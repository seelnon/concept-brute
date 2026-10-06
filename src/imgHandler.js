import { TOOLS } from './constants.js';

export class ImgHandler {
  constructor(engine, onUpdate = null) {
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.active = false;
    
    // UI Elements
    this.topBarMain = document.getElementById('top-bar');
    this.topBarRef = document.getElementById('top-bar-ref');
    this.btnBack = document.getElementById('btn-ref-back');
    this.btnDelete = document.getElementById('btn-ref-delete');
    this.opacitySlider = document.getElementById('ref-opacity');
    this.opacityVal = document.getElementById('ref-opacity-val');

    // Ref specific tool buttons
    this.refTools = {
      MOVE: document.getElementById('btn-ref-move'),
      CROP: document.getElementById('btn-ref-crop'),
      EXTRACT: document.getElementById('btn-ref-extract'),
      KNIFE: document.getElementById('btn-ref-knife'),
      COLOR: document.getElementById('btn-ref-color')
    };

    // Editor Modal Elements
    this.modal = document.getElementById('modal-ref-editor');
    this.btnCloseEditor = document.getElementById('btn-close-ref-editor');
    this.btnApply = document.getElementById('btn-ref-editor-apply');
    this.btnCancel = document.getElementById('btn-ref-editor-cancel');
    this.editorCanvas = document.getElementById('ref-editor-canvas');
    this.editorSvg = document.getElementById('ref-editor-svg');
    this.colorChannelSelect = document.getElementById('color-channel-select');
    this.knifeModeSelect = document.getElementById('knife-mode-select');

    // Tabs
    this.tabs = {
      crop: document.getElementById('btn-tab-crop'),
      knife: document.getElementById('btn-tab-knife'),
      color: document.getElementById('btn-tab-color')
    };
    
    this.tabContentViews = {
      crop: document.getElementById('tab-content-crop'),
      knife: document.getElementById('tab-content-knife'),
      color: document.getElementById('tab-content-color')
    };

    // Crop Sliders
    this.cropSliders = {
      left: document.getElementById('crop-slider-left'),
      right: document.getElementById('crop-slider-right'),
      top: document.getElementById('crop-slider-top'),
      bottom: document.getElementById('crop-slider-bottom')
    };
    this.btnCropReset = document.getElementById('btn-crop-reset');

    // Color Sliders
    this.colorSliders = {
      black: document.getElementById('slider-col-black'),
      gamma: document.getElementById('slider-col-gamma'),
      white: document.getElementById('slider-col-white'),
      outblack: document.getElementById('slider-col-outblack'),
      outwhite: document.getElementById('slider-col-outwhite')
    };
    this.colorValuesText = {
      black: document.getElementById('val-col-black'),
      gamma: document.getElementById('val-col-gamma'),
      white: document.getElementById('val-col-white'),
      outblack: document.getElementById('val-col-outblack'),
      outwhite: document.getElementById('val-col-outwhite')
    };
    this.btnColorReset = document.getElementById('btn-color-reset');

    // Knife controls
    this.btnKnifeClear = document.getElementById('btn-knife-clear');
    this.btnKnifeUndo = document.getElementById('btn-knife-undo');
    this.knifeStatus = document.getElementById('knife-status');

    // State Variables for Modal Editor
    this.selectedRef = null;
    this.activeTab = 'crop';
    this.origImgData = null; // Unmodified pixels
    this.origCanvas = null;
    
    this.cropVal = { left: 0, right: 0, top: 0, bottom: 0 };
    this.knifePoints = [];
    this.knifeMode = 'lasso';
    this.colorVal = {
      all: { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      r:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      g:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      b:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 }
    };

    this.isDraggingCrop = false;
    this.dragStartPos = null;

    this._initEvents();
    this._initEditorEvents();

    window.addEventListener('resize', () => {
      if (this.modal && !this.modal.classList.contains('hidden')) {
        this.resizeEditorWorkspace();
      }
    });
  }

  activate() {
    this.active = true;
    this.topBarMain.classList.add('hidden');
    this.topBarRef.classList.remove('hidden');
    this.syncUI();
  }

  deactivate() {
    this.active = false;
    this.topBarMain.classList.remove('hidden');
    this.topBarRef.classList.add('hidden');
    if (this.modal) this.modal.classList.add('hidden');
  }

  syncUI() {
    const selected = this.engine.referenceImages[this.engine.selectedRefIndex];
    if (selected) {
      const val = Math.round(selected.opacity * 100);
      if (this.opacitySlider) this.opacitySlider.value = val;
      if (this.opacityVal) this.opacityVal.innerText = `${val}%`;
    }
  }

