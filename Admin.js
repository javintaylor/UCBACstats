/**
 * UCBAC Stats — Admin.gs
 *
 * First-run setup and coach management. Everything here is safe to run twice.
 *
 * If you are setting this up for the first time, run firstRunSetup(). It creates
 * the tabs the portal needs, makes you an administrator, backfills positions
 * from the historical roster text, and installs the rebuild schedule.
 */

/** The one function to run on a fresh project. Idempotent. */
function firstRunSetup() {
  const out = [];

  out.push('1. Operational tabs');
  const made = ensureOpsTabs_();
  ensureCoachesTab_();
  ensureAllConferenceTab_();
  out.push('   ' + (made.length ? 'created ' + made.join(', ') : 'already present') +
           ', Coaches, AllConference');

  out.push('');
  out.push('2. Administrator');
  out.push('   ' + setupAdmin());

  out.push('');
  out.push('3. Positions backfilled from historical roster text');
  out.push('   ' + backfillPositions());

  out.push('');
  out.push('4. Rebuild schedule');
  try { out.push('   ' + installTriggers()); }
  catch (e) { out.push('   could not install triggers: ' + e.message); }

  out.push('');
  out.push('5. First build');
  // The sweep only fires when something is marked dirty, so without an explicit
  // build here the derived tabs and every All-Conference ballot stay empty until
  // the first roster edit — which reads as a broken site.
  try { out.push('   ' + runRebuild_('setup').split('\n').join('\n   ')); }
  catch (e) { out.push('   build failed: ' + e.message); }

  out.push('');
  out.push('Next: run repairPlayerIdsDryRun_() before trusting any career total.');

  const msg = out.join('\n');
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert('UCBAC first-run setup', msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

/**
 * Make whoever runs this an administrator.
 *
 * Run it from the Apps Script editor and it uses the account you are signed in
 * as — there is nothing to type and no tab to create by hand.
 */
function setupAdmin() {
  const email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
  if (!email) return 'Could not determine your email. Use addCoach_("contact@example.invalid", "", "ADMIN").';
  return addCoach_(email, '', 'ADMIN');
}

/* ── where the portal actually lives ──────────────────────────────────────────────── */

/**
 * The sign-in address: this one deployment with ?page=portal appended.
 *
 * Computed on the server because the browser cannot see it — HtmlService
 * serves every page inside a googleusercontent sandbox frame, so
 * location.href is the frame's address, which is blank when opened on its
 * own. ScriptApp.getService().getUrl() inside a web request is the published
 * /exec URL, which is exactly the thing to link.
 *
 * There used to be a second deployment here — sign-in was
 * Session.getActiveUser(), which only works on a deployment executing as the
 * visitor, which the public site must never be. Auth.gs replaced that with
 * emailed one-time codes, so one deployment now does both jobs and there is
 * nothing to configure.
 *
 * A stored PORTAL_URL that points at script.google.com is IGNORED, not
 * honored. The old system stored the second deployment's address there, and
 * once that deployment is deleted the stored URL is Google's "unable to open
 * the file" page wearing a plausible name — the sign-in link must never
 * outlive the deployment it names. A stored URL on any other host is a
 * deliberate custom-domain override and is kept.
 */
function portalUrl_() {
  var stored = '';
  try {
    stored = String(PropertiesService.getScriptProperties()
                      .getProperty('PORTAL_URL') || '').trim();
  } catch (e) {}
  if (stored && stored.indexOf('script.google.com') < 0) return stored;

  try {
    var self = String(ScriptApp.getService().getUrl() || '');
    return self ? self.split('?')[0] + '?page=portal' : '';
  } catch (e) { return ''; }
}

/**
 * What the sign-in system is doing right now: mail health, live sessions,
 * and any leftover override.
 *
 * This deliberately does NOT print ScriptApp.getService().getUrl() as "the
 * sign-in link". From the spreadsheet menu there is no web request, so that
 * call returns the project's internal head deployment — an address nobody was
 * ever given — and printing it here once sent an administrator chasing a URL
 * that was wrong precisely because he was reading it from the one place that
 * cannot know it. The real link is derived inside each web request and is
 * always right; the menu's job is to say so, not to guess.
 */
function menuCheckPortal() {
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}

  var live = 0, tab = false;
  try {
    if (hasTab_(AUTH.TAB)) {
      tab = true;
      const now = new Date();
      live = rowsOf_(AUTH.TAB).filter(function (r) {
        return !r.RevokedAt && !(r.ExpiresAt instanceof Date && r.ExpiresAt < now);
      }).length;
    }
  } catch (e) {}

  const props_ = PropertiesService.getScriptProperties();
  const stored = String(props_.getProperty('PORTAL_URL') || '').trim();

  const out = [];
  out.push('Sign-in is by emailed one-time code. One deployment serves everything;');
  out.push('the sign-in link is that deployment\'s own URL plus ?page=portal, derived');
  out.push('fresh on every page it serves. The right address to hand out is the Web');
  out.push('app URL under Deploy > Manage deployments.');
  out.push('');

  if (quota < 0) {
    out.push('MAIL IS BROKEN, not exhausted: the script is not authorized to send.');
    out.push('Run Coaches > Fix mail and approve the permission window. Until then,');
    out.push('no code can be emailed — hand codes out with Emergency sign-in code.');
  } else if (quota < 1) {
    out.push('Mail quota is used up for today (~100/day, resets daily). Emergency');
    out.push('sign-in code still works.');
  } else {
    out.push('Mail quota left today: ' + quota + '  (each code costs one)');
  }
  out.push('Sessions tab: ' + (tab ? live + ' live session(s)' : 'not created yet — ' +
           'made automatically on the first sign-in'));

  if (stored && stored.indexOf('script.google.com') >= 0) {
    // deleting it here beats describing it here — it is dead weight from the
    // two-deployment era and nothing reads it anymore
    try { props_.deleteProperty('PORTAL_URL'); } catch (e) {}
    out.push('');
    out.push('A leftover PORTAL_URL from the old two-deployment sign-in was found');
    out.push('and removed. Old bookmarks pointing at a deleted deployment still show');
    out.push('Google\'s "unable to open the file" page — replace them with the Web');
    out.push('app URL from Manage deployments.');
  } else if (stored) {
    out.push('');
    out.push('A custom-domain override is set: ' + stored);
    out.push('setPortalUrl_("") clears it.');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Sign-in check', msg,
    SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/**
 * Prove mail end to end, and force the permission window when the grant is
 * missing. A menu item that touches MailApp is the smoothest way to trigger
 * Google's authorization dialog — no editor, no function picker: click,
 * approve, done. The proof is a real message to the owner, because a quota
 * number can be readable while sending still fails.
 */
function menuFixMail() {
  const ui = SpreadsheetApp.getUi();
  var msg;
  try {
    const me = String(Session.getEffectiveUser().getEmail() || '');
    const quota = MailApp.getRemainingDailyQuota();
    MailApp.sendEmail({
      to: me,
      subject: 'UCBAC Stats can send mail',
      body: 'This is the test message from UCBAC Stats > Coaches > Fix mail. ' +
            'Sign-in codes and notifications will deliver.\n\nQuota left today ' +
            'after this message: ' + (quota - 1) + '.',
      name: 'UCBAC Stats'
    });
    msg = 'Mail works. A test message went to ' + me + '.\n\n' +
          'Quota left today: ' + (quota - 1) + '.';
  } catch (e) {
    msg = 'Mail is still broken: ' + (e && e.message ? e.message : e) + '\n\n' +
          'If no permission window appeared: open Extensions > Apps Script, pick ' +
          '"deliverNotifications" in the toolbar dropdown, press Run, and approve ' +
          'the permissions it asks for.';
  }
  ui.alert('Fix mail', msg, ui.ButtonSet.OK);
  return msg;
}

/** Manual override for a custom domain; setPortalUrl("") clears it. */
function setPortalUrl_(url) {
  url = String(url || '').trim();
  const props_ = PropertiesService.getScriptProperties();
  if (!url) {
    props_.deleteProperty('PORTAL_URL');
    try { CacheService.getScriptCache().remove('boot'); } catch (e) {}
    return 'Cleared. The sign-in link now derives from this deployment.';
  }
  if (url.indexOf('https://') !== 0)
    throw new Error('That is not a URL. Paste the whole https:// address.');
  if (url.indexOf('googleusercontent.com') >= 0 || url.indexOf('userCodeAppPanel') >= 0)
    throw new Error('That is the sandbox frame address the browser shows, not a page.');
  if (url.indexOf('script.google.com') >= 0)
    throw new Error('A script.google.com address never needs to be stored — the sign-in ' +
                    'link derives from the live deployment by itself, and a stored one ' +
                    'would keep pointing at it after it was deleted. This override is ' +
                    'only for a custom domain.');
  if (url.indexOf('page=portal') < 0)
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'page=portal';
  props_.setProperty('PORTAL_URL', url);
  try { CacheService.getScriptCache().remove('boot'); } catch (e) {}
  return 'Sign-in link overridden to ' + url;
}

/**
 * Hand out a sign-in code from the sheet, no email involved.
 *
 * For the day mail is exhausted or broken, and for the coach whose school
 * spam filter eats every code. Type the person's address, read them the six
 * digits, they type it into the sign-in form within ten minutes.
 */
function menuMintLoginCode() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Emergency sign-in code',
    'Email address the person will sign in AS (they enter this address plus ' +
    'the code on the portal sign-in form):',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return '';
  var msg;
  try {
    const r = adminMintLoginCode_(res.getResponseText());
    msg = 'Code for ' + r.email + ':\n\n        ' + r.code +
          '\n\nWorks for ' + r.minutes + ' minutes, once. On the portal they enter ' +
          'that email, press "Email me a code", ignore the mail step if it errors, ' +
          'and type this code in.';
  } catch (e) { msg = 'No code minted: ' + e.message; }
  ui.alert('Emergency sign-in code', msg, ui.ButtonSet.OK);
  return msg;
}

/**
 * Make some *other* account an administrator, by typing the address.
 *
 * setupAdmin() promotes whoever is running the script, which is not the same
 * person as whoever browses the site: the sheet and the script are owned by one
 * Google account, and the conference is run from another. Promoting the owner
 * again does nothing useful. This asks which address to promote.
 */
function menuAddAdmin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Add an administrator',
    'Google account to promote (the address that signs in to the portal):',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return '';
  const email = String(res.getResponseText() || '').trim();
  if (!email) return '';
  var msg;
  try { msg = addCoach_(email, '', 'ADMIN'); }
  catch (e) { msg = 'Not added: ' + e.message; }
  ui.alert('Add an administrator', msg, ui.ButtonSet.OK);
  return msg;
}

/**
 * Add or update a coach.
 *   addCoach('contact@example.invalid', 'TEAM-001', 'COACH')
 *   addCoach('contact@example.invalid', '', 'ADMIN')       // admins need no team
 *
 * Re-running with the same email updates the existing row rather than adding a
 * duplicate — two rows for one person would make access depend on row order.
 */
function addCoach_(email, teamId, role) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account change is in progress. Try again.');
  try {
    __tableCache={}; authRecheckBoundSession_();
    return addCoachLocked_(email, teamId, role);
  } finally {lock.releaseLock();}
}
function addCoachLocked_(email, teamId, role) {
  email = String(email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') < 0) throw new Error('A valid email is required.');
  role = String(role || 'COACH').toUpperCase();
  if (['ADMIN', 'COACH'].indexOf(role) < 0) throw new Error('Role must be ADMIN or COACH.');
  teamId = String(teamId || '').trim();

  if (role === 'COACH' && !teamId)
    throw new Error('A coach needs a TeamID. Run listTeams() to see them.');
  if (teamId) {
    const known = rowsOf_(CONFIG.TABS.TEAMS).some(function (t) {
      return String(t.TeamID).trim() === teamId;
    });
    if (!known) throw new Error('Unknown TeamID "' + teamId + '". Run listTeams().');
  }

  ensureCoachesTab_();
  const sh = getTab_('Coaches');
  const data = sh.getDataRange().getValues();
  const head = data[0].map(String);
  const cEmail = head.indexOf('Email'), cName = head.indexOf('DisplayName'),
        cTeam = head.indexOf('TeamID'), cRole = head.indexOf('Role'),
        cActive = head.indexOf('Active'), cAdded = head.indexOf('AddedAt');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][cEmail] || '').toLowerCase().trim() !== email) continue;
    sh.getRange(r + 1, cTeam + 1).setValue(teamId);
    sh.getRange(r + 1, cRole + 1).setValue(role);
    sh.getRange(r + 1, cActive + 1).setValue(true);
    return 'Updated ' + email + ' -> ' + role + (teamId ? ' / ' + teamId : '');
  }

  sh.appendRow([email, email.split('@')[0], teamId, role, true, new Date()]);
  __tableCache = {};
  return 'Added ' + email + ' as ' + role + (teamId ? ' for ' + teamId : '');
}

