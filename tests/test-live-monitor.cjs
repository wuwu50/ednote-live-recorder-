const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {LiveDetector,probeLivePage} = require('../extension/live-detector.js');
const id = '5f0c0b43000000000101fb9c';
const profile = `https://www.xiaohongshu.com/user/profile/${id}`;
const room = `https://www.xiaohongshu.com/livestream/test/123?host_id=${id}`;
assert(LiveDetector.belongs(profile,id));
assert(LiveDetector.belongs(room,id));
for (const url of [`https://evil.test/user/profile/${id}`,`https://www.xiaohongshu.com/livestream/test/123?host_id=other`,`http://www.xiaohongshu.com/user/profile/${id}`]) assert(!LiveDetector.belongs(url,id));
assert.equal(LiveDetector.decision({kind:'ended'}).action,'wait');
assert.equal(LiveDetector.decision({kind:'ended'},{endedCount:1}).action,'ended');
assert.equal(LiveDetector.decision({kind:'unknown'},{endedCount:1}).endedCount,0);
function probe(url,text,links=[],videos=[]) {
  return vm.runInNewContext(`(${probeLivePage})('${id}')`,{URL,location:{href:url},document:{title:'主播',body:{innerText:text},querySelectorAll:s=>s==='video'?videos:s==='a[href]'?links:[]}});
}
assert.equal(probe(room,'直播已结束',[],[{paused:false,ended:false,readyState:4,videoWidth:100}]).kind,'ended','ended message wins over leftover player');
assert.equal(probe(room,'',[],[{paused:false,ended:false,readyState:4,videoWidth:100}]).kind,'playing');
assert.equal(probe(room,'缓冲中').kind,'room-pending','buffering is never offline');
assert.equal(probe(room,'安全验证').kind,'blocked');
assert.equal(probe(profile,'',[{href:room,innerText:'歷史直播',getAttribute(){}}]).kind,'unknown','old room link alone is insufficient');
assert.equal(probe(profile,'',[{href:room,innerText:'正在直播',getAttribute(){}}]).kind,'live-link');
assert.equal(probe(profile,'',[{href:room.replace(id,'other'),innerText:'直播中',getAttribute(){}}]).kind,'unknown');
console.log('PASS: hostname/owner validation, explicit live link, ended precedence, buffering and verification guards.');

