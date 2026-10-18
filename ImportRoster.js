/**
 * UCBAC Stats — ImportRoster.gs
 *
 * Rebuild the CURRENT season's rosters from the conference's roster sheet —
 * the CSV with columns School, #, Player Name, Grad., Position, Height,
 * Weight, 40 time, Bench Max, Squat Max, GPA, Offers.
 *
 * To use: File > Import > Upload the CSV > Insert new sheet(s), then run
 * UCBAC Stats > Maintenance > Import rosters (dry run). The importer finds
 * the tab by its header row, so the tab's name does not matter.
 *
 * What it does, per CSV row:
 *   - resolves the school (Bo Manor, CMW and HDG are spelled out for it)
 *   - matches the player against the Players tab by exact normalized name,
 *     creating him when he is new
 *   - moves or creates his current-season roster row under the CSV's school —
 *     this is the correction: players seated on the wrong team move
 *   - fills jersey, grad, positions, height, weight, 40, bench, squat, GPA
 *     from the CSV where the CSV has a value; a blank never erases anything
 *   - reads the Offers column: a school marked ✔ becomes his Commitment, the
 *     rest become his Offers — filled only where his profile is blank, so a
 *     player who already updated his own is never overwritten
 *
 * A current-season roster row for a player the file does not name is REMOVED,
 * with three exceptions, each kept and listed instead:
 *   - he has stats recorded this season, and deleting the seat would orphan them
 *   - a person is behind the seat: he holds an account, or has entered his own
 *     information. A file's silence is evidence about a PDF, not about whether
 *     somebody left the team, and it must not delete work a person did
 *   - his school is not in the file at all, which says nothing about him
 *
 * Names in the sheet carry stars, checkmarks and injury notes; all of that is
 * stripped before matching. ("Anthony Hall (shoulder fx/dis)" is Anthony Hall.)
 */

const IMPROSTER = {
  ALIASES: {
    'bo manor': 'bohemia manor',
    'cmw': 'c milton wright',
    'hdg': 'havre de grace',
    'harford tech': 'harford technical'
  },
  /* When a file would take this many seats off a school, AND that many is this
     share of the school's roster, it is a partial list rather than a roster and
     is refused. Both must be true: a small squad losing three of five is a real
     roster change, and a big squad losing five of forty is a graduating class.
     Emptying a team is neither. */
  WIPE_MIN: 6,
  WIPE_SHARE: 0.5
};

function importRosterDryRun_() { return importRosterRun_(false); }
function importRosterApply_()  { return importRosterRun_(true); }

