import { wasmCore } from '../wasm/wasmBridge.js';

/**
 * Ensures pristine chunk backup exists in CPU memory for undo/redo and zero-stall reads.
 * Specifying { willReadFrequently: true } guarantees software RAM backing in modern browsers,
 * preventing GPU pipeline flushes and readback stalls.
 */
function _ensureChunkBackup(engine, cx, cy) {
    const chunk = engine._getChunk(cx, cy);
    if (!chunk) return null;
    const id = `${cx},${cy}`;

    if (!engine.currentStrokeDirtyChunks.has(id)) {
        const srcCanvas = chunk.canvases[engine.activeLayer];
        const backup = document.createElement('canvas');
        backup.width = srcCanvas.width;
        backup.height = srcCanvas.height;
        const backupCtx = backup.getContext('2d', { willReadFrequently: true });
        backupCtx.drawImage(srcCanvas, 0, 0);
        engine.currentStrokeDirtyChunks.set(id, {
            layer: engine.activeLayer,
            canvas: backup,
            ctx: backupCtx
        });
        engine._markDirty(id, engine.activeLayer);
    }
    return { id, chunk, backupData: engine.currentStrokeDirtyChunks.get(id) };
}

/**
 * Stamps a rectangular world region from pristine backups into the WASM session.
 * Uses a single getImageData call per chunk with 0-allocation transfers into WASM memory.
 */
