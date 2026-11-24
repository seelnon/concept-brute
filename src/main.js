import { Engine } from './engine.js';
import { SketchStorage } from './storage.js';
import { TOOLS, LAYERS_COUNT, SECTOR_SIZE } from './constants.js';
import { PaletteManager, PaletteStudio } from './paletteManager.js';
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
import { initFluidPaint, activateFluidPaint, deactivateFluidPaint, syncFluidSettingsFromTip, warmFluidSolver } from './tools/fluidPaint.js';
import { initAirPaint, activateAirPaint, deactivateAirPaint, syncAirSettingsFromTip, warmAirSolver } from './tools/airPaint.js';
import { initSumiPaint, activateSumiPaint, deactivateSumiPaint, syncSumiSettingsFromTip, syncSumiTip, warmSumiSolver, updateSumiSubtoolUI } from './tools/sumiPaint.js';
import { ensureSmudgeBuffers, warmSmudgeSolver } from './tools/smudge.js';
import { warmLiquifySolver } from './tools/liquify.js';
import { warmEraserSolver } from './tools/eraser.js';
import { acquireBackupCanvas, releaseBackupCanvas } from './engine/backupPool.js';
import { wasmCore } from './wasm/wasmBridge.js';
import { PerfMonitor } from './perfMonitor.js';
import { runPhantomToolsPrewarm } from './tools/prewarm.js';
import { LayerColorController } from './colorCorrection.js';

