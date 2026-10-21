const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('extension/updates.js','utf8');
let stored = {updateSource:''}, granted = true, calls = 0, payload = {}, status = 200, networkError = null;
const ctx = vm.createContext({URL,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,TypeError,
  chrome:{runtime:{getManifest:()=>({version:'1.2.0'})},storage:{local:{async get(){return {...stored}},async set(data){Object.assign(stored,data)}}},permissions:{async contains(){return granted}}},
  async fetch(url,options){
    calls++; assert.equal(options.credentials,'omit'); assert.equal(options.cache,'no-store'); assert.equal(options.redirect,'error');
    assert.equal(url,stored.updateSource);
    if(networkError)throw networkError;
    return new Response(typeof payload==='string' ? payload : JSON.stringify(payload),{status});
  }
});
vm.runInContext(source,ctx);
(async()=>{
  assert.equal(ctx.compareUpdateVersions('1.10.0','1.2.0'),1);
  assert.equal(ctx.compareUpdateVersions('1.2','1.2.0.0'),0);
  assert.equal(ctx.compareUpdateVersions('1.1.9','1.2.0'),-1);
  for(const bad of ['1.2-beta','1.2.3.4.5','65536.1',null])assert.throws(()=>ctx.compareUpdateVersions(bad,'1.2.0'));
  for(const bad of ['http://example.com/a','javascript:alert(1)','https://user:pass@example.com/a','https://example.com/a#b'])assert.throws(()=>ctx.updateHttpsUrl(bad));
  await assert.rejects(ctx.checkForUpdate(),/尚未設定/);assert.equal(calls,0);
  await ctx.saveUpdateSource('https://example.com/version.json');
  payload={version:'1.10.0',downloadUrl:'https://example.com/release.zip',notes:'new'};
  const [a,b]=await Promise.all([ctx.checkForUpdate(),ctx.checkForUpdate()]);
  assert(a.available && b.available);assert.equal(calls,1,'deduplicate simultaneous checks');
  assert.equal(a.latestVersion,'1.10.0');
  payload={version:'1.2.0'};assert(!(await ctx.checkForUpdate()).available);
  payload={version:'1.1.0'};assert((await ctx.checkForUpdate()).sourceBehind);
  payload={version:'2.0.0'};await assert.rejects(ctx.checkForUpdate(),/缺少 downloadUrl/);
  payload={version:'2.0.0',downloadUrl:'javascript:alert(1)'};await assert.rejects(ctx.checkForUpdate(),/HTTPS/);
  payload='not json';await assert.rejects(ctx.checkForUpdate(),/有效的版本 JSON/);
  payload='x'.repeat(65537);await assert.rejects(ctx.checkForUpdate(),/64 KB/);
  payload={version:'1.2.0'};status=404;await assert.rejects(ctx.checkForUpdate(),/HTTP 404/);
  status=200;networkError=new TypeError('network failed');await assert.rejects(ctx.checkForUpdate(),/無法連線/);
  networkError=Object.assign(new Error('abort'),{name:'AbortError'});await assert.rejects(ctx.checkForUpdate(),/逾時/);
  networkError=null;assert(!(await ctx.checkForUpdate()).available,'retry after failure');
  granted=false;await assert.rejects(ctx.checkForUpdate(),/連線權限/);
  await assert.rejects(ctx.saveUpdateSource('https://other.example/version.json'),/尚未允許/);
  assert.equal(stored.updateSource,'https://example.com/version.json');
  await ctx.saveUpdateSource('');await assert.rejects(ctx.checkForUpdate(),/尚未設定/);
  console.log('PASS: numeric version ordering, missing source, HTTPS validation, permission denial, newest/older versions, single-flight, malformed/oversize data, HTTP/network/timeout errors, retry, disabling source.');
})().catch(e=>{console.error(e);process.exitCode=1});
