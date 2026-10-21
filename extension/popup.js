// Compatibility entry point; all controls now live in panel.html.
async function openController() {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    const response = await chrome.runtime.sendMessage({target:'background',type:'open-panel',tabId:tab?.id});
    if (!response?.ok) throw new Error(response?.error || '無法開啟控制視窗');
    window.close();
  } catch (error) { document.getElementById('status').textContent = error.message; }
}
document.getElementById('open-panel').addEventListener('click',openController);
void openController();
