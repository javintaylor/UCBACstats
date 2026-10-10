// GENERATED. scripts/build-daily-summary-source.mjs; local draft, not deployed.
var UCBACDailySummarySource=(function(){
'use strict';
const projectDailySummary=(function(){
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const clean=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(v);
// Project only display fields from the website's stored pair. Internal facts,
// source metadata, identity and any unrecognized fields never reach the app.
function projectDailySummary(value,season){
 if(value===null)return null;
 if(!value||value.schema!==1||!id(season)||value.seasonId!==season||!clean(value.seasonLabel,100)||!/^\d{4}-\d{2}-\d{2}$/.test(value.day)||!Number.isFinite(Date.parse(value.day+'T00:00:00Z'))||new Date(value.day+'T00:00:00Z').toISOString().slice(0,10)!==value.day||!clean(value.generatedAt,40)||!/^\d{4}-\d{2}-\d{2}T/.test(value.generatedAt)||!Number.isFinite(Date.parse(value.generatedAt)))throw Error('Invalid edition');
 let size=0;const editions={};
 for(const kind of ['players','teams']){
  const a=value.editions?.[kind];
  if(!a||!clean(a.headline,120)||!a.headline.trim()||!Array.isArray(a.paragraphs)||a.paragraphs.length!==3)throw Error('Invalid article');
  editions[kind]={headline:a.headline,paragraphs:a.paragraphs.map(p=>{
   if(!Array.isArray(p)||p.length<1||p.length>60)throw Error('Invalid paragraph');
   const parts=p.map(s=>{
    if(!s||!clean(s.text,1200))throw Error('Invalid segment');size+=s.text.length;
    if(s.type==null){if(s.id!=null)throw Error('Invalid profile');return{text:s.text};}
    if(!['player','team','coach'].includes(s.type)||!id(s.id))throw Error('Invalid profile');
    return{text:s.text,type:s.type,id:s.id};
   });
   if(!parts.map(s=>s.text).join('').trim())throw Error('Empty paragraph');return parts;
  })};
 }
 if(size>18000)throw Error('Oversized edition');
 return{schema:1,day:value.day,seasonId:season,seasonLabel:value.seasonLabel,generatedAt:value.generatedAt,editions};
}

return projectDailySummary;})();

const fail=()=>{throw Error('Stored summary source unavailable.');};
const bytes=value=>Utilities.newBlob(value).getBytes().length;
const encode=value=>Utilities.base64EncodeWebSafe(value,Utilities.Charset.UTF_8).replace(/=+$/,'');
const decode=value=>Utilities.newBlob(Utilities.base64DecodeWebSafe(value)).getDataAsString('UTF-8');
const mac=(key,value)=>Utilities.computeHmacSha256Signature(value,key,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join() === [...keys].sort().join();
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;let mismatch=0;for(let i=0;i<64;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0;}
function keyValid(key){if(typeof key!=='string'||bytes(key)<32||bytes(key)>256)fail();}
function validateSummaryScope(scope,now){
 if(!exact(scope,['version','projectRef','sourceScriptId','windowId','startsAt','expiresAt'])||scope.version!==1||!/^[a-z]{20}$/.test(scope.projectRef)||!identifier(scope.sourceScriptId)||scope.sourceScriptId.length<20||!identifier(scope.windowId)||!Number.isSafeInteger(now)||!Number.isSafeInteger(scope.startsAt)||!Number.isSafeInteger(scope.expiresAt)||scope.startsAt>now||scope.expiresAt<=now||scope.expiresAt<=scope.startsAt||scope.expiresAt-scope.startsAt>86400000)fail();
 return scope;
}
function unpack(envelope,domain,key,max){
 keyValid(key);
 if(!exact(envelope,['payload','signature'])||typeof envelope.payload!=='string'||envelope.payload.length>max*2||!/^[A-Za-z0-9_-]+$/.test(envelope.payload)||!equal(mac(key,domain+'\n'+envelope.payload),envelope.signature))fail();
 const text=decode(envelope.payload);
 if(bytes(text)>max||encode(text)!==envelope.payload)fail();
 return JSON.parse(text);
}
function sign(value,domain,key,max){
 keyValid(key);const text=JSON.stringify(value);if(bytes(text)>max)fail();
 const payload=encode(text);return {payload,signature:mac(key,domain+'\n'+payload)};
}
function requestValid(request,scope,now){
 validateSummaryScope(scope,now);
 if(!exact(request,['version','audience','sourceScriptId','windowId','nonce','seasonId','issuedAt','expiresAt'])||request.version!==1||request.audience!==scope.projectRef||request.sourceScriptId!==scope.sourceScriptId||request.windowId!==scope.windowId||!identifier(request.seasonId)||typeof request.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(request.nonce)||!Number.isSafeInteger(request.issuedAt)||!Number.isSafeInteger(request.expiresAt)||request.issuedAt>now+5000||request.issuedAt<scope.startsAt||request.expiresAt<=now||request.expiresAt>scope.expiresAt||request.expiresAt<=request.issuedAt||request.expiresAt-request.issuedAt>30000)fail();
 return request;
}
function signSummaryRequest({scope,key,seasonId,nonce,now}){
 validateSummaryScope(scope,now);
 const request=requestValid({version:1,audience:scope.projectRef,sourceScriptId:scope.sourceScriptId,windowId:scope.windowId,nonce,seasonId,issuedAt:now,expiresAt:Math.min(now+30000,scope.expiresAt)},scope,now);
 return {request,envelope:sign(request,'ucbac-summary-request-v1',key,2048)};
}
function verifySummaryResponse({envelope,request,scope,key,now}){
 requestValid(request,scope,now);
 const proof=unpack(envelope,'ucbac-summary-response-v1',key,24576);
 if(!exact(proof,['version','audience','sourceScriptId','windowId','nonce','seasonId','issuedAt','expiresAt','edition'])||['version','audience','sourceScriptId','windowId','nonce','seasonId','expiresAt'].some(k=>proof[k]!==request[k])||!Number.isSafeInteger(proof.issuedAt)||proof.issuedAt<request.issuedAt-5000||proof.issuedAt>now+5000||proof.issuedAt>=proof.expiresAt)fail();
 return projectDailySummary(proof.edition,request.seasonId);
}

// Read four named properties per attempt, never enumerate Script Properties.
// Immutable tokenized editions plus a repeated publication pointer prevent a
// Players/Teams pair from straddling publication. At most one race retry.
function readPublishedSummary({readProperty,currentSeason,seasonId}){
 const prefix='UCBAC_DAILY_V1_';
 const parse=(text,max)=>{if(typeof text!=='string'||bytes(text)>max)fail();return JSON.parse(text);};
 for(let attempt=0;attempt<2;attempt++){
  const season=currentSeason();if(!identifier(season))fail();
  const raw=readProperty(prefix+'PUBLISHED');
  if(raw===null||season!==seasonId)return null;
  const manifest=parse(raw,8192);
  if(!manifest||manifest.schema!==1||manifest.seasonId!==season||typeof manifest.token!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(manifest.token))fail();
  const editions={};
  for(const kind of ['players','teams']){
   const saved=parse(readProperty(prefix+manifest.token+'_'+kind),8200);
   if(!saved||saved.token!==manifest.token||!saved.edition)fail();
   editions[kind]=saved.edition;
  }
  if(readProperty(prefix+'PUBLISHED')!==raw||currentSeason()!==season)continue;
  return projectDailySummary({...manifest,editions},seasonId);
 }
 fail();
}

// Synchronous Apps Script compatible function. Only signed, scoped callers can
// read the stored pair. The app server separately verifies each adult account.
function createSummarySource({getScope,getKey,sourceScriptId,readProperty,currentSeason,now=Date.now}){
 if(![getScope,getKey,readProperty,currentSeason,now].every(f=>typeof f==='function'))fail();
 return envelope=>{
  const scope=validateSummaryScope(getScope(),now()),key=getKey();
  if(scope.sourceScriptId!==sourceScriptId)fail();
  const request=requestValid(unpack(envelope,'ucbac-summary-request-v1',key,2048),scope,now());
  const edition=readPublishedSummary({readProperty,currentSeason,seasonId:request.seasonId});
  const latest=validateSummaryScope(getScope(),now());
  if(Object.keys(scope).some(k=>scope[k]!==latest[k])||getKey()!==key)fail();
  requestValid(request,scope,now());
  return sign({...request,issuedAt:now(),edition},'ucbac-summary-response-v1',key,24576);
 };
}

return Object.freeze({createSummarySource,readPublishedSummary});
})();
