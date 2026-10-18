/**
 * UCBAC Stats — CoachInvites.gs
 *
 * Invite the conference's coaches to sign in.
 *
 * A coach whose email is on the Coaches tab already has an account in every
 * way that matters: the portal's one-time code goes to that address, and the
 * roster editor, stat entry and approvals open to him the moment he redeems
 * it. Nobody had told the coaches. This mails each one a short note with the
 * link and what is behind it.
 *
 * Recipients are read from the CoachInvites tab (Team, Name, Email), never
 * from code — addresses live in the workbook, where the administrator can see
 * and edit the list. A dry run writes a verdict beside every row and sends
 * nothing; SEND mails the rows the dry run said it would, once: a row marked
 * SENT is never mailed again by a later run.
 *
 * A coach on the list who is not yet on the Coaches tab is seated there first,
 * on SEND, so the sign-in the message promises actually works. "(HC)" after a
 * name makes him the head coach; anyone else is an assistant. A coach whose
 * email already holds an ACTIVE account is skipped — he was not asked for.
 */
const COACHINVITE = {
  TAB: 'CoachInvites',
  COLS: ['Team', 'Name', 'Email', 'Result', 'Note'],
  REPLY_TO: 'contact@example.invalid',
  SIGNOFF: 'Javin Taylor\nUCBACstats.com'
};

function ciEnsureTab_() {
  if (hasTab_(COACHINVITE.TAB)) return db_().getSheetByName(COACHINVITE.TAB);
  const sh = db_().insertSheet(COACHINVITE.TAB);
  sh.getRange(1, 1, 1, COACHINVITE.COLS.length).setValues([COACHINVITE.COLS])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#1F3B54');
  sh.setFrozenRows(1);
  __tabMap = null;
  return sh;
}

/** "Derrick Krumholtz (HC)" -> { name: 'Derrick Krumholtz', head: true, last: 'Krumholtz' } */
function ciName_(raw) {
  const s = String(raw || '').trim();
  const head = /\(\s*hc\s*\)/i.test(s);
  const name = s.replace(/\(\s*hc\s*\)/ig, '').replace(/\s+/g, ' ').trim();
  const parts = name.split(' ');
  return { name: name, head: head, last: parts.length ? parts[parts.length - 1] : '' };
}

/** ACTIVE, PENDING (or another non-active status), or '' for no account. */
function ciAccountStatus_(email) {
  if (!hasTab_('Accounts')) return '';
  const want = String(email || '').toLowerCase().trim();
  const rows = acctRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Email || '').toLowerCase().trim() !== want) continue;
    const st = String(rows[i].Status || '').toUpperCase().trim();
    return st || 'PENDING';
  }
  return '';
}

/** The live Coaches row carrying this email, or null. */
function ciCoachRow_(email) {
  if (!hasTab_('Coaches')) return null;
  const want = String(email || '').toLowerCase().trim();
  const rows = rowsOf_('Coaches');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Email || '').toLowerCase().trim() !== want) continue;
    if (String(rows[i].Active).toUpperCase() === 'FALSE') continue;
    return rows[i];
  }
  return null;
}

/**
 * The sign-in link: the published /exec address plus ?page=portal.
 *
 * Never ScriptApp.getService().getUrl(). From the spreadsheet menu that names
 * the project's internal head deployment - an address nobody was ever given,
 * and the first dry run of this mailer printed it as the link. The address to
 * hand out is the one a real page load remembered (doGet stores it on every
 * visit), and failing that the newest one this site has already mailed inside
 * an account notification. With neither on record the mailer refuses rather
 * than guess: nineteen coaches with a dead link is worse than a day's delay.
 */
