// Performance Watchdog & Frame Drop Profiler
// Designed for zero overhead during smooth 60fps painting.

export class PerfMonitor {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.enabled = false;
    this.paintOnly = true; // Focus on painting & user actions
    this.autoOpenOnDrop = false;
    this._prewarmSuppressed = false;

    // Strict 59 FPS threshold: 1000 / 59 = ~16.949ms
    // If a frame takes >= 16.95ms, it has dropped below 60fps!
    this.thresholdMs = 16.95; 

    // Runtime state (plain variables for nanosecond performance)
    this.lastFrameTime = performance.now();
    this.currentFps = 60.0;
    this.minFps = 60.0;
    this.avgFps = 60.0;
    this.fpsHistory = [];
    this.dropsCount = 0;
    this.records = []; // History of drop events

    // Lightweight breadcrumb markers (assigned in nanoseconds)
    this.currentPhase = 'idle';
    this.phaseStartTime = performance.now();
    this.phaseDetails = null;

    this.lastToolChangeTime = null;
    this.lastTool = 'brush';
    this.prevTool = null;

    this.lastStrokeStartTime = null;
    this.strokePointsCount = 0;
    this.lastInteractionTime = performance.now();

    // Zero-allocation per-frame Stroke Init instrumentation accumulators (reset every rAF)
    this.strokeInitStats = {
      tool: '',
      pointerType: '',
      flushGpuMs: 0,
      mousePosMs: 0,
      pressureMs: 0,
      tipCacheMs: 0,
      backupMs: 0,
      toolStartMs: 0,
      redoClearMs: 0,
      totalMs: 0,
      chunksBackedUp: 0,
      backupBytes: 0,
      isStatic: false,
      canvasDim: ''
    };

    // Zero-allocation per-frame Sumi-e instrumentation accumulators (reset every rAF)
    this.sumiFrameStats = {
      beginMs: 0,
      tuftMs: 0,
      backupMs: 0,
      backupMode: '',
      backupBytes: 0,
      tileEnsureMs: 0,
      tilesCreated: 0,
      tilesEvicted: 0,
      subBakeMs: 0,
      subBakedCount: 0,
      assembleMs: 0,
      physicsMs: 0,
      compositeMs: 0,
      storeBlitMs: 0,
      stampMs: 0,
      stampMoves: 0,
      stampBoxes: 0,
      stampSegs: 0,
      simMs: 0,
      simClusters: 0,
      simBoxes: 0,
      retireDryBoxes: 0,
      syncMs: 0,
      syncTiles: 0,
      probeMs: 0,
      gpuRenderMs: 0,
      previewMs: 0,
      activeTiles: 0,
      wetTiles: 0,
      passiveTiles: 0,
      inFlightSyncs: 0,
      inFlightBackups: 0,
      retireQueue: 0,
      canvasDim: '',
      isStatic: false,
      zoom: 1,
      quality: 2
    };

    // UI throttler: update DOM only 5 times a second to ensure 0 lag from profiler itself
    this.lastUiUpdateTime = 0;
    this.uiUpdateInterval = 180; // ms
    this.frameWorkMs = 0;
    this.frameWorkLabel = '';
    this._frameWorkPeakMs = 0;

    // Animation frame handle
    this.rafId = null;
    this.isWindowOpen = false;

    this._lastFocusTime = performance.now();
    this._resumeTimer = null;