  _initEvents() {
    // Back to painting
    if (this.btnBack) {
      this.btnBack.onclick = () => {
         const layer1 = document.getElementById('layer-btn-1');
         if (layer1) layer1.click();
      };
    }

    // Delete selected image
    if (this.btnDelete) {
      this.btnDelete.onclick = () => {
          if (this.engine.selectedRefIndex >= 0) {
              this.engine.removeReferenceImage(this.engine.selectedRefIndex);
              if (this.onUpdate) this.onUpdate();
          }
      };
    }

    // Opacity
    if (this.opacitySlider) {
      this.opacitySlider.oninput = (e) => {
          const val = parseInt(e.target.value);
          this.opacityVal.innerText = `${val}%`;
          const selected = this.engine.referenceImages[this.engine.selectedRefIndex];
          if (selected) {
              selected.opacity = val / 100;
              this.engine.refresh();
          }
      };
    }

    // Secondary ref bar button clicks - Open our modular master Ref Editor
    Object.entries(this.refTools).forEach(([id, btn]) => {
      if (!btn) return;
      btn.onclick = (e) => {
        e.stopPropagation();
        this._setRefTool(id);

        if (id === 'EXTRACT') {
            if (this.engine.selectedRefIndex >= 0) {
                this.engine.extractPaletteFromRef(this.engine.selectedRefIndex).then(() => {
                    if (this.onUpdate) this.onUpdate();
                });
            }
        } else if (id === 'CROP') {
            this.openEditor('crop');
        } else if (id === 'KNIFE') {
            this.openEditor('knife');
        } else if (id === 'COLOR') {
            this.openEditor('color');
        }
      };
    });
  }

  _setRefTool(toolId) {
    Object.values(this.refTools).forEach(b => b?.classList.remove('active-tool'));
    this.refTools[toolId]?.classList.add('active-tool');
    
    if (toolId === 'MOVE') {
        this.engine.brush.type = TOOLS.REF_MOVE;
    }
    console.log(`Switching to REF Tool: ${toolId}`);
  }

  // --- MASTER MODAL EDITOR CONTROL LOGIC ---

  openEditor(tabMode = 'crop') {
    if (this.engine.selectedRefIndex < 0) {
      alert('Please select a reference image first.');
      return;
    }
    this.selectedRef = this.engine.referenceImages[this.engine.selectedRefIndex];
    if (!this.selectedRef || !this.selectedRef.img) return;

    // Show modal overlay
    if (this.modal) {
      this.modal.classList.remove('hidden');
      
      // Clear saved position to ensure it opens centered by default
      if (this.engine.windowPositions) {
          delete this.engine.windowPositions['modal-ref-editor'];
          localStorage.setItem('window_positions', JSON.stringify(this.engine.windowPositions));
      }
      
      // Center modal in pixels
      const modalWidth = this.modal.offsetWidth;
      const modalHeight = this.modal.offsetHeight;
      this.modal.style.left = (window.innerWidth - modalWidth) / 2 + 'px';
      this.modal.style.top = (window.innerHeight - modalHeight) / 2 + 'px';
      this.modal.style.transform = '';
    }

    // Build Original Canvas Data model
    this.origCanvas = document.createElement('canvas');
    this.origCanvas.width = this.selectedRef.img.width;
    this.origCanvas.height = this.selectedRef.img.height;
    const octx = this.origCanvas.getContext('2d');
    octx.drawImage(this.selectedRef.img, 0, 0);
    this.origImgData = octx.getImageData(0, 0, this.origCanvas.width, this.origCanvas.height);

    // Reset parameters
    this.cropVal = { left: 0, right: 0, top: 0, bottom: 0 };
    this.knifePoints = [];
    this.knifeMode = this.knifeModeSelect ? this.knifeModeSelect.value : 'lasso';
    this.colorVal = {
      all: { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      r:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      g:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 },
      b:   { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 }
    };

    if (this.colorBWCheckbox) {
      this.colorBWCheckbox.checked = false;
    }
    this.colorBWMode = false;

    // Update Sliders in UI
    this.syncCropSliders();
    this.syncColorSliders('all');
    if (this.colorChannelSelect) this.colorChannelSelect.value = 'all';
    this.updateKnifeStatus();

    // Switch active Tab visual indicators
    this.switchTab(tabMode);

    // Initial render
    this.renderPreview();
  }

  closeEditor() {
    if (this.modal) this.modal.classList.add('hidden');
    this.selectedRef = null;
    this.origImgData = null;
    this.origCanvas = null;
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    Object.entries(this.tabs).forEach(([id, tabBtn]) => {
      if (!tabBtn) return;
      if (id === tabId) {
        tabBtn.style.background = 'white';
        tabBtn.style.color = 'black';
      } else {
        tabBtn.style.background = 'black';
        tabBtn.style.color = 'white';
      }
    });

    Object.entries(this.tabContentViews).forEach(([id, view]) => {
      if (view) {
        if (id === tabId) {
          view.classList.remove('hidden');
        } else {
          view.classList.add('hidden');
        }
      }
    });

    this.renderPreview();
  }

