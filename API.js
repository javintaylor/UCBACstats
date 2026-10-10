/**
 * UCBAC Stats — Api.gs
 * Read layer. Every function returns a plain object the frontend can render.
 * Payloads are cached so repeated page views don't re-read the whole database.
 */

function cacheGet_(key, ttl, producer) {
  const c = CacheService.getScriptCache();
  try {
    const hit = c.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  const val = producer();
  try {
    const s_ = JSON.stringify(val);
    if (s_.length < 95000) c.put(key, s_, ttl || CONFIG.CACHE_TTL_SECONDS);
  } catch (e) {}
  return val;
}

function clearApiCache_() {
  CacheService.getScriptCache().removeAll([
    'public-view-epoch-v1', 'boot', 'standings-SEA-2023', 'standings-SEA-2024', 'standings-SEA-2025',
    'standings-SEA-2026', 'leaders-SEA-2024', 'leaders-SEA-2025', 'teams', 'postseason'
  ]);
  return 'Cache cleared.';
}

/** Short-lived, public Home/Team responses only. Large JSON is split into
 * bounded parts; the manifest is published last. Cache eviction or an unavailable
 * cache always falls back to a normal read, never to an incomplete response.
 * A new epoch after Clear cache invalidates every team/season combination.
 */
function cachePublicView_(identity, producer) {
  var cache, key, ttl = 60;
  try {
    cache = CacheService.getScriptCache();
    var epoch = cache.get('public-view-epoch-v1');
    if (!epoch) {
      epoch = Utilities.getUuid();
      cache.put('public-view-epoch-v1', epoch, 21600);
    }
    var digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, JSON.stringify(identity)));
    key = 'public-view-v1-' + epoch + '-' + digest;
    var raw = cache.get(key);
    if (raw) {
      var record = JSON.parse(raw);
      if (Object.prototype.hasOwnProperty.call(record, 'value')) return record.value;
      if (record.count >= 1 && record.count <= 20 && /^[a-zA-Z0-9-]+$/.test(record.token)) {
        var keys = [];
        for (var i = 0; i < record.count; i++) keys.push(key + '-' + record.token + '-' + i);
        var parts = cache.getAll(keys);
        if (keys.every(function (k) { return typeof parts[k] === 'string'; }))
          return JSON.parse(keys.map(function (k) { return parts[k]; }).join(''));
      }
    }
  } catch (e) { /* An optional cache must never break a public page. */ }

  var value = producer();
  try {
    if (!cache || !key || value === null || value === undefined) return value;
    var json = JSON.stringify(value);
    if (json.length > 400000) return value;
    if (json.length <= 20000) {
      cache.put(key, JSON.stringify({ value: value }), ttl);
    } else {
      var token = Utilities.getUuid(), chunks = {}, count = 0, at = 0;
      while (at < json.length) {
        var end = Math.min(at + 20000, json.length);
        // Avoid splitting an emoji/surrogate pair across cache entries.
        if (end < json.length && /[\uD800-\uDBFF]/.test(json.charAt(end - 1))) end--;
        chunks[key + '-' + token + '-' + count++] = json.slice(at, end);
        at = end;
      }
      if (count > 20) return value;
      cache.putAll(chunks, ttl);
      cache.put(key, JSON.stringify({ token: token, count: count }), ttl);
    }
  } catch (e) { /* Size limits and early eviction are safe cache misses. */ }
  return value;
}

function num_(v) { var n = Number(v); return (v === '' || v === null || isNaN(n)) ? null : n; }
/**
 * Sheets stores a checkbox as a real boolean, but the same column seeded from a
 * CSV arrives as the string "TRUE". Comparing against either one alone silently
 * reads half the rows as false.
 */
function isTrue_(v) {
  if (v === true) return true;
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase() === 'TRUE';
}
function s_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

/**
 * School name for a TeamID, for every user-facing string. TEAM-001 is a
 * spreadsheet key; nobody outside the workbook should ever read one.
 */
function teamNameOf_(teamId) {
  teamId = s_(teamId);
  if (!teamId) return '';
  const t = rowsOf_(CONFIG.TABS.TEAMS).filter(function (x) {
    return s_(x.TeamID) === teamId;
  })[0];
  return t ? s_(t.DisplayName) : teamId;
}

/**
 * Every stat a row actually holds, keyed by its own column name.
 *
 * The named fields on a player payload are a curated handful chosen years ago
 * for the pages that existed then; anything outside it — a punt, a kick
 * return, a pancake block — was simply absent, so a reader could not ask for
 * it. This carries the lot, and only the lot: a blank column is left out
 * rather than sent as a zero, because a kicker with no field goals attempted
 * and a kicker who missed three are not the same fact.
 */
function apiStatSums_(row) {
  const out = {};
  SUM_FIELDS.forEach(function (f) {
    const v = num_(row[f]);
    if (v !== null) out[f] = v;
  });
  return out;
}

/** Drive image URL usable in an <img> tag. */
function mediaUrl_(fileId, w) {
  if (!fileId) return '';
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + (w || 200);
}

/* A crest changes about never, and every card wants one, so it is worth
   holding on to. The ceiling is what CacheService will take for one key. */
const CREST_TTL_SECONDS = 21600;
const CREST_MAX_CHARS = 90000;
const CREST_MAX_SOURCE_BYTES = 400000;
const CREST_MISS = '-';

/** A picture as a data: URL, or '' if what came back was not one. */
function crestData_(blob) {
  const type = s_(blob && blob.getContentType());
  if (!/^image\//.test(type)) return '';
  const bytes = blob.getBytes();
  // the file behind a crest is a crest; a photograph that happens to live in
  // the same folder is not, and has no business on a card
  if (bytes.length > CREST_MAX_SOURCE_BYTES) return '';
  return 'data:' + type + ';base64,' + Utilities.base64Encode(bytes);
}

/**
 * The Drive file behind a thumbnail address, read directly.
 *
 * The plain fetch is the first choice because it asks for a picture already
 * cut to 240px. It is also the one Drive sometimes refuses to a server that
 * is not a browser, so this is the way round that: the same file, read with
 * the permissions the script already holds.
 */
function crestFromDrive_(url) {
  const m = String(url).match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (!m) return '';
  return crestData_(DriveApp.getFileById(m[1]).getBlob());
}

/**
 * A team's crest as the picture itself, not a link to it.
 *
 * The pages show a crest with a plain <img>, which asks Drive for nothing but
 * the bytes. A canvas is stricter: it will not export a picture drawn from
 * another origin unless that origin says it may, and Drive says nothing at
 * all — so the share card asked for the crest, was refused, and drew a hole
 * where a school's mark belongs. Fetching it here removes the other origin
 * from the question: same file, same picture, handed over as a data: URL the
 * browser can paint and keep.
 *
 * Empty when there is no crest on file or Drive will not serve it; the card
 * falls back to the school's initial in the school's colour.
 */
function apiTeamCrest_(teamId) {
  teamId = s_(teamId);
  if (!teamId) return '';
  const key = 'crest-' + teamId;
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get(key);
    if (hit) return hit === CREST_MISS ? '' : hit;
  } catch (e) {}

  let url = '';
  try {
    const boot = cacheGetBoot_();
    const t = (boot.teams || []).filter(function (x) { return x.id === teamId; })[0];
    url = (t && t.logo) || '';
  } catch (e) { url = ''; }
  // no crest on file is a settled answer; a refusal might not be, so it is
  // remembered for a quarter of an hour rather than six
  const miss = function (ttl) { try { cache.put(key, CREST_MISS, ttl); } catch (e) {} return ''; };
  if (!url) return miss(CREST_TTL_SECONDS);

  let out = '';
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() === 200) out = crestData_(r.getBlob());
  } catch (e) { out = ''; }
  if (!out) { try { out = crestFromDrive_(url); } catch (e) { out = ''; } }
  if (!out) return miss(900);
  if (out.length <= CREST_MAX_CHARS) { try { cache.put(key, out, CREST_TTL_SECONDS); } catch (e) {} }
  return out;
}

// ───────────────────────────────── bootstrap

function apiBootstrap_() {
  const boot = cacheGetBoot_();
  /* Deliberately outside the cache. The sign-in link is built from this, and a
     quarter of an hour of a wrong one is a quarter of an hour in which nobody
     can get in. It costs one property read. */
  boot.portalUrl = (typeof portalUrl_ === 'function') ? portalUrl_() : '';
  return boot;
}

/**
 * Names for the search box to cycle through: a player, a team, a coach, and
 * round again, so the box shows the three things it accepts rather than
 * naming two of them and hiding the third.
 *
 * Players are the newest season's projected First Team — the names a reader
 * is most likely to recognise, and already published beside their badges.
 * A season with no ballot yet (this one, in August) falls back to the last
 * one that has one. Nothing here is a new disclosure: every name is already
 * on a roster, a leaderboard or a team page.
 *
 * Every school and every head coach ships, not a sample: the box shuffles
 * the list and shows each name once before repeating, so a wider pool is a
 * longer wait between repeats and costs about forty short strings.
 */
/**
 * The names the search box rotates. Players are CURRENT players only - on
 * this season's roster - and outnumber the schools and the coaches three to
 * one: the client draws from the list as a shuffled bag, so the mix of the
 * list is the mix of the rotation. This season's projected First Team leads
 * the player names; the rest are drawn evenly across the roster so every
 * school's players get a turn.
 */
