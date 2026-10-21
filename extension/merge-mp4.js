// Re-mux encoded packets. Never concatenate complete MP4 byte streams or re-encode.
const MergeMp4 = {
  async write({parts,getBlob,writable,onProgress = () => {}}) {
    const M = await import('./vendor/mediabunny.mjs');
    let output, videoSource, audioSource, videoConfig, audioConfig;
    let videoCodec, audioCodec, offset = 0, packetsWritten = 0;
    const configEqual = (a,b) => {
      if (!a || !b) return a === b;
      for (const key of ['codec','codedWidth','codedHeight','sampleRate','numberOfChannels']) if (a[key] !== b[key]) return false;
      const bytes = config => config.description ? new Uint8Array(config.description.buffer || config.description,config.description.byteOffset || 0,config.description.byteLength) : new Uint8Array();
      const x = bytes(a), y = bytes(b);
      return x.length === y.length && x.every((value,i)=>value === y[i]);
    };
    try {
      for (let index=0;index<parts.length;index++) {
        const input = new M.Input({source:new M.BlobSource(await getBlob(parts[index]),{maxCacheSize:4 * 1048576}),formats:[M.MP4]});
        let videoIterator, audioIterator;
        try {
          const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
          if (!video) throw new Error(`第 ${index+1} 段沒有可合併的畫面。`);
          const vc = await video.getDecoderConfig(), ac = audio ? await audio.getDecoderConfig() : null;
          if (!vc || (audio && !ac)) throw new Error(`第 ${index+1} 段缺少影音編碼資訊。`);
          if (!output) {
            videoCodec = video.codec; audioCodec = audio?.codec || null;
            videoConfig = vc; audioConfig = ac;
            videoSource = new M.EncodedVideoPacketSource(videoCodec);
            audioSource = audio ? new M.EncodedAudioPacketSource(audioCodec) : null;
            output = new M.Output({format:new M.Mp4OutputFormat({fastStart:false}),target:new M.StreamTarget(new WritableStream({
              write:chunk => writable.write({type:'write',position:chunk.position,data:chunk.data})
            }),{chunked:true,chunkSize:8 * 1048576})});
            output.addVideoTrack(videoSource,{rotation:video.rotation});
            if (audioSource) output.addAudioTrack(audioSource);
            await output.start();
          } else if (video.codec !== videoCodec || (audio?.codec || null) !== audioCodec || !configEqual(vc,videoConfig) || !configEqual(ac,audioConfig)) {
            throw new Error(`第 ${index+1} 段的影音編碼設定不同，請使用分段儲存。`);
          }
          const tracks = audio ? [video,audio] : [video];
          const base = await input.getFirstTimestamp(tracks);
          const end = await input.computeDuration(tracks);
          if (!Number.isFinite(base) || !Number.isFinite(end) || end <= base) throw new Error(`第 ${index+1} 段長度無法讀取。`);
          // Pull one packet at a time. The library's general-purpose iterator
          // maintains a sliding queue of every packet read in the last second;
          // fast offline remuxing makes that queue unnecessarily expensive.
          const iterator = track => {
            const sink = new M.EncodedPacketSink(track);
            let previous, started = false;
            return {async next() {
              const options = {verifyKeyPackets:track === video};
              const packet = started ? await sink.getNextPacket(previous,options) : await sink.getFirstPacket(options);
              started = true; previous = packet;
              return packet ? {done:false,value:packet} : {done:true};
            }};
          };
          videoIterator = iterator(video);
          audioIterator = audio ? iterator(audio) : null;
          let v = await videoIterator.next(), a = audioIterator ? await audioIterator.next() : {done:true};
          if (v.done || v.value.type !== 'key') throw new Error(`第 ${index+1} 段缺少起始關鍵影格，請使用分段儲存。`);
          // Interleave tracks instead of buffering all video while waiting for audio.
          let firstVideo = true, firstAudio = true, segmentEnd = base;
          while (!v.done || !a.done) {
            const isVideo = a.done || (!v.done && v.value.timestamp <= a.value.timestamp);
            const packet = isVideo ? v.value : a.value;
            const adjusted = packet.clone({timestamp:packet.timestamp - base + offset,sequenceNumber:-1});
            segmentEnd = Math.max(segmentEnd,packet.timestamp + packet.duration);
            if (isVideo) {
              await videoSource.add(adjusted,firstVideo ? {decoderConfig:vc} : undefined);
              firstVideo = false; v = await videoIterator.next();
            } else {
              await audioSource.add(adjusted,firstAudio ? {decoderConfig:ac} : undefined);
              firstAudio = false; a = await audioIterator.next();
            }
            packetsWritten++;
            onProgress({part:index+1,total:parts.length,progress:(index + Math.min(1,(segmentEnd-base)/(end-base))) / parts.length});
            // Blob reads and file writes already yield. Background setTimeout
            // can be throttled to seconds, multiplying the cost of long videos.
          }
          if (audio && firstAudio) throw new Error(`第 ${index+1} 段音訊無法讀取。`);
          offset += Math.max(end,segmentEnd) - base;
          onProgress({part:index+1,total:parts.length,progress:(index+1)/parts.length});
        } finally {
          input.dispose();
        }
      }
      if (!output || !packetsWritten) throw new Error('沒有可合併的影片。');
      await output.finalize();
      return {duration:offset,packets:packetsWritten};
    } catch (error) {
      await output?.cancel().catch(() => {});
      throw error;
    }
  }
};
