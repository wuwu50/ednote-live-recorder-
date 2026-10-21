let liveWork = Promise.resolve();
let profileRetryScheduled = false;
function liveLocked(fn) { const work = liveWork.then(fn); liveWork = work.catch(()=>{}); return work; }
async function liveStatus() {
  const monitor = (await chrome.storage.session.get('liveMonitor')).liveMonitor || {enabled:false,message:'尚未啟用待命'};
  return {...monitor,observation:(await chrome.storage.session.get('liveObservation')).liveObservation || null};
}
async function saveLive(value) {
  await chrome.storage.session.set({liveMonitor:value});
  if (typeof ToolbarStatus !== 'undefined') void ToolbarStatus.refresh().catch(()=>{});
  return value;
}
function armLive(message) { return liveLocked(async()=>{
  const hostId = LiveDetector.hostId(message.hostId);
  if ((await liveStatus()).enabled) throw new Error('已在待命，請先解除。');
  const tab = await chrome.tabs.get(message.tabId);
  if (!LiveDetector.belongs(tab.url,hostId)) throw new Error('請在指定主播的小紅書個人頁或帶有 host_id 的直播頁啟用。');
  await ensureOffscreen();
  const status = await offscreen('status');
  if (status.armed || !['idle','error'].includes(status.phase)) throw new Error('請先停止目前錄影或解除待命。');
  await offscreen('arm-preflight');
  // The only getMediaStreamId call for monitoring happens after the user's click.
  const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
  await offscreen('arm-capture',{streamId,tabId:tab.id});
  try {
    const url = new URL(tab.url);
    await saveLive({enabled:true,hostId,tabId:tab.id,profileUrl:`${url.origin}/user/profile/${hostId}`,knownRoom:url.pathname.startsWith('/livestream/') ? url.href : '',endedCount:0,lastNavigation:Date.now(),message:'已啟用待命，每分鐘檢查；只在確認播放後錄影。'});
    await chrome.alarms.create('live-monitor',{periodInMinutes:1});
  } catch (error) { await offscreen('disarm-capture'); throw error; }
  setTimeout(()=>{void checkLive().catch(()=>{});},0);
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
  let pageObserved = false;
  try {
    if (!(await contexts()).length) throw new Error('背景擷取已中斷，請解除後重新啟用。');
    const status = await offscreen('status');
    if (!status.armed || status.armedTabId !== m.tabId) throw new Error('擷取已中斷，請解除後重新啟用。');
    const tab = await chrome.tabs.get(m.tabId);
    if (m.followingProfileEntry && Date.now() - m.followingProfileEntry < 30000 && LiveDetector.allowed(tab.url) && new URL(tab.url).pathname.startsWith('/livestream/')) {
      const owner = new URL(tab.url).searchParams.get('host_id');
      if (owner && owner !== m.hostId) throw new Error('直播入口導向了其他主播，請手動確認。');
      m.knownRoom = tab.url; m.profileUrl = `${new URL(tab.url).origin}/user/profile/${m.hostId}`; m.followingProfileEntry = 0;
    }
    if (!LiveDetector.allowed(tab.url) || new URL(tab.url).origin !== new URL(m.profileUrl).origin) {
      await offscreen('disarm-capture'); await chrome.alarms.clear('live-monitor');
      await reportLiveSample({kind:'unknown',detail:'監控分頁已離開原網站，請重新檢查指定主播頁面。'},{hostId:m.hostId,tabId:m.tabId});
      await saveLive({...m,enabled:false,message:'監控分頁已離開原網站，已停止錄影；請重新啟用。'}); return;
    }
    if (tab.status === 'loading') return;
    const result = await chrome.scripting.executeScript({target:{tabId:m.tabId},func:probeLivePage,args:[m.hostId,m.knownRoom]});
    const sample = result[0]?.result || {kind:'unknown'};
    const next = LiveDetector.decision(sample,m);
    if(['unknown','wrong-page','wrong-host','blocked'].includes(sample.kind) && typeof diagnosticPageSnapshot === 'function') {
      try {
        const snapshot=await chrome.scripting.executeScript({target:{tabId:m.tabId},func:diagnosticPageSnapshot});
        await traceEvent('直播判斷結構摘要',{tabId:m.tabId,kind:sample.kind,evidence:JSON.stringify(snapshot[0]?.result || {})});
      }catch(error){await traceEvent('無法擷取診斷摘要',{tabId:m.tabId,error:error.message});}
    }
    if(typeof traceEvent === 'function') await traceEvent('直播檢查',{hostId:m.hostId,tabId:m.tabId,kind:sample.kind,action:next.action,detail:sample.detail,endedCount:next.endedCount,phase:status.phase,armed:status.armed});
    const recording = ['recording','rotating'].includes(status.phase);
    m.lastCheck = Date.now(); m.endedCount = next.endedCount;
    if (['wrong-page','wrong-host'].includes(sample.kind)) {
      await offscreen('disarm-capture'); await chrome.alarms.clear('live-monitor');
      await reportLiveSample({kind:'unknown',detail:sample.detail || '分頁已離開指定主播，先前結果不代表目前狀態。'},{hostId:m.hostId,tabId:m.tabId});
      await saveLive({...m,enabled:false,message:'分頁已離開指定主播，已停止錄影；請重新啟用待命。'}); return;
    }
    await reportLiveSample(sample,{hostId:m.hostId,tabId:m.tabId,confirmedEnd:next.action === 'ended'});
    pageObserved = true;
    if (sample.kind === 'blocked') {
      m.message = '網站要求驗證，請打開監控分頁處理；尚未判定為下播。';
    } else if (next.action === 'record') {
      if (!recording) {
        if (status.jobs?.some(j=>j.error || j.phase === 'ready')) throw new Error('有尚未儲存的影片，請先在獨立控制視窗處理。');
        const started = await offscreen('start',{useArmed:true,tabId:m.tabId,title:`小紅書 ${m.hostId}`,filenamePrefix:`小紅書-${m.hostId}`,mergeAfterStop:true});
        if (started.tabId !== m.tabId || started.armedTabId !== m.tabId || !['recording','rotating'].includes(started.phase)) {
          if (['recording','rotating'].includes(started.phase)) await offscreen('stop');
          throw new Error('錄影回報的分頁與指定直播來源不一致，已停止並保留片段。');
        }
      }
      m.recordingCheck = {tabId:m.tabId,hostId:m.hostId,checkedAt:Date.now(),ownerProof:sample.ownerProof || '已確認的主播來源'};
      if(typeof traceEvent === 'function' && !recording) await traceEvent('自動錄影來源已核對',{hostId:m.hostId,tabId:m.tabId,sourceTabId:status.armedTabId,detail:sample.ownerProof});
      m.message = '正在自動錄影；每分鐘檢查直播是否結束。';
    } else if (next.action === 'open' && !recording) {
      if (!LiveDetector.room(sample.url,m.hostId) || new URL(sample.url).origin !== new URL(m.profileUrl).origin) throw new Error('直播入口與指定主播不符。');
      m.knownRoom = sample.url; m.lastNavigation = Date.now();
      await chrome.tabs.update(m.tabId,{url:sample.url});
      m.message = '發現直播入口，等待直播開始播放；若未自動播放請打開分頁按播放。';
    } else if (next.action === 'click' && !recording) {
      if (!m.lastEntryAttempt || Date.now() - m.lastEntryAttempt > 60000) {
        m.followingProfileEntry = Date.now();
        const clicked = await chrome.scripting.executeScript({target:{tabId:m.tabId},func:clickProfileLiveEntry,args:[m.hostId,sample.entryToken]});
        m.lastEntryAttempt = Date.now();
        if (clicked[0]?.result) m.followingProfileEntry = Date.now();
      }
      m.message = '主頁顯示直播中，已嘗試點擊入口；若另開分頁，將導回已授權擷取的原分頁。';
    } else if (next.action === 'ended') {
      if (recording) await offscreen('stop');
      m.message = '連續兩次確認下播，已停止並背景儲存；返回主播頁繼續待命。';
      m.knownRoom = ''; m.endedCount = 0; m.lastNavigation = Date.now();
      await chrome.tabs.update(m.tabId,{url:m.profileUrl});
    } else {
      m.message = recording ? '錄影持續中；目前未確認下播（可能緩衝或頁面變更）。' : sample.kind === 'ended' ? '第一次確認下播，等待再次確認。' : sample.kind === 'offline' ? '主頁判讀目前未開播，繼續待命。' : sample.kind === 'live-indicator' ? '主頁顯示直播中，但沒有可辨識的入口，請手動開啟直播。' : sample.kind === 'profile-pending' ? '主頁已載入，稍後再次確認直播標記。' : '待命中；目前沒有可確認的直播訊號。';
      if (['profile-pending','room-pending'].includes(sample.kind) && !profileRetryScheduled && (m.pendingRetries || 0) < 6) {
        m.pendingRetries = (m.pendingRetries || 0) + 1;
        profileRetryScheduled = true;
        setTimeout(()=>{profileRetryScheduled=false;void checkLive().catch(()=>{});},Math.min(6000,Math.max(1000,sample.retryAfterMs || 5200)));
      }
      if (!['profile-pending','room-pending'].includes(sample.kind)) m.pendingRetries = 0;
      // Refresh only the profile, never interrupt a live-room recording.
      if (!recording && sample.kind !== 'profile-pending' && tab.url.startsWith(m.profileUrl) && Date.now() - m.lastNavigation >= 55000) {
        await chrome.tabs.reload(m.tabId); m.lastNavigation = Date.now();
      }
    }
    await saveLive(m);
  } catch (error) {
    // A failed check must never delete footage or mean the broadcaster is offline.
    if(typeof traceEvent === 'function') await traceEvent('直播流程錯誤',{hostId:m.hostId,tabId:m.tabId,error:error.message});
    m.message = `需要注意：${error.message}`; m.lastCheck = Date.now(); m.endedCount = 0;
    if (!pageObserved) await reportLiveSample({kind:'unknown',detail:error.message},{hostId:m.hostId,tabId:m.tabId});
    await saveLive(m);
  }
}); }
function adoptOpenedLiveTab(tabId) { return liveLocked(async()=>{
  const m = await liveStatus();
  if (!m.enabled || !m.followingProfileEntry || Date.now() - m.followingProfileEntry > 30000 || tabId === m.tabId) return;
  const opened = await chrome.tabs.get(tabId);
  const url = opened.pendingUrl || opened.url;
  if (opened.openerTabId !== m.tabId || !LiveDetector.room(url,m.hostId)) return;
  const original = await chrome.tabs.get(m.tabId);
  if (!LiveDetector.allowed(original.url)) return;
  await chrome.tabs.update(m.tabId,opened.active ? {url,active:true} : {url});
  m.knownRoom=url; m.profileUrl=`${new URL(url).origin}/user/profile/${m.hostId}`;
  m.followingProfileEntry=0; m.lastNavigation=Date.now();
  m.message='直播另開的分頁已導回原擷取分頁，正在核對主播及影片播放。';
  await saveLive(m);
  await chrome.tabs.remove(tabId);
  if(typeof traceEvent === 'function') await traceEvent('直播新分頁導回原分頁',{hostId:m.hostId,tabId:m.tabId,sourceTabId:tabId});
}); }
function setupLiveMonitor() {
  chrome.alarms.onAlarm.addListener(alarm=>{if (alarm.name === 'live-monitor') void checkLive();});
  chrome.tabs.onUpdated.addListener((tabId,change)=>{
    if (change.url || change.status === 'complete') void adoptOpenedLiveTab(tabId).catch(()=>{});
    if (change.status === 'complete') void liveStatus().then(m=>{if(m.enabled && m.tabId === tabId) return checkLive();});
  });
  chrome.tabs.onCreated.addListener(tab=>{if (tab.openerTabId) void adoptOpenedLiveTab(tab.id).catch(()=>{});});
  chrome.tabs.onRemoved.addListener(tabId=>{
    void liveStatus().then(m=>{if(m.enabled && m.tabId === tabId) return disarmLive('監控分頁已關閉；已停止並嘗試儲存錄影，請重新啟用。');});
  });
}

