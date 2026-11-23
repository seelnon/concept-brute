/**
 * Physical Canvas Surface Engine & Multi-Pass Procedural + Image-Extracted Heightmap Generator
 *
 * Pre-bakes a seamless 512x512 RGBA8 surface pair ONCE on preset/image change:
 *  - colorRgba: [R, G, B, 255] shaded & speckled albedo for background compositing (gl.REPEAT)
 *  - mapRgba:   [R = height 0..255, G = Sobel dH/dx, B = Sobel dH/dy, A = cavity/crack mask]
 *
 * Stroke runtime overhead on GPU shaders: 1 single filtered texture() lookup (~0ms CPU).
 */

export const SURFACE_TILE_RES = 512;

export const SURFACE_PRESETS = {
  none: {
    id: 'none',
    label: 'FLAT (OFF)',
    hint: 'Direct 1:1 stroke response with zero surface resistance.',
    slip: 0.50,
    resist: 0.00,
    channel: 0.00,
    relief: 0.00,
    absorb: 0.00,
    sizing: 0.72,
    seepRate: 0.45,
    coarseness: 0.15,
    capillarity: 0.35,
    sootSnag: 0.25,
    backrun: 0.55,
    scale: 320,
    bgOpacity: 0.00,
    biomeMix: 0.00,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [255, 255, 255]
  },
  raw_xuan: {
    id: 'raw_xuan',
    label: 'RAW XUAN (SHENG)',
    hint: 'Unsized Xuan paper: rapid nijimi feathering, long bast fibers & rich dry splits.',
    slip: 0.22,
    resist: 0.52,
    channel: 0.48,
    relief: 0.54,
    absorb: 0.92,
    sizing: 0.18,
    seepRate: 1.00,
    coarseness: 0.52,
    capillarity: 0.76,
    sootSnag: 0.62,
    backrun: 0.66,
    scale: 340,
    bgOpacity: 0.66,
    biomeMix: 0.88,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [245, 240, 228]
  },
  half_xuan: {
    id: 'half_xuan',
    label: 'HALF-SIZED XUAN',
    hint: 'Ban Sheng Shu: balanced calligraphy ink bleed, luminous wash gradients & kasure.',
    slip: 0.34,
    resist: 0.42,
    channel: 0.38,
    relief: 0.44,
    absorb: 0.68,
    sizing: 0.52,
    seepRate: 0.72,
    coarseness: 0.42,
    capillarity: 0.58,
    sootSnag: 0.50,
    backrun: 0.72,
    scale: 320,
    bgOpacity: 0.62,
    biomeMix: 0.88,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [246, 242, 232]
  },
  sized_xuan: {
    id: 'sized_xuan',
    label: 'SIZED XUAN (SHU)',
    hint: 'Alum-sized silk Xuan: crisp brushwork, slow diffusion & pronounced backrun rims.',
    slip: 0.64,
    resist: 0.26,
    channel: 0.20,
    relief: 0.28,
    absorb: 0.24,
    sizing: 0.88,
    seepRate: 0.28,
    coarseness: 0.25,
    capillarity: 0.26,
    sootSnag: 0.28,
    backrun: 0.86,
    scale: 300,
    bgOpacity: 0.56,
    biomeMix: 0.88,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [248, 245, 238]
  },
  hemp: {
    id: 'hemp',
    label: 'MULBERRY / HEMP (MA ZHI)',
    hint: 'Coarse handmade bast fibers: dramatic tooth catching, heavy soot snagging & dry-brush splits.',
    slip: 0.16,
    resist: 0.80,
    channel: 0.68,
    relief: 0.82,
    absorb: 0.86,
    sizing: 0.28,
    seepRate: 0.90,
    coarseness: 0.85,
    capillarity: 0.72,
    sootSnag: 0.84,
    backrun: 0.60,
    scale: 380,
    bgOpacity: 0.72,
    biomeMix: 0.90,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [236, 228, 210]
  },
  paper: {
    id: 'paper',
    label: 'COLD-PRESS PAPER',
    hint: 'Absorbent cold-press peaks catch light strokes & granulate.',
    slip: 0.24,
    resist: 0.56,
    channel: 0.22,
    relief: 0.58,
    absorb: 0.74,
    sizing: 0.38,
    seepRate: 0.78,
    coarseness: 0.58,
    capillarity: 0.60,
    sootSnag: 0.64,
    backrun: 0.70,
    scale: 340,
    bgOpacity: 0.62,
    biomeMix: 0.88,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [242, 236, 224]
  },
  canvas: {
    id: 'canvas',
    label: 'WOVEN LINEN CANVAS',
    hint: 'Woven linen crown grabs thick paint; press harder to fill weave.',
    slip: 0.28,
    resist: 0.74,
    channel: 0.50,
    relief: 0.70,
    absorb: 0.54,
    sizing: 0.62,
    seepRate: 0.50,
    coarseness: 0.72,
    capillarity: 0.48,
    sootSnag: 0.74,
    backrun: 0.54,
    scale: 240,
    bgOpacity: 0.68,
    biomeMix: 0.75,
    allowRotate: 0.0,
    scaleSpread: 0.06,
    tint: [243, 238, 226]
  },
  wood: {
    id: 'wood',
    label: 'OAK WOOD GRAIN',
    hint: 'Strong directional oak grain channels paint & water along vessels.',
    slip: 0.52,
    resist: 0.62,
    channel: 0.88,
    relief: 0.66,
    absorb: 0.34,
    sizing: 0.70,
    seepRate: 0.42,
    coarseness: 0.66,
    capillarity: 0.52,
    sootSnag: 0.60,
    backrun: 0.58,
    scale: 420,
    bgOpacity: 0.72,
    biomeMix: 0.82,
    allowRotate: 0.0,
    scaleSpread: 0.22,
    tint: [222, 195, 160]
  },
  stone: {
    id: 'stone',
    label: 'SLATE / STONE',
    hint: 'High relief slate with deep fractures that break dry brushstrokes.',
    slip: 0.16,
    resist: 0.86,
    channel: 0.66,
    relief: 0.88,
    absorb: 0.60,
    sizing: 0.58,
    seepRate: 0.56,
    coarseness: 0.86,
    capillarity: 0.46,
    sootSnag: 0.82,
    backrun: 0.74,
    scale: 380,
    bgOpacity: 0.74,
    biomeMix: 0.88,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [212, 210, 204]
  },
  cloth: {
    id: 'cloth',
    label: 'TWILL CLOTH',
    hint: 'Diagonal twill threads wick wet pigment outward into fibers.',
    slip: 0.20,
    resist: 0.78,
    channel: 0.58,
    relief: 0.76,
    absorb: 0.85,
    sizing: 0.24,
    seepRate: 0.92,
    coarseness: 0.76,
    capillarity: 0.82,
    sootSnag: 0.72,
    backrun: 0.50,
    scale: 210,
    bgOpacity: 0.70,
    biomeMix: 0.75,
    allowRotate: 0.0,
    scaleSpread: 0.06,
    tint: [232, 226, 214]
  },
  ceramic: {
    id: 'ceramic',
    label: 'GLAZED CERAMIC',
    hint: 'Glazed slick tiles let paint glide fast; hairline crazing catches edges.',
    slip: 0.86,
    resist: 0.16,
    channel: 0.18,
    relief: 0.24,
    absorb: 0.08,
    sizing: 0.94,
    seepRate: 0.18,
    coarseness: 0.20,
    capillarity: 0.16,
    sootSnag: 0.18,
    backrun: 0.82,
    scale: 360,
    bgOpacity: 0.58,
    biomeMix: 0.85,
    allowRotate: 1.0,
    scaleSpread: 0.85,
    tint: [245, 246, 242]
  },
  glass: {
    id: 'glass',
    label: 'SLICK GLASS',
    hint: 'Ultra-slippery non-absorbent surface: paint hydroplanes & smears long.',
    slip: 0.96,
    resist: 0.04,
    channel: 0.02,
    relief: 0.06,
    absorb: 0.02,
    sizing: 0.98,
    seepRate: 0.08,
    coarseness: 0.06,
    capillarity: 0.08,
    sootSnag: 0.06,
    backrun: 0.68,
    scale: 400,
    bgOpacity: 0.44,
    biomeMix: 0.85,
    allowRotate: 1.0,
    scaleSpread: 1.0,
    tint: [234, 243, 248]
  },
  custom: {
    id: 'custom',
    label: 'CUSTOM UPLOADED IMAGE',
    hint: 'Auto-extracted height, slope & crevices from your uploaded photo.',
    slip: 0.32,
    resist: 0.62,
    channel: 0.42,
    relief: 0.66,
    absorb: 0.60,
    sizing: 0.46,
    seepRate: 0.68,
    coarseness: 0.64,
    capillarity: 0.58,
    sootSnag: 0.62,
    backrun: 0.66,
    scale: 380,
    bgOpacity: 0.78,
    biomeMix: 0.78,
    allowRotate: 0.0,
    scaleSpread: 0.16,
    tint: [255, 255, 255]
  }
};

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function clampByte(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5) | 0);
}

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3.0 - 2.0 * t);
}

