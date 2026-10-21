// Local, bounded diagnostics. Never save query strings, page text, cookies or media.
let traceWrites = Promise.resolve();
function diagnosticText(value) {
  return String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, value=>{try{const u=new URL(value);return u.origin+u.pathname;}catch(_){return '[網址已隱藏]';}})
    .replace(/(?:[a-z]:\\|\\\\)[^\r\n<>"']+/gi,'[本機路徑已隱藏]')
    .replace(/(xsec_token|access_token|authorization|cookie|token)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[^\s,;"'}]+/gi,'$1=[已隱藏]').slice(0,1200);
}
function traceEvent(event, fields = {}) {
  const entry={time:new Date().toISOString(),event:diagnosticText(event)};
  for(const key of ['hostId','tabId','sourceTabId','phase','kind','action','detail','error','reason','endedCount','armed','jobs','bytes','ready','note','evidence']) {
    const value=fields[key];
    if(value === undefined)continue;
    entry[key]=typeof value === 'number' || typeof value === 'boolean' ? value : diagnosticText(value);
  }
  traceWrites=traceWrites.catch(()=>{}).then(async()=>{
    const rows=(await chrome.storage.local.get('workflowDiagnostics')).workflowDiagnostics || [];
    const cutoff=Date.now()-7*86400000;
    await chrome.storage.local.set({workflowDiagnostics:[...rows.filter(row=>Date.parse(row.time)>=cutoff),entry].slice(-500)});
  }).catch(()=>{}); // Logging must not interrupt capture or discard footage.
  return traceWrites;
}
async function diagnosticPageSnapshot() {
  const count=selector=>document.querySelectorAll(selector).length;
  return {readyState:document.readyState,profileHeaders:count('.user-info,[data-testid="profile-header"]'),feeds:count('.feeds-container'),liveLabels:count('.live-status,.live-tag,.live-badge,[data-live-status="live"]'),
    videos:[...document.querySelectorAll('video')].slice(0,5).map(v=>({paused:v.paused,ended:v.ended,readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,visible:!!v.getClientRects().length}))};
}
async function diagnosticReport() {
  await traceWrites;
  await diagnosticWrites;
  const local=await chrome.storage.local.get('diagnostics');
  const entries=(local.diagnostics || []).map(row=>({...row,reason:diagnosticText(row.reason)}));
  const workflow=(await chrome.storage.local.get('workflowDiagnostics')).workflowDiagnostics || [];
  return {schema:2,version:chrome.runtime.getManifest().version,exportedAt:new Date().toISOString(),browser:diagnosticText(typeof navigator === 'undefined' ? '' : navigator.userAgent),retention:'最多500筆流程紀錄／7天，另保留40筆錄影指標；只存本機，不自動上傳。',entries,workflow};
}
