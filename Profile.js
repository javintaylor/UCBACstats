/**
 * UCBAC Stats — Profile.gs
 *
 * What a signed-in PLAYER may do to his own record, and nothing else.
 *
 * The whole file is one idea: a player owns the things a person knows about
 * himself — his height, his handle, where he committed — and owns none of the
 * things a scorekeeper knows about him. Stats are never written here. A player
 * who believes a number is wrong files a correction, a coach or an administrator
 * decides, and until then the published number does not move. That asymmetry is
 * the point; without it the leaderboard is a self-report.
 *
 * Three guards exist because this page is public and it names a minor:
 *
 *   DisplayName may change, because names change and imports mangle them, but a
 *   change that does not share a surname with the name already on file is
 *   refused. Renaming a profile into a different person is how one account
 *   quietly becomes another, and the rename is audited and mailed either way.
 *
 *   A link is stored only when it is https and its host is one we recognize —
 *   the film and recruiting sites, plus whatever school domains the Teams tab
 *   declares. An arbitrary URL on a page about a sixteen-year-old is not a
 *   feature.
 *
 *   Bio is stripped of markup and capped. It is rendered on the public site.
 *
 * Authorization is decided here, on the server, before anything is read or
 * written. The svc* wrappers are callable by any signed-in Google account, so a
 * hostile caller passing someone else's PlayerID is the case every function has
 * to survive: none of them take a player id at all — the identity comes from the
 * Accounts row, never from the argument list.
 */

// Literals rather than CONFIG lookups where a top-level constant is involved:
// Apps Script evaluates every file's top-level statements before any function
// runs, so nothing here may depend on another file's constants. Everything below
// reaches for CONFIG inside a function body, where it is defined.
const PROFILE = {

  BIO_MAX: 600,
  TEXT_MAX: 80,
  REASON_MIN: 12,
  REASON_MAX: 500,

  // A player with two dozen unreviewed disputes is not disputing, he is
  // flooding the coach's queue. Reviewed ones do not count against him.
  OPEN_CORRECTION_CAP: 25,

  // MailApp's daily quota is per-account and shared with everything else this
  // project sends, so a sweep never tries to drain the whole queue at once.
  MAIL_BATCH: 50,

  // Never spent by the notification sweep: kept back for sign-in codes, which
  // have a person waiting at a form. A day where the queue ate the last mail
  // was a day nobody could sign in at all.
  MAIL_RESERVE: 15,

  /**
   * Hosts a player-supplied link may point at. Matched on the exact host or any
   * subdomain of it. hcps.org and ccps.org are the two county school systems the
   * conference sits in; any additional school host comes from Teams.SchoolURL at
   * runtime, so adding a school never means editing this list.
   */
  URL_HOSTS: ['hudl.com', 'maxpreps.com', 'x.com', 'twitter.com', 'instagram.com',
              'hcps.org', 'ccps.org'],

  // Free text here would be unrankable and unfilterable the moment anyone wanted
  // to count commitments by level, which is the first thing anyone wants.
  COMMITMENT_LEVELS: ['D1', 'D2', 'D3', 'NAIA', 'JUCO', 'PREP', 'WALK_ON', 'UNDECIDED'],

  /**
   * The Players columns a player may write, and how each is validated.
   * `key` is what the client sends; `col` is the sheet header. appendRows() and
   * updateCells() both match on the header exactly, so `col` is checked against
   * the real header row before anything is written.
   */
  /* No commitmentDate and no profilePhotoId, on purpose. The date added a
     third question to a two-question fact (school, level). The photo became a
     jersey-number avatar instead: a photo pipeline on a site full of minors
     is moderation work nobody signed up for. Offers are the schools recruiting
     him — several of them, each a school and a level. */
  PLAYER_FIELDS: [
    { key: 'displayName',       col: 'DisplayName',       kind: 'NAME' },
    { key: 'gradYear',          col: 'GradYear',          kind: 'YEAR' },
    { key: 'commitment',        col: 'Commitment',        kind: 'TEXT' },
    { key: 'commitmentLevel',   col: 'CommitmentLevel',   kind: 'LEVEL' },
    { key: 'offers',            col: 'Offers',            kind: 'OFFERS' },
    { key: 'hudlUrl',           col: 'HudlURL',           kind: 'URL' },
    { key: 'xHandle',           col: 'XHandle',           kind: 'HANDLE' },
    { key: 'instagramHandle',   col: 'InstagramHandle',   kind: 'HANDLE' },
    { key: 'maxPrepsUrl',       col: 'MaxPrepsURL',       kind: 'URL' },
    { key: 'hometown',          col: 'Hometown',          kind: 'TEXT' },
    { key: 'bio',               col: 'Bio',               kind: 'BIO' }
  ],

  MAX_OFFERS: 30,

  /**
   * The PlayerSeasons columns a player may write that are not measurables.
   * Use profileSeasonFields() — it appends the measured numbers.
   */
  SEASON_FIELDS_FIXED: [
    { key: 'jersey',    col: 'Jersey',    kind: 'JERSEY' },
    { key: 'positions', col: 'Positions', kind: 'POSITIONS' }
  ],

  /**
   * Named refusals. Anything not on an editable list is refused anyway, but
   * these four are the ones a client will actually try, and a reason a person
   * can read beats "not an editable field".
   */
  NEVER: {
    iscaptain: 'a captain is named by his coach, not by himself',
    teamid:    'your team is set by your coach',
    playerid:  'identity is not editable',
    stars:     'a rating is entered by an administrator'
  },

  // ensureOpsTabs() creates the first eleven; Schema.gs appends the last five.
  CORRECTION_COLS: ['CorrectionID', 'StatID', 'GameID', 'PlayerID', 'Field',
                    'OldValue', 'NewValue', 'CorrectedBy', 'Role', 'CorrectedAt',
                    'Reason', 'Status', 'ReviewedBy', 'ReviewedAt', 'SeasonID', 'TeamID']
};

/**
 * Every PlayerSeasons column a player may write, measurables included.
 *
 * A function rather than a field on PROFILE because MEASURABLES is a top-level
 * const in another file. Apps Script evaluates all .gs files into one global
 * scope in an order this code does not control, so a const literal that reads
 * another file's const is a load error on the days the order goes the other
 * way. Read at call time it is always there.
 *
 * The measurables come from that one list rather than being restated here, so a
 * player and his coach can never be offered different fields.
 */
function profileSeasonFields_() {
  return PROFILE.SEASON_FIELDS_FIXED.concat(MEASURABLES.map(function (m) {
    return { key: m.key, col: m.col, kind: 'MEASURABLE' };
  }));
}

