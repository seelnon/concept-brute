import { TOOLS, LAYERS_COUNT } from '../constants.js';
import { _paintOnChunks } from '../engine/stroke.js';
import {
  startWireframeStroke,
  paintWireframeMove,
  endWireframeStroke,
  cancelWireframeStroke
} from './wireframe.js';
import { normalizeSelectionPath, drawSelectionMask } from './selection.js';
import {
  warmSmudgeSolver,
  startSmudgeStroke,
  paintSmudgeOnChunks,
  endSmudgeStroke,
  cancelSmudgeStroke
} from './smudge.js';
import {
  warmLiquifySolver,
  startLiquifyStroke,
  paintLiquifyStroke,
  endLiquifyStroke,
  cancelLiquifyStroke,
  flushLiquifyGpuCommits,
  invalidateLiquifySession
} from './liquify.js';
import {
  fluidSettings,
  warmFluidSolver,
  startFluidPaintStroke,
  paintFluidOnChunks,
  endFluidPaintStroke,
  cancelFluidAfterEffect
} from './fluidPaint.js';
import {
  airSettings,
  warmAirSolver,
  startAirPaintStroke,
  paintAirIncrementally,
  endAirPaintStroke,
  clearAirParticles,
  clearAirWetCacheForProject
} from './airPaint.js';
import {
  sumiSettings,
  syncSumiTip,
  reDipSumi,
  warmSumiSolver,
  startSumiPaintStroke,
  paintSumiMove,
  endSumiPaintStroke,
  stopSumiSimulation,
  cancelSumiStroke,
  clearSumiPassiveArchive
} from './sumiPaint.js';
import {
  warmEraserSolver,
  startEraserStroke,
  endEraserStroke,
  cancelEraserStroke
} from './eraser.js';
import { wasmCore } from '../wasm/wasmBridge.js';

const SCRATCH_SIZE = 512;
const VIEW_W = 512;
const VIEW_H = 256;
const PREWARM_PROJECT_ID = '__prewarm__';

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates a coarse multi-strand bristle tip canvas for Fluid Paint prewarm
 * so texture ridges & 3D impasto shading read crisply on the loading stage.
 */
function createPrewarmBristleTip() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c._tipVersion = 9001;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    const bristles = [
      [18, 22, 6.2], [30, 17, 7.0], [43, 21, 5.8],
      [14, 34, 6.8], [26, 31, 7.5], [38, 33, 7.2], [49, 34, 5.6],
      [20, 45, 6.0], [32, 46, 6.8], [44, 44, 5.5]
    ];
    for (let i = 0; i < bristles.length; i++) {
      const [bx, by, r] = bristles[i];
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/**
 * Generates a smooth circular brush tip for clean anti-aliased Brush/Eraser loading preview strokes.
 */
function createPrewarmRoundTip() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c._tipVersion = 9002;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.28, size * 0.5, size * 0.5, size * 0.48);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.75, 'rgba(0, 0, 0, 0.92)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.5, size * 0.48, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function createDetachedChunk(useGpu) {
  const canvases = [];
  const ctxs = [];
  for (let i = 0; i < LAYERS_COUNT; i++) {
    const c = document.createElement('canvas');
    c.width = SCRATCH_SIZE;
    c.height = SCRATCH_SIZE;
    const ctx = c.getContext('2d', { alpha: true, willReadFrequently: true });
    canvases.push(c);
    ctxs.push(ctx);
  }
  const strokeCanvas = document.createElement('canvas');
  strokeCanvas.width = SCRATCH_SIZE;
  strokeCanvas.height = SCRATCH_SIZE;
  const strokeCtx = strokeCanvas.getContext('2d', { alpha: true, willReadFrequently: true });

  return {
    cx: 0,
    cy: 0,
    width: SCRATCH_SIZE,
    height: SCRATCH_SIZE,
    canvases,
    ctxs,
    offscreenCanvases: [],
    offscreenCtxs: [],
    isEmpty: new Array(LAYERS_COUNT).fill(true),
    gpuTextures: new Array(LAYERS_COUNT).fill(null),
    gpuDirty: new Array(LAYERS_COUNT).fill(false),
    gpuStrokeTexture: null,
    gpuStrokeDirty: false,
    gpuStrokeActive: false,
    strokeCanvas,
    strokeCtx,
    element: null,
    isAttached: false,
    _useGpu: useGpu
  };
}

function seedScratchPaint(chunk, layer = 1) {
  const ctx = chunk.ctxs[layer];
  if (!ctx) return;
  ctx.fillStyle = '#336699';
  ctx.fillRect(28, 28, 72, 72);
  chunk.isEmpty[layer] = false;
  if (chunk.gpuDirty) {
    chunk.gpuDirty[layer] = true;
  }
}

function createIsolatedGpuProxy(realGr) {
  if (!realGr || !realGr.supported) return null;
  const proxy = {
    get gl() { return realGr.gl; },
    get supported() { return realGr.supported; },
    get _contextLost() { return realGr._contextLost; },
    get vao() { return realGr.vao; },
    get liquifySolver() { return realGr.liquifySolver; },
    set liquifySolver(v) { realGr.liquifySolver = v; },
    get smudgeSolver() { return realGr.smudgeSolver; },
    set smudgeSolver(v) { realGr.smudgeSolver = v; },
    get fluidSolver() { return realGr.fluidSolver; },
    set fluidSolver(v) { realGr.fluidSolver = v; },
    get airSolver() { return realGr.airSolver; },
    set airSolver(v) { realGr.airSolver = v; },
    get sumiSolver() { return realGr.sumiSolver; },
    set sumiSolver(v) { realGr.sumiSolver = v; },
    get eraserSolver() { return realGr.eraserSolver; },
    set eraserSolver(v) { realGr.eraserSolver = v; },
    _compileShader(type, src) {
      return realGr._compileShader(type, src);
    },
    _createOrUpdateTexture(existingTex, sourceCanvasOrImg, useLinear = true) {
      return realGr._createOrUpdateTexture(existingTex, sourceCanvasOrImg, useLinear);
    },
    updateChunkTextureSubRegion(chunk, layer, x, y, width, height, dataOrImageData) {
      return realGr.updateChunkTextureSubRegion(chunk, layer, x, y, width, height, dataOrImageData);
    },
    markChunkLayerDirty(chunk, layer) {
      if (chunk?.gpuDirty) chunk.gpuDirty[layer] = true;
    },
    markChunkStrokeDirty(chunk, active = true) {
      if (chunk) {
        chunk.gpuStrokeDirty = true;
        chunk.gpuStrokeActive = !!active;
      }
    },
    requestRender() {
      // Isolated scratch strokes must never trigger main viewport redraws
    }
  };
  return proxy;
}

