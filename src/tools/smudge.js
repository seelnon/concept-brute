import { isMobileDevice } from '../colorUtils.js';
import { GpuSmudgeSolver } from './smudgeGpu.js';

const TILE_SIZE = 256;
const SMUDGE_RES = 64;
const SMUDGE_MAX = SMUDGE_RES - 1;

function getGpuSmudgeSolver(engine) {
  const gr = engine && engine.gpuRenderer;
  if (!gr || !gr.supported || !gr.gl) return null;
  if (!gr.smudgeSolver) {
    gr.smudgeSolver = new GpuSmudgeSolver(gr);
  }
  return gr.smudgeSolver.ready ? gr.smudgeSolver : null;
}

// Cached smudge buffers & reusable patch arrays (zero per-stamp GC churn)
let _tipWorkCanvas = null;
let _tipWorkCtx = null;
let _cachedTipRef = null;
const _tipMask = new Float32Array(SMUDGE_RES * SMUDGE_RES);

let _tileReadCanvas = null;
let _tileReadCtx = null;
let _outCanvas = null;
let _outCtx = null;
let _outImageData = null;
let _scratchW = 0;
let _scratchH = 0;

let _patchOrig = new Uint8ClampedArray(0);
let _patchSim = new Float32Array(0);
let _patchCov = new Float32Array(0);
const _tmpSample = new Float32Array(SMUDGE_RES * SMUDGE_RES * 4);

function ensureScratch(w, h) {
  if (!_outCanvas) {
    _outCanvas = document.createElement('canvas');
  }
  if (w > _scratchW || h > _scratchH) {
    const newW = Math.max(_scratchW, w + 64);
    const newH = Math.max(_scratchH, h + 64);
    _scratchW = newW;
    _scratchH = newH;

    _outCanvas.width = newW;
    _outCanvas.height = newH;
    _outCtx = _outCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    _outImageData = _outCtx.createImageData(newW, newH);

    const len = newW * newH;
    _patchOrig = new Uint8ClampedArray(len * 4);
    _patchSim = new Float32Array(len * 4);
    _patchCov = new Float32Array(len);
  } else if (!_outCtx) {
    _outCtx = _outCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
    _outImageData = _outCtx.createImageData(_scratchW, _scratchH);
  }
}

function updateTipMaskCache(tip) {
  const targetRef = tip || 'circle';
  if (_cachedTipRef === targetRef && tip === null) return;
  if (_cachedTipRef === tip && tip !== null) {
    // Re-read in case custom tip canvas was edited in TipManager; cheap 64x64 read
  }
  _cachedTipRef = targetRef;

  if (tip && tip.width > 0 && tip.height > 0) {
    if (!_tipWorkCanvas) {
      _tipWorkCanvas = document.createElement('canvas');
      _tipWorkCanvas.width = SMUDGE_RES;
      _tipWorkCanvas.height = SMUDGE_RES;
      _tipWorkCtx = _tipWorkCanvas.getContext('2d', { willReadFrequently: true });
    }
    _tipWorkCtx.clearRect(0, 0, SMUDGE_RES, SMUDGE_RES);
    _tipWorkCtx.drawImage(tip, 0, 0, SMUDGE_RES, SMUDGE_RES);
    const data = _tipWorkCtx.getImageData(0, 0, SMUDGE_RES, SMUDGE_RES).data;
    for (let i = 0; i < SMUDGE_RES * SMUDGE_RES; i++) {
      _tipMask[i] = data[i * 4 + 3] / 255.0;
    }
  } else {
    const half = (SMUDGE_RES - 1) * 0.5;
    for (let y = 0; y < SMUDGE_RES; y++) {
      const dy = (y - half) / half;
      for (let x = 0; x < SMUDGE_RES; x++) {
        const dx = (x - half) / half;
        const d = Math.hypot(dx, dy);
        // Smooth radial falloff inside unit circle
        _tipMask[y * SMUDGE_RES + x] = d >= 1.0 ? 0.0 : Math.max(0.0, 1.0 - d * d);
      }
    }
  }
}

