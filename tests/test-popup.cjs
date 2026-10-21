const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const manifest=JSON.parse(fs.readFileSync('extension/manifest.json','utf8'));
 assert.equal(manifest.action.default_popup,undefined,'toolbar must open the unified controller');
 let fail=true,closed=0,click;const messages=[],status={};
 const ctx=vm.createContext({document:{getElementById:id=>id==='status'?status:{addEventListener(_,fn){click=fn}}},
  window:{close(){closed++}},chrome:{tabs:{query:async()=>[{id:7}]},runtime:{sendMessage:async m=>{messages.push(m);return fail?{ok:false,error:'open failed'}:{ok:true}}}}});
 vm.runInContext(fs.readFileSync('extension/popup.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.equal(status.textContent,'open failed');assert.equal(closed,0);fail=false;await click();
 assert.equal(closed,1);assert(messages.every(m=>m.type==='open-panel'&&m.tabId===7));
 console.log('PASS: toolbar uses one controller; compatibility popup only routes there and supports retry.');
})().catch(e=>{console.error(e);process.exitCode=1});
