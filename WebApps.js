/**
 * UCBAC Stats - WebApp.gs
 *
 * ONE deployment serves everything:
 *
 *   Deploy > New deployment > Web app
 *   Execute as: Me            Who has access: Anyone
 *
 * The public site needs no sign-in. The portal is the same URL with
 * ?page=portal, and its sign-in is an emailed one-time code (Auth.gs), so the
 * deployment never needs to run as the visitor. That matters twice over: a
 * deployment running as the visitor would ask every player to grant the
 * script's scopes to their own Google account, and would then read the
 * database AS that player, who has no access to the workbook and must never
 * be given any.
 *
 * After pasting new code, publish it: Deploy > Manage deployments > edit >
 * Version: New version. Saving files alone changes nothing anyone can see.
 *
 * Every svc* below is a pure pass-through carrying no logic of its own. They
 * are callable by anyone through google.script.run whatever the page chooses
 * to render, so authorization lives in the api* function and nowhere else;
 * hiding a control is never a control. Portal wrappers take the session token
 * as their FIRST argument and bind it for the request via withSession(); the
 * api* signatures underneath are unchanged.
 */

function doGet(e) {
  const page = String((e && e.parameter && e.parameter.page) || '').toLowerCase();
  if (page === 'policy') return policyPage_(e && e.parameter && e.parameter.doc);

  /* Every page load knows the deployment's real published address; the
     spreadsheet menu does not. Remember it here so a decision link built from
     the menu points somewhere a coach can actually open. */
  try { corrRememberBase_(); } catch (ignore) {}

  // an approve/reject link from a request email; the signature is the
  // authorization, checked inside apiDecideByLink / apiDecideCorrectionByLink
  const decide = String((e && e.parameter && e.parameter.decide) || '').toLowerCase();
  if (decide) {
    const corr = String((e && e.parameter && e.parameter.corr) || '');
    var out;
    try {
      // ?corr= is a stat correction from a coach's inbox; ?acc= an account request
      const r = corr ? apiDecideCorrectionByLink_(corr, decide, e.parameter.sig)
                     : apiDecideByLink_(e.parameter.acc, decide, e.parameter.sig);
      out = (r && r.message) || 'Done.';
      // a correction already settled is not an error, and says so itself
      if (corr && r && r.ok === false) out = (r && r.message) || 'Already decided.';
    } catch (err) {
      out = (err && err.message) || 'This link is not valid.';
    }
    const safe = String(out).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
    const home = String(ScriptApp.getService().getUrl() || '').split('?')[0];
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;' +
      'padding:24px;border:1px solid #ddd;border-radius:12px">' +
      '<h2 style="margin-top:0">UCBAC Stats</h2><p>' + safe + '</p>' +
      (corr ? '<p>The player has been told. Totals catch up within the hour.</p>' +
              '<p><a href="' + home + '?page=portal&view=signup">Create a coach account</a> ' +
              'to enter box scores and see these without waiting for an email.</p>' : '') +
      '<p><a href="' + home + '?page=portal">Open the portal</a></p></div>'
    ).setTitle('UCBAC Stats');
  }

  if (page === 'portal') {
    /* One tab, no frames. Google's sandbox will not render one Apps Script
       app inside another's iframe, so the portal is its own page again, but
       wearing the site's header, whose links navigate this same tab back to
       the public site. Sign-in returns to the site home, greeted by name. */
    const portal = HtmlService.createTemplateFromFile('Portal');
    portal.siteUrl = String(CONFIG.SITE_URL || '');
    portal.execUrl = String(ScriptApp.getService().getUrl() || '');
    /* ?view=signup opens on the Create an account form - the site's "Create
       a player account" button lands here. Anything else opens as usual. */
    portal.view = String((e && e.parameter && e.parameter.view) || '').replace(/[^a-z]/gi, '').toLowerCase();
    return portal
      .evaluate()
      .setTitle('UCBAC Stats - Profile')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const t = HtmlService.createTemplateFromFile('Index');
  t.route   = webAppRoute_(e);
  t.siteUrl = String(CONFIG.SITE_URL || '');
  /* The published /exec address, for "Share profile" links. The page cannot
     read it for itself: inside the sandbox frame its own location is a
     googleusercontent address nobody should ever be handed. */
  t.execUrl = String(ScriptApp.getService().getUrl() || '');
  return t
    .evaluate()
    .setTitle('UCBAC Football Scores, Standings & Stats')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Public Home markup only. Auth/data services still authorize every request.
 * The portal mounts this owned document locally after login instead of trying
 * to navigate the top Google sandbox after an asynchronous code redemption.
 */
function svcHomeDocument() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.route = '#/';
  t.siteUrl = String(CONFIG.SITE_URL || '');
  t.execUrl = String(ScriptApp.getService().getUrl() || '');
  t.fromPortal = true;
  return t.evaluate().getContent();
}

