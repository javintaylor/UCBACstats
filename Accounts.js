/**
 * UCBAC Stats — Accounts.gs
 *
 * Player and coach accounts. Identity is the Google account and nothing else —
 * Session.getActiveUser().getEmail(). There are no passwords here to leak, to
 * reset, or to store badly.
 *
 * This file must run under a deployment configured "Execute as: User accessing
 * the web app", the only configuration in which getActiveUser() returns the
 * visitor rather than a blank string. Under the owner-executing public
 * deployment every visitor reads as signed out, which is correct: the public
 * site needs no account.
 *
 * Approval is not ceremony. A player profile is published on a public site and
 * names a minor, so an unverified stranger must never be able to create one. A
 * PLAYER request waits for that team's COACH or an ADMIN — the coach is the
 * person who actually knows whether this student plays for him. A COACH request
 * waits for an ADMIN, because a coach account can rewrite a whole roster.
 *
 * Nothing here rebuilds the derived layer inline. Registrations arrive in
 * bursts at the start of a season and the sweep trigger collapses a burst into
 * one recompute.
 */

// Tab and column names. These are literals, not CONFIG lookups: Apps Script
// evaluates every file's top-level statements before any function runs and
// Accounts.gs loads ahead of Config.gs alphabetically, so CONFIG is not yet
// defined at this point in the file.
const ACCT = {
  TAB: 'Accounts',
  NOTIFY: 'Notifications',
  COLS: ['AccountID', 'Email', 'Role', 'Status', 'PlayerID', 'TeamID', 'DisplayName',
         'RequestedRole', 'RequestedTeamID', 'RequestedPlayerID', 'Note', 'CreatedAt',
         'ApprovedBy', 'ApprovedAt', 'LastSeenAt'],
  NOTIFY_COLS: ['NotificationID', 'ToEmail', 'Kind', 'Subject', 'Body', 'EntityType',
                'EntityID', 'TeamID', 'CreatedAt', 'SentAt', 'Status'],
  ROLES: ['PLAYER', 'COACH', 'ADMIN', 'FAN'],
  STATUSES: ['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED'],
};

// ── identity ───────────────────────────────────────────────────────────────

/** Every Accounts row, or none at all when the tab has not been created yet. */
function acctRows_() {
  if (!hasTab_(ACCT.TAB)) return [];
  return rowsOf_(ACCT.TAB);
}

/**
 * The account for an email, or null.
 *
 * First row wins, exactly as the Coaches lookup does. The defence against a
 * duplicate is the upsert in apiRegister(), not a tolerant reader — two rows
 * for one person would make access depend on row order.
 */
function acctFind_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  const rows = acctRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Email || '').toLowerCase().trim() === email) return rows[i];
  }
  return null;
}

/** Blank is not ACTIVE. An unfilled Status cell is a request nobody reviewed. */
function acctStatusOf_(row) {
  const v = s_(row && row.Status).toUpperCase();
  return ACCT.STATUSES.indexOf(v) >= 0 ? v : 'PENDING';
}

/**
 * Who is calling, reading the Accounts tab first and the Coaches tab second.
 *
 * The Coaches tab predates accounts and still carries the administrators who
 * bootstrapped the system, so it stays a live grant rather than dead weight. An
 * ADMIN grant there is never downgraded by an account row: the one person who
 * can approve accounts must not be able to lock himself out by registering as a
 * player to see what the form looks like.
 *
 * The shape is a superset of whoami()'s — same email/role/teamId/name keys, plus
 * playerId, status and accountId — so it is a drop-in for it.
 */
function accountsWhoami_() {
  // authEmail(): the session token's owner when the call came through the
  // portal, Session.getActiveUser() otherwise — which still names the script
  // owner, the one identity Google grants on an execute-as-me deployment.
  const email = authEmail_();
  if (!email) {
    return { email: '', role: 'PUBLIC', status: 'NONE', teamId: '', playerId: '',
             name: '', accountId: '' };
  }

  const row = acctFind_(email);
  const status = row ? acctStatusOf_(row) : 'NONE';
  const role = row ? s_(row.Role).toUpperCase() : '';

  var legacy = null;
  try { legacy = whoami_(); } catch (e) { legacy = null; }

  const out = {
    email: email,
    accountId: row ? s_(row.AccountID) : '',
    status: status,
    role: 'PUBLIC',
    teamId: '',
    playerId: '',
    name: (row && s_(row.DisplayName)) || (legacy && legacy.name) || email
  };

  // Only an ACTIVE account grants anything. PENDING, REJECTED and SUSPENDED all
  // read as PUBLIC — they may see the public site and their own request, and
  // nothing else. The status still travels so the UI can say which it is.
  if (row && status === 'ACTIVE' && ACCT.ROLES.indexOf(role) >= 0) {
    out.role = role;
    out.teamId = role === 'FAN' ? '' : s_(row.TeamID);
    out.playerId = role === 'FAN' ? '' : s_(row.PlayerID);
  } else if (legacy && legacy.role !== 'PUBLIC') {
    out.role = legacy.role;
    out.teamId = legacy.teamId;
    if (out.status === 'NONE') out.status = 'ACTIVE';
  }

  if (legacy && legacy.role === 'ADMIN') {
    out.role = 'ADMIN';
    if (!out.teamId) out.teamId = legacy.teamId;
  }
  return out;
}

/**
 * Authentication state for the page shell. Called on every page load.
 *
 * Deliberately uncached. CacheService is script-wide and shared across every
 * visitor, so caching anything keyed on the caller would hand one person's
 * identity, team and player id to the next person through the door. The cost of
 * being honest here is one read of Accounts and one of Coaches — and a signed
 * out visitor, which is most of them, costs neither.
 */
