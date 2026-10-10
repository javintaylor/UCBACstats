/**
 * UCBAC Stats — Database.gs
 * Generic sheet access. ONE getValues() per tab per execution, then work in memory.
 * Never call getRange().getValue() in a loop.
 */

var __tableCache = {};   // per-execution memo
var __tabMap = null;     // normalized tab name -> real Sheet object

/** Diagnostic: list every tab with its exact name and row count. */
function listTabs_() {
  const out = ['TABS IN THIS SPREADSHEET', ''];
  db_().getSheets().forEach(function (sh) {
    var nm = sh.getName();
    out.push('  "' + nm + '"' +
             (nm !== nm.trim() ? '   <- has leading/trailing space' : '') +
             '   rows=' + Math.max(0, sh.getLastRow() - 1));
  });
  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Tabs', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function normName_(s_) {
  return String(s_).replace(/[\s_\-]+/g, '').toLowerCase();
}

/** Resolve a tab tolerantly: exact -> trimmed -> case/space/underscore-insensitive. */
function getTab_(tabName) {
  var sh = db_().getSheetByName(tabName);
  if (sh) return sh;

  if (!__tabMap) {
    __tabMap = {};
    db_().getSheets().forEach(function (s_) { __tabMap[normName_(s_.getName())] = s_; });
  }
  sh = __tabMap[normName_(tabName)];
  if (sh) return sh;

  const have = db_().getSheets().map(function (s_) { return '"' + s_.getName() + '"'; }).join(', ');
  throw new Error('Missing tab: ' + tabName + '\nTabs present: ' + have +
                  '\nRun listTabs_() to see exact names.');
}

/**
 * Read a whole tab as an array of objects keyed by its header row.
 * Blank cells become '' — callers use numOrNull() to distinguish blank from zero.
 */
function readTable_(tabName) {
  if (__tableCache[tabName]) return __tableCache[tabName];

  const sh = getTab_(tabName);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    __tableCache[tabName] = { headers: [], rows: [] };
    return __tableCache[tabName];
  }

  const values  = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });

  const rows = [];
  for (var r = 1; r < values.length; r++) {
    var obj = {}, blank = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      obj[headers[c]] = v;
      if (v !== '' && v !== null) blank = false;
    }
    if (!blank) { obj.__row = r + 1; rows.push(obj); }
  }
  __tableCache[tabName] = { headers: headers, rows: rows };
  return __tableCache[tabName];
}

function rowsOf_(tabName) {
  if (typeof appPublicRows_ === 'function') { var snapshot = appPublicRows_(tabName); if (snapshot !== null) return snapshot; }
  return readTable_(tabName).rows;
}

/** True if a tab carries this column. For writes that are genuinely optional —
    a cosmetic field on a tab an older workbook may predate — so the caller can
    leave it out rather than have updateCells_ refuse the whole change. */
function hasColumn_(tabName, field) {
  try { return readTable_(tabName).headers.indexOf(field) >= 0; }
  catch (e) { return false; }
}

/** True if a tab exists (tolerantly), without throwing. */
function hasTab_(tabName) {
  try { getTab_(tabName); return true; } catch (e) { return false; }
}

/** Build an in-memory index: key -> row (or array of rows when multi=true). */
function indexBy_(rows, keyFn, multi) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var k = keyFn(rows[i]);
    if (k === null || k === undefined || k === '') continue;
    if (multi) { (map[k] = map[k] || []).push(rows[i]); }
    else if (map[k] === undefined) { map[k] = rows[i]; }
  }
  return map;
}

