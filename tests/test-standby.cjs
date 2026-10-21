const assert = require('node:assert/strict');
const {setup} = require('./test-recorder.cjs');
// The real recorder receives a cloned stream; stopping it must not release its parent.
(async()=>{
 const noFolder=setup({manager:true});
 const missing=await noFolder.command('arm-preflight');assert(!missing.ok);assert(missing.error.includes('儲存資料夾'));
 assert.equal(noFolder.streams.length,0,'preflight never opens a media stream');
 const t=setup({manager:true,folder:{}});
 assert((await t.command('arm-preflight')).ok);
 const r=await t.command('arm-capture',{streamId:'armed',tabId:8}); assert(r.ok,r.error);
 const parent=t.streams[0];
 const cloned=[];
 parent.clone=()=>{
   const tracks=parent.getTracks().map(original=>({...original,readyState:'live',stop(){this.readyState='ended'},addEventListener(){}}));
   const stream={getTracks:()=>tracks,getVideoTracks:()=>tracks.slice(0,1),getAudioTracks:()=>tracks.slice(1)};
   cloned.push(stream);return stream;
 };
 assert(!(await t.command('start',{streamId:'manual',tabId:8})).ok,'manual capture blocked during standby');
 for(let i=0;i<2;i++){
   const start=await t.command('start',{useArmed:true,tabId:8,filenamePrefix:'小紅書-主播'});assert(start.ok,start.error);
   t.emit(new Blob(['clip']));await t.command('stop');
   for(let tries=0;tries<200;tries++){
     if((await t.command('status')).data.phase==='idle') break;
     await new Promise(r=>setTimeout(r,5));
   }
   assert(parent.getTracks().every(t=>t.readyState==='live'),'standby parent survives session cleanup');
   assert(cloned[i].getTracks().every(t=>t.readyState==='ended'),'session releases only its clone');
 }
 assert.equal(t.messages.filter(m=>m.type==='restore-audio').length,0,'session must not undo standby audio routing');
 await t.command('disarm-capture');assert(parent.getTracks().every(t=>t.readyState==='ended'));
 assert.equal(t.messages.filter(m=>m.type==='restore-audio').length,1);
 console.log('PASS: standby stream reused for two sessions, cloned tracks isolated, audio restored only on disarm.');
})().catch(e=>{console.error(e);process.exitCode=1});
