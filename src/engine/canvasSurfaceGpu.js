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
    scale: 320,
    bgOpacity: 0.00,
    tint: [255, 255, 255]
  },
  paper: {
    id: 'paper',
    label: 'PAPER',
    hint: 'Absorbent cold-press peaks catch light strokes & granulate.',
    slip: 0.24,
    resist: 0.56,
    channel: 0.22,
    relief: 0.58,
    absorb: 0.74,
    scale: 340,
    bgOpacity: 0.62,
    tint: [242, 236, 224]
  },
  canvas: {
    id: 'canvas',
    label: 'CANVAS',
    hint: 'Woven linen crown grabs thick paint; press harder to fill weave.',
    slip: 0.28,
    resist: 0.74,
    channel: 0.50,
    relief: 0.70,
    absorb: 0.54,
    scale: 240,
    bgOpacity: 0.68,
    tint: [243, 238, 226]
  },
  wood: {
    id: 'wood',
    label: 'WOOD',
    hint: 'Strong directional oak grain channels paint & water along vessels.',
    slip: 0.52,
    resist: 0.62,
    channel: 0.88,
    relief: 0.66,
    absorb: 0.34,
    scale: 420,
    bgOpacity: 0.72,
    tint: [222, 195, 160]
  },
  stone: {
    id: 'stone',
    label: 'STONE',
    hint: 'High relief slate with deep fractures that break dry brushstrokes.',
    slip: 0.16,
    resist: 0.86,
    channel: 0.66,
    relief: 0.88,
    absorb: 0.60,
    scale: 380,
    bgOpacity: 0.74,
    tint: [212, 210, 204]
  },
  cloth: {
    id: 'cloth',
    label: 'CLOTH',
    hint: 'Diagonal twill threads wick wet pigment outward into fibers.',
    slip: 0.20,
    resist: 0.78,
    channel: 0.58,
    relief: 0.76,
    absorb: 0.85,
    scale: 210,
    bgOpacity: 0.70,
    tint: [232, 226, 214]
  },
  ceramic: {
    id: 'ceramic',
    label: 'CERAMIC',
    hint: 'Glazed slick tiles let paint glide fast; hairline crazing catches edges.',
    slip: 0.86,
    resist: 0.16,
    channel: 0.18,
    relief: 0.24,
    absorb: 0.08,
    scale: 360,
    bgOpacity: 0.58,
    tint: [245, 246, 242]
  },
  glass: {
    id: 'glass',
    label: 'GLASS',
    hint: 'Ultra-slippery non-absorbent surface: paint hydroplanes & smears long.',
    slip: 0.96,
    resist: 0.04,
    channel: 0.02,
    relief: 0.06,
    absorb: 0.02,
    scale: 400,
    bgOpacity: 0.44,
    tint: [234, 243, 248]
  },
  custom: {
    id: 'custom',
    label: 'CUSTOM IMG',
    hint: 'Auto-extracted height, slope & crevices from your uploaded photo.',
    slip: 0.32,
    resist: 0.62,
    channel: 0.42,
    relief: 0.66,
    absorb: 0.60,
    scale: 380,
    bgOpacity: 0.78,
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

// Fast integer spatial hash [0..1)
function hash2i(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296.0;
}

function hash1(i, seed) {
  let h = (i * 1597334677 + seed * 3812015801) | 0;
  h = ((h ^ (h >>> 15)) * 2246822519) | 0;
  h = h ^ (h >>> 13);
  return (h >>> 0) / 4294967296.0;
}

/**
 * Toroidal periodic value noise on [0..1) domain — repeats seamlessly at period boundary.
 */
function torusNoise(u, v, period, seed) {
  const px = u * period;
  const py = v * period;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const sx = fx * fx * (3.0 - 2.0 * fx);
  const sy = fy * fy * (3.0 - 2.0 * fy);

  const ix0 = ((x0 % period) + period) % period;
  const iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period;
  const iy1 = (iy0 + 1) % period;

  const n00 = hash2i(ix0, iy0, seed);
  const n10 = hash2i(ix1, iy0, seed);
  const n01 = hash2i(ix0, iy1, seed);
  const n11 = hash2i(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
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
  const invert = !!opts.invertHeight;
  const slopeGain = opts.slopeGain !== undefined ? opts.slopeGain : 2.6;
  const shadeStrength = opts.shadeStrength !== undefined ? opts.shadeStrength : 0.22;
  const crackAoStrength = opts.crackAoStrength !== undefined ? opts.crackAoStrength : 0.28;
  const srcAlbedoRgba = opts.srcAlbedoRgba || null;

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

  // Pass 5 & 6: Toroidal 3x3 Sobel Normal + Cavity + Lit Surface Albedo
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
      const cavity = clamp01(Math.max(cBase, smoothstep(0.50, 0.08, h) * 0.85));

      mapRgba[idx4] = clampByte(h * 255.0);
      mapRgba[idx4 + 1] = clampByte((clamp01(gx * 0.5 + 0.5)) * 255.0);
      mapRgba[idx4 + 2] = clampByte((clamp01(gy * 0.5 + 0.5)) * 255.0);
      mapRgba[idx4 + 3] = clampByte(cavity * 255.0);

      // Directional surface shading (-0.65, -0.76) from top-left light source
      const ndotl = -gx * 0.65 - gy * 0.76;
      const shade = 1.0 + ndotl * shadeStrength - cavity * crackAoStrength * 0.45 + (h - 0.5) * shadeStrength * 0.45;

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

  return { mapRgba, colorRgba };
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
  // PASS 1 + PASS 2 + PASS 3 (Structure + Organic Undulation + Cracks/Creases)
  for (let y = 0; y < res; y++) {
    const v = y * invRes;
    const row = y * res;

    for (let x = 0; x < res; x++) {
      const u = x * invRes;
      const idx = row + x;

      // Pass 2 base multi-scale organic FBM field (toroidal, zero seams)
      const macroFbm = torusFbm(u, v, 4, 3, seed + 7);
      const midFbm = torusFbm(u, v, 16, 3, seed + 101);
      const fineNoise = torusNoise(u, v, 64, seed + 251);

      let h = 0.5;
      let crack = 0.0;

      if (type === 'paper') {
        // Cold-press cotton fiber deckle lumps + faint horizontal sheet creases
        const nWarp = macroFbm * 0.12;
        const nFine = torusFbm(u + nWarp, v + nWarp * 0.6, 24, 3, seed + 313);
        const tooth = torusFbm(u, v, 48, 2, seed + 409);
        const creaseWarp = Math.sin(u * Math.PI * 2.0 * 1.0 + macroFbm * 2.5) * 0.028;
        const creasePos = Math.abs(((v + creaseWarp + 0.25) % 1.0) - 0.5);
        const creaseMask = smoothstep(0.012, 0.001, creasePos) * smoothstep(0.32, 0.72, midFbm);
        h = 0.36 * macroFbm + 0.34 * nFine + 0.22 * tooth + 0.08 * fineNoise - creaseMask * 0.42;
        crack = creaseMask * 0.85;
      } else if (type === 'canvas') {
        // Orthogonal woven linen warp & weft basket pattern
        const warpFreq = 26.0;
        const warpPhase = (u + (macroFbm - 0.5) * 0.012) * Math.PI * 2.0 * warpFreq;
        const weftPhase = (v + (midFbm - 0.5) * 0.012) * Math.PI * 2.0 * warpFreq;
        const tx = Math.cos(warpPhase);
        const ty = Math.cos(weftPhase);
        // Flatten crown and sharpen interstitial pockets like true primed linen
        const threadX = Math.pow(Math.max(0.0, tx * 0.5 + 0.5), 0.72);
        const threadY = Math.pow(Math.max(0.0, ty * 0.5 + 0.5), 0.72);
        const basketCheck = Math.sin(warpPhase * 0.5) * Math.sin(weftPhase * 0.5);
        const weave = Math.max(threadX, threadY) * 0.72 + (threadX * threadY) * 0.28 + basketCheck * 0.14;
        const pit = smoothstep(0.42, 0.08, weave);
        h = weave * 0.74 + macroFbm * 0.14 + fineNoise * 0.12;
        crack = pit * 0.65;
      } else if (type === 'cloth') {
        // Heavy 2/2 diagonal twill + fuzzy textile fibers
        const freq = 24.0;
        const diagA = (2.0 * u + v + (macroFbm - 0.5) * 0.018) * Math.PI * 2.0 * freq;
        const diagB = (u - 2.0 * v + (midFbm - 0.5) * 0.018) * Math.PI * 2.0 * freq;
        const ribA = Math.pow(Math.max(0.0, Math.cos(diagA) * 0.5 + 0.5), 0.65);
        const ribB = Math.pow(Math.max(0.0, Math.cos(diagB) * 0.5 + 0.5), 0.75);
        const twill = ribA * 0.62 + ribB * 0.38;
        const fuzz = torusFbm(u * 1.5, v * 1.5, 48, 2, seed + 521);
        h = twill * 0.65 + fuzz * 0.25 + macroFbm * 0.10;
        crack = smoothstep(0.45, 0.12, twill) * 0.75;
      } else if (type === 'wood') {
        // Stretched periodic timber rings + subtle oval knot + vessel pores
        const ringWarp = (macroFbm - 0.5) * 0.26 + (midFbm - 0.5) * 0.07;
        // Toroidal knot center around (0.35, 0.55)
        let kdx = u - 0.35; if (kdx > 0.5) kdx -= 1.0; if (kdx < -0.5) kdx += 1.0;
        let kdy = v - 0.55; if (kdy > 0.5) kdy -= 1.0; if (kdy < -0.5) kdy += 1.0;
        const kDist = Math.hypot(kdx * 0.42, kdy * 1.6);
        const knotPush = Math.exp(-kDist * kDist * 28.0) * 0.16;

        const rVal = (v * 9.0 + ringWarp + knotPush) * Math.PI * 2.0;
        const latewood = Math.pow(Math.sin(rVal) * 0.5 + 0.5, 1.8);
        // Fine horizontal timber fibers stretched 8:1 along X
        const fibers = torusNoise((u * 4.0) % 1.0, (v * 64.0) % 1.0, 16, seed + 619);
        const vesselN = torusNoise((u * 3.0) % 1.0, (v * 40.0) % 1.0, 12, seed + 701);
        const pores = smoothstep(0.14, 0.02, vesselN) * (0.4 + 0.6 * latewood);
        h = 0.42 + latewood * 0.34 + fibers * 0.18 + macroFbm * 0.08 - pores * 0.48;
        crack = pores * 0.92;
      } else if (type === 'stone') {
        // Chiseled slate / travertine rock plateaus + sharp Voronoi fissures
        const uW = (u + (macroFbm - 0.5) * 0.07 + 1.0) % 1.0;
        const vW = (v + (midFbm - 0.5) * 0.07 + 1.0) % 1.0;
        const va = sampleTorusVoronoi(stoneVorA, uW, vW);
        const vb = sampleTorusVoronoi(stoneVorB, u, v);
        const majorCrack = smoothstep(0.055, 0.004, va.edge);
        const minorCrack = smoothstep(0.045, 0.005, vb.edge) * 0.55;
        const plateau = va.tone * 0.24 + (1.0 - va.f1 * 0.35) * 0.25 + midFbm * 0.30 + fineNoise * 0.21;
        h = plateau - majorCrack * 0.52 - minorCrack * 0.26;
        crack = clamp01(majorCrack + minorCrack * 0.65);
      } else if (type === 'ceramic') {
        // Smooth porcelain glaze with subtle hairline craquelure fissures
        const uW = (u + (macroFbm - 0.5) * 0.03 + 1.0) % 1.0;
        const vW = (v + (midFbm - 0.5) * 0.03 + 1.0) % 1.0;
        const vc = sampleTorusVoronoi(ceramicVor, uW, vW);
        const craze = smoothstep(0.024, 0.002, vc.edge);
        const glazeWave = macroFbm * 0.38 + midFbm * 0.16 + 0.46;
        h = glazeWave - craze * 0.44;
        crack = craze * 0.90;
      } else if (type === 'glass') {
        // Ultra-smooth optical float ripple + faint micro silica texture
        const wave = Math.sin((u * 2.0 + v * 1.0) * Math.PI * 2.0) * 0.06;
        h = 0.50 + macroFbm * 0.28 + wave + fineNoise * 0.08;
        crack = 0.0;
      }

      heightBuf[idx] = h;
      crackBuf[idx] = crack;
    }
  }

  const p4Start = performance.now();
  // PASS 4: Deterministic Mineral & Fiber Flecks / Specks (matches organic paper/stone inclusions)
  const speckCount = type === 'paper' ? 320 : (type === 'stone' ? 460 : (type === 'cloth' ? 220 : (type === 'ceramic' ? 95 : 0)));
  for (let s = 0; s < speckCount; s++) {
    const sx = (hash1(s, seed + 17) * res) | 0;
    const sy = (hash1(s, seed + 89) * res) | 0;
    const rad = hash1(s, seed + 233) > 0.86 ? 1 : 0;
    const kind = hash1(s, seed + 389);

    let sr = 72, sg = 68, sb = 64, sa = 0.55, dh = -0.04;
    if (type === 'paper') {
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

  const slopeGain = type === 'glass' ? 0.6 : (type === 'ceramic' ? 1.3 : 2.8);
  const shadeStrength = type === 'glass' ? 0.05 : (type === 'ceramic' ? 0.10 : (type === 'paper' ? 0.14 : 0.24));
  const crackAoStrength = type === 'paper' ? 0.16 : (type === 'ceramic' ? 0.22 : 0.30);

  const packed = finalizeSurfaceMaps(res, heightBuf, crackBuf, speckR, speckG, speckB, speckAmt, preset.tint, {
    invertHeight: !!opts.invertHeight,
    slopeGain,
    shadeStrength,
    crackAoStrength
  });

  const tEnd = performance.now();
  return {
    width: res,
    height: res,
    colorRgba: packed.colorRgba,
    mapRgba: packed.mapRgba,
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
      } else {
        tiledAlbedo[idx4] = clampByte(rBuf[idx]);
        tiledAlbedo[idx4 + 1] = clampByte(gBuf[idx]);
        tiledAlbedo[idx4 + 2] = clampByte(bBuf[idx]);
        tiledAlbedo[idx4 + 3] = 255;

        const relLum = lumBuf[idx] - lowLum[idx];
        const darkCrevice = clamp01((-relLum - 0.025) * 4.5);
        crackBuf[idx] = darkCrevice;
        heightBuf[idx] = 0.5 + relLum * 2.4 + (lumBuf[idx] - 0.5) * 0.35 - darkCrevice * 0.16;
      }
    }
  }

  const packed = finalizeSurfaceMaps(res, heightBuf, crackBuf, null, null, null, null, [255, 255, 255], {
    invertHeight,
    slopeGain: 2.8,
    shadeStrength: 0.18,
    crackAoStrength: 0.15,
    srcAlbedoRgba: tiledAlbedo
  });

  const tEnd = performance.now();
  return {
    width,
    height,
    colorRgba: packed.colorRgba,
    mapRgba: packed.mapRgba,
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
    this.seamless = true;
    this.invertHeight = false;
    this.seed = 1337;

    this.customDataUrl = null;
    this._customImage = null;

    this.width = SURFACE_TILE_RES;
    this.height = SURFACE_TILE_RES;
    this.colorRgba = null;
    this.mapRgba = null;
    this.lastGenMs = 0;
    this.version = 0;

    this._colorCanvas = null;
    this._heightCanvas = null;

    // WebGL2 state bound per-context (rebuilt cleanly on context loss/restore)
    this._gl = null;
    this._glColorTex = null;
    this._glMapTex = null;
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
    this.lastGenMs = result.genMs;
    this._colorCanvas = null;
    this._heightCanvas = null;
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

  ensureGpuTextures(gl) {
    if (!gl || !this.isActive || gl.isContextLost()) {
      return { colorTex: null, mapTex: null };
    }
    if (this._gl && this._gl !== gl) {
      this._glColorTex = null;
      this._glMapTex = null;
      this._uploadedVersion = -1;
    }
    this._gl = gl;

    if (!this._glColorTex || !this._glMapTex || this._uploadedVersion !== this.version) {
      if (!this._glColorTex) this._glColorTex = gl.createTexture();
      if (!this._glMapTex) this._glMapTex = gl.createTexture();

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
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._uploadedVersion = this.version;
    }

    return { colorTex: this._glColorTex, mapTex: this._glMapTex };
  }

  getShaderUniforms() {
    if (!this.isActive) {
      return {
        active: false,
        invScale: 1.0 / 320.0,
        slip: 0.5,
        resist: 0.0,
        channel: 0.0,
        relief: 0.0,
        absorb: 0.0,
        bgOpacity: 0.0
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
      bgOpacity: clamp01(this.bgOpacity)
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
    }
    this._gl = null;
    this._glColorTex = null;
    this._glMapTex = null;
    this._uploadedVersion = -1;
  }
}
