export function drawLasso(engine, from, to) {
    if (!engine.lassoPath) {
        engine.lassoPath = [];
    }
    const m = engine._getMousePos({
        clientX: to.x + engine.container.getBoundingClientRect().left,
        clientY: to.y + engine.container.getBoundingClientRect().top
    });
    engine.lassoPath.push({ x: m.wx, y: m.wy });
    engine._status('LASSOING...');
}

export function updateSelectionPreview(engine) {
    if (!engine.warpSelectionImage) {
        engine.warpSelectionImage = warpSelectionImage;
    }
    if (!engine.floatingSelection) {
        if (engine.selectionOverlay) engine.selectionOverlay.remove();
        engine.selectionOverlay = null;

        // Clean up all chunk selection canvases
        engine.chunks.forEach(chunk => {
            if (chunk.selectionCanvas) {
                chunk.selectionCanvas.remove();
                chunk.selectionCanvas = null;
                chunk.selectionCtx = null;
            }
        });
        if (engine.gpuRenderer && engine.gpuRenderer.supported) {
            engine.gpuRenderer.requestRender();
        }
        return;
    }

    const sel = engine.floatingSelection;
    const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
    const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);

    const selW = sel.width || sel.canvas.width;
    const selH = sel.height || sel.canvas.height;

    // Pre-emptively load and attach chunks inside selection bounding box during transform selection preview
    const rotVal = sel.rotation || 0;
    const cosVal = Math.abs(Math.cos(rotVal));
    const sinVal = Math.abs(Math.sin(rotVal));
    const boundingW = (sel.canvas.width * scX * cosVal + sel.canvas.height * scY * sinVal);
    const boundingH = (sel.canvas.width * scX * sinVal + sel.canvas.height * scY * cosVal);

    const startCX = engine.isStatic ? 0 : Math.floor((sel.x + selW / 2 - boundingW / 2) / engine.chunkSize);
    const startCY = engine.isStatic ? 0 : Math.floor((sel.y + selH / 2 - boundingH / 2) / engine.chunkSize);
    const endCX = engine.isStatic ? 0 : Math.floor((sel.x + selW / 2 + boundingW / 2) / engine.chunkSize);
    const endCY = engine.isStatic ? 0 : Math.floor((sel.y + selH / 2 + boundingH / 2) / engine.chunkSize);

    for (let cx = startCX; cx <= endCX; cx++) {
        for (let cy = startCY; cy <= endCY; cy++) {
            const chunk = engine._getChunk(cx, cy);
            if (!engine.gpuRenderer?.supported && chunk && !chunk.isAttached) {
                engine.boardContainer.appendChild(chunk.element);
                chunk.isAttached = true;
                engine._updateChunkTransform(chunk);
            }
        }
    }

    if (!engine.selectionOverlay) {
        engine.selectionOverlay = document.createElement('div');
        engine.selectionOverlay.className = 'absolute pointer-events-none selection-overlay-gpu';
        engine.selectionOverlay.style.boxSizing = 'border-box';
        // Use layout-independent outline and boxShadow for high-contrast marquee look to avoid 1px coordinate shifting.
        engine.selectionOverlay.style.outline = '1px dashed #ffffff';
        engine.selectionOverlay.style.boxShadow = '0 0 0 1px #000000, 0 0 0 2px #ffffff';
        engine.uiLayer.appendChild(engine.selectionOverlay);
    }

    const rect = engine.container.getBoundingClientRect();
    
    engine.selectionOverlay.style.width = `${selW}px`;
    engine.selectionOverlay.style.height = `${selH}px`;
    
    // pivot point calculation in screen space
    const s = engine._worldToScreen(sel.x + selW / 2, sel.y + selH / 2);
    
    let rot = (sel.rotation || 0);
    const displayScaleX = scX * engine.zoom;
    const displayScaleY = scY * engine.zoom;
    const opacity = (sel.opacity !== undefined ? sel.opacity : 1);
    
    let mirrorX = sel.mirrorX ? -1 : 1;
    let mirrorY = sel.mirrorY ? -1 : 1;
    
    let finalRot = rot + engine.rotation;
    if (engine.isMirrored) {
        mirrorX *= -1;
        finalRot = -finalRot;
    }

    engine.selectionOverlay.style.left = '0px';
    engine.selectionOverlay.style.top = '0px';
    engine.selectionOverlay.style.transformOrigin = 'center center';
    // Center on pivot, then rotate and scale
    engine.selectionOverlay.style.transform = `translate3d(${s.x}px, ${s.y}px, 0px) translate3d(-50%, -50%, 0px) rotate(${finalRot}rad) scale(${displayScaleX * mirrorX}, ${displayScaleY * mirrorY})`;
    
    // Opacity shouldn't change opacity of outer UI/bounding box and the menu, so keep overlay fully opaque
    engine.selectionOverlay.style.opacity = '1';

    // Puppet pin drawing and event handling
    const existingPins = engine.selectionOverlay.querySelectorAll('.brutal-pin');
    existingPins.forEach(p => p.remove());

    if (engine.transformMode === 'deform') {
        const origW = sel.width || sel.canvas.width;
        const origH = sel.height || sel.canvas.height;

        // Auto-initialize padded canvases in deform mode to prevent cutting off at bounds
        if (!sel.deformMargin) {
            const margin = Math.max(300, Math.floor(Math.max(origW, origH) * 0.8));
            sel.deformMargin = margin;

            const origCanvas = sel.originalCanvas || sel.canvas;

            const paddedCanvas = document.createElement('canvas');
            paddedCanvas.width = origW + 2 * margin;
            paddedCanvas.height = origH + 2 * margin;
            paddedCanvas.getContext('2d').drawImage(origCanvas, margin, margin);

            const paddedOriginal = document.createElement('canvas');
            paddedOriginal.width = origW + 2 * margin;
            paddedOriginal.height = origH + 2 * margin;
            paddedOriginal.getContext('2d').drawImage(origCanvas, margin, margin);

            sel.canvas = paddedCanvas;
            sel.originalCanvas = paddedOriginal;
        }

        const w = sel.canvas.width;
        const h = sel.canvas.height;
        const margin = sel.deformMargin || 0;

        // Auto-initialize pins if not present
        if (!sel.pins) {
            sel.pins = [
                { id: '1', ox: margin, oy: margin, x: margin, y: margin, type: 'corner' },
                { id: '2', ox: margin + origW, oy: margin, x: margin + origW, y: margin, type: 'corner' },
                { id: '3', ox: margin, oy: margin + origH, x: margin, y: margin + origH, type: 'corner' },
                { id: '4', ox: margin + origW, oy: margin + origH, x: margin + origW, y: margin + origH, type: 'corner' },
                { id: '5', ox: margin + origW/2, oy: margin + origH/2, x: margin + origW/2, y: margin + origH/2, type: 'center' }
            ];
        }

        // Draw pin circles
        sel.pins.forEach(pin => {
            const pinEl = document.createElement('div');
            pinEl.className = 'absolute brutal-pin';
            pinEl.style.width = '12px';
            pinEl.style.height = '12px';
            pinEl.style.borderRadius = '50%';
            pinEl.style.border = '2px solid black';
            
            // Choose background color based on type
            if (pin.type === 'corner') {
                pinEl.style.backgroundColor = '#00ffff'; // cyan corners
            } else if (pin.type === 'center') {
                pinEl.style.backgroundColor = '#ff00ff'; // magenta center
            } else {
                pinEl.style.backgroundColor = '#00ff00'; // green custom pins
            }
            
            const parentScaleX = (scX * engine.zoom) * mirrorX;
            const parentScaleY = (scY * engine.zoom) * mirrorY;
            const invScaleX = Math.abs(parentScaleX) > 0.001 ? 1 / parentScaleX : 1;
            const invScaleY = Math.abs(parentScaleY) > 0.001 ? 1 / parentScaleY : 1;
            pinEl.style.transform = `translate(-50%, -50%) scale(${invScaleX}, ${invScaleY})`;
            pinEl.style.left = `${((pin.x - margin) / origW) * 100}%`;
            pinEl.style.top = `${((pin.y - margin) / origH) * 100}%`;
            pinEl.style.cursor = 'move';
            pinEl.style.pointerEvents = 'auto'; // allow dragging
            pinEl.style.zIndex = '120';
            
            // Handle pin dragging in local space with transform history tracking
            pinEl.onpointerdown = (pe) => {
                pe.stopPropagation();
                pe.preventDefault();
                engine.isDraggingPin = pin;
                engine.pinDragStartMouse = { x: pe.clientX, y: pe.clientY };
                engine.pinDragStartPos = { x: pin.x, y: pin.y };
                
                const stateBefore = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                let moved = false;

                const onPointerMove = (moveEv) => {
                    if (engine.isDraggingPin === pin) {
                        const dx = moveEv.clientX - engine.pinDragStartMouse.x;
                        const dy = moveEv.clientY - engine.pinDragStartMouse.y;
                        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                            moved = true;
                        }
                        
                        // Inverse transformation of pointer movement (rotated and scaled by selection placement)
                        const sX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
                        const sY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
                        const rot = (sel.rotation || 0) + (engine.rotation || 0);
                        const cosRot = Math.cos(-rot);
                        const sinRot = Math.sin(-rot);
                        
                        let localDx = dx * cosRot - dy * sinRot;
                        let localDy = dx * sinRot + dy * cosRot;
                        
                        const displayScaleX = sX * engine.zoom;
                        const displayScaleY = sY * engine.zoom;
                        
                        localDx /= displayScaleX;
                        localDy /= displayScaleY;
                        
                        if (sel.mirrorX) localDx *= -1;
                        if (sel.mirrorY) localDy *= -1;
                        if (engine.isMirrored) localDx *= -1;
                        
                        pin.x = engine.pinDragStartPos.x + localDx;
                        pin.y = engine.pinDragStartPos.y + localDy;
                        
                        // Warp selection image and trigger redraw!
                        warpSelectionImage(engine);
                        engine._updateSelectionPreview();
                    }
                };
                
                const onPointerUp = () => {
                    engine.isDraggingPin = null;
                    document.removeEventListener('pointermove', onPointerMove);
                    document.removeEventListener('pointerup', onPointerUp);
                    
                    if (moved && stateBefore) {
                        const stateAfter = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                        if (stateAfter) {
                            if (!engine.transformHistory) engine.transformHistory = [];
                            engine.transformHistory.push({
                                before: stateBefore,
                                after: stateAfter
                            });
                            engine.transformRedoHistory = [];
                        }
                    }
                };
                
                document.addEventListener('pointermove', onPointerMove);
                document.addEventListener('pointerup', onPointerUp);
            };
            
            // Double click to delete pin (except corners/center)
            if (pin.type !== 'corner' && pin.type !== 'center') {
                pinEl.ondblclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    
                    const stateBefore = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                    
                    sel.pins = sel.pins.filter(p => p !== pin);
                    warpSelectionImage(engine);
                    engine._updateSelectionPreview();
                    
                    const stateAfter = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                    if (stateBefore && stateAfter) {
                        if (!engine.transformHistory) engine.transformHistory = [];
                        engine.transformHistory.push({
                            before: stateBefore,
                            after: stateAfter
                        });
                        engine.transformRedoHistory = [];
                    }
                };
            }
            
            engine.selectionOverlay.appendChild(pinEl);
        });

        // Setup clicking on overlay to create custom pins
        engine.selectionOverlay.onpointerdown = (pe) => {
            const sX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
            const sY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
            
            const origW = sel.width || (w - 2 * margin);
            const origH = sel.height || (h - 2 * margin);

            const m = engine._getMousePos(pe); // get world coords
            const cx = sel.x + origW / 2;
            const cy = sel.y + origH / 2;
            const dx = m.wx - cx;
            const dy = m.wy - cy;
            
            const rot = sel.rotation || 0;
            const localXCent = dx * Math.cos(-rot) - dy * Math.sin(-rot);
            const localYCent = dx * Math.sin(-rot) + dy * Math.cos(-rot);
            
            let mX = sel.mirrorX ? -1 : 1;
            let mY = sel.mirrorY ? -1 : 1;
            
            const localX = (localXCent / (sX * mX)) + origW / 2 + margin;
            const localY = (localYCent / (sY * mY)) + origH / 2 + margin;
            
            if (localX >= 0 && localX <= w && localY >= 0 && localY <= h) {
                // Check if we already clicked near a pin to avoid double adding
                const clickedNearPin = sel.pins.some(p => {
                    const d = Math.sqrt((p.x - localX)**2 + (p.y - localY)**2);
                    return d < 18; // 18px radius tolerance
                });
                
                if (!clickedNearPin) {
                    const stateBefore = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                    
                    const newPin = {
                        id: Math.random().toString(),
                        ox: localX,
                        oy: localY,
                        x: localX,
                        y: localY,
                        type: 'custom'
                    };
                    sel.pins.push(newPin);
                    warpSelectionImage(engine);
                    engine._updateSelectionPreview();
                    
                    const stateAfter = engine.captureFloatingSelectionState ? engine.captureFloatingSelectionState() : null;
                    if (stateBefore && stateAfter) {
                        if (!engine.transformHistory) engine.transformHistory = [];
                        engine.transformHistory.push({
                            before: stateBefore,
                            after: stateAfter
                        });
                        engine.transformRedoHistory = [];
                    }
                }
            }
        };
    } else {
        if (engine.selectionOverlay) {
            engine.selectionOverlay.onpointerdown = null;
        }
    }

    // Position/update the selectionCanvas on each attached chunk (or render directly via WebGL2 GPURenderer)
    const worldPivotX = sel.x + selW / 2;
    const worldPivotY = sel.y + selH / 2;

    if (engine.gpuRenderer && engine.gpuRenderer.supported) {
        engine.gpuRenderer.requestRender();
    } else {
        engine.chunks.forEach(chunk => {
            if (!chunk.isAttached) {
                if (chunk.selectionCanvas) {
                    chunk.selectionCanvas.remove();
                    chunk.selectionCanvas = null;
                    chunk.selectionCtx = null;
                }
                return;
            }

            const scale = engine.isStatic ? engine.dpiScale : 1;
            
            if (!chunk.selectionCanvas) {
                const sCanv = document.createElement('canvas');
                sCanv.width = chunk.width * scale;
                sCanv.height = chunk.height * scale;
                sCanv.className = 'absolute inset-0';
                sCanv.style.imageRendering = 'auto';
                sCanv.style.backfaceVisibility = 'hidden';
                sCanv.style.webkitBackfaceVisibility = 'hidden';
                sCanv.style.transform = 'translate3d(0, 0, 0)';
                sCanv.style.willChange = 'transform';
                
                const sCtx = sCanv.getContext('2d', { alpha: true });
                if (scale !== 1) {
                    sCtx.scale(scale, scale);
                }
                chunk.selectionCanvas = sCanv;
                chunk.selectionCtx = sCtx;
            }
            
            // Ensure its DOM insertion position is correct (immediately above active layer in this chunk)
            const nextCanvas = chunk.canvases[engine.activeLayer + 1];
            if (nextCanvas) {
                if (chunk.selectionCanvas.nextSibling !== nextCanvas) {
                    chunk.element.insertBefore(chunk.selectionCanvas, nextCanvas);
                }
            } else {
                if (chunk.element.lastChild !== chunk.selectionCanvas) {
                    chunk.element.appendChild(chunk.selectionCanvas);
                }
            }
            
            // Now draw the selection content onto this chunk's canvas
            const sCtx = chunk.selectionCtx;
            sCtx.clearRect(0, 0, chunk.width, chunk.height);
            
            const cxWorld = engine.isStatic ? -engine.staticWidth / 2 : chunk.cx * engine.chunkSize;
            const cyWorld = engine.isStatic ? -engine.staticHeight / 2 : chunk.cy * engine.chunkSize;
            
            sCtx.save();
            sCtx.globalAlpha = opacity;
            
            // Translate relative to chunk coordinate space
            sCtx.translate(-cxWorld, -cyWorld);
            
            // 1. Pivot point of selection in world coordinates
            sCtx.translate(worldPivotX, worldPivotY);
            
            // 2. Rotate
            if (sel.rotation) {
                sCtx.rotate(sel.rotation);
            }
            
            // 3. Scale & Mirror
            let mX = sel.mirrorX ? -1 : 1;
            let mY = sel.mirrorY ? -1 : 1;
            sCtx.scale(scX * mX, scY * mY);
            
            // 4. Draw centrally
            sCtx.drawImage(sel.canvas, -sel.canvas.width / 2, -sel.canvas.height / 2);
            
            sCtx.restore();
        });
    }
    
    // Create/update the mode selector toolbar at the bottom of the bounding box
    let toolbar = document.getElementById('selection-mode-toolbar');

    if (!toolbar && engine.selectionOverlay) {
        toolbar = document.createElement('div');
        toolbar.id = 'selection-mode-toolbar';
        toolbar.className = 'absolute pointer-events-auto';
        toolbar.style.top = '100%';
        toolbar.style.bottom = 'auto';
        toolbar.style.left = '50%';
        toolbar.style.display = 'flex';
        toolbar.style.gap = '3px';
        toolbar.style.padding = '3px';
        toolbar.style.backgroundColor = '#ebebeb';
        toolbar.style.border = '2px solid black';
        toolbar.style.boxShadow = 'none';
        toolbar.style.zIndex = '110';
        
        // Mode buttons
        const modesContainer = document.createElement('div');
        modesContainer.id = 'selection-modes-container';
        modesContainer.style.display = 'flex';
        modesContainer.style.gap = '3px';
        
        const modes = ['move', 'scale', 'rotate', 'opacity', 'deform'];
        modes.forEach(mode => {
            const btn = document.createElement('button');
            btn.className = 'brutal-btn';
            btn.textContent = mode.toUpperCase();
            btn.style.fontSize = '9px';
            btn.style.fontFamily = 'monospace';
            btn.style.fontWeight = '900';
            btn.style.padding = '2px 6px';
            btn.style.height = '20px';
            btn.style.cursor = 'pointer';
            
            const currentMode = engine.transformMode || 'move';
            if (currentMode === mode) {
                if (mode === 'scale') {
                    btn.style.backgroundColor = engine.scaleNonUniform ? '#00ffff' : '#ffff00';
                } else {
                    btn.style.backgroundColor = '#ffff00';
                }
            } else {
                btn.style.backgroundColor = '#ffffff';
            }
            
            btn.style.color = '#000000';
            btn.style.border = '1px solid black';
            btn.style.boxShadow = '1px 1px 0px 0px black';
            
            btn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                
                if (mode === 'scale') {
                    if (engine.transformMode === 'scale') {
                        engine.scaleNonUniform = !engine.scaleNonUniform;
                    } else {
                        engine.transformMode = 'scale';
                        engine.scaleNonUniform = false; // Default to uniform
                    }
                } else {
                    engine.transformMode = mode;
                }
                
                // Update active states
                const btns = modesContainer.querySelectorAll('button');
                btns.forEach((b, idx) => {
                    const m = modes[idx];
                    if (!m) return;
                    if (m === engine.transformMode) {
                        if (m === 'scale') {
                            b.style.backgroundColor = engine.scaleNonUniform ? '#00ffff' : '#ffff00';
                        } else {
                            b.style.backgroundColor = '#ffff00';
                        }
                    } else {
                        b.style.backgroundColor = '#ffffff';
                    }
                });
                
                if (engine.app && typeof engine.app.setTool === 'function') {
                    engine.app.setTool('lasso', true);
                }
                if (engine._updateSelectionPreview) {
                    engine._updateSelectionPreview();
                }
                if (engine.refresh) {
                    engine.refresh();
                }
            };
            modesContainer.appendChild(btn);
        });

        // Append Mirror Button for easy visual flip access
        const mirrorBtn = document.createElement('button');
        mirrorBtn.className = 'brutal-btn';
        mirrorBtn.textContent = 'MIRROR';
        mirrorBtn.style.fontSize = '9px';
        mirrorBtn.style.fontFamily = 'monospace';
        mirrorBtn.style.fontWeight = '900';
        mirrorBtn.style.padding = '2px 6px';
        mirrorBtn.style.height = '20px';
        mirrorBtn.style.cursor = 'pointer';
        mirrorBtn.style.backgroundColor = '#ffffff';
        mirrorBtn.style.color = '#000000';
        mirrorBtn.style.border = '1px solid black';
        mirrorBtn.style.boxShadow = '1px 1px 0px 0px black';
        mirrorBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            engine.toggleFloatingSelectionMirrorX();
        };
        modesContainer.appendChild(mirrorBtn);
        
        toolbar.appendChild(modesContainer);
        engine.selectionOverlay.appendChild(toolbar);
    }
    if (toolbar) {
        const modesContainer = document.getElementById('selection-modes-container');
        
        // Expanded: flat, neat, clean container with a 2px solid black border (no brutal offset shadow)
        toolbar.style.backgroundColor = '#ebebeb';
        toolbar.style.border = '2px solid black';
        toolbar.style.boxShadow = 'none';
        toolbar.style.padding = '3px';
        
        if (modesContainer) {
            modesContainer.style.display = 'flex';
        }

        const modes = ['move', 'scale', 'rotate', 'opacity', 'deform'];
        const mContainer = document.getElementById('selection-modes-container');
        if (mContainer) {
            const btns = mContainer.querySelectorAll('button');
            btns.forEach((b, idx) => {
                const m = modes[idx];
                if (!m) return; // Skip mirror button
                if (m === (engine.transformMode || 'move')) {
                    if (m === 'scale') {
                        b.style.backgroundColor = engine.scaleNonUniform ? '#00ffff' : '#ffff00';
                    } else {
                        b.style.backgroundColor = '#ffff00';
                    }
                } else {
                    b.style.backgroundColor = '#ffffff';
                }
            });
        }
        
        const parentScaleX = (scX * engine.zoom) * mirrorX;
        const parentScaleY = (scY * engine.zoom) * mirrorY;
        const invScaleX = 1 / parentScaleX;
        const invScaleY = 1 / parentScaleY;
        toolbar.style.transform = `translateX(-50%) translateY(${12 * Math.abs(invScaleY)}px) scale(${invScaleX}, ${invScaleY})`;
    }

    // Update info status
    const comboScale = scX === scY ? `${Math.round(scX * 100)}%` : `X:${Math.round(scX * 100)}% Y:${Math.round(scY * 100)}%`;
    engine._status(`TRANSFORM: ${comboScale} | ${Math.round(rot * 180 / Math.PI)}° | OPACITY: ${Math.round(opacity * 100)}%`);
}

