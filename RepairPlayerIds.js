/* historical record comment removed */

function _rpNorm_(s_) {
  return String(s_ === null || s_ === undefined ? '' : s_)
    .toLowerCase().replace(/[^a-z]/g, '');
}

/** Build the collision plan without touching anything. */
function _rpPlan_() {
  const players = rowsOf_(CONFIG.TABS.PLAYERS);

  const byId = {};
  players.forEach(function (p) {
    const id = String(p.PlayerID || '').trim();
    if (!id) return;
    (byId[id] = byId[id] || []).push(String(p.DisplayName || '').trim());
  });

  var maxId = 0;
  Object.keys(byId).forEach(function (id) {
    const m = id.match(/(\d+)\s*$/);
    if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
  });

  const collisions = {};
  Object.keys(byId).forEach(function (id) {
    const names = byId[id].filter(function (n, i, a) { return n && a.indexOf(n) === i; });
    if (names.length > 1) collisions[id] = names;
  });

  // The first name listed keeps the original ID; every later name is renumbered.
  const assign = {};                       // oldId -> { name -> newId }
  var next = maxId;
  Object.keys(collisions).sort().forEach(function (id) {
    assign[id] = {};
    collisions[id].forEach(function (name, i) {
      if (i === 0) { assign[id][name] = id; return; }
      next++;
      var s_ = String(next);
      while (s_.length < 6) s_ = '0' + s_;
      assign[id][name] = 'PLY-' + s_;
    });
  });

  return { collisions: collisions, assign: assign, maxId: maxId, nextAfter: next };
}

/** Strip suffixes and split into comparable name parts. */
function _rpParts_(s_) {
  const toks = String(s_ === null || s_ === undefined ? '' : s_)
    .toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(function (t) { return t && ['jr', 'sr', 'ii', 'iii', 'iv'].indexOf(t) < 0; });
  if (!toks.length) return { first: '', last: '', all: '' };
  return { first: toks[0], last: toks[toks.length - 1], all: toks.join('') };
}

/**
 * Which name in `names` does this raw string refer to? '' when undecidable.
 * Walks the same ladder the import adapter uses: exact, then surname plus first
 * initial, then a surname prefix. A tie at any rung is left unresolved rather
 * than guessed — a wrong attribution here silently invents a career.
 */
function _rpResolve_(raw, names) {
  const r = _rpParts_(raw);
  if (!r.all) return '';
  const cand = names.map(function (n) { return { name: n, p: _rpParts_(n) }; });

  var hit = cand.filter(function (c) { return c.p.all === r.all; });
  if (hit.length === 1) return hit[0].name;

  // surname must agree, either outright or as a prefix ("kirby" / "kirbye")
  const surOk = cand.filter(function (c) {
    const a = c.p.last, b = r.last;
    if (!a || !b) return false;
    return a === b || (a.length >= 4 && b.length >= 4 &&
                       (a.indexOf(b) === 0 || b.indexOf(a) === 0));
  });
  if (surOk.length === 1) return surOk[0].name;

  // same surname on both sides — separate them on the first name or its initial
  if (surOk.length > 1) {
    hit = surOk.filter(function (c) {
      const a = c.p.first, b = r.first;
      if (!a || !b) return false;
      return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0 || a[0] === b[0];
    });
    if (hit.length === 1) return hit[0].name;
  }
  return '';
}

function repairPlayerIdsDryRun_() { return _rpRun_(false); }
function repairPlayerIdsApply_()  { return _rpRun_(true); }

