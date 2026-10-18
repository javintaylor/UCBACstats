/** Administrator-only, non-destructive account closure. No row deletion or email. */
const ACCOUNT_CLOSURE = {
  TAB:'AccountClosures', TTL:300,
  COLS:['ClosureID','AccountID','Email','ClosedAt','ClosedBy','Reason','PriorStatus',
        'AccountDigest','CoachSnapshot','SessionRows','ReleaseID']
};
function closureEmail_(v) { return String(v || '').trim().toLowerCase(); }
function closureRows_() { return hasTab_(ACCOUNT_CLOSURE.TAB) ? rowsOf_(ACCOUNT_CLOSURE.TAB) : []; }
function closureAdmin_() {
  authRecheckBoundSession_();
  const me=accountsWhoami_();
  if (!me.email || me.role !== 'ADMIN') throw new Error('Administrator only.');
  return me;
}
function closureAccount_(target) {
  target=s_(target);
  const email=closureEmail_(target), rows=hasTab_(ACCT.TAB) ? rowsOf_(ACCT.TAB) : [];
  const byId=rows.filter(function(r){return s_(r.AccountID) === target;});
  if (byId.length > 1) throw new Error('Duplicate account ID. Resolve it before closing an account.');
  if (byId.length) return byId[0];
  const live=rows.filter(function(r){return closureEmail_(r.Email)===email && acctStatusOf_(r)!=='CLOSED';});
  if (live.length > 1) throw new Error('Duplicate current accounts. Resolve them before closing an account.');
  if (live.length) return live[0];
  const old=rows.filter(function(r){return closureEmail_(r.Email)===email && acctStatusOf_(r)==='CLOSED';});
  if (old.length) throw new Error('Only closed accounts found. Review one using its original account ID.');
  throw new Error('No account found. Enter the exact email or account ID.');
}
function closureAdminEmails_() {
  const out={};
  acctRows_().forEach(function(r){if(acctStatusOf_(r)==='ACTIVE' && s_(r.Role).toUpperCase()==='ADMIN') out[closureEmail_(r.Email)]=true;});
  if(hasTab_('Coaches')) rowsOf_('Coaches').forEach(function(r){
    if(String(r.Active).toUpperCase()!=='FALSE' && s_(r.Role).toUpperCase()==='ADMIN') out[closureEmail_(r.Email)]=true;
  });
  delete out['']; return Object.keys(out);
}
function closureState_(row,me) {
  const email=closureEmail_(row.Email), id=s_(row.AccountID);
  if(!authMailable_(email)||!id) throw new Error('The account has no valid identity. Resolve it before closure.');
  if(email===closureEmail_(me.email)) throw new Error('You cannot close your own account.');
  const duplicates=acctRows_().filter(function(r){return closureEmail_(r.Email)===email || s_(r.AccountID)===id;});
  if(duplicates.length!==1 || duplicates[0].__row!==row.__row) throw new Error('Account identity changed. Review it again.');
  const admins=closureAdminEmails_();
  if(admins.indexOf(closureEmail_(me.email))<0) throw new Error('Your administrator grant changed. Sign in again.');
  if(admins.indexOf(email)>=0 && admins.filter(function(e){return e!==email;}).length===0)
    throw new Error('The last administrator cannot be closed.');
  const grants=hasTab_('Coaches') ? rowsOf_('Coaches').filter(function(r){return closureEmail_(r.Email)===email && String(r.Active).toUpperCase()!=='FALSE';}) : [];
  const sessions=hasTab_(AUTH.TAB) ? rowsOf_(AUTH.TAB).filter(function(r){return closureEmail_(r.Email)===email && !r.RevokedAt;}) : [];
  const clean=function(r){const x={}; Object.keys(r).sort().forEach(function(k){if(k!=='LastSeenAt')x[k]=r[k];});return x;};
  const evidence=policyRows_(POLICY.ACK_TAB).filter(function(r){return closureEmail_(r.Email)===email;});
  const digest=authHash_(JSON.stringify([clean(row),grants.map(clean),sessions.map(clean),evidence,
    policyRows_('AccountIdentityReleases').filter(function(r){return closureEmail_(r.Email)===email;})]));
  return {email:email,id:id,grants:grants,sessions:sessions,digest:digest};
}
/** Shared emailed decision capabilities expire for affected teams when a reviewer closes.
 * No secret rotation. An ADMIN closure expires all shared review links; a COACH closure
 * expires its teams' links. Other authorized reviewers use the portal or a newly issued link.
 */