export function normalizeSelectionPath(path) {
    if (!path) return null;
    if (path.length === 0) return [];
    if (path[0] && Array.isArray(path[0].points)) {
        return path;
    }
    return [{ points: path, type: 'add' }];
}

export function drawSelectionMask(maskCtx, activeSelectionPath, lx, ly) {
    if (!activeSelectionPath) return;
    const norm = normalizeSelectionPath(activeSelectionPath);
    norm.forEach(sub => {
        if (sub.points.length < 3) return;
        maskCtx.save();
        if (sub.type === 'subtract') {
            maskCtx.globalCompositeOperation = 'destination-out';
        } else {
            maskCtx.globalCompositeOperation = 'source-over';
        }
        maskCtx.beginPath();
        sub.points.forEach((p, i) => {
            if (i === 0) maskCtx.moveTo(p.x - lx, p.y - ly);
            else maskCtx.lineTo(p.x - lx, p.y - ly);
        });
        maskCtx.closePath();
        maskCtx.fillStyle = '#ffffff';
        maskCtx.fill();
        maskCtx.restore();
    });
}

export function processLassoSelection(engine, e = null) {
    if (!engine.lassoPath || engine.lassoPath.length < 3) {
        engine.lassoPath = null;
        engine.refresh();
        return;
    }

    const strokeMode = engine.lassoStrokeMode;
    const isAdditive = strokeMode === 'add' || (strokeMode === undefined && (engine.keys['shift'] || (e && e.shiftKey)));
    const isSubtractive = strokeMode === 'subtract' || (strokeMode === undefined && (engine.keys['alt'] || (e && e.altKey)));

    const prevPath = engine._selectionBeforeStroke !== undefined ? engine._selectionBeforeStroke : (engine.activeSelectionPath ? 
        normalizeSelectionPath(engine.activeSelectionPath).map(p => ({ points: [...p.points], type: p.type })) : 
        null);

    let newPathList = [];
    if (prevPath) {
        newPathList = prevPath.map(p => ({ points: [...p.points], type: p.type }));
    }

    if (isAdditive) {
        newPathList.push({ points: [...engine.lassoPath], type: 'add' });
    } else if (isSubtractive) {
        newPathList.push({ points: [...engine.lassoPath], type: 'subtract' });
    } else {
        newPathList = [{ points: [...engine.lassoPath], type: 'add' }];
    }

    engine.activeSelectionPath = newPathList;
    
    // Push previous path to history so undo can go back
    engine._pushHistory({ type: 'selection', path: prevPath });

    engine.lassoPath = null;
    engine.refresh();
}

