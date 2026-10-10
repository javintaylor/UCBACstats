/**
 * UCBAC Stats — ImportProfiles.gs
 *
 * Loads the commitments, accolades and measurables mined out of the season
 * workbooks into the database, so the player profile pages have something real
 * to show instead of empty fields.
 *
 * HOW TO USE
 *   1. In the spreadsheet: File > Import > Upload, pick Commitments_seed.csv,
 *      choose "Insert new sheet(s)", Import. Repeat for Accolades_seed.csv and
 *      Measurables_seed.csv.
 *   2. UCBAC Stats > Maintenance > Import profile seeds.
 *   3. Delete the three imported sheets afterwards if you like — nothing depends
 *      on them once the import has run.
 *
 * Safe to run twice. Every write is an update-in-place keyed on PlayerID, and
 * awards are keyed on player + season + award, so a second run corrects rather
 * than duplicates.
 *
 * Rows whose PlayerID is blank are the ones the extractor could not resolve to a
 * player without guessing. They are skipped and reported rather than attached to
 * whoever happens to share a surname.
 */

const IP_SHEETS = {
  commitments:  ['Commitments_seed', 'Commitments', 'Commitments_seed.csv'],
  accolades:    ['Accolades_seed', 'Accolades', 'Accolades_seed.csv'],
  measurables:  ['Measurables_seed', 'Measurables', 'Measurables_seed.csv']
};

const IP_AWARDS_TAB = 'Awards';

/**
 * Find a seed sheet by name, tolerantly.
 *
 * Importing a CSV whose name already exists makes Sheets append a counter, so
 * the tab arrives as "Commitments_seed (2)" and an exact-name lookup silently
 * finds nothing — the import then reports success having done nothing at all.
 * Punctuation, case and that counter are all ignored here.
 */
function _ipNormName_(s_) {
  return String(s_ === null || s_ === undefined ? '' : s_)
    .replace(/\.csv$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[\s_\-]+/g, '')
    .toLowerCase();
}

function _ipFind_(names) {
  const wanted = {};
  names.forEach(function (n) { wanted[_ipNormName_(n)] = true; });

  const sheets = db_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    const real = sheets[i].getName();
    if (wanted[_ipNormName_(real)]) return real;
  }
  return null;
}

/**
 * Append any missing columns to a tab and return the ones added.
 * Named with a prefix because Apps Script shares one global scope across files —
 * a second addColumns() elsewhere would silently replace this one.
 */
function _ipAddColumns_(tabName, columns) {
  const sh = getTab_(tabName);
  const width = Math.max(1, sh.getLastColumn());
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  const missing = columns.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing])
      .setFontWeight('bold');
    __tableCache = {};
  }
  return missing;
}

/** Column-name -> index map from a sheet's real header row. */
function _ipHeader_(sh) {
  const width = Math.max(1, sh.getLastColumn());
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  const map = {};
  head.forEach(function (h, i) { if (h) map[h] = i; });
  return { head: head, index: map };
}

function _ipStr_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function _ipNum_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

