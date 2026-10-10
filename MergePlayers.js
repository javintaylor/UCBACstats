/**
 * UCBAC Stats — MergePlayers.gs
 *
 * Rejoins players who were split across two PlayerIDs.
 *
 * RepairPlayerIds.gs fixed the opposite fault: 151 IDs each held two different
 * people, so careers were two players added together. Renumbering separated them
 * correctly, but it did not then ask whether a renumbered ID and an existing one
 * were the SAME person seen in different seasons. Thirty-six were: Collin Rogers
 * holds 2025 and 2026 under one ID and 2024 under another, so his career now
 * undercounts by a season. That is the same failure as before wearing the other
 * face — one person reported as two instead of two reported as one.
 *
 * The merge rule is deliberately narrow, because a wrong merge invents a career
 * exactly the way the original bug did:
 *
 *   same normalized name  AND  same team  AND  no season in common
 *   AND  graduation years agree once formatting is normalized, or one is blank
 *
 * Two IDs that share a season are two people who happen to share a name -
 * UNLESS they share the season on the same team wearing the same number. A
 * team issues a number once, so "Isaiah Deyo #55" twice on Edgewood's 2026
 * roster is one player entered twice (a roster import beside an account he
 * registered himself, as a rule), and that pair is merged. Same season with
 * different numbers, or one number blank, is left alone and reported.
 *
 * ALWAYS run mergeSplitPlayersDryRun() first.
 */

const MP_SUFFIX = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1 };

function _mpNorm_(s_) {
  const toks = String(s_ === null || s_ === undefined ? '' : s_)
    .toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(function (t) { return t && !MP_SUFFIX[t]; });
  return toks.join('');
}

/** '2026', "26, '26.0' all mean the same class. Blank stays blank. */
function _mpGrad_(v) {
  const digits = String(v === null || v === undefined ? '' : v).replace(/[^\d]/g, '');
  if (!digits) return '';
  const two = digits.length >= 4 ? digits.slice(2, 4) : digits.slice(0, 2);
  return two.length === 2 ? two : '';
}

/**
 * Find every cluster of PlayerIDs that are the same person.
 * Returns { merges: [{keep, absorb[], name, teamId, seasons}], conflicts: [...] }
 */
function _mpPlan_() {
  const players = indexBy_(rowsOf_(CONFIG.TABS.PLAYERS), function (p) {
    return String(p.PlayerID || '').trim();
  });

  const teamOf = {}, seasonsOf = {}, seatOf = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (ps) {
    const pid = String(ps.PlayerID || '').trim();
    const tid = String(ps.TeamID || '').trim();
    if (!pid || !tid || !players[pid]) return;
    const sid = String(ps.SeasonID || '').trim();
    (teamOf[pid] = teamOf[pid] || {})[tid] = true;
    (seasonsOf[pid] = seasonsOf[pid] || {})[sid] = true;
    // the seat itself: which team, what number - the test for "entered twice"
    (seatOf[pid] = seatOf[pid] || {})[sid] = { team: tid, jersey: String(ps.Jersey === null || ps.Jersey === undefined ? '' : ps.Jersey).trim() };
  });

  // group by (team, normalized name)
  const groups = {};
  Object.keys(teamOf).forEach(function (pid) {
    const name = _mpNorm_(players[pid].DisplayName);
    if (!name) return;
    Object.keys(teamOf[pid]).forEach(function (tid) {
      const key = tid + '|' + name;
      (groups[key] = groups[key] || {})[pid] = true;
    });
  });

  const merges = [], conflicts = [];
  Object.keys(groups).forEach(function (key) {
    const ids = Object.keys(groups[key]).sort();
    if (ids.length < 2) return;
    const tid = key.split('|')[0];

    /* A season in common means different people who share a name - unless
       both seats are on this team wearing the same number, which is one
       player entered twice. Every shared season must pass that test. */
    var shared = false, twice = true, sameSeasons = {};
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        Object.keys(seasonsOf[ids[i]] || {}).forEach(function (s_) {
          if (!(seasonsOf[ids[j]] || {})[s_]) return;
          shared = true; sameSeasons[s_] = true;
          const a = (seatOf[ids[i]] || {})[s_] || {}, b = (seatOf[ids[j]] || {})[s_] || {};
          if (!(a.team === tid && b.team === tid && a.jersey && a.jersey === b.jersey)) twice = false;
        });
      }
    }
    const grads = {};
    ids.forEach(function (pid) {
      const g = _mpGrad_((players[pid] || {}).GradYear);
      if (g) grads[g] = true;
    });
    const gradConflict = Object.keys(grads).length > 1;

    if ((shared && !twice) || gradConflict) {
      conflicts.push({
        teamId: tid, name: String(players[ids[0]].DisplayName || ''), ids: ids,
        reason: shared && !twice
          ? 'share a season with different numbers — different people who share a name (if it is one player, remove the extra row on the portal Roster tab)'
          : 'graduation years disagree: ' + Object.keys(grads).join(' vs ')
      });
      return;
    }

    // keep the lowest-numbered id: it is the one the rest of the data grew around
    const keep = ids[0];
    const seasons = {};
    ids.forEach(function (pid) {
      Object.keys(seasonsOf[pid] || {}).forEach(function (s_) { seasons[s_] = true; });
    });
    merges.push({
      keep: keep, absorb: ids.slice(1), teamId: tid,
      name: String(players[keep].DisplayName || ''),
      seasons: Object.keys(seasons).sort(),
      // the same number in the same season: one player entered twice
      twice: shared ? Object.keys(sameSeasons).sort() : []
    });
  });

  return { merges: merges, conflicts: conflicts,
           unseated: _mpUnseated_(players, teamOf) };
}