export function applySelection(engine) {
    if (!engine.floatingSelection) return;
    
    const sel = engine.floatingSelection;
    const { canvas, x, y, rotation, opacity, mirrorX, mirrorY } = sel;
    const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
    const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
    const rot = rotation || 0;
    const op = opacity !== undefined ? opacity : 1;
    
    const selW = sel.width || canvas.width;
    const selH = sel.height || canvas.height;

    // Calculate bounding box for rotated/scaled canvas to find relevant chunks
    const cos = Math.abs(Math.cos(rot));
    const sin = Math.abs(Math.sin(rot));
    const bbW = (canvas.width * scX * cos + canvas.height * scY * sin);
    const bbH = (canvas.width * scX * sin + canvas.height * scY * cos);

    const startCX = engine.isStatic ? 0 : Math.floor((x + selW / 2 - bbW / 2) / engine.chunkSize);
    const startCY = engine.isStatic ? 0 : Math.floor((y + selH / 2 - bbH / 2) / engine.chunkSize);
    const endCX = engine.isStatic ? 0 : Math.floor((x + selW / 2 + bbW / 2) / engine.chunkSize);
    const endCY = engine.isStatic ? 0 : Math.floor((y + selH / 2 + bbH / 2) / engine.chunkSize);

    const applyHistory = new Map();
    for (let cx = startCX; cx <= endCX; cx++) {
        for (let cy = startCY; cy <= endCY; cy++) {
            const id = `${cx},${cy}`;
            const chunk = engine._getChunk(cx, cy);
            const ctx = chunk.ctxs[engine.activeLayer];
            const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
            const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;

            // Backup for undo
            if (!applyHistory.has(id)) {
                const srcCanvas = chunk.canvases[engine.activeLayer];
                const backup = document.createElement('canvas');
                backup.width = srcCanvas.width;
                backup.height = srcCanvas.height;
                backup.getContext('2d').drawImage(srcCanvas, 0, 0);
                applyHistory.set(id, { layer: engine.activeLayer, canvas: backup });
            }

            ctx.save();
            // Pivot around the center of the selection in world space
            const worldPivotX = x + selW / 2;
            const worldPivotY = y + selH / 2;
            
            ctx.translate(worldPivotX - lx, worldPivotY - ly);
            ctx.rotate(rot);
            ctx.scale(scX * (mirrorX ? -1 : 1), scY * (mirrorY ? -1 : 1));
            ctx.globalAlpha = op;
            // Draw centered at the pivot
            ctx.drawImage(canvas, -canvas.width/2, -canvas.height/2);
            ctx.restore();
            
            engine._markDirty(id, engine.activeLayer);
        }
    }

    engine._pushHistory({ 
        type: 'stroke', 
        chunks: applyHistory,
        selection: { ...engine.floatingSelection } 
    });
    engine.floatingSelection = null;
    engine.transformHistory = [];
    engine.transformRedoHistory = [];
    engine._updateSelectionPreview();
    engine.refresh();
    engine._status('APPLIED');
    if (engine.onDrawEnd) engine.onDrawEnd();
}

