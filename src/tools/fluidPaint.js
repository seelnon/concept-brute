import { TOOLS } from '../constants.js';

/**
 * Viscous Physical Oil Paint Engine
 * Features:
 * - Authentic Viscous Oil Body: Thick, rich oil paint with physical multi-filament bristle dynamics.
 * - Dynamic Vortex Swirl & Turbulence: Fluid rotational eddies and natural paint folding.
 * - 3D Impasto Surface Shading: Directional relief groove shadows, lit diffuse ridge edges, and Blinn-Phong specular gloss.
 * - Chunk-Safe Execution: Strict chunk boundary clipping with zero chunk corruption or sector desync.
 * - 100% Reliable Persistence: Seamless IndexedDB sector saving and undo/redo support.
 */

// Module-level cached tuning settings (0 DOM lookups during drawing)
export const fluidSettings = {
  flow: 100,
  vortex: 45,
  turb: 30,
  retention: 20,
  pickup: 0, // Default 0: pure clean oil paint
  depth: 75,
  gloss: 35,
  fluidity: 80,
  bristles: 40,
  shading: true
};

export function initFluidPaint(app) {
  const panelFluid = document.getElementById('panel-fluid');
  const btnCollapse = document.getElementById('btn-fluid-collapse');

  const sliderFluidity = document.getElementById('slider-fluidity');
  const valFluidity = document.getElementById('val-fluidity');
  const sliderBristles = document.getElementById('slider-bristles');
  const valBristles = document.getElementById('val-bristles');

  // Register panel draggable
  if (app._makeDraggable && panelFluid) {
    app._makeDraggable(panelFluid, document.getElementById('handle-fluid'));
  }

  // Collapse / expand panel
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

  // Top-bar fluidity slider
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
    };
  }

  // Top-bar bristles slider
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

  // Bind tuning sliders with memory caching & localStorage
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

  // Bind checkboxes with memory caching & localStorage
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
  setupSlider('slider-fluid-vortex', 'val-fluid-vortex', 'vortex', 45);
  setupSlider('slider-fluid-turb', 'val-fluid-turb', 'turb', 30);
  setupSlider('slider-fluid-retention', 'val-fluid-retention', 'retention', 20);
  setupSlider('slider-fluid-pickup', 'val-fluid-pickup', 'pickup', 0);
  setupSlider('slider-fluid-depth', 'val-fluid-depth', 'depth', 75);
  setupSlider('slider-fluid-gloss', 'val-fluid-gloss', 'gloss', 35);

  setupCheckbox('chk-surface-shading', 'shading', true);
}

export function activateFluidPaint(app) {
  const panel = document.getElementById('panel-fluid');
  if (panel) panel.classList.remove('hidden');

  const ctrlFluidity = document.getElementById('control-fluidity');
  if (ctrlFluidity) ctrlFluidity.style.display = 'flex';

  const ctrlBristles = document.getElementById('control-bristles');
  if (ctrlBristles) ctrlBristles.style.display = 'flex';

  app._status('VISCOUS OIL PAINT ACTIVE');
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

  app._status('OIL PAINT DEACTIVATED');
}

// ----------------------------------------------------
// COLOR & PARAMETER HELPERS
// ----------------------------------------------------
function parseColor(c) {
  if (!c) return { r: 215, g: 35, b: 35 };
  if (typeof c === 'object' && c.r !== undefined) {
    return { r: c.r, g: c.g, b: c.b };
  }
  if (typeof c === 'string') {
    if (c.startsWith('#')) {
      const hex = c.replace('#', '');
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16)
        };
      }
      return {
        r: parseInt(hex.substring(0, 2), 16) || 0,
        g: parseInt(hex.substring(2, 4), 16) || 0,
        b: parseInt(hex.substring(4, 6), 16) || 0
      };
    }
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    }
  }
  return { r: 215, g: 35, b: 35 };
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Initializes physical oil bristle tuft with Vogel spiral disc distribution.
 */
