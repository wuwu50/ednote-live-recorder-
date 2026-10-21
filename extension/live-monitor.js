let liveWork = Promise.resolve();
function liveLocked(fn) { const work = liveWork.then(fn); liveWork = work.catch(()=>{}); return work; }
async function liveStatus() {
  return (await chrome.storage.session.get('liveMonitor')).liveMonitor || {enabled:false,message:'尚未啟用待命'};
}
async function saveLive(value) { await chrome.storage.session.set({liveMonitor:value}); return value; }
function armLive(message) { return liveLocked(async()=>{
  const hostId = LiveDetector.hostId(message.hostId);
  if ((await liveStatus()).enabled) throw new Error('已在待命，請先解除。');
  const tab = await chrome.tabs.get(message.tabId);
  if (!LiveDetector.belongs(tab.url,hostId)) throw new Error('請在指定主播的小紅書個人頁或帶有 host_id 的直播頁啟用。');
  await ensureOffscreen();
  const status = await offscreen('status');
  if (status.armed || !['idle','error'].includes(status.phase)) throw new Error('請先停止目前錄影或解除待命。');
  // The only getMediaStreamId call for monitoring happens after the user's click.
  const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
  await offscreen('arm-capture',{streamId,tabId:tab.id});
  try {
    const url = new URL(tab.url);
    await saveLive({enabled:true,hostId,tabId:tab.id,profileUrl:`${url.origin}/user/profile/${hostId}`,knownRoom:url.pathname.startsWith('/livestream/') ? url.href : '',endedCount:0,lastNavigation:Date.now(),message:'已啟用待命，每分鐘檢查；只在確認播放後錄影。'});
    await chrome.alarms.create('live-monitor',{periodInMinutes:1});
  } catch (error) { await offscreen('disarm-capture'); throw error; }
  return liveStatus();
}); }
function disarmLive(reason = '已解除待命，錄影片段會在背景儲存。') { return liveLocked(async()=>{
  const m = await liveStatus();
  // Keep monitoring active until the capture really stops, so retry remains possible.
  if ((await contexts()).length) await offscreen('disarm-capture');
  await chrome.alarms.clear('live-monitor');
  return saveLive({...m,enabled:false,message:reason});
}); }
function checkLive() { return liveLocked(async()=>{
  const m = await liveStatus(); if (!m.enabled) return;
  try {
    if (!(await contexts()).length) throw new Error('背景擷取已中斷，請解除後重新啟用。');
    const status = await offscreen('status');
    if (!status.armed || status.armedTabId !== m.tabId) throw new Error('擷取已中斷，請解除後重新啟用。');
    const tab = await chrome.tabs.get(m.tabId);
    if (!LiveDetector.allowed(tab.url) || new URL(tab.url).origin !== new URL(m.profileUrl).origin) {
      await offscreen('disarm-capture'); await chrome.alarms.clear('live-monitor');
      await saveLive({...m,enabled:false,message:'監控分頁已離開原網站，已停止錄影；請重新啟用。'}); return;
    }
    if (tab.status === 'loading') return;
    const result = await chrome.scripting.executeScript({target:{tabId:m.tabId},func:probeLivePage,args:[m.hostId,m.knownRoom]});
    const sample = result[0]?.result || {kind:'unknown'};
    const next = LiveDetector.decision(sample,m);
    const recording = ['recording','rotating'].includes(status.phase);
    m.lastCheck = Date.now(); m.endedCount = next.endedCount;
    if (sample.kind === 'wrong-page') {
      await offscreen('disarm-capture'); await chrome.alarms.clear('live-monitor');
      await saveLive({...m,enabled:false,message:'分頁已離開指定主播，已停止錄影；請重新啟用待命。'}); return;
    }
    if (sample.kind === 'blocked') {
      m.message = '網站要求驗證，請打開監控分頁處理；尚未判定為下播。';
    } else if (next.action === 'record') {
      if (!recording) {
        if (status.jobs?.some(j=>j.error || j.phase === 'ready')) throw new Error('有尚未儲存的影片，請先在獨立控制視窗處理。');
        await offscreen('start',{useArmed:true,tabId:m.tabId,title:`小紅書 ${m.hostId}`,filenamePrefix:`小紅書-${m.hostId}`,mergeAfterStop:true});
      }
      m.message = '正在自動錄影；每分鐘檢查直播是否結束。';
    } else if (next.action === 'open' && !recording) {
      if (!LiveDetector.belongs(sample.url,m.hostId) || new URL(sample.url).origin !== new URL(m.profileUrl).origin) throw new Error('直播入口與指定主播不符。');
      m.knownRoom = sample.url; m.lastNavigation = Date.now();
      await chrome.tabs.update(m.tabId,{url:sample.url});
      m.message = '發現直播入口，等待直播開始播放；若未自動播放請打開分頁按播放。';
    } else if (next.action === 'ended') {
      if (recording) await offscreen('stop');
      m.message = '連續兩次確認下播，已停止並背景儲存；返回主播頁繼續待命。';
      m.knownRoom = ''; m.endedCount = 0; m.lastNavigation = Date.now();
      await chrome.tabs.update(m.tabId,{url:m.profileUrl});
    } else {
      m.message = recording ? '錄影持續中；目前未確認下播（可能緩衝或頁面變更）。' : sample.kind === 'ended' ? '第一次確認下播，等待再次確認。' : '待命中；目前沒有可確認的直播訊號。';
      // Refresh only the profile, never interrupt a live-room recording.
      if (!recording && tab.url.startsWith(m.profileUrl) && Date.now() - m.lastNavigation >= 55000) {
        await chrome.tabs.reload(m.tabId); m.lastNavigation = Date.now();
      }
    }
    await saveLive(m);
  } catch (error) {
    // A failed check must never delete footage or mean the broadcaster is offline.
    m.message = `需要注意：${error.message}`; m.lastCheck = Date.now(); m.endedCount = 0;
    await saveLive(m);
  }
}); }
function setupLiveMonitor() {
  chrome.alarms.onAlarm.addListener(alarm=>{if (alarm.name === 'live-monitor') void checkLive();});
  chrome.tabs.onUpdated.addListener((tabId,change)=>{
    if (change.status === 'complete') void liveStatus().then(m=>{if(m.enabled && m.tabId === tabId) return checkLive();});
  });
  chrome.tabs.onRemoved.addListener(tabId=>{
    void liveStatus().then(m=>{if(m.enabled && m.tabId === tabId) return disarmLive('監控分頁已關閉；已停止並嘗試儲存錄影，請重新啟用。');});
  });
}