function sampleTipMask(fx, fy) {
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 < SMUDGE_MAX ? x0 + 1 : x0;
  const y1 = y0 < SMUDGE_MAX ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const r0 = y0 * SMUDGE_RES;
  const r1 = y1 * SMUDGE_RES;
  const v0 = _tipMask[r0 + x0] * (1.0 - tx) + _tipMask[r0 + x1] * tx;
  const v1 = _tipMask[r1 + x0] * (1.0 - tx) + _tipMask[r1 + x1] * tx;
  return v0 * (1.0 - ty) + v1 * ty;
}

function ensureChunkBackup(engine, chunk, cx, cy) {
  const id = `${cx},${cy}`;
  if (!engine.currentStrokeDirtyChunks.has(id)) {
    const srcCanvas = chunk.canvases[engine.activeLayer];
    const backup = document.createElement('canvas');
    backup.width = srcCanvas.width;
    backup.height = srcCanvas.height;
    backup.getContext('2d').drawImage(srcCanvas, 0, 0);
    engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
    engine._markDirty(id, engine.activeLayer, false);
  }
}

function ensureSmudgeTile(engine, tx, ty) {
  if (!engine.smudgeTiles) {
    engine.smudgeTiles = new Map();
  }
  const key = `${tx},${ty}`;
  let tile = engine.smudgeTiles.get(key);
  if (tile) return tile;

  if (!_tileReadCanvas) {
    _tileReadCanvas = document.createElement('canvas');
    _tileReadCanvas.width = TILE_SIZE;
    _tileReadCanvas.height = TILE_SIZE;
    _tileReadCtx = _tileReadCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
  }

  const wx = tx * TILE_SIZE;
  const wy = ty * TILE_SIZE;
  _tileReadCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  let hasPixels = false;
  const layer = engine.activeLayer;

  if (engine.isStatic) {
    const chunk = engine._getChunk(0, 0);
    if (chunk) {
      const lx = -engine.staticWidth / 2;
      const ly = -engine.staticHeight / 2;
      const ox = Math.max(wx, lx);
      const oy = Math.max(wy, ly);
      const ox2 = Math.min(wx + TILE_SIZE, lx + chunk.width);
      const oy2 = Math.min(wy + TILE_SIZE, ly + chunk.height);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow > 0 && oh > 0) {
        ensureChunkBackup(engine, chunk, 0, 0);
        if (!chunk.isEmpty || !chunk.isEmpty[layer]) {
          _tileReadCtx.drawImage(chunk.canvases[layer], ox - lx, oy - ly, ow, oh, ox - wx, oy - wy, ow, oh);
          hasPixels = true;
        }
      }
    }
  } else {
    const sCX = Math.floor(wx / engine.chunkSize);
    const eCX = Math.floor((wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = Math.floor(wy / engine.chunkSize);
    const eCY = Math.floor((wy + TILE_SIZE - 1) / engine.chunkSize);
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine._getChunk(cx, cy);
        if (!chunk) continue;
        ensureChunkBackup(engine, chunk, cx, cy);
        if (chunk.isEmpty && chunk.isEmpty[layer]) continue;
        const lx = cx * engine.chunkSize;
        const ly = cy * engine.chunkSize;
        const ox = Math.max(wx, lx);
        const oy = Math.max(wy, ly);
        const ox2 = Math.min(wx + TILE_SIZE, lx + chunk.width);
        const oy2 = Math.min(wy + TILE_SIZE, ly + chunk.height);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow > 0 && oh > 0) {
          _tileReadCtx.drawImage(chunk.canvases[layer], ox - lx, oy - ly, ow, oh, ox - wx, oy - wy, ow, oh);
          hasPixels = true;
        }
      }
    }
  }

  const len = TILE_SIZE * TILE_SIZE;
  const orig = hasPixels
    ? new Uint8ClampedArray(_tileReadCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data)
    : new Uint8ClampedArray(len * 4);
  const sim = new Float32Array(len * 4);
  if (hasPixels) {
    for (let i = 0; i < len; i++) {
      const i4 = i * 4;
      const a = orig[i4 + 3] / 255.0;
      if (a > 0) {
        sim[i4] = (orig[i4] / 255.0) * a;
        sim[i4 + 1] = (orig[i4 + 1] / 255.0) * a;
        sim[i4 + 2] = (orig[i4 + 2] / 255.0) * a;
        sim[i4 + 3] = a;
      }
    }
  }
  const cov = new Float32Array(len);

  tile = { tx, ty, wx, wy, orig, sim, cov };
  engine.smudgeTiles.set(key, tile);
  return tile;
}

