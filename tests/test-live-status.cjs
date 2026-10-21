const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {LiveDetector,probeLivePage}=require('../extension/live-detector.js');
const id='5f0c0b43000000000101fb9c',url=`https://www.xiaohongshu.com/user/profile/${id}`;
(async()=>{
 const stored={},notifications=[];let sample={kind:'playing'},permission='granted',failRead=false,captures=0;
 const ctx=vm.createContext({Date,Promise,URL,LiveDetector,probeLivePage,liveLocked:fn=>fn(),
  ensureOffscreen:()=>{captures++;throw Error('should not capture')},
  liveStatus:async()=>({enabled:false,observation:stored.liveObservation}),
  chrome:{runtime:{getURL:x=>x},notifications:{getPermissionLevel:async()=>permission,create:async(id,options)=>{notifications.push({id,...options});return id}},
   storage:{session:{get:async key=>({[key]:stored[key]}),set:async v=>Object.assign(stored,v)}},
   tabs:{get:async()=>({id:4,url,status:'complete'})},scripting:{executeScript:async()=>{if(failRead)throw Error('page read failed');return [{result:sample}]}}}});
 vm.runInContext(fs.readFileSync('extension/live-status.js','utf8'),ctx);
 const report=async(kind,extra={})=>{ctx.testSample={kind};ctx.testOptions={hostId:id,tabId:4,...extra};return vm.runInContext('reportLiveSample(testSample,testOptions)',ctx)};
 assert.equal((await report('playing')).label,'直播中');assert.equal(notifications.length,1);
 await report('playing');await report('unknown');await report('playing');assert.equal(notifications.length,1,'unknown between live samples must not duplicate notifications');
 assert.equal((await report('ended')).state,'unknown');assert.equal(notifications.length,1,'first end is pending');
 assert.equal((await report('ended',{confirmedEnd:true})).label,'直播已結束');assert.equal(notifications.length,2);
 await report('ended',{confirmedEnd:true});assert.equal(notifications.length,2);
 await report('live-link');assert.equal(notifications.length,3,'new broadcast notifies again');
 await report('offline');assert.equal(notifications.length,4);assert.equal(stored.liveObservation.state,'offline');
 const inspect=()=>vm.runInContext(`inspectLiveNow({hostId:'${id}',tabId:4})`,ctx);
 sample={kind:'playing'};let result=await inspect();assert.equal(result.observation.state,'live');assert.equal(result.enabled,false);assert.equal(captures,0);
 const before=notifications.length;await inspect();assert.equal(notifications.length,before+1,'explicit checks may repeat a notification');
 permission='denied';sample={kind:'ended'};result=await inspect();assert.equal(result.observation.state,'ended');assert(result.observation.notificationError,'blocked notification preserves the confirmed status');
 failRead=true;result=await inspect();assert.equal(result.observation.state,'unknown');assert(!result.observation.label.includes('未開播'));
 assert(notifications.every(n=>n.type==='basic'&&n.iconUrl.startsWith('data:image/png;base64,')&&n.message.includes(id)));
 const probe=text=>vm.runInNewContext(`(${probeLivePage})('${id}')`,{URL,location:{href:url},document:{body:{innerText:text},querySelectorAll:()=>[]}});
 assert.equal(probe('主播未开播').kind,'offline');assert.equal(probe('普通个人主页').kind,'unknown');
 assert.equal((await report('live-indicator')).state,'live');
 assert.equal((await report('profile-pending')).state,'unknown');
 let reads=0;ctx.setTimeout=fn=>fn();
 ctx.chrome.scripting.executeScript=async()=>[{result:++reads===1?{kind:'profile-pending',retryAfterMs:1}:{kind:'offline',detail:'依主頁畫面判讀'}}];
 result=await inspect();assert.equal(reads,2);assert.equal(result.observation.state,'offline');assert(result.observation.detail.includes('主頁'));
 console.log('PASS: explicit current live/offline/ended/unknown, deduplicated notifications, manual checks without recording, blocked notifications and read failures.');
})().catch(e=>{console.error(e);process.exitCode=1});
