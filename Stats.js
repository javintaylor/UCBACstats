/**
 * UCBAC Stats — Stats.gs
 *
 * The filterable stats API. One query object in, one rendered-ready table out:
 * rows, a column registry the client renders generically, footer totals, and a
 * meta block that says exactly what the numbers cover.
 *
 * This is the most-used page on the site, so it has to be fast AND it has to be
 * honest. Those pull in opposite directions and every decision below is one or
 * the other:
 *
 *  1. PLAYER scope reads PlayerSeasonStats (341 rows), not PlayerGameStats
 *     (5,069). The season table has already resolved grain precedence per
 *     player-season, so a multi-season total is a sum of resolved rows and can
 *     never double-count a player who has both GAME rows and a SEASON_TOTAL row.
 *  2. TEAM scope has no choice but to read PlayerGameStats — TeamGameStats is
 *     sparse, carries no PointsAllowed and joins by raw team name, so it is not
 *     used here at all. Grain precedence is resolved per player-season FIRST and
 *     the resolved total is then attributed to the team on its own stat rows, so
 *     a mid-season transfer lands on both teams rather than on whichever one the
 *     season table happened to record first.
 *  3. Points, record and games played come from Games and Standings. They cannot
 *     be derived from player stats: PassTD + RushTD + RecTD double-counts every
 *     passing touchdown, and two-point conversions and safeties are not collected.
 *  4. Nothing is hidden and nothing is invented. A range that cannot include a
 *     season says so in meta.seasonsExcluded; a column nobody reported is listed
 *     in meta.emptyColumns; every convention break in the underlying data raises
 *     a string in meta.warnings. A silent omission is a lie the user cannot see.
 *
 * blank != zero, everywhere. A blank input yields a blank output — including in
 * derived columns, where dividing by a blank produces null rather than a 0 that
 * would sort a player who reported nothing to the top of a leaderboard.
 */

const STATS_CACHE_PREFIX = 'stats2:';   // bump the digit to invalidate every key
const STATS_CACHE_TTL    = 900;
const STATS_DEFAULT_LIMIT = 50;
// A page of 100 player rows with every column measured 91,700 characters against
// the live database — close enough to the script cache's 95,000-character ceiling
// that one long name would tip it over, and cacheGet() drops an oversized value
// without a word. 75 leaves the busiest page room to stay cached.
const STATS_MAX_LIMIT     = 75;
const STATS_LAST_N        = 4;

// A rate stat off two carries is noise. Applied only when the caller sorts by a
// rate column and did not ask for a qualifier of their own — a blanket default
// would delete the 52 players whose 2025 season is a season total with no games.
const STATS_RATE_MIN_GAMES = 4;

// MEASURE is the roster's board, not the box score's: who is biggest,
// fastest, strongest — sortable like any stat, no game required.
const STATS_SIDES = ['OFFENSE', 'DEFENSE', 'SPECIAL', 'ALL', 'MEASURE'];

const STATS_TIME_RANGES = [
  { key: 'SEASON', label: 'Single season' },
  { key: 'LAST4',  label: 'Last ' + STATS_LAST_N + ' seasons with data' },
  { key: 'ALL',    label: 'All seasons with data' }
];

/**
 * Every column the Stats page can render, in display order.
 *
 * format drives the client: 'text' | 'int' | 'dec1' | 'dec2' | 'pct1'.
 * derived columns are computed on read and are never stored (CONFIG.DERIVED_FIELDS).
 * rate columns are ratios and per-game figures — the only ones a games-played
 * qualifier is meaningful for.
 *
 * Every non-derived key here is also a member of SUM_FIELDS, which is what lets
 * addInto() do the summing without a second field list to keep in step.
 */
const STATS_FIELDS = [
  // ── offense
  { key: 'PassComp',   label: 'Comp',        side: 'OFFENSE', group: 'Passing',   format: 'int' },
  { key: 'PassAtt',    label: 'Att',         side: 'OFFENSE', group: 'Passing',   format: 'int' },
  { key: 'CompPct',    label: 'Comp%',       side: 'OFFENSE', group: 'Passing',   format: 'pct1', derived: true, rate: true },
  { key: 'PassYds',    label: 'Pass Yds',    side: 'OFFENSE', group: 'Passing',   format: 'int' },
  { key: 'YPA',        label: 'Yds/Att',     side: 'OFFENSE', group: 'Passing',   format: 'dec1', derived: true, rate: true },
  { key: 'PassTD',     label: 'Pass TD',     side: 'OFFENSE', group: 'Passing',   format: 'int' },
  { key: 'PassInt',    label: 'INT Thrown',  side: 'OFFENSE', group: 'Passing',   format: 'int' },
  { key: 'PassYdsPG',  label: 'Pass Yds/G',  side: 'OFFENSE', group: 'Passing',   format: 'dec1', derived: true, rate: true },
  { key: 'NFLRating',  label: 'QB Rtg',      side: 'OFFENSE', group: 'Passing',   format: 'dec1', derived: true, rate: true },
  { key: 'QBRating',   label: 'NCAA Eff',    side: 'OFFENSE', group: 'Passing',   format: 'dec1', derived: true, rate: true },
  { key: 'AYA',        label: 'AY/A',        side: 'OFFENSE', group: 'Passing',   format: 'dec1', derived: true, rate: true },
  { key: 'TDPct',      label: 'TD%',         side: 'OFFENSE', group: 'Passing',   format: 'pct1', derived: true, rate: true },
  { key: 'IntPct',     label: 'INT%',        side: 'OFFENSE', group: 'Passing',   format: 'pct1', derived: true, rate: true },
  { key: 'Pass200G',   label: '200+ Yd G',   side: 'OFFENSE', group: 'Passing',   format: 'int',  playerOnly: true },

  { key: 'RushAtt',    label: 'Car',         side: 'OFFENSE', group: 'Rushing',   format: 'int' },
  { key: 'RushYds',    label: 'Rush Yds',    side: 'OFFENSE', group: 'Rushing',   format: 'int' },
  { key: 'YPC',        label: 'Yds/Car',     side: 'OFFENSE', group: 'Rushing',   format: 'dec1', derived: true, rate: true },
  { key: 'RushTD',     label: 'Rush TD',     side: 'OFFENSE', group: 'Rushing',   format: 'int' },
  { key: 'RushFum',    label: 'Rush Fum',    side: 'OFFENSE', group: 'Rushing',   format: 'int' },
  { key: 'RushYdsPG',  label: 'Rush Yds/G',  side: 'OFFENSE', group: 'Rushing',   format: 'dec1', derived: true, rate: true },
  { key: 'Rush100G',   label: '100+ Yd G',   side: 'OFFENSE', group: 'Rushing',   format: 'int',  playerOnly: true },

  { key: 'Rec',        label: 'Rec',         side: 'OFFENSE', group: 'Receiving', format: 'int' },
  { key: 'RecYds',     label: 'Rec Yds',     side: 'OFFENSE', group: 'Receiving', format: 'int' },
  // CONFIG.DERIVED_FIELDS calls this RecAvg. Same measure, stored under neither
  // name; YPR is what the position pages and the ballot already call it.
  { key: 'YPR',        label: 'Yds/Rec',     side: 'OFFENSE', group: 'Receiving', format: 'dec1', derived: true, rate: true },
  { key: 'RecTD',      label: 'Rec TD',      side: 'OFFENSE', group: 'Receiving', format: 'int' },
  { key: 'RecFum',     label: 'Rec Fum',     side: 'OFFENSE', group: 'Receiving', format: 'int' },
  { key: 'RecYdsPG',   label: 'Rec Yds/G',   side: 'OFFENSE', group: 'Receiving', format: 'dec1', derived: true, rate: true },
  { key: 'Rec100G',    label: '100+ Yd G',   side: 'OFFENSE', group: 'Receiving', format: 'int',  playerOnly: true },

  // the one offensive-line stat the conference records
  { key: 'Pancakes',   label: 'Pancakes',    side: 'OFFENSE', group: 'Blocking',  format: 'int' },

  { key: 'TotalYds',   label: 'Total Yds',   side: 'OFFENSE', group: 'Total',     format: 'int',  derived: true },
  { key: 'TotalTD',    label: 'Total TD',    side: 'OFFENSE', group: 'Total',     format: 'int',  derived: true },
  { key: 'TotalYdsPG', label: 'Total Yds/G', side: 'OFFENSE', group: 'Total',     format: 'dec1', derived: true, rate: true },
  { key: 'ScrimYds',   label: 'Scrim Yds',   side: 'OFFENSE', group: 'Total',     format: 'int',  derived: true },
  { key: 'YdsPerTouch',label: 'Yds/Touch',   side: 'OFFENSE', group: 'Total',     format: 'dec1', derived: true, rate: true },
  { key: 'AllPurpose', label: 'All-Purpose', side: 'OFFENSE', group: 'Total',     format: 'int',  derived: true },

  // ── defense
  { key: 'TackleSolo',   label: 'Solo',      side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'TackleAssist', label: 'Ast',       side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'TacklesTotal', label: 'Tackles',   side: 'DEFENSE', group: 'Defense',   format: 'int',  derived: true },
  { key: 'TacklesPG',    label: 'Tackles/G', side: 'DEFENSE', group: 'Defense',   format: 'dec1', derived: true, rate: true },
  { key: 'TFL',          label: 'TFL',       side: 'DEFENSE', group: 'Defense',   format: 'dec1' },
  { key: 'Sacks',        label: 'Sacks',     side: 'DEFENSE', group: 'Defense',   format: 'dec1' },
  { key: 'Int',          label: 'INT',       side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'PassDef',      label: 'PD',        side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'FF',           label: 'FF',        side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'FR',           label: 'FR',        side: 'DEFENSE', group: 'Defense',   format: 'int' },
  { key: 'DefTD',        label: 'Def TD',    side: 'DEFENSE', group: 'Defense',   format: 'int' },
  // havoc: every play that wrecks an offensive snap, in one number
  { key: 'Havoc',        label: 'Havoc',     side: 'DEFENSE', group: 'Defense',   format: 'dec1', derived: true },
  { key: 'HavocPG',      label: 'Havoc/G',   side: 'DEFENSE', group: 'Defense',   format: 'dec1', derived: true, rate: true },
  { key: 'TOForced',     label: 'TO Forced', side: 'DEFENSE', group: 'Defense',   format: 'int',  derived: true },
  { key: 'TOGiven',      label: 'TO Lost',   side: 'DEFENSE', group: 'Defense',   format: 'int',  derived: true, teamOnly: true },
  { key: 'TOMargin',     label: 'TO Margin', side: 'DEFENSE', group: 'Defense',   format: 'int',  derived: true, teamOnly: true },

  // ── special teams
  { key: 'FGM',        label: 'FGM',         side: 'SPECIAL', group: 'Kicking',   format: 'int' },
  { key: 'FGA',        label: 'FGA',         side: 'SPECIAL', group: 'Kicking',   format: 'int' },
  { key: 'FGPct',      label: 'FG%',         side: 'SPECIAL', group: 'Kicking',   format: 'pct1', derived: true, rate: true },
  { key: 'XPM',        label: 'XPM',         side: 'SPECIAL', group: 'Kicking',   format: 'int' },
  { key: 'XPA',        label: 'XPA',         side: 'SPECIAL', group: 'Kicking',   format: 'int' },
  { key: 'XPPct',      label: 'XP%',         side: 'SPECIAL', group: 'Kicking',   format: 'pct1', derived: true, rate: true },
  { key: 'KickPoints', label: 'Kick Pts',    side: 'SPECIAL', group: 'Kicking',   format: 'int',  derived: true },
  { key: 'Punts',      label: 'Punts',       side: 'SPECIAL', group: 'Punting',   format: 'int' },
  { key: 'PuntYds',    label: 'Punt Yds',    side: 'SPECIAL', group: 'Punting',   format: 'int' },
  { key: 'PuntAvg',    label: 'Punt Avg',    side: 'SPECIAL', group: 'Punting',   format: 'dec1', derived: true, rate: true },
  { key: 'KR',         label: 'KR',          side: 'SPECIAL', group: 'Returns',   format: 'int' },
  { key: 'KRYds',      label: 'KR Yds',      side: 'SPECIAL', group: 'Returns',   format: 'int' },
  { key: 'KRAvg',      label: 'KR Avg',      side: 'SPECIAL', group: 'Returns',   format: 'dec1', derived: true, rate: true },
  { key: 'PR',         label: 'PR',          side: 'SPECIAL', group: 'Returns',   format: 'int' },
  { key: 'PRYds',      label: 'PR Yds',      side: 'SPECIAL', group: 'Returns',   format: 'int' },
  { key: 'PRAvg',      label: 'PR Avg',      side: 'SPECIAL', group: 'Returns',   format: 'dec1', derived: true, rate: true },
  // a punt, a field goal or an extra point stopped at the line
  { key: 'Blocks',     label: 'Blk',         side: 'SPECIAL', group: 'Returns',   format: 'int' },

  { key: 'BlockedPunts', label: 'Blocked punts', side: 'SPECIAL', group: 'Blocks', format: 'int' },
  { key: 'TwoPointConversions', label: '2PT made', side: 'OFFENSE', group: 'Conversions', format: 'int' },

  // ── measurables (side MEASURE) — from the roster, keys are the sheet columns.
  // `asc` marks lower-is-better: a 40 sorts fastest first by default.
  // stored in inches, sorted in inches, printed as feet and inches (6′1″)
  { key: 'HeightInches', label: 'Ht',           side: 'MEASURE', group: 'Measurables', format: 'ftin' },
  { key: 'WeightLbs',    label: 'Wt (lbs)',     side: 'MEASURE', group: 'Measurables', format: 'int' },
  { key: 'GPA',          label: 'GPA',          side: 'MEASURE', group: 'Measurables', format: 'dec2' },
  { key: 'Forty',        label: '40 (sec)',     side: 'MEASURE', group: 'Measurables', format: 'dec2', asc: true },
  { key: 'Bench',        label: 'Bench (lbs)',  side: 'MEASURE', group: 'Measurables', format: 'int' },
  { key: 'Squat',        label: 'Squat (lbs)',  side: 'MEASURE', group: 'Measurables', format: 'int' },
  { key: 'Clean',        label: 'Clean (lbs)',  side: 'MEASURE', group: 'Measurables', format: 'int' },
  { key: 'Vertical',     label: 'Vert (in)',    side: 'MEASURE', group: 'Measurables', format: 'dec1' },
  { key: 'Shuttle',      label: '5-10-5 (sec)', side: 'MEASURE', group: 'Measurables', format: 'dec2', asc: true }
];