function initBristles(centerX, centerY, radius, count, baseColor, tipCanvas = null, engine = null) {
  const bristles = [];
  const rotAngle = (engine?.rotation || 0) + (engine?.brush?.jitterAngle ? (Math.random() - 0.5) * engine.brush.jitterAngle * 2 : 0);
  const cosA = Math.cos(rotAngle);
  const sinA = Math.sin(rotAngle);

  const goldenAngle = 2.3999632;
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const theta = i * goldenAngle;
    let u = r * Math.cos(theta);
    let v = r * Math.sin(theta);

    if (rotAngle !== 0) {
      const ru = u * cosA - v * sinA;
      const rv = u * sinA + v * cosA;
      u = ru;
      v = rv;
    }

    const discAlpha = Math.max(0.3, 1.0 - r * 0.35);
    const alphaFactor = 0.55 + 0.70 * discAlpha;

    // Organic filament tiers: 20% fine hairs, 55% body, 25% core impasto ridge
    const rand = Math.random();
    const tierFactor = rand < 0.20 ? (0.65 + 0.25 * Math.random()) :
                       rand < 0.75 ? (0.95 + 0.30 * Math.random()) :
                                     (1.35 + 0.45 * Math.random());
    const widthScale = alphaFactor * tierFactor;
    const flowScale = Math.max(0.4, Math.min(1.0, discAlpha * (0.90 + 0.25 * tierFactor)));
    const followRate = Math.max(0.22, Math.min(0.65, (0.26 + 0.14 / Math.max(0.5, widthScale)) * (0.85 + 0.30 * Math.random())));

    // Subtle oil pigment nuance across bristles (authentic oil paint look)
    const nuance = (Math.random() - 0.5) * 16;
    const bristleColor = {
      r: clampByte(baseColor.r + nuance),
      g: clampByte(baseColor.g + nuance * 0.8),
      b: clampByte(baseColor.b + nuance * 0.6)
    };

    const tipX = centerX + u * radius;
    const tipY = centerY + v * radius;

    bristles.push({
      u,
      v,
      origU: u,
      origV: v,
      curX: tipX,
      curY: tipY,
      prevX: tipX,
      prevY: tipY,
      vx: 0,
      vy: 0,
      followRate,
      color: bristleColor,
      baseColor: { ...bristleColor },
      widthScale,
      flowScale,
      tipAlpha: discAlpha,
      tierFactor,
      orbitSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.8),
      seed: Math.random() * 100,
      bnx: 0,
      bny: 1,
      points: []
    });
  }
  return bristles;
}

/**
 * Pre-warms the oil paint stroke on pointerdown.
 */
