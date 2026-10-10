/**
 * UCBAC Stats — AllConference.gs
 *
 * Objective All-Conference projection, implementing the UCBAC Implementation
 * Spec v1.0 against the live database.
 *
 * Eligibility comes from PlayerSeasons.Positions — the controlled multi-select
 * a coach fills in through the roster editor. A player listed "RB|CB|ATH" is
 * ranked in all three pools; resolveDuplicates() then decides which award he
 * actually occupies.
 *
 * SIX DEPARTURES from the spec as written, each forced by the data and each
 * visible in the output rather than applied silently:
 *
 *  1. §6 says Non-Sack TFL = MAX(0, TFL - Sacks). Measured against the real
 *     data, 15 of 31 team-seasons already record TFL as EXCLUDING sacks — three
 *     of them report TFL < Sacks on every single row. Blanket subtraction would
 *     erase real production for half the conference, so the convention is
 *     detected per team-season instead of assumed.
 *  2. §1.1 requires conference-only statistics, but a SEASON_TOTAL row cannot be
 *     split into conference and non-conference. Those players are scored when
 *     their team played >= 80% conference games, and flagged Provisional.
 *  3. §4.3 removes a player whose material fields are incomplete. Eight of
 *     fifteen teams reported 2025 defense as season totals only; the strict rule
 *     would delete most of the conference from the ballot. Incompleteness lowers
 *     the multiplier and the confidence instead.
 *  4. §5.5 Offensive Line is not ranked at all — the spec says so itself, as no
 *     snap, pressure or block-grade data exists.
 *  5. §2.3 opportunity thresholds are season figures — 35 carries, 20 tackles —
 *     and the ballot is published from week two. Held at full size in September
 *     they admitted nobody: two games in, a back averaging thirteen carries a
 *     game had 26 and was not on the ballot behind one with 35. Each threshold
 *     is scaled to the share of the conference schedule the player's team has
 *     played, so the bar is the same pace all year and reaches the spec's
 *     number at the end of it. Confidence still asks the unscaled question.
 *  6. A blank defensive count is a zero when the team keeps that count. A
 *     coach's sheet writes an interception on the boy who made it and nothing
 *     on the rest, so the blank was arriving as "not reported", the term was
 *     dropped from the player's score and his remaining terms renormalized -
 *     which meant a linebacker with no interceptions was not scored against
 *     the one with two, and the weight on interceptions moved nobody. Now, for
 *     TFL, sacks, interceptions, forced and recovered fumbles, passes defensed
 *     and defensive touchdowns: when any of a team's conference rows for the
 *     season carries the figure, a teammate with a defensive line and no
 *     figure has zero. A team whose sheet never carries it is still "not
 *     reported", and departure 3 still applies.
 */

/* AC-1.1: a tackle is a tackle. Solo and assisted count the same, and the
   separate solo term is gone from every defensive position.

   AC-1.2: one quarterback rating in place of its own four parts. Completion %,
   yards per attempt, TD rate and interception rate were carrying .10+.10+.10+
   .08 of a quarterback's score between them — and those four ARE the passer
   rating, which is why adding a rating term on top would have counted each of
   them twice. QBRtg replaces the four at their combined .38, so the weight a
   quarterback's efficiency carries is unchanged and it is now expressed as the
   number a coach reads on MaxPreps. Volume keeps its own weight, so an
   efficient backup with sixty attempts still does not outrank a starter.

   AC-1.3: opportunity thresholds scale with the schedule (departure 5 above).
   No weight changed; a row from before this cannot be compared on who was
   allowed into the pool, which is why the version moves.

   AC-1.4: defensive touchdowns become a measure for ILB, OLB, EDGE and DL
   (they were reaching those positions only through the disruption index),
   and a linebacker's interception now outweighs his fumble recoveries and
   passes defensed, as a safety's already did. ILB: Int .04 -> .07, DefTD
   .04 added, PassDef .05 -> .04, FR .05 -> .03, Tack .32 -> .30, FF .10 ->
   .09, DIP .05 -> .04. OLB: Int .04 -> .08, DefTD .04 added, PassDef .07 ->
   .05, FR .05 -> .03, Tack .27 -> .25, FF .10 -> .09, DIP .05 -> .04. EDGE
   and DL: DefTD .03 added, from Tack. S, CB and every offensive list are
   unchanged. Every list still sums to 1.00.
   The same version adds departure 6 (above): a blank defensive count is a
   zero when the team keeps that count. Without it the new weights moved
   nobody, because a boy with no interceptions had the term dropped and his
   score renormalized over what was left.

   AC-1.5: Athlete and Ironman are decided by production, not by the roster.
   Three games into 2026 the Athlete ballot was empty while thirteen players
   were clearing its gate - quarterbacks who run, backs who catch - because
   every one of them was listed QB or RB and nobody had typed ATH. Ironman
   was emptier still: it took a player's best offensive ranking and best
   defensive ranking, and a boy listed only on one side has no ranking on the
   other, however many tackles he made. No roster position names Ironman at
   all. So a player who meets the Athlete gate is in the Athlete pool whether
   or not a coach listed him there; the one-award-per-side rule still decides
   whether he takes Athlete or his listed position. And for Ironman, a side
   the roster does not list is scored the way it would be if it were - the
   player is placed in every pool on that side his numbers qualify for and
   the best of them stands in. Those stand-in scores are marked * in the
   note and never appear on the position ballots themselves. No weight
   changed. */
const AC_FORMULA_VERSION = 'AC-1.5';
const AC_TAB = 'AllConference';

