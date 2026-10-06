import { LAYERS_COUNT, SECTOR_SIZE } from './constants.js';
import { isCanvasEmpty, isMobileDevice } from './colorUtils.js';

export function canvasToBlobAsync(canvas, type = 'image/webp', quality = 0.95) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        resolve(blob || null);
      }, type, quality);
    } catch (e) {
      resolve(null);
    }
  });
}

export function canvasToDataURLAsync(canvas, type = 'image/png', quality) {
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

export async function decodeChunkData(chunkData) {
    if (!chunkData) return null;
    if (chunkData instanceof Blob) {
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(chunkData);
            } catch (e) {}
        }
        return new Promise(resolve => {
            const url = URL.createObjectURL(chunkData);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }
    if (chunkData instanceof ArrayBuffer || ArrayBuffer.isView(chunkData)) {
        const blob = new Blob([chunkData], { type: 'image/webp' });
        if (typeof createImageBitmap === 'function') {
            try { return await createImageBitmap(blob); } catch (e) {}
        }
        return new Promise(resolve => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }
    if (typeof chunkData === 'string') {
        if (chunkData.startsWith('data:') && typeof createImageBitmap === 'function') {
            try {
                const res = await fetch(chunkData);
                const blob = await res.blob();
                return await createImageBitmap(blob);
            } catch (e) {}
        }
        return new Promise(resolve => {
            const img = new Image();
            const timer = setTimeout(() => { img.src = ''; resolve(null); }, 30000);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = chunkData;
        });
    }
    return null;
}

export async function decodeAndDrawChunk(chunkData, chunk, layerId) {
    if (!chunk || !chunk.ctxs[layerId] || !chunkData) return;
    const bmp = await decodeChunkData(chunkData);
    if (bmp) {
        chunk.ctxs[layerId].drawImage(bmp, 0, 0);
        if (chunk.isEmpty) chunk.isEmpty[layerId] = false;
        if (chunk.gpuDirty) chunk.gpuDirty[layerId] = true;
        if (bmp.close) bmp.close();
    }
}

export async function initProjectSystem(app) {
    let list = await app.storage.loadGlobalSetting('projects_list');
    if (!list || !Array.isArray(list) || list.length === 0) {
        list = [{ id: 'default', name: 'ORIGINAL', settings: { chunkSize: 1024, quality: 0.92 } }];
        await app.storage.saveGlobalSetting('projects_list', list);
    }
    app.projects = list;

    let currentId = await app.storage.loadGlobalSetting('current_project_id');
    if (!currentId || !app.projects.some(p => p.id === currentId)) {
        currentId = app.projects[0].id;
        await app.storage.saveGlobalSetting('current_project_id', currentId);
    }

    app.currentProjectId = currentId;
    app.storage.setProjectId(currentId);
    app.engine.currentProjectId = currentId;
    app.engine.loadViewport(currentId);
    
    // Set Engine settings from current project
    const project = app.projects.find(p => p.id === currentId);
    if (project && project.settings) {
        app.engine.chunkSize = project.settings.chunkSize || 1024;
        app.engine.saveQuality = project.settings.quality || 0.92;
        app.engine.isStatic = project.settings.isStatic || false;
        app.engine.staticWidth = project.settings.width || 2400;
        app.engine.staticHeight = project.settings.height || 3600;
        app.engine.dpiScale = 1.0;
        if (app.engine.setupBoard) {
            app.engine.setupBoard();
        }
        syncStaticSettingsUI(app);
    }
    
    await renderProjectList(app);

    // Setup Cross-Tab BroadcastChannel sync
    if (typeof BroadcastChannel !== 'undefined' && !app._projectChannel) {
        try {
            app._projectChannel = new BroadcastChannel('concept_brute_sync');
            app._projectChannel.onmessage = async (event) => {
                const { type, projects, currentProjectId } = event.data || {};
                if (type === 'PROJECTS_UPDATED' && projects && Array.isArray(projects)) {
                    app.projects = projects;
                    await renderProjectList(app);
                }
            };
        } catch (e) {}
    }

    // Setup Tab Visibility / Wake-up sync
    if (!app._visibilitySyncInitialized) {
        app._visibilitySyncInitialized = true;
        const handleWakeUp = async () => {
            if (!document.hidden) {
                try {
                    await app.storage.ensureReady();
                    const storedProjects = await app.storage.loadGlobalSetting('projects_list');
                    if (storedProjects && Array.isArray(storedProjects) && storedProjects.length > 0) {
                        const storedStr = JSON.stringify(storedProjects.map(p => ({ id: p.id, name: p.name, thumb: !!p.thumbnail })));
                        const currentStr = JSON.stringify((app.projects || []).map(p => ({ id: p.id, name: p.name, thumb: !!p.thumbnail })));
                        if (storedStr !== currentStr) {
                            app.projects = storedProjects;
                            await renderProjectList(app);
                        }
                    }
                } catch (e) {}
            }
        };
        document.addEventListener('visibilitychange', handleWakeUp);
        window.addEventListener('focus', handleWakeUp);
    }
}

export async function renderProjectList(app) {
    const container = document.getElementById('project-list');
    if (!container) return;
    container.innerHTML = '';

    app.projects.forEach(proj => {
        const item = document.createElement('div');
        item.className = 'project-item';
        item.dataset.projId = proj.id;
        if (proj.id === app.currentProjectId) item.classList.add('active');

        const thumbContainer = document.createElement('div');
        thumbContainer.style.width = '100%';
        thumbContainer.style.aspectRatio = '1';
        thumbContainer.style.background = '#eee';
        thumbContainer.style.border = '1px solid #000';
        thumbContainer.style.marginBottom = '4px';
        thumbContainer.style.overflow = 'hidden';
        thumbContainer.style.display = 'flex';
        thumbContainer.style.alignItems = 'center';
        thumbContainer.style.justifyContent = 'center';

        if (proj.thumbnail) {
            const thumb = document.createElement('img');
            thumb.className = 'project-thumb';
            thumb.src = proj.thumbnail;
            thumb.style.width = '100%';
            thumb.style.height = '100%';
            thumb.style.objectFit = 'cover';
            thumbContainer.appendChild(thumb);
        } else {
            const placeholder = document.createElement('div');
            placeholder.innerText = proj.name ? proj.name[0].toUpperCase() : '?';
            placeholder.style.fontSize = '24px';
            placeholder.style.fontWeight = '900';
            placeholder.style.opacity = '0.2';
            thumbContainer.appendChild(placeholder);
        }
        item.appendChild(thumbContainer);

        const name = document.createElement('div');
        name.className = 'project-name';
        name.innerText = proj.name || proj.id;
        item.appendChild(name);

        if (proj.id !== 'default') {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-proj';
            delBtn.innerText = 'X';
            delBtn.title = 'DELETE PROJECT';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (delBtn.innerText === 'X') {
                    delBtn.innerText = '?';
                    delBtn.style.background = '#000';
                    delBtn.style.color = '#fff';
                    delBtn.title = 'CLICK AGAIN TO CONFIRM DELETION';
                    
                    // Reset to "X" if they don't click again within 3 seconds
                    setTimeout(() => {
                        if (delBtn.innerText === '?') {
                            delBtn.innerText = 'X';
                            delBtn.style.background = '#f00';
                            delBtn.style.color = '#fff';
                            delBtn.title = 'DELETE PROJECT';
                        }
                    }, 3000);
                } else {
                    deleteProject(app, proj.id);
                }
            };
            item.appendChild(delBtn);
        }

        // Instant visual tactile touch/click feedback on pointerdown
        item.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.btn-delete-proj')) return;
            if (proj.id !== app.currentProjectId) {
                item.classList.add('active', 'switching');
            }
        });

        item.onclick = (e) => {
            e.stopPropagation();
            switchProject(app, proj.id);
        };
        container.appendChild(item);
    });
}