function apiAuthState_() {
  const me = accountsWhoami_();
  const policyState = policyUpdateState_(me);

  var pendingAccounts = 0;
  if (me.role === 'ADMIN') {
    pendingAccounts = acctRows_().filter(function (r) {
      return acctStatusOf_(r) === 'PENDING';
    }).length;
  } else if (me.role === 'COACH' && me.teamId) {
    pendingAccounts = acctRows_().filter(function (r) {
      return acctStatusOf_(r) === 'PENDING' &&
             s_(r.RequestedRole).toUpperCase() === 'PLAYER' &&
             s_(r.RequestedTeamID) === me.teamId;
    }).length;
  }

  /* Corrections count toward the same badge. A player filing one is waiting on
     exactly the same person as a player asking for an account, and a badge that
     showed only half the queue would let the other half sit unread while the
     tab said there was nothing to do. */
  var pendingCorrections = acctPendingCorrections_(me);
  var pendingStats = (typeof taPendingStatCount_ === 'function') ? taPendingStatCount_(me) : 0;

  return {
    email: me.email,
    signedIn: !!me.email,
    accountUpdateRequired: policyState.required,
    accountUpdateBirthDateRequired: policyState.birthDateRequired,
    accountUpdateReason: policyState.reason,
    canUseBlitz: blitzAccess_(me).allowed,
    role: me.role,
    status: me.status,
    teamId: me.teamId,
    playerId: me.playerId,
    name: me.name,
    isAdmin: me.role === 'ADMIN',
    isCoach: me.role === 'COACH',
    isPlayer: me.role === 'PLAYER',
    isFan: me.role === 'FAN',
    pendingAccounts: pendingAccounts,
    pendingCorrections: pendingCorrections,
    pendingStats: pendingStats,
    pendingCount: pendingAccounts + pendingCorrections + pendingStats
  };
}

/**
 * How many stat corrections are waiting on this caller.
 *
 * An administrator sees the whole conference's queue; a coach sees his team's;
 * everyone else sees zero, because nobody else can act on one.
 */
function acctPendingCorrections_(me) {
  if (me.role !== 'ADMIN' && !(me.role === 'COACH' && me.teamId)) return 0;
  if (!hasTab_(CONFIG.TABS.CORRECTIONS)) return 0;
  return rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
    // profileCorrectionStatus, not a raw read: a blank Status is a request
    // nobody reviewed, and the badge exists precisely for those.
    if (profileCorrectionStatus_(r) !== 'PENDING') return false;
    return me.role === 'ADMIN' || s_(r.TeamID) === me.teamId;
  }).length;
}

// ── claiming an existing roster row ────────────────────────────────────────

/** Name tokens, lowercased, suffixes dropped. "Joe Reinhardt III" -> joe/reinhardt. */
function acctNameParts_(v) {
  const toks = String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(function (t) { return t && ['jr', 'sr', 'ii', 'iii', 'iv'].indexOf(t) < 0; });
  return {
    first: toks[0] || '',
    last: toks.length ? toks[toks.length - 1] : '',
    all: toks.join('')
  };
}

/**
 * Exact full name, or surname plus first initial. Nothing else.
 *
 * Identity is exact-match only — a near miss is shown to nobody and bound to
 * nothing. Patterson is not Patterson Mill. Note that a bare surname cannot
 * match a full name under this rule, which is deliberate: it stops the claim
 * form from being used to page through a roster one common surname at a time.
 */
function acctNameMatches_(q, name) {
  const p = acctNameParts_(name);
  if (!p.all || !q.all) return false;
  if (p.all === q.all) return true;
  return !!(p.last && q.last && p.last === q.last &&
            p.first && q.first && p.first.charAt(0) === q.first.charAt(0));
}

/**
 * Roster rows a registering player might be. Requires BOTH a team and a name:
 * the caller gets back only players they could already name, on only the team
 * they named, so this can never be used to read a school's roster wholesale.
 */
function apiClaimCandidates_(teamId, name) {
  const me = accountsWhoami_();
  if (!me.email) throw new Error('Sign in with your Google account first.');

  teamId = s_(teamId);
  const q = acctNameParts_(name);
  if (!teamId || q.all.length < 2) return [];

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  const byPlayer = {};

  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    if (s_(r.TeamID) !== teamId) return;
    const pid = s_(r.PlayerID);
    if (!pid) return;
    const p = players[pid] || {};
    const nm = s_(p.DisplayName) || s_(r.DisplayName);
    if (!acctNameMatches_(q, nm)) return;

    const b = byPlayer[pid] || (byPlayer[pid] = {
      playerId: pid, name: nm, jersey: '',
      grad: s_(p.GradYear) || s_(r.GradYear), seasons: [], latest: ''
    });
    const sid = s_(r.SeasonID);
    if (sid && b.seasons.indexOf(sid) < 0) b.seasons.push(sid);
    // season ids sort lexically because they are SEA-YYYY; show the jersey from
    // the most recent season, which is the one he will recognize
    if (sid >= b.latest) { b.latest = sid; b.jersey = s_(r.Jersey); }
  });

  return Object.keys(byPlayer).map(function (pid) {
    const b = byPlayer[pid];
    return {
      playerId: b.playerId, name: b.name, jersey: b.jersey, grad: b.grad,
      seasons: b.seasons.sort().reverse()
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); }).slice(0, 25);
}