    // Pause rAF loop completely when blurred/hidden and resume smoothly on focus return
    this._onFocus = () => {
      this._lastFocusTime = performance.now();
      this.resetTiming();
      if (this._resumeTimer) clearTimeout(this._resumeTimer);
      this._resumeTimer = setTimeout(() => {
        this._resumeTimer = null;
        if (!document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus())) {
          this.resetTiming();
          this.start();
        }
      }, 160);
    };
    this._onBlur = () => {
      if (this._resumeTimer) {
        clearTimeout(this._resumeTimer);
        this._resumeTimer = null;
      }
      this.stop();
    };
    this._onVisibilityChange = () => {
      if (document.hidden) {
        this._onBlur();
      } else {
        this._onFocus();
      }
    };

    window.addEventListener('focus', this._onFocus);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._initUI();
    this.start();
  }

  _resetStrokeInitStats() {
    const s = this.strokeInitStats;
    s.tool = '';
    s.pointerType = '';
    s.flushGpuMs = 0;
    s.mousePosMs = 0;
    s.pressureMs = 0;
    s.tipCacheMs = 0;
    s.backupMs = 0;
    s.toolStartMs = 0;
    s.redoClearMs = 0;
    s.totalMs = 0;
    s.chunksBackedUp = 0;
    s.backupBytes = 0;
    s.isStatic = false;
    s.canvasDim = '';
  }

  _resetSumiFrameStats() {
    const s = this.sumiFrameStats;
    s.beginMs = 0;
    s.tuftMs = 0;
    s.backupMs = 0;
    s.backupMode = '';
    s.backupBytes = 0;
    s.tileEnsureMs = 0;
    s.tilesCreated = 0;
    s.tilesEvicted = 0;
    s.subBakeMs = 0;
    s.subBakedCount = 0;
    s.assembleMs = 0;
    s.physicsMs = 0;
    s.compositeMs = 0;
    s.storeBlitMs = 0;
    s.stampMs = 0;
    s.stampMoves = 0;
    s.stampBoxes = 0;
    s.stampSegs = 0;
    s.simMs = 0;
    s.simClusters = 0;
    s.simBoxes = 0;
    s.retireDryBoxes = 0;
    s.syncMs = 0;
    s.syncTiles = 0;
    s.probeMs = 0;
    s.gpuRenderMs = 0;
    s.previewMs = 0;
    s.activeTiles = 0;
    s.wetTiles = 0;
    s.passiveTiles = 0;
    s.inFlightSyncs = 0;
    s.inFlightBackups = 0;
    s.retireQueue = 0;
  }

  _resetFrameWorkStats() {
    this.frameWorkMs = 0;
    this.frameWorkLabel = '';
    this._frameWorkPeakMs = 0;
  }

  recordWork(ms, label = '') {
    if (!this.enabled || !Number.isFinite(ms) || ms <= 0) return;
    this.frameWorkMs += ms;
    if (label && ms > this._frameWorkPeakMs) {
      this._frameWorkPeakMs = ms;
      this.frameWorkLabel = label;
    }
  }

  resetTiming() {
    this.lastFrameTime = performance.now();
    this.fpsHistory.length = 0;
    this._resetStrokeInitStats();
    this._resetSumiFrameStats();
    this._resetFrameWorkStats();
  }

  markInteraction() {
    this.lastInteractionTime = performance.now();
  }

  markToolChange(tool, prevTool = null) {
    this.lastToolChangeTime = performance.now();
    this.prevTool = prevTool || this.lastTool;
    this.lastTool = tool;
    this.currentPhase = 'tool_change';
    this.phaseStartTime = this.lastToolChangeTime;
    this.phaseDetails = { tool, prevTool: this.prevTool };
    this.lastInteractionTime = this.lastToolChangeTime;

    // Reset currentPhase back to 'idle' after tool switch completes so it doesn't linger forever
    setTimeout(() => {
      if (this.currentPhase === 'tool_change') {
        this.currentPhase = 'idle';
      }
    }, 60);
  }

  markStrokeStart(tool) {
    this.lastStrokeStartTime = performance.now();
    this.strokePointsCount = 1;
    this.currentPhase = 'stroke_init';
    this.phaseStartTime = this.lastStrokeStartTime;
    this.phaseDetails = { tool };
    this.lastInteractionTime = this.lastStrokeStartTime;
  }

  markStrokeEnd() {
    this.lastStrokeEndTime = performance.now();
    this.currentPhase = 'idle';
    this.phaseDetails = null;
  }

  markPhase(phase, details = null) {
    this.currentPhase = phase;
    this.phaseStartTime = performance.now();
    this.phaseDetails = details;
    if (details && details.strokePointsCount !== undefined) {
      this.strokePointsCount = details.strokePointsCount;
    }
  }

  setPrewarmSuppression(flag) {
    this._prewarmSuppressed = !!flag;
    if (!this._prewarmSuppressed) {
      this.resetTiming();
    }
  }

  isSavingActive() {
    return !!(
      this.app && 
      (this.app._isSavingProject || 
       this.app._isSaving || 
       (this.app.storage && this.app.storage.isSaving))
    );
  }

  isMonitoringEligible(now) {
    if (!this.enabled) return false;
    if (this._prewarmSuppressed || (this.app && this.app._isPrewarming)) return false;
    if (this.isSavingActive()) return false; // Strictly skip checks during saving
    if (document.hidden) return false; // Ignore browser background tab throttling
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false; // Ignore blurred window
    if ((now - (this._lastFocusTime || 0)) < 400) return false; // Allow compositor wake-up settle after Alt-Tab

    if (this.paintOnly) {
      // Must be actively painting on canvas, within 70ms of stroke commit, or stepping live Sumi fluid sim
      const isDrawing = !!(this.engine && this.engine.isDrawing);
      const isFinishingStroke = (now - (this.lastStrokeEndTime || 0)) < 70;
      const sumi = this.engine && this.engine.gpuRenderer && this.engine.gpuRenderer.sumiSolver;
      const isLiveSumiSim = !!(
        (this.currentPhase === 'sumi_sim' || this.currentPhase === 'sumi_end') &&
        sumi &&
        sumi.active &&
        (
          (sumi.simActiveFrames > 0 && (sumi._activeWetCount > 0 || (sumi.activeTiles && sumi.activeTiles.size > 0))) ||
          (typeof sumi.hasPendingSyncs === 'function' && sumi.hasPendingSyncs())
        )
      );
      if (!isDrawing && !isFinishingStroke && !isLiveSumiSim) return false;
    }

    // Idle phase has no active engine rendering; ignore OS/browser power-saving rAF jitter
    if (this.currentPhase === 'idle') return false;

    return true;
  }

  start() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.lastFrameTime = performance.now();
    
    const loop = (time) => {
      if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) {
        this.rafId = null;
        return;
      }
      this._checkFrame(time);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _checkFrame(now) {
    if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) {
      this.lastFrameTime = now;
      this._resetStrokeInitStats();
      this._resetSumiFrameStats();
      return;
    }

    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Discard spikes from background tab reactivation or device sleep (> 250ms)
    if (dt > 250) {
      this.fpsHistory.length = 0;
      this._resetStrokeInitStats();
      this._resetSumiFrameStats();
      this._resetFrameWorkStats();
      return;
    }

    const instantFps = Math.min(120, Math.max(1, 1000 / dt));
    this.currentFps = instantFps;

    // Rolling 60-frame history for average calculation
    this.fpsHistory.push(instantFps);
    if (this.fpsHistory.length > 60) this.fpsHistory.shift();

    let sum = 0;
    for (let i = 0; i < this.fpsHistory.length; i++) sum += this.fpsHistory[i];
    this.avgFps = sum / this.fpsHistory.length;

    const eligible = this.isMonitoringEligible(now);
    if (instantFps < this.minFps && eligible) {
      this.minFps = instantFps;
    }

    // Check for FPS drop below threshold
    if (dt > this.thresholdMs && eligible) {
      this._recordDrop(dt, instantFps, now);
    }

    this._resetStrokeInitStats();
    this._resetSumiFrameStats();
    this._resetFrameWorkStats();

    // Throttled UI refresh so the profiler itself uses 0.0% CPU
    if (now - this.lastUiUpdateTime > this.uiUpdateInterval) {
      this.lastUiUpdateTime = now;
      if (this.isWindowOpen) {
        this._updateUIStats();
      }
    }
  }

  _snapshotStrokeInitStats() {
    const s = this.strokeInitStats;
    if (!s || (!s.totalMs && !s.flushGpuMs && !s.toolStartMs && !s.backupMs && !s.tipCacheMs)) {
      return null;
    }
    const r = (v) => Math.round(v * 100) / 100;
    const out = {
      totalMs: r(s.totalMs),
      tool: s.tool || this.lastTool,
      pointerType: s.pointerType || '',
      isStatic: !!s.isStatic,
      canvasDim: s.canvasDim || ''
    };
    if (s.flushGpuMs > 0.01) out.flushGpuMs = r(s.flushGpuMs);
    if (s.mousePosMs > 0.01) out.mousePosMs = r(s.mousePosMs);
    if (s.pressureMs > 0.01) out.pressureMs = r(s.pressureMs);
    if (s.tipCacheMs > 0.01) out.tipCacheMs = r(s.tipCacheMs);
    if (s.backupMs > 0.01) out.backupMs = r(s.backupMs);
    if (s.toolStartMs > 0.01) out.toolStartMs = r(s.toolStartMs);
    if (s.redoClearMs > 0.01) out.redoClearMs = r(s.redoClearMs);
    if (s.chunksBackedUp > 0) out.chunksBackedUp = s.chunksBackedUp;
    if (s.backupBytes > 0) out.backupMB = Math.round((s.backupBytes / (1024 * 1024)) * 100) / 100;
    return out;
  }

  _snapshotSumiFrameStats(activeTool, phase) {
    const s = this.sumiFrameStats;
    const hasActivity = (
      s.beginMs > 0 || s.tuftMs > 0 || s.backupMs > 0 || s.tileEnsureMs > 0 ||
      s.subBakeMs > 0 || s.assembleMs > 0 || s.physicsMs > 0 || s.compositeMs > 0 ||
      s.storeBlitMs > 0 || s.stampMs > 0 || s.simMs > 0 || s.syncMs > 0 ||
      s.probeMs > 0 || s.previewMs > 0 || s.tilesCreated > 0 || s.tilesEvicted > 0 ||
      s.simBoxes > 0 || s.stampBoxes > 0
    );
    if (!hasActivity && activeTool !== 'sumi' && !(phase && phase.startsWith('sumi'))) {
      return null;
    }
    const r = (v) => Math.round(v * 100) / 100;
    const out = {
      canvasDim: s.canvasDim || '',
      isStatic: !!s.isStatic,
      zoom: Math.round((s.zoom || 1) * 1000) / 1000,
      quality: s.quality || 2,
      activeTiles: s.activeTiles,
      wetTiles: s.wetTiles,
      passiveTiles: s.passiveTiles
    };
    if (s.beginMs > 0.01) out.beginMs = r(s.beginMs);
    if (s.tuftMs > 0.01) out.tuftMs = r(s.tuftMs);
    if (s.backupMs > 0.01) out.backupMs = r(s.backupMs);
    if (s.backupMode) out.backupMode = s.backupMode;
    if (s.backupBytes > 0) out.backupMB = Math.round((s.backupBytes / (1024 * 1024)) * 100) / 100;
    if (s.tileEnsureMs > 0.01) out.tileEnsureMs = r(s.tileEnsureMs);
    if (s.tilesCreated > 0) out.tilesCreated = s.tilesCreated;
    if (s.tilesEvicted > 0) out.tilesEvicted = s.tilesEvicted;
    if (s.subBakeMs > 0.01) out.subBakeMs = r(s.subBakeMs);
    if (s.subBakedCount > 0) out.subBakedCount = s.subBakedCount;
    if (s.assembleMs > 0.01) out.assembleMs = r(s.assembleMs);
    if (s.physicsMs > 0.01) out.physicsMs = r(s.physicsMs);
    if (s.compositeMs > 0.01) out.compositeMs = r(s.compositeMs);
    if (s.storeBlitMs > 0.01) out.storeBlitMs = r(s.storeBlitMs);
    if (s.stampMs > 0.01) out.stampMs = r(s.stampMs);
    if (s.stampMoves > 0) out.stampMoves = s.stampMoves;
    if (s.stampBoxes > 0) out.stampBoxes = s.stampBoxes;
    if (s.stampSegs > 0) out.stampSegs = s.stampSegs;
    if (s.simMs > 0.01) out.simMs = r(s.simMs);
    if (s.simClusters > 0) out.simClusters = s.simClusters;
    if (s.simBoxes > 0) out.simBoxes = s.simBoxes;
    if (s.retireDryBoxes > 0) out.retireDryBoxes = s.retireDryBoxes;
    if (s.syncMs > 0.01) out.syncMs = r(s.syncMs);
    if (s.syncTiles > 0) out.syncTiles = s.syncTiles;
    if (s.probeMs > 0.01) out.probeMs = r(s.probeMs);
    if (s.gpuRenderMs > 0.01) out.gpuRenderMs = r(s.gpuRenderMs);
    if (s.previewMs > 0.01) out.previewMs = r(s.previewMs);
    if (s.inFlightSyncs > 0) out.inFlightSyncs = s.inFlightSyncs;
    if (s.inFlightBackups > 0) out.inFlightBackups = s.inFlightBackups;
    if (s.retireQueue > 0) out.retireQueue = s.retireQueue;
    return out;
  }

  _buildBreakdownLine(si, ss) {
    const parts = [];
    if (si) {
      const steps = [
        ['total', si.totalMs],
        ['flush', si.flushGpuMs],
        ['tipCache', si.tipCacheMs],
        ['backup', si.backupMs],
        ['toolStart', si.toolStartMs],
        ['redo', si.redoClearMs]
      ];
      for (let i = 0; i < steps.length; i++) {
        if ((steps[i][1] || 0) >= 0.3) parts.push(`${steps[i][0]}:${steps[i][1].toFixed(1)}ms`);
      }
      if (si.backupMB) parts.push(`bak:${si.backupMB.toFixed(1)}MB`);
    }
    if (ss) {
      const steps = [
        ['tuft', ss.tuftMs],
        ['begin', ss.beginMs],
        ['ensure', ss.tileEnsureMs],
        ['subBake', ss.subBakeMs],
        ['sumiBak', ss.backupMs],
        ['stamp', ss.stampMs],
        ['sim', ss.simMs],
        ['asm', ss.assembleMs],
        ['phys', ss.physicsMs],
        ['comp', ss.compositeMs],
        ['blit', ss.storeBlitMs],
        ['sync', ss.syncMs],
        ['gpuRend', ss.gpuRenderMs],
        ['prev', ss.previewMs]
      ];
      for (let i = 0; i < steps.length; i++) {
        if ((steps[i][1] || 0) >= 0.3) parts.push(`${steps[i][0]}:${steps[i][1].toFixed(1)}ms`);
      }
      if (ss.backupMode) parts.push(`bakMode:${ss.backupMode}`);
      if (ss.backupMB) parts.push(`bak:${ss.backupMB.toFixed(1)}MB`);
      if (ss.tilesCreated) parts.push(`+tiles:${ss.tilesCreated}`);
      if (ss.tilesEvicted) parts.push(`evict:${ss.tilesEvicted}`);
      if (ss.stampBoxes) parts.push(`stmpBox:${ss.stampBoxes}`);
      if (ss.simBoxes) parts.push(`simBox:${ss.simBoxes}`);
      if (ss.retireDryBoxes) parts.push(`retBox:${ss.retireDryBoxes}`);
      if (ss.syncTiles) parts.push(`syncT:${ss.syncTiles}`);
      parts.push(`T:${ss.wetTiles}/${ss.activeTiles} z:${Math.round((ss.zoom || 1) * 100)}% q:${ss.quality}`);
    }
    return parts.join(' | ');
  }

  _recordDrop(dt, instantFps, now) {
    this.dropsCount++;

    const timeSinceTool = this.lastToolChangeTime ? (now - this.lastToolChangeTime) : null;
    const timeSinceStroke = this.lastStrokeStartTime ? (now - this.lastStrokeStartTime) : null;
    const activeTool = (this.engine && this.engine.brush) ? this.engine.brush.type : (this.lastTool || 'unknown');
    const activeLayer = this.engine ? this.engine.activeLayer : 1;

    const strokeInitSnap = this._snapshotStrokeInitStats();
    const sumiSnap = this._snapshotSumiFrameStats(activeTool, this.currentPhase);
    const frameWorkMs = this.frameWorkMs || 0;
    const frameWorkLabel = this.frameWorkLabel || '';
    const sumiMeasured = sumiSnap
      ? ((sumiSnap.beginMs || 0) + (sumiSnap.tuftMs || 0) + (sumiSnap.backupMs || 0) + (sumiSnap.tileEnsureMs || 0) +
         (sumiSnap.subBakeMs || 0) + (sumiSnap.assembleMs || 0) + (sumiSnap.physicsMs || 0) + (sumiSnap.compositeMs || 0) +
         (sumiSnap.storeBlitMs || 0) + (sumiSnap.stampMs || 0) + (sumiSnap.simMs || 0) + (sumiSnap.syncMs || 0) +
         (sumiSnap.probeMs || 0) + (sumiSnap.gpuRenderMs || 0) + (sumiSnap.previewMs || 0))
      : 0;
    const engineWorkMs = Math.max(frameWorkMs, strokeInitSnap?.totalMs || 0, sumiMeasured);

    let breakdown = this._buildBreakdownLine(strokeInitSnap, sumiSnap);
    if (frameWorkMs >= 0.05) {
      const engTag = `eng:${engineWorkMs.toFixed(1)}ms${frameWorkLabel ? '(' + frameWorkLabel + ')' : ''}`;
      breakdown = breakdown ? `${engTag} | ${breakdown}` : engTag;
    }

    const diagnosis = this._diagnoseCause(
      dt,
      this.currentPhase,
      this.phaseDetails,
      timeSinceStroke,
      timeSinceTool,
      activeTool,
      strokeInitSnap,
      sumiSnap,
      breakdown,
      engineWorkMs
    );

    const record = {
      id: Date.now() + Math.random(),
      time: new Date(),
      timeString: new Date().toTimeString().split(' ')[0] + '.' + String(Math.floor(now % 1000)).padStart(3, '0'),
      dt: dt.toFixed(1),
      fps: instantFps.toFixed(1),
      engineMs: Number(engineWorkMs.toFixed(2)),
      phase: this.currentPhase,
      category: diagnosis.category,
      title: diagnosis.title,
      description: diagnosis.description,
      details: diagnosis.details,
      tool: activeTool,
      layer: activeLayer,
      timeSinceTool: timeSinceTool !== null ? Math.round(timeSinceTool) : null,
      timeSinceStroke: timeSinceStroke !== null ? Math.round(timeSinceStroke) : null
    };
    if (breakdown) record.breakdown = breakdown;
    if (strokeInitSnap) record.strokeInitStats = strokeInitSnap;
    if (sumiSnap) record.sumiStats = sumiSnap;

    this.records.unshift(record);
    if (this.records.length > 80) this.records.pop();

    if (this.autoOpenOnDrop && !this.isWindowOpen) {
      this.show();
    }

    if (this.isWindowOpen) {
      this._appendRecordToUI(record);
      this._updateUIStats();
      this._flashAlert(record);
    }
  }

  _diagnoseCause(dt, phase, details, timeSinceStroke, timeSinceTool, activeTool, si = null, ss = null, breakdown = '', engineWorkMs = 0) {
    details = details || {};
    const isVeryEarlyInStroke = timeSinceStroke !== null && timeSinceStroke < 80;
    const isRightAfterTool = timeSinceTool !== null && timeSinceTool < 350;
    const bdSuffix = breakdown ? ` [${breakdown}]` : '';

    // 0. Detect external browser/OS/GPU wakeup stalls when measured engine CPU/GPU submit work was tiny
    const hasInstrumentation = !!(si || ss || engineWorkMs > 0);
    const isZeroTileSumi = !!(ss && !ss.activeTiles && !ss.wetTiles && !ss.simBoxes && !ss.stampBoxes && !ss.backupMs);
    if (!details.simulated && dt >= 22.0 && ((hasInstrumentation && engineWorkMs < 3.0) || isZeroTileSumi)) {
      return {
        category: 'BROWSER / GPU WAKEUP',
        title: `Browser/driver stall (${dt.toFixed(1)}ms; engine ${engineWorkMs.toFixed(1)}ms)`,
        description: `Frame waited ${dt.toFixed(1)}ms while engine CPU/GPU submit work took only ${engineWorkMs.toFixed(1)}ms.`,
        details: `Likely compositor wake, Windows Ink/tablet sync, GPU clock ramp, or GC pause after idle. Phase: ${phase} | Tool: ${activeTool}.${bdSuffix}`
      };
    }

    // 1. Tool change transition
    if (isRightAfterTool || phase === 'tool_change') {
      return {
        category: 'TOOL CHANGE',
        title: `Engine after tool change (${activeTool})`,
        description: `Frame hitch of ${dt.toFixed(1)}ms (${(1000 / dt).toFixed(0)} FPS) occurred right after switching tools.`,
        details: `Switched from ${this.prevTool || 'prev'} to ${activeTool} ${timeSinceTool !== null ? timeSinceTool : 0}ms ago.${bdSuffix}`
      };
    }

    // 2. Stroke initialisation (pointerdown setup / chunk backup / tile init)
    if ((phase === 'stroke_init' && (timeSinceStroke === null || timeSinceStroke < 90)) || (si && si.totalMs > 8 && isVeryEarlyInStroke)) {
      let dominant = 'tip/backup setup';
      if (ss && ss.backupMs >= 4) {
        dominant = `GPU backup (${ss.backupMode || 'readback'} ${(ss.backupMB || 0).toFixed(1)}MB in ${ss.backupMs.toFixed(1)}ms)`;
      } else if (ss && ss.tileEnsureMs >= 4) {
        dominant = `tile init (${ss.tilesCreated || 0} created, ${ss.tileEnsureMs.toFixed(1)}ms)`;
      } else if (si && si.backupMs >= 4) {
        dominant = `chunk snapshot (${si.backupMs.toFixed(1)}ms)`;
      } else if (si && si.flushGpuMs >= 4) {
        dominant = `GPU flush (${si.flushGpuMs.toFixed(1)}ms)`;
      } else if (si && si.tipCacheMs >= 4) {
        dominant = `tip cache (${si.tipCacheMs.toFixed(1)}ms)`;
      } else if (ss && ss.beginMs >= 4) {
        dominant = `Sumi session switch/flush (${ss.beginMs.toFixed(1)}ms)`;
      }
      return {
        category: 'STROKE INIT',
        title: `Stroke init (${activeTool}): ${dominant}`,
        description: `Pointerdown initialization stalled for ${(si?.totalMs || dt).toFixed(1)}ms.`,
        details: `Tool: ${activeTool} | ptr: ${si?.pointerType || '?'} | canvas: ${si?.canvasDim || ss?.canvasDim || '?'}.${bdSuffix}`
      };
    }

    // 3. First stamp calculation
    if (phase === 'first_stamp' || (isVeryEarlyInStroke && phase === 'chunk_paint') || (this.strokePointsCount <= 2 && phase === 'chunk_paint')) {
      return {
        category: '1ST STAMP',
        title: `1st stamp calculation & dynamic speed modulation`,
        description: `Recalibrating initial stamp parameters to match stroke speed and pressure ramp.`,
        details: `Evaluated point 1 to point 2 ramp. Dynamic scale and opacity recalculation for initial segment.${bdSuffix}`
      };
    }

    // 3b. Sumi-e phases (interactive stamping, live Navier-Stokes bleed sim, stroke end sync)
    if (phase === 'sumi_stamp' || phase === 'sumi_sim' || phase === 'sumi_end' || (activeTool === 'sumi' && ss)) {
      const cat = phase === 'sumi_sim' ? 'SUMI SIM' : (phase === 'sumi_end' ? 'SUMI END' : 'SUMI STAMP');
      let driver = `WorkBox (${ss?.simBoxes || ss?.stampBoxes || 0} boxes)`;
      if (ss) {
        if (ss.tilesEvicted > 0) {
          driver = `LRU tile eviction (${ss.tilesEvicted} evicted, sync readback)`;
        } else if (ss.backupMs >= 5) {
          driver = `chunk backup (${ss.backupMode || ''} ${(ss.backupMB || 0).toFixed(1)}MB in ${ss.backupMs.toFixed(1)}ms)`;
        } else if ((ss.retireDryBoxes || 0) >= 3) {
          driver = `retire-dry queue (${ss.retireDryBoxes} boxes on ${ss.wetTiles}/${ss.activeTiles} tiles)`;
        } else if ((ss.simBoxes || 0) >= 4 || (ss.stampBoxes || 0) >= 3) {
          driver = `multi-box zoomed sweep (${ss.simBoxes || 0} sim / ${ss.stampBoxes || 0} stamp boxes @ ${Math.round((ss.zoom || 1) * 100)}%)`;
        } else if ((ss.syncMs || 0) >= 5) {
          driver = `CPU chunk readback (${ss.syncTiles || 0} tiles in ${ss.syncMs.toFixed(1)}ms)`;
        } else if ((ss.tilesCreated || 0) >= 4) {
          driver = `cold tile allocation (${ss.tilesCreated} tiles in ${(ss.tileEnsureMs || 0).toFixed(1)}ms)`;
        }
      }
      return {
        category: cat,
        title: `${cat}: ${driver}`,
        description: `Frame took ${dt.toFixed(1)}ms (${(1000 / dt).toFixed(0)} FPS) in ${phase}.`,
        details: breakdown || `Phase: ${phase} | Tool: ${activeTool} | Layer: ${this.engine ? this.engine.activeLayer : 1}.`
      };
    }

    // 4. Wireframe connection mesh
    if (phase === 'wireframe_step' || activeTool === 'wireframe') {
      const pointsCount = details.strokePointsCount || (this.strokePointsCount || 1);
      return {
        category: 'WIREFRAME MESH',
        title: `Wireframe dynamic connection mesh`,
        description: `Incremental multi-point wireframe line connectors across previous stroke points.`,
        details: `Point ${pointsCount}: evaluated Delaunay connections to historical points.`
      };
    }

    // 5. Heavy Smudge readback
    if (phase === 'smudge_step' || activeTool === 'smudge') {
      const chunksCount = details.chunks || 1;
      const stampsCount = details.stamps || 1;
      return {
        category: 'SMUDGE STEP',
        title: `Smudge canvas readback & blend`,
        description: `Synchronous image data readback or multi-chunk segment blending.`,
        details: `${stampsCount} stamps on ${chunksCount} chunk(s). Flow boost and pickup processing.`
      };
    }

    // 6. Heavy Fluid simulation
    if (phase === 'fluid_step' || activeTool === 'fluid') {
      return {
        category: 'FLUID STEP',
        title: `Fluid paint advection / swirl simulation`,
        description: `Fluid solver calculations or bristle transfer during stroke move.`,
        details: `Turbulence and velocity advection on active layer.`
      };
    }

    // 7. Liquify mesh warp
    if (phase === 'liquify_step' || activeTool === 'liquify') {
      return {
        category: 'LIQUIFY WARP',
        title: `Liquify displacement calculations`,
        description: `Mesh warp displacement and bilinear interpolation resampling.`,
        details: `Quality resolution and chunk read/write execution.`
      };
    }

    // 8. Air particle simulation
    if (phase === 'air_step' || activeTool === 'air') {
      return {
        category: 'AIR PARTICLES',
        title: `Air paint particle diffusion`,
        description: `Stochastic particle physics and density propagation.`,
        details: `Multiple particle trajectories evaluated during pointer step.`
      };
    }

    // 9. Stroke end baking
    if (phase === 'stroke_end_bake') {
      const chunks = details.chunks || 1;
      return {
        category: 'BUFFER BAKE',
        title: `Stroke end buffer bake & commit`,
        description: `Committing stroke buffer canvases to permanent chunk layers.`,
        details: `${chunks} dirty chunks committed, alpha mask processed, and history frame pushed.${bdSuffix}`
      };
    }

    // 10. Prolonged calculations (high density stamps / oil relief)
    if (phase === 'chunk_paint') {
      const stamps = details.stamps || 0;
      const chunks = details.chunks || 1;
      if (details.hasRelief) {
        return {
          category: 'PROLONGED CALC',
          title: `Oil impasto & specular relief shading`,
          description: `High computational overhead rendering embossed relief highlights and multiply shadows.`,
          details: `${stamps} stamps on ${chunks} chunks with active 3D oil relief buffers.`
        };
      }
      if (stamps > 20) {
        return {
          category: 'PROLONGED CALC',
          title: `High stamp density calculation (${stamps} stamps)`,
          description: `Dense stamp spacing or jitter produced ${stamps} sub-stamps in a single pointer event.`,
          details: `Spanned ${chunks} chunks with position/size jitter evaluation.`
        };
      }
      return {
        category: 'PROLONGED CALC',
        title: `Prolonged chunk stamp rendering`,
        description: `Drawing routine took longer than the 16.9ms frame budget.`,
        details: `Phase: chunk_paint | Tool: ${activeTool} | Chunks: ${chunks}.`
      };
    }

    // 11. Viewport transform
    if (phase === 'viewport_transform') {
      return {
        category: 'VIEWPORT',
        title: `Canvas transform & culling refresh`,
        description: `Heavy matrix recalculation and visible chunk culling during pan/zoom/rotate.`,
        details: `Redrawing transformed tiles and grid.`
      };
    }

    // Generic fallback
    return {
      category: 'ENGINE LAG',
      title: `Prolonged calculations in phase [${phase || 'paint loop'}]`,
      description: `Execution took ${dt.toFixed(1)}ms (${(1000 / dt).toFixed(0)} FPS).`,
      details: `Active phase: ${phase} | Tool: ${activeTool} | Layer: ${this.engine ? this.engine.activeLayer : 1}.${bdSuffix}`
    };
  }

  simulateTestDrop() {
    // Artificial 25ms delay to verify the detector triggers accurately
    const start = performance.now();
    while (performance.now() - start < 26) {
      // Busy wait
    }
    this.markPhase('prolonged_calculation_test', { simulated: true });
    this._recordDrop(26.2, 38.1, performance.now());
  }

  clearLogs() {
    this.records = [];
    this.dropsCount = 0;
    this.minFps = 60.0;
    const logList = document.getElementById('perf-log-list');
    if (logList) {
      logList.innerHTML = `
        <div class="perf-empty-state">
          <div class="perf-pulse-dot"></div>
          <div style="font-size: 10px; font-weight: 900; letter-spacing: 0.5px;">RUNNING FULL 60 FPS</div>
          <div style="font-size: 8px; opacity: 0.6; margin-top: 3px;">No frame drops recorded yet</div>
        </div>
      `;
    }
    this._updateUIStats();
  }

  exportReport() {
    const data = {
      timestamp: new Date().toISOString(),
      currentFps: this.currentFps.toFixed(1),
      avgFps: this.avgFps.toFixed(1),
      minFps: this.minFps.toFixed(1),
      thresholdMs: this.thresholdMs,
      totalDrops: this.dropsCount,
      events: this.records
    };
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard?.writeText(json).then(() => {
      if (this.app) this.app._status('PERF REPORT COPIED TO CLIPBOARD');
    }).catch(() => {
      console.log('Performance Report:', json);
      if (this.app) this.app._status('PERF REPORT LOGGED TO CONSOLE');
    });
  }

  show() {
    const el = document.getElementById('panel-perf-monitor');
    if (el) {
      el.classList.remove('hidden');
      this.isWindowOpen = true;
      this._updateUIStats();
      this._renderAllRecords();
    }
  }

  hide() {
    const el = document.getElementById('panel-perf-monitor');
    if (el) {
      el.classList.add('hidden');
      this.isWindowOpen = false;
    }
  }

  toggle() {
    if (this.isWindowOpen) this.hide();
    else this.show();
  }

  _flashAlert(record) {
    const banner = document.getElementById('perf-drop-alert');
    if (banner) {
      banner.innerText = `🚨 DROP: ${record.fps} FPS (${record.dt}ms) — ${record.category}`;
      banner.style.display = 'block';
      clearTimeout(this._alertTimeout);
      this._alertTimeout = setTimeout(() => {
        banner.style.display = 'none';
      }, 2500);
    }
  }

  _updateUIStats() {
    const fpsVal = document.getElementById('perf-val-fps');
    const msVal = document.getElementById('perf-val-ms');
    const dropsVal = document.getElementById('perf-val-drops');
    const minFpsVal = document.getElementById('perf-val-min-fps');

    const dt = 1000 / Math.max(1, this.currentFps);

    if (fpsVal) {
      fpsVal.innerText = `${this.currentFps.toFixed(1)}`;
      if (this.currentFps < 55) {
        fpsVal.style.color = '#ff3333';
      } else if (this.currentFps < 59.5) {
        fpsVal.style.color = '#ff9900';
      } else {
        fpsVal.style.color = '#00aa33';
      }
    }

    if (msVal) {
      msVal.innerText = `${dt.toFixed(1)}ms`;
    }

    if (minFpsVal) {
      minFpsVal.innerText = `${this.minFps.toFixed(1)}`;
      minFpsVal.style.color = this.minFps < 59.5 ? '#ff4444' : '#00aa33';
    }

    if (dropsVal) {
      dropsVal.innerText = `${this.dropsCount}`;
      dropsVal.style.backgroundColor = this.dropsCount > 0 ? '#ff3333' : '#00aa33';
    }
  }

  _appendRecordToUI(record) {
    const logList = document.getElementById('perf-log-list');
    if (!logList) return;

    // Remove empty placeholder if present
    const emptyState = logList.querySelector('.perf-empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = 'perf-log-card';

    let catBg = '#222';
    if (record.category === 'BROWSER / GPU WAKEUP') catBg = '#4b5563';
    else if (record.category === '1ST STAMP') catBg = '#ff6600';
    else if (record.category === 'TOOL CHANGE') catBg = '#8833cc';
    else if (record.category === 'STROKE INIT') catBg = '#0066cc';
    else if (record.category === 'SUMI STAMP') catBg = '#111111';
    else if (record.category === 'SUMI SIM') catBg = '#0055aa';
    else if (record.category === 'SUMI END') catBg = '#444444';
    else if (record.category === 'SMUDGE STEP') catBg = '#008888';
    else if (record.category === 'WIREFRAME MESH') catBg = '#227700';
    else if (record.category === 'PROLONGED CALC') catBg = '#cc0033';

    const bdHtml = record.breakdown
      ? `<div style="font-size: 7px; font-family: monospace; background: #111; color: #f5f5f5; padding: 2px 4px; margin-top: 2px; line-height: 1.3; word-break: break-word;">${record.breakdown}</div>`
      : '';

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
        <div style="display: flex; align-items: center; gap: 4px;">
          <span style="font-size: 7px; font-weight: 900; background: ${catBg}; color: white; padding: 1px 4px; border-radius: 2px;">
            ${record.category}
          </span>
          <span style="font-size: 9px; font-weight: 900; font-family: monospace; color: #ff2222;">
            ${record.dt}ms (${record.fps} FPS)
          </span>
        </div>
        <span style="font-size: 7px; opacity: 0.6; font-family: monospace;">${record.timeString}</span>
      </div>
      <div style="font-size: 9px; font-weight: 900; margin-bottom: 2px; line-height: 1.2;">
        ${record.title}
      </div>
      <div style="font-size: 8px; opacity: 0.85; line-height: 1.25; margin-bottom: 3px;">
        ${record.description}
      </div>
      <div style="font-size: 7px; opacity: 0.6; font-family: monospace; background: rgba(0,0,0,0.04); padding: 2px 4px; border-left: 2px solid #000;">
        ${record.details}
      </div>
      ${bdHtml}
    `;

    logList.insertBefore(item, logList.firstChild);

    // Keep list bounded to max 80 elements in DOM
    while (logList.children.length > 80) {
      logList.removeChild(logList.lastChild);
    }
  }

  _renderAllRecords() {
    const logList = document.getElementById('perf-log-list');
    if (!logList) return;

    if (this.records.length === 0) {
      logList.innerHTML = `
        <div class="perf-empty-state">
          <div class="perf-pulse-dot"></div>
          <div style="font-size: 10px; font-weight: 900; letter-spacing: 0.5px;">RUNNING FULL 60 FPS</div>
          <div style="font-size: 8px; opacity: 0.6; margin-top: 3px;">No frame drops recorded yet</div>
        </div>
      `;
      return;
    }

    logList.innerHTML = '';
    for (const r of this.records) {
      this._appendRecordToUI(r);
    }
  }

  _initUI() {
    // If floating panel does not exist in DOM, build it
    if (!document.getElementById('panel-perf-monitor')) {
      const panel = document.createElement('div');
      panel.id = 'panel-perf-monitor';
      panel.className = 'ui-panel hidden';
      panel.style.cssText = `
        width: 320px;
        height: 440px;
        left: 280px;
        top: 80px;
        z-index: 10006;
        display: flex;
        flex-direction: column;
        background: #fff;
        border: 2px solid #000;
        box-shadow: 6px 6px 0 #000;
      `;

      panel.innerHTML = `
        <div id="handle-perf-monitor" class="panel-handle" style="cursor: move; user-select: none;">
          <span class="panel-title">⚡ PERF PROFILER (60 FPS WATCHDOG)</span>
          <button id="btn-close-perf-monitor" class="mini-btn">X</button>
        </div>

        <!-- Alert flash banner -->
        <div id="perf-drop-alert" style="display: none; background: #ff2222; color: #fff; font-size: 8px; font-weight: 900; padding: 4px 8px; text-align: center; border-bottom: 2px solid #000; text-transform: uppercase;">
          🚨 DROP DETECTED
        </div>

        <!-- Stats Bar -->
        <div style="display: flex; gap: 6px; padding: 6px 8px; background: #f5f5f5; border-bottom: 2px solid #000; align-items: center;">
          <div style="flex: 1; text-align: center; background: #fff; border: 1px solid #000; padding: 3px 2px;">
            <div style="font-size: 7px; font-weight: 900; opacity: 0.6;">CURRENT</div>
            <div id="perf-val-fps" style="font-size: 14px; font-weight: 900; font-family: monospace; color: #00aa33; line-height: 1;">60.0</div>
            <div id="perf-val-ms" style="font-size: 7px; opacity: 0.6; font-family: monospace;">16.6ms</div>
          </div>
          <div style="flex: 1; text-align: center; background: #fff; border: 1px solid #000; padding: 3px 2px;">
            <div style="font-size: 7px; font-weight: 900; opacity: 0.6;">MIN FPS</div>
            <div id="perf-val-min-fps" style="font-size: 14px; font-weight: 900; font-family: monospace; color: #00aa33; line-height: 1;">60.0</div>
            <div style="font-size: 7px; opacity: 0.6;">WORST</div>
          </div>
          <div style="flex: 1; text-align: center; background: #fff; border: 1px solid #000; padding: 3px 2px;">
            <div style="font-size: 7px; font-weight: 900; opacity: 0.6;">DROPS</div>
            <div id="perf-val-drops" style="display: inline-block; font-size: 12px; font-weight: 900; font-family: monospace; color: #fff; background: #00aa33; padding: 1px 6px; border-radius: 2px; line-height: 1.2;">0</div>
            <div style="font-size: 7px; opacity: 0.6;">EVENTS</div>
          </div>
        </div>

        <!-- Profiler Config / Controls Bar -->
        <div style="padding: 6px 8px; border-bottom: 2px solid #000; display: flex; flex-direction: column; gap: 4px; background: #fafafa;">
          <div style="display: flex; gap: 6px; align-items: center; justify-content: space-between;">
            <div style="display: flex; gap: 4px; align-items: center; flex: 1;">
              <span style="font-size: 8px; font-weight: 900; white-space: nowrap;">THRESHOLD:</span>
              <select id="perf-threshold-select" style="flex: 1; font-size: 8px; font-family: inherit; font-weight: 900; border: 1px solid #000; background: white; padding: 2px;">
                <option value="16.95" selected>STRICT: 59 FPS (&gt;16.9ms)</option>
                <option value="18.2">MEDIUM: 55 FPS (&gt;18.2ms)</option>
                <option value="20.0">RELAXED: 50 FPS (&gt;20.0ms)</option>
                <option value="33.3">LOOSE: 30 FPS (&gt;33.3ms)</option>
              </select>
            </div>
            <label style="display: flex; align-items: center; gap: 3px; font-size: 8px; font-weight: 900; cursor: pointer; user-select: none;">
              <input type="checkbox" id="perf-paint-only-checkbox" checked style="margin: 0; accent-color: #000;">
              PAINT ONLY
            </label>
          </div>

          <div style="display: flex; gap: 4px; justify-content: space-between;">
            <button id="btn-perf-toggle-rec" class="brutal-btn" style="flex: 1; font-size: 8px; padding: 3px; font-weight: 900; background: ${this.enabled ? '#000' : '#888'}; color: #fff;">${this.enabled ? '● ACTIVE' : '⏸ PAUSED'}</button>
            <button id="btn-perf-test-drop" class="brutal-btn" style="font-size: 8px; padding: 3px 6px; font-weight: 900;">TEST HITCH</button>
            <button id="btn-perf-clear" class="brutal-btn" style="font-size: 8px; padding: 3px 6px; font-weight: 900;">CLEAR</button>
            <button id="btn-perf-copy" class="brutal-btn" style="font-size: 8px; padding: 3px 6px; font-weight: 900;">REPORT</button>
          </div>
        </div>

        <!-- Log List -->
        <div id="perf-log-list" style="flex: 1; overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; background: #fff;">
          <div class="perf-empty-state">
            <div class="perf-pulse-dot"></div>
            <div style="font-size: 10px; font-weight: 900; letter-spacing: 0.5px;">RUNNING FULL 60 FPS</div>
            <div style="font-size: 8px; opacity: 0.6; margin-top: 3px;">No frame drops recorded yet</div>
          </div>
        </div>
      `;

      document.body.appendChild(panel);

      // Make draggable
      if (this.app && typeof this.app._makeDraggable === 'function') {
        this.app._makeDraggable(panel, panel.querySelector('#handle-perf-monitor'));
      }

      // Wire close button
      panel.querySelector('#btn-close-perf-monitor').onclick = () => this.hide();

      // Wire threshold select
      const threshSelect = panel.querySelector('#perf-threshold-select');
      threshSelect.onchange = (e) => {
        this.thresholdMs = parseFloat(e.target.value) || 16.95;
      };

      // Wire paint only toggle
      const cbPaintOnly = panel.querySelector('#perf-paint-only-checkbox');
      if (cbPaintOnly) {
        cbPaintOnly.onchange = (e) => {
          this.paintOnly = e.target.checked;
        };
      }

      // Wire recording toggle
      const btnToggle = panel.querySelector('#btn-perf-toggle-rec');
      btnToggle.onclick = () => {
        this.enabled = !this.enabled;
        if (this.enabled) {
          this.resetTiming();
          if (!this.rafId) this.start();
        }
        btnToggle.innerText = this.enabled ? '● ACTIVE' : '⏸ PAUSED';
        btnToggle.style.background = this.enabled ? '#000' : '#888';
      };

      // Wire test drop button
      panel.querySelector('#btn-perf-test-drop').onclick = () => this.simulateTestDrop();

      // Wire clear logs button
      panel.querySelector('#btn-perf-clear').onclick = () => this.clearLogs();

      // Wire export report
      panel.querySelector('#btn-perf-copy').onclick = () => this.exportReport();
    }
  }
}