export async function switchProject(app, id) {
    if (!id || (id === app.currentProjectId && !app._isSwitchingProject)) return;

    // STEP 1: INSTANT VISUAL FEEDBACK (0 ms)
    // Update the project-list DOM immediately so the clicked card displays the active & switching state!
    const container = document.getElementById('project-list');
    if (container) {
        const items = container.querySelectorAll('.project-item');
        items.forEach(el => {
            if (el.dataset.projId === id) {
                el.classList.add('active', 'switching');
            } else {
                el.classList.remove('active', 'switching');
            }
        });
    }

    const targetProj = app.projects.find(p => p.id === id);
    const targetName = targetProj ? (targetProj.name || id) : id;

    app._status(`SAVING PREVIOUS PROJECT...`);
    // Yield to the browser so the UI paints the selected state and status bar immediately!
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

    // Track generation to prevent race conditions or superseded loads
    const switchToken = ++app._switchProjectGeneration;

    // If another switch is actively running, queue this target and return
    if (app._isSwitchingProject) {
        app._queuedSwitchId = id;
        return;
    }
    app._isSwitchingProject = true;

    try {
        const outgoingId = app.currentProjectId;

        if (app.engine && app.engine.isDrawing) {
            app.engine._endStroke();
        }
        if (app._clearSaveTimer) {
            app._clearSaveTimer();
        }

        // Wait for any in-flight auto-save to finish cleanly
        if (app._activeSavePromise) {
            try { await app._activeSavePromise; } catch (e) {}
        }

        // Save outgoing project if valid
        if (outgoingId) {
            const isDirty = (app.engine && app.engine.dirtyChunks && app.engine.dirtyChunks.size > 0) || (app.engine && app.engine.refsDirty);
            const currentProj = app.projects ? app.projects.find(p => p.id === outgoingId) : null;

            // Generate thumbnail only if canvas was actually modified or thumbnail is missing
            if (isDirty || !currentProj || !currentProj.thumbnail) {
                const thumbnail = await generateThumbnail(app);
                if (currentProj && thumbnail) currentProj.thumbnail = thumbnail;
                await app.storage.saveGlobalSetting('projects_list', app.projects);
            }

            // Save outgoing project with explicit outgoing ID so nothing can leak
            await saveProject(app, true, outgoingId);

            // Save previous viewport before switching ID
            if (app.engine && app.engine.saveViewport) {
                app.engine.saveViewport(outgoingId);
            }
        }

        // Check if user clicked a different project while we were saving
        if (app._queuedSwitchId) {
            const nextId = app._queuedSwitchId;
            app._queuedSwitchId = null;
            app._isSwitchingProject = false;
            return switchProject(app, nextId);
        }

        // STEP 2: SHOWCASE LOADING NEW PROJECT
        app._status(`LOADING ${targetName.toUpperCase()}...`);
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

        // Safely set the new project ID across all subsystems
        app.currentProjectId = id;
        app.storage.setProjectId(id);
        if (app.engine) app.engine.currentProjectId = id;
        await app.storage.saveGlobalSetting('current_project_id', id);

        // Load non-canvas project-specific settings (background, palette, grid)
        await app.loadProjectSettings(id);

        // Load project settings
        const project = app.projects.find(p => p.id === id);
        const settings = project ? project.settings : {};

        // Update Engine with new settings
        app.engine.chunkSize = settings.chunkSize || 1024;
        app.engine.saveQuality = settings.quality || 0.92;
        app.engine.isStatic = settings.isStatic || false;
        app.engine.staticWidth = settings.width || 2400;
        app.engine.staticHeight = settings.height || 3600;
        app.engine.dpiScale = 1.0;
        if (app.engine.setupBoard) {
            app.engine.setupBoard();
        }
        syncStaticSettingsUI(app);

        // Wipe engine state completely
        app.engine.resetEngineState();

        app.engine._updateSelectionPreview();
        app.engine.loadViewport(id);

        // Sync UI settings
        const spacingEl = document.getElementById('settings-brush-spacing');
        if (spacingEl) spacingEl.value = app.engine.brush.spacing;

        // Load incoming project data
        await loadProject(app, id, switchToken);

        if (switchToken !== app._switchProjectGeneration) return;

        app._updateRefImageList();
        await renderProjectList(app);

        if (app.recorder && typeof app.recorder.onProjectSwitched === 'function') {
            app.recorder.onProjectSwitched(id);
        }
        app._status('READY');
    } catch (err) {
        console.error("Project switch failed:", err);
        app._status('SWITCH ERROR');
    } finally {
        app._isSwitchingProject = false;
        if (container) {
            const items = container.querySelectorAll('.project-item');
            items.forEach(el => el.classList.remove('switching'));
        }
        // If another switch was requested, process it now
        if (app._queuedSwitchId) {
            const nextId = app._queuedSwitchId;
            app._queuedSwitchId = null;
            switchProject(app, nextId);
        }
    }
}

