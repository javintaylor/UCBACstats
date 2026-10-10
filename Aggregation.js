/**
 * UCBAC Stats — Aggregations.gs
 *
 * The derivation chain. PlayerGameStats is the only input; everything else is
 * computed and disposable.
 *
 *   PlayerGameStats -> PlayerSeasonStats -> PlayerCareerStats
 *                   -> TeamSeasonStats   -> Standings
 *                   -> Leaders
 *
 * TWO RULES THAT MATTER:
 *   1. blank != zero. A blank cell means "not reported" and must not become 0.
 *   2. grain precedence per player+season+category:
 *        if any GAME rows exist      -> sum the GAME rows
 *        else if SEASON_TOTAL exists -> use it
 *      SEASON_REF is NEVER summed. It exists only to reconcile against.
 */

const SUM_FIELDS = [
  'PassAtt','PassComp','PassYds','PassTD','PassInt',
  'RushAtt','RushYds','RushTD','RushFum',
  'Rec','RecYds','RecTD','RecFum','Pancakes',
  'TackleSolo','TackleAssist','TFL','Sacks','Int','FF','FR','PassDef','DefTD',
  'FGM','FGA','XPM','XPA','Punts','PuntYds','KR','KRYds','PR','PRYds','Blocks',
  // milestone-game counts. Nobody ENTERS these — computePlayerSeasonStats
  // counts them from the game rows — but they live in this list so career
  // totals and multi-season ranges sum them like any other column.
  'Rush100G','Rec100G','Pass200G'
];

/**
 * A stat line nobody official has confirmed yet: a player's own entry. It
 * publishes grey and sits in the review queue until a coach or an
 * administrator approves it, or a coach writes the line himself. A coach's
 * upload (FILE_IMPORT) is NOT provisional - it is the coach's word, official
 * as it lands, and he uploads again to change it. Every "is this
 * provisional?" test goes through here so nothing can drift.
 */
function provisionalSource_(v) {
  const t = String(v === null || v === undefined ? '' : v).trim();
  return t === 'PLAYER_ENTRY';
}

/** Number or null — blank/non-numeric never becomes zero. */
function numOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function addInto_(acc, rec) {
  for (var i = 0; i < SUM_FIELDS.length; i++) {
    var f = SUM_FIELDS[i];
    var v = numOrNull_(rec[f]);
    if (v === null) continue;
    acc[f] = (acc[f] === undefined ? 0 : acc[f]) + v;
  }
}

/**
 * Season totals per player.
 * Returns [{PlayerID, SeasonID, TeamID, GamesPlayed, SourceGrain, ...sums}]
 */