/** Append many rows in ONE write. objects are matched against the header row. */
function appendRows_(tabName, objects) {
  if (!objects || !objects.length) return 0;
  const sh = getTab_(tabName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
                    .map(function (h) { return String(h).trim(); });

  const matrix = objects.map(function (o) {
    return headers.map(function (h) {
      var v = o[h];
      return (v === undefined || v === null) ? '' : v;
    });
  });

  sh.getRange(sh.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
  delete __tableCache[tabName];
  return matrix.length;
}

/** Replace a tab's data (header preserved) in ONE write. Used for derived tables. */
function replaceRows_(tabName, objects, headers) {
  var sh;
  try { sh = getTab_(tabName); } catch (e) { sh = db_().insertSheet(tabName); __tabMap = null; }

  if (!headers) {
    if (sh.getLastColumn() > 0 && sh.getLastRow() > 0) {
      headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
                  .map(function (h) { return String(h).trim(); })
                  .filter(function (h) { return h; });
    }
    if (!headers || !headers.length) {
      headers = objects.length ? Object.keys(objects[0]) : [];
    }
  }
  sh.clear();
  if (!headers.length) return 0;

  const matrix = [headers];
  for (var i = 0; i < objects.length; i++) {
    matrix.push(headers.map(function (h) {
      var v = objects[i][h];
      return (v === undefined || v === null) ? '' : v;
    }));
  }
  sh.getRange(1, 1, matrix.length, headers.length).setValues(matrix);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  delete __tableCache[tabName];
  return objects.length;
}

/**
 * Update specific cells by row number.
 *
 * A field the tab has no column for used to be skipped in silence, and the
 * count nobody reads was the only sign. That is the worst way for a write to
 * fail: an approval reports success, a roster edit reports saved, and the
 * sheet never moved. A column that is merely absent from SOME rows is not the
 * case here — the header row is the whole contract — so a field that is not in
 * it is a bug in the caller or a renamed column, and both want saying out loud.
 * Fields that did write are kept: rolling them back would leave the row in a
 * state no source describes.
 */
function updateCells_(tabName, updates) {
  if (!updates || !updates.length) return 0;
  const sh = getTab_(tabName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
                    .map(function (h) { return String(h).trim(); });
  var n = 0;
  const missing = [];
  for (var i = 0; i < updates.length; i++) {
    var col = headers.indexOf(updates[i].field) + 1;
    if (col < 1) { missing.push(updates[i].field); continue; }
    sh.getRange(updates[i].row, col).setValue(updates[i].value);
    n++;
  }
  delete __tableCache[tabName];
  if (missing.length) {
    throw new Error(tabName + ' has no column named ' + missing.join(', ') +
                    ', so ' + (n ? 'part of this change was' : 'this change was') +
                    ' not saved. An administrator should run ensureSchema().');
  }
  return n;
}

/** Sequential ID generator, lock-protected against concurrent writers. */
function nextId_(tabName, field, prefix, pad_) {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const rows = rowsOf_(tabName);
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = String(rows[i][field] || '');
      var m = v.match(/(\d+)\s*$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    var n = String(max + 1);
    while (n.length < (pad_ || 6)) n = '0' + n;
    return prefix + n;
  } finally {
    lock.releaseLock();
  }
}

/** Create the operational tabs the seed workbook does not include. */
function ensureOpsTabs_() {
  const specs = {};
  specs[CONFIG.TABS.AUDIT] = ['AuditID','Timestamp','UserID','Role','Action','EntityType',
                              'EntityID','Field','OldValue','NewValue','RequestID','Notes'];
  specs[CONFIG.TABS.SUBMISSIONS] = ['SubmissionID','GameID','TeamID','SeasonID','Week',
                                    'SubmittedBy','SubmittedAt','Method','Status','RowCount',
                                    'ErrorCount','WarningCount','PublishedAt','Notes'];
  specs[CONFIG.TABS.CORRECTIONS] = ['CorrectionID','StatID','GameID','PlayerID','Field',
                                    'OldValue','NewValue','CorrectedBy','Role','CorrectedAt',
                                    'Reason'];
  var made = [];
  Object.keys(specs).forEach(function (name) {
    if (!hasTab_(name)) {
      const sh = db_().insertSheet(name);
      sh.getRange(1, 1, 1, specs[name].length).setValues([specs[name]])
        .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
      sh.setFrozenRows(1);
      made.push(name);
      __tabMap = null;
    }
  });
  return made;
}