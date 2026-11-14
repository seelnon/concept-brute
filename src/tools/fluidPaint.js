import { TOOLS } from '../constants.js';
import { hexToRgb, rgbToHsl, hslToRgb } from '../colorUtils.js';

/**
 * Physical Fluid & Tip-Guided Self-Feeding Paint Engine
 * - Quadratic Bezier corner smoothing + exact coverage recovery (zero contour stitches or corner pie-wedges)
 * - Continuous self-advection ("feeds on itself") + world-phase curl filaments
 * - Active Brush Tip (engine.brush.tip) silhouette & 2D local-density bump map:
 *   solid tip regions build deeper 3D impasto & sharper bristle lines; thin line regions stay softer
 * - Vortex = 0% yields straight parallel bristle lines following the stroke tangent; Flow = 100% is fully opaque
 * - Adaptive physics lattice (simStep 1/2/3) + linearized tip sweep keeps brush size >100 fast at 60fps
 * - Sparse 256x256 in-memory world tiles + Air-Paint curl streamers + 3x3 Sobel 3D impasto & Blinn-Phong gloss
 */

const TILE_SIZE = 256;
const TIP_RES = 64;

// Module-level cached tuning settings (0 DOM lookups during drawing)
export const fluidSettings = {
  flow: 100,
  vortex: 55,
  turb: 40,
  retention: 35,
  pickup: 45,
  depth: 75,
  gloss: 45,
  fluidity: 80,
  bristles: 40,
  shading: true
};

// Reusable scratch buffers to eliminate per-frame allocations & GC stalls
let _tileReadCanvas = null;
let _tileReadCtx = null;
let _tipWorkCanvas = null;
let _tipWorkCtx = null;
let _litCanvas = null;
let _litCtx = null;
let _litImageData = null;
let _scratchW = 0;
let _scratchH = 0;

let _patchPixels = new Uint8ClampedArray(0);
let _patchH = new Float32Array(0);
let _patchDist = new Float32Array(0);
let _patchCover = new Float32Array(0);
let _patchAdvRGB = new Uint8ClampedArray(0);
let _patchAdvH = new Float32Array(0);
let _patchAdvDist = new Float32Array(0);
let _patchAdvCover = new Float32Array(0);

// Pre-allocated tip bump buffers (64x64 fits cleanly in L1 cache)
const _tipRaw = new Float32Array(TIP_RES * TIP_RES);
const _tipBlurTmp = new Float32Array(TIP_RES * TIP_RES);
const _tipBump = new Float32Array(TIP_RES * TIP_RES);
const _tipActivePoints = [];

function ensureScratchBuffers(w, h) {
  if (!_litCanvas) {
    _litCanvas = document.createElement('canvas');
  }

  if (w > _scratchW || h > _scratchH) {
    const newW = Math.max(_scratchW, w + 32);
    const newH = Math.max(_scratchH, h + 32);
    _scratchW = newW;
    _scratchH = newH;

    _litCanvas.width = newW;
    _litCanvas.height = newH;
    _litCtx = _litCanvas.getContext('2d', { willReadFrequently: true });
    _litImageData = _litCtx.createImageData(newW, newH);

    const len = newW * newH;
    _patchPixels = new Uint8ClampedArray(len * 4);
    _patchH = new Float32Array(len);
    _patchDist = new Float32Array(len);
    _patchCover = new Float32Array(len);
    _patchAdvRGB = new Uint8ClampedArray(len * 4);
    _patchAdvH = new Float32Array(len);
    _patchAdvDist = new Float32Array(len);
    _patchAdvCover = new Float32Array(len);
  } else if (!_litCtx) {
    _litCtx = _litCanvas.getContext('2d', { willReadFrequently: true });
    _litImageData = _litCtx.createImageData(_scratchW, _scratchH);
  }
}

export function initFluidPaint(app) {
  const panelFluid = document.getElementById('panel-fluid');
  const btnCollapse = document.getElementById('btn-fluid-collapse');

  const sliderFluidity = document.getElementById('slider-fluidity');
  const valFluidity = document.getElementById('val-fluidity');
  const sliderBristles = document.getElementById('slider-bristles');
  const valBristles = document.getElementById('val-bristles');

  if (app._makeDraggable && panelFluid) {
    app._makeDraggable(panelFluid, document.getElementById('handle-fluid'));
  }

  if (btnCollapse) {
    btnCollapse.onclick = () => {
      const content = document.getElementById('fluid-content');
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'flex' : 'none';
        btnCollapse.innerText = isHidden ? '_' : '+';
      }
    };
  }

  if (sliderFluidity) {
    const saved = localStorage.getItem('fluid_setting_slider-fluidity');
    if (saved !== null) {
      sliderFluidity.value = saved;
      fluidSettings.fluidity = parseFloat(saved);
    }
    if (valFluidity) valFluidity.innerText = `${sliderFluidity.value}%`;
    sliderFluidity.oninput = () => {
      const v = parseFloat(sliderFluidity.value);
      fluidSettings.fluidity = v;
      if (valFluidity) valFluidity.innerText = `${v}%`;
      localStorage.setItem('fluid_setting_slider-fluidity', sliderFluidity.value);
      if (app.updateActiveSetting) app.updateActiveSetting('fluidity', v);
    };
  }

  if (sliderBristles) {
    const saved = localStorage.getItem('fluid_setting_slider-bristles');
    if (saved !== null) {
      sliderBristles.value = saved;
      fluidSettings.bristles = parseInt(saved, 10);
    }
    if (valBristles) valBristles.innerText = sliderBristles.value;
    sliderBristles.oninput = () => {
      const v = parseInt(sliderBristles.value, 10);
      fluidSettings.bristles = v;
      if (valBristles) valBristles.innerText = v;
      localStorage.setItem('fluid_setting_slider-bristles', sliderBristles.value);
    };
  }

  const setupSlider = (sliderId, valId, settingKey, defaultVal) => {
    const slider = document.getElementById(sliderId);
    const val = document.getElementById(valId);
    if (slider) {
      const saved = localStorage.getItem('fluid_setting_' + sliderId);
      if (saved !== null) {
        slider.value = saved;
        fluidSettings[settingKey] = parseFloat(saved);
      } else {
        slider.value = defaultVal;
        fluidSettings[settingKey] = defaultVal;
      }
      if (val) val.innerText = `${slider.value}%`;

      slider.oninput = () => {
        const v = parseFloat(slider.value);
        fluidSettings[settingKey] = v;
        if (val) val.innerText = `${v}%`;
        localStorage.setItem('fluid_setting_' + sliderId, slider.value);
      };
    }
  };

  const setupCheckbox = (chkId, settingKey, defaultVal) => {
    const chk = document.getElementById(chkId);
    if (chk) {
      const saved = localStorage.getItem('fluid_setting_' + chkId);
      if (saved !== null) {
        chk.checked = saved === 'true';
        fluidSettings[settingKey] = chk.checked;
      } else {
        chk.checked = defaultVal;
        fluidSettings[settingKey] = defaultVal;
      }
      chk.onchange = () => {
        fluidSettings[settingKey] = chk.checked;
        localStorage.setItem('fluid_setting_' + chkId, chk.checked);
      };
    }
  };

  setupSlider('slider-fluid-flow', 'val-fluid-flow', 'flow', 100);
  setupSlider('slider-fluid-vortex', 'val-fluid-vortex', 'vortex', 55);
  setupSlider('slider-fluid-turb', 'val-fluid-turb', 'turb', 40);
  setupSlider('slider-fluid-retention', 'val-fluid-retention', 'retention', 35);
  setupSlider('slider-fluid-pickup', 'val-fluid-pickup', 'pickup', 45);
  setupSlider('slider-fluid-depth', 'val-fluid-depth', 'depth', 75);
  setupSlider('slider-fluid-gloss', 'val-fluid-gloss', 'gloss', 45);

  setupCheckbox('chk-surface-shading', 'shading', true);
}

