/* historical record comment removed */

const ORPHAN = {
  // tabs that name a player, and the column each uses
  REFS: [
    { tab: 'PlayerSeasons',    col: 'PlayerID', label: 'season row' },
    { tab: 'PlayerGameStats',  col: 'PlayerID', label: 'stat row' },
    { tab: 'Accounts',         col: 'PlayerID', label: 'sign-in account' },
    { tab: 'PlayerSeasonStats',col: 'PlayerID', label: 'season total' },
    { tab: 'PlayerCareerStats',col: 'PlayerID', label: 'career total' },
    { tab: 'Awards',           col: 'PlayerID', label: 'award' },
    { tab: 'AllConference',    col: 'PlayerID', label: 'all-conference row' },
    { tab: 'StatCorrections',  col: 'PlayerID', label: 'correction' },
    { tab: 'StatSubmissions',  col: 'PlayerID', label: 'submission' },
    { tab: 'Media',            col: 'PlayerID', label: 'media row' }
  ],
  CREATED_FROM: 'ORPHAN_REPAIR'
};

/** The same normalization the roster and registration paths write. */
function opNorm_(v) {
  return String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/* historical record comment removed */
function opNameOf_(row) {
  const tries = [row.DisplayName, row.player_raw, row.PlayerName, row.Player];
  for (var i = 0; i < tries.length; i++) {
    const v = s_(tries[i]);
    if (v && !/^PLY-/i.test(v) && opNorm_(v)) return v;
  }
  return '';
}

/**
 * Every PlayerID some tab still names that the Players tab does not have.
 *
 * Returns one entry per missing ID: where it is referenced, how many times,
 * and the best name and first season the references can supply. A PlayerID
 * with no name anywhere is reported without one rather than skipped — it still
 * needs a row, and a person needs to see that the name has to be typed.
 */
function opScan_() {
  const known = {};
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
    const id = s_(p.PlayerID);
    if (id) known[id] = true;
  });

  const found = {};
  const note = function (id, label, name, season, grad, teamId) {
    if (!id || known[id]) return;
    const e = found[id] || (found[id] = { id: id, refs: {}, total: 0,
                                          name: '', season: '', grad: '',
                                          teamId: '', similar: [] });
    e.refs[label] = (e.refs[label] || 0) + 1;
    e.total++;
    // first name found wins; a season row is consulted before a stat row
    if (!e.name && s_(name)) e.name = s_(name);
    if (s_(season) && (!e.season || s_(season) < e.season)) e.season = s_(season);
    if (!e.grad && s_(grad)) e.grad = s_(grad);
    if (!e.teamId && s_(teamId)) e.teamId = s_(teamId);
  };

  ORPHAN.REFS.forEach(function (r) {
    if (!hasTab_(r.tab)) return;
    rowsOf_(r.tab).forEach(function (row) {
      note(s_(row[r.col]), r.label, opNameOf_(row), row.SeasonID, row.GradYear,
           row.TeamID);
    });
  });

  const out = Object.keys(found).map(function (k) { return found[k]; });
  out.forEach(function (e) { e.similar = opSimilar_(e); });
  out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
  return out;
}

/** Edit distance, capped — only "is this a typo of that" is ever asked. */
function opEdits_(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  var prev = [], cur = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur = [i];
    for (var k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1,
                        prev[k - 1] + (a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/* historical record comment removed */
function opSimilar_(e) {
  const want = opNorm_(e.name);
  if (!want) return [];
  const seats = hasTab_(CONFIG.TABS.PLAYER_SEASONS) ? rowsOf_(CONFIG.TABS.PLAYER_SEASONS) : [];
  const teamOf = {};
  seats.forEach(function (r) {
    const pid = s_(r.PlayerID);
    if (pid && s_(r.TeamID)) teamOf[pid] = teamOf[pid] || s_(r.TeamID);
  });

  const out = [];
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
    const nm = opNorm_(p.DisplayName);
    if (!nm || nm === want) return;
    if (opEdits_(nm, want) > 2) return;
    const pid = s_(p.PlayerID);
    // a near name on another school is a different boy far more often than not
    if (e.teamId && teamOf[pid] && teamOf[pid] !== e.teamId) return;
    out.push({ id: pid, name: s_(p.DisplayName) });
  });
  return out;
}

/** One orphan, written the way the report reads it out. */
function opDescribe_(e) {
  const where = Object.keys(e.refs).map(function (k) {
    return e.refs[k] + ' ' + k + (e.refs[k] === 1 ? '' : 's');
  }).join(', ');
  const like = e.similar.map(function (x) { return x.name + ' (' + x.id + ')'; }).join(', ');
  return '  ' + e.id + '  ' + (e.name || '(no name on any reference)') +
         '\n      named by: ' + where +
         (e.season ? '\n      first season: ' + e.season : '') +
         (like ? '\n      already on the Players tab, spelled differently: ' + like +
                 '\n      — restore this row anyway, then merge the two by hand.' : '');
}

function opReport_(list, applied) {
  const out = [];
  out.push(applied ? 'Orphaned players — REPAIRED' : 'Orphaned players — dry run');
  out.push('');
  if (!list.length) {
    out.push('Every PlayerID the workbook names has a row on the Players tab.');
    return out.join('\n');
  }
  out.push(list.length + ' PlayerID' + (list.length === 1 ? '' : 's') +
           ' referenced with no Players row:');
  out.push('');
  list.forEach(function (e) { out.push(opDescribe_(e)); out.push(''); });
  if (!applied) {
    out.push('APPLY rebuilds each Players row from the name and season above,');
    out.push('marked ' + ORPHAN.CREATED_FROM + '. Statistics, season rows and');
    out.push('accounts are not touched — they already point at the right ID.');
    const nameless = list.filter(function (e) { return !e.name; }).length;
    if (nameless)
      out.push('\n' + nameless + ' has no name on any reference and will be ' +
               'restored blank — type the name on the Players tab afterwards.');
  }
  return out.join('\n');
}

function repairOrphanPlayersDryRun_() {
  const msg = opReport_(opScan_(), false);
  Logger.log(msg);
  return msg;
}

/**
 * Put the missing Players rows back.
 *
 * Under the script lock, because it appends to the same tab registration and
 * the roster importer append to — and unlike those two it does not allocate an
 * ID, so a concurrent allocation must not be reading the tab mid-write.
 */
function repairOrphanPlayersApply_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  var list;
  try {
    __tableCache = {};
    list = opScan_();
    if (!list.length) return opReport_(list, true);

    const me = accountsWhoami_();
    const rows = list.map(function (e) {
      return { PlayerID: e.id, DisplayName: e.name, NameNormalized: opNorm_(e.name),
               GradYear: e.grad || '', FirstSeenSeason: e.season || '',
               CreatedFrom: ORPHAN.CREATED_FROM };
    });
    appendRows_(CONFIG.TABS.PLAYERS, rows);

    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, list.map(function (e) {
      return auditRow_(me, 'ORPHAN_REPAIR', 'Player', e.id, 'PlayerID', '',
                      e.name || '(blank)', e.total + ' reference(s) restored');
    }));
  } finally {
    lock.releaseLock();
  }

  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot']);
  if (typeof markDirty_ === 'function') markDirty_('orphan');

  const msg = opReport_(list, true) +
    '\n\nWritten. Run "Rebuild everything now" so the restored players appear ' +
    'in the derived tables.';
  Logger.log(msg);
  return msg;
}

function menuOrphanDryRun() {
  const msg = repairOrphanPlayersDryRun_();
  SpreadsheetApp.getUi().alert('Orphaned players — dry run',
    msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg,
    SpreadsheetApp.getUi().ButtonSet.OK);
  return msg;
}

function menuOrphanApply() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Restore orphaned players — APPLY',
    'This rebuilds a Players row for every PlayerID the workbook still names ' +
    'but the Players tab has lost. Nothing else is changed.\n\nRun the dry run ' +
    'first and read the names.\n\nProceed?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return 'Cancelled — nothing was written.';
  const msg = repairOrphanPlayersApply_();
  ui.alert('Orphaned players — repaired',
    msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg,
    ui.ButtonSet.OK);
  return msg;
}
