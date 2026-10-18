/**
 * UCBAC Stats — CorrectionMail.gs
 *
 * A stat correction reaches the person who can settle it, whether or not that
 * person has ever signed in.
 *
 * A player disputes a number from his own portal. Until now that put a row in
 * Approvals and told nobody but the site owner, so a school whose coach has no
 * account left the player waiting on a phone call somebody had to remember to
 * make. Now, the moment a correction is filed:
 *
 *   1. Every ACTIVE coach account at that school is emailed, with APPROVE and
 *      REJECT links that decide it from the inbox — the same one-click
 *      mechanism the account-request emails have always used.
 *   2. If that school has no coach account, the head coach is emailed at the
 *      address on the Coaches tab instead, with the same two links and an
 *      invitation to create an account.
 *
 * The links carry an HMAC of the correction id and the decision, signed with
 * the script secret (acctLinkSecret, shared with account approvals). Knowing a
 * link is knowing that secret was applied to that one correction, and the only
 * place the signatures exist is mail sent to the coach entitled to decide.
 * Deciding twice is not possible: the second click reads a row that is no
 * longer PENDING and says so rather than applying the change again.
 *
 * WHERE THE ADDRESSES LIVE: the Coaches tab, one row per head coach, in its
 * Email column — the same column acctApproversFor() already reads. It is a
 * sheet, so a coach who changes school or address is a cell edit, not a code
 * change. UCBAC Stats > Coaches > Head coach emails (dry run / APPLY) fills it
 * from the conference contact list below the first time.
 */

const CORRMAIL = {
  ENTITY: 'StatCorrection',
  KIND: 'CORRECTION_REQUEST',
  BASE_PROP: 'EXEC_URL',          // the real published address, learned from a web request
  /**
   * The conference contact list, for seeding the Coaches tab once.
   *
   * This is a starting point, not the source of truth: after the seeding menu
   * has run, the Email cells on the Coaches tab are what the mailer reads, and
   * they are what an administrator edits. `note` is printed by the dry run so
   * a judgement call is made by a person rather than by this table.
   */
  HEAD_CONTACTS: [] /* private dataset removed */
};

/** An address MailApp could conceivably deliver to. */
function corrMailable_(email) {
  return /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(String(email || '').trim());
}

/**
 * A stat in words, for a coach who does not read column names. The same list
 * the portal shows a reviewer (FIELD_LONG in Portal.html), kept here because
 * that one lives in the browser and this message is written on the server.
 */
const CORR_FIELD_LONG = {
  PassAtt: 'Pass attempts', PassComp: 'Completions', PassYds: 'Passing yards',
  PassTD: 'Passing touchdowns', PassInt: 'Interceptions thrown',
  RushAtt: 'Rush attempts', RushYds: 'Rushing yards', RushTD: 'Rushing touchdowns',
  RushFum: 'Fumbles rushing', Rec: 'Receptions', RecYds: 'Receiving yards',
  RecTD: 'Receiving touchdowns', RecFum: 'Fumbles receiving',
  TackleSolo: 'Solo tackles', TackleAssist: 'Assisted tackles', TFL: 'Tackles for loss',
  Sacks: 'Sacks', Int: 'Interceptions caught', FF: 'Forced fumbles',
  FR: 'Fumbles recovered', PassDef: 'Passes defended', DefTD: 'Defensive touchdowns',
  FGM: 'Field goals made', FGA: 'Field goals attempted', XPM: 'Extra points made',
  XPA: 'Extra points attempted', Punts: 'Punts', PuntYds: 'Punt yards',
  KR: 'Kick returns', KRYds: 'Kick return yards', PR: 'Punt returns',
  PRYds: 'Punt return yards', Pancakes: 'Pancake blocks', Blocks: 'Blocked kicks'
};
function corrFieldLong_(f) { return CORR_FIELD_LONG[s_(f)] || s_(f); }

/**
 * The published /exec address, remembered from a real web request.
 *
 * From the spreadsheet menu ScriptApp.getService().getUrl() returns the
 * project's internal head deployment — an address nobody was ever given — so
 * a decision link built there would be dead on arrival. doGet sees the true
 * address on every page load and stores it here; the menu reads what was
 * stored. Until a page has been loaded once since this shipped, the menu says
 * so rather than mailing a link it cannot vouch for.
 */
