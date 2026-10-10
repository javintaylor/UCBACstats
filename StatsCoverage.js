/**
 * UCBAC Stats — StatsCoverage.gs
 *
 * Which box scores are actually IN, said by a person rather than guessed.
 *
 * A defence's "allowed" figures are read off the other side's box score: a
 * team's rushing yards allowed ARE its opponent's rushing yards. That makes
 * the allowed board only as honest as the opponent's filing, and the failure
 * is silent and backwards — a school whose opponent filed one carry for five
 * yards leads the conference in fewest rushing yards allowed, and looks like
 * the best run defence in two counties.
 *
 * The old guard asked "did every counted game report this field". A one-carry
 * fragment DOES report rushing yards, so the guard passed. Presence is not
 * completeness, and no threshold on volume or points can tell a fragment from
 * a real low-output night without sometimes being wrong in both directions.
 *
 * So it is not inferred. An administrator ticks a box per team per game — "the
 * whole box score for this team in this game is in" — and a game nobody has
 * ticked contributes nothing to the opponent's allowed figures. Unticked is
 * the default, because the alternative is to assume completeness, and assuming
 * completeness is the bug.
 *
 * It gates ONLY what depends on somebody else's filing. A team's own numbers
 * appear on the leaderboards whether or not their box score is complete: an
 * incomplete box score is still real production, and hiding it would lose true
 * numbers to fix a different problem.
 */

const STATSCOV = {
  TAB: 'StatsCoverage',
  COLUMNS: ['GameID', 'TeamID', 'SeasonID', 'Week', 'Phase',
            'Complete', 'MarkedBy', 'MarkedAt', 'Note'],
  /* An allowed figure built from one or two games is not a season's worth of
     anything, and on a board that ranks TOTALS it would lead by having played
     less. Below this a team is dropped from the allowed board and named in
     the footnotes rather than left in to win on a technicality. */
  MIN_GAMES: 3
};

function statsCovKey_(gameId, teamId) { return s_(gameId) + '|' + s_(teamId); }

function statsCovEnsureTab_() {
  if (hasTab_(STATSCOV.TAB)) return false;
  const sh = db_().insertSheet(STATSCOV.TAB);
  sh.getRange(1, 1, 1, STATSCOV.COLUMNS.length).setValues([STATSCOV.COLUMNS])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  sh.setFrozenRows(1);
  __tabMap = null;
  return true;
}

/**
 * GameID|TeamID -> true, for every box score marked complete.
 *
 * Absence is the answer for everything else, which is the whole point: a game
 * nobody has looked at is not complete, and a tab that does not exist yet
 * means nothing is.
 */
var __statsCovMap = null;
function statsCovMap_() {
  if (__statsCovMap) return __statsCovMap;
  const map = {};
  if (hasTab_(STATSCOV.TAB)) {
    rowsOf_(STATSCOV.TAB).forEach(function (r) {
      if (!isTrue_(r.Complete)) return;
      const g = s_(r.GameID), t = s_(r.TeamID);
      if (g && t) map[statsCovKey_(g, t)] = true;
    });
  }
  __statsCovMap = map;
  return map;
}

/** Is THIS team's box score for THIS game in? */
function statsCovComplete_(gameId, teamId) {
  return !!statsCovMap_()[statsCovKey_(gameId, teamId)];
}

// ── the admin's grid ────────────────────────────────────────────────────────

function statsCovAssertAdmin_() {
  const me = (typeof rosterWho_ === 'function') ? rosterWho_() : whoami_();
  if (!me || me.role !== 'ADMIN') throw new Error('Administrators only.');
  return me;
}

/** Every conference game in a season, oldest first, with both sides named. */
function statsCovGames_(seasonId) {
  const teams = statsTeamIndex_();
  const out = [];
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (s_(g.SeasonID) !== seasonId) return;
    const home = s_(g.HomeTeamID), away = s_(g.AwayTeamID);
    // Both sides ours, or the allowed figure can never be built from it at all
    // and there is nothing for anybody to tick.
    if (!teams[home] || !teams[away]) return;
    out.push({ id: s_(g.GameID), week: num_(g.Week), phase: s_(g.Phase),
               order: gameOrder_(g), home: home, away: away,
               hs: numOrNull_(g.HomeScore), as: numOrNull_(g.AwayScore) });
  });
  out.sort(function (a, b) { return a.order - b.order; });
  return out;
}

/* Neither the grid nor the evidence is built here.
   apiStatsTracker in TeamAdmin.gs puts statsIn on every row it already draws,
   because it IS the same grid: the same school, the same week, the same game.
   A second checklist meant reading the same fifteen rows twice to answer "did
   it come in" and then "was all of it there" — and the tracker's own boxes
   already say what arrived, in more detail than a count of lines ever did. */

/**
 * Tick or untick. `marks` is [{gameId, teamId, complete}].
 *
 * The whole tab is rewritten in one go rather than cell by cell: it is a few
 * hundred rows at most, and a single write cannot leave half a save behind.
 */
