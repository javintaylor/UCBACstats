/**
 * UCBAC Stats — Roster.gs
 *
 * Coach-facing roster management. Position is chosen here, from the controlled
 * list in Positions.gs, and nowhere else. A player may hold several positions
 * and becomes All-Conference eligible at each one.
 *
 * This file must run under a deployment configured "Execute as: User accessing
 * the web app" so Session.getActiveUser() identifies the coach. The public site
 * runs as a separate deployment executing as the owner.
 */

/** Who is calling, and what may they touch? */
function whoami_() {
  const email = authEmail_();
  if (!email) return { email: '', role: 'PUBLIC', teamId: '', name: '' };

  ensureCoachesTab_();
  const rows = rowsOf_('Coaches');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Email || '').toLowerCase().trim() !== email) continue;
    if (String(rows[i].Active).toUpperCase() === 'FALSE') break;
    return { email: email,
             role: String(rows[i].Role || 'COACH').toUpperCase(),
             teamId: String(rows[i].TeamID || '').trim(),
             name: String(rows[i].DisplayName || email) };
  }
  return { email: email, role: 'PUBLIC', teamId: '', name: email };
}

function ensureCoachesTab_() {
  if (hasTab_('Coaches')) return;
  const sh = db_().insertSheet('Coaches');
  sh.getRange(1, 1, 1, 6).setValues([[
    'Email', 'DisplayName', 'TeamID', 'Role', 'Active', 'AddedAt'
  ]]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/* Who is asking: the Accounts tab first, the Coaches tab second. A coach
   approved through the portal is a coach whether or not the older tab
   lists him - the roster must open to every coach the portal let in. */
function rosterWho_() {
  return (typeof accountsWhoami_ === 'function') ? accountsWhoami_() : whoami_();
}

/** Throws unless the caller may edit this team. Admins may edit any team. */
function assertCanEdit_(teamId) {
  const me = rosterWho_();
  if (me.role === 'ADMIN') return me;
  if (me.role === 'COACH' && me.teamId && me.teamId === teamId) return me;
  throw new Error('Not authorized to edit ' + (teamId || 'this roster') +
                  '. Signed in as ' + (me.email || 'nobody') + '.');
}

// ── read ───────────────────────────────────────────────────────────────────

/** The position list the UI renders as selectable chips. */
function apiPositionOptions_() {
  return POSITIONS.map(function (p) {
    return { code: p.code, label: p.label, side: p.side,
             ranked: !p.unranked, pool: poolOf_(p.code),
             // The optional refinements — Guard under OL, Edge under DL. The
             // client offers them only once the major is selected.
             subs: (p.subs || []).map(function (x) {
               return { code: x.code, label: x.label };
             }) };
  });
}

function apiRoster_(teamId, seasonId) {
  const me = rosterWho_();
  teamId = teamId || me.teamId;
  seasonId = seasonId || CONFIG.CURRENT_SEASON;
  if (!teamId) throw new Error('No team. Ask an administrator to add you to the Coaches tab.');

  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) { return String(p.PlayerID); });
  const rows = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return String(r.TeamID).trim() === teamId && String(r.SeasonID).trim() === seasonId;
  }).map(function (r) {
    const p = players[String(r.PlayerID)] || {};
    // legacy rows may still carry free text; surface the suggestion but never
    // save it silently — the coach confirms it.
    var codes = parsePositions_(r.Positions);
    var suggested = [];
    if (!codes.length) {
      const legacy = [r.Position, r.OffensePosition, r.DefensePosition]
        .filter(function (v) { return v !== '' && v !== null && v !== undefined; }).join(' / ');
      const n = normalizeLegacyPosition_(legacy);
      suggested = n.codes;
    }
    const out = {
      playerSeasonId: String(r.PlayerSeasonID || ''),
      playerId: String(r.PlayerID || ''),
      name: String(p.DisplayName || r.DisplayName || ''),
      jersey: String(r.Jersey === null || r.Jersey === undefined ? '' : r.Jersey),
      isCaptain: String(r.IsCaptain || '').toUpperCase().trim() === 'TRUE' ||
                 r.IsCaptain === true,
      grad: String(p.GradYear || r.GradYear || ''),
      // Commitment is a career fact and lives on Players, so it is the same on
      // every season's row rather than something a coach re-enters each year.
      commitment: String(p.Commitment || ''),
      commitmentLevel: String(p.CommitmentLevel || ''),
      positions: codes,
      suggested: suggested,
      needsPositions: codes.length === 0
    };
    // Blank must survive the trip as null, not 0 — see MEASURABLES in Schema.gs.
    MEASURABLES.forEach(function (m) {
      const v = r[m.col];
      out[m.key] = (v === '' || v === null || v === undefined) ? null : Number(v);
      if (isNaN(out[m.key])) out[m.key] = null;
    });
    return out;
  }).sort(function (a, b) {
    return (Number(a.jersey) || 999) - (Number(b.jersey) || 999) ||
           a.name.localeCompare(b.name);
  });

  return { teamId: teamId, seasonId: seasonId, me: me, roster: rows,
           options: apiPositionOptions_(),
           measurables: MEASURABLES,
           commitmentLevels: PROFILE.COMMITMENT_LEVELS,
           // captains are edited on this same page; the list and the cap ride
           // along so the editor never needs a second fetch to draw the C column
           captains: rows.filter(function (r) { return r.isCaptain; })
                         .map(function (r) { return r.playerId; }),
           maxCaptains: (typeof TEAMADMIN !== 'undefined' && TEAMADMIN.MAX_CAPTAINS) || 8,
           incomplete: rows.filter(function (r) { return r.needsPositions; }).length };
}

