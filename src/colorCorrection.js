// Perceptual & Painterly Color Correction Engine
// Pure GPU 3D-LUT preview + exact per-pixel perceptual bake across OKLCH, OKLab, Painterly HDR, RYB, and RGB.

import { rgbToRyb, rybToRgb, isMobileDevice } from './colorUtils.js';
import {
  captureLayerSnapshot,
  releaseBackupCanvas
} from './engine/backupPool.js';

// ==================== FAST sRGB <-> LINEAR & OKLAB/OKLCH MATH ====================

const SRGB_TO_LIN_256 = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN_256[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbToLin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToSrgb(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// Warm-cool perceptual opponent axis (~36 deg in OKLab: Cool Cerulean <-> Warm Golden-Amber)
const WARM_COS = Math.cos(36 * Math.PI / 180);
const WARM_SIN = Math.sin(36 * Math.PI / 180);

function linRgbToOklabTriple(r, g, b, out) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(Math.max(0, l));
  const m_ = Math.cbrt(Math.max(0, m));
  const s_ = Math.cbrt(Math.max(0, s));

  out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
}

function oklabTripleToLinRaw(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
}

// Chroma-preserving binary gamut projection into Linear sRGB [0..1]
function oklabToLinGamutSafe(L, a, b, out) {
  if (L <= 0.0005) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
  if (L >= 0.9995) { out[0] = 1; out[1] = 1; out[2] = 1; return; }

  oklabTripleToLinRaw(L, a, b, out);
  const eps = -0.0005;
  const max1 = 1.0005;
  if (
    out[0] >= eps && out[0] <= max1 &&
    out[1] >= eps && out[1] <= max1 &&
    out[2] >= eps && out[2] <= max1
  ) {
    out[0] = clamp01(out[0]);
    out[1] = clamp01(out[1]);
    out[2] = clamp01(out[2]);
    return;
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 11; i++) {
    const mid = (lo + hi) * 0.5;
    oklabTripleToLinRaw(L, a * mid, b * mid, out);
    if (
      out[0] >= eps && out[0] <= max1 &&
      out[1] >= eps && out[1] <= max1 &&
      out[2] >= eps && out[2] <= max1
    ) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  oklabTripleToLinRaw(L, a * lo, b * lo, out);
  out[0] = clamp01(out[0]);
  out[1] = clamp01(out[1]);
  out[2] = clamp01(out[2]);
}

// ==================== SPACES, CHANNELS & PRESETS ====================

export const COLOR_CORRECTION_SPACES = {
  oklch: {
    id: 'oklch',
    label: 'OKLCH',
    hint: 'Perceptual Value, Chroma & Value-Locked Hue curves.',
    channels: [
      { id: 'l',  label: 'VALUE (L)',   bipolar: false, accent: '#f5f5f5', minLabel: 'DARK', maxLabel: 'LIGHT', desc: 'Human-eye perceptual Lightness curve.' },
      { id: 'c',  label: 'CHROMA (C)',  bipolar: false, accent: '#f43f5e', minLabel: 'GREY', maxLabel: 'PURE',  desc: 'Shapes color purity without shifting value.' },
      { id: 'cl', label: 'C VS VALUE',  bipolar: true,  accent: '#fb923c', minLabel: 'MUTE', maxLabel: 'RICH',  desc: 'Chroma multiplier across shadows (left) to highlights (right).' },
      { id: 'hl', label: 'HUE VS VAL',  bipolar: true,  accent: '#38bdf8', minLabel: '-60°', maxLabel: '+60°',  desc: 'Value-locked hue shift across shadows to highlights.' }
    ]
  },
  oklab: {
    id: 'oklab',
    label: 'OKLAB',
    hint: 'Perceptual Light (L), Temperature-by-Tone, & Opponent A/B axes.',
    channels: [
      { id: 'l',    label: 'LIGHT (L)',   bipolar: false, accent: '#f5f5f5', minLabel: 'DARK',  maxLabel: 'LIGHT', desc: 'Perceptual luminance curve (hue-preserving).' },
      { id: 'temp', label: 'TEMP VS VAL', bipolar: true,  accent: '#fbbf24', minLabel: 'COOL',  maxLabel: 'WARM',  desc: 'Pull shadows cool / push highlights warm at constant value.' },
      { id: 'a',    label: 'OPPONENT A',  bipolar: true,  accent: '#ec4899', minLabel: 'GREEN', maxLabel: 'MAG',   desc: 'Green <-> Red/Magenta perceptual shift by lightness.' },
      { id: 'b',    label: 'OPPONENT B',  bipolar: true,  accent: '#3b82f6', minLabel: 'BLUE',  maxLabel: 'GOLD',  desc: 'Blue <-> Yellow perceptual shift by lightness.' }
    ]
  },
  painterly: {
    id: 'painterly',
    label: 'PAINTERLY',
    hint: 'Natural HDR light curve, shadow/highlight warmth & chroma-driven dye bleed.',
    channels: [
      { id: 'light',      label: 'HDR LIGHT',    bipolar: false, accent: '#fde047', minLabel: 'SHADOW', maxLabel: 'LIGHT', desc: 'Filmic/HDR tone curve preserving warm highlight glow.' },
      { id: 'temp',       label: 'WARM / COOL',  bipolar: true,  accent: '#f97316', minLabel: 'COOL',   maxLabel: 'WARM',  desc: 'Temperature shift along shadow-to-highlight spectrum.' },
      { id: 'shadowRich', label: 'RICHNESS',     bipolar: true,  accent: '#22c55e', minLabel: 'PASTEL', maxLabel: 'DEEP',  desc: 'Perceptual chroma richness vs value.' },
      { id: 'chromaBleed',label: 'CHROMA BLEED', bipolar: true,  accent: '#c084fc', minLabel: 'DEEPEN', maxLabel: 'WARM',  desc: 'How color amount/purity (X) shifts light & warmth bleed.' }
    ]
  },
  ryb: {
    id: 'ryb',
    label: 'RYB',
    hint: 'Subtractive Painterly Red, Yellow, Blue pigment curves.',
    channels: [
      { id: 'master', label: 'DENSITY', bipolar: false, accent: '#e5e5e5', minLabel: 'THIN', maxLabel: 'HEAVY', desc: 'Overall subtractive pigment value curve.' },
      { id: 'r',      label: 'RED',     bipolar: false, accent: '#ef4444', minLabel: '0%',   maxLabel: '100%',  desc: 'Crimson / Red pigment response.' },
      { id: 'y',      label: 'YELLOW',  bipolar: false, accent: '#eab308', minLabel: '0%',   maxLabel: '100%',  desc: 'Ochre / Yellow pigment response.' },
      { id: 'b',      label: 'BLUE',    bipolar: false, accent: '#3b82f6', minLabel: '0%',   maxLabel: '100%',  desc: 'Ultramarine / Blue pigment response.' }
    ]
  },
  rgb: {
    id: 'rgb',
    label: 'RGB',
    hint: 'Classic display-referred RGB channel curves for comparison.',
    channels: [
      { id: 'master', label: 'MASTER', bipolar: false, accent: '#ffffff', minLabel: '0', maxLabel: '255', desc: 'Classic sRGB Master curve.' },
      { id: 'r',      label: 'RED',    bipolar: false, accent: '#f87171', minLabel: '0', maxLabel: '255', desc: 'Red sRGB channel.' },
      { id: 'g',      label: 'GREEN',  bipolar: false, accent: '#4ade80', minLabel: '0', maxLabel: '255', desc: 'Green sRGB channel.' },
      { id: 'b',      label: 'BLUE',   bipolar: false, accent: '#60a5fa', minLabel: '0', maxLabel: '255', desc: 'Blue sRGB channel.' }
    ]
  }
};

function defaultPoints(bipolar) {
  return bipolar
    ? [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]
    : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
}

export function createDefaultCurvesMap() {
  const curves = {};
  Object.values(COLOR_CORRECTION_SPACES).forEach(sp => {
    curves[sp.id] = {};
    sp.channels.forEach(ch => {
      curves[sp.id][ch.id] = defaultPoints(ch.bipolar);
    });
  });
  return curves;
}

export function createDefaultColorAdjustState() {
  return {
    activeSpace: 'oklch',
    activeChannels: {
      oklch: 'l',
      oklab: 'temp',
      painterly: 'light',
      ryb: 'master',
      rgb: 'master'
    },
    curves: createDefaultCurvesMap(),
    sliders: {
      exposure: 0,       // -2.0 .. +2.0 EV (HDR linear light)
      hdrRolloff: 35,    // 0 .. 100 % (filmic highlight shoulder)
      temp: 0,           // -100 .. +100 (perceptual OKLab cool<->warm)
      tint: 0,           // -100 .. +100 (perceptual OKLab green<->magenta)
      shadowTemp: 0,     // -100 .. +100 (split tone shadows)
      highlightTemp: 0,  // -100 .. +100 (split tone highlights)
      chroma: 0,         // -100 .. +100 %
      hueShift: 0,       // -180 .. +180 deg (value-locked OKLCH)
      chromaBleed: 0     // -100 .. +100 (purity-driven warmth & pigment bleed)
    },
    bwMode: false
  };
}

export function isCurveModified(pts, bipolar) {
  if (!Array.isArray(pts) || pts.length < 2) return false;
  if (pts.length > 2) return true;
  if (bipolar) {
    return Math.abs(pts[0].y - 0.5) > 0.004 || Math.abs(pts[1].y - 0.5) > 0.004 || Math.abs(pts[0].x) > 0.004 || Math.abs(pts[1].x - 1) > 0.004;
  }
  return Math.abs(pts[0].y) > 0.004 || Math.abs(pts[1].y - 1) > 0.004 || Math.abs(pts[0].x) > 0.004 || Math.abs(pts[1].x - 1) > 0.004;
}

export function isSpaceModified(state, spaceId) {
  const sp = COLOR_CORRECTION_SPACES[spaceId];
  if (!sp || !state?.curves?.[spaceId]) return false;
  for (let i = 0; i < sp.channels.length; i++) {
    const ch = sp.channels[i];
    if (isCurveModified(state.curves[spaceId][ch.id], ch.bipolar)) return true;
  }
  return false;
}

export function isDefaultColorAdjustState(state) {
  if (!state) return true;
  if (state.bwMode) return false;
  const s = state.sliders || {};
  if (
    Math.abs(s.exposure || 0) > 0.01 ||
    Math.abs(s.temp || 0) > 0.5 ||
    Math.abs(s.tint || 0) > 0.5 ||
    Math.abs(s.shadowTemp || 0) > 0.5 ||
    Math.abs(s.highlightTemp || 0) > 0.5 ||
    Math.abs(s.chroma || 0) > 0.5 ||
    Math.abs(s.hueShift || 0) > 0.5 ||
    Math.abs(s.chromaBleed || 0) > 0.5
  ) {
    return false;
  }
  for (const spId of Object.keys(COLOR_CORRECTION_SPACES)) {
    if (isSpaceModified(state, spId)) return false;
  }
  return true;
}

export const PAINTERLY_PRESETS = [
  {
    id: 'flat',
    label: 'FLAT',
    apply: () => createDefaultColorAdjustState()
  },
  {
    id: 'golden_hdr',
    label: 'GOLDEN HDR',
    apply: () => {
      const st = createDefaultColorAdjustState();
      st.activeSpace = 'painterly';
      st.sliders.exposure = 0.35;
      st.sliders.hdrRolloff = 68;
      st.sliders.temp = 18;
      st.sliders.shadowTemp = -24;
      st.sliders.highlightTemp = 42;
      st.sliders.chroma = 14;
      st.sliders.chromaBleed = 26;
      st.curves.painterly.light = [{ x: 0, y: 0.02 }, { x: 0.32, y: 0.28 }, { x: 0.72, y: 0.80 }, { x: 1, y: 1 }];
      st.curves.painterly.temp = [{ x: 0, y: 0.42 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.70 }];
      return st;
    }
  },
  {
    id: 'cool_warm',
    label: 'COOL / WARM',
    apply: () => {
      const st = createDefaultColorAdjustState();
      st.activeSpace = 'oklab';
      st.sliders.hdrRolloff = 45;
      st.sliders.shadowTemp = -48;
      st.sliders.highlightTemp = 44;
      st.sliders.chroma = 10;
      st.curves.oklab.temp = [{ x: 0, y: 0.28 }, { x: 0.45, y: 0.48 }, { x: 1, y: 0.72 }];
      st.curves.oklch.cl = [{ x: 0, y: 0.62 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.38 }];
      return st;
    }
  },
  {
    id: 'filmic',
    label: 'FILMIC HDR',
    apply: () => {
      const st = createDefaultColorAdjustState();
      st.activeSpace = 'oklch';
      st.sliders.exposure = 0.22;
      st.sliders.hdrRolloff = 82;
      st.sliders.chroma = -6;
      st.sliders.chromaBleed = 14;
      st.curves.oklch.l = [{ x: 0, y: 0.04 }, { x: 0.25, y: 0.21 }, { x: 0.75, y: 0.80 }, { x: 1, y: 0.96 }];
      st.curves.oklch.cl = [{ x: 0, y: 0.58 }, { x: 0.65, y: 0.52 }, { x: 1, y: 0.34 }];
      return st;
    }
  },
  {
    id: 'gouache',
    label: 'GOUACHE',
    apply: () => {
      const st = createDefaultColorAdjustState();
      st.activeSpace = 'oklch';
      st.sliders.hdrRolloff = 55;
      st.sliders.temp = 8;
      st.sliders.chroma = -14;
      st.sliders.chromaBleed = -22;
      st.curves.oklch.l = [{ x: 0, y: 0.08 }, { x: 0.4, y: 0.44 }, { x: 0.85, y: 0.88 }, { x: 1, y: 0.96 }];
      return st;
    }
  },
  {
    id: 'ink_dramatic',
    label: 'DEEP INK',
    apply: () => {
      const st = createDefaultColorAdjustState();
      st.activeSpace = 'oklch';
      st.sliders.exposure = -0.15;
      st.sliders.hdrRolloff = 50;
      st.sliders.shadowTemp = -22;
      st.sliders.chroma = 24;
      st.sliders.chromaBleed = -34;
      st.curves.oklch.l = [{ x: 0, y: 0 }, { x: 0.25, y: 0.16 }, { x: 0.7, y: 0.76 }, { x: 1, y: 1 }];
      st.curves.oklch.cl = [{ x: 0, y: 0.72 }, { x: 0.5, y: 0.54 }, { x: 1, y: 0.42 }];
      return st;
    }
  }
];

// ==================== MONOTONE CUBIC SPLINE & CURVE LUT ====================

export function evaluateMonotoneSpline(sortedPts, x) {
  const n = sortedPts.length;
  if (n === 0) return x;
  if (n === 1) return sortedPts[0].y;
  if (x <= sortedPts[0].x) return sortedPts[0].y;
  if (x >= sortedPts[n - 1].x) return sortedPts[n - 1].y;

  const dx = new Float64Array(n - 1);
  const dy = new Float64Array(n - 1);
  const m = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-5, sortedPts[i + 1].x - sortedPts[i].x);
    dy[i] = sortedPts[i + 1].y - sortedPts[i].y;
    m[i] = dy[i] / dx[i];
  }

  const tangents = new Float64Array(n);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-6) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / m[i];
      const b = tangents[i + 1] / m[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        tangents[i] = t * a * m[i];
        tangents[i + 1] = t * b * m[i];
      }
    }
  }

  let seg = 0;
  for (let i = 0; i < n - 1; i++) {
    if (x >= sortedPts[i].x && x <= sortedPts[i + 1].x) {
      seg = i;
      break;
    }
  }
  const h = dx[seg];
  const t = (x - sortedPts[seg].x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return clamp01(
    h00 * sortedPts[seg].y +
    h10 * h * tangents[seg] +
    h01 * sortedPts[seg + 1].y +
    h11 * h * tangents[seg + 1]
  );
}

