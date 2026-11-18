import { backupChunkLayer } from '../engine/backupPool.js';

const TILE_SIZE = 256;
const MAX_TILE_POOL = 64;

const _tilePool = [];
let _inkScratchCanvas = null;
let _inkScratchCtx = null;
let _inkScratchImgData = null;

function _ensureScratchInk() {
    if (!_inkScratchCanvas) {
        _inkScratchCanvas = document.createElement('canvas');
        _inkScratchCanvas.width = TILE_SIZE;
        _inkScratchCanvas.height = TILE_SIZE;
        _inkScratchCtx = _inkScratchCanvas.getContext('2d', { alpha: true });
        _inkScratchImgData = _inkScratchCtx.createImageData(TILE_SIZE, TILE_SIZE);
    }
}

function _acquireTile(tx, ty) {
    let tile = _tilePool.pop();
    if (!tile) {
        tile = {
            tx: 0,
            ty: 0,
            wx: 0,
            wy: 0,
            inkData: new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4),
            webCanvas: null,
            webCtx: null,
            hasInk: false,
            hasWeb: false
        };
    } else {
        tile.inkData.fill(0);
        if (tile.webCtx && tile.hasWeb) {
            tile.webCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        }
        tile.hasInk = false;
        tile.hasWeb = false;
    }
    tile.tx = tx;
    tile.ty = ty;
    tile.wx = tx * TILE_SIZE;
    tile.wy = ty * TILE_SIZE;
    return tile;
}

function _ensureTileWebCanvas(tile) {
    if (!tile.webCanvas) {
        tile.webCanvas = document.createElement('canvas');
        tile.webCanvas.width = TILE_SIZE;
        tile.webCanvas.height = TILE_SIZE;
        tile.webCtx = tile.webCanvas.getContext('2d', { alpha: true });
    }
    return tile.webCtx;
}

function _getOrCreateTile(state, tx, ty) {
    const key = `${tx},${ty}`;
    let tile = state.tiles.get(key);
    if (!tile) {
        tile = _acquireTile(tx, ty);
        state.tiles.set(key, tile);
    }
    return tile;
}

function _releaseStateTiles(state) {
    if (!state || !state.tiles) return;
    state.tiles.forEach((tile) => {
        if (_tilePool.length < MAX_TILE_POOL) {
            _tilePool.push(tile);
        }
    });
    state.tiles.clear();
}

function _parseHexRgb(hex) {
    if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    let h = hex.trim();
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) {
        return {
            r: parseInt(h[0] + h[0], 16) || 0,
            g: parseInt(h[1] + h[1], 16) || 0,
            b: parseInt(h[2] + h[2], 16) || 0
        };
    }
    if (h.length >= 6) {
        return {
            r: parseInt(h.slice(0, 2), 16) || 0,
            g: parseInt(h.slice(2, 4), 16) || 0,
            b: parseInt(h.slice(4, 6), 16) || 0
        };
    }
    return { r: 0, g: 0, b: 0 };
}

function _inkRadiusFromSize(size) {
    return Math.max(0.45, size * 0.16 * 0.5);
}

function _inkAlphaByte(engine, pointOpacity) {
    const flow = (engine.brush && engine.brush.flow !== undefined) ? engine.brush.flow : 1.0;
    const a = Math.max(0.01, Math.min(1.0, (pointOpacity ?? 1.0) * flow));
    return Math.round(a * 255);
}

/**
 * Analytic anti-aliased capsule rasterizer using MAX-alpha compositing.
 * Overlapping joints never double-darken, completely eliminating beaded dots.
 */
