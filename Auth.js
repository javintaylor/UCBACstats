/**
 * UCBAC Stats — Auth.gs
 *
 * Sign-in by emailed one-time code, on the ONE public deployment.
 *
 * Why not Google sign-in: a web app deployment has a single "execute as"
 * setting. Running as the visitor is the only way Session.getActiveUser()
 * names anyone — but then every Apps Script call runs AS that visitor, who
 * has no access to the private database workbook, so the portal could read
 * and write nothing for anybody except the owner. Running as the owner keeps
 * the database reachable and the public site sign-in-free, but blinds
 * getActiveUser(). Two deployments with opposite settings was the workaround;
 * this file removes the need for it.
 *
 * The flow: a person types their email, the server mails a six-digit code,
 * they type the code back, and the server hands the browser a long random
 * session token. Every portal call carries the token; the server turns it
 * back into an email. Possessing the code proves control of the inbox, which
 * is the same proof "sign in with Google" gives for a Gmail address — and it
 * also works for the school addresses coaches actually use.
 *
 * What is stored where, and why:
 *   - Codes: hashed, in CacheService, 10 minutes. A code is worthless after
 *     redemption or expiry, so it belongs in the layer that forgets.
 *   - Sessions: hashed, in a Sessions tab. They must survive for months and
 *     be revocable one at a time, which is exactly what a sheet row is.
 *   - Nothing is ever stored that could be replayed from a leak of the tab:
 *     the tab holds SHA-256 digests, not the tokens themselves.
 */

/* The two things a player agrees to before an account is made, in the words
   the form shows him. They live on the server rather than in Portal.html
   because the server is what enforces them and what records them: the version
   is written to the account, so a row can be read back against the sentences
   in force the day it was signed rather than the ones in force today. Bump a
   version whenever its words change.

   Two boxes and not one, because they are two different questions. The first
   is a claim about himself that only he can answer. The second is a fact
   about this site that he is owed before he answers the first. Rolling them
   into a single tick would let a yes to one stand as a yes to the other. */
const ATTEST_TEXT =
  'I play varsity football for this school this season and I am on the roster now.\n' +
  'This is me — not a teammate, not a brother, not a player I follow.';

const CONSENT_TEXT =
  'Published, on pages anyone can read: my name, school, class, jersey, position, ' +
  'measurables and statistics.\n' +
  'Never published: my email address. My date of birth is never shown — only my age.\n' +
  'My coach and I can both edit my line; I can share my profile as a link or a card.\n' +
  'If I am under 18, a parent or guardian knows I am making this account.\n' +
  'I can ask for my page to be taken down by emailing contact@example.invalid.';

const AUTH = {
  ATTEST_VERSION: 'ATTEST-1 2026-09',
  CONSENT_VERSION: 'CONSENT-1 2026-09',
  FAN_CONSENT_VERSION: 'FAN-CONSENT-1 2026-10',
  TAB: 'Sessions',
  COLS: ['SessionHash', 'Email', 'CreatedAt', 'LastSeenAt', 'ExpiresAt', 'RevokedAt'],

  CODE_TTL_SECONDS: 600,        // ten minutes to get to an inbox is plenty
  CODE_MAX_ATTEMPTS: 5,         // then the code dies and a new one is needed
  REQUEST_COOLDOWN_SECONDS: 60, // one mail per address per minute
  SESSION_DAYS: 180,            // roughly a season plus the awards argument

  // Signing in twice on the same day should not grow the tab forever; expired
  // and revoked rows are swept opportunistically on each successful login.
  PRUNE_ON_LOGIN: true
};

// ── the per-request identity ────────────────────────────────────────────────

/**
 * The email this execution is acting for. One request is one execution in
 * Apps Script, so globals set at the svc boundary are request-scoped by
 * construction.
 *
 * Inside withSession() — every call the portal makes — the token is the ONLY
 * identity, including when it resolves to nobody. The Session fallback below
 * is for everything else: menu functions and the editor, where the person at
 * the keyboard IS the Google account. It must never leak into the portal
 * path, because Session.getActiveUser() names the script owner even on an
 * execute-as-me deployment — so with the fallback live, the owner's sign-out
 * cleared the token, the next call fell back to Google, and the portal
 * silently signed them straight back in. Sign-out that only works for people
 * who are not the administrator is the kind of bug the administrator can
 * never see.
 */
