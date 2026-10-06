import { TOOLS } from '../constants.js';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb } from '../colorUtils.js';

// Initialization, activation, deactivation of Air Paint Panel
export function initAirPaint(app) {
  const panelAir = document.getElementById('panel-air');
  const btnCollapse = document.getElementById('btn-air-collapse');

  // Register panel draggable
  if (app._makeDraggable && panelAir) {
    app._makeDraggable(panelAir, document.getElementById('handle-air'));
  }

  // Event listeners
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
  app._status('AIR BRUSH ACTIVE');
}

export function deactivateAirPaint(app) {
  const panel = document.getElementById('panel-air');
  if (panel) panel.classList.add('hidden');
  app._status('AIR BRUSH DEACTIVATED');
}

// Holds active wind/vortex particles across incremental brush steps
let activeParticles = [];
let time = 0;
let strokePaintLoad = 1.0;

let airOffscreenCanvas = null;
let airOffscreenCtx = null;
let airBackBufferCanvas = null;
let airBackBufferCtx = null;

let bounds = {
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
  width: 0,
  height: 0
};

let minCX = Infinity;
let maxCX = -Infinity;
let minCY = Infinity;
let maxCY = -Infinity;
const loadedChunks = new Set();

function getChunkWorldRect(engine, cx, cy) {
  if (engine.isStatic) {
    return {
      x: -engine.staticWidth / 2,
      y: -engine.staticHeight / 2,
      width: engine.staticWidth,
      height: engine.staticHeight
    };
  } else {
    return {
      x: cx * engine.chunkSize,
      y: cy * engine.chunkSize,
      width: engine.chunkSize,
      height: engine.chunkSize
    };
  }
}

function ensureChunkLoaded(engine, cx, cy) {
  const key = `${cx},${cy}`;
  if (loadedChunks.has(key)) return;

  const chunk = engine._getChunk(cx, cy);
  if (!chunk) {
    loadedChunks.add(key);
    return;
  }

  const rect = getChunkWorldRect(engine, cx, cy);

  if (loadedChunks.size === 0) {
    minCX = cx;
    maxCX = cx;
    minCY = cy;
    maxCY = cy;
    bounds.minX = rect.x;
    bounds.minY = rect.y;
    bounds.maxX = rect.x + rect.width;
    bounds.maxY = rect.y + rect.height;
    bounds.width = rect.width;
    bounds.height = rect.height;

    airOffscreenCanvas = document.createElement('canvas');
    airOffscreenCanvas.width = bounds.width;
    airOffscreenCanvas.height = bounds.height;
    airOffscreenCtx = airOffscreenCanvas.getContext('2d');

    airBackBufferCanvas = document.createElement('canvas');
    airBackBufferCanvas.width = bounds.width;
    airBackBufferCanvas.height = bounds.height;
    airBackBufferCtx = airBackBufferCanvas.getContext('2d');
  }

  const newMinCX = Math.min(minCX, cx);
  const newMaxCX = Math.max(maxCX, cx);
  const newMinCY = Math.min(minCY, cy);
  const newMaxCY = Math.max(maxCY, cy);

  if (newMinCX < minCX || newMaxCX > maxCX || newMinCY < minCY || newMaxCY > maxCY) {
    let newMinX = Infinity;
    let newMinY = Infinity;
    let newMaxX = -Infinity;
    let newMaxY = -Infinity;

    for (let x = newMinCX; x <= newMaxCX; x++) {
      for (let y = newMinCY; y <= newMaxCY; y++) {
        const r = getChunkWorldRect(engine, x, y);
        newMinX = Math.min(newMinX, r.x);
        newMinY = Math.min(newMinY, r.y);
        newMaxX = Math.max(newMaxX, r.x + r.width);
        newMaxY = Math.max(newMaxY, r.y + r.height);
      }
    }

    const newWidth = newMaxX - newMinX;
    const newHeight = newMaxY - newMinY;

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newWidth;
    newCanvas.height = newHeight;
    const newCtx = newCanvas.getContext('2d');

    if (airOffscreenCanvas) {
      const offsetX = bounds.minX - newMinX;
      const offsetY = bounds.minY - newMinY;
      newCtx.drawImage(airOffscreenCanvas, offsetX, offsetY);
    }

    airOffscreenCanvas = newCanvas;
    airOffscreenCtx = newCtx;

    airBackBufferCanvas = document.createElement('canvas');
    airBackBufferCanvas.width = newWidth;
    airBackBufferCanvas.height = newHeight;
    airBackBufferCtx = airBackBufferCanvas.getContext('2d');

    minCX = newMinCX;
    maxCX = newMaxCX;
    minCY = newMinCY;
    maxCY = newMaxCY;
    bounds.minX = newMinX;
    bounds.minY = newMinY;
    bounds.maxX = newMaxX;
    bounds.maxY = newMaxY;
    bounds.width = newWidth;
    bounds.height = newHeight;
  }

  const chunkCanvas = chunk.canvases[engine.activeLayer];
  const destX = rect.x - bounds.minX;
  const destY = rect.y - bounds.minY;
  airOffscreenCtx.drawImage(chunkCanvas, destX, destY);
  loadedChunks.add(key);

  if (!engine.currentStrokeDirtyChunks.has(key)) {
    const backup = document.createElement('canvas');
    backup.width = chunkCanvas.width;
    backup.height = chunkCanvas.height;
    backup.getContext('2d').drawImage(chunkCanvas, 0, 0);
    engine.currentStrokeDirtyChunks.set(key, { layer: engine.activeLayer, canvas: backup });
    engine._markDirty(key, engine.activeLayer);
  }
}

