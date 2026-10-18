// LOCAL CANDIDATE ONLY. Disabled without an explicit bounded source scope.
// This file belongs to the source writer project; copying it to a different
// Apps Script project cannot certify the live writer's work.
var __appPublicOwner = null;
var __appPublicInputs = null;
var __appPublicWriteDepth = 0;
var APP_PUBLIC_STATE = 'APP_PUBLIC_REBUILD_STATE';

function appPublicScope_() {
  try {
    var p = PropertiesService.getScriptProperties();
    if (p.getProperty('APP_PUBLIC_REFRESH_ENABLED') !== 'true') return null;
    var raw = p.getProperty('APP_PUBLIC_REFRESH_SCOPE');
    if (!raw || raw.length > 2048) return null;
    var scope = JSON.parse(raw);
    UCBACPublicSource.publicEvidenceScopeHash(scope, Date.now());
    return scope.spreadsheetId === CONFIG.DB_ID ? scope : null;
  } catch (_) { return null; }
}
function appPublicRows_(tabName) {
  if (!__appPublicInputs || !Object.prototype.hasOwnProperty.call(__appPublicInputs, tabName)) return null;
  // Derivation helpers may sort/mutate their result; the captured rows stay fixed.
  return __appPublicInputs[tabName].map(function (row) { return Object.assign({}, row); });
}
function appPublicInputRows_() {
  var contract = UCBACPublicSource.contract, result = {};
  var extra = {Games:['Notes'], PlayerGameStats:['Pancakes','Blocks','BlockedPunts','TwoPointConversions'],
    TeamSeasons:['TeamID','SeasonID','Wins','Losses','ConfWins','ConfLosses','PointsFor','DefPointsAllowed']};
  ['Seasons','Teams','Players','PlayerSeasons','Games','PlayerGameStats','TeamSeasons'].forEach(function (name) {
    var sh = db_().getSheetByName(name);
    if (!sh) { if (name !== 'TeamSeasons') throw Error('Missing source input'); result[name] = []; return; }
    var last = sh.getLastRow(), width = sh.getLastColumn();
    if (last > 100001 || width < 1 || width > 512) throw Error('Source bounds');
    var header = sh.getRange(1, 1, 1, width).getValues()[0].map(function(value){return String(value).trim();});
    var names = (contract[name] || []).reduce(function (out, span) { return out.concat(span.headers); }, []).concat(extra[name] || []);
    var rows = Array.from({length:Math.max(0,last-1)}, function () { return {}; });
    // Read only selected input columns, never account/session/birthday/contact
    // columns. Games.Notes stays inside Google's derivation process for the
    // incumbent forfeit rule; it is NOT included in the public export contract.
    var columns = [];
    names.forEach(function (field) {
      var index = header.indexOf(field);
      if (index < 0) return;
      if (header.lastIndexOf(field) !== index) throw Error('Duplicate input header');
      columns.push({index:index,field:field});
    });
    columns.sort(function (a,b) { return a.index-b.index; });
    for (var i=0; i<columns.length;) {
      var end=i+1;while(end<columns.length && columns[end].index===columns[end-1].index+1)end++;
      if (rows.length) {
        var values=sh.getRange(2,columns[i].index+1,rows.length,end-i).getValues();
        values.forEach(function (row,r) { for(var c=i;c<end;c++) rows[r][columns[c].field]=row[c-i]; });
      }
      i=end;
    }
    rows.forEach(function(row,index){
      // A row with only excluded columns is ambiguous. Keep ordinary website
      // behavior by abandoning app capture rather than guessing its meaning.
      if(!Object.keys(row).some(function(key){return row[key]!==''&&row[key]!==null;}) &&
         !m15RetiredSlot_(name,index+2))throw Error('Unresolved empty source input');
      row.__row=index+2;
    });
    // Approved archived slots have no live values; keep all other empty-row refusals.
    result[name]=rows.filter(function(row){return Object.keys(row).some(function(key){return key!=='__row'&&row[key]!==''&&row[key]!==null;});});
  });
  return result;
}
function appPublicJSON_(url) {
  var response=UrlFetchApp.fetch(url,{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true,followRedirects:false});
  if(response.getResponseCode()!==200)throw Error('Source read unavailable HTTP '+response.getResponseCode());
  var text=response.getContentText();if(Utilities.newBlob(text).getBytes().length>2097152)throw Error('Source response bounds');
  return JSON.parse(text);
}
function appPublicStamp_() {
  var data=appPublicJSON_('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(CONFIG.DB_ID)+'?fields=id,mimeType,modifiedTime,version,trashed');
  if(data.id!==CONFIG.DB_ID||data.mimeType!=='application/vnd.google-apps.spreadsheet'||data.trashed!==false||!/^\d+$/.test(data.version)||!isFinite(Date.parse(data.modifiedTime)))throw Error('Source stamp unavailable');
  return {version:data.version,modifiedTime:new Date(data.modifiedTime).toISOString()};
}
function appPublicContent_() {
  var contract=UCBACPublicSource.contract, headers={}, lastRows={}, jobs=[], ranges=[], cells=0;
  var col=function (text) { return text.split('').reduce(function(n,c){return n*26+c.charCodeAt(0)-64;},0); };
  Object.keys(contract).forEach(function(name){
    var sh=db_().getSheetByName(name);if(!sh)throw Error('Missing public source');
    var count=sh.getMaxRows();if(count<2||count>100001)throw Error('Source row bounds');lastRows[name]=count;
    headers[name]=Array(Math.max.apply(null,contract[name].map(function(s){return col(s.to);}))).fill(null);
    contract[name].forEach(function(span){
      var actual=sh.getRange(1,col(span.from),1,span.headers.length).getValues()[0];
      if(JSON.stringify(actual)!==JSON.stringify(span.headers))throw Error('Public headers changed '+name+' '+span.from+':'+span.to);
      headers[name].splice.apply(headers[name],[col(span.from)-1,span.headers.length].concat(span.headers));
      cells+=(count-1)*span.headers.length;
      for(var start=2;start<=count;start+=250)jobs.push({sheet:name,a:span.from,b:span.to,start:start,end:Math.min(start+249,count)});
    });
  });
  if(cells>1500000||jobs.length>1920)throw Error('Public export bounds '+cells+' cells '+jobs.length+' ranges');
  var totalBytes=0;
  for(var i=0;i<jobs.length;i+=8){
    var batch=jobs.slice(i,i+8),names=batch.map(function(j){return j.sheet+'!'+j.a+j.start+':'+j.b+j.end;});
    var url='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(CONFIG.DB_ID)+'/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
    names.forEach(function(name){url+='&ranges='+encodeURIComponent(name);});
    var result=appPublicJSON_(url);totalBytes+=Utilities.newBlob(JSON.stringify(result)).getBytes().length;
    if(totalBytes>25165824||result.spreadsheetId!==CONFIG.DB_ID||!Array.isArray(result.valueRanges)||result.valueRanges.length!==batch.length)throw Error('Public export response');
    result.valueRanges.forEach(function(value,index){
      var job=batch[index];if(value.range.replace(/^'([A-Za-z]+)'!/, '$1!')!==names[index]||value.majorDimension!=='ROWS')throw Error('Public range mismatch');
      var values=value.values||[];if(!Array.isArray(values)||values.length>job.end-job.start+1)throw Error('Public range rows');
      values=values.map(function(row){
        if(!Array.isArray(row)||row.length>col(job.b)-col(job.a)+1)throw Error('Public range columns');
        row=row.map(function(v){if(v===null)return '';if(!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!isFinite(v)||typeof v==='string'&&v.length>4096)throw Error('Public cell');return v;});
        while(row.length&&row[row.length-1]==='')row.pop();return row;
      });
      while(values.length&&values[values.length-1].length===0)values.pop();
      ranges.push({job:job,data:{range:names[index],majorDimension:'ROWS',values:values}});
    });
  }
  return {contractSHA256:UCBACPublicSource.contractSHA256,headers:headers,lastRows:lastRows,ranges:ranges};
}
function appPublicProducer_() {
  var p=PropertiesService.getScriptProperties();
  return UCBACPublicSource.createPublicRebuildProducer({
    load:function(){var raw=p.getProperty(APP_PUBLIC_STATE);if(raw&&raw.length>8192)throw Error('Completion bounds');return raw?JSON.parse(raw):null;},
    save:function(state){p.setProperty(APP_PUBLIC_STATE,JSON.stringify(state));},
    readInputs:appPublicInputRows_,readPublicContent:appPublicContent_,stamp:appPublicStamp_,
    newId:function(){return Utilities.getUuid();},locked:function(){return LockService.getScriptLock().hasLock();},
    readEditToken:function(){return p.getProperty('APP_PUBLIC_EDIT_TOKEN')||'';}
  });
}
function appPublicRebuildBegin_() {
  __appPublicOwner=null;__appPublicInputs=null;
  if(!appPublicScope_())return false;
  try { __appPublicOwner=appPublicProducer_();__appPublicInputs=__appPublicOwner.begin();return true; }
  catch(_){__appPublicOwner=null;__appPublicInputs=null;return false;}
}
function appPublicRebuildFinish_(success) {
  var owner=__appPublicOwner;__appPublicInputs=null;
  try {if(owner){if(success&&appPublicScope_()){SpreadsheetApp.flush();owner.complete(CONFIG.DB_ID);}else owner.fail();}}
  catch(error){
    try {if(owner)owner.fail();}catch(ignore){}
    // Report only our bounded operational error labels, never cells, response
    // bodies, credentials or arbitrary upstream exception messages.
    var message=String(error&&error.message||'');
    var safe=/^(Source|Public|Missing|Duplicate|Unresolved|Completion)[A-Za-z0-9 .,():!_-]{0,180}$/.test(message)?message:'Unexpected capture fault';
    try {Logger.log('App public completion: '+safe);}catch(ignore){}
    // A source-export problem must not break the website's completed rebuild.
    try {PropertiesService.getScriptProperties().setProperty('UCBAC_DIRTY','app-public-retry');}catch(ignore){}
  } finally {__appPublicOwner=null;}
}
function appPublicDirectWrite_(operation) {
  if(__appPublicOwner||!appPublicScope_()){__appPublicWriteDepth++;try{return operation();}finally{__appPublicWriteDepth--;}}
  var lock=LockService.getScriptLock(), ownsLock=!lock.hasLock();if(ownsLock&&!lock.tryLock(5000))throw Error('Another rebuild is running. Try again shortly.');
  __appPublicWriteDepth++;
  try {appPublicProducer_().invalidate();PropertiesService.getScriptProperties().setProperty('UCBAC_DIRTY','app-public-retry');return operation();}
  finally {__appPublicWriteDepth--;if(ownsLock)lock.releaseLock();}
}
function appPublicMarkEdit_() {
  // Keep the existing dirty marker running if this optional receipt fails.
  // A changed-input hash or source stamp independently denies stale exports.
  try {if(appPublicScope_())PropertiesService.getScriptProperties().setProperty('APP_PUBLIC_EDIT_TOKEN',Utilities.getUuid());}catch(_){}
}
function appPublicCollection_() {
  var started=Date.now(),before=appPublicStamp_();
  if(started-Date.parse(before.modifiedTime)<60000)throw Error('Source busy');
  var first=appPublicContent_(),second=appPublicContent_(),after=appPublicStamp_();
  if(JSON.stringify(first)!==JSON.stringify(second)||JSON.stringify(before)!==JSON.stringify(after))throw Error('Source changed');
  var captured=Date.now(),day=Utilities.formatDate(new Date(captured),'America/New_York','yyyy-MM-dd');
  if(day!==Utilities.formatDate(new Date(started),'America/New_York','yyyy-MM-dd')||captured-started>90000)throw Error('Source timing');
  var bundle={schemaVersion:1,asOf:day,complete:true,headers:second.headers,lastRows:second.lastRows,ranges:second.ranges,expectedRangeCount:second.ranges.length,acquiredRangeCount:second.ranges.length};
  var text=JSON.stringify(bundle)+'\n';
  var receipt={schemaVersion:1,contractSHA256:UCBACPublicSource.contractSHA256,
    bundleSHA256:Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b){return(b&255).toString(16).padStart(2,'0');}).join(''),
    startedAt:new Date(started).toISOString(),capturedAt:new Date(captured).toISOString(),sourceModifiedAt:before.modifiedTime,sourceVersion:before.version,
    requestCount:2+2*Math.ceil(second.ranges.length/8),responseBytes:Utilities.newBlob(text).getBytes().length,rangeCount:second.ranges.length,sourceDate:day,matchingPasses:2};
  return {text:text,receipt:receipt};
}
function ucbacAppPublicEvidence_(e) {
  var result,lock;
  try {
    if(!e||e.queryString!=='appPublicEvidence=1'||!e.postData||e.postData.type!=='application/json'||typeof e.postData.contents!=='string'||Utilities.newBlob(e.postData.contents).getBytes().length>16384)throw Error('Unavailable');
    var p=PropertiesService.getScriptProperties();
    var source=UCBACPublicSource.createPublicEvidenceSource({getScope:appPublicScope_,getKey:function(){return p.getProperty('APP_PUBLIC_REFRESH_KEY');},spreadsheetId:CONFIG.DB_ID,
      collect:function(){lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('Source busy');var raw=p.getProperty(APP_PUBLIC_STATE);if(p.getProperty('UCBAC_DIRTY')||!raw||JSON.parse(raw).status!=='ready')throw Error('Source not ready');return appPublicCollection_();},
      observe:function(requestId){lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('Source busy');return appPublicProducer_().observe(requestId,{dirty:!!p.getProperty('UCBAC_DIRTY')});}});
    result=source(JSON.parse(e.postData.contents));
  } catch(_) {result={error:'Public source evidence unavailable.'};}
  finally {if(lock&&lock.hasLock())lock.releaseLock();}
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
