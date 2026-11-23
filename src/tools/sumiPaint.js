import { hexToRgb } from '../colorUtils.js';
import { GpuSumiSolver } from './sumiPaintGpu.js';

/**
 * Sumi-e Ink & Paper Engine
 *
 * Uses RGBA alpha coordinates of the active brush texture (`engine.brush.tip`) as available
 * bristle tuft locations (falling back to a tapered phyllotaxis calligraphy bundle when blank),
 * simulates reservoir depletion, dynamic kasure splitting, velocity/pressure compliance, and
 * feeds deformable capsule segments into the 5-layer GPU Sumi-e solver (`GpuSumiSolver`).
 */

export const sumiSettings = {
  mode: 'draw',          // 'draw' | 'water' | 'blow' | 'dry'
  ink: 78,               // 0..100
  inkAffection: 35,      // 0..100 (independent water affection for 'water' subtool)
  water: 65,             // 0..100
  bleed: 58,             // 0..100
  bristles: 28,          // 8..48
  stiffness: 60,         // 10..100
  splitDry: 48,          // 0..100
  depleteSpan: 550,      // 150..2400 px
  glue: 42,              // 0..100
  warmth: 12,            // -100..100 (cool pine soot <-> warm lampblack)
  evaporation: 28,       // 0..100
  capillarity: 62,       // 0..100
  backrun: 68,           // 0..100
  sootSnag: 55,          // 0..100
  depleteEnabled: true,
  splitEnabled: true,
  tiltEnabled: true,
  autoReDip: true,
  followStroke: false,
  tipAngle: 0,           // -180..180 deg
  pressureFlow: 35,      // 0..100
  useHeightmap: false,
  heightSource: 'surface' // 'surface' | 'layer'
};

export function syncSumiSettingsFromTip(tipSettings) {
  if (!tipSettings) return;
  sumiSettings.mode = tipSettings.sumiMode || sumiSettings.mode || 'draw';
  sumiSettings.ink = tipSettings.sumiInk ?? 78;
  sumiSettings.inkAffection = tipSettings.sumiInkAffection ?? 35;
  sumiSettings.water = tipSettings.sumiWater ?? 65;
  sumiSettings.bleed = tipSettings.sumiBleed ?? 58;
  sumiSettings.bristles = tipSettings.sumiBristles ?? 28;
  sumiSettings.stiffness = tipSettings.sumiStiffness ?? 60;
  sumiSettings.splitDry = tipSettings.sumiSplit ?? 48;
  sumiSettings.depleteSpan = tipSettings.sumiSpan ?? 550;
  sumiSettings.glue = tipSettings.sumiGlue ?? 42;
  sumiSettings.warmth = tipSettings.sumiWarmth ?? 12;
  sumiSettings.evaporation = tipSettings.sumiEvaporation ?? 28;
  sumiSettings.capillarity = tipSettings.sumiCapillarity ?? 62;
  sumiSettings.backrun = tipSettings.sumiBackrun ?? 68;
  sumiSettings.sootSnag = tipSettings.sumiSootSnag ?? 55;
  sumiSettings.depleteEnabled = tipSettings.sumiDeplete !== undefined ? !!tipSettings.sumiDeplete : true;
  sumiSettings.splitEnabled = tipSettings.sumiSplitEnabled !== undefined ? !!tipSettings.sumiSplitEnabled : true;
  sumiSettings.tiltEnabled = tipSettings.sumiTilt !== undefined ? !!tipSettings.sumiTilt : true;
  sumiSettings.autoReDip = tipSettings.sumiAutoReDip !== undefined ? !!tipSettings.sumiAutoReDip : true;
  sumiSettings.followStroke = !!tipSettings.sumiFollowStroke;
  sumiSettings.tipAngle = tipSettings.sumiTipAngle ?? 0;
  sumiSettings.pressureFlow = tipSettings.sumiPressureFlow ?? 35;
  sumiSettings.useHeightmap = tipSettings.sumiUseHeightmap !== undefined ? !!tipSettings.sumiUseHeightmap : false;
  sumiSettings.heightSource = tipSettings.sumiHeightSource || 'surface';
}

const TIP_SAMPLE_RES = 64;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _tipSampleCanvas = null;
let _tipSampleCtx = null;

