// The native installer writes this local completion marker LAST, after all files.
// A different disk manifest alone is not proof that installation has finished.
let installedUpdateCheck = null, updateReloading = false, lastInstalledCheck = 0;
let restoringReloadPanel = false;
function safeToReload(state) {
  return state && !state.armed && ['idle','error'].includes(state.phase) && !state.preparing && Array.isArray(state.jobs) && state.jobs.length === 0;
}
async function installedJson(path) {
  const response = await fetch(chrome.runtime.getURL(path)+'?installed='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(4000)});
  if (!response.ok) return null;
  const text = await response.text();
  if (text.length > 4096) return null;
  return JSON.parse(text);
}
async function checkForInstalledUpdate(force = false) {
  if (installedUpdateCheck) return installedUpdateCheck;
  if (starting || updateReloading || (!force && Date.now() - lastInstalledCheck < 5000)) return false;
  lastInstalledCheck = Date.now();
  installedUpdateCheck = (async()=>{
    const marker = await installedJson('install-complete.json');
    if (marker?.complete !== true || compareUpdateVersions(marker.version,chrome.runtime.getManifest().version) <= 0) return false;
    const disk = await installedJson('manifest.json');
    if (!disk || disk.version !== marker.version) return false;
    // Query the live manager, including recovered/failed journals. Missing state
    // or a failed message must never be interpreted as an idle recorder.
    await ensureOffscreen();
    const state = await offscreen('status');
    if (starting || !safeToReload(state)) return false;
    updateReloading = true; // Blocks a new start while the resume plan is stored.
    const saved = await chrome.storage.session.get(['panelTarget','panelWindowId']);
    let panelOpen = false;
    if (saved.panelWindowId) {
      try { await chrome.windows.get(saved.panelWindowId); panelOpen = true; } catch (_) { /* closed */ }
    }
    await chrome.storage.local.set({reloadResume:{version:marker.version,tabId:saved.panelTarget?.id || null,panelOpen}});
    // Revalidate after asynchronous storage operations: captures and background
    // work must still be idle, and the completion marker must still exist.
    const finalMarker = await installedJson('install-complete.json');
    const latestState = await offscreen('status');
    if (starting || finalMarker?.complete !== true || finalMarker.version !== marker.version || !safeToReload(latestState)) {
      await chrome.storage.local.remove('reloadResume'); updateReloading = false; return false;
    }
    chrome.runtime.reload(); return true;
  })().catch(()=>{updateReloading = false; return false;});
  try { return await installedUpdateCheck; } finally { installedUpdateCheck = null; }
}
async function restoreReloadPanel() {
  if (restoringReloadPanel) return;
  restoringReloadPanel = true;
  try {
    const {reloadResume:plan} = await chrome.storage.local.get('reloadResume');
    if (!plan || compareUpdateVersions(chrome.runtime.getManifest().version,plan.version) < 0) return;
    await chrome.storage.local.remove('reloadResume');
    if (!plan.panelOpen) return;
    if (Number.isInteger(plan.tabId)) {
      try {
        const tab = await chrome.tabs.get(plan.tabId);
        await chrome.storage.session.set({panelTarget:{id:tab.id,title:tab.title || 'Chrome 分頁',url:tab.url || ''}});
      } catch (_) { /* Target was closed during installation. */ }
    }
    const window = await chrome.windows.create({url:chrome.runtime.getURL('panel.html'),type:'popup',width:960,height:790});
    await chrome.storage.session.set({panelWindowId:window.id});
  } finally { restoringReloadPanel = false; }
}
function setupInstalledUpdateWatch() {
  // One minute also works on Chrome 116; open control windows trigger faster checks.
  chrome.alarms.create('installed-update',{periodInMinutes:1}).catch(()=>{});
  chrome.alarms.onAlarm.addListener(alarm=>{
    if (alarm.name === 'installed-update') void checkForInstalledUpdate(true);
  });
  chrome.runtime.onInstalled.addListener(()=>{void restoreReloadPanel().catch(()=>{});});
  void restoreReloadPanel().catch(()=>{});
}
