/**
 * UCBAC Stats — TeamHistory.gs
 *
 * Fifty years of season records, and the all-time line drawn from them.
 *
 * The rows live on the TeamHistory tab: one per team per season, 1976 to the
 * last completed year, carrying W/L/T and a Status that says how much the row
 * is worth:
 *
 *   VERIFIED    a record from a cited source
 *   UNVERIFIED  the season happened, the record is not established
 *   NA          the school fielded no varsity team that year
 *   CANCELLED   a season nobody played (2020)
 *
 * Only VERIFIED rows enter the all-time record, and the page says how many
 * seasons that is out of how many the program has played. A .559 built from
 * 47 of 50 seasons is a fact; the same number presented as fifty years of
 * football is not, and the difference is the whole reason Status is stored
 * rather than thrown away at import.
 *
 * Seasons the tab does not cover but this site does — the current one, and
 * every one after it — are read from Standings instead, so the record grows
 * on its own as scores are entered and the tab never needs a yearly edit.
 */

const TEAM_HISTORY = { TAB: 'TeamHistory' };

/** Year of a SeasonID ('SEA-2026' -> 2026), or 0. */
function thYear_(seasonId) {
  const m = String(seasonId || '').match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

/**
 * Every season on file for one team, newest first: the stored history, plus
 * any season this site has played that the history does not name.
 */
function teamHistory_(teamId) {
  teamId = s_(teamId);
  const out = [], seen = {};

  if (hasTab_(TEAM_HISTORY.TAB)) {
    rowsOf_(TEAM_HISTORY.TAB).forEach(function (r) {
      if (s_(r.TeamID) !== teamId) return;
      const yr = num_(r.Season);
      if (!yr) return;
      seen[yr] = true;
      const st = s_(r.Status).toUpperCase() || 'UNVERIFIED';
      out.push({
        year: yr, status: st,
        w: st === 'VERIFIED' ? num_(r.W) || 0 : null,
        l: st === 'VERIFIED' ? num_(r.L) || 0 : null,
        t: st === 'VERIFIED' ? num_(r.T) || 0 : null,
        source: s_(r.Source), live: false
      });
    });
  }

  // seasons this site computes for itself, where the tab is silent
  rowsOf_(CONFIG.TABS.SEASONS).forEach(function (sn) {
    const sid = s_(sn.SeasonID), yr = thYear_(sid);
    if (!yr || seen[yr]) return;
    const st = (typeof apiStandings_ === 'function' ? apiStandings_(sid) : [])
      .filter(function (x) { return s_(x.teamId) === teamId; })[0];
    if (!st) return;
    const played = (num_(st.w) || 0) + (num_(st.l) || 0) + (num_(st.t) || 0);
    out.push({
      year: yr, status: played ? 'VERIFIED' : 'CANCELLED',
      w: played ? num_(st.w) || 0 : null,
      l: played ? num_(st.l) || 0 : null,
      t: played ? num_(st.t) || 0 : null,
      source: 'This site', live: true
    });
  });

  out.sort(function (a, b) { return b.year - a.year; });
  return out;
}

/**
 * What the current head coach's teams have done, from the year he took the
 * program to now.
 *
 * Needs a start year, and most of the conference has not published one, so
 * this returns null far more often than not — which is the point. A record
 * headed by a coach's name has to cover his tenure and only his tenure; a
 * guess at when it began would put someone else's seasons under his name.
 */
function teamCoachRecord_(teamId, rows) {
  if (typeof coachHeadRowFor_ !== 'function') return null;
  const t = rowsOf_(CONFIG.TABS.TEAMS).filter(function (x) { return s_(x.TeamID) === s_(teamId); })[0];
  if (!t) return null;
  const row = coachHeadRowFor_(s_(teamId), t) || {};
  const name = s_(row.DisplayName) || s_(t.HeadCoach);
  const since = num_(row.HCSince);
  if (!name || !since) return null;

  rows = rows || teamHistory_(teamId);
  var w = 0, l = 0, tt = 0, known = 0, unknown = 0;
  rows.forEach(function (r) {
    if (r.year < since || r.status === 'NA' || r.status === 'CANCELLED') return;
    if (r.status !== 'VERIFIED') { unknown++; return; }
    known++; w += r.w || 0; l += r.l || 0; tt += r.t || 0;
  });
  if (!known) return null;
  const games = w + l + tt;
  return { name: name, since: since, w: w, l: l, t: tt,
           pct: games ? (w + 0.5 * tt) / games : null,
           seasons: known, unknown: unknown };
}

/**
 * The all-time line. Wins, losses, ties and a percentage over the seasons
 * whose records are established, and the counts a reader needs to judge it:
 * how many seasons that was, and how many are still unaccounted for.
 */
function teamAllTime_(teamId, rows) {
  rows = rows || teamHistory_(teamId);
  var w = 0, l = 0, t = 0, known = 0, unknown = 0, played = 0;
  var first = 0, last = 0;
  rows.forEach(function (r) {
    if (r.status === 'NA' || r.status === 'CANCELLED') return;
    played++;
    if (!first || r.year < first) first = r.year;
    if (r.year > last) last = r.year;
    if (r.status !== 'VERIFIED') { unknown++; return; }
    known++; w += r.w || 0; l += r.l || 0; t += r.t || 0;
  });
  const games = w + l + t;
  return {
    w: w, l: l, t: t,
    pct: games ? (w + 0.5 * t) / games : null,
    seasons: known, unknown: unknown, played: played,
    first: first || null, last: last || null
  };
}