function extractTipCoordinates(tipCanvas) {
  if (!tipCanvas || !tipCanvas.width || !tipCanvas.height) return null;
  if (!_tipSampleCanvas) {
    _tipSampleCanvas = document.createElement('canvas');
    _tipSampleCanvas.width = TIP_SAMPLE_RES;
    _tipSampleCanvas.height = TIP_SAMPLE_RES;
    _tipSampleCtx = _tipSampleCanvas.getContext('2d', { willReadFrequently: true });
  }
  _tipSampleCtx.clearRect(0, 0, TIP_SAMPLE_RES, TIP_SAMPLE_RES);
  _tipSampleCtx.drawImage(tipCanvas, 0, 0, TIP_SAMPLE_RES, TIP_SAMPLE_RES);
  const data = _tipSampleCtx.getImageData(0, 0, TIP_SAMPLE_RES, TIP_SAMPLE_RES).data;

  const coords = [];
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;

  for (let y = 0; y < TIP_SAMPLE_RES; y++) {
    for (let x = 0; x < TIP_SAMPLE_RES; x++) {
      const a = data[(y * TIP_SAMPLE_RES + x) * 4 + 3] / 255.0;
      if (a >= 0.14) {
        const nx = ((x + 0.5) / TIP_SAMPLE_RES) * 2.0 - 1.0;
        const ny = ((y + 0.5) / TIP_SAMPLE_RES) * 2.0 - 1.0;
        coords.push({ x: nx, y: ny, a });
        sumX += nx * a;
        sumY += ny * a;
        sumW += a;
      }
    }
  }

  if (coords.length < 4 || sumW <= 0) return null;
  const cx = sumX / sumW;
  const cy = sumY / sumW;
  let maxDist = 0.001;
  for (let i = 0; i < coords.length; i++) {
    const d = Math.hypot(coords[i].x - cx, coords[i].y - cy);
    if (d > maxDist) maxDist = d;
  }
  return { coords, cx, cy, maxDist };
}

class AlphaBristleBrush {
  constructor() {
    this.tufts = [];
    this.spineBendX = 0;
    this.spineBendY = 0;
    this.lastDirX = 1;
    this.lastDirY = 0;
    this.splitAmount = 0;
    this.avgInkRes = 1.0;
    this.avgWaterRes = 1.0;
    this.hasTipShape = false;

    this._lastTipRef = null;
    this._lastTipVer = -1;
    this._lastCount = -1;

    this.rebuildTufts(28, null);
  }

