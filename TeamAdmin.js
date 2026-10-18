/**
 * UCBAC Stats — TeamAdmin.gs
 *
 * What a signed-in COACH may do for his own team, and nothing else.
 *
 * Everything here is a write a scorekeeper makes: the Friday score, the week's
 * box score, who the captains are, where the film lives, and what to do about a
 * player who says a number is wrong. Profile.gs is the mirror image — a player
 * owns what a person knows about himself and may only ASK for a stat to move.
 * This file is where asking turns into moving, and it is the only place a
 * measure reaches PlayerGameStats from a person rather than from an import.
 *
 * Four rules the whole file is built on:
 *
 *   Authorization first. Every entry point calls assertTeamAdmin() before it
 *   reads a row, let alone writes one. The svc* wrappers are callable by any
 *   signed-in Google account, so a hostile caller passing another school's
 *   TeamID, GameID or CorrectionID is the case each function has to survive.
 *   A team is proved twice: once for the caller, once for the row.
 *
 *   Blank is not zero. A blank stat cell means "not reported"; a 0 means
 *   "reported, and it was none". A coach who leaves the receiving column empty
 *   has not claimed his receivers gained nothing. Every value written from here
 *   goes through teamAdminStat(), which returns '' for blank and never 0.
 *
 *   A forfeit survives. The 2023 import lost a forfeit by overwriting it with
 *   the opponent's win, and nobody noticed until the standings were published.
 *   A forfeit is a conference ruling, not a scorekeeping detail, so a coach can
 *   record one but cannot record one away — only an administrator can, and the
 *   change is audited by name.
 *
 *   Nothing rebuilds inline. Scores and box scores arrive in a burst on Friday
 *   night and Saturday morning; markDirty() lets the sweep trigger collapse the
 *   burst into one recompute. A save that also rebuilt would hold the script
 *   lock for a minute while fourteen other coaches waited on it.
 *
 * This file must run under a deployment configured "Execute as: User accessing
 * the web app" — the only configuration in which Session.getActiveUser()
 * identifies the coach rather than returning a blank string.
 */

// Literals rather than CONFIG lookups: Apps Script evaluates every file's
// top-level statements before any function runs, so nothing here may depend on
// another file's constants. Everything below reaches for CONFIG, SUM_FIELDS and
// the PROFILE helpers inside a function body, where they are defined.
const TEAMADMIN = {

  GAME_STATUSES: ['SCHEDULED', 'FINAL', 'FORFEIT', 'CANCELLED', 'POSTPONED'],

  // A running clock and a mercy rule put the real ceiling near 80. 150 is loose
  // enough never to refuse a real game and tight enough to catch a fat finger
  // that would otherwise land in the standings as a 640-point differential.
  MAX_SCORE: 150,

  // NFHS 1-2-4 puts at most four captains at the coin toss. Teams name more than
  // that — seniors, a game captain, a permanent captain — so this is a bound on
  // absurdity rather than a rule: eight is a leadership group, twenty is nobody.
  MAX_CAPTAINS: 8,

  // One team's box score for one game is roughly twenty-five to forty rows once
  // a player who both rushed and caught passes is counted twice. The cap bounds
  // the cell-by-cell write below it, not the sport.
  MAX_STAT_ROWS: 80,

  STAT_MAX: 1000,

  // Sacks and tackles for loss are shared and recorded in halves. Everything
  // else is a count and a half of one is a typo.
  HALF_FIELDS: ['Sacks', 'TFL'],

  // Yardage runs backwards. A count never does — "minus two receptions" is not
  // a thing that happened.
  SIGNED_FIELDS: ['PassYds', 'RushYds', 'RecYds', 'PuntYds', 'KRYds', 'PRYds'],

  /**
   * The PlayerGameStats `category` vocabulary, and which measures belong to
   * each. Together these are exactly SUM_FIELDS partitioned — no measure is in
   * two categories and none is missing, which is what lets the upsert key be
   * (GameID, PlayerID, category) without a player's rushing line quietly
   * overwriting his receiving line.
   *
   * A row is refused if it carries a field from another category. A Passing row
   * holding tackles would be summed once as passing and once as defense the
   * next time the grain resolver ran over it.
   */
  CATEGORIES: {
    Passing:   ['PassAtt', 'PassComp', 'PassYds', 'PassTD', 'PassInt'],
    Rushing:   ['RushAtt', 'RushYds', 'RushTD', 'RushFum'],
    Receiving: ['Rec', 'RecYds', 'RecTD', 'RecFum'],
    // Pancake blocks: the one offensive-line stat collected, and what the OL
    // All-Conference projection ranks on
    Blocking:  ['Pancakes'],
    Defense:   ['TackleSolo', 'TackleAssist', 'TFL', 'Sacks', 'Int', 'FF', 'FR',
                'PassDef', 'DefTD'],
    /* A blocked kick is a special-teams play wherever the man who made it
       lines up, so it is entered here rather than under Defense, which is
       where a box score usually prints it. */
    SpecTeams: ['FGM', 'FGA', 'XPM', 'XPA', 'Punts', 'PuntYds', 'KR', 'KRYds',
                'PR', 'PRYds', 'Blocks', 'BlockedPunts', 'TwoPointConversions']
  },

  CATEGORY_ORDER: ['Passing', 'Rushing', 'Receiving', 'Blocking', 'Defense', 'SpecTeams'],

  /**
   * The Teams columns a coach may write, and how each is validated.
   *
   * A URL field takes any https address. These are filled in by a coach or an
   * administrator who had to sign in to reach the page, and a school's own site
   * is wherever the school put it — no list kept here could stay ahead of them.
   */
  LINK_FIELDS: [
    { key: 'hudlUrl',     col: 'HudlURL',     kind: 'URL' },
    { key: 'schoolUrl',   col: 'SchoolURL',   kind: 'URL' },
    { key: 'facebookUrl', col: 'FacebookURL', kind: 'URL' },
    { key: 'youTubeUrl',  col: 'YouTubeURL',  kind: 'URL' },
    { key: 'tikTokUrl',   col: 'TikTokURL',   kind: 'URL' },
    // the program's own X and Instagram, as handles: the site links them itself
    { key: 'xHandle',         col: 'XHandle',         kind: 'HANDLE', pattern: /^[A-Za-z0-9_]{1,15}$/,  what: 'an X handle' },
    { key: 'instagramHandle', col: 'InstagramHandle', kind: 'HANDLE', pattern: /^[A-Za-z0-9_.]{1,30}$/, what: 'an Instagram handle' },
    { key: 'headCoach',   col: 'HeadCoach',   kind: 'TEXT' },
    { key: 'stadiumName', col: 'StadiumName', kind: 'TEXT' }
  ],

  // The columns this file writes to PlayerGameStats, apart from the measures.
  // Checked against the real header before anything is built for appendRows().
  STAT_KEY_COLS: ['GameID', 'PlayerID', 'TeamID', 'SeasonID'],

  DECISIONS: ['APPROVE', 'REJECT']
};

// ── authorization ──────────────────────────────────────────────────────────

/**
 * Prove the caller may write for this team, before anything is read.
 *
 * assertCanEdit() in Roster.gs is the gate every coach-facing write in this
 * project already goes through, and it reads the Coaches tab — which predates
 * accounts and still carries the administrators who bootstrapped the system. A
 * coach approved through Accounts.gs has no Coaches row at all, so the account
 * grant is tested second. Same rule both ways: ADMIN may write for any team, a
 * COACH only for his own, and everybody else throws.
 *
 * Returns the accountsWhoami() shape, so the audit row names the caller by the
 * role he actually holds rather than by the table he was found in.
 */
function assertTeamAdmin_(teamId) {
  teamId = s_(teamId);
  const me = accountsWhoami_();

  var granted = false;
  try { assertCanEdit_(teamId); granted = true; } catch (e) { granted = false; }

  if (!granted && me.role === 'ADMIN') granted = true;
  if (!granted && me.role === 'COACH' && me.teamId && me.teamId === teamId) granted = true;

  if (!granted)
    throw new Error('Not authorized to edit ' +
                    (teamNameOf_(teamId) || 'this team') +
                    '. Signed in as ' + (me.email || 'nobody') + '.');
  return me;
}

/**
 * The team a caller acts for when the function signature carries no TeamID.
 *
 * apiSaveGameScore() and apiReviewCorrection() are addressed by GameID and
 * CorrectionID, and the team those belong to is not known until the row is read
 * — but authorization has to happen before the read, not after it. So the
 * caller's OWN team is what is asserted here, and the row's team is asserted
 * again once it is in hand. An administrator has no team of his own and passes
 * on the first test by role.
 */
function teamAdminSelf_() {
  const me = accountsWhoami_();
  return assertTeamAdmin_(me.teamId);
}

/** Throws unless this caller may act on a row belonging to `teamId`. */
function assertTeamScope_(me, teamId, what) {
  teamId = s_(teamId);
  if (me.role === 'ADMIN') return teamId;
  if (teamId && me.teamId && me.teamId === teamId) return teamId;
  throw new Error(what + ' belongs to ' + (teamId || 'another team') + ', not to ' +
                  (me.teamId || 'your account') + '.');
}

// ── validation ─────────────────────────────────────────────────────────────

/** A social handle: the @ dropped, the site's own rules for the rest, blank allowed. */
function linkHandle_(v, f) {
  const h = String(v === null || v === undefined ? '' : v).trim().replace(/^@+/, '');
  if (!h) return '';
  if (!f.pattern.test(h)) throw new Error('"' + h + '" is not ' + f.what + '.');
  return h;
}

/**
 * A team link: https, a real host, and nothing else asked of it.
 *
 * The allowlist that used to guard this was written for a player's profile and
 * borrowed here, which was a mistake of scope. A school's own site is wherever
 * the school put it — C. Milton Wright is on cmhs.hcpsschools.org, not on
 * hcps.org — and a program broadcasts on whatever platform it has this year.
 * A list of approved hosts could only ever be behind the schools it governs,
 * and the field it governs is filled in by a coach or an administrator on a
 * page they had to sign in to reach. That is the check that was doing the work.
 *
 * https is still required, because http on an https page is a broken link and
 * a "javascript:" or "data:" one is not a link at all. A player's own profile
 * keeps its allowlist: profileUrl() in Profile.gs, unchanged.
 */