class App {
  constructor() {
    this.engine = new Engine(document.getElementById('canvas-container'));
    this.engine.app = this;
    this.perfMonitor = new PerfMonitor(this);
    this.engine.perfMonitor = this.perfMonitor;
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
                this.palette.setBaseColor(paletteIdx, colors[extractedIdx], { skipGroup: true, skipSave: true });
            }
        });
        if (this.palette.config.groupLock) {
            this.palette.captureGroupBaseline();
        }
        this.palette.saveConfig();
        this._renderPalette();
        if (colors.length > 0) {
            this.setColor(colors[0]);
            this._updateHSVFromHex(colors[0]);
        }
        this._status('PALETTE UPDATED (6 SELECTED)');
        this._updateRefImageList();
        this.palette?.saveProjectPalette?.(this.currentProjectId);
        this.paletteStudio?.renderStudioDynamicSections();
    };
    this.currentProjectId = 'default';
    this._domCache = new Map();
    this._dirtyTools = new Set();
    this._perfPrewarmTools = true;
    this.storage = new SketchStorage();
    this.engine.storage = this.storage;
    this.palette = new PaletteManager();
    this.palette.setStorage(this.storage, this.currentProjectId);
    this.engine.physicalColorMix = (this.palette.config.canvasMixMode !== 'digital');
    this.paletteStudio = new PaletteStudio(this);
    this.imgHandler = new ImgHandler(this.engine, () => {
        this._updateRefImageList();
        this._triggerAutoSave();
    });
    this.layerColorController = new LayerColorController(this);

    this.activeTool = TOOLS.BRUSH;
    this.lastBrush = TOOLS.BRUSH; // Track for smart switching back to painting
    this.prevTool = TOOLS.BRUSH; 
    this.lastPaintLayer = 2; // Track last paint layer for easy toggling
    
    // Per-brush settings
    this.brushSettings = this._createDefaultBrushSettings();

    this.tipManager = new TipManager(document.getElementById('panel-brush-tips'), (tip, height, oiliness, airbrush, skipStorage = false) => {
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
            
            if (tool === TOOLS.BRUSH || tool === TOOLS.ERASER || tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.FLUID || tool === TOOLS.AIR || tool === TOOLS.SUMI) {
                if (tip && !tip._tipVersion) tip._tipVersion = 1;
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
                this.engine.brush.speedHeight = tipSettings.speedHeight ?? 0;
                this.engine.brush.speedWater = tipSettings.speedWater ?? (tool === TOOLS.SUMI ? -45 : 0);
                this.engine.brush.speedMax = tipSettings.speedMax ?? 5.0;
                
                // Impasto
                this.engine.brush.paintHeight = (tool === TOOLS.ERASER || tool === TOOLS.SMUDGE) ? 0 : (tipSettings.paintHeight || 0);
                this.engine.brush.oiliness = (tool === TOOLS.ERASER || tool === TOOLS.SMUDGE) ? 0 : (tipSettings.oiliness ?? 0.5);
                this.engine.brush.airbrush = (tool === TOOLS.ERASER) ? 0 : (tipSettings.airbrush || 0);
                
                // Spacing, Pressure, Jitter
                this.engine.brush.spacing = tipSettings.spacing ?? 0.05;
                this.engine.brush.pressureEnabled = tipSettings.pressureEnabled ?? true;
                this.engine.brush.pressureOpacityInfluence = tipSettings.pressureOpacityInfluence ?? ((tool === TOOLS.SMUDGE || tool === TOOLS.WIREFRAME || tool === TOOLS.SUMI) ? 0.0 : 1.0);
                this.engine.brush.pressureSizeInfluence = tipSettings.pressureSizeInfluence ?? 1.0;
                this.engine.brush.jitterSize = (tipSettings.jitterSize ?? 0) / 100;
                this.engine.brush.jitterAngle = ((tipSettings.jitterAngle ?? 0) * Math.PI) / 180;
                this.engine.brush.jitterPos = (tipSettings.jitterPos ?? 0) / 100;
                this.engine.brush.jitterHue = (tipSettings.jitterHue ?? 0) / 100;
                
                // Smudge
                this.engine.brush.smudgeFlowBoost = tipSettings.smudgeFlowBoost ?? 1.0;
                this.engine.brush.smudgePickup = tipSettings.smudgePickup ?? 2.0;
                this.engine.brush.smudgeAlpha = tipSettings.smudgeAlpha ?? true;
                
                // Sharpen
                this.engine.brush.brushSharpen = tipSettings.brushSharpen ?? 0.0;
                
                // Wireframe
                this.engine.brush.wireDensity = tipSettings.wireDensity ?? 30;
                this.engine.brush.wireRange = tipSettings.wireRange ?? 4.0;
                this.engine.brush.wireMinDist = tipSettings.wireMinDist ?? 0.5;

                // Fluid Paint
                if (tool === TOOLS.FLUID) {
                    syncFluidSettingsFromTip(tipSettings);
                }

                // Air Watercolor
                if (tool === TOOLS.AIR) {
                    syncAirSettingsFromTip(tipSettings);
                }

                // Sumi-e Ink & Bristles
                if (tool === TOOLS.SUMI) {
                    syncSumiSettingsFromTip(tipSettings);
                    syncSumiTip(this.engine);
                }
            }
        }

        if (this.engine && !this.engine._isLoadingProject && !this._isSwitchingProject && !this._isPrewarming) {
            if (tool === TOOLS.SMUDGE || tool === TOOLS.FLUID || tool === TOOLS.AIR || tool === TOOLS.SUMI) {
                if (this._tipWarmupTimer) clearTimeout(this._tipWarmupTimer);
                this._tipWarmupTimer = setTimeout(() => {
                    this._tipWarmupTimer = null;
                    if (this.activeTool === tool && this.engine && !this.engine.isDrawing) {
                        try {
                            this._warmToolSolver(tool);
                        } catch (_) {}
                    }
                }, 0);
            }
        }

        if (this.engine) {
            this.engine._updateBrushCursor();
        }
        this._updateBrushSettingsUI(tool);
        if (!skipStorage) {
            this._dirtyTools.add(tool);
            this._saveBrushSettings();
        }
    }, this.storage);

    this._lastCanvasActivityTime = 0;
    this._brushSettingsDirty = false;
    this._saveBrushSettingsIdleId = null;
    this.tipManager.shouldDeferSave = () => this._shouldDeferSettingsSave();

    this.hsv = { h: 0, s: 70, v: 70 };
    
    this.autosaveDelay = 4000;
    this.autosaveEnabled = true;
    
    this.projects = [];
    this._projectSlotStates = new Map();
    this._switchProjectGeneration = 0;
    this._isSwitchingProject = false;
    this._activeSwitchTargetId = null;
    this._slotReadyTimer = null;
    this._projectLoadedCompletely = true;
    this._queuedSwitchId = null;
    this._queuedSwitchOptions = null;
    this._isSavingProject = false;
    this._activeSavePromise = null;
    this._isPrewarming = false;
    this._allToolsPrewarmed = false;

    this.windowPositions = {};

    this._initToggles();
    this._initCategories();
    this.init();

    window.addEventListener('resize', () => {
        if (typeof this.clampPanelsToView === 'function') {
            this.clampPanelsToView();
        }
    });

    this.recorder = new TimelapseRecorder(this);
    this.recorder.initEventListeners();

    // Global UI focus cleanup ONLY after interaction completes (never mid-drag on pointerdown)
    document.addEventListener('pointerup', (e) => {
        const ctrl = (e.target instanceof Element) ? e.target.closest('button, [role="button"], input[type="range"], input[type="checkbox"]') : null;
        if (ctrl) {
            setTimeout(() => {
                if (document.activeElement === ctrl && document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
            }, 0);
        }
    }, true);
  }

  _el(id) {
    if (!id) return null;
    let node = this._domCache?.get(id);
    if (node && node.isConnected) return node;
    node = document.getElementById(id);
    if (node && this._domCache) this._domCache.set(id, node);
    return node;
  }

  _createDefaultBrushSettings() {
    const map = {};
    Object.values(TOOLS).forEach(tool => {
        map[tool] = {
            size: 40,
            opacity: 1.0,
            flow: 1.0,
            speedSize: 15,
            speedOpacity: 10,
            speedValue: -20,
            speedHue: -50,
            speedHeight: 0,
            speedWater: 0,
            speedMax: 5.0,
            paintHeight: 0,
            oiliness: 0.5,
            airbrush: 0.0,
            smudgeFlowBoost: 1.0,
            smudgePickup: 2.0,
            smudgeAlpha: true,
            brushSharpen: 0.0,
            wireDensity: 30,
            wireRange: 4.0,
            wireMinDist: 0.5,
            airWetness: 100,
            airStreamFlow: 100,
            airBloom: 50,
            airEdge: 30,
            airGranulation: 30,
            airTipPour: 100,
            airFollowStroke: false,
            airTipAngle: 0,
            airTipHardness: 55,
            airPressureFlow: 35,
            airUseHeightmap: false,
            airHeightSource: 'surface',
            fluidHeightShield: 65,
            sumiMode: 'draw',
            sumiInk: 78,
            sumiInkAffection: 35,
            sumiWater: 65,
            sumiWaterWash: 75,
            sumiEraserInk: 85,
            sumiEraserWater: 25,
            sumiBleed: 58,
            sumiBristles: 28,
            sumiStiffness: 60,
            sumiSplit: 48,
            sumiSpan: 550,
            sumiGlue: 42,
            sumiWarmth: 12,
            sumiEvaporation: 28,
            sumiCapillarity: 62,
            sumiBackrun: 68,
            sumiTurbulence: 0,
            sumiSootSnag: 55,
            sumiDeplete: true,
            sumiSplitEnabled: true,
            sumiTilt: true,
            sumiAutoReDip: true,
            sumiFollowStroke: false,
            sumiTipAngle: 0,
            sumiPressureFlow: 35,
            sumiPressureGate: 20,
            sumiMaxWater: 100,
            sumiUseHeightmap: false,
            sumiHeightSource: 'surface',
            tip: null,
            spacing: 0.05,
            pressureEnabled: true,
            pressureInfluence: 1.0,
            pressureOpacityInfluence: 1.0,
            pressureSizeInfluence: 1.0,
            jitterSize: 0,
            jitterAngle: 0,
            jitterPos: 0,
            jitterHue: 0,
            _defaultsCalibratedV3: true,
            _defaultsCalibratedV4: true,
            _defaultsCalibratedV5: true
        };
    });
    map[TOOLS.ERASER].opacity = 1.0;
    map[TOOLS.SMUDGE].opacity = 1.0;
    map[TOOLS.SMUDGE].flow = 1.0;
    map[TOOLS.SMUDGE].pressureOpacityInfluence = 0.0;
    map[TOOLS.WIREFRAME].size = 20;
    map[TOOLS.WIREFRAME].pressureOpacityInfluence = 0.0;
    map[TOOLS.LIQUIFY].size = 85;
    map[TOOLS.LIQUIFY].flow = 0.40;
    map[TOOLS.LIQUIFY].falloff = 0.50;
    map[TOOLS.LIQUIFY].liquifyQuality = 2;
    map[TOOLS.LIQUIFY].speedSize = 0;
    map[TOOLS.LIQUIFY].pressureSizeInfluence = 0.0;

    map[TOOLS.FLUID].size = 50;
    map[TOOLS.FLUID].opacity = 1.0;
    map[TOOLS.FLUID].flow = 1.0;
    map[TOOLS.FLUID].fluidity = 80;
    map[TOOLS.FLUID].bristles = 10;
    map[TOOLS.FLUID].fluidFlow = 100;
    map[TOOLS.FLUID].fluidVortex = 8;
    map[TOOLS.FLUID].fluidTurb = 8;
    map[TOOLS.FLUID].fluidRetention = 80;
    map[TOOLS.FLUID].fluidPickup = 80;
    map[TOOLS.FLUID].fluidDepth = 30;
    map[TOOLS.FLUID].fluidHeightShield = 65;
    map[TOOLS.FLUID].fluidGloss = 100;
    map[TOOLS.FLUID].fluidShading = true;
    map[TOOLS.FLUID].fluidFollowStroke = false;
    map[TOOLS.FLUID].fluidTipAngle = 0;
    map[TOOLS.FLUID].fluidBristleContrast = 65;
    map[TOOLS.FLUID].fluidBleed = 50;
    map[TOOLS.FLUID].fluidTipHardness = 50;
    map[TOOLS.FLUID].fluidPressureFlow = 35;

    map[TOOLS.AIR].size = 70;
    map[TOOLS.AIR].opacity = 0.55;
    map[TOOLS.AIR].flow = 0.70;
    map[TOOLS.AIR].speedWater = 0;
    map[TOOLS.AIR].airWetness = 100;
    map[TOOLS.AIR].airStreamFlow = 100;
    map[TOOLS.AIR].airBloom = 50;
    map[TOOLS.AIR].airEdge = 30;
    map[TOOLS.AIR].airGranulation = 30;
    map[TOOLS.AIR].airTipPour = 100;
    map[TOOLS.AIR].airFollowStroke = false;
    map[TOOLS.AIR].airTipAngle = 0;
    map[TOOLS.AIR].airTipHardness = 55;
    map[TOOLS.AIR].airPressureFlow = 35;
    map[TOOLS.AIR].airUseHeightmap = false;
    map[TOOLS.AIR].airHeightSource = 'surface';

    map[TOOLS.SUMI].size = 40;
    map[TOOLS.SUMI].opacity = 1.0;
    map[TOOLS.SUMI].flow = 1.0;
    map[TOOLS.SUMI].pressureOpacityInfluence = 0.0;
    map[TOOLS.SUMI].speedWater = -45;
    map[TOOLS.SUMI].sumiMode = 'draw';
    map[TOOLS.SUMI].sumiInk = 78;
    map[TOOLS.SUMI].sumiInkAffection = 35;
    map[TOOLS.SUMI].sumiWater = 65;
    map[TOOLS.SUMI].sumiWaterWash = 75;
    map[TOOLS.SUMI].sumiEraserInk = 85;
    map[TOOLS.SUMI].sumiEraserWater = 25;
    map[TOOLS.SUMI].sumiBleed = 58;
    map[TOOLS.SUMI].sumiBristles = 28;
    map[TOOLS.SUMI].sumiStiffness = 60;
    map[TOOLS.SUMI].sumiSplit = 48;
    map[TOOLS.SUMI].sumiSpan = 550;
    map[TOOLS.SUMI].sumiGlue = 42;
    map[TOOLS.SUMI].sumiWarmth = 12;
    map[TOOLS.SUMI].sumiEvaporation = 28;
    map[TOOLS.SUMI].sumiCapillarity = 62;
    map[TOOLS.SUMI].sumiBackrun = 68;
    map[TOOLS.SUMI].sumiTurbulence = 0;
    map[TOOLS.SUMI].sumiSootSnag = 55;
    map[TOOLS.SUMI].sumiDeplete = true;
    map[TOOLS.SUMI].sumiSplitEnabled = true;
    map[TOOLS.SUMI].sumiTilt = true;
    map[TOOLS.SUMI].sumiAutoReDip = true;
    map[TOOLS.SUMI].sumiFollowStroke = false;
    map[TOOLS.SUMI].sumiTipAngle = 0;
    map[TOOLS.SUMI].sumiPressureFlow = 35;
    map[TOOLS.SUMI].sumiPressureGate = 20;
    map[TOOLS.SUMI].sumiMaxWater = 100;
    map[TOOLS.SUMI].sumiUseHeightmap = false;
    map[TOOLS.SUMI].sumiHeightSource = 'surface';
    return map;
  }

  _initCategories() {
    this._categoryEls = Array.from(document.querySelectorAll('.settings-category'));
    this._categoryEls.forEach(cat => {
        const header = cat.querySelector('.category-header');
        if (!header) return;
        header.onclick = () => {
            cat.classList.toggle('category-collapsed');
            this.storage?.saveUiState(`cat_collapsed_${cat.id}`, cat.classList.contains('category-collapsed'));
        };
    });
  }

  _initToggles() {
    this._uiToggles = [
        { btn: 'toggle-tools', target: 'tool-group', key: 'toggle_tools' },
        { btn: 'toggle-sliders', target: 'slider-group', key: 'toggle_sliders' },
        { btn: 'toggle-sensitivity', target: 'sensitivity-group', key: 'toggle_sensitivity' }
    ];

    this._uiToggles.forEach(t => {
        const btn = this._el(t.btn);
        const target = this._el(t.target);
        if (btn && target) {
            if (t.key === 'toggle_sensitivity') {
                target.classList.remove('group-collapsed');
            }
            btn.style.opacity = target.classList.contains('group-collapsed') ? '0.3' : '1';
            btn.onclick = () => {
                target.classList.toggle('group-collapsed');
                const isCollapsed = target.classList.contains('group-collapsed');
                btn.style.opacity = isCollapsed ? '0.3' : '1';
                this.storage?.saveUiState(t.key, isCollapsed ? 'collapsed' : 'open');
            };
        }
    });
  }

  async _restoreUiTogglesAndCategories() {
    const keys = [];
    if (this._categoryEls) {
      for (let i = 0; i < this._categoryEls.length; i++) {
        keys.push(`cat_collapsed_${this._categoryEls[i].id}`);
      }
    }
    if (this._uiToggles) {
      for (let i = 0; i < this._uiToggles.length; i++) {
        keys.push(this._uiToggles[i].key);
      }
    }
    if (keys.length === 0) return;

    const batch = await this.storage.loadUiStateBatch(keys);
    if (this._categoryEls) {
      for (let i = 0; i < this._categoryEls.length; i++) {
        const cat = this._categoryEls[i];
        const k = `cat_collapsed_${cat.id}`;
        let val = batch[k];
        if (val === null || val === undefined) {
          try {
            const legacy = localStorage.getItem(k);
            if (legacy !== null) {
              val = (legacy === 'true');
              this.storage.saveUiState(k, val).catch(() => {});
              localStorage.removeItem(k);
            }
          } catch (_) {}
        }
        if (val === true || val === 'true') {
          cat.classList.add('category-collapsed');
        }
      }
    }
    if (this._uiToggles) {
      for (let i = 0; i < this._uiToggles.length; i++) {
        const t = this._uiToggles[i];
        const btn = this._el(t.btn);
        const target = this._el(t.target);
        if (!btn || !target) continue;
        let saved = batch[t.key];
        if (saved === null || saved === undefined) {
          try {
            const legacy = localStorage.getItem(t.key);
            if (legacy !== null) {
              saved = legacy;
              this.storage.saveUiState(t.key, saved).catch(() => {});
              localStorage.removeItem(t.key);
            }
          } catch (_) {}
        }
        if (saved === 'collapsed') {
          target.classList.add('group-collapsed');
        } else if (saved === 'open') {
          target.classList.remove('group-collapsed');
        }
        btn.style.opacity = target.classList.contains('group-collapsed') ? '0.3' : '1';
      }
    }
  }

  async initProjectSystem() {
    await initProjectSystem(this);
  }

  async _renderProjectList() {
    await renderProjectList(this);
  }

  async switchProject(id, options = {}) {
    await switchProject(this, id, options);
  }

  async deleteProject(id) {
    await deleteProject(this, id);
  }

  async init() {
    console.log('[PERF] --- INITIALIZING APP START ---');
    const t0 = performance.now();
    if (this.engine) {
        this.engine._isLoadingProject = true;
    }

    try {
        // 1. PANELS & UI FIRST (Immediate listener & hotkey wiring)
        this._status('INITIALIZING UI...');
        this._setupUI();
        this._setupHotkeys();

        // 2. STORAGE & COMPARTMENTS SECONDO (Single IndexedDB open, zero artificial sleep)
        try {
            await this.storage.init();
            await Promise.all([
                this._loadWindowPositions(),
                this._restoreUiTogglesAndCategories()
            ]);
            this._restoreWindowPositions();

            await this.initProjectSystem();
            this.palette.setProjectId(this.currentProjectId);
            await this.palette.hydrateFromStorage(this.currentProjectId);
        } catch (e) {
            console.error("Storage init failed", e);
            this._status('STORAGE ERROR');
        }

        await this.tipManager.ready;

        // 3. LOAD NON-CANVAS SETTINGS (Fast per-tool & UI compartment restoration)
        await this.loadProjectSettings();

        // 4. HEAVY ASSETS LAST (Image references and large canvas chunk matrices)
        await this.load();

        // Final viewport and layer sync
        this.engine.refresh();

        // Query and restore the saved recording state for the active project
        if (this.recorder && typeof this.recorder.onProjectSwitched === "function") {
            try {
                await this.recorder.onProjectSwitched();
            } catch(err) {
                console.error("Failed to restore initial recording state:", err);
            }
        }
    } finally {
        if (this.engine) {
            this.engine._isLoadingProject = false;
            this.engine._resetInteractionState({ cancelActive: false });
            this.engine.refresh();
            if (this.engine.gpuRenderer) {
                this.engine.gpuRenderer.requestRender();
            }
            try {
                if (typeof window.focus === 'function') window.focus();
                if ((!document.activeElement || document.activeElement === document.body) && typeof this.engine.container?.focus === 'function') {
                    this.engine.container.focus({ preventScroll: true });
                }
            } catch (_) {}
        }
    }

    this._status('READY');
    console.log(`[PERF] --- TOTAL INITIALIZATION TIME: ${(performance.now() - t0).toFixed(2)}ms ---`);

    // Event hooks
    this.engine.onDrawStart = () => {
        this._lastCanvasActivityTime = performance.now();
        this._clearSaveTimer();
    };
    this.engine.onDrawMove = null;
    this.engine.onDrawEnd = () => {
        this._lastCanvasActivityTime = performance.now();
        this._triggerAutoSave();
    };
    if (this.engine.container) {
        const markCanvasActivity = () => {
            this._lastCanvasActivityTime = performance.now();
        };
        this.engine.container.addEventListener('pointerdown', markCanvasActivity, { passive: true, capture: true });
        this.engine.container.addEventListener('pointerup', markCanvasActivity, { passive: true, capture: true });
    }
    const flushDirtySettings = () => {
        if (this._brushSettingsDirty || (this._dirtyTools && this._dirtyTools.size > 0)) {
            this._saveBrushSettings(true);
        }
        if (this.paletteStudio?._flushDeferredSave) this.paletteStudio._flushDeferredSave();
        if (this.tipManager?.flushPendingSave) this.tipManager.flushPendingSave();
        if (this.engine?._viewportDirty && this.engine?.saveViewport) this.engine.saveViewport(null, true);
        if (this.storage?.flushPendingWrites) this.storage.flushPendingWrites().catch(() => {});
    };
    window.addEventListener('pagehide', flushDirtySettings);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushDirtySettings();
    });
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

    this._scheduleToolWarmup();
  }

  _warmToolSolver(tool) {
    if (!this.engine || !tool) return;
    if (tool === TOOLS.LIQUIFY) {
      if (!warmLiquifySolver(this.engine) && wasmCore && wasmCore.ready) {
        wasmCore.liquifyPrewarm();
      }
    } else if (tool === TOOLS.SMUDGE) {
      warmSmudgeSolver(this.engine);
    } else if (tool === TOOLS.FLUID) {
      warmFluidSolver(this.engine);
    } else if (tool === TOOLS.AIR) {
      warmAirSolver(this.engine);
    } else if (tool === TOOLS.SUMI) {
      warmSumiSolver(this.engine);
    } else if (tool === TOOLS.ERASER) {
      warmEraserSolver(this.engine);
    }
  }

  async prewarmAllTools(force = false) {
    if (!this.engine || this._isPrewarming) return false;
    if (this._allToolsPrewarmed && !force) return true;

    const statusEl = document.getElementById('perf-prewarm-status');
    const btnNow = document.getElementById('btn-perf-prewarm-now');
    if (btnNow) btnNow.disabled = true;
    if (statusEl) statusEl.innerText = 'PREWARMING TOOLS...';

    const ok = await runPhantomToolsPrewarm(this, {
      onProgress: (step, total, label) => {
        if (statusEl) statusEl.innerText = `PREWARMING ${step}/${total}: ${label}`;
      }
    });

    if (btnNow) btnNow.disabled = false;
    if (ok) {
      this._allToolsPrewarmed = true;
      if (statusEl) statusEl.innerText = 'ALL 9 TOOLS WARMED (READY)';
      this._status('ALL TOOLS PREWARMED');
    } else if (statusEl) {
      statusEl.innerText = 'PREWARM INTERRUPTED';
    }
    return ok;
  }

  _scheduleToolWarmup() {
    if (this._warmupScheduled) return;
    this._warmupScheduled = true;

    const runLightweightWarmup = () => {
      if (!this.engine || this.engine.isDrawing || this._isSwitchingProject) return;
      try {
        if (this.engine.brush && this.engine.brush.tip) {
          const bSize = Math.round(this.engine.brush.size || 20);
          const cacheSize = this.engine._getCacheSize(bSize);
          const airbrush = this.engine.brush.airbrush || 0;
          const color = this.engine.brush.color || '#000000';
          this.engine._updateTipCache(cacheSize, airbrush, color);
        }
        const bw = this.engine.isStatic ? Math.min(2560, this.engine.staticWidth || 1024) : (this.engine.chunkSize || 1024);
        const bh = this.engine.isStatic ? Math.min(2560, this.engine.staticHeight || 1024) : (this.engine.chunkSize || 1024);
        const c = acquireBackupCanvas(this.engine, bw, bh, false);
        releaseBackupCanvas(this.engine, c);

        // Prewarm all heavy tools non-blockingly across rAF ticks when enabled
        if (this._perfPrewarmTools && !this._allToolsPrewarmed) {
          this.prewarmAllTools(false);
          return;
        }

        // Fallback when user disabled full prewarm: still warm active heavy tool
        this._warmToolSolver(this.activeTool);
      } catch (e) {
        console.warn('Startup warmup skipped:', e);
      }
    };

    setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(runLightweightWarmup, { timeout: 600 });
      } else {
        runLightweightWarmup();
      }
    }, 120);
  }

  schedulePostSwitchWarmup() {
    if (this._postSwitchWarmupTimer) {
      clearTimeout(this._postSwitchWarmupTimer);
      this._postSwitchWarmupTimer = null;
    }
    const runWarmup = () => {
      this._postSwitchWarmupTimer = null;
      if (!this.engine || this.engine.isDrawing || this._isSwitchingProject) return;
      try {
        if (this.engine.brush && this.engine.brush.tip) {
          const bSize = Math.round(this.engine.brush.size || 20);
          const cacheSize = this.engine._getCacheSize(bSize);
          this.engine._updateTipCache(cacheSize, this.engine.brush.airbrush || 0, this.engine.brush.color || '#000000');
        }
        const bw = this.engine.isStatic ? Math.min(2560, this.engine.staticWidth || 1024) : (this.engine.chunkSize || 1024);
        const bh = this.engine.isStatic ? Math.min(2560, this.engine.staticHeight || 1024) : (this.engine.chunkSize || 1024);
        const c = acquireBackupCanvas(this.engine, bw, bh, false);
        releaseBackupCanvas(this.engine, c);
        this._warmToolSolver(this.activeTool);
        if (this._perfPrewarmTools && !this._allToolsPrewarmed) {
          this.prewarmAllTools(false);
        }
      } catch (_) {}
    };
    this._postSwitchWarmupTimer = setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(runWarmup, { timeout: 350 });
      } else {
        runWarmup();
      }
    }, 40);
  }

  _clearSaveTimer() {
    if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
    }
  }

  _triggerAutoSave() {
    this._clearSaveTimer();
    if (this._pauseAutosaveForModal) return;
    if (this.autosaveEnabled) {
        const delayMs = Number.isFinite(this.autosaveDelay) ? Math.max(1000, this.autosaveDelay) : 4000;
        this.saveTimeout = setTimeout(() => {
            if (this._pauseAutosaveForModal) return;
            const isBusy = this.isCapturingTip || 
                           (this.engine && (this.engine.isDrawing || this.engine.isPanning || this.engine.isPanningMode));
            if (isBusy) {
                // Postpone save action again because the user is currently busy painting/liquifying/editing
                this._triggerAutoSave();
            } else {
                this.save();
            }
        }, delayMs);
    }
  }

  syncCanvasMixMode() {
    const isPhys = (this.palette?.config?.canvasMixMode !== 'digital');
    if (this.engine) {
      this.engine.physicalColorMix = isPhys;
    }
    const chkFluid = document.getElementById('chk-fluid-physical-mix');
    if (chkFluid) chkFluid.checked = isPhys;
    const chkAir = document.getElementById('chk-air-physical-mix');
    if (chkAir) chkAir.checked = isPhys;
    const chkSumi = document.getElementById('chk-sumi-physical-mix');
    if (chkSumi) chkSumi.checked = isPhys;
  }

  _setupUI() {
    setupUI(this);
    initFluidPaint(this);
    initAirPaint(this);
    initSumiPaint(this);
    this.syncCanvasMixMode();
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
      
      if (el.id === 'modal-ref-editor' || el.id === 'modal-color-studio' || el.id === 'modal-layer-color' || el.id === 'modal-new-project' || el.id === 'modal-export') {
        const rect = el.getBoundingClientRect();
        el.style.transform = 'none';
        el.style.left = rect.left + 'px';
        el.style.top = rect.top + 'px';
      }

      
      
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}
      handle.onpointermove = elementDrag;
      handle.onpointerup = closeDragElement;
      handle.onpointercancel = closeDragElement;
      handle.onlostpointercapture = closeDragElement;
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
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
      handle.onlostpointercapture = null;
      try {
        if (e && e.pointerId !== undefined && handle.hasPointerCapture?.(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
      
      if (el.id !== 'modal-ref-editor' && el.id !== 'modal-color-studio' && el.id !== 'modal-new-project' && el.id !== 'modal-export') {
        self.windowPositions[el.id] = {
            top: el.offsetTop,
            left: el.offsetLeft
        };
        self._saveWindowPositions();
      }
    }
  }

  async loadProjectSettings(targetProjectId = null, options = {}) {
    const pid = targetProjectId || this.currentProjectId;
    let settings = {};
    this._dirtyTools?.clear();
    this._brushSettingsDirty = false;

    try {
        const keys = [
            'autosaveDelaySlider',
            'autosaveEnabled',
            'palette',
            'canvasBg',
            'canvasSurface',
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

        const uiStateBatch = await this.storage.loadUiStateBatch([
            'global_autosaveDelaySlider',
            'global_autosaveEnabled',
            'perf_prewarm_tools'
        ]);

        let prewarmPref = uiStateBatch['perf_prewarm_tools'];
        if (prewarmPref === null || prewarmPref === undefined) {
            try {
                const legacyPrewarm = localStorage.getItem('perf_prewarm_tools');
                if (legacyPrewarm !== null) {
                    prewarmPref = (legacyPrewarm === 'true');
                    localStorage.removeItem('perf_prewarm_tools');
                } else {
                    prewarmPref = true;
                }
                this.storage.saveUiState('perf_prewarm_tools', prewarmPref).catch(() => {});
            } catch (_) {
                prewarmPref = true;
            }
        }
        this._perfPrewarmTools = (prewarmPref !== false && prewarmPref !== 'false');
        const prewarmCheck = this._el('settings-perf-prewarm-tools');
        if (prewarmCheck) prewarmCheck.checked = !!this._perfPrewarmTools;

        let perToolMap = null;
        if (!options.isNewProject) {
            const [batchRes, toolRes, _palRes] = await Promise.all([
                this.storage.loadSettingsBatch(keys, pid),
                this.storage.loadAllToolSettings(pid),
                this.palette.hydrateFromStorage(pid)
            ]);
            settings = batchRes || {};
            perToolMap = toolRes || {};
        } else {
            await this.palette.hydrateFromStorage(pid);
        }

        // Load autosave settings (UI state compartment -> per-project legacy fallback -> one-time localStorage migration)
        const rawSlider = settings['autosaveDelaySlider'] ?? uiStateBatch['global_autosaveDelaySlider'];
        const rawEnabled = settings['autosaveEnabled'] ?? uiStateBatch['global_autosaveEnabled'];

        let sliderVal = null;
        if (rawSlider !== null && rawSlider !== undefined && rawSlider !== '') {
            const parsed = Number(rawSlider);
            if (Number.isFinite(parsed)) {
                sliderVal = Math.max(0, Math.min(100, parsed));
            }
        }
        if (sliderVal === null) {
            try {
                const globalRaw = localStorage.getItem('global_autosaveDelaySlider');
                if (globalRaw !== null && globalRaw !== '') {
                    const parsedGlobal = Number(globalRaw);
                    if (Number.isFinite(parsedGlobal)) {
                        sliderVal = Math.max(0, Math.min(100, parsedGlobal));
                        this.storage.saveUiState('global_autosaveDelaySlider', sliderVal).catch(() => {});
                    }
                    localStorage.removeItem('global_autosaveDelaySlider');
                }
            } catch (_) {}
        }
        if (sliderVal === null) sliderVal = 0;

        const seconds = Math.round(4 * Math.pow(300 / 4, sliderVal / 100));
        this.autosaveDelay = (Number.isFinite(seconds) ? seconds : 4) * 1000;
        const sliderEl = this._el('settings-autosave');
        if (sliderEl) sliderEl.value = sliderVal;
        const valEl = this._el('autosave-val');
        if (valEl) valEl.innerText = `${Number.isFinite(seconds) ? seconds : 4}s`;

        let enabledVal = null;
        if (typeof rawEnabled === 'boolean') {
            enabledVal = rawEnabled;
        } else if (rawEnabled === 'true' || rawEnabled === 'false') {
            enabledVal = (rawEnabled === 'true');
        } else {
            try {
                const globalEn = localStorage.getItem('global_autosaveEnabled');
                if (globalEn === 'true' || globalEn === 'false') {
                    enabledVal = (globalEn === 'true');
                    this.storage.saveUiState('global_autosaveEnabled', enabledVal).catch(() => {});
                }
                if (globalEn !== null) localStorage.removeItem('global_autosaveEnabled');
            } catch (_) {}
        }
        if (enabledVal === null) enabledVal = true;

        this.autosaveEnabled = enabledVal;
        const enableEl = this._el('settings-autosave-enable');
        if (enableEl) enableEl.checked = enabledVal;

        // Legacy fallback if project palette wasn't yet in IDB palette compartment
        const savedPalette = settings['palette'];
        const hasPaletteCompartment = await this.storage.loadPaletteCompartment(`p_${pid}`);
        if (!hasPaletteCompartment && savedPalette) {
            this.palette.applySerializedState(savedPalette, { save: true });
        }
        this.syncCanvasMixMode();
        this.paletteStudio?.applyDockedPanelLayout();

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
            const bgEl = this._el('settings-bg-color');
            if (bgEl) bgEl.value = canvasBg;
        } else {
            const bgEl = this._el('settings-bg-color');
            if (bgEl) bgEl.value = '#ffffff';
        }

        const gridColor = projSet.gridColor !== undefined ? projSet.gridColor : settings['gridColor'];
        if (gridColor) {
            this.engine.gridColor = gridColor;
            const gcEl = this._el('settings-grid-color');
            if (gcEl) gcEl.value = gridColor;
        } else {
            const gcEl = this._el('settings-grid-color');
            if (gcEl) gcEl.value = '#cccccc';
        }

        const gridPattern = projSet.gridPattern !== undefined ? projSet.gridPattern : settings['gridPattern'];
        if (gridPattern) {
            this.engine.gridPattern = gridPattern;
            const gpEl = this._el('settings-grid-pattern');
            if (gpEl) gpEl.value = gridPattern;
        } else {
            const gpEl = this._el('settings-grid-pattern');
            if (gpEl) gpEl.value = 'dots';
        }

        const gridSize = projSet.gridSize !== undefined ? projSet.gridSize : settings['gridSize'];
        if (gridSize) {
            this.engine.gridSize = parseInt(gridSize);
            const gsEl = this._el('settings-grid-size');
            if (gsEl) gsEl.value = gridSize;
            const gsvEl = this._el('grid-size-val');
            if (gsvEl) gsvEl.innerText = `${gridSize}px`;
        } else {
            const gsEl = this._el('settings-grid-size');
            if (gsEl) gsEl.value = '64';
            const gsvEl = this._el('grid-size-val');
            if (gsvEl) gsvEl.innerText = '64px';
        }

        const gridThickness = projSet.gridThickness !== undefined ? projSet.gridThickness : settings['gridThickness'];
        if (gridThickness) {
            this.engine.gridThickness = parseFloat(gridThickness);
            const gtEl = this._el('settings-grid-thickness');
            if (gtEl) gtEl.value = gridThickness;
            const gtvEl = this._el('grid-thickness-val');
            if (gtvEl) gtvEl.innerText = `${gridThickness}px`;
        } else {
            this.engine.gridThickness = 2;
            const gtEl = this._el('settings-grid-thickness');
            if (gtEl) gtEl.value = '2';
            const gtvEl = this._el('grid-thickness-val');
            if (gtvEl) gtvEl.innerText = '2px';
        }

        const gridIntensity = projSet.gridIntensity !== undefined ? projSet.gridIntensity : settings['gridIntensity'];
        if (gridIntensity) {
            this.engine.gridIntensity = parseInt(gridIntensity) / 100;
            const giEl = this._el('settings-grid-intensity');
            if (giEl) giEl.value = gridIntensity;
            const givEl = this._el('grid-intensity-val');
            if (givEl) givEl.innerText = `${gridIntensity}%`;
        } else {
            const giEl = this._el('settings-grid-intensity');
            if (giEl) giEl.value = '50';
            const givEl = this._el('grid-intensity-val');
            if (givEl) givEl.innerText = '50%';
        }

        const showGrid = projSet.showGrid !== undefined ? projSet.showGrid : settings['showGrid'];
        if (showGrid !== undefined) {
            this.engine.showGrid = showGrid;
            const sgEl = this._el('settings-grid-show');
            if (sgEl) sgEl.checked = showGrid;
        } else {
            const sgEl = this._el('settings-grid-show');
            if (sgEl) sgEl.checked = true;
        }
        
        const savedSurface = projSet.canvasSurface !== undefined ? projSet.canvasSurface : settings['canvasSurface'];
        if (this.engine.surfaceManager) {
            if (savedSurface) {
                this.engine.surfaceManager.deserialize(savedSurface, () => {
                    if (this.syncSurfaceUI) this.syncSurfaceUI();
                    this.engine.refreshGrid();
                });
            } else {
                this.engine.surfaceManager.applyPresetDefaults('none');
            }
            if (this.syncSurfaceUI) this.syncSurfaceUI();
        }

        // Refresh grid textures & application styles based on settings loaded
        this.engine.setupBoard();

        // PER-TOOL BRUSH SETTINGS (Start from clean defaults on existing project switch so zero leakage occurs)
        if (!options.isNewProject) {
            this.brushSettings = this._createDefaultBrushSettings();
        }

        let savedBrushes = (perToolMap && Object.keys(perToolMap).length > 0) ? perToolMap : null;
        let migratedFromLegacyMonolith = false;
        if (!savedBrushes && !options.isNewProject) {
            savedBrushes = settings['brushSettings'] || null;
            if (!savedBrushes) {
                try {
                    const raw = localStorage.getItem('brushSettings');
                    if (raw) savedBrushes = JSON.parse(raw);
                } catch (_) {}
            }
            if (savedBrushes) migratedFromLegacyMonolith = true;
        }

        if (savedBrushes) {
            Object.keys(savedBrushes).forEach(tool => {
                if (this.brushSettings[tool]) {
                    const migrated = { ...savedBrushes[tool] };
                    let changed = migratedFromLegacyMonolith;
                    if (migrated.speedSize !== undefined && migrated.speedSize !== 0 && Math.abs(migrated.speedSize) <= 12) {
                        migrated.speedSize = Math.round(migrated.speedSize * 5);
                        changed = true;
                    }
                    if (migrated.speedOpacity !== undefined && migrated.speedOpacity !== 0 && Math.abs(migrated.speedOpacity) <= 12) {
                        migrated.speedOpacity = Math.round(migrated.speedOpacity * 5);
                        changed = true;
                    }
                    if (migrated.speedValue !== undefined && migrated.speedValue !== 0 && Math.abs(migrated.speedValue) <= 12) {
                        migrated.speedValue = Math.round(migrated.speedValue * 5);
                        changed = true;
                    }
                    if (migrated.speedHue !== undefined && migrated.speedHue !== 0 && Math.abs(migrated.speedHue) <= 12) {
                        migrated.speedHue = Math.round(migrated.speedHue * 5);
                        changed = true;
                    }
                    if (!migrated._smudgeCalibratedV2) {
                        if (migrated.smudgeFlowBoost === 10.0) {
                            migrated.smudgeFlowBoost = 1.0;
                        }
                        if (migrated.tips) {
                            Object.keys(migrated.tips).forEach(tid => {
                                if (migrated.tips[tid] && migrated.tips[tid].smudgeFlowBoost === 10.0 && !migrated.tips[tid]._smudgeCalibratedV2) {
                                    migrated.tips[tid].smudgeFlowBoost = 1.0;
                                    migrated.tips[tid]._smudgeCalibratedV2 = true;
                                }
                            });
                        }
                        migrated._smudgeCalibratedV2 = true;
                        changed = true;
                    }
                    if (!migrated._defaultsCalibratedV3) {
                        const patchToolDefaults = (obj) => {
                            if (!obj) return;
                            if (tool === TOOLS.SMUDGE) {
                                obj.opacity = 1.0;
                                obj.flow = 1.0;
                                obj.pressureOpacityInfluence = 0.0;
                            } else if (tool === TOOLS.WIREFRAME) {
                                obj.pressureOpacityInfluence = 0.0;
                            } else if (tool === TOOLS.FLUID) {
                                obj.opacity = 1.0;
                                obj.flow = 1.0;
                                obj.fluidity = 80;
                                obj.bristles = 10;
                                obj.fluidFlow = 100;
                                obj.fluidVortex = 8;
                                obj.fluidTurb = 8;
                                obj.fluidRetention = 80;
                                obj.fluidPickup = 80;
                                obj.fluidDepth = 30;
                                obj.fluidGloss = 100;
                            } else if (tool === TOOLS.AIR) {
                                obj.airWetness = 50;
                                obj.airStreamFlow = 50;
                                obj.airBloom = 50;
                                obj.airEdge = 30;
                                obj.airGranulation = 30;
                                obj.airTipPour = 100;
                            }
                        };
                        patchToolDefaults(migrated);
                        if (migrated.tips) {
                            Object.keys(migrated.tips).forEach(tid => patchToolDefaults(migrated.tips[tid]));
                        }
                        migrated._defaultsCalibratedV3 = true;
                        changed = true;
                    }
                    if (!migrated._defaultsCalibratedV4) {
                        if (tool === TOOLS.AIR) {
                            const patchAirV4 = (obj) => {
                                if (!obj) return;
                                obj.airWetness = 100;
                                obj.airStreamFlow = 100;
                            };
                            patchAirV4(migrated);
                            if (migrated.tips) {
                                Object.keys(migrated.tips).forEach(tid => patchAirV4(migrated.tips[tid]));
                            }
                        }
                        migrated._defaultsCalibratedV4 = true;
                        changed = true;
                    }
                    if (!migrated._defaultsCalibratedV5) {
                        if (tool === TOOLS.SUMI) {
                            const patchSumiV5 = (obj) => {
                                if (!obj) return;
                                if (obj.speedWater === undefined || obj.speedWater === 0) {
                                    obj.speedWater = -45;
                                }
                                if (obj.sumiUseHeightmap === undefined) obj.sumiUseHeightmap = false;
                                if (!obj.sumiHeightSource) obj.sumiHeightSource = 'surface';
                            };
                            patchSumiV5(migrated);
                            if (migrated.tips) {
                                Object.keys(migrated.tips).forEach(tid => patchSumiV5(migrated.tips[tid]));
                            }
                        } else if (tool === TOOLS.AIR) {
                            const patchAirV5 = (obj) => {
                                if (!obj) return;
                                if (obj.speedWater === undefined) obj.speedWater = 0;
                                if (obj.airUseHeightmap === undefined) obj.airUseHeightmap = false;
                                if (!obj.airHeightSource) obj.airHeightSource = 'surface';
                            };
                            patchAirV5(migrated);
                            if (migrated.tips) {
                                Object.keys(migrated.tips).forEach(tid => patchAirV5(migrated.tips[tid]));
                            }
                        } else if (tool === TOOLS.FLUID) {
                            const patchFluidV5 = (obj) => {
                                if (!obj) return;
                                if (obj.speedHeight === undefined) obj.speedHeight = 0;
                                if (obj.fluidHeightShield === undefined) obj.fluidHeightShield = 65;
                            };
                            patchFluidV5(migrated);
                            if (migrated.tips) {
                                Object.keys(migrated.tips).forEach(tid => patchFluidV5(migrated.tips[tid]));
                            }
                        }
                        migrated._defaultsCalibratedV5 = true;
                        changed = true;
                    }
                    if (tool === TOOLS.LIQUIFY && !migrated._liquifySizeLockV1) {
                        migrated.speedSize = 0;
                        migrated.pressureSizeInfluence = 0.0;
                        if (migrated.tips) {
                            Object.keys(migrated.tips).forEach(tid => {
                                if (migrated.tips[tid]) {
                                    migrated.tips[tid].speedSize = 0;
                                    migrated.tips[tid].pressureSizeInfluence = 0.0;
                                }
                            });
                        }
                        migrated._liquifySizeLockV1 = true;
                        changed = true;
                    }
                    if (tool === TOOLS.SUMI && !migrated._sumiPressOpacV1) {
                        migrated.pressureOpacityInfluence = 0.0;
                        if (migrated.tips) {
                            Object.keys(migrated.tips).forEach(tid => {
                                if (migrated.tips[tid]) {
                                    migrated.tips[tid].pressureOpacityInfluence = 0.0;
                                }
                            });
                        }
                        migrated._sumiPressOpacV1 = true;
                        changed = true;
                    }
                    this.brushSettings[tool] = { ...this.brushSettings[tool], ...migrated };
                    if (changed) {
                        this.storage.saveToolSetting(tool, this._serializeToolForStorage(this.brushSettings[tool]), pid, false).catch(() => {});
                    }
                }
            });
        }

        // One-time migration of legacy global Fluid Tuning keys to TOOLS.FLUID settings if not yet saved
        const fluidCfg = this.brushSettings[TOOLS.FLUID];
        if (fluidCfg && (!savedBrushes || !savedBrushes[TOOLS.FLUID] || savedBrushes[TOOLS.FLUID].fluidFlow === undefined)) {
            const readLegacyNum = (k, def) => {
                try {
                    const raw = localStorage.getItem(k);
                    if (raw === null) return def;
                    localStorage.removeItem(k);
                    const n = parseFloat(raw);
                    return Number.isFinite(n) ? n : def;
                } catch (_) { return def; }
            };
            fluidCfg.fluidity = readLegacyNum('fluid_setting_slider-fluidity', fluidCfg.fluidity ?? 80);
            fluidCfg.bristles = readLegacyNum('fluid_setting_slider-bristles', fluidCfg.bristles ?? 10);
            fluidCfg.fluidFlow = readLegacyNum('fluid_setting_slider-fluid-flow', fluidCfg.fluidFlow ?? 100);
            fluidCfg.fluidVortex = readLegacyNum('fluid_setting_slider-fluid-vortex', fluidCfg.fluidVortex ?? 8);
            fluidCfg.fluidTurb = readLegacyNum('fluid_setting_slider-fluid-turb', fluidCfg.fluidTurb ?? 8);
            fluidCfg.fluidRetention = readLegacyNum('fluid_setting_slider-fluid-retention', fluidCfg.fluidRetention ?? 80);
            fluidCfg.fluidPickup = readLegacyNum('fluid_setting_slider-fluid-pickup', fluidCfg.fluidPickup ?? 80);
            fluidCfg.fluidDepth = readLegacyNum('fluid_setting_slider-fluid-depth', fluidCfg.fluidDepth ?? 30);
            fluidCfg.fluidGloss = readLegacyNum('fluid_setting_slider-fluid-gloss', fluidCfg.fluidGloss ?? 100);
            try {
                const rawShade = localStorage.getItem('fluid_setting_chk-surface-shading');
                if (rawShade !== null) {
                    fluidCfg.fluidShading = (rawShade === 'true');
                    localStorage.removeItem('fluid_setting_chk-surface-shading');
                }
            } catch (_) {}
        }

        if (migratedFromLegacyMonolith) {
            try { localStorage.removeItem('brushSettings'); } catch (_) {}
        }

        const spacing = settings['brushSpacing'];
        if (spacing) {
            this.engine.brush.spacing = parseFloat(spacing);
            const spEl = this._el('settings-brush-spacing');
            if (spEl) spEl.value = spacing;
        } else {
            const spEl = this._el('settings-brush-spacing');
            if (spEl) spEl.value = '0.05';
        }

    } catch (e) {
        console.warn("Settings load failed", e);
    }

    // 4. RENDER UI STATE
    this._renderPalette();
    this._initColorSelector();
    
    // Retrieve last color value without triggering a redundant write
    const lastColor = (settings && settings['lastColor']) || this.palette.baseColors[0];
    this.setColor(lastColor, { skipSave: true });
    this._updateHSVFromHex(lastColor);
    
    // 5. APPLY BRUSH (Sync UI sliders)
    this.setTool(this.activeTool, true);
  }

  _saveWindowPositions() {
      this.storage?.saveUiState('window_positions', this.windowPositions);
  }

  async _loadWindowPositions() {
      try {
          let saved = await this.storage.loadUiState('window_positions');
          if (!saved) {
              const raw = localStorage.getItem('window_positions');
              if (raw) {
                  saved = JSON.parse(raw);
                  this.storage.saveUiState('window_positions', saved).catch(() => {});
                  localStorage.removeItem('window_positions');
              }
          }
          if (saved && typeof saved === 'object') {
              this.windowPositions = saved;
          }
      } catch (e) {}
  }

  _restoreWindowPositions() {
      Object.keys(this.windowPositions).forEach(id => {
          if (id === 'modal-ref-editor' || id === 'modal-color-studio' || id === 'modal-layer-color' || id === 'modal-new-project' || id === 'modal-export') return;
          const el = document.getElementById(id);
          if (!el) return;

          const pos = this.windowPositions[id];
          if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;

          el.style.top = `${pos.top}px`;
          el.style.left = `${pos.left}px`;
          el.style.right = 'auto';
          el.style.bottom = 'auto';
      });
      this.clampPanelsToView();
  }

  _getPanelDefaultDimensions(id, el) {
      const defaults = {
          'panel-color': [192, 290],
          'panel-images': [144, 210],
          'panel-brush-tips': [168, 420],
          'panel-layers': [160, 260],
          'panel-touch-shortcuts': [144, 240],
          'panel-settings': [320, 500],
          'panel-advanced-brush': [250, 420],
          'panel-recording': [290, 480],
          'panel-fluid': [180, 310],
          'panel-air': [184, 340],
          'panel-sumi': [196, 390],
          'panel-perf-monitor': [320, 440]
      };
      const fallback = defaults[id] || [220, 240];
      const w = (el && el.offsetWidth > 0) ? el.offsetWidth : (parseInt(el?.style?.width, 10) || fallback[0]);
      const h = (el && el.offsetHeight > 0) ? el.offsetHeight : (parseInt(el?.style?.height, 10) || fallback[1]);
      return { w, h };
  }

  clampPanelsToView() {
      const panelIds = [
          'panel-color',
          'panel-images',
          'panel-brush-tips',
          'panel-layers',
          'panel-touch-shortcuts',
          'panel-settings',
          'panel-advanced-brush',
          'panel-recording',
          'panel-fluid',
          'panel-air',
          'panel-sumi',
          'panel-perf-monitor'
      ];
      const canvasContainer = document.getElementById('canvas-container');
      const topBar = document.getElementById('top-bar');
      const topBarH = (topBar && topBar.offsetHeight > 0) ? topBar.offsetHeight : 48;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      panelIds.forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;

          const inCanvasContainer = !!(canvasContainer && canvasContainer.contains(el));
          const maxW = inCanvasContainer ? (canvasContainer.clientWidth || vw) : vw;
          const maxH = inCanvasContainer ? (canvasContainer.clientHeight || (vh - topBarH)) : vh;
          const minX = pad;
          const minY = inCanvasContainer ? pad : (topBarH + pad);
          const { w, h } = this._getPanelDefaultDimensions(id, el);

          let curLeft, curTop;
          if (el.offsetWidth > 0 && el.offsetHeight > 0) {
              curLeft = el.offsetLeft;
              curTop = el.offsetTop;
          } else {
              curLeft = parseFloat(el.style.left);
              curTop = parseFloat(el.style.top);
              if (Number.isNaN(curLeft) || Number.isNaN(curTop)) return;
          }

          const maxLeft = Math.max(minX, maxW - w - pad);
          const maxTop = Math.max(minY, maxH - h - pad);
          const clampedLeft = Math.round(Math.max(minX, Math.min(maxLeft, curLeft)));
          const clampedTop = Math.round(Math.max(minY, Math.min(maxTop, curTop)));

          if (Math.abs(clampedLeft - curLeft) > 0.5 || Math.abs(clampedTop - curTop) > 0.5) {
              el.style.left = `${clampedLeft}px`;
              el.style.top = `${clampedTop}px`;
              el.style.right = 'auto';
              el.style.bottom = 'auto';
              if (this.windowPositions[id]) {
                  this.windowPositions[id] = { top: clampedTop, left: clampedLeft };
              }
          }
      });
  }

  resetUILayout() {
      this.windowPositions = {};
      this.storage?.deleteUiState('window_positions');

      const cssDefaultPanels = [
          'panel-color',
          'panel-images',
          'panel-brush-tips',
          'panel-layers',
          'panel-touch-shortcuts',
          'panel-settings',
          'panel-advanced-brush'
      ];
      cssDefaultPanels.forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;
          el.style.top = '';
          el.style.left = '';
          el.style.right = '';
          el.style.bottom = '';
          el.style.transform = '';
      });

      const inlineDefaults = {
          'panel-recording': { left: '340px', top: '180px' },
          'panel-fluid': { left: '20px', top: '120px' },
          'panel-air': { left: '20px', top: '120px' },
          'panel-sumi': { left: '20px', top: '120px' },
          'panel-perf-monitor': { left: '280px', top: '80px' }
      };
      Object.entries(inlineDefaults).forEach(([id, coords]) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.style.left = coords.left;
          el.style.top = coords.top;
          el.style.right = 'auto';
          el.style.bottom = 'auto';
      });

      this.clampPanelsToView();
      this._saveWindowPositions();
  }

  _updateZoomUI() {
      document.getElementById('zoom-val').innerText = `${Math.round(this.engine.zoom * 100)}%`;
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (this.layerColorController && this.layerColorController.isOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.layerColorController.cancel();
        }
        return;
      }
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
      
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const sumiSubMap = { Digit1: 'draw', Digit2: 'water', Digit3: 'blow', Digit4: 'dry', Digit5: 'eraser' };
        const sumiSubMode = sumiSubMap[e.code];
        if (sumiSubMode) {
          e.preventDefault();
          if (this.activeTool !== TOOLS.SUMI) {
            this.setTool(TOOLS.SUMI);
          }
          this.updateActiveSetting('sumiMode', sumiSubMode);
          const ts = this.getCurrentTipSettings();
          if (ts) syncSumiSettingsFromTip(ts);
          updateSumiSubtoolUI(sumiSubMode);
          this._status(`SUMI MODE: ${sumiSubMode.toUpperCase()}`);
          return;
        }
      }

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
        case '7':
        case 'f':
          this.setTool(TOOLS.FLUID);
          break;
        case '8':
        case 'a':
          this.setTool(TOOLS.AIR);
          break;
        case '9':
        case 'q':
          if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            this.setTool(TOOLS.SUMI);
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
    
    this.updateActiveSetting('size', newSize, null, skipSave);
    
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
    if (!paletteEl) return;
    const cfg = this.palette.config || {};
    const swHeight = Math.max(12, Math.min(44, Number(cfg.swatchHeight) || 24));
    const swGap = Math.max(0, Math.min(10, Number(cfg.swatchGap) || 2));
    const swRadius = cfg.swatchShape === 'rounded' ? '4px' : '0px';

    paletteEl.style.gap = `${swGap}px`;
    const rows = this.palette.generate();

    // Fast path: patch existing swatch nodes in-place if layout structure matches (avoids DOM churn during 60fps wheel drag)
    const existingRows = paletteEl.children;
    let canPatch = existingRows.length === rows.length;
    if (canPatch) {
        for (let r = 0; r < rows.length; r++) {
            const rowEl = existingRows[r];
            const row = rows[r];
            if (!rowEl || rowEl.children.length !== row.length) {
                canPatch = false;
                break;
            }
            for (let c = 0; c < row.length; c++) {
                const sw = rowEl.children[c];
                if (!sw || sw.dataset.swType !== row[c].type || String(sw.dataset.swSpan || '') !== String(row[c].span || '')) {
                    canPatch = false;
                    break;
                }
            }
            if (!canPatch) break;
        }
    }

    if (canPatch) {
        for (let r = 0; r < rows.length; r++) {
            const rowEl = existingRows[r];
            rowEl.style.gap = `${swGap}px`;
            rowEl.style.minHeight = `${swHeight}px`;
            const row = rows[r];
            for (let c = 0; c < row.length; c++) {
                const sw = rowEl.children[c];
                const item = row[c];
                sw._swatchColor = item.color;
                sw.style.backgroundColor = item.color;
                sw.style.height = `${swHeight}px`;
                sw.style.borderRadius = swRadius;
                sw.classList.toggle('active-swatch', !!item.active);
                sw.classList.toggle('locked-swatch', !!item.locked);
                sw.title = item.type === 'main'
                    ? `${item.color} (Anchor ${item.index + 1}${item.locked ? ' · Locked' : ''})`
                    : `${item.color} (Click to use · Shift+Click to set active anchor)`;
            }
        }
        return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'palette-row';
        rowEl.style.gap = `${swGap}px`;
        rowEl.style.minHeight = `${swHeight}px`;

        row.forEach(item => {
            const swatch = document.createElement('div');
            swatch.className = `swatch ${item.type}`;
            swatch.dataset.swType = item.type;
            if (item.span) swatch.dataset.swSpan = String(item.span);
            if (item.active) swatch.classList.add('active-swatch');
            if (item.locked) swatch.classList.add('locked-swatch');
            swatch._swatchColor = item.color;
            swatch.style.backgroundColor = item.color;
            swatch.style.height = `${swHeight}px`;
            swatch.style.borderRadius = swRadius;
            if (item.span) swatch.style.flex = item.span;

            swatch.onclick = (e) => {
                e.stopPropagation();
                const col = swatch._swatchColor || item.color;
                if (item.type === 'main') {
                    this.palette.activeIndex = item.index;
                    this._updateHSVFromHex(col);
                    this.setColor(col);
                    this._renderPalette();
                    this.paletteStudio?.renderStudioDynamicSections({ includeHeavy: false });
                } else if (e.shiftKey) {
                    // Shift+Click promotes generated swatch into active main anchor
                    this.palette.setBaseColor(this.palette.activeIndex, col);
                    this.setColor(col);
                    this._renderPalette();
                    this.storage?.saveSetting('palette', this.palette.getSerializedState());
                    this.paletteStudio?.renderStudioDynamicSections({ includeHeavy: false });
                } else {
                    this.setColor(col);
                }
            };

            swatch.title = item.type === 'main'
                ? `${item.color} (Anchor ${item.index + 1}${item.locked ? ' · Locked' : ''})`
                : `${item.color} (Click to use · Shift+Click to set active anchor)`;
            rowEl.appendChild(swatch);
        });

        frag.appendChild(rowEl);
    });

    paletteEl.innerHTML = '';
    paletteEl.appendChild(frag);
  }

  _initColorSelector() {
    this.paletteStudio?.init();
  }

  _applyHSV() {
    const rgb = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);

    this.palette.setBaseColor(this.palette.activeIndex, hex);
    this.setColor(hex);
    this._renderPalette();
    this._updateColorUI();
    this.palette.saveProjectPalette(this.currentProjectId);
    this.paletteStudio?.renderStudioDynamicSections();
  }

  _updateHSVFromHex(hex) {
    const rgb = hexToRgb(hex);
    this.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    this._updateColorUI();
  }

  _updateColorUI(opts = {}) {
    if (this.paletteStudio && this.paletteStudio._initialized) {
        this.paletteStudio.syncColorUI(this.engine?.brush?.color || this.palette.baseColors[this.palette.activeIndex], opts);
        return;
    }
    const svPicker = document.getElementById('sv-picker');
    const svCursor = svPicker?.querySelector('.sv-cursor');
    const hueSlider = document.getElementById('hue-slider');
    if (!svPicker || !svCursor || !hueSlider) return;

    const pureRgb = hsvToRgb(this.hsv.h, 100, 100);
    const pureHex = rgbToHex(pureRgb.r, pureRgb.g, pureRgb.b);
    svPicker.style.backgroundColor = pureHex;
    svCursor.style.left = `${this.hsv.s}%`;
    svCursor.style.top = `${100 - this.hsv.v}%`;
    hueSlider.value = this.hsv.h;
  }

  _updateBrushSettingsUI(tool) {
    if (!tool || this.activeTool !== tool) return;
    const settings = this.brushSettings[tool];
    const tipSettings = this.getCurrentTipSettings() || settings;
    const el = (id) => this._el(id);
    const setDisp = (id, disp) => {
        const node = el(id);
        if (node && node._lastDisp !== disp) {
            node._lastDisp = disp;
            node.style.display = disp;
        }
        return node;
    };

    const isBrush = tool === TOOLS.BRUSH;
    const isSmudge = tool === TOOLS.SMUDGE;
    const isEraser = tool === TOOLS.ERASER;
    const isWire = tool === TOOLS.WIREFRAME;
    const isLiq = tool === TOOLS.LIQUIFY;
    const isFluid = tool === TOOLS.FLUID;
    const isAir = tool === TOOLS.AIR;
    const isSumi = tool === TOOLS.SUMI;
    const hasAdv = isBrush || isSmudge || isWire || isEraser || isFluid || isAir || isSumi;

    setDisp('height-control', isBrush ? 'block' : 'none');
    setDisp('oiliness-control', isBrush ? 'block' : 'none');
    setDisp('smudge-alpha-control', isSmudge ? 'block' : 'none');
    setDisp('smudge-pickup-control', isSmudge ? 'block' : 'none');
    setDisp('airbrush-control', (isBrush || isSmudge) ? 'block' : 'none');
    setDisp('sumi-span-control', isSumi ? 'block' : 'none');
    setDisp('sumi-bristles-control', isSumi ? 'block' : 'none');
    setDisp('sumi-split-control', isSumi ? 'block' : 'none');

    setDisp('control-opacity', (isLiq || isSumi) ? 'none' : 'block');
    setDisp('control-flow', isSumi ? 'none' : 'block');
    const flowLbl = el('lbl-flow');
    if (flowLbl) flowLbl.innerText = isLiq ? 'STRENGTH' : 'FLOW';

    setDisp('control-falloff', isLiq ? 'block' : 'none');
    setDisp('control-liquify-quality', isLiq ? 'block' : 'none');
    setDisp('control-fluidity', isFluid ? 'block' : 'none');
    setDisp('control-bristles', isFluid ? 'block' : 'none');
    setDisp('btn-advanced-brush', hasAdv ? 'block' : 'none');

    setDisp('cat-pressure', hasAdv ? 'block' : 'none');
    setDisp('cat-jitter', (isBrush || isSmudge || isWire || isEraser || isAir || isFluid) ? 'block' : 'none');
    setDisp('cat-smudge', (isBrush || isSmudge) ? 'block' : 'none');
    setDisp('cat-wireframe', isWire ? 'block' : 'none');
    setDisp('cat-fluid', isFluid ? 'block' : 'none');
    setDisp('cat-air', isAir ? 'block' : 'none');
    setDisp('cat-sumi-brush', isSumi ? 'block' : 'none');
    setDisp('cat-sumi-paper', isSumi ? 'block' : 'none');
    setDisp('cat-speed-tuning', hasAdv ? 'block' : 'none');

    if (!this._advTitleEl) this._advTitleEl = document.querySelector('#panel-advanced-brush .panel-title');
    if (this._advTitleEl) {
        this._advTitleEl.innerText = isEraser
            ? 'ADVANCED ERASER'
            : (isFluid ? 'ADVANCED FLUID' : (isAir ? 'ADVANCED WATERCOLOR' : (isSumi ? 'ADVANCED SUMI-E' : 'ADVANCED BRUSH')));
    }

    const getVal = (key, defaultVal) => (tipSettings[key] !== undefined ? tipSettings[key] : defaultVal);
    const setValSlider = (sliderId, valId, v, formatter) => {
        const s = el(sliderId);
        if (!s) return;
        s.value = v;
        const lbl = valId ? el(valId) : null;
        if (lbl) lbl.innerText = formatter ? formatter(v) : String(v);
    };

    // Common Size / Flow / Opacity
    const mappedSize = this._mapSizeToSlider(tipSettings.size);
    const sizeInput = el('brush-size');
    if (sizeInput) sizeInput.value = mappedSize;
    const sizeValEl = el('size-val');
    if (sizeValEl) sizeValEl.innerText = tipSettings.size;

    const touchSizeInput = el('touch-brush-size');
    if (touchSizeInput) touchSizeInput.value = mappedSize;
    const touchSizeRangeVal = el('touch-size-val');
    if (touchSizeRangeVal) touchSizeRangeVal.innerText = tipSettings.size;

    if (!isLiq && !isSumi) {
        setValSlider('brush-opacity', 'opacity-val', tipSettings.opacity * 100, (v) => `${Math.round(v)}%`);
    }
    if (!isSumi) {
        setValSlider('brush-flow', 'flow-val', tipSettings.flow * 100, (v) => `${Math.round(v)}%`);
    }

    // Tool-specific primary controls (skip hidden tools completely)
    if (isLiq) {
        setValSlider('brush-falloff', 'falloff-val', (tipSettings.falloff ?? 0.50) * 100, (v) => `${Math.round(v)}%`);
        const liqQualEl = el('brush-liquify-quality');
        if (liqQualEl) {
            const qModeNames = { 1: 'FAST', 2: 'CRISP', 3: 'ULTRA' };
            const qVal = Math.max(1, Math.min(3, parseInt(tipSettings.liquifyQuality ?? 2, 10) || 2));
            liqQualEl.value = qVal;
            const liqQualDisplay = el('liquify-quality-val');
            if (liqQualDisplay) liqQualDisplay.innerText = qModeNames[qVal] || 'CRISP';
        }
    }

    if (isBrush || isSmudge) {
        if (isBrush) {
            setValSlider('brush-height', 'height-val', (tipSettings.paintHeight || 0) * 100, (v) => `${Math.round(v)}%`);
            setValSlider('brush-oiliness', 'oiliness-val', (tipSettings.oiliness ?? 0.5) * 100, (v) => `${Math.round(v)}%`);
        }
        setValSlider('brush-airbrush', 'airbrush-val', (tipSettings.airbrush || 0) * 100, (v) => `${Math.round(v)}%`);

        const smudgeAlphaEl = el('brush-smudge-alpha');
        if (smudgeAlphaEl) {
            const isAlphaOn = (tipSettings.smudgeAlpha !== undefined) ? !!tipSettings.smudgeAlpha : true;
            smudgeAlphaEl.value = isAlphaOn ? 1 : 0;
            const valEl = el('smudge-alpha-val');
            if (valEl) valEl.innerText = isAlphaOn ? 'ON' : 'OFF';
        }
        setValSlider('brush-smudge-pickup', 'smudge-pickup-val', tipSettings.smudgePickup ?? 2.0, (v) => v.toFixed(1));
        setValSlider('adv-smudge-flow-boost', 'adv-smudge-flow-boost-val', getVal('smudgeFlowBoost', 1.0), (v) => v.toFixed(1));
    }

    if (hasAdv) {
        setValSlider('speed-size', 's-size-val', tipSettings.speedSize, (v) => String(Math.round(v)));
        setValSlider('speed-opacity', 's-opac-val', tipSettings.speedOpacity, (v) => String(Math.round(v)));
        setValSlider('speed-value', 's-val-val', tipSettings.speedValue, (v) => String(Math.round(v)));
        setValSlider('speed-hue', 's-hue-val', tipSettings.speedHue, (v) => String(Math.round(v)));

        setDisp('s-height-container', isFluid ? '' : 'none');
        if (isFluid) {
            setValSlider('speed-height', 's-height-val', tipSettings.speedHeight ?? 0, (v) => String(Math.round(v)));
        }

        setDisp('s-water-container', (isAir || isSumi) ? '' : 'none');
        if (isAir || isSumi) {
            setValSlider('speed-water', 's-water-val', tipSettings.speedWater ?? (isSumi ? -45 : 0), (v) => String(Math.round(v)));
        }

        setDisp('max-water-container', isSumi ? '' : 'none');
        if (isSumi) {
            setValSlider('sumi-max-water', 'max-water-val', tipSettings.sumiMaxWater ?? 100, (v) => `${Math.round(v)}%`);
        }

        setValSlider('adv-brush-sharpen', 'adv-brush-sharpen-val', getVal('brushSharpen', 0.0), (v) => v.toFixed(2));
        setDisp('group-brush-spacing', isSumi ? 'none' : '');
        setDisp('group-sumi-pressure-gate', isSumi ? '' : 'none');
        if (!isSumi) {
            const spacingEl = el('settings-brush-spacing');
            if (spacingEl) spacingEl.value = getVal('spacing', 0.05);
        }

        const pressureEnable = el('settings-pressure-enable');
        if (pressureEnable) pressureEnable.checked = getVal('pressureEnabled', true);

        const pressureOpacityLbl = el('lbl-pressure-opacity');
        if (pressureOpacityLbl) pressureOpacityLbl.innerText = isSumi ? 'AFFECTED INK CONC.' : 'AFFECTED OPACITY';

        const defOpInf = (isSmudge || isWire || isSumi) ? 0.0 : 1.0;
        setValSlider('settings-pressure-opacity-influence', 'pressure-opacity-val', getVal('pressureOpacityInfluence', defOpInf), (v) => v.toFixed(1));
        setValSlider('settings-pressure-size-influence', 'pressure-size-val', getVal('pressureSizeInfluence', 1.0), (v) => v.toFixed(1));
        setValSlider('adv-speed-max', 'adv-speed-max-val', getVal('speedMax', 5.0), (v) => v.toFixed(1));
    }

    if (hasAdv && !isSumi) {
        const jSizeVal = getVal('jitterSize', 0);
        const jitterSize = el('settings-jitter-size');
        if (jitterSize) {
            jitterSize.value = this._mapPrecisionToSlider(jSizeVal, 100);
            const valEl = el('jitter-size-val');
            if (valEl) valEl.innerText = `${jSizeVal}%`;
        }
        const jAngleVal = getVal('jitterAngle', 0);
        const jitterAngle = el('settings-jitter-angle');
        if (jitterAngle) {
            jitterAngle.value = this._mapPrecisionToSlider(jAngleVal, 180);
            const valEl = el('jitter-angle-val');
            if (valEl) valEl.innerText = `${jAngleVal}°`;
        }
        const jPosVal = getVal('jitterPos', 0);
        const jitterPos = el('settings-jitter-pos');
        if (jitterPos) {
            jitterPos.value = this._mapPrecisionToSlider(jPosVal, 200);
            const valEl = el('jitter-pos-val');
            if (valEl) valEl.innerText = `${jPosVal}%`;
        }
        const jHueVal = getVal('jitterHue', 0);
        const jitterHue = el('settings-jitter-hue');
        if (jitterHue) {
            jitterHue.value = this._mapPrecisionToSlider(jHueVal, 100);
            const valEl = el('jitter-hue-val');
            if (valEl) valEl.innerText = `${jHueVal}%`;
        }
    }

    if (isWire) {
        setValSlider('adv-wire-density', 'adv-wire-density-val', getVal('wireDensity', 30), (v) => String(v));
        setValSlider('adv-wire-range', 'adv-wire-range-val', getVal('wireRange', 4.0), (v) => v.toFixed(1));
        setValSlider('adv-wire-min-dist', 'adv-wire-min-dist-val', getVal('wireMinDist', 0.5), (v) => v.toFixed(1));
    }

    if (isAir) {
        const syncAirUi = (elId, valId, key, defVal) => {
            const val = getVal(key, defVal);
            setValSlider(elId, valId, val, (v) => `${v}%`);
            if (this.engine?.brush) this.engine.brush[key] = val;
        };
        syncAirUi('adv-air-wetness', 'adv-air-wetness-val', 'airWetness', 100);
        syncAirUi('adv-air-stream', 'adv-air-stream-val', 'airStreamFlow', 100);
        syncAirUi('adv-air-bloom', 'adv-air-bloom-val', 'airBloom', 50);
        syncAirUi('adv-air-edge', 'adv-air-edge-val', 'airEdge', 30);
        syncAirUi('adv-air-granulation', 'adv-air-granulation-val', 'airGranulation', 30);

        const airPourVal = getVal('airTipPour', 100);
        setValSlider('adv-air-tip-pour', 'adv-air-tip-pour-val', airPourVal, (v) => `${Math.round(v)}%`);
        setValSlider('slider-air-tip-pour', 'air-tip-pour-val', airPourVal, (v) => `${Math.round(v)}%`);

        const btnDraw = el('btn-air-mode-draw');
        const btnMix = el('btn-air-mode-mix');
        const btnPour = el('btn-air-mode-pour');
        if (btnDraw && btnMix && btnPour) {
            btnDraw.classList.toggle('active-btn', airPourVal <= 12);
            btnMix.classList.toggle('active-btn', airPourVal > 12 && airPourVal < 65);
            btnPour.classList.toggle('active-btn', airPourVal >= 65);
        }

        const airFollow = el('adv-air-follow-stroke');
        if (airFollow) airFollow.checked = !!getVal('airFollowStroke', false);
        setValSlider('adv-air-tip-angle', 'adv-air-tip-angle-val', getVal('airTipAngle', 0), (v) => `${Math.round(v)}°`);
        syncAirUi('adv-air-tip-hardness', 'adv-air-tip-hardness-val', 'airTipHardness', 55);
        syncAirUi('adv-air-pressure-flow', 'adv-air-pressure-flow-val', 'airPressureFlow', 35);

        const airUseH = !!getVal('airUseHeightmap', false);
        const airHSrc = getVal('airHeightSource', 'surface') === 'layer' ? 'layer' : 'surface';
        const airHSrcLbl = airHSrc === 'layer' ? 'LAYER' : 'SURFACE';
        const chkAirH = el('chk-air-use-heightmap');
        const advChkAirH = el('adv-air-use-heightmap');
        const btnAirSrc = el('btn-air-height-source');
        const advBtnAirSrc = el('adv-air-height-source');
        if (chkAirH) chkAirH.checked = airUseH;
        if (advChkAirH) advChkAirH.checked = airUseH;
        if (btnAirSrc) { btnAirSrc.innerText = airHSrcLbl; btnAirSrc.style.opacity = airUseH ? '1' : '0.45'; }
        if (advBtnAirSrc) { advBtnAirSrc.innerText = airHSrcLbl; advBtnAirSrc.style.opacity = airUseH ? '1' : '0.45'; }
        if (this.engine?.brush) {
            this.engine.brush.airUseHeightmap = airUseH;
            this.engine.brush.airHeightSource = airHSrc;
        }
    }

    if (isFluid) {
        const syncFluidUiSlider = (elId, valId, key, defVal, unit = '%') => {
            setValSlider(elId, valId, getVal(key, defVal), (v) => `${Math.round(v)}${unit}`);
        };
        syncFluidUiSlider('slider-fluidity', 'val-fluidity', 'fluidity', 80);
        syncFluidUiSlider('slider-bristles', 'val-bristles', 'bristles', 10, '');
        syncFluidUiSlider('slider-fluid-flow', 'val-fluid-flow', 'fluidFlow', 100);
        syncFluidUiSlider('slider-fluid-vortex', 'val-fluid-vortex', 'fluidVortex', 8);
        syncFluidUiSlider('slider-fluid-turb', 'val-fluid-turb', 'fluidTurb', 8);
        syncFluidUiSlider('slider-fluid-retention', 'val-fluid-retention', 'fluidRetention', 80);
        syncFluidUiSlider('slider-fluid-pickup', 'val-fluid-pickup', 'fluidPickup', 80);
        syncFluidUiSlider('slider-fluid-depth', 'val-fluid-depth', 'fluidDepth', 30);
        syncFluidUiSlider('slider-fluid-height-shield', 'val-fluid-height-shield', 'fluidHeightShield', 65);
        syncFluidUiSlider('slider-fluid-gloss', 'val-fluid-gloss', 'fluidGloss', 100);

        const chkShading = el('chk-surface-shading');
        if (chkShading) chkShading.checked = getVal('fluidShading', true);
        const chkFollow = el('adv-fluid-follow-stroke');
        if (chkFollow) chkFollow.checked = !!getVal('fluidFollowStroke', false);
        syncFluidUiSlider('adv-fluid-tip-angle', 'adv-fluid-tip-angle-val', 'fluidTipAngle', 0, '°');
        syncFluidUiSlider('adv-fluid-bristle-contrast', 'adv-fluid-bristle-contrast-val', 'fluidBristleContrast', 65);
        syncFluidUiSlider('adv-fluid-bleed', 'adv-fluid-bleed-val', 'fluidBleed', 50);
        syncFluidUiSlider('adv-fluid-tip-hardness', 'adv-fluid-tip-hardness-val', 'fluidTipHardness', 50);
        syncFluidUiSlider('adv-fluid-pressure-flow', 'adv-fluid-pressure-flow-val', 'fluidPressureFlow', 35);
    }

    if (isSumi) {
        const syncSumiSlider = (elId, valId, key, defVal, unit = '%') => {
            setValSlider(elId, valId, getVal(key, defVal), (v) => `${Math.round(v)}${unit}`);
        };
        syncSumiSlider('brush-sumi-span', 'sumi-span-val', 'sumiSpan', 550, 'px');
        syncSumiSlider('brush-sumi-bristles', 'sumi-bristles-val', 'sumiBristles', 28, '');
        syncSumiSlider('brush-sumi-split', 'sumi-split-val', 'sumiSplit', 48, '%');
        const activeSumiMode = getVal('sumiMode', 'draw');
        const inkKey = activeSumiMode === 'water' ? 'sumiInkAffection' : (activeSumiMode === 'eraser' ? 'sumiEraserInk' : 'sumiInk');
        const inkDef = activeSumiMode === 'water' ? 35 : (activeSumiMode === 'eraser' ? 85 : 78);
        const watKey = activeSumiMode === 'water' ? 'sumiWaterWash' : (activeSumiMode === 'eraser' ? 'sumiEraserWater' : 'sumiWater');
        const watDef = activeSumiMode === 'water' ? 75 : (activeSumiMode === 'eraser' ? 25 : 65);
        syncSumiSlider('slider-sumi-ink', 'val-sumi-ink', inkKey, inkDef, '%');
        syncSumiSlider('slider-sumi-water', 'val-sumi-water', watKey, watDef, '%');
        syncSumiSlider('slider-sumi-bleed', 'val-sumi-bleed', 'sumiBleed', 58, '%');
        syncSumiSlider('adv-sumi-stiffness', 'adv-sumi-stiffness-val', 'sumiStiffness', 60, '%');
        syncSumiSlider('adv-sumi-glue', 'adv-sumi-glue-val', 'sumiGlue', 42, '%');
        syncSumiSlider('adv-sumi-warmth', 'adv-sumi-warmth-val', 'sumiWarmth', 12, '');
        syncSumiSlider('adv-sumi-evaporation', 'adv-sumi-evaporation-val', 'sumiEvaporation', 28, '%');
        syncSumiSlider('adv-sumi-capillarity', 'adv-sumi-capillarity-val', 'sumiCapillarity', 62, '%');
        syncSumiSlider('adv-sumi-backrun', 'adv-sumi-backrun-val', 'sumiBackrun', 68, '%');
        syncSumiSlider('adv-sumi-turbulence', 'adv-sumi-turbulence-val', 'sumiTurbulence', 0, '%');
        syncSumiSlider('adv-sumi-soot-snag', 'adv-sumi-soot-snag-val', 'sumiSootSnag', 55, '%');
        syncSumiSlider('adv-sumi-tip-angle', 'adv-sumi-tip-angle-val', 'sumiTipAngle', 0, '°');
        syncSumiSlider('adv-sumi-pressure-flow', 'adv-sumi-pressure-flow-val', 'sumiPressureFlow', 35, '%');
        syncSumiSlider('adv-sumi-pressure-gate', 'adv-sumi-pressure-gate-val', 'sumiPressureGate', 20, '%');

        const chkSumiDeplete = el('adv-sumi-deplete');
        if (chkSumiDeplete) chkSumiDeplete.checked = getVal('sumiDeplete', true);
        const chkSumiSplit = el('adv-sumi-split-enabled');
        if (chkSumiSplit) chkSumiSplit.checked = getVal('sumiSplitEnabled', true);
        const chkSumiTilt = el('adv-sumi-tilt');
        if (chkSumiTilt) chkSumiTilt.checked = getVal('sumiTilt', true);
        const chkSumiFollow = el('adv-sumi-follow-stroke');
        if (chkSumiFollow) chkSumiFollow.checked = !!getVal('sumiFollowStroke', false);

        const sumiUseH = !!getVal('sumiUseHeightmap', false);
        const sumiHSrc = getVal('sumiHeightSource', 'surface') === 'layer' ? 'layer' : 'surface';
        const sumiHSrcLbl = sumiHSrc === 'layer' ? 'LAYER' : 'SURFACE';
        const chkSumiH = el('chk-sumi-use-heightmap');
        const advChkSumiH = el('adv-sumi-use-heightmap');
        const btnSumiSrc = el('btn-sumi-height-source');
        const advBtnSumiSrc = el('adv-sumi-height-source');
        if (chkSumiH) chkSumiH.checked = sumiUseH;
        if (advChkSumiH) advChkSumiH.checked = sumiUseH;
        if (btnSumiSrc) { btnSumiSrc.innerText = sumiHSrcLbl; btnSumiSrc.style.opacity = sumiUseH ? '1' : '0.45'; }
        if (advBtnSumiSrc) { advBtnSumiSrc.innerText = sumiHSrcLbl; advBtnSumiSrc.style.opacity = sumiUseH ? '1' : '0.45'; }
        if (this.engine?.brush) {
            this.engine.brush.sumiUseHeightmap = sumiUseH;
            this.engine.brush.sumiHeightSource = sumiHSrc;
        }

        const btnAutoDip = el('btn-sumi-auto-redip');
        if (btnAutoDip) {
            const autoDip = getVal('sumiAutoReDip', true);
            btnAutoDip.classList.toggle('active-btn', !!autoDip);
            btnAutoDip.innerText = autoDip ? 'AUTO DIP' : 'MANUAL DIP';
        }
        updateSumiSubtoolUI(getVal('sumiMode', 'draw'));
    }

    // Active tip label badge for visible panel
    let tipBadge = 'MAIN #1';
    if (this.tipManager) {
        if (this.tipManager.activeBankIndex >= 0) {
            tipBadge = `MAIN #${this.tipManager.activeBankIndex + 1}`;
        } else if (this.tipManager.activeGeneratedIndex >= 0) {
            tipBadge = `GEN #${this.tipManager.activeGeneratedIndex + 1}`;
        }
    }
    const advTipLbl = el('adv-active-tip-label');
    if (advTipLbl) advTipLbl.innerText = `TIP: ${tipBadge}`;
    if (isFluid) {
        const fldTipLbl = el('fluid-active-tip-label');
        if (fldTipLbl) fldTipLbl.innerText = tipBadge;
    } else if (isAir) {
        const airTipLbl = el('air-active-tip-label');
        if (airTipLbl) airTipLbl.innerText = tipBadge;
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
            speedHeight: settings.speedHeight ?? 0,
            speedWater: settings.speedWater ?? (this.activeTool === TOOLS.SUMI ? -45 : 0),
            speedMax: settings.speedMax ?? 5.0,
            paintHeight: settings.paintHeight ?? 0,
            oiliness: settings.oiliness ?? 0.5,
            airbrush: settings.airbrush ?? 0.0,
            smudgeFlowBoost: settings.smudgeFlowBoost ?? 1.0,
            _smudgeCalibratedV2: true,
            smudgePickup: settings.smudgePickup ?? 2.0,
            smudgeAlpha: settings.smudgeAlpha ?? true,
            brushSharpen: settings.brushSharpen ?? 0.0,
            wireDensity: settings.wireDensity ?? 30,
            wireRange: settings.wireRange ?? 4.0,
            wireMinDist: settings.wireMinDist ?? 0.5,
            spacing: settings.spacing ?? 0.05,
            pressureEnabled: settings.pressureEnabled ?? true,
            pressureOpacityInfluence: settings.pressureOpacityInfluence ?? (this.activeTool === TOOLS.SUMI ? 0.0 : 1.0),
            pressureSizeInfluence: settings.pressureSizeInfluence ?? 1.0,
            jitterSize: settings.jitterSize ?? 0,
            jitterAngle: settings.jitterAngle ?? 0,
            jitterPos: settings.jitterPos ?? 0,
            jitterHue: settings.jitterHue ?? 0,
            airWetness: settings.airWetness ?? 100,
            airStreamFlow: settings.airStreamFlow ?? 100,
            airBloom: settings.airBloom ?? 50,
            airEdge: settings.airEdge ?? 30,
            airGranulation: settings.airGranulation ?? 30,
            airTipPour: settings.airTipPour ?? 100,
            airFollowStroke: settings.airFollowStroke ?? false,
            airTipAngle: settings.airTipAngle ?? 0,
            airTipHardness: settings.airTipHardness ?? 55,
            airPressureFlow: settings.airPressureFlow ?? 35,
            airUseHeightmap: settings.airUseHeightmap ?? false,
            airHeightSource: settings.airHeightSource || 'surface',
            fluidity: settings.fluidity ?? 80,
            bristles: settings.bristles ?? 10,
            fluidFlow: settings.fluidFlow ?? 100,
            fluidVortex: settings.fluidVortex ?? 8,
            fluidTurb: settings.fluidTurb ?? 8,
            fluidRetention: settings.fluidRetention ?? 80,
            fluidPickup: settings.fluidPickup ?? 80,
            fluidDepth: settings.fluidDepth ?? 30,
            fluidHeightShield: settings.fluidHeightShield ?? 65,
            fluidGloss: settings.fluidGloss ?? 100,
            fluidShading: settings.fluidShading ?? true,
            fluidFollowStroke: settings.fluidFollowStroke ?? false,
            fluidTipAngle: settings.fluidTipAngle ?? 0,
            fluidBristleContrast: settings.fluidBristleContrast ?? 65,
            fluidBleed: settings.fluidBleed ?? 50,
            fluidTipHardness: settings.fluidTipHardness ?? 50,
            fluidPressureFlow: settings.fluidPressureFlow ?? 35,
            sumiMode: settings.sumiMode ?? 'draw',
            sumiInk: settings.sumiInk ?? 78,
            sumiInkAffection: settings.sumiInkAffection ?? 35,
            sumiWater: settings.sumiWater ?? 65,
            sumiWaterWash: settings.sumiWaterWash ?? settings.sumiWater ?? 75,
            sumiEraserInk: settings.sumiEraserInk ?? 85,
            sumiEraserWater: settings.sumiEraserWater ?? 25,
            sumiBleed: settings.sumiBleed ?? 58,
            sumiBristles: settings.sumiBristles ?? 28,
            sumiStiffness: settings.sumiStiffness ?? 60,
            sumiSplit: settings.sumiSplit ?? 48,
            sumiSpan: settings.sumiSpan ?? 550,
            sumiGlue: settings.sumiGlue ?? 42,
            sumiWarmth: settings.sumiWarmth ?? 12,
            sumiEvaporation: settings.sumiEvaporation ?? 28,
            sumiCapillarity: settings.sumiCapillarity ?? 62,
            sumiBackrun: settings.sumiBackrun ?? 68,
            sumiTurbulence: settings.sumiTurbulence ?? 0,
            sumiSootSnag: settings.sumiSootSnag ?? 55,
            sumiDeplete: settings.sumiDeplete ?? true,
            sumiSplitEnabled: settings.sumiSplitEnabled ?? true,
            sumiTilt: settings.sumiTilt ?? true,
            sumiAutoReDip: settings.sumiAutoReDip ?? true,
            sumiFollowStroke: settings.sumiFollowStroke ?? false,
            sumiTipAngle: settings.sumiTipAngle ?? 0,
            sumiPressureFlow: settings.sumiPressureFlow ?? 35,
            sumiPressureGate: settings.sumiPressureGate ?? 20,
            sumiMaxWater: settings.sumiMaxWater ?? 100,
            sumiUseHeightmap: settings.sumiUseHeightmap ?? false,
            sumiHeightSource: settings.sumiHeightSource || 'surface'
        };
    }
    return settings.tips[tipId];
  }

  updateActiveSetting(key, val, mappedVal = null, skipSave = false) {
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
    
    this._dirtyTools.add(this.activeTool);
    if (!skipSave) {
        this._saveBrushSettings();
    } else {
        this._brushSettingsDirty = true;
    }
  }

  setTool(tool, force = false) {
    if (this.activeTool === tool && !force) return;
    this.prevTool = this.activeTool;
    this.activeTool = tool;
    if (this.perfMonitor) this.perfMonitor.markToolChange(tool, this.prevTool);
    
    // Reset any stuck stroke or pointing states from previous tool
    if (this.engine) {
        if (this.engine.isDrawing) {
            try { this.engine._endStroke(); } catch (e) { this.engine.isDrawing = false; }
        }
        this.engine._resetInteractionState({ cancelActive: false });
        if (tool !== TOOLS.LIQUIFY && this.engine.invalidateLiquifySession) {
            this.engine.invalidateLiquifySession();
        }
    }

    // Deselect reference image when switching to anything that isn't generic move, only if one was selected
    if (tool !== TOOLS.REF_MOVE && this.engine.selectedRefIndex !== -1) {
        this.engine.selectedRefIndex = -1;
        this.engine.refresh();
    }

    const isCanvasPaintTool = (
        tool === TOOLS.BRUSH ||
        tool === TOOLS.ERASER ||
        tool === TOOLS.WIREFRAME ||
        tool === TOOLS.LASSO ||
        tool === TOOLS.SMUDGE ||
        tool === TOOLS.LIQUIFY ||
        tool === TOOLS.FLUID ||
        tool === TOOLS.AIR ||
        tool === TOOLS.SUMI
    );
    if (tool === TOOLS.REF_MOVE) {
        if (this.engine.activeLayer !== 0) this.setLayer(0);
    } else if (isCanvasPaintTool && this.engine && this.engine.activeLayer === 0) {
        const targetLayer = (this.lastPaintLayer >= 1 && this.lastPaintLayer < LAYERS_COUNT) ? this.lastPaintLayer : 2;
        this.setLayer(targetLayer);
    }

    const sensitivityGroup = document.querySelector('.sensitivity-group');
    if (sensitivityGroup) {
        if (tool === TOOLS.BRUSH || tool === TOOLS.SMUDGE || tool === TOOLS.ERASER || tool === TOOLS.WIREFRAME || tool === TOOLS.FLUID || tool === TOOLS.AIR || tool === TOOLS.SUMI) {
            sensitivityGroup.classList.remove('hidden');
        } else {
            sensitivityGroup.classList.add('hidden');
        }
    }
    
    if (!this._toolBtnList) {
        this._toolBtnList = Array.from(document.querySelectorAll('.tool-group .tool-btn'));
    }
    if (!tool) {
        for (let i = 0; i < this._toolBtnList.length; i++) {
            this._toolBtnList[i].classList.remove('active-tool');
        }
        return;
    }

    if (tool === TOOLS.BRUSH || tool === TOOLS.WIREFRAME) {
        this.lastBrush = tool;
    }
    
    // Apply per-brush settings
    const settings = this.brushSettings[tool];
    this.engine.brush.type = tool;

    // Lightweight CPU buffer prep immediately; heavy GPU solver compile runs right after UI paint
    if (tool === TOOLS.SMUDGE || tool === TOOLS.FLUID) {
        ensureSmudgeBuffers(this.engine);
    }
    if (this._toolWarmupTimer) {
        clearTimeout(this._toolWarmupTimer);
        this._toolWarmupTimer = null;
    }
    if (
        this.engine &&
        !this.engine._isLoadingProject &&
        (tool === TOOLS.LIQUIFY || tool === TOOLS.SMUDGE || tool === TOOLS.FLUID || tool === TOOLS.AIR || tool === TOOLS.SUMI || tool === TOOLS.ERASER)
    ) {
        this._toolWarmupTimer = setTimeout(() => {
            this._toolWarmupTimer = null;
            if (this.activeTool === tool && this.engine && !this.engine.isDrawing && !this._isSwitchingProject) {
                try {
                    this._warmToolSolver(tool);
                } catch (e) {
                    console.warn('Tool solver warmup skipped:', e);
                }
            }
        }, 0);
    }

    // Restore this tool's specific active tip in the panel
    if (this.tipManager && (tool === TOOLS.BRUSH || tool === TOOLS.WIREFRAME || tool === TOOLS.ERASER || tool === TOOLS.SMUDGE || tool === TOOLS.FLUID || tool === TOOLS.AIR || tool === TOOLS.SUMI)) {
        this.tipManager.activeBankIndex = settings.activeBankIndex !== undefined ? settings.activeBankIndex : 0;
        this.tipManager.activeGeneratedIndex = settings.activeGeneratedIndex !== undefined ? settings.activeGeneratedIndex : -1;
        this.tipManager._renderPalette(false);
        this.tipManager.refreshTip(true);
    } else {
        this.engine.brush.size = settings.size;
        this.engine.brush.opacity = settings.opacity;
        this.engine.brush.flow = settings.flow;
        this.engine.brush.falloff = settings.falloff ?? 0.50;
        this.engine.brush.liquifyQuality = settings.liquifyQuality ?? 2;
        this.engine.brush.speedSize = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedSize ?? 0);
        this.engine.brush.speedOpacity = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedOpacity ?? 0);
        this.engine.brush.speedValue = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedValue ?? 0);
        this.engine.brush.speedHue = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedHue ?? 0);
        this.engine.brush.speedHeight = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedHeight ?? 0);
        this.engine.brush.speedWater = (tool === TOOLS.LIQUIFY) ? 0 : (settings.speedWater ?? 0);
        this.engine.brush.speedMax = settings.speedMax ?? 5.0;
        this.engine.brush.pressureEnabled = settings.pressureEnabled ?? true;
        this.engine.brush.pressureSizeInfluence = (tool === TOOLS.LIQUIFY) ? 0.0 : (settings.pressureSizeInfluence ?? 1.0);
        this.engine.brush.pressureOpacityInfluence = (tool === TOOLS.LIQUIFY) ? 0.0 : (settings.pressureOpacityInfluence ?? (tool === TOOLS.SUMI ? 0.0 : 1.0));
        this._updateBrushSettingsUI(tool);
    }
    
    // Update UI Buttons
    for (let i = 0; i < this._toolBtnList.length; i++) {
        this._toolBtnList[i].classList.remove('active-tool');
    }

    let activeBtnId = `btn-${tool === TOOLS.AIR ? 'air' : tool}`;
    const btn = this._el(activeBtnId);
    if (btn) {
      btn.classList.add('active-tool');
    }

    // Update Touch Eyedropper highlight
    const touchPickerBtn = this._el('btn-touch-picker');
    if (touchPickerBtn) {
        touchPickerBtn.classList.toggle('active-tool', tool === TOOLS.PICKER);
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
    if (this.prevTool === TOOLS.SUMI && tool !== TOOLS.SUMI) {
        deactivateSumiPaint(this);
    }
    if (tool === TOOLS.SUMI) {
        activateSumiPaint(this);
    }

    if (this.engine && this.engine._updateBrushCursor) {
        this.engine._updateBrushCursor();
    }
    if (tool) this._status(tool);
  }

  setColor(color, { skipSave = false, preserveHsv = false, deferUi = false } = {}) {
    this.engine.brush.color = color;
    const preview = document.getElementById('current-color-preview');
    if (preview) preview.style.backgroundColor = color;
    
    if (!skipSave && this.storage) this.storage.saveSetting('lastColor', color);

    if (!preserveHsv) {
        const rgb = hexToRgb(color);
        this.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    }
    this._updateColorUI({ deferUi });

    // Smart Switch check: if color picked while using non-painting tools, switch to last brush
    if (this.activeTool === TOOLS.ERASER || this.activeTool === TOOLS.LASSO || this.activeTool === TOOLS.SMUDGE || this.activeTool === TOOLS.PICKER) {
        this.setTool(this.lastBrush || TOOLS.BRUSH);
    }
  }

  openLayerColorCorrection(layerIndex) {
    if (!this.layerColorController || layerIndex <= 0) return;
    this.layerColorController.open(layerIndex);
  }

  setLayer(index) {
    const prevLayer = this.engine.activeLayer;
    if (prevLayer !== index && this.engine?.flushPendingGpuCommits) {
        this.engine.flushPendingGpuCommits();
    }
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

  _shouldDeferSettingsSave() {
    return !!(
      this.engine?.isDrawing ||
      this.engine?.isPanning ||
      this.engine?.isZooming ||
      (performance.now() - (this._lastCanvasActivityTime || 0) < 450)
    );
  }

  _serializeToolForStorage(s) {
    if (!s) return null;
    const clean = { ...s };
    if (clean.tip instanceof HTMLCanvasElement) clean.tip = null;
    if (s.tips) {
      clean.tips = {};
      const tipKeys = Object.keys(s.tips);
      for (let i = 0; i < tipKeys.length; i++) {
        const tk = tipKeys[i];
        const ts = { ...s.tips[tk] };
        if (ts.tip instanceof HTMLCanvasElement) ts.tip = null;
        clean.tips[tk] = ts;
      }
    }
    return clean;
  }

  _saveBrushSettings(immediate = false) {
    if (this._saveBrushSettingsTimeout) {
        clearTimeout(this._saveBrushSettingsTimeout);
        this._saveBrushSettingsTimeout = null;
    }
    if (this._saveBrushSettingsIdleId && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(this._saveBrushSettingsIdleId);
        this._saveBrushSettingsIdleId = null;
    }
    const flush = () => {
        this._saveBrushSettingsTimeout = null;
        this._saveBrushSettingsIdleId = null;
        if (!immediate && this._shouldDeferSettingsSave()) {
            this._saveBrushSettingsTimeout = setTimeout(scheduleIdleFlush, 400);
            return;
        }
        this._brushSettingsDirty = false;
        const dirtyList = (this._dirtyTools && this._dirtyTools.size > 0)
            ? Array.from(this._dirtyTools)
            : (this.activeTool ? [this.activeTool] : []);
        this._dirtyTools?.clear();

        const pid = this.currentProjectId;
        for (let i = 0; i < dirtyList.length; i++) {
            const toolId = dirtyList[i];
            const raw = this.brushSettings[toolId];
            if (!raw) continue;
            const clean = this._serializeToolForStorage(raw);
            this.storage.saveToolSetting(toolId, clean, pid, immediate).catch(() => {});
        }
    };
    const scheduleIdleFlush = () => {
        this._saveBrushSettingsTimeout = null;
        if (this._shouldDeferSettingsSave()) {
            this._saveBrushSettingsTimeout = setTimeout(scheduleIdleFlush, 400);
            return;
        }
        if (typeof requestIdleCallback === 'function') {
            this._saveBrushSettingsIdleId = requestIdleCallback(flush, { timeout: 900 });
        } else {
            flush();
        }
    };
    if (immediate) {
        flush();
    } else {
        this._brushSettingsDirty = true;
        this._saveBrushSettingsTimeout = setTimeout(scheduleIdleFlush, 260);
    }
  }

  saveCurrentTipPreset() {
    if (!this.activeTool) return null;
    const tipSettings = this.getCurrentTipSettings();
    if (this.activeTool === TOOLS.FLUID && tipSettings) {
        syncFluidSettingsFromTip(tipSettings);
    }
    if (this.activeTool === TOOLS.AIR && tipSettings) {
        syncAirSettingsFromTip(tipSettings);
    }
    if (this.activeTool === TOOLS.SUMI && tipSettings) {
        syncSumiSettingsFromTip(tipSettings);
        syncSumiTip(this.engine);
    }
    this._dirtyTools.add(this.activeTool);
    this._saveBrushSettings(true);
    let tipBadge = 'MAIN #1';
    if (this.tipManager) {
        if (this.tipManager.activeBankIndex >= 0) {
            tipBadge = `MAIN #${this.tipManager.activeBankIndex + 1}`;
        } else if (this.tipManager.activeGeneratedIndex >= 0) {
            tipBadge = `GEN #${this.tipManager.activeGeneratedIndex + 1}`;
        }
    }
    this._status(`SAVED PRESET -> ${tipBadge}`);
    return tipBadge;
  }

  resetCurrentTipPreset() {
    if (!this.activeTool) return;
    let bankIdx = this.tipManager ? this.tipManager.activeBankIndex : 0;
    let genIdx = this.tipManager ? this.tipManager.activeGeneratedIndex : -1;
    if (bankIdx < 0 && genIdx < 0) bankIdx = 0;
    const tipId = bankIdx >= 0 ? `main-${bankIdx}` : `gen-${genIdx}`;

    const settings = this.brushSettings[this.activeTool];
    if (settings) {
        if (this.activeTool === TOOLS.SMUDGE) {
            settings.opacity = 1.0;
            settings.flow = 1.0;
            settings.pressureOpacityInfluence = 0.0;
        } else if (this.activeTool === TOOLS.WIREFRAME) {
            settings.size = 20;
            settings.opacity = 1.0;
            settings.flow = 1.0;
            settings.pressureOpacityInfluence = 0.0;
        } else if (this.activeTool === TOOLS.FLUID) {
            settings.size = 50;
            settings.flow = 1.0;
            settings.opacity = 1.0;
            settings.fluidity = 80;
            settings.bristles = 10;
            settings.fluidFlow = 100;
            settings.fluidVortex = 8;
            settings.fluidTurb = 8;
            settings.fluidRetention = 80;
            settings.fluidPickup = 80;
            settings.fluidDepth = 30;
            settings.fluidHeightShield = 65;
            settings.speedHeight = 0;
            settings.fluidGloss = 100;
            settings.fluidShading = true;
            settings.fluidFollowStroke = false;
            settings.fluidTipAngle = 0;
            settings.fluidBristleContrast = 65;
            settings.fluidBleed = 50;
            settings.fluidTipHardness = 50;
            settings.fluidPressureFlow = 35;
        } else if (this.activeTool === TOOLS.AIR) {
            settings.size = 70;
            settings.opacity = 0.55;
            settings.flow = 0.70;
            settings.speedWater = 0;
            settings.airWetness = 100;
            settings.airStreamFlow = 100;
            settings.airBloom = 50;
            settings.airEdge = 30;
            settings.airGranulation = 30;
            settings.airTipPour = 100;
            settings.airFollowStroke = false;
            settings.airTipAngle = 0;
            settings.airTipHardness = 55;
            settings.airPressureFlow = 35;
            settings.airUseHeightmap = false;
            settings.airHeightSource = 'surface';
        } else if (this.activeTool === TOOLS.SUMI) {
            settings.size = 40;
            settings.opacity = 1.0;
            settings.flow = 1.0;
            settings.pressureOpacityInfluence = 0.0;
            settings.speedWater = -45;
            settings.sumiMode = 'draw';
            settings.sumiInk = 78;
            settings.sumiInkAffection = 35;
            settings.sumiWater = 65;
            settings.sumiWaterWash = 75;
            settings.sumiEraserInk = 85;
            settings.sumiEraserWater = 25;
            settings.sumiBleed = 58;
            settings.sumiBristles = 28;
            settings.sumiStiffness = 60;
            settings.sumiSplit = 48;
            settings.sumiSpan = 550;
            settings.sumiGlue = 42;
            settings.sumiWarmth = 12;
            settings.sumiEvaporation = 28;
            settings.sumiCapillarity = 62;
            settings.sumiBackrun = 68;
            settings.sumiTurbulence = 0;
            settings.sumiSootSnag = 55;
            settings.sumiDeplete = true;
            settings.sumiSplitEnabled = true;
            settings.sumiTilt = true;
            settings.sumiAutoReDip = true;
            settings.sumiFollowStroke = false;
            settings.sumiTipAngle = 0;
            settings.sumiPressureFlow = 35;
            settings.sumiPressureGate = 20;
            settings.sumiMaxWater = 100;
            settings.sumiUseHeightmap = false;
            settings.sumiHeightSource = 'surface';
        }
        if (settings.tips && settings.tips[tipId]) {
            delete settings.tips[tipId];
        }
    }

    this._dirtyTools.add(this.activeTool);
    if (this.tipManager) {
        this.tipManager.refreshTip(false);
    } else {
        this._updateBrushSettingsUI(this.activeTool);
        this._saveBrushSettings(true);
    }
    this._status('TIP PRESET RESET');
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