function computePlayerSeasonStats_() {
  const stats = rowsOf_(CONFIG.TABS.PLAYER_STATS);
  const buckets = {};          // playerId|seasonId -> bucket

  for (var i = 0; i < stats.length; i++) {
    var r = stats[i];
    var pid = String(r.PlayerID || '').trim();
    var sid = String(r.SeasonID || '').trim();
    if (!pid || !sid) continue;

    var grain = String(r.grain || r.Grain || '').trim();
    if (grain === CONFIG.GRAIN.SEASON_REF) continue;      // reference only

    var key = pid + '|' + sid;
    var b = buckets[key];
    if (!b) {
      b = buckets[key] = {
        PlayerID: pid, SeasonID: sid, TeamID: String(r.TeamID || '').trim(),
        game: {}, season: {}, games: {}, gyds: {}, hasGame: false, hasSeason: false,
        prov: false
      };
    }
    if (!b.TeamID && r.TeamID) b.TeamID = String(r.TeamID).trim();

    if (grain === CONFIG.GRAIN.GAME) {
      b.hasGame = true;
      // one unapproved player-entered line taints the whole total: the sum
      // contains a number no official has confirmed, and the site shows it grey
      if (provisionalSource_(r.SourceType)) b.prov = true;
      addInto_(b.game, r);
      var gid = String(r.GameID || '').trim();
      if (gid) b.games[gid] = true;
      else if (r.week !== '' && r.week !== null) b.games['wk' + r.week] = true;
      // per-game yardage, for the 100/200-yard milestone counts
      var gk = gid || ('wk' + r.week);
      var gy = b.gyds[gk] || (b.gyds[gk] = { rush: 0, rec: 0, pass: 0 });
      gy.rush += numOrNull_(r.RushYds) || 0;
      gy.rec  += numOrNull_(r.RecYds)  || 0;
      gy.pass += numOrNull_(r.PassYds) || 0;
    } else if (grain === CONFIG.GRAIN.SEASON_TOTAL) {
      b.hasSeason = true;
      addInto_(b.season, r);
    }
  }

  const out = [];
  Object.keys(buckets).forEach(function (k) {
    var b = buckets[k];
    var use = b.hasGame ? b.game : (b.hasSeason ? b.season : null);
    if (!use) return;
    var rec = {
      PlayerSeasonStatID: 'PSS-' + b.SeasonID.replace('SEA-', '') + '-' + b.PlayerID,
      PlayerID: b.PlayerID, SeasonID: b.SeasonID, TeamID: b.TeamID,
      GamesPlayed: b.hasGame ? Object.keys(b.games).length : '',
      SourceGrain: b.hasGame ? CONFIG.GRAIN.GAME : CONFIG.GRAIN.SEASON_TOTAL,
      Provisional: (b.hasGame && b.prov) ? 'TRUE' : '',
      ComputedAt: new Date()
    };
    for (var i = 0; i < SUM_FIELDS.length; i++) {
      var f = SUM_FIELDS[i];
      rec[f] = (use[f] === undefined) ? '' : use[f];
    }
    // Milestone games are countable only where game rows exist. A season filed
    // as one total stays blank — unknowable, not zero.
    if (b.hasGame) {
      var r100 = 0, c100 = 0, p200 = 0;
      Object.keys(b.gyds).forEach(function (gk) {
        if (b.gyds[gk].rush >= 100) r100++;
        if (b.gyds[gk].rec  >= 100) c100++;
        if (b.gyds[gk].pass >= 200) p200++;
      });
      rec.Rush100G = r100; rec.Rec100G = c100; rec.Pass200G = p200;
    }
    out.push(rec);
  });
  return out;
}

/** Career totals — aggregate on PlayerID across every season and team. */
function computePlayerCareerStats_(seasonRows) {
  const byPlayer = {};
  for (var i = 0; i < seasonRows.length; i++) {
    var r = seasonRows[i];
    var b = byPlayer[r.PlayerID];
    if (!b) {
      b = byPlayer[r.PlayerID] = { PlayerID: r.PlayerID, seasons: {}, teams: {}, gp: 0,
                                   sums: {}, prov: false };
    }
    if (String(r.Provisional || '') === 'TRUE') b.prov = true;
    b.seasons[r.SeasonID] = true;
    if (r.TeamID) b.teams[r.TeamID] = true;
    var gp = numOrNull_(r.GamesPlayed);
    if (gp !== null) b.gp += gp;
    for (var j = 0; j < SUM_FIELDS.length; j++) {
      var f = SUM_FIELDS[j];
      var v = numOrNull_(r[f]);
      if (v === null) continue;
      b.sums[f] = (b.sums[f] === undefined ? 0 : b.sums[f]) + v;
    }
  }
  const out = [];
  Object.keys(byPlayer).forEach(function (pid) {
    var b = byPlayer[pid];
    var rec = {
      PlayerID: pid,
      SeasonsPlayed: Object.keys(b.seasons).length,
      TeamsPlayed: Object.keys(b.teams).length,
      GamesPlayed: b.gp || '',
      Provisional: b.prov ? 'TRUE' : '',
      ComputedAt: new Date()
    };
    for (var j = 0; j < SUM_FIELDS.length; j++) {
      var f = SUM_FIELDS[j];
      rec[f] = (b.sums[f] === undefined) ? '' : b.sums[f];
    }
    out.push(rec);
  });
  return out;
}