export async function deleteProject(app, id) {
    if (id === 'default') {
        app._status('CANNOT DELETE STANDARD PROJECT');
        return;
    }
    
    app._status('DELETING...');
    try {
        if (app.storage && typeof app.storage.deleteProjectStoredData === 'function') {
            await app.storage.deleteProjectStoredData(id);
        }
    } catch (e) {
        console.error("Purging storage for deleted project failed", e);
    }
    
    app.projects = app.projects.filter(p => p.id !== id);
    await app.storage.saveGlobalSetting('projects_list', app.projects);
    
    // If we deleted the active project, cleanly switch to default
    if (id === app.currentProjectId) {
        app._isSwitchingProject = false;
        await switchProject(app, 'default');
    } else {
        await renderProjectList(app);
        app._status('PROJECT DELETED');
    }
}

// Process tasks in controlled batches to avoid thread/layout exhaustion (especially on mobile devices!)
async function runInBatches(tasks, batchSize = 12, onProgress = null) {
    for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        await Promise.all(batch.map(fn => fn()));
        if (onProgress) {
            onProgress(i + batch.length, tasks.length);
        }
        // Yield to the main/UI thread with a microtask break to ensure the browser paints intermediate frames and processes inputs!
        await new Promise(resolve => setTimeout(resolve, 4));
    }
}