/**
 * A claim must name a player who is actually on that team's roster, and no two
 * accounts may hold the same player — a public profile naming a minor belongs
 * to exactly one person.
 */
function assertClaimable_(teamId, playerId, email) {
  const on = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).some(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.TeamID) === teamId;
  });
  if (!on) throw new Error('Player ' + playerId + ' is not on that team\'s roster.');

  const mine = String(email || '').toLowerCase().trim();
  const taken = acctRows_().some(function (r) {
    return s_(r.PlayerID) === playerId && acctStatusOf_(r) === 'ACTIVE' &&
           String(r.Email || '').toLowerCase().trim() !== mine;
  });
  if (taken) throw new Error('That player is already claimed by another account. ' +
                             'Ask your coach or an administrator.');
}

// ── registration ───────────────────────────────────────────────────────────

/**
 * The Accounts tab has no columns for jersey, positions or measurables, and
 * appendRows() maps objects onto the sheet BY COLUMN NAME — an invented field
 * name lands in no column at all and the row is written blank. So a player's
 * submitted roster details ride inside Note as JSON until approval builds the
 * PlayerSeasons row from them.
 *
 * Only non-blank details are packed. A height nobody entered stays absent and
 * never arrives at the roster as a zero.
 */
function acctPackNote_(note, detail) {
  const o = { note: s_(note) };
  Object.keys(detail || {}).forEach(function (k) {
    const v = detail[k];
    if (v !== '' && v !== null && v !== undefined) o[k] = v;
  });
  return JSON.stringify(o);
}

/** Read a packed Note back. A hand-typed Note is returned as plain text. */
function acctUnpackNote_(raw) {
  const txt = s_(raw);
  if (txt.charAt(0) !== '{') return { note: txt };
  try {
    const o = JSON.parse(txt);
    return (o && typeof o === 'object') ? o : { note: txt };
  } catch (e) { return { note: txt }; }
}

/**
 * appendRows() and updateCells() both match on the header row and both fail
 * silently when a column is absent — one writes a blank row, the other skips
 * the field. Check first and name the missing column.
 */
function acctAssertHeaders_(tabName, needed) {
  if (!hasTab_(tabName))
    throw new Error('The ' + tabName + ' tab does not exist yet. Run ensureSchema_().');
  const sh = getTab_(tabName);
  const head = sh.getLastColumn()
    ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
        .map(function (h) { return String(h).trim(); })
    : [];
  const missing = needed.filter(function (h) { return head.indexOf(h) < 0; });
  if (missing.length)
    throw new Error(tabName + ' is missing column(s): ' + missing.join(', ') +
                    '. Run ensureSchema_().');
  return head;
}

/**
 * Allocate the next sequential ID while the script lock is ALREADY held.
 * nextId() in Database.gs takes the lock itself and would deadlock nested
 * inside one — it would block on us for the full timeout and then throw.
 */