  rebuildTufts(count, tipCanvas) {
    const targetCount = Math.min(48, Math.max(8, Math.round(count || 28)));
    const tipVer = tipCanvas ? (tipCanvas._tipVersion || 1) : 0;

    if (
      this._lastCount === targetCount &&
      this._lastTipRef === tipCanvas &&
      this._lastTipVer === tipVer &&
      this.tufts.length === targetCount
    ) {
      return;
    }

    this._lastCount = targetCount;
    this._lastTipRef = tipCanvas;
    this._lastTipVer = tipVer;

    const extracted = extractTipCoordinates(tipCanvas);
    const rand = mulberry32(1337 + targetCount * 31 + tipVer * 97);
    this.tufts = [];

    if (extracted && extracted.coords.length >= 4) {
      this.hasTipShape = true;
      const pool = extracted.coords;
      const selected = [];
      const selectedIdx = new Set();

      // Seed 1st tuft closest to opaque center of mass
      let bestSeedIdx = 0;
      let bestSeedDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = Math.hypot(pool[i].x - extracted.cx, pool[i].y - extracted.cy);
        if (d < bestSeedDist) {
          bestSeedDist = d;
          bestSeedIdx = i;
        }
      }
      selected.push(pool[bestSeedIdx]);
      selectedIdx.add(bestSeedIdx);

      // Deterministic farthest-point sampling across available RGBA alpha coordinates
      const minDists = new Float32Array(pool.length);
      for (let i = 0; i < pool.length; i++) {
        minDists[i] = Math.hypot(pool[i].x - pool[bestSeedIdx].x, pool[i].y - pool[bestSeedIdx].y);
      }

      while (selected.length < targetCount) {
        let farIdx = -1;
        let farScore = -1;
        for (let i = 0; i < pool.length; i++) {
          if (selectedIdx.has(i) && selected.length < pool.length) continue;
          const score = minDists[i] * (0.78 + 0.22 * pool[i].a) + rand() * 0.015;
          if (score > farScore) {
            farScore = score;
            farIdx = i;
          }
        }
        if (farIdx < 0) farIdx = Math.floor(rand() * pool.length);
        const picked = pool[farIdx];
        selected.push(picked);
        selectedIdx.add(farIdx);
        for (let i = 0; i < pool.length; i++) {
          const d = Math.hypot(pool[i].x - picked.x, pool[i].y - picked.y);
          if (d < minDists[i]) minDists[i] = d;
        }
      }

      // Compute nearest-neighbor spacing so tufts cleanly cover the tip without giant blobs
      for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        let nn = 0.7;
        for (let j = 0; j < selected.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(selected[j].x - p.x, selected[j].y - p.y);
          if (d > 0.005 && d < nn) nn = d;
        }
        const rx = Math.max(-0.96, Math.min(0.96, p.x));
        const ry = Math.max(-0.96, Math.min(0.96, p.y));
        const radialDist = Math.min(1.0, Math.hypot(rx - extracted.cx, ry - extracted.cy) / Math.max(0.25, extracted.maxDist));
        const radiusScale = Math.max(0.20, Math.min(0.48, (nn * 0.74 + 0.12) * (0.78 + 0.22 * p.a)));
        this.tufts.push({
          baseX: rx,
          baseY: ry,
          radialDist,
          alphaWeight: p.a,
          clusterAngle: Math.atan2(ry - extracted.cy, rx - extracted.cx) + (rand() - 0.5) * 0.25,
          radiusScale,
          stiffJitter: 0.85 + rand() * 0.3,
          inkLoad: 1.0,
          waterLoad: 1.0,
          curX: rx,
          curY: ry,
          curR: radiusScale,
          weight: 1.0
        });
      }
    } else {
      this.hasTipShape = false;
      for (let i = 0; i < targetCount; i++) {
        const t = i / Math.max(1, targetCount - 1);
        let rx = 0;
        let ry = 0;
        let radiusScale = 0.36;
        if (i === 0) {
          rx = 0;
          ry = 0;
          radiusScale = 0.44;
        } else {
          const angle = i * 2.3999632 + (rand() - 0.5) * 0.32;
          const radial = Math.sqrt(t);
          rx = Math.cos(angle) * radial * 0.92;
          ry = Math.sin(angle) * radial * 0.92;
          radiusScale = 0.27 + (1.0 - radial * 0.42) * 0.18;
        }
        const radialDist = Math.min(1.0, Math.hypot(rx, ry));
        this.tufts.push({
          baseX: rx,
          baseY: ry,
          radialDist,
          alphaWeight: 1.0,
          clusterAngle: Math.atan2(ry, rx) + (rand() - 0.5) * 0.25,
          radiusScale,
          stiffJitter: 0.85 + rand() * 0.3,
          inkLoad: 1.0,
          waterLoad: 1.0,
          curX: rx,
          curY: ry,
          curR: radiusScale,
          weight: 1.0
        });
      }
    }
  }

  reDip(inkOnly = false) {
    for (let i = 0; i < this.tufts.length; i++) {
      this.tufts[i].inkLoad = 1.0;
      if (!inkOnly) this.tufts[i].waterLoad = 1.0;
    }
    this.avgInkRes = 1.0;
    this.avgWaterRes = 1.0;
    this.splitAmount = 0;
  }

  beginStroke(dirX = 1, dirY = 0) {
    this.spineBendX = 0;
    this.spineBendY = 0;
    const len = Math.hypot(dirX, dirY);
    if (len > 0.001) {
      this.lastDirX = dirX / len;
      this.lastDirY = dirY / len;
    }
    let rotAngle = (sumiSettings.tipAngle || 0) * Math.PI / 180;
    if (sumiSettings.followStroke) {
      rotAngle += Math.atan2(this.lastDirY, this.lastDirX);
    }
    const cosA = Math.cos(rotAngle);
    const sinA = Math.sin(rotAngle);
    for (let i = 0; i < this.tufts.length; i++) {
      const b = this.tufts[i];
      b.curX = b.baseX * cosA - b.baseY * sinA;
      b.curY = b.baseX * sinA + b.baseY * cosA;
    }
  }

  buildSegments({
    fromX,
    fromY,
    toX,
    toY,
    sizePx,
    pressure,
    tiltX,
    tiltY,
    velX,
    velY,
    modeInt,
    stepWeight = 1.0,
    bridgeCapsule = false,
    waterScale = 1.0
  }) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const stepDist = Math.hypot(dx, dy);

    let dirX = this.lastDirX;
    let dirY = this.lastDirY;
    if (stepDist > 0.15) {
      const ndx = dx / stepDist;
      const ndy = dy / stepDist;
      this.lastDirX = this.lastDirX * 0.65 + ndx * 0.35;
      this.lastDirY = this.lastDirY * 0.65 + ndy * 0.35;
      const n = Math.hypot(this.lastDirX, this.lastDirY) || 1;
      this.lastDirX /= n;
      this.lastDirY /= n;
      dirX = this.lastDirX;
      dirY = this.lastDirY;
    }

    const stiffness = Math.max(0.1, Math.min(1.0, sumiSettings.stiffness / 100));
    const speed = Math.hypot(velX, velY);
    const comply = sumiSettings.tiltEnabled ? (1.12 - stiffness * 0.72) : 0.12;
    const targetBendX = -dirX * Math.min(0.8, speed * 0.03) * comply + (tiltX || 0) * 0.45;
    const targetBendY = -dirY * Math.min(0.8, speed * 0.03) * comply + (tiltY || 0) * 0.45;
    this.spineBendX = this.spineBendX * 0.62 + targetBendX * 0.38;
    this.spineBendY = this.spineBendY * 0.62 + targetBendY * 0.38;

    const pClamped = Math.max(0.08, Math.min(1.0, pressure || 1.0));
    const contactRadiusPx = Math.max(2.0, (sizePx || 40) * 0.5);

    const splitThresh = Math.max(0.0, Math.min(1.0, sumiSettings.splitDry / 100));
    const dryness = Math.max(0, 1.0 - this.avgWaterRes * 1.15);
    const speedFactor = Math.min(1.0, speed / 22.0);
    const rawSplit = sumiSettings.splitEnabled
      ? Math.max(0, (dryness * 0.78 + speedFactor * 0.42) * splitThresh * 1.45 - 0.10)
      : 0;
    this.splitAmount = this.splitAmount * 0.70 + Math.min(1.0, rawSplit) * 0.30;

    // Rotation angle for custom brush tip (follow stroke or fixed tipAngle)
    let rotAngle = (sumiSettings.tipAngle || 0) * Math.PI / 180;
    if (sumiSettings.followStroke) {
      rotAngle += Math.atan2(dirY, dirX);
    }
    const cosA = Math.cos(rotAngle);
    const sinA = Math.sin(rotAngle);

    const sizeRatio = Math.max(0.45, Math.min(2.4, (sizePx || 40) / 40));
    const spanPx = Math.max(90, (sumiSettings.depleteSpan || 550) * sizeRatio);
    const travelNorm = Math.min(0.28, stepDist / spanPx);
    const pFlowInf = Math.max(0, Math.min(1, sumiSettings.pressureFlow / 100));
    const flowGain = (1.0 - pFlowInf) + pClamped * pFlowInf;

    const count = this.tufts.length;
    const densityNorm = Math.min(
      1.25,
      Math.max(
        0.55,
        (28 / Math.max(12, count)) * Math.min(1.10, Math.max(0.84, Math.pow(40 / Math.max(14, sizePx || 40), 0.06)))
      )
    );
    const segments = [];
    let inkSum = 0;
    let waterSum = 0;

    for (let i = 0; i < count; i++) {
      const b = this.tufts[i];

      // Rotate tip coordinates into canvas orientation
      const rx = b.baseX * cosA - b.baseY * sinA;
      const ry = b.baseX * sinA + b.baseY * cosA;

      const splay = 1.0 + pClamped * (1.0 - stiffness * 0.55) * 0.25;
      let offX = rx * splay + this.spineBendX * b.radialDist * 0.35;
      let offY = ry * splay + this.spineBendY * b.radialDist * 0.35;

      if (this.splitAmount > 0.02) {
        const push = this.splitAmount * (0.20 + b.radialDist * 0.48);
        offX += Math.cos(b.clusterAngle + rotAngle) * push;
        offY += Math.sin(b.clusterAngle + rotAngle) * push;
      }

      const prevOffX = b.curX !== undefined ? b.curX : offX;
      const prevOffY = b.curY !== undefined ? b.curY : offY;
      b.curX = offX;
      b.curY = offY;

      const x1 = toX + offX * contactRadiusPx;
      const y1 = toY + offY * contactRadiusPx;
      const x0 = bridgeCapsule ? (fromX + prevOffX * contactRadiusPx) : x1;
      const y0 = bridgeCapsule ? (fromY + prevOffY * contactRadiusPx) : y1;

      const rPx = Math.max(1.1, contactRadiusPx * b.radiusScale * (0.76 + pClamped * 0.32) * (1.0 - this.splitAmount * 0.34));
      b.curR = rPx / Math.max(contactRadiusPx, 1.0);

      const pressureGate = Math.max(0.0, Math.min(1.0, (pClamped * 1.15 - b.radialDist * 0.38) * 1.40)) * b.alphaWeight;

      let inkW = 0;
      let waterW = 0;
      let contactW = pressureGate * flowGain * stepWeight;
      if (modeInt === 0) {
        inkW = (sumiSettings.ink / 100) * b.inkLoad * pressureGate * flowGain * stepWeight * densityNorm;
        waterW = (sumiSettings.water / 100) * b.waterLoad * pressureGate * flowGain * stepWeight * densityNorm * waterScale;
      } else if (modeInt === 1) {
        waterW = (sumiSettings.water / 100) * 1.15 * pressureGate * flowGain * stepWeight * densityNorm * waterScale;
      } else if (modeInt === 2) {
        const blowScale = Math.max(0.35, stepWeight);
        waterW = pressureGate * blowScale;
        contactW = pressureGate * blowScale;
      } else {
        const blotScale = Math.min(1.0, Math.max(0.45, stepWeight));
        waterW = pressureGate * blotScale;
        contactW = pressureGate * blotScale;
      }

      if (this.splitAmount > 0.32 && (i % 3 === 1)) {
        const kasure = Math.max(0.08, 1.0 - this.splitAmount * 0.78);
        inkW *= kasure;
        waterW *= kasure;
        contactW *= kasure;
      }

      b.weight = pressureGate;

      if (modeInt === 0 && sumiSettings.depleteEnabled && stepDist > 0.1) {
        const drainScale = 0.55 + b.radialDist * 0.85;
        b.waterLoad = Math.max(0.05, b.waterLoad - travelNorm * drainScale * 1.12);
        b.inkLoad = Math.max(0.08, b.inkLoad - travelNorm * drainScale * 0.86);
      }

      inkSum += b.inkLoad;
      waterSum += b.waterLoad;

      segments.push({
        x0,
        y0,
        x1,
        y1,
        r: rPx,
        inkW: Math.max(0, Math.min(4, inkW)),
        waterW: Math.max(0, Math.min(4, waterW)),
        contactW: Math.max(0, Math.min(4, contactW)),
        seed: i * 0.37
      });
    }

    this.avgInkRes = inkSum / Math.max(1, count);
    this.avgWaterRes = waterSum / Math.max(1, count);
    return segments;
  }
}

