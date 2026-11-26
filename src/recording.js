import { TOOLS, LAYERS_COUNT } from './constants.js';

const TIMELAPSE_PAGE_SIZE = 20;

function canvasToJpegBlobAsync(canvas, quality = 0.8) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const dataUrlToBlob = (url) => {
      if (!url || !url.startsWith('data:')) return null;
      try {
        const comma = url.indexOf(',');
        if (comma === -1) return null;
        const mimeMatch = /data:([^;]+)/.exec(url.slice(0, comma));
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const bin = atob(url.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      } catch (_) {
        return null;
      }
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        done(dataUrlToBlob(canvas.toDataURL('image/jpeg', quality)));
      } catch (_) {
        done(null);
      }
    }, 10000);
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        if (blob) {
          done(blob);
          return;
        }
        try {
          done(dataUrlToBlob(canvas.toDataURL('image/jpeg', quality)));
        } catch (_) {
          done(null);
        }
      }, 'image/jpeg', quality);
    } catch (e) {
      try {
        done(dataUrlToBlob(canvas.toDataURL('image/jpeg', quality)));
      } catch (_) {
        done(null);
      }
    }
  });
}

function blobToDataURLAsync(blob) {
  if (!blob) return Promise.resolve('');
  if (typeof blob === 'string') return Promise.resolve(blob);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || '');
    reader.onerror = () => resolve('');
    try {
      reader.readAsDataURL(blob);
    } catch (_) {
      resolve('');
    }
  });
}

export class TimelapseRecorder {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    
    // Core parameters
    this.sessionId = 'NONE';
    this.isRecording = false;
    this.frames = [];
    this.currentFrameIdx = 0;
    
    // Capture state
    this.strokeCounter = 0;
    this.strideInterval = 4; // snap frame every 4 forward strokes
    this.qualityScale = 0.25; // default 1/4 size (FAST)
    
    // Selection box in world coordinates (canvas space)
    this.selectionBox = { cx: 0, cy: 0, w: 500, h: 500 }; 
    this.isBoxVisible = false;
    this.boxElement = null;
    
    // Player playback state
    this.isPlaying = false;
    this.playbackIntervalId = null;
    this.playbackFps = 12;

    // Buffered capture, non-starving background encoder & paged IDB persistence
    this._workCanvas = null;
    this._workCtx = null;
    this._hasUnsavedChanges = false;
    this._encodeTimer = null;
    this._isEncodingBuffer = false;
    this._flushPromise = null;
    this._maxBufferedRawFrames = 6;
    this._pendingGpuCapture = false;
    this._dirtyPageVersions = new Map();
    this._persistedPageCount = 0;
    this._legacyNeedsPageMigration = false;
    this._previewObjectUrl = null;
    this._lastPreviewFrameRef = null;
    this._clearArmed = false;
    this._clearArmTimer = null;