function createScratchEngine(realEngine, app, scratchChunk, gpuProxy) {
  const realBrush = realEngine?.brush || {};
  const brushColor = realBrush.color || '#224466';

  const scratchEngine = {
    app,
    perfMonitor: null,
    currentProjectId: PREWARM_PROJECT_ID,
    isStatic: false,
    chunkSize: SCRATCH_SIZE,
    staticWidth: SCRATCH_SIZE,
    staticHeight: SCRATCH_SIZE,
    dpiScale: 1,
    zoom: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
    activeLayer: 1,
    isDrawing: true,
    smoothedVelocity: 1.0,
    spacingAccumulator: 0,
    strokeMinX: 0,
    strokeMaxX: SCRATCH_SIZE,
    strokeMinY: 0,
    strokeMaxY: SCRATCH_SIZE,
    strokePoints: [],
    activeSelectionPath: null,
    textureModeEnabled: false,
    texturePattern: 'dots',
    textureDensity: 0.5,
    textureGridSize: 8,
    backupCanvasPool: [],
    chunks: new Map([['0,0', scratchChunk]]),
    dirtyChunks: new Set(),
    offscreenDirty: new Set(),
    currentStrokeDirtyChunks: new Map(),
    layerSettings: Array.from({ length: LAYERS_COUNT }, () => ({
      visible: true,
      locked: false,
      alphaLock: false,
      opacity: 1.0
    })),
    gpuRenderer: gpuProxy,
    brush: {
      type: TOOLS.BRUSH,
      color: brushColor,
      tip: realBrush.tip || null,
      size: 28,
      opacity: 0.9,
      flow: 0.9,
      spacing: 0.08,
      falloff: realBrush.falloff ?? 0.5,
      liquifyQuality: realBrush.liquifyQuality ?? 2,
      airbrush: realBrush.airbrush ?? 0.15,
      brushSharpen: realBrush.brushSharpen ?? 0,
      paintHeight: Math.max(0.2, realBrush.paintHeight ?? 0),
      oiliness: Math.max(0.2, realBrush.oiliness ?? 0.5),
      smudgeFlowBoost: realBrush.smudgeFlowBoost ?? 1.0,
      smudgePickup: realBrush.smudgePickup ?? 2.0,
      smudgeAlpha: true,
      speedSize: 0,
      speedOpacity: 0,
      speedHue: 0,
      speedValue: 0,
      speedHeight: 0,
      speedWater: 0,
      fluidHeightShield: realBrush.fluidHeightShield ?? 65,
      airUseHeightmap: false,
      airHeightSource: 'surface',
      sumiUseHeightmap: false,
      sumiHeightSource: 'surface',
      sumiQuality: 3,
      sumiZoomProject: false,
      sumiPauseWhilePainting: false,
      wireDensity: realBrush.wireDensity ?? 24,
      wireRange: realBrush.wireRange ?? 4.0,
      wireMinDist: realBrush.wireMinDist ?? 0.5,
      pressureEnabled: false,
      pressureOpacityInfluence: 0,
      pressureSizeInfluence: 0,
      jitterPos: 0,
      jitterSize: 0,
      jitterAngle: 0,
      jitterHue: 0
    },
    _tipColorCache: null,
    _reliefCache: null,
    _masterReliefCache: null,
    scratchCanvas: null,
    scratchCtx: null,
    smudgeBuf: null,
    smudgeDirty: false,
    smudgeTiles: new Map(),
    useGpuSmudge: false,
    liquifyStroke: null,
    liquifySteps: [],
    liquifyChunkData: null,
    activeFluidBrush: null,
    activeAirBrush: null,

    _getChunk(cx, cy) {
      if (cx === 0 && cy === 0) return scratchChunk;
      return null;
    },
    _ensureStrokeCanvas(chunk) {
      return chunk.strokeCtx;
    },
    _markDirty(id, layer, isEmpty = false) {
      const chunk = this.chunks.get(id);
      if (chunk) {
        if (chunk.isEmpty) chunk.isEmpty[layer] = isEmpty;
        if (chunk.gpuDirty) chunk.gpuDirty[layer] = true;
      }
      this.dirtyChunks.add(`${id}|${layer}`);
    },
    _pushHistory() {},
    _status() {},
    refresh() {},
    refreshTransforms() {},
    clearAllOffscreenCanvases() {},
    _getCacheSize: realEngine._getCacheSize.bind(realEngine),
    _shiftColor: realEngine._shiftColor.bind(realEngine),
    _getTexturePattern: realEngine._getTexturePattern.bind(realEngine)
  };

  scratchEngine._updateTipCache = function (s, airbrush, color) {
    realEngine._updateTipCache.call(this, s, airbrush, color);
  };
  scratchEngine._updateReliefCache = function (s, blur) {
    realEngine._updateReliefCache.call(this, s, blur);
  };

  return scratchEngine;
}

