/**
 * UCBAC Stats — Triggers.gs
 *
 * Keeps the derived layer current without anyone remembering to rebuild it.
 *
 * Rosters change at unpredictable intervals for weeks at a time, so nothing here
 * assumes a starting point or a finished state. Edits mark the database dirty; a
 * short-interval trigger notices and rebuilds. A nightly pass rebuilds
 * unconditionally so a dropped flag can never leave the site stale for long.
 *
 * Run installTriggers() once. It is idempotent — it removes this project's
 * existing triggers before installing, so running it twice is harmless.
 */

const TRG = {
  DIRTY_KEY: 'UCBAC_DIRTY',
  LAST_BUILD_KEY: 'UCBAC_LAST_BUILD',
  LAST_ERROR_KEY: 'UCBAC_LAST_ERROR',
  SWEEP_MINUTES: 15,
  NIGHTLY_HOUR: 3,
  // Mail is checked on its own schedule, not the rebuild's. A player's
  // correction request marks nothing dirty, so a sweep that only runs when the
  // database changed would leave his coach unmailed until somebody edited a
  // roster.
  MAIL_MINUTES: 5
};

function props_() { return PropertiesService.getScriptProperties(); }

/**
 * Mark the database as needing a rebuild. Called from every write path.
 * `scope` is a comma-joined set so a burst of edits collapses into one rebuild.
 */
function markDirty_(scope) {
  if (typeof appPublicMarkEdit_ === 'function') appPublicMarkEdit_();
  const p = props_();
  const cur = String(p.getProperty(TRG.DIRTY_KEY) || '');
  const set = {};
  cur.split(',').forEach(function (s_) { if (s_) set[s_] = true; });
  (scope || 'all').split(',').forEach(function (s_) { if (s_) set[s_] = true; });
  p.setProperty(TRG.DIRTY_KEY, Object.keys(set).join(','));
}

function isDirty_() { return !!String(props_().getProperty(TRG.DIRTY_KEY) || ''); }
function clearDirty_() { props_().deleteProperty(TRG.DIRTY_KEY); }

/** Runs every SWEEP_MINUTES. Cheap when nothing changed. */
function sweepRebuild() {
  // Explicit READY batches only; the legacy StatsImport tab is never scanned.
  // Queue failures do not suppress the existing derived-layer rebuild.
  try { if (typeof sqWorker_ === 'function') sqWorker_(); }
  catch (e) { Logger.log('Bounded stats queue paused this sweep: ' + String(e.message || '').replace(/[^A-Z_]/g,'').slice(0,80)); }
  if (!isDirty_()) return 'clean — nothing to do';
  return runRebuild_('sweep');
}

/** Runs nightly regardless of the flag. */
function nightlyRebuild() { return runRebuild_('nightly'); }

/**
 * The one place a rebuild actually happens. Serialized, so a nightly pass and a
 * sweep firing together cannot interleave and half-write the derived tabs.
 */