    this._initStyles();
    this.resetSession();
  }

  _isPanelVisible() {
    const panel = document.getElementById('panel-recording');
    return Boolean(panel && !panel.classList.contains('hidden'));
  }

  _revokePreviewObjectUrl() {
    if (this._previewObjectUrl) {
      try { URL.revokeObjectURL(this._previewObjectUrl); } catch (_) {}
      this._previewObjectUrl = null;
    }
    this._lastPreviewFrameRef = null;
  }

  _disposeWorkCanvas() {
    if (this._workCanvas) {
      this._workCanvas.width = 1;
      this._workCanvas.height = 1;
      this._workCanvas = null;
      this._workCtx = null;
    }
  }

  _disposeFrameItem(item) {
    if (item && typeof item === 'object' && item.canvas) {
      item.canvas.width = 1;
      item.canvas.height = 1;
      item.canvas = null;
    }
  }

  _disposeAllBufferedFrames() {
    if (!Array.isArray(this.frames)) return;
    for (let i = 0; i < this.frames.length; i++) {
      this._disposeFrameItem(this.frames[i]);
    }
  }

  _countBufferedFrames() {
    if (!Array.isArray(this.frames)) return 0;
    let count = 0;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i] && typeof this.frames[i] === 'object' && this.frames[i].__buffered) {
        count++;
      }
    }
    return count;
  }

  _hasBufferedFrames() {
    if (!Array.isArray(this.frames)) return false;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i] && typeof this.frames[i] === 'object' && this.frames[i].__buffered) {
        return true;
      }
    }
    return false;
  }

  _markPageDirty(pageIdx) {
    if (pageIdx < 0) return;
    const prev = this._dirtyPageVersions.get(pageIdx) || 0;
    this._dirtyPageVersions.set(pageIdx, prev + 1);
  }

  _markPagesDirtyFrom(startFrameIdx = 0) {
    const startPage = Math.floor(Math.max(0, startFrameIdx) / TIMELAPSE_PAGE_SIZE);
    const totalPages = Math.ceil(this.frames.length / TIMELAPSE_PAGE_SIZE);
    for (let p = startPage; p < totalPages; p++) {
      this._markPageDirty(p);
    }
  }

  hasPendingSave() {
    return Boolean(
      this._hasUnsavedChanges ||
      this._dirtyPageVersions.size > 0 ||
      this._hasBufferedFrames() ||
      this._pendingGpuCapture
    );
  }

  _clearEncodeTimer() {
    if (this._encodeTimer) {
      clearTimeout(this._encodeTimer);
      this._encodeTimer = null;
    }
  }

  _scheduleIdleEncode(delayMs = 250, { forceReschedule = false } = {}) {
    if (!this._hasBufferedFrames()) return;
    if (this._encodeTimer) {
      if (!forceReschedule) return; // Never starve pending encode timer during rapid strokes!
      clearTimeout(this._encodeTimer);
      this._encodeTimer = null;
    }
    this._encodeTimer = setTimeout(() => {
      this._encodeTimer = null;
      this._drainOneBufferedFrameIdle();
    }, delayMs);
  }

  async _drainOneBufferedFrameIdle() {
    if (this._isEncodingBuffer || this._flushPromise) return;
    const bufferedCount = this._countBufferedFrames();
    if (bufferedCount === 0) return;

    // Only yield to pointer activity while buffer is small; force drain if >= maxBufferedRawFrames
    if (bufferedCount < this._maxBufferedRawFrames &&
        this.engine && (this.engine.isDrawing || this.engine.isPanning || this.engine.isZooming || this.engine.isGesture)) {
      this._scheduleIdleEncode(250, { forceReschedule: true });
      return;
    }

    const idx = this.frames.findIndex(f => f && typeof f === 'object' && f.__buffered && f.canvas);
    if (idx === -1) return;

    this._isEncodingBuffer = true;
    try {
      const item = this.frames[idx];
      if (item && item.canvas) {
        const blob = await canvasToJpegBlobAsync(item.canvas, 0.8);
        const liveIdx = this.frames[idx] === item ? idx : this.frames.indexOf(item);
        if (liveIdx !== -1 && blob) {
          this.frames[liveIdx] = blob;
          this._markPageDirty(Math.floor(liveIdx / TIMELAPSE_PAGE_SIZE));
        }
        this._disposeFrameItem(item);
      }
    } catch (e) {
      console.warn('Idle timelapse encode failed', e);
    } finally {
      this._isEncodingBuffer = false;
      if (this._hasBufferedFrames()) {
        this._scheduleIdleEncode(35, { forceReschedule: true });
      }
    }
  }

  async flushBufferedFrames(opts = {}) {
    const background = !!opts.background;
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    if (this._pendingGpuCapture && this.engine && typeof this.engine.flushPendingGpuCommits === 'function') {
      if (background) {
        this.engine.flushPendingGpuCommits({
          keepSumiSession: this.app && this.app.activeTool === 'sumi',
          syncSumiForReadback: true
        });
      } else {
        this.engine.flushPendingGpuCommits();
      }
    }
    if (this._flushPromise) return this._flushPromise;
    this._clearEncodeTimer();
    if (!this._hasBufferedFrames()) return { aborted: false };

    let aborted = false;
    this._flushPromise = (async () => {
      const waitStart = Date.now();
      while (this._isEncodingBuffer && (Date.now() - waitStart) < 12000) {
        if (shouldAbort && shouldAbort()) {
          aborted = true;
          return;
        }
        await new Promise(r => setTimeout(r, 10));
      }
      for (let i = 0; i < this.frames.length; i++) {
        if (shouldAbort && shouldAbort()) {
          aborted = true;
          return;
        }
        const item = this.frames[i];
        if (item && typeof item === 'object' && item.__buffered && item.canvas) {
          if (background) {
            await new Promise(r => setTimeout(r, 0));
            if (shouldAbort && shouldAbort()) {
              aborted = true;
              return;
            }
          }
          try {
            const blob = await canvasToJpegBlobAsync(item.canvas, 0.8);
            if (blob) {
              this.frames[i] = blob;
              this._markPageDirty(Math.floor(i / TIMELAPSE_PAGE_SIZE));
            }
          } catch (e) {
            console.warn('Flush encode failed for frame', i, e);
          } finally {
            this._disposeFrameItem(item);
          }
        }
      }
    })();

    try {
      await this._flushPromise;
    } finally {
      this._flushPromise = null;
    }
    return { aborted };
  }

  _getFramePreviewSrc(frame) {
    if (!frame) {
      this._revokePreviewObjectUrl();
      return '';
    }
    if (typeof frame === 'string') {
      this._revokePreviewObjectUrl();
      return frame;
    }
    if (frame instanceof Blob) {
      if (this._lastPreviewFrameRef === frame && this._previewObjectUrl) {
        return this._previewObjectUrl;
      }
      this._revokePreviewObjectUrl();
      this._previewObjectUrl = URL.createObjectURL(frame);
      this._lastPreviewFrameRef = frame;
      return this._previewObjectUrl;
    }
    if (frame.__buffered && frame.canvas) {
      this._revokePreviewObjectUrl();
      try {
        return frame.canvas.toDataURL('image/jpeg', 0.8);
      } catch (_) {
        return '';
      }
    }
    return '';
  }

  _initStyles() {
    if (document.getElementById('recording-custom-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'recording-custom-styles';
    styleEl.innerHTML = `
      #recording-selection-box {
        position: absolute;
        border: 2px dashed red;
        box-shadow: 0 0 0 10000px rgba(0, 0, 0, 0.35);
        box-sizing: border-box;
        z-index: 1000;
        pointer-events: auto;
        touch-action: none;
      }
      #recording-selection-title {
        position: absolute;
        top: -24px;
        left: 0;
        background: red;
        color: white;
        font-family: monospace;
        font-size: 10px;
        font-weight: bold;
        padding: 2px 6px;
        border: 1px solid black;
        white-space: nowrap;
        pointer-events: none;
      }
      .rec-handle {
        width: 12px;
        height: 12px;
        background: white;
        border: 2px solid black;
        position: absolute;
        box-sizing: border-box;
        z-index: 1010;
        touch-action: none;
      }
      .rec-handle-tl { top: -6px; left: -6px; cursor: nwse-resize; }
      .rec-handle-tr { top: -6px; right: -6px; cursor: nesw-resize; }
      .rec-handle-bl { bottom: -6px; left: -6px; cursor: nesw-resize; }
      .rec-handle-br { bottom: -6px; right: -6px; cursor: nwse-resize; }
      .rec-drag-handle {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        cursor: move;
        z-index: 999;
        touch-action: none;
      }
    `;
    document.head.appendChild(styleEl);
  }

  resetSession() {
    this._clearEncodeTimer();
    this._disposeAllBufferedFrames();
    this._disposeWorkCanvas();
    this._revokePreviewObjectUrl();
    this._pendingGpuCapture = false;
    this.sessionId = 'REC-' + new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
    this.frames = [];
    this.currentFrameIdx = 0;
    this.strokeCounter = 0;
    this._hasUnsavedChanges = false;
    this._dirtyPageVersions.clear();
    this._legacyNeedsPageMigration = false;
    this.isPlaying = false;
    if (this.playbackIntervalId) {
      clearInterval(this.playbackIntervalId);
      this.playbackIntervalId = null;
    }
    this.updateUI();
  }

  async saveCurrentSession(explicitProjectId = null, opts = {}) {
    if (!this.app || !this.app.storage) return { aborted: false };
    const background = !!opts.background;
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;

    const flushRes = await this.flushBufferedFrames({ background, shouldAbort });
    if (flushRes && flushRes.aborted) {
      return { aborted: true };
    }

    if (this._legacyNeedsPageMigration) {
      this._markPagesDirtyFrom(0);
      this._legacyNeedsPageMigration = false;
    }

    const targetPid = explicitProjectId || this.app.currentProjectId;
    const isForeignProjectSave = Boolean(explicitProjectId && explicitProjectId !== this.app.currentProjectId);
    const frameCount = this.frames.length;
    const pageCount = Math.ceil(frameCount / TIMELAPSE_PAGE_SIZE);
    const storage = this.app.storage;

    try {
      // Write ONLY modified pages (unless explicitly saving snapshot into a different projectId)
      const pagesToWrite = isForeignProjectSave
        ? Array.from({ length: pageCount }, (_, i) => i)
        : Array.from(this._dirtyPageVersions.keys()).filter(p => p >= 0 && p < pageCount);

      for (const pageIdx of pagesToWrite) {
        if (shouldAbort && shouldAbort()) {
          return { aborted: true };
        }
        if (background) {
          await new Promise(r => setTimeout(r, 0));
          if (shouldAbort && shouldAbort()) {
            return { aborted: true };
          }
        }
        const versionAtStart = this._dirtyPageVersions.get(pageIdx);
        const start = pageIdx * TIMELAPSE_PAGE_SIZE;
        let slice = this.frames.slice(start, start + TIMELAPSE_PAGE_SIZE);
        if (storage.isFallback) {
          slice = await Promise.all(slice.map(f => blobToDataURLAsync(f)));
        }
        await storage.saveSetting(`timelapse_page_${pageIdx}`, { page: pageIdx, frames: slice }, explicitProjectId);
        if (!isForeignProjectSave && this._dirtyPageVersions.get(pageIdx) === versionAtStart) {
          this._dirtyPageVersions.delete(pageIdx);
        }
      }

      // Clean up stale trailing dirty entries beyond new pageCount
      if (!isForeignProjectSave) {
        for (const p of Array.from(this._dirtyPageVersions.keys())) {
          if (p >= pageCount) this._dirtyPageVersions.delete(p);
        }
      }

      // Delete any leftover old pages beyond current pageCount
      if (this._persistedPageCount > pageCount && typeof storage.deleteSetting === 'function') {
        for (let p = pageCount; p < this._persistedPageCount; p++) {
          await storage.deleteSetting(`timelapse_page_${p}`, explicitProjectId);
        }
      }

      // Compact metadata header only (never re-writes old frame bytes on every autosave)
      const meta = {
        version: 2,
        sessionId: this.sessionId,
        frameCount,
        pageSize: TIMELAPSE_PAGE_SIZE,
        pageCount,
        selectionBox: this.selectionBox,
        isRecording: this.isRecording,
        isBoxVisible: this.isBoxVisible,
        qualityScale: this.qualityScale,
        strideInterval: this.strideInterval,
        playbackFps: this.playbackFps
      };
      await storage.saveSetting('timelapse_data', meta, explicitProjectId);
      if (targetPid === this.app.currentProjectId) {
        this._persistedPageCount = pageCount;
        this._hasUnsavedChanges = false;
      }
    } catch (e) {
      console.warn('Failed saving timelapse_data session', e);
    }
  }

  async asyncSave() {
    try {
      await this.saveCurrentSession();
    } catch (e) {
      console.error("Timelapse asyncSave failed", e);
    }
  }

  toggleRecording() {
    this.isRecording = !this.isRecording;
    this._hasUnsavedChanges = true;
    this.updateRecordingIndicator();
    if (this.isRecording) {
      // Auto show selection box if in infinite mode
      if (!this.engine.isStatic && !this.isBoxVisible) {
        this.toggleSelectionBox(true);
      }
    }
    this.asyncSave();
  }

  updateRecordingIndicator() {
    const mainBtn = document.getElementById('btn-rec-toggle');
    if (mainBtn) {
      if (this.isRecording) {
        mainBtn.innerHTML = '● RECORDING (ACTIVE)...';
        mainBtn.style.background = 'red';
        mainBtn.style.color = 'white';
      } else {
        mainBtn.innerHTML = '● RECORD';
        mainBtn.style.background = '#fff';
        mainBtn.style.color = 'red';
      }
    }

    const refBtn = document.getElementById('btn-open-recording');
    if (refBtn) {
      if (this.isRecording) {
        refBtn.innerHTML = '●';
        refBtn.style.color = 'red';
        refBtn.title = 'Timelapse Recording (ACTIVE)';
      } else {
        refBtn.innerHTML = '■';
        refBtn.style.color = '#777';
        refBtn.title = 'Timelapse Recording (STOPPED)';
      }
    }
  }

  syncSettingsUI() {
    // 1. Stride interval
    const strideSl = document.getElementById('rec-stride-slider');
    const strideVal = document.getElementById('rec-stride-val');
    if (strideSl) {
      strideSl.value = this.strideInterval;
    }
    if (strideVal) {
      strideVal.innerText = `${this.strideInterval} strokes`;
    }

    // 2. Resolution buttons & label
    const r14 = document.getElementById('btn-rec-res-14');
    const r12 = document.getElementById('btn-rec-res-12');
    const r11 = document.getElementById('btn-rec-res-11');
    const valLab = document.getElementById('rec-quality-val');

    [r14, r12, r11].forEach(r => r && r.classList.remove('active-btn'));
    if (this.qualityScale === 0.25) {
      if (r14) r14.classList.add('active-btn');
      if (valLab) valLab.innerText = '1/4 SIZE';
    } else if (this.qualityScale === 0.50) {
      if (r12) r12.classList.add('active-btn');
      if (valLab) valLab.innerText = '1/2 SIZE';
    } else if (this.qualityScale === 1.0) {
      if (r11) r11.classList.add('active-btn');
      if (valLab) valLab.innerText = 'FULL SIZE';
    }

    // 3. Playback FPS
    const fpsIn = document.getElementById('rec-fps');
    if (fpsIn) {
      fpsIn.value = this.playbackFps;
    }

    // 4. Update indicators
    this.updateRecordingIndicator();
  }

  toggleSelectionBox(forceState = null) {
    const nextState = (forceState !== null) ? forceState : !this.isBoxVisible;
    this.isBoxVisible = nextState;
    
    const btn = document.getElementById('btn-rec-toggle-box');
    if (btn) {
      btn.classList.toggle('active-btn', this.isBoxVisible);
    }

    if (this.isBoxVisible) {
      this.renderSelectionBox();
    } else {
      this.removeSelectionBox();
    }
  }

  renderSelectionBox() {
    this.removeSelectionBox();

    const wrapper = this.engine.canvasWrapper;
    if (!wrapper) return;

    // Check if box centered coordinate is uninitialized (0, 0), center it on current screen
    if (this.selectionBox.cx === 0 && this.selectionBox.cy === 0) {
      const centerWorld = this.engine._screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      this.selectionBox.cx = Math.round(centerWorld.wx);
      this.selectionBox.cy = Math.round(centerWorld.wy);
    }

    const box = document.createElement('div');
    box.id = 'recording-selection-box';
    
    // Explicit pointerdown trapping to prevent general canvas interactions
    box.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    
    const title = document.createElement('div');
    title.id = 'recording-selection-title';
    title.innerText = `REC AREA [${Math.round(this.selectionBox.w)} x ${Math.round(this.selectionBox.h)}]`;
    box.appendChild(title);

    // Click and drag zone inside
    const dragZ = document.createElement('div');
    dragZ.className = 'rec-drag-handle';
    box.appendChild(dragZ);

    // Setup 4 corner handles
    const handles = ['tl', 'tr', 'bl', 'br'];
    handles.forEach(h => {
      const el = document.createElement('div');
      el.className = `rec-handle rec-handle-${h}`;
      box.appendChild(el);

      // Mouse/touch dragging on corner handles for resize
      let startX = 0, startY = 0;
      let startW = 0, startH = 0;
      let startCX = 0, startCY = 0;

      const handleDown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        
        try {
          el.setPointerCapture(e.pointerId);
        } catch (_) {}

        startX = e.clientX;
        startY = e.clientY;
        startW = this.selectionBox.w;
        startH = this.selectionBox.h;
        startCX = this.selectionBox.cx;
        startCY = this.selectionBox.cy;

        const handleMove = (eMove) => {
          eMove.stopPropagation();
          eMove.preventDefault();
          const dx = (eMove.clientX - startX) / (this.engine.zoom || 1);
          const dy = (eMove.clientY - startY) / (this.engine.zoom || 1);

          if (h === 'br') {
            this.selectionBox.w = Math.max(100, startW + dx * 2);
            this.selectionBox.h = Math.max(100, startH + dy * 2);
          } else if (h === 'bl') {
            this.selectionBox.w = Math.max(100, startW - dx * 2);
            this.selectionBox.h = Math.max(100, startH + dy * 2);
          } else if (h === 'tr') {
            this.selectionBox.w = Math.max(100, startW + dx * 2);
            this.selectionBox.h = Math.max(100, startH - dy * 2);
          } else if (h === 'tl') {
            this.selectionBox.w = Math.max(100, startW - dx * 2);
            this.selectionBox.h = Math.max(100, startH - dy * 2);
          }
          this.updateBoxElement();
        };

        const handleUp = (eUp) => {
          eUp.stopPropagation();
          eUp.preventDefault();
          try {
            el.releasePointerCapture(eUp.pointerId);
          } catch (_) {}
          window.removeEventListener('pointermove', handleMove);
          window.removeEventListener('pointerup', handleUp);
          window.removeEventListener('pointercancel', handleUp);
          this.asyncSave();
        };

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleUp);
      };

      el.addEventListener('pointerdown', handleDown);
    });

    // Body drag listener for position move
    let startDragX = 0, startDragY = 0;
    let startBoxCX = 0, startBoxCY = 0;

    const bodyDown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      try {
        dragZ.setPointerCapture(e.pointerId);
      } catch (_) {}

      startDragX = e.clientX;
      startDragY = e.clientY;
      startBoxCX = this.selectionBox.cx;
      startBoxCY = this.selectionBox.cy;

      const bodyMove = (eMove) => {
        eMove.stopPropagation();
        eMove.preventDefault();
        const dx = (eMove.clientX - startDragX) / (this.engine.zoom || 1);
        const dy = (eMove.clientY - startDragY) / (this.engine.zoom || 1);

        this.selectionBox.cx = startBoxCX + dx;
        this.selectionBox.cy = startBoxCY + dy;
        this.updateBoxElement();
      };

      const bodyUp = (eUp) => {
        eUp.stopPropagation();
        eUp.preventDefault();
        try {
          dragZ.releasePointerCapture(eUp.pointerId);
        } catch (_) {}
        window.removeEventListener('pointermove', bodyMove);
        window.removeEventListener('pointerup', bodyUp);
        window.removeEventListener('pointercancel', bodyUp);
        // Save the updated box coordinates
        this.asyncSave();
      };

      window.addEventListener('pointermove', bodyMove);
      window.addEventListener('pointerup', bodyUp);
      window.addEventListener('pointercancel', bodyUp);
    };

    dragZ.addEventListener('pointerdown', bodyDown);

    wrapper.appendChild(box);
    this.boxElement = box;
    this.updateBoxElement();
  }

  updateBoxElement() {
    if (!this.boxElement) return;
    const center = this.engine.worldCenter;
    const left = center + this.selectionBox.cx - this.selectionBox.w / 2;
    const top = center + this.selectionBox.cy - this.selectionBox.h / 2;

    this.boxElement.style.left = `${left}px`;
    this.boxElement.style.top = `${top}px`;
    this.boxElement.style.width = `${this.selectionBox.w}px`;
    this.boxElement.style.height = `${this.selectionBox.h}px`;

    const title = document.getElementById('recording-selection-title');
    if (title) {
      title.innerText = `REC AREA [${Math.round(this.selectionBox.w)} x ${Math.round(this.selectionBox.h)}]`;
    }
  }

  removeSelectionBox() {
    if (this.boxElement) {
      this.boxElement.remove();
      this.boxElement = null;
    }
  }

  // Hook triggered when history registers a stroke committed
  onStrokeCommitted() {
    if (!this.isRecording) return;
    this.strokeCounter++;
    if (this.strokeCounter >= this.strideInterval) {
      this.strokeCounter = 0;
      this.captureFrame();
    }
  }

  // Hook triggered when undo occurs
  onUndoCommitted() {
    if (!this.isRecording) return;
    this.strokeCounter = Math.max(0, this.strokeCounter - 1);
  }

  // Hook triggered when redo occurs
  onRedoCommitted() {
    if (!this.isRecording) return;
    this.strokeCounter++;
    if (this.strokeCounter >= this.strideInterval) {
      this.strokeCounter = 0;
      this.captureFrame();
    }
  }

  captureFrame() {
    try {
      if (this.engine && typeof this.engine.hasPendingGpuCommits === 'function' && this.engine.hasPendingGpuCommits()) {
        if (!this._pendingGpuCapture) {
          this._pendingGpuCapture = true;
          this.engine.whenGpuCommitsDone(() => {
            this._pendingGpuCapture = false;
            this.captureFrame();
          });
        }
        return;
      }

      let cropX = 0;
      let cropY = 0;
      let cropW = 0;
      let cropH = 0;

      if (this.engine.isStatic) {
        cropW = Math.round(this.engine.staticWidth);
        cropH = Math.round(this.engine.staticHeight);
        cropX = Math.round(-cropW / 2);
        cropY = Math.round(-cropH / 2);
      } else {
        cropW = Math.round(this.selectionBox.w);
        cropH = Math.round(this.selectionBox.h);
        cropX = Math.round(this.selectionBox.cx - cropW / 2);
        cropY = Math.round(this.selectionBox.cy - cropH / 2);
      }

      if (cropW <= 0 || cropH <= 0) return;

      const outW = Math.max(1, Math.round(cropW * this.qualityScale));
      const outH = Math.max(1, Math.round(cropH * this.qualityScale));
      const scaleX = outW / cropW;
      const scaleY = outH / cropH;

      // Reuse pooled small output canvas (zero multi-MB full-res allocation during strokes)
      if (!this._workCanvas) {
        this._workCanvas = document.createElement('canvas');
        this._workCtx = this._workCanvas.getContext('2d', { alpha: false });
      }
      const outCanvas = this._workCanvas;
      const outCtx = this._workCtx;
      if (!outCtx) return;

      if (outCanvas.width !== outW || outCanvas.height !== outH) {
        outCanvas.width = outW;
        outCanvas.height = outH;
      }

      outCtx.imageSmoothingEnabled = this.qualityScale < 1.0;
      if (outCtx.imageSmoothingEnabled) {
        outCtx.imageSmoothingQuality = 'low';
      }

      // Fill background color
      outCtx.fillStyle = this.engine.canvasBg || '#ffffff';
      outCtx.fillRect(0, 0, outW, outH);

      // Render references if visible
      if (this.engine.layerSettings[0] && this.engine.layerSettings[0].visible && this.engine.referenceImages.length > 0) {
        outCtx.save();
        outCtx.scale(scaleX, scaleY);
        outCtx.translate(-cropX, -cropY);
        for (let rIdx = 0; rIdx < this.engine.referenceImages.length; rIdx++) {
          const ref = this.engine.referenceImages[rIdx];
          if (!ref || !ref.img) continue;
          outCtx.save();
          outCtx.translate(ref.x, ref.y);
          outCtx.rotate(ref.rotation);
          outCtx.scale(ref.scale, ref.scale);
          if (ref.mirrorX) outCtx.scale(-1, 1);
          if (ref.mirrorY) outCtx.scale(1, -1);
          outCtx.globalAlpha = ref.opacity;
          outCtx.drawImage(ref.img, -ref.img.width / 2, -ref.img.height / 2);
          outCtx.restore();
        }
        outCtx.restore();
      }

      // Render non-empty visible chunks directly at output scale with shared integer seams
      const isStatic = this.engine.isStatic;
      const chunkSize = this.engine.chunkSize;
      this.engine.chunks.forEach(chunk => {
        const lx = Math.round(isStatic ? -this.engine.staticWidth / 2 : chunk.cx * chunkSize);
        const ly = Math.round(isStatic ? -this.engine.staticHeight / 2 : chunk.cy * chunkSize);
        const chunkW = Math.round(isStatic ? this.engine.staticWidth : chunkSize);
        const chunkH = Math.round(isStatic ? this.engine.staticHeight : chunkSize);

        if (lx < (cropX + cropW) && lx + chunkW > cropX &&
            ly < (cropY + cropH) && ly + chunkH > cropY) {
          const destX = Math.round((lx - cropX) * scaleX);
          const destY = Math.round((ly - cropY) * scaleY);
          const destW = Math.round((lx + chunkW - cropX) * scaleX) - destX;
          const destH = Math.round((ly + chunkH - cropY) * scaleY) - destY;

          for (let i = 1; i < LAYERS_COUNT; i++) {
            if (this.engine.layerSettings[i] && !this.engine.layerSettings[i].visible) continue;
            if (chunk.isEmpty && chunk.isEmpty[i]) continue;
            const layerCanvas = chunk.canvases[i];
            if (!layerCanvas || layerCanvas.width === 0 || layerCanvas.height === 0) continue;
            outCtx.drawImage(layerCanvas, destX, destY, destW, destH);
          }
        }
      });

      // Buffer lightweight scaled canvas snapshot in RAM (~0.3ms, zero JPEG/IndexedDB work mid-hatching)
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = outW;
      snapCanvas.height = outH;
      const snapCtx = snapCanvas.getContext('2d', { alpha: false });
      if (!snapCtx) return;
      snapCtx.drawImage(outCanvas, 0, 0);

      const frameIndex = this.frames.length;
      this.frames.push({ __buffered: true, canvas: snapCanvas });
      this.currentFrameIdx = frameIndex;
      this._markPageDirty(Math.floor(frameIndex / TIMELAPSE_PAGE_SIZE));
      this._hasUnsavedChanges = true;

      // Skip DOM & image updates while panel is closed; encode lazily in non-starving background pump
      if (this._isPanelVisible()) {
        this.updateUI();
      }
      const bufferedCount = this._countBufferedFrames();
      if (bufferedCount >= this._maxBufferedRawFrames && !this._isEncodingBuffer) {
        this._scheduleIdleEncode(35, { forceReschedule: true });
      } else {
        this._scheduleIdleEncode(250);
      }
    } catch (e) {
      console.error('Timelapse Frame Capture Failed:', e);
    }
  }

  deleteCurrentFrame() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    const removedIdx = this.currentFrameIdx;
    const removed = this.frames.splice(removedIdx, 1);
    if (removed && removed[0]) this._disposeFrameItem(removed[0]);
    this.currentFrameIdx = Math.max(0, Math.min(this.currentFrameIdx, this.frames.length - 1));
    this._markPagesDirtyFrom(removedIdx);
    this._hasUnsavedChanges = true;
    this.updateUI();
    this.asyncSave();
  }

  trimTimelineStart() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    for (let i = 0; i < this.currentFrameIdx; i++) {
      this._disposeFrameItem(this.frames[i]);
    }
    this.frames = this.frames.slice(this.currentFrameIdx);
    this.currentFrameIdx = 0;
    this._markPagesDirtyFrom(0);
    this._hasUnsavedChanges = true;
    this.updateUI();
    this.asyncSave();
  }

  trimTimelineEnd() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    for (let i = this.currentFrameIdx + 1; i < this.frames.length; i++) {
      this._disposeFrameItem(this.frames[i]);
    }
    const prevLen = this.frames.length;
    this.frames = this.frames.slice(0, this.currentFrameIdx + 1);
    this.currentFrameIdx = this.frames.length - 1;
    if (prevLen !== this.frames.length) {
      this._markPageDirty(Math.floor(Math.max(0, this.frames.length - 1) / TIMELAPSE_PAGE_SIZE));
    }
    this._hasUnsavedChanges = true;
    this.updateUI();
    this.asyncSave();
  }

  clearTimeline() {
    const clearBtn = document.getElementById('btn-rec-clear');
    if (clearBtn) {
      if (!this._clearArmed) {
        this._clearArmed = true;
        clearBtn.dataset.origLabel = clearBtn.dataset.origLabel || clearBtn.textContent;
        clearBtn.textContent = 'CONFIRM CLEAR?';
        clearBtn.style.background = '#c00';
        clearBtn.style.color = '#fff';
        if (this._clearArmTimer) clearTimeout(this._clearArmTimer);
        this._clearArmTimer = setTimeout(() => {
          this._clearArmed = false;
          this._clearArmTimer = null;
          clearBtn.textContent = clearBtn.dataset.origLabel || 'CLEAR';
          clearBtn.style.background = '';
          clearBtn.style.color = '';
        }, 3500);
        this.app?._status?.('CLICK CLEAR AGAIN TO WIPE TIMELAPSE');
        return;
      }
      this._clearArmed = false;
      if (this._clearArmTimer) {
        clearTimeout(this._clearArmTimer);
        this._clearArmTimer = null;
      }
      clearBtn.textContent = clearBtn.dataset.origLabel || 'CLEAR';
      clearBtn.style.background = '';
      clearBtn.style.color = '';
    }
    this.resetSession();
    this._hasUnsavedChanges = true;
    this.asyncSave();
    this.app?._status?.('TIMELAPSE CLEARED');
  }

  async togglePlayback() {
    if (!this.isPlaying) {
      await this.flushBufferedFrames();
    }
    this.isPlaying = !this.isPlaying;
    const btn = document.getElementById('btn-player-play');
    if (!btn) return;

    if (this.isPlaying) {
      btn.innerText = '‖ PAUSE';
      btn.style.background = '#ff0';
      btn.style.color = '#000';

      const playStep = () => {
        if (this.frames.length === 0) {
          this.togglePlayback();
          return;
        }
        this.currentFrameIdx = (this.currentFrameIdx + 1) % this.frames.length;
        this.updateUI();
      };

      const delayMs = 1000 / this.playbackFps;
      this.playbackIntervalId = setInterval(playStep, delayMs);
    } else {
      btn.innerText = '▶ PLAY';
      btn.style.background = '#333';
      btn.style.color = '#fff';

      if (this.playbackIntervalId) {
        clearInterval(this.playbackIntervalId);
        this.playbackIntervalId = null;
      }
    }
  }

  async downloadSequence() {
    if (this.frames.length === 0) {
      this.app?._status?.('NO TIMELAPSE FRAMES CAPTURED YET');
      return;
    }

    await this.flushBufferedFrames();

    try {
      const dataUrlFrames = await Promise.all(this.frames.map(f => blobToDataURLAsync(f)));
      const payload = {
        sessionId: this.sessionId,
        fps: this.playbackFps,
        mode: this.engine.isStatic ? 'Static' : 'Infinite',
        quality: this.qualityScale,
        totalFrames: dataUrlFrames.length,
        frames: dataUrlFrames // array of base64 jpg streams
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${this.sessionId}_TIMELAPSE.json`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('Failed to export timelapse sequence payload:', e);
      this.app?._status?.('TIMELAPSE JSON EXPORT ERROR');
    }
  }

  async exportVideo() {
    if (this.frames.length === 0) {
      this.app?._status?.('NO TIMELAPSE FRAMES CAPTURED YET');
      return;
    }

    await this.flushBufferedFrames();

    if (this.isPlaying) {
      await this.togglePlayback();
    }

    const btn = document.getElementById('btn-rec-export-video');
    const orgText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '🎬 SETUP ENCODER...';
    }

    const loadFrameImage = (frame) => new Promise((resolve, reject) => {
      const img = new Image();
      let tempUrl = null;
      const cleanup = () => {
        if (tempUrl) {
          URL.revokeObjectURL(tempUrl);
          tempUrl = null;
        }
      };
      img.onload = () => { cleanup(); resolve(img); };
      img.onerror = (err) => { cleanup(); reject(err); };
      if (frame instanceof Blob) {
        tempUrl = URL.createObjectURL(frame);
        img.src = tempUrl;
      } else {
        img.src = typeof frame === 'string' ? frame : '';
      }
    });

    let stream = null;
    let exportCanvas = null;

    try {
      // 1. Get first image dimensions
      const firstImg = await loadFrameImage(this.frames[0]);
      const w = firstImg.width;
      const h = firstImg.height;

      // 2. Offscreen canvas at target dimensions
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = w;
      exportCanvas.height = h;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) throw new Error('Could not get Canvas 2D context');

      ctx.drawImage(firstImg, 0, 0);

      // 3. Find supported mime types
      let mimeType = '';
      let ext = 'webm';
      const types = [
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
      ];
      for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          if (type.includes('mp4')) ext = 'mp4';
          break;
        }
      }

      if (!mimeType) {
        throw new Error('Your browser does not support high fidelity MediaRecorder format.');
      }

      // 4. Set up MediaRecorder on canvas capture stream
      const fps = this.playbackFps || 12;
      stream = exportCanvas.captureStream(fps);
      const options = {
        mimeType: mimeType,
        videoBitsPerSecond: 8000000
      };

      const chunks = [];
      const recorder = new MediaRecorder(stream, options);

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      const recordFinishedPromise = new Promise((resolve, reject) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.onerror = (e) => reject(e);
      });

      recorder.start();

      // 5. Sequentially draw frames
      const frameDelay = 1000 / fps;
      for (let i = 0; i < this.frames.length; i++) {
        if (btn) {
          const percent = Math.round(((i + 1) / this.frames.length) * 100);
          btn.innerHTML = `🎬 RENDER VIDEO (${percent}%)`;
        }

        const img = await loadFrameImage(this.frames[i]);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0);

        await new Promise(resolve => setTimeout(resolve, frameDelay));
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      recorder.stop();
      const videoBlob = await recordFinishedPromise;

      // 6. Trigger file download
      const url = URL.createObjectURL(videoBlob);
      const link = document.createElement('a');
      link.download = `${this.sessionId}_TIMELAPSE.${ext}`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('[TIMELAPSE ENCODE ERROR]:', err);
      this.app?._status?.('VIDEO EXPORT FAILED');
    } finally {
      if (stream) {
        try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      if (exportCanvas) {
        exportCanvas.width = 1;
        exportCanvas.height = 1;
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = orgText;
      }
    }
  }

  updateUI() {
    this.updateRecordingIndicator();
    // Clamp currentFrameIdx safely to actual bounds
    if (this.frames.length === 0) {
      this.currentFrameIdx = 0;
    } else {
      this.currentFrameIdx = Math.max(0, Math.min(this.currentFrameIdx, this.frames.length - 1));
    }

    // Mode parameters
    const modeTypeEl = document.getElementById('rec-mode-type');
    if (modeTypeEl) {
      modeTypeEl.innerText = this.engine.isStatic ? 'Static Full Screen' : 'Infinite Selection';
    }

    const infiniteControls = document.getElementById('rec-infinite-controls');
    if (infiniteControls) {
      infiniteControls.style.display = this.engine.isStatic ? 'none' : 'flex';
    }

    // Session id
    const sessEl = document.getElementById('rec-session-id');
    if (sessEl) sessEl.innerText = this.sessionId;

    // Frame counters
    const counterEl = document.getElementById('rec-frame-count');
    if (counterEl) counterEl.innerText = this.frames.length;

    const frameInfoEl = document.getElementById('rec-player-frame-info');
    if (frameInfoEl) {
      frameInfoEl.innerText = `FRAME ${this.frames.length > 0 ? this.currentFrameIdx + 1 : 0} / ${this.frames.length}`;
    }

    // Scrubber updates
    const scrubber = document.getElementById('rec-scrubber');
    if (scrubber) {
      scrubber.max = Math.max(0, this.frames.length - 1);
      scrubber.value = this.currentFrameIdx;
      scrubber.disabled = this.frames.length <= 1;
    }

    // Preview SCREEN element
    const previewScreen = document.getElementById('rec-player-screen');
    const previewEmpty = document.getElementById('rec-player-empty');

    if (this.frames.length > 0) {
      if (previewScreen) {
        previewScreen.src = this._getFramePreviewSrc(this.frames[this.currentFrameIdx]);
        previewScreen.style.display = 'block';
      }
      if (previewEmpty) previewEmpty.style.display = 'none';
    } else {
      if (previewScreen) {
        previewScreen.src = '';
        previewScreen.style.display = 'none';
      }
      if (previewEmpty) previewEmpty.style.display = 'block';
    }

    // Update button states for quick trimming
    const btns = ['btn-rec-trim-start', 'btn-rec-trim-end', 'btn-rec-del-frame'];
    btns.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = this.frames.length === 0;
    });
  }

  initEventListeners() {
    // Reference Toggle open
    const openBtn = document.getElementById('btn-open-recording');
    if (openBtn) {
      openBtn.onclick = () => {
        const panel = document.getElementById('panel-recording');
        if (panel) {
          const wasHidden = panel.classList.toggle('hidden');
          if (!wasHidden) {
            this.updateUI();
            this.flushBufferedFrames().then(() => {
              if (this._isPanelVisible()) this.updateUI();
            });
          } else {
            this.toggleSelectionBox(false);
            this._revokePreviewObjectUrl();
          }
        }
      };
    }

    // Close buttons
    const closeBtn1 = document.getElementById('btn-recording-close');
    if (closeBtn1) {
      closeBtn1.onclick = () => {
        const panel = document.getElementById('panel-recording');
        if (panel) panel.classList.add('hidden');
        this.toggleSelectionBox(false);
        this._revokePreviewObjectUrl();
      };
    }

    // Recording start toggle
    const toggleBtn = document.getElementById('btn-rec-toggle');
    if (toggleBtn) toggleBtn.onclick = () => this.toggleRecording();

    // Clear session
    const clearBtn = document.getElementById('btn-rec-clear');
    if (clearBtn) clearBtn.onclick = () => this.clearTimeline();

    // Toggle Selection Box
    const sBoxBtn = document.getElementById('btn-rec-toggle-box');
    if (sBoxBtn) sBoxBtn.onclick = () => this.toggleSelectionBox();

    // Box quick sizes
    const smBtn = document.getElementById('btn-rec-size-small');
    if (smBtn) {
      smBtn.onclick = () => {
        this.selectionBox.w = 300;
        this.selectionBox.h = 300;
        this.asyncSave();
        this.toggleSelectionBox(true);
      };
    }
    const mdBtn = document.getElementById('btn-rec-size-medium');
    if (mdBtn) {
      mdBtn.onclick = () => {
        this.selectionBox.w = 500;
        this.selectionBox.h = 500;
        this.asyncSave();
        this.toggleSelectionBox(true);
      };
    }
    const lgBtn = document.getElementById('btn-rec-size-large');
    if (lgBtn) {
      lgBtn.onclick = () => {
        this.selectionBox.w = 800;
        this.selectionBox.h = 800;
        this.asyncSave();
        this.toggleSelectionBox(true);
      };
    }

    // Manual Snap Frame
    const snapBtn = document.getElementById('btn-rec-snap-manual');
    if (snapBtn) snapBtn.onclick = () => this.captureFrame();

    // Resolution scales
    const r14 = document.getElementById('btn-rec-res-14');
    const r12 = document.getElementById('btn-rec-res-12');
    const r11 = document.getElementById('btn-rec-res-11');
    const valLab = document.getElementById('rec-quality-val');

    const updateResUI = (sel) => {
      [r14, r12, r11].forEach(r => r && r.classList.remove('active-btn'));
      sel.classList.add('active-btn');
    };

    if (r14) {
      r14.onclick = () => {
        this.qualityScale = 0.25;
        if (valLab) valLab.innerText = '1/4 SIZE';
        updateResUI(r14);
        this.asyncSave();
      };
    }
    if (r12) {
      r12.onclick = () => {
        this.qualityScale = 0.50;
        if (valLab) valLab.innerText = '1/2 SIZE';
        updateResUI(r12);
        this.asyncSave();
      };
    }
    if (r11) {
      r11.onclick = () => {
        this.qualityScale = 1.0;
        if (valLab) valLab.innerText = 'FULL SIZE';
        updateResUI(r11);
        this.asyncSave();
      };
    }

    // Stride slider (strokes interval)
    const strideSl = document.getElementById('rec-stride-slider');
    const strideVal = document.getElementById('rec-stride-val');
    if (strideSl) {
      strideSl.oninput = (e) => {
        const val = parseInt(e.target.value);
        this.strideInterval = val;
        if (strideVal) strideVal.innerText = `${val} strokes`;
      };
      strideSl.onchange = () => {
        this.asyncSave();
      };
    }

    // Scrubber input
    const scrub = document.getElementById('rec-scrubber');
    if (scrub) {
      scrub.oninput = (e) => {
        this.currentFrameIdx = parseInt(e.target.value);
        this.updateUI();
      };
    }

    // Playback Controls
    const prevBtn = document.getElementById('btn-player-prev');
    if (prevBtn) {
      prevBtn.onclick = () => {
        this.currentFrameIdx = 0;
        this.updateUI();
      };
    }
    const playBtn = document.getElementById('btn-player-play');
    if (playBtn) playBtn.onclick = () => this.togglePlayback();

    const nextBtn = document.getElementById('btn-player-next');
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (this.frames.length > 0) {
          this.currentFrameIdx = this.frames.length - 1;
          this.updateUI();
        }
      };
    }

    // FPS configuration
    const fpsIn = document.getElementById('rec-fps');
    if (fpsIn) {
      fpsIn.onchange = (e) => {
        const val = Math.max(1, Math.min(60, parseInt(e.target.value) || 12));
        fpsIn.value = val;
        this.playbackFps = val;
        this.asyncSave();
        if (this.isPlaying) {
          // Restart player interval with new delay
          this.togglePlayback();
          this.togglePlayback();
        }
      };
    }

    // Trimming operations
    const trimSt = document.getElementById('btn-rec-trim-start');
    if (trimSt) trimSt.onclick = () => this.trimTimelineStart();

    const trimEn = document.getElementById('btn-rec-trim-end');
    if (trimEn) trimEn.onclick = () => this.trimTimelineEnd();

    const delFr = document.getElementById('btn-rec-del-frame');
    if (delFr) delFr.onclick = () => this.deleteCurrentFrame();

    // Export downloadable JSON mapping base64 frames
    const exportBtn = document.getElementById('btn-rec-export-json');
    if (exportBtn) exportBtn.onclick = () => this.downloadSequence();

    // Export playable MP4/WebM video matching custom frame timing
    const exportVideoBtn = document.getElementById('btn-rec-export-video');
    if (exportVideoBtn) exportVideoBtn.onclick = () => this.exportVideo();
  }

  async onProjectSwitched(explicitProjectId = null) {
    this._clearEncodeTimer();
    this._disposeAllBufferedFrames();
    this._disposeWorkCanvas();
    this._revokePreviewObjectUrl();
    this._hasUnsavedChanges = false;
    this._dirtyPageVersions.clear();
    this._persistedPageCount = 0;
    this._pendingGpuCapture = false;

    // 1. If currently playing, stop it cleanly
    if (this.isPlaying) {
      this.isPlaying = false;
      if (this.playbackIntervalId) {
        clearInterval(this.playbackIntervalId);
        this.playbackIntervalId = null;
      }
      const playBtn = document.getElementById('btn-player-play');
      if (playBtn) {
        playBtn.innerText = '▶ PLAY';
        playBtn.style.background = '#333';
        playBtn.style.color = '#fff';
      }
    }
    
    // Purge active preview screen image to prevent RAM/GPU leaks
    const screen = document.getElementById('rec-player-screen');
    if (screen) {
      screen.src = '';
      screen.style.display = 'none';
    }
    const emptyMsg = document.getElementById('rec-player-empty');
    if (emptyMsg) {
      emptyMsg.style.display = 'block';
    }

    // 2. Stop active recording temporarily before restoring
    this.isRecording = false;
    this.removeSelectionBox();
    this.isBoxVisible = false;

    // 3. Load the lapse session data for the newly active project ID
    let data = null;
    try {
      if (this.app && this.app.storage) {
        data = await this.app.storage.loadSetting('timelapse_data', explicitProjectId);
      }
    } catch (e) {
      console.warn('Failed to load timelapse data on switch', e);
    }

    if (data && data.sessionId) {
      this.sessionId = data.sessionId;
      this.selectionBox = data.selectionBox || { cx: 0, cy: 0, w: 500, h: 500 };
      this.isRecording = data.isRecording || false;
      this.isBoxVisible = data.isBoxVisible || false;
      this.qualityScale = data.qualityScale !== undefined ? data.qualityScale : 0.25;
      this.strideInterval = data.strideInterval !== undefined ? data.strideInterval : 4;
      this.playbackFps = data.playbackFps !== undefined ? data.playbackFps : 12;

      if (data.version === 2) {
        const pageCount = Math.max(0, data.pageCount || 0);
        this._persistedPageCount = pageCount;
        const loadedFrames = [];
        if (pageCount > 0 && this.app?.storage) {
          const keys = Array.from({ length: pageCount }, (_, i) => `timelapse_page_${i}`);
          try {
            const pagesMap = typeof this.app.storage.loadSettingsBatch === 'function'
              ? await this.app.storage.loadSettingsBatch(keys, explicitProjectId)
              : null;
            for (let p = 0; p < pageCount; p++) {
              const k = keys[p];
              const pageObj = pagesMap ? pagesMap[k] : await this.app.storage.loadSetting(k, explicitProjectId);
              if (pageObj && Array.isArray(pageObj.frames)) {
                loadedFrames.push(...pageObj.frames);
              }
            }
          } catch (e) {
            console.warn('Failed to load paged timelapse frames', e);
          }
        }
        this.frames = loadedFrames;
      } else {
        // Legacy single-record migration on read
        this.frames = Array.isArray(data.frames) ? data.frames.slice() : [];
        this._persistedPageCount = 0;
        this._legacyNeedsPageMigration = this.frames.length > 0;
      }
    } else {
      // Create a fresh session and clear frames sequence
      this.sessionId = 'REC-' + new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
      this.frames = [];
      this.selectionBox = { cx: 0, cy: 0, w: 500, h: 500 };
      this.isRecording = false;
      this.isBoxVisible = false;
      this.qualityScale = 0.25;
      this.strideInterval = 4;
      this.playbackFps = 12;
      this._persistedPageCount = 0;
      this._legacyNeedsPageMigration = false;
    }

    this.currentFrameIdx = this.frames.length > 0 ? this.frames.length - 1 : 0;
    this.strokeCounter = 0;

    // Sync elements and snapshot settings
    this.syncSettingsUI();

    const boxBtn = document.getElementById('btn-rec-toggle-box');
    if (boxBtn) {
      boxBtn.classList.toggle('active-btn', this.isBoxVisible);
    }

    if (this.isBoxVisible && !this.engine.isStatic) {
      this.renderSelectionBox();
    }

    this.updateUI();
  }
}
