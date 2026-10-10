/**
 * UCBAC Stats — StatsExtract.gs
 *
 * Reads a box score out of whatever a coach sent - a photo, a PDF, a
 * spreadsheet, a paragraph - with the same Gemini key Blitz uses, into the
 * plain rows StatsImport understands. Two doors:
 *
 *   The inbox   Drop the files coaches send into the Drive folder
 *               "UCBAC Stats inbox" (made on first use). Stats > Read the
 *               inbox reads every file there, appends its rows to the
 *               StatsImport tab, and moves the file to a "done" folder
 *               inside. Then dry run, then APPLY, as with any import.
 *   The portal  A coach uploads a file against a game. It is read at once,
 *               matched to his roster, and written as FILE_IMPORT: official
 *               on landing, replaced by his next upload for the same game.
 *               Names that do not match go to the StatsImport tab for a
 *               person. The file is still mailed to the administrators, as
 *               it always was.
 *
 * The model is asked only for numbers it can see. It is handed the roster,
 * so "J. Smith" comes back as the roster's spelling when that is the only
 * Smith, and it is told the site's conventions: sacks apart from tackles
 * for loss, a lone tackle count as solo tackles, a blank where the sheet
 * is blank. Every reading still passes through the resolver and the
 * review queue; nothing the model says is published as official on its
 * own word.
 */

