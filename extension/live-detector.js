// Pure decisions are shared with tests. The DOM probe runs only in the armed tab.
const LiveDetector = {
  hostId(value) {
    if (!/^[0-9a-f]{24}$/i.test(value || '')) throw new Error('主播 ID 必須是 24 位英數字，例如預設帳號。');
    return value.toLowerCase();
  },
  allowed(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && ['www.xiaohongshu.com','www.rednote.com'].includes(u.hostname) && !u.username && !u.password; }
    catch (_) { return false; }
  },
  belongs(value, hostId) {
    if (!this.allowed(value)) return false;
    const u = new URL(value);
    return u.pathname.replace(/\/$/,'') === `/user/profile/${hostId}` || (u.pathname.startsWith('/livestream/') && u.searchParams.get('host_id') === hostId);
  },
  room(value,hostId) {
    if (!this.allowed(value)) return false;
    const url = new URL(value),owner=url.searchParams.get('host_id');
    return url.pathname.startsWith('/livestream/') && (!owner || owner === hostId);
  },
  // Only explicit ended signals stop a recording; buffering and missing DOM do not.
  decision(sample, previous = {}) {
    if (sample.kind === 'ended') {
      const endedCount = (previous.endedCount || 0) + 1;
      return {action:endedCount >= 2 ? 'ended' : 'wait',endedCount};
    }
    if (sample.kind === 'playing') return {action:'record',endedCount:0};
    if (sample.kind === 'live-link') return {action:'open',endedCount:0};
    if (sample.kind === 'live-indicator' && sample.entryToken) return {action:'click',endedCount:0};
    return {action:'wait',endedCount:0};
  }
};

