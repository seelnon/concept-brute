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
  warmFluidSolver,
  startFluidPaintStroke,
  paintFluidOnChunks,
  endFluidPaintStroke,
  cancelFluidAfterEffect
} from './fluidPaint.js';
import {
  warmAirSolver,
  startAirPaintStroke,
  paintAirIncrementally,
  endAirPaintStroke,
  clearAirParticles,
  clearAirWetCacheForProject
} from './airPaint.js';
import {
  warmSumiSolver,
  startSumiPaintStroke,
  paintSumiMove,
  endSumiPaintStroke,
  cancelSumiStroke
} from './sumiPaint.js';
import {
  warmEraserSolver,
  startEraserStroke,
  endEraserStroke,
  cancelEraserStroke
} from './eraser.js';
import { wasmCore } from '../wasm/wasmBridge.js';

const SCRATCH_SIZE = 128;
const PREWARM_PROJECT_ID = '__prewarm__';

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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
  ctx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
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
      // Isolated phantom scratch strokes must never trigger viewport redraws
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
      opacity: 0.85,
      flow: 0.85,
      spacing: 0.1,
      falloff: realBrush.falloff ?? 0.5,
      liquifyQuality: realBrush.liquifyQuality ?? 2,
      airbrush: realBrush.airbrush ?? 0.25,
      brushSharpen: realBrush.brushSharpen ?? 0,
      paintHeight: Math.max(0.2, realBrush.paintHeight ?? 0),
      oiliness: Math.max(0.2, realBrush.oiliness ?? 0.5),
      smudgeFlowBoost: realBrush.smudgeFlowBoost ?? 1.0,
      smudgePickup: realBrush.smudgePickup ?? 2.0,
      smudgeAlpha: true,
      speedHeight: 0,
      speedWater: 0,
      fluidHeightShield: realBrush.fluidHeightShield ?? 65,
      airUseHeightmap: false,
      airHeightSource: 'surface',
      sumiUseHeightmap: false,
      sumiHeightSource: 'surface',
      wireDensity: realBrush.wireDensity ?? 24,
      wireRange: realBrush.wireRange ?? 4.0,
      wireMinDist: realBrush.wireMinDist ?? 0.5,
      pressureEnabled: false,
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