/**
 * Who lost a forfeit, or ''.
 *
 * A forfeited game is a decision, not a draw, but it is often filed as 0-0 —
 * and 0-0 walks straight into the tie branch below, which is how Elkton's
 * 2025 read 10-1-1 against an outside record of 11-1, and Harford Tech's
 * 1-8-1 against 1-9. One row, two wrong records.
 *
 * The forfeiting team is named either in a ForfeitBy column, or in the
 * game's Notes ("Harford Tech forfeit"). Nothing is inferred: a forfeit
 * naming nobody, or naming both teams, is left out of the standings
 * entirely rather than recorded as a tie somebody could quote.
 */
/**
 * Which SIDE forfeited — 'HOME', 'AWAY', or '' when nothing says.
 *
 * A side, not a TeamID, because the team that forfeits may not have one. A
 * non-conference opponent is carried on the game by name alone, with no row in
 * the Teams tab and often no id at all, and Benjamin Franklin forfeiting to
 * Joppatowne could not be recorded at all while this answered in ids: there
 * was no id to give it, and matching by name only consulted the Teams tab,
 * where it does not appear.
 *
 * So each side is matched against every name it answers to: its id, its name
 * in the Teams tab, and the name written on the game itself — the last being
 * the only one an outside opponent has.
 */
function forfeitSide_(g, teams) {
  if (String(g.Status || '').trim().toUpperCase() !== 'FORFEIT') return '';
  const home = String(g.HomeTeamID || '').trim(), away = String(g.AwayTeamID || '').trim();
  const named = String(g.ForfeitBy || '').trim();
  if (named && named === home) return 'HOME';
  if (named && named === away) return 'AWAY';

  const namesFor = function (id, sideName) {
    const out = [];
    if (id) out.push(id.toLowerCase());
    const t = teams.filter(function (x) { return String(x.TeamID).trim() === id; })[0];
    const nm = String((t && t.DisplayName) || '').toLowerCase().trim();
    if (nm) out.push(nm);
    const sn = String(sideName || '').toLowerCase().trim();
    if (sn && out.indexOf(sn) < 0) out.push(sn);
    return out;
  };
  const hn = namesFor(home, g.HomeTeamName), an = namesFor(away, g.AwayTeamName);
  const decide = function (hit, ait) {
    if (hit && !ait) return 'HOME';
    if (ait && !hit) return 'AWAY';
    return '';                    // both named, or neither: not a decision
  };

  // ForfeitBy may hold a name rather than an id
  if (named) {
    const q = named.toLowerCase();
    const byName = decide(hn.indexOf(q) >= 0, an.indexOf(q) >= 0);
    if (byName) return byName;
  }

  const note = String(g.Notes || '').toLowerCase();
  if (!note) return '';
  const inNote = function (names) {
    return names.some(function (n) { return note.indexOf(n) >= 0; });
  };
  return decide(inNote(hn), inNote(an));
}

/**
 * Where a game falls in the season, as one comparable number: the week,
 * with playoff rounds counted past the last regular week. The same rule
 * Api.gs uses for the schedule, kept here so the standings need nothing
 * from the site layer.
 */
function standingsOrder_(g) {
  const w = numOrNull_(g.Week) || 0;
  const phase = String(g.Phase || '').trim().toUpperCase();
  const playoff = phase === 'ROUND' || phase === 'PLAYOFF' ||
                  String(g.GameType || '').trim().toUpperCase() === 'PLAYOFF';
  return playoff ? 100 + w : w;
}

/**
 * Standings from Games. Forfeits count; games without a score do not.
 *
 * With `throughOrder`, only games up to and including that week count — the
 * standings as they stood then. Without it, every scored game counts, and
 * each row also carries PrevRank: the team's place as of the week BEFORE
 * the latest week with a result, so the site can show who moved. There is
 * no PrevRank when the latest week is the first with results, and none when
 * the week before it is week 0 — a week-0 table of two or three games is not
 * a standing anybody fell from.
 */
