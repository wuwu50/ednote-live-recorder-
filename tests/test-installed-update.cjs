const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const updateSource=fs.readFileSync('extension/updates.js','utf8'),source=fs.readFileSync('extension/installed-update.js','utf8');
function setup({phase='idle',jobs=[],marker={version:'1.15.0',complete:true},disk={version:'1.15.0'},pending=false,badFetch=false,statusFails=false,startDuringSave=false}={}){
 let reloads=0,opens=0,reads=0,alarm,installed;const local={},session={panelTarget:{id:42},panelWindowId:7};let version='1.14.0';const state={phase,jobs,preparing:pending};
 const context=vm.createContext({starting:false,Date,Promise,AbortSignal,URL,ensureOffscreen:async()=>{},offscreen:async()=>{if(statusFails)throw Error('unavailable');return state},
 fetch:async url=>{reads++;if(badFetch)throw Error('missing file');const value=url.startsWith('install-complete.json')?marker:disk;return {ok:!!value,text:async()=>JSON.stringify(value)}},
 chrome:{runtime:{getURL:p=>p,getManifest:()=>({version}),reload(){reloads++},onInstalled:{addListener(fn){installed=fn}}},alarms:{async create(){},onAlarm:{addListener(fn){alarm=fn}}},
 storage:{local:{async get(key){return {[key]:local[key]}},async set(obj){Object.assign(local,obj);if(startDuringSave)context.starting=true},async remove(key){delete local[key]}},session:{async get(){return session},async set(obj){Object.assign(session,obj)}}},
 windows:{async get(){return {id:7}},async create(){opens++;return {id:8}}},tabs:{async get(id){return {id,title:'same target',url:'https://example.com'}}}}
 });vm.runInContext(updateSource,context);vm.runInContext(source,context);
 return {check:()=>vm.runInContext('checkForInstalledUpdate(true)',context),restore:()=>vm.runInContext('restoreReloadPanel()',context),local,state,session,setVersion:v=>version=v,metrics:()=>({reloads,opens,reads}),marker};
}
(async()=>{
 for(const phase of ['recording','starting','rotating','saving','merging','downloading','ready']){const t=setup({phase});assert.equal(await t.check(),false);assert.equal(t.metrics().reloads,0)}
 for(const jobs of [[{phase:'queued'}],[{phase:'merging'}],[{phase:'ready',error:'save failed'}]]){const t=setup({jobs});assert.equal(await t.check(),false)}
 for(const args of [{pending:true},{marker:null},{marker:{version:'1.15.0',complete:false}},{disk:{version:'1.16.0'}},{marker:{version:'1.13.0',complete:true}},{marker:{version:'bad',complete:true}},{badFetch:true},{statusFails:true},{startDuringSave:true}]){const t=setup(args);assert.equal(await t.check(),false);assert.equal(t.metrics().reloads,0)}
 const t=setup();await Promise.all([t.check(),t.check(),t.check()]);assert.equal(t.metrics().reloads,1);assert.equal(t.local.reloadResume.tabId,42);assert.equal(t.local.reloadResume.panelOpen,true);
 await t.restore();assert.equal(t.metrics().opens,0,'do not restore until new runtime version is active');
 t.setVersion('1.15.0');await Promise.all([t.restore(),t.restore()]);assert.equal(t.metrics().opens,1);assert.equal(t.session.panelTarget.id,42);assert.equal(t.local.reloadResume,undefined);assert.equal(await t.check(),false,'same version must not create reload loop');
 const armed=setup();armed.state.armed=true;assert.equal(await armed.check(),false,'standby capture must defer automatic update reload');
 const deferred=setup({phase:'recording'});assert.equal(await deferred.check(),false);deferred.state.phase='idle';assert.equal(await deferred.check(),true);
 console.log('PASS: completed newer installer triggers one reload; captures, all pending jobs, preparing, partial install, missing state, downgrades and start races defer it; same target/control window restores once.');
})().catch(e=>{console.error(e);process.exitCode=1});
