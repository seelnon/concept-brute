import { Engine } from './engine.js';
import { SketchStorage } from './storage.js';
import { TOOLS, LAYERS_COUNT, SECTOR_SIZE } from './constants.js';
import { PaletteManager } from './paletteManager.js';
import { TipManager } from './tipManager.js';
import { ImgHandler } from './imgHandler.js';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, isCanvasEmpty } from './colorUtils.js';
import { setupUI } from './uiManager.js';
import { 
  initProjectSystem, 
  renderProjectList, 
  switchProject, 
  deleteProject, 
  loadProject, 
  saveProject, 
  generateThumbnail, 
  updateStorageStat, 
  performExport 
} from './projectManager.js';
import { setupIgnoreSystem } from './ignore.js';
import { TimelapseRecorder } from './recording.js';
import { initFluidPaint, activateFluidPaint, deactivateFluidPaint } from './tools/fluidPaint.js';
import { initAirPaint, activateAirPaint, deactivateAirPaint } from './tools/airPaint.js';
import { wasmCore } from './wasm/wasmBridge.js';

class App {
  constructor() {
    this.engine = new Engine(document.getElementById('canvas-container'));
    this.engine.app = this;
    setupIgnoreSystem(this.engine);
    this.engine.onColorPicked = (color) => {
        this.setColor(color);
        this._updateHSVFromHex(color);
    };
    this.engine.onStatus = (text) => this._status(text);
    this.engine.onDrawEnd = () => {
        if (this.autosaveEnabled) this._triggerAutoSave();
    };
    this.engine.onReferenceImagesChange = () => {
        this._updateRefImageList();
        if (this.autosaveEnabled) this._triggerAutoSave();
    };
    this.engine.onRefSelectionChanged = (index) => {
        this._updateRefImageList();
    };
    this.engine.onPaletteExtracted = (colors) => {
        // Pick 2 bright, 2 mid, 2 dark from the 12 extracted values
        // Extraction is sorted by lum: [0..3] Light, [4..7] Mid, [8..11] Dark
        const indices = [0, 1, 5, 6, 10, 11];
        indices.forEach((extractedIdx, paletteIdx) => {
            if (colors[extractedIdx]) {
                this.palette.setBaseColor(paletteIdx, colors[extractedIdx]);
            }
        });
        this._renderPalette();
        if (colors.length > 0) {
            this.setColor(colors[0]);
            this._updateHSVFromHex(colors[0]);
        }
        this._status('PALETTE UPDATED (6 SELECTED)');
        this._updateRefImageList();
        localStorage.setItem('canvas_palette', JSON.stringify(this.palette.baseColors));
    };
    this.storage = new SketchStorage();
    this.engine.storage = this.storage;
    this.palette = new PaletteManager();
    this.imgHandler = new ImgHandler(this.engine, () => {
        this._updateRefImageList();
        this._triggerAutoSave();
    });

    this.activeTool = TOOLS.BRUSH;
    this.lastBrush = TOOLS.BRUSH; // Track for smart switching back to painting
    this.prevTool = TOOLS.BRUSH; 
    this.lastPaintLayer = 2; // Track last paint layer for easy toggling
    
    // Per-brush settings
    this.brushSettings = {};
    Object.values(TOOLS).forEach(tool => {
        this.brushSettings[tool] = {
            size: 40,
            opacity: 1.0,
            flow: 1.0,
            speedSize: 15,
            speedOpacity: 10,
            speedValue: -20,
            speedHue: -50,
            speedMax: 5.0,
            paintHeight: 0,
            oiliness: 0.5,
            airbrush: 0.0,
            smudgeFlowBoost: 10.0,
            smudgePickup: 2.0,
            brushSharpen: 0.0,
            wireDensity: 30,
            wireRange: 4.0,
            wireMinDist: 0.5,
            airTurb: 0,
            airScale: 50,
            airDensity: 1,
            airDrift: 14,
            airFalloff: 0,
            airDryFriction: 0,
            tip: null,
            spacing: 0.05,
            pressureEnabled: true,
            pressureInfluence: 1.0,
            jitterSize: 0,
            jitterAngle: 0,
            jitterPos: 0,
            jitterHue: 0
        };
    });
    // Set some defaults
    this.brushSettings[TOOLS.ERASER].opacity = 1.0;
    this.brushSettings[TOOLS.SMUDGE].opacity = 0.5;
    this.brushSettings[TOOLS.SMUDGE].flow = 0.5;
    this.brushSettings[TOOLS.WIREFRAME].size = 20;
    this.brushSettings[TOOLS.LIQUIFY].size = 85;
    this.brushSettings[TOOLS.LIQUIFY].flow = 0.40; // 40% strength is a great sweet spot!
    this.brushSettings[TOOLS.LIQUIFY].falloff = 0.50; // default 50% falloff
    this.brushSettings[TOOLS.LIQUIFY].liquifyQuality = 2; // default 2 (RESOLVE)
    
    // Fluid default settings
    this.brushSettings[TOOLS.FLUID].size = 50;
    this.brushSettings[TOOLS.FLUID].flow = 0.70;
    this.brushSettings[TOOLS.FLUID].fluidity = 80;
    this.brushSettings[TOOLS.FLUID].bristles = 50;

    // Air default settings
    this.brushSettings[TOOLS.AIR].size = 60;
    this.brushSettings[TOOLS.AIR].opacity = 0.40;
    this.brushSettings[TOOLS.AIR].flow = 0.50;

    this.tipManager = new TipManager(document.getElementById('panel-brush-tips'), (tip, height, oiliness, airbrush) => {
        const tool = this.activeTool;
        if (!tool) return;
        
        let bankIdx = this.tipManager ? this.tipManager.activeBankIndex : 0;
        let genIdx = this.tipManager ? this.tipManager.activeGeneratedIndex : -1;
        if (bankIdx < 0 && genIdx < 0) bankIdx = 0;
        const tipId = bankIdx >= 0 ? `main-${bankIdx}` : `gen-${genIdx}`;

        const currentSettings = this.brushSettings[tool];
        if (currentSettings) {
            currentSettings.activeBankIndex = bankIdx;
            currentSettings.activeGeneratedIndex = genIdx;
            
            if (tool === TOOLS.BRUSH || tool === TOOLS.ERASER || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.FLUID) {
                this.engine.brush.tip = tip;
            }
            
            const tipSettings = this.getCurrentTipSettings();
            if (tipSettings) {
                tipSettings.tip = tip;
                
                // Set sizes & opacity & flow
                this.engine.brush.size = tipSettings.size;
                this.engine.brush.opacity = tipSettings.opacity;
                this.engine.brush.flow = tipSettings.flow;
                this.engine.brush.falloff = tipSettings.falloff ?? 0.50;
                this.engine.brush.liquifyQuality = tipSettings.liquifyQuality ?? 2;
                
                // Sensitivity
                this.engine.brush.speedSize = tipSettings.speedSize;
                this.engine.brush.speedOpacity = tipSettings.speedOpacity;
                this.engine.brush.speedValue = tipSettings.speedValue;
                this.engine.brush.speedHue = tipSettings.speedHue;
                this.engine.brush.speedMax = tipSettings.speedMax ?? 5.0;
                
                // Impasto
                this.engine.brush.paintHeight = (tool === TOOLS.ERASER || tool === TOOLS.SMUDGE) ? 0 : (tipSettings.paintHeight || 0);
                this.engine.brush.oiliness = (tool === TOOLS.ERASER || tool === TOOLS.SMUDGE) ? 0 : (tipSettings.oiliness ?? 0.5);
                this.engine.brush.airbrush = (tool === TOOLS.ERASER || tool === TOOLS.SMUDGE) ? 0 : (tipSettings.airbrush || 0);
                
                // Spacing, Pressure, Jitter
                this.engine.brush.spacing = tipSettings.spacing ?? 0.05;
                this.engine.brush.pressureEnabled = tipSettings.pressureEnabled ?? true;
                this.engine.brush.pressureOpacityInfluence = tipSettings.pressureOpacityInfluence ?? 1.0;
                this.engine.brush.pressureSizeInfluence = tipSettings.pressureSizeInfluence ?? 1.0;
                this.engine.brush.jitterSize = (tipSettings.jitterSize ?? 0) / 100;
                this.engine.brush.jitterAngle = ((tipSettings.jitterAngle ?? 0) * Math.PI) / 180;
                this.engine.brush.jitterPos = (tipSettings.jitterPos ?? 0) / 100;
                this.engine.brush.jitterHue = (tipSettings.jitterHue ?? 0) / 100;
                
                // Smudge
                this.engine.brush.smudgeFlowBoost = tipSettings.smudgeFlowBoost ?? 10.0;
                this.engine.brush.smudgePickup = tipSettings.smudgePickup ?? 2.0;
                
                // Sharpen
                this.engine.brush.brushSharpen = tipSettings.brushSharpen ?? 0.0;
                
                // Wireframe
                this.engine.brush.wireDensity = tipSettings.wireDensity ?? 30;
                this.engine.brush.wireRange = tipSettings.wireRange ?? 4.0;
                this.engine.brush.wireMinDist = tipSettings.wireMinDist ?? 0.5;
            }
        }

        this._updateBrushSettingsUI(tool);
        this._saveBrushSettings();
    }, this.storage);

    this.hsv = { h: 0, s: 70, v: 70 };
    
    this.autosaveDelay = 4000;
    this.autosaveEnabled = true;
    
    this.projects = [];
    this.currentProjectId = 'default';
    this._switchProjectGeneration = 0;
    this._isSwitchingProject = false;
    this._queuedSwitchId = null;
    this._isSavingProject = false;
    this._activeSavePromise = null;

    this.windowPositions = {};

    this.init();
    this._initToggles();
    this._initCategories();

    this.recorder = new TimelapseRecorder(this);
    this.recorder.initEventListeners();

    // Global UI focus prevention
    document.addEventListener('pointerup', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
            // Delay slightly to allow the click/action to complete if needed
            setTimeout(() => {
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
            }, 50);
        }
    }, true);
  }

  _initCategories() {
    document.querySelectorAll('.settings-category').forEach(cat => {
        const header = cat.querySelector('.category-header');
        header.onclick = () => {
            cat.classList.toggle('category-collapsed');
            localStorage.setItem(`cat_collapsed_${cat.id}`, cat.classList.contains('category-collapsed'));
        };

        // Restore state
        const isCollapsed = localStorage.getItem(`cat_collapsed_${cat.id}`) === 'true';
        if (isCollapsed) cat.classList.add('category-collapsed');
    });
  }

  _initToggles() {
    const toggles = [
        { btn: 'toggle-tools', target: 'tool-group', key: 'toggle_tools' },
        { btn: 'toggle-sliders', target: 'slider-group', key: 'toggle_sliders' },
        { btn: 'toggle-sensitivity', target: 'sensitivity-group', key: 'toggle_sensitivity' }
    ];

    toggles.forEach(t => {
        const btn = document.getElementById(t.btn);
        const target = document.getElementById(t.target);
        if (btn && target) {
            // Load state
            const saved = localStorage.getItem(t.key);
            // Default to open (not collapsed) for sensitivity, others follow their HTML classes
            if (saved === 'collapsed') {
                target.classList.add('group-collapsed');
            } else if (saved === 'open') {
                target.classList.remove('group-collapsed');
            } else if (t.key === 'toggle_sensitivity') {
                // Default if no saved state
                target.classList.remove('group-collapsed');
            }

            // Sync visual
            btn.style.opacity = target.classList.contains('group-collapsed') ? '0.3' : '1';

            btn.onclick = () => {
                target.classList.toggle('group-collapsed');
                const isCollapsed = target.classList.contains('group-collapsed');
                btn.style.opacity = isCollapsed ? '0.3' : '1';
                localStorage.setItem(t.key, isCollapsed ? 'collapsed' : 'open');
            };
        }
    });
  }

  async initProjectSystem() {
    await initProjectSystem(this);
  }

  async _renderProjectList() {
    await renderProjectList(this);
  }

  async switchProject(id) {
    await switchProject(this, id);
  }

  async deleteProject(id) {
    await deleteProject(this, id);
  }

  async init() {
    console.log('[PERF] --- INITIALIZING APP START ---');
    const t0 = performance.now();
    
    // 1. PANELS & UI FIRST (Immediate render & interactive frames)
    const tUiStart = performance.now();
    this._status('INITIALIZING UI...');
    this._setupUI();
    this._setupHotkeys();
    console.log(`[PERF] _setupUI() & _setupHotkeys() took ${(performance.now() - tUiStart).toFixed(2)}ms`);

    const tWindowPositionsStart = performance.now();
    await this._loadWindowPositions();
    this._restoreWindowPositions();
    console.log(`[PERF] _loadWindowPositions() & _restoreWindowPositions() took ${(performance.now() - tWindowPositionsStart).toFixed(2)}ms`);

    // Force layout paint so the windows/palette render to the screen immediately for the user
    await new Promise(resolve => setTimeout(resolve, 10));

    // 2. STORAGE & PROJECTS SECONDO (Lightweight database handshake)
    const tStorageStart = performance.now();
    try {
        await this.storage.init();
        console.log(`[PERF] storage.init() took ${(performance.now() - tStorageStart).toFixed(2)}ms`);
        const tProjectSystemStart = performance.now();
        await this.initProjectSystem();
        console.log(`[PERF] initProjectSystem() took ${(performance.now() - tProjectSystemStart).toFixed(2)}ms`);
    } catch (e) {
        console.error("Storage init failed", e);
        this._status('STORAGE ERROR');
    }

    const tTipManagerStart = performance.now();
    await this.tipManager.ready;
    console.log(`[PERF] tipManager.ready took ${(performance.now() - tTipManagerStart).toFixed(2)}ms`);

    // 3. LOAD NON-CANVAS SETTINGS (Fast settings properties restoration)
    const tProjectSettingsStart = performance.now();
    await this.loadProjectSettings();
    console.log(`[PERF] loadProjectSettings() took ${(performance.now() - tProjectSettingsStart).toFixed(2)}ms`);

    // Brief yield for snappy feedback
    await new Promise(resolve => setTimeout(resolve, 10));

    // 4. HEAVY ASSETS LAST (Image references and large canvas chunk matrices)
    const tHeavyAssetsStart = performance.now();
    await this.load();
    console.log(`[PERF] load() (Heavy Assets) took ${(performance.now() - tHeavyAssetsStart).toFixed(2)}ms`);
    
    // Final viewport and layer sync
    const tRefreshStart = performance.now();
    this.engine.refresh();
    console.log(`[PERF] engine.refresh() took ${(performance.now() - tRefreshStart).toFixed(2)}ms`);

    // Query and restore the saved recording state for the active project
    if (this.recorder && typeof this.recorder.onProjectSwitched === "function") {
        try {
            await this.recorder.onProjectSwitched();
        } catch(err) {
            console.error("Failed to restore initial recording state:", err);
        }
    }

    this._status('READY');
    console.log(`[PERF] --- TOTAL INITIALIZATION TIME: ${(performance.now() - t0).toFixed(2)}ms ---`);

    // Event hooks
    this.engine.onDrawStart = () => this._clearSaveTimer();
    this.engine.onDrawMove = null;
    this.engine.onDrawEnd = () => this._triggerAutoSave();
    this.engine.onZoomChange = () => this._updateZoomUI();
    this.engine.onExportSelectionDone = (rect) => this._showExportModal(rect);
    this.engine.onTipCaptured = (canvas) => {
        this.tipManager.setTipFromCanvas(canvas);
        this.isCapturingTip = false;
        document.getElementById('btn-tip-capture').classList.remove('active-btn');
        this._status('TIP CAPTURED');
    };

    this.tipManager.onCaptureRequest = () => {
        this.isCapturingTip = !this.isCapturingTip;
        this.engine.isCapturingTip = this.isCapturingTip;
        document.getElementById('btn-tip-capture').classList.toggle('active-btn', this.isCapturingTip);
        document.getElementById('capture-reticle').style.display = this.isCapturingTip ? 'block' : 'none';
        if (this.isCapturingTip) {
            this._status('CLICK ON CANVAS TO CAPTURE AREA');
        } else {
            this._status('CAPTURE CANCELLED');
        }
    };
  }

  _clearSaveTimer() {
    if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
    }
  }

  _triggerAutoSave() {
    this._clearSaveTimer();
    if (this.autosaveEnabled) {
        this.saveTimeout = setTimeout(() => {
            const isBusy = this.isCapturingTip || 
                           (this.engine && (this.engine.isDrawing || this.engine.isPanning || this.engine.isPanningMode));
            if (isBusy) {
                // Postpone save action again because the user is currently busy painting/liquifying/editing
                this._triggerAutoSave();
            } else {
                this.save();
            }
        }, this.autosaveDelay);
    }
  }

  _setupUI() {
    setupUI(this);
    initFluidPaint(this);
    initAirPaint(this);
  }

  _makeDraggable(el, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onpointerdown = dragPointerDown;

    const self = this;

    function dragPointerDown(e) {
      // Don't drag if we're interacting with a control inside the handle (if any)
      if (e.target.closest('input, button, select')) return;

      e.preventDefault();
      e.stopPropagation();
      
      if (el.id === 'modal-ref-editor' || el.id === 'modal-new-project' || el.id === 'modal-export') {
        const rect = el.getBoundingClientRect();
        el.style.transform = 'none';
        el.style.left = rect.left + 'px';
        el.style.top = rect.top + 'px';
      }

      
      
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      handle.setPointerCapture(e.pointerId);
      handle.onpointermove = elementDrag;
      handle.onpointerup = closeDragElement;
      handle.onpointercancel = closeDragElement;
    }

    function elementDrag(e) {
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      el.style.top = (el.offsetTop - pos2) + "px";
      el.style.left = (el.offsetLeft - pos1) + "px";
      el.style.right = 'auto'; 
      el.style.bottom = 'auto'; 
    }

    function closeDragElement(e) {
      handle.releasePointerCapture(e.pointerId);
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
      
      if (el.id !== 'modal-ref-editor' && el.id !== 'modal-new-project' && el.id !== 'modal-export') {
        self.windowPositions[el.id] = {
            top: el.offsetTop,
            left: el.offsetLeft
        };
        self._saveWindowPositions();
      }
    }
  }

  async loadProjectSettings(targetProjectId = null) {
    const pid = targetProjectId || this.currentProjectId;
    let settings = {};
    try {
        const keys = [
            'autosaveDelaySlider',
            'autosaveEnabled',
            'palette',
            'canvasBg',
            'gridColor',
            'gridPattern',
            'gridSize',
            'gridThickness',
            'gridIntensity',
            'showGrid',
            'brushSettings',
            'brushSpacing',
            'lastColor'
        ];
        
        settings = await this.storage.loadSettingsBatch(keys, pid);

        // Load autosave settings
        const savedAutosaveSlider = settings['autosaveDelaySlider'];
        const savedAutosaveEnabled = settings['autosaveEnabled'];
        if (savedAutosaveSlider !== null) {
            const sliderEl = document.getElementById('settings-autosave');
            if (sliderEl) sliderEl.value = savedAutosaveSlider;
            const seconds = Math.round(4 * Math.pow(300 / 4, savedAutosaveSlider / 100));
            this.autosaveDelay = seconds * 1000;
            const valEl = document.getElementById('autosave-val');
            if (valEl) valEl.innerText = `${seconds}s`;
        }
        if (savedAutosaveEnabled !== null) {
            this.autosaveEnabled = savedAutosaveEnabled;
            const enableEl = document.getElementById('settings-autosave-enable');
            if (enableEl) enableEl.checked = savedAutosaveEnabled;
        }

        const savedPalette = settings['palette'];
        if (savedPalette) this.palette.baseColors = savedPalette;

        // Reset default background/grid settings so they don't leak from previous project if not present
        this.engine.canvasBg = '#ffffff';
        this.engine.gridColor = '#cccccc';
        this.engine.gridPattern = 'dots';
        this.engine.gridSize = 64;
        this.engine.gridThickness = 2;
        this.engine.gridIntensity = 0.5;
        this.engine.showGrid = true;

        const project = this.projects ? this.projects.find(p => p.id === pid) : null;
        const projSet = (project && project.settings) ? project.settings : {};

        const canvasBg = projSet.canvasBg !== undefined ? projSet.canvasBg : settings['canvasBg'];
        if (canvasBg) {
            this.engine.canvasBg = canvasBg;
            const bgEl = document.getElementById('settings-bg-color');
            if (bgEl) bgEl.value = canvasBg;
        } else {
            const bgEl = document.getElementById('settings-bg-color');
            if (bgEl) bgEl.value = '#ffffff';
        }

        const gridColor = projSet.gridColor !== undefined ? projSet.gridColor : settings['gridColor'];
        if (gridColor) {
            this.engine.gridColor = gridColor;
            const gcEl = document.getElementById('settings-grid-color');
            if (gcEl) gcEl.value = gridColor;
        } else {
            const gcEl = document.getElementById('settings-grid-color');
            if (gcEl) gcEl.value = '#cccccc';
        }

        const gridPattern = projSet.gridPattern !== undefined ? projSet.gridPattern : settings['gridPattern'];
        if (gridPattern) {
            this.engine.gridPattern = gridPattern;
            const gpEl = document.getElementById('settings-grid-pattern');
            if (gpEl) gpEl.value = gridPattern;
        } else {
            const gpEl = document.getElementById('settings-grid-pattern');
            if (gpEl) gpEl.value = 'dots';
        }

        const gridSize = projSet.gridSize !== undefined ? projSet.gridSize : settings['gridSize'];
        if (gridSize) {
            this.engine.gridSize = parseInt(gridSize);
            const gsEl = document.getElementById('settings-grid-size');
            if (gsEl) gsEl.value = gridSize;
            const gsvEl = document.getElementById('grid-size-val');
            if (gsvEl) gsvEl.innerText = `${gridSize}px`;
        } else {
            const gsEl = document.getElementById('settings-grid-size');
            if (gsEl) gsEl.value = '64';
            const gsvEl = document.getElementById('grid-size-val');
            if (gsvEl) gsvEl.innerText = '64px';
        }

        const gridThickness = projSet.gridThickness !== undefined ? projSet.gridThickness : settings['gridThickness'];
        if (gridThickness) {
            this.engine.gridThickness = parseFloat(gridThickness);
            const gtEl = document.getElementById('settings-grid-thickness');
            if (gtEl) gtEl.value = gridThickness;
            const gtvEl = document.getElementById('grid-thickness-val');
            if (gtvEl) gtvEl.innerText = `${gridThickness}px`;
        } else {
            this.engine.gridThickness = 2;
            const gtEl = document.getElementById('settings-grid-thickness');
            if (gtEl) gtEl.value = '2';
            const gtvEl = document.getElementById('grid-thickness-val');
            if (gtvEl) gtvEl.innerText = '2px';
        }

        const gridIntensity = projSet.gridIntensity !== undefined ? projSet.gridIntensity : settings['gridIntensity'];
        if (gridIntensity) {
            this.engine.gridIntensity = parseInt(gridIntensity) / 100;
            const giEl = document.getElementById('settings-grid-intensity');
            if (giEl) giEl.value = gridIntensity;
            const givEl = document.getElementById('grid-intensity-val');
            if (givEl) givEl.innerText = `${gridIntensity}%`;
        } else {
            const giEl = document.getElementById('settings-grid-intensity');
            if (giEl) giEl.value = '50';
            const givEl = document.getElementById('grid-intensity-val');
            if (givEl) givEl.innerText = '50%';
        }

        const showGrid = projSet.showGrid !== undefined ? projSet.showGrid : settings['showGrid'];
        if (showGrid !== undefined) {
            this.engine.showGrid = showGrid;
            const sgEl = document.getElementById('settings-grid-show');
            if (sgEl) sgEl.checked = showGrid;
        } else {
            const sgEl = document.getElementById('settings-grid-show');
            if (sgEl) sgEl.checked = true;
        }
        
        // Refresh grid textures & application styles based on settings loaded
        this.engine.setupBoard();
        this.engine.refreshGrid();

        // BRUSH SETTINGS
        let savedBrushes = null;
        try {
            const raw = localStorage.getItem('brushSettings');
            if (raw) savedBrushes = JSON.parse(raw);
        } catch(e) {}
        if (!savedBrushes) savedBrushes = settings['brushSettings'];
        if (savedBrushes) {
            Object.keys(savedBrushes).forEach(tool => {
                if (this.brushSettings[tool]) {
                    const migrated = { ...savedBrushes[tool] };
                    // Auto-migrate old sensitivity ranges (-20 to 20) to new percentage scale (-100 to 100)
                    if (migrated.speedSize !== undefined && migrated.speedSize !== 0 && Math.abs(migrated.speedSize) <= 12) {
                        migrated.speedSize = Math.round(migrated.speedSize * 5);
                    }
                    if (migrated.speedOpacity !== undefined && migrated.speedOpacity !== 0 && Math.abs(migrated.speedOpacity) <= 12) {
                        migrated.speedOpacity = Math.round(migrated.speedOpacity * 5);
                    }
                    if (migrated.speedValue !== undefined && migrated.speedValue !== 0 && Math.abs(migrated.speedValue) <= 12) {
                        migrated.speedValue = Math.round(migrated.speedValue * 5);
                    }
                    if (migrated.speedHue !== undefined && migrated.speedHue !== 0 && Math.abs(migrated.speedHue) <= 12) {
                        migrated.speedHue = Math.round(migrated.speedHue * 5);
                    }
                    this.brushSettings[tool] = { ...this.brushSettings[tool], ...migrated };
                }
            });
        }

        const spacing = settings['brushSpacing'];
        if (spacing) {
            this.engine.brush.spacing = parseFloat(spacing);
            const spEl = document.getElementById('settings-brush-spacing');
            if (spEl) spEl.value = spacing;
        } else {
            const spEl = document.getElementById('settings-brush-spacing');
            if (spEl) spEl.value = '0.05';
        }

    } catch (e) {
        console.warn("Settings load failed", e);
    }

    // 4. RENDER UI STATE
    this._renderPalette();
    this._initColorSelector();
    
    // Retrieve last color value from batch settings
    const lastColor = (settings && settings['lastColor']) || this.palette.baseColors[0];
    this.setColor(lastColor);
    this._updateHSVFromHex(lastColor);
    
    // 5. APPLY BRUSH (Sync UI sliders)
    this.setTool(this.activeTool, true);
  }

  _saveWindowPositions() {
      localStorage.setItem('window_positions', JSON.stringify(this.windowPositions));
  }

  async _loadWindowPositions() {
      try {
          const raw = localStorage.getItem('window_positions');
          if (raw) this.windowPositions = JSON.parse(raw);
      } catch (e) {}
  }

  _restoreWindowPositions() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      Object.keys(this.windowPositions).forEach(id => {
          if (id === 'modal-ref-editor' || id === 'modal-new-project' || id === 'modal-export') return;
          const el = document.getElementById(id);
          if (!el) return;

          let { top, left } = this.windowPositions[id];
          
          // Force layout if not visible to get dimensions, or fallback to defaults
          const w = el.offsetWidth || (id === 'panel-brush-tips' ? 180 : 200);
          const h = el.offsetHeight || 200;

          // Strictly clamp within viewport
          if (left + w > vw) left = vw - w;
          if (left < 0) left = 0;
          if (top + h > vh) top = vh - h;
          if (top < 0) top = 0;

          el.style.top = `${top}px`;
          el.style.left = `${left}px`;
          el.style.right = 'auto';
          el.style.bottom = 'auto';
      });
  }

  _updateZoomUI() {
      document.getElementById('zoom-val').innerText = `${Math.round(this.engine.zoom * 100)}%`;
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      const refEditor = document.getElementById('modal-ref-editor');
      if (refEditor && !refEditor.classList.contains('hidden')) {
        const key = e.key.toLowerCase();
        if (key === 'z' && e.ctrlKey) {
          e.preventDefault();
          const btnKnifeUndo = document.getElementById('btn-knife-undo');
          if (btnKnifeUndo) btnKnifeUndo.click();
        } else if (key === 'escape') {
          e.preventDefault();
          const btnCancel = document.getElementById('btn-ref-editor-cancel');
          if (btnCancel) btnCancel.click();
        }
        return; // Block other hotkeys
      }
      
      if (
          document.activeElement && 
          (document.activeElement.tagName === 'INPUT' || 
           document.activeElement.tagName === 'TEXTAREA' || 
           document.activeElement.tagName === 'SELECT' || 
           document.activeElement.isContentEditable)
      ) {
          if (document.activeElement.closest('.hidden') || document.activeElement.offsetParent === null) {
              document.activeElement.blur();
              window.focus();
          } else {
              return;
          }
      }

      if (document.activeElement && (document.activeElement.tagName === 'BUTTON' || document.activeElement.closest('.brutal-btn, .mini-btn, .tool-btn'))) {
          document.activeElement.blur();
      }
      if (e.repeat && ['z', 'y'].includes(e.key.toLowerCase())) return;
      
      const key = e.key.toLowerCase();
      switch (key) {
        case '1': this.setTool(TOOLS.BRUSH); break;
        case '2': this.setTool(TOOLS.WIREFRAME); break;
        case '3': this.setTool(TOOLS.LASSO); break;
        case '4': this.setTool(TOOLS.SMUDGE); break;
        case '5': this.setTool(TOOLS.ERASER); break;
        case '6':
        case 'g':
          this.setTool(TOOLS.LIQUIFY);
          break;
        case 'f':
          this.setTool(TOOLS.FLUID);
          break;
        case '8':
        case 'a':
          this.setTool(TOOLS.AIR);
          break;
        case '7':
          this.setTool(TOOLS.LASSO);
          if (this.engine.floatingSelection) {
              this.engine.transformMode = 'deform';
              this.engine._updateSelectionPreview();
              this._status('PUPPET DEFORM ACTIVE');
          } else if (this.engine.activeSelectionPath) {
              this.engine.startTransform();
              this.engine.transformMode = 'deform';
              this.engine._updateSelectionPreview();
              this._status('PUPPET DEFORM ACTIVE');
          } else {
              this._status('LASSO AN AREA FIRST THEN DEFORM');
          }
          break;
        case 'i':
          if (this.engine.activeLayer === 0) {
              this.setLayer(this.lastPaintLayer || 2);
          } else {
              this.lastPaintLayer = this.engine.activeLayer;
              this.setLayer(0);
          }
          break;
        case 'b': 
          if (this.engine.floatingSelection) {
              this.engine.toggleFloatingSelectionMirrorX();
          } else if (this.activeTool === TOOLS.REF_MOVE && this.engine.selectedRefIndex !== -1) {
              const ref = this.engine.referenceImages[this.engine.selectedRefIndex];
              ref.mirrorX = !ref.mirrorX;
              this.engine.refresh();
              this._triggerAutoSave();
          } else {
              this.engine.toggleMirror(); 
          }
          break;
        case 'd': 
          if (e.ctrlKey) {
            if (this.engine.floatingSelection) {
                this.engine._applySelection();
            } else if (this.engine.activeSelectionPath) {
                const prevPath = this.engine.activeSelectionPath ? [...this.engine.activeSelectionPath] : null;
                this.engine._pushHistory({ type: 'selection', path: prevPath });
                this.engine.clearSelection();
            }
            e.preventDefault();
          } else {
            this._adjOpacity(5); 
          }
          break;
        case 'delete':
        case 'backspace':
          if (this.engine.activeSelectionPath) {
            this.engine.deleteSelection();
            e.preventDefault();
          } else if (this.activeTool === TOOLS.REF_MOVE && this.engine.selectedRefIndex !== -1) {
            this.engine.removeReferenceImage(this.engine.selectedRefIndex);
            this._updateRefImageList();
            e.preventDefault();
          }
          break;
        case 't':
          this.engine.startTransform();
          break;
        case 'l': this.setTool(TOOLS.LASSO); break;
        case 'c':
          if (e.ctrlKey) {
            this.engine.copy();
            e.preventDefault();
          }
          break;
        case 'v':
          if (e.ctrlKey) {
            this.engine.paste();
            e.preventDefault();
          }
          break;
        case 's':
          if (e.ctrlKey) {
            e.preventDefault();
            if (e.shiftKey) {
              // Save into a file (export trigger)
              if (this.engine.isStatic) {
                  this._status('SAVING CODES TO INDEXED-DB...');
                  saveProject(this).then(() => {
                      const rect = {
                          x: -this.engine.staticWidth / 2,
                          y: -this.engine.staticHeight / 2,
                          w: this.engine.staticWidth,
                          h: this.engine.staticHeight
                      };
                      this._showExportModal(rect);
                      this._status('PROJECT SAVED - EXPORT READY');
                  });
              } else {
                  this._startExportMode();
              }
            } else {
              // Force save now to database
              this.save();
            }
          } else {
            this._adjOpacity(-5);
          }
          break;
        case 'x':
          if (e.ctrlKey) {
            this.engine.cut();
            e.preventDefault();
          } else {
            this.setTool(TOOLS.ERASER); 
          }
          break;
        case 'z': 
          if (e.ctrlKey) {
              if (e.shiftKey) this.engine.redo();
              else this.engine.undo();
              e.preventDefault();
          }
          break;
        case 'enter':
          if (this.engine.floatingSelection) {
              this.engine._applySelection();
              e.preventDefault();
          }
          break;
        case 'escape':
          if (this.engine.isExportMode) {
              this._endExportMode();
              this._status('EXPORT CANCELLED');
          }
          if (this.engine.activeSelectionPath || this.engine.floatingSelection) {
              const prevPath = this.engine.activeSelectionPath ? [...this.engine.activeSelectionPath] : null;
              this.engine._pushHistory({ type: 'selection', path: prevPath });
              this.engine.clearSelection();
          }
          this.settingsPanel.classList.add('hidden');
          document.getElementById('modal-new-project').classList.add('hidden');
          document.getElementById('modal-export').classList.add('hidden');
          this.isCapturingTip = false;
          this.engine.isCapturingTip = false;
          document.getElementById('capture-reticle').style.display = 'none';
          break;
        case 'y': if (e.ctrlKey) { this.engine.redo(); e.preventDefault(); } break;
        case 'w': this._adjSize(-8, e.repeat); break; 
        case 'e': this._adjSize(8, e.repeat); break;  
        case '[': this._adjSize(-5, e.repeat); break;
        case ']': this._adjSize(5, e.repeat); break;
      }
    });
  }

  _adjSize(delta, skipSave = false) {
    if (!this.activeTool) return;
    const el = document.getElementById('brush-size');
    const valEl = document.getElementById('size-val');
    
    const settings = this.brushSettings[this.activeTool];
    const tipSettings = this.getCurrentTipSettings() || settings;
    const currentSize = tipSettings.size;
    
    // Low amount precision bias (shortcut keys)
    let effectiveDelta = delta;
    if (currentSize < 20) {
        effectiveDelta = Math.sign(delta) * Math.max(1, Math.floor(Math.abs(delta) / 4));
    }
    
    const maxSize = (this.activeTool === TOOLS.LIQUIFY) ? 1500 : 500;
    const newSize = Math.max(1, Math.min(maxSize, currentSize + effectiveDelta));
    
    this.updateActiveSetting('size', newSize);
    
    if (el) el.value = this._mapSizeToSlider(newSize);
    if (valEl) valEl.innerText = newSize;

    const touchSizeInput = document.getElementById('touch-brush-size');
    if (touchSizeInput) touchSizeInput.value = this._mapSizeToSlider(newSize);
    const touchSizeRangeVal = document.getElementById('touch-size-val');
    if (touchSizeRangeVal) touchSizeRangeVal.innerText = newSize;
    
    if (this.engine) {
        this.engine._updateBrushCursor();
    }
  }

  _adjOpacity(delta) {
    if (!this.activeTool) return;
    const el = document.getElementById('brush-opacity');
    const valEl = document.getElementById('opacity-val');
    
    const settings = this.brushSettings[this.activeTool];
    const tipSettings = this.getCurrentTipSettings() || settings;
    const pVal = Math.round(tipSettings.opacity * 100);
    
    // Low amount precision bias: if current value < 20, reduce delta effect
    let effectiveDelta = delta;
    if (pVal < 20) {
        effectiveDelta = Math.sign(delta) * Math.max(1, Math.floor(Math.abs(delta) / 4));
    }
    
    const newVal = Math.max(0, Math.min(100, pVal + effectiveDelta));
    if (el) el.value = newVal;
    
    this.updateActiveSetting('opacity', newVal / 100);
    
    if (valEl) valEl.innerText = `${newVal}%`;
  }

  _handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const ref = this.engine.addReferenceImage(img, file.name);
        this._updateRefImageList();
        this._status('IMAGE IMPORTED');
        this.setLayer(0);
        this._triggerAutoSave();
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // Clear value
  }

  _updateRefImageList() {
      const list = document.getElementById('image-list');
      if (!list) return;
      list.innerHTML = '';
      
      if (this.engine.referenceImages.length === 0) {
          list.innerHTML = '<div class="empty-state">Empty</div>';
          return;
      }

      this.engine.referenceImages.forEach((ref, index) => {
          const item = document.createElement('div');
          item.className = 'image-item';
          if (index === this.engine.selectedRefIndex) item.classList.add('active-ref');

          item.onclick = (e) => {
              this.engine.selectedRefIndex = index;
              this.setLayer(0);
              this.engine.refresh();
              this._updateRefImageList();
          };

          // Drag and drop mechanics for item reordering
          item.draggable = true;
          item.dataset.index = index;

          item.addEventListener('dragstart', (e) => {
              e.dataTransfer.setData('text/plain', index);
              item.classList.add('dragging');
              e.dataTransfer.effectAllowed = 'move';
          });

          item.addEventListener('dragend', () => {
              item.classList.remove('dragging');
              list.querySelectorAll('.image-item').forEach(el => {
                  el.classList.remove('drag-over');
              });
          });

          item.addEventListener('dragover', (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              item.classList.add('drag-over');
          });

          item.addEventListener('dragleave', () => {
              item.classList.remove('drag-over');
          });

          item.addEventListener('drop', (e) => {
              e.preventDefault();
              item.classList.remove('drag-over');
              const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
              if (isNaN(draggedIndex) || draggedIndex === index) return;

              // Record State / Undo History entry
              this.engine._pushHistory({
                  type: 'reference_change',
                  referenceImagesState: this.engine.captureReferenceImagesState()
              });
              this.engine._clearStack(this.engine.redoStack);

              // Reorder array list
              const draggedItem = this.engine.referenceImages[draggedIndex];
              const selectedRef = this.engine.referenceImages[this.engine.selectedRefIndex];

              this.engine.referenceImages.splice(draggedIndex, 1);
              this.engine.referenceImages.splice(index, 0, draggedItem);

              // Restore selection target
              if (selectedRef) {
                  this.engine.selectedRefIndex = this.engine.referenceImages.indexOf(selectedRef);
              } else {
                  this.engine.selectedRefIndex = -1;
              }

              this.engine.refsDirty = true;
              this.engine.refresh();
              this._updateRefImageList();
              this._triggerAutoSave();
          });

          if (ref.extractedPalette) {
              const palPreview = document.createElement('div');
              palPreview.className = 'ref-mini-palette';
              palPreview.style.marginRight = '6px';
              palPreview.style.flex = '1';
              
              ref.extractedPalette.forEach(c => {
                  const s = document.createElement('div');
                  s.style.backgroundColor = c;
                  s.title = `Use color ${c}`;
                  s.onclick = (e) => {
                      e.stopPropagation();
                      this.setColor(c);
                      this._updateHSVFromHex(c);
                      this._status(`COLOR SET: ${c}`);
                  };
                  palPreview.appendChild(s);
              });
              item.appendChild(palPreview);
          } else {
              const nameSpan = document.createElement('span');
              nameSpan.className = 'truncate';
              nameSpan.innerText = ref.name;
              item.appendChild(nameSpan);
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'btn-del-img';
          delBtn.innerText = 'X';
          delBtn.title = 'Remove Reference';
          delBtn.onclick = (e) => {
              e.stopPropagation();
              this.engine.removeReferenceImage(index);
              this._updateRefImageList();
              this._triggerAutoSave();
          };
          item.appendChild(delBtn);

          list.appendChild(item);
      });
  }

  _renderPalette() {
    const paletteEl = document.getElementById('palette');
    const frag = document.createDocumentFragment();
    const rows = this.palette.generate();

    rows.forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'palette-row';
        
        row.forEach(item => {
            const swatch = document.createElement('div');
            swatch.className = `swatch ${item.type}`;
            if (item.active) swatch.classList.add('active-swatch');
            swatch.style.backgroundColor = item.color;
            if (item.span) swatch.style.flex = item.span;
            
            swatch.onclick = (e) => {
                e.stopPropagation();
                if (item.type === 'main') {
                    this.palette.activeIndex = item.index;
                    // Only update the actual influence colors if we picked from the main row
                    this._updateHSVFromHex(item.color);
                    this._applyHSV(); // This syncs and regenerates palette
                } else {
                    // Just set the color for the brush, don't update row 1 or regenerate
                    this.setColor(item.color);
                }
            };
            
            swatch.title = item.color;
            rowEl.appendChild(swatch);
        });
        
        frag.appendChild(rowEl);
    });
    
    paletteEl.innerHTML = '';
    paletteEl.appendChild(frag);
  }

  _initColorSelector() {
    const svPicker = document.getElementById('sv-picker');
    const svCursor = svPicker.querySelector('.sv-cursor');
    const hueSlider = document.getElementById('hue-slider');

    const updateFromSV = (e) => {
        const rect = svPicker.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;
        x = Math.max(0, Math.min(rect.width, x));
        y = Math.max(0, Math.min(rect.height, y));
        
        this.hsv.s = (x / rect.width) * 100;
        this.hsv.v = 100 - (y / rect.height) * 100;
        
        this._applyHSV();
    };

    svPicker.onpointerdown = (e) => {
        svPicker.setPointerCapture(e.pointerId);
        updateFromSV(e);
        
        const onPointerMove = (pe) => updateFromSV(pe);
        const onPointerUp = (pe) => {
            svPicker.releasePointerCapture(pe.pointerId);
            svPicker.removeEventListener('pointermove', onPointerMove);
            svPicker.removeEventListener('pointerup', onPointerUp);
            svPicker.removeEventListener('pointercancel', onPointerUp);
        };
        
        svPicker.addEventListener('pointermove', onPointerMove);
        svPicker.addEventListener('pointerup', onPointerUp);
        svPicker.addEventListener('pointercancel', onPointerUp);
    };

    hueSlider.oninput = (e) => {
        this.hsv.h = parseFloat(e.target.value);
        this._applyHSV();
    };
  }

  _applyHSV() {
    const rgb = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    
    // Update active base color
    this.palette.setBaseColor(this.palette.activeIndex, hex);
    this.setColor(hex);
    this._renderPalette();
    this._updateColorUI();
    this.storage.saveSetting('palette', this.palette.baseColors);
  }

  _updateHSVFromHex(hex) {
    const rgb = hexToRgb(hex);
    this.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    this._updateColorUI();
  }

  _updateColorUI() {
    const svPicker = document.getElementById('sv-picker');
    const svCursor = svPicker.querySelector('.sv-cursor');
    const hueSlider = document.getElementById('hue-slider');

    // Update SV background to reflect hue
    const pureRgb = hsvToRgb(this.hsv.h, 100, 100);
    const pureHex = rgbToHex(pureRgb.r, pureRgb.g, pureRgb.b);
    svPicker.style.backgroundColor = pureHex;

    // Position cursor
    svCursor.style.left = `${this.hsv.s}%`;
    svCursor.style.top = `${100 - this.hsv.v}%`;

    // Update hue slider
    hueSlider.value = this.hsv.h;
  }

  _updateBrushSettingsUI(tool) {
    if (!tool) return;
    const settings = this.brushSettings[tool];
    const tipSettings = this.getCurrentTipSettings() || settings;
    if (this.activeTool === tool) {
        // Toggle visibility of specific properties based on tool
        const heightCtrl = document.getElementById('height-control');
        const oilCtrl = document.getElementById('oiliness-control');
        const airCtrl = document.getElementById('airbrush-control');
        const advBtn = document.getElementById('btn-advanced-brush');

        if (heightCtrl) heightCtrl.style.display = (tool === TOOLS.BRUSH) ? 'block' : 'none';
        if (oilCtrl) oilCtrl.style.display = (tool === TOOLS.BRUSH) ? 'block' : 'none';
        if (airCtrl) airCtrl.style.display = (tool === TOOLS.BRUSH) ? 'block' : 'none';

        const opacCtrl = document.getElementById('control-opacity');
        const flowLbl = document.getElementById('lbl-flow');
        if (opacCtrl) opacCtrl.style.display = (tool === TOOLS.LIQUIFY) ? 'none' : 'block';
        if (flowLbl) flowLbl.innerText = (tool === TOOLS.LIQUIFY) ? 'STRENGTH' : 'FLOW';
        
        const falloffCtrl = document.getElementById('control-falloff');
        if (falloffCtrl) {
            falloffCtrl.style.display = (tool === TOOLS.LIQUIFY) ? 'block' : 'none';
        }
        
        const qCtrl = document.getElementById('control-liquify-quality');
        if (qCtrl) {
            qCtrl.style.display = (tool === TOOLS.LIQUIFY) ? 'block' : 'none';
        }

        const fluidityCtrl = document.getElementById('control-fluidity');
        const bristlesCtrl = document.getElementById('control-bristles');
        if (fluidityCtrl) {
            fluidityCtrl.style.display = (tool === TOOLS.FLUID) ? 'block' : 'none';
        }
        if (bristlesCtrl) {
            bristlesCtrl.style.display = (tool === TOOLS.FLUID) ? 'block' : 'none';
        }
        
        // Advanced settings button visibility
        if (advBtn) {
            const hasAdv = (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER);
            advBtn.style.display = hasAdv ? 'block' : 'none';
        }
        const advTitle = document.querySelector('#panel-advanced-brush .panel-title');
        if (advTitle) {
            advTitle.innerText = (tool === TOOLS.ERASER) ? 'ADVANCED ERASER' : 'ADVANCED BRUSH';
        }

        // Update UI Sliders
        document.getElementById('brush-size').value = this._mapSizeToSlider(tipSettings.size);
        document.getElementById('size-val').innerText = tipSettings.size;

        const touchSizeInput = document.getElementById('touch-brush-size');
        if (touchSizeInput) touchSizeInput.value = this._mapSizeToSlider(tipSettings.size);
        const touchSizeRangeVal = document.getElementById('touch-size-val');
        if (touchSizeRangeVal) touchSizeRangeVal.innerText = tipSettings.size;
        
        const opacEl = document.getElementById('brush-opacity');
        if (opacEl) {
            opacEl.value = tipSettings.opacity * 100;
            document.getElementById('opacity-val').innerText = `${Math.round(tipSettings.opacity * 100)}%`;
        }

        const flowEl = document.getElementById('brush-flow');
        if (flowEl) {
            flowEl.value = tipSettings.flow * 100;
            document.getElementById('flow-val').innerText = `${Math.round(tipSettings.flow * 100)}%`;
        }

        const falloffEl = document.getElementById('brush-falloff');
        if (falloffEl) {
            const fValue = (tipSettings.falloff !== undefined) ? tipSettings.falloff : 0.50;
            falloffEl.value = fValue * 100;
            const fValDisplay = document.getElementById('falloff-val');
            if (fValDisplay) fValDisplay.innerText = `${Math.round(fValue * 100)}%`;
        }

        const qualityEl = document.getElementById('brush-liquify-quality');
        if (qualityEl) {
            const qValue = tipSettings.liquifyQuality ?? 2;
            qualityEl.value = qValue;
            const qValDisplay = document.getElementById('liquify-quality-val');
            if (qValDisplay) {
                const labels = { 1: 'FAST', 2: 'RESOLVE', 3: 'ULTRA' };
                qValDisplay.innerText = labels[qValue] || 'RESOLVE';
            }
        }

        const heightEl = document.getElementById('brush-height');
        if (heightEl) {
            heightEl.value = (tipSettings.paintHeight || 0) * 100;
            const hVal = document.getElementById('height-val');
            if (hVal) hVal.innerText = `${Math.round((tipSettings.paintHeight || 0) * 100)}%`;
        }

        const oilEl = document.getElementById('brush-oiliness');
        if (oilEl) {
            oilEl.value = (tipSettings.oiliness ?? 0.5) * 100;
            const oVal = document.getElementById('oiliness-val');
            if (oVal) oVal.innerText = `${Math.round((tipSettings.oiliness ?? 0.5) * 100)}%`;
        }

        const airEl = document.getElementById('brush-airbrush');
        if (airEl) {
            airEl.value = (tipSettings.airbrush || 0) * 100;
            const aVal = document.getElementById('airbrush-val');
            if (aVal) aVal.innerText = `${Math.round((tipSettings.airbrush || 0) * 100)}%`;
        }

        // Update Sensitivity UI
        const sSize = document.getElementById('speed-size');
        if (sSize) {
            sSize.value = tipSettings.speedSize;
            const val = document.getElementById('s-size-val');
            if (val) val.innerText = Math.round(tipSettings.speedSize);
        }
        const sOpac = document.getElementById('speed-opacity');
        if (sOpac) {
            sOpac.value = tipSettings.speedOpacity;
            const val = document.getElementById('s-opac-val');
            if (val) val.innerText = Math.round(tipSettings.speedOpacity);
        }
        const sVal = document.getElementById('speed-value');
        if (sVal) {
            sVal.value = tipSettings.speedValue;
            const val = document.getElementById('s-val-val');
            if (val) val.innerText = Math.round(tipSettings.speedValue);
        }
        const sHue = document.getElementById('speed-hue');
        if (sHue) {
            sHue.value = tipSettings.speedHue;
            const val = document.getElementById('s-hue-val');
            if (val) val.innerText = Math.round(tipSettings.speedHue);
        }

        // Update Advanced Sliders
        const getVal = (key, defaultVal) => {
            return tipSettings[key] !== undefined ? tipSettings[key] : defaultVal;
        };

        const smudgeBoost = document.getElementById('adv-smudge-flow-boost');
        if (smudgeBoost) {
            const bVal = getVal('smudgeFlowBoost', 10.0);
            smudgeBoost.value = bVal;
            const valEl = document.getElementById('adv-smudge-flow-boost-val');
            if (valEl) valEl.innerText = bVal.toFixed(1);
        }
        
        const smudgePickup = document.getElementById('adv-smudge-pickup');
        if (smudgePickup) {
            const pVal = getVal('smudgePickup', 2.0);
            smudgePickup.value = pVal;
            const valEl = document.getElementById('adv-smudge-pickup-val');
            if (valEl) valEl.innerText = pVal.toFixed(1);
        }
        
        const sharpen = document.getElementById('adv-brush-sharpen');
        if (sharpen) {
            const sVal = getVal('brushSharpen', 0.0);
            sharpen.value = sVal;
            const valEl = document.getElementById('adv-brush-sharpen-val');
            if (valEl) valEl.innerText = sVal.toFixed(2);
        }
        
        const wireDensity = document.getElementById('adv-wire-density');
        if (wireDensity) {
            const dVal = getVal('wireDensity', 30);
            wireDensity.value = dVal;
            const valEl = document.getElementById('adv-wire-density-val');
            if (valEl) valEl.innerText = dVal;
        }
        
        const wireRange = document.getElementById('adv-wire-range');
        if (wireRange) {
            const rVal = getVal('wireRange', 4.0);
            wireRange.value = rVal;
            const valEl = document.getElementById('adv-wire-range-val');
            if (valEl) valEl.innerText = rVal.toFixed(1);
        }
        
        const wireMinDist = document.getElementById('adv-wire-min-dist');
        if (wireMinDist) {
            const mVal = getVal('wireMinDist', 0.5);
            wireMinDist.value = mVal;
            const valEl = document.getElementById('adv-wire-min-dist-val');
            if (valEl) valEl.innerText = mVal.toFixed(1);
        }

        const airTurb = document.getElementById('adv-air-turb');
        if (airTurb) {
            const val = getVal('airTurb', 0);
            airTurb.value = val;
            const valEl = document.getElementById('adv-air-turb-val');
            if (valEl) valEl.innerText = `${val}%`;
        }
        
        const airScale = document.getElementById('adv-air-scale');
        if (airScale) {
            const val = getVal('airScale', 50);
            airScale.value = val;
            const valEl = document.getElementById('adv-air-scale-val');
            if (valEl) valEl.innerText = `${val}px`;
        }
        
        const airDensity = document.getElementById('adv-air-density');
        if (airDensity) {
            const val = getVal('airDensity', 1);
            airDensity.value = val;
            const valEl = document.getElementById('adv-air-density-val');
            if (valEl) valEl.innerText = `${val} streams`;
        }
        
        const airDrift = document.getElementById('adv-air-drift');
        if (airDrift) {
            const val = getVal('airDrift', 14);
            airDrift.value = val;
            const valEl = document.getElementById('adv-air-drift-val');
            if (valEl) valEl.innerText = `${val}%`;
        }

        const airFalloff = document.getElementById('adv-air-falloff');
        if (airFalloff) {
            const val = getVal('airFalloff', 0);
            airFalloff.value = val;
            const valEl = document.getElementById('adv-air-falloff-val');
            if (valEl) valEl.innerText = `${val}%`;
        }

        const airDryFriction = document.getElementById('adv-air-dry-friction');
        if (airDryFriction) {
            const val = getVal('airDryFriction', 0);
            airDryFriction.value = val;
            const valEl = document.getElementById('adv-air-dry-friction-val');
            if (valEl) valEl.innerText = `${val}%`;
        }

        const spacingEl = document.getElementById('settings-brush-spacing');
        if (spacingEl) {
            spacingEl.value = getVal('spacing', 0.05);
        }

        const pressureEnable = document.getElementById('settings-pressure-enable');
        if (pressureEnable) {
            pressureEnable.checked = getVal('pressureEnabled', true);
        }

        const pressureOpacityInf = document.getElementById('settings-pressure-opacity-influence');
        if (pressureOpacityInf) {
            const opVal = getVal('pressureOpacityInfluence', 1.0);
            pressureOpacityInf.value = opVal;
            const valEl = document.getElementById('pressure-opacity-val');
            if (valEl) valEl.innerText = opVal.toFixed(1);
        }

        const pressureSizeInf = document.getElementById('settings-pressure-size-influence');
        if (pressureSizeInf) {
            const szVal = getVal('pressureSizeInfluence', 1.0);
            pressureSizeInf.value = szVal;
            const valEl = document.getElementById('pressure-size-val');
            if (valEl) valEl.innerText = szVal.toFixed(1);
        }

        const advSpeedMax = document.getElementById('adv-speed-max');
        if (advSpeedMax) {
            const sMaxVal = getVal('speedMax', 5.0);
            advSpeedMax.value = sMaxVal;
            const valEl = document.getElementById('adv-speed-max-val');
            if (valEl) valEl.innerText = sMaxVal.toFixed(1);
        }

        // Jitter Sliders
        const jitterSize = document.getElementById('settings-jitter-size');
        if (jitterSize) {
            const jSizeVal = getVal('jitterSize', 0);
            jitterSize.value = this._mapPrecisionToSlider(jSizeVal, 100);
            const valEl = document.getElementById('jitter-size-val');
            if (valEl) valEl.innerText = `${jSizeVal}%`;
        }
        const jitterAngle = document.getElementById('settings-jitter-angle');
        if (jitterAngle) {
            const jAngleVal = getVal('jitterAngle', 0);
            jitterAngle.value = this._mapPrecisionToSlider(jAngleVal, 180);
            const valEl = document.getElementById('jitter-angle-val');
            if (valEl) valEl.innerText = `${jAngleVal}°`;
        }
        const jitterPos = document.getElementById('settings-jitter-pos');
        if (jitterPos) {
            const jPosVal = getVal('jitterPos', 0);
            jitterPos.value = this._mapPrecisionToSlider(jPosVal, 200);
            const valEl = document.getElementById('jitter-pos-val');
            if (valEl) valEl.innerText = `${jPosVal}%`;
        }
        const jitterHue = document.getElementById('settings-jitter-hue');
        if (jitterHue) {
            const jHueVal = getVal('jitterHue', 0);
            jitterHue.value = this._mapPrecisionToSlider(jHueVal, 100);
            const valEl = document.getElementById('jitter-hue-val');
            if (valEl) valEl.innerText = `${jHueVal}%`;
        }

        const catPressure = document.getElementById('cat-pressure');
        const catJitter = document.getElementById('cat-jitter');
        const catSmudge = document.getElementById('cat-smudge');
        const catWireframe = document.getElementById('cat-wireframe');
        const catSpeedTuning = document.getElementById('cat-speed-tuning');
        
        if (catPressure) catPressure.style.display = (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER || tool === TOOLS.AIR) ? 'block' : 'none';
        if (catJitter) catJitter.style.display = (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER || tool === TOOLS.AIR) ? 'block' : 'none';
        if (catSmudge) catSmudge.style.display = (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE) ? 'block' : 'none';
        if (catWireframe) catWireframe.style.display = (tool === TOOLS.WIREFRAME) ? 'block' : 'none';
        if (catSpeedTuning) catSpeedTuning.style.display = (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER || tool === TOOLS.AIR) ? 'block' : 'none';
        
        // Fluidity and Bristles updating
        const fldEl = document.getElementById('slider-fluidity');
        if (fldEl) {
            const fldValue = getVal('fluidity', 80);
            fldEl.value = fldValue;
            const fldValDisplay = document.getElementById('val-fluidity');
            if (fldValDisplay) fldValDisplay.innerText = `${Math.round(fldValue)}%`;
        }

        const brsEl = document.getElementById('slider-bristles');
        if (brsEl) {
            const brsValue = getVal('bristles', 50);
            brsEl.value = brsValue;
            const brsValDisplay = document.getElementById('val-bristles');
            if (brsValDisplay) brsValDisplay.innerText = Math.round(brsValue);
        }
    }
  }

  getCurrentTipSettings() {
    if (!this.activeTool) return null;
    let bankIdx = 0;
    let genIdx = -1;
    if (this.tipManager) {
        bankIdx = this.tipManager.activeBankIndex;
        genIdx = this.tipManager.activeGeneratedIndex;
    }
    if (bankIdx < 0 && genIdx < 0) {
        bankIdx = 0;
    }
    const tipId = bankIdx >= 0 ? `main-${bankIdx}` : `gen-${genIdx}`;
    
    const settings = this.brushSettings[this.activeTool];
    if (!settings) return null;
    
    if (!settings.tips) settings.tips = {};
    if (!settings.tips[tipId]) {
        settings.tips[tipId] = {
            size: settings.size ?? 40,
            opacity: settings.opacity ?? 1.0,
            flow: settings.flow ?? 1.0,
            falloff: settings.falloff ?? 0.50,
            liquifyQuality: settings.liquifyQuality ?? 2,
            speedSize: settings.speedSize ?? 15,
            speedOpacity: settings.speedOpacity ?? 10,
            speedValue: settings.speedValue ?? -20,
            speedHue: settings.speedHue ?? -50,
            speedMax: settings.speedMax ?? 5.0,
            paintHeight: settings.paintHeight ?? 0,
            oiliness: settings.oiliness ?? 0.5,
            airbrush: settings.airbrush ?? 0.0,
            smudgeFlowBoost: settings.smudgeFlowBoost ?? 10.0,
            smudgePickup: settings.smudgePickup ?? 2.0,
            brushSharpen: settings.brushSharpen ?? 0.0,
            wireDensity: settings.wireDensity ?? 30,
            wireRange: settings.wireRange ?? 4.0,
            wireMinDist: settings.wireMinDist ?? 0.5,
            spacing: settings.spacing ?? 0.05,
            pressureEnabled: settings.pressureEnabled ?? true,
            pressureOpacityInfluence: settings.pressureOpacityInfluence ?? 1.0,
            pressureSizeInfluence: settings.pressureSizeInfluence ?? 1.0,
            jitterSize: settings.jitterSize ?? 0,
            jitterAngle: settings.jitterAngle ?? 0,
            jitterPos: settings.jitterPos ?? 0,
            jitterHue: settings.jitterHue ?? 0,
            airTurb: settings.airTurb ?? 0,
            airScale: settings.airScale ?? 50,
            airDensity: settings.airDensity ?? 1,
            airDrift: settings.airDrift ?? 14,
            airFalloff: settings.airFalloff ?? 0,
            airDryFriction: settings.airDryFriction ?? 0
        };
    }
    return settings.tips[tipId];
  }

  updateActiveSetting(key, val, mappedVal = null) {
    if (!this.activeTool) return;
    
    this.brushSettings[this.activeTool][key] = val;
    
    const tipSettings = this.getCurrentTipSettings();
    if (tipSettings) {
        tipSettings[key] = val;
    }
    
    if (this.tipManager) {
        if (key === 'paintHeight' || key === 'oiliness' || key === 'airbrush') {
            this.tipManager.updateActiveTipSettings(
                key === 'paintHeight' ? val : undefined,
                key === 'oiliness' ? val : undefined,
                key === 'airbrush' ? val : undefined
            );
        } else {
            this.tipManager.updateActiveTipAdvancedSettings(key, val);
        }
    }
    
    const engineVal = (mappedVal !== null) ? mappedVal : val;
    this.engine.brush[key] = engineVal;
    
    this._saveBrushSettings();
  }

  setTool(tool, force = false) {
    if (this.activeTool === tool && !force) return;
    this.prevTool = this.activeTool;
    this.activeTool = tool;
    
    // Deselect reference image when switching to anything that isn't generic move
    if (tool !== TOOLS.REF_MOVE) {
        this.engine.selectedRefIndex = -1;
        this.engine.refresh();
    }

    if (tool === TOOLS.REF_MOVE) {
        if (this.engine.activeLayer !== 0) this.setLayer(0);
    }

    const sensitivityGroup = document.querySelector('.sensitivity-group');
    if (sensitivityGroup) {
        if (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.ERASER || tool === TOOLS.WIREFRAME) {
            sensitivityGroup.classList.remove('hidden');
        } else {
            sensitivityGroup.classList.add('hidden');
        }
    }
    
    if (!tool) {
        // Deselecting all tools
        document.querySelectorAll('.tool-group .tool-btn').forEach(btn => {
            btn.classList.remove('active-tool');
        });
        return;
    }

    if (tool === TOOLS.BRUSH || tool === TOOLS.WIREFRAME) {
        this.lastBrush = tool;
    }
    
    // Apply per-brush settings
    const settings = this.brushSettings[tool];
    this.engine.brush.type = tool;

    // Instant tool pre-warming (zero-lag initialization)
    if (tool === TOOLS.LIQUIFY) {
        wasmCore.liquifyPrewarm();
    } else if (tool === TOOLS.SMUDGE || tool === TOOLS.FLUID) {
        if (!this.engine.segmentCanvas) {
            this.engine.segmentCanvas = document.createElement('canvas');
            this.engine.segmentCtx = this.engine.segmentCanvas.getContext('2d', { willReadFrequently: true });
        }
    }

    // Restore this tool's specific active tip in the panel
    if (this.tipManager && (tool === TOOLS.BRUSH || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER || tool === TOOLS.SMUDGE || tool === TOOLS.FLUID)) {
        this.tipManager.activeBankIndex = settings.activeBankIndex !== undefined ? settings.activeBankIndex : 0;
        this.tipManager.activeGeneratedIndex = settings.activeGeneratedIndex !== undefined ? settings.activeGeneratedIndex : -1;
        this.tipManager._renderPalette();
        this.tipManager.refreshTip();
    } else {
        this.engine.brush.size = settings.size;
        this.engine.brush.opacity = settings.opacity;
        this.engine.brush.flow = settings.flow;
        this.engine.brush.falloff = settings.falloff ?? 0.50;
        this.engine.brush.liquifyQuality = settings.liquifyQuality ?? 2;
        this._updateBrushSettingsUI(tool);
    }
    
    // Update UI Buttons
    document.querySelectorAll('.tool-group .tool-btn').forEach(btn => {
      btn.classList.remove('active-tool');
    });

    let activeBtnId = `btn-${tool === TOOLS.AIR ? 'air' : tool}`;
    const btn = document.getElementById(activeBtnId);
    if (btn) {
      btn.classList.add('active-tool');
    }

    // Update Touch Eyedropper highlight
    const touchPickerBtn = document.getElementById('btn-touch-picker');
    if (touchPickerBtn) {
        if (tool === TOOLS.PICKER) {
            touchPickerBtn.classList.add('active-tool');
        } else {
            touchPickerBtn.classList.remove('active-tool');
        }
    }

    if (this.prevTool === TOOLS.FLUID) {
        deactivateFluidPaint(this);
    }
    if (tool === TOOLS.FLUID) {
        activateFluidPaint(this);
    }
    if (this.prevTool === TOOLS.AIR) {
        deactivateAirPaint(this);
    }
    if (tool === TOOLS.AIR) {
        activateAirPaint(this);
    }

    if (tool) this._status(tool);
  }

  setColor(color) {
    this.engine.brush.color = color;
    const preview = document.getElementById('current-color-preview');
    if (preview) preview.style.backgroundColor = color;
    
    if (this.storage) this.storage.saveSetting('lastColor', color);

    // Sync picker if it differs significantly or always sync?
    // Always sync to ensure the selector matches current color
    const rgb = hexToRgb(color);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    this.hsv = hsv;
    this._updateColorUI();

    // Smart Switch check: if color picked while using non-painting tools, switch to last brush
    if (this.activeTool === TOOLS.ERASER || this.activeTool === TOOLS.LASSO || this.activeTool === TOOLS.SMUDGE || this.activeTool === TOOLS.PICKER) {
        this.setTool(this.lastBrush || TOOLS.BRUSH);
    }
  }

  setLayer(index) {
    const prevLayer = this.engine.activeLayer;
    this.engine.activeLayer = index;

    // Deselect reference when switching to paint layer
    if (index !== 0) {
        this.engine.selectedRefIndex = -1;
        this.engine.refresh();
        this._updateRefImageList();
        this.lastPaintLayer = index;
    }

    // Update UI
    for (let i = 0; i < LAYERS_COUNT; i++) {
        const btn = document.getElementById(`layer-btn-${i}`);
        const item = btn?.parentElement;
        if (item) item.classList.remove('active-layer');
    }
    const active = document.getElementById(`layer-btn-${index}`);
    const activeItem = active?.parentElement;
    if (activeItem) activeItem.classList.add('active-layer');

    if (index === 0) {
        if (this.activeTool !== TOOLS.REF_MOVE) this.setTool(TOOLS.REF_MOVE);
        this.imgHandler.activate();
    } else {
        if (this.activeTool === TOOLS.REF_MOVE) {
            this.setTool(this.lastBrush);
        }
        this.imgHandler.deactivate();
    }

    this._status(index === 0 ? 'IMG REF' : `L${index}`);

    const refToolbar = document.getElementById('top-bar-ref');
    const mainToolbar = document.getElementById('top-bar');
    if (index === 0) {
        if (refToolbar) refToolbar.classList.remove('hidden');
        if (mainToolbar) mainToolbar.classList.add('hidden');
    } else {
        if (refToolbar) refToolbar.classList.add('hidden');
        if (mainToolbar) mainToolbar.classList.remove('hidden');
    }
  }

  async load(targetProjectId = null) {
    await loadProject(this, targetProjectId);
  }

  async save(force = false, targetProjectId = null) {
    await saveProject(this, force, targetProjectId);
  }

  _showSaved() {
      const el = document.getElementById('save-status');
      if (!el) return;
      el.classList.remove('hidden');
      if (this.saveStatusTimeout) clearTimeout(this.saveStatusTimeout);
      this.saveStatusTimeout = setTimeout(() => {
          el.classList.add('hidden');
      }, 2000);
  }

  _status(text) {
    const el = document.getElementById('status');
    if (el) el.innerText = text;
  }

  _saveBrushSettings() {
    if (this._saveBrushSettingsTimeout) {
        clearTimeout(this._saveBrushSettingsTimeout);
    }
    this._saveBrushSettingsTimeout = setTimeout(() => {
        const toSave = {};
        Object.keys(this.brushSettings).forEach(tool => {
            const s = this.brushSettings[tool];
            toSave[tool] = { ...s };
            // Canvas elements cannot be cloned in IndexedDB/Storage
            if (toSave[tool].tip instanceof HTMLCanvasElement) {
                toSave[tool].tip = null; 
            }
            if (s.tips) {
                toSave[tool].tips = {};
                Object.keys(s.tips).forEach(tipId => {
                    toSave[tool].tips[tipId] = { ...s.tips[tipId] };
                    if (toSave[tool].tips[tipId].tip instanceof HTMLCanvasElement) {
                        toSave[tool].tips[tipId].tip = null;
                    }
                });
            }
        });
        localStorage.setItem('brushSettings', JSON.stringify(toSave));
        this.storage.saveSetting('brushSettings', toSave);
        this._saveBrushSettingsTimeout = null;
    }, 250);
  }

  async _generateThumbnail() {
    return await generateThumbnail(this);
  }

  async _updateStorageStat() {
    await updateStorageStat(this);
  }

  _showExportModal(rect) {
      if (!rect || rect.w <= 0 || rect.h <= 0) return;
      this.currentExportRect = rect;
      
      const modal = document.getElementById('modal-export');
      
      modal.style.left = '50%';
      modal.style.top = '50%';
      modal.style.transform = 'translate(-50%, -50%)';
      modal.style.right = 'auto';
      modal.style.bottom = 'auto';
      modal.style.display = '';
      
      modal.classList.remove('hidden');
      
      const wInput = document.getElementById('export-width');
      const hInput = document.getElementById('export-height');
      wInput.value = Math.round(rect.w);
      hInput.value = Math.round(rect.h);
      
      this.exportAspectRatio = rect.w / rect.h;
      
      document.getElementById('export-scale').value = 100;
      document.getElementById('export-scale-val').innerText = '100%';
  }

  _updateExportDimensions(ratioOnly = false) {
      if (!this.currentExportRect) return;
      
      const wInput = document.getElementById('export-width');
      const hInput = document.getElementById('export-height');
      const scaleInput = document.getElementById('export-scale');
      const keepRatio = document.getElementById('export-keep-ratio').checked;
      
      if (ratioOnly && keepRatio) {
          // If width changed, update height, and vice versa
          // We need to know which one was modified last. 
          // For simplicity, let's assume width is master if both changed?
          // Actually, let's just use the current active element.
          if (document.activeElement === wInput) {
              hInput.value = Math.round(wInput.value / this.exportAspectRatio);
          } else if (document.activeElement === hInput) {
              wInput.value = Math.round(hInput.value * this.exportAspectRatio);
          }
      } else {
          // Scale changed
          const scale = parseInt(scaleInput.value) / 100;
          wInput.value = Math.round(this.currentExportRect.w * scale);
          hInput.value = Math.round(this.currentExportRect.h * scale);
      }
  }

  async _performExport() {
    await performExport(this);
  }

  _startExportMode() {
      this.engine.isExportMode = true;
      this.engine.container.classList.add('export-mode');
      this.setTool(null);
      this._status('DRAG TO SELECT EXPORT AREA (ESC TO CANCEL)');
  }

  _endExportMode() {
      const modal = document.getElementById('modal-export');
      if (modal) {
          modal.classList.add('hidden');
          modal.style.display = '';
      }
      this.engine.isExportMode = false;
      this.engine.container.classList.remove('export-mode');
      if (this.prevTool) this.setTool(this.prevTool);
      else this.setTool(TOOLS.BRUSH);
  }

  _mapSliderToSize(val) {
    if (this.activeTool === TOOLS.LIQUIFY) {
      if (val <= 100) return 1 + (val / 100) * (15 - 1);
      if (val <= 200) return 15 + ((val - 100) / 100) * (100 - 15);
      if (val <= 300) return 100 + ((val - 200) / 100) * (500 - 100);
      return 500 + ((val - 300) / 100) * (1500 - 500);
    } else {
      if (val <= 100) return 1 + (val / 100) * (10 - 1);
      if (val <= 200) return 10 + ((val - 100) / 100) * (30 - 10);
      if (val <= 300) return 30 + ((val - 200) / 100) * (100 - 30);
      return 100 + ((val - 300) / 100) * (500 - 100);
    }
  }

  _mapSizeToSlider(size) {
    if (this.activeTool === TOOLS.LIQUIFY) {
      if (size <= 15) return ((size - 1) / (15 - 1)) * 100;
      if (size <= 100) return 100 + ((size - 15) / (100 - 15)) * 100;
      if (size <= 500) return 200 + ((size - 100) / (500 - 100)) * 100;
      return 300 + ((size - 500) / (1500 - 500)) * 100;
    } else {
      if (size <= 10) return ((size - 1) / (10 - 1)) * 100;
      if (size <= 30) return 100 + ((size - 10) / (30 - 10)) * 100;
      if (size <= 100) return 200 + ((size - 30) / (100 - 30)) * 100;
      return 300 + ((size - 100) / (500 - 100)) * 100;
    }
  }

  _mapSliderToPrecision(val, rangeMax = 100) {
    const t = val; // Sliders are 0-100
    let res;
    if (t <= 25) {
        res = (t / 25) * 10;
    } else if (t <= 50) {
        res = 10 + ((t - 25) / 25) * 20;
    } else if (t <= 75) {
        res = 30 + ((t - 50) / 25) * 30;
    } else {
        res = 60 + ((t - 75) / 25) * 40;
    }
    return (res / 100) * rangeMax;
  }

  _mapPrecisionToSlider(val, rangeMax = 100) {
    const t = (val / rangeMax) * 100;
    if (t <= 10) {
        return (t / 10) * 25;
    } else if (t <= 30) {
        return 25 + ((t - 10) / 20) * 25;
    } else if (t <= 60) {
        return 50 + ((t - 30) / 30) * 25;
    } else {
        return 75 + ((t - 60) / 40) * 25;
    }
  }
}

new App();