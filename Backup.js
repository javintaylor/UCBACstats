/**
 * UCBAC Stats — Backup.gs
 *
 * Every 24 hours the database workbook is copied into its own backup
 * spreadsheet, so one bad edit, one bad import, or one bad script can never
 * be the only surviving version of the season.
 *
 * The shape of the run:
 *
 *   1. A nightly time-driven trigger fires ucbacNightlyWorkbookBackup after
 *      the 3:00 rebuild, so the copy carries that night's derived tabs.
 *      Install it once with installWorkbookBackupTrigger() — idempotent, it
 *      deletes any existing trigger for the handler first. Test any time with
 *      runWorkbookBackupNow().
 *
 *   2. What gets backed up is a registry, one line per workbook. Today it
 *      holds only the database; adding a second workbook is adding a line.
 *
 *   3. The destination is found by NAME, not ID — 'UCBAC Master' at the top
 *      of Drive, 'UCBAC Workbook Backups' inside it — and both are created if
 *      missing, so the backup survives the folder being moved, recreated, or
 *      never made in the first place.
 *
 *   4. Copy first, replace second. The new copy is made under the fixed name,
 *      and only once it exists are the older copies of that name trashed. A
 *      failure mid-run can leave you with two backups, never zero. Trash is
 *      not deletion: Drive keeps trashed files ~30 days, a second window on
 *      yesterday if tonight's copy captured a disaster.
 *
 *   5. Each workbook runs in its own try/catch, so one failure cannot stop
 *      the rest, and any failure mails the run summary to the admin.
 */

const BACKUP = {
  PARENT_FOLDER: 'UCBAC Master',
  BACKUP_FOLDER: 'UCBAC Workbook Backups',
  ALERT_EMAIL: 'contact@example.invalid',
  NIGHTLY_HOUR: 4  // the rebuild runs at 3; the backup snapshots its result
};

/**
 * The registry: one line per workbook. A function, not a constant, and the
 * distinction is load-bearing: Apps Script runs every file's top level in
 * file-list order, and a constant reading CONFIG here would throw in any
 * project where this file sits above Config — which kills the whole project,
 * menus included, with no visible error. Resolved at run time, order cannot
 * matter.
 */
function backupSources_() {
  return [
    { spreadsheetId: CONFIG.DB_ID, backupName: 'UCBAC_Database backup' }
    // { spreadsheetId: '...', backupName: '... backup' },
  ];
}

/**
 * The backup folder, found or created by name. Only the first match at each
 * level is used, so two folders sharing the name would split the history —
 * a state this never creates, since it only makes a folder it cannot find.
 */
function backupFolder_() {
  const roots = DriveApp.getRootFolder().getFoldersByName(BACKUP.PARENT_FOLDER);
  const parent = roots.hasNext() ? roots.next()
    : DriveApp.getRootFolder().createFolder(BACKUP.PARENT_FOLDER);
  const kids = parent.getFoldersByName(BACKUP.BACKUP_FOLDER);
  return kids.hasNext() ? kids.next() : parent.createFolder(BACKUP.BACKUP_FOLDER);
}

/** The nightly handler. Never assumes the last run finished, or ever ran. */
function ucbacNightlyWorkbookBackup() {
  const folder = backupFolder_();
  const sources = backupSources_();
  const lines = [], failures = [];

  sources.forEach(function (src) {
    try {
      const copy = DriveApp.getFileById(src.spreadsheetId)
        .makeCopy(src.backupName, folder);

      // The new copy exists; NOW the older ones under this name can go.
      var trashed = 0;
      const olds = folder.getFilesByName(src.backupName);
      while (olds.hasNext()) {
        const f = olds.next();
        if (f.getId() === copy.getId()) continue;
        f.setTrashed(true);
        trashed++;
      }
      lines.push('OK      ' + src.backupName +
                 (trashed ? '  (replaced ' + trashed + ')' : '  (first copy)'));
    } catch (e) {
      failures.push(src.backupName + ': ' + (e && e.message ? e.message : e));
      lines.push('FAILED  ' + src.backupName + '  ' +
                 (e && e.message ? e.message : e));
    }
  });

  const summary = 'UCBAC nightly backup — ' + new Date().toISOString() + '\n' +
                  lines.join('\n');
  Logger.log(summary);

  if (failures.length) {
    try {
      MailApp.sendEmail(BACKUP.ALERT_EMAIL,
        'UCBAC backup FAILED (' + failures.length + ' of ' +
        sources.length + ')',
        summary + '\n\nThe last successful copy of each failed workbook is ' +
        'still in place — copy-first means a failure never removes one.');
    } catch (e2) {
      Logger.log('Backup alert mail failed too: ' +
                 (e2 && e2.message ? e2.message : e2));
    }
  }
  return summary;
}

/**
 * Install the nightly trigger. Safe to re-run: existing triggers for the
 * handler are deleted first, so there is always exactly one.
 */
function installWorkbookBackupTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['ucbacNightlyWorkbookBackup', 'ucbacNightlyWorkbookBackup_']
        .indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('ucbacNightlyWorkbookBackup').timeBased()
    .everyDays(1).atHour(BACKUP.NIGHTLY_HOUR).create();
  const msg = 'Installed: ucbacNightlyWorkbookBackup daily in the ' +
              BACKUP.NIGHTLY_HOUR + ':00 hour, ' + backupSources_().length +
              ' workbook(s) -> "' + BACKUP.PARENT_FOLDER + '/' +
              BACKUP.BACKUP_FOLDER + '".';
  Logger.log(msg);
  return msg;
}

/** Run the backup right now — for testing, or before something risky. */
function runWorkbookBackupNow_() {
  return ucbacNightlyWorkbookBackup();
}
