/** UCBAC Stats — Policies.gs
 * Review the policy text before publishing this version. Changing any document
 * changes the bundle fingerprint and requires a new acknowledgment. Keep old
 * PolicyDocuments and PolicyAcknowledgments rows for the audit history.
 */
const POLICY = {
  VERSION: '2026-10-01.1',
  RENEWAL_MONTHS: 3,
  OPERATOR: 'Javin Taylor',
  LOCATION: 'Maryland, United States',
  EMAIL: 'contact@example.invalid',
  PROFILE_TAB: 'AccountCompliance',
  PROFILE_COLS: ['Email', 'BirthDate', 'RecordedAt', 'Source'],
  ACK_TAB: 'PolicyAcknowledgments',
  ACK_COLS: ['AcknowledgmentID', 'Email', 'AccountID', 'Role', 'AcknowledgedAt',
    'BundleID', 'TermsVersion', 'PrivacyVersion', 'DataVersion', 'TermsAgreed',
    'PrivacyAcknowledged', 'DataAcknowledged', 'Source', 'BirthDateDigest',
    'TermsDocumentID', 'PrivacyDocumentID', 'DataDocumentID',
    'TermsReviewMethod', 'PrivacyReviewMethod', 'DataReviewMethod'],
  DOC_TAB: 'PolicyDocuments',
  DOC_COLS: ['DocumentID', 'Kind', 'Version', 'Title', 'Text', 'SHA256', 'RecordedAt']
};

