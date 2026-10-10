/**
 * UCBAC Stats — Positions.gs
 *
 * The single source of truth for position. The roster editor, the All-Conference
 * engine and the public site all read this list — there is no second copy and no
 * free text anywhere downstream.
 *
 * A player carries a SET of positions, stored pipe-delimited in
 * PlayerSeasons.Positions ("RB|CB|ATH"). He is eligible for All-Conference
 * ranking at every position in that set. The duplicate-resolution rules in
 * AllConference.gs decide which award he ultimately occupies.
 *
 * Historical rows carry free text instead ("WR/DB", "OT/G/DT", "T, DT"). The
 * normalizer below maps that vocabulary onto these codes. It was validated
 * against all 743 historical roster rows with zero unrecognized tokens.
 */

const POSITIONS = [
  // code   label                 side       slots  (slots = First Team seats)
  // Major positions. A coach picks one of these; the sub-position is optional
  // and only narrows what was already chosen. Keeping the major position
  // mandatory is what stops the roster drifting back into the free text this
  // replaced, where half the conference was "LB" and the rest was "MLB", "Mike",
  // "OLB" or "LB/DB" and none of it could be compared.
  { code: 'QB',   label: 'Quarterback',        side: 'OFF', slots: 1 },
  { code: 'RB',   label: 'Running Back',       side: 'OFF', slots: 2,
    subs: [{ code: 'HB', label: 'Halfback' }, { code: 'FB', label: 'Fullback' }] },
  { code: 'WR',   label: 'Wide Receiver',      side: 'OFF', slots: 2 },
  { code: 'TE',   label: 'Tight End',          side: 'OFF', slots: 2, ranksAs: 'WR' },
  { code: 'OL',   label: 'Offensive Line',     side: 'OFF', slots: 2,
    subs: [{ code: 'C', label: 'Center' }, { code: 'G', label: 'Guard' },
           { code: 'T', label: 'Tackle' }] },
  { code: 'ATH',  label: 'Athlete',            side: 'OFF', slots: 1 },
  { code: 'LB',   label: 'Linebacker',         side: 'DEF', slots: 2,
    subs: [{ code: 'ILB', label: 'Inside LB' }, { code: 'OLB', label: 'Outside LB' }] },
  { code: 'DL',   label: 'Defensive Line',     side: 'DEF', slots: 2,
    subs: [{ code: 'NG', label: 'Nose Guard' }, { code: 'DT', label: 'Defensive Tackle' },
           { code: 'EDGE', label: 'Edge' }] },
  { code: 'DB',   label: 'Defensive Back',     side: 'DEF', slots: 2,
    subs: [{ code: 'S', label: 'Safety' }, { code: 'CB', label: 'Cornerback' }] },
  // Special teams carry no award in phase 1 but are tracked so the roster is
  // complete and kicking stats have somewhere to attach.
  { code: 'K',    label: 'Kicker',             side: 'ST',  slots: 0, unranked: true },
  { code: 'P',    label: 'Punter',             side: 'ST',  slots: 0, unranked: true },
  { code: 'LS',   label: 'Long Snapper',       side: 'ST',  slots: 0, unranked: true },
  { code: 'RET',  label: 'Returner',           side: 'ST',  slots: 0, unranked: true }
];

// Ironman is not selectable. It is earned by qualifying on both sides.
const IRONMAN = { code: 'IRONMAN', label: 'Ironman', side: 'BOTH', slots: 2 };

/**
 * Every selectable code, major and sub alike, mapped to what it is.
 *
 * A sub-position is a filter, not a separate position: ILB and OLB are both
 * Linebacker, and a player listed ILB must still appear when someone filters on
 * LB. `major` is what he belongs to; `isSub` is how the UI knows to nest it.
 */
const POS_BY_CODE = (function () {
  const m = {};
  POSITIONS.forEach(function (p) {
    m[p.code] = { code: p.code, label: p.label, side: p.side, slots: p.slots,
                  unranked: !!p.unranked, ranksAs: p.ranksAs, major: p.code,
                  isSub: false, subs: (p.subs || []).map(function (x) { return x.code; }) };
    (p.subs || []).forEach(function (x) {
      m[x.code] = { code: x.code, label: x.label, side: p.side, slots: p.slots,
                    unranked: !!p.unranked, major: p.code, isSub: true, subs: [] };
    });
  });
  m[IRONMAN.code] = { code: IRONMAN.code, label: IRONMAN.label, side: IRONMAN.side,
                      slots: IRONMAN.slots, major: IRONMAN.code, isSub: false, subs: [] };
  return m;
})();