/**
 * Identity columns - who the row is. Games played and county remain available
 * to the query and derivation layers, but the compact public table omits them.
 * Graduation year rides beside the player's name (the '27 after it), so it is
 * not a column of its own; it still travels on every row for whoever asks.
 *
 * hideWhen        drop the column when that filter is already pinned.
 * multiSeasonOnly drop the column when the range is a single season.
 */
const STATS_IDENTITY = {
  PLAYER: [
    { key: 'player',    label: 'Player',  side: 'ID', group: 'Player', format: 'text' },
    { key: 'team',      label: 'Team',    side: 'ID', group: 'Player', format: 'text', hideWhen: 'teamId' },
    { key: 'positions', label: 'Pos',     side: 'ID', group: 'Player', format: 'text' },
    { key: 'seasons',   label: 'Seasons', side: 'ID', group: 'Player', format: 'text', multiSeasonOnly: true }
  ],
  TEAM: [
    { key: 'team',          label: 'Team',    side: 'ID', group: 'Team',   format: 'text' },
    { key: 'seasons',       label: 'Seasons', side: 'ID', group: 'Team',   format: 'text', multiSeasonOnly: true },
    { key: 'boxGames',      label: 'Box',     side: 'ID', group: 'Team',   format: 'int' },
    // W/L/T are stored and returned as three atoms. A "W-L" string is never
    // built anywhere near a sheet: Sheets coerces "11-1" into a duration and
    // eats the record, which is what destroyed the 2023 rows in the source
    // workbook. The client formats them for display.
    { key: 'w',             label: 'W',       side: 'ID', group: 'Record', format: 'int' },
    { key: 'l',             label: 'L',       side: 'ID', group: 'Record', format: 'int' },
    { key: 't',             label: 'T',       side: 'ID', group: 'Record', format: 'int' },
    { key: 'PointsScored',  label: 'PF',      side: 'ID', group: 'Record', format: 'int' },
    { key: 'PointsAllowed', label: 'PA',      side: 'ID', group: 'Record', format: 'int' },
    { key: 'PointDiff',     label: 'Diff',    side: 'ID', group: 'Record', format: 'int', derived: true }
  ]
};

const STATS_DEFAULT_SORT = {
  PLAYER: { OFFENSE: 'TotalYds', DEFENSE: 'TacklesTotal', SPECIAL: 'FGM', ALL: 'TotalYds',
            MEASURE: 'Forty' },
  TEAM:   { OFFENSE: 'TotalYds', DEFENSE: 'TacklesTotal', SPECIAL: 'FGM', ALL: 'PointsScored',
            MEASURE: 'PointsScored' }
};

// ── blank-preserving arithmetic ─────────────────────────────────────────────
// Every one of these returns null rather than 0 when an input is missing. That
// is the whole reason they exist: a 0 in a stats table is a claim that someone
// tried and failed, and we are not entitled to make it on a coach's behalf.

/** Sum, skipping blanks. Blank only when every input is blank. */
function statsSum_(list) {
  var total = null;
  for (var i = 0; i < list.length; i++) {
    var v = numOrNull_(list[i]);
    if (v === null) continue;
    total = (total === null ? 0 : total) + v;
  }
  return total;
}

function statsHalf_(v) { var n = numOrNull_(v); return n === null ? null : n / 2; }

/** a / b, blank when either side is blank or the denominator is not positive. */
function statsDiv_(a, b) {
  var x = numOrNull_(a), y = numOrNull_(b);
  if (x === null || y === null || y <= 0) return null;
  return x / y;
}

function statsPct_(a, b) {
  var r = statsDiv_(a, b);
  return r === null ? null : r * 100;
}

function statsRound_(v, format) {
  if (v === null || v === undefined || typeof v !== 'number' || isNaN(v)) return v;
  if (format === 'dec2') return Math.round(v * 100) / 100;
  if (format === 'dec1' || format === 'pct1') return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;    // 'int' — sums are whole, this kills float dust
}

/**
 * Does what this player recorded look like the position being filtered on?
 *
 * Used only for players whose roster row names no position at all. It reads
 * opportunity, never talent: a quarterback is someone who threw, a corner is
 * someone who defended passes. The thresholds are deliberately low, because the
 * question is "did he play here", not "was he good here" — the leaderboard
 * answers the second one on its own.
 */
function statsProfileFits_(sums, position) {
  const v = function (k) { return numOrNull_(sums[k]) || 0; };
  const major = majorOf_(position);
  const tackles = v('TackleSolo') + v('TackleAssist');
  const front = v('TFL') + v('Sacks');
  const cover = v('PassDef') + v('Int');

  switch (major) {
    case 'QB':  return v('PassAtt') >= 20;
    case 'RB':  return v('RushAtt') >= 20 && v('RushAtt') >= v('Rec');
    case 'WR':
    case 'TE':  return v('Rec') >= 8;
    case 'ATH': return (v('RushAtt') >= 15 && v('Rec') >= 8) ||
                       (v('PassAtt') >= 10 && v('RushAtt') >= 15);
    case 'LB':  return tackles >= 15;
    case 'DL':  return front >= 4 || (tackles >= 10 && cover === 0);
    case 'DB':  return cover >= 3 || (tackles >= 10 && front === 0);
    // Offensive line and special teams leave no box-score trace to infer from,
    // so a missing position cannot be filled in for them.
    default:    return false;
  }
}

// ── column assembly ─────────────────────────────────────────────────────────

function statsFieldsFor_(side) {
  if (side === 'MEASURE')
    return STATS_FIELDS.filter(function (f) { return f.side === 'MEASURE'; });
  /* What a defence gives up is what an offence produced, so the allowed board
     is built from the OFFENSIVE columns — read as "against them" rather than
     "by them". */
  if (side === 'ALLOWED')
    return STATS_FIELDS.filter(function (f) {
      return f.side === 'OFFENSE' && !f.playerOnly;
    });
  return STATS_FIELDS.filter(function (f) {
    return f.side !== 'MEASURE' && (side === 'ALL' || f.side === side);
  });
}