function nextIdLocked_(tabName, field, prefix, pad_) {
  const rows = rowsOf_(tabName);
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    const m = String(rows[i][field] || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  var n = String(max + 1);
  while (n.length < (pad_ || 6)) n = '0' + n;
  return prefix + n;
}


/**
 * Everyone who may review a request for this team, by email. A blank teamId
 * means administrators only — a coach whose own TeamID is blank has no team and
 * can approve nothing, so he must not be mailed about it either.
 */
function acctApproversFor_(teamId) {
  teamId = s_(teamId);
  const out = {};
  acctRows_().forEach(function (r) {
    if (acctStatusOf_(r) !== 'ACTIVE') return;
    const role = s_(r.Role).toUpperCase();
    if (role === 'ADMIN' || (role === 'COACH' && teamId && s_(r.TeamID) === teamId))
      out[String(r.Email || '').toLowerCase().trim()] = true;
  });
  if (hasTab_('Coaches')) {
    rowsOf_('Coaches').forEach(function (c) {
      if (String(c.Active).toUpperCase() === 'FALSE') return;
      const role = String(c.Role || 'COACH').toUpperCase();
      if (role === 'ADMIN' || (role === 'COACH' && teamId && s_(c.TeamID) === teamId))
        out[String(c.Email || '').toLowerCase().trim()] = true;
    });
  }
  delete out[''];
  return Object.keys(out);
}

/**
 * Request an account.
 *
 *   payload { role:'PLAYER'|'COACH', teamId, claimPlayerId|null, displayName,
 *             gradYear, jersey, positions:[codes], heightInches, weightLbs, note }
 *
 * Nothing is granted here. The row is written PENDING and a human decides.
 * Re-registering with the same email UPDATES the pending request rather than
 * adding a second row — two rows for one person would make access depend on row
 * order.
 */
function apiRegister_(payload) {
  payload = payload || {};
  const email = authEmail_();
  if (!email) throw new Error('Sign in before registering.');

  const role = String(payload.role || '').toUpperCase();
  if (['PLAYER', 'COACH'].indexOf(role) < 0)
    throw new Error('Choose PLAYER or COACH. An administrator is added by another ' +
                    'administrator, never by request.');

  const teamId = s_(payload.teamId);
  if (!teamId) throw new Error('Choose your school.');
  const known = rowsOf_(CONFIG.TABS.TEAMS).some(function (t) { return s_(t.TeamID) === teamId; });
  if (!known) throw new Error('Unknown school "' + teamId + '".');

  const displayName = s_(payload.displayName);
  if (!displayName) throw new Error('A name is required.');

  const claimId = s_(payload.claimPlayerId);
  const codes = parsePositions_(formatPositions_(payload.positions || []));
  const detail = {};

  if (role === 'PLAYER') {
    // A claimed row already carries the positions his coach declared, so a
    // claim may leave them blank. A new roster row has none, and one chosen
    // here is what the reviewing coach confirms or corrects.
    if (!claimId || codes.length) {
      const err = validatePositions_(codes);
      if (err) throw new Error(err);
    }
    // these throw rather than collecting: nothing is written yet, so a bad
    // value costs the applicant a retype and costs the sheet nothing
    detail.jersey = normalizeJersey_(payload.jersey);
    detail.ht = numOrBlank_(payload.heightInches);
    detail.wt = numOrBlank_(payload.weightLbs);
    detail.grad = s_(payload.gradYear);
    detail.positions = formatPositions_(codes);
    if (claimId) assertClaimable_(teamId, claimId, email);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another registration is in progress. Try again in a moment.');

  try {
    // another execution may have written since this one first read the tab
    delete __tableCache[ACCT.TAB];
    acctAssertHeaders_(ACCT.TAB, ACCT.COLS);

    const me = { email: email, role: 'PUBLIC' };
    const note = acctPackNote_(payload.note, detail);
    const existing = acctFind_(email);

    if (existing) {
      const status = acctStatusOf_(existing);
      const accountId = s_(existing.AccountID);

      if (status === 'ACTIVE')
        return { status: 'ACTIVE', accountId: accountId,
                 message: 'You already have an active account. An administrator can ' +
                          'change its role or team.' };
      if (status === 'SUSPENDED')
        return { status: 'SUSPENDED', accountId: accountId,
                 message: 'This account is suspended. Contact an administrator.' };

      // PENDING or REJECTED: replace the request in place. A rejected applicant
      // who fixes a typo gets another turn; only an administrator lifts a
      // suspension, which is why it is handled above.
      updateCells_(ACCT.TAB, [
        { row: existing.__row, field: 'DisplayName',       value: displayName },
        { row: existing.__row, field: 'RequestedRole',     value: role },
        { row: existing.__row, field: 'RequestedTeamID',   value: teamId },
        { row: existing.__row, field: 'RequestedPlayerID', value: claimId },
        { row: existing.__row, field: 'Note',              value: note },
        { row: existing.__row, field: 'Status',            value: 'PENDING' },
        { row: existing.__row, field: 'ApprovedBy',        value: '' },
        { row: existing.__row, field: 'ApprovedAt',        value: '' }
      ]);

      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_REQUEST', 'Account', accountId,
        'Status', status, 'PENDING', role + ' ' + teamId + (claimId ? ' claim ' + claimId : ''))]);

      return { status: 'PENDING', accountId: accountId,
               message: acctPendingMessage_(role) };
    }

    const accountId = nextIdLocked_(ACCT.TAB, 'AccountID', 'ACC-', 6);
    appendRows_(ACCT.TAB, [{
      AccountID: accountId, Email: email, Role: '', Status: 'PENDING',
      PlayerID: '', TeamID: '', DisplayName: displayName,
      RequestedRole: role, RequestedTeamID: teamId, RequestedPlayerID: claimId,
      Note: note, CreatedAt: new Date(), ApprovedBy: '', ApprovedAt: '', LastSeenAt: ''
    }]);

    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_REQUEST', 'Account', accountId,
      'Status', '', 'PENDING', role + ' ' + teamId + (claimId ? ' claim ' + claimId : ''))]);

    return { status: 'PENDING', accountId: accountId, message: acctPendingMessage_(role) };
  } finally {
    lock.releaseLock();
  }
}





/**
 * Create the account a validated registration describes. Called with a
 * VERIFIED email only — either the emailed code was just redeemed, or the
 * caller holds a live session for that address. Never from the client.
 *
 *   PLAYER, coach name verified -> ACTIVE now. Linked to the existing roster
 *     record when exactly one carries this player's name for this team;
 *     created fresh when none does; left unlinked (and an administrator told)
 *     when two do — guessing between two boys with one name publishes the
 *     wrong one's statistics to the other.
 *   PLAYER, unverifiable (no coach on file) -> PENDING, the old road.
 *   COACH -> always PENDING; administrators decide. The date of birth and
 *     the coach name given ride along in the Note for the reviewer.
 */
