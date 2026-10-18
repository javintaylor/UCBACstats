/**
 * UCBAC Stats — Fantasy.gs
 *
 * A PPR fantasy scoring board over the statistics the conference already keeps.
 *
 * It is a way of READING the box score, not a competition: there is no league,
 * no draft, no roster and no team to build. One player, one number, and the
 * arithmetic that produced it shown in full — which is the point. A fantasy
 * score is only interesting if you can see where every point came from, so the
 * player view returns the same four columns a scoring settings page shows:
 * category, points per, how many, and what that came to.
 *
 * One scoring system: PPR. There is no format switch, because a page offering
 * three of them is asking a reader to make a decision the page could just make
 * for them — and PPR is the one nearly every league runs.
 *
 * Three commitments, and every decision below is one of them:
 *
 *  1. The scoring is the standard one, not a house one. Passing yards at a
 *     point per 25 and touchdowns at four, rushing and receiving at a point per
 *     ten and six, a point per catch, minus two for a giveaway. Anybody who has
 *     played fantasy football recognises the table without being told it.
 *  2. Every position on the roster scores something. A site that tracks fifteen
 *     schools' defences and then hands a linebacker a zero would be advertising
 *     a page that does not work for half its players, so defenders score on the
 *     standard IDP table and the one blocking statistic the conference records
 *     is worth a point. The two additions are labelled as what they are.
 *  3. blank != zero, as everywhere else. A category nobody filed is absent from
 *     a player's table rather than printed as a nought, and it contributes
 *     nothing to his total. A total built by treating unreported as zero would
 *     rank the boys whose coaches file carefully BELOW the ones who do not.
 *
 * The numbers come from the same grain-resolved player-season table the Stats
 * page reads, so a fantasy total and a stat line can never disagree.
 */

const FANTASY_CACHE_PREFIX = 'fant3:';    // bump the digit to invalidate every key
const FANTASY_CACHE_TTL    = 120;
const FANTASY_LIMIT        = 50;
const FANTASY_MAX_LIMIT    = 75;

const FANTASY_LABEL = 'PPR';
const FANTASY_NOTE  = 'a point per reception';

/**
 * One part of the game at a time, and no combined total.
 *
 * A two-way player's offensive points and his defensive points are scored on
 * two different tables and answer two different questions, so adding them
 * produces a number that ranks him against nobody: a running back who never
 * plays defence and a linebacker who never touches the ball are not competing,
 * and a total across all three puts the boys who play both ahead of everyone
 * for reasons that have nothing to do with how they played. Pick a side and
 * the board is a board.
 *
 * There is deliberately no ALL. Offense is the default because it is the one
 * everybody means by "fantasy points" — but a position filter overrides it,
 * since a linebacker asked for on the offensive board is an empty screen.
 */
const FANTASY_SIDES = ['OFFENSE', 'DEFENSE', 'SPECIAL'];
const FANTASY_SIDE_LABEL = { OFFENSE: 'Offense', DEFENSE: 'Defense', SPECIAL: 'Special Teams' };

/**
 * The scoring table.
 *
 * A label NAMES THE UNIT, singular: the column beside it says what one of them
 * pays, so "Sack, 2" is the sentence and "Each Sack" says the same word twice.
 * Yardage stays plural, because nobody has ever written "Passing Yard".
 *
 * `fields` are SUM_FIELDS keys, summed together — a fumble lost is a fumble
 * lost whether he was carrying it or catching it. `pts` per `per` units, so a
 * point per 25 passing yards is {pts:1, per:25}; the screen divides it out and
 * prints 0.04, because the column beside it is a count and the two have to
 * multiply. `short` is the board's column heading, where a label will not fit.
 *
 * `house` marks a category standard fantasy football does not score at all.
 * There are exactly two kinds and both are deliberate: the defensive block is
 * the standard IDP table, which every league that scores defenders uses, and
 * the pancake is ours, because the conference records it and an offensive
 * lineman deserves better than a page of zeros. Both are declared to the
 * client so the scoring key can say so out loud rather than quietly passing
 * them off as canon.
 */