function apiSetStatsCoverage_(marks) {
  const me = statsCovAssertAdmin_();
  if (!marks || !marks.length) return { saved: 0, message: 'Nothing to save.' };
  statsCovEnsureTab_();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');
  try {
    const games = indexBy_(rowsOf_(CONFIG.TABS.GAMES), function (g) { return s_(g.GameID); });
    const existing = {};
    rowsOf_(STATSCOV.TAB).forEach(function (r) {
      const k = statsCovKey_(r.GameID, r.TeamID);
      if (k !== '|') existing[k] = r;
    });

    const stamp = new Date().toISOString();
    var saved = 0;
    marks.forEach(function (m) {
      const gid = s_(m.gameId), tid = s_(m.teamId);
      if (!gid || !tid) return;
      const g = games[gid];
      if (!g) return;                       // a tick for a game that is not there
      const k = statsCovKey_(gid, tid);
      const row = existing[k] || (existing[k] = { GameID: gid, TeamID: tid });
      row.SeasonID = s_(g.SeasonID);
      row.Week = num_(g.Week);
      row.Phase = s_(g.Phase);
      row.Complete = m.complete ? 'TRUE' : 'FALSE';
      row.MarkedBy = s_(me.email) || s_(me.userId) || 'admin';
      row.MarkedAt = stamp;
      saved++;
    });

    const out = Object.keys(existing).map(function (k) {
      const r = existing[k];
      const o = {};
      STATSCOV.COLUMNS.forEach(function (c) { o[c] = (r[c] === undefined ? '' : r[c]); });
      return o;
    });
    replaceRows_(STATSCOV.TAB, out, STATSCOV.COLUMNS);
    __statsCovMap = null;
    try { clearApiCache_(); } catch (ignore) {}
    return { saved: saved, message: saved + ' game' + (saved === 1 ? '' : 's') + ' updated.' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Mark every played conference game in a season as received.
 *
 * For the seasons that are already history: they were imported wholesale and
 * are as complete as they are ever going to be, and leaving them unticked
 * would empty the allowed board for every year on the site. Going forward the
 * checklist is kept week by week.
 */
function apiBaselineStatsCoverage_(seasonId) {
  statsCovAssertAdmin_();
  seasonId = s_(seasonId) || CONFIG.CURRENT_SEASON;
  const marks = [];
  statsCovGames_(seasonId).forEach(function (g) {
    if (g.hs === null || g.as === null) return;      // not played is not received
    marks.push({ gameId: g.id, teamId: g.home, complete: true });
    marks.push({ gameId: g.id, teamId: g.away, complete: true });
  });
  if (!marks.length) return { saved: 0, message: 'No played conference games in ' + seasonId + '.' };
  const r = apiSetStatsCoverage_(marks);
  return { saved: r.saved,
           message: 'Baselined ' + seasonId + ': ' + r.saved + ' team-games marked received.' };
}

// ── from the spreadsheet menu ───────────────────────────────────────────────

function menuBaselineCoverage() {
  const ui = SpreadsheetApp.getUi();
  const seasons = rowsOf_(CONFIG.TABS.SEASONS).map(function (r) { return s_(r.SeasonID); })
    .filter(Boolean);
  const ask = ui.prompt('Baseline stats coverage',
    'Mark every PLAYED conference game in a season as "stats received", so the ' +
    'Allowed boards can be built from it.\n\nSeasons: ' + seasons.join(', ') +
    '\n\nType one season ID, or ALL:', ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;
  const want = s_(ask.getResponseText()).toUpperCase();
  if (!want) return;

  statsCovEnsureTab_();
  const list = (want === 'ALL') ? seasons : [s_(ask.getResponseText())];
  const said = [];
  list.forEach(function (sid) {
    const marks = [];
    statsCovGames_(sid).forEach(function (g) {
      if (g.hs === null || g.as === null) return;
      marks.push({ gameId: g.id, teamId: g.home, complete: true });
      marks.push({ gameId: g.id, teamId: g.away, complete: true });
    });
    if (!marks.length) { said.push(sid + ': no played conference games'); return; }
    said.push(sid + ': ' + statsCovWriteDirect_(marks) + ' team-games');
  });
  ui.alert('Stats coverage', said.join('\n') + '\n\nThe Allowed boards refresh within 15 minutes.',
           ui.ButtonSet.OK);
}

/**
 * The same write as apiSetStatsCoverage, without the sign-in check.
 *
 * The menu already runs as the workbook's owner — there is no portal session
 * behind it to check a role against, and asking for one would make the menu
 * item impossible to use from the very place the data lives.
 */
function statsCovWriteDirect_(marks) {
  statsCovEnsureTab_();
  const games = indexBy_(rowsOf_(CONFIG.TABS.GAMES), function (g) { return s_(g.GameID); });
  const existing = {};
  rowsOf_(STATSCOV.TAB).forEach(function (r) {
    const k = statsCovKey_(r.GameID, r.TeamID);
    if (k !== '|') existing[k] = r;
  });
  const stamp = new Date().toISOString();
  var n = 0;
  marks.forEach(function (m) {
    const gid = s_(m.gameId), tid = s_(m.teamId);
    const g = games[gid];
    if (!gid || !tid || !g) return;
    const k = statsCovKey_(gid, tid);
    const row = existing[k] || (existing[k] = { GameID: gid, TeamID: tid });
    row.SeasonID = s_(g.SeasonID);
    row.Week = num_(g.Week);
    row.Phase = s_(g.Phase);
    row.Complete = m.complete ? 'TRUE' : 'FALSE';
    row.MarkedBy = 'menu';
    row.MarkedAt = stamp;
    n++;
  });
  const out = Object.keys(existing).map(function (k) {
    const r = existing[k], o = {};
    STATSCOV.COLUMNS.forEach(function (c) { o[c] = (r[c] === undefined ? '' : r[c]); });
    return o;
  });
  replaceRows_(STATSCOV.TAB, out, STATSCOV.COLUMNS);
  __statsCovMap = null;
  try { clearApiCache_(); } catch (ignore) {}
  return n;
}
