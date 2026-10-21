function createRecordingSession({root:sessionRoot = null,onChange = null,onFinalized = null} = {}) {
let state = {phase:'idle',bytes:0};
let borrowedMedia = false;
let media, audio, recorder, root, fileHandle, writer, blobUrl;
let writes = Promise.resolve();
let writeError = null;
let stopping = null;
let filename;
let journal, queuedBytes = 0, assembled = false;
let diskFailed = false;
let lastDiagnostic = 0;
let stopRequested = false, rotating = false, recorderOptions;
let partStartedAt = 0, outputDirectory = null;
const maxQueuedBytes = 64 * 1048576;
// Chromium's MP4 OutputPositionTracker is uint32_t and CHECKs on overflow.
// Restart the muxer well before 4 GiB, while keeping the same captured tab.
const maxSegmentBytes = 1024 * 1048576;
const maxSegmentDuration = 5 * 60 * 1000;
const diskReserve = 256 * 1048576;
const tempName = 'recording.tmp';
const mimeTypes = ['video/mp4;codecs=avc1,mp4a.40.2','video/mp4'];
function shouldMerge() {
  return !!journal?.meta?.segmented && journal.meta.mergeAfterStop !== false && !(journal.meta.downloaded || 0) && journal.parts().length > 1;
}
const profiles = {
  normal:{fps:30,bitrate:4000000},high:{fps:30,bitrate:8000000},
  '1080p60':{width:1920,height:1080,fps:60,bitrate:16000000},
  '1080p120':{width:1920,height:1080,fps:120,bitrate:32000000}
};
function notify() {
  if (onChange) { onChange({...state}); return; }
  chrome.runtime.sendMessage({target:'background',type:'state',phase:state.phase,error:state.error || ''}).catch(() => {});
}
function diagnostic(reason) {
  chrome.runtime.sendMessage({target:'background',type:'diagnostic',entry:{time:new Date().toISOString(),reason,phase:state.phase,bytes:state.bytes,queuedBytes,partNumber:state.partNumber || 1,partBytes:state.partBytes || 0,captureFormat:state.captureFormat || '',requestedFps:state.requestedFps || 0}}).catch(() => {});
}
async function checkSpace(extra = 0, assembling = false) {
  if (!navigator.storage.estimate) return;
  const {usage,quota} = await navigator.storage.estimate();
  // Only OPFS assembly needs a second full copy. Capturing or writing directly
  // to the chosen folder needs room for queued chunks, not the whole recording.
  const assemblyBytes = !assembling ? 0 : shouldMerge() ? journal.meta.bytes : journal?.meta?.segmented ? journal.meta.segments.reduce((largest,part)=>Math.max(largest,part.bytes),journal.meta.activeBytes || 0) : state.bytes;
  if (Number.isFinite(quota) && Number.isFinite(usage) && quota - usage < assemblyBytes + extra * 2 + diskReserve) throw new Error(`Chrome 暫存可用空間不足（約 ${Math.max(0,(quota-usage)/1048576).toFixed(0)} MB）；已保留片段。請先完成背景儲存，或釋放 Chrome 所在磁碟的空間。`);
}
async function assemble() {
  if (assembled) return;
  if (!journal?.meta?.count) throw new Error('沒有可取回的錄影片段。');
  await checkSpace(0,true);
  fileHandle ||= await root.getFileHandle(tempName,{create:true});
  writer ||= await fileHandle.createWritable();
  const part = journal.parts()[journal.meta.downloaded || 0];
  if (!part) throw new Error('所有影片段落都已儲存。');
  try {
    await writeOutput(writer);
    await writer.close(); writer = null; assembled = true;
  }
  catch (error) { await writer.abort().catch(() => {}); writer = null; throw error; }
}
async function writeOutput(writable) {
  const part = journal.parts()[journal.meta.downloaded || 0];
  if (!part) throw new Error('所有影片段落都已儲存。');
    if (shouldMerge()) {
      const previousPhase = state.phase;
      state.phase = 'merging'; state.mergeProgress = 0; state.merged = false; notify();
      let progressAt = 0;
      try {
        await MergeMp4.write({parts:journal.parts(),getBlob:part=>journal.blob(part),writable,onProgress:progress=>{
          state.mergeProgress = Math.floor(progress.progress * 100); state.mergePart = progress.part;
          if (Date.now() - progressAt > 500) { progressAt = Date.now(); notify(); }
        }});
        state.merged = true; state.mergeProgress = 100;
        diagnostic('所有片段已合併成單一 MP4');
      } finally { state.phase = previousPhase; notify(); }
    } else {
      state.merged = false;
      await journal.assemble(writable,part);
    }
}
const initialized = (async () => {
  try {
    root = sessionRoot || await navigator.storage.getDirectory(); journal = new RecordingJournal(root);
    const meta = await journal.read();
    if (!meta) return;
    if (!meta.count) { await journal.remove(); return; }
    filename = meta.filename;
    state = {phase:'ready',bytes:meta.bytes,startedAt:meta.startedAt,endedAt:meta.endedAt || Date.now(),captureFormat:meta.captureFormat,requestedFps:meta.requestedFps,segmented:!!meta.segmented,partNumber:journal.parts().length,savedParts:meta.downloaded || 0,error:meta.complete ? '找到尚未儲存的影片，請按「重新儲存影片」。' : '上次錄影意外中斷，已保留寫入的片段。請嘗試重新儲存；尾段可能不完整，無法保證可播放。'};
    if ((meta.downloaded || 0) >= journal.parts().length) { await discard(); return; }
    diagnostic(state.error); notify();
  } catch (error) { state = {phase:'ready',bytes:0,error:`暫存取回失敗：${error.message}`}; diagnostic(state.error); notify(); }
})();
async function releaseMedia() {
  if (media && !borrowedMedia) {
    const restored = await chrome.runtime.sendMessage({target:'background',type:'restore-audio'}).catch(() => null);
    if (!restored?.ok) state.error = '無法確認分頁靜音已恢復，請檢查 Chrome 分頁的靜音狀態。';
  }
  media?.getTracks().forEach(track => track.stop());
  media = null;
  if (audio) { await audio.close().catch(() => {}); audio = null; }
}
async function discard() {
  if (!['ready','idle','error'].includes(state.phase)) throw new Error('請先停止錄影。');
  if (writer) { await writer.abort(); writer = null; }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  if (root) await root.removeEntry(tempName).catch(() => {});
  if (journal) await journal.remove();
  fileHandle = null;
  assembled = false;
  state = {phase:'idle',bytes:0};
  notify();
}
async function start(message) {
  if (!['idle','error'].includes(state.phase)) throw new Error('已有錄影或尚未儲存的影片。');
  state = {phase:'starting',bytes:0,title:message.title,tabId:message.tabId,segmented:true,partNumber:1,partBytes:0,savedParts:0};
  notify();
  try {
    outputDirectory = await OutputFolder.authorized(await OutputFolder.stored());
    const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('此 Chrome 沒有可用的 MP4 編碼器，請更新 Chrome 後再錄影。');
    root = sessionRoot || await navigator.storage.getDirectory();
    fileHandle = await root.getFileHandle(tempName,{create:true});
    writer = await fileHandle.createWritable();
    assembled = false; queuedBytes = 0; diskFailed = false; lastDiagnostic = Date.now();
    writes = Promise.resolve();
    writeError = null;
    stopping = null;
    stopRequested = false; rotating = false;
    const profile = profiles[message.quality || 'normal'];
    if (!profile) throw new Error('不支援的錄影設定。');
    const videoConstraints = {chromeMediaSource:'tab',chromeMediaSourceId:message.streamId,maxFrameRate:profile.fps};
    if (profile.width) Object.assign(videoConstraints,{minWidth:profile.width,maxWidth:profile.width,minHeight:profile.height,maxHeight:profile.height,minFrameRate:profile.fps});
    borrowedMedia = !!message.mediaStream;
    media = message.mediaStream || await navigator.mediaDevices.getUserMedia({
      audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},
      video:{mandatory:videoConstraints}
    });
    if (!media.getVideoTracks().length) throw new Error('沒有取得分頁畫面。');
    const settings = media.getVideoTracks()[0].getSettings();
    if (profile.width && (settings.width !== profile.width || settings.height !== profile.height || !(settings.frameRate >= profile.fps - 0.01))) {
      throw new Error(`Chrome 未提供 ${profile.width}×${profile.height} / ${profile.fps} FPS 擷取設定（回報 ${settings.width || '?'}×${settings.height || '?'} / ${settings.frameRate || '?'} FPS）。請改選較低設定。`);
    }
    state.captureFormat = `${settings.width || '?'}×${settings.height || '?'} / ${settings.frameRate || '?'} FPS`;
    state.requestedFps = profile.fps;
    const prepared = borrowedMedia ? {ok:true,data:{originallyMuted:false}} : await chrome.runtime.sendMessage({target:'background',type:'prepare-audio',tabId:message.tabId});
    if (!prepared?.ok) throw new Error(prepared?.error || '無法準備分頁音訊。');
    state.monitorAudio = message.monitorAudio === true && !prepared.data?.originallyMuted;
    state.audioMode = state.monitorAudio ? '錄音並播放到喇叭' : '安靜錄影，持續錄入分頁音訊';
    if (state.monitorAudio && media.getAudioTracks().length) {
      audio = new AudioContext();
      audio.createMediaStreamSource(media).connect(audio.destination);
      await audio.resume();
    }
    recorderOptions = {mimeType,videoBitsPerSecond:profile.bitrate,audioBitsPerSecond:192000};
    recorder = new MediaRecorder(media,recorderOptions);
    if (!recorder.mimeType.toLowerCase().startsWith('video/mp4')) throw new Error('編碼器未使用 MP4，已取消錄影。');
    const stamp = new Date().toLocaleString('sv-SE').replace(/[^0-9]/g,'');
    const prefix = message.filenamePrefix ? String(message.filenamePrefix).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80) : '分頁錄影';
    filename = `${prefix}-${stamp}.mp4`;
    await checkSpace();
    await journal.begin({filename,startedAt:Date.now(),captureFormat:state.captureFormat,requestedFps:state.requestedFps,segmented:true,mergeAfterStop:message.mergeAfterStop !== false});
    attachRecorder();
    for (const track of media.getTracks()) track.addEventListener('ended',() => {
      if (['recording','rotating'].includes(state.phase)) { diagnostic('擷取軌道結束'); stop().catch(() => {}); }
    });
    recorder.start(5000);
    state.phase = 'recording'; state.startedAt = Date.now(); partStartedAt = state.startedAt;
    diagnostic('開始錄影');
    notify();
    return {...state};
  } catch (error) {
    await releaseMedia();
    if (writer) await writer.abort().catch(() => {});
    writer = null;
    state.phase = 'error'; state.error = `無法開始錄影：${error.message}`;
    diagnostic(state.error);
    notify();
    throw new Error(state.error);
  }
}
function attachRecorder() {
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      if (writeError) return;
      if (queuedBytes + event.data.size > maxQueuedBytes) {
        writeError = new Error('待寫入資料超過 64 MB，磁碟或編碼器可能跟不上錄影速度。');
        state.error = `${writeError.message} 已停止並嘗試儲存先前片段；尾段可能不完整。`;
        diagnostic(state.error); stop().catch(() => {}); return;
      }
      queuedBytes += event.data.size;
      state.partBytes += event.data.size;
      writes = writes.then(async () => {
        if (diskFailed) return;
        await checkSpace(event.data.size);
        await journal.append(event.data);
        state.bytes += event.data.size;
        if (Date.now() - lastDiagnostic >= 60000) { lastDiagnostic = Date.now(); diagnostic('錄影進度'); }
      }).catch(error => {
        diskFailed = true;
        writeError = error;
        state.error = `暫存寫入失敗：${error.message}；已寫入的部分會嘗試儲存。`;
        diagnostic(state.error);
        stop().catch(() => {});
      }).finally(() => { queuedBytes -= event.data.size; });
      if (!stopRequested && !rotating && state.phase === 'recording' && recorder.state !== 'inactive' && (state.partBytes >= maxSegmentBytes || Date.now() - partStartedAt >= maxSegmentDuration)) {
        rotating = true; diagnostic('達到分段門檻，重新建立 MP4 編碼器'); recorder.stop();
      }
    };
    recorder.onerror = event => {
      state.error = `編碼失敗：${event.error?.message || '未知原因'}；嘗試儲存已錄製的部分。`;
      diagnostic(state.error);
      stop().catch(() => {});
    };
    // Assign before start, so automatically ended captures also finalize the file.
    recorder.onstop = () => (rotating && !stopRequested && !writeError ? rotateSegment() : finalize()).catch(async error => {
      stopRequested = true;
      await releaseMedia();
      state.phase = 'ready'; state.error = `完成影片失敗：${error.message}。片段仍保留，請重新儲存或匯出錯誤紀錄。`; diagnostic(state.error); notify();
    });
}
async function rotateSegment() {
  state.phase = 'rotating'; notify();
  await writes;
  if (stopRequested || writeError) return finalize();
  await journal.finishSegment();
  if (stopRequested) return finalize();
  recorder = new MediaRecorder(media,recorderOptions);
  if (!recorder.mimeType.toLowerCase().startsWith('video/mp4')) throw new Error('新段落沒有使用 MP4 編碼器。');
  state.partNumber++; state.partBytes = 0;
  attachRecorder();
  recorder.start(5000);
  partStartedAt = Date.now(); rotating = false; state.phase = 'recording';
  diagnostic('開始下一段 MP4'); notify();
}
async function stop() {
  if (stopping) return stopping;
  if (!recorder || !['recording','rotating','saving'].includes(state.phase)) throw new Error('目前沒有進行中的錄影。');
  stopRequested = true;
  state.phase = 'saving'; state.endedAt = Date.now(); notify();
  if (recorder.state !== 'inactive') recorder.stop();
  // onstop performs finalization once the final dataavailable event arrives.
  return {...state};
}
async function finalize() {
  if (stopping) return stopping;
  stopping = (async () => {
    state.phase = 'saving'; state.endedAt ||= Date.now(); notify();
    await releaseMedia();
    await writes;
    if (journal.meta.segmented) await journal.finishSegment(!writeError && !state.error);
    state.bytes = journal.meta.bytes;
    journal.meta.complete = !writeError && !state.error;
    journal.meta.endedAt = state.endedAt;
    await journal.saveMeta();
    state.phase = 'ready'; notify();
    diagnostic(state.error || '錄影已完成');
    if (!state.bytes) { state.error = '沒有錄到影片資料。'; notify(); if (onFinalized) onFinalized(); return; }
    if (onFinalized) onFinalized();
    else await download();
  })();
  return stopping;
}
async function download() {
  if (state.phase !== 'ready') throw new Error('影片尚未準備好，請稍候。');
  state.phase = 'saving'; notify();
  try {
  outputDirectory = await OutputFolder.authorized(await OutputFolder.stored());
  if (outputDirectory && !assembled) {
    // Skip the complete OPFS output copy: write the final MP4 once, to its folder.
    if (writer) { await writer.abort(); writer = null; }
    const parts = journal.parts();
    const name = shouldMerge() || (parts.length === 1 && journal.meta.mergeAfterStop !== false) ? filename : parts[journal.meta.downloaded || 0].filename;
    await OutputFolder.save(outputDirectory,name,writable=>writeOutput(writable));
    diagnostic('MP4 已直接完成於設定資料夾，略過整部暫存複製');
    await discardAfterDownload(); return {...state};
  }
  await assemble();
  const file = await fileHandle.getFile();
  if (!file.size) throw new Error('暫存影片是空的，請刪除並重新錄影。');
  const parts = journal.parts();
  const outputFilename = state.merged || (parts.length === 1 && journal.meta.mergeAfterStop !== false) ? filename : parts[journal.meta.downloaded || 0].filename;
  // Re-read persisted settings for recovery and retries after folder reauthorization.
  outputDirectory = await OutputFolder.authorized(await OutputFolder.stored());
  if (outputDirectory) {
    await OutputFolder.save(outputDirectory,outputFilename,file);
    diagnostic('MP4 已直接存入設定資料夾');
    await discardAfterDownload();
    return {...state};
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(file);
  state.phase = 'downloading'; notify();
    const response = await chrome.runtime.sendMessage({target:'background',type:'save-file',url:blobUrl,filename:outputFilename,saveAs:state.merged || parts.length === 1});
    if (!response?.ok) throw new Error(response?.error || '無法儲存影片。');
  } catch (error) {
    state.phase = 'ready'; state.error = `儲存未完成：${error.message}。請按「重新儲存影片」。`; diagnostic(state.error); notify();
  }
  return {...state};
}
async function handle(message) {
  await initialized;
  switch (message.type) {
    case 'monitor-off':
      if (audio) { await audio.close(); audio = null; }
      state.monitorAudio = false;
      state.audioMode = '安靜錄影，持續錄入分頁音訊';
      return {...state};
    case 'status': return {...state};
    case 'start': return start(message);
    case 'stop': return stop();
    case 'download': return download();
    case 'save-segments':
      if (state.phase !== 'ready') throw new Error('請先等待錄影及合併完成。');
      journal.meta.mergeAfterStop = false; await journal.saveMeta();
      assembled = false; state.merged = false; state.error = '';
      return download();
    case 'discard': await discard(); return {...state};
    case 'download-ended':
      if (message.complete) await discardAfterDownload();
      else { state.phase = 'ready'; state.error = message.error; notify(); }
      return {...state};
    default: throw new Error('未知操作。');
  }
}
async function discardAfterDownload() {
  journal.meta.downloaded = state.merged ? journal.parts().length : (journal.meta.downloaded || 0) + 1;
  await journal.saveMeta(); state.savedParts = journal.meta.downloaded;
  if (journal.meta.downloaded < journal.parts().length) {
    if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null;
    fileHandle = null; assembled = false;
    state.phase = 'ready'; return download();
  }
  state.phase = 'ready';
  await discard();
}

return {handle,ready:initialized,snapshot:()=>({...state})};
}