function acctFinalizeRegistration_(reg) {
  const email = String(reg.email || '').toLowerCase();
  if (!email) throw new Error('No verified address to register.');
  const role = String(reg.role || '').toUpperCase();
  if (['PLAYER','COACH','FAN'].indexOf(role) < 0) throw new Error('Invalid account role.');
  const teamId = s_(reg.teamId);
  const name = (s_(reg.first) + ' ' + s_(reg.last)).replace(/\s+/g, ' ').trim();
  // packed, not prose: the approvals page and the request email both read
  // these fields back, and parsing a sentence is how fields get lost
  const note = acctPackNote_('', { dob: s_(reg.dob), coachLast: s_(reg.coachLast),
                                  coachVerified: !!reg.coachVerified,
                                  coachType: s_(reg.coachType).toUpperCase(),
                                  // which sentences he agreed to, so the row can be
                                  // read back against the words in force that day
                                  attest: s_(reg.attest),
                                  consent: s_(reg.consent) });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another registration is in progress. Try again in a moment.');

  try {
    delete __tableCache[ACCT.TAB];
    acctAssertHeaders_(ACCT.TAB, ACCT.COLS);
    const me = { email: email, role: 'PUBLIC' };
    const existing = acctFind_(email);

    if (existing && acctStatusOf_(existing) === 'ACTIVE')
      return { status: 'ACTIVE', message: 'This address already has an active account — ' +
               'you are signed in to it now.' };
    if (existing && acctStatusOf_(existing) === 'SUSPENDED')
      return { status: 'SUSPENDED', message: 'This account is suspended. ' +
               'Contact an administrator.' };

    // Fans own an account only. Never provision or attach a roster/profile,
    // and never replace an existing pending/rejected role request here.
    if (role === 'FAN') {
      if (existing) return {status:acctStatusOf_(existing), message:'This address already has an account request. Contact contact@example.invalid to change its account type.'};
      const accountId = nextIdLocked_(ACCT.TAB, 'AccountID', 'ACC-', 6);
      appendRows_(ACCT.TAB, [{AccountID:accountId, Email:email, Role:'FAN', Status:'ACTIVE',
        PlayerID:'', TeamID:'', DisplayName:name, RequestedRole:'FAN', RequestedTeamID:'',
        RequestedPlayerID:'', Note:note, CreatedAt:new Date(), ApprovedBy:'EMAIL_VERIFIED',
        ApprovedAt:new Date(), LastSeenAt:''}]);
      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_AUTO', 'Account', accountId,
        'Status', '', 'ACTIVE', 'FAN email verified; no team or player privileges')]);
      return {status:'ACTIVE', message:'Your fan account is ready.'};
    }

    // ── the auto-activating player ──────────────────────────────────────
    if (role === 'PLAYER' && reg.coachVerified) {
      const seasonId = CONFIG.CURRENT_SEASON;
      const norm = function (v) {
        return String(v || '').toLowerCase().replace(/[^a-z ]/g, '')
          .replace(/\s+/g, ' ').trim();
      };
      const want = norm(name);

      // exact name, this team, any season — a returning player registers as
      // himself, not as a duplicate of himself
      const hits = {};
      rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
        if (s_(r.TeamID) !== teamId) return;
        if (norm(r.DisplayName) === want) hits[s_(r.PlayerID)] = true;
      });
      /* historical record comment removed */
      const onPlayersTab = {};
      rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
        const pid = s_(p.PlayerID);
        if (pid) onPlayersTab[pid] = true;
      });
      const ids = Object.keys(hits).filter(function (x) {
        return !!x && onPlayersTab[x] === true;
      });

      var playerId = '', ambiguous = false, created = false;
      if (ids.length === 1) {
        playerId = ids[0];
        /* The rule that a public page naming a minor belongs to exactly one
           person lived in assertClaimable() and was never called here — this
           branch wrote Status ACTIVE bound to a PlayerID without asking. The
           three things it needs are all published by this site: a name off the
           team's roster page, the head coach's surname off the same page, and
           any email address. So a second registration in a player's name took
           over his page, his blue check and his stat entry. It is refused now,
           the same way a claim on the reviewed path is. */
        assertClaimable_(teamId, playerId, email);
      }
      else if (ids.length > 1) ambiguous = true;
      else {
        playerId = nextPlayerIdLocked_();
        appendRows_(CONFIG.TABS.PLAYERS, [{
          PlayerID: playerId, DisplayName: name, NameNormalized: want,
          FirstSeenSeason: seasonId, BirthDate: s_(reg.dob), Email: email,
          CreatedFrom: 'SELF_REGISTER:' + email
        }]);
        appendRows_(CONFIG.TABS.PLAYER_SEASONS, [{
          PlayerSeasonID: 'PS-' + seasonId.replace('SEA-', '') + '-' + playerId,
          PlayerID: playerId, TeamID: teamId, SeasonID: seasonId,
          DisplayName: name
        }]);
        created = true;
      }

      /* A birth date on a matched career is the one fact about a player this
         site holds that is NOT published anywhere — which makes it the only
         thing here that can tell the player apart from someone who read his
         name off the roster page. It used to be written FROM the applicant's
         form when the career had none, which had it backwards: the applicant
         was filling in the very fact he was supposed to be checked against.
         It is only ever read now, and a mismatch is refused. A career with no
         birth date on file cannot check anyone, and is left blank rather than
         filled in by whoever registered first. */
      if (playerId && !created) {
        var onFile = '';
        try {
          rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
            if (s_(p.PlayerID) === playerId) onFile = s_(p.BirthDate);
          });
        } catch (e) { onFile = ''; }
        if (onFile && String(onFile).slice(0, 10) !== String(s_(reg.dob)).slice(0, 10))
          throw new Error('That date of birth does not match the one on file for ' +
                          name + '. Check it, or ask your coach to register you.');
      }

      const accountId = existing ? s_(existing.AccountID)
                                 : nextIdLocked_(ACCT.TAB, 'AccountID', 'ACC-', 6);
      const fields = {
        Email: email, Role: 'PLAYER', Status: 'ACTIVE', PlayerID: playerId,
        TeamID: teamId, DisplayName: name, RequestedRole: 'PLAYER',
        RequestedTeamID: teamId, RequestedPlayerID: playerId, Note: note,
        ApprovedBy: 'auto (head-coach check)', ApprovedAt: new Date()
      };
      if (existing) {
        updateCells_(ACCT.TAB, Object.keys(fields).map(function (k) {
          return { row: existing.__row, field: k, value: fields[k] };
        }));
      } else {
        fields.AccountID = accountId;
        fields.CreatedAt = new Date();
        fields.LastSeenAt = '';
        appendRows_(ACCT.TAB, [fields]);
      }

      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_AUTO', 'Account', accountId,
        'Status', existing ? acctStatusOf_(existing) : '', 'ACTIVE',
        'PLAYER ' + teamId + ' ' + (created ? 'created ' : ambiguous ? 'AMBIGUOUS ' : 'linked ')
        + (playerId || ''))]);

      // an ambiguous match is listed in the morning email, under accounts to link
      if (created) {
        CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
        markDirty_('roster');
      }
      return { status: 'ACTIVE',
               message: 'Your account is live' +
                        (playerId ? '.' : ' — an administrator will attach your roster ' +
                                          'record shortly.') };
    }

    // ── everyone a person must look at: coaches, and unverifiable players ──
    if (existing) {
      updateCells_(ACCT.TAB, [
        { row: existing.__row, field: 'DisplayName',     value: name },
        { row: existing.__row, field: 'RequestedRole',   value: role },
        { row: existing.__row, field: 'RequestedTeamID', value: teamId },
        { row: existing.__row, field: 'Note',            value: note },
        { row: existing.__row, field: 'Status',          value: 'PENDING' },
        { row: existing.__row, field: 'ApprovedBy',      value: '' },
        { row: existing.__row, field: 'ApprovedAt',      value: '' }
      ]);
      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_REQUEST', 'Account',
        s_(existing.AccountID), 'Status', acctStatusOf_(existing), 'PENDING',
        role + ' ' + teamId)]);
      return { status: 'PENDING', message: acctPendingMessage_(role) };
    }

    const accountId = nextIdLocked_(ACCT.TAB, 'AccountID', 'ACC-', 6);
    appendRows_(ACCT.TAB, [{
      AccountID: accountId, Email: email, Role: '', Status: 'PENDING',
      PlayerID: '', TeamID: '', DisplayName: name,
      RequestedRole: role, RequestedTeamID: teamId, RequestedPlayerID: '',
      Note: note, CreatedAt: new Date(), ApprovedBy: '', ApprovedAt: '', LastSeenAt: ''
    }]);
    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_REQUEST', 'Account', accountId,
      'Status', '', 'PENDING', role + ' ' + teamId)]);
    return { status: 'PENDING', message: acctPendingMessage_(role) };
  } finally {
    lock.releaseLock();
  }
}