/** The major position a code belongs to. An unknown code is its own major. */
function majorOf_(code) {
  const p = POS_BY_CODE[String(code || '').toUpperCase()];
  return p ? p.major : String(code || '').toUpperCase();
}

/**
 * Does a player's selection satisfy a filter?
 * Filtering on LB matches ILB and OLB; filtering on ILB matches only ILB.
 */
function positionMatches_(selected, filterCode) {
  const want = String(filterCode || '').toUpperCase();
  if (!want) return true;
  const wantIsMajor = !!(POS_BY_CODE[want] && !POS_BY_CODE[want].isSub);
  for (var i = 0; i < (selected || []).length; i++) {
    const code = String(selected[i]).toUpperCase();
    if (code === want) return true;
    if (wantIsMajor && majorOf_(code) === want) return true;
  }
  return false;
}

/** Positions that actually receive a ranking. TE ranks inside the WR pool. */
function rankedPositions_() {
  return POSITIONS.filter(function (p) { return !p.unranked && !p.ranksAs; })
                  .map(function (p) { return p.code; })
                  .concat([IRONMAN.code]);
}

/**
 * The award pools a code competes for.
 *
 * All-Conference awards at the specific position — Inside Linebacker and Outside
 * Linebacker are separate ballots — but the roster only requires the major one.
 * A player listed just "LB" is therefore eligible for BOTH linebacker pools and
 * the duplicate-resolution pass keeps whichever he ranks better in. Excluding
 * him instead would punish a player for his coach's brevity.
 *
 * The other way round, a sub-position with no ballot of its own competes in
 * its major's: a halfback or fullback is a Running Back, a guard is Offensive
 * Line, a nose guard is Defensive Line. Only the sub-positions listed in
 * AC_WEIGHTS (ILB, OLB, S, CB, EDGE) are ballots in their own right.
 */
const POOL_EXPANSION = {
  LB: ['ILB', 'OLB'],
  DB: ['S', 'CB'],
  DL: ['DL', 'EDGE'],
  NG: ['DL'], DT: ['DL'],
  C: ['OL'], G: ['OL'], T: ['OL'],
  HB: ['RB'], FB: ['RB']
};

function poolsOf_(code) {
  const c = String(code || '').toUpperCase();
  if (POOL_EXPANSION[c]) return POOL_EXPANSION[c].slice();
  const p = POS_BY_CODE[c];
  if (p && p.ranksAs) return [p.ranksAs];
  return [c];
}

/** The single pool a code most belongs to. TE competes as WR. */
function poolOf_(code) { return poolsOf_(code)[0]; }

function isOffense_(code) { const p = POS_BY_CODE[code]; return !!p && p.side === 'OFF'; }
function isDefense_(code) { const p = POS_BY_CODE[code]; return !!p && p.side === 'DEF'; }

/** "RB|CB|ATH" -> ['RB','CB','ATH']; unknown codes are dropped, never guessed. */
function parsePositions_(v) {
  if (!v) return [];
  return String(v).split(/[|,;/]+/)
    .map(function (x) { return x.trim().toUpperCase(); })
    .filter(function (x) { return !!POS_BY_CODE[x]; })
    .filter(function (x, i, a) { return a.indexOf(x) === i; });
}

function formatPositions_(list) { return (list || []).join('|'); }

/**
 * Validate a coach's selection at roster-entry time. Returns an error string,
 * or '' when the selection is acceptable.
 */
function validatePositions_(list) {
  const codes = parsePositions_(formatPositions_(list));
  if (!codes.length) return 'Select at least one position.';
  if (codes.length > 4) return 'Select at most four positions.';
  if (codes.indexOf('ATH') >= 0 && codes.filter(isOffense_).length < 2)
    return 'Offensive Athlete requires a second offensive position — Athlete ' +
           'recognizes production in more than one role.';
  return '';
}

// ── historical free-text normalization ─────────────────────────────────────
// Every token observed across the 2023-2026 roster data. Nothing is matched by
// similarity: an unrecognized token is reported for review, never absorbed.