const STATSEXTRACT = {
  INBOX: 'UCBAC Stats inbox',
  DONE: 'done',
  FOLDER_PROP: 'STATS_INBOX_FOLDER',
  MAX_BYTES: 12 * 1024 * 1024,
  MAX_PLAYERS: 120,
  MAX_TRIES: 3,
  MAX_OUTPUT: 8000,
  TEXT: { 'text/plain': 1, 'text/csv': 1, 'text/tab-separated-values': 1, 'text/markdown': 1, 'application/json': 1 },
  INLINE: { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'image/heif': 1, 'application/pdf': 1 },
  // office files go through Drive: uploaded as a Google file, exported as text
  CONVERT: {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      { to: 'application/vnd.google-apps.spreadsheet', out: 'text/csv' },
    'application/vnd.ms-excel':
      { to: 'application/vnd.google-apps.spreadsheet', out: 'text/csv' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      { to: 'application/vnd.google-apps.document', out: 'text/plain' },
    'application/msword':
      { to: 'application/vnd.google-apps.document', out: 'text/plain' }
  },
  BY_EXT: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
            heif: 'image/heif', pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', tsv: 'text/tab-separated-values',
            md: 'text/markdown', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            xls: 'application/vnd.ms-excel',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' }
};

/** What the model is asked to return: the site's own fields, nothing else. */
function seSchema_() {
  const stat = { type: 'INTEGER' }, half = { type: 'NUMBER' };
  const player = { name: { type: 'STRING' }, jersey: { type: 'INTEGER' } };
  STATSIMPORT.FIELDS.forEach(function (f) {
    player[f] = TEAMADMIN.HALF_FIELDS.indexOf(f) >= 0 ? half : stat;
  });
  return {
    type: 'OBJECT',
    properties: {
      team: { type: 'STRING' }, opponent: { type: 'STRING' }, week: { type: 'INTEGER' },
      gameDate: { type: 'STRING' }, teamScore: { type: 'INTEGER' }, opponentScore: { type: 'INTEGER' },
      players: { type: 'ARRAY', items: { type: 'OBJECT', properties: player, required: ['name'] } },
      notes: { type: 'STRING' }
    },
    required: ['players']
  };
}

/** The standing instruction: what the numbers mean here. */
function seRules_(ctx) {
  const lines = [
    'You read American high school football box scores for a statistics site. Return JSON only.',
    'Extract per-player statistics for ONE team from the document. Use only numbers you can see; never invent, estimate or total.',
    'Fields: ' + STATSIMPORT.FIELDS.join(', ') + '. Omit a field the document does not give. Never write 0 for a blank.',
    'Conventions: a single "tackles" number goes in TackleSolo; a solo/assist split goes in TackleSolo and TackleAssist.',
    'Sacks and TFL (tackles for loss) are separate; do not count a sack as a TFL unless the document does.',
    'Passing: PassComp is completions, PassAtt attempts, PassInt interceptions THROWN. Int is interceptions CAUGHT by a defender.',
    'PassDef is pass break-ups. FF forced fumbles, FR fumble recoveries, DefTD defensive touchdowns. RushFum/RecFum are fumbles lost.',
    '"2-point conversions" have no field: leave them out. Kick returns KR/KRYds, punt returns PR/PRYds.',
    'Blocks is blocked kicks - a punt, field goal or extra point stopped at the line. Box scores often print it under defense; it belongs in Blocks.',
    'Skip rows that are team totals, opponents, or coaches. A name written twice in different sections is one player.',
    'jersey: the number beside the name if shown. name: the player as written, with the roster\'s spelling when one roster name clearly matches.',
    'team, opponent, week, gameDate, teamScore, opponentScore: fill from the document when present, else omit.'
  ];
  if (ctx && ctx.team) lines.push('The team is ' + ctx.team + (ctx.opponent ? ', playing ' + ctx.opponent : '') + (ctx.week ? ', week ' + ctx.week : '') + '.');
  if (ctx && ctx.roster && ctx.roster.length) {
    lines.push('ROSTER (name #jersey): ' + ctx.roster.map(function (r) { return r.name + (r.jersey !== null && r.jersey !== undefined ? ' #' + r.jersey : ''); }).join('; '));
  }
  return lines.join('\n');
}

/** A file's parts for the request: text as text, images and PDFs inline, office files converted. */
function seParts_(fileName, mimeType, bytes) {
  var mime = s_(mimeType).toLowerCase().split(';')[0];
  const ext = (String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (!mime || mime === 'application/octet-stream') mime = STATSEXTRACT.BY_EXT[ext] || mime;
  if (STATSEXTRACT.TEXT[mime] || (mime.indexOf('text/') === 0)) {
    return [{ text: 'DOCUMENT (' + fileName + '):\n' + Utilities.newBlob(bytes).getDataAsString().slice(0, 60000) }];
  }
  if (STATSEXTRACT.INLINE[mime]) {
    return [{ inlineData: { mimeType: mime, data: Utilities.base64Encode(bytes) } }];
  }
  const conv = STATSEXTRACT.CONVERT[mime];
  if (conv) {
    return [{ text: 'DOCUMENT (' + fileName + ', converted to text):\n' + seConvertToText_(fileName, mime, bytes, conv).slice(0, 60000) }];
  }
  throw new Error('"' + fileName + '" is a ' + (mime || ext || 'file') + ', which cannot be read. Send a photo, PDF, spreadsheet, Word file or plain text.');
}

/**
 * An office file -> text, by way of Drive: uploaded converting to the Google
 * kind, exported as text, deleted. All through the REST API with the
 * script's own token, so no extra service or scope is needed.
 */
function seConvertToText_(fileName, mime, bytes, conv) {
  const token = ScriptApp.getOAuthToken();
  const boundary = 'ucbac' + Utilities.getUuid().replace(/-/g, '');
  const meta = JSON.stringify({ name: 'stats-extract ' + fileName, mimeType: conv.to });
  const body = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n' +
    '--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n').getBytes()
    .concat(bytes)
    .concat(Utilities.newBlob('\r\n--' + boundary + '--').getBytes());
  const up = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary,
    headers: { Authorization: 'Bearer ' + token }, payload: body, muteHttpExceptions: true
  });
  if (up.getResponseCode() !== 200)
    throw new Error('Drive would not convert "' + fileName + '" (' + up.getResponseCode() + ').');
  const id = s_(JSON.parse(up.getContentText()).id);
  try {
    const ex = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
      '/export?mimeType=' + encodeURIComponent(conv.out),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (ex.getResponseCode() !== 200)
      throw new Error('Drive would not export "' + fileName + '" as text (' + ex.getResponseCode() + ').');
    return ex.getContentText();
  } finally {
    try { UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id),
      { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }); } catch (e) {}
  }
}