export function activateFluidPaint(app) {
  const panel = document.getElementById('panel-fluid');
  if (panel) panel.classList.remove('hidden');

  const ctrlFluidity = document.getElementById('control-fluidity');
  if (ctrlFluidity) ctrlFluidity.style.display = 'flex';

  const ctrlBristles = document.getElementById('control-bristles');
  if (ctrlBristles) ctrlBristles.style.display = 'flex';

  const sliderFluidity = document.getElementById('slider-fluidity');
  if (sliderFluidity) {
    const v = parseFloat(sliderFluidity.value);
    if (!Number.isNaN(v)) fluidSettings.fluidity = v;
  }

  app._status('FLUID PAINT ACTIVE');
}

export function deactivateFluidPaint(app) {
  const panel = document.getElementById('panel-fluid');
  if (panel) panel.classList.add('hidden');

  const ctrlFluidity = document.getElementById('control-fluidity');
  if (ctrlFluidity) ctrlFluidity.style.display = 'none';

  const ctrlBristles = document.getElementById('control-bristles');
  if (ctrlBristles) ctrlBristles.style.display = 'none';

  if (app.engine) {
    cancelFluidAfterEffect(app.engine);
    app.engine.activeFluidBrush = null;
  }

  app._status('FLUID PAINT DEACTIVATED');
}

// ----------------------------------------------------
// COLOR & MATH HELPERS
// ----------------------------------------------------
function parseColor(c) {
  if (!c) return { r: 215, g: 35, b: 35 };
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
  return { r: 215, g: 35, b: 35 };
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

/**
 * Analytic divergence-free 2D curl noise velocity field: v = curl(psi)
 * Produces smooth incompressible fluid eddies (zero pinch/explosion).
 */
function sampleCurl(x, y, time, freq) {
  const fx = x * freq;
  const fy = y * freq;
  const p1 = fx + time;
  const q1 = fy - 0.7 * time;
  const p2 = 2.1 * fx - 1.3 * time;
  const q2 = 1.9 * fy + 0.9 * time;

  const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
  const sinQ1 = Math.sin(q1), cosQ1 = Math.cos(q1);
  const sinP2 = Math.sin(p2), cosP2 = Math.cos(p2);
  const sinQ2 = Math.sin(q2), cosQ2 = Math.cos(q2);

  return {
    vx: -sinP1 * sinQ1 + 0.95 * sinP2 * cosQ2,
    vy: -(cosP1 * cosQ1 + 1.05 * cosP2 * sinQ2)
  };
}

// ----------------------------------------------------
// BRUSH TIP SILHOUETTE & BUMP MAP BUILDER (64x64 L1-CACHED)
// ----------------------------------------------------
function prepareTipMaps(engine) {
  _tipActivePoints.length = 0;
  const tip = engine?.brush?.tip;

  if (tip && tip.width > 0 && tip.height > 0) {
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
    for (let y = 0; y < TIP_RES; y++) {
      for (let x = 0; x < TIP_RES; x++) {
        const i = y * TIP_RES + x;
        const a = data[i * 4 + 3] / 255.0;
        _tipRaw[i] = a;
        if (a > 0.18) {
          anyOpaque = true;
          _tipActivePoints.push({
            u: (x / (TIP_RES - 1)) * 2.0 - 1.0,
            v: (y / (TIP_RES - 1)) * 2.0 - 1.0,
            w: a
          });
        }
      }
    }

    if (anyOpaque) {
      // Separable 9x9 box blur computes local shape thickness/mass:
      // Solid regions (e.g. top hat) -> ~0.9-1.0; thin lines (middle face/eyes) -> ~0.2-0.45
      const rBlur = 4;
      const invSpan = 1.0 / (rBlur * 2 + 1);

      for (let y = 0; y < TIP_RES; y++) {
        const row = y * TIP_RES;
        for (let x = 0; x < TIP_RES; x++) {
          let sum = 0;
          for (let dx = -rBlur; dx <= rBlur; dx++) {
            const sx = x + dx;
            if (sx >= 0 && sx < TIP_RES) sum += _tipRaw[row + sx];
          }
          _tipBlurTmp[row + x] = sum * invSpan;
        }
      }

      let maxBump = 0.001;
      for (let y = 0; y < TIP_RES; y++) {
        for (let x = 0; x < TIP_RES; x++) {
          let sum = 0;
          for (let dy = -rBlur; dy <= rBlur; dy++) {
            const sy = y + dy;
            if (sy >= 0 && sy < TIP_RES) sum += _tipBlurTmp[sy * TIP_RES + x];
          }
          const b = sum * invSpan;
          _tipBump[y * TIP_RES + x] = b;
          if (b > maxBump) maxBump = b;
        }
      }

      const normScale = maxBump > 0.25 ? (1.0 / maxBump) : 1.0;
      for (let i = 0; i < TIP_RES * TIP_RES; i++) {
        const bNorm = Math.min(1.0, _tipBump[i] * normScale);
        _tipBump[i] = _tipRaw[i] * (0.18 + 0.82 * bNorm);
      }
      return true;
    }
  }

  // Fallback smooth domed circle tip
  for (let y = 0; y < TIP_RES; y++) {
    const v = (y / (TIP_RES - 1)) * 2.0 - 1.0;
    for (let x = 0; x < TIP_RES; x++) {
      const u = (x / (TIP_RES - 1)) * 2.0 - 1.0;
      const r2 = u * u + v * v;
      const i = y * TIP_RES + x;
      if (r2 >= 1.0) {
        _tipRaw[i] = 0;
        _tipBump[i] = 0;
      } else {
        const dome = 1.0 - r2;
        _tipRaw[i] = dome > 0.12 ? 1.0 : dome / 0.12;
        _tipBump[i] = Math.sqrt(dome);
        if (_tipRaw[i] > 0.25) {
          _tipActivePoints.push({ u, v, w: _tipRaw[i] });
        }
      }
    }
  }
  return false;
}

// ----------------------------------------------------
// SPARSE 256x256 IN-MEMORY WORLD FLUID TILE STORAGE
// ----------------------------------------------------
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

function ensureTile(engine, fb, tx, ty) {
  const key = `${tx},${ty}`;
  let tile = fb.tiles.get(key);
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
  const lastDist = new Float32Array(len);
  lastDist.fill(-1e9);

  tile = {
    tx,
    ty,
    wx,
    wy,
    pixels,
    height: new Float32Array(len),
    lastDist,
    lastCover: new Float32Array(len)
  };
  fb.tiles.set(key, tile);
  return tile;
}

function readPatchFromTiles(engine, fb, boxX, boxY, boxW, boxH) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  const totalPx = boxW * boxH;
  _patchPixels.fill(0, 0, totalPx * 4);
  _patchH.fill(0, 0, totalPx);
  _patchDist.fill(-1e9, 0, totalPx);
  _patchCover.fill(0, 0, totalPx);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = ensureTile(engine, fb, tx, ty);
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

      const tPix = tile.pixels;
      const tH = tile.height;
      const tD = tile.lastDist;
      const tC = tile.lastCover;

      for (let row = 0; row < oh; row++) {
        const sOff = (srcY + row) * TILE_SIZE + srcX;
        const dOff = (dstY + row) * boxW + dstX;
        _patchPixels.set(tPix.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        _patchH.set(tH.subarray(sOff, sOff + ow), dOff);
        _patchDist.set(tD.subarray(sOff, sOff + ow), dOff);
        _patchCover.set(tC.subarray(sOff, sOff + ow), dOff);
      }
    }
  }
}