function menuImportRosterDry()   { return importRosterAlert_(importRosterRun_(false)); }
function menuImportRosterApply() { return importRosterAlert_(importRosterRun_(true)); }
function importRosterAlert_(msg) {
  try {
    SpreadsheetApp.getUi().alert('Roster import',
      msg.length > 6000 ? msg.slice(0, 6000) + '\n\n…full report in View > Logs' : msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

function irNorm_(v) {
  return String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/** "Xzaiver Whittington⭐️⭐️⭐️" / "Anthony Hall (shoulder fx/dis)" -> the name. */
function irCleanName_(v) {
  return String(v || '')
    .replace(/\([^)]*\)/g, ' ')                       // injury notes
    .replace(/[⭐✅✔️⃣❌❤]/g, ' ')  // stars, checks
    .replace(/[\uD800-\uDFFF]/g, ' ')                 // any other emoji surrogate
    .replace(/["“”]/g, '')                  // "JJ" style quote marks
    .replace(/\s+/g, ' ').trim();
}

/**
 * A name as the two things a roster and a box score agree on: the first
 * initial and the surname. "K. Sorrells", "Kristian Sorrells" and "Sorrells,
 * Kristian" are one boy; a suffix is not part of who he is.
 */
const IR_SUFFIX = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, v: 1 };
function irNameParts_(name) {
  const toks = irNorm_(name).split(' ').filter(function (t) { return t && !IR_SUFFIX[t]; });
  if (!toks.length) return null;
  return { initial: toks[0].charAt(0), surname: toks[toks.length - 1] };
}

/** 6'0, 6'4", 5'10" -> inches. Anything unreadable -> ''. */
function irHeight_(v) {
  const m = String(v || '').match(/(\d)\s*'\s*(\d{1,2})/);
  if (!m) return '';
  const inches = Number(m[1]) * 12 + Number(m[2]);
  return (inches >= 48 && inches <= 90) ? inches : '';
}

function irNum_(v, lo, hi) {
  const m = String(v === null || v === undefined ? '' : v).match(/-?\d+(\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  if (isNaN(n)) return '';
  if (lo !== undefined && (n < lo || n > hi)) return '';
  return n;
}

function irGrad_(v) {
  const m = String(v || '').match(/\b(\d{2})\b|\b(20\d{2})\b/);
  if (!m) return '';
  const n = m[2] ? Number(m[2]) : 2000 + Number(m[1]);
  return (n >= 2020 && n <= 2035) ? n : '';
}

/**
 * "Culver Stockton✔️ Defiance, Howard" ->
 *   { commit: 'Culver Stockton', offers: ['Culver Stockton','Defiance','Howard'] }
 * The ✔ binds to the school before it; text after it in the same clause is the
 * next school even without a comma.
 */
function irOffers_(v) {
  var txt = String(v || '').replace(/[✅✔]️?/g, '✔,');
  var commit = '';
  const offers = [];
  txt.split(',').forEach(function (part) {
    var name = irCleanName_(part.replace(/✔/g, ''));
    var isCommit = part.indexOf('✔') >= 0;
    if (!name) return;
    if (name.length > 60) name = name.slice(0, 60);
    if (isCommit && !commit) commit = name;
    if (offers.indexOf(name) < 0) offers.push(name);
  });
  return { commit: commit, offers: offers };
}

/**
 * Everyone who has put their own information into this site.
 *
 * Protecting a field is not enough on its own. A player who signed up, entered
 * his forty, his bench and his squat, and is simply not on the MaxPreps sheet
 * his school last published would have had the whole seat deleted - and with
 * it every field the protection was carefully declining to overwrite. A roster
 * file's silence about a player is not evidence that he left the team; it is
 * evidence about a PDF.
 *
 * So a seat with a person behind it is kept and reported rather than removed.
 * If he really has left, an administrator takes the seat off deliberately,
 * which is the only way work somebody did should ever be thrown away.
 *
 * Keyed by both PlayerID and PlayerSeasonID, since a profile edit is logged
 * against whichever row it changed.
 */
function irProfileAuthors_() {
  const people = {};
  if (hasTab_(CONFIG.TABS.AUDIT)) {
    rowsOf_(CONFIG.TABS.AUDIT).forEach(function (a) {
      const action = String(a.Action || '').trim();
      if (action !== 'PROFILE_EDIT' && action !== 'PROFILE_RENAME') return;
      const id = String(a.EntityID || '').trim();
      if (id) {
        people[id] = true;
        people[m15Canonical_(id, String(a.EntityType || '').trim() === 'PlayerSeason')] = true;
      }
    });
  }
  // A registered account is a person too, even one who has typed nothing yet.
  if (hasTab_('Accounts')) {
    rowsOf_('Accounts').forEach(function (r) {
      const pid = String(r.PlayerID || '').trim();
      const status = String(r.Status || '').trim().toUpperCase();
      if (pid && status !== 'REJECTED' && status !== 'REVOKED') people[pid] = true;
    });
  }
  return people;
}

/**
 * Every field a person has typed for themselves, which no roster file may
 * overwrite.
 *
 * A bulk import and a player's own portal write the same cells, and the file is
 * the one that knows less: a MaxPreps sheet carries a height and a weight and
 * nothing else, while a player enters his forty, his bench, his squat, and a
 * height he has actually been measured at since. Refreshing from the file has
 * to leave those alone or every import quietly undoes a season of entries.
 *
 * The authority is the audit log, not blankness. Blankness cannot tell a value
 * a player typed from a value the last import left behind, and treating both as
 * untouchable would freeze the roster - a junior who grew an inch could never
 * be corrected. Profile.gs writes a PROFILE_EDIT row naming the entity and the
 * exact column for every field a person changes, so that, and only that, is
 * what gets held back.
 *
 * Coaches edit profiles on a player's behalf through the same path and leave
 * the same audit row. That counts: a person beats a file, whichever person.
 *
 * Keyed 'EntityID|ColumnName' - PlayerSeasonID for a seat field, PlayerID for
 * a career one.
 */
function irProtectedFields_() {
  const held = {};
  if (!hasTab_(CONFIG.TABS.AUDIT)) return held;        // no log yet, nothing entered
  rowsOf_(CONFIG.TABS.AUDIT).forEach(function (a) {
    if (String(a.Action || '').trim() !== 'PROFILE_EDIT') return;
    const id = String(a.EntityID || '').trim();
    const field = String(a.Field || '').trim();
    if (id && field) {
      held[id + '|' + field] = true;
      held[m15Canonical_(id, String(a.EntityType || '').trim() === 'PlayerSeason') + '|' + field] = true;
    }
  });
  return held;
}

/**
 * The imported tab, found by its header row rather than its name.
 *
 * This used to return the first sheet that looked like a roster, and last
 * season's import is still sitting in the workbook looking exactly like one.
 * A new file went in, the old tab came first, and the whole import ran against
 * a year-old roster while reporting numbers that looked perfectly reasonable.
 *
 * So: an ambiguous workbook is refused rather than guessed at. Name the sheet
 * you mean "RosterImport" and it wins outright; otherwise there must be exactly
 * one candidate. Either way importRosterRun names the sheet it read at the top
 * of its report, because the failure here is silent by nature - every number
 * downstream is plausible, just about the wrong file.
 */
function irFindTab_() {
  const found = [];
  const sheets = db_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 3) continue;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).toLowerCase().trim(); });
    if (head.indexOf('school') >= 0 && head.indexOf('player name') >= 0) found.push(sh);
  }

  /* "Not found" covers three different mistakes, and the old message named
     only one of them. So say which workbook was searched — the menu reads the
     database by ID, not whatever is on screen — and point at whichever near
     miss is actually sitting there. */
  if (!found.length) {
    const first = function (sh) { return String(sh.getRange(1, 1).getValue() || ''); };
    // A CSV pasted rather than imported lands whole in column A: every header
    // in one cell, one column wide. It reads correctly on screen and matches
    // nothing.
    const glued = sheets.filter(function (sh) {
      return sh.getLastRow() >= 2 && sh.getLastColumn() < 3 && /school\s*,/i.test(first(sh));
    });
    // and a sheet that says School but not Player Name is the stats file
    const near = sheets.filter(function (sh) {
      return sh.getLastRow() >= 2 && sh.getLastColumn() >= 3 && /^school$/i.test(first(sh).trim());
    }).map(function (sh) { return sh.getName(); });

    throw new Error('No imported roster tab found in "' + db_().getName() + '" (' +
      sheets.length + ' sheets searched).\n\n' +
      (glued.length
        ? 'The sheet "' + glued[0].getName() + '" holds the whole CSV in column A, so it ' +
          'was pasted rather than imported. Select column A and use Data > Split text to ' +
          'columns, or delete the sheet and use File > Import > Insert new sheet.'
        : 'File > Import the CSV into this spreadsheet first, choosing "Insert new sheet" — ' +
          'the importer finds it by its School / Player Name header row, not by its name.') +
      (near.length ? '\n\nSheets starting with School: ' + near.join(', ') +
                     '  (a roster file needs a Player Name column too)' : '') +
      '\n\nThe menu reads the database by ID, so a copy of the workbook will not do — ' +
      'the CSV has to go into this one.');
  }

  const named = found.filter(function (sh) {
    return /^\s*rosterimport\s*$/i.test(String(sh.getName()).replace(/[\s_-]/g, ''));
  });
  if (named.length === 1) return named[0];

  if (found.length > 1)
    throw new Error('More than one sheet looks like a roster file, and picking the ' +
                    'wrong one silently imports the wrong season:\n\n  ' +
                    found.map(function (sh) {
                      return sh.getName() + '  (' + (sh.getLastRow() - 1) + ' rows)';
                    }).join('\n  ') +
                    '\n\nRename the one you want to "RosterImport", or delete the others.');

  return found[0];
}

function importRosterRun_(apply) {
  const seasonId = CONFIG.CURRENT_SEASON;
  // Class of 2026 graduated in the spring of 2026; the 2026 season is the fall
  // AFTER that walk. Anyone whose class year is not past the season's year is
  // an alumnus, and an alumnus does not get a roster seat.
  const seasonYear = Number(String(seasonId).replace(/\D/g, '')) || 0;
  const sh = irFindTab_();
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).toLowerCase().trim(); });
  const c = function (name) { return head.indexOf(name); };
  const cSchool = c('school'), cJersey = c('#'), cName = c('player name'),
        cGrad = c('grad.') >= 0 ? c('grad.') : c('grad'),
        cPos = c('position'), cHt = c('height'), cWt = c('weight'),
        cForty = c('40 time'), cBench = c('bench max'), cSquat = c('squat max'),
        cGpa = c('gpa'), cOffers = c('offers');

  // school name -> TeamID, aliases included
  const teamByNorm = {};
  rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
    const id = String(t.TeamID || '').trim();
    if (!id) return;
    [t.DisplayName, t.SchoolName, t.Slug].forEach(function (n) {
      const k = irNorm_(n);
      if (k) teamByNorm[k] = id;
    });
  });
  Object.keys(IMPROSTER.ALIASES).forEach(function (a) {
    const target = teamByNorm[IMPROSTER.ALIASES[a]];
    if (target) teamByNorm[a] = target;
  });

  // desired roster from the CSV, deduped per school by name
  const wanted = {};                 // teamId|norm -> person
  const badSchools = {};
  for (var r = 1; r < values.length; r++) {
    const school = irNorm_(values[r][cSchool]);
    const name = irCleanName_(values[r][cName]);
    if (!school || !name) continue;
    const teamId = teamByNorm[school];
    if (!teamId) { badSchools[String(values[r][cSchool])] = true; continue; }

    const key = teamId + '|' + irNorm_(name);
    const off = cOffers >= 0 ? irOffers_(values[r][cOffers]) : { commit: '', offers: [] };
    const person = wanted[key] || (wanted[key] = {
      teamId: teamId, name: name, norm: irNorm_(name),
      jersey: '', grad: '', codes: [], ht: '', wt: '', forty: '', bench: '',
      squat: '', gpa: '', commit: '', offers: []
    });
    // first non-blank wins — the sheet repeats some players
    if (!person.jersey && cJersey >= 0) person.jersey = irNum_(values[r][cJersey], 0, 99);
    if (!person.grad && cGrad >= 0) person.grad = irGrad_(values[r][cGrad]);
    if (!person.codes.length && cPos >= 0) {
      const legacy = String(values[r][cPos] || '');
      // "TE/LB" keeps its LB: see rosterCodesFromLegacy for why the plain
      // normalizer's codes were not enough
      if (legacy) person.codes = rosterCodesFromLegacy_(legacy);
    }
    if (!person.ht && cHt >= 0) person.ht = irHeight_(values[r][cHt]);
    if (!person.wt && cWt >= 0) person.wt = irNum_(values[r][cWt], 80, 450);
    if (!person.forty && cForty >= 0) person.forty = irNum_(values[r][cForty], 4, 8);
    if (!person.bench && cBench >= 0) person.bench = irNum_(values[r][cBench], 45, 700);
    if (!person.squat && cSquat >= 0) person.squat = irNum_(values[r][cSquat], 45, 1000);
    if (!person.gpa && cGpa >= 0) person.gpa = irNum_(values[r][cGpa], 0, 5);
    if (!person.commit) person.commit = off.commit;
    if (!person.offers.length) person.offers = off.offers;
  }

  // the graduated: known class year, and it is not after this season's year.
  // A blank grad is unknown, not graduated — those stay.
  var graduated = 0;
  Object.keys(wanted).forEach(function (key) {
    const w = wanted[key];
    if (w.grad !== '' && Number(w.grad) <= seasonYear) {
      graduated++;
      delete wanted[key];
    }
  });

  // who exists already
  const players = rowsOf_(CONFIG.TABS.PLAYERS);
  const byNorm = {};                 // norm name -> [player rows]
  const plById0 = {};                // pid -> player row, for the stored name
  players.forEach(function (p) {
    plById0[String(p.PlayerID || '').trim()] = p;
    const k = irNorm_(p.DisplayName);
    if (!k) return;
    (byNorm[k] = byNorm[k] || []).push(p);
  });
  // Approved archived spellings join only the name index, never live profiles.
  m15NameRows_(players).slice(players.length).forEach(function(p) {
    const key = irNorm_(p.DisplayName);
    if (key && !(byNorm[key] || []).some(function(x) { return x.PlayerID === p.PlayerID; }))
      (byNorm[key] = byNorm[key] || []).push(p);
  });
  const seatRows = rowsOf_(CONFIG.TABS.PLAYER_SEASONS);
  const seatByPid = {};              // pid -> this-season seat row
  const teamOfPid = {};              // pid -> {teamId: true} across seasons
  seatRows.forEach(function (r) {
    const pid = String(r.PlayerID || '').trim();
    if (!pid) return;
    (teamOfPid[pid] = teamOfPid[pid] || {})[String(r.TeamID || '').trim()] = true;
    if (String(r.SeasonID || '').trim() === seasonId) seatByPid[pid] = r;
  });
  /* This season's seats by school, for the boys a file names differently from
     the way they were first entered. "K. Sorrells" was typed in from a box
     score; the roster says "Kristian Sorrells". Exact matching sees two people
     and creates the second beside the first, which already holds this
     season's stats - the duplicate the merge tools then have to undo. */
  const seatsOfTeam = {};            // teamId -> [{pid, jersey, parts}]
  Object.keys(seatByPid).forEach(function (pid) {
    const seat = seatByPid[pid];
    const tid = String(seat.TeamID || '').trim();
    if (!tid) return;
    (seatsOfTeam[tid] = seatsOfTeam[tid] || []).push({
      pid: pid,
      jersey: String(seat.Jersey === null || seat.Jersey === undefined ? '' : seat.Jersey).trim(),
      parts: irNameParts_(seat.DisplayName || '')
    });
  });
  const hasStats = {};
  rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
    if (String(r.SeasonID || '').trim() !== seasonId) return;
    const pid = String(r.PlayerID || '').trim();
    if (pid) hasStats[pid] = true;
  });

  /* Whose seat may not be deleted by a file: anyone who has entered their own
     information, or holds an account. Read before the removal pass below. */
  const authors = irProfileAuthors_();
  const plan = { create: [], move: [], update: [], remove: [], keepStats: [], keepEntered: [],
                 ambiguous: [] };
  const claimed = {};                // pid -> the wanted person who claimed it

  /* Pass one: exact names, every row, before any looser matching runs at all.
     A fallback for one row must never take a seat that a later row matches
     exactly. That is how "Mekhi Gibbs" came to find his own seat already
     claimed by Rocco Corriggio and settle for Dinitri's. */
  Object.keys(wanted).forEach(function (key) {
    const w = wanted[key];
    const cands = (byNorm[w.norm] || []).filter(function (p) {
      return !claimed[String(p.PlayerID)];
    });
    var pid = '';
    if (cands.length === 1) pid = String(cands[0].PlayerID);
    else if (cands.length > 1) {
      // two players, one name: prefer the one who has ever worn this school
      const here = cands.filter(function (p) {
        return (teamOfPid[String(p.PlayerID)] || {})[w.teamId];
      });
      if (here.length === 1) pid = String(here[0].PlayerID);
      else { plan.ambiguous.push(w.name + ' (' + w.teamId + '): ' + cands.length +
                                 ' players share this name — left alone'); w.skip = true; return; }
    }
    if (pid) { claimed[pid] = w; w.pid = pid; }
  });

  /* Pass two: the rows nobody matched exactly, against this school's seats
     this season, by NAME. First initial and surname must agree: "K. Sorrells"
     is Kristian Sorrells, "Zyad" is Zayd Fareed, "M. Shelley Jr" is Michael
     Shelley. When that names two boys - Khyari and Khaliq Copeland - the
     jersey breaks the tie, and only then.

     A jersey on its own never matches. The seats carry the number a boy wore
     when his seat was made, and #1 belonged to M. Shelley a year before it
     belonged to Khyari Copeland; matched on the number first, this handed
     three seats to the wrong boys. A number can confirm a name. It cannot
     replace one. */
  Object.keys(wanted).forEach(function (key) {
    const w = wanted[key];
    if (w.pid || w.skip) return;
    const me = irNameParts_(w.name);
    if (!me) return;
    const mine = (seatsOfTeam[w.teamId] || []).filter(function (s_) { return !claimed[s_.pid]; });
    var hits = mine.filter(function (s_) {
      return s_.parts && s_.parts.surname === me.surname && s_.parts.initial === me.initial;
    });
    var how = 'initial and surname';
    /* Two rows in the FILE answering to the same initial and surname - Khyari
       and Khaliq Copeland - and one seat on file between them. Whichever row
       came first would take it. When the file itself carries twins, a seat is
       only theirs if the jersey says so. */
    const twins = Object.keys(wanted).filter(function (k) {
      const o = wanted[k], p = o.teamId === w.teamId && irNameParts_(o.name);
      return p && p.surname === me.surname && p.initial === me.initial;
    }).length;
    if (twins > 1) {
      hits = hits.filter(function (s_) {
        return w.jersey !== '' && s_.jersey !== '' && Number(s_.jersey) === Number(w.jersey);
      });
      if (hits.length) how += ', jersey #' + w.jersey + ' confirming';
    }
    if (hits.length > 1 && w.jersey !== '') {
      const byNum = hits.filter(function (s_) {
        return s_.jersey !== '' && Number(s_.jersey) === Number(w.jersey);
      });
      if (byNum.length === 1) { hits = byNum; how += ', jersey #' + w.jersey + ' deciding'; }
    }
    if (hits.length > 1) {
      plan.ambiguous.push(w.name + ' (' + w.teamId + '): ' + hits.length +
                          ' seats share the initial and surname and no jersey tells them apart — left alone');
      w.skip = true; return;
    }
    if (hits.length !== 1) return;                          // nobody: created below
    const pid = hits[0].pid;
    claimed[pid] = w; w.pid = pid;
    const was = String((plById0[pid] || {}).DisplayName || '');
    if (irNorm_(was) !== w.norm) {
      w.renamedFrom = was;
      (plan.renamed = plan.renamed || []).push('  ' + was + ' -> ' + w.name + '   (by ' + how + ')');
    }
  });

  /* Now the seats. */
  Object.keys(wanted).forEach(function (key) {
    const w = wanted[key];
    if (w.skip) return;
    if (!w.pid) { plan.create.push(w); return; }
    const pid = w.pid;
    const seat = seatByPid[pid];
    if (!seat) plan.move.push(w);                              // new seat this season
    else if (String(seat.TeamID || '').trim() !== w.teamId) {
      w.fromTeam = String(seat.TeamID || '').trim();
      w.seatRow = seat.__row;
      w.seatId = String(seat.PlayerSeasonID || '').trim();     // audit key, see fillSeat
      plan.move.push(w);                                       // the wrong-team fix
    } else {
      w.seatRow = seat.__row;
      w.seatId = String(seat.PlayerSeasonID || '').trim();
      plan.update.push(w);
    }
  });

  /* Seats this season that the file does not name.
     A file is only evidence about the schools it actually contains. Rosters
     arrive a few schools at a time - eight of fifteen in one sheet is normal -
     and reading silence about Perryville as "Perryville has no players" would
     empty every roster the file happens not to cover. So a seat is only ever
     considered for removal when its own team appears in the file. */
  const filedTeams = {};
  Object.keys(wanted).forEach(function (k) { filedTeams[wanted[k].teamId] = true; });
  const plById = {};
  players.forEach(function (p) { plById[String(p.PlayerID || '').trim()] = p; });
  /* A seat the file does not name, at a school it does, whose initial and
     surname the file DID name and matched to a different record: almost
     certainly one boy under two records - "Zyad Fareed" with the stats and
     "Zayd Fareed" without. The report says so, and names the merge. */
  const twinOf = {};
  Object.keys(wanted).forEach(function (k) {
    const w = wanted[k], p = w.pid && irNameParts_(w.name);
    if (p) twinOf[w.teamId + '|' + p.initial + '|' + p.surname] = w.name + ' (' + w.pid + ')';
  });
  var untouched = 0;
  Object.keys(seatByPid).forEach(function (pid) {
    if (claimed[pid]) return;
    const seat = seatByPid[pid];
    const nm = String(seat.DisplayName || pid);
    const tid = String(seat.TeamID || '');
    if (!filedTeams[tid]) { untouched++; return; }        // this file says nothing about them
    const seatId = String(seat.PlayerSeasonID || '').trim();
    /* Graduation is not the file's silence. It is a date that has passed, and
       it outranks however much a player entered about himself - otherwise a
       senior who filled in his profile would hold a roster seat forever. Only
       somebody who could still be on the team is rescued below. */
    const career = plById[pid] || {};
    const gradYear = Number(String(career.GradYear || seat.GradYear || '')
                            .replace(/\D/g, '')) || 0;
    const walked = gradYear > 0 && gradYear <= seasonYear;
    if (hasStats[pid]) {
      const p = irNameParts_(nm);
      const twin = p && twinOf[tid + '|' + p.initial + '|' + p.surname];
      plan.keepStats.push(nm + ' (' + tid + ')' + (twin
        ? '   — same initial and surname as ' + twin + ', who matched. One boy, two records? ' +
          'Merge two players by ID, absorbing ' + pid + '.'
        : ''));
    }
    else if (!walked && (authors[pid] || authors[seatId]))
      plan.keepEntered.push(nm + ' (' + tid + ')');
    else plan.remove.push({ pid: pid, name: nm, row: seat.__row, teamId: tid });
  });

  /* What a person has already entered for themselves, and therefore what this
     file may not touch. Counted here, before anything is written, so the dry
     run reports it too - knowing what an import will refuse to do is most of
     the reason to run one. */
  const held = irProtectedFields_();
  const kept = {};
  const SEAT_FIELDS = [['Jersey', 'jersey'], ['GradYear', 'grad'], ['Positions', 'codes'],
                       ['HeightInches', 'ht'], ['WeightLbs', 'wt'], ['Forty', 'forty'],
                       ['Bench', 'bench'], ['Squat', 'squat'], ['GPA', 'gpa']];
  plan.update.concat(plan.move).forEach(function (w) {
    if (!w.seatId) return;                            // a new seat has nothing to protect
    SEAT_FIELDS.forEach(function (f) {
      const v = w[f[1]];
      const offered = (f[1] === 'codes') ? v.length
                                         : (v !== '' && v !== null && v !== undefined);
      /* Names, not just a count. "Jersey: 4" tells an administrator that four
         numbers on the coach's sheet were declined and nothing about which
         four — and a held-back jersey is exactly where a wrong number
         survives a corrected roster. He can only check them if he is told who
         they are. */
      if (offered && held[w.seatId + '|' + f[0]])
        (kept[f[0]] = kept[f[0]] || []).push(w.name || w.pid);
    });
  });

  const out = [];
  out.push((apply ? 'ROSTER IMPORT' : 'ROSTER IMPORT — DRY RUN') + ' for ' + seasonId);
  /* Which sheet this actually read. Everything below is plausible whichever
     file it came from, so the file has to be named before the numbers are. */
  out.push('Reading sheet "' + sh.getName() + '" — ' + (values.length - 1) + ' rows');
  out.push('');
  out.push('CSV players matched to existing careers: ' +
           (plan.move.length + plan.update.length));
  out.push('  moved to the right team: ' +
           plan.move.filter(function (w) { return w.fromTeam; }).length);
  out.push('  seated for the season:   ' +
           plan.move.filter(function (w) { return !w.fromTeam; }).length);
  out.push('  already right, refreshed: ' + plan.update.length);
  if (plan.renamed && plan.renamed.length) {
    out.push('  matched under a different spelling — the file\'s name replaces the stored one on APPLY:');
    plan.renamed.forEach(function (x) { out.push('  ' + x); });
  }
  out.push('New players created: ' + plan.create.length);
  out.push('Graduated (class of ' + seasonYear + ' or earlier) skipped: ' + graduated +
           ' — the ' + seasonId + ' season is the fall after their walk');
  out.push('Seats removed (graduated or not in CSV, no ' + seasonId + ' stats): ' +
           plan.remove.length);
  out.push('Schools in this file: ' + Object.keys(filedTeams).length +
           ' — only their rosters are touched');
  if (untouched)
    out.push('Seats left alone at schools this file does not mention: ' + untouched);
  if (plan.keepEntered.length) {
    out.push('KEPT despite missing from the file — they have an account or have');
    out.push('entered their own information. Remove a seat by hand if one really left:');
    plan.keepEntered.forEach(function (x) { out.push('  ' + x); });
  }
  if (plan.keepStats.length) {
    out.push('KEPT despite missing from CSV — they have ' + seasonId + ' stats:');
    plan.keepStats.forEach(function (x) { out.push('  ' + x); });
  }
  if (plan.ambiguous.length) {
    out.push('Left for a person:');
    plan.ambiguous.forEach(function (x) { out.push('  ' + x); });
  }
  if (Object.keys(badSchools).length)
    out.push('Unrecognized schools (rows skipped): ' +
             Object.keys(badSchools).join(', '));
  const keptCols = Object.keys(kept).sort();
  if (keptCols.length) {
    out.push('');
    out.push('Held back — a player or coach entered these, so the file is ignored.');
    out.push('Check these against the file and correct any by hand that are wrong:');
    keptCols.forEach(function (k) {
      const who = kept[k];
      const show = who.slice(0, 12).join(', ') +
                   (who.length > 12 ? ' …and ' + (who.length - 12) + ' more' : '');
      out.push('  ' + k + ' (' + who.length + '): ' + show);
    });
  }

  /* A file that names a school claims to BE that school's roster, and everyone
     it leaves out loses their seat. That is right for a roster the coach sent
     and catastrophic for a partial one: a five-row file headed "North Harford",
     meant only to add five players, took twenty-one seats off North Harford in
     a single click. Nothing protected them — they had no stats yet and had
     entered nothing themselves, which is exactly the state a roster is in early
     in the season, when a partial file is most likely to be used. Aberdeen
     survived the identical mistake a day earlier only because its players
     already had week 1 stats.

     So a file that would empty out most of a school is treated as a partial
     list rather than as a roster, and refused before anything is written.
     Nothing about the wanted behaviour changes: a real roster keeps nearly
     everyone, and taking a handful of seats off stays one click. */
  const rosterSize = {};
  Object.keys(seatByPid).forEach(function (pid) {
    const tid = String(seatByPid[pid].TeamID || '');
    if (tid) rosterSize[tid] = (rosterSize[tid] || 0) + 1;
  });
  const cut = {};
  plan.remove.forEach(function (x) { cut[x.teamId] = (cut[x.teamId] || 0) + 1; });
  const gutted = Object.keys(cut).filter(function (tid) {
    return cut[tid] >= IMPROSTER.WIPE_MIN &&
           cut[tid] >= (rosterSize[tid] || 0) * IMPROSTER.WIPE_SHARE;
  });
  if (gutted.length) {
    out.push('');
    out.push('REFUSED — this looks like a partial list, not a roster:');
    gutted.forEach(function (tid) {
      out.push('  ' + (teamNameOf_(tid) || tid) + ': the file would take away ' +
               cut[tid] + ' of its ' + (rosterSize[tid] || 0) + ' seats. A roster ' +
               'file that names a school REPLACES that school\'s roster, so every ' +
               'player it leaves out loses his place.');
    });
    out.push('');
    out.push('If you meant to ADD players, put the whole roster in the file — the');
    out.push('players already seated as well as the new ones — and run it again.');
    out.push('If those players really have left the team, take their seats off on');
    out.push('the portal Roster tab, which does it one at a time and on purpose.');
    const stop = out.join('\n');
    Logger.log(stop);
    return stop;
  }

  if (!apply) {
    out.push('');
    out.push('Nothing was written. Run Import rosters (APPLY) to do it.');
    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  }

  // ── the writes ────────────────────────────────────────────────────────────
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');
  try {
    const psSheet = getTab_(CONFIG.TABS.PLAYER_SEASONS);
    const psHead = tabHeader_(CONFIG.TABS.PLAYER_SEASONS);
    const pCol = function (n) { return psHead.indexOf(n); };

    const plHead = tabHeader_(CONFIG.TABS.PLAYERS);
    const plSheet = getTab_(CONFIG.TABS.PLAYERS);
    const plRowOf = {};
    players.forEach(function (p) { plRowOf[String(p.PlayerID)] = p; });

    function setCell(sheet, row, colIdx, v) {
      if (colIdx >= 0 && v !== '' && v !== null && v !== undefined)
        sheet.getRange(row, colIdx + 1).setValue(v);
    }

    /* A field a person entered through the portal is never written over. The
       file refreshes everything else, so a number that only ever came from an
       import stays correctable. */
    function setSeatCell(rowIdx, seatId, col, v) {
      if (v === '' || v === null || v === undefined) return;
      if (seatId && held[seatId + '|' + col]) return;   // already counted, above
      setCell(psSheet, rowIdx, pCol(col), v);
    }

    function fillSeat(rowIdx, w) {
      setCell(psSheet, rowIdx, pCol('TeamID'), w.teamId);      // roster fact, not a profile field
      setSeatCell(rowIdx, w.seatId, 'Jersey', w.jersey);
      setSeatCell(rowIdx, w.seatId, 'GradYear', w.grad);
      if (w.codes.length)
        setSeatCell(rowIdx, w.seatId, 'Positions', formatPositions_(w.codes));
      setSeatCell(rowIdx, w.seatId, 'HeightInches', w.ht);
      setSeatCell(rowIdx, w.seatId, 'WeightLbs', w.wt);
      setSeatCell(rowIdx, w.seatId, 'Forty', w.forty);
      setSeatCell(rowIdx, w.seatId, 'Bench', w.bench);
      setSeatCell(rowIdx, w.seatId, 'Squat', w.squat);
      setSeatCell(rowIdx, w.seatId, 'GPA', w.gpa);
    }

    function fillCareer(pid, w) {
      const p = plRowOf[pid];
      if (!p) return;
      /* Matched under a shorter or misspelt name: the file's is the fuller one
         and becomes the stored one, on the career and on this season's seat,
         so "K. Sorrells" stops appearing anywhere once the roster says
         Kristian. A name a person entered himself is left as he wrote it. */
      if (w.renamedFrom && !held[pid + '|DisplayName']) {
        setCell(plSheet, p.__row, plHead.indexOf('DisplayName'), w.name);
        if (w.seatRow) setSeatCell(w.seatRow, w.seatId, 'DisplayName', w.name);
      }
      /* The career graduation year follows the file unless a person set it.
         Blank-only would be wrong here: a stale year is exactly what this
         import exists to correct, and a seat whose GradYear the file refreshes
         must not disagree with the career row beside it.

         Commitment and offers stay blank-only below. Those are claims a player
         makes about himself, and a roster sheet has neither to offer. */
      if (w.grad && !held[pid + '|GradYear'])
        setCell(plSheet, p.__row, plHead.indexOf('GradYear'), w.grad);
      if (w.commit && !String(p.Commitment || '').trim())
        setCell(plSheet, p.__row, plHead.indexOf('Commitment'), w.commit);
      if (w.offers.length && plHead.indexOf('Offers') >= 0 &&
          !String(p.Offers || '').trim())
        setCell(plSheet, p.__row, plHead.indexOf('Offers'),
                JSON.stringify(w.offers.map(function (o) {
                  return { school: o, level: '' };
                })));
    }

    plan.update.concat(plan.move.filter(function (w) { return w.seatRow; }))
      .forEach(function (w) { fillSeat(w.seatRow, w); fillCareer(w.pid, w); });

    const newSeats = [];
    plan.move.filter(function (w) { return !w.seatRow; }).forEach(function (w) {
      const seat = { PlayerSeasonID: 'PS-' + seasonId.replace('SEA-', '') + '-' + w.pid,
                     PlayerID: w.pid, TeamID: w.teamId, SeasonID: seasonId,
                     DisplayName: w.name };
      if (w.jersey !== '') seat.Jersey = w.jersey;
      if (w.grad !== '') seat.GradYear = w.grad;
      if (w.codes.length) seat.Positions = formatPositions_(w.codes);
      if (w.ht !== '') seat.HeightInches = w.ht;
      if (w.wt !== '') seat.WeightLbs = w.wt;
      if (w.forty !== '') seat.Forty = w.forty;
      if (w.bench !== '') seat.Bench = w.bench;
      if (w.squat !== '') seat.Squat = w.squat;
      if (w.gpa !== '') seat.GPA = w.gpa;
      newSeats.push(seat);
      fillCareer(w.pid, w);
    });

    // brand-new players, ids allocated once for the batch
    var nextN = 0;
    players.forEach(function (p) {
      const m = String(p.PlayerID || '').match(/(\d+)\s*$/);
      if (m) nextN = Math.max(nextN, parseInt(m[1], 10));
    });
    const newPlayers = [];
    plan.create.forEach(function (w) {
      nextN++;
      var id = String(nextN);
      while (id.length < 6) id = '0' + id;
      const pid = 'PLY-' + id;
      const rec = { PlayerID: pid, DisplayName: w.name, NameNormalized: w.norm,
                    FirstSeenSeason: seasonId, CreatedFrom: 'ROSTER_IMPORT' };
      if (w.grad !== '') rec.GradYear = w.grad;
      if (w.commit) rec.Commitment = w.commit;
      if (w.offers.length && plHead.indexOf('Offers') >= 0)
        rec.Offers = JSON.stringify(w.offers.map(function (o) {
          return { school: o, level: '' };
        }));
      newPlayers.push(rec);
      const seat = { PlayerSeasonID: 'PS-' + seasonId.replace('SEA-', '') + '-' + pid,
                     PlayerID: pid, TeamID: w.teamId, SeasonID: seasonId,
                     DisplayName: w.name };
      if (w.jersey !== '') seat.Jersey = w.jersey;
      if (w.grad !== '') seat.GradYear = w.grad;
      if (w.codes.length) seat.Positions = formatPositions_(w.codes);
      if (w.ht !== '') seat.HeightInches = w.ht;
      if (w.wt !== '') seat.WeightLbs = w.wt;
      newSeats.push(seat);
    });
    if (newPlayers.length) appendRows_(CONFIG.TABS.PLAYERS, newPlayers);
    if (newSeats.length) appendRows_(CONFIG.TABS.PLAYER_SEASONS, newSeats);

    // removals, bottom-up so the row numbers stay true while deleting
    plan.remove.sort(function (a, b) { return b.row - a.row; })
      .forEach(function (x) { psSheet.deleteRow(x.row); });

    __tableCache = {};
    CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
    markDirty_('roster');

    out.push('');
    out.push('APPLIED. Derived tables recompute on the next sweep (within 15 minutes),');
    out.push('or run Rebuild everything now.');
    const msg = out.join('\n');
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}
