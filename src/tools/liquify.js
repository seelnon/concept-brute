import { wasmCore } from '../wasm/wasmBridge.js';

/**
 * Stamps chunk image data into the WASM session for the given world region.
 * Avoids redundant DOM allocations and reads only the session sub-rect in static mode.
 */
function _stampChunksInRegion(engine, stroke, minWorldX, maxWorldX, minWorldY, maxWorldY) {
    const sCX = engine.isStatic ? 0 : Math.floor(minWorldX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor(maxWorldX / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(minWorldY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor(maxWorldY / engine.chunkSize);

    const touchedChunks = [];
    for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
            const chunk = engine._getChunk(cx, cy);
            if (!chunk) continue;
            const id = `${cx},${cy}`;
            touchedChunks.push({ id, chunk, cx, cy });

            // Back up chunk for undo/redo (once per stroke)
            if (!engine.currentStrokeDirtyChunks.has(id)) {
                const srcCanvas = chunk.canvases[engine.activeLayer];
                const backup = document.createElement('canvas');
                backup.width = srcCanvas.width;
                backup.height = srcCanvas.height;
                backup.getContext('2d').drawImage(srcCanvas, 0, 0);
                engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
                engine._markDirty(id, engine.activeLayer);
            }

            // Stamp pristine image into WASM session once per chunk
            if (!stroke.stampedChunks.has(id)) {
                const backupCanvas = engine.currentStrokeDirtyChunks.get(id).canvas;
                const backupCtx = backupCanvas.getContext('2d');
                const clx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
                const cly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;

                if (engine.isStatic) {
                    // For static canvas: only read the active session sub-rectangle (0 lag!)
                    const clipMinX = Math.max(clx, stroke.originX);
                    const clipMaxX = Math.min(clx + engine.staticWidth, stroke.originX + stroke.width);
                    const clipMinY = Math.max(cly, stroke.originY);
                    const clipMaxY = Math.min(cly + engine.staticHeight, stroke.originY + stroke.height);

                    if (clipMaxX > clipMinX && clipMaxY > clipMinY) {
                        const srcX = Math.round(clipMinX - clx);
                        const srcY = Math.round(clipMinY - cly);
                        const stampW = Math.round(clipMaxX - clipMinX);
                        const stampH = Math.round(clipMaxY - clipMinY);
                        const dstX = Math.round(clipMinX - stroke.originX);
                        const dstY = Math.round(clipMinY - stroke.originY);

                        const imgData = backupCtx.getImageData(srcX, srcY, stampW, stampH);
                        wasmCore.liquifySessionStampSrc(imgData.data, stampW, stampH, dstX, dstY);
                    }
                } else {
                    // Infinite canvas chunk (512x512)
                    const imgData = backupCtx.getImageData(0, 0, backupCanvas.width, backupCanvas.height);
                    const dstX = Math.round(clx - stroke.originX);
                    const dstY = Math.round(cly - stroke.originY);
                    wasmCore.liquifySessionStampSrc(imgData.data, backupCanvas.width, backupCanvas.height, dstX, dstY);
                }
                stroke.stampedChunks.add(id);
            }
        }
    }
    return touchedChunks;
}

/**
 * Initializes a new Liquify stroke session.
 * Reuses persistent WebAssembly memory for 0-lag instant responsiveness.
 * Immediately pre-warms the starting chunk so the first movement has zero hesitation.
 */
export function startLiquifyStroke(engine, worldPos) {
    if (engine.activeLayer === 0) return;
    if (engine.layerSettings[engine.activeLayer]?.locked) return;

    // Grid cell size adapts to quality setting:
    // 1 (FAST): 12px, 2 (RESOLVE): 8px, 3 (ULTRA): 4px
    let cellSize = 8.0;
    if (engine.brush.liquifyQuality === 1) cellSize = 12.0;
    else if (engine.brush.liquifyQuality === 3) cellSize = 4.0;

    // Scale up cell size for extremely large brushes to preserve 120 FPS
    if (engine.brush.size > 300) {
        cellSize = Math.max(cellSize, 12.0);
    }
    if (engine.brush.size > 700) {
        cellSize = Math.max(cellSize, 16.0);
    }

    let originX, originY, width, height;
    if (engine.isStatic) {
        // Generous continuous session centered around starting brush position
        width = Math.min(2048, engine.staticWidth);
        height = Math.min(2048, engine.staticHeight);
        originX = Math.floor((worldPos.x - width / 2) / 64) * 64;
        originY = Math.floor((worldPos.y - height / 2) / 64) * 64;

        // Keep session inside static bounds
        const clx = -engine.staticWidth / 2;
        const cly = -engine.staticHeight / 2;
        originX = Math.max(clx, Math.min(clx + engine.staticWidth - width, originX));
        originY = Math.max(cly, Math.min(cly + engine.staticHeight - height, originY));
    } else {
        // Continuous region centered around the starting brush position
        width = 2048;
        height = 2048;
        originX = Math.floor((worldPos.x - width / 2) / 64) * 64;
        originY = Math.floor((worldPos.y - height / 2) / 64) * 64;
    }

    wasmCore.liquifySessionStart(width, height, cellSize, originX, originY);

    const stroke = {
        originX,
        originY,
        width,
        height,
        cellSize,
        stampedChunks: new Set(),
        lastPos: { x: worldPos.x, y: worldPos.y },
        active: true
    };
    engine.liquifyStroke = stroke;

    // Pre-stamp the chunk(s) under the cursor immediately upon pointerdown!
    // This completely eliminates any initialization lag when dragging begins!
    const R = Math.max(4.0, (engine.brush.size || 50) / 2);
    _stampChunksInRegion(engine, stroke, worldPos.x - R - 16, worldPos.x + R + 16, worldPos.y - R - 16, worldPos.y + R + 16);
}

/**
 * Executes a continuous Liquify brush move using the Rust WASM session.
 * Warps only the affected sub-box with full bilinear interpolation directly from
 * the original pristine stroke backup (Zero loss in image quality).
 */
export function paintLiquifyStroke(engine, from, to, dynamicSize, pressure) {
    if (engine.activeLayer === 0) return;
    if (engine.layerSettings[engine.activeLayer]?.locked) return;

    if (!engine.liquifyStroke || !engine.liquifyStroke.active) {
        startLiquifyStroke(engine, from);
    }

    const stroke = engine.liquifyStroke;
    if (!stroke || !stroke.active) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.2) return;

    const currentSize = dynamicSize || engine.brush.size || 50;
    const R = Math.max(4.0, currentSize / 2);
    const flow = engine.brush.flow || 0.40;
    const press = (pressure !== undefined && Number.isFinite(pressure)) ? pressure : 1.0;
    const strength = flow * (0.35 + 0.65 * press);
    const falloff = engine.brush.falloff ?? 0.50;

    // If brush travels near the edge in infinite canvas, re-center the session
    if (!engine.isStatic) {
        const margin = R + 64;
        if (to.x - stroke.originX < margin || 
            to.x - stroke.originX > stroke.width - margin ||
            to.y - stroke.originY < margin || 
            to.y - stroke.originY > stroke.height - margin) {
            startLiquifyStroke(engine, to);
        }
    }

    // 1. Identify all chunks overlapping the brush bounding box & ensure stamped
    const minWorldX = Math.floor(Math.min(from.x, to.x) - R - 8);
    const maxWorldX = Math.ceil(Math.max(from.x, to.x) + R + 8);
    const minWorldY = Math.floor(Math.min(from.y, to.y) - R - 8);
    const maxWorldY = Math.ceil(Math.max(from.y, to.y) + R + 8);

    const touchedChunks = _stampChunksInRegion(engine, stroke, minWorldX, maxWorldX, minWorldY, maxWorldY);
    if (touchedChunks.length === 0) return;

    // 2. Displace the 2D grid inside Rust WASM (Semi-Lagrangian advection kernel)
    wasmCore.liquifySessionDisplace(
        from.x,
        from.y,
        dx * strength,
        dy * strength,
        R,
        falloff
    );

    // 3. For each affected chunk, warp only its overlapping portion using Rust WASM
    // and write directly to the activeLayer canvas
    touchedChunks.forEach(({ id, chunk, cx, cy }) => {
        const clx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
        const cly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
        const chunkW = engine.isStatic ? engine.staticWidth : engine.chunkSize;
        const chunkH = engine.isStatic ? engine.staticHeight : engine.chunkSize;

        const iMinWorldX = Math.max(clx, minWorldX);
        const iMaxWorldX = Math.min(clx + chunkW - 1, maxWorldX);
        const iMinWorldY = Math.max(cly, minWorldY);
        const iMaxWorldY = Math.min(cly + chunkH - 1, maxWorldY);

        if (iMaxWorldX < iMinWorldX || iMaxWorldY < iMinWorldY) return;

        // Sub-box coordinates within the session
        const sMinX = Math.round(iMinWorldX - stroke.originX);
        const sMaxX = Math.round(iMaxWorldX - stroke.originX);
        const sMinY = Math.round(iMinWorldY - stroke.originY);
        const sMaxY = Math.round(iMaxWorldY - stroke.originY);

        const boxW = sMaxX - sMinX + 1;
        const boxH = sMaxY - sMinY + 1;
        if (boxW <= 0 || boxH <= 0) return;

        const chunkCtx = chunk.ctxs[engine.activeLayer];
        if (!chunk._cachedBoxImageData || chunk._cachedBoxImageData.width !== boxW || chunk._cachedBoxImageData.height !== boxH) {
            chunk._cachedBoxImageData = chunkCtx.createImageData(boxW, boxH);
        }
        const boxImageData = chunk._cachedBoxImageData;

        // Pure Rust bilinear warping of this sub-box directly from original stamped image
        const ok = wasmCore.liquifySessionWarpBox(sMinX, sMaxX, sMinY, sMaxY, boxImageData.data);
        if (ok) {
            const localDstX = Math.round(iMinWorldX - clx);
            const localDstY = Math.round(iMinWorldY - cly);
            chunkCtx.putImageData(boxImageData, localDstX, localDstY);
            engine._markDirty(id, engine.activeLayer, false);
            if (engine.gpuRenderer) {
                engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
            }
        }
    });

    stroke.lastPos = { x: to.x, y: to.y };
    engine.refresh();
}

