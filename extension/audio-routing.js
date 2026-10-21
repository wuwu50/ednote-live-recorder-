// Changes only the captured tab after tabCapture has suppressed local playback.
let audioTransition = Promise.resolve();
function audioLocked(action) {
  const result = audioTransition.then(action);
  audioTransition = result.catch(() => {});
  return result;
}
function prepareCapturedAudio(tabId) {
  return audioLocked(async () => {
    const tab = await chrome.tabs.get(tabId);
    const originallyMuted = tab.mutedInfo?.muted === true;
    await chrome.storage.session.set({captureAudio:{tabId,restoreMuted:originallyMuted}});
    if (originallyMuted) await chrome.tabs.update(tabId,{muted:false});
    return {originallyMuted};
  });
}
function restoreCapturedAudio() {
  return audioLocked(async () => {
    const {captureAudio} = await chrome.storage.session.get('captureAudio');
    if (!captureAudio) return;
    // Remove before restoring to avoid responding to our own mute event.
    await chrome.storage.session.remove('captureAudio');
    if (!captureAudio.restoreMuted) return;
    let tab;
    try { tab = await chrome.tabs.get(captureAudio.tabId); }
    catch (_) { return; } // Closed tab has no audio state to restore.
    if (!tab.mutedInfo?.muted) await chrome.tabs.update(tab.id,{muted:true});
  });
}
function capturedTabMuted(tabId,change) {
  if (!change.mutedInfo?.muted) return Promise.resolve();
  return audioLocked(async () => {
    const {captureAudio} = await chrome.storage.session.get('captureAudio');
    if (!captureAudio || captureAudio.tabId !== tabId) return;
    // Respect the user's intention to silence speakers while retaining capture.
    await offscreen('monitor-off');
    await chrome.storage.session.set({captureAudio:{...captureAudio,restoreMuted:true}});
    await chrome.tabs.update(tabId,{muted:false});
  });
}