// Fast 32-bit integer spatial hash [0..1) using native Math.imul
function hash2i(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) * 2.3283064365386963e-10;
}

function hash1(i, seed) {
  let h = (Math.imul(i, 1597334677) + Math.imul(seed, 3812015801)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = h ^ (h >>> 13);
  return (h >>> 0) * 2.3283064365386963e-10;
}

/**
 * Toroidal periodic value noise on [0..1) domain — repeats seamlessly at period boundary.
 */
function torusNoise(u, v, period, seed) {
  const px = (u + 16.0) * period;
  const py = (v + 16.0) * period;
  const x0 = px | 0;
  const y0 = py | 0;
  const fx = px - x0;
  const fy = py - y0;
  const sx = fx * fx * (3.0 - 2.0 * fx);
  const sy = fy * fy * (3.0 - 2.0 * fy);

  const ix0 = x0 % period;
  const iy0 = y0 % period;
  const ix1 = ix0 + 1 >= period ? 0 : ix0 + 1;
  const iy1 = iy0 + 1 >= period ? 0 : iy0 + 1;

  const n00 = hash2i(ix0, iy0, seed);
  const n10 = hash2i(ix1, iy0, seed);
  const n01 = hash2i(ix0, iy1, seed);
  const n11 = hash2i(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/**
 * Independent anisotropic X/Y toroidal periodic noise on [0..1) domain.
 */
function torusNoise2(u, v, perX, perY, seed) {
  const px = (u + 16.0) * perX;
  const py = (v + 16.0) * perY;
  const x0 = px | 0;
  const y0 = py | 0;
  const fx = px - x0;
  const fy = py - y0;
  const sx = fx * fx * (3.0 - 2.0 * fx);
  const sy = fy * fy * (3.0 - 2.0 * fy);

  const ix0 = x0 % perX;
  const iy0 = y0 % perY;
  const ix1 = ix0 + 1 >= perX ? 0 : ix0 + 1;
  const iy1 = iy0 + 1 >= perY ? 0 : iy0 + 1;

  const n00 = hash2i(ix0, iy0, seed);
  const n10 = hash2i(ix1, iy0, seed);
  const n01 = hash2i(ix0, iy1, seed);
  const n11 = hash2i(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/**
 * Integer-rotated anisotropic billow ridge bast fiber layer (100% seamless on [0..1)^2).
 * Produces sinuous crisscrossing bast strands like sumi-test when given domain-warped (wu, wv).
 */
function torusBastFiber(wu, wv, kx, ky, perLong, perAcross, ridgePow, seed) {
  const s = kx * wu + ky * wv;
  const t = -ky * wu + kx * wv;
  const n = torusNoise2(s, t, perLong, perAcross, seed);
  const ridge = 1.0 - Math.abs(n * 2.0 - 1.0);
  return ridge * ridge;
}

function torusFbm(u, v, basePeriod, octaves, seed) {
  let sum = 0.0;
  let amp = 0.5;
  let norm = 0.0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * torusNoise(u, v, p, seed + o * 97);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / (norm || 1.0);
}

/**
 * Toroidal Voronoi / Worley distance (returns f1 and f2-f1 edge metric) for stone & ceramic craquelure.
 */
function buildTorusVoronoiPoints(cells, seed) {
  const ptsX = new Float32Array(cells * cells);
  const ptsY = new Float32Array(cells * cells);
  const ptsTone = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const idx = cy * cells + cx;
      ptsX[idx] = cx + 0.14 + hash2i(cx, cy, seed) * 0.72;
      ptsY[idx] = cy + 0.14 + hash2i(cx, cy, seed + 53) * 0.72;
      ptsTone[idx] = hash2i(cx, cy, seed + 131);
    }
  }
  return { cells, ptsX, ptsY, ptsTone };
}

function sampleTorusVoronoi(grid, u, v) {
  const c = grid.cells;
  const px = u * c;
  const py = v * c;
  const gx = Math.floor(px);
  const gy = Math.floor(py);

  let d1 = 1e9;
  let d2 = 1e9;
  let cellTone = 0.5;

  for (let oy = -1; oy <= 1; oy++) {
    const ny = ((gy + oy) % c + c) % c;
    const shiftY = (gy + oy) - ny;
    for (let ox = -1; ox <= 1; ox++) {
      const nx = ((gx + ox) % c + c) % c;
      const shiftX = (gx + ox) - nx;
      const idx = ny * c + nx;
      const dx = (grid.ptsX[idx] + shiftX) - px;
      const dy = (grid.ptsY[idx] + shiftY) - py;
      const dist = Math.hypot(dx, dy);
      if (dist < d1) {
        d2 = d1;
        d1 = dist;
        cellTone = grid.ptsTone[idx];
      } else if (dist < d2) {
        d2 = dist;
      }
    }
  }
  return { f1: d1, edge: d2 - d1, tone: cellTone };
}

/**
 * Fast O(W*H) toroidal separable box blur on Float32Array.
 */
function boxBlurToroidal(src, dst, tmp, w, h, radius) {
  if (radius <= 0) {
    dst.set(src);
    return;
  }
  const win = radius * 2 + 1;
  const invW = 1.0 / win;

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0.0;
    for (let dx = -radius; dx <= radius; dx++) {
      sum += src[row + (((dx % w) + w) % w)];
    }
    tmp[row] = sum * invW;
    for (let x = 1; x < w; x++) {
      const addX = (x + radius) % w;
      const remX = ((x - radius - 1) % w + w) % w;
      sum += src[row + addX] - src[row + remX];
      tmp[row + x] = sum * invW;
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0.0;
    for (let dy = -radius; dy <= radius; dy++) {
      const sy = ((dy % h) + h) % h;
      sum += tmp[sy * w + x];
    }
    dst[x] = sum * invW;
    for (let y = 1; y < h; y++) {
      const addY = (y + radius) % h;
      const remY = ((y - radius - 1) % h + h) % h;
      sum += tmp[addY * w + x] - tmp[remY * w + x];
      dst[y * w + x] = sum * invW;
    }
  }
}

/**
 * Packs Height (0..1), Toroidal Sobel Normals (G=dH/dx, B=dH/dy), Cavity mask (A),
 * and shaded/speckled Albedo into two contiguous RGBA8 Uint8Array buffers.
 */
function finalizeSurfaceMaps(res, heightBuf, crackBuf, speckR, speckG, speckB, speckAmt, tintRgb, opts = {}) {
  const len = res * res;
  const mapRgba = new Uint8Array(len * 4);
  const colorRgba = new Uint8Array(len * 4);
  const poreRgba = new Uint8Array(len * 4);
  const invert = !!opts.invertHeight;
  const slopeGain = opts.slopeGain !== undefined ? opts.slopeGain : 2.6;
  const shadeStrength = opts.shadeStrength !== undefined ? opts.shadeStrength : 0.22;
  const crackAoStrength = opts.crackAoStrength !== undefined ? opts.crackAoStrength : 0.28;
  const srcAlbedoRgba = opts.srcAlbedoRgba || null;
  const poreBuf = opts.poreBuf || null;
  const fiberBuf = opts.fiberBuf || null;

  // Compute robust percentile range [p2..p98] in O(N) so dynamic range fills 0..1 cleanly
  const hist = new Uint32Array(256);
  let hMin = 1e9;
  let hMax = -1e9;
  for (let i = 0; i < len; i++) {
    const h = heightBuf[i];
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const rawSpan = Math.max(1e-5, hMax - hMin);
  for (let i = 0; i < len; i++) {
    const b = clampByte(((heightBuf[i] - hMin) / rawSpan) * 255.0);
    hist[b]++;
  }
  const lowCut = Math.floor(len * 0.012);
  const highCut = Math.floor(len * 0.988);
  let acc = 0;
  let bLow = 0;
  let bHigh = 255;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= lowCut) {
      bLow = b;
      break;
    }
  }
  acc = 0;
  for (let b = 255; b >= 0; b--) {
    acc += hist[b];
    if (acc >= (len - highCut)) {
      bHigh = b;
      break;
    }
  }
  const pLow = hMin + (bLow / 255.0) * rawSpan;
  const pHigh = Math.max(pLow + 1e-4, hMin + (bHigh / 255.0) * rawSpan);
  const invNorm = 1.0 / (pHigh - pLow);

  for (let i = 0; i < len; i++) {
    let hn = clamp01((heightBuf[i] - pLow) * invNorm);
    if (invert) hn = 1.0 - hn;
    heightBuf[i] = hn;
  }

  // Compute macro-smoothed height field so Albedo leveling avoids muddy dark tile blotches
  const macroHeight = new Float32Array(len);
  const blurTmp = new Float32Array(len);
  const macroR = Math.max(6, Math.round(res * 0.055));
  boxBlurToroidal(heightBuf, macroHeight, blurTmp, res, res, macroR);

  // Pass 5 & 6: Toroidal 3x3 Sobel Normal + Cavity + Pores/Fibers + Lit Surface Albedo
  const tr = tintRgb[0];
  const tg = tintRgb[1];
  const tb = tintRgb[2];

  for (let y = 0; y < res; y++) {
    const yUp = (y - 1 + res) % res;
    const yDn = (y + 1) % res;
    const rUp = yUp * res;
    const rMd = y * res;
    const rDn = yDn * res;

    for (let x = 0; x < res; x++) {
      const xL = (x - 1 + res) % res;
      const xR = (x + 1) % res;
      const idx = rMd + x;
      const idx4 = idx * 4;

      const h = heightBuf[idx];
      const tl = heightBuf[rUp + xL];
      const tc = heightBuf[rUp + x];
      const trH = heightBuf[rUp + xR];
      const ml = heightBuf[rMd + xL];
      const mr = heightBuf[rMd + xR];
      const bl = heightBuf[rDn + xL];
      const bc = heightBuf[rDn + x];
      const br = heightBuf[rDn + xR];

      const gx = ((trH + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) * 0.25 * slopeGain;
      const gy = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + trH)) * 0.25 * slopeGain;

      const cBase = crackBuf ? crackBuf[idx] : 0.0;
      const cavity = clamp01(Math.max(cBase, smoothstep(0.48, 0.08, h) * 0.82));

      mapRgba[idx4] = clampByte(h * 255.0);
      mapRgba[idx4 + 1] = clampByte((clamp01(gx * 0.5 + 0.5)) * 255.0);
      mapRgba[idx4 + 2] = clampByte((clamp01(gy * 0.5 + 0.5)) * 255.0);
      mapRgba[idx4 + 3] = clampByte(cavity * 255.0);

      const fib = fiberBuf ? clamp01(fiberBuf[idx]) : h;
      const openPore = poreBuf ? clamp01(poreBuf[idx]) : clamp01(Math.max(cBase, 1.0 - h * 0.72) * 0.78);
      poreRgba[idx4] = clampByte(fib * 255.0);
      poreRgba[idx4 + 1] = clampByte(openPore * 255.0);
      poreRgba[idx4 + 2] = clampByte(clamp01(fib * 0.72 + (1.0 - openPore) * 0.28) * 255.0);
      poreRgba[idx4 + 3] = clampByte(clamp01(0.45 + (fib - 0.5) * 0.65 - cavity * 0.12) * 255.0);

      // High-pass balanced height for crisp background albedo without dark low-frequency repeating blobs
      const hDetail = h - macroHeight[idx];
      const hBalanced = 0.5 + hDetail * 0.90 + (macroHeight[idx] - 0.5) * 0.18;

      // Directional surface shading (-0.65, -0.76) from top-left light source
      const ndotl = -gx * 0.65 - gy * 0.76;
      const shade = 1.0 + ndotl * shadeStrength - cavity * crackAoStrength * 0.38 + (hBalanced - 0.5) * shadeStrength * 0.55;

      let ar, ag, ab;
      if (srcAlbedoRgba) {
        ar = srcAlbedoRgba[idx4] * (tr / 255.0);
        ag = srcAlbedoRgba[idx4 + 1] * (tg / 255.0);
        ab = srcAlbedoRgba[idx4 + 2] * (tb / 255.0);
        // Add crisp subtle shading modulation to custom extracted surface
        const cMod = 1.0 + ndotl * (shadeStrength * 0.40);
        ar *= cMod;
        ag *= cMod;
        ab *= cMod;
      } else {
        ar = tr * shade;
        ag = tg * shade;
        ab = tb * shade;
      }

      if (speckAmt && speckAmt[idx] > 0.002) {
        const sa = speckAmt[idx];
        const invSa = 1.0 - sa;
        ar = ar * invSa + speckR[idx] * sa;
        ag = ag * invSa + speckG[idx] * sa;
        ab = ab * invSa + speckB[idx] * sa;
      }

      colorRgba[idx4] = clampByte(ar);
      colorRgba[idx4 + 1] = clampByte(ag);
      colorRgba[idx4 + 2] = clampByte(ab);
      colorRgba[idx4 + 3] = 255;
    }
  }

  return { mapRgba, colorRgba, poreRgba };
}

/**
 * Multi-Pass Procedural Surface Synthesizer
 * Explicitly separates Pass 1 (Structure), Pass 2 (Organic Imperfections),
 * Pass 3 (Cracks/Fissures), Pass 4 (Mineral/Fiber Specks), Pass 5-6 (Sobel + Albedo).
 */
export function generateProceduralSurface(type = 'paper', opts = {}) {
  const tStart = performance.now();
  const res = opts.res || SURFACE_TILE_RES;
  const seed = (opts.seed | 0) || 1337;
  const preset = SURFACE_PRESETS[type] || SURFACE_PRESETS.paper;
  const len = res * res;

  const heightBuf = new Float32Array(len);
  const crackBuf = new Float32Array(len);
  const fiberBuf = new Float32Array(len);
  const poreBuf = new Float32Array(len);
  const speckR = new Float32Array(len);
  const speckG = new Float32Array(len);
  const speckB = new Float32Array(len);
  const speckAmt = new Float32Array(len);

  const invRes = 1.0 / res;

  // Voronoi grids needed for stone and ceramic craquelure
  const stoneVorA = type === 'stone' ? buildTorusVoronoiPoints(8, seed + 19) : null;
  const stoneVorB = type === 'stone' ? buildTorusVoronoiPoints(18, seed + 83) : null;
  const ceramicVor = type === 'ceramic' ? buildTorusVoronoiPoints(6, seed + 41) : null;

  const p1Start = performance.now();
  // PASS 1 + PASS 2 + PASS 3 (Structure + Curved Domain-Warped Turbulence + Cracks/Pores)
  for (let y = 0; y < res; y++) {
    const v = y * invRes;
    const row = y * res;

    for (let x = 0; x < res; x++) {
      const u = x * invRes;
      const idx = row + x;

      // Multi-scale organic FBM + curved domain-warp coordinates (strictly toroidal)
      const macroFbm = torusFbm(u, v, 4, 2, seed + 7);
      const midFbm = torusNoise(u, v, 12, seed + 101) * 0.65 + torusNoise(u, v, 24, seed + 199) * 0.35;
      const fineNoise = torusNoise(u, v, 64, seed + 251);

      const warpX = (macroFbm - 0.5) * 0.16;
      const warpY = (torusFbm(u, v, 4, 2, seed + 43) - 0.5) * 0.16;
      const wu = u + warpX;
      const wv = v + warpY;

      let h = 0.5;
      let crack = 0.0;
      let fib = 0.5;
      let openPore = 0.35;

      if (type === 'raw_xuan' || type === 'half_xuan' || type === 'sized_xuan' || type === 'hemp') {
        // Organic curved bast fiber web matching sumi-test turbulence (zero vertical banding or lattice dots)
        const coarseScale = type === 'hemp' ? 1 : 0;
        const pL1 = type === 'sized_xuan' ? 3 : 2;
        const pA1 = type === 'hemp' ? 8 : (type === 'sized_xuan' ? 13 : 10);
        const f1 = torusBastFiber(wu, wv, 3, 1, pL1, pA1, 2.0, seed + 307);
        const f2 = torusBastFiber(wu + 0.17, wv - 0.23, -1, 3, pL1, pA1, 2.0, seed + 419);
        const f3 = torusBastFiber(wu - warpX * 0.35, wv + warpY * 0.35, 2, 3, pL1 + 1, pA1 + 3 + coarseScale, 2.0, seed + 503);
        const f4 = torusBastFiber(wu + 0.31, wv + 0.11, 4, -1, pL1 + 2, pA1 + 5, 2.0, seed + 613);

        const longFibers = clamp01(f1 * 0.32 + f2 * 0.32 + f3 * 0.22 + f4 * 0.14);
        // Intra-tile natural pulp & fiber-pocket clusters (small/medium variation inside each sheet tile)
        const pulpClusters = torusNoise(wu, wv, 16, seed + 709) * 0.65 + torusNoise(wu, wv, 32, seed + 823) * 0.35;
        const sectorDensity = smoothstep(0.20, 0.82, macroFbm);

        const fiberGain = type === 'hemp' ? 0.54 : (type === 'sized_xuan' ? 0.28 : 0.44);
        const pulpGain = type === 'hemp' ? 0.28 : (type === 'sized_xuan' ? 0.38 : 0.34);
        const microGain = type === 'sized_xuan' ? 0.20 : 0.16;

        // Modulate fiber prominence gently across intra-tile sectors so clusters breathe organically
        const modulatedFibers = longFibers * (0.76 + 0.44 * sectorDensity);
        h = clamp01(modulatedFibers * fiberGain + pulpClusters * pulpGain + fineNoise * microGain + midFbm * 0.12);
        crack = smoothstep(0.46, 0.10, longFibers * 0.68 + pulpClusters * 0.32) * (type === 'hemp' ? 0.80 : 0.48);
        fib = clamp01(longFibers * 0.66 + pulpClusters * 0.22 + fineNoise * 0.12);
        openPore = clamp01(((1.0 - longFibers * 0.68) * 0.62 + (1.0 - pulpClusters) * 0.38) * (1.0 - 0.78 * (preset.sizing ?? 0.35)) * (0.80 + 0.38 * (1.0 - sectorDensity)));
      } else if (type === 'paper') {
        // Cold-press cotton pulp hills, intertwined short curved fibers & micro tooth pits
        const f1 = torusBastFiber(wu, wv, 2, 1, 3, 10, 2.0, seed + 313);
        const f2 = torusBastFiber(wu + 0.29, wv - 0.13, -1, 2, 3, 10, 2.0, seed + 409);
        const fiberWeb = f1 * 0.5 + f2 * 0.5;
        const cottonHills = torusFbm(wu, wv, 10, 3, seed + 521);
        const tooth = torusFbm(wu, wv, 28, 2, seed + 641);
        const pits = smoothstep(0.32, 0.08, cottonHills * 0.6 + tooth * 0.4);
        h = cottonHills * 0.38 + tooth * 0.28 + fiberWeb * 0.22 + fineNoise * 0.12 - pits * 0.14;
        crack = pits * 0.68;
        fib = clamp01(fiberWeb * 0.52 + tooth * 0.34 + cottonHills * 0.14);
        openPore = clamp01(pits * 0.55 + (1.0 - tooth) * 0.45);
      } else if (type === 'canvas') {
        // Orthogonal woven linen warp & weft basket pattern with organic slub variation
        const warpFreq = 26.0;
        const warpPhase = (u + (macroFbm - 0.5) * 0.010) * Math.PI * 2.0 * warpFreq;
        const weftPhase = (v + (midFbm - 0.5) * 0.010) * Math.PI * 2.0 * warpFreq;
        const slub = 0.88 + 0.24 * torusNoise(u, v, 12, seed + 331);
        const tx = Math.cos(warpPhase);
        const ty = Math.cos(weftPhase);
        // Flatten crown and sharpen interstitial pockets like true primed linen
        const threadX = Math.pow(Math.max(0.0, tx * 0.5 + 0.5), 0.72) * slub;
        const threadY = Math.pow(Math.max(0.0, ty * 0.5 + 0.5), 0.72);
        const basketCheck = Math.sin(warpPhase * 0.5) * Math.sin(weftPhase * 0.5);
        const weave = Math.max(threadX, threadY) * 0.72 + (threadX * threadY) * 0.28 + basketCheck * 0.12;
        const pit = smoothstep(0.42, 0.08, weave);
        h = weave * 0.74 + midFbm * 0.12 + fineNoise * 0.14;
        crack = pit * 0.65;
        fib = clamp01(h);
        openPore = clamp01(pit * 0.75 + (1.0 - h) * 0.25);
      } else if (type === 'cloth') {
        // Heavy 2/2 diagonal twill + fuzzy curved textile fibers
        const freq = 24.0;
        const diagA = (2.0 * u + v + (macroFbm - 0.5) * 0.016) * Math.PI * 2.0 * freq;
        const diagB = (u - 2.0 * v + (midFbm - 0.5) * 0.016) * Math.PI * 2.0 * freq;
        const ribA = Math.pow(Math.max(0.0, Math.cos(diagA) * 0.5 + 0.5), 0.65);
        const ribB = Math.pow(Math.max(0.0, Math.cos(diagB) * 0.5 + 0.5), 0.75);
        const twill = ribA * 0.62 + ribB * 0.38;
        const fuzz = torusFbm(wu, wv, 36, 2, seed + 521);
        h = twill * 0.64 + fuzz * 0.26 + fineNoise * 0.10;
        crack = smoothstep(0.45, 0.12, twill) * 0.75;
        fib = clamp01(h);
        openPore = clamp01(crack * 0.75 + (1.0 - h) * 0.25);
      } else if (type === 'wood') {
        // Stretched periodic timber rings with organic multi-wave warp & fine grain vessels
        const ringWarp = (macroFbm - 0.5) * 0.32 + (midFbm - 0.5) * 0.09 + (torusNoise(u, v, 6, seed + 443) - 0.5) * 0.14;
        const rVal = (v * 8.0 + ringWarp) * Math.PI * 2.0;
        const latewood = Math.pow(Math.sin(rVal) * 0.5 + 0.5, 1.75);
        // Fine horizontal curved timber fibers stretched along X
        const fibers = torusNoise2(wu, wv, 4, 42, seed + 619);
        const vesselN = torusNoise2(wu + 0.21, wv + 0.09, 3, 30, seed + 701);
        const pores = smoothstep(0.14, 0.02, vesselN) * (0.4 + 0.6 * latewood);
        h = 0.42 + latewood * 0.32 + fibers * 0.20 + midFbm * 0.08 - pores * 0.44;
        crack = pores * 0.90;
        fib = clamp01(0.35 + latewood * 0.35 + fibers * 0.30);
        openPore = clamp01(pores * 0.85 + 0.15 * (1.0 - fibers));
      } else if (type === 'stone') {
        // Chiseled slate / travertine rock plateaus + sharp Voronoi fissures
        const uW = ((wu % 1.0) + 1.0) % 1.0;
        const vW = ((wv % 1.0) + 1.0) % 1.0;
        const va = sampleTorusVoronoi(stoneVorA, uW, vW);
        const vb = sampleTorusVoronoi(stoneVorB, u, v);
        const majorCrack = smoothstep(0.055, 0.004, va.edge);
        const minorCrack = smoothstep(0.045, 0.005, vb.edge) * 0.55;
        const plateau = va.tone * 0.22 + (1.0 - va.f1 * 0.35) * 0.24 + midFbm * 0.32 + fineNoise * 0.22;
        h = plateau - majorCrack * 0.50 - minorCrack * 0.25;
        crack = clamp01(majorCrack + minorCrack * 0.65);
        fib = clamp01(h);
        openPore = clamp01(crack * 0.82 + (1.0 - (preset.sizing ?? 0.7)) * 0.18);
      } else if (type === 'ceramic') {
        // Smooth porcelain glaze with subtle hairline craquelure fissures
        const uW = ((u + (macroFbm - 0.5) * 0.04) % 1.0 + 1.0) % 1.0;
        const vW = ((v + (midFbm - 0.5) * 0.04) % 1.0 + 1.0) % 1.0;
        const vc = sampleTorusVoronoi(ceramicVor, uW, vW);
        const craze = smoothstep(0.024, 0.002, vc.edge);
        const glazeWave = midFbm * 0.34 + macroFbm * 0.22 + 0.44;
        h = glazeWave - craze * 0.44;
        crack = craze * 0.90;
        fib = clamp01(h);
        openPore = clamp01(crack * 0.82 + (1.0 - (preset.sizing ?? 0.7)) * 0.18);
      } else if (type === 'glass') {
        // Ultra-smooth optical float ripple + faint micro silica texture
        const wave = Math.sin((wu * 2.0 + wv * 1.0) * Math.PI * 2.0) * 0.05;
        h = 0.50 + midFbm * 0.28 + wave + fineNoise * 0.12;
        crack = 0.0;
        fib = clamp01(h);
        openPore = clamp01(crack * 0.82 + (1.0 - (preset.sizing ?? 0.7)) * 0.18);
      }

      heightBuf[idx] = h;
      crackBuf[idx] = crack;
      fiberBuf[idx] = fib;
      poreBuf[idx] = openPore;
    }
  }

  const p4Start = performance.now();
  // PASS 4: Deterministic Mineral & Fiber Flecks / Specks (matches organic paper/stone inclusions)
  const isXuan = (type === 'raw_xuan' || type === 'half_xuan' || type === 'sized_xuan' || type === 'hemp');
  const speckCount = type === 'hemp' ? 420 : (isXuan ? 240 : (type === 'paper' ? 320 : (type === 'stone' ? 460 : (type === 'cloth' ? 220 : (type === 'ceramic' ? 95 : 0)))));
  for (let s = 0; s < speckCount; s++) {
    const sx = (hash1(s, seed + 17) * res) | 0;
    const sy = (hash1(s, seed + 89) * res) | 0;
    const rad = hash1(s, seed + 233) > 0.86 ? 1 : 0;
    const kind = hash1(s, seed + 389);

    let sr = 72, sg = 68, sb = 64, sa = 0.55, dh = -0.04;
    if (isXuan) {
      if (kind < 0.65) {
        // Natural mulberry bark & straw fleck
        sr = 124; sg = 104; sb = 78; sa = 0.26 + kind * 0.28; dh = 0.03;
      } else {
        sr = 78; sg = 70; sb = 60; sa = 0.24; dh = -0.04;
      }
    } else if (type === 'paper') {
      if (kind < 0.72) {
        // Dark pulp/mineral speck
        sr = 58; sg = 54; sb = 50; sa = 0.35 + kind * 0.4; dh = -0.05;
      } else if (kind < 0.88) {
        // Warm amber fiber fleck
        sr = 188; sg = 132; sb = 94; sa = 0.32; dh = 0.03;
      } else {
        // Tiny blue/teal recycled fiber fleck
        sr = 78; sg = 138; sb = 166; sa = 0.36; dh = 0.02;
      }
    } else if (type === 'stone') {
      if (kind < 0.6) {
        sr = 95; sg = 92; sb = 88; sa = 0.45; dh = -0.09;
      } else {
        sr = 236; sg = 232; sb = 222; sa = 0.38; dh = 0.06;
      }
    } else if (type === 'cloth') {
      sr = 148; sg = 138; sb = 124; sa = 0.30; dh = 0.04;
    } else if (type === 'ceramic') {
      sr = 110; sg = 104; sb = 96; sa = 0.32; dh = -0.02;
    }

    for (let dy = -rad; dy <= rad; dy++) {
      const py = (sy + dy + res) % res;
      for (let dx = -rad; dx <= rad; dx++) {
        if (rad > 0 && Math.abs(dx) + Math.abs(dy) > 1 && hash1(s + dx * 3 + dy, seed) < 0.45) continue;
        const px = (sx + dx + res) % res;
        const idx = py * res + px;
        speckR[idx] = sr;
        speckG[idx] = sg;
        speckB[idx] = sb;
        speckAmt[idx] = sa * (dx === 0 && dy === 0 ? 1.0 : 0.45);
        heightBuf[idx] += dh;
      }
    }
  }

  const slopeGain = type === 'glass' ? 0.6 : (type === 'ceramic' || type === 'sized_xuan' ? 1.3 : (type === 'hemp' ? 3.0 : 2.6));
  const shadeStrength = type === 'glass' ? 0.05 : (type === 'ceramic' || type === 'sized_xuan' ? 0.09 : (type === 'paper' || isXuan ? 0.13 : 0.24));
  const crackAoStrength = type === 'paper' || isXuan ? 0.15 : (type === 'ceramic' ? 0.22 : 0.30);

  const packed = finalizeSurfaceMaps(res, heightBuf, crackBuf, speckR, speckG, speckB, speckAmt, preset.tint, {
    invertHeight: !!opts.invertHeight,
    slopeGain,
    shadeStrength,
    crackAoStrength,
    fiberBuf,
    poreBuf
  });

  const tEnd = performance.now();
  return {
    width: res,
    height: res,
    colorRgba: packed.colorRgba,
    mapRgba: packed.mapRgba,
    poreRgba: packed.poreRgba,
    heightBuf,
    genMs: Math.round((tEnd - tStart) * 10) / 10,
    passDetailMs: {
      structureAndCracks: Math.round((p4Start - p1Start) * 10) / 10,
      specksSobelAlbedo: Math.round((tEnd - p4Start) * 10) / 10
    }
  };
}

/**
 * Custom Image -> Optional Seamless Toroidal Tiler + Automatic Height/Normal/Cavity Extraction
 * Operates in O(W*H) using separable sliding-window high-pass illumination flattening so uneven
 * photography becomes a flat-field seamlessly tiling 3D bump & albedo surface!
 */
export function extractSurfaceFromRgba(srcRgba, width, height, opts = {}) {
  const tStart = performance.now();
  const res = width;
  const len = width * height;
  const seamless = opts.seamless !== false;
  const invertHeight = !!opts.invertHeight;

  const rBuf = new Float32Array(len);
  const gBuf = new Float32Array(len);
  const bBuf = new Float32Array(len);
  const lumBuf = new Float32Array(len);

  let meanR = 0, meanG = 0, meanB = 0;
  for (let i = 0; i < len; i++) {
    const i4 = i * 4;
    const r = srcRgba[i4];
    const g = srcRgba[i4 + 1];
    const b = srcRgba[i4 + 2];
    rBuf[i] = r;
    gBuf[i] = g;
    bBuf[i] = b;
    lumBuf[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
    meanR += r;
    meanG += g;
    meanB += b;
  }
  meanR /= len;
  meanG /= len;
  meanB /= len;

  // Compute macro low-pass illumination band via separable sliding box blur
  const blurTmp = new Float32Array(len);
  const lowR = new Float32Array(len);
  const lowG = new Float32Array(len);
  const lowB = new Float32Array(len);
  const lowLum = new Float32Array(len);

  const macroRadius = Math.max(8, Math.round(res * 0.055));
  boxBlurToroidal(rBuf, lowR, blurTmp, width, height, macroRadius);
  boxBlurToroidal(gBuf, lowG, blurTmp, width, height, macroRadius);
  boxBlurToroidal(bBuf, lowB, blurTmp, width, height, macroRadius);
  boxBlurToroidal(lumBuf, lowLum, blurTmp, width, height, macroRadius);

  const tiledAlbedo = new Uint8Array(len * 4);
  const heightBuf = new Float32Array(len);
  const crackBuf = new Float32Array(len);
  const fiberBuf = new Float32Array(len);
  const poreBuf = new Float32Array(len);
  const half = res >> 1;

  for (let y = 0; y < height; y++) {
    const vNorm = Math.abs((2.0 * y) / height - 1.0);
    const wy = 1.0 - smoothstep(0.45, 1.0, vNorm);
    const sy = (y + half) % height;

    for (let x = 0; x < width; x++) {
      const uNorm = Math.abs((2.0 * x) / width - 1.0);
      const wx = 1.0 - smoothstep(0.45, 1.0, uNorm);
      const idx = y * width + x;
      const idx4 = idx * 4;

      if (seamless) {
        // Diamond toroidal high-pass/low-pass crossfade removes edges without ghosting center
        const sIdx = sy * width + ((x + half) % width);
        const w = wx * wy;
        const invW = 1.0 - w;

        const r1 = rBuf[idx] - lowR[idx] + meanR * 0.65 + lowR[idx] * 0.35;
        const g1 = gBuf[idx] - lowG[idx] + meanG * 0.65 + lowG[idx] * 0.35;
        const b1 = bBuf[idx] - lowB[idx] + meanB * 0.65 + lowB[idx] * 0.35;

        const r2 = rBuf[sIdx] - lowR[sIdx] + meanR * 0.65 + lowR[sIdx] * 0.35;
        const g2 = gBuf[sIdx] - lowG[sIdx] + meanG * 0.65 + lowG[sIdx] * 0.35;
        const b2 = bBuf[sIdx] - lowB[sIdx] + meanB * 0.65 + lowB[sIdx] * 0.35;

        const outR = r1 * w + r2 * invW;
        const outG = g1 * w + g2 * invW;
        const outB = b1 * w + b2 * invW;
        tiledAlbedo[idx4] = clampByte(outR);
        tiledAlbedo[idx4 + 1] = clampByte(outG);
        tiledAlbedo[idx4 + 2] = clampByte(outB);
        tiledAlbedo[idx4 + 3] = 255;

        const y1 = lumBuf[idx] - lowLum[idx];
        const y2 = lumBuf[sIdx] - lowLum[sIdx];
        const relLum = y1 * w + y2 * invW;
        const absLum = lumBuf[idx] * w + lumBuf[sIdx] * invW;

        const darkCrevice = clamp01((-relLum - 0.025) * 4.5);
        crackBuf[idx] = darkCrevice;
        heightBuf[idx] = 0.5 + relLum * 2.4 + (absLum - 0.5) * 0.30 - darkCrevice * 0.16;
        fiberBuf[idx] = clamp01(0.5 + relLum * 2.8);
        poreBuf[idx] = clamp01(0.22 + darkCrevice * 0.58 + Math.max(0.0, -relLum) * 1.4);
      } else {
        tiledAlbedo[idx4] = clampByte(rBuf[idx]);
        tiledAlbedo[idx4 + 1] = clampByte(gBuf[idx]);
        tiledAlbedo[idx4 + 2] = clampByte(bBuf[idx]);
        tiledAlbedo[idx4 + 3] = 255;

        const relLum = lumBuf[idx] - lowLum[idx];
        const darkCrevice = clamp01((-relLum - 0.025) * 4.5);
        crackBuf[idx] = darkCrevice;
        heightBuf[idx] = 0.5 + relLum * 2.4 + (lumBuf[idx] - 0.5) * 0.35 - darkCrevice * 0.16;
        fiberBuf[idx] = clamp01(0.5 + relLum * 2.8);
        poreBuf[idx] = clamp01(0.22 + darkCrevice * 0.58 + Math.max(0.0, -relLum) * 1.4);
      }
    }
  }

  const packed = finalizeSurfaceMaps(res, heightBuf, crackBuf, null, null, null, null, [255, 255, 255], {
    invertHeight,
    slopeGain: 2.8,
    shadeStrength: 0.18,
    crackAoStrength: 0.15,
    srcAlbedoRgba: tiledAlbedo,
    fiberBuf,
    poreBuf
  });

  const tEnd = performance.now();
  return {
    width,
    height,
    colorRgba: packed.colorRgba,
    mapRgba: packed.mapRgba,
    poreRgba: packed.poreRgba,
    heightBuf,
    genMs: Math.round((tEnd - tStart) * 10) / 10
  };
}

/**
 * Resamples a browser Image / Canvas into a square power-of-2 tile and runs extraction.
 */
export function extractSurfaceFromImage(imgOrCanvas, opts = {}) {
  const res = opts.res || SURFACE_TILE_RES;
  const work = document.createElement('canvas');
  work.width = res;
  work.height = res;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgOrCanvas, 0, 0, res, res);
  const imgData = ctx.getImageData(0, 0, res, res);
  return extractSurfaceFromRgba(imgData.data, res, res, opts);
}

/**
 * SurfaceManager — Holds surface configuration, baked RGBA tiles, 2D pattern canvas,
 * and lazy WebGL2 texture upload with gl.REPEAT & mipmaps (0 alloc during paint strokes).
 */
export class CanvasSurfaceManager {
  constructor() {
    this.type = 'none';
    this.scale = 340;
    this.relief = 0.58;
    this.slip = 0.24;
    this.resist = 0.56;
    this.channel = 0.22;
    this.absorb = 0.74;
    this.bgOpacity = 0.62;
    this.biomeMix = 0.88;
    this.seamless = true;
    this.invertHeight = false;
    this.seed = 1337;

    this.customDataUrl = null;
    this._customImage = null;

    this.width = SURFACE_TILE_RES;
    this.height = SURFACE_TILE_RES;
    this.colorRgba = null;
    this.mapRgba = null;
    this.poreRgba = null;
    this.lastGenMs = 0;
    this.version = 0;

    this._colorCanvas = null;
    this._heightCanvas = null;
    this._poreCanvas = null;

    // WebGL2 state bound per-context (rebuilt cleanly on context loss/restore)
    this._gl = null;
    this._glColorTex = null;
    this._glMapTex = null;
    this._glPoreTex = null;
    this._uploadedVersion = -1;
  }

  get isActive() {
    return this.type !== 'none' && !!this.mapRgba && !!this.colorRgba;
  }

  applyPresetDefaults(typeId) {
    const p = SURFACE_PRESETS[typeId] || SURFACE_PRESETS.none;
    this.type = p.id;
    this.slip = p.slip;
    this.resist = p.resist;
    this.channel = p.channel;
    this.relief = p.relief;
    this.absorb = p.absorb;
    this.scale = p.scale;
    this.bgOpacity = p.bgOpacity;
    this.biomeMix = p.biomeMix !== undefined ? p.biomeMix : 0.88;
    this.rebuild();
  }

  setCustomImage(img, dataUrl = null) {
    this._customImage = img;
    if (dataUrl) this.customDataUrl = dataUrl;
    const p = SURFACE_PRESETS.custom;
    if (this.type !== 'custom') {
      this.slip = p.slip;
      this.resist = p.resist;
      this.channel = p.channel;
      this.relief = p.relief;
      this.absorb = p.absorb;
      this.scale = p.scale;
      this.bgOpacity = p.bgOpacity;
      this.biomeMix = p.biomeMix !== undefined ? p.biomeMix : 0.78;
    }
    this.type = 'custom';
    this.rebuild();
  }

  loadCustomDataUrl(dataUrl, onDone = null) {
    if (!dataUrl || typeof Image === 'undefined') return;
    const img = new Image();
    img.onload = () => {
      this._customImage = img;
      this.customDataUrl = dataUrl;
      if (this.type === 'custom') {
        this.rebuild();
        if (onDone) onDone(this);
      }
    };
    img.src = dataUrl;
  }

  rebuild() {
    if (this.type === 'none') {
      this.colorRgba = null;
      this.mapRgba = null;
      this.poreRgba = null;
      this._colorCanvas = null;
      this._heightCanvas = null;
      this._poreCanvas = null;
      this.lastGenMs = 0;
      this.version++;
      return;
    }

    let result;
    if (this.type === 'custom' && this._customImage && (this._customImage.complete !== false) && (this._customImage.width || 0) > 0) {
      result = extractSurfaceFromImage(this._customImage, {
        res: SURFACE_TILE_RES,
        seamless: this.seamless,
        invertHeight: this.invertHeight
      });
    } else {
      const procType = this.type === 'custom' ? 'paper' : this.type;
      result = generateProceduralSurface(procType, {
        res: SURFACE_TILE_RES,
        seed: this.seed,
        invertHeight: this.invertHeight
      });
    }

    this.width = result.width;
    this.height = result.height;
    this.colorRgba = result.colorRgba;
    this.mapRgba = result.mapRgba;
    this.poreRgba = result.poreRgba || null;
    this.lastGenMs = result.genMs;
    this._colorCanvas = null;
    this._heightCanvas = null;
    this._poreCanvas = null;
    this.version++;
  }

  _updateCanvasFromBytes(cachedCanvas, rgbaBytes) {
    if (typeof document === 'undefined' || !rgbaBytes) return null;
    const c = cachedCanvas || document.createElement('canvas');
    if (c.width !== this.width || c.height !== this.height) {
      c.width = this.width;
      c.height = this.height;
    }
    const ctx = c.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgbaBytes), this.width, this.height);
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  getColorCanvas() {
    if (!this.colorRgba) return null;
    if (!this._colorCanvas) {
      this._colorCanvas = this._updateCanvasFromBytes(null, this.colorRgba);
    }
    return this._colorCanvas;
  }

  getHeightCanvas() {
    if (!this.mapRgba) return null;
    if (!this._heightCanvas) {
      const len = this.width * this.height;
      const gray = new Uint8Array(len * 4);
      for (let i = 0; i < len; i++) {
        const i4 = i * 4;
        const h = this.mapRgba[i4];
        gray[i4] = h;
        gray[i4 + 1] = h;
        gray[i4 + 2] = h;
        gray[i4 + 3] = 255;
      }
      this._heightCanvas = this._updateCanvasFromBytes(null, gray);
    }
    return this._heightCanvas;
  }

  getPoreCanvas() {
    if (!this.poreRgba) return null;
    if (!this._poreCanvas) {
      const len = this.width * this.height;
      const vis = new Uint8Array(len * 4);
      for (let i = 0; i < len; i++) {
        const i4 = i * 4;
        const fib = this.poreRgba[i4] / 255.0;
        const openPore = this.poreRgba[i4 + 1] / 255.0;
        const block = this.poreRgba[i4 + 2] / 255.0;
        // High-clarity porous Xuan contrast like sumi-test: deep porous pockets & warm bast fibers
        const vR = 26 + fib * 145 - openPore * 22 + block * 18;
        const vG = 28 + fib * 150 + openPore * 18;
        const vB = 26 + fib * 132 + openPore * 34;
        vis[i4] = clampByte(vR);
        vis[i4 + 1] = clampByte(vG);
        vis[i4 + 2] = clampByte(vB);
        vis[i4 + 3] = 255;
      }
      this._poreCanvas = this._updateCanvasFromBytes(null, vis);
    }
    return this._poreCanvas;
  }

  ensureGpuTextures(gl) {
    if (!gl || !this.isActive || gl.isContextLost()) {
      return { colorTex: null, mapTex: null, poreTex: null };
    }
    if (this._gl && this._gl !== gl) {
      this._glColorTex = null;
      this._glMapTex = null;
      this._glPoreTex = null;
      this._uploadedVersion = -1;
    }
    this._gl = gl;

    if (!this._glColorTex || !this._glMapTex || !this._glPoreTex || this._uploadedVersion !== this.version) {
      if (!this._glColorTex) this._glColorTex = gl.createTexture();
      if (!this._glMapTex) this._glMapTex = gl.createTexture();
      if (!this._glPoreTex) this._glPoreTex = gl.createTexture();

      const uploadRepeat = (tex, bytes) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        gl.generateMipmap(gl.TEXTURE_2D);
      };

      uploadRepeat(this._glColorTex, this.colorRgba);
      uploadRepeat(this._glMapTex, this.mapRgba);
      uploadRepeat(this._glPoreTex, this.poreRgba || this.mapRgba);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._uploadedVersion = this.version;
    }

    return { colorTex: this._glColorTex, mapTex: this._glMapTex, poreTex: this._glPoreTex };
  }

  getShaderUniforms() {
    const p = SURFACE_PRESETS[this.type] || SURFACE_PRESETS.none;
    if (!this.isActive) {
      return {
        active: false,
        invScale: 1.0 / 320.0,
        slip: 0.5,
        resist: 0.0,
        channel: 0.0,
        relief: 0.0,
        absorb: 0.0,
        bgOpacity: 0.0,
        biomeMix: 0.0,
        allowRotate: 1.0,
        scaleSpread: 1.0
      };
    }
    return {
      active: true,
      invScale: 1.0 / Math.max(32.0, this.scale || 320.0),
      slip: clamp01(this.slip),
      resist: clamp01(this.resist),
      channel: clamp01(this.channel),
      relief: clamp01(this.relief),
      absorb: clamp01(this.absorb),
      bgOpacity: clamp01(this.bgOpacity),
      biomeMix: clamp01(this.biomeMix !== undefined ? this.biomeMix : (p.biomeMix ?? 0.88)),
      allowRotate: p.allowRotate !== undefined ? p.allowRotate : 1.0,
      scaleSpread: p.scaleSpread !== undefined ? p.scaleSpread : 1.0
    };
  }

  getSumiPhysicsParams() {
    const p = SURFACE_PRESETS[this.type] || SURFACE_PRESETS.none;
    if (!this.isActive) {
      return {
        active: false,
        sizing: 0.25,
        seepRate: 0.90,
        coarseness: 0.42,
        capillarity: 0.62,
        sootSnag: 0.55,
        backrun: 0.68,
        slip: 0.45,
        relief: 0.25,
        channel: 0.20,
        invScale: 1.0 / 340.0,
        biomeMix: 0.0,
        allowRotate: 1.0,
        scaleSpread: 1.0
      };
    }
    const reliefRatio = p.relief > 0.05 ? (this.relief / p.relief) : (0.5 + this.relief);
    const slipDelta = this.slip - p.slip;
    return {
      active: true,
      sizing: clamp01((p.sizing ?? 0.45) + slipDelta * 0.45),
      seepRate: clamp01((p.seepRate ?? 0.68) * clamp01(1.15 - slipDelta * 0.55) * 1.15),
      coarseness: clamp01((p.coarseness ?? 0.50) * Math.max(0.25, Math.min(1.6, reliefRatio))),
      capillarity: clamp01((p.capillarity ?? 0.55) + (this.channel - p.channel) * 0.35),
      sootSnag: clamp01((p.sootSnag ?? 0.55) * Math.max(0.25, Math.min(1.6, reliefRatio))),
      backrun: clamp01(p.backrun ?? 0.68),
      slip: clamp01(this.slip),
      relief: clamp01(this.relief),
      channel: clamp01(this.channel),
      invScale: 1.0 / Math.max(32.0, this.scale || 340.0),
      biomeMix: clamp01(this.biomeMix !== undefined ? this.biomeMix : (p.biomeMix ?? 0.88)),
      allowRotate: p.allowRotate !== undefined ? p.allowRotate : 1.0,
      scaleSpread: p.scaleSpread !== undefined ? p.scaleSpread : 1.0
    };
  }

  serialize() {
    return {
      type: this.type,
      scale: this.scale,
      relief: this.relief,
      slip: this.slip,
      resist: this.resist,
      channel: this.channel,
      absorb: this.absorb,
      bgOpacity: this.bgOpacity,
      biomeMix: this.biomeMix,
      seamless: this.seamless,
      invertHeight: this.invertHeight,
      seed: this.seed,
      customDataUrl: (this.type === 'custom' && this.customDataUrl && this.customDataUrl.length < 350000)
        ? this.customDataUrl
        : null
    };
  }

  deserialize(data, onReady = null) {
    if (!data || typeof data !== 'object') {
      this.applyPresetDefaults('none');
      return;
    }
    const type = SURFACE_PRESETS[data.type] ? data.type : 'none';
    const def = SURFACE_PRESETS[type];
    this.type = type;
    this.scale = Number.isFinite(data.scale) ? data.scale : def.scale;
    this.relief = Number.isFinite(data.relief) ? data.relief : def.relief;
    this.slip = Number.isFinite(data.slip) ? data.slip : def.slip;
    this.resist = Number.isFinite(data.resist) ? data.resist : def.resist;
    this.channel = Number.isFinite(data.channel) ? data.channel : def.channel;
    this.absorb = Number.isFinite(data.absorb) ? data.absorb : def.absorb;
    this.bgOpacity = Number.isFinite(data.bgOpacity) ? data.bgOpacity : def.bgOpacity;
    this.biomeMix = Number.isFinite(data.biomeMix) ? data.biomeMix : (def.biomeMix !== undefined ? def.biomeMix : 0.88);
    this.seamless = data.seamless !== undefined ? !!data.seamless : true;
    this.invertHeight = !!data.invertHeight;
    this.seed = Number.isFinite(data.seed) ? (data.seed | 0) : 1337;
    this.customDataUrl = data.customDataUrl || null;

    if (this.type === 'custom' && this.customDataUrl) {
      this.rebuild(); // immediate fallback map until image finishes decoding
      this.loadCustomDataUrl(this.customDataUrl, () => {
        if (onReady) onReady(this);
      });
    } else {
      this.rebuild();
    }
  }

  dispose() {
    if (this._gl && !this._gl.isContextLost()) {
      if (this._glColorTex) this._gl.deleteTexture(this._glColorTex);
      if (this._glMapTex) this._gl.deleteTexture(this._glMapTex);
      if (this._glPoreTex) this._gl.deleteTexture(this._glPoreTex);
    }
    this._gl = null;
    this._glColorTex = null;
    this._glMapTex = null;
    this._glPoreTex = null;
    this._uploadedVersion = -1;
  }
}

