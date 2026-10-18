/**
 * UCBAC Stats — StatsImport.gs
 *
 * A box score arrives as whatever a coach has: a photo of a notebook page,
 * a spreadsheet in his own layout, a paragraph of text. Getting it into
 * PlayerGameStats used to mean an administrator normalizing it by hand and
 * pasting forty-eight-column rows into the tab, one PlayerID at a time.
 * This file is the tab and the menu that replace the paste:
 *
 *   StatsImport tab     one row per player per game, in plain columns -
 *                       School, Week, Opponent, Player, #, then the stat
 *                       fields by name. A person can fill it; so can the
 *                       extractor in StatsExtract.gs reading a coach's file.
 *   Stats > Import (dry run)   resolves every row - which game, which
 *                       player - and writes the answer beside it, in the
 *                       Result and Note columns. Nothing else moves.
 *   Stats > Import (APPLY)     writes the resolved rows through the very
 *                       path the coach portal uses (teamAdminWriteStats), so
 *                       a line landed here is indistinguishable from one a
 *                       coach typed: GAME grain, one row per category,
 *                       an existing line updated rather than duplicated.
 *
 * Nothing is guessed silently. A name that is not on the roster exactly is
 * matched by jersey, by initial and surname, or by surname alone - and only
 * when that leaves ONE candidate. The row says how it was matched. Anything
 * else is refused with a reason and left on the tab for a person.
 */

const STATSIMPORT = {
  TAB: 'StatsImport',
  KEYS: ['School', 'Week', 'Opponent', 'Player', '#'],
  // the stat columns, in the order a coach reads a box score
  FIELDS: ['PassAtt', 'PassComp', 'PassYds', 'PassTD', 'PassInt',
           'RushAtt', 'RushYds', 'RushTD', 'RushFum',
           'Rec', 'RecYds', 'RecTD', 'RecFum', 'Pancakes',
           'TackleSolo', 'TackleAssist', 'TFL', 'Sacks', 'Int', 'FF', 'FR', 'PassDef', 'DefTD',
           'FGM', 'FGA', 'XPM', 'XPA', 'Punts', 'PuntYds', 'KR', 'KRYds', 'PR', 'PRYds',
           'Blocks', 'BlockedPunts', 'TwoPointConversions'],
  OUT: ['Result', 'Note'],
  // an administrator's import is the official line
  SOURCE: 'COACH_ENTRY',
  // how a school is written on a coach's sheet, beyond its display name
  ALIASES: {
    cmw: 'C. Milton Wright', cmilton: 'C. Milton Wright', miltonwright: 'C. Milton Wright',
    bomanor: 'Bohemia Manor', bohemia: 'Bohemia Manor', bmhs: 'Bohemia Manor',
    hdg: 'Havre de Grace', havre: 'Havre de Grace',
    pmill: 'Patterson Mill', pm: 'Patterson Mill', pmhs: 'Patterson Mill',
    nh: 'North Harford', nhhs: 'North Harford', ne: 'North East', nehs: 'North East',
    ht: 'Harford Tech', tech: 'Harford Tech', hths: 'Harford Tech', harfordtechnical: 'Harford Tech',
    joppa: 'Joppatowne', jhs: 'Joppatowne', rs: 'Rising Sun', rshs: 'Rising Sun',
    bahs: 'Bel Air', belair: 'Bel Air', ehs: 'Elkton', fhs: 'Fallston', ahs: 'Aberdeen',
    phs: 'Perryville', ewhs: 'Edgewood'
  }
};

function siHeader_() {
  return STATSIMPORT.KEYS.concat(STATSIMPORT.FIELDS.filter(function (f) {
    return f !== 'BlockedPunts' && f !== 'TwoPointConversions';
  }), STATSIMPORT.OUT, ['BlockedPunts', 'TwoPointConversions']);
}

