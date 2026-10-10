/**
 * UCBAC Stats — Setup.gs
 * Menu + verification. Run verifyDatabase() first; then rebuildDerived().
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('UCBAC Stats')
    .addItem('First-run setup', 'firstRunSetup')
    .addSeparator()
    .addItem('Verify database', 'verifyDatabase')
    .addItem('Rebuild everything now', 'menuRebuildAll')
    .addSubMenu(ui.createMenu('Coaches')
      .addItem('Make me an administrator', 'setupAdmin')
      .addItem('Add an administrator…', 'menuAddAdmin')
      .addItem('Update head coaches', 'menuUpdateHeadCoaches')
      .addItem('Seed coach profiles (dry run)', 'menuSeedCoachProfilesDry')
      .addItem('Seed coach profiles (APPLY)', 'menuSeedCoachProfilesApply')
      .addItem('Head coach emails (dry run)', 'menuSeedCoachEmailsDry')
      .addItem('Head coach emails (APPLY)', 'menuSeedCoachEmailsApply')
      .addItem('Check sign-in', 'menuCheckPortal')
      .addItem('Fix mail', 'menuFixMail')
      .addItem('Emergency sign-in code…', 'menuMintLoginCode')
      .addItem('List coaches', 'listCoaches')
      .addItem('List team IDs', 'listTeams')
      .addItem('Who am I?', 'whoAmIReally'))
    .addSubMenu(ui.createMenu('Stats')
      .addItem('Open the StatsImport tab', 'menuStatsImportTab')
      .addItem('Import (dry run)', 'menuStatsImportDry')
      .addItem('Import (APPLY)', 'menuStatsImportApply')
      .addItem('Remove saved rows from the tab', 'menuStatsImportClear')
      .addSeparator()
      .addItem('Where is the inbox folder?', 'menuStatsInboxOpen_')
      .addItem('Read the inbox (files → StatsImport)', 'menuStatsInbox_')
      .addSeparator()
      .addItem('Email pending stat corrections (dry run)', 'menuCorrectionMailDry')
      .addItem('Email pending stat corrections (SEND)', 'menuCorrectionMailApply'))
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Backfill positions', 'backfillPositions')
      .addItem('Import rosters (dry run)', 'menuImportRosterDry')
      .addItem('Import rosters (APPLY)', 'menuImportRosterApply')
      .addItem('Resolve stat rows (dry run)', 'menuResolveStatsDry')
      .addItem('Resolve stat rows (APPLY)', 'menuResolveStatsApply')
      /* Import2023 has been deleted from the project, and these two items went
         with it: a menu entry naming a function that no longer exists throws
         "Script function could not be found" the moment anyone clicks it. The
         file is in the repository if the 2023 numbers ever need redoing. */
      .addItem('Import profile seeds', 'importProfileSeeds')
      .addItem('Seed postseason records (dry run)', 'menuSeedPostseasonDry')
      .addItem('Seed postseason records (APPLY)', 'menuSeedPostseasonApply')
      .addItem('Repair PlayerIDs (dry run)', 'menuRepairDryRun')
      .addItem('Merge split players (dry run)', 'menuMergeDryRun')
      .addItem('Merge split players (APPLY)', 'menuMergeApply')
      .addItem('Merge two players by ID…', 'menuMergePairApply')
      .addItem('Restore orphaned players (dry run)', 'menuOrphanDryRun')
      .addItem('Restore orphaned players (APPLY)', 'menuOrphanApply')
      .addItem('Install rebuild schedule', 'installTriggers')
      .addItem('Install the Sunday Top Plays digest', 'menuInstallPlaysDigest')
      .addItem('Send the Top Plays digest now', 'menuPlaysDigestNow')
      .addItem('Install nightly backup', 'menuInstallBackup')
      .addItem('Back up workbook now', 'menuBackupNow')
      .addSubMenu(ui.createMenu('Daily summaries')
        .addItem('Install morning publication schedule', 'dailySummaryInstall_')
        .addItem('Generate today’s editions', 'dailySummaryNow_')
        .addItem('Pause automatic publication', 'dailySummaryPause_')
        .addItem('Publication status', 'dailySummaryStatus_'))
      .addItem('Blitz usage', 'menuChatUsage')
      .addItem('Which models can Blitz use?', 'menuChatModels_')
      .addItem('Blitz emails on/off', 'menuChatNotify')
      .addItem('Traffic — yesterday', 'menuTrafficReport')
      .addItem('Install the morning traffic email', 'menuInstallTrafficDigest')
      .addItem('Send the traffic email now', 'menuTrafficNow')
      .addItem('Morning traffic email on/off', 'menuTrafficOnOff')
      .addItem('Baseline stats coverage (Allowed boards)', 'menuBaselineCoverage')
      .addItem('Refresh site cache', 'menuClearCache')
      .addItem('Check share pages', 'menuShareCheck')
      .addItem('Build status', 'menuBuildStatus')
      .addItem('Create ops tabs', 'menuEnsureOps')
      .addItem('Show exception summary', 'menuExceptions'))
    .addToUi();
}