/**
 * Concludes the Liquify stroke session and cleans up WASM scratch memory.
 */
export function endLiquifyStroke(engine) {
    if (engine.liquifyStroke) {
        engine.liquifyStroke.active = false;
        engine.liquifyStroke = null;
    }
    wasmCore.liquifySessionEnd();
}

// ============================================================================
// COMPATIBILITY INTERFACES FOR LEGACY ENGINE CALLERS
// ============================================================================

export function displaceLiquifyCoords(engine, p0, p1, affectedThisFrame) {
    paintLiquifyStroke(engine, p0, p1, engine.brush.size, 1.0);
}

export function renderLiquifyChunks(engine, affectedThisFrame, forceBilinear = false) {
    // Already rendered directly to chunk canvases in paintLiquifyStroke
    engine.refresh();
}

export function getOriginalChunkDataFromId(engine, id) {
    const backupData = engine.currentStrokeDirtyChunks?.get(id);
    if (backupData) {
        const backupCtx = backupData.canvas.getContext('2d');
        return backupCtx.getImageData(0, 0, backupData.canvas.width, backupData.canvas.height).data;
    }
    const chunk = engine.chunks?.get(id);
    if (!chunk) return null;
    const ctx = chunk.ctxs[engine.activeLayer];
    return ctx.getImageData(0, 0, chunk.width, chunk.height).data;
}

