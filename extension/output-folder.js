// Directory handles stay in this extension's IndexedDB, shared by its UI and recorder.
const OutputFolder = {
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
    let permission = await handle.queryPermission(options);
    if (permission !== 'granted' && prompt) permission = await handle.requestPermission(options);
    if (permission !== 'granted') throw new Error('請在「儲存資料夾」按「允許存取」，再重新儲存影片。');
    return handle;
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