export function buildCurveLut(points, size = 256) {
  const sorted = (points && points.length >= 2)
    ? [...points].sort((a, b) => a.x - b.x)
    : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    lut[i] = evaluateMonotoneSpline(sorted, x);
  }
  return lut;
}

function sampleLut(lut, x) {
  const n = lut.length - 1;
  const pos = clamp01(x) * n;
  const idx = Math.min(n - 1, pos | 0);
  const frac = pos - idx;
  return lut[idx] + (lut[idx + 1] - lut[idx]) * frac;
}

// ==================== COMPILED PIPELINE & 3D LUT ====================

export function compileColorAdjustState(state, levelsConfig = null) {
  const st = state || createDefaultColorAdjustState();
  const s = st.sliders || {};

  let hasLevels = false;
  let levelsLutR = null;
  let levelsLutG = null;
  let levelsLutB = null;
  let levelsBW = false;
  if (levelsConfig) {
    const build1 = (cfg) => {
      const lut = new Float32Array(256);
      const range = (cfg.white - cfg.black) || 1;
      const invGamma = 1 / (cfg.gamma || 1);
      for (let i = 0; i < 256; i++) {
        let v = clamp01((i - cfg.black) / range);
        if (cfg.gamma !== 1) v = Math.pow(v, invGamma);
        lut[i] = clamp01((cfg.outblack + v * (cfg.outwhite - cfg.outblack)) / 255);
      }
      return lut;
    };
    const allC = levelsConfig.all;
    const isChanMod = (c) => c && (c.black !== 0 || Math.abs(c.gamma - 1) > 0.005 || c.white !== 255 || c.outblack !== 0 || c.outwhite !== 255);
    levelsBW = !!levelsConfig.bwMode;
    if (levelsBW || isChanMod(allC) || isChanMod(levelsConfig.r) || isChanMod(levelsConfig.g) || isChanMod(levelsConfig.b)) {
      hasLevels = true;
      const lAll = build1(allC);
      const lR = build1(levelsConfig.r);
      const lG = build1(levelsConfig.g);
      const lB = build1(levelsConfig.b);
      levelsLutR = new Float32Array(256);
      levelsLutG = new Float32Array(256);
      levelsLutB = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const m = Math.round(lAll[i] * 255);
        levelsLutR[i] = lR[m];
        levelsLutG[i] = lG[m];
        levelsLutB[i] = lB[m];
      }
    }
  }

  const luts = {
    rgb: {
      master: buildCurveLut(st.curves.rgb.master),
      r: buildCurveLut(st.curves.rgb.r),
      g: buildCurveLut(st.curves.rgb.g),
      b: buildCurveLut(st.curves.rgb.b),
      active: isSpaceModified(st, 'rgb')
    },
    ryb: {
      master: buildCurveLut(st.curves.ryb.master),
      r: buildCurveLut(st.curves.ryb.r),
      y: buildCurveLut(st.curves.ryb.y),
      b: buildCurveLut(st.curves.ryb.b),
      active: isSpaceModified(st, 'ryb')
    },
    oklab: {
      l: buildCurveLut(st.curves.oklab.l),
      temp: buildCurveLut(st.curves.oklab.temp),
      a: buildCurveLut(st.curves.oklab.a),
      b: buildCurveLut(st.curves.oklab.b),
      active: isSpaceModified(st, 'oklab')
    },
    oklch: {
      l: buildCurveLut(st.curves.oklch.l),
      c: buildCurveLut(st.curves.oklch.c),
      cl: buildCurveLut(st.curves.oklch.cl),
      hl: buildCurveLut(st.curves.oklch.hl),
      active: isSpaceModified(st, 'oklch')
    },
    painterly: {
      light: buildCurveLut(st.curves.painterly.light),
      temp: buildCurveLut(st.curves.painterly.temp),
      shadowRich: buildCurveLut(st.curves.painterly.shadowRich),
      chromaBleed: buildCurveLut(st.curves.painterly.chromaBleed),
      active: isSpaceModified(st, 'painterly')
    }
  };

  return {
    hasLevels,
    levelsLutR,
    levelsLutG,
    levelsLutB,
    levelsBW,
    luts,
    exposureGain: Math.pow(2, Number(s.exposure) || 0),
    hasExposure: Math.abs(Number(s.exposure) || 0) > 0.005,
    hdrRolloff: clamp01((Number(s.hdrRolloff) ?? 35) / 100),
    temp: (Number(s.temp) || 0) / 100,
    tint: (Number(s.tint) || 0) / 100,
    shadowTemp: (Number(s.shadowTemp) || 0) / 100,
    highlightTemp: (Number(s.highlightTemp) || 0) / 100,
    chroma: (Number(s.chroma) || 0) / 100,
    hueShiftRad: ((Number(s.hueShift) || 0) * Math.PI) / 180,
    chromaBleed: (Number(s.chromaBleed) || 0) / 100,
    bwMode: !!st.bwMode
  };
}

