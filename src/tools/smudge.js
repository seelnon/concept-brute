import { isMobileDevice } from '../colorUtils.js';

export function ensureSmudgeBuffers(engine) {
    if (!engine.smudgeCanvas) {
        engine.smudgeCanvas = document.createElement('canvas');
        engine.smudgeCanvas.width = 128;
        engine.smudgeCanvas.height = 128;
        engine.smudgeCtx = engine.smudgeCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
        engine.smudgeDirty = false;
    }
    if (!engine.segmentCanvas) {
        engine.segmentCanvas = document.createElement('canvas');
        engine.segmentCtx = engine.segmentCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    }
}

export function paintSmudgeOnChunks(engine, stamps, affectedChunks, flow, opacity, tip) {
    if (engine.perfMonitor) engine.perfMonitor.markPhase('smudge_step', { stamps: stamps.length, chunks: affectedChunks ? affectedChunks.size : 1 });
    ensureSmudgeBuffers(engine);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stamps) {
        const sR = s.size / 2;
        minX = Math.min(minX, s.x - sR); minY = Math.min(minY, s.y - sR);
        maxX = Math.max(maxX, s.x + sR); maxY = Math.max(maxY, s.y + sR);
    }
    minX = Math.floor(minX - 4); minY = Math.floor(minY - 4);
    maxX = Math.ceil(maxX + 4); maxY = Math.ceil(maxY + 4);
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
                    const srcCanvas = chunk.canvases[engine.activeLayer];
                    const backup = document.createElement('canvas');
                    backup.width = srcCanvas.width; backup.height = srcCanvas.height;
                    backup.getContext('2d').drawImage(srcCanvas, 0, 0);
                    engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
                    engine._markDirty(id, engine.activeLayer);
                }
            }
        });

        const sCtx = engine.segmentCtx;
        for (const s of stamps) {
            const px = s.x - minX, py = s.y - minY;
            const sSz = Math.max(4, s.size), sR = sSz / 2;
            
            if (engine.smudgeDirty) {
                sCtx.save();
                sCtx.translate(px, py); sCtx.rotate(s.angle);                   // Boost visibility of smudge. 
                // Higher flow = more opaque smudge stamp.
                sCtx.globalAlpha = Math.min(1.0, flow * (engine.brush.smudgeFlowBoost ?? 10.0)); 
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
                // Higher flow = more pickup (wetness).
                // Higher opacity = less update (drag length).
                const pickupMul = engine.brush.smudgePickup ?? 2.0;
                const pickUpAlpha = (0.3 + flow * 0.4 * pickupMul) * (1.1 - opacity * 0.8);
                engine.smudgeCtx.globalAlpha = Math.min(1.0, pickUpAlpha);
            } else {
                engine.smudgeCtx.globalAlpha = 1.0;
            }
            
            // 1. Pick up color from the segment
            engine.smudgeCtx.drawImage(engine.segmentCanvas, px - sR, py - sR, sSz, sSz, 0, 0, 128, 128);

            // 2. MASK the smudge content with the brush tip
            engine.smudgeCtx.globalCompositeOperation = 'destination-in';
            engine.smudgeCtx.globalAlpha = 1.0;
            if (tip) {
                engine.smudgeCtx.drawImage(tip, 0, 0, 128, 128);
            } else {
                engine.smudgeCtx.beginPath();
                engine.smudgeCtx.arc(64, 64, 64, 0, Math.PI * 2);
                engine.smudgeCtx.fill();
            }

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
                    // Smudge is now drawn fully/unclipped interactive to be extremely fast. Crucially, the clip is applied once-off upon mouseup in _endStroke!

                    if (layerSet && layerSet.alphaLock) {
                        // If alpha lock is on, we don't clear.
                        // We use source-atop to paint only on existing pixels.
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
 * Samples initial color at worldPos and marks smudgeDirty so step 1 immediately smudges with zero lag.
 */
export function startSmudgeStroke(engine, worldPos) {
    ensureSmudgeBuffers(engine);
    const sz = worldPos.size || engine.brush.size || 50;
    const sR = sz / 2;
    const cx = engine.isStatic ? 0 : Math.floor(worldPos.x / engine.chunkSize);
    const cy = engine.isStatic ? 0 : Math.floor(worldPos.y / engine.chunkSize);
    const chunk = engine._getChunk(cx, cy);
    if (chunk) {
        const id = `${cx},${cy}`;
        if (!engine.currentStrokeDirtyChunks.has(id)) {
            const srcCanvas = chunk.canvases[engine.activeLayer];
            const backup = document.createElement('canvas');
            backup.width = srcCanvas.width;
            backup.height = srcCanvas.height;
            backup.getContext('2d').drawImage(srcCanvas, 0, 0);
            engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
            engine._markDirty(id, engine.activeLayer);
        }

        const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
        const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
        const px = worldPos.x - lx;
        const py = worldPos.y - ly;

        engine.smudgeCtx.save();
        engine.smudgeCtx.clearRect(0, 0, 128, 128);
        engine.smudgeCtx.drawImage(chunk.canvases[engine.activeLayer], px - sR, py - sR, sz, sz, 0, 0, 128, 128);

        // Apply tip mask on start so the very first stamp is correctly shaped
        const tip = engine.brush.tip;
        engine.smudgeCtx.globalCompositeOperation = 'destination-in';
        engine.smudgeCtx.globalAlpha = 1.0;
        if (tip) {
            engine.smudgeCtx.drawImage(tip, 0, 0, 128, 128);
        } else {
            engine.smudgeCtx.beginPath();
            engine.smudgeCtx.arc(64, 64, 64, 0, Math.PI * 2);
            engine.smudgeCtx.fill();
        }

        engine.smudgeCtx.restore();
        engine.smudgeDirty = true;
    }
}
