/**
 * UCBAC Stats — ResolveStats.gs
 *
 * Thirty percent of the imported stat rows never resolved to a PlayerID — the
 * source workbooks spelled names one way and the rosters another. Those rows
 * still count in team totals (keyed on the raw name), but the PLAYER pages and
 * player leaderboards can only show rows that name a player, so every one of
 * them is a player "missing" from a leaderboard he earned a place on.
 *
 * Two passes, both menu-driven with a dry run:
 *
 *   RESOLVE — attach orphaned rows to players who already exist. Three tiers,
 *   each exact and each accepted only when it matches exactly ONE player:
 *     1. the whole normalized name  ("aaron dixon" = "Aaron Dixon")
 *     2. first + last token, same team  ("Jaxon Simms" = 'Jaxon "JJ" Simms')
 *     3. first initial + last token, same team  ("G. Johnson" = Gary Johnson)
 *   Anything matching two players is left alone and listed — guessing between
 *   two boys with one name attributes one boy's season to the other.
 *
 *   CREATE — for raw names that match nobody, create the player and seat him
 *   for the seasons his rows cover. These are mostly 2024 players who predate
 *   every imported roster. Some will be misspellings of players who do exist
 *   ("Cole Lindeblad" / "Cole Lindelad"); creating them makes their production
 *   visible today, and the merge tool folds a misspelling into the real career
 *   the day somebody spots it. Invisible production helps nobody.
 */

function resolveStatsDryRun_()  { return resolveStatsRun_(false); }
function resolveStatsApply_()   { return resolveStatsRun_(true); }
function menuResolveStatsDry()   { return rsAlert_(resolveStatsRun_(false)); }
function menuResolveStatsApply() { return rsAlert_(resolveStatsRun_(true)); }
function rsAlert_(msg) {
  try {
    SpreadsheetApp.getUi().alert('Resolve stat rows',
      msg.length > 6000 ? msg.slice(0, 6000) + '\n\n…full report in View > Logs' : msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

const RS_SUFFIX = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, v: 1 };

function rsToks_(v) {
  return String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z ]/g, ' ')
    .split(/\s+/).filter(function (t) { return t && !RS_SUFFIX[t]; });
}

/**
 * Lines in a box score that are not a person.
 *
 * A scorer who has written down six carries by name and still owes forty
 * yards puts the difference on a line called "Rest of team". It is real
 * production and it already counts in the team totals, which are keyed on
 * the raw name rather than on a PlayerID. But there is nobody behind it.
 *
 * The resolver's CREATE pass exists to make invisible production visible, on
 * the reasoning that a name matching nobody is a player who predates the
 * rosters. That reasoning does not hold here: creating "Rest of team" would
 * seat a fiction on a roster, and from there it would appear on a team page
 * and rank on a leaderboard against boys who exist. So these are left where
 * they are, counted and named, and never created.
 */
const RS_NOT_A_PERSON = {
  'team': 1, 'team total': 1, 'team totals': 1, 'total': 1, 'totals': 1,
  'other': 1, 'others': 1, 'unknown': 1, 'unlisted': 1, 'misc': 1,
  'miscellaneous': 1, 'various': 1, 'bench': 1, 'reserves': 1,
  'opponent': 1, 'opponents': 1, 'scramble': 1, 'scrambles': 1,
  'n a': 1, 'none': 1, 'tbd': 1
};
function rsNotAPerson_(raw) {
  const key = rsToks_(raw).join(' ');
  if (!key) return true;
  if (RS_NOT_A_PERSON[key]) return true;
  // "rest of team", "rest of the squad", "team rushing", "team passing"
  return /^rest of\b/.test(key) || /^team\b/.test(key);
}

/**
 * The rows two boys could equally own, named.
 *
 * "Left alone, two players share the name: 33" is true and useless — it says
 * work remains without saying what. Every one of these needs a person who
 * knows the teams to decide, and the only thing that makes that possible is
 * seeing the stat row's own team and season next to both candidates and
 * theirs. Usually one candidate never played for that school, and the answer
 * is obvious the moment the two are side by side.
 */