function readPatch(engine, boxX, boxY, boxW, boxH) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  const totalPx = boxW * boxH;
  _patchOrig.fill(0, 0, totalPx * 4);
  _patchSim.fill(0, 0, totalPx * 4);
  _patchCov.fill(0, 0, totalPx);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = ensureSmudgeTile(engine, tx, ty);
      const ox = Math.max(boxX, tile.wx);
      const oy = Math.max(boxY, tile.wy);
      const ox2 = Math.min(boxX + boxW, tile.wx + TILE_SIZE);
      const oy2 = Math.min(boxY + boxH, tile.wy + TILE_SIZE);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const srcX = ox - tile.wx;
      const srcY = oy - tile.wy;
      const dstX = ox - boxX;
      const dstY = oy - boxY;

      for (let row = 0; row < oh; row++) {
        const sOff = (srcY + row) * TILE_SIZE + srcX;
        const dOff = (dstY + row) * boxW + dstX;
        _patchOrig.set(tile.orig.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        _patchSim.set(tile.sim.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        _patchCov.set(tile.cov.subarray(sOff, sOff + ow), dOff);
      }
    }
  }
}

function writePatch(engine, boxX, boxY, boxW, boxH, alphaLock) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = engine.smudgeTiles ? engine.smudgeTiles.get(`${tx},${ty}`) : null;
      if (!tile) continue;
      const ox = Math.max(boxX, tile.wx);
      const oy = Math.max(boxY, tile.wy);
      const ox2 = Math.min(boxX + boxW, tile.wx + TILE_SIZE);
      const oy2 = Math.min(boxY + boxH, tile.wy + TILE_SIZE);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const srcX = ox - boxX;
      const srcY = oy - boxY;
      const dstX = ox - tile.wx;
      const dstY = oy - tile.wy;

      for (let row = 0; row < oh; row++) {
        const sOff = (srcY + row) * boxW + srcX;
        const dOff = (dstY + row) * TILE_SIZE + dstX;
        tile.sim.set(_patchSim.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        tile.cov.set(_patchCov.subarray(sOff, sOff + ow), dOff);
      }
    }
  }

  // Reconstruct straight RGBA into _outImageData blending pre-stroke orig -> simulated smudge by stroke opacity envelope (_patchCov)
  const dstPixels = _outImageData.data;
  for (let y = 0; y < boxH; y++) {
    const srcRow = y * boxW;
    const dstRow = y * _scratchW;
    for (let x = 0; x < boxW; x++) {
      const si = srcRow + x;
      const si4 = si * 4;
      const di4 = (dstRow + x) * 4;

      const c = _patchCov[si];
      if (c <= 0.0005) {
        dstPixels[di4] = _patchOrig[si4];
        dstPixels[di4 + 1] = _patchOrig[si4 + 1];
        dstPixels[di4 + 2] = _patchOrig[si4 + 2];
        dstPixels[di4 + 3] = _patchOrig[si4 + 3];
        continue;
      }

      const oa = _patchOrig[si4 + 3] / 255.0;
      const opr = (_patchOrig[si4] / 255.0) * oa;
      const opg = (_patchOrig[si4 + 1] / 255.0) * oa;
      const opb = (_patchOrig[si4 + 2] / 255.0) * oa;

      const invC = 1.0 - c;
      const spr = _patchSim[si4];
      const spg = _patchSim[si4 + 1];
      const spb = _patchSim[si4 + 2];
      const sa = _patchSim[si4 + 3];

      let outPR = opr * invC + spr * c;
      let outPG = opg * invC + spg * c;
      let outPB = opb * invC + spb * c;
      let outA = oa * invC + sa * c;

      if (alphaLock) {
        if (oa <= 0.001) {
          outPR = 0; outPG = 0; outPB = 0; outA = 0;
        } else {
          const ratio = outA > 0.001 ? (oa / outA) : 0;
          outPR *= ratio;
          outPG *= ratio;
          outPB *= ratio;
          outA = oa;
        }
      }

      if (outA <= 0.002) {
        dstPixels[di4] = 0;
        dstPixels[di4 + 1] = 0;
        dstPixels[di4 + 2] = 0;
        dstPixels[di4 + 3] = 0;
      } else {
        const invA = 255.0 / outA;
        dstPixels[di4] = Math.min(255, Math.max(0, (outPR * invA + 0.5) | 0));
        dstPixels[di4 + 1] = Math.min(255, Math.max(0, (outPG * invA + 0.5) | 0));
        dstPixels[di4 + 2] = Math.min(255, Math.max(0, (outPB * invA + 0.5) | 0));
        dstPixels[di4 + 3] = Math.min(255, Math.max(0, (outA * 255.0 + 0.5) | 0));
      }
    }
  }

  _outCtx.putImageData(_outImageData, 0, 0, 0, 0, boxW, boxH);

  const layer = engine.activeLayer;
  const sCX = engine.isStatic ? 0 : Math.floor(boxX / engine.chunkSize);
  const eCX = engine.isStatic ? 0 : Math.floor((boxX + boxW - 1) / engine.chunkSize);
  const sCY = engine.isStatic ? 0 : Math.floor(boxY / engine.chunkSize);
  const eCY = engine.isStatic ? 0 : Math.floor((boxY + boxH - 1) / engine.chunkSize);

  for (let cx = sCX; cx <= eCX; cx++) {
    for (let cy = sCY; cy <= eCY; cy++) {
      const chunk = engine._getChunk(cx, cy);
      if (!chunk) continue;
      ensureChunkBackup(engine, chunk, cx, cy);

      const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
      const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
      const ox = Math.max(boxX, lx);
      const oy = Math.max(boxY, ly);
      const ox2 = Math.min(boxX + boxW, lx + chunk.width);
      const oy2 = Math.min(boxY + boxH, ly + chunk.height);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const srcX = ox - boxX;
      const srcY = oy - boxY;
      const dstX = ox - lx;
      const dstY = oy - ly;

      const lCtx = chunk.ctxs[layer];
      lCtx.save();
      lCtx.beginPath();
      lCtx.rect(0, 0, chunk.width, chunk.height);
      lCtx.clip();
      if (alphaLock) {
        lCtx.globalCompositeOperation = 'source-atop';
      } else {
        lCtx.clearRect(dstX, dstY, ow, oh);
        lCtx.globalCompositeOperation = 'source-over';
      }
      lCtx.drawImage(_outCanvas, srcX, srcY, ow, oh, dstX, dstY, ow, oh);
      lCtx.restore();

      if (chunk.isEmpty) chunk.isEmpty[layer] = false;
      const id = `${cx},${cy}`;
      engine._markDirty(id, layer, false);

      if (engine.gpuRenderer) {
        if (typeof engine.gpuRenderer.updateChunkTextureSubRegion === 'function') {
          const scale = engine.isStatic ? (engine.dpiScale || 1.0) : 1.0;
          const pxX = Math.max(0, Math.floor(dstX * scale));
          const pxY = Math.max(0, Math.floor(dstY * scale));
          const pxW = Math.min(chunk.canvases[layer].width - pxX, Math.ceil(ow * scale));
          const pxH = Math.min(chunk.canvases[layer].height - pxY, Math.ceil(oh * scale));
          if (pxW > 0 && pxH > 0) {
            const subImg = lCtx.getImageData(pxX, pxY, pxW, pxH);
            engine.gpuRenderer.updateChunkTextureSubRegion(chunk, layer, pxX, pxY, pxW, pxH, subImg);
          }
        } else {
          engine.gpuRenderer.markChunkLayerDirty(chunk, layer);
        }
      }
    }
  }
}