/** (metric, weight, invertLowerIsBetter) — verbatim from the spec. */
const AC_WEIGHTS = {
  QB:  [['PassYds',.20,0],['PassYdsPG',.15,0],['PassTD',.12,0],['QBRtg',.38,0],
        ['PPE',.05,0],['RushYds',.05,0],['RushTD',.05,0]],
  RB:  [['RushYds',.20,0],['RushYdsPG',.15,0],['YPC',.15,0],['RushTD',.15,0],
        ['RushAtt',.08,0],['FumRate',.07,1],['Rec',.08,0],['RecYds',.07,0],['RecTD',.05,0]],
  WR:  [['RecYds',.20,0],['RecYdsPG',.15,0],['Rec',.15,0],['RecPG',.12,0],
        ['YPR',.13,0],['RecTD',.15,0],['FumRate',.05,1],['RushYds',.05,0]],
  ATH: [['TotYds',.25,0],['TotYdsPG',.15,0],['TotTD',.20,0],['TouchEff',.10,0],
        ['MultiDim',.15,0],['PrimaryEff',.10,0],['FumRate',.05,1]],
  /* A tackle is a tackle. The spec ranked solo tackles a second time, on top
     of a Tack figure that already counted an assist as half of one, so the
     same play was worth anything from a half to one and a half depending on
     who wrote the sheet — and half the conference reports a combined total
     with no split to read. The separate solo term is folded into Tack, which
     now counts both kinds as one. Every list still sums to 1.00. */
  /* AC-1.4: a takeaway that ends in the end zone is a measure for every front-
     seven position, not only the secondary, and an interception outranks a
     recovered fumble or a pass broken up for a linebacker as it already did for
     a safety. Tackles and tackles for loss remain the bulk of the score. */
  ILB: [['Tack',.30,0],['TackPG',.12,0],['NsTFL',.15,0],
        ['Sacks',.12,0],['FF',.09,0],['FR',.03,0],['PassDef',.04,0],['Int',.07,0],['DefTD',.04,0],['DIP',.04,0]],
  OLB: [['Tack',.25,0],['TackPG',.10,0],['NsTFL',.17,0],
        ['Sacks',.15,0],['FF',.09,0],['FR',.03,0],['PassDef',.05,0],['Int',.08,0],['DefTD',.04,0],['DIP',.04,0]],
  EDGE:[['Tack',.15,0],['NsTFL',.22,0],['Sacks',.25,0],
        ['FF',.12,0],['FR',.05,0],['PassDef',.05,0],['DefTD',.03,0],['DIP',.08,0],['DisrPG',.05,0]],
  DL:  [['Tack',.22,0],['NsTFL',.25,0],['Sacks',.20,0],
        ['FF',.12,0],['FR',.05,0],['DefTD',.03,0],['DIP',.08,0],['DisrPG',.05,0]],
  S:   [['Tack',.25,0],['NsTFL',.08,0],['Sacks',.05,0],
        ['FF',.10,0],['FR',.05,0],['PassDef',.17,0],['Int',.20,0],['DefTD',.05,0],['DIP',.05,0]],
  CB:  [['Tack',.13,0],['NsTFL',.04,0],['FF',.08,0],['FR',.05,0],
        ['PassDef',.27,0],['Int',.28,0],['DefTD',.10,0],['DIP',.05,0]],
  /* Pancake blocks are the only offensive-line stat the conference records, so
     the OL projection ranks on them alone: volume first, rate close behind. */
  OL:  [['Pancakes',.60,0],['PancakesPG',.40,0]]
};

/**
 * The transparency layer. Everything below is DESCRIPTION of the formulas
 * above, published on the All-Conference page so a reader can see exactly what
 * moves a projection — the weights themselves stay in AC_WEIGHTS, and these
 * labels are rendered straight from them, so the description cannot drift from
 * the arithmetic.
 */
const AC_METRIC_LABEL = {
  PassYds: 'Passing yards', PassYdsPG: 'Passing yards per game', PassTD: 'Passing TDs',
  QBRtg: 'QB rating', TDRate: 'TD rate per attempt', CompPct: 'Completion %',
  YPA: 'Yards per attempt', IntRate: 'Interception rate',
  PPE: 'Points produced per game',
  RushYds: 'Rushing yards', RushYdsPG: 'Rushing yards per game', RushTD: 'Rushing TDs',
  YPC: 'Yards per carry', RushAtt: 'Carries', FumRate: 'Fumble rate',
  Rec: 'Receptions', RecYds: 'Receiving yards', RecYdsPG: 'Receiving yards per game',
  RecPG: 'Receptions per game', YPR: 'Yards per catch', RecTD: 'Receiving TDs',
  TotYds: 'Total yards (pass + rush + rec)', TotYdsPG: 'Total yards per game',
  TotTD: 'Total TDs', TouchEff: 'Yards per touch', MultiDim: 'Multi-category balance',
  PrimaryEff: 'Primary-role efficiency',
  Pancakes: 'Pancake blocks', PancakesPG: 'Pancake blocks per game',
  Tack: 'Total tackles (solo and assisted count the same)', TackPG: 'Tackles per game',
  NsTFL: 'Tackles for loss (sacks not double-counted)',
  Sacks: 'Sacks', FF: 'Forced fumbles', FR: 'Fumble recoveries',
  PassDef: 'Passes defensed', Int: 'Interceptions', DefTD: 'Defensive TDs',
  DIP: 'Disruption index (weighted havoc plays)', DisrPG: 'Disruptions per game'
};

/**
 * The arithmetic behind a metric whose name alone does not give it away.
 *
 * QB rating is the one term on the ballot that is itself a formula, and it now
 * carries more weight than any other single metric a quarterback has. A reader
 * asked to accept .38 of a ranking should be able to see what it is made of
 * rather than take the phrase on trust — so the formula is printed beside it,
 * in the same block that lists the weights.
 *
 * Written the way it is calculated in acDerive() and in the two places the site
 * shows the number itself, so a coach can check any of them against the others.
 */
const AC_METRIC_DETAIL = {
  QBRtg: '[a + b + c + d] ÷ 6 × 100, where a = (Comp ÷ Att − 0.3) × 5, ' +
         'b = (Yds ÷ Att − 3) × 0.25, c = (TD ÷ Att) × 20, ' +
         'd = 2.375 − (Int ÷ Att) × 25, each held between 0 and 2.375. ' +
         'The 0–158.3 scale MaxPreps prints as QB Rate.'
};

/** AC_THRESHOLD, in words. */
const AC_THRESHOLD_TEXT = {
  OL: '10 pancake blocks recorded',
  QB: '40 pass attempts, or 60 combined pass and rush attempts',
  RB: '35 carries, or 45 combined carries and catches',
  WR: '15 receptions',
  ATH: '40 combined attempts and catches',
  ILB: '20 tackles', OLB: '20 tackles', S: '15 tackles',
  CB: '10 tackles', EDGE: '10 tackles', DL: '10 tackles'
};

/** Positions ranked by something other than a weight table. */
const AC_POSITION_NOTE = {
  IRONMAN: 'The two-way award. Score = 40% of the player’s best offensive ' +
      'position score + 40% of his best defensive position score + 15% for how ' +
      'balanced the two are + 5% for two-way availability. Requires 25 offensive ' +
      'touches or attempts, and 15 tackles or 4 defensive plays. A side the roster ' +
      'does not list is scored as if it did: the player is placed in every position ' +
      'on that side his numbers qualify for and the best stands in, marked * in the note.'
};

/**
 * Eligibility, in words, for the page's "How this page works" block: the
 * rules every ranked player meets, then the ones particular to a position.
 * Description only — the arithmetic is AC_THRESHOLD, AC_ATH_GATE, acEligible()
 * and POOL_EXPANSION, and the position-specific lines are built from those
 * tables so the words cannot drift from the rule.
 */
