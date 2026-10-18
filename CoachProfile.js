/**
 * UCBAC Stats — CoachProfile.gs
 *
 * A coach's public page and the form behind it.
 *
 * The page is addressed by TEAM — #/coach/TEAM-014 is "Perryville's head
 * coach" — because that is the stable fact. A head coach who has never
 * registered still gets a page carrying his name from the Teams tab; one who
 * has an account fills in the rest himself through the portal, and the page
 * grows as he does. The same page is the program's coaching staff page:
 * assistants publish their own cards on it through the same portal form, so
 * every coach's name, anywhere on the site, has one place to point.
 *
 * Profile fields ride on the Coaches tab beside the access columns. The email
 * is the join key everywhere here and ships to no payload, public or portal.
 */

const COACH_PROFILE = {
  TAB: 'Coaches',
  // access columns first (Roster.gs createed them); profile columns appended
  COLS: ['CoachID', 'CoachType', 'BirthYear', 'Hometown', 'AlmaMater',
         'HCSince', 'YearsCoaching', 'Highlights', 'XHandle', 'HighSchool', 'InstagramHandle'],
  FIELDS: {
    birthYear:       { col: 'BirthYear',       min: 1940, max: 2012 },
    // Hometown stays on the tab for what was seeded, but the page and the
    // form carry the high school in its place
    hometown:        { col: 'Hometown',        len: 40 },
    highSchool:      { col: 'HighSchool',      len: 60 },
    almaMater:       { col: 'AlmaMater',       len: 60 },
    hcSince:         { col: 'HCSince',         min: 1970, max: 2100 },
    yearsCoaching:   { col: 'YearsCoaching',   min: 0,    max: 60 },
    highlights:      { col: 'Highlights',      len: 160 },
    xHandle:         { col: 'XHandle',         len: 15 },
    instagramHandle: { col: 'InstagramHandle', len: 30 }
  },
  HANDLE: { xHandle: /^[A-Za-z0-9_]{1,15}$/, instagramHandle: /^[A-Za-z0-9_.]{1,30}$/ }
};

/** Append any profile column the Coaches tab does not have yet. */
function coachEnsureColumns_() {
  ensureCoachesTab_();
  const sh = getTab_(COACH_PROFILE.TAB);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const missing = COACH_PROFILE.COLS.filter(function (c) { return head.indexOf(c) < 0; });
  if (!missing.length) return;
  sh.getRange(1, head.length + 1, 1, missing.length)
    .setValues([missing]).setFontWeight('bold');
  delete __tableCache[COACH_PROFILE.TAB];
}