function acctPendingMessage_(role) {
  return role === 'COACH'
    ? 'Request received. An administrator will review it.'
    : 'Request received. Your head coach or an administrator will review it.';
}

/** Whole years between a yyyy-mm-dd birth date and today. null when unreadable. */
function acctAgeOf_(dob) {
  const m = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  var age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() ||
      (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

/**
 * The secret behind the approve-by-email links, created on first use. Knowing
 * a link's signature is knowing this secret was applied to that accountId and
 * that decision — and the only place signatures exist is mail sent to people
 * already entitled to decide.
 */
function acctLinkSecret_() {
  const props_ = PropertiesService.getScriptProperties();
  var v = props_.getProperty('APPROVE_SECRET');
  if (!v) { v = authNewToken_(); props_.setProperty('APPROVE_SECRET', v); }
  return v;
}

function acctLinkSig_(accountId, decision) {
  return authHash_(acctLinkSecret_() + '|' + s_(accountId) + '|' +
                  String(decision).toLowerCase()).slice(0, 32);
}


// ── review ─────────────────────────────────────────────────────────────────

/**
 * A COACH request is reviewed by an ADMIN only — a coach account can rewrite a
 * whole roster. A PLAYER request may also be reviewed by the coach of the team
 * named in the request, who is the person who knows whether this student is on
 * his team.
 */
function assertCanApprove_(me, requestedRole, requestedTeamId) {
  if (me.role === 'ADMIN') return me;
  if (requestedRole === 'PLAYER' && me.role === 'COACH' && me.teamId &&
      me.teamId === requestedTeamId) return me;
  throw new Error('Not authorized to review this request. Signed in as ' +
                  (me.email || 'nobody') + '.');
}

/** Requests this caller may act on. Admins see all of them; a coach sees his own. */
function apiPendingAccounts_() {
  const me = accountsWhoami_();
  if (me.role !== 'ADMIN' && !(me.role === 'COACH' && me.teamId))
    throw new Error('Administrators and team coaches only.');

  const teams = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return s_(t.TeamID); });

  // the running headcount rides with every load of this page — an
  // administrator watching sign-ups should not need a second screen for it
  var totalPlayers = 0, totalCoaches = 0;
  acctRows_().forEach(function (r) {
    if (acctStatusOf_(r) !== 'ACTIVE') return;
    const role = s_(r.Role).toUpperCase();
    if (role === 'PLAYER') totalPlayers++;
    if (role === 'COACH') totalCoaches++;
  });

  const pending = acctRows_().filter(function (r) {
    if (acctStatusOf_(r) !== 'PENDING') return false;
    if (me.role === 'ADMIN') return true;
    return s_(r.RequestedRole).toUpperCase() === 'PLAYER' &&
           s_(r.RequestedTeamID) === me.teamId;
  }).map(function (r) {
    const d = acctUnpackNote_(r.Note);
    const t = teams[s_(r.RequestedTeamID)] || {};
    return {
      accountId: s_(r.AccountID),
      email: s_(r.Email),
      displayName: s_(r.DisplayName),
      requestedRole: s_(r.RequestedRole).toUpperCase(),
      requestedTeamId: s_(r.RequestedTeamID),
      teamName: s_(t.DisplayName) || s_(r.RequestedTeamID),
      dob: s_(d.dob),
      age: acctAgeOf_(d.dob),
      coachLast: s_(d.coachLast),
      coachVerified: d.coachVerified === true,
      coachType: s_(d.coachType),
      note: s_(d.note),
      // getValues() hands back a real Date; String(date) has no year in its
      // first ten characters, so it is neither sortable nor parseable
      createdAt: (r.CreatedAt instanceof Date) ? r.CreatedAt.toISOString() : s_(r.CreatedAt),
      status: acctStatusOf_(r)
    };
  }).sort(function (a, b) {
    return a.createdAt < b.createdAt ? -1 : (a.createdAt > b.createdAt ? 1 : 0);
  });

  return { pending: pending,
           totals: { players: totalPlayers, coaches: totalCoaches,
                     pending: pending.length } };
}