/**
 * Conference-wide position coverage, for chasing the schools that have not
 * declared yet. Admin only — a coach sees their own roster and nobody else's.
 */
function apiCoverage_(seasonId) {
  const me = rosterWho_();
  if (me.role !== 'ADMIN') throw new Error('Administrators only.');
  seasonId = seasonId || CONFIG.CURRENT_SEASON;
  const cov = acRosterCoverage_(seasonId);
  var status = {};
  try { status = buildStatus_(); } catch (e) { status = { lastBuild: 'unknown' }; }
  return { coverage: cov, build: status, seasonId: seasonId };
}

// ── write ──────────────────────────────────────────────────────────────────

/**
 * Save roster edits. `edits` is a list of
 *   { playerSeasonId, positions:[codes], jersey, heightInches, weightLbs, gpa }
 * Positions are validated against the controlled list; anything else is refused.
 */
function apiSaveRoster_(teamId, seasonId, edits) {
  const me = assertCanEdit_(teamId);
  seasonId = seasonId || CONFIG.CURRENT_SEASON;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    const sh = getTab_(CONFIG.TABS.PLAYER_SEASONS);
    const data = sh.getDataRange().getValues();
    const head = data[0].map(String);

    // Every measurable column, plus Positions. A workbook that predates one of
    // them gets it now rather than silently dropping what the coach typed.
    const need = ['Positions'].concat(MEASURABLES.map(function (m) { return m.col; }));
    need.forEach(function (c) {
      if (head.indexOf(c) < 0) { head.push(c); sh.getRange(1, head.length).setValue(c); }
    });
    const col = {};
    ['PlayerSeasonID', 'PlayerID', 'TeamID', 'SeasonID', 'Jersey', 'Positions']
      .concat(MEASURABLES.map(function (m) { return m.col; }))
      .forEach(function (c) { col[c] = head.indexOf(c); });

    const rowOf = {};
    for (var r = 1; r < data.length; r++) {
      const id = String(data[r][col.PlayerSeasonID] || '');
      if (id) rowOf[id] = r + 1;                        // 1-based sheet row
    }

    const audit = [];
    const playerPatch = {};        // PlayerID -> career fields, written once below
    var saved = 0, refused = [];

    edits.forEach(function (e) {
      const rowIdx = rowOf[String(e.playerSeasonId || '')];
      if (!rowIdx) { refused.push(e.playerSeasonId + ': not found'); return; }
      const rowTeam = String(data[rowIdx - 1][col.TeamID] || '').trim();
      if (rowTeam !== teamId && me.role !== 'ADMIN') {
        refused.push(e.playerSeasonId + ': belongs to another team'); return;
      }

      const codes = parsePositions_(formatPositions_(e.positions || []));
      const err = validatePositions_(codes);
      if (err) { refused.push((e.playerSeasonId || '?') + ': ' + err); return; }

      /* Validate the whole row BEFORE writing any of it. Writing as we go would
         leave a refused row half-saved — a new weight stored beside the old 40
         time, with nothing on screen saying which half took. The career fields
         are validated here too, for the same reason: a bad grad year must not
         surface after the positions have already been written. */
      var values, career = {};
      try {
        values = { jersey: e.jersey === undefined ? undefined : normalizeJersey_(e.jersey) };
        MEASURABLES.forEach(function (m) {
          if (e[m.key] !== undefined) values[m.key] = measurableValue_(m.key, e[m.key]);
        });
        if (e.grad !== undefined) career.GradYear = profileGradYear_(e.grad);
        if (e.commitment !== undefined)
          career.Commitment = profileText_(e.commitment, 120);
        if (e.commitmentLevel !== undefined)
          career.CommitmentLevel = profileLevel_(e.commitmentLevel);
      } catch (ex) {
        refused.push((e.playerSeasonId || '?') + ': ' + ex.message);
        return;
      }

      const before = String(data[rowIdx - 1][col.Positions] || '');
      sh.getRange(rowIdx, col.Positions + 1).setValue(formatPositions_(codes));

      if (values.jersey !== undefined && col.Jersey >= 0)
        sh.getRange(rowIdx, col.Jersey + 1).setValue(values.jersey);
      MEASURABLES.forEach(function (m) {
        if (values[m.key] !== undefined && col[m.col] >= 0)
          sh.getRange(rowIdx, col[m.col] + 1).setValue(values[m.key]);
      });

      // Graduation year and commitment are career facts on the Players tab, not
      // season facts. Validated above; written in one pass per player below.
      const pid = String(data[rowIdx - 1][col.PlayerID] || '');
      if (pid && Object.keys(career).length) {
        playerPatch[pid] = playerPatch[pid] || {};
        Object.keys(career).forEach(function (k) { playerPatch[pid][k] = career[k]; });
      }

      if (before !== formatPositions_(codes)) {
        audit.push(auditRow_(me, 'ROSTER_EDIT', 'PlayerSeason', e.playerSeasonId,
                            'Positions', before, formatPositions_(codes),
                            teamId + ' ' + seasonId));
      }
      saved++;
    });

    rosterWritePlayerFields_(playerPatch, refused);

    if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }
    CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
    // a rebuild is not run inline — rosters change in bursts, and the sweep
    // trigger collapses a burst into a single recompute
    markDirty_('roster');

    return { saved: saved, refused: refused };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Write career fields onto the Players tab, one row per player.
 *
 * `patch` is PlayerID -> { HeaderName: value }. The header names are checked
 * against the real header row rather than assumed: a workbook without a
 * Commitment column must refuse the edit and say so, because appendRows and
 * updateCells both match by header and an unmatched name writes nothing at all
 * while reporting success.
 */