function syncOffscreenToChunks(engine, activeBox = null) {
  if (!airOffscreenCanvas) return;
  loadedChunks.forEach(key => {
    const parts = key.split(',');
    const cx = parseInt(parts[0]);
    const cy = parseInt(parts[1]);
    const chunk = engine._getChunk(cx, cy);
    if (!chunk) return;

    const r = getChunkWorldRect(engine, cx, cy);

    // Fast bounding box culling: when zoomed out, only sync and re-upload chunks actively modified in this step!
    if (activeBox) {
      if (
        r.x + r.width < activeBox.minX ||
        r.x > activeBox.maxX ||
        r.y + r.height < activeBox.minY ||
        r.y > activeBox.maxY
      ) {
        return;
      }
    }

    const activeCtx = chunk.ctxs[engine.activeLayer];
    activeCtx.clearRect(0, 0, chunk.width, chunk.height);
    activeCtx.drawImage(
      airOffscreenCanvas,
      r.x - bounds.minX,
      r.y - bounds.minY,
      chunk.width,
      chunk.height,
      0,
      0,
      chunk.width,
      chunk.height
    );
    engine._markDirty(key, engine.activeLayer, false);
    if (engine.gpuRenderer) {
      engine.gpuRenderer.markChunkLayerDirty(chunk, engine.activeLayer);
    }
  });
}

export function startAirPaintStroke(engine) {
  strokePaintLoad = 1.0;
  minCX = Infinity;
  maxCX = -Infinity;
  minCY = Infinity;
  maxCY = -Infinity;
  loadedChunks.clear();

  // Only load the initial chunk where the stroke begins, never the entire zoomed-out viewport!
  const startP = (engine.strokePoints && engine.strokePoints.length > 0) ? engine.strokePoints[0] : null;
  if (startP) {
    const cx = engine.isStatic ? 0 : Math.floor(startP.x / engine.chunkSize);
    const cy = engine.isStatic ? 0 : Math.floor(startP.y / engine.chunkSize);
    ensureChunkLoaded(engine, cx, cy);
  }
}

export function endAirPaintStroke(engine) {
  syncOffscreenToChunks(engine);
  airOffscreenCtx = null;
  airBackBufferCtx = null;
  airOffscreenCanvas = null;
  airBackBufferCanvas = null;
  loadedChunks.clear();
  minCX = Infinity;
  maxCX = -Infinity;
  minCY = Infinity;
  maxCY = -Infinity;
  engine.refresh();
}