function allowedLinkUrl_(v) {
  const txt = String(v === null || v === undefined ? '' : v).trim();
  if (!txt) return '';
  if (txt.length > 300) throw new Error('That link is too long.');
  if (!/^https:\/\//i.test(txt))
    throw new Error('Links must start with https:// — "' + txt.slice(0, 40) + '" does not.');
  if (!profileHostOf_(txt))
    throw new Error('"' + txt.slice(0, 60) + '" is not a web address.');
  return txt;
}

/** A score: a whole number of points, or blank. Blank is "not played", not 0-0. */
function teamAdminScore_(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (isNaN(n) || Math.floor(n) !== n || n < 0 || n > TEAMADMIN.MAX_SCORE)
    throw new Error(label + ' "' + v + '" is not a whole number of points between 0 and ' +
                    TEAMADMIN.MAX_SCORE + '. Leave it blank if the game has not been played.');
  return n;
}

function teamAdminStatus_(v) {
  const txt = s_(v).toUpperCase().replace(/[\s-]+/g, '_');
  if (!txt) return '';
  if (TEAMADMIN.GAME_STATUSES.indexOf(txt) < 0)
    throw new Error('Status must be one of ' + TEAMADMIN.GAME_STATUSES.join(', ') +
                    '. "' + s_(v) + '" is not.');
  return txt;
}

/** Which side forfeited, as the page says it: HOME, AWAY, or blank for "not said". */
function teamAdminForfeitSide_(v) {
  const txt = s_(v).toUpperCase();
  if (!txt) return '';
  if (txt !== 'HOME' && txt !== 'AWAY')
    throw new Error('Who forfeited must be HOME or AWAY. "' + s_(v) + '" is neither.');
  return txt;
}

/** The category a measure belongs to, or '' when it belongs to none. */
function teamAdminCategoryOf_(field) {
  const cats = TEAMADMIN.CATEGORY_ORDER;
  for (var i = 0; i < cats.length; i++) {
    if (TEAMADMIN.CATEGORIES[cats[i]].indexOf(field) >= 0) return cats[i];
  }
  return '';
}

/**
 * The measures a category accepts, filtered to the ones the aggregation layer
 * actually sums. A field this file offered but SUM_FIELDS did not carry would be
 * written to the sheet and then ignored by every total on the site.
 */
function teamAdminStatFields_(category) {
  const list = TEAMADMIN.CATEGORIES[category];
  if (!list)
    throw new Error('"' + category + '" is not a stat category. Use one of ' +
                    TEAMADMIN.CATEGORY_ORDER.join(', ') + '.');
  return list.filter(function (f) { return SUM_FIELDS.indexOf(f) >= 0; });
}

/**
 * One stat value, ready to store. Blank returns '' and NEVER 0 — that
 * distinction is the whole reason this function exists rather than Number().
 */
function teamAdminStat_(field, v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = numOrNull_(v);
  if (n === null) throw new Error(field + ' "' + v + '" is not a number.');

  const half = TEAMADMIN.HALF_FIELDS.indexOf(field) >= 0;
  if (half) {
    if (n * 2 !== Math.round(n * 2))
      throw new Error(field + ' is recorded in whole numbers or halves. "' + v + '" is neither.');
  } else if (Math.floor(n) !== n) {
    throw new Error(field + ' is a whole number. "' + v + '" is not.');
  }

  const lo = TEAMADMIN.SIGNED_FIELDS.indexOf(field) >= 0 ? -TEAMADMIN.STAT_MAX : 0;
  if (n < lo || n > TEAMADMIN.STAT_MAX)
    throw new Error('A ' + field + ' of ' + n + ' is outside ' + lo + '–' +
                    TEAMADMIN.STAT_MAX + '.');
  return n;
}

/**
 * The real header name for a column the live workbook spells inconsistently.
 *
 * PlayerGameStats came out of the import with lowercase `grain`, `category` and
 * `week` beside TitleCase `GameID` and `PlayerID`. appendRows() and updateCells()
 * both match a header EXACTLY, so guessing which spelling is on the sheet writes
 * a blank column. Ask the header.
 */
function teamAdminCol_(head, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (head.indexOf(candidates[i]) >= 0) return candidates[i];
  }
  return '';
}

/** Did the cell actually change? Blanks compare by emptiness, numbers by value. */
function teamAdminSame_(a, b) {
  const x = (a === null || a === undefined) ? '' : a;
  const y = (b === null || b === undefined) ? '' : b;
  if (x === '' || y === '') return String(x).trim() === String(y).trim();
  const nx = numOrNull_(x), ny = numOrNull_(y);
  if (nx !== null && ny !== null) return nx === ny;
  return String(x).trim() === String(y).trim();
}

/**
 * Invalidate the payloads a write to this season just falsified.
 *
 * Stats.gs keys its own cache on the whole filter combination
 * (STATS_CACHE_PREFIX + scope|side|range|season|county|team|...), which cannot be
 * enumerated and therefore cannot be removed by key. Those entries age out on
 * their own 900-second TTL — see followUps.
 */
function teamAdminBustCache_(seasonId) {
  seasonId = s_(seasonId) || CONFIG.CURRENT_SEASON;
  CacheService.getScriptCache().removeAll([
    'boot',
    'ac-' + seasonId,
    'standings-' + seasonId,
    'leaders-' + seasonId + '-all'
  ]);
}

// ── read ───────────────────────────────────────────────────────────────────

/**
 * Everything the coach portal needs for one team and one season, in ONE round
 * trip.
 *
 * Each google.script.run call is its own execution with its own cold read of
 * every tab it touches, so five endpoints would mean five full scans of Games,
 * PlayerSeasons and PlayerGameStats to paint one page. This is one.
 *
 * `missingColumns` is here so the page can say "an administrator must run
 * ensureSchema()" rather than rendering a control whose save would be refused.
 */
function apiTeamAdmin_(teamId, seasonId) {
  const me = accountsWhoami_();
  teamId = s_(teamId) || s_(me.teamId);
  if (!teamId)
    throw new Error(me.role === 'ADMIN'
      ? 'Name a team. An administrator has no team of his own to fall back on.'
      : 'No team. An administrator has to attach your account to one before you ' +
        'can edit anything.');
  assertTeamAdmin_(teamId);
  seasonId = s_(seasonId) || CONFIG.CURRENT_SEASON;

  const teamRow = rowsOf_(CONFIG.TABS.TEAMS).filter(function (t) {
    return s_(t.TeamID) === teamId;
  })[0];
  if (!teamRow) throw new Error('Unknown team "' + teamId + '".');

  const teamNames = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return s_(t.TeamID); });
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });

  // How much of each game has actually been entered. A coach looking at this
  // page is deciding which week still needs work, and "12 rows filed" answers
  // that where a green tick would only claim it.
  const statHead = hasTab_(CONFIG.TABS.PLAYER_STATS)
    ? tabHeader_(CONFIG.TABS.PLAYER_STATS) : [];
  const cGrain = teamAdminCol_(statHead, ['grain', 'Grain']);
  const cCat = teamAdminCol_(statHead, ['category', 'Category']);
  const filed = {};
  if (statHead.length && cGrain) {
    rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
      if (s_(r.TeamID) !== teamId || s_(r[cGrain]) !== CONFIG.GRAIN.GAME) return;
      const gid = s_(r.GameID);
      if (gid) filed[gid] = (filed[gid] || 0) + 1;
    });
  }

  const teamRows = rowsOf_(CONFIG.TABS.TEAMS);
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === seasonId &&
           (s_(g.HomeTeamID) === teamId || s_(g.AwayTeamID) === teamId);
  }).map(function (g) {
    const row = gameRow_(g);
    const home = row.home === teamId;
    const oppId = home ? row.away : row.home;
    row.isHome = home;
    row.opponentId = oppId;
    row.opponentName = (teamNames[oppId] && s_(teamNames[oppId].DisplayName)) ||
                       (home ? row.awayName : row.homeName) || oppId;
    row.teamScore = home ? row.hs : row.as;
    row.opponentScore = home ? row.as : row.hs;
    row.statRows = filed[row.id] || 0;
    // which side forfeited, as the standings read it - HOME, AWAY or nothing
    // yet - so the page can show the choice already made
    row.forfeitBy = (typeof forfeitSide_ === 'function') ? forfeitSide_(g, teamRows) : '';
    return row;
  }).sort(function (a, b) {
    return (a.week === null ? 99 : a.week) - (b.week === null ? 99 : b.week);
  });

  const seasonHead = tabHeader_(CONFIG.TABS.PLAYER_SEASONS);
  const captains = [];
  const roster = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId;
  }).map(function (r) {
    const p = players[s_(r.PlayerID)] || {};
    const isCaptain = s_(r.IsCaptain).toUpperCase() === 'TRUE';
    if (isCaptain) captains.push(s_(r.PlayerID));
    return {
      playerSeasonId: s_(r.PlayerSeasonID),
      playerId: s_(r.PlayerID),
      name: s_(p.DisplayName) || s_(r.DisplayName) || s_(r.PlayerID),
      jersey: s_(r.Jersey),
      grad: s_(p.GradYear) || s_(r.GradYear),
      positions: parsePositions_(r.Positions),
      heightInches: num_(r.HeightInches),
      weightLbs: num_(r.WeightLbs),
      isCaptain: isCaptain
    };
  }).sort(function (a, b) {
    return (Number(a.jersey) || 999) - (Number(b.jersey) || 999) ||
           a.name.localeCompare(b.name);
  });

  const teamHead = tabHeader_(CONFIG.TABS.TEAMS);
  const missing = [];
  const links = {};
  TEAMADMIN.LINK_FIELDS.forEach(function (f) {
    if (teamHead.indexOf(f.col) < 0) { missing.push(CONFIG.TABS.TEAMS + '.' + f.col); return; }
    links[f.key] = s_(teamRow[f.col]);
  });
  if (seasonHead.indexOf('IsCaptain') < 0)
    missing.push(CONFIG.TABS.PLAYER_SEASONS + '.IsCaptain');

  return {
    teamId: teamId,
    seasonId: seasonId,
    me: { email: me.email, role: me.role, teamId: me.teamId, name: me.name },
    team: {
      teamId: teamId,
      name: s_(teamRow.DisplayName) || teamId,
      school: s_(teamRow.SchoolName),
      mascot: s_(teamRow.Mascot),
      county: s_(teamRow.County),
      city: s_(teamRow.City),
      cls: s_(teamRow.Class2025),
      color: s_(teamRow.PrimaryColor) || '#1F3B54',
      color2: s_(teamRow.SecondaryColor) || '#C9A227'
    },
    games: games,
    roster: roster,
    links: links,
    captains: captains,
    corrections: teamAdminPendingCorrections_(teamId),
    editable: {
      statuses: TEAMADMIN.GAME_STATUSES.slice(),
      categories: TEAMADMIN.CATEGORY_ORDER.map(function (c) {
        return { category: c, fields: teamAdminStatFields_(c) };
      }),
      halfFields: TEAMADMIN.HALF_FIELDS.slice(),
      linkFields: TEAMADMIN.LINK_FIELDS.map(function (f) { return f.key; }),
      maxCaptains: TEAMADMIN.MAX_CAPTAINS,
      maxStatRows: TEAMADMIN.MAX_STAT_ROWS,
      // a coach cannot record a game out of FORFEIT; the page should say so
      // rather than offer a control that will be refused
      forfeitIsAdminOnly: me.role !== 'ADMIN',
      // false means PlayerGameStats has no grain or no category column, so stat
      // entry cannot be keyed at all and the page should not offer it
      statsEntryReady: !!(cGrain && cCat),
      missingColumns: missing
    }
  };
}

/**
 * Corrections still waiting on a decision, oldest first.
 *
 * A blank `teamId` means every team — which is what an administrator's queue
 * is. Each row names its school, because a conference-wide list that did not
 * would ask the reader to guess whose player this is.
 */
/**
 * Whether "Approve and add the line" would actually work for this correction.
 *
 * Asked the same way the approval asks, so the button appears only where it can
 * finish. A button that is offered and then refuses is the fault this whole
 * queue was fixed for.
 */
function teamAdminCorrectionAddable_(playerId, seasonId, gameId, field) {
  try {
    if (!gameId || SUM_FIELDS.indexOf(field) < 0) return false;
    if (!teamAdminCategoryOf_(field)) return false;
    if (teamAdminHasStatLine_(playerId, gameId, field)) return false;
    if (tabHeader_(CONFIG.TABS.PLAYER_STATS).indexOf(field) < 0) return false;
    const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) {
      return s_(x.GameID) === gameId;
    })[0];
    if (!g) return false;
    const ps = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
      return s_(r.PlayerID) === playerId && s_(r.SeasonID) === seasonId;
    })[0];
    if (!ps) return false;
    const onTeam = s_(ps.TeamID);
    return s_(g.HomeTeamID) === onTeam || s_(g.AwayTeamID) === onTeam;
  } catch (e) {
    return false;
  }
}

