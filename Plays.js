/**
 * UCBAC Stats — Plays.gs
 *
 * Top 10 Plays of the Week: anyone can send a clip from the site, and it
 * lands in the Drive folder for the week it belongs to.
 *
 * The shape of it, and why:
 *
 *   WHICH WEEK is decided here, never by the visitor. Each game week has a
 *   window on the clock: it opens the Friday of that week at OPEN_HM and
 *   closes the Sunday after at CLOSE_HM - Friday 9:30 PM to Sunday 11:59 AM -
 *   and a Thursday or Saturday game belongs to the same Friday. Between
 *   windows nothing is accepted, and the site counts down to the next one.
 *   Playoff rounds follow the same rule off the Games tab. On Saturday you
 *   are submitting for Friday's game; nobody has to know what week it is.
 *
 *   THE FOLDERS stay in this file. They are shared "anyone with the link can
 *   edit", which is what lets the site drop files into them, and is also why
 *   no visitor is ever handed a folder link: anyone who had one could open
 *   the folder and delete every other clip in it. The visitor sees a week
 *   name. The server knows where that goes.
 *
 *   THE BYTES go straight from the browser to Google. A phone clip is easily
 *   a few hundred megabytes, far past what can travel through this script,
 *   and re-encoding it to squeeze through would throw away the quality that
 *   is the whole reason for taking uploads here instead of on Instagram. So
 *   the server opens a Drive "resumable upload" session under its own
 *   credentials and hands the browser that one-time session address; the
 *   browser sends the file to it in chunks. The session address can receive
 *   exactly one file into one place and expires - it reveals nothing and
 *   permits nothing else. If the browser cannot reach Google directly, the
 *   chunks come through here instead, slower but whole.
 *
 * Nothing about the person submitting is collected. A clip is the team, the
 * player it features - first name, last name, position, graduation year, so
 * the Top 10 can credit him - an optional line about the play, and the file.
 * New uploads record confirmation that the clip is from a varsity game,
 * not JV, and that the play was not overturned due to a penalty. Each
 * acknowledgment is recorded with the server time it was received.
 * The page thanks them on the spot, and invites them to make a player
 * account; no mail goes to them.
 *
 * The owner hears about clips once a week: a Sunday-morning digest of
 * everything in so far, by week, with each week's folder - not a message
 * per clip. playsDigest() runs on a trigger installPlaysDigest() sets up.
 */

const PLAYS = {
  FOLDERS: {
    W1: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W2: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W3: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W4: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W5: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W6: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W7: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W8: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    W9: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    P1: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    P2: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    P3: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    P4: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    P5: 'CONFIGURE_PRIVATE_RESOURCE_ID'
  },
  LABELS: {
    P1: 'Playoffs Round 1', P2: 'Playoffs Round 2', P3: 'Playoffs Round 3 (Regional)',
    P4: 'Playoffs Round 4 (Semifinal)', P5: 'Playoffs Round 5 (State Championship)'
  },
  // the window, on the clock, in the script's timezone: opens the Friday of
  // the game week at OPEN_HM, closes CLOSE_AFTER_DAYS later at CLOSE_HM
  OPEN_HM: '21:30',
  CLOSE_HM: '11:59',
  CLOSE_AFTER_DAYS: 2,
  /* A window held open past its usual close, by key: 'yyyy-MM-dd HH:mm' in
     the script's timezone. The page's clock, its "Closes ..." line and the
     server's own gate all read the same moment from here, so an extension
     is one line and cannot disagree with itself. Remove the line once the
     window has passed; a stale one changes nothing, since that week is
     over either way. */
  CLOSE_OVERRIDES: {
    W4: '2026-09-29 12:00'               // week 4 of 2026: open until Tuesday noon
  },
  // One-off schedule changes are scoped to both season and week. The same
  // window drives the public countdown and the upload server's acceptance gate.
  WINDOW_OVERRIDES: {
    'SEA-2026': {
      W5: { open: '2026-10-01 21:30', close: '2026-10-04 11:59' }
    }
  },
  MAX_BYTES: 2 * 1024 * 1024 * 1024,     // 2 GB - Drive's own comfort zone
  CHUNK: 8 * 1024 * 1024,                // browser -> Google, multiple of 256 KiB
  RELAY_CHUNK: 4 * 1024 * 1024,          // browser -> here -> Google, base64 in a call
  EXT: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'hevc'],
  PER_DAY: 10,                           // clips per visitor
  SITE_PER_DAY: 400,
  TICKET_SECS: 6 * 3600,                 // how long an upload may take
  TAB: 'PlaySubmissions',
  COLUMNS: ['Timestamp', 'WeekKey', 'Week', 'Team', 'FirstName', 'LastName', 'Position',
            'GradYear', 'Description', 'FileName', 'Bytes', 'FileID', 'Status',
            // one submission may carry two files (two angles of the same play)
            // and credit two players (the QB and the receiver on a touchdown)
            'SubmissionID', 'Angle', 'FirstName2', 'LastName2', 'Position2', 'GradYear2',
            'PlayResultConfirmed', 'PlayResultConfirmedAt', 'VarsityConfirmed', 'VarsityConfirmedAt'],
  NAME_MAX: 40,
  DESC_MAX: 120,
  UPLOAD_HOST: 'https://www.googleapis.com/upload/drive/v3/files',
  DRIVE_FILES: 'https://www.googleapis.com/drive/v3/files',
  // how long a folder's count is believed before Drive is asked again, and
  // how long the last answer is kept for a moment when Drive cannot be asked
  COUNT_SECS: 300,
  COUNT_KEEP_SECS: 21600,
  // The weekly digest goes here. This is the one place folder links are
  // written out, and it goes to the folders' owner, never a visitor.
  NOTIFY: 'contact@example.invalid',
  DIGEST_SUBJECT: 'Top Play Submissions',
  DIGEST_HOUR: 5,                        // Sunday, 5 am, in the script's timezone
  // the season, for the digest: from the first window's opening day until
  // this many days after the last game on the schedule
  SEASON_GRACE_DAYS: 9
};