function _rasterizeInkCapsule(engine, state, x0, y0, r0, a0, c0, x1, y1, r1, a1, c1, dirtyBounds) {
    const maxR = Math.max(r0, r1);
    const pad = maxR + 1.5;
    const minX = Math.floor(Math.min(x0, x1) - pad);
    const maxX = Math.ceil(Math.max(x0, x1) + pad);
    const minY = Math.floor(Math.min(y0, y1) - pad);
    const maxY = Math.ceil(Math.max(y0, y1) + pad);

    if (engine.isStatic) {
        const halfW = engine.staticWidth * 0.5;
        const halfH = engine.staticHeight * 0.5;
        if (maxX < -halfW || minX > halfW || maxY < -halfH || minY > halfH) {
            return;
        }
    }

    if (minX < dirtyBounds.minX) dirtyBounds.minX = minX;
    if (maxX > dirtyBounds.maxX) dirtyBounds.maxX = maxX;
    if (minY < dirtyBounds.minY) dirtyBounds.minY = minY;
    if (maxY > dirtyBounds.maxY) dirtyBounds.maxY = maxY;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    const invLenSq = lenSq > 1e-6 ? 1.0 / lenSq : 0.0;
    const dr = r1 - r0;
    const da = a1 - a0;
    const dRed = c1.r - c0.r;
    const dGreen = c1.g - c0.g;
    const dBlue = c1.b - c0.b;

    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1) / TILE_SIZE);

    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const tile = _getOrCreateTile(state, tx, ty);
            const lx0 = Math.max(0, minX - tile.wx);
            const ly0 = Math.max(0, minY - tile.wy);
            const lx1 = Math.min(TILE_SIZE, maxX - tile.wx);
            const ly1 = Math.min(TILE_SIZE, maxY - tile.wy);
            if (lx0 >= lx1 || ly0 >= ly1) continue;

            const ink = tile.inkData;
            for (let ly = ly0; ly < ly1; ly++) {
                const py = tile.wy + ly + 0.5;
                const rowOffset = ly * TILE_SIZE * 4;
                for (let lx = lx0; lx < lx1; lx++) {
                    const px = tile.wx + lx + 0.5;
                    let t = 0.0;
                    if (invLenSq > 0.0) {
                        t = ((px - x0) * dx + (py - y0) * dy) * invLenSq;
                        if (t < 0.0) t = 0.0;
                        else if (t > 1.0) t = 1.0;
                    }
                    const cx = x0 + dx * t;
                    const cy = y0 + dy * t;
                    const dist = Math.hypot(px - cx, py - cy);
                    const r = r0 + dr * t;

                    // Crisp 1px analytic antialiasing with hairline falloff for sub-pixel tips
                    const edge = 0.5 + (r - dist);
                    if (edge <= 0.0) continue;
                    let cov = edge >= 1.0 ? 1.0 : edge;
                    if (r < 0.5) {
                        cov *= Math.max(0.05, r * 2.0);
                    }

                    const baseA = a0 + da * t;
                    const targetA = (cov * baseA + 0.5) | 0;
                    if (targetA <= 0) continue;

                    const idx = rowOffset + lx * 4;
                    const prevA = ink[idx + 3];
                    if (targetA > prevA || (cov >= 0.99 && targetA >= prevA && lenSq > 0.0)) {
                        ink[idx] = (c0.r + dRed * t + 0.5) | 0;
                        ink[idx + 1] = (c0.g + dGreen * t + 0.5) | 0;
                        ink[idx + 2] = (c0.b + dBlue * t + 0.5) | 0;
                        ink[idx + 3] = targetA;
                        tile.hasInk = true;
                    }
                }
            }
        }
    }
}

function _rasterizeQuadraticInk(engine, state, p0, p1, p2, dirtyBounds) {
    const chordDist = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.min(24, Math.max(1, Math.ceil(chordDist / 2.5)));

    const rStart = _inkRadiusFromSize(p0.size);
    const aStart = _inkAlphaByte(engine, p0.opacity);
    const cStart = _parseHexRgb(p0.color);

    const rEnd = _inkRadiusFromSize(p2.size);
    const aEnd = _inkAlphaByte(engine, p2.opacity);
    const cEnd = _parseHexRgb(p2.color);

    let prevX = p0.x;
    let prevY = p0.y;
    let prevR = rStart;
    let prevA = aStart;
    let prevC = cStart;

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const tInv = 1.0 - t;
        const nx = tInv * tInv * p0.x + 2.0 * tInv * t * p1.x + t * t * p2.x;
        const ny = tInv * tInv * p0.y + 2.0 * tInv * t * p1.y + t * t * p2.y;
        const nr = rStart + (rEnd - rStart) * t;
        const na = aStart + (aEnd - aStart) * t;
        const nc = {
            r: Math.round(cStart.r + (cEnd.r - cStart.r) * t),
            g: Math.round(cStart.g + (cEnd.g - cStart.g) * t),
            b: Math.round(cStart.b + (cEnd.b - cStart.b) * t)
        };

        _rasterizeInkCapsule(engine, state, prevX, prevY, prevR, prevA, prevC, nx, ny, nr, na, nc, dirtyBounds);
        prevX = nx;
        prevY = ny;
        prevR = nr;
        prevA = na;
        prevC = nc;
    }
}