function probeLivePage(hostId, knownRoom = '') {
  const here = new URL(location.href);
  const profile = here.pathname.replace(/\/$/,'') === `/user/profile/${hostId}`;
  const room = here.pathname.startsWith('/livestream/');
  if (!profile && !room) return {kind:'wrong-page'};
  const text = document.body?.innerText || '';
  if (/请完成验证|請完成驗證|安全验证|安全驗證|访问频繁|訪問頻繁/.test(text)) return {kind:'blocked'};
  if (room) {
    if (here.searchParams.get('host_id') !== hostId && here.href !== knownRoom) return {kind:'wrong-page'};
    const owners = [...(document.querySelectorAll?.('.anchor-info a[href],.host-info a[href],.streamer-info a[href],.live-author a[href],[data-testid="live-host"] a[href]') || [])].map(link=>{
      try { const url=new URL(link.href,here.href);return url.pathname.match(/^\/user\/profile\/([0-9a-f]{24})\/?$/i)?.[1]?.toLowerCase(); }catch(_){return null;}
    }).filter(Boolean);
    if (owners.length && !owners.includes(hostId)) return {kind:'wrong-host',detail:'直播間顯示的主播與指定帳號不同，已拒絕自動錄影。'};
    const ownerVerified = here.searchParams.get('host_id') === hostId || owners.includes(hostId);
    if (/直播已结束|直播已結束|本场直播已结束|主播已下播|直播结束了|直播結束了/.test(text)) return {kind:'ended'};
    const video = [...document.querySelectorAll('video')].find(v=>!v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0);
    if (video && ownerVerified) return {kind:'playing',title:document.title,ownerProof:owners.includes(hostId) ? '直播間主播連結' : '直播網址主播 ID'};
    if (video) return {kind:'unknown',detail:'直播影片已播放，但尚無法核對主播帳號，暫不開始錄影。'};
    const paused = [...document.querySelectorAll('video')].find(v=>v.paused && !v.ended && v.readyState >= 2);
    if (paused && ownerVerified && typeof paused.play === 'function' && !paused.dataset.rednotePlaybackAttempt) {
      paused.dataset.rednotePlaybackAttempt='1';void paused.play().catch(()=>{});
    }
    return {kind:'room-pending',retryAfterMs:2200,detail:'已開啟直播間，等待指定主播影片實際播放；若瀏覽器阻擋自動播放，請在直播頁按播放。'};
  }
  const query = (scope,selector)=>scope.querySelectorAll ? [...scope.querySelectorAll(selector)] : [];
  const visible = node=>{
    if (!node || (node.getClientRects && !node.getClientRects().length)) return false;
    if (typeof getComputedStyle === 'function') {
      for (let current=node;current?.nodeType === 1;current=current.parentElement) {
        const style=getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
    }
    return true;
  };
  const profileHeaders = query(document,'.user-info, .user-page .user-info, [data-testid="profile-header"], [data-testid="user-profile-header"]').filter(visible);
  const firstCard = query(document,'.feeds-container .note-item, .feeds-container section, [data-testid="profile-feed"] [data-testid="note-card"]').find(visible);
  const banners = query(document,'.user-page [class*="live-banner"],.user-page [class*="live-tip"],[data-testid="profile-live-banner"]').filter(visible);
  const scopes = [...profileHeaders,...banners,...(firstCard ? [firstCard] : [])];
  // Do not inspect recommendation links: require a live label and ownership.
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.href,location.href); } catch (_) { continue; }
    if (u.protocol !== 'https:' || !['www.xiaohongshu.com','www.rednote.com'].includes(u.hostname) || !u.pathname.startsWith('/livestream/')) continue;
    if (!/直播中|正在直播|直播进行中|直播進行中/.test(a.innerText || a.getAttribute('aria-label') || '')) continue;
    const owner = u.searchParams.get('host_id');
    if (owner && owner !== hostId) continue;
    if (scopes.length && !scopes.some(scope=>scope.contains(a)) && owner !== hostId) continue;
    // Links emitted by this profile stay in its origin to retain capture authorization.
    if (u.origin !== here.origin) continue;
    return {kind:'live-link',url:u.href};
  }
  // Match a short status label in the author's header or first feed card,
  // not a note title/bio merely mentioning past livestreams.
  for (const scope of scopes) {
    const candidates = [...query(scope,'[data-live-status="live"], .live-status, .live-tag, .live-badge, [class*="live-status"], [class*="live-tag"], [class*="live-badge"], [aria-label], button, [role="button"], span'),scope];
    for (const node of candidates) {
      if (!visible(node) || node.closest?.('.user-desc,.user-name,.title,.note-title,.author,.author-wrapper,[data-testid="note-title"]')) continue;
      const label = (node.getAttribute?.('aria-label') || node.innerText || '').trim();
      const explicit = /^(直播中|正在直播|直播进行中|直播進行中|LIVE)$/i.test(label) || /主播正在直播中[，,\s]*[点點][击擊][进進]入直播[间間]/.test(label);
      if (!explicit && node.getAttribute?.('data-live-status') !== 'live') continue;
      const entry = node.closest?.('a,button,[role="button"],.avatar,.user-avatar,[class*="avatar"],.live-card,[data-testid="live-card"]');
      let entryToken = '';
      if (entry && scope.contains(entry)) {
        entryToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        entry.setAttribute('data-rednote-recorder-live-entry',entryToken);
      }
      return {kind:'live-indicator',entryToken,detail:'頭貼／主頁提示／首張卡片顯示直播中；尚未確認影片播放。'};
    }
  }
  const profileText = profileHeaders.length ? profileHeaders.map(node=>node.innerText || '').join('\n') : text;
  if (/当前未开播|目前未開播|暂未开播|暫未開播|暂未直播|暫未直播|主播未开播|主播未開播/.test(profileText)) return {kind:'offline'};
  if (/登录后查看|登入後查看|登录后继续|登入後繼續|页面不存在|頁面不存在|网络异常|網路異常|加载失败|載入失敗/.test(text)) return {kind:'unknown',detail:'主頁尚未正常載入，不能判斷未開播。'};
  const header = profileHeaders.find(scope=>query(scope,'.user-name,[data-testid="profile-name"]').some(node=>visible(node) && (node.innerText || '').trim()) && query(scope,'img').some(node=>visible(node) && node.complete && node.naturalWidth > 0));
  const tabs = query(document,'.reds-tabs-list,.tabs-container,[data-testid="profile-tabs"]').find(node=>visible(node) && /笔记|筆記/.test(node.innerText || ''));
  const feed = query(document,'.feeds-container,[data-testid="profile-feed"]').find(visible);
  const loading = query(document,'[aria-busy="true"],.loading,.skeleton,[class*="skeleton"]').some(visible);
  const possibleRing = profileHeaders.some(scope=>query(scope,'[class*="live-avatar"],[class*="avatar-live"],[class*="live-ring"]').some(visible));
  if (possibleRing) return {kind:'unknown',detail:'頭貼有疑似直播外框，等待文字標籤確認；不判為未開播。'};
  if (document.readyState !== 'complete' || !header || !tabs || !feed || loading) return {kind:'unknown',detail:'尚未辨識到完整的主播主頁，暫不判為未開播。'};
  const signature = (header.innerText || '').trim().slice(0,1000) + '|' + query(header,'img').map(img=>img.currentSrc || img.src || '').join('|');
  const key = here.origin + here.pathname;
  const now = Date.now();
  const previous = globalThis.__rednoteRecorderProfileSample;
  if (!previous || previous.key !== key || previous.signature !== signature) {
    globalThis.__rednoteRecorderProfileSample = {key,signature,firstSeen:now};
    return {kind:'profile-pending',retryAfterMs:5200,detail:'主播主頁已載入，等待再次確認頭貼與直播卡片狀態。'};
  }
  if (now - previous.firstSeen < 5000) return {kind:'profile-pending',retryAfterMs:5200-(now-previous.firstSeen),detail:'正在再次確認主頁直播標記。'};
  return {kind:'offline',inferred:true,detail:'主頁完整載入且再次檢查未見頭貼直播標籤、直播提示或首張直播卡片（依主頁畫面判讀）。'};
}
function clickProfileLiveEntry(hostId,token) {
  const here = new URL(location.href);
  if (here.pathname.replace(/\/$/,'') !== `/user/profile/${hostId}` || !/^[0-9]+-[a-z0-9]+$/.test(token)) return false;
  const entry = document.querySelector(`[data-rednote-recorder-live-entry="${token}"]`);
  if (!entry || !entry.getClientRects().length) return false;
  entry.removeAttribute('data-rednote-recorder-live-entry'); entry.click(); return true;
}
if (typeof module !== 'undefined') module.exports = {LiveDetector,probeLivePage};
