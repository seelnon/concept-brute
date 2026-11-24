import { TOOLS, LAYERS_COUNT } from './constants.js';
import { syncFluidSettingsFromTip } from './tools/fluidPaint.js';
import { syncAirSettingsFromTip } from './tools/airPaint.js';
import { sumiSettings, syncSumiSettingsFromTip, updateSumiSubtoolUI, syncSumiTip, reDipSumi, forceDrySumi, stopSumiSimulation, clearSumiPores } from './tools/sumiPaint.js';
import { SURFACE_PRESETS } from './engine/canvasSurfaceGpu.js';

export function setupUI(app) {
    // Ensures keyboard hotkeys listen immediately when the user touches or interacts with the app
    document.addEventListener('pointerdown', (e) => {
        const targetEl = (e.target instanceof Element) ? e.target : null;
        if (!targetEl || !targetEl.closest('input, textarea, select')) {
            if (document.activeElement && document.activeElement !== document.body && document.activeElement.tagName !== 'SELECT') {
                document.activeElement.blur();
            }
            if (!document.hasFocus()) {
                window.focus();
            }
        }
        if (targetEl && targetEl.closest('button, [role="button"]')) {
            setTimeout(() => {
                if (document.activeElement && document.activeElement !== document.body && document.activeElement.tagName !== 'SELECT' && document.activeElement.type !== 'range') {
                    document.activeElement.blur();
                }
            }, 50);
        }
    });

    // Ensure buttons, sliders, checkboxes, and scrollable menus don't steal spacebar/hotkeys
    window.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isTextEntry = active && (
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'SELECT' ||
            active.isContentEditable ||
            (active.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(active.type))
        );
        if (!isTextEntry && (e.code === 'Space' || e.key === ' ' || e.keyCode === 32)) {
            e.preventDefault();
        }
        if (active && !isTextEntry && (
            active.tagName === 'BUTTON' ||
            active.type === 'range' ||
            active.type === 'checkbox' ||
            active.closest('.brutal-btn, .mini-btn, .tool-btn')
        )) {
            active.blur();
            window.focus();
        }
    }, { capture: true });

    // Toolbar buttons
    document.getElementById('btn-brush').onclick = () => app.setTool(TOOLS.BRUSH);
    document.getElementById('btn-eraser').onclick = () => app.setTool(TOOLS.ERASER);
    document.getElementById('btn-wireframe').onclick = () => app.setTool(TOOLS.WIREFRAME);
    document.getElementById('btn-lasso').onclick = () => app.setTool(TOOLS.LASSO);
    document.getElementById('btn-smudge').onclick = () => app.setTool(TOOLS.SMUDGE);
    document.getElementById('btn-liquify').onclick = () => app.setTool(TOOLS.LIQUIFY);
    document.getElementById('btn-fluid').onclick = () => app.setTool(TOOLS.FLUID);
    document.getElementById('btn-air').onclick = () => app.setTool(TOOLS.AIR);
    const btnSumi = document.getElementById('btn-sumi');
    if (btnSumi) btnSumi.onclick = () => app.setTool(TOOLS.SUMI);

    document.getElementById('btn-ref_move').onclick = () => app.setTool(TOOLS.REF_MOVE);
    document.getElementById('btn-save').onclick = () => {
        if (app.engine.isStatic) {
            app._status('SAVING CODES TO INDEXED-DB...');
            import('./projectManager.js').then(module => {
                module.saveProject(app).then(() => {
                    const rect = {
                        x: app.engine.isStatic ? -app.engine.staticWidth / 2 : 0,
                        y: app.engine.isStatic ? -app.engine.staticHeight / 2 : 0,
                        w: app.engine.isStatic ? app.engine.staticWidth : 0,
                        h: app.engine.isStatic ? app.engine.staticHeight : 0
                    };
                    app._showExportModal(rect);
                    app._status('PROJECT SAVED - EXPORT READY');
                });
            });
        } else {
            app._startExportMode();
        }
    };

    document.getElementById('btn-undo').onclick = () => app.engine.undo();
    document.getElementById('btn-redo').onclick = () => app.engine.redo();
    const btnClear = document.getElementById('btn-clear');
    if (btnClear) {
        btnClear.dataset.state = 'idle';
        btnClear.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (btnClear.dataset.state === 'idle') {
                btnClear.dataset.state = 'confirm';
                btnClear.innerText = 'REALLY?';
                btnClear.style.backgroundColor = '#ff0000';
                btnClear.style.color = 'white';
                
                setTimeout(() => {
                    if (btnClear.dataset.state === 'confirm') {
                        btnClear.dataset.state = 'idle';
                        btnClear.innerText = 'Clear';
                        btnClear.style.backgroundColor = '';
                        btnClear.style.color = '';
                    }
                }, 3000);
            } else {
                app.engine.clear();
                app._status('CANVAS PURGED');
                btnClear.dataset.state = 'idle';
                btnClear.innerText = 'PURGED!';
                setTimeout(() => {
                    btnClear.innerText = 'Clear';
                    btnClear.style.backgroundColor = '';
                    btnClear.style.color = '';
                }, 1000);
            }
        });
    }
    document.getElementById('btn-fullscreen').onclick = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    };

    document.getElementById('btn-import').onclick = () => document.getElementById('file-import').click();
    document.getElementById('file-import').onchange = (e) => app._handleImport(e);

    // Settings
    app.settingsPanel = document.getElementById('panel-settings');
    document.getElementById('btn-settings').onclick = () => {
        app.settingsPanel.classList.toggle('hidden');
        if (!app.settingsPanel.classList.contains('hidden')) {
            if (!app._isSwitchingProject && !app._queuedSwitchId && !app._slotReadyTimer && app._projectSlotStates?.size > 0) {
                app._projectSlotStates.clear();
            }
            app._renderProjectList();
        }
        app._updateStorageStat();
    };
    document.getElementById('btn-close-settings').onclick = () => {
        app.settingsPanel.classList.add('hidden');
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        window.focus();
    };

    // Settings Tabs
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            const paneId = `tab-${tab.dataset.tab}`;
            document.getElementById(paneId).classList.add('active');
            
            if (tab.dataset.tab === 'data') app._updateStorageStat();
            if (tab.dataset.tab === 'projects') {
                if (!app._isSwitchingProject && !app._queuedSwitchId && !app._slotReadyTimer && app._projectSlotStates?.size > 0) {
                    app._projectSlotStates.clear();
                }
                app._renderProjectList();
            }
        };
    });

    document.getElementById('btn-project-new').onclick = (e) => {
        e.stopPropagation();
        const modal = document.getElementById('modal-new-project');
        modal.style.left = '50%';
        modal.style.top = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
        modal.style.right = 'auto';
        modal.style.bottom = 'auto';
        modal.classList.remove('hidden');
        // Reset inputs
        document.getElementById('new-project-mode').value = 'infinite';
        document.getElementById('new-project-static-dimensions').classList.add('hidden');
        // Reset/Sync quality value display
        const qualitySlider = document.getElementById('new-project-quality');
        document.getElementById('new-quality-val').innerText = qualitySlider.value;
    };

    document.getElementById('new-project-mode').onchange = (e) => {
        const dimPanel = document.getElementById('new-project-static-dimensions');
        if (e.target.value === 'static') {
            dimPanel.classList.remove('hidden');
        } else {
            dimPanel.classList.add('hidden');
        }
    };

    document.getElementById('btn-close-new-project').onclick = () => {
        document.getElementById('modal-new-project').classList.add('hidden');
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        window.focus();
    };

    document.getElementById('new-project-quality').oninput = (e) => {
        document.getElementById('new-quality-val').innerText = e.target.value;
    };

    document.getElementById('btn-create-project-final').onclick = () => {
        const name = document.getElementById('new-project-name').value || 'SKETCH';
        let id = 'prj_' + Date.now();
        while (app.projects.some(p => p.id === id)) {
            id = 'prj_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        }
        const chunkSize = parseInt(document.getElementById('new-project-chunk-size').value);
        const quality = parseFloat(document.getElementById('new-project-quality').value);
        const mode = document.getElementById('new-project-mode').value;
        const isStatic = (mode === 'static');
        const width = isStatic ? (parseInt(document.getElementById('new-project-width').value) || 2400) : 0;
        const height = isStatic ? (parseInt(document.getElementById('new-project-height').value) || 3600) : 0;
        const dpi = isStatic ? (parseInt(document.getElementById('new-project-dpi').value) || 300) : 300;
        
        const newProj = { 
            id, 
            name, 
            settings: { 
                chunkSize, 
                quality,
                isStatic,
                width,
                height,
                dpi: dpi,
                dpiScale: 1.0
            } 
        };
        app.projects.push(newProj);

        // Close modal immediately for instant visual response
        document.getElementById('modal-new-project').classList.add('hidden');
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        window.focus();

        // Switch with fast-path new project initialization & immediate slot visual in Settings
        app.switchProject(id, { isNewProject: true, projectsListDirty: true });
    };

    // Export Modal
    document.getElementById('btn-close-export').onclick = () => {
        app._endExportMode();
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        window.focus();
    };

    document.getElementById('export-scale').oninput = (e) => {
        document.getElementById('export-scale-val').innerText = `${e.target.value}%`;
        app._updateExportDimensions();
    };

    const updateDim = () => {
        if (document.getElementById('export-keep-ratio').checked) {
            app._updateExportDimensions(true);
        }
    };
    document.getElementById('export-width').oninput = updateDim;
    document.getElementById('export-height').oninput = updateDim;

    document.getElementById('btn-export-final').onclick = () => app._performExport();

    const btnResetUi = document.getElementById('btn-reset-ui');
    if (btnResetUi) {
        btnResetUi.onclick = () => {
            if (typeof app.resetUILayout === 'function') {
                app.resetUILayout();
                app._status('UI RESET TO VIEW');
            }
        };
    }

    let resetClicks = 0;
    document.getElementById('btn-clear-storage').onclick = async (e) => {
        resetClicks++;
        if (resetClicks === 1) {
            e.target.innerText = 'ARE YOU SURE?';
            e.target.style.background = '#ff0000';
        } else if (resetClicks === 2) {
            e.target.innerText = 'TRULY SURE?';
            e.target.style.background = '#880000';
        } else if (resetClicks === 3) {
            app._status('WIPING DATA...');
            await app.storage.clearDatabase();
            localStorage.clear();
            location.reload();
        }
        
        // Reset timer
        setTimeout(() => {
            if (resetClicks < 3) {
                resetClicks = 0;
                e.target.innerText = 'RESET SYSTEM';
                e.target.style.background = '#ff4444';
            }
        }, 3000);
    };

    // Static settings update triggers
    document.getElementById('btn-apply-static-settings').onclick = async () => {
        const wVal = parseInt(document.getElementById('settings-static-width').value);
        const hVal = parseInt(document.getElementById('settings-static-height').value);
        const dpiVal = 1.0; // Standard 1:1 pixel coordinates for absolute precision and stability

        if (isNaN(wVal) || wVal < 100 || wVal > 15000 || isNaN(hVal) || hVal < 100 || hVal > 15000) {
            app._status('LIMIT REACHED: 100 - 15000 PX');
            return;
        }

        const currentW = app.engine.staticWidth;
        const currentH = app.engine.staticHeight;
        const currentDpi = app.engine.dpiScale || 1.0;

        if (wVal === currentW && hVal === currentH && dpiVal === currentDpi) {
            app._status('NO CHANGES MADE');
            return;
        }

        // Apply settings & upscale/extend artwork
        app._status('RECONFIGURING CANVAS...');
        
        const preserveArtwork = document.getElementById('settings-static-preserve') ? document.getElementById('settings-static-preserve').checked : true;

        // Find static chunk
        if (app.engine && app.engine.flushPendingGpuCommits) {
            app.engine.flushPendingGpuCommits();
        }
        const chunk = app.engine.chunks.get("0,0");
        const backups = [];

        if (chunk) {
            for (let l = 0; l < 4; l++) {  // LAYERS_COUNT (4)
                const backup = document.createElement('canvas');
                backup.width = chunk.canvases[l].width;
                backup.height = chunk.canvases[l].height;
                backup.getContext('2d').drawImage(chunk.canvases[l], 0, 0);
                backups.push(backup);
            }
        }

        app.engine.staticWidth = wVal;
        app.engine.staticHeight = hVal;
        app.engine.dpiScale = dpiVal;

        // Update in global projects list
        const project = app.projects.find(p => p.id === app.currentProjectId);
        if (project) {
            if (!project.settings) project.settings = {};
            project.settings.width = wVal;
            project.settings.height = hVal;
            project.settings.dpiScale = dpiVal;
            await app.storage.saveGlobalSetting('projects_list', app.projects);
        }

        // Reconfigure chunk canvases
        if (chunk) {
            chunk.width = wVal;
            chunk.height = hVal;

            for (let l = 0; l < 4; l++) {
                const canv = chunk.canvases[l];
                canv.width = wVal * dpiVal;
                canv.height = hVal * dpiVal;

                const ctx = chunk.ctxs[l];
                ctx.restore(); // Clear any existing scales
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canv.width, canv.height);
                
                // Draw backup
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                
                if (preserveArtwork) {
                    // Rescale artwork to fit new coordinates
                    ctx.drawImage(backups[l], 0, 0, backups[l].width, backups[l].height, 0, 0, canv.width, canv.height);
                } else {
                    // Center the artwork: if the canvas is made smaller, it trims evenly on all sides. If made larger, it adds padding evenly on all sides.
                    const dx = Math.round((canv.width - backups[l].width) / 2);
                    const dy = Math.round((canv.height - backups[l].height) / 2);
                    ctx.drawImage(backups[l], dx, dy);
                }

                if (dpiVal !== 1) {
                    ctx.scale(dpiVal, dpiVal);
                }
            }

            // Reconstruct strokeCanvas
            const sCanv = chunk.strokeCanvas;
            sCanv.width = wVal * dpiVal;
            sCanv.height = hVal * dpiVal;
            
            const sCtx = sCanv.getContext('2d', { alpha: true });
            sCtx.setTransform(1, 0, 0, 1, 0, 0);
            sCtx.clearRect(0, 0, sCanv.width, sCanv.height);
            if (dpiVal !== 1) {
                sCtx.scale(dpiVal, dpiVal);
            }
            chunk.strokeCtx = sCtx;
        }

        // Release backup canvas GPU memory immediately
        for (const backup of backups) {
            backup.width = 1;
            backup.height = 1;
        }

        // Reset undo stack since coordinate/backing store size differs
        app.engine.history = [];
        app.engine.redoStack = [];

        // Reposition Board
        if (app.engine.setupBoard) {
            app.engine.setupBoard();
        }

        // Recenter
        app.engine.refresh();
        app.engine.fitZoom();
        app._updateStorageStat();
        
        // Final Save-Out
        if (app.save) {
            await app.save();
        }

        app._status('CANVAS RECONFIGURED!');
    };

    // Linked Aspect Ratio handlers
    const staticWInput = document.getElementById('settings-static-width');
    const staticHInput = document.getElementById('settings-static-height');
    const staticAspectCheck = document.getElementById('settings-static-aspect');

    if (staticWInput && staticHInput) {
        staticWInput.oninput = (e) => {
            if (!staticAspectCheck || !staticAspectCheck.checked) return;
            const newW = parseInt(e.target.value);
            if (isNaN(newW) || newW <= 0) return;
            const currentRatio = app.engine.staticWidth / app.engine.staticHeight;
            if (currentRatio && !isNaN(currentRatio)) {
                staticHInput.value = Math.round(newW / currentRatio);
            }
        };

        staticHInput.oninput = (e) => {
            if (!staticAspectCheck || !staticAspectCheck.checked) return;
            const newH = parseInt(e.target.value);
            if (isNaN(newH) || newH <= 0) return;
            const currentRatio = app.engine.staticWidth / app.engine.staticHeight;
            if (currentRatio && !isNaN(currentRatio)) {
                staticWInput.value = Math.round(newH * currentRatio);
            }
        };
    }

    const updateProjectSetting = async (key, val) => {
        const project = app.projects.find(p => p.id === app.currentProjectId);
        if (project) {
            if (!project.settings) project.settings = {};
            project.settings[key] = val;
            await app.storage.saveGlobalSetting('projects_list', app.projects);
        }
    };

    let gridSaveTimeout = null;
    const queueGridSettingsSave = () => {
        if (gridSaveTimeout) clearTimeout(gridSaveTimeout);
        const runGridSave = async () => {
            gridSaveTimeout = null;
            if (app._shouldDeferSettingsSave?.() || app.engine?.isDrawing) {
                gridSaveTimeout = setTimeout(scheduleGridIdle, 600);
                return;
            }
            await app.storage.saveSetting('canvasBg', app.engine.canvasBg);
            await app.storage.saveSetting('gridColor', app.engine.gridColor);
            await app.storage.saveSetting('gridPattern', app.engine.gridPattern);
            await app.storage.saveSetting('gridSize', app.engine.gridSize);
            await app.storage.saveSetting('gridThickness', app.engine.gridThickness);
            await app.storage.saveSetting('gridIntensity', Math.round(app.engine.gridIntensity * 100));
            await app.storage.saveSetting('showGrid', app.engine.showGrid);

            const project = app.projects.find(p => p.id === app.currentProjectId);
            if (project) {
                if (!project.settings) project.settings = {};
                project.settings.canvasBg = app.engine.canvasBg;
                project.settings.gridColor = app.engine.gridColor;
                project.settings.gridPattern = app.engine.gridPattern;
                project.settings.gridSize = app.engine.gridSize;
                project.settings.gridThickness = app.engine.gridThickness;
                project.settings.gridIntensity = Math.round(app.engine.gridIntensity * 100);
                project.settings.showGrid = app.engine.showGrid;
                await app.storage.saveGlobalSetting('projects_list', app.projects);
            }
        };
        const scheduleGridIdle = () => {
            if (app._shouldDeferSettingsSave?.() || app.engine?.isDrawing) {
                gridSaveTimeout = setTimeout(scheduleGridIdle, 600);
                return;
            }
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => { runGridSave(); }, { timeout: 1500 });
            } else {
                runGridSave();
            }
        };
        gridSaveTimeout = setTimeout(scheduleGridIdle, 850);
    };

    // Original Settings inputs
    document.getElementById('settings-bg-color').oninput = (e) => {
        app.engine.canvasBg = e.target.value;
        app.engine.refreshGrid();
    };
    document.getElementById('settings-bg-color').onchange = () => {
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-color').oninput = (e) => {
        app.engine.gridColor = e.target.value;
        app.engine.refreshGrid();
    };
    document.getElementById('settings-grid-color').onchange = () => {
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-pattern').onchange = (e) => {
        app.engine.gridPattern = e.target.value;
        app.engine.refreshGrid();
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-size').oninput = (e) => {
        const val = parseInt(e.target.value);
        app.engine.gridSize = val;
        document.getElementById('grid-size-val').innerText = `${val}px`;
        app.engine.refreshGrid();
    };
    document.getElementById('settings-grid-size').onchange = () => {
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-thickness').oninput = (e) => {
        const val = parseFloat(e.target.value);
        app.engine.gridThickness = val;
        document.getElementById('grid-thickness-val').innerText = `${val}px`;
        app.engine.refreshGrid();
    };
    document.getElementById('settings-grid-thickness').onchange = () => {
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-intensity').oninput = (e) => {
        const val = parseInt(e.target.value);
        app.engine.gridIntensity = val / 100;
        document.getElementById('grid-intensity-val').innerText = `${val}%`;
        app.engine.refreshGrid();
    };
    document.getElementById('settings-grid-intensity').onchange = () => {
        queueGridSettingsSave();
    };
    document.getElementById('settings-grid-show').onchange = (e) => {
        app.engine.showGrid = e.target.checked;
        app.engine.refreshGrid();
        queueGridSettingsSave();
    };

    // CANVAS SURFACE TEXTURE (Fluid & Air/Watercolor physics + background tile)
    let surfaceSaveTimeout = null;
    const queueSurfaceSettingsSave = () => {
        if (surfaceSaveTimeout) clearTimeout(surfaceSaveTimeout);
        const runSurfaceSave = async () => {
            surfaceSaveTimeout = null;
            if (!app.engine?.surfaceManager) return;
            if (app._shouldDeferSettingsSave?.() || app.engine?.isDrawing) {
                surfaceSaveTimeout = setTimeout(scheduleSurfaceIdle, 600);
                return;
            }
            const serialized = app.engine.surfaceManager.serialize();
            await app.storage.saveSetting('canvasSurface', serialized);
            await updateProjectSetting('canvasSurface', serialized);
        };
        const scheduleSurfaceIdle = () => {
            if (app._shouldDeferSettingsSave?.() || app.engine?.isDrawing) {
                surfaceSaveTimeout = setTimeout(scheduleSurfaceIdle, 600);
                return;
            }
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => { runSurfaceSave(); }, { timeout: 1500 });
            } else {
                runSurfaceSave();
            }
        };
        surfaceSaveTimeout = setTimeout(scheduleSurfaceIdle, 900);
    };

    let surfacePreviewMode = 'albedo'; // 'albedo' | 'height' | 'pores'
    const surfaceTypeEl = document.getElementById('settings-surface-type');
    const surfaceBoxEl = document.getElementById('surface-controls-box');
    const surfacePreviewEl = document.getElementById('surface-preview-canvas');
    const surfacePreviewBtn = document.getElementById('btn-surface-preview-mode');
    const surfaceRegenBtn = document.getElementById('btn-surface-regen');
    const surfaceUploadBtn = document.getElementById('btn-surface-upload');
    const surfaceFileInput = document.getElementById('input-surface-file');
    const surfaceInfoEl = document.getElementById('surface-gen-info');
    const surfaceHintEl = document.getElementById('surface-preset-hint');
    const surfaceSeamlessEl = document.getElementById('settings-surface-seamless');
    const surfaceInvertEl = document.getElementById('settings-surface-invert');
    const surfaceScaleEl = document.getElementById('settings-surface-scale');
    const surfaceBiomeEl = document.getElementById('settings-surface-biome');
    const surfaceSlipEl = document.getElementById('settings-surface-slip');
    const surfaceReliefEl = document.getElementById('settings-surface-relief');
    const surfaceChannelEl = document.getElementById('settings-surface-channel');
    const surfaceOpacityEl = document.getElementById('settings-surface-opacity');

    app.syncSurfaceUI = () => {
        const mgr = app.engine?.surfaceManager;
        if (!mgr) return;
        const pDef = SURFACE_PRESETS[mgr.type] || SURFACE_PRESETS.none;

        if (surfaceTypeEl) surfaceTypeEl.value = mgr.type || 'none';
        if (surfaceBoxEl) surfaceBoxEl.classList.toggle('hidden', mgr.type === 'none');
        if (surfaceSeamlessEl) surfaceSeamlessEl.checked = !!mgr.seamless;
        if (surfaceInvertEl) surfaceInvertEl.checked = !!mgr.invertHeight;

        if (surfaceScaleEl) {
            surfaceScaleEl.value = Math.round(mgr.scale || 340);
            const vEl = document.getElementById('surface-scale-val');
            if (vEl) vEl.innerText = `${Math.round(mgr.scale || 340)}px`;
        }
        if (surfaceBiomeEl) {
            const pct = Math.round((mgr.biomeMix ?? 0.88) * 100);
            surfaceBiomeEl.value = pct;
            const vEl = document.getElementById('surface-biome-val');
            if (vEl) vEl.innerText = `${pct}%`;
        }
        if (surfaceSlipEl) {
            const pct = Math.round((mgr.slip ?? 0.24) * 100);
            surfaceSlipEl.value = pct;
            const vEl = document.getElementById('surface-slip-val');
            if (vEl) vEl.innerText = `${pct}% SLIP`;
        }
        if (surfaceReliefEl) {
            const pct = Math.round((mgr.relief ?? 0.58) * 100);
            surfaceReliefEl.value = pct;
            const vEl = document.getElementById('surface-relief-val');
            if (vEl) vEl.innerText = `${pct}%`;
        }
        if (surfaceChannelEl) {
            const pct = Math.round((mgr.channel ?? 0.22) * 100);
            surfaceChannelEl.value = pct;
            const vEl = document.getElementById('surface-channel-val');
            if (vEl) vEl.innerText = `${pct}%`;
        }
        if (surfaceOpacityEl) {
            const pct = Math.round((mgr.bgOpacity ?? 0.62) * 100);
            surfaceOpacityEl.value = pct;
            const vEl = document.getElementById('surface-opacity-val');
            if (vEl) vEl.innerText = `${pct}%`;
        }
        if (surfacePreviewBtn) {
            surfacePreviewBtn.innerText = surfacePreviewMode === 'albedo'
                ? 'HEIGHTMAP'
                : (surfacePreviewMode === 'height' ? 'PORES' : 'ALBEDO');
        }
        if (surfaceRegenBtn) {
            surfaceRegenBtn.style.display = mgr.type === 'custom' ? 'none' : '';
        }
        if (surfaceSeamlessEl && surfaceSeamlessEl.closest('.settings-row')) {
            surfaceSeamlessEl.closest('.settings-row').style.display = mgr.type === 'custom' ? 'flex' : 'none';
        }
        if (surfaceInfoEl) {
            surfaceInfoEl.innerText = mgr.isActive
                ? `${mgr.width}x${mgr.height} TILE • ${mgr.lastGenMs}ms`
                : 'FLAT SURFACE';
        }
        if (surfaceHintEl) {
            surfaceHintEl.innerText = pDef.hint || '';
        }
        if (surfacePreviewEl && mgr.isActive) {
            let srcCanvas = mgr.getColorCanvas();
            if (surfacePreviewMode === 'height') {
                srcCanvas = mgr.getHeightCanvas();
            } else if (surfacePreviewMode === 'pores') {
                srcCanvas = (typeof mgr.getPoreCanvas === 'function' ? mgr.getPoreCanvas() : null) || mgr.getHeightCanvas();
            }
            if (srcCanvas) {
                const pCtx = surfacePreviewEl.getContext('2d');
                pCtx.clearRect(0, 0, surfacePreviewEl.width, surfacePreviewEl.height);
                pCtx.drawImage(srcCanvas, 0, 0, surfacePreviewEl.width, surfacePreviewEl.height);
            }
        }
    };

    if (surfaceTypeEl) {
        surfaceTypeEl.onchange = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const val = e.target.value;
            if (val === 'custom' && !mgr._customImage && !mgr.customDataUrl) {
                surfaceFileInput?.click();
            }
            mgr.applyPresetDefaults(val);
            app.syncSurfaceUI();
            app.engine.refreshGrid();
            queueSurfaceSettingsSave();
        };
    }

    if (surfaceUploadBtn && surfaceFileInput) {
        surfaceUploadBtn.onclick = () => {
            surfaceFileInput.value = '';
            surfaceFileInput.click();
        };
        surfaceFileInput.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file || !app.engine?.surfaceManager) return;
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                try {
                    // Store a compressed <= 512px dataUrl so localStorage & project reloads stay small/fast
                    const maxDim = 512;
                    const c = document.createElement('canvas');
                    c.width = Math.min(maxDim, Math.max(64, img.width || maxDim));
                    c.height = Math.min(maxDim, Math.max(64, img.height || maxDim));
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, c.width, c.height);
                    const compactUrl = c.toDataURL('image/jpeg', 0.86);
                    app.engine.surfaceManager.setCustomImage(c, compactUrl);
                    app.syncSurfaceUI();
                    app.engine.refreshGrid();
                    queueSurfaceSettingsSave();
                } finally {
                    URL.revokeObjectURL(url);
                }
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
            };
            img.src = url;
        };
    }

    if (surfacePreviewBtn) {
        surfacePreviewBtn.onclick = () => {
            surfacePreviewMode = surfacePreviewMode === 'albedo'
                ? 'height'
                : (surfacePreviewMode === 'height' ? 'pores' : 'albedo');
            app.syncSurfaceUI();
        };
    }

    if (surfaceRegenBtn) {
        surfaceRegenBtn.onclick = () => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            mgr.seed = ((mgr.seed || 1337) + 97) % 100000;
            mgr.rebuild();
            app.syncSurfaceUI();
            app.engine.refreshGrid();
            queueSurfaceSettingsSave();
        };
    }

    if (surfaceSeamlessEl) {
        surfaceSeamlessEl.onchange = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            mgr.seamless = !!e.target.checked;
            mgr.rebuild();
            app.syncSurfaceUI();
            app.engine.refreshGrid();
            queueSurfaceSettingsSave();
        };
    }

    if (surfaceInvertEl) {
        surfaceInvertEl.onchange = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            mgr.invertHeight = !!e.target.checked;
            mgr.rebuild();
            app.syncSurfaceUI();
            app.engine.refreshGrid();
            queueSurfaceSettingsSave();
        };
    }

    if (surfaceScaleEl) {
        surfaceScaleEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            mgr.scale = parseInt(e.target.value, 10) || 340;
            const vEl = document.getElementById('surface-scale-val');
            if (vEl) vEl.innerText = `${mgr.scale}px`;
            app.engine.refreshGrid();
        };
        surfaceScaleEl.onchange = () => queueSurfaceSettingsSave();
    }

    if (surfaceBiomeEl) {
        surfaceBiomeEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const pct = parseInt(e.target.value, 10) || 0;
            mgr.biomeMix = pct / 100;
            const vEl = document.getElementById('surface-biome-val');
            if (vEl) vEl.innerText = `${pct}%`;
            app.engine.refreshGrid();
        };
        surfaceBiomeEl.onchange = () => queueSurfaceSettingsSave();
    }

    if (surfaceSlipEl) {
        surfaceSlipEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const pct = parseInt(e.target.value, 10) || 0;
            mgr.slip = pct / 100;
            const vEl = document.getElementById('surface-slip-val');
            if (vEl) vEl.innerText = `${pct}% SLIP`;
        };
        surfaceSlipEl.onchange = () => queueSurfaceSettingsSave();
    }

    if (surfaceReliefEl) {
        surfaceReliefEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const pct = parseInt(e.target.value, 10) || 0;
            mgr.relief = pct / 100;
            mgr.resist = Math.min(1, (pct / 100) * 0.95);
            const vEl = document.getElementById('surface-relief-val');
            if (vEl) vEl.innerText = `${pct}%`;
        };
        surfaceReliefEl.onchange = () => queueSurfaceSettingsSave();
    }

    if (surfaceChannelEl) {
        surfaceChannelEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const pct = parseInt(e.target.value, 10) || 0;
            mgr.channel = pct / 100;
            const vEl = document.getElementById('surface-channel-val');
            if (vEl) vEl.innerText = `${pct}%`;
        };
        surfaceChannelEl.onchange = () => queueSurfaceSettingsSave();
    }

    if (surfaceOpacityEl) {
        surfaceOpacityEl.oninput = (e) => {
            const mgr = app.engine?.surfaceManager;
            if (!mgr) return;
            const pct = parseInt(e.target.value, 10) || 0;
            mgr.bgOpacity = pct / 100;
            const vEl = document.getElementById('surface-opacity-val');
            if (vEl) vEl.innerText = `${pct}%`;
            app.engine.refreshGrid();
        };
        surfaceOpacityEl.onchange = () => queueSurfaceSettingsSave();
    }
    document.getElementById('settings-brush-spacing').oninput = (e) => {
        const val = parseFloat(e.target.value);
        app.updateActiveSetting('spacing', val);
    };

    const pressureEnable = document.getElementById('settings-pressure-enable');
    const pressureOpacityInf = document.getElementById('settings-pressure-opacity-influence');
    const pressureSizeInf = document.getElementById('settings-pressure-size-influence');

    if (pressureEnable) {
        pressureEnable.onchange = (e) => {
            app.updateActiveSetting('pressureEnabled', e.target.checked);
        };
    }

    if (pressureOpacityInf) {
        pressureOpacityInf.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const displayEl = document.getElementById('pressure-opacity-val');
            if (displayEl) displayEl.innerText = val.toFixed(1);
            app.updateActiveSetting('pressureOpacityInfluence', val);
        };
    }

    if (pressureSizeInf) {
        pressureSizeInf.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const displayEl = document.getElementById('pressure-size-val');
            if (displayEl) displayEl.innerText = val.toFixed(1);
            app.updateActiveSetting('pressureSizeInfluence', val);
        };
    }

    // Jitter sliders
    const jitterSizeInput = document.getElementById('settings-jitter-size');
    const jitterAngleInput = document.getElementById('settings-jitter-angle');
    const jitterPosInput = document.getElementById('settings-jitter-pos');
    const jitterHueInput = document.getElementById('settings-jitter-hue');

    if (jitterSizeInput) {
        jitterSizeInput.oninput = (e) => {
            const rawVal = parseFloat(e.target.value);
            const val = Math.round(app._mapSliderToPrecision(rawVal, 100));
            const valEl = document.getElementById('jitter-size-val');
            if (valEl) valEl.innerText = `${val}%`;
            app.updateActiveSetting('jitterSize', val, val / 100);
        };
    }
    if (jitterAngleInput) {
        jitterAngleInput.oninput = (e) => {
            const rawVal = parseFloat(e.target.value);
            const val = Math.round(app._mapSliderToPrecision(rawVal, 180));
            const valEl = document.getElementById('jitter-angle-val');
            if (valEl) valEl.innerText = `${val}°`;
            app.updateActiveSetting('jitterAngle', val, (val * Math.PI) / 180);
        };
    }
    if (jitterPosInput) {
        jitterPosInput.oninput = (e) => {
            const rawVal = parseFloat(e.target.value);
            const val = Math.round(app._mapSliderToPrecision(rawVal, 200));
            const valEl = document.getElementById('jitter-pos-val');
            if (valEl) valEl.innerText = `${val}%`;
            app.updateActiveSetting('jitterPos', val, val / 100);
        };
    }
    if (jitterHueInput) {
        jitterHueInput.oninput = (e) => {
            const rawVal = parseFloat(e.target.value);
            const val = Math.round(app._mapSliderToPrecision(rawVal, 100));
            const valEl = document.getElementById('jitter-hue-val');
            if (valEl) valEl.innerText = `${val}%`;
            app.updateActiveSetting('jitterHue', val, val / 100);
        };
    }

    // Zoom controls
    const ZOOM_LEVELS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.4, 0.5, 0.66, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0, 20.0, 24.0, 32.0, 40.0, 50.0];

    document.getElementById('btn-zoom-in').onclick = () => {
        const cur = app.engine.zoom;
        let nextZoom = ZOOM_LEVELS.find(z => z > cur + 0.005);
        if (nextZoom === undefined) nextZoom = cur * 1.2;
        app.engine.setZoom(nextZoom);
        app._updateZoomUI();
    };
    document.getElementById('btn-zoom-out').onclick = () => {
        const cur = app.engine.zoom;
        let prevZoom = [...ZOOM_LEVELS].reverse().find(z => z < cur - 0.005);
        if (prevZoom === undefined) prevZoom = cur / 1.2;
        app.engine.setZoom(prevZoom);
        app._updateZoomUI();
    };
    document.getElementById('btn-zoom-fit').onclick = () => {
        app.engine.fitZoom();
        app._updateZoomUI();
    };

    // Autosave inputs
    const autosaveSlider = document.getElementById('settings-autosave');
    const autosaveVal = document.getElementById('autosave-val');
    const autosaveEnable = document.getElementById('settings-autosave-enable');
    const btnForceSave = document.getElementById('btn-force-save');

    if (autosaveSlider) {
        autosaveSlider.oninput = (e) => {
            const parsed = Number(e.target.value);
            const v = Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
            // Exponential mapping: 4 * pow(300/4, v/100)
            const seconds = Math.round(4 * Math.pow(300 / 4, v / 100));
            app.autosaveDelay = seconds * 1000;
            if (autosaveVal) autosaveVal.innerText = `${seconds}s`;
            app.storage?.saveUiState('global_autosaveDelaySlider', v);
            app.storage?.saveSetting('autosaveDelaySlider', v);
        };
    }

    if (autosaveEnable) {
        autosaveEnable.onchange = (e) => {
            const checked = Boolean(e.target.checked);
            app.autosaveEnabled = checked;
            app.storage?.saveUiState('global_autosaveEnabled', checked);
            app.storage?.saveSetting('autosaveEnabled', checked);
            if (!app.autosaveEnabled) app._clearSaveTimer();
        };
    }

    if (btnForceSave) {
        btnForceSave.onclick = async () => {
            await app.save(true);
            app._status('FORCE SAVED');
            if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
            window.focus();
        };
    }

    // Palette
    app._renderPalette();

    // Layers
    const layerStack = document.getElementById('layer-stack');
    layerStack.innerHTML = '';
    // Reverse UI display: Index 3 at top, Index 0 at bottom
    // Index 0 is IMG REF, Indices 1-3 are PAINT LAYERS
    for (let i = LAYERS_COUNT - 1; i >= 0; i--) {
      const container = document.createElement('div');
      container.className = 'layer-item';
      if (i === app.engine.activeLayer) container.classList.add('active-layer');

      // Slim vertical line trigger on the LEFT of Paint layers (1..3) for Perceptual Color Correction
      if (i > 0) {
        const ccBtn = document.createElement('button');
        ccBtn.type = 'button';
        ccBtn.className = 'layer-color-btn';
        ccBtn.id = `layer-color-btn-${i}`;
        ccBtn.title = `Color Correction & Curves (Paint ${i})`;
        ccBtn.setAttribute('aria-label', `Color Correction Paint ${i}`);
        ccBtn.onclick = (e) => {
            e.stopPropagation();
            app.openLayerColorCorrection?.(i);
        };
        container.appendChild(ccBtn);
      }

      const btn = document.createElement('button');
      btn.className = 'layer-btn';
      btn.id = `layer-btn-${i}`;
      btn.innerHTML = i === 0 ? 'IMG REF' : `PAINT ${i}`;
      btn.onclick = () => app.setLayer(i);
      container.appendChild(btn);

      // Controls container
      const controls = document.createElement('div');
      controls.className = 'layer-controls';

      // Alpha Lock toggle for paint layers
      if (i > 0) {
        const lockBtn = document.createElement('button');
        lockBtn.className = 'layer-lock-btn';
        lockBtn.title = 'Alpha Lock';
        lockBtn.innerHTML = 'A';
        if (app.engine.layerSettings[i].alphaLock) lockBtn.classList.add('lock-active');
        lockBtn.onclick = (e) => {
            e.stopPropagation();
            app.engine.layerSettings[i].alphaLock = !app.engine.layerSettings[i].alphaLock;
            lockBtn.classList.toggle('lock-active');
        };
        controls.appendChild(lockBtn);
      }

      // Visibility Toggle for ALL layers
      const visBtn = document.createElement('button');
      visBtn.className = 'layer-vis-btn';
      visBtn.title = 'Toggle Visibility';
      
      const eyeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/></svg>`;
      const eyeOffIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
      
      visBtn.innerHTML = app.engine.layerSettings[i].visible ? eyeIcon : eyeOffIcon;
      if (!app.engine.layerSettings[i].visible) visBtn.classList.add('vis-hidden');
      
      visBtn.onclick = (e) => {
          e.stopPropagation();
          const newVis = !app.engine.layerSettings[i].visible;
          app.engine.setLayerVisibility(i, newVis);
          visBtn.innerHTML = newVis ? eyeIcon : eyeOffIcon;
          visBtn.classList.toggle('vis-hidden', !newVis);
      };
      controls.appendChild(visBtn);

      container.appendChild(controls);
      layerStack.appendChild(container);
    }
    app.engine.activeLayer = 2; // Default to second paint layer as requested

    const sizeSlider = document.getElementById('brush-size');
    const sizeVal = document.getElementById('size-val');
    sizeSlider.oninput = (e) => {
      const val = parseInt(e.target.value);
      const size = Math.round(app._mapSliderToSize(val));
      sizeVal.innerText = size;
      app.updateActiveSetting('size', size);
      if (app.engine) app.engine._updateBrushCursor();
    };

    const opacitySlider = document.getElementById('brush-opacity');
    const opacityVal = document.getElementById('opacity-val');
    if (opacitySlider) {
        opacitySlider.oninput = (e) => {
          const val = parseInt(e.target.value);
          opacityVal.innerText = `${val}%`;
          app.updateActiveSetting('opacity', val / 100);
        };
    }

    const flowSlider = document.getElementById('brush-flow');
    const flowVal = document.getElementById('flow-val');
    if (flowSlider) {
        flowSlider.oninput = (e) => {
          const val = parseInt(e.target.value);
          flowVal.innerText = `${val}%`;
          app.updateActiveSetting('flow', val / 100);
        };
    }

    const falloffSlider = document.getElementById('brush-falloff');
    const falloffVal = document.getElementById('falloff-val');
    if (falloffSlider) {
        falloffSlider.oninput = (e) => {
          const val = parseInt(e.target.value);
          if (falloffVal) falloffVal.innerText = `${val}%`;
          app.updateActiveSetting('falloff', val / 100);
          if (app.engine) app.engine._updateBrushCursor();
        };
    }

    const liqQualitySlider = document.getElementById('brush-liquify-quality');
    const liqQualityVal = document.getElementById('liquify-quality-val');
    if (liqQualitySlider) {
        const modeNames = { 1: 'FAST', 2: 'CRISP', 3: 'ULTRA' };
        const modeMsgs = {
            1: 'LIQUIFY MODE: FAST (MAX FPS, SOFTER ON ZOOM/REPEATS)',
            2: 'LIQUIFY MODE: CRISP (BICUBIC + 1:1 GRID + NO-BLUR SESSION)',
            3: 'LIQUIFY MODE: ULTRA (LANCZOS-3 NON-DESTRUCTIVE, SLOWER AT HUGE SIZE)'
        };
        liqQualitySlider.oninput = (e) => {
          const val = Math.max(1, Math.min(3, parseInt(e.target.value, 10) || 2));
          if (liqQualityVal) liqQualityVal.innerText = modeNames[val] || 'CRISP';
          app.updateActiveSetting('liquifyQuality', val);
          app.engine?.invalidateLiquifySession?.();
          app._status(modeMsgs[val]);
        };
    }


    const heightSlider = document.getElementById('brush-height');
    const heightVal = document.getElementById('height-val');
    if (heightSlider) {
        heightSlider.oninput = (e) => {
            const val = parseInt(e.target.value);
            heightVal.innerText = `${val}%`;
            app.updateActiveSetting('paintHeight', val / 100);
        };
    }

    const oilinessSlider = document.getElementById('brush-oiliness');
    const oilinessVal = document.getElementById('oiliness-val');
    if (oilinessSlider) {
        oilinessSlider.oninput = (e) => {
            const val = parseInt(e.target.value);
            oilinessVal.innerText = `${val}%`;
            app.updateActiveSetting('oiliness', val / 100);
        };
    }

    const smudgeAlphaSlider = document.getElementById('brush-smudge-alpha');
    const smudgeAlphaVal = document.getElementById('smudge-alpha-val');
    const smudgeAlphaLabelRow = document.getElementById('smudge-alpha-label-row');
    const applySmudgeAlpha = (isOn) => {
        if (smudgeAlphaSlider) smudgeAlphaSlider.value = isOn ? '1' : '0';
        if (smudgeAlphaVal) smudgeAlphaVal.innerText = isOn ? 'ON' : 'OFF';
        app.updateActiveSetting('smudgeAlpha', isOn);
    };
    if (smudgeAlphaSlider) {
        smudgeAlphaSlider.oninput = (e) => {
            applySmudgeAlpha(parseInt(e.target.value, 10) >= 1);
        };
    }
    if (smudgeAlphaLabelRow) {
        smudgeAlphaLabelRow.onclick = () => {
            const cur = smudgeAlphaSlider ? (parseInt(smudgeAlphaSlider.value, 10) >= 1) : true;
            applySmudgeAlpha(!cur);
        };
    }

    const smudgePickupSlider = document.getElementById('brush-smudge-pickup');
    const smudgePickupVal = document.getElementById('smudge-pickup-val');
    if (smudgePickupSlider) {
        smudgePickupSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (smudgePickupVal) smudgePickupVal.innerText = val.toFixed(1);
            app.updateActiveSetting('smudgePickup', val);
        };
    }

    const airbrushSlider = document.getElementById('brush-airbrush');
    const airbrushVal = document.getElementById('airbrush-val');
    if (airbrushSlider) {
        airbrushSlider.oninput = (e) => {
            const val = parseInt(e.target.value);
            airbrushVal.innerText = `${val}%`;
            app.updateActiveSetting('airbrush', val / 100);
        };
    }

    const fluiditySlider = document.getElementById('slider-fluidity');
    const fluidityVal = document.getElementById('val-fluidity');
    if (fluiditySlider) {
        fluiditySlider.oninput = (e) => {
            const val = parseInt(e.target.value);
            if (fluidityVal) fluidityVal.innerText = `${val}%`;
            app.updateActiveSetting('fluidity', val);
        };
    }

    const bristlesSlider = document.getElementById('slider-bristles');
    const bristlesVal = document.getElementById('val-bristles');
    if (bristlesSlider) {
        bristlesSlider.oninput = (e) => {
            const val = parseInt(e.target.value);
            if (bristlesVal) bristlesVal.innerText = val;
            app.updateActiveSetting('bristles', val);
        };
    }

    // Speed Sliders - sensitivity tuning
    const sSize = document.getElementById('speed-size');
    const sOpac = document.getElementById('speed-opacity');
    const sVal = document.getElementById('speed-value');
    const sHue = document.getElementById('speed-hue');

    if (sSize) sSize.oninput = (e) => {
        const val = parseInt(e.target.value);
        const el = document.getElementById('s-size-val');
        if (el) el.innerText = e.target.value;
        app.updateActiveSetting('speedSize', val);
    };
    if (sOpac) sOpac.oninput = (e) => {
        const val = parseInt(e.target.value);
        const el = document.getElementById('s-opac-val');
        if (el) el.innerText = e.target.value;
        app.updateActiveSetting('speedOpacity', val);
    };
    if (sVal) sVal.oninput = (e) => {
        const val = parseInt(e.target.value);
        const el = document.getElementById('s-val-val');
        if (el) el.innerText = e.target.value;
        app.updateActiveSetting('speedValue', val);
    };
    if (sHue) sHue.oninput = (e) => {
        const val = parseInt(e.target.value);
        const el = document.getElementById('s-hue-val');
        if (el) el.innerText = e.target.value;
        app.updateActiveSetting('speedHue', val);
    };

    const sHeight = document.getElementById('speed-height');
    if (sHeight) sHeight.oninput = (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        const el = document.getElementById('s-height-val');
        if (el) el.innerText = String(val);
        app.updateActiveSetting('speedHeight', val);
    };

    const sWater = document.getElementById('speed-water');
    if (sWater) sWater.oninput = (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        const el = document.getElementById('s-water-val');
        if (el) el.innerText = String(val);
        app.updateActiveSetting('speedWater', val);
    };

    const speedMaxSlider = document.getElementById('adv-speed-max');
    const speedMaxVal = document.getElementById('adv-speed-max-val');
    if (speedMaxSlider) {
        speedMaxSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (speedMaxVal) speedMaxVal.innerText = val.toFixed(1);
            app.updateActiveSetting('speedMax', val);
        };
    }

    // Wire up speed sliders reset arrows to snap back to 0
    document.querySelectorAll('.slider-reset-arrow').forEach(btn => {
        btn.onclick = () => {
            const targetId = btn.getAttribute('data-target');
            const targetInput = document.getElementById(targetId);
            if (targetInput) {
                targetInput.value = 0;
                targetInput.dispatchEvent(new Event('input'));
            }
        };
    });

    // Draggable Panels
    app._makeDraggable(document.getElementById('panel-color'), document.getElementById('handle-color'));
    app._makeDraggable(document.getElementById('panel-images'), document.getElementById('handle-images'));
    app._makeDraggable(document.getElementById('panel-layers'), document.getElementById('handle-layers'));
    app._makeDraggable(document.getElementById('panel-recording'), document.getElementById('handle-recording'));
    app._makeDraggable(app.settingsPanel, document.getElementById('handle-settings'));
    app._makeDraggable(document.getElementById('panel-brush-tips'), document.getElementById('handle-brush-tips'));
    app._makeDraggable(document.getElementById('panel-advanced-brush'), document.getElementById('handle-advanced-brush'));
    app._makeDraggable(document.getElementById('panel-touch-shortcuts'), document.getElementById('handle-touch-shortcuts'));
    app._makeDraggable(document.getElementById('modal-new-project'), document.getElementById('handle-new-project'));
    app._makeDraggable(document.getElementById('modal-export'), document.getElementById('handle-export'));
    app._makeDraggable(document.getElementById('modal-ref-editor'), document.getElementById('handle-ref-editor'));
    const modalLayerColor = document.getElementById('modal-layer-color');
    const handleLayerColor = document.getElementById('handle-layer-color');
    if (modalLayerColor && handleLayerColor) {
        app._makeDraggable(modalLayerColor, handleLayerColor);
    }

    // Draggable Perf Monitor
    const perfPanel = document.getElementById('panel-perf-monitor');
    const perfHandle = document.getElementById('handle-perf-monitor');
    if (perfPanel && perfHandle) {
        app._makeDraggable(perfPanel, perfHandle);
    }

    // Perf Monitor settings panel wiring
    const btnOpenPerfFromSettings = document.getElementById('btn-open-perf-from-settings');
    if (btnOpenPerfFromSettings) btnOpenPerfFromSettings.onclick = () => app.perfMonitor?.show();

    const selPerfThresh = document.getElementById('settings-perf-thresh-select');
    if (selPerfThresh) {
        selPerfThresh.onchange = (e) => {
            const val = parseFloat(e.target.value) || 16.95;
            if (app.perfMonitor) app.perfMonitor.thresholdMs = val;
            const lbl = document.getElementById('settings-perf-thresh-label');
            if (lbl) lbl.innerText = `${val.toFixed(1)}ms`;
            const panelSelect = document.getElementById('perf-threshold-select');
            if (panelSelect) panelSelect.value = String(val);
        };
    }

    const checkPerfAutoOpen = document.getElementById('settings-perf-auto-open');
    if (checkPerfAutoOpen) {
        checkPerfAutoOpen.onchange = (e) => {
            if (app.perfMonitor) app.perfMonitor.autoOpenOnDrop = e.target.checked;
        };
    }

    const checkPerfPaintOnly = document.getElementById('settings-perf-paint-only');
    if (checkPerfPaintOnly) {
        checkPerfPaintOnly.onchange = (e) => {
            if (app.perfMonitor) app.perfMonitor.paintOnly = e.target.checked;
        };
    }

    const checkPerfPrewarm = document.getElementById('settings-perf-prewarm-tools');
    const checkPerfLoading = document.getElementById('settings-perf-loading-screen');

    if (typeof app._syncPerfPrewarmLockUI === 'function') {
        app._syncPerfPrewarmLockUI();
    }

    if (checkPerfLoading) {
        checkPerfLoading.onchange = (e) => {
            const loadingOn = !!e.target.checked;
            app._perfLoadingScreen = loadingOn;
            app.storage?.saveUiState('perf_loading_screen', loadingOn, true);
            try { localStorage.setItem('perf_loading_screen_hint', String(loadingOn)); } catch (_) {}

            if (loadingOn) {
                app._perfPrewarmTools = true;
                app.storage?.saveUiState('perf_prewarm_tools', true, true);
            }
            app._syncPerfPrewarmLockUI?.();

            if (loadingOn && !app._allToolsPrewarmed && typeof app.prewarmAllTools === 'function') {
                app.prewarmAllTools(false);
            }
        };
    }

    if (checkPerfPrewarm) {
        checkPerfPrewarm.onchange = (e) => {
            if (app._perfLoadingScreen) {
                e.target.checked = true;
                app._perfPrewarmTools = true;
                app._syncPerfPrewarmLockUI?.();
                return;
            }
            const enabled = !!e.target.checked;
            app._perfPrewarmTools = enabled;
            app.storage?.saveUiState('perf_prewarm_tools', enabled, true);
            if (enabled && !app._allToolsPrewarmed && typeof app.prewarmAllTools === 'function') {
                app.prewarmAllTools(false);
            }
        };
    }

    const btnPerfPrewarmNow = document.getElementById('btn-perf-prewarm-now');
    if (btnPerfPrewarmNow) {
        btnPerfPrewarmNow.onclick = () => {
            if (typeof app.prewarmAllTools === 'function') {
                app.prewarmAllTools(true);
            }
        };
    }

    const btnPerfTestDrop = document.getElementById('btn-perf-test-drop-settings');
    if (btnPerfTestDrop) {
        btnPerfTestDrop.onclick = () => app.perfMonitor?.simulateTestDrop();
    }

    // Toggle Touch Shortcuts Panel
    const toggleShortcutsBtn = document.getElementById('btn-toggle-shortcuts');
    const touchShortcutsPanel = document.getElementById('panel-touch-shortcuts');
    if (toggleShortcutsBtn && touchShortcutsPanel) {
        toggleShortcutsBtn.onclick = () => {
            const isHidden = touchShortcutsPanel.classList.toggle('hidden');
            if (isHidden) {
                toggleShortcutsBtn.classList.remove('active');
            } else {
                toggleShortcutsBtn.classList.add('active');
                // Sync current active brush size with the touch slider when opened
                const activeSizeSlider = document.getElementById('touch-brush-size');
                if (activeSizeSlider && app.activeTool) {
                    const currentSize = app.brushSettings[app.activeTool].size;
                    activeSizeSlider.value = app._mapSizeToSlider(currentSize);
                    const touchSizeValDisplay = document.getElementById('touch-size-val');
                    if (touchSizeValDisplay) touchSizeValDisplay.innerText = currentSize;
                }
            }
        };
    }

    const closeShortcutsBtn = document.getElementById('btn-close-shortcuts');
    if (closeShortcutsBtn && touchShortcutsPanel && toggleShortcutsBtn) {
        closeShortcutsBtn.onclick = () => {
            touchShortcutsPanel.classList.add('hidden');
            toggleShortcutsBtn.classList.remove('active');
        };
    }

    // Touch Tools Execution Hooks
    const btnTouchUndo = document.getElementById('btn-touch-undo');
    if (btnTouchUndo) {
        btnTouchUndo.onclick = () => {
            if (app.engine) app.engine.undo();
        };
    }

    const btnTouchRedo = document.getElementById('btn-touch-redo');
    if (btnTouchRedo) {
        btnTouchRedo.onclick = () => {
            if (app.engine) app.engine.redo();
        };
    }

    const btnTouchTransform = document.getElementById('btn-touch-transform');
    if (btnTouchTransform) {
        btnTouchTransform.onclick = () => {
            if (app.engine) {
                if (app.engine.activeSelectionPath) {
                    app.engine.startTransform();
                } else if (!app.engine.floatingSelection) {
                    app._status('SELECT WITH LASSO FIRST');
                    setTimeout(() => app._status(app.activeTool), 1500);
                }
            }
        };
    }

    const btnTouchApply = document.getElementById('btn-touch-apply');
    if (btnTouchApply) {
        btnTouchApply.onclick = () => {
            if (app.engine && app.engine.floatingSelection) {
                app.engine._applySelection();
            }
        };
    }

    const btnTouchDeselect = document.getElementById('btn-touch-deselect');
    if (btnTouchDeselect) {
        btnTouchDeselect.onclick = () => {
            if (app.engine) app.engine.clearSelection();
        };
    }

    const btnTouchDelete = document.getElementById('btn-touch-delete');
    if (btnTouchDelete) {
        btnTouchDelete.onclick = () => {
            if (app.engine) app.engine.deleteSelection();
        };
    }

    const btnTouchMirror = document.getElementById('btn-touch-mirror');
    if (btnTouchMirror) {
        btnTouchMirror.onclick = () => {
            if (app.engine) {
                if (app.engine.floatingSelection) {
                    app.engine.toggleFloatingSelectionMirrorX();
                } else if (app.activeTool === TOOLS.REF_MOVE && app.engine.selectedRefIndex !== -1) {
                    const ref = app.engine.referenceImages[app.engine.selectedRefIndex];
                    ref.mirrorX = !ref.mirrorX;
                    app.engine.refresh();
                    app._triggerAutoSave();
                } else {
                    app.engine.toggleMirror();
                }
            }
        };
    }

    const btnTouchPicker = document.getElementById('btn-touch-picker');
    if (btnTouchPicker) {
        btnTouchPicker.onclick = () => {
            if (app.activeTool === TOOLS.PICKER) {
                app.setTool(app.lastBrush || TOOLS.BRUSH);
            } else {
                app.setTool(TOOLS.PICKER);
            }
        };
    }

    const touchBrushSize = document.getElementById('touch-brush-size');
    if (touchBrushSize) {
        touchBrushSize.oninput = (e) => {
            const sliderVal = parseInt(e.target.value);
            const size = Math.round(app._mapSliderToSize(sliderVal));
            
            if (app.activeTool) {
                app.updateActiveSetting('size', size);
                
                // Sync main size inputs
                const mainSizeInput = document.getElementById('brush-size');
                if (mainSizeInput) mainSizeInput.value = sliderVal;
                const mainSizeVal = document.getElementById('size-val');
                if (mainSizeVal) mainSizeVal.innerText = size;
                
                const touchSizeValDisplay = document.getElementById('touch-size-val');
                if (touchSizeValDisplay) touchSizeValDisplay.innerText = size;
                
                if (app.engine) app.engine._updateBrushCursor();
            }
        };
    }

    const setupHoldButton = (btn, delta) => {
        let sizeTimeout = null;
        let sizeInterval = null;

        const startAdjusting = (e) => {
            e.preventDefault();
            app._adjSize(delta, true); // skip save on immediate click

            if (sizeTimeout) clearTimeout(sizeTimeout);
            sizeTimeout = setTimeout(() => {
                if (sizeInterval) clearInterval(sizeInterval);
                sizeInterval = setInterval(() => {
                    app._adjSize(delta, true); // skip save on repeat
                }, 30);
            }, 250);
        };

        const stopAdjusting = (e) => {
            if (sizeTimeout) {
                clearTimeout(sizeTimeout);
                sizeTimeout = null;
            }
            if (sizeInterval) {
                clearInterval(sizeInterval);
                sizeInterval = null;
            }
            app._saveBrushSettings(); // Save once at the end of holding or clicking
        };

        btn.addEventListener('pointerdown', startAdjusting);
        btn.addEventListener('pointerup', stopAdjusting);
        btn.addEventListener('pointercancel', stopAdjusting);
        btn.addEventListener('pointerleave', stopAdjusting);
    };

    const btnTouchSizeDown = document.getElementById('btn-touch-size-down');
    if (btnTouchSizeDown) {
        setupHoldButton(btnTouchSizeDown, -5);
    }

    const btnTouchSizeUp = document.getElementById('btn-touch-size-up');
    if (btnTouchSizeUp) {
        setupHoldButton(btnTouchSizeUp, 5);
    }

    document.getElementById('btn-advanced-brush').onclick = () => {
        document.getElementById('panel-advanced-brush').classList.toggle('hidden');
    };
    document.getElementById('btn-close-advanced-brush').onclick = () => {
        document.getElementById('panel-advanced-brush').classList.add('hidden');
    };

    const smudgeBoostInput = document.getElementById('adv-smudge-flow-boost');
    if (smudgeBoostInput) {
        smudgeBoostInput.oninput = (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('adv-smudge-flow-boost-val').innerText = val.toFixed(1);
            app.updateActiveSetting('smudgeFlowBoost', val);
        };
    }

    const sharpenInput = document.getElementById('adv-brush-sharpen');
    if (sharpenInput) {
        sharpenInput.oninput = (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('adv-brush-sharpen-val').innerText = val.toFixed(2);
            app.updateActiveSetting('brushSharpen', val);
        };
    }

    // Wireframe Settings
    const wireDensityInput = document.getElementById('adv-wire-density');
    if (wireDensityInput) {
        wireDensityInput.oninput = (e) => {
            const val = parseInt(e.target.value);
            document.getElementById('adv-wire-density-val').innerText = val;
            app.updateActiveSetting('wireDensity', val);
        };
    }

    const wireRangeInput = document.getElementById('adv-wire-range');
    if (wireRangeInput) {
        wireRangeInput.oninput = (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('adv-wire-range-val').innerText = val.toFixed(1);
            app.updateActiveSetting('wireRange', val);
        };
    }

    const wireMinDistInput = document.getElementById('adv-wire-min-dist');
    if (wireMinDistInput) {
        wireMinDistInput.oninput = (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('adv-wire-min-dist-val').innerText = val.toFixed(1);
            app.updateActiveSetting('wireMinDist', val);
        };
    }

    // Air Paint (Watercolor Navier-Stokes & Tip Pour/Draw) Sliders
    const syncAirLive = () => {
        if (app.getCurrentTipSettings) {
            const ts = app.getCurrentTipSettings();
            if (ts) syncAirSettingsFromTip(ts);
        }
        if (app.engine && app.engine._updateBrushCursor) {
            app.engine._updateBrushCursor();
        }
    };

    const bindAirSlider = (inputId, valId, settingKey, unit = '%') => {
        const el = document.getElementById(inputId);
        if (!el) return;
        el.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById(valId);
            if (valEl) valEl.innerText = `${Math.round(val)}${unit}`;
            app.updateActiveSetting(settingKey, val);
            syncAirLive();
        };
    };

    bindAirSlider('adv-air-wetness', 'adv-air-wetness-val', 'airWetness', '%');
    bindAirSlider('adv-air-stream', 'adv-air-stream-val', 'airStreamFlow', '%');
    bindAirSlider('adv-air-bloom', 'adv-air-bloom-val', 'airBloom', '%');
    bindAirSlider('adv-air-edge', 'adv-air-edge-val', 'airEdge', '%');
    bindAirSlider('adv-air-granulation', 'adv-air-granulation-val', 'airGranulation', '%');

    const applyAirTipPour = (rawVal) => {
        const val = Math.max(0, Math.min(100, Math.round(parseFloat(rawVal) || 0)));
        const advSlider = document.getElementById('adv-air-tip-pour');
        const advLbl = document.getElementById('adv-air-tip-pour-val');
        const panelSlider = document.getElementById('slider-air-tip-pour');
        const panelLbl = document.getElementById('air-tip-pour-val');
        if (advSlider) advSlider.value = val;
        if (advLbl) advLbl.innerText = `${val}%`;
        if (panelSlider) panelSlider.value = val;
        if (panelLbl) panelLbl.innerText = `${val}%`;

        const btnDraw = document.getElementById('btn-air-mode-draw');
        const btnMix = document.getElementById('btn-air-mode-mix');
        const btnPour = document.getElementById('btn-air-mode-pour');
        if (btnDraw && btnMix && btnPour) {
            btnDraw.classList.toggle('active-btn', val <= 12);
            btnMix.classList.toggle('active-btn', val > 12 && val < 65);
            btnPour.classList.toggle('active-btn', val >= 65);
        }

        app.updateActiveSetting('airTipPour', val);
        syncAirLive();
    };

    const advAirPourInput = document.getElementById('adv-air-tip-pour');
    if (advAirPourInput) {
        advAirPourInput.oninput = (e) => applyAirTipPour(e.target.value);
    }
    const panelAirPourInput = document.getElementById('slider-air-tip-pour');
    if (panelAirPourInput) {
        panelAirPourInput.oninput = (e) => applyAirTipPour(e.target.value);
    }
    const btnAirModeDraw = document.getElementById('btn-air-mode-draw');
    if (btnAirModeDraw) btnAirModeDraw.onclick = () => applyAirTipPour(0);
    const btnAirModeMix = document.getElementById('btn-air-mode-mix');
    if (btnAirModeMix) btnAirModeMix.onclick = () => applyAirTipPour(35);
    const btnAirModePour = document.getElementById('btn-air-mode-pour');
    if (btnAirModePour) btnAirModePour.onclick = () => applyAirTipPour(85);

    const advAirFollow = document.getElementById('adv-air-follow-stroke');
    if (advAirFollow) {
        advAirFollow.onchange = (e) => {
            app.updateActiveSetting('airFollowStroke', e.target.checked);
            syncAirLive();
        };
    }

    bindAirSlider('adv-air-tip-angle', 'adv-air-tip-angle-val', 'airTipAngle', '°');
    bindAirSlider('adv-air-tip-hardness', 'adv-air-tip-hardness-val', 'airTipHardness', '%');
    bindAirSlider('adv-air-pressure-flow', 'adv-air-pressure-flow-val', 'airPressureFlow', '%');

    const syncAirHeightUi = (useH, src) => {
        const chkPanel = document.getElementById('chk-air-use-heightmap');
        const chkAdv = document.getElementById('adv-air-use-heightmap');
        const btnPanel = document.getElementById('btn-air-height-source');
        const btnAdv = document.getElementById('adv-air-height-source');
        const label = src === 'layer' ? 'LAYER' : 'SURFACE';
        if (chkPanel) chkPanel.checked = !!useH;
        if (chkAdv) chkAdv.checked = !!useH;
        if (btnPanel) {
            btnPanel.innerText = label;
            btnPanel.style.opacity = useH ? '1' : '0.45';
        }
        if (btnAdv) {
            btnAdv.innerText = label;
            btnAdv.style.opacity = useH ? '1' : '0.45';
        }
    };

    const bindAirHeightToggle = (elId) => {
        const el = document.getElementById(elId);
        if (!el) return;
        el.onchange = (e) => {
            const checked = !!e.target.checked;
            const ts = app.getCurrentTipSettings ? app.getCurrentTipSettings() : null;
            const src = (ts && ts.airHeightSource) || 'surface';
            app.updateActiveSetting('airUseHeightmap', checked);
            syncAirHeightUi(checked, src);
            syncAirLive();
        };
    };
    bindAirHeightToggle('chk-air-use-heightmap');
    bindAirHeightToggle('adv-air-use-heightmap');

    const bindAirSourceBtn = (btnId) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.onclick = () => {
            const ts = app.getCurrentTipSettings ? app.getCurrentTipSettings() : null;
            const curSrc = (ts && ts.airHeightSource) || 'surface';
            const nextSrc = curSrc === 'layer' ? 'surface' : 'layer';
            const useH = !!(ts && ts.airUseHeightmap);
            app.updateActiveSetting('airHeightSource', nextSrc);
            syncAirHeightUi(useH, nextSrc);
            syncAirLive();
        };
    };
    bindAirSourceBtn('btn-air-height-source');
    bindAirSourceBtn('adv-air-height-source');

    const toggleCanvasPhysicalMix = (checked) => {
        app.palette.config.canvasMixMode = checked ? 'physical' : 'digital';
        app.palette.saveConfig();
        app.storage?.saveSetting('palette', app.palette.getSerializedState());
        app.syncCanvasMixMode?.();
        app.paletteStudio?.renderStudioControls();
        app._status(checked ? 'CANVAS PAINT MIX: PHYSICAL RYB (Y+B=G)' : 'CANVAS PAINT MIX: DIGITAL RGB');
    };

    const chkAirPhysicalMix = document.getElementById('chk-air-physical-mix');
    if (chkAirPhysicalMix) {
        chkAirPhysicalMix.onchange = (e) => toggleCanvasPhysicalMix(!!e.target.checked);
    }

    const chkFluidPhysicalMix = document.getElementById('chk-fluid-physical-mix');
    if (chkFluidPhysicalMix) {
        chkFluidPhysicalMix.onchange = (e) => toggleCanvasPhysicalMix(!!e.target.checked);
    }

    const chkSumiPhysicalMix = document.getElementById('chk-sumi-physical-mix');
    if (chkSumiPhysicalMix) {
        chkSumiPhysicalMix.onchange = (e) => toggleCanvasPhysicalMix(!!e.target.checked);
    }

    // Sumi-e Ink & Paper Brush Controls
    const syncSumiLive = (rebuildTip = false) => {
        if (app.getCurrentTipSettings) {
            const ts = app.getCurrentTipSettings();
            if (ts) syncSumiSettingsFromTip(ts);
        }
        if (rebuildTip && app.engine) {
            syncSumiTip(app.engine);
        }
        if (app.engine && app.engine._updateBrushCursor) {
            app.engine._updateBrushCursor();
        }
    };

    const bindSumiSlider = (inputId, valId, settingKey, unit = '%', rebuildTip = false) => {
        const el = document.getElementById(inputId);
        if (!el) return;
        el.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById(valId);
            if (valEl) valEl.innerText = `${Math.round(val)}${unit}`;
            app.updateActiveSetting(settingKey, val);
            syncSumiLive(rebuildTip);
        };
    };

    const bindSumiCheck = (inputId, settingKey) => {
        const el = document.getElementById(inputId);
        if (!el) return;
        el.onchange = (e) => {
            app.updateActiveSetting(settingKey, !!e.target.checked);
            syncSumiLive(false);
        };
    };

    // Brush Textures sidebar Sumi sliders
    bindSumiSlider('brush-sumi-span', 'sumi-span-val', 'sumiSpan', 'px', false);
    bindSumiSlider('brush-sumi-bristles', 'sumi-bristles-val', 'sumiBristles', '', true);
    bindSumiSlider('brush-sumi-split', 'sumi-split-val', 'sumiSplit', '%', false);

    // Floating #panel-sumi sliders & subtools
    const sliderSumiInk = document.getElementById('slider-sumi-ink');
    if (sliderSumiInk) {
        sliderSumiInk.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById('val-sumi-ink');
            if (valEl) valEl.innerText = `${Math.round(val)}%`;
            let targetKey = 'sumiInk';
            if (sumiSettings.mode === 'water') targetKey = 'sumiInkAffection';
            else if (sumiSettings.mode === 'eraser') targetKey = 'sumiEraserInk';
            app.updateActiveSetting(targetKey, val);
            syncSumiLive(false);
        };
    }
    const sliderSumiWater = document.getElementById('slider-sumi-water');
    if (sliderSumiWater) {
        sliderSumiWater.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById('val-sumi-water');
            if (valEl) valEl.innerText = `${Math.round(val)}%`;
            let targetKey = 'sumiWater';
            if (sumiSettings.mode === 'water') targetKey = 'sumiWaterWash';
            else if (sumiSettings.mode === 'eraser') targetKey = 'sumiEraserWater';
            app.updateActiveSetting(targetKey, val);
            syncSumiLive(false);
        };
    }
    bindSumiSlider('slider-sumi-bleed', 'val-sumi-bleed', 'sumiBleed', '%', false);

    ['draw', 'water', 'blow', 'dry', 'eraser'].forEach(mode => {
        const btn = document.getElementById(`btn-sumi-mode-${mode}`);
        if (btn) {
            btn.onclick = () => {
                app.updateActiveSetting('sumiMode', mode);
                syncSumiLive(false);
                updateSumiSubtoolUI(mode);
                app._status(`SUMI MODE: ${mode.toUpperCase()}`);
            };
        }
    });

    const btnSumiAutoReDip = document.getElementById('btn-sumi-auto-redip');
    if (btnSumiAutoReDip) {
        btnSumiAutoReDip.onclick = () => {
            const ts = app.getCurrentTipSettings ? app.getCurrentTipSettings() : null;
            const nextVal = !(ts && ts.sumiAutoReDip !== undefined ? !!ts.sumiAutoReDip : true);
            app.updateActiveSetting('sumiAutoReDip', nextVal);
            syncSumiLive(false);
            btnSumiAutoReDip.classList.toggle('active-btn', nextVal);
            btnSumiAutoReDip.innerText = nextVal ? 'AUTO DIP' : 'MANUAL DIP';
        };
    }

    const btnSumiReDip = document.getElementById('btn-sumi-redip');
    if (btnSumiReDip) {
        btnSumiReDip.onclick = () => {
            if (app.engine) reDipSumi(app.engine);
            app._status('SUMI BRUSH RE-DIPPED');
        };
    }

    const btnSumiDryNow = document.getElementById('btn-sumi-dry-now');
    if (btnSumiDryNow) {
        btnSumiDryNow.onclick = () => {
            if (app.engine && forceDrySumi(app.engine)) {
                app._status('SUMI WASH HEAT-DRIED');
            }
        };
    }

    const btnSumiStop = document.getElementById('btn-sumi-stop');
    if (btnSumiStop) {
        btnSumiStop.onclick = () => {
            if (app.engine) stopSumiSimulation(app.engine);
            app._status('SUMI SIMULATION STOPPED (FULL DRY)');
        };
    }

    const btnSumiClearPores = document.getElementById('btn-sumi-clear-pores');
    if (btnSumiClearPores) {
        btnSumiClearPores.onclick = () => {
            if (app.engine) clearSumiPores(app.engine);
            app._status('SUMI FIBER / ALBEDO / PORES CLEARED');
        };
    }

    // Advanced Sumi-e Physics Controls
    bindSumiCheck('adv-sumi-deplete', 'sumiDeplete');
    bindSumiCheck('adv-sumi-split-enabled', 'sumiSplitEnabled');
    bindSumiCheck('adv-sumi-tilt', 'sumiTilt');
    bindSumiCheck('adv-sumi-follow-stroke', 'sumiFollowStroke');
    bindSumiSlider('adv-sumi-stiffness', 'adv-sumi-stiffness-val', 'sumiStiffness', '%', false);
    bindSumiSlider('adv-sumi-glue', 'adv-sumi-glue-val', 'sumiGlue', '%', false);
    bindSumiSlider('adv-sumi-warmth', 'adv-sumi-warmth-val', 'sumiWarmth', '', false);
    bindSumiSlider('adv-sumi-evaporation', 'adv-sumi-evaporation-val', 'sumiEvaporation', '%', false);
    bindSumiSlider('adv-sumi-capillarity', 'adv-sumi-capillarity-val', 'sumiCapillarity', '%', false);
    bindSumiSlider('adv-sumi-backrun', 'adv-sumi-backrun-val', 'sumiBackrun', '%', false);
    bindSumiSlider('adv-sumi-turbulence', 'adv-sumi-turbulence-val', 'sumiTurbulence', '%', false);
    bindSumiSlider('adv-sumi-soot-snag', 'adv-sumi-soot-snag-val', 'sumiSootSnag', '%', false);
    bindSumiSlider('adv-sumi-tip-angle', 'adv-sumi-tip-angle-val', 'sumiTipAngle', '°', false);
    bindSumiSlider('adv-sumi-pressure-flow', 'adv-sumi-pressure-flow-val', 'sumiPressureFlow', '%', false);
    bindSumiSlider('adv-sumi-pressure-gate', 'sumi-pressure-gate-val', 'sumiPressureGate', '%', false);
    bindSumiSlider('sumi-max-water', 'max-water-val', 'sumiMaxWater', '%', false);

    const syncSumiHeightUi = (useH, src) => {
        const chkPanel = document.getElementById('chk-sumi-use-heightmap');
        const chkAdv = document.getElementById('adv-sumi-use-heightmap');
        const btnPanel = document.getElementById('btn-sumi-height-source');
        const btnAdv = document.getElementById('adv-sumi-height-source');
        const label = src === 'layer' ? 'LAYER' : 'SURFACE';
        if (chkPanel) chkPanel.checked = !!useH;
        if (chkAdv) chkAdv.checked = !!useH;
        if (btnPanel) {
            btnPanel.innerText = label;
            btnPanel.style.opacity = useH ? '1' : '0.45';
        }
        if (btnAdv) {
            btnAdv.innerText = label;
            btnAdv.style.opacity = useH ? '1' : '0.45';
        }
    };

    const bindSumiHeightToggle = (elId) => {
        const el = document.getElementById(elId);
        if (!el) return;
        el.onchange = (e) => {
            const checked = !!e.target.checked;
            const ts = app.getCurrentTipSettings ? app.getCurrentTipSettings() : null;
            const src = (ts && ts.sumiHeightSource) || 'surface';
            app.updateActiveSetting('sumiUseHeightmap', checked);
            syncSumiHeightUi(checked, src);
            syncSumiLive(false);
        };
    };
    bindSumiHeightToggle('chk-sumi-use-heightmap');
    bindSumiHeightToggle('adv-sumi-use-heightmap');

    const bindSumiSourceBtn = (btnId) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.onclick = () => {
            const ts = app.getCurrentTipSettings ? app.getCurrentTipSettings() : null;
            const curSrc = (ts && ts.sumiHeightSource) || 'surface';
            const nextSrc = curSrc === 'layer' ? 'surface' : 'layer';
            const useH = !!(ts && ts.sumiUseHeightmap);
            app.updateActiveSetting('sumiHeightSource', nextSrc);
            syncSumiHeightUi(useH, nextSrc);
            syncSumiLive(false);
        };
    };
    bindSumiSourceBtn('btn-sumi-height-source');
    bindSumiSourceBtn('adv-sumi-height-source');

    // Advanced Fluid Paint Dynamics
    const bindAdvFluidSlider = (inputId, valId, settingKey, unit = '%') => {
        const el = document.getElementById(inputId);
        if (!el) return;
        el.oninput = (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById(valId);
            if (valEl) valEl.innerText = `${Math.round(val)}${unit}`;
            app.updateActiveSetting(settingKey, val);
            if (app.getCurrentTipSettings) {
                const ts = app.getCurrentTipSettings();
                if (ts) syncFluidSettingsFromTip(ts);
            }
        };
    };

    const advFluidFollow = document.getElementById('adv-fluid-follow-stroke');
    if (advFluidFollow) {
        advFluidFollow.onchange = (e) => {
            app.updateActiveSetting('fluidFollowStroke', e.target.checked);
            if (app.getCurrentTipSettings) {
                const ts = app.getCurrentTipSettings();
                if (ts) syncFluidSettingsFromTip(ts);
            }
        };
    }

    bindAdvFluidSlider('adv-fluid-tip-angle', 'adv-fluid-tip-angle-val', 'fluidTipAngle', '°');
    bindAdvFluidSlider('adv-fluid-bristle-contrast', 'adv-fluid-bristle-contrast-val', 'fluidBristleContrast', '%');
    bindAdvFluidSlider('adv-fluid-bleed', 'adv-fluid-bleed-val', 'fluidBleed', '%');
    bindAdvFluidSlider('adv-fluid-tip-hardness', 'adv-fluid-tip-hardness-val', 'fluidTipHardness', '%');
    bindAdvFluidSlider('adv-fluid-pressure-flow', 'adv-fluid-pressure-flow-val', 'fluidPressureFlow', '%');

    const wireSaveTipBtn = (btnId, defaultLabel) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.onclick = () => {
            if (app.saveCurrentTipPreset) {
                app.saveCurrentTipPreset();
                btn.innerText = 'SAVED ✓';
                setTimeout(() => {
                    btn.innerText = defaultLabel;
                }, 900);
            }
        };
    };

    const wireResetTipBtn = (btnId) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.onclick = () => {
            if (app.resetCurrentTipPreset) {
                app.resetCurrentTipPreset();
            }
        };
    };

    wireSaveTipBtn('btn-fluid-save-tip', 'SAVE TIP');
    wireResetTipBtn('btn-fluid-reset-tip');
    wireSaveTipBtn('btn-air-save-tip', 'SAVE TIP');
    wireResetTipBtn('btn-air-reset-tip');
    wireSaveTipBtn('btn-adv-save-tip', 'SAVE TO TIP');
    wireResetTipBtn('btn-adv-reset-tip');

    // --- TEXTURE PAINT (SCREENTONES) SYSTEM INTERACTION CONTROLS ---
    const toggleTextureBtn = document.getElementById('btn-toggle-texture');
    const textureSettingsPanel = document.getElementById('texture-settings');
    
    if (toggleTextureBtn && textureSettingsPanel) {
        toggleTextureBtn.onclick = () => {
            if (!app.engine) return;
            const isEnabled = !app.engine.textureModeEnabled;
            app.engine.textureModeEnabled = isEnabled;
            
            if (isEnabled) {
                toggleTextureBtn.classList.add('active');
                textureSettingsPanel.classList.remove('hidden');
                app._status("TEXTURE MODE: ON");
            } else {
                toggleTextureBtn.classList.remove('active');
                textureSettingsPanel.classList.add('hidden');
                app._status("TEXTURE MODE: OFF");
            }
        };
    }

    // Pattern selector button group
    const patternBtns = {
        dot: document.getElementById('btn-tex-dot'),
        square: document.getElementById('btn-tex-sq'),
        line: document.getElementById('btn-tex-line'),
        triangle: document.getElementById('btn-tex-tri')
    };

    Object.entries(patternBtns).forEach(([patternType, btn]) => {
        if (btn) {
            btn.onclick = () => {
                if (!app.engine) return;
                app.engine.texturePattern = patternType;
                
                // Toggle active visual states
                Object.values(patternBtns).forEach(b => {
                    if (b) b.classList.remove('active-btn');
                });
                btn.classList.add('active-btn');
                
                app._status(`PATTERN: ${patternType.toUpperCase()}`);
            };
        }
    });

    // Density range slider
    const texDensitySlider = document.getElementById('slider-tex-density');
    const texDensityVal = document.getElementById('tex-density-val');
    if (texDensitySlider && texDensityVal) {
        texDensitySlider.oninput = (e) => {
            if (!app.engine) return;
            const valPercent = parseInt(e.target.value);
            app.engine.textureDensity = valPercent / 100.0;
            texDensityVal.innerText = `${valPercent}%`;
        };
    }

    // Grid size (Screentone spacing frequency) slider
    const texSizeSlider = document.getElementById('slider-tex-size');
    const texSizeVal = document.getElementById('tex-size-val');
    if (texSizeSlider && texSizeVal) {
        texSizeSlider.oninput = (e) => {
            if (!app.engine) return;
            const valPx = parseInt(e.target.value);
            app.engine.textureGridSize = valPx;
            texSizeVal.innerText = `${valPx}px`;
        };
    }
}
