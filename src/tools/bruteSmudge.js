import { isMobileDevice } from '../colorUtils.js';
import { backupChunkLayer } from '../engine/backupPool.js';

function drawChunkSliceToSmudge(smudgeCtx, srcCanvas, px, py, sSz, srcW, srcH) {
    if (!srcCanvas || srcW <= 0 || srcH <= 0 || sSz <= 0) return false;
    const sR = sSz * 0.5;
    const reqX0 = px - sR;
    const reqY0 = py - sR;
    const reqX1 = px + sR;
    const reqY1 = py + sR;

    const clipX0 = Math.max(0, reqX0);
    const clipY0 = Math.max(0, reqY0);
    const clipX1 = Math.min(srcW, reqX1);
    const clipY1 = Math.min(srcH, reqY1);
    const clipW = clipX1 - clipX0;
    const clipH = clipY1 - clipY0;
    if (clipW <= 0 || clipH <= 0) return false;

    const scale = 128.0 / sSz;
    const dx = (clipX0 - reqX0) * scale;
    const dy = (clipY0 - reqY0) * scale;
    const dw = clipW * scale;
    const dh = clipH * scale;
    smudgeCtx.drawImage(srcCanvas, clipX0, clipY0, clipW, clipH, dx, dy, dw, dh);
    return true;
}

function maskSmudgeCanvasWithTip(smudgeCtx, tip) {
    smudgeCtx.globalCompositeOperation = 'destination-in';
    smudgeCtx.globalAlpha = 1.0;
    if (tip) {
        smudgeCtx.drawImage(tip, 0, 0, 128, 128);
    } else {
        smudgeCtx.beginPath();
        smudgeCtx.arc(64, 64, 63, 0, Math.PI * 2);
        smudgeCtx.fill();
    }
}

export function paintSmudgeOnChunks(engine, stamps, affectedChunks, flow, opacity, tip) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stamps) {
        const sR = Math.max(1, s.size * 0.5);
        const padR = sR * ((s.angle || 0) !== 0 ? 1.45 : 1.05);
        minX = Math.min(minX, s.x - padR);
        minY = Math.min(minY, s.y - padR);
        maxX = Math.max(maxX, s.x + padR);
        maxY = Math.max(maxY, s.y + padR);
    }
    minX = Math.floor(minX - 4);
    minY = Math.floor(minY - 4);
    maxX = Math.ceil(maxX + 4);
    maxY = Math.ceil(maxY + 4);
    const w = maxX - minX, h = maxY - minY;

    if (w > 0 && h > 0) {
        if (!engine.segmentCanvas) {
            engine.segmentCanvas = document.createElement('canvas');
            engine.segmentCtx = engine.segmentCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
        }
        if (engine.segmentCanvas.width < w || engine.segmentCanvas.height < h) {
            engine.segmentCanvas.width = Math.max(engine.segmentCanvas.width, w + 128);
            engine.segmentCanvas.height = Math.max(engine.segmentCanvas.height, h + 128);
        }
        engine.segmentCtx.clearRect(0, 0, w, h);

        affectedChunks.forEach((group, id) => {
            const chunk = engine._getChunk(group.cx, group.cy);
            if (chunk) {
                const lx = engine.isStatic ? -engine.staticWidth / 2 : group.cx * engine.chunkSize;
                const ly = engine.isStatic ? -engine.staticHeight / 2 : group.cy * engine.chunkSize;

                engine.segmentCtx.drawImage(chunk.canvases[engine.activeLayer], lx - minX, ly - minY, chunk.width, chunk.height);

                if (engine.isDrawing && !engine.currentStrokeDirtyChunks.has(id)) {
                    backupChunkLayer(engine, chunk, id, { layer: engine.activeLayer });
                }
            }
        });

        const sCtx = engine.segmentCtx;
        const brushOpac = (engine.brush && engine.brush.opacity !== undefined) ? engine.brush.opacity : 1.0;

        for (const s of stamps) {
            const px = s.x - minX, py = s.y - minY;
            const sSz = Math.max(2, s.size);
            const sR = sSz * 0.5;
            const effOpac = Math.max(
                0.01,
                Math.min(1.0, (s.opacity !== undefined) ? (s.opacity * brushOpac) : opacity)
            );
            const angle = s.angle || 0;

            if (engine.smudgeDirty) {
                sCtx.save();
                sCtx.translate(px, py);
                if (angle !== 0) sCtx.rotate(angle);
                // Higher flow + pressure opacity = more opaque smudge stamp.
                sCtx.globalAlpha = Math.min(1.0, flow * (engine.brush.smudgeFlowBoost ?? 10.0) * effOpac);
                sCtx.drawImage(engine.smudgeCanvas, -sR, -sR, sSz, sSz);
                sCtx.restore();
            }

            engine.smudgeCtx.save();
            engine.smudgeCtx.clearRect(0, 0, 128, 128);

            if (engine.smudgeDirty) {
                // Previous smudge content
                engine.smudgeCtx.globalAlpha = 1.0;
                engine.smudgeCtx.drawImage(engine.smudgeCanvas, 0, 0);

                // Pickup from segment.
                const pickupMul = engine.brush.smudgePickup ?? 2.0;
                const pickUpAlpha = (0.3 + flow * 0.4 * pickupMul) * (1.1 - effOpac * 0.8);
                engine.smudgeCtx.globalAlpha = Math.max(0.0, Math.min(1.0, pickUpAlpha));
            } else {
                engine.smudgeCtx.globalAlpha = 1.0;
            }

            // 1. Pick up color from the segment aligned with stamp rotation & pressure size
            if (angle !== 0) {
                engine.smudgeCtx.save();
                engine.smudgeCtx.translate(64, 64);
                engine.smudgeCtx.rotate(-angle);
                engine.smudgeCtx.scale(128 / sSz, 128 / sSz);
                engine.smudgeCtx.drawImage(engine.segmentCanvas, -px, -py);
                engine.smudgeCtx.restore();
            } else {
                engine.smudgeCtx.drawImage(engine.segmentCanvas, px - sR, py - sR, sSz, sSz, 0, 0, 128, 128);
            }

            // 2. MASK the smudge content strictly with the brush tip shape
            maskSmudgeCanvasWithTip(engine.smudgeCtx, tip);

            engine.smudgeCtx.restore();
            engine.smudgeDirty = true;
        }

        affectedChunks.forEach((group, id) => {
            const chunk = engine._getChunk(group.cx, group.cy);
            if (chunk) {
                const lx = engine.isStatic ? -engine.staticWidth / 2 : group.cx * engine.chunkSize;
                const ly = engine.isStatic ? -engine.staticHeight / 2 : group.cy * engine.chunkSize;
                const chunkW = engine.isStatic ? engine.staticWidth : engine.chunkSize;
                const chunkH = engine.isStatic ? engine.staticHeight : engine.chunkSize;
                const iMinX = Math.max(lx, minX), iMinY = Math.max(ly, minY);
                const iMaxX = Math.min(lx + chunkW, maxX), iMaxY = Math.min(ly + chunkH, maxY);
                if (iMaxX > iMinX && iMaxY > iMinY) {
                    const lCtx = chunk.ctxs[engine.activeLayer];
                    const layerSet = engine.layerSettings[engine.activeLayer];

                    lCtx.save();
                    if (layerSet && layerSet.alphaLock) {
                        lCtx.globalCompositeOperation = 'source-atop';
                        lCtx.drawImage(engine.segmentCanvas, iMinX - minX, iMinY - minY, iMaxX - iMinX, iMaxY - iMinY, iMinX - lx, iMinY - ly, iMaxX - iMinX, iMaxY - iMinY);
                    } else {
                        lCtx.clearRect(iMinX - lx, iMinY - ly, iMaxX - iMinX, iMaxY - iMinY);
                        lCtx.drawImage(engine.segmentCanvas, iMinX - minX, iMinY - minY, iMaxX - iMinX, iMaxY - iMinY, iMinX - lx, iMinY - ly, iMaxX - iMinX, iMaxY - iMinY);
                    }
                    lCtx.restore();
                    engine._markDirty(id, engine.activeLayer, false);
                    if (engine.gpuRenderer) {
                        engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
                    }
                }
            }
        });
    }
}

