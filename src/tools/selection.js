const ROTATE_BAND_PX = 90;
const _svgCursorCache = new Map();

function _makeSvgCursor(svgBody, hotX = 12, hotY = 12, fallback = 'default') {
    const key = `${hotX},${hotY}|${svgBody}`;
    let cached = _svgCursorCache.get(key);
    if (!cached) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${svgBody}</svg>`;
        cached = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
        _svgCursorCache.set(key, cached);
    }
    return cached;
}

function _getScaleCursor(angleRad, nonUniform = false) {
    const deg = Math.round((angleRad * 180) / Math.PI);
    const snapped = ((deg % 180) + 180) % 180; // double-ended arrow is symmetric mod 180
    const accent = nonUniform ? '#00ffff' : '#ffff00';
    return _makeSvgCursor(
        `<g transform="rotate(${snapped} 12 12)">` +
        `<path d="M3 12 L8 7.5 L8 10.5 L16 10.5 L16 7.5 L21 12 L16 16.5 L16 13.5 L8 13.5 L8 16.5 Z" fill="${accent}" stroke="#000000" stroke-width="1.5" stroke-linejoin="round"/>` +
        `</g>`,
        12, 12, 'nesw-resize'
    );
}

function _getRotateCursor(tangentAngleRad) {
    const deg = Math.round((tangentAngleRad * 180) / Math.PI);
    const qDeg = Math.round(deg / 5) * 5;
    return _makeSvgCursor(
        `<g transform="rotate(${qDeg} 12 12)">` +
        `<path d="M6.2 9.5 A6.8 6.8 0 0 1 17.8 9.5" fill="none" stroke="#000000" stroke-width="4" stroke-linecap="round"/>` +
        `<path d="M6.2 9.5 A6.8 6.8 0 0 1 17.8 9.5" fill="none" stroke="#ffff00" stroke-width="2" stroke-linecap="round"/>` +
        `<polygon points="3.5,8.5 8.5,6.5 7.5,11.8" fill="#ffff00" stroke="#000000" stroke-width="1.2" stroke-linejoin="round"/>` +
        `<polygon points="20.5,8.5 15.5,6.5 16.5,11.8" fill="#ffff00" stroke="#000000" stroke-width="1.2" stroke-linejoin="round"/>` +
        `</g>`,
        12, 12, 'grab'
    );
}

function _getMoveCursor() {
    return _makeSvgCursor(
        `<path d="M12 2 L15 5.5 L13.2 5.5 L13.2 10.8 L18.5 10.8 L18.5 9 L22 12 L18.5 15 L18.5 13.2 L13.2 13.2 L13.2 18.5 L15 18.5 L12 22 L9 18.5 L10.8 18.5 L10.8 13.2 L5.5 13.2 L5.5 15 L2 12 L5.5 9 L5.5 10.8 L10.8 10.8 L10.8 5.5 L9 5.5 Z" fill="#ffffff" stroke="#000000" stroke-width="1.3" stroke-linejoin="round"/>`,
        12, 12, 'move'
    );
}

export function isUnifiedTransformMode(mode) {
    return !mode || mode === 'move' || mode === 'transform' || mode === 'scale' || mode === 'rotate';
}

export function hitTestTransformGizmo(engine, clientX, clientY) {
    const sel = engine && engine.floatingSelection;
    if (!sel || !sel.canvas) return null;

    const rect = engine.getContainerRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const world = engine._screenToWorld(sx, sy);
    const wx = world.wx;
    const wy = world.wy;

    const selW = sel.width || sel.canvas.width;
    const selH = sel.height || sel.canvas.height;
    const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
    const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
    const rot = sel.rotation || 0;
    const zoom = engine.zoom || 1;

    const pivotX = sel.x + selW * 0.5;
    const pivotY = sel.y + selH * 0.5;
    const hw = (selW * scX) * 0.5;
    const hh = (selH * scY) * 0.5;

    const dx = wx - pivotX;
    const dy = wy - pivotY;
    const cosN = Math.cos(-rot);
    const sinN = Math.sin(-rot);
    const lx = dx * cosN - dy * sinN;
    const ly = dx * sinN + dy * cosN;

    const pxX = lx * zoom;
    const pxY = ly * zoom;
    const pxHW = hw * zoom;
    const pxHH = hh * zoom;

    const outX = Math.max(0, Math.abs(pxX) - pxHW);
    const outY = Math.max(0, Math.abs(pxY) - pxHH);
    const distOutside = Math.hypot(outX, outY);
    const isInsideBox = Math.abs(pxX) <= pxHW && Math.abs(pxY) <= pxHH;

    const mode = engine.transformMode || 'move';
    const baseHit = {
        mode,
        selW,
        selH,
        scX,
        scY,
        rot,
        pivotX,
        pivotY,
        wx,
        wy,
        lx,
        ly,
        pxX,
        pxY,
        pxHW,
        pxHH,
        distOutside
    };

    if (mode === 'deform') {
        if (isInsideBox || distOutside <= 14) {
            return { ...baseHit, zone: 'deform', handle: null, cursorAngle: 0 };
        }
        return { ...baseHit, zone: 'apply', handle: null, cursorAngle: 0 };
    }

    if (mode === 'opacity') {
        if (isInsideBox || distOutside <= 14) {
            return { ...baseHit, zone: 'opacity', handle: null, cursorAngle: 0 };
        }
        return { ...baseHit, zone: 'apply', handle: null, cursorAngle: 0 };
    }

    // Unified Gizmo Mode: Corner/Side handles -> Scale, Inside -> Move, Outside halo -> Rotate
    const pivotScreen = engine._worldToScreen(pivotX, pivotY);
    const computeHandleScreenAngle = (hx, hy) => {
        const cosP = Math.cos(rot);
        const sinP = Math.sin(rot);
        const offX = hx * hw;
        const offY = hy * hh;
        const hwx = pivotX + offX * cosP - offY * sinP;
        const hwy = pivotY + offX * sinP + offY * cosP;
        const hs = engine._worldToScreen(hwx, hwy);
        return Math.atan2(hs.y - pivotScreen.y, hs.x - pivotScreen.x);
    };

    const minDim = Math.min(pxHW * 2, pxHH * 2);
    const cornerHitR = Math.min(14, Math.max(6, minDim * 0.35 + 4));

    const corners = [
        { id: 'tl', hx: -1, hy: -1, ax: 1, ay: 1 },
        { id: 'tr', hx: 1, hy: -1, ax: -1, ay: 1 },
        { id: 'bl', hx: -1, hy: 1, ax: 1, ay: -1 },
        { id: 'br', hx: 1, hy: 1, ax: -1, ay: -1 }
    ];

    let bestCorner = null;
    let bestCornerDist = Infinity;
    for (const c of corners) {
        const d = Math.hypot(pxX - c.hx * pxHW, pxY - c.hy * pxHH);
        if (d <= cornerHitR && d < bestCornerDist) {
            bestCornerDist = d;
            bestCorner = c;
        }
    }
    if (bestCorner) {
        return {
            ...baseHit,
            zone: 'scale',
            handleKind: 'corner',
            handle: bestCorner.id,
            hx: bestCorner.hx,
            hy: bestCorner.hy,
            ax: bestCorner.ax,
            ay: bestCorner.ay,
            cursorAngle: computeHandleScreenAngle(bestCorner.hx, bestCorner.hy)
        };
    }

    // Side midpoint handles + grabbing directly along side borders
    const sides = [
        { id: 't', hx: 0, hy: -1, ax: 0, ay: 1, show: pxHW * 2 >= 26 },
        { id: 'b', hx: 0, hy: 1, ax: 0, ay: -1, show: pxHW * 2 >= 26 },
        { id: 'l', hx: -1, hy: 0, ax: 1, ay: 0, show: pxHH * 2 >= 26 },
        { id: 'r', hx: 1, hy: 0, ax: -1, ay: 0, show: pxHH * 2 >= 26 }
    ];

    let bestSide = null;
    let bestSideDist = Infinity;
    for (const s of sides) {
        if (!s.show) continue;
        const dKnob = Math.hypot(pxX - s.hx * pxHW, pxY - s.hy * pxHH);
        const onVerticalEdge = s.hx !== 0 && Math.abs(pxX - s.hx * pxHW) <= 7 && Math.abs(pxY) <= Math.max(0, pxHH - 8);
        const onHorizontalEdge = s.hy !== 0 && Math.abs(pxY - s.hy * pxHH) <= 7 && Math.abs(pxX) <= Math.max(0, pxHW - 8);
        const edgeDist = onVerticalEdge ? Math.abs(pxX - s.hx * pxHW) : (onHorizontalEdge ? Math.abs(pxY - s.hy * pxHH) : Infinity);
        const effDist = Math.min(dKnob <= 13 ? dKnob : Infinity, edgeDist);
        if (effDist < bestSideDist) {
            bestSideDist = effDist;
            bestSide = s;
        }
    }
    if (bestSide) {
        return {
            ...baseHit,
            zone: 'scale',
            handleKind: 'side',
            handle: bestSide.id,
            hx: bestSide.hx,
            hy: bestSide.hy,
            ax: bestSide.ax,
            ay: bestSide.ay,
            cursorAngle: computeHandleScreenAngle(bestSide.hx, bestSide.hy)
        };
    }

    // Inside box -> Move
    if (isInsideBox) {
        return {
            ...baseHit,
            zone: 'move',
            handle: null,
            cursorAngle: 0
        };
    }

    // Outside box -> Rotate within outer rotate band
    if (distOutside <= ROTATE_BAND_PX) {
        const tangentAngle = Math.atan2(sy - pivotScreen.y, sx - pivotScreen.x) + Math.PI * 0.5;
        return {
            ...baseHit,
            zone: 'rotate',
            handle: null,
            cursorAngle: tangentAngle
        };
    }

    // Far outside -> Click to apply & exit transform
    return {
        ...baseHit,
        zone: 'apply',
        handle: null,
        cursorAngle: 0
    };
}

function _ensureGizmoPrompt(engine) {
    if (!engine || !engine.uiLayer) return null;
    let prompt = document.getElementById('gizmo-prompt');
    if (!prompt) {
        prompt = document.createElement('div');
        prompt.id = 'gizmo-prompt';
        prompt.className = 'gizmo-prompt pointer-events-none hidden';
        engine.uiLayer.appendChild(prompt);
    }
    return prompt;
}

export function clearGizmoHoverUI(engine) {
    if (!engine) return;
    engine._gizmoCursor = null;
    engine._hoveredGizmoZone = null;
    const prompt = document.getElementById('gizmo-prompt');
    if (prompt) prompt.classList.add('hidden');
    if (engine.selectionOverlay) {
        engine.selectionOverlay.classList.remove('gizmo-rotate-hover');
        const handles = engine.selectionOverlay.querySelectorAll('.gizmo-handle');
        handles.forEach(h => {
            h.classList.remove('active-handle', 'alt-handle');
        });
    }
}

export function updateGizmoHoverUI(engine, clientX, clientY, isAltDown = false, hitOverride = null) {
    if (!engine || !engine.floatingSelection) {
        clearGizmoHoverUI(engine);
        return null;
    }

    const hit = hitOverride || hitTestTransformGizmo(engine, clientX, clientY);
    if (!hit) {
        clearGizmoHoverUI(engine);
        return null;
    }

    engine._hoveredGizmoZone = hit;

    const sel = engine.floatingSelection;
    const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
    const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
    const rotDeg = Math.round(((sel.rotation || 0) * 180) / Math.PI);
    const opPct = Math.round((sel.opacity !== undefined ? sel.opacity : 1) * 100);

    let cursor = 'crosshair';
    let label = '';
    let promptAccent = '';

    if (hit.zone === 'scale') {
        cursor = _getScaleCursor(hit.cursorAngle, isAltDown);
        if (engine.isDrawing && engine._gizmoDrag) {
            label = Math.abs(scX - scY) < 0.005
                ? `SCALE ${Math.round(scX * 100)}%`
                : `X:${Math.round(scX * 100)}% Y:${Math.round(scY * 100)}%`;
        } else {
            label = isAltDown ? 'NON-UNIFORM SCALE [ALT]' : 'SCALE (HOLD ALT: NON-UNIFORM)';
        }
        promptAccent = isAltDown ? 'alt' : 'active';
    } else if (hit.zone === 'rotate') {
        cursor = _getRotateCursor(hit.cursorAngle);
        label = (engine.isDrawing && engine._gizmoDrag)
            ? `↻ ${rotDeg}°`
            : '↻ ROTATE';
        promptAccent = 'active';
    } else if (hit.zone === 'move') {
        cursor = _getMoveCursor();
        label = (engine.isDrawing && engine._gizmoDrag) ? 'MOVING' : 'MOVE';
        promptAccent = '';
    } else if (hit.zone === 'opacity') {
        cursor = 'ns-resize';
        label = `OPACITY ${opPct}%`;
        promptAccent = '';
    } else if (hit.zone === 'deform') {
        cursor = 'crosshair';
        label = 'PIN WARP';
        promptAccent = '';
    } else if (hit.zone === 'apply') {
        cursor = 'pointer';
        label = 'CLICK TO APPLY';
        promptAccent = 'muted';
    }

    engine._gizmoCursor = cursor;
    if (engine.container && !engine.isPanning && !engine.isZooming && !engine.keys[' '] && !engine.keys['z']) {
        engine.container.style.cursor = cursor;
    }

    if (engine.selectionOverlay) {
        engine.selectionOverlay.classList.toggle('gizmo-rotate-hover', hit.zone === 'rotate');
        const handles = engine.selectionOverlay.querySelectorAll('.gizmo-handle');
        handles.forEach(h => {
            const isActive = hit.zone === 'scale' && h.dataset.handle === hit.handle;
            h.classList.toggle('active-handle', isActive && !isAltDown);
            h.classList.toggle('alt-handle', isActive && isAltDown);
        });
    }

    const prompt = _ensureGizmoPrompt(engine);
    if (prompt) {
        if (label) {
            const rect = engine.getContainerRect();
            const px = Math.max(8, Math.min(rect.width - 180, (clientX - rect.left) + 16));
            const py = Math.max(8, Math.min(rect.height - 28, (clientY - rect.top) + 18));
            prompt.textContent = label;
            prompt.style.left = `${px}px`;
            prompt.style.top = `${py}px`;
            prompt.dataset.accent = promptAccent;
            prompt.classList.remove('hidden');
        } else {
            prompt.classList.add('hidden');
        }
    }

    return hit;
}

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
        const staleToolbar = document.getElementById('selection-mode-toolbar');
        if (staleToolbar) staleToolbar.remove();
        clearGizmoHoverUI(engine);

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
        engine.selectionOverlay.style.outline = '1px dashed #ffffff';
        engine.selectionOverlay.style.boxShadow = '0 0 0 1px #000000, 0 0 0 2px #ffffff';
        engine.uiLayer.appendChild(engine.selectionOverlay);
    }

    const boxW = Math.max(1, selW * scX * engine.zoom);
    const boxH = Math.max(1, selH * scY * engine.zoom);
    engine.selectionOverlay.style.width = `${boxW}px`;
    engine.selectionOverlay.style.height = `${boxH}px`;

    // Pivot point calculation in screen space
    const worldPivotX = sel.x + selW / 2;
    const worldPivotY = sel.y + selH / 2;
    const s = engine._worldToScreen(worldPivotX, worldPivotY);

    const rot = (sel.rotation || 0);
    const opacity = (sel.opacity !== undefined ? sel.opacity : 1);

    const mirrorXSign = (sel.mirrorX ? -1 : 1) * (engine.isMirrored ? -1 : 1);
    const mirrorYSign = sel.mirrorY ? -1 : 1;
    const finalRot = engine.isMirrored ? (-rot + engine.rotation) : (rot + engine.rotation);

    engine.selectionOverlay.style.left = '0px';
    engine.selectionOverlay.style.top = '0px';
    engine.selectionOverlay.style.transformOrigin = 'center center';
    engine.selectionOverlay.style.transform = `translate3d(${s.x}px, ${s.y}px, 0px) translate3d(-50%, -50%, 0px) rotate(${finalRot}rad)`;
    engine.selectionOverlay.style.opacity = '1';

    const currentMode = engine.transformMode || 'move';
    const unified = isUnifiedTransformMode(currentMode);

    // Unified Move/Scale/Rotate Handles & Center Pivot
    let gizmoLayer = engine.selectionOverlay.querySelector('.gizmo-handles-layer');
    if (unified) {
        if (!gizmoLayer) {
            gizmoLayer = document.createElement('div');
            gizmoLayer.className = 'gizmo-handles-layer';

            const pivot = document.createElement('div');
            pivot.className = 'gizmo-pivot';
            gizmoLayer.appendChild(pivot);

            const handleSpecs = [
                { id: 'tl', kind: 'corner', left: '0%', top: '0%' },
                { id: 'tr', kind: 'corner', left: '100%', top: '0%' },
                { id: 'bl', kind: 'corner', left: '0%', top: '100%' },
                { id: 'br', kind: 'corner', left: '100%', top: '100%' },
                { id: 't', kind: 'edge-h', left: '50%', top: '0%' },
                { id: 'b', kind: 'edge-h', left: '50%', top: '100%' },
                { id: 'l', kind: 'edge-v', left: '0%', top: '50%' },
                { id: 'r', kind: 'edge-v', left: '100%', top: '50%' }
            ];
            handleSpecs.forEach(spec => {
                const h = document.createElement('div');
                h.className = `gizmo-handle gizmo-handle-${spec.kind}`;
                h.dataset.handle = spec.id;
                h.style.left = spec.left;
                h.style.top = spec.top;
                gizmoLayer.appendChild(h);
            });
            engine.selectionOverlay.appendChild(gizmoLayer);
        }

        gizmoLayer.style.display = 'block';
        const showTopBottomEdges = boxW >= 26;
        const showLeftRightEdges = boxH >= 26;
        gizmoLayer.querySelectorAll('.gizmo-handle').forEach(h => {
            const id = h.dataset.handle;
            if (id === 't' || id === 'b') {
                h.style.display = showTopBottomEdges ? 'block' : 'none';
            } else if (id === 'l' || id === 'r') {
                h.style.display = showLeftRightEdges ? 'block' : 'none';
            } else {
                h.style.display = 'block';
            }
        });
    } else if (gizmoLayer) {
        gizmoLayer.style.display = 'none';
    }

    // Puppet pin drawing and event handling
    const existingPins = engine.selectionOverlay.querySelectorAll('.brutal-pin');
    existingPins.forEach(p => p.remove());

    if (currentMode === 'deform') {
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

        engine.selectionOverlay.style.pointerEvents = 'auto';

        // Draw pin circles
        sel.pins.forEach(pin => {
            const pinEl = document.createElement('div');
            pinEl.className = 'absolute brutal-pin';
            pinEl.style.width = '12px';
            pinEl.style.height = '12px';
            pinEl.style.borderRadius = '50%';
            pinEl.style.border = '2px solid black';

            if (pin.type === 'corner') {
                pinEl.style.backgroundColor = '#00ffff';
            } else if (pin.type === 'center') {
                pinEl.style.backgroundColor = '#ff00ff';
            } else {
                pinEl.style.backgroundColor = '#00ff00';
            }

            const uPct = ((pin.x - margin) / origW) * 100;
            const vPct = ((pin.y - margin) / origH) * 100;
            pinEl.style.transform = 'translate(-50%, -50%)';
            pinEl.style.left = `${mirrorXSign < 0 ? (100 - uPct) : uPct}%`;
            pinEl.style.top = `${mirrorYSign < 0 ? (100 - vPct) : vPct}%`;
            pinEl.style.cursor = 'move';
            pinEl.style.pointerEvents = 'auto';
            pinEl.style.zIndex = '120';

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

                        const sX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
                        const sY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
                        const curRot = engine.isMirrored
                            ? (-(sel.rotation || 0) + (engine.rotation || 0))
                            : ((sel.rotation || 0) + (engine.rotation || 0));
                        const cosRot = Math.cos(-curRot);
                        const sinRot = Math.sin(-curRot);

                        let localDx = dx * cosRot - dy * sinRot;
                        let localDy = dx * sinRot + dy * cosRot;

                        localDx /= (sX * engine.zoom);
                        localDy /= (sY * engine.zoom);

                        if (sel.mirrorX) localDx *= -1;
                        if (sel.mirrorY) localDy *= -1;
                        if (engine.isMirrored) localDx *= -1;

                        pin.x = engine.pinDragStartPos.x + localDx;
                        pin.y = engine.pinDragStartPos.y + localDy;

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

            const m = engine._getMousePos(pe);
            const cx = sel.x + origW / 2;
            const cy = sel.y + origH / 2;
            const dx = m.wx - cx;
            const dy = m.wy - cy;

            const curRot = sel.rotation || 0;
            const localXCent = dx * Math.cos(-curRot) - dy * Math.sin(-curRot);
            const localYCent = dx * Math.sin(-curRot) + dy * Math.cos(-curRot);

            const mX = sel.mirrorX ? -1 : 1;
            const mY = sel.mirrorY ? -1 : 1;

            const localX = (localXCent / (sX * mX)) + origW / 2 + margin;
            const localY = (localYCent / (sY * mY)) + origH / 2 + margin;

            if (localX >= 0 && localX <= w && localY >= 0 && localY <= h) {
                const clickedNearPin = sel.pins.some(p => {
                    const d = Math.sqrt((p.x - localX)**2 + (p.y - localY)**2);
                    return d < 18;
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
            engine.selectionOverlay.style.pointerEvents = 'none';
            engine.selectionOverlay.onpointerdown = null;
        }
    }

    // Position/update the selectionCanvas on each attached chunk (or render directly via WebGL2 GPURenderer)
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

            const sCtx = chunk.selectionCtx;
            sCtx.clearRect(0, 0, chunk.width, chunk.height);

            const cxWorld = engine.isStatic ? -engine.staticWidth / 2 : chunk.cx * engine.chunkSize;
            const cyWorld = engine.isStatic ? -engine.staticHeight / 2 : chunk.cy * engine.chunkSize;

            sCtx.save();
            sCtx.globalAlpha = opacity;
            sCtx.translate(-cxWorld, -cyWorld);
            sCtx.translate(worldPivotX, worldPivotY);
            if (sel.rotation) {
                sCtx.rotate(sel.rotation);
            }
            const mX = sel.mirrorX ? -1 : 1;
            const mY = sel.mirrorY ? -1 : 1;
            sCtx.scale(scX * mX, scY * mY);
            sCtx.drawImage(sel.canvas, -sel.canvas.width / 2, -sel.canvas.height / 2);
            sCtx.restore();
        });
    }

    // Create/update the screen-aligned floating mode toolbar below the selection's bounding box
    let toolbar = document.getElementById('selection-mode-toolbar');
    const toolbarBtns = [
        { id: 'move', label: 'TRANSFORM' },
        { id: 'opacity', label: 'OPACITY' },
        { id: 'deform', label: 'DEFORM' }
    ];

    if (!toolbar && engine.uiLayer) {
        toolbar = document.createElement('div');
        toolbar.id = 'selection-mode-toolbar';
        toolbar.className = 'absolute pointer-events-auto';
        toolbar.style.display = 'flex';
        toolbar.style.gap = '3px';
        toolbar.style.padding = '3px';
        toolbar.style.backgroundColor = '#ebebeb';
        toolbar.style.border = '2px solid black';
        toolbar.style.boxShadow = 'none';
        toolbar.style.zIndex = '115';

        const modesContainer = document.createElement('div');
        modesContainer.id = 'selection-modes-container';
        modesContainer.style.display = 'flex';
        modesContainer.style.gap = '3px';

        const makeToolbarBtn = (text) => {
            const b = document.createElement('button');
            b.className = 'brutal-btn';
            b.textContent = text;
            b.style.fontSize = '9px';
            b.style.fontFamily = 'monospace';
            b.style.fontWeight = '900';
            b.style.padding = '2px 6px';
            b.style.height = '20px';
            b.style.cursor = 'pointer';
            b.style.color = '#000000';
            b.style.border = '1px solid black';
            b.style.boxShadow = '1px 1px 0px 0px black';
            b.style.backgroundColor = '#ffffff';
            return b;
        };

        toolbarBtns.forEach(item => {
            const btn = makeToolbarBtn(item.label);
            btn.dataset.mode = item.id;
            btn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                engine.transformMode = item.id;
                if (engine._updateSelectionPreview) {
                    engine._updateSelectionPreview();
                }
                if (engine.refresh) {
                    engine.refresh();
                }
            };
            modesContainer.appendChild(btn);
        });

        const mirrorBtn = makeToolbarBtn('MIRROR');
        mirrorBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            engine.toggleFloatingSelectionMirrorX();
        };
        modesContainer.appendChild(mirrorBtn);

        const applyBtn = makeToolbarBtn('APPLY');
        applyBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            engine._applySelection();
        };
        modesContainer.appendChild(applyBtn);

        toolbar.appendChild(modesContainer);
        engine.uiLayer.appendChild(toolbar);
    }

    if (toolbar) {
        const modesContainer = document.getElementById('selection-modes-container');
        if (modesContainer) {
            const activeModeKey = unified ? 'move' : currentMode;
            modesContainer.querySelectorAll('button[data-mode]').forEach(b => {
                b.style.backgroundColor = (b.dataset.mode === activeModeKey) ? '#ffff00' : '#ffffff';
            });
        }

        // Anchor horizontally upright below the lowest screen corner of the rotated box
        const absC = Math.abs(Math.cos(finalRot));
        const absS = Math.abs(Math.sin(finalRot));
        const screenHalfSpanY = (boxW * 0.5) * absS + (boxH * 0.5) * absC;
        const containerRect = engine.getContainerRect();
        const tbWidth = toolbar.offsetWidth || 260;
        const tbHeight = toolbar.offsetHeight || 28;
        const margin = 8;

        const targetX = Math.max(
            tbWidth * 0.5 + margin,
            Math.min((containerRect.width || 800) - tbWidth * 0.5 - margin, s.x)
        );
        const targetY = Math.max(
            margin,
            Math.min((containerRect.height || 600) - tbHeight - margin, s.y + screenHalfSpanY + 14)
        );

        toolbar.style.left = `${targetX}px`;
        toolbar.style.top = `${targetY}px`;
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'translateX(-50%)';
    }

    // Update info status
    const comboScale = Math.abs(scX - scY) < 0.005 ? `${Math.round(scX * 100)}%` : `X:${Math.round(scX * 100)}% Y:${Math.round(scY * 100)}%`;
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
    engine._gizmoDrag = null;
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
