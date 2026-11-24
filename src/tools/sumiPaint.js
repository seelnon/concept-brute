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
  mode: 'draw',          // 'draw' | 'water' | 'blow' | 'dry' | 'eraser'
  ink: 78,               // 0..100
  inkAffection: 35,      // 0..100 (independent water affection for 'water' subtool)
  water: 65,             // 0..100 ('draw' subtool water charge)
  waterWash: 75,         // 0..100 ('water' subtool water charge)
  eraserInk: 85,         // 0..100 ('eraser' subtool erase strength)
  eraserWater: 25,       // 0..100 ('eraser' subtool water charge)
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
  turbulence: 0,         // 0..100 (water curl turbulence)
  sootSnag: 55,          // 0..100
  depleteEnabled: true,
  splitEnabled: true,
  tiltEnabled: true,
  autoReDip: true,
  followStroke: false,
  tipAngle: 0,           // -180..180 deg
  pressureFlow: 35,      // 0..100
  pressureGate: 20,      // 0..100 (radial bristle contact taper under light pressure)
  maxWater: 100,         // 15..200 (max water puddle cap on paper)
  useHeightmap: false,
  heightSource: 'surface' // 'surface' | 'layer'
};

function computeSpeedWaterProfile(baseWaterPct, speedWaterSlider, vFactor) {
  const sw = Math.max(-100, Math.min(100, speedWaterSlider || 0));
  const spd = Math.max(0, Math.min(1, vFactor || 0));
  if (Math.abs(sw) < 0.01 || spd < 0.001) {
    return {
      effWaterPct: Math.max(0, Math.min(100, baseWaterPct)),
      waterMult: 1.0,
      addWaterNorm: 0.0,
      dryAmt: 0.0
    };
  }
  if (sw < 0) {
    const negStrength = (-sw) / 100.0;
    const dryAmt = Math.max(0, Math.min(1.0, Math.pow(spd, 0.72) * negStrength * 1.65));
    const remain = 1.0 - dryAmt;
    return {
      effWaterPct: Math.max(0, baseWaterPct * remain),
      waterMult: remain,
      addWaterNorm: 0.0,
      dryAmt
    };
  }
  const posStrength = sw / 100.0;
  const addWaterNorm = Math.pow(spd, 0.85) * posStrength * 1.50;
  const effWaterPct = Math.max(0, Math.min(165, baseWaterPct + addWaterNorm * 100.0));
  return {
    effWaterPct,
    waterMult: 1.0,
    addWaterNorm,
    dryAmt: 0.0
  };
}

function getEffectiveSumiParams(s = sumiSettings, effWaterOverride = null, effInkOverride = null) {
  const m = s.mode || 'draw';
  let inkVal = effInkOverride !== null ? effInkOverride : (s.ink ?? 78);
  let waterVal = s.water ?? 65;
  if (m === 'water') {
    waterVal = s.waterWash ?? s.water ?? 75;
  } else if (m === 'eraser') {
    inkVal = effInkOverride !== null ? effInkOverride : (s.eraserInk ?? 85);
    waterVal = s.eraserWater ?? 25;
  }
  const effWater = effWaterOverride !== null
    ? Math.max(0, Math.min(165, effWaterOverride))
    : Math.max(0, Math.min(100, waterVal));
  return { ...s, ink: Math.max(0, Math.min(150, inkVal)), water: effWater };
}

function getPressureInkMod(engine, pressure, e) {
  if (!engine || !engine.brush || engine.brush.pressureEnabled === false) return 1.0;
  if (e && e.pointerType && e.pointerType !== 'pen') return 1.0;
  if ((!e || !e.pointerType) && (pressure === undefined || pressure >= 0.999)) return 1.0;
  const inf = engine.brush.pressureOpacityInfluence ?? 0.0;
  if (Math.abs(inf) < 0.001) return 1.0;
  const p = Math.max(0.01, Math.min(1.0, pressure ?? 1.0));
  return Math.max(0.03, Math.min(1.5, (1.0 - inf) + p * inf));
}