/**
 * Give the approved player somewhere to stand.
 *
 * A claim binds to the PlayerID that already exists and leaves the roster row
 * alone — jersey and positions belong to the coach, not to the applicant. But a
 * returning senior may have no row for the season that just opened, and binding
 * alone would leave an approved account attached to no roster at all, so a
 * missing current-season row is created from what he submitted.
 *
 * Must be called under the script lock: it allocates a PlayerID.
 */
function acctProvisionPlayer_(me, row, detail) {
  const seasonId = CONFIG.CURRENT_SEASON;
  const teamId = s_(row.RequestedTeamID);
  const name = s_(row.DisplayName) || s_(row.Email);
  const accountId = s_(row.AccountID);
  var playerId = s_(row.RequestedPlayerID);
  var changed = false;

  if (playerId) {
    assertClaimable_(teamId, playerId, s_(row.Email));
    /* A claim can name an ID whose Players row has since gone — a merge that
       missed a reference, or a request that has been sitting in the queue. The
       ID is right; everything else in the workbook still calls him that. So the
       identity row is put back under the same ID rather than the approval
       binding him to nothing. */
    const present = rowsOf_(CONFIG.TABS.PLAYERS).some(function (p) {
      return s_(p.PlayerID) === playerId;
    });
    if (!present) {
      appendRows_(CONFIG.TABS.PLAYERS, [{
        PlayerID: playerId, DisplayName: name,
        NameNormalized: name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
        GradYear: detail.grad || '', FirstSeenSeason: seasonId,
        CreatedFrom: 'ORPHAN_REPAIR:' + accountId
      }]);
      changed = true;
    }
  } else {
    // allocate inside our own lock; nextId() would take the lock again and hang
    playerId = nextPlayerIdLocked_();
    appendRows_(CONFIG.TABS.PLAYERS, [{
      PlayerID: playerId, DisplayName: name,
      NameNormalized: name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
      GradYear: detail.grad || '', FirstSeenSeason: seasonId,
      BirthDate: detail.dob || '',
      CreatedFrom: 'ACCOUNT:' + accountId + ':' + me.email
    }]);
    changed = true;
  }

  const seated = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).some(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.SeasonID) === seasonId;
  });
  if (!seated) {
    appendRows_(CONFIG.TABS.PLAYER_SEASONS, [{
      PlayerSeasonID: 'PS-' + seasonId.replace('SEA-', '') + '-' + playerId,
      PlayerID: playerId, TeamID: teamId, SeasonID: seasonId,
      Jersey: detail.jersey === undefined ? '' : detail.jersey,
      Positions: formatPositions_(parsePositions_(detail.positions || '')),
      HeightInches: detail.ht === undefined ? '' : detail.ht,
      WeightLbs: detail.wt === undefined ? '' : detail.wt,
      DisplayName: name, GradYear: detail.grad || ''
    }]);
    changed = true;
  }

  return { playerId: playerId, changed: changed };
}

/**
 * Approve or reject a pending request.
 *
 * Approving a PLAYER binds the account to an existing PlayerID when he claimed
 * one, and otherwise creates the Players row and the current-season
 * PlayerSeasons row from what he submitted. Either way the decision lands in
 * the AuditLog and a notification is queued for the applicant.
 *
 * Re-deciding a request that is no longer PENDING is a no-op that says so,
 * rather than a second approval that appends a second roster row.
 */
function apiApproveAccount_(accountId, approve, note) {
  return acctDecide_(accountsWhoami_(), accountId, approve, note);
}

/**
 * Decide a request from an emailed link — no session, no sign-in.
 *
 * The signature is the authorization: it exists only in mail queued to the
 * people acctApproversFor() named, so presenting it is presenting that mail.
 * It binds the account AND the decision, so an approve link cannot be bent
 * into a reject. Wrong or stale signatures learn nothing — one refusal
 * message regardless of whether the account exists.
 */
function apiDecideByLink_(accountId, decision, sig) {
  accountId = s_(accountId);
  decision = String(decision || '').toLowerCase();
  if (decision !== 'approve' && decision !== 'reject')
    throw new Error('This link is not valid.');
  if (!accountId || s_(sig) !== acctLinkSig_(accountId, decision))
    throw new Error('This link is not valid.');
  return acctDecide_({ email: 'email-link', role: 'ADMIN', teamId: '' },
                    accountId, decision === 'approve',
                    'decided from the request email');
}

