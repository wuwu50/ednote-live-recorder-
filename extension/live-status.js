const LIVE_STATUS_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAvklEQVR4nO3ZwQ2AMAzF0G7FGOwvsQvMgJrECTjSv1vv2K7rOO8/b9EB9ASgA+gJQAfQE4AOoCcAHUBPADqAngB0AD0B6AB6AtAB9EoB3tynAHZuPEDEjQTIuDEAmSdAd4CKawtQeQJ0AyBOAAEEEEAAAQQQQAABGgBUI0Q1CxAJUIUQ2euLkAAJAFkIGZ3+C2QD7CJkt/k3WAnQcQLQAfQEoAPoCUAH0BOADqAnAB1ATwA6gJ4AdAA9AegAeg979XF6EYmflwAAAABJRU5ErkJggg==";
// Observation is separate from recording: a page can be checked without capture.
function liveObservation(sample, confirmedEnd = false) {
  if (sample.kind === 'playing') return {state:'live',label:'直播中',detail:'已確認直播影片正在播放。'};
  if (sample.kind === 'live-link') return {state:'live',label:'直播中',detail:'主播頁顯示直播入口；尚未確認影片播放。'};
  if (sample.kind === 'offline') return {state:'offline',label:'目前未開播',detail:'頁面明確顯示主播未開播。'};
  if (sample.kind === 'ended' && confirmedEnd) return {state:'ended',label:'直播已結束',detail:'直播頁顯示直播已結束。'};
  if (sample.kind === 'ended') return {state:'unknown',label:'正在確認是否下播',detail:'第一次發現結束訊號，等待再次確認。'};
  if (sample.kind === 'blocked') return {state:'unknown',label:'目前無法確認',detail:'網站要求驗證，請在直播分頁處理。'};
  return {state:'unknown',label:'目前無法確認',detail:sample.detail || '未找到明確開播或下播訊號；不代表主播未開播。'};
}
async function reportLiveSample(sample, {hostId,tabId,confirmedEnd = false,forceNotify = false} = {}) {
  const {liveObservation:previous} = await chrome.storage.session.get('liveObservation');
  const sameHost = previous?.hostId === hostId;
  const observation = {...liveObservation(sample,confirmedEnd),hostId,tabId,checkedAt:Date.now(),
    lastNotifiedState:sameHost ? previous.lastNotifiedState : null};
  // Unknown/buffering never erases the last announced state or retriggers 'live'.
  const transition = ['live','ended'].includes(observation.state) && observation.state !== observation.lastNotifiedState;
  const offlineTransition = observation.state === 'offline' && observation.lastNotifiedState === 'live';
  if (forceNotify || transition || offlineTransition) {
    try {
      if (await chrome.notifications.getPermissionLevel() !== 'granted') throw new Error('請允許 Chrome 通知，狀態仍會顯示在這裡。');
      await chrome.notifications.create('rednote-live-status',{
        type:'basic',iconUrl:LIVE_STATUS_ICON,title:`小紅書｜${observation.label}`,
        message:`主播 ${hostId}\n${observation.detail}`,silent:!forceNotify
      });
      if (['live','ended','offline'].includes(observation.state)) observation.lastNotifiedState = observation.state;
    } catch (_) { observation.notificationError = '桌面通知未送出，請檢查 Chrome／Windows 通知設定；上方狀態仍有效。'; }
  }
  await chrome.storage.session.set({liveObservation:observation});
  return observation;
}
function inspectLiveNow(message) { return liveLocked(async()=>{
  const hostId = LiveDetector.hostId(message.hostId);
  const tab = await chrome.tabs.get(message.tabId);
  if (!LiveDetector.belongs(tab.url,hostId)) throw new Error('請先開啟指定主播個人頁或帶有 host_id 的直播頁，再檢查。');
  let sample;
  try {
    if (tab.status === 'loading') sample = {kind:'unknown',detail:'頁面載入中，請稍後再次檢查。'};
    else {
      const result = await chrome.scripting.executeScript({target:{tabId:tab.id},func:probeLivePage,args:[hostId,tab.url]});
      sample = result[0]?.result || {kind:'unknown'};
    }
  } catch (_) { sample = {kind:'unknown',detail:'無法讀取目前頁面，請重新整理頁面後再檢查。'}; }
  await reportLiveSample(sample,{hostId,tabId:tab.id,confirmedEnd:true,forceNotify:true});
  return liveStatus();
}); }