const AC_ATH_GATE_LABEL = {
  PassAtt: 'pass attempts', RushAtt: 'carries', Rec: 'receptions',
  PassYds: 'passing yards', RushYds: 'rushing yards', RecYds: 'receiving yards'
};

function acEligibilityCommon_() {
  return [
    'Listed at the position on the team roster. Athlete and Ironman are the exceptions: production alone decides them.',
    'Stats from 2 or more conference games.',
    'Position minimums are full-season figures, scaled to the share of the conference schedule the team has played so far. Two games into eight, the bar is a quarter of the figure shown; it reaches the full figure at the end of the season.',
    'Season-only totals count when 80% or more of the team’s games were conference games, and rank as provisional.',
    'One award per side: a player in range at two positions on the same side keeps the stronger.'
  ];
}

function acEligibilityFor_(code) {
  if (code === 'IRONMAN') return [
    'Scored at one offensive and one defensive position. A side the roster does not list is scored from his numbers alone, at every position on that side he qualifies for, and the best stands in (marked *).',
    '25 offensive touches or attempts.',
    '15 tackles, or 4 defensive plays (TFL, sacks, forced or recovered fumbles, passes defensed, interceptions, defensive TDs).'
  ];
  const out = [];
  if (AC_THRESHOLD_TEXT[code]) out.push('Minimum: ' + AC_THRESHOLD_TEXT[code] + '.');
  if (code === 'ATH') {
    // one line per category, so the rule reads as it is applied: two of
    // passing, rushing and receiving, each reached by either of its figures
    const byCat = {}, order = [];
    AC_ATH_GATE.forEach(function (g) {
      if (!byCat[g[2]]) { byCat[g[2]] = []; order.push(g[2]); }
      byCat[g[2]].push(g[1] + ' ' + (AC_ATH_GATE_LABEL[g[0]] || g[0]));
    });
    out.push('Production in at least 2 of passing, rushing and receiving: ' + order.map(function (c) {
      return byCat[c].join(' or ');
    }).join('; ') + '.');
    out.push('No roster listing needed. Any player who meets both figures is ranked here, and keeps either this award or his listed position, whichever ranks him higher.');
  }
  if (code === 'WR') out.push('Tight ends rank here.');
  if (code === 'RB') out.push('Halfbacks and fullbacks rank here.');
  if (code === 'OL') out.push('Centers, guards and tackles rank here.');
  // the major a roster may list instead of this pool, and every pool it reaches
  Object.keys(POOL_EXPANSION).forEach(function (major) {
    const pools = POOL_EXPANSION[major];
    if (pools.length < 2 || pools.indexOf(code) < 0) return;
    out.push('A roster listing of just ' + major + ' counts for ' + pools.map(function (c) {
      return (POS_BY_CODE[c] || {}).label || c;
    }).join(' and ') + '.');
  });
  return out;
}

/** What the expandable "how this is scored" block renders, per position. */
function acFormulaFor_(code) {
  const w = AC_WEIGHTS[code];
  if (!w) return { note: AC_POSITION_NOTE[code] || '', threshold: '', weights: [] };
  return {
    note: '',
    threshold: AC_THRESHOLD_TEXT[code] || '',
    weights: w.map(function (e) {
      return { metric: e[0], label: AC_METRIC_LABEL[e[0]] || e[0],
               detail: AC_METRIC_DETAIL[e[0]] || '',
               pct: Math.round(e[1] * 100), lower: !!e[2] };
    })
  };
}

/** §2.3 opportunity thresholds, using box-score proxies until snaps exist.
    The numbers are the spec's season figures; `k` is the share of the
    conference schedule the player's team has played (departure 5), so two
    games into nine a back needs 35 × 2/9 ≈ 8 carries, and at the end of the
    year he needs 35. Called with k = 1 to ask the season question itself. */
const AC_THRESHOLD = {
  QB:  function (m, k) { return m.PassAtt >= 40 * k || (m.PassAtt + m.RushAtt) >= 60 * k; },
  RB:  function (m, k) { return m.RushAtt >= 35 * k || (m.RushAtt + m.Rec) >= 45 * k; },
  WR:  function (m, k) { return m.Rec >= 15 * k; },
  ATH: function (m, k) { return (m.PassAtt + m.RushAtt + m.Rec) >= 40 * k; },
  OL:  function (m, k) { return (m.Pancakes || 0) >= 10 * k; },
  ILB: function (m, k) { return m.Tack >= 20 * k; },
  OLB: function (m, k) { return m.Tack >= 20 * k; },
  S:   function (m, k) { return m.Tack >= 15 * k; },
  CB:  function (m, k) { return m.Tack >= 10 * k; },
  EDGE:function (m, k) { return m.Tack >= 10 * k; },
  DL:  function (m, k) { return m.Tack >= 10 * k; }
};

/** How far through the conference schedule a team is, as the factor the
    thresholds are scaled by. Never below the two games eligibility already
    demands, never above the whole season. */
function acPace_(teamGames, gp, scheduled) {
  const played = Math.max(teamGames || 0, gp || 0, 2);
  return Math.min(1, played / Math.max(1, scheduled || 1));
}

/** Conference games per team on the schedule: every conference game counts
    for two teams, so twice the games over the number of schools. */
function acScheduled_(seasonId) {
  var scheduled = 0;
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (String(g.SeasonID).trim() === seasonId &&
        String(g.GameType).trim() === 'CONFERENCE') scheduled++;
  });
  return Math.round(scheduled * 2 / Math.max(1, rowsOf_(CONFIG.TABS.TEAMS).length)) || 8;
}

/** §3 small-sample stabilizers: metric -> [k, opportunityField]. */
const AC_STABILIZE = {
  QBRtg: [40, 'PassAtt'],
  CompPct: [40, 'PassAtt'], YPA: [40, 'PassAtt'], TDRate: [40, 'PassAtt'],
  IntRate: [40, 'PassAtt'], YPC: [30, 'RushAtt'], YPR: [15, 'Rec'],
  TouchEff: [30, 'Touches'], PrimaryEff: [30, 'Touches']
};

/** §5.4 Athlete requires production in at least two categories. The third
    entry of each row is the category the figure belongs to — a back with 15
    carries and 100 yards has produced in ONE category, not two, and until this
    said so every running back listed as an athlete cleared the gate on his
    rushing alone. Passing, rushing and receiving are the categories; either
    figure of a pair counts, and two different categories are needed. */