function mergeSplitPlayersDryRun_() { return _mpRun_(false); }
function mergeSplitPlayersApply_()  { return _mpRun_(true); }

/* historical record comment removed */
function mergePlayersByIdDryRun_(absorbId, keepId) {
  return _mpRun_(false, _mpPairPlan_(absorbId, keepId));
}
function mergePlayersByIdApply_(absorbId, keepId) {
  return _mpRun_(true, _mpPairPlan_(absorbId, keepId));
}

function _mpPairPlan_(absorbId, keepId) {
  const absorb = String(absorbId || '').trim().toUpperCase();
  const keep = String(keepId || '').trim().toUpperCase();
  if (!absorb || !keep) throw new Error('Two PlayerIDs are needed, like PLY-EXAMPLE and PLY-EXAMPLE.');
  if (absorb === keep) throw new Error(keep + ' cannot absorb itself.');

  const byId = {};
  rowsOf_(CONFIG.TABS.PLAYERS).forEach(function (p) {
    const id = String(p.PlayerID || '').trim();
    if (id) byId[id] = p;
  });
  [absorb, keep].forEach(function (id) {
    if (!byId[id])
      throw new Error(id + ' is not on the Players tab. If something still refers ' +
                      'to it, run Maintenance > Restore orphaned players first — ' +
                      'a career cannot be merged into a row that is not there.');
  });

  const seasons = {}, teams = {};
  rowsOf_(CONFIG.TABS.PLAYER_SEASONS).forEach(function (r) {
    const pid = String(r.PlayerID || '').trim();
    if (pid !== absorb && pid !== keep) return;
    if (String(r.SeasonID || '').trim()) seasons[String(r.SeasonID).trim()] = true;
    if (String(r.TeamID || '').trim()) teams[String(r.TeamID).trim()] = true;
  });

  return {
    merges: [{ keep: keep, absorb: [absorb], teamId: Object.keys(teams).join('/'),
               name: String(byId[keep].DisplayName || '') + '  <- ' +
                     String(byId[absorb].DisplayName || ''),
               seasons: Object.keys(seasons).sort(), twice: [] }],
    conflicts: []
  };
}

/**
 * Players who share a name with somebody, and hold no seat in any season.
 *
 * The grouping above is built from PlayerSeasons, so a Players row with no
 * seat never enters a group and the merge tool cannot see it at all — it is
 * not refused, it is invisible. Nine such rows are why "Jeremiah Smith" sits
 * unresolvable on the stat resolver: two records answer to the name, so the
 * resolver will not guess, and the merge tool never offers to remove one.
 *
 * Nothing is merged from this. A row with no seat is not automatically a
 * duplicate — CreatedFrom says where it came from, and the answer differs:
 * a boy who registered an account and was never rostered is a real person
 * with a real claim on his stats, while a row a roster import made twice is
 * an artifact. So this reports the evidence and leaves the decision alone.
 */
