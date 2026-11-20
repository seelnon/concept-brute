export class TipManager {
  constructor(container, onTipChange, storage = null) {
    this.container = container;
    this.onTipChange = onTipChange;
    this.storage = storage;
    this.tips = []; 
    this.defaults = []; 
    this.generatedTips = []; // Store generated tips persistently
    this.activeBankIndex = 0; // >= 0 for main slots, < 0 for generated or custom
    this.activeGeneratedIndex = -1; // Index in generatedTips if active
    this.selectedTipCanvas = null; // The one actually in use
    this.editorCanvas = document.getElementById('tip-editor-canvas');
    this.editorCtx = this.editorCanvas.getContext('2d');
    this.isEraser = false;
    
    this.ready = this.init();
  }

  _applyDefaultAdvancedSettings(t, saved = {}) {
    t.paintHeight = saved.paintHeight || 0;
    t.oiliness = saved.oiliness ?? 0.5;
    t.airbrush = saved.airbrush || 0;
    
    t.spacing = saved.spacing ?? 0.05;
    t.pressureEnabled = saved.pressureEnabled ?? true;
    t.pressureOpacityInfluence = saved.pressureOpacityInfluence ?? 1.0;
    t.pressureSizeInfluence = saved.pressureSizeInfluence ?? 1.0;
    t.jitterSize = saved.jitterSize ?? 0;
    t.jitterAngle = saved.jitterAngle ?? 0;
    t.jitterPos = saved.jitterPos ?? 0;
    t.jitterHue = saved.jitterHue ?? 0;
    const rawSmudgeBoost = (saved.smudgeFlowBoost === 10.0 && !saved._smudgeCalibratedV2)
      ? 1.0
      : (saved.smudgeFlowBoost ?? 1.0);
    t.smudgeFlowBoost = rawSmudgeBoost;
    t._smudgeCalibratedV2 = true;
    t.smudgePickup = saved.smudgePickup ?? 2.0;
    t.brushSharpen = saved.brushSharpen ?? 0.0;
    t.wireDensity = saved.wireDensity ?? 30;
    t.wireRange = saved.wireRange ?? 4.0;
    t.wireMinDist = saved.wireMinDist ?? 0.5;
    t.airWetness = saved.airWetness ?? 100;
    t.airStreamFlow = saved.airStreamFlow ?? 100;
    t.airBloom = saved.airBloom ?? 50;
    t.airEdge = saved.airEdge ?? 30;
    t.airGranulation = saved.airGranulation ?? 30;
    t.airTipPour = saved.airTipPour ?? 100;
    t.airFollowStroke = saved.airFollowStroke ?? false;
    t.airTipAngle = saved.airTipAngle ?? 0;
    t.airTipHardness = saved.airTipHardness ?? 55;
    t.airPressureFlow = saved.airPressureFlow ?? 35;
  }

  async init() {
    await this._createDefaultTips();
    
    // Create initial empty generated tips
    for (let i = 0; i < 9; i++) {
        const t = { canvas: null };
        this._applyDefaultAdvancedSettings(t);
        this.generatedTips.push(t);
    }

    if (this.storage) {
        // Load main tips
        let savedMain = null;
        try {
            const raw = localStorage.getItem('brushTips');
            if (raw) savedMain = JSON.parse(raw);
        } catch(e) {}

        if (savedMain && Array.isArray(savedMain)) {
            const mainPromises = [];
            for (let i = 0; i < savedMain.length && i < this.tips.length; i++) {
                if (savedMain[i]) {
                    const idx = i;
                    const tipData = (typeof savedMain[i] === 'string') ? { src: savedMain[i] } : savedMain[i];
                    mainPromises.push((async () => {
                        try {
                            const img = new Image();
                            await new Promise((res, rej) => {
                                const timer = setTimeout(() => {
                                    img.src = '';
                                    rej(new Error('Tip load timeout'));
                                }, 300);
                                img.onload = () => { clearTimeout(timer); res(); };
                                img.onerror = () => { clearTimeout(timer); rej(new Error('Tip load error')); };
                                img.src = tipData.src;
                            });
                            const c = document.createElement('canvas');
                            c.width = 128; c.height = 128;
                            c.getContext('2d').drawImage(img, 0, 0);
                            this.tips[idx].canvas = c;
                            this._applyDefaultAdvancedSettings(this.tips[idx], tipData);
                        } catch (err) {
                            console.warn(`Failed loading saved main tip ${idx}:`, err);
                        }
                    })());
                }
            }
            await Promise.all(mainPromises);
        }

        // Load generated tips
        let savedGen = null;
        try {
            const raw = localStorage.getItem('brushTips_generated');
            if (raw) savedGen = JSON.parse(raw);
        } catch(e) {}

        if (savedGen && Array.isArray(savedGen)) {
            const genPromises = [];
            for (let i = 0; i < savedGen.length && i < this.generatedTips.length; i++) {
                if (savedGen[i] && savedGen[i].src) {
                    const idx = i;
                    genPromises.push((async () => {
                        try {
                            const img = new Image();
                            await new Promise((res, rej) => {
                                const timer = setTimeout(() => {
                                    img.src = '';
                                    rej(new Error('Gen tip load timeout'));
                                }, 300);
                                img.onload = () => { clearTimeout(timer); res(); };
                                img.onerror = () => { clearTimeout(timer); rej(new Error('Gen tip load error')); };
                                img.src = savedGen[idx].src;
                            });
                            const c = document.createElement('canvas');
                            c.width = 128; c.height = 128;
                            c.getContext('2d').drawImage(img, 0, 0);
                            this.generatedTips[idx].canvas = c;
                            this._applyDefaultAdvancedSettings(this.generatedTips[idx], savedGen[idx]);
                        } catch (err) {
                            console.warn(`Failed loading saved gen tip ${idx}:`, err);
                        }
                    })());
                }
            }
            await Promise.all(genPromises);
        }

        // Fill missing generated tips
        for (let i = 0; i < 9; i++) {
            if (!this.generatedTips[i].canvas) {
                this._regenerateSlot(i, false);
            }
        }

        // Load active indices
        const savedBankIdx = localStorage.getItem('activeTipBankIndex');
        if (savedBankIdx !== null) this.activeBankIndex = parseInt(savedBankIdx);
        const savedGenIdx = localStorage.getItem('activeTipGenIndex');
        if (savedGenIdx !== null) this.activeGeneratedIndex = parseInt(savedGenIdx);
    } else {
        // No storage, just generate
        for (let i = 0; i < 9; i++) this._regenerateSlot(i, false);
    }

    this._setupUI();
    
    if (this.activeGeneratedIndex >= 0) {
        this.selectedTipCanvas = this.generatedTips[this.activeGeneratedIndex].canvas;
        this.activeBankIndex = -1;
    } else {
        this.selectedTipCanvas = this.tips[Math.max(0, this.activeBankIndex)].canvas;
        this.activeGeneratedIndex = -1;
    }

    this.editorCtx.clearRect(0,0,128,128);
    this.editorCtx.drawImage(this.selectedTipCanvas, 0, 0);
    this._renderPalette();
    this._updateActiveTip();
  }

  _regenerateSlot(i, save = true) {
    const t1 = this.tips[Math.floor(Math.random() * this.tips.length)];
    const t2 = this.tips[Math.floor(Math.random() * this.tips.length)];
    
    let rotation = 0;
    if (i % 3 === 0) rotation = Math.floor(Math.random() * 4) * 90;
    else if (i % 3 === 1) rotation = Math.floor(Math.random() * 8) * 45;
    else rotation = Math.floor(Math.random() * 360);

    let baseAlpha = 1.0;
    if (i % 3 === 0) baseAlpha = 1.0;
    else if (i % 3 === 1) baseAlpha = 0.5 + Math.random() * 0.5;
    else baseAlpha = Math.random();

    const combined = document.createElement('canvas');
    combined.width = 128; combined.height = 128;
    const cctx = combined.getContext('2d');
    cctx.save();
    cctx.translate(64, 64);
    cctx.rotate((rotation * Math.PI) / 180);
    cctx.globalAlpha = baseAlpha;
    cctx.drawImage(t1.canvas, -64, -64);
    cctx.drawImage(t2.canvas, -64, -64);
    cctx.restore();

    combined._tipVersion = ((this.generatedTips[i].canvas && this.generatedTips[i].canvas._tipVersion) || 0) + 1;
    this.generatedTips[i].canvas = combined;
    this._applyDefaultAdvancedSettings(this.generatedTips[i]);

    if (save) this._saveToStorage();
  }

  async _createDefaultTips() {
    this.tips = [];
    this.defaults = [];
    const types = ['rect', 'circle', 'triangle', 'scatter', 'scratchy', 'hollow'];
    
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        let canvas;
        
        if (type === 'triangle') {
            try {
                const resp = await fetch('./main_brushtip.png');
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const blob = await resp.blob();
                const objUrl = URL.createObjectURL(blob);
                try {
                    canvas = await new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => {
                            const tc = document.createElement('canvas');
                            tc.width = 128; tc.height = 128;
                            tc.getContext('2d').drawImage(img, 0, 0, 128, 128);
                            resolve(tc);
                        };
                        img.onerror = () => reject(new Error('Error decoding main_brushtip.png'));
                        img.src = objUrl;
                    });
                } finally {
                    URL.revokeObjectURL(objUrl);
                }
            } catch (e) {
                console.warn('Could not load ./main_brushtip.png, falling back to shape:', e);
                canvas = this._createShape(type);
            }
        } else {
            canvas = this._createShape(type);
        }

        const t = { canvas };
        this._applyDefaultAdvancedSettings(t);
        this.tips.push(t);
        const backup = document.createElement('canvas');
        backup.width = 128; backup.height = 128;
        backup.getContext('2d').drawImage(canvas, 0, 0);
        this.defaults.push(backup);
    }
  }

  _createShape(type) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'black';
    
    if (type === 'rect') {
      ctx.fillRect(0, 32, 128, 64);
    } else if (type === 'circle') {
      ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'triangle') {
      ctx.beginPath(); ctx.moveTo(64, 10); ctx.lineTo(118, 118); ctx.lineTo(10, 118); ctx.closePath(); ctx.fill();
    } else if (type === 'scatter') {
      for(let i=0; i<30; i++) {
        ctx.beginPath(); ctx.arc(Math.random()*128, Math.random()*128, Math.random()*8, 0, Math.PI*2); ctx.fill();
      }
    } else if (type === 'scratchy') {
      ctx.lineWidth = 2;
      for(let i=0; i<20; i++) {
        ctx.beginPath(); const y = 32 + Math.random()*64; ctx.moveTo(10, y); ctx.lineTo(118, y + (Math.random()-0.5)*10); ctx.stroke();
      }
    } else if (type === 'hollow') {
      ctx.lineWidth = 12; ctx.beginPath(); ctx.arc(64, 64, 54, 0, Math.PI * 2); ctx.stroke();
    }
    return c;
  }

  _setupUI() {
    let drawing = false;
    const editorContainer = document.getElementById('tip-editor-container');
    const editorCrosshair = document.getElementById('tip-editor-crosshair');

    const updateCrosshair = (e, clampInside = false) => {
        if (!editorCrosshair) return;
        const rect = this._editorRect || this.editorCanvas.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        let lx = e.clientX - rect.left;
        let ly = e.clientY - rect.top;
        if (clampInside) {
            lx = Math.max(0, Math.min(rect.width, lx));
            ly = Math.max(0, Math.min(rect.height, ly));
        } else if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) {
            hideCrosshair();
            return;
        }
        if (editorCrosshair.style.display !== 'block') {
            editorCrosshair.style.display = 'block';
        }
        editorCrosshair.style.transform = `translate3d(${lx - 8.5}px, ${ly - 8.5}px, 0)`;
        if (editorContainer) editorContainer.classList.add('tip-crosshair-active');
    };

    const hideCrosshair = () => {
        if (editorCrosshair && editorCrosshair.style.display !== 'none') {
            editorCrosshair.style.display = 'none';
        }
        if (editorContainer) editorContainer.classList.remove('tip-crosshair-active');
    };

    const startDraw = (e) => {
        if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        try {
            this.editorCanvas.setPointerCapture(e.pointerId);
        } catch (_) {}
        drawing = true;
        this._editorRect = this.editorCanvas.getBoundingClientRect();
        updateCrosshair(e, true);
        this._drawEditor(e, true);
    };
    
    const moveDraw = (e) => {
        if (e.pointerType !== 'touch' || drawing) {
            updateCrosshair(e, drawing);
        }
        if (!drawing) return;
        e.preventDefault();
        const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
        if (events && events.length > 0) {
            for (let i = 0; i < events.length; i++) {
                this._drawEditor(events[i], false);
            }
        } else {
            this._drawEditor(e, false);
        }
    };

    const stopDraw = (e) => { 
        if (drawing) { 
            drawing = false;
            this._finishEditorStroke();
            this._editorRect = null;
            try {
                if (e && e.pointerId !== undefined && this.editorCanvas.hasPointerCapture?.(e.pointerId)) {
                    this.editorCanvas.releasePointerCapture(e.pointerId);
                }
            } catch (_) {}
            this._updateFromEditor();
            if (!e || e.pointerType === 'touch') {
                hideCrosshair();
            } else {
                updateCrosshair(e, false);
            }
        } 
    };

    this.editorCanvas.onpointerenter = (e) => {
        this._editorRect = this.editorCanvas.getBoundingClientRect();
        if (e.pointerType !== 'touch') updateCrosshair(e, drawing);
    };
    this.editorCanvas.onpointerdown = startDraw;
    this.editorCanvas.onpointermove = moveDraw;
    this.editorCanvas.onpointerup = stopDraw;
    this.editorCanvas.onpointercancel = stopDraw;
    this.editorCanvas.onlostpointercapture = stopDraw;
    this.editorCanvas.onpointerleave = () => {
        if (!drawing) hideCrosshair();
    };
    
    document.getElementById('btn-tip-clear').onclick = () => {
        this.editorCtx.clearRect(0,0,128,128);
        this._updateFromEditor();
    };

    document.getElementById('btn-tip-reset').onclick = () => {
        if (this.activeBankIndex < 0) return; 
        const backup = this.defaults[this.activeBankIndex];
        this.editorCtx.save();
        this.editorCtx.globalCompositeOperation = 'source-over';
        this.editorCtx.clearRect(0,0,128,128);
        this.editorCtx.drawImage(backup, 0, 0);
        this.editorCtx.restore();
        this._updateFromEditor();
    };

    document.getElementById('btn-tip-eraser').onclick = () => {
        this.isEraser = !this.isEraser;
        document.getElementById('btn-tip-eraser').classList.toggle('active-btn', this.isEraser);
    };

    document.getElementById('btn-tips-collapse').onclick = () => {
        const content = document.getElementById('tips-content');
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? '' : 'none';
        document.getElementById('btn-tips-collapse').innerText = isHidden ? '_' : '+';
    };

    document.getElementById('btn-tip-capture').onclick = () => {
        if (this.onCaptureRequest) this.onCaptureRequest();
    };

    // Refresh Buttons
    for (let col = 0; col < 3; col++) {
        const btn = document.getElementById(`btn-refresh-col-${col}`);
        if (btn) {
            btn.onclick = () => {
                for (let row = 0; row < 3; row++) {
                    this._regenerateSlot(row * 3 + col, false);
                }
                this._renderPalette(true);
                if (this.activeGeneratedIndex >= 0 && (this.activeGeneratedIndex % 3 === col)) {
                    this.selectedTipCanvas = this.generatedTips[this.activeGeneratedIndex].canvas;
                    this.editorCtx.save();
                    this.editorCtx.globalCompositeOperation = 'source-over';
                    this.editorCtx.clearRect(0, 0, 128, 128);
                    this.editorCtx.drawImage(this.selectedTipCanvas, 0, 0);
                    this.editorCtx.restore();
                    this._updateActiveTip();
                }
                this._saveToStorage();
            };
        }
    }
  }

  setTipFromCanvas(canvas) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 128, 128);
    c._tipVersion = ((this.selectedTipCanvas && this.selectedTipCanvas._tipVersion) || 0) + 1;

    this.selectedTipCanvas = c;
    if (this.activeBankIndex >= 0 && this.tips[this.activeBankIndex]) {
        this.tips[this.activeBankIndex].canvas = c;
    } else if (this.activeGeneratedIndex >= 0 && this.generatedTips[this.activeGeneratedIndex]) {
        this.generatedTips[this.activeGeneratedIndex].canvas = c;
    } else if (this.tips[0]) {
        this.activeBankIndex = 0;
        this.activeGeneratedIndex = -1;
        this.tips[0].canvas = c;
    }
    
    this.editorCtx.save();
    this.editorCtx.globalCompositeOperation = 'source-over';
    this.editorCtx.clearRect(0,0,128,128);
    this.editorCtx.drawImage(c, 0, 0);
    this.editorCtx.restore();
    
    this._renderPalette(true);
    this._updateActiveTip();
    this._saveToStorage();
  }

  _getEditorPoint(e) {
    let rect = this._editorRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        rect = this.editorCanvas.getBoundingClientRect();
        this._editorRect = rect;
    }
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 128;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 128;
    const isPen = e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0;
    const pressure = isPen ? Math.max(0.05, Math.min(1.0, e.pressure)) : 1.0;
    const baseR = this.isEraser ? 6.0 : 5.0;
    const r = isPen ? (1.2 + Math.pow(pressure, 0.8) * (this.isEraser ? 6.0 : 5.4)) : baseR;
    return { x, y, r, isPen };
  }

  _strokeEditorSegment(ax, ay, ar, cx, cy, cr, bx, by, br, isQuadratic = true) {
    const ctx = this.editorCtx;
    ctx.save();
    ctx.globalCompositeOperation = this.isEraser ? 'destination-out' : 'source-over';
    ctx.globalAlpha = 1.0;

    if (!this._strokeIsPen && Math.abs(ar - br) < 0.05) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = br * 2.0;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        if (isQuadratic) {
            ctx.quadraticCurveTo(cx, cy, bx, by);
        } else {
            ctx.lineTo(bx, by);
        }
        ctx.stroke();
    } else {
        ctx.fillStyle = '#000000';
        const len = isQuadratic
            ? (Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy))
            : Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len * 2.8));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            let px, py, pr;
            if (isQuadratic) {
                const inv = 1 - t;
                px = inv * inv * ax + 2 * inv * t * cx + t * t * bx;
                py = inv * inv * ay + 2 * inv * t * cy + t * t * by;
                pr = inv * inv * ar + 2 * inv * t * cr + t * t * br;
            } else {
                px = ax + (bx - ax) * t;
                py = ay + (by - ay) * t;
                pr = ar + (br - ar) * t;
            }
            ctx.beginPath();
            ctx.arc(px, py, Math.max(0.6, pr), 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
  }

  _drawEditor(e, isStart = false) {
    const pt = this._getEditorPoint(e);

    if (isStart || !this._strokePts) {
        this._strokeIsPen = pt.isPen;
        this._strokePts = [pt];
        this._lastMid = { x: pt.x, y: pt.y, r: pt.r };
        const ctx = this.editorCtx;
        ctx.save();
        ctx.globalCompositeOperation = this.isEraser ? 'destination-out' : 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
    }

    const pts = this._strokePts;
    const prev = pts[pts.length - 1];
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < 0.25) return;

    // Smooth rapid radius jumps on pen strokes so ink thickness flows cleanly
    if (pt.isPen) {
        pt.r = prev.r + (pt.r - prev.r) * 0.45;
    }
    pts.push(pt);

    const mid = {
        x: (prev.x + pt.x) * 0.5,
        y: (prev.y + pt.y) * 0.5,
        r: (prev.r + pt.r) * 0.5
    };

    if (pts.length === 2) {
        this._strokeEditorSegment(
            this._lastMid.x, this._lastMid.y, this._lastMid.r,
            prev.x, prev.y, prev.r,
            mid.x, mid.y, mid.r,
            false
        );
    } else {
        this._strokeEditorSegment(
            this._lastMid.x, this._lastMid.y, this._lastMid.r,
            prev.x, prev.y, prev.r,
            mid.x, mid.y, mid.r,
            true
        );
    }
    this._lastMid = mid;
  }

  _finishEditorStroke() {
    if (!this._strokePts || !this._lastMid) return;
    if (this._strokePts.length >= 2) {
        const last = this._strokePts[this._strokePts.length - 1];
        this._strokeEditorSegment(
            this._lastMid.x, this._lastMid.y, this._lastMid.r,
            last.x, last.y, last.r,
            last.x, last.y, last.r,
            false
        );
    }
    this._strokePts = null;
    this._lastMid = null;
  }

  _updateFromEditor() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    c.getContext('2d').drawImage(this.editorCanvas, 0, 0);
    c._tipVersion = ((this.selectedTipCanvas && this.selectedTipCanvas._tipVersion) || 0) + 1;
    this.selectedTipCanvas = c;
    
    if (this.activeBankIndex >= 0 && this.tips[this.activeBankIndex]) {
        this.tips[this.activeBankIndex].canvas = c;
    } else if (this.activeGeneratedIndex >= 0 && this.generatedTips[this.activeGeneratedIndex]) {
        this.generatedTips[this.activeGeneratedIndex].canvas = c;
    }
    
    this._renderPalette(true);
    this._updateActiveTip();
    this._saveToStorage();
  }

  _renderPalette(forceRedraw = false) {
    const mainGrid = document.getElementById('tip-main-slots');
    if (mainGrid) {
      const existingMain = mainGrid.querySelectorAll('.tip-swatch');
      if (existingMain.length === this.tips.length) {
        existingMain.forEach((slot, i) => {
          slot.classList.toggle('active-swatch', this.activeBankIndex === i);
          const tipCanvas = this.tips[i]?.canvas;
          if (tipCanvas && (forceRedraw || slot._drawnCanvas !== tipCanvas)) {
            const thumb = slot.querySelector('canvas');
            if (thumb) {
              const tctx = thumb.getContext('2d');
              tctx.clearRect(0, 0, 64, 64);
              tctx.drawImage(tipCanvas, 0, 0, 64, 64);
              slot._drawnCanvas = tipCanvas;
            }
          }
        });
      } else {
        mainGrid.innerHTML = '';
        this.tips.forEach((tip, i) => {
          const slot = document.createElement('div');
          slot.className = 'tip-swatch';
          if (this.activeBankIndex === i) slot.classList.add('active-swatch');
          
          const thumb = document.createElement('canvas');
          thumb.width = 64; thumb.height = 64;
          thumb.getContext('2d').drawImage(tip.canvas, 0, 0, 64, 64);
          slot._drawnCanvas = tip.canvas;
          slot.appendChild(thumb);
          
          slot.onclick = () => {
            this.activeBankIndex = i;
            this.activeGeneratedIndex = -1;
            this.selectedTipCanvas = tip.canvas;
            this.editorCtx.save();
            this.editorCtx.globalCompositeOperation = 'source-over';
            this.editorCtx.clearRect(0,0,128,128);
            this.editorCtx.drawImage(tip.canvas, 0, 0);
            this.editorCtx.restore();
            this._renderPalette(false);
            this._updateActiveTip();
            this._saveToStorage();
          };
          mainGrid.appendChild(slot);
        });
      }
    }

    const genGrid = document.getElementById('tip-generated-slots');
    if (genGrid) {
      const existingGen = genGrid.querySelectorAll('.tip-swatch');
      if (existingGen.length === this.generatedTips.length) {
        existingGen.forEach((slot, i) => {
          slot.classList.toggle('active-swatch', this.activeGeneratedIndex === i);
          const tipCanvas = this.generatedTips[i]?.canvas;
          if (tipCanvas && (forceRedraw || slot._drawnCanvas !== tipCanvas)) {
            const thumb = slot.querySelector('canvas');
            if (thumb) {
              const tctx = thumb.getContext('2d');
              tctx.clearRect(0, 0, 64, 64);
              tctx.drawImage(tipCanvas, 0, 0, 64, 64);
              slot._drawnCanvas = tipCanvas;
            }
          }
        });
      } else {
        genGrid.innerHTML = '';
        this.generatedTips.forEach((tip, i) => {
            const slot = document.createElement('div');
            slot.className = 'tip-swatch';
            if (this.activeGeneratedIndex === i) slot.classList.add('active-swatch');
            const thumb = document.createElement('canvas');
            thumb.width = 64; thumb.height = 64;
            thumb.getContext('2d').drawImage(tip.canvas, 0, 0, 64, 64);
            slot._drawnCanvas = tip.canvas;
            slot.appendChild(thumb);
            
            slot.onclick = () => {
                this.activeGeneratedIndex = i;
                this.activeBankIndex = -1;
                this.selectedTipCanvas = tip.canvas;
                this.editorCtx.save();
                this.editorCtx.globalCompositeOperation = 'source-over';
                this.editorCtx.clearRect(0,0,128,128);
                this.editorCtx.drawImage(tip.canvas, 0, 0);
                this.editorCtx.restore();
                
                this._renderPalette(false);
                this._updateActiveTip();
                this._saveToStorage();
            };
            genGrid.appendChild(slot);
        });
      }
    }
  }

  updateActiveTipSettings(height, oiliness, airbrush) {
    let target = null;
    if (this.activeBankIndex >= 0) {
        target = this.tips[this.activeBankIndex];
    } else if (this.activeGeneratedIndex >= 0) {
        target = this.generatedTips[this.activeGeneratedIndex];
    }
    
    if (target) {
        if (height !== undefined) target.paintHeight = height;
        if (oiliness !== undefined) target.oiliness = oiliness;
        if (airbrush !== undefined) target.airbrush = airbrush;
        this._saveToStorage();
    }
  }

  getActiveTip() {
    if (this.activeBankIndex >= 0) {
        return this.tips[this.activeBankIndex];
    } else if (this.activeGeneratedIndex >= 0) {
        return this.generatedTips[this.activeGeneratedIndex];
    }
    return null;
  }

  updateActiveTipAdvancedSettings(key, val) {
    const target = this.getActiveTip();
    if (target) {
        target[key] = val;
        this._saveToStorage();
    }
  }

  _updateActiveTip() {
    this.refreshTip();
  }

  refreshTip(skipStorage = false) {
    let tip = null;
    if (this.activeBankIndex >= 0) {
        tip = this.tips[this.activeBankIndex];
    } else if (this.activeGeneratedIndex >= 0) {
        tip = this.generatedTips[this.activeGeneratedIndex];
    } else {
        tip = { canvas: this.selectedTipCanvas, paintHeight: 0, oiliness: 0.5, airbrush: 0 };
    }

    if (tip && tip.canvas) {
        if (!tip.canvas._tipVersion) tip.canvas._tipVersion = 1;
        this.selectedTipCanvas = tip.canvas;
        if (this.editorCtx) {
            this.editorCtx.save();
            this.editorCtx.globalCompositeOperation = 'source-over';
            this.editorCtx.clearRect(0, 0, 128, 128);
            this.editorCtx.drawImage(tip.canvas, 0, 0);
            this.editorCtx.restore();
        }
    }

    if (this.onTipChange) {
      this.onTipChange(tip.canvas, tip.paintHeight, tip.oiliness, tip.airbrush, skipStorage);
    }
  }

  _saveToStorage() {
      if (!this.storage) return;
      
      const mainData = this.tips.map(t => ({ 
          src: t.canvas.toDataURL(), 
          paintHeight: t.paintHeight || 0,
          oiliness: t.oiliness ?? 0.5,
          airbrush: t.airbrush || 0,
          spacing: t.spacing ?? 0.05,
          pressureEnabled: t.pressureEnabled ?? true,
          pressureOpacityInfluence: t.pressureOpacityInfluence ?? 1.0,
          pressureSizeInfluence: t.pressureSizeInfluence ?? 1.0,
          jitterSize: t.jitterSize ?? 0,
          jitterAngle: t.jitterAngle ?? 0,
          jitterPos: t.jitterPos ?? 0,
          jitterHue: t.jitterHue ?? 0,
          smudgeFlowBoost: t.smudgeFlowBoost ?? 1.0,
          _smudgeCalibratedV2: true,
          smudgePickup: t.smudgePickup ?? 2.0,
          brushSharpen: t.brushSharpen ?? 0.0,
          wireDensity: t.wireDensity ?? 30,
          wireRange: t.wireRange ?? 4.0,
          wireMinDist: t.wireMinDist ?? 0.5,
          airWetness: t.airWetness ?? 100,
          airStreamFlow: t.airStreamFlow ?? 100,
          airBloom: t.airBloom ?? 50,
          airEdge: t.airEdge ?? 30,
          airGranulation: t.airGranulation ?? 30,
          airTipPour: t.airTipPour ?? 100,
          airFollowStroke: t.airFollowStroke ?? false,
          airTipAngle: t.airTipAngle ?? 0,
          airTipHardness: t.airTipHardness ?? 55,
          airPressureFlow: t.airPressureFlow ?? 35
      }));
      localStorage.setItem('brushTips', JSON.stringify(mainData));

      const genData = this.generatedTips.map(t => ({
          src: t.canvas ? t.canvas.toDataURL() : null,
          paintHeight: t.paintHeight || 0,
          oiliness: t.oiliness ?? 0.5,
          airbrush: t.airbrush || 0,
          spacing: t.spacing ?? 0.05,
          pressureEnabled: t.pressureEnabled ?? true,
          pressureOpacityInfluence: t.pressureOpacityInfluence ?? 1.0,
          pressureSizeInfluence: t.pressureSizeInfluence ?? 1.0,
          jitterSize: t.jitterSize ?? 0,
          jitterAngle: t.jitterAngle ?? 0,
          jitterPos: t.jitterPos ?? 0,
          jitterHue: t.jitterHue ?? 0,
          smudgeFlowBoost: t.smudgeFlowBoost ?? 1.0,
          _smudgeCalibratedV2: true,
          smudgePickup: t.smudgePickup ?? 2.0,
          brushSharpen: t.brushSharpen ?? 0.0,
          wireDensity: t.wireDensity ?? 30,
          wireRange: t.wireRange ?? 4.0,
          wireMinDist: t.wireMinDist ?? 0.5,
          airWetness: t.airWetness ?? 100,
          airStreamFlow: t.airStreamFlow ?? 100,
          airBloom: t.airBloom ?? 50,
          airEdge: t.airEdge ?? 30,
          airGranulation: t.airGranulation ?? 30,
          airTipPour: t.airTipPour ?? 100,
          airFollowStroke: t.airFollowStroke ?? false,
          airTipAngle: t.airTipAngle ?? 0,
          airTipHardness: t.airTipHardness ?? 55,
          airPressureFlow: t.airPressureFlow ?? 35
      }));
      localStorage.setItem('brushTips_generated', JSON.stringify(genData));

      localStorage.setItem('activeTipBankIndex', this.activeBankIndex);
      localStorage.setItem('activeTipGenIndex', this.activeGeneratedIndex);
  }
}