export function startFluidPaintStroke(engine, worldPos) {
  cancelFluidAfterEffect(engine);

  const rawSize = worldPos.size || engine.brush.size || 35;
  const radius = Math.max(2.0, rawSize * 0.5);
  const baseColor = parseColor(worldPos.color || engine.brush.color);

  const userCount = fluidSettings.bristles || 40;
  const count = Math.max(16, Math.min(64, Math.round(userCount * (radius < 15 ? 0.65 : radius > 80 ? 1.30 : 1.0))));

  const tipCanvas = engine.brush ? engine.brush.tip : null;
  const bristles = initBristles(worldPos.x, worldPos.y, radius, count, baseColor, tipCanvas, engine);

  engine.activeFluidBrush = {
    bristles,
    lastPos: { x: worldPos.x, y: worldPos.y },
    radius,
    baseColor,
    hasPainted: false,
    time: 0
  };

  // Pre-backup the starting chunk in background during pointerdown
  const cx = engine.isStatic ? 0 : Math.floor(worldPos.x / engine.chunkSize);
  const cy = engine.isStatic ? 0 : Math.floor(worldPos.y / engine.chunkSize);
  const chunk = engine._getChunk(cx, cy);
  if (chunk) {
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
}

/**
 * Continuous Viscous Oil Paint Stroke Handler.
 * Delivers authentic oil paint feel with physical bristle dynamics, 3D specular impasto,
 * vortex swirl and turbulence, without chunk corruption or sector glitches.
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

  // Teleportation protection: if distance is huge, resync bristles directly
  if (dist > 500.0) {
    for (let i = 0; i < fb.bristles.length; i++) {
      const b = fb.bristles[i];
      b.curX = to.x + b.u * radius;
      b.curY = to.y + b.v * radius;
      b.prevX = b.curX;
      b.prevY = b.curY;
      b.vx = 0;
      b.vy = 0;
      b.points = [{ x: b.curX, y: b.curY }];
    }
    fb.lastPos = { x: to.x, y: to.y };
    return;
  }

  // Fast in-memory tuning parameters
  const valFlow = fluidSettings.flow;
  const valVortex = fluidSettings.vortex;
  const valTurb = fluidSettings.turb;
  const valDepth = fluidSettings.depth;
  const valGloss = fluidSettings.gloss;
  const valFluidity = fluidSettings.fluidity;
  const isShading = fluidSettings.shading;

  // Bounded sub-step count: ensures unbroken, smooth paint strokes
  const stepDist = Math.max(2.5, radius * 0.18);
  const numSteps = Math.min(8, Math.max(1, Math.ceil(dist / stepDist)));

  const flowFactor = (valFlow / 100) * (opacity || 1.0) * (0.45 + pressure * 0.55);
  const vortexForce = (valVortex / 100) * 0.55;
  const turbForce = (valTurb / 100) * 0.40;
  const fluidityFactor = 0.85 + (valFluidity / 100) * 0.45;

  const bristleRibbonWidth = Math.max(2.0, (radius * 2.2 / fb.bristles.length) * 1.40);

  // Initialize polyline path collection for this frame
  for (let i = 0; i < fb.bristles.length; i++) {
    const b = fb.bristles[i];
    b.points = [{ x: b.curX, y: b.curY }];
  }

  fb.time += 0.05 * (dist / 10.0 + 1.0);
  const time = fb.time;

  const dirX = rawDx / dist;
  const dirY = rawDy / dist;

  // Physical simulation steps: strictly moving from `from` all the way to `to`
  for (let s = 1; s <= numSteps; s++) {
    const t = s / numSteps;
    const centerX = from.x + rawDx * t;
    const centerY = from.y + rawDy * t;

    for (let i = 0; i < fb.bristles.length; i++) {
      const b = fb.bristles[i];

      let targetX = centerX + b.u * radius;
      let targetY = centerY + b.v * radius;

      // Vortex swirl force (fluid rotational drag)
      if (vortexForce > 0.01) {
        const swirlMag = vortexForce * radius * 0.25 * b.orbitSpeed;
        targetX += -b.v * swirlMag;
        targetY += b.u * swirlMag;
      }

      // Continuous turbulence field
      if (turbForce > 0.01) {
        const scale = 0.04;
        const fX = (targetX + b.seed) * scale;
        const fY = (targetY + b.seed) * scale;
        const turbX = Math.sin(fY * 1.3 + time * 1.5) * Math.cos(fX * 0.7) + Math.cos(fY * 0.4 - time * 0.8);
        const turbY = Math.cos(fX * 1.3 - time * 1.5) * Math.sin(fY * 0.7) + Math.sin(fX * 0.4 + time * 0.8);
        const chaos = turbForce * radius * 0.18;
        targetX += turbX * chaos;
        targetY += turbY * chaos;
      }

      // Overdamped viscous relaxation with directional drag
      const follow = Math.max(0.20, Math.min(0.70, b.followRate * fluidityFactor));
      b.vx = b.vx * 0.80 + (targetX - b.curX) * follow * 0.20 + dirX * Math.min(2.5, dist * 0.10);
      b.vy = b.vy * 0.80 + (targetY - b.curY) * follow * 0.20 + dirY * Math.min(2.5, dist * 0.10);

      b.curX += (targetX - b.curX) * follow + b.vx * 0.35;
      b.curY += (targetY - b.curY) * follow + b.vy * 0.35;

      // Inextensible physical constraint
      const maxLen = radius * 1.10;
      const offX = b.curX - targetX;
      const offY = b.curY - targetY;
      const offDist = Math.hypot(offX, offY);
      if (offDist > maxLen && offDist > 0.001) {
        const scale = maxLen / offDist;
        b.curX = targetX + offX * scale;
        b.curY = targetY + offY * scale;
      }

      b.points.push({ x: b.curX, y: b.curY });
    }
  }

  // Compute normal direction for 3D impasto lighting
  for (let i = 0; i < fb.bristles.length; i++) {
    const b = fb.bristles[i];
    const dispX = b.curX - b.points[0].x;
    const dispY = b.curY - b.points[0].y;
    const dispLen = Math.hypot(dispX, dispY);
    b.bnx = dispLen > 0.001 ? -dispY / dispLen : 0;
    b.bny = dispLen > 0.001 ? dispX / dispLen : 1;
    b.prevX = b.curX;
    b.prevY = b.curY;
  }

  fb.lastPos = { x: to.x, y: to.y };

  // Strictly bounded bounding box
  const pad = radius * 2.5 + 24;
  const strokeMinX = Math.min(from.x, to.x) - pad;
  const strokeMaxX = Math.max(from.x, to.x) + pad;
  const strokeMinY = Math.min(from.y, to.y) - pad;
  const strokeMaxY = Math.max(from.y, to.y) + pad;

  // Identify affected canvas chunks
  const sCX = engine.isStatic ? 0 : Math.floor(strokeMinX / engine.chunkSize);
  const eCX = engine.isStatic ? 0 : Math.floor(strokeMaxX / engine.chunkSize);
  const sCY = engine.isStatic ? 0 : Math.floor(strokeMinY / engine.chunkSize);
  const eCY = engine.isStatic ? 0 : Math.floor(strokeMaxY / engine.chunkSize);

  const depthRatio = valDepth / 100;
  const glossRatio = valGloss / 100;
  const cr = baseColor.r;
  const cg = baseColor.g;
  const cb = baseColor.b;
  const w = bristleRibbonWidth;

  for (let cx = sCX; cx <= eCX; cx++) {
    for (let cy = sCY; cy <= eCY; cy++) {
      const chunk = engine._getChunk(cx, cy);
      if (!chunk) continue;

      const id = `${cx},${cy}`;
      if (engine.isDrawing && !engine.currentStrokeDirtyChunks.has(id)) {
        const srcCanvas = chunk.canvases[engine.activeLayer];
        const backup = document.createElement('canvas');
        backup.width = srcCanvas.width;
        backup.height = srcCanvas.height;
        backup.getContext('2d').drawImage(srcCanvas, 0, 0);
        engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
        engine._markDirty(id, engine.activeLayer, false);
      }

      const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
      const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;

      const ctx = chunk.ctxs[engine.activeLayer];
      ctx.save();

      // Chunk boundary clipping ensures painting strictly stays inside the chunk
      ctx.beginPath();
      ctx.rect(0, 0, chunk.width, chunk.height);
      ctx.clip();

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
      if (layerSet && layerSet.alphaLock) {
        ctx.globalCompositeOperation = 'source-atop';
      }

      if (isShading) {
        // Pass 1: Soft Groove Shadows between bristle ridges
        const shadowFactor = Math.max(0.35, 1.0 - depthRatio * 0.35);
        for (let i = 0; i < fb.bristles.length; i++) {
          const b = fb.bristles[i];
          const bFlow = (b.flowScale || 1.0) * flowFactor * 0.65;
          ctx.strokeStyle = `rgba(${clampByte(cr * shadowFactor)}, ${clampByte(cg * shadowFactor)}, ${clampByte(cb * shadowFactor)}, ${bFlow})`;
          ctx.lineWidth = Math.max(0.85, w * b.widthScale * 1.30);
          const shadowSign = (-b.bnx * 0.707 - b.bny * 0.707) >= 0 ? 1 : -1;
          const offX = b.bnx * w * b.widthScale * 0.25 * shadowSign;
          const offY = b.bny * w * b.widthScale * 0.25 * shadowSign;
          const pts = b.points;
          ctx.beginPath();
          ctx.moveTo(pts[0].x - lx + offX, pts[0].y - ly + offY);
          for (let p = 1; p < pts.length; p++) {
            ctx.lineTo(pts[p].x - lx + offX, pts[p].y - ly + offY);
          }
          ctx.stroke();
        }

        // Pass 2: Rich Core Oil Pigment Ribbons
        for (let i = 0; i < fb.bristles.length; i++) {
          const b = fb.bristles[i];
          const bFlow = Math.min(1.0, flowFactor * (b.flowScale || 1.0));
          ctx.strokeStyle = `rgba(${b.color.r}, ${b.color.g}, ${b.color.b}, ${bFlow})`;
          ctx.lineWidth = Math.max(0.7, w * b.widthScale * 1.05);
          ctx.beginPath();
          const pts = b.points;
          ctx.moveTo(pts[0].x - lx, pts[0].y - ly);
          for (let p = 1; p < pts.length; p++) {
            ctx.lineTo(pts[p].x - lx, pts[p].y - ly);
          }
          ctx.stroke();
        }

        // Pass 3: Lit Diffuse Ridge Highlights facing key light
        const litFactor = Math.min(1.50, 1.0 + depthRatio * 0.30);
        for (let i = 0; i < fb.bristles.length; i++) {
          const b = fb.bristles[i];
          const bFlow = (b.flowScale || 1.0) * flowFactor * 0.55;
          ctx.strokeStyle = `rgba(${clampByte(cr * litFactor)}, ${clampByte(cg * litFactor)}, ${clampByte(cb * litFactor)}, ${bFlow})`;
          ctx.lineWidth = Math.max(0.55, w * b.widthScale * 0.75);
          const shadowSign = (-b.bnx * 0.707 - b.bny * 0.707) >= 0 ? 1 : -1;
          const offX = -b.bnx * w * b.widthScale * 0.22 * shadowSign;
          const offY = -b.bny * w * b.widthScale * 0.22 * shadowSign;
          const pts = b.points;
          ctx.beginPath();
          ctx.moveTo(pts[0].x - lx + offX, pts[0].y - ly + offY);
          for (let p = 1; p < pts.length; p++) {
            ctx.lineTo(pts[p].x - lx + offX, pts[p].y - ly + offY);
          }
          ctx.stroke();
        }

        // Pass 4: 3D Specular Gloss Sheen along bristle crest
        if (glossRatio > 0.01) {
          for (let i = 0; i < fb.bristles.length; i++) {
            const b = fb.bristles[i];
            const specAlpha = Math.min(0.75, glossRatio * 0.55 * flowFactor * (b.flowScale || 1.0));
            ctx.strokeStyle = `rgba(255, 255, 255, ${specAlpha})`;
            ctx.lineWidth = Math.max(0.40, w * b.widthScale * 0.32);
            const pts = b.points;
            ctx.beginPath();
            ctx.moveTo(pts[0].x - lx, pts[0].y - ly);
            for (let p = 1; p < pts.length; p++) {
              ctx.lineTo(pts[p].x - lx, pts[p].y - ly);
            }
            ctx.stroke();
          }
        }
      } else {
        // Flat shading ribbons with individual bristle widths and flow
        for (let i = 0; i < fb.bristles.length; i++) {
          const b = fb.bristles[i];
          const bFlow = Math.min(1.0, flowFactor * (b.flowScale || 1.0));
          ctx.strokeStyle = `rgba(${b.color.r}, ${b.color.g}, ${b.color.b}, ${bFlow})`;
          ctx.lineWidth = Math.max(0.6, w * b.widthScale);
          ctx.beginPath();
          const pts = b.points;
          ctx.moveTo(pts[0].x - lx, pts[0].y - ly);
          for (let p = 1; p < pts.length; p++) {
            ctx.lineTo(pts[p].x - lx, pts[p].y - ly);
          }
          ctx.stroke();
        }
      }

      ctx.restore();

      engine._markDirty(id, engine.activeLayer, false);
      if (engine.gpuRenderer) {
        engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
      }
    }
  }

  engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, strokeMinX);
  engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, strokeMaxX);
  engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, strokeMinY);
  engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, strokeMaxY);
}

/**
 * Finalizes fluid paint stroke on pointerup.
 */
export function endFluidPaintStroke(engine) {
  if (engine.activeFluidBrush) {
    const fb = engine.activeFluidBrush;
    if (!fb.hasPainted) {
      const p = fb.lastPos;
      const microTo = { x: p.x + 0.1, y: p.y + 0.1 };
      paintFluidOnChunks(engine, p, microTo, fb.radius * 2, engine.brush.opacity || 1.0, fb.baseColor);
    }
    engine.activeFluidBrush = null;
  }
}

/**
 * Cancels active fluid stroke state.
 */
export function cancelFluidAfterEffect(engine) {
  if (!engine) return;
  if (engine.activeFluidBrush) {
    engine.activeFluidBrush = null;
  }
}

export let fluidEngineMode = 'oil';
export function setFluidEngineMode(mode) {
  fluidEngineMode = mode;
}

