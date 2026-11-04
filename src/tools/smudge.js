import { isMobileDevice } from '../colorUtils.js';

/**
 * Extracts and caches a normalized 128x128 alpha mask for any brush tip.
 * Accurately handles:
 * 1. Transparent PNGs / canvas drawings (preserves alpha channel).
 * 2. Opaque grayscale textures (inverts luminance: black is opaque foreground, white is transparent background).
 * 3. Default soft circular brush tip fallback.
 */
export function getBrushTipMask(tip) {
    if (!tip || !tip.width || !tip.height) {
        if (!getBrushTipMask._defaultCircle) {
            const defCanvas = document.createElement('canvas');
            defCanvas.width = 128;
            defCanvas.height = 128;
            const dCtx = defCanvas.getContext('2d');
            const grad = dCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
            grad.addColorStop(0, 'rgba(0,0,0,1.0)');
            grad.addColorStop(0.85, 'rgba(0,0,0,0.9)');
            grad.addColorStop(1.0, 'rgba(0,0,0,0.0)');
            dCtx.fillStyle = grad;
            dCtx.beginPath();
            dCtx.arc(64, 64, 64, 0, Math.PI * 2);
            dCtx.fill();
            getBrushTipMask._defaultCircle = defCanvas;
        }
        return getBrushTipMask._defaultCircle;
    }

    if (tip._smudgeAlphaMask && tip._smudgeMaskSrc === tip) {
        return tip._smudgeAlphaMask;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = 128;
    maskCanvas.height = 128;
    const mCtx = maskCanvas.getContext('2d');

    mCtx.drawImage(tip, 0, 0, 128, 128);
    const imgData = mCtx.getImageData(0, 0, 128, 128);
    const d = imgData.data;
    const len = d.length;

    // Detect if this tip already has native alpha transparency
    let hasAlpha = false;
    for (let i = 3; i < len; i += 4) {
        if (d[i] < 245) {
            hasAlpha = true;
            break;
        }
    }

    if (hasAlpha) {
        // Transparent texture: ensure RGB is black and keep the exact alpha shape
        for (let i = 0; i < len; i += 4) {
            d[i] = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
        }
    } else {
        // Opaque texture (e.g. black stroke on white paper): convert darkness to alpha
        for (let i = 0; i < len; i += 4) {
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const a = Math.max(0, Math.min(255, Math.round(255 - lum)));
            d[i] = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
            d[i + 3] = a;
        }
    }

    mCtx.putImageData(imgData, 0, 0);
    tip._smudgeAlphaMask = maskCanvas;
    tip._smudgeMaskSrc = tip;
    return maskCanvas;
}

export function ensureSmudgeBuffers(engine) {
    if (!engine.smudgeCanvas) {
        engine.smudgeCanvas = document.createElement('canvas');
        engine.smudgeCanvas.width = 128;
        engine.smudgeCanvas.height = 128;
        engine.smudgeCtx = engine.smudgeCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
        engine.smudgeDirty = false;
    }
    if (!engine.smudgePickupCanvas) {
        engine.smudgePickupCanvas = document.createElement('canvas');
        engine.smudgePickupCanvas.width = 128;
        engine.smudgePickupCanvas.height = 128;
        engine.smudgePickupCtx = engine.smudgePickupCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    }
    if (!engine.segmentCanvas) {
        engine.segmentCanvas = document.createElement('canvas');
        engine.segmentCtx = engine.segmentCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    }
}

export function paintSmudgeOnChunks(engine, stamps, affectedChunks, flow, opacity, tip) {
    ensureSmudgeBuffers(engine);
    const mask = getBrushTipMask(tip);

    const brushOpacity = Math.max(0, Math.min(1.0, (opacity !== undefined ? opacity : (engine.brush.opacity ?? 1.0))));
    const brushFlow = Math.max(0, Math.min(1.0, (flow !== undefined ? flow : (engine.brush.flow ?? 1.0))));
    const flowBoost = (engine.brush.smudgeFlowBoost !== undefined) ? engine.brush.smudgeFlowBoost : 1.0;
    const wetness = (engine.brush.oiliness !== undefined) ? engine.brush.oiliness : 0.5;
    const pickupSetting = (engine.brush.smudgePickup !== undefined) ? engine.brush.smudgePickup : 1.0;

    // Strict deadzone: if opacity or flow is 0, smudge does nothing
    if (brushOpacity <= 0.001 || brushFlow <= 0.001 || !engine.smudgeDirty) {
        return;
    }

    // Compound strength normalized to [0, 1]
    const strength = Math.max(0, Math.min(1.0, brushOpacity * brushFlow * (flowBoost / 2.0)));
    if (strength <= 0.001) {
        return;
    }

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
        const pCtx = engine.smudgePickupCtx;

        // Calibrated stamp alpha compounding over ~10 stamps per brush radius
        const stampAlpha = Math.max(0, Math.min(0.85, 1.0 - Math.pow(Math.max(0.0001, 1.0 - strength), 0.1)));

        // Effective wetness / pickup rate
        const effectiveWetness = Math.max(0, Math.min(1.0, wetness * (pickupSetting / 2.0)));
        const pickupAlpha = Math.max(0, Math.min(0.35, effectiveWetness * 0.15 * (brushFlow * 0.5 + 0.5)));

        // Retention: at wetness = 1.0, retention is 1.0 (no decay). At wetness = 0.0, retention is 0.88 (~15-20 stamps fade)
        const retention = Math.min(1.0, 0.88 + effectiveWetness * 0.12);

        for (const s of stamps) {
            const px = s.x - minX, py = s.y - minY;
            const sSz = Math.max(4, s.size), sR = sSz / 2;
            
            // 1. Stamp the masked smudge buffer onto the segment canvas
            if (engine.smudgeDirty && stampAlpha > 0.0005) {
                sCtx.save();
                sCtx.translate(px, py);
                sCtx.rotate(s.angle);
                sCtx.globalAlpha = stampAlpha;
                sCtx.drawImage(engine.smudgeCanvas, -sR, -sR, sSz, sSz);
                sCtx.restore();
            }

            // 2. Sample new canvas color under current stamp location into pickup buffer
            pCtx.save();
            pCtx.clearRect(0, 0, 128, 128);
            pCtx.drawImage(engine.segmentCanvas, px - sR, py - sR, sSz, sSz, 0, 0, 128, 128);
            // Mask pickup strictly by the brush tip
            pCtx.globalCompositeOperation = 'destination-in';
            if (mask) {
                pCtx.drawImage(mask, 0, 0, 128, 128);
            }
            pCtx.restore();

            // 3. Blend new pickup into smudge canvas (if wetness/pickup allows)
            if (pickupAlpha > 0.001) {
                engine.smudgeCtx.save();
                engine.smudgeCtx.globalAlpha = pickupAlpha;
                engine.smudgeCtx.drawImage(engine.smudgePickupCanvas, 0, 0);

                // Enforce mask boundary on smudgeCanvas so corners stay 100% transparent
                engine.smudgeCtx.globalCompositeOperation = 'destination-in';
                engine.smudgeCtx.globalAlpha = 1.0;
                if (mask) {
                    engine.smudgeCtx.drawImage(mask, 0, 0, 128, 128);
                }
                engine.smudgeCtx.restore();
            }

            // 4. Decay carried paint if dry / low wetness (runs out of paint)
            if (retention < 0.999) {
                engine.smudgeCtx.save();
                engine.smudgeCtx.globalCompositeOperation = 'destination-out';
                engine.smudgeCtx.fillStyle = `rgba(0, 0, 0, ${+(1.0 - retention).toFixed(3)})`;
                engine.smudgeCtx.fillRect(0, 0, 128, 128);
                engine.smudgeCtx.restore();
            }

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
 * Samples initial color at worldPos and immediately applies the brush tip alpha mask,
 * ensuring the very first stamp has zero square borders.
 */
export function startSmudgeStroke(engine, worldPos) {
    ensureSmudgeBuffers(engine);
    const brushOpacity = (engine.brush.opacity !== undefined) ? engine.brush.opacity : 1.0;
    const brushFlow = (engine.brush.flow !== undefined) ? engine.brush.flow : 1.0;
    if (brushOpacity <= 0.001 || brushFlow <= 0.001) {
        engine.smudgeDirty = false;
        return;
    }

    const sz = engine.brush.size || 50;
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

        // Mask the starting smudge buffer to the brush tip shape
        const mask = getBrushTipMask(engine.brush.tip);
        engine.smudgeCtx.globalCompositeOperation = 'destination-in';
        if (mask) {
            engine.smudgeCtx.drawImage(mask, 0, 0, 128, 128);
        }
        engine.smudgeCtx.restore();

        engine.smudgeDirty = true;
    }
}
