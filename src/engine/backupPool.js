// Reusable chunk layer backup canvas pool & empty-chunk fast path.
// Eliminates per-stroke full-chunk/sheet <canvas> allocations (Skia/VRAM churn)
// and skips 100% of allocation/copy work when backing up known-empty chunks.

const MAX_POOL_PER_BUCKET = 16;
const MAX_LARGE_POOL_PER_BUCKET = 4; // >1.5M px (e.g., large static canvases)
const MAX_TOTAL_POOL_BYTES = 128 * 1024 * 1024; // 128 MB cap

function ensurePoolState(engine) {
    if (!engine._backupCanvasPool) {
        engine._backupCanvasPool = new Map();
        engine._backupPoolBytes = 0;
    }
    return engine._backupCanvasPool;
}

function estimateBytes(w, h) {
    return w * h * 4;
}

export function acquireBackupCanvas(engine, width, height, willReadFrequently = false) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const readFlag = willReadFrequently ? 1 : 0;

    if (engine) {
        const pool = ensurePoolState(engine);
        const key = `${w}x${h}_${readFlag}`;
        const bucket = pool.get(key);
        if (bucket && bucket.length > 0) {
            const canvas = bucket.pop();
            engine._backupPoolBytes = Math.max(0, (engine._backupPoolBytes || 0) - estimateBytes(w, h));
            return canvas;
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas._poolReadBack = willReadFrequently;
    canvas._cached2dCtx = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
    return canvas;
}

export function releaseBackupCanvas(engine, canvasOrEntry) {
    if (!canvasOrEntry) return;
    const canvas = canvasOrEntry.canvas !== undefined ? canvasOrEntry.canvas : canvasOrEntry;
    if (!canvas || canvas.width <= 1 || canvas.height <= 1) return;

    const w = canvas.width;
    const h = canvas.height;
    const bytes = estimateBytes(w, h);
    const readFlag = (canvas._poolReadBack || canvasOrEntry._willReadFrequently) ? 1 : 0;

    if (engine) {
        const pool = ensurePoolState(engine);
        const key = `${w}x${h}_${readFlag}`;
        let bucket = pool.get(key);
        if (!bucket) {
            bucket = [];
            pool.set(key, bucket);
        }
        const isLarge = (w * h) > 1500000;
        const maxCount = isLarge ? MAX_LARGE_POOL_PER_BUCKET : MAX_POOL_PER_BUCKET;
        if (bucket.length < maxCount && ((engine._backupPoolBytes || 0) + bytes) <= MAX_TOTAL_POOL_BYTES) {
            canvas._poolReadBack = !!readFlag;
            bucket.push(canvas);
            engine._backupPoolBytes = (engine._backupPoolBytes || 0) + bytes;
            return;
        }
    }

    // Pool cap reached: release backing store cleanly
    canvas._cached2dCtx = null;
    canvas.width = 1;
    canvas.height = 1;
}

export function clearBackupPool(engine) {
    if (!engine || !engine._backupCanvasPool) return;
    engine._backupCanvasPool.forEach((bucket) => {
        for (let i = 0; i < bucket.length; i++) {
            const c = bucket[i];
            if (c) {
                c._cached2dCtx = null;
                c.width = 1;
                c.height = 1;
            }
        }
    });
    engine._backupCanvasPool.clear();
    engine._backupPoolBytes = 0;
}

export function captureLayerSnapshot(engine, chunk, layer, options = {}) {
    const srcCanvas = chunk.canvases[layer];
    const willReadFrequently = !!options.willReadFrequently;
    const needCanvas = !!options.needCanvas;
    const wasChunkEmpty = options.wasEmpty !== undefined
        ? !!options.wasEmpty
        : !!(chunk.isEmpty && chunk.isEmpty[layer]);

    if (!needCanvas && wasChunkEmpty) {
        return {
            layer,
            canvas: null,
            ctx: null,
            wasEmpty: true,
            _willReadFrequently: willReadFrequently,
            width: srcCanvas.width,
            height: srcCanvas.height
        };
    }

    const backup = acquireBackupCanvas(engine, srcCanvas.width, srcCanvas.height, willReadFrequently);
    let bCtx = backup._cached2dCtx;
    if (!bCtx) {
        bCtx = backup.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
        backup._cached2dCtx = bCtx;
    }
    bCtx.save();
    bCtx.setTransform(1, 0, 0, 1, 0, 0);
    bCtx.globalAlpha = 1.0;
    bCtx.globalCompositeOperation = 'copy';
    bCtx.drawImage(srcCanvas, 0, 0);
    bCtx.restore();

    return {
        layer,
        canvas: backup,
        ctx: bCtx,
        wasEmpty: false,
        _willReadFrequently: willReadFrequently,
        width: srcCanvas.width,
        height: srcCanvas.height
    };
}

export function backupChunkLayer(engine, chunk, id, options = {}) {
    if (!engine || !chunk) return null;
    const targetMap = options.targetMap || engine.currentStrokeDirtyChunks || (engine.currentStrokeDirtyChunks = new Map());
    if (!targetMap.has(id)) {
        const layer = options.layer !== undefined ? options.layer : engine.activeLayer;
        const entry = captureLayerSnapshot(engine, chunk, layer, options);
        targetMap.set(id, entry);
        if (options.markDirty !== false) {
            const dirtyIsEmpty = options.dirtyIsEmpty !== undefined ? options.dirtyIsEmpty : false;
            engine._markDirty(id, layer, dirtyIsEmpty, !!options.fromSumi);
        }
        return entry;
    }
    return targetMap.get(id);
}

export function restoreBackupToLayer(engine, chunk, id, data) {
    if (!engine || !chunk || !data) return;
    const layer = data.layer;
    const dstCanvas = chunk.canvases[layer];
    const ctx = chunk.ctxs[layer];
    if (!dstCanvas || !ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (data.wasEmpty || !data.canvas) {
        ctx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
        ctx.restore();
        engine._markDirty(id, layer, true);
    } else {
        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(data.canvas, 0, 0);
        ctx.restore();
        engine._markDirty(id, layer, false);
    }
}