const _labTmp = new Float64Array(3);
const _linTmp = new Float64Array(3);

export function evaluatePerceptualPixel(r255, g255, b255, c, outRgb255) {
  let r01 = r255 / 255;
  let g01 = g255 / 255;
  let b01 = b255 / 255;

  if (c.hasLevels) {
    r01 = c.levelsLutR[r255];
    g01 = c.levelsLutG[g255];
    b01 = c.levelsLutB[b255];
    if (c.levelsBW) {
      const lum = 0.299 * r01 + 0.587 * g01 + 0.114 * b01;
      r01 = lum; g01 = lum; b01 = lum;
    }
  }

  if (c.luts.rgb.active) {
    r01 = sampleLut(c.luts.rgb.r, sampleLut(c.luts.rgb.master, r01));
    g01 = sampleLut(c.luts.rgb.g, sampleLut(c.luts.rgb.master, g01));
    b01 = sampleLut(c.luts.rgb.b, sampleLut(c.luts.rgb.master, b01));
  }

  if (c.luts.ryb.active) {
    const ryb = rgbToRyb(r01 * 255, g01 * 255, b01 * 255);
    const rr = sampleLut(c.luts.ryb.r, sampleLut(c.luts.ryb.master, ryb.r / 100)) * 100;
    const yy = sampleLut(c.luts.ryb.y, sampleLut(c.luts.ryb.master, ryb.y / 100)) * 100;
    const bb = sampleLut(c.luts.ryb.b, sampleLut(c.luts.ryb.master, ryb.b / 100)) * 100;
    const back = rybToRgb(rr, yy, bb);
    r01 = back.r / 255;
    g01 = back.g / 255;
    b01 = back.b / 255;
  }

  let lr = srgbToLin(r01);
  let lg = srgbToLin(g01);
  let lb = srgbToLin(b01);

  if (c.hasExposure) {
    const gain = c.exposureGain;
    lr *= gain;
    lg *= gain;
    lb *= gain;

    const ro = c.hdrRolloff;
    if (gain > 1.0 && ro > 0.01) {
      const maxChan = Math.max(lr, lg, lb);
      if (maxChan > 0.65) {
        const knee = 0.65;
        const shoulderStrength = 0.55 + ro * 1.45;
        const over = maxChan - knee;
        const compressed = knee + (over / (1 + over * shoulderStrength)) * (1 - knee + 0.12);
        const scale = compressed / maxChan;
        const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        const desat = Math.min(0.65, (maxChan - 1.0) * 0.28 * ro);
        lr *= scale;
        lg *= scale;
        lb *= scale;
        if (desat > 0) {
          const lumScaled = clamp01(lum * scale);
          lr += (lumScaled - lr) * desat;
          lg += (lumScaled - lg) * desat;
          lb += (lumScaled - lb) * desat;
        }
      }
    }
    lr = Math.max(0, lr);
    lg = Math.max(0, lg);
    lb = Math.max(0, lb);
  }

  linRgbToOklabTriple(lr, lg, lb, _labTmp);
  let L = _labTmp[0];
  let a = _labTmp[1];
  let b = _labTmp[2];

  if (L < 0) L = 0;

  if (c.luts.painterly.active) {
    L = sampleLut(c.luts.painterly.light, L);
  }
  if (c.luts.oklab.active) {
    L = sampleLut(c.luts.oklab.l, L);
  }
  if (c.luts.oklch.active) {
    L = sampleLut(c.luts.oklch.l, L);
  }

  let C = Math.hypot(a, b);
  let H = Math.atan2(b, a);
  const cNorm = clamp01(C / 0.34);

  if (c.luts.oklch.active) {
    const cMapped = sampleLut(c.luts.oklch.c, cNorm) * 0.34;
    const clMult = Math.pow(2, (sampleLut(c.luts.oklch.cl, L) - 0.5) * 2.2);
    C = cMapped * clMult;
    const hlDelta = (sampleLut(c.luts.oklch.hl, L) - 0.5) * (Math.PI * 2 / 3);
    H += hlDelta;
  }

  if (c.luts.painterly.active) {
    const richMult = Math.pow(2, (sampleLut(c.luts.painterly.shadowRich, L) - 0.5) * 2.0);
    C *= richMult;
    // Purity-driven chroma bleed: amount of color C alters warmth & subtle value response (0ms spatial cost!)
    const bleedDelta = (sampleLut(c.luts.painterly.chromaBleed, cNorm) - 0.5) * 2.0;
    if (Math.abs(bleedDelta) > 0.002) {
      L = clamp01(L + bleedDelta * 0.14 * cNorm);
      H += bleedDelta * 0.25 * cNorm;
    }
  }

  if (Math.abs(c.chromaBleed) > 0.005 && cNorm > 0.01) {
    // Saturated pigments either glow/warm into paper light (+), or deepen into rich velvet pigment (-)
    L = clamp01(L + c.chromaBleed * 0.16 * cNorm * (1 - L * 0.45));
  }

  if (Math.abs(c.chroma) > 0.005) {
    if (c.chroma > 0) {
      const satNorm = clamp01(C / 0.32);
      const vibranceWeight = 1.0 - satNorm * 0.45;
      C = C * (1 + c.chroma * 1.15 * vibranceWeight);
    } else {
      C = C * Math.max(0, 1 + c.chroma);
    }
  }

  if (Math.abs(c.hueShiftRad) > 0.001) {
    H += c.hueShiftRad;
  }

  a = C * Math.cos(H);
  b = C * Math.sin(H);

  const midMask = Math.min(1, L * 4.5) * Math.min(1, (1 - L) * 5.0 + 0.15);

  let warmShift = c.temp * 0.11 * midMask;
  if (Math.abs(c.shadowTemp) > 0.005) {
    const shW = (1 - L) * (1 - L) * Math.min(1, L * 6 + 0.2);
    warmShift += c.shadowTemp * 0.11 * shW;
  }
  if (Math.abs(c.highlightTemp) > 0.005) {
    const hiW = L * L * Math.min(1, (1 - L) * 5 + 0.25);
    warmShift += c.highlightTemp * 0.11 * hiW;
  }
  if (c.luts.oklab.active) {
    warmShift += (sampleLut(c.luts.oklab.temp, L) - 0.5) * 0.18 * midMask;
    a += (sampleLut(c.luts.oklab.a, L) - 0.5) * 0.22 * midMask;
    b += (sampleLut(c.luts.oklab.b, L) - 0.5) * 0.22 * midMask;
  }
  if (c.luts.painterly.active) {
    warmShift += (sampleLut(c.luts.painterly.temp, L) - 0.5) * 0.18 * midMask;
  }
  if (Math.abs(c.chromaBleed) > 0.005 && cNorm > 0.01) {
    warmShift += c.chromaBleed * 0.075 * cNorm * midMask;
  }

  if (Math.abs(warmShift) > 1e-5 || Math.abs(c.tint) > 0.005) {
    const orthoShift = c.tint * 0.095 * midMask;
    a += warmShift * WARM_COS - orthoShift * WARM_SIN;
    b += warmShift * WARM_SIN + orthoShift * WARM_COS;
  }

  if (c.bwMode) {
    a = 0;
    b = 0;
  }

  oklabToLinGamutSafe(clamp01(L), a, b, _linTmp);

  const sR = clamp01(linToSrgb(_linTmp[0]));
  const sG = clamp01(linToSrgb(_linTmp[1]));
  const sB = clamp01(linToSrgb(_linTmp[2]));

  outRgb255[0] = Math.round(sR * 255);
  outRgb255[1] = Math.round(sG * 255);
  outRgb255[2] = Math.round(sB * 255);
}

