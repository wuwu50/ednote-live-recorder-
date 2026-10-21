const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 let permission='granted',active=true,requested=0,writes=0,removed=0,full=false;
 const files=new Map([['existing.mp4','KEEP']]);
 const handle={name:'影片',queryPermission:async()=>permission,
  requestPermission:async()=>{assert(active,'permission must be requested from the UI click');requested++;permission='granted';return permission},
  isSameEntry:async other=>other===handle,
  getFileHandle:async(name,options={})=>{
   if(!options.create && !files.has(name))throw Object.assign(Error('missing'),{name:'NotFoundError'});
   if(options.create)files.set(name,'');
   return {createWritable:async()=>({write:async()=>{if(full)throw Error('disk full');writes++},close:async()=>{},abort:async()=>{}})};
  },removeEntry:async name=>{assert(name.startsWith('.rednote-write-check-'));files.delete(name);removed++}};
 const ctx=vm.createContext({crypto:require('node:crypto').webcrypto,Uint8Array,console});
 vm.runInContext(fs.readFileSync('extension/output-folder.js','utf8'),ctx);ctx.handle=handle;
 vm.runInContext('OutputFolder.stored=async()=>handle',ctx);
 const run=s=>vm.runInContext(s,ctx);
 assert.equal((await run('OutputFolder.status()')).ready,false,'remembered/granted is not yet verified by the recorder');
 await run('OutputFolder.verify()');assert.equal((await run('OutputFolder.status()')).ready,true);assert.equal(writes,1);assert.equal(removed,1);assert.equal(files.size,1);assert.equal(files.get('existing.mp4'),'KEEP');
 permission='prompt';assert.equal((await run('OutputFolder.status()')).ready,false);await assert.rejects(run('OutputFolder.verify()'),/允許存取/);
 const grant=run('OutputFolder.authorized(handle,true)');active=false;await grant;assert.equal(requested,1);
 await run('OutputFolder.verify()');assert.equal((await run('OutputFolder.status()')).ready,true);
 full=true;await assert.rejects(run('OutputFolder.verify()'),/disk full/);assert.equal((await run('OutputFolder.status()')).ready,false);assert.equal(files.size,1);
 console.log('PASS: direct permission request, background readiness needs actual write check, revoked grants/disk failures block readiness, probe cleanup preserves recordings.');
})().catch(e=>{console.error(e);process.exitCode=1});