export async function loadProject(app, targetProjectId = null, switchToken = null) {
    const projId = targetProjectId || app.currentProjectId;
    console.log(`[PERF] loadProject(${projId}) started`);
    const tLoadStart = performance.now();
    app._status('LOADING...');
    app.engine.selectedRefIndex = -1; // Ensure de-selected on load
    try {
        if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;

        const tRefsStart = performance.now();
        const refs = await app.storage.loadSetting('referenceImages', projId);
        console.log(`[PERF] Loaded reference settings from storage in ${(performance.now() - tRefsStart).toFixed(2)}ms`);

        if (refs && Array.isArray(refs) && refs.length > 0) {
            if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;
            const tRefsImagesStart = performance.now();
            const refPromises = refs.map((r) => {
                return () => (async () => {
                    const img = new Image();
                    await new Promise(res => {
                        const timer = setTimeout(() => {
                            img.src = '';
                            res();
                        }, 1200);
                        img.onload = () => { clearTimeout(timer); res(); };
                        img.onerror = () => { clearTimeout(timer); res(); };
                        img.src = r.src;
                    });
                    if (img.width > 0) {
                        const refObj = app.engine.addReferenceImage(img, r.name, r.x, r.y, {
                            rotation: r.rotation,
                            scale: r.scale,
                            opacity: r.opacity,
                            mirrorX: r.mirrorX,
                            mirrorY: r.mirrorY
                        }, false);
                        if (refObj && r.extractedPalette) {
                            refObj.extractedPalette = r.extractedPalette;
                        }
                    }
                })();
            });
            await runInBatches(refPromises, 6);
            app._updateRefImageList();
            console.log(`[PERF] Reference images decoding and layout took ${(performance.now() - tRefsImagesStart).toFixed(2)}ms`);
        }

        if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;

        // 1. LEGACY MIGRATION
        const legacyKeys = await app.storage.getAllLegacyKeys(projId);
        if (legacyKeys.length > 0) {
            app._status('MIGRATING...');
            const legacyPromises = legacyKeys.map((key) => {
                return () => (async () => {
                    const parts = key.split('_');
                    const cy = parseInt(parts[parts.length - 1]);
                    const cx = parseInt(parts[parts.length - 2]);
                    const layerId = parseInt(parts[parts.length - 3]);
                    
                    if (isNaN(layerId) || layerId <= 0 || layerId >= LAYERS_COUNT) {
                        return;
                    }

                    const dataUrl = await app.storage.loadLegacyChunk(key);
                    if (dataUrl) {
                        const bmp = await decodeChunkData(dataUrl);
                        if (bmp) {
                            const chunk = app.engine._getChunk(cx, cy);
                            if (chunk && chunk.ctxs[layerId]) {
                                chunk.ctxs[layerId].drawImage(bmp, 0, 0);
                                if (chunk.isEmpty) chunk.isEmpty[layerId] = false;
                                if (chunk.gpuDirty) chunk.gpuDirty[layerId] = true;
                                if (app.engine.gpuRenderer) {
                                    app.engine.gpuRenderer.markChunkLayerDirty(chunk, layerId);
                                }
                                app.engine._markDirty(`${cx},${cy}`, layerId, false);
                            }
                            if (bmp.close) bmp.close();
                        }
                    }
                    await app.storage.deleteLegacyChunk(key);
                })();
            });
            await runInBatches(legacyPromises, 12);
        }

        if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;

        // 2. SECTOR LOADING
        const tSectorKeysStart = performance.now();
        const sectorKeys = await app.storage.getAllSectorKeys(projId);
        console.log(`[PERF] Retrieved ${sectorKeys.length} sector keys for ${projId} in ${(performance.now() - tSectorKeysStart).toFixed(2)}ms`);
        
        const tSectorsLoadStart = performance.now();
        // Load all sectors in a single batch transaction from the indexedDB store
        const batchResults = await app.storage.loadSectorsBatch(sectorKeys);
        const sectors = batchResults.map(({ key, sector }) => {
            if (!sector) return null;
            const parts = key.split('_'); 
            const sy = parseInt(parts[parts.length - 1].replace('minus', '-'));
            const sx = parseInt(parts[parts.length - 2].replace('minus', '-'));
            return { sx, sy, sector };
        }).filter(Boolean);
        console.log(`[PERF] Loading sector metadata took ${(performance.now() - tSectorsLoadStart).toFixed(2)}ms`);

        if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;

        // Map and load all chunk images concurrently with high-speed bitmap decoding
        const chunkLoadPromises = [];
        for (const { sector } of sectors) {
            if (sector && sector.chunks) {
                for (const chunkKey in sector.chunks) {
                    let layerId, cx, cy;
                    if (chunkKey.includes('|')) {
                        const [coords, lStr] = chunkKey.split('|');
                        const [xStr, yStr] = coords.split(',');
                        layerId = parseInt(lStr);
                        cx = parseInt(xStr);
                        cy = parseInt(yStr);
                    } else if (chunkKey.includes(',')) {
                        const parts = chunkKey.split(',');
                        layerId = parseInt(parts[0]);
                        cx = parseInt(parts[1]);
                        cy = parseInt(parts[2]);
                    } else {
                        const cParts = chunkKey.split('_');
                        cy = parseInt(cParts[cParts.length - 1]);
                        cx = parseInt(cParts[cParts.length - 2]);
                        layerId = parseInt(cParts[cParts.length - 3]);
                    }
                    const chunkData = sector.chunks[chunkKey];
                    
                    if (chunkData && !isNaN(layerId) && !isNaN(cx) && !isNaN(cy) && layerId >= 0 && layerId < LAYERS_COUNT) {
                        chunkLoadPromises.push(() => (async () => {
                            if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;
                            try {
                                const bmp = await decodeChunkData(chunkData);
                                if (bmp) {
                                    if (switchToken !== null && switchToken !== app._switchProjectGeneration) {
                                        if (bmp.close) bmp.close();
                                        return;
                                    }
                                    const chunk = app.engine._getChunk(cx, cy);
                                    if (chunk && chunk.ctxs[layerId]) {
                                        chunk.ctxs[layerId].drawImage(bmp, 0, 0);
                                        if (chunk.isEmpty) chunk.isEmpty[layerId] = false;
                                        if (chunk.gpuDirty) chunk.gpuDirty[layerId] = true;
                                        if (app.engine.gpuRenderer) {
                                            app.engine.gpuRenderer.markChunkLayerDirty(chunk, layerId);
                                        }
                                    }
                                    if (bmp.close) bmp.close();
                                }
                            } catch (err) {
                                console.warn(`[LOAD] Error decoding chunk ${cx},${cy} layer ${layerId}:`, err);
                            }
                        })());
                    }
                }
            }
        }
        
        console.log(`[PERF] Prepared ${chunkLoadPromises.length} chunk loaders. Starting runInBatches...`);
        const tBatchRunStart = performance.now();
        if (chunkLoadPromises.length > 0) {
            await runInBatches(chunkLoadPromises, 24, (loaded, total) => {
                const pct = Math.min(100, Math.round((loaded / total) * 100));
                app._status(`LOADING (${pct}%)`);
            });
        }
        console.log(`[PERF] runInBatches() completed in ${(performance.now() - tBatchRunStart).toFixed(2)}ms for ${chunkLoadPromises.length} chunks`);

        if (switchToken !== null && switchToken !== app._switchProjectGeneration) return;

        // Force promote all loaded chunks to GPU so zero chunks/layers are left blank
        app.engine.chunks.forEach(chunk => {
            if (chunk.gpuDirty) {
                chunk.gpuDirty.fill(true);
            }
        });
        if (app.engine.gpuRenderer) {
            app.engine.gpuRenderer.markAllChunksDirty();
        }
        app.engine.refresh();
        if (app.engine.gpuRenderer) {
            app.engine.gpuRenderer.requestRender();
        }
        if (app.engine && app.engine.loadHistoryStackFromStorage) {
            await app.engine.loadHistoryStackFromStorage(projId);
        }
        app._status('READY');
        console.log(`[PERF] loadProject(${projId}) completed in ${(performance.now() - tLoadStart).toFixed(2)}ms`);
    } catch (e) {
        console.error("Load failed", e);
        app._status('LOAD ERROR');
    }
}