// ── identity ───────────────────────────────────────────────────────────────

/**
 * The caller, refusing anyone who is not an ACTIVE account bound to a player.
 *
 * No function in this file accepts a PlayerID from the client. The only player
 * anyone can reach here is the one their own Accounts row names, which is what
 * makes "may never edit another player" true rather than merely intended.
 */
function profileWhoami_() {
  const me = accountsWhoami_();
  if (!me.email) throw new Error('Sign in with your Google account first.');

  if (me.status === 'PENDING')
    throw new Error('Your account is still waiting for approval. Until then you ' +
                    'can read the site but not edit a profile.');
  if (me.status === 'REJECTED')
    throw new Error('This account was not approved. Speak to your head coach.');
  if (me.status === 'SUSPENDED')
    throw new Error('This account is suspended. Contact an administrator.');
  if (me.status !== 'ACTIVE')
    throw new Error('This account is not active. Register first.');

  if (!me.playerId)
    throw new Error('This account is not linked to a player. Ask your coach or an ' +
                    'administrator to link it before editing a profile.');
  return me;
}

/**
 * Who a profile call acts ON. Without a playerId it is the signed-in player
 * himself. With one, it is a coach or administrator editing one of their own
 * players — same fields, same validation, their name on the change log. A
 * coach can edit anything his player can edit, and nothing of anyone else's.
 */
function profileTarget_(playerId) {
  playerId = s_(playerId);
  if (!playerId) return profileWhoami_();

  const me = accountsWhoami_();
  if (!me.email) throw new Error('Sign in first.');
  const seat = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.SeasonID) === CONFIG.CURRENT_SEASON;
  })[0];
  const teamId = seat ? s_(seat.TeamID) : '';
  const ok = me.role === 'ADMIN' ||
             (me.role === 'COACH' && me.teamId && me.teamId === teamId);
  if (!ok)
    throw new Error('Only ' + (teamNameOf_(teamId) || 'that player\'s team') +
                    '\'s coach or an administrator can edit this profile.');
  return { email: me.email, role: me.role, teamId: me.teamId, playerId: playerId };
}

// ── validation ─────────────────────────────────────────────────────────────
//
// Every normalizer below returns the value to store, or throws with a message a
// player can act on. Blank always returns '' and never 0 — a cleared height is
// "not reported", and a zero would publish him as nought inches tall.