const LEGACY_TOKEN = {
  QB: 'QB',
  RB: 'RB', HB: 'HB', TB: 'HB', FB: 'FB',        // halfback and fullback refine RB
  WR: 'WR', SE: 'WR', SB: 'WR',
  TE: 'TE',
  OL: 'OL', T: 'OL', OT: 'OL', G: 'OL', OG: 'OL', C: 'OL',
  LT: 'OL', RT: 'OL', LG: 'OL', RG: 'OL',
  ATH: 'ATH',
  MLB: 'ILB', ILB: 'ILB', MIKE: 'ILB',
  OLB: 'OLB', SAM: 'OLB', WILL: 'OLB', WLB: 'OLB', SLB: 'OLB',
  S: 'S', SS: 'S', FS: 'S', SAF: 'S', SAFETY: 'S',
  CB: 'CB', CORNER: 'CB', CORNERBACK: 'CB',
  OC: 'OL',                       // "offensive center" on Harford Tech's sheet
  DE: 'EDGE', EDGE: 'EDGE', RUSH: 'EDGE', BUCK: 'EDGE',
  DT: 'DL', NG: 'DL', NT: 'DL', DL: 'DL',
  K: 'K', KICKER: 'K', P: 'P', PUNTER: 'P',
  LS: 'LS', 'LONG SNAPPER': 'LS', SNAPPER: 'LS',
  // RET could not survive a round trip. Every other canonical code is a key on
  // itself here, so a string already written in this project's own vocabulary
  // re-normalizes to itself - but RET was reachable only through KR and PR, and
  // a sheet that said RET or RETURNER lost it silently. Rising Sun's 2026
  // roster carries four returners, spelled out, and every one of them would
  // have arrived with no return role at all.
  RET: 'RET', KR: 'RET', PR: 'RET', RETURNER: 'RET', RETURN: 'RET'
};

// "LB" and "DB" are real tokens but not specific enough to award on. They are
// carried through as review flags rather than resolved by guesswork.
const LEGACY_AMBIGUOUS = { LB: ['ILB', 'OLB'], DB: ['S', 'CB'] };

/* Words that turn up where a position goes and are not positions. They are
   listed so they can be DROPPED quietly. Left out, they come back as unknown
   tokens, which raises an ERROR in the exception queue and asks somebody to
   resolve an injury into a defensive assignment. Availability is not a role and
   a blank is the right answer for it - Rising Sun's sheet writes "Hurt" in the
   defensive column for three players. */
const LEGACY_NOT_A_POSITION = {
  HURT: 1, INJURED: 1, INJURY: 1, OUT: 1, 'OUT FOR SEASON': 1, 'N/A': 1,
  NA: 1, NONE: 1, TBD: 1, '?': 1, '-': 1, '--': 1, X: 1
};

/**
 * Convert a legacy free-text position string to canonical codes.
 * Returns { codes: [...], ambiguous: [...], unknown: [...] }.
 */
function normalizeLegacyPosition_(raw) {
  const out = { codes: [], ambiguous: [], unknown: [] };
  if (raw === null || raw === undefined) return out;
  const txt = String(raw).trim().toUpperCase();
  if (!txt || txt === 'NONE' || txt === 'N/A' || txt === '-') return out;
  if (/^[\d.]+$/.test(txt)) return out;          // a stray number leaked in ("26.0")

  txt.split(/[\/,;|&]+|\s+AND\s+/).forEach(function (piece) {
    const tok = piece.trim();
    if (!tok) return;
    if (LEGACY_NOT_A_POSITION[tok]) return;      // availability, not a role
    if (LEGACY_TOKEN[tok]) {
      const c = LEGACY_TOKEN[tok];
      if (out.codes.indexOf(c) < 0) out.codes.push(c);
    } else if (LEGACY_AMBIGUOUS[tok]) {
      if (out.ambiguous.indexOf(tok) < 0) out.ambiguous.push(tok);
    } else {
      out.unknown.push(tok);
    }
  });
  return out;
}

/**
 * The codes a ROSTER row keeps from a legacy string: everything resolved,
 * plus a bare LB or DB as the major position it names. "LB" is too vague to
 * award on, which is why the normalizer sets it aside for review, but it is
 * exactly what a coach's sheet means by "TE/LB", and a major position is a
 * legal roster entry - the roster editor accepts one without a sub-position.
 * Dropping it filed a two-way tight end as a tight end alone, and the
 * defensive boards then had nothing to show for him but his offense.
 */