function writePatchToTilesAndChunks(engine, fb, boxX, boxY, boxW, boxH, isShading, depthRatio, glossRatio) {
  const tx0 = Math.floor(boxX / TILE_SIZE);
  const tx1 = Math.floor((boxX + boxW - 1) / TILE_SIZE);
  const ty0 = Math.floor(boxY / TILE_SIZE);
  const ty1 = Math.floor((boxY + boxH - 1) / TILE_SIZE);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const tile = fb.tiles.get(`${tx},${ty}`);
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

      const tPix = tile.pixels;
      const tH = tile.height;
      const tD = tile.lastDist;
      const tC = tile.lastCover;

      for (let row = 0; row < oh; row++) {
        const sOff = (srcY + row) * boxW + srcX;
        const dOff = (dstY + row) * TILE_SIZE + dstX;
        tPix.set(_patchPixels.subarray(sOff * 4, (sOff + ow) * 4), dOff * 4);
        tH.set(_patchH.subarray(sOff, sOff + ow), dOff);
        tD.set(_patchDist.subarray(sOff, sOff + ow), dOff);
        tC.set(_patchCover.subarray(sOff, sOff + ow), dOff);
      }
    }
  }

  const apron = 2;
  const innerW = boxW - apron * 2;
  const innerH = boxH - apron * 2;
  if (innerW <= 0 || innerH <= 0) return;

  const srcPixels = _patchPixels;
  const dstPixels = _litImageData.data;
  const doShade = isShading && (depthRatio > 0.005 || glossRatio > 0.005);

  if (doShade) {
    const bumpScale = depthRatio * 0.36;
    const diffIntensity = depthRatio * 1.08;
    const rimMax = depthRatio * 34;
    const specScale = glossRatio;

    for (let y = apron; y < boxH - apron; y++) {
      const row = y * boxW;
      const rowUp = (y - 1) * boxW;
      const rowDn = (y + 1) * boxW;
      const dstRow = y * _scratchW;

      for (let x = apron; x < boxW - apron; x++) {
        const idx = row + x;
        const p4 = idx * 4;
        const dst4 = (dstRow + x) * 4;
        const a = srcPixels[p4 + 3];
        if (a === 0) {
          dstPixels[dst4] = 0;
          dstPixels[dst4 + 1] = 0;
          dstPixels[dst4 + 2] = 0;
          dstPixels[dst4 + 3] = 0;
          continue;
        }

        const r = srcPixels[p4];
        const g = srcPixels[p4 + 1];
        const b = srcPixels[p4 + 2];
        const h = _patchH[idx];

        if (h <= 0.004) {
          dstPixels[dst4] = r;
          dstPixels[dst4 + 1] = g;
          dstPixels[dst4 + 2] = b;
          dstPixels[dst4 + 3] = a;
          continue;
        }

        const tl = _patchH[rowUp + x - 1];
        const tc = _patchH[rowUp + x];
        const tr = _patchH[rowUp + x + 1];
        const ml = _patchH[row + x - 1];
        const mr = _patchH[row + x + 1];
        const bl = _patchH[rowDn + x - 1];
        const bc = _patchH[rowDn + x];
        const br = _patchH[rowDn + x + 1];

        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);

        const nxRaw = -gx * bumpScale;
        const nyRaw = -gy * bumpScale;
        const invLen = 1.0 / Math.sqrt(nxRaw * nxRaw + nyRaw * nyRaw + 1.0);
        const nx = nxRaw * invLen;
        const ny = nyRaw * invLen;
        const nz = invLen;

        const dDot = (nx * -0.54 + ny * -0.68 + nz * 0.496) - 0.496;
        let shade = 1.0 + dDot * diffIntensity;
        if (shade < 0.60) shade = 0.60;
        else if (shade > 1.48) shade = 1.48;

        const rimLift = dDot > 0 ? dDot * rimMax : 0;

        let spec = 0;
        if (specScale > 0.005) {
          const ndoth = nx * -0.305 + ny * -0.384 + nz * 0.871;
          if (ndoth > 0) {
            const nd2 = ndoth * ndoth;
            const nd4 = nd2 * nd2;
            const nd8 = nd4 * nd4;
            const nd24 = nd8 * nd8 * nd8;
            const hMask = h > 3.2 ? 1.0 : (h * 0.312);
            spec = (nd24 * 190.0 + nd4 * 26.0) * specScale * hMask;
          }
        }

        dstPixels[dst4] = clampByte(r * shade + rimLift + spec);
        dstPixels[dst4 + 1] = clampByte(g * shade + rimLift + spec);
        dstPixels[dst4 + 2] = clampByte(b * shade + rimLift + spec);
        dstPixels[dst4 + 3] = a;
      }
    }
  } else {
    for (let y = apron; y < boxH - apron; y++) {
      const sOff = (y * boxW + apron) * 4;
      const dOff = (y * _scratchW + apron) * 4;
      dstPixels.set(srcPixels.subarray(sOff, sOff + innerW * 4), dOff);
    }
  }

  _litCtx.putImageData(_litImageData, 0, 0, apron, apron, innerW, innerH);

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
      ctx.drawImage(_litCanvas, srcX, srcY, ow, oh, dstX, dstY, ow, oh);
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
// AIR-PAINT CURL STREAMERS (CPU IN-MEMORY RENDERING)
// ----------------------------------------------------
function spawnFluidStreamer(fb, x, y, dirX, dirY, radius, speed, baseColor, rotAngle) {
  let sx = x;
  let sy = y;
  if (_tipActivePoints.length > 0) {
    const pt = _tipActivePoints[(Math.random() * _tipActivePoints.length) | 0];
    const cosA = Math.cos(rotAngle);
    const sinA = Math.sin(rotAngle);
    const lx = pt.u * radius * (0.75 + Math.random() * 0.28);
    const ly = pt.v * radius * (0.75 + Math.random() * 0.28);
    sx = x + (lx * cosA - ly * sinA);
    sy = y + (lx * sinA + ly * cosA);
  } else {
    const angle = Math.random() * Math.PI * 2;
    const ringR = radius * (0.25 + Math.random() * 0.55);
    sx = x + Math.cos(angle) * ringR;
    sy = y + Math.sin(angle) * ringR;
  }

  const cR = fb.carriedR * 0.45 + baseColor.r * 0.55;
  const cG = fb.carriedG * 0.45 + baseColor.g * 0.55;
  const cB = fb.carriedB * 0.45 + baseColor.b * 0.55;
  const sHsl = rgbToHsl(cR, cG, cB);
  const shifted = hslToRgb(
    (sHsl.h + (Math.random() - 0.5) * 18 + 360) % 360,
    Math.max(4, Math.min(100, sHsl.s + (Math.random() - 0.5) * 10)),
    Math.max(4, Math.min(96, sHsl.l + (Math.random() - 0.5) * 10))
  );

  const kick = Math.min(3.0, speed * 0.16 + 0.5);
  fb.streamers.push({
    x: sx,
    y: sy,
    prevX: sx,
    prevY: sy,
    vx: dirX * kick + (Math.random() - 0.5) * 0.7,
    vy: dirY * kick + (Math.random() - 0.5) * 0.7,
    centerX: x,
    centerY: y,
    life: 1.0,
    decay: 0.048 + Math.random() * 0.048,
    orbitSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.45 + Math.random() * 0.75),
    widthBase: Math.max(0.65, radius * (0.018 + Math.random() * 0.024)),
    r: shifted.r,
    g: shifted.g,
    b: shifted.b,
    alpha: 0.20 + Math.random() * 0.22,
    seed: Math.random() * 50
  });

  if (fb.streamers.length > 48) {
    fb.streamers.shift();
  }
}