function corrRememberBase_() {
  try {
    const url = String(ScriptApp.getService().getUrl() || '');
    if (!url || url.indexOf('/exec') < 0) return;
    const props_ = PropertiesService.getScriptProperties();
    if (String(props_.getProperty(CORRMAIL.BASE_PROP) || '') !== url)
      props_.setProperty(CORRMAIL.BASE_PROP, url);
  } catch (e) {}
}

/**
 * The address to build decision links on, from the best source available.
 *
 *   1. What a page load remembered (above) — always current.
 *   2. The newest /exec address inside an email this site has already sent.
 *      Every account-request notification carries decision links built inside
 *      a real web request, so the true address is sitting in the
 *      Notifications tab whether or not anyone has loaded a page since this
 *      shipped. Found once, it is remembered, so the scan does not repeat.
 *   3. This execution's own idea of it, accepted only if it is an /exec
 *      address — from the spreadsheet menu it is the project's internal head
 *      deployment, which nobody was ever given.
 */
function corrBaseUrl_() {
  const props_ = (function () {
    try { return PropertiesService.getScriptProperties(); } catch (e) { return null; }
  })();
  var stored = '';
  try { stored = String((props_ && props_.getProperty(CORRMAIL.BASE_PROP)) || '').trim(); } catch (e) {}
  if (stored) return stored;

  const found = corrBaseFromSentMail_();
  if (found) {
    try { if (props_) props_.setProperty(CORRMAIL.BASE_PROP, found); } catch (e) {}
    return found;
  }

  try {
    const self = String(ScriptApp.getService().getUrl() || '');
    return self.indexOf('/exec') >= 0 ? self : '';
  } catch (e) { return ''; }
}

/**
 * The newest published address this site has ever mailed out. A redeployment
 * changes the address, so the newest notification wins — an older one names a
 * deployment that may no longer answer.
 */
function corrBaseFromSentMail_() {
  try {
    if (!hasTab_(ACCT.NOTIFY)) return '';
    const rows = rowsOf_(ACCT.NOTIFY);
    for (var i = rows.length - 1; i >= 0; i--) {
      const m = String(rows[i].Body || '')
        .match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/);
      if (m) return m[0];
    }
  } catch (e) {}
  return '';
}

/* ── the links ─────────────────────────────────────────────────────────── */

/**
 * The signature on a decision link.
 *
 * 'corr' is in the signed string so a signature can never be replayed against
 * the account-approval links, which sign the same secret over an account id.
 */
function corrLinkSig_(correctionId, decision) {
  const row=hasTab_(CONFIG.TABS.CORRECTIONS) ? rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function(r){return s_(r.CorrectionID)===s_(correctionId);})[0] : null;
  const epoch=closureReviewEpoch_(row ? s_(row.TeamID) : '');
  return authHash_(acctLinkSecret_() + '|corr|' + s_(correctionId) + '|' +
                  String(decision).toLowerCase() + (epoch ? '|closed-grant:'+epoch : '')).slice(0, 32);
}

function corrLink_(base, correctionId, decision) {
  return base + '?corr=' + encodeURIComponent(s_(correctionId)) +
         '&decide=' + decision + '&sig=' + corrLinkSig_(correctionId, decision);
}

/**
 * Apply a decision that arrived on a link rather than from a signed-in
 * reviewer. The signature IS the authorization, and it is checked before
 * anything is read; the write itself is the ordinary review path, so a
 * correction settled from an inbox is indistinguishable from one settled in
 * the portal apart from the name in the audit row.
 */
function apiDecideCorrectionByLink_(correctionId, decision, sig) {
  correctionId = s_(correctionId);
  decision = String(decision || '').toLowerCase();
  if (decision !== 'approve' && decision !== 'reject')
    throw new Error('This link is not valid.');
  if (!correctionId || s_(sig) !== corrLinkSig_(correctionId, decision))
    throw new Error('This link is not valid.');
  return teamAdminDecideCorrection_(
    { email: 'coach-email-link', role: 'ADMIN', teamId: '', decisionSig:sig, decision:decision },
    correctionId, decision === 'approve' ? 'APPROVE' : 'REJECT',
    'decided from the correction email');
}