export function getIntPixelDataAndIdx(engine, wx, wy, chunkCache) {
    const cx = engine.isStatic ? 0 : Math.floor(wx / engine.chunkSize);
    const cy = engine.isStatic ? 0 : Math.floor(wy / engine.chunkSize);
    const id = `${cx},${cy}`;

    let data = chunkCache.get(id);
    if (data === undefined) {
        data = getOriginalChunkDataFromId(engine, id);
        chunkCache.set(id, data);
    }
    if (!data) return false;

    const clx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
    const cly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
    const w = engine.isStatic ? engine.staticWidth : engine.chunkSize;
    const h = engine.isStatic ? engine.staticHeight : engine.chunkSize;
    const lx = Math.max(0, Math.min(w - 1, Math.floor(wx - clx)));
    const ly = Math.max(0, Math.min(h - 1, Math.floor(wy - cly)));

    engine._tempData = data;
    engine._tempIdx = (ly * w + lx) * 4;
    return true;
}

export function sampleOriginalWorldPixel(engine, wx, wy, chunkCache, dstData, dstIdx) {
    const x0 = Math.floor(wx);
    const x1 = x0 + 1;
    const y0 = Math.floor(wy);
    const y1 = y0 + 1;
    const tx = wx - x0;
    const ty = wy - y0;

    let c00_r = 0, c00_g = 0, c00_b = 0, c00_a = 0;
    if (getIntPixelDataAndIdx(engine, x0, y0, chunkCache)) {
        const d = engine._tempData, idx = engine._tempIdx;
        c00_r = d[idx]; c00_g = d[idx + 1]; c00_b = d[idx + 2]; c00_a = d[idx + 3];
    }
    let c10_r = 0, c10_g = 0, c10_b = 0, c10_a = 0;
    if (getIntPixelDataAndIdx(engine, x1, y0, chunkCache)) {
        const d = engine._tempData, idx = engine._tempIdx;
        c10_r = d[idx]; c10_g = d[idx + 1]; c10_b = d[idx + 2]; c10_a = d[idx + 3];
    }
    let c01_r = 0, c01_g = 0, c01_b = 0, c01_a = 0;
    if (getIntPixelDataAndIdx(engine, x0, y1, chunkCache)) {
        const d = engine._tempData, idx = engine._tempIdx;
        c01_r = d[idx]; c01_g = d[idx + 1]; c01_b = d[idx + 2]; c01_a = d[idx + 3];
    }
    let c11_r = 0, c11_g = 0, c11_b = 0, c11_a = 0;
    if (getIntPixelDataAndIdx(engine, x1, y1, chunkCache)) {
        const d = engine._tempData, idx = engine._tempIdx;
        c11_r = d[idx]; c11_g = d[idx + 1]; c11_b = d[idx + 2]; c11_a = d[idx + 3];
    }

    const r0_r = c00_r + tx * (c10_r - c00_r);
    const r1_r = c01_r + tx * (c11_r - c01_r);
    dstData[dstIdx] = Math.round(r0_r + ty * (r1_r - r0_r));

    const r0_g = c00_g + tx * (c10_g - c00_g);
    const r1_g = c01_g + tx * (c11_g - c01_g);
    dstData[dstIdx + 1] = Math.round(r0_g + ty * (r1_g - r0_g));

    const r0_b = c00_b + tx * (c10_b - c00_b);
    const r1_b = c01_b + tx * (c11_b - c01_b);
    dstData[dstIdx + 2] = Math.round(r0_b + ty * (r1_b - r0_b));

    const r0_a = c00_a + tx * (c10_a - c00_a);
    const r1_a = c01_a + tx * (c11_a - c01_a);
    dstData[dstIdx + 3] = Math.round(r0_a + ty * (r1_a - r0_a));
}