/**
 * The merge had a dry run on the menu and no way to finish it, so the only way
 * through was the Apps Script editor - which is a strange place to send someone
 * for the destructive half of an operation whose safe half is two clicks away.
 * Every other pair here is dry-run-then-APPLY; this one is now too.
 *
 * It asks first. Merging absorbs one career into another and deletes the row
 * left behind, and unlike an import there is no file to run again afterwards.
 */
function menuMergeApply() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Merge split players — APPLY',
    'This absorbs each duplicate career into the one it belongs to and deletes ' +
    'the row left behind. Sign-in accounts and profile history follow the ' +
    'player.\n\nRun the dry run first if you have not, and read the list.\n\n' +
    'Proceed?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return 'Cancelled — nothing was written.';
  const msg = mergeSplitPlayersApply_();
  ui.alert('Merge split players — applied',
    (msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg) +
    '\n\nRun Rebuild everything now: every career computed before this is short a season.',
    ui.ButtonSet.OK);
  return msg;
}

function menuMergeDryRun() {
  const msg = mergeSplitPlayersDryRun_();
  SpreadsheetApp.getUi().alert('Merge split players — dry run',
    msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg,
    SpreadsheetApp.getUi().ButtonSet.OK);
  return msg;
}

/**
 * Drop the cached boot payload and the cached tables behind it.
 *
 * Editing the sheet directly - a logo swapped on the Media tab, a colour, a
 * head coach - changes nothing anyone can see for up to fifteen minutes,
 * because the site reads a cached copy. The write paths in the code clear the
 * cache themselves; a human editing a cell has no way to, which is why this
 * is on the menu.
 */
function menuClearCache() {
  const msg = clearApiCache_();
  SpreadsheetApp.getUi().alert('Site cache',
    msg + '\n\nReload the site to see sheet edits (logo, colours, coaches) right away.',
    SpreadsheetApp.getUi().ButtonSet.OK);
  return msg;
}

