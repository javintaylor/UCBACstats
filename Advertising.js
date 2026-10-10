/**
 * UCBAC Stats — Advertising.gs
 *
 * The order form on the Site's hidden Advertising page posts here. Nothing
 * else in the project takes a POST, so this file owns doPost: the page sends
 * one JSON object, and the server prices it from the rate card below, writes
 * it to the AdOrders tab, mails a summary to ADS.TO with Reply-To set to the
 * advertiser, and sends the advertiser a copy saying the request is pending.
 * Replying to that summary email is how an order is accepted or declined;
 * nothing here decides anything.
 *
 * The page posts with Content-Type text/plain so the browser sends no CORS
 * preflight (an Apps Script web app cannot answer one); the body is still
 * JSON, and the answer is JSON the page can read.
 *
 * After pasting this file: Deploy > Manage deployments > edit > Version: New
 * version. A function is not published until the deployment moves, and until
 * then the page's request lands on a deployment with no doPost at all.
 *
 * The rate card here and the one inside the Advertising page must agree. The
 * server's copy is the one that prices the email; if the page's estimate
 * differs, the email says so and shows both. The page also asks here for the
 * live card when it loads ({kind:'ad-rates'}), so what it shows follows this
 * file and the two script properties below without republishing the page.
 *
 * THE WEEK. Content weeks run Monday to Sunday: the Weekly Slate posts Monday,
 * the Weekly Finals Friday, Top 10 Plays Sunday. Week 5 begins Monday,
 * September 28, 2026; Week 10 is playoff Round 1; up to three playoff rounds
 * follow. The "Weeks N-10" package is whatever is left of the six-week core
 * term, priced at the listed rate times the share remaining, rounded to $5,
 * and it moves on its own every Monday. After Week 10 the core term is gone:
 * weekly tests and the playoff rounds remain; after the last round the
 * Instagram inventory closes for the year. Website placements run year-round.
 *
 * TWO SCRIPT PROPERTIES (Project Settings > Script properties) are read on
 * every request, so they take effect at once, with no new deployment:
 *   ADS_SOLD   comma-separated keys of what is booked, e.g. "slate,banner".
 *              Keys: slate, finals, top10, story, igpartner, fansign, banner,
 *              both, flagship, flagshipPlayoffs. The page shows them as
 *              Booked; an order naming one is refused.
 *   ADS_WEEK   a week number to pin the current week, if the calendar ever
 *              needs overriding. Blank follows the calendar.
 *
 * To check the mail path from the editor: Run > adsSelfTest. It sends a
 * sample order to ADS.TO, marked [TEST], and writes no row.
 */

const ADS = {
  TO: 'contact@example.invalid',
  FROM_NAME: 'UCBAC Stats',
  SEASON: '2026',
  TAB: 'AdOrders',
  COLS: ['OrderID', 'ReceivedAt', 'Status', 'Business', 'Contact', 'Email', 'Phone',
         'Website', 'Instagram', 'Category', 'Exclusivity', 'Flagship',
         'InstagramTerm', 'InstagramWeeks', 'InstagramItems',
         'WebsiteSeason', 'WebsiteMonths', 'WebsiteWeeks', 'WebsiteItem',
         'PreferredStart', 'Artwork', 'LogoFile', 'Notes', 'SeasonWeek', 'Estimate', 'PageEstimate', 'Lines',
         'Mailed', 'Decision', 'DecisionNote'],

  /* ---- the calendar: see THE WEEK above ---- */
  SCHEDULE: { FIRST_WEEK: 5, LAST_WEEK: 10, WEEK5_MONDAY: '2026-09-28', PLAYOFF_ROUNDS: 3 },

  /* ---- outbound clicks on the homepage sponsor banner ---- */
  CLICKS_TAB: 'SponsorClicks',
  CLICKS_COLS: ['ClickedAt', 'Placement', 'Sponsor', 'Route', 'VisitorID', 'Width'],

  /* ---- a logo attached to an order: it rides inside the request as base64,
     is saved to this Drive folder (created on first use, in the deploying
     account's My Drive) and attached to the summary email ---- */
  LOGO: {
    FOLDER: 'UCBAC Advertising logos',
    MAX_BYTES: 4 * 1024 * 1024,
    TYPES: { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1, 'image/svg+xml': 1,
             'application/pdf': 1, 'application/postscript': 1, 'application/illustrator': 1 },
    EXT: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
           svg: 'image/svg+xml', pdf: 'application/pdf', ai: 'application/postscript', eps: 'application/postscript' }
  },

  // MailApp's daily allowance is shared with sign-in codes; those come first.
  QUOTA_FLOOR: 5,        // below this, log the order and skip every email
  COPY_FLOOR: 20,        // below this, skip only the advertiser's copy
  PER_EMAIL_HOUR: 5,     // one advertiser, one hour
  PER_HOUR: 40,          // everyone, one hour

  /* ---- the rate card: 2026 media kit, pages 8 and 9 ---- */
  IG: {
    slate:     { name: 'Weekly Slate sponsor',             weekly: 60,  core: 300,  ext: 150 },
    finals:    { name: 'Weekly Finals sponsor',            weekly: 60,  core: 300,  ext: 150 },
    top10:     { name: 'Top 10 Plays sponsor',             weekly: 100, core: 500,  ext: 100 },
    story:     { name: 'Story post or reshare',            weekly: 30,  core: 150,  ext: 75  },
    igpartner: { name: 'All-Instagram presenting partner', weekly: 0,   core: 1000, ext: 350 }
  },
  IG_TERMS: { weekly: 'Weekly test', core: 'Remaining core term', coreExt: 'Remaining core term + playoff extension',
              playoffs: 'Remaining playoff rounds' },
  FLAGSHIP: {
    flagship:         { name: 'Cross-platform flagship',            price: 1500 },
    flagshipPlayoffs: { name: 'Cross-platform flagship + playoffs', price: 1850 }
  },
  WEB: {
    fansign: { name: 'Fan sign logo placement',    weekly: 45, season: 450, month: 100 },
    banner:  { name: 'Fixed bottom banner',        weekly: 30, season: 300, month: 75  },
    both:    { name: 'Fan sign + bottom banner',   weekly: 75, season: 750, month: 175 }
  },
  WEB_SEASONS: { inseason: 'In season (through December)', offseason: 'Offseason', weekly: 'Weekly test' }
};

