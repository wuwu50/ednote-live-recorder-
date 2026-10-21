const assert=require('node:assert/strict');const {setup}=require('./test-recorder.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,predicate){for(let i=0;i<250;i++){const s=(await test.command('status')).data;if(predicate(s))return s;await delay(5)}throw Error('manager state timeout: '+JSON.stringify((await test.command('status')).data))}
(async()=>{
 const releases=[];const folder={};const t=setup({manager:true,folder,saveGate:()=>new Promise(r=>releases.push(r))});
 assert((await t.command('start',{streamId:'one',title:'first'})).ok);t.emit(new Blob(['-ONE-']));await t.command('stop');await wait(t,s=>s.phase==='idle'&&s.jobs.length===1&&releases.length===1);
 const firstJob=(await t.command('status')).data.jobs[0].id;
 assert((await t.command('start',{streamId:'two',title:'second'})).ok,'new capture must start before first save finishes');t.emit(new Blob(['-TWO-']));await t.command('stop');await wait(t,s=>s.phase==='idle'&&s.jobs.length===2);
 assert((await t.command('start',{streamId:'three',title:'third'})).ok);assert(!(await t.command('start',{streamId:'concurrent'})).ok);
 assert.equal(t.messages.filter(m=>m.type==='restore-audio').length,2);
 releases[0]();await wait(t,s=>s.phase==='recording'&&s.jobs.length===1&&releases.length===2);assert(t.streams[2].getTracks().every(track=>track.readyState==='live'),'old save must never stop new tracks');
 assert.equal(t.messages.filter(m=>m.type==='restore-audio').length,2,'old export must not restore or change new capture audio');
 releases[1]();await wait(t,s=>s.jobs.length===0&&s.phase==='recording');assert.equal(folder.saved[0].bytes,'first-ONE-last');assert.equal(folder.saved[1].bytes,'first-TWO-last');assert(![...t.files.keys()].some(key=>key.includes(firstJob)),'completed session owns and deletes only its directory');
 await t.command('stop');await wait(t,s=>releases.length===3&&s.phase==='idle');releases[2]();await wait(t,s=>s.jobs.length===0);
 console.log('PASS: new capture during background save, serial queue, isolated bytes, no cross-session track/audio cleanup, unique session directories.');
 const stuck=setup({manager:true,folder:{},saveGate:()=>new Promise(()=>{})});await stuck.command('start',{streamId:'recovery1'});await stuck.command('stop');await wait(stuck,s=>s.phase==='idle'&&s.jobs.length===1);
 await stuck.command('start',{streamId:'recovery2'});await stuck.command('stop');await wait(stuck,s=>s.phase==='idle'&&s.jobs.length===2);
 const recoveredFolder={};const recovered=setup({manager:true,folder:recoveredFolder,files:stuck.files});const recoveredState=await wait(recovered,s=>s.jobs.length===2);assert(recoveredState.jobs.every(job=>job.phase==='ready'));
 await recovered.command('start',{streamId:'after-crash'});const id=recoveredState.jobs[0].id;await recovered.command('download',{jobId:id});await wait(recovered,s=>s.jobs.length===1);assert(recovered.streams[0].getTracks().every(track=>track.readyState==='live'));assert.equal(recoveredFolder.saved.length,1);
 const other=(await recovered.command('status')).data.jobs[0];await recovered.command('discard',{jobId:other.id});assert.equal((await recovered.command('status')).data.jobs.length,0);assert(recovered.streams[0].getTracks().every(track=>track.readyState==='live'));
 console.log('PASS: crash recovers multiple journals; per-job retry and discard preserve concurrent capture and other recordings.');
 const browserDownload=setup({manager:true});await browserDownload.command('start',{streamId:'download1'});await browserDownload.command('stop');await wait(browserDownload,s=>s.jobs.some(j=>j.phase==='downloading'));
 await browserDownload.command('start',{streamId:'download2'});await browserDownload.command('stop');await wait(browserDownload,s=>s.jobs.length===2);await browserDownload.command('download-ended',{complete:true});await wait(browserDownload,s=>s.jobs.length===1&&s.jobs[0].phase==='downloading');
 await browserDownload.command('start',{streamId:'download3'});await browserDownload.command('download-ended',{complete:true});await wait(browserDownload,s=>s.jobs.length===0&&s.phase==='recording');assert(browserDownload.streams[2].getTracks().every(t=>t.readyState==='live'));
 console.log('PASS: browser-download fallback waits for completion, serializes jobs and routes old completion away from current capture.');
 const old=setup();await old.command('start',{streamId:'old-version'});await old.command('stop');await wait(old,s=>s.phase==='downloading');const upgraded=setup({manager:true,files:old.files});await wait(upgraded,s=>s.jobs.some(j=>j.id==='legacy'));
 await upgraded.command('start',{streamId:'new-version'});await upgraded.command('discard',{jobId:'legacy'});assert((await upgraded.command('status')).data.phase==='recording');assert([...upgraded.files.keys()].some(k=>k.startsWith('recording-sessions/')&&k.endsWith('metadata.json')));
 console.log('PASS: legacy unsaved recording recovered on upgrade; discarding it does not touch new capture.');
 const limited=setup({folder:{},quota:512*1048576,usedSpace:232*1048576});assert((await limited.command('start',{streamId:'quota'})).ok);for(let i=1;i<=4;i++){limited.emit(new Blob([new Uint8Array(8*1048576)]));await wait(limited,s=>s.bytes>=i*8*1048576);assert.equal((await limited.command('status')).data.phase,'recording')}
 await limited.command('stop');await wait(limited,s=>s.phase==='idle');
 console.log('PASS: recording does not reserve an unnecessary full-film copy; direct-folder save works without OPFS assembly headroom.');
 const failureFolder={fail:true};const failed=setup({manager:true,folder:failureFolder});await failed.command('start',{streamId:'disk'});await failed.command('stop');const failure=await wait(failed,s=>s.jobs.some(job=>job.phase==='ready'&&job.error.includes('destination full')));assert([...failed.files.keys()].some(k=>k.endsWith('metadata.json')));
 await failed.command('start',{streamId:'new-after-failed-save'});failureFolder.fail=false;await failed.command('download',{jobId:failure.jobs[0].id});await wait(failed,s=>s.jobs.length===0&&s.phase==='recording');
 console.log('PASS: disk-write failure retains old recording, allows next capture and retries the selected job safely.');
})().catch(e=>{console.error(e);process.exitCode=1});