function menuInstallBackup() {
  SpreadsheetApp.getUi().alert('Nightly backup', installWorkbookBackupTrigger_(),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuBackupNow() {
  SpreadsheetApp.getUi().alert('Backup', runWorkbookBackupNow_(),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuRepairDryRun() {
  const msg = repairPlayerIdsDryRun_();
  SpreadsheetApp.getUi().alert('PlayerID repair — dry run',
    msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg,
    SpreadsheetApp.getUi().ButtonSet.OK);
  return msg;
}

function menuBuildStatus() {
  const s_ = buildStatus_();
  SpreadsheetApp.getUi().alert('Build status',
    'Last rebuild:  ' + s_.lastBuild +
    '\nPending changes: ' + (s_.dirty || 'none') +
    '\nTriggers: ' + (s_.triggersInstalled.join(', ') || 'NONE — run Install rebuild schedule') +
    (s_.lastError ? '\n\nLast error: ' + s_.lastError : ''),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuRebuild_()     { SpreadsheetApp.getUi().alert(runRebuild_('manual')); }

/** Derived layer plus every season's All-Conference ballot. */
function menuRebuildAll() {
  SpreadsheetApp.getUi().alert('Rebuild', runRebuild_('manual'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}
function menuEnsureOps()   {
  var made = ensureOpsTabs_();
  SpreadsheetApp.getUi().alert(made.length ? 'Created: ' + made.join(', ') : 'All ops tabs already exist.');
}

/**
 * Confirms every expected tab exists, reports row counts, and runs integrity
 * checks that would silently corrupt aggregates if they failed.
 */
function verifyDatabase() {
  const out = [];
  const expect = {
    'Seasons': 4, 'Teams': 15, 'Media': 71, 'Games': 265, 'Players': 563,
    'PlayerSeasons': 743, 'PlayerGameStats': 5069, 'TeamGameStats': 987,
    'TeamSeasons': 15, 'Exceptions': 1603
  };

  out.push('TABS');
  var ok = true;
  Object.keys(expect).forEach(function (t) {
    var sh = db_().getSheetByName(t);
    if (!sh) { out.push('  MISSING  ' + t); ok = false; return; }
    var n = Math.max(0, sh.getLastRow() - 1);
    var flag = (n === expect[t]) ? 'ok' : ('expected ' + expect[t]);
    if (n !== expect[t]) ok = false;
    out.push('  ' + pad_(t, 18) + pad_(String(n), 7) + flag);
  });

  // ---- integrity ----
  out.push('');
  out.push('INTEGRITY');

  const stats   = rowsOf_(CONFIG.TABS.PLAYER_STATS);
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return p.PlayerID; });
  const teams   = indexBy_(rowsOf_(CONFIG.TABS.TEAMS),   function (t) { return t.TeamID; });
  const games   = indexBy_(rowsOf_(CONFIG.TABS.GAMES),   function (g) { return g.GameID; });

  var grain = {}, noPlayer = 0, badPlayer = 0, badTeam = 0, badGame = 0;
  /* A count of one dangling reference is a count of one needle in 5,440 rows.
     Name the id and the row it sits on, or the person reading this has no way
     to act on it. These appear when a Players row is deleted by hand: the
     merge tools repoint every reference before deleting, deleting the row
     directly does not. */
  const badPlayerIds = {};
  for (var i = 0; i < stats.length; i++) {
    var r = stats[i];
    var g = String(r.grain || r.Grain || '').trim();
    grain[g] = (grain[g] || 0) + 1;
    var pid = String(r.PlayerID || '').trim();
    if (!pid) noPlayer++;
    else if (!players[pid]) {
      badPlayer++;
      (badPlayerIds[pid] = badPlayerIds[pid] || []).push(r.__row || (i + 2));
    }
    var tid = String(r.TeamID || '').trim();
    if (tid && !teams[tid]) badTeam++;
    var gid = String(r.GameID || '').trim();
    if (gid && !games[gid]) badGame++;
  }
  Object.keys(grain).forEach(function (k) {
    out.push('  grain ' + pad_(k || '(blank)', 16) + grain[k]);
  });
  out.push('  stat rows with no PlayerID     ' + noPlayer + '   (unresolved -> exception queue)');
  out.push('  PlayerID not in Players        ' + badPlayer);
  Object.keys(badPlayerIds).sort().slice(0, 10).forEach(function (pid) {
    const rows = badPlayerIds[pid];
    out.push('      ' + pid + ' — ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') +
             ', ' + CONFIG.TABS.PLAYER_STATS + ' row ' + rows.slice(0, 8).join(', ') +
             (rows.length > 8 ? ' …' : ''));
  });
  if (Object.keys(badPlayerIds).length > 10)
    out.push('      ...and ' + (Object.keys(badPlayerIds).length - 10) + ' more ids');
  out.push('  TeamID not in Teams            ' + badTeam);
  out.push('  GameID not in Games            ' + badGame);

  const exc = rowsOf_(CONFIG.TABS.EXCEPTIONS);
  var sev = {};
  exc.forEach(function (e) { var s_ = String(e.Severity).trim(); sev[s_] = (sev[s_] || 0) + 1; });
  out.push('');
  out.push('EXCEPTION QUEUE');
  Object.keys(sev).forEach(function (s_) { out.push('  ' + pad_(s_, 18) + sev[s_]); });

  out.push('');
  out.push(ok ? 'All tabs present with expected row counts.'
              : 'Row counts differ from the seed — check the import.');

  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('UCBAC database check', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function menuExceptions() {
  const exc = rowsOf_(CONFIG.TABS.EXCEPTIONS);
  var byType = {};
  exc.forEach(function (e) {
    var t = String(e.Type).trim();
    byType[t] = (byType[t] || 0) + 1;
  });
  var keys = Object.keys(byType).sort(function (a, b) { return byType[b] - byType[a]; });
  var lines = keys.slice(0, 20).map(function (k) { return pad_(k, 30) + byType[k]; });
  var msg = 'Exception queue — ' + exc.length + ' open\n\n' + lines.join('\n');
  SpreadsheetApp.getUi().alert(msg);
  return msg;
}

function pad_(s_, n) {
  s_ = String(s_);
  while (s_.length < n) s_ += ' ';
  return s_;
}