var __AUTH_EMAIL = '';
var __AUTH_BOUND = false;

function authEmail_() {
  if (__AUTH_BOUND) return __AUTH_EMAIL;
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}

/**
 * Resolve a session token and run fn as that person — or as nobody, if the
 * token is missing, expired or revoked. Every portal svc wrapper goes through
 * here; api* signatures stay exactly as they were, because accountsWhoami()
 * and whoami() read authEmail() rather than a parameter. The finally is not
 * decoration — executions are isolated, but a triggered function running in
 * the same global scope must never inherit a login.
 */
function withSession_(token, fn, options) {
  options = options || {};
  __AUTH_EMAIL = authSessionEmail_(token, !!options.fresh);
  __AUTH_BOUND = true;
  try {
    if (__AUTH_EMAIL && !options.allowIncomplete) policyRequireCurrent_();
    return fn();
  }
  finally { __AUTH_EMAIL = ''; __AUTH_BOUND = false; }
}

// ── primitives ──────────────────────────────────────────────────────────────

function authHash_(v) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(v))
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); })
    .join('');
}

/** Six digits from getUuid's entropy — Math.random is not for credentials. */
function authNewCode_() {
  const hex = Utilities.getUuid().replace(/-/g, '');
  const n = parseInt(hex.slice(0, 12), 16) % 1000000;
  return ('00000' + n).slice(-6);
}

function authNewToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function authMailable_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return '';
  return email;
}