function restoreDefaultGlState(gl) {
  if (!gl || gl.isContextLost()) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.disable(gl.SCISSOR_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.activeTexture(gl.TEXTURE0);
}

/**
 * Lightweight GPU->Canvas2D reader for the 512x256 loading preview viewport.
 */
function createPreviewPresenter(previewCanvas, overlayCanvas, scratchChunk, realGr) {
  const previewCtx = previewCanvas ? previewCanvas.getContext('2d', { alpha: true }) : null;
  const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d', { alpha: true }) : null;
  const gl = (realGr && realGr.supported && !realGr._contextLost) ? realGr.gl : null;

  let readFbo = null;
  let readBytes = null;
  let readImgData = null;

  if (gl && previewCtx) {
    readFbo = gl.createFramebuffer();
    readBytes = new Uint8Array(VIEW_W * VIEW_H * 4);
    readImgData = new ImageData(VIEW_W, VIEW_H);
  }

  function syncGpuToPreviewOrChunk(writeToChunk = false) {
    const tex = scratchChunk?.gpuTextures?.[1];
    if (!gl || gl.isContextLost() || !readFbo || !tex || !readBytes || !readImgData) return false;

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) {
      gl.readPixels(0, 0, VIEW_W, VIEW_H, gl.RGBA, gl.UNSIGNED_BYTE, readBytes);
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    if (status !== gl.FRAMEBUFFER_COMPLETE) return false;

    const dst = readImgData.data;
    const len = readBytes.length;
    for (let i = 0; i < len; i += 4) {
      const a = readBytes[i + 3];
      if (a === 0) {
        dst[i] = 0;
        dst[i + 1] = 0;
        dst[i + 2] = 0;
        dst[i + 3] = 0;
      } else if (a < 255) {
        const inv = 255 / a;
        dst[i] = Math.min(255, (readBytes[i] * inv + 0.5) | 0);
        dst[i + 1] = Math.min(255, (readBytes[i + 1] * inv + 0.5) | 0);
        dst[i + 2] = Math.min(255, (readBytes[i + 2] * inv + 0.5) | 0);
        dst[i + 3] = a;
      } else {
        dst[i] = readBytes[i];
        dst[i + 1] = readBytes[i + 1];
        dst[i + 2] = readBytes[i + 2];
        dst[i + 3] = 255;
      }
    }

    if (writeToChunk && scratchChunk?.ctxs?.[1]) {
      scratchChunk.ctxs[1].putImageData(readImgData, 0, 0);
      scratchChunk.isEmpty[1] = false;
    }
    if (previewCtx) {
      previewCtx.clearRect(0, 0, VIEW_W, VIEW_H);
      previewCtx.putImageData(readImgData, 0, 0);
    }
    return true;
  }

  function present(source = 'auto') {
    if (!previewCtx) return;
    if (source === 'gpu' && scratchChunk?.gpuTextures?.[1]) {
      if (syncGpuToPreviewOrChunk(false)) {
        if (scratchChunk.strokeCanvas) {
          previewCtx.drawImage(scratchChunk.strokeCanvas, 0, 0, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);
        }
        return;
      }
    }
    previewCtx.clearRect(0, 0, VIEW_W, VIEW_H);
    if (scratchChunk?.canvases?.[1]) {
      previewCtx.drawImage(scratchChunk.canvases[1], 0, 0, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);
    }
    if (scratchChunk?.strokeCanvas) {
      previewCtx.drawImage(scratchChunk.strokeCanvas, 0, 0, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);
    }
  }

  function renderOverlay({
    cursor = null,
    toolTag = '',
    lassoPoints = null,
    lassoClosed = false,
    antOffset = 0,
    deleteFlash = 0,
    userCursor = null
  } = {}) {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, VIEW_W, VIEW_H);

    // Optional Delete flash pulse inside mask
    if (deleteFlash > 0 && lassoPoints && lassoPoints.length >= 3) {
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (let i = 1; i < lassoPoints.length; i++) {
        overlayCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      }
      overlayCtx.closePath();
      overlayCtx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, deleteFlash * 0.85)})`;
      overlayCtx.fill();
      overlayCtx.lineWidth = 2.5;
      overlayCtx.strokeStyle = `rgba(220, 38, 38, ${Math.min(1, deleteFlash)})`;
      overlayCtx.stroke();
      overlayCtx.restore();
    } else if (lassoPoints && lassoPoints.length >= 2) {
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (let i = 1; i < lassoPoints.length; i++) {
        overlayCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      }
      if (lassoClosed) overlayCtx.closePath();
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = '#ffffff';
      overlayCtx.setLineDash([7, 5]);
      overlayCtx.lineDashOffset = -antOffset;
      overlayCtx.stroke();
      overlayCtx.strokeStyle = '#000000';
      overlayCtx.lineDashOffset = -antOffset + 6;
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    // Simulated automated brush reticle
    if (cursor) {
      const r = Math.max(4, (cursor.size || 20) * 0.5);
      overlayCtx.save();
      overlayCtx.strokeStyle = 'rgba(0,0,0,0.85)';
      overlayCtx.lineWidth = 1.5;
      overlayCtx.beginPath();
      overlayCtx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
      overlayCtx.stroke();

      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.arc(cursor.x, cursor.y, Math.max(2, r - 1.5), 0, Math.PI * 2);
      overlayCtx.stroke();

      if (toolTag) {
        const tx = Math.min(VIEW_W - 64, Math.max(6, cursor.x + r + 5));
        const ty = Math.max(14, Math.min(VIEW_H - 6, cursor.y - 4));
        overlayCtx.font = '900 8px ui-monospace, monospace';
        const tw = overlayCtx.measureText(toolTag).width + 6;
        overlayCtx.fillStyle = '#000000';
        overlayCtx.fillRect(tx - 3, ty - 9, tw, 11);
        overlayCtx.fillStyle = '#ffffff';
        overlayCtx.fillText(toolTag, tx, ty);
      }
      overlayCtx.restore();
    }

    // Live interactive user pointer crosshair
    if (userCursor && userCursor.inside) {
      const ux = userCursor.x;
      const uy = userCursor.y;
      overlayCtx.save();
      overlayCtx.strokeStyle = '#000000';
      overlayCtx.lineWidth = 1.5;
      overlayCtx.strokeRect(ux - 6, uy - 6, 12, 12);
      overlayCtx.beginPath();
      overlayCtx.moveTo(ux - 10, uy);
      overlayCtx.lineTo(ux + 10, uy);
      overlayCtx.moveTo(ux, uy - 10);
      overlayCtx.lineTo(ux, uy + 10);
      overlayCtx.stroke();
      overlayCtx.restore();
    }
  }

  function destroy() {
    if (gl && !gl.isContextLost() && readFbo) {
      gl.deleteFramebuffer(readFbo);
      readFbo = null;
    }
    readBytes = null;
    readImgData = null;
  }

  return {
    previewCtx,
    overlayCtx,
    present,
    syncGpuToPreviewOrChunk,
    renderOverlay,
    destroy
  };
}

/**
 * Generates vertical snake 'S' points from y0..y1 around centerX.
 */
function generateVerticalSnakePoints(count, {
  centerX,
  y0 = 32,
  y1 = 224,
  amp = 24,
  cycles = 2.0,
  phase = 0,
  harmonicAmp = 0,
  harmonicMult = 2.0,
  sizeBase = 24,
  sizeVar = 0,
  pressureWave = false
}) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const theta = t * Math.PI * 2 * cycles + phase;
    const x = centerX + amp * Math.sin(theta) + harmonicAmp * Math.cos(theta * harmonicMult);
    const y = y0 + (y1 - y0) * t;
    // Higher speed through inflection crossings (cos close to +/-1), slower at turn peaks
    const slopeNorm = Math.abs(Math.cos(theta));
    const vFactor = Math.max(0.12, Math.min(0.98, 0.14 + 0.84 * slopeNorm));
    const pressure = pressureWave
      ? Math.max(0.45, Math.min(1.0, 0.55 + 0.45 * Math.sin(t * Math.PI)))
      : 0.9;
    const size = Math.max(4, sizeBase + sizeVar * (slopeNorm - 0.5));
    pts.push({ x, y, t, vFactor, pressure, size });
  }
  return pts;
}

function cleanupScratchResources(realEngine, scratchEngine, scratchChunk, realGrSnapshot) {
  try { cancelWireframeStroke(scratchEngine); } catch (_) {}
  try { cancelSmudgeStroke(scratchEngine); } catch (_) {}
  try { cancelFluidAfterEffect(scratchEngine); } catch (_) {}
  try { cancelAirParticles(scratchEngine); } catch (_) {}
  try { cancelSumiStroke(scratchEngine); } catch (_) {}
  try { cancelEraserStroke(scratchEngine); } catch (_) {}
  try { cancelLiquifyStroke(scratchEngine); } catch (_) {}
  try { invalidateLiquifySession(realEngine); } catch (_) {}
  try {
    if (wasmCore && wasmCore.ready && typeof wasmCore.liquifyEndAllSessions === 'function') {
      wasmCore.liquifyEndAllSessions();
    }
  } catch (_) {}

  try {
    clearAirWetCacheForProject(scratchEngine, PREWARM_PROJECT_ID);
  } catch (_) {}
  try {
    clearSumiPassiveArchive(scratchEngine, null);
  } catch (_) {}

  const realGr = realEngine?.gpuRenderer;
  const gl = realGr?.gl;
  if (gl && !gl.isContextLost()) {
    for (let i = 0; i < scratchChunk.gpuTextures.length; i++) {
      if (scratchChunk.gpuTextures[i]) {
        gl.deleteTexture(scratchChunk.gpuTextures[i]);
        scratchChunk.gpuTextures[i] = null;
      }
    }
    if (scratchChunk.gpuStrokeTexture) {
      gl.deleteTexture(scratchChunk.gpuStrokeTexture);
      scratchChunk.gpuStrokeTexture = null;
    }

    // Discard any scratch-sized (512x512) origPool FBOs acquired during prewarm Liquify step
    const liqSolver = realGr.liquifySolver;
    if (liqSolver && Array.isArray(liqSolver.origPool)) {
      const kept = [];
      for (let i = 0; i < liqSolver.origPool.length; i++) {
        const item = liqSolver.origPool[i];
        if (item && item.w === SCRATCH_SIZE && item.h === SCRATCH_SIZE) {
          liqSolver._delTexFbo(item);
        } else {
          kept.push(item);
        }
      }
      liqSolver.origPool = kept;
    }

    if (realGrSnapshot) {
      realGr.fluidOverlay = null;
      realGr.airOverlay = null;
      realGr.smudgeOverlay = null;
      realGr.sumiOverlay = null;
    }

    restoreDefaultGlState(gl);
  }

  for (let i = 0; i < scratchChunk.canvases.length; i++) {
    scratchChunk.canvases[i].width = 0;
    scratchChunk.canvases[i].height = 0;
  }
  scratchChunk.strokeCanvas.width = 0;
  scratchChunk.strokeCanvas.height = 0;

  if (scratchEngine.scratchCanvas) {
    scratchEngine.scratchCanvas.width = 0;
    scratchEngine.scratchCanvas.height = 0;
    scratchEngine.scratchCanvas = null;
    scratchEngine.scratchCtx = null;
  }
  for (let i = 0; i < scratchEngine.backupCanvasPool.length; i++) {
    const b = scratchEngine.backupCanvasPool[i];
    if (b?.canvas) {
      b.canvas.width = 0;
      b.canvas.height = 0;
    }
  }
  scratchEngine.backupCanvasPool.length = 0;
  scratchEngine.currentStrokeDirtyChunks.clear();
  scratchEngine.dirtyChunks.clear();
  scratchEngine.chunks.clear();
  if (scratchEngine.smudgeTiles) scratchEngine.smudgeTiles.clear();
  scratchEngine.smudgeBuf = null;
}

/**
 * Runs an isolated prewarm across every painting tool + WASM + brush tip caches.
 * When `previewCanvas` & `overlayCanvas` are supplied, animates a visual interactive
 * multi-tool choreography synchronized so the final Lasso mask + DELETE fires in exact
 * lockstep with completion of all warmup tasks.
 */
export async function runPhantomToolsPrewarm(app, {
  onProgress,
  shouldAbort,
  previewCanvas = null,
  overlayCanvas = null
} = {}) {
  const realEngine = app?.engine;
  if (!realEngine || app._isPrewarming) return false;

  const visualMode = !!(previewCanvas && overlayCanvas);
  const isAborted = () => !!(
    shouldAbort?.() ||
    realEngine.isDrawing ||
    app._isSwitchingProject ||
    realEngine._isLoadingProject ||
    realEngine.gpuRenderer?._contextLost
  );

  if (isAborted()) return false;

  // Snapshot module-level tool settings & active reservoir so startup demo never leaks into user settings
  const snapFluid = { ...fluidSettings };
  const snapAir = { ...airSettings };
  const snapSumi = { ...sumiSettings };

  const scratchChunk = createDetachedChunk(!!realEngine.gpuRenderer?.supported);
  const gpuProxy = createIsolatedGpuProxy(realEngine.gpuRenderer);
  const scratchEngine = createScratchEngine(realEngine, app, scratchChunk, gpuProxy);
  const bristleTip = createPrewarmBristleTip();
  const roundTip = createPrewarmRoundTip();

  const presenter = visualMode
    ? createPreviewPresenter(previewCanvas, overlayCanvas, scratchChunk, realEngine.gpuRenderer)
    : null;

  const lassoMaskCanvas = document.createElement('canvas');
  lassoMaskCanvas.width = SCRATCH_SIZE;
  lassoMaskCanvas.height = SCRATCH_SIZE;
  const lassoMaskCtx = lassoMaskCanvas.getContext('2d', { willReadFrequently: true });

  // Interactive user doodle support on the loading preview canvas
  const userCursor = { x: VIEW_W * 0.5, y: VIEW_H * 0.5, inside: false, down: false, lastX: 0, lastY: 0, hueShift: 0 };
  let lastOverlayState = {};
  let canInteractivePaint = visualMode;

  const toStageCoords = (ev) => {
    const rect = previewCanvas.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(VIEW_W, ((ev.clientX - rect.left) / rect.width) * VIEW_W)),
      y: Math.max(0, Math.min(VIEW_H, ((ev.clientY - rect.top) / rect.height) * VIEW_H))
    };
  };

  const paintUserSegment = (x0, y0, x1, y1) => {
    if (!canInteractivePaint || !scratchChunk?.ctxs?.[1]) return;
    const ctx = scratchChunk.ctxs[1];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    userCursor.hueShift = (userCursor.hueShift + 9) % 360;
    ctx.strokeStyle = `hsl(${userCursor.hueShift}, 82%, 45%)`;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
    scratchChunk.isEmpty[1] = false;

    // If GPU texture is active right now, sync modified subrect directly so GPU tools react to user paint
    if (scratchChunk.gpuTextures?.[1] && realEngine.gpuRenderer?.supported) {
      const rx0 = Math.max(0, Math.floor(Math.min(x0, x1) - 6));
      const ry0 = Math.max(0, Math.floor(Math.min(y0, y1) - 6));
      const rx1 = Math.min(VIEW_W, Math.ceil(Math.max(x0, x1) + 6));
      const ry1 = Math.min(VIEW_H, Math.ceil(Math.max(y0, y1) + 6));
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      if (rw > 0 && rh > 0) {
        const subImg = ctx.getImageData(rx0, ry0, rw, rh);
        realEngine.gpuRenderer.updateChunkTextureSubRegion(scratchChunk, 1, rx0, ry0, rw, rh, subImg);
      }
    } else if (scratchChunk.gpuDirty) {
      scratchChunk.gpuDirty[1] = true;
    }

    presenter?.present('auto');
  };

  const onPointerDown = (e) => {
    if (!canInteractivePaint) return;
    const p = toStageCoords(e);
    userCursor.inside = true;
    userCursor.down = true;
    userCursor.x = p.x;
    userCursor.y = p.y;
    userCursor.lastX = p.x;
    userCursor.lastY = p.y;
    try { previewCanvas.setPointerCapture?.(e.pointerId); } catch (_) {}
    paintUserSegment(p.x, p.y, p.x + 0.5, p.y + 0.5);
    presenter?.renderOverlay({ ...lastOverlayState, userCursor });
  };

  const onPointerMove = (e) => {
    if (!visualMode) return;
    const p = toStageCoords(e);
    userCursor.inside = true;
    userCursor.x = p.x;
    userCursor.y = p.y;
    if (userCursor.down && canInteractivePaint) {
      paintUserSegment(userCursor.lastX, userCursor.lastY, p.x, p.y);
      userCursor.lastX = p.x;
      userCursor.lastY = p.y;
    }
    presenter?.renderOverlay({ ...lastOverlayState, userCursor });
  };

  const onPointerUp = () => {
    userCursor.down = false;
  };

  const onPointerLeave = () => {
    userCursor.inside = false;
    userCursor.down = false;
    presenter?.renderOverlay({ ...lastOverlayState, userCursor });
  };

  if (visualMode) {
    previewCanvas.addEventListener('pointerdown', onPointerDown);
    previewCanvas.addEventListener('pointermove', onPointerMove);
    previewCanvas.addEventListener('pointerup', onPointerUp);
    previewCanvas.addEventListener('pointercancel', onPointerUp);
    previewCanvas.addEventListener('pointerleave', onPointerLeave);
  }

  const updateOverlay = (state) => {
    lastOverlayState = state;
    presenter?.renderOverlay({ ...state, userCursor });
  };

  const progress = (stepIdx, total, toolLabel, detailText) => {
    if (typeof onProgress === 'function') {
      onProgress(stepIdx, total, toolLabel, detailText);
    }
  };

  /**
   * Helper: animates array of steps across multiple rAF batches in visual mode,
   * or in a single batch in headless silent mode.
   */
  async function animateBatches(items, batchSize, onBatchItem, onFrameDone) {
    if (!visualMode) {
      for (let i = 0; i < items.length; i++) {
        onBatchItem(items[i], i);
      }
      return !isAborted();
    }
    for (let i = 0; i < items.length; i++) {
      onBatchItem(items[i], i);
      const isBatchEnd = ((i + 1) % batchSize === 0) || (i === items.length - 1);
      if (isBatchEnd) {
        onFrameDone?.(items[i], i);
        await nextAnimationFrame();
        if (isAborted()) return false;
      }
    }
    return true;
  }

  // Ensures Canvas2D layer matches GPU layer before Canvas2D ops / cross-tool transitions
  const syncGpuToCanvasIfNeeded = () => {
    if (presenter && scratchChunk.gpuTextures?.[1]) {
      presenter.syncGpuToPreviewOrChunk(true);
    }
  };

  // Precomputed 5 varied vertical snake 'S' trajectories
  const snakeBrush = generateVerticalSnakePoints(visualMode ? 48 : 4, {
    centerX: 62, y0: 34, y1: 222, amp: 20, cycles: 1.85, phase: 0.15, sizeBase: 24, sizeVar: 8
  });
  const snakeWire = generateVerticalSnakePoints(visualMode ? 38 : 4, {
    centerX: 158, y0: 36, y1: 220, amp: 22, cycles: 2.35, phase: 0.9, harmonicAmp: 9, harmonicMult: 2.0, sizeBase: 17, sizeVar: 5
  });
  const snakeFluid = generateVerticalSnakePoints(visualMode ? 32 : 4, {
    centerX: 256, y0: 32, y1: 224, amp: 23, cycles: 1.65, phase: -0.4, sizeBase: 36, sizeVar: 10
  });
  const snakeAir = generateVerticalSnakePoints(visualMode ? 32 : 4, {
    centerX: 352, y0: 40, y1: 218, amp: -24, cycles: 1.75, phase: 0.5, sizeBase: 42, sizeVar: 8
  });
  const snakeSumi = generateVerticalSnakePoints(visualMode ? 36 : 4, {
    centerX: 446, y0: 32, y1: 224, amp: 20, cycles: 2.15, phase: -0.7, harmonicAmp: 6, harmonicMult: 2.0, sizeBase: 34, sizeVar: 10, pressureWave: true
  });

  // Smudge horizontal sweep across all 5 vertical snakes
  const smudgeLine = [];
  const smCount = visualMode ? 28 : 3;
  for (let i = 0; i < smCount; i++) {
    const t = i / (smCount - 1);
    smudgeLine.push({
      x: 32 + t * 448,
      y: 128 + 11 * Math.sin(t * Math.PI * 2.0),
      size: 36,
      opacity: 1.0,
      pressure: 0.92
    });
  }

  // Eraser clean diagonal cut line
  const eraserLine = [];
  const erCount = visualMode ? 20 : 3;
  for (let i = 0; i < erCount; i++) {
    const t = i / (erCount - 1);
    eraserLine.push({
      x: 38 + t * 436,
      y: 176 - t * 92 + 5 * Math.sin(t * Math.PI * 3),
      size: 19,
      opacity: 1.0,
      pressure: 0.95
    });
  }

  // Liquify circular swirl loop in center
  const liquifyCircle = [];
  const lqCount = visualMode ? 30 : 3;
  for (let i = 0; i < lqCount; i++) {
    const t = i / (lqCount - 1);
    const ang = t * Math.PI * 2.25;
    liquifyCircle.push({
      x: 256 + Math.cos(ang) * 56,
      y: 128 + Math.sin(ang) * 44,
      size: 92
    });
  }

  // Lasso enclosing polygon covering the whole active artwork (with margin for blooms & doodles)
  const lassoPoly = [
    { x: 10, y: 8 },
    { x: 140, y: 7 },
    { x: 264, y: 8 },
    { x: 388, y: 7 },
    { x: 502, y: 10 },
    { x: 504, y: 128 },
    { x: 502, y: 246 },
    { x: 368, y: 248 },
    { x: 256, y: 247 },
    { x: 132, y: 248 },
    { x: 10, y: 246 },
    { x: 8, y: 126 }
  ];

  const TOTAL_STEPS = 10;
  app._isPrewarming = true;
  app.perfMonitor?.setPrewarmSuppression(true);

  let completed = false;
  try {
    if (!visualMode) seedScratchPaint(scratchChunk, 1);

    // ------------------------------------------------------------------
    // 1. BRUSH — Smooth Red with Subtle Speed Hue, Value & Size Dynamics
    // ------------------------------------------------------------------
    progress(1, TOTAL_STEPS, 'BRUSH', 'WARMING BRUSH & SPEED HUE/VALUE DYNAMICS...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.BRUSH;
    scratchEngine.brush.tip = roundTip;
    scratchEngine.brush.color = '#dc2626';
    scratchEngine.brush.opacity = 1.0;
    scratchEngine.brush.flow = 0.96;
    scratchEngine.brush.spacing = 0.03;
    scratchEngine.brush.speedHue = 22;
    scratchEngine.brush.speedValue = -18;
    scratchEngine.brush.speedSize = 36;
    scratchEngine.brush.paintHeight = 0;
    scratchEngine.brush.oiliness = 0;
    scratchEngine.currentStrokeDirtyChunks.clear();
    scratchEngine.spacingAccumulator = 0;

    const brushSegments = [];
    for (let i = 1; i < snakeBrush.length; i++) {
      brushSegments.push({ from: snakeBrush[i - 1], to: snakeBrush[i] });
    }
    const okBrush = await animateBatches(
      brushSegments,
      4,
      (seg) => {
        const vf = seg.to.vFactor;
        const hShift = vf * (scratchEngine.brush.speedHue / 100) * 110;
        const lShift = vf * (scratchEngine.brush.speedValue / 100) * 0.75;
        const col = scratchEngine._shiftColor('#dc2626', hShift, lShift);
        const dynSize = seg.to.size * (0.82 + vf * 0.42);
        _paintOnChunks.call(scratchEngine, seg.from, seg.to, dynSize, 0.96, col);
        scratchChunk.isEmpty[1] = false;
      },
      (seg) => {
        presenter?.present('auto');
        updateOverlay({ cursor: { x: seg.to.x, y: seg.to.y, size: seg.to.size }, toolTag: 'BRUSH' });
      }
    );
    if (!okBrush) return false;
    if (scratchChunk.strokeCtx) {
      scratchChunk.ctxs[1].drawImage(scratchChunk.strokeCanvas, 0, 0);
      scratchChunk.strokeCtx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
      scratchChunk.gpuStrokeActive = false;
      scratchChunk.gpuStrokeDirty = false;
    }
    if (scratchChunk.gpuDirty) scratchChunk.gpuDirty[1] = true;
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 2. WIREFRAME — Enclosing Polygons
    // ------------------------------------------------------------------
    progress(2, TOTAL_STEPS, 'WIREFRAME', 'WARMING WIREFRAME ENCLOSING GEOMETRY...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.WIREFRAME;
    scratchEngine.brush.color = '#1d4ed8';
    scratchEngine.brush.opacity = 0.95;
    scratchEngine.brush.flow = 0.95;
    scratchEngine.brush.spacing = 0.05;
    scratchEngine.brush.wireDensity = 28;
    scratchEngine.brush.wireRange = 3.2;
    scratchEngine.brush.wireMinDist = 0.35;
    scratchEngine.currentStrokeDirtyChunks.clear();

    const wireStart = {
      x: snakeWire[0].x,
      y: snakeWire[0].y,
      size: snakeWire[0].size,
      opacity: 0.95,
      color: '#1d4ed8',
      pressure: 0.9
    };
    scratchEngine.strokePoints = [wireStart];
    startWireframeStroke(scratchEngine, wireStart);

    const okWire = await animateBatches(
      snakeWire.slice(1),
      4,
      (pt) => {
        const col = scratchEngine._shiftColor('#1d4ed8', pt.vFactor * 36, pt.vFactor * 0.15);
        const wp = { x: pt.x, y: pt.y, size: pt.size, opacity: 0.95, color: col, pressure: 0.9 };
        scratchEngine.strokePoints.push(wp);
        paintWireframeMove(scratchEngine, wp);
      },
      (pt) => {
        presenter?.present('auto');
        updateOverlay({ cursor: { x: pt.x, y: pt.y, size: pt.size }, toolTag: 'WIREFRAME' });
      }
    );
    endWireframeStroke(scratchEngine);
    if (!okWire) return false;
    if (scratchChunk.strokeCtx) {
      scratchChunk.ctxs[1].save();
      scratchChunk.ctxs[1].globalAlpha = scratchEngine.brush.opacity ?? 0.95;
      scratchChunk.ctxs[1].drawImage(scratchChunk.strokeCanvas, 0, 0);
      scratchChunk.ctxs[1].restore();
      scratchChunk.strokeCtx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
      scratchChunk.gpuStrokeActive = false;
      scratchChunk.gpuStrokeDirty = false;
    }
    scratchChunk.isEmpty[1] = false;
    if (scratchChunk.gpuDirty) scratchChunk.gpuDirty[1] = true;
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 3. FLUID PAINT — Bristle Texture & 3D Impasto
    // ------------------------------------------------------------------
    progress(3, TOTAL_STEPS, 'FLUID PAINT', 'COMPILING FLUID IMPASTO & SOBEL SHADERS...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.FLUID;
    scratchEngine.brush.tip = bristleTip;
    scratchEngine.brush.color = '#ea580c';
    scratchEngine.brush.size = 38;
    scratchEngine.brush.opacity = 1.0;
    scratchEngine.brush.flow = 1.0;
    scratchEngine.brush.paintHeight = 0.85;
    scratchEngine.brush.oiliness = 0.85;
    scratchEngine.currentStrokeDirtyChunks.clear();

    Object.assign(fluidSettings, {
      flow: 100,
      vortex: 16,
      turb: 12,
      retention: 88,
      pickup: 38,
      depth: 85,
      gloss: 100,
      fluidity: 70,
      bristles: 28,
      shading: true,
      followStroke: true,
      tipAngle: 0,
      bristleContrast: 92,
      bleed: 28,
      tipHardness: 72,
      pressureFlow: 30,
      heightShield: 65
    });

    warmFluidSolver(realEngine);
    const flStart = { x: snakeFluid[0].x, y: snakeFluid[0].y, size: 38, opacity: 1.0, color: '#ea580c', pressure: 0.95 };
    startFluidPaintStroke(scratchEngine, flStart);

    const flSegments = [];
    for (let i = 1; i < snakeFluid.length; i++) {
      flSegments.push({ from: snakeFluid[i - 1], to: snakeFluid[i] });
    }
    const okFluid = await animateBatches(
      flSegments,
      3,
      (seg) => {
        const col = scratchEngine._shiftColor('#ea580c', seg.to.vFactor * 24, 0);
        paintFluidOnChunks(scratchEngine, seg.from, seg.to, seg.to.size, 1.0, col, 0.95, performance.now(), seg.to.vFactor);
      },
      (seg) => {
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: seg.to.x, y: seg.to.y, size: seg.to.size }, toolTag: 'FLUID' });
      }
    );
    endFluidPaintStroke(scratchEngine);
    if (!okFluid) return false;
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 4. WATERCOLOR / AIR — Wet Dye Advection & Capillary Bloom
    // ------------------------------------------------------------------
    progress(4, TOTAL_STEPS, 'WATERCOLOR', 'COMPILING NAVIER-STOKES WATERCOLOR SOLVER...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.AIR;
    scratchEngine.brush.tip = realEngine.brush?.tip || null;
    scratchEngine.brush.color = '#0891b2';
    scratchEngine.brush.size = 42;
    scratchEngine.brush.opacity = 0.72;
    scratchEngine.brush.flow = 0.78;
    scratchEngine.currentStrokeDirtyChunks.clear();

    Object.assign(airSettings, {
      wetness: 98,
      streamFlow: 100,
      bloom: 80,
      edge: 70,
      granulation: 55,
      tipPour: 92,
      followStroke: false,
      tipAngle: 0,
      tipHardness: 45,
      pressureFlow: 30,
      useHeightmap: false,
      heightSource: 'surface'
    });

    warmAirSolver(realEngine);
    scratchEngine.strokePoints = snakeAir.map((pt) => ({
      x: pt.x,
      y: pt.y,
      size: pt.size,
      opacity: 0.72,
      color: scratchEngine._shiftColor('#0891b2', pt.vFactor * 20, -pt.vFactor * 0.1),
      pressure: 0.9,
      vFactor: pt.vFactor
    }));
    startAirPaintStroke(scratchEngine);

    const airIndices = [];
    for (let j = 1; j < scratchEngine.strokePoints.length; j++) airIndices.push(j);
    const okAir = await animateBatches(
      airIndices,
      3,
      (j) => {
        paintAirIncrementally(scratchEngine, j);
      },
      (j) => {
        const pt = scratchEngine.strokePoints[j];
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: pt.x, y: pt.y, size: pt.size }, toolTag: 'WATER' });
      }
    );
    endAirPaintStroke(scratchEngine);
    if (!okAir) return false;
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 5. SUMI-E INK — Deformable Bristles & Paper Pore Capillary Bleed
    // ------------------------------------------------------------------
    progress(5, TOTAL_STEPS, 'SUMI-E INK', 'COMPILING MULTI-LAYER SUMI-E INK PHYSICS...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.SUMI;
    scratchEngine.brush.tip = realEngine.brush?.tip || null;
    scratchEngine.brush.color = '#111111';
    scratchEngine.brush.size = 34;
    scratchEngine.brush.opacity = 1.0;
    scratchEngine.brush.flow = 1.0;
    scratchEngine.brush.speedWater = -35;
    scratchEngine.currentStrokeDirtyChunks.clear();

    Object.assign(sumiSettings, {
      mode: 'draw',
      ink: 92,
      water: 76,
      bleed: 72,
      bristles: 24,
      stiffness: 58,
      splitDry: 54,
      depleteSpan: 550,
      glue: 40,
      warmth: 12,
      evaporation: 24,
      capillarity: 75,
      backrun: 80,
      turbulence: 8,
      sootSnag: 55,
      depleteEnabled: true,
      splitEnabled: true,
      tiltEnabled: false,
      autoReDip: true,
      followStroke: false,
      tipAngle: 0,
      pressureFlow: 35,
      pressureGate: 20,
      maxWater: 110,
      useHeightmap: false
    });

    warmSumiSolver(realEngine);
    const sumiP0 = { x: snakeSumi[0].x, y: snakeSumi[0].y, size: snakeSumi[0].size, opacity: 1.0, color: '#111111', pressure: snakeSumi[0].pressure };
    scratchEngine.strokePoints = [sumiP0];
    startSumiPaintStroke(scratchEngine, sumiP0);

    const okSumi = await animateBatches(
      snakeSumi.slice(1),
      4,
      (pt) => {
        scratchEngine.strokePoints.push({ ...pt, color: '#111111', opacity: 1.0 });
        paintSumiMove(scratchEngine, pt, pt.size, 1.0, '#111111', pt.pressure, null, pt.vFactor);
      },
      (pt) => {
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: pt.x, y: pt.y, size: pt.size }, toolTag: 'SUMI-E' });
      }
    );
    if (!okSumi) return false;
    endSumiPaintStroke(scratchEngine);

    // Let Sumi water/ink bleed visibly settle for a few quick simulation frames
    const sumiSolver = scratchEngine.gpuRenderer?.sumiSolver;
    if (visualMode && sumiSolver && sumiSolver.active && sumiSolver.ready) {
      for (let f = 0; f < 6; f++) {
        await nextAnimationFrame();
        if (isAborted()) return false;
        sumiSolver.stepSimulation(scratchEngine, 0.018, false);
        presenter?.present('gpu');
        updateOverlay({ cursor: null, toolTag: 'SUMI-E' });
      }
    }
    stopSumiSimulation(scratchEngine);
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 6. SMUDGE — Horizontal Sweep Across All 5 Snakes
    // ------------------------------------------------------------------
    progress(6, TOTAL_STEPS, 'SMUDGE', 'WARMING SMUDGE PICKUP & MIXING SHADERS...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.SMUDGE;
    scratchEngine.brush.tip = realEngine.brush?.tip || null;
    scratchEngine.brush.size = 36;
    scratchEngine.brush.opacity = 1.0;
    scratchEngine.brush.flow = 0.95;
    scratchEngine.brush.smudgeFlowBoost = 1.25;
    scratchEngine.brush.smudgePickup = 2.4;
    scratchEngine.brush.smudgeAlpha = true;
    scratchEngine.currentStrokeDirtyChunks.clear();

    warmSmudgeSolver(realEngine);
    const affectedSmudge = new Map([['0,0', { cx: 0, cy: 0, stamps: smudgeLine }]]);
    startSmudgeStroke(scratchEngine, smudgeLine[0]);

    const smudgePairs = [];
    for (let i = 1; i < smudgeLine.length; i++) {
      smudgePairs.push([smudgeLine[i - 1], smudgeLine[i]]);
    }
    const okSmudge = await animateBatches(
      smudgePairs,
      3,
      (pair) => {
        const subAffected = new Map([['0,0', { cx: 0, cy: 0, stamps: pair }]]);
        paintSmudgeOnChunks(scratchEngine, pair, subAffected, 0.95, 1.0, scratchEngine.brush.tip);
      },
      (pair) => {
        const pt = pair[1];
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: pt.x, y: pt.y, size: 36 }, toolTag: 'SMUDGE' });
      }
    );
    if (!okSmudge) return false;
    // Also make sure headless path sees full affectedSmudge warmed cleanly
    if (!visualMode) {
      paintSmudgeOnChunks(scratchEngine, smudgeLine.slice(0, 2), affectedSmudge, 0.95, 1.0, scratchEngine.brush.tip);
    }
    endSmudgeStroke(scratchEngine);
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 7. ERASER — Clean Cut Across Composition
    // ------------------------------------------------------------------
    progress(7, TOTAL_STEPS, 'ERASER', 'WARMING GPU ERASER STENCIL SOLVER...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.ERASER;
    scratchEngine.brush.tip = roundTip;
    scratchEngine.brush.size = 20;
    scratchEngine.brush.opacity = 1.0;
    scratchEngine.brush.flow = 1.0;
    scratchEngine.brush.spacing = 0.04;
    scratchEngine.currentStrokeDirtyChunks.clear();
    scratchEngine.spacingAccumulator = 0;

    warmEraserSolver(realEngine);
    startEraserStroke(scratchEngine);

    const erSegs = [];
    for (let i = 1; i < eraserLine.length; i++) {
      erSegs.push({ from: eraserLine[i - 1], to: eraserLine[i] });
    }
    const okEraser = await animateBatches(
      erSegs,
      3,
      (seg) => {
        _paintOnChunks.call(scratchEngine, seg.from, seg.to, 20, 1.0, scratchEngine.brush.color);
      },
      (seg) => {
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: seg.to.x, y: seg.to.y, size: 20 }, toolTag: 'ERASER' });
      }
    );
    endEraserStroke(scratchEngine);
    if (!okEraser) return false;
    if (scratchChunk.strokeCtx) {
      scratchChunk.strokeCtx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
      scratchChunk.gpuStrokeActive = false;
      scratchChunk.gpuStrokeDirty = false;
    }
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 8. LIQUIFY — Circular Warp Swirl
    // ------------------------------------------------------------------
    progress(8, TOTAL_STEPS, 'LIQUIFY', 'WARMING LIQUIFY DISPLACEMENT FIELD & WASM...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.LIQUIFY;
    scratchEngine.brush.size = 92;
    scratchEngine.brush.flow = 0.72;
    scratchEngine.brush.falloff = 0.45;
    scratchEngine.brush.liquifyQuality = 2;
    scratchEngine.currentStrokeDirtyChunks.clear();

    // Always warm Liquify on realEngine first so origPool keeps real chunk dimensions
    warmLiquifySolver(realEngine);
    if (wasmCore && wasmCore.ready && typeof wasmCore.liquifyPrewarm === 'function') {
      try { wasmCore.liquifyPrewarm(); } catch (_) {}
    }

    startLiquifyStroke(scratchEngine, liquifyCircle[0]);
    const lqSegs = [];
    for (let i = 1; i < liquifyCircle.length; i++) {
      lqSegs.push({ from: liquifyCircle[i - 1], to: liquifyCircle[i] });
    }
    const okLiquify = await animateBatches(
      lqSegs,
      3,
      (seg) => {
        paintLiquifyStroke(scratchEngine, seg.from, seg.to, 92, 0.9);
      },
      (seg) => {
        presenter?.present(scratchChunk.gpuTextures?.[1] ? 'gpu' : 'auto');
        updateOverlay({ cursor: { x: seg.to.x, y: seg.to.y, size: 92 }, toolTag: 'LIQUIFY' });
      }
    );
    endLiquifyStroke(scratchEngine);
    flushLiquifyGpuCommits(scratchEngine);
    invalidateLiquifySession(realEngine);
    if (!okLiquify) return false;
    syncGpuToCanvasIfNeeded();
    presenter?.present('auto');

    // ------------------------------------------------------------------
    // 9. LASSO SELECTION — Tracing Selection Mask + Active Tip Warmup
    // ------------------------------------------------------------------
    progress(9, TOTAL_STEPS, 'LASSO', 'WARMING SELECTION MASK & BRUSH TIP CACHES...');
    await nextAnimationFrame();
    if (isAborted()) return false;

    scratchEngine.brush.type = TOOLS.LASSO;
    if (visualMode) {
      for (let k = 2; k <= lassoPoly.length; k++) {
        const subPoly = lassoPoly.slice(0, k);
        const lastPt = subPoly[subPoly.length - 1];
        updateOverlay({
          cursor: { x: lastPt.x, y: lastPt.y, size: 14 },
          toolTag: 'LASSO',
          lassoPoints: subPoly,
          lassoClosed: false,
          antOffset: k * 3
        });
        await nextAnimationFrame();
        if (isAborted()) return false;
      }
    }

    const norm = normalizeSelectionPath(lassoPoly);
    if (lassoMaskCtx && norm) {
      drawSelectionMask(lassoMaskCtx, norm, 0, 0);
      lassoMaskCtx.getImageData(24, 24, 32, 32);
    }

    // Pre-warm the user's real active brush tip cache before final DELETE beat
    if (!isAborted() && realEngine.brush?.tip) {
      const bSize = Math.round(realEngine.brush.size || 20);
      const cacheSize = realEngine._getCacheSize(bSize);
      realEngine._updateTipCache(cacheSize, realEngine.brush.airbrush || 0, realEngine.brush.color || '#000000');
    }

    // Animate a quick marching-ants beat showing active closed selection ready to DELETE
    if (visualMode) {
      for (let t = 0; t < 4; t++) {
        updateOverlay({
          cursor: null,
          toolTag: 'MASKED',
          lassoPoints: lassoPoly,
          lassoClosed: true,
          antOffset: t * 4
        });
        await nextAnimationFrame();
        if (isAborted()) return false;
      }
    }

    // ------------------------------------------------------------------
    // 10. SYNCHRONIZED DELETE — Exact Completion of All Tool Warmup
    // ------------------------------------------------------------------
    canInteractivePaint = false;
    progress(10, TOTAL_STEPS, 'DELETE', 'ALL TOOLS PREWARMED // CLEARING MASK');

    if (scratchChunk.ctxs?.[1] && lassoMaskCanvas) {
      const ctx = scratchChunk.ctxs[1];
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(lassoMaskCanvas, 0, 0);
      ctx.restore();
      if (scratchChunk.gpuDirty) scratchChunk.gpuDirty[1] = true;
    }
    if (scratchChunk.strokeCtx) {
      scratchChunk.strokeCtx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
      scratchChunk.gpuStrokeActive = false;
      scratchChunk.gpuStrokeDirty = false;
    }

    if (visualMode) {
      presenter?.present('auto');
      updateOverlay({
        cursor: null,
        toolTag: 'DELETE',
        lassoPoints: lassoPoly,
        lassoClosed: true,
        deleteFlash: 0.9
      });
      await waitMs(110);
      if (!isAborted()) {
        updateOverlay({
          cursor: null,
          toolTag: '',
          lassoPoints: null,
          deleteFlash: 0
        });
        await waitMs(120);
      }
    }

    completed = true;
    return true;
  } catch (err) {
    console.warn('Phantom tools prewarm aborted:', err);
    return false;
  } finally {
    if (visualMode) {
      previewCanvas.removeEventListener('pointerdown', onPointerDown);
      previewCanvas.removeEventListener('pointermove', onPointerMove);
      previewCanvas.removeEventListener('pointerup', onPointerUp);
      previewCanvas.removeEventListener('pointercancel', onPointerUp);
      previewCanvas.removeEventListener('pointerleave', onPointerLeave);
    }
    presenter?.destroy();

    Object.assign(fluidSettings, snapFluid);
    Object.assign(airSettings, snapAir);
    Object.assign(sumiSettings, snapSumi);
    try {
      syncSumiTip(realEngine);
      reDipSumi(realEngine);
    } catch (_) {}

    bristleTip.width = 0;
    bristleTip.height = 0;
    roundTip.width = 0;
    roundTip.height = 0;
    lassoMaskCanvas.width = 0;
    lassoMaskCanvas.height = 0;
    cleanupScratchResources(realEngine, scratchEngine, scratchChunk, realEngine.gpuRenderer);
    app._isPrewarming = false;
    app.perfMonitor?.setPrewarmSuppression(false);
    if (completed) {
      app.perfMonitor?.resetTiming();
    }
    realEngine.gpuRenderer?.requestRender();
  }
}
