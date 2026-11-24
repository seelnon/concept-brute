import { GpuEraserSolver } from './eraserGpu.js';

const TIP_RES = 128;

let _tipWorkCanvas = null;
let _tipWorkCtx = null;
let _tipSubCanvas = null;
let _tipSubCtx = null;
let _cachedKey = null;
let _cachedHasTip = false;
let _cachedTipVersion = 0;

function getGpuEraserSolver(engine) {
  const gr = engine && engine.gpuRenderer;
  if (!gr || !gr.supported || gr._contextLost || !gr.gl || gr.gl.isContextLost()) return null;
  if (!gr.eraserSolver) {
    gr.eraserSolver = new GpuEraserSolver(gr);
  }
  return gr.eraserSolver.ready ? gr.eraserSolver : null;
}

function getEffectiveEraserTip(tip, airbrush = 0, sharpen = 0) {
  if (!tip || (tip.width || tip.naturalWidth || 0) <= 0) {
    return { canvas: null, key: 'none' };
  }

  const ab = Math.max(0, Math.min(1, airbrush || 0));
  const sh = Math.max(0, Math.min(1, sharpen || 0));
  const tipVer = tip._tipVersion || 0;

  // Fast path: raw tip without CPU blur/sharpen filter needs zero intermediate Canvas2D copy
  if (ab <= 0.005 && sh <= 0.005) {
    return {
      canvas: tip,
      key: tip,
      version: `raw_${tipVer}`
    };
  }

  const abBucket = Math.round(ab * 100);
  const shBucket = Math.round(sh * 100);
  if (
    _tipWorkCanvas &&
    _cachedHasTip &&
    _cachedKey &&
    _cachedKey.tip === tip &&
    _cachedKey.tipVer === tipVer &&
    _cachedKey.ab === abBucket &&
    _cachedKey.sh === shBucket
  ) {
    return {
      canvas: _tipWorkCanvas,
      key: `fx_${_cachedTipVersion}`
    };
  }

  if (!_tipWorkCanvas) {
    _tipWorkCanvas = document.createElement('canvas');
    _tipWorkCanvas.width = TIP_RES;
    _tipWorkCanvas.height = TIP_RES;
    _tipWorkCtx = _tipWorkCanvas.getContext('2d', { alpha: true });
  }

  const ctx = _tipWorkCtx;
  const blur = ab * TIP_RES * 0.45;
  const scale = 1.0 / (1.0 + ab * 1.5);
  const dSize = Math.max(1, Math.round(TIP_RES * scale));
  const pad = (TIP_RES - dSize) * 0.5;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const supportsFilters = typeof ctx.filter !== 'undefined' && !isIOS && !isSafari;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, TIP_RES, TIP_RES);

  if (ab > 0.005 && blur > 0) {
    if (!_tipSubCanvas) {
      _tipSubCanvas = document.createElement('canvas');
      _tipSubCtx = _tipSubCanvas.getContext('2d', { alpha: true });
    }
    if (_tipSubCanvas.width !== dSize || _tipSubCanvas.height !== dSize) {
      _tipSubCanvas.width = dSize;
      _tipSubCanvas.height = dSize;
    }
    const sCtx = _tipSubCtx;
    sCtx.save();
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
    sCtx.clearRect(0, 0, dSize, dSize);
    sCtx.drawImage(tip, 0, 0, dSize, dSize);
    sCtx.globalCompositeOperation = 'source-in';
    sCtx.fillStyle = '#000000';
    sCtx.fillRect(0, 0, dSize, dSize);
    sCtx.restore();

    if (supportsFilters) {
      ctx.filter = `blur(${blur.toFixed(2)}px)`;
      ctx.drawImage(_tipSubCanvas, pad, pad);
    } else {
      ctx.shadowBlur = blur;
      ctx.shadowColor = '#000000';
      ctx.shadowOffsetX = TIP_RES;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(_tipSubCanvas, pad - TIP_RES, pad);
    }
    ctx.filter = 'none';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, TIP_RES, TIP_RES);
  } else {
    if (sh > 0.005 && supportsFilters) {
      ctx.filter = `contrast(${100 + sh * 900}%)`;
    }
    ctx.drawImage(tip, pad, pad, dSize, dSize);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, TIP_RES, TIP_RES);
  }
  ctx.restore();

  _cachedKey = { tip, tipVer, ab: abBucket, sh: shBucket };
  _cachedHasTip = true;
  _cachedTipVersion++;
  return {
    canvas: _tipWorkCanvas,
    key: `fx_${_cachedTipVersion}`
  };
}

function resolveTipUploadKey(eff) {
  if (!eff || !eff.canvas) return null;
  if (typeof eff.key === 'string') return eff.key;
  // Raw tip: combine tip object reference identity on solver via version string + size + _tipVersion
  if (!eff.canvas._eraserGpuId) {
    eff.canvas._eraserGpuId = ++_cachedTipVersion;
  }
  return `raw_${eff.canvas._eraserGpuId}_${eff.canvas._tipVersion || 0}`;
}