/** True if the player already has a line in this game for the field's category. */
function teamAdminHasStatLine_(playerId, gameId, field) {
  const head = tabHeader_(CONFIG.TABS.PLAYER_STATS);
  const cGrain = teamAdminCol_(head, ['grain', 'Grain']);
  const cCat = teamAdminCol_(head, ['category', 'Category']);
  if (!cGrain || !cCat) return false;
  const category = teamAdminCategoryOf_(field);
  return rowsOf_(CONFIG.TABS.PLAYER_STATS).some(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.GameID) === gameId &&
           s_(r[cGrain]) === CONFIG.GRAIN.GAME &&
           normName_(s_(r[cCat])) === normName_(category);
  });
}

/**
 * Write the stat line a correction is asking for, holding that one number.
 *
 * Built the same way Stat entry builds a new row — same grain, category, week,
 * raw name and opponent — so nothing downstream can tell the difference. What
 * it does NOT do is fill the rest of the category with zeros: a blank cell here
 * means "not reported", and that distinction is the whole reason creating a row
 * from one number is safe to offer at all.
 */
function teamAdminAddStatLine_(me, playerId, teamId, seasonId, gameId, field, value,
                               correctionId, reason) {
  const head = tabHeader_(CONFIG.TABS.PLAYER_STATS);
  if (head.indexOf(field) < 0)
    throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' + field + ' column.');
  const cGrain = teamAdminCol_(head, ['grain', 'Grain']);
  const cCat = teamAdminCol_(head, ['category', 'Category']);
  const cWeek = teamAdminCol_(head, ['week', 'Week']);
  if (!cGrain || !cCat)
    throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' +
                    (cGrain ? 'category' : 'grain') + ' column.');

  const category = teamAdminCategoryOf_(field);
  if (!category)
    throw new Error('"' + field + '" belongs to no stat category, so there is no ' +
                    'line to build from it.');

  const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) {
    return s_(x.GameID) === gameId;
  })[0];
  if (!g) throw new Error('No game ' + gameId + '.');
  // The roster is the check that this is his team's game and his season
  const ps = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.SeasonID) === seasonId;
  })[0];
  if (!ps)
    throw new Error('That player is not on a ' + seasonId + ' roster, so a line ' +
                    'cannot be opened for him. Add him to the roster first.');
  const onTeam = s_(ps.TeamID) || teamId;
  if (s_(g.HomeTeamID) !== onTeam && s_(g.AwayTeamID) !== onTeam)
    throw new Error('His team did not play in ' + gameId + '.');

  const obj = {};
  obj.GameID = gameId;
  obj.PlayerID = playerId;
  obj.TeamID = onTeam;
  obj.SeasonID = seasonId;
  obj[cGrain] = CONFIG.GRAIN.GAME;
  obj[cCat] = category;
  if (cWeek) obj[cWeek] = (g.Week === null || g.Week === undefined) ? '' : g.Week;
  if (head.indexOf('player_raw') >= 0) obj.player_raw = s_(ps.DisplayName) || playerId;
  if (head.indexOf('opponent_raw') >= 0)
    obj.opponent_raw = s_(g.HomeTeamID) === onTeam
      ? (s_(g.AwayTeamName) || s_(g.AwayTeamID))
      : (s_(g.HomeTeamName) || s_(g.HomeTeamID));
  if (head.indexOf('SourceType') >= 0) obj.SourceType = 'COACH_ENTRY';
  if (head.indexOf('EnteredBy') >= 0) obj.EnteredBy = me.email;
  if (head.indexOf('EnteredAt') >= 0) obj.EnteredAt = new Date();
  obj[field] = value;

  appendRows_(CONFIG.TABS.PLAYER_STATS, [obj]);
  ensureOpsTabs_();
  appendRows_(CONFIG.TABS.AUDIT, [
    auditRow_(me, 'STATS_ENTER', 'PlayerGameStat', gameId + ':' + playerId,
             category, '', field + '=' + (value === '' ? '—' : value),
             onTeam + ' ' + seasonId + ' — line opened by correction ' + correctionId +
             (reason ? ' — ' + reason : '')),
    auditRow_(me, 'CORRECTION_APPROVE', 'StatCorrection', correctionId, field,
             '', value, onTeam + ' ' + gameId + ' — line created')
  ]);
  return { category: category };
}

/**
 * Why APPROVE would refuse this correction, or '' if it would not.
 *
 * The same checks the approval runs, in the same order, asked ahead of time so
 * the queue can print the answer instead of selling a click for an error. Keep
 * it in step with teamAdminDecideCorrection_: a queue that promises one
 * sentence and delivers another is worse than one that promises nothing.
 * Anything unexpected is swallowed — a listing that will not draw is worse than
 * a button that turns out not to work.
 */
function teamAdminCorrectionBlocked_(correctionId, playerId, seasonId, gameId, field, proposed) {
  try {
    if (SUM_FIELDS.indexOf(field) < 0)
      return 'Correction ' + correctionId + ' names "' + field + '", which is ' +
             'not a stat this database keeps. Reject it.';
    const target = teamAdminCorrectionTarget_(playerId, seasonId, gameId, field);
    if (teamAdminSame_(target.current, proposed === null ? '' : proposed))
      return 'The database already holds ' +
             (target.current === '' ? 'no value' : target.current) +
             ' for that. Reject the correction instead — approving it would ' +
             'record a change that did not happen.';
    return '';
  } catch (e) {
    return s_(e && e.message) || 'This one cannot be applied as it stands.';
  }
}

function teamAdminPendingCorrections_(teamId) {
  if (!hasTab_(CONFIG.TABS.CORRECTIONS)) return [];
  teamId = s_(teamId);

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  const games = indexBy_(rowsOf_(CONFIG.TABS.GAMES), function (g) { return s_(g.GameID); });
  const teams = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return s_(t.TeamID); });

  return rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
    if (profileCorrectionStatus_(r) !== 'PENDING') return false;
    return !teamId || s_(r.TeamID) === teamId;
  }).map(function (r) {
    const g = games[s_(r.GameID)] || {};
    const p = players[s_(r.PlayerID)] || {};
    const t = teams[s_(r.TeamID)] || {};
    return {
      correctionId: s_(r.CorrectionID),
      playerId: s_(r.PlayerID),
      player: s_(p.DisplayName) || s_(r.PlayerID),
      teamId: s_(r.TeamID),
      teamName: s_(t.DisplayName) || s_(r.TeamID),
      seasonId: s_(r.SeasonID),
      gameId: s_(r.GameID),
      week: num_(g.Week),
      field: s_(r.Field),
      // blank travels as null, never as 0 — the page has to be able to print
      // "not reported" rather than a number nobody recorded
      oldValue: num_(r.OldValue),
      newValue: num_(r.NewValue),
      reason: s_(r.Reason),
      requestedBy: s_(r.CorrectedBy),
      requestedAt: (r.CorrectedAt instanceof Date)
        ? r.CorrectedAt.toISOString() : s_(r.CorrectedAt),
      status: profileCorrectionStatus_(r),
      /* Why Approve cannot work yet, if it cannot: no box score for the game,
         a season total that is assembled rather than stored, a duplicate row.
         Asked here so the queue can say it on the card instead of offering a
         button that spends a click to produce an error. Rejecting is always
         available — a request can be turned down whatever the sheet holds. */
      blocked: teamAdminCorrectionBlocked_(s_(r.CorrectionID), s_(r.PlayerID), s_(r.SeasonID),
                                           s_(r.GameID), s_(r.Field), numOrNull_(r.NewValue)),
      /* True when the only thing stopping this is that the player has no line
         in that game, and one can be opened for him. The queue offers "Approve
         and add the line" instead of a dead button. */
      addable: teamAdminCorrectionAddable_(s_(r.PlayerID), s_(r.SeasonID),
                                           s_(r.GameID), s_(r.Field)),
      // which line the field belongs to, so the page can name it without guessing
      category: teamAdminCategoryOf_(s_(r.Field))
    };
  }).sort(function (a, b) {
    return a.requestedAt < b.requestedAt ? -1 : (a.requestedAt > b.requestedAt ? 1 : 0);
  });
}

/**
 * The caller's own correction queue, scoped exactly the way the badge is.
 *
 * An administrator's badge counts every pending correction in the conference
 * (acctPendingCorrections), so his LIST has to be that same list. It was not:
 * the page showed only the school in the team picker, so a correction filed at
 * Perryville was counted while an administrator looking at Aberdeen was told
 * nothing was waiting — a badge pointing at an empty page. A coach still sees
 * his own school, which is the whole of his badge too.
 */
function apiPendingCorrections_() {
  const me = accountsWhoami_();
  if (me.role !== 'ADMIN' && !(me.role === 'COACH' && me.teamId))
    throw new Error('Administrators and team coaches only.');
  return teamAdminPendingCorrections_(me.role === 'ADMIN' ? '' : me.teamId);
}

// ── the score ──────────────────────────────────────────────────────────────

/**
 * Set the score and status of a game the caller's team played.
 *
 *   apiSaveGameScore(gameId, homeScore, awayScore, status, forfeitBy)
 *
 * Scores are whole numbers of points or blank. Blank means the game has not been
 * played — it is NOT 0-0, and a 0-0 written where a blank belonged is a shutout
 * this database would then publish, count in the standings and average into a
 * points-per-game figure.
 *
 * A forfeit is decided by who forfeited, not by a score, and the standings
 * award the win from that alone. So a FORFEIT must name a side — HOME or AWAY,
 * from the page's own choice or from what the row already says in ForfeitBy or
 * Notes — and it is stored in ForfeitBy as the forfeiting team's id, or its
 * name when it has none: Benjamin Franklin forfeiting to Joppatowne has no id
 * to be stored under. The page used to accept FORFEIT with nobody named, and
 * the standings then skipped the game rather than guess: the win never
 * arrived, and the screen had asked for a score it did not need.
 *
 * A stored FORFEIT is never recorded away by a coach. The 2023 import lost one
 * by assuming the opponent's win, and the difference between "they did not play"
 * and "they lost" is a conference ruling that a scorekeeping screen has no
 * business overturning. An administrator can change it, and the change is
 * audited under his name.
 *
 * Nothing is recomputed here. markDirty('scores') hands that to the sweep.
 */