function samplePatchSimBilinear(boxW, boxH, fx, fy, outIdx) {
  const cx = fx < 0 ? 0 : (fx > boxW - 1.001 ? boxW - 1.001 : fx);
  const cy = fy < 0 ? 0 : (fy > boxH - 1.001 ? boxH - 1.001 : fy);
  const ix = cx | 0;
  const iy = cy | 0;
  const tx = cx - ix;
  const ty = cy - iy;
  const i00 = (iy * boxW + ix) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + boxW * 4;
  const i11 = i01 + 4;
  const w00 = (1.0 - tx) * (1.0 - ty);
  const w10 = tx * (1.0 - ty);
  const w01 = (1.0 - tx) * ty;
  const w11 = tx * ty;

  _tmpSample[outIdx] = _patchSim[i00] * w00 + _patchSim[i10] * w10 + _patchSim[i01] * w01 + _patchSim[i11] * w11;
  _tmpSample[outIdx + 1] = _patchSim[i00 + 1] * w00 + _patchSim[i10 + 1] * w10 + _patchSim[i01 + 1] * w01 + _patchSim[i11 + 1] * w11;
  _tmpSample[outIdx + 2] = _patchSim[i00 + 2] * w00 + _patchSim[i10 + 2] * w10 + _patchSim[i01 + 2] * w01 + _patchSim[i11 + 2] * w11;
  _tmpSample[outIdx + 3] = _patchSim[i00 + 3] * w00 + _patchSim[i10 + 3] * w10 + _patchSim[i01 + 3] * w01 + _patchSim[i11 + 3] * w11;
}