/** Plain single-line text: no markup, no control characters, capped. */
function profileText_(v, max) {
  const txt = String(v === null || v === undefined ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = max || PROFILE.TEXT_MAX;
  if (txt.length > cap)
    throw new Error('That is ' + txt.length + ' characters; the limit is ' + cap + '.');
  return txt;
}

/**
 * Bio, stripped of markup and capped.
 *
 * Over-length throws rather than truncating. A silently cut sentence is a worse
 * outcome than a refusal: the player never learns the end of it was dropped, and
 * the public page carries the half of it that survived.
 */
function profileBio_(v) {
  var txt = String(v === null || v === undefined ? '' : v);
  txt = txt.replace(/<[^>]*>/g, ' ')                    // tags
           .replace(/&[#a-zA-Z0-9]{1,10};/g, ' ')       // entities, escaped or not
           .replace(/[<>]/g, ' ')                       // a stray bracket is still markup
           .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
           .replace(/[ \t]+/g, ' ')
           .replace(/[ \t]*\n[ \t]*/g, '\n')
           .replace(/\n{3,}/g, '\n\n')
           .trim();
  if (txt.length > PROFILE.BIO_MAX)
    throw new Error('Your bio is ' + txt.length + ' characters; the limit is ' +
                    PROFILE.BIO_MAX + '. Shorten it and save again.');
  return txt;
}

/** The host of an https URL, lowercased, or '' when it is not one. */
function profileHostOf_(url) {
  const m = /^https:\/\/([^\/\?#\s]+)(?:[\/\?#][^\s]*)?$/i.exec(String(url || '').trim());
  if (!m) return '';
  const authority = m[1];
  if (authority.indexOf('@') >= 0) return '';      // userinfo disguises the real host
  return authority.split(':')[0].toLowerCase();
}

/**
 * Every host a player link may point at: the fixed list, plus the host of each
 * school's own site as declared in Teams.SchoolURL.
 *
 * Memoized per execution. A workbook that has not been through ensureSchema()
 * has no SchoolURL column yet and simply contributes no school hosts.
 */
var __profileHosts = null;
function profileAllowedHosts_() {
  if (__profileHosts) return __profileHosts;
  const out = PROFILE.URL_HOSTS.slice();
  if (hasTab_(CONFIG.TABS.TEAMS) && tabHeader_(CONFIG.TABS.TEAMS).indexOf('SchoolURL') >= 0) {
    rowsOf_(CONFIG.TABS.TEAMS).forEach(function (t) {
      const h = profileHostOf_(s_(t.SchoolURL)).replace(/^www\./, '');
      if (h && out.indexOf(h) < 0) out.push(h);
    });
  }
  __profileHosts = out;
  return out;
}

/** The host itself, or a subdomain of it. "nothudl.com" is not "hudl.com". */
function profileHostAllowed_(host, allowed) {
  for (var i = 0; i < allowed.length; i++) {
    const d = allowed[i];
    if (host === d) return true;
    if (host.length > d.length + 1 &&
        host.slice(host.length - d.length - 1) === '.' + d) return true;
  }
  return false;
}

/** https only, allowlisted host only. Anything else is refused, never stored. */
function profileUrl_(v) {
  const txt = String(v === null || v === undefined ? '' : v).trim();
  if (!txt) return '';
  if (txt.length > 300) throw new Error('That link is too long.');
  if (!/^https:\/\//i.test(txt))
    throw new Error('Links must start with https:// — "' + txt.slice(0, 40) + '" does not.');

  const host = profileHostOf_(txt);
  const allowed = profileAllowedHosts_();
  if (!host || !profileHostAllowed_(host.replace(/^www\./, ''), allowed))
    throw new Error('Links are accepted only from ' + allowed.join(', ') +
                    '. "' + (host || txt.slice(0, 40)) + '" is not one of them.');
  return txt;
}

/** A bare handle, stored with its @. A pasted link is refused, not guessed at. */
function profileHandle_(v) {
  const raw = profileText_(v, 40).replace(/^@+/, '');
  if (!raw) return '';
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(raw))
    throw new Error('Enter the handle by itself — letters, numbers, underscore — ' +
                    'not a link. "' + raw.slice(0, 30) + '" is not a handle.');
  return '@' + raw;
}

function profileGradYear_(v) {
  const txt = String(v === null || v === undefined ? '' : v).trim();
  if (!txt) return '';
  const now = new Date().getFullYear();
  const n = Number(txt);
  if (!/^\d{4}$/.test(txt) || n < 1950 || n > now + 6)
    throw new Error('Graduation year "' + txt + '" is not a year between 1950 and ' +
                    (now + 6) + '.');
  return n;
}

function profileLevel_(v) {
  const txt = profileText_(v, 20).toUpperCase().replace(/[\s-]+/g, '_');
  if (!txt) return '';
  if (PROFILE.COMMITMENT_LEVELS.indexOf(txt) < 0)
    throw new Error('Commitment level must be one of ' +
                    PROFILE.COMMITMENT_LEVELS.join(', ') + '.');
  return txt;
}

/**
 * A calendar date, stored as a Date.
 *
 * Only YYYY-MM-DD is accepted from a client. Anything looser gets parsed
 * differently by every browser and every locale, and a commitment dated the
 * wrong side of a signing period is worse than no date at all.
 */
function profileDate_(v) {
  if (v instanceof Date) return v;
  const txt = String(v === null || v === undefined ? '' : v).trim();
  if (!txt) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(txt);
  if (!m) throw new Error('Enter the date as YYYY-MM-DD. "' + txt + '" is not.');

  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d)
    throw new Error('"' + txt + '" is not a real date.');

  const now = new Date().getFullYear();
  if (y < 2000 || y > now + 2)
    throw new Error('Commitment date "' + txt + '" is outside 2000–' + (now + 2) + '.');
  return dt;
}

/** A Drive file id, or one lifted out of a Drive link the player pasted. */
function profileFileId_(v) {
  const txt = String(v === null || v === undefined ? '' : v).trim();
  if (!txt) return '';
  const link = /\/d\/([A-Za-z0-9_-]{10,100})|[?&]id=([A-Za-z0-9_-]{10,100})/.exec(txt);
  const id = link ? (link[1] || link[2]) : txt;
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id))
    throw new Error('That is not a Drive file id. Upload the photo, then paste its ' +
                    'file id or its Drive link.');
  return id;
}

/**
 * A measurable, in range. The range is not fussiness — an unbounded number here
 * ends up on the public page and in the All-Conference pool, where a 6-inch
 * lineman is noticed by everyone except the code.
 */
function profileMeasure_(v, lo, hi, label) {
  const n = numOrBlank_(v);
  if (n === '') return '';
  if (n < lo || n > hi)
    throw new Error(label + ' "' + v + '" is outside ' + lo + '–' + hi + '.');
  return n;
}

/**
 * The offers list: [{school, level}] in, JSON out. Blank list stores ''.
 * Each school is plain text; each level comes from the same controlled list
 * as the commitment, or blank for "level unknown".
 */
function profileOffers_(v) {
  var list = v;
  if (typeof list === 'string') {
    if (!list.trim()) return '';
    try { list = JSON.parse(list); } catch (e) { throw new Error('Offers are unreadable.'); }
  }
  if (!Array.isArray(list)) throw new Error('Offers must be a list.');
  const out = [];
  list.forEach(function (o) {
    const school = profileText_(o && o.school, 60);
    if (!school) return;                            // an empty row is just a row
    const level = profileLevel_(o && o.level || '');
    out.push({ school: school, level: level });
  });
  if (out.length > PROFILE.MAX_OFFERS)
    throw new Error('That is ' + out.length + ' offers; the limit is ' +
                    PROFILE.MAX_OFFERS + '.');
  return out.length ? JSON.stringify(out) : '';
}

/** Read the stored Offers cell back into a list. Junk reads as no offers. */
function profileParseOffers_(raw) {
  const txt = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!txt || txt.charAt(0) !== '[') return [];
  try {
    const list = JSON.parse(txt);
    return Array.isArray(list) ? list.filter(function (o) {
      return o && String(o.school || '').trim();
    }).map(function (o) {
      return { school: String(o.school), level: String(o.level || '') };
    }) : [];
  } catch (e) { return []; }
}

/** One value, validated for its field. Throws with a message meant for a player. */
function profileValue_(field, raw, ctx) {
  switch (field.kind) {
    case 'NAME':      return profileDisplayName_(raw, ctx.currentName);
    case 'TEXT':      return profileText_(raw, PROFILE.TEXT_MAX);
    case 'BIO':       return profileBio_(raw);
    case 'URL':       return profileUrl_(raw);
    case 'HANDLE':    return profileHandle_(raw);
    case 'YEAR':      return profileGradYear_(raw);
    case 'LEVEL':     return profileLevel_(raw);
    case 'DATE':      return profileDate_(raw);
    case 'FILEID':    return profileFileId_(raw);
    case 'JERSEY':    return normalizeJersey_(raw);
    case 'OFFERS':    return profileOffers_(raw);
    // One validator for every measured number, sharing its range with the
    // coach's roster editor. INCHES and POUNDS below are the older spellings of
    // the same two fields, kept because other callers still name them.
    case 'MEASURABLE': return measurableValue_(field.key, raw);
    case 'INCHES':    return profileMeasure_(raw, 48, 90, 'Height');
    case 'POUNDS':    return profileMeasure_(raw, 80, 450, 'Weight');
    case 'GPA':       return normalizeGpa_(raw);
    case 'POSITIONS': return profilePositions_(raw);
  }
  throw new Error('No validator for ' + field.key + '.');
}

function profilePositions_(v) {
  const codes = parsePositions_(formatPositions_(v || []));
  const err = validatePositions_(codes);
  if (err) throw new Error(err);
  return formatPositions_(codes);
}

/**
 * A name change, guarded by its surname.
 *
 * Fixing "Deshawn" to "DeShawn", or an import's "Reinhardt Iii" to
 * "Reinhardt III", is exactly what this field is for. Turning Reinhardt into
 * Rodriguez is not a correction, it is one account becoming another — and the
 * account is already bound to a PlayerID whose stats and All-Conference standing
 * would go with the new name. Identity is exact-match only, so the surname must
 * survive; anything else needs a person.
 */
function profileDisplayName_(v, current) {
  const name = profileText_(v, 60);
  if (!name) throw new Error('A name cannot be blank.');
  if (!/^[A-Za-z][A-Za-z'\.\- ]*$/.test(name))
    throw new Error('A name may hold only letters, spaces, apostrophes, hyphens and ' +
                    'periods. "' + name + '" does not.');
  if (name.split(' ').filter(function (t) { return !!t; }).length < 2)
    throw new Error('Enter your first and last name.');

  const was = acctNameParts_(current), now = acctNameParts_(name);
  if (!now.last) throw new Error('Enter your first and last name.');
  if (was.last && now.last !== was.last)
    throw new Error('This profile is on file as "' + current + '". A name change that ' +
                    'drops the surname has to be made by a coach or an administrator — ' +
                    'a profile carries a player\'s stats, and renaming it moves them.');
  return name;
}

/** Did the cell actually change? Dates compare by instant, blanks by emptiness. */
function profileSame_(a, b) {
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }
  const x = (a === null || a === undefined) ? '' : String(a).trim();
  const y = (b === null || b === undefined) ? '' : String(b).trim();
  return x === y;
}

// ── read ───────────────────────────────────────────────────────────────────

/**
 * The caller's own profile, plus exactly what the form is allowed to offer.
 *
 * `editable` is generated from the same registry the save path validates
 * against, and filtered to the columns the workbook really has, so the UI can
 * never render a field the server would then refuse. Stats are not here at all —
 * the public player page already carries them, and nothing on this page edits
 * one.
 */
function apiMyProfile_(forPlayerId) {
  const me = profileTarget_(forPlayerId);

  const player = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (p) {
    return s_(p.PlayerID) === me.playerId;
  })[0];
  /* The account names a PlayerID the Players tab has lost. Nothing the player
     can do about it and nothing he did wrong, so the message says so and names
     the one-click repair rather than leaving an administrator to guess:
     UCBAC Stats > Maintenance > Restore orphaned players. */
  if (!player)
    throw new Error('Your profile row is missing from the database — this is our ' +
                    'fault, not yours, and your statistics are safe. Email ' +
                    'contact@example.invalid and quote ' + me.playerId + '. ' +
                    '(Administrator: Maintenance > Restore orphaned players.)');

  const teams = indexBy_(rowsOf_(CONFIG.TABS.TEAMS), function (t) { return s_(t.TeamID); });
  const seasonId = CONFIG.CURRENT_SEASON;

  const seasons = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === me.playerId;
  }).map(function (r) {
    const t = teams[s_(r.TeamID)] || {};
    const out = {
      playerSeasonId: s_(r.PlayerSeasonID),
      seasonId: s_(r.SeasonID),
      teamId: s_(r.TeamID),
      teamName: s_(t.DisplayName) || s_(r.TeamID),
      jersey: s_(r.Jersey),
      positions: parsePositions_(r.Positions),
      // read-only here, and the only reason it travels at all is so the page can
      // show the C without offering a switch
      isCaptain: s_(r.IsCaptain).toUpperCase() === 'TRUE',
      editable: s_(r.SeasonID) === seasonId
    };
    // num() already returns null for a blank cell, which is what has to reach
    // the form — an empty box, not a zero the player has to notice and clear.
    MEASURABLES.forEach(function (m) { out[m.key] = num_(r[m.col]); });
    return out;
  }).sort(function (a, b) {
    return a.seasonId < b.seasonId ? 1 : (a.seasonId > b.seasonId ? -1 : 0);
  });

  const playerHead = tabHeader_(CONFIG.TABS.PLAYERS);
  const seasonHead = tabHeader_(CONFIG.TABS.PLAYER_SEASONS);
  const missing = [];

  const playerFields = PROFILE.PLAYER_FIELDS.filter(function (f) {
    if (playerHead.indexOf(f.col) >= 0) return true;
    missing.push(CONFIG.TABS.PLAYERS + '.' + f.col);
    return false;
  }).map(function (f) { return f.key; });

  const seasonFields = profileSeasonFields_().filter(function (f) {
    if (seasonHead.indexOf(f.col) >= 0) return true;
    missing.push(CONFIG.TABS.PLAYER_SEASONS + '.' + f.col);
    return false;
  }).map(function (f) { return f.key; });

  const current = seasons.filter(function (r) { return r.seasonId === seasonId; })[0] || null;

  return {
    player: {
      playerId: me.playerId,
      name: s_(player.DisplayName),
      gradYear: s_(player.GradYear),
      hometown: s_(player.Hometown),
      bio: s_(player.Bio),
      updatedAt: (player.UpdatedAt instanceof Date)
        ? player.UpdatedAt.toISOString() : s_(player.UpdatedAt),
      updatedBy: s_(player.UpdatedBy)
    },
    seasons: seasons,
    links: {
      hudlUrl: s_(player.HudlURL),
      maxPrepsUrl: s_(player.MaxPrepsURL),
      xHandle: s_(player.XHandle),
      instagramHandle: s_(player.InstagramHandle)
    },
    commitment: {
      commitment: s_(player.Commitment),
      commitmentLevel: s_(player.CommitmentLevel)
    },
    offers: profileParseOffers_(player.Offers),
    editable: {
      seasonId: seasonId,
      hasCurrentSeason: !!current,
      playerSeasonId: current ? current.playerSeasonId : '',
      fields: playerFields,
      seasonFields: seasonFields,
      // Labels, ranges and step for the measured numbers, so the player's form
      // and the coach's roster editor render one identical set of inputs.
      measurables: MEASURABLES,
      commitmentLevels: PROFILE.COMMITMENT_LEVELS.slice(),
      allowedHosts: profileAllowedHosts_(),
      bioMaxChars: PROFILE.BIO_MAX,
      // the surname the rename guard will hold you to
      surname: acctNameParts_(s_(player.DisplayName)).last,
      correctableFields: SUM_FIELDS.slice(),
      // the category vocabulary the stat-entry form renders — the same one
      // the coach's box-score editor uses, from the same constant
      statCategories: (typeof TEAMADMIN !== 'undefined') ? TEAMADMIN.CATEGORIES : {},
      statCategoryOrder: (typeof TEAMADMIN !== 'undefined') ? TEAMADMIN.CATEGORY_ORDER : [],
      // named so the page can say why rather than just greying a control
      readOnly: Object.keys(PROFILE.NEVER),
      missingColumns: missing
    }
  };
}