function computeStandings_(seasonId, throughOrder) {
  const games = rowsOf_(CONFIG.TABS.GAMES);
  const teams = rowsOf_(CONFIG.TABS.TEAMS);
  const rec = {};
  const modernStandings = conferenceStandingsApplies_(seasonId);
  teams.forEach(function (t) {
    if (modernStandings && String(t.IsConferenceMember).toLowerCase() === 'false') return;
    rec[t.TeamID] = { TeamID: t.TeamID, TeamName: t.DisplayName, SeasonID: seasonId,
                      W: 0, L: 0, T: 0, ConfW: 0, ConfL: 0, PF: 0, PA: 0 };
  });
  const cutoff = (throughOrder === undefined || throughOrder === null) ? null : Number(throughOrder);

  games.forEach(function (g) {
    if (String(g.SeasonID).trim() !== seasonId) return;
    if (modernStandings && !conferenceStandingsFinal_(g)) return;
    var hs = numOrNull_(g.HomeScore), as = numOrNull_(g.AwayScore);
    if (cutoff !== null && standingsOrder_(g) > cutoff) return;
    var h = rec[String(g.HomeTeamID).trim()], a = rec[String(g.AwayTeamID).trim()];
    var conf = String(g.GameType).trim() === 'CONFERENCE' && (!modernStandings || conferenceStandingsRegular_(g));
    var isForfeit = String(g.Status || '').trim().toUpperCase() === 'FORFEIT';

    /* A forfeit is decided by who forfeited, not by the scoreboard, and it
       counts whether or not anybody entered a score. Nobody plays a forfeit,
       so there is often no score to enter, and requiring one meant the game
       vanished from the standings entirely — the win simply never arrived.

       An unequal score is left to the ordinary reckoning below: 2-0 written
       against a forfeit is somebody recording the outcome by the convention
       for it, and the scoreboard and the status then agree. */
    if (isForfeit && (hs === null || as === null || hs === as)) {
      const side = forfeitSide_(g, teams);
      if (!side) {
        // a forfeit naming nobody: better absent than filed as a draw
        Logger.log('standings: ' + String(g.GameID) + ' is a forfeit with no team named — skipped. ' +
                   'Put the forfeiting team in Notes or a ForfeitBy column.');
        return;
      }
      const win = side === 'HOME' ? a : h;
      const lose = side === 'HOME' ? h : a;
      // the points stand as recorded, where any were - a forfeit earns a win,
      // not a scoring record
      if (hs !== null && as !== null) {
        if (h) { h.PF += hs; h.PA += as; }
        if (a) { a.PF += as; a.PA += hs; }
      }
      if (win) { win.W++; if (conf) win.ConfW++; }
      if (lose) { lose.L++; if (conf) lose.ConfL++; }
      return;
    }
    if (hs === null || as === null) return;

    if (h) {
      h.PF += hs; h.PA += as;
      if (hs > as) { h.W++; if (conf) h.ConfW++; }
      else if (hs < as) { h.L++; if (conf) h.ConfL++; }
      else h.T++;
    }
    if (a) {
      a.PF += as; a.PA += hs;
      if (as > hs) { a.W++; if (conf) a.ConfW++; }
      else if (as < hs) { a.L++; if (conf) a.ConfL++; }
      else a.T++;
    }
  });

  // 2023 exists only as season aggregates — no game rows, so the loop above
  // finds nothing for it. A team with no scored games takes its record from
  // the TeamSeasons tab instead; points stay blank where nobody recorded
  // them, never zero. Records there include playoffs, which is the intent.
  if ((!modernStandings || cutoff === null) && hasTab_(CONFIG.TABS.TEAM_SEASONS)) {
    rowsOf_(CONFIG.TABS.TEAM_SEASONS).forEach(function (t) {
      if (String(t.SeasonID).trim() !== seasonId) return;
      var r = rec[String(t.TeamID).trim()];
      if (!r || r.W + r.L + r.T > 0) return;          // played games are authoritative
      var w = numOrNull_(t.Wins), l = numOrNull_(t.Losses);
      if (w === null && l === null) return;
      r.W = w || 0; r.L = l || 0;
      r.ConfW = numOrNull_(t.ConfWins) || 0;
      r.ConfL = numOrNull_(t.ConfLosses) || 0;
      r.PF = numOrNull_(t.PointsFor);
      r.PA = numOrNull_(t.DefPointsAllowed);
    });
  }

  const out = Object.keys(rec).map(function (k) { return rec[k]; })
    .filter(function (r) { return r.W + r.L + r.T > 0; });
  out.forEach(function (r) {
    r.Diff = (numOrNull_(r.PF) === null || numOrNull_(r.PA) === null) ? '' : r.PF - r.PA;
    if (r.PF === null) r.PF = '';
    if (r.PA === null) r.PA = '';
    r.WinPct = (r.W + r.L) ? Math.round(r.W / (r.W + r.L) * 1000) / 1000 : '';
    // NOTE: do NOT store a "W-L" string. Sheets coerces "11-1" into a duration
    // ("6s") — the same corruption that destroyed the 2023 records in the source
    // workbook. W/L/ConfW/ConfL are the atoms; the site formats them for display.
    r.ComputedAt = new Date();
  });
  // Keep archived seasons under the rules used to publish them. The new policy
  // begins in 2026 and is retained when CONFIG.CURRENT_SEASON advances.
  var conferenceOrder = modernStandings ? conferenceStandingsOrder_(out, games, teams, seasonId, cutoff) : null;
  out.sort(function (x, y) {
    if (conferenceOrder) return conferenceOrder.position[x.TeamID] - conferenceOrder.position[y.TeamID];
    return (y.ConfW - y.ConfL) - (x.ConfW - x.ConfL) || (y.W - y.L) - (x.W - x.L) ||
           (numOrNull_(y.Diff) || 0) - (numOrNull_(x.Diff) || 0);
  });
  out.forEach(function (r, i) { r.Rank = conferenceOrder ? conferenceOrder.ranks[r.TeamID] : i + 1; });

  if (cutoff === null) {
    /* the week before the latest week with a result, and where everyone
       stood then - blank when there is no such week worth comparing to */
    const played = games.filter(function (g) {
      if (String(g.SeasonID).trim() !== seasonId) return false;
      if (modernStandings && !conferenceStandingsFinal_(g)) return false;
      if (modernStandings && String(g.Status).toUpperCase() === 'FORFEIT' && forfeitSide_(g, teams)) return true;
      return numOrNull_(g.HomeScore) !== null && numOrNull_(g.AwayScore) !== null;
    }).map(standingsOrder_);
    const latest = played.reduce(function (m, o) { return Math.max(m, o); }, -1);
    const before = played.filter(function (o) { return o < latest; })
      .reduce(function (m, o) { return Math.max(m, o); }, -1);
    const prev = {};
    if (latest > before && before >= 1) {
      computeStandings_(seasonId, before).forEach(function (r) { prev[r.TeamID] = r.Rank; });
    }
    out.forEach(function (r) {
      r.PrevRank = prev[r.TeamID] === undefined ? '' : prev[r.TeamID];
    });
  }
  // Append after PrevRank, preserving the app's existing A:O public contract.
  out.forEach(function(r) {
    var c = conferenceOrder && conferenceOrder.records[r.TeamID];
    if (!Object.prototype.hasOwnProperty.call(r, 'PrevRank')) r.PrevRank = '';
    r.ConfT = c ? c.t : '';
    r.ConfPct = c ? conferenceStandingsPct_(c.w,c.l,c.t) : '';
    r.RankReason = conferenceOrder ? conferenceOrder.reasons[r.TeamID] : '';
    r.RankTied = conferenceOrder ? !!conferenceOrder.tied[r.TeamID] : false;
    r.ConfMarginAvg = c && c.scored ? c.margin/c.scored : '';
    r.StandingsRule = conferenceOrder ? CONFERENCE_STANDINGS.version : 'LEGACY';
  });
  return out;
}

