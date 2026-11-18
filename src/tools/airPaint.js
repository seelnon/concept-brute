import { TOOLS } from '../constants.js';
import { hexToRgb, rgbToHsl, hslToRgb } from '../colorUtils.js';
import { GpuWatercolorSolver } from './airWatercolorGpu.js';
import { backupChunkLayer } from '../engine/backupPool.js';

/**
 * Air Paint — Incompressible Navier-Stokes Watercolor Wash Engine
 * - Abstract 2D incompressible Navier-Stokes solver (vorticity confinement + Poisson pressure projection + semi-Lagrangian advection)
 * - Persistent wet paper film across strokes on sparse 256x256 world tiles (wet-on-wet bleeding with 100% Undo fidelity)
 * - Zero popping: ring-capped non-truncated Navier-Stokes dye ribbons embedded directly into wet grid diffusion
 * - Authentic watercolor optical glazing (Beer-Lambert multiply tint), capillary bloom & bleed,
 *   coffee-ring drying pigment edge, and world-locked cold-press paper granulation
 */

const TILE_SIZE = 256;
const TIP_RES = 64;
const MAX_STREAMERS = 110;
const MAX_WET_CACHE_TILES = 96;

// Cached Air/Watercolor settings (0 DOM reads inside draw loop)
export const airSettings = {
  wetness: 100,     // 0..100
  streamFlow: 100,  // 0..100
  bloom: 50,        // 0..100
  edge: 30,         // 0..100
  granulation: 30,  // 0..100
  tipPour: 100,     // 0..100 (0 = crisp Draw silhouette, 100 = wet Pour puddle)
  followStroke: false,
  tipAngle: 0,      // -180..180 deg
  tipHardness: 55,  // 0..100
  pressureFlow: 35  // 0..100
};

export function syncAirSettingsFromTip(tipSettings) {
  if (!tipSettings) return;
  airSettings.wetness = tipSettings.airWetness ?? 100;
  airSettings.streamFlow = tipSettings.airStreamFlow ?? 100;
  airSettings.bloom = tipSettings.airBloom ?? 50;
  airSettings.edge = tipSettings.airEdge ?? 30;
  airSettings.granulation = tipSettings.airGranulation ?? 30;
  airSettings.tipPour = tipSettings.airTipPour ?? 100;
  airSettings.followStroke = !!tipSettings.airFollowStroke;
  airSettings.tipAngle = tipSettings.airTipAngle ?? 0;
  airSettings.tipHardness = tipSettings.airTipHardness ?? 55;
  airSettings.pressureFlow = tipSettings.airPressureFlow ?? 35;
}

// Reusable 64x64 Brush Tip silhouette / mass / outward-gradient buffers
let _tipWorkCanvas = null;
let _tipWorkCtx = null;
const _airTipRaw = new Float32Array(TIP_RES * TIP_RES);
const _airTipBlurTmp = new Float32Array(TIP_RES * TIP_RES);
const _airTipBump = new Float32Array(TIP_RES * TIP_RES);
const _airTipGradX = new Float32Array(TIP_RES * TIP_RES);
const _airTipGradY = new Float32Array(TIP_RES * TIP_RES);
const _airTipRgbaBytes = new Uint8Array(TIP_RES * TIP_RES * 4);
let _hasAirTip = false;
let _preparedAirTipRef = null;
let _preparedAirTipKey = '';
let _preparedAirTipVersionCounter = 0;

// Persistent sparse paper wetness & velocity cache across strokes
const _paperWetTiles = new Map();

// Reusable scratch buffers (zero per-frame heap churn)
let _tileReadCanvas = null;
let _tileReadCtx = null;
let _outCanvas = null;
let _outCtx = null;
let _outImageData = null;
let _scratchW = 0;
let _scratchH = 0;

let _patchPixels = new Uint8ClampedArray(0);
let _patchWater = new Float32Array(0);
let _patchVx = new Float32Array(0);
let _patchVy = new Float32Array(0);
let _patchDist = new Float32Array(0);
let _patchCover = new Float32Array(0);

let _outBufRGBA = new Uint8ClampedArray(0);
let _outBufWater = new Float32Array(0);
let _outBufVx = new Float32Array(0);
let _outBufVy = new Float32Array(0);
let _outBufDist = new Float32Array(0);
let _outBufCover = new Float32Array(0);

// Reusable downsampled Navier-Stokes grid buffers
let _nsCap = 0;
let _nsU = new Float32Array(0);
let _nsV = new Float32Array(0);
let _nsU0 = new Float32Array(0);
let _nsV0 = new Float32Array(0);
let _nsDiv = new Float32Array(0);
let _nsP = new Float32Array(0);
let _nsOmega = new Float32Array(0);
let _nsW = new Float32Array(0);
let _nsW0 = new Float32Array(0);
let _nsPR = new Float32Array(0);
let _nsPG = new Float32Array(0);
let _nsPB = new Float32Array(0);
let _nsA = new Float32Array(0);
let _nsPR0 = new Float32Array(0);
let _nsPG0 = new Float32Array(0);
let _nsPB0 = new Float32Array(0);
let _nsA0 = new Float32Array(0);
let _nsDist = new Float32Array(0);
let _nsCov = new Float32Array(0);
let _nsNewCov = new Float32Array(0);

// ----------------------------------------------------
// UI PANEL LIFECYCLE
// ----------------------------------------------------
export function initAirPaint(app) {
  const panelAir = document.getElementById('panel-air');
  const btnCollapse = document.getElementById('btn-air-collapse');

  if (app._makeDraggable && panelAir) {
    app._makeDraggable(panelAir, document.getElementById('handle-air'));
  }

  if (btnCollapse) {
    btnCollapse.onclick = () => {
      const content = document.getElementById('air-content');
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'flex' : 'none';
        btnCollapse.innerText = isHidden ? '_' : '+';
      }
    };
  }
}

export function activateAirPaint(app) {
  const panel = document.getElementById('panel-air');
  if (panel) panel.classList.remove('hidden');
  if (app && app.getCurrentTipSettings) {
    const ts = app.getCurrentTipSettings();
    if (ts) syncAirSettingsFromTip(ts);
  }
  app._status('WATERCOLOR AIR BRUSH ACTIVE');
}

export function deactivateAirPaint(app) {
  const panel = document.getElementById('panel-air');
  if (panel) panel.classList.add('hidden');
  if (app && app.engine) {
    clearAirParticles(app.engine);
    if (app.engine.gpuRenderer && app.engine.gpuRenderer.airSolver) {
      app.engine.gpuRenderer.airSolver.cancel();
    }
  } else {
    clearAirParticles();
  }
  app._status('AIR BRUSH DEACTIVATED');
}

// ----------------------------------------------------
// MEMORY MANAGEMENT
// ----------------------------------------------------
function ensurePatchScratch(w, h) {
  if (!_outCanvas) {
    _outCanvas = document.createElement('canvas');
  }

  if (w > _scratchW || h > _scratchH) {
    const newW = Math.max(_scratchW, w + 32);
    const newH = Math.max(_scratchH, h + 32);
    _scratchW = newW;
    _scratchH = newH;

    _outCanvas.width = newW;
    _outCanvas.height = newH;
    _outCtx = _outCanvas.getContext('2d', { willReadFrequently: true });
    _outImageData = _outCtx.createImageData(newW, newH);

    const len = newW * newH;
    _patchPixels = new Uint8ClampedArray(len * 4);
    _patchWater = new Float32Array(len);
    _patchVx = new Float32Array(len);
    _patchVy = new Float32Array(len);
    _patchDist = new Float32Array(len);
    _patchCover = new Float32Array(len);

    _outBufRGBA = new Uint8ClampedArray(len * 4);
    _outBufWater = new Float32Array(len);
    _outBufVx = new Float32Array(len);
    _outBufVy = new Float32Array(len);
    _outBufDist = new Float32Array(len);
    _outBufCover = new Float32Array(len);
  } else if (!_outCtx) {
    _outCtx = _outCanvas.getContext('2d', { willReadFrequently: true });
    _outImageData = _outCtx.createImageData(_scratchW, _scratchH);
  }
}

function ensureNsGrid(cells) {
  if (cells <= _nsCap) return;
  _nsCap = Math.max(cells, Math.ceil(cells * 1.25));
  _nsU = new Float32Array(_nsCap);
  _nsV = new Float32Array(_nsCap);
  _nsU0 = new Float32Array(_nsCap);
  _nsV0 = new Float32Array(_nsCap);
  _nsDiv = new Float32Array(_nsCap);
  _nsP = new Float32Array(_nsCap);
  _nsOmega = new Float32Array(_nsCap);
  _nsW = new Float32Array(_nsCap);
  _nsW0 = new Float32Array(_nsCap);
  _nsPR = new Float32Array(_nsCap);
  _nsPG = new Float32Array(_nsCap);
  _nsPB = new Float32Array(_nsCap);
  _nsA = new Float32Array(_nsCap);
  _nsPR0 = new Float32Array(_nsCap);
  _nsPG0 = new Float32Array(_nsCap);
  _nsPB0 = new Float32Array(_nsCap);
  _nsA0 = new Float32Array(_nsCap);
  _nsDist = new Float32Array(_nsCap);
  _nsCov = new Float32Array(_nsCap);
  _nsNewCov = new Float32Array(_nsCap);
}

// ----------------------------------------------------
// MATH & DETERMINISTIC WATERCOLOR FIELDS
// ----------------------------------------------------
function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

function parseColor(c) {
  if (!c) return { r: 45, g: 110, b: 200 };
  if (typeof c === 'object' && c.r !== undefined) {
    return { r: c.r, g: c.g, b: c.b };
  }
  if (typeof c === 'string') {
    if (c.startsWith('#')) {
      const rgb = hexToRgb(c);
      if (rgb) return rgb;
    }
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    }
  }
  return { r: 45, g: 110, b: 200 };
}

/**
 * Analytic divergence-free curl perturbation for fluid eddies.
 */
function sampleCurl(x, y, time, freq) {
  const px = x * freq;
  const py = y * freq;
  const a = (px * 0.927 + py * 0.375) + time * 0.68;
  const b = (-px * 0.545 + py * 0.838) * 1.37 - time * 0.53;
  const c = (-px * 0.312 - py * 0.950) * 2.13 + time * 0.81;

  const sa = Math.sin(a);
  const sb = Math.sin(b + 0.62 * sa);
  const sc = Math.sin(c + 0.58 * sb);

  const w1 = Math.cos(a + 0.55 * sc);
  const w2 = Math.cos(b + 0.62 * sa);
  const w3 = Math.cos(c + 0.58 * sb);

  return {
    vx: 0.72 * w1 - 0.64 * w2 + 0.48 * w3,
    vy: -0.58 * w1 - 0.71 * w2 - 0.52 * w3
  };
}

/**
 * World-anchored deterministic cold-press watercolor paper tooth [0..1].
 * Never shimmers or swims between frames because it depends purely on world coordinates.
 */