/** The positions a clip can be filed under: the site's own list, flattened. */
function playsPositions_() {
  const out = [];
  POSITIONS.forEach(function (p) {
    out.push({ code: p.code, label: p.label });
    (p.subs || []).forEach(function (x) { out.push({ code: x.code, label: x.label }); });
  });
  return out;
}

/** Graduation years of players on a current roster: the four classes. */
function playsGradYears_() {
  const m = String(CONFIG.CURRENT_SEASON || '').match(/(\d{4})/);
  const y = m ? Number(m[1]) : new Date().getFullYear();
  return [y + 1, y + 2, y + 3, y + 4];
}

/** A person's name as typed, tidied; '' if it is not a name at all. */
function playsName_(v) {
  /* A phone keyboard types the curly apostrophe (’) and a curly dash, not the
     straight ones a keyboard on a desk does, and a name is the same name
     either way. Ke’Mar was being refused as "not a name" on the strength of
     one character; his teammates with plain names were not. Fold the curly
     forms to straight before the test, so the stored name is one shape. */
  const t = String(v === null || v === undefined ? '' : v)
    .replace(/[‘’ʼʻ`´]/g, "'")
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ').trim();
  if (!t || t.length > PLAYS.NAME_MAX) return '';
  // letters of any alphabet, plus the punctuation names carry: O'Neal, Smith-Jones, J.
  return /^[\p{L}][\p{L}\p{M}' .-]*$/u.test(t) ? t : '';
}

/**
 * The optional second player - the quarterback on a touchdown pass. Either
 * all four fields or none: a half-named player is a mistake, not a choice.
 * Returns null (none given), { first, last, pos, grad } or { error }.
 */
function playsSecond_(meta) {
  const raw = [meta.first2, meta.last2, meta.pos2, meta.grad2].map(function (v) { return s_(v); });
  if (!raw.some(Boolean)) return null;
  const first = playsName_(meta.first2), last = playsName_(meta.last2);
  if (!first) return { error: 'Enter the second player\'s first name.' };
  if (!last) return { error: 'Enter the second player\'s last name.' };
  const pos = s_(meta.pos2).toUpperCase();
  if (!playsPositions_().some(function (p) { return p.code === pos; }))
    return { error: 'Pick the second player\'s position.' };
  const grad = num_(meta.grad2);
  if (playsGradYears_().indexOf(grad) < 0) return { error: 'Pick the second player\'s graduation year.' };
  return { first: first, last: last, pos: pos, grad: grad };
}

/**
 * How many clips a window holds: the video files in its Drive folder,
 * counted there and nowhere else. The log tab records what was sent, but
 * the same clip sent twice is logged twice, and a duplicate the owner
 * deletes from the folder stays logged - so a count from the tab could be
 * inflated by anyone with a phone. The folder is the truth, and the folder
 * is asked. Cached briefly; refreshed the moment a clip lands (`fresh`).
 */
function playsCount_(key, fresh) {
  const folderId = PLAYS.FOLDERS[key];
  if (!folderId) return 0;
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('playsc-' + key);
    if (hit !== null && hit !== undefined) return Number(hit) || 0;
  }
  var n = playsFolderCount_(folderId);
  if (n === null) {
    // Drive could not be asked: the last answer, or failing that, the log
    const last = cache.get('playscl-' + key);
    return (last !== null && last !== undefined) ? (Number(last) || 0) : playsLoggedCount_(key);
  }
  cache.put('playsc-' + key, String(n), PLAYS.COUNT_SECS);
  cache.put('playscl-' + key, String(n), PLAYS.COUNT_KEEP_SECS);
  return n;
}

/** The video files in a folder, page by page; null when Drive did not answer. */
function playsFolderCount_(folderId) {
  var n = 0, token = '';
  try {
    do {
      const q = "'" + folderId + "' in parents and trashed = false";
      const url = PLAYS.DRIVE_FILES + '?q=' + encodeURIComponent(q) +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType)') +
        '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true' +
        (token ? '&pageToken=' + encodeURIComponent(token) : '');
      const res = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) {
        Logger.log('plays: folder listing ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
        return null;
      }
      const body = JSON.parse(res.getContentText());
      (body.files || []).forEach(function (f) { if (playsIsClip_(f)) n++; });
      token = s_(body.nextPageToken);
    } while (token);
  } catch (e) {
    Logger.log('plays: folder listing failed: ' + (e && e.message ? e.message : e));
    return null;
  }
  return n;
}

/** A video, by type or by name; never a folder or a stray document. */
function playsIsClip_(f) {
  const mime = s_(f && f.mimeType).toLowerCase();
  if (mime === 'application/vnd.google-apps.folder') return false;
  return mime.indexOf('video/') === 0 || PLAYS.EXT.indexOf(playsExt_(f && f.name)) >= 0;
}

/** Submissions logged for a window - the tab's count, for when Drive cannot be asked. */
function playsLoggedCount_(key) {
  if (!hasTab_(PLAYS.TAB)) return 0;
  return rowsOf_(PLAYS.TAB).filter(function (r) {
    return s_(r.WeekKey) === key && s_(r.Status) === 'RECEIVED' && (num_(r.Angle) || 1) === 1;
  }).length;
}

function playsTz_() { return Session.getScriptTimeZone() || 'America/New_York'; }

/** A Date or a date string -> 'yyyy-MM-dd' in the conference's timezone. */
function playsDay_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, playsTz_(), 'yyyy-MM-dd');
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** The Friday of the Monday-to-Sunday week a calendar day falls in. */
function playsFridayOf_(day) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();   // 0 Sunday .. 6 Saturday
  return playsDayPlus_(day, dow === 0 ? -2 : 5 - dow);
}

/** A calendar day and a clock time, in the conference's timezone, as a moment in ms. */
function playsAt_(day, hm) {
  return Utilities.parseDate(day + ' ' + hm, playsTz_(), 'yyyy-MM-dd HH:mm').getTime();
}

/** Now, in ms. A function so a test can set the clock. */
function playsNow_() { return Date.now(); }

/** A moment in words: "Sunday 11:59 AM" (short) or "Friday, September 11 at 9:30 PM". */
function playsWhen_(ms, short) {
  const d = new Date(ms);
  return short ? Utilities.formatDate(d, playsTz_(), 'EEEE h:mm a')
               : Utilities.formatDate(d, playsTz_(), 'EEEE, MMMM d') + ' at ' + Utilities.formatDate(d, playsTz_(), 'h:mm a');
}

/**
 * Every submission window the schedule defines, in order: W1..W9 from the
 * regular season, P1.. from playoff rounds once those games are on the
 * Games tab. Each belongs to the day of its first game; on the clock it
 * opens the Friday of that week at OPEN_HM and closes the Sunday after at
 * CLOSE_HM (openAt/closeAt, in ms).
 */
function playsWindows_() {
  const opens = {};
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (s_(g.SeasonID) !== CONFIG.CURRENT_SEASON) return;
    const day = playsDay_(g.GameDate);
    const n = num_(g.Week);
    if (!day || !n) return;
    const phase = s_(g.Phase).toLowerCase();
    const key = (phase === 'round' || phase.indexOf('play') >= 0 ? 'P' : 'W') + n;
    if (!PLAYS.FOLDERS[key]) return;
    if (!opens[key] || day < opens[key]) opens[key] = day;
  });
  return Object.keys(opens).map(function (k) {
    const friday = playsFridayOf_(opens[k]);
    // a window held open longer than usual (PLAYS.CLOSE_OVERRIDES) closes then instead
    const held = String((PLAYS.CLOSE_OVERRIDES || {})[k] || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    const special = ((PLAYS.WINDOW_OVERRIDES || {})[CONFIG.CURRENT_SEASON] || {})[k];
    const specialOpen = special && String(special.open).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    const specialClose = special && String(special.close).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (special && (!specialOpen || !specialClose)) throw new Error('Invalid submission window override: ' + k);
    return { key: k, label: PLAYS.LABELS[k] || ('Week ' + k.slice(1)), opens: opens[k], friday: friday,
             openAt: specialOpen ? playsAt_(specialOpen[1], specialOpen[2]) : playsAt_(friday, PLAYS.OPEN_HM),
             closeAt: specialClose ? playsAt_(specialClose[1], specialClose[2]) : held ? playsAt_(held[1], held[2])
                           : playsAt_(playsDayPlus_(friday, PLAYS.CLOSE_AFTER_DAYS), PLAYS.CLOSE_HM),
             extended: !!held };
  }).sort(function (a, b) { return a.opens < b.opens ? -1 : a.opens > b.opens ? 1 : 0; });
}

/**
 * The window a given DAY belongs to: the latest one whose game week has
 * begun. The digest reads the week this way; the clock below decides
 * whether clips are being taken.
 */
function playsCurrent_(today) {
  today = today || playsDay_(new Date());
  const all = playsWindows_();
  var cur = null, next = null;
  all.forEach(function (w) {
    if (w.opens <= today) cur = w;
    else if (!next) next = w;
  });
  return { current: cur, next: next };
}

/**
 * Where the clock stands: the window open this moment, or else the last
 * one that closed and the next one to open.
 */
function playsState_(now) {
  now = now || playsNow_();
  var open = null, last = null, next = null;
  playsWindows_().forEach(function (w) {
    if (w.openAt <= now && now < w.closeAt) open = w;
    else if (w.closeAt <= now) last = w;
    else if (w.openAt > now && !next) next = w;
  });
  return { open: open, last: last, next: next };
}

/** Public: what the upload page needs to say. No folder, ever. */
function apiPlaysInfo_(weekKey) {
  const teams = rowsOf_(CONFIG.TABS.TEAMS).map(function (t) {
    return { id: s_(t.TeamID), name: s_(t.DisplayName) };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  const now = playsNow_();
  const st = playsState_(now);
  // what a closed page says: the week just closed and its count, the next
  // window and when it opens - the site counts down to it
  const closed = function (last, next, message) {
    return { open: false, teams: teams, message: message,
             lastKey: last ? last.key : '', lastLabel: last ? last.label : '',
             lastCount: last ? playsCount_(last.key) : 0,
             nextKey: next ? next.key : '', nextLabel: next ? next.label : '',
             opensAt: next ? next.openAt : 0, opensText: next ? playsWhen_(next.openAt, true) : '' };
  };

  weekKey = s_(weekKey).toUpperCase();
  var w = null;
  if (weekKey) {
    w = playsWindows_().filter(function (x) { return x.key === weekKey; })[0] || null;
    if (!w) return { open: false, error: 'There is no submission window called ' + weekKey + '.', teams: teams };
    if (now < w.openAt)
      return closed(st.last, w, w.label + ' submissions open ' + playsWhen_(w.openAt) + '.');
    if (now >= w.closeAt)
      return closed(w, st.next, w.label + ' submissions closed ' + playsWhen_(w.closeAt) + '.' +
                    (st.next ? ' ' + st.next.label + ' opens ' + playsWhen_(st.next.openAt) + '.' : ''));
  } else {
    w = st.open;
    if (!w) {
      return closed(st.last, st.next,
        st.next ? (st.last ? st.last.label + ' submissions closed ' + playsWhen_(st.last.closeAt) + '. ' : '') +
                  st.next.label + ' submissions open ' + playsWhen_(st.next.openAt) + '.'
                : st.last ? 'Submissions are closed for the season.' : 'Submissions are not open yet.');
    }
  }
  return { open: true, key: w.key, label: w.label, opens: w.opens, teams: teams,
           count: playsCount_(w.key),
           closesAt: w.closeAt, closesText: playsWhen_(w.closeAt, true),
           positions: playsPositions_(), gradYears: playsGradYears_(),
           nameMax: PLAYS.NAME_MAX, descMax: PLAYS.DESC_MAX,
           maxBytes: PLAYS.MAX_BYTES, chunk: PLAYS.CHUNK, relayChunk: PLAYS.RELAY_CHUNK,
           accept: 'video/*' };
}

/** Same courtesy-plus-backstop limits as the assistant. */
function playsSpend_(visitorId) {
  const cache = CacheService.getScriptCache();
  const day = playsDay_(new Date());
  const who = String(visitorId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'anon';
  const siteKey = 'playsn-' + day;
  const site = Number(cache.get(siteKey) || 0) + 1;
  cache.put(siteKey, String(site), 21600);
  if (site > PLAYS.SITE_PER_DAY) return 'The site has taken all the clips it can today. Try tomorrow.';
  const meKey = 'playsv-' + day + '-' + who;
  const mine = Number(cache.get(meKey) || 0) + 1;
  cache.put(meKey, String(mine), 21600);
  if (mine > PLAYS.PER_DAY) return 'That is ' + PLAYS.PER_DAY + ' clips today - the daily limit for one visitor.';
  return '';
}

function playsExt_(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * A file name that says what it is, safe for Drive and for a folder listing:
 *   Week 1 - Elkton - Jaylen Smith WR 2028 - 45-yard TD pass - 20260905-193012.mov
 */
function playsFileName_(label, teamName, player, desc, tag, ext) {
  const clean = function (v, n) {
    return String(v || '').replace(/[\\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  };
  const stamp = Utilities.formatDate(new Date(), playsTz_(), 'yyyyMMdd-HHmmss');
  return [clean(label, 40), clean(teamName, 40), clean(player, 160), clean(desc, 60) || 'play', clean(tag, 20), stamp]
    .filter(Boolean).join(' - ') + '.' + ext;
}

/**
 * Open a resumable upload session for one clip and hand back its address.
 *
 * `meta` includes { team, first, last, pos, grad, desc, name, size, type, origin,
 * playResultConfirmed, varsityConfirmed }. Both must be the boolean true.
 * The player fields are required - a Top 10 play is credited to someone -
 * and are checked here, not merely on the form. The origin is the browser's
 * own, sent so Google will accept the browser's chunks from it - it scopes
 * the session to that page and grants nothing else.
 */
function apiPlaysBegin_(meta, visitorId) {
  meta = meta || {};
  // Require an explicit acknowledgment before reading data, spending quota,
  // or creating an upload session. Truthy strings/numbers are not confirmation.
  if (meta.playResultConfirmed !== true)
    return { error: 'Confirm that the play counted and was not overturned due to a penalty. If this checkbox is missing, refresh the page.' };
  if (meta.varsityConfirmed !== true)
    return { error: 'Confirm this clip is from a varsity game. Junior varsity (JV) clips are not eligible. Refresh the page to see the updated acknowledgment.' };
  const size = num_(meta.size), ext = playsExt_(meta.name), type = s_(meta.type).toLowerCase();
  const teamId = s_(meta.team);
  const teamRow = rowsOf_(CONFIG.TABS.TEAMS).filter(function (t) { return s_(t.TeamID) === teamId; })[0];

  if (!teamRow) return { error: 'Pick the team the play belongs to.' };
  const first = playsName_(meta.first), last = playsName_(meta.last);
  if (!first) return { error: 'Enter the player\'s first name.' };
  if (!last) return { error: 'Enter the player\'s last name.' };
  const pos = s_(meta.pos).toUpperCase();
  if (!playsPositions_().some(function (p) { return p.code === pos; }))
    return { error: 'Pick the player\'s position.' };
  const grad = num_(meta.grad);
  if (playsGradYears_().indexOf(grad) < 0) return { error: 'Pick the player\'s graduation year.' };
  const second = playsSecond_(meta);
  if (second && second.error) return { error: second.error };
  const desc = s_(meta.desc).replace(/\s+/g, ' ').slice(0, PLAYS.DESC_MAX);
  /* A second angle is the same play again: it joins the first file's
     submission rather than opening one of its own. The id was handed out
     when the first file was confirmed; anything else is not a submission. */
  const angle = num_(meta.angle) === 2 ? 2 : 1;
  var sub = '';
  if (angle === 2) {
    sub = s_(meta.sub).replace(/[^a-z0-9]/gi, '').slice(0, 12);
    if (!sub) return { error: 'Send the first angle first.' };
  } else {
    sub = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  }
  if (!size || size <= 0) return { error: 'That file is empty.' };
  if (size > PLAYS.MAX_BYTES) return { error: 'That clip is over 2 GB. Trim it and try again.' };
  if (!(type.indexOf('video/') === 0 || PLAYS.EXT.indexOf(ext) >= 0))
    return { error: 'That does not look like a video. Send an MP4 or MOV.' };

  const win = s_(meta.week) ? playsWindows_().filter(function (x) { return x.key === s_(meta.week).toUpperCase(); })[0]
                           : playsCurrent_().current;
  if (!win) return { error: 'Submissions are not open yet.' };
  // the window is on the clock: nothing is taken before it opens or after it closes
  const now = playsNow_();
  if (win.openAt && now < win.openAt) return { error: win.label + ' submissions open ' + playsWhen_(win.openAt) + '.' };
  if (win.closeAt && now >= win.closeAt) return { error: win.label + ' submissions closed ' + playsWhen_(win.closeAt) + '.' };
  const folderId = PLAYS.FOLDERS[win.key];
  if (!folderId) return { error: 'No folder is set up for ' + win.label + ' yet.' };

  const stop = playsSpend_(visitorId);
  if (stop) return { error: stop };

  const player = first + ' ' + last + ' ' + pos + ' ' + grad +
    (second ? ' + ' + second.first + ' ' + second.last + ' ' + second.pos + ' ' + second.grad : '');
  const fileName = playsFileName_(win.label, teamRow.DisplayName, player, desc,
                                 angle === 2 ? 'angle 2' : '', ext || 'mp4');
  const headers = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    'X-Upload-Content-Type': type || 'video/mp4',
    'X-Upload-Content-Length': String(size)
  };
  const origin = s_(meta.origin);
  if (/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com$/i.test(origin) ||
      /^https:\/\/script\.google\.com$/i.test(origin)) headers.Origin = origin;

  const res = UrlFetchApp.fetch(PLAYS.UPLOAD_HOST + '?uploadType=resumable&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json; charset=UTF-8', headers: headers,
    payload: JSON.stringify({ name: fileName, parents: [folderId], mimeType: type || 'video/mp4' }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('plays: could not open a session: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
    return { error: 'The upload could not be started. Try again in a minute.' };
  }
  const h = res.getAllHeaders();
  const uploadUrl = s_(h.Location || h.location);
  if (uploadUrl.indexOf(PLAYS.UPLOAD_HOST) !== 0) {
    Logger.log('plays: unexpected session address ' + uploadUrl.slice(0, 80));
    return { error: 'The upload could not be started. Try again in a minute.' };
  }

  const ticket = Utilities.getUuid().replace(/-/g, '');
  const confirmedAt = new Date().toISOString();
  CacheService.getScriptCache().put('plays-' + ticket, JSON.stringify({
    url: uploadUrl, key: win.key, label: win.label, team: s_(teamRow.DisplayName),
    first: first, last: last, pos: pos, grad: grad, second: second,
    sub: sub, angle: angle,
    desc: desc, file: fileName, size: size,
    playResultConfirmed: true, playResultConfirmedAt: confirmedAt,
    varsityConfirmed: true, varsityConfirmedAt: confirmedAt
  }), PLAYS.TICKET_SECS);

  return { ok: true, ticket: ticket, uploadUrl: uploadUrl, fileName: fileName, sub: sub, angle: angle,
           label: win.label, chunk: PLAYS.CHUNK, relayChunk: PLAYS.RELAY_CHUNK };
}

function playsTicket_(ticket) {
  const raw = CacheService.getScriptCache().get('plays-' + String(ticket || '').replace(/[^a-f0-9]/g, ''));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * The fallback road: one chunk, base64, through here to Google. Slower, but
 * it needs nothing from the browser but a working google.script.run.
 */
function apiPlaysChunk_(ticket, start, total, base64) {
  const t = playsTicket_(ticket);
  if (!t) return { error: 'That upload has expired. Start it again.' };
  if (t.url.indexOf(PLAYS.UPLOAD_HOST) !== 0) return { error: 'Bad upload address.' };
  start = num_(start); total = num_(total);
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (start === null || total === null || !bytes.length) return { error: 'Empty chunk.' };
  if (total !== t.size) return { error: 'That is not the file this upload was opened for.' };
  const end = start + bytes.length - 1;
  const res = UrlFetchApp.fetch(t.url, {
    method: 'put',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
               'Content-Range': 'bytes ' + start + '-' + end + '/' + total },
    payload: Utilities.newBlob(bytes), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  // 308 = received, send the next one; 200/201 = that was the last one
  if (code === 308 || code === 200 || code === 201) return { ok: true, status: code, next: end + 1 };
  Logger.log('plays: chunk ' + start + ' -> ' + code + ' ' + res.getContentText().slice(0, 200));
  return { error: 'Google did not accept that piece. Try again.', status: code };
}

/**
 * Confirm the file arrived whole, then write the row. Asked of Google, not
 * taken from the browser: a "bytes * /N" query returns the finished file, or
 * 308 with how far it got.
 */
function apiPlaysDone_(ticket) {
  const t = playsTicket_(ticket);
  if (!t) return { error: 'That upload has expired. If the clip finished, it is in - otherwise start again.' };
  if (t.url.indexOf(PLAYS.UPLOAD_HOST) !== 0) return { error: 'Bad upload address.' };
  const res = UrlFetchApp.fetch(t.url, {
    method: 'put',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
               'Content-Range': 'bytes */' + t.size },
    payload: '', muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    return { error: code === 308 ? 'The clip did not finish uploading.' : 'The clip could not be confirmed.',
             status: code };
  }
  var fileId = '';
  try { fileId = s_(JSON.parse(res.getContentText()).id); } catch (e) {}

  playsEnsureTab_();
  const second = t.second || null;
  appendRows_(PLAYS.TAB, [{
    Timestamp: new Date(), WeekKey: t.key, Week: t.label, Team: t.team,
    FirstName: t.first, LastName: t.last, Position: t.pos, GradYear: t.grad,
    Description: t.desc, FileName: t.file, Bytes: t.size, FileID: fileId, Status: 'RECEIVED',
    SubmissionID: t.sub || '', Angle: t.angle || 1,
    FirstName2: second ? second.first : '', LastName2: second ? second.last : '',
    Position2: second ? second.pos : '', GradYear2: second ? second.grad : '',
    // Let pre-update sessions finish, without claiming they acknowledged it.
    PlayResultConfirmed: t.playResultConfirmed === true ? true : '',
    PlayResultConfirmedAt: t.playResultConfirmed === true ? (t.playResultConfirmedAt || '') : '',
    VarsityConfirmed: t.varsityConfirmed === true ? true : '',
    VarsityConfirmedAt: t.varsityConfirmed === true ? (t.varsityConfirmedAt || '') : ''
  }]);
  CacheService.getScriptCache().remove('plays-' + ticket);
  // the folder just grew: count it again now, so the page shows the truth
  return { ok: true, label: t.label, fileName: t.file, sub: t.sub || '', angle: t.angle || 1,
           count: playsCount_(t.key, true) };
}

function playsHtmlEsc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// ── the Sunday digest ──────────────────────────────────────────────────────

/** 'yyyy-MM-dd' plus n days, in the conference's calendar. */
function playsDayPlus_(day, n) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

/**
 * The season, for the digest's purposes: from the day the first window
 * opens until SEASON_GRACE_DAYS after the last game on the schedule - the
 * Sunday after the final, then quiet until next year's games are entered.
 */
function playsSeasonSpan_() {
  const wins = playsWindows_();
  if (!wins.length) return null;
  var last = '';
  rowsOf_(CONFIG.TABS.GAMES).forEach(function (g) {
    if (s_(g.SeasonID) !== CONFIG.CURRENT_SEASON) return;
    const day = playsDay_(g.GameDate);
    if (day && day > last) last = day;
  });
  return { first: wins[0].opens, last: playsDayPlus_(last || wins[wins.length - 1].opens, PLAYS.SEASON_GRACE_DAYS) };
}

function playsInSeason_(today) {
  today = today || playsDay_(new Date());
  const span = playsSeasonSpan_();
  return !!span && span.first <= today && today <= span.last;
}

/**
 * Everything received so far, by week: newest window first, each with its
 * count, its players and its folder. A second angle is the play it belongs
 * to, not another entry.
 */
function playsDigestWeeks_() {
  const rows = hasTab_(PLAYS.TAB) ? rowsOf_(PLAYS.TAB) : [];
  const byWeek = {};
  rows.forEach(function (r) {
    if (s_(r.Status) !== 'RECEIVED') return;
    const key = s_(r.WeekKey);
    if (!key) return;
    const w = byWeek[key] || (byWeek[key] = { key: key, label: s_(r.Week) || key, subs: {}, order: [] });
    const sid = s_(r.SubmissionID) || ('row' + (r.__row || w.order.length));
    if ((num_(r.Angle) || 1) === 2) {
      if (w.subs[sid]) w.subs[sid].angles++;
      return;
    }
    if (w.subs[sid]) return;
    w.order.push(sid);
    w.subs[sid] = {
      team: s_(r.Team),
      player: s_(r.FirstName) + ' ' + s_(r.LastName),
      pos: s_(r.Position), grad: s_(r.GradYear),
      second: s_(r.FirstName2) ? { player: s_(r.FirstName2) + ' ' + s_(r.LastName2), pos: s_(r.Position2), grad: s_(r.GradYear2) } : null,
      desc: s_(r.Description), angles: 1
    };
  });
  const opens = {};
  playsWindows_().forEach(function (w) { opens[w.key] = w.opens; });
  return Object.keys(byWeek).map(function (k) {
    const w = byWeek[k];
    return { key: k, label: w.label, opens: opens[k] || '',
             folder: PLAYS.FOLDERS[k] ? 'https://drive.google.com/drive/folders/' + PLAYS.FOLDERS[k] : '',
             // the count is the folder's, as on the site; the names are the log's
             files: playsCount_(k),
             clips: w.order.map(function (sid) { return w.subs[sid]; }) };
  }).sort(function (a, b) { return a.opens < b.opens ? 1 : a.opens > b.opens ? -1 : 0; });
}

/**
 * The digest, composed: the current week in full, earlier weeks beneath it,
 * every week with its count, its names and its folder. `today` is for tests.
 */
function playsDigestReport_(today) {
  today = today || playsDay_(new Date());
  const cur = playsCurrent_(today).current;
  const weeks = playsDigestWeeks_();
  const curWeek = cur ? (weeks.filter(function (w) { return w.key === cur.key; })[0] ||
                         { key: cur.key, label: cur.label, opens: cur.opens, clips: [], files: playsCount_(cur.key),
                           folder: PLAYS.FOLDERS[cur.key] ? 'https://drive.google.com/drive/folders/' + PLAYS.FOLDERS[cur.key] : '' })
                      : null;
  const all = (curWeek && weeks.indexOf(curWeek) < 0) ? weeks.concat([curWeek]) : weeks;
  const total = all.reduce(function (n, w) { return n + w.files; }, 0);
  const clipWord = function (n) { return n + (n === 1 ? ' clip' : ' clips'); };
  // the folder's count, and the log's beside it when they disagree - a
  // duplicate deleted from the folder, or a clip dropped in by hand
  const countOf = function (w) {
    return clipWord(w.files) + (w.files !== w.clips.length ? ' (' + w.clips.length + ' logged)' : '');
  };
  const credit = function (c) {
    return c.player + (c.pos ? ' (' + c.pos + (c.grad ? ' ’' + String(c.grad).slice(-2) : '') + ')' : '') +
      (c.second ? ' + ' + c.second.player + (c.second.pos ? ' (' + c.second.pos +
        (c.second.grad ? ' ’' + String(c.second.grad).slice(-2) : '') + ')' : '') : '');
  };
  const h = playsHtmlEsc_;
  const when = Utilities.formatDate(new Date(), playsTz_(), 'EEEE, MMMM d, yyyy');

  const subject = PLAYS.DIGEST_SUBJECT + (curWeek ? ' · ' + curWeek.label + ' · ' + clipWord(curWeek.files) : '') +
                  ' · ' + clipWord(total) + ' so far';
  const lines = [], html = [];
  html.push('<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111">');
  html.push('<p style="margin:0 0 4px;color:#777;font-size:13px">' + h(when) + '</p>');
  lines.push(when);

  const week = function (w, full) {
    lines.push('');
    lines.push(w.label.toUpperCase() + ' - ' + countOf(w) + (w.folder ? '  ' + w.folder : ''));
    html.push('<p style="margin:18px 0 6px;font-size:17px"><b>' + h(w.label) + '</b> · ' + h(countOf(w)) +
      (w.folder ? ' · <a href="' + h(w.folder) + '">Open the folder</a>' : '') + '</p>');
    if (!w.clips.length) {
      lines.push('  (none logged yet)');
      html.push('<p style="margin:0;color:#777">None logged yet.</p>');
      return;
    }
    html.push('<ol style="margin:0;padding-left:22px">');
    w.clips.forEach(function (c) {
      const line = credit(c) + ' - ' + c.team + (full && c.desc ? ' - ' + c.desc : '') + (c.angles > 1 ? ' (' + c.angles + ' angles)' : '');
      lines.push('  ' + line);
      html.push('<li style="margin:2px 0"><b>' + h(credit(c)) + '</b> · ' + h(c.team) +
        (full && c.desc ? ' · <span style="color:#555">' + h(c.desc) + '</span>' : '') +
        (c.angles > 1 ? ' <span style="color:#777">(' + c.angles + ' angles)</span>' : '') + '</li>');
    });
    html.push('</ol>');
  };

  if (curWeek) week(curWeek, true);
  const earlier = weeks.filter(function (w) { return !curWeek || w.key !== curWeek.key; });
  if (earlier.length) {
    lines.push('');
    lines.push('EARLIER - ' + clipWord(total - (curWeek ? curWeek.files : 0)));
    html.push('<p style="margin:22px 0 0;font:600 11px monospace;letter-spacing:.09em;color:#777">EARLIER</p>');
    earlier.forEach(function (w) { week(w, false); });
  }
  lines.push('');
  lines.push(clipWord(total) + ' so far this season.');
  html.push('<p style="margin:18px 0 0"><b>' + h(clipWord(total)) + '</b> so far this season.</p>');
  html.push('<p style="margin:16px 0 0;color:#777;font-size:13px">Sent every Sunday morning during the season by UCBAC Stats.</p>');
  html.push('</div>');
  return { subject: subject, body: lines.join('\n'), htmlBody: html.join(''), total: total,
           week: curWeek ? curWeek.label : '', count: curWeek ? curWeek.files : 0 };
}

/** Sunday, 5 am: the digest, in season only. Never throws - a trigger that throws mails a stack trace. */
function playsDigest() {
  try {
    if (!playsInSeason_()) return 'out of season - no digest';
    return playsDigestSend_();
  } catch (e) {
    Logger.log('playsDigest failed: ' + (e && e.message ? e.message : e));
    return 'failed: ' + (e && e.message ? e.message : e);
  }
}

/** The digest, now, season or not - the menu's "send it now". */
function playsDigestSend_() {
  const r = playsDigestReport_();
  if (!PLAYS.NOTIFY) return 'no NOTIFY address';
  MailApp.sendEmail({ to: PLAYS.NOTIFY, subject: r.subject, body: r.body, htmlBody: r.htmlBody, name: 'UCBAC Stats' });
  const msg = 'Digest sent to ' + PLAYS.NOTIFY + ': ' + (r.week ? r.week + ' ' + r.count + ', ' : '') + r.total + ' so far.';
  Logger.log(msg);
  return msg;
}

/** Install the Sunday trigger. Idempotent: an existing one is replaced. */
function installPlaysDigest_() {
  removePlaysDigest_();
  ScriptApp.newTrigger('playsDigest').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(PLAYS.DIGEST_HOUR).create();
  const msg = 'Installed: the Top Plays digest every Sunday at ' + PLAYS.DIGEST_HOUR + ':00 (' + playsTz_() +
              '), during the season, to ' + PLAYS.NOTIFY + '.';
  Logger.log(msg);
  return msg;
}

function removePlaysDigest_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['playsDigest', 'playsDigest_'].indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function menuInstallPlaysDigest() {
  SpreadsheetApp.getUi().alert('Top Plays digest', installPlaysDigest_(), SpreadsheetApp.getUi().ButtonSet.OK);
}
function menuPlaysDigestNow() {
  SpreadsheetApp.getUi().alert('Top Plays digest', playsDigestSend_(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function playsSize_(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

/**
 * The log tab, created on first use. If it already exists from an earlier
 * version with fewer columns, the missing ones are added at the end - old
 * rows keep their places, new rows get every column.
 */
function playsEnsureTab_() {
  var sh;
  if (hasTab_(PLAYS.TAB)) {
    sh = getTab_(PLAYS.TAB);
    const width = sh.getLastColumn();
    const have = width ? sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
    const missing = PLAYS.COLUMNS.filter(function (c) { return have.indexOf(c) < 0; });
    if (!missing.length) return;
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  } else {
    sh = db_().insertSheet(PLAYS.TAB);
    sh.getRange(1, 1, 1, PLAYS.COLUMNS.length).setValues([PLAYS.COLUMNS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  delete __tableCache[PLAYS.TAB];
}