function removeCoach_(email) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account change is in progress. Try again.');
  try {
    __tableCache={}; authRecheckBoundSession_();
    return removeCoachLocked_(email);
  } finally {lock.releaseLock();}
}
function removeCoachLocked_(email) {
  email = String(email || '').toLowerCase().trim();
  const sh = getTab_('Coaches');
  const data = sh.getDataRange().getValues();
  const cEmail = data[0].map(String).indexOf('Email');
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][cEmail] || '').toLowerCase().trim() === email) {
      sh.deleteRow(r + 1);
      __tableCache = {};
      return 'Removed ' + email;
    }
  }
  return email + ' was not in the Coaches tab.';
}

/** Print every team and its ID, so addCoach() calls can be written correctly. */
function listTeams() {
  const lines = rowsOf_(CONFIG.TABS.TEAMS).map(function (t) {
    return pad_(String(t.TeamID), 12) + String(t.DisplayName || '');
  });
  const msg = 'TEAMS\n' + lines.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

function listCoaches() {
  ensureCoachesTab_();
  const rows = rowsOf_('Coaches');
  if (!rows.length) {
    const m = 'No coaches yet. Run setupAdmin() to add yourself.';
    Logger.log(m);
    try { SpreadsheetApp.getUi().alert(m); } catch (e) {}
    return m;
  }
  const teams = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return String(t.TeamID); });
  const lines = rows.map(function (c) {
    const t = teams[String(c.TeamID || '').trim()];
    return pad_(String(c.Role || ''), 7) + pad_(String(c.Email || ''), 34) +
           (t ? String(t.DisplayName) : (c.TeamID ? String(c.TeamID) : 'all teams')) +
           (String(c.Active).toUpperCase() === 'FALSE' ? '   [inactive]' : '');
  });
  const msg = 'COACHES — ' + rows.length + '\n\n' + lines.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