/**
 * Shared GLSL WebGL2 Multi-Scale "Sectors / Biomes" Aperiodic Surface Sampler.
 * Combines Small (~1.85x), Medium (~1.0x), and Large (~0.50x) stochastic simplex sectors
 * with domain-warped boundaries, continuous textureGrad() mipmapping (zero seams),
 * exact 90-degree orthogonal normal rotation, and variance-preserving contrast blending.
 */
export const GLSL_SURFACE_BIOME_SAMPLER = `
vec4 _sbHash4(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

float _sbHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + 19.7);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float _sbNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(_sbHash21(i), _sbHash21(i + vec2(1.0, 0.0)), f.x),
    mix(_sbHash21(i + vec2(0.0, 1.0)), _sbHash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

vec2 _sbSymVec(vec2 v, int sym) {
  if (sym == 1) return vec2(-v.y, v.x);
  if (sym == 2) return vec2(-v.x, -v.y);
  if (sym == 3) return vec2(v.y, -v.x);
  if (sym == 4) return vec2(-v.x, v.y);
  if (sym == 5) return vec2(v.y, v.x);
  if (sym == 6) return vec2(v.x, -v.y);
  if (sym == 7) return vec2(-v.y, -v.x);
  return v;
}

vec2 _sbInvSymVec(vec2 v, int sym) {
  if (sym == 1) return vec2(v.y, -v.x);
  if (sym == 2) return vec2(-v.x, -v.y);
  if (sym == 3) return vec2(-v.y, v.x);
  if (sym == 4) return vec2(-v.x, v.y);
  if (sym == 5) return vec2(v.y, v.x);
  if (sym == 6) return vec2(v.x, -v.y);
  if (sym == 7) return vec2(-v.y, -v.x);
  return v;
}

struct _SbCellSample {
  vec2 id0; vec2 id1; vec2 id2;
  vec3 bw;
  float macroA;
  float macroB;
};

_SbCellSample _sbComputeSectors(vec2 uvBase, float biomeMix) {
  float mA = _sbNoise(uvBase * 0.24 + vec2(4.2, 1.9));
  float mB = _sbNoise(uvBase * 0.13 + vec2(19.7, 8.3));
  vec2 warp = vec2(
    _sbNoise(uvBase * 0.42 + vec2(3.1, 7.4)) - 0.5,
    _sbNoise(uvBase * 0.42 + vec2(11.9, 2.3)) - 0.5
  ) * (0.34 * biomeMix);

  vec2 secP = uvBase * 0.72 + warp;
  const float K1 = 0.366025404;
  vec2 skew = secP + (secP.x + secP.y) * K1;
  vec2 i = floor(skew);
  vec2 f = skew - i;

  vec2 o1 = (f.x >= f.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float w0 = (f.x >= f.y) ? (1.0 - f.x) : (1.0 - f.y);
  float w1 = (f.x >= f.y) ? (f.x - f.y) : (f.y - f.x);
  float w2 = (f.x >= f.y) ? f.y : f.x;

  vec3 bw = pow(max(vec3(w0, w1, w2), 0.0), vec3(mix(1.0, 2.35, biomeMix)));
  bw /= max(bw.x + bw.y + bw.z, 1e-5);

  _SbCellSample res;
  res.id0 = i;
  res.id1 = i + o1;
  res.id2 = i + vec2(1.0, 1.0);
  res.bw = bw;
  res.macroA = mA;
  res.macroB = mB;
  return res;
}

float _sbPickScale(float localHash, float macroA, float scaleSpread, float biomeMix) {
  float sel = mix(localHash, macroA, 0.55);
  float tier = 1.0;
  if (sel < 0.32) {
    tier = mix(0.50, 0.74, sel / 0.32);
  } else if (sel < 0.70) {
    tier = mix(0.88, 1.15, (sel - 0.32) / 0.38);
  } else {
    tier = mix(1.42, 2.02, (sel - 0.70) / 0.30);
  }
  return mix(1.0, tier, scaleSpread * biomeMix);
}

int _sbPickSym(float zHash, float allowRotate) {
  if (allowRotate <= 0.5) return 0;
  return int(floor(zHash * 8.0)) & 7;
}

vec3 sampleSurfaceColorBiome(sampler2D tex, vec2 worldPos, float invScale, float biomeMix, float allowRotate, float scaleSpread) {
  vec2 uvBase = worldPos * invScale;
  vec2 ddx = dFdx(uvBase);
  vec2 ddy = dFdy(uvBase);
  if (biomeMix <= 0.01) {
    return textureGrad(tex, uvBase, ddx, ddy).rgb;
  }

  _SbCellSample sc = _sbComputeSectors(uvBase, biomeMix);
  vec4 h0 = _sbHash4(sc.id0);
  vec4 h1 = _sbHash4(sc.id1);
  vec4 h2 = _sbHash4(sc.id2);

  float s0 = _sbPickScale(h0.w, sc.macroA, scaleSpread, biomeMix);
  float s1 = _sbPickScale(h1.w, sc.macroA, scaleSpread, biomeMix);
  float s2 = _sbPickScale(h2.w, sc.macroA, scaleSpread, biomeMix);

  int sym0 = _sbPickSym(h0.z, allowRotate);
  int sym1 = _sbPickSym(h1.z, allowRotate);
  int sym2 = _sbPickSym(h2.z, allowRotate);

  vec3 c0 = textureGrad(tex, _sbSymVec(uvBase * s0 - 0.5, sym0) + 0.5 + h0.xy, _sbSymVec(ddx, sym0) * s0, _sbSymVec(ddy, sym0) * s0).rgb;
  vec3 c1 = textureGrad(tex, _sbSymVec(uvBase * s1 - 0.5, sym1) + 0.5 + h1.xy, _sbSymVec(ddx, sym1) * s1, _sbSymVec(ddy, sym1) * s1).rgb;
  vec3 c2 = textureGrad(tex, _sbSymVec(uvBase * s2 - 0.5, sym2) + 0.5 + h2.xy, _sbSymVec(ddx, sym2) * s2, _sbSymVec(ddy, sym2) * s2).rgb;

  vec3 blended = c0 * sc.bw.x + c1 * sc.bw.y + c2 * sc.bw.z;
  // Subtle variance preservation & organic large-scale macro paper cloud variation
  vec3 tileAvg = textureLod(tex, vec2(0.5), 8.0).rgb;
  float varGain = mix(1.0, min(1.55, inversesqrt(max(dot(sc.bw, sc.bw), 0.25))), biomeMix);
  vec3 crisp = tileAvg + (blended - tileAvg) * varGain;
  float macroCloud = ((sc.macroA - 0.5) * 0.022 + (sc.macroB - 0.5) * 0.018) * biomeMix;
  return clamp(crisp + vec3(macroCloud), 0.0, 1.0);
}

vec4 sampleSurfaceMapBiome(sampler2D mapTex, vec2 worldPos, float invScale, float biomeMix, float allowRotate, float scaleSpread) {
  vec2 uvBase = worldPos * invScale;
  vec2 ddx = vec2(invScale, 0.0);
  vec2 ddy = vec2(0.0, invScale);
  if (biomeMix <= 0.01) {
    return textureGrad(mapTex, uvBase, ddx, ddy);
  }

  _SbCellSample sc = _sbComputeSectors(uvBase, biomeMix);
  vec4 h0 = _sbHash4(sc.id0);
  vec4 h1 = _sbHash4(sc.id1);
  vec4 h2 = _sbHash4(sc.id2);

  float s0 = _sbPickScale(h0.w, sc.macroA, scaleSpread, biomeMix);
  float s1 = _sbPickScale(h1.w, sc.macroA, scaleSpread, biomeMix);
  float s2 = _sbPickScale(h2.w, sc.macroA, scaleSpread, biomeMix);

  int sym0 = _sbPickSym(h0.z, allowRotate);
  int sym1 = _sbPickSym(h1.z, allowRotate);
  int sym2 = _sbPickSym(h2.z, allowRotate);

  vec4 t0 = textureGrad(mapTex, _sbSymVec(uvBase * s0 - 0.5, sym0) + 0.5 + h0.xy, _sbSymVec(ddx, sym0) * s0, _sbSymVec(ddy, sym0) * s0);
  vec4 t1 = textureGrad(mapTex, _sbSymVec(uvBase * s1 - 0.5, sym1) + 0.5 + h1.xy, _sbSymVec(ddx, sym1) * s1, _sbSymVec(ddy, sym1) * s1);
  vec4 t2 = textureGrad(mapTex, _sbSymVec(uvBase * s2 - 0.5, sym2) + 0.5 + h2.xy, _sbSymVec(ddx, sym2) * s2, _sbSymVec(ddy, sym2) * s2);

  float varGain = mix(1.0, min(1.55, inversesqrt(max(dot(sc.bw, sc.bw), 0.25))), biomeMix);
  float hMix = t0.r * sc.bw.x + t1.r * sc.bw.y + t2.r * sc.bw.z;
  float hOut = clamp(0.5 + (hMix - 0.5) * varGain + (sc.macroB - 0.5) * 0.08 * biomeMix, 0.0, 1.0);

  vec2 g0 = _sbInvSymVec(t0.gb - 0.5, sym0);
  vec2 g1 = _sbInvSymVec(t1.gb - 0.5, sym1);
  vec2 g2 = _sbInvSymVec(t2.gb - 0.5, sym2);
  vec2 gOut = clamp((g0 * sc.bw.x + g1 * sc.bw.y + g2 * sc.bw.z) * varGain + 0.5, 0.0, 1.0);

  float cavOut = clamp(t0.a * sc.bw.x + t1.a * sc.bw.y + t2.a * sc.bw.z, 0.0, 1.0);
  return vec4(hOut, gOut, cavOut);
}

vec4 sampleSurfacePoreBiome(sampler2D poreTex, vec2 worldPos, float invScale, float biomeMix, float allowRotate, float scaleSpread) {
  vec2 uvBase = worldPos * invScale;
  vec2 ddx = vec2(invScale, 0.0);
  vec2 ddy = vec2(0.0, invScale);
  if (biomeMix <= 0.01) {
    return textureGrad(poreTex, uvBase, ddx, ddy);
  }

  _SbCellSample sc = _sbComputeSectors(uvBase, biomeMix);
  vec4 h0 = _sbHash4(sc.id0);
  vec4 h1 = _sbHash4(sc.id1);
  vec4 h2 = _sbHash4(sc.id2);

  float s0 = _sbPickScale(h0.w, sc.macroA, scaleSpread, biomeMix);
  float s1 = _sbPickScale(h1.w, sc.macroA, scaleSpread, biomeMix);
  float s2 = _sbPickScale(h2.w, sc.macroA, scaleSpread, biomeMix);

  int sym0 = _sbPickSym(h0.z, allowRotate);
  int sym1 = _sbPickSym(h1.z, allowRotate);
  int sym2 = _sbPickSym(h2.z, allowRotate);

  vec4 p0 = textureGrad(poreTex, _sbSymVec(uvBase * s0 - 0.5, sym0) + 0.5 + h0.xy, _sbSymVec(ddx, sym0) * s0, _sbSymVec(ddy, sym0) * s0);
  vec4 p1 = textureGrad(poreTex, _sbSymVec(uvBase * s1 - 0.5, sym1) + 0.5 + h1.xy, _sbSymVec(ddx, sym1) * s1, _sbSymVec(ddy, sym1) * s1);
  vec4 p2 = textureGrad(poreTex, _sbSymVec(uvBase * s2 - 0.5, sym2) + 0.5 + h2.xy, _sbSymVec(ddx, sym2) * s2, _sbSymVec(ddy, sym2) * s2);

  vec4 pMix = p0 * sc.bw.x + p1 * sc.bw.y + p2 * sc.bw.z;
  float varGain = mix(1.0, min(1.50, inversesqrt(max(dot(sc.bw, sc.bw), 0.25))), biomeMix);
  return clamp(0.5 + (pMix - 0.5) * varGain, 0.0, 1.0);
}
`;