const AC_ATH_GATE = [['PassAtt',10,'pass'],['RushAtt',15,'rush'],['Rec',8,'rec'],
                     ['PassYds',150,'pass'],['RushYds',100,'rush'],['RecYds',100,'rec']];

const AC_SUM = ['PassAtt','PassComp','PassYds','PassTD','PassInt','RushAtt','RushYds',
  'RushTD','RushFum','Rec','RecYds','RecTD','RecFum','Pancakes','TackleSolo',
  'TackleAssist','TFL','Sacks','Int','FF','FR','PassDef','DefTD'];

function acNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** Departure 6: the defensive counts a blank can stand for, and the fields
    whose presence says a player has a defensive line at all. */
const AC_DEF_COUNTS = ['TFL', 'Sacks', 'Int', 'FF', 'FR', 'PassDef', 'DefTD'];
const AC_DEF_ANY = ['TackleSolo', 'TackleAssist'].concat(AC_DEF_COUNTS);

/**
 * A player's summed game figures, with a zero written into every defensive
 * count his team keeps and his rows never carried. Only a player with a
 * defensive line of some kind gets them - a receiver who never made a tackle
 * is not handed seven zeros - and a count the team never keeps stays absent.
 */
function acFillKeptZeros_(use, keptByTeam) {
  if (!keptByTeam) return use;
  const hasDef = AC_DEF_ANY.some(function (f) { return use[f] !== undefined && use[f] !== null; });
  if (!hasDef) return use;
  AC_DEF_COUNTS.forEach(function (f) {
    if (keptByTeam[f] && (use[f] === undefined || use[f] === null)) use[f] = 0;
  });
  return use;
}

/** PERCENTRANK: share strictly below, plus half the ties. */
function acPercentile_(sorted, v) {
  const n = sorted.length;
  if (n < 2) return 50;
  var below = 0, ties = 0;
  for (var i = 0; i < n; i++) {
    if (sorted[i] < v) below++;
    else if (sorted[i] === v) ties++;
  }
  return 100 * (below + 0.5 * Math.max(0, ties - 1)) / (n - 1);
}

function acStabilize_(rate, opps, posAvg, k) {
  if (rate === null || posAvg === null) return rate;
  return (opps / (opps + k)) * rate + (k / (opps + k)) * posAvg;
}

/** Every derived metric the weights reference. A blank input stays blank. */
function acDerive_(m, gp, tflExclusive) {
  const d = {}, g = Math.max(1, gp || 1);
  AC_SUM.forEach(function (f) { d[f] = m[f] === undefined ? null : m[f]; });
  const z = function (f) { return m[f] || 0; };

  // a tackle is a tackle: solo and assisted each count as one, which is how
  // the conference counts them and the only way half its sheets can be read
  d.Tack = z('TackleSolo') + z('TackleAssist');
  d.TackPG = d.Tack / g;
  // departure 1 — convention detected per team, never assumed
  d.NsTFL = tflExclusive ? z('TFL') : Math.max(0, z('TFL') - z('Sacks'));
  d.DIP = d.Tack + d.NsTFL * 2.5 + z('Sacks') * 4 +
          z('FF') * 4 + z('FR') * 3 + z('PassDef') * 2 + z('Int') * 5 + z('DefTD') * 6;
  d.Disr = d.NsTFL + z('Sacks') + z('FF') + z('PassDef');
  d.DisrPG = d.Disr / g;

  const pa = z('PassAtt');
  d.CompPct = pa ? 100 * z('PassComp') / pa : null;
  d.YPA     = pa ? z('PassYds') / pa : null;
  d.TDRate  = pa ? z('PassTD') / pa : null;
  d.IntRate = pa ? z('PassInt') / pa : null;
  /* The 0-158.3 passer rating, the same formula Stats.gs and the team Stats tab
     use, so a quarterback's All-Conference score is built on the number he can
     already see on his own page. A blank companion counts as 0 inside it, as
     everywhere else here; no attempts is no rating rather than a zero one, and
     an unrated quarterback simply carries no QBRtg term. */
  d.QBRtg = pa ? (function () {
    const cl = function (v) { return Math.max(0, Math.min(2.375, v)); };
    return (cl((z('PassComp') / pa - 0.3) * 5) + cl((z('PassYds') / pa - 3) * 0.25) +
            cl((z('PassTD') / pa) * 20) + cl(2.375 - (z('PassInt') / pa) * 25)) / 6 * 100;
  })() : null;
  d.PPE = (z('PassYds') / 25 + z('PassTD') * 4 - z('PassInt') * 4) / g;
  d.PassYdsPG = z('PassYds') / g;

  const ra = z('RushAtt'), rc = z('Rec');
  d.YPC = ra ? z('RushYds') / ra : null;
  d.YPR = rc ? z('RecYds') / rc : null;
  d.RushYdsPG = z('RushYds') / g;
  d.RecYdsPG  = z('RecYds') / g;
  d.RecPG     = rc / g;
  d.Touches   = ra + rc;
  d.FumRate   = (z('RushFum') + z('RecFum')) / Math.max(1, ra + rc);

  d.Pancakes = m.Pancakes === undefined ? null : m.Pancakes;
  d.PancakesPG = z('Pancakes') / g;

  const py = z('PassYds'), ry = z('RushYds'), cy = z('RecYds');
  d.TotYds = py + ry + cy;
  d.TotYdsPG = d.TotYds / g;
  d.TotTD = z('PassTD') + z('RushTD') + z('RecTD');
  d.TouchEff = (ry + cy) / Math.max(1, ra + rc);
  const cats = [py, ry, cy].sort(function (a, b) { return b - a; });
  d.MultiDim = 100 * cats[1] / Math.max(1, cats[0]);
  d.PrimaryEff = d.TouchEff;
  return d;
}

// ── gather ─────────────────────────────────────────────────────────────────