/**
 * A player enters his own line for one of his team's games.
 *
 * The write goes through the same machinery the coach's box-score editor
 * uses — same validation, same upsert key, same audit — with the self flag
 * set, so the rows land marked PLAYER_ENTRY: published at once, in grey,
 * counted into totals that also turn grey, and queued for the coach to
 * approve, reject, or supersede with the official line. His coach and the
 * administrators are told there is something to look at.
 */
function apiSubmitMyStats_(gameId, rows) {
  const me = profileWhoami_();
  gameId = s_(gameId);
  if (!gameId) throw new Error('Which game?');

  const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) {
    return s_(x.GameID) === gameId;
  })[0];
  if (!g) throw new Error('Unknown game "' + gameId + '".');
  const seasonId = s_(g.SeasonID) || CONFIG.CURRENT_SEASON;

  // his team for THAT game's season — a 2024 game gets his 2024 team
  const seat = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === me.playerId && s_(r.SeasonID) === seasonId;
  })[0];
  if (!seat)
    throw new Error('You are not on a roster for the ' +
                    seasonId.replace('SEA-', '') + ' season, so there is no ' +
                    'team to record these under.');
  const teamId = s_(seat.TeamID);
  if (s_(g.HomeTeamID) !== teamId && s_(g.AwayTeamID) !== teamId)
    throw new Error('That game is not one of ' + (teamNameOf_(teamId) || 'your team') + "'s.");

  /* Entry opens the morning AFTER the game. Numbers typed in at halftime are
     guesses; Saturday's entry is Friday's stats with a night's sleep on them. */
  const gdate = apiDateStr_(g.GameDate);
  if (gdate && apiTodayStr_() <= gdate)
    throw new Error('Stat entry for this game opens the day after it is played. ' +
                    'Come back tomorrow.');

  /* The window for self-entry is BEFORE the official box score exists. One
     official line for this game and team — a coach's entry, an approved entry,
     an import — closes it: from then on the player's road is a correction
     request, which lands on the same Approvals badge. Two entry paths onto the
     same recorded game would make every disagreement a race. */
  const official = rowsOf_(CONFIG.TABS.PLAYER_STATS).some(function (r) {
    return s_(r.GameID) === gameId && s_(r.TeamID) === teamId &&
           s_(r.grain || r.Grain) === CONFIG.GRAIN.GAME &&
           s_(r.SourceType) !== 'PLAYER_ENTRY';
  });
  if (official)
    throw new Error('Your coach has already entered statistics for this game. If a ' +
                    'number is missing or wrong, request a correction below — it goes ' +
                    'to your coach the same way.');

  /* No mail to the coach — the Approvals badge is the notification. Forty
     players entering Friday's stats must not be forty messages. */
  return apiSavePlayerStats_(gameId, teamId, rows,
                            { playerId: me.playerId, email: me.email });
}