// Fast 21x21x21 3D LUT cube (~9,261 samples, 27KB Uint8Array for instant WebGL2 sampler3D upload!)
export const CC_LUT_SIZE = 21;
const CUBE_STEP = 255 / (CC_LUT_SIZE - 1);

export function buildColorCubeLut(compiled) {
  const lut = new Uint8Array(CC_LUT_SIZE * CC_LUT_SIZE * CC_LUT_SIZE * 3);
  const tmpOut = new Float64Array(3);
  let ptr = 0;
  for (let bi = 0; bi < CC_LUT_SIZE; bi++) {
    const b255 = Math.round(bi * CUBE_STEP);
    for (let gi = 0; gi < CC_LUT_SIZE; gi++) {
      const g255 = Math.round(gi * CUBE_STEP);
      for (let ri = 0; ri < CC_LUT_SIZE; ri++) {
        const r255 = Math.round(ri * CUBE_STEP);
        evaluatePerceptualPixel(r255, g255, b255, compiled, tmpOut);
        lut[ptr++] = tmpOut[0];
        lut[ptr++] = tmpOut[1];
        lut[ptr++] = tmpOut[2];
      }
    }
  }
  return lut;
}

export function buildColorStripLutRgba(compiled) {
  const N = CC_LUT_SIZE;
  const stripW = N * N;
  const lut = new Uint8Array(stripW * N * 4);
  const tmpOut = new Float64Array(3);
  for (let bi = 0; bi < N; bi++) {
    const b255 = Math.round(bi * CUBE_STEP);
    for (let gi = 0; gi < N; gi++) {
      const g255 = Math.round(gi * CUBE_STEP);
      const rowBase = gi * stripW + bi * N;
      for (let ri = 0; ri < N; ri++) {
        const r255 = Math.round(ri * CUBE_STEP);
        evaluatePerceptualPixel(r255, g255, b255, compiled, tmpOut);
        const idx = (rowBase + ri) * 4;
        lut[idx] = tmpOut[0];
        lut[idx + 1] = tmpOut[1];
        lut[idx + 2] = tmpOut[2];
        lut[idx + 3] = 255;
      }
    }
  }
  return lut;
}

function sampleCube3D(lut, r255, g255, b255, out) {
  const scale = (CC_LUT_SIZE - 1) / 255;
  const fx = r255 * scale;
  const fy = g255 * scale;
  const fz = b255 * scale;

  const x0 = Math.min(CC_LUT_SIZE - 2, fx | 0);
  const y0 = Math.min(CC_LUT_SIZE - 2, fy | 0);
  const z0 = Math.min(CC_LUT_SIZE - 2, fz | 0);

  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;

  const sY = CC_LUT_SIZE * 3;
  const sZ = CC_LUT_SIZE * CC_LUT_SIZE * 3;
  const i000 = x0 * 3 + y0 * sY + z0 * sZ;
  const i100 = i000 + 3;
  const i010 = i000 + sY;
  const i110 = i010 + 3;
  const i001 = i000 + sZ;
  const i101 = i001 + 3;
  const i011 = i010 + sZ;
  const i111 = i011 + 3;

  const itx = 1 - tx;
  const ity = 1 - ty;
  const itz = 1 - tz;

  const w000 = itx * ity * itz;
  const w100 = tx * ity * itz;
  const w010 = itx * ty * itz;
  const w110 = tx * ty * itz;
  const w001 = itx * ity * tz;
  const w101 = tx * ity * tz;
  const w011 = itx * ty * tz;
  const w111 = tx * ty * tz;

  out[0] = Math.round(lut[i000] * w000 + lut[i100] * w100 + lut[i010] * w010 + lut[i110] * w110 +
           lut[i001] * w001 + lut[i101] * w101 + lut[i011] * w011 + lut[i111] * w111);
  out[1] = Math.round(lut[i000 + 1] * w000 + lut[i100 + 1] * w100 + lut[i010 + 1] * w010 + lut[i110 + 1] * w110 +
           lut[i001 + 1] * w001 + lut[i101 + 1] * w101 + lut[i011 + 1] * w011 + lut[i111 + 1] * w111);
  out[2] = Math.round(lut[i000 + 2] * w000 + lut[i100 + 2] * w100 + lut[i010 + 2] * w010 + lut[i110 + 2] * w110 +
           lut[i001 + 2] * w001 + lut[i101 + 2] * w101 + lut[i011 + 2] * w011 + lut[i111 + 2] * w111);
}

export function applyColorAdjustToBuffer(srcData, destData, imgW, imgH, state, options = {}) {
  const compiled = options.compiled || compileColorAdjustState(state, options.levelsConfig || null);
  const cube = options.cube || (options.exact ? null : buildColorCubeLut(compiled));
  const out3 = new Float64Array(3);

  const bounds = options.bounds || null;
  if (bounds) {
    const minX = Math.max(0, bounds.minX);
    const minY = Math.max(0, bounds.minY);
    const maxX = Math.min(imgW - 1, bounds.maxX);
    const maxY = Math.min(imgH - 1, bounds.maxY);

    for (let y = minY; y <= maxY; y++) {
      let idx = (y * imgW + minX) * 4;
      for (let x = minX; x <= maxX; x++, idx += 4) {
        const a = srcData[idx + 3];
        if (a === 0) {
          destData[idx] = 0; destData[idx + 1] = 0; destData[idx + 2] = 0; destData[idx + 3] = 0;
          continue;
        }
        if (cube) {
          sampleCube3D(cube, srcData[idx], srcData[idx + 1], srcData[idx + 2], out3);
        } else {
          evaluatePerceptualPixel(srcData[idx], srcData[idx + 1], srcData[idx + 2], compiled, out3);
        }
        destData[idx]     = out3[0];
        destData[idx + 1] = out3[1];
        destData[idx + 2] = out3[2];
        destData[idx + 3] = a;
      }
    }
  } else {
    for (let i = 0; i < srcData.length; i += 4) {
      const a = srcData[i + 3];
      if (a === 0) {
        destData[i] = 0; destData[i + 1] = 0; destData[i + 2] = 0; destData[i + 3] = 0;
        continue;
      }
      if (cube) {
        sampleCube3D(cube, srcData[i], srcData[i + 1], srcData[i + 2], out3);
      } else {
        evaluatePerceptualPixel(srcData[i], srcData[i + 1], srcData[i + 2], compiled, out3);
      }
      destData[i]     = out3[0];
      destData[i + 1] = out3[1];
      destData[i + 2] = out3[2];
      destData[i + 3] = a;
    }
  }
}