function drawStreamerSegToPatch(boxX, boxY, boxW, boxH, x0, y0, x1, y1, r, g, b, alpha, width, hAdd) {
  const lx0 = x0 - boxX;
  const ly0 = y0 - boxY;
  const lx1 = x1 - boxX;
  const ly1 = y1 - boxY;
  const dx = lx1 - lx0;
  const dy = ly1 - ly0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.min(14, Math.ceil(len / 0.9)));
  const dotR = Math.max(0.7, Math.min(2.8, width * 0.65));
  const dotR2 = dotR * dotR;
  const ri = Math.ceil(dotR);
  const stepAlpha = alpha / (steps > 1 ? 1.45 : 1.0);

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = lx0 + dx * t;
    const cy = ly0 + dy * t;

    const minX = Math.max(2, Math.floor(cx - ri));
    const maxX = Math.min(boxW - 3, Math.ceil(cx + ri));
    const minY = Math.max(2, Math.floor(cy - ri));
    const maxY = Math.min(boxH - 3, Math.ceil(cy + ri));

    for (let py = minY; py <= maxY; py++) {
      const pdy = py - cy;
      const row = py * boxW;
      for (let px = minX; px <= maxX; px++) {
        const pdx = px - cx;
        const d2 = pdx * pdx + pdy * pdy;
        if (d2 >= dotR2) continue;

        const falloff = 1.0 - Math.sqrt(d2) / dotR;
        const sa = stepAlpha * falloff;
        if (sa <= 0.008) continue;

        const idx = row + px;
        const p4 = idx * 4;
        const daByte = _patchPixels[p4 + 3];
        if (daByte === 0) {
          _patchPixels[p4] = r;
          _patchPixels[p4 + 1] = g;
          _patchPixels[p4 + 2] = b;
          _patchPixels[p4 + 3] = clampByte(sa * 255.0);
        } else {
          const da = daByte / 255.0;
          const invSa = 1.0 - sa;
          const outA = sa + da * invSa;
          const invOut = 1.0 / outA;
          _patchPixels[p4] = (r * sa + _patchPixels[p4] * da * invSa) * invOut;
          _patchPixels[p4 + 1] = (g * sa + _patchPixels[p4 + 1] * da * invSa) * invOut;
          _patchPixels[p4 + 2] = (b * sa + _patchPixels[p4 + 2] * da * invSa) * invOut;
          _patchPixels[p4 + 3] = clampByte(outA * 255.0);
        }
        if (hAdd > 0.005) {
          const nextH = _patchH[idx] + hAdd * falloff * 0.45;
          _patchH[idx] = nextH > 52.0 ? 52.0 : nextH;
        }
      }
    }
  }
}

// ----------------------------------------------------
// PUBLIC STROKE LIFECYCLE
// ----------------------------------------------------
export function startFluidPaintStroke(engine, worldPos) {
  cancelFluidAfterEffect(engine);

  const rawSize = worldPos.size || engine.brush.size || 35;
  const radius = Math.max(2.0, rawSize * 0.5);
  const baseColor = parseColor(worldPos.color || engine.brush.color);

  prepareTipMaps(engine);

  engine.activeFluidBrush = {
    streamers: [],
    tiles: new Map(),
    p0: { x: worldPos.x, y: worldPos.y },
    p1: null,
    midPrev: { x: worldPos.x, y: worldPos.y },
    lastPos: { x: worldPos.x, y: worldPos.y },
    prevDir: null,
    radius,
    baseColor,
    carriedR: baseColor.r,
    carriedG: baseColor.g,
    carriedB: baseColor.b,
    totalDist: 0.0,
    hasPainted: false,
    time: Math.random() * 10.0
  };

  // Pre-warm initial chunk backup lazily on pointerdown
  const cx = engine.isStatic ? 0 : Math.floor(worldPos.x / engine.chunkSize);
  const cy = engine.isStatic ? 0 : Math.floor(worldPos.y / engine.chunkSize);
  const chunk = engine._getChunk(cx, cy);
  if (chunk) {
    ensureChunkBackup(engine, chunk, cx, cy);
  }
}

/**
 * Core Continuous Self-Feeding Tip-Guided Fluid Renderer
 */