/** Who does the system think you are? Useful when the portal says PUBLIC. */
function whoAmIReally() {
  const active = String(Session.getActiveUser().getEmail() || '(blank)');
  const effective = String(Session.getEffectiveUser().getEmail() || '(blank)');
  var resolved;
  try { resolved = JSON.stringify(whoami_()); } catch (e) { resolved = 'error: ' + e.message; }
  const msg = 'Session.getActiveUser    ' + active +
            '\nSession.getEffectiveUser ' + effective +
            '\nwhoami()                 ' + resolved +
            '\n\nIf the portal shows PUBLIC, the email above is not in the Coaches tab,' +
            '\nor the portal deployment is not set to "Execute as: User accessing the web app".';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

/**
 * The 2026 head coaches, as provided by the administrator. One menu run sets
 * the HeadCoach column on Teams — which is also what registration checks a
 * player's "head coach's last name" answer against, so keeping it current is
 * what keeps sign-ups working.
 */
const HEAD_COACHES_2026 = {
  'Aberdeen': 'Kaleb Myers',        'Bel Air': 'Eric Siegel',
  'Bohemia Manor': 'Vince Ricci',   'C. Milton Wright': 'Bryan Hansrote',
  'Edgewood': 'Keneth Brinkman',    'Elkton': 'CJ Ponzo',
  // keyed by the Teams tab's DisplayName - "Harford Tech", not the school's
  // long name, or the menu reports it missing and never sets it
  'Fallston': 'Derrick Krumholtz',  'Harford Tech': 'Brad Dreyer',
  'Havre de Grace': 'Brian Eberhardt', 'Joppatowne': 'Chris Johnson',
  'North East': 'Wes Laguerre',     'North Harford': 'Justin Martinek',
  'Patterson Mill': 'David Huryk',  'Perryville': 'Dan Basara',
  'Rising Sun': 'Wes Johnson'
};

function menuUpdateHeadCoaches() {
  const sh = getTab_(CONFIG.TABS.TEAMS);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const cName = head.indexOf('DisplayName'), cCoach = head.indexOf('HeadCoach');
  if (cName < 0 || cCoach < 0) throw new Error('Teams needs DisplayName and HeadCoach columns.');

  const out = [], missing = [];
  var changed = 0, same = 0;
  const seen = {};
  for (var r = 1; r < values.length; r++) {
    const name = String(values[r][cName] || '').trim();
    const want = HEAD_COACHES_2026[name];
    if (!want) continue;
    seen[name] = true;
    const have = String(values[r][cCoach] || '').trim();
    if (have === want) { same++; continue; }
    sh.getRange(r + 1, cCoach + 1).setValue(want);
    out.push('  ' + name + ': ' + (have || '(blank)') + ' -> ' + want);
    changed++;
  }
  Object.keys(HEAD_COACHES_2026).forEach(function (n) { if (!seen[n]) missing.push(n); });

  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot']);

  const msg = 'HEAD COACHES\n\nUpdated: ' + changed + '   already current: ' + same +
    (out.length ? '\n\n' + out.join('\n') : '') +
    (missing.length ? '\n\nNot found on the Teams tab: ' + missing.join(', ') : '') +
    '\n\nPlayers registering now verify against these names.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Head coaches', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}