/** The one entry point. */
function importProfileSeeds() {
  const report = [];
  var totalSkipped = 0;

  const cs = _ipFind_(IP_SHEETS.commitments);
  const as = _ipFind_(IP_SHEETS.accolades);
  const ms = _ipFind_(IP_SHEETS.measurables);

  if (!cs && !as && !ms) {
    const none = 'No seed sheets found.\n\nImport the CSVs first:\n' +
      'File > Import > Upload > Commitments_seed.csv > Insert new sheet(s).\n' +
      'Repeat for Accolades_seed.csv and Measurables_seed.csv, then run this again.';
    Logger.log(none);
    try { SpreadsheetApp.getUi().alert('Import profile seeds', none,
      SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
    return none;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Database busy — try again.');
  try {
    if (cs) { const r = _ipCommitments_(cs); report.push(r.text); totalSkipped += r.skipped; }
    if (ms) { const r = _ipMeasurables_(ms); report.push(r.text); totalSkipped += r.skipped; }
    if (as) { const r = _ipAccolades_(as);   report.push(r.text); totalSkipped += r.skipped; }
  } finally {
    lock.releaseLock();
  }

  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot']);
  if (typeof markDirty_ === 'function') markDirty_('profiles');

  if (totalSkipped) {
    report.push('\n' + totalSkipped + ' row(s) had no PlayerID and were skipped. Those are ' +
                'the names the extractor could not resolve without guessing — attach them ' +
                'by hand in the seed sheet and re-run if you want them in.');
  }
  const msg = report.join('\n\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Import profile seeds', msg,
    SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/** Who a skipped seed row names, so a person can go and attach it. */
function _ipWho_(row, sHead, sheetRow) {
  const cols = ['Player', 'PlayerName', 'Name', 'DisplayName', 'FullName'];
  for (var i = 0; i < cols.length; i++) {
    const c = sHead.index[cols[i]];
    if (c !== undefined && _ipStr_(row[c])) return _ipStr_(row[c]);
  }
  return 'row ' + sheetRow;
}
/** "... 3 unmatched rows skipped (no PlayerID): A, B, C" - names, not a count. */
function _ipSkipText_(list) {
  if (!list.length) return '';
  const SHOW = 25;
  return ', ' + list.length + ' unmatched row' + (list.length === 1 ? '' : 's') + ' skipped (no PlayerID): ' +
         list.slice(0, SHOW).join(', ') + (list.length > SHOW ? ', ... and ' + (list.length - SHOW) + ' more' : '');
}

// ── commitments -> Players ─────────────────────────────────────────────────

function _ipCommitments_(tabName) {
  _ipAddColumns_(CONFIG.TABS.PLAYERS,
    ['Commitment', 'CommitmentLevel', 'CommitmentDate', 'Offers', 'Committed',
     'HudlURL', 'XHandle', 'InstagramHandle', 'MaxPrepsURL', 'Hometown', 'Bio',
     'Email', 'ProfilePhotoID', 'UpdatedAt', 'UpdatedBy']);

  const seed = getTab_(tabName);
  const sHead = _ipHeader_(seed);
  const rows = seed.getDataRange().getValues().slice(1);

  const psh = getTab_(CONFIG.TABS.PLAYERS);
  const pHead = _ipHeader_(psh);
  const pData = psh.getDataRange().getValues();
  const cPid = pHead.index['PlayerID'];

  const rowOf = {};
  for (var r = 1; r < pData.length; r++) {
    const id = _ipStr_(pData[r][cPid]);
    if (id) rowOf[id] = r + 1;
  }

  var applied = 0, skipped = 0, missing = 0;
  const skippedWho = [], missingWho = [];
  rows.forEach(function (row, i) {
    const pid = _ipStr_(row[sHead.index['PlayerID']]);
    if (!pid) { skipped++; skippedWho.push(_ipWho_(row, sHead, i + 2)); return; }
    const sheetRow = rowOf[pid];
    if (!sheetRow) { missing++; missingWho.push(pid); return; }

    const committed = _ipStr_(row[sHead.index['Committed']]).toUpperCase() === 'TRUE';
    const offers = _ipStr_(row[sHead.index['Offers']]);
    const commitment = _ipStr_(row[sHead.index['Commitment']]);

    _ipSet_(psh, pHead, sheetRow, 'Offers', offers);
    _ipSet_(psh, pHead, sheetRow, 'Committed', committed ? 'TRUE' : '');
    // only a checked offer is a commitment; an uncommitted player keeps a blank
    // Commitment rather than being shown as committed to their first offer
    _ipSet_(psh, pHead, sheetRow, 'Commitment', committed ? commitment : '');
    _ipSet_(psh, pHead, sheetRow, 'UpdatedAt', new Date());
    _ipSet_(psh, pHead, sheetRow, 'UpdatedBy', 'seed:offers');
    applied++;
  });

  return {
    skipped: skipped,
    text: 'Commitments: ' + applied + ' players updated' +
          (missing ? ', ' + missing + ' PlayerIDs not found in Players (' + missingWho.slice(0, 25).join(', ') + ')' : '') +
          _ipSkipText_(skippedWho)
  };
}

// ── measurables -> PlayerSeasons ───────────────────────────────────────────

function _ipMeasurables_(tabName) {
  _ipAddColumns_(CONFIG.TABS.PLAYER_SEASONS,
    ['FortyTime', 'BenchMax', 'IsCaptain', 'GPA']);
  _ipAddColumns_(CONFIG.TABS.PLAYERS, ['Stars']);

  const seed = getTab_(tabName);
  const sHead = _ipHeader_(seed);
  const rows = seed.getDataRange().getValues().slice(1);

  const ssh = getTab_(CONFIG.TABS.PLAYER_SEASONS);
  const psHead = _ipHeader_(ssh);
  const psData = ssh.getDataRange().getValues();
  const cPid = psHead.index['PlayerID'], cSeason = psHead.index['SeasonID'];

  // the measurables come from the 2025 roster sheet
  const SEASON = 'SEA-2025';
  const rowOf = {};
  for (var r = 1; r < psData.length; r++) {
    if (_ipStr_(psData[r][cSeason]) !== SEASON) continue;
    const id = _ipStr_(psData[r][cPid]);
    if (id) rowOf[id] = r + 1;
  }

  const plh = getTab_(CONFIG.TABS.PLAYERS);
  const pHead = _ipHeader_(plh);
  const pData = plh.getDataRange().getValues();
  const pRowOf = {};
  for (var q = 1; q < pData.length; q++) {
    const id = _ipStr_(pData[q][pHead.index['PlayerID']]);
    if (id) pRowOf[id] = q + 1;
  }

  var applied = 0, skipped = 0, missing = 0, stars = 0;
  const skippedWho = [], missingWho = [];
  rows.forEach(function (row, i) {
    const pid = _ipStr_(row[sHead.index['PlayerID']]);
    if (!pid) { skipped++; skippedWho.push(_ipWho_(row, sHead, i + 2)); return; }

    const sheetRow = rowOf[pid];
    if (sheetRow) {
      // blank in the source means not measured — never write a 0
      ['HeightInches', 'WeightLbs', 'FortyTime', 'BenchMax'].forEach(function (f) {
        if (sHead.index[f] === undefined) return;
        const v = _ipNum_(row[sHead.index[f]]);
        if (v !== '') _ipSet_(ssh, psHead, sheetRow, f, v);
      });
      const jersey = _ipNum_(row[sHead.index['Jersey']]);
      if (jersey !== '' && jersey >= 0 && jersey <= 99) {
        _ipSet_(ssh, psHead, sheetRow, 'Jersey', jersey);
      }
      applied++;
    } else {
      missing++; missingWho.push(pid);
    }

    const st = _ipNum_(row[sHead.index['Stars']]);
    if (st !== '' && pRowOf[pid]) { _ipSet_(plh, pHead, pRowOf[pid], 'Stars', st); stars++; }
  });

  return {
    skipped: skipped,
    text: 'Measurables: ' + applied + ' ' + SEASON + ' roster rows updated, ' +
          stars + ' star ratings' +
          (missing ? ', ' + missing + ' players had no ' + SEASON + ' roster row (' + missingWho.slice(0, 25).join(', ') + ')' : '') +
          _ipSkipText_(skippedWho)
  };
}

// ── accolades -> Awards ────────────────────────────────────────────────────

function _ipAccolades_(tabName) {
  const cols = ['AwardID', 'PlayerID', 'TeamID', 'SeasonID', 'Award', 'Detail',
                'Source', 'CreatedAt'];
  if (!hasTab_(IP_AWARDS_TAB)) {
    const sh = db_().insertSheet(IP_AWARDS_TAB);
    sh.getRange(1, 1, 1, cols.length).setValues([cols])
      .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
    sh.setFrozenRows(1);
    __tabMap = null;
    __tableCache = {};
  }

  const seed = getTab_(tabName);
  const sHead = _ipHeader_(seed);
  const rows = seed.getDataRange().getValues().slice(1);

  // keyed so a re-run corrects rather than appends a second copy
  const existing = {};
  rowsOf_(IP_AWARDS_TAB).forEach(function (a) {
    existing[_ipStr_(a.PlayerID) + '|' + _ipStr_(a.SeasonID) + '|' + _ipStr_(a.Award)] = true;
  });

  const add = [], skippedWho = [];
  var skipped = 0, dupes = 0;
  rows.forEach(function (row, i) {
    const pid = _ipStr_(row[sHead.index['PlayerID']]);
    if (!pid) { skipped++; skippedWho.push(_ipWho_(row, sHead, i + 2)); return; }
    const seasonId = _ipStr_(row[sHead.index['SeasonID']]);
    const award = _ipStr_(row[sHead.index['Award']]);
    const key = pid + '|' + seasonId + '|' + award;
    if (existing[key]) { dupes++; return; }
    existing[key] = true;
    add.push({
      AwardID: '', PlayerID: pid,
      TeamID: _ipStr_(row[sHead.index['TeamID']]),
      SeasonID: seasonId, Award: award,
      Detail: _ipStr_(row[sHead.index['Detail']]),
      Source: _ipStr_(row[sHead.index['Source']]),
      CreatedAt: new Date()
    });
  });

  if (add.length) appendRows_(IP_AWARDS_TAB, add);

  return {
    skipped: skipped,
    text: 'Accolades: ' + add.length + ' awards added to ' + IP_AWARDS_TAB +
          (dupes ? ', ' + dupes + ' already present' : '') +
          _ipSkipText_(skippedWho)
  };
}

/** Write one cell by column NAME, never by position. */
function _ipSet_(sh, header, sheetRow, column, value) {
  const c = header.index[column];
  if (c === undefined) return false;
  sh.getRange(sheetRow, c + 1).setValue(value);
  return true;
}

/** Read layer: the awards a player has won, newest season first. */
function apiPlayerAwards_(playerId) {
  if (!hasTab_(IP_AWARDS_TAB)) return [];
  return rowsOf_(IP_AWARDS_TAB)
    .filter(function (a) { return _ipStr_(a.PlayerID) === String(playerId); })
    .map(function (a) {
      return { seasonId: _ipStr_(a.SeasonID), award: _ipStr_(a.Award),
               detail: _ipStr_(a.Detail) };
    })
    .sort(function (x, y) { return x.seasonId < y.seasonId ? 1 : -1; });
}