function runFluidStep(engine, fb, from, to, radius, opacity, baseColor, pressure, isTailFlush = false) {
  const rawDx = to.x - from.x;
  const rawDy = to.y - from.y;
  const dist = Math.hypot(rawDx, rawDy);
  const safeDist = dist > 0.0001 ? dist : 0.001;
  const dirX = dist > 0.0001 ? rawDx / dist : (fb.prevDir ? fb.prevDir.x : 1.0);
  const dirY = dist > 0.0001 ? rawDy / dist : (fb.prevDir ? fb.prevDir.y : 0.0);

  if (!fb.prevDir) {
    fb.prevDir = { x: dirX, y: dirY };
  }

  // Normalized tuning parameters
  const flowRatio = fluidSettings.flow / 100;
  const vortexRatio = fluidSettings.vortex / 100;
  const turbRatio = fluidSettings.turb / 100;
  const retentionRatio = fluidSettings.retention / 100;
  const pickupRatio = fluidSettings.pickup / 100;
  const depthRatio = fluidSettings.depth / 100;
  const glossRatio = fluidSettings.gloss / 100;
  const fluidityRatio = fluidSettings.fluidity / 100;
  const isShading = fluidSettings.shading;
  const brCount = Math.max(8, fluidSettings.bristles || 40);

  const effPressure = engine?.brush?.pressureEnabled ? pressure : 1.0;
  const brushFlow = engine?.brush?.flow !== undefined ? engine.brush.flow : 1.0;
  // Flow Rate (Advection) + top-bar Flow control physical paint production/thickness (strand fill & advection push),
  // while Opacity strictly controls translucency so low Flow produces thinner paint rather than washed-out opacity!
  const paintSupply = Math.max(0.01, Math.min(1.0, flowRatio * brushFlow));
  const strokeOpacity = Math.min(1.0, Math.max(0.01, (opacity || 1.0) * effPressure));

  const curlFreq = 1.0 / Math.max(12.0, radius * 0.90);
  const rotAngle = engine?.rotation || 0;
  const cosR = Math.cos(-rotAngle);
  const sinR = Math.sin(-rotAngle);
  const hasCurl = vortexRatio > 0.005 || turbRatio > 0.005;

  const prevDistTotal = fb.totalDist;
  if (!isTailFlush) {
    fb.totalDist += dist;
  }
  fb.time += 0.055 * (dist / 12.0 + 1.0);
  const curTime = fb.time;

  // Step 1: Advance Air-Paint curl streamers & spawn wisps when fluid swirl/turb is active
  let minX = Math.min(from.x, to.x) - radius * 1.25;
  let maxX = Math.max(from.x, to.x) + radius * 1.25;
  let minY = Math.min(from.y, to.y) - radius * 1.25;
  let maxY = Math.max(from.y, to.y) + radius * 1.25;

  if (!isTailFlush) {
    const fluidityDrive = (fluidityRatio * 0.45 * (0.25 + vortexRatio * 0.45 + turbRatio * 0.45) + (vortexRatio + turbRatio) * 0.22) * (0.20 + 0.80 * paintSupply);
    if (fluidityDrive > 0.14 && dist > 0.5 && (vortexRatio > 0.02 || turbRatio > 0.02)) {
      const spawnCount = Math.min(2, Math.max(1, Math.round(fluidityDrive * (dist / 16.0 + 0.5))));
      for (let k = 0; k < spawnCount; k++) {
        const ratio = k / spawnCount;
        spawnFluidStreamer(
          fb,
          from.x + rawDx * ratio,
          from.y + rawDy * ratio,
          dirX,
          dirY,
          radius,
          dist,
          baseColor,
          rotAngle
        );
      }
    }
  }

  const streamerSteps = isTailFlush ? 1 : 2;
  const streamerSegsToDraw = [];
  for (let i = fb.streamers.length - 1; i >= 0; i--) {
    const s = fb.streamers[i];
    if (s.life <= 0.01) {
      fb.streamers.splice(i, 1);
      continue;
    }

    for (let st = 0; st < streamerSteps; st++) {
      s.centerX = s.centerX * 0.92 + to.x * 0.08;
      s.centerY = s.centerY * 0.92 + to.y * 0.08;

      const rx = s.x - s.centerX;
      const ry = s.y - s.centerY;
      const cd = Math.hypot(rx, ry) || 0.01;

      const curl = hasCurl ? sampleCurl(s.x + s.seed, s.y + s.seed, curTime, curlFreq * 0.85) : { vx: 0, vy: 0 };
      const curlAmp = turbRatio * 1.45 * (0.6 + fluidityRatio * 0.8);
      const rotAmp = vortexRatio * 1.45 * s.orbitSpeed;
      const rotX = (-ry / cd) * rotAmp;
      const rotY = (rx / cd) * rotAmp;

      const pushProx = Math.max(0.0, 1.0 - cd / (radius * 2.2));
      const pushX = dirX * Math.min(4.0, dist * 0.35) * pushProx;
      const pushY = dirY * Math.min(4.0, dist * 0.35) * pushProx;

      s.vx = s.vx * 0.88 + (curl.vx * curlAmp + rotX + pushX) * 0.28;
      s.vy = s.vy * 0.88 + (curl.vy * curlAmp + rotY + pushY) * 0.28;

      const spd = Math.hypot(s.vx, s.vy);
      const maxSpd = Math.max(2.5, radius * 0.22);
      if (spd > maxSpd) {
        const inv = maxSpd / spd;
        s.vx *= inv;
        s.vy *= inv;
      }

      s.prevX = s.x;
      s.prevY = s.y;
      s.x += s.vx;
      s.y += s.vy;
      s.life -= isTailFlush ? Math.max(0.20, s.decay * 2.5) : s.decay;

      const lifeSin = Math.sin(Math.max(0, Math.min(1, s.life)) * Math.PI);
      if (lifeSin > 0.02) {
        streamerSegsToDraw.push({
          x0: s.prevX,
          y0: s.prevY,
          x1: s.x,
          y1: s.y,
          r: s.r,
          g: s.g,
          b: s.b,
          alpha: Math.min(0.65, s.alpha * lifeSin * strokeOpacity * (0.35 + 0.65 * paintSupply)),
          width: Math.max(0.55, s.widthBase * lifeSin * (0.45 + 0.55 * paintSupply))
        });
        if (s.x - 6 < minX) minX = s.x - 6;
        if (s.x + 6 > maxX) maxX = s.x + 6;
        if (s.y - 6 < minY) minY = s.y - 6;
        if (s.y + 6 > maxY) maxY = s.y + 6;
      }
      if (s.life <= 0.01) break;
    }

    if (s.life <= 0.01) {
      fb.streamers.splice(i, 1);
    }
  }

  // Adaptive physics step for large brushes (keeps >100px brushes blazing fast at 60fps!)
  const simStep = radius <= 48 ? 1 : (radius <= 115 ? 2 : 3);
  const sweepR = radius * 1.08;
  const extraPad = Math.ceil(Math.max(10, sweepR * 0.14)) + 6 + simStep;

  const boxX = Math.floor(Math.min(minX, Math.min(from.x, to.x) - sweepR) - extraPad);
  const boxY = Math.floor(Math.min(minY, Math.min(from.y, to.y) - sweepR) - extraPad);
  const boxX2 = Math.ceil(Math.max(maxX, Math.max(from.x, to.x) + sweepR) + extraPad);
  const boxY2 = Math.ceil(Math.max(maxY, Math.max(from.y, to.y) + sweepR) + extraPad);
  const boxW = Math.max(8, boxX2 - boxX);
  const boxH = Math.max(8, boxY2 - boxY);

  ensureScratchBuffers(boxW, boxH);
  readPatchFromTiles(engine, fb, boxX, boxY, boxW, boxH);

  // Step 3: Self-Feeding Wet Pigment Pickup (ignores same-pass paint so color doesn't drift across segments)
  const coverWindow = Math.max(24.0, radius * 2.40);
  if (!isTailFlush && pickupRatio > 0.005) {
    const cxLocal = Math.round(to.x) - boxX;
    const cyLocal = Math.round(to.y) - boxY;
    let pickR = 0, pickG = 0, pickB = 0, pickWeight = 0;

    const pStep = Math.max(3, (radius * 0.35) | 0);
    for (let oy = -pStep; oy <= pStep; oy += pStep) {
      const py = cyLocal + oy;
      if (py < 0 || py >= boxH) continue;
      for (let ox = -pStep; ox <= pStep; ox += pStep) {
        const px = cxLocal + ox;
        if (px < 0 || px >= boxW) continue;
        const pIdx = py * boxW + px;
        if (prevDistTotal - _patchDist[pIdx] < coverWindow * 0.65) continue;

        const p4 = pIdx * 4;
        const a = _patchPixels[p4 + 3] / 255.0;
        if (a > 0.06) {
          pickR += _patchPixels[p4] * a;
          pickG += _patchPixels[p4 + 1] * a;
          pickB += _patchPixels[p4 + 2] * a;
          pickWeight += a;
        }
      }
    }

    const mixPickup = pickupRatio * (1.0 - retentionRatio * 0.72) * 0.42;
    if (pickWeight > 0.05 && mixPickup > 0.004) {
      const invW = 1.0 / pickWeight;
      const sampleRate = Math.min(0.65, mixPickup);
      fb.carriedR = fb.carriedR * (1.0 - sampleRate) + (pickR * invW) * sampleRate;
      fb.carriedG = fb.carriedG * (1.0 - sampleRate) + (pickG * invW) * sampleRate;
      fb.carriedB = fb.carriedB * (1.0 - sampleRate) + (pickB * invW) * sampleRate;
    }

    const replenishRate = 0.08 + retentionRatio * 0.55;
    fb.carriedR = fb.carriedR * (1.0 - replenishRate) + baseColor.r * replenishRate;
    fb.carriedG = fb.carriedG * (1.0 - replenishRate) + baseColor.g * replenishRate;
    fb.carriedB = fb.carriedB * (1.0 - replenishRate) + baseColor.b * replenishRate;
  } else if (!isTailFlush) {
    fb.carriedR = baseColor.r;
    fb.carriedG = baseColor.g;
    fb.carriedB = baseColor.b;
  }

  // Step 4: Unified Swept Tip-Guided Self-Advection + Continuous Filament Texture
  if (!isTailFlush) {
    const fXLocal = from.x - boxX;
    const fYLocal = from.y - boxY;
    const invRadius = 1.0 / radius;
    const tipMaxIdx = TIP_RES - 1;
    const tipHalf = tipMaxIdx * 0.5;
    const reachR = radius * 1.04;
    const reachR2 = reachR * reachR;

    const rawMinX = Math.max(2, Math.floor(Math.min(from.x, to.x) - reachR) - boxX);
    const rawMaxX = Math.min(boxW - 3 - simStep, Math.ceil(Math.max(from.x, to.x) + reachR) - boxX);
    const rawMinY = Math.max(2, Math.floor(Math.min(from.y, to.y) - reachR) - boxY);
    const rawMaxY = Math.min(boxH - 3 - simStep, Math.ceil(Math.max(from.y, to.y) + reachR) - boxY);

    const spanX = Math.max(simStep, rawMaxX - rawMinX);
    const spanY = Math.max(simStep, rawMaxY - rawMinY);
    const gridW = Math.ceil(spanX / simStep) * simStep;
    const gridH = Math.ceil(spanY / simStep) * simStep;
    const aMinX = rawMinX;
    const aMaxX = Math.min(boxW - 3, rawMinX + gridW);
    const aMinY = rawMinY;
    const aMaxY = Math.min(boxH - 3, rawMinY + gridH);

    if (simStep > 1) {
      for (let y = aMinY; y <= aMaxY; y++) {
        const sOff = y * boxW + aMinX;
        const cnt = aMaxX - aMinX + 1;
        _patchAdvRGB.set(_patchPixels.subarray(sOff * 4, (sOff + cnt) * 4), sOff * 4);
        _patchAdvH.set(_patchH.subarray(sOff, sOff + cnt), sOff);
        _patchAdvDist.set(_patchDist.subarray(sOff, sOff + cnt), sOff);
        _patchAdvCover.set(_patchCover.subarray(sOff, sOff + cnt), sOff);
      }
    }

    const advSupply = 0.16 + 0.84 * paintSupply;
    const dragAmp = Math.min(3.5, safeDist * 0.24) * fluidityRatio * advSupply;
    const swirlAmp = vortexRatio * (0.9 + fluidityRatio * 1.8) * advSupply;
    const curlAmp = turbRatio * (0.8 + fluidityRatio * 1.6) * advSupply;
    const lagDistBase = 0.8 + fluidityRatio * 2.4;
    const advMixBase = Math.min(0.62, (0.14 + fluidityRatio * 0.36) * advSupply);
    const trailFeatherInv = 1.0 / Math.max(4.0, radius * 0.35);

    const brFreq = brCount * 0.44;
    const depthScale = depthRatio * 18.5 + glossRatio * 2.5;
    const prevDX = fb.prevDir.x;
    const prevDY = fb.prevDir.y;
    const maxBW = boxW - 1;
    const maxBH = boxH - 1;

    const paintR = fb.carriedR;
    const paintG = fb.carriedG;
    const paintB = fb.carriedB;
    const recolorRateBase = Math.min(0.95, (0.18 + retentionRatio * 0.72) * (1.0 - pickupRatio * 0.50) * (0.35 + 0.65 * paintSupply));
    const supplyThreshold = (1.0 - paintSupply) * 0.68;

    const duDs = -(dirX * cosR + dirY * sinR) * invRadius * tipHalf;
    const dvDs = -(-dirX * sinR + dirY * cosR) * invRadius * tipHalf;

    for (let y = aMinY; y <= aMaxY; y += simStep) {
      const worldY = boxY + y;
      const row = y * boxW;
      const apy = y - fYLocal;

      for (let x = aMinX; x <= aMaxX; x += simStep) {
        const worldX = boxX + x;
        const apx = x - fXLocal;

        const proj = apx * dirX + apy * dirY;
        let tSeg = proj / safeDist;
        if (tSeg < 0) tSeg = 0;
        else if (tSeg > 1) tSeg = 1;

        const cxSeg = fXLocal + dirX * safeDist * tSeg;
        const cySeg = fYLocal + dirY * safeDist * tSeg;
        const rx = x - cxSeg;
        const ry = y - cySeg;
        const d2 = rx * rx + ry * ry;
        if (d2 >= reachR2) continue;

        let sDirX = prevDX * (1.0 - tSeg) + dirX * tSeg;
        let sDirY = prevDY * (1.0 - tSeg) + dirY * tSeg;
        const sdLen = Math.hypot(sDirX, sDirY) || 1.0;
        sDirX /= sdLen;
        sDirY /= sdLen;
        const sPerpX = -sDirY;
        const sPerpY = sDirX;

        const sMin = Math.max(0.0, proj - reachR);
        const sMax = Math.min(safeDist, proj + reachR);
        const sSpan = sMax - sMin;
        const nSteps = sSpan <= 0.001 ? 1 : Math.min(14, Math.max(1, Math.ceil(sSpan / Math.max(1.5, radius * 0.07))));
        const sStep = sSpan / nSteps;

        const dtx0 = worldX - (from.x + dirX * sMin);
        const dty0 = worldY - (from.y + dirY * sMin);
        let fxT = ((dtx0 * cosR - dty0 * sinR) * invRadius + 1.0) * tipHalf;
        let fyT = ((dtx0 * sinR + dty0 * cosR) * invRadius + 1.0) * tipHalf;
        const stepFx = duDs * sStep;
        const stepFy = dvDs * sStep;

        let maxTipA = 0.0;
        let maxTipBump = 0.0;

        for (let k = 0; k <= nSteps; k++) {
          if (fxT >= -0.5 && fxT <= tipMaxIdx + 0.5 && fyT >= -0.5 && fyT <= tipMaxIdx + 0.5) {
            const tx = fxT < 0 ? 0 : (fxT >= tipMaxIdx ? tipMaxIdx : ((fxT + 0.5) | 0));
            const ty = fyT < 0 ? 0 : (fyT >= tipMaxIdx ? tipMaxIdx : ((fyT + 0.5) | 0));
            const ti = ty * TIP_RES + tx;
            const tA = _tipRaw[ti];
            if (tA > 0.01) {
              const tB = _tipBump[ti];
              if (tA > maxTipA) maxTipA = tA;
              if (tB > maxTipBump) maxTipBump = tB;
            }
          }
          fxT += stepFx;
          fyT += stepFy;
        }

        const dstIdx = row + x;
        const dst4 = dstIdx * 4;
        const curA = _patchPixels[dst4 + 3];

        if (maxTipA <= 0.008 && curA === 0) {
          _patchAdvRGB[dst4 + 3] = 0;
          _patchAdvH[dstIdx] = 0;
          continue;
        }

        const wNorm = 1.0 - d2 / reachR2;
        const w = wNorm * wNorm;
        const invR = d2 > 0.25 ? (1.0 / Math.sqrt(d2)) : 0.0;

        let curlVx = 0.0;
        let curlVy = 0.0;
        if (hasCurl) {
          const curl = sampleCurl(worldX, worldY, curTime, curlFreq);
          curlVx = curl.vx;
          curlVy = curl.vy;
        }

        const trailFade = proj >= 0.0 ? 1.0 : Math.max(0.0, 1.0 + proj * trailFeatherInv);

        const activeTipDrive = 0.25 + 0.75 * maxTipA;
        let vx = sDirX * dragAmp * activeTipDrive + (-ry * invR) * swirlAmp * w + curlVx * curlAmp * w;
        let vy = sDirY * dragAmp * activeTipDrive + (rx * invR) * swirlAmp * w + curlVy * curlAmp * w;
        const vLen = Math.hypot(vx, vy);
        if (vLen > 4.5) {
          const vs = 4.5 / vLen;
          vx *= vs;
          vy *= vs;
        }

        const m = advMixBase * w * trailFade;
        let wetA = curA;
        let wetR = _patchPixels[dst4];
        let wetG = _patchPixels[dst4 + 1];
        let wetB = _patchPixels[dst4 + 2];
        let wetH = _patchH[dstIdx];

        if (m > 0.005) {
          const t1x = x - vx * w;
          const t1y = y - vy * w;
          const t2x = x - sDirX * lagDistBase * w;
          const t2y = y - sDirY * lagDistBase * w;

          let sumPR = 0, sumPG = 0, sumPB = 0, sumA = 0, sumH = 0;
          for (let tp = 0; tp < 2; tp++) {
            let sx = tp === 0 ? t1x : t2x;
            let sy = tp === 0 ? t1y : t2y;
            const wt = tp === 0 ? 0.64 : 0.36;

            if (sx < 0) sx = 0;
            else if (sx >= maxBW) sx = maxBW - 0.001;
            if (sy < 0) sy = 0;
            else if (sy >= maxBH) sy = maxBH - 0.001;

            const x0 = sx | 0;
            const y0 = sy | 0;
            const fx = sx - x0;
            const fy = sy - y0;
            const w00 = (1.0 - fx) * (1.0 - fy);
            const w10 = fx * (1.0 - fy);
            const w01 = (1.0 - fx) * fy;
            const w11 = fx * fy;

            const i00 = (y0 * boxW + x0) * 4;
            const i10 = i00 + 4;
            const i01 = i00 + boxW * 4;
            const i11 = i01 + 4;

            const a00 = _patchPixels[i00 + 3];
            const a10 = _patchPixels[i10 + 3];
            const a01 = _patchPixels[i01 + 3];
            const a11 = _patchPixels[i11 + 3];
            const ta = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

            if (ta > 0.1) {
              sumPR += (_patchPixels[i00] * a00 * w00 + _patchPixels[i10] * a10 * w10 + _patchPixels[i01] * a01 * w01 + _patchPixels[i11] * a11 * w11) * wt;
              sumPG += (_patchPixels[i00 + 1] * a00 * w00 + _patchPixels[i10 + 1] * a10 * w10 + _patchPixels[i01 + 1] * a01 * w01 + _patchPixels[i11 + 1] * a11 * w11) * wt;
              sumPB += (_patchPixels[i00 + 2] * a00 * w00 + _patchPixels[i10 + 2] * a10 * w10 + _patchPixels[i01 + 2] * a01 * w01 + _patchPixels[i11 + 2] * a11 * w11) * wt;
              sumA += ta * wt;
            }

            const hIdx = y0 * boxW + x0;
            sumH += (_patchH[hIdx] * w00 + _patchH[hIdx + 1] * w10 + _patchH[hIdx + boxW] * w01 + _patchH[hIdx + boxW + 1] * w11) * wt;
          }

          wetA = curA * (1.0 - m) + sumA * m;
          wetH = wetH * (1.0 - m) + sumH * m;
          if (wetA > 0.4) {
            const ca = curA * (1.0 - m);
            const invWet = 1.0 / (ca + sumA * m);
            wetR = (wetR * ca + sumPR * m) * invWet;
            wetG = (wetG * ca + sumPG * m) * invWet;
            wetB = (wetB * ca + sumPB * m) * invWet;
          }
        }

        // Bristle texture guided by Brush Tip Bump Map & Flow Rate (amount of paint produced):
        // Low Flow thins bristle strands cleanly instead of diluting color into pale opacity!
        if (maxTipA > 0.008) {
          const crossNorm = (rx * sPerpX + ry * sPerpY) * invRadius;
          const phaseWarp = vortexRatio * (0.75 + turbRatio * 0.85) * (curlVx * 3.6 + curlVy * 1.9);
          const ridgePhase = crossNorm * brFreq + phaseWarp;
          const wave = 0.54 + 0.30 * Math.sin(ridgePhase) + 0.16 * Math.sin(ridgePhase * 2.13 + phaseWarp * 0.6);

          const ridgePronounce = (0.24 + 0.76 * maxTipBump) * (0.40 + 0.60 * (1.0 - fluidityRatio * 0.50));
          const ridgeFactor = 1.0 - ridgePronounce * (1.0 - wave);

          let strandCoverage = maxTipA;
          if (paintSupply < 0.99) {
            const supplySignal = wave * (0.66 + 0.34 * maxTipBump) * Math.min(1.0, maxTipA * 1.35);
            const softBand = 0.11 + 0.11 * (1.0 - maxTipBump);
            const normMask = (supplySignal - supplyThreshold) / softBand;
            const clamped = normMask < 0.0 ? 0.0 : (normMask > 1.0 ? 1.0 : normMask);
            const smoothStrand = clamped * clamped * (3.0 - 2.0 * clamped);
            strandCoverage = maxTipA * smoothStrand;
          }

          const localDist = prevDistTotal + safeDist * tSeg;
          const prevDist = _patchDist[dstIdx];
          const prevCov = (localDist - prevDist >= 0 && localDist - prevDist < coverWindow)
            ? _patchCover[dstIdx]
            : 0.0;

          const targetBrushAlpha = Math.min(1.0, strandCoverage * strokeOpacity);
          const stepA = targetBrushAlpha > prevCov && prevCov < 0.99
            ? (targetBrushAlpha - prevCov) / (1.0 - prevCov)
            : 0.0;

          if (targetBrushAlpha > 0.004) {
            const wetA01 = wetA / 255.0;
            let outA01 = Math.min(1.0, wetA01 + stepA * (1.0 - wetA01));
            if (outA01 < targetBrushAlpha) {
              outA01 = targetBrushAlpha;
            }

            const toneShift = (wave - 0.54) * (5.0 + 11.0 * maxTipBump);
            const fR = clampByte(paintR + toneShift);
            const fG = clampByte(paintG + toneShift);
            const fB = clampByte(paintB + toneShift);

            if (wetA01 <= 0.01) {
              wetR = fR;
              wetG = fG;
              wetB = fB;
              wetA = outA01 * 255.0;
            } else {
              const colorFeed = Math.max(stepA, strandCoverage * recolorRateBase * (0.35 + 0.65 * maxTipBump) * trailFade);
              const blendAmt = Math.min(1.0, colorFeed / Math.max(0.05, outA01));
              wetR = wetR * (1.0 - blendAmt) + fR * blendAmt;
              wetG = wetG * (1.0 - blendAmt) + fG * blendAmt;
              wetB = wetB * (1.0 - blendAmt) + fB * blendAmt;
              wetA = outA01 * 255.0;
            }

            if (depthScale > 0.01) {
              const supplyH = 0.22 + 0.78 * paintSupply;
              const targetH = strandCoverage * (0.14 + 0.86 * maxTipBump) * (0.30 + 0.70 * ridgeFactor) * depthScale * supplyH;
              if (targetH > wetH) {
                wetH = targetH;
              }
              if (wetH > 52.0) wetH = 52.0;
            }

            _patchAdvDist[dstIdx] = localDist;
            _patchAdvCover[dstIdx] = targetBrushAlpha > prevCov ? targetBrushAlpha : prevCov;
          } else {
            _patchAdvDist[dstIdx] = prevDist;
            _patchAdvCover[dstIdx] = prevCov;
          }
        } else {
          _patchAdvDist[dstIdx] = _patchDist[dstIdx];
          _patchAdvCover[dstIdx] = _patchCover[dstIdx];
        }

        if (wetA < 0.5) {
          _patchAdvRGB[dst4 + 3] = 0;
          _patchAdvH[dstIdx] = 0;
        } else {
          _patchAdvRGB[dst4] = clampByte(wetR);
          _patchAdvRGB[dst4 + 1] = clampByte(wetG);
          _patchAdvRGB[dst4 + 2] = clampByte(wetB);
          _patchAdvRGB[dst4 + 3] = clampByte(wetA);
          _patchAdvH[dstIdx] = wetH;
        }
      }
    }

    // Reconstruct intermediate pixels smoothly when simStep > 1 (brush size > 96)
    if (simStep > 1) {
      const invStep = 1.0 / simStep;
      for (let by = aMinY; by <= aMaxY - simStep; by += simStep) {
        const yEnd = Math.min(aMaxY, by + simStep);
        for (let bx = aMinX; bx <= aMaxX - simStep; bx += simStep) {
          const xEnd = Math.min(aMaxX, bx + simStep);
          const i00 = by * boxW + bx;
          const i10 = by * boxW + (bx + simStep);
          const i01 = (by + simStep) * boxW + bx;
          const i11 = (by + simStep) * boxW + (bx + simStep);

          const a00 = _patchAdvRGB[i00 * 4 + 3];
          const a10 = _patchAdvRGB[i10 * 4 + 3];
          const a01 = _patchAdvRGB[i01 * 4 + 3];
          const a11 = _patchAdvRGB[i11 * 4 + 3];
          if (a00 === 0 && a10 === 0 && a01 === 0 && a11 === 0) continue;

          for (let py = by; py <= yEnd; py++) {
            const fy = (py - by) * invStep;
            const pRow = py * boxW;
            for (let px = bx; px <= xEnd; px++) {
              if (py === by && px === bx) continue;
              if (py === by && px === bx + simStep) continue;
              if (py === by + simStep && px === bx) continue;
              if (py === by + simStep && px === bx + simStep) continue;

              const fx = (px - bx) * invStep;
              const w00 = (1.0 - fx) * (1.0 - fy);
              const w10 = fx * (1.0 - fy);
              const w01 = (1.0 - fx) * fy;
              const w11 = fx * fy;

              const outA = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
              const idx = pRow + px;
              const p4 = idx * 4;
              if (outA < 0.5) {
                _patchAdvRGB[p4 + 3] = 0;
                _patchAdvH[idx] = 0;
              } else {
                const invA = 1.0 / outA;
                _patchAdvRGB[p4] = (_patchAdvRGB[i00 * 4] * a00 * w00 + _patchAdvRGB[i10 * 4] * a10 * w10 + _patchAdvRGB[i01 * 4] * a01 * w01 + _patchAdvRGB[i11 * 4] * a11 * w11) * invA;
                _patchAdvRGB[p4 + 1] = (_patchAdvRGB[i00 * 4 + 1] * a00 * w00 + _patchAdvRGB[i10 * 4 + 1] * a10 * w10 + _patchAdvRGB[i01 * 4 + 1] * a01 * w01 + _patchAdvRGB[i11 * 4 + 1] * a11 * w11) * invA;
                _patchAdvRGB[p4 + 2] = (_patchAdvRGB[i00 * 4 + 2] * a00 * w00 + _patchAdvRGB[i10 * 4 + 2] * a10 * w10 + _patchAdvRGB[i01 * 4 + 2] * a01 * w01 + _patchAdvRGB[i11 * 4 + 2] * a11 * w11) * invA;
                _patchAdvRGB[p4 + 3] = clampByte(outA);
                _patchAdvH[idx] = _patchAdvH[i00] * w00 + _patchAdvH[i10] * w10 + _patchAdvH[i01] * w01 + _patchAdvH[i11] * w11;
                _patchAdvDist[idx] = Math.max(_patchAdvDist[i00], _patchAdvDist[i10], _patchAdvDist[i01], _patchAdvDist[i11]);
                _patchAdvCover[idx] = _patchAdvCover[i00] * w00 + _patchAdvCover[i10] * w10 + _patchAdvCover[i01] * w01 + _patchAdvCover[i11] * w11;
              }
            }
          }
        }
      }
    }

    // Commit swept capsule update into _patchPixels, _patchH, _patchDist, _patchCover
    for (let y = aMinY; y <= aMaxY; y++) {
      const apy = y - fYLocal;
      const row = y * boxW;
      for (let x = aMinX; x <= aMaxX; x++) {
        const apx = x - fXLocal;
        let tSeg = (apx * dirX + apy * dirY) / safeDist;
        if (tSeg < 0) tSeg = 0;
        else if (tSeg > 1) tSeg = 1;
        const rx = x - (fXLocal + dirX * safeDist * tSeg);
        const ry = y - (fYLocal + dirY * safeDist * tSeg);
        if (rx * rx + ry * ry >= reachR2) continue;

        const idx = row + x;
        const p4 = idx * 4;
        _patchPixels[p4] = _patchAdvRGB[p4];
        _patchPixels[p4 + 1] = _patchAdvRGB[p4 + 1];
        _patchPixels[p4 + 2] = _patchAdvRGB[p4 + 2];
        _patchPixels[p4 + 3] = _patchAdvRGB[p4 + 3];
        _patchH[idx] = _patchAdvH[idx];
        _patchDist[idx] = _patchAdvDist[idx];
        _patchCover[idx] = _patchAdvCover[idx];
      }
    }

    fb.prevDir = { x: dirX, y: dirY };
  }

  // Step 5: Composite silky Air-Paint curl streamers directly in memory
  const streamerHScale = depthRatio * 10.0 + glossRatio * 2.0;
  for (let i = 0; i < streamerSegsToDraw.length; i++) {
    const sg = streamerSegsToDraw[i];
    drawStreamerSegToPatch(
      boxX, boxY, boxW, boxH,
      sg.x0, sg.y0, sg.x1, sg.y1,
      sg.r, sg.g, sg.b, sg.alpha, sg.width,
      streamerHScale * sg.alpha
    );
  }

  // Step 6: Persist tiles, run Sobel 3D impasto shader on writable interior, and update GPU chunks
  writePatchToTilesAndChunks(engine, fb, boxX, boxY, boxW, boxH, isShading, depthRatio, glossRatio);

  const commitPad = 2;
  engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, boxX + commitPad);
  engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, boxX + boxW - commitPad);
  engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, boxY + commitPad);
  engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, boxY + boxH - commitPad);
}