const FANTASY_RULES = [
  // Scorer only: conversion plays never enter ordinary offensive totals.
  { key: 'TwoPointConversions', label: 'Two-point Conversion', short: '2PT', side: 'OFFENSE', group: 'Conversions', fields: ['TwoPointConversions'], pts: 2 },
  // ── passing
  { key: 'PassYds',      label: 'Passing Yards',        short: 'PASS YDS', side: 'OFFENSE', group: 'Passing',   fields: ['PassYds'],      pts: 1,   per: 25 },
  { key: 'PassTD',       label: 'Passing Touchdown',    short: 'PASS TD',  side: 'OFFENSE', group: 'Passing',   fields: ['PassTD'],       pts: 4 },
  // Two categories are called INT in football and they are opposites. The one
  // he threw says so on the board, or a quarterback reads as a ball hawk.
  { key: 'PassInt',      label: 'Interception Thrown',  short: 'INT THR',  side: 'OFFENSE', group: 'Passing',   fields: ['PassInt'],      pts: -2 },

  // ── rushing
  { key: 'RushYds',      label: 'Rushing Yards',        short: 'RUSH YDS', side: 'OFFENSE', group: 'Rushing',   fields: ['RushYds'],      pts: 1,   per: 10 },
  { key: 'RushTD',       label: 'Rushing Touchdown',    short: 'RUSH TD',  side: 'OFFENSE', group: 'Rushing',   fields: ['RushTD'],       pts: 6 },

  // ── receiving
  { key: 'Rec',          label: 'Reception',            short: 'REC',      side: 'OFFENSE', group: 'Receiving', fields: ['Rec'],          pts: 1 },
  { key: 'RecYds',       label: 'Receiving Yards',      short: 'REC YDS',  side: 'OFFENSE', group: 'Receiving', fields: ['RecYds'],       pts: 1,   per: 10 },
  { key: 'RecTD',        label: 'Receiving Touchdown',  short: 'REC TD',   side: 'OFFENSE', group: 'Receiving', fields: ['RecTD'],        pts: 6 },

  // A giveaway costs the same wherever it happened.
  { key: 'FumLost',      label: 'Fumble Lost',          short: 'FUM',      side: 'OFFENSE', group: 'Ball security',
    fields: ['RushFum', 'RecFum'], pts: -2 },

  // ── kicking. Distance is not collected, so a field goal is a field goal:
  // scoring 0-39 / 40-49 / 50+ would mean inventing a distance for every kick
  // in the database. A miss is not penalised — the flat three already declines
  // to reward the long ones, and taking a point off a fourteen-year-old's card
  // for a miss is not what this page is for.
  { key: 'FGM',          label: 'Field Goal Made',      short: 'FGM',      side: 'SPECIAL', group: 'Kicking',   fields: ['FGM'],          pts: 3 },
  { key: 'XPM',          label: 'Extra Point Made',     short: 'XPM',      side: 'SPECIAL', group: 'Kicking',   fields: ['XPM'],          pts: 1 },

  // ── returns
  { key: 'KRYds',        label: 'Kick Return Yards',    short: 'KR YDS',   side: 'SPECIAL', group: 'Returns',   fields: ['KRYds'],        pts: 1,   per: 25 },
  { key: 'PRYds',        label: 'Punt Return Yards',    short: 'PR YDS',   side: 'SPECIAL', group: 'Returns',   fields: ['PRYds'],        pts: 1,   per: 25 },

  // ── the standard IDP table
  { key: 'TackleSolo',   label: 'Solo Tackle',          short: 'SOLO',     side: 'DEFENSE', group: 'Defense',   fields: ['TackleSolo'],   pts: 1,   house: 'IDP' },
  { key: 'TackleAssist', label: 'Assisted Tackle',      short: 'AST',      side: 'DEFENSE', group: 'Defense',   fields: ['TackleAssist'], pts: 0.5, house: 'IDP' },
  { key: 'TFL',          label: 'Tackle for Loss',      short: 'TFL',      side: 'DEFENSE', group: 'Defense',   fields: ['TFL'],          pts: 1,   house: 'IDP' },
  { key: 'Sacks',        label: 'Sack',                 short: 'SACK',     side: 'DEFENSE', group: 'Defense',   fields: ['Sacks'],        pts: 2,   house: 'IDP' },
  { key: 'Int',          label: 'Interception',         short: 'INT',      side: 'DEFENSE', group: 'Defense',   fields: ['Int'],          pts: 3,   house: 'IDP' },
  { key: 'PassDef',      label: 'Pass Defended',        short: 'PD',       side: 'DEFENSE', group: 'Defense',   fields: ['PassDef'],      pts: 1,   house: 'IDP' },
  { key: 'FF',           label: 'Forced Fumble',        short: 'FF',       side: 'DEFENSE', group: 'Defense',   fields: ['FF'],           pts: 2,   house: 'IDP' },
  { key: 'FR',           label: 'Fumble Recovery',      short: 'FR',       side: 'DEFENSE', group: 'Defense',   fields: ['FR'],           pts: 2,   house: 'IDP' },
  { key: 'DefTD',        label: 'Defensive Touchdown',  short: 'DEF TD',   side: 'DEFENSE', group: 'Defense',   fields: ['DefTD'],        pts: 6,   house: 'IDP' },
  { key: 'Blocks',       label: 'Blocked Kick',         short: 'BLK',      side: 'DEFENSE', group: 'Defense',   fields: ['Blocks'],       pts: 2,   house: 'IDP' },

  // ── the one blocking statistic the conference keeps
  { key: 'Pancakes',     label: 'Pancake Block',        short: 'PAN',      side: 'OFFENSE', group: 'Blocking',  fields: ['Pancakes'],     pts: 1,   house: 'UCBAC' }
];

const FANTASY_BY_KEY = (function () {
  const m = {};
  FANTASY_RULES.forEach(function (r) { m[r.key] = r; });
  return m;
})();

/**
 * Team Defense — the D/ST table, which is a different scoring system from the
 * IDP one above and not a sum of it. A league scores an individual linebacker
 * on tackles; it scores a DEFENCE on takeaways, sacks and what it gave up.
 *
 * Three standard categories are absent because the conference does not record
 * them, and the page says so rather than letting a reader think his defence
 * came up short: the kickoff return touchdown, the punt return touchdown, and
 * the safety. Our one DefTD field covers the interception and fumble returns,
 * which is where the standard table also puts 6 points, so those are exact.
 */
const FANTASY_TEAM_RULES = [
  { key: 'Sacks',  label: 'Sack',                    short: 'SACK',   side: 'DEFENSE', group: 'Defense',
    fields: ['Sacks'],  pts: 1 },
  { key: 'Int',    label: 'Interception',            short: 'INT',    side: 'DEFENSE', group: 'Defense',
    fields: ['Int'],    pts: 2 },
  { key: 'FR',     label: 'Fumble Recovery',         short: 'FR',     side: 'DEFENSE', group: 'Defense',
    fields: ['FR'],     pts: 2 },
  { key: 'Blocks', label: 'Blocked Punt, PAT or FG', short: 'BLK',    side: 'DEFENSE', group: 'Defense',
    fields: ['Blocks'], pts: 2 },
  // Interception and fumble returns both score 6 in the standard table, and
  // both land in this one field, so not being able to tell them apart costs
  // the arithmetic nothing.
  { key: 'DefTD',  label: 'Interception or Fumble Return TD', short: 'DEF TD', side: 'DEFENSE', group: 'Defense',
    fields: ['DefTD'],  pts: 6 }
];

