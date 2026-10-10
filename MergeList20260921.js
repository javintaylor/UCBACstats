/** One-time, owner-requested player merge. No website deployment is required.
 * Exact pairs come from Merge-list-v1.tsv. Preview, backup, lock, audit, rebuild.
 * This file sends no mail and changes no account roles, policy records or stats.
 */
function mergeList20260921Preview() { return ml21Preview_(); }
function mergeList20260921Apply() { return ml21Apply_(); }
function mergeList20260921Rebuild() { return ml21Finish_(); }

function ml21Config_() {
  return {
    key: 'MERGE_LIST_20260921_V1',
    db: 'CONFIGURE_PRIVATE_RESOURCE_ID',
    owner: 'contact@example.invalid',
    pairs: [] /* private dataset removed */,
    held: [] /* private dataset removed */,
    sourceHash: 'e1fe781b2bdd2161bb12d180cfb6710e12fec2b3f0788f11364a296c754db013'
  };
}
function ml21Assert_(ok, message) { if (!ok) throw new Error(message); }
function ml21Text_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function ml21Blank_(v) { return v === null || v === undefined || v === ''; }
function ml21Owner_() {
  const c = ml21Config_();
  ml21Assert_(Session.getEffectiveUser().getEmail().toLowerCase() === c.owner, 'Owner execution required.');
  ml21Assert_(CONFIG.DB_ID === c.db && db_().getId() === c.db, 'Wrong database.');
  return c;
}
function ml21Read_() {
  const out = {};
  ['Players','PlayerSeasons','PlayerGameStats','Accounts','Awards','StatCorrections','AuditLog'].forEach(function(name) {
    const sh = db_().getSheetByName(name);
    ml21Assert_(!!sh, 'Missing source table: ' + name);
    const range = sh.getDataRange(), data = range.getValues(), headers = data[0].map(ml21Text_);
    ml21Assert_(!range.getFormulas().some(function(r) { return r.some(Boolean); }), 'Source formulas require review: ' + name);
    out[name] = {headers:headers, rows:data.slice(1).map(function(v,i) {
      const row = {__row:i+2}; headers.forEach(function(h,j) { row[h] = v[j]; }); return row;
    })};
  });
  return out;
}
function ml21Fingerprint_(tables, pairs) {
  const input = {pairs:pairs, tables:{}};
  Object.keys(tables).filter(function(n) { return n !== 'AuditLog'; }).sort().forEach(function(n) {
    input.tables[n] = tables[n].rows.map(function(row) {
      const copy = Object.assign({},row);
      if(n === 'Accounts') delete copy.LastSeenAt;
      return copy;
    });
  });
  return authHash_(JSON.stringify(input));
}

/** Pure planner: keeper values win; blanks and earlier first-seen season carry over.
 * Only requested identities are combined. Every raw stat cell except PlayerID stays intact.
 */