function openLiveRoom(message) { return liveLocked(async()=>{
  const hostId=LiveDetector.hostId(message.hostId),url=String(message.url || '').trim();
  if(!LiveDetector.room(url,hostId) || !LiveDetector.belongs(url,hostId)) throw Error('請貼上含指定主播 host_id 的有效小紅書直播分享連結。');
  const m=await liveStatus(),tab=await chrome.tabs.get(message.tabId);
  if(!LiveDetector.belongs(tab.url,hostId) && !(m.enabled && m.tabId === tab.id && m.hostId === hostId && LiveDetector.room(tab.url,hostId))) throw Error('目前目標不是指定主播，請先在主播分頁點錄影機圖示。');
  if(m.enabled && (m.tabId !== tab.id || m.hostId !== hostId)) throw Error('目前正在監控其他分頁或主播，請先解除待命。');
  const status=(await contexts()).length ? await offscreen('status') : {phase:'idle'};
  if(!['idle','error'].includes(status.phase)) throw Error('目前正在錄影，請先停止並儲存後再更換直播連結。');
  if(status.armed && (!m.enabled || status.armedTabId !== tab.id)) throw Error('擷取分頁不一致，請先解除待命。');
  if(m.enabled) await saveLive({...m,knownRoom:url,profileUrl:`${new URL(url).origin}/user/profile/${hostId}`,endedCount:0,lastNavigation:Date.now(),message:'已套用本場直播連結，等待核對主播及影片播放。'});
  try {await chrome.tabs.update(tab.id,{url});}
  catch(error){if(m.enabled)await saveLive(m);throw error;}
  if(typeof traceEvent === 'function') await traceEvent('使用者開啟直播連結',{tabId:tab.id,hostId,armed:!!m.enabled});
  return null;
}); }