function closureReviewEpoch_(teamId) {
  const all=hasTab_(ACCT.TAB) ? rowsOf_(ACCT.TAB) : [];
  const ids=closureRows_().filter(function(record){
    if(!record.ClosedAt || !record.ClosureID)return false;
    const row=all.filter(function(r){return s_(r.AccountID)===s_(record.AccountID);})[0];
    const direct=row && s_(record.PriorStatus).toUpperCase()==='ACTIVE' &&
      (s_(row.Role).toUpperCase()==='ADMIN' || (s_(row.Role).toUpperCase()==='COACH' && s_(row.TeamID)===teamId));
    var grants=[];try{grants=JSON.parse(record.CoachSnapshot || '[]');}catch(e){throw new Error('Closure grant history needs administrator review.');}
    return direct || grants.some(function(g){return s_(g.Role).toUpperCase()==='ADMIN' || (s_(g.Role).toUpperCase()==='COACH' && s_(g.TeamID)===teamId);});
  }).map(function(r){return s_(r.ClosureID);}).sort();
  return ids.length ? authHash_(ids.join('|')) : '';
}
/** Exact-target review only; never returns DOB, Note, consent documents or session hashes. */
function apiPrepareAccountClosure_(target) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account change is in progress. Try again.');
  try {
    __tableCache={}; const me=closureAdmin_(), row=closureAccount_(target);
    if(acctStatusOf_(row)==='CLOSED') {
      const records=closureRows_().filter(function(r){return s_(r.AccountID)===s_(row.AccountID);});
      const last=records[records.length-1];
      return {closed:true,accountId:s_(row.AccountID),email:closureEmail_(row.Email),
        name:s_(row.DisplayName),closedAt:last ? policyDateText_(last.ClosedAt) : '',
        message:'This account is already closed. Its history is preserved.'};
    }
    const state=closureState_(row,me), ticket=Utilities.getUuid();
    CacheService.getScriptCache().put('account-close:'+ticket,JSON.stringify({
      actor:closureEmail_(me.email),accountId:state.id,email:state.email,digest:state.digest,
      expiresAt:Date.now()+ACCOUNT_CLOSURE.TTL*1000
    }),ACCOUNT_CLOSURE.TTL);
    const reviewTeams={}; var allReviewTeams=false;
    state.grants.concat(acctStatusOf_(row)==='ACTIVE' ? [row] : []).forEach(function(g){
      const role=s_(g.Role).toUpperCase();
      if(role==='ADMIN')allReviewTeams=true;
      else if(role==='COACH' && s_(g.TeamID))reviewTeams[s_(g.TeamID)]=true;
    });
    const affectedTeams=Object.keys(reviewTeams);
    const reviewLinkScope=allReviewTeams ? 'all teams' : affectedTeams.map(function(id){
      return typeof teamNameOf_==='function' ? (teamNameOf_(id)||id) : id;
    }).join(', ');
    return {closed:false,ticket:ticket,accountId:state.id,email:state.email,name:s_(row.DisplayName),
      status:acctStatusOf_(row),role:s_(row.Role || row.RequestedRole),
      sessions:state.sessions.length,coachGrants:state.grants.length,
      reviewLinksAffected:allReviewTeams||affectedTeams.length>0,reviewLinkScope:reviewLinkScope,expiresIn:ACCOUNT_CLOSURE.TTL};
  } finally {lock.releaseLock();}
}
/** Build one Sheets batch: all durable changes succeed together, including new ledger headers. */
function closureBatch_(row,state,me,reason,ticket,now) {
  const requests=[], sheets=db_().getSheets();
  let next=sheets.reduce(function(n,sh){return Math.max(n,sh.getSheetId());},0)+1;
  const cell=function(v){return {userEnteredValue:{stringValue:String(v===undefined||v===null ? '' : v)}};};
  const plans={};
  const table=function(name,required,create){
    if(plans[name])return plans[name];
    const sh=hasTab_(name) ? getTab_(name) : null;
    if(!sh&&!create)throw new Error('Missing '+name+' table. Nothing was closed.');
    const headers=sh ? sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(v){return String(v).trim();}) : required;
    if(required.some(function(h){return headers.indexOf(h)<0;}) || headers.some(function(h,i){return h && headers.indexOf(h)!==i;}))
      throw new Error('Unexpected '+name+' headers. Nothing was closed.');
    const id=sh ? sh.getSheetId() : next++;
    if(!sh){
      requests.push({addSheet:{properties:{sheetId:id,title:name,gridProperties:{rowCount:1000,columnCount:Math.max(20,headers.length),frozenRowCount:1}}}});
      requests.push({updateCells:{start:{sheetId:id,rowIndex:0,columnIndex:0},rows:[{values:headers.map(cell)}],fields:'userEnteredValue'}});
    }
    return plans[name]={id:id,headers:headers};
  };
  const set=function(name,fields,r,field,value){
    const t=table(name,fields,false), col=t.headers.indexOf(field);
    requests.push({updateCells:{start:{sheetId:t.id,rowIndex:r-1,columnIndex:col},rows:[{values:[cell(value)]}],fields:'userEnteredValue'}});
  };
  const append=function(name,fields,value,create){
    const t=table(name,fields,create);
    requests.push({appendCells:{sheetId:t.id,rows:[{values:t.headers.map(function(h){return cell(value[h]);})}],fields:'userEnteredValue'}});
  };
  const releaseId=Utilities.getUuid(), at=now.toISOString();
  set(ACCT.TAB,ACCT.COLS,row.__row,'Status','CLOSED');
  state.grants.forEach(function(g){set('Coaches',['Email','Role','Active'],g.__row,'Active','FALSE');});
  state.sessions.forEach(function(r){set(AUTH.TAB,AUTH.COLS,r.__row,'RevokedAt',at);});
  append('AccountIdentityReleases',['ReleaseID','Email','PriorAccountID','ReleasedAt','ReleasedBy','Reason'],
    {ReleaseID:releaseId,Email:state.email,PriorAccountID:state.id,ReleasedAt:at,ReleasedBy:me.email,Reason:reason},true);
  append(ACCOUNT_CLOSURE.TAB,ACCOUNT_CLOSURE.COLS,{ClosureID:ticket,AccountID:state.id,Email:state.email,
    ClosedAt:at,ClosedBy:me.email,Reason:reason,PriorStatus:String(row.Status||''),AccountDigest:state.digest,
    CoachSnapshot:JSON.stringify(state.grants),SessionRows:JSON.stringify(state.sessions.map(function(r){return r.__row;})),ReleaseID:releaseId},true);
  const audit=auditRow_(me,'ACCOUNT_CLOSE','Account',state.id,'Status',String(row.Status||''),'CLOSED',reason+' [closure '+ticket+']');
  audit.AuditID=Utilities.getUuid(); audit.Timestamp=at; audit.RequestID=ticket;
  append(CONFIG.TABS.AUDIT,Object.keys(audit),audit,false);
  const payload=JSON.stringify({requests:requests});
  if(payload.length>1000000)throw new Error('Closure is too large for one safe operation. Nothing was closed.');
  return payload;
}
function closureCommit_(payload) {
  SpreadsheetApp.flush();
  // Existing spreadsheets + external_request scopes; no new credentials or advanced-service dependency.
  const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(CONFIG.DB_ID)+':batchUpdate',{
    method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},
    payload:payload,muteHttpExceptions:true,followRedirects:false
  });
  if(response.getResponseCode()<200||response.getResponseCode()>=300)
    throw new Error('Closure could not be confirmed. Review the account again before retrying.');
}
/** Only remove sessions from the retired generation; never affect a later account on retry. */
function closureClearCaches_(record) {
  const at=new Date(record.ClosedAt).getTime();
  const keys=(hasTab_(AUTH.TAB) ? rowsOf_(AUTH.TAB) : []).filter(function(r){
    return closureEmail_(r.Email)===closureEmail_(record.Email) && r.RevokedAt && (new Date(r.CreatedAt).getTime()<=at || new Date(r.RevokedAt).getTime()===at);
  }).map(function(r){return 'sess:'+String(r.SessionHash);});
  keys.push('boot');
  try {CacheService.getScriptCache().removeAll(keys);return true;} catch(e){return false;}
}
function apiCloseAccount_(p) {
  p=p||{};
  const ticket=s_(p.ticket), id=s_(p.accountId), reason=s_(p.reason), confirmation=closureEmail_(p.confirmEmail);
  if(!/^[\w-]{8,80}$/.test(ticket)||!id||reason.length<8||reason.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason))
    throw new Error('Review the account and enter a closure reason of 8–500 characters.');
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error('Another account change is in progress. Try again.');
  try {
    __tableCache={}; const me=closureAdmin_();
    const completed=closureRows_().filter(function(r){return s_(r.ClosureID)===ticket;})[0];
    if(completed){
      if(s_(completed.AccountID)!==id||closureEmail_(completed.ClosedBy)!==closureEmail_(me.email)||closureEmail_(completed.Email)!==confirmation||s_(completed.Reason)!==reason)
        throw new Error('This confirmation does not match the completed closure.');
      const archived=closureAccount_(id);
      const evidence=policyRows_('AccountIdentityReleases').some(function(r){
        return s_(r.ReleaseID)===s_(completed.ReleaseID) && !!r.ReleasedAt && isFinite(new Date(r.ReleasedAt).getTime());
      });
      if(acctStatusOf_(archived)!=='CLOSED'||!evidence)
        throw new Error('This closure was reconciled or rolled back. Review the account again.');
      return {ok:true,closed:true,repeated:true,accountId:id,cacheCleared:closureClearCaches_(completed),message:'Account already closed. Its history is preserved.'};
    }
    const raw=CacheService.getScriptCache().get('account-close:'+ticket);
    const review=raw ? JSON.parse(raw) : null;
    if(!review||review.expiresAt<=Date.now()||review.actor!==closureEmail_(me.email)||review.accountId!==id||review.email!==confirmation)
      throw new Error('The confirmation expired or does not match. Review the account again.');
    const row=closureAccount_(id), state=closureState_(row,me);
    if(state.digest!==review.digest)throw new Error('The account, grants or sessions changed. Review the account again.');
    const now=new Date(), payload=closureBatch_(row,state,me,reason,ticket,now);
    // Pre-commit removal is safe if the batch fails. Durable release checks reject stale cache resurrection.
    CacheService.getScriptCache().removeAll(['lc:'+state.email,'lc-n:'+state.email,'lc-cool:'+state.email,'reg:'+state.email]);
    try {closureCommit_(payload);} catch(e){
      __tableCache={}; __tabMap=null; __ss=null;
      if(!closureRows_().some(function(r){return s_(r.ClosureID)===ticket;}))throw e;
    }
    __tableCache={}; __tabMap=null; __ss=null;
    const record=closureRows_().filter(function(r){return s_(r.ClosureID)===ticket;})[0];
    const closed=closureAccount_(id), release=policyRelease_(state.email);
    if(!record||acctStatusOf_(closed)!=='CLOSED'||!release||String(release.ReleaseID)!==String(record.ReleaseID)||
        acctRows_().some(function(r){return closureEmail_(r.Email)===state.email;})||
        (hasTab_('Coaches')&&rowsOf_('Coaches').some(function(r){return closureEmail_(r.Email)===state.email&&String(r.Active).toUpperCase()!=='FALSE';}))||
        (hasTab_(AUTH.TAB)&&rowsOf_(AUTH.TAB).some(function(r){return closureEmail_(r.Email)===state.email&&!r.RevokedAt;})))
      throw new Error('Closure result needs administrator review. Do not create a new account yet.');
    return {ok:true,closed:true,accountId:id,closureId:ticket,cacheCleared:closureClearCaches_(record),
      message:'Account closed. Sessions ended; history preserved. Fresh registration requires new policy acknowledgments.'};
  } finally {lock.releaseLock();}
}