function statsPublicColumn_(f) {
  return { key: f.key, label: f.label, side: f.side, group: f.group,
           numeric: f.format !== 'text', derived: !!f.derived,
           // asc: lower is better (a 40 time), so the client opens it ascending
           rate: !!f.rate, asc: !!f.asc, format: f.format };
}

/**
 * The columns this particular query returns, identity first.
 * `ctx` may be null — during query normalization only the key set matters.
 */
/**
 * Which statistic groups matter most at a position, best first.
 *
 * Filtering to quarterbacks and then reading Comp, Att, Comp% across the screen
 * before reaching passing yards makes the table work against the question that
 * was just asked. Groups not listed keep their natural order behind these.
 */
const STATS_POSITION_PRIORITY = {
  QB:  ['Passing', 'Rushing', 'Total'],
  RB:  ['Rushing', 'Receiving', 'Total'],
  WR:  ['Receiving', 'Rushing', 'Total'],
  TE:  ['Receiving', 'Total'],
  ATH: ['Total', 'Rushing', 'Receiving', 'Passing'],
  LB:  ['Defense'],
  DL:  ['Defense'],
  DB:  ['Defense'],
  OL:  [],
  K:   ['Kicking'], P: ['Punting'], RET: ['Returns']
};

/** The side a position plays, so a position filter implies its column set. */
function statsSideForPosition_(position) {
  const p = POS_BY_CODE[String(position || '').toUpperCase()];
  if (!p) return '';
  if (p.side === 'OFF') return 'OFFENSE';
  if (p.side === 'DEF') return 'DEFENSE';
  if (p.side === 'ST') return 'SPECIAL';
  return '';
}

/**
 * The columns this particular query returns, identity first.
 * `ctx` may be null — during query normalization only the key set matters.
 */
function statsColumns_(scope, side, q, ctx) {
  /* The allowed board is asked for as Defense, and shows the columns of an
     offence: it is the other side's line. The flag has to reach the column
     picker or the table comes back with tackles and sacks in it. */
  if (q && q.allowed) side = 'ALLOWED';
  const multi = ctx ? ctx.seasons.length > 1 : true;
  const ident = STATS_IDENTITY[scope].filter(function (f) {
    if (f.hideWhen && q && q[f.hideWhen]) return false;
    if (f.multiSeasonOnly && !multi) return false;
    // games played means nothing on the measurables board: a forty time is not
    // earned per game, and the column would be blank for everyone
    if (f.key === 'gp' && side === 'MEASURE') return false;
    return true;
  });

  var fields = statsFieldsFor_(side).filter(function (f) {
    // milestone-game counts exist only where player game rows do, and a
    // turnover margin is a team fact — each scope shows only what it can mean
    if (f.playerOnly && scope === 'TEAM') return false;
    if (f.teamOnly && scope === 'PLAYER') return false;
    return true;
  });

  const position = q && q.position ? String(q.position).toUpperCase() : '';
  if (position) {
    const order = STATS_POSITION_PRIORITY[majorOf_(position)] || [];
    if (order.length) {
      // stable sort: listed groups first in the order given, everything else
      // afterwards in the order the field table already declares
      const rank = {};
      order.forEach(function (gname, i) { rank[gname] = i; });
      fields = fields.map(function (f, i) { return { f: f, i: i }; })
        .sort(function (a, b) {
          const ra = rank[a.f.group] === undefined ? order.length : rank[a.f.group];
          const rb = rank[b.f.group] === undefined ? order.length : rank[b.f.group];
          return ra - rb || a.i - b.i;
        })
        .map(function (x) { return x.f; });
    }
  }

  return ident.concat(fields).map(statsPublicColumn_);
}

/** Every key a caller may sort by, whether or not this query displays it. */
function statsSortableKeys_(scope, side) {
  const keys = {};
  STATS_IDENTITY[scope].forEach(function (f) { keys[f.key] = f; });
  statsFieldsFor_(side).forEach(function (f) { keys[f.key] = f; });
  return keys;
}

// ── seasons and teams ───────────────────────────────────────────────────────

/** SeasonID -> {id, year, label, status, tackleConvention}, plus newest-first order. */
function statsSeasonIndex_() {
  const byId = {}, order = [];
  rowsOf_(CONFIG.TABS.SEASONS).forEach(function (r) {
    var id = s_(r.SeasonID);
    if (!id || byId[id]) return;
    byId[id] = { id: id, year: num_(r.Year), label: s_(r.Label) || id,
                 status: s_(r.Status), tackleConvention: s_(r.TackleConvention) };
    order.push(id);
  });
  order.sort(function (a, b) { return (byId[b].year || 0) - (byId[a].year || 0); });
  return { byId: byId, newestFirst: order };
}

var __statsSeasonRows = null;

/**
 * The player-season table, already grain-resolved.
 *
 * Falls back to computing it in memory when the derived layer has never been
 * built on this workbook. That costs a full PlayerGameStats read, so the fact is
 * reported in meta.source rather than left to look like a fast path.
 */
function statsSeasonSource_() {
  if (__statsSeasonRows) return __statsSeasonRows;
  if (hasTab_('PlayerSeasonStats')) {
    __statsSeasonRows = { rows: rowsOf_('PlayerSeasonStats'), source: 'PlayerSeasonStats' };
  } else {
    __statsSeasonRows = { rows: computePlayerSeasonStats_(), source: 'computed' };
  }
  return __statsSeasonRows;
}

/**
 * Seasons that can answer a query at all.
 *
 * PLAYER needs player statistics. TEAM also counts a season with scored games,
 * because points and record stand on their own even where no box score was ever
 * filed. A season on the schedule with neither — SEA-2026 today — belongs in
 * neither set, and saying so is the whole point.
 */
function statsSeasonsWithData_(scope, side) {
  const out = {};
  statsSeasonSource_().rows.forEach(function (r) {
    var sid = s_(r.SeasonID);
    if (sid) out[sid] = true;
  });
  // The measurables board runs on ROSTERS: a preseason with seats but no
  // stats filed is exactly when people want to compare forties.
  if (side === 'MEASURE') {
    rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
      var sid = s_(r.SeasonID);
      if (sid) out[sid] = true;
    });
  }
  if (scope === 'TEAM') {
    rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
      if (numOrNull_(g.HomeScore) === null || numOrNull_(g.AwayScore) === null) return;
      var sid = s_(g.SeasonID);
      if (sid) out[sid] = true;
    });
  }
  return out;
}

/** TeamID -> {id, name, county}. Only the Teams tab — never a raw opponent name. */
function statsTeamIndex_() {
  const out = {};
  rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
    var id = s_(t.TeamID);
    if (!id) return;
    out[id] = { id: id, name: s_(t.DisplayName) || s_(t.SchoolName) || id, county: s_(t.County) };
  });
  return out;
}

/**
 * Which seasons a time range actually covers, and why each other one is out.
 *
 * A range is only ever narrowed to seasons that hold data. "Last 4 years"
 * silently spanning a season with nothing in it would read as a four-year total
 * while being a two-year total.
 */
function statsResolveSeasons_(q, sIdx, withData) {
  const ordered = sIdx.newestFirst.filter(function (id) { return withData[id]; });
  var picked;
  if (q.timeRange === 'ALL')        picked = ordered.slice();
  else if (q.timeRange === 'LAST4') picked = ordered.slice(0, STATS_LAST_N);
  else                              picked = withData[q.seasonId] ? [q.seasonId] : [];

  const inPicked = {};
  picked.forEach(function (id) { inPicked[id] = true; });

  const excluded = [];
  if (q.timeRange === 'SEASON' && !sIdx.byId[q.seasonId]) {
    excluded.push({ id: q.seasonId, label: q.seasonId,
                    reason: 'not a season in this database' });
  }
  sIdx.newestFirst.forEach(function (id) {
    if (inPicked[id]) return;
    var reason;
    if (!withData[id]) reason = 'no statistics recorded yet';
    else if (q.timeRange === 'SEASON') reason = 'not the selected season';
    else reason = 'older than the ' + STATS_LAST_N + ' most recent seasons with data';
    excluded.push({ id: id, label: sIdx.byId[id].label, reason: reason });
  });
  return { seasons: picked, inRange: inPicked, excluded: excluded };
}

// ── derived columns ─────────────────────────────────────────────────────────

/**
 * Compute every derived column on a row from the atoms already on it.
 *
 * A derived value is blank whenever an input is blank or a denominator is not
 * positive. Per-game columns additionally go blank when games played is unknown
 * or only partly known — a season total carries no game count, and dividing a
 * two-season total by the one season that reported games inflates the rate by
 * roughly double.
 */