function runRebuild_(reason) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'another rebuild is already running — skipped';
  const t0 = new Date().getTime();
  try {
    const appPublicBuild = typeof appPublicRebuildBegin_ === 'function' && appPublicRebuildBegin_();
    const log = [];
    log.push(rebuildDerived_());

    // A completed season's inputs no longer change, so the sweep only touches
    // the active one. A nightly or an explicit full pass does every season —
    // and the first run must, or the historical ballots never exist at all.
    const full = appPublicBuild || (reason === 'nightly' || reason === 'setup' || reason === 'manual');
    rowsOf_(CONFIG.TABS.SEASONS).forEach(function (s_) {
      const sid = String(s_.SeasonID).trim();
      const status = String(s_.Status || '').toUpperCase();
      if (full || sid === CONFIG.CURRENT_SEASON || status === 'ACTIVE') {
        log.push(rebuildAllConference_(sid));
      }
    });

    clearDirty_();
    /* The derived tabs now hold new numbers and the site is still serving the
       old ones, for up to fifteen minutes, from a cache that has no idea a
       rebuild happened. Somebody who enters Friday's scores and then looks at
       the standings sees last week's table and reasonably concludes the
       rebuild did not work. A rebuild that leaves the site showing the
       previous answer has not finished. */
    try { clearApiCache_(); } catch (ignore) {}
    const secs = ((new Date().getTime() - t0) / 1000).toFixed(1);
    const msg = '[' + reason + '] rebuilt in ' + secs + 's\n' + log.join('\n');
    props_().setProperty(TRG.LAST_BUILD_KEY, new Date().toISOString());
    props_().deleteProperty(TRG.LAST_ERROR_KEY);
    if (typeof appPublicRebuildFinish_ === 'function') appPublicRebuildFinish_(true);
    Logger.log(msg);
    return msg;
  } catch (e) {
    if (typeof appPublicRebuildFinish_ === 'function') appPublicRebuildFinish_(false);
    // leave the dirty flag set so the next sweep retries
    props_().setProperty(TRG.LAST_ERROR_KEY, new Date().toISOString() + '  ' + e.message);
    Logger.log('REBUILD FAILED (' + reason + '): ' + e.stack);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deliver whatever is queued in Notifications.
 *
 * Its own trigger, deliberately. sendPendingNotifications() has existed since
 * the account layer went in and nothing ever called it, so every approval
 * request, correction and decision since then has been written to the tab and
 * left there — the queue worked, the delivery was never scheduled, and the
 * symptom was silence rather than an error anybody could see.
 *
 * Never throws. A time trigger that throws mails the owner a stack trace on
 * every firing, which is a worse mailing problem than the one it reports.
 */
function deliverNotifications() {
  try {
    return sendPendingNotifications_();
  } catch (e) {
    Logger.log('deliverNotifications failed: ' + (e && e.message ? e.message : e));
    return 'failed: ' + (e && e.message ? e.message : e);
  }
}

/** Install the schedule. Safe to re-run. */
function installTriggers() {
  removeTriggers_();
  ScriptApp.newTrigger('sweepRebuild').timeBased()
    .everyMinutes(TRG.SWEEP_MINUTES).create();
  ScriptApp.newTrigger('nightlyRebuild').timeBased()
    .everyDays(1).atHour(TRG.NIGHTLY_HOUR).create();
  ScriptApp.newTrigger('deliverNotifications').timeBased()
    .everyMinutes(TRG.MAIL_MINUTES).create();
  const msg = 'Installed: sweepRebuild every ' + TRG.SWEEP_MINUTES +
              ' minutes, nightlyRebuild at ' + TRG.NIGHTLY_HOUR + ':00, ' +
              'deliverNotifications every ' + TRG.MAIL_MINUTES + ' minutes.';
  Logger.log(msg);
  return msg;
}

function removeTriggers_() {
  const all = ScriptApp.getProjectTriggers();
  var removed=0;
  all.forEach(function (t) {
    const fn = t.getHandlerFunction();
    /* Both spellings. A trigger installed while the handlers were briefly
       private is still out there under the underscored name, and clearing it
       is this function's job — otherwise reinstalling leaves a dead copy
       beside the live one. */
    if (['sweepRebuild', 'nightlyRebuild', 'deliverNotifications',
         'sweepRebuild_', 'nightlyRebuild_', 'deliverNotifications_'].indexOf(fn) >= 0) {
      ScriptApp.deleteTrigger(t); removed++;
    }
  });
  return 'Removed ' + removed + ' trigger(s).';
}

/** Operational status, for the admin view and for eyeballing in the editor. */
function buildStatus_() {
  const p = props_();
  const triggers = ScriptApp.getProjectTriggers()
    .filter(function (t) {
      return ["sweepRebuild", "nightlyRebuild"].indexOf(t.getHandlerFunction()) >= 0;
    })
    .map(function (t) { return t.getHandlerFunction(); });
  return {
    dirty: String(p.getProperty(TRG.DIRTY_KEY) || ''),
    lastBuild: p.getProperty(TRG.LAST_BUILD_KEY) || 'never',
    lastError: p.getProperty(TRG.LAST_ERROR_KEY) || '',
    triggersInstalled: triggers,
    sweepMinutes: TRG.SWEEP_MINUTES
  };
}