function apiSaveGameScore_(gameId, homeScore, awayScore, status, forfeitBy) {
  const me = teamAdminSelf_();
  gameId = s_(gameId);
  if (!gameId) throw new Error('Which game?');

  const want = teamAdminStatus_(status);
  const hs = teamAdminScore_(homeScore, 'Home score');
  const as = teamAdminScore_(awayScore, 'Away score');
  const side = teamAdminForfeitSide_(forfeitBy);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    // another execution may have written to Games since this one read it
    delete __tableCache[CONFIG.TABS.GAMES];

    const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) {
      return s_(x.GameID) === gameId;
    })[0];
    if (!g) throw new Error('Unknown game "' + gameId + '".');

    /* Only ONE side has to be a UCBAC team.
       Half the non-conference schedule is against schools outside the
       conference — Kent County, Overlea, The Seed School — and those have no
       TeamID because they have no page here, only a name. Demanding both
       made every one of those games unscorable, which is how Bohemia Manor's
       week 1 could not be entered at all. */
    const home = s_(g.HomeTeamID), away = s_(g.AwayTeamID);
    const homeName = s_(g.HomeTeamName) || teamNameOf_(home) || home;
    const awayName = s_(g.AwayTeamName) || teamNameOf_(away) || away;
    if (!home && !away)
      throw new Error('Game ' + gameId + ' names no UCBAC team. An administrator has to ' +
                      'fix the schedule row before a score can be entered.');

    // A coach may score a game his team played, and only that game. An
    // administrator may score any of them.
    var teamId = '';
    if (me.role === 'ADMIN') {
      teamId = me.teamId && (me.teamId === home || me.teamId === away) ? me.teamId : (home || away);
    } else if (me.teamId && (me.teamId === home || me.teamId === away)) {
      teamId = me.teamId;
    } else {
      throw new Error('Game ' + gameId + ' is ' + awayName + ' at ' + homeName +
                      '. Your team did not play in it.');
    }
    /* Unconditionally. This read a bare `self`, which is a parameter of
       apiSavePlayerStats and not a variable here or a global in Apps Script,
       so the line would have thrown ReferenceError the moment anything
       reached it — and nothing had, because the both-teams check above
       rejected these games first. There is no self-service path for a game
       score; that is apiSavePlayerStats. */
    assertTeamScope_(me, teamId, 'Game ' + gameId);

    const seasonId = s_(g.SeasonID) || CONFIG.CURRENT_SEASON;
    const wasStatus = s_(g.Status).toUpperCase();
    const wasHs = num_(g.HomeScore), wasAs = num_(g.AwayScore);

    // The one inference this function makes, and it can never produce a FORFEIT:
    // a scheduled game that now has both scores is final. Anything else keeps
    // whatever status is already on the row, so a blank argument is "leave it".
    var next = want;
    if (!next) {
      next = (wasStatus === 'SCHEDULED' || !wasStatus) && hs !== '' && as !== ''
        ? 'FINAL' : (wasStatus || 'SCHEDULED');
    }

    if (wasStatus === 'FORFEIT' && next !== 'FORFEIT' && me.role !== 'ADMIN')
      throw new Error('Game ' + gameId + ' is recorded as a forfeit. A forfeit is a ' +
                      'conference ruling, so only an administrator can record it as ' +
                      'anything else. Ask one, and say why.');

    if (next === 'FINAL' && (hs === '' || as === ''))
      throw new Error('A final score needs both teams\' points. Leave the status as ' +
                      'SCHEDULED until you have them — a blank is "not played yet", ' +
                      'not nil.');
    if ((next === 'CANCELLED' || next === 'POSTPONED') && (hs !== '' || as !== ''))
      throw new Error('A ' + next.toLowerCase() + ' game has no score. Clear both ' +
                      'boxes, or set the status to FINAL.');
    if (next === 'SCHEDULED' && (hs !== '' || as !== ''))
      throw new Error('A scheduled game has no score yet. Set the status to FINAL, ' +
                      'or FORFEIT if that is what happened.');
    if (next === 'FORFEIT' && ((hs === '') !== (as === '')))
      throw new Error('A forfeit is recorded with both scores or with neither. ' +
                      'One of the two is half a result.');

    /* Who forfeited. The page's choice first; failing that, whatever the row
       already says (a ForfeitBy written earlier, or a name in Notes); failing
       that, refused — a forfeit naming nobody is the one the standings skip. */
    const wasForfeitBy = s_(g.ForfeitBy);
    var who = '', forfeitValue = wasForfeitBy;
    if (next === 'FORFEIT') {
      // forfeitSide_ answers only for a row that IS a forfeit; this one is
      // about to be, so it is asked about the row as it will stand
      const asForfeit = {};
      Object.keys(g).forEach(function (k) { asForfeit[k] = g[k]; });
      asForfeit.Status = 'FORFEIT';
      who = side || ((typeof forfeitSide_ === 'function') ? forfeitSide_(asForfeit, rowsOf_(CONFIG.TABS.TEAMS)) : '');
      if (!who)
        throw new Error('Who forfeited? Pick the team that did not play — the win is ' +
                        'recorded from that, not from a score.');
      // the forfeiting side, stored as its id, or its name when it has none
      forfeitValue = (who === 'HOME') ? (home || homeName) : (away || awayName);
    } else {
      forfeitValue = '';
    }

    const updates = [], audit = [];
    function stage(field, before, value, label) {
      if (teamAdminSame_(before, value)) return;
      updates.push({ row: g.__row, field: field, value: value });
      audit.push(auditRow_(me, 'GAME_SCORE', 'Game', gameId, field, before, value,
                          seasonId + ' ' + awayName + ' at ' + homeName + label));
    }

    var head = tabHeader_(CONFIG.TABS.GAMES);
    ['HomeScore', 'AwayScore', 'Status'].forEach(function (c) {
      if (head.indexOf(c) < 0)
        throw new Error(CONFIG.TABS.GAMES + ' has no ' + c + ' column. Run ensureSchema_().');
    });
    // the column is made the first time a forfeit needs it, rather than
    // refusing the one save that could not wait for a schema run
    if (forfeitValue !== wasForfeitBy && head.indexOf('ForfeitBy') < 0 &&
        typeof addColumns_ === 'function') {
      addColumns_(CONFIG.TABS.GAMES, ['ForfeitBy']);
      head = tabHeader_(CONFIG.TABS.GAMES);
    }

    stage('HomeScore', wasHs, hs, '');
    stage('AwayScore', wasAs, as, '');
    stage('Status', wasStatus, next,
          wasStatus === 'FORFEIT' && next !== 'FORFEIT'
            ? ' — FORFEIT RECORDED AWAY BY AN ADMINISTRATOR' : '');
    if (head.indexOf('ForfeitBy') >= 0)
      stage('ForfeitBy', wasForfeitBy, forfeitValue,
            who ? ' — forfeited by ' + (who === 'HOME' ? homeName : awayName) : '');

    // The unchanged case returns the same shape as the changed one. A client
    // that only reads `status` on success must not see it go undefined because
    // the coach saved the same score twice.
    if (!updates.length)
      return { ok: true, gameId: gameId, status: next, forfeitBy: who,
               homeScore: hs === '' ? null : hs, awayScore: as === '' ? null : as,
               changed: [], message: 'Nothing changed.' };

    updateCells_(CONFIG.TABS.GAMES, updates);
    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, audit);

    teamAdminBustCache_(seasonId);
    // a rebuild is not run inline — a Friday night arrives as fifteen scores in
    // twenty minutes, and the sweep trigger collapses that into one recompute
    markDirty_('scores');

    return {
      ok: true, gameId: gameId, status: next, forfeitBy: who,
      homeScore: hs === '' ? null : hs, awayScore: as === '' ? null : as,
      changed: updates.map(function (u) { return u.field; })
    };
  } finally {
    lock.releaseLock();
  }
}

// ── the box score ──────────────────────────────────────────────────────────

/**
 * The weekly stat entry path — one team's box score for one game.
 *
 *   rows: [{ playerId, category, PassYds: 210, PassTD: 3, ... }]
 *
 * Every row is written at GAME grain, keyed on (GameID, PlayerID, category), and
 * an existing row for that key is UPDATED rather than appended to. Re-submitting
 * a week therefore corrects it; the alternative is a second set of rows that the
 * grain resolver dutifully sums into a player who threw for four hundred yards
 * twice in the same game.
 *
 * A blank field is written blank. Not 0, not skipped-so-the-old-value-survives —
 * blank, because clearing a number a coach entered by mistake has to be possible
 * and "we did not record this" has to remain sayable. teamAdminStat() is the
 * only thing that decides what a value becomes.
 *
 * A bad row lands in refused[] with its reason and the rest of the batch is
 * written. Thirty-eight good rows must not be thrown away by one mistyped
 * jersey; a coach entering a box score on a Saturday morning gets one chance at
 * patience.
 */
/*
 * `self` is set only by apiSubmitMyStats on the server — the svc wrapper
 * passes three arguments, so a client can never reach it. With it set, the
 * caller is a player entering his OWN line: every row is forced to his
 * playerId, the rows land marked PLAYER_ENTRY (published grey until someone
 * official approves them), and an official row is never overwritten — a
 * player disputing an official number files a correction, he does not type
 * over it.
 */
function apiSavePlayerStats_(gameId, teamId, rows, self) {
  const me = self ? { email: s_(self.email), role: 'PLAYER', teamId: s_(teamId) }
                  : assertTeamAdmin_(teamId);
  return teamAdminWriteStats_(me, gameId, teamId, rows,
    { self: self || null, sourceType: self ? 'PLAYER_ENTRY' : 'COACH_ENTRY' });
}

/**
 * The writer under apiSavePlayerStats, callable by anything that has already
 * settled who is writing: the portal (a coach or a player), the StatsImport
 * menu (an administrator at the sheet) and the file extractor (a coach's
 * upload, read by the model).
 *
 *   opts.sourceType  COACH_ENTRY  official - typed by a coach, overwrites anything
 *                    FILE_IMPORT  official - read out of a coach's upload; a later
 *                                 upload overwrites it, and so does the coach
 *                    PLAYER_ENTRY player-reported - immediately visible grey;
 *                                 verified imports replace covered fields
 *   opts.self        the player entering his own line: every row is his
 *
 * A provisional line never overwrites an official one; an official line
 * writing over a provisional one IS the review, and the row turns official.
 * Coaches are not asked to approve their own uploads.
 */