function _rasterizeLinearInk(engine, state, p0, p1, dirtyBounds) {
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const steps = Math.min(24, Math.max(1, Math.ceil(dist / 3.0)));

    const r0 = _inkRadiusFromSize(p0.size);
    const a0 = _inkAlphaByte(engine, p0.opacity);
    const c0 = _parseHexRgb(p0.color);
    const r1 = _inkRadiusFromSize(p1.size);
    const a1 = _inkAlphaByte(engine, p1.opacity);
    const c1 = _parseHexRgb(p1.color);

    let prevX = p0.x;
    let prevY = p0.y;
    let prevR = r0;
    let prevA = a0;
    let prevC = c0;

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const nx = p0.x + (p1.x - p0.x) * t;
        const ny = p0.y + (p1.y - p0.y) * t;
        const nr = r0 + (r1 - r0) * t;
        const na = a0 + (a1 - a0) * t;
        const nc = {
            r: Math.round(c0.r + (c1.r - c0.r) * t),
            g: Math.round(c0.g + (c1.g - c0.g) * t),
            b: Math.round(c0.b + (c1.b - c0.b) * t)
        };
        _rasterizeInkCapsule(engine, state, prevX, prevY, prevR, prevA, prevC, nx, ny, nr, na, nc, dirtyBounds);
        prevX = nx;
        prevY = ny;
        prevR = nr;
        prevA = na;
        prevC = nc;
    }
}

function _drawWireframeWebConnections(engine, state, p, dirtyBounds) {
    const wireNodes = state.wireNodes;
    const j = wireNodes.length - 1;
    if (j < 1) return;

    const dynamicSize = p.size;
    const thresholdMaxRatio = engine.brush.wireRange ?? 4.0;
    const thresholdMinRatio = engine.brush.wireMinDist ?? 0.5;
    const maxSeek = engine.brush.wireDensity ?? 30;
    const flow = engine.brush.flow ?? 1.0;

    const thresholdMax = dynamicSize * thresholdMaxRatio;
    const thresholdMin = dynamicSize * thresholdMinRatio;
    const connOpacity = Math.max(0.02, Math.min(0.45, p.opacity * flow * 0.2));
    const baseConnWidth = Math.max(0.35, Math.min(2.5, dynamicSize * 0.04));

    const connPoints = [];
    let minX = p.x;
    let maxX = p.x;
    let minY = p.y;
    let maxY = p.y;

    for (let i = Math.max(0, j - maxSeek); i < j - 1; i++) {
        const prevP = wireNodes[i];
        const dx = prevP.x - p.x;
        const dy = prevP.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > thresholdMin && d < thresholdMax) {
            connPoints.push(prevP);
            if (prevP.x < minX) minX = prevP.x;
            if (prevP.x > maxX) maxX = prevP.x;
            if (prevP.y < minY) minY = prevP.y;
            if (prevP.y > maxY) maxY = prevP.y;
        }
    }

    if (connPoints.length === 0) return;

    const pad = baseConnWidth + 3;
    minX = Math.floor(minX - pad);
    maxX = Math.ceil(maxX + pad);
    minY = Math.floor(minY - pad);
    maxY = Math.ceil(maxY + pad);

    if (engine.isStatic) {
        const halfW = engine.staticWidth * 0.5;
        const halfH = engine.staticHeight * 0.5;
        if (maxX < -halfW || minX > halfW || maxY < -halfH || minY > halfH) {
            return;
        }
    }

    if (minX < dirtyBounds.minX) dirtyBounds.minX = minX;
    if (maxX > dirtyBounds.maxX) dirtyBounds.maxX = maxX;
    if (minY < dirtyBounds.minY) dirtyBounds.minY = minY;
    if (maxY > dirtyBounds.maxY) dirtyBounds.maxY = maxY;

    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1) / TILE_SIZE);

    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const tile = _getOrCreateTile(state, tx, ty);
            const wCtx = _ensureTileWebCanvas(tile);
            wCtx.save();
            wCtx.translate(-tile.wx, -tile.wy);
            wCtx.globalCompositeOperation = 'source-over';
            wCtx.globalAlpha = connOpacity;
            wCtx.lineCap = 'round';
            wCtx.lineJoin = 'round';
            wCtx.lineWidth = baseConnWidth;
            wCtx.strokeStyle = p.color;
            wCtx.beginPath();
            for (let k = 0; k < connPoints.length; k++) {
                wCtx.moveTo(connPoints[k].x, connPoints[k].y);
                wCtx.lineTo(p.x, p.y);
            }
            wCtx.stroke();
            wCtx.restore();
            tile.hasWeb = true;
        }
    }
}