function bootExamples_(teams, acFirst, rosterNames, seasonId) {
  const uniq = function (list) {
    const seen = {}, out = [];
    (list || []).forEach(function (v) {
      const k = s_(v);
      if (!k || seen[k.toLowerCase()]) return;
      seen[k.toLowerCase()] = true;
      out.push(k);
    });
    return out;
  };

  const teamNames = uniq((teams || []).map(function (t) { return t.name; }));
  const coaches = uniq((teams || []).map(function (t) { return t.headCoach; }));
  const roster = uniq(rosterNames);
  const onRoster = {};
  roster.forEach(function (n) { onRoster[n.toLowerCase()] = true; });

  // this season's First Team first, if they are still on a roster
  const first = uniq((acFirst || {})[seasonId] || []).filter(function (n) { return onRoster[n.toLowerCase()]; });
  const need = 3 * Math.max(teamNames.length, coaches.length);
  const players = first.slice(0, need);
  if (players.length < need) {
    const rest = roster.filter(function (n) { return players.indexOf(n) < 0; });
    const step = Math.max(1, Math.floor(rest.length / (need - players.length)));
    for (var k = 0; k < rest.length && players.length < need; k += step) players.push(rest[k]);
  }

  // three players, a school, a coach, in turn: the shuffle keeps the ratio,
  // and an interleaved list keeps every kind represented if it ever stops
  const out = [];
  const most = Math.max(Math.ceil(players.length / 3), teamNames.length, coaches.length);
  for (var i = 0; i < most; i++) {
    for (var j = 0; j < 3; j++) if (players[i * 3 + j]) out.push(players[i * 3 + j]);
    if (teamNames[i]) out.push(teamNames[i]);
    if (coaches[i])   out.push(coaches[i]);
  }
  return out;
}

function cacheGetBoot_() {
  return cacheGet_('boot', 900, function () {
    const media = rowsOf_(CONFIG.TABS.MEDIA);
    const logo = {}, helmet = {}, brand = {};
    media.forEach(function (m) {
      if (s_(m.IsPrimary).toUpperCase() !== 'TRUE') return;
      if (s_(m.EntityType) === 'BRAND') { brand[s_(m.EntityID)] = s_(m.DriveFileID); return; }
      if (s_(m.EntityType) !== 'TEAM') return;
      if (s_(m.MediaType) === 'LOGO')   logo[s_(m.EntityID)]   = s_(m.DriveFileID);
      if (s_(m.MediaType) === 'HELMET') helmet[s_(m.EntityID)] = s_(m.DriveFileID);
    });

    const teams = rowsOf_(CONFIG.TABS.TEAMS).map(function (t) {
      return {
        id: s_(t.TeamID), name: s_(t.DisplayName), school: s_(t.SchoolName),
        mascot: s_(t.Mascot), county: s_(t.County), city: s_(t.City),
        cls: s_(t.Class2025), slug: s_(t.Slug),
        color: s_(t.PrimaryColor) || '#1F3B54', color2: s_(t.SecondaryColor) || '#C9A227',
        colorName: s_(t.PrimaryColorName), x: s_(t.XHandle), ig: s_(t.InstagramHandle),
        maxpreps: s_(t.MaxPrepsURL), hudl: s_(t.HudlURL), school: s_(t.SchoolURL),
        facebook: s_(t.FacebookURL), youtube: s_(t.YouTubeURL), tiktok: s_(t.TikTokURL),
        headCoach: s_(t.HeadCoach), stadium: s_(t.StadiumName),
        logo: mediaUrl_(logo[s_(t.TeamID)], 240),
        helmet: mediaUrl_(helmet[s_(t.TeamID)], 240)
      };
    });

    const seasons = rowsOf_(CONFIG.TABS.SEASONS).map(function (x) {
      return { id: s_(x.SeasonID), year: num_(x.Year), label: s_(x.Label), status: s_(x.Status) };
    }).sort(function (a, b) { return b.year - a.year; });

    // Which season should the site open on? The current one the moment it has a
    // result, otherwise the most recent season that does. Opening on a season
    // that has not kicked off yet shows empty standings, empty leaders and an
    // empty ballot, which reads as a broken site rather than an early one.
    const played = {};
    rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
      if (num_(g.HomeScore) !== null) played[s_(g.SeasonID)] = true;
    });
    var defaultSeason = CONFIG.CURRENT_SEASON;
    if (!played[defaultSeason]) {
      for (var i = 0; i < seasons.length; i++) {
        if (played[seasons[i].id]) { defaultSeason = seasons[i].id; break; }
      }
    }

    // Captains are needed next to a player's name on every page, so they ship
    // once here as season -> playerId -> true rather than being threaded through
    // each endpoint and forgotten in one of them.
    const captains = {};
    rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
      if (!isTrue_(r.IsCaptain)) return;
      const sid = s_(r.SeasonID);
      (captains[sid] = captains[sid] || {})[s_(r.PlayerID)] = true;
    });

    // Jersey and class travel with every player name the same way: one compact
    // map, season -> playerId -> "jersey|yy", instead of widening every payload.
    const gradOf = {};
    rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
      const g = s_(p.GradYear);
      if (g) gradOf[s_(p.PlayerID)] = g;
    });
    const pmeta = {};
    rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
      const pid = s_(r.PlayerID), sid = s_(r.SeasonID);
      if (!pid || !sid) return;
      const j = s_(r.Jersey);
      const g = gradOf[pid] || s_(r.GradYear);
      if (!j && !g) return;
      (pmeta[sid] = pmeta[sid] || {})[pid] = j + '|' + (g ? String(g).slice(-2) : '');
    });

    // Standings rank per season, so a team name can carry its place — "(3)
    // Aberdeen" — wherever it appears, for whatever season the page shows.
    const ranks = {}, records = {};
    if (hasTab_('Standings')) rowsOf_('Standings').forEach(function (r) {
      const rk = num_(r.Rank);
      if (rk) (ranks[s_(r.SeasonID)] = ranks[s_(r.SeasonID)] || {})[s_(r.TeamID)] = rk;
      // and the record, worn as a suffix on the Scores page: "(3) Aberdeen (2-1)"
      const w = num_(r.W), l = num_(r.L), t = num_(r.T);
      if (w !== null || l !== null)
        (records[s_(r.SeasonID)] = records[s_(r.SeasonID)] || {})[s_(r.TeamID)] =
          (w || 0) + '-' + (l || 0) + (t ? '-' + t : '');
    });

    // Who is projected First or Second Team, worn beside the name wherever it
    // appears — "RB1" in gold, "RB2" in silver. Keyed by season like pmeta, so
    // a 2025 page wears 2025's projections, not this year's. Honorable Mention
    // is deliberately absent: a badge on a third of the conference marks
    // nobody. A player may hold one offensive and one defensive award, so the
    // value is |-joined.
    // acrank is the same tab read a second way: the raw place at the position
    // - "RB5" - shown on a player's own page. Top fifteen only, and only with
    // games played: a rank computed from nothing describes nothing, and
    // "38th of 41" is a number nobody needs published about a teenager.
    const acbadge = {}, acrank = {}, acFirst = {};
    if (hasTab_('AllConference')) rowsOf_('AllConference').forEach(function (r) {
      const pid = s_(r.PlayerID), sid = s_(r.SeasonID), pos = s_(r.Position);
      if (!pid || !sid || !pos) return;
      const t = s_(r.ProjectedTeam);
      const n = t === 'First Team' ? 1 : t === 'Second Team' ? 2 : 0;
      if (n) {
        const m = acbadge[sid] = acbadge[sid] || {};
        m[pid] = (m[pid] ? m[pid] + '|' : '') + pos + n;
      }
      // first-team names, for the search box's rotating examples
      if (n === 1 && s_(r.PlayerName)) {
        (acFirst[sid] = acFirst[sid] || []).push(s_(r.PlayerName));
      }
      const rk = num_(r.PositionRank);
      if (rk && rk <= 15 && num_(r.GamesPlayed)) {
        const m2 = acrank[sid] = acrank[sid] || {};
        m2[pid] = (m2[pid] ? m2[pid] + '|' : '') + pos + rk;
      }
    });

    // Players who hold an ACTIVE account bound to their career: their page is
    // managed by the person it names, and the check says so wherever the name
    // appears. Career-level, not season-keyed - an account does not expire
    // with a season. Only the bare PlayerID ships; never the email behind it.
    /* And the schools whose page a coach is actually keeping: an ACTIVE coach
       account bound to the team. The same check, saying the same thing one
       step up - a roster and a schedule somebody is answerable for, rather
       than a page the conference fills in on the school's behalf. An
       administrator's account is not a coach's and does not count. */
    const verified = {}, verifiedTeams = {};
    if (hasTab_('Accounts')) rowsOf_('Accounts').forEach(function (r) {
      const active = s_(r.Status).toUpperCase() === 'ACTIVE';
      if (!active) return;
      const pid = s_(r.PlayerID);
      if (pid) verified[pid] = 1;
      const tid = s_(r.TeamID);
      if (tid && s_(r.Role).toUpperCase() === 'COACH') verifiedTeams[tid] = 1;
    });

    // this season's roster, by name, for the search box's examples
    const nameOf = {};
    rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) { nameOf[s_(p.PlayerID)] = s_(p.DisplayName); });
    const rosterNames = rowsOf_(CONFIG.TABS.PLAYER_SEASONS)
      .filter(function (r) { return s_(r.SeasonID) === CONFIG.CURRENT_SEASON; })
      .map(function (r) { return nameOf[s_(r.PlayerID)] || ''; })
      .filter(Boolean);

    return { teams: teams, seasons: seasons,
             currentSeason: CONFIG.CURRENT_SEASON,
             defaultSeason: defaultSeason,
             seasonsWithResults: Object.keys(played),
             // Site identity from the Media tab: the UCBACstats logo for the
             // header and footer, the conference mark alongside it.
             brand: { logo: mediaUrl_(brand['UCBAC_STATS'], 240),
                      conf: mediaUrl_(brand['UCBAC'], 240) },
             captains: captains, pmeta: pmeta, ranks: ranks, records: records, acbadge: acbadge,
             acrank: acrank, verified: verified, verifiedTeams: verifiedTeams,
             // playoff history, so a team tile can wear it without a read of
             // its own. Nine schools have any; the rest are simply absent.
             postseason: (typeof tpAll_ === 'function') ? tpAll_() : {},
             postseasonWindows: (typeof tpWindows_ === 'function') ? tpWindows_() : null,
             // names to show in the search box, so it advertises what it
             // actually accepts instead of describing it
             examples: bootExamples_(teams, acFirst, rosterNames, CONFIG.CURRENT_SEASON) };
  });
}