/* ------------------------------------------------------------------ */
/* the endpoint                                                        */
/* ------------------------------------------------------------------ */

function doPost(e) {
  if (e && e.parameter && Object.prototype.hasOwnProperty.call(e.parameter, 'appPublicEvidence')) return ucbacAppPublicEvidence_(e);
  if (e && e.parameter && Object.prototype.hasOwnProperty.call(e.parameter, 'appDailySummary')) return ucbacAppDailySummary_(e);
  var out;
  try {
    const raw = e && e.postData && e.postData.contents;
    const body = raw ? JSON.parse(raw) : {};
    if (body && body.kind === 'ad-order') out = adsReceive_(body);
    else if (body && body.kind === 'ad-rates') out = adsRatesPayload_();
    else out = { ok: false, error: 'This address takes advertising orders only.' };
  } catch (err) {
    Logger.log('doPost: ' + (err && err.stack ? err.stack : err));
    out = { ok: false, error: 'The order could not be read. Please try again, or email ' + ADS.TO + '.' };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
                       .setMimeType(ContentService.MimeType.JSON);
}

/**
 * One order: validate, price, log, mail. Returns what the page shows.
 * body.test = true is the self-test: mailed to ADS.TO only, marked, not logged.
 */
function adsReceive_(body) {
  body = body || {};

  // A hidden field no person can see. A filled one is a bot; say yes and drop it.
  if (adsClean_(body.hp, 200)) return { ok: true, ref: 'AD-' + adsStamp_() + '-0000', dropped: true };

  const o = adsOrderFrom_(body);
  const week = adsWeek_();
  const sold = body.test ? [] : adsSold_();
  const problems = adsProblems_(o, week, sold);
  const logoCheck = body.logo ? adsLogoCheck_(body.logo) : null;
  if (logoCheck && logoCheck.error) problems.push(logoCheck.error);
  if (problems.length) return { ok: false, error: problems.join(' ') };

  const busy = body.test ? '' : adsThrottle_(o.email);
  if (busy) return { ok: false, error: busy };

  const price = adsPrice_(o, week);
  o.week = week;
  o.ref = 'AD-' + adsStamp_() + '-' + adsSuffix_();
  o.receivedAt = Utilities.formatDate(new Date(), adsTz_(), 'yyyy-MM-dd HH:mm');
  o.total = price.total;
  o.lines = price.lines;

  // the logo, to Drive; a Drive failure loses the file, never the order
  o.logo = null; o.logoFailed = '';
  if (logoCheck && !body.test) {
    try { o.logo = adsSaveLogo_(logoCheck, o); }
    catch (err) {
      o.logoFailed = logoCheck.name;
      Logger.log('logo not saved for ' + o.ref + ': ' + (err && err.message ? err.message : err));
    }
  }

  var logged = false;
  if (!body.test) {
    try {
      ensureTab_(ADS.TAB, ADS.COLS);
      const row = adsRow_(o);
      logged = appendRows_(ADS.TAB, [row]) === 1;
    } catch (err) {
      Logger.log('AdOrders write failed for ' + o.ref + ': ' + (err && err.message ? err.message : err));
    }
  }

  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (err) {}
  var mailed = false, copied = false;
  if (quota === -1 || quota >= ADS.QUOTA_FLOOR) {
    try {
      const m = adsSummaryMail_(o, !!body.test);
      const mail = { to: ADS.TO, replyTo: o.email, subject: m.subject,
                     body: m.body, htmlBody: m.htmlBody, name: ADS.FROM_NAME };
      if (o.logo && o.logo.blob) mail.attachments = [o.logo.blob];
      MailApp.sendEmail(mail);
      mailed = true;
    } catch (err) {
      Logger.log('summary mail failed for ' + o.ref + ': ' + (err && err.message ? err.message : err));
    }
    if (mailed && !body.test && (quota === -1 || quota >= ADS.COPY_FLOOR)) {
      try {
        const c = adsCopyMail_(o);
        MailApp.sendEmail({ to: o.email, replyTo: ADS.TO, subject: c.subject,
                            body: c.body, htmlBody: c.htmlBody, name: ADS.FROM_NAME });
        copied = true;
      } catch (err) {
        Logger.log('copy mail failed for ' + o.ref + ': ' + (err && err.message ? err.message : err));
      }
    }
  } else {
    Logger.log('order ' + o.ref + ' logged, mail skipped: ' + quota + ' messages left today');
  }
  if (logged) {
    try { adsMarkMailed_(o.ref, mailed ? (copied ? 'yes + copy' : 'yes') : 'no'); } catch (err) {}
  }

  return { ok: true, ref: o.ref, total: o.total, lines: o.lines,
           mailed: mailed, copied: copied, logged: logged,
           logo: o.logo ? { saved: true, name: o.logo.name } : (o.logoFailed ? { saved: false, name: o.logoFailed } : null) };
}

/* ------------------------------------------------------------------ */
/* the logo file                                                       */
/* ------------------------------------------------------------------ */

/** The file as the page sent it, checked; { error } when it is refused. */
function adsLogoCheck_(logo) {
  if (!logo || typeof logo !== 'object') return null;
  const name = (adsClean_(logo.name, 120) || 'logo').replace(/[\\\/:*?"<>|]/g, '-');
  const data = String(logo.data || '').replace(/\s+/g, '');
  if (!data) return { error: 'The logo file arrived empty. Please attach it again, or paste a link.' };
  if (!/^[A-Za-z0-9+\/]+=*$/.test(data)) return { error: 'The logo file could not be read. Please attach it again, or paste a link.' };
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [0, ''])[1].toLowerCase();
  var type = adsClean_(logo.type, 80).toLowerCase();
  if (!ADS.LOGO.TYPES[type]) type = ADS.LOGO.EXT[ext] || '';
  if (!type) return { error: 'Logo files can be PNG, JPG, GIF, WebP, SVG, PDF, AI or EPS.' };
  const bytes = Math.floor(data.length * 3 / 4) - (data.match(/=+$/) || [''])[0].length;
  if (bytes > ADS.LOGO.MAX_BYTES) return { error: 'The logo file is larger than 4 MB. Please send a smaller file, or paste a link.' };
  return { name: name, type: type, data: data, bytes: bytes };
}

/** Save it to the Drive folder, named by the order. */
function adsSaveLogo_(check, o) {
  const blob = Utilities.newBlob(Utilities.base64Decode(check.data), check.type, check.name);
  const file = adsLogoFolder_().createFile(blob);
  file.setName(o.ref + ' - ' + o.business + ' - ' + check.name);
  return { name: check.name, url: file.getUrl(), id: file.getId(), bytes: check.bytes, blob: blob };
}

function adsLogoFolder_() {
  const found = DriveApp.getFoldersByName(ADS.LOGO.FOLDER);
  if (found.hasNext()) return found.next();
  return DriveApp.createFolder(ADS.LOGO.FOLDER);
}

/* ------------------------------------------------------------------ */
/* reading the order                                                   */
/* ------------------------------------------------------------------ */

function adsOrderFrom_(b) {
  const keys = function (list, table) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (k) {
      k = adsClean_(k, 30);
      if (table[k] && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  };
  const one = function (v, table) { v = adsClean_(v, 30); return table[v] ? v : ''; };
  const num = function (v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  };
  return {
    business:   adsClean_(b.business, 120),
    contact:    adsClean_(b.contact, 80),
    email:      adsClean_(b.email, 254).toLowerCase(),
    phone:      adsClean_(b.phone, 40),
    website:    adsClean_(b.website, 200),
    instagram:  adsClean_(b.instagram, 60).replace(/^@+/, ''),
    category:   adsClean_(b.category, 80),
    exclusivity: b.exclusivity === true || b.exclusivity === 'yes' || b.exclusivity === 'on',
    flagship:   one(b.flagship, ADS.FLAGSHIP),
    igTerm:     one(b.igTerm, ADS.IG_TERMS) || 'core',
    igWeeks:    num(b.igWeeks, 1, 5, 1),
    ig:         keys(b.ig, ADS.IG),
    webSeason:  one(b.webSeason, ADS.WEB_SEASONS) || 'inseason',
    webMonths:  num(b.webMonths, 1, 12, 1),
    webWeeks:   num(b.webWeeks, 1, 5, 1),
    web:        one(b.web, ADS.WEB),
    start:      adsClean_(b.start, 120),
    artwork:    adsClean_(b.artwork, 300),
    notes:      adsClean_(b.notes, 2000, true),
    pageEstimate: (typeof b.estimate === 'number' && isFinite(b.estimate)) ? Math.round(b.estimate) : null,
    pageWeek:   parseInt(b.pageWeek, 10) || 0,
    agree:      b.agree === true || b.agree === 'yes' || b.agree === 'on'
  };
}

function adsProblems_(o, week, sold) {
  const p = [];
  if (o.business.length < 2) p.push('Business name is missing.');
  if (o.contact.length < 2) p.push('Contact name is missing.');
  if (!adsEmailOk_(o.email)) p.push('A working email address is needed for the reply.');
  if (!o.flagship && !o.ig.length && !o.web) p.push('Choose at least one placement.');
  if (!o.agree) p.push('Please confirm that this is a request, not a booking.');
  if (o.flagship && !week.remaining) p.push('The flagship packages closed with Week 10.');
  if (o.ig.length && !o.flagship && week.seasonOver) p.push('The 2026 Instagram season has ended; website placements are still open.');
  if (o.ig.length && !o.flagship && !week.remaining && (o.igTerm === 'core' || o.igTerm === 'coreExt'))
    p.push('The Weeks 5-10 term has ended; choose a weekly test or the remaining playoff rounds.');
  const booked = [];
  if (o.flagship && sold.indexOf(o.flagship) >= 0) booked.push(ADS.FLAGSHIP[o.flagship].name);
  if (!o.flagship) {
    o.ig.forEach(function (k) { if (sold.indexOf(k) >= 0) booked.push(ADS.IG[k].name); });
    if (o.web && sold.indexOf(o.web) >= 0) booked.push(ADS.WEB[o.web].name);
  }
  if (booked.length) p.push('Already booked: ' + booked.join(', ') + '. Please choose another placement.');
  return p;
}

/** Text as typed, minus control characters and runaway length. */
function adsClean_(v, max, keepLines) {
  var s = (v === null || v === undefined) ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = keepLines ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** An address MailApp could conceivably deliver to. */
function adsEmailOk_(e) {
  return !!e && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/* ------------------------------------------------------------------ */
/* pricing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lines and a total from the rate card, for the given week. A flagship
 * includes every Instagram feature and both website placements, so with one
 * chosen nothing else is priced. The presenting partner has no weekly rate:
 * asked for weekly, it is priced at the remaining term and the line says so.
 * Once the core term is over, every Instagram term prices as the playoff
 * rounds, which is the extension price on its own.
 */
function adsPrice_(o, week) {
  week = week || adsWeek_();
  const lines = [];
  const add = function (label, amount) { lines.push({ label: label, amount: amount }); };

  if (o.flagship && week.remaining) {
    const base = adsCorePrice_(ADS.FLAGSHIP.flagship.price, week);
    if (o.flagship === 'flagshipPlayoffs')
      add(ADS.FLAGSHIP.flagshipPlayoffs.name + ' — ' + week.label + ' and the playoff rounds',
          base + (ADS.FLAGSHIP.flagshipPlayoffs.price - ADS.FLAGSHIP.flagship.price));
    else add(ADS.FLAGSHIP.flagship.name + ' — ' + week.label, base);
  } else {
    o.ig.forEach(function (k) {
      const r = ADS.IG[k];
      if (o.igTerm === 'weekly') {
        if (r.weekly) add(r.name + ' — weekly test, ' + o.igWeeks + ' week' + (o.igWeeks === 1 ? '' : 's'), r.weekly * o.igWeeks);
        else if (week.remaining) add(r.name + ' — ' + week.label + ' (no weekly rate)', adsCorePrice_(r.core, week));
        else add(r.name + ' — remaining playoff rounds (no weekly rate)', r.ext);
      } else if (o.igTerm === 'playoffs' || !week.remaining) {
        add(r.name + ' — remaining playoff rounds', r.ext);
      } else {
        add(r.name + ' — ' + week.label, adsCorePrice_(r.core, week));
        if (o.igTerm === 'coreExt') add(r.name + ' — playoff extension', r.ext);
      }
    });
    if (o.web) {
      const w = ADS.WEB[o.web];
      if (o.webSeason === 'offseason') add(w.name + ' — offseason, ' + o.webMonths + ' month' + (o.webMonths === 1 ? '' : 's'), w.month * o.webMonths);
      else if (o.webSeason === 'weekly') add(w.name + ' — weekly test, ' + o.webWeeks + ' week' + (o.webWeeks === 1 ? '' : 's'), w.weekly * o.webWeeks);
      else add(w.name + ' — in season, through December', w.season);
    }
  }
  var total = 0;
  lines.forEach(function (l) { total += l.amount; });
  return { lines: lines, total: total };
}

function adsMoney_(n) {
  return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function adsRound5_(n) { return Math.round(n / 5) * 5; }

/** A core-term price for the weeks still to come. */
function adsCorePrice_(base, week) {
  return adsRound5_(base * week.remaining / week.coreWeeks);
}

/* ------------------------------------------------------------------ */
/* the week                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the season stands on a given day ('yyyy-MM-dd' in the script's zone),
 * or at a pinned week number. The same arithmetic runs inside the page.
 */
function adsWeekFor_(dateStr, pin) {
  const S = ADS.SCHEDULE;
  const days = function (s) {
    const p = String(s).split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  };
  const since = days(dateStr) - days(S.WEEK5_MONDAY);
  const current = pin ? pin : (since < 0 ? S.FIRST_WEEK : S.FIRST_WEEK + Math.floor(since / 7));
  const remaining = Math.max(0, S.LAST_WEEK - current + 1);
  return {
    current: current,
    remaining: remaining,
    coreWeeks: S.LAST_WEEK - S.FIRST_WEEK + 1,
    playoffRound: current >= S.LAST_WEEK ? current - S.LAST_WEEK + 1 : 0,
    seasonOver: current > S.LAST_WEEK + S.PLAYOFF_ROUNDS,
    label: remaining ? 'Weeks ' + current + '-' + S.LAST_WEEK : 'Playoff rounds'
  };
}

/** Today's week, unless ADS_WEEK pins one. */
function adsWeek_() {
  var pin = 0;
  try { pin = parseInt(PropertiesService.getScriptProperties().getProperty('ADS_WEEK'), 10) || 0; } catch (e) {}
  return adsWeekFor_(Utilities.formatDate(new Date(), adsTz_(), 'yyyy-MM-dd'), pin);
}

/** What ADS_SOLD says is booked, limited to keys the rate card knows. */
function adsSold_() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty('ADS_SOLD') || ''; } catch (e) {}
  return String(raw).split(',').map(function (k) { return k.trim(); })
    .filter(function (k) { return ADS.IG[k] || ADS.WEB[k] || ADS.FLAGSHIP[k]; });
}

/* ------------------------------------------------------------------ */
/* sponsor clicks                                                      */
/* ------------------------------------------------------------------ */

/**
 * The homepage banner (Index.html) reports each outbound click here through
 * google.script.run, for the sponsor's campaign report: one row per click on
 * the SponsorClicks tab. A visitor's repeated clicks inside a minute count
 * once. A pass-through in the WebApp.gs manner, kept here so the banner
 * needs no other file; nothing about the visitor is recorded beyond the
 * anonymous id the site already keeps for its own traffic count.
 */
function svcSponsorClick(placement, sponsor, route, visitorId, width) {
  return apiSponsorClick_(placement, sponsor, route, visitorId, width);
}

function apiSponsorClick_(placement, sponsor, route, visitorId, width) {
  const p = adsClean_(placement, 40), s = adsClean_(sponsor, 80);
  const r = adsClean_(route, 120), v = adsClean_(visitorId, 60);
  if (!p || !s) return { ok: false };
  try {
    const cache = CacheService.getScriptCache();
    const key = 'spon:' + p + ':' + s + ':' + (v || 'anon');
    if (cache.get(key)) return { ok: true, repeat: true };
    cache.put(key, '1', 60);
  } catch (e) {}
  try {
    ensureTab_(ADS.CLICKS_TAB, ADS.CLICKS_COLS);
    appendRows_(ADS.CLICKS_TAB, [{
      ClickedAt: Utilities.formatDate(new Date(), adsTz_(), 'yyyy-MM-dd HH:mm:ss'),
      Placement: p, Sponsor: s, Route: r || 'home', VisitorID: v,
      Width: parseInt(width, 10) || ''
    }]);
  } catch (e) {
    Logger.log('sponsor click not written: ' + (e && e.message ? e.message : e));
    return { ok: false };
  }
  return { ok: true };
}

/** The live card the page asks for when it loads. */
function adsRatesPayload_() {
  return {
    ok: true,
    rates: { ig: ADS.IG, flagship: ADS.FLAGSHIP, web: ADS.WEB },
    week: adsWeek_(),
    sold: adsSold_(),
    schedule: ADS.SCHEDULE,
    asOf: Utilities.formatDate(new Date(), adsTz_(), 'yyyy-MM-dd HH:mm')
  };
}

/* ------------------------------------------------------------------ */
/* the tab                                                             */
/* ------------------------------------------------------------------ */

function adsRow_(o) {
  return {
    OrderID: o.ref, ReceivedAt: o.receivedAt, Status: 'NEW',
    Business: o.business, Contact: o.contact, Email: o.email, Phone: o.phone,
    Website: o.website, Instagram: o.instagram, Category: o.category,
    Exclusivity: o.exclusivity ? 'yes' : '',
    Flagship: o.flagship ? ADS.FLAGSHIP[o.flagship].name : '',
    InstagramTerm: o.ig.length && !o.flagship ? ADS.IG_TERMS[o.igTerm] : '',
    InstagramWeeks: o.ig.length && !o.flagship && o.igTerm === 'weekly' ? o.igWeeks : '',
    InstagramItems: o.flagship ? '' : o.ig.map(function (k) { return ADS.IG[k].name; }).join('; '),
    WebsiteSeason: o.web && !o.flagship ? ADS.WEB_SEASONS[o.webSeason] : '',
    WebsiteMonths: o.web && !o.flagship && o.webSeason === 'offseason' ? o.webMonths : '',
    WebsiteWeeks: o.web && !o.flagship && o.webSeason === 'weekly' ? o.webWeeks : '',
    WebsiteItem: o.web && !o.flagship ? ADS.WEB[o.web].name : '',
    PreferredStart: o.start, Artwork: o.artwork,
    LogoFile: o.logo ? o.logo.url : (o.logoFailed ? 'NOT SAVED: ' + o.logoFailed : ''),
    Notes: o.notes,
    SeasonWeek: o.week ? o.week.current : '',
    Estimate: o.total, PageEstimate: o.pageEstimate === null ? '' : o.pageEstimate,
    Lines: o.lines.map(function (l) { return l.label + ': ' + adsMoney_(l.amount); }).join('\n'),
    Mailed: '', Decision: '', DecisionNote: ''
  };
}

function adsMarkMailed_(ref, value) {
  if (!hasColumn_(ADS.TAB, 'Mailed')) return;
  const rows = rowsOf_(ADS.TAB);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].OrderID) === ref) {
      const head = tabHeader_(ADS.TAB);
      getTab_(ADS.TAB).getRange(rows[i].__row, head.indexOf('Mailed') + 1).setValue(value);
      delete __tableCache[ADS.TAB];
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* the emails                                                          */
/* ------------------------------------------------------------------ */

function adsPairs_(o) {
  const pairs = [
    ['Reference', o.ref],
    ['Received', o.receivedAt],
    ['Business', o.business],
    ['Contact', o.contact],
    ['Email', o.email],
    ['Phone', o.phone || '—'],
    ['Website', o.website || '—'],
    ['Instagram', o.instagram ? '@' + o.instagram : '—'],
    ['Business category', o.category || '—'],
    ['Category exclusivity', o.exclusivity ? 'Requested' : 'Not requested'],
    ['Preferred start', o.start || '—'],
    ['Artwork link', o.artwork || '—'],
    ['Logo file', o.logo ? o.logo.name + ' — attached, and in Drive: ' + o.logo.url
                : o.logoFailed ? o.logoFailed + ' — the upload did not save; ask them to resend it'
                : 'None attached']
  ];
  if (o.week) {
    const w = o.week;
    pairs.push(['Season week', 'Week ' + w.current +
      (w.remaining ? ' (' + w.label + ', ' + w.remaining + ' week' + (w.remaining === 1 ? '' : 's') + ' left in the term)'
                   : w.seasonOver ? ' (Instagram season over)' : ' (playoff Round ' + w.playoffRound + ')') +
      (o.pageWeek && o.pageWeek !== w.current ? ' — the page was showing Week ' + o.pageWeek : '')]);
  }
  return pairs;
}

function adsSummaryMail_(o, test) {
  const subject = (test ? '[TEST] ' : '') + 'Advertising request ' + o.ref + ' — ' + o.business +
                  ' — ' + adsMoney_(o.total);
  const pairs = adsPairs_(o);
  const mismatch = o.pageEstimate !== null && o.pageEstimate !== o.total;

  const text = [];
  text.push('New advertising request from the UCBAC Stats site.');
  text.push('Reply to this email to accept or decline; it goes straight to ' + o.contact + ' at ' + o.email + '.');
  text.push('');
  pairs.forEach(function (p) { text.push(p[0] + ': ' + p[1]); });
  text.push('');
  text.push('PLACEMENTS');
  o.lines.forEach(function (l) { text.push('  ' + l.label + ' — ' + adsMoney_(l.amount)); });
  text.push('  Estimated total — ' + adsMoney_(o.total));
  if (mismatch) text.push('  (the page showed the advertiser ' + adsMoney_(o.pageEstimate) + '; the rate cards differ — check both)');
  if (o.notes) { text.push(''); text.push('NOTES'); text.push(o.notes); }
  text.push('');
  text.push('Logged on the ' + ADS.TAB + ' tab of the database workbook' + (test ? ' (not for a test)' : '') + '.');

  const h = [];
  h.push('<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;color:#1b1b2f">');
  h.push('<h2 style="margin:0 0 6px;font-size:20px">Advertising request ' + adsEsc_(o.ref) + (test ? ' <span style="color:#b45309">[TEST]</span>' : '') + '</h2>');
  h.push('<p style="margin:0 0 16px;color:#42546a">Reply to this email to accept or decline; the reply goes to ' +
         adsEsc_(o.contact) + ' at ' + adsEsc_(o.email) + '.</p>');
  h.push(adsH2_('Advertiser'));
  h.push(adsRows_(pairs));
  h.push(adsH2_('Placements'));
  h.push(adsRows_(o.lines.map(function (l) { return [l.label, adsMoney_(l.amount)]; })
                   .concat([['Estimated total', adsMoney_(o.total)]])));
  if (mismatch) h.push('<p style="margin:8px 0;color:#b45309">The page showed the advertiser ' + adsMoney_(o.pageEstimate) +
                       '. The two rate cards differ — check both before replying.</p>');
  if (o.notes) { h.push(adsH2_('Notes')); h.push('<p style="white-space:pre-wrap;margin:0">' + adsEsc_(o.notes) + '</p>'); }
  h.push('<p style="margin:22px 0 0;font-size:12px;color:#6b7c8f">Logged on the ' + adsEsc_(ADS.TAB) +
         ' tab of the database workbook' + (test ? ' (not for a test)' : '') + '. Rates from the ' + ADS.SEASON + ' media kit.</p>');
  h.push('</div>');
  return { subject: subject, body: text.join('\n'), htmlBody: h.join('') };
}

function adsCopyMail_(o) {
  const subject = 'We received your UCBAC Stats advertising request (' + o.ref + ')';
  const text = [];
  text.push('Hi ' + o.contact + ',');
  text.push('');
  text.push('Thanks for your interest in advertising with UCBAC Stats. This is a copy of your request, reference ' + o.ref + '.');
  text.push('It is a request, not yet a booking: UCBAC Stats will reply to this address to accept or decline, and to confirm campaign weeks, artwork and the final total.');
  text.push('');
  text.push('PLACEMENTS');
  o.lines.forEach(function (l) { text.push('  ' + l.label + ' — ' + adsMoney_(l.amount)); });
  text.push('  Estimated total — ' + adsMoney_(o.total));
  text.push('');
  text.push('Business: ' + o.business);
  if (o.phone) text.push('Phone: ' + o.phone);
  if (o.website) text.push('Website: ' + o.website);
  if (o.instagram) text.push('Instagram: @' + o.instagram);
  if (o.category) text.push('Category: ' + o.category + (o.exclusivity ? ' (exclusivity requested)' : ''));
  if (o.start) text.push('Preferred start: ' + o.start);
  if (o.artwork) text.push('Artwork: ' + o.artwork);
  if (o.logo) text.push('Logo file: ' + o.logo.name + ' (received)');
  else if (o.logoFailed) text.push('Logo file: ' + o.logoFailed + ' did not save on our side. Please reply to this email with it attached.');
  if (o.notes) { text.push(''); text.push('Your notes: ' + o.notes); }
  text.push('');
  text.push('Questions in the meantime: reply to this email or write to ' + ADS.TO + '.');
  text.push('');
  text.push('UCBAC Stats');

  const h = [];
  h.push('<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;color:#1b1b2f">');
  h.push('<p>Hi ' + adsEsc_(o.contact) + ',</p>');
  h.push('<p>Thanks for your interest in advertising with UCBAC Stats. This is a copy of your request, reference <strong>' + adsEsc_(o.ref) + '</strong>.</p>');
  h.push('<p>It is a request, not yet a booking: UCBAC Stats will reply to this address to accept or decline, and to confirm campaign weeks, artwork and the final total.</p>');
  h.push(adsH2_('Placements'));
  h.push(adsRows_(o.lines.map(function (l) { return [l.label, adsMoney_(l.amount)]; })
                   .concat([['Estimated total', adsMoney_(o.total)]])));
  h.push(adsH2_('Your details'));
  h.push(adsRows_(adsPairs_(o).filter(function (p) { return p[0] !== 'Reference' && p[0] !== 'Received'; })));
  if (o.notes) { h.push(adsH2_('Your notes')); h.push('<p style="white-space:pre-wrap;margin:0">' + adsEsc_(o.notes) + '</p>'); }
  h.push('<p style="margin:22px 0 0">Questions in the meantime: reply to this email or write to ' + adsEsc_(ADS.TO) + '.</p>');
  h.push('<p>UCBAC Stats</p></div>');
  return { subject: subject, body: text.join('\n'), htmlBody: h.join('') };
}

function adsH2_(t) {
  return '<h3 style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7c8f;margin:20px 0 6px">' + adsEsc_(t) + '</h3>';
}
function adsRows_(pairs) {
  const out = ['<table style="border-collapse:collapse;width:100%;font-size:14px">'];
  pairs.forEach(function (p) {
    out.push('<tr><td style="padding:4px 12px 4px 0;color:#42546a;vertical-align:top">' + adsEsc_(p[0]) + '</td>' +
             '<td style="padding:4px 0;font-weight:600;vertical-align:top">' + adsEsc_(p[1]) + '</td></tr>');
  });
  out.push('</table>');
  return out.join('');
}
function adsEsc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function adsTz_() {
  try { return Session.getScriptTimeZone() || 'America/New_York'; } catch (e) { return 'America/New_York'; }
}
function adsStamp_() { return Utilities.formatDate(new Date(), adsTz_(), 'yyyyMMdd'); }
function adsSuffix_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 4; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return s;
}

/**
 * Too many orders from one address, or from everyone, inside an hour. Returns
 * the message to show, or '' to proceed. Counts live in the script cache, so
 * they reset on their own.
 */
function adsThrottle_(email) {
  var cache;
  try { cache = CacheService.getScriptCache(); } catch (e) { return ''; }
  const bump = function (key, cap) {
    const n = parseInt(cache.get(key), 10) || 0;
    if (n >= cap) return true;
    cache.put(key, String(n + 1), 3600);
    return false;
  };
  if (bump('ads:all', ADS.PER_HOUR)) return 'The order desk is busy right now. Please try again in an hour, or email ' + ADS.TO + '.';
  if (bump('ads:' + email, ADS.PER_EMAIL_HOUR)) return 'That address has sent several requests in the last hour. UCBAC Stats has them; please wait for a reply, or email ' + ADS.TO + '.';
  return '';
}

/**
 * Run from the editor: sends a sample order to ADS.TO, marked [TEST], and
 * writes nothing to the tab. Proves the deployment can mail before the page
 * goes live.
 */
function adsSelfTest() {
  const r = adsReceive_({
    kind: 'ad-order', test: true,
    business: 'Sample Hardware Co.', contact: 'Sam Sample', email: ADS.TO,
    phone: '410-555-0100', website: 'https://example.com', instagram: '@samplehardware',
    category: 'Hardware store', exclusivity: true,
    igTerm: 'coreExt', ig: ['slate', 'top10'], web: 'both', webSeason: 'inseason',
    start: 'Week 6', notes: 'Self-test from the Apps Script editor.', estimate: 1800, agree: true
  });
  const msg = r.ok ? 'Test order ' + r.ref + ' priced at ' + adsMoney_(r.total) + ', mailed: ' + r.mailed + '. Check ' + ADS.TO + '.'
                   : 'Refused: ' + r.error;
  Logger.log(msg);
  return msg;
}