const FANTASY_TEAM_BY_KEY = (function () {
  const m = {};
  FANTASY_TEAM_RULES.forEach(function (r) { m[r.key] = r; });
  return m;
})();

/**
 * Points allowed, in the standard bands.
 *
 * The band is a PER-GAME band and is applied per game, which is the whole
 * point of it: a defence that allowed 140 points across ten games played ten
 * ordinary games, and running its season total through this table would call
 * it a 46+ defence and take five points off it.
 */
const FANTASY_PA_TIERS = [
  { key: 'PA0',     max: 0,       label: 'Shutout — 0 points allowed', short: 'SHO', pts: 5 },
  { key: 'PA1_6',   max: 6,       label: '1-6 points allowed',              short: '1-6', pts: 4 },
  { key: 'PA7_13',  max: 13,      label: '7-13 points allowed',             short: '7-13', pts: 3 },
  { key: 'PA14_17', max: 17,      label: '14-17 points allowed',            short: '14-17', pts: 1 },
  { key: 'PA18_27', max: 27,      label: '18-27 points allowed',            short: '18-27', pts: 0 },
  { key: 'PA28_34', max: 34,      label: '28-34 points allowed',            short: '28-34', pts: -1 },
  { key: 'PA35_45', max: 45,      label: '35-45 points allowed',            short: '35-45', pts: -3 },
  { key: 'PA46',    max: 1e9,     label: '46+ points allowed',              short: '46+', pts: -5 }
];

function fantasyTier_(pointsAllowed) {
  for (var i = 0; i < FANTASY_PA_TIERS.length; i++) {
    if (pointsAllowed <= FANTASY_PA_TIERS[i].max) return FANTASY_PA_TIERS[i];
  }
  return FANTASY_PA_TIERS[FANTASY_PA_TIERS.length - 1];
}

/**
 * What one of the thing is worth: "0.04", "0.1", "4", "-2", "0.5".
 *
 * The multiplier, not the ratio — the column is called Pts Per and the row
 * beside it is a count, so the three columns have to read across as
 * "0.1 x 26 = 2.6". Printing "1 per 10" there is a different sum from the one
 * the numbers next to it are doing.
 */
function fantasyPtsLabel_(rule) {
  const each = rule.pts / (rule.per || 1);
  return String(Math.round(each * 1000) / 1000);
}

/** Fantasy points carry one decimal, the way every scoreboard shows them. */
function fantasyRound_(v) {
  if (v === null || v === undefined || typeof v !== 'number' || isNaN(v)) return null;
  return Math.round(v * 10) / 10;
}

/**
 * Score one player's summed statistics.
 *
 * Returns every line that has something behind it, plus the total. A category
 * the player did not record — or recorded as a genuine nought — yields no line
 * at all: "0 interceptions thrown, 0.0 points" is a row that tells the reader
 * nothing and pushes the rows that do off the screen.
 */
function fantasyScore_(sums, side) {
  const lines = [], counts = {};
  var total = 0, any = false;
  FANTASY_RULES.forEach(function (rule) {
    if (side && rule.side !== side) return;
    var count = null;
    rule.fields.forEach(function (f) {
      const v = numOrNull_(sums[f]);
      if (v === null) return;
      count = (count === null ? 0 : count) + v;
    });
    if (count === null || count === 0) return;
    const score = (count / (rule.per || 1)) * rule.pts;
    any = true;
    total += score;
    counts[rule.key] = Math.round(count * 100) / 100;
    lines.push({
      key: rule.key, label: rule.label, short: rule.short, group: rule.group,
      ptsLabel: fantasyPtsLabel_(rule),
      count: counts[rule.key],
      score: fantasyRound_(score),
      house: rule.house || ''
    });
  });
  // Nobody who filed nothing gets a 0.0 — that is a score, and he has none.
  return { lines: lines, counts: counts, total: any ? fantasyRound_(total) : null };
}

/**
 * Every player in range, with his points.
 *
 * Deliberately the same shape and the same gates as statsPlayerRows(): filters
 * apply to the SEASON row so a boy who transferred out of the county is scored
 * only for the seasons he played there, and a player whose roster row names no
 * position is judged on what he actually recorded rather than dropped for his
 * coach's paperwork.
 */