/**
 * Pre-warms the smudge stroke on pointerdown.
 * Respects pressure-scaled worldPos.size, samples intersecting chunks cleanly,
 * and masks immediately with the brush tip shape so Stamp #1 is never an oversized square.
 */
export function startSmudgeStroke(engine, worldPos, tip = null) {
    if (!engine || !worldPos) return;
    if (!engine.segmentCanvas) {
        engine.segmentCanvas = document.createElement('canvas');
        engine.segmentCtx = engine.segmentCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    }
    const sz = Math.max(2, worldPos.size || engine.brush.size || 50);
    const sR = sz * 0.5;
    const sCX = engine.isStatic ? 0 : Math.floor((worldPos.x - sR) / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((worldPos.x + sR) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor((worldPos.y - sR) / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((worldPos.y + sR) / engine.chunkSize);

    let sampledAny = false;
    engine.smudgeCtx.save();
    engine.smudgeCtx.clearRect(0, 0, 128, 128);
    engine.smudgeCtx.globalCompositeOperation = 'source-over';
    engine.smudgeCtx.globalAlpha = 1.0;

    for (let cy = sCY; cy <= eCY; cy++) {
        for (let cx = sCX; cx <= eCX; cx++) {
            const chunk = engine._getChunk(cx, cy);
            if (!chunk) continue;
            const id = `${cx},${cy}`;
            if (engine.isDrawing && !engine.currentStrokeDirtyChunks.has(id)) {
                backupChunkLayer(engine, chunk, id, { layer: engine.activeLayer });
            }
            const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
            const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
            const px = worldPos.x - lx;
            const py = worldPos.y - ly;
            if (drawChunkSliceToSmudge(engine.smudgeCtx, chunk.canvases[engine.activeLayer], px, py, sz, chunk.width, chunk.height)) {
                sampledAny = true;
            }
        }
    }

    if (sampledAny) {
        maskSmudgeCanvasWithTip(engine.smudgeCtx, tip);
        engine.smudgeDirty = true;
    } else {
        engine.smudgeDirty = false;
    }
    engine.smudgeCtx.restore();
}