function rsCollisionReport_(collisions, nameOf, teamOf) {
  const keys = Object.keys(collisions);
  if (!keys.length) return [];
  const named = function (tid) {
    if (!tid || tid === '?') return 'no team';
    return (typeof teamNameOf_ === 'function' ? teamNameOf_(tid) : '') || tid;
  };
  const list = keys.map(function (k) { return collisions[k]; })
    .sort(function (a, b) { return b.rows - a.rows; });

  const out = ['', 'Names two players share — each needs somebody to decide:'];
  list.forEach(function (c) {
    const seats = Object.keys(c.seats).map(function (s) {
      const p = s.split('|');
      return named(p[1]) + ' ' + String(p[0]).replace('SEA-', '');
    }).sort();
    out.push('  ' + c.raw + ' — ' + c.rows + ' row' + (c.rows === 1 ? '' : 's') +
             ' on ' + (seats.join(', ') || 'no team'));
    Object.keys(c.pids).forEach(function (pid) {
      const teams = Object.keys(teamOf[pid] || {}).filter(Boolean).map(named);
      out.push('      ' + pid + '  ' + (nameOf[pid] || '(no name)') +
               '  — ' + (teams.join(', ') || 'never seated'));
    });
  });
  out.push('  Settle one by putting the PlayerID into the row\'s PlayerID cell.');
  return out;
}

