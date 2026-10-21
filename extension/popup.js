const $ = id => document.getElementById(id);
let busy = false;
let operationError = '';
function actionStatus(text,isError = false) {
  $('live-action-status').hidden = !text;
  $('live-action-status').textContent = text;
  $('live-action-status').dataset.error = String(isError);
  $('live-folder').hidden = !isError || !/資料夾|存取/.test(text);
}
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
    if (busy) return;
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
    $('error').textContent = operationError || s.error || ((s.jobs || []).some(job=>job.error) ? '有影片尚未儲存完成，請開啟獨立控制視窗處理。' : '');
  } catch (error) {
    if (busy) return;
    $('error').textContent = operationError || error.message;
    if (!operationError) actionStatus(`無法讀取錄影機狀態：${error.message}`,true);
  }
}
async function run(type, extra = {}) {
  if (busy) return;
  busy = true;
  operationError = '';
  const arming = type === 'live-arm';
  actionStatus(arming ? '正在檢查分頁、儲存資料夾並啟用待命…' : '正在處理…');
  $('live-arm').textContent = arming ? '正在啟用待命…' : '啟用目前分頁待命';
  for (const id of ['start','stop','retry','discard','live-check','live-arm','live-disarm']) $(id).disabled = true;
  $('error').textContent = '';
  const waiting = setTimeout(()=>actionStatus(arming ? '仍在準備待命，請留意 Chrome 的權限提示；請勿重複點擊。' : '仍在處理，請稍候…'),10000);
  try {
    const values = typeof extra === 'function' ? await extra() : extra;
    await command(type, values);
    actionStatus(arming ? '✓ 待命已啟用。將立即檢查一次，之後每分鐘檢查。請保持此分頁開啟。' : type === 'live-disarm' ? '已解除待命，錄影片段將在背景儲存。' : '操作已完成。');
  }
  catch (error) {
    operationError = error.message;
    actionStatus(`${arming ? '待命未啟用' : '操作未完成'}：${operationError}`,true);
    $('live-action-status').scrollIntoView({block:'nearest'});
  }
  finally {
    clearTimeout(waiting);
    busy = false;
    $('live-arm').textContent = '啟用目前分頁待命';
    $('retry').disabled = $('discard').disabled = false;
    await refresh();
    if (operationError) $('error').textContent = operationError;
  }
}
$('start').addEventListener('click', async () => {
  await run('start',async()=>{
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return {tabId:tab?.id,quality:$('quality').value,monitorAudio:$('monitor-audio').checked};
  });
});
$('stop').addEventListener('click', () => run('stop'));
$('panel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    await command('open-panel',{tabId:tab?.id});
    window.close();
  } catch (error) { operationError = error.message; $('error').textContent = error.message; actionStatus(error.message,true); }
});
$('live-folder').addEventListener('click',()=>$('panel').click());
$('retry').addEventListener('click', () => run('download'));
$('discard').addEventListener('click', () => {
  if (confirm('確定刪除尚未儲存的暫存影片？')) run('discard');
});
refresh();
setInterval(refresh,1000);

$('live-arm').addEventListener('click',async()=>{
  const hostId = $('host-id').value.trim();
  await run('live-arm',async()=>{
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return {tabId:tab?.id,hostId};
  });
});
$('live-disarm').addEventListener('click',()=>run('live-disarm'));
$('live-check').addEventListener('click',async()=>{
  const hostId = $('host-id').value.trim();
  await run('live-inspect',async()=>{
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return {tabId:tab?.id,hostId};
  });
});
command('live-status').then(live=>{
  if (document.activeElement !== $('host-id')) $('host-id').value = live.observation?.hostId || live.hostId || '5f0c0b43000000000101fb9c';
}).catch(()=>{});