/** letters and digits only, lower case: "Ke'Mar Parsons" and "kemar parsons" agree */
function siNorm_(v) { return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** the same without a generational suffix, so "DJ Webster Jr." meets "DJ Webster" */
function siNormBare_(v) {
  return siNorm_(String(v || '').replace(/[,.\s]+(jr|sr|ii|iii|iv)\.?\s*$/i, ''));
}

/** The tab, created with its header the first time it is asked for. */
function siEnsureTab_() {
  if (hasTab_(STATSIMPORT.TAB)) return getTab_(STATSIMPORT.TAB);
  const sh = db_().insertSheet(STATSIMPORT.TAB);
  const h = siHeader_();
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(4);
  delete __tableCache[STATSIMPORT.TAB];
  return sh;
}

/** Rows keyed by header name, appended under whatever header the tab has. */
function siAppend_(rows) {
  if (!rows || !rows.length) return 0;
  siEnsureTab_();
  const head = tabHeader_(STATSIMPORT.TAB);
  ['BlockedPunts', 'TwoPointConversions'].forEach(function (f) {
    if (head.indexOf(f) < 0 && rows.some(function (r) {
      return r[f] !== undefined && r[f] !== null && r[f] !== '';
    })) throw new Error('StatsImport has no ' + f + ' column. Run the approved schema migration before importing this field.');
  });
  return appendRows_(STATSIMPORT.TAB, rows);
}

/** Who is writing when the menu runs: the sheet's owner, an administrator. */
function siMe_() {
  var email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { email = ''; }
  return { email: email || 'sheet', role: 'ADMIN', teamId: '' };
}

/**
 * A school as a coach writes it -> its TeamID. Display name, school name,
 * slug, id, an alias, or a unique prefix of the display name.
 */
function siTeamByName_(name) {
  const want = siNorm_(name);
  if (!want) return '';
  const teams = rowsOf_(CONFIG.TABS.TEAMS);
  var hit = '';
  teams.forEach(function (t) {
    if (hit) return;
    if (siNorm_(t.TeamID) === want || siNorm_(t.DisplayName) === want ||
        siNorm_(t.SchoolName) === want || siNorm_(t.Slug) === want) hit = s_(t.TeamID);
  });
  if (hit) return hit;
  const alias = STATSIMPORT.ALIASES[want];
  if (alias) return siTeamByName_(alias);
  const pref = teams.filter(function (t) { return siNorm_(t.DisplayName).indexOf(want) === 0; });
  return pref.length === 1 ? s_(pref[0].TeamID) : '';
}

/**
 * The game a row belongs to. `week` may be a week number or a GameID;
 * `opponent` settles a week with two games (Fallston's week 4) and may
 * stand alone when the week is blank. Returns { game } or { error }.
 */
function siResolveGame_(teamId, week, opponent) {
  const seasonId = CONFIG.CURRENT_SEASON;
  const mine = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === seasonId && (s_(g.HomeTeamID) === teamId || s_(g.AwayTeamID) === teamId);
  });
  const wk = s_(week);
  if (/^GAME-/i.test(wk)) {
    const g = mine.filter(function (x) { return s_(x.GameID).toUpperCase() === wk.toUpperCase(); })[0];
    return g ? { game: g } : { error: 'Game ' + wk + ' is not one of ' + (teamNameOf_(teamId) || teamId) + '\'s ' + seasonId.replace('SEA-', '') + ' games.' };
  }
  const n = num_(wk);
  const opp = siNorm_(opponent);
  if (n === null && !opp) return { error: 'Give the week (or the GameID) and, if the week had two games, the opponent.' };
  var cands = n === null ? mine.slice() : mine.filter(function (g) { return num_(g.Week) === n; });
  if (opp) {
    const oppId = siTeamByName_(opponent);
    cands = cands.filter(function (g) {
      const other = s_(g.HomeTeamID) === teamId ? { id: s_(g.AwayTeamID), name: s_(g.AwayTeamName) }
                                                 : { id: s_(g.HomeTeamID), name: s_(g.HomeTeamName) };
      if (oppId && other.id === oppId) return true;
      const on = siNorm_(other.name);
      return !!on && (on === opp || on.indexOf(opp) === 0 || opp.indexOf(on) === 0);
    });
  }
  if (cands.length === 1) return { game: cands[0] };
  if (!cands.length) {
    if (n === null && !opp) return { error: 'Give the week (or the GameID) and, if the week had two games, the opponent.' };
    return { error: (teamNameOf_(teamId) || teamId) + ' has no ' + seasonId.replace('SEA-', '') + ' game' +
                    (n !== null ? ' in week ' + n : '') + (opp ? ' against "' + s_(opponent) + '"' : '') + '.' };
  }
  return { error: (teamNameOf_(teamId) || teamId) + ' has ' + cands.length + ' games' +
                  (n !== null ? ' in week ' + n : '') + ': name the opponent (' +
                  cands.map(function (g) { return s_(g.HomeTeamID) === teamId ? s_(g.AwayTeamName) : s_(g.HomeTeamName); }).join(', ') + ').' };
}

/** A team's roster for the season: what a stat line may be attached to. */
function siRoster_(teamId, seasonId) {
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return s_(p.PlayerID); });
  return rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.TeamID) === teamId && s_(r.SeasonID) === seasonId && s_(r.PlayerID);
  }).map(function (r) {
    const p = players[s_(r.PlayerID)] || {};
    const name = s_(p.DisplayName) || s_(r.DisplayName) || s_(r.PlayerID);
    const parts = name.replace(/[,.\s]+(jr|sr|ii|iii|iv)\.?\s*$/i, '').trim().split(/\s+/);
    return { pid: s_(r.PlayerID), name: name, norm: siNorm_(name), bare: siNormBare_(name),
             jersey: num_(r.Jersey), first: siNorm_(parts[0] || ''), last: siNorm_(parts[parts.length - 1] || '') };
  });
}

/**
 * Which roster player a written name is. Exact first; then the safe
 * fallbacks, each only when it leaves one candidate. Returns
 * { pid, name, how } or { error, near }.
 */
function siResolvePlayer_(roster, name, jersey) {
  const raw = s_(name);
  const nm = siNorm_(raw), bare = siNormBare_(raw), j = num_(jersey);
  const one = function (list, how) {
    return list.length === 1 ? { pid: list[0].pid, name: list[0].name, how: how } : null;
  };
  var hit = null;
  if (nm) {
    const exact = roster.filter(function (r) { return r.norm === nm || r.bare === bare; });
    hit = one(roster.filter(function (r) { return r.norm === nm; }), 'exact') ||
          one(roster.filter(function (r) { return r.bare === bare; }), 'exact');
    if (hit) return hit;
    /* The name is on the roster more than once. Wearing the same number it
       is one player entered twice, and nothing typed on this tab can choose
       between two ids - the roster has to be mended first. */
    if (exact.length > 1) {
      // a number on the row picks between two people who share a name
      if (j !== null) {
        hit = one(exact.filter(function (r) { return r.jersey === j; }), 'jersey');
        if (hit) return hit;
      }
      const nums = exact.map(function (r) { return r.jersey === null ? 'no number' : '#' + r.jersey; });
      const same = nums.every(function (n) { return n === nums[0]; });
      return { error: '"' + raw + '" is on the roster ' + exact.length + ' times (' + nums.join(', ') + ')' +
                      (same ? ' - one player entered twice. Run UCBAC Stats > Maintenance > Merge split players (dry run), then (APPLY), and import again.'
                            : ' - if that is one player, remove the extra row on the portal Roster tab; if two, give the number here.'),
               near: exact.map(function (r) { return r.name + (r.jersey !== null ? ' #' + r.jersey : ''); }) };
    }
  }
  // the written name split the same way the roster's was
  const parts = raw.replace(/[,.\s]+(jr|sr|ii|iii|iv)\.?\s*$/i, '').trim().split(/\s+/).filter(Boolean);
  const first = siNorm_(parts[0] || ''), last = siNorm_(parts[parts.length - 1] || '');
  const surname = parts.length >= 2 ? last : (parts.length === 1 ? first : '');
  if (j !== null) {
    const byJ = roster.filter(function (r) { return r.jersey === j; });
    // a jersey is trusted when the name does not contradict it
    hit = one(byJ.filter(function (r) { return !surname || r.last === surname || (parts.length === 1 && r.first === first); }), 'jersey');
    if (hit) return hit;
  }
  if (parts.length >= 2 && surname) {
    hit = one(roster.filter(function (r) { return r.last === surname && r.first.charAt(0) === first.charAt(0); }), 'initial');
    if (hit) return hit;
  }
  if (surname) {
    hit = one(roster.filter(function (r) { return r.last === surname; }), 'surname');
    if (hit) return hit;
  }
  const near = roster.filter(function (r) {
    return (surname && r.last === surname) || (j !== null && r.jersey === j);
  }).map(function (r) { return r.name + (r.jersey !== null ? ' #' + r.jersey : ''); });
  return { error: raw ? '"' + raw + '"' + (j !== null ? ' #' + j : '') + ' is not on the roster' : 'no player name',
           near: near };
}