// ── write ──────────────────────────────────────────────────────────────────

/**
 * Validate one field out of the patch and stage the cell that changes.
 *
 * Nothing is written here — updates are collected so each tab is touched once,
 * after every field has had its say. A field the caller did not name is left
 * alone; a field whose column is missing is refused by name rather than written
 * nowhere, which is what updateCells() would quietly do with it.
 *
 * `out` carries the running result: saved, refused, audit, and the two flags the
 * caller acts on afterwards — whether the name changed and whether anything the
 * roster depends on did.
 */
function profileApplyField_(f, row, head, tabName, updates, patch, ctx, out) {
  const raw = (patch[f.key] !== undefined) ? patch[f.key] : patch[f.col];
  if (raw === undefined) return;

  if (head.indexOf(f.col) < 0) {
    out.refused.push(f.key + ': ' + tabName + ' has no ' + f.col + ' column. ' +
                     'An administrator must run ensureSchema_().');
    return;
  }

  var value;
  try {
    value = profileValue_(f, raw, ctx);
  } catch (err) {
    out.refused.push(f.key + ': ' + (err && err.message ? err.message : String(err)));
    return;
  }

  const before = row[f.col];
  if (profileSame_(before, value)) return;        // nothing to write, nothing to audit

  const onPlayers = (tabName === CONFIG.TABS.PLAYERS);
  updates.push({ row: row.__row, field: f.col, value: value });
  out.audit.push(auditRow_(ctx.me, 'PROFILE_EDIT',
                          onPlayers ? 'Player' : 'PlayerSeason',
                          onPlayers ? ctx.me.playerId : s_(row.PlayerSeasonID),
                          f.col, before, value, ctx.seasonId));
  out.saved.push(f.key);

  if (f.kind === 'NAME') { out.renamedFrom = s_(before); out.renamedTo = String(value); }
  // a name, a jersey or a position changes what the site and the ballot render
  if (!onPlayers || f.kind === 'NAME') out.rosterTouched = true;
}

/**
 * Save a patch of the caller's own profile.
 *
 * `patch` is a flat object keyed by the `key` names apiMyProfile() hands out
 * (the sheet header works too). A key that is absent is left alone; a key whose
 * value is blank clears the cell. Every field is validated on its own and a bad
 * one lands in `refused` with its reason — one mistyped height does not throw
 * away eleven good fields, which is the difference between a form a teenager
 * fills in once and a form he gives up on.
 *
 * Returns { ok, saved:[keys written], refused:[strings] }.
 */