function ensureSessionsTab_() {
  if (hasTab_(AUTH.TAB)) return;
  const sh = db_().insertSheet(AUTH.TAB);
  sh.getRange(1, 1, 1, AUTH.COLS.length).setValues([AUTH.COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

// ── step one: mail a code ───────────────────────────────────────────────────

/**
 * Always answers the same sentence whether or not the address is known.
 * A login form that answers differently for known addresses is a directory
 * of every coach and player who has an account.
 *
 * Sent directly, not through the Notifications queue: the queue drains on a
 * five-minute trigger, and a person is sitting at the form right now.
 */
function apiRequestLoginCode_(email) {
  const addr = authMailable_(email);
  const sent = 'If that address can sign in, a code is on its way. It works for ten ' +
               'minutes. Not in your inbox? Check your spam or junk folder.';
  if (!addr) throw new Error('That is not an email address.');

  const cache = CacheService.getScriptCache();
  if (cache.get('lc-cool:' + addr))
    return { ok: true, message: 'A code was already sent. Check your inbox and spam folder — ' +
                                'a new one can be requested in a minute.' };

  authAssertMailQuota_();

  const code = authNewCode_();
  cache.put('lc:' + addr, authHash_(code), AUTH.CODE_TTL_SECONDS);
  cache.put('lc-n:' + addr, '0', AUTH.CODE_TTL_SECONDS);
  cache.put('lc-cool:' + addr, '1', AUTH.REQUEST_COOLDOWN_SECONDS);

  MailApp.sendEmail({
    to: addr,
    subject: code + ' is your UCBAC Stats sign-in code',
    body: 'Your sign-in code is:\n\n    ' + code + '\n\nIt works for ten minutes, once. ' +
          'If you did not request it, ignore this message — nobody can sign in ' +
          'without it.\n\nExpecting a code that never arrived? Check your spam or ' +
          'junk folder — school mail filters sometimes hold these.\n\n— UCBAC Stats. ' +
          'This message was sent automatically; replies to it are not read.',
    name: 'UCBAC Stats'
  });
  return { ok: true, message: sent };
}

/**
 * Can the site send a message right now? Unreadable and exhausted are
 * different failures with different fixes, and collapsing them sent people
 * to wait for a tomorrow that would not help. The quota call throwing almost
 * always means the script lost or never got its mail authorization — waiting
 * cannot fix that.
 */
function authAssertMailQuota_() {
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  /* What the person at the form is told is the same either way: the reason
     is the site's business, not theirs, and "the mail allowance is used up"
     invites a hundred people to try again in a minute. The real reason goes to
     the log and to UCBAC Stats > Coaches > Check sign-in. */
  const down = 'Sign-in is under maintenance for the rest of today. Please try again ' +
               'tomorrow. The public site is unaffected.';
  if (quota < 0) {
    Logger.log('sign-in mail: the script is not authorized to send - open the Apps Script ' +
               'editor, run any function once, approve the permissions; or hand out a code ' +
               'with UCBAC Stats > Coaches > Emergency sign-in code');
    throw new Error(down);
  }
  if (quota < 1) {
    Logger.log('sign-in mail: the daily allowance is used up (about 100 messages a day)');
    throw new Error(down);
  }
}

// ── "which email did I use?" ────────────────────────────────────────────────

const FORGOT = {
  COOLDOWN_SECONDS: 600          // one reminder per account per ten minutes
};

/**
 * A player who has forgotten which address his account is under names his
 * school and himself; the reminder goes to THE ADDRESS ON THE ACCOUNT, and
 * the screen never shows it. The screen does say whether a player account
 * exists for that name - which the public site already says, with the
 * verified mark beside a player who has one. Player accounts only: whether a
 * coach holds an account is nobody's business but the conference's.
 *
 * The name is matched the way a claim is: exact, or surname plus first
 * initial, against the account's own name and the roster name it is linked
 * to. Nothing looser, so this cannot be used to walk a roster.
 */
function apiForgotEmail_(teamId, name) {
  teamId = s_(teamId);
  const raw = String(name || '').trim();
  const q = acctNameParts_(raw);
  if (!teamId) throw new Error('Choose your school.');
  if (raw.split(/\s+/).length < 2 || q.all.length < 3)
    throw new Error('Type your first and last name.');
  const team = (typeof teamNameOf_ === 'function' && teamNameOf_(teamId)) || teamId;

  const players = {};
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) { players[s_(p.PlayerID)] = s_(p.DisplayName); });
  const hits = acctRows_().filter(function (r) {
    if (acctStatusOf_(r) !== 'ACTIVE') return false;
    if (s_(r.Role).toUpperCase() !== 'PLAYER') return false;
    if (s_(r.TeamID) !== teamId) return false;
    if (!authMailable_(r.Email)) return false;
    return acctNameMatches_(q, r.DisplayName) ||
           (s_(r.PlayerID) && acctNameMatches_(q, players[s_(r.PlayerID)] || ''));
  });
  if (!hits.length)
    return { found: false, team: team,
             message: 'No player account for ' + raw + ' at ' + team + '. Check the spelling, ' +
                      'or create an account if you have not yet.' };

  authAssertMailQuota_();
  var portal = '';
  try { portal = (typeof portalUrl_ === 'function') ? portalUrl_() : ''; } catch (e) {}
  const cache = CacheService.getScriptCache();
  var sent = 0, names = [];
  hits.forEach(function (r) {
    const addr = authMailable_(r.Email);
    const who = s_(r.DisplayName) || players[s_(r.PlayerID)] || raw;
    if (names.indexOf(who) < 0) names.push(who);
    const key = 'fe:' + s_(r.AccountID || addr);
    if (cache.get(key)) return;                    // reminded minutes ago; do not be a spam gun
    cache.put(key, '1', FORGOT.COOLDOWN_SECONDS);
    MailApp.sendEmail({
      to: addr,
      subject: 'Your UCBAC Stats sign-in email',
      body: 'Hi ' + who + ',\n\n' +
            'This address - ' + addr + ' - is the sign-in email for your UCBAC Stats player ' +
            'account (' + team + ').\n\n' +
            'To sign in:\n' +
            '  1. Open the portal' + (portal ? ': ' + portal : '') + '\n' +
            '  2. Enter this email address and press "Email me a code".\n' +
            '  3. A six-digit code arrives here within a minute. Type it in.\n\n' +
            'No password, no Google account needed. If the code does not arrive, check ' +
            'your spam or junk folder.\n\n' +
            'If you did not ask for this reminder, ignore it - nobody can sign in without ' +
            'the code.\n\n— UCBAC Stats. This message was sent automatically; replies to it ' +
            'are not read.',
      name: 'UCBAC Stats'
    });
    sent++;
  });
  return { found: true, team: team, name: names.join(', '), sent: sent > 0,
           message: 'There is an email on file for ' + names.join(', ') + ' (' + team + '). ' +
                    'A reminder was just sent to it with the sign-in steps.' };
}

/**
 * Mint a sign-in code WITHOUT sending mail, for an administrator to read out
 * loud, text, or use themselves. The door that still opens when mail cannot:
 * quota gone, authorization broken, a school spam filter eating codes.
 *
 * No authorization check here on purpose — it is reachable only from the
 * spreadsheet menu, and being able to open the spreadsheet is already total
 * control of every number this system holds. The code goes through the same
 * cache, TTL and attempt limits as a mailed one.
 */
function adminMintLoginCode_(email) {
  const addr = authMailable_(email);
  if (!addr) throw new Error('"' + email + '" is not an email address.');
  const code = authNewCode_();
  const cache = CacheService.getScriptCache();
  cache.put('lc:' + addr, authHash_(code), AUTH.CODE_TTL_SECONDS);
  cache.put('lc-n:' + addr, '0', AUTH.CODE_TTL_SECONDS);
  return { email: addr, code: code, minutes: Math.round(AUTH.CODE_TTL_SECONDS / 60) };
}

// ── registration ────────────────────────────────────────────────────────────
//
// One form: role, school, first name, last name, date of birth, the head
// coach's last name, email. The coach's name is the knowledge check — it is
// on the team page for anyone determined, but it stops the idle stranger, and
// it is the difference between a player account creating itself and waiting.
//
//   PLAYER + coach name matches Teams.HeadCoach  -> account is ACTIVE the
//     moment the emailed code proves the inbox. No human in the loop.
//   PLAYER, team has no head coach on file       -> PENDING; someone must look.
//   COACH                                        -> always PENDING; reviewed by
//     the conference administrators. A coach account can rewrite a roster.

/** A person's name part: letters and joiners, 2..40 chars. */
function authNamePart_(v, label) {
  const t = String(v === null || v === undefined ? '' : v)
    .replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 2) throw new Error(label + ' is required.');
  if (t.length > 40) throw new Error(label + ' is too long.');
  return t;
}