function teamAdminWriteStats_(me, gameId, teamId, rows, opts) {
  opts = opts || {};
  const self = opts.self || null;
  const sourceType = s_(opts.sourceType) || 'COACH_ENTRY';
  const official = !provisionalSource_(sourceType);
  teamId = s_(teamId);
  gameId = s_(gameId);
  if (!gameId) throw new Error('Which game?');
  rows = rows || [];
  if (!rows.length) return { ok: true, saved: 0, refused: [] };
  if (rows.length > TEAMADMIN.MAX_STAT_ROWS)
    throw new Error('That is ' + rows.length + ' stat lines in one save; the limit is ' +
                    TEAMADMIN.MAX_STAT_ROWS + '. Send them in two batches.');

  const lock = LockService.getScriptLock();
  const queued = !!(opts.queueContext && typeof __statQueueContext !== 'undefined' &&
    opts.queueContext === __statQueueContext && lock.hasLock());
  if (opts.queueContext && !queued) throw new Error('Invalid queue execution context.');
  if (!queued && !lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    // another execution may have written to either tab since this one read it
    delete __tableCache[CONFIG.TABS.PLAYER_STATS];
    delete __tableCache[CONFIG.TABS.GAMES];

    const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) {
      return s_(x.GameID) === gameId;
    })[0];
    if (!g) throw new Error('Unknown game "' + gameId + '".');
    if (s_(g.HomeTeamID) !== teamId && s_(g.AwayTeamID) !== teamId)
      throw new Error('That game is ' + (teamNameOf_(s_(g.HomeTeamID)) || s_(g.HomeTeamID)) +
                      ' against ' + (teamNameOf_(s_(g.AwayTeamID)) || s_(g.AwayTeamID)) + '. ' +
                      (teamNameOf_(teamId) || 'Your team') + ' did not play in it.');
    if (!self) assertTeamScope_(me, teamId, 'Game ' + gameId);

    const seasonId = s_(g.SeasonID) || CONFIG.CURRENT_SEASON;
    const week = num_(g.Week);
    if (self) profileAssertSelfStats_(self, g, teamId);

    // Read the sheet directly rather than through readTable(): readTable drops
    // any column whose header cell is blank, and this function rewrites whole
    // rows. A rebuilt row that had lost those columns would blank them.
    const sh = getTab_(CONFIG.TABS.PLAYER_STATS);
    const values = sh.getDataRange().getValues();
    const head = values[0].map(function (h) { return String(h).trim(); });

    const cGrain = teamAdminCol_(head, ['grain', 'Grain']);
    const cCat = teamAdminCol_(head, ['category', 'Category']);
    const cWeek = teamAdminCol_(head, ['week', 'Week']);
    if (!cGrain || !cCat)
      throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' +
                      (cGrain ? 'category' : 'grain') + ' column. Run listTabs_() and ' +
                      'check the import — nothing can be keyed without it.');
    TEAMADMIN.STAT_KEY_COLS.forEach(function (c) {
      if (head.indexOf(c) < 0)
        throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' + c + ' column.');
    });

    const col = {};
    head.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });

    // Who is allowed to appear in this box score at all.
    const roster = {};
    rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
      if (s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId)
        roster[s_(r.PlayerID)] = s_(r.DisplayName) || s_(r.PlayerID);
    });
    const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });

    // Existing GAME-grain lines for this game, keyed the way the upsert is.
    const existing = {}, officialKeys = {}, duplicateKeys = {};
    const reviewLedger = taReviewLedger_(), accepted = {};
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][col.GameID] || '').trim() !== gameId) continue;
      if (s_(values[r][col.TeamID]) !== teamId || s_(values[r][col.SeasonID]) !== seasonId) continue;
      if (String(values[r][col[cGrain]] || '').trim() !== CONFIG.GRAIN.GAME) continue;
      const pid = taReviewCanonical_(values[r][col.PlayerID]);
      if (!pid) continue;
      const key = pid + '|' + String(values[r][col[cCat]] || '').trim();
      if (existing[key] === undefined) existing[key] = r;
      else duplicateKeys[key] = true;
      // Protect every official line, including one after an older duplicate.
      if (!provisionalSource_(col.SourceType === undefined ? '' : values[r][col.SourceType]))
        officialKeys[key] = true;
    }

    // Fail the whole save before any write if a target has duplicate canonical
    // keys. Choosing a duplicate silently would make totals unpredictable.
    rows.forEach(function (row) {
      const key = taReviewCanonical_(self ? self.playerId : row.playerId) + '|' + s_(row.category);
      if (duplicateKeys[key]) throw new Error('Duplicate canonical stat lines for ' + key + ' in this exact game/team/season; review before saving.');
    });
    const refused = [], audit = [], appends = [];
    const touched = {}, seen = {};
    // what was saved, in words, for the note to the owner when it needs approving
    const noted = [];
    const nameOf = function (pid) { return (players[pid] && s_(players[pid].DisplayName)) || roster[pid] || pid; };
    var saved = 0;

    rows.forEach(function (row, i) {
      const label = 'row ' + (i + 1);
      const pid = taReviewCanonical_(self ? self.playerId : row.playerId);
      const category = s_(row.category);

      if (!pid) { refused.push(label + ': no playerId.'); return; }
      if (!roster[pid]) {
        refused.push(label + ': not on ' + (teamNameOf_(teamId) || 'this team') + '\'s ' +
                     seasonId.replace('SEA-', '') + ' roster. Add him in the roster editor first.');
        return;
      }

      var fields;
      try { fields = teamAdminStatFields_(category); }
      catch (err) { refused.push(label + ': ' + err.message); return; }

      const key = pid + '|' + category;
      if (self && officialKeys[key]) {
        refused.push(label + ' (' + roster[pid] + ', ' + category + '): this line is ' +
                     'already officially recorded. If a number is wrong, request a correction instead.');
        return;
      }
      if (seen[key]) {
        refused.push(label + ' (' + roster[pid] + ', ' + category + '): the same player ' +
                     'and category appears twice in this batch. Combine them.');
        return;
      }

      // A field from another category would be summed twice by the grain
      // resolver — once as this category, once as its own.
      const stray = Object.keys(row).filter(function (k) {
        if (k === 'playerId' || k === 'category') return false;
        if (fields.indexOf(k) >= 0) return false;
        return SUM_FIELDS.indexOf(k) >= 0 || CONFIG.DERIVED_FIELDS.indexOf(k) >= 0 ||
               teamAdminCategoryOf_(k) !== '';
      });
      if (stray.length) {
        refused.push(label + ' (' + roster[pid] + '): ' + stray.join(', ') +
                     ' ' + (stray.length === 1 ? 'is not a ' : 'are not ') + category +
                     ' measure' + (stray.length === 1 ? '' : 's') + '. Send it as its own row.');
        return;
      }

      const cells = {};
      var bad = '';
      fields.forEach(function (f) {
        if (bad) return;
        if (row[f] === undefined) return;                  // absent means leave alone
        if (col[f] === undefined) {
          bad = f + ': ' + CONFIG.TABS.PLAYER_STATS + ' has no ' + f + ' column.';
          return;
        }
        try { cells[f] = teamAdminStat_(f, row[f]); }
        catch (err) { bad = err.message; }
      });
      if (bad) { refused.push(label + ' (' + roster[pid] + '): ' + bad); return; }
      if (!Object.keys(cells).length) {
        refused.push(label + ' (' + roster[pid] + ', ' + category + '): no ' + category +
                     ' measures were sent, so there is nothing to record.');
        return;
      }

      seen[key] = true;
      const at = existing[key];

      if (at !== undefined) {
        const original = {};
        head.forEach(function (h,j) { if (h) original[h] = values[at][j]; });
        const scope = {seasonId:seasonId,teamId:teamId,gameId:gameId,playerId:pid,category:category};
        const priorCovered = reviewLedger[taReviewKey_(scope)] || {};
        if (self && Object.keys(cells).some(function (f) {
          return Object.prototype.hasOwnProperty.call(priorCovered,f);
        })) {
          refused.push(label + ': an official has already verified one of these fields; request a correction.');
          return;
        }
        const was = col.SourceType !== undefined ? String(values[at][col.SourceType] || '').trim() : '';
        const wasProvisional = provisionalSource_(was);
        if (!official && !wasProvisional) {
          refused.push(label + ' (' + roster[pid] + ', ' + category + '): this line is ' +
                       'already officially recorded. ' +
                       (self ? 'If a number is wrong, request a correction instead.'
                             : 'Edit the box score to change it.'));
          return;
        }
        // an official write over a provisional line IS the review - the line
        // leaves the approval queue; over another official source, the line
        // says which one wrote it last (the coach's hand, or his newest file)
        var review = null;
        if (official) {
          const updated = Object.assign({},original,cells,{PlayerID:pid});
          review = taReviewPlan_(me,original,updated,cells,reviewLedger,
            queued && opts.queueContext.env.payload.SourceKind === 'MAXPREPS' ? 'MAXPREPS' : 'COACH_ENTRY');
          if (review.audit) audit.push(review.audit);
        }
        const desiredSource = review && Object.keys(review.remaining).length ? 'PLAYER_ENTRY' : sourceType;
        var reviewed = !!(review && review.audit);
        if (official && col.SourceType !== undefined && was !== desiredSource) {
          values[at][col.SourceType] = desiredSource;
          if (col.EnteredBy !== undefined) values[at][col.EnteredBy] = me.email;
          touched[at] = true;
          reviewed = true;
        } else if (!official && col.SourceType !== undefined && was !== sourceType) {
          // one provisional source replacing another: say which it is now
          values[at][col.SourceType] = sourceType;
          touched[at] = true;
        }
        const before = [], after = [];
        Object.keys(cells).forEach(function (f) {
          const was = values[at][col[f]];
          if (teamAdminSame_(was, cells[f])) return;
          before.push(f + '=' + (was === '' || was === null ? '—' : was));
          after.push(f + '=' + (cells[f] === '' ? '—' : cells[f]));
          values[at][col[f]] = cells[f];
          touched[at] = true;
        });
        if (official) accepted[key] = cells;
        if (!before.length) {
          if (reviewed) saved++;
          return;                        // identical resubmission is still a review
        }
        // One audit row per stat line rather than one per cell: a full week is
        // forty lines, and forty audit rows are readable where four hundred are
        // a wall. The before/after strings carry every field that moved.
        audit.push(auditRow_(me, 'STATS_UPDATE', 'PlayerGameStat', gameId + ':' + pid,
                            category, before.join(' '), after.join(' '),
                            teamId + ' ' + seasonId +
                            (week === null ? '' : ' week ' + week)));
        noted.push(nameOf(pid) + ' - ' + category + ': ' + after.join(' '));
        saved++;
        return;
      }

      const obj = {};
      obj.GameID = gameId;
      obj.PlayerID = pid;
      obj.TeamID = teamId;
      obj.SeasonID = seasonId;
      obj[cGrain] = CONFIG.GRAIN.GAME;
      obj[cCat] = category;
      if (cWeek) obj[cWeek] = week === null ? '' : week;
      // The import kept the source's spelling of a name beside the resolved id,
      // and thirty percent of the historical rows never resolved. A row entered
      // here resolved by construction, so the raw name is the roster's.
      if (col.player_raw !== undefined) obj.player_raw = players[pid]
        ? s_(players[pid].DisplayName) : roster[pid];
      if (col.opponent_raw !== undefined) {
        obj.opponent_raw = s_(g.HomeTeamID) === teamId
          ? (s_(g.AwayTeamName) || s_(g.AwayTeamID))
          : (s_(g.HomeTeamName) || s_(g.HomeTeamID));
      }
      if (col.EnteredBy !== undefined) obj.EnteredBy = me.email;
      if (col.EnteredAt !== undefined) obj.EnteredAt = new Date();
      if (col.SourceType !== undefined) obj.SourceType = sourceType;
      Object.keys(cells).forEach(function (f) { obj[f] = cells[f]; });

      if (official) {
        const review = taReviewPlan_(me,{},obj,cells,reviewLedger,
          queued && opts.queueContext.env.payload.SourceKind === 'MAXPREPS' ? 'MAXPREPS' : 'COACH_ENTRY');
        if (review.audit) audit.push(review.audit);
      }
      appends.push(obj);
      if (official) accepted[key] = cells;
      const said = Object.keys(cells).map(function (f) {
        return f + '=' + (cells[f] === '' ? '—' : cells[f]);
      }).join(' ');
      audit.push(auditRow_(me, 'STATS_ENTER', 'PlayerGameStat', gameId + ':' + pid,
                          category, '', said,
                          teamId + ' ' + seasonId + (week === null ? '' : ' week ' + week)));
      noted.push(nameOf(pid) + ' - ' + category + ': ' + said);
      saved++;
    });

    if (queued) return sqCommitWriter_(me,{values:values,head:head,col:col,touched:touched,
      appends:appends,audit:audit,accepted:accepted,refused:refused,saved:saved,
      seasonId:seasonId,teamId:teamId,gameId:gameId});
    // Preserve original claims before any stat mutation. Coverage is only
    // considered settled when its recorded value matches the live stat cell.
    if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }
    // One setValues per changed row rather than one setValue per changed cell.
    // A full week is forty rows against several hundred cells, and the script
    // lock is held for the whole batch.
    Object.keys(touched).forEach(function (at) {
      const idx = Number(at);
      sh.getRange(idx + 1, 1, 1, head.length).setValues([values[idx]]);
    });
    if (Object.keys(touched).length) delete __tableCache[CONFIG.TABS.PLAYER_STATS];

    if (appends.length) appendRows_(CONFIG.TABS.PLAYER_STATS, appends);
    const reconciled = official ? taReviewCorrections_(me,seasonId,teamId,gameId,accepted) : 0;

    if (saved || reconciled) {
      teamAdminBustCache_(seasonId);
      // a rebuild is not run inline — a box score arrives category by category
      // over several saves, and the sweep collapses them into one recompute
      markDirty_('stats');
    }

    /* A player's own line lands in Approvals, where the badge counts it. No
       note to the owner: one per save was the first thing he cut when the
       day's hundred messages ran out, and a coach's own upload is announced
       by the mail that carries the file itself. */

    return { ok: refused.length === 0, saved: saved, refused: refused, reconciledCorrections:reconciled };
  } finally {
    if (!queued) lock.releaseLock();
  }
}

// ── player-entered stats: the review queue ──────────────────────────────────
//
// A player's own line is published immediately, in grey, marked PLAYER_ENTRY.
// Three things can happen to it: a coach or administrator approves it (it
// turns black), rejects it (it is deleted and the player told), or enters the
// official line themselves — which approves by supersession inside
// apiSavePlayerStats and needs no queue at all.