/**
 * Turn ?p=scores into the hash the app routes on.
 *
 * The Google Site at UCBACstats.com links into this deployment, and it cannot
 * link to a section directly: the page it reaches runs inside Apps Script's
 * sandbox frame, whose document has no access to the hash on the address the
 * reader actually typed. A query parameter does survive - it arrives here in
 * e.parameter - so the SERVER reads the requested page and hands the client an
 * opening route to apply for itself.
 *
 * Everything is whitelisted rather than escaped. The result is dropped into a
 * JavaScript string literal, and the only characters that can reach it are
 * letters, digits, hyphen, underscore and the punctuation this function writes
 * itself, so there is nothing to break out with.
 *
 *   ?p=scores                      -> #/scores
 *   ?p=team&id=TEAM-006            -> #/team/TEAM-006
 *   ?p=stats&side=MEASURE          -> #/stats?side=MEASURE
 *   ?p=home&sec=standings          -> #/?sec=standings
 */
const WEBAPP_PAGES = ['scores', 'teams', 'team', 'player', 'coach', 'game',
                      'stats', 'fantasy', 'allconference', 'standings', 'leaders', 'plays'];
/* These are the Stats page's own filter keys (SDEF in Index.html) plus 'sec',
   which picks a section of Home. Spell them exactly as the page reads them -
   'pos', not 'position' - or the link arrives and silently does nothing. The
   free-text search 'q' is deliberately absent: it is the one filter that
   cannot survive this whitelist intact. */
const WEBAPP_PARAMS = ['sec', 'week', 'season', 'range', 'side', 'scope',
                       'pos', 'team', 'county', 'min', 'sort', 'dir'];

