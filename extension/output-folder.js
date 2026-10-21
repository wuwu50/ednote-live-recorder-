// Directory handles stay in this extension's IndexedDB, shared by its UI and recorder.
const OutputFolder = {
  verifiedHandle:null,
  async stored(value, write = false) {
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open('recorder-output',1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve,reject) => {
        const tx = db.transaction('settings',write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('settings');
        const request = write ? store.put(value,'folder') : store.get('folder');
        tx.oncomplete = () => resolve(write ? value : request.result || null);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('無法儲存資料夾設定。'));
      });
    } finally { db.close(); }
  },
  async authorized(handle, prompt = false) {
    if (!handle) return null;
    const options = {mode:'readwrite'};
    // Start the permission request directly from the visible UI's click.
    const permission = prompt ? await handle.requestPermission(options) : await handle.queryPermission(options);
    if (permission !== 'granted') throw new Error('請在此控制視窗的「儲存資料夾」按「允許存取」，並保持控制視窗開啟（可最小化）。');
    return handle;
  },
  async status() {
    const handle = await this.stored();
    if (!handle) return {name:'',permission:'missing',ready:false};
    const permission = await handle.queryPermission({mode:'readwrite'});
    const verified = permission === 'granted' && !!this.verifiedHandle && await handle.isSameEntry(this.verifiedHandle);
    return {name:handle.name,permission,ready:!!verified,verified:!!verified};
  },
  async verify() {
    this.verifiedHandle = null;
    const handle = await this.authorized(await this.stored());
    if (!handle) throw new Error('請先在此控制視窗選擇儲存資料夾。');
    const name = `.rednote-write-check-${crypto.randomUUID()}.tmp`;
    let created = false, writable;
    try {
      // A unique probe never touches a user's existing recording.
      try { await handle.getFileHandle(name); throw new Error('檢查檔案名稱重複，請重試。'); }
      catch(error) { if (error.name !== 'NotFoundError') throw error; }
      const file = await handle.getFileHandle(name,{create:true}); created = true;
      writable = await file.createWritable(); await writable.write(new Uint8Array([82,78]));
      await writable.close(); writable = null;
      await handle.removeEntry(name); created = false;
      this.verifiedHandle = handle;
      return {name:handle.name,permission:'granted',ready:true,verified:true};
    } finally {
      if (writable) await writable.abort().catch(()=>{});
      if (created) await handle.removeEntry(name);
    }
  },
  async save(directory, filename, file) {
    await this.authorized(directory);
    // Preserve existing recordings, even when two recordings have the same timestamp.
    let name = filename, suffix = 0;
    while (true) {
      try { await directory.getFileHandle(name); }
      catch (error) { if (error.name === 'NotFoundError') break; throw error; }
      name = filename.replace(/\.mp4$/i,` (${++suffix}).mp4`);
    }
    const handle = await directory.getFileHandle(name,{create:true});
    let writable;
    try {
      writable = await handle.createWritable();
      // Producers remux directly into the destination. Blob writes use Chrome's
      // native streaming path instead of thousands of small JS/IPC writes.
      if (typeof file === 'function') await file(writable);
      else await writable.write(file);
      await writable.close();
      return name;
    } catch (error) {
      if (writable) await writable.abort().catch(() => {});
      await directory.removeEntry(name).catch(() => {});
      throw error;
    }
  }
};
