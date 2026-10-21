const $ = id => document.getElementById(id);
let busy = false;
async function command(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({target: 'background', type, ...extra});
  if (!response?.ok) throw new Error(response?.error || '無法連線至錄影機。');
  return response.data;
}
async function refresh() {
  if (busy) return;
  try {
    const s = await command('status');
    const live = await command('live-status');
    const observation = live.observation;
    const inputHost = $('host-id').value.trim().toLowerCase();
    const relevant = observation && observation.hostId === inputHost;
    const stale = relevant && Date.now() - observation.checkedAt > 120000;
    $('live-state').textContent = relevant ? observation.label + (stale ? '（待重新確認）' : '') : '尚未檢查直播狀態';
    $('live-state').dataset.state = relevant && !stale ? observation.state : 'unknown';
    $('live-detail').textContent = relevant ? observation.detail : '開啟主播頁面即可檢查，不需要先啟用錄影。';
    $('live-checked-at').textContent = relevant ? `主播 ${observation.hostId} · 最後檢查：${new Date(observation.checkedAt).toLocaleString('zh-TW')}` : '尚無檢查時間';
    $('live-notification-error').textContent = relevant ? observation.notificationError || '' : '';
    $('live-status').textContent = live.message || '尚未啟用待命';
    $('live-arm').disabled = !!s.armed || !['idle','error'].includes(s.phase);
    $('live-disarm').disabled = !live.enabled && !s.armed;
    $('live-check').disabled = false;
    const names = {idle:'尚未開始',starting:'準備錄製…',recording:'● 錄製中',saving:'正在儲存…',ready:'影片已暫存，請儲存',downloading:'正在下載影片…',error:'錄影發生錯誤'};
    const pending = (s.jobs || []).length;
    $('status').textContent = s.phase === 'idle' && pending ? `背景處理 ${pending} 部影片，可開始下一次錄影` : names[s.phase] || s.phase;
    $('title').textContent = s.title || '開啟要錄製的網頁，再按開始';
    const seconds = s.startedAt ? Math.floor(((s.endedAt || Date.now()) - s.startedAt) / 1000) : 0;
    $('time').textContent = [Math.floor(seconds / 3600),Math.floor(seconds / 60) % 60,seconds % 60].map(n => String(n).padStart(2,'0')).join(':');
    $('size').textContent = s.bytes ? `已寫入 ${(s.bytes / 1048576).toFixed(1)} MB` : '';
    $('start').disabled = !!s.armed || !!s.preparing || !['idle','error'].includes(s.phase);
    $('stop').disabled = !['recording','rotating'].includes(s.phase);
    $('quality').disabled = !['idle','error'].includes(s.phase);
    $('monitor-audio').disabled = !['idle','error'].includes(s.phase);
    $('retry').hidden = s.phase !== 'ready';
    $('discard').hidden = s.phase !== 'ready';
    $('error').textContent = s.error || ((s.jobs || []).some(job=>job.error) ? '有影片尚未儲存完成，請開啟獨立控制視窗處理。' : '');
  } catch (error) { $('error').textContent = error.message; }
}
async function run(type, extra = {}) {
  busy = true;
  let operationError = '';
  for (const id of ['start','stop','retry','discard','live-check','live-arm','live-disarm']) $(id).disabled = true;
  $('error').textContent = '';
  try { await command(type, extra); }
  catch (error) { operationError = error.message; }
  finally {
    busy = false;
    $('retry').disabled = $('discard').disabled = false;
    await refresh();
    if (operationError) $('error').textContent = operationError;
  }
}
$('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  await run('start', {tabId:tab?.id,quality:$('quality').value,monitorAudio:$('monitor-audio').checked});
});
$('stop').addEventListener('click', () => run('stop'));
$('panel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    await command('open-panel',{tabId:tab?.id});
    window.close();
  } catch (error) { $('error').textContent = error.message; }
});
$('retry').addEventListener('click', () => run('download'));
$('discard').addEventListener('click', () => {
  if (confirm('確定刪除尚未儲存的暫存影片？')) run('discard');
});
refresh();
setInterval(refresh,1000);

$('live-arm').addEventListener('click',async()=>{
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  await run('live-arm',{tabId:tab?.id,hostId:$('host-id').value.trim()});
});
$('live-disarm').addEventListener('click',()=>run('live-disarm'));
$('live-check').addEventListener('click',async()=>{
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  await run('live-inspect',{tabId:tab?.id,hostId:$('host-id').value.trim()});
});
command('live-status').then(live=>{
  if (document.activeElement !== $('host-id')) $('host-id').value = live.observation?.hostId || live.hostId || '5f0c0b43000000000101fb9c';
}).catch(()=>{});