function samplePaperTooth(wx, wy) {
  const rx = wx * 0.80 - wy * 0.60;
  const ry = wx * 0.60 + wy * 0.80;
  const w1 = Math.sin(rx * 0.14 + Math.cos(ry * 0.19) * 1.35);
  const w2 = Math.sin((-wx * 0.545 + wy * 0.838) * 0.29 + 0.8 * w1);
  const w3 = Math.sin((-wx * 0.312 - wy * 0.950) * 0.53 + 0.65 * w2);
  const v = 0.50 + 0.22 * w1 + 0.16 * w2 + 0.12 * w3;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// ----------------------------------------------------
// SPARSE 256x256 TILE STORAGE + WET-ON-WET FILM CACHE
// ----------------------------------------------------
function ensureChunkBackup(engine, chunk, cx, cy) {
  const id = `${cx},${cy}`;
  backupChunkLayer(engine, chunk, id, { layer: engine.activeLayer, dirtyIsEmpty: false });
}

function getWetCacheKey(engine, tx, ty) {
  const proj = engine.currentProjectId || 'default';
  return `${proj}|${engine.activeLayer}|${tx},${ty}`;
}

function touchWetCacheEntry(key, entry) {
  _paperWetTiles.delete(key);
  _paperWetTiles.set(key, entry);
  while (_paperWetTiles.size > MAX_WET_CACHE_TILES) {
    const oldestKey = _paperWetTiles.keys().next().value;
    if (oldestKey === undefined) break;
    _paperWetTiles.delete(oldestKey);
  }
}

function ensureAirTile(engine, ab, tx, ty) {
  const key = `${tx},${ty}`;
  let tile = ab.tiles.get(key);
  if (tile) return tile;

  if (!_tileReadCanvas) {
    _tileReadCanvas = document.createElement('canvas');
    _tileReadCanvas.width = TILE_SIZE;
    _tileReadCanvas.height = TILE_SIZE;
    _tileReadCtx = _tileReadCanvas.getContext('2d', { willReadFrequently: true });
  }

  const wx = tx * TILE_SIZE;
  const wy = ty * TILE_SIZE;
  _tileReadCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  let hasAnyPixels = false;

  const layer = engine.activeLayer;
  if (engine.isStatic) {
    const chunk = engine._getChunk(0, 0);
    if (chunk) {
      ensureChunkBackup(engine, chunk, 0, 0);
      if (!chunk.isEmpty || !chunk.isEmpty[layer]) {
        const lx = -engine.staticWidth / 2;
        const ly = -engine.staticHeight / 2;
        const ox = Math.max(wx, lx);
        const oy = Math.max(wy, ly);
        const ox2 = Math.min(wx + TILE_SIZE, lx + chunk.width);
        const oy2 = Math.min(wy + TILE_SIZE, ly + chunk.height);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow > 0 && oh > 0) {
          _tileReadCtx.drawImage(chunk.canvases[layer], ox - lx, oy - ly, ow, oh, ox - wx, oy - wy, ow, oh);
          hasAnyPixels = true;
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
          hasAnyPixels = true;
        }
      }
    }
  }

  const len = TILE_SIZE * TILE_SIZE;
  const pixels = hasAnyPixels
    ? new Uint8ClampedArray(_tileReadCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data)
    : new Uint8ClampedArray(len * 4);
  const water = new Float32Array(len);
  const vx = new Float32Array(len);
  const vy = new Float32Array(len);
  const lastDist = new Float32Array(len);
  lastDist.fill(-1e9);
  const lastCover = new Float32Array(len);

  // Restore lingering wet paper film where live canvas pigment still exists (safe across Undo!)
  const wetKey = getWetCacheKey(engine, tx, ty);
  const cachedWet = _paperWetTiles.get(wetKey);
  if (cachedWet && hasAnyPixels) {
    const now = performance.now();
    const dtSec = Math.max(0, (now - cachedWet.updatedAt) * 0.001);
    const wetnessNorm = (airSettings.wetness || 0) / 100.0;
    const dryHorizon = 4.0 + wetnessNorm * 22.0;
    const decay = Math.exp(-dtSec / dryHorizon);
    if (decay > 0.03) {
      const cw = cachedWet.water;
      const cvx = cachedWet.vx;
      const cvy = cachedWet.vy;
      for (let i = 0; i < len; i++) {
        if (pixels[i * 4 + 3] > 2 && cw[i] > 0.01) {
          water[i] = cw[i] * decay;
          vx[i] = cvx[i] * decay * 0.6;
          vy[i] = cvy[i] * decay * 0.6;
        }
      }
    }
  }

  tile = { tx, ty, wx, wy, pixels, water, vx, vy, lastDist, lastCover };
  ab.tiles.set(key, tile);
  return tile;
}

function readPatchFromTiles(engine, ab, boxX, boxY, boxW, boxH) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  const totalPx = boxW * boxH;
  _patchPixels.fill(0, 0, totalPx * 4);
  _patchWater.fill(0, 0, totalPx);
  _patchVx.fill(0, 0, totalPx);
  _patchVy.fill(0, 0, totalPx);
  _patchDist.fill(-1e9, 0, totalPx);
  _patchCover.fill(0, 0, totalPx);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = ensureAirTile(engine, ab, tx, ty);
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
        _patchPixels.set(tile.pixels.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        _patchWater.set(tile.water.subarray(sOff, sOff + ow), dOff);
        _patchVx.set(tile.vx.subarray(sOff, sOff + ow), dOff);
        _patchVy.set(tile.vy.subarray(sOff, sOff + ow), dOff);
        _patchDist.set(tile.lastDist.subarray(sOff, sOff + ow), dOff);
        _patchCover.set(tile.lastCover.subarray(sOff, sOff + ow), dOff);
      }
    }
  }
}

function writePatchToTilesAndChunks(engine, ab, boxX, boxY, boxW, boxH) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = ab.tiles.get(`${tx},${ty}`);
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
        tile.pixels.set(_outBufRGBA.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        tile.water.set(_outBufWater.subarray(sOff, sOff + ow), dOff);
        tile.vx.set(_outBufVx.subarray(sOff, sOff + ow), dOff);
        tile.vy.set(_outBufVy.subarray(sOff, sOff + ow), dOff);
        tile.lastDist.set(_outBufDist.subarray(sOff, sOff + ow), dOff);
        tile.lastCover.set(_outBufCover.subarray(sOff, sOff + ow), dOff);
      }
    }
  }

  const apron = 2;
  const innerW = boxW - apron * 2;
  const innerH = boxH - apron * 2;
  if (innerW <= 0 || innerH <= 0) return;

  const dstPixels = _outImageData.data;
  for (let y = apron; y < boxH - apron; y++) {
    const sOff = (y * boxW + apron) * 4;
    const dOff = (y * _scratchW + apron) * 4;
    dstPixels.set(_outBufRGBA.subarray(sOff, sOff + innerW * 4), dOff);
  }
  _outCtx.putImageData(_outImageData, 0, 0, apron, apron, innerW, innerH);

  const commitX = boxX + apron;
  const commitY = boxY + apron;
  const layer = engine.activeLayer;
  const layerSet = engine.layerSettings ? engine.layerSettings[layer] : null;
  const alphaLock = !!(layerSet && layerSet.alphaLock);

  const sCX = engine.isStatic ? 0 : Math.floor(commitX / engine.chunkSize);
  const eCX = engine.isStatic ? 0 : Math.floor((commitX + innerW - 1) / engine.chunkSize);
  const sCY = engine.isStatic ? 0 : Math.floor(commitY / engine.chunkSize);
  const eCY = engine.isStatic ? 0 : Math.floor((commitY + innerH - 1) / engine.chunkSize);

  for (let cx = sCX; cx <= eCX; cx++) {
    for (let cy = sCY; cy <= eCY; cy++) {
      const chunk = engine._getChunk(cx, cy);
      if (!chunk) continue;

      const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
      const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;

      const ox = Math.max(commitX, lx);
      const oy = Math.max(commitY, ly);
      const ox2 = Math.min(commitX + innerW, lx + chunk.width);
      const oy2 = Math.min(commitY + innerH, ly + chunk.height);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const srcX = ox - boxX;
      const srcY = oy - boxY;
      const dstX = ox - lx;
      const dstY = oy - ly;

      const ctx = chunk.ctxs[layer];
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, chunk.width, chunk.height);
      ctx.clip();

      if (alphaLock) {
        ctx.globalCompositeOperation = 'source-atop';
      } else {
        ctx.clearRect(dstX, dstY, ow, oh);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(_outCanvas, srcX, srcY, ow, oh, dstX, dstY, ow, oh);
      ctx.restore();

      if (chunk.isEmpty) chunk.isEmpty[layer] = false;
      const id = `${cx},${cy}`;
      engine._markDirty(id, layer, false);
      if (engine.gpuRenderer) {
        engine.gpuRenderer.markChunkLayerDirty(chunk, layer);
      }
    }
  }
}