// ───────────────────────────────── standings / leaders

/**
 * A place in the table, or null.
 *
 * num_ was not enough. A cell in the Standings tab carrying date formatting
 * comes back from getValues as a Date, and Number(Date) is milliseconds since
 * 1970 — so a rank read that way became 2,208,787,200,001, and the site
 * printed "down 2208787200001 places" beside the league leader. A rank is a
 * small whole number and anything else is a formatting accident, not a rank.
 */
function stdRank_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return null;
  const n = Number(v);
  if (!isFinite(n) || n !== Math.round(n) || n < 1 || n > 200) return null;
  return n;
}

function apiStandings_(seasonId) {
  return cacheGet_('standings-' + seasonId, 900, function () {
    if (!hasTab_('Standings')) return [];
    return rowsOf_('Standings').filter(function (r) { return s_(r.SeasonID) === seasonId; })
      .map(function (r) {
        const rank = stdRank_(r.Rank), prev = stdRank_(r.PrevRank);
        return { rank: rank, teamId: s_(r.TeamID), team: s_(r.TeamName),
                 w: num_(r.W) || 0, l: num_(r.L) || 0, t: num_(r.T) || 0,
                 cw: num_(r.ConfW) || 0, cl: num_(r.ConfL) || 0,
                 // 2023 records carry no points — blank stays blank, never 0-0
                 pf: num_(r.PF), pa: num_(r.PA), diff: num_(r.Diff),
                 pct: num_(r.WinPct),
                 ct: num_(r.ConfT), conferencePct: num_(r.ConfPct),
                 rankReason: s_(r.RankReason), rankTied: String(r.RankTied).toLowerCase() === 'true',
                 conferenceMarginAverage: num_(r.ConfMarginAvg), standingsRule: s_(r.StandingsRule),
                 // places gained since the week before last week's games:
                 // positive is up, negative is down, null when there is no
                 // earlier week to compare with
                 move: (rank !== null && prev !== null) ? prev - rank : null };
      }).sort(function (a, b) { return (a.rank || 99) - (b.rank || 99); });
  });
}

function apiLeaders_(seasonId, category) {
  const key = 'leaders-' + seasonId + '-' + (category || 'all');
  return cacheGet_(key, 900, function () {
    if (!hasTab_('Leaders')) return [];
    return rowsOf_('Leaders').filter(function (r) {
      return s_(r.SeasonID) === seasonId && (!category || s_(r.Category) === category);
    }).map(function (r) {
      return { cat: s_(r.Category), label: s_(r.CategoryLabel), rank: num_(r.Rank),
               playerId: s_(r.PlayerID), player: s_(r.PlayerName),
               teamId: s_(r.TeamID), team: s_(r.TeamName),
               value: num_(r.Value), gp: num_(r.GamesPlayed), grain: s_(r.SourceGrain),
               prov: s_(r.Provisional) === 'TRUE' };
    }).sort(function (a, b) { return a.rank - b.rank; });
  });
}

// ───────────────────────────────── games

/**
 * Where a game falls in the season, as one comparable number.
 *
 * The playoffs restart Week at 1 and mark themselves Phase "Round", so sorting
 * on Week alone puts Round 1 below Week 9 and the regular-season finale looks
 * like the most recent game all winter. Rounds are therefore offset past the
 * last regular week rather than compared against it.
 */
const GAME_ORDER_PLAYOFF_BASE = 100;

function gameOrder_(g) {
  const w = num_(g.Week) || 0;
  return isPlayoffPhase_(g) ? GAME_ORDER_PLAYOFF_BASE + w : w;
}

function isPlayoffPhase_(g) {
  const phase = s_(g.Phase).toUpperCase();
  return phase === 'ROUND' || phase === 'PLAYOFF' ||
         s_(g.GameType).toUpperCase() === 'PLAYOFF';
}

/**
 * One side of a game, by name.
 *
 * A playoff row against a non-conference school carries that school's NAME in
 * the TeamID column and leaves TeamName blank, so the name has to be recovered
 * from whichever of the two actually holds it.
 */
function gameSideName_(g, side) {
  const id = s_(g[side + 'TeamID']);
  return s_(g[side + 'TeamName']) || (/^TEAM-\d+$/.test(id) ? '' : id);
}

function gameRow_(g) {
  const playoff = isPlayoffPhase_(g);
  const homeId = s_(g.HomeTeamID), awayId = s_(g.AwayTeamID);
  return {
    id: s_(g.GameID), season: s_(g.SeasonID), week: num_(g.Week), phase: s_(g.Phase),
    type: s_(g.GameType), status: s_(g.Status),
    playoff: playoff, order: gameOrder_(g),
    roundLabel: playoff ? playoffRoundLabel_(num_(g.Week)) : '',
    home: homeId, away: awayId,
    homeName: gameSideName_(g, 'Home'),
    awayName: gameSideName_(g, 'Away'),
    hs: num_(g.HomeScore), as: num_(g.AwayScore),
    date: apiDateStr_(g.GameDate)
  };
}

/**
 * A game date as yyyy-mm-dd. getValues() hands back a real Date for a
 * date-formatted cell, and String(aDate) starts "Fri Aug 21" — which neither
 * sorts nor parses. Format the object; slice only what was already a string.
 */
/**
 * A date cell as the calendar day somebody typed into it.
 *
 * Sheets hands a date cell back as a Date at midnight in the SPREADSHEET's
 * time zone, and getDate() reads it in the SCRIPT's. Those are the same
 * setting in two different places, and when they drift apart — the workbook
 * on GMT, the script on New York — midnight becomes eight the previous
 * evening and every Friday fixture is filed under Thursday.
 *
 * So it is read back in the zone it was written in, and the two settings no
 * longer have to agree for the schedule to be right.
 */
function apiDateStr_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    try {
      return Utilities.formatDate(v, apiSheetTz_(), 'yyyy-MM-dd');
    } catch (e) {
      return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) +
             '-' + ('0' + v.getDate()).slice(-2);
    }
  }
  return String(v).slice(0, 10);
}

var __apiSheetTz = null;
function apiSheetTz_() {
  if (__apiSheetTz) return __apiSheetTz;
  try { __apiSheetTz = db_().getSpreadsheetTimeZone(); } catch (e) {}
  if (!__apiSheetTz) {
    try { __apiSheetTz = Session.getScriptTimeZone(); } catch (e) {}
  }
  return (__apiSheetTz = __apiSheetTz || 'America/New_York');
}

/** Today as yyyy-mm-dd in the project's own time zone — date math by string. */
function apiTodayStr_() {
  try {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  } catch (e) {
    const d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
           '-' + ('0' + d.getDate()).slice(-2);
  }
}

/**
 * Friday night's scoreboard, and the hours it is worth showing.
 *
 * Home is the standings page; the games live on Scores. That is right for six
 * days a week and wrong for one, because on a Friday evening in the autumn the
 * only thing anybody opens this site for is what the score is right now.
 *
 * So the board appears at six, before the first kickoff, and is gone by seven
 * the next morning — by then the night is over, the standings underneath have
 * absorbed it, and a scoreboard still sitting there on Tuesday is just old
 * news at the top of the page.
 *
 * The clock is the project's, not the reader's: Friday night means Friday
 * night in Harford County, whichever time zone a grandparent is watching from.
 */
const HOME_FRIDAY = { OPEN_HOUR: 18, CLOSE_HOUR: 7 };

/* Weekday and day-shifting straight off a yyyy-mm-dd string, through UTC, so
   neither one can be dragged over a boundary by the local zone. 0=Sun..6=Sat */
