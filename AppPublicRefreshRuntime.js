// GENERATED LOCAL CANDIDATE. Never deploy without reviewing the source integration.
var UCBACPublicSource=(function(){
const PUBLIC_SHEET_CONTRACT_SHA256='71f8c8b670fd6ae4ef6e7a62bdd9b527eac663c889691875831791645e952bcc';
// Public-football-only authorization. Continuous access is a distinct, explicitly
// approved mode; a missing expiry never upgrades an existing 24-hour pilot.
const publicScopeKeys = ['spreadsheetId','contractSHA256','approvalId','startsAt','expiresAt'];
const publicScopeISO = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function publicRefreshWindowValid(scope) {
  if (!scope || !publicScopeISO(scope.startsAt)) return false;
  if (scope.mode === 'continuous') return scope.expiresAt === null;
  if (scope.mode !== undefined) return false;
  return publicScopeISO(scope.expiresAt) && Date.parse(scope.expiresAt) > Date.parse(scope.startsAt) &&
    Date.parse(scope.expiresAt) - Date.parse(scope.startsAt) <= 86400000;
}
function publicRefreshEnd(scope) {
  if (!publicRefreshWindowValid(scope)) throw Error('Invalid public refresh authorization.');
  return scope.mode === 'continuous' ? Infinity : Date.parse(scope.expiresAt);
}
function canonicalPublicRefreshScope(scope, contractSHA256) {
  const keys = scope?.mode === 'continuous' ? publicScopeKeys.concat('mode') : publicScopeKeys;
  if (!scope || Array.isArray(scope) || Object.keys(scope).length !== keys.length || keys.some(k => !Object.hasOwn(scope,k)) ||
      typeof scope.spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(scope.spreadsheetId) ||
      scope.contractSHA256 !== contractSHA256 || typeof scope.approvalId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(scope.approvalId) ||
      !publicRefreshWindowValid(scope)) throw Error('Invalid public refresh authorization.');
  return JSON.stringify(Object.fromEntries(keys.map(k => [k,scope[k]])));
}

const state=(function(){

// Local protocol, not a live source adapter. The source must persist transitions
// under its own writer lock. An app-side copy of this state cannot certify Google.

const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const version=v=>typeof v==='string'&&/^[1-9]\d{0,30}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{12,128}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw new Error('Public rebuild evidence is unavailable.');};
const stateKeys=['schemaVersion','epoch','generation','status','attempt','seal'];
const attemptKeys=['id','epoch','startedAt','inputSHA256'];
const sealKeys=['generation','coverage','spreadsheetId','contractSHA256','contentSHA256','inputSHA256','sourceVersion','sourceModifiedAt','startedAt','completedAt'];
const proofKeys=['schemaVersion','requestId','observedAt','dirty','status','epoch','generation','sourceVersion','sourceModifiedAt','seal'];
const bundleKeys=['schemaVersion','asOf','complete','headers','lastRows','ranges','expectedRangeCount','acquiredRangeCount'];
const receiptKeys=['schemaVersion','contractSHA256','bundleSHA256','startedAt','capturedAt','sourceModifiedAt','sourceVersion','requestCount','responseBytes','rangeCount','sourceDate','matchingPasses'];

function sealShape(s){
 return exact(s,sealKeys)&&Number.isSafeInteger(s.generation)&&s.generation>0&&s.coverage==='all-seasons'&&id(s.spreadsheetId)&&s.contractSHA256===PUBLIC_SHEET_CONTRACT_SHA256&&
  hex(s.contentSHA256)&&hex(s.inputSHA256)&&version(s.sourceVersion)&&iso(s.sourceModifiedAt)&&iso(s.startedAt)&&iso(s.completedAt)&&
  Date.parse(s.completedAt)>=Date.parse(s.startedAt)&&Date.parse(s.completedAt)-Date.parse(s.startedAt)<=300000&&Date.parse(s.sourceModifiedAt)<=Date.parse(s.completedAt);
}
function checkState(s){
 if(!exact(s,stateKeys)||s.schemaVersion!==1||!Number.isSafeInteger(s.epoch)||s.epoch<0||!Number.isSafeInteger(s.generation)||s.generation<0||
  !['dirty','building','ready','failed'].includes(s.status))fail();
 if(s.status==='building'){
  if(!exact(s.attempt,attemptKeys)||!uuid(s.attempt.id)||s.attempt.epoch!==s.epoch||!iso(s.attempt.startedAt)||!hex(s.attempt.inputSHA256)||s.seal!==null)fail();
 }else if(s.attempt!==null)fail();
 if(s.status==='ready'){if(!sealShape(s.seal)||s.seal.generation!==s.generation)fail();}
 else if(s.seal!==null)fail();
}
function initialPublicRebuildState(){return {schemaVersion:1,epoch:0,generation:0,status:'dirty',attempt:null,seal:null};}
function invalidatePublicRebuild(state){
 checkState(state);if(state.epoch===Number.MAX_SAFE_INTEGER)fail();
 return {...state,epoch:state.epoch+1,status:'dirty',attempt:null,seal:null};
}
function beginPublicRebuild(state,{attemptId,startedAt,inputSHA256}={}){
 checkState(state);if(state.status==='building'||!uuid(attemptId)||!iso(startedAt)||!hex(inputSHA256))fail();
 // Invalidate the previous completion before any derived write begins.
 const next=invalidatePublicRebuild(state);
 return {...next,status:'building',attempt:{id:attemptId,epoch:next.epoch,startedAt,inputSHA256}};
}
function attemptMatches(state,attempt){
 checkState(state);
 if(state.status!=='building'||!exact(attempt,attemptKeys)||JSON.stringify(attempt)!==JSON.stringify(state.attempt))fail();
}
function failPublicRebuild(state,attempt){
 attemptMatches(state,attempt);return {...state,status:'failed',attempt:null,seal:null};
}
function completePublicRebuild(state,attempt,{coverage,spreadsheetId,sourceVersion,sourceModifiedAt,completedAt,inputSHA256,contentSHA256}={}){
 attemptMatches(state,attempt);
 if(inputSHA256!==attempt.inputSHA256||state.generation===Number.MAX_SAFE_INTEGER)fail();
 const seal={generation:state.generation+1,coverage,spreadsheetId,contractSHA256:PUBLIC_SHEET_CONTRACT_SHA256,contentSHA256,inputSHA256,
  sourceVersion,sourceModifiedAt,startedAt:attempt.startedAt,completedAt};
 if(!sealShape(seal))fail();
 return {...state,generation:seal.generation,status:'ready',attempt:null,seal};
}

function observePublicRebuild(state,{requestId,observedAt,dirty,sourceVersion,sourceModifiedAt}={}){
 checkState(state);
 if(!uuid(requestId)||!iso(observedAt)||typeof dirty!=='boolean'||!version(sourceVersion)||!iso(sourceModifiedAt))fail();
 return {schemaVersion:1,requestId,observedAt,dirty,status:state.status,epoch:state.epoch,generation:state.generation,sourceVersion,sourceModifiedAt,
  seal:state.seal?{...state.seal}:null};
}


return {initialPublicRebuildState,invalidatePublicRebuild,beginPublicRebuild,completePublicRebuild,failPublicRebuild,observePublicRebuild};})();
const {initialPublicRebuildState,invalidatePublicRebuild,beginPublicRebuild,completePublicRebuild,failPublicRebuild,observePublicRebuild}=state;
const producer=(function(){

// Synchronous source-owner logic; it runs inside the source project's own
// ScriptLock. Inputs stay in that process. Only the sealed public-output hash
// and counters leave it. The caller must supply an immutable input read context
// to the existing derivation functions, not let them reread mutable sheets.
const sha=value=>{const text=JSON.stringify(value);return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');};
const unavailable=()=>{throw Error('Public rebuild completion unavailable.');};
function createPublicRebuildProducer({load,save,readInputs,readPublicContent,stamp,now=Date.now,newId,locked,readEditToken}={}) {
 if(![load,save,readInputs,readPublicContent,stamp,now,newId,locked,readEditToken].every(f=>typeof f==='function'))unavailable();
 let active=null;
 const guard=()=>{if(locked()!==true)unavailable();};
 const state=()=>load()??initialPublicRebuildState();
 const invalidate=()=>{guard();save(invalidatePublicRebuild(state()));active=null;};
 return {
  begin(){
   guard();if(active)unavailable();
   // Persist invalidation before reading or writing anything. A crash cannot
   // leave the previous generation advertised as newly completed.
   save(invalidatePublicRebuild(state()));
   const editToken=readEditToken(),inputs=readInputs();
   if(readEditToken()!==editToken)unavailable();
   const building=beginPublicRebuild(state(),{attemptId:newId(),startedAt:new Date(now()).toISOString(),inputSHA256:sha(inputs)});
   save(building);active={attempt:building.attempt,inputs,editToken};
   return inputs;
  },
  complete(spreadsheetId){
   guard();if(!active)unavailable();
   const attempt=active.attempt;
   try {
    // Two source-owned output captures plus current inputs protect against
    // out-of-band sheet edits. These hashes never come from an app request.
    const before=stamp(),content=readPublicContent(),inputSHA256=sha(readInputs());
    if(sha(readPublicContent())!==sha(content)||JSON.stringify(stamp())!==JSON.stringify(before)||
       inputSHA256!==attempt.inputSHA256||readEditToken()!==active.editToken)unavailable();
    const next=completePublicRebuild(state(),attempt,{coverage:'all-seasons',spreadsheetId,
     sourceVersion:before.version,sourceModifiedAt:before.modifiedTime,completedAt:new Date(now()).toISOString(),
     inputSHA256,contentSHA256:sha(content)});
    save(next);active=null;return next.seal;
   } catch(error){this.fail();throw error;}
  },
  fail(){
   guard();if(!active)return;
   const current=state();
   if(current.status==='building'&&current.attempt?.id===active.attempt.id)save(failPublicRebuild(current,current.attempt));
   active=null;
  },
  invalidate,
  observe(requestId,{dirty=false}={}){
   guard();const current=state(),before=stamp();
   // Also check inputs on every observation. A stored Drive version or delayed
   // edit trigger is not enough to certify a formerly correct generation.
   const changed=current.status==='ready'&&sha(readInputs())!==current.seal.inputSHA256;
   const after=stamp();
   return observePublicRebuild(current,{requestId,observedAt:new Date(now()).toISOString(),
    dirty:dirty||changed||JSON.stringify(before)!==JSON.stringify(after),sourceVersion:after.version,sourceModifiedAt:after.modifiedTime});
  }
 };
}

return {createPublicRebuildProducer};})();
const channel=(function(){

const project='tbhyjxwhibhkocqvvgvg';
const requestKeys=['version','projectRef','spreadsheetId','scopeSHA256','requestId','operation','issuedAt','expiresAt'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=()=>{throw Error('Public source evidence unavailable.');};
const hash=text=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
const mac=(key,text)=>Utilities.computeHmacSha256Signature(text,key,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
function equal(a,b){if(!hex(a)||!hex(b))return false;let n=0;for(let i=0;i<64;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function publicEvidenceScopeHash(scope,now){
 const canonical=canonicalPublicRefreshScope(scope,PUBLIC_SHEET_CONTRACT_SHA256);
 if(!Number.isSafeInteger(now)||Date.parse(scope.startsAt)>now||publicRefreshEnd(scope)<=now)fail();
 return hash(canonical);
}
function validRequest(request,scope,now){
 const scopeSHA256=publicEvidenceScopeHash(scope,now);
 if(!exact(request,requestKeys)||request.version!==1||request.projectRef!==project||request.spreadsheetId!==scope.spreadsheetId||request.scopeSHA256!==scopeSHA256||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.requestId)||
    !['evidence','collection'].includes(request.operation)||!Number.isSafeInteger(request.issuedAt)||!Number.isSafeInteger(request.expiresAt)||request.issuedAt>now+5000||request.issuedAt<Date.parse(scope.startsAt)||
    request.expiresAt<=now||request.expiresAt>publicRefreshEnd(scope)||request.expiresAt<=request.issuedAt||request.expiresAt-request.issuedAt>(request.operation==='collection'?90000:30000))fail();
 return request;
}
function pack(value,key,domain,max=8192){
 if(!hex(key))fail();const payload=JSON.stringify(value);if(payload.length>max)fail();
 return {payload,signature:mac(key,domain+'\n'+payload)};
}
function unpack(envelope,key,domain,max=8192){
 if(!hex(key)||!exact(envelope,['payload','signature'])||typeof envelope.payload!=='string'||envelope.payload.length>max||
    !equal(mac(key,domain+'\n'+envelope.payload),envelope.signature))fail();
 return JSON.parse(envelope.payload);
}
function signPublicEvidenceRequest({scope,key,requestId,now,operation='evidence'}){
 const request=validRequest({version:1,projectRef:project,spreadsheetId:scope.spreadsheetId,scopeSHA256:publicEvidenceScopeHash(scope,now),requestId,operation,
  issuedAt:now,expiresAt:Math.min(now+(operation==='collection'?90000:30000),publicRefreshEnd(scope))},scope,now);
 return {request,envelope:pack(request,key,'ucbac-public-evidence-request-v1')};
}
function verifyPublicEvidenceResponse({envelope,request,scope,key,now}){
 validRequest(request,scope,now);
 const response=unpack(envelope,key,'ucbac-public-evidence-response-v1',request.operation==='collection'?24*1024*1024:8192);
 if(!exact(response,['request','evidence'])||JSON.stringify(response.request)!==JSON.stringify(request))fail();
 return response.evidence; // The existing readiness verifier validates every evidence field.
}
function createPublicEvidenceSource({getScope,getKey,spreadsheetId,observe,collect,now=Date.now}){
 return envelope=>{
  const scope=getScope(),key=getKey(),scopeHash=publicEvidenceScopeHash(scope,now());
  if(scope.spreadsheetId!==spreadsheetId)fail();
  const request=validRequest(unpack(envelope,key,'ucbac-public-evidence-request-v1'),scope,now());
  const evidence=request.operation==='collection'?collect():observe(request.requestId);
  if(publicEvidenceScopeHash(getScope(),now())!==scopeHash||getKey()!==key)fail();
  validRequest(request,scope,now());
  return pack({request,evidence},key,'ucbac-public-evidence-response-v1',request.operation==='collection'?24*1024*1024:8192);
 };
}

return {createPublicEvidenceSource,publicEvidenceScopeHash};})();
return Object.freeze({...producer,...channel,contract:{
  "Seasons": [
    {
      "from": "A",
      "to": "F",
      "headers": [
        "SeasonID",
        "Year",
        "Label",
        "Status",
        "TackleConvention",
        "RegularSeasonWeeks"
      ]
    }
  ],
  "Teams": [
    {
      "from": "A",
      "to": "F",
      "headers": [
        "TeamID",
        "Slug",
        "SchoolName",
        "DisplayName",
        "Mascot",
        "County"
      ]
    },
    {
      "from": "T",
      "to": "U",
      "headers": [
        "IsConferenceMember",
        "Active"
      ]
    }
  ],
  "Players": [
    {
      "from": "A",
      "to": "B",
      "headers": [
        "PlayerID",
        "DisplayName"
      ]
    }
  ],
  "PlayerSeasons": [
    {
      "from": "B",
      "to": "F",
      "headers": [
        "PlayerID",
        "TeamID",
        "SeasonID",
        "Jersey",
        "Position"
      ]
    },
    {
      "from": "N",
      "to": "N",
      "headers": [
        "GradYear"
      ]
    },
    {
      "from": "Q",
      "to": "Q",
      "headers": [
        "Positions"
      ]
    }
  ],
  "Games": [
    {
      "from": "A",
      "to": "N",
      "headers": [
        "Phase",
        "Week",
        "HomeTeamName",
        "HomeScore",
        "AwayTeamName",
        "AwayScore",
        "GameDate",
        "GameType",
        "GameID",
        "SeasonID",
        "HomeTeamID",
        "AwayTeamID",
        "Status",
        "Venue"
      ]
    },
    {
      "from": "P",
      "to": "P",
      "headers": [
        "ForfeitBy"
      ]
    }
  ],
  "PlayerGameStats": [
    {
      "from": "A",
      "to": "I",
      "headers": [
        "player_raw",
        "PlayerID",
        "team_raw",
        "opponent_raw",
        "week",
        "GameID",
        "TeamID",
        "category",
        "grain"
      ]
    },
    {
      "from": "M",
      "to": "AT",
      "headers": [
        "PassAtt",
        "PassComp",
        "PassYds",
        "PassTD",
        "PassInt",
        "RushAtt",
        "RushYds",
        "RushTD",
        "RushFum",
        "Rec",
        "RecYds",
        "RecTD",
        "RecFum",
        "TackleSolo",
        "TackleAssist",
        "TFL",
        "Sacks",
        "Int",
        "FF",
        "FR",
        "PassDef",
        "DefTD",
        "FGM",
        "FGA",
        "XPM",
        "XPA",
        "Punts",
        "PuntYds",
        "KR",
        "KRYds",
        "PR",
        "PRYds",
        "SeasonID",
        "SourceType"
      ]
    }
  ],
  "PlayerSeasonStats": [
    {
      "from": "A",
      "to": "AS",
      "headers": [
        "PlayerSeasonStatID",
        "PlayerID",
        "SeasonID",
        "TeamID",
        "GamesPlayed",
        "SourceGrain",
        "Provisional",
        "ComputedAt",
        "PassAtt",
        "PassComp",
        "PassYds",
        "PassTD",
        "PassInt",
        "RushAtt",
        "RushYds",
        "RushTD",
        "RushFum",
        "Rec",
        "RecYds",
        "RecTD",
        "RecFum",
        "Pancakes",
        "TackleSolo",
        "TackleAssist",
        "TFL",
        "Sacks",
        "Int",
        "FF",
        "FR",
        "PassDef",
        "DefTD",
        "FGM",
        "FGA",
        "XPM",
        "XPA",
        "Punts",
        "PuntYds",
        "KR",
        "KRYds",
        "PR",
        "PRYds",
        "Blocks",
        "Rush100G",
        "Rec100G",
        "Pass200G"
      ]
    }
  ],
  "Standings": [
    {
      "from": "A",
      "to": "O",
      "headers": [
        "TeamID",
        "TeamName",
        "SeasonID",
        "W",
        "L",
        "T",
        "ConfW",
        "ConfL",
        "PF",
        "PA",
        "Diff",
        "WinPct",
        "ComputedAt",
        "Rank",
        "PrevRank"
      ]
    }
  ],
  "AllConference": [
    {
      "from": "A",
      "to": "W",
      "headers": [
        "SeasonID",
        "Position",
        "PositionLabel",
        "PositionRank",
        "PlayerID",
        "PlayerName",
        "TeamID",
        "TeamName",
        "GamesPlayed",
        "TeamConferenceGamesPlayed",
        "EligibilityStatus",
        "RawPositionScore",
        "AvailabilityMultiplier",
        "DataCompletenessMultiplier",
        "FinalPositionScore",
        "ProjectedTeam",
        "ProjectionConfidence",
        "ConfidenceLabel",
        "PoolSchools",
        "PoolSize",
        "RosterCoverage",
        "CoverageLabel",
        "SelectedPositions"
      ]
    },
    {
      "from": "Y",
      "to": "AA",
      "headers": [
        "SourceGrain",
        "FormulaVersion",
        "LastUpdated"
      ]
    }
  ]
}
,contractSHA256:PUBLIC_SHEET_CONTRACT_SHA256});
})();