/**
 * What a player record actually holds, across every table that names one.
 *
 * CreatedFrom turned out to be blank on almost all of these — they predate the
 * column — so provenance cannot decide it. This can. A record with no seat, no
 * stat row, no account, no award, no correction and no audit entry holds
 * nothing: there is no career behind it and nobody can sign in as it. Whether
 * it was once a real boy is then beside the point, because removing it takes
 * nothing away from anyone, and leaving it makes his namesake's stats
 * unresolvable forever.
 *
 * A record that holds something is a different matter entirely, and this only
 * counts. It never decides.
 */
function _mpHoldings_(pids) {
  const want = {};
  pids.forEach(function (p) { want[p] = {}; });
  const targets = [CONFIG.TABS.PLAYER_STATS, CONFIG.TABS.PLAYER_SEASONS,
                   'Accounts', 'Awards', CONFIG.TABS.CORRECTIONS]
                  .filter(function (t) { return t && hasTab_(t); });
  targets.forEach(function (tab) {
    rowsOf_(tab).forEach(function (r) {
      const p = String(r.PlayerID || '').trim();
      if (want[p]) want[p][tab] = (want[p][tab] || 0) + 1;
    });
  });
  if (hasTab_(CONFIG.TABS.AUDIT)) {
    rowsOf_(CONFIG.TABS.AUDIT).forEach(function (a) {
      const p = String(a.EntityID || '').trim();
      if (want[p] && String(a.EntityType || '').trim() === 'Player')
        want[p][CONFIG.TABS.AUDIT] = (want[p][CONFIG.TABS.AUDIT] || 0) + 1;
    });
  }
  return want;
}

/** '' when the record holds nothing at all, else 'Accounts 1, Awards 2'. */
function _mpHoldingText_(h) {
  return Object.keys(h || {}).sort().map(function (t) { return t + ' ' + h[t]; }).join(', ');
}

function _mpUnseated_(players, teamOf) {
  const byName = {};
  Object.keys(players).forEach(function (pid) {
    const n = _mpNorm_(players[pid].DisplayName);
    if (n) (byName[n] = byName[n] || []).push(pid);
  });
  const out = [];
  Object.keys(byName).forEach(function (n) {
    const ids = byName[n].sort();
    if (ids.length < 2) return;
    const seated = ids.filter(function (p) { return teamOf[p]; });
    const loose = ids.filter(function (p) { return !teamOf[p]; });
    if (!seated.length || !loose.length) return;
    out.push({ name: String(players[ids[0]].DisplayName || ''), seated: seated, loose: loose,
               players: players });
  });
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });

  // what each loose record holds, counted once across every table
  const loosePids = [];
  out.forEach(function (u) { u.loose.forEach(function (p) { loosePids.push(p); }); });
  const held = loosePids.length ? _mpHoldings_(loosePids) : {};
  out.forEach(function (u) { u.held = held; });
  return out;
}

function _mpUnseatedReport_(unseated) {
  if (!unseated || !unseated.length) return [];
  const held = unseated[0].held || {};
  const inert = function (pid) { return !Object.keys(held[pid] || {}).length; };

  var empty = 0, holding = 0;
  unseated.forEach(function (u) {
    u.loose.forEach(function (p) { if (inert(p)) empty++; else holding++; });
  });

  const out = ['', 'NEVER SEATED — a second record for the name, on no roster in any season:'];
  unseated.slice(0, 25).forEach(function (u) {
    const P = u.players;
    out.push('  ' + u.name);
    u.seated.forEach(function (pid) {
      out.push('      ' + pid + '  on a roster' +
               (P[pid].GradYear ? ', class of ' + P[pid].GradYear : ''));
    });
    u.loose.forEach(function (pid) {
      const what = _mpHoldingText_(held[pid]);
      out.push('      ' + pid + '  NO SEAT' +
               (P[pid].GradYear ? ', class of ' + P[pid].GradYear : '') +
               (what ? '  — holds ' + what : '  — holds nothing') +
               (String(P[pid].CreatedFrom || '').trim()
                 ? ', created by ' + String(P[pid].CreatedFrom).trim() : ''));
    });
  });
  if (unseated.length > 25) out.push('  ...and ' + (unseated.length - 25) + ' more');

  out.push('');
  out.push('  ' + empty + ' of these hold nothing at all — no stats, no account, no awards,');
  out.push('  no corrections, no history. Removing one takes nothing from anybody, and');
  out.push('  leaving it keeps his namesake\'s stat rows unresolvable.');
  if (holding)
    out.push('  ' + holding + ' hold something and are listed above with what. Read those before ' +
             'touching them.');
  out.push('  Nothing here is removed automatically.');
  return out;
}