const _brush = new AlphaBristleBrush();
let _simRafId = 0;
let _lastStrokeWorld = null;
let _lastStrokeTime = 0;
let _lastPreviewTime = 0;

function hexToPigmentK(hex) {
  const rgb = hexToRgb(hex || '#141414');
  const linR = Math.pow(Math.max(0, rgb.r / 255), 2.2);
  const linG = Math.pow(Math.max(0, rgb.g / 255), 2.2);
  const linB = Math.pow(Math.max(0, rgb.b / 255), 2.2);
  return [
    Math.max(0.03, Math.min(0.98, 1.0 - linR)),
    Math.max(0.03, Math.min(0.98, 1.0 - linG)),
    Math.max(0.03, Math.min(0.98, 1.0 - linB))
  ];
}

function getModeInt(mode) {
  if (mode === 'water') return 1;
  if (mode === 'blow') return 2;
  if (mode === 'dry') return 3;
  return 0;
}

export function renderSumiBristlePreview() {
  const canvas = document.getElementById('sumi-bristle-preview');
  const stateEl = document.getElementById('sumi-bristle-state');
  if (stateEl) {
    if (sumiSettings.mode === 'water') {
      stateEl.innerText = 'WATER WASH';
    } else if (sumiSettings.mode === 'blow') {
      stateEl.innerText = 'BLOW PLUME';
    } else if (sumiSettings.mode === 'dry') {
      stateEl.innerText = 'HEAT BLOT';
    } else {
      const pct = Math.round(_brush.avgInkRes * 100);
      stateEl.innerText = pct < 26 ? `DRY SPLIT ${pct}%` : `LOAD ${pct}%`;
    }
  }
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#f8f7f2';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#d4d0c5';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 4);
  ctx.lineTo(w * 0.5, h - 4);
  ctx.moveTo(4, h * 0.5);
  ctx.lineTo(w - 4, h * 0.5);
  ctx.stroke();

  const cx = w * 0.5;
  const cy = h * 0.5;
  const rad = Math.min(w, h) * 0.36;

  for (let i = 0; i < _brush.tufts.length; i++) {
    const b = _brush.tufts[i];
    const px = cx + (b.curX ?? b.baseX) * rad;
    const py = cy + (b.curY ?? b.baseY) * rad;
    const pr = Math.max(1.5, (b.curR ?? b.radiusScale) * rad * 0.62);

    if (sumiSettings.mode === 'water') {
      ctx.fillStyle = `rgba(38, 118, 210, ${(0.35 + 0.45 * b.weight).toFixed(2)})`;
    } else if (sumiSettings.mode === 'blow') {
      ctx.fillStyle = `rgba(95, 110, 125, ${(0.35 + 0.45 * b.weight).toFixed(2)})`;
    } else if (sumiSettings.mode === 'dry') {
      ctx.fillStyle = `rgba(180, 95, 35, ${(0.40 + 0.45 * b.weight).toFixed(2)})`;
    } else {
      const v = Math.round(190 * (1.0 - b.inkLoad * 0.92));
      ctx.fillStyle = `rgba(${v}, ${v}, ${v + 4}, ${(0.42 + 0.56 * b.weight).toFixed(2)})`;
    }
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function updateSumiSubtoolUI(mode) {
  const m = mode || sumiSettings.mode || 'draw';
  sumiSettings.mode = m;
  const map = {
    draw: 'btn-sumi-mode-draw',
    water: 'btn-sumi-mode-water',
    blow: 'btn-sumi-mode-blow',
    dry: 'btn-sumi-mode-dry'
  };
  Object.entries(map).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active-btn', k === m);
  });
  const inkLbl = document.getElementById('label-sumi-ink');
  const inkSlider = document.getElementById('slider-sumi-ink');
  const inkValEl = document.getElementById('val-sumi-ink');
  if (m === 'water') {
    if (inkLbl) inkLbl.innerText = 'INK AFFECTION';
    const v = Math.round(sumiSettings.inkAffection ?? 35);
    if (inkSlider) inkSlider.value = v;
    if (inkValEl) inkValEl.innerText = `${v}%`;
  } else {
    if (inkLbl) inkLbl.innerText = 'INK CONCENTRATION';
    const v = Math.round(sumiSettings.ink ?? 78);
    if (inkSlider) inkSlider.value = v;
    if (inkValEl) inkValEl.innerText = `${v}%`;
  }
  renderSumiBristlePreview();
}

