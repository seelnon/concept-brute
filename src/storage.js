const ALL_STORES = [
  'chunks',
  'settings',
  'sectors',
  'toolSettings',
  'tips',
  'palette',
  'projectThumbs',
  'uiState'
];

export class SketchStorage {
  constructor() {
    this.projectId = 'default';
    this.dbName = 'ConceptBruteDB';
    this.version = 2;
    this.db = null;
    this.isFallback = false;
    this._initPromise = null;
    this.fallbackStore = {
      chunks: {},
      settings: {},
      sectors: {},
      toolSettings: {},
      tips: {},
      palette: {},
      projectThumbs: {},
      uiState: {}
    };

    // Per-compartment in-memory caches for instant repeat reads
    this._caches = {
      settings: new Map(),
      toolSettings: new Map(),
      tips: new Map(),
      palette: new Map(),
      projectThumbs: new Map(),
      uiState: new Map()
    };

    // Coalesced async write queue (batches slider/tool/tip/ui updates into one multi-store IDB tx)
    this._pendingWrites = new Map();
    this._flushTimer = null;
    this._inFlightPromises = new Set();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const flushOnHide = () => {
        if (this._pendingWrites.size > 0) {
          this.flushPendingWrites().catch(() => {});
        }
      };
      window.addEventListener('pagehide', flushOnHide);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) flushOnHide();
        });
      }
    }
  }

  setProjectId(id) {
    this.projectId = id || 'default';
  }

  async ensureReady() {
    if (this.db) return this.db;
    if (this.isFallback) return null;
    return this.init();
  }

  _enableFallback() {
    this.isFallback = true;
    this.fallbackStore = {
      chunks: {},
      settings: {},
      sectors: {},
      toolSettings: {},
      tips: {},
      palette: {},
      projectThumbs: {},
      uiState: {}
    };

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;

        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (key.startsWith('p_') && key.includes('_s_')) {
              if (/_s_-?\d+_-?\d+$/.test(key) || key.includes('_s_minus_')) {
                this.fallbackStore.sectors[key] = parsed;
              } else {
                this.fallbackStore.settings[key] = parsed;
              }
            } else if (key.startsWith('global_')) {
              const baseKey = key.substring(7);
              this.fallbackStore.settings[baseKey] = parsed;
            } else {
              this.fallbackStore.settings[key] = parsed;
            }
          }
        } catch (e) {
          const raw = localStorage.getItem(key);
          this.fallbackStore.settings[key] = raw;
        }
      }
    } catch (err) {
      console.warn('LocalStorage reads disabled or blocked:', err);
    }
  }

  async init() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        console.warn('IndexedDB unavailable. Activating in-memory fallback.');
        this._enableFallback();
        resolve(null);
        return;
      }

      const timeoutId = setTimeout(() => {
        if (!this.db) {
          console.warn('IndexedDB handshake exceeded 20s guard. Activating in-memory fallback.');
          this._enableFallback();
          resolve(null);
        }
      }, 20000);

      let request;
      try {
        request = indexedDB.open(this.dbName, this.version);
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn('IndexedDB blocked by security rules. Activating in-memory fallback.', err.message);
        this._enableFallback();
        resolve(null);
        return;
      }

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        for (let i = 0; i < ALL_STORES.length; i++) {
          const storeName = ALL_STORES[i];
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
      };

      request.onsuccess = (event) => {
        clearTimeout(timeoutId);
        this.db = event.target.result;
        this.isFallback = false;

        this.db.onversionchange = () => {
          console.warn('IndexedDB version changed elsewhere. Closing connection.');
          if (this.db) {
            this.db.close();
            this.db = null;
          }
        };

        this.db.onclose = () => {
          console.warn('IndexedDB connection closed. Will reconnect on next transaction.');
          this.db = null;
        };

        resolve(this.db);
      };

      request.onerror = (event) => {
        clearTimeout(timeoutId);
        console.warn('IndexedDB connection failed. Activating in-memory fallback.', event.target?.error);
        this._enableFallback();
        resolve(null);
      };

      request.onblocked = () => {
        console.warn('IndexedDB open blocked by another tab.');
      };
    }).finally(() => {
      this._initPromise = null;
    });

    return this._initPromise;
  }

  _trackPromise(p) {
    this._inFlightPromises.add(p);
    p.finally(() => this._inFlightPromises.delete(p));
    return p;
  }

  _scheduleQueueFlush(delayMs = 90) {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flushPendingWrites().catch(() => {});
    }, delayMs);
  }

  async flushPendingWrites() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    if (this._pendingWrites.size > 0) {
      const entries = Array.from(this._pendingWrites.values());
      this._pendingWrites.clear();

      await this.ensureReady();
      if (this.isFallback || !this.db) {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const fb = this.fallbackStore[e.storeName] || (this.fallbackStore[e.storeName] = {});
          if (e.deleteRecord) delete fb[e.key];
          else fb[e.key] = e.record;
        }
      } else {
        const storeSet = new Set();
        for (let i = 0; i < entries.length; i++) {
          storeSet.add(entries[i].storeName);
        }
        const txPromise = new Promise((resolve, reject) => {
          try {
            const tx = this.db.transaction(Array.from(storeSet), 'readwrite');
            const storeRefs = {};
            storeSet.forEach((s) => {
              storeRefs[s] = tx.objectStore(s);
            });
            for (let i = 0; i < entries.length; i++) {
              const e = entries[i];
              if (e.deleteRecord) storeRefs[e.storeName].delete(e.key);
              else storeRefs[e.storeName].put(e.record);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = (ev) => reject(ev.target?.error || new Error('Batch write failed'));
            tx.onabort = (ev) => reject(ev.target?.error || new Error('Batch write aborted'));
          } catch (err) {
            reject(err);
          }
        });
        await this._trackPromise(txPromise);
      }
    }

    if (this._inFlightPromises.size > 0) {
      await Promise.allSettled(Array.from(this._inFlightPromises));
    }
  }

  async _putCompartment(storeName, key, record, immediate = false) {
    const cache = this._caches[storeName];
    if (cache) cache.set(key, record);

    const queueKey = `${storeName}::${key}`;
    if (!immediate) {
      this._pendingWrites.set(queueKey, { storeName, key, record, deleteRecord: false });
      this._scheduleQueueFlush(90);
      return;
    }

    this._pendingWrites.delete(queueKey);
    await this.ensureReady();

    if (this.isFallback || !this.db) {
      const fb = this.fallbackStore[storeName] || (this.fallbackStore[storeName] = {});
      fb[key] = record;
      return;
    }

    const txPromise = new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readwrite');
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = (ev) => reject(ev.target?.error || new Error(`Save ${storeName} failed`));
      tx.onabort = (ev) => reject(ev.target?.error || new Error(`Save ${storeName} aborted`));
    });
    return this._trackPromise(txPromise);
  }

  async _deleteCompartment(storeName, key, immediate = false) {
    const cache = this._caches[storeName];
    if (cache) cache.set(key, null);

    const queueKey = `${storeName}::${key}`;
    if (!immediate) {
      this._pendingWrites.set(queueKey, { storeName, key, record: null, deleteRecord: true });
      this._scheduleQueueFlush(90);
      return;
    }

    this._pendingWrites.delete(queueKey);
    await this.ensureReady();

    if (this.isFallback || !this.db) {
      if (this.fallbackStore[storeName]) delete this.fallbackStore[storeName][key];
      return;
    }

    const txPromise = new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (ev) => reject(ev.target?.error || new Error(`Delete ${storeName} failed`));
      tx.onabort = (ev) => reject(ev.target?.error || new Error(`Delete ${storeName} aborted`));
    });
    return this._trackPromise(txPromise);
  }

  async _getCompartment(storeName, key) {
    const cache = this._caches[storeName];
    if (cache && cache.has(key)) {
      return cache.get(key);
    }

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      const val = (this.fallbackStore[storeName] && this.fallbackStore[storeName][key]) || null;
      if (cache) cache.set(key, val);
      return val;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        const res = req.result || null;
        if (cache) cache.set(key, res);
        resolve(res);
      };
      req.onerror = (ev) => reject(ev.target?.error || new Error(`Load ${storeName} failed`));
      tx.onabort = (ev) => reject(ev.target?.error || new Error(`Load ${storeName} aborted`));
    });
  }

  async _getAllCompartment(storeName, prefix = null) {
    await this.ensureReady();
    const cache = this._caches[storeName];

    if (this.isFallback || !this.db) {
      const src = this.fallbackStore[storeName] || {};
      const out = [];
      for (const k in src) {
        if (!prefix || k.startsWith(prefix)) {
          if (src[k]) out.push(src[k]);
        }
      }
      return out;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const range = prefix ? IDBKeyRange.bound(prefix, prefix + '\uffff') : null;
      const req = range ? store.getAll(range) : store.getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        if (cache) {
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item && item.id) cache.set(item.id, item);
          }
        }
        resolve(list);
      };
      req.onerror = (ev) => reject(ev.target?.error || new Error(`LoadAll ${storeName} failed`));
      tx.onabort = (ev) => reject(ev.target?.error || new Error(`LoadAll ${storeName} aborted`));
    });
  }

  // ==================== COMPARTMENT: PER-TOOL SETTINGS ====================

  async saveToolSetting(toolId, value, explicitProjectId = null, immediate = false) {
    if (!toolId) return;
    const pid = explicitProjectId || this.projectId;
    const key = `${pid}:${toolId}`;
    return this._putCompartment('toolSettings', key, { id: key, pid, toolId, value }, immediate);
  }

  async loadAllToolSettings(explicitProjectId = null) {
    const pid = explicitProjectId || this.projectId;
    const prefix = `${pid}:`;
    const rows = await this._getAllCompartment('toolSettings', prefix);
    const map = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.toolId) map[r.toolId] = r.value;
    }
    return map;
  }

  // ==================== COMPARTMENT: PER-SLOT BRUSH TIPS ====================

  async saveTipSlot(slotId, payload, immediate = false) {
    if (!slotId) return;
    return this._putCompartment('tips', slotId, { id: slotId, ...payload }, immediate);
  }

  async loadAllTipSlots() {
    const rows = await this._getAllCompartment('tips', null);
    const map = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.id) map[r.id] = r;
    }
    return map;
  }

  // ==================== COMPARTMENT: PALETTE ====================

  async savePaletteCompartment(key, value, immediate = false) {
    if (!key) return;
    return this._putCompartment('palette', key, { id: key, value }, immediate);
  }

  async loadPaletteCompartment(key) {
    const rec = await this._getCompartment('palette', key);
    return rec ? rec.value : null;
  }

  async loadAllPaletteCompartment() {
    const rows = await this._getAllCompartment('palette', null);
    const map = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.id) map[r.id] = r.value;
    }
    return map;
  }

  // ==================== COMPARTMENT: PROJECT THUMBNAILS ====================

  async saveProjectThumb(pid, thumbnail, immediate = false) {
    if (!pid) return;
    if (!thumbnail) {
      return this._deleteCompartment('projectThumbs', pid, immediate);
    }
    return this._putCompartment('projectThumbs', pid, { id: pid, thumbnail }, immediate);
  }

  async loadAllProjectThumbs() {
    const rows = await this._getAllCompartment('projectThumbs', null);
    const map = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.id && r.thumbnail) map[r.id] = r.thumbnail;
    }
    return map;
  }

  async deleteProjectThumb(pid) {
    if (!pid) return;
    return this._deleteCompartment('projectThumbs', pid, true);
  }

  // ==================== COMPARTMENT: UI STATE ====================

  async saveUiState(key, value, immediate = false) {
    if (!key) return;
    return this._putCompartment('uiState', key, { id: key, value }, immediate);
  }

  async loadUiState(key) {
    const rec = await this._getCompartment('uiState', key);
    return rec ? rec.value : null;
  }

  async deleteUiState(key) {
    if (!key) return;
    return this._deleteCompartment('uiState', key, true);
  }

  async loadUiStateBatch(keys) {
    if (!keys || keys.length === 0) return {};
    const cache = this._caches.uiState;
    const results = {};
    const missing = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (cache.has(k)) {
        const rec = cache.get(k);
        results[k] = rec ? rec.value : null;
      } else {
        missing.push(k);
      }
    }
    if (missing.length === 0) return results;

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      for (let i = 0; i < missing.length; i++) {
        const k = missing[i];
        const rec = this.fallbackStore.uiState[k] || null;
        cache.set(k, rec);
        results[k] = rec ? rec.value : null;
      }
      return results;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['uiState'], 'readonly');
      const store = tx.objectStore('uiState');
      let loaded = 0;
      let failed = false;
      missing.forEach((k) => {
        const req = store.get(k);
        req.onsuccess = () => {
          if (failed) return;
          const rec = req.result || null;
          cache.set(k, rec);
          results[k] = rec ? rec.value : null;
          loaded++;
          if (loaded === missing.length) resolve(results);
        };
        req.onerror = (ev) => {
          if (failed) return;
          failed = true;
          reject(ev.target?.error || new Error('Batch uiState load failed'));
        };
      });
      tx.onabort = (ev) => {
        if (failed) return;
        failed = true;
        reject(ev.target?.error || new Error('Batch uiState load aborted'));
      };
    });
  }

  // ==================== SECTORS & CHUNKS ====================

  _getSectorKey(sx, sy, explicitProjectId = null) {
    const pid = explicitProjectId || this.projectId;
    return `p_${pid}_s_${sx}_${sy}`;
  }

  _getSettingKey(id, explicitProjectId = null) {
    const pid = explicitProjectId || this.projectId;
    return `p_${pid}_s_${id}`;
  }

  async saveSector(sx, sy, sectorData, explicitProjectId = null) {
    await this.ensureReady();
    const key = this._getSectorKey(sx, sy, explicitProjectId);

    if (this.isFallback || !this.db) {
      if (!sectorData || Object.keys(sectorData.chunks || {}).length === 0) {
        delete this.fallbackStore.sectors[key];
        try { localStorage.removeItem(key); } catch (e) {}
      } else {
        this.fallbackStore.sectors[key] = sectorData;
        try { localStorage.setItem(key, JSON.stringify(sectorData)); } catch (e) {}
      }
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sectors'], 'readwrite');
      const store = transaction.objectStore('sectors');

      if (!sectorData || Object.keys(sectorData.chunks || {}).length === 0) {
        store.delete(key);
      } else {
        store.put({ id: key, ...sectorData });
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target?.error || new Error('Save sector failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Save sector aborted'));
    });
  }

  async loadSector(sx, sy, explicitProjectId = null) {
    await this.ensureReady();
    const key = this._getSectorKey(sx, sy, explicitProjectId);

    if (this.isFallback || !this.db) {
      return this.fallbackStore.sectors[key] || null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sectors'], 'readonly');
      const store = transaction.objectStore('sectors');
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = (event) => reject(event.target?.error || new Error('Load sector failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Load sector aborted'));
    });
  }

  async loadSectorsBatch(keys) {
    await this.ensureReady();
    if (this.isFallback || !this.db) {
      return keys.map(key => ({
        key,
        sector: this.fallbackStore.sectors[key] || null
      }));
    }

    if (keys.length === 0) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sectors'], 'readonly');
      const store = transaction.objectStore('sectors');
      const results = [];
      let loadedCount = 0;
      let failed = false;

      keys.forEach((key, index) => {
        const request = store.get(key);
        request.onsuccess = () => {
          if (failed) return;
          results[index] = { key, sector: request.result || null };
          loadedCount++;
          if (loadedCount === keys.length) {
            resolve(results);
          }
        };
        request.onerror = (event) => {
          if (failed) return;
          failed = true;
          reject(event.target?.error || new Error('Load sectors batch failed'));
        };
      });
      transaction.onabort = (event) => {
        if (failed) return;
        failed = true;
        reject(event.target?.error || new Error('Load sectors batch aborted'));
      };
    });
  }

  async getAllSectorKeys(explicitProjectId = null) {
    await this.ensureReady();
    const pid = explicitProjectId || this.projectId;
    if (this.isFallback || !this.db) {
      const prefix = `p_${pid}_s_`;
      return Object.keys(this.fallbackStore.sectors).filter(k => k.startsWith(prefix));
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sectors'], 'readonly');
      const store = transaction.objectStore('sectors');
      const range = IDBKeyRange.bound(`p_${pid}_s_`, `p_${pid}_s_\uffff`);
      const request = store.getAllKeys(range);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target?.error || new Error('Get keys failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Get keys aborted'));
    });
  }

  async getAllLegacyKeys(explicitProjectId = null) {
    await this.ensureReady();
    const pid = explicitProjectId || this.projectId;
    if (this.isFallback || !this.db) {
      const prefix = `p_${pid}_c_`;
      return Object.keys(this.fallbackStore.chunks).filter(k => k.startsWith(prefix));
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readonly');
      const store = transaction.objectStore('chunks');
      const range = IDBKeyRange.bound(`p_${pid}_c_`, `p_${pid}_c_\uffff`);
      const request = store.getAllKeys(range);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target?.error || new Error('Get legacy keys failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Get legacy keys aborted'));
    });
  }

  async loadLegacyChunk(id) {
    await this.ensureReady();
    if (this.isFallback || !this.db) {
      return this.fallbackStore.chunks[id] ? this.fallbackStore.chunks[id].data : null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readonly');
      const store = transaction.objectStore('chunks');
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result ? request.result.data : null);
      request.onerror = (event) => reject(event.target?.error || new Error('Load legacy chunk failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Load legacy chunk aborted'));
    });
  }

  async deleteLegacyChunk(id) {
    await this.ensureReady();
    if (this.isFallback || !this.db) {
      delete this.fallbackStore.chunks[id];
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const store = transaction.objectStore('chunks');
      store.delete(id);

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target?.error || new Error('Delete legacy chunk failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Delete legacy chunk aborted'));
    });
  }

  // ==================== PROJECT & GLOBAL SETTINGS (CACHED IDB) ====================

  async saveSetting(id, value, explicitProjectId = null, immediate = false) {
    const key = this._getSettingKey(id, explicitProjectId);
    // Keep heavyweight keys (historyStack, referenceImages, canvasSurface, timelapse) immediate when saved
    const isHeavy = immediate || id === 'historyStack' || id === 'redoStack' || id === 'referenceImages' || id === 'canvasSurface' || id.startsWith('timelapse');
    return this._putCompartment('settings', key, { id: key, value }, isHeavy);
  }

  async loadSetting(id, explicitProjectId = null) {
    const key = this._getSettingKey(id, explicitProjectId);
    const cache = this._caches.settings;
    if (cache.has(key)) {
      const rec = cache.get(key);
      return rec ? rec.value : null;
    }

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      if (this.fallbackStore.settings[key] !== undefined) {
        const val = this.fallbackStore.settings[key];
        cache.set(key, { id: key, value: val });
        return val;
      }
      try {
        const raw = localStorage.getItem(key);
        const val = raw ? JSON.parse(raw) : null;
        if (val !== null) cache.set(key, { id: key, value: val });
        return val;
      } catch (e) {
        return null;
      }
    }

    const rec = await this._getCompartment('settings', key);
    return rec ? rec.value : null;
  }

  async deleteSetting(id, explicitProjectId = null) {
    const key = this._getSettingKey(id, explicitProjectId);
    if (this.isFallback || !this.db) {
      try { localStorage.removeItem(key); } catch (e) {}
    }
    return this._deleteCompartment('settings', key, true);
  }

  async loadSettingsBatch(keys, explicitProjectId = null) {
    if (!keys || keys.length === 0) return {};
    const cache = this._caches.settings;
    const results = {};
    const missingKeys = [];

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const fullKey = this._getSettingKey(k, explicitProjectId);
      if (cache.has(fullKey)) {
        const rec = cache.get(fullKey);
        results[k] = rec ? rec.value : null;
      } else {
        missingKeys.push({ shortKey: k, fullKey });
      }
    }

    if (missingKeys.length === 0) return results;

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      for (let i = 0; i < missingKeys.length; i++) {
        const { shortKey, fullKey } = missingKeys[i];
        if (this.fallbackStore.settings[fullKey] !== undefined) {
          const val = this.fallbackStore.settings[fullKey];
          cache.set(fullKey, { id: fullKey, value: val });
          results[shortKey] = val;
        } else {
          try {
            const raw = localStorage.getItem(fullKey);
            const val = raw ? JSON.parse(raw) : null;
            if (val !== null) cache.set(fullKey, { id: fullKey, value: val });
            results[shortKey] = val;
          } catch (e) {
            results[shortKey] = null;
          }
        }
      }
      return results;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      let loadedCount = 0;
      let failed = false;

      missingKeys.forEach(({ shortKey, fullKey }) => {
        const request = store.get(fullKey);
        request.onsuccess = () => {
          if (failed) return;
          const rec = request.result || null;
          cache.set(fullKey, rec);
          results[shortKey] = rec ? rec.value : null;
          loadedCount++;
          if (loadedCount === missingKeys.length) {
            resolve(results);
          }
        };
        request.onerror = (event) => {
          if (failed) return;
          failed = true;
          reject(event.target?.error || new Error('Batch settings load failed'));
        };
      });
      transaction.onabort = (event) => {
        if (failed) return;
        failed = true;
        reject(event.target?.error || new Error('Batch settings load aborted'));
      };
    });
  }

  async saveGlobalSetting(id, value) {
    // No synchronous localStorage.setItem / JSON.stringify on main thread!
    // Persist directly to IDB settings store + in-memory cache.
    return this._putCompartment('settings', id, { id, value }, true);
  }

  async loadGlobalSetting(id) {
    const cache = this._caches.settings;
    if (cache.has(id)) {
      const rec = cache.get(id);
      return rec ? rec.value : null;
    }

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      if (this.fallbackStore.settings[id] !== undefined) {
        const val = this.fallbackStore.settings[id];
        cache.set(id, { id, value: val });
        return val;
      }
      try {
        const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
        const val = raw ? JSON.parse(raw) : null;
        if (val !== null) cache.set(id, { id, value: val });
        return val;
      } catch (e) {
        return null;
      }
    }

    return new Promise((resolve) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(id);

      request.onsuccess = () => {
        const rec = request.result || null;
        let val = rec ? rec.value : null;
        if (val === null || val === undefined) {
          // One-time legacy localStorage migration
          try {
            const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
            if (raw) {
              val = JSON.parse(raw);
              if (val !== null && val !== undefined) {
                this.saveGlobalSetting(id, val).catch(() => {});
                try { localStorage.removeItem(`global_${id}`); } catch (_) {}
              }
            }
          } catch (e) {}
        }
        if (val !== null && val !== undefined) {
          cache.set(id, { id, value: val });
        }
        resolve(val);
      };
      request.onerror = () => {
        try {
          const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          resolve(null);
        }
      };
      transaction.onabort = () => {
        try {
          const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          resolve(null);
        }
      };
    });
  }

  async getStorageStats(explicitProjectId = null) {
    await this.ensureReady();
    const pid = explicitProjectId || this.projectId;
    if (this.isFallback || !this.db) {
      let size = 0;
      let sectors = 0;
      let chunks = 0;
      const prefix = `p_${pid}_s_`;

      for (const key in this.fallbackStore.sectors) {
        if (key.startsWith(prefix)) {
          sectors++;
          const chunkData = this.fallbackStore.sectors[key].chunks || {};
          for (const k in chunkData) {
            chunks++;
            size += (chunkData[k]?.size || chunkData[k]?.length || 0);
          }
        }
      }
      return { size, sectors, chunks };
    }

    return new Promise((resolve, reject) => {
      let size = 0;
      let sectors = 0;
      let chunks = 0;

      const transaction = this.db.transaction(['sectors'], 'readonly');
      const store = transaction.objectStore('sectors');
      const range = IDBKeyRange.bound(`p_${pid}_s_`, `p_${pid}_s_\uffff`);
      const request = store.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          sectors++;
          const chunkData = cursor.value.chunks || {};
          for (const key in chunkData) {
            chunks++;
            size += (chunkData[key]?.size || chunkData[key]?.length || 0);
          }
          cursor.continue();
        } else {
          resolve({ size, sectors, chunks });
        }
      };

      request.onerror = (event) => reject(event.target?.error || new Error('Get storage stats failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Get storage stats aborted'));
    });
  }

  async deleteProjectStoredData(targetProjectId) {
    if (!targetProjectId) return;
    await this.flushPendingWrites().catch(() => {});
    await this.ensureReady();

    // Evict cached entries belonging to deleted project
    const settingPrefix = `p_${targetProjectId}_s_`;
    const toolPrefix = `${targetProjectId}:`;
    for (const k of this._caches.settings.keys()) {
      if (k.startsWith(settingPrefix)) this._caches.settings.delete(k);
    }
    for (const k of this._caches.toolSettings.keys()) {
      if (k.startsWith(toolPrefix)) this._caches.toolSettings.delete(k);
    }
    this._caches.palette.delete(`p_${targetProjectId}`);
    this._caches.projectThumbs.delete(targetProjectId);
    this._caches.uiState.delete(`v_${targetProjectId}`);

    // Clean any legacy localStorage remnants for this project
    try {
      localStorage.removeItem(`v_${targetProjectId}_zoom`);
      localStorage.removeItem(`v_${targetProjectId}_pan`);
    } catch (_) {}

    if (this.isFallback || !this.db) {
      const sectorPrefix = `p_${targetProjectId}_s_`;
      for (const k in this.fallbackStore.sectors) {
        if (k.startsWith(sectorPrefix)) {
          delete this.fallbackStore.sectors[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      for (const k in this.fallbackStore.settings) {
        if (k.startsWith(settingPrefix)) {
          delete this.fallbackStore.settings[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      const chunkPrefix = `p_${targetProjectId}_c_`;
      for (const k in this.fallbackStore.chunks) {
        if (k.startsWith(chunkPrefix)) {
          delete this.fallbackStore.chunks[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      for (const k in this.fallbackStore.toolSettings) {
        if (k.startsWith(toolPrefix)) delete this.fallbackStore.toolSettings[k];
      }
      delete this.fallbackStore.palette[`p_${targetProjectId}`];
      delete this.fallbackStore.projectThumbs[targetProjectId];
      delete this.fallbackStore.uiState[`v_${targetProjectId}`];
      return;
    }

    return new Promise((resolve, reject) => {
      const txStores = ['sectors', 'settings', 'chunks', 'toolSettings', 'palette', 'projectThumbs', 'uiState'];
      const transaction = this.db.transaction(txStores, 'readwrite');

      const deletePrefixFromStore = (store, prefix) => {
        const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
        const req = store.openCursor(range);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            store.delete(cursor.key);
            cursor.continue();
          }
        };
      };

      deletePrefixFromStore(transaction.objectStore('sectors'), `p_${targetProjectId}_s_`);
      deletePrefixFromStore(transaction.objectStore('settings'), `p_${targetProjectId}_s_`);
      deletePrefixFromStore(transaction.objectStore('chunks'), `p_${targetProjectId}_c_`);
      deletePrefixFromStore(transaction.objectStore('toolSettings'), `${targetProjectId}:`);
      transaction.objectStore('palette').delete(`p_${targetProjectId}`);
      transaction.objectStore('projectThumbs').delete(targetProjectId);
      transaction.objectStore('uiState').delete(`v_${targetProjectId}`);

      transaction.oncomplete = () => {
        console.log(`[STORAGE] Completed storage purge for project ID: ${targetProjectId}`);
        resolve();
      };
      transaction.onerror = (event) => reject(event.target?.error || new Error('Delete project stored data failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Delete project stored data aborted'));
    });
  }

  async clearDatabase() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._pendingWrites.clear();
    for (const k in this._caches) {
      this._caches[k].clear();
    }

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      this.fallbackStore = {
        chunks: {},
        settings: {},
        sectors: {},
        toolSettings: {},
        tips: {},
        palette: {},
        projectThumbs: {},
        uiState: {}
      };
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith(`p_${this.projectId}_`) || key.startsWith(`brushTips`))) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => {
          try { localStorage.removeItem(k); } catch (e) {}
        });
      } catch (e) {}
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(ALL_STORES, 'readwrite');
      for (let i = 0; i < ALL_STORES.length; i++) {
        transaction.objectStore(ALL_STORES[i]).clear();
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target?.error || new Error('Clear database failed'));
      transaction.onabort = (event) => reject(event.target?.error || new Error('Clear database aborted'));
    });
  }
}
