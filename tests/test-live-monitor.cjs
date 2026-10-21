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
  return vm.runInNewContext(`(${probeLivePage})('${id}')`,{URL,location:{href:url},document:{title:'主播',body:{innerText:text},querySelectorAll:s=>s==='video'?videos:links}});
}
assert.equal(probe(room,'直播已结束',[],[{paused:false,ended:false,readyState:4,videoWidth:100}]).kind,'ended','ended message wins over leftover player');
assert.equal(probe(room,'',[],[{paused:false,ended:false,readyState:4,videoWidth:100}]).kind,'playing');
assert.equal(probe(room,'缓冲中').kind,'unknown','buffering is never offline');
assert.equal(probe(room,'安全验证').kind,'blocked');
assert.equal(probe(profile,'',[{href:room,innerText:'歷史直播',getAttribute(){}}]).kind,'unknown','old room link alone is insufficient');
assert.equal(probe(profile,'',[{href:room,innerText:'正在直播',getAttribute(){}}]).kind,'live-link');
assert.equal(probe(profile,'',[{href:room.replace(id,'other'),innerText:'直播中',getAttribute(){}}]).kind,'unknown');
console.log('PASS: hostname/owner validation, explicit live link, ended precedence, buffering and verification guards.');

(async()=>{
  const stored = {}; const actions = []; let sample = {kind:'unknown'};
  let state = {phase:'idle',armed:false,jobs:[]};
  const tab = {id:7,url:profile,status:'complete'};
  const ctx = vm.createContext({URL,Date,Promise,LiveDetector,probeLivePage,contexts:async()=>[{}],ensureOffscreen:async()=>{},
    offscreen:async(type,extra={})=>{
      actions.push(type);
      if(type==='arm-capture') state={...state,armed:true,armedTabId:extra.tabId};
      if(type==='disarm-capture') state={...state,phase:'idle',armed:false};
      if(type==='start') {assert(extra.useArmed); state.phase='recording';}
      if(type==='stop') state.phase='idle';
      return {...state};
    },chrome:{storage:{session:{get:async key=>({[key]:stored[key]}),set:async v=>Object.assign(stored,v)}},
      tabs:{get:async()=>tab,update:async(_,v)=>{Object.assign(tab,v)},reload:async()=>{actions.push('reload')}},
      tabCapture:{getMediaStreamId:async()=>{actions.push('capture-grant');return 'one-use'}},
      alarms:{create:async()=>{},clear:async()=>{}},scripting:{executeScript:async()=>[{result:sample}]}}});
  vm.runInContext(fs.readFileSync('extension/live-monitor.js','utf8'),ctx);
  const call=(s)=>vm.runInContext(s,ctx);
  await call(`armLive({hostId:'${id}',tabId:7})`);
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
  console.log('PASS: one capture grant, serialized checks, auto start/stop/return, second broadcast, explicit disarm.');
})().catch(e=>{console.error(e);process.exitCode=1});
