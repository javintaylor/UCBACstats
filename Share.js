/* historical record comment removed */

const SHARE = {
  REPO_PROP: 'SHARE_GITHUB_REPO',
  TOKEN_PROP: 'SHARE_GITHUB_TOKEN',
  HOST_PROP: 'SHARE_HOST',
  BRANCH_PROP: 'SHARE_BRANCH',
  API: 'https://api.github.com',
  DIR: 'p',
  FILE_HTML: 'index.html',
  FILE_PNG: 'card.png',
  MAX_BYTES: 900 * 1024,          // a 1200×630 PNG is a fraction of this
  COOLDOWN_SECONDS: 60,           // one publish a minute per player
  WIDTH: 1200, HEIGHT: 630
};

/** The share host, or null when the three properties are not all set. */
function shareHost_() {
  const props_ = PropertiesService.getScriptProperties();
  const repo = s_(props_.getProperty(SHARE.REPO_PROP));
  const token = s_(props_.getProperty(SHARE.TOKEN_PROP));
  const host = s_(props_.getProperty(SHARE.HOST_PROP)).replace(/\/+$/, '');
  if (!repo || !token || !host) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  if (!/^https:\/\/[^\s"'<>?#]+$/i.test(host)) return null;
  return { repo: repo, token: token, host: host,
           branch: s_(props_.getProperty(SHARE.BRANCH_PROP)) || 'main' };
}

/** The player's page on this deployment — the link that works pasted anywhere. */
function shareSiteLink_(playerId) {
  var exec = '';
  try { exec = String(ScriptApp.getService().getUrl() || ''); } catch (e) {}
  return exec ? exec + '?p=player&id=' + encodeURIComponent(playerId) : '';
}

/**
 * Publish a player's card and page, and return where they are.
 *
 *   { link, site, image, hosted }
 *
 * `link` is what the player copies: the share page when a host is set up,
 * else the deployment address. `site` is always the deployment address.
 * `png` is the card as base64 (a data: prefix is tolerated) and may be blank,
 * in which case the page is published without a picture.
 *
 * The player himself, or his coach or an administrator (profileTarget). One
 * publish a minute per player: a second press inside the minute gets the
 * same answer back without another trip to GitHub.
 */
function apiShareCard_(playerId, png) {
  const me = profileTarget_(playerId);
  const pid = String(me.playerId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!pid) throw new Error('This account is not linked to a player.');
  const site = shareSiteLink_(pid);

  const host = shareHost_();
  if (!host) return { link: site, site: site, image: '', hosted: false };

  const cache = CacheService.getScriptCache();
  const key = 'share:' + pid;
  const prev = cache.get(key);
  if (prev) return JSON.parse(prev);

  var bytes = null;
  const b64 = String(png || '').replace(/^data:image\/png;base64,/, '').trim();
  if (b64) {
    try { bytes = Utilities.base64Decode(b64); }
    catch (e) { throw new Error('The card could not be read. Press Share profile again.'); }
    if (bytes.length > SHARE.MAX_BYTES) throw new Error('The card is too large to publish.');
    if (!sharePngBytes_(bytes)) throw new Error('The card must be a PNG picture.');
  }

  const dir = SHARE.DIR + '/' + pid;
  const page = host.host + '/' + dir + '/';
  const image = bytes ? page + SHARE.FILE_PNG + '?v=' + Date.now().toString(36) : '';
  const meta = shareCardMeta_(pid);

  if (bytes) shareGithubPut_(host, dir + '/' + SHARE.FILE_PNG, bytes, 'Share card for ' + pid);
  shareGithubPut_(host, dir + '/' + SHARE.FILE_HTML,
                 Utilities.newBlob(shareHtml_(meta, image, site, page)).getBytes(),
                 'Share page for ' + pid);

  const out = { link: page, site: site, image: image, hosted: true };
  cache.put(key, JSON.stringify(out), SHARE.COOLDOWN_SECONDS);
  return out;
}

/**
 * Where this player's card WILL live, without publishing anything.
 *
 * The card has the address printed on it, and the address is only known to
 * the server — so the browser has to be told before it draws, not after it
 * publishes. Asking apiShareCard would publish a page to find out, and its
 * one-a-minute cooldown would then answer the real publish from the cache
 * and never upload the picture.
 */
function apiShareWhere_(playerId) {
  const me = profileTarget_(playerId);
  const pid = String(me.playerId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!pid) throw new Error('This account is not linked to a player.');
  const site = shareSiteLink_(pid);
  const host = shareHost_();
  return host
    ? { link: host.host + '/' + SHARE.DIR + '/' + pid + '/', site: site, hosted: true }
    : { link: site, site: site, hosted: false };
}

/** The eight-byte PNG signature. Apps Script bytes are signed. */
function sharePngBytes_(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!bytes || bytes.length < 8) return false;
  for (var i = 0; i < 8; i++) if (((bytes[i] + 256) % 256) !== sig[i]) return false;
  return true;
}

/**
 * The words on the page: what a post shows beside the picture.
 *
 *   title        Ziel Cleveland · Elkton Golden Elks #2 · QB
 *   description  Class of 2027 · 6′1″ · 185 lbs · 412 passing yds · 3 passing TD
 */
function shareCardMeta_(pid) {
  const p = apiPlayer_(pid);
  if (!p) throw new Error('No player record found.');
  const seasons = p.seasons || [];
  const cur = seasons.filter(function (x) { return x.seasonId === CONFIG.CURRENT_SEASON; })[0] || seasons[0] || null;
  var team = null;
  try {
    team = (apiBootstrap_().teams || []).filter(function (t) { return cur && t.id === cur.teamId; })[0] || null;
  } catch (e) { team = null; }
  const teamName = team ? (team.name + (team.mascot ? ' ' + team.mascot : '')) : (cur ? teamNameOf_(cur.teamId) : '');

  var title = p.name;
  if (teamName) title += ' · ' + teamName;
  if (cur && cur.jersey) title += ' #' + cur.jersey;
  if (cur && cur.pos) title += ' · ' + cur.pos;

  const bits = [];
  if (p.grad) bits.push('Class of ' + p.grad);
  if (cur && cur.ht !== null && cur.ht !== undefined && cur.ht !== '')
    bits.push(Math.floor(Number(cur.ht) / 12) + '′' + (Number(cur.ht) % 12) + '″');
  if (cur && cur.wt !== null && cur.wt !== undefined && cur.wt !== '') bits.push(cur.wt + ' lbs');
  const ss = (p.seasonStats || []).filter(function (x) { return cur && x.seasonId === cur.seasonId; })[0];
  shareLine_(ss).forEach(function (x) { bits.push(x); });
  return { name: p.name, title: title, description: bits.join(' · ') || 'UCBAC football player profile',
           season: cur ? cur.seasonId : '' };
}

/** The top of his season line, in words: ["412 passing yds", "3 passing TD"]. */
function shareLine_(ss) {
  if (!ss) return [];
  const n = function (v) { return Number(v || 0); };
  const picks = [
    [n(ss.passYds), 1, 'passing yds'], [n(ss.passTD), 25, 'passing TD'],
    [n(ss.rushYds), 1, 'rushing yds'], [n(ss.rushTD), 25, 'rushing TD'],
    [n(ss.recYds), 1, 'receiving yds'], [n(ss.rec), 8, 'receptions'], [n(ss.recTD), 25, 'receiving TD'],
    [n(ss.solo) + n(ss.asst), 4, 'tackles'], [n(ss.tfl), 10, 'TFL'], [n(ss.sacks), 30, 'sacks'], [n(ss.int), 45, 'interceptions']
  ].map(function (x, i) { return { v: x[0], w: x[0] * x[1], label: x[2], i: i }; })
   .filter(function (x) { return x.v > 0; })
   .sort(function (a, b) { return b.w - a.w; }).slice(0, 2)
   .sort(function (a, b) { return a.i - b.i; });
  return picks.map(function (x) { return x.v + ' ' + x.label; });
}

function shareEsc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * The share page: Open Graph and Twitter tags for the crawlers, and an
 * immediate send-on to the real page for anyone who opens it. Crawlers do
 * not follow the refresh; people do.
 */
function shareHtml_(meta, image, site, page) {
  const t = shareEsc_(meta.title), d = shareEsc_(meta.description);
  const img = image ? '<meta property="og:image" content="' + shareEsc_(image) + '">' +
                      '<meta property="og:image:width" content="' + SHARE.WIDTH + '">' +
                      '<meta property="og:image:height" content="' + SHARE.HEIGHT + '">' +
                      '<meta property="og:image:alt" content="' + t + '">' +
                      '<meta name="twitter:image" content="' + shareEsc_(image) + '">' : '';
  const go = site ? '<meta http-equiv="refresh" content="0;url=' + shareEsc_(site) + '">' +
                    '<link rel="canonical" href="' + shareEsc_(site) + '">' +
                    '<script>location.replace(' + JSON.stringify(site).replace(/</g, '\\u003c') + ');</script>' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>' + t + ' · UCBAC Stats</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    /* No "noindex" here. It was a tidiness measure — a redirect stub has no
       business in a search index — but X and Facebook read these pages with
       crawlers that also honour robots directives, and a preview that does
       not appear is a worse outcome than a stub that does. The canonical
       below points at the real page, which is the proper way to say the same
       thing to a search engine. */
    '<meta property="og:type" content="profile">' +
    '<meta property="og:site_name" content="UCBAC Stats">' +
    '<meta property="og:title" content="' + t + '">' +
    '<meta property="og:description" content="' + d + '">' +
    '<meta property="og:url" content="' + shareEsc_(page) + '">' +
    img +
    '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">' +
    '<meta name="twitter:title" content="' + t + '">' +
    '<meta name="twitter:description" content="' + d + '">' +
    go +
    '</head><body style="font-family:system-ui,sans-serif;margin:40px auto;max-width:640px;padding:0 16px;text-align:center;color:#0B0D1A">' +
    (image ? '<img src="' + shareEsc_(SHARE.FILE_PNG) + '" alt="' + t + '" style="max-width:100%;border-radius:12px">' : '') +
    '<p><a href="' + shareEsc_(site || '#') + '">Open ' + shareEsc_(meta.name) + ' on UCBAC Stats</a></p>' +
    '</body></html>';
}

/**
 * Create or replace one file in the repository through the Contents API.
 * A replace needs the file's current sha, so the write is a read first.
 */
function shareGithubPut_(host, path, bytes, message) {
  const url = SHARE.API + '/repos/' + host.repo + '/contents/' + path;
  const headers = { Authorization: 'Bearer ' + host.token, Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28' };
  const got = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(host.branch),
                                { headers: headers, muteHttpExceptions: true });
  var sha = '';
  const gc = got.getResponseCode();
  if (gc === 200) { try { sha = String(JSON.parse(got.getContentText()).sha || ''); } catch (e) { sha = ''; } }
  else if (gc !== 404)
    throw new Error('The share host refused (' + gc + '). An administrator can run Check share pages.');

  const body = { message: message, content: Utilities.base64Encode(bytes), branch: host.branch };
  if (sha) body.sha = sha;
  const put = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json', headers: headers,
                                       payload: JSON.stringify(body), muteHttpExceptions: true });
  const pc = put.getResponseCode();
  if (pc !== 200 && pc !== 201)
    throw new Error('The share page could not be published (' + pc + '). An administrator can run Check share pages.');
  return true;
}