function acGather_(seasonId) {
  const games = rowsOf_(CONFIG.TABS.GAMES);
  const conf = {}, teamAll = {}, teamConf = {};
  games.forEach(function (g) {
    if (String(g.SeasonID).trim() !== seasonId) return;
    const gid = String(g.GameID || '').trim();
    const isConf = String(g.GameType).trim() === 'CONFERENCE';
    if (isConf) conf[gid] = true;
    if (acNum_(g.HomeScore) === null) return;
    [String(g.HomeTeamID || ''), String(g.AwayTeamID || '')].forEach(function (t) {
      if (!t) return;
      teamAll[t] = (teamAll[t] || 0) + 1;
      if (isConf) teamConf[t] = (teamConf[t] || 0) + 1;
    });
  });

  const stats = rowsOf_(CONFIG.TABS.PLAYER_STATS).filter(function (r) {
    return String(r.SeasonID).trim() === seasonId;
  });

  // departure 1 — detect the TFL convention per team
  const tflExclusive = {};
  stats.forEach(function (r) {
    const t = acNum_(r.TFL), s_ = acNum_(r.Sacks);
    if (t === null || s_ === null) return;
    if (t < s_) tflExclusive[String(r.TeamID || '').trim()] = true;
  });

  // departure 6 — which defensive counts each team keeps this season: any
  // conference game row carrying the figure means the team's blanks are zeros
  const kept = {};
  stats.forEach(function (r) {
    const gid = String(r.GameID || '').trim();
    if (String(r.grain || r.Grain || '').trim() !== CONFIG.GRAIN.GAME || !conf[gid]) return;
    const t = String(r.TeamID || '').trim();
    const k = kept[t] || (kept[t] = {});
    AC_DEF_COUNTS.forEach(function (f) { if (acNum_(r[f]) !== null) k[f] = true; });
  });

  const acc = {};
  stats.forEach(function (r) {
    const pid = String(r.PlayerID || '').trim();
    const grain = String(r.grain || r.Grain || '').trim();
    if (!pid || grain === CONFIG.GRAIN.SEASON_REF) return;
    const gid = String(r.GameID || '').trim();
    if (grain === CONFIG.GRAIN.GAME && (!gid || !conf[gid])) return;   // §1.1

    var b = acc[pid];
    if (!b) b = acc[pid] = { pid: pid, tid: String(r.TeamID || '').trim(),
                             game: {}, season: {}, games: {}, hasG: false, hasS: false };
    if (!b.tid && r.TeamID) b.tid = String(r.TeamID).trim();
    const tgt = (grain === CONFIG.GRAIN.GAME) ? b.game : b.season;
    if (grain === CONFIG.GRAIN.GAME) { b.hasG = true; b.games[gid] = true; }
    else b.hasS = true;
    AC_SUM.forEach(function (f) {
      const v = acNum_(r[f]);
      if (v !== null) tgt[f] = (tgt[f] || 0) + v;
    });
  });

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return String(p.PlayerID); });
  const teams   = indexBy_(rowsOf_(CONFIG.TABS.TEAMS),   function (t) { return String(t.TeamID); });

  const posOf = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    if (String(r.SeasonID).trim() !== seasonId) return;
    posOf[String(r.PlayerID).trim()] = parsePositions_(r.Positions);
  });
  const scheduled = acScheduled_(seasonId);

  const out = [];
  Object.keys(acc).forEach(function (pid) {
    const b = acc[pid];
    const use = b.hasG ? b.game : b.season;
    if (!use || !Object.keys(use).length) return;
    var gp, provisional = false;
    if (b.hasG) {
      gp = Object.keys(b.games).length;
    } else {
      // departure 2 — a season total cannot be split conference/non-conference
      const share = (teamConf[b.tid] || 0) / Math.max(1, teamAll[b.tid] || 0);
      if (share < 0.80) return;
      gp = teamAll[b.tid] || 0;
      provisional = true;
    }
    const teamGames = teamConf[b.tid] || teamAll[b.tid] || 0;
    if (b.hasG) acFillKeptZeros_(use, kept[b.tid]);
    out.push({
      pid: pid, tid: b.tid, gp: gp, teamGames: teamGames, provisional: provisional,
      // the share of the schedule his team has played: what the thresholds scale by
      pace: acPace_(teamGames, gp, scheduled),
      grain: b.hasG ? CONFIG.GRAIN.GAME : CONFIG.GRAIN.SEASON_TOTAL,
      positions: posOf[pid] || [],
      name: String((players[pid] || {}).DisplayName || pid),
      team: String((teams[b.tid] || {}).DisplayName || b.tid),
      m: acDerive_(use, gp, !!tflExclusive[b.tid])
    });
  });
  return out;
}

// ── score one pool ─────────────────────────────────────────────────────────

/**
 * Who is in a pool. The roster listing admits a player to his position's
 * pool; the opportunity threshold and, for Athlete, the two-category gate
 * then decide whether he has done enough to be ranked there.
 *
 * Two pools ignore the listing (AC-1.5). Athlete always: the gate is the
 * whole definition of an athlete, and a coach who wrote QB for a boy who
 * runs for a hundred yards a game has not said he is not one. And any pool
 * when `byProduction` is set - that is how Ironman scores a side the roster
 * left out, and those rankings are never published as the position ballot.
 */
function acEligible_(all, pos, excluded, byProduction) {
  return all.filter(function (p) {
    if (excluded && excluded[p.pid + '|' + pos]) return false;
    // TE competes in the WR pool; everything else matches its own code
    // poolsOf() expands a major position into the specific ballots it covers,
    // so a roster that says only "LB" still reaches both linebacker pools.
    var holds = pos === 'ATH' || !!byProduction;
    for (var i = 0; i < p.positions.length && !holds; i++) {
      const pools = poolsOf_(p.positions[i]);
      for (var j = 0; j < pools.length; j++) {
        if (pools[j] === pos) { holds = true; break; }
      }
    }
    if (!holds) return false;
    if ((p.gp || 0) < 2) return false;                                  // §2.1
    // season figures, scaled to how much of the season there has been
    const k = (p.pace === undefined) ? 1 : p.pace;
    if (pos === 'ATH') {
      const cats = {};
      AC_ATH_GATE.forEach(function (g) { if ((p.m[g[0]] || 0) >= g[1] * k) cats[g[2]] = true; });
      if (Object.keys(cats).length < 2) return false;                   // §5.4
    }
    const f = AC_THRESHOLD[pos];
    return !f || f(p.m, k);
  });
}

function acScorePool_(pool, pos) {
  const w = AC_WEIGHTS[pos];
  /* A pool of one is still a pool. This used to refuse fewer than two, on the
     reasoning that one boy cannot be ranked against nobody - and two weeks
     into 2026 that emptied the ballot of every position but EDGE. Daniel
     Afriyie had 35 conference carries, the only running back who did, and
     was nowhere, because a ranking of one was thrown away rather than
     written. A boy who has met the threshold should be able to find himself:
     he ranks first, the pool size says he was alone, and the confidence label
     already says how early it is. Everything below tolerates n = 1 - the
     percentile of a single value is 50, and stabilisation averages what
     there is. */
  if (!w || !pool.length) return [];

  // work on a copy so stabilization in one pool cannot leak into another
  const rows = pool.map(function (p) {
    return { p: p, m: JSON.parse(JSON.stringify(p.m)) };
  });

  // §15 step 7 — stabilize BEFORE percentiling
  Object.keys(AC_STABILIZE).forEach(function (key) {
    const k = AC_STABILIZE[key][0], oppField = AC_STABILIZE[key][1];
    const vals = rows.filter(function (r) { return r.m[key] !== null && r.m[key] !== undefined; })
                     .map(function (r) { return r.m[key]; });
    if (!vals.length) return;
    var sum = 0; vals.forEach(function (v) { sum += v; });
    const avg = sum / vals.length;
    rows.forEach(function (r) {
      if (r.m[key] === null || r.m[key] === undefined) return;
      r.m[key] = acStabilize_(r.m[key], r.m[oppField] || 0, avg, k);
    });
  });

  const dist = {};
  w.forEach(function (spec) {
    dist[spec[0]] = rows.filter(function (r) { return r.m[spec[0]] !== null && r.m[spec[0]] !== undefined; })
                        .map(function (r) { return r.m[spec[0]]; })
                        .sort(function (a, b) { return a - b; });
  });

  const out = [];
  rows.forEach(function (r) {
    var raw = 0, wsum = 0, missing = 0;
    w.forEach(function (spec) {
      const key = spec[0], wt = spec[1], inv = spec[2];
      const v = r.m[key];
      if (v === null || v === undefined || !dist[key].length) { missing++; return; }
      var pr = acPercentile_(dist[key], v);
      if (inv) pr = 100 - pr;
      raw += wt * pr; wsum += wt;
    });
    if (!wsum) return;
    raw = raw / wsum;                                    // renormalize over reported

    const part = Math.min(1, (r.p.gp || 0) / Math.max(1, r.p.teamGames || 1));
    const avail = 0.85 + 0.15 * part;                    // §4.2
    // departure 3 — incompleteness lowers the multiplier, never deletes
    var comp = missing === 0 ? 1.00 : (missing === 1 ? 0.99 : 0.97);
    if (r.p.provisional) comp *= 0.98;

    out.push({
      pid: r.p.pid, tid: r.p.tid, name: r.p.name, team: r.p.team, pos: pos,
      gp: r.p.gp, teamGames: r.p.teamGames, provisional: r.p.provisional,
      grain: r.p.grain, positions: r.p.positions, m: r.m,
      raw: raw, avail: avail, comp: comp, missing: missing,
      score: raw * avail * comp
    });
  });

  acRank_(out);
  return out;
}

/** §10 tie-breakers, applied in order. */
function acRank_(list) {
  list.sort(function (a, b) {
    return (b.score - a.score)
        || (b.raw - a.raw)
        || ((b.m.DIP || 0) - (a.m.DIP || 0))
        || ((b.gp || 0) - (a.gp || 0))
        || String(a.name).localeCompare(String(b.name));
  });
  list.forEach(function (r, i) { r.rank = i + 1; });
  return list;
}

function acTier_(pos, rank) {
  const slots = (POS_BY_CODE[pos] || {}).slots || 0;
  if (!slots) return 'Outside';
  if (rank <= slots) return 'First Team';
  if (rank <= 2 * slots) return 'Second Team';
  if (rank <= 3 * slots) return 'Honorable Mention';
  return 'Outside';
}

const AC_TIER_ORDER = { 'First Team': 3, 'Second Team': 2, 'Honorable Mention': 1, 'Outside': 0 };

// ── duplicate resolution (§9) ──────────────────────────────────────────────

/**
 * A player may hold one offensive award and one defensive award. When he ranks
 * in the award range of two pools on the same side, he keeps the stronger and
 * is removed from the other — which promotes the next player, who may himself
 * now be duplicated. So this iterates to a fixpoint rather than resolving once.
 */