function _compositeDirtyBoundsToChunks(engine, state, dirtyBounds) {
    if (dirtyBounds.minX >= dirtyBounds.maxX || dirtyBounds.minY >= dirtyBounds.maxY) return;

    const minX = dirtyBounds.minX;
    const maxX = dirtyBounds.maxX;
    const minY = dirtyBounds.minY;
    const maxY = dirtyBounds.maxY;

    engine.strokeMinX = Math.min(engine.strokeMinX, minX);
    engine.strokeMaxX = Math.max(engine.strokeMaxX, maxX);
    engine.strokeMinY = Math.min(engine.strokeMinY, minY);
    engine.strokeMaxY = Math.max(engine.strokeMaxY, maxY);

    if (engine.isStatic) {
        const halfW = engine.staticWidth * 0.5;
        const halfH = engine.staticHeight * 0.5;
        if (maxX < -halfW || minX > halfW || maxY < -halfH || minY > halfH) {
            return;
        }
    }

    _ensureScratchInk();

    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1) / TILE_SIZE);

    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const tile = state.tiles.get(`${tx},${ty}`);
            if (!tile || (!tile.hasInk && !tile.hasWeb)) continue;

            const rx0 = Math.max(0, minX - tile.wx);
            const ry0 = Math.max(0, minY - tile.wy);
            const rx1 = Math.min(TILE_SIZE, maxX - tile.wx);
            const ry1 = Math.min(TILE_SIZE, maxY - tile.wy);
            const rw = rx1 - rx0;
            const rh = ry1 - ry0;
            if (rw <= 0 || rh <= 0) continue;

            if (tile.hasInk) {
                const dst = _inkScratchImgData.data;
                const src = tile.inkData;
                for (let row = ry0; row < ry1; row++) {
                    const rowOff = (row * TILE_SIZE + rx0) * 4;
                    dst.set(src.subarray(rowOff, rowOff + rw * 4), rowOff);
                }
                _inkScratchCtx.putImageData(_inkScratchImgData, 0, 0, rx0, ry0, rw, rh);
            }

            const worldMinX = tile.wx + rx0;
            const worldMinY = tile.wy + ry0;
            const worldMaxX = tile.wx + rx1;
            const worldMaxY = tile.wy + ry1;

            const sCX = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
            const eCX = engine.isStatic ? 0 : Math.floor((worldMaxX - 1) / engine.chunkSize);
            const sCY = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
            const eCY = engine.isStatic ? 0 : Math.floor((worldMaxY - 1) / engine.chunkSize);

            for (let cx = sCX; cx <= eCX; cx++) {
                for (let cy = sCY; cy <= eCY; cy++) {
                    const chunk = engine._getChunk(cx, cy);
                    if (!chunk) continue;

                    const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
                    const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
                    const ox = Math.max(worldMinX, lx);
                    const oy = Math.max(worldMinY, ly);
                    const ox2 = Math.min(worldMaxX, lx + chunk.width);
                    const oy2 = Math.min(worldMaxY, ly + chunk.height);
                    const ow = ox2 - ox;
                    const oh = oy2 - oy;
                    if (ow <= 0 || oh <= 0) continue;

                    const id = `${cx},${cy}`;
                    backupChunkLayer(engine, chunk, id, { layer: engine.activeLayer });

                    engine._ensureStrokeCanvas(chunk);
                    chunk.strokeCanvas.style.opacity = engine.brush.opacity ?? 1.0;

                    const dstX = ox - lx;
                    const dstY = oy - ly;
                    const srcX = ox - tile.wx;
                    const srcY = oy - tile.wy;

                    const sCtx = chunk.strokeCtx;
                    sCtx.save();
                    sCtx.beginPath();
                    sCtx.rect(0, 0, chunk.width, chunk.height);
                    sCtx.clip();
                    sCtx.clearRect(dstX, dstY, ow, oh);
                    sCtx.globalCompositeOperation = 'source-over';
                    sCtx.globalAlpha = 1.0;
                    if (tile.hasWeb && tile.webCanvas) {
                        sCtx.drawImage(tile.webCanvas, srcX, srcY, ow, oh, dstX, dstY, ow, oh);
                    }
                    if (tile.hasInk) {
                        sCtx.drawImage(_inkScratchCanvas, srcX, srcY, ow, oh, dstX, dstY, ow, oh);
                    }
                    sCtx.restore();

                    if (engine.gpuRenderer) {
                        engine.gpuRenderer.markChunkStrokeDirty(chunk, true);
                    }
                }
            }
        }
    }
}