/**
 * Everything waiting for review, grouped one card per game and player.
 * An administrator sees the whole conference; a coach sees his team.
 */
function apiPendingPlayerStats_() {
  const me = accountsWhoami_();
  if (me.role !== 'ADMIN' && !(me.role === 'COACH' && me.teamId))
    throw new Error('Administrators and team coaches only.');
  // Compatibility for older pages: initial entries never require approval.
  return [];
}

/** How many game+player groups are waiting, for the badge. Never throws. */
function taPendingStatCount_(me) { return 0; }

/**
 * Approve or reject one game+player group. Approving flips SourceType to
 * COACH_ENTRY — the numbers do not move, only their standing. Rejecting
 * deletes the rows: an unapproved claim leaves no residue in any total.
 * The player is told which, either way.
 */
function apiReviewPlayerStats_(gameId, playerId, decision) {
  throw new Error('Player-entered stats publish immediately and do not require approval. Use Stat Entry to record verified values; Stat Corrections remain subject to review.');
}

// ── captains ───────────────────────────────────────────────────────────────

/**
 * Name this season's captains.
 *
 * The whole roster is rewritten, not just the names sent, so dropping a captain
 * is possible — a list that only ever added would leave last month's captain
 * flagged forever.
 *
 * TRUE marks a captain and blank marks everyone else. There is no third state
 * worth storing: "considered and not named" and "not considered" are the same
 * fact about a public page.
 */
function apiSetCaptains_(teamId, seasonId, playerIds) {
  const me = assertTeamAdmin_(teamId);
  teamId = s_(teamId);
  seasonId = s_(seasonId) || CONFIG.CURRENT_SEASON;

  const wanted = {}, order = [];
  (playerIds || []).forEach(function (p) {
    const pid = s_(p);
    if (!pid || wanted[pid]) return;
    wanted[pid] = true;
    order.push(pid);
  });
  if (order.length > TEAMADMIN.MAX_CAPTAINS)
    throw new Error('That is ' + order.length + ' captains. The limit is ' +
                    TEAMADMIN.MAX_CAPTAINS + ' — past that the word stops meaning ' +
                    'anything.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    delete __tableCache[CONFIG.TABS.PLAYER_SEASONS];

    const head = tabHeader_(CONFIG.TABS.PLAYER_SEASONS);
    if (head.indexOf('IsCaptain') < 0)
      throw new Error(CONFIG.TABS.PLAYER_SEASONS + ' has no IsCaptain column. ' +
                      'An administrator must run ensureSchema_() first.');

    const roster = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
      return s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId;
    });
    if (!roster.length)
      throw new Error('No ' + seasonId + ' roster for ' + teamId + '. Add players ' +
                      'before naming captains.');

    const onRoster = {};
    roster.forEach(function (r) { onRoster[s_(r.PlayerID)] = r; });

    const refused = order.filter(function (pid) { return !onRoster[pid]; })
      .map(function (pid) {
        return pid + ': not on ' + teamId + '\'s ' + seasonId + ' roster.';
      });
    if (refused.length) throw new Error(refused.join(' '));

    const updates = [], audit = [], named = [];
    roster.forEach(function (r) {
      const pid = s_(r.PlayerID);
      const was = s_(r.IsCaptain).toUpperCase() === 'TRUE';
      const now = !!wanted[pid];
      if (now) named.push(pid);
      if (was === now) return;
      updates.push({ row: r.__row, field: 'IsCaptain', value: now ? 'TRUE' : '' });
      audit.push(auditRow_(me, 'CAPTAIN_SET', 'PlayerSeason', s_(r.PlayerSeasonID),
                          'IsCaptain', was ? 'TRUE' : '', now ? 'TRUE' : '',
                          teamId + ' ' + seasonId));
    });

    if (!updates.length)
      return { ok: true, captains: named, changed: 0, message: 'Nothing changed.' };

    updateCells_(CONFIG.TABS.PLAYER_SEASONS, updates);
    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, audit);

    CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
    // a rebuild is not run inline — the roster editor and this page are used in
    // the same sitting, and the sweep collapses both into one recompute
    markDirty_('roster');

    return { ok: true, captains: named, changed: updates.length };
  } finally {
    lock.releaseLock();
  }
}

// ── team links ─────────────────────────────────────────────────────────────

/**
 * The Teams row's link and venue columns.
 *
 * `links` is a flat object keyed by the `key` names apiTeamAdmin() hands out. A
 * key that is absent is left alone; a key whose value is blank clears the cell.
 * Each field is validated on its own and a bad one lands in refused[] with its
 * reason, so one mistyped URL does not throw away five good ones.
 *
 * Every link goes through allowedLinkUrl(), which is the SAME allowlist
 * Profile.gs applies to a player's links. SchoolURL is the one field with a
 * chicken and egg in it: profileAllowedHosts() learns school domains FROM that
 * column, so a school whose site is on neither county system's domain has to be
 * seeded once by an administrator in the sheet.
 */
function apiSaveTeamLinks_(teamId, links) {
  const me = assertTeamAdmin_(teamId);
  teamId = s_(teamId);
  links = links || {};

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    delete __tableCache[CONFIG.TABS.TEAMS];

    const row = rowsOf_(CONFIG.TABS.TEAMS).filter(function (t) {
      return s_(t.TeamID) === teamId;
    })[0];
    if (!row) throw new Error('Unknown team "' + teamId + '".');

    const head = tabHeader_(CONFIG.TABS.TEAMS);
    const saved = [], refused = [], updates = [], audit = [];

    // Anything named that is not a link field is refused by name. Silence would
    // read as success and the coach would keep typing into a field that goes
    // nowhere.
    const known = {};
    TEAMADMIN.LINK_FIELDS.forEach(function (f) {
      known[f.key.toLowerCase()] = true;
      known[f.col.toLowerCase()] = true;
    });
    Object.keys(links).forEach(function (k) {
      if (!known[String(k).toLowerCase()])
        refused.push(k + ': not a field you can edit here.');
    });

    TEAMADMIN.LINK_FIELDS.forEach(function (f) {
      const raw = (links[f.key] !== undefined) ? links[f.key] : links[f.col];
      if (raw === undefined) return;

      if (head.indexOf(f.col) < 0) {
        refused.push(f.key + ': ' + CONFIG.TABS.TEAMS + ' has no ' + f.col +
                     ' column. An administrator must run ensureSchema_().');
        return;
      }

      var value;
      try {
        value = f.kind === 'URL' ? allowedLinkUrl_(raw)
              : f.kind === 'HANDLE' ? linkHandle_(raw, f)
              : profileText_(raw, 80);
      } catch (err) {
        refused.push(f.key + ': ' + (err && err.message ? err.message : String(err)));
        return;
      }

      const before = s_(row[f.col]);
      if (before === String(value)) return;

      updates.push({ row: row.__row, field: f.col, value: value });
      audit.push(auditRow_(me, 'TEAM_LINKS', 'Team', teamId, f.col, before, value, ''));
      saved.push(f.key);
    });

    if (updates.length) {
      updateCells_(CONFIG.TABS.TEAMS, updates);
      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, audit);
      // apiBootstrap() carries the team payload for fifteen minutes; a link
      // nobody can see for fifteen minutes reads as a link that did not save
      CacheService.getScriptCache().removeAll(['boot']);
    }

    return { ok: refused.length === 0, saved: saved, refused: refused };
  } finally {
    lock.releaseLock();
  }
}

// ── corrections ────────────────────────────────────────────────────────────

/**
 * The single PlayerGameStats cell a correction is about.
 *
 * A correction names a player, a field and either a game or a season. It carries
 * no StatID because PlayerGameStats has no such column — the row is identified
 * the way a reviewer would find it, by game, player and the category the field
 * belongs to.
 *
 * Returns { row, current } or throws with something a coach can act on. It never
 * creates a row: a correction against a game whose box score was never entered
 * is a request to enter the box score, and inventing a line holding one number
 * would publish a player who caught four passes and nothing else.
 */
function teamAdminCorrectionTarget_(playerId, seasonId, gameId, field) {
  const head = tabHeader_(CONFIG.TABS.PLAYER_STATS);
  if (head.indexOf(field) < 0)
    throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' + field + ' column.');

  const cGrain = teamAdminCol_(head, ['grain', 'Grain']);
  const cCat = teamAdminCol_(head, ['category', 'Category']);
  if (!cGrain || !cCat)
    throw new Error(CONFIG.TABS.PLAYER_STATS + ' has no ' +
                    (cGrain ? 'category' : 'grain') + ' column.');

  const category = teamAdminCategoryOf_(field);
  const want = gameId ? CONFIG.GRAIN.GAME : CONFIG.GRAIN.SEASON_TOTAL;

  const hits = rowsOf_(CONFIG.TABS.PLAYER_STATS).filter(function (r) {
    if (s_(r.PlayerID) !== playerId) return false;
    if (s_(r[cGrain]) !== want) return false;
    if (gameId ? s_(r.GameID) !== gameId : s_(r.SeasonID) !== seasonId) return false;
    return normName_(s_(r[cCat])) === normName_(category);
  });

  if (!hits.length) {
    if (gameId) {
      /* "Enter the box score" is the right advice only when there is no box
         score. When the game HAS one and this player is simply not in it, the
         likelier story is that his line was credited to somebody else — two
         brothers on the same roster is all it takes — and telling a coach to
         enter a box score he already entered sends him looking in the wrong
         place. So say which of the two it is. */
      const entered = rowsOf_(CONFIG.TABS.PLAYER_STATS).some(function (r) {
        return s_(r.GameID) === gameId && s_(r[cGrain]) === want;
      });
      if (entered)
        throw new Error('The box score for ' + gameId + ' is entered, but it has no ' +
                        category.toLowerCase() + ' line for that player. Either he is ' +
                        'missing from it, or his line was credited to somebody else — ' +
                        'check the box score for a teammate holding these numbers. Put ' +
                        'the line right in Stat entry, then approve this.');
      throw new Error('There is no ' + category.toLowerCase() + ' line for that player in ' +
                      gameId + ' yet. Enter the box score first, then approve this — a ' +
                      'row built from one corrected number would publish him as having ' +
                      'done nothing else.');
    }
    throw new Error('That player\'s ' + seasonId + ' total is assembled from his game ' +
                    'rows, so there is no season cell to change. Approve the correction ' +
                    'against the game it happened in.');
  }
  if (hits.length > 1)
    throw new Error('There are ' + hits.length + ' ' + category.toLowerCase() +
                    ' rows for that player ' + (gameId ? 'in ' + gameId : 'in ' + seasonId) +
                    '. The duplicate has to be resolved in the sheet before a correction ' +
                    'can be applied to one of them.');

  const row = hits[0];
  const current = numOrNull_(row[field]);
  return { row: row, current: current === null ? '' : current };
}

/**
 * Approve or reject a stat correction a player filed.
 *
 *   apiReviewCorrection(correctionId, 'APPROVE'|'REJECT', note)
 *
 * APPROVE writes the proposed value into the PlayerGameStats cell it names,
 * marks the correction APPROVED and marks the derived layer dirty. REJECT marks
 * it REJECTED and changes no number. Either way the player who asked is told —
 * a dispute that vanishes gets filed again, louder.
 *
 * A correction that is no longer PENDING is reported, not re-decided. Two
 * approvals of the same row would apply the same delta twice.
 *
 * The proposed value may be blank, and blank is applied as blank: "this was
 * never reported" is a different and often truer claim than "this was zero", and
 * a reviewer who agrees with it must be able to say so.
 */
function apiReviewCorrection_(correctionId, decision, note) {
  return teamAdminDecideCorrection_(teamAdminSelf_(), correctionId, decision, note);
}