function resolveStatsRun_(apply) {
  const players = rowsOf_(CONFIG.TABS.PLAYERS);
  const teamOf = {};                       // pid -> {teamId:true} across seasons
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    const pid = String(r.PlayerID || '').trim();
    if (pid) (teamOf[pid] = teamOf[pid] || {})[String(r.TeamID || '').trim()] = true;
  });

  // the three candidate indexes
  const byExact = {}, byFL = {}, byIL = {};
  const nameOf = {};                       // pid -> DisplayName, for the report
  function add(map, key, pid) { (map[key] = map[key] || {})[pid] = true; }
  m15NameRows_(players).forEach(function (p) {
    const t = rsToks_(p.DisplayName);
    if (!t.length) return;
    const pid = String(p.PlayerID);
    nameOf[pid] = String(p.DisplayName || '').trim();
    add(byExact, t.join(' '), pid);
    if (t.length >= 2) {
      add(byFL, t[0] + '|' + t[t.length - 1], pid);
      add(byIL, t[0].charAt(0) + '|' + t[t.length - 1], pid);
    }
  });

  function inTeam(set, teamId) {
    return Object.keys(set || {}).filter(function (pid) {
      return (teamOf[pid] || {})[teamId];
    });
  }

  /* Which of the shared names are held by a record with nothing behind it.
     Only names two or more records answer to are worth the lookup. */
  const inert = {};
  (function () {
    if (typeof _mpHoldings_ !== 'function') return;    // MergePlayers.gs
    const shared = [];
    Object.keys(byExact).forEach(function (k) {
      const ids = Object.keys(byExact[k]);
      if (ids.length > 1) ids.forEach(function (p) { shared.push(p); });
    });
    if (!shared.length) return;
    const held = _mpHoldings_(shared);
    shared.forEach(function (p) {
      if (!Object.keys(held[p] || {}).length) inert[p] = true;
    });
  })();

  /**
   * Candidates worth considering.
   *
   * Thirty-one Players rows share a name with somebody and hold nothing at
   * all — no roster seat in any season, no stat row, no account, no award, no
   * correction, no history. There is no career behind such a record and
   * nobody can sign in as it, so it cannot be the owner of a stat line. But
   * it counted as a second candidate, and two candidates is zero candidates,
   * so its namesake's rows were unresolvable for as long as it existed.
   *
   * Ignoring it decides nothing about who the row belongs to. It removes a
   * possibility that was never real. If EVERY candidate is empty the
   * ambiguity stands, because then there is no better answer either.
   */
  function live(set) {
    const ids = Object.keys(set || {});
    const kept = ids.filter(function (p) { return !inert[p]; });
    return kept.length ? kept : ids;
  }

  /** One PlayerID or ''. Never a guess: two candidates is zero candidates. */
  function resolve(raw, teamId) {
    const t = rsToks_(raw);
    if (!t.length) return '';
    const exact = live(byExact[t.join(' ')]);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      const here = inTeam(byExact[t.join(' ')], teamId).filter(function (p) { return !inert[p]; });
      return here.length === 1 ? here[0] : '';
    }
    if (t.length < 2) return '';
    const fl = inTeam(byFL[t[0] + '|' + t[t.length - 1]], teamId);
    if (fl.length === 1) return fl[0];
    const il = inTeam(byIL[t[0].charAt(0) + '|' + t[t.length - 1]], teamId);
    if (il.length === 1) return il[0];
    return '';
  }

  // sweep the orphans
  const sh = getTab_(CONFIG.TABS.PLAYER_STATS);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const cPid = head.indexOf('PlayerID'), cRaw = head.indexOf('player_raw'),
        cTeam = head.indexOf('TeamID'), cSeason = head.indexOf('SeasonID');
  if (cPid < 0 || cRaw < 0)
    throw new Error(CONFIG.TABS.PLAYER_STATS + ' is missing PlayerID or player_raw.');

  var attached = 0, ambiguous = 0, notPeople = 0;
  const notPersonNames = {};               // norm -> raw, for the report
  /* The rows nobody can resolve without knowing the boys. Naming the two
     candidates turns "33 rows left alone" from a dead end into a short list
     somebody with the roster in front of him can actually finish. */
  const collisions = {};                   // norm -> {raw, rows, pids, seats:{}}
  const unmatched = {};                    // norm -> {raw, rows, seasons:{sid:{teamId}}}
  const fills = [];                        // {row, pid}
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][cPid] || '').trim()) continue;
    const raw = String(values[r][cRaw] || '').trim();
    if (!raw) continue;
    if (rsNotAPerson_(raw)) {              // a bucket line, not a boy
      notPeople++;
      notPersonNames[rsToks_(raw).join(' ')] = raw;
      continue;
    }
    const teamId = String(values[r][cTeam] || '').trim();
    const pid = resolve(raw, teamId);
    if (pid) { fills.push({ row: r, pid: pid }); attached++; continue; }

    const t = rsToks_(raw);
    const key = t.join(' ');
    const realCandidates = live(byExact[key]);
    const anyExact = realCandidates.length;
    if (anyExact > 1) {
      ambiguous++;
      const still = {};
      realCandidates.forEach(function (p) { still[p] = true; });
      const c = collisions[key] ||
                (collisions[key] = { raw: raw, rows: 0, pids: still, seats: {} });
      c.rows++;
      const sid0 = String(values[r][cSeason] || '').trim();
      if (sid0 || teamId) c.seats[(sid0 || '?') + '|' + (teamId || '?')] = true;
      continue;
    }

    const u = unmatched[key] || (unmatched[key] = { raw: raw, rows: 0, seats: {} });
    u.rows++;
    const sid = String(values[r][cSeason] || '').trim();
    if (sid && teamId) u.seats[sid + '|' + teamId] = true;
  }

  const unmatchedList = Object.keys(unmatched).map(function (k) { return unmatched[k]; })
    .sort(function (a, b) { return b.rows - a.rows; });

  const out = [];
  out.push((apply ? 'RESOLVE STAT ROWS' : 'RESOLVE STAT ROWS — DRY RUN'));
  out.push('');
  out.push('Rows attached to existing players: ' + attached);
  out.push('Left alone, two players share the name: ' + ambiguous);
  const notPersonList = Object.keys(notPersonNames).map(function (k) { return notPersonNames[k]; });
  if (notPeople) {
    out.push('Left alone, not a person: ' + notPeople + ' row' + (notPeople === 1 ? '' : 's') +
             ' (' + notPersonList.join(', ') + ')');
    out.push('  These already count in the team totals. Nobody is created for them.');
  }
  out.push('Names matching nobody: ' + unmatchedList.length + ' players across ' +
           unmatchedList.reduce(function (n, u) { return n + u.rows; }, 0) + ' rows.');
  /* Only worth explaining when it is about to happen. Printed against a count
     of zero it reads as a warning that something is going to be created. */
  if (unmatchedList.length) {
    out.push('These are created as new players and seated for the seasons their rows');
    out.push('cover — mostly 2024 players who predate every imported roster. A few');
    out.push('will be misspellings of players who exist; run Merge split players');
    out.push('(dry run) afterwards to spot and fold those.');
  }

  if (!apply) {
    if (unmatchedList.length) {
      out.push('');
      out.push('Top unmatched names:');
      unmatchedList.slice(0, 15).forEach(function (u) {
        out.push('  ' + u.raw + '  (' + u.rows + ' rows)');
      });
    }
    rsCollisionReport_(collisions, nameOf, teamOf).forEach(function (l) { out.push(l); });
    out.push('');
    out.push('Nothing was written. Run Resolve stat rows (APPLY) to do it.');
    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');
  try {
    // tier fills, one setValue per cell — a few hundred, once ever
    fills.forEach(function (f) {
      sh.getRange(f.row + 1, cPid + 1).setValue(f.pid);
    });

    // creations: ids allocated once for the batch
    var nextN = 0;
    players.forEach(function (p) {
      const m = String(p.PlayerID || '').match(/(\d+)\s*$/);
      if (m) nextN = Math.max(nextN, parseInt(m[1], 10));
    });
    const newPlayers = [], newSeats = [], pidOf = {};
    unmatchedList.forEach(function (u) {
      nextN++;
      var id = String(nextN);
      while (id.length < 6) id = '0' + id;
      const pid = 'PLY-' + id;
      pidOf[rsToks_(u.raw).join(' ')] = pid;
      newPlayers.push({
        PlayerID: pid, DisplayName: u.raw,
        NameNormalized: rsToks_(u.raw).join(' '),
        CreatedFrom: 'STAT_RESOLVER'
      });
      Object.keys(u.seats).forEach(function (k) {
        const sid = k.split('|')[0], teamId = k.split('|')[1];
        newSeats.push({
          PlayerSeasonID: 'PS-' + sid.replace('SEA-', '') + '-' + pid,
          PlayerID: pid, TeamID: teamId, SeasonID: sid, DisplayName: u.raw
        });
      });
    });
    if (newPlayers.length) appendRows_(CONFIG.TABS.PLAYERS, newPlayers);
    if (newSeats.length) appendRows_(CONFIG.TABS.PLAYER_SEASONS, newSeats);

    // second sweep: point the unmatched rows at their new players
    var created = 0;
    for (var r2 = 1; r2 < values.length; r2++) {
      if (String(values[r2][cPid] || '').trim()) continue;
      const raw2 = String(values[r2][cRaw] || '').trim();
      if (!raw2) continue;
      const pid2 = pidOf[rsToks_(raw2).join(' ')];
      if (pid2) { sh.getRange(r2 + 1, cPid + 1).setValue(pid2); created++; }
    }
    // rows filled by the tier pass are skipped above because the in-memory
    // `values` still shows them blank — refill from the fills list instead
    // (already written); nothing further to do for them.

    __tableCache = {};
    CacheService.getScriptCache().removeAll(['boot']);
    markDirty_('stats');

    out.push('');
    out.push('APPLIED: ' + attached + ' rows attached, ' + newPlayers.length +
             ' players created, ' + created + ' rows pointed at them.');
    out.push('Derived tables recompute on the next sweep, or run Rebuild everything now.');
    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}