export function warpSelectionImage(engine) {
    const sel = engine.floatingSelection;
    if (!sel || !sel.originalCanvas) return;
    
    const w = sel.canvas.width;
    const h = sel.canvas.height;
    
    // Clear target canvas
    const ctx = sel.canvas.getContext('2d');
    
    if (!sel.pins || sel.pins.length === 0) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(sel.originalCanvas, 0, 0);
        return;
    }
    
    ctx.clearRect(0, 0, w, h);
    
    // Divide into a mesh grid of e.g. 10x10 vertices
    const GRID_SIZE = 10;
    const vertices = [];
    
    // 1. Calculate displaced position of each vertex in the grid
    for (let i = 0; i <= GRID_SIZE; i++) {
        vertices[i] = [];
        const u = i / GRID_SIZE;
        const ox = u * w;
        
        for (let j = 0; j <= GRID_SIZE; j++) {
            const v = j / GRID_SIZE;
            const oy = v * h;
            
            // Calculate IDW displacement
            let sumW = 0;
            let dispX = 0;
            let dispY = 0;
            let exactMatch = false;
            
            for (const pin of sel.pins) {
                const dx = ox - pin.ox;
                const dy = oy - pin.oy;
                const distSq = dx * dx + dy * dy;
                
                if (distSq < 0.0001) {
                    dispX = pin.x - pin.ox;
                    dispY = pin.y - pin.oy;
                    exactMatch = true;
                    break;
                }
                
                const weight = 1.0 / distSq; // p = 2 is mathematically perfect and cheap
                sumW += weight;
                dispX += weight * (pin.x - pin.ox);
                dispY += weight * (pin.y - pin.oy);
            }
            
            let vx = ox;
            let vy = oy;
            
            if (exactMatch) {
                vx += dispX;
                vy += dispY;
            } else if (sumW > 0) {
                vx += dispX / sumW;
                vy += dispY / sumW;
            }
            
            vertices[i][j] = { x: vx, y: vy };
        }
    }
    
    // 2. Render triangles
    // Each quad has 2 triangles:
    // T1: (i, j) -> (i+1, j) -> (i, j+1)
    // T2: (i+1, j) -> (i+1, j+1) -> (i, j+1)
    for (let i = 0; i < GRID_SIZE; i++) {
        const u0 = (i / GRID_SIZE) * w;
        const u1 = ((i + 1) / GRID_SIZE) * w;
        
        for (let j = 0; j < GRID_SIZE; j++) {
            const v0 = (j / GRID_SIZE) * h;
            const v1 = ((j + 1) / GRID_SIZE) * h;
            
            // Quad vertices
            const q00 = vertices[i][j];
            const q10 = vertices[i+1][j];
            const q01 = vertices[i][j+1];
            const q11 = vertices[i+1][j+1];
            
            // Triangle 1
            drawTriangle(ctx, sel.originalCanvas, q00, q10, q01, u0, v0, u1, v0, u0, v1);
            // Triangle 2
            drawTriangle(ctx, sel.originalCanvas, q10, q11, q01, u1, v0, u1, v1, u0, v1);
        }
    }
}

