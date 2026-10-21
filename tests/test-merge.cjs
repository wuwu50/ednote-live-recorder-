const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const extension=path.resolve(__dirname,'../extension');
(async()=>{
 const M=await import(pathToFileURL(path.join(extension,'vendor/mediabunny.mjs')).href);
 const code=fs.readFileSync(path.join(extension,'merge-mp4.js'),'utf8').replace("'./vendor/mediabunny.mjs'",JSON.stringify(pathToFileURL(path.join(extension,'vendor/mediabunny.mjs')).href));
 const merger=new Function(code+'; return MergeMp4;')();
 const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'merge-fixtures.json'),'utf8'));const blobs=fixture.segments.map(x=>new Blob([Buffer.from(x,'base64')],{type:'video/mp4'}));
 const writes=[];let maxPosition=0;const writable={async write(chunk){writes.push({position:chunk.position,data:Buffer.from(chunk.data)});maxPosition=Math.max(maxPosition,chunk.position+chunk.data.length)}};
 const progress=[];const result=await merger.write({parts:[0,1],getBlob:async i=>blobs[i],writable,onProgress:p=>progress.push(p)});
 const bytes=Buffer.alloc(maxPosition);for(const w of writes)w.data.copy(bytes,w.position);assert.equal(bytes.toString('ascii',4,8),'ftyp');assert(progress.at(-1).progress===1);
 const merged=new M.Input({source:new M.BlobSource(new Blob([bytes])),formats:[M.MP4]});const mergedVideo=await merged.getPrimaryVideoTrack(),mergedAudio=await merged.getPrimaryAudioTrack();assert(mergedVideo&&mergedAudio);
 async function packets(track){const values=[];for await(const p of new M.EncodedPacketSink(track).packets())values.push({hash:crypto.createHash('sha256').update(p.data).digest('hex'),timestamp:p.timestamp,duration:p.duration});return values}
 let originalsV=[],originalsA=[],expectedDuration=0;let vc,firstPacket;
 for(const blob of blobs){const input=new M.Input({source:new M.BlobSource(blob),formats:[M.MP4]});const v=await input.getPrimaryVideoTrack(),a=await input.getPrimaryAudioTrack();originalsV.push(...await packets(v));originalsA.push(...await packets(a));expectedDuration+=await input.computeDuration()-await input.getFirstTimestamp();if(!vc){vc=await v.getDecoderConfig();firstPacket=await new M.EncodedPacketSink(v).getFirstPacket()}input.dispose()}
 const finalV=await packets(mergedVideo),finalA=await packets(mergedAudio);assert.deepEqual(finalV.map(x=>x.hash),originalsV.map(x=>x.hash),'video must not be re-encoded, dropped or reordered');assert.deepEqual(finalA.map(x=>x.hash),originalsA.map(x=>x.hash),'audio must not be re-encoded or lost');
 assert(Math.abs(await merged.computeDuration()-expectedDuration)<0.03);assert(Math.abs(result.duration-expectedDuration)<0.03);merged.dispose();
 await assert.rejects(merger.write({parts:[0,1],getBlob:async i=>i===0?blobs[0]:new Blob(['broken MP4']),writable}),/./);
 await assert.rejects(merger.write({parts:[0,1],getBlob:async i=>blobs[i],writable:{async write(){throw Error('disk full')}}}),/disk full/);
 console.log('PASS: actual H.264/AAC fixtures merge with identical video/audio packet bytes, preserved order and duration, corrupt input and write errors reject.');
 // Exercise 64-bit MP4 positions past 4 GiB without filling the user's disk.
 let highest=0,co64=false;const target=new M.StreamTarget(new WritableStream({write(chunk){highest=Math.max(highest,chunk.position+chunk.data.length);if(chunk.data.length<1048576&&Buffer.from(chunk.data).includes(Buffer.from('co64')))co64=true}}));
 const output=new M.Output({format:new M.Mp4OutputFormat({fastStart:false}),target});const source=new M.EncodedVideoPacketSource('avc');output.addVideoTrack(source);await output.start();
 const data=new Uint8Array(1048576);data.set(firstPacket.data);for(let i=0;i<4220;i++){await source.add(new M.EncodedPacket(data,'key',i/120,1/120),i===0?{decoderConfig:vc}:undefined);if(i%256===0)await new Promise(r=>setTimeout(r,0))}await output.finalize();assert(highest>4294967296);assert(co64,'large MP4 must use 64-bit chunk offsets');
 console.log('PASS: MP4 output crossed 4 GiB using 64-bit co64 offsets with a reusable 1 MiB buffer and no disk allocation.',{highest});
})().catch(e=>{console.error(e);process.exitCode=1});