(async()=>{
  const stored = {}; const actions = []; let sample = {kind:'unknown'};
  let state = {phase:'idle',armed:false,jobs:[]};
  const tab = {id:7,url:profile,status:'complete'}; let opened = null;
  let scheduled = 0, missingFolder = false;
  const ctx = vm.createContext({URL,Date,Promise,setTimeout(){scheduled++;},LiveDetector,probeLivePage,clickProfileLiveEntry(){},contexts:async()=>[{}],ensureOffscreen:async()=>{},
    offscreen:async(type,extra={})=>{
      actions.push(type);
      if(type==='arm-preflight' && missingFolder) throw Error('請先選擇儲存資料夾');
      if(type==='arm-capture') state={...state,armed:true,armedTabId:extra.tabId};
      if(type==='disarm-capture') state={...state,phase:'idle',armed:false};
      if(type==='start') {assert(extra.useArmed); state.phase='recording';state.tabId=extra.tabId;}
      if(type==='stop') state.phase='idle';
      return {...state};
    },chrome:{storage:{session:{get:async key=>({[key]:stored[key]}),set:async v=>Object.assign(stored,v)}},
      tabs:{get:async id=>id===7?tab:opened,remove:async id=>{actions.push('remove-'+id)},update:async(_,v)=>{Object.assign(tab,v)},reload:async()=>{actions.push('reload')}},
      tabCapture:{getMediaStreamId:async()=>{actions.push('capture-grant');return 'one-use'}},
      alarms:{create:async()=>{},clear:async()=>{}},scripting:{executeScript:async options=>[{result:options.func.name === 'clickProfileLiveEntry' ? true : sample}]}}});
  vm.runInContext(fs.readFileSync('extension/live-status.js','utf8'),ctx);
  vm.runInContext(fs.readFileSync('extension/live-monitor.js','utf8'),ctx);
  const call=(s)=>vm.runInContext(s,ctx);
  await call(`armLive({hostId:'${id}',tabId:7})`);
  assert.equal(scheduled,1,'successful arming schedules an immediate check');
  assert(actions.indexOf('arm-preflight') < actions.indexOf('capture-grant'),'folder permission checked before acquiring capture');
  sample={kind:'live-link',url:room}; await call('checkLive()'); assert.equal(tab.url,room);
  sample={kind:'playing'}; await Promise.all([call('checkLive()'),call('checkLive()')]);
  assert.equal(actions.filter(a=>a==='start').length,1,'concurrent checks cannot start duplicate recordings');
  sample={kind:'unknown'}; await call('checkLive()'); assert.equal(state.phase,'recording');
  sample={kind:'ended'}; await call('checkLive()'); assert.equal(state.phase,'recording');
  await call('checkLive()'); assert.equal(state.phase,'idle'); assert.equal(state.armed,true,'end saves without releasing standby capture');
  assert.equal(tab.url,profile); assert.equal(actions.filter(a=>a==='capture-grant').length,1);
  sample={kind:'live-link',url:room}; await call('checkLive()'); sample={kind:'playing'}; await call('checkLive()');
  assert.equal(actions.filter(a=>a==='start').length,2,'next broadcast reuses standby capture');
  await call('disarmLive()'); assert.equal(state.armed,false); assert.equal(stored.liveMonitor.enabled,false);
  tab.url=profile; await call(`armLive({hostId:'${id}',tabId:7})`);
  sample={kind:'wrong-page'}; await call('checkLive()');
  assert.equal(state.armed,false,'leaving the selected broadcaster releases capture');
  assert.equal(stored.liveMonitor.enabled,false);
  const grants = actions.filter(a=>a==='capture-grant').length;
  tab.url=profile;missingFolder=true;
  await assert.rejects(call(`armLive({hostId:'${id}',tabId:7})`),/儲存資料夾/);
  assert.equal(actions.filter(a=>a==='capture-grant').length,grants,'missing folder must not acquire a capture grant');
  assert.equal(state.armed,false);
  missingFolder=false;sample={kind:'profile-pending',retryAfterMs:5200};
  await call(`armLive({hostId:'${id}',tabId:7})`);const beforeRetry=scheduled;await call('checkLive()');assert.equal(scheduled,beforeRetry+1,'complete profile receives a delayed second check');
  sample={kind:'live-indicator',entryToken:'123-test'};await call('checkLive()');assert(stored.liveMonitor.followingProfileEntry);
  tab.url=room.replace(`?host_id=${id}`,'');sample={kind:'playing'};await call('checkLive()');
  assert.equal(stored.liveMonitor.knownRoom,tab.url,'a room navigated from the verified profile entry can omit host_id');
  assert.equal(state.phase,'recording');
  await call('disarmLive()');tab.url=profile;sample={kind:'unknown'};
  await call(`armLive({hostId:'${id}',tabId:7})`);
  stored.liveMonitor.followingProfileEntry=Date.now();
  opened={id:8,openerTabId:999,url:room};await call('adoptOpenedLiveTab(8)');assert.equal(tab.url,profile,'unrelated new tab is ignored');
  opened={id:8,openerTabId:7,url:room.replace(id,'other')};await call('adoptOpenedLiveTab(8)');assert.equal(tab.url,profile,'other host is ignored');
  opened={id:8,openerTabId:7,url:room,active:true};await call('adoptOpenedLiveTab(8)');
  assert.equal(tab.url,room);assert(actions.includes('remove-8'),'only related adopted room tab is closed');
  sample={kind:'playing',ownerProof:'fixture host link'};await call('checkLive()');
  assert.equal(stored.liveMonitor.recordingCheck.tabId,7);assert.equal(state.tabId,7,'recording remains bound to original capture tab');
  sample={kind:'wrong-host'};await call('checkLive()');assert.equal(state.armed,false);assert.equal(stored.liveMonitor.enabled,false);
  console.log('PASS: one capture grant, serialized checks, auto start/stop/return, second broadcast, explicit disarm.');
})().catch(e=>{console.error(e);process.exitCode=1});