function fantasyAccum_(q, ctx) {
  const src = ctx.playerSource || statsSeasonSource_();
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });

  const posOf = {}, gradOf = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    var sid = s_(r.SeasonID), pid = s_(r.PlayerID), grad = s_(r.GradYear);
    if (pid && grad && !gradOf[pid]) gradOf[pid] = grad;
    if (!ctx.inRange[sid]) return;
    posOf[pid + '|' + sid] = parsePositions_(r.Positions);
  });

  const acc = {};
  src.rows.forEach(function (r) {
    var pid = s_(r.PlayerID), sid = s_(r.SeasonID);
    if (!pid || !ctx.inRange[sid]) return;
    if (q.playerId && pid !== q.playerId) return;

    var tid = s_(r.TeamID), team = ctx.teams[tid];
    if (q.teamId && tid !== q.teamId) return;
    if (q.county && (!team || team.county !== q.county)) return;

    var codes = posOf[pid + '|' + sid] || [];
    var posUnknown = false;
    if (q.position) {
      if (!positionMatches_(codes, q.position)) {
        if (codes.length) return;
        posUnknown = true;
      }
    }

    var b = acc[pid];
    if (!b) {
      b = acc[pid] = { playerId: pid, sums: {}, gp: null, gpMissing: 0, seasons: [],
                       positions: {}, newest: '', newestTeam: '', posUnknown: false,
                       positionConfirmed: false, prov: false };
    }
    if (s_(r.Provisional) === 'TRUE') b.prov = true;
    addInto_(b.sums, r);

    var gp = numOrNull_(r.GamesPlayed);
    if (gp === null) b.gpMissing++;
    else b.gp = (b.gp === null ? 0 : b.gp) + gp;

    if (b.seasons.indexOf(sid) < 0) b.seasons.push(sid);
    codes.forEach(function (c) { b.positions[c] = true; });
    if (posUnknown) { if (!b.positionConfirmed) b.posUnknown = true; }
    else if (q.position) { b.posUnknown = false; b.positionConfirmed = true; }
    if (sid > b.newest) { b.newest = sid; b.newestTeam = tid; }
  });

  const out = [];
  var inferred = 0;
  Object.keys(acc).forEach(function (pid) {
    var b = acc[pid];
    if (b.posUnknown) {
      if (!statsProfileFits_(b.sums, q.position)) return;
      inferred++;
    }
    var scored = fantasyScore_(b.sums, q.side);
    // A player in range who scored nothing at all is not a fantasy row. He is
    // on the Stats page with whatever he did record; a board of 0.0s is not a
    // leaderboard, it is a roster.
    if (scored.total === null && ctx.keepZero && fantasyHasReported_(b.sums, q.side)) scored.total = 0;
    if (scored.total === null) return;

    var p = players[pid] || {};
    var team = ctx.teams[b.newestTeam] || null;
    var seasons = b.seasons.slice().sort().reverse();
    // Per-game means nothing off a partial game count: a two-season total
    // divided by the one season that filed games roughly doubles the rate.
    var fppg = (b.gp !== null && b.gp > 0 && !b.gpMissing)
             ? fantasyRound_(scored.total / b.gp) : null;

    out.push({
      playerId: pid,
      player: s_(p.DisplayName) || pid,
      teamId: b.newestTeam,
      team: team ? team.name : b.newestTeam,
      county: team ? team.county : '',
      grad: s_(p.GradYear) || gradOf[pid] || '',
      positions: formatPositions_(statsOrderedCodes_(b.positions)),
      seasonIds: seasons,
      seasons: seasons.map(function (id) { return ctx.seasonIdx.byId[id].label; }).join(', '),
      gp: b.gp,
      gpPartial: b.gpMissing > 0,
      prov: !!b.prov,
      fpts: scored.total,
      fppg: fppg,
      cats: scored.counts,
      lines: scored.lines
    });
  });
  ctx.inferredPositions = inferred;
  return out;
}

// ── Team Defense ────────────────────────────────────────────────────────────

/**
 * One bucket per conference team: what its defence recorded, and what it gave
 * up game by game.
 *
 * Two independent halves, for the same reason statsTeamRows has two. Points
 * allowed come from Games, because they must be read one game at a time for
 * the band to mean anything, and because a defence allowed what it allowed
 * whether the other side was a conference member or not. Sacks, takeaways and
 * blocks come from PlayerGameStats with grain resolved per player-season
 * FIRST, so a player holding both GAME rows and a SEASON_TOTAL row contributes
 * once and a mid-season transfer lands on both teams.
 */
