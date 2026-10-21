const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('extension/background.js','utf8');
(async()=>{
 let listener,actionListener,created=false,creations=0,restorations=0,downloadId=0,panelCreates=0,panelFocuses=0;
 const session={};
 const local={},items=new Map(),finished=[];
 const command=(type,extra={})=>new Promise(resolve=>listener({target:'background',type,...extra},{id:'test'},resolve));
 const context=vm.createContext({
  liveStatus:async()=>({enabled:false}),importScripts(){},setupLiveMonitor(){},checkForInstalledUpdate:async()=>false,setupInstalledUpdateWatch(){},updateReloading:false,restoreCapturedAudio:async()=>{restorations++},setTimeout,Date,Promise,
  chrome:{
   runtime:{id:'test',getURL:p=>p,getManifest:()=>({version:'1.8.0'}),getContexts:async()=>created?[{}]:[],onStartup:{addListener(){}},onMessage:{addListener(fn){listener=fn}},
    async sendMessage(message){
     if(message.type==='status')return {ok:true,data:{phase:'ready',bytes:10}};
     if(message.type==='download-ended'){
      finished.push(downloadId);
      if(finished.length===1)await command('save-file',{url:'blob:2',filename:'2.mp4',saveAs:false});
      return {ok:true};
     }
     throw Error('unexpected message');
    }
   },
   offscreen:{async createDocument(){creations++;await new Promise(r=>setTimeout(r,5));created=true}},
   storage:{session:{async get(key){return {[key]:session[key]}},async set(value){Object.assign(session,value)}},local:{async get(key){return {[key]:local[key]}},async set(value){Object.assign(local,value)},async remove(key){delete local[key]}}},
   action:{onClicked:{addListener(fn){actionListener=fn}},async setTitle(){},async setBadgeText(){},async setBadgeBackgroundColor(){}},
   alarms:{async create(){},onAlarm:{addListener(){}}},
   windows:{async create(){panelCreates++;return {id:20}},async update(){panelFocuses++}},
   tabs:{async get(id){return {id,title:'target',url:'https://www.rednote.com/user/profile/test'}},onUpdated:{addListener(){}}},
   downloads:{async download(options){assert.equal(options.saveAs,false);const id=++downloadId;items.set(id,{id,state:'complete'});return id},async search({id}){return [items.get(id)]},onChanged:{addListener(){}}}
  }
 });
 vm.runInContext(fs.readFileSync('extension/toolbar-status.js','utf8'),context);
 vm.runInContext(fs.readFileSync('extension/diagnostics.js','utf8'),context);
 vm.runInContext(source,context);
 const statuses=await Promise.all([command('status'),command('status')]);
 assert(statuses.every(result=>result.ok && result.data.phase==='ready'));assert.equal(creations,1);assert.equal(restorations,1);
 await command('save-file',{url:'blob:1',filename:'1.mp4',saveAs:false});
 for(let i=0;i<100 && finished.length<2;i++)await new Promise(r=>setTimeout(r,5));
 await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(finished,[1,2],'fast second completion must not be lost while finishing first part');
 assert.equal(local.pendingDownload,undefined);
 await Promise.all(Array.from({length:45},(_,i)=>command('diagnostic',{entry:{reason:'event '+i,partNumber:2,partBytes:123,url:'private',title:'private'}})));
 const report=(await command('diagnostics')).data;
 assert.equal(report.entries.length,40);assert.equal(report.entries[0].reason,'event 5');
 assert.equal(report.entries[0].partBytes,123);assert(!JSON.stringify(report).includes('private'));
 actionListener({id:7});await new Promise(r=>setTimeout(r,10));
 actionListener({id:8});await new Promise(r=>setTimeout(r,10));
 assert.equal(panelCreates,1);assert.equal(panelFocuses,1);assert.equal(session.panelTarget.id,8,'toolbar refreshes target in the same controller');
 console.log('PASS: one offscreen recovery under parallel status calls, fast consecutive segment downloads, bounded private diagnostics.');
})().catch(error=>{console.error(error);process.exitCode=1});