/**
 * Evaluates smooth quadratic Bezier arc subdivision between stroke points so sharp corners
 * turn gradually without pie-slice wedges or angular polygon stitches.
 */
function runSmoothedBezier(engine, fb, a, ctrl, b, radius, opacity, baseColor, pressure) {
  const dx1 = ctrl.x - a.x;
  const dy1 = ctrl.y - a.y;
  const dx2 = b.x - ctrl.x;
  const dy2 = b.y - ctrl.y;
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);

  let subSteps = 1;
  if (len1 > 0.5 && len2 > 0.5) {
    const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    const clampedDot = dot < -1 ? -1 : (dot > 1 ? 1 : dot);
    const angle = Math.acos(clampedDot);
    if (angle > 0.14) {
      subSteps = Math.min(4, Math.max(2, Math.ceil(angle / 0.16)));
    }
  }

  let prevPt = a;
  for (let i = 1; i <= subSteps; i++) {
    const t = i / subSteps;
    const invT = 1.0 - t;
    const qx = invT * invT * a.x + 2.0 * invT * t * ctrl.x + t * t * b.x;
    const qy = invT * invT * a.y + 2.0 * invT * t * ctrl.y + t * t * b.y;
    const nextPt = i === subSteps ? b : { x: qx, y: qy };
    runFluidStep(engine, fb, prevPt, nextPt, radius, opacity, baseColor, pressure, false);
    prevPt = nextPt;
  }
}