export function syncSumiTip(engine) {
  _brush.rebuildTufts(sumiSettings.bristles, engine?.brush?.tip || null);
  renderSumiBristlePreview();
}

export function reDipSumi(engine) {
  _brush.rebuildTufts(sumiSettings.bristles, engine?.brush?.tip || null);
  _brush.reDip(false);
  renderSumiBristlePreview();
}

export function warmSumiSolver(engine) {
  const gr = engine?.gpuRenderer;
  if (!gr || !gr.supported || gr._contextLost) return null;
  if (!gr.sumiSolver) {
    gr.sumiSolver = new GpuSumiSolver(gr);
  }
  return gr.sumiSolver;
}

function stopLiveSimLoop() {
  if (_simRafId) {
    cancelAnimationFrame(_simRafId);
    _simRafId = 0;
  }
}

function ensureLiveSimLoop(engine) {
  if (_simRafId) return;
  const stepTick = () => {
    _simRafId = 0;
    const gr = engine?.gpuRenderer;
    const solver = gr?.sumiSolver;
    if (!solver || !solver.active || !solver.ready || gr._contextLost) return;

    if (!engine.isDrawing) {
      if (solver.simActiveFrames > 0) {
        solver.stepSimulation(engine, 0.016, false);
        solver.simActiveFrames--;
      } else {
        solver.syncTilesToCanvas2D(engine);
        return;
      }
    }

    if (solver.active && (engine.isDrawing || solver.simActiveFrames > 0)) {
      _simRafId = requestAnimationFrame(stepTick);
    }
  };
  _simRafId = requestAnimationFrame(stepTick);
}

