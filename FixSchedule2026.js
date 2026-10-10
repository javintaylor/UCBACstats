/**
 * UCBAC Stats — FixSchedule2026.gs
 *
 * One-time correction of the 2026 schedule against the conference's official
 * grid (checked cell by cell, weeks 2-9; week 1 was fixed separately).
 *
 * What was wrong, and what running fixSchedule2026() does about it:
 *
 *   1. Joppatowne had no week-2 game at all. ADDS Joppatowne at Benjamin
 *      Franklin, 9/11.
 *   2. Fallston and Perryville each carried TWO week-4 games; the grid has
 *      Fallston home vs Aberdeen and Perryville home vs Edgewood, both of
 *      which exist. DELETES the spurious extra (Fallston at Perryville).
 *   3. Four non-conference games faced the wrong way - the UCBAC school
 *      travels in all of them. FLIPS home and away:
 *        wk 4  Patterson Mill  at Chesapeake-AA   (was home)
 *        wk 5  Bohemia Manor   at Sussex Tech     (was home)
 *        wk 6  Perryville      at The Seed School (was home)
 *        wk 8  Elkton          at The Seed School (was home)
 *      Outside-school names are normalized on the way ("SEED" becomes
 *      "The Seed School", "Chesapeake" becomes "Chesapeake-AA").
 *
 * Run it from the editor: pick fixSchedule2026, press Run, read the log.
 * Safe to run twice - each step checks the row is still in its wrong state
 * before touching it, and nothing with a score entered is ever altered.
 * Delete this file once the log says every step is done.
 */

function fixSchedule2026_() {
  const sh = db_().getSheetByName('Games');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const col = function (n) {
    const i = head.indexOf(n);
    if (i < 0) throw new Error('Games has no column ' + n);
    return i;
  };
  const C = {
    id: col('GameID'), season: col('SeasonID'), week: col('Week'),
    phase: col('Phase'), type: col('GameType'),
    hid: col('HomeTeamID'), aid: col('AwayTeamID'),
    hs: col('HomeScore'), as: col('AwayScore'),
    status: col('Status'), date: col('GameDate'),
    hname: col('HomeTeamName'), aname: col('AwayTeamName')
  };
  const data = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), head.length).getValues();
  const out = [];
  const s_ = function (v) { return String(v === null || v === undefined ? '' : v).trim(); };

  const untouched = function (r, what) {
    if (s_(r[C.hs]) !== '' || s_(r[C.as]) !== '') { out.push('SKIPPED ' + what + ': a score is entered.'); return false; }
    return true;
  };

  // ---- flips: the UCBAC school travels ----
  const flips = [
    { gid: 'GAME-2026-0032', team: 'TEAM-013', opp: 'Chesapeake-AA' },
    { gid: 'GAME-2026-0036', team: 'TEAM-003', opp: 'Sussex Tech' },
    { gid: 'GAME-2026-0050', team: 'TEAM-014', opp: 'The Seed School' },
    { gid: 'GAME-2026-0062', team: 'TEAM-006', opp: 'The Seed School' }
  ];
  flips.forEach(function (f) {
    for (var i = 0; i < data.length; i++) {
      const r = data[i];
      if (s_(r[C.id]) !== f.gid) continue;
      if (s_(r[C.hid]) !== f.team) {
        out.push('ok      ' + f.gid + ' already flipped (' + s_(r[C.aname]) + ' at ' + s_(r[C.hname]) + ').');
        return;
      }
      if (!untouched(r, f.gid)) return;
      const row = i + 2;
      sh.getRange(row, C.aid + 1).setValue(r[C.hid]);       // school moves to away
      sh.getRange(row, C.aname + 1).setValue(r[C.hname]);
      sh.getRange(row, C.hid + 1).setValue('');             // outside school hosts
      sh.getRange(row, C.hname + 1).setValue(f.opp);
      out.push('FLIPPED ' + f.gid + ': ' + s_(r[C.hname]) + ' at ' + f.opp + '.');
      return;
    }
    out.push('MISSING ' + f.gid + ' — not found; nothing done.');
  });

  // ---- the spurious second week-4 game ----
  for (var i = 0; i < data.length; i++) {
    const r = data[i];
    if (s_(r[C.id]) !== 'GAME-2026-0034') continue;
    if (s_(r[C.aid]) === 'TEAM-007' && s_(r[C.hid]) === 'TEAM-014' && untouched(r, 'GAME-2026-0034')) {
      sh.deleteRow(i + 2);
      out.push('DELETED GAME-2026-0034 (Fallston at Perryville, week 4 — neither team plays it).');
    } else if (s_(r[C.aid]) !== 'TEAM-007' || s_(r[C.hid]) !== 'TEAM-014') {
      out.push('SKIPPED GAME-2026-0034: no longer Fallston at Perryville — look at it by hand.');
    }
    break;
  }

  // ---- Joppatowne's missing week 2 ----
  var joppW2 = data.some(function (r) {
    return s_(r[C.season]) === 'SEA-2026' && s_(r[C.week]) === '2' &&
           (s_(r[C.hid]) === 'TEAM-010' || s_(r[C.aid]) === 'TEAM-010');
  });
  if (joppW2) {
    out.push('ok      Joppatowne already has a week-2 game.');
  } else {
    var maxN = 0;
    data.forEach(function (r) {
      const m = s_(r[C.id]).match(/^GAME-2026-(\d+)$/);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    const gid = 'GAME-2026-' + ('0000' + (maxN + 1)).slice(-4);
    const row = new Array(head.length).fill('');
    row[C.id] = gid; row[C.season] = 'SEA-2026'; row[C.week] = 2;
    row[C.phase] = 'Week'; row[C.type] = 'NON_CONFERENCE';
    row[C.hid] = ''; row[C.hname] = 'Benjamin Franklin';
    row[C.aid] = 'TEAM-010'; row[C.aname] = 'Joppatowne';
    row[C.status] = 'SCHEDULED'; row[C.date] = new Date(2026, 8, 11);
    sh.appendRow(row);
    out.push('ADDED   ' + gid + ': Joppatowne at Benjamin Franklin, week 2 (9/11).');
  }

  if (typeof markDirty_ === 'function') markDirty_('games');
  const msg = out.join('\n') + '\n\nRun UCBAC Stats > Rebuild everything now, then delete this file.';
  /* The log, not an alert: this is run from the editor, and an alert there
     waits on a dialog in a spreadsheet tab nobody is watching until the six
     minute limit kills it. */
  Logger.log(msg);
  return msg;
}