/* ── who hears about it ────────────────────────────────────────────────── */

/** ACTIVE coach accounts at this school, by email. */
function corrCoachAccounts_(teamId) {
  teamId = s_(teamId);
  if (!teamId || !hasTab_(ACCT.TAB)) return [];
  const out = {};
  rowsOf_(ACCT.TAB).forEach(function (r) {
    if (s_(r.Status).toUpperCase() !== 'ACTIVE') return;
    if (s_(r.Role).toUpperCase() !== 'COACH') return;
    if (s_(r.TeamID) !== teamId) return;
    const e = String(r.Email || '').trim();
    if (corrMailable_(e)) out[e.toLowerCase()] = e;
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

/**
 * The head coach on the Coaches tab, with whatever address is on file.
 * Falls back to any coach row for the school when no row is marked HEAD —
 * a school with one unlabelled coach row still has somebody to write to.
 */
function corrHeadCoach_(teamId) {
  teamId = s_(teamId);
  if (!teamId || !hasTab_('Coaches')) return null;
  const mine = rowsOf_('Coaches').filter(function (c) {
    return s_(c.TeamID) === teamId && String(c.Active).toUpperCase() !== 'FALSE';
  });
  if (!mine.length) return null;
  const head = mine.filter(function (c) { return s_(c.CoachType).toUpperCase() === 'HEAD'; });
  const pick = head.filter(function (c) { return corrMailable_(c.Email); })[0] ||
               mine.filter(function (c) { return corrMailable_(c.Email); })[0] ||
               head[0] || mine[0];
  return { name: s_(pick.DisplayName), email: String(pick.Email || '').trim(),
           isHead: s_(pick.CoachType).toUpperCase() === 'HEAD' };
}

/** Has this correction already been mailed out to a coach? */
function corrAlreadyNotified_(correctionId) {
  if (!hasTab_(ACCT.NOTIFY)) return false;
  correctionId = s_(correctionId);
  return rowsOf_(ACCT.NOTIFY).some(function (n) {
    return s_(n.Kind) === CORRMAIL.KIND && s_(n.EntityID) === correctionId;
  });
}

/* ── the message ───────────────────────────────────────────────────────── */

/**
 * Mail the people who can settle one correction.
 *
 * Never throws: a correction that is filed and not mailed is still filed, and
 * a player pressing Send must not be shown a mail error he cannot act on.
 * Returns a line describing what happened, for the menu's report.
 */
function corrNotifyCoaches_(correctionId, opts) {
  opts = opts || {};
  try {
    correctionId = s_(correctionId);
    if (!hasTab_(CONFIG.TABS.CORRECTIONS)) return correctionId + ': no corrections tab';

    const c = rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
      return s_(r.CorrectionID) === correctionId;
    })[0];
    if (!c) return correctionId + ': no such correction';
    if (profileCorrectionStatus_(c) !== 'PENDING')
      return correctionId + ': already ' + profileCorrectionStatus_(c) + ' — not mailed';

    const teamId = s_(c.TeamID);
    const teamName = teamNameOf_(teamId) || teamId;

    const accounts = corrCoachAccounts_(teamId);
    const head = accounts.length ? null : corrHeadCoach_(teamId);
    const to = accounts.length ? accounts
             : (head && corrMailable_(head.email) ? [head.email] : []);
    if (!to.length) {
      return correctionId + ': ' + teamName + ' has no coach account and no address on the ' +
             'Coaches tab — nobody to write to. It is still waiting in Approvals.';
    }

    const player = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (p) {
      return s_(p.PlayerID) === s_(c.PlayerID);
    })[0];
    const playerName = (player && s_(player.DisplayName)) || s_(c.PlayerID);
    const game = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
      return s_(g.GameID) === s_(c.GameID);
    })[0];
    const seasonId = s_(c.SeasonID) || CONFIG.CURRENT_SEASON;
    const where = s_(c.GameID)
      ? (game && num_(game.Week) !== null ? 'week ' + num_(game.Week) : 'a game') +
        (game ? ' ' + (s_(game.HomeTeamID) === teamId
                        ? 'vs ' + (s_(game.AwayTeamName) || teamNameOf_(s_(game.AwayTeamID)))
                        : 'at ' + (s_(game.HomeTeamName) || teamNameOf_(s_(game.HomeTeamID)))) : '')
      : seasonId + ' season total';

    const onFile = (c.OldValue === '' || c.OldValue === null || c.OldValue === undefined)
      ? '(blank — not reported)' : String(c.OldValue);
    const asked = (c.NewValue === '' || c.NewValue === null || c.NewValue === undefined)
      ? '(blank — not reported)' : String(c.NewValue);

    const lines = [];
    lines.push(playerName + ' of ' + teamName + ' says a number on UCBACstats.com is wrong.');
    lines.push('Nothing has changed yet. One click below settles it.');
    lines.push('');
    lines.push('Player:   ' + playerName);
    lines.push('School:   ' + teamName);
    lines.push('Stat:     ' + corrFieldLong_(c.Field));
    lines.push('Where:    ' + where);
    lines.push('On file:  ' + onFile);
    lines.push('He says:  ' + asked);
    if (s_(c.Reason)) {
      lines.push('');
      lines.push('In his words:');
      lines.push('  "' + s_(c.Reason) + '"');
    }

    const base = corrBaseUrl_();
    if (base) {
      lines.push('');
      lines.push('APPROVE — change the number to ' + asked + ':');
      lines.push('  ' + corrLink_(base, correctionId, 'approve'));
      lines.push('');
      lines.push('REJECT — leave the number as it is:');
      lines.push('  ' + corrLink_(base, correctionId, 'reject'));
      lines.push('');
      lines.push('Either link works once, from any device, with no sign-in.');
      if (!accounts.length) {
        lines.push('');
        lines.push('You do not have a UCBAC Stats account yet. With one you can enter box ');
        lines.push('scores, upload a stats file, manage your roster and see every request ');
        lines.push('your players file, instead of waiting for an email like this one:');
        lines.push('  ' + base.split('?')[0] + '?page=portal&view=signup');
      } else {
        lines.push('');
        lines.push('Or open the portal: ' + base.split('?')[0] + '?page=portal');
      }
    } else {
      lines.push('');
      lines.push('Review it in the portal under Approvals.');
    }
    lines.push('');
    lines.push('Not your player, or not something you should be deciding? Ignore this ');
    lines.push('message and reply to ' + ACCT.OWNER + '.');

    const subject = 'Stat correction to approve: ' + playerName + ' (' + teamName + ')';
    if (opts.dry) {
      return correctionId + ': would mail ' + to.join(', ') +
             (accounts.length ? '  [coach account]'
                              : '  [no account — head coach ' + ((head && head.name) || '?') + ']');
    }
    profileQueueNotifications_(to, CORRMAIL.KIND, subject, lines.join('\n'),
                              CORRMAIL.ENTITY, correctionId, teamId);
    return correctionId + ': mailed ' + to.join(', ') +
           (accounts.length ? '  [coach account]'
                            : '  [no account — head coach ' + ((head && head.name) || '?') +
                              ', invited to create one]');
  } catch (e) {
    Logger.log('corrNotifyCoaches ' + correctionId + ': ' + (e && e.stack ? e.stack : e));
    return s_(correctionId) + ': could not be mailed (' + (e && e.message) + ')';
  }
}

