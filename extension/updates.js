// Loaded by the service worker; requests are only made when the user checks.
function updateHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('請輸入有效的 HTTPS 網址。');
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('請輸入有效的 HTTPS 網址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('更新網址必須使用 HTTPS，且不可包含帳密或片段。');
  return url;
}
function updateHostPattern(url) { return `https://${url.hostname}/*`; }
function updateVersionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(value)) throw new Error('版本格式無效，請使用 1.2.0 這類數字版本。');
  const parts = value.split('.').map(Number);
  if (parts.some(n => n > 65535)) throw new Error('版本數字超出範圍。');
  while (parts.length < 4) parts.push(0);
  return parts;
}
function compareUpdateVersions(left,right) {
  const a = updateVersionParts(left), b = updateVersionParts(right);
  for (let i=0;i<4;i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; }
  return 0;
}
async function getUpdateSettings() {
  const {updateSource = 'https://raw.githubusercontent.com/wuwu50/ednote-live-recorder-/main/version.json'} = await chrome.storage.local.get('updateSource');
  return {currentVersion:chrome.runtime.getManifest().version,url:updateSource};
}
async function saveUpdateSource(value) {
  const url = value.trim() ? updateHttpsUrl(value.trim()).href : '';
  if (url && !(await chrome.permissions.contains({origins:[updateHostPattern(new URL(url))]}))) {
    throw new Error('尚未允許連線至更新來源，請重新按「儲存來源」並允許。');
  }
  await chrome.storage.local.set({updateSource:url});
  return getUpdateSettings();
}
let updateInFlight = null;
async function checkForUpdate() {
  if (updateInFlight) return updateInFlight;
  updateInFlight = fetchUpdateInfo();
  try { return await updateInFlight; } finally { updateInFlight = null; }
}
async function fetchUpdateInfo() {
  const settings = await getUpdateSettings();
  if (!settings.url) throw new Error('尚未設定更新来源。請先填入版本 JSON 的 HTTPS 網址並儲存。');
  const url = updateHttpsUrl(settings.url);
  if (!(await chrome.permissions.contains({origins:[updateHostPattern(url)]}))) throw new Error('更新來源的連線權限未開啟，請重新儲存來源並允許。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),12000);
  try {
    const response = await fetch(url.href,{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal,headers:{Accept:'application/json'}});
    if (!response.ok) throw new Error(`伺服器回應 HTTP ${response.status}。`);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new Error('版本資料超過 64 KB。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    let info;
    try { info = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new Error('來源不是有效的版本 JSON。'); }
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('版本資料格式錯誤。');
    const comparison = compareUpdateVersions(info.version,settings.currentVersion);
    let downloadUrl = '';
    if (info.downloadUrl !== undefined && info.downloadUrl !== '') downloadUrl = updateHttpsUrl(info.downloadUrl).href;
    if (comparison > 0 && !downloadUrl) throw new Error('新版資料缺少 downloadUrl 下載網址。');
    if (info.notes !== undefined && typeof info.notes !== 'string') throw new Error('更新說明 notes 必須是文字。');
    return {currentVersion:settings.currentVersion,latestVersion:info.version,available:comparison > 0,
      sourceBehind:comparison < 0,downloadUrl:comparison > 0 ? downloadUrl : '',notes:(info.notes || '').slice(0,4000),checkedAt:Date.now()};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('檢查更新逾時，請稍後再試。');
    if (error instanceof TypeError) throw new Error('無法連線至更新來源。請確認網路、網址，並使用不需登入且不重新導向的 JSON 連結。');
    throw error;
  } finally { clearTimeout(timeout); }
}