function fantasyTeamAccum_(q, ctx) {
  const acc = {};
  function bucket(tid) {
    if (!ctx.teams[tid]) return null;                 // conference members only
    var b = acc[tid];
    if (!b) {
      b = acc[tid] = { teamId: tid, sums: {}, pa: null, gp: 0, tiers: {},
                       seasons: {}, prov: false };
    }
    return b;
  }

  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    var sid = s_(g.SeasonID);
    if (!ctx.inRange[sid] || (ctx.acceptGame && !ctx.acceptGame(g))) return;
    var hs = numOrNull_(g.HomeScore), as = numOrNull_(g.AwayScore);
    if (hs === null || as === null) return;           // unplayed contributes nothing
    [[s_(g.HomeTeamID), as], [s_(g.AwayTeamID), hs]].forEach(function (persp) {
      var b = bucket(persp[0]);
      if (!b) return;
      b.pa = (b.pa === null ? 0 : b.pa) + persp[1];
      b.gp++;
      b.seasons[sid] = true;
      var t = fantasyTier_(persp[1]);
      b.tiers[t.key] = (b.tiers[t.key] || 0) + 1;
    });
  });

  const pacc = {};
  var rowIdx = 0;
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    rowIdx++;
    var sid = s_(r.SeasonID);
    if (!ctx.inRange[sid]) return;
    var grain = s_(r.grain || r.Grain);
    if (ctx.acceptGame) {
      const game = fantasyCalendar_().games[s_(r.GameID)];
      if (grain !== CONFIG.GRAIN.GAME || !game || s_(game.SeasonID) !== sid || !ctx.acceptGame(game)) return;
    }
    if (grain !== CONFIG.GRAIN.GAME && grain !== CONFIG.GRAIN.SEASON_TOTAL) return;
    var tid = s_(r.TeamID);
    if (!ctx.teams[tid]) return;

    // A stat row that never resolved to a PlayerID is still the team's
    // production. Dropping it would understate every school that had an
    // import miss.
    var pid = s_(r.PlayerID);
    if (!pid) pid = s_(r.player_raw) ? '~raw:' + s_(r.player_raw).toLowerCase() : '~row:' + rowIdx;

    var key = pid + '|' + sid;
    var p = pacc[key];
    if (!p) p = pacc[key] = { seasonId: sid, game: {}, season: {}, hasGame: false, provTeams: {} };
    if (grain === CONFIG.GRAIN.GAME) {
      p.hasGame = true;
      if (provisionalSource_(r.SourceType)) p.provTeams[tid] = true;
      if (!p.game[tid]) p.game[tid] = {};
      addInto_(p.game[tid], r);
    } else {
      if (!p.season[tid]) p.season[tid] = {};
      addInto_(p.season[tid], r);
    }
  });

  Object.keys(pacc).forEach(function (key) {
    var p = pacc[key];
    var use = p.hasGame ? p.game : p.season;
    Object.keys(use).forEach(function (tid) {
      var b = bucket(tid);
      if (!b) return;
      var sums = use[tid];
      FANTASY_TEAM_RULES.forEach(function (rule) {
        rule.fields.forEach(function (f) {
          if (sums[f] === undefined) return;
          b.sums[f] = (b.sums[f] === undefined ? 0 : b.sums[f]) + sums[f];
        });
      });
      b.seasons[p.seasonId] = true;
      if (p.hasGame && p.provTeams[tid]) b.prov = true;
    });
  });

  const out = [];
  Object.keys(acc).forEach(function (tid) {
    var b = acc[tid];
    var scored = fantasyTeamScore_(b);
    if (scored.total === null) return;
    var team = ctx.teams[tid];
    var seasons = Object.keys(b.seasons).sort().reverse();
    out.push({
      playerId: tid,                       // the sorter and the client key on this
      teamId: tid,
      player: team.name, team: team.name,
      county: team.county, positions: '', grad: '',
      seasonIds: seasons,
      seasons: seasons.map(function (id) { return ctx.seasonIdx.byId[id].label; }).join(', '),
      gp: b.gp || null,
      gpPartial: false,
      prov: !!b.prov,
      pa: b.pa,
      fpts: scored.total,
      fppg: (b.gp > 0) ? fantasyRound_(scored.total / b.gp) : null,
      cats: scored.counts,
      lines: scored.lines
    });
  });
  return out;
}

/**
 * Score one defence.
 *
 * The points-allowed bands are emitted as one line per band that actually
 * happened — "7-13 points allowed, 3 points each, 4 games, 12.0" — which is
 * exactly the four columns the rest of the page uses. A band worth nothing
 * still gets its line, unlike every other category on the site: the bands
 * together have to account for every game played, and one silently missing
 * makes the games stop adding up.
 */
function fantasyTeamScore_(b) {
  const lines = [], counts = {};
  var total = 0, any = false;

  FANTASY_TEAM_RULES.forEach(function (rule) {
    var count = null;
    rule.fields.forEach(function (f) {
      const v = numOrNull_(b.sums[f]);
      if (v === null) return;
      count = (count === null ? 0 : count) + v;
    });
    if (count === null || count === 0) return;
    const score = count * rule.pts;
    any = true; total += score;
    counts[rule.key] = Math.round(count * 100) / 100;
    lines.push({ key: rule.key, label: rule.label, short: rule.short, group: rule.group,
                 ptsLabel: fantasyPtsLabel_(rule), count: counts[rule.key],
                 score: fantasyRound_(score), house: '' });
  });

  FANTASY_PA_TIERS.forEach(function (t) {
    const games = b.tiers[t.key] || 0;
    if (!games) return;
    const score = games * t.pts;
    any = true; total += score;
    lines.push({ key: t.key, label: t.label, short: t.short, group: 'Points allowed',
                 ptsLabel: String(t.pts), count: games,
                 score: fantasyRound_(score), house: '' });
  });
  if (b.pa !== null) counts.PA = b.pa;

  return { lines: lines, counts: counts, total: any ? fantasyRound_(total) : null };
}

/** The board's columns for a defence: the five categories, then what it gave up. */
function fantasyTeamColumns_(rows, sortBy) {
  const present = {};
  rows.forEach(function (r) {
    Object.keys(r.cats || {}).forEach(function (k) { present[k] = true; });
  });
  const cols = FANTASY_TEAM_RULES
    .filter(function (r) { return present[r.key] || sortBy === r.key; })
    .map(function (r) {
      return { key: r.key, label: r.short, full: r.label, group: r.group,
               ptsLabel: fantasyPtsLabel_(r), house: '' };
    });
  if (present.PA || sortBy === 'PA') {
    // fewest allowed is the good end, so this one column opens ascending
    cols.push({ key: 'PA', label: 'PA', full: 'Points allowed',
                group: 'Points allowed', ptsLabel: 'banded', house: '', asc: true });
  }
  return cols;
}

/** The team scoring key, bands and all. */
function fantasyTeamKey_() {
  return FANTASY_TEAM_RULES.map(function (r) {
    return { key: r.key, label: r.label, short: r.short, group: r.group,
             ptsLabel: fantasyPtsLabel_(r), house: '' };
  }).concat(FANTASY_PA_TIERS.map(function (t) {
    return { key: t.key, label: t.label, short: t.short, group: 'Points allowed',
             ptsLabel: String(t.pts), house: '' };
  }));
}