function policyDocuments_() {
  const contact = POLICY.EMAIL;
  const identity = 'UCBACstats.com is operated by ' + POLICY.OPERATOR +
    ', an independent media operator in ' + POLICY.LOCATION +
    '. It is not affiliated with, endorsed by, or operated by Cecil County Public Schools, ' +
    'Harford County Public Schools, or the Upper Chesapeake Bay Athletic Conference (UCBAC).';
  const docs = [
    {kind:'terms', title:'Terms of Use', sections:[
      ['About this site', identity + ' These terms apply to the public site and its account tools. Contact: ' + contact + '.'],
      ['Accounts and eligibility', 'Account registration is available to people age 13 or older, subject to the role and school requirements shown during registration. Give accurate information, including your date of birth, use your own email address, and keep sign-in codes and sessions private. If you are under 18, review these terms and policies with a parent or guardian and obtain their permission before creating or using an account. A younger user’s statement about parental permission is not a separately verified parental-consent process. Fan accounts are available without school or team membership and do not create a public player or coach profile. Some account tools depend on role, age, approval status, and service availability. Blitz and AI-generated daily summaries require an active signed-in account, a recorded birth date indicating age 18 or older, and current policy acknowledgments. Birth dates are self-reported; this is not independent identity or age verification.'],
      ['Roles and responsible use', 'Use only accounts and profiles you are authorized to manage. Do not impersonate a player or coach, submit false results, harass others, upload unlawful material, bypass access controls, or interfere with the site. Coach and administrator access is reviewed or granted by the operator. We may restrict or suspend access to investigate misuse or protect the service.'],
      ['Contributions and public information', 'Only submit statistics, profile details, photographs, links, or video that you are authorized to provide and publish. You retain rights you hold in your contributions and grant the operator permission to host, display, format, and distribute them as needed to run the site and its sharing features. Public profiles and share cards can be copied, indexed, or reposted by others. See the Data Policy for corrections and removal requests.'],
      ['Accuracy and AI assistance', 'Statistics, projections, rankings, historical records, and automated answers may be incomplete or incorrect. Projections are the site’s own analysis and are not official conference awards or school decisions. Blitz uses Google Gemini to generate answers and some share-card text. Daily Players and Teams summaries also use Gemini to select and organize approved football information for eligible account holders. Check AI output against the underlying records before relying on or sharing it. Do not submit private, sensitive, or confidential information in questions.'],
      ['Availability and third parties', 'We may correct records, change features, or interrupt service for maintenance. Google and other linked services have their own terms and privacy practices. The site is provided as available, without a promise of uninterrupted service or error-free records. These terms do not waive rights or responsibilities that applicable law does not allow to be waived.'],
      ['Changes and questions', 'The version displayed with these terms identifies the text you are accepting. Material account-policy changes will be presented for acknowledgment before continued use of account tools. Public pages remain available without an account. Contact ' + contact + ' with questions or account concerns.']
    ]},
    {kind:'privacy', title:'Privacy Policy', sections:[
      ['Operator and scope', identity + ' This policy describes the site’s handling of personal information. Privacy and deletion requests: ' + contact + '.'],
      ['Information collected', 'We collect account email, name, role, school or team, date of birth, registration and approval information, and information you submit to your profile or account tools. We also process sign-in code hashes, session-token hashes, session timestamps, account actions, policy acknowledgments, football records, submitted media, AI questions, generated share-card text, and share activity. Site analytics can include a browser identifier, page or section visited, referring page, screen width, and timestamps. Google hosting may separately receive technical connection data under its own policies.'],
      ['How information is used', 'We use account details to sign you in, associate you with the correct profile and school, review roles, support accounts, and prevent misuse. Birth dates support account eligibility, age-dependent features, and profile matching; a player’s age may appear publicly. We keep policy versions, acknowledgment timestamps, and related account records to document the notices and agreements presented to an account. Site activity and question logs help operate, troubleshoot, and improve the service.'],
      ['What is public and what is private', 'Public football pages may include names, school or team, season, graduating class, jersey, position, age, measurables, statistics, awards or projections, and links or media submitted for publication. Account email addresses, full birth dates, sign-in credentials, and policy acknowledgment records are not intended for public display. Fan account names and account details are private; creating a fan account does not publish a player or coach profile. The operator and authorized people who administer accounts may access private details as needed for their responsibilities. Public pages and downloaded share cards can remain in search engines, screenshots, or other people’s copies.'],
      ['Google and AI processing', 'The site uses Google Apps Script, Sheets, Drive, and email services to run account and publishing functions. Blitz sends questions, relevant conversation context, selected football data, text used to generate AI share cards, and uploaded statistics files selected for automatic extraction to Google’s Gemini API through a project with active Cloud Billing. Google’s paid-service terms state that API prompts and responses are not used to improve its products; Google may retain them temporarily for abuse prevention, security, and legal obligations. Daily summaries send selected current-season statistics and verified historical football context to Gemini on a shared publication schedule. They are not generated from private fan account information or individualized browsing activity. The site’s AI data tools exclude private account, birth-date, sign-in, and policy-acknowledgment records. Do not place personal or confidential information in a question yourself. Google’s terms and privacy practices also apply to its processing.'],
      ['Storage, retention, and security', 'The site uses browser storage for sign-in sessions and preferences and Google services for server records. Account and operational records are kept while needed to provide the service, maintain historical sports records, investigate misuse, handle requests, or document agreements. AI question and share-card logs are configured for a 90-day pruning period; deletion depends on maintenance jobs running. Copies in backups and notification email can remain until those copies are removed. Policy text and acknowledgment history are retained for accountability, subject to applicable requirements and deletion review. Access controls reduce risk, but no system can guarantee absolute security.'],
      ['Your requests and younger users', 'Email ' + contact + ' to ask about access, correction, account closure, or removal of personal information. We may need to verify your identity or authority before acting. A parent or guardian may contact us about a child’s information. Accounts are not offered to children under 13; if you believe we have collected account information from a child under 13, contact us so we can investigate and take appropriate action. A removal request for an account does not automatically remove every historical game statistic or copy posted by others; we will explain the action taken on your request.'],
      ['Policy updates', 'We identify this policy by version and ask account holders to acknowledge updated policies when required. Acknowledgment records receipt of this notice; it is not blanket consent to every possible use of personal information.']
    ]},
    {kind:'data', title:'Data and Publication Policy', sections:[
      ['Independent football coverage', identity + ' The site maintains football scores, statistics, profiles, and historical coverage. Its records and projections should not be represented as official school or conference determinations.'],
      ['Sources and corrections', 'Records may come from available sports results, historical research, coaches, players, and user submissions. Some entries are incomplete or awaiting review. Submit corrections through the account tools when available or email ' + contact + ' with the player, team, season or game, the disputed value, and supporting information. Authorized reviewers can approve, reject, or correct submissions; an account’s verified mark indicates an account relationship, not a guarantee that every statistic is accurate.'],
      ['Birth dates and account records', 'A valid birth date is required for account creation and the account update accompanying these policies. Use your own correct birth date. Full birth dates remain private; player age may be displayed. Birth dates are used for account eligibility, age-dependent access, and matching records. Corrections to a birth date already on file require contacting ' + contact + '. New or revised policies require an affirmative acknowledgment, and the site records the account, server timestamp, policy versions, and text associated with that acknowledgment.'],
      ['Publication and sharing', 'Profile details, football statistics, and submitted material intended for publication may be displayed publicly. Share tools create links or downloaded images that can circulate outside the site. Submit only material you have permission to share, including appropriate permission for images or videos of others. Do not submit medical records, private contact details, or other sensitive information in public fields, uploads, or AI questions.'],
      ['AI-generated content', 'Blitz and daily Players and Teams summaries are optional account tools powered by Gemini, available only to eligible signed-in adults. Daily summaries are shared editions that may include current-season performance and verified historical context; they may remain unchanged when generation fails or sufficient approved data is unavailable. Automatic extraction of uploaded statistics files also uses Gemini; review the extracted results for accuracy. Its answers and card text are generated and may be inaccurate. The site supplies relevant football data and limits which database fields the assistant can read. Questions and generated share-card text are logged for review and improvement; conversation context and share-card requests are also processed by Google. A generated answer is not an official result, award, scouting judgment, or school statement.'],
      ['Removal and recordkeeping', 'Request a correction, account closure, or personal-profile removal at ' + contact + '. Explain what you want changed and your relationship to the person or material. We may verify authority and retain records needed to document the request, preserve historical sports reporting, resolve disputes, or meet legal obligations. We cannot recall copies that other people have downloaded or independently published.'],
      ['Acknowledgment', 'Acknowledging this policy confirms that you have received this explanation of collection, publication, corrections, and sharing. It does not transfer ownership of your personal information or replace any permission that must be obtained separately.']
    ]}
  ];
  return docs.map(function (d) {
    d.version = POLICY.VERSION;
    d.text = d.title + '\nVersion ' + d.version + '\n\n' + d.sections.map(function (s) {
      return s[0] + '\n' + s[1];
    }).join('\n\n');
    d.sha256 = authHash_(d.text);
    d.documentId = d.kind + ':' + d.version + ':' + d.sha256;
    return d;
  });
}