function apiSaveProfile_(patch, forPlayerId) {
  const me = profileTarget_(forPlayerId);
  patch = patch || {};

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS))
    throw new Error('Another save is in progress. Try again in a moment.');

  try {
    // another execution may have written to either tab since this one read it
    delete __tableCache[CONFIG.TABS.PLAYERS];
    delete __tableCache[CONFIG.TABS.PLAYER_SEASONS];

    const seasonId = CONFIG.CURRENT_SEASON;
    const playerRow = rowsOf_(CONFIG.TABS.PLAYERS).filter(function (p) {
      return s_(p.PlayerID) === me.playerId;
    })[0];
    if (!playerRow)
      throw new Error('Your profile row is missing from the database — this is our ' +
                      'fault, not yours, and nothing you entered was lost. Email ' +
                      'contact@example.invalid and quote ' + me.playerId + '. ' +
                      '(Administrator: Maintenance > Restore orphaned players.)');

    const seasonRow = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
      return s_(r.PlayerID) === me.playerId && s_(r.SeasonID) === seasonId;
    })[0] || null;

    const playerHead = tabHeader_(CONFIG.TABS.PLAYERS);
    const seasonHead = tabHeader_(CONFIG.TABS.PLAYER_SEASONS);
    const ctx = { me: me, seasonId: seasonId, currentName: s_(playerRow.DisplayName) };

    const saved = [], refused = [], audit = [];
    const playerUpdates = [], seasonUpdates = [];

    // Anything the caller named that is not on a registry is refused by name.
    // Silence here would read as success, and the player would keep typing into
    // a field that goes nowhere.
    const known = {};
    PROFILE.PLAYER_FIELDS.concat(profileSeasonFields_()).forEach(function (f) {
      known[f.key.toLowerCase()] = true;
      known[f.col.toLowerCase()] = true;
    });
    Object.keys(patch).forEach(function (k) {
      const lower = String(k).toLowerCase();
      if (known[lower]) return;
      if (PROFILE.NEVER[lower]) { refused.push(k + ': ' + PROFILE.NEVER[lower]); return; }
      if (SUM_FIELDS.indexOf(String(k)) >= 0 || CONFIG.DERIVED_FIELDS.indexOf(String(k)) >= 0) {
        refused.push(k + ': stats are never edited here — file a correction instead.');
        return;
      }
      refused.push(k + ': not a field you can edit.');
    });

    const out = { saved: saved, refused: refused, audit: audit,
                  renamedFrom: '', renamedTo: '', rosterTouched: false };

    PROFILE.PLAYER_FIELDS.forEach(function (f) {
      profileApplyField_(f, playerRow, playerHead, CONFIG.TABS.PLAYERS,
                        playerUpdates, patch, ctx, out);
    });

    profileSeasonFields_().forEach(function (f) {
      const raw = (patch[f.key] !== undefined) ? patch[f.key] : patch[f.col];
      if (raw === undefined) return;
      if (!seasonRow) {
        refused.push(f.key + ': you have no ' + seasonId + ' roster row yet. Your coach ' +
                     'adds you to the roster, then this can be edited.');
        return;
      }
      profileApplyField_(f, seasonRow, seasonHead, CONFIG.TABS.PLAYER_SEASONS,
                        seasonUpdates, patch, ctx, out);
    });

    const renamedFrom = out.renamedFrom, renamedTo = out.renamedTo;

    if (playerUpdates.length) {
      // stamped only when something else on the row actually moved, so the
      // column keeps meaning "last edited" rather than "last opened"
      if (playerHead.indexOf('UpdatedAt') >= 0)
        playerUpdates.push({ row: playerRow.__row, field: 'UpdatedAt', value: new Date() });
      if (playerHead.indexOf('UpdatedBy') >= 0)
        playerUpdates.push({ row: playerRow.__row, field: 'UpdatedBy', value: me.email });
      updateCells_(CONFIG.TABS.PLAYERS, playerUpdates);
    }
    if (seasonUpdates.length) updateCells_(CONFIG.TABS.PLAYER_SEASONS, seasonUpdates);

    if (audit.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, audit); }

    if (renamedTo) {
      // A rename passes the surname guard and is still the single most abusable
      // edit on the page, so the people who could spot a wrong one are told
      // rather than left to find it in the log.
      appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'PROFILE_RENAME', 'Player', me.playerId,
        'DisplayName', renamedFrom, renamedTo, 'self-service rename by ' + me.email)]);
      // the audit row is the record; nobody is mailed about a rename
    }

    if (out.rosterTouched) {
      CacheService.getScriptCache().removeAll(['boot', 'ac-' + seasonId]);
      // a rebuild is not run inline — profiles are edited in bursts the week a
      // season opens, and the sweep trigger collapses a burst into one recompute
      markDirty_('roster');
    }

    return { ok: refused.length === 0, saved: saved, refused: refused };
  } finally {
    lock.releaseLock();
  }
}

// ── corrections ────────────────────────────────────────────────────────────

/**
 * Queue mail for later delivery, in ONE write.
 *
 * queueNotifications() in Accounts.gs stamps every row EntityType 'Account'; a
 * correction is not an account, and the review queue reads that column to find
 * what a message is about. Same table, same discipline, one parameter more.
 * Nothing here sends: delivery has its own quota and its own failure modes, and
 * a bounced message must never roll back a correction that was already filed.
 * Must be called under the script lock — it allocates ids.
 */
function profileQueueNotifications_(recipients, kind, subject, body, entityType, entityId, teamId) {
  const to = (recipients || []).filter(function (e) { return !!s_(e); });
  if (!to.length || !hasTab_(ACCT.NOTIFY)) return 0;
  acctAssertHeaders_(ACCT.NOTIFY, ACCT.NOTIFY_COLS);

  // one allocation for the batch; appendRows would otherwise force a fresh read
  // of the whole tab for every single recipient
  var n = parseInt(nextIdLocked_(ACCT.NOTIFY, 'NotificationID', 'NTF-', 6)
                     .replace(/\D/g, ''), 10);
  const now = new Date();
  return appendRows_(ACCT.NOTIFY, to.map(function (e) {
    var seq = String(n++);
    while (seq.length < 6) seq = '0' + seq;
    return {
      NotificationID: 'NTF-' + seq, ToEmail: s_(e), Kind: kind, Subject: subject,
      Body: body, EntityType: entityType, EntityID: s_(entityId), TeamID: s_(teamId),
      CreatedAt: now, SentAt: '', Status: 'QUEUED'
    };
  }));
}

/**
 * What the database currently holds for this player, field and game.
 *
 * Read from the sheet rather than believed from the client. The client's idea of
 * the current value is what he saw on a cached page; the coach reviewing this
 * needs the number that is actually stored, and a mismatch between the two is
 * itself worth telling him about.
 *
 * Returns '' when nothing is on file. Blank is not zero: "we never recorded a
 * tackle for him" and "he made none" are different claims, and a correction that
 * flattened the first into the second would be a correction that lied.
 */
function profileCurrentStat_(playerId, seasonId, gameId, field) {
  if (gameId) {
    var total = null;
    rowsOf_(CONFIG.TABS.PLAYER_STATS).forEach(function (r) {
      if (s_(r.PlayerID) !== playerId || s_(r.GameID) !== gameId) return;
      if (s_(r.grain || r.Grain) !== CONFIG.GRAIN.GAME) return;   // SEASON_REF is never summed
      const v = numOrNull_(r[field]);
      if (v === null) return;
      total = (total === null ? 0 : total) + v;
    });
    return total === null ? '' : total;
  }

  if (!hasTab_('PlayerSeasonStats')) return '';
  const row = rowsOf_('PlayerSeasonStats').filter(function (r) {
    return s_(r.PlayerID) === playerId && s_(r.SeasonID) === seasonId;
  })[0];
  if (!row) return '';
  const v = numOrNull_(row[field]);
  return v === null ? '' : v;
}

/**
 * A stat a player believes is wrong.
 *
 *   payload { seasonId, gameId|null, field, currentValue, proposedValue, reason }
 *
 * Nothing is changed. A row is written PENDING and the people who can decide are
 * told, with enough in the message — season, week, opponent, field, what is on
 * file, what he says it should be, and why — that a coach can act on it without
 * going looking for the rest.
 *
 * Only the atoms in SUM_FIELDS can be disputed. A derived figure is computed on
 * read from those atoms, so "my completion percentage is wrong" is really a
 * claim about attempts or completions, and correcting the derived number would
 * store something the next rebuild throws away.
 */
