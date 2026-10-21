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
  // Only explicit ended signals stop a recording; buffering and missing DOM do not.
  decision(sample, previous = {}) {
    if (sample.kind === 'ended') {
      const endedCount = (previous.endedCount || 0) + 1;
      return {action:endedCount >= 2 ? 'ended' : 'wait',endedCount};
    }
    if (sample.kind === 'playing') return {action:'record',endedCount:0};
    if (sample.kind === 'live-link') return {action:'open',endedCount:0};
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
    if (/直播已结束|直播已結束|本场直播已结束|主播已下播|直播结束了|直播結束了/.test(text)) return {kind:'ended'};
    const video = [...document.querySelectorAll('video')].find(v=>!v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0);
    if (video) return {kind:'playing',title:document.title};
    return {kind:'unknown'};
  }
  // Do not inspect recommendation links: require a live label and ownership.
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.href,location.href); } catch (_) { continue; }
    if (u.protocol !== 'https:' || !['www.xiaohongshu.com','www.rednote.com'].includes(u.hostname) || !u.pathname.startsWith('/livestream/')) continue;
    if (!/直播中|正在直播|直播进行中|直播進行中/.test(a.innerText || a.getAttribute('aria-label') || '')) continue;
    const owner = u.searchParams.get('host_id');
    if (owner && owner !== hostId) continue;
    // Links emitted by this profile stay in its origin to retain capture authorization.
    if (u.origin !== here.origin) continue;
    u.searchParams.set('host_id',hostId);
    return {kind:'live-link',url:u.href};
  }
  if (/当前未开播|目前未開播|暂未开播|暫未開播|暂未直播|暫未直播|主播未开播|主播未開播/.test(text)) return {kind:'offline'};
  return {kind:'unknown'};
}
if (typeof module !== 'undefined') module.exports = {LiveDetector,probeLivePage};