export function initSumiPaint(app) {
  const panel = document.getElementById('panel-sumi');
  const btnCollapse = document.getElementById('btn-sumi-collapse');

  if (app._makeDraggable && panel) {
    app._makeDraggable(panel, document.getElementById('handle-sumi'));
  }

  if (btnCollapse) {
    btnCollapse.onclick = () => {
      const content = document.getElementById('sumi-content');
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'flex' : 'none';
        btnCollapse.innerText = isHidden ? '_' : '+';
      }
    };
  }
  updateSumiSubtoolUI(sumiSettings.mode);
}

export function activateSumiPaint(app) {
  const panel = document.getElementById('panel-sumi');
  if (panel) panel.classList.remove('hidden');
  if (app && app.getCurrentTipSettings) {
    const ts = app.getCurrentTipSettings();
    if (ts) syncSumiSettingsFromTip(ts);
  }
  _brush.rebuildTufts(sumiSettings.bristles, app?.engine?.brush?.tip || null);
  updateSumiSubtoolUI(sumiSettings.mode);
  app._status('SUMI-E INK ACTIVE');
}

export function deactivateSumiPaint(app) {
  const panel = document.getElementById('panel-sumi');
  if (panel) panel.classList.add('hidden');
  if (app && app.engine) {
    flushSumiToChunks(app.engine, true);
  }
}