/**
 * Every PENDING correction nobody has been mailed about yet.
 * Run from the menu after this shipped, to catch up the ones already filed.
 */
function corrSendPending_(apply) {
  const out = [];
  out.push(apply ? 'SENDING' : 'DRY RUN — nothing will be mailed');
  out.push('');

  const base = corrBaseUrl_();
  if (!base) {
    out.push('The published web address is not known, so a decision link cannot be built.');
    out.push('It is normally recovered from an email this site has already sent, and');
    out.push('there are none on the Notifications tab. Load any page of the site once');
    out.push('and run this again.');
    const m0 = out.join('\n');
    Logger.log(m0);
    try { SpreadsheetApp.getUi().alert('Stat correction emails', m0, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
    return m0;
  }
  out.push('Links will point at ' + base);
  out.push('');

  if (!hasTab_(CONFIG.TABS.CORRECTIONS)) {
    out.push('No ' + CONFIG.TABS.CORRECTIONS + ' tab — nothing to send.');
    const m1 = out.join('\n');
    Logger.log(m1);
    return m1;
  }

  const pending = rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
    return profileCorrectionStatus_(r) === 'PENDING';
  });
  const todo = pending.filter(function (r) { return !corrAlreadyNotified_(s_(r.CorrectionID)); });

  out.push('Pending corrections: ' + pending.length +
           '   already mailed: ' + (pending.length - todo.length) +
           '   to send: ' + todo.length);
  out.push('');
  if (!todo.length) {
    out.push('Nothing to do.');
  } else {
    todo.forEach(function (r) {
      out.push('  ' + corrNotifyCoaches_(s_(r.CorrectionID), { dry: !apply }));
    });
    out.push('');
    out.push(apply
      ? 'Queued. The delivery trigger sends within a few minutes.'
      : 'Nothing was sent. Run "Email pending stat corrections (SEND)" to send them.');
  }
  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Stat correction emails', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function menuCorrectionMailDry()   { return corrSendPending_(false); }
function menuCorrectionMailApply() { return corrSendPending_(true); }

/* ── seeding the addresses ─────────────────────────────────────────────── */

/**
 * Fill the Coaches tab's Email column for head coaches who have none, from
 * the conference contact list.
 *
 * An address already on the tab is never overwritten: somebody put it there,
 * and the list in this file is older than they are. A school with no HEAD row
 * at all is reported rather than invented.
 */
function corrSeedHeadCoachEmails_(apply) {
  const out = [];
  out.push(apply ? 'APPLYING' : 'DRY RUN — nothing will be written');
  out.push('');

  if (!hasTab_('Coaches')) {
    out.push('No Coaches tab. Run UCBAC Stats > Coaches > Seed coach profiles first.');
    const m0 = out.join('\n');
    Logger.log(m0);
    try { SpreadsheetApp.getUi().alert('Head coach emails', m0, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
    return m0;
  }

  const rows = rowsOf_('Coaches');
  const updates = [], skipped = [], missing = [];

  CORRMAIL.HEAD_CONTACTS.forEach(function (contact) {
    const teamName = teamNameOf_(contact.teamId) || contact.teamId;
    const mine = rows.filter(function (c) { return s_(c.TeamID) === contact.teamId; });
    const head = mine.filter(function (c) { return s_(c.CoachType).toUpperCase() === 'HEAD'; })[0];
    if (!head) {
      missing.push('  ' + teamName + ': no head-coach row on the Coaches tab — ' +
                   'run Seed coach profiles, then this again' +
                   (contact.note ? '  (' + contact.note + ')' : ''));
      return;
    }
    const have = String(head.Email || '').trim();
    if (have) {
      skipped.push('  ' + teamName + ': keeping ' + have +
                   (have.toLowerCase() === contact.email.toLowerCase() ? '' :
                    '  (the list says ' + contact.email + ')'));
      return;
    }
    updates.push({ row: head.__row, teamName: teamName, name: s_(head.DisplayName),
                   email: contact.email, note: contact.note || '' });
  });

  out.push('To fill: ' + updates.length + '   already on file: ' + skipped.length +
           '   no head-coach row: ' + missing.length);
  out.push('');
  updates.forEach(function (u) {
    out.push('  ' + u.teamName + ': ' + (u.name || '(unnamed)') + ' -> ' + u.email +
             (u.note ? '\n      NOTE: ' + u.note : ''));
  });
  if (skipped.length) { out.push(''); out.push('Left alone:'); skipped.forEach(function (x) { out.push(x); }); }
  if (missing.length) { out.push(''); out.push('No row to fill:'); missing.forEach(function (x) { out.push(x); }); }

  if (apply && updates.length) {
    updateCells_('Coaches', updates.map(function (u) {
      return { row: u.row, field: 'Email', value: u.email };
    }));
    out.push('');
    out.push('Written. These addresses now receive stat-correction emails for their');
    out.push('school, and account requests from their own players, exactly as a coach');
    out.push('with an account does.');
  } else if (!apply) {
    out.push('');
    out.push('Nothing was written. Run "Head coach emails (APPLY)" to fill them.');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Head coach emails', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function menuSeedCoachEmailsDry()   { return corrSeedHeadCoachEmails_(false); }
function menuSeedCoachEmailsApply() { return corrSeedHeadCoachEmails_(true); }