function apiDowOf_(ymd) {
  const p = String(ymd || '').split('-');
  if (p.length !== 3) return -1;
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
}
function apiShiftDay_(ymd, days) {
  const p = String(ymd || '').split('-');
  if (p.length !== 3) return '';
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** The Friday this scoreboard belongs to, or '' when the window is shut. */
function apiFridayWindow_(now) {
  /* The SCRIPT's zone, which is the project's wall clock: "six on a Friday
     evening" is a time in Harford County. Reading dates out of cells is a
     different question and uses the workbook's zone, because that is where
     those values were written — but both name the same Friday, so the date
     this returns still matches a GameDate.
     Tying the window to the workbook instead was wrong, and worse than
     untidy: a workbook left on Pacific would have held the board shut until
     nine in the evening Eastern, with every game already under way. */
  const tz = (function () {
    try { return Session.getScriptTimeZone() || 'America/New_York'; }
    catch (e) { return 'America/New_York'; }
  })();
  now = now || new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const dow = apiDowOf_(today);
  if (dow === 5 && hour >= HOME_FRIDAY.OPEN_HOUR) return today;        // Friday evening
  if (dow === 6 && hour < HOME_FRIDAY.CLOSE_HOUR) return apiShiftDay_(today, -1);
  return '';                                                          // the other six days
}

/**
 * The games of that Friday, scores filled in as they arrive.
 *
 * Empty out of season without being told the season is over: if nothing is
 * scheduled for tonight there is nothing to show, and an autumn Friday with
 * fifteen games and a February one with none need no different rule.
 */
function apiFridayScores_(now) {
  const date = apiFridayWindow_(now);
  if (!date) return null;
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === CONFIG.CURRENT_SEASON && apiDateStr_(g.GameDate) === date;
  }).map(gameRow_);
  if (!games.length) return null;
  /* Scores first. At eight o'clock most of the board is still blank, and the
     reader came for the part that is not — a final should never be below three
     fixtures that have not kicked off. Alphabetical within each group, so the
     order is steady as the night fills in rather than reshuffling wholesale. */
  const scored = function (g) { return g.hs !== null && g.as !== null; };
  games.sort(function (a, b) {
    return (scored(a) ? 0 : 1) - (scored(b) ? 0 : 1) ||
           (a.homeName || '').localeCompare(b.homeName || '');
  });
  const first = games[0];
  return {
    date: date,
    label: first.playoff ? first.roundLabel : (first.week ? 'Week ' + first.week : ''),
    games: games,
    final: games.filter(function (g) { return g.hs !== null; }).length
  };
}

/** Round 1..4 read better as their round names once the bracket narrows. */
function playoffRoundLabel_(round) {
  const names = { 1: 'First Round', 2: 'Quarterfinal', 3: 'Semifinal', 4: 'State Final' };
  return names[round] || ('Round ' + (round || ''));
}

function apiScores_(seasonId, week) {
  // `week` is a period key (W3, R2). A bare number still works and is read as a
  // regular week, so an old link does not silently return the playoffs too.
  const want = s_(week);
  const wantKey = want && /^\d+$/.test(want) ? ('W' + Number(want)) : want.toUpperCase();
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === seasonId && (!wantKey || periodKey_(g) === wantKey);
  }).map(gameRow_);
  games.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  return games;
}

/**
 * The periods a season is played in, in order.
 *
 * Regular weeks and playoff rounds both number from 1, so a bare week number is
 * ambiguous: filtering on "1" would return Week 1 alongside the first round of
 * the playoffs. Each period therefore carries its own key — W1..W9, R1..R4.
 */
function periodKey_(g) {
  const w = num_(g.Week);
  if (!w) return '';
  return (isPlayoffPhase_(g) ? 'R' : 'W') + w;
}

function apiWeeks_(seasonId) {
  const seen = {};
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (s_(g.SeasonID) !== seasonId) return;
    const k = periodKey_(g);
    if (!k) return;
    if (!seen[k]) {
      seen[k] = { key: k, label: isPlayoffPhase_(g) ? playoffRoundLabel_(num_(g.Week))
                                                  : ('Week ' + num_(g.Week)),
                  short: k, playoff: isPlayoffPhase_(g), order: gameOrder_(g), games: 0 };
    }
    seen[k].games++;
  });
  return Object.keys(seen).map(function (k) { return seen[k]; })
    .sort(function (a, b) { return a.order - b.order; });
}

function apiGame_(gameId) {
  const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) { return s_(x.GameID) === gameId; })[0];
  if (!g) return null;
  const out = gameRow_(g);

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  /* Numbers come from the SEASON's roster, not the Players tab, which holds
     none: a boy can change number between years, so the number on a box score
     has to be the one he wore in the season that box score belongs to. A card
     made from a row prints it, and a wrong number is a different boy. */
  const jersey = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (ps) {
    if (s_(ps.SeasonID) !== s_(out.season)) return;
    const j = s_(ps.Jersey);
    if (j) jersey[s_(ps.PlayerID)] = j;
  });
  const stats = rowsOf_(CONFIG.TABS.PLAYER_STATS).filter(function (r) {
    return s_(r.GameID) === gameId && s_(r.grain) === CONFIG.GRAIN.GAME;
  });

  const byTeam = {};
  stats.forEach(function (r) {
    var tid = s_(r.TeamID);
    if (!byTeam[tid]) byTeam[tid] = [];
    var p = players[s_(r.PlayerID)];
    byTeam[tid].push({
      playerId: s_(r.PlayerID), name: p ? s_(p.DisplayName) : s_(r.player_raw),
      jersey: jersey[s_(r.PlayerID)] || '',
      cat: s_(r.category),
      passAtt: num_(r.PassAtt), passComp: num_(r.PassComp), passYds: num_(r.PassYds),
      passTD: num_(r.PassTD), passInt: num_(r.PassInt),
      rushAtt: num_(r.RushAtt), rushYds: num_(r.RushYds), rushTD: num_(r.RushTD),
      rec: num_(r.Rec), recYds: num_(r.RecYds), recTD: num_(r.RecTD),
      solo: num_(r.TackleSolo), asst: num_(r.TackleAssist), tfl: num_(r.TFL),
      sacks: num_(r.Sacks), int: num_(r.Int),
      // player-entered and not yet approved: the site renders it grey
      prov: provisionalSource_(r.SourceType)
    });
  });
  out.stats = byTeam;
  return out;
}

// ───────────────────────────────── team

/**
 * The team's own line, game by game, and the season it adds up to.
 *
 * Summed from its players' game rows rather than read from TeamGameStats, so
 * the team's figure is exactly the sum of the players' figures the same page
 * shows beside it. A reader who adds a column up gets the total row, which is
 * not true of two tables filled from two different sources.
 *
 * Only games with a stat line appear: a week nobody entered is absent rather
 * than printed as a row of zeroes, which reads as a shutout.
 */
function teamGameTotals_(teamId, seasonId, games) {
  if (!hasTab_(CONFIG.TABS.PLAYER_STATS)) return null;
  const byGame = {};
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    if (s_(r.TeamID) !== teamId || s_(r.SeasonID) !== seasonId) return;
    if (s_(r.grain) !== CONFIG.GRAIN.GAME) return;
    const gid = s_(r.GameID);
    if (!gid) return;
    const bag = byGame[gid] || (byGame[gid] = {});
    SUM_FIELDS.forEach(function (f) {
      const v = num_(r[f]);
      if (v !== null) bag[f] = (bag[f] || 0) + v;
    });
  });

  const rows = [], total = {};
  (games || []).forEach(function (g) {
    const bag = byGame[g.id];
    if (!bag) return;
    const home = g.home === teamId;
    const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
    Object.keys(bag).forEach(function (f) { total[f] = (total[f] || 0) + bag[f]; });
    rows.push({ gameId: g.id, week: g.week, order: g.order, isHome: home,
                opp: home ? (g.awayName || g.away) : (g.homeName || g.home),
                oppId: home ? g.away : g.home,
                pf: us, pa: them,
                result: (us === null || them === null) ? ''
                        : (us > them ? 'W' : us < them ? 'L' : 'T'),
                stats: bag });
  });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  const played = rows.filter(function (r) { return r.pf !== null && r.pa !== null; });
  return { games: rows, season: total, gp: rows.length,
           pf: played.reduce(function (a, r) { return a + r.pf; }, 0),
           pa: played.reduce(function (a, r) { return a + r.pa; }, 0) };
}

/**
 * Every team's line in every game of a season: byGame[gameId][teamId] = bag.
 *
 * One pass over PlayerGameStats serves both the team page and the conference
 * boards; walking that tab once per school would read it fifteen times.
 */
function statsByGameTeam_(seasonId) {
  const byGame = {};
  if (!hasTab_(CONFIG.TABS.PLAYER_STATS)) return byGame;
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    if (s_(r.SeasonID) !== seasonId) return;
    if (s_(r.grain) !== CONFIG.GRAIN.GAME) return;
    const gid = s_(r.GameID), tid = s_(r.TeamID);
    if (!gid || !tid) return;
    const side = byGame[gid] || (byGame[gid] = {});
    const bag = side[tid] || (side[tid] = {});
    SUM_FIELDS.forEach(function (f) {
      const v = num_(r[f]);
      if (v !== null) bag[f] = (bag[f] || 0) + v;
    });
  });
  return byGame;
}

