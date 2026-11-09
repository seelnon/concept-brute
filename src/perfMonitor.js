// Performance Watchdog & Frame Drop Profiler
// Designed for zero overhead during smooth 60fps painting.

export class PerfMonitor {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.enabled = true;
    this.paintOnly = true; // Focus on painting & user actions
    this.autoOpenOnDrop = false;

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

    // UI throttler: update DOM only 5 times a second to ensure 0 lag from profiler itself
    this.lastUiUpdateTime = 0;
    this.uiUpdateInterval = 180; // ms

    // Animation frame handle
    this.rafId = null;
    this.isWindowOpen = false;

    // Listen for tab visibility and window focus changes to discard OS/browser background throttle spikes
    this._onFocus = () => this.resetTiming();
    this._onBlur = () => this.resetTiming();
    this._onVisibilityChange = () => this.resetTiming();

    window.addEventListener('focus', this._onFocus);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._initUI();
    this.start();
  }

  resetTiming() {
    this.lastFrameTime = performance.now();
    this.fpsHistory.length = 0;
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
    if (this.isSavingActive()) return false; // Strictly skip checks during saving
    if (document.hidden) return false; // Ignore browser background tab throttling
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false; // Ignore blurred window

    if (this.paintOnly) {
      // Must be actively painting on canvas or within 70ms of stroke commit
      const isDrawing = !!(this.engine && this.engine.isDrawing);
      const isFinishingStroke = (now - (this.lastStrokeEndTime || 0)) < 70;
      if (!isDrawing && !isFinishingStroke) return false;
    }

    // Idle phase has no active engine rendering; ignore OS/browser power-saving rAF jitter
    if (this.currentPhase === 'idle') return false;

    return true;
  }

  start() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.lastFrameTime = performance.now();
    
    const loop = (time) => {
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
    // If window is blurred or document is hidden (e.g. typing in AI Studio chat or switched tabs),
    // browser intentionally throttles requestAnimationFrame down to 20-30 FPS.
    // Reset lastFrameTime to prevent false 'engine lag' reports upon return.
    if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) {
      this.lastFrameTime = now;
      return;
    }

    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Discard spikes from background tab reactivation or device sleep (> 250ms)
    if (dt > 250) {
      this.fpsHistory.length = 0;
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

    if (instantFps < this.minFps && this.isMonitoringEligible(now)) {
      this.minFps = instantFps;
    }

    // Check for FPS drop below threshold
    if (dt > this.thresholdMs && this.isMonitoringEligible(now)) {
      this._recordDrop(dt, instantFps, now);
    }

    // Throttled UI refresh so the profiler itself uses 0.0% CPU
    if (now - this.lastUiUpdateTime > this.uiUpdateInterval) {
      this.lastUiUpdateTime = now;
      if (this.isWindowOpen) {
        this._updateUIStats();
      }
    }
  }

  _recordDrop(dt, instantFps, now) {
    this.dropsCount++;

    const timeSinceTool = this.lastToolChangeTime ? (now - this.lastToolChangeTime) : null;
    const timeSinceStroke = this.lastStrokeStartTime ? (now - this.lastStrokeStartTime) : null;
    const activeTool = (this.engine && this.engine.brush) ? this.engine.brush.type : (this.lastTool || 'unknown');
    const activeLayer = this.engine ? this.engine.activeLayer : 1;

    const diagnosis = this._diagnoseCause(dt, this.currentPhase, this.phaseDetails, timeSinceStroke, timeSinceTool, activeTool);

    const record = {
      id: Date.now() + Math.random(),
      time: new Date(),
      timeString: new Date().toTimeString().split(' ')[0] + '.' + String(Math.floor(now % 1000)).padStart(3, '0'),
      dt: dt.toFixed(1),
      fps: instantFps.toFixed(1),
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

  _diagnoseCause(dt, phase, details, timeSinceStroke, timeSinceTool, activeTool) {
    details = details || {};
    const isVeryEarlyInStroke = timeSinceStroke !== null && timeSinceStroke < 80;
    const isRightAfterTool = timeSinceTool !== null && timeSinceTool < 350;

    // 1. Tool change transition
    if (isRightAfterTool || phase === 'tool_change') {
      return {
        category: 'TOOL CHANGE',
        title: `Engine after tool change (${activeTool})`,
        description: `Frame hitch of ${dt.toFixed(1)}ms (${(1000/dt).toFixed(0)} FPS) occurred right after switching tools.`,
        details: `Switched from ${this.prevTool || 'prev'} to ${activeTool} ${timeSinceTool !== null ? timeSinceTool : 0}ms ago. Tip cache or tool pipeline was activating.`
      };
    }

    // 2. Stroke initialisation
    if (phase === 'stroke_init' || (isVeryEarlyInStroke && phase !== 'chunk_paint')) {
      return {
        category: 'STROKE INIT',
        title: `Stroke initialisation & tip preparation`,
        description: `Delay at stroke start while initializing chunk dirty-buffers or updating tip color cache.`,
        details: `Tool: ${activeTool}. Point 0 setup, pressure thresholding, and dirty chunk pre-allocation.`
      };
    }

    // 3. First stamp calculation
    if (phase === 'first_stamp' || (isVeryEarlyInStroke && phase === 'chunk_paint') || (this.strokePointsCount <= 2 && phase === 'chunk_paint')) {
      return {
        category: '1ST STAMP',
        title: `1st stamp calculation & dynamic speed modulation`,
        description: `Recalibrating initial stamp parameters to match stroke speed and pressure ramp.`,
        details: `Evaluated point 1 to point 2 ramp. Dynamic scale and opacity recalculation for initial segment.`
      };
    }

    // 4. Heavy Smudge readback
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

    // 5. Heavy Fluid simulation
    if (phase === 'fluid_step' || activeTool === 'fluid') {
      return {
        category: 'FLUID STEP',
        title: `Fluid paint advection / swirl simulation`,
        description: `Fluid solver calculations or bristle transfer during stroke move.`,
        details: `Turbulence and velocity advection on active layer.`
      };
    }

    // 6. Liquify mesh warp
    if (phase === 'liquify_step' || activeTool === 'liquify') {
      return {
        category: 'LIQUIFY WARP',
        title: `Liquify displacement calculations`,
        description: `Mesh warp displacement and bilinear interpolation resampling.`,
        details: `Quality resolution and chunk read/write execution.`
      };
    }

    // 7. Air particle simulation
    if (phase === 'air_step' || activeTool === 'air') {
      return {
        category: 'AIR PARTICLES',
        title: `Air paint particle diffusion`,
        description: `Stochastic particle physics and density propagation.`,
        details: `Multiple particle trajectories evaluated during pointer step.`
      };
    }

    // 8. Stroke end baking
    if (phase === 'stroke_end_bake') {
      const chunks = details.chunks || 1;
      return {
        category: 'BUFFER BAKE',
        title: `Stroke end buffer bake & commit`,
        description: `Committing stroke buffer canvases to permanent chunk layers.`,
        details: `${chunks} dirty chunks committed, alpha mask processed, and history frame pushed.`
      };
    }

    // 9. Prolonged calculations (high density stamps / oil relief)
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

    // 10. Viewport transform
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
      description: `Execution took ${dt.toFixed(1)}ms (${(1000/dt).toFixed(0)} FPS).`,
      details: `Active phase: ${phase} | Tool: ${activeTool} | Layer: ${this.engine ? this.engine.activeLayer : 1}.`
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
    if (record.category === '1ST STAMP') catBg = '#ff6600';
    else if (record.category === 'TOOL CHANGE') catBg = '#8833cc';
    else if (record.category === 'STROKE INIT') catBg = '#0066cc';
    else if (record.category === 'SMUDGE STEP') catBg = '#008888';
    else if (record.category === 'PROLONGED CALC') catBg = '#cc0033';

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
            <button id="btn-perf-toggle-rec" class="brutal-btn" style="flex: 1; font-size: 8px; padding: 3px; font-weight: 900; background: #000; color: #fff;">● ACTIVE</button>
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