function _mpRun_(apply, plan) {
  plan = plan || _mpPlan_();
  const out = [];
  out.push(apply ? 'APPLYING' : 'DRY RUN — nothing will be written');
  out.push('');
  out.push('Merges: ' + plan.merges.length + '   Left alone: ' + plan.conflicts.length);

  if (!plan.merges.length) {
    /* "No split identities found" printed beside "Left alone: 9" is a
       contradiction, and the nine were the only thing worth reading. */
    out.push(plan.conflicts.length
      ? '\nNothing can be merged by rule. What was found and refused:'
      : '\nNo split identities found.');
    plan.conflicts.slice(0, 20).forEach(function (c) {
      out.push('  ' + c.name + '  ' + c.ids.join(', ') + '  — ' + c.reason);
    });
    if (plan.conflicts.length > 20)
      out.push('  ...and ' + (plan.conflicts.length - 20) + ' more');
    _mpUnseatedReport_(plan.unseated).forEach(function (l) { out.push(l); });
    const m0 = out.join('\n');
    Logger.log(m0);
    return m0;
  }

  const remap = {};
  plan.merges.forEach(function (m) {
    m.absorb.forEach(function (pid) { remap[pid] = m.keep; });
  });

  out.push('');
  plan.merges.slice(0, 40).forEach(function (m) {
    out.push('  ' + m.name + '  ' + m.absorb.join(', ') + ' -> ' + m.keep +
             '   [' + m.seasons.join(' ') + ']' +
             (m.twice && m.twice.length ? '   entered twice in ' + m.twice.join(' ') + ', same number' : ''));
  });
  if (plan.merges.length > 40) out.push('  ...and ' + (plan.merges.length - 40) + ' more');

  if (plan.conflicts.length) {
    out.push('');
    out.push('LEFT ALONE — these need a human, not a rule:');
    plan.conflicts.slice(0, 20).forEach(function (c) {
      out.push('  ' + c.name + '  ' + c.ids.join(', ') + '  — ' + c.reason);
    });
  }
  if (!apply) _mpUnseatedReport_(plan.unseated).forEach(function (l) { out.push(l); });

  /* Every table that names a player by id, not just the two holding his
     numbers. The absorbed Players rows are deleted at the end of this, so a
     reference left behind does not point at an old career - it points at
     nothing. An Accounts row is the one that matters most: a player whose
     PlayerID no longer exists cannot reach his own profile, and he did nothing
     wrong but share a name with somebody. */
  const targets = [CONFIG.TABS.PLAYER_STATS, CONFIG.TABS.PLAYER_SEASONS,
                   'Accounts', 'Awards', CONFIG.TABS.CORRECTIONS]
                  .filter(function (t) { return t && hasTab_(t); });
  const counts = {};
  targets.forEach(function (tab) {
    counts[tab] = rowsOf_(tab).filter(function (r) {
      return remap[String(r.PlayerID || '').trim()];
    }).length;
  });
  /* The audit log names its subject in EntityID rather than PlayerID. Career
     rows are repointed; PlayerSeason rows are left, because the seat keeps its
     own PlayerSeasonID through a merge and those references still resolve. */
  const auditMoves = hasTab_(CONFIG.TABS.AUDIT)
    ? rowsOf_(CONFIG.TABS.AUDIT).filter(function (a) {
        return String(a.EntityType || '').trim() === 'Player' &&
               remap[String(a.EntityID || '').trim()];
      }).length
    : 0;
  out.push('');
  targets.forEach(function (tab) { out.push('  ' + tab + ': ' + counts[tab] + ' rows would move'); });
  if (auditMoves) out.push('  ' + CONFIG.TABS.AUDIT + ': ' + auditMoves + ' rows would move');
  if (counts['Accounts'])
    out.push('  (' + counts['Accounts'] + ' sign-in account(s) follow their player — ' +
             'without this they would point at a deleted career)');

  if (!apply) {
    out.push('');
    out.push('Nothing was written. Run mergeSplitPlayersApply_() to proceed,');
    out.push('then rebuild — every career computed before this is short a season.');
    const m1 = out.join('\n');
    Logger.log(m1);
    return m1;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Database busy — try again.');
  try {
    // rewrite the PlayerID column in place on each table that references one
    targets.forEach(function (tab) {
      const sh = getTab_(tab);
      const data = sh.getDataRange().getValues();
      const col = data[0].map(String).indexOf('PlayerID');
      if (col < 0) return;
      const write = [];
      var moved = 0;
      for (var r = 1; r < data.length; r++) {
        const cur = String(data[r][col] || '').trim();
        const to = remap[cur];
        if (to) { write.push([to]); moved++; } else { write.push([data[r][col]]); }
      }
      if (write.length) sh.getRange(2, col + 1, write.length, 1).setValues(write);
      out.push('  ' + tab + ': ' + moved + ' rows moved');
    });

    /* The audit log follows its subject. Those rows are the record of what a
       person entered about himself, and the roster importer reads them to know
       which fields it may not overwrite - pointed at a deleted career they
       would stop protecting anything. */
    if (hasTab_(CONFIG.TABS.AUDIT)) {
      const ash = getTab_(CONFIG.TABS.AUDIT);
      const adata = ash.getDataRange().getValues();
      const eCol = adata[0].map(String).indexOf('EntityID');
      const tCol = adata[0].map(String).indexOf('EntityType');
      if (eCol >= 0 && adata.length > 1) {
        const awrite = [];
        var amoved = 0;
        for (var a = 1; a < adata.length; a++) {
          const isPlayer = tCol < 0 || String(adata[a][tCol] || '').trim() === 'Player';
          const to = isPlayer ? remap[String(adata[a][eCol] || '').trim()] : null;
          if (to) { awrite.push([to]); amoved++; } else { awrite.push([adata[a][eCol]]); }
        }
        ash.getRange(2, eCol + 1, awrite.length, 1).setValues(awrite);
        out.push('  ' + CONFIG.TABS.AUDIT + ': ' + amoved + ' rows moved');
      }
    }

    /* Everything that POINTS AT a player has been moved. What was never moved
       is what the absorbed row itself held: his email, his birth date, the note
       saying he registered himself, his class, his Hudl link, his bio. Those
       live in the Players row, and the row was about to be deleted with them
       still in it — so merging the boy who had signed up into the roster copy
       of himself quietly threw away the record that he had.

       So the keeper takes anything it is missing before the other row goes. A
       cell the keeper already has is never overwritten: the keeper is the
       identity being kept, and its own values are the ones a person chose. */
    const psh = getTab_(CONFIG.TABS.PLAYERS);
    const pdata = psh.getDataRange().getValues();
    const phead = pdata[0].map(String);
    const pcol = phead.indexOf('PlayerID');
    const rowAt = {};
    for (var r0 = 1; r0 < pdata.length; r0++) rowAt[String(pdata[r0][pcol] || '').trim()] = r0;

    const blank = function (v) { return v === '' || v === null || v === undefined; };
    const filled = {};                       // keeper row index -> [column names]
    Object.keys(remap).forEach(function (from) {
      const a = rowAt[from], b = rowAt[remap[from]];
      if (a === undefined || b === undefined) return;
      for (var c = 0; c < phead.length; c++) {
        if (!phead[c] || c === pcol) continue;
        if (blank(pdata[b][c]) && !blank(pdata[a][c])) {
          pdata[b][c] = pdata[a][c];
          (filled[b] = filled[b] || []).push(phead[c]);
        }
      }
    });
    const carried = [];
    Object.keys(filled).forEach(function (b) {
      psh.getRange(Number(b) + 1, 1, 1, phead.length).setValues([pdata[Number(b)]]);
      carried.push(String(pdata[Number(b)][pcol]).trim() + ' (' + filled[b].join(', ') + ')');
    });
    if (carried.length) {
      out.push('  Players: fields carried onto the kept row where it had none —');
      carried.slice(0, 20).forEach(function (x) { out.push('    ' + x); });
      if (carried.length > 20) out.push('    …and ' + (carried.length - 20) + ' more');
    }

    // the absorbed Players rows are now unreferenced; drop them so a merged
    // player does not keep a second, statless profile page
    var dropped = 0;
    for (var r2 = pdata.length - 1; r2 >= 1; r2--) {
      if (remap[String(pdata[r2][pcol] || '').trim()]) { psh.deleteRow(r2 + 1); dropped++; }
    }
    out.push('  Players: ' + dropped + ' duplicate profiles removed');

    // a merged player may now hold two PlayerSeasons rows for one season if both
    // halves carried the same year; that would double-count, so collapse them
    const dedup = _mpDedupePlayerSeasons_();
    if (dedup) out.push('  PlayerSeasons: ' + dedup + ' duplicate season rows collapsed');
  } finally {
    lock.releaseLock();
  }

  __tableCache = {};
  CacheService.getScriptCache().removeAll(['boot']);
  if (typeof markDirty_ === 'function') markDirty_('merge');
  out.push('');
  out.push('Written. Run "Rebuild everything now" — careers computed before this');
  out.push('merge were each missing a season.');
  const m2 = out.join('\n');
  Logger.log(m2);
  return m2;
}

/** Collapse duplicate (PlayerID, SeasonID) rows, keeping the fullest one. */
function _mpDedupePlayerSeasons_() {
  const sh = getTab_(CONFIG.TABS.PLAYER_SEASONS);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(String);
  const cP = head.indexOf('PlayerID'), cS = head.indexOf('SeasonID');
  if (cP < 0 || cS < 0) return 0;

  const seen = {}, drop = [];
  for (var r = 1; r < data.length; r++) {
    const key = String(data[r][cP] || '').trim() + '|' + String(data[r][cS] || '').trim();
    if (!key.replace('|', '')) continue;
    const filled = data[r].filter(function (v) { return v !== '' && v !== null; }).length;
    if (seen[key] === undefined) { seen[key] = { row: r, filled: filled }; continue; }
    // keep whichever row carries more information
    if (filled > seen[key].filled) { drop.push(seen[key].row); seen[key] = { row: r, filled: filled }; }
    else drop.push(r);
  }
  drop.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r + 1); });
  return drop.length;
}
/**
 * Merge a pair a person names, from the menu.
 *
 * Two prompts and a confirmation, because this is the destructive half and the
 * pair arrived by human judgement rather than by a rule. The dry run runs first
 * whatever the operator does, and its text is what the confirmation shows — so
 * the seasons on both sides are on screen at the moment of deciding, which is
 * the only place they are of any use.
 */
function menuMergePairApply() {
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('Merge two players — step 1 of 2',
    'PlayerID to ABSORB (the duplicate; its row is deleted):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return 'Cancelled.';
  const b = ui.prompt('Merge two players — step 2 of 2',
    'PlayerID to KEEP (everything moves onto this one):', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return 'Cancelled.';

  const preview = mergePlayersByIdDryRun_(a.getResponseText(), b.getResponseText());
  const ok = ui.alert('Merge two players — confirm',
    preview.slice(0, 3000) +
    '\n\nRead the names and seasons above. Two boys who share a name are NOT ' +
    'one player.\n\nMerge them?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return 'Cancelled — nothing was written.';

  const msg = mergePlayersByIdApply_(a.getResponseText(), b.getResponseText());
  ui.alert('Merge two players — applied',
    (msg.length > 4000 ? msg.slice(0, 4000) + '\n\n…full report in View > Logs' : msg) +
    '\n\nRun Rebuild everything now.', ui.ButtonSet.OK);
  return msg;
}