/** yyyy-mm-dd, and an age that is possible for the role. */
function authDob_(v, role) {
  const birth = policyBirthDate_(v);
  const t = birth.value, age = birth.age;

  if (role === 'PLAYER' && (age < 13 || age > 19))
    throw new Error('Player accounts are for ages 13 through 19. Check the date of birth.');
  if (role === 'COACH' && (age < 18 || age > 100))
    throw new Error('Check the date of birth.');
  if (role === 'FAN' && age < 13)
    throw new Error('Accounts are available to people age 13 or older. Check the date of birth.');
  return t;
}

/** The last word of the coach's name on file, lowercased. '' when none. */
function authCoachLastOnFile_(team) {
  const full = String((team && team.HeadCoach) || '').trim();
  return full ? full.split(/\s+/).pop().toLowerCase().replace(/[^a-z'\-]/g, '') : '';
}

/**
 * Validate the whole form, or throw the first thing the person can fix.
 * Returns the registration object that will be finalized once the emailed
 * code proves the address.
 */
function authValidateRegistration_(p) {
  p = p || {};
  const role = String(p.role || '').toUpperCase();
  if (['PLAYER','COACH','FAN'].indexOf(role) < 0)
    throw new Error('Choose Fan, Player or Coach first.');

  const teamId = role === 'FAN' ? '' : String(p.teamId || '').trim();
  var team = null;
  if (role !== 'FAN') rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
    if (String(t.TeamID).trim() === teamId) team = t;
  });
  if (role !== 'FAN' && !team) throw new Error('Choose your school.');

  const first = authNamePart_(p.first, 'First name');
  const last = authNamePart_(p.last, 'Last name');
  const dob = authDob_(p.dob, role);
  policyValidateAck_(p.policies);

  /* Both boxes are checked HERE and not only in the form. apiRegisterStart is
     a callable endpoint; a tick box in Portal.html is a courtesy to an honest
     applicant and no obstacle at all to anyone else.

     Be accurate about what the attestation is: a deterrent, and a record of
     what a person was told and agreed to. It is not a control. The controls
     are the head coach's surname below, and the rule that one player's page
     belongs to one account. The consent is not a control at all - it is the
     disclosure that has to happen before a minor puts his name on a public
     page, and the record that it did. */
  if (role === 'PLAYER' && p.attest !== true)
    throw new Error('Tick the box to confirm you play varsity football for this school.');
  if (p.consent !== true)
    throw new Error(role === 'FAN' ? 'Confirm the fan account notice.' : 'Tick the box to confirm you understand what this site publishes.');

  const coachLast = role === 'FAN' ? '' : String(p.coachLast || '').trim();
  if (role !== 'FAN' && !coachLast) throw new Error("The head coach's last name is required.");

  const onFile = authCoachLastOnFile_(team);
  const given = coachLast.toLowerCase().replace(/[^a-z'\-]/g, '');
  const match = !!onFile && given === onFile;

  /* A player naming the wrong coach is refused OUTRIGHT rather than parked
     pending: the pending queue is for requests a person must judge, and a
     failed knowledge check is not a judgement call. A team with no coach on
     file cannot check anyone, so those requests go pending instead. */
  if (role === 'PLAYER' && onFile && !match)
    throw new Error('That does not match the head coach on file for ' +
                    (String(team.DisplayName || '') || teamId) +
                    '. Check the spelling with your coach.');

  // Coaches say which kind they are; the approval email and the Approvals
  // card both show it — same access either way, different standing when an
  // administrator judges the request.
  var coachType = '';
  if (role === 'COACH')
    coachType = String(p.coachType || '').toUpperCase() === 'HEAD' ? 'HEAD' : 'ASSISTANT';

  return { role: role, teamId: teamId,
           teamName: String(team && team.DisplayName || '') || teamId,
           first: first, last: last, dob: dob, coachLast: coachLast,
           coachType: coachType,
           policies: {bundleId:p.policies.bundleId, terms:true, privacy:true, data:true,
             review:{terms:p.policies.review.terms, privacy:p.policies.review.privacy, data:p.policies.review.data}},
           // which words were agreed to, so the record can be read back later
           // rather than remembered
           attest: role === 'PLAYER' ? AUTH.ATTEST_VERSION : '',
           consent: role === 'FAN' ? AUTH.FAN_CONSENT_VERSION : AUTH.CONSENT_VERSION,
           coachVerified: role === 'PLAYER' && match };
}

/**
 * Step one from the signed-out form: validate, stash the registration, and
 * mail the code. Redeeming the code (below) is what actually creates anything
 * — an unverified address must never be able to fill the Accounts tab.
 */
function apiRegisterStart_(p) {
  const reg = authValidateRegistration_(p);
  const email = authMailable_(p && p.email);
  if (!email) throw new Error('That is not an email address.');
  reg.email = email;

  CacheService.getScriptCache().put('reg:' + email, JSON.stringify(reg), 1800);
  const sent = apiRequestLoginCode_(email);
  return { ok: true, message: (sent && sent.message) || 'A code is on its way.' };
}

/**
 * The same form submitted by somebody already signed in — an address that
 * proved itself earlier but never registered. No second code; the session IS
 * the verification.
 */
function apiRegisterFinalize_(p) {
  const email = authEmail_();
  if (!email) throw new Error('Sign in first.');
  const reg = authValidateRegistration_(p);
  reg.email = email;
  return authFinalizeRegistration_(reg);
}

// ── step two: redeem it ─────────────────────────────────────────────────────

function apiRedeemLoginCode_(email, code) {
  const addr = authMailable_(email);
  if (!addr) throw new Error('That is not an email address.');
  const cache = CacheService.getScriptCache();

  const want = cache.get('lc:' + addr);
  if (!want)
    throw new Error('That code has expired or was never sent. Request a new one.');

  const tries = parseInt(cache.get('lc-n:' + addr) || '0', 10) + 1;
  if (tries > AUTH.CODE_MAX_ATTEMPTS) {
    cache.remove('lc:' + addr);
    throw new Error('Too many wrong guesses. Request a new code.');
  }
  cache.put('lc-n:' + addr, String(tries), AUTH.CODE_TTL_SECONDS);

  if (authHash_(String(code || '').replace(/\D/g, '')) !== want)
    throw new Error('That is not the code. ' +
                    (AUTH.CODE_MAX_ATTEMPTS - tries) + ' attempt(s) left.');

  cache.remove('lc:' + addr);      // a code redeems exactly once

  /* A registration waiting on this address is finalized NOW, between the code
     proving the inbox and the auth state being computed — so a new player's
     very first sign-in lands on a live account, not on a form he already
     filled in. A failure here must not eat the sign-in: the session is still
     minted and the problem rides back as a sentence. */
  var registered = '';
  const stash = cache.get('reg:' + addr);
  if (stash) {
    cache.remove('reg:' + addr);
    try {
      __AUTH_EMAIL = addr; __AUTH_BOUND = true;
      const fin = authFinalizeRegistration_(JSON.parse(stash));
      registered = (fin && fin.message) || '';
    } catch (e) {
      registered = 'Signed in, but the account could not be created: ' +
                   (e && e.message ? e.message : e);
    } finally { __AUTH_EMAIL = ''; __AUTH_BOUND = false; }
  }

  ensureSessionsTab_();
  const token = authNewToken_();
  const now = new Date();
  appendRows_(AUTH.TAB, [{
    SessionHash: authHash_(token), Email: addr, CreatedAt: now, LastSeenAt: now,
    ExpiresAt: new Date(now.getTime() + AUTH.SESSION_DAYS * 86400000), RevokedAt: ''
  }]);
  if (AUTH.PRUNE_ON_LOGIN) authPruneSessions_();

  // the state is computed AS the new session so one round trip signs in
  __AUTH_EMAIL = addr;
  __AUTH_BOUND = true;
  try { return { token: token, auth: apiAuthState_(), note: registered }; }
  finally { __AUTH_EMAIL = ''; __AUTH_BOUND = false; }
}

// ── resolving and ending sessions ───────────────────────────────────────────

function authSessionEmail_(token, fresh) {
  token = String(token || '');
  if (token.length < 32) return '';         // never a real token; skip the read
  const h = authHash_(token);

  const cache = CacheService.getScriptCache();
  const hit = fresh ? null : cache.get('sess:' + h);
  if (hit === '!') return '';
  if (hit) return hit;

  if (!hasTab_(AUTH.TAB)) return '';
  const now = new Date();
  const rows = rowsOf_(AUTH.TAB);
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r.SessionHash) !== h) continue;
    if (r.RevokedAt) return '';
    const expiry = r.ExpiresAt instanceof Date ? r.ExpiresAt.getTime() : Date.parse(String(r.ExpiresAt || ''));
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return '';
    const email = String(r.Email || '').toLowerCase();
    cache.put('sess:' + h, email, 600);
    // touched at most daily — a timestamp per call would write on every read
    if (!(r.LastSeenAt instanceof Date) || now.getTime() - r.LastSeenAt.getTime() > 86400000) {
      try { updateCells_(AUTH.TAB, [{ row: r.__row, field: 'LastSeenAt', value: now }]); }
      catch (e) {}
    }
    return email;
  }
  // Remember the miss too. A stale token in one abandoned tab would otherwise
  // re-read the whole tab on every call it makes.
  cache.put('sess:' + h, '!', 600);
  return '';
}

