/**
 * UCBAC Stats — Schema.gs
 *
 * Every schema migration lives here and nowhere else. ensureSchema() is the one
 * function to run after a deploy: it creates the tabs the account, correction and
 * notification layers need, and appends the columns the newer modules read.
 *
 * Three rules it never breaks:
 *   1. Columns are only ever APPENDED. Nothing is reordered, renamed or removed —
 *      the seed workbook's column order is load-bearing for the import adapters,
 *      and a removed column takes its data with it.
 *   2. No data cell is ever written. Only row 1 is touched.
 *   3. Running it twice changes nothing. Run it after every deploy.
 *
 * tabHeader() is as much the point of this file as the migrations are.
 * appendRows() maps an object onto the sheet BY COLUMN NAME, so a key that is not
 * a real header lands in no column and the row is written blank — no exception,
 * no warning, just an empty row. That bug has shipped twice. Read the header
 * before you build the object; never remember it.
 */

const SCHEMA = {

  // Tabs this file owns. The ops tabs (AuditLog, StatSubmissions,
  // StatCorrections) are still created by ensureOpsTabs() in Database.gs.
  TABS: {
    ACCOUNTS:      'Accounts',
    NOTIFICATIONS: 'Notifications'
  },

  ACCOUNTS: ['AccountID', 'Email', 'Role', 'Status', 'PlayerID', 'TeamID',
             'DisplayName', 'RequestedRole', 'RequestedTeamID', 'RequestedPlayerID',
             'Note', 'CreatedAt', 'ApprovedBy', 'ApprovedAt', 'LastSeenAt'],

  NOTIFICATIONS: ['NotificationID', 'ToEmail', 'Kind', 'Subject', 'Body',
                  'EntityType', 'EntityID', 'TeamID', 'CreatedAt', 'SentAt', 'Status'],

  TEAMS_ADD: ['HudlURL', 'SchoolURL', 'FacebookURL', 'YouTubeURL', 'TikTokURL',
              'HeadCoach', 'StadiumName'],

  // BirthDate is collected at registration and never published anywhere —
  // it exists so a person claiming a name can be told apart from the name.
  // Offers holds a JSON list of {school, level} — the schools recruiting him,
  // beside the one Commitment he has made.
  PLAYERS_ADD: ['Commitment', 'CommitmentLevel', 'CommitmentDate', 'HudlURL',
                'XHandle', 'InstagramHandle', 'MaxPrepsURL', 'Hometown', 'Bio',
                'Email', 'ProfilePhotoID', 'UpdatedAt', 'UpdatedBy', 'BirthDate',
                'Offers'],

  // Who put a stat line in. Blank and IMPORT and COACH_ENTRY are official;
  // PLAYER_ENTRY is a player's own claim, published in grey until a coach or
  // administrator approves it or an official entry supersedes it.
  PLAYER_STATS_ADD: ['SourceType', 'EnteredBy', 'EnteredAt', 'Pancakes', 'Blocks',
                     'BlockedPunts', 'TwoPointConversions'],

  /* Positions is already present on the live workbook; listing it here is what
     makes a fresh import safe, and addColumns() skips it when it exists.

     The four lifts are season-scoped like height and weight, not career facts:
     a junior's bench is not a senior's, and storing one number per player would
     quietly overwrite last year's every time somebody retested. */
  PLAYER_SEASONS_ADD: ['IsCaptain', 'GPA', 'Positions',
                       'Forty', 'Bench', 'Squat', 'Clean', 'Vertical', 'Shuttle'],

  CORRECTIONS_ADD: ['Status', 'ReviewedBy', 'ReviewedAt', 'SeasonID', 'TeamID'],

  /* Who forfeited: the forfeiting side's TeamID, or its name when it has no
     row here (an outside opponent). The standings read it before they read
     the Notes column, and the Scores page writes it. */
  GAMES_ADD: ['ForfeitBy'],

  /* The 2023 team sheet reports points scored and fumble recoveries, which the
     original TeamSeasons tab had no columns for. */
  TEAM_SEASONS_ADD: ['PointsFor', 'DefFR']
};

/**
 * The measured numbers a roster row carries, in the order they are shown.
 *
 * One list, read by the roster editor, the player's own profile and both save
 * paths. Two lists would drift, and the drift would look like a coach and a
 * player disagreeing about what a player is allowed to report about himself.
 *
 * Every range is a refusal boundary, not a hint. A 40 time of 2.1 seconds and a
 * bench of 4 pounds are both typing mistakes, and a published measurable nobody
 * can defend is worse than a blank one — which is why blank stays blank here and
 * never becomes zero.
 */