export function computeHistogramBins(rgba, bins = 64) {
  const hist = new Float32Array(bins);
  if (!rgba || rgba.length < 4) return hist;
  const totalPixels = rgba.length >> 2;
  const stride = Math.max(1, Math.floor(totalPixels / 12000)) * 4;
  let maxVal = 0;
  for (let i = 0; i < rgba.length; i += stride) {
    if (rgba[i + 3] < 8) continue;
    const lr = SRGB_TO_LIN_256[rgba[i]];
    const lg = SRGB_TO_LIN_256[rgba[i + 1]];
    const lb = SRGB_TO_LIN_256[rgba[i + 2]];
    const L = Math.cbrt(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
    const bIdx = Math.min(bins - 1, Math.max(0, Math.floor(L * (bins - 1))));
    hist[bIdx] += 1;
    if (hist[bIdx] > maxVal) maxVal = hist[bIdx];
  }
  if (maxVal > 0) {
    for (let i = 0; i < bins; i++) {
      hist[i] = Math.pow(hist[i] / maxVal, 0.7);
    }
  }
  return hist;
}

// ==================== INTERACTIVE SPLINE CURVE WIDGET ====================

export class CurveEditor {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.readoutEl = options.readoutEl || null;
    this.onChange = options.onChange || null;
    this.showHistogram = options.showHistogram !== false;
    this.histogram = null;

    this.state = options.state || createDefaultColorAdjustState();
    this.dragIndex = -1;
    this.hoverIndex = -1;
    this.selectedIndex = -1;

    if (this.canvas) {
      this._bindEvents();
      this.draw();
    }
  }

  setState(state) {
    this.state = state;
    this.dragIndex = -1;
    this.selectedIndex = -1;
    this.draw();
  }

  setHistogram(bins) {
    this.histogram = bins || null;
    this.draw();
  }

  getActiveChannelSpec() {
    const sp = COLOR_CORRECTION_SPACES[this.state.activeSpace] || COLOR_CORRECTION_SPACES.oklch;
    const chId = this.state.activeChannels[sp.id] || sp.channels[0].id;
    const ch = sp.channels.find(c => c.id === chId) || sp.channels[0];
    return { space: sp, channel: ch };
  }

  getActivePoints() {
    const { space, channel } = this.getActiveChannelSpec();
    return this.state.curves[space.id][channel.id];
  }

  _bindEvents() {
    const pad = 12;
    const getNormCoords = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const nx = clamp01((px - pad) / Math.max(1, w - pad * 2));
      const ny = clamp01(1 - (py - pad) / Math.max(1, h - pad * 2));
      return { nx, ny, rectW: w, rectH: h };
    };

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { nx, ny, rectW, rectH } = getNormCoords(e);
      const pts = this.getActivePoints();
      const hit = this._findHitPoint(pts, nx, ny, rectW - pad * 2, rectH - pad * 2);
      if (hit > 0 && hit < pts.length - 1) {
        pts.splice(hit, 1);
        this.selectedIndex = -1;
        this.draw();
        if (this.onChange) this.onChange(pts, { dragging: false });
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const { nx, ny, rectW, rectH } = getNormCoords(e);
      const pts = this.getActivePoints();
      const hit = this._findHitPoint(pts, nx, ny, rectW - pad * 2, rectH - pad * 2);
      if (hit > 0 && hit < pts.length - 1) {
        pts.splice(hit, 1);
        this.selectedIndex = -1;
        this.draw();
        if (this.onChange) this.onChange(pts, { dragging: false });
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}

      const { nx, ny, rectW, rectH } = getNormCoords(e);
      const pts = this.getActivePoints();
      pts.sort((a, b) => a.x - b.x);
      let hit = this._findHitPoint(pts, nx, ny, rectW - pad * 2, rectH - pad * 2);

      if (hit === -1 && pts.length < 16) {
        pts.push({ x: nx, y: ny });
        pts.sort((a, b) => a.x - b.x);
        hit = pts.findIndex(p => p.x === nx && p.y === ny);
      }

      this.dragIndex = hit;
      this.selectedIndex = hit;
      this.draw();
      if (this.onChange) this.onChange(pts, { dragging: true });
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const { nx, ny, rectW, rectH } = getNormCoords(e);
      const pts = this.getActivePoints();

      if (this.dragIndex >= 0 && this.dragIndex < pts.length) {
        const idx = this.dragIndex;
        if (idx === 0) {
          pts[idx].x = 0;
        } else if (idx === pts.length - 1) {
          pts[idx].x = 1;
        } else {
          const minX = pts[idx - 1].x + 0.015;
          const maxX = pts[idx + 1].x - 0.015;
          pts[idx].x = Math.max(minX, Math.min(maxX, nx));
        }
        pts[idx].y = ny;
        this.draw();
        if (this.onChange) this.onChange(pts, { dragging: true });
      } else {
        const hit = this._findHitPoint(pts, nx, ny, rectW - pad * 2, rectH - pad * 2);
        if (hit !== this.hoverIndex) {
          this.hoverIndex = hit;
          this.draw();
        }
      }
    });

    const finishDrag = (e) => {
      if (this.dragIndex >= 0) {
        this.dragIndex = -1;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        this.draw();
        if (this.onChange) this.onChange(this.getActivePoints(), { dragging: false });
      }
    };

    this.canvas.addEventListener('pointerup', finishDrag);
    this.canvas.addEventListener('pointercancel', finishDrag);
    this.canvas.addEventListener('pointerleave', () => {
      if (this.dragIndex < 0 && this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.draw();
      }
    });
  }

  _findHitPoint(pts, nx, ny, plotW, plotH) {
    let best = -1;
    let bestDist = 16;
    for (let i = 0; i < pts.length; i++) {
      const dx = (pts[i].x - nx) * plotW;
      const dy = (pts[i].y - ny) * plotH;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  resetActiveCurve() {
    const { space, channel } = this.getActiveChannelSpec();
    this.state.curves[space.id][channel.id] = defaultPoints(channel.bipolar);
    this.selectedIndex = -1;
    this.draw();
    if (this.onChange) this.onChange(this.getActivePoints(), { dragging: false });
  }

  addMidpoint() {
    const pts = this.getActivePoints();
    pts.sort((a, b) => a.x - b.x);
    const hasMid = pts.some(p => Math.abs(p.x - 0.5) < 0.05);
    if (!hasMid) {
      const lut = buildCurveLut(pts, 64);
      const yVal = sampleLut(lut, 0.5);
      pts.push({ x: 0.5, y: yVal });
      pts.sort((a, b) => a.x - b.x);
      this.selectedIndex = pts.findIndex(p => Math.abs(p.x - 0.5) < 0.001);
      this.draw();
      if (this.onChange) this.onChange(pts, { dragging: false });
    }
  }

  draw() {
    if (!this.canvas || !this.ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || this.canvas.width || 260;
    const cssH = this.canvas.clientHeight || this.canvas.height || 210;
    if (cssW < 10 || cssH < 10) return;

    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    const w = cssW;
    const h = cssH;
    const pad = 12;
    const pw = w - pad * 2;
    const ph = h - pad * 2;
    const toX = (nx) => pad + nx * pw;
    const toY = (ny) => pad + (1 - ny) * ph;

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    if (this.showHistogram && this.histogram) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
      const n = this.histogram.length;
      const bw = pw / n;
      for (let i = 0; i < n; i++) {
        const val = this.histogram[i];
        if (val <= 0.005) continue;
        const bh = val * ph * 0.72;
        ctx.fillRect(pad + i * bw, pad + ph - bh, Math.ceil(bw), bh);
      }
    }

    const { space, channel } = this.getActiveChannelSpec();

    if (channel.id === 'temp' || channel.id === 'chromaBleed') {
      const grad = ctx.createLinearGradient(0, pad, 0, pad + ph);
      grad.addColorStop(0, 'rgba(251, 146, 60, 0.85)');
      grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.25)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(pad - 6, pad, 3, ph);
    } else if (channel.id === 'hl') {
      const grad = ctx.createLinearGradient(0, pad, 0, pad + ph);
      grad.addColorStop(0, '#f43f5e');
      grad.addColorStop(0.33, '#facc15');
      grad.addColorStop(0.66, '#38bdf8');
      grad.addColorStop(1, '#a855f7');
      ctx.fillStyle = grad;
      ctx.fillRect(pad - 6, pad, 3, ph);
    } else {
      ctx.fillStyle = channel.accent || '#ffffff';
      ctx.globalAlpha = 0.65;
      ctx.fillRect(pad - 6, pad, 3, ph);
      ctx.globalAlpha = 1;
    }

    const xGrad = ctx.createLinearGradient(pad, 0, pad + pw, 0);
    xGrad.addColorStop(0, '#18181b');
    xGrad.addColorStop(0.5, '#71717a');
    xGrad.addColorStop(1, '#fafafa');
    ctx.fillStyle = xGrad;
    ctx.fillRect(pad, pad + ph + 4, pw, 3);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const gx = pad + (pw * i) / 4;
      const gy = pad + (ph * i) / 4;
      ctx.moveTo(gx, pad); ctx.lineTo(gx, pad + ph);
      ctx.moveTo(pad, gy); ctx.lineTo(pad + pw, gy);
    }
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    if (channel.bipolar) {
      ctx.moveTo(toX(0), toY(0.5));
      ctx.lineTo(toX(1), toY(0.5));
    } else {
      ctx.moveTo(toX(0), toY(0));
      ctx.lineTo(toX(1), toY(1));
    }
    ctx.stroke();
    ctx.restore();

    space.channels.forEach(otherCh => {
      if (otherCh.id === channel.id) return;
      const pts = this.state.curves[space.id][otherCh.id];
      if (!isCurveModified(pts, otherCh.bipolar)) return;
      const lut = buildCurveLut(pts, 64);
      ctx.save();
      ctx.strokeStyle = otherCh.accent || '#888';
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 64; i++) {
        const px = toX(i / 63);
        const py = toY(lut[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    });

    const activePts = this.getActivePoints();
    const sorted = [...activePts].sort((a, b) => a.x - b.x);
    const activeLut = buildCurveLut(sorted, 96);

    ctx.strokeStyle = channel.accent || '#ffffff';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let i = 0; i < 96; i++) {
      const px = toX(i / 95);
      const py = toY(activeLut[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.52)';
    ctx.font = '900 8px monospace';
    ctx.fillText(channel.maxLabel || '1.0', pad + 3, pad + 9);
    ctx.fillText(channel.minLabel || '0.0', pad + 3, pad + ph - 4);

    for (let i = 0; i < sorted.length; i++) {
      const pt = sorted[i];
      const cx = toX(pt.x);
      const cy = toY(pt.y);
      const isActive = (i === this.dragIndex || i === this.hoverIndex || i === this.selectedIndex);
      const r = isActive ? 6.0 : 4.5;

      ctx.fillStyle = isActive ? '#ffffff' : (channel.accent || '#ffffff');
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (this.readoutEl) {
      const activeIdx = this.dragIndex >= 0 ? this.dragIndex : (this.selectedIndex >= 0 ? this.selectedIndex : -1);
      if (activeIdx >= 0 && activePts[activeIdx]) {
        const p = activePts[activeIdx];
        const outTxt = channel.bipolar
          ? `${(p.y - 0.5) >= 0 ? '+' : ''}${Math.round((p.y - 0.5) * 200)}%`
          : `${Math.round(p.y * 100)}%`;
        this.readoutEl.innerText = `IN ${Math.round(p.x * 100)}% -> ${outTxt}`;
      } else {
        this.readoutEl.innerText = channel.desc || 'CLICK ADD · DRAG MOVE · DBL-CLICK/RIGHT DEL';
      }
    }

    ctx.restore();
  }
}

// ==================== SHARED UI MOUNT (SLIDERS, TABS, PRESETS) ====================

export const PAINTERLY_SLIDER_DEFS = [
  { key: 'exposure',      label: 'EXPOSURE (HDR LIGHT)',  min: -2.0, max: 2.0, step: 0.05, fmt: v => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)} EV` },
  { key: 'hdrRolloff',    label: 'HDR HIGHLIGHT SHOULDER',min: 0,    max: 100, step: 1,    fmt: v => `${Math.round(v)}%` },
  { key: 'temp',          label: 'TEMPERATURE (WARM)',    min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}` },
  { key: 'tint',          label: 'TINT (GREEN / MAG)',    min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}` },
  { key: 'shadowTemp',    label: 'SHADOW TEMP (SPLIT)',   min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}` },
  { key: 'highlightTemp', label: 'HIGHLIGHT TEMP (SPLIT)',min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}` },
  { key: 'chroma',        label: 'CHROMA / VIBRANCE',     min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` },
  { key: 'hueShift',      label: 'HUE SHIFT (VALUE LOCK)',min: -180, max: 180, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}°` },
  { key: 'chromaBleed',   label: 'CHROMA BLEED (PURITY)', min: -100, max: 100, step: 1,    fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` }
];