/** Force the rank columns back to plain numbers, whatever they were given. */
function standingsPlainNumbers_() {
  try {
    const sh = db_().getSheetByName('Standings');
    if (!sh || sh.getLastRow() < 2) return;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h || '').trim(); });
    ['Rank', 'PrevRank'].forEach(function (col) {
      const i = head.indexOf(col);
      if (i < 0) return;
      sh.getRange(2, i + 1, sh.getLastRow() - 1, 1).setNumberFormat('0');
    });
  } catch (ignore) {}        // a formatting nicety must never fail a rebuild
}

/** Top-N leaders per category, with a qualifier so rate stats stay honest. */
function computeLeaders_(seasonId, seasonRows) {
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return p.PlayerID; });
  const teams   = indexBy_(rowsOf_(CONFIG.TABS.TEAMS),   function (t) { return t.TeamID; });

  const CATS = [
    { key: 'PassYds',  label: 'Passing Yards' },
    { key: 'PassTD',   label: 'Passing TD' },
    { key: 'RushYds',  label: 'Rushing Yards' },
    { key: 'RushTD',   label: 'Rushing TD' },
    { key: 'RecYds',   label: 'Receiving Yards' },
    { key: 'RecTD',    label: 'Receiving TD' },
    { key: 'Sacks',    label: 'Sacks' },
    { key: 'Int',      label: 'Interceptions' },
    { key: 'TFL',      label: 'Tackles for Loss' }
  ];

  const out = [];
  CATS.forEach(function (cat) {
    var pool = seasonRows.filter(function (r) {
      return String(r.SeasonID).trim() === seasonId && numOrNull_(r[cat.key]) !== null;
    });
    // combined tackles are derived, never stored
    pool.sort(function (a, b) { return numOrNull_(b[cat.key]) - numOrNull_(a[cat.key]); });
    pool.slice(0, 25).forEach(function (r, i) {
      var p = players[r.PlayerID] || {};
      var t = teams[r.TeamID] || {};
      out.push({
        SeasonID: seasonId, Category: cat.key, CategoryLabel: cat.label, Rank: i + 1,
        PlayerID: r.PlayerID, PlayerName: p.DisplayName || r.PlayerID,
        TeamID: r.TeamID, TeamName: t.DisplayName || r.TeamID,
        Value: numOrNull_(r[cat.key]), GamesPlayed: r.GamesPlayed,
        SourceGrain: r.SourceGrain, Provisional: String(r.Provisional || ''),
        ComputedAt: new Date()
      });
    });
  });
  return out;
}