function _stampWorldRegion(engine, stroke, minWorldX, maxWorldX, minWorldY, maxWorldY) {
    const sCX = engine.isStatic ? 0 : Math.floor(minWorldX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor(maxWorldX / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(minWorldY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor(maxWorldY / engine.chunkSize);

    for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
            const entry = _ensureChunkBackup(engine, cx, cy);
            if (!entry) continue;
            const { chunk, backupData } = entry;

            const clx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
            const cly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
            const chunkW = engine.isStatic ? engine.staticWidth : (chunk.width || engine.chunkSize);
            const chunkH = engine.isStatic ? engine.staticHeight : (chunk.height || engine.chunkSize);

            const clipMinX = Math.max(clx, minWorldX);
            const clipMaxX = Math.min(clx + chunkW, maxWorldX);
            const clipMinY = Math.max(cly, minWorldY);
            const clipMaxY = Math.min(cly + chunkH, maxWorldY);

            if (clipMaxX > clipMinX && clipMaxY > clipMinY) {
                const srcX = Math.round(clipMinX - clx);
                const srcY = Math.round(clipMinY - cly);
                const stampW = Math.round(clipMaxX - clipMinX);
                const stampH = Math.round(clipMaxY - clipMinY);
                const dstX = Math.round(clipMinX - stroke.originX);
                const dstY = Math.round(clipMinY - stroke.originY);

                if (stampW > 0 && stampH > 0 && backupData && backupData.ctx) {
                    const imgData = backupData.ctx.getImageData(srcX, srcY, stampW, stampH);
                    wasmCore.liquifySessionStampSrc(imgData.data, stampW, stampH, dstX, dstY);
                }
            }
        }
    }

    stroke.stampedMinX = Math.min(stroke.stampedMinX, minWorldX);
    stroke.stampedMaxX = Math.max(stroke.stampedMaxX, maxWorldX);
    stroke.stampedMinY = Math.min(stroke.stampedMinY, minWorldY);
    stroke.stampedMaxY = Math.max(stroke.stampedMaxY, maxWorldY);
}

/**
 * Initializes a new Liquify stroke session.
 * Reuses persistent WebAssembly memory for instant responsiveness.
 * Features immediate radial pre-grabbing: the core area under the cursor is grabbed
 * immediately on click (<0.5ms) so the very first move is already active and moving.
 * Outer rings for large brushes are lazily queued across up to 4 frames with a strict
 * 1.5ms budget to prevent any frame drops.
 */
export function startLiquifyStroke(engine, worldPos) {
    if (engine.activeLayer === 0) return;
    if (engine.layerSettings[engine.activeLayer]?.locked) return;

    // Fixed, high precision cell size of 8px (<0.01ms evaluation)
    const cellSize = 8.0;

    let originX, originY, width, height;
    if (engine.isStatic) {
        width = Math.ceil(engine.staticWidth / 8) * 8;
        height = Math.ceil(engine.staticHeight / 8) * 8;
        originX = -engine.staticWidth / 2;
        originY = -engine.staticHeight / 2;
    } else {
        const sessionDim = 3072;
        width = sessionDim;
        height = sessionDim;
        originX = Math.floor((worldPos.x - width / 2) / 64) * 64;
        originY = Math.floor((worldPos.y - height / 2) / 64) * 64;
    }

    wasmCore.liquifySessionStart(width, height, cellSize, originX, originY);

    const gridW = Math.ceil(width / cellSize) + 1;
    const gridH = Math.ceil(height / cellSize) + 1;
    const gridPtr = wasmCore.liquifySessionGetGridPtr();

    const stroke = {
        originX,
        originY,
        width,
        height,
        cellSize,
        gridW,
        gridH,
        gridPtr,
        stampedMinX: Infinity,
        stampedMaxX: -Infinity,
        stampedMinY: Infinity,
        stampedMaxY: -Infinity,
        maxDisp: 0,
        lazyQueue: null,
        lazyRafId: null,
        startPos: { x: worldPos.x, y: worldPos.y },
        lastPos: { x: worldPos.x, y: worldPos.y },
        active: true
    };
    engine.liquifyStroke = stroke;

    const currentSize = engine.brush.size || 50;
    const R = Math.max(4.0, currentSize / 2);

    if (R <= 160) {
        // Small/medium brush: grab entire circle + generous 128px margin in a single call (<0.5ms)
        const pad = Math.max(96, R + 64);
        _stampWorldRegion(
            engine,
            stroke,
            worldPos.x - R - pad,
            worldPos.x + R + pad,
            worldPos.y - R - pad,
            worldPos.y + R + pad
        );
    } else {
        // Large brush: grab immediate core under cursor (<0.4ms) so 1st move is active
        const corePad = 96;
        _stampWorldRegion(
            engine,
            stroke,
            worldPos.x - corePad,
            worldPos.x + corePad,
            worldPos.y - corePad,
            worldPos.y + corePad
        );

        // Queue remaining outer area across up to 4 frames with 1.5ms budget
        const totalPad = Math.max(128, R + 64);
        const rings = [
            { r: Math.min(R * 0.5 + 48, totalPad) },
            { r: Math.min(R * 0.75 + 64, totalPad) },
            { r: totalPad }
        ];
        stroke.lazyQueue = rings;

        const processLazy = () => {
            if (!stroke.active || !stroke.lazyQueue || stroke.lazyQueue.length === 0) {
                stroke.lazyRafId = null;
                return;
            }
            const t0 = performance.now();
            while (stroke.lazyQueue.length > 0 && (performance.now() - t0) < 1.5) {
                const item = stroke.lazyQueue.shift();
                _stampWorldRegion(
                    engine,
                    stroke,
                    worldPos.x - item.r,
                    worldPos.x + item.r,
                    worldPos.y - item.r,
                    worldPos.y + item.r
                );
            }
            if (stroke.lazyQueue.length > 0) {
                stroke.lazyRafId = requestAnimationFrame(processLazy);
            } else {
                stroke.lazyRafId = null;
            }
        };
        stroke.lazyRafId = requestAnimationFrame(processLazy);
    }
}

/**
 * Deforms the 2D displacement grid in WASM memory.
 * - 100% falloff: elegant, smooth S-curve gradient all the way from the center to edge
 * - 0% falloff: flat plateau across the entire circle (picks up whatever is in the circle and moves it)
 * - 100% strength: exactly follows mouse cursor 1-to-1
 * - 1% strength: subtle minimum displacement
 * - Cumulative forward warp anchored to pristine starting artwork (Zero blur accumulation, zero snapping)
 */
function _displaceGrid(stroke, fromX, fromY, mvX, mvY, R, falloff) {
    if (stroke.gridPtr === 0 || R <= 0) return;

    const memF32 = new Float32Array(wasmCore.getMemBuffer());
    const gridOffset = stroke.gridPtr / 4;
    const invCell = 1.0 / stroke.cellSize;
    const rSq = R * R;
    const invR = 1.0 / R;

    const minGx = Math.max(0, Math.floor((fromX - R - stroke.originX) * invCell));
    const maxGx = Math.min(stroke.gridW - 1, Math.ceil((fromX + R - stroke.originX) * invCell));
    const minGy = Math.max(0, Math.floor((fromY - R - stroke.originY) * invCell));
    const maxGy = Math.min(stroke.gridH - 1, Math.ceil((fromY + R - stroke.originY) * invCell));

    if (minGx > maxGx || minGy > maxGy) return;

    // Inner plateau radius: 1.0 at falloff=0, 0.0 at falloff=1
    const rInner = Math.max(0.0, 1.0 - falloff);

    for (let gy = minGy; gy <= maxGy; gy++) {
        const wy = stroke.originY + gy * stroke.cellSize;
        const dy = wy - fromY;
        const dy2 = dy * dy;
        if (dy2 >= rSq) continue;

        const rowOffset = gridOffset + gy * stroke.gridW * 2;
        for (let gx = minGx; gx <= maxGx; gx++) {
            const wx = stroke.originX + gx * stroke.cellSize;
            const dx = wx - fromX;
            const d2 = dx * dx + dy2;
            if (d2 >= rSq) continue;

            const d = Math.sqrt(d2);
            const u = d * invR;

            let w;
            if (u <= rInner) {
                // If falloff is 0% (rInner >= 0.95), smooth only the outermost 4% boundary
                if (rInner >= 0.95 && u > 0.96) {
                    const edgeT = (u - 0.96) / 0.04;
                    w = 1.0 - (edgeT * edgeT * (3.0 - 2.0 * edgeT));
                } else {
                    w = 1.0;
                }
            } else {
                const t = (u - rInner) / (1.0 - rInner);
                // Cubic Hermite smoothstep: 1.0 at t=0, 0.0 at t=1, derivative 0 at both endpoints
                w = (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
            }

            const idx = rowOffset + gx * 2;
            memF32[idx] += mvX * w;
            memF32[idx + 1] += mvY * w;
        }
    }
}

/**
 * Executes a continuous Liquify brush move using the Rust WASM session.
 * Warps only the affected sub-box with full bilinear interpolation directly from
 * the original pristine stroke backup (Zero loss in image quality).
 * Streams modified pixels directly into GPU texture via texSubImage2D (<0.05ms)
 * to maintain solid 60-120 FPS without full-canvas re-uploads.
 */
export function paintLiquifyStroke(engine, from, to, dynamicSize, pressure) {
    if (engine.perfMonitor) engine.perfMonitor.markPhase('liquify_step');
    if (engine.activeLayer === 0) return;
    if (engine.layerSettings[engine.activeLayer]?.locked) return;

    if (!engine.liquifyStroke || !engine.liquifyStroke.active) {
        startLiquifyStroke(engine, from);
    }

    const stroke = engine.liquifyStroke;
    if (!stroke || !stroke.active) return;

    const totalDx = to.x - from.x;
    const totalDy = to.y - from.y;
    const dist = Math.hypot(totalDx, totalDy);
    if (dist < 0.2) return;

    const currentSize = dynamicSize || engine.brush.size || 50;
    const R = Math.max(4.0, currentSize / 2);

    // Strength computation:
    // Flow slider from UI (1% to 100% -> 0.01 to 1.0)
    const flow = (engine.brush.flow !== undefined) ? engine.brush.flow : 0.40;
    let strength;
    if (pressure !== undefined && Number.isFinite(pressure) && pressure > 0 && pressure !== 0.5) {
        strength = Math.max(0.01, Math.min(1.0, flow * (0.15 + 0.85 * pressure)));
    } else {
        // Mouse: 100% strength is 1-to-1 with mouse cursor
        strength = Math.max(0.01, Math.min(1.0, flow));
    }

    const falloff = (engine.brush.falloff !== undefined) ? engine.brush.falloff : 0.50;

    // Sub-stepping for smooth curvature during fast movements
    const maxSubStepDist = Math.max(12.0, R * 0.35);
    const steps = Math.min(4, Math.max(1, Math.ceil(dist / maxSubStepDist)));

    // Total bounding box of the brush stroke this frame
    const minWorldX = Math.floor(Math.min(from.x, to.x) - R - 8);
    const maxWorldX = Math.ceil(Math.max(from.x, to.x) + R + 8);
    const minWorldY = Math.floor(Math.min(from.y, to.y) - R - 8);
    const maxWorldY = Math.ceil(Math.max(from.y, to.y) + R + 8);

    stroke.maxDisp += dist * strength;

    // Source coordinates that might be sampled by backward warp:
    // Destination (x,y) samples from (x - dx, y - dy).
    const neededMinX = minWorldX - stroke.maxDisp - 64;
    const neededMaxX = maxWorldX + stroke.maxDisp + 64;
    const neededMinY = minWorldY - stroke.maxDisp - 64;
    const neededMaxY = maxWorldY + stroke.maxDisp + 64;

    // Expand stamped bounds if moving into unstamped territory.
    // Adds a generous 128px lookahead buffer so subsequent frames require 0 readbacks.
    if (neededMinX < stroke.stampedMinX || neededMaxX > stroke.stampedMaxX ||
        neededMinY < stroke.stampedMinY || neededMaxY > stroke.stampedMaxY) {
        const expandMinX = Math.min(stroke.stampedMinX, neededMinX - 128);
        const expandMaxX = Math.max(stroke.stampedMaxX, neededMaxX + 128);
        const expandMinY = Math.min(stroke.stampedMinY, neededMinY - 128);
        const expandMaxY = Math.max(stroke.stampedMaxY, neededMaxY + 128);
        _stampWorldRegion(engine, stroke, expandMinX, expandMaxX, expandMinY, expandMaxY);
    }

    // 1. Displace the grid (sub-stepped if fast, with 0 intermediate pixel blits)
    let prevX = from.x;
    let prevY = from.y;
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const curX = from.x + totalDx * t;
        const curY = from.y + totalDy * t;
        const subMvX = (curX - prevX) * strength;
        const subMvY = (curY - prevY) * strength;
        _displaceGrid(stroke, prevX, prevY, subMvX, subMvY, R, falloff);
        prevX = curX;
        prevY = curY;
    }

    // 2. Identify touched chunks
    const sCX = engine.isStatic ? 0 : Math.floor(minWorldX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor(maxWorldX / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(minWorldY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor(maxWorldY / engine.chunkSize);

    for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
            const chunk = engine._getChunk(cx, cy);
            if (!chunk) continue;
            const id = `${cx},${cy}`;

            const clx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
            const cly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
            const chunkW = engine.isStatic ? engine.staticWidth : (chunk.width || engine.chunkSize);
            const chunkH = engine.isStatic ? engine.staticHeight : (chunk.height || engine.chunkSize);

            const iMinWorldX = Math.max(clx, minWorldX);
            const iMaxWorldX = Math.min(clx + chunkW - 1, maxWorldX);
            const iMinWorldY = Math.max(cly, minWorldY);
            const iMaxWorldY = Math.min(cly + chunkH - 1, maxWorldY);

            if (iMaxWorldX < iMinWorldX || iMaxWorldY < iMinWorldY) continue;

            // Sub-box coordinates within the session
            const sMinX = Math.max(0, Math.min(stroke.width - 1, Math.round(iMinWorldX - stroke.originX)));
            const sMaxX = Math.max(0, Math.min(stroke.width - 1, Math.round(iMaxWorldX - stroke.originX)));
            const sMinY = Math.max(0, Math.min(stroke.height - 1, Math.round(iMinWorldY - stroke.originY)));
            const sMaxY = Math.max(0, Math.min(stroke.height - 1, Math.round(iMaxWorldY - stroke.originY)));

            const boxW = sMaxX - sMinX + 1;
            const boxH = sMaxY - sMinY + 1;
            if (boxW <= 0 || boxH <= 0) continue;

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

                if (engine.gpuRenderer && engine.gpuRenderer.supported) {
                    // Update only this sub-box via texSubImage2D (<0.05ms) without re-uploading the 16MB canvas
                    engine.gpuRenderer.updateChunkTextureSubRegion(
                        chunk,
                        engine.activeLayer,
                        localDstX,
                        localDstY,
                        boxW,
                        boxH,
                        boxImageData
                    );
                } else {
                    engine._markDirty(id, engine.activeLayer, false);
                }
            }
        }
    }

    stroke.lastPos = { x: to.x, y: to.y };
    if (engine.gpuRenderer && engine.gpuRenderer.supported) {
        engine.gpuRenderer.render();
    } else {
        engine.refreshTransforms();
    }
}

/**
 * Concludes the Liquify stroke session, synchronizes final GPU textures,
 * and cleans up WASM scratch memory.
 */
export function endLiquifyStroke(engine) {
    if (engine.liquifyStroke) {
        if (engine.liquifyStroke.lazyRafId) {
            cancelAnimationFrame(engine.liquifyStroke.lazyRafId);
            engine.liquifyStroke.lazyRafId = null;
        }
        engine.liquifyStroke.active = false;
        engine.liquifyStroke = null;
    }

    // Synchronize chunk GPU state cleanly for subsequent tools
    if (engine.gpuRenderer && engine.gpuRenderer.supported && engine.chunks) {
        engine.chunks.forEach(chunk => {
            engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
        });
    }

    wasmCore.liquifySessionEnd();
}

// ============================================================================
// COMPATIBILITY INTERFACES FOR LEGACY CALLERS
// ============================================================================

export function displaceLiquifyCoords(engine, p0, p1, affectedThisFrame) {
    paintLiquifyStroke(engine, p0, p1, engine.brush.size, 1.0);
}

export function renderLiquifyChunks(engine, affectedThisFrame, forceBilinear = false) {
    if (engine.gpuRenderer && engine.gpuRenderer.supported) {
        engine.gpuRenderer.render();
    } else {
        engine.refreshTransforms();
    }
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