function acResolveSide_(all, positions, excluded) {
  var ranked = {};
  for (var pass = 0; pass < 12; pass++) {
    ranked = {};
    positions.forEach(function (pos) {
      ranked[pos] = acScorePool_(acEligible_(all, pos, excluded), pos);
    });

    // who is in award range in more than one pool on this side?
    const claims = {};
    positions.forEach(function (pos) {
      ranked[pos].forEach(function (r) {
        if (acTier_(pos, r.rank) === 'Outside') return;
        (claims[r.pid] = claims[r.pid] || []).push({ pos: pos, r: r });
      });
    });

    var changed = false;
    Object.keys(claims).forEach(function (pid) {
      const c = claims[pid];
      if (c.length < 2) return;
      c.sort(function (x, y) {
        const tx = AC_TIER_ORDER[acTier_(x.pos, x.r.rank)],
              ty = AC_TIER_ORDER[acTier_(y.pos, y.r.rank)];
        if (tx !== ty) return ty - tx;                       // 1. higher tier
        if (y.r.score !== x.r.score) return y.r.score - x.r.score;  // 2. higher score
        // 3. larger margin over the next player in that pool
        const mx = acMargin_(ranked[x.pos], x.r.rank), my = acMargin_(ranked[y.pos], y.r.rank);
        if (mx !== my) return my - mx;
        // 4. the position the coach listed first is primary
        const px = x.r.positions.indexOf(x.pos), py2 = y.r.positions.indexOf(y.pos);
        return (px < 0 ? 99 : px) - (py2 < 0 ? 99 : py2);
      });
      for (var i = 1; i < c.length; i++) {
        excluded[pid + '|' + c[i].pos] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return ranked;
}

function acMargin_(list, rank) {
  const me = list[rank - 1], next = list[rank];
  return (me && next) ? (me.score - next.score) : 999;
}

// ── Ironman (§7) ───────────────────────────────────────────────────────────

/**
 * A player's best score on one side: the published ranking where he has one,
 * else the stand-in ranking built from his numbers alone (AC-1.5). The
 * stand-in is marked so the note can say which it was.
 */
function acBestSide_(ranked, shadow) {
  const best = {};
  Object.keys(ranked || {}).forEach(function (pos) {
    ranked[pos].forEach(function (r) {
      if (!best[r.pid] || r.score > best[r.pid].score) best[r.pid] = r;
    });
  });
  Object.keys(shadow || {}).forEach(function (pos) {
    shadow[pos].forEach(function (r) {
      if (best[r.pid] && !best[r.pid].inferred) return;      // a listed ranking stands
      if (!best[r.pid] || r.score > best[r.pid].score) {
        const s = {}; Object.keys(r).forEach(function (k) { s[k] = r[k]; });
        s.inferred = true;
        best[r.pid] = s;
      }
    });
  });
  return best;
}

function acIronman_(all, offRanked, defRanked, offShadow, defShadow) {
  const bestOff = acBestSide_(offRanked, offShadow);
  const bestDef = acBestSide_(defRanked, defShadow);

  const out = [];
  Object.keys(bestOff).forEach(function (pid) {
    const o = bestOff[pid], d = bestDef[pid];
    if (!d) return;
    // §7.1 temporary box-score threshold, until snap counts exist
    const offOpp = (o.m.Touches || 0) + (o.m.PassAtt || 0);
    const defPlays = (d.m.NsTFL || 0) + (d.m.Sacks || 0) + (d.m.FF || 0) +
                     (d.m.FR || 0) + (d.m.PassDef || 0) + (d.m.Int || 0) + (d.m.DefTD || 0);
    if (offOpp < 25) return;
    if ((d.m.Tack || 0) < 15 && defPlays < 4) return;

    const balance = 100 * Math.min(o.score, d.score) / Math.max(1, Math.max(o.score, d.score));
    const twoWayAvail = 100 * Math.min(1, (Math.min(o.gp, d.gp) || 0) /
                                          Math.max(1, o.teamGames || 1));
    const raw = 0.40 * o.score + 0.40 * d.score + 0.15 * balance + 0.05 * twoWayAvail;
    out.push({
      pid: pid, tid: o.tid, name: o.name, team: o.team, pos: 'IRONMAN',
      gp: Math.min(o.gp, d.gp), teamGames: o.teamGames,
      provisional: o.provisional || d.provisional, grain: o.grain,
      positions: o.positions, m: o.m,
      raw: raw, avail: 1, comp: Math.min(o.comp, d.comp), missing: 0,
      score: raw * Math.min(o.comp, d.comp),
      // a * marks a side scored from his numbers alone, with no roster listing
      note: o.pos + (o.inferred ? '*' : '') + ' ' + o.score.toFixed(1) + ' / ' +
            d.pos + (d.inferred ? '*' : '') + ' ' + d.score.toFixed(1) +
            ((o.inferred || d.inferred) ? '  (* not listed there on the roster)' : '')
    });
  });
  return acRank_(out);
}

// ── projection confidence (§11) ────────────────────────────────────────────

function acConfidence_(r, scheduledConfGames) {
  const seasonC = Math.min(1, (r.teamGames || 0) / Math.max(1, scheduledConfGames || 1));
  // the unscaled question: has he already reached the full-season floor? A
  // back on pace at 8 carries is projected; one past 35 is settled.
  const thr = AC_THRESHOLD[r.pos];
  var oppC = 1;
  if (thr) oppC = thr(r.m, 1) ? 1 : 0.5;
  const verif = r.provisional ? 0.5 : 1;
  const pct = 100 * (0.50 * seasonC + 0.30 * oppC + 0.20 * verif);
  var label = 'Very Early';
  if (pct >= 90) label = 'Final-Level Confidence';
  else if (pct >= 75) label = 'Strong';
  else if (pct >= 50) label = 'Moderate';
  else if (pct >= 25) label = 'Developing';
  return { pct: Math.round(pct), label: label };
}

// ── roster coverage ────────────────────────────────────────────────────────

/**
 * How much of the conference has actually declared positions yet.
 *
 * Rosters are filled in over weeks, so every projection published before that
 * finishes is drawn from a partial field. Ranking one school's linebackers
 * against nobody produces a "First Team" that means nothing. Coverage does not
 * change any ranking — it states plainly how much of the conference the ranking
 * was drawn from, so an early projection cannot be mistaken for a settled one.
 */
function acRosterCoverage_(seasonId) {
  const teams = rowsOf_(CONFIG.TABS.TEAMS);
  const totalSchools = teams.length || 15;

  const withPos = {}, rosterOf = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    if (String(r.SeasonID).trim() !== seasonId) return;
    const tid = String(r.TeamID || '').trim();
    if (!tid) return;
    rosterOf[tid] = (rosterOf[tid] || 0) + 1;
    if (parsePositions_(r.Positions).length) withPos[tid] = (withPos[tid] || 0) + 1;
  });

  const schoolsDeclared = Object.keys(withPos).length;
  var players = 0, declared = 0;
  Object.keys(rosterOf).forEach(function (t) {
    players += rosterOf[t];
    declared += (withPos[t] || 0);
  });

  const byTeam = teams.map(function (t) {
    const tid = String(t.TeamID).trim();
    return { teamId: tid, team: String(t.DisplayName || tid),
             roster: rosterOf[tid] || 0, declared: withPos[tid] || 0 };
  }).sort(function (a, b) { return a.declared - b.declared || a.team.localeCompare(b.team); });

  const schoolPct = 100 * schoolsDeclared / Math.max(1, totalSchools);
  var label = 'Preliminary';
  if (schoolPct >= 95) label = 'Conference-Wide';
  else if (schoolPct >= 75) label = 'Broad';
  else if (schoolPct >= 40) label = 'Partial';
  return {
    seasonId: seasonId, totalSchools: totalSchools, schoolsDeclared: schoolsDeclared,
    schoolPct: Math.round(schoolPct), players: players, declared: declared,
    playerPct: Math.round(100 * declared / Math.max(1, players)),
    label: label, byTeam: byTeam
  };
}

// ── entry points ───────────────────────────────────────────────────────────

function computeAllConference_(seasonId) {
  seasonId = seasonId || CONFIG.CURRENT_SEASON;
  const all = acGather_(seasonId);

  const offPos = ['QB', 'RB', 'WR', 'OL', 'ATH'];
  const defPos = ['ILB', 'OLB', 'EDGE', 'DL', 'S', 'CB'];
  const excluded = {};

  const offRanked = acResolveSide_(all, offPos, excluded);
  const defRanked = acResolveSide_(all, defPos, excluded);

  /* Ironman's stand-in rankings (AC-1.5): every pool on each side, filled by
     the numbers alone, so a boy the roster lists on one side can still be
     scored on the other. Nothing here is published as a position ballot;
     the one-award-per-side exclusions do not apply, because these are not
     awards. Athlete is left out - it is a production pool already, and a
     two-way player's offensive side is his listed position or that. */
  const shadow = function (positions) {
    const out = {};
    positions.forEach(function (pos) {
      if (pos === 'ATH') return;
      out[pos] = acScorePool_(acEligible_(all, pos, null, true), pos);
    });
    return out;
  };
  const iron = acIronman_(all, offRanked, defRanked, shadow(offPos), shadow(defPos));

  const scheduled = acScheduled_(seasonId);

  const cov = acRosterCoverage_(seasonId);

  const rows = [];
  const emit = function (pos, list) {
    // how many distinct schools this particular pool was drawn from — the
    // number that decides whether a ranking is meaningful
    const poolSchools = {};
    list.forEach(function (r) { if (r.tid) poolSchools[r.tid] = true; });
    const nSchools = Object.keys(poolSchools).length;

    list.forEach(function (r) {
      const tier = acTier_(pos, r.rank);
      const c = acConfidence_(r, scheduled);
      rows.push({
        SeasonID: seasonId, Position: pos,
        PositionLabel: (POS_BY_CODE[pos] || {}).label || pos,
        PositionRank: r.rank, PlayerID: r.pid, PlayerName: r.name,
        TeamID: r.tid, TeamName: r.team, GamesPlayed: r.gp,
        TeamConferenceGamesPlayed: r.teamGames,
        EligibilityStatus: r.provisional ? 'Provisional' : 'Eligible',
        RawPositionScore: Math.round(r.raw * 100) / 100,
        AvailabilityMultiplier: Math.round(r.avail * 1000) / 1000,
        DataCompletenessMultiplier: Math.round(r.comp * 1000) / 1000,
        FinalPositionScore: Math.round(r.score * 100) / 100,
        ProjectedTeam: tier,
        ProjectionConfidence: c.pct, ConfidenceLabel: c.label,
        PoolSchools: nSchools, PoolSize: list.length,
        RosterCoverage: cov.schoolPct, CoverageLabel: cov.label,
        SelectedPositions: formatPositions_(r.positions),
        // a boy alone in his pool is first by default; the reader should know
        Note: r.note || (list.length === 1 ? 'Only qualifier so far' : ''),
        SourceGrain: r.grain,
        FormulaVersion: AC_FORMULA_VERSION, LastUpdated: new Date()
      });
    });
  };

  offPos.forEach(function (p) { emit(p, offRanked[p] || []); });
  defPos.forEach(function (p) { emit(p, defRanked[p] || []); });
  emit('IRONMAN', iron);
  // OL ranks on pancake blocks now — the old §5.5 non-ranking placeholder is
  // retired along with it.

  return rows;
}

function rebuildAllConference_(seasonId) {
  if (typeof appPublicDirectWrite_ === 'function' && !__appPublicWriteDepth) return appPublicDirectWrite_(function () { return rebuildAllConference_(seasonId); });
  seasonId = seasonId || CONFIG.CURRENT_SEASON;
  const rows = computeAllConference_(seasonId);
  ensureAllConferenceTab_();

  // replaceRows() rewrites the WHOLE tab, so writing one season's rows on their
  // own deletes every other season. Rebuilding each season in turn would then
  // leave only the last one standing — which is how a full pass ending on 2026,
  // a season with no games, reduced the entire ballot to a single row.
  const others = rowsOf_(AC_TAB).filter(function (r) {
    return String(r.SeasonID).trim() !== seasonId;
  });
  const n = replaceRows_(AC_TAB, others.concat(rows));

  CacheService.getScriptCache().removeAll(['ac-' + seasonId]);
  const msg = 'All-Conference rebuilt for ' + seasonId + ': ' + rows.length +
              ' rows (' + n + ' in the tab, ' + AC_FORMULA_VERSION + ')';
  Logger.log(msg);
  return msg;
}

function ensureAllConferenceTab_() {
  if (hasTab_(AC_TAB)) return;
  const cols = ['SeasonID','Position','PositionLabel','PositionRank','PlayerID','PlayerName',
    'TeamID','TeamName','GamesPlayed','TeamConferenceGamesPlayed','EligibilityStatus',
    'RawPositionScore','AvailabilityMultiplier','DataCompletenessMultiplier',
    'FinalPositionScore','ProjectedTeam','ProjectionConfidence','ConfidenceLabel',
    'PoolSchools','PoolSize','RosterCoverage','CoverageLabel',
    'SelectedPositions','Note','SourceGrain','FormulaVersion','LastUpdated'];
  const sh = db_().insertSheet(AC_TAB);
  sh.getRange(1, 1, 1, cols.length).setValues([cols])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  sh.setFrozenRows(1);
  __tabMap = null;
}

/** Read layer for the public site. */
function apiAllConference_(seasonId) {
  seasonId = seasonId || CONFIG.CURRENT_SEASON;
  return cacheGet_('ac-' + seasonId, 900, function () {
    const coverage = acRosterCoverage_(seasonId);
    if (!hasTab_(AC_TAB)) return { season: seasonId, positions: [], coverage: coverage };
    const rows = rowsOf_(AC_TAB).filter(function (r) {
      return String(r.SeasonID).trim() === seasonId;
    });
    const byPos = {}, meta = {};
    rows.forEach(function (r) {
      const p = String(r.Position);
      meta[p] = { poolSchools: acNum_(r.PoolSchools), poolSize: acNum_(r.PoolSize) };
      (byPos[p] = byPos[p] || []).push({
        rank: acNum_(r.PositionRank), playerId: String(r.PlayerID || ''),
        player: String(r.PlayerName || ''), teamId: String(r.TeamID || ''),
        team: String(r.TeamName || ''), score: acNum_(r.FinalPositionScore),
        tier: String(r.ProjectedTeam || ''), gp: acNum_(r.GamesPlayed),
        confidence: acNum_(r.ProjectionConfidence),
        confidenceLabel: String(r.ConfidenceLabel || ''),
        status: String(r.EligibilityStatus || ''),
        selected: String(r.SelectedPositions || ''), note: String(r.Note || '')
      });
    });
    const order = ['QB','RB','WR','OL','ATH','ILB','OLB','EDGE','DL','S','CB','IRONMAN'];
    return {
      season: seasonId, formulaVersion: AC_FORMULA_VERSION, coverage: coverage,
      lastBuild: (typeof buildStatus_ === 'function') ? buildStatus_().lastBuild : '',
      eligibility: acEligibilityCommon_(),
      // Every position renders a section, empty pools included — a reader
      // should see the whole ballot's shape before a single stat is filed.
      positions: order.map(function (p) {
        const slots = (POS_BY_CODE[p] || {}).slots || 0;
        const m = meta[p] || {};
        // A pool drawn from fewer schools than it awards First Team seats is not
        // a conference ranking yet. Say so next to the ranking, not in a footnote.
        const thin = slots > 0 && (m.poolSchools || 0) < Math.max(3, slots + 1);
        return { code: p, label: (POS_BY_CODE[p] || {}).label ||
                        (p === 'IRONMAN' ? 'Ironman (Two-Way)' : p),
                 slots: slots,
                 poolSchools: m.poolSchools || 0, poolSize: m.poolSize || 0,
                 thin: thin, players: byPos[p] || [],
                 formula: acFormulaFor_(p), eligibility: acEligibilityFor_(p) };
      })
    };
  });
}