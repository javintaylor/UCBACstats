/** UCBACstats conference standings policy, effective with the 2026 season.
 * Public website ordering, not an official championship or playoff-seeding rule.
 * Resolve whole tied groups: a pairwise head-to-head comparator is not transitive.
 */
const CONFERENCE_STANDINGS = { version: 'UCBAC-2026.2', firstYear: 2026 };
function conferenceStandingsApplies_(season) {
  var match = /^SEA-(\d{4})$/.exec(String(season));
  return !!match && Number(match[1]) >= CONFERENCE_STANDINGS.firstYear;
}
function conferenceStandingsFinal_(g) {
  return /^(FINAL|COMPLETE|COMPLETED|FORFEIT)$/.test(String(g.Status || '').trim().toUpperCase());
}
function conferenceStandingsRegular_(g) {
  return !/PLAYOFF|POST.?SEASON|TOURNAMENT|SCRIMMAGE|PRE.?SEASON|EXHIBITION/i.test(String(g.Phase || '') + ' ' + String(g.GameType || ''));
}
function conferenceStandingsType_(g) { return String(g.GameType || '').trim().toUpperCase().replace(/[ -]/g, '_'); }
function conferenceStandingsPct_(w, l, t) { var n = w + l + t; return n ? (w + t / 2) / n : null; }
function conferenceStandingsOpponent_(g, side, memberIds) {
  var id = String(g[side + 'TeamID'] || '').trim(), name = String(g[side + 'TeamName'] || '').trim();
  if (memberIds[id]) return '';
  // Preserve exact opponent identity. Do not fuzzy-merge North East/Northeast,
  // Kent/Kent Island, or schools in different states merely because names resemble.
  return (id || name) ? (id ? 'id:' + id : 'name:' + name.toLowerCase().replace(/\s+/g, ' ')) : '';
}
function conferenceStandingsOrder_(rows, games, teams, season, cutoff) {
  var members = {}, records = {}, played = [], reasons = {}, tied = {}, ranks = {}, position = {};
  teams.forEach(function(t) { if (String(t.IsConferenceMember).toLowerCase() !== 'false') members[String(t.TeamID).trim()] = true; });
  rows.forEach(function(r) { records[r.TeamID] = {w:0,l:0,t:0,margin:0,scored:0,decisions:0}; });
  games.forEach(function(g) {
    if (String(g.SeasonID).trim() !== season || !conferenceStandingsFinal_(g) || !conferenceStandingsRegular_(g) ||
        (cutoff !== null && standingsOrder_(g) > cutoff)) return;
    var type = conferenceStandingsType_(g);
    if (type !== 'CONFERENCE' && type !== 'NON_CONFERENCE') return;
    var h = String(g.HomeTeamID || '').trim(), a = String(g.AwayTeamID || '').trim();
    var hs = numOrNull_(g.HomeScore), as = numOrNull_(g.AwayScore), result;
    var forfeit = String(g.Status || '').trim().toUpperCase() === 'FORFEIT';
    if (forfeit && (hs === null || as === null || hs === as)) {
      var side = forfeitSide_(g, teams); if (!side) return;
      result = side === 'HOME' ? -1 : 1;
    } else {
      if (hs === null || as === null) return;
      result = hs > as ? 1 : hs < as ? -1 : 0;
    }
    var item = {h:h,a:a,result:result,conf:type === 'CONFERENCE',hs:hs,as:as,forfeit:forfeit,
      ho:conferenceStandingsOpponent_(g,'Home',members),ao:conferenceStandingsOpponent_(g,'Away',members)};
    played.push(item);
    if (!item.conf) return;
    [[h,result,hs,as],[a,-result,as,hs]].forEach(function(x) {
      var r = records[x[0]]; if (!r) return;
      r.decisions++; if (x[1] > 0) r.w++; else if (x[1] < 0) r.l++; else r.t++;
      // A forfeit decides W/L and head-to-head, never an invented scoring margin.
      if (!forfeit && x[2] !== null && x[3] !== null) {
        r.scored++; r.margin += (x[2]-x[3]);
      }
    });
  });
  function fraction(w,l,t) { return {n:2*w+t,d:2*(w+l+t)}; }
  function compare(a,b) { return a.n*b.d-b.n*a.d; }
  function split(group, values) {
    if (group.some(function(id){return !values[id] || !values[id].d;})) return [group];
    var sorted = group.slice().sort(function(a,b){return -compare(values[a],values[b]) || a.localeCompare(b);});
    var parts=[]; sorted.forEach(function(id){var last=parts[parts.length-1];if(last && compare(values[last[0]],values[id])===0)last.push(id);else parts.push([id]);});
    return parts;
  }
  function headToHead(group) {
    var totals={},pairs={}; group.forEach(function(id){totals[id]={w:0,l:0,t:0};});
    played.filter(function(g){return g.conf && totals[g.h] && totals[g.a];}).forEach(function(g){
      pairs[g.h+'|'+g.a]=pairs[g.a+'|'+g.h]=true;
      if(g.result>0){totals[g.h].w++;totals[g.a].l++;}else if(g.result<0){totals[g.a].w++;totals[g.h].l++;}else{totals[g.h].t++;totals[g.a].t++;}
    });
    var complete=group.every(function(a){return group.every(function(b){return a===b || pairs[a+'|'+b];});});
    if(complete){var vals={};group.forEach(function(id){var r=totals[id];vals[id]=fraction(r.w,r.l,r.t);});return split(group,vals);}
    // With an incomplete mini-league only an unbeaten sweep of EVERY tied rival
    // or losses to EVERY rival supplies a valid head-to-head separation.
    var top=group.filter(function(id){return group.every(function(other){return id===other || pairs[id+'|'+other];}) && totals[id].w>0 && totals[id].l===0 && totals[id].t===0;});
    var bottom=group.filter(function(id){return group.every(function(other){return id===other || pairs[id+'|'+other];}) && totals[id].l>0 && totals[id].w===0 && totals[id].t===0;});
    var middle=group.filter(function(id){return top.indexOf(id)<0 && bottom.indexOf(id)<0;});
    return [top,middle,bottom].filter(function(p){return p.length;});
  }
  function commonOpponents(group) {
    var results={};group.forEach(function(id){results[id]={};});
    played.filter(function(g){return !g.conf;}).forEach(function(g){
      [[g.h,g.ao,g.result],[g.a,g.ho,-g.result]].forEach(function(x){
        if(!results[x[0]] || !x[1])return;
        var r=results[x[0]][x[1]] || (results[x[0]][x[1]]={w:0,l:0,t:0});
        if(x[2]>0)r.w++;else if(x[2]<0)r.l++;else r.t++;
      });
    });
    var common=Object.keys(results[group[0]]).filter(function(op){return group.every(function(id){return !!results[id][op];});});
    if(!common.length)return [group];
    var values={};group.forEach(function(id){var w=0,l=0,t=0;common.forEach(function(op){var r=results[id][op];w+=r.w;l+=r.l;t+=r.t;});values[id]=fraction(w,l,t);});
    return split(group,values);
  }
  function pointMargin(group) {
    var values={};group.forEach(function(id){var r=records[id];if(r.scored)values[id]={n:r.margin,d:r.scored};});
    return split(group,values);
  }
  function resolve(group) {
    if(group.length<2)return [group];
    var criteria=[headToHead,commonOpponents,pointMargin],labels=['head-to-head','common nonconference opponents','average conference point differential'];
    for(var i=0;i<criteria.length;i++){
      var parts=criteria[i](group);
      if(parts.length>1){group.forEach(function(id){reasons[id]=labels[i];});return parts.reduce(function(all,p){return all.concat(resolve(p));},[]);}
    }
    group.forEach(function(id){reasons[id]='unresolved tie';tied[id]=true;});
    // A stable name order makes refreshes predictable without awarding a place.
    return [group.slice().sort(function(a,b){var ar=rows.filter(function(r){return r.TeamID===a;})[0],br=rows.filter(function(r){return r.TeamID===b;})[0];return String(ar.TeamName).localeCompare(String(br.TeamName)) || a.localeCompare(b);})];
  }
  var values={},known=[],unknown=[];
  rows.forEach(function(r){var id=r.TeamID,c=records[id];
    r.ConfW=c.w;r.ConfL=c.l;
    if(c.decisions){values[id]=fraction(c.w,c.l,c.t);known.push(id);}else unknown.push(id);
    reasons[id]='conference winning percentage';
  });
  var groups=split(known,values).filter(function(p){return p.length;}).reduce(function(all,g){return all.concat(resolve(g));},[]);
  if(unknown.length){unknown.forEach(function(id){reasons[id]='no completed conference games';tied[id]=unknown.length>1;});groups.push(unknown.sort());}
  var next=1;groups.forEach(function(g){g.forEach(function(id){ranks[id]=next;position[id]=Object.keys(position).length;});next+=g.length;});
  return {records:records,ranks:ranks,position:position,reasons:reasons,tied:tied};
}
/** Append the six explanatory columns without moving the existing A:O contract. */
function conferenceStandingsWrite_(all) {
  var headers=all.length?Object.keys(all[0]):null,sh=db_().getSheetByName('Standings');
  if(sh && headers && sh.getMaxColumns()<headers.length)sh.insertColumnsAfter(sh.getMaxColumns(),headers.length-sh.getMaxColumns());
  return replaceRows_('Standings',all,headers);
}
/** Run from Apps Script once after deployment; rewrites ONLY derived Standings. */
function refreshConferenceStandings() {
  var lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw new Error('Rebuild already running; retry later.');
  try {
    var run=function(){
      var all=[];rowsOf_(CONFIG.TABS.SEASONS).forEach(function(s){all=all.concat(computeStandings_(String(s.SeasonID).trim()));});
      conferenceStandingsWrite_(all);standingsPlainNumbers_();
      clearApiCache_();PropertiesService.getScriptProperties().setProperty(TRG.LAST_BUILD_KEY,new Date().toISOString());
      var result={rule:CONFERENCE_STANDINGS.version,rows:all.length,standingsOnly:true};Logger.log(JSON.stringify(result));return result;
    };
    return typeof appPublicDirectWrite_==='function'?appPublicDirectWrite_(run):run();
  } finally {lock.releaseLock();}
}