export function flushSumiToChunks(engine, closeSession = true) {
  stopLiveSimLoop();
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver && solver.active) {
    solver.commitToChunks(engine, undefined, closeSession);
  }
}

export function forceDrySumi(engine) {
  stopLiveSimLoop();
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver && solver.active) {
    solver.forceDry(engine);
    if (engine.gpuRenderer) engine.gpuRenderer.requestRender();
    return true;
  }
  return false;
}

export function startSumiPaintStroke(engine, worldPos, e = null) {
  if (!engine) return;
  if (engine.brush) {
    if (engine.brush.sumiUseHeightmap !== undefined) sumiSettings.useHeightmap = !!engine.brush.sumiUseHeightmap;
    if (engine.brush.sumiHeightSource !== undefined) sumiSettings.heightSource = engine.brush.sumiHeightSource;
  }
  const solver = warmSumiSolver(engine);
  if (!solver || !solver.ready) return;

  _brush.rebuildTufts(sumiSettings.bristles, engine.brush?.tip || null);
  if (sumiSettings.autoReDip) {
    _brush.reDip(false);
  }
  _brush.beginStroke(1, 0);

  solver.beginStrokeSession(engine, worldPos, { ...sumiSettings });

  const baseSize = engine.brush.size || worldPos.size || 40;
  const effectiveSize = worldPos.size ? (baseSize * 0.40 + worldPos.size * 0.60) : baseSize;
  _lastStrokeWorld = { x: worldPos.x, y: worldPos.y, size: effectiveSize };
  _lastStrokeTime = performance.now();

  const modeInt = getModeInt(sumiSettings.mode);
  const tiltX = (e && Number.isFinite(e.tiltX)) ? e.tiltX / 90 : 0;
  const tiltY = (e && Number.isFinite(e.tiltY)) ? e.tiltY / 90 : 0;
  const segments = _brush.buildSegments({
    fromX: worldPos.x,
    fromY: worldPos.y,
    toX: worldPos.x,
    toY: worldPos.y,
    sizePx: effectiveSize,
    pressure: worldPos.pressure ?? 1.0,
    tiltX,
    tiltY,
    velX: 0,
    velY: 0,
    modeInt,
    stepWeight: 1.0,
    bridgeCapsule: false
  });

  const pigmentK = hexToPigmentK(worldPos.color || engine.brush.color);
  solver.stampAndStep(
    engine,
    segments,
    modeInt,
    { x: 0, y: 0 },
    worldPos.pressure ?? 1.0,
    pigmentK,
    { ...sumiSettings }
  );
  renderSumiBristlePreview();
  if (modeInt !== 3) {
    ensureLiveSimLoop(engine);
  }
}

