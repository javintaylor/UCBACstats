/**
 * UCBAC Stats — Cleanup2026.gs
 *
 * ONE-OFF. Delete this file from the project once it has run.
 *
 * The roster review of 21 September 2026 left a list of mechanical fixes that
 * are tedious by hand and easy to get wrong one cell at a time. This runs
 * them all, with a dry run first that only writes to the log.
 *
 * Run from the script editor (pick the function, press Run, read the
 * Execution log). There is no menu item, so Setup.gs is not touched.
 *
 *   cleanup2026Dry()                 report what would change, write nothing
 *   cleanup2026Apply()               steps 1-6 below
 *   cleanup2026Week3Dry()            step 7 preview
 *   cleanup2026Week3Apply()          step 7, on its own because it goes
 *                                    through the StatsImport tab
 *   cleanup2026SkippedMergesDry()    the four merges left off the list
 *   cleanup2026SkippedMergesApply()  because they wanted a second look
 *
 * Steps:
 *   1. PlayerSeasons rows whose player no longer exists and that hold no
 *      stats and no account: removed. The test players and two 2025 Bel Air
 *      seats left behind when their Players rows were deleted.
 *   2. Seats that carry another school's player name from an old import
 *      (ExternalRef set, seat name not the player's name): the seat takes
 *      the player's name back, ExternalRef is cleared, a missing
 *      PlayerSeasonID is filled in. The displaced names are listed so they
 *      can be given seats on their own teams.
 *   3. Three Players rows that hold nothing and whose initials fit two boys:
 *      removed. Checked again here before deleting.
 *   4. PlayerGameStats: a player with two GAME lines in one game and one
 *      category. Identical copies lose the extra. Two partial lines that do
 *      not contradict each other are combined into one. Anything that does
 *      contradict is reported and left alone.
 *   5. Names corrected on the Players row and on this season's seat.
 *   6. Players added to a roster with a name only, for the coach to number.
 *      A name already seated on that team this season is skipped.
 *   7. Week 3 box scores that arrived after the other imports, through the
 *      StatsImport tab and the same import path as every other box score:
 *      Elkton's defense, and Bel Air's whole game. Bel Air's lines are the
 *      MaxPreps season totals after three games less the two games already
 *      on file, so a figure here is only as good as those two games.
 *
 * Absent means leave alone: a blank cell is never written as zero.
 */

const CLEANUP2026 = {
  SEASON: 'SEA-2026',

  // step 3
  DELETE_PLAYERS: [] /* private dataset removed */,

  // step 5: PlayerID -> the name the school uses
  RENAMES: [] /* private dataset removed */,

  // step 6: TeamID, name
  ADD: [] /* private dataset removed */,

  // stale import tabs
  DROP_TABS: ['ImportRoster', 'RosterImport'],

  // the merges left off the 21 September list: [absorb, keep]
  SKIPPED_MERGES: [] /* private dataset removed */,

  // step 7: one entry per box score; each row is [name, #, {field: value}]
  WEEK3_IMPORTS: [] /* private dataset removed */
};

// ── small helpers, local so this file depends on as little as possible ──────

function cu26Str_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function cu26Norm_(v) { return cu26Str_(v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function cu26Blank_(v) { return v === '' || v === null || v === undefined; }
function cu26Num_(v) {
  if (cu26Blank_(v)) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function cu26Parts_(name) {
  const t = cu26Str_(name).split(/\s+/).filter(Boolean);
  return { first: t[0] || '', last: t.length > 1 ? t[t.length - 1] : '' };
}
function cu26Me_() {
  var email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { email = ''; }
  return { email: email || 'sheet', role: 'ADMIN', teamId: '' };
}
/** A tab as { sh, head, col, values } read once. */
function cu26Read_(tab) {
  const sh = getTab_(tab);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const col = {};
  head.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
  return { sh: sh, head: head, col: col, values: values };
}
/** Delete sheet rows (1-based) bottom-up so the numbers stay true. */
function cu26DeleteRows_(sh, rows1) {
  rows1.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}
function cu26Audit_(me, action, type, id, field, oldV, newV, note) {
  if (typeof auditRow_ !== 'function' || !hasTab_(CONFIG.TABS.AUDIT)) return null;
  return auditRow_(me, action, type, id, field, oldV, newV, note);
}

// ── the run ──────────────────────────────────────────────────────────────────

function cu26Run_(apply) {
  const out = [apply ? 'CLEANUP 2026 — APPLYING' : 'CLEANUP 2026 — DRY RUN, nothing written', ''];
  const me = cu26Me_();
  const audit = [];
  const season = CLEANUP2026.SEASON;

  const players = rowsOf_(CONFIG.TABS.PLAYERS);
  const byId = {};
  players.forEach(function (p) { const id = cu26Str_(p.PlayerID); if (id) byId[id] = p; });
  const statCount = {}, acctCount = {};
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) { const id = cu26Str_(r.PlayerID); if (id) statCount[id] = (statCount[id] || 0) + 1; });
  if (hasTab_('Accounts'))
    rowsOf_('Accounts').forEach(function (a) { const id = cu26Str_(a.PlayerID); if (id) acctCount[id] = (acctCount[id] || 0) + 1; });

  // ── 1 and 2: PlayerSeasons ──────────────────────────────────────────────
  const S = cu26Read_(CONFIG.TABS.PLAYER_SEASONS);
  const sc = S.col;
  ['PlayerID', 'PlayerSeasonID', 'TeamID', 'SeasonID', 'DisplayName'].forEach(function (c) {
    if (sc[c] === undefined) throw new Error('PlayerSeasons has no ' + c + ' column');
  });
  const seatDeletes = [], seatEdits = [];      // edits: [row1, col0, value]
  const seatedNames = {};                       // norm name -> [TeamID] this season, proper seats
  const displaced = [];
  out.push('1. Seats whose player is gone');
  for (var r = 1; r < S.values.length; r++) {
    const v = S.values[r];
    const pid = cu26Str_(v[sc.PlayerID]);
    if (!pid) continue;
    if (!byId[pid]) {
      if (statCount[pid] || acctCount[pid]) {
        out.push('   left: ' + pid + ' (' + cu26Str_(v[sc.DisplayName]) + ') has ' + (statCount[pid] || 0) +
                 ' stat lines / ' + (acctCount[pid] || 0) + ' accounts pointing at a missing player - run Restore orphaned players');
        continue;
      }
      seatDeletes.push(r + 1);
      out.push('   remove: row ' + (r + 1) + ' ' + pid + ' ' + cu26Str_(v[sc.DisplayName]) + ' ' +
               cu26Str_(v[sc.TeamID]) + ' ' + cu26Str_(v[sc.SeasonID]) + ' ' + cu26Str_(v[sc.PlayerSeasonID]));
      audit.push(cu26Audit_(me, 'CLEANUP_SEAT_REMOVE', 'PlayerSeason', cu26Str_(v[sc.PlayerSeasonID]) || pid, '',
                            cu26Str_(v[sc.DisplayName]), '', 'player row missing'));
    }
  }
  if (!seatDeletes.length) out.push('   none');

  out.push('');
  out.push('2. Seats carrying another school\'s name');
  var repaired = 0;
  for (r = 1; r < S.values.length; r++) {
    const v2 = S.values[r];
    const pid2 = cu26Str_(v2[sc.PlayerID]);
    if (!pid2 || !byId[pid2] || cu26Str_(v2[sc.SeasonID]) !== season) continue;
    const real = cu26Str_(byId[pid2].DisplayName);
    const seatName = cu26Str_(v2[sc.DisplayName]);
    const ext = sc.ExternalRef === undefined ? '' : cu26Str_(v2[sc.ExternalRef]);
    const wrong = !!ext && !!seatName && cu26Norm_(seatName) !== cu26Norm_(real);
    if (!wrong) {
      const key = cu26Norm_(real);
      (seatedNames[key] = seatedNames[key] || []).push(cu26Str_(v2[sc.TeamID]));
      continue;
    }
    repaired++;
    const parts = cu26Parts_(real);
    seatEdits.push([r + 1, sc.DisplayName, real]);
    if (sc.LastName !== undefined) seatEdits.push([r + 1, sc.LastName, parts.last]);
    if (sc.FirstName !== undefined) seatEdits.push([r + 1, sc.FirstName, parts.first]);
    seatEdits.push([r + 1, sc.ExternalRef, '']);
    var psid = cu26Str_(v2[sc.PlayerSeasonID]);
    if (!psid) { psid = 'PS-' + season.replace('SEA-', '') + '-' + pid2; seatEdits.push([r + 1, sc.PlayerSeasonID, psid]); }
    displaced.push({ name: seatName, ref: ext, team: cu26Str_(v2[sc.TeamID]) });
    out.push('   ' + cu26Str_(v2[sc.TeamID]) + ' row ' + (r + 1) + ': "' + seatName + '" -> ' + real + ' (' + pid2 + ')' +
             (cu26Str_(v2[sc.PlayerSeasonID]) ? '' : ', PlayerSeasonID ' + psid));
    audit.push(cu26Audit_(me, 'CLEANUP_SEAT_REPAIR', 'PlayerSeason', psid, 'DisplayName', seatName, real,
                          'ExternalRef ' + ext + ' cleared'));
  }
  if (!repaired) out.push('   none');
  const noSeat = displaced.filter(function (d) { return !seatedNames[cu26Norm_(d.name)]; });
  if (noSeat.length) {
    out.push('   Displaced names with no seat of their own this season (' + noSeat.length + '). Their own school\'s');
    out.push('   roster file names them; add them there with the roster editor or the next roster import:');
    noSeat.forEach(function (d) { out.push('     ' + d.name + '   (' + d.ref.split('-')[0] + ', was sitting on ' + d.team + ')'); });
  }

  // ── 3: Players rows that hold nothing ──────────────────────────────────
  out.push('');
  out.push('3. Empty player rows');
  const P = cu26Read_(CONFIG.TABS.PLAYERS);
  const pc = P.col;
  const playerDeletes = [], playerEdits = [];
  const seatCount = {};
  for (r = 1; r < S.values.length; r++) { const id = cu26Str_(S.values[r][sc.PlayerID]); if (id) seatCount[id] = (seatCount[id] || 0) + 1; }
  const awardCount = {};
  if (hasTab_('Awards')) rowsOf_('Awards').forEach(function (a) { const id = cu26Str_(a.PlayerID); if (id) awardCount[id] = (awardCount[id] || 0) + 1; });
  const rowOfPlayer = {};
  for (r = 1; r < P.values.length; r++) { const id = cu26Str_(P.values[r][pc.PlayerID]); if (id) rowOfPlayer[id] = r + 1; }
  CLEANUP2026.DELETE_PLAYERS.forEach(function (id) {
    if (!rowOfPlayer[id]) { out.push('   ' + id + ': already gone'); return; }
    const holds = (seatCount[id] || 0) + (statCount[id] || 0) + (acctCount[id] || 0) + (awardCount[id] || 0);
    if (holds) { out.push('   ' + id + ': now holds ' + holds + ' thing(s), left alone'); return; }
    playerDeletes.push(rowOfPlayer[id]);
    out.push('   remove: ' + id + ' ' + cu26Str_(byId[id].DisplayName));
    audit.push(cu26Audit_(me, 'CLEANUP_PLAYER_REMOVE', 'Player', id, '', cu26Str_(byId[id].DisplayName), '', 'held nothing'));
  });

  // ── 4: duplicate stat lines ─────────────────────────────────────────────
  out.push('');
  out.push('4. Duplicate stat lines');
  const T = cu26Read_(CONFIG.TABS.PLAYER_STATS);
  const tc = T.col;
  const fields = STATSIMPORT.FIELDS.filter(function (f) { return tc[f] !== undefined; });
  const groups = {};
  for (r = 1; r < T.values.length; r++) {
    const v4 = T.values[r];
    if (cu26Str_(v4[tc.grain]) !== CONFIG.GRAIN.GAME) continue;
    const g = cu26Str_(v4[tc.GameID]), p = cu26Str_(v4[tc.PlayerID]), c = cu26Str_(v4[tc.category]);
    if (!g || !p || !c) continue;
    const k = g + '|' + p + '|' + c;
    (groups[k] = groups[k] || []).push(r);
  }
  const statDeletes = [], statEdits = [];
  var identical = 0, combined = 0, conflicts = 0;
  Object.keys(groups).forEach(function (k) {
    const rows = groups[k];
    if (rows.length < 2) return;
    const who = k.split('|');
    const label = who[0] + ' ' + (byId[who[1]] ? cu26Str_(byId[who[1]].DisplayName) : who[1]) + ' ' + who[2];
    // per field: the set of non-blank values across the copies. A written
    // zero beside a figure is the coach's form filling in the boxes he left
    // empty, not a second opinion - the figure wins. Two different figures
    // are two opinions, and that is a conflict for a person.
    const merged = {}; var clash = '';
    fields.forEach(function (f) {
      const seen = {}; var zero = false;
      rows.forEach(function (rr) {
        const n = cu26Num_(T.values[rr][tc[f]]);
        if (n === null) return;
        if (n === 0) zero = true; else seen[n] = true;
      });
      const vals = Object.keys(seen);
      if (vals.length > 1) clash = clash || (f + ' ' + vals.join(' vs '));
      else if (vals.length === 1) merged[f] = Number(vals[0]);
      else if (zero) merged[f] = 0;
    });
    if (clash) { conflicts++; out.push('   CONFLICT, left alone: ' + label + ' (' + clash + ')'); return; }
    const same = rows.every(function (rr) {
      return fields.every(function (f) { const n = cu26Num_(T.values[rr][tc[f]]); return (n === null && merged[f] === undefined) || n === merged[f]; });
    });
    if (same) { identical++; out.push('   identical x' + rows.length + ', keep one: ' + label); }
    else {
      combined++;
      out.push('   combine into one: ' + label + ' -> ' + Object.keys(merged).map(function (f) { return f + ' ' + merged[f]; }).join(', '));
      fields.forEach(function (f) { if (merged[f] !== undefined) statEdits.push([rows[0] + 1, tc[f], merged[f]]); });
    }
    rows.slice(1).forEach(function (rr) { statDeletes.push(rr + 1); });
    audit.push(cu26Audit_(me, 'CLEANUP_STAT_DEDUPE', 'PlayerGameStats', who[1], who[2], String(rows.length) + ' lines', '1 line', who[0]));
  });
  out.push('   ' + identical + ' identical, ' + combined + ' combined, ' + conflicts + ' conflict(s)');

  // ── 5: renames ──────────────────────────────────────────────────────────
  out.push('');
  out.push('5. Names');
  CLEANUP2026.RENAMES.forEach(function (x) {
    const id = x[0], name = x[1];
    if (!rowOfPlayer[id]) { out.push('   ' + id + ': not on Players, skipped'); return; }
    const was = cu26Str_(byId[id].DisplayName);
    if (was === name) { out.push('   ' + id + ': already ' + name); return; }
    playerEdits.push([rowOfPlayer[id], pc.DisplayName, name]);
    if (pc.NameNormalized !== undefined)
      playerEdits.push([rowOfPlayer[id], pc.NameNormalized, name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()]);
    const parts = cu26Parts_(name);
    for (var rr = 1; rr < S.values.length; rr++) {
      if (cu26Str_(S.values[rr][sc.PlayerID]) !== id || cu26Str_(S.values[rr][sc.SeasonID]) !== season) continue;
      seatEdits.push([rr + 1, sc.DisplayName, name]);
      if (sc.LastName !== undefined) seatEdits.push([rr + 1, sc.LastName, parts.last]);
      if (sc.FirstName !== undefined) seatEdits.push([rr + 1, sc.FirstName, parts.first]);
    }
    out.push('   ' + id + ': ' + was + ' -> ' + name);
    audit.push(cu26Audit_(me, 'CLEANUP_RENAME', 'Player', id, 'DisplayName', was, name, ''));
  });

  // ── 6: adds ─────────────────────────────────────────────────────────────
  out.push('');
  out.push('6. Players to add, name only');
  const adds = [];
  CLEANUP2026.ADD.forEach(function (x) {
    const team = x[0], name = x[1], key = cu26Norm_(name);
    const already = (seatedNames[key] || []).indexOf(team) >= 0;
    if (already) { out.push('   ' + name + ': already seated on ' + team); return; }
    adds.push({ team: team, name: name });
    out.push('   add ' + name + ' to ' + team + ' (no number, no class - coach to fill in)');
  });

  // ── tabs ────────────────────────────────────────────────────────────────
  out.push('');
  out.push('Stale tabs');
  const dropTabs = CLEANUP2026.DROP_TABS.filter(function (t) { return hasTab_(t); });
  out.push(dropTabs.length ? '   remove: ' + dropTabs.join(', ') : '   none present');

  // ── 7: preview only; the apply is its own function ──────────────────────
  out.push('');
  out.push('7. Week 3 imports: ' + CLEANUP2026.WEEK3_IMPORTS.map(function (b) {
    return b.school + ' ' + b.rows.length + ' rows';
  }).join(', ') + ', through the StatsImport tab.');
  out.push('   Run cleanup2026Week3Apply() after this one.');

  if (!apply) {
    out.push('');
    out.push('Nothing was written. Run cleanup2026Apply() to proceed.');
    const m0 = out.join('\n'); Logger.log(m0); return m0;
  }

  // ── write, in an order that keeps every row number true ─────────────────
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Database busy — try again.');
  try {
    seatEdits.forEach(function (e) { S.sh.getRange(e[0], e[1] + 1).setValue(e[2]); });
    cu26DeleteRows_(S.sh, seatDeletes);
    playerEdits.forEach(function (e) { P.sh.getRange(e[0], e[1] + 1).setValue(e[2]); });
    cu26DeleteRows_(P.sh, playerDeletes);
    statEdits.forEach(function (e) { T.sh.getRange(e[0], e[1] + 1).setValue(e[2]); });
    cu26DeleteRows_(T.sh, statDeletes);
    __tableCache = {};

    adds.forEach(function (a) {
      const pid = nextPlayerIdLocked_();
      const parts = cu26Parts_(a.name);
      appendRows_(CONFIG.TABS.PLAYERS, [{
        PlayerID: pid, DisplayName: a.name,
        NameNormalized: a.name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
        FirstSeenSeason: season, CreatedFrom: 'CLEANUP2026:' + me.email
      }]);
      appendRows_(CONFIG.TABS.PLAYER_SEASONS, [{
        PlayerSeasonID: 'PS-' + season.replace('SEA-', '') + '-' + pid,
        PlayerID: pid, TeamID: a.team, SeasonID: season,
        DisplayName: a.name, LastName: parts.last, FirstName: parts.first
      }]);
      audit.push(cu26Audit_(me, 'ROSTER_ADD', 'Player', pid, '', '', a.name, a.team + ' ' + season + ' (cleanup)'));
      out.push('   added ' + a.name + ' as ' + pid);
    });

    dropTabs.forEach(function (t) { db_().deleteSheet(getTab_(t)); });
    if (typeof __tabMap !== 'undefined') __tabMap = null;

    const rows = audit.filter(Boolean);
    if (rows.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, rows); }
  } finally {
    lock.releaseLock();
  }
  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot', 'ac-' + season]);
  if (typeof markDirty_ === 'function') markDirty_('cleanup');

  out.push('');
  out.push('Written: ' + seatDeletes.length + ' seat rows removed, ' + repaired + ' seats repaired, ' +
           playerDeletes.length + ' player rows removed, ' + statDeletes.length + ' stat lines removed, ' +
           CLEANUP2026.RENAMES.length + ' renames checked, ' + adds.length + ' players added, ' +
           dropTabs.length + ' tabs removed.');
  out.push('Next: cleanup2026Week3Apply(), then UCBAC Stats > Rebuild everything now.');
  const m1 = out.join('\n'); Logger.log(m1); return m1;
}

// ── 7: week 3 box scores, through the StatsImport tab ───────────────────────

function cu26Week3Rows_() {
  const out = [];
  CLEANUP2026.WEEK3_IMPORTS.forEach(function (b) {
    b.rows.forEach(function (x) {
      const row = { School: b.school, Week: b.week, Opponent: b.opponent, Player: x[0] };
      row['#'] = x[1];
      Object.keys(x[2]).forEach(function (f) { row[f] = x[2][f]; });
      out.push(row);
    });
  });
  return out;
}

function cu26Week3_(apply) {
  siClearSaved_();
  const sh = siEnsureTab_();
  const left = sh.getLastRow() - 1;
  if (left > 0)
    return 'StatsImport still holds ' + left + ' row(s) that were never saved. Deal with those first ' +
           '(Stats > Import, or clear the tab), then run this again.';
  const rows = cu26Week3Rows_();
  if (!apply) return 'Would paste ' + rows.length + ' rows (' + CLEANUP2026.WEEK3_IMPORTS.map(function (b) {
    return b.school + ' ' + b.rows.length;
  }).join(', ') + ') and import them. Nothing written.';
  siAppend_(rows);
  return siRun_(true);
}

// ── the merges that wanted a second look ────────────────────────────────────

function cu26SkippedMerges_(apply) {
  const out = [];
  CLEANUP2026.SKIPPED_MERGES.forEach(function (m) {
    try {
      out.push((apply ? mergePlayersByIdApply_ : mergePlayersByIdDryRun_)(m[0], m[1]));
    } catch (e) {
      out.push(m[0] + ' -> ' + m[1] + ': ' + e.message);
    }
    out.push('----');
  });
  return out.join('\n');
}

// ── entry points: pick one in the editor and press Run; read the log ────────

function cleanup2026Dry()                 { Logger.log(cu26Run_(false)); }
function cleanup2026Apply()               { Logger.log(cu26Run_(true)); }
function cleanup2026Week3Dry()            { Logger.log(cu26Week3_(false)); }
function cleanup2026Week3Apply()          { Logger.log(cu26Week3_(true)); }
function cleanup2026SkippedMergesDry()    { Logger.log(cu26SkippedMerges_(false)); }
function cleanup2026SkippedMergesApply()  { Logger.log(cu26SkippedMerges_(true)); }