export function warmEraserSolver(engine) {
  if (!engine) return null;
  const solver = getGpuEraserSolver(engine);
  if (!solver) return null;
  const b = engine.brush || {};
  const eff = getEffectiveEraserTip(b.tip, b.airbrush || 0, b.brushSharpen || 0);
  const tipKey = eff.canvas ? resolveTipUploadKey(eff) : null;
  solver.prewarmPipelines(eff.canvas, tipKey);
  return solver;
}

export function startEraserStroke(engine) {
  if (!engine) return false;
  engine.useGpuEraser = false;
  engine._eraserBatchDepth = 0;
  engine._eraserPendingStamps = null;
  engine._eraserPendingFlow = 1.0;

  const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
  if (engine.activeLayer === 0 || (layerSet && layerSet.alphaLock)) {
    return false;
  }

  const solver = getGpuEraserSolver(engine);
  if (solver && solver.beginStroke()) {
    engine.useGpuEraser = true;
    return true;
  }
  return false;
}

export function beginEraserBatch(engine) {
  if (!engine || !engine.useGpuEraser) return;
  engine._eraserBatchDepth = (engine._eraserBatchDepth || 0) + 1;
  if (!engine._eraserPendingStamps) {
    engine._eraserPendingStamps = [];
  } else {
    engine._eraserPendingStamps.length = 0;
  }
}

export function flushEraserBatch(engine) {
  if (!engine || !engine.useGpuEraser) return;
  if ((engine._eraserBatchDepth || 0) > 0) {
    engine._eraserBatchDepth--;
  }
  if (engine._eraserBatchDepth > 0) return;

  const pending = engine._eraserPendingStamps;
  if (!pending || pending.length === 0) return;

  const solver = getGpuEraserSolver(engine);
  if (solver && solver.active) {
    const b = engine.brush || {};
    const brushOpac = b.opacity !== undefined ? b.opacity : 1.0;
    const eff = getEffectiveEraserTip(b.tip, b.airbrush || 0, b.brushSharpen || 0);
    const tipKey = eff.canvas ? resolveTipUploadKey(eff) : null;
    solver.stepStamps(engine, pending, engine._eraserPendingFlow, brushOpac, eff.canvas, tipKey);
  }
  pending.length = 0;
}

export function paintEraserOnChunks(engine, stamps, flow) {
  if (!engine || !stamps || stamps.length === 0) return false;

  const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
  if (engine.activeLayer === 0 || (layerSet && layerSet.alphaLock)) {
    return true;
  }

  if (!engine.useGpuEraser) return false;
  const solver = getGpuEraserSolver(engine);
  if (!solver || !solver.active) {
    engine.useGpuEraser = false;
    return false;
  }

  if ((engine._eraserBatchDepth || 0) > 0 && engine._eraserPendingStamps) {
    engine._eraserPendingFlow = flow;
    const pending = engine._eraserPendingStamps;
    for (let i = 0; i < stamps.length; i++) {
      pending.push(stamps[i]);
    }
    return true;
  }

  const b = engine.brush || {};
  const brushOpac = b.opacity !== undefined ? b.opacity : 1.0;
  const eff = getEffectiveEraserTip(b.tip, b.airbrush || 0, b.brushSharpen || 0);
  const tipKey = eff.canvas ? resolveTipUploadKey(eff) : null;
  solver.stepStamps(engine, stamps, flow, brushOpac, eff.canvas, tipKey);
  return true;
}

export function endEraserStroke(engine) {
  if (!engine) return;
  if ((engine._eraserBatchDepth || 0) > 0) {
    engine._eraserBatchDepth = 0;
    flushEraserBatch(engine);
  }
  if (engine._eraserPendingStamps) {
    engine._eraserPendingStamps.length = 0;
    engine._eraserPendingStamps = null;
  }
  if (engine.useGpuEraser) {
    const solver = engine.gpuRenderer && engine.gpuRenderer.eraserSolver;
    if (solver) {
      solver.endStroke(engine);
    }
    engine.useGpuEraser = false;
  }
}

export function cancelEraserStroke(engine) {
  if (!engine) return;
  engine._eraserBatchDepth = 0;
  if (engine._eraserPendingStamps) {
    engine._eraserPendingStamps.length = 0;
    engine._eraserPendingStamps = null;
  }
  if (engine.useGpuEraser) {
    const solver = engine.gpuRenderer && engine.gpuRenderer.eraserSolver;
    if (solver && typeof solver.cancel === 'function') {
      solver.cancel(engine);
    }
    engine.useGpuEraser = false;
  }
}

export function flushEraserCaches(engine = null) {
  cancelEraserStroke(engine);
  _cachedKey = null;
  _cachedHasTip = false;
  if (_tipWorkCanvas) {
    _tipWorkCanvas.width = 0;
    _tipWorkCanvas.height = 0;
    _tipWorkCanvas = null;
    _tipWorkCtx = null;
  }
  if (_tipSubCanvas) {
    _tipSubCanvas.width = 0;
    _tipSubCanvas.height = 0;
    _tipSubCanvas = null;
    _tipSubCtx = null;
  }
}
