/** Calendar periods and deterministic fantasy projections. Public statistics only. */
var __fantasyCalendar = null;
var __fantasyForecasts = {};

function fantasyCalendar_() {
  if (__fantasyCalendar) return __fantasyCalendar;
  const today = apiTodayStr_(), currentSeason = CONFIG.CURRENT_SEASON;
  // UTC arithmetic on an already localized date avoids DST and server-zone drift.
  const day = new Date(today + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const monday = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 6);
  const sunday = day.toISOString().slice(0, 10);
  const bySeason = {}, games = {}, currentGames = [];
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    const sid = s_(g.SeasonID), key = periodKey_(g), id = s_(g.GameID);
    if (id) games[id] = g;
    if (!sid || !key) return;
    if (!bySeason[sid]) bySeason[sid] = {};
    const date = apiDateStr_(g.GameDate);
    var p = bySeason[sid][key];
    if (!p) p = bySeason[sid][key] = {
      key: key, label: isPlayoffPhase_(g) ? playoffRoundLabel_(num_(g.Week)) : 'Week ' + num_(g.Week),
      seasonId: sid, order: gameOrder_(g), date: date || '', inWeek: 0
    };
    if (date && (!p.date || date < p.date)) p.date = date;
    if (date && date >= monday && date <= sunday) p.inWeek++;
    if (sid === currentSeason) currentGames.push(g);
  });
  // Match Home: the first dated, unscored upcoming game determines the period.
  // An undated old fixture must not pin the forecast to an abandoned week.
  const upcoming = currentGames.filter(function (g) {
    const date = apiDateStr_(g.GameDate);
    return (numOrNull_(g.HomeScore) === null || numOrNull_(g.AwayScore) === null) && (!date || date >= today);
  }).sort(function (a, b) {
    const ad = apiDateStr_(a.GameDate), bd = apiDateStr_(b.GameDate);
    return (ad || '9999').localeCompare(bd || '9999') || gameOrder_(a) - gameOrder_(b);
  });
  const periods = Object.keys(bySeason[currentSeason] || {}).map(function (key) {
    return bySeason[currentSeason][key];
  }).sort(function (a, b) { return a.order - b.order; });
  const next = upcoming.length ? bySeason[currentSeason][periodKey_(upcoming[0])] : null;
  const thisWeek = periods.filter(function (p) { return p.inWeek; })
    .sort(function (a, b) { return b.inWeek - a.inWeek || b.order - a.order; });
  const current = thisWeek[0] || next || periods[periods.length - 1] || null;
  const nextTeams = {};
  upcoming.forEach(function (g) {
    if (!next || periodKey_(g) !== next.key) return;
    [s_(g.HomeTeamID), s_(g.AwayTeamID)].forEach(function (tid) {
      nextTeams[tid] = (nextTeams[tid] || 0) + 1;
    });
  });
  return (__fantasyCalendar = { today: today, bySeason: bySeason, games: games,
    current: current, next: next, nextTeams: nextTeams });
}

/** Count a recorded zero, but never convert an entirely unreported side to zero. */
function fantasyHasReported_(sums, side) {
  return FANTASY_RULES.some(function (rule) {
    return rule.side === side && rule.fields.some(function (f) { return numOrNull_(sums[f]) !== null; });
  });
}

