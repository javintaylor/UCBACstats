/**
 * UCBAC Stats - Traffic.gs
 *
 * Who came, what they looked at, and what they did — and a note about it every
 * morning.
 *
 * TWO HALVES.
 *
 * The first is a page counter, because until now there was none. The site is
 * one page that repaints itself, so the server hears from a visitor once when
 * they arrive and never again however far they wander; every hash change was
 * invisible. The page now says where it went, and a row is written for it.
 *
 * The second reads that tab and every other tab that carries a timestamp —
 * questions asked, accounts requested, sign-ins, corrections filed, clips
 * uploaded, box scores entered — and mails one summary of yesterday.
 *
 * WHAT IS NOT HERE, and cannot be. Apps Script hands doGet no address and no
 * user agent, and the page runs inside Google's frame, so there is no IP, no
 * country, and a referrer that usually names the frame rather than whoever
 * linked in. What there is: a browser's own courtesy id — the same anonymous
 * one Blitz counts, which names nobody — a route, an hour, and a window width.
 * That is enough to say how many people came, what they read and when, and
 * nothing at all about who they are.
 *
 * Rows go after 90 days, the same as the question log.
 */

const TRAFFIC = {
  TAB: 'VisitLog',
  DAYS: 90,
  TO: 'contact@example.invalid',
  TO_PROP: 'TRAFFIC_DIGEST_TO',   // an address to send elsewhere, or "off"
  HOUR: 5,                        // 5 am, in the conference's own timezone
  /* One row a view, not one a repaint. A route the same browser has just been
     counted for is ignored for this long — back, forward and a re-render are
     one visit to a page, and a reader who genuinely returns after a minute is
     a second view. */
  DEDUPE_SECONDS: 60,
  ROUTE_MAX: 80,
  REF_MAX: 100,
  /* Mail is shared with sign-in codes. The digest is one message a day and
     must never be the one that empties the tin. */
  QUOTA_FLOOR: 5,
  COLUMNS: ['Timestamp', 'Day', 'Hour', 'Visitor', 'Page', 'Route', 'Ref', 'Width', 'New']
};

/** yyyy-mm-dd in the conference's own timezone. */
function trDay_(d) {
  return Utilities.formatDate(d || new Date(), trTz_(), 'yyyy-MM-dd');
}
function trTz_() { return Session.getScriptTimeZone() || 'America/New_York'; }

/** The day a cell belongs to, whatever shape the cell is in. '' if unreadable. */
function trDayOf_(v) {
  if (v instanceof Date) return trDay_(v);
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? '' : trDay_(new Date(t));
}

/**
 * The calendar day a Day cell names.
 *
 * apiHit() writes Day as 'yyyy-MM-dd', and Sheets turns that into a date at
 * midnight in the SPREADSHEET's zone the moment it lands. Read back it is a
 * Date, and String() of a Date is "Thu Sep 10 2026 …", which is never equal
 * to the day it was written as — so every count keyed on the Day column came
 * out at nought while the tab filled up. Formatted in the sheet's own zone it
 * is the day written, whatever zone the script runs in; a cell that stayed
 * text is read as it is.
 */
function trCalDay_(v) {
  if (v instanceof Date) {
    var tz = '';
    try { tz = (typeof apiSheetTz_ === 'function') ? apiSheetTz_() : db_().getSpreadsheetTimeZone(); }
    catch (e) { tz = ''; }
    return Utilities.formatDate(v, tz || trTz_(), 'yyyy-MM-dd');
  }
  const t = String(v || '').trim();
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : trDayOf_(t);
}

/** yyyy-mm-dd, n days back from today. */
function trDayBack_(n) {
  return trDay_(new Date(new Date().getTime() - (n || 0) * 86400000));
}

// ── the counter ─────────────────────────────────────────────────────────────

/**
 * One view. Called by the page as it paints, and never waited on: a counter
 * that cannot write must not be able to hold up a page, so everything in here
 * is wrapped and the caller is told nothing it has to act on.
 */