export function paintSumiMove(engine, worldTo, dynamicSize, _opacMod, color, pressure, e = null, vFactor = 0) {
  if (!engine || !_lastStrokeWorld) return;
  const solver = engine.gpuRenderer?.sumiSolver;
  if (!solver || !solver.ready || !solver.active) return;

  const dx = worldTo.x - _lastStrokeWorld.x;
  const dy = worldTo.y - _lastStrokeWorld.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.6) return;

  const now = performance.now();
  const dt = Math.max(0.004, Math.min(0.05, (now - _lastStrokeTime) / 1000));
  const velX = (dx / dt) * 0.04;
  const velY = (dy / dt) * 0.04;
  const tiltX = (e && Number.isFinite(e.tiltX)) ? e.tiltX / 90 : 0;
  const tiltY = (e && Number.isFinite(e.tiltY)) ? e.tiltY / 90 : 0;
  const modeInt = getModeInt(sumiSettings.mode);
  const pigmentK = hexToPigmentK(color || engine.brush.color);

  const sw = engine?.brush?.speedWater ?? 0;
  const waterScale = Math.max(0.10, 1.0 + vFactor * (sw / 100.0) * 0.85);
  const effWater = Math.max(0, Math.min(100, sumiSettings.water * waterScale));
  const stepParams = { ...sumiSettings, water: effWater };

  const baseSize = engine.brush.size || dynamicSize || 40;
  const effectiveSize = dynamicSize ? (baseSize * 0.40 + dynamicSize * 0.60) : baseSize;

  // Fine sub-stepping keeps bristles overlapped into continuous ribbons across all brush sizes,
  // and bridges fast swipes with capsule segments so large strokes never break into dots
  const refStep = Math.max(2.0, effectiveSize * 0.20);
  const maxSubStep = Math.max(1.2, Math.min(refStep, effectiveSize * 0.045));
  const steps = Math.max(1, Math.min(96, Math.ceil(dist / maxSubStep)));
  const subDist = dist / steps;
  const stepWeight = Math.min(1.5, subDist / refStep);
  const bridgeCapsule = subDist > Math.max(1.8, effectiveSize * 0.06);
  const allSegs = [];

  for (let s = 0; s < steps; s++) {
    const t0 = s / steps;
    const t1 = (s + 1) / steps;
    const sx0 = _lastStrokeWorld.x + dx * t0;
    const sy0 = _lastStrokeWorld.y + dy * t0;
    const sx1 = _lastStrokeWorld.x + dx * t1;
    const sy1 = _lastStrokeWorld.y + dy * t1;

    const segs = _brush.buildSegments({
      fromX: sx0,
      fromY: sy0,
      toX: sx1,
      toY: sy1,
      sizePx: effectiveSize,
      pressure: pressure ?? 1.0,
      tiltX,
      tiltY,
      velX,
      velY,
      modeInt,
      stepWeight,
      bridgeCapsule,
      waterScale
    });
    for (let k = 0; k < segs.length; k++) allSegs.push(segs[k]);
  }

  solver.stampAndStep(
    engine,
    allSegs,
    modeInt,
    { x: Math.max(-18, Math.min(18, velX)), y: Math.max(-18, Math.min(18, velY)) },
    pressure ?? 1.0,
    pigmentK,
    stepParams
  );

  _lastStrokeWorld = { x: worldTo.x, y: worldTo.y, size: effectiveSize };
  _lastStrokeTime = now;

  if (now - _lastPreviewTime > 48) {
    _lastPreviewTime = now;
    renderSumiBristlePreview();
  }
  if (modeInt !== 3) {
    ensureLiveSimLoop(engine);
  }
}

export function endSumiPaintStroke(engine) {
  _lastStrokeWorld = null;
  if (!engine) return;
  const solver = engine.gpuRenderer?.sumiSolver;
  if (solver && solver.active) {
    // Sync current tiles to Canvas2D for Undo & Selection while keeping live ink/pore layers active
    solver.syncTilesToCanvas2D(engine);
    if (sumiSettings.mode === 'dry') {
      solver.simActiveFrames = 0;
    } else {
      solver.simActiveFrames = 540;
      ensureLiveSimLoop(engine);
    }
  }
  renderSumiBristlePreview();
}

export function cancelSumiStroke(engine) {
  stopLiveSimLoop();
  _lastStrokeWorld = null;
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver) {
    solver.cancel(engine, true);
  }
  renderSumiBristlePreview();
}