export function mountPainterlyControlsUI({
  state,
  spaceTabsEl,
  channelPillsEl,
  presetsEl,
  slidersEl,
  curveCanvas,
  readoutEl,
  btnResetCurve,
  btnAddMidpoint,
  btnResetAll,
  onChange
}) {
  const refs = { sliderInputs: {}, sliderVals: {}, bwCheck: null };
  const curveEditor = new CurveEditor(curveCanvas, {
    state,
    readoutEl,
    onChange: (_pts, meta) => {
      refreshSpaceDots();
      if (onChange) onChange(meta);
    }
  });

  const renderSpaceTabs = () => {
    if (!spaceTabsEl) return;
    spaceTabsEl.innerHTML = '';
    Object.values(COLOR_CORRECTION_SPACES).forEach(sp => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-space-tab';
      if (state.activeSpace === sp.id) btn.classList.add('active');
      const dirtyDot = isSpaceModified(state, sp.id) ? ' •' : '';
      btn.textContent = sp.label + dirtyDot;
      btn.title = sp.hint;
      btn.onclick = () => {
        state.activeSpace = sp.id;
        renderSpaceTabs();
        renderChannelPills();
        curveEditor.draw();
      };
      spaceTabsEl.appendChild(btn);
    });
  };

  const refreshSpaceDots = () => {
    if (!spaceTabsEl) return;
    const btns = spaceTabsEl.querySelectorAll('.cc-space-tab');
    const spaces = Object.values(COLOR_CORRECTION_SPACES);
    btns.forEach((btn, i) => {
      const sp = spaces[i];
      if (!sp) return;
      btn.classList.toggle('active', state.activeSpace === sp.id);
      const dirtyDot = isSpaceModified(state, sp.id) ? ' •' : '';
      btn.textContent = sp.label + dirtyDot;
    });
  };

  const renderChannelPills = () => {
    if (!channelPillsEl) return;
    channelPillsEl.innerHTML = '';
    const sp = COLOR_CORRECTION_SPACES[state.activeSpace] || COLOR_CORRECTION_SPACES.oklch;
    const activeCh = state.activeChannels[sp.id] || sp.channels[0].id;
    sp.channels.forEach(ch => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-ch-pill';
      if (ch.id === activeCh) btn.classList.add('active');
      const mod = isCurveModified(state.curves[sp.id][ch.id], ch.bipolar) ? '• ' : '';
      btn.innerHTML = `<span class="cc-ch-dot" style="background:${ch.accent}"></span>${mod}${ch.label}`;
      btn.onclick = () => {
        state.activeChannels[sp.id] = ch.id;
        renderChannelPills();
        curveEditor.draw();
      };
      channelPillsEl.appendChild(btn);
    });
  };

  const renderPresets = () => {
    if (!presetsEl) return;
    presetsEl.innerHTML = '';
    PAINTERLY_PRESETS.forEach(preset => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-preset-btn';
      btn.textContent = preset.label;
      btn.onclick = () => {
        const next = preset.apply();
        Object.assign(state.sliders, next.sliders);
        state.activeSpace = next.activeSpace;
        state.activeChannels = { ...next.activeChannels };
        state.bwMode = next.bwMode;
        Object.keys(state.curves).forEach(spId => {
          Object.keys(state.curves[spId]).forEach(chId => {
            state.curves[spId][chId] = next.curves[spId][chId].map(p => ({ x: p.x, y: p.y }));
          });
        });
        syncUIFromState();
        if (onChange) onChange({ dragging: false });
      };
      presetsEl.appendChild(btn);
    });
  };

  const buildSliders = () => {
    if (!slidersEl) return;
    slidersEl.innerHTML = '';

    const bwRow = document.createElement('div');
    bwRow.className = 'settings-row';
    bwRow.style.margin = '0 0 6px 0';
    bwRow.innerHTML = `
      <label class="settings-label" style="font-size:8px;">B&amp;W (PERCEPTUAL OKLAB L)</label>
      <div class="checkbox-wrapper">
        <input type="checkbox" class="settings-input-check">
        <span class="checkbox-custom"></span>
      </div>
    `;
    const bwChk = bwRow.querySelector('input');
    bwChk.checked = !!state.bwMode;
    bwChk.onchange = (e) => {
      state.bwMode = !!e.target.checked;
      if (onChange) onChange({ dragging: false });
    };
    refs.bwCheck = bwChk;
    slidersEl.appendChild(bwRow);

    PAINTERLY_SLIDER_DEFS.forEach(def => {
      const grp = document.createElement('div');
      grp.className = 'settings-group';
      grp.style.marginTop = '5px';

      const hdr = document.createElement('div');
      hdr.style.display = 'flex';
      hdr.style.justifyContent = 'space-between';
      hdr.style.alignItems = 'center';

      const lbl = document.createElement('label');
      lbl.className = 'settings-label';
      lbl.style.fontSize = '8px';
      lbl.style.margin = '0';
      lbl.textContent = def.label;
      lbl.title = 'Double-click to reset slider';

      const valSpan = document.createElement('span');
      valSpan.style.fontSize = '8px';
      valSpan.style.fontWeight = '900';
      valSpan.style.fontFamily = 'monospace';
      valSpan.textContent = def.fmt(state.sliders[def.key]);

      hdr.appendChild(lbl);
      hdr.appendChild(valSpan);

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'minimal-range';
      input.style.width = '100%';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.value = String(state.sliders[def.key]);

      const defaultVal = createDefaultColorAdjustState().sliders[def.key];
      lbl.ondblclick = () => {
        state.sliders[def.key] = defaultVal;
        input.value = String(defaultVal);
        valSpan.textContent = def.fmt(defaultVal);
        if (onChange) onChange({ dragging: false });
      };

      input.oninput = (e) => {
        const v = parseFloat(e.target.value);
        state.sliders[def.key] = v;
        valSpan.textContent = def.fmt(v);
        if (onChange) onChange({ dragging: true });
      };
      input.onchange = () => {
        if (onChange) onChange({ dragging: false });
      };

      refs.sliderInputs[def.key] = input;
      refs.sliderVals[def.key] = valSpan;

      grp.appendChild(hdr);
      grp.appendChild(input);
      slidersEl.appendChild(grp);
    });
  };

  const syncUIFromState = () => {
    renderSpaceTabs();
    renderChannelPills();
    curveEditor.draw();
    if (refs.bwCheck) refs.bwCheck.checked = !!state.bwMode;
    PAINTERLY_SLIDER_DEFS.forEach(def => {
      const v = state.sliders[def.key];
      if (refs.sliderInputs[def.key]) refs.sliderInputs[def.key].value = String(v);
      if (refs.sliderVals[def.key]) refs.sliderVals[def.key].textContent = def.fmt(v);
    });
  };

  if (btnResetCurve) {
    btnResetCurve.onclick = () => {
      curveEditor.resetActiveCurve();
      renderChannelPills();
      refreshSpaceDots();
    };
  }
  if (btnAddMidpoint) {
    btnAddMidpoint.onclick = () => {
      curveEditor.addMidpoint();
      renderChannelPills();
      refreshSpaceDots();
    };
  }
  if (btnResetAll) {
    btnResetAll.onclick = () => {
      const fresh = createDefaultColorAdjustState();
      state.activeSpace = fresh.activeSpace;
      state.activeChannels = { ...fresh.activeChannels };
      state.curves = fresh.curves;
      state.sliders = { ...fresh.sliders };
      state.bwMode = false;
      syncUIFromState();
      if (onChange) onChange({ dragging: false });
    };
  }

  renderPresets();
  buildSliders();
  syncUIFromState();

  return {
    curveEditor,
    syncUIFromState,
    refreshChannelDots: () => {
      renderChannelPills();
      refreshSpaceDots();
    }
  };
}