/**
 * What the sheet menu reports: which link the button hands out, and whether
 * the token reaches the repository. Never prints the token.
 */
function shareSetupReport_() {
  const props_ = PropertiesService.getScriptProperties();
  const repo = s_(props_.getProperty(SHARE.REPO_PROP)), hostUrl = s_(props_.getProperty(SHARE.HOST_PROP));
  const hasToken = !!s_(props_.getProperty(SHARE.TOKEN_PROP));
  const out = [];
  const host = shareHost_();
  if (!host) {
    out.push('Share pages are OFF. Share profile hands out the deployment\'s own link, and a pasted ' +
             'link previews as a Google page; the card is the player\'s to attach.');
    out.push('To turn them on, set three Script Properties (Project Settings > Script Properties):');
    out.push('  ' + SHARE.REPO_PROP + ' = owner/repo of a GitHub repository with Pages enabled' + (repo ? '  (set: ' + repo + ')' : '  (not set)'));
    out.push('  ' + SHARE.TOKEN_PROP + ' = a fine-grained token, Contents read and write, that repository only' + (hasToken ? '  (set)' : '  (not set)'));
    out.push('  ' + SHARE.HOST_PROP + ' = where Pages serves it, e.g. https://javintaylor.github.io/ucbacstats-share' + (hostUrl ? '  (set: ' + hostUrl + ')' : '  (not set)'));
    return out.join('\n');
  }
  out.push('Share pages are ON: ' + host.host + '/' + SHARE.DIR + '/<PlayerID>/ on ' + host.repo + ' (' + host.branch + ').');
  /* Which pages exist, so a preview that does not appear can be told apart
     from a page that was never published. */
  const made = shareLivePages_(host);
  if (made.length) {
    out.push('Cards published so far: ' + made.length);
    made.slice(0, 5).forEach(function (u) { out.push('  ' + u); });
    out.push('Paste one of those into X. If the card does not appear, the address');
    out.push('above is not what GitHub Pages actually serves — open it in a browser.');
  } else {
    out.push('No cards published yet. A player presses Share profile > Make my card.');
  }
  try {
    const r = UrlFetchApp.fetch(SHARE.API + '/repos/' + host.repo,
      { headers: { Authorization: 'Bearer ' + host.token, Accept: 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28' }, muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code === 200) out.push('The token reaches the repository.');
    else if (code === 401) out.push('The token is refused (401): it is wrong or expired.');
    else if (code === 404) out.push('The repository is not found with this token (404): check the owner/repo and the token\'s repository access.');
    else out.push('GitHub answered ' + code + '.');
  } catch (e) {
    out.push('GitHub could not be reached: ' + (e && e.message));
  }
  out.push('A player presses Share profile on My Profile; the page and card appear within a minute or two of the first press.');
  return out.join('\n');
}

/** The share pages that actually exist in the repository, as URLs. */
function shareLivePages_(host) {
  try {
    const r = UrlFetchApp.fetch(SHARE.API + '/repos/' + host.repo + '/contents/' + SHARE.DIR +
                                '?ref=' + encodeURIComponent(host.branch),
      { headers: { Authorization: 'Bearer ' + host.token, Accept: 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28' }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return [];
    return (JSON.parse(r.getContentText()) || [])
      .filter(function (x) { return x && x.type === 'dir'; })
      .map(function (x) { return host.host + '/' + SHARE.DIR + '/' + x.name + '/'; });
  } catch (e) { return []; }
}

function menuShareCheck() {
  const msg = shareSetupReport_();
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Share pages', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}
