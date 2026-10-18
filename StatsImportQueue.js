/** Bounded connector inbox. No endpoint, credentials, legacy StatsImport scan,
 * or new trigger. The existing sweepRebuild invokes the private worker.
 * Queue and receipt tabs are private parts of the existing database workbook.
 */
const STATQUEUE = {
  queue:'StatsImportQueue', receipts:'StatsImportReceipts', owner:'contact@example.invalid',
  enabled:'UCBAC_STAT_QUEUE_ENABLED_V1', maxRows:2000, maxLines:40, maxAttempts:3,
  input:['BatchID','State','SeasonID','TeamID','GameID','SourceKind','SubmittedBy',
    'AuthorizationRef','SourceEvidenceJSON','LinesJSON','PayloadSHA256','SubmittedAt'],
  output:['StartedAt','CompletedAt','Attempts','ReceiptID','ResultJSON','Error','WorkerRunID','FrozenSHA256'],
  receipt:['BatchID','PayloadSHA256','State','FrozenPayloadJSON','BeforeJSON','AfterJSON',
    'ReceiptJSON','StartedAt','CompletedAt','Error','WorkerRunID','RebuildState']
};
var __statQueueContext = null;
function sqAssert_(condition, code) { if (!condition) throw new Error('QUEUE_' + code); }
function sqActor_() {
  // Never turn an execute-as-owner web visitor or a portal token into a queue
  // operator. Only the existing Google owner identity may run setup/worker.
  const active = s_(Session.getActiveUser().getEmail()).toLowerCase();
  const effective = s_(Session.getEffectiveUser().getEmail()).toLowerCase();
  const me = accountsWhoami_();
  sqAssert_(!__AUTH_BOUND && active === STATQUEUE.owner && effective === active &&
    s_(me.email).toLowerCase() === active && me.role === 'ADMIN','OWNER_REQUIRED');
  return {email:active,role:'ADMIN',teamId:''};
}
function sqHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8)
    .map(function (b) { return (b & 255).toString(16).padStart(2,'0'); }).join('');
}
function sqJSON_(text, code) {
  sqAssert_(typeof text === 'string' && text.length <= 40000,code);
  try { return JSON.parse(text); } catch (_) { throw new Error('QUEUE_' + code); }
}
function sqKeys_(obj, keys, code) {
  sqAssert_(obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).sort().join('|') === keys.slice().sort().join('|'),code);
}
function sqISO_(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && isFinite(Date.parse(v)); }
function sqInput_(row) {
  const p = {};
  STATQUEUE.input.forEach(function (h) { if (h !== 'State' && h !== 'PayloadSHA256') p[h] = row[h]; });
  return p;
}
/** Public protocol: SHA256 UTF-8 JSON.stringify of these ten string values.
 * State, digest and all worker-owned outputs are excluded from the digest. */