function acctDecide_(me, accountId, approve, note) {
  accountId = s_(accountId);
  if (!accountId) throw new Error('Which account?');
  approve = !!approve;
  note = s_(note);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');

  try {
    delete __tableCache[ACCT.TAB];
    acctAssertHeaders_(ACCT.TAB, ACCT.COLS);

    var row = null;
    const rows = rowsOf_(ACCT.TAB);
    for (var i = 0; i < rows.length; i++) {
      if (s_(rows[i].AccountID) === accountId) { row = rows[i]; break; }
    }
    if (!row) throw new Error('No account ' + accountId + '.');

    const wantRole = s_(row.RequestedRole).toUpperCase();
    const wantTeam = s_(row.RequestedTeamID);
    assertCanApprove_(me, wantRole, wantTeam);

    const status = acctStatusOf_(row);
    if (status !== 'PENDING')
      return { ok: false, message: 'Account ' + accountId + ' is already ' + status + '.' };

    const applicant = s_(row.Email);
    const detail = acctUnpackNote_(row.Note);

    if (!approve) {
      updateCells_(ACCT.TAB, [
        { row: row.__row, field: 'Status',     value: 'REJECTED' },
        { row: row.__row, field: 'ApprovedBy', value: me.email },
        { row: row.__row, field: 'ApprovedAt', value: new Date() }
      ]);
      ensureOpsTabs_();
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_REJECT', 'Account', accountId,
        'Status', status, 'REJECTED', note)]);
      // no note to the applicant: the sign-in form says a pending account is pending
      return { ok: true, message: 'Rejected ' + applicant + '.' };
    }

    if (ACCT.ROLES.indexOf(wantRole) < 0 || wantRole === 'ADMIN')
      throw new Error('Request ' + accountId + ' asks for role "' + wantRole +
                      '", which cannot be granted here.');
    if (!wantTeam) throw new Error('Request ' + accountId + ' names no team.');

    var playerId = '', rosterChanged = false;
    if (wantRole === 'PLAYER') {
      const prov = acctProvisionPlayer_(me, row, detail);
      playerId = prov.playerId;
      rosterChanged = prov.changed;
    }

    updateCells_(ACCT.TAB, [
      { row: row.__row, field: 'Role',       value: wantRole },
      { row: row.__row, field: 'Status',     value: 'ACTIVE' },
      { row: row.__row, field: 'TeamID',     value: wantTeam },
      { row: row.__row, field: 'PlayerID',   value: playerId },
      { row: row.__row, field: 'ApprovedBy', value: me.email },
      { row: row.__row, field: 'ApprovedAt', value: new Date() }
    ]);

    /* An approved coach is a working coach: seat them on the Coaches tab for
       their school in the same stroke, so the roster editor and stat entry
       work the moment they sign in — no second, easily-forgotten admin step. */
    if (wantRole === 'COACH' && hasTab_('Coaches')) {
      const coachRows = rowsOf_('Coaches');
      const onTab = coachRows.some(function (c) {
        return String(c.Email || '').toLowerCase().trim() === applicant.toLowerCase() &&
               s_(c.TeamID) === wantTeam &&
               String(c.Active).toUpperCase() !== 'FALSE';
      });
      if (!onTab) {
        // head or assistant rode in on the request Note; landed on the row it
        // tells the team page and his own page which he is
        var ctype = '';
        try { ctype = String((acctUnpackNote_(row.Note) || {}).coachType || '').toUpperCase(); } catch (e) {}
        ctype = ctype === 'HEAD' || ctype === 'ASSISTANT' ? ctype : '';

        /* A seeded seat is claimed, never duplicated. The admin may have
           filled this coach's public page from press coverage before he ever
           signed up, which leaves a Coaches row carrying his name and no
           email. Appending a second row would split him in two: the page
           would keep reading the seeded row while his own portal edits landed
           on the new one, invisibly. So the email goes onto the seat instead —
           the team's head-coach seat when the admin approved him as head
           coach, else the seat bearing his name. */
        const seat = coachRows.filter(function (c) {
          if (s_(c.TeamID) !== wantTeam || s_(c.Email)) return false;
          if (String(c.Active).toUpperCase() === 'FALSE') return false;
          if (ctype === 'HEAD') return s_(c.CoachType).toUpperCase() === 'HEAD';
          return typeof coachNorm_ === 'function' &&
                 coachNorm_(c.DisplayName) === coachNorm_(row.DisplayName) && !!coachNorm_(row.DisplayName);
        })[0];
        if (seat) {
          // Email is the claim itself and has to land. The other two are
          // niceties an older Coaches tab may have no column for, and a
          // missing column there is no reason to refuse a coach his seat.
          const claim = [{ row: seat.__row, field: 'Email', value: applicant }];
          if (!s_(seat.CoachType) && ctype && hasColumn_('Coaches', 'CoachType'))
            claim.push({ row: seat.__row, field: 'CoachType', value: ctype });
          if (!s_(seat.AddedAt) && hasColumn_('Coaches', 'AddedAt'))
            claim.push({ row: seat.__row, field: 'AddedAt', value: new Date() });
          updateCells_('Coaches', claim);
        } else {
          appendRows_('Coaches', [{
            Email: applicant, DisplayName: s_(row.DisplayName) || applicant,
            TeamID: wantTeam, Role: 'COACH', Active: true, AddedAt: new Date(),
            CoachType: ctype
          }]);
        }
        delete __tableCache['Coaches'];
      }
    }

    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ACCOUNT_APPROVE', 'Account', accountId,
      'Status', status, 'ACTIVE',
      wantRole + ' ' + wantTeam + (playerId ? ' ' + playerId : '') + (note ? ' — ' + note : ''))]);

    // no note to the applicant: his next sign-in simply works

    if (rosterChanged) {
      CacheService.getScriptCache().removeAll(['boot', 'ac-' + CONFIG.CURRENT_SEASON]);
      // a rebuild is not run inline — accounts arrive in bursts at the start of
      // a season, and the sweep trigger collapses a burst into one recompute
      markDirty_('roster');
    }

    return { ok: true, message: 'Approved ' + applicant + ' as ' + wantRole +
                                (playerId ? ' (' + playerId + ')' : '') + '.' };
  } finally {
    lock.releaseLock();
  }
}