function apiHit_(page, route, visitorId, ref, width, isNew) {
  try {
    const who = String(visitorId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'anon';
    const rt = String(route || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, TRAFFIC.ROUTE_MAX);
    const cache = CacheService.getScriptCache();
    const key = 'hit-' + who + '-' + rt;
    if (cache.get(key)) return false;             // the same page again, seconds later
    cache.put(key, '1', TRAFFIC.DEDUPE_SECONDS);

    const now = new Date();
    trEnsureTab_();
    appendRows_(TRAFFIC.TAB, [{
      Timestamp: now,
      Day: trDay_(now),
      Hour: Number(Utilities.formatDate(now, trTz_(), 'H')),
      Visitor: who,
      Page: String(page || 'site').replace(/[^a-z]/gi, '').toLowerCase().slice(0, 12) || 'site',
      Route: rt,
      Ref: trRefHost_(ref),
      Width: Math.max(0, Math.min(9999, Math.round(Number(width) || 0))),
      New: isNew ? 1 : 0
    }]);
    trTrimDaily_();
    return true;
  } catch (e) {
    Logger.log('apiHit: ' + (e && e.message ? e.message : e));
    return false;
  }
}

/**
 * A referrer is only ever kept as its host.
 *
 * The path of the page somebody came from can carry their search terms and
 * sometimes their name; the host answers the only question worth asking, which
 * is whether they arrived from a search, a post or a link on a school's site.
 * Google's own frame refers every visit to itself, so that one is dropped
 * rather than counted as traffic from nowhere.
 */
function trRefHost_(ref) {
  const r = String(ref || '').trim();
  if (!r) return '';
  const m = r.match(/^https?:\/\/([^/?#]+)/i);
  const host = m ? m[1].toLowerCase().replace(/^www\./, '') : '';
  if (!host) return '';
  if (/googleusercontent\.com$|^script\.google\.com$/.test(host)) return '';  // our own frame
  return host.slice(0, TRAFFIC.REF_MAX);
}

function trEnsureTab_() {
  if (hasTab_(TRAFFIC.TAB)) return;
  const sh = db_().insertSheet(TRAFFIC.TAB);
  sh.getRange(1, 1, 1, TRAFFIC.COLUMNS.length).setValues([TRAFFIC.COLUMNS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  __tabMap = null;
  delete __tableCache[TRAFFIC.TAB];
}

/** Sweep once a day, not once a view. */
function trTrimDaily_() {
  const cache = CacheService.getScriptCache();
  const key = 'trtrim-' + trDay_();
  if (cache.get(key)) return;
  cache.put(key, '1', 21600);
  try { trTrim_(); } catch (e) { Logger.log('trTrim: ' + e); }
}

/**
 * Drop rows past the cut-off.
 *
 * Views arrive in time order, so the expired ones are a block at the top and
 * go in a single call. A busy season is thousands of rows; deleting those one
 * at a time is thousands of round trips and a trim that runs out of its six
 * minutes. Anything out of order after the block — a row whose date was typed
 * in by hand, say — is handled the slow way, because there will never be many.
 */
function trTrim_() {
  if (!hasTab_(TRAFFIC.TAB)) return 0;
  const sh = getTab_(TRAFFIC.TAB);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  const col = data[0].map(String).indexOf('Timestamp');
  if (col < 0) return 0;
  const cutoff = new Date().getTime() - TRAFFIC.DAYS * 86400000;
  const old = function (v) {
    const ms = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
    return !isNaN(ms) && ms < cutoff;
  };

  var lead = 0;                                   // rows 2..(lead+1) are all expired
  while (lead + 1 < data.length && old(data[lead + 1][col])) lead++;

  const rest = [];
  for (var r = lead + 1; r < data.length; r++) if (old(data[r][col])) rest.push(r + 1);

  if (lead) sh.deleteRows(2, lead);
  rest.map(function (n) { return n - lead; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (n) { sh.deleteRow(n); });

  const n = lead + rest.length;
  if (n) delete __tableCache[TRAFFIC.TAB];
  return n;
}

// ── reading a day back ──────────────────────────────────────────────────────

/**
 * A tab named by another file's constant, with the name it has today as the
 * fallback. Traffic.gs reads half the project; it must not be the file that
 * stops working because it was pasted in before one of the others.
 */
function trTabOf_(constName, fallback) {
  /* Named one by one rather than looked up: a `const` in another file is not a
     property of anything this function could index, and reaching it by name
     would mean eval. Three lines of plain reference is the cheaper price. */
  try {
    if (constName === 'ACCT' && typeof ACCT !== 'undefined' && ACCT.TAB) return ACCT.TAB;
    if (constName === 'AUTH' && typeof AUTH !== 'undefined' && AUTH.TAB) return AUTH.TAB;
    if (constName === 'PLAYS' && typeof PLAYS !== 'undefined' && PLAYS.TAB) return PLAYS.TAB;
  } catch (e) {}
  return fallback;
}

/** Rows of a tab whose date column falls on `day`. */
function trOnDay_(tab, field, day) {
  if (!hasTab_(tab)) return [];
  return rowsOf_(tab).filter(function (r) { return trDayOf_(r[field]) === day; });
}
function trCountOnDay_(tab, field, day) { return trOnDay_(tab, field, day).length; }

/** A day of visits, counted every way the digest needs. */
function trVisitDay_(day, rows) {
  const mine = (rows || (hasTab_(TRAFFIC.TAB) ? rowsOf_(TRAFFIC.TAB) : []))
    .filter(function (r) { return trCalDay_(r.Day) === day; });
  const people = {}, routes = {}, refs = {}, hours = [];
  var fresh = 0, phone = 0, desk = 0;
  for (var h = 0; h < 24; h++) hours.push(0);
  mine.forEach(function (r) {
    const who = s_(r.Visitor);
    if (!people[who]) people[who] = 0;
    people[who]++;
    const rt = s_(r.Route) || '/';
    routes[rt] = (routes[rt] || 0) + 1;
    const ref = s_(r.Ref);
    if (ref) refs[ref] = (refs[ref] || 0) + 1;
    const hr = Number(r.Hour);
    if (hr >= 0 && hr < 24) hours[hr]++;
    if (Number(r.New)) fresh++;
    const w = Number(r.Width) || 0;
    if (w && w < 700) phone++; else if (w) desk++;
  });
  return { views: mine.length, people: Object.keys(people).length, fresh: fresh,
           routes: routes, refs: refs, hours: hours, phone: phone, desk: desk,
           perPerson: Object.keys(people).length
             ? Math.round(mine.length / Object.keys(people).length * 10) / 10 : 0 };
}

/** Everything the digest says about one day. */
function trGather_(day) {
  const visits = hasTab_(TRAFFIC.TAB) ? rowsOf_(TRAFFIC.TAB) : [];
  const v = trVisitDay_(day, visits);

  /* A week to compare against — yesterday alone says nothing about whether
     yesterday was good. */
  const week = [];
  for (var i = 1; i <= 7; i++) {
    const d = trDay_(new Date(Date.parse(day + 'T12:00:00Z') - i * 86400000));
    week.push({ day: d, v: trVisitDay_(d, visits) });
  }
  const past = week.filter(function (w) { return w.v.views > 0; });
  const avg = past.length
    ? Math.round(past.reduce(function (a, w) { return a + w.v.views; }, 0) / past.length) : 0;

  /* A card writes a ChatLog row too, so that tab is questions AND cards. They
     must be counted apart: three cards made from one answer are not four
     questions, and "SHARE CARD: who led in rushing" is not a thing anybody
     asked — it would otherwise turn up in the list of questions quoted in the
     morning note, looking like a reader who types in capitals. */
  const chatAll = (typeof CHAT !== 'undefined' && hasTab_(CHAT.LOG_TAB))
    ? rowsOf_(CHAT.LOG_TAB).filter(function (r) { return trCalDay_(r.Day) === day; }) : [];
  const chat = chatAll.filter(function (r) { return !/^CARD/.test(s_(r.Outcome)); });
  const asked = chat.map(function (r) { return s_(r.Question); }).filter(function (q) { return q; });
  const chatPeople = {};
  chat.forEach(function (r) { chatPeople[s_(r.Visitor)] = 1; });

  const T = CONFIG.TABS;
  const audit = trOnDay_(T.AUDIT, 'Timestamp', day);
  const actions = {};
  audit.forEach(function (a) { const k = s_(a.Action) || 'OTHER'; actions[k] = (actions[k] || 0) + 1; });

  return {
    day: day,
    visits: v,
    week: week,
    avg: avg,
    yday: week.length ? week[0].v : null,
    chat: {
      n: chat.length,
      people: Object.keys(chatPeople).length,
      refused: chat.filter(function (r) { return /^(REFUSED|FAILED)$/i.test(s_(r.Outcome)); }).length,
      capped: chat.filter(function (r) { return /^CAPPED/i.test(s_(r.Outcome)); }).length,
      /* Questions Google turned away rather than the site. Kept apart because
         the fix is a different one, and because a morning of these is the
         signal to go and look at the API allowance. */
      busy: chat.filter(function (r) { return /^BUSY/i.test(s_(r.Outcome)); })
                .map(function (r) { return s_(r.Outcome).toUpperCase(); }),
      /* What yesterday cost, and where the month stands against its budget.
         Summed off the log rather than read from the running total, so a lost
         or reset property cannot quietly make the morning number look good. */
      /* Cost counts EVERYTHING on the tab, cards included: a card is spending
         even though it is not a question, and the budget line must not
         quietly under-report. */
      cost: chatAll.reduce(function (a, r) { return a + (Number(r.Cost) || 0); }, 0),
      month: trMonthSpend_(day),
      asked: asked
    },
    cards: trCardDay_(day),
    /* The rest of the morning: accounts made and waiting, corrections filed,
       decided and waiting, lines a player entered that nobody has approved.
       This one message replaced a note per event - a hundred messages a day
       is the allowance, and sign-in codes come out of the same hundred - so
       everything that used to arrive on its own arrives here, with the links
       that settle it. Each part is guarded: a tab this cannot read must not
       cost the rest of the note. */
    accounts: trSafe_(function () { return trAccounts_(day); }, { made: [], pending: [], unlinked: [] }),
    corrections: trSafe_(function () { return trCorrections_(day); }, { filed: [], decided: [], pending: [] }),
    pendingLines: trSafe_(function () { return trPendingLines_(); }, 0),
    base: trSafe_(function () { return (typeof corrBaseUrl_ === 'function') ? String(corrBaseUrl_() || '') : ''; }, ''),
    people: {
      /* Named through the other files' own constants, so a tab that is ever
         renamed is renamed in one place and this keeps working. */
      accounts: trCountOnDay_(trTabOf_('ACCT', 'Accounts'), 'CreatedAt', day),
      approved: trCountOnDay_(trTabOf_('ACCT', 'Accounts'), 'ApprovedAt', day),
      signins: trCountOnDay_(trTabOf_('AUTH', 'Sessions'), 'CreatedAt', day),
      actions: actions
    },
    work: {
      corrections: trCountOnDay_(T.CORRECTIONS, 'CorrectedAt', day),
      submissions: trCountOnDay_(T.SUBMISSIONS, 'SubmittedAt', day),
      plays: trCountOnDay_(trTabOf_('PLAYS', 'PlaySubmissions'), 'Timestamp', day),
      exceptions: trCountOnDay_(T.EXCEPTIONS, 'Timestamp', day)
    }
  };
}

/** A part of the note that must not cost the rest of it. */
function trSafe_(fn, fallback) {
  try { return fn(); } catch (e) { Logger.log('traffic: ' + (e && e.message ? e.message : e)); return fallback; }
}

/** Accounts made yesterday, requests still waiting, and players nothing could link. */
function trAccounts_(day) {
  const out = { made: [], pending: [], unlinked: [] };
  const tab = trTabOf_('ACCT', 'Accounts');
  if (!hasTab_(tab)) return out;
  const nameOf = function (id) { return (typeof teamNameOf_ === 'function' && teamNameOf_(id)) || s_(id); };
  rowsOf_(tab).forEach(function (r) {
    const status = s_(r.Status).toUpperCase() || 'PENDING';
    const role = s_(r.Role).toUpperCase() || s_(r.RequestedRole).toUpperCase() || '?';
    const team = nameOf(s_(r.TeamID) || s_(r.RequestedTeamID));
    const name = s_(r.DisplayName) || s_(r.Email) || s_(r.AccountID);
    if (trDayOf_(r.CreatedAt) === day)
      out.made.push({ name: name, role: role, team: team, status: status.toLowerCase() });
    if (status === 'PENDING')
      out.pending.push({ id: s_(r.AccountID), name: name, role: role, team: team, since: trDayOf_(r.CreatedAt) });
    if (status === 'ACTIVE' && role === 'PLAYER' && !s_(r.PlayerID))
      out.unlinked.push({ name: name, team: team });
  });
  return out;
}

/** Corrections filed yesterday, decided yesterday, and still waiting. */
function trCorrections_(day) {
  const out = { filed: [], decided: [], pending: [] };
  const tab = CONFIG.TABS.CORRECTIONS;
  if (!tab || !hasTab_(tab)) return out;
  const players = {};
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) { players[s_(p.PlayerID)] = s_(p.DisplayName); });
  const games = {};
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) { games[s_(g.GameID)] = g; });
  const nameOf = function (id) { return (typeof teamNameOf_ === 'function' && teamNameOf_(id)) || s_(id); };
  const longOf = function (f) { return (typeof corrFieldLong_ === 'function') ? corrFieldLong_(f) : s_(f); };
  const blankOr = function (v) { return (v === '' || v === null || v === undefined) ? 'blank' : String(v); };
  rowsOf_(tab).forEach(function (r) {
    const status = (typeof profileCorrectionStatus_ === 'function')
      ? profileCorrectionStatus_(r) : (s_(r.Status).toUpperCase() || 'PENDING');
    const teamId = s_(r.TeamID), g = games[s_(r.GameID)];
    var where = s_(r.SeasonID) + ' season total';
    if (g) {
      const home = s_(g.HomeTeamID) === teamId;
      where = (num_(g.Week) === null ? 'a game' : 'week ' + num_(g.Week)) + ' ' +
              (home ? 'vs ' + (s_(g.AwayTeamName) || nameOf(s_(g.AwayTeamID)))
                    : 'at ' + (s_(g.HomeTeamName) || nameOf(s_(g.HomeTeamID))));
    } else if (s_(r.GameID)) where = s_(r.GameID);
    const item = { id: s_(r.CorrectionID), player: players[s_(r.PlayerID)] || s_(r.PlayerID),
                   team: nameOf(teamId), field: longOf(r.Field), where: where,
                   was: blankOr(r.OldValue), says: blankOr(r.NewValue), reason: s_(r.Reason),
                   status: status, by: s_(r.ReviewedBy), since: trDayOf_(r.CorrectedAt) };
    if (trDayOf_(r.CorrectedAt) === day) out.filed.push(item);
    if (status !== 'PENDING' && trDayOf_(r.ReviewedAt) === day) out.decided.push(item);
    if (status === 'PENDING') out.pending.push(item);
  });
  return out;
}

/** Stat lines a player entered himself that nobody has approved or removed. */
function trPendingLines_() {
  const tab = CONFIG.TABS.PLAYER_STATS;
  if (!tab || !hasTab_(tab)) return 0;
  var n = 0;
  rowsOf_(tab).forEach(function (r) { if (s_(r.SourceType) === 'PLAYER_ENTRY') n++; });
  return n;
}

/** The links that settle an account request from the inbox, or nothing without an address. */
function trAccountLinks_(base, id) {
  if (!base || typeof acctLinkSig_ !== 'function') return null;
  const b = base.split('?')[0];
  return { approve: b + '?decide=approve&acc=' + id + '&sig=' + acctLinkSig_(id, 'approve'),
           reject:  b + '?decide=reject&acc='  + id + '&sig=' + acctLinkSig_(id, 'reject') };
}
function trCorrectionLinks_(base, id) {
  if (!base || typeof corrLink_ !== 'function') return null;
  return { approve: corrLink_(base, id, 'approve'), reject: corrLink_(base, id, 'reject') };
}

// ── the morning note ────────────────────────────────────────────────────────

function trTop_(map, n) {
  return Object.keys(map || {})
    .sort(function (a, b) { return map[b] - map[a] || (a < b ? -1 : 1); })
    .slice(0, n || 8)
    .map(function (k) { return { key: k, n: map[k] }; });
}

/** "up 14%" / "down 3%" / "level" against a number worth comparing to. */
function trMove_(now, then) {
  if (!then) return now ? 'first day with anything to compare' : '';
  const pct = Math.round((now - then) / then * 100);
  if (Math.abs(pct) < 5) return 'level with the ' + (then) + ' before';
  return (pct > 0 ? 'up ' : 'down ') + Math.abs(pct) + '%';
}

/**
 * Ids into names, once per run.
 *
 * "Team page (TEAM-006)" is a row key; "Elkton" is the thing somebody actually
 * wants to know was read 9 times. The names are the ones already on the public
 * pages, so nothing reaches the summary that a visitor could not see anyway.
 */
var __trNames = null;
function trNames_() {
  if (__trNames) return __trNames;
  const m = {};
  const T = CONFIG.TABS;
  try {
    rowsOf_(T.TEAMS).forEach(function (t) {
      const id = s_(t.TeamID);
      if (id) m[id] = s_(t.DisplayName) || s_(t.SchoolName) || id;
    });
  } catch (e) {}
  try {
    rowsOf_(T.PLAYERS).forEach(function (p) {
      const id = s_(p.PlayerID);
      if (!id) return;
      const n = s_(p.DisplayName) || (s_(p.FirstName) + ' ' + s_(p.LastName)).trim();
      if (n) m[id] = n;
    });
  } catch (e) {}
  __trNames = m;
  return m;
}

/** A route as a reader would name it. */
function trRouteName_(rt) {
  const r = s_(rt).replace(/^#\/?/, '');
  if (!r) return 'Home';
  const parts = r.split('/');
  const name = {
    home: 'Home', scores: 'Scores', teams: 'Teams', team: 'Team', player: 'Player',
    game: 'Game', standings: 'Standings', leaders: 'Leaders', stats: 'Statistics',
    allconference: 'All-Conference', ask: (typeof CHAT !== 'undefined' ? CHAT.NAME : 'Blitz'),
    plays: 'Submit Top Plays', coach: 'Coach', portal: 'Profile',
    dashboard: 'Profile · dashboard', profile: 'Profile · details', share: 'Profile · share'
  }[parts[0]] || parts[0];
  if (parts.length < 2) return name;
  const id = parts.slice(1).join('/');
  const known = trNames_()[id];
  return known ? known + ' · ' + name.toLowerCase() : name + ' (' + id + ')';
}

/** The hours of the day, as a row of blocks somebody can read at a glance. */
function trHourBar_(hours) {
  const max = Math.max.apply(null, hours.concat([1]));
  const blocks = ['·', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return hours.map(function (n) {
    return blocks[Math.min(8, Math.round(n / max * 8))];
  }).join('');
}

/**
 * The report, in text and in HTML. Both say the same thing; the text one is
 * what lands in a mail client that will not draw the other, and it is also
 * what the sheet menu shows.
 */
function trafficReport_(day) {
  day = s_(day) || trDayBack_(1);
  const g = trGather_(day);
  const v = g.visits, L = [], H = [];
  const pretty = Utilities.formatDate(new Date(Date.parse(day + 'T12:00:00Z')), trTz_(), 'EEEE d MMMM');

  const head = v.views
    ? v.views + ' page views from ' + v.people + ' ' + (v.people === 1 ? 'person' : 'people')
    : 'Nobody visited';
  L.push('UCBAC Stats — ' + pretty);
  L.push(head + (v.views ? ' · ' + trMove_(v.views, g.avg) + ' against the last week' : ''));
  if (v.fresh) L.push(v.fresh + ' of them had never been here before.');
  if (v.views) L.push(v.perPerson + ' pages each.');

  H.push('<div style="font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
         'color:#16202b;max-width:640px;margin:0 auto;padding:8px">');
  H.push('<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;' +
         'color:#6b7c8f">UCBAC Stats</div>');
  H.push('<h1 style="margin:2px 0 14px;font-size:22px">' + trEsc_(pretty) + '</h1>');
  H.push('<div style="background:#f4f7fa;border-radius:12px;padding:16px 18px;margin-bottom:18px">');
  H.push('<div style="font-size:30px;font-weight:700;line-height:1.1">' +
         v.views + '<span style="font-size:15px;font-weight:400;color:#6b7c8f"> page views</span></div>');
  H.push('<div style="color:#42546a;margin-top:4px">' + v.people + ' ' +
         (v.people === 1 ? 'person' : 'people') +
         (v.fresh ? ', ' + v.fresh + ' here for the first time' : '') +
         (v.views ? ' · ' + trEsc_(trMove_(v.views, g.avg)) + ' against the last week' : '') + '</div>');
  H.push('</div>');

  // ── waiting for a decision: the queue, with the links that settle each one
  const acct = g.accounts || { made: [], pending: [], unlinked: [] };
  const corr = g.corrections || { filed: [], decided: [], pending: [] };
  const base = g.base || '';
  const portal = base ? base.split('?')[0] + '?page=portal' : '';
  const linkPair = function (links) {
    return links ? '  approve: ' + links.approve + '\n' + '  reject:  ' + links.reject : '';
  };
  const linkPairH = function (links) {
    return links ? ' <a href="' + trEsc_(links.approve) + '" style="color:#1d6f3a;font-weight:600">Approve</a> · ' +
                   '<a href="' + trEsc_(links.reject) + '" style="color:#9b2c2c;font-weight:600">Reject</a>' : '';
  };
  const waiting = acct.pending.length + corr.pending.length + acct.unlinked.length + (g.pendingLines || 0);
  if (waiting) {
    L.push('');
    L.push('WAITING FOR YOU');
    H.push(trH2_('Waiting for you'));
    H.push('<ul style="margin:6px 0 0;padding-left:18px;color:#42546a">');
    acct.pending.forEach(function (a) {
      const links = trAccountLinks_(base, a.id);
      L.push('  Account request: ' + a.name + ' - ' + a.role + ', ' + a.team + (a.since ? ' - since ' + a.since : ''));
      if (links) L.push(linkPair(links));
      H.push('<li style="margin:3px 0"><b>Account request:</b> ' + trEsc_(a.name) + ' — ' + trEsc_(a.role.toLowerCase()) +
             ', ' + trEsc_(a.team) + (a.since ? ' <span style="color:#8494a6">since ' + trEsc_(a.since) + '</span>' : '') +
             linkPairH(links) + '</li>');
    });
    corr.pending.forEach(function (c) {
      const links = trCorrectionLinks_(base, c.id);
      L.push('  Correction: ' + c.player + ' (' + c.team + ') - ' + c.field + ', ' + c.where + ': ' + c.was + ' -> ' + c.says +
             (c.reason ? '  "' + c.reason.slice(0, 120) + '"' : ''));
      if (links) L.push(linkPair(links));
      H.push('<li style="margin:3px 0"><b>Correction:</b> ' + trEsc_(c.player) + ' (' + trEsc_(c.team) + ') — ' +
             trEsc_(c.field) + ', ' + trEsc_(c.where) + ': ' + trEsc_(c.was) + ' → <b>' + trEsc_(c.says) + '</b>' +
             (c.reason ? '<br><span style="color:#6b7c8f">“' + trEsc_(c.reason.slice(0, 160)) + '”</span>' : '') +
             linkPairH(links) + '</li>');
    });
    if (acct.unlinked.length) {
      const names = acct.unlinked.map(function (u) { return u.name + ' (' + u.team + ')'; }).join(', ');
      L.push('  ' + acct.unlinked.length + ' player account' + trS_(acct.unlinked.length) + ' to link to a roster record: ' + names);
      H.push('<li style="margin:3px 0"><b>To link to a roster record:</b> ' + trEsc_(names) + '</li>');
    }
    if (g.pendingLines) {
      L.push('  ' + g.pendingLines + ' stat line' + trS_(g.pendingLines) + ' entered by players await approval' +
             (portal ? ' - ' + portal : ' (portal > Approvals)'));
      H.push('<li style="margin:3px 0"><b>' + g.pendingLines + ' stat line' + trS_(g.pendingLines) +
             '</b> entered by players await approval' + (portal ? ' — <a href="' + trEsc_(portal) + '">Approvals</a>' : '') + '</li>');
    }
    H.push('</ul>');
  }

  // ── yesterday's accounts and corrections
  if (acct.made.length || corr.filed.length || corr.decided.length) {
    L.push('');
    L.push('YESTERDAY');
    H.push(trH2_('Yesterday'));
    H.push('<ul style="margin:6px 0 0;padding-left:18px;color:#42546a">');
    acct.made.forEach(function (a) {
      L.push('  New account: ' + a.name + ' - ' + a.role + ', ' + a.team + ' - ' + a.status);
      H.push('<li style="margin:2px 0">New account: ' + trEsc_(a.name) + ' — ' + trEsc_(a.role.toLowerCase()) + ', ' +
             trEsc_(a.team) + ' — ' + trEsc_(a.status) + '</li>');
    });
    corr.filed.forEach(function (c) {
      L.push('  Correction filed: ' + c.player + ' (' + c.team + ') - ' + c.field + ', ' + c.where + ': ' + c.was + ' -> ' + c.says);
      H.push('<li style="margin:2px 0">Correction filed: ' + trEsc_(c.player) + ' (' + trEsc_(c.team) + ') — ' +
             trEsc_(c.field) + ', ' + trEsc_(c.where) + ': ' + trEsc_(c.was) + ' → ' + trEsc_(c.says) + '</li>');
    });
    corr.decided.forEach(function (c) {
      L.push('  Correction ' + c.status.toLowerCase() + (c.by ? ' by ' + c.by : '') + ': ' + c.player + ' (' + c.team + ') - ' + c.field + ', ' + c.where);
      H.push('<li style="margin:2px 0">Correction <b>' + trEsc_(c.status.toLowerCase()) + '</b>' + (c.by ? ' by ' + trEsc_(c.by) : '') +
             ': ' + trEsc_(c.player) + ' (' + trEsc_(c.team) + ') — ' + trEsc_(c.field) + ', ' + trEsc_(c.where) + '</li>');
    });
    H.push('</ul>');
  }

  // ── the week behind it
  if (g.week.length) {
    L.push('');
    L.push('THE WEEK');
    g.week.slice().reverse().forEach(function (w) {
      L.push('  ' + w.day + '  ' + w.v.views + ' views · ' + w.v.people + ' people');
    });
    L.push('  ' + day + '  ' + v.views + ' views · ' + v.people + ' people   <- yesterday');
    H.push(trH2_('The week'));
    H.push('<table style="border-collapse:collapse;width:100%;font-size:14px">');
    g.week.slice().reverse().concat([{ day: day, v: v, now: true }]).forEach(function (w) {
      const wide = Math.round(w.v.views / Math.max(1, Math.max.apply(null,
        g.week.map(function (x) { return x.v.views; }).concat([v.views, 1]))) * 100);
      H.push('<tr>' +
        '<td style="padding:3px 8px 3px 0;color:' + (w.now ? '#16202b' : '#6b7c8f') +
        ';white-space:nowrap' + (w.now ? ';font-weight:600' : '') + '">' + trEsc_(w.day) + '</td>' +
        '<td style="width:100%;padding:3px 0"><span style="display:inline-block;height:9px;' +
        'border-radius:5px;background:' + (w.now ? '#2d4ea8' : '#c3d0e0') + ';width:' +
        Math.max(2, wide) + '%"></span></td>' +
        '<td style="padding:3px 0 3px 10px;text-align:right;white-space:nowrap' +
        (w.now ? ';font-weight:600' : '') + '">' + w.v.views + '</td></tr>');
    });
    H.push('</table>');
  }

  // ── what they read
  const routes = trTop_(v.routes, 8);
  if (routes.length) {
    L.push('');
    L.push('WHAT THEY READ');
    routes.forEach(function (r) { L.push('  ' + r.n + '  ' + trRouteName_(r.key)); });
    H.push(trH2_('What they read'));
    H.push(trRows_(routes.map(function (r) { return [trRouteName_(r.key), String(r.n)]; })));
  }

  // ── when, and on what
  if (v.views) {
    L.push('');
    L.push('WHEN  ' + trHourBar_(v.hours) + '   (midnight to midnight)');
    var busiest = 0;
    v.hours.forEach(function (n, i) { if (n > v.hours[busiest]) busiest = i; });
    L.push('  busiest around ' + trHour12_(busiest));
    if (v.phone || v.desk) {
      L.push('  ' + Math.round(v.phone / (v.phone + v.desk) * 100) + '% on a phone');
    }
    H.push(trH2_('When'));
    H.push(trHourChart_(v.hours));
    H.push('<div style="color:#6b7c8f;font-size:13px;margin-top:2px">midnight to midnight · ' +
           'busiest around ' + trEsc_(trHour12_(busiest)) +
           ((v.phone || v.desk) ? ' · ' + Math.round(v.phone / (v.phone + v.desk) * 100) +
                                  '% on a phone' : '') + '</div>');
  }

  // ── where from, when there is anything to say
  const refs = trTop_(v.refs, 5);
  if (refs.length) {
    L.push('');
    L.push('CAME FROM');
    refs.forEach(function (r) { L.push('  ' + r.n + '  ' + r.key); });
    H.push(trH2_('Came from'));
    H.push(trRows_(refs.map(function (r) { return [r.key, String(r.n)]; })));
  }

  // ── Blitz
  const c = g.chat;
  if (c.n) {
    L.push('');
    L.push((typeof CHAT !== 'undefined' ? CHAT.NAME : 'Blitz').toUpperCase());
    L.push('  ' + c.n + ' question' + trS_(c.n) + ' from ' + c.people + ' ' + (c.people === 1 ? 'person' : 'people') +
           (c.refused ? ' · ' + c.refused + ' not answered' : '') +
           (c.capped ? ' · ' + c.capped + ' turned away at the cap' : ''));
    const cardsL = trCardLine_(g.cards);
    if (cardsL) L.push('  ' + cardsL);
    const spend = trSpendLine_(c.month, c.cost);
    if (spend) L.push('  ' + spend);
    if (c.busy.length) L.push('  ' + trBusyLine_(c.busy));
    // every question, in full: this is the one place they are read now
    c.asked.forEach(function (q) { L.push('    "' + q.slice(0, 300) + '"'); });
    H.push(trH2_(typeof CHAT !== 'undefined' ? CHAT.NAME : 'Blitz'));
    H.push('<div style="color:#42546a">' + c.n + ' question' + trS_(c.n) + ' from ' + c.people + ' ' +
           (c.people === 1 ? 'person' : 'people') +
           (c.refused ? ' · <b>' + c.refused + '</b> not answered' : '') +
           (c.capped ? ' · ' + c.capped + ' turned away at the cap' : '') + '</div>');
    const cardsH = trCardLine_(g.cards);
    if (cardsH) {
      H.push('<div style="margin-top:8px;background:#eef4ff;border-radius:10px;padding:10px 14px;' +
             'color:#26417a">' + trEsc_(cardsH) + '</div>');
    }
    const spendH = trSpendLine_(c.month, c.cost);
    if (spendH) {
      /* Amber once the pace runs past the budget: the one line here that is
         ever a call to act rather than a thing to note. */
      const over = /OVER the budget/.test(spendH);
      H.push('<div style="margin-top:8px;border-radius:10px;padding:10px 14px;background:' +
             (over ? '#fff4e5;color:#7a4b00' : '#f4f7fa;color:#42546a') + '">' +
             trEsc_(spendH) + '</div>');
    }
    if (c.busy.length) {
      H.push('<div style="margin-top:8px;background:#fff4e5;border-radius:10px;padding:12px 14px;' +
             'color:#7a4b00">' + trEsc_(trBusyLine_(c.busy)) + '</div>');
    }
    if (c.asked.length) {
      H.push('<ul style="margin:8px 0 0;padding-left:18px;color:#42546a">');
      c.asked.forEach(function (q) {
        H.push('<li style="margin:2px 0">' + trEsc_(q.slice(0, 300)) + '</li>');
      });
      H.push('</ul>');
    }
  }

  // ── people and work
  const p = g.people, w = g.work;
  const bits = [];
  if (p.accounts) bits.push([p.accounts + ' new account request' + trS_(p.accounts), '']);
  if (p.approved) bits.push([p.approved + ' account' + trS_(p.approved) + ' approved', '']);
  if (p.signins) bits.push([p.signins + ' sign-in' + trS_(p.signins), '']);
  if (w.corrections) bits.push([w.corrections + ' stat correction' + trS_(w.corrections) + ' filed', '']);
  if (w.plays) bits.push([w.plays + ' Top Play' + trS_(w.plays) + ' uploaded', '']);
  if (w.submissions) bits.push([w.submissions + ' box score' + trS_(w.submissions) + ' submitted', '']);
  Object.keys(p.actions).sort().forEach(function (k) {
    if (/^ACCOUNT_/.test(k)) return;                 // counted above, in words
    bits.push([p.actions[k] + ' × ' + k.toLowerCase().replace(/_/g, ' '), '']);
  });
  if (bits.length) {
    L.push('');
    L.push('WHAT HAPPENED');
    bits.forEach(function (b) { L.push('  ' + b[0]); });
    H.push(trH2_('What happened'));
    H.push('<ul style="margin:6px 0 0;padding-left:18px;color:#42546a">');
    bits.forEach(function (b) { H.push('<li style="margin:2px 0">' + trEsc_(b[0]) + '</li>'); });
    H.push('</ul>');
  }

  if (w.exceptions) {
    L.push('');
    L.push('WORTH A LOOK: ' + w.exceptions + ' exception' + trS_(w.exceptions) +
           ' logged. UCBAC Stats > Maintenance > Show exception summary.');
    H.push('<div style="margin-top:16px;background:#fff4e5;border-radius:10px;padding:12px 14px;' +
           'color:#7a4b00">' + w.exceptions + ' exception' + trS_(w.exceptions) + ' logged yesterday. ' +
           'UCBAC Stats &gt; Maintenance &gt; Show exception summary.</div>');
  }

  const foot = 'Counted from the page itself: an anonymous browser id, a route and an hour. ' +
               'No names, no addresses. Rows go after ' + TRAFFIC.DAYS + ' days.';
  L.push('');
  L.push(foot);
  H.push('<div style="margin-top:22px;padding-top:12px;border-top:1px solid #e3e9f0;' +
         'color:#8494a6;font-size:12px">' + trEsc_(foot) + '<br>To stop these: ' +
         'UCBAC Stats &gt; Maintenance &gt; Morning traffic email on/off.</div>');
  H.push('</div>');

  return {
    day: day,
    subject: 'UCBAC Stats — ' + pretty + ': ' + (v.views ? v.views + ' views, ' + v.people +
             (v.people === 1 ? ' person' : ' people') : 'a quiet day'),
    body: L.join('\n'),
    htmlBody: H.join(''),
    views: v.views,
    people: v.people
  };
}

/**
 * The same twenty-four hours, drawn.
 *
 * A table rather than flexbox: mail clients are a decade behind a browser and
 * a row of cells is the one layout every one of them gets right.
 */
function trHourChart_(hours) {
  const max = Math.max.apply(null, hours.concat([1]));
  const out = ['<table style="border-collapse:collapse;width:100%;table-layout:fixed">',
               '<tr style="vertical-align:bottom">'];
  hours.forEach(function (n) {
    const h = Math.max(2, Math.round(n / max * 46));
    out.push('<td style="padding:0 1px;height:48px;vertical-align:bottom">' +
             '<div style="height:' + h + 'px;border-radius:2px;background:' +
             (n ? '#2d4ea8' : '#e3e9f0') + '"></div></td>');
  });
  out.push('</tr><tr>');
  hours.forEach(function (n, i) {
    out.push('<td style="padding:2px 0 0;text-align:center;font-size:9px;color:#8494a6">' +
             (i % 6 === 0 ? trHour12_(i).replace('midnight', '12a').replace('noon', '12p') : '') +
             '</td>');
  });
  out.push('</tr></table>');
  return out.join('');
}

/**
 * Questions Google refused, said so the reader knows what to do about it.
 *
 * A day's allowance running out and Google having a bad afternoon both end as
 * an unanswered question, and only one of them is worth getting up for.
 */
/**
 * Cards made yesterday, and the ones somebody actually posted.
 *
 * Two numbers, not one: a card offered and shut away is a reader looking, and
 * a card posted is the site travelling. Only the second is marketing, and only
 * the second put the site's name in front of strangers.
 */
function trCardDay_(day) {
  if (typeof CHAT === 'undefined' || !CHAT.CARD_TAB || !hasTab_(CHAT.CARD_TAB)) return null;
  const mine = rowsOf_(CHAT.CARD_TAB).filter(function (r) { return trCalDay_(r.Day) === day; });
  if (!mine.length) return null;
  const how = {}, people = {};
  var posted = 0;
  mine.forEach(function (r) {
    people[s_(r.Visitor)] = 1;
    const h = s_(r.How);
    if (h) { posted++; how[h] = (how[h] || 0) + 1; }
  });
  return { made: mine.length, posted: posted, people: Object.keys(people).length, how: how };
}

/** "3 posted — 2 to the share sheet, 1 copied". */
function trCardLine_(c) {
  if (!c) return '';
  const words = { share: 'straight to a phone\'s share sheet', copy: 'copied',
                  download: 'downloaded', caption: 'caption only' };
  const bits = Object.keys(c.how).sort(function (a, b) { return c.how[b] - c.how[a]; })
    .map(function (k) { return c.how[k] + ' ' + (words[k] || k); });
  return c.made + ' share card' + trS_(c.made) + ' made by ' + c.people + ' ' +
         (c.people === 1 ? 'person' : 'people') +
         (c.posted ? ' · ' + c.posted + ' posted (' + bits.join(', ') + ')'
                   : ' · none posted — made and looked at, not shared');
}

/** This calendar month's spend, from every logged question that falls in it. */
function trMonthSpend_(day) {
  if (typeof CHAT === 'undefined' || !hasTab_(CHAT.LOG_TAB)) return null;
  const month = s_(day).slice(0, 7);
  var spent = 0;
  rowsOf_(CHAT.LOG_TAB).forEach(function (r) {
    if (trCalDay_(r.Day).slice(0, 7) === month) spent += Number(r.Cost) || 0;
  });
  const budget = Number(CHAT.BUDGET_MONTH) || 0;
  return { month: month, spent: spent, budget: budget, today: s_(day),
           pct: budget ? Math.round(spent / budget * 100) : 0 };
}

/**
 * The month's spending, said the way somebody deciding whether to worry needs
 * it: how much, how far through the budget, and — the part a running total
 * never tells you — where this pace lands by the end of the month.
 */
function trSpendLine_(m, dayCost) {
  if (!m || !m.budget) return '';
  const parts = [trMoney_(m.spent) + ' of ' + trMoney_(m.budget) + ' this month (' + m.pct + '%)'];
  if (dayCost > 0) parts.push(trMoney_(dayCost) + ' yesterday');
  /* Where the month lands if the rest of it looks like the days so far. The
     figure that turns "9% used" into "and it is the 2nd". */
  const dayOfMonth = Number(String(m.today || '').slice(-2)) || 0;
  if (dayOfMonth > 2 && m.spent > 0) {
    const days = trDaysInMonth_(m.month);
    const pace = m.spent / dayOfMonth * days;
    parts.push('on track for about ' + trMoney_(pace) +
               (pace > m.budget ? ' — OVER the budget' : ''));
  }
  return parts.join(' · ');
}

function trDaysInMonth_(ym) {
  const y = Number(String(ym).slice(0, 4)), mo = Number(String(ym).slice(5, 7));
  if (!y || !mo) return 30;
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function trMoney_(v) {
  const n = Number(v) || 0;
  return '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
}

function trBusyLine_(kinds) {
  const n = kinds.length;
  const day = kinds.filter(function (k) { return k === 'BUSY_RATE_DAY'; }).length;
  const min = kinds.filter(function (k) { return k === 'BUSY_RATE_MINUTE' || k === 'BUSY_RATE'; }).length;
  const cap = kinds.filter(function (k) { return k === 'BUSY_CAPACITY'; }).length;
  const head = n + ' question' + trS_(n) + ' got no answer because Google said no';
  if (day) return head + ' — ' + day + ' of them after the day\'s free API allowance ran out. ' +
                  'That is the one worth acting on: a paid key, or fewer questions a day.';
  if (min) return head + ' — the free tier\'s per-minute limit, which clears itself. ' +
                  'Worth watching if it keeps happening at the same hour.';
  if (cap) return head + ' — Google\'s own capacity, nothing to do with the site. Weather, not a bill.';
  return head + '.';
}

function trS_(n) { return n === 1 ? '' : 's'; }
function trH2_(t) {
  return '<h2 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b7c8f;' +
         'margin:22px 0 6px">' + trEsc_(t) + '</h2>';
}
function trRows_(pairs) {
  const out = ['<table style="border-collapse:collapse;width:100%;font-size:14px">'];
  pairs.forEach(function (p) {
    out.push('<tr><td style="padding:3px 0;color:#42546a">' + trEsc_(p[0]) + '</td>' +
             '<td style="padding:3px 0;text-align:right;font-weight:600;white-space:nowrap">' +
             trEsc_(p[1]) + '</td></tr>');
  });
  out.push('</table>');
  return out.join('');
}
function trHour12_(h) {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return (h % 12) + (h < 12 ? 'am' : 'pm');
}
function trEsc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

/** Where the digest goes, or '' if it is switched off. */
function trDigestTo_() {
  const v = s_(PropertiesService.getScriptProperties().getProperty(TRAFFIC.TO_PROP));
  if (/^(off|no|none|0|false)$/i.test(v)) return '';
  return v || TRAFFIC.TO;
}

/** 7 am. Never throws — a trigger that throws mails a stack trace instead. */
function trafficDigest() {
  try { return trafficDigestSend_(); }
  catch (e) {
    Logger.log('trafficDigest failed: ' + (e && e.stack ? e.stack : e));
    return 'failed: ' + (e && e.message ? e.message : e);
  }
}

function trafficDigestSend_(day) {
  const to = trDigestTo_();
  if (!to) return 'the morning email is switched off';
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  if (quota > -1 && quota < TRAFFIC.QUOTA_FLOOR) {
    const msg = 'skipped: only ' + quota + ' messages left today, and sign-in codes come first';
    Logger.log(msg);
    return msg;
  }
  const r = trafficReport_(day);
  MailApp.sendEmail({ to: to, subject: r.subject, body: r.body, htmlBody: r.htmlBody,
                      name: 'UCBAC Stats' });
  const msg = 'Sent to ' + to + ': ' + r.day + ', ' + r.views + ' views from ' + r.people + '.';
  Logger.log(msg);
  return msg;
}

/** Install the morning trigger. Idempotent: an existing one is replaced. */
function installTrafficDigest_() {
  removeTrafficDigest_();
  ScriptApp.newTrigger('trafficDigest').timeBased()
    .everyDays(1).atHour(TRAFFIC.HOUR).create();
  const msg = 'Installed: the traffic summary every morning around ' + TRAFFIC.HOUR + ':00 (' +
              trTz_() + '), to ' + trDigestTo_() + '.';
  Logger.log(msg);
  return msg;
}

function removeTrafficDigest_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['trafficDigest', 'trafficDigest_'].indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// ── the sheet menu ──────────────────────────────────────────────────────────

function menuInstallTrafficDigest() {
  SpreadsheetApp.getUi().alert('Morning traffic email', installTrafficDigest_(),
                               SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuTrafficNow() {
  SpreadsheetApp.getUi().alert('Morning traffic email', trafficDigestSend_(),
                               SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Yesterday's summary on screen, without sending anything. */
function menuTrafficReport() {
  const r = trafficReport_();
  Logger.log(r.body);
  try {
    SpreadsheetApp.getUi().alert('Traffic — ' + r.day,
      r.body.length > 6000 ? r.body.slice(0, 6000) + '\n\n…full report in View > Logs' : r.body,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return r.body;
}

function menuTrafficOnOff() {
  const props_ = PropertiesService.getScriptProperties();
  const on = !!trDigestTo_();
  const ui = SpreadsheetApp.getUi();
  const msg = on
    ? 'The morning summary goes to ' + trDigestTo_() + ' around ' + TRAFFIC.HOUR + ':00.\n\nTurn it off?'
    : 'The morning summary is off.\n\nTurn it on? It goes to ' + TRAFFIC.TO + '.';
  if (ui.alert('Morning traffic email', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  if (on) props_.setProperty(TRAFFIC.TO_PROP, 'off');
  else props_.deleteProperty(TRAFFIC.TO_PROP);
  ui.alert('Morning traffic email',
           'The morning summary is now ' + (on ? 'OFF' : 'ON') + '.' +
           (on ? '' : '\n\nIf it has never been installed, run "Install the morning traffic email" too.'),
           ui.ButtonSet.OK);
}