export async function saveProject(app, force = false, targetProjectId = null) {
    const projId = targetProjectId || app.currentProjectId;

    if (app.engine.isDrawing && !force) {
        app._triggerAutoSave();
        return;
    }
    if (app.engine.isDrawing && force) {
        app.engine._endStroke();
    }

    const isDirty = (app.engine.dirtyChunks && app.engine.dirtyChunks.size > 0) || app.engine.refsDirty;
    if (!isDirty && !force) {
        app._status('SAVED');
        app._showSaved();
        return;
    }

    if (app._isSavingProject) {
        try { await app._activeSavePromise; } catch (e) {}
    }

    let finishSave;
    app._activeSavePromise = new Promise(r => { finishSave = r; });
    app._isSavingProject = true;
    app._status('SAVING...');

    try {
        if (app.recorder && typeof app.recorder.saveCurrentSession === 'function') {
            await app.recorder.saveCurrentSession(projId);
        }

        if (app.engine && app.engine.saveHistoryStackToStorage) {
            await app.engine.saveHistoryStackToStorage(projId);
        }

        if (app.engine.refsDirty) {
            const refData = app.engine.referenceImages.map(r => ({
                id: r.id,
                name: r.name,
                src: r.img.src,
                x: r.x,
                y: r.y,
                rotation: r.rotation,
                scale: r.scale,
                opacity: r.opacity,
                mirrorX: r.mirrorX,
                mirrorY: r.mirrorY,
                extractedPalette: r.extractedPalette || null
            }));
            await app.storage.saveSetting('referenceImages', refData, projId);
            app.engine.refsDirty = false;
        }

        app.engine.compact();

        // If force is true and dirtyChunks is empty (e.g. user clicked FORCE SAVE NOW or project switch),
        // mark all non-empty chunk layers dirty so all chunks are guaranteed persisted
        if (force && (!app.engine.dirtyChunks || app.engine.dirtyChunks.size === 0)) {
            app.engine.chunks.forEach((chunk, chunkId) => {
                for (let l = 1; l < LAYERS_COUNT; l++) {
                    const canv = chunk.canvases[l];
                    if (canv && !isCanvasEmpty(canv)) {
                        app.engine._markDirty(chunkId, l, false);
                    }
                }
            });
        }

        if (!app.engine.dirtyChunks || app.engine.dirtyChunks.size === 0) {
            app._status('SAVED');
            app._showSaved();
            return;
        }

        const dirty = Array.from(app.engine.dirtyChunks);
        app.engine.dirtyChunks.clear(); 

        const sectorGroups = new Map();
        
        for (const item of dirty) {
            const [chunkId, layerStr] = item.split('|');
            const [cx, cy] = chunkId.split(',').map(Number);
            const sx = Math.floor(cx / SECTOR_SIZE);
            const sy = Math.floor(cy / SECTOR_SIZE);
            const sKey = `${sx},${sy}`;
            
            if (!sectorGroups.has(sKey)) sectorGroups.set(sKey, new Set());
            sectorGroups.get(sKey).add(item);
        }

        const promises = [];
        
        for (const [sKey, affectedItems] of sectorGroups) {
            const [sx, sy] = sKey.split(',').map(Number);
            
            promises.push((async () => {
                let sector = await app.storage.loadSector(sx, sy, projId);
                if (!sector) {
                    sector = { chunks: {} };
                }

                for (const item of affectedItems) {
                    const [chunkId, layerStr] = item.split('|');
                    const l = parseInt(layerStr);
                    const [cx, cy] = chunkId.split(',').map(Number);
                    const chunkKey = `${l}_${cx}_${cy}`;

                    const chunk = app.engine.chunks.get(chunkId);
                    if (chunk && chunk.canvases && chunk.canvases[l]) {
                        const sourceCanvas = chunk.canvases[l];
                        if (sourceCanvas.width === 0 || sourceCanvas.height === 0) {
                            delete sector.chunks[chunkKey];
                            chunk.isEmpty[l] = true;
                            continue;
                        }

                        const empty = isCanvasEmpty(sourceCanvas);
                        chunk.isEmpty[l] = empty;
                        
                        if (empty) {
                            delete sector.chunks[chunkKey];
                        } else {
                            // High-speed binary Blob storage in IndexedDB (zero base64 conversion overhead!)
                            const blob = await canvasToBlobAsync(sourceCanvas, 'image/webp', 0.95);
                            sector.chunks[chunkKey] = blob || (await canvasToDataURLAsync(sourceCanvas, 'image/png'));
                        }
                    }
                }

                await app.storage.saveSector(sx, sy, sector, projId);
            })());
        }
        
        await Promise.all(promises);
        
        if (app.engine && app.engine.clearAllOffscreenCanvases) {
            app.engine.clearAllOffscreenCanvases();
        }
        
        app._status('SAVED');
        app._showSaved();
        await updateStorageStat(app);
    } catch (e) {
        console.error("Save failed", e);
        if (dirty && dirty.length > 0) {
            dirty.forEach(item => app.engine.dirtyChunks.add(item));
        }
        app._status('SAVE ERROR');
    } finally {
        app._isSavingProject = false;
        app._activeSavePromise = null;
        if (finishSave) finishSave();
    }
}