function ciLink_() {
  var base = '';
  try {
    const key = (typeof CORRMAIL !== 'undefined' && CORRMAIL.BASE_PROP) || 'EXEC_URL';
    base = String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (e) { base = ''; }
  if (!base && typeof corrBaseFromSentMail_ === 'function') {
    try { base = String(corrBaseFromSentMail_() || '').trim(); } catch (e) { base = ''; }
  }
  if (!base || base.indexOf('script.google.com/macros/s/') < 0 || base.indexOf('/exec') < 0) return '';
  return base.split('?')[0] + '?page=portal';
}

/**
 * The message. Short: what it is, three steps in, five things behind the
 * door. The coach-page line goes only to a head coach, whose page it is.
 */
function ciMessage_(who, teamName, link) {
  const hello = 'Coach ' + (who.last || '');
  const steps = [
    'Open ' + link,
    'Enter this email address',
    'Type the six-digit code it sends you'
  ];
  const can = [
    'Enter box scores and stats after each game, or upload the sheet or PDF you already keep',
    'Manage your roster: numbers, positions, heights and weights, captains',
    'Approve or fix stats your players enter themselves',
    'Keep your players eligible for the All-Conference projections, which follow the positions on your roster'
  ];
  if (who.head) can.splice(3, 0, 'Fill in your own coach page');

  const subject = 'Your UCBAC Stats coach sign-in';
  const intro = 'UCBACstats.com has a coach sign-in for ' + teamName + ', and yours is ready. ' +
                'No password, no form:';
  const tail = 'If the code does not arrive, check your spam folder. Questions: reply to this email.';

  const body = hello + ',\n\n' + intro + '\n\n' +
    steps.map(function (s, i) { return '  ' + (i + 1) + '. ' + s; }).join('\n') + '\n\n' +
    'Once you are in, you can:\n' +
    can.map(function (s) { return '  - ' + s; }).join('\n') + '\n\n' +
    tail + '\n\n' + COACHINVITE.SIGNOFF + '\n';

  const esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  const htmlBody = '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:560px">' +
    '<p>' + esc(hello) + ',</p>' +
    '<p>' + esc(intro) + '</p>' +
    '<ol>' +
      '<li>Open <a href="' + esc(link) + '">' + esc(link) + '</a></li>' +
      '<li>' + esc(steps[1]) + '</li>' +
      '<li>' + esc(steps[2]) + '</li>' +
    '</ol>' +
    '<p>Once you are in, you can:</p>' +
    '<ul>' + can.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
    '<p>' + esc(tail) + '</p>' +
    '<p>' + COACHINVITE.SIGNOFF.split('\n').map(esc).join('<br>') + '</p>' +
    '</div>';
  return { subject: subject, body: body, htmlBody: htmlBody };
}

/**
 * The run. `send` false writes a verdict beside every row and mails nobody;
 * true mails the rows a dry run would, seating on the Coaches tab first
 * whoever is not there yet. Returns the report as text.
 */
function ciRun_(send) {
  const out = [];
  out.push(send ? 'SENDING coach invitations' : 'DRY RUN — nothing is sent, nothing is written but the verdicts');
  out.push('');

  const sh = ciEnsureTab_();
  const data = sh.getDataRange().getValues();
  const head = data[0].map(function (h) { return String(h || '').trim(); });
  const col = {};
  head.forEach(function (h, i) { if (h) col[h] = i; });
  ['Result', 'Note'].forEach(function (h) {
    if (col[h] === undefined) {
      col[h] = head.length; head.push(h);
      sh.getRange(1, head.length).setValue(h).setFontWeight('bold');
    }
  });
  if (col.Team === undefined || col.Name === undefined || col.Email === undefined) {
    const m0 = 'The ' + COACHINVITE.TAB + ' tab needs Team, Name and Email columns.';
    out.push(m0);
    return ciReport_(out);
  }

  const link = ciLink_();
  if (!link) {
    out.push('No published address on record yet, so there is no link to send.');
    out.push('Open the site once in a browser (any page), then run this again.');
    return ciReport_(out);
  }

  const plan = [], verdicts = [];   // verdicts: [sheetRow, Result, Note]
  const seen = {};
  for (var r = 1; r < data.length; r++) {
    const row = data[r];
    const teamRaw = String(row[col.Team] || '').trim();
    const nameRaw = String(row[col.Name] || '').trim();
    const emailRaw = String(row[col.Email] || '').trim();
    const already = String(row[col.Result] || '').trim().toUpperCase();
    if (!teamRaw && !nameRaw && !emailRaw) continue;
    const sheetRow = r + 1;
    const verdict = function (res, note) { verdicts.push([sheetRow, res, note || '']); };

    const email = (typeof authMailable_ === 'function') ? authMailable_(emailRaw)
                : (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw.toLowerCase()) ? emailRaw.toLowerCase() : '');
    /* A row already mailed keeps its verdict, and its address stays claimed:
       a second row carrying the same address was skipped as a duplicate the
       first time only because this one came first, and would go out on the
       next run if this one no longer spoke for the address. */
    if (already === 'SENT') {
      if (email && !seen[email]) seen[email] = sheetRow;
      verdict('SENT', String(row[col.Note] || ''));
      continue;
    }
    if (!email) { verdict('SKIP', '"' + emailRaw + '" is not an email address'); continue; }
    if (seen[email]) { verdict('SKIP', 'same address as row ' + seen[email]); continue; }
    seen[email] = sheetRow;

    const teamId = siTeamByName_(teamRaw);
    if (!teamId) { verdict('SKIP', 'no school called "' + teamRaw + '"'); continue; }
    const teamName = teamNameOf_(teamId) || teamRaw;

    const st = ciAccountStatus_(email);
    if (st === 'ACTIVE') { verdict('SKIP', 'already has an account'); continue; }

    const who = ciName_(nameRaw);
    if (!who.last) { verdict('SKIP', 'no name'); continue; }

    const onTab = ciCoachRow_(email);
    var note = '';
    if (onTab && String(onTab.TeamID || '').trim() !== teamId) {
      verdict('SKIP', 'on the Coaches tab for ' + (teamNameOf_(String(onTab.TeamID).trim()) || onTab.TeamID) +
                      ', not ' + teamName + ' — fix the Coaches tab first');
      continue;
    }
    const notes = [];
    if (!onTab) notes.push((send ? 'seated' : 'will be seated') + ' on the Coaches tab as ' +
                           (who.head ? 'head coach' : 'assistant coach') + ' for ' + teamName);
    if (st) notes.push('has a ' + st.toLowerCase() + ' account request; the sign-in works regardless');
    note = notes.join('; ');

    plan.push({ sheetRow: sheetRow, email: email, who: who, teamId: teamId, teamName: teamName,
                seat: !onTab, note: note, verdict: verdict });
  }

  if (send && plan.length) {
    var quota = -1;
    try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = -1; }
    if (quota < 0) {
      out.push('The site cannot send mail right now — the script needs to be re-authorized: ' +
               'open the Apps Script editor, run any function once, approve the permissions.');
      return ciReport_(out);
    }
    if (quota < plan.length) {
      out.push('Only ' + quota + ' message' + (quota === 1 ? '' : 's') + ' left in today\'s mail quota and ' +
               plan.length + ' to send. Nothing sent — try again tomorrow, or shorten the list.');
      return ciReport_(out);
    }
  }

  var sent = 0, seated = 0;
  plan.forEach(function (p) {
    if (!send) { p.verdict('WOULD SEND', p.note); return; }
    if (p.seat) {
      appendRows_('Coaches', [{
        Email: p.email, DisplayName: p.who.name, TeamID: p.teamId, Role: 'COACH',
        Active: true, AddedAt: new Date(), CoachType: p.who.head ? 'HEAD' : 'ASSISTANT'
      }]);
      delete __tableCache['Coaches'];
      seated++;
    }
    const m = ciMessage_(p.who, p.teamName, link);
    MailApp.sendEmail({ to: p.email, subject: m.subject, body: m.body, htmlBody: m.htmlBody,
                        name: 'UCBAC Stats', replyTo: COACHINVITE.REPLY_TO });
    sent++;
    p.verdict('SENT', (p.note ? p.note + '; ' : '') + 'sent ' +
              Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'MMM d h:mm a'));
  });

  // verdicts beside every row
  verdicts.forEach(function (v) {
    sh.getRange(v[0], col.Result + 1, 1, 2).setValues([[v[1], v[2]]]);
  });

  const skipped = verdicts.filter(function (v) { return v[1] === 'SKIP'; });
  out.push((send ? 'Sent: ' + sent : 'Would send: ' + plan.length) +
           '   skipped: ' + skipped.length +
           (send ? '   seated on the Coaches tab: ' + seated : '') +
           '   already sent earlier: ' + verdicts.filter(function (v) { return v[1] === 'SENT' && !send; }).length);
  out.push('Link in the message: ' + link);
  out.push('');
  plan.forEach(function (p) {
    out.push('  ' + (send ? 'SENT  ' : 'WOULD ') + p.teamName + ': ' + p.who.name +
             (p.who.head ? ' (HC)' : '') + ' <' + p.email + '>' + (p.note ? '  — ' + p.note : ''));
  });
  if (skipped.length) {
    out.push('');
    out.push('Skipped:');
    skipped.forEach(function (v) { out.push('  row ' + v[0] + ': ' + v[2]); });
  }
  out.push('');
  out.push(send ? 'Every row\'s outcome is beside it on the ' + COACHINVITE.TAB + ' tab. A row marked SENT is never mailed again.'
                : 'Nothing was sent. Run Coach invites (SEND) to mail these.');
  return ciReport_(out);
}

function ciReport_(out) {
  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Coach invites', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function menuCoachInvitesTab()  { const sh = ciEnsureTab_(); db_().setActiveSheet(sh); }
function menuCoachInvitesDry()  { return ciRun_(false); }
function menuCoachInvitesSend() { return ciRun_(true); }