/**
 * Rebuild the whole derived layer. Safe to run any time — it is idempotent
 * and every output tab is disposable.
 */
function rebuildDerived_() {
  if (typeof appPublicDirectWrite_ === 'function' && !__appPublicWriteDepth) return appPublicDirectWrite_(function () { return rebuildDerived_(); });
  const t0 = new Date().getTime();
  const log = [];

  const seasonStats = computePlayerSeasonStats_();
  // explicit headers: replaceRows reuses the sheet's existing header row by
  // default, which would silently drop columns added since the last rebuild
  log.push('PlayerSeasonStats  ' + replaceRows_('PlayerSeasonStats', seasonStats,
    seasonStats.length ? Object.keys(seasonStats[0]) : null));

  const career = computePlayerCareerStats_(seasonStats);
  log.push('PlayerCareerStats  ' + replaceRows_('PlayerCareerStats', career,
    career.length ? Object.keys(career[0]) : null));

  var allStandings = [], allLeaders = [];
  rowsOf_(CONFIG.TABS.SEASONS).forEach(function (s_) {
    var sid = String(s_.SeasonID).trim();
    allStandings = allStandings.concat(computeStandings_(sid));
    allLeaders   = allLeaders.concat(computeLeaders_(sid, seasonStats));
  });
  // headers from the rows, so PrevRank lands in a tab written before it existed
  log.push('Standings          ' + conferenceStandingsWrite_(allStandings));
  /* Rank and PrevRank are places in a table. A cell carrying date formatting
     hands them back from getValues as a Date, which reads as milliseconds —
     that is how "down 2208787200001 places" came to sit beside the league
     leader. Rewriting the tab replaces the values but not the cell FORMAT, so
     it is set back to plain here rather than waiting to be noticed again. */
  standingsPlainNumbers_();
  log.push('Leaders            ' + replaceRows_('Leaders', allLeaders));

  const secs = ((new Date().getTime() - t0) / 1000).toFixed(1);
  const msg = 'Rebuilt derived layer in ' + secs + 's\n  ' + log.join(' rows\n  ') + ' rows';
  Logger.log(msg);
  return msg;
}