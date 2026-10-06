import { TOOLS, LAYERS_COUNT } from './constants.js';

function canvasToDataURLAsync(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(canvas.toDataURL(type, quality));
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result);
        };
        reader.onerror = () => {
          resolve(canvas.toDataURL(type, quality));
        };
        reader.readAsDataURL(blob);
      }, type, quality);
    } catch (e) {
      resolve(canvas.toDataURL(type, quality));
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

    this._initStyles();
    this.resetSession();
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
    this.sessionId = 'REC-' + new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
    this.frames = [];
    this.currentFrameIdx = 0;
    this.strokeCounter = 0;
    this.isPlaying = false;
    if (this.playbackIntervalId) {
      clearInterval(this.playbackIntervalId);
      this.playbackIntervalId = null;
    }
    this.updateUI();
  }

  async saveCurrentSession(explicitProjectId = null) {
    if (!this.app || !this.app.storage) return;
    const data = {
      sessionId: this.sessionId,
      frames: this.frames,
      selectionBox: this.selectionBox,
      isRecording: this.isRecording,
      isBoxVisible: this.isBoxVisible,
      qualityScale: this.qualityScale,
      strideInterval: this.strideInterval,
      playbackFps: this.playbackFps
    };
    try {
      await this.app.storage.saveSetting('timelapse_data', data, explicitProjectId);
    } catch (e) {
      console.warn("Failed saving timelapse_data session", e);
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

  async captureFrame() {
    try {
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

      const exactW = cropW;
      const exactH = cropH;

      // Create primary snapshot canvas at cropped bounding dimensions
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = exactW;
      tempCanvas.height = exactH;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;

      // Disable image smoothing on tempCtx for the 1:1 tile composition.
      // This prevents subpixel anti-aliasing / blurry interpolation at chunk edges!
      tempCtx.imageSmoothingEnabled = false;

      // Fill Background color
      tempCtx.fillStyle = this.engine.canvasBg || '#ffffff';
      tempCtx.fillRect(0, 0, exactW, exactH);

      // Render References if visible
      if (this.engine.layerSettings[0] && this.engine.layerSettings[0].visible) {
        tempCtx.save();
        tempCtx.translate(-cropX, -cropY);
        this.engine.referenceImages.forEach(ref => {
          tempCtx.save();
          tempCtx.translate(ref.x, ref.y);
          tempCtx.rotate(ref.rotation);
          tempCtx.scale(ref.scale, ref.scale);
          if (ref.mirrorX) tempCtx.scale(-1, 1);
          if (ref.mirrorY) tempCtx.scale(1, -1);
          tempCtx.globalAlpha = ref.opacity;
          tempCtx.drawImage(ref.img, -ref.img.width/2, -ref.img.height/2);
          tempCtx.restore();
        });
        tempCtx.restore();
      }

      // Render Active paint chunks
      this.engine.chunks.forEach(chunk => {
        const lx = Math.round(this.engine.isStatic ? -this.engine.staticWidth / 2 : chunk.cx * this.engine.chunkSize);
        const ly = Math.round(this.engine.isStatic ? -this.engine.staticHeight / 2 : chunk.cy * this.engine.chunkSize);
        const chunkW = Math.round(this.engine.isStatic ? this.engine.staticWidth : this.engine.chunkSize);
        const chunkH = Math.round(this.engine.isStatic ? this.engine.staticHeight : this.engine.chunkSize);

        if (lx < (cropX + cropW) && lx + chunkW > cropX &&
            ly < (cropY + cropH) && ly + chunkH > cropY) {
          
          for (let i = 1; i < LAYERS_COUNT; i++) {
            if (this.engine.layerSettings[i] && !this.engine.layerSettings[i].visible) {
              continue;
            }
            // Align destination coordinates perfectly on integer pixels to avoid boundary seams/lines
            const destX = lx - cropX;
            const destY = ly - cropY;
            tempCtx.drawImage(chunk.canvases[i], destX, destY, chunkW, chunkH);
          }
        }
      });

      // Downscale for saving storage & processing memory fast
      const outW = Math.max(1, Math.round(exactW * this.qualityScale));
      const outH = Math.max(1, Math.round(exactH * this.qualityScale));

      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) return;

      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'medium';
      outCtx.drawImage(tempCanvas, 0, 0, exactW, exactH, 0, 0, outW, outH);

      // Compress to high performance low-weight JPEG asynchronously
      const dataUrl = await canvasToDataURLAsync(outCanvas, 'image/jpeg', 0.8);
      
      // Append to timeline frames list
      this.frames.push(dataUrl);
      this.currentFrameIdx = this.frames.length - 1;

      this.updateUI();
      this.asyncSave();
    } catch (e) {
      console.error('Timelapse Frame Capture Failed:', e);
    }
  }

  deleteCurrentFrame() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    this.frames.splice(this.currentFrameIdx, 1);
    this.currentFrameIdx = Math.max(0, Math.min(this.currentFrameIdx, this.frames.length - 1));
    this.updateUI();
    this.asyncSave();
  }

  trimTimelineStart() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    this.frames = this.frames.slice(this.currentFrameIdx);
    this.currentFrameIdx = 0;
    this.updateUI();
    this.asyncSave();
  }

  trimTimelineEnd() {
    if (this.frames.length === 0) return;
    if (this.isPlaying) this.togglePlayback();
    this.frames = this.frames.slice(0, this.currentFrameIdx + 1);
    this.currentFrameIdx = this.frames.length - 1;
    this.updateUI();
    this.asyncSave();
  }

  clearTimeline() {
    if (confirm('Clear the current timelapse recording completely? All captured frames under this session will be wiped.')) {
      this.resetSession();
      this.asyncSave();
    }
  }

  togglePlayback() {
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

  downloadSequence() {
    if (this.frames.length === 0) {
      alert('There are no frames captured yet. Start drawing to snap elements!');
      return;
    }

    try {
      const payload = {
        sessionId: this.sessionId,
        fps: this.playbackFps,
        mode: this.engine.isStatic ? 'Static' : 'Infinite',
        quality: this.qualityScale,
        totalFrames: this.frames.length,
        frames: this.frames // array of base64 jpg streams
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${this.sessionId}_TIMELAPSE.json`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export timelapse sequence payload:', e);
      alert('Error creating sequence file payload: ' + e.message);
    }
  }

  async exportVideo() {
    if (this.frames.length === 0) {
      alert('There are no frames captured yet. Start drawing to snap elements!');
      return;
    }

    if (this.isPlaying) {
      this.togglePlayback();
    }

    const btn = document.getElementById('btn-rec-export-video');
    const orgText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '🎬 SETUP ENCODER...';
    }

    try {
      // 1. Get first image dimensions
      const firstImg = new Image();
      await new Promise((resolve, reject) => {
        firstImg.onload = resolve;
        firstImg.onerror = reject;
        firstImg.src = this.frames[0];
      });

      const w = firstImg.width;
      const h = firstImg.height;

      // 2. Offscreen canvas at target dimensions
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get Canvas 2D context');

      ctx.drawImage(firstImg, 0, 0);

      // 3. Find supported mine types
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

      console.log('[TIMELAPSE] Using video writer mimeType:', mimeType, 'extension:', ext);

      // 4. Set up MediaRecorder on canvas capture stream
      const fps = this.playbackFps || 12;
      const stream = canvas.captureStream(fps);
      const options = {
        mimeType: mimeType,
        videoBitsPerSecond: 8000000 // 8 Mbps high bit-rate for crystal clear canvas rendering
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

        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = this.frames[i];
        });

        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0);

        // Standard delay matching FPS to let recorder capture the painted buffer correctly
        await new Promise(resolve => setTimeout(resolve, frameDelay));
      }

      // Add trailing buffer of half a second to capture final frame nicely
      await new Promise(resolve => setTimeout(resolve, 300));

      recorder.stop();
      const videoBlob = await recordFinishedPromise;

      // 6. Trigger file download
      const url = URL.createObjectURL(videoBlob);
      const link = document.createElement('a');
      link.download = `${this.sessionId}_TIMELAPSE.${ext}`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);

    } catch (err) {
      console.error('[TIMELAPSE ENCODE ERROR]:', err);
      alert('Failed to encode video stream: ' + err.message);
    } finally {
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
        previewScreen.src = this.frames[this.currentFrameIdx];
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
            // Reposition selection bounds or show selection helper
            this.updateUI();
          } else {
            this.toggleSelectionBox(false);
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
    // 1. If currently playing, stop it cleanly
    if (this.isPlaying) {
      this.togglePlayback();
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
      console.warn("Failed to load timelapse data on switch", e);
    }

    if (data && data.sessionId) {
      this.sessionId = data.sessionId;
      this.frames = data.frames || [];
      this.selectionBox = data.selectionBox || { cx: 0, cy: 0, w: 500, h: 500 };
      this.isRecording = data.isRecording || false;
      this.isBoxVisible = data.isBoxVisible || false;
      this.qualityScale = data.qualityScale !== undefined ? data.qualityScale : 0.25;
      this.strideInterval = data.strideInterval !== undefined ? data.strideInterval : 4;
      this.playbackFps = data.playbackFps !== undefined ? data.playbackFps : 12;
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