export function bilinearSampleImageData(engine, srcData, w, h, x, y, dstData, dstIdx) {
    const x0 = Math.floor(x);
    const x1 = Math.min(w - 1, x0 + 1);
    const y0 = Math.floor(y);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;

    const ix0 = Math.max(0, Math.min(w - 1, x0));
    const ix1 = Math.max(0, Math.min(w - 1, x1));
    const iy0 = Math.max(0, Math.min(h - 1, y0));
    const iy1 = Math.max(0, Math.min(h - 1, y1));

    const idx00 = (iy0 * w + ix0) * 4;
    const idx10 = (iy0 * w + ix1) * 4;
    const idx01 = (iy1 * w + ix0) * 4;
    const idx11 = (iy1 * w + ix1) * 4;

    for (let c = 0; c < 4; c++) {
        const c00 = srcData[idx00 + c];
        const c10 = srcData[idx10 + c];
        const c01 = srcData[idx01 + c];
        const c11 = srcData[idx11 + c];
        const r0 = c00 + tx * (c10 - c00);
        const r1 = c01 + tx * (c11 - c01);
        dstData[dstIdx + c] = Math.round(r0 + ty * (r1 - r0));
    }
}

export function bilinearSample(engine, srcData, w, h, x, y, dstData, dstIdx) {
    bilinearSampleImageData(engine, srcData, w, h, x, y, dstData, dstIdx);
}