function webAppRoute_(e) {
  const p = (e && e.parameter) || {};
  const clean = function (v) { return String(v || '').replace(/[^A-Za-z0-9_-]/g, ''); };

  let page = clean(p.p).toLowerCase();
  if (page === 'all-conference' || page === 'allconf') page = 'allconference';
  if (page === 'home' || WEBAPP_PAGES.indexOf(page) < 0) page = '';

  let hash = '#/' + page;
  const id = clean(p.id);
  if (page && id) hash += '/' + id;

  const qs = [];
  WEBAPP_PARAMS.forEach(function (k) {
    const v = clean(p[k]);
    if (v) qs.push(k + '=' + v);
  });
  if (qs.length) hash += '?' + qs.join('&');

  // '#/' is where the app opens anyway; say nothing rather than route to it.
  return hash === '#/' ? '' : hash;
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ---- public site: no identity involved ---- */
function svcBootstrap()                 { return apiBootstrap_(); }
function svcHome(season)                { return apiHome_(season); }
function svcScores(season, week)        { return apiScores_(season, week); }
function svcWeeks(season)               { return apiWeeks_(season); }
function svcStandings(season)           { return apiStandings_(season); }
function svcLeaders(season, cat)        { return apiLeaders_(season, cat); }
function svcTeam(teamId, season)        { return apiTeam_(teamId, season); }
function svcCoach(teamId)               { return apiCoach_(teamId); }
function svcPlayer(playerId)            { return apiPlayer_(playerId); }
function svcGame(gameId)                { return apiGame_(gameId); }
function svcMatchup(gameId)             { return apiMatchup_(gameId); }
function svcSearch(q)                   { return apiSearch_(q); }
function svcAllConference(season)       { return apiAllConference_(season); }
function svcStatsFilters()              { return apiStatsFilters_(); }
function svcStats(query)                { return apiStats_(query); }
/* Fantasy reads the same filter options as Stats — the same seasons, teams,
   counties and positions — so it adds no filter endpoint of its own. */
function svcFantasyView(query, id, includeFilters) { return apiFantasyView_(query, id, includeFilters); }
function svcFantasy(query)              { return apiFantasy_(query); }
function svcFantasyPlayer(pid, query)   { return apiFantasyPlayer_(pid, query); }
function svcFantasyTeam(tid, query)     { return apiFantasyTeam_(tid, query); }
function svcPlayerAwards(playerId)      { return apiPlayerAwards_(playerId); }
function svcPositionOptions()           { return apiPositionOptions_(); }
function svcTeamCrest(teamId)           { return apiTeamCrest_(teamId); }
function svcAsk(t, question, history) { return withBlitzSession_(t, function (id) { return apiAsk_(question, id, history); }); }
/* A page counting itself. The site repaints rather than reloading, so without
   this the server hears about a visit once and never learns where they went. */
/* Three short renderings of an answer, for the card a reader shares. */
function svcAskCard(t, question, answer) { return withBlitzSession_(t, function (id) { return apiAskCard_(question, answer, id); }); }
/* Which of the three actually got posted, and how. The server cannot know. */
function svcCardUsed(t, cardId, style, how) { return withBlitzSession_(t, function (id) { return apiCardUsed_(cardId, style, how, id); }); }
function svcBlitzAccess(t) { return withSession_(t, function () { return blitzAccess_(accountsWhoami_()); }, {fresh:true, allowIncomplete:true}); }
// Authorization runs before any story read; never add this to a public cache.
function svcDailySummary(t) { return withBlitzSession_(t, function () { return dailySummaryStored_(); }); }
function svcPolicies() { return apiPolicies_(); }
function svcCompleteAccountUpdate(t, p) { return withSession_(t, function () { return apiCompleteAccountUpdate_(p); }, {fresh:true, allowIncomplete:true}); }
function svcHit(page, route, visitorId, ref, width, isNew) {
  return apiHit_(page, route, visitorId, ref, width, isNew);
}

/* ---- Top 10 Plays uploads: open to anyone, no identity involved ---- */
function svcPlaysInfo(weekKey)                     { return apiPlaysInfo_(weekKey); }
function svcPlaysBegin(meta, visitorId)            { return apiPlaysBegin_(meta, visitorId); }
function svcPlaysChunk(ticket, start, total, b64)  { return apiPlaysChunk_(ticket, start, total, b64); }
function svcPlaysDone(ticket)                      { return apiPlaysDone_(ticket); }

/* ---- signing in ---- */
function svcRequestLoginCode(email)     { return apiRequestLoginCode_(email); }
function svcRedeemLoginCode(email, c)   { return apiRedeemLoginCode_(email, c); }
function svcForgotEmail(teamId, name)   { return apiForgotEmail_(teamId, name); }
function svcSignOut(t)                  { return apiSignOut_(t); }
function svcAuthState(t)                { return withSession_(t, function () { return apiAuthState_(); }, {fresh:true, allowIncomplete:true}); }

/* ---- registration ---- */
// Start is identity-free: the emailed code is the verification, and nothing is
// written until it is redeemed. Finalize is for an already-signed-in session.
function svcRegisterStart(payload)      { return apiRegisterStart_(payload); }
function svcRegisterFinalize(t, p)      { return withSession_(t, function () { return apiRegisterFinalize_(p); }, {fresh:true, allowIncomplete:true}); }
function svcClaimCandidates(t, teamId, name)  { return withSession_(t, function () { return apiClaimCandidates_(teamId, name); }); }
function svcPendingAccounts(t)                { return withSession_(t, function () { return apiPendingAccounts_(); }); }
function svcApproveAccount(t, id, ap, note)   { return withSession_(t, function () { return apiApproveAccount_(id, ap, note); }); }

/* ---- portal: player ---- */
function svcMyCoachProfile(t)           { return withSession_(t, function () { return apiMyCoachProfile_(); }); }
function svcSaveCoachProfile(t, patch)  { return withSession_(t, function () { return apiSaveCoachProfile_(patch); }); }
function svcMyProfile(t, pid)           { return withSession_(t, function () { return apiMyProfile_(pid); }); }
function svcSaveProfile(t, patch, pid)  { return withSession_(t, function () { return apiSaveProfile_(patch, pid); }); }
function svcRequestCorrection(t, p)     { return withSession_(t, function () { return apiRequestCorrection_(p); }); }
function svcMyCorrections(t)            { return withSession_(t, function () { return apiMyCorrections_(); }); }
function svcSubmitMyStats(t, gameId, r) { return withSession_(t, function () { return apiSubmitMyStats_(gameId, r); }); }
function svcShareCard(t, pid, png)      { return withSession_(t, function () { return apiShareCard_(pid, png); }); }
function svcShareWhere(t, pid)          { return withSession_(t, function () { return apiShareWhere_(pid); }); }

/* ---- portal: coach ---- */
function svcWhoami(t)                             { return withSession_(t, function () { return whoami_(); }); }
function svcRoster(t, teamId, season)             { return withSession_(t, function () { return apiRoster_(teamId, season); }); }
function svcSaveRoster(t, teamId, season, edits)  { return withSession_(t, function () { return apiSaveRoster_(teamId, season, edits); }); }
function svcAddPlayer(t, teamId, season, player)  { return withSession_(t, function () { return apiAddPlayer_(teamId, season, player); }); }
function svcDeletePlayers(t, teamId, season, ids) { return withSession_(t, function () { return apiDeletePlayers_(teamId, season, ids); }); }
function svcCoverage(t, season)                   { return withSession_(t, function () { return apiCoverage_(season); }); }
/* Which box scores are in. The GRID comes back on svcStatsTracker, beside the
   stat-submission columns it belongs with; these two only write. Admin only,
   checked inside the api* function — hiding a control is never the control. */
function svcSetStatsCoverage(t, marks)            { return withSession_(t, function () { return apiSetStatsCoverage_(marks); }); }
function svcBaselineStatsCoverage(t, season)      { return withSession_(t, function () { return apiBaselineStatsCoverage_(season); }); }
function svcTeamAdmin(t, teamId, season)          { return withSession_(t, function () { return apiTeamAdmin_(teamId, season); }); }
function svcSaveGameScore(t, gameId, hs, as, st, fb) { return withSession_(t, function () { return apiSaveGameScore_(gameId, hs, as, st, fb); }); }
function svcSaveTeamLinks(t, teamId, links)       { return withSession_(t, function () { return apiSaveTeamLinks_(teamId, links); }); }
function svcSetCaptains(t, teamId, season, ids)   { return withSession_(t, function () { return apiSetCaptains_(teamId, season, ids); }); }
function svcSavePlayerStats(t, gameId, teamId, r) { return withSession_(t, function () { return apiSavePlayerStats_(gameId, teamId, r); }); }
function svcReviewCorrection(t, id, dec, note)    { return withSession_(t, function () { return apiReviewCorrection_(id, dec, note); }); }
function svcPendingCorrections(t)                 { return withSession_(t, function () { return apiPendingCorrections_(); }); }
function svcPendingPlayerStats(t)                 { return withSession_(t, function () { return apiPendingPlayerStats_(); }); }
function svcEmailStatsFile(t, n, m, b, g)         { return withSession_(t, function () { return apiEmailStatsFile_(n, m, b, g); }, {fresh:true}); }
function svcReviewPlayerStats(t, gid, pid, dec)   { return withSession_(t, function () { return apiReviewPlayerStats_(gid, pid, dec); }); }
function svcStatsTracker(t, season, teamId)       { return withSession_(t, function () { return apiStatsTracker_(season, teamId); }); }
