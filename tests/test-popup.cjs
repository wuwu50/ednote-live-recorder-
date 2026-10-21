const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const elements=new Map(),intervals=[];let armed=false,failQuery=false,release,scrolled=0,armCalls=0;
 function element(id){if(!elements.has(id))elements.set(id,{value:id==='host-id'?'5f0c0b43000000000101fb9c':'normal',checked:false,disabled:false,hidden:false,dataset:{},listeners:{},addEventListener(name,fn){this.listeners[name]=fn},click(){if(!this.disabled)return this.listeners.click?.()},scrollIntoView(){scrolled++}});return elements.get(id)}
 const ctx=vm.createContext({Date,Promise,console,document:{getElementById:element,activeElement:null},window:{close(){}},confirm:()=>false,
  setInterval(fn){intervals.push(fn)},setTimeout(){return 1},clearTimeout(){},
  chrome:{tabs:{query:async()=>{if(failQuery)throw Error('分頁讀取失敗');return [{id:7}]}},runtime:{sendMessage:async message=>{
   if(message.type==='live-arm'){armCalls++;return new Promise(resolve=>{release=ok=>{if(ok)armed=true;resolve(ok?{ok:true,data:{enabled:true}}:{ok:false,error:'請先選擇儲存資料夾'})}})}
   if(message.type==='live-status')return {ok:true,data:{enabled:armed}};
   return {ok:true,data:{phase:'idle',jobs:[],armed}};
  }}}});
 vm.runInContext(fs.readFileSync('extension/popup.js','utf8'),ctx);
 const flush=()=>new Promise(r=>setImmediate(r));await flush();
 const pending=element('live-arm').click();
 assert.equal(element('live-arm').textContent,'正在啟用待命…');assert(element('live-arm').disabled);
 await flush();element('live-arm').click();assert.equal(armCalls,1,'pending action cannot be submitted twice');
 release(false);await pending;
 for(let i=0;i<3;i++)await intervals[0]();
 assert(element('live-action-status').textContent.includes('待命未啟用：請先選擇儲存資料夾'));
 assert.equal(element('error').textContent,'請先選擇儲存資料夾');assert.equal(element('live-folder').hidden,false);assert.equal(scrolled,1);
 const retry=element('live-arm').click();await flush();release(true);await retry;
 assert(element('live-action-status').textContent.includes('✓ 待命已啟用'));assert.equal(element('error').textContent,'');assert(element('live-arm').disabled);
 armed=false;failQuery=true;await intervals[0]();await element('live-arm').click();
 assert(element('live-action-status').textContent.includes('分頁讀取失敗'));
 console.log('PASS: popup pending guard, visible persistent failure after polling, folder action, successful retry, tab-query failure handling.');
})().catch(e=>{console.error(e);process.exitCode=1});
