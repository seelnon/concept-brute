import { TOOLS } from '../constants.js';

/**
 * David Li Style Viscous Fluid Oil Paint Engine
 * Simulates physical multi-bristle spring dynamics, continuous impasto ribbons,
 * wet paint pickup/color blending, fluid vortex swirl, and 3D specular surface relief.
 */

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
    if (saved !== null) sliderFluidity.value = saved;
    if (valFluidity) valFluidity.innerText = `${sliderFluidity.value}%`;
    sliderFluidity.oninput = () => {
      const v = parseFloat(sliderFluidity.value);
      if (valFluidity) valFluidity.innerText = `${v}%`;
      localStorage.setItem('fluid_setting_slider-fluidity', sliderFluidity.value);
    };
  }

  // Top-bar bristles slider
  if (sliderBristles) {
    const saved = localStorage.getItem('fluid_setting_slider-bristles');
    if (saved !== null) sliderBristles.value = saved;
    if (valBristles) valBristles.innerText = sliderBristles.value;
    sliderBristles.oninput = () => {
      const v = parseInt(sliderBristles.value, 10);
      if (valBristles) valBristles.innerText = v;
      localStorage.setItem('fluid_setting_slider-bristles', sliderBristles.value);
    };
  }

  // Bind tuning sliders with localStorage
  const setupSlider = (sliderId, valId, defaultVal) => {
    const slider = document.getElementById(sliderId);
    const val = document.getElementById(valId);
    if (slider) {
      const saved = localStorage.getItem('fluid_setting_' + sliderId);
      if (saved !== null) {
        slider.value = saved;
      } else {
        slider.value = defaultVal;
      }
      if (val) val.innerText = `${slider.value}%`;

      slider.oninput = () => {
        if (val) val.innerText = `${slider.value}%`;
        localStorage.setItem('fluid_setting_' + sliderId, slider.value);
      };
    }
  };

  setupSlider('slider-fluid-flow', 'val-fluid-flow', 100);
  setupSlider('slider-fluid-vortex', 'val-fluid-vortex', 45);
  setupSlider('slider-fluid-turb', 'val-fluid-turb', 30);
  setupSlider('slider-fluid-retention', 'val-fluid-retention', 20);
  setupSlider('slider-fluid-pickup', 'val-fluid-pickup', 65);
  setupSlider('slider-fluid-depth', 'val-fluid-depth', 75);
  setupSlider('slider-fluid-gloss', 'val-fluid-gloss', 35);

  const chkShading = document.getElementById('chk-surface-shading');
  if (chkShading) {
    const savedShading = localStorage.getItem('fluid_setting_chk-surface-shading');
    if (savedShading !== null) {
      chkShading.checked = savedShading === 'true';
    }
    chkShading.onchange = () => {
      localStorage.setItem('fluid_setting_chk-surface-shading', chkShading.checked);
    };
  }
}

export function activateFluidPaint(app) {
  const panel = document.getElementById('panel-fluid');
  if (panel) panel.classList.remove('hidden');

  const ctrlFluidity = document.getElementById('control-fluidity');
  if (ctrlFluidity) ctrlFluidity.style.display = 'flex';

  const ctrlBristles = document.getElementById('control-bristles');
  if (ctrlBristles) ctrlBristles.style.display = 'flex';

  const canvas = document.getElementById('fluid-canvas');
  if (canvas) canvas.classList.add('hidden');

  app._status('FLUID VISCOUS OIL PAINT ACTIVE');
}

export function deactivateFluidPaint(app) {
  const panel = document.getElementById('panel-fluid');
  if (panel) panel.classList.add('hidden');

  const ctrlFluidity = document.getElementById('control-fluidity');
  if (ctrlFluidity) ctrlFluidity.style.display = 'none';

  const ctrlBristles = document.getElementById('control-bristles');
  if (ctrlBristles) ctrlBristles.style.display = 'none';

  if (app.engine) {
    app.engine.activeFluidBrush = null;
  }

  app._status('FLUID PAINT DEACTIVATED');
}