function apiRequestCorrection_(payload) {
  const me = profileWhoami_();
  payload = payload || {};

  const seasonId = s_(payload.seasonId) || CONFIG.CURRENT_SEASON;
  const gameId = s_(payload.gameId);
  const field = s_(payload.field);

  if (!field) throw new Error('Which stat?');
  if (CONFIG.DERIVED_FIELDS.indexOf(field) >= 0)
    throw new Error(field + ' is worked out from the numbers behind it and is never ' +
                    'stored. Correct the attempts, yards or completions instead.');
  if (SUM_FIELDS.indexOf(field) < 0)
    throw new Error('"' + field + '" is not a stat this database keeps.');

  const known = rowsOf_(CONFIG.TABS.SEASONS).some(function (x) {
    return s_(x.SeasonID) === seasonId;
  });
  if (!known) throw new Error('Unknown season "' + seasonId + '".');

  // The roster row is what proves this is his own stat line, and it is where the
  // team comes from — the client never gets to name a team.
  const mine = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.PlayerID) === me.playerId && s_(r.SeasonID) === seasonId;
  })[0];
  if (!mine)
    throw new Error('You have no roster row for ' + seasonId + ', so there is nothing ' +
                    'of yours to correct in it.');
  const teamId = s_(mine.TeamID);

  var gameNote = '';
  if (gameId) {
    const g = rowsOf_(CONFIG.TABS.GAMES).filter(function (x) { return s_(x.GameID) === gameId; })[0];
    if (!g) throw new Error('Unknown game "' + gameId + '".');
    if (s_(g.SeasonID) !== seasonId)
      throw new Error('Game ' + gameId + ' is not in ' + seasonId + '.');
    if (s_(g.HomeTeamID) !== teamId && s_(g.AwayTeamID) !== teamId)
      throw new Error('Your team did not play in game ' + gameId + '.');
    const home = s_(g.HomeTeamID) === teamId;
    gameNote = 'Week ' + (num_(g.Week) === null ? '?' : num_(g.Week)) + ', ' +
               (home ? 'vs ' : 'at ') +
               (home ? (s_(g.AwayTeamName) || s_(g.AwayTeamID))
                     : (s_(g.HomeTeamName) || s_(g.HomeTeamID)));
  }

  // Blank is a legitimate proposal: "this was never reported" is a different and
  // often truer claim than "this was zero".
  const rawProposed = payload.proposedValue;
  var proposed = '';
  if (!(rawProposed === '' || rawProposed === null || rawProposed === undefined)) {
    const n = numOrNull_(rawProposed);
    if (n === null) throw new Error('"' + rawProposed + '" is not a number.');
    if (n < -1000 || n > 1000)
      throw new Error('A ' + field + ' of ' + n + ' is not a plausible correction.');
    if (n * 2 !== Math.round(n * 2))
      throw new Error('Stats are whole numbers, or halves for sacks and tackles for loss.');
    proposed = n;
  }

  const reason = profileText_(payload.reason, PROFILE.REASON_MAX);
  if (reason.length < PROFILE.REASON_MIN)
    throw new Error('Say what happened, in at least ' + PROFILE.REASON_MIN +
                    ' characters. A coach has to be able to check it.');

  const onFile = profileCurrentStat_(me.playerId, seasonId, gameId, field);
  if (profileSame_(onFile, proposed))
    throw new Error('The database already holds ' +
                    (onFile === '' ? 'no value' : onFile) + ' for that. Nothing to change.');

  // What he was looking at, when it is not what is stored. Usually a cached page
  // or a season total where he meant one game, and the coach should know which.
  const claimed = payload.currentValue;
  const stale = !(claimed === undefined) && !profileSame_(claimed, onFile)
    ? '\nHe reported seeing "' + s_(claimed) + '", which is not what is on file.' : '';

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Busy — try again.');

  try {
    ensureOpsTabs_();
    delete __tableCache[CONFIG.TABS.CORRECTIONS];
    acctAssertHeaders_(CONFIG.TABS.CORRECTIONS, PROFILE.CORRECTION_COLS);

    const existing = rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
      return s_(r.PlayerID) === me.playerId && profileCorrectionStatus_(r) === 'PENDING';
    });
    if (existing.length >= PROFILE.OPEN_CORRECTION_CAP)
      throw new Error('You already have ' + existing.length + ' corrections waiting. ' +
                      'Wait for those to be reviewed before filing more.');

    const duplicate = existing.some(function (r) {
      return s_(r.Field) === field && s_(r.SeasonID) === seasonId && s_(r.GameID) === gameId;
    });
    if (duplicate)
      throw new Error('You already have a correction waiting for ' + field +
                      (gameId ? ' in that game.' : ' in ' + seasonId + '.'));

    const correctionId = nextIdLocked_(CONFIG.TABS.CORRECTIONS, 'CorrectionID', 'CORR-', 6);

    appendRows_(CONFIG.TABS.CORRECTIONS, [{
      CorrectionID: correctionId,
      // PlayerGameStats carries no StatID column, so there is no id to put here.
      // The row is identified by GameID + PlayerID + Field, which is exactly what
      // the reviewer searches on. A made-up id would only look authoritative.
      StatID: '',
      GameID: gameId,
      PlayerID: me.playerId,
      Field: field,
      OldValue: onFile,
      NewValue: proposed,
      CorrectedBy: me.email,
      Role: me.role,
      CorrectedAt: new Date(),
      Reason: reason,
      Status: 'PENDING',
      ReviewedBy: '',
      ReviewedAt: '',
      SeasonID: seasonId,
      TeamID: teamId
    }]);

    appendRows_(CONFIG.TABS.AUDIT, [auditRow_(me, 'CORRECTION_REQUEST', 'StatCorrection',
      correctionId, field, onFile, proposed,
      seasonId + (gameId ? ' ' + gameId : '') + ' — ' + reason)]);

    /* The coaches ARE mailed, with links that settle it from the inbox.
       (CorrectionMail.gs. The badge alone was the notification once, on the
       theory that forty emails a week is how all forty get ignored — but a
       school whose coach has no account had no badge to look at either, and
       those requests sat until somebody made a phone call. One email that can
       be answered in one click is the smaller cost.) Never throws: a
       correction that is filed and not mailed is still filed. */
    if (typeof corrNotifyCoaches_ === 'function') corrNotifyCoaches_(correctionId);

    /* The owner reads every filing in the morning email, with the links that
       settle it. No note per filing: the day's hundred messages are for codes. */

    return { ok: true, correctionId: correctionId };
  } finally {
    lock.releaseLock();
  }
}

/** Blank is not approved. An unfilled Status is a correction nobody reviewed. */
function profileCorrectionStatus_(row) {
  const v = s_(row && row.Status).toUpperCase();
  return v || 'PENDING';
}