/**
 * What a defence gave up, taken from the other side's own box score.
 *
 * There is no such thing as a defensive yard in this database. A team's
 * passing yards allowed ARE its opponent's passing yards, and the only way to
 * know them is to have the opponent's line — which is exactly why this can
 * only ever be a CONFERENCE figure. Nobody sends us Kent County's box score,
 * so a non-conference game contributes nothing and is named as such rather
 * than counted as a shutout, which is what silently skipping it would look
 * like. A conference game whose opponent has not reported yet is named too,
 * and separately: one is a permanent gap and the other is a Monday.
 *
 * Because the games counted differ from team to team, `gp` here is the number
 * of games this figure is built from — never the number the team has played —
 * and every reader of these numbers must divide by it rather than by games
 * played. Totals across unequal schedules are not comparable; per game is.
 */
function teamAllowed_(teamId, seasonId, games, byGame, confIds) {
  /* `have` counts, per field, how many of the counted games actually reported
     it. A field nobody reported sums to nothing, and nothing read as a zero is
     how a school that has never had a rushing touchdown REPORTED against it
     ends up leading "fewest rushing touchdowns allowed". A stat that was not
     recorded is not a stat of zero, and this is what tells the two apart. */
  const rows = [], total = {}, have = {}, skipped = [];
  (games || []).forEach(function (g) {
    const home = g.home === teamId;
    const oppId = home ? g.away : g.home;
    const oppName = home ? (g.awayName || g.away) : (g.homeName || g.home);
    if (!oppId || !confIds[oppId]) {
      if (g.hs !== null || g.as !== null)
        skipped.push({ week: g.week, opp: oppName || 'a non-conference opponent',
                       why: 'outside the conference — we hold no statistics for them' });
      return;
    }
    const bag = (byGame[g.id] || {})[oppId];
    if (!bag) {
      if (g.hs !== null || g.as !== null)
        skipped.push({ week: g.week, opp: oppName, why: 'their line is not in yet' });
      return;
    }
    /* A line being present is not the same as a line being finished. The
       completeness of a box score is a fact about the paperwork, not about
       the numbers, so it is recorded by hand in StatsCoverage rather than
       inferred here — and a game not yet confirmed is named and skipped
       exactly like one that was never filed. */
    if (typeof statsCovComplete_ === 'function' && !statsCovComplete_(g.id, oppId)) {
      skipped.push({ week: g.week, opp: oppName, why: 'their box score is not confirmed complete' });
      return;
    }
    Object.keys(bag).forEach(function (f) {
      total[f] = (total[f] || 0) + bag[f];
      have[f] = (have[f] || 0) + 1;          // how many counted games reported it
    });
    const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
    rows.push({ gameId: g.id, week: g.week, order: g.order, isHome: home,
                opp: oppName, oppId: oppId, pf: us, pa: them,
                result: (us === null || them === null) ? ''
                        : (us > them ? 'W' : us < them ? 'L' : 'T'),
                stats: bag });
  });
  if (!rows.length && !skipped.length) return null;
  rows.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  return { games: rows, season: total, have: have, gp: rows.length, skipped: skipped };
}

function apiTeam_(teamId, seasonId) {
  return cachePublicView_(['team', teamId, seasonId], function () {
    return buildPublicTeam_(teamId, seasonId);
  });
}

function buildPublicTeam_(teamId, seasonId) {
  const t = rowsOf_(CONFIG.TABS.TEAMS).filter(function (x) { return s_(x.TeamID) === teamId; })[0];
  if (!t) return null;

  /* Sorting on raw Week interleaved the playoffs (their weeks restart at 1)
     among September games — the schedule read as shuffled. Sort on the season
     order instead: played games newest first, so the latest result leads, and
     any unplayed games after them soonest first, so preseason reads Week 1 up. */
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === seasonId && (s_(g.HomeTeamID) === teamId || s_(g.AwayTeamID) === teamId);
  }).map(gameRow_).sort(function (a, b) {
    const ap = a.hs !== null, bp = b.hs !== null;
    if (ap !== bp) return ap ? -1 : 1;
    return ap ? (b.order || 0) - (a.order || 0)
              : (a.order || 0) - (b.order || 0);
  });

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  const roster = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId;
  }).map(function (r) {
    var p = players[s_(r.PlayerID)] || {};
    // Positions is the controlled multi-select a coach fills in; the old free-text
    // columns are only a fallback for seasons nobody has revisited yet.
    var codes = parsePositions_(r.Positions);
    var out = { playerId: s_(r.PlayerID), name: s_(p.DisplayName) || s_(r.DisplayName),
             jersey: s_(r.Jersey),
             pos: codes.length ? codes.join('/') : (s_(r.Position) || s_(r.OffensePosition)),
             grad: s_(p.GradYear) || s_(r.GradYear),
             ht: num_(r.HeightInches), wt: num_(r.WeightLbs),
             captain: isTrue_(r.IsCaptain),
             commitment: s_(p.Commitment), commitLevel: s_(p.CommitmentLevel) };
    // Every measurable the schema knows, by its own key — one list, so a column
    // added to MEASURABLES reaches the public roster without a second edit here.
    MEASURABLES.forEach(function (m) { out[m.key] = num_(r[m.col]); });
    return out;
  }).sort(function (a, b) { return (num_(a.jersey) || 999) - (num_(b.jersey) || 999); });

  var stats = [];
  if (hasTab_('PlayerSeasonStats')) {
    stats = rowsOf_('PlayerSeasonStats').filter(function (r) {
      return s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId;
    }).map(function (r) {
      var p = players[s_(r.PlayerID)] || {};
      return { playerId: s_(r.PlayerID), name: s_(p.DisplayName),
               gp: num_(r.GamesPlayed), grain: s_(r.SourceGrain),
               passYds: num_(r.PassYds), passTD: num_(r.PassTD), passInt: num_(r.PassInt),
               rushYds: num_(r.RushYds), rushTD: num_(r.RushTD), rushAtt: num_(r.RushAtt),
               rec: num_(r.Rec), recYds: num_(r.RecYds), recTD: num_(r.RecTD),
               solo: num_(r.TackleSolo), asst: num_(r.TackleAssist),
               sacks: num_(r.Sacks), int: num_(r.Int), tfl: num_(r.TFL),
               // and every column the row actually holds, under its own name,
               // so the team page can show a punter's yards and a kicker's
               // extra points rather than the handful chosen years ago
               stats: apiStatSums_(r) };
    });
  }

  const st = apiStandings_(seasonId).filter(function (r) { return r.teamId === teamId; })[0] || null;
  // fifty years of season records, and the all-time line they add up to
  const hist = typeof teamHistory_ === 'function' ? teamHistory_(teamId) : [];
  return { team: teamId, games: games, roster: roster, stats: stats, standing: st,
           // the same numbers a school's players carry, added up as the school
           teamStats: teamGameTotals_(teamId, seasonId, games),
           /* What this defence gave up, from the other side's box score —
              conference games only, because those are the only lines we hold. */
           allowed: (function () {
             const conf = {};
             rowsOf_(CONFIG.TABS.TEAMS).forEach(function (x) {
               if (s_(x.TeamID)) conf[s_(x.TeamID)] = true;
             });
             return teamAllowed_(teamId, seasonId, games, statsByGameTeam_(seasonId), conf);
           })(),
           history: hist,
           allTime: hist.length ? teamAllTime_(teamId, hist) : null,
           coachRecord: (hist.length && typeof teamCoachRecord_ === 'function')
             ? teamCoachRecord_(teamId, hist) : null,
           // titles, state semifinals, regional finals — the years, with the
           // counts read off them
           postseason: typeof tpOf_ === 'function' ? tpOf_(teamId) : null,
           // who runs the program: the head coach (his name links to his page)
           // and the assistants beside him
           staff: typeof coachStaff_ === 'function' ? coachStaff_(teamId) : null };
}

// ───────────────────────────────── player