function apiSignOut_(token) {
  token = String(token || '');
  if (!token || !hasTab_(AUTH.TAB)) return { ok: true };
  const h = authHash_(token);
  rowsOf_(AUTH.TAB).forEach(function (r) {
    if (String(r.SessionHash) === h && !r.RevokedAt) {
      updateCells_(AUTH.TAB, [{ row: r.__row, field: 'RevokedAt', value: new Date() }]);
    }
  });
  CacheService.getScriptCache().remove('sess:' + h);
  delete __tableCache[AUTH.TAB];
  return { ok: true };
}

/** Delete rows that can never authenticate again. Best effort, never throws. */
function authPruneSessions_() {
  try {
    if (!hasTab_(AUTH.TAB)) return 0;
    const sh = getTab_(AUTH.TAB);
    const data = sh.getDataRange().getValues();
    const head = data[0].map(String);
    const cExp = head.indexOf('ExpiresAt'), cRev = head.indexOf('RevokedAt');
    const now = new Date();
    const dead = [];
    for (var r = 1; r < data.length; r++) {
      const exp = data[r][cExp], rev = data[r][cRev];
      if ((rev !== '' && rev !== null) || (exp instanceof Date && exp < now))
        dead.push(r + 1);
    }
    // bottom-up: deleting a row renumbers everything beneath it
    dead.sort(function (a, b) { return b - a; })
        .forEach(function (rowIdx) { sh.deleteRow(rowIdx); });
    if (dead.length) delete __tableCache[AUTH.TAB];
    return dead.length;
  } catch (e) { return 0; }
}
