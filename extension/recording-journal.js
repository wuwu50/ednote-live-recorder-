// Each chunk is committed separately, so a lost offscreen process does not
// discard an entire recording's open writable stream.
class RecordingJournal {
  constructor(root) { this.root = root; this.directory = null; this.meta = null; }
  async read() {
    try { this.directory = await this.root.getDirectoryHandle('recording-parts'); }
    catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
    this.meta = JSON.parse(await (await this.directory.getFileHandle('metadata.json')).getFile().then(file => file.text()));
    if (this.meta.version !== 1 || !Number.isSafeInteger(this.meta.count) || this.meta.count < 0 || this.meta.count > 1000000 || !Number.isFinite(this.meta.bytes) || this.meta.bytes < 0 || typeof this.meta.filename !== 'string') throw new Error('錄影暫存索引無法讀取；請保留資料並匯出錯誤紀錄。');
    if (this.meta.segmented) {
      if (!Array.isArray(this.meta.segments) || !Number.isSafeInteger(this.meta.downloaded || 0) || (this.meta.downloaded || 0) < 0) throw new Error('錄影分段索引損壞。');
      let end=0;
      for (const part of this.meta.segments) {
        if (part.start !== end || !Number.isSafeInteger(part.end) || part.end <= part.start || part.end > this.meta.count || !Number.isFinite(part.bytes) || part.bytes <= 0) throw new Error('錄影分段範圍損壞。');
        end=part.end;
      }
      if (this.meta.activeStart !== end) throw new Error('錄影分段起點損壞。');
      if (!Number.isFinite(this.meta.activeBytes) || this.meta.activeBytes < 0 || (this.meta.downloaded || 0) > this.meta.segments.length + (this.meta.count > end ? 1 : 0)) throw new Error('錄影分段狀態損壞。');
    }
    return this.meta;
  }
  async saveMeta() {
    const writable = await (await this.directory.getFileHandle('metadata.json',{create:true})).createWritable();
    try { await writable.write(JSON.stringify(this.meta)); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
  }
  async begin(meta) {
    await this.remove();
    this.directory = await this.root.getDirectoryHandle('recording-parts',{create:true});
    this.meta = {...meta,version:1,count:0,bytes:0,complete:false,segments:[],activeStart:0,activeBytes:0,downloaded:0};
    await this.saveMeta();
  }
  async append(blob) {
    const handle = await this.directory.getFileHandle(`part-${this.meta.count}`,{create:true});
    const writable = await handle.createWritable();
    try { await writable.write(blob); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
    this.meta.count++; this.meta.bytes += blob.size;
    this.meta.activeBytes = (this.meta.activeBytes || 0) + blob.size;
    await this.saveMeta();
  }
  async finishSegment(complete=true) {
    if (this.meta.count > this.meta.activeStart) {
      this.meta.segments.push({start:this.meta.activeStart,end:this.meta.count,bytes:this.meta.activeBytes,complete});
      this.meta.activeStart = this.meta.count; this.meta.activeBytes = 0;
      await this.saveMeta();
    }
  }
  parts() {
    if (!this.meta.segmented) return this.meta.count ? [{start:0,end:this.meta.count,bytes:this.meta.bytes,complete:this.meta.complete,filename:this.meta.filename}] : [];
    const parts = [...this.meta.segments];
    if (this.meta.count > this.meta.activeStart) parts.push({start:this.meta.activeStart,end:this.meta.count,bytes:this.meta.activeBytes,complete:false});
    return parts.map((part,index)=>({...part,filename:this.meta.filename.replace(/\.mp4$/i,`-第${String(index+1).padStart(3,'0')}段.mp4`)}));
  }
  async assemble(writable,part={start:0,end:this.meta.count}) {
    for (let i=part.start;i<part.end;i++) {
      const file = await (await this.directory.getFileHandle(`part-${i}`)).getFile();
      await writable.write(file);
    }
  }
  async blob(part) {
    const files = [];
    for (let i=part.start;i<part.end;i++) files.push(await (await this.directory.getFileHandle(`part-${i}`)).getFile());
    // Blob composition references the committed files; it does not read them into RAM.
    return new Blob(files,{type:'video/mp4'});
  }
  async remove() {
    try { await this.root.removeEntry('recording-parts',{recursive:true}); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    this.directory = null; this.meta = null;
  }
}