// ==================== PAINT LAYER COLOR CORRECTION CONTROLLER ====================

function computeChunkOpaqueBounds(rgba, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let idx = y * w * 4 + 3;
    for (let x = 0; x < w; x++, idx += 4) {
      if (rgba[idx] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

export class LayerColorController {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.modal = document.getElementById('modal-layer-color');
    this.titleEl = document.getElementById('layer-color-title');
    this.emptyNoticeEl = document.getElementById('layer-color-empty-notice');
    this.btnClose = document.getElementById('btn-close-layer-color');
    this.btnApply = document.getElementById('btn-layer-color-apply');
    this.btnCancel = document.getElementById('btn-layer-color-cancel');
    this.btnCompare = document.getElementById('btn-layer-color-compare');

    this.btnViewToggle = document.getElementById('btn-layer-cc-view-toggle');
    this.curvesPane = document.getElementById('layer-cc-curves-pane');
    this.slidersPane = document.getElementById('layer-cc-sliders-pane');
    this.viewMode = 'curves'; // 'curves' | 'sliders'

    this.isOpen = false;
    this.targetLayer = 2;
    this.state = createDefaultColorAdjustState();
    this._previewTimer = null;
    this._lastPreviewTime = 0;
    this._cpuFallbackChunks = null;

    this.ui = mountPainterlyControlsUI({
      state: this.state,
      spaceTabsEl: document.getElementById('layer-cc-space-tabs'),
      channelPillsEl: document.getElementById('layer-cc-channel-pills'),
      presetsEl: document.getElementById('layer-cc-presets'),
      slidersEl: document.getElementById('layer-cc-sliders'),
      curveCanvas: document.getElementById('layer-cc-curve-canvas'),
      readoutEl: document.getElementById('layer-cc-curve-readout'),
      btnResetCurve: document.getElementById('btn-layer-cc-reset-curve'),
      btnAddMidpoint: document.getElementById('btn-layer-cc-midpoint'),
      btnResetAll: document.getElementById('btn-layer-cc-reset-all'),
      onChange: (meta) => {
        this.ui?.refreshChannelDots();
        if (this.isOpen) {
          this._schedulePreview(!!meta?.dragging);
        }
      }
    });

    this._bindModalButtons();
  }

  _bindModalButtons() {
    if (this.btnClose) {
      this.btnClose.onclick = () => this.cancel();
    }
    if (this.btnCancel) {
      this.btnCancel.onclick = () => this.cancel();
    }
    if (this.btnApply) {
      this.btnApply.onclick = () => this.apply();
    }
    if (this.btnViewToggle) {
      this.btnViewToggle.onclick = () => {
        this.setViewMode(this.viewMode === 'curves' ? 'sliders' : 'curves');
      };
    }
    if (this.btnCompare) {
      const showOrig = (e) => {
        if (e.preventDefault) e.preventDefault();
        if (this.engine.gpuRenderer?.supported) {
          this.engine.gpuRenderer.setColorCorrectionCompare(true);
        } else {
          this._renderCpuFallback(true);
        }
      };
      const showEdited = () => {
        if (!this.isOpen) return;
        if (this.engine.gpuRenderer?.supported) {
          this.engine.gpuRenderer.setColorCorrectionCompare(false);
        } else {
          this._renderCpuFallback(false);
        }
      };
      this.btnCompare.addEventListener('pointerdown', showOrig);
      this.btnCompare.addEventListener('pointerup', showEdited);
      this.btnCompare.addEventListener('pointerleave', showEdited);
      this.btnCompare.addEventListener('pointercancel', showEdited);
    }
  }

  setViewMode(mode = 'curves') {
    this.viewMode = mode === 'sliders' ? 'sliders' : 'curves';
    const isSliders = this.viewMode === 'sliders';
    if (this.curvesPane) this.curvesPane.classList.toggle('hidden', isSliders);
    if (this.slidersPane) this.slidersPane.classList.toggle('hidden', !isSliders);
    if (this.btnViewToggle) {
      this.btnViewToggle.textContent = isSliders ? 'CURVES ▸' : 'SLIDERS ▸';
      this.btnViewToggle.classList.toggle('active-mode', isSliders);
    }
    if (!isSliders) {
      requestAnimationFrame(() => this.ui?.curveEditor?.draw());
    }
  }

  _computeFastHistogram(layerIndex) {
    const sampleSize = 96;
    const c = document.createElement('canvas');
    c.width = sampleSize;
    c.height = sampleSize;
    const sctx = c.getContext('2d', { willReadFrequently: true });
    let hasPixels = false;

    const histCombined = new Float32Array(64);
    this.engine.chunks.forEach((chunk) => {
      if (chunk.isEmpty && chunk.isEmpty[layerIndex]) return;
      const srcCanvas = chunk.canvases[layerIndex];
      if (!srcCanvas || srcCanvas.width <= 0 || srcCanvas.height <= 0) return;
      hasPixels = true;
      sctx.clearRect(0, 0, sampleSize, sampleSize);
      sctx.drawImage(srcCanvas, 0, 0, sampleSize, sampleSize);
      const data = sctx.getImageData(0, 0, sampleSize, sampleSize).data;
      const bins = computeHistogramBins(data, 64);
      for (let i = 0; i < 64; i++) histCombined[i] += bins[i];
    });
    c.width = 1;
    c.height = 1;

    if (!hasPixels) return null;
    let maxV = 0;
    for (let i = 0; i < 64; i++) if (histCombined[i] > maxV) maxV = histCombined[i];
    if (maxV > 0) {
      for (let i = 0; i < 64; i++) histCombined[i] /= maxV;
    }
    return histCombined;
  }

  open(layerIndex) {
    if (!this.engine || layerIndex <= 0) return;
    if (this.isOpen) {
      if (this.targetLayer === layerIndex) return;
      this.cancel();
    }

    // Pause autosave during color correction session so zero background IDB writes occur while adjusting
    this.app._clearSaveTimer?.();
    this.app._pauseAutosaveForModal = true;

    this.engine.flushPendingGpuCommits?.();
    if (this.engine.floatingSelection && this.engine.applySelection) {
      try { this.engine.applySelection(); } catch (_) {}
    }
    this.engine._resetInteractionState?.({ cancelActive: false });

    this.targetLayer = layerIndex;
    this.app.setLayer?.(layerIndex);

    const fresh = createDefaultColorAdjustState();
    this.state.activeSpace = fresh.activeSpace;
    this.state.activeChannels = { ...fresh.activeChannels };
    this.state.curves = fresh.curves;
    this.state.sliders = { ...fresh.sliders };
    this.state.bwMode = false;
    this.ui.syncUIFromState();

    // Fast downsampled histogram (~1ms, never calls full-res getImageData on open!)
    const hist = this._computeFastHistogram(layerIndex);
    this.ui.curveEditor.setHistogram(hist);

    // If WebGL2 isn't supported, cache CPU fallback snapshots
    this._cpuFallbackChunks = null;
    if (!this.engine.gpuRenderer?.supported) {
      this._prepareCpuFallback(layerIndex);
    }

    if (this.titleEl) {
      this.titleEl.innerText = `COLOR · PAINT ${layerIndex}`;
    }
    if (this.emptyNoticeEl) {
      this.emptyNoticeEl.classList.toggle('hidden', !!hist);
    }

    this.isOpen = true;
    document.querySelectorAll('.layer-color-btn').forEach(b => b.classList.remove('active'));
    const rowBtn = document.getElementById(`layer-color-btn-${layerIndex}`);
    if (rowBtn) rowBtn.classList.add('active');

    this.setViewMode('curves');

    if (this.modal) {
      this.modal.classList.remove('hidden');
      const w = this.modal.offsetWidth || 344;
      const h = this.modal.offsetHeight || 480;
      const saved = this.app?.windowPositions?.['modal-layer-color'];
      const isSavedValid = !!(
        saved &&
        Number.isFinite(saved.left) &&
        Number.isFinite(saved.top) &&
        saved.left >= 0 &&
        saved.top >= 0 &&
        (saved.left + w) <= window.innerWidth &&
        (saved.top + h) <= window.innerHeight
      );
      if (isSavedValid) {
        this.modal.style.left = Math.round(saved.left) + 'px';
        this.modal.style.top = Math.round(saved.top) + 'px';
      } else {
        if (this.app?.windowPositions && saved) {
          delete this.app.windowPositions['modal-layer-color'];
          this.app._saveWindowPositions?.();
        }
        this.modal.style.left = Math.max(12, Math.round(window.innerWidth - w - 24)) + 'px';
        this.modal.style.top = Math.max(52, Math.round((window.innerHeight - h) * 0.45)) + 'px';
      }
      this.modal.style.transform = '';
      this.modal.style.right = 'auto';
      this.modal.style.bottom = 'auto';
      requestAnimationFrame(() => this.ui.curveEditor.draw());
    }
  }

  _schedulePreview(dragging = true) {
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }

    if (!dragging) {
      this._applyLivePreview();
      return;
    }

    // Throttle live preview cleanly (~32ms during active drag) so Curve handles stay silky responsive
    const now = performance.now();
    const elapsed = now - this._lastPreviewTime;
    const wait = Math.max(0, 32 - elapsed);
    this._previewTimer = setTimeout(() => {
      this._previewTimer = null;
      if (this.isOpen) this._applyLivePreview();
    }, wait);
  }

  _applyLivePreview() {
    if (!this.isOpen) return;
    this._lastPreviewTime = performance.now();

    const gpu = this.engine.gpuRenderer;
    if (gpu && gpu.supported) {
      if (isDefaultColorAdjustState(this.state)) {
        gpu.clearColorCorrectionPreview();
      } else {
        const compiled = compileColorAdjustState(this.state);
        const lutStrip = buildColorStripLutRgba(compiled);
        gpu.setColorCorrectionPreview(this.targetLayer, lutStrip, CC_LUT_SIZE);
      }
      return;
    }

    this._renderCpuFallback(false);
  }

  _prepareCpuFallback(layer) {
    this._cpuFallbackChunks = [];
    this.engine.chunks.forEach((chunk, id) => {
      if (chunk.isEmpty && chunk.isEmpty[layer]) return;
      const canvas = chunk.canvases[layer];
      const ctx = chunk.ctxs[layer];
      if (!canvas || !ctx) return;
      const srcImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bounds = computeChunkOpaqueBounds(srcImg.data, canvas.width, canvas.height);
      if (!bounds) return;
      this._cpuFallbackChunks.push({
        id,
        chunk,
        srcImg,
        dstImg: ctx.createImageData(canvas.width, canvas.height),
        bounds
      });
    });
  }

  _renderCpuFallback(showOrig = false) {
    if (!this._cpuFallbackChunks) return;
    const layer = this.targetLayer;
    const compiled = !showOrig ? compileColorAdjustState(this.state) : null;
    const cube = compiled ? buildColorCubeLut(compiled) : null;

    for (let i = 0; i < this._cpuFallbackChunks.length; i++) {
      const e = this._cpuFallbackChunks[i];
      const bw = e.bounds.maxX - e.bounds.minX + 1;
      const bh = e.bounds.maxY - e.bounds.minY + 1;
      if (showOrig || isDefaultColorAdjustState(this.state)) {
        e.chunk.ctxs[layer].putImageData(e.srcImg, 0, 0, e.bounds.minX, e.bounds.minY, bw, bh);
      } else {
        applyColorAdjustToBuffer(e.srcImg.data, e.dstImg.data, e.srcImg.width, e.srcImg.height, this.state, {
          compiled,
          cube,
          bounds: e.bounds
        });
        e.chunk.ctxs[layer].putImageData(e.dstImg, 0, 0, e.bounds.minX, e.bounds.minY, bw, bh);
      }
    }
    this.engine.refresh?.();
  }

  apply() {
    if (!this.isOpen) return;
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }

    const modified = !isDefaultColorAdjustState(this.state);
    if (!modified) {
      this.cancel();
      return;
    }

    const layer = this.targetLayer;
    const compiled = compileColorAdjustState(this.state);
    const historyChunks = new Map();

    // Clear GPU live LUT overlay before writing final baked pixels to chunks
    this.engine.gpuRenderer?.clearColorCorrectionPreview?.();

    if (this._cpuFallbackChunks) {
      // Restore original source before exact bake
      for (let i = 0; i < this._cpuFallbackChunks.length; i++) {
        const e = this._cpuFallbackChunks[i];
        const bw = e.bounds.maxX - e.bounds.minX + 1;
        const bh = e.bounds.maxY - e.bounds.minY + 1;
        e.chunk.ctxs[layer].putImageData(e.srcImg, 0, 0, e.bounds.minX, e.bounds.minY, bw, bh);
      }
      this._cpuFallbackChunks = null;
    }

    this.engine.chunks.forEach((chunk, id) => {
      if (chunk.isEmpty && chunk.isEmpty[layer]) return;
      const canvas = chunk.canvases[layer];
      const ctx = chunk.ctxs[layer];
      if (!canvas || !ctx || canvas.width <= 0 || canvas.height <= 0) return;

      const srcImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bounds = computeChunkOpaqueBounds(srcImg.data, canvas.width, canvas.height);
      if (!bounds) {
        if (chunk.isEmpty) chunk.isEmpty[layer] = true;
        return;
      }

      const backup = captureLayerSnapshot(this.engine, chunk, layer, {
        willReadFrequently: !isMobileDevice,
        needCanvas: true,
        wasEmpty: false
      });

      const dstImg = ctx.createImageData(canvas.width, canvas.height);
      applyColorAdjustToBuffer(srcImg.data, dstImg.data, canvas.width, canvas.height, this.state, {
        compiled,
        exact: true,
        bounds
      });

      const bw = bounds.maxX - bounds.minX + 1;
      const bh = bounds.maxY - bounds.minY + 1;
      ctx.putImageData(dstImg, 0, 0, bounds.minX, bounds.minY, bw, bh);
      this.engine._markDirty(id, layer, false);
      historyChunks.set(id, backup);
    });

    if (historyChunks.size > 0) {
      this.engine._pushHistory({
        type: 'stroke',
        chunks: historyChunks,
        selection: this.engine.floatingSelection ? { ...this.engine.floatingSelection } : null
      });
      this.engine._clearStack(this.engine.redoStack);
    }

    this._cleanupSession();
    this.engine.refresh?.();
    this.app._status?.(`COLOR APPLIED TO PAINT ${layer}`);
    if (this.app.autosaveEnabled) this.app._triggerAutoSave?.();
  }

  cancel() {
    if (!this.isOpen) return;
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }

    this.engine.gpuRenderer?.clearColorCorrectionPreview?.();

    if (this._cpuFallbackChunks) {
      this._renderCpuFallback(true);
      this._cpuFallbackChunks = null;
    }

    this._cleanupSession();
    this.engine.refresh?.();
  }

  _cleanupSession() {
    this.app._pauseAutosaveForModal = false;
    this.isOpen = false;
    document.querySelectorAll('.layer-color-btn').forEach(b => b.classList.remove('active'));
    if (this.modal) this.modal.classList.add('hidden');
  }
}