// ----------------------------------------------------
// COLOR & PARAMETER HELPERS
// ----------------------------------------------------
function parseColor(c) {
  if (!c) return { r: 230, g: 30, b: 30 };
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
  return { r: 230, g: 30, b: 30 };
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function getSliderVal(id, def) {
  const el = document.getElementById(id);
  return el ? parseFloat(el.value) : def;
}

// ----------------------------------------------------
// BRISTLE TUFT MODEL
// ----------------------------------------------------
function initBristles(centerX, centerY, radius, count, baseColor, strokeAngle) {
  const bristles = [];
  const cosA = Math.cos(strokeAngle);
  const sinA = Math.sin(strokeAngle);
  const nx = -sinA;
  const ny = cosA;
  const tx = cosA;
  const ty = sinA;

  for (let i = 0; i < count; i++) {
    // Cosine profile across brush width gives denser core with tapered feathering at the edges
    const t = count > 1 ? i / (count - 1) : 0.5;
    const u = -Math.cos(t * Math.PI); 
    const v = (Math.random() - 0.5) * 0.30;

    const offsetX = (nx * u + tx * v) * radius;
    const offsetY = (ny * u + ty * v) * radius;

    const tipX = centerX + offsetX;
    const tipY = centerY + offsetY;

    bristles.push({
      u,
      v,
      curX: tipX,
      curY: tipY,
      prevX: tipX,
      prevY: tipY,
      velX: 0,
      velY: 0,
      stiffness: 0.50 + Math.random() * 0.20,
      drag: 0.72 + Math.random() * 0.10,
      color: { ...baseColor },
      widthScale: 0.8 + Math.random() * 0.4
    });
  }
  return bristles;
}

/**
 * Pre-warms the fluid paint stroke on pointerdown.
 * Initializes the physical bristle tuft and deposits a thick, luscious 3D oil paint dab.
 */
export function startFluidPaintStroke(engine, worldPos) {
  const rawSize = worldPos.size || engine.brush.size || 35;
  const radius = Math.max(2.0, rawSize * 0.5);
  const baseColor = parseColor(worldPos.color || engine.brush.color);

  const bristleSlider = document.getElementById('slider-bristles');
  const userCount = bristleSlider ? parseInt(bristleSlider.value, 10) : 40;
  // Scale bristle count with brush size
  const count = Math.max(16, Math.min(80, Math.round(userCount * (radius < 15 ? 0.6 : radius > 80 ? 1.4 : 1.0))));

  const bristles = initBristles(worldPos.x, worldPos.y, radius, count, baseColor, 0);

  engine.activeFluidBrush = {
    bristles,
    lastPos: { x: worldPos.x, y: worldPos.y },
    lastAngle: 0,
    radius,
    baseColor,
    stepCount: 0
  };

  // Deposit initial oil paint dab at pointerdown
  const microTo = { x: worldPos.x + 0.1, y: worldPos.y + 0.1 };
  paintFluidOnChunks(engine, worldPos, microTo, rawSize, worldPos.opacity || engine.brush.opacity || 1.0, worldPos.color || engine.brush.color);
}

/**
 * Continuous Fluid Paint Stroke Handler.
 * Simulates physical bristle dynamics, fluid vortex curls, wet paint pickup,
 * and 3D specular impasto surface lighting. Guaranteed ZERO dots or gaps at any speed!
 */
export function paintFluidOnChunks(engine, from, to, size, opacity, color, pressure = 1.0) {
  if (!engine.activeFluidBrush) {
    startFluidPaintStroke(engine, from);
  }

  const fb = engine.activeFluidBrush;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  const radius = Math.max(2.0, (size || engine.brush.size || 35) * 0.5);
  fb.radius = radius;
  const baseColor = parseColor(color || engine.brush.color);
  fb.baseColor = baseColor;

  // Read tuning parameters
  const valFlow = getSliderVal('slider-fluid-flow', 100);
  const valVortex = getSliderVal('slider-fluid-vortex', 45);
  const valTurb = getSliderVal('slider-fluid-turb', 30);
  const valRetention = getSliderVal('slider-fluid-retention', 20);
  const valPickup = getSliderVal('slider-fluid-pickup', 65);
  const valDepth = getSliderVal('slider-fluid-depth', 75);
  const valGloss = getSliderVal('slider-fluid-gloss', 35);
  const valFluidity = getSliderVal('slider-fluidity', 80);

  const chkShading = document.getElementById('chk-surface-shading');
  const isShading = chkShading ? chkShading.checked : true;

  // Sub-step spacing: fine step guarantees unbroken, creamy, continuous ribbons
  const stepDist = Math.max(1.5, Math.min(4.0, radius * 0.08));
  const numSteps = Math.max(1, Math.ceil(dist / stepDist));

  const strokeAngle = dist > 0.001 ? Math.atan2(dy, dx) : fb.lastAngle;
  fb.lastAngle = strokeAngle;

  const cosA = Math.cos(strokeAngle);
  const sinA = Math.sin(strokeAngle);
  const nx = -sinA;
  const ny = cosA;
  const tx = cosA;
  const ty = sinA;

  const flowFactor = (valFlow / 100) * (opacity || 1.0);
  const vortexForce = (valVortex / 100) * 0.35;
  const turbForce = (valTurb / 100) * 0.30;
  const fluidityDamping = 0.65 + (valFluidity / 100) * 0.15;
  const pickupRate = (valPickup / 100) * (1.0 - (valRetention / 100) * 0.85) * 0.12;

  // Base ribbon width per bristle
  const bristleRibbonWidth = Math.max(1.8, (radius * 2.2 / fb.bristles.length) * 1.5);

  // Stroke bounding box tracking
  let strokeMinX = Infinity, strokeMinY = Infinity;
  let strokeMaxX = -Infinity, strokeMaxY = -Infinity;

  // Collect line segments to render per sub-step
  const segments = [];

  for (let s = 1; s <= numSteps; s++) {
    const t = s / numSteps;
    const centerX = from.x + dx * t;
    const centerY = from.y + dy * t;
    fb.stepCount++;

    for (let i = 0; i < fb.bristles.length; i++) {
      const b = fb.bristles[i];

      // Anchor position on brush ferrule
      let targetX = centerX + (nx * b.u + tx * b.v) * radius;
      let targetY = centerY + (ny * b.u + ty * b.v) * radius;

      // Fluid vortex swirl force
      if (vortexForce > 0) {
        const swirl = b.u * vortexForce * radius;
        targetX += -ny * swirl;
        targetY += nx * swirl;
      }

      // Fluid turbulence chaos
      if (turbForce > 0) {
        const chaos = turbForce * radius * 0.4;
        targetX += Math.sin(centerY * 0.06 + b.u * 3.5) * chaos;
        targetY += Math.cos(centerX * 0.06 + b.u * 3.5) * chaos;
      }

      // Damped spring physics update for bristle tip follow
      b.velX = (b.velX + (targetX - b.curX) * b.stiffness) * (b.drag * fluidityDamping);
      b.velY = (b.velY + (targetY - b.curY) * b.stiffness) * (b.drag * fluidityDamping);
      b.curX += b.velX;
      b.curY += b.velY;

      const segMinX = Math.min(b.prevX, b.curX) - bristleRibbonWidth * 2;
      const segMaxX = Math.max(b.prevX, b.curX) + bristleRibbonWidth * 2;
      const segMinY = Math.min(b.prevY, b.curY) - bristleRibbonWidth * 2;
      const segMaxY = Math.max(b.prevY, b.curY) + bristleRibbonWidth * 2;

      strokeMinX = Math.min(strokeMinX, segMinX);
      strokeMaxX = Math.max(strokeMaxX, segMaxX);
      strokeMinY = Math.min(strokeMinY, segMinY);
      strokeMaxY = Math.max(strokeMaxY, segMaxY);

      segments.push({
        x0: b.prevX,
        y0: b.prevY,
        x1: b.curX,
        y1: b.curY,
        color: { ...b.color },
        width: bristleRibbonWidth * b.widthScale,
        bristleIdx: i
      });

      b.prevX = b.curX;
      b.prevY = b.curY;
    }
  }

  fb.lastPos = { x: to.x, y: to.y };

  if (segments.length === 0 || !Number.isFinite(strokeMinX)) return;

  // Identify all affected canvas chunks
  const sCX = engine.isStatic ? 0 : Math.floor(strokeMinX / engine.chunkSize);
  const eCX = engine.isStatic ? 0 : Math.floor(strokeMaxX / engine.chunkSize);
  const sCY = engine.isStatic ? 0 : Math.floor(strokeMinY / engine.chunkSize);
  const eCY = engine.isStatic ? 0 : Math.floor(strokeMaxY / engine.chunkSize);

  // Sample wet paint pickup from canvas once per movement
  if (pickupRate > 0.001) {
    const midX = (from.x + to.x) * 0.5;
    const midY = (from.y + to.y) * 0.5;
    const sampleCX = engine.isStatic ? 0 : Math.floor(midX / engine.chunkSize);
    const sampleCY = engine.isStatic ? 0 : Math.floor(midY / engine.chunkSize);
    const sampleChunk = engine._getChunk(sampleCX, sampleCY);

    if (sampleChunk && sampleChunk.ctxs[engine.activeLayer]) {
      const lx = engine.isStatic ? -engine.staticWidth / 2 : sampleCX * engine.chunkSize;
      const ly = engine.isStatic ? -engine.staticHeight / 2 : sampleCY * engine.chunkSize;
      const sCtx = sampleChunk.ctxs[engine.activeLayer];

      for (let i = 0; i < fb.bristles.length; i += 2) {
        const b = fb.bristles[i];
        const px = Math.floor(b.curX - lx);
        const py = Math.floor(b.curY - ly);
        if (px >= 0 && px < sampleChunk.width && py >= 0 && py < sampleChunk.height) {
          try {
            const pData = sCtx.getImageData(px, py, 1, 1).data;
            if (pData[3] > 20) {
              b.color.r = Math.round(b.color.r * (1 - pickupRate) + pData[0] * pickupRate);
              b.color.g = Math.round(b.color.g * (1 - pickupRate) + pData[1] * pickupRate);
              b.color.b = Math.round(b.color.b * (1 - pickupRate) + pData[2] * pickupRate);
            }
          } catch (e) {}
        }
      }
    }
  }

  // Render continuous bristle ribbons across affected chunks
  for (let cx = sCX; cx <= eCX; cx++) {
    for (let cy = sCY; cy <= eCY; cy++) {
      const chunk = engine._getChunk(cx, cy);
      if (!chunk) continue;

      const id = `${cx},${cy}`;
      // Save chunk state for immediate undo
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
      const cW = chunk.width;
      const cH = chunk.height;

      const ctx = chunk.ctxs[engine.activeLayer];
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
      if (layerSet && layerSet.alphaLock) {
        ctx.globalCompositeOperation = 'source-atop';
      }

      const depthRatio = valDepth / 100;
      const glossRatio = valGloss / 100;

      for (let j = 0; j < segments.length; j++) {
        const seg = segments[j];
        const x0 = seg.x0 - lx;
        const y0 = seg.y0 - ly;
        const x1 = seg.x1 - lx;
        const y1 = seg.y1 - ly;

        // Skip if segment is completely outside chunk boundary
        const pad = seg.width * 2;
        if (Math.max(x0, x1) < -pad || Math.min(x0, x1) > cW + pad ||
            Math.max(y0, y1) < -pad || Math.min(y0, y1) > cH + pad) {
          continue;
        }

        const segDx = x1 - x0;
        const segDy = y1 - y0;
        const segLen = Math.hypot(segDx, segDy);
        const snx = segLen > 0.001 ? -segDy / segLen : 0;
        const sny = segLen > 0.001 ? segDx / segLen : 1;

        const cr = seg.color.r;
        const cg = seg.color.g;
        const cb = seg.color.b;
        const w = seg.width;

        if (isShading) {
          // 3D Impasto Surface Relief:
          // Directional key light from upper-left produces shadows in bristle grooves
          // and bright glistening specular highlights along ridge crests.

          // 1. Soft Shadow on groove edge facing away from light
          const shadowFactor = Math.max(0.40, 1.0 - depthRatio * 0.32);
          const shadowR = clampByte(cr * shadowFactor);
          const shadowG = clampByte(cg * shadowFactor);
          const shadowB = clampByte(cb * shadowFactor);
          const shadowOffset = w * 0.22;

          ctx.strokeStyle = `rgba(${shadowR}, ${shadowG}, ${shadowB}, ${flowFactor * 0.65})`;
          ctx.lineWidth = w * 1.15;
          ctx.beginPath();
          ctx.moveTo(x0 + snx * shadowOffset, y0 + sny * shadowOffset);
          ctx.lineTo(x1 + snx * shadowOffset, y1 + sny * shadowOffset);
          ctx.stroke();

          // 2. Rich Pigment Core
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${flowFactor})`;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();

          // 3. Lit Diffuse Edge facing key light
          const litFactor = Math.min(1.45, 1.0 + depthRatio * 0.28);
          const litR = clampByte(cr * litFactor);
          const litG = clampByte(cg * litFactor);
          const litB = clampByte(cb * litFactor);
          const litOffset = -w * 0.20;

          ctx.strokeStyle = `rgba(${litR}, ${litG}, ${litB}, ${flowFactor * 0.55})`;
          ctx.lineWidth = w * 0.70;
          ctx.beginPath();
          ctx.moveTo(x0 + snx * litOffset, y0 + sny * litOffset);
          ctx.lineTo(x1 + snx * litOffset, y1 + sny * litOffset);
          ctx.stroke();

          // 4. Wet 3D Blinn-Phong Specular Gloss along bristle ridge crest
          if (glossRatio > 0.01) {
            const specAlpha = Math.min(0.70, glossRatio * 0.50 * flowFactor);
            ctx.strokeStyle = `rgba(255, 255, 255, ${specAlpha})`;
            ctx.lineWidth = Math.max(0.75, w * 0.28);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
          }
        } else {
          // Flat solid paint ribbons without directional lighting
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${flowFactor})`;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      ctx.restore();

      // Mark chunk and GPU layer dirty
      engine._markDirty(id, engine.activeLayer, false);
      if (engine.gpuRenderer) {
        engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
      }
    }
  }

  // Update stroke bounding box in engine
  engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, strokeMinX);
  engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, strokeMaxX);
  engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, strokeMinY);
  engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, strokeMaxY);

  engine.refresh();
}

/**
 * Finalizes fluid paint stroke on pointerup.
 */
export function endFluidPaintStroke(engine) {
  if (engine.activeFluidBrush) {
    engine.activeFluidBrush = null;
  }
}