export function paintAirIncrementally(engine, j) {
  if (!engine.isDrawing) return;
  const points = engine.strokePoints;
  if (j < 1 || j >= points.length) return;

  const p0 = points[j - 1];
  const p1 = points[j];

  // If bounds or canvas are not set up yet, let's make sure they are
  if (!airOffscreenCanvas || bounds.width <= 0) {
    startAirPaintStroke(engine);
  }

  const cx0 = engine.isStatic ? 0 : Math.floor(p0.x / engine.chunkSize);
  const cy0 = engine.isStatic ? 0 : Math.floor(p0.y / engine.chunkSize);
  ensureChunkLoaded(engine, cx0, cy0);

  const cx1 = engine.isStatic ? 0 : Math.floor(p1.x / engine.chunkSize);
  const cy1 = engine.isStatic ? 0 : Math.floor(p1.y / engine.chunkSize);
  ensureChunkLoaded(engine, cx1, cy1);

  // Access user-selected settings
  const size = p1.size || engine.brush.size || 60;
  const opacity = p1.opacity || engine.brush.opacity || 0.40;
  const color = p1.color || '#000000';

  const airTurb = engine.brush.airTurb ?? 40;     // Swirl turbulence power
  const airScale = engine.brush.airScale ?? 15;   // Swirl scale/resolution frequency
  const airDensity = engine.brush.airDensity ?? 12; // Particle flow density
  const airDrift = engine.brush.airDrift ?? 30;   // Wind drift/inertia force
  const airFalloff = engine.brush.airFalloff ?? 30; // Paint falloff rate
  const airDryFriction = engine.brush.airDryFriction ?? 40; // Dry brush friction/turbulence boost

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;

  // Track paint depletion
  const flowSetting = engine.brush.flow ?? 0.50; // default 50%
  const flowFactor = Math.max(0.01, flowSetting); // Avoid divide by zero
  // Depletion rate per pixel drawn
  const depletionRate = (airFalloff / 1500.0) / flowFactor;
  strokePaintLoad = Math.max(0.0, strokePaintLoad - dist * depletionRate);

  const baseRgb = hexToRgb(color);
  const baseHsl = rgbToHsl(baseRgb.r, baseRgb.g, baseRgb.b);

  // Fewer, high-quality wind-ribbons spawned, but lingering much longer to avoid visual clutter
  // Scale spawns by the current paint load, and clamp world dist to avoid explosive spawn bursts when zoomed out
  const clampedDist = Math.min(dist, 40.0);
  const count = strokePaintLoad <= 0.001 ? 0 : Math.max(1, Math.min(3, Math.round((airDensity * 0.08) * (clampedDist / 8.0 + 1.0) * Math.sqrt(strokePaintLoad))));

  for (let i = 0; i < count; i++) {
    const ratio = i / count;
    const cx = p0.x + dx * ratio;
    const cy = p0.y + dy * ratio;

    // Disperse particles snugly around the path center
    const angle = Math.random() * Math.PI * 2;
    const maxRadius = size * (0.05 + Math.random() * 0.35);
    const px = cx + Math.cos(angle) * maxRadius;
    const py = cy + Math.sin(angle) * maxRadius;

    // Load chunk containing the newly spawned particle
    const pcx = engine.isStatic ? 0 : Math.floor(px / engine.chunkSize);
    const pcy = engine.isStatic ? 0 : Math.floor(py / engine.chunkSize);
    ensureChunkLoaded(engine, pcx, pcy);

    // Jitter color of this specific wind stream to create a gorgeous multi-tone fluid-paint look
    const hueShift = (Math.random() - 0.5) * 35; 
    const satShift = (Math.random() - 0.5) * 15;
    const lightShift = (Math.random() - 0.5) * 10;

    const streamHsl = {
      h: (baseHsl.h + hueShift + 360) % 360,
      s: Math.max(10, Math.min(100, baseHsl.s + satShift)),
      l: Math.max(10, Math.min(90, baseHsl.l + lightShift))
    };

    const streamRgb = hslToRgb(streamHsl.h, streamHsl.s, streamHsl.l);
    const streamColorStr = rgbToHex(streamRgb.r, streamRgb.g, streamRgb.b);

    const glossRgb = hslToRgb(streamHsl.h, Math.max(0, streamHsl.s - 25), Math.min(100, streamHsl.l + 25));
    const glossColorStr = rgbToHex(glossRgb.r, glossRgb.g, glossRgb.b);

    activeParticles.push({
      x: px,
      y: py,
      centerX: cx,
      centerY: cy,
      vx: (Math.random() - 0.5) * 0.4 + (dist > 0.05 ? (dx / dist) * (1.5 + Math.min(4.0, dist * 0.5)) : 0),
      vy: (Math.random() - 0.5) * 0.4 + (dist > 0.05 ? (dy / dist) * (1.5 + Math.min(4.0, dist * 0.5)) : 0),
      driftX: dist > 0.05 ? dx / dist : 0,
      driftY: dist > 0.05 ? dy / dist : 0,
      life: 1.0,
      decay: 0.0022 + Math.random() * 0.0033, 
      color: streamColorStr,
      glossColor: glossColorStr,
      opacity: opacity * (0.35 + Math.random() * 0.35),
      seed: Math.random(),
      orbitSpeed: (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.8),
      paintLoad: strokePaintLoad
    });
  }

  // Keep a clean, fast particle ceiling (250 particles looks dense and beautiful with zero lag)
  if (activeParticles.length > 250) {
    activeParticles = activeParticles.slice(activeParticles.length - 250);
  }

  time += 0.04;

  const currentCx = p1.x;
  const currentCy = p1.y;

  // Simulate existing active particles in a gorgeous, continuous chaotic fluidic flow field
  for (let i = 0; i < activeParticles.length; i++) {
    const p = activeParticles[i];

    p.centerX = p.centerX * 0.95 + currentCx * 0.05;
    p.centerY = p.centerY * 0.95 + currentCy * 0.05;

    const rx = p.x - p.centerX;
    const ry = p.y - p.centerY;
    const currentDist = Math.sqrt(rx * rx + ry * ry) || 0.01;

    const scale = 1.0 / Math.max(4.0, airScale * 1.8);
    const fX = p.x * scale;
    const fY = p.y * scale;
    
    const turbX = Math.sin(fY * 1.2 + time * 1.6) * Math.cos(fX * 0.6) + Math.cos(fY * 0.3 - time * 0.8);
    const turbY = Math.cos(fX * 1.2 - time * 1.6) * Math.sin(fY * 0.6) + Math.sin(fX * 0.3 + time * 0.8);

    const turbForce = (airTurb / 100.0) * 1.6;
    const noiseX = turbX * turbForce;
    const noiseY = turbY * turbForce;

    const rotX = -ry / currentDist;
    const rotY = rx / currentDist;
    const rotForce = turbForce * 1.2 * p.orbitSpeed;

    const blowForce = 0.35 * (airTurb / 100.0) * Math.max(0.05, 1.0 - currentDist / (size * 2.5));
    const blowX = (rx / currentDist) * blowForce;
    const blowY = (ry / currentDist) * blowForce;

    const windForce = (airDrift / 100.0) * 1.6;
    const windX = p.driftX * windForce;
    const windY = p.driftY * windForce;

    // Direct cursor nozzle drag blow force (moves paint in current hand drag direction)
    const distToCursor = Math.sqrt((p.x - currentCx) * (p.x - currentCx) + (p.y - currentCy) * (p.y - currentCy)) || 0.01;
    const proximityFactor = Math.max(0.0, 1.0 - distToCursor / (size * 2.5));
    const cursorBlowX = (dist > 0.05) ? (dx / dist) * Math.min(8.0, dist * 1.5) * proximityFactor : 0;
    const cursorBlowY = (dist > 0.05) ? (dy / dist) * Math.min(8.0, dist * 1.5) * proximityFactor : 0;

    p.vx = p.vx * 0.93 + (windX + noiseX + blowX + rotX * rotForce + cursorBlowX * 0.8) * 0.07 + (Math.random() - 0.5) * 0.06;
    p.vy = p.vy * 0.93 + (windY + noiseY + blowY + rotY * rotForce + cursorBlowY * 0.8) * 0.07 + (Math.random() - 0.5) * 0.06;

    // Dry brush sputter / friction
    const pLoad = p.paintLoad !== undefined ? p.paintLoad : 1.0;
    const dryFactor = 1.0 - pLoad;
    if (dryFactor > 0.05 && airDryFriction > 0) {
      const sputterPower = (airDryFriction / 100.0) * dryFactor * 2.5;
      p.vx += (Math.random() - 0.5) * sputterPower;
      p.vy += (Math.random() - 0.5) * sputterPower;
    }

    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0.01;
    const maxSpeed = 8.0;
    if (speed > maxSpeed) {
      p.vx = (p.vx / speed) * maxSpeed;
      p.vy = (p.vy / speed) * maxSpeed;
    }

    p.oldX = p.x;
    p.oldY = p.y;
    p.x += p.vx;
    p.y += p.vy;

    const pcx = engine.isStatic ? 0 : Math.floor(p.x / engine.chunkSize);
    const pcy = engine.isStatic ? 0 : Math.floor(p.y / engine.chunkSize);
    ensureChunkLoaded(engine, pcx, pcy);

    p.life -= p.decay;

    if (p.life > 0) {
      const lifeSin = Math.sin(p.life * Math.PI);
      const pLoad = p.paintLoad !== undefined ? p.paintLoad : 1.0;
      p.width = Math.max(0.6, size * 0.08 * lifeSin * Math.sqrt(pLoad));
      p.finalOpacity = p.opacity * lifeSin * pLoad;
      p.glossOpacity = p.finalOpacity * 0.65;
    }
  }

  // --- 1. RENDER AERODYNAMIC WIND RIBBONS & FLUID FILAMENTS ---
  airOffscreenCtx.save();
  airOffscreenCtx.lineCap = 'round';
  airOffscreenCtx.lineJoin = 'round';

  for (let i = 0; i < activeParticles.length; i++) {
    const p = activeParticles[i];
    if (p.life <= 0 || p.oldX === undefined) continue;

    const x0 = p.oldX - bounds.minX;
    const y0 = p.oldY - bounds.minY;
    const x1 = p.x - bounds.minX;
    const y1 = p.y - bounds.minY;

    // Draw primary filament stroke
    airOffscreenCtx.beginPath();
    airOffscreenCtx.moveTo(x0, y0);
    airOffscreenCtx.lineTo(x1, y1);
    airOffscreenCtx.strokeStyle = p.color;
    airOffscreenCtx.lineWidth = Math.max(1.0, p.width);
    airOffscreenCtx.globalAlpha = Math.max(0.01, Math.min(1.0, p.finalOpacity));
    airOffscreenCtx.stroke();

    // Draw subtle aerodynamic gloss highlight
    if (p.glossOpacity > 0.05 && p.width > 2.0) {
      airOffscreenCtx.beginPath();
      airOffscreenCtx.moveTo(x0 - p.vy * 0.15, y0 + p.vx * 0.15);
      airOffscreenCtx.lineTo(x1 - p.vy * 0.15, y1 + p.vx * 0.15);
      airOffscreenCtx.strokeStyle = p.glossColor;
      airOffscreenCtx.lineWidth = Math.max(0.6, p.width * 0.4);
      airOffscreenCtx.globalAlpha = Math.max(0.01, Math.min(1.0, p.glossOpacity));
      airOffscreenCtx.stroke();
    }
  }
  airOffscreenCtx.restore();

  // --- 2. LOCALIZED AERODYNAMIC NOZZLE JET ADVECTION ---
  // Apply a smooth, single atmospheric nozzle push around the active drag cursor (capped to prevent gigantic canvas copies on large sizes)
  const jetRadius = Math.max(20, Math.min(160, size * 1.4));
  const curX = p1.x - bounds.minX;
  const curY = p1.y - bounds.minY;
  const jetMinX = Math.max(0, Math.floor(curX - jetRadius));
  const jetMinY = Math.max(0, Math.floor(curY - jetRadius));
  const jetW = Math.min(bounds.width - jetMinX, Math.ceil(jetRadius * 2));
  const jetH = Math.min(bounds.height - jetMinY, Math.ceil(jetRadius * 2));

  if (jetW > 4 && jetH > 4 && dist > 0.2) {
    const blowShiftX = (dx / dist) * Math.min(6.0, dist * 0.8) * (airDrift / 100.0);
    const blowShiftY = (dy / dist) * Math.min(6.0, dist * 0.8) * (airDrift / 100.0);
    const advectAlpha = Math.max(0.05, Math.min(0.35, 0.12 + (airTurb / 100.0) * 0.15));

    airBackBufferCtx.clearRect(jetMinX, jetMinY, jetW, jetH);
    airBackBufferCtx.drawImage(
      airOffscreenCanvas,
      jetMinX, jetMinY, jetW, jetH,
      jetMinX, jetMinY, jetW, jetH
    );

    airOffscreenCtx.save();
    airOffscreenCtx.beginPath();
    airOffscreenCtx.arc(curX, curY, jetRadius * 0.85, 0, Math.PI * 2);
    airOffscreenCtx.clip();
    airOffscreenCtx.globalAlpha = advectAlpha;
    airOffscreenCtx.drawImage(
      airBackBufferCanvas,
      jetMinX, jetMinY, jetW, jetH,
      jetMinX + blowShiftX, jetMinY + blowShiftY, jetW, jetH
    );
    airOffscreenCtx.restore();
  }

  // Sync back only the active area to overlapping chunk canvases in real-time
  const activePad = Math.max(jetRadius + 32, size * 0.5);
  const activeBox = {
    minX: p1.x - activePad,
    maxX: p1.x + activePad,
    minY: p1.y - activePad,
    maxY: p1.y + activePad
  };
  syncOffscreenToChunks(engine, activeBox);

  // Filter out expired particles
  activeParticles = activeParticles.filter(p => p.life > 0);
}

export function clearAirParticles() {
  activeParticles = [];
  airOffscreenCtx = null;
  airBackBufferCtx = null;
  airOffscreenCanvas = null;
  airBackBufferCanvas = null;
}