function ml21Plan_(tables, pairs) {
  const remap = {}, groups = {}, playerById = {}, before = {}, after = {};
  const wanted = {};
  pairs.forEach(function(p) { wanted[p.absorb] = true; wanted[p.keep] = true; });
  Object.keys(tables).forEach(function(n) {
    before[n] = tables[n].rows;
    after[n] = before[n].map(function(r) { return Object.assign({},r); });
  });
  after.Players.forEach(function(p) {
    const id = ml21Text_(p.PlayerID); if(!wanted[id]) return;
    ml21Assert_(!playerById[id], 'Duplicate Players identity: ' + id); playerById[id] = p;
  });
  pairs.forEach(function(p) {
    ml21Assert_(p.absorb !== p.keep && !remap[p.absorb], 'Duplicate/cyclic merge source.');
    ml21Assert_(playerById[p.absorb] && playerById[p.keep], 'Missing player: '+p.absorb+' -> '+p.keep);
    remap[p.absorb] = p.keep; (groups[p.keep] = groups[p.keep] || []).push(p.absorb);
  });
  Object.keys(remap).forEach(function(id) { ml21Assert_(!remap[remap[id]], 'Chained merges are not supported.'); });
  const conflicts = [], carried = [], moved = {}, seatRemap = {}, seatDropped = [];
  Object.keys(groups).forEach(function(keep) {
    const ids = [keep].concat(groups[keep]);
    const accountEmails = {};
    before.Accounts.forEach(function(a) { if(ids.indexOf(ml21Text_(a.PlayerID)) >= 0) accountEmails[ml21Text_(a.Email).toLowerCase()] = true; });
    ml21Assert_(Object.keys(accountEmails).filter(Boolean).length <= 1, 'Multiple accounts would share '+keep);
    const birthDates = {};
    ids.forEach(function(id) { const v = playerById[id].BirthDate; if(!ml21Blank_(v)) birthDates[JSON.stringify(v)] = true; });
    ml21Assert_(Object.keys(birthDates).length <= 1, 'Birth dates disagree for '+keep);
    groups[keep].forEach(function(absorb) {
      const a = playerById[absorb], k = playerById[keep];
      tables.Players.headers.forEach(function(field) {
        if(field === 'PlayerID') return;
        if(ml21Blank_(k[field]) && !ml21Blank_(a[field])) {
          k[field] = a[field]; carried.push({player:keep,from:absorb,field:field});
        } else if(field === 'FirstSeenSeason' && /^SEA-\d{4}$/.test(ml21Text_(a[field])) &&
                  /^SEA-\d{4}$/.test(ml21Text_(k[field])) && a[field] < k[field]) {
          k[field] = a[field];
        } else if(!ml21Blank_(a[field]) && !ml21Blank_(k[field]) && JSON.stringify(a[field]) !== JSON.stringify(k[field])) {
          conflicts.push({table:'Players',keep:keep,absorb:absorb,field:field});
        }
      });
    });
  });
  ['PlayerGameStats','PlayerSeasons','Accounts','Awards','StatCorrections'].forEach(function(name) {
    const fields = name === 'Accounts' ? ['PlayerID','RequestedPlayerID'] : ['PlayerID'];
    fields.forEach(function(field) {
      ml21Assert_(tables[name].headers.indexOf(field) >= 0, 'Missing '+name+'.'+field);
      let count = 0;
      after[name].forEach(function(r) { const to = remap[ml21Text_(r[field])]; if(to) { r[field] = to; count++; } });
      moved[name+'.'+field] = count;
    });
  });
  const seatGroups = {};
  after.PlayerSeasons.forEach(function(s) {
    if(!groups[ml21Text_(s.PlayerID)]) return;
    const key = ml21Text_(s.PlayerID)+'|'+ml21Text_(s.SeasonID);
    (seatGroups[key] = seatGroups[key] || []).push(s);
  });
  Object.keys(seatGroups).forEach(function(key) {
    const seats = seatGroups[key];
    if(seats.length < 2 || !seats.some(function(s) { return remap[ml21Text_(before.PlayerSeasons[s.__row-2].PlayerID)]; })) return;
    function originalKeeper(s) { return ml21Text_(before.PlayerSeasons[s.__row-2].PlayerID) === ml21Text_(s.PlayerID); }
    function size(s) { return tables.PlayerSeasons.headers.filter(function(h) { return !ml21Blank_(s[h]); }).length; }
    seats.sort(function(a,b) { return Number(originalKeeper(b))-Number(originalKeeper(a)) || size(b)-size(a) || a.__row-b.__row; });
    const keeper = seats[0];
    seats.slice(1).forEach(function(s) {
      tables.PlayerSeasons.headers.forEach(function(field) {
        if(field === 'PlayerSeasonID' || field === 'PlayerID') return;
        if(ml21Blank_(keeper[field]) && !ml21Blank_(s[field])) keeper[field] = s[field];
        else if(!ml21Blank_(s[field]) && !ml21Blank_(keeper[field]) && JSON.stringify(s[field]) !== JSON.stringify(keeper[field]))
          conflicts.push({table:'PlayerSeasons',keep:keeper.PlayerID,season:keeper.SeasonID,field:field});
      });
      if(ml21Text_(s.PlayerSeasonID) && ml21Text_(s.PlayerSeasonID) !== ml21Text_(keeper.PlayerSeasonID)) {
        ml21Assert_(ml21Text_(keeper.PlayerSeasonID), 'Surviving season row needs an ID.');
        seatRemap[ml21Text_(s.PlayerSeasonID)] = keeper.PlayerSeasonID;
      }
      seatDropped.push(s.__row);
    });
  });
  let auditMoved = 0;
  after.AuditLog.forEach(function(row) {
    const id = ml21Text_(row.EntityID), type = ml21Text_(row.EntityType);
    const to = type === 'Player' ? remap[id] : type === 'PlayerSeason' ? seatRemap[id] : null;
    if(to) { row.EntityID = to; auditMoved++; }
  });
  moved['AuditLog.EntityID'] = auditMoved;
  const deletes = {
    Players:before.Players.filter(function(p) { return remap[ml21Text_(p.PlayerID)]; }).map(function(p) { return p.__row; }),
    PlayerSeasons:seatDropped
  };
  const changes = {};
  Object.keys(tables).forEach(function(name) {
    changes[name] = [];
    after[name].forEach(function(row,i) {
      if((deletes[name] || []).indexOf(row.__row) >= 0) return;
      tables[name].headers.forEach(function(field,c) {
        if(JSON.stringify(row[field]) !== JSON.stringify(before[name][i][field]))
          changes[name].push({row:row.__row,col:c+1,field:field,value:row[field]});
      });
    });
  });
  return {remap:remap,seatRemap:seatRemap,changes:changes,deletes:deletes,after:after,
    summary:{pairs:pairs.length,keepers:Object.keys(groups).length,moved:moved,
      profilesRemoved:deletes.Players.length,seasonsConsolidated:seatDropped.length,
      rawStatRows:before.PlayerGameStats.length,fieldsCarried:carried.length,keeperConflictsPreserved:conflicts.length},
    conflicts:conflicts};
}
function ml21Preview_() {
  const c = ml21Owner_(), tables = ml21Read_(), plan = ml21Plan_(tables,c.pairs);
  const hash = ml21Fingerprint_(tables,c.pairs);
  PropertiesService.getScriptProperties().setProperty(c.key+'_PREVIEW',JSON.stringify({hash:hash,at:Date.now()}));
  const result = {status:'PREVIEW_NO_DATABASE_WRITES',sourceHash:c.sourceHash,hash:hash,summary:plan.summary,held:c.held};
  Logger.log(JSON.stringify(result)); return result;
}
function ml21WriteChanges_(tables, plan) {
  Object.keys(plan.changes).forEach(function(name) {
    const sh = db_().getSheetByName(name), cells = plan.changes[name], byCol = {};
    cells.forEach(function(c) { (byCol[c.col] = byCol[c.col] || []).push(c); });
    Object.keys(byCol).forEach(function(col) {
      const list = byCol[col].sort(function(a,b) { return a.row-b.row; });
      let start = 0;
      while(start < list.length) {
        let end = start+1;
        while(end < list.length && list[end].row === list[end-1].row+1) end++;
        sh.getRange(list[start].row,Number(col),end-start,1).setValues(list.slice(start,end).map(function(c) { return [c.value]; }));
        start = end;
      }
    });
  });
  Object.keys(plan.deletes).forEach(function(name) {
    const rows = plan.deletes[name].slice().sort(function(a,b) { return b-a; }), sh = db_().getSheetByName(name);
    let i = 0;
    while(i < rows.length) {
      let j = i+1; while(j < rows.length && rows[j] === rows[j-1]-1) j++;
      sh.deleteRows(rows[j-1],j-i); i = j;
    }
  });
}
function ml21Apply_() {
  const c = ml21Owner_(), props = PropertiesService.getScriptProperties(), lock = LockService.getScriptLock();
  ml21Assert_(lock.tryLock(5000), 'Database busy; nothing changed.');
  let state;
  try {
    state = JSON.parse(props.getProperty(c.key+'_STATE') || 'null');
    if(state) { Logger.log(JSON.stringify(state)); ml21Assert_(state.status === 'COMPLETE', 'Previous run exists; inspect its checkpoint before retrying.'); return state; }
    const tables = ml21Read_(), plan = ml21Plan_(tables,c.pairs);
    const preview = JSON.parse(props.getProperty(c.key+'_PREVIEW') || 'null');
    ml21Assert_(preview && Date.now()-preview.at < 3600000 && preview.hash === ml21Fingerprint_(tables,c.pairs), 'Source changed or preview expired; run Preview again.');
    const folder = DriveApp.getFolderById('CONFIGURE_PRIVATE_RESOURCE_ID');
    const backup = DriveApp.getFileById(c.db).makeCopy('UCBAC_Database — before player merges — '+new Date().toISOString().replace(/[:.]/g,'-'),folder);
    backup.setDescription('Recovery snapshot before owner-requested Merge-list-v1.tsv; SHA256 '+c.sourceHash+'. Original database '+c.db+'.');
    state = {status:'WRITING',backupId:backup.getId(),backupUrl:backup.getUrl(),startedAt:new Date().toISOString(),summary:plan.summary};
    props.setProperty(c.key+'_STATE',JSON.stringify(state)); Logger.log('BACKUP '+backup.getUrl());
    ml21WriteChanges_(tables,plan); SpreadsheetApp.flush();
    __tableCache = {};
    const check = ml21Read_();
    ml21Assert_(!check.Players.rows.some(function(p) { return plan.remap[ml21Text_(p.PlayerID)]; }), 'An absorbed profile remains.');
    ['PlayerSeasons','PlayerGameStats','Accounts','Awards','StatCorrections'].forEach(function(name) {
      check[name].rows.forEach(function(row) {
        ml21Assert_(!plan.remap[ml21Text_(row.PlayerID)] && (name !== 'Accounts' || !plan.remap[ml21Text_(row.RequestedPlayerID)]), 'Unmoved reference in '+name);
      });
    });
    ml21Assert_(check.PlayerGameStats.rows.length === tables.PlayerGameStats.rows.length, 'Raw stat row count changed.');
    check.PlayerGameStats.rows.forEach(function(row,i) {
      tables.PlayerGameStats.headers.forEach(function(field) {
        const expected = field === 'PlayerID' ? (plan.remap[ml21Text_(tables.PlayerGameStats.rows[i][field])] || tables.PlayerGameStats.rows[i][field]) : tables.PlayerGameStats.rows[i][field];
        ml21Assert_(JSON.stringify(row[field]) === JSON.stringify(expected), 'Unexpected stat change at row '+row.__row+', '+field);
      });
    });
    const now = new Date();
    appendRows_('AuditLog',c.pairs.map(function(p) {
      return {AuditID:Utilities.getUuid(),Timestamp:now,UserID:c.owner,Role:'ADMIN',Action:'PLAYER_MERGE',EntityType:'Player',EntityID:p.keep,Field:'PlayerID',OldValue:p.absorb,NewValue:p.keep,RequestID:c.key,
        Notes:JSON.stringify({source:'Merge-list-v1.tsv',sourceHash:c.sourceHash,absorbName:p.absorbName,keepName:p.keepName,backupId:state.backupId,rule:'Keep designated profile values; fill blanks; preserve raw statistics and account links.'})};
    }));
    markDirty_('player-merge-list'); clearApiCache_();
    state.status = 'MERGED_REBUILD_PENDING'; props.setProperty(c.key+'_STATE',JSON.stringify(state));
    Logger.log(JSON.stringify(state));
  } catch(e) {
    if(state && state.status === 'WRITING') { state.status = 'NEEDS_REVIEW'; state.error = String(e.message || e); props.setProperty(c.key+'_STATE',JSON.stringify(state)); }
    throw e;
  } finally { lock.releaseLock(); }
  return ml21Finish_();
}
function ml21Finish_() {
  const c = ml21Owner_(), props = PropertiesService.getScriptProperties();
  const state = JSON.parse(props.getProperty(c.key+'_STATE') || 'null');
  ml21Assert_(state && ['MERGED_REBUILD_PENDING','COMPLETE'].indexOf(state.status) >= 0, 'No verified merge awaiting rebuild.');
  if(state.status === 'COMPLETE') { Logger.log(JSON.stringify(state)); return state; }
  __tableCache = {};
  const result = runRebuild_('manual');
  ml21Assert_(String(result).indexOf('skipped') < 0, 'Rebuild busy; run the Rebuild function again.');
  state.status = 'COMPLETE'; state.completedAt = new Date().toISOString(); state.rebuild = result;
  props.setProperty(c.key+'_STATE',JSON.stringify(state)); Logger.log(JSON.stringify(state)); return state;
}
