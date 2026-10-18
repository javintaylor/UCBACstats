/** Field-scoped official review. AuditLog is the durable claim/coverage ledger.
 * No messages, notifications, row deletion or second stat append. Call only
 * while holding the same script lock as teamAdminWriteStats_. */
function taReviewCanonical_(id) {
  return typeof m15Canonical_ === 'function' ? m15Canonical_(s_(id)) : s_(id);
}
function taReviewKey_(scope) {
  return [scope.seasonId, scope.teamId, scope.gameId,
          taReviewCanonical_(scope.playerId), scope.category].join('|');
}
function taReviewScope_(row) {
  return {seasonId:s_(row.SeasonID),teamId:s_(row.TeamID),gameId:s_(row.GameID),
          playerId:taReviewCanonical_(row.PlayerID),category:s_(row.category)};
}
function taReviewLedger_() {
  const out = {};
  if (!hasTab_(CONFIG.TABS.AUDIT)) return out;
  rowsOf_(CONFIG.TABS.AUDIT).forEach(function (r) {
    if (s_(r.Action) !== 'STATS_RECONCILE') return;
    // Header names in older imports differ. Never infer coverage from a
    // free-text STATS_UPDATE entry or a number merely present in production.
    try {
      const scope = JSON.parse(r.Notes);
      const value = JSON.parse(r.NewValue);
      if (scope.reviewSchema !== 1 || !value.covered || !scope.gameId ||
          !scope.seasonId || !scope.teamId || !scope.playerId || !scope.category) return;
      out[taReviewKey_(scope)] = value.covered;
    } catch (ignored) {}
  });
  return out;
}
function taReviewRemaining_(row, covered) {
  const out = {};
  teamAdminStatFields_(s_(row.category)).forEach(function (f) {
    if (row[f] === '' || row[f] === null || row[f] === undefined) return;
    if (!Object.prototype.hasOwnProperty.call(covered || {}, f) ||
        !teamAdminSame_(row[f], covered[f])) out[f] = row[f];
  });
  return out;
}
/** Value-matched per-field source ledger. Pre-v1 source records are verified
 * coach/admin coverage; unknown verified imports remain protected. */
function taReviewSources_() {
  const out = {};
  if (!hasTab_(CONFIG.TABS.AUDIT)) return out;
  rowsOf_(CONFIG.TABS.AUDIT).forEach(function (r) {
    if (s_(r.Action) !== 'STATS_RECONCILE') return;
    try {
      const scope = JSON.parse(r.Notes), value = JSON.parse(r.NewValue);
      if (scope.reviewSchema !== 1 || !value.covered) return;
      const sources = {};
      Object.keys(value.covered).forEach(function (f) {
        sources[f] = value.sources && value.sources[f] || 'COACH_ENTRY';
      });
      out[taReviewKey_(scope)] = sources;
    } catch (ignored) {}
  });
  return out;
}
function taReviewPlan_(me, original, updated, cells, ledger, incomingSource) {
  incomingSource = incomingSource || 'COACH_ENTRY';
  const scope = taReviewScope_(updated), key = taReviewKey_(scope);
  const prior = ledger[key] || {}, covered = Object.assign({},prior);
  const priorSources = taReviewSources_()[key] || {}, sources = Object.assign({},priorSources);
  // A pre-existing verified row has no unverified populated fields, even if
  // it predates the field ledger. Never turn them into player claims.
  if (s_(original.SourceType) && !provisionalSource_(original.SourceType)) {
    teamAdminStatFields_(scope.category).forEach(function (f) {
      if (original[f] !== '' && original[f] !== null && original[f] !== undefined &&
          !Object.prototype.hasOwnProperty.call(covered,f)) {
        covered[f] = original[f]; sources[f] = 'VERIFIED_UCBAC';
      }
    });
  }
  Object.keys(cells).forEach(function (f) {
    const preserveHigher = incomingSource === 'MAXPREPS' &&
      Object.prototype.hasOwnProperty.call(covered,f) && sources[f] !== 'MAXPREPS' &&
      teamAdminSame_(covered[f],cells[f]);
    covered[f] = cells[f];
    if (!preserveHigher) sources[f] = incomingSource;
  });
  const remaining = taReviewRemaining_(updated,covered);
  const changed = JSON.stringify(covered) !== JSON.stringify(prior) ||
    JSON.stringify(sources) !== JSON.stringify(priorSources);
  ledger[key] = covered;
  scope.reviewSchema = 1;
  return {sourceType:Object.keys(remaining).length ? 'PLAYER_ENTRY' :
      (incomingSource === 'MAXPREPS' ? 'IMPORT' : 'COACH_ENTRY'),
    remaining:remaining,covered:covered,sources:sources,
    audit:changed ? auditRow_(me,'STATS_RECONCILE','PlayerGameStat',
      scope.gameId + ':' + scope.playerId,scope.category,JSON.stringify(original),
      JSON.stringify({covered:covered,remaining:remaining,sources:sources}),JSON.stringify(scope)) : null};
}
function taReviewCorrectionPlan_(me, seasonId, teamId, gameId, accepted) {
  if (!hasTab_(CONFIG.TABS.CORRECTIONS)) return {updates:[],audit:[]};
  delete __tableCache[CONFIG.TABS.CORRECTIONS];
  const updates = [], audit = [];
  rowsOf_(CONFIG.TABS.CORRECTIONS).forEach(function (r) {
    if (profileCorrectionStatus_(r) !== 'PENDING' || s_(r.SeasonID) !== seasonId ||
        s_(r.TeamID) !== teamId || s_(r.GameID) !== gameId) return;
    const pid = taReviewCanonical_(r.PlayerID), field = s_(r.Field);
    const match = accepted[pid + '|' + teamAdminCategoryOf_(field)];
    if (!match || !Object.prototype.hasOwnProperty.call(match,field)) return;
    const status = teamAdminSame_(r.NewValue,match[field]) ? 'APPROVED' : 'SUPERSEDED';
    updates.push({row:r.__row,field:'Status',value:status},
      {row:r.__row,field:'ReviewedBy',value:me.email},
      {row:r.__row,field:'ReviewedAt',value:new Date()});
    audit.push(auditRow_(me,'CORRECTION_' + (status === 'APPROVED' ? 'RECONCILED' : 'SUPERSEDED'),
      'StatCorrection',s_(r.CorrectionID),field,r.NewValue,match[field],
      seasonId + ' ' + teamId + ' ' + gameId + ' — verified official save; original request preserved'));
  });
  return {updates:updates,audit:audit};
}
function taReviewCorrections_(me, seasonId, teamId, gameId, accepted) {
  const plan = taReviewCorrectionPlan_(me,seasonId,teamId,gameId,accepted);
  const updates = plan.updates, audit = plan.audit;
  // Audit first: a failed subsequent status write is safely retryable and
  // cannot manufacture a new stat or lose the request's original proposal.
  if (audit.length) appendRows_(CONFIG.TABS.AUDIT,audit);
  if (updates.length) updateCells_(CONFIG.TABS.CORRECTIONS,updates);
  return audit.length;
}