function _rpRun_(apply) {
  const plan = _rpPlan_();
  const ids = Object.keys(plan.collisions);
  if (!ids.length) return 'No PlayerID collisions found. Nothing to repair.';

  const log = [];
  log.push((apply ? 'APPLYING' : 'DRY RUN — nothing will be written') + '\n');
  log.push('Colliding PlayerIDs: ' + ids.length);
  log.push('Highest existing ID: PLY-' + plan.maxId + '  ->  new IDs run to PLY-' + plan.nextAfter);

  // ── PlayerGameStats ──────────────────────────────────────────────────────
  const statSheet = getTab_(CONFIG.TABS.PLAYER_STATS);
  const stats = statSheet.getDataRange().getValues();
  const sh = stats[0].map(String);
  const cPid = sh.indexOf('PlayerID'), cRaw = sh.indexOf('player_raw');
  if (cPid < 0 || cRaw < 0) throw new Error('PlayerGameStats is missing PlayerID or player_raw.');

  var moved = 0, kept = 0;
  const unresolved = [];
  const statCol = [];
  for (var i = 1; i < stats.length; i++) {
    const id = String(stats[i][cPid] || '').trim();
    const map = plan.assign[id];
    if (!map) { statCol.push([stats[i][cPid]]); continue; }
    const name = _rpResolve_(stats[i][cRaw], plan.collisions[id]);
    if (!name) {
      unresolved.push('  row ' + (i + 1) + '  ' + id + '  raw="' + stats[i][cRaw] +
                      '"  candidates: ' + plan.collisions[id].join(' | '));
      statCol.push([stats[i][cPid]]);
      continue;
    }
    const newId = map[name];
    if (newId !== id) moved++; else kept++;
    statCol.push([newId]);
  }
  log.push('\nPlayerGameStats: ' + kept + ' rows keep their ID, ' + moved +
           ' rows move to a new ID, ' + unresolved.length + ' unresolved.');

  // ── PlayerSeasons ────────────────────────────────────────────────────────
  const psSheet = getTab_(CONFIG.TABS.PLAYER_SEASONS);
  const ps = psSheet.getDataRange().getValues();
  const ph = ps[0].map(String);
  const pPid = ph.indexOf('PlayerID'), pName = ph.indexOf('DisplayName'),
        pSeason = ph.indexOf('SeasonID');

  // Two thirds of PlayerSeasons rows carry no name. They are attributed from the
  // stat rows just split above: which season, and which team, each new ID landed
  // on. Team is the stronger signal — colliding players are almost always at
  // different schools.
  const pTeam = ph.indexOf('TeamID');
  const cStatSeason = sh.indexOf('SeasonID'), cStatTeam = sh.indexOf('TeamID');
  const seasonOf = {}, teamOf = {};
  for (var j = 1; j < stats.length; j++) {
    const nid = statCol[j - 1][0];
    if (!nid) continue;
    (seasonOf[nid] = seasonOf[nid] || {})[String(stats[j][cStatSeason] || '')] = true;
    if (cStatTeam >= 0)
      (teamOf[nid] = teamOf[nid] || {})[String(stats[j][cStatTeam] || '')] = true;
  }

  var psMoved = 0; const psUnresolved = [];
  const psCol = [];
  for (var k = 1; k < ps.length; k++) {
    const id = String(ps[k][pPid] || '').trim();
    const map = plan.assign[id];
    if (!map) { psCol.push([ps[k][pPid]]); continue; }
    var name = pName >= 0 ? _rpResolve_(ps[k][pName], plan.collisions[id]) : '';

    if (!name) {
      const season = pSeason >= 0 ? String(ps[k][pSeason] || '') : '';
      const team   = pTeam   >= 0 ? String(ps[k][pTeam]   || '') : '';
      var cands = Object.keys(map);
      if (season) cands = cands.filter(function (nm) {
        const nid = map[nm];
        return seasonOf[nid] && seasonOf[nid][season];
      });
      if (cands.length > 1 && team) cands = cands.filter(function (nm) {
        const nid = map[nm];
        return teamOf[nid] && teamOf[nid][team];
      });
      if (cands.length === 1) name = cands[0];
    }
    if (!name) {
      psUnresolved.push('  row ' + (k + 1) + '  ' + id + '  season=' +
        (pSeason >= 0 ? ps[k][pSeason] : '?') + '  team=' +
        (pTeam >= 0 ? ps[k][pTeam] : '?') + '  candidates: ' + plan.collisions[id].join(' | '));
      psCol.push([ps[k][pPid]]);
      continue;
    }
    if (map[name] !== id) psMoved++;
    psCol.push([map[name]]);
  }
  log.push('PlayerSeasons:   ' + psMoved + ' rows move to a new ID, ' +
           psUnresolved.length + ' unresolved.');

  // ── Players ──────────────────────────────────────────────────────────────
  const plSheet = getTab_(CONFIG.TABS.PLAYERS);
  const pl = plSheet.getDataRange().getValues();
  const lh = pl[0].map(String);
  const lPid = lh.indexOf('PlayerID'), lName = lh.indexOf('DisplayName');
  const plCol = [];
  const usedName = {};
  for (var q = 1; q < pl.length; q++) {
    const id = String(pl[q][lPid] || '').trim();
    const map = plan.assign[id];
    if (!map) { plCol.push([pl[q][lPid]]); continue; }
    const nm = String(pl[q][lName] || '').trim();
    plCol.push([map[nm] !== undefined ? map[nm] : pl[q][lPid]]);
    usedName[id + '|' + nm] = true;
  }

  if (unresolved.length) log.push('\nUNRESOLVED PlayerGameStats rows:\n' + unresolved.slice(0, 40).join('\n') +
    (unresolved.length > 40 ? '\n  ...and ' + (unresolved.length - 40) + ' more' : ''));
  if (psUnresolved.length) log.push('\nUNRESOLVED PlayerSeasons rows:\n' + psUnresolved.slice(0, 40).join('\n') +
    (psUnresolved.length > 40 ? '\n  ...and ' + (psUnresolved.length - 40) + ' more' : ''));

  if (!apply) {
    log.push('\nNothing was written. Review the unresolved rows above, then run ' +
             'repairPlayerIdsApply_().');
    const out = log.join('\n');
    Logger.log(out);
    return out;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Database busy — try again.');
  try {
    if (statCol.length) statSheet.getRange(2, cPid + 1, statCol.length, 1).setValues(statCol);
    if (psCol.length)   psSheet.getRange(2, pPid + 1, psCol.length, 1).setValues(psCol);
    if (plCol.length)   plSheet.getRange(2, lPid + 1, plCol.length, 1).setValues(plCol);
  } finally {
    lock.releaseLock();
  }

  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot']);
  log.push('\nWritten. Now run rebuildDerived_() — every career and season total ' +
           'computed before this repair was built on merged identities.');
  const out = log.join('\n');
  Logger.log(out);
  return out;
}