function apiPlayer_(playerId) {
  const p = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (x) { return s_(x.PlayerID) === playerId; })[0];
  if (!p) return null;

  const seasons = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === playerId;
  }).map(function (r) {
    var codes = parsePositions_(r.Positions);
    var out = { seasonId: s_(r.SeasonID), teamId: s_(r.TeamID), jersey: s_(r.Jersey),
                pos: codes.length ? codes.join('/') : (s_(r.Position) || s_(r.OffensePosition)),
                captain: isTrue_(r.IsCaptain) };
    /* Every measurable the portal collects, named off the one list, so a
       player's own page can never again show less than the roster does. This
       read asked for FortyTime and BenchMax - columns an old profile importer
       wrote and nothing writes any more - so a forty entered in the portal
       appeared on the roster and was blank on the player's own page. Those
       names are still read, second, for whatever the old importer left. */
    MEASURABLES.forEach(function (m) { out[m.key] = num_(r[m.col]); });
    if (out.forty === null) out.forty = num_(r.FortyTime);
    if (out.bench === null) out.bench = num_(r.BenchMax);
    out.ht = out.heightInches;        // the short names the profile has always used
    out.wt = out.weightLbs;
    return out;
  });

  var seasonStats = [], career = null;
  if (hasTab_('PlayerSeasonStats')) {
    seasonStats = rowsOf_('PlayerSeasonStats').filter(function (r) {
      return s_(r.PlayerID) === playerId;
    }).map(function (r) {
      const out = { seasonId: s_(r.SeasonID), teamId: s_(r.TeamID), gp: num_(r.GamesPlayed),
               grain: s_(r.SourceGrain), prov: s_(r.Provisional) === 'TRUE',
               passYds: num_(r.PassYds), passTD: num_(r.PassTD), passInt: num_(r.PassInt),
               passAtt: num_(r.PassAtt), passComp: num_(r.PassComp),
               rushAtt: num_(r.RushAtt), rushYds: num_(r.RushYds), rushTD: num_(r.RushTD),
               rec: num_(r.Rec), recYds: num_(r.RecYds), recTD: num_(r.RecTD),
               solo: num_(r.TackleSolo), asst: num_(r.TackleAssist),
               sacks: num_(r.Sacks), int: num_(r.Int), tfl: num_(r.TFL) };
      out.stats = apiStatSums_(r);
      return out;
    }).sort(function (a, b) { return a.seasonId < b.seasonId ? 1 : -1; });
  }
  if (hasTab_('PlayerCareerStats')) {
    const c = rowsOf_('PlayerCareerStats').filter(function (r) { return s_(r.PlayerID) === playerId; })[0];
    if (c) career = { seasons: num_(c.SeasonsPlayed), teams: num_(c.TeamsPlayed), gp: num_(c.GamesPlayed),
                      prov: s_(c.Provisional) === 'TRUE',
                      passYds: num_(c.PassYds), passTD: num_(c.PassTD),
                      rushYds: num_(c.RushYds), rushTD: num_(c.RushTD),
                      rec: num_(c.Rec), recYds: num_(c.RecYds), recTD: num_(c.RecTD),
                      solo: num_(c.TackleSolo), asst: num_(c.TackleAssist),
                      sacks: num_(c.Sacks), int: num_(c.Int), tfl: num_(c.TFL),
                      // and every column the career holds, so the page's totals
                      // card can carry a pick-six and a punt the same as a season row
                      stats: apiStatSums_(c) };
  }

  const gamesIdx = indexBy_(rowsOf_(CONFIG.TABS.GAMES), function (g) { return s_(g.GameID); });
  const log = rowsOf_(CONFIG.TABS.PLAYER_STATS).filter(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.grain) === CONFIG.GRAIN.GAME;
  }).map(function (r) {
    var g = gamesIdx[s_(r.GameID)];
    return { gameId: s_(r.GameID), season: s_(r.SeasonID), week: num_(r.week),
             opp: s_(r.opponent_raw), cat: s_(r.category),
             prov: provisionalSource_(r.SourceType),
             passYds: num_(r.PassYds), passTD: num_(r.PassTD),
             rushAtt: num_(r.RushAtt), rushYds: num_(r.RushYds), rushTD: num_(r.RushTD),
             rec: num_(r.Rec), recYds: num_(r.RecYds), recTD: num_(r.RecTD),
             solo: num_(r.TackleSolo), asst: num_(r.TackleAssist), sacks: num_(r.Sacks), int: num_(r.Int),
             // every stat the row holds, under the names the categories use, so a
             // reader wanting special teams is not limited to the handful above
             stats: apiStatSums_(r),
             // who played whom, and how it finished: enough for a reader of
             // this line to draw the scoreboard beside it without a second
             // read of the schedule
             home: g ? s_(g.HomeTeamID) : '', away: g ? s_(g.AwayTeamID) : '',
             homeName: g ? gameSideName_(g, 'Home') : '',
             awayName: g ? gameSideName_(g, 'Away') : '',
             hs: g ? num_(g.HomeScore) : null, as: g ? num_(g.AwayScore) : null };
  }).sort(function (a, b) {
    return (b.season + '').localeCompare(a.season + '') || (b.week || 0) - (a.week || 0);
  });

  var awards = [];
  try { awards = apiPlayerAwards_(playerId); } catch (e) { awards = []; }

  return {
    id: playerId, name: s_(p.DisplayName), grad: s_(p.GradYear), stars: num_(p.Stars),
    commitment: s_(p.Commitment), commitmentLevel: s_(p.CommitmentLevel),
    offers: (typeof profileParseOffers_ === 'function')
              ? profileParseOffers_(p.Offers) : [],
    hometown: s_(p.Hometown), bio: s_(p.Bio),
    links: { hudl: s_(p.HudlURL), maxpreps: s_(p.MaxPrepsURL),
             x: s_(p.XHandle), instagram: s_(p.InstagramHandle) },
    awards: awards,
    seasons: seasons, seasonStats: seasonStats, career: career, gameLog: log
  };
}

// ───────────────────────────────── search + home

function apiSearch_(q) {
  q = s_(q).toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  const teams = apiBootstrap_().teams;
  teams.forEach(function (t) {
    if (t.name.toLowerCase().indexOf(q) >= 0 || t.mascot.toLowerCase().indexOf(q) >= 0)
      out.push({ type: 'team', id: t.id, label: t.name + ' ' + t.mascot });
  });
  const tIdx = {};
  teams.forEach(function (t) { tIdx[t.id] = t.name; });

  /* Coaches, between the teams and the players: the Coaches tab first, then
     any head coach from the Teams tab who never registered - his staff page
     exists either way, and a parent searching his name should land on it.
     Deduplicated by name-and-team so a registered head coach appears once. */
  const seenCoach = {};
  const coachHit = function (name, teamId, type) {
    const nm = s_(name);
    if (!nm || nm.toLowerCase().indexOf(q) < 0) return;
    const key = nm.toLowerCase() + '|' + s_(teamId);
    if (seenCoach[key]) return;
    seenCoach[key] = true;
    out.push({ type: 'coach', id: s_(teamId), label: nm,
               sub: (tIdx[s_(teamId)] || '') + ' · ' + type });
  };
  if (hasTab_('Coaches')) rowsOf_('Coaches').forEach(function (r) {
    if (String(r.Active) === 'false' || r.Active === false) return;
    if (s_(r.Role) === 'ADMIN') return;
    coachHit(r.DisplayName, r.TeamID,
             s_(r.CoachType).toUpperCase() === 'HEAD' ? 'Head Coach' : 'Assistant Coach');
  });
  rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
    coachHit(t.HeadCoach, t.TeamID, 'Head Coach');
  });

  const ps = rowsOf_(CONFIG.TABS.PLAYER_SEASONS);
  const latest = {};
  ps.forEach(function (r) {
    var pid = s_(r.PlayerID);
    if (!latest[pid] || s_(r.SeasonID) > latest[pid]) latest[pid] = s_(r.SeasonID);
  });
  const teamOf = {};
  ps.forEach(function (r) {
    if (s_(r.SeasonID) === latest[s_(r.PlayerID)]) teamOf[s_(r.PlayerID)] = s_(r.TeamID);
  });
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
    if (out.length > 40) return;
    var n = s_(p.DisplayName);
    if (n.toLowerCase().indexOf(q) >= 0)
      out.push({ type: 'player', id: s_(p.PlayerID), label: n,
                 sub: tIdx[teamOf[s_(p.PlayerID)]] || '' });
  });
  return out.slice(0, 40);
}

function apiHome_(selectedSeason) {
  return cachePublicView_(['home-no-ai-v2', CONFIG.CURRENT_SEASON, s_(selectedSeason), apiTodayStr_()], function () {
    return buildPublicHome_(selectedSeason);
  });
}

function buildPublicHome_(selectedSeason) {
  const season = CONFIG.CURRENT_SEASON;
  const boot = apiBootstrap_();
  // most recent season that actually has results
  var resultSeason = season;
  var scored = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === season && num_(g.HomeScore) !== null;
  });
  if (!scored.length) {
    for (var i = 0; i < boot.seasons.length; i++) {
      var sid = boot.seasons[i].id;
      var any = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
        return s_(g.SeasonID) === sid && num_(g.HomeScore) !== null;
      });
      if (any.length) { resultSeason = sid; break; }
    }
  }
  /* Upcoming is the next WEEK, whole. A game leaves this list the morning after
     its date passes — Friday's games roll off on Saturday whether or not a
     score has been entered yet — and the following week takes the marquee. */
  const todayStr = apiTodayStr_();
  const pool = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    if (s_(g.SeasonID) !== season || num_(g.HomeScore) !== null) return false;
    const d = apiDateStr_(g.GameDate);
    return !d || d >= todayStr;
  }).map(gameRow_);
  // The marquee week belongs to the game that kicks off SOONEST — not the
  // lowest week number. A Week 4 make-up rescheduled to late November must not
  // outrank the playoff round being played this Friday, and a cancelled game
  // that never got a date (or a score) must not pin Home to a dead week all
  // season. Undated games still show once their week is the chosen one.
  const dated = pool.filter(function (g) { return g.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  var nextOrder = dated.length ? (dated[0].order || 0) : 0;
  if (!nextOrder) nextOrder = pool.reduce(function (m, g) {
    return (g.order && (m === 0 || g.order < m)) ? g.order : m;
  }, 0);
  const upcoming = pool.filter(function (g) { return (g.order || 0) === nextOrder; })
    .sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });

  const recent = apiScores_(resultSeason).filter(function (g) { return g.hs !== null; });
  // the LAST round played, not the highest week number — the playoffs restart
  // Week at 1, so a week comparison stops at the regular-season finale
  const latest = recent.reduce(function (m, g) { return Math.max(m, g.order || 0); }, 0);

  const requestedStandings = apiStandings_(s_(selectedSeason) || season);
  const standingsSeason = requestedStandings.length ? (s_(selectedSeason) || season) : resultSeason;
  return {
    currentSeason: season,
    resultSeason: resultSeason,
    standingsSeason: standingsSeason,
    // null for all but thirteen hours a week, and the page draws nothing then
    tonight: apiFridayScores_(),
    // Stored public editorial content only; this read never calls Gemini.
    upcoming: upcoming,
    upcomingLabel: (function () {
      const g = upcoming[0];
      if (!g) return '';
      return g.playoff ? g.roundLabel : (g.week ? 'Week ' + g.week : '');
    })(),
    recent: recent.filter(function (g) { return (g.order || 0) === latest; }),
    latestLabel: (function () {
      const g = recent.filter(function (x) { return (x.order || 0) === latest; })[0];
      if (!g) return '';
      return g.playoff ? g.roundLabel : ('Week ' + g.week);
    })(),
    // The whole table, not a top-eight teaser — Home is the standings page now
    standings: requestedStandings.length ? requestedStandings : apiStandings_(resultSeason),
    // nine boards, top three each — the six that come from play, and the three
    // measurables, which belong to whichever season's roster is being read
    leaders: apiHomeLeaders_(resultSeason, season),
    // the same six that come from play, ranked by school. No measurables: a
    // school does not run a forty.
    teamLeaders: apiHomeTeamLeaders_(resultSeason)
  };
}