/**
 * Ask the model for JSON in the shape of seSchema(). The remembered model
 * first, then the best of the list, as Blitz does; a request the model
 * rejects for its thinking settings is sent again without them.
 */
function seGenerate_(parts, ctx) {
  if (__AUTH_BOUND && !blitzAccess_(accountsWhoami_()).allowed)
    throw new Error("Automatic reading is unavailable for this account.");
  const key = chatKey_();
  if (!key) throw new Error('The reader is not switched on: no ' + CHAT.KEY_PROP + ' in Script Properties.');
  const props_ = PropertiesService.getScriptProperties();
  const pinned = String(props_.getProperty(CHAT.MODEL_PROP) || '').trim();
  var models = pinned ? [pinned] : chatDiscoverModels_().slice(0, STATSEXTRACT.MAX_TRIES);
  var expanded = !pinned;
  if (!models.length) throw new Error('No model is available to read the file.');

  const base = {
    systemInstruction: { parts: [{ text: seRules_(ctx) }] },
    contents: [{ role: 'user', parts: parts.concat([{ text: 'Extract the box score as JSON.' }]) }]
  };
  const shapes = [
    { temperature: 0, maxOutputTokens: STATSEXTRACT.MAX_OUTPUT, responseMimeType: 'application/json',
      responseSchema: seSchema_(), thinkingConfig: { thinkingBudget: 0 } },
    { temperature: 0, maxOutputTokens: STATSEXTRACT.MAX_OUTPUT, responseMimeType: 'application/json',
      responseSchema: seSchema_() }
  ];
  var lastErr = '', tried = [];
  for (var i = 0; i < models.length && tried.length < STATSEXTRACT.MAX_TRIES; i++) {
    const m = models[i];
    tried.push(m);
    var code = 0, text = '';
    for (var sh = 0; sh < shapes.length; sh++) {
      const res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) +
        ':generateContent?key=' + encodeURIComponent(key),
        { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ systemInstruction: base.systemInstruction, contents: base.contents,
                                    generationConfig: shapes[sh] }) });
      code = res.getResponseCode();
      if (code === 400 && sh === 0) { lastErr = 'thinkingConfig refused'; continue; }
      if (code !== 200) { lastErr = 'HTTP ' + code + ' from ' + m + ': ' + res.getContentText().slice(0, 200); break; }
      var parsed;
      try { parsed = JSON.parse(res.getContentText()); } catch (e) { lastErr = 'bad JSON envelope'; break; }
      const cand = (parsed.candidates || [])[0] || {};
      text = ((cand.content || {}).parts || []).map(function (p) { return s_(p.text); }).join('').trim();
      if (text) break;
      lastErr = 'empty answer from ' + m;
    }
    if (code === 200 && text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { lastErr = m + ' returned text that is not JSON'; data = null; }
      if (data && Array.isArray(data.players)) {
        if (m !== pinned) props_.setProperty(CHAT.MODEL_PROP, m);
        data.model = m;
        return data;
      }
    }
    if (m === pinned && (code === 404 || code === 429 || code === 503)) props_.deleteProperty(CHAT.MODEL_PROP);
    if (!expanded) {
      expanded = true;
      chatDiscoverModels_().forEach(function (n) { if (tried.indexOf(n) < 0 && models.indexOf(n) < 0) models.push(n); });
    }
  }
  throw new Error('The file could not be read. Tried ' + tried.join(', ') + '. ' + lastErr);
}

/**
 * A file -> what the model read: { team, opponent, week, players: [{ name,
 * jersey, <fields> }], notes, model }. Numbers are cleaned here: blanks
 * stay blank, anything that is not a number is dropped.
 */