/**
 * Continuous Fluid Paint Move Step
 */
export function paintFluidOnChunks(engine, from, to, size, opacity, color, pressure = 1.0, currentTime = performance.now()) {
  if (engine.perfMonitor) engine.perfMonitor.markPhase('fluid_step');
  if (!engine.activeFluidBrush) {
    startFluidPaintStroke(engine, from);
  }

  const fb = engine.activeFluidBrush;
  fb.hasPainted = true;

  const rawDx = to.x - from.x;
  const rawDy = to.y - from.y;
  const dist = Math.hypot(rawDx, rawDy) || 0.001;

  const radius = Math.max(2.0, (size || engine.brush.size || 35) * 0.5);
  fb.radius = radius;
  const baseColor = parseColor(color || engine.brush.color);
  fb.baseColor = baseColor;

  if (dist > 500.0) {
    fb.p0 = { x: to.x, y: to.y };
    fb.p1 = null;
    fb.midPrev = { x: to.x, y: to.y };
    fb.lastPos = { x: to.x, y: to.y };
    fb.prevDir = null;
    return;
  }

  if (!fb.p1) {
    const mid = { x: (fb.p0.x + to.x) * 0.5, y: (fb.p0.y + to.y) * 0.5 };
    runFluidStep(engine, fb, fb.p0, mid, radius, opacity, baseColor, pressure, false);
    fb.p1 = { x: to.x, y: to.y };
    fb.midPrev = mid;
  } else {
    const midNext = { x: (fb.p1.x + to.x) * 0.5, y: (fb.p1.y + to.y) * 0.5 };
    runSmoothedBezier(engine, fb, fb.midPrev, fb.p1, midNext, radius, opacity, baseColor, pressure);
    fb.p1 = { x: to.x, y: to.y };
    fb.midPrev = midNext;
  }

  fb.lastPos = { x: to.x, y: to.y };
  fb.lastOpacity = opacity;
  fb.lastPressure = pressure;
}