function coachNorm_(v) {
  return String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Active coaching rows for one team. */
function coachRowsFor_(teamId) {
  if (!hasTab_(COACH_PROFILE.TAB)) return [];
  return rowsOf_(COACH_PROFILE.TAB).filter(function (r) {
    return s_(r.TeamID) === s_(teamId) && String(r.Active) !== 'false' &&
           r.Active !== false && s_(r.Role) !== 'ADMIN';
  });
}

/**
 * The team's head coach row, or null. CoachType decides where it is filled;
 * where it is not — rows seeded before the column existed — the name on the
 * Teams tab decides, since that is the name players verify against.
 */
function coachHeadRowFor_(teamId, teamRow) {
  const rows = coachRowsFor_(teamId);
  const typed = rows.filter(function (r) { return s_(r.CoachType).toUpperCase() === 'HEAD'; });
  if (typed.length) return typed[0];
  const want = coachNorm_(teamRow && teamRow.HeadCoach);
  const named = rows.filter(function (r) { return want && coachNorm_(r.DisplayName) === want; });
  return named[0] || null;
}

/** The staff line for a team page: the head coach by name, then assistants. */
function coachStaff_(teamId) {
  const t = rowsOf_(CONFIG.TABS.TEAMS).filter(function (x) { return s_(x.TeamID) === s_(teamId); })[0];
  const headRow = coachHeadRowFor_(teamId, t);
  const headName = (headRow && s_(headRow.DisplayName)) || s_(t && t.HeadCoach);
  const assistants = coachRowsFor_(teamId).filter(function (r) {
    return r !== headRow && coachNorm_(r.DisplayName) !== coachNorm_(headName);
  }).map(function (r) { return s_(r.DisplayName); }).filter(Boolean).sort();
  return { head: headName || '', assistants: assistants };
}

/** One coach row, published: never the email, never a birth date — the year
 * becomes an age and stays home. */
function coachCard_(row, year) {
  const by = num_(row.BirthYear);
  return {
    name: s_(row.DisplayName),
    type: s_(row.CoachType).toUpperCase() === 'HEAD' ? 'Head Coach' : 'Assistant Coach',
    age: by ? year - by : null,
    highSchool: s_(row.HighSchool), almaMater: s_(row.AlmaMater),
    yearsCoaching: num_(row.YearsCoaching),
    highlights: s_(row.Highlights), x: s_(row.XHandle), ig: s_(row.InstagramHandle),
    hasProfile: !!(by || s_(row.HighSchool) || s_(row.AlmaMater) ||
                   num_(row.YearsCoaching) || s_(row.Highlights) || s_(row.XHandle) || s_(row.InstagramHandle))
  };
}

/**
 * The program's coaching-staff page. Only what a program publishes about its
 * coaches: never an email, never a birth date.
 */
function apiCoach_(teamId) {
  teamId = s_(teamId);
  const t = rowsOf_(CONFIG.TABS.TEAMS).filter(function (x) { return s_(x.TeamID) === teamId; })[0];
  if (!t) return null;
  const row = coachHeadRowFor_(teamId, t) || {};
  const name = s_(row.DisplayName) || s_(t.HeadCoach);
  if (!name) return null;

  const year = new Date().getFullYear();
  const by = num_(row.BirthYear), since = num_(row.HCSince);
  const st = (typeof apiStandings_ === 'function' ? apiStandings_(CONFIG.CURRENT_SEASON) : [])
    .filter(function (r) { return r.teamId === teamId; })[0] || null;

  return {
    teamId: teamId, team: s_(t.DisplayName), name: name, type: 'Head Coach',
    age: by ? year - by : null,
    highSchool: s_(row.HighSchool), almaMater: s_(row.AlmaMater),
    hcSince: since || null,
    hcYears: since ? Math.max(1, year - since + 1) : null,
    yearsCoaching: num_(row.YearsCoaching),
    highlights: s_(row.Highlights),
    x: s_(row.XHandle), ig: s_(row.InstagramHandle),
    staff: coachStaff_(teamId).assistants,
    // every assistant as his own card, profile fields and all - the page is
    // the whole program's staff, not one man
    staffProfiles: coachRowsFor_(teamId).filter(function (r2) {
      return r2 !== (coachHeadRowFor_(teamId, t) || null) &&
             coachNorm_(r2.DisplayName) !== coachNorm_(name) && s_(r2.DisplayName);
    }).map(function (r2) { return coachCard_(r2, year); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); }),
    standing: st ? { w: st.w, l: st.l, cw: st.cw, cl: st.cl } : null,
    hasProfile: !!(by || s_(row.HighSchool) || s_(row.AlmaMater) || since ||
                   num_(row.YearsCoaching) || s_(row.Highlights) || s_(row.XHandle) || s_(row.InstagramHandle))
  };
}

/**
 * What the public record says about each program's head coach — hire
 * announcements, school pages, local coverage. The admin's research, not the
 * coach's words, so it is applied as a SEED: it fills a field the coach has
 * left blank and never touches one he has written or deliberately cleared.
 * Keys are TeamIDs; fields are the portal's own (COACH_PROFILE.FIELDS), so
 * the same bounds apply. A team with no entry is skipped.
 *
 * Birth years appear only where a dated article stated the coach's age.
 * Sources are kept with the repository notes, not here.
 */