export function startWireframeStroke(engine, worldPos) {
    if (engine._wireframeState) {
        _releaseStateTiles(engine._wireframeState);
    }
    engine._wireframeState = {
        inkPoints: [{ ...worldPos }],
        wireNodes: [{ ...worldPos }],
        lastMid: null,
        tiles: new Map()
    };
}

export function paintWireframeMove(engine, worldPos) {
    if (!engine._wireframeState) {
        startWireframeStroke(engine, worldPos);
        return;
    }

    const state = engine._wireframeState;
    const inkPoints = state.inkPoints;
    const prevInk = inkPoints[inkPoints.length - 1];
    const inkDist = Math.hypot(worldPos.x - prevInk.x, worldPos.y - prevInk.y);
    if (inkDist < 1.25) return;

    const dirtyBounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity
    };

    const nextPoint = { ...worldPos };
    inkPoints.push(nextPoint);

    if (inkPoints.length === 2) {
        // Recalibrate initial point pressure/size smoothly to match initial move velocity/pressure
        const p0 = inkPoints[0];
        p0.size = nextPoint.size;
        p0.opacity = nextPoint.opacity;
        p0.color = nextPoint.color;
        p0.pressure = nextPoint.pressure;

        const mid = {
            x: (p0.x + nextPoint.x) * 0.5,
            y: (p0.y + nextPoint.y) * 0.5,
            size: (p0.size + nextPoint.size) * 0.5,
            opacity: (p0.opacity + nextPoint.opacity) * 0.5,
            color: nextPoint.color
        };
        _rasterizeLinearInk(engine, state, p0, mid, dirtyBounds);
        state.lastMid = mid;
    } else if (inkPoints.length >= 3) {
        const pPrev = inkPoints[inkPoints.length - 2];
        const nextMid = {
            x: (pPrev.x + nextPoint.x) * 0.5,
            y: (pPrev.y + nextPoint.y) * 0.5,
            size: (pPrev.size + nextPoint.size) * 0.5,
            opacity: (pPrev.opacity + nextPoint.opacity) * 0.5,
            color: nextPoint.color
        };
        _rasterizeQuadraticInk(engine, state, state.lastMid, pPrev, nextMid, dirtyBounds);
        state.lastMid = nextMid;
    }

    // Wireframe web nodes keep consistent structural spacing for density/range sliders
    const wireNodes = state.wireNodes;
    const lastNode = wireNodes[wireNodes.length - 1];
    const nodeDist = Math.hypot(nextPoint.x - lastNode.x, nextPoint.y - lastNode.y);
    const minWireStep = Math.max(2.5, nextPoint.size * Math.max(0.12, engine.brush.spacing || 0.05));
    if (nodeDist >= minWireStep) {
        const nodeCopy = { ...nextPoint };
        wireNodes.push(nodeCopy);
        engine.strokePoints.push(nodeCopy);
        _drawWireframeWebConnections(engine, state, nodeCopy, dirtyBounds);
    }

    _compositeDirtyBoundsToChunks(engine, state, dirtyBounds);
}

export function endWireframeStroke(engine) {
    const state = engine._wireframeState;
    if (!state) return;

    const dirtyBounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity
    };

    const inkPoints = state.inkPoints;
    if (inkPoints.length === 1) {
        // Single click/tap -> clean circular ink nib dot
        const p = inkPoints[0];
        const r = _inkRadiusFromSize(p.size);
        const a = _inkAlphaByte(engine, p.opacity);
        const c = _parseHexRgb(p.color);
        _rasterizeInkCapsule(engine, state, p.x, p.y, r, a, c, p.x, p.y, r, a, c, dirtyBounds);
        _compositeDirtyBoundsToChunks(engine, state, dirtyBounds);
    } else if (inkPoints.length >= 2 && state.lastMid) {
        // Flush trailing half-segment smoothly to release point
        const pLast = inkPoints[inkPoints.length - 1];
        _rasterizeLinearInk(engine, state, state.lastMid, pLast, dirtyBounds);
        _compositeDirtyBoundsToChunks(engine, state, dirtyBounds);
    }

    _releaseStateTiles(state);
    engine._wireframeState = null;
}

export function cancelWireframeStroke(engine) {
    const state = engine && engine._wireframeState;
    if (!state) return;
    _releaseStateTiles(state);
    engine._wireframeState = null;
}

export function paintWireframeIncrementally(engine, j) {
    const points = engine.strokePoints;
    if (j < 1 || j >= points.length) return;
    paintWireframeMove(engine, points[j]);
}