/**
 * The decision itself, given whoever is making it.
 *
 * Split from apiReviewCorrection so a coach can settle a correction from the
 * link in his email without an account (CorrectionMail.gs): the signature on
 * that link is the authorization, and once it is checked the write must be
 * the SAME write the portal performs — same guards, same audit, same message
 * to the player — or the two paths would drift and one of them would be wrong.
 */
function teamAdminDecideCorrection_(me, correctionId, decision, note) {
  correctionId = s_(correctionId);
  if (!correctionId) throw new Error('Which correction?');

  /* The portal sends the verb; a caller reading the Status column back sends the
     past tense. Both mean the same decision, and neither is worth an error.

     APPROVE_ADD is APPROVE for a game the player has no line in at all: it
     writes the line rather than refusing. It is its own word so that the
     approve link in a coach's email, which can only say APPROVE, keeps the
     careful behaviour — creating a row is a bigger act than changing a number
     and wants somebody looking at the screen. */
  const spoken = s_(decision).toUpperCase();
  const verdict = spoken === 'APPROVED' ? 'APPROVE'
                : (spoken === 'REJECTED' ? 'REJECT' : spoken);
  const mayCreate = verdict === 'APPROVE_ADD';
  const act = mayCreate ? 'APPROVE' : verdict;
  if (TEAMADMIN.DECISIONS.indexOf(act) < 0)
    throw new Error('Decision must be APPROVE or REJECT. "' + s_(decision) + '" is not.');
  note = profileText_(note, PROFILE.REASON_MAX);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    if(me.email==='coach-email-link' && s_(me.decisionSig)!==corrLinkSig_(correctionId,me.decision))
      throw new Error('This review link expired after an account closure. Use Approvals in the portal.');
    if (!hasTab_(CONFIG.TABS.CORRECTIONS))
      throw new Error('There is no ' + CONFIG.TABS.CORRECTIONS + ' tab. Run ensureSchema_().');
    delete __tableCache[CONFIG.TABS.CORRECTIONS];
    delete __tableCache[CONFIG.TABS.PLAYER_STATS];
    acctAssertHeaders_(CONFIG.TABS.CORRECTIONS, PROFILE.CORRECTION_COLS);

    const c = rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
      return s_(r.CorrectionID) === correctionId;
    })[0];
    if (!c) throw new Error('No correction ' + correctionId + '.');

    const teamId = s_(c.TeamID);
    assertTeamScope_(me, teamId, 'Correction ' + correctionId);

    const status = profileCorrectionStatus_(c);
    if (status !== 'PENDING')
      return { ok: false, message: 'Correction ' + correctionId + ' is already ' +
                                   status + '.' };

    const playerId = s_(c.PlayerID);
    const seasonId = s_(c.SeasonID) || CONFIG.CURRENT_SEASON;
    const gameId = s_(c.GameID);
    const field = s_(c.Field);
    const applicant = s_(c.CorrectedBy);
    const proposed = numOrNull_(c.NewValue);
    const proposedCell = (field === 'BlockedPunts' || field === 'TwoPointConversions') && act === 'APPROVE'
      ? teamAdminStat_(field, c.NewValue) : (proposed === null ? '' : proposed);

    const player = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (p) {
      return s_(p.PlayerID) === playerId;
    })[0];
    const playerName = (player && s_(player.DisplayName)) || playerId;
    const where = gameId ? 'game ' + gameId : seasonId + ' season total';

    if (act === 'REJECT') {
      updateCells_(CONFIG.TABS.CORRECTIONS, [
        { row: c.__row, field: 'Status',     value: 'REJECTED' },
        { row: c.__row, field: 'ReviewedBy', value: me.email },
        { row: c.__row, field: 'ReviewedAt', value: new Date() }
      ]);
      ensureOpsTabs_();
      // StatCorrections has no ReviewNote column, so the reviewer's words live
      // in the AuditLog and in the message to the player — never appended to
      // Reason, which is the player's own account of what happened.
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'CORRECTION_REJECT', 'StatCorrection',
        correctionId, field, s_(c.OldValue), s_(c.NewValue),
        teamId + ' ' + where + (note ? ' — ' + note : ''))]);

      // no note to the player: My Stats > Your requests shows the decision

      // the owner is told when a correction is FILED, not when it is decided:
      // he asked for the decisions to stop arriving in his inbox

      return { ok: true, correctionId: correctionId, decision: 'REJECTED',
               message: 'Rejected ' + correctionId + '.' };
    }

    /* Checked here and not before the REJECT branch above. It used to sit at
       the top, which made a correction naming an unknown field impossible to
       reject: the guard fired first and the sentence it threw said "Reject
       it." The request stuck in the queue with no way out of it. Nothing about
       this check is needed to turn a request down. */
    if (SUM_FIELDS.indexOf(field) < 0)
      throw new Error('Correction ' + correctionId + ' names "' + field + '", which is ' +
                      'not a stat this database keeps. Reject it.');

    /* "Approve and add the line" asked for by name. The row is written holding
       the one corrected number and NOTHING else — every other stat cell stays
       blank, which in this database reads as "not reported", never as zero.
       That is what makes creating it safe: the old refusal existed because a
       row of zeros would publish a boy as having caught four passes and done
       nothing else, and a row of blanks says only what was actually claimed. */
    if (mayCreate && gameId && !teamAdminHasStatLine_(playerId, gameId, field)) {
      const made = teamAdminAddStatLine_(me, playerId, teamId, seasonId, gameId,
                                         field, proposedCell, correctionId, s_(c.Reason));
      updateCells_(CONFIG.TABS.CORRECTIONS, [
        { row: c.__row, field: 'Status',     value: 'APPROVED' },
        { row: c.__row, field: 'ReviewedBy', value: me.email },
        { row: c.__row, field: 'ReviewedAt', value: new Date() },
        { row: c.__row, field: 'OldValue',   value: '' }
      ]);
      CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
      markDirty_('stats');
      teamAdminBustCache_(seasonId);
      return { ok: true, correctionId: correctionId, decision: 'APPROVED',
               message: 'Added a ' + made.category.toLowerCase() + ' line for ' +
                        playerName + ' in ' + where + ' holding ' + field + ' ' +
                        (proposedCell === '' ? 'blank' : proposedCell) +
                        '. Every other number on it is blank, not zero. Totals catch up ' +
                        'on the next rebuild.' };
    }

    const target = teamAdminCorrectionTarget_(playerId, seasonId, gameId, field);
    if (teamAdminSame_(target.current, proposedCell))
      throw new Error('The database already holds ' +
                      (target.current === '' ? 'no value' : target.current) +
                      ' for that. Reject the correction instead — approving it would ' +
                      'record a change that did not happen.');

    updateCells_(CONFIG.TABS.PLAYER_STATS,
                [{ row: target.row.__row, field: field, value: proposedCell }]);

    updateCells_(CONFIG.TABS.CORRECTIONS, [
      { row: c.__row, field: 'Status',     value: 'APPROVED' },
      { row: c.__row, field: 'ReviewedBy', value: me.email },
      { row: c.__row, field: 'ReviewedAt', value: new Date() },
      // What was actually on the sheet at the moment of approval, which is not
      // necessarily what the player saw when he filed.
      { row: c.__row, field: 'OldValue',   value: target.current }
    ]);

    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, [
      auditRow_(me, 'CORRECTION_APPROVE', 'StatCorrection', correctionId, field,
               target.current, proposedCell,
               teamId + ' ' + where + (note ? ' — ' + note : '')),
      // The stat itself gets its own row. A number that moved has to be findable
      // from the number's side, not only from the dispute's.
      auditRow_(me, 'STAT_CORRECTED', 'PlayerGameStat',
               (gameId || seasonId) + ':' + playerId, field,
               target.current, proposedCell,
               'correction ' + correctionId + ' — ' + s_(c.Reason))
    ]);

      // no note to the player: My Stats > Your requests shows the decision

    // no note to the owner on a decision - the player and the audit log hear;
    // he asked not to

    teamAdminBustCache_(seasonId);
    // a rebuild is not run inline — corrections are reviewed in a sitting, and
    // the sweep trigger collapses the sitting into one recompute
    markDirty_('stats');

    return {
      ok: true, correctionId: correctionId, decision: 'APPROVED',
      playerId: playerId, field: field,
      oldValue: target.current === '' ? null : target.current,
      newValue: proposedCell === '' ? null : proposedCell,
      message: 'Applied ' + field + ' for ' + playerName + ' in ' + where + '.'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * A coach's stats file. It goes to the administrators' inbox as it always
 * did, and - when the coach named the game and the reader is switched on -
 * it is read on the spot (StatsExtract.gs): every line that matches his
 * roster is written as FILE_IMPORT, official on landing - his upload is his
 * word, and he may upload again for any game, any time, to replace it; a
 * name that does not match goes to the StatsImport tab for the
 * administrator. A file that cannot be read costs nothing but the mail.
 */
function apiEmailStatsFile_(fileName, mimeType, base64, gameId) {
  const me = accountsWhoami_();
  if (me.role !== 'COACH' && me.role !== 'ADMIN')
    throw new Error('Only coach accounts can send a stats file.');
  gameId = s_(gameId);

  fileName = s_(fileName).replace(/[^\w .\-()]/g, '').slice(0, 80) || 'stats-file';
  const b64 = String(base64 || '');
  if (!b64) throw new Error('The file arrived empty. Choose it again.');
  if (b64.length > 10 * 1024 * 1024)
    throw new Error('That file is over the 7 MB limit. Export a smaller one, or share ' +
                    'it with contact@example.invalid directly.');

  var bytes;
  try { bytes = Utilities.base64Decode(b64); }
  catch (e) { throw new Error('Could not read the file. Choose it again.'); }
  /* Always a DOWNLOADABLE attachment. Gmail renders an image-typed attachment
     inline in the message body; typed as a generic binary it arrives as a file
     chip the admin saves and runs through extraction. The filename keeps its
     real extension, so nothing is lost but the inlining. */
  var mt = s_(mimeType) || 'application/octet-stream';
  if (mt.slice(0, 6) === 'image/') mt = 'application/octet-stream';
  const blob = Utilities.newBlob(bytes, mt, fileName);

  // every administrator, and the owner whether or not the tabs list him as one:
  // the reading this file becomes is something to approve, and he asked to hear
  const admins = acctApproversFor_('');
  const owner = (typeof ACCT !== 'undefined' && ACCT.OWNER) ? String(ACCT.OWNER) : '';
  if (owner && !admins.some(function (e) { return String(e).toLowerCase() === owner.toLowerCase(); }))
    admins.push(owner);
  if (!admins.length) throw new Error('No administrator address is on file.');

  const team = teamNameOf_(me.teamId);

  /* Read it now, if we can. The reading stands as the coach's official
     numbers; a misread is fixed by uploading again or editing the box score. */
  var read = null, readErr = '';
  if (gameId && me.teamId && typeof statsExtractForPortal_ === 'function' &&
      typeof chatKey_ === 'function' && chatKey_()) {
    try { read = statsExtractForPortal_(me, gameId, fileName, s_(mimeType), bytes); }
    catch (e) { readErr = (e && e.message) ? e.message : String(e); Logger.log('stats file: not read: ' + readErr); }
  }

  MailApp.sendEmail({
    to: admins.join(','),
    subject: 'Stats file from ' + (team || me.email),
    body: 'A stats file was uploaded from the coach portal.\n\n' +
          'Coach:  ' + me.email + '\n' +
          (team ? 'School: ' + team + '\n' : '') +
          (gameId ? 'Game:   ' + gameId + '\n' : '') +
          'File:   ' + fileName + '\n\n' +
          (read
            ? 'Read automatically: ' + read.saved + ' lines for ' + read.matched.length + ' players written as ' +
              'FILE_IMPORT (official; the coach can upload again to replace them).' +
              (read.unmatched.length ? ' Not on the roster, left on the StatsImport tab: ' + read.unmatched.join(', ') + '.' : '') +
              (read.refused.length ? ' Refused: ' + read.refused.join('; ') : '') +
              (read.notes ? '\nReader\'s note: ' + read.notes : '')
            : (readErr ? 'Not read automatically: ' + readErr + '\n' : '') +
              'Extract the statistics and enter them for the team.'),
    attachments: [blob],
    name: 'UCBAC Stats'
  });

  if (read) {
    const names = read.matched.map(function (m) { return m.name; });
    return { ok: true, read: read.read, saved: read.saved, matched: names, unmatched: read.unmatched,
             gameId: gameId,
             message: 'Read ' + read.read + ' player' + (read.read === 1 ? '' : 's') + ' from the file. ' +
                      (read.saved ? read.saved + ' line' + (read.saved === 1 ? ' is' : 's are') + ' on the box score as official; ' +
                                    'upload again any time to replace them. ' : '') +
                      (read.unmatched.length ? 'Not on your roster, sent to the administrator: ' + read.unmatched.join(', ') + '. ' : '') +
                      'The file was also mailed to the administrators.' };
  }
  return { ok: true, message: 'Sent. ' + (readErr ? 'It could not be read automatically, so an ' : 'The statistics will appear on the site once an ') +
                              'administrator has entered them.' };
}

// ── the stat-submission tracker ─────────────────────────────────────────────
//
// Who has sent what. For every game week of a season, each team's four boxes:
// team offense, individual offense, team defense, individual defense. An
// individual box is filled by a stat line that names a player. A team box is
// the totals, which the site derives from whatever lines it holds - so it is
// filled by individual lines OR by a team-level line (no PlayerID: "Rest of
// team"). A box is OFFICIAL when at least one official line fills it, PENDING
// when only provisional lines do (a player's own entry waiting in Approvals),
// NONE when nothing does. A team with no game that week has no boxes at all.

const TRACKER = {
  OFFENSE: { Passing: 1, Rushing: 1, Receiving: 1, Blocking: 1 },
  DEFENSE: { Defense: 1 },
  // One player entering his own line fills every box, which says nothing
  // about whether the school sent its stats. A side counts as submitted
  // once this many NAMED players have stats on it.
  MIN_PLAYERS: 5,
  // key, label, what the number in the box is: the team boxes carry the
  // totals on file (yards on offense, tackles on defense), the individual
  // boxes the number of named players with stats on that side
  BOXES: [['teamO', 'team offense', 'yds'], ['indO', 'individual offense', 'players'],
          ['teamD', 'team defense', 'tkl'], ['indD', 'individual defense', 'players']]
};

/** Which side of the ball a stat line is: by its category, else by what it carries. */
function taSideOf_(r) {
  const cat = s_(r.category || r.Category);
  if (TRACKER.OFFENSE[cat]) return 'O';
  if (TRACKER.DEFENSE[cat]) return 'D';
  if (cat) return '';                                  // special teams, or something else
  const any = function (fields) {
    return fields.some(function (f) { return r[f] !== '' && r[f] !== null && r[f] !== undefined; });
  };
  if (any(TEAMADMIN.CATEGORIES.Defense)) return 'D';
  if (any(TEAMADMIN.CATEGORIES.Passing.concat(TEAMADMIN.CATEGORIES.Rushing, TEAMADMIN.CATEGORIES.Receiving, TEAMADMIN.CATEGORIES.Blocking))) return 'O';
  return '';
}

/**
 * The whole conference for an administrator, or one school when asked for
 * one; a coach sees his own school and nothing else. With one school the
 * weeks it did not play are left out - there is nothing to be missing.
 */
function apiStatsTracker_(seasonId, teamId) {
  const me = accountsWhoami_();
  if (me.role === 'COACH') {
    if (!me.teamId) throw new Error('Your account is not bound to a school yet.');
    teamId = me.teamId;
  } else if (me.role !== 'ADMIN') {
    throw new Error('Coaches and administrators only.');
  }
  teamId = s_(teamId);
  seasonId = s_(seasonId) || CONFIG.CURRENT_SEASON;
  const tz = Session.getScriptTimeZone() || 'America/New_York';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  // every school's name, for the opponent column - then the schools asked for
  const teamName = {};
  const teams = rowsOf_(CONFIG.TABS.TEAMS).map(function (t) {
    return { id: s_(t.TeamID), name: s_(t.DisplayName) || s_(t.TeamID) };
  }).filter(function (t) { if (t.id) teamName[t.id] = t.name; return t.id && (!teamId || t.id === teamId); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  if (teamId && !teams.length) throw new Error('No school ' + teamId + '.');

  // what each game+team holds, per side: the lines and their total (yards
  // on offense, tackles on defense), and the named players - each 2 when
  // any of his lines is official, 1 when all of them are still pending
  const held = {};
  const n0 = function (v) { return num_(v) || 0; };
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    if (s_(r.SeasonID) !== seasonId) return;
    if (s_(r.grain || r.Grain) !== CONFIG.GRAIN.GAME) return;
    const gid = s_(r.GameID), tid = s_(r.TeamID);
    if (!gid || !tid) return;
    const side = taSideOf_(r);
    if (!side) return;
    const lvl = provisionalSource_(r.SourceType) ? 1 : 2;
    const key = gid + '|' + tid;
    const h = held[key] || (held[key] = { O: { lines: 0, pendingLines: 0, total: 0, players: {} },
                                          D: { lines: 0, pendingLines: 0, total: 0, players: {} } });
    const t = h[side];
    t.lines++;
    if (lvl === 1) t.pendingLines++;
    t.total += side === 'O' ? n0(r.PassYds) + n0(r.RushYds) : n0(r.TackleSolo) + n0(r.TackleAssist);
    const pid = s_(r.PlayerID);
    if (pid) t.players[pid] = Math.max(t.players[pid] || 0, lvl);
  });
  const EMPTY = { O: { lines: 0, pendingLines: 0, total: 0, players: {} }, D: { lines: 0, pendingLines: 0, total: 0, players: {} } };
  const boxesOf = function (h) {
    const out = {};
    ['O', 'D'].forEach(function (side) {
      const t = h[side];
      const ids = Object.keys(t.players);
      const waiting = ids.filter(function (p) { return t.players[p] === 1; }).length;
      out['team' + side] = { n: t.total, empty: t.lines === 0, pending: t.pendingLines > 0, short: false };
      out['ind' + side] = { n: ids.length, empty: ids.length === 0, pending: waiting > 0,
                            short: ids.length > 0 && ids.length < TRACKER.MIN_PLAYERS };
    });
    return out;
  };

  // the season's weeks, from its games; a week counts once any game in it is
  // played or its day has come - the future has nothing to be missing yet
  const weeks = {};
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (s_(g.SeasonID) !== seasonId) return;
    const n = num_(g.Week);
    if (n === null) return;
    const playoff = (typeof isPlayoffPhase_ === 'function') ? isPlayoffPhase_(g) : /round|play/i.test(s_(g.Phase));
    const key = (playoff ? 'P' : 'W') + n;
    const day = (g.GameDate instanceof Date) ? Utilities.formatDate(g.GameDate, tz, 'yyyy-MM-dd')
                                             : (String(g.GameDate || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
    const played = num_(g.HomeScore) !== null && num_(g.AwayScore) !== null;
    const w = weeks[key] || (weeks[key] = {
      key: key, playoff: playoff, n: n,
      label: playoff ? ((typeof playoffRoundLabel_ === 'function') ? playoffRoundLabel_(n) : 'Playoffs Round ' + n) : 'Week ' + n,
      order: (playoff ? 100 : 0) + n, due: false, games: []
    });
    if (played || (day && day <= today)) w.due = true;
    w.games.push({ id: s_(g.GameID), day: day, played: played,
                   hs: num_(g.HomeScore), as: num_(g.AwayScore),
                   home: s_(g.HomeTeamID), away: s_(g.AwayTeamID),
                   homeName: s_(g.HomeTeamName) || teamName[s_(g.HomeTeamID)] || s_(g.HomeTeamID),
                   awayName: s_(g.AwayTeamName) || teamName[s_(g.AwayTeamID)] || s_(g.AwayTeamID) });
  });

  const out = Object.keys(weeks).map(function (k) { return weeks[k]; })
    .filter(function (w) { return w.due; })
    .sort(function (a, b) { return b.order - a.order; })            // newest first
    .map(function (w) {
      const rows = teams.map(function (t) {
        const g = w.games.filter(function (x) { return x.home === t.id || x.away === t.id; })[0];
        if (!g) return { teamId: t.id, team: t.name, game: null };
        const home = g.home === t.id;
        const boxes = boxesOf(held[g.id + '|' + t.id] || EMPTY);
        const missing = TRACKER.BOXES.filter(function (x) { return boxes[x[0]].empty; }).map(function (x) { return x[1]; });
        const short = TRACKER.BOXES.filter(function (x) { return boxes[x[0]].short; }).map(function (x) { return x[0]; });
        const pending = TRACKER.BOXES.some(function (x) { return boxes[x[0]].pending; });
        /* Whether this school's box score has been CONFIRMED complete, which
           is what the other side's Allowed figures are built on. It rides on
           this row rather than on a checklist of its own, because it is the
           same grid: the same school, the same week, the same game. The tick
           itself is administrators only, and apiSetStatsCoverage says so —
           this field is a status anybody looking at the row may read.
           A non-conference opponent never sends us a line, so no Allowed
           figure can ever be built from that game and there is nothing to
           confirm; the row says so rather than offering a box that does
           nothing. */
        const oppId = home ? g.away : g.home;
        const covApplies = !!(oppId && teamName[oppId]) && g.played;
        return { teamId: t.id, team: t.name,
                 game: { id: g.id, opponent: home ? g.awayName : g.homeName, home: home, played: g.played, day: g.day,
                         us: g.played ? (home ? g.hs : g.as) : null, them: g.played ? (home ? g.as : g.hs) : null },
                 oppId: oppId, covApplies: covApplies,
                 statsIn: covApplies ? statsCovComplete_(g.id, t.id) : false,
                 boxes: boxes, missing: missing, short: short, pending: pending,
                 complete: missing.length === 0 && short.length === 0 };
      });
      const withGame = rows.filter(function (r) { return r.game; });
      const covRows = rows.filter(function (r) { return r.covApplies; });
      return { key: w.key, label: w.label, playoff: w.playoff,
               teams: withGame.length, complete: withGame.filter(function (r) { return r.complete; }).length,
               pending: withGame.filter(function (r) { return r.pending; }).length,
               missing: withGame.filter(function (r) { return !r.complete; }).length,
               covPlayed: covRows.length,
               received: covRows.filter(function (r) { return r.statsIn; }).length,
               rows: rows };
    })
    .filter(function (w) { return !teamId || w.teams > 0; });
  var covDone = 0, covAll = 0;
  out.forEach(function (w) { covDone += w.received; covAll += w.covPlayed; });
  return { season: seasonId, today: today, weeks: out, minPlayers: TRACKER.MIN_PLAYERS,
           team: teamId ? teams[0] : null,
           /* The tick is an administrator's; a coach sees the state and no box.
              Hiding the control is never the control — apiSetStatsCoverage
              refuses either way — but offering one that will be refused is
              its own kind of lie. */
           isAdmin: me.role === 'ADMIN',
           coverage: { received: covDone, played: covAll,
                       pct: covAll ? Math.round(100 * covDone / covAll) : 0,
                       minGames: (typeof STATSCOV !== 'undefined') ? STATSCOV.MIN_GAMES : 3 },
           boxes: TRACKER.BOXES.map(function (x) { return { key: x[0], label: x[1], unit: x[2] }; }) };
}