function sqPayloadText_(p) {
  return JSON.stringify(['BatchID','SeasonID','TeamID','GameID','SourceKind','SubmittedBy',
    'AuthorizationRef','SourceEvidenceJSON','LinesJSON','SubmittedAt'].map(function (h) { return p[h]; }));
}
function sqTable_(name, headers) {
  const sh = getTab_(name), values = sh.getDataRange().getValues();
  sqAssert_(values.length <= STATQUEUE.maxRows,'TABLE_BOUND');
  const head = values[0].map(String);
  sqAssert_(JSON.stringify(head) === JSON.stringify(headers),'HEADERS');
  const formulas = sh.getDataRange().getFormulas();
  return {sh:sh,head:head,rows:values.slice(1).map(function (v,i) {
    const r = {__row:i+2,__formulas:formulas[i+1] || []};
    head.forEach(function (h,j) { r[h] = v[j] === undefined ? '' : v[j]; });
    return r;
  })};
}
function sqEnvelope_(row) {
  const p = sqInput_(row);
  Object.keys(p).forEach(function (h) { sqAssert_(typeof p[h] === 'string','LITERAL_STRINGS'); });
  sqAssert_(!(row.__formulas || []).slice(0,12).some(Boolean),'FORMULA_INPUT');
  sqAssert_(/^SQ-[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(p.BatchID),'BATCH_ID');
  sqAssert_(/^SEA-\d{4}$/.test(p.SeasonID) && /^TEAM-\d{3}$/.test(p.TeamID) &&
    /^GAME-\d{4}-\d{4}$/.test(p.GameID),'SCOPE_IDS');
  sqAssert_(p.SubmittedBy === STATQUEUE.owner && p.AuthorizationRef.trim().length >= 8 &&
    p.AuthorizationRef.length <= 1000 && sqISO_(p.SubmittedAt),'AUTHORIZATION');
  sqAssert_(['COACH_VERIFIED','MAXPREPS','VERIFY_ONLY'].indexOf(p.SourceKind) >= 0,'SOURCE_KIND');
  const text = sqPayloadText_(p);
  sqAssert_(text.length <= 45000 && /^[a-f0-9]{64}$/.test(row.PayloadSHA256) &&
    sqHash_(text) === row.PayloadSHA256,'DIGEST');
  return {payload:p,text:text,hash:row.PayloadSHA256};
}
/** One-game cumulative difference only. Both source snapshots and every prior
 * game's unchanged source values are frozen in the ordinary hashed payload.
 * A season total alone cannot distinguish a new game from an old correction. */
function sqSeasonDelta_(p, pid, category, field, proof, evidence, stats, ledger) {
  const additive = ['PassAtt','PassComp','PassYds','PassTD','PassInt','RushAtt','RushYds','RushTD','RushFum',
    'Rec','RecYds','RecTD','RecFum','Pancakes','TackleSolo','TackleAssist','TFL','Sacks','Int','FF','FR',
    'PassDef','DefTD','FGM','FGA','XPM','XPA','Punts','PuntYds','KR','KRYds','PR','PRYds',
    'Blocks','BlockedPunts','TwoPointConversions'];
  sqAssert_(additive.indexOf(field) >= 0 && proof.value !== null,'SEASON_DELTA_ADDITIVE');
  const d = proof.delta;
  sqKeys_(d,['seasonId','teamId','playerId','category','field','baseline','current','priorGames'],'SEASON_DELTA_SHAPE');
  sqAssert_(d.seasonId === p.SeasonID && d.teamId === p.TeamID && d.playerId === pid &&
    d.category === category && d.field === field,'SEASON_DELTA_SCOPE');
  function day(v) {
    const result = v instanceof Date ? Utilities.formatDate(v,db_().getSpreadsheetTimeZone(),'yyyy-MM-dd') :
      (typeof v === 'string' ? (v.match(/^\d{4}-\d{2}-\d{2}(?:$|T| )/) || [''])[0].slice(0,10) : '');
    sqAssert_(/^\d{4}-\d{2}-\d{2}$/.test(result) && isFinite(Date.parse(result + 'T00:00:00Z')) &&
      new Date(result + 'T00:00:00Z').toISOString().slice(0,10) === result,'SEASON_DELTA_DATE');
    return result;
  }
  function numeric(v) {
    const half = ['Sacks','TFL'].indexOf(field) >= 0;
    sqAssert_(typeof v === 'number' && isFinite(v) && Math.abs(v) <= 100000 &&
      Number.isInteger(v * (half ? 2 : 1)) &&
      (TEAMADMIN.SIGNED_FIELDS.indexOf(field) >= 0 || v >= 0),'SEASON_DELTA_NUMBER');
    return v;
  }
  function reference(index, locator) {
    sqAssert_(Number.isInteger(index) && index >= 0 && index < evidence.references.length &&
      typeof locator === 'string' && locator.length > 0 && locator.length <= 500,'SEASON_DELTA_REFERENCE');
  }
  function snapshot(s) {
    sqKeys_(s,['reference','locator','cutoffGameId','cutoffDate','observedAt','total','gameIds'],'SEASON_DELTA_SNAPSHOT');
    reference(s.reference,s.locator); day(s.cutoffDate); numeric(s.total);
    sqAssert_(sqISO_(s.observedAt) && Date.parse(s.observedAt) <= Date.parse(evidence.references[s.reference].retrievedAt) &&
      s.observedAt.slice(0,10) >= s.cutoffDate && Array.isArray(s.gameIds) && s.gameIds.length <= 40 &&
      s.gameIds.every(function (id) { return typeof id === 'string' && /^GAME-\d{4}-\d{4}$/.test(id); }) &&
      new Set(s.gameIds).size === s.gameIds.length,'SEASON_DELTA_SNAPSHOT');
  }
  snapshot(d.baseline); snapshot(d.current);
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) {
    return s_(g.SeasonID) === p.SeasonID && [s_(g.HomeTeamID),s_(g.AwayTeamID)].indexOf(p.TeamID) >= 0 &&
      s_(g.Status).toUpperCase() !== 'CANCELLED';
  }).map(function (g) { return {id:s_(g.GameID),date:day(g.GameDate),status:s_(g.Status).toUpperCase()}; });
  sqAssert_(new Set(games.map(function (g) { return g.id; })).size === games.length,'SEASON_DELTA_GAME_DUPLICATE');
  const target = games.filter(function (g) { return g.id === p.GameID; });
  sqAssert_(target.length === 1 && target[0].status === 'FINAL','SEASON_DELTA_FINAL');
  const targetDay = target[0].date;
  sqAssert_(games.filter(function (g) { return g.date === targetDay; }).length === 1,'SEASON_DELTA_SAME_DAY');
  const prior = games.filter(function (g) { return g.date < targetDay; }).sort(function (a,b) { return a.date.localeCompare(b.date) || a.id.localeCompare(b.id); });
  sqAssert_(prior.length <= 39 && prior.every(function (g) { return g.status === 'FINAL'; }),'SEASON_DELTA_PRIOR_SCHEDULE');
  const ids = prior.map(function (g) { return g.id; });
  sqAssert_(JSON.stringify(d.baseline.gameIds) === JSON.stringify(ids) &&
    JSON.stringify(d.current.gameIds) === JSON.stringify(ids.concat([p.GameID])) &&
    d.current.cutoffGameId === p.GameID && d.current.cutoffDate === targetDay &&
    d.baseline.cutoffGameId === (prior.length ? prior[prior.length-1].id : '') &&
    (prior.length ? d.baseline.cutoffDate === prior[prior.length-1].date : d.baseline.cutoffDate < targetDay),
    'SEASON_DELTA_ONE_GAME');
  sqAssert_(d.baseline.reference !== d.current.reference &&
    d.baseline.observedAt.slice(0,10) < targetDay &&
    Date.parse(d.baseline.observedAt) < Date.parse(d.current.observedAt) &&
    proof.reference === d.current.reference && proof.locator === d.current.locator,'SEASON_DELTA_CUTOFF');
  // A current snapshot captured after another dated game cannot claim its
  // cumulative total stops at this earlier game without extra attribution.
  const next = games.filter(function (g) { return g.date > targetDay; }).sort(function (a,b) { return a.date.localeCompare(b.date); })[0];
  sqAssert_(!next || d.current.observedAt.slice(0,10) < next.date,'SEASON_DELTA_LATER_GAME');
  sqAssert_(Array.isArray(d.priorGames) && d.priorGames.length === prior.length,'SEASON_DELTA_RECONCILIATION');
  let sum = 0;
  d.priorGames.forEach(function (entry,i) {
    sqKeys_(entry,['gameId','gameDate','value','sourceType','baselineReference','baselineLocator',
      'baselineValue','currentReference','currentLocator','currentValue'],'SEASON_DELTA_PRIOR_SHAPE');
    sqAssert_(entry.gameId === prior[i].id && entry.gameDate === prior[i].date,'SEASON_DELTA_PRIOR_SCOPE');
    reference(entry.baselineReference,entry.baselineLocator); reference(entry.currentReference,entry.currentLocator);
    sqAssert_(entry.baselineReference === d.baseline.reference && entry.currentReference === d.current.reference &&
      numeric(entry.baselineValue) === numeric(entry.currentValue) && numeric(entry.value) === entry.baselineValue,
      'SEASON_DELTA_PRIOR_REVISION');
    const rows = stats.filter(function (r) {
      return s_(r.SeasonID) === p.SeasonID && s_(r.TeamID) === p.TeamID && s_(r.GameID) === entry.gameId &&
        taReviewCanonical_(r.PlayerID) === pid && s_(r.category) === category && s_(r.grain) === 'GAME';
    });
    sqAssert_(rows.length === 1 && typeof entry.sourceType === 'string' && s_(rows[0].SourceType) === entry.sourceType &&
      rows[0][field] !== '' && rows[0][field] !== null && rows[0][field] !== undefined &&
      teamAdminSame_(rows[0][field],entry.value),'SEASON_DELTA_BASELINE');
    const covered = ledger[taReviewKey_(taReviewScope_(rows[0]))] || {};
    sqAssert_(!provisionalSource_(rows[0].SourceType) ||
      (Object.prototype.hasOwnProperty.call(covered,field) && teamAdminSame_(covered[field],entry.value)),
      'SEASON_DELTA_UNVERIFIED_BASELINE');
    sqAssert_(!hasTab_(CONFIG.TABS.CORRECTIONS) || !rowsOf_(CONFIG.TABS.CORRECTIONS).some(function (r) {
      return profileCorrectionStatus_(r) === 'PENDING' && s_(r.SeasonID) === p.SeasonID &&
        s_(r.TeamID) === p.TeamID && s_(r.GameID) === entry.gameId &&
        taReviewCanonical_(r.PlayerID) === pid && s_(r.Field) === field;
    }),'SEASON_DELTA_PENDING_PRIOR_CORRECTION');
    sum += entry.value;
  });
  sqAssert_(sum === d.baseline.total && d.current.total - d.baseline.total === proof.value,'SEASON_DELTA_ARITHMETIC');
}
function sqPreflight_(p) {
  const games = rowsOf_(CONFIG.TABS.GAMES).filter(function (g) { return s_(g.GameID) === p.GameID; });
  sqAssert_(games.length === 1 && s_(games[0].SeasonID) === p.SeasonID &&
    [s_(games[0].HomeTeamID),s_(games[0].AwayTeamID)].indexOf(p.TeamID) >= 0,'GAME_SCOPE');
  const evidence = sqJSON_(p.SourceEvidenceJSON,'EVIDENCE_JSON');
  sqKeys_(evidence,['schemaVersion','verifiedBy','verifiedAt','references','notes'],'EVIDENCE_SHAPE');
  sqAssert_(evidence.schemaVersion === 1 && evidence.verifiedBy === STATQUEUE.owner &&
    sqISO_(evidence.verifiedAt) && Array.isArray(evidence.references) && evidence.references.length >= 1 &&
    evidence.references.length <= 20 && typeof evidence.notes === 'string' && evidence.notes.trim().length >= 8,'EVIDENCE');
  evidence.references.forEach(function (ref) {
    sqKeys_(ref,['url','locator','retrievedAt'],'REFERENCE_SHAPE');
    sqAssert_(typeof ref.url === 'string' && /^https:\/\/[^\s]{1,1500}$/.test(ref.url) &&
      typeof ref.locator === 'string' && ref.locator.length > 0 && ref.locator.length <= 500 &&
      sqISO_(ref.retrievedAt),'REFERENCE');
    if (p.SourceKind === 'MAXPREPS') sqAssert_(/^https:\/\/(?:www\.)?maxpreps\.com\//i.test(ref.url),'MAXPREPS_REFERENCE');
  });
  const lines = sqJSON_(p.LinesJSON,'LINES_JSON');
  sqAssert_(Array.isArray(lines) && lines.length <= STATQUEUE.maxLines,'LINE_BOUND');
  if (p.SourceKind === 'VERIFY_ONLY') {
    sqAssert_(lines.length === 0,'VERIFY_NO_STATS');
    return {rows:[],before:[],after:[],canonical:[]};
  }
  sqAssert_(lines.length > 0,'EMPTY_IMPORT');
  const stats = rowsOf_(CONFIG.TABS.PLAYER_STATS), head = tabHeader_(CONFIG.TABS.PLAYER_STATS);
  const roster = rowsOf_(CONFIG.TABS.PLAYER_SEASONS).filter(function (r) {
    return s_(r.SeasonID) === p.SeasonID && s_(r.TeamID) === p.TeamID;
  });
  const ledger = taReviewLedger_(), sourceLedger = taReviewSources_();
  const seen = {}, result = {rows:[],before:[],after:[],canonical:[]};
  lines.forEach(function (line) {
    sqKeys_(line,['playerId','category','fields','expected','coverage'],'LINE_SHAPE');
    sqAssert_(typeof line.playerId === 'string' && /^PLY-\d{6}$/.test(line.playerId),'PLAYER_ID');
    const pid = taReviewCanonical_(line.playerId), category = line.category;
    sqAssert_(typeof category === 'string' && Object.prototype.hasOwnProperty.call(TEAMADMIN.CATEGORIES,category),'CATEGORY');
    const fields = teamAdminStatFields_(category).filter(function (f) { return head.indexOf(f) >= 0; });
    const key = pid + '|' + category;
    sqAssert_(!seen[key],'DUPLICATE_INPUT'); seen[key] = true;
    sqAssert_(roster.filter(function (r) { return taReviewCanonical_(r.PlayerID) === pid; }).length === 1,'ROSTER');
    sqAssert_(line.fields && typeof line.fields === 'object' && !Array.isArray(line.fields) &&
      Object.keys(line.fields).length > 0,'FIELDS');
    sqKeys_(line.coverage,Object.keys(line.fields),'COVERAGE_FIELDS');
    const row = {playerId:pid,category:category};
    Object.keys(line.fields).forEach(function (f) {
      sqAssert_(fields.indexOf(f) >= 0,'UNSUPPORTED_FIELD');
      const value = line.fields[f];
      sqAssert_(value === null || (typeof value === 'number' && isFinite(value)),'NUMBER_TYPE');
      const validated = teamAdminStat_(f,value);
      const proof = line.coverage[f];
      sqKeys_(proof,proof && proof.method === 'SEASON_DELTA' ? ['reference','locator','value','method','delta'] :
        ['reference','locator','value','method'],'COVERAGE_SHAPE');
      sqAssert_(Number.isInteger(proof.reference) && proof.reference >= 0 && proof.reference < evidence.references.length &&
        typeof proof.locator === 'string' && proof.locator.length > 0 && proof.locator.length <= 500 &&
        proof.value === value && ['EXPLICIT','TOTAL_MINUS_ASSIST','UNSPECIFIED_TACKLE_SOLO','EXPLICIT_CLEAR','SEASON_DELTA'].indexOf(proof.method) >= 0,'COVERAGE');
      sqAssert_(value !== null || proof.method === 'EXPLICIT_CLEAR','CLEAR_EVIDENCE');
      sqAssert_(proof.method !== 'TOTAL_MINUS_ASSIST' || (f === 'TackleSolo' && p.SourceKind === 'COACH_VERIFIED'),'DERIVATION');
      sqAssert_(proof.method !== 'UNSPECIFIED_TACKLE_SOLO' || f === 'TackleSolo','TACKLE_KIND');
      if (proof.method === 'SEASON_DELTA') sqSeasonDelta_(p,pid,category,f,proof,evidence,stats,ledger);
      row[f] = validated;
    });
    const hits = stats.filter(function (r) {
      return s_(r.GameID) === p.GameID && s_(r.SeasonID) === p.SeasonID && s_(r.TeamID) === p.TeamID &&
        s_(r.grain) === 'GAME' && s_(r.category) === category && taReviewCanonical_(r.PlayerID) === pid;
    });
    sqAssert_(hits.length <= 1,'DUPLICATE_PRODUCTION');
    const exists = hits.length === 1;
    sqAssert_(line.expected && line.expected.exists === exists,'STALE_EXISTENCE');
    if (exists) {
      sqKeys_(line.expected,['exists','sourceType','values'],'EXPECTED_SHAPE');
      sqKeys_(line.expected.values,fields,'EXPECTED_FIELDS');
      sqAssert_(typeof line.expected.sourceType === 'string' && s_(hits[0].SourceType) === line.expected.sourceType,'STALE_SOURCE');
      fields.forEach(function (f) {
        const expected = line.expected.values[f];
        sqAssert_(expected === null || (typeof expected === 'number' && isFinite(expected)),'EXPECTED_NUMBER');
        sqAssert_(teamAdminSame_(hits[0][f],expected),'STALE_VALUE');
      });
      if (p.SourceKind === 'MAXPREPS') {
        const scopeKey = taReviewKey_(taReviewScope_(hits[0]));
        const covered = ledger[scopeKey] || {}, sources = sourceLedger[scopeKey] || {};
        Object.keys(line.fields).forEach(function (f) {
          const coveredCurrent = Object.prototype.hasOwnProperty.call(covered,f) &&
            teamAdminSame_(hits[0][f],covered[f]);
          const priorMaxPreps = coveredCurrent && sources[f] === 'MAXPREPS';
          const protectedField = !priorMaxPreps && (coveredCurrent ||
            (!provisionalSource_(hits[0].SourceType) && hits[0][f] !== '' &&
              hits[0][f] !== null && hits[0][f] !== undefined));
          sqAssert_(!protectedField || teamAdminSame_(hits[0][f],line.fields[f]),'VERIFIED_UCBAC_PRECEDENCE');
        });
      }
    } else sqKeys_(line.expected,['exists'],'EXPECTED_NEW_SHAPE');
    const before = {playerId:pid,category:category,exists:exists,sourceType:exists?s_(hits[0].SourceType):'',values:{}};
    fields.forEach(function (f) { before.values[f] = exists && hits[0][f] !== undefined && hits[0][f] !== '' ? hits[0][f] : null; });
    const after = JSON.parse(JSON.stringify(before)); after.exists = true;
    Object.keys(line.fields).forEach(function (f) { after.values[f] = line.fields[f]; });
    result.rows.push(row); result.before.push(before); result.after.push(after);
    result.canonical.push({submittedPlayerId:line.playerId,playerId:pid,category:category});
  });
  sqAssert_(JSON.stringify(result.before).length <= 45000 && JSON.stringify(result.after).length <= 45000,'SNAPSHOT_BOUND');
  return result;
}
function sqCell_(v) {
  if (v === null || v === undefined || v === '') return {};
  if (v instanceof Date) {
    const local = Utilities.formatDate(v,db_().getSpreadsheetTimeZone(),"yyyy-MM-dd'T'HH:mm:ss.SSS");
    return {userEnteredValue:{numberValue:Date.parse(local + 'Z') / 86400000 + 25569}};
  }
  if (typeof v === 'number') { sqAssert_(isFinite(v),'NONFINITE'); return {userEnteredValue:{numberValue:v}}; }
  if (typeof v === 'boolean') return {userEnteredValue:{boolValue:v}};
  sqAssert_(String(v).length <= 45000,'CELL_BOUND');
  return {userEnteredValue:{stringValue:String(v)}};
}
function sqPut_(requests, name, row, values) {
  const sh = getTab_(name), capacity = sh.getMaxRows() + requests.reduce(function (n,r) {
    return n + (r.appendDimension && r.appendDimension.sheetId === sh.getSheetId() ? r.appendDimension.length : 0);
  },0), needed = row - capacity;
  if (needed > 0) requests.push({appendDimension:{sheetId:sh.getSheetId(),dimension:'ROWS',length:needed}});
  requests.push({updateCells:{start:{sheetId:sh.getSheetId(),rowIndex:row-1,columnIndex:0},
    rows:[{values:values.map(sqCell_)}],fields:'userEnteredValue'}});
}
function sqObject_(requests, name, row, obj, head) {
  head = head || tabHeader_(name);
  sqPut_(requests,name,row,head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}
function sqAtomic_(requests) {
  sqAssert_(LockService.getScriptLock().hasLock(),'LOCK_REQUIRED');
  sqAssert_(requests.length > 0 && requests.length <= 500 && JSON.stringify(requests).length < 1800000,'TRANSACTION_BOUND');
  // Queue metadata also changes this workbook's public source version. Reuse
  // the existing rebuild so the public completion receipt cannot go stale.
  markDirty_('queue-metadata');
  SpreadsheetApp.flush();
  Sheets.Spreadsheets.batchUpdate({requests:requests},CONFIG.DB_ID);
  __tableCache = {};
}
function sqQueueRow_(row, patch) { return Object.assign({},row,patch); }
function sqReceiptRow_(id) {
  const hits = sqTable_(STATQUEUE.receipts,STATQUEUE.receipt).rows.filter(function (r) { return r.BatchID === id; });
  sqAssert_(hits.length <= 1,'DUPLICATE_RECEIPT'); return hits[0] || null;
}
function sqFinish_(context, writer) {
  const p = context.env.payload, now = new Date().toISOString(), requests = [];
  const corrections = writer ? taReviewCorrectionPlan_(context.me,p.SeasonID,p.TeamID,p.GameID,writer.accepted) : {updates:[],audit:[]};
  if (writer) sqAssert_(!writer.refused.length,'WRITER_REFUSED');
  if (writer) context.plan.after.forEach(function (snapshot) {
    const appended = writer.appends.find(function (r) {
      return taReviewCanonical_(r.PlayerID) === snapshot.playerId && s_(r.category) === snapshot.category;
    });
    const values = appended ? null : writer.values.slice(1).find(function (r) {
      return s_(r[writer.col.GameID]) === p.GameID && s_(r[writer.col.SeasonID]) === p.SeasonID &&
        s_(r[writer.col.TeamID]) === p.TeamID && s_(r[writer.col.grain]) === 'GAME' &&
        taReviewCanonical_(r[writer.col.PlayerID]) === snapshot.playerId &&
        s_(r[writer.col.category]) === snapshot.category;
    });
    sqAssert_(!!(appended || values),'AFTER_IMAGE');
    snapshot.sourceType = s_(appended ? appended.SourceType : values[writer.col.SourceType]);
    Object.keys(snapshot.values).forEach(function (f) {
      const value = appended ? appended[f] : values[writer.col[f]];
      snapshot.values[f] = value === '' || value === undefined || value === null ? null : value;
    });
  });
  const receipt = {schemaVersion:1,batchId:p.BatchID,payloadSHA256:context.env.hash,
    receiptId:'SQR-' + p.BatchID,workerRunId:context.runId,committedAt:now,
    mode:p.SourceKind,lines:writer?context.plan.rows.length:0,saved:writer?writer.saved:0,
    newRows:writer?writer.appends.length:0,updatedRows:writer?Object.keys(writer.touched).length:0,
    reconciledCorrections:corrections.audit.length,canonicalKeys:context.plan.canonical,
    sourceEvidenceSHA256:sqHash_(p.SourceEvidenceJSON),rebuildState:'DIRTY'};
  const audit = writer ? writer.audit.concat(corrections.audit) : [];
  audit.push(auditRow_(context.me,'STATS_QUEUE_COMMIT','StatsImportBatch',p.BatchID,'Receipt','',
    JSON.stringify(receipt),'Immutable source/coverage snapshot in StatsImportReceipts; no notification'));
  // All stat mutations, v233 audit/coverage, correction decisions, queue state
  // and successful receipt are a SINGLE Sheets transaction. Lost replies are
  // recovered by reading this same receipt; the writer is never replayed.
  if (writer) {
    Object.keys(writer.touched).forEach(function (at) { sqPut_(requests,CONFIG.TABS.PLAYER_STATS,Number(at)+1,writer.values[Number(at)]); });
    const start = getTab_(CONFIG.TABS.PLAYER_STATS).getLastRow()+1;
    writer.appends.forEach(function (obj,i) { sqObject_(requests,CONFIG.TABS.PLAYER_STATS,start+i,obj,writer.head); });
    corrections.updates.forEach(function (u) {
      const sh = getTab_(CONFIG.TABS.CORRECTIONS), col = tabHeader_(CONFIG.TABS.CORRECTIONS).indexOf(u.field);
      sqAssert_(col >= 0,'CORRECTION_HEADER');
      requests.push({updateCells:{start:{sheetId:sh.getSheetId(),rowIndex:u.row-1,columnIndex:col},rows:[{values:[sqCell_(u.value)]}],fields:'userEnteredValue'}});
    });
  }
  const auditStart = getTab_(CONFIG.TABS.AUDIT).getLastRow()+1;
  audit.forEach(function (obj,i) { sqObject_(requests,CONFIG.TABS.AUDIT,auditStart+i,obj); });
  const done = sqQueueRow_(context.queue,{State:'PROCESSED',CompletedAt:now,ReceiptID:receipt.receiptId,
    ResultJSON:JSON.stringify(receipt),Error:'',FrozenSHA256:context.env.hash});
  sqObject_(requests,STATQUEUE.queue,context.queue.__row,done,STATQUEUE.input.concat(STATQUEUE.output));
  const record = Object.assign({},context.record,{State:'PROCESSED',AfterJSON:JSON.stringify(context.plan.after),
    ReceiptJSON:JSON.stringify(receipt),CompletedAt:now,Error:'',RebuildState:receipt.rebuildState});
  sqObject_(requests,STATQUEUE.receipts,context.record.__row,record,STATQUEUE.receipt);
  if (writer) { teamAdminBustCache_(p.SeasonID); markDirty_('stats'); }
  sqAtomic_(requests);
  return receipt;
}
function sqCommitWriter_(me, writer) {
  sqAssert_(__statQueueContext && __statQueueContext.me.email === me.email,'CONTEXT_REQUIRED');
  return sqFinish_(__statQueueContext,writer);
}
function sqProcess_(row, me, runId) {
  let record = null, env;
  try {
    env = sqEnvelope_(row);
    record = sqReceiptRow_(row.BatchID);
    if (record) {
      sqAssert_(record.PayloadSHA256 === env.hash && record.FrozenPayloadJSON === env.text,'IMMUTABLE_BATCH');
      if (record.State === 'PROCESSED') {
        const r = sqJSON_(record.ReceiptJSON,'RECEIPT_JSON'), requests = [];
        sqObject_(requests,STATQUEUE.queue,row.__row,sqQueueRow_(row,{State:'PROCESSED',ReceiptID:r.receiptId,
          CompletedAt:record.CompletedAt,ResultJSON:record.ReceiptJSON,Error:'',FrozenSHA256:record.PayloadSHA256}),STATQUEUE.input.concat(STATQUEUE.output));
        sqAtomic_(requests); return r;
      }
    }
    const attempts = Number(row.Attempts || 0)+1;
    sqAssert_(attempts <= STATQUEUE.maxAttempts,'ATTEMPTS_EXHAUSTED');
    const plan = sqPreflight_(env.payload), now = new Date().toISOString();
    const requests = [];
    const queued = sqQueueRow_(row,{State:'PROCESSING',StartedAt:now,Attempts:attempts,Error:'',WorkerRunID:runId,FrozenSHA256:env.hash});
    record = Object.assign({},record || {},{BatchID:row.BatchID,PayloadSHA256:env.hash,State:'PROCESSING',
      FrozenPayloadJSON:env.text,BeforeJSON:JSON.stringify(plan.before),AfterJSON:'',ReceiptJSON:'',
      StartedAt:now,CompletedAt:'',Error:'',WorkerRunID:runId,RebuildState:'NOT_COMMITTED',
      __row:record?record.__row:getTab_(STATQUEUE.receipts).getLastRow()+1});
    // Recovered PROCESSING requests must have the same original preimage.
    // sqPreflight already compared it with current production under the lock.
    sqObject_(requests,STATQUEUE.queue,row.__row,queued,STATQUEUE.input.concat(STATQUEUE.output));
    sqObject_(requests,STATQUEUE.receipts,record.__row,record,STATQUEUE.receipt);
    sqAtomic_(requests);
    __statQueueContext = {queue:queued,record:record,env:env,plan:plan,me:me,runId:runId};
    if (env.payload.SourceKind === 'VERIFY_ONLY') return sqFinish_(__statQueueContext,null);
    return teamAdminWriteStats_(me,env.payload.GameID,env.payload.TeamID,plan.rows,
      {sourceType:env.payload.SourceKind === 'COACH_VERIFIED'?'COACH_ENTRY':'IMPORT',queueContext:__statQueueContext});
  } catch (error) {
    // A network exception can mean the atomic commit succeeded but its reply
    // was lost. A committed receipt always wins over a local error.
    __tableCache = {};
    const latest = env ? sqReceiptRow_(row.BatchID) : null;
    if (latest && latest.State === 'PROCESSED') return sqJSON_(latest.ReceiptJSON,'RECEIPT_JSON');
    const message = /^QUEUE_[A-Z_]+$/.test(String(error.message)) ? error.message : 'QUEUE_EXECUTION_FAILED';
    const requests = [];
    sqObject_(requests,STATQUEUE.queue,row.__row,sqQueueRow_(row,{State:'FAILED',Error:message,
      CompletedAt:new Date().toISOString(),Attempts:Number(row.Attempts||0)+1,WorkerRunID:runId}),STATQUEUE.input.concat(STATQUEUE.output));
    if (latest) sqObject_(requests,STATQUEUE.receipts,latest.__row,Object.assign({},latest,{State:'FAILED',Error:message}),STATQUEUE.receipt);
    else if (env) sqObject_(requests,STATQUEUE.receipts,getTab_(STATQUEUE.receipts).getLastRow()+1,
      {BatchID:row.BatchID,PayloadSHA256:env.hash,State:'FAILED',FrozenPayloadJSON:env.text,
       BeforeJSON:'',AfterJSON:'',ReceiptJSON:'',StartedAt:new Date().toISOString(),CompletedAt:'',
       Error:message,WorkerRunID:runId,RebuildState:'NOT_COMMITTED'},STATQUEUE.receipt);
    sqAtomic_(requests);
    return {batchId:row.BatchID,state:'FAILED',error:message};
  } finally { __statQueueContext = null; }
}
function sqWorker_() {
  if (PropertiesService.getScriptProperties().getProperty(STATQUEUE.enabled) !== 'true') return {enabled:false};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return {busy:true};
  try {
    __tableCache = {};
    const me = sqActor_();
    const table = sqTable_(STATQUEUE.queue,STATQUEUE.input.concat(STATQUEUE.output));
    const row = table.rows.filter(function (r) { return r.State === 'READY' || r.State === 'PROCESSING'; })[0];
    if (!row) return {enabled:true,ready:0};
    if (table.rows.filter(function (r) { return r.BatchID === row.BatchID; }).length !== 1) {
      const requests=[];
      sqObject_(requests,STATQUEUE.queue,row.__row,sqQueueRow_(row,{State:'FAILED',Error:'QUEUE_DUPLICATE_BATCH_ID',
        CompletedAt:new Date().toISOString()}),STATQUEUE.input.concat(STATQUEUE.output));
      sqAtomic_(requests); return {state:'FAILED',error:'QUEUE_DUPLICATE_BATCH_ID'};
    }
    const result = sqProcess_(row,me,Utilities.getUuid());
    Logger.log(JSON.stringify(result)); return result;
  } finally { lock.releaseLock(); }
}
function queueImportSetup() {
  sqActor_(); const lock = LockService.getScriptLock();
  sqAssert_(lock.tryLock(1000),'BUSY');
  try {
    const requests = [];
    [[STATQUEUE.queue,STATQUEUE.input.concat(STATQUEUE.output)],[STATQUEUE.receipts,STATQUEUE.receipt]].forEach(function (pair) {
      const sh = hasTab_(pair[0]) ? getTab_(pair[0]) : db_().insertSheet(pair[0]);
      const values = sh.getDataRange().getValues(), formulas = sh.getDataRange().getFormulas();
      const blank = values.every(function (r) { return r.every(function (v) { return v === ''; }); }) &&
        formulas.every(function (r) { return r.every(function (v) { return v === ''; }); });
      if (blank) sqPut_(requests,pair[0],1,pair[1]);
      else sqTable_(pair[0],pair[1]);
      const id = sh.getSheetId(), width = pair[1].length;
      requests.push({repeatCell:{range:{sheetId:id,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:width},
        cell:{userEnteredFormat:{textFormat:{bold:true}},note:'Queue schema v1. Connector writes only StatsImportQueue A:L; outputs and receipts are worker-owned. Long JSON intentionally clipped; inspect full values in formula bar.'},fields:'userEnteredFormat.textFormat.bold,note'}},
        {updateSheetProperties:{properties:{sheetId:id,gridProperties:{frozenRowCount:1}},fields:'gridProperties.frozenRowCount'}},
        {updateDimensionProperties:{range:{sheetId:id,dimension:'COLUMNS',startIndex:0,endIndex:width},properties:{pixelSize:180},fields:'pixelSize'}},
        {repeatCell:{range:{sheetId:id,startRowIndex:0,endRowIndex:sh.getMaxRows(),startColumnIndex:0,endColumnIndex:width},cell:{userEnteredFormat:{wrapStrategy:'CLIP'}},fields:'userEnteredFormat.wrapStrategy'}});
    });
    sqAtomic_(requests);
    Logger.log(JSON.stringify({setup:true,enabled:PropertiesService.getScriptProperties().getProperty(STATQUEUE.enabled)==='true',triggers:sqTriggers_()}));
  } finally { lock.releaseLock(); }
}
function sqTriggers_() {
  return ScriptApp.getProjectTriggers().map(function (t) { return {handler:t.getHandlerFunction(),event:String(t.getEventType())}; });
}
function queueImportActivate() {
  sqActor_();
  sqTable_(STATQUEUE.queue,STATQUEUE.input.concat(STATQUEUE.output)); sqTable_(STATQUEUE.receipts,STATQUEUE.receipt);
  sqAssert_(sqTriggers_().filter(function (t) { return t.handler === 'sweepRebuild'; }).length === 1,'EXACTLY_ONE_SWEEP_REQUIRED');
  PropertiesService.getScriptProperties().setProperty(STATQUEUE.enabled,'true');
  Logger.log('Queue active on existing sweepRebuild; no trigger or OAuth scope added.');
}
function queueImportPause() {
  sqActor_(); PropertiesService.getScriptProperties().deleteProperty(STATQUEUE.enabled);
  Logger.log('Queue paused; existing rebuild and unrelated triggers unchanged.');
}
function queueImportStatus() {
  sqActor_(); Logger.log(JSON.stringify({enabled:PropertiesService.getScriptProperties().getProperty(STATQUEUE.enabled)==='true',triggers:sqTriggers_(),build:buildStatus_()}));
}
