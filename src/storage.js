import { SECTOR_SIZE } from './constants.js';

export class SketchStorage {
  constructor() {
    this.projectId = 'default';
    this.dbName = 'ConceptBruteDB';
    this.version = 1;
    this.db = null;
    this.isFallback = false;
    this._initPromise = null;
    this.fallbackStore = {
      chunks: {},
      settings: {},
      sectors: {}
    };
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
      sectors: {}
    };
    
    // Attempt to load settings/metadata keys from localStorage to preserve state
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (key.startsWith('p_') && key.includes('_s_')) {
              if (key.includes('_s_0_') || key.includes('_s_1_') || key.includes('_s_2_') || key.includes('_s_3_') || key.includes('_s_minus_')) {
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

      // 20-second safety guard: background tabs are throttled by browsers, so never use a short 1s timeout!
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
        if (!database.objectStoreNames.contains('chunks')) {
          database.createObjectStore('chunks', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('sectors')) {
          database.createObjectStore('sectors', { keyPath: 'id' });
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
      transaction.onerror = (event) => reject(event.target.error || new Error('Save sector failed'));
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
      request.onerror = (event) => reject(event.target.error || new Error('Load sector failed'));
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
          reject(event.target.error || new Error('Load sectors batch failed'));
        };
      });
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
      request.onerror = (event) => reject(event.target.error || new Error('Get keys failed'));
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
      request.onerror = (event) => reject(event.target.error || new Error('Get legacy keys failed'));
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
      request.onerror = (event) => reject(event.target.error || new Error('Load legacy chunk failed'));
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
      transaction.onerror = (event) => reject(event.target.error || new Error('Delete legacy chunk failed'));
    });
  }

  async saveSetting(id, value, explicitProjectId = null) {
    await this.ensureReady();
    const key = this._getSettingKey(id, explicitProjectId);

    if (this.isFallback || !this.db) {
      this.fallbackStore.settings[key] = value;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
      return;
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      store.put({ id: key, value });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error || new Error('Save setting failed'));
    });
  }

  async loadSetting(id, explicitProjectId = null) {
    await this.ensureReady();
    const key = this._getSettingKey(id, explicitProjectId);

    if (this.isFallback || !this.db) {
      if (this.fallbackStore.settings[key] !== undefined) {
        return this.fallbackStore.settings[key];
      }
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = (event) => reject(event.target.error || new Error('Load setting failed'));
    });
  }

  async loadSettingsBatch(keys, explicitProjectId = null) {
    await this.ensureReady();
    if (this.isFallback || !this.db) {
      const results = {};
      keys.forEach(k => {
        const key = this._getSettingKey(k, explicitProjectId);
        if (this.fallbackStore.settings[key] !== undefined) {
          results[k] = this.fallbackStore.settings[key];
        } else {
          try {
            const raw = localStorage.getItem(key);
            results[k] = raw ? JSON.parse(raw) : null;
          } catch (e) {
            results[k] = null;
          }
        }
      });
      return results;
    }

    if (keys.length === 0) return {};

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const results = {};
      let loadedCount = 0;
      let failed = false;

      keys.forEach((k) => {
        const key = this._getSettingKey(k, explicitProjectId);
        const request = store.get(key);
        request.onsuccess = () => {
          if (failed) return;
          results[k] = request.result ? request.result.value : null;
          loadedCount++;
          if (loadedCount === keys.length) {
            resolve(results);
          }
        };
        request.onerror = (event) => {
          if (failed) return;
          failed = true;
          reject(event.target.error || new Error('Batch settings load failed'));
        };
      });
    });
  }

  async saveGlobalSetting(id, value) {
    try {
      localStorage.setItem(`global_${id}`, JSON.stringify(value));
      localStorage.setItem(id, JSON.stringify(value));
    } catch (e) {}

    await this.ensureReady();
    if (this.isFallback || !this.db) {
      this.fallbackStore.settings[id] = value;
      return;
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      store.put({ id, value });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error || new Error('Save global setting failed'));
    });
  }

  async loadGlobalSetting(id) {
    await this.ensureReady();
    if (this.isFallback || !this.db) {
      if (this.fallbackStore.settings[id] !== undefined) {
        return this.fallbackStore.settings[id];
      }
      try {
        const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(id);
      
      request.onsuccess = () => {
        let val = request.result ? request.result.value : null;
        if (val === null || val === undefined) {
          try {
            const raw = localStorage.getItem(`global_${id}`) || localStorage.getItem(id);
            if (raw) {
              val = JSON.parse(raw);
              if (val !== null && val !== undefined) {
                this.saveGlobalSetting(id, val).catch(() => {});
              }
            }
          } catch (e) {}
        }
        resolve(val);
      };
      request.onerror = (event) => {
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
    const pid = explicitProjectId || this.projectId;
    if (this.isFallback) {
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

    if (!this.db) throw new Error('Database not initialized');
    
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
      
      request.onerror = (event) => reject(event.target.error || new Error('Get storage stats failed'));
    });
  }

  async deleteProjectStoredData(targetProjectId) {
    if (this.isFallback) {
      // 1. Delete matching sectors from fallback model
      const sectorPrefix = `p_${targetProjectId}_s_`;
      for (const k in this.fallbackStore.sectors) {
        if (k.startsWith(sectorPrefix)) {
          delete this.fallbackStore.sectors[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      // 2. Delete matching settings from fallback model
      const settingPrefix = `p_${targetProjectId}_s_`;
      for (const k in this.fallbackStore.settings) {
        if (k.startsWith(settingPrefix)) {
          delete this.fallbackStore.settings[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      // 3. Delete matching legacy chunks from fallback model
      const chunkPrefix = `p_${targetProjectId}_c_`;
      for (const k in this.fallbackStore.chunks) {
        if (k.startsWith(chunkPrefix)) {
          delete this.fallbackStore.chunks[k];
          try { localStorage.removeItem(k); } catch (e) {}
        }
      }
      return;
    }

    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['sectors', 'settings', 'chunks'], 'readwrite');
      const sectorsStore = transaction.objectStore('sectors');
      const settingsStore = transaction.objectStore('settings');
      const chunksStore = transaction.objectStore('chunks');

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

      deletePrefixFromStore(sectorsStore, `p_${targetProjectId}_s_`);
      deletePrefixFromStore(settingsStore, `p_${targetProjectId}_s_`);
      deletePrefixFromStore(chunksStore, `p_${targetProjectId}_c_`);

      transaction.oncomplete = () => {
        console.log(`[STORAGE] Completed storage purge for project ID: ${targetProjectId}`);
        resolve();
      };
      transaction.onerror = (event) => reject(event.target.error || new Error('Delete project stored data failed'));
    });
  }

  async clearDatabase() {
    if (this.isFallback) {
      this.fallbackStore = {
        chunks: {},
        settings: {},
        sectors: {}
      };
      // Attempt to clear corresponding localStorage keys
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith(`p_${this.projectId}_`) || key.startsWith(`brushTips_`))) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => {
          try { localStorage.removeItem(k); } catch (e) {}
        });
      } catch (e) {}
      return;
    }

    if (!this.db) throw new Error('Database not initialized');
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks', 'settings', 'sectors'], 'readwrite');
      transaction.objectStore('chunks').clear();
      transaction.objectStore('settings').clear();
      transaction.objectStore('sectors').clear();
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error || new Error('Clear database failed'));
    });
  }
}
