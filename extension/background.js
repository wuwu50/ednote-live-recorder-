importScripts('updates.js','audio-routing.js','installed-update.js','live-detector.js','live-status.js','live-monitor.js');
let starting = false;
let creating = null;
let diagnosticWrites = Promise.resolve();
async function contexts() {
  return chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
}
async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
  if (!(await contexts()).length) {
    await restoreCapturedAudio();
    await chrome.offscreen.createDocument({
    url:'offscreen.html', reasons:['USER_MEDIA','BLOBS'],
    justification:'擷取使用者指定分頁的影音，在背景錄影並儲存本機影片。'
  });
  }
  })();
  try { await creating; } finally { creating = null; }
}
async function offscreen(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({target:'offscreen',type,...extra});
  if (!response?.ok) throw new Error(response?.error || '背景錄影機沒有回應。');
  return response.data;
}
async function setBadge(phase) {
  await chrome.action.setBadgeText({text: ['recording','rotating'].includes(phase) ? 'REC' : ['ready','downloading','saving','merging'].includes(phase) ? '存' : ''});
  await chrome.action.setBadgeBackgroundColor({color:'#d9415b'});
}
async function handle(message) {
  switch (message.type) {
    case 'live-status': return liveStatus();
    case 'live-arm': return armLive(message);
    case 'live-disarm': return disarmLive();
    case 'live-check': await checkLive(); return liveStatus();
    case 'live-inspect': return inspectLiveNow(message);
    case 'live-capture-ended': return disarmLive('分頁擷取中斷，請重新啟用待命。');
    case 'prepare-audio': return prepareCapturedAudio(message.tabId);
    case 'restore-audio': await restoreCapturedAudio(); return null;
    case 'update-settings': return getUpdateSettings();
    case 'update-source': return saveUpdateSource(message.url);
    case 'check-update': return checkForUpdate();
    case 'open-panel': {
      const tab = await chrome.tabs.get(message.tabId);
      await chrome.storage.session.set({panelTarget:{id:tab.id,title:tab.title || 'Chrome 分頁',url:tab.url || ''}});
      const saved = (await chrome.storage.session.get('panelWindowId')).panelWindowId;
      if (saved) {
        try { await chrome.windows.update(saved,{focused:true,state:'normal'}); return null; }
        catch (_) { /* The previous control window was closed. */ }
      }
      const panel = await chrome.windows.create({url:chrome.runtime.getURL('panel.html'),type:'popup',width:960,height:790});
      await chrome.storage.session.set({panelWindowId:panel.id});
      return null;
    }
    case 'panel-target':
      return (await chrome.storage.session.get('panelTarget')).panelTarget || null;
    case 'status': {
      await ensureOffscreen();
      const result = await offscreen('status');
      if (!result.error) result.error = (await chrome.storage.local.get('lastError')).lastError || '';
      void checkForInstalledUpdate();
      return result;
    }
    case 'diagnostics':
      await diagnosticWrites;
      return {version:chrome.runtime.getManifest().version,exportedAt:new Date().toISOString(),entries:(await chrome.storage.local.get('diagnostics')).diagnostics || []};
    case 'diagnostic': {
      const entry = message.entry || {};
      // Keep only recording metrics and errors; never store page titles or URLs.
      const clean = {time:String(entry.time || ''),reason:String(entry.reason || '').slice(0,2000),phase:String(entry.phase || ''),bytes:Number(entry.bytes) || 0,queuedBytes:Number(entry.queuedBytes) || 0,partNumber:Number(entry.partNumber) || 1,partBytes:Number(entry.partBytes) || 0,captureFormat:String(entry.captureFormat || ''),requestedFps:Number(entry.requestedFps) || 0};
      diagnosticWrites = diagnosticWrites.catch(() => {}).then(async () => {
        const entries = (await chrome.storage.local.get('diagnostics')).diagnostics || [];
        await chrome.storage.local.set({diagnostics:[...entries,clean].slice(-40)});
      });
      await diagnosticWrites; return null;
    }
    case 'start': {
      if (updateReloading) throw new Error('新版正在自動啟用，請稍候重新開啟錄影介面。');
      if (starting) throw new Error('正在準備錄製，請稍候。');
      starting = true;
      try {
        const tab = await chrome.tabs.get(message.tabId);
        if (!tab.url || !/^https?:|^file:/.test(tab.url)) throw new Error('請開啟一般網頁；Chrome 設定頁與擴充功能頁不能錄製。');
        await ensureOffscreen();
        const state = await offscreen('status');
        if (!['idle','error'].includes(state.phase)) throw new Error('請先停止錄影並儲存或刪除暫存影片。');
        if (state.armed) throw new Error('請先解除直播待命。');
        const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
        const result = await offscreen('start',{streamId,title:tab.title || 'Chrome 分頁',tabId:tab.id,quality:message.quality,monitorAudio:message.monitorAudio === true,mergeAfterStop:message.mergeAfterStop !== false});
        await chrome.storage.local.remove('lastError');
        await setBadge('recording');
        return result;
      } finally { starting = false; }
    }
    case 'stop': { const m = await liveStatus(); if (m.enabled) return disarmLive(); return offscreen('stop'); }
    case 'download': return offscreen('download',{jobId:message.jobId});
    case 'save-segments': return offscreen('save-segments',{jobId:message.jobId});
    case 'discard': return offscreen('discard',{jobId:message.jobId});
    case 'state':
      await setBadge(message.phase);
      await chrome.storage.local.set({lastError:message.error || ''});
      return null;
    case 'save-file': {
      const id = await chrome.downloads.download({url:message.url,filename:message.filename,saveAs:message.saveAs !== false});
      await chrome.storage.local.set({pendingDownload:id});
      // Completion may race with storing the ID for very small files.
      const [item] = await chrome.downloads.search({id});
      if (item?.state !== 'in_progress') setTimeout(() => finishDownload(id,item?.state,item?.error),0);
      return {downloadId:id};
    }
    default: throw new Error('未知操作。');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;
  handle(message).then(data => respond({ok:true,data}),error => respond({ok:false,error:error.message}));
  return true;
});
let finishing = false;
async function finishDownload(id,state,error) {
  if (finishing || !['complete','interrupted'].includes(state)) return;
  if ((await chrome.storage.local.get('pendingDownload')).pendingDownload !== id) return;
  finishing = true;
  try {
    await offscreen('download-ended',{complete:state === 'complete',error:error || '下載取消或失敗，影片仍在暫存，可重新儲存。'});
    // Completing one segment can start the next download before this returns.
    // Do not erase that next segment's ID or miss its fast completion event.
    if ((await chrome.storage.local.get('pendingDownload')).pendingDownload === id) await chrome.storage.local.remove('pendingDownload');
  } catch (e) { await chrome.storage.local.set({lastError:e.message}); }
  finally { finishing = false; }
  const next = (await chrome.storage.local.get('pendingDownload')).pendingDownload;
  if (next && next !== id) {
    const [item] = await chrome.downloads.search({id:next});
    if (item && item.state !== 'in_progress') setTimeout(()=>finishDownload(next,item.state,item.error),0);
  }
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state) finishDownload(delta.id,delta.state.current,delta.error?.current);
});
chrome.runtime.onStartup.addListener(() => setBadge('idle'));
chrome.tabs.onUpdated.addListener((tabId,change) => {
  capturedTabMuted(tabId,change).catch(error => chrome.storage.local.set({lastError:`分頁音訊處理失敗：${error.message}`}));
});
setupInstalledUpdateWatch();

setupLiveMonitor();