  _initEditorEvents() {
    // Top Right close button
    if (this.btnCloseEditor) {
      this.btnCloseEditor.onclick = () => this.closeEditor();
    }

    // Cancel Button
    if (this.btnCancel) {
      this.btnCancel.onclick = () => this.closeEditor();
    }

    // Tab switcher links
    Object.entries(this.tabs).forEach(([id, tabBtn]) => {
      if (tabBtn) {
        tabBtn.onclick = () => this.switchTab(id);
      }
    });

    // Apply Changes Button
    if (this.btnApply) {
      this.btnApply.onclick = () => this.applyChanges();
    }

    // Setup Crop Sliders real-time rendering response
    Object.entries(this.cropSliders).forEach(([side, slider]) => {
      if (slider) {
        slider.oninput = (e) => {
          this.cropVal[side] = parseInt(e.target.value);
          const valSpan = document.getElementById(`crop-val-${side}`);
          if (valSpan) {
            valSpan.innerText = `${this.cropVal[side]}%`;
          }
          this.renderPreview();
        };
      }
    });

    // Setup Crop Reset
    if (this.btnCropReset) {
      this.btnCropReset.onclick = () => {
        this.cropVal = { left: 0, right: 0, top: 0, bottom: 0 };
        this.syncCropSliders();
        this.renderPreview();
      };
    }

    // Color selectors & parameters real-time response
    if (this.colorChannelSelect) {
      this.colorChannelSelect.onchange = (e) => {
        this.syncColorSliders(e.target.value);
      };
    }

    Object.entries(this.colorSliders).forEach(([prop, slider]) => {
      if (slider) {
        slider.oninput = (e) => {
          const chan = this.colorChannelSelect ? this.colorChannelSelect.value : 'all';
          let val = parseFloat(e.target.value);
          if (prop === 'gamma') {
            val = val / 100; // gamma was scaled * 100 on slider
          }
          this.colorVal[chan][prop] = val;
          
          // Update visual numeric indicators
          if (this.colorValuesText[prop]) {
            this.colorValuesText[prop].innerText = prop === 'gamma' ? val.toFixed(2) : Math.round(val);
          }
          
          this.renderPreview();
        };
      }
    });

    // Black & White mode checkbox real-time response
    this.colorBWCheckbox = document.getElementById('color-bw-mode');
    if (this.colorBWCheckbox) {
      this.colorBWCheckbox.onchange = (e) => {
        this.colorBWMode = e.target.checked;
        this.renderPreview();
      };
    }

    if (this.btnColorReset) {
      this.btnColorReset.onclick = () => {
        const chan = this.colorChannelSelect ? this.colorChannelSelect.value : 'all';
        this.colorVal[chan] = { black: 0, gamma: 1.0, white: 255, outblack: 0, outwhite: 255 };
        if (this.colorBWCheckbox) {
          this.colorBWCheckbox.checked = false;
        }
        this.colorBWMode = false;
        this.syncColorSliders(chan);
        this.renderPreview();
      };
    }

    // Knife parameters real-time response
    if (this.knifeModeSelect) {
      this.knifeModeSelect.onchange = (e) => {
        this.knifeMode = e.target.value;
        this.knifePoints = [];
        this.updateKnifeStatus();
        this.renderPreview();
      };
    }
    if (this.btnKnifeClear) {
      this.btnKnifeClear.onclick = () => {
        this.knifePoints = [];
        this.updateKnifeStatus();
        this.renderPreview();
      };
    }
    if (this.btnKnifeUndo) {
      this.btnKnifeUndo.onclick = () => {
        this.knifePoints.pop();
        this.updateKnifeStatus();
        this.renderPreview();
      };
    }

    // Pointer/Dragging events on the interactive workspace area
    const workspaceCol = document.getElementById('ref-editor-workspace-col');
    if (workspaceCol) {
      workspaceCol.addEventListener('mousedown', (e) => this.handleCanvasMouseDown(e));

      // Support touch events
      workspaceCol.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          const fakeEvent = {
            clientX: e.touches[0].clientX,
            clientY: e.touches[0].clientY,
            preventDefault: () => e.preventDefault()
          };
          this.handleCanvasMouseDown(fakeEvent);
        }
      });
    }

    // Window level listeners make moving mouse outside the workspace extremely robust!
    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingCrop) {
        this.handleCanvasMouseMove(e);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDraggingCrop) {
        this.handleCanvasMouseUp(e);
      }
    });

    window.addEventListener('touchmove', (e) => {
      if (this.isDraggingCrop && e.touches.length === 1) {
        const fakeEvent = {
          clientX: e.touches[0].clientX,
          clientY: e.touches[0].clientY,
          preventDefault: () => e.preventDefault()
        };
        this.handleCanvasMouseMove(fakeEvent);
      }
    });

    window.addEventListener('touchend', (e) => {
      if (this.isDraggingCrop) {
        this.handleCanvasMouseUp(e);
      }
    });
  }

  // Syncing state views
  syncCropSliders() {
    Object.entries(this.cropSliders).forEach(([side, slider]) => {
      if (slider) {
        slider.value = this.cropVal[side];
        const valSpan = document.getElementById(`crop-val-${side}`);
        if (valSpan) {
          valSpan.innerText = `${this.cropVal[side]}%`;
        }
      }
    });
  }

  syncColorSliders(channel) {
    const vals = this.colorVal[channel];
    if (this.colorSliders.black) this.colorSliders.black.value = vals.black;
    if (this.colorSliders.gamma) this.colorSliders.gamma.value = Math.round(vals.gamma * 100);
    if (this.colorSliders.white) this.colorSliders.white.value = vals.white;
    if (this.colorSliders.outblack) this.colorSliders.outblack.value = vals.outblack;
    if (this.colorSliders.outwhite) this.colorSliders.outwhite.value = vals.outwhite;

    // Sync texts
    if (this.colorValuesText.black) this.colorValuesText.black.innerText = Math.round(vals.black);
    if (this.colorValuesText.gamma) this.colorValuesText.gamma.innerText = vals.gamma.toFixed(2);
    if (this.colorValuesText.white) this.colorValuesText.white.innerText = Math.round(vals.white);
    if (this.colorValuesText.outblack) this.colorValuesText.outblack.innerText = Math.round(vals.outblack);
    if (this.colorValuesText.outwhite) this.colorValuesText.outwhite.innerText = Math.round(vals.outwhite);
  }

  updateKnifeStatus() {
    if (this.knifeStatus) {
      if (this.knifePoints.length === 0) {
        this.knifeStatus.innerText = '0 POINTS PLACED';
        this.knifeStatus.style.color = '#d97706';
      } else {
        this.knifeStatus.innerText = `${this.knifePoints.length} POINTS PLACED ${this.knifeMode === 'slice' && this.knifePoints.length >= 2 ? '(READY TO SLICE)' : ''}`;
        this.knifeStatus.style.color = '#15803d';
      }
    }
  }

  // --- INTERACTIVE PIXEL RENDERING PREVIEW ENGINE ---

  generateLUT(black, gamma, white, outBlack, outWhite) {
    const lut = new Uint8Array(256);
    const range = white - black;
    const invGamma = 1 / gamma;
    for (let i = 0; i < 256; i++) {
        let val = (i - black) / (range || 1);
        val = Math.max(0, Math.min(1, val));
        
        if (gamma !== 1) {
            val = Math.pow(val, invGamma);
        }
        
        const out = outBlack + val * (outWhite - outBlack);
        lut[i] = Math.max(0, Math.min(255, Math.round(out)));
    }
    return lut;
  }

  resizeEditorWorkspace() {
    if (!this.selectedRef || !this.origImgData) return;
    
    const workspaceCol = document.getElementById('ref-editor-workspace-col');
    const container = document.getElementById('ref-editor-canvas-container');
    if (!workspaceCol || !container || !this.editorCanvas) return;

    const w = this.origImgData.width;
    const h = this.origImgData.height;

    const rect = workspaceCol.getBoundingClientRect();
    const availW = rect.width - 32;
    const availH = rect.height - 32;

    if (availW <= 0 || availH <= 0 || w <= 0 || h <= 0) return;

    // Calculate scale to fit inside availW x availH while maintaining W/H aspect ratio
    const scale = Math.min(availW / w, availH / h);
    const displayW = Math.round(w * scale);
    const displayH = Math.round(h * scale);

    // Apply exact pixel dimensions to the wrapper container style
    container.style.width = `${displayW}px`;
    container.style.height = `${displayH}px`;

    // Apply exact pixel dimensions to the canvas style
    this.editorCanvas.style.width = `${displayW}px`;
    this.editorCanvas.style.height = `${displayH}px`;
  }

  renderPreview() {
    if (!this.selectedRef || !this.editorCanvas || !this.origImgData) return;

    if (this.editorSvg) {
      this.editorSvg.innerHTML = '';
    }

    this.resizeEditorWorkspace();

    const w = this.origImgData.width;
    const h = this.origImgData.height;

    // 1. Maintain layout sizes
    if (this.editorCanvas.width !== w || this.editorCanvas.height !== h) {
      this.editorCanvas.width = w;
      this.editorCanvas.height = h;
    }

    const ctx = this.editorCanvas.getContext('2d');
    if (!ctx) return;

    // Create a workspace image copy
    const previewImgData = ctx.createImageData(w, h);
    const srcData = this.origImgData.data;
    const destData = previewImgData.data;
    
    // 2. Generate and combine Levels LUTs
    const lutAll = this.generateLUT(this.colorVal.all.black, this.colorVal.all.gamma, this.colorVal.all.white, this.colorVal.all.outblack, this.colorVal.all.outwhite);
    const lutR = this.generateLUT(this.colorVal.r.black, this.colorVal.r.gamma, this.colorVal.r.white, this.colorVal.r.outblack, this.colorVal.r.outwhite);
    const lutG = this.generateLUT(this.colorVal.g.black, this.colorVal.g.gamma, this.colorVal.g.white, this.colorVal.g.outblack, this.colorVal.g.outwhite);
    const lutB = this.generateLUT(this.colorVal.b.black, this.colorVal.b.gamma, this.colorVal.b.white, this.colorVal.b.outblack, this.colorVal.b.outwhite);

    const finalLUT_R = new Uint8Array(256);
    const finalLUT_G = new Uint8Array(256);
    const finalLUT_B = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const masterVal = lutAll[i];
      finalLUT_R[i] = lutR[masterVal];
      finalLUT_G[i] = lutG[masterVal];
      finalLUT_B[i] = lutB[masterVal];
    }

    // 3. Render color tone pixels
    for (let i = 0; i < srcData.length; i += 4) {
      const r = finalLUT_R[srcData[i]];
      const g = finalLUT_G[srcData[i + 1]];
      const b = finalLUT_B[srcData[i + 2]];
      
      if (this.colorBWMode) {
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        destData[i]     = lum;
        destData[i + 1] = lum;
        destData[i + 2] = lum;
      } else {
        destData[i]     = r;
        destData[i + 1] = g;
        destData[i + 2] = b;
      }
      destData[i + 3] = srcData[i + 3];
    }

    ctx.putImageData(previewImgData, 0, 0);

    // 4. Overlays based on active Mode Tab
    if (this.activeTab === 'crop') {
      const cropLeft = Math.round(w * this.cropVal.left / 100);
      const cropRight = Math.round(w * (100 - this.cropVal.right) / 100);
      const cropTop = Math.round(h * this.cropVal.top / 100);
      const cropBottom = Math.round(h * (100 - this.cropVal.bottom) / 100);

      // Fill outside with dark overlay transparent shroud
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      
      // Top slice
      ctx.fillRect(0, 0, w, cropTop);
      // Bottom slice
      ctx.fillRect(0, cropBottom, w, h - cropBottom);
      // Left slice
      ctx.fillRect(0, cropTop, cropLeft, cropBottom - cropTop);
      // Right slice
      ctx.fillRect(cropRight, cropTop, w - cropRight, cropBottom - cropTop);

      // Outline the focus zone
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth = 3;
      ctx.shadowColor = 'black';
      ctx.shadowBlur = 4;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(cropLeft, cropTop, cropRight - cropLeft, cropBottom - cropTop);
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    } 
    else if (this.activeTab === 'knife') {
      if (this.knifePoints.length > 0 && this.editorSvg) {
        this.editorSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        
        let d = `M ${this.knifePoints[0].x} ${this.knifePoints[0].y}`;
        for (let i = 1; i < this.knifePoints.length; i++) {
          d += ` L ${this.knifePoints[i].x} ${this.knifePoints[i].y}`;
        }
        
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', this.knifeMode === 'lasso' && this.knifePoints.length > 2 ? d + ' Z' : d);
        pathEl.setAttribute('stroke', '#ff0033');
        
        const sw = Math.max(3, w / 200);
        pathEl.setAttribute('stroke-width', sw.toString());
        pathEl.setAttribute('fill', this.knifeMode === 'lasso' && this.knifePoints.length > 2 ? 'rgba(255,0,50,0.15)' : 'none');
        pathEl.setAttribute('stroke-linejoin', 'round');
        pathEl.setAttribute('stroke-linecap', 'round');
        pathEl.style.filter = 'drop-shadow(0px 2px 3px rgba(0,0,0,0.75))';
        
        this.editorSvg.appendChild(pathEl);

        // Draw point anchors
        this.knifePoints.forEach((pt, idx) => {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', pt.x.toString());
          circle.setAttribute('cy', pt.y.toString());
          
          const radius = Math.max(6, w / 100);
          circle.setAttribute('r', radius.toString());
          circle.setAttribute('fill', idx === 0 ? '#00f0ff' : '#ff0033');
          circle.setAttribute('stroke', '#ffffff');
          circle.setAttribute('stroke-width', Math.max(1.5, w / 400).toString());
          circle.style.filter = 'drop-shadow(0px 1px 2px rgba(0,0,0,0.6))';
          
          this.editorSvg.appendChild(circle);
        });
      }
    }
  }

  // --- MOUSE TRACKING COORDINATES HELPERS ---

  getMousePosOnImage(e, clamp = true) {
    if (!this.editorCanvas) return null;
    const rect = this.editorCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Map into original pixel boundary domain
    let pxX = (x / rect.width) * this.editorCanvas.width;
    let pxY = (y / rect.height) * this.editorCanvas.height;

    if (clamp) {
      pxX = Math.max(0, Math.min(this.editorCanvas.width, pxX));
      pxY = Math.max(0, Math.min(this.editorCanvas.height, pxY));
    }
    return { x: pxX, y: pxY };
  }

  handleCanvasMouseDown(e) {
    if (e.preventDefault) e.preventDefault();
    const pos = this.getMousePosOnImage(e, this.activeTab !== 'knife');
    if (!pos) return;

    if (this.activeTab === 'crop') {
      this.isDraggingCrop = true;
      this.dragStartPos = pos;
      
      // Clear previous crop upon new drag
      this.cropVal = { left: 0, right: 0, top: 0, bottom: 0 };
    } 
    else if (this.activeTab === 'knife') {
      if (this.knifeMode === 'slice') {
        if (this.knifePoints.length >= 2) {
          this.knifePoints = [];
        }
        this.knifePoints.push(pos);
      } else {
        // Lasso points placement
        // If clicking close to start point, we can consider closed, but simply drawing is fine
        if (this.knifePoints.length > 2) {
          const dx = pos.x - this.knifePoints[0].x;
          const dy = pos.y - this.knifePoints[0].y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < 15) {
            // Closed back loop!
            this.updateKnifeStatus();
            this.renderPreview();
            return;
          }
        }
        this.knifePoints.push(pos);
      }
      this.updateKnifeStatus();
      this.renderPreview();
    }
  }

  handleCanvasMouseMove(e) {
    if (!this.isDraggingCrop || !this.dragStartPos || this.activeTab !== 'crop') return;
    const pos = this.getMousePosOnImage(e, true);
    if (!pos) return;

    const w = this.editorCanvas.width;
    const h = this.editorCanvas.height;

    const xMin = Math.min(this.dragStartPos.x, pos.x);
    const xMax = Math.max(this.dragStartPos.x, pos.x);
    const yMin = Math.min(this.dragStartPos.y, pos.y);
    const yMax = Math.max(this.dragStartPos.y, pos.y);

    this.cropVal.left = Math.round((xMin / w) * 100);
    this.cropVal.right = Math.round(((w - xMax) / w) * 100);
    this.cropVal.top = Math.round((yMin / h) * 100);
    this.cropVal.bottom = Math.round(((h - yMax) / h) * 100);

    // Limit ranges
    Object.keys(this.cropVal).forEach(side => {
      this.cropVal[side] = Math.max(0, Math.min(95, this.cropVal[side]));
    });

    this.syncCropSliders();
    this.renderPreview();
  }

  handleCanvasMouseUp(e) {
    this.isDraggingCrop = false;
    this.dragStartPos = null;
  }

  // --- BAKING & SAVING PIPELINE ENGINE ---

  applyChanges() {
    if (!this.selectedRef || !this.origImgData) return;

    // Push undo state!
    this.engine._pushHistory({
        type: 'reference_change',
        referenceImagesState: this.engine.captureReferenceImagesState()
    });
    this.engine._clearStack(this.engine.redoStack);

    const w = this.origImgData.width;
    const h = this.origImgData.height;

    // Common Color LUT generation
    const lutAll = this.generateLUT(this.colorVal.all.black, this.colorVal.all.gamma, this.colorVal.all.white, this.colorVal.all.outblack, this.colorVal.all.outwhite);
    const lutR = this.generateLUT(this.colorVal.r.black, this.colorVal.r.gamma, this.colorVal.r.white, this.colorVal.r.outblack, this.colorVal.r.outwhite);
    const lutG = this.generateLUT(this.colorVal.g.black, this.colorVal.g.gamma, this.colorVal.g.white, this.colorVal.g.outblack, this.colorVal.g.outwhite);
    const lutB = this.generateLUT(this.colorVal.b.black, this.colorVal.b.gamma, this.colorVal.b.white, this.colorVal.b.outblack, this.colorVal.b.outwhite);

    const finalLUT_R = new Uint8Array(256);
    const finalLUT_G = new Uint8Array(256);
    const finalLUT_B = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const masterVal = lutAll[i];
      finalLUT_R[i] = lutR[masterVal];
      finalLUT_G[i] = lutG[masterVal];
      finalLUT_B[i] = lutB[masterVal];
    }

    if (this.activeTab === 'crop' || this.activeTab === 'color') {
      // 1. Evaluate crop bounding boxes
      const cLeft = Math.round(w * this.cropVal.left / 100);
      const cRight = Math.round(w * (100 - this.cropVal.right) / 100);
      const cTop = Math.round(h * this.cropVal.top / 100);
      const cBottom = Math.round(h * (100 - this.cropVal.bottom) / 100);

      const targetW = Math.max(1, cRight - cLeft);
      const targetH = Math.max(1, cBottom - cTop);

      // Create an offscreen canvas to render final baked pixels
      const bakeCanvas = document.createElement('canvas');
      bakeCanvas.width = targetW;
      bakeCanvas.height = targetH;
      const bctx = bakeCanvas.getContext('2d');
      if (!bctx) return;

      const finishBake = () => {
        const bakedImg = new Image();
        bakedImg.onload = () => {
          // Keep old metrics and references updated
          this.selectedRef.img = bakedImg;
          this.selectedRef.gpuDirty = true;
          if (this.selectedRef.element) {
            this.selectedRef.element.src = bakedImg.src;
            this.selectedRef.element.style.left = `-${bakedImg.width/2}px`;
            this.selectedRef.element.style.top = `-${bakedImg.height/2}px`;
          }

          // Note: shift center of ref layer coordinate so it keeps aligned perfectly with background drawings!
          // Since we cropped starting at cLeft & cTop, let's adjust world point (selectedRef.x, selectedRef.y)
          // We must apply rotation & scaling to this offset to shift the pivot correctly.
          const dxPixels = (cLeft + targetW/2) - w/2;
          const dyPixels = (cTop + targetH/2) - h/2;

          const rad = this.selectedRef.rotation;
          const sc = this.selectedRef.scale;
          
          // Convert pixel offset to scaled rotated offsets
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const worldDx = (dxPixels * cos - dyPixels * sin) * sc;
          const worldDy = (dxPixels * sin + dyPixels * cos) * sc;

          this.selectedRef.x += worldDx;
          this.selectedRef.y += worldDy;

          this.engine.refsDirty = true;
          this.engine.refresh();
          if (this.onUpdate) this.onUpdate();
          this.closeEditor();
        };
        bakedImg.src = bakeCanvas.toDataURL();
      };

      // Extract color corrected sub region
      const tempImgData = bctx.createImageData(targetW, targetH);
      const dest = tempImgData.data;
      const src = this.origImgData.data;

      let destIdx = 0;
      for (let y = cTop; y < cBottom; y++) {
        for (let x = cLeft; x < cRight; x++) {
          const srcIdx = (y * w + x) * 4;
          const r = finalLUT_R[src[srcIdx]];
          const g = finalLUT_G[src[srcIdx + 1]];
          const b = finalLUT_B[src[srcIdx + 2]];
          
          if (this.colorBWMode) {
            const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            dest[destIdx]     = lum;
            dest[destIdx + 1] = lum;
            dest[destIdx + 2] = lum;
          } else {
            dest[destIdx]     = r;
            dest[destIdx + 1] = g;
            dest[destIdx + 2] = b;
          }
          dest[destIdx + 3] = src[srcIdx + 3];
          destIdx += 4;
        }
      }
      bctx.putImageData(tempImgData, 0, 0);
      finishBake();
    }
    else if (this.activeTab === 'knife') {
      if (this.knifePoints.length < 2) {
        alert('Please place a cutting line / lasso points path first.');
        return;
      }

      // Bake the full color values to a temp Canvas first so we retain colors in the splits!
      const coloredCanvas = document.createElement('canvas');
      coloredCanvas.width = w;
      coloredCanvas.height = h;
      const cctx = coloredCanvas.getContext('2d');
      if (!cctx) return;
      const colorImgData = cctx.createImageData(w, h);
      const src = this.origImgData.data;
      const dest = colorImgData.data;
      for (let i = 0; i < src.length; i += 4) {
        const r = finalLUT_R[src[i]];
        const g = finalLUT_G[src[i + 1]];
        const b = finalLUT_B[src[i + 2]];
        if (this.colorBWMode) {
          const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          dest[i]     = lum;
          dest[i + 1] = lum;
          dest[i + 2] = lum;
        } else {
          dest[i]     = r;
          dest[i + 1] = g;
          dest[i + 2] = b;
        }
        dest[i + 3] = src[i + 3];
      }
      cctx.putImageData(colorImgData, 0, 0);

      // We slice into TWO separate reference images: 
      // 1. INSIDE path cutout 
      // 2. OUTSIDE path cutout
      const canvasIn = document.createElement('canvas');
      canvasIn.width = w;
      canvasIn.height = h;
      const ctxIn = canvasIn.getContext('2d');

      const canvasOut = document.createElement('canvas');
      canvasOut.width = w;
      canvasOut.height = h;
      const ctxOut = canvasOut.getContext('2d');

      if (!ctxIn || !ctxOut) return;

      // Draw inside cutout
      ctxIn.save();
      ctxIn.beginPath();
      
      if (this.knifeMode === 'slice') {
        // For slice straight line, we can build a polygon covering the inside half of the line
        // A straight line splits the canvas; we'll connect it around the canvas borders to close a polygon
        const p1 = this.knifePoints[0];
        const p2 = this.knifePoints[1];
        ctxIn.moveTo(p1.x, p1.y);
        ctxIn.lineTo(p2.x, p2.y);
        // Connect through corners to fill one side
        ctxIn.lineTo(w, h);
        ctxIn.lineTo(0, h);
        ctxIn.closePath();
      } else {
        // Multi point polygon lasso
        ctxIn.moveTo(this.knifePoints[0].x, this.knifePoints[0].y);
        for (let i = 1; i < this.knifePoints.length; i++) {
          ctxIn.lineTo(this.knifePoints[i].x, this.knifePoints[i].y);
        }
        ctxIn.closePath();
      }
      ctxIn.clip();
      ctxIn.drawImage(coloredCanvas, 0, 0);
      ctxIn.restore();

      // Draw outside cutout (everything EXCEPT inside)
      ctxOut.drawImage(coloredCanvas, 0, 0);
      ctxOut.save();
      ctxOut.globalCompositeOperation = 'destination-out';
      ctxOut.beginPath();
      if (this.knifeMode === 'slice') {
        const p1 = this.knifePoints[0];
        const p2 = this.knifePoints[1];
        ctxOut.moveTo(p1.x, p1.y);
        ctxOut.lineTo(p2.x, p2.y);
        ctxOut.lineTo(w, h);
        ctxOut.lineTo(0, h);
        ctxOut.closePath();
      } else {
        ctxOut.moveTo(this.knifePoints[0].x, this.knifePoints[0].y);
        for (let i = 1; i < this.knifePoints.length; i++) {
          ctxOut.lineTo(this.knifePoints[i].x, this.knifePoints[i].y);
        }
        ctxOut.closePath();
      }
      ctxOut.fillStyle = 'black';
      ctxOut.fill();
      ctxOut.restore();

      // Crop each canvas to its non-transparent bounds
      const croppedIn = this.cropCanvasToContent(canvasIn);
      const croppedOut = this.cropCanvasToContent(canvasOut);

      // Local helper to calculate new world position after cropping
      const getNewCenter = (croppedInfo) => {
        const left = croppedInfo.offsetX;
        const top = croppedInfo.offsetY;
        const cW = croppedInfo.canvas.width;
        const cH = croppedInfo.canvas.height;
        
        // Local shifts relative to original image center
        const shiftX = (left + cW / 2) - w / 2;
        const shiftY = (top + cH / 2) - h / 2;
        
        // Map to world coordinates based on scale, rotation and mirroring
        const r = this.selectedRef.rotation || 0;
        const s = this.selectedRef.scale || 1.0;
        const mirX = this.selectedRef.mirrorX || false;
        const mirY = this.selectedRef.mirrorY || false;
        
        const localShiftX = shiftX * (mirX ? -1 : 1);
        const localShiftY = shiftY * (mirY ? -1 : 1);
        
        const worldShiftX = (localShiftX * Math.cos(r) - localShiftY * Math.sin(r)) * s;
        const worldShiftY = (localShiftX * Math.sin(r) + localShiftY * Math.cos(r)) * s;
        
        return {
          x: this.selectedRef.x + worldShiftX,
          y: this.selectedRef.y + worldShiftY
        };
      };

      const posA = getNewCenter(croppedIn);
      const posB = getNewCenter(croppedOut);

      // Create new reference images in the engine
      let loadedCount = 0;
      const onSplitImgLoaded = () => {
        loadedCount++;
        if (loadedCount === 2) {
          // Remove the original master reference image (do NOT push history again asynchronously here!)
          this.engine.removeReferenceImage(this.engine.selectedRefIndex, false);
          this.engine.refsDirty = true;
          this.engine.refresh();
          if (this.onUpdate) this.onUpdate();
          this.closeEditor();
        }
      };

      const imgIn = new Image();
      imgIn.onload = () => {
        const refA = this.engine.addReferenceImage(imgIn, `${this.selectedRef.name} (Cut A)`, posA.x, posA.y, {
          rotation: this.selectedRef.rotation,
          scale: this.selectedRef.scale,
          opacity: this.selectedRef.opacity,
          mirrorX: this.selectedRef.mirrorX,
          mirrorY: this.selectedRef.mirrorY
        }, false, false); // autoSelect = false, pushHistory = false
        onSplitImgLoaded();
      };
      imgIn.src = croppedIn.canvas.toDataURL();

      const imgOut = new Image();
      imgOut.onload = () => {
        const refB = this.engine.addReferenceImage(imgOut, `${this.selectedRef.name} (Cut B)`, posB.x, posB.y, {
          rotation: this.selectedRef.rotation,
          scale: this.selectedRef.scale,
          opacity: this.selectedRef.opacity,
          mirrorX: this.selectedRef.mirrorX,
          mirrorY: this.selectedRef.mirrorY
        }, false, false); // autoSelect = false, pushHistory = false
        onSplitImgLoaded();
      };
      imgOut.src = croppedOut.canvas.toDataURL();
    }
  }

  cropCanvasToContent(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return { canvas, offsetX: 0, offsetY: 0 };
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let hasPixels = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const alpha = data[idx + 3];
        if (alpha > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          hasPixels = true;
        }
      }
    }

    if (!hasPixels) {
      return { canvas, offsetX: 0, offsetY: 0 };
    }

    const cropW = (maxX - minX) + 1;
    const cropH = (maxY - minY) + 1;

    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = cropW;
    croppedCanvas.height = cropH;
    const croppedCtx = croppedCanvas.getContext('2d');
    if (croppedCtx) {
      croppedCtx.putImageData(ctx.getImageData(minX, minY, cropW, cropH), 0, 0);
    }

    return {
      canvas: croppedCanvas,
      offsetX: minX,
      offsetY: minY
    };
  }
}
