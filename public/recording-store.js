const recordingStore = (() => {
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open('review-room-recordings', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' });
      const chunks = request.result.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
      chunks.createIndex('sessionId', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Recording storage is blocked'));
  });
  async function transaction(stores, mode, action) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction(stores, mode);
      let result;
      try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Recording storage failed'));
    });
  }
  return {
    create: session => transaction(['sessions'], 'readwrite', tx => tx.objectStore('sessions').add(session)),
    put: session => transaction(['sessions'], 'readwrite', tx => tx.objectStore('sessions').put(session)),
    append: (sessionId, seq, blob) => transaction(['chunks'], 'readwrite', tx => tx.objectStore('chunks').add({ sessionId, seq, blob })),
    sessions: () => transaction(['sessions'], 'readonly', tx => tx.objectStore('sessions').getAll()),
    chunks: sessionId => transaction(['chunks'], 'readonly', tx => tx.objectStore('chunks').index('sessionId').getAll(sessionId)),
    remove: async sessionId => {
      const entries = await transaction(['chunks'], 'readonly', tx => tx.objectStore('chunks').index('sessionId').getAllKeys(sessionId));
      return transaction(['sessions', 'chunks'], 'readwrite', tx => {
        tx.objectStore('sessions').delete(sessionId);
        for (const key of entries) tx.objectStore('chunks').delete(key);
      });
    }
  };
})();