function seExtract_(fileName, mimeType, bytes, ctx) {
  if (!bytes || !bytes.length) throw new Error('"' + fileName + '" is empty.');
  if (bytes.length > STATSEXTRACT.MAX_BYTES) throw new Error('"' + fileName + '" is over 12 MB.');
  const data = seGenerate_(seParts_(fileName, mimeType, bytes), ctx);
  const players = [];
  (data.players || []).slice(0, STATSEXTRACT.MAX_PLAYERS).forEach(function (p) {
    if (!p || !s_(p.name)) return;
    const row = { name: s_(p.name).slice(0, 60), jersey: num_(p.jersey) };
    var any = false;
    STATSIMPORT.FIELDS.forEach(function (f) {
      const v = numOrNull_(p[f]);
      if (v === null) return;
      row[f] = v; any = true;
    });
    if (any) players.push(row);
  });
  return { team: s_(data.team), opponent: s_(data.opponent), week: num_(data.week), gameDate: s_(data.gameDate),
           teamScore: num_(data.teamScore), opponentScore: num_(data.opponentScore),
           players: players, notes: s_(data.notes).slice(0, 300), model: s_(data.model) };
}

/** The reading as StatsImport rows, School/Week/Opponent as given or as read. */
function seRows_(read, school, week, opponent, tag) {
  return read.players.map(function (p) {
    const row = { School: school || read.team, Week: week !== undefined && week !== '' ? week : (read.week === null ? '' : read.week),
                  Opponent: opponent || read.opponent, Player: p.name, '#': p.jersey === null ? '' : p.jersey,
                  Result: 'EXTRACTED', Note: tag || '' };
    STATSIMPORT.FIELDS.forEach(function (f) { if (p[f] !== undefined) row[f] = p[f]; });
    return row;
  });
}

// ── the inbox ───────────────────────────────────────────────────────────────