/**
 * Finalizes fluid paint stroke on pointerup.
 */
export function endFluidPaintStroke(engine) {
  if (engine.activeFluidBrush) {
    const fb = engine.activeFluidBrush;
    const p = fb.lastPos;
    const op = fb.lastOpacity ?? engine.brush.opacity ?? 1.0;
    const pr = fb.lastPressure ?? 1.0;

    if (!fb.hasPainted) {
      // Single click / tap: stamp rich tip-shaped fluid dab
      const dabAngle = Math.random() * Math.PI * 2;
      const dabDist = Math.max(0.8, Math.min(2.5, fb.radius * 0.06));
      const dabTo = { x: p.x + Math.cos(dabAngle) * dabDist, y: p.y + Math.sin(dabAngle) * dabDist };
      runFluidStep(engine, fb, p, dabTo, fb.radius, op, fb.baseColor, 1.0, false);
    } else if (fb.p1 && fb.midPrev) {
      // Flush final half-segment smoothly to the exact pointerup coordinate
      runFluidStep(engine, fb, fb.midPrev, fb.p1, fb.radius, op, fb.baseColor, pr, false);
    }

    // Taper remaining Air-Paint curl streamers synchronously so wisps finish smoothly
    for (let t = 0; t < 4 && fb.streamers.length > 0; t++) {
      runFluidStep(engine, fb, fb.lastPos, fb.lastPos, fb.radius, op, fb.baseColor, 1.0, true);
    }

    fb.tiles.clear();
    fb.streamers = [];
    engine.activeFluidBrush = null;
  }
}

/**
 * Cancels active fluid stroke state.
 */
export function cancelFluidAfterEffect(engine) {
  if (!engine) return;
  if (engine.activeFluidBrush) {
    if (engine.activeFluidBrush.tiles) engine.activeFluidBrush.tiles.clear();
    engine.activeFluidBrush = null;
  }
}

export let fluidEngineMode = 'oil';
export function setFluidEngineMode(mode) {
  fluidEngineMode = mode;
}
