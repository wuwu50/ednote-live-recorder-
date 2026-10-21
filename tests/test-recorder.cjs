const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../extension/recording-session.js'),'utf8');
const journalSource = fs.readFileSync(path.join(__dirname,'../extension/recording-journal.js'),'utf8');
function setup({captureFails = false,saveFails = false,settingsOverride = null,tabMuted = false,mp4Supported = true,files = new Map(),slowDisk = false,quota = 1e12,assemblyFails = false,segmentLimit = null, folder = null, mergeFails = false, manager = false, saveGate = null, usedSpace = 0} = {}) {
  let listener, constraints, writes = [], closed = false, removed = 0, aborted = 0, stopped = 0, downloads = 0, speakerConnections = 0;
  const downloadRequests=[],streams=[],messages=[];
  const tracks = ['video','audio'].map(kind => ({kind,stop(){stopped++},addEventListener(name,fn){this.ended = fn}}));
  tracks[0].getSettings = () => settingsOverride || ({width:constraints?.video.mandatory.maxWidth || 1280,height:constraints?.video.mandatory.maxHeight || 720,frameRate:constraints?.video.mandatory.maxFrameRate || 30});
  const stream = {getTracks:()=>tracks,getVideoTracks:()=>[tracks[0]],getAudioTracks:()=>[tracks[1]]};
  const missing = () => Object.assign(Error('missing'),{name:'NotFoundError'});
  const directory = prefix => ({kind:'directory',
    async *entries(){const names=new Set([...files.keys()].filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length).split('/')[0]).filter(Boolean));for(const name of names){if(files.has(prefix+name+'/'))yield [name,directory(prefix+name+'/')];else yield [name,{kind:'file'}]}} ,
    async getDirectoryHandle(name,options={}) {
      const key=prefix+name+'/';
      if(!files.has(key) && !options.create)throw missing();
      files.set(key,null);return directory(key);
    },
    async getFileHandle(name,options={}) {
      const key=prefix+name;
      if(!files.has(key) && !options.create)throw missing();
      if(!files.has(key))files.set(key,new Blob());
      return {async createWritable(){
        const parts=[];
        return {async write(blob){if(key==='recording.tmp' && assemblyFails){assemblyFails=false;throw Error('disk write failed')}if(slowDisk && key.includes('part-'))await new Promise(r=>setTimeout(r,30));else await new Promise(r=>setTimeout(r,1));parts.push(blob);if(key==='recording.tmp')writes.push(blob)},
          async close(){files.set(key,new Blob(parts));if(key==='recording.tmp')closed=true},async abort(){if(key==='recording.tmp')aborted++}};
      },async getFile(){if(key==='recording.tmp')assert(closed,'download before file close');return files.get(key)}};
    },
    async removeEntry(name,options={}){
      const key=prefix+name;if(!files.has(key) && !files.has(key+'/'))throw missing();
      if(name==='recording.tmp')removed++;
      for(const item of [...files.keys()])if(item===key || (options.recursive && item.startsWith(key+'/')))files.delete(item);
    }
  });
  const root=directory('');
  class Recorder {
    static isTypeSupported(type){return mp4Supported && type.startsWith('video/mp4')}
    constructor(media,options){this.state='inactive';this.options=options;this.mimeType=options.mimeType;Recorder.instance=this}
    start(){this.state='recording';this.ondataavailable({data:new Blob(['first'])})}
    stop(){assert.equal(this.state,'recording');this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new Blob(['last'])});this.onstop()})}
  }
  const context = vm.createContext({
    chrome:{runtime:{id:'test',onMessage:{addListener(fn){listener=fn}},async sendMessage(m){messages.push(m);
      if(m.type==='prepare-audio')return {ok:true,data:{originallyMuted:tabMuted}};
      if(m.type==='save-file'){downloads++;downloadRequests.push(m);if(saveFails)return {ok:false,error:'cancelled'};return {ok:true,data:{downloadId:7}}}return {ok:true};
    }}},
    navigator:{storage:{getDirectory:async()=>root,estimate:async()=>({usage:usedSpace,quota})},mediaDevices:{async getUserMedia(c){constraints=c;if(captureFails)throw Error('denied');if(manager){const captureTracks=tracks.map(track=>({...track,readyState:'live',stop(){this.readyState='ended';stopped++}}));const capture={getTracks:()=>captureTracks,getVideoTracks:()=>[captureTracks[0]],getAudioTracks:()=>[captureTracks[1]]};streams.push(capture);return capture}return stream}}},
    MediaRecorder:Recorder,AudioContext:class{createMediaStreamSource(){return {connect(){speakerConnections++}}}destination={};async resume(){}async close(){}},
    OutputFolder:{stored:async()=>folder,verify:async()=>{if(!folder)throw Error('請先選擇儲存資料夾');if(folder.denied)throw Error('允許存取');return {ready:true}},authorized:async h=>{if(h?.denied)throw Error('允許存取');return h},save:async(dir,name,file)=>{if(saveGate)await saveGate(name);if(dir.fail)throw Error('destination full');dir.saved ||= [];let bytes;if(typeof file==='function'){const chunks=[];await file({async write(blob){chunks.push(blob)}});bytes=await new Blob(chunks).text()}else bytes=await file.text();dir.saved.push({name,bytes})}},
    Blob,MergeMp4:{async write({parts,getBlob,writable,onProgress}){if(mergeFails)throw Error('broken merge input');for(let i=0;i<parts.length;i++){await writable.write(await getBlob(parts[i]));onProgress({part:i+1,total:parts.length,progress:(i+1)/parts.length})}}},
    crypto:require('node:crypto').webcrypto,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},Date,Promise,console
  });
  vm.runInContext(journalSource,context);
  vm.runInContext(segmentLimit === null ? source : source.replace('const maxSegmentBytes = 1024 * 1048576;',`const maxSegmentBytes = ${segmentLimit};`),context);
  if(manager)vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/offscreen.js'),'utf8'),context);
  else vm.runInContext("const testSession = createRecordingSession(); chrome.runtime.onMessage.addListener((m,s,r)=>{testSession.handle(m).then(data=>r({ok:true,data}),error=>r({ok:false,error:error.message}));return true});",context);
  const command = (type,extra={}) => new Promise(resolve=>listener({target:'offscreen',type,...(type==='start'?{mergeAfterStop:false}:{}),...extra},{id:'test'},resolve));
  return {command,tracks,files,streams,messages,emit(data){Recorder.instance.ondataavailable({data})},get stats(){return {constraints,writes,closed,removed,aborted,stopped,downloads,downloadRequests,speakerConnections,encoding:Recorder.instance?.options}}};
}
async function until(test,phase) {
  for(let i=0;i<100;i++){const s=await test.command('status');if(s.data.phase===phase)return s.data;await new Promise(r=>setTimeout(r,5))}
  throw Error(`never reached ${phase}`);
}
async function runTests(){
  async function rotated(test){await test.command('start',{streamId:'merge',mergeAfterStop:true});test.emit(new Blob(['12345678']));for(let i=0;i<100;i++){const s=(await test.command('status')).data;if(s.phase==='recording'&&s.partNumber===2)return;await new Promise(r=>setTimeout(r,5))}throw Error('rotation timeout')}
  const merge=setup({segmentLimit:12});await rotated(merge);await merge.command('stop');await until(merge,'downloading');
  assert.equal(merge.stats.downloadRequests.length,1);assert(!merge.stats.downloadRequests[0].filename.includes('第001段'));assert.equal(merge.stats.downloadRequests[0].saveAs,true);
  await merge.command('download-ended',{complete:false,error:'cancelled merged download'});assert((await until(merge,'ready')).error.includes('cancelled'));assert.equal(merge.stats.removed,0);
  const resumed=setup({files:merge.files});await until(resumed,'ready');await resumed.command('download');await until(resumed,'downloading');assert.equal(resumed.stats.downloadRequests.length,1);assert(!resumed.stats.downloadRequests[0].filename.includes('第001段'));await resumed.command('download-ended',{complete:true});await until(resumed,'idle');
  const badMerge=setup({segmentLimit:12,mergeFails:true});await rotated(badMerge);await badMerge.command('stop');assert((await until(badMerge,'ready')).error.includes('broken merge input'));assert.equal(badMerge.stats.downloads,0);assert(badMerge.files.has('recording-parts/metadata.json'));
  await badMerge.command('save-segments');await until(badMerge,'downloading');assert(badMerge.stats.downloadRequests[0].filename.endsWith('第001段.mp4'));await badMerge.command('download-ended',{complete:true});await until(badMerge,'downloading');assert(badMerge.stats.downloadRequests[1].filename.endsWith('第002段.mp4'));await badMerge.command('download-ended',{complete:true});await until(badMerge,'idle');
  console.log('PASS: merged file saves once, cancellation retains all chunks, recovery re-merges, merge errors preserve segments for explicit fallback.');
  const folder={};const direct=setup({folder,segmentLimit:12});
  await direct.command('start',{streamId:'folder'});direct.emit(new Blob(['12345678']));
  for(let i=0;i<100;i++){const status=(await direct.command('status')).data;if(status.phase==='recording' && status.partNumber===2)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal((await direct.command('status')).data.partNumber,2);await direct.command('stop');await until(direct,'idle');
  assert.equal(direct.stats.downloads,0,'selected folder must bypass browser Save As');assert.equal(direct.stats.writes.length,0,'direct folder output must skip whole-film OPFS assembly and second copy');
  assert.equal(folder.saved.length,2);assert.equal(folder.saved[0].bytes,'first12345678last');assert.equal(folder.saved[1].bytes,'firstlast');
  const broken={fail:true};const retry=setup({folder:broken});await retry.command('start',{streamId:'retry'});await retry.command('stop');
  assert((await until(retry,'ready')).error.includes('destination full'));assert.equal(retry.stats.removed,0);
  broken.fail=false;await retry.command('download');await until(retry,'idle');assert.equal(broken.saved.length,1);
  const denied=setup({folder:{denied:true}});assert(!(await denied.command('start',{streamId:'denied'})).ok);
  console.log('PASS: direct folder exports all MP4 segments without download dialog, failed write preserves journal and retries, revoked permission blocks recording.');
  const t = setup();
  assert((await t.command('start',{streamId:'tab-123',title:'video'})).ok);
  assert.equal(t.stats.constraints.audio.mandatory.chromeMediaSource,'tab');
  assert.equal(t.stats.constraints.video.mandatory.chromeMediaSourceId,'tab-123');
  assert(t.stats.encoding.mimeType.startsWith('video/mp4'));
  assert.equal(t.stats.speakerConnections,0,'silent mode must not connect tab audio to speakers');
  assert.equal(t.tracks[1].enabled,undefined,'silent mode must not disable recorded audio track');
  assert(!(await t.command('start',{streamId:'other'})).ok,'must prevent concurrent capture');
  assert((await t.command('stop')).ok);
  const saved = await until(t,'downloading');
  assert.equal(saved.bytes,9,'must include final chunk');
  assert.equal(t.stats.stopped,2,'release both capture tracks');
  assert.equal(t.stats.writes.length,2);
  await t.command('download-ended',{complete:false,error:'cancelled'});
  await until(t,'ready');
  assert.equal(t.stats.removed,0,'must retain file on canceled download');
  assert((await t.command('download')).ok);
  assert.equal(t.stats.downloads,2);
  await t.command('download-ended',{complete:true});
  await until(t,'idle');
  assert.equal(t.stats.removed,1,'delete temp only after completed download');
  assert((await t.command('start',{streamId:'again',title:'again'})).ok);
  t.tracks[0].ended();
  await until(t,'downloading');
  const failure = setup({captureFails:true});
  assert(!(await failure.command('start',{streamId:'bad'})).ok);
  await until(failure,'error');
  assert.equal(failure.stats.aborted,1,'abort temp writer when acquisition fails');
  const cancel = setup({saveFails:true});
  await cancel.command('start',{streamId:'ok'});
  await cancel.command('stop');
  const pending = await until(cancel,'ready');
  assert(pending.error.includes('cancelled'));
  assert.equal(cancel.stats.removed,0);
  for(const fps of [60,120]) {
    const hd=setup();
    const result=await hd.command('start',{streamId:'hd',quality:`1080p${fps}`});
    assert(result.ok,result.error);
    assert.equal(hd.stats.constraints.video.mandatory.minWidth,1920);
    assert.equal(hd.stats.constraints.video.mandatory.maxHeight,1080);
    assert.equal(hd.stats.constraints.video.mandatory.minFrameRate,fps);
    assert.equal(hd.stats.encoding.videoBitsPerSecond,fps===120?32000000:16000000);
    assert(result.data.captureFormat.includes(String(fps)));
    await hd.command('stop');await until(hd,'downloading');
  }
  const limited=setup({settingsOverride:{width:1920,height:1080,frameRate:60}});
  const rejected=await limited.command('start',{streamId:'limited',quality:'1080p120'});
  assert(!rejected.ok,'must not silently claim 120 FPS when Chrome reports 60');
  assert.equal(limited.stats.stopped,2);
  assert.equal(limited.stats.aborted,1);
  const audible=setup();
  const listen=await audible.command('start',{streamId:'listen',monitorAudio:true});
  assert(listen.ok);
  assert.equal(audible.stats.speakerConnections,1,'explicit monitoring routes the tab stream to speakers');
  await audible.command('stop');await until(audible,'downloading');
  const originallyMuted=setup({tabMuted:true});
  assert((await originallyMuted.command('start',{streamId:'muted',monitorAudio:true})).ok);
  assert.equal(originallyMuted.stats.speakerConnections,0,'muted tab must stay silent even if monitoring was selected');
  await originallyMuted.command('stop');await until(originallyMuted,'downloading');
  const unsupported=setup({mp4Supported:false});
  const noMp4=await unsupported.command('start',{streamId:'not-used'});
  assert(!noMp4.ok && noMp4.error.includes('MP4'));
  assert.equal(unsupported.stats.constraints,undefined,'reject before any capture or mute change');
  const interrupted=setup();
  await interrupted.command('start',{streamId:'crash',quality:'1080p120'});
  for(let i=0;i<100;i++) {
    const meta=interrupted.files.get('recording-parts/metadata.json');
    if(meta && JSON.parse(await meta.text()).count===1)break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(JSON.parse(await interrupted.files.get('recording-parts/metadata.json').text()).count,1);
  assert.equal(interrupted.files.get('recording.tmp').size,0,'open MP4 must not be mistaken for durable chunks');
  const recovered=setup({files:interrupted.files});
  const recovery=await recovered.command('status');
  assert.equal(recovery.data.phase,'ready');assert.equal(recovery.data.bytes,5);
  assert(recovery.data.error.includes('意外中斷'));
  assert(!(await recovered.command('start',{streamId:'overwrite'})).ok,'never overwrite recovered recording');
  await recovered.command('download');await until(recovered,'downloading');
  assert.equal(await recovered.files.get('recording.tmp').text(),'first');
  const overloaded=setup({slowDisk:true});
  await overloaded.command('start',{streamId:'slow'});
  overloaded.emit({size:65*1048576});
  const safe=await until(overloaded,'downloading');
  assert(safe.error.includes('64 MB'));assert.equal(safe.bytes,5,'retain queued prefix and reject oversized chunk');
  const full=setup({quota:100});
  const diskFailure=await full.command('start',{streamId:'full'});
  assert(!diskFailure.ok && diskFailure.error.includes('空間不足'));
  const corrupted=setup({files:new Map([['recording-parts/',null],['recording-parts/metadata.json',new Blob(['broken'])]])});
  assert.equal((await corrupted.command('status')).data.phase,'ready');
  assert(!(await corrupted.command('start',{streamId:'overwrite'})).ok);
  const assemblyError=setup({assemblyFails:true});
  await assemblyError.command('start',{streamId:'assembly'});await assemblyError.command('stop');
  const retained=await until(assemblyError,'ready');
  assert(retained.error.includes('disk write failed'));
  assert.equal(assemblyError.stats.downloads,0);
  assert.equal(JSON.parse(await assemblyError.files.get('recording-parts/metadata.json').text()).count,2);
  await assemblyError.command('download');await until(assemblyError,'downloading');
  assert.equal(await assemblyError.files.get('recording.tmp').text(),'firstlast');
  const split=setup({segmentLimit:12});
  await split.command('start',{streamId:'same-tab',quality:'1080p120'});
  split.emit(new Blob(['12345678']));
  let segmentState;
  for(let i=0;i<100;i++){
    segmentState=(await split.command('status')).data;
    if(segmentState.phase==='recording' && segmentState.partNumber===2)break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(segmentState.partNumber,2);assert.equal(segmentState.phase,'recording');
  assert.equal(split.stats.stopped,0,'rotation must retain the same video and audio capture tracks');
  assert.equal(split.stats.encoding.videoBitsPerSecond,32000000,'rotation must retain 120 FPS bitrate');
  await split.command('stop');await until(split,'downloading');
  assert.equal(await split.files.get('recording.tmp').text(),'first12345678last','first segment needs final encoder chunk');
  assert(split.stats.downloadRequests[0].filename.endsWith('第001段.mp4'));
  assert.equal(split.stats.downloadRequests[0].saveAs,false,'multiple segments use default download folder');
  await split.command('download-ended',{complete:true});await until(split,'downloading');
  assert.equal(await split.files.get('recording.tmp').text(),'firstlast','new encoder output must not be concatenated with previous MP4');
  assert(split.stats.downloadRequests[1].filename.endsWith('第002段.mp4'));
  await split.command('download-ended',{complete:false,error:'second cancelled'});await until(split,'ready');
  assert.equal(JSON.parse(await split.files.get('recording-parts/metadata.json').text()).downloaded,1);
  const resume=setup({files:split.files});
  assert.equal((await resume.command('status')).data.savedParts,1,'restart remembers which segments were downloaded');
  await resume.command('download');await until(resume,'downloading');
  assert(resume.stats.downloadRequests[0].filename.endsWith('第002段.mp4'),'resume does not download already completed first part');
  await resume.command('download-ended',{complete:true});await until(resume,'idle');
  assert(!resume.files.has('recording-parts/'),'delete journal only when every segment is saved');
  const stopDuringRotation=setup({segmentLimit:12,slowDisk:true});
  await stopDuringRotation.command('start',{streamId:'rotate-stop'});
  stopDuringRotation.emit(new Blob(['12345678']));
  await until(stopDuringRotation,'rotating');
  await stopDuringRotation.command('stop');
  const stoppedRotation=await until(stopDuringRotation,'downloading');
  assert.equal(stoppedRotation.partNumber,1,'stop during rotation must not start another encoder');
  assert.equal(await stopDuringRotation.files.get('recording.tmp').text(),'first12345678last');
  await stopDuringRotation.command('download-ended',{complete:true});await until(stopDuringRotation,'idle');
  console.log('PASS: tab-only media, concurrent guard, final chunk flush, track cleanup, download retry, temp cleanup, target closed, acquisition failure.');
  console.log('PASS: committed chunk recovery after process loss, overwrite guard, bounded queue stop, storage quota guard, corrupted journal protection.');
  console.log('PASS: muxer rotation retains tab/audio/120 FPS, independent MP4 parts, final chunks, ordered downloads, cancellation and restart resume.');
}
module.exports={setup,until};
if(require.main===module)runTests().catch(error=>{console.error(error);process.exitCode=1});