const COACH_SEED_2026 = {
  'TEAM-001': { // Aberdeen — Kaleb Myers
    almaMater: 'Edgewood High School' },
  'TEAM-002': { // Bel Air — Eric Siegel
    hcSince: 2019, almaMater: 'Bel Air High School', xHandle: 'BAHSCoachSiegel',
    highlights: '2022: first unbeaten regular season in program history and the UCBAC Chesapeake title; Ravens HS Coach of the Week; 2024 3A state quarterfinal.' },
  'TEAM-003': { // Bohemia Manor — Vince Ricci
    highlights: 'Eagles head coach since at least 2023; the 2024 team went 7-4 with a playoff win over Kent County.' },
  'TEAM-004': { // C. Milton Wright — Bryan Hansrote
    hcSince: 2025,
    highlights: 'Took CMW to the 2A playoffs in his first season (2025); formerly Edgewood head coach (two stints) and an Aberdeen assistant in 2018.' },
  'TEAM-005': { // Edgewood — Ken Brinkman
    hcSince: 2025, yearsCoaching: 29,
    almaMater: 'Indiana Univ. of Pennsylvania / McDaniel (M.A.)',
    highlights: '11-1 in his 2025 Edgewood debut; 12 seasons at North Harford (89-48, four UCBAC titles, unbeaten 2010); Ravens Coach of the Week 2010 and 2025.' },
  'TEAM-006': { // Elkton — CJ Ponzo
    hcSince: 2025, almaMater: 'Elkton High School (2004)', xHandle: 'CoachPonzoEHS',
    highlights: '11-1 in his first season (2025): unbeaten regular season, 2A/1A state semifinal, Cecil Whig Coach of the Year. Longtime Cecil Saints youth director.' },
  'TEAM-007': { // Fallston — Derrick Krumholtz
    xHandle: 'CoachKrum27',
    highlights: '2025 Cougars went 8-3 with playoff wins over Bohemia Manor and Harford Tech.' },
  'TEAM-008': { // Harford Tech — Brad Dreyer
    hcSince: 2026, almaMater: 'Frostburg State University',
    highlights: 'Hired in February 2026; played defensive back at Frostburg State.' },
  'TEAM-009': { // Havre de Grace — Brian Eberhardt
    hcSince: 2016, yearsCoaching: 17,
    highlights: 'Head coach since 2016: 1A state finalist that first year, four straight region titles through 2018, 2024 Susky Bowl. Also coaches Warriors boys basketball.' },
  // TEAM-010 Joppatowne: no public source names Chris Johnson as head coach — nothing seeded
  'TEAM-011': { // North East — Wes Laguerre
    almaMater: 'C. Milton Wright High School',
    highlights: 'Succeeded Taylor Slaughenhoupt as head coach; played three years at C. Milton Wright and coached as an assistant around Harford County.' },
  'TEAM-012': { // North Harford — Justin Martinek
    hcSince: 2019, yearsCoaching: 16,
    highlights: 'On the Hawks staff since 2010 (JV head coach in 2013), head coach since 2019; also North Harford\'s athletic director.' },
  'TEAM-013': { // Patterson Mill — David Huryk
    highlights: 'Bel Air head coach 2010-18: 58-34 with no losing seasons and three straight playoff trips (2014-16).' },
  'TEAM-014': { // Perryville — Dan Basara
    hcSince: 2026, yearsCoaching: 15,
    almaMater: 'Randolph-Macon College / Univ. of Delaware (2003)',
    highlights: '15th season at Perryville in 2026: QB coach, then offensive coordinator, then co-head coach for the 2025 run to a third straight 1A state semifinal.' },
  'TEAM-015': { // Rising Sun — Wes Johnson
    yearsCoaching: 23, almaMater: 'Rising Sun High School (1997)',
    highlights: 'Rising Sun alum coaching Tigers football since 2003 - JV, then varsity defensive coordinator - before taking over from Dom Massimiano.' }
};

/**
 * Apply COACH_SEED_2026. Dry run lists every change; apply writes it, with an
 * AuditLog row per field so the seed's provenance is as visible as a coach's
 * own edit. A head coach with no Coaches row yet gets one, without an email;
 * the approval flow claims it the day he signs up.
 */
function seedCoachProfiles_(apply) {
  coachEnsureColumns_();
  const me = { email: 'seed', role: 'ADMIN' };
  const out = [];
  var setCount = 0, keptCount = 0, made = 0;

  // fields a coach edited himself, even to blank — never seeded over
  const edited = {};
  if (hasTab_(CONFIG.TABS.AUDIT)) {
    rowsOf_(CONFIG.TABS.AUDIT).forEach(function (a) {
      if (s_(a.EntityType) === 'Coach' && s_(a.Action) === 'PROFILE_EDIT')
        edited[s_(a.EntityID) + '|' + s_(a.Field)] = true;
    });
  }

  rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
    const teamId = s_(t.TeamID), seed = COACH_SEED_2026[teamId];
    if (!seed) return;
    const headName = s_(t.HeadCoach);
    if (!headName) { out.push(s_(t.DisplayName) + ': no head coach on the Teams tab — skipped.'); return; }

    var row = coachHeadRowFor_(teamId, t);
    if (!row) {
      out.push(s_(t.DisplayName) + ': ' + headName + ' has no Coaches row — ' +
               (apply ? 'created one (no email; claimed at sign-up).' : 'would create one.'));
      made++;
      if (!apply) row = { __row: null, DisplayName: headName };
      else {
        appendRows_(COACH_PROFILE.TAB, [{ Email: '', DisplayName: headName, TeamID: teamId,
          Role: 'COACH', Active: true, AddedAt: new Date(), CoachType: 'HEAD' }]);
        delete __tableCache[COACH_PROFILE.TAB];
        row = coachHeadRowFor_(teamId, t);
        if (!row) { out.push('  could not re-read the new row — skipped.'); return; }
      }
    }

    var coachId = s_(row.CoachID);
    const updates = [], audit = [], lines = [];
    Object.keys(COACH_PROFILE.FIELDS).forEach(function (k) {
      if (!(k in seed) || seed[k] === null || seed[k] === undefined || seed[k] === '') return;
      const f = COACH_PROFILE.FIELDS[k];
      var v = seed[k];
      if (f.min !== undefined) {
        v = Number(v);
        if (isNaN(v) || v < f.min || v > f.max) { lines.push('  ' + k + ': seed value out of bounds — skipped'); return; }
      } else {
        v = String(v).trim();
        if (COACH_PROFILE.HANDLE[k]) v = v.replace(/^@+/, '');
        if (v.length > f.len) v = v.slice(0, f.len);
      }
      const have = row[f.col];
      if (String(have === null || have === undefined ? '' : have).trim() !== '') {
        keptCount++; lines.push('  ' + k + ': kept "' + s_(have) + '"'); return;
      }
      if (coachId && edited[coachId + '|' + f.col]) {
        keptCount++; lines.push('  ' + k + ': the coach cleared this himself — kept blank'); return;
      }
      setCount++;
      lines.push('  ' + k + ': ' + (apply ? 'set' : 'would set') + ' "' + v + '"');
      if (apply) {
        if (!coachId) {
          coachId = nextIdLocked_(COACH_PROFILE.TAB, 'CoachID', 'CH-', 6);
          updates.push({ row: row.__row, field: 'CoachID', value: coachId });
        }
        updates.push({ row: row.__row, field: f.col, value: v });
        audit.push(auditRow_(me, 'PROFILE_SEED', 'Coach', coachId, f.col, have, v, teamId));
      }
    });

    out.push(s_(t.DisplayName) + ' — ' + s_(row.DisplayName || headName));
    out.push.apply(out, lines.length ? lines : ['  nothing to seed']);
    if (apply && updates.length) {
      updateCells_(COACH_PROFILE.TAB, updates);
      delete __tableCache[COACH_PROFILE.TAB];
      if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }
    }
  });

  if (apply) CacheService.getScriptCache().removeAll(['boot']);
  const msg = (apply ? 'COACH PROFILES — SEEDED' : 'COACH PROFILES — DRY RUN') +
    '\n' + (apply ? 'set ' : 'would set ') + setCount + '   kept ' + keptCount +
    '   rows created ' + made + '\n\n' + out.join('\n');
  Logger.log(msg);
  return msg;
}

function menuSeedCoachProfilesDry()   { return coachSeedAlert_(seedCoachProfiles_(false)); }
function menuSeedCoachProfilesApply() { return coachSeedAlert_(seedCoachProfiles_(true)); }
function coachSeedAlert_(msg) {
  try {
    SpreadsheetApp.getUi().alert('Coach profiles',
      msg.length > 6000 ? msg.slice(0, 6000) + '\n\n…full report in View > Logs' : msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

/** The signed-in coach's own row, by session email. */
function coachMyRow_() {
  const email = authEmail_();
  if (!email) throw new Error('Sign in first.');
  const rows = hasTab_(COACH_PROFILE.TAB) ? rowsOf_(COACH_PROFILE.TAB) : [];
  const mine = rows.filter(function (r) {
    return String(r.Email || '').toLowerCase().trim() === email &&
           String(r.Active) !== 'false' && r.Active !== false;
  })[0];
  if (!mine) throw new Error('This account is not on the coaching staff of any school.');
  return mine;
}

function apiMyCoachProfile_() {
  coachEnsureColumns_();
  const r = coachMyRow_();
  const out = { teamId: s_(r.TeamID), team: teamNameOf_(s_(r.TeamID)) || s_(r.TeamID),
                name: s_(r.DisplayName),
                isHead: s_(r.CoachType).toUpperCase() === 'HEAD' };
  Object.keys(COACH_PROFILE.FIELDS).forEach(function (k) {
    const f = COACH_PROFILE.FIELDS[k];
    out[k] = f.min !== undefined ? num_(r[f.col]) : s_(r[f.col]);
  });
  return out;
}

function apiSaveCoachProfile_(patch) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account change is in progress. Try again.');
  try {
    __tableCache={}; authRecheckBoundSession_();
    return coachSaveProfileLocked_(patch);
  } finally {lock.releaseLock();}
}
function coachSaveProfileLocked_(patch) {
  patch = patch || {};
  coachEnsureColumns_();
  const r = coachMyRow_();
  const me = { email: authEmail_(), role: 'COACH' };

  const updates = [], audit = [], refused = [];
  var coachId = s_(r.CoachID);
  if (!coachId) {
    coachId = nextIdLocked_(COACH_PROFILE.TAB, 'CoachID', 'CH-', 6);
    updates.push({ row: r.__row, field: 'CoachID', value: coachId });
  }

  Object.keys(COACH_PROFILE.FIELDS).forEach(function (k) {
    if (!(k in patch)) return;
    const f = COACH_PROFILE.FIELDS[k];
    var v = patch[k];
    if (f.min !== undefined) {
      v = (v === '' || v === null || v === undefined) ? '' : Number(v);
      if (v !== '' && (isNaN(v) || v < f.min || v > f.max)) {
        refused.push(k + ' must be between ' + f.min + ' and ' + f.max + '.');
        return;
      }
    } else {
      v = String(v === null || v === undefined ? '' : v).trim();
      if (COACH_PROFILE.HANDLE[k]) {
        v = v.replace(/^@+/, '');
        if (v && !COACH_PROFILE.HANDLE[k].test(v)) {
          refused.push(k === 'xHandle' ? 'That is not an X handle.' : 'That is not an Instagram handle.');
          return;
        }
      }
      if (v.length > f.len) v = v.slice(0, f.len);
    }
    const before = r[f.col];
    if (String(before === null || before === undefined ? '' : before) === String(v)) return;
    updates.push({ row: r.__row, field: f.col, value: v });
    audit.push(auditRow_(me, 'PROFILE_EDIT', 'Coach', coachId, f.col, before, v, s_(r.TeamID)));
  });

  if (updates.length) {
    updateCells_(COACH_PROFILE.TAB, updates);
    delete __tableCache[COACH_PROFILE.TAB];
    if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }
  }
  return { saved: audit.length, refused: refused,
           message: refused.length ? refused.join(' ')
                  : audit.length ? 'Saved.' : 'Nothing changed.' };
}