// ───────────────────────────────── matchup comparison

/**
 * Side-by-side team comparison for one game: each side's season to date as it
 * stood going into that week. A Week 9 matchup compares Weeks 1–8; a Week 1
 * matchup has no "before", so once Week 1 is played the comparison shows the
 * season as of Week 1 itself, labeled that way. Computed live from the stat
 * rows (not the nightly tables) so a coach's afternoon entry shows up on the
 * evening's matchup card.
 */
function apiMatchup_(gameId) {
  return cacheGet_('mx-' + gameId, 300, function () {
    const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) { return s_(x.GameID) === gameId; })[0];
    if (!g) return null;
    const row = gameRow_(g);
    const season = row.season;
    // A schedule row with no Week has order 0; "before week nothing" would
    // exclude the whole season, so an unweeked game compares season to date.
    var cut = row.order || 0;
    const unweeked = !cut;
    if (unweeked) cut = 100000;

    // per-game order AND played-ness: gp and the stat sums must agree on what
    // counts as a played game (score entered), or per-game rates divide stats
    // from N games by a count of fewer.
    const orderOf = {}, playedGame = {};
    rowsOf_(CONFIG.TABS.GAMES).forEach(function (x) {
      if (s_(x.SeasonID) !== season) return;
      orderOf[s_(x.GameID)] = gameOrder_(x);
      if (num_(x.HomeScore) !== null && num_(x.AwayScore) !== null)
        playedGame[s_(x.GameID)] = true;
    });

    function side(teamId, cutoff) {
      const out = { teamId: teamId, gp: 0, w: 0, l: 0, prov: false };
      if (!/^TEAM-\d+$/.test(teamId)) { out.unknown = true; return out; }
      var pf = 0, pa = 0;
      rowsOf_(CONFIG.TABS.GAMES).forEach(function (x) {
        if (s_(x.SeasonID) !== season || gameOrder_(x) >= cutoff) return;
        var hs = num_(x.HomeScore), as = num_(x.AwayScore);
        if (hs === null || as === null) return;
        if (s_(x.HomeTeamID) === teamId) {
          out.gp++; pf += hs; pa += as;
          if (hs > as) out.w++; else if (hs < as) out.l++;
        } else if (s_(x.AwayTeamID) === teamId) {
          out.gp++; pf += as; pa += hs;
          if (as > hs) out.w++; else if (as < hs) out.l++;
        }
      });
      const sums = {};
      const FIELDS = ['PassYds','PassComp','PassAtt','PassTD','PassInt','RushAtt','RushYds',
                      'RushTD','RushFum','Rec','RecYds','RecTD','RecFum','TackleSolo',
                      'TackleAssist','TFL','Sacks','Int','FF','FR'];
      rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
        if (s_(r.SeasonID) !== season || s_(r.TeamID) !== teamId) return;
        if (s_(r.grain || r.Grain) !== CONFIG.GRAIN.GAME) return;
        const gid = s_(r.GameID);
        const o = orderOf[gid];
        if (o === undefined || o >= cutoff) return;
        if (!playedGame[gid]) return;       // stats only from games gp counts
        if (provisionalSource_(r.SourceType)) out.prov = true;
        for (var i = 0; i < FIELDS.length; i++) {
          var v = num_(r[FIELDS[i]]);
          if (v !== null) sums[FIELDS[i]] = (sums[FIELDS[i]] || 0) + v;
        }
      });
      function per(v) { return (out.gp && v !== undefined) ? Math.round(v / out.gp * 10) / 10 : null; }
      function tot(f) { return sums[f] === undefined ? null : sums[f]; }
      out.ppg  = out.gp ? Math.round(pf / out.gp * 10) / 10 : null;
      out.papg = out.gp ? Math.round(pa / out.gp * 10) / 10 : null;
      out.totYdsPG = (sums.PassYds === undefined && sums.RushYds === undefined)
        ? null : per((sums.PassYds || 0) + (sums.RushYds || 0));
      out.passYdsPG = per(sums.PassYds);
      out.rushYdsPG = per(sums.RushYds);
      out.compPct = sums.PassAtt ? Math.round(1000 * (sums.PassComp || 0) / sums.PassAtt) / 10 : null;
      out.passTD = tot('PassTD'); out.rushTD = tot('RushTD');
      out.intThrown = tot('PassInt');
      out.fumLost = (sums.RushFum === undefined && sums.RecFum === undefined)
        ? null : (sums.RushFum || 0) + (sums.RecFum || 0);
      out.sacks = tot('Sacks'); out.tfl = tot('TFL');
      out.takeaways = (sums.Int === undefined && sums.FR === undefined)
        ? null : (sums.Int || 0) + (sums.FR || 0);
      out.toMargin = (out.takeaways === null && out.intThrown === null && out.fumLost === null)
        ? null : (out.takeaways || 0) - ((out.intThrown || 0) + (out.fumLost || 0));
      out.tacklesPG = (sums.TackleSolo === undefined && sums.TackleAssist === undefined)
        ? null : per((sums.TackleSolo || 0) + (sums.TackleAssist || 0));
      return out;
    }

    // strictly before the game's week; if nothing has been played yet and the
    // game itself has, fold that week in so a Week 1 matchup still compares
    var a = side(row.away, cut), h = side(row.home, cut), inclusive = false;
    const gamePlayed = row.hs !== null && row.as !== null;
    if (!unweeked && !a.gp && !h.gp && gamePlayed) {
      inclusive = true;
      a = side(row.away, cut + 1); h = side(row.home, cut + 1);
    }
    const label = row.playoff ? row.roundLabel : ('Week ' + row.week);
    return {
      id: row.id, season: season, week: row.week, label: label,
      cutoff: unweeked ? 'Season to date'
                       : (inclusive ? ('Season as of ' + label)
                                    : ('Season before ' + label)),
      away: a, home: h
    };
  });
}

// ───────────────────────────────── home leader boards

/**
 * The nine boards on the home page, computed live rather than read from the
 * Leaders tab: two of them (tackles, and the three measurables) are not in
 * that tab at all, and a board that waits for a nightly rebuild would show
 * yesterday's conference. Six come from PlayerSeasonStats — the same rows the
 * Leaders tab is built from — and three from the rosters themselves.
 *
 * `asc` marks lower-is-better, which is only the forty. Blank never competes:
 * a player with no bench press is absent from that board, not last on it.
 */