function fantasyNormalizeQuery_(query) {
  const raw = query || {};
  const q = {};
  q.scope = String(raw.scope || 'PLAYER').toUpperCase() === 'TEAM' ? 'TEAM' : 'PLAYER';
  const askedSide = s_(raw.side).toUpperCase();
  q.side = FANTASY_SIDES.indexOf(askedSide) >= 0 ? askedSide : 'OFFENSE';
  q.timeRange = String(raw.timeRange || 'CURRENT').toUpperCase();
  if (['CURRENT', 'WEEK', 'SEASON', 'LAST4', 'ALL'].indexOf(q.timeRange) < 0) q.timeRange = 'CURRENT';
  q.seasonId = s_(raw.seasonId);
  q.weekKey = /^[WR][1-9][0-9]*$/.test(s_(raw.weekKey)) ? s_(raw.weekKey) : '';
  if (q.timeRange === 'CURRENT') {
    const current = fantasyCalendar_().current;
    q.timeRange = 'WEEK'; q.seasonId = CONFIG.CURRENT_SEASON;
    q.weekKey = current ? current.key : '';
  }
  q.county   = s_(raw.county);
  q.teamId   = s_(raw.teamId);
  q.playerId = s_(raw.playerId);
  q.search   = s_(raw.search).slice(0, 40);
  q.position = s_(raw.position).toUpperCase();
  if (q.position && !POS_BY_CODE[q.position]) q.position = '';
  if (q.scope === 'TEAM') q.position = '';           // a defence has no position
  /* Asking for linebackers on the offensive board is asking for an empty
     screen. A position implies its side, unless the reader named one — which
     is the same bargain the Stats page strikes, for the same reason. */
  if (q.position && !askedSide) {
    const implied = statsSideForPosition_(q.position);
    if (implied && FANTASY_SIDES.indexOf(implied) >= 0) q.side = implied;
  }
  /* Total, per game, or any one of the scoring categories — a column on a
     leaderboard that cannot be sorted by is decoration. Anything else asked
     for falls back to the projected-points default rather than to an empty board. */
  const asked = s_(raw.sortBy);
  const known = q.scope === 'TEAM'
    ? (FANTASY_TEAM_BY_KEY[asked] || asked === 'PA')
    : !!(FANTASY_BY_KEY[asked] && FANTASY_BY_KEY[asked].side === q.side);
  q.sortBy = asked.toUpperCase() === 'PPG' || asked.toUpperCase() === 'FPPG' ? 'PPG'
           : asked.toUpperCase() === 'PTS' ? 'PTS' : known ? asked : 'PRED';
  q.sortDir = String(raw.sortDir || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  var limit = numOrNull_(raw.limit);
  q.limit = limit === null ? FANTASY_LIMIT
          : Math.max(1, Math.min(FANTASY_MAX_LIMIT, Math.floor(limit)));
  var offset = numOrNull_(raw.offset);
  q.offset = offset === null ? 0 : Math.max(0, Math.floor(offset));
  return q;
}

function fantasyCacheKey_(q) {
  return FANTASY_CACHE_PREFIX + [apiTodayStr_(), CONFIG.CURRENT_SEASON, q.weekKey, q.scope, q.side, q.timeRange, q.seasonId, q.county, q.teamId,
    q.position, q.playerId, q.sortBy, q.sortDir, q.limit, q.offset,
    q.search.toLowerCase()].join('|');
}

/** The range this query covers, resolved exactly as the Stats page resolves it. */
function fantasyContext_(q) {
  const sIdx = statsSeasonIndex_();
  /* A defence's season can stand on scored games alone — points allowed need
     no box score. A player's cannot. */
  const withData = q.timeRange === 'WEEK' ? {} : statsSeasonsWithData_(q.scope === 'TEAM' ? 'TEAM' : 'PLAYER', 'ALL');
  if (!q.seasonId) {
    for (var i = 0; i < sIdx.newestFirst.length; i++) {
      if (withData[sIdx.newestFirst[i]]) { q.seasonId = sIdx.newestFirst[i]; break; }
    }
    if (!q.seasonId) q.seasonId = CONFIG.CURRENT_SEASON;
  }
  var range;
  if (q.timeRange === 'WEEK') {
    range = { seasons: sIdx.byId[q.seasonId] ? [q.seasonId] : [], inRange: {}, excluded: [] };
    range.seasons.forEach(function (sid) { range.inRange[sid] = true; });
  } else range = statsResolveSeasons_(q, sIdx, withData);
  const ctx = { seasonIdx: sIdx, seasons: range.seasons, inRange: range.inRange,
           excluded: range.excluded, teams: statsTeamIndex_(),
           source: q.timeRange === 'WEEK' ? 'Game-level records' : statsSeasonSource_().source, inferredPositions: 0 };
  if (q.timeRange === 'WEEK') {
    ctx.acceptGame = function (g) { return s_(g.SeasonID) === q.seasonId && periodKey_(g) === q.weekKey; };
    ctx.keepZero = true;
    if (q.scope !== 'TEAM') ctx.playerSource = fantasyGameSource_(ctx.acceptGame, q.side);
  }
  return ctx;
}

/**
 * Blanks last in both directions, with a stable tiebreak so paging is steady.
 * A category sort reads through `cats`, where a player who never recorded one
 * has no entry at all — which is how he sorts last rather than as a nought.
 */
function fantasySorter_(sortBy, dir) {
  const mul = dir === 'ASC' ? 1 : -1;
  const read = sortBy === 'PTS' ? function (r) { return r.fpts; }
             : sortBy === 'PPG' ? function (r) { return r.fppg; }
             : sortBy === 'PRED' ? function (r) { return r.prediction; }
             : function (r) { return (r.cats || {})[sortBy]; };
  return function (x, y) {
    var a = read(x), b = read(y);
    var an = (a === null || a === undefined || a === '');
    var bn = (b === null || b === undefined || b === '');
    if (an && bn) return String(x.playerId).localeCompare(String(y.playerId));
    if (an) return 1;
    if (bn) return -1;
    return ((a - b) * mul) || String(x.playerId).localeCompare(String(y.playerId));
  };
}

/**
 * The scoring key, as the page prints it: every category and what it is worth,
 * whether or not anybody scored in it.
 */
function fantasyKey_(side) {
  return FANTASY_RULES.filter(function (r) { return !side || r.side === side; })
    .map(function (r) {
      return { key: r.key, label: r.label, short: r.short, side: r.side, group: r.group,
               ptsLabel: fantasyPtsLabel_(r), house: r.house || '' };
    });
}

function fantasyBuild_(q) {
  const ctx = fantasyContext_(q);
  const team = q.scope === 'TEAM';
  var rows = fantasyRows_(q, ctx);

  if (team) {
    if (q.county) rows = rows.filter(function (r) { return r.county === q.county; });
    if (q.teamId) rows = rows.filter(function (r) { return r.teamId === q.teamId; });
  }

  if (q.search) {
    var needle = q.search.toLowerCase();
    rows = rows.filter(function (r) {
      return String(r.player || '').toLowerCase().indexOf(needle) >= 0 ||
             String(r.team || '').toLowerCase().indexOf(needle) >= 0;
    });
  }

  /* The board carries a column per scoring category, in the order the rules
     are declared, so a reader sees WHERE the points came from without opening
     anybody. A category nobody in this view recorded is dropped rather than
     printed as a stripe of blanks — filter to quarterbacks and the tackles
     and pancakes go away by themselves. The sorted column always stays, or
     the order would have no visible cause. */
  var columns;
  if (team) {
    columns = fantasyTeamColumns_(rows, q.sortBy);
  } else {
    const present = {};
    rows.forEach(function (r) {
      Object.keys(r.cats || {}).forEach(function (k) { present[k] = true; });
    });
    columns = FANTASY_RULES
      .filter(function (r) { return r.side === q.side; })
      .filter(function (r) { return present[r.key] || q.sortBy === r.key; })
      .map(function (r) {
        return { key: r.key, label: r.short, full: r.label, group: r.group,
                 ptsLabel: fantasyPtsLabel_(r), house: r.house || '' };
      });
  }

  rows.sort(fantasySorter_(q.sortBy, q.sortDir));
  const total = rows.length;
  const page = rows.slice(q.offset, q.offset + q.limit).map(function (r, i) {
    return { rank: q.sortBy === 'PTS' && r.fpts === null ? null : q.offset + i + 1, playerId: r.playerId, player: r.player,
             teamId: r.teamId, team: r.team, positions: r.positions, grad: r.grad,
             seasons: r.seasons, seasonIds: r.seasonIds, gp: r.gp,
             gpPartial: r.gpPartial, prov: r.prov, fpts: r.fpts, fppg: r.fppg,
             cats: r.cats, prediction: r.prediction, predictionGames: r.predictionGames,
             predictionProvisional: r.predictionProvisional, predictionTeam: r.predictionTeam };
  });

  const warnings = [];
  if (ctx.inferredPositions) {
    warnings.push(ctx.inferredPositions + ' player' + (ctx.inferredPositions === 1 ? '' : 's') +
      ' included on what they recorded: their roster row named no position.');
  }
  if (q.timeRange !== 'SEASON' && rows.some(function (r) { return r.gpPartial; })) {
    warnings.push('Points per game is left blank where a season was filed as a ' +
                  'total with no game count behind it.');
  }

  return {
    rows: page,
    columns: columns,
    scoring: team ? fantasyTeamKey_() : fantasyKey_(q.side),
    meta: Object.assign(fantasyPeriodFields_(q, ctx), {
      scope: q.scope,
      side: team ? 'DEFENSE' : q.side,
      sideLabel: team ? 'Team Defense' : FANTASY_SIDE_LABEL[q.side],
      sides: FANTASY_SIDES.map(function (k) { return { key: k, label: FANTASY_SIDE_LABEL[k] }; }),
      formatLabel: FANTASY_LABEL, formatNote: FANTASY_NOTE,
      timeRange: q.timeRange, seasonId: q.seasonId,
      seasons: ctx.seasons.map(function (id) {
        return { id: id, label: ctx.seasonIdx.byId[id].label };
      }),
      seasonsExcluded: ctx.excluded,
      county: q.county, teamId: q.teamId, position: q.position, search: q.search,
      sortBy: q.sortBy, sortDir: q.sortDir,
      limit: q.limit, offset: q.offset, total: total, returned: page.length,
      inferredPositions: ctx.inferredPositions,
      source: ctx.source, warnings: warnings,
      generatedAt: new Date().toISOString()
    })
  };
}

/**
 * The fantasy board.
 *
 * query {scope, timeRange, seasonId, county, teamId, position, search,
 *        sortBy, sortDir, limit, offset}
 * -> {rows[], columns[], scoring[], meta}
 *
 * Nothing here reads an identity, so nothing user-specific can leak into the
 * shared cache — and nothing user-specific may ever be added to it.
 */
function apiFantasy_(query) {
  const q = fantasyNormalizeQuery_(query);
  q.playerId = '';                    // the board is everybody; one row is below
  return cacheGet_(fantasyCacheKey_(q), FANTASY_CACHE_TTL, function () { return fantasyBuild_(q); });
}

/**
 * One player's card: category, points per, how many, what it came to, total.
 *
 * ONE SIDE of the game, like the board. A two-way player has an offensive
 * total and a defensive total and they are not addends — they are scored on
 * different tables and answer different questions, and a card that summed
 * them would print a number that means nothing and rank him against nobody.
 *
 * The rank travels with it, worked out over the SAME range and side with no
 * position, team or county filter applied — "12th in the conference" has to
 * mean the conference, not twelfth of whatever happened to be on screen.
 */
function apiFantasyPlayer_(playerId, query) {
  const q = fantasyNormalizeQuery_(query);
  q.playerId = s_(playerId);
  if (!q.playerId) throw new Error('Which player?');
  q.position = ''; q.teamId = ''; q.county = ''; q.search = '';

  return cacheGet_(fantasyCacheKey_(q), FANTASY_CACHE_TTL, function () {
    const ctx = fantasyContext_(q);
    const rows = fantasyRows_(q, ctx);
    const me = rows[0] || null;

    /* Everybody, over the same range AND on the same side, so his place is a
       real place: "3rd of 214" has to mean third among the boys scored on the
       table he is being scored on. */
    var rank = null, of = 0;
    if (me) {
      const all = fantasyRows_(Object.assign({}, q, { position: '', teamId: '', county: '', playerId: '' }), ctx)
        .filter(function (r) { return r.fpts !== null; });
      all.sort(fantasySorter_('PTS', 'DESC'));
      of = all.length;
      for (var i = 0; i < all.length; i++) {
        if (all[i].playerId === q.playerId) { rank = i + 1; break; }
      }
    }

    return {
      playerId: q.playerId,
      found: !!me,
      player: me ? me.player : '',
      teamId: me ? me.teamId : '', team: me ? me.team : '',
      positions: me ? me.positions : '', grad: me ? me.grad : '',
      seasons: me ? me.seasons : '', seasonIds: me ? me.seasonIds : [],
      gp: me ? me.gp : null, gpPartial: me ? me.gpPartial : false,
      prov: me ? me.prov : false,
      rows: me ? me.lines : [],
      total: me ? me.fpts : null,
      fppg: me ? me.fppg : null,
      prediction: me ? me.prediction : null, predictionGames: me ? me.predictionGames : 0,
      predictionProvisional: me ? me.predictionProvisional : false,
      rank: rank, of: of,
      scoring: fantasyKey_(q.side),
      meta: Object.assign(fantasyPeriodFields_(q, ctx), {
        scope: 'PLAYER',
        side: q.side, sideLabel: FANTASY_SIDE_LABEL[q.side],
        sides: FANTASY_SIDES.map(function (k) { return { key: k, label: FANTASY_SIDE_LABEL[k] }; }),
        formatLabel: FANTASY_LABEL, formatNote: FANTASY_NOTE,
        timeRange: q.timeRange, seasonId: q.seasonId,
        seasons: ctx.seasons.map(function (id) {
          return { id: id, label: ctx.seasonIdx.byId[id].label };
        }),
        source: ctx.source, generatedAt: new Date().toISOString()
      })
    };
  });
}

/**
 * One defence's card, in the same four columns — with the points-allowed
 * bands spelled out one line per band, so a reader can count the games back.
 */
function apiFantasyTeam_(teamId, query) {
  const q = fantasyNormalizeQuery_(query);
  q.scope = 'TEAM';
  q.playerId = s_(teamId);
  if (!q.playerId) throw new Error('Which team?');
  q.position = ''; q.teamId = ''; q.county = ''; q.search = '';

  return cacheGet_(fantasyCacheKey_(q), FANTASY_CACHE_TTL, function () {
    const ctx = fantasyContext_(q);
    /* Fifteen schools: computing them all and picking one out is cheaper than
       a second code path, and it is what the rank needs anyway. */
    const all = fantasyRows_(Object.assign({}, q, { playerId: '' }), ctx);
    all.sort(fantasySorter_('PTS', 'DESC'));
    var me = null, rank = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].teamId === q.playerId) { me = all[i]; rank = me.fpts === null ? null : i + 1; break; }
    }

    return {
      playerId: q.playerId,
      found: !!me,
      player: me ? me.player : (ctx.teams[q.playerId] ? ctx.teams[q.playerId].name : ''),
      teamId: q.playerId, team: me ? me.team : '',
      positions: '', grad: '',
      seasons: me ? me.seasons : '', seasonIds: me ? me.seasonIds : [],
      gp: me ? me.gp : null, gpPartial: false, prov: me ? me.prov : false,
      pa: me ? me.pa : null,
      rows: me ? me.lines : [],
      total: me ? me.fpts : null,
      fppg: me ? me.fppg : null,
      prediction: me ? me.prediction : null, predictionGames: me ? me.predictionGames : 0,
      predictionProvisional: me ? me.predictionProvisional : false,
      rank: rank, of: all.filter(function (r) { return r.fpts !== null; }).length,
      scoring: fantasyTeamKey_(),
      meta: Object.assign(fantasyPeriodFields_(q, ctx), {
        scope: 'TEAM',
        formatLabel: FANTASY_LABEL, formatNote: FANTASY_NOTE,
        timeRange: q.timeRange, seasonId: q.seasonId,
        seasons: ctx.seasons.map(function (id) {
          return { id: id, label: ctx.seasonIdx.byId[id].label };
        }),
        source: ctx.source, generatedAt: new Date().toISOString()
      })
    };
  });
}