function drawTriangle(ctx, image, p0, p1, p2, u0, v0, u1, v1, u2, v2) {
    // Forward transform mapping: source triangle (u, v) to destination triangle (p)
    const delta = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (Math.abs(delta) < 0.001) return;
    
    const A = (p0.x * (v1 - v2) + p1.x * (v2 - v0) + p2.x * (v0 - v1)) / delta;
    const C = (p0.x * (u2 - u1) + p1.x * (u0 - u2) + p2.x * (u1 - u0)) / delta;
    const E = (p0.x * (u1 * v2 - u2 * v1) + p1.x * (u2 * v0 - u0 * v2) + p2.x * (u0 * v1 - u1 * v0)) / delta;
    
    const B = (p0.y * (v1 - v2) + p1.y * (v2 - v0) + p2.y * (v0 - v1)) / delta;
    const D = (p0.y * (u2 - u1) + p1.y * (u0 - u2) + p2.y * (u1 - u0)) / delta;
    const F = (p0.y * (u1 * v2 - u2 * v1) + p1.y * (u2 * v0 - u0 * v2) + p2.y * (u0 * v1 - u1 * v0)) / delta;
    
    ctx.save();
    
    // Expand the clipping path slightly outwards from the triangle's centroid to eliminate anti-aliasing gaps.
    const cx = (p0.x + p1.x + p2.x) / 3;
    const cy = (p0.y + p1.y + p2.y) / 3;
    const EXPAND = 0.5;
    
    let d0x = p0.x - cx;
    let d0y = p0.y - cy;
    let l0 = Math.sqrt(d0x * d0x + d0y * d0y);
    const px0 = l0 > 0.001 ? p0.x + (d0x / l0) * EXPAND : p0.x;
    const py0 = l0 > 0.001 ? p0.y + (d0y / l0) * EXPAND : p0.y;
    
    let d1x = p1.x - cx;
    let d1y = p1.y - cy;
    let l1 = Math.sqrt(d1x * d1x + d1y * d1y);
    const px1 = l1 > 0.001 ? p1.x + (d1x / l1) * EXPAND : p1.x;
    const py1 = l1 > 0.001 ? p1.y + (d1y / l1) * EXPAND : p1.y;
    
    let d2x = p2.x - cx;
    let d2y = p2.y - cy;
    let l2 = Math.sqrt(d2x * d2x + d2y * d2y);
    const px2 = l2 > 0.001 ? p2.x + (d2x / l2) * EXPAND : p2.x;
    const py2 = l2 > 0.001 ? p2.y + (d2y / l2) * EXPAND : p2.y;
    
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.closePath();
    ctx.clip();
    
    ctx.transform(A, B, C, D, E, F);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
}