/** The inbox folder, made in My Drive on first use and remembered by id. */
function seInboxFolder_() {
  const props_ = PropertiesService.getScriptProperties();
  const id = String(props_.getProperty(STATSEXTRACT.FOLDER_PROP) || '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(STATSEXTRACT.INBOX);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(STATSEXTRACT.INBOX);
  props_.setProperty(STATSEXTRACT.FOLDER_PROP, folder.getId());
  return folder;
}

function seDoneFolder_(inbox) {
  const it = inbox.getFoldersByName(STATSEXTRACT.DONE);
  return it.hasNext() ? it.next() : inbox.createFolder(STATSEXTRACT.DONE);
}

/**
 * Read every file in the inbox onto the StatsImport tab. The school is
 * whatever the document says, resolved against the Teams tab; a school or
 * week the model could not tell is left blank for a person to fill in
 * before the dry run. Files are moved to "done" once read.
 */
function seReadInbox_() {
  const inbox = seInboxFolder_();
  const done = seDoneFolder_(inbox);
  const out = ['READ THE INBOX — ' + inbox.getName()];
  const files = inbox.getFiles();
  var n = 0;
  while (files.hasNext()) {
    const f = files.next();
    n++;
    const name = f.getName();
    try {
      const read = seExtract_(name, f.getMimeType(), f.getBlob().getBytes(), null);
      const teamId = siTeamByName_(read.team);
      // the document's own words stay on the row either way, as a clue for
      // the person who has to fill in the school
      const school = teamId ? teamNameOf_(teamId) : read.team;
      const rows = seRows_(read, school, read.week === null ? '' : read.week, read.opponent, 'from ' + name +
                          (read.model ? ' (' + read.model + ')' : '') + (read.notes ? ' — ' + read.notes : ''));
      siAppend_(rows);
      f.moveTo(done);
      out.push('  ' + name + ': ' + rows.length + ' players' +
               (teamId ? ' for ' + school
                       : ' — school not recognized' + (read.team ? ' ("' + read.team + '")' : '') + ', fill in the School column') +
               (read.week !== null ? ', week ' + read.week : ', week unknown') +
               (read.opponent ? ' vs ' + read.opponent : ''));
    } catch (e) {
      out.push('  ' + name + ': NOT READ — ' + (e && e.message ? e.message : e));
    }
  }
  if (!n) out.push('  The folder is empty. Drop the coaches\' files in and run this again.');
  else out.push('Next: Stats > Import (dry run), check the Result column, then Import (APPLY).');
  return out.join('\n');
}

// ── the portal ──────────────────────────────────────────────────────────────

/**
 * A coach's upload against one of his games: read, matched to his roster,
 * written as FILE_IMPORT - official, overwriting whatever the game held for
 * those players, so an upload can be repeated for any game at any time.
 * Returns what happened, for the message back to him. Throws only when
 * nothing could be read; a name that does not match is not an error, it is
 * a row on the StatsImport tab for the administrator.
 */
function statsExtractForPortal_(me, gameId, fileName, mimeType, bytes) {
  if (!blitzAccess_(me).allowed) throw new Error("Automatic reading is unavailable for this account.");
  const teamId = s_(me.teamId);
  const seasonId = CONFIG.CURRENT_SEASON;
  const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) { return s_(x.GameID) === s_(gameId); })[0];
  if (!g) throw new Error('Unknown game ' + gameId + '.');
  if (s_(g.HomeTeamID) !== teamId && s_(g.AwayTeamID) !== teamId)
    throw new Error('That game is not ' + (teamNameOf_(teamId) || 'your team') + '\'s.');
  const opponent = s_(g.HomeTeamID) === teamId ? s_(g.AwayTeamName) : s_(g.HomeTeamName);
  const roster = siRoster_(teamId, s_(g.SeasonID) || seasonId);
  const read = seExtract_(fileName, mimeType, bytes,
                         { team: teamNameOf_(teamId), opponent: opponent, week: num_(g.Week), roster: roster });

  const lines = [], matched = [], unmatched = [];
  read.players.forEach(function (p) {
    const who = siResolvePlayer_(roster, p.name, p.jersey);
    if (who.error) { unmatched.push(p); return; }
    const L = siLines_(p, who.pid);
    if (L.error || !L.lines.length) { unmatched.push(p); return; }
    L.lines.forEach(function (l) { lines.push(l); });
    matched.push({ name: who.name, how: who.how });
  });

  var saved = 0, refused = [];
  for (var i = 0; i < lines.length; i += TEAMADMIN.MAX_STAT_ROWS) {
    const res = teamAdminWriteStats_(me, s_(g.GameID), teamId, lines.slice(i, i + TEAMADMIN.MAX_STAT_ROWS),
                                    { sourceType: 'FILE_IMPORT' });
    saved += res.saved || 0;
    refused = refused.concat(res.refused || []);
  }
  if (unmatched.length) {
    siAppend_(seRows_({ players: unmatched, team: teamNameOf_(teamId), opponent: opponent, week: num_(g.Week) },
                    teamNameOf_(teamId), num_(g.Week), opponent,
                    'portal upload ' + fileName + ' by ' + me.email + ': not on the roster'));
  }
  return { read: read.players.length, matched: matched, unmatched: unmatched.map(function (p) { return p.name; }),
           saved: saved, refused: refused, model: read.model, notes: read.notes };
}

// ── menu and editor entry points ────────────────────────────────────────────
function menuStatsInbox_()  { SpreadsheetApp.getUi().alert(seReadInbox_()); }
function statsReadInbox_()  { Logger.log(seReadInbox_()); }
function menuStatsInboxOpen_() {
  const f = seInboxFolder_();
  SpreadsheetApp.getUi().alert('Drop coaches\' files into the Drive folder "' + f.getName() + '":\n' + f.getUrl() +
                               '\n\nThen Stats > Read the inbox.');
}