// ----------------------------------------------------
// ABSTRACT NAVIER-STOKES STREAMERS (NON-POPPING RING POOL)
// ----------------------------------------------------
function spawnNsStreamer(ab, x, y, dirX, dirY, radius, baseColor, opacity) {
  if (ab.streamers.length >= MAX_STREAMERS) return;

  const angle = Math.random() * Math.PI * 2;
  const r = radius * (0.12 + Math.random() * 0.62);
  const sx = x + Math.cos(angle) * r;
  const sy = y + Math.sin(angle) * r;

  // Delicate luminous watercolor tonal variation (never garish neon hue jumps)
  const hsl = rgbToHsl(baseColor.r, baseColor.g, baseColor.b);
  const sRgb = hslToRgb(
    (hsl.h + (Math.random() - 0.5) * 10 + 360) % 360,
    Math.max(4, Math.min(100, hsl.s + (Math.random() - 0.5) * 12)),
    Math.max(8, Math.min(92, hsl.l + (Math.random() - 0.5) * 14))
  );

  ab.streamers.push({
    x: sx,
    y: sy,
    vx: dirX * (0.8 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9,
    vy: dirY * (0.8 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9,
    life: 1.0,
    decay: 0.022 + Math.random() * 0.018,
    r: sRgb.r,
    g: sRgb.g,
    b: sRgb.b,
    alpha: Math.min(0.42, (0.14 + Math.random() * 0.16) * opacity),
    widthCell: Math.max(0.85, Math.min(2.8, radius * 0.048 * (0.7 + Math.random() * 0.6))),
    seed: Math.random() * 50.0,
    spin: (Math.random() > 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.6)
  });
}

/**
 * Stamps a soft, watery Navier-Stokes ribbon segment straight into the wet simulation grid
 * BEFORE capillary diffusion & edge settling so tendrils melt seamlessly into the paper wash.
 */
function depositStreamerToNsGrid(
  cols, rows, gridOriginX, gridOriginY, simStep,
  x0, y0, x1, y1, r, g, b, alpha, cellRadius
) {
  if (alpha <= 0.002) return;
  const invStep = 1.0 / simStep;
  const gx0 = (x0 - gridOriginX) * invStep;
  const gy0 = (y0 - gridOriginY) * invStep;
  const gx1 = (x1 - gridOriginX) * invStep;
  const gy1 = (y1 - gridOriginY) * invStep;

  const pad = Math.ceil(cellRadius + 1.5);
  const minGx = Math.max(1, Math.floor(Math.min(gx0, gx1)) - pad);
  const maxGx = Math.min(cols - 2, Math.ceil(Math.max(gx0, gx1)) + pad);
  const minGy = Math.max(1, Math.floor(Math.min(gy0, gy1)) - pad);
  const maxGy = Math.min(rows - 2, Math.ceil(Math.max(gy0, gy1)) + pad);
  if (minGx > maxGx || minGy > maxGy) return;

  const segDx = gx1 - gx0;
  const segDy = gy1 - gy0;
  const segLen2 = segDx * segDx + segDy * segDy;
  const rad2 = cellRadius * cellRadius;

  for (let gy = minGy; gy <= maxGy; gy++) {
    const row = gy * cols;
    for (let gx = minGx; gx <= maxGx; gx++) {
      let t = segLen2 > 0.0001 ? ((gx - gx0) * segDx + (gy - gy0) * segDy) / segLen2 : 0.0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const dx = gx - (gx0 + segDx * t);
      const dy = gy - (gy0 + segDy * t);
      const d2 = dx * dx + dy * dy;
      if (d2 >= rad2) continue;

      const falloff = 1.0 - d2 / rad2;
      const w = falloff * falloff * alpha;
      if (w <= 0.002) continue;

      const idx = row + gx;
      const curA = _nsA[idx];

      // Subtle watery multiply-glaze blend inside existing pigment
      let tr = r;
      let tg = g;
      let tb = b;
      if (curA > 0.04) {
        const invC = 1.0 / curA;
        const cr = _nsPR[idx] * invC;
        const cg = _nsPG[idx] * invC;
        const cb = _nsPB[idx] * invC;
        const multR = (cr * r) / 255.0;
        const multG = (cg * g) / 255.0;
        const multB = (cb * b) / 255.0;
        tr = r * 0.55 + multR * 0.45;
        tg = g * 0.55 + multG * 0.45;
        tb = b * 0.55 + multB * 0.45;
      }

      const outA = curA + w * (1.0 - curA);
      const oneMinusW = 1.0 - w;
      _nsPR[idx] = _nsPR[idx] * oneMinusW + tr * w;
      _nsPG[idx] = _nsPG[idx] * oneMinusW + tg * w;
      _nsPB[idx] = _nsPB[idx] * oneMinusW + tb * w;
      _nsA[idx] = outA > 1.0 ? 1.0 : outA;

      const addW = Math.min(1.0, _nsW[idx] + falloff * 0.35);
      if (addW > _nsW[idx]) _nsW[idx] = addW;
    }
  }
}

// ----------------------------------------------------
// BRUSH TIP PREPARATION & SETTINGS SYNC
// ----------------------------------------------------
function syncAirSettingsFromEngine(engine) {
  const b = engine && engine.brush;
  if (!b) return;
  if (b.airWetness !== undefined) airSettings.wetness = b.airWetness;
  if (b.airStreamFlow !== undefined) airSettings.streamFlow = b.airStreamFlow;
  if (b.airBloom !== undefined) airSettings.bloom = b.airBloom;
  if (b.airEdge !== undefined) airSettings.edge = b.airEdge;
  if (b.airGranulation !== undefined) airSettings.granulation = b.airGranulation;
  if (b.airTipPour !== undefined) airSettings.tipPour = b.airTipPour;
  if (b.airFollowStroke !== undefined) airSettings.followStroke = !!b.airFollowStroke;
  if (b.airTipAngle !== undefined) airSettings.tipAngle = b.airTipAngle;
  if (b.airTipHardness !== undefined) airSettings.tipHardness = b.airTipHardness;
  if (b.airPressureFlow !== undefined) airSettings.pressureFlow = b.airPressureFlow;
}

function prepareAirTipMaps(engine) {
  const tip = engine?.brush?.tip || null;
  const hardNorm = Math.max(0.0, Math.min(1.0, (airSettings.tipHardness ?? 55) / 100.0));
  const tipVer = tip ? (tip._tipVersion || 0) : 0;
  const key = tip ? `${tipVer}_${hardNorm.toFixed(3)}` : 'none';
  if (_preparedAirTipRef === tip && _preparedAirTipKey === key) {
    return _hasAirTip;
  }

  _preparedAirTipRef = tip;
  _preparedAirTipKey = key;
  _preparedAirTipVersionCounter++;
  _hasAirTip = false;
  if (!tip || tip.width <= 0 || tip.height <= 0) return false;

  if (!_tipWorkCanvas) {
    _tipWorkCanvas = document.createElement('canvas');
    _tipWorkCanvas.width = TIP_RES;
    _tipWorkCanvas.height = TIP_RES;
    _tipWorkCtx = _tipWorkCanvas.getContext('2d', { willReadFrequently: true });
  }
  _tipWorkCtx.clearRect(0, 0, TIP_RES, TIP_RES);
  _tipWorkCtx.drawImage(tip, 0, 0, TIP_RES, TIP_RES);
  const data = _tipWorkCtx.getImageData(0, 0, TIP_RES, TIP_RES).data;
  let anyOpaque = false;
  for (let i = 0; i < TIP_RES * TIP_RES; i++) {
    let a = data[i * 4 + 3] / 255.0;
    if (hardNorm < 0.48) {
      const exp = 1.0 + (0.5 - hardNorm) * 2.2;
      a = Math.pow(a, exp);
    } else if (hardNorm > 0.52 && a > 0.0) {
      const boost = 1.0 + (hardNorm - 0.5) * 4.0;
      a = Math.min(1.0, Math.max(0.0, (a - 0.15 * (hardNorm - 0.5)) * boost));
    }
    _airTipRaw[i] = a;
    if (a > 0.05) anyOpaque = true;
  }
  if (!anyOpaque) return false;

  // Separable 9x9 box blur -> tipBump mass map
  const rBlur = 4;
  const invSpan = 1.0 / (rBlur * 2 + 1);
  for (let y = 0; y < TIP_RES; y++) {
    const row = y * TIP_RES;
    for (let x = 0; x < TIP_RES; x++) {
      let sum = 0.0;
      for (let k = -rBlur; k <= rBlur; k++) {
        const sx = x + k < 0 ? 0 : (x + k >= TIP_RES ? TIP_RES - 1 : x + k);
        sum += _airTipRaw[row + sx];
      }
      _airTipBlurTmp[row + x] = sum * invSpan;
    }
  }
  for (let y = 0; y < TIP_RES; y++) {
    for (let x = 0; x < TIP_RES; x++) {
      let sum = 0.0;
      for (let k = -rBlur; k <= rBlur; k++) {
        const sy = y + k < 0 ? 0 : (y + k >= TIP_RES ? TIP_RES - 1 : y + k);
        sum += _airTipBlurTmp[sy * TIP_RES + x];
      }
      const val = sum * invSpan * 1.15;
      _airTipBump[y * TIP_RES + x] = val > 1.0 ? 1.0 : val;
    }
  }

  // Spatial gradient of bump mass -> normalized vector pointing into thicker paint; negate on pour!
  for (let y = 0; y < TIP_RES; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < TIP_RES - 1 ? y + 1 : TIP_RES - 1;
    for (let x = 0; x < TIP_RES; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < TIP_RES - 1 ? x + 1 : TIP_RES - 1;
      const gx = (_airTipBump[y * TIP_RES + x1] - _airTipBump[y * TIP_RES + x0]) * 2.5;
      const gy = (_airTipBump[y1 * TIP_RES + x] - _airTipBump[y0 * TIP_RES + x]) * 2.5;
      const clampedX = Math.max(-1.0, Math.min(1.0, gx));
      const clampedY = Math.max(-1.0, Math.min(1.0, gy));
      const idx = y * TIP_RES + x;
      _airTipGradX[idx] = clampedX;
      _airTipGradY[idx] = clampedY;
      const bIdx = idx * 4;
      _airTipRgbaBytes[bIdx] = clampByte(_airTipRaw[idx] * 255.0);
      _airTipRgbaBytes[bIdx + 1] = clampByte(_airTipBump[idx] * 255.0);
      _airTipRgbaBytes[bIdx + 2] = clampByte((clampedX * 0.5 + 0.5) * 255.0);
      _airTipRgbaBytes[bIdx + 3] = clampByte((clampedY * 0.5 + 0.5) * 255.0);
    }
  }

  _hasAirTip = true;
  return true;
}

function sampleCpuAirTip(u, v) {
  const tx = (u + 1.0) * 0.5 * (TIP_RES - 1);
  const ty = (v + 1.0) * 0.5 * (TIP_RES - 1);
  if (tx < 0 || tx >= TIP_RES - 1 || ty < 0 || ty >= TIP_RES - 1) return { a: 0, bump: 0, gx: 0, gy: 0 };
  const ix = tx | 0;
  const iy = ty | 0;
  const fx = tx - ix;
  const fy = ty - iy;
  const i00 = iy * TIP_RES + ix;
  const i10 = i00 + 1;
  const i01 = i00 + TIP_RES;
  const i11 = i01 + 1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  return {
    a: _airTipRaw[i00] * w00 + _airTipRaw[i10] * w10 + _airTipRaw[i01] * w01 + _airTipRaw[i11] * w11,
    bump: _airTipBump[i00] * w00 + _airTipBump[i10] * w10 + _airTipBump[i01] * w01 + _airTipBump[i11] * w11,
    gx: _airTipGradX[i00] * w00 + _airTipGradX[i10] * w10 + _airTipGradX[i01] * w01 + _airTipGradX[i11] * w11,
    gy: _airTipGradY[i00] * w00 + _airTipGradY[i10] * w10 + _airTipGradY[i01] * w01 + _airTipGradY[i11] * w11
  };
}

function computeAirTipAngle(engine, dirX, dirY, pointAngle = null) {
  const angleOffRad = ((airSettings.tipAngle || 0) * Math.PI) / 180.0;
  const baseRot = pointAngle !== null && pointAngle !== undefined ? pointAngle : (engine?.rotation || 0);
  const followRad = airSettings.followStroke ? Math.atan2(dirY, dirX) : 0.0;
  const angle = followRad + angleOffRad + baseRot;
  return {
    cosR: Math.cos(-angle),
    sinR: Math.sin(-angle)
  };
}

// ----------------------------------------------------
// CORE NAVIER-STOKES WATERCOLOR SIMULATION STEP
// ----------------------------------------------------
function runAirStep(engine, ab, from, to, radius, opacity, baseColor, pressure, isSettleStep = false, pointAngle = null, isDab = false) {
  syncAirSettingsFromEngine(engine);

  const wetnessRatio = Math.max(0.0, Math.min(1.0, airSettings.wetness / 100.0));
  const streamRatio = Math.max(0.0, Math.min(1.0, airSettings.streamFlow / 100.0));
  const bloomRatio = Math.max(0.0, Math.min(1.0, airSettings.bloom / 100.0));
  const edgeRatio = Math.max(0.0, Math.min(1.0, airSettings.edge / 100.0));
  const granRatio = Math.max(0.0, Math.min(1.0, airSettings.granulation / 100.0));

  const effPressure = engine?.brush?.pressureEnabled ? pressure : 1.0;
  const pFlowInf = (airSettings.pressureFlow ?? 35) / 100.0;
  const pressFlowScale = 1.0 - pFlowInf + pFlowInf * effPressure;
  const brushFlow = engine?.brush?.flow !== undefined ? engine.brush.flow : 0.70;
  const flowFactor = Math.max(0.03, Math.min(1.0, brushFlow * pressFlowScale));
  const tipPourRatio = Math.max(0.0, Math.min(1.0, (airSettings.tipPour ?? 100) / 100.0));
  const strokeOpacity = Math.max(0.02, Math.min(1.0, (opacity || 0.55) * effPressure));

  const rawDx = to.x - from.x;
  const rawDy = to.y - from.y;
  const dist = Math.hypot(rawDx, rawDy);
  const safeDist = dist > 0.0001 ? dist : 0.001;
  const dirX = dist > 0.0001 ? rawDx / dist : (ab.prevDir ? ab.prevDir.x : 1.0);
  const dirY = dist > 0.0001 ? rawDy / dist : (ab.prevDir ? ab.prevDir.y : 0.0);
  if (!ab.prevDir) ab.prevDir = { x: dirX, y: dirY };

  const prevDistTotal = ab.totalDist;
  if (!isSettleStep) {
    ab.totalDist += dist;
  }
  ab.time += 0.065 * (dist / 14.0 + 1.0);
  const curTime = ab.time;

  // Adaptive cell size keeps giant watercolor brushes silky fast at 60fps
  const simStep = radius <= 36 ? 2 : (radius <= 92 ? 3 : 4);
  const bleedR = radius * (1.18 + bloomRatio * 0.34 + streamRatio * 0.22);
  const patchPad = Math.ceil(Math.max(18, bleedR * 0.25)) + 10 + simStep * 2;

  let minX = Math.min(from.x, to.x) - bleedR;
  let maxX = Math.max(from.x, to.x) + bleedR;
  let minY = Math.min(from.y, to.y) - bleedR;
  let maxY = Math.max(from.y, to.y) + bleedR;

  // Include active Navier-Stokes streamers gently in bbox
  for (let i = 0; i < ab.streamers.length; i++) {
    const s = ab.streamers[i];
    const rMargin = s.widthCell * simStep + 10;
    if (s.x - rMargin < minX) minX = s.x - rMargin;
    if (s.x + rMargin > maxX) maxX = s.x + rMargin;
    if (s.y - rMargin < minY) minY = s.y - rMargin;
    if (s.y + rMargin > maxY) maxY = s.y + rMargin;
  }

  // Clamp patch expansion cleanly if a streamer wandered abnormally far
  const maxHalfSpan = Math.max(260, bleedR * 2.4 + Math.hypot(rawDx, rawDy));
  const midX = (from.x + to.x) * 0.5;
  const midY = (from.y + to.y) * 0.5;
  minX = Math.max(minX, midX - maxHalfSpan);
  maxX = Math.min(maxX, midX + maxHalfSpan);
  minY = Math.max(minY, midY - maxHalfSpan);
  maxY = Math.min(maxY, midY + maxHalfSpan);

  // Align Navier-Stokes grid onto world integer multiples of simStep so grid never shimmers!
  const apron = 2;
  const rawX0 = Math.floor((minX - patchPad) / simStep) * simStep;
  const rawY0 = Math.floor((minY - patchPad) / simStep) * simStep;
  const rawX1 = Math.ceil((maxX + patchPad) / simStep) * simStep;
  const rawY1 = Math.ceil((maxY + patchPad) / simStep) * simStep;

  const boxX = rawX0 - apron;
  const boxY = rawY0 - apron;
  const boxW = Math.max(16, (rawX1 - rawX0) + apron * 2);
  const boxH = Math.max(16, (rawY1 - rawY0) + apron * 2);

  ensurePatchScratch(boxW, boxH);
  readPatchFromTiles(engine, ab, boxX, boxY, boxW, boxH);

  // Seed _outBuf with unmodified patch state outside simulated interior
  const totalPx = boxW * boxH;
  _outBufRGBA.set(_patchPixels.subarray(0, totalPx * 4));
  _outBufWater.set(_patchWater.subarray(0, totalPx));
  _outBufVx.set(_patchVx.subarray(0, totalPx));
  _outBufVy.set(_patchVy.subarray(0, totalPx));
  _outBufDist.set(_patchDist.subarray(0, totalPx));
  _outBufCover.set(_patchCover.subarray(0, totalPx));

  const cols = Math.max(5, Math.floor((rawX1 - rawX0) / simStep) + 1);
  const rows = Math.max(5, Math.floor((rawY1 - rawY0) / simStep) + 1);
  const numCells = cols * rows;
  ensureNsGrid(numCells);

  // -----------------------------------------------------------------
  // 1. SAMPLE PATCH INTO NAVIER-STOKES GRID (PREMULTIPLIED RGBA)
  // -----------------------------------------------------------------
  const curlFreq = 1.0 / Math.max(14.0, radius * 0.78);
  const fXGrid = (from.x - rawX0) / simStep;
  const fYGrid = (from.y - rawY0) / simStep;
  const segGridDist = safeDist / simStep;
  const radGrid = radius / simStep;
  const reachGrid = bleedR / simStep;
  const reachGrid2 = reachGrid * reachGrid;
  const jetScale = (0.35 + 1.35 * streamRatio) * (0.35 + 0.65 * wetnessRatio);
  const pushSpeed = Math.min(2.2, (dist / simStep) * 0.32) * jetScale;
  const curlSwirl = (0.28 + 0.95 * streamRatio) * (0.4 + 0.6 * wetnessRatio);
  const inputWaterLevel = 0.22 + 0.78 * wetnessRatio;

  const dirAngle = computeAirTipAngle(engine, dirX, dirY, pointAngle);
  const rotCos = dirAngle.cosR;
  const rotSin = dirAngle.sinR;
  const invRadWorld = 1.0 / Math.max(1.0, radius);

  for (let gy = 0; gy < rows; gy++) {
    const py = apron + gy * simStep;
    const pRow = py * boxW + apron;
    const gRow = gy * cols;
    const worldY = rawY0 + gy * simStep;
    const apy = gy - fYGrid;

    for (let gx = 0; gx < cols; gx++) {
      const pIdx = pRow + gx * simStep;
      const gIdx = gRow + gx;
      const p4 = pIdx * 4;

      const a01 = _patchPixels[p4 + 3] / 255.0;
      _nsPR[gIdx] = _patchPixels[p4] * a01;
      _nsPG[gIdx] = _patchPixels[p4 + 1] * a01;
      _nsPB[gIdx] = _patchPixels[p4 + 2] * a01;
      _nsA[gIdx] = a01;

      let u = _patchVx[pIdx];
      let v = _patchVy[pIdx];
      let w = _patchWater[pIdx];
      _nsDist[gIdx] = _patchDist[pIdx];
      _nsCov[gIdx] = _patchCover[pIdx];
      _nsNewCov[gIdx] = _patchCover[pIdx];

      if (!isSettleStep && gx > 0 && gx < cols - 1 && gy > 0 && gy < rows - 1) {
        const apx = gx - fXGrid;
        let tSeg = (apx * dirX + apy * dirY) / segGridDist;
        if (tSeg < 0) tSeg = 0;
        else if (tSeg > 1) tSeg = 1;

        const rx = gx - (fXGrid + dirX * segGridDist * tSeg);
        const ry = gy - (fYGrid + dirY * segGridDist * tSeg);
        const d2 = rx * rx + ry * ry;

        if (d2 < reachGrid2) {
          const dNorm = Math.sqrt(d2) / Math.max(0.5, radGrid);
          const worldX = rawX0 + gx * simStep;
          const curl = sampleCurl(worldX, worldY, curTime, curlFreq);
          const prox = dNorm < 1.3 ? Math.max(0.0, 1.0 - dNorm / 1.3) : 0.0;
          const lobe = Math.max(0.0, 1.0 - d2 / reachGrid2);

          if (_hasAirTip) {
            const cxRot = (worldX - (isDab ? to.x : (from.x + rawDx * tSeg)));
            const cyRot = (worldY - (isDab ? to.y : (from.y + rawDy * tSeg)));
            const txU = (cxRot * rotCos - cyRot * rotSin) * invRadWorld;
            const tyV = (cxRot * rotSin + cyRot * rotCos) * invRadWorld;
            const tipSample = sampleCpuAirTip(txU, tyV);
            const tipMask = Math.max(tipSample.a, tipSample.bump * tipPourRatio);
            if (tipMask > 0.01) {
              const pourOutX = -(tipSample.gx * rotCos + tipSample.gy * rotSin) * tipPourRatio * (0.4 + 0.6 * tipSample.bump) * 1.25;
              const pourOutY = -(-tipSample.gx * rotSin + tipSample.gy * rotCos) * tipPourRatio * (0.4 + 0.6 * tipSample.bump) * 1.25;
              u += (dirX * pushSpeed * prox * tipMask + curl.vx * curlSwirl * lobe * 0.45 * tipMask + pourOutX);
              v += (dirY * pushSpeed * prox * tipMask + curl.vy * curlSwirl * lobe * 0.45 * tipMask + pourOutY);
              const waterScale = 0.24 + 0.76 * tipPourRatio;
              const injW = Math.min(1.0, Math.max(tipSample.a, tipSample.bump * tipPourRatio) * inputWaterLevel * (0.45 + 0.55 * flowFactor) * waterScale);
              if (injW > w) w = injW;
            }
          } else {
            if (prox > 0.01) {
              u += (dirX * pushSpeed * prox + curl.vx * curlSwirl * lobe * 0.45);
              v += (dirY * pushSpeed * prox + curl.vy * curlSwirl * lobe * 0.45);
            }
            const puddleProfile = dNorm < 1.05 ? Math.max(0.0, 1.0 - (dNorm / 1.05) * (dNorm / 1.05)) : 0.0;
            const injW = Math.min(1.0, Math.sqrt(puddleProfile) * inputWaterLevel * (0.45 + 0.55 * flowFactor));
            if (injW > w) w = injW;
          }
        }
      }

      _nsU[gIdx] = u;
      _nsV[gIdx] = v;
      _nsW[gIdx] = w;
    }
  }

  // Enforce clean zero velocity on patch boundary perimeter
  for (let gx = 0; gx < cols; gx++) {
    _nsU[gx] = 0; _nsV[gx] = 0;
    const bIdx = (rows - 1) * cols + gx;
    _nsU[bIdx] = 0; _nsV[bIdx] = 0;
  }
  for (let gy = 0; gy < rows; gy++) {
    const lIdx = gy * cols;
    const rIdx = lIdx + cols - 1;
    _nsU[lIdx] = 0; _nsV[lIdx] = 0;
    _nsU[rIdx] = 0; _nsV[rIdx] = 0;
  }

  // -----------------------------------------------------------------
  // 2. INCOMPRESSIBLE NAVIER-STOKES: VORTICITY + PRESSURE PROJECTION
  // -----------------------------------------------------------------
  if (streamRatio > 0.02 || wetnessRatio > 0.15) {
    // 2a. Compute vorticity omega = dv/dx - du/dy
    _nsOmega.fill(0, 0, numCells);
    for (let gy = 1; gy < rows - 1; gy++) {
      const row = gy * cols;
      for (let gx = 1; gx < cols - 1; gx++) {
        const i = row + gx;
        _nsOmega[i] = 0.5 * ((_nsV[i + 1] - _nsV[i - 1]) - (_nsU[i + cols] - _nsU[i - cols]));
      }
    }

    // 2b. Vorticity confinement sustains smooth swirling abstract fluid streams
    const vortConf = 0.08 + 0.48 * streamRatio;
    for (let gy = 1; gy < rows - 1; gy++) {
      const row = gy * cols;
      for (let gx = 1; gx < cols - 1; gx++) {
        const i = row + gx;
        const dwDx = 0.5 * (Math.abs(_nsOmega[i + 1]) - Math.abs(_nsOmega[i - 1]));
        const dwDy = 0.5 * (Math.abs(_nsOmega[i + cols]) - Math.abs(_nsOmega[i - cols]));
        const len = Math.hypot(dwDx, dwDy) + 1e-5;
        const nx = dwDx / len;
        const ny = dwDy / len;
        const wCurl = _nsOmega[i];
        _nsU[i] += ny * wCurl * vortConf;
        _nsV[i] -= nx * wCurl * vortConf;
      }
    }

    // 2c. Divergence & 5 Gauss-Seidel pressure Poisson projection (div u = 0)
    _nsP.fill(0, 0, numCells);
    for (let gy = 1; gy < rows - 1; gy++) {
      const row = gy * cols;
      for (let gx = 1; gx < cols - 1; gx++) {
        const i = row + gx;
        _nsDiv[i] = -0.5 * ((_nsU[i + 1] - _nsU[i - 1]) + (_nsV[i + cols] - _nsV[i - cols]));
      }
    }
    for (let iter = 0; iter < 5; iter++) {
      for (let gy = 1; gy < rows - 1; gy++) {
        const row = gy * cols;
        for (let gx = 1; gx < cols - 1; gx++) {
          const i = row + gx;
          _nsP[i] = (_nsDiv[i] + _nsP[i - 1] + _nsP[i + 1] + _nsP[i - cols] + _nsP[i + cols]) * 0.25;
        }
      }
    }

    const maxVel = 2.2;
    for (let gy = 1; gy < rows - 1; gy++) {
      const row = gy * cols;
      for (let gx = 1; gx < cols - 1; gx++) {
        const i = row + gx;
        let u = _nsU[i] - 0.5 * (_nsP[i + 1] - _nsP[i - 1]);
        let v = _nsV[i] - 0.5 * (_nsP[i + cols] - _nsP[i - cols]);
        const spd = Math.hypot(u, v);
        if (spd > maxVel) {
          const inv = maxVel / spd;
          u *= inv;
          v *= inv;
        }
        _nsU[i] = u;
        _nsV[i] = v;
      }
    }
  }

  // -----------------------------------------------------------------
  // 3. ADVANCE NON-POPPING STREAMERS INSIDE LIVE N-S FIELD
  // -----------------------------------------------------------------
  if (!isSettleStep && streamRatio > 0.05 && wetnessRatio > 0.08 && dist > 0.6) {
    const spawnWant = streamRatio > 0.45 ? Math.min(2, Math.round(streamRatio * 2.1)) : (Math.random() < streamRatio * 1.8 ? 1 : 0);
    for (let k = 0; k < spawnWant; k++) {
      spawnNsStreamer(ab, to.x, to.y, dirX, dirY, radius, baseColor, strokeOpacity);
    }
  }

  const maxGxC = cols - 1.001;
  const maxGyC = rows - 1.001;
  const invStep = 1.0 / simStep;
  for (let i = ab.streamers.length - 1; i >= 0; i--) {
    const s = ab.streamers[i];
    if (s.life <= 0.01) {
      ab.streamers.splice(i, 1);
      continue;
    }

    const oldX = s.x;
    const oldY = s.y;

    // Sample incompressible Navier-Stokes velocity bilinearly if inside patch
    const gsx = (s.x - rawX0) * invStep;
    const gsy = (s.y - rawY0) * invStep;
    let nsVx = 0;
    let nsVy = 0;
    if (gsx >= 0 && gsx < maxGxC && gsy >= 0 && gsy < maxGyC) {
      const ix = gsx | 0;
      const iy = gsy | 0;
      const fx = gsx - ix;
      const fy = gsy - iy;
      const c00 = iy * cols + ix;
      const c10 = c00 + 1;
      const c01 = c00 + cols;
      const c11 = c01 + 1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      nsVx = (_nsU[c00] * w00 + _nsU[c10] * w10 + _nsU[c01] * w01 + _nsU[c11] * w11) * simStep;
      nsVy = (_nsV[c00] * w00 + _nsV[c10] * w10 + _nsV[c01] * w01 + _nsV[c11] * w11) * simStep;
    }

    const curlS = sampleCurl(s.x + s.seed, s.y - s.seed, curTime * 1.1, curlFreq * 0.9);
    const curlBoost = (0.35 + streamRatio * 1.15) * s.spin;
    s.vx = s.vx * 0.84 + (nsVx * 0.72 + curlS.vx * curlBoost * 0.32) * 0.42;
    s.vy = s.vy * 0.84 + (nsVy * 0.72 + curlS.vy * curlBoost * 0.32) * 0.42;

    const sp = Math.hypot(s.vx, s.vy);
    const maxS = Math.max(2.2, radius * 0.14);
    if (sp > maxS) {
      const inv = maxS / sp;
      s.vx *= inv;
      s.vy *= inv;
    }

    s.x += s.vx;
    s.y += s.vy;
    s.life -= isSettleStep ? Math.max(0.16, s.decay * 3.5) : s.decay;

    const env = Math.sin(Math.max(0, Math.min(1, s.life)) * Math.PI);
    const fade = Math.pow(env, 1.25);
    const segAlpha = s.alpha * fade * (0.25 + 0.75 * streamRatio) * (0.35 + 0.65 * wetnessRatio);
    if (segAlpha > 0.004) {
      depositStreamerToNsGrid(
        cols, rows, rawX0, rawY0, simStep,
        oldX, oldY, s.x, s.y,
        s.r, s.g, s.b, segAlpha,
        s.widthCell * (0.75 + 0.55 * fade)
      );
    }

    if (s.life <= 0.01) {
      ab.streamers.splice(i, 1);
    }
  }

  // -----------------------------------------------------------------
  // 4. SEMI-LAGRANGIAN WET ADVECTION & CAPILLARY BLOOM DIFFUSION
  // -----------------------------------------------------------------
  _nsU0.set(_nsU.subarray(0, numCells));
  _nsV0.set(_nsV.subarray(0, numCells));
  _nsW0.set(_nsW.subarray(0, numCells));
  _nsPR0.set(_nsPR.subarray(0, numCells));
  _nsPG0.set(_nsPG.subarray(0, numCells));
  _nsPB0.set(_nsPB.subarray(0, numCells));
  _nsA0.set(_nsA.subarray(0, numCells));

  const velDamp = Math.min(0.97, 0.72 + 0.22 * wetnessRatio);
  const advStep = (0.30 + 0.75 * streamRatio) * (0.25 + 0.75 * wetnessRatio);
  const diffBase = (0.04 + 0.28 * bloomRatio) * (0.25 + 0.75 * wetnessRatio);

  for (let gy = 1; gy < rows - 1; gy++) {
    const row = gy * cols;
    const worldY = rawY0 + gy * simStep;
    for (let gx = 1; gx < cols - 1; gx++) {
      const i = row + gx;
      const u = _nsU0[i];
      const v = _nsV0[i];
      const wHere = _nsW0[i];

      // Advect velocity smoothly
      let bxV = gx - u * 0.65;
      let byV = gy - v * 0.65;
      if (bxV < 0) bxV = 0; else if (bxV > maxGxC) bxV = maxGxC;
      if (byV < 0) byV = 0; else if (byV > maxGyC) byV = maxGyC;
      const vx0 = bxV | 0;
      const vy0 = byV | 0;
      const fvx = bxV - vx0;
      const fvy = byV - vy0;
      const vi00 = vy0 * cols + vx0;
      const vw00 = (1 - fvx) * (1 - fvy);
      const vw10 = fvx * (1 - fvy);
      const vw01 = (1 - fvx) * fvy;
      const vw11 = fvx * fvy;

      _nsU[i] = (_nsU0[vi00] * vw00 + _nsU0[vi00 + 1] * vw10 + _nsU0[vi00 + cols] * vw01 + _nsU0[vi00 + cols + 1] * vw11) * velDamp;
      _nsV[i] = (_nsV0[vi00] * vw00 + _nsV0[vi00 + 1] * vw10 + _nsV0[vi00 + cols] * vw01 + _nsV0[vi00 + cols + 1] * vw11) * velDamp;

      // Neighbor wetness (lets water wick capillary-style into dry paper around wet edge)
      const wL = _nsW0[i - 1];
      const wR = _nsW0[i + 1];
      const wT = _nsW0[i - cols];
      const wB = _nsW0[i + cols];
      const maxNbW = Math.max(wHere, wL, wR, wT, wB);
      if (maxNbW <= 0.008) continue;

      const wetMobility = Math.min(0.85, Math.max(0.0, (maxNbW - 0.008) * 2.4));

      // Semi-Lagrangian backtrace of premultiplied pigment + water
      let sx = gx - u * advStep * wetMobility;
      let sy = gy - v * advStep * wetMobility;
      if (sx < 0) sx = 0; else if (sx > maxGxC) sx = maxGxC;
      if (sy < 0) sy = 0; else if (sy > maxGyC) sy = maxGyC;
      const ix = sx | 0;
      const iy = sy | 0;
      const fx = sx - ix;
      const fy = sy - iy;
      const i00 = iy * cols + ix;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const advPR = _nsPR0[i00] * w00 + _nsPR0[i00 + 1] * w10 + _nsPR0[i00 + cols] * w01 + _nsPR0[i00 + cols + 1] * w11;
      const advPG = _nsPG0[i00] * w00 + _nsPG0[i00 + 1] * w10 + _nsPG0[i00 + cols] * w01 + _nsPG0[i00 + cols + 1] * w11;
      const advPB = _nsPB0[i00] * w00 + _nsPB0[i00 + 1] * w10 + _nsPB0[i00 + cols] * w01 + _nsPB0[i00 + cols + 1] * w11;
      const advA = _nsA0[i00] * w00 + _nsA0[i00 + 1] * w10 + _nsA0[i00 + cols] * w01 + _nsA0[i00 + cols + 1] * w11;
      const advW = _nsW0[i00] * w00 + _nsW0[i00 + 1] * w10 + _nsW0[i00 + cols] * w01 + _nsW0[i00 + cols + 1] * w11;

      const worldX = rawX0 + gx * simStep;
      const tooth = samplePaperTooth(worldX, worldY);
      const grainDiff = 1.0 - granRatio * 0.35 * (1.0 - tooth);
      const diffRate = Math.min(0.42, diffBase * wetMobility * grainDiff);

      // 4-neighbor capillary bleed
      const nbPR = (_nsPR0[i - 1] + _nsPR0[i + 1] + _nsPR0[i - cols] + _nsPR0[i + cols]) * 0.25;
      const nbPG = (_nsPG0[i - 1] + _nsPG0[i + 1] + _nsPG0[i - cols] + _nsPG0[i + cols]) * 0.25;
      const nbPB = (_nsPB0[i - 1] + _nsPB0[i + 1] + _nsPB0[i - cols] + _nsPB0[i + cols]) * 0.25;
      const nbA = (_nsA0[i - 1] + _nsA0[i + 1] + _nsA0[i - cols] + _nsA0[i + cols]) * 0.25;
      const nbW = (wL + wR + wT + wB) * 0.25;

      const advBlend = Math.min(0.45, streamRatio * 0.35 * wetMobility);
      let outPR = _nsPR0[i] * (1.0 - advBlend) + advPR * advBlend;
      let outPG = _nsPG0[i] * (1.0 - advBlend) + advPG * advBlend;
      let outPB = _nsPB0[i] * (1.0 - advBlend) + advPB * advBlend;
      let outA = _nsA0[i] * (1.0 - advBlend) + advA * advBlend;
      let outW = _nsW0[i] * (1.0 - advBlend) + advW * advBlend;

      if (diffRate > 0.002) {
        outPR = outPR * (1.0 - diffRate) + nbPR * diffRate;
        outPG = outPG * (1.0 - diffRate) + nbPG * diffRate;
        outPB = outPB * (1.0 - diffRate) + nbPB * diffRate;
        outA = outA * (1.0 - diffRate) + nbA * diffRate;
        outW = outW * (1.0 - diffRate * 0.85) + nbW * (diffRate * 0.85);
      }

      _nsPR[i] = outPR;
      _nsPG[i] = outPG;
      _nsPB[i] = outPB;
      _nsA[i] = outA > 1.0 ? 1.0 : (outA < 0 ? 0 : outA);
      _nsW[i] = outW > 1.0 ? 1.0 : (outW < 0 ? 0 : outW);
    }
  }

  // -----------------------------------------------------------------
  // 5. WATERCOLOR PIGMENT DEPOSITION (GLAZING, GRANULATION, EDGE RING)
  // -----------------------------------------------------------------
  if (!isSettleStep) {
    const coverWindow = Math.max(20.0, radius * 2.2);
    const opticalMultWeight = Math.min(1.0, 0.24 + 0.42 * wetnessRatio);
    const edgeStrength = edgeRatio * (0.25 + 0.75 * wetnessRatio);
    const localDist = prevDistTotal + safeDist;

    for (let gy = 1; gy < rows - 1; gy++) {
      const row = gy * cols;
      const worldY = rawY0 + gy * simStep;
      const apy = gy - fYGrid;

      for (let gx = 1; gx < cols - 1; gx++) {
        const i = row + gx;
        const apx = gx - fXGrid;
        let tSeg = (apx * dirX + apy * dirY) / segGridDist;
        if (tSeg < 0) tSeg = 0;
        else if (tSeg > 1) tSeg = 1;

        const rx = gx - (fXGrid + dirX * segGridDist * tSeg);
        const ry = gy - (fYGrid + dirY * segGridDist * tSeg);
        const d2 = rx * rx + ry * ry;
        if (d2 >= reachGrid2) continue;

        const worldX = rawX0 + gx * simStep;
        const tooth = samplePaperTooth(worldX, worldY);
        const edgeNoise = sampleCurl(worldX, worldY, curTime * 0.25, curlFreq * 0.8);

        let washDome = 0.0;
        let dNorm = 1.0;

        if (_hasAirTip) {
          let bestA = 0.0;
          let bestBump = 0.0;
          const steps = isDab || dist < 1.0 ? 1 : Math.min(8, Math.max(2, Math.ceil(dist / Math.max(2.0, radius * 0.25))));
          const wobbleU = tipPourRatio > 0.04 ? (edgeNoise.vx * 0.05 + (tooth - 0.5) * 0.06) * tipPourRatio : 0.0;
          const wobbleV = tipPourRatio > 0.04 ? (edgeNoise.vy * 0.05 + (0.5 - tooth) * 0.06) * tipPourRatio : 0.0;
          for (let st = 0; st < steps; st++) {
            const stFrac = steps === 1 ? 1.0 : st / (steps - 1);
            const sxW = isDab ? to.x : (from.x + rawDx * stFrac);
            const syW = isDab ? to.y : (from.y + rawDy * stFrac);
            const lxW = worldX - sxW;
            const lyW = worldY - syW;
            const u = (lxW * rotCos - lyW * rotSin) * invRadWorld + wobbleU;
            const v = (lxW * rotSin + lyW * rotCos) * invRadWorld + wobbleV;
            const ts = sampleCpuAirTip(u, v);
            if (ts.a > bestA) bestA = ts.a;
            if (ts.bump > bestBump) bestBump = ts.bump;
          }
          const pourBody = Math.max(0.0, Math.min(1.0, (bestBump * (0.80 + 0.36 * tooth) + bestA * 0.38 - 0.05) / 0.50));
          washDome = bestA * (1.0 - tipPourRatio) + Math.max(bestA, pourBody) * tipPourRatio;
          dNorm = Math.max(0.0, Math.min(1.05, 1.0 - (bestA * (1.0 - tipPourRatio) + bestBump * tipPourRatio) * 0.88));
        } else {
          // Organic liquid edge wobble scaled by Bloom + Stream Flow
          const dNormRaw = Math.sqrt(d2) / Math.max(0.5, radGrid);
          const wobbleAmt = (edgeNoise.vx * 0.14 + (tooth - 0.5) * 0.16) * (0.30 + 0.70 * bloomRatio);
          dNorm = Math.max(0.0, dNormRaw + wobbleAmt);
          if (dNorm < 1.06) {
            const edgeShape = Math.max(0.0, 1.0 - (dNorm / 1.06) * (dNorm / 1.06));
            washDome = Math.pow(edgeShape, 0.78);
          }
        }

        if (washDome > 0.004) {
          // Internal pooling mottle + cold-press paper granulation
          const caustics = 0.88 + 0.14 * (0.5 + 0.5 * edgeNoise.vy) * (0.3 + 0.7 * wetnessRatio);
          const granMod = 1.0 - granRatio * 0.26 * tooth;

          // Classic subtle watery rim lightening inside puddle center when Pigment Edge is up
          const centerLighten = Math.max(0.25, 1.0 - edgeRatio * 0.15 * (1.0 - dNorm) * wetnessRatio);

          const targetA = Math.min(1.0, washDome * strokeOpacity * flowFactor * caustics * granMod * centerLighten);

          const prevDist = _nsDist[i];
          const prevCov = (localDist - prevDist >= 0 && localDist - prevDist < coverWindow) ? _nsCov[i] : 0.0;
          const stepA = targetA > prevCov && prevCov < 0.99
            ? (targetA - prevCov) / (1.0 - prevCov)
            : 0.0;

          if (stepA > 0.002) {
            const curA = _nsA[i];
            let paintR = baseColor.r;
            let paintG = baseColor.g;
            let paintB = baseColor.b;

            // Paper valley settling tint & Beer-Lambert optical translucent layer mixing
            if (curA > 0.02) {
              const invC = 1.0 / curA;
              const dstR = _nsPR[i] * invC;
              const dstG = _nsPG[i] * invC;
              const dstB = _nsPB[i] * invC;
              const multR = (dstR * baseColor.r) / 255.0;
              const multG = (dstG * baseColor.g) / 255.0;
              const multB = (dstB * baseColor.b) / 255.0;
              paintR = baseColor.r * (1.0 - opticalMultWeight) + multR * opticalMultWeight;
              paintG = baseColor.g * (1.0 - opticalMultWeight) + multG * opticalMultWeight;
              paintB = baseColor.b * (1.0 - opticalMultWeight) + multB * opticalMultWeight;
            }

            // Slight mineral darkening inside paper valleys for cold-press granulation
            if (granRatio > 0.02) {
              const gShade = Math.max(0.86, 1.0 - granRatio * 0.06 * (1.0 - tooth));
              paintR *= gShade;
              paintG *= gShade;
              paintB *= gShade;
            }

            const oneMinusStep = 1.0 - stepA;
            let outA = curA * oneMinusStep + stepA;
            if (outA < targetA) outA = targetA;

            _nsPR[i] = _nsPR[i] * oneMinusStep + paintR * stepA;
            _nsPG[i] = _nsPG[i] * oneMinusStep + paintG * stepA;
            _nsPB[i] = _nsPB[i] * oneMinusStep + paintB * stepA;
            _nsA[i] = Math.min(1.0, outA);

            _nsDist[i] = localDist;
            if (targetA > _nsNewCov[i]) _nsNewCov[i] = targetA;
          }
        }

        // Authentic Coffee-Ring Drying Edge (rate-limited so multi-frame strokes stay translucent & colorful)
        if (edgeStrength > 0.02 && _nsA[i] > 0.02 && _nsW[i] > 0.02) {
          const gW = Math.hypot(_nsW[i + 1] - _nsW[i - 1], _nsW[i + cols] - _nsW[i - cols]);
          if (gW > 0.08) {
            const rimFactor = Math.min(0.032, gW * 0.14 * edgeStrength);
            const shade = 1.0 - rimFactor * 0.10;
            const newA = Math.min(1.0, _nsA[i] + rimFactor * 0.22 * (1.0 - _nsA[i]));
            const scale = (_nsA[i] > 0.001 ? newA / _nsA[i] : 1.0) * shade;
            _nsPR[i] *= scale;
            _nsPG[i] *= scale;
            _nsPB[i] *= scale;
            _nsA[i] = newA;
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------
  // 6. SMOOTH PREMULTIPLIED BILINEAR RECONSTRUCTION TO FULL PATCH
  // -----------------------------------------------------------------
  const invStepGrid = 1.0 / simStep;
  for (let y = apron; y < boxH - apron; y++) {
    const pRow = y * boxW;
    const fyFull = (y - apron) * invStepGrid;
    const gy0 = Math.min(rows - 2, Math.max(0, fyFull | 0));
    const fy = fyFull - gy0;
    const invFy = 1.0 - fy;

    for (let x = apron; x < boxW - apron; x++) {
      const fxFull = (x - apron) * invStepGrid;
      const gx0 = Math.min(cols - 2, Math.max(0, fxFull | 0));
      const fx = fxFull - gx0;
      const invFx = 1.0 - fx;

      const c00 = gy0 * cols + gx0;
      const c10 = c00 + 1;
      const c01 = c00 + cols;
      const c11 = c01 + 1;

      const w00 = invFx * invFy;
      const w10 = fx * invFy;
      const w01 = invFx * fy;
      const w11 = fx * fy;

      const outW = _nsW[c00] * w00 + _nsW[c10] * w10 + _nsW[c01] * w01 + _nsW[c11] * w11;
      const outA = _nsA[c00] * w00 + _nsA[c10] * w10 + _nsA[c01] * w01 + _nsA[c11] * w11;

      const dstIdx = pRow + x;
      const dst4 = dstIdx * 4;

      if (outA < 0.002 && outW < 0.005) {
        _outBufRGBA[dst4 + 3] = 0;
        _outBufWater[dstIdx] = 0;
        _outBufVx[dstIdx] = 0;
        _outBufVy[dstIdx] = 0;
        continue;
      }

      if (outA < 0.002) {
        _outBufRGBA[dst4] = 0;
        _outBufRGBA[dst4 + 1] = 0;
        _outBufRGBA[dst4 + 2] = 0;
        _outBufRGBA[dst4 + 3] = 0;
      } else {
        const pr = _nsPR[c00] * w00 + _nsPR[c10] * w10 + _nsPR[c01] * w01 + _nsPR[c11] * w11;
        const pg = _nsPG[c00] * w00 + _nsPG[c10] * w10 + _nsPG[c01] * w01 + _nsPG[c11] * w11;
        const pb = _nsPB[c00] * w00 + _nsPB[c10] * w10 + _nsPB[c01] * w01 + _nsPB[c11] * w11;
        const invA = 1.0 / outA;
        _outBufRGBA[dst4] = clampByte(pr * invA);
        _outBufRGBA[dst4 + 1] = clampByte(pg * invA);
        _outBufRGBA[dst4 + 2] = clampByte(pb * invA);
        _outBufRGBA[dst4 + 3] = clampByte(outA * 255.0);
      }

      _outBufWater[dstIdx] = outW;
      _outBufVx[dstIdx] = _nsU[c00] * w00 + _nsU[c10] * w10 + _nsU[c01] * w01 + _nsU[c11] * w11;
      _outBufVy[dstIdx] = _nsV[c00] * w00 + _nsV[c10] * w10 + _nsV[c01] * w01 + _nsV[c11] * w11;
      _outBufDist[dstIdx] = Math.max(_nsDist[c00], _nsDist[c10], _nsDist[c01], _nsDist[c11]);
      _outBufCover[dstIdx] = _nsNewCov[c00] * w00 + _nsNewCov[c10] * w10 + _nsNewCov[c01] * w01 + _nsNewCov[c11] * w11;
    }
  }

  writePatchToTilesAndChunks(engine, ab, boxX, boxY, boxW, boxH);

  ab.prevDir = { x: dirX, y: dirY };
  engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, boxX + apron);
  engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, boxX + boxW - apron);
  engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, boxY + apron);
  engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, boxY + boxH - apron);
}

/**
 * Quadratic Bezier arc subdivision so quick curves produce fluid continuous washes without corners.
 */
function runSmoothedBezier(engine, ab, a, ctrl, b, radius, opacity, baseColor, pressure, pointAngle = null, isDab = false) {
  const dx1 = ctrl.x - a.x;
  const dy1 = ctrl.y - a.y;
  const dx2 = b.x - ctrl.x;
  const dy2 = b.y - ctrl.y;
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);

  let subSteps = 1;
  if (!isDab && len1 > 0.5 && len2 > 0.5) {
    const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    const angle = Math.acos(dot < -1 ? -1 : (dot > 1 ? 1 : dot));
    if (angle > 0.16) {
      subSteps = Math.min(4, Math.max(2, Math.ceil(angle / 0.20)));
    }
  }

  let prevPt = a;
  for (let i = 1; i <= subSteps; i++) {
    const t = i / subSteps;
    const invT = 1.0 - t;
    const nextPt = i === subSteps
      ? b
      : {
          x: invT * invT * a.x + 2.0 * invT * t * ctrl.x + t * t * b.x,
          y: invT * invT * a.y + 2.0 * invT * t * ctrl.y + t * t * b.y
        };
    runAirStep(engine, ab, prevPt, nextPt, radius, opacity, baseColor, pressure, false, pointAngle, isDab);
    prevPt = nextPt;
  }
}

function getNormalizedAirParams() {
  return {
    wetness: Math.max(0.0, Math.min(1.0, airSettings.wetness / 100.0)),
    streamFlow: Math.max(0.0, Math.min(1.0, airSettings.streamFlow / 100.0)),
    bloom: Math.max(0.0, Math.min(1.0, airSettings.bloom / 100.0)),
    edge: Math.max(0.0, Math.min(1.0, airSettings.edge / 100.0)),
    granulation: Math.max(0.0, Math.min(1.0, airSettings.granulation / 100.0)),
    tipPour: Math.max(0.0, Math.min(1.0, (airSettings.tipPour ?? 100) / 100.0))
  };
}

function buildTipInfo(engine, dirX, dirY, params, pointAngle = null, isDab = false) {
  const rot = computeAirTipAngle(engine, dirX, dirY, pointAngle);
  return {
    hasTip: _hasAirTip,
    cosR: rot.cosR,
    sinR: rot.sinR,
    tipPour: params.tipPour,
    isDab
  };
}

function getGpuSolver(engine) {
  const gr = engine && engine.gpuRenderer;
  if (!gr || !gr.supported || !gr.gl) return null;
  if (!gr.airSolver) {
    gr.airSolver = new GpuWatercolorSolver(gr);
  }
  return gr.airSolver.ready ? gr.airSolver : null;
}

export function warmAirSolver(engine) {
  if (!engine) return null;
  return getGpuSolver(engine);
}

function runGpuSmoothedBezier(engine, solver, ab, a, ctrl, b, radius, opacity, baseColor, flowFactor, params, timeSec, pointAngle = null, isDab = false) {
  const dx1 = ctrl.x - a.x;
  const dy1 = ctrl.y - a.y;
  const dx2 = b.x - ctrl.x;
  const dy2 = b.y - ctrl.y;
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);

  let subSteps = 1;
  if (!isDab && len1 > 0.5 && len2 > 0.5) {
    const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    const angle = Math.acos(dot < -1 ? -1 : (dot > 1 ? 1 : dot));
    if (angle > 0.16) {
      subSteps = Math.min(4, Math.max(2, Math.ceil(angle / 0.20)));
    }
  }

  let minX = isDab ? b.x : Math.min(a.x, ctrl.x, b.x);
  let minY = isDab ? b.y : Math.min(a.y, ctrl.y, b.y);
  let maxX = isDab ? b.x : Math.max(a.x, ctrl.x, b.x);
  let maxY = isDab ? b.y : Math.max(a.y, ctrl.y, b.y);

  const pad = Math.ceil(radius * (1.12 + params.bloom * 0.35 + params.tipPour * 0.22)) + 16;
  solver.beginStepBatch(engine, minX - pad, minY - pad, maxX + pad, maxY + pad);

  let prevPt = a;
  for (let i = 1; i <= subSteps; i++) {
    const t = i / subSteps;
    const invT = 1.0 - t;
    const nextPt = i === subSteps
      ? b
      : {
          x: invT * invT * a.x + 2.0 * invT * t * ctrl.x + t * t * b.x,
          y: invT * invT * a.y + 2.0 * invT * t * ctrl.y + t * t * b.y
        };
    const sDx = nextPt.x - prevPt.x;
    const sDy = nextPt.y - prevPt.y;
    const sL = Math.hypot(sDx, sDy);
    const dirX = sL > 0.0001 ? sDx / sL : (ab.prevDir ? ab.prevDir.x : 1.0);
    const dirY = sL > 0.0001 ? sDy / sL : (ab.prevDir ? ab.prevDir.y : 0.0);
    const tipInfo = buildTipInfo(engine, dirX, dirY, params, pointAngle, isDab);
    solver.injectSegment(engine, prevPt, nextPt, radius, baseColor, opacity, flowFactor, params, timeSec + i * 0.015, tipInfo);
    ab.prevDir = { x: dirX, y: dirY };
    prevPt = nextPt;
  }

  solver.solveAndFlowStep(engine, minX - pad, minY - pad, maxX + pad, maxY + pad, params, 1.0);
  ab.time = timeSec + 0.06;
}

// ----------------------------------------------------
// PUBLIC ENGINE HOOKS
// ----------------------------------------------------
export function startAirPaintStroke(engine) {
  syncAirSettingsFromEngine(engine);
  const params = getNormalizedAirParams();
  const hasTip = prepareAirTipMaps(engine);

  const startP = (engine.strokePoints && engine.strokePoints.length > 0)
    ? engine.strokePoints[0]
    : { x: 0, y: 0, size: engine.brush.size, opacity: engine.brush.opacity, color: engine.brush.color, pressure: 1.0 };

  const baseColor = parseColor(startP.color || engine.brush.color);
  const radius = Math.max(3.0, (startP.size || engine.brush.size || 70) * 0.5);

  const solver = getGpuSolver(engine);
  if (solver) {
    solver.uploadTipMaps(hasTip ? _airTipRgbaBytes : null, TIP_RES, _preparedAirTipVersionCounter);
  }
  const useGpu = !!(solver && solver.beginStroke(engine, startP, params.wetness));

  engine.activeAirBrush = {
    useGpu,
    tiles: new Map(),
    streamers: [],
    p0: { x: startP.x, y: startP.y },
    p1: null,
    midPrev: { x: startP.x, y: startP.y },
    lastPos: { x: startP.x, y: startP.y },
    prevDir: null,
    totalDist: 0,
    time: (performance.now() * 0.001) % 100.0,
    hasPainted: false,
    radius,
    baseColor,
    lastOpacity: startP.opacity ?? engine.brush.opacity ?? 0.55,
    lastPressure: startP.pressure ?? 1.0,
    lastAngle: startP.angle ?? null
  };
}

export function paintAirIncrementally(engine, j) {
  if (engine.perfMonitor) engine.perfMonitor.markPhase('air_step');
  if (!engine.isDrawing) return;
  const points = engine.strokePoints;
  if (j < 1 || j >= points.length) return;

  if (!engine.activeAirBrush) {
    startAirPaintStroke(engine);
  }
  const ab = engine.activeAirBrush;
  ab.hasPainted = true;

  const pPrev = points[j - 1];
  const p = points[j];

  const radius = Math.max(3.0, (p.size || engine.brush.size || 70) * 0.5);
  const opacity = p.opacity !== undefined ? p.opacity : (engine.brush.opacity ?? 0.55);
  const pressure = p.pressure !== undefined ? p.pressure : 1.0;
  const pointAngle = p.angle !== undefined ? p.angle : null;
  const isDab = !!p.isDab;
  const baseColor = parseColor(p.color || engine.brush.color);

  ab.radius = radius;
  ab.baseColor = baseColor;
  ab.lastOpacity = opacity;
  ab.lastPressure = pressure;
  ab.lastAngle = pointAngle;

  const dist = Math.hypot(p.x - pPrev.x, p.y - pPrev.y);
  if (dist > 450.0) {
    ab.p0 = { x: p.x, y: p.y };
    ab.p1 = null;
    ab.midPrev = { x: p.x, y: p.y };
    ab.lastPos = { x: p.x, y: p.y };
    ab.prevDir = null;
    return;
  }

  if (ab.useGpu) {
    const solver = getGpuSolver(engine);
    if (solver && solver.active) {
      syncAirSettingsFromEngine(engine);
      const params = getNormalizedAirParams();
      const effPressure = engine?.brush?.pressureEnabled ? pressure : 1.0;
      const pFlowInf = (airSettings.pressureFlow ?? 35) / 100.0;
      const pressFlowScale = 1.0 - pFlowInf + pFlowInf * effPressure;
      const effOpacity = Math.max(0.02, Math.min(1.0, opacity * effPressure));
      const flowFactor = Math.max(0.03, Math.min(1.0, (engine?.brush?.flow ?? 0.70) * pressFlowScale));

      if (isDab) {
        const sDx = p.x - pPrev.x;
        const sDy = p.y - pPrev.y;
        const sL = Math.hypot(sDx, sDy);
        const dirX = sL > 0.0001 ? sDx / sL : (ab.prevDir ? ab.prevDir.x : 1.0);
        const dirY = sL > 0.0001 ? sDy / sL : (ab.prevDir ? ab.prevDir.y : 0.0);
        ab.prevDir = { x: dirX, y: dirY };
        const tipInfo = buildTipInfo(engine, dirX, dirY, params, pointAngle, true);
        const pad = Math.ceil(radius * (1.12 + params.bloom * 0.35 + params.tipPour * 0.22)) + 16;
        solver.beginStepBatch(engine, p.x - pad, p.y - pad, p.x + pad, p.y + pad);
        solver.injectSegment(engine, p, p, radius, baseColor, effOpacity, flowFactor, params, ab.time, tipInfo);
        solver.solveAndFlowStep(engine, p.x - pad, p.y - pad, p.x + pad, p.y + pad, params, 1.0);
        ab.time += 0.04;
        ab.p0 = { x: p.x, y: p.y };
        ab.p1 = null;
        ab.midPrev = { x: p.x, y: p.y };
      } else if (!ab.p1) {
        const mid = { x: (ab.p0.x + p.x) * 0.5, y: (ab.p0.y + p.y) * 0.5 };
        const sDx = mid.x - ab.p0.x;
        const sDy = mid.y - ab.p0.y;
        const sL = Math.hypot(sDx, sDy);
        const dirX = sL > 0.0001 ? sDx / sL : 1.0;
        const dirY = sL > 0.0001 ? sDy / sL : 0.0;
        ab.prevDir = { x: dirX, y: dirY };
        const tipInfo = buildTipInfo(engine, dirX, dirY, params, pointAngle, false);
        const pad = Math.ceil(radius * (1.12 + params.bloom * 0.35 + params.tipPour * 0.22)) + 16;
        const bMinX = Math.min(ab.p0.x, mid.x) - pad;
        const bMinY = Math.min(ab.p0.y, mid.y) - pad;
        const bMaxX = Math.max(ab.p0.x, mid.x) + pad;
        const bMaxY = Math.max(ab.p0.y, mid.y) + pad;
        solver.beginStepBatch(engine, bMinX, bMinY, bMaxX, bMaxY);
        solver.injectSegment(engine, ab.p0, mid, radius, baseColor, effOpacity, flowFactor, params, ab.time, tipInfo);
        solver.solveAndFlowStep(engine, bMinX, bMinY, bMaxX, bMaxY, params, 1.0);
        ab.time += 0.04;
        ab.p1 = { x: p.x, y: p.y };
        ab.midPrev = mid;
      } else {
        const midNext = { x: (ab.p1.x + p.x) * 0.5, y: (ab.p1.y + p.y) * 0.5 };
        runGpuSmoothedBezier(engine, solver, ab, ab.midPrev, ab.p1, midNext, radius, effOpacity, baseColor, flowFactor, params, ab.time, pointAngle, false);
        ab.p1 = { x: p.x, y: p.y };
        ab.midPrev = midNext;
      }

      ab.lastPos = { x: p.x, y: p.y };
      return;
    }
  }

  // CPU Fallback (if WebGL2 unavailable)
  if (isDab) {
    runAirStep(engine, ab, p, p, radius, opacity, baseColor, pressure, false, pointAngle, true);
    ab.p0 = { x: p.x, y: p.y };
    ab.p1 = null;
    ab.midPrev = { x: p.x, y: p.y };
  } else if (!ab.p1) {
    const mid = { x: (ab.p0.x + p.x) * 0.5, y: (ab.p0.y + p.y) * 0.5 };
    runAirStep(engine, ab, ab.p0, mid, radius, opacity, baseColor, pressure, false, pointAngle, false);
    ab.p1 = { x: p.x, y: p.y };
    ab.midPrev = mid;
  } else {
    const midNext = { x: (ab.p1.x + p.x) * 0.5, y: (ab.p1.y + p.y) * 0.5 };
    runSmoothedBezier(engine, ab, ab.midPrev, ab.p1, midNext, radius, opacity, baseColor, pressure, pointAngle, false);
    ab.p1 = { x: p.x, y: p.y };
    ab.midPrev = midNext;
  }

  ab.lastPos = { x: p.x, y: p.y };
}

export function endAirPaintStroke(engine) {
  const ab = engine.activeAirBrush;
  if (!ab) return;

  const p = ab.lastPos;
  const op = ab.lastOpacity ?? engine.brush.opacity ?? 0.55;
  const pr = ab.lastPressure ?? 1.0;
  const pAng = ab.lastAngle ?? null;

  if (ab.useGpu) {
    const solver = getGpuSolver(engine);
    if (solver && solver.active) {
      syncAirSettingsFromEngine(engine);
      const params = getNormalizedAirParams();
      const effPressure = engine?.brush?.pressureEnabled ? pr : 1.0;
      const pFlowInf = (airSettings.pressureFlow ?? 35) / 100.0;
      const pressFlowScale = 1.0 - pFlowInf + pFlowInf * effPressure;
      const effOpacity = Math.max(0.02, Math.min(1.0, op * effPressure));
      const flowFactor = Math.max(0.03, Math.min(1.0, (engine?.brush?.flow ?? 0.70) * pressFlowScale));

      if (!ab.hasPainted) {
        const dirX = ab.prevDir ? ab.prevDir.x : 1.0;
        const dirY = ab.prevDir ? ab.prevDir.y : 0.0;
        const tipInfo = buildTipInfo(engine, dirX, dirY, params, pAng, true);
        const pad = Math.ceil(ab.radius * (1.12 + params.bloom * 0.35 + params.tipPour * 0.22)) + 16;
        solver.beginStepBatch(engine, p.x - pad, p.y - pad, p.x + pad, p.y + pad);
        if (_hasAirTip) {
          solver.injectSegment(engine, p, p, ab.radius, ab.baseColor, effOpacity, flowFactor, params, ab.time, tipInfo);
        } else {
          const dabAngle = Math.random() * Math.PI * 2;
          const dabDist = Math.max(0.8, Math.min(2.5, ab.radius * 0.05));
          const dabTo = { x: p.x + Math.cos(dabAngle) * dabDist, y: p.y + Math.sin(dabAngle) * dabDist };
          solver.injectSegment(engine, p, dabTo, ab.radius, ab.baseColor, effOpacity, flowFactor, params, ab.time, tipInfo);
        }
        solver.solveAndFlowStep(engine, p.x - pad, p.y - pad, p.x + pad, p.y + pad, params, 1.0);
      } else if (ab.p1 && ab.midPrev) {
        const sDx = ab.p1.x - ab.midPrev.x;
        const sDy = ab.p1.y - ab.midPrev.y;
        const sL = Math.hypot(sDx, sDy);
        const dirX = sL > 0.0001 ? sDx / sL : (ab.prevDir ? ab.prevDir.x : 1.0);
        const dirY = sL > 0.0001 ? sDy / sL : (ab.prevDir ? ab.prevDir.y : 0.0);
        const tipInfo = buildTipInfo(engine, dirX, dirY, params, pAng, false);
        const pad = Math.ceil(ab.radius * (1.12 + params.bloom * 0.35 + params.tipPour * 0.22)) + 16;
        const bMinX = Math.min(ab.midPrev.x, ab.p1.x) - pad;
        const bMinY = Math.min(ab.midPrev.y, ab.p1.y) - pad;
        const bMaxX = Math.max(ab.midPrev.x, ab.p1.x) + pad;
        const bMaxY = Math.max(ab.midPrev.y, ab.p1.y) + pad;
        solver.beginStepBatch(engine, bMinX, bMinY, bMaxX, bMaxY);
        solver.injectSegment(engine, ab.midPrev, ab.p1, ab.radius, ab.baseColor, effOpacity, flowFactor, params, ab.time, tipInfo);
        solver.solveAndFlowStep(engine, bMinX, bMinY, bMaxX, bMaxY, params, 1.0);
      }

      solver.endStroke(engine, params);
      ab.tiles.clear();
      ab.streamers = [];
      engine.activeAirBrush = null;
      return;
    }
  }

  if (!ab.hasPainted) {
    if (_hasAirTip) {
      runAirStep(engine, ab, p, p, ab.radius, op, ab.baseColor, 1.0, false, pAng, true);
    } else {
      const dabAngle = Math.random() * Math.PI * 2;
      const dabDist = Math.max(0.8, Math.min(2.5, ab.radius * 0.05));
      const dabTo = { x: p.x + Math.cos(dabAngle) * dabDist, y: p.y + Math.sin(dabAngle) * dabDist };
      runAirStep(engine, ab, p, dabTo, ab.radius, op, ab.baseColor, 1.0, false, pAng, true);
    }
  } else if (ab.p1 && ab.midPrev) {
    // Flush final half-segment cleanly to exact pointerup coordinate
    runAirStep(engine, ab, ab.midPrev, ab.p1, ab.radius, op, ab.baseColor, pr, false, pAng, false);
  }

  // Smoothly coast & settle Navier-Stokes streams + wet capillary bleed without abrupt cuts
  const settleSteps = Math.min(6, Math.max(2, Math.round((airSettings.wetness / 100) * 5)));
  for (let s = 0; s < settleSteps; s++) {
    runAirStep(engine, ab, ab.lastPos, ab.lastPos, ab.radius, op, ab.baseColor, 1.0, true, pAng, false);
  }

  // Persist wet paper film across strokes for true wet-on-wet watercolor bleeding
  const now = performance.now();
  ab.tiles.forEach((tile) => {
    const key = getWetCacheKey(engine, tile.tx, tile.ty);
    touchWetCacheEntry(key, {
      water: new Float32Array(tile.water),
      vx: new Float32Array(tile.vx),
      vy: new Float32Array(tile.vy),
      updatedAt: now
    });
  });

  ab.tiles.clear();
  ab.streamers = [];
  engine.activeAirBrush = null;
  engine.refresh();
}

export function clearAirParticles(engine = null) {
  if (engine && engine.gpuRenderer && engine.gpuRenderer.airSolver) {
    engine.gpuRenderer.airSolver.cancel(engine);
  }
  if (engine && engine.activeAirBrush) {
    if (engine.activeAirBrush.tiles) engine.activeAirBrush.tiles.clear();
    engine.activeAirBrush.streamers = [];
    engine.activeAirBrush = null;
  }
}