function apiPolicies_() {
  const documents = policyDocuments_();
  return {bundleId: authHash_(documents.map(function (d) { return d.documentId; }).join('|')),
    documents: documents, contact: POLICY.EMAIL};
}

/** Public, server-rendered documents: readable without signing in or JavaScript. */
function policyPage_(kind) {
  const documents = policyDocuments_();
  const doc = documents.filter(function (d) { return d.kind === String(kind || ''); })[0] || documents[0];
  const esc = function (s) { return String(s || '').replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); };
  const base = String(ScriptApp.getService().getUrl() || '').split('?')[0];
  const canonical = base + '?page=policy&doc=' + doc.kind;
  return HtmlService.createHtmlOutput('<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8"><meta name="description" content="' + esc(doc.title + ' for UCBAC Stats, independent football coverage by Javin Taylor.') + '">' +
    '<link rel="canonical" href="' + esc(canonical) + '">' +
    '<style>body{font:17px/1.65 system-ui,sans-serif;color:#182333;background:#f7f9fc;margin:0}main{max-width:760px;margin:auto;padding:32px 22px 60px}h1{line-height:1.15}h2{font-size:21px;margin:30px 0 8px}a{color:#1556bb}nav{display:flex;gap:18px;flex-wrap:wrap;font-size:15px}p{margin:8px 0}a:focus-visible{outline:3px solid #397ddd;outline-offset:4px}</style></head><body><main>' +
    '<nav aria-label="Site and policies"><a href="' + esc(base) + '" target="_top">UCBAC Stats</a>' +
    documents.map(function (d) { return '<a target="_top" href="' + esc(base + '?page=policy&doc=' + d.kind) + '"' +
      (d.kind === doc.kind ? ' aria-current="page"' : '') + '>' + esc(d.title) + '</a>'; }).join('') + '</nav>' +
    '<article><h1>' + esc(doc.title) + '</h1><p>Version ' + esc(doc.version) + '</p>' +
    doc.sections.map(function (s) { return '<section><h2>' + esc(s[0]) + '</h2><p>' + esc(s[1]) + '</p></section>'; }).join('') +
    '</article></main></body></html>').setTitle(doc.title + ' | UCBAC Stats')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Reject impossible/future dates; compute birthdays in the site's timezone. */
