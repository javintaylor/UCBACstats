/**
 * UCBAC Stats — TeamPostseason.gs
 *
 * What a program has done in the playoffs, going back further than the
 * conference itself.
 *
 * Three things are counted, and they are not the same thing:
 *
 *   State championships   the title game won.
 *   State semifinal wins  the semifinal won, which is to say the program
 *                         reached the state final. Every championship is
 *                         also a semifinal win, so the second number
 *                         includes the first — Havre de Grace's 9 contains
 *                         its 3.
 *   Regional final wins   the regional championship game won, 2003 to 2018,
 *                         the years the MPSSAA record book covers that round.
 *
 * The years are the record; the counts are read off them, never stored, so
 * a corrected year list cannot leave a stale total behind it.
 *
 * The rows live on the TeamPostseason tab, which an administrator can edit.
 * Until that tab exists the site reads TEAMPOST.RESEARCH below, so the
 * history appears the moment this file is pasted and the seeding menu is a
 * convenience rather than a prerequisite.
 */

const TEAMPOST = {
  TAB: 'TeamPostseason',
  COLS: ['TeamID', 'TeamName', 'StateTitleYears', 'SemifinalYears', 'RegionalYears',
         'Note', 'Source', 'UpdatedAt'],

  /* What each column covers, printed under the years wherever they are shown.
     A zero in the regional column means no win in THESE years — it does not
     establish that a school never won a regional title of any kind. */
  SEMI_FROM: 1974, SEMI_TO: 2025,
  REG_FROM: 2003, REG_TO: 2018,

  SOURCE: 'MPSSAA Fall Record Book 2024, pp. 39-44; 2025 results checked separately',

  /**
   * Compiled 8 September 2026 from the MPSSAA Fall Record Book and the
   * federation's championship pages. Six schools appear with nothing in any
   * column and are absent from this table rather than listed as zeroes:
   * Edgewood, Fallston, North East, North Harford, Patterson Mill, Rising Sun.
   */
  RESEARCH: [
    { id: 'TEAM-001', name: 'Aberdeen',         sc: [2003], sf: [2003], rf: [2003, 2011] },
    { id: 'TEAM-002', name: 'Bel Air',          sc: [],     sf: [],     rf: [2004] },
    { id: 'TEAM-003', name: 'Bohemia Manor',    sc: [2002], sf: [2002], rf: [] },
    { id: 'TEAM-004', name: 'C. Milton Wright', sc: [],     sf: [1990], rf: [] },
    { id: 'TEAM-006', name: 'Elkton',           sc: [2000], sf: [1980, 2000, 2016],
      rf: [2006, 2007, 2012, 2016, 2018] },
    { id: 'TEAM-008', name: 'Harford Tech',     sc: [],     sf: [],     rf: [2017] },
    { id: 'TEAM-009', name: 'Havre de Grace',   sc: [1978, 1981, 1986],
      sf: [1978, 1981, 1985, 1986, 1987, 1988, 2010, 2015, 2016],
      rf: [2006, 2010, 2015, 2016, 2017, 2018] },
    { id: 'TEAM-010', name: 'Joppatowne',       sc: [1975, 2003],
      sf: [1974, 1975, 1976, 2001, 2003, 2004, 2009],
      rf: [2003, 2004, 2005, 2008, 2009],
      note: 'The 2007 playoff season was later forfeited, and its regional final win is excluded.' },
    { id: 'TEAM-014', name: 'Perryville',       sc: [],     sf: [2011], rf: [2011, 2012] }
  ]
};

/** "2003, 2011" -> [2003, 2011]; anything that is not a year is dropped. */
function tpYears_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/[^0-9]+/)
    .map(Number)
    .filter(function (y) { return y >= 1900 && y <= 2100; })
    .sort(function (a, b) { return a - b; });
}

/** One team's postseason, or null when it has none to show. */
function tpOf_(teamId) {
  const all = tpAll_();
  return all[s_(teamId)] || null;
}

/**
 * Every team's postseason, keyed by TeamID — the tab when there is one, the
 * research table when there is not. A team with nothing in any column is left
 * out entirely: an empty row on a team page says less than no row at all.
 */