const MEASURABLES = [
  // `unit` is the word beside the column heading — "HT (ft)", "WT (lbs)".
  // Height is stored in inches and entered and shown as feet and inches.
  { key: 'heightInches', col: 'HeightInches', label: 'Ht (ft)', short: 'Ht', unit: 'ft',
    min: 48, max: 90,   step: 1,    dp: 0 },
  { key: 'weightLbs',    col: 'WeightLbs',    label: 'Wt (lbs)', short: 'Wt', unit: 'lbs',
    min: 80, max: 450,  step: 1,    dp: 0 },
  { key: 'gpa',          col: 'GPA',          label: 'GPA',     short: 'GPA', unit: '',
    min: 0,  max: 5,    step: 0.01, dp: 3 },
  { key: 'forty',        col: 'Forty',        label: '40 (sec)', short: '40', unit: 'sec',
    min: 4,  max: 8,    step: 0.01, dp: 2 },
  { key: 'bench',        col: 'Bench',        label: 'Bench (lbs)', short: 'Bench', unit: 'lbs',
    min: 45, max: 700,  step: 5,    dp: 0 },
  { key: 'squat',        col: 'Squat',        label: 'Squat (lbs)', short: 'Squat', unit: 'lbs',
    min: 45, max: 1000, step: 5,    dp: 0 },
  { key: 'clean',        col: 'Clean',        label: 'Clean (lbs)', short: 'Clean', unit: 'lbs',
    min: 45, max: 600,  step: 5,    dp: 0 },
  { key: 'vertical',     col: 'Vertical',     label: 'Vertical (in)', short: 'Vert', unit: 'in',
    min: 10, max: 50,   step: 0.5,  dp: 1 },
  { key: 'shuttle',      col: 'Shuttle',      label: '5-10-5 Shuttle (sec)', short: 'Shuttle', unit: 'sec',
    min: 3.5, max: 8,   step: 0.01, dp: 2 }
];

function measurableByKey_(key) {
  for (var i = 0; i < MEASURABLES.length; i++)
    if (MEASURABLES[i].key === key) return MEASURABLES[i];
  return null;
}

/**
 * A measurable's stored value, or '' for blank. Throws on anything else.
 *
 * Blank is emphatically not zero. A cleared 40 time means nobody has timed him;
 * a zero would publish him as the fastest player in conference history.
 */
function measurableValue_(key, raw) {
  const m = measurableByKey_(key);
  if (!m) throw new Error('"' + key + '" is not a measurable.');
  if (raw === '' || raw === null || raw === undefined) return '';

  const n = Number(raw);
  if (isNaN(n)) throw new Error(m.label + ' "' + raw + '" is not a number.');
  if (n < m.min || n > m.max)
    throw new Error(m.label + ' "' + raw + '" is outside ' + m.min + '–' + m.max + '.');

  const f = Math.pow(10, m.dp);
  return Math.round(n * f) / f;
}

// ── the primitive every other module should reach for ───────────────────────

/**
 * The real header row of a tab, trimmed.
 *
 * Reads the sheet rather than readTable()'s per-execution memo, so a column added
 * earlier in this same execution is visible immediately.
 *
 * Call this before building any object for appendRows(). appendRows() matches
 * object keys against these exact strings — an invented key lands in no column
 * and the row is written blank. Check, do not guess.
 */
function tabHeader_(tabName) {
  const sh = getTab_(tabName);
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0]
           .map(function (h) { return String(h).trim(); });
}

/**
 * Append whichever of `columnNames` the tab does not already have.
 * Returns the names actually added, in the order they were written.
 *
 * Existing columns are never moved and no cell below row 1 is touched, so this is
 * safe on a tab holding five thousand rows of live data.
 */