/**
 * The caller's own corrections, newest first — filed, decided and all.
 * A player who cannot see what happened to his dispute files it again.
 */
function apiMyCorrections_() {
  const me = profileWhoami_();
  if (!hasTab_(CONFIG.TABS.CORRECTIONS)) return [];

  const games = indexBy_(rowsOf_(CONFIG.TABS.GAMES), function (g) { return s_(g.GameID); });

  return rowsOf_(CONFIG.TABS.CORRECTIONS).filter(function (r) {
    return s_(r.PlayerID) === me.playerId;
  }).map(function (r) {
    const g = games[s_(r.GameID)] || {};
    return {
      correctionId: s_(r.CorrectionID),
      seasonId: s_(r.SeasonID),
      gameId: s_(r.GameID),
      week: num_(g.Week),
      field: s_(r.Field),
      // blank travels as null, never as 0 — the page must be able to print
      // "not reported" rather than a number nobody recorded
      oldValue: num_(r.OldValue),
      newValue: num_(r.NewValue),
      reason: s_(r.Reason),
      status: profileCorrectionStatus_(r),
      reviewedBy: s_(r.ReviewedBy),
      reviewedAt: (r.ReviewedAt instanceof Date) ? r.ReviewedAt.toISOString() : s_(r.ReviewedAt),
      createdAt: (r.CorrectedAt instanceof Date) ? r.CorrectedAt.toISOString() : s_(r.CorrectedAt)
    };
  }).sort(function (a, b) {
    return a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0);
  });
}

// ── delivery ───────────────────────────────────────────────────────────────

/** An address MailApp could conceivably deliver to. */
function profileMailable_(email) {
  return /^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$/.test(String(email || '').trim());
}

/**
 * Send whatever is queued in Notifications and mark it SENT.
 *
 * Call this from the sweep, NOT from inside runRebuild() — that function already
 * holds the script lock and LockService locks are not reentrant, so a nested call
 * would block on itself for the full timeout and then give up.
 *
 * Each row is marked the instant its message goes out rather than in one batch at
 * the end. A batched write that never lands because the execution timed out would
 * re-send every message in the batch on the next sweep, and the people on the
 * receiving end of that are coaches.
 *
 * Failures are not retried into oblivion. A send that fails for a reason that
 * might pass later — quota, a transient Google error — is left PENDING and the
 * reason goes to the AuditLog, where somebody can read it. An address that is not
 * an address can never succeed, so it is marked FAILED once instead of consuming
 * a slot in every sweep from now until someone notices.
 */
function sendPendingNotifications_(limit) {
  if (!hasTab_(ACCT.NOTIFY)) return 'No ' + ACCT.NOTIFY + ' tab — nothing to send.';

  const head = tabHeader_(ACCT.NOTIFY);
  const need = ['NotificationID', 'ToEmail', 'Subject', 'Body', 'SentAt', 'Status'];
  const missing = need.filter(function (h) { return head.indexOf(h) < 0; });
  // A trigger that throws mails the owner a stack trace every fifteen minutes.
  // Report it and stop.
  if (missing.length)
    return ACCT.NOTIFY + ' is missing column(s): ' + missing.join(', ') +
           '. Run ensureSchema_(). Nothing sent.';

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'another delivery is already running — skipped';

  try {
    delete __tableCache[ACCT.NOTIFY];
    const queued = rowsOf_(ACCT.NOTIFY).filter(function (r) {
      const st = s_(r.Status).toUpperCase();
      return (st === 'QUEUED' || st === 'PENDING' || st === '') && !s_(r.SentAt);
    });
    if (!queued.length) return 'nothing queued';

    var quota = 0;
    try {
      quota = MailApp.getRemainingDailyQuota();
    } catch (e) {
      return 'mail quota unreadable (' + (e && e.message ? e.message : e) + ') — ' +
             queued.length + ' left queued';
    }
    if (quota <= PROFILE.MAIL_RESERVE)
      return 'remaining mail quota (' + quota + ') is reserved for sign-in codes — ' +
             queued.length + ' left queued, retried next sweep';

    const budget = Math.min(queued.length, quota - PROFILE.MAIL_RESERVE,
                            limit || PROFILE.MAIL_BATCH);
    const me = { email: 'system', role: 'SYSTEM' };
    const failures = [];
    var sent = 0, failed = 0, stopped = '';

    for (var i = 0; i < budget; i++) {
      const r = queued[i];
      const to = s_(r.ToEmail);
      const id = s_(r.NotificationID);

      if (!profileMailable_(to)) {
        updateCells_(ACCT.NOTIFY, [{ row: r.__row, field: 'Status', value: 'FAILED' }]);
        failures.push(auditRow_(me, 'NOTIFY_FAILED', 'Notification', id, 'Status',
          s_(r.Status), 'FAILED', '"' + to + '" is not a deliverable address'));
        failed++;
        continue;
      }

      try {
        MailApp.sendEmail({
          to: to,
          subject: s_(r.Subject) || 'UCBAC Stats',
          body: s_(r.Body) + '\n\n— UCBAC Stats. This message was sent automatically; ' +
                'replies to it are not read.',
          name: 'UCBAC Stats'
        });
      } catch (e) {
        const why = (e && e.message ? e.message : String(e)).slice(0, 240);
        updateCells_(ACCT.NOTIFY, [{ row: r.__row, field: 'Status', value: 'PENDING' }]);
        failures.push(auditRow_(me, 'NOTIFY_DEFERRED', 'Notification', id, 'Status',
          s_(r.Status), 'PENDING', why));
        Logger.log('sendPendingNotifications: ' + id + ' deferred — ' + why);

        // Once the quota is gone every remaining send fails the same way, and
        // each attempt costs an execution second for nothing.
        if (/quota|too many times|limit/i.test(why)) {
          stopped = 'stopped at the daily quota';
          break;
        }
        continue;
      }

      updateCells_(ACCT.NOTIFY, [
        { row: r.__row, field: 'Status', value: 'SENT' },
        { row: r.__row, field: 'SentAt', value: new Date() }
      ]);
      sent++;
    }

    if (failures.length) { ensureOpsTabs_(); appendRows_(CONFIG.TABS.AUDIT, failures); }

    const left = queued.length - sent - failed;
    const msg = 'sent ' + sent + ', ' + failed + ' undeliverable, ' + left + ' left queued' +
                (stopped ? ' (' + stopped + ')' : '') +
                '. Quota remaining: ' + Math.max(0, quota - sent) + '.';
    Logger.log('sendPendingNotifications: ' + msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}