export function syncSumiSettingsFromTip(tipSettings) {
  if (!tipSettings) return;
  sumiSettings.mode = tipSettings.sumiMode || sumiSettings.mode || 'draw';
  sumiSettings.ink = tipSettings.sumiInk ?? 78;
  sumiSettings.inkAffection = tipSettings.sumiInkAffection ?? 35;
  sumiSettings.water = tipSettings.sumiWater ?? 65;
  sumiSettings.waterWash = tipSettings.sumiWaterWash ?? tipSettings.sumiWater ?? 75;
  sumiSettings.eraserInk = tipSettings.sumiEraserInk ?? 85;
  sumiSettings.eraserWater = tipSettings.sumiEraserWater ?? 25;
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
  sumiSettings.turbulence = tipSettings.sumiTurbulence ?? 0;
  sumiSettings.sootSnag = tipSettings.sumiSootSnag ?? 55;
  sumiSettings.depleteEnabled = tipSettings.sumiDeplete !== undefined ? !!tipSettings.sumiDeplete : true;
  sumiSettings.splitEnabled = tipSettings.sumiSplitEnabled !== undefined ? !!tipSettings.sumiSplitEnabled : true;
  sumiSettings.tiltEnabled = tipSettings.sumiTilt !== undefined ? !!tipSettings.sumiTilt : true;
  sumiSettings.autoReDip = tipSettings.sumiAutoReDip !== undefined ? !!tipSettings.sumiAutoReDip : true;
  sumiSettings.followStroke = !!tipSettings.sumiFollowStroke;
  sumiSettings.tipAngle = tipSettings.sumiTipAngle ?? 0;
  sumiSettings.pressureFlow = tipSettings.sumiPressureFlow ?? 35;
  sumiSettings.pressureGate = tipSettings.sumiPressureGate ?? 20;
  sumiSettings.maxWater = tipSettings.sumiMaxWater ?? 100;
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
    waterMult = 1.0,
    addWaterNorm = 0.0,
    dryAmt = 0.0,
    inkScale = 1.0,
    snapDir = false
  }) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const stepDist = Math.hypot(dx, dy);

    let dirX = this.lastDirX;
    let dirY = this.lastDirY;
    if (stepDist > 0.15) {
      const ndx = dx / stepDist;
      const ndy = dy / stepDist;
      if (snapDir) {
        this.lastDirX = ndx;
        this.lastDirY = ndy;
      } else {
        this.lastDirX = this.lastDirX * 0.65 + ndx * 0.35;
        this.lastDirY = this.lastDirY * 0.65 + ndy * 0.35;
        const n = Math.hypot(this.lastDirX, this.lastDirY) || 1;
        this.lastDirX /= n;
        this.lastDirY /= n;
      }
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
    const baseDryness = Math.max(0, 1.0 - this.avgWaterRes * 1.15);
    const dryness = Math.min(
      1.0,
      Math.max(0, baseDryness * (1.0 - Math.min(0.85, addWaterNorm * 0.75)) + dryAmt * 0.92)
    );
    const speedFactor = Math.min(1.0, speed / 22.0);
    const effSplitThresh = Math.max(splitThresh, dryAmt * 0.88);
    const rawSplit = sumiSettings.splitEnabled
      ? Math.max(0, (dryness * 0.78 + speedFactor * 0.42) * effSplitThresh * 1.45 - 0.10 + dryAmt * 0.32)
      : 0;
    this.splitAmount = dryAmt > 0.25
      ? (this.splitAmount * 0.45 + Math.min(1.0, rawSplit) * 0.55)
      : (this.splitAmount * 0.70 + Math.min(1.0, rawSplit) * 0.30);

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
    const gateInf = Math.max(0, Math.min(1, (sumiSettings.pressureGate ?? 20) / 100));
    const splayP = (1.0 - gateInf) * 0.85 + gateInf * pClamped;
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

      const splay = 1.0 + splayP * (1.0 - stiffness * 0.55) * 0.25;
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

      const rPMod = (1.0 - gateInf) + gateInf * (0.76 + pClamped * 0.32);
      const rPx = Math.max(1.1, contactRadiusPx * b.radiusScale * rPMod * (1.0 - this.splitAmount * 0.34));
      b.curR = rPx / Math.max(contactRadiusPx, 1.0);

      const rawGate = Math.max(0.0, Math.min(1.0, (pClamped * 1.32 - b.radialDist * 0.40) * 1.45));
      const pressureGate = ((1.0 - gateInf) + gateInf * rawGate) * b.alphaWeight;

      let inkW = 0;
      let waterW = 0;
      let contactW = pressureGate * flowGain * stepWeight;
      if (modeInt === 0) {
        const wCharge = (sumiSettings.water / 100) * 1.25 * b.waterLoad * waterMult + addWaterNorm * (0.55 + 0.65 * b.waterLoad);
        inkW = (sumiSettings.ink / 100) * inkScale * b.inkLoad * pressureGate * flowGain * stepWeight * densityNorm;
        waterW = wCharge * pressureGate * flowGain * stepWeight * densityNorm;
      } else if (modeInt === 1) {
        const wWash = ((sumiSettings.waterWash ?? sumiSettings.water ?? 75) / 100) * 1.85 * waterMult + addWaterNorm * 1.35;
        waterW = wWash * pressureGate * flowGain * stepWeight * densityNorm;
      } else if (modeInt === 2) {
        const blowScale = Math.max(0.35, stepWeight);
        waterW = pressureGate * blowScale;
        contactW = pressureGate * blowScale;
      } else if (modeInt === 4) {
        const eInk = ((sumiSettings.eraserInk ?? 85) / 100) * inkScale;
        const eWat = ((sumiSettings.eraserWater ?? 25) / 100) * b.waterLoad * waterMult + addWaterNorm * 0.85;
        inkW = eInk * b.inkLoad * pressureGate * flowGain * stepWeight * densityNorm;
        waterW = eWat * pressureGate * flowGain * stepWeight * densityNorm;
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

      if ((modeInt === 0 || modeInt === 4) && sumiSettings.depleteEnabled && stepDist > 0.1) {
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
let _lastRawPt = null;
let _lastMidPt = null;
let _isFirstMove = false;
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
  if (mode === 'eraser') return 4;
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
    } else if (sumiSettings.mode === 'eraser') {
      const pct = Math.round(_brush.avgInkRes * 100);
      stateEl.innerText = pct < 26 ? `ERASE SPLIT ${pct}%` : 'INK ERASER';
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
    } else if (sumiSettings.mode === 'eraser') {
      ctx.fillStyle = `rgba(215, 68, 80, ${(0.35 + 0.55 * b.inkLoad * b.weight).toFixed(2)})`;
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
    dry: 'btn-sumi-mode-dry',
    eraser: 'btn-sumi-mode-eraser'
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
  } else if (m === 'eraser') {
    if (inkLbl) inkLbl.innerText = 'ERASE STRENGTH';
    const v = Math.round(sumiSettings.eraserInk ?? 85);
    if (inkSlider) inkSlider.value = v;
    if (inkValEl) inkValEl.innerText = `${v}%`;
  } else {
    if (inkLbl) inkLbl.innerText = 'INK CONCENTRATION';
    const v = Math.round(sumiSettings.ink ?? 78);
    if (inkSlider) inkSlider.value = v;
    if (inkValEl) inkValEl.innerText = `${v}%`;
  }

  const watLbl = document.getElementById('label-sumi-water');
  const watSlider = document.getElementById('slider-sumi-water');
  const watValEl = document.getElementById('val-sumi-water');
  if (watLbl) watLbl.innerText = 'WATER CHARGE';
  let wVal = sumiSettings.water ?? 65;
  if (m === 'water') {
    wVal = sumiSettings.waterWash ?? 75;
  } else if (m === 'eraser') {
    wVal = sumiSettings.eraserWater ?? 25;
  }
  const wRounded = Math.round(wVal);
  if (watSlider) watSlider.value = wRounded;
  if (watValEl) watValEl.innerText = `${wRounded}%`;

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
  if (gr.sumiSolver.ready && gr.sumiSolver.prewarmPipelines) {
    gr.sumiSolver.prewarmPipelines(engine);
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
  let idleTick = 0;
  const stepTick = () => {
    _simRafId = 0;
    const gr = engine?.gpuRenderer;
    const solver = gr?.sumiSolver;
    if (!solver || !solver.active || !solver.ready || gr._contextLost) return;

    // Water propagates continuously in real time — throttle gently during late idle settling
    if (solver.simActiveFrames > 0) {
      const isIdleDecay = !engine.isDrawing && solver.simActiveFrames < 260;
      idleTick = (idleTick + 1) & 1;
      if (!isIdleDecay || idleTick === 0) {
        solver.stepSimulation(engine, isIdleDecay ? 0.024 : 0.016, false);
      }
      solver.simActiveFrames--;
    } else if (!engine.isDrawing) {
      solver.syncTilesToCanvas2D(engine);
      return;
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

  const startPres = worldPos.pressure ?? 1.0;
  const startInkMod = getPressureInkMod(engine, startPres, e);
  const modeInt = getModeInt(sumiSettings.mode);
  const baseInkPct = modeInt === 4 ? (sumiSettings.eraserInk ?? 85) : (sumiSettings.ink ?? 78);
  const effParams = getEffectiveSumiParams(sumiSettings, null, baseInkPct * startInkMod);
  solver.beginStrokeSession(engine, worldPos, effParams);

  const baseSize = engine.brush.size || worldPos.size || 40;
  const effectiveSize = Math.max(1.5, worldPos.size || baseSize);
  const tiltX = (e && Number.isFinite(e.tiltX)) ? e.tiltX / 90 : 0;
  const tiltY = (e && Number.isFinite(e.tiltY)) ? e.tiltY / 90 : 0;

  _lastStrokeWorld = { x: worldPos.x, y: worldPos.y, size: effectiveSize };
  _lastRawPt = {
    x: worldPos.x,
    y: worldPos.y,
    size: effectiveSize,
    pressure: startPres,
    inkMod: startInkMod,
    color: worldPos.color || engine.brush.color,
    vFactor: 0,
    tiltX,
    tiltY
  };
  _lastMidPt = null;
  _isFirstMove = true;
  _lastStrokeTime = performance.now();

  const segments = _brush.buildSegments({
    fromX: worldPos.x,
    fromY: worldPos.y,
    toX: worldPos.x,
    toY: worldPos.y,
    sizePx: effectiveSize,
    pressure: startPres,
    tiltX,
    tiltY,
    velX: 0,
    velY: 0,
    modeInt,
    stepWeight: 1.0,
    bridgeCapsule: false,
    inkScale: startInkMod
  });

  const pigmentK = hexToPigmentK(worldPos.color || engine.brush.color);
  solver.stampAndStep(
    engine,
    segments,
    modeInt,
    { x: 0, y: 0 },
    startPres,
    pigmentK,
    effParams
  );
  renderSumiBristlePreview();
  if (modeInt !== 3) {
    ensureLiveSimLoop(engine);
  }
}

function _emitQuadraticCurveBatch(engine, solver, pStart, pCtrl, pEnd, modeInt, velMag, dt, sw, color) {
  const arcEst =
    Math.hypot(pCtrl.x - pStart.x, pCtrl.y - pStart.y) +
    Math.hypot(pEnd.x - pCtrl.x, pEnd.y - pCtrl.y);
  if (arcEst < 0.2) return;

  const avgSize = (pStart.size + pEnd.size) * 0.5;
  const refStep = Math.max(2.0, avgSize * 0.20);
  const maxSubStep = Math.max(1.1, Math.min(refStep, avgSize * 0.042));
  const steps = Math.max(1, Math.min(128, Math.ceil(arcEst / maxSubStep)));

  const baseInkPct = modeInt === 4 ? (sumiSettings.eraserInk ?? 85) : (sumiSettings.ink ?? 78);
  const baseWaterPct = modeInt === 1
    ? (sumiSettings.waterWash ?? sumiSettings.water ?? 75)
    : (modeInt === 4 ? (sumiSettings.eraserWater ?? 25) : (sumiSettings.water ?? 65));
  const pigmentK = hexToPigmentK(color || engine.brush.color);

  const tuftsPerStep = Math.max(8, _brush.tufts.length);
  const maxStepsPerDispatch = Math.max(8, Math.floor(3800 / tuftsPerStep));

  let batchSegs = [];
  let batchSteps = 0;
  let batchWaterSum = 0;
  let batchInkSum = 0;
  let lastVelX = 0;
  let lastVelY = 0;
  let prevX = pStart.x;
  let prevY = pStart.y;

  const flushBatch = () => {
    if (batchSegs.length === 0) return;
    const avgEffW = batchWaterSum / Math.max(1, batchSteps);
    const avgEffInk = batchInkSum / Math.max(1, batchSteps);
    const stepParams = getEffectiveSumiParams(sumiSettings, avgEffW, avgEffInk);
    solver.stampAndStep(
      engine,
      batchSegs,
      modeInt,
      { x: Math.max(-18, Math.min(18, lastVelX)), y: Math.max(-18, Math.min(18, lastVelY)) },
      pEnd.pressure ?? 1.0,
      pigmentK,
      stepParams
    );
    batchSegs = [];
    batchSteps = 0;
    batchWaterSum = 0;
    batchInkSum = 0;
  };

  for (let s = 0; s < steps; s++) {
    const t1 = (s + 1) / steps;
    const omt = 1 - t1;
    const nx = omt * omt * pStart.x + 2 * omt * t1 * pCtrl.x + t1 * t1 * pEnd.x;
    const ny = omt * omt * pStart.y + 2 * omt * t1 * pCtrl.y + t1 * t1 * pEnd.y;
    const subDist = Math.hypot(nx - prevX, ny - prevY);

    // Quadratic Bezier tangent at midpoint parameter tMid
    const tMid = (s + 0.5) / steps;
    const tanX = 2 * (1 - tMid) * (pCtrl.x - pStart.x) + 2 * tMid * (pEnd.x - pCtrl.x);
    const tanY = 2 * (1 - tMid) * (pCtrl.y - pStart.y) + 2 * tMid * (pEnd.y - pCtrl.y);
    const tanLen = Math.hypot(tanX, tanY) || 1;
    const subVelX = (tanX / tanLen) * velMag;
    const subVelY = (tanY / tanLen) * velMag;
    lastVelX = subVelX;
    lastVelY = subVelY;

    const stepSize = pStart.size + (pEnd.size - pStart.size) * t1;
    const stepPres = pStart.pressure + (pEnd.pressure - pStart.pressure) * t1;
    const stepInkMod = (pStart.inkMod ?? 1.0) + ((pEnd.inkMod ?? 1.0) - (pStart.inkMod ?? 1.0)) * t1;
    const stepTiltX = (pStart.tiltX || 0) + ((pEnd.tiltX || 0) - (pStart.tiltX || 0)) * t1;
    const stepTiltY = (pStart.tiltY || 0) + ((pEnd.tiltY || 0) - (pStart.tiltY || 0)) * t1;
    const stepVFactor = (pStart.vFactor || 0) + ((pEnd.vFactor || 0) - (pStart.vFactor || 0)) * t1;

    const swProf = computeSpeedWaterProfile(baseWaterPct, sw, stepVFactor);
    batchWaterSum += swProf.effWaterPct;
    batchInkSum += baseInkPct * stepInkMod;
    batchSteps++;

    const stepWeight = Math.min(1.5, subDist / Math.max(2.0, stepSize * 0.20));
    const bridgeCapsule = subDist > Math.max(1.6, stepSize * 0.055);

    const segs = _brush.buildSegments({
      fromX: prevX,
      fromY: prevY,
      toX: nx,
      toY: ny,
      sizePx: stepSize,
      pressure: stepPres,
      tiltX: stepTiltX,
      tiltY: stepTiltY,
      velX: subVelX,
      velY: subVelY,
      modeInt,
      stepWeight,
      bridgeCapsule,
      waterMult: swProf.waterMult,
      addWaterNorm: swProf.addWaterNorm,
      dryAmt: swProf.dryAmt,
      inkScale: stepInkMod,
      snapDir: _isFirstMove
    });
    _isFirstMove = false;
    for (let k = 0; k < segs.length; k++) batchSegs.push(segs[k]);

    prevX = nx;
    prevY = ny;

    if (batchSteps >= maxStepsPerDispatch) {
      flushBatch();
    }
  }
  flushBatch();
}

export function paintSumiMove(engine, worldTo, dynamicSize, _opacMod, color, pressure, e = null, vFactor = 0) {
  if (!engine || !_lastRawPt) return;
  const solver = engine.gpuRenderer?.sumiSolver;
  if (!solver || !solver.ready || !solver.active) return;

  const dx = worldTo.x - _lastRawPt.x;
  const dy = worldTo.y - _lastRawPt.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.6) return;

  const now = performance.now();
  const dt = Math.max(0.004, Math.min(0.05, (now - _lastStrokeTime) / 1000));
  const velMag = (dist / dt) * 0.04;
  const tiltX = (e && Number.isFinite(e.tiltX)) ? e.tiltX / 90 : 0;
  const tiltY = (e && Number.isFinite(e.tiltY)) ? e.tiltY / 90 : 0;
  const modeInt = getModeInt(sumiSettings.mode);
  const sw = engine?.brush?.speedWater ?? 0;

  const baseSize = engine.brush.size || dynamicSize || 40;
  const effectiveSize = Math.max(1.5, dynamicSize || baseSize);
  const curPres = pressure ?? 1.0;
  const curInkMod = getPressureInkMod(engine, curPres, e);

  const pNew = {
    x: worldTo.x,
    y: worldTo.y,
    size: effectiveSize,
    pressure: curPres,
    inkMod: curInkMod,
    color: color || engine.brush.color,
    vFactor,
    tiltX,
    tiltY
  };

  if (!_lastMidPt) {
    const mid1 = {
      x: (_lastRawPt.x + pNew.x) * 0.5,
      y: (_lastRawPt.y + pNew.y) * 0.5,
      size: (_lastRawPt.size + pNew.size) * 0.5,
      pressure: (_lastRawPt.pressure + pNew.pressure) * 0.5,
      inkMod: ((_lastRawPt.inkMod ?? 1.0) + pNew.inkMod) * 0.5,
      color: pNew.color,
      vFactor: (_lastRawPt.vFactor + pNew.vFactor) * 0.5,
      tiltX: (_lastRawPt.tiltX + pNew.tiltX) * 0.5,
      tiltY: (_lastRawPt.tiltY + pNew.tiltY) * 0.5
    };
    const ctrl0 = {
      x: (_lastRawPt.x + mid1.x) * 0.5,
      y: (_lastRawPt.y + mid1.y) * 0.5
    };
    _emitQuadraticCurveBatch(engine, solver, _lastRawPt, ctrl0, mid1, modeInt, velMag, dt, sw, pNew.color);
    _lastMidPt = mid1;
  } else {
    const mid2 = {
      x: (_lastRawPt.x + pNew.x) * 0.5,
      y: (_lastRawPt.y + pNew.y) * 0.5,
      size: (_lastRawPt.size + pNew.size) * 0.5,
      pressure: (_lastRawPt.pressure + pNew.pressure) * 0.5,
      inkMod: ((_lastRawPt.inkMod ?? 1.0) + pNew.inkMod) * 0.5,
      color: pNew.color,
      vFactor: (_lastRawPt.vFactor + pNew.vFactor) * 0.5,
      tiltX: (_lastRawPt.tiltX + pNew.tiltX) * 0.5,
      tiltY: (_lastRawPt.tiltY + pNew.tiltY) * 0.5
    };
    _emitQuadraticCurveBatch(engine, solver, _lastMidPt, _lastRawPt, mid2, modeInt, velMag, dt, sw, pNew.color);
    _lastMidPt = mid2;
  }

  _lastRawPt = pNew;
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
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver && solver.active && solver.ready && _lastMidPt && _lastRawPt) {
    const remDist = Math.hypot(_lastRawPt.x - _lastMidPt.x, _lastRawPt.y - _lastMidPt.y);
    if (remDist > 0.35) {
      const modeInt = getModeInt(sumiSettings.mode);
      const sw = engine?.brush?.speedWater ?? 0;
      const dt = Math.max(0.004, Math.min(0.05, (performance.now() - _lastStrokeTime) / 1000));
      const velMag = (remDist / dt) * 0.04;
      const ctrlEnd = {
        x: (_lastMidPt.x + _lastRawPt.x) * 0.5,
        y: (_lastMidPt.y + _lastRawPt.y) * 0.5
      };
      _emitQuadraticCurveBatch(
        engine,
        solver,
        _lastMidPt,
        ctrlEnd,
        _lastRawPt,
        modeInt,
        velMag,
        dt,
        sw,
        _lastRawPt.color || engine.brush.color
      );
    }
  }
  _lastStrokeWorld = null;
  _lastRawPt = null;
  _lastMidPt = null;
  _isFirstMove = false;

  if (!engine) return;
  if (solver && solver.active) {
    // Sync current tiles to Canvas2D for Undo & Selection while keeping live ink/pore layers active
    solver.syncTilesToCanvas2D(engine);
    if (sumiSettings.mode === 'dry') {
      solver.simActiveFrames = 0;
    } else {
      const evapPct = sumiSettings.evaporation ?? 28;
      solver.simActiveFrames = evapPct < 2 ? 320 : 480;
      ensureLiveSimLoop(engine);
    }
  }
  renderSumiBristlePreview();
}

export function cancelSumiStroke(engine) {
  stopLiveSimLoop();
  _lastStrokeWorld = null;
  _lastRawPt = null;
  _lastMidPt = null;
  _isFirstMove = false;
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver) {
    solver.cancel(engine, true);
  }
  renderSumiBristlePreview();
}

export function flushSumiCaches(engine) {
  stopLiveSimLoop();
  _lastStrokeWorld = null;
  _lastRawPt = null;
  _lastMidPt = null;
  _isFirstMove = false;
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver) {
    solver.cancel(engine, false);
  }
}

export function clearSumiPassiveArchive(engine, layerIndex = null) {
  const solver = engine?.gpuRenderer?.sumiSolver;
  if (solver && typeof solver.clearPassiveArchive === 'function') {
    const projId = engine?.currentProjectId || 'default';
    solver.clearPassiveArchive(projId, layerIndex);
  }
}