function addColumns_(tabName, columnNames) {
  const sh = getTab_(tabName);
  const head = tabHeader_(tabName);
  const missing = [];

  (columnNames || []).forEach(function (c) {
    const name = String(c).trim();
    if (!name) return;
    if (head.indexOf(name) >= 0) return;
    if (missing.indexOf(name) >= 0) return;      // a repeat in the caller's list

    // A header matching apart from case or spacing is a rename, not an addition.
    // Appending a second column would split one field across two, leaving the
    // data in the old one and every future read pointed at the new one.
    for (var i = 0; i < head.length; i++) {
      if (head[i] && normName_(head[i]) === normName_(name)) {
        Logger.log('addColumns: ' + tabName + ' has "' + head[i] + '", not "' + name +
                   '". Left alone — appendRows_() matches headers exactly, so rename ' +
                   'the header by hand before anything writes to it.');
        return;
      }
    }
    missing.push(name);
  });

  if (!missing.length) return [];

  const first = head.length + 1;
  const short = (first + missing.length - 1) - sh.getMaxColumns();
  if (short > 0) sh.insertColumnsAfter(sh.getMaxColumns(), short);

  const cells = sh.getRange(1, first, 1, missing.length);
  cells.setValues([missing]);

  // Match whatever the existing header row looks like rather than imposing the
  // ops-tab palette on a tab that does not use it.
  if (head.length) {
    const model = sh.getRange(1, 1);
    cells.setFontWeight(model.getFontWeight())
         .setFontColor(model.getFontColor())
         .setBackground(model.getBackground());
  } else {
    cells.setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  }
  sh.setFrozenRows(1);

  delete __tableCache[tabName];
  return missing;
}

/**
 * Create a tab with these headers, or bring an existing one up to them.
 * Returns { tab, created, added } — `added` is every header on a tab this call
 * created, and only the appended ones on a tab that already existed.
 */
function ensureTab_(name, headers) {
  if (hasTab_(name)) {
    return { tab: name, created: false, added: addColumns_(name, headers) };
  }

  const cols = (headers || []).map(function (h) { return String(h).trim(); })
                              .filter(function (h) { return h; });
  if (!cols.length) throw new Error('ensureTab_("' + name + '") needs at least one header.');

  const sh = db_().insertSheet(name);
  if (sh.getMaxColumns() < cols.length)
    sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());

  sh.getRange(1, 1, 1, cols.length).setValues([cols])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  sh.setFrozenRows(1);

  __tabMap = null;                 // getTab() memoizes the tab list per execution
  delete __tableCache[name];
  return { tab: name, created: true, added: cols.slice() };
}

/**
 * Headers that differ from what a module will ask for by case or spacing only.
 *
 * Worse than a missing column: getTab() resolves a TAB name tolerantly, but
 * appendRows() matches a COLUMN name exactly, so a header reading "Head Coach"
 * silently swallows every HeadCoach value. Reported, never repaired — renaming a
 * live header is a decision for a person.
 */
function columnConflicts_(tabName, columnNames) {
  const head = tabHeader_(tabName);
  const out = [];
  (columnNames || []).forEach(function (c) {
    const want = String(c).trim();
    if (!want || head.indexOf(want) >= 0) return;
    for (var i = 0; i < head.length; i++) {
      if (head[i] && normName_(head[i]) === normName_(want)) {
        out.push({ want: want, found: head[i] });
        return;
      }
    }
  });
  return out;
}

// ── the migration ───────────────────────────────────────────────────────────

/**
 * Bring the workbook up to the schema every current module expects.
 * Idempotent, additive, and safe to run against live data. Returns a report.
 */