export async function generateThumbnail(app) {
    const size = 128;
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = size;
    thumbCanvas.height = size;
    const tctx = thumbCanvas.getContext('2d');
    
    tctx.fillStyle = app.engine.canvasBg;
    tctx.fillRect(0, 0, size, size);
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (app.engine.isStatic) {
        minX = -app.engine.staticWidth / 2;
        minY = -app.engine.staticHeight / 2;
        maxX = app.engine.staticWidth / 2;
        maxY = app.engine.staticHeight / 2;
    } else {
        app.engine.chunks.forEach(c => {
            minX = Math.min(minX, c.cx * app.engine.chunkSize);
            minY = Math.min(minY, c.cy * app.engine.chunkSize);
            maxX = Math.max(maxX, (c.cx + 1) * app.engine.chunkSize);
            maxY = Math.max(maxY, (c.cy + 1) * app.engine.chunkSize);
        });
    }
    
    if (minX === Infinity) return '';
    
    const w = maxX - minX;
    const h = maxY - minY;
    const scale = Math.min(size / w, size / h, 1);
    
    tctx.save();
    tctx.translate(size/2, size/2);
    tctx.scale(scale, scale);
    tctx.translate(-(minX + w/2), -(minY + h/2));
    
    app.engine.chunks.forEach(chunk => {
        const lx = app.engine.isStatic ? -app.engine.staticWidth / 2 : chunk.cx * app.engine.chunkSize;
        const ly = app.engine.isStatic ? -app.engine.staticHeight / 2 : chunk.cy * app.engine.chunkSize;
        for (let i = 1; i < LAYERS_COUNT; i++) {
            tctx.drawImage(chunk.canvases[i], lx, ly);
        }
    });
    tctx.restore();
    
    // Sweep and promote all memory-loaded chunk canvases back to GPU after the readback
    if (app.engine.promoteAllToGPU) {
        app.engine.promoteAllToGPU();
    }
    
    return thumbCanvas.toDataURL('image/webp', 0.5);
}