function rosterWritePlayerFields_(patch, refused) {
  const ids = Object.keys(patch || {});
  if (!ids.length) return 0;

  const sh = getTab_(CONFIG.TABS.PLAYERS);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(String);
  const cId = head.indexOf('PlayerID');
  if (cId < 0) { refused.push('Players has no PlayerID column'); return 0; }

  const rowOf = {};
  for (var r = 1; r < data.length; r++) {
    const id = String(data[r][cId] || '');
    if (id) rowOf[id] = r + 1;
  }

  var n = 0;
  ids.forEach(function (pid) {
    const rowIdx = rowOf[pid];
    if (!rowIdx) { refused.push(pid + ': not on the Players tab'); return; }
    Object.keys(patch[pid]).forEach(function (colName) {
      const c = head.indexOf(colName);
      if (c < 0) {
        refused.push(pid + ': Players has no ' + colName +
                     ' column — an administrator must run ensureSchema_()');
        return;
      }
      sh.getRange(rowIdx, c + 1).setValue(patch[pid][colName]);
      n++;
    });
  });
  return n;
}

/**
 * Take players off a roster.
 *
 * Removes the PlayerSeasons row, not the player. The Players row is left alone
 * on purpose: it carries his career, his other seasons and whatever his stat
 * rows point at, and deleting it to undo a typo would take all of that with it.
 *
 * A player with recorded stats for the season is refused. Every stat row joins
 * back through this row for team, position and eligibility, so removing it
 * would leave numbers attributed to a player who, as far as the season is
 * concerned, was never on the team.
 */