function apiHomeLeaders_(seasonId, measureSeasonId) {
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  const teams   = indexBy_(rowsOf_(CONFIG.TABS.TEAMS),   function (t) { return s_(t.TeamID); });
  const TOP = 3;

  function board(cat, label, rows, valueOf, opts) {
    opts = opts || {};
    const pool = [];
    rows.forEach(function (r) {
      const v = valueOf(r);
      if (v === null || v === undefined || v === '') return;
      const pid = s_(r.PlayerID);
      if (!pid) return;
      const p = players[pid] || {}, t = teams[s_(r.TeamID)] || {};
      pool.push({ playerId: pid, player: s_(p.DisplayName) || pid,
                  teamId: s_(r.TeamID), team: s_(t.DisplayName) || s_(r.TeamID),
                  value: v, prov: s_(r.Provisional) === 'TRUE' });
    });
    pool.sort(function (a, b) {
      const d = opts.asc ? a.value - b.value : b.value - a.value;
      return d || a.player.localeCompare(b.player);      // stable, never arbitrary
    });
    /* Each board names the season its rows were drawn from, because two
       different ones share this card: the stat boards read the newest season
       with results while the measurables read the current rosters, and a
       reader shown both under one heading deserves to know which is which.
       The client renders the season into the label and into the link out. */
    return { cat: cat, label: label, unit: opts.unit || '', dp: opts.dp || 0,
             seasonId: opts.sid || seasonId, measure: !!opts.measure,
             rows: pool.slice(0, TOP).map(function (r, i) {
               r.rank = i + 1; return r;
             }) };
  }

  const seasonRows = hasTab_('PlayerSeasonStats')
    ? rowsOf_('PlayerSeasonStats').filter(function (r) { return s_(r.SeasonID) === seasonId; })
    : [];
  function statOf(field) {
    return function (r) { return num_(r[field]); };
  }

  /* Measurables on the home page describe players you can still go and watch,
     so they read the CURRENT season's rosters and nothing else. There is
     deliberately no fallback to an older season: every earlier roster is full
     of players who have since graduated, and a graduate's forty time has no
     business leading this year's board. An empty board says so instead. The
     Stats page keeps the whole archive, graduates included — that is history,
     and history is what it is for. */
  const mSeason = s_(measureSeasonId) || seasonId;
  const mYear = Number(String(mSeason).replace(/[^\d]/g, '')) || 0;
  const seats = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    if (s_(r.SeasonID) !== mSeason) return false;
    // Belt and braces: a seat on this season's roster should already mean an
    // eligible player, but a stale import row must not slip a graduate in.
    const grad = num_(players[s_(r.PlayerID)] && players[s_(r.PlayerID)].GradYear) ||
                 num_(r.GradYear);
    return !(grad && mYear && grad <= mYear);
  });
  function measureOf(col) {
    return function (r) { return num_(r[col]); };
  }

  return [
    board('PassYds', 'Passing Yards',  seasonRows, statOf('PassYds')),
    board('RushYds', 'Rushing Yards',  seasonRows, statOf('RushYds')),
    board('RecYds',  'Receiving Yards',seasonRows, statOf('RecYds')),
    // tackles are derived and stored nowhere: solo plus assists, the way the
    // conference counts them
    board('Tackles', 'Tackles', seasonRows, function (r) {
      const so = num_(r.TackleSolo), as = num_(r.TackleAssist);
      return (so === null && as === null) ? null : (so || 0) + (as || 0);
    }),
    board('Sacks',   'Sacks',          seasonRows, statOf('Sacks'), { dp: 1 }),
    board('Int',     'Interceptions',  seasonRows, statOf('Int')),
    board('Forty',   '40-Yard Dash',   seats, measureOf('Forty'),
          { asc: true, unit: 's', dp: 2, sid: mSeason, measure: true }),
    board('Bench',   'Bench',          seats, measureOf('Bench'),
          { unit: ' lb', sid: mSeason, measure: true }),
    board('Squat',   'Squat',          seats, measureOf('Squat'),
          { unit: ' lb', sid: mSeason, measure: true })
  ];
}

/**
 * The same six boards, ranked by school rather than by player.
 *
 * Measurables are deliberately absent: a school does not run a forty, and the
 * fastest roster is a question about averages that nobody asked. The six that
 * remain are summed from the very rows the player boards rank, so a school's
 * figure is the sum of its own players' - the two cards on the home page
 * cannot contradict each other.
 */
function apiHomeTeamLeaders_(seasonId) {
  const teams = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return s_(t.TeamID); });
  const TOP = 3;
  const rows = hasTab_('PlayerSeasonStats')
    ? rowsOf_('PlayerSeasonStats').filter(function (r) { return s_(r.SeasonID) === seasonId; })
    : [];

  // one bag per school, and the games it has played, for the boards that want a rate
  const bags = {};
  rows.forEach(function (r) {
    const tid = s_(r.TeamID);
    if (!tid) return;
    const bag = bags[tid] || (bags[tid] = {});
    SUM_FIELDS.forEach(function (f) {
      const v = num_(r[f]);
      if (v !== null) bag[f] = (bag[f] || 0) + v;
    });
  });

  function board(cat, label, valueOf, opts) {
    opts = opts || {};
    const pool = [];
    Object.keys(bags).forEach(function (tid) {
      const v = valueOf(bags[tid]);
      if (v === null || v === undefined || v === '' || v === 0) return;
      const t = teams[tid] || {};
      pool.push({ teamId: tid, team: s_(t.DisplayName) || tid, value: v });
    });
    /* Most is best on every offensive board, and fewest on every defensive one:
       the best run defence is the one that gave up the least. Without this the
       leaderboard would name the worst three in the conference. */
    pool.sort(function (a, b) {
      return (opts.low ? (a.value - b.value) : (b.value - a.value)) || a.team.localeCompare(b.team);
    });
    return { cat: cat, label: label, unit: opts.unit || '', dp: opts.dp || 0,
             seasonId: seasonId, team: true, low: !!opts.low, note: opts.note || '',
             rows: pool.slice(0, TOP).map(function (r, i) { r.rank = i + 1; return r; }) };
  }
  const of = function (f) { return function (b) { return b[f] === undefined ? null : b[f]; }; };

  return [
    board('PassYds', 'Passing Yards',   of('PassYds')),
    board('RushYds', 'Rushing Yards',   of('RushYds')),
    board('RecYds',  'Receiving Yards', of('RecYds')),
    board('Tackles', 'Tackles', function (b) {
      const so = b.TackleSolo, as = b.TackleAssist;
      return (so === undefined && as === undefined) ? null : (so || 0) + (as || 0);
    }),
    board('Sacks',   'Sacks',           of('Sacks'), { dp: 1 }),
    board('Int',     'Interceptions',   of('Int'))
  ].concat(apiTeamDefenseBoards_(seasonId, teams, TOP));
}

/**
 * Who has the best run defence, pass defence, and defence.
 *
 * Per game, never in total: these are built only from conference games, a
 * school has played a different number of them from its neighbour, and ranking
 * totals across unequal schedules would put the team with the lightest
 * conference schedule on top of every board. A team with no conference game
 * fully reported is simply absent — one game is a result, not a defence, so
 * nothing is ranked until a school has at least one line to rank.
 */
function apiTeamDefenseBoards_(seasonId, teams, TOP) {
  const conf = {};
  rowsOf_(CONFIG.TABS.TEAMS).forEach(function (x) { if (s_(x.TeamID)) conf[s_(x.TeamID)] = true; });
  const byGame = statsByGameTeam_(seasonId);

  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === seasonId;
  }).map(gameRow_);

  const bags = {};
  Object.keys(conf).forEach(function (tid) {
    const mine = games.filter(function (g) { return g.home === tid || g.away === tid; });
    const a = teamAllowed_(tid, seasonId, mine, byGame, conf);
    if (a && a.gp) bags[tid] = { gp: a.gp, s: a.season, have: a.have || {} };
  });

  /* `needs` names the fields a board is made of. A school is ranked only where
     EVERY one of them was reported in EVERY game counted — otherwise a missing
     column sums to nothing, and nothing divided by two games is 0.0, which
     sorts to the top of a board where fewest wins. The team that reported least
     would lead every defensive board on the page. */
  function dboard(cat, label, needs, valueOf, opts) {
    opts = opts || {};
    const pool = [];
    Object.keys(bags).forEach(function (tid) {
      const B = bags[tid];
      const complete = needs.every(function (f) { return B.have[f] === B.gp; });
      if (!complete) return;
      const v = valueOf(B.s, B.gp);
      if (v === null || v === undefined || isNaN(v)) return;
      const t = teams[tid] || {};
      pool.push({ teamId: tid, team: s_(t.DisplayName) || tid,
                  value: Math.round(v * 10) / 10, gp: B.gp });
    });
    pool.sort(function (a, b) { return (a.value - b.value) || a.team.localeCompare(b.team); });
    return { cat: cat, label: label, unit: opts.unit || '', dp: 1, seasonId: seasonId,
             team: true, low: true,
             rows: pool.slice(0, TOP).map(function (r, i) { r.rank = i + 1; return r; }) };
  }
  const per = function (f) {
    return function (b, gp) { return gp ? (b[f] || 0) / gp : null; };
  };

  return [
    dboard('TotYdsAll',  'Total Yards Allowed', ['RushYds', 'RecYds'], function (b, gp) {
      return gp ? ((b.RushYds || 0) + (b.RecYds || 0)) / gp : null; }),
    dboard('RushYdsAll', 'Rushing Yards Allowed',   ['RushYds'], per('RushYds')),
    dboard('PassYdsAll', 'Passing Yards Allowed',   ['RecYds'],  per('RecYds')),
    dboard('RushTDAll',  'Rushing TDs Allowed',     ['RushTD'],  per('RushTD')),
    dboard('PassTDAll',  'Passing TDs Allowed',     ['PassTD'],  per('PassTD')),
    /* Sacks a team gave up are the sacks its opponents recorded — an offensive
       line's number, sitting in the opponent's defensive column. */
    dboard('SacksAll',   'Sacks Allowed',           ['Sacks'],   per('Sacks')),
    dboard('TFLAll',     'TFL Allowed',             ['TFL'],     per('TFL')),
    dboard('YPCAll',     'Yards per Carry Allowed', ['RushAtt', 'RushYds'], function (b) {
      return b.RushAtt ? (b.RushYds || 0) / b.RushAtt : null; }),
    dboard('YPAAll',     'Yards per Pass Allowed',  ['PassAtt', 'RecYds'], function (b) {
      return b.PassAtt ? (b.RecYds || 0) / b.PassAtt : null; })
  ];
}