export async function updateStorageStat(app) {
    const stats = await app.storage.getStorageStats(app.currentProjectId);
    
    const chunksEl = document.getElementById('storage-chunks');
    if (chunksEl) {
        if (app.engine.isStatic) {
            const project = app.projects.find(p => p.id === app.currentProjectId);
            const dpiVal = (project && project.settings && project.settings.dpi) ? project.settings.dpi : 300;
            chunksEl.innerText = `STATIC SHEET: ${app.engine.staticWidth} x ${app.engine.staticHeight} PX @ ${dpiVal} DPI`;
        } else {
            chunksEl.innerText = `${stats.chunks} CHUNKS (${stats.sectors} SECTORS)`;
        }
    }

    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const sizeEl = document.getElementById('storage-size');
    if (sizeEl) sizeEl.innerText = sizeMB;
}

export async function performExport(app) {
    if (!app.currentExportRect) return;
    
    const w = parseInt(document.getElementById('export-width').value);
    const h = parseInt(document.getElementById('export-height').value);
    const alpha = document.getElementById('export-alpha').checked;
    
    const rect = app.currentExportRect;
    
    const xStart = Math.floor(rect.x);
    const yStart = Math.floor(rect.y);
    const xEnd = Math.ceil(rect.x + rect.w);
    const yEnd = Math.ceil(rect.y + rect.h);
    const exactW = Math.max(1, xEnd - xStart);
    const exactH = Math.max(1, yEnd - yStart);
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = exactW;
    tempCanvas.height = exactH;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;
    
    // Draw background color and grid pattern if not exporting transparency (alpha)
    if (!alpha) {
        tempCtx.fillStyle = app.engine.canvasBg;
        tempCtx.fillRect(0, 0, exactW, exactH);
        
        if (app.engine.showGrid) {
            if (!app.engine._gridCanvas) {
                app.engine._generateGridTexture();
            }
            if (app.engine._gridCanvas) {
                const pattern = tempCtx.createPattern(app.engine._gridCanvas, 'repeat');
                if (pattern) {
                    let originX = 0;
                    let originY = 0;
                    if (app.engine.isStatic) {
                        originX = -app.engine.staticWidth / 2;
                        originY = -app.engine.staticHeight / 2;
                    }
                    tempCtx.save();
                    tempCtx.translate(originX - xStart, originY - yStart);
                    tempCtx.fillStyle = pattern;
                    tempCtx.fillRect(xStart - originX, yStart - originY, exactW, exactH);
                    tempCtx.restore();
                }
            }
        }
    }
    
    // Only draw reference images if layer index 0 (IMG REF) is visible
    if (app.engine.layerSettings[0] && app.engine.layerSettings[0].visible) {
        tempCtx.save();
        tempCtx.translate(-xStart, -yStart);
        app.engine.referenceImages.forEach(ref => {
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
    
    app.engine.chunks.forEach(chunk => {
        const lx = app.engine.isStatic ? -app.engine.staticWidth / 2 : chunk.cx * app.engine.chunkSize;
        const ly = app.engine.isStatic ? -app.engine.staticHeight / 2 : chunk.cy * app.engine.chunkSize;
        const chunkW = app.engine.isStatic ? app.engine.staticWidth : app.engine.chunkSize;
        const chunkH = app.engine.isStatic ? app.engine.staticHeight : app.engine.chunkSize;
        
        if (lx < xEnd && lx + chunkW > xStart &&
            ly < yEnd && ly + chunkH > yStart) {
            
            for (let i = 1; i < LAYERS_COUNT; i++) {
                // Skip invisible layers
                if (app.engine.layerSettings[i] && !app.engine.layerSettings[i].visible) {
                    continue;
                }
                tempCtx.drawImage(chunk.canvases[i], lx - xStart, ly - yStart, chunkW, chunkH);
            }
        }
    });
    
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = w;
    exportCanvas.height = h;
    const exCtx = exportCanvas.getContext('2d');
    if (!exCtx) return;
    
    if (!alpha) {
        exCtx.fillStyle = app.engine.canvasBg;
        exCtx.fillRect(0, 0, w, h);
    }
    
    const cropX = rect.x - xStart;
    const cropY = rect.y - yStart;
    
    exCtx.imageSmoothingEnabled = true;
    exCtx.imageSmoothingQuality = 'high';
    
    exCtx.drawImage(
        tempCanvas,
        cropX, cropY, rect.w, rect.h,
        0, 0, w, h
    );
    
    const link = document.createElement('a');
    link.download = `CONCEPT_BRUTE_${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
    
    // Sweep and promote all memory-loaded chunk canvases back to GPU after export readback
    if (app.engine.promoteAllToGPU) {
        app.engine.promoteAllToGPU();
    }

    app._endExportMode();
    app._status('EXPORTED');
}

export function syncStaticSettingsUI(app) {
    const staticSec = document.getElementById('settings-static-section');
    if (staticSec) {
        if (app.engine.isStatic) {
            staticSec.classList.remove('hidden');
            const wInput = document.getElementById('settings-static-width');
            const hInput = document.getElementById('settings-static-height');
            if (wInput) wInput.value = app.engine.staticWidth;
            if (hInput) hInput.value = app.engine.staticHeight;
        } else {
            staticSec.classList.add('hidden');
        }
    }
}