function tpAll_() {
  return cacheGet_('postseason', 21600, function () {
    const out = {};
    const keep = function (id, name, sc, sf, rf, note) {
      if (!id || (!sc.length && !sf.length && !rf.length)) return;
      out[id] = { team: name, sc: sc, sf: sf, rf: rf, note: note || '' };
    };

    if (hasTab_(TEAMPOST.TAB)) {
      rowsOf_(TEAMPOST.TAB).forEach(function (r) {
        keep(s_(r.TeamID), s_(r.TeamName), tpYears_(r.StateTitleYears),
             tpYears_(r.SemifinalYears), tpYears_(r.RegionalYears), s_(r.Note));
      });
      return out;
    }
    TEAMPOST.RESEARCH.forEach(function (r) {
      keep(r.id, r.name, r.sc.slice(), r.sf.slice(), r.rf.slice(), r.note);
    });
    return out;
  });
}

/** The coverage each column claims, so a page can say it rather than imply it. */
function tpWindows_() {
  return { semi: TEAMPOST.SEMI_FROM + '-' + TEAMPOST.SEMI_TO,
           regional: TEAMPOST.REG_FROM + '-' + TEAMPOST.REG_TO };
}

/** The tab, created with its header the first time it is asked for. */
function tpEnsureTab_() {
  if (hasTab_(TEAMPOST.TAB)) return getTab_(TEAMPOST.TAB);
  const sh = db_().insertSheet(TEAMPOST.TAB);
  sh.getRange(1, 1, 1, TEAMPOST.COLS.length).setValues([TEAMPOST.COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  delete __tableCache[TEAMPOST.TAB];
  return sh;
}

/**
 * Write the researched history onto the tab, once.
 *
 * A team already on the tab is left exactly as it is — the tab is the
 * administrator's copy, and a seeding menu that overwrites an edit is a
 * seeding menu nobody runs twice.
 */
function tpSeed_(apply) {
  const out = ['POSTSEASON RECORDS' + (apply ? '' : ' — DRY RUN'), ''];
  tpEnsureTab_();
  const have = {};
  rowsOf_(TEAMPOST.TAB).forEach(function (r) { if (s_(r.TeamID)) have[s_(r.TeamID)] = true; });

  const add = [], skip = [];
  TEAMPOST.RESEARCH.forEach(function (r) {
    const line = (teamNameOf_(r.id) || r.name) + ': ' +
      r.sc.length + ' state, ' + r.sf.length + ' semifinal, ' + r.rf.length + ' regional';
    if (have[r.id]) { skip.push('  ' + line + '  (already on the tab, left alone)'); return; }
    add.push({ r: r, line: line });
  });

  out.push('To write: ' + add.length + '   already there: ' + skip.length);
  out.push('');
  add.forEach(function (x) { out.push('  ' + x.line); });
  if (skip.length) { out.push(''); out.push('Left alone:'); skip.forEach(function (t) { out.push(t); }); }

  if (apply && add.length) {
    const now = new Date();
    appendRows_(TEAMPOST.TAB, add.map(function (x) {
      return { TeamID: x.r.id, TeamName: teamNameOf_(x.r.id) || x.r.name,
               StateTitleYears: x.r.sc.join(', '), SemifinalYears: x.r.sf.join(', '),
               RegionalYears: x.r.rf.join(', '), Note: x.r.note || '',
               Source: TEAMPOST.SOURCE, UpdatedAt: now };
    }));
    try { CacheService.getScriptCache().remove('postseason'); } catch (e) {}
    try { clearApiCache_(); } catch (e) {}
    out.push('');
    out.push('Written. Edit the tab to correct a year; the counts on the site are');
    out.push('read off the years, so they cannot disagree with them.');
  } else if (!apply) {
    out.push('');
    out.push('Nothing was written. Run "Seed postseason records (APPLY)" to write them.');
    out.push('The site already shows these figures either way — the tab only makes');
    out.push('them editable.');
  }

  const msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Postseason records', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function menuSeedPostseasonDry()   { return tpSeed_(false); }
function menuSeedPostseasonApply() { return tpSeed_(true); }