export function ensureSmudgeBuffers(engine) {
  if (!engine.smudgeBuf) {
    engine.smudgeBuf = new Float32Array(SMUDGE_RES * SMUDGE_RES * 4);
    engine.smudgeDirty = false;
  }
}

export function paintSmudgeOnChunks(engine, stamps, affectedChunks, flow, opacity, tip) {
  if (!stamps || stamps.length === 0) return;
  if (opacity <= 0.001 || flow <= 0.001) return;

  if (engine.perfMonitor) {
    engine.perfMonitor.markPhase('smudge_step', { stamps: stamps.length, chunks: affectedChunks ? affectedChunks.size : 1 });
  }

  ensureSmudgeBuffers(engine);
  updateTipMaskCache(tip);

  const flowBoost = engine.brush.smudgeFlowBoost !== undefined ? engine.brush.smudgeFlowBoost : 1.0;
  const pickupSetting = engine.brush.smudgePickup !== undefined ? engine.brush.smudgePickup : 2.0;
  const rawStrength = Math.max(0.0, Math.min(1.0, flow * flowBoost));
  const depositBase = rawStrength > 0.001
    ? Math.min(0.95, 1.0 - Math.pow(1.0 - Math.min(0.98, rawStrength * 0.88), 0.35))
    : 0.0;
  const pickupBase = pickupSetting <= 0.005
    ? 0.0
    : Math.min(0.85, (0.04 + flow * 0.24) * (pickupSetting / 2.0));
  const effOpacity = Math.max(0.0, Math.min(1.0, opacity));

  if (engine.useGpuSmudge) {
    const solver = getGpuSmudgeSolver(engine);
    if (solver && solver.active) {
      solver.stepStamps(engine, stamps, depositBase, pickupBase, effOpacity);
      return;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stamps) {
    const sR = Math.max(2, s.size * 0.5);
    minX = Math.min(minX, s.x - sR);
    minY = Math.min(minY, s.y - sR);
    maxX = Math.max(maxX, s.x + sR);
    maxY = Math.max(maxY, s.y + sR);
  }
  const boxX = Math.floor(minX - 2);
  const boxY = Math.floor(minY - 2);
  const boxW = Math.ceil(maxX + 2) - boxX;
  const boxH = Math.ceil(maxY + 2) - boxY;
  if (boxW <= 0 || boxH <= 0) return;

  ensureScratch(boxW, boxH);
  readPatch(engine, boxX, boxY, boxW, boxH);

  const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
  const alphaLock = !!(layerSet && layerSet.alphaLock);

  const buf = engine.smudgeBuf;

  for (const s of stamps) {
    const sR = Math.max(2.0, s.size * 0.5);
    const invR = 1.0 / sR;
    const locX = s.x - boxX;
    const locY = s.y - boxY;
    const angle = s.angle || 0.0;
    const cosFwd = Math.cos(angle);
    const sinFwd = Math.sin(angle);
    const cosInv = cosFwd;
    const sinInv = -sinFwd;

    // 1. Sample pre-deposit patch pixels across the 64x64 brush buffer (fixed O(4096) cost)
    const halfGrid = SMUDGE_MAX * 0.5;
    for (let gy = 0; gy < SMUDGE_RES; gy++) {
      const ny = (gy - halfGrid) / halfGrid;
      const ly = ny * sR;
      for (let gx = 0; gx < SMUDGE_RES; gx++) {
        const nx = (gx - halfGrid) / halfGrid;
        const lx = nx * sR;
        const wx = locX + (lx * cosFwd - ly * sinFwd);
        const wy = locY + (lx * sinFwd + ly * cosFwd);
        samplePatchSimBilinear(boxW, boxH, wx - 0.5, wy - 0.5, (gy * SMUDGE_RES + gx) * 4);
      }
    }

    // 2. Deposit carried smudge buffer onto simulation patch via convex premultiplied LERP (zero alpha compounding!)
    if (engine.smudgeDirty && depositBase > 0.001) {
      const boundR = Math.ceil(sR * (angle === 0 ? 1.0 : 1.42)) + 1;
      const x0 = Math.max(0, Math.floor(locX - boundR));
      const y0 = Math.max(0, Math.floor(locY - boundR));
      const x1 = Math.min(boxW - 1, Math.ceil(locX + boundR));
      const y1 = Math.min(boxH - 1, Math.ceil(locY + boundR));

      for (let py = y0; py <= y1; py++) {
        const dy = py + 0.5 - locY;
        const rowOff = py * boxW;
        for (let px = x0; px <= x1; px++) {
          const dx = px + 0.5 - locX;
          const lx = dx * cosInv - dy * sinInv;
          const ly = dx * sinInv + dy * cosInv;
          const nx = lx * invR;
          const ny = ly * invR;
          if (nx <= -1.0 || nx >= 1.0 || ny <= -1.0 || ny >= 1.0) continue;

          const fu = (nx + 1.0) * 0.5 * SMUDGE_MAX;
          const fv = (ny + 1.0) * 0.5 * SMUDGE_MAX;
          const mask = sampleTipMask(fu, fv);
          if (mask <= 0.002) continue;

          // Bilinear sample carried smudge buffer
          const bx0 = fu | 0;
          const by0 = fv | 0;
          const bx1 = bx0 < SMUDGE_MAX ? bx0 + 1 : bx0;
          const by1 = by0 < SMUDGE_MAX ? by0 + 1 : by0;
          const tx = fu - bx0;
          const ty = fv - by0;
          const b00 = (by0 * SMUDGE_RES + bx0) * 4;
          const b10 = (by0 * SMUDGE_RES + bx1) * 4;
          const b01 = (by1 * SMUDGE_RES + bx0) * 4;
          const b11 = (by1 * SMUDGE_RES + bx1) * 4;
          const bw00 = (1.0 - tx) * (1.0 - ty);
          const bw10 = tx * (1.0 - ty);
          const bw01 = (1.0 - tx) * ty;
          const bw11 = tx * ty;

          const bPR = buf[b00] * bw00 + buf[b10] * bw10 + buf[b01] * bw01 + buf[b11] * bw11;
          const bPG = buf[b00 + 1] * bw00 + buf[b10 + 1] * bw10 + buf[b01 + 1] * bw01 + buf[b11 + 1] * bw11;
          const bPB = buf[b00 + 2] * bw00 + buf[b10 + 2] * bw10 + buf[b01 + 2] * bw01 + buf[b11 + 2] * bw11;
          const bA = buf[b00 + 3] * bw00 + buf[b10 + 3] * bw10 + buf[b01 + 3] * bw01 + buf[b11 + 3] * bw11;

          const si = rowOff + px;
          const si4 = si * 4;
          const w = depositBase * mask;
          const invW = 1.0 - w;

          if (alphaLock) {
            const dstA = _patchSim[si4 + 3];
            if (dstA > 0.002 && bA > 0.002) {
              const dr = _patchSim[si4] / dstA;
              const dg = _patchSim[si4 + 1] / dstA;
              const db = _patchSim[si4 + 2] / dstA;
              const br = bPR / bA;
              const bg = bPG / bA;
              const bb = bPB / bA;
              _patchSim[si4] = (dr * invW + br * w) * dstA;
              _patchSim[si4 + 1] = (dg * invW + bg * w) * dstA;
              _patchSim[si4 + 2] = (db * invW + bb * w) * dstA;
            }
          } else {
            _patchSim[si4] = _patchSim[si4] * invW + bPR * w;
            _patchSim[si4 + 1] = _patchSim[si4 + 1] * invW + bPG * w;
            _patchSim[si4 + 2] = _patchSim[si4 + 2] * invW + bPB * w;
            _patchSim[si4 + 3] = _patchSim[si4 + 3] * invW + bA * w;
          }

          const covTarget = effOpacity * mask;
          if (covTarget > _patchCov[si]) {
            _patchCov[si] = covTarget;
          }
        }
      }
    }

    // 3. Pick up pre-deposit canvas color into carried smudge buffer
    if (!engine.smudgeDirty) {
      buf.set(_tmpSample);
      engine.smudgeDirty = true;
    } else if (pickupBase > 0.001) {
      for (let i = 0; i < SMUDGE_RES * SMUDGE_RES; i++) {
        const mask = _tipMask[i];
        if (mask <= 0.002) continue;
        const p = pickupBase * (0.25 + 0.75 * mask);
        const invP = 1.0 - p;
        const i4 = i * 4;
        buf[i4] = buf[i4] * invP + _tmpSample[i4] * p;
        buf[i4 + 1] = buf[i4 + 1] * invP + _tmpSample[i4 + 1] * p;
        buf[i4 + 2] = buf[i4 + 2] * invP + _tmpSample[i4 + 2] * p;
        buf[i4 + 3] = buf[i4 + 3] * invP + _tmpSample[i4 + 3] * p;
      }
    }
  }

  writePatch(engine, boxX, boxY, boxW, boxH, alphaLock);
}

/**
 * Pre-warms the smudge stroke on pointerdown.
 * Samples initial premultiplied RGBA at worldPos without inflating alpha.
 */
export function startSmudgeStroke(engine, worldPos) {
  ensureSmudgeBuffers(engine);
  if (engine.smudgeTiles) {
    engine.smudgeTiles.clear();
  } else {
    engine.smudgeTiles = new Map();
  }
  engine.smudgeDirty = false;
  engine.smudgeBuf.fill(0);
  engine.useGpuSmudge = false;

  updateTipMaskCache(engine.brush.tip);

  const solver = getGpuSmudgeSolver(engine);
  if (solver && solver.beginStroke(engine, worldPos, _tipMask)) {
    engine.useGpuSmudge = true;
    engine.smudgeDirty = true;
    return;
  }

  const sz = worldPos.size || engine.brush.size || 50;
  const sR = Math.max(2.0, sz * 0.5);
  const boxX = Math.floor(worldPos.x - sR - 2);
  const boxY = Math.floor(worldPos.y - sR - 2);
  const boxW = Math.ceil(worldPos.x + sR + 2) - boxX;
  const boxH = Math.ceil(worldPos.y + sR + 2) - boxY;
  if (boxW <= 0 || boxH <= 0) return;

  ensureScratch(boxW, boxH);
  readPatch(engine, boxX, boxY, boxW, boxH);

  const locX = worldPos.x - boxX;
  const locY = worldPos.y - boxY;
  const halfGrid = SMUDGE_MAX * 0.5;
  const buf = engine.smudgeBuf;
  for (let gy = 0; gy < SMUDGE_RES; gy++) {
    const ny = (gy - halfGrid) / halfGrid;
    const wy = locY + ny * sR - 0.5;
    for (let gx = 0; gx < SMUDGE_RES; gx++) {
      const nx = (gx - halfGrid) / halfGrid;
      const wx = locX + nx * sR - 0.5;
      const i4 = (gy * SMUDGE_RES + gx) * 4;
      samplePatchSimBilinear(boxW, boxH, wx, wy, i4);
      buf[i4] = _tmpSample[i4];
      buf[i4 + 1] = _tmpSample[i4 + 1];
      buf[i4 + 2] = _tmpSample[i4 + 2];
      buf[i4 + 3] = _tmpSample[i4 + 3];
    }
  }
  engine.smudgeDirty = true;
}

export function endSmudgeStroke(engine) {
  if (engine && engine.useGpuSmudge) {
    const solver = engine.gpuRenderer && engine.gpuRenderer.smudgeSolver;
    if (solver) {
      solver.endStroke(engine);
    }
    engine.useGpuSmudge = false;
  }
  if (engine && engine.smudgeTiles) {
    engine.smudgeTiles.clear();
  }
  if (engine) {
    engine.smudgeDirty = false;
  }
}

export function cancelSmudgeStroke(engine) {
  if (!engine) return;
  if (engine.useGpuSmudge) {
    const solver = engine.gpuRenderer && engine.gpuRenderer.smudgeSolver;
    if (solver && typeof solver.cancel === 'function') {
      solver.cancel(engine);
    }
    engine.useGpuSmudge = false;
  }
  if (engine.smudgeTiles) {
    engine.smudgeTiles.clear();
  }
  engine.smudgeDirty = false;
}