function policyBirthDate_(v) {
  const value = String(v || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error('Enter your date of birth.');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd');
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 ||
      d.getUTCDate() !== +m[3] || value > today || +m[1] < +today.slice(0, 4) - 120)
    throw new Error('Enter a valid date of birth.');
  const age = +today.slice(0, 4) - +m[1] - (today.slice(5) < value.slice(5) ? 1 : 0);
  return {value: value, age: age};
}

function policyRows_(tab) { return hasTab_(tab) ? rowsOf_(tab) : []; }
function policyProfile_(email) {
  return policyRows_(POLICY.PROFILE_TAB).filter(function (r) {
    return String(r.Email || '').trim().toLowerCase() === email;
  })[0] || null;
}
function policyDateText_(v) {
  return v instanceof Date
    ? Utilities.formatDate(v, Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd')
    : String(v || '').trim();
}
function policyExistingDob_(email) {
  const profile = policyProfile_(email);
  if (profile && profile.BirthDate) return policyDateText_(profile.BirthDate);
  const row = acctFind_(email);
  const note = row && acctUnpackNote_(row.Note);
  // acctPackNote_ writes fields at the top level; tolerate older nested notes.
  const recordedDob = note && (note.dob || (note.detail && note.detail.dob));
  if (recordedDob) return policyDateText_(recordedDob);
  if (row && row.PlayerID) {
    const player = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (p) {
      return String(p.PlayerID) === String(row.PlayerID);
    })[0];
    if (player && player.BirthDate) return policyDateText_(player.BirthDate);
  }
  return '';
}
function policyHasAccount_(me) {
  return !!(me.email && (acctFind_(me.email) || me.role === 'COACH' || me.role === 'ADMIN'));
}
/** Keep the history; the most recent complete, server-dated acknowledgment wins. */
function policyLatestAck_(email) {
  const now = Date.now();
  return policyRows_(POLICY.ACK_TAB).filter(function (r) {
    const at = r.AcknowledgedAt ? new Date(r.AcknowledgedAt).getTime() : NaN;
    return String(r.Email || '').trim().toLowerCase() === email &&
      !!String(r.BundleID || '') && isFinite(at) && at <= now &&
      String(r.TermsAgreed).toLowerCase() === 'true' &&
      String(r.PrivacyAcknowledged).toLowerCase() === 'true' &&
      String(r.DataAcknowledged).toLowerCase() === 'true' &&
      ['TermsReviewMethod','PrivacyReviewMethod','DataReviewMethod'].every(function(k){
        return ['opened','scrolled'].indexOf(String(r[k]))>=0;
      });
  }).reduce(function (latest, r) {
    return !latest || new Date(r.AcknowledgedAt).getTime() >= new Date(latest.AcknowledgedAt).getTime()
      ? r : latest;
  }, null);
}
/** Three calendar months, clamped at month end (November 30 -> February 28). */
function policyRenewalAt_(at) {
  const due = new Date(at), day = due.getUTCDate();
  due.setUTCDate(1);
  due.setUTCMonth(due.getUTCMonth() + POLICY.RENEWAL_MONTHS);
  const last = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
  due.setUTCDate(Math.min(day, last));
  return due;
}
function policyCurrentAck_(email, bundleId) {
  const latest = policyLatestAck_(email);
  return !!(latest && String(latest.BundleID) === bundleId &&
    Date.now() < policyRenewalAt_(latest.AcknowledgedAt).getTime());
}
function policyUpdateState_(me) {
  const state = {required:false, birthDateRequired:false, reason:''};
  if (!policyHasAccount_(me)) return state;
  const latest = policyLatestAck_(me.email), bundleId = apiPolicies_().bundleId;
  var validDob = false;
  try { validDob = policyBirthDate_(policyExistingDob_(me.email)).age >= 13; } catch (ignore) {}
  // Legacy holders confirm DOB once; signup or a prior update already did so.
  state.birthDateRequired = !validDob || (!latest && !policyProfile_(me.email));
  if (!latest) state.reason = 'initial';
  else if (String(latest.BundleID) !== bundleId) state.reason = 'policy-changed';
  else if (Date.now() >= policyRenewalAt_(latest.AcknowledgedAt).getTime()) state.reason = 'quarterly';
  else if (state.birthDateRequired) state.reason = 'initial';
  state.required = !!state.reason;
  return state;
}
function policyNeedsUpdate_(me) {
  return policyUpdateState_(me).required;
}
function policyRequireCurrent_() {
  if (policyNeedsUpdate_(accountsWhoami_()))
    throw new Error('ACCOUNT_UPDATE_REQUIRED: Review the account update before continuing.');
}
function policyValidateAck_(ack) {
  const bundle = apiPolicies_();
  if (!ack || ack.bundleId !== bundle.bundleId)
    throw new Error('The policies have changed. Reload this page to review the current versions.');
  if (ack.terms !== true || ack.privacy !== true || ack.data !== true)
    throw new Error('Agree to the Terms of Use and acknowledge the Privacy and Data policies.');
  if (!ack.review || ['terms','privacy','data'].some(function(k){return ['opened','scrolled'].indexOf(ack.review[k])<0;}))
    throw new Error('Open each policy or scroll to the end before acknowledging it.');
  return bundle;
}
function policyEnsureTab_(name, columns) {
  if (!hasTab_(name)) {
    const sh = db_().insertSheet(name);
    sh.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  acctAssertHeaders_(name, columns);
}

/** Called only after inbox/session verification. Never records raw session tokens. */
function policyRecord_(email, dob, ack, source, registrationRole) {
  const birth = policyBirthDate_(dob);
  if (birth.age < 13) throw new Error('Account registration is available from age 13. Contact ' + POLICY.EMAIL + ' for help.');
  const bundle = policyValidateAck_(ack);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account update is being saved. Try again.');
  try {
    [POLICY.PROFILE_TAB, POLICY.ACK_TAB, POLICY.DOC_TAB, ACCT.TAB].forEach(function (tab) { delete __tableCache[tab]; });
    policyEnsureTab_(POLICY.PROFILE_TAB, POLICY.PROFILE_COLS);
    policyEnsureTab_(POLICY.ACK_TAB, POLICY.ACK_COLS);
    policyEnsureTab_(POLICY.DOC_TAB, POLICY.DOC_COLS);
    const existingDob = policyExistingDob_(email);
    var validExisting = '';
    try { validExisting = policyBirthDate_(existingDob).value; } catch (ignore) {}
    if (validExisting && validExisting !== birth.value)
      throw new Error('That birth date does not match the account record. Check it or contact ' + POLICY.EMAIL + ' to correct it.');
    const now = new Date();
    const archived = policyRows_(POLICY.DOC_TAB);
    const missing = bundle.documents.filter(function (d) {
      return !archived.some(function (a) { return String(a.DocumentID) === d.documentId; });
    }).map(function (d) { return {DocumentID:d.documentId, Kind:d.kind, Version:d.version,
      Title:d.title, Text:d.text, SHA256:d.sha256, RecordedAt:now}; });
    appendRows_(POLICY.DOC_TAB, missing);
    const profile = policyProfile_(email);
    // A new signup can still fail roster validation. Its DOB becomes durable
    // account data only when Accounts is written; don't lock in a failed form.
    const awaitingAccount = source === 'registration' && !acctFind_(email);
    if (!profile && !awaitingAccount) appendRows_(POLICY.PROFILE_TAB, [{Email:email, BirthDate:birth.value, RecordedAt:now, Source:source}]);
    else if (profile && !validExisting) updateCells_(POLICY.PROFILE_TAB, [
      {row:profile.__row, field:'BirthDate', value:birth.value},
      {row:profile.__row, field:'RecordedAt', value:now},
      {row:profile.__row, field:'Source', value:source}
    ]);
    const latest = policyLatestAck_(email);
    if (!policyCurrentAck_(email, bundle.bundleId) || !latest ||
        latest.BirthDateDigest !== authHash_(email + '|' + birth.value)) {
      const row = acctFind_(email);
      const me = accountsWhoami_();
      appendRows_(POLICY.ACK_TAB, [{AcknowledgmentID:Utilities.getUuid(), Email:email,
        AccountID:row ? String(row.AccountID || '') : '',
        Role:row ? String(row.Role || row.RequestedRole || me.role) : (registrationRole || me.role),
        AcknowledgedAt:now, BundleID:bundle.bundleId,
        TermsVersion:bundle.documents[0].version, PrivacyVersion:bundle.documents[1].version,
        DataVersion:bundle.documents[2].version, TermsAgreed:true,
        PrivacyAcknowledged:true, DataAcknowledged:true, Source:source,
        BirthDateDigest:authHash_(email + '|' + birth.value),
        TermsDocumentID:bundle.documents[0].documentId, PrivacyDocumentID:bundle.documents[1].documentId,
        DataDocumentID:bundle.documents[2].documentId,
        // Browser-reported interaction, not proof that the person read the text.
        TermsReviewMethod:ack.review.terms, PrivacyReviewMethod:ack.review.privacy,
        DataReviewMethod:ack.review.data}]);
    }
    delete __tableCache[POLICY.PROFILE_TAB];
  } finally { lock.releaseLock(); }
}
function apiCompleteAccountUpdate_(p) {
  const me = accountsWhoami_();
  if (!me.email || !policyHasAccount_(me)) throw new Error('Sign in to an existing account first.');
  p = p || {};
  const state = policyUpdateState_(me);
  // Reuse the private record on renewals. Any supplied correction still goes
  // through policyRecord_'s mismatch check; never allow changing DOB here.
  const dob = state.birthDateRequired || p.dob ? p.dob : policyExistingDob_(me.email);
  const source = state.reason === 'quarterly' ? 'quarterly-renewal'
    : state.reason === 'policy-changed' ? 'policy-update' : 'account-update';
  policyRecord_(me.email, dob, p.policies, source);
  return apiAuthState_();
}
/** Mirror the account DOB and attach its ID without rewriting the agreement. */
function policyLinkRegistration_(email) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Could not link registration acknowledgment.');
  try {
    delete __tableCache[ACCT.TAB]; delete __tableCache[POLICY.ACK_TAB]; delete __tableCache[POLICY.PROFILE_TAB];
    const row = acctFind_(email);
    if (!row || !row.AccountID) return;
    const updates = [];
    policyRows_(POLICY.ACK_TAB).forEach(function (r) {
      if (String(r.Email || '').trim().toLowerCase() === email && r.Source === 'registration' && !r.AccountID)
        updates.push({row:r.__row, field:'AccountID', value:String(row.AccountID)});
    });
    updateCells_(POLICY.ACK_TAB, updates);
    if (!policyProfile_(email)) {
      const birth = policyBirthDate_(policyExistingDob_(email));
      appendRows_(POLICY.PROFILE_TAB, [{Email:email, BirthDate:birth.value, RecordedAt:new Date(), Source:'registration'}]);
    }
  } finally { lock.releaseLock(); }
}
function authFinalizeRegistration_(reg) {
  authDob_(reg.dob, reg.role);
  policyValidateAck_(reg.policies); // reject an old code flow after a policy change
  const prior = policyExistingDob_(String(reg.email || '').toLowerCase());
  var priorValid = '';
  try { priorValid = policyBirthDate_(prior).value; } catch (ignore) {}
  if (priorValid && priorValid !== reg.dob)
    throw new Error('That birth date does not match the account record. Contact ' + POLICY.EMAIL + ' to correct it.');
  // Inbox verification has completed. Save its actual acknowledgment before
  // account creation, so a later audit/cache failure cannot lose this step.
  policyRecord_(reg.email, reg.dob, reg.policies, 'registration', reg.role);
  try { return acctFinalizeRegistration_(reg); }
  finally {
    try { policyLinkRegistration_(reg.email); }
    catch (e) { Logger.log('Registration acknowledgment saved; compliance follow-up failed: ' + e.message); }
  }
}

/** Active adult accounts share AI access. DOB is self-reported, not identity-verified. */
function blitzAccess_(me) {
  if (!me || !me.email || me.status !== 'ACTIVE' || ['PLAYER','COACH','ADMIN','FAN'].indexOf(me.role) < 0)
    return {allowed:false};
  const account = acctFind_(me.email);
  if (account && acctStatusOf_(account) !== 'ACTIVE') return {allowed:false};
  if (policyNeedsUpdate_(me)) return {allowed:false};
  try { return {allowed:policyBirthDate_(policyExistingDob_(me.email)).age >= 18}; }
  catch (e) { return {allowed:false}; }
}
function withBlitzSession_(token, fn) {
  return withSession_(token, function () {
    const me = accountsWhoami_();
    if (!blitzAccess_(me).allowed) throw new Error('BLITZ_ACCESS: This account cannot open Blitz.');
    return fn('account-' + authHash_(me.email).slice(0, 32));
  }, {fresh:true, allowIncomplete:true});
}