/** Combine category rows within a game before counting one appearance. */
function fantasyGameSource_(accept, side) {
  const cal = fantasyCalendar_(), perGame = {}, seasons = {};
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    if (s_(r.grain || r.Grain) !== CONFIG.GRAIN.GAME) return;
    const g = cal.games[s_(r.GameID)], pid = s_(r.PlayerID), tid = s_(r.TeamID);
    if (!g || !pid || !tid || !accept(g) || s_(r.SeasonID) !== s_(g.SeasonID)) return;
    const key = pid + '|' + s_(g.GameID) + '|' + tid;
    var b = perGame[key];
    if (!b) b = perGame[key] = { PlayerID: pid, TeamID: tid, SeasonID: s_(g.SeasonID), sums: {}, prov: false };
    addInto_(b.sums, r);
    if (provisionalSource_(r.SourceType)) b.prov = true;
  });
  Object.keys(perGame).forEach(function (key) {
    const g = perGame[key];
    if (!fantasyHasReported_(g.sums, side)) return;
    const skey = g.PlayerID + '|' + g.SeasonID + '|' + g.TeamID;
    var b = seasons[skey];
    if (!b) b = seasons[skey] = { PlayerID: g.PlayerID, TeamID: g.TeamID,
      SeasonID: g.SeasonID, GamesPlayed: 0, Provisional: 'FALSE' };
    b.GamesPlayed++;
    addInto_(b, g.sums);
    if (g.prov) b.Provisional = 'TRUE';
  });
  return { rows: Object.keys(seasons).map(function (key) { return seasons[key]; }), source: 'Game-level records' };
}

function fantasyPeriodFields_(q, ctx) {
  const cal = fantasyCalendar_(), options = [];
  ctx.seasonIdx.newestFirst.forEach(function (sid) {
    const season = ctx.seasonIdx.byId[sid], label = season ? season.label : sid;
    options.push({ value: sid, label: label + ' season' });
    Object.keys(cal.bySeason[sid] || {}).map(function (k) { return cal.bySeason[sid][k]; })
      .sort(function (a, b) { return a.order - b.order; }).forEach(function (p) {
        options.push({ value: sid + '@' + p.key, label: label + ' · ' + p.label });
      });
  });
  const sid = ctx.seasonIdx.byId[q.seasonId];
  const period = q.timeRange === 'WEEK' && (cal.bySeason[q.seasonId] || {})[q.weekKey];
  const nextSeason = ctx.seasonIdx.byId[CONFIG.CURRENT_SEASON];
  return {
    weekKey: q.weekKey || '', timeOptions: options,
    currentWeekLabel: cal.current ? (nextSeason ? nextSeason.label : CONFIG.CURRENT_SEASON) + ' · ' + cal.current.label : '',
    periodLabel: q.timeRange === 'WEEK' ? (sid ? sid.label : q.seasonId) + ' · ' + (period ? period.label : 'No scheduled week') : '',
    prediction: { seasonId: CONFIG.CURRENT_SEASON, weekKey: cal.next ? cal.next.key : '',
      label: cal.next ? (nextSeason ? nextSeason.label : CONFIG.CURRENT_SEASON) + ' · ' + cal.next.label : 'No upcoming week',
      method: 'Average fantasy points per recorded game this season, before the upcoming week. Multiplied by scheduled games if a team plays more than once. No estimate without prior game records or an upcoming fixture.' }
  };
}

/** Projections do not depend on the year/week the visitor is viewing. */
function fantasyForecast_(q, ctx) {
  const key = q.scope + '|' + q.side;
  if (__fantasyForecasts[key]) return __fantasyForecasts[key];
  const next = fantasyCalendar_().next;
  // All counties, teams and historical filters share the same public forecast.
  // Cache it independently so each new filter does not rescan prior games.
  return (__fantasyForecasts[key] = cacheGet_(FANTASY_CACHE_PREFIX + 'forecast|' +
    apiTodayStr_() + '|' + CONFIG.CURRENT_SEASON + '|' + (next ? next.key + '|' + next.date : 'none') + '|' + key, FANTASY_CACHE_TTL,
    function () { return fantasyForecastBuild_(q, ctx); }));
}

