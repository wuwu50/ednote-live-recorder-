const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const host='5f0c0b43000000000101fb9c';
const icon='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
(async()=>{
 const ctx=await chromium.launchPersistentContext(path.resolve('build/browser-test-'+Date.now()),{executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,viewport:{width:960,height:720},args:['--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required'],ignoreDefaultArgs:['--disable-extensions']});
 try{
  const cdp=await ctx.browser().newBrowserCDPSession();const {id:extension}=await cdp.send('Extensions.loadUnpacked',{path:path.resolve('extension')});
  let live=true,mode=process.argv[2]||'new-tab';
  await ctx.route('https://www.rednote.com/**',route=>{
   const u=new URL(route.request().url());
   if(u.pathname.startsWith('/user/profile/'))return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><style>body{background:rgb(220,0,0);color:white}.user-avatar{cursor:pointer}</style><div class="user-info"><div class="user-avatar" role="button" onclick="${mode==='new-tab'?'window.open':'location.assign'}('/livestream/fixture/123?host_id=${host}'${mode==='new-tab'?",'_blank'":''})"><img width="50" height="50" src="${icon}">${live?'<span class="live-badge">直播中</span>':''}</div><div class="user-name">指定主播</div></div><div class="reds-tabs-list">筆記 收藏</div><div class="feeds-container"><section class="note-item">個人主頁，不應錄到紅色畫面</section></div>`});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><style>body{margin:0;background:rgb(0,220,0)}video{width:100vw;height:90vh;object-fit:fill}</style><div class="host-info"><a href="/user/profile/${host}">指定主播</a></div><video autoplay muted playsinline></video><script>const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let n=0;setInterval(()=>{x.fillStyle='rgb(0,220,0)';x.fillRect(0,0,640,360);x.fillStyle='black';x.font='24px sans-serif';x.fillText('LIVE ROOM '+n++,20,50)},40);const stream=c.captureStream(25);const ac=new AudioContext(),dest=ac.createMediaStreamDestination(),tone=ac.createOscillator();tone.connect(dest);tone.start();stream.addTrack(dest.stream.getAudioTracks()[0]);document.querySelector('video').srcObject=stream;</script>`});
  });
  const source=await ctx.newPage();await source.goto(`https://www.rednote.com/user/profile/${host}`);
  const targets=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
  const tabTarget=targets.targetInfos.find(t=>t.url===source.url());assert(tabTarget,JSON.stringify(targets));
  await source.bringToFront();
  console.log('Loaded extension',extension);await cdp.send('Extensions.triggerAction',{id:extension,targetId:tabTarget.targetId});console.log('Granted source action');
  const worker=ctx.serviceWorkers().find(w=>w.url().includes(extension)) || await ctx.waitForEvent('serviceworker');await worker.evaluate(()=>Promise.resolve());
  if(worker){console.log('ACTION',await worker.evaluate(async()=>({listeners:chrome.action.onClicked.hasListeners(),session:await chrome.storage.session.get('panelTarget')})));await worker.evaluate(async host=>{const [tab]=await chrome.tabs.query({url:`https://www.rednote.com/user/profile/${host}*`});return handle({type:'open-panel',tabId:tab.id})},host)}
  let panel=ctx.pages().find(p=>p.url().endsWith('/panel.html'));
  for(let i=0;!panel&&i<100;i++){await source.waitForTimeout(100);panel=ctx.pages().find(p=>p.url().endsWith('/panel.html'))}
  if(!panel){console.log('PAGES',ctx.pages().map(p=>p.url()));for(const w of ctx.serviceWorkers())console.log('WORKER',w.url(),await w.evaluate(()=>chrome.storage.local.get('lastError')));throw Error('Controller did not open')}
  await panel.waitForLoadState();await panel.waitForTimeout(1200);
  await panel.evaluate(()=>{window.showDirectoryPicker=async()=>{return (await navigator.storage.getDirectory()).getDirectoryHandle('fixture-output',{create:true})}});
  await panel.locator('#choose-folder:not([disabled])').click();
  await panel.waitForTimeout(800);
  console.log('PREFLIGHT',await panel.evaluate(()=>({folder:document.querySelector('#folder-status').textContent,error:document.querySelector('#error').textContent,busy,folderReady,folderLoading,target,state,liveState})));
  await panel.waitForFunction(()=>!document.querySelector('#live-arm').disabled,null,{timeout:10000});
  await panel.locator('#live-arm').click();
  for(let i=0;i<100;i++){
   const status=await panel.evaluate(async()=>({live:(await chrome.runtime.sendMessage({target:'background',type:'live-status'})).data,rec:(await chrome.runtime.sendMessage({target:'background',type:'status'})).data}));
   if(status.rec?.phase==='recording'){
    console.log('RECORDING',JSON.stringify({room:source.url(),tab:status.rec.tabId,armed:status.rec.armedTabId,receipt:status.live.recordingCheck}));break;
   }
   if(i===99){console.log('SOURCE DOM',await source.evaluate(()=>({url:location.href,html:document.body.innerHTML.slice(0,1600),nodes:[...document.querySelectorAll('.user-info,.live-badge')].map(n=>({cls:n.className,text:n.innerText,rects:n.getClientRects().length,opacity:getComputedStyle(n).opacity,display:getComputedStyle(n).display,visible:getComputedStyle(n).visibility}))})));throw Error('Did not record: '+JSON.stringify(status))}
   await panel.waitForTimeout(200);
  }
  let status=await panel.evaluate(async()=>(await chrome.runtime.sendMessage({target:'background',type:'status'})).data);
  assert.equal(status.phase,'recording');assert.equal(status.tabId,status.armedTabId);
  assert(source.url().includes('/livestream/'),'authorized original tab navigated to the room');
  assert.equal(ctx.pages().filter(p=>p.url().includes('/livestream/')).length,1,'auxiliary live tab is closed after redirect');
  await source.bringToFront();await source.waitForTimeout(2500);
  const badge=await panel.evaluate(()=>chrome.action.getBadgeText({}));assert.equal(badge,'錄');
  live=false;await source.evaluate(()=>{document.body.insertAdjacentHTML('afterbegin','<h1>直播已结束</h1>')});
  for(let i=0;i<2;i++)await panel.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'live-check'}));
  for(let i=0;i<100;i++){
   status=await panel.evaluate(async()=>(await chrome.runtime.sendMessage({target:'background',type:'status'})).data);
   if(status.phase==='idle'&&status.jobs.length===0)break;
   await panel.waitForTimeout(100);
  }
  const saved=await panel.evaluate(async()=>{
   const folder=await OutputFolder.stored(),items=[];
   for await(const [name,handle] of folder.entries()){
    if(!name.endsWith('.mp4'))continue;
    const file=await handle.getFile(),video=document.createElement('video');video.muted=true;video.src=URL.createObjectURL(file);
    await new Promise((r,j)=>{video.onloadeddata=r;video.onerror=()=>j(Error('cannot decode MP4'));video.load()});
    video.currentTime=Math.min(.5,video.duration/2);await new Promise(r=>video.onseeked=r);
    const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const x=c.getContext('2d');x.drawImage(video,0,0);const pixel=[...x.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data];
    items.push({name,bytes:file.size,width:c.width,height:c.height,duration:video.duration,pixel});
   }
   return items;
  });
  assert.equal(saved.length,1);assert(saved[0].pixel[1]>100&&saved[0].pixel[0]<80,'saved MP4 contains green live-room pixels, not red profile pixels');
  console.log('PASS REAL EXTENSION',JSON.stringify(saved));
  await panel.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'live-disarm'}));
 }finally{await ctx.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
