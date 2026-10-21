const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Toolbar=require('../extension/toolbar-status.js');
const now=1000000,observation=state=>({state,checkedAt:now});
assert.equal(Toolbar.resolve({},observation('offline'),{},now).text,'未');
assert.equal(Toolbar.resolve({},observation('ended'),{},now).text,'未');
assert.equal(Toolbar.resolve({},observation('live'),{},now).text,'直');
assert.equal(Toolbar.resolve({phase:'recording'},observation('live'),{},now).text,'錄');
assert.equal(Toolbar.resolve({phase:'recording'},observation('unknown'),{},now).text,'錄');
assert.equal(Toolbar.resolve({phase:'rotating',jobs:[{phase:'merging'}]},observation('offline'),{},now).text,'錄');
assert.equal(Toolbar.resolve({},null,{},now).text,'？');
assert.equal(Toolbar.resolve({},observation('live'),{},now+120001).text,'？');
assert.equal(Toolbar.resolve({jobs:[{phase:'saving'}]},observation('offline'),{},now).text,'存');
assert.equal(Toolbar.resolve({jobs:[{phase:'saving'}]},observation('live'),{},now).text,'直');
assert.equal(Toolbar.resolve({jobs:[{phase:'ready',error:'disk full'}]},observation('live'),{},now).text,'!');
assert(Toolbar.resolve({},observation('live'),{enabled:true},now).title.includes('待命已啟用'));
(async()=>{
 const stored={liveObservation:{state:'live',checkedAt:Date.now()},liveMonitor:{enabled:true}};
 let captures=true,painted=[],title,alarm;
 const context=vm.createContext({Date,Promise,chrome:{
  storage:{session:{get:async key=>({[key]:stored[key]}),set:async data=>Object.assign(stored,data)}},
  runtime:{getURL:p=>p,getContexts:async()=>captures?[{}]:[]},
  action:{setBadgeText:async s=>painted.push(s.text),setBadgeBackgroundColor:async()=>{},setTitle:async s=>{title=s.title}},
  alarms:{create:async()=>{},onAlarm:{addListener(fn){alarm=fn}}}
 }});
 vm.runInContext(fs.readFileSync('extension/toolbar-status.js','utf8'),context);
 const call=s=>vm.runInContext(s,context);
 await call('ToolbarStatus.refresh()');assert.equal(painted.at(-1),'直');
 await call("ToolbarStatus.record({phase:'recording'})");assert.equal(painted.at(-1),'錄');
 stored.liveObservation={state:'unknown',checkedAt:Date.now()};await call('ToolbarStatus.refresh()');assert.equal(painted.at(-1),'錄','observation updates must not overwrite actual recording');
 captures=false;await call('ToolbarStatus.refresh()');assert.equal(painted.at(-1),'!','lost offscreen cannot remain labeled as recording');
 captures=true;await call("ToolbarStatus.record({phase:'idle'})");assert.equal(painted.at(-1),'？');
 stored.liveObservation={state:'offline',checkedAt:Date.now()};await call('ToolbarStatus.refresh()');assert.equal(painted.at(-1),'未');
 const count=painted.length;await call('ToolbarStatus.refresh()');assert.equal(painted.length,count,'unchanged state does not repaint');
 stored.liveObservation.checkedAt=Date.now()-180000;await call('ToolbarStatus.setup()');alarm({name:'toolbar-status'});await call('ToolbarStatus.queue');assert.equal(painted.at(-1),'？');assert(title.includes('過期'));
 await Promise.all([call("ToolbarStatus.record({phase:'idle'})"),call("ToolbarStatus.record({phase:'recording'})")]);assert.equal(painted.at(-1),'錄');
 console.log('PASS: Chinese toolbar statuses, recording priority, save/error distinction, stale observations, capture loss, serialized updates and worker-restored state.');
})().catch(e=>{console.error(e);process.exitCode=1});