function cleanupScratchResources(realEngine, scratchEngine, scratchChunk) {
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

    // Discard any scratch-sized (128x128) origPool FBOs acquired during phantom Liquify step
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
 * Runs an isolated, non-blocking phantom 1-stroke warmup across all 8 painting tools
 * on a detached 128x128 4-layer scratch canvas. Leaves zero canvas marks, zero undo
 * entries, zero project dirtiness, and zero false PerfMonitor frame drop records.
 */
export async function runPhantomToolsPrewarm(app, { onProgress, shouldAbort } = {}) {
  const realEngine = app?.engine;
  if (!realEngine || app._isPrewarming) return false;

  const isAborted = () => !!(
    shouldAbort?.() ||
    realEngine.isDrawing ||
    app._isSwitchingProject ||
    realEngine._isLoadingProject ||
    realEngine.gpuRenderer?._contextLost
  );

  if (isAborted()) return false;

  const scratchChunk = createDetachedChunk(!!realEngine.gpuRenderer?.supported);
  const gpuProxy = createIsolatedGpuProxy(realEngine.gpuRenderer);
  const scratchEngine = createScratchEngine(realEngine, app, scratchChunk, gpuProxy);

  const p0 = { x: 40, y: 48, size: 28, opacity: 0.85, color: scratchEngine.brush.color, pressure: 0.9 };
  const p1 = { x: 64, y: 56, size: 28, opacity: 0.85, color: scratchEngine.brush.color, pressure: 0.9 };
  const p2 = { x: 88, y: 60, size: 28, opacity: 0.85, color: scratchEngine.brush.color, pressure: 0.9 };

  const lassoMaskCanvas = document.createElement('canvas');
  lassoMaskCanvas.width = SCRATCH_SIZE;
  lassoMaskCanvas.height = SCRATCH_SIZE;
  const lassoMaskCtx = lassoMaskCanvas.getContext('2d', { willReadFrequently: true });

  const steps = [
    {
      label: 'BRUSH',
      run: () => {
        scratchEngine.brush.type = TOOLS.BRUSH;
        scratchEngine.currentStrokeDirtyChunks.clear();
        scratchEngine.spacingAccumulator = 0;
        _paintOnChunks.call(scratchEngine, p0, p1, 24, 0.85, scratchEngine.brush.color);
        if (scratchChunk.strokeCtx) {
          scratchChunk.ctxs[1].drawImage(scratchChunk.strokeCanvas, 0, 0);
          scratchChunk.strokeCtx.clearRect(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
        }
        scratchChunk.isEmpty[1] = false;
      }
    },
    {
      label: 'WIREFRAME',
      run: () => {
        scratchEngine.brush.type = TOOLS.WIREFRAME;
        scratchEngine.currentStrokeDirtyChunks.clear();
        scratchEngine.strokePoints = [p0, p1, p2];
        startWireframeStroke(scratchEngine, p0);
        paintWireframeMove(scratchEngine, p1);
        paintWireframeMove(scratchEngine, p2);
        endWireframeStroke(scratchEngine);
      }
    },
    {
      label: 'LASSO',
      run: () => {
        scratchEngine.brush.type = TOOLS.LASSO;
        const poly = [
          { x: 24, y: 24 },
          { x: 96, y: 30 },
          { x: 80, y: 96 },
          { x: 30, y: 84 }
        ];
        const norm = normalizeSelectionPath(poly);
        if (lassoMaskCtx && norm) {
          drawSelectionMask(lassoMaskCtx, norm, 0, 0);
          lassoMaskCtx.getImageData(24, 24, 32, 32);
        }
      }
    },
    {
      label: 'SMUDGE',
      run: () => {
        scratchEngine.brush.type = TOOLS.SMUDGE;
        scratchEngine.currentStrokeDirtyChunks.clear();
        seedScratchPaint(scratchChunk, 1);
        warmSmudgeSolver(realEngine);
        const smP0 = { x: 42, y: 54, size: 28, opacity: 0.85, pressure: 0.9 };
        const smP1 = { x: 74, y: 58, size: 28, opacity: 0.85, pressure: 0.9 };
        startSmudgeStroke(scratchEngine, smP0);
        paintSmudgeOnChunks(scratchEngine, [smP0, smP1], new Map([['0,0', { cx: 0, cy: 0, stamps: [smP0, smP1] }]]), 0.85, 0.85, scratchEngine.brush.tip);
        endSmudgeStroke(scratchEngine);
      }
    },
    {
      label: 'ERASER',
      run: () => {
        scratchEngine.brush.type = TOOLS.ERASER;
        scratchEngine.currentStrokeDirtyChunks.clear();
        scratchEngine.spacingAccumulator = 0;
        seedScratchPaint(scratchChunk, 1);
        warmEraserSolver(realEngine);
        startEraserStroke(scratchEngine);
        _paintOnChunks.call(scratchEngine, p0, p1, 24, 0.85, scratchEngine.brush.color);
        endEraserStroke(scratchEngine);
      }
    },
    {
      label: 'LIQUIFY',
      run: () => {
        scratchEngine.brush.type = TOOLS.LIQUIFY;
        scratchEngine.currentStrokeDirtyChunks.clear();
        seedScratchPaint(scratchChunk, 1);
        // Always warm Liquify on realEngine first so origPool keeps real chunk dimensions
        warmLiquifySolver(realEngine);
        const lqP0 = { x: 48, y: 56 };
        const lqP1 = { x: 72, y: 60 };
        startLiquifyStroke(scratchEngine, lqP0);
        paintLiquifyStroke(scratchEngine, lqP0, lqP1, 48, 0.5);
        endLiquifyStroke(scratchEngine);
        flushLiquifyGpuCommits(scratchEngine);
        invalidateLiquifySession(realEngine);
      }
    },
    {
      label: 'FLUID',
      run: () => {
        scratchEngine.brush.type = TOOLS.FLUID;
        scratchEngine.currentStrokeDirtyChunks.clear();
        seedScratchPaint(scratchChunk, 1);
        warmFluidSolver(realEngine);
        startFluidPaintStroke(scratchEngine, p0);
        paintFluidOnChunks(scratchEngine, p0, p1, 32, 0.85, scratchEngine.brush.color, 0.9);
        paintFluidOnChunks(scratchEngine, p1, p2, 32, 0.85, scratchEngine.brush.color, 0.9);
        endFluidPaintStroke(scratchEngine);
      }
    },
    {
      label: 'WATERCOLOR',
      run: () => {
        scratchEngine.brush.type = TOOLS.AIR;
        scratchEngine.currentStrokeDirtyChunks.clear();
        seedScratchPaint(scratchChunk, 1);
        warmAirSolver(realEngine);
        scratchEngine.strokePoints = [p0, p1, p2];
        startAirPaintStroke(scratchEngine);
        paintAirIncrementally(scratchEngine, 1);
        paintAirIncrementally(scratchEngine, 2);
        endAirPaintStroke(scratchEngine);
      }
    },
    {
      label: 'SUMI',
      run: () => {
        scratchEngine.brush.type = TOOLS.SUMI;
        scratchEngine.currentStrokeDirtyChunks.clear();
        seedScratchPaint(scratchChunk, 1);
        warmSumiSolver(realEngine);
        scratchEngine.strokePoints = [p0, p1, p2];
        startSumiPaintStroke(scratchEngine, p0);
        paintSumiMove(scratchEngine, p1, 28, 0.85, scratchEngine.brush.color, 0.9);
        paintSumiMove(scratchEngine, p2, 28, 0.85, scratchEngine.brush.color, 0.9);
        endSumiPaintStroke(scratchEngine);
        cancelSumiStroke(scratchEngine);
      }
    }
  ];

  app._isPrewarming = true;
  app.perfMonitor?.setPrewarmSuppression(true);

  let completed = false;
  try {
    for (let i = 0; i < steps.length; i++) {
      await nextAnimationFrame();
      if (isAborted()) {
        return false;
      }
      const step = steps[i];
      if (typeof onProgress === 'function') {
        onProgress(i + 1, steps.length, step.label);
      }
      step.run();
    }

    // Also pre-warm the active real brush tip color cache at the end
    if (!isAborted() && realEngine.brush?.tip) {
      const bSize = Math.round(realEngine.brush.size || 20);
      const cacheSize = realEngine._getCacheSize(bSize);
      realEngine._updateTipCache(cacheSize, realEngine.brush.airbrush || 0, realEngine.brush.color || '#000000');
    }

    completed = true;
    return true;
  } catch (err) {
    console.warn('Phantom tools prewarm aborted:', err);
    return false;
  } finally {
    lassoMaskCanvas.width = 0;
    lassoMaskCanvas.height = 0;
    cleanupScratchResources(realEngine, scratchEngine, scratchChunk);
    app._isPrewarming = false;
    app.perfMonitor?.setPrewarmSuppression(false);
    if (completed) {
      app.perfMonitor?.resetTiming();
    }
    realEngine.gpuRenderer?.requestRender();
  }
}