function fantasyForecastBuild_(q, ctx) {
  const cal = fantasyCalendar_(), out = { byId: {}, candidates: [] };
  if (!cal.next) return out;
  const sid = CONFIG.CURRENT_SEASON;
  function earlier(g) {
    if (s_(g.SeasonID) !== sid || gameOrder_(g) >= cal.next.order) return false;
    const date = apiDateStr_(g.GameDate);
    // Undated games cannot establish that a performance precedes the forecast.
    if (!date || date > cal.today || (cal.next.date && date >= cal.next.date)) return false;
    if (q.scope === 'TEAM' && (numOrNull_(g.HomeScore) === null || numOrNull_(g.AwayScore) === null)) return false;
    if (date === cal.today && (numOrNull_(g.HomeScore) === null || numOrNull_(g.AwayScore) === null)) return false;
    return true;
  }
  const hist = { seasonIdx: ctx.seasonIdx, seasons: [sid], inRange: {}, excluded: [],
    teams: ctx.teams, inferredPositions: 0, keepZero: true, acceptGame: earlier };
  hist.inRange[sid] = true;
  const team = q.scope === 'TEAM';
  if (!team) hist.playerSource = fantasyGameSource_(earlier, q.side);
  const rows = team ? fantasyTeamAccum_({ side: 'DEFENSE' }, hist)
    : fantasyAccum_({ side: q.side }, hist);
  const roster = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    if (s_(r.SeasonID) === sid) roster[s_(r.PlayerID)] = r;
  });
  rows.forEach(function (r) {
    const ps = roster[r.playerId], tid = team ? r.teamId : ps ? s_(ps.TeamID) : '';
    if (!tid || !cal.nextTeams[tid] || !r.gp || r.fppg === null) return;
    const t = ctx.teams[tid];
    // A past player's history must not imply that he is on this year's roster.
    if (!team && (!ps || !t)) return;
    const prediction = fantasyRound_(r.fpts / r.gp * cal.nextTeams[tid]);
    const item = { value: prediction, games: r.gp, scheduledGames: cal.nextTeams[tid], provisional: r.prov,
      team: t ? t.name : tid };
    out.byId[r.playerId] = item;
    const copy = Object.assign({}, r, { teamId: tid, team: t ? t.name : r.team,
      county: t ? t.county : r.county, positions: team ? '' : formatPositions_(parsePositions_(ps.Positions)),
      fpts: null, fppg: null, gp: null, cats: {}, lines: [], prov: false,
      prediction: prediction, predictionGames: r.gp, predictionProvisional: r.prov });
    out.candidates.push(copy);
  });
  return out;
}

/** Actual rows plus eligible forecasts while a current/upcoming week is unplayed. */
function fantasyRows_(q, ctx) {
  const team = q.scope === 'TEAM';
  var rows = !ctx.seasons.length ? [] : team ? fantasyTeamAccum_(q, ctx) : fantasyAccum_(q, ctx);
  const forecast = fantasyForecast_(q, ctx), cal = fantasyCalendar_(), seen = {};
  rows.forEach(function (r) { seen[r.playerId] = true; });
  if (q.timeRange === 'WEEK' && q.seasonId === CONFIG.CURRENT_SEASON &&
      ((cal.current && q.weekKey === cal.current.key) || (cal.next && q.weekKey === cal.next.key))) {
    forecast.candidates.forEach(function (r) {
      if (seen[r.playerId] || (q.playerId && q.playerId !== r.playerId)) return;
      if (q.teamId && q.teamId !== r.teamId) return;
      if (q.county && q.county !== r.county) return;
      if (q.position && !positionMatches_(parsePositions_(r.positions), q.position)) return;
      rows.push(Object.assign({}, r));
    });
  }
  rows.forEach(function (r) {
    const p = forecast.byId[r.playerId];
    r.prediction = p ? p.value : null;
    r.predictionGames = p ? p.games : 0;
    r.predictionProvisional = p ? p.provisional : false;
    r.predictionTeam = p ? p.team : '';
  });
  return rows;
}

/** One request for the Fantasy view, including its filters on the first visit. */
function apiFantasyView_(query, id, includeFilters) {
  const q = query || {};
  const data = id ? (String(q.scope).toUpperCase() === 'TEAM' ? apiFantasyTeam_(id, q) : apiFantasyPlayer_(id, q)) : apiFantasy_(q);
  return { data: data, filters: includeFilters ? apiStatsFilters_() : null };
}