function ensureSchema_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save or migration is in progress. Try again in a moment.');

  try {
    const out = ['SCHEMA MIGRATION', ''];
    const warn = [];

    out.push('TABS');

    // AuditLog / StatSubmissions / StatCorrections predate this file, and the
    // correction columns below assume StatCorrections exists.
    const ops = ensureOpsTabs_();
    out.push('  ' + pad_('ops tabs', 20) +
             (ops.length ? 'created ' + ops.join(', ') : 'already present'));

    [[SCHEMA.TABS.ACCOUNTS,      SCHEMA.ACCOUNTS],
     [SCHEMA.TABS.NOTIFICATIONS, SCHEMA.NOTIFICATIONS],
     // sign-in sessions (Auth.gs); also created lazily on the first sign-in
     ['Sessions', ['SessionHash', 'Email', 'CreatedAt', 'LastSeenAt',
                   'ExpiresAt', 'RevokedAt']]].forEach(function (spec) {
      const name = spec[0], cols = spec[1];
      if (hasTab_(name)) {
        columnConflicts_(name, cols).forEach(function (c) { warn.push(conflictNote_(name, c)); });
      }
      const r = ensureTab_(name, cols);
      out.push('  ' + pad_(name, 20) +
               (r.created ? 'created with ' + r.added.length + ' columns'
                          : (r.added.length ? 'existed — added ' + r.added.join(', ')
                                            : 'already correct')));
    });

    out.push('');
    out.push('COLUMNS');
    schemaAddTo_(CONFIG.TABS.TEAMS,          SCHEMA.TEAMS_ADD,          out, warn);
    schemaAddTo_(CONFIG.TABS.PLAYERS,        SCHEMA.PLAYERS_ADD,        out, warn);
    schemaAddTo_(CONFIG.TABS.PLAYER_SEASONS, SCHEMA.PLAYER_SEASONS_ADD, out, warn);
    schemaAddTo_(CONFIG.TABS.PLAYER_STATS,   SCHEMA.PLAYER_STATS_ADD,   out, warn);
    if (hasTab_('StatsImport'))
      schemaAddTo_('StatsImport', ['BlockedPunts', 'TwoPointConversions'], out, warn);
    schemaAddTo_(CONFIG.TABS.CORRECTIONS,    SCHEMA.CORRECTIONS_ADD,    out, warn);
    schemaAddTo_(CONFIG.TABS.GAMES,          SCHEMA.GAMES_ADD,          out, warn);
    schemaAddTo_(CONFIG.TABS.TEAM_SEASONS,   SCHEMA.TEAM_SEASONS_ADD,   out, warn);

    if (warn.length) {
      out.push('');
      out.push('NEEDS A HUMAN');
      warn.forEach(function (w) { out.push('  ' + w); });
    }

    out.push('');
    out.push('No column was reordered, renamed or removed. No data cell was written.');

    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** One tab's column migration, appended to the running report. */
function schemaAddTo_(tabName, columns, out, warn) {
  if (!hasTab_(tabName)) {
    out.push('  ' + pad_(tabName, 20) + 'MISSING — not touched');
    warn.push(tabName + ' does not exist in this workbook. Run listTabs_() to see ' +
              'the exact names, then check the import.');
    return;
  }
  columnConflicts_(tabName, columns).forEach(function (c) { warn.push(conflictNote_(tabName, c)); });

  const added = addColumns_(tabName, columns);
  out.push('  ' + pad_(tabName, 20) +
           (added.length ? 'added ' + added.join(', ') : 'already complete'));
}

function conflictNote_(tabName, c) {
  return tabName + ': header reads "' + c.found + '", modules ask for "' + c.want +
         '". Not added — appendRows_() would write blanks either way. Rename the ' +
         'header cell by hand, then re-run ensureSchema_().';
}

/** Menu entry. Safe to run any number of times. */
function menuEnsureSchema_() {
  const msg = ensureSchema_();
  try {
    SpreadsheetApp.getUi().alert('Schema migration', msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

/** Scoped activation: only the two approved optional stat headers. */
function menuEnsureConversionSchema() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== owner) throw new Error('Run this migration from the owner Apps Script editor.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another save is in progress.');
  try {
    const fields = ['BlockedPunts', 'TwoPointConversions'];
    const tabs = [CONFIG.TABS.PLAYER_STATS, 'StatsImport'];
    tabs.forEach(function (tab) {
      if (!hasTab_(tab)) throw new Error('Missing tab: ' + tab);
      if (columnConflicts_(tab, fields).length) throw new Error('Conflicting headers on ' + tab);
    });
    const report = tabs.map(function (tab) {
      const added = addColumns_(tab, fields);
      const sh = getTab_(tab), head = tabHeader_(tab);
      // Inserted columns can inherit EnteredAt's date format. Counts must be
      // numeric on getValues(), never Date objects converted to epoch millis.
      fields.forEach(function (field) {
        if (sh.getMaxRows() > 1)
          sh.getRange(2, head.indexOf(field) + 1, sh.getMaxRows() - 1, 1).setNumberFormat('0');
      });
      return tab + ': ' + added.join(', ') + ' (integer formatting verified)';
    }).join('\n');
    Logger.log(report);
    return report;
  } finally { lock.releaseLock(); }
}

/** Owner editor runner: incumbent rebuild/cache/snapshot path without UI dialogs. */
function menuRebuildConversionStats() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== owner) throw new Error('Run this rebuild from the owner Apps Script editor.');
  return runRebuild_('manual');
}