function statsDerive_(row, allowPerGame) {
  row.CompPct = statsPct_(row.PassComp, row.PassAtt);
  row.YPA     = statsDiv_(row.PassYds, row.PassAtt);
  row.YPC     = statsDiv_(row.RushYds, row.RushAtt);
  row.YPR     = statsDiv_(row.RecYds, row.Rec);

  row.TotalYds = statsSum_([row.PassYds, row.RushYds, row.RecYds]);
  row.TotalTD  = statsSum_([row.PassTD, row.RushTD, row.RecTD]);
  /* Total tackles = solo + assists, the way the conference counts them and
     the way every coach's season sheet reads. The half-assist weighting that
     used to live here made Aaron Dixon's 78 (26 solo + 52 assists) print as
     52 and dropped him twenty places — "missing" without being absent. The
     All-Conference formula counts them the same way now (AC-1.1), so a
     published total and a ranking no longer disagree about what a tackle is. */
  row.TacklesTotal = statsSum_([row.TackleSolo, row.TackleAssist]);

  row.FGPct   = statsPct_(row.FGM, row.FGA);
  row.XPPct   = statsPct_(row.XPM, row.XPA);
  row.PuntAvg = statsDiv_(row.PuntYds, row.Punts);

  /* ── one-number ratings and rollups, every one from atoms already summed ──
     Blank attempts mean no rating, never a zero rating. Inside the formulas a
     blank companion stat (a season sheet that never listed INTs) counts as 0 —
     the alternative is refusing to rate half the conference. */
  const att = numOrNull_(row.PassAtt);
  if (att) {
    const pc = numOrNull_(row.PassComp) || 0, py2 = numOrNull_(row.PassYds) || 0,
          ptd = numOrNull_(row.PassTD) || 0, pint = numOrNull_(row.PassInt) || 0;
    /* Two ratings that disagree loudly on the same line — 7 of 15 for 126 and a
       touchdown is 98.2 one way and 139.2 the other — so each is labelled for
       what it is rather than one of them for "rating". QB Rtg is the 0–158.3
       NFL formula, which is what MaxPreps prints as QB Rate and therefore the
       number a coach already has in front of him; NCAA Eff is passing
       efficiency, where about 180 is elite. */
    row.QBRating = (8.4 * py2 + 330 * ptd + 100 * pc - 200 * pint) / att;
    const clamp = function (v) { return Math.max(0, Math.min(2.375, v)); };
    row.NFLRating = (clamp((pc / att - 0.3) * 5) + clamp((py2 / att - 3) * 0.25) +
                     clamp((ptd / att) * 20) + clamp(2.375 - (pint / att) * 25)) / 6 * 100;
    // adjusted yards per attempt: a TD is worth 20 yards, an INT costs 45
    row.AYA    = (py2 + 20 * ptd - 45 * pint) / att;
    row.TDPct  = 100 * ptd / att;
    row.IntPct = 100 * pint / att;
  } else {
    row.QBRating = row.NFLRating = row.AYA = row.TDPct = row.IntPct = null;
  }
  row.ScrimYds    = statsSum_([row.RushYds, row.RecYds]);
  row.Touches     = statsSum_([row.RushAtt, row.Rec]);
  row.YdsPerTouch = statsDiv_(row.ScrimYds, row.Touches);
  row.AllPurpose  = statsSum_([row.RushYds, row.RecYds, row.KRYds, row.PRYds]);
  row.Havoc       = statsSum_([row.TFL, row.Sacks, row.FF, row.Int, row.PassDef]);
  row.TOForced    = statsSum_([row.Int, row.FR]);
  row.TOGiven     = statsSum_([row.PassInt, row.RushFum, row.RecFum]);
  row.TOMargin    = (row.TOForced === null && row.TOGiven === null) ? null
                    : (row.TOForced || 0) - (row.TOGiven || 0);
  row.KickPoints  = (numOrNull_(row.FGM) === null && numOrNull_(row.XPM) === null) ? null
                    : 3 * (numOrNull_(row.FGM) || 0) + (numOrNull_(row.XPM) || 0);
  row.KRAvg = statsDiv_(row.KRYds, row.KR);
  row.PRAvg = statsDiv_(row.PRYds, row.PR);

  const gp = (allowPerGame && row.gpPartial !== true) ? numOrNull_(row.gp) : null;
  row.PassYdsPG  = statsDiv_(row.PassYds, gp);
  row.RushYdsPG  = statsDiv_(row.RushYds, gp);
  row.RecYdsPG   = statsDiv_(row.RecYds, gp);
  row.TotalYdsPG = statsDiv_(row.TotalYds, gp);
  row.TacklesPG  = statsDiv_(row.TacklesTotal, gp);
  row.HavocPG    = statsDiv_(row.Havoc, gp);
  return row;
}

/** Copy the summed atoms onto a row, blank where nothing was ever reported. */
function statsEmitSums_(row, sums) {
  for (var i = 0; i < SUM_FIELDS.length; i++) {
    var f = SUM_FIELDS[i];
    row[f] = (sums[f] === undefined) ? null : sums[f];
  }
  return row;
}

/**
 * Trim a working row down to what this query returns.
 *
 * Rows are built with every atom and every derived column on them because the
 * derivations reference each other. Shipping all of that when the caller asked
 * for one side would triple the payload and push it past the 95,000-character
 * script-cache limit, which fails silently. The identity and honesty fields
 * outside the column list are kept deliberately: the client needs them for links
 * and for saying how complete a row is.
 */
function statsProject_(row, keys) {
  const keep = ['playerId', 'teamId', 'seasonIds', 'gpPartial', 'partial', 'teamCount', 'count'];
  const out = {};
  keys.forEach(function (k) { out[k] = (row[k] === undefined) ? null : row[k]; });
  keep.forEach(function (k) { if (row[k] !== undefined) out[k] = row[k]; });
  return out;
}

function statsGrainLabel_(grains) {
  const g = !!grains[CONFIG.GRAIN.GAME], t = !!grains[CONFIG.GRAIN.SEASON_TOTAL];
  if (g && t) return 'MIXED';
  if (g) return CONFIG.GRAIN.GAME;
  if (t) return CONFIG.GRAIN.SEASON_TOTAL;
  return '';
}

// ── PLAYER scope ────────────────────────────────────────────────────────────

/**
 * One row per player, summed across every season in range.
 *
 * Filters are applied to the SEASON row, not to the player: a Cecil filter over
 * a player who transferred out of the county returns only the seasons he played
 * there. Aggregating his whole career under a county he left would be wrong in
 * the one direction nobody would ever check.
 */
function statsPlayerRows_(q, ctx) {
  const src = statsSeasonSource_();
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });

  // Positions are a per-season roster attribute, so they gate per season too.
  // GradYear is career identity data. The Players tab is authoritative, with a
  // PlayerSeasons value retained as a fallback for older or partially migrated
  // records.
  const posOf = {}, posFiled = {}, posTotal = {}, gradOf = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    var sid = s_(r.SeasonID), pid = s_(r.PlayerID), grad = s_(r.GradYear);
    if (pid && grad && !gradOf[pid]) gradOf[pid] = grad;
    if (!ctx.inRange[sid]) return;
    var codes = parsePositions_(r.Positions);
    posOf[pid + '|' + sid] = codes;
    posTotal[sid] = (posTotal[sid] || 0) + 1;
    if (codes.length) posFiled[sid] = (posFiled[sid] || 0) + 1;
  });
  ctx.positionCoverage = ctx.seasons.map(function (sid) {
    return { seasonId: sid, label: ctx.seasonIdx.byId[sid].label,
             filed: posFiled[sid] || 0, roster: posTotal[sid] || 0 };
  });

  const acc = {};
  src.rows.forEach(function (r) {
    var pid = s_(r.PlayerID), sid = s_(r.SeasonID);
    if (!pid || !ctx.inRange[sid]) return;

    var tid = s_(r.TeamID);
    var team = ctx.teams[tid];
    if (q.teamId && tid !== q.teamId) return;
    if (q.county && (!team || team.county !== q.county)) return;

    var codes = posOf[pid + '|' + sid] || [];
    var posUnknown = false;
    if (q.position) {
      // positionMatches is hierarchical: LB admits ILB and OLB, DL admits DT,
      // NG and Edge. A player carrying a position that does not match is out.
      // A player carrying NO position is held back and judged on what he
      // actually did — a back with 140 carries and nothing on his roster row is
      // still a running back, and dropping him would make the leaderboard a
      // measure of paperwork rather than production.
      if (!positionMatches_(codes, q.position)) {
        if (codes.length) return;
        posUnknown = true;
      }
    }

    var b = acc[pid];
    if (!b) {
      b = acc[pid] = { playerId: pid, sums: {}, gp: null, gpMissing: 0,
                       seasons: [], teams: {}, grains: {}, positions: {},
                       newest: '', newestTeam: '', posUnknown: false, prov: false };
    }
    // one unapproved player-entered game in any summed season greys the total
    if (s_(r.Provisional) === 'TRUE') b.prov = true;
    addInto_(b.sums, r);

    var gp = numOrNull_(r.GamesPlayed);
    if (gp === null) b.gpMissing++;
    else b.gp = (b.gp === null ? 0 : b.gp) + gp;

    if (b.seasons.indexOf(sid) < 0) b.seasons.push(sid);
    if (tid) b.teams[tid] = true;
    var grain = s_(r.SourceGrain);
    if (grain) b.grains[grain] = true;
    codes.forEach(function (c) { b.positions[c] = true; });
    // one season with a matching position settles it; only a player who never
    // had one falls through to the stat-profile test below
    if (posUnknown) { if (!b.positionConfirmed) b.posUnknown = true; }
    else if (q.position) { b.posUnknown = false; b.positionConfirmed = true; }
    if (sid > b.newest) { b.newest = sid; b.newestTeam = tid; }
  });

  const out = [];
  var inferred = 0;    // included on stat profile alone; reported in meta
  Object.keys(acc).forEach(function (pid) {
    var b = acc[pid];
    // Held back above because his roster row named no position: keep him only if
    // what he actually recorded belongs to the position being filtered on.
    if (b.posUnknown) {
      if (!statsProfileFits_(b.sums, q.position)) return;
      inferred++;
    }
    var p = players[pid] || {};
    var team = ctx.teams[b.newestTeam] || null;
    var seasons = b.seasons.slice().sort().reverse();

    var row = {
      playerId: pid,
      player: s_(p.DisplayName) || pid,
      teamId: b.newestTeam,
      team: team ? team.name : b.newestTeam,
      county: team ? team.county : '',
      grad: s_(p.GradYear) || gradOf[pid] || '',
      teamCount: Object.keys(b.teams).length,
      positions: formatPositions_(statsPositionsForSide_(statsOrderedCodes_(b.positions), q.side)),
      seasonIds: seasons,
      seasons: seasons.map(function (id) { return ctx.seasonIdx.byId[id].label; }).join(', '),
      gp: b.gp,
      // A total assembled from a season that never filed a game count is a
      // floor, not a count, and every per-game rate built on it would be wrong.
      gpPartial: b.gpMissing > 0,
      prov: !!b.prov,
      grain: statsGrainLabel_(b.grains)
    };
    statsEmitSums_(row, b.sums);
    out.push(statsDerive_(row, true));
  });
  ctx.inferredPositions = inferred;
  return out;
}

// ── TEAM scope ──────────────────────────────────────────────────────────────

/**
 * One row per conference team, summed across every season in range.
 *
 * Two independent halves. Points, record and games played come from Games and
 * Standings, restricted to the fifteen TeamIDs on the Teams tab — Games also
 * carries forty-five non-conference opponents stored as raw names, and grouping
 * over it naively invents forty-five teams. Volume statistics come from
 * PlayerGameStats with grain resolved per player-season before anything is
 * attributed to a team, so a player holding both GAME rows and a SEASON_TOTAL
 * row contributes once.
 */
function statsTeamRows_(q, ctx) {
  const acc = {};
  function bucket(tid) {
    if (!ctx.teams[tid]) return null;                 // conference members only
    var b = acc[tid];
    if (!b) {
      b = acc[tid] = { teamId: tid, sums: {}, pf: null, pa: null, gp: 0,
                       seasons: {}, boxGames: {}, grains: {},
                       bySeason: {}, gameSeasons: {},
                       w: null, l: null, t: null };
    }
    return b;
  }

  // points, games played, record
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    var sid = s_(g.SeasonID);
    if (!ctx.inRange[sid]) return;
    var hs = numOrNull_(g.HomeScore), as = numOrNull_(g.AwayScore);
    if (hs === null || as === null) return;           // unplayed contributes nothing
    [[s_(g.HomeTeamID), hs, as], [s_(g.AwayTeamID), as, hs]].forEach(function (persp) {
      var b = bucket(persp[0]);
      if (!b) return;
      b.pf = (b.pf === null ? 0 : b.pf) + persp[1];
      b.pa = (b.pa === null ? 0 : b.pa) + persp[2];
      b.gp++;
      b.seasons[sid] = true;
      b.gameSeasons[sid] = true;
    });
  });

  if (hasTab_('Standings')) {
    // Read the tab rather than apiStandings(), which collapses a blank W/L/T to
    // zero. A team with no standings row has no record, not a 0-0-0 record.
    rowsOf_('Standings').forEach(function (r) {
      var sid = s_(r.SeasonID);
      if (!ctx.inRange[sid]) return;
      var b = bucket(s_(r.TeamID));
      if (!b) return;
      b.w = statsSum_([b.w, r.W]);
      b.l = statsSum_([b.l, r.L]);
      b.t = statsSum_([b.t, r.T]);
      // A season present only as a standings record — 2023 has no game rows —
      // plays its record: games played is W+L+T, and points come from the
      // standings row where reported. Blank stays blank.
      if (!b.gameSeasons[sid]) {
        var played = statsSum_([r.W, r.L, r.T]);
        if (played !== null) { b.gp += played; b.seasons[sid] = true; }
        var pf = numOrNull_(r.PF), pa = numOrNull_(r.PA);
        if (pf !== null) b.pf = (b.pf === null ? 0 : b.pf) + pf;
        if (pa !== null) b.pa = (b.pa === null ? 0 : b.pa) + pa;
      }
    });
  }

  // volume statistics, grain resolved per player-season first
  const pacc = {};
  var unresolved = 0, rowIdx = 0;
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    rowIdx++;
    var sid = s_(r.SeasonID);
    if (!ctx.inRange[sid]) return;
    var grain = s_(r.grain || r.Grain);
    if (grain !== CONFIG.GRAIN.GAME && grain !== CONFIG.GRAIN.SEASON_TOTAL) return;
    var tid = s_(r.TeamID);
    if (!ctx.teams[tid]) return;

    // Thirty percent of stat rows never resolved to a PlayerID. The production is
    // still the team's, so it is kept and keyed on the raw name — dropping it
    // would understate every team that had an import miss.
    var pid = s_(r.PlayerID);
    if (!pid) {
      unresolved++;
      pid = s_(r.player_raw) ? '~raw:' + s_(r.player_raw).toLowerCase() : '~row:' + rowIdx;
    }

    var key = pid + '|' + sid;
    var b = pacc[key];
    if (!b) b = pacc[key] = { seasonId: sid, game: {}, season: {}, gameIds: {},
                              hasGame: false, provTeams: {} };
    if (grain === CONFIG.GRAIN.GAME) {
      b.hasGame = true;
      if (provisionalSource_(r.SourceType)) b.provTeams[tid] = true;
      if (!b.game[tid]) b.game[tid] = {};
      addInto_(b.game[tid], r);
      var gid = s_(r.GameID);
      if (gid) {
        if (!b.gameIds[tid]) b.gameIds[tid] = {};
        b.gameIds[tid][gid] = true;
      }
    } else {
      if (!b.season[tid]) b.season[tid] = {};
      addInto_(b.season[tid], r);
    }
  });

  Object.keys(pacc).forEach(function (key) {
    var p = pacc[key];
    var use = p.hasGame ? p.game : p.season;
    var grain = p.hasGame ? CONFIG.GRAIN.GAME : CONFIG.GRAIN.SEASON_TOTAL;
    Object.keys(use).forEach(function (tid) {
      var b = bucket(tid);
      if (!b) return;
      var sums = use[tid];
      if (!Object.keys(sums).length) return;          // present but nothing reported
      var perS = b.bySeason[p.seasonId] || (b.bySeason[p.seasonId] = {});
      SUM_FIELDS.forEach(function (f) {
        if (sums[f] === undefined) return;
        b.sums[f] = (b.sums[f] === undefined ? 0 : b.sums[f]) + sums[f];
        perS[f] = (perS[f] === undefined ? 0 : perS[f]) + sums[f];
      });
      b.grains[grain] = true;
      b.seasons[p.seasonId] = true;
      if (p.hasGame && p.provTeams[tid]) b.prov = true;
      if (p.hasGame && p.gameIds[tid]) {
        Object.keys(p.gameIds[tid]).forEach(function (gid) { b.boxGames[gid] = true; });
      }
    });
  });

  // Team-level season totals. 2023 exists only as aggregates on the
  // TeamSeasons tab — no games, no box scores, and player rows that cover
  // only each leaderboard's top names. Where TeamSeasons reports a stat for
  // a season in range it replaces the player-derived sum for that team and
  // season: the player rows are a floor, the team sheet is the total. A stat
  // TeamSeasons does not report keeps whatever the player rows added up to.
  if (hasTab_(CONFIG.TABS.TEAM_SEASONS)) {
    const TS_FIELDS = { RushAtt: 'RushAtt', RushYds: 'RushYds', RushTD: 'RushTD',
                        PassAtt: 'PassAtt', PassComp: 'PassComp', PassYds: 'PassYds',
                        PassTD: 'PassTD', DefTFL: 'TFL', DefSacks: 'Sacks',
                        DefInt: 'Int', DefFF: 'FF', DefFR: 'FR' };
    rowsOf_(CONFIG.TABS.TEAM_SEASONS).forEach(function (r) {
      var sid = s_(r.SeasonID);
      if (!ctx.inRange[sid]) return;
      var b = bucket(s_(r.TeamID));
      if (!b) return;
      var perS = b.bySeason[sid] || {};
      var touched = false;
      Object.keys(TS_FIELDS).forEach(function (src) {
        var v = numOrNull_(r[src]);
        if (v === null) return;
        var f = TS_FIELDS[src];
        b.sums[f] = (b.sums[f] === undefined ? 0 : b.sums[f]) - (perS[f] || 0) + v;
        touched = true;
      });
      // Tackles arrive as one total; the player atoms are solo and assist.
      // Carry the difference and fold it into TacklesTotal after derivation.
      var tk = numOrNull_(r.DefTackles);
      if (tk !== null) {
        b.extraTackles = (b.extraTackles || 0) + tk -
                         (perS.TackleSolo || 0) - (perS.TackleAssist || 0);
        touched = true;
      }
      if (touched) {
        b.grains[CONFIG.GRAIN.SEASON_TOTAL] = true;
        b.seasons[sid] = true;
      }
    });
  }

  ctx.unresolvedStatRows = unresolved;

  const out = [];
  Object.keys(acc).forEach(function (tid) {
    var b = acc[tid];
    var t = ctx.teams[tid];
    if (q.county && t.county !== q.county) return;
    if (q.teamId && tid !== q.teamId) return;

    var seasons = Object.keys(b.seasons).filter(function (id) { return ctx.inRange[id]; }).sort().reverse();
    var box = Object.keys(b.boxGames).length;
    var row = {
      teamId: tid, team: t.name, county: t.county,
      seasonIds: seasons,
      seasons: seasons.map(function (id) { return ctx.seasonIdx.byId[id].label; }).join(', '),
      gp: b.gp || null,
      boxGames: box,
      w: b.w, l: b.l, t: b.t,
      PointsScored: b.pf, PointsAllowed: b.pa,
      PointDiff: (b.pf === null || b.pa === null) ? null : b.pf - b.pa,
      grain: statsGrainLabel_(b.grains),
      gpPartial: false,
      prov: !!b.prov,
      // Box scores exist for only part of 2025. A team missing games has a
      // volume total that is a floor; the flag is what lets the client say so.
      partial: !!b.grains[CONFIG.GRAIN.GAME] && b.gp > 0 && box < b.gp
    };
    statsEmitSums_(row, b.sums);
    statsDerive_(row, true);
    if (b.extraTackles) {
      row.TacklesTotal = statsSum_([row.TacklesTotal, b.extraTackles]);
      var tgp = (row.gpPartial !== true) ? numOrNull_(row.gp) : null;
      row.TacklesPG = statsDiv_(row.TacklesTotal, tgp);
    }
    out.push(row);
  });
  return out;
}

/**
 * What each defence gave up, from the other side's own box score.
 *
 * There is no such thing as a defensive yard in this database: a team's
 * passing yards allowed ARE its opponent's passing yards. So this is
 * necessarily a CONFERENCE-ONLY figure — nobody sends us a non-conference
 * opponent's line — and it is built game by game, crediting each team with
 * whatever the other side produced.
 *
 * `have` is the whole reason this is not three lines long. It counts, per
 * field, how many of the counted games actually reported that field. A field
 * nobody reported sums to nothing, and nothing read as a zero is how a school
 * that has never had a rushing touchdown REPORTED against it ends up leading
 * "fewest rushing touchdowns allowed". A stat that was not recorded is not a
 * stat of zero. Only a field every counted game reported is emitted; the rest
 * come back blank, and blank sorts out of the way instead of to the top.
 *
 * Because the games counted differ from team to team — one school's opponents
 * may all have filed, another's may not — `gp` is the number of games the
 * figure is BUILT from, never the number played. Per game is comparable;
 * totals across unequal schedules are not.
 */
function statsAllowedRows_(q, ctx) {
  const acc = {};
  const confIds = ctx.teams;

  ctx.seasons.forEach(function (sid) {
    const byGame = statsByGameTeam_(sid);
    rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
      if (s_(g.SeasonID) !== sid) return;
      const home = s_(g.HomeTeamID), away = s_(g.AwayTeamID);
      const hs = numOrNull_(g.HomeScore), as = numOrNull_(g.AwayScore);
      if (hs === null || as === null) return;              // unplayed gives nothing
      [[home, away], [away, home]].forEach(function (pair) {
        const tid = pair[0], oppId = pair[1];
        if (!confIds[tid] || !confIds[oppId]) return;      // both sides must be ours
        const bag = (byGame[s_(g.GameID)] || {})[oppId];
        if (!bag) return;                                  // their line is not in yet
        /* And a line that IS in is not necessarily all of it. The old guard
           asked only whether a field was reported, which a single carry for
           five yards satisfies — and the school that played that opponent
           then led the conference in fewest rushing yards allowed. Whether a
           box score is complete is not a thing this can work out from the
           numbers in it, so an administrator says so per team per game, and
           a game nobody has said so about counts for nothing here. */
        if (!statsCovComplete_(g.GameID, oppId)) return;
        var b = acc[tid];
        if (!b) b = acc[tid] = { sums: {}, have: {}, gp: 0, seasons: {} };
        b.gp++;
        b.seasons[sid] = true;
        Object.keys(bag).forEach(function (f) {
          b.sums[f] = (b.sums[f] || 0) + bag[f];
          b.have[f] = (b.have[f] || 0) + 1;
        });
      });
    });
  });

  const out = [];
  Object.keys(acc).forEach(function (tid) {
    const t = ctx.teams[tid];
    if (!t) return;
    const b = acc[tid];
    const seasons = Object.keys(b.seasons).sort().reverse();
    /* Only a field EVERY counted game reported. This is the guard described
       above, and it is the difference between a defensive leaderboard and a
       list of schools whose opponents forgot to file. */
    const sums = {};
    Object.keys(b.sums).forEach(function (f) {
      if (b.have[f] === b.gp) sums[f] = b.sums[f];
    });
    const row = {
      teamId: tid, team: t.name, county: t.county,
      seasonIds: seasons,
      seasons: seasons.map(function (id) {
        return ctx.seasonIdx.byId[id] ? ctx.seasonIdx.byId[id].label : id;
      }).join(', '),
      gp: b.gp || null,
      boxGames: b.gp,
      w: null, l: null, t: null,
      PointsScored: null, PointsAllowed: null, PointDiff: null,
      grain: 'Game', gpPartial: false, prov: false, partial: false,
      /* Named on the row so the page can say it out loud: these are conference
         games only, and the count is games this figure is built from. */
      allowed: true, allowedGames: b.gp
    };
    statsEmitSums_(row, sums);
    statsDerive_(row, true);
    out.push(row);
  });
  return out;
}

// ── MEASURE scope: the roster board ─────────────────────────────────────────

/**
 * A player's position codes in the site's order - each major position, then
 * the sub-positions beneath it. Walking POSITIONS alone missed every
 * sub-position: a safety filed as "S" printed nothing, and a two-way "WR|S"
 * printed as a receiver on the defensive board.
 */
function statsOrderedCodes_(has) {
  const out = [];
  POSITIONS.forEach(function (p) {
    if (has[p.code]) out.push(p.code);
    (p.subs || []).forEach(function (x) { if (has[x.code]) out.push(x.code); });
  });
  return out;
}

/**
 * The positions to print beside a name on one side's board: a two-way player
 * is a safety among the defensive numbers and a receiver among the offensive
 * ones. A player with nothing filed on that side keeps his whole list - a
 * tight end whose roster row never mentions linebacker still reads TE, and
 * the fix for that is on his roster row, not a blank here.
 */
function statsPositionsForSide_(codes, side) {
  const want = side === 'DEFENSE' ? 'DEF' : side === 'OFFENSE' ? 'OFF' : side === 'SPECIAL' ? 'ST' : '';
  if (!want) return codes;
  const onSide = codes.filter(function (c) { const p = POS_BY_CODE[c]; return !!p && p.side === want; });
  return onSide.length ? onSide : codes;
}

/**
 * One row per player from the ROSTER, not the stat rows. The measurables board
 * answers who is biggest, fastest and strongest, which needs no game played —
 * a multi-season range shows each player's newest seat in range.
 */
function statsMeasureRows_(q, ctx) {
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  const acc = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    var sid = s_(r.SeasonID);
    if (!ctx.inRange[sid]) return;
    var pid = s_(r.PlayerID);
    if (!pid) return;
    var tid = s_(r.TeamID);
    var team = ctx.teams[tid];
    if (q.teamId && tid !== q.teamId) return;
    if (q.county && (!team || team.county !== q.county)) return;
    var codes = parsePositions_(r.Positions);
    // a player with declared positions that do not match is out; one with none
    // declared stays — the board is about bodies, not paperwork
    if (q.position && codes.length && !positionMatches_(codes, q.position)) return;
    var b = acc[pid] || (acc[pid] = { seasons: {}, sid: '' });
    b.seasons[sid] = true;
    if (sid < b.sid) return;
    b.sid = sid; b.seat = r; b.teamId = tid; b.codes = codes;
  });

  const out = [];
  Object.keys(acc).forEach(function (pid) {
    var b = acc[pid], r = b.seat, p = players[pid] || {};
    var t = ctx.teams[b.teamId] || {};
    var row = {
      playerId: pid, player: s_(p.DisplayName) || s_(r.DisplayName) || pid,
      teamId: b.teamId, team: t.name || '', county: t.county || '',
      grad: s_(p.GradYear) || s_(r.GradYear) || '',
      positions: (b.codes || []).join('/'),
      seasonIds: Object.keys(b.seasons).sort().reverse(),
      gp: null, gpPartial: false, grain: '', prov: false
    };
    row.seasons = row.seasonIds.map(function (id) {
      var x = ctx.seasonIdx.byId[id];
      return x ? x.label : id;
    }).join(', ');
    var any = false;
    MEASURABLES.forEach(function (m) {
      var v = numOrNull_(r[m.col]);
      row[m.col] = v;
      if (v !== null) any = true;
    });
    // a row with nothing measured says nothing — keep the board dense
    if (any) out.push(row);
  });
  return out;
}

// ── warnings ────────────────────────────────────────────────────────────────

/**
 * Everything the numbers on this page do not say for themselves.
 *
 * Each entry is raised from the data in front of us, never from a fixed list —
 * a warning that fires when it does not apply teaches people to ignore all of
 * them.
 */
function statsWarnings_(q, ctx, rows, keys, empties) {
  const out = [];
  if (q.side === 'MEASURE') {
    out.push('Measurables come from the roster, entered by coaches and players ' +
             'themselves. Blank means never recorded — and a time or a lift ' +
             'nobody verified is a claim, not a certification.');
    return out;
  }
  const defense = keys.indexOf('TFL') >= 0 || keys.indexOf('TacklesTotal') >= 0;
  const perGame = keys.filter(function (k) { return k.slice(-2) === 'PG'; }).length > 0;

  if (ctx.source === 'computed') {
    out.push('PlayerSeasonStats has never been built on this workbook, so these ' +
             'totals were computed live from PlayerGameStats. Run rebuildDerived_().');
  }

  if (q.timeRange === 'SEASON' && !ctx.seasons.length) {
    var picked = ctx.seasonIdx.byId[q.seasonId];
    out.push(picked
      ? picked.label + ' has no statistics recorded yet. The schedule may be loaded, ' +
        'but no game has been played or filed.'
      : q.seasonId + ' is not a season in this database. Nothing was returned rather ' +
        'than quietly falling back to a season nobody asked for.');
  } else if (q.timeRange !== 'SEASON') {
    // Only worth saying for a multi-season range: a range named "last four
    // seasons" that quietly spans two would read as a four-season total.
    var noData = ctx.excluded.filter(function (e) { return e.reason.indexOf('no statistics') === 0; });
    if (noData.length) {
      out.push('This range covers ' + ctx.seasons.length + ' season' +
               (ctx.seasons.length === 1 ? '' : 's') + ', not ' +
               (ctx.seasons.length + noData.length) + ': ' +
               noData.map(function (e) { return e.label; }).join(', ') +
               ' ' + (noData.length > 1 ? 'have' : 'has') + ' no statistics recorded.');
    }
  }

  if (q.scope === 'PLAYER' && ctx.seasons.length > 1) {
    var byName = {};
    rows.forEach(function (r) {
      var n = String(r.player || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
      if (!n) return;
      (byName[n] = byName[n] || {})[r.playerId] = true;
    });
    var split = Object.keys(byName).filter(function (n) { return Object.keys(byName[n]).length > 1; });
    if (split.length) {
      out.push('Player identity is not merged across seasons: ' + split.length +
               ' name' + (split.length > 1 ? 's appear' : ' appears') +
               ' under more than one player ID here, once per season. A multi-season ' +
               'total covers only the seasons filed under a single ID.');
    }
  }

  if (defense) {
    var teamCount = {};
    rows.forEach(function (r) { if (r.teamId) teamCount[r.teamId] = true; });
    if (Object.keys(teamCount).length > 1) {
      out.push('Tackles for loss are not recorded to one convention across the ' +
               'conference — some teams count sacks inside TFL and some do not, so ' +
               'TFL compares within a team but not between teams.');
    }
    var conv = {};
    ctx.seasons.forEach(function (id) {
      var c = ctx.seasonIdx.byId[id].tackleConvention;
      if (c && c.toUpperCase() !== 'UNKNOWN') conv[c] = true;
    });
    if (Object.keys(conv).length > 1) {
      out.push('Tackle totals are not comparable across these seasons: the counting ' +
               'convention changes (' + Object.keys(conv).join(', ') + ').');
    }
  }

  if (perGame) {
    var noGp = rows.filter(function (r) { return r.gp === null || r.gpPartial; }).length;
    if (noGp) {
      out.push(noGp + ' of ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') +
               ' carry no usable game count, so their per-game columns are blank ' +
               'rather than estimated from a partial one.');
    }
    // Only true where a game count came from box scores at all. A season-total
    // season has no box scores to over-count.
    var fromGames = rows.filter(function (r) {
      return r.grain === CONFIG.GRAIN.GAME || r.grain === 'MIXED';
    }).length;
    if (q.scope === 'PLAYER' && fromGames) {
      out.push('Games played counts every appearance in a box score, including games ' +
               'in which a player recorded nothing, so per-game rates are conservative.');
    }
  }

  if (q.scope === 'TEAM') {
    var thin = rows.filter(function (r) { return r.partial; });
    if (thin.length) {
      out.push(thin.length + ' team' + (thin.length > 1 ? 's have' : ' has') +
               ' box scores for only part of the schedule, so their volume totals are ' +
               'a floor. The Box column is how many games are actually covered.');
    }
    if (ctx.unresolvedStatRows) {
      out.push(ctx.unresolvedStatRows + ' stat rows in range never resolved to a named ' +
               'player. They are counted in these team totals and cannot appear in a ' +
               'player table, so player totals will not add up to the team total.');
    }
  }

  if (q.position && q.scope === 'TEAM') {
    out.push('A position filter has no meaning for a team total and was ignored: ' +
             'yardage belongs to the team whoever gained it.');
  } else if (q.position) {
    const isMajor = !!(POS_BY_CODE[q.position] && !POS_BY_CODE[q.position].isSub);
    if (isMajor) {
      out.push('This includes every sub-position beneath ' +
               ((POS_BY_CODE[q.position] || {}).label || q.position) + '.');
    }
    if (ctx.inferredPositions) {
      out.push(ctx.inferredPositions + ' player' + (ctx.inferredPositions === 1 ? '' : 's') +
               ' here have no position on file and were matched on what they recorded ' +
               'instead. Their listed position is blank, not wrong.');
    }
    out.push('Positions on file: ' + (ctx.positionCoverage || []).map(function (c) {
               return c.label + ' ' + c.filed + '/' + c.roster;
             }).join(', ') + '.');
  }

  var sideFields = statsFieldsFor_(q.allowed ? 'ALLOWED' : q.side).map(function (f) { return f.key; });
  var allEmpty = sideFields.length && sideFields.every(function (k) { return empties[k]; });
  if (allEmpty) {
    out.push('Nothing has been reported in any of these columns for the seasons ' +
             'selected. The columns are shown so the gap is visible rather than ' +
             'looking like a page that failed to load.');
  }
  return out;
}

// ── query, build, cache ─────────────────────────────────────────────────────

/**
 * Coerce a caller's query into the canonical shape everything below assumes.
 * Anything unrecognized falls back to a documented default rather than throwing —
 * a stale bookmark should render the default table, not an error panel.
 */
function statsNormalizeQuery_(query) {
  const raw = query || {};
  const q = {};
  q.scope = String(raw.scope || 'PLAYER').toUpperCase() === 'TEAM' ? 'TEAM' : 'PLAYER';
  q.side = String(raw.side || 'ALL').toUpperCase();
  if (STATS_SIDES.indexOf(q.side) < 0) q.side = 'ALL';
  // measurables belong to players; a team has no forty time
  if (q.side === 'MEASURE' && q.scope === 'TEAM') q.side = 'ALL';
  /* What a defence ALLOWED, rather than what it recorded. Its own flag rather
     than a sixth side, because it is a way of reading the defensive board and
     not a fifth part of the field — and because a reader turning it on and off
     should not lose their place in the Side control.
     It means nothing anywhere else: a yard allowed is read off the other
     side's box score, so a player has no share of one and an offence has no
     use for the idea. Anything else asking for it is simply not asking for
     it. */
  q.allowed = (q.scope === 'TEAM' && q.side === 'DEFENSE' &&
               String(raw.allowed || '') !== '' && String(raw.allowed) !== '0');

  // The position has to be resolved BEFORE the side, the columns and the default
  // sort, all of which depend on it. Read after them, it is still undefined and
  // a linebacker filter quietly sorts on total yards.
  q.position = s_(raw.position).toUpperCase();
  if (q.position && !POS_BY_CODE[q.position]) q.position = '';

  // Filtering to a defensive position and still being shown passing columns is
  // noise. A position implies its side unless the caller asked for another.
  if (q.position && q.side === 'ALL') {
    const implied = statsSideForPosition_(q.position);
    if (implied) q.side = implied;
  }
  q.timeRange = String(raw.timeRange || 'SEASON').toUpperCase();
  if (['SEASON', 'LAST4', 'ALL'].indexOf(q.timeRange) < 0) q.timeRange = 'SEASON';

  q.seasonId = s_(raw.seasonId);
  q.county   = s_(raw.county);
  q.teamId   = s_(raw.teamId);
  q.search   = s_(raw.search).slice(0, 40);

  /* The allowed board SHOWS offensive columns, so those are the ones it must
     be sortable by. Asked for as DEFENSE it offered tackles and sacks — none
     of which are in the table — so every header click on that board was
     rejected and fell back to a default sort on a column nobody could see. */
  const sortable = statsSortableKeys_(q.scope, q.allowed ? 'ALLOWED' : q.side);
  // Sorting a quarterback filter on total yards buries the passer behind whoever
  // also ran; the position, when given, decides what "best" means here.
  const POSITION_SORT = { QB: 'PassYds', RB: 'RushYds', WR: 'RecYds', TE: 'RecYds',
                          ATH: 'TotalYds', LB: 'TacklesTotal', DL: 'Sacks',
                          DB: 'Int', K: 'FGM', P: 'PuntYds' };
  q.sortBy = s_(raw.sortBy);
  if (!sortable[q.sortBy]) {
    const byPos = q.position ? POSITION_SORT[majorOf_(q.position)] : '';
    /* PER GAME on the allowed board, never the total. The games it is built
       from differ school to school — one team's opponents all filed, the
       next team's did not — so a total ranks on who was counted least. */
    q.sortBy = q.allowed ? 'TotalYdsPG'
             : (byPos && sortable[byPos]) ? byPos : STATS_DEFAULT_SORT[q.scope][q.side];
  }
  const sortField = sortable[q.sortBy];
  q.sortDir = String(raw.sortDir || '').toUpperCase() === 'ASC' ? 'ASC'
            : (String(raw.sortDir || '').toUpperCase() === 'DESC' ? 'DESC'
            : ((sortField.format === 'text' || sortField.asc) ? 'ASC' : 'DESC'));

  // The qualifier defaults to nothing so a counting-stat table shows everyone.
  // It only defaults to a real floor when the caller sorts by a rate, which is
  // the one case where a two-carry season would otherwise lead the conference.
  var asked = numOrNull_(raw.minGames);
  if (asked !== null && asked >= 0) {
    q.minGames = Math.floor(asked);
    q.minGamesReason = 'requested';
  } else if (sortField.rate) {
    q.minGames = STATS_RATE_MIN_GAMES;
    q.minGamesReason = 'default for a rate-sorted table';
  } else {
    q.minGames = 0;
    q.minGamesReason = 'none applied';
  }

  var limit = numOrNull_(raw.limit);
  q.limit = limit === null ? STATS_DEFAULT_LIMIT
          : Math.max(1, Math.min(STATS_MAX_LIMIT, Math.floor(limit)));
  var offset = numOrNull_(raw.offset);
  q.offset = offset === null ? 0 : Math.max(0, Math.floor(offset));
  return q;
}

function statsCacheKey_(q) {
  return STATS_CACHE_PREFIX + [q.scope, q.side, q.allowed ? 'ALW' : '', q.timeRange, q.seasonId, q.county,
    q.teamId, q.position, q.minGames, q.sortBy, q.sortDir, q.limit, q.offset,
    q.search.toLowerCase()].join('|');
}

/** Blanks sort last in BOTH directions — nobody who filed nothing tops a table. */
function statsSorter_(key, dir, idKey) {
  const mul = dir === 'ASC' ? 1 : -1;
  return function (x, y) {
    var a = x[key], b = y[key];
    var an = (a === null || a === undefined || a === '');
    var bn = (b === null || b === undefined || b === '');
    if (an && bn) return String(x[idKey]).localeCompare(String(y[idKey]));
    if (an) return 1;
    if (bn) return -1;
    var c;
    if (typeof a === 'number' && typeof b === 'number') c = (a - b) * mul;
    else c = String(a).localeCompare(String(b)) * mul;
    // A stable tiebreak keeps a row from moving between pages as you page through.
    return c || String(x[idKey]).localeCompare(String(y[idKey]));
  };
}

function statsBuild_(q) {
  const sIdx = statsSeasonIndex_();
  const withData = statsSeasonsWithData_(q.scope, q.side);
  if (!q.seasonId) {
    for (var i = 0; i < sIdx.newestFirst.length; i++) {
      if (withData[sIdx.newestFirst[i]]) { q.seasonId = sIdx.newestFirst[i]; break; }
    }
    if (!q.seasonId) q.seasonId = CONFIG.CURRENT_SEASON;
  }

  const range = statsResolveSeasons_(q, sIdx, withData);
  const ctx = {
    seasonIdx: sIdx, seasons: range.seasons, inRange: range.inRange,
    excluded: range.excluded, teams: statsTeamIndex_(),
    source: statsSeasonSource_().source, unresolvedStatRows: 0, positionCoverage: []
  };

  var rows = [];
  if (ctx.seasons.length) {
    rows = (q.side === 'MEASURE') ? statsMeasureRows_(q, ctx)
         : q.allowed ? statsAllowedRows_(q, ctx)
         : (q.scope === 'TEAM') ? statsTeamRows_(q, ctx) : statsPlayerRows_(q, ctx);
  }

  if (q.search) {
    var needle = q.search.toLowerCase();
    rows = rows.filter(function (r) {
      return String(r.player || '').toLowerCase().indexOf(needle) >= 0 ||
             String(r.team || '').toLowerCase().indexOf(needle) >= 0;
    });
  }

  /* A defence whose opponents have barely filed has no allowed figure worth
     ranking, and on a board of totals it would LEAD by having been counted
     least. Dropped, and named — a school that vanishes without explanation
     reads as a site that has forgotten it exists. */
  const allowedThin = [];
  if (q.allowed) {
    rows = rows.filter(function (r) {
      if ((r.allowedGames || 0) >= STATSCOV.MIN_GAMES) return true;
      allowedThin.push({ team: r.team, games: r.allowedGames || 0 });
      return false;
    });
    allowedThin.sort(function (a, b) { return a.team.localeCompare(b.team); });
  }

  const excluded = { belowMinGames: 0, unknownGamesPlayed: 0 };
  if (q.minGames > 0) {
    rows = rows.filter(function (r) {
      var gp = numOrNull_(r.gp);
      // A partial count is a floor: it can prove a row qualifies, never that it
      // does not. An indeterminate row is excluded and counted, not assumed.
      if (gp !== null && gp >= q.minGames) return true;
      if (gp === null || r.gpPartial) { excluded.unknownGamesPlayed++; return false; }
      excluded.belowMinGames++;
      return false;
    });
  }

  const columns = statsColumns_(q.scope, q.side, q, ctx);
  const keys = columns.map(function (c) { return c.key; });
  const idKey = q.scope === 'TEAM' ? 'teamId' : 'playerId';

  // Round to what the client will display, before sorting, so the order always
  // matches the numbers on screen.
  columns.forEach(function (c) {
    if (!c.numeric) return;
    rows.forEach(function (r) { r[c.key] = statsRound_(r[c.key], c.format); });
  });

  const empties = {};
  columns.forEach(function (c) { empties[c.key] = true; });
  rows.forEach(function (r) {
    columns.forEach(function (c) {
      if (r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== '') empties[c.key] = false;
    });
  });

  const totals = statsProject_(statsTotals_(q, rows, columns), keys);
  const grains = {};
  rows.forEach(function (r) { if (r.grain) grains[r.grain] = (grains[r.grain] || 0) + 1; });

  const warnings = statsWarnings_(q, ctx, rows, keys, empties);

  rows.sort(statsSorter_(q.sortBy, q.sortDir, idKey));
  const total = rows.length;
  const page = rows.slice(q.offset, q.offset + q.limit).map(function (r) {
    return statsProject_(r, keys);
  });

  const payload = {
    scope: q.scope,
    rows: page,
    columns: columns,
    totals: totals,
    meta: {
      scope: q.scope, side: q.side, timeRange: q.timeRange,
      seasonId: q.seasonId,
      seasons: ctx.seasons.map(function (id) {
        return { id: id, label: sIdx.byId[id].label, year: sIdx.byId[id].year,
                 status: sIdx.byId[id].status };
      }),
      seasonsExcluded: ctx.excluded,
      county: q.county, teamId: q.teamId, position: q.position, search: q.search,
      allowed: !!q.allowed,
      allowedMinGames: STATSCOV.MIN_GAMES,
      allowedThin: allowedThin,
      inferredPositions: ctx.inferredPositions || 0,
      minGames: q.minGames, minGamesDefault: STATS_RATE_MIN_GAMES,
      minGamesReason: q.minGamesReason, excluded: excluded,
      sortBy: q.sortBy, sortDir: q.sortDir,
      limit: q.limit, offset: q.offset, total: total,
      returned: page.length,
      grains: grains,
      /* The client hides an empty column so "Special" is not a screen of
         blanks. On the measurables board the columns ARE the subject — a coach
         needs to see that Squat exists and nobody has filled it, not find it
         quietly missing — so that board keeps every column. */
      emptyColumns: q.side === 'MEASURE' ? []
                    : keys.filter(function (k) { return empties[k]; }),
      source: ctx.source,
      warnings: warnings,
      generatedAt: new Date().toISOString()
    }
  };

  // cacheGet() skips its put above 95,000 characters without saying so, which
  // would leave this endpoint re-running its full producer on every request while
  // looking perfectly healthy. Say so here instead.
  try {
    payload.meta.bytes = JSON.stringify(payload).length;
    if (payload.meta.bytes >= 95000) {
      Logger.log('apiStats: payload ' + payload.meta.bytes + ' chars exceeds the script ' +
                 'cache limit and will not be cached. Key: ' + statsCacheKey_(q));
    }
  } catch (e) {}

  return payload;
}

/**
 * Footer totals across every matching row, not just the page.
 *
 * Ratios are recomputed from the summed atoms — averaging a column of averages
 * would weight a two-carry back the same as a two-hundred-carry one. Per-game
 * columns stay blank: a sum of games played across different players is not a
 * denominator anything can be divided by.
 */
function statsTotals_(q, rows, columns) {
  const sums = {};
  SUM_FIELDS.forEach(function (f) {
    var v = statsSum_(rows.map(function (r) { return r[f]; }));
    if (v !== null) sums[f] = v;
  });

  const t = { count: rows.length };
  t[q.scope === 'TEAM' ? 'team' : 'player'] = 'Total';
  statsEmitSums_(t, sums);

  if (q.scope === 'TEAM') {
    t.PointsScored  = statsSum_(rows.map(function (r) { return r.PointsScored; }));
    t.PointsAllowed = statsSum_(rows.map(function (r) { return r.PointsAllowed; }));
    t.PointDiff = (t.PointsScored === null || t.PointsAllowed === null)
                ? null : t.PointsScored - t.PointsAllowed;
    ['w', 'l', 't', 'gp', 'boxGames'].forEach(function (k) {
      t[k] = statsSum_(rows.map(function (r) { return r[k]; }));
    });
  } else {
    t.gp = statsSum_(rows.map(function (r) { return r.gp; }));
  }

  statsDerive_(t, false);
  columns.forEach(function (c) { if (c.numeric) t[c.key] = statsRound_(t[c.key], c.format); });
  return t;
}

/**
 * The filterable stats table.
 *
 * query {scope, side, timeRange, seasonId, county, teamId, position, minGames,
 *        sortBy, sortDir, limit, offset, search}
 * -> {scope, rows[], columns[], totals, meta}
 *
 * Cached under a key derived from the whole query. Nothing here reads an
 * identity, so there is nothing user-specific to leak into a shared cache entry —
 * and nothing user-specific may ever be added to this payload for that reason.
 */
function apiStats_(query) {
  const q = statsNormalizeQuery_(query);
  return cacheGet_(statsCacheKey_(q), STATS_CACHE_TTL, function () { return statsBuild_(q); });
}

/**
 * Everything the Stats page needs to build its controls, every list derived from
 * the data that actually exists.
 *
 * Seasons carry flags rather than being filtered out: the UI should be able to
 * show that 2026 is on the calendar and empty, which is true, instead of
 * pretending the season does not exist.
 */
function apiStatsFilters_() {
  return cacheGet_(STATS_CACHE_PREFIX + 'filters', STATS_CACHE_TTL, function () {
    const sIdx = statsSeasonIndex_();
    const teamIdx = statsTeamIndex_();

    const hasPlayerStats = {}, hasGameDetail = {}, statRows = {};
    statsSeasonSource_().rows.forEach(function (r) {
      var sid = s_(r.SeasonID);
      if (!sid) return;
      hasPlayerStats[sid] = true;
      statRows[sid] = (statRows[sid] || 0) + 1;
      if (s_(r.SourceGrain) === CONFIG.GRAIN.GAME) hasGameDetail[sid] = true;
    });
    const hasScores = {};
    rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
      if (numOrNull_(g.HomeScore) === null || numOrNull_(g.AwayScore) === null) return;
      hasScores[s_(g.SeasonID)] = true;
    });

    const seasons = sIdx.newestFirst.map(function (id) {
      var x = sIdx.byId[id];
      return { id: id, label: x.label, year: x.year, status: x.status,
               hasPlayerStats: !!hasPlayerStats[id], hasGameDetail: !!hasGameDetail[id],
               hasScores: !!hasScores[id], players: statRows[id] || 0,
               tackleConvention: x.tackleConvention };
    });
    const withPlayerData = sIdx.newestFirst.filter(function (id) { return hasPlayerStats[id]; });
    const withAnyData = sIdx.newestFirst.filter(function (id) {
      return hasPlayerStats[id] || hasScores[id];
    });

    const teams = Object.keys(teamIdx).map(function (id) { return teamIdx[id]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    const countyCount = {};
    teams.forEach(function (t) { if (t.county) countyCount[t.county] = (countyCount[t.county] || 0) + 1; });
    const counties = Object.keys(countyCount).sort().map(function (c) {
      return { key: c, label: c + ' County', teams: countyCount[c] };
    });

    // A position is only offered when a player carrying it has statistics to
    // show. Positions were barely filed before 2025; offering the full list
    // would return an empty table that reads as "this player had no season".
    const hasStats = {};
    statsSeasonSource_().rows.forEach(function (r) {
      var pid = s_(r.PlayerID), sid = s_(r.SeasonID);
      if (pid && sid) hasStats[pid + '|' + sid] = true;
    });
    const posPlayers = {}, posSeasons = {};
    rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
      var pid = s_(r.PlayerID), sid = s_(r.SeasonID);
      if (!pid || !hasStats[pid + '|' + sid]) return;
      parsePositions_(r.Positions).forEach(function (c) {
        (posPlayers[c] = posPlayers[c] || {})[pid] = true;
        posSeasons[c] = posSeasons[c] || {};
        posSeasons[c][sid] = (posSeasons[c][sid] || 0) + 1;
      });
    });
    // Majors and their sub-positions, each with how many players it would find.
    // A major's count includes everyone under it, so choosing Linebacker never
    // shows fewer players than choosing Inside Linebacker beneath it.
    const positions = [];
    POSITIONS.forEach(function (p) {
      const own = posPlayers[p.code] || {};
      const rolled = {};
      Object.keys(own).forEach(function (k) { rolled[k] = true; });
      (p.subs || []).forEach(function (sub) {
        Object.keys(posPlayers[sub.code] || {}).forEach(function (k) { rolled[k] = true; });
      });
      const total = Object.keys(rolled).length;
      if (total) {
        positions.push({ code: p.code, label: p.label, side: p.side, major: p.code,
                         isSub: false, players: total, seasons: posSeasons[p.code] });
      }
      (p.subs || []).forEach(function (sub) {
        const n = Object.keys(posPlayers[sub.code] || {}).length;
        if (!n) return;
        positions.push({ code: sub.code, label: sub.label, side: p.side, major: p.code,
                         isSub: true, players: n, seasons: posSeasons[sub.code] });
      });
    });

    const seen = {}, categories = [];
    STATS_FIELDS.forEach(function (f) {
      var k = f.side + '|' + f.group;
      if (seen[k]) return;
      seen[k] = true;
      categories.push({ key: f.group.toUpperCase(), label: f.group, side: f.side });
    });

    const timeRanges = STATS_TIME_RANGES.map(function (t) {
      var covers = t.key === 'ALL' ? withPlayerData
                 : (t.key === 'LAST4' ? withPlayerData.slice(0, STATS_LAST_N) : []);
      return { key: t.key, label: t.label, seasons: covers,
               teamSeasons: t.key === 'ALL' ? withAnyData
                          : (t.key === 'LAST4' ? withAnyData.slice(0, STATS_LAST_N) : []) };
    });

    return {
      seasons: seasons,
      defaultSeason: withPlayerData[0] || CONFIG.CURRENT_SEASON,
      teams: teams,
      counties: counties,
      positions: positions,
      categories: categories,
      sides: STATS_SIDES,
      timeRanges: timeRanges,
      minGamesDefault: STATS_RATE_MIN_GAMES,
      limitDefault: STATS_DEFAULT_LIMIT,
      limitMax: STATS_MAX_LIMIT
    };
  });
}