function rosterCodesFromLegacy_(raw) {
  const n = normalizeLegacyPosition_(raw);
  const out = n.codes.slice();
  n.ambiguous.forEach(function (tok) {
    if (POS_BY_CODE[tok] && out.indexOf(tok) < 0) out.push(tok);
  });
  return out;
}

/**
 * Remove every POSITION_REVIEW row from the exception queue.
 *
 * backfillPositions() appends its findings, so without this a second run would
 * stack another full set on top of the first and the queue would grow without
 * ever being right.
 */
function clearPositionReviewExceptions_() {
  if (!hasTab_(CONFIG.TABS.EXCEPTIONS)) return 0;
  const sh = getTab_(CONFIG.TABS.EXCEPTIONS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  const cType = data[0].map(String).indexOf('Type');
  if (cType < 0) return 0;
  var removed = 0;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][cType]).trim() === 'POSITION_REVIEW') { sh.deleteRow(r + 1); removed++; }
  }
  __tableCache = {};
  return removed;
}

/**
 * Backfill PlayerSeasons.Positions from the legacy columns.
 *
 * Ambiguous and empty rows go to the exception queue so a coach resolves them in
 * the roster editor rather than the system inventing an answer. Safe to re-run:
 * it clears its own previous findings first.
 */
function backfillPositions() {
  const purged = clearPositionReviewExceptions_();
  const sh = getTab_(CONFIG.TABS.PLAYER_SEASONS);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(String);

  var colPos = head.indexOf('Positions');
  if (colPos < 0) {
    colPos = head.length;
    sh.getRange(1, colPos + 1).setValue('Positions');
  }
  const legacy = ['Position', 'OffensePosition', 'DefensePosition']
    .map(function (c) { return head.indexOf(c); }).filter(function (i) { return i >= 0; });
  const cSeason = head.indexOf('SeasonID'), cPlayer = head.indexOf('PlayerID');

  const writes = [], exceptions = [];
  var filled = 0, review = 0, empty = 0;

  for (var r = 1; r < data.length; r++) {
    const parts = legacy.map(function (i) { return data[r][i]; })
                        .filter(function (v) { return v !== '' && v !== null; });
    const agg = { codes: [], ambiguous: [], unknown: [] };
    parts.forEach(function (p) {
      const n = normalizeLegacyPosition_(p);
      n.codes.forEach(function (c) { if (agg.codes.indexOf(c) < 0) agg.codes.push(c); });
      n.ambiguous.forEach(function (a) { if (agg.ambiguous.indexOf(a) < 0) agg.ambiguous.push(a); });
      agg.unknown = agg.unknown.concat(n.unknown);
    });

    writes.push([formatPositions_(agg.codes)]);
    if (agg.codes.length) filled++;
    if (agg.ambiguous.length || agg.unknown.length || !agg.codes.length) {
      if (!agg.codes.length && !agg.ambiguous.length && !agg.unknown.length) empty++;
      else review++;
      // These keys must match the Exceptions header exactly. appendRows() maps
      // objects onto the sheet by column name, so an invented field name lands
      // in no column at all and the row is written blank.
      exceptions.push({
        ExceptionID: '',
        Type: 'POSITION_REVIEW',
        Severity: agg.unknown.length ? CONFIG.SEVERITY.ERROR
                : (agg.ambiguous.length ? CONFIG.SEVERITY.WARNING : CONFIG.SEVERITY.INFO),
        SourceRef: String(data[r][cSeason] || '') + ' ' + String(data[r][cPlayer] || ''),
        RawValue: parts.join(' / '),
        SuggestedMatch: formatPositions_(agg.codes),
        Confidence: '',
        Note: agg.ambiguous.length
                ? 'Ambiguous: ' + agg.ambiguous.join(',') + ' — the coach must choose'
                : (agg.unknown.length ? 'Unrecognized: ' + agg.unknown.join(',')
                                      : 'No position on file'),
        Status: 'OPEN'
      });
    }
  }

  if (writes.length) sh.getRange(2, colPos + 1, writes.length, 1).setValues(writes);
  if (exceptions.length && hasTab_(CONFIG.TABS.EXCEPTIONS)) {
    appendRows_(CONFIG.TABS.EXCEPTIONS, exceptions);
  }
  const msg = 'Positions backfilled: ' + filled + ' rows resolved, ' + review +
              ' need coach review, ' + empty + ' had no position on file.' +
              (purged ? '\nCleared ' + purged + ' stale POSITION_REVIEW rows first.' : '');
  Logger.log(msg);
  return msg;
}