function apiDeletePlayers_(teamId, seasonId, playerSeasonIds) {
  const me = assertCanEdit_(teamId);
  seasonId = seasonId || CONFIG.CURRENT_SEASON;

  const want = (playerSeasonIds || []).map(String).filter(function (x) { return !!x; });
  if (!want.length) return { removed: 0, refused: [] };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    __tableCache = {};
    authRecheckBoundSession_();
    const sh = getTab_(CONFIG.TABS.PLAYER_SEASONS);
    const data = sh.getDataRange().getValues();
    const head = data[0].map(String);
    const cId = head.indexOf('PlayerSeasonID'),
          cPlayer = head.indexOf('PlayerID'),
          cTeam = head.indexOf('TeamID'),
          cSeason = head.indexOf('SeasonID'),
          cName = head.indexOf('DisplayName');

    // How many stat rows each player has this season, counted once.
    const statCount = {};
    rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (st) {
      if (String(st.SeasonID || '').trim() !== seasonId) return;
      const pid = String(st.PlayerID || '');
      if (pid) statCount[pid] = (statCount[pid] || 0) + 1;
    });

    const refused = [], remove = [], audit = [];

    want.forEach(function (psid) {
      var rowIdx = -1;
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][cId] || '') === psid) { rowIdx = r; break; }
      }
      if (rowIdx < 0) { refused.push(psid + ': not found'); return; }

      const row = data[rowIdx];
      const rowTeam = String(row[cTeam] || '').trim();
      if (rowTeam !== teamId && me.role !== 'ADMIN') {
        refused.push(psid + ': belongs to another team'); return;
      }
      if (String(row[cSeason] || '').trim() !== seasonId) {
        refused.push(psid + ': belongs to another season'); return;
      }

      const pid = String(row[cPlayer] || '');
      const name = String(row[cName] || pid);
      const n = statCount[pid] || 0;
      if (n) {
        refused.push(name + ': has ' + n + ' stat row' + (n === 1 ? '' : 's') +
                     ' this season. Remove the stats first, or leave him on the ' +
                     'roster — deleting him would orphan them.');
        return;
      }

      remove.push(rowIdx + 1);                     // 1-based sheet row
      audit.push(auditRow_(me, 'ROSTER_REMOVE', 'PlayerSeason', psid, '',
                          name, '', teamId + ' ' + seasonId));
    });

    // Delete from the bottom up: removing a row shifts every row beneath it,
    // and top-down deletion would take the wrong ones from the second onward.
    remove.sort(function (a, b) { return b - a; })
          .forEach(function (rowIdx) { sh.deleteRow(rowIdx); });

    if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }
    if (remove.length) {
      delete __tableCache[CONFIG.TABS.PLAYER_SEASONS];
      CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
      markDirty_('roster');
    }
    return { removed: remove.length, refused: refused };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Build an AuditLog row matching the schema ensureOpsTabs() creates. appendRows
 * maps objects onto the sheet by header name, so these keys must be exact or the
 * row lands blank.
 */
function auditRow_(me, action, entityType, entityId, field, oldV, newV, notes) {
  return {
    AuditID: '', Timestamp: new Date(), UserID: me.email, Role: me.role,
    Action: action, EntityType: entityType, EntityID: entityId, Field: field || '',
    OldValue: oldV === undefined || oldV === null ? '' : String(oldV),
    NewValue: newV === undefined || newV === null ? '' : String(newV),
    RequestID: '', Notes: notes || ''
  };
}

/**
 * Allocate the next PlayerID. Must be called while already holding the script
 * lock — nextId() in Database.gs takes the lock itself and would deadlock if
 * nested inside one.
 */
function nextPlayerIdLocked_() {
  const rows = rowsOf_(CONFIG.TABS.PLAYERS);
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    const m = String(rows[i].PlayerID || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  var n = String(max + 1);
  while (n.length < 6) n = '0' + n;
  return 'PLY-' + n;
}

/** NFHS rule 1-4-3: 0 through 99, no leading zeros. Blank stays blank. */
function normalizeJersey_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).trim());
  if (isNaN(n) || n < 0 || n > 99 || Math.floor(n) !== n)
    throw new Error('Jersey "' + v + '" is not a legal number (0-99).');
  return n;
}

function normalizeGpa_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (isNaN(n) || n < 0 || n > 5) throw new Error('GPA "' + v + '" is out of range.');
  return Math.round(n * 1000) / 1000;
}

function numOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

/** Add a player who is not yet on the roster. */
function apiAddPlayer_(teamId, seasonId, player) {
  const me = assertCanEdit_(teamId);
  seasonId = seasonId || CONFIG.CURRENT_SEASON;

  const name = String(player.name || '').trim();
  if (!name) throw new Error('A name is required.');
  const codes = parsePositions_(formatPositions_(player.positions || []));
  const err = validatePositions_(codes);
  if (err) throw new Error(err);

  // Validated before the lock is taken. A refusal that costs nobody the script
  // lock is a refusal that cannot make a second coach wait for a typo.
  const grad = profileGradYear_(player.grad);
  const commitment = profileText_(player.commitment || '', 120);
  const commitmentLevel = profileLevel_(player.commitmentLevel || '');
  const jersey = normalizeJersey_(player.jersey);
  const measured = {};
  MEASURABLES.forEach(function (m) {
    measured[m.col] = measurableValue_(m.key, player[m.key]);
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');
  try {
    __tableCache = {};
    authRecheckBoundSession_();
    // allocate inside our own lock; nextId() would take the lock again and hang
    const playerId = nextPlayerIdLocked_();
    appendRows_(CONFIG.TABS.PLAYERS, [{
      PlayerID: playerId, DisplayName: name,
      NameNormalized: name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
      GradYear: grad, FirstSeenSeason: seasonId,
      Commitment: commitment, CommitmentLevel: commitmentLevel,
      CreatedFrom: 'ROSTER_EDITOR:' + me.email
    }]);
    const seasonRow = {
      PlayerSeasonID: 'PS-' + seasonId.replace('SEA-', '') + '-' + playerId,
      PlayerID: playerId, TeamID: teamId, SeasonID: seasonId,
      Jersey: jersey, Positions: formatPositions_(codes),
      DisplayName: name, GradYear: grad
    };
    Object.keys(measured).forEach(function (c) { seasonRow[c] = measured[c]; });
    appendRows_(CONFIG.TABS.PLAYER_SEASONS, [seasonRow]);
    ensureOpsTabs_();
    appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'ROSTER_ADD', 'Player', playerId,
      '', '', name + ' (' + formatPositions_(codes) + ')', teamId + ' ' + seasonId)]);
    CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
    // a rebuild is not run inline — rosters change in bursts, and the sweep
    // trigger collapses a burst into a single recompute
    markDirty_('roster');
    return { playerId: playerId };
  } finally {
    lock.releaseLock();
  }
}