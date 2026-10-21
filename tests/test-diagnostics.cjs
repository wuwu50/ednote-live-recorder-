const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
(async()=>{
 const local={workflowDiagnostics:[{time:'2000-01-01T00:00:00Z',event:'expired'}]};let fail=false;
 const ctx=vm.createContext({URL,Date,Promise,diagnosticWrites:Promise.resolve(),chrome:{runtime:{getManifest:()=>({version:'0.5.0'})},storage:{local:{get:async key=>({[key]:local[key]}),set:async v=>{if(fail)throw Error('disk full');Object.assign(local,v);}}}}});
 vm.runInContext(fs.readFileSync('extension/diagnostics.js','utf8'),ctx);
 const call=code=>vm.runInContext(code,ctx);
 ctx.fields={detail:'https://www.rednote.com/path?xsec_token=SECRET#SECRET',note:'token=SECRET',url:'SECRET',title:'SECRET',error:['C:','Users','private','video.mp4'].join(String.fromCharCode(92))};
 await call("traceEvent('test',fields)");
 let text=JSON.stringify(local);assert(!text.includes('SECRET'));assert(!text.includes('private'));assert(!text.includes('expired'));
 await call(`Promise.all(Array.from({length:510},(_,i)=>traceEvent('step',{bytes:i})))`);
 assert.equal(local.workflowDiagnostics.length,500);assert.equal(local.workflowDiagnostics[0].bytes,10);assert.equal(local.workflowDiagnostics[499].bytes,509);
 fail=true;await call(`traceEvent('logging-failure')`);fail=false;await call(`traceEvent('recovered')`);
 assert.equal(local.workflowDiagnostics.at(-1).event,'recovered','storage failure never poisons later events');
 local.diagnostics=[{reason:'failed https://example.com/a?token=SECRET'}];const report=await call('diagnosticReport()');assert.equal(report.schema,2);assert(!JSON.stringify(report).includes('SECRET'));
 console.log('PASS: serialized bounded 7-day diagnostics, URL/token/path redaction, allowlisted fields, storage failure isolation, legacy export sanitization.');
})().catch(error=>{console.error(error);process.exitCode=1});