/**
 * One tab row -> the category lines the writer takes, or { error }.
 * Blank cells are absent, never zero; a cell that is not a number refuses
 * the whole row, since half a line is worse than none.
 */
function siLines_(row, playerId) {
  const out = [];
  var bad = '';
  TEAMADMIN.CATEGORY_ORDER.forEach(function (cat) {
    const line = { playerId: playerId, category: cat };
    var any = false;
    TEAMADMIN.CATEGORIES[cat].forEach(function (f) {
      if (STATSIMPORT.FIELDS.indexOf(f) < 0) return;
      const v = row[f];
      if (v === '' || v === null || v === undefined) return;
      var n;
      try { n = teamAdminStat_(f, v); }
      catch (e) { bad = bad || e.message; return; }
      line[f] = n; any = true;
    });
    if (any) out.push(line);
  });
  if (bad) return { error: bad };
  return { lines: out };
}

/**
 * The run. `apply` false writes only Result and Note beside every row;
 * true also writes the resolved lines to PlayerGameStats. Returns the
 * report as text, for the menu dialog or the log.
 */
function siRun_(apply) {
  const me = siMe_();
  const sh = siEnsureTab_();
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const col = {};
  head.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
  ['School', 'Player'].forEach(function (c) {
    if (col[c] === undefined) throw new Error(STATSIMPORT.TAB + ' has no ' + c + ' column. The header is: ' + siHeader_().join(', '));
  });
  // Result and Note live at the end; added if a hand-made tab lacks them
  STATSIMPORT.OUT.forEach(function (c) {
    if (col[c] === undefined) {
      const at = head.length;
      sh.getRange(1, at + 1).setValue(c).setFontWeight('bold');
      head.push(c); col[c] = at;
    }
  });
  if (values.length < 2) return STATSIMPORT.TAB + ' is empty. Paste rows under the header: ' + siHeader_().join(', ') + '.';

  const seasonId = CONFIG.CURRENT_SEASON;
  const rosters = {}, games = {}, groups = {};
  const results = [];        // [sheetRow, Result, Note]
  const refusals = [];       // { row, who, why } - the dialog says WHY, not just how many
  var counted = 0, resolved = 0, refused = 0;

  for (var r = 1; r < values.length; r++) {
    const v = values[r];
    const cell = function (c) { return col[c] === undefined ? '' : v[col[c]]; };
    const row = {};
    head.forEach(function (h, i) { row[h] = v[i]; });
    const blank = STATSIMPORT.KEYS.concat(STATSIMPORT.FIELDS).every(function (c) {
      const x = cell(c); return x === '' || x === null || x === undefined;
    });
    if (blank) continue;
    counted++;
    const note = function (res, why) {
      results.push([r + 1, res, why || '']);
      if (res.indexOf('REFUSED') === 0) {
        refused++;
        refusals.push({ row: r + 1, who: s_(cell('Player')) || s_(cell('School')) || '(blank)', why: why || '' });
      }
    };

    const teamId = siTeamByName_(cell('School'));
    if (!teamId) { note('REFUSED', 'school "' + s_(cell('School')) + '" is not a UCBAC team'); continue; }
    const gk = teamId + '|' + s_(cell('Week')) + '|' + s_(cell('Opponent'));
    if (!games[gk]) games[gk] = siResolveGame_(teamId, cell('Week'), cell('Opponent'));
    if (games[gk].error) { note('REFUSED', games[gk].error); continue; }
    const g = games[gk].game;
    if (!rosters[teamId]) rosters[teamId] = siRoster_(teamId, seasonId);
    const who = siResolvePlayer_(rosters[teamId], cell('Player'), cell('#'));
    if (who.error) {
      note('REFUSED', who.error + (who.near && who.near.length ? '. Did you mean: ' + who.near.join(', ') + '?' : ''));
      continue;
    }
    const lines = siLines_(row, who.pid);
    if (lines.error) { note('REFUSED', lines.error); continue; }
    if (!lines.lines.length) { note('REFUSED', 'no statistics on the row'); continue; }

    const gid = s_(g.GameID);
    const grp = groups[teamId + '|' + gid] || (groups[teamId + '|' + gid] = { teamId: teamId, gameId: gid, game: g, rows: [] });
    grp.rows.push({ sheetRow: r + 1, pid: who.pid, name: who.name, how: who.how, lines: lines.lines });
    resolved++;
    const opp = s_(g.HomeTeamID) === teamId ? s_(g.AwayTeamName) : s_(g.HomeTeamName);
    note('RESOLVED', who.name + (who.how !== 'exact' ? ' (matched by ' + who.how + ')' : '') +
         ' · ' + gid + ' week ' + s_(g.Week) + ' vs ' + opp + ' · ' +
         lines.lines.map(function (l) { return l.category; }).join('/'));
  }

  const out = [];
  out.push((apply ? 'STATS IMPORT' : 'STATS IMPORT — DRY RUN') + ' for ' + seasonId);
  out.push('Rows read: ' + counted + ' · resolved: ' + resolved + ' · refused: ' + refused);
  /* A count of refusals is nothing a person can act on. Each one, with the
     row it sits on, who the row names, and the reason - the same words
     written beside it in the Note column. */
  if (refusals.length) {
    const SHOW = 40;
    out.push('');
    /* A refusal is about its own row and nothing else - every other row is
       written regardless. Saying "fix these, then run again" read as a
       precondition and stopped an import that was ready to go, so it says what
       it means: these rows wait, the rest do not. */
    out.push('REFUSED - these ' + refusals.length + ' rows only. The other ' +
             resolved + ' are unaffected and will be written:');
    refusals.slice(0, SHOW).forEach(function (x) {
      out.push('  row ' + x.row + ' · ' + x.who + ': ' + x.why);
    });
    if (refusals.length > SHOW)
      out.push('  ... and ' + (refusals.length - SHOW) + ' more; every row\'s reason is in its Note column');
    out.push('');
  }
  Object.keys(groups).forEach(function (k) {
    const grp = groups[k];
    const opp = s_(grp.game.HomeTeamID) === grp.teamId ? s_(grp.game.AwayTeamName) : s_(grp.game.HomeTeamName);
    out.push('  ' + (teamNameOf_(grp.teamId) || grp.teamId) + ' · ' + grp.gameId + ' week ' + s_(grp.game.Week) +
             ' vs ' + opp + ': ' + grp.rows.length + ' players, ' +
             grp.rows.reduce(function (n, x) { return n + x.lines.length; }, 0) + ' lines');
    const loose = grp.rows.filter(function (x) { return x.how !== 'exact'; });
    if (loose.length) out.push('    matched loosely (check): ' + loose.map(function (x) { return x.name + ' by ' + x.how; }).join('; '));
  });

  if (apply) {
    var saved = 0;
    Object.keys(groups).forEach(function (k) {
      const grp = groups[k];
      // the writer takes up to MAX_STAT_ROWS lines a call
      const flat = [];
      grp.rows.forEach(function (x) { x.lines.forEach(function (l) { flat.push({ line: l, row: x }); }); });
      for (var i = 0; i < flat.length; i += TEAMADMIN.MAX_STAT_ROWS) {
        const batch = flat.slice(i, i + TEAMADMIN.MAX_STAT_ROWS);
        const res = teamAdminWriteStats_(me, grp.gameId, grp.teamId, batch.map(function (b) { return b.line; }),
                                        { sourceType: STATSIMPORT.SOURCE });
        saved += res.saved || 0;
        (res.refused || []).forEach(function (msg) {
          const m = /^row (\d+)/.exec(msg);
          const b = m ? batch[Number(m[1]) - 1] : null;
          if (b) results.push([b.row.sheetRow, 'REFUSED', msg.replace(/^row \d+\s*/, '')]);
          out.push('  refused: ' + msg);
        });
      }
    });
    // every resolved row that was not refused by the writer is saved
    const refusedRows = {};
    results.forEach(function (x) { if (x[1] === 'REFUSED') refusedRows[x[0]] = true; });
    results.forEach(function (x) { if (x[1] === 'RESOLVED' && !refusedRows[x[0]]) x[1] = 'SAVED'; });
    out.push('Lines written to ' + CONFIG.TABS.PLAYER_STATS + ': ' + saved);
    if (saved) { teamAdminBustCache_(seasonId); markDirty_('stats'); out.push('Totals catch up on the next rebuild (or Rebuild everything now).'); }
  } else {
    /* This is the dry run, and the last line it prints is the one a person acts
       on. It used to make fixing the refusals sound like the next step, when
       the next step is APPLY: refused rows keep their place on the tab for a
       later pass, and never hold up the ones that resolved. */
    out.push(refused
      ? 'Nothing written — this is the dry run. Stats > Import (APPLY) writes the ' +
        resolved + ' resolved row' + (resolved === 1 ? '' : 's') + ' and leaves the ' +
        refused + ' refused one' + (refused === 1 ? '' : 's') + ' on the tab for later.'
      : 'Nothing written — this is the dry run. Stats > Import (APPLY) writes all ' +
        resolved + ' row' + (resolved === 1 ? '' : 's') + '.');
  }
  out.push('Every row\'s verdict is beside it on the ' + STATSIMPORT.TAB + ' tab, in the Result and Note columns.');

  // the verdicts, beside the rows; the last verdict for a row wins
  const byRow = {};
  results.forEach(function (x) { byRow[x[0]] = x; });
  Object.keys(byRow).forEach(function (k) {
    const x = byRow[k];
    sh.getRange(x[0], col.Result + 1, 1, 2).setValues([[x[1], x[2]]]);
  });
  delete __tableCache[STATSIMPORT.TAB];
  return out.join('\n');
}

/** Clear the rows that were saved, keeping refused ones for another pass. */
function siClearSaved_() {
  const sh = siEnsureTab_();
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const c = head.indexOf('Result');
  if (c < 0) return 0;
  var n = 0;
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][c] || '').trim() === 'SAVED') { sh.deleteRow(r + 1); n++; }
  }
  delete __tableCache[STATSIMPORT.TAB];
  return n;
}

// ── menu and editor entry points ────────────────────────────────────────────
// Menu items may show a dialog; the editor-run twins only log, so a function
// picked from the toolbar never waits six minutes on a dialog nobody sees.
function menuStatsImportTab()   { const sh = siEnsureTab_(); db_().setActiveSheet(sh); }
function menuStatsImportDry()   { SpreadsheetApp.getUi().alert(siRun_(false)); }
function menuStatsImportApply() { SpreadsheetApp.getUi().alert(siRun_(true)); }
function menuStatsImportClear() { SpreadsheetApp.getUi().alert('Removed ' + siClearSaved_() + ' saved row(s) from ' + STATSIMPORT.TAB + '.'); }
function statsImportDryRun_()    { Logger.log(siRun_(false)); }
function statsImportApply_()     { Logger.log(siRun_(true)); }
