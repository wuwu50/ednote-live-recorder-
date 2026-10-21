// One priority decision combines capture, export and livestream observations.
const ToolbarStatus = {
  queue:Promise.resolve(),
  last:'',
  resolve(recorder = {},observation = null,monitor = {},now = Date.now()) {
    const prefix = '小紅書直播錄影機｜';
    const suffix = monitor.enabled ? '｜自動待命已啟用' : '｜自動待命未啟用';
    const result = (text,color,label)=>({text,color,title:prefix+label+suffix});
    if (['recording','rotating'].includes(recorder.phase)) return result('錄','#cf2849',recorder.phase === 'rotating' ? '正在錄影（分段保護切換中）' : '正在錄影');
    if (recorder.error || recorder.phase === 'error' || (recorder.jobs || []).some(job=>job.error)) return result('!','#b45b00','錄影／存檔需要處理，點擊查看原因');
    const fresh = observation && now - observation.checkedAt <= 120000 && now >= observation.checkedAt;
    const time = observation?.checkedAt ? `｜最後檢查 ${new Date(observation.checkedAt).toLocaleString('zh-TW')}` : '';
    if (fresh && observation.state === 'live') return result('直','#087f62','直播中，尚未錄影'+time);
    if (['saving','merging','downloading'].includes(recorder.phase) || (recorder.jobs || []).some(job=>['queued','saving','merging','downloading'].includes(job.phase))) return result('存','#275bb0','正在儲存影片');
    if (fresh && ['offline','ended'].includes(observation.state)) return result('未','#596579',(observation.state === 'ended' ? '直播已結束' : '目前未開播')+time);
    return result('？','#946200',(observation ? fresh ? '目前無法確認直播狀態' : '上次結果已過期，請重新檢查' : '尚未檢查直播狀態')+time);
  },
  run(fn) {
    const result = this.queue.catch(()=>{}).then(fn);
    this.queue = result.catch(()=>{}); return result;
  },
  refresh() { return this.run(()=>this.paint()); },
  record(state) { return this.run(async()=>{
    await chrome.storage.session.set({toolbarRecorder:{phase:state.phase || 'idle',error:state.error || '',preparing:!!state.preparing,jobs:(state.jobs || []).map(job=>({phase:job.phase,error:job.error || ''}))}});
    return this.paint();
  }); },
  async paint() {
    const [saved,observed,watched] = await Promise.all(['toolbarRecorder','liveObservation','liveMonitor'].map(key=>chrome.storage.session.get(key)));
    let recorder = saved.toolbarRecorder || {};
    if (['recording','rotating'].includes(recorder.phase)) {
      try {
        const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
        if (!contexts.length) recorder = {phase:'error',error:'擷取中斷'};
      } catch (_) { recorder = {phase:'error',error:'無法確認擷取狀態'}; }
    }
    const status = this.resolve(recorder,observed.liveObservation,watched.liveMonitor || {});
    const signature = JSON.stringify(status);
    if (signature === this.last) return status;
    await chrome.action.setBadgeBackgroundColor({color:status.color});
    await chrome.action.setBadgeText({text:status.text});
    await chrome.action.setTitle({title:status.title});
    this.last = signature; return status;
  },
  setup() {
    chrome.alarms.create('toolbar-status',{periodInMinutes:1}).catch(()=>{});
    chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name === 'toolbar-status') void this.refresh().catch(()=>{});});
    void this.refresh().catch(()=>{});
  }
};
if (typeof module !== 'undefined') module.exports = ToolbarStatus;
