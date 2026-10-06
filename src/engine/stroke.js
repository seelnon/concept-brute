import { TOOLS } from '../constants.js';
import { paintWireframeIncrementally } from '../tools/wireframe.js';
import { paintSmudgeOnChunks, startSmudgeStroke } from '../tools/smudge.js';
import { paintFluidOnChunks, startFluidPaintStroke, endFluidPaintStroke } from '../tools/fluidPaint.js';
import { startLiquifyStroke, paintLiquifyStroke, endLiquifyStroke } from '../tools/liquify.js';
import { paintAirIncrementally, clearAirParticles, startAirPaintStroke, endAirPaintStroke } from '../tools/airPaint.js';
import { isMobileDevice } from '../colorUtils.js';
import { wasmCore } from '../wasm/wasmBridge.js';

export function _startStroke(e) {
  this.lastMousePos = { x: e.clientX, y: e.clientY };

  if (this.isExportMode) return;

  // Expanded UI shielding to prevent drawing through panels
  const target = e.target;
  if (target.closest('.ui-panel') || target.closest('button') || target.closest('input') || target.closest('#top-bar')) {
      return;
  }

  // Ensure app understands it is active and listens to keyboard immediately upon painting
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== this.container) {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT' || document.activeElement.tagName === 'BUTTON') {
          document.activeElement.blur();
      }
  }
  window.focus();

  // Check if we are panning (Space) or zooming (Z)
  if (this.keys[' '] || this.isPanningMode) {
      this.isPanning = true;
      return;
  }
  
  if (this.keys['z'] || this.isZoomingMode || this.keys['r']) {
      this.isZooming = this.keys['z'] || this.isZoomingMode;
      this.transformAnchor = { x: e.clientX, y: e.clientY };
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      return;
  }

  // No Color Pick for Wireframe
  if (this.brush.type === TOOLS.PICKER) {
      const color = this.pickColor(e.clientX, e.clientY);
      this.brush.color = color;
      this._notifyPicker(e.clientX, e.clientY, color, true); // true = SET color now
      return; // STOP HERE, don't start drawing
  }

  // NEW: Handle Alt-Click for picking
  if (e.altKey && this.brush.type !== TOOLS.LASSO) {
      const color = this.pickColor(e.clientX, e.clientY);
      this._notifyPicker(e.clientX, e.clientY, color, true); // true = SET color now
      return; // STOP HERE, don't start drawing
  }

  if (this.brush.type === TOOLS.REF_MOVE) {
      const m = this._getMousePos(e);
      if (this.selectReferenceAt(m.wx, m.wy)) {
          this.isDrawing = true;
          this.lastMousePos = { x: e.clientX, y: e.clientY };
          if (this.onDrawStart) this.onDrawStart();
          return;
      } else {
          this.selectedRefIndex = -1;
          this.refresh();
          if (this.onRefSelectionChanged) {
              this.onRefSelectionChanged(-1);
          }
          return; // STOP HERE, don't start painting
      }
  }

  // If the active layer is hidden, do not accept strokes or actions into it
  if (this.layerSettings[this.activeLayer] && !this.layerSettings[this.activeLayer].visible) {
      this._status('LAYER IS HIDDEN');
      return; // STOP HERE, don't start drawing/painting/selection on a hidden layer
  }

  // Selection Apply Check: If we have a selection and click away, apply it
  if (this.floatingSelection) {
      const m = this._getMousePos(e);
      const wx = m.wx;
      const wy = m.wy;
      const sel = this.floatingSelection;
      
      const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
      const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
      const rot = sel.rotation || 0;
      
      const cx = sel.x + sel.canvas.width / 2;
      const cy = sel.y + sel.canvas.height / 2;
      
      const dx = wx - cx;
      const dy = wy - cy;
      
      const localX = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const localY = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      
      const hw = (sel.canvas.width * scX) / 2;
      const hh = (sel.canvas.height * scY) / 2;
      
      // Pad by 10 pixels in world units for comfortable grabbing
      const isInside = (localX >= -hw - 10 && localX <= hw + 10 && localY >= -hh - 10 && localY <= hh + 10);
      
      if (isInside) {
          // Click inside selection: start moving regardless of tool
          if (this.onDrawStart) this.onDrawStart();
          this.isDrawing = true;
          this.lastMousePos = { x: e.clientX, y: e.clientY };
          this._transformStateBeforeDrag = this.captureFloatingSelectionState ? this.captureFloatingSelectionState() : null;
          return;
      } else {
          // Click outside selection: apply it
          this._applySelection();
          // Don't return, let it start a new stroke (e.g. new lasso)
      }
  }

  // Clear Selection on new Lasso click if we aren't moving a transform and we aren't holding shift/alt
  if (this.brush.type === TOOLS.LASSO) {
      const isAdditive = (this.keys['shift'] || e.shiftKey);
      const isSubtractive = (this.keys['alt'] || e.altKey);
      
      // Lock the lasso stroke mode at the start of the stroke
      if (isAdditive) {
          this.lassoStrokeMode = 'add';
      } else if (isSubtractive) {
          this.lassoStrokeMode = 'subtract';
      } else {
          this.lassoStrokeMode = 'new';
      }

      // Save the selection path BEFORE we make any changes to it
      this._selectionBeforeStroke = this.activeSelectionPath ? 
          this.normalizeSelectionPath(this.activeSelectionPath).map(p => ({ points: [...p.points], type: p.type })) : 
          null;

      if (!isAdditive && !isSubtractive) {
          if (this.activeSelectionPath) {
              this.clearSelection();
          }
      }
  }

  if (this.onDrawStart) this.onDrawStart();
  this.isDrawing = true;
  this._fluidBristles = null;
  const m = this._getMousePos(e);
  this.lastPos = { x: m.x, y: m.y };
  this.lastWorldPos = { x: m.wx, y: m.wy };
  this.lastTime = e.timeStamp || performance.now();
  this.smoothedVelocity = 0;
  
  // Improved pressure detection (default to 1.0 for mouse, use raw for pen)
  let pressure = 1.0;
  if (e.pointerType === 'pen' || e.pointerType === 'touch') {
      // If pressure is 0 or 0.5 (neutral/unsupported), we use a sensible starting floor (0.15)
      // to avoid tiny first-stamp artifacts while still feeling responsive.
      pressure = (e.pressure !== undefined && e.pressure !== 0 && e.pressure !== 0.5) ? e.pressure : 0.15;
  }
  if (!Number.isFinite(pressure) || pressure <= 0) pressure = 0.5;
  pressure = Math.max(0.01, Math.min(1.0, pressure));
  
  // Size modulated by initial pressure
  let initSize = this.brush.size;
  if (e.pointerType === 'pen' || e.pointerType === 'touch') {
      initSize *= (0.2 + pressure * 0.8);
  }
  if (!Number.isFinite(initSize) || initSize < 0.1) initSize = Math.max(0.1, this.brush.size);

  const worldPos = {
      x: m.wx,
      y: m.wy,
      size: initSize,
      opacity: (0.3 + pressure * 0.7),
      pressure: pressure,
      color: this.brush.color
  };
  this.strokePoints = [worldPos];
  this.lastDynamicSize = initSize;
  this.lastDynamicOpac = worldPos.opacity;
  this.lastPressure = pressure;

  const pad = (initSize || 10) + 15;
  this.strokeMinX = worldPos.x - pad;
  this.strokeMaxX = worldPos.x + pad;
  this.strokeMinY = worldPos.y - pad;
  this.strokeMaxY = worldPos.y + pad;
  
  this.spacingAccumulator = 0;
  this.shiftOrigin = null;
  this.shiftLockAxis = null;
  this._currentHueJitterColor = null;
  this._hueJitterStampCount = 0;
  this._lastHueJitterBaseColor = null;

  // Clear dirty chunks tracking for this stroke
  this.currentStrokeDirtyChunks = new Map();
  if (this.brush.type === TOOLS.SMUDGE) {
      startSmudgeStroke(this, worldPos);
  } else if (this.brush.type === TOOLS.FLUID) {
      startFluidPaintStroke(this, worldPos);
  } else if (this.brush.type === TOOLS.LIQUIFY) {
      this.liquifySteps = [];
      startLiquifyStroke(this, worldPos);
  } else if (this.brush.type === TOOLS.AIR) {
      startAirPaintStroke(this);
  }
  this._clearStack(this.redoStack);
}

export function _moveStroke(e) {
  if (this.isDrawing && this.onDrawMove) this.onDrawMove();

  if (this.isPanning || (this.keys['r'] && this.isMouseDown)) {
      let dx = e.clientX - this.lastMousePos.x;
      let dy = e.clientY - this.lastMousePos.y;
      
      if (this.keys['r']) {
          // Rotate
          const rect = this.getContainerRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          
          // Calculate rotation angle relative to center
          const a1 = Math.atan2(this.lastMousePos.y - cy, this.lastMousePos.x - cx);
          const a2 = Math.atan2(e.clientY - cy, e.clientX - cx);
          
          // Pivot around the point where they first pressed
          const anchor = this.transformAnchor || { x: cx, y: cy };
          this.setRotation(this.rotation + (a2 - a1), anchor.x, anchor.y);
      } else {
          // Pan
          const dx = e.clientX - this.lastMousePos.x;
          const dy = e.clientY - this.lastMousePos.y;
          
          this.pan.x += dx;
          this.pan.y += dy;
          this.saveViewport();
      }
      
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      this.refresh();
      return;
  }
  
  if (this.isZooming) {
      // Use vertical delta primarily for zoom, but now anchored to start pos
      const dy = e.clientY - this.lastMousePos.y;
      
      // Exponential zoom feel
      const zoomDelta = -dy * 0.01;
      const newZoom = this.zoom * (1 + zoomDelta);
      
      this.setZoom(newZoom, this.transformAnchor.x, this.transformAnchor.y, true);
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      return;
  }

  if (this.floatingSelection && this.isDrawing) {
      const sel = this.floatingSelection;
      const m1 = this._getMousePos({ clientX: this.lastMousePos.x, clientY: this.lastMousePos.y });
      const m2 = this._getMousePos(e);
      const dwx = m2.wx - m1.wx;
      const dwy = m2.wy - m1.wy;

      const isOpacity = this.keys['t'] || this.transformMode === 'opacity';
      const isScale = this.keys['shift'] || this.transformMode === 'scale';
      const isRotate = this.keys['alt'] || this.keys['control'] || this.transformMode === 'rotate';

      if (isOpacity) {
          // Opacity
          const dy = e.clientY - this.lastMousePos.y;
          const opDelta = -dy * 0.01;
          sel.opacity = Math.max(0, Math.min(1, (sel.opacity !== undefined ? sel.opacity : 1) + opDelta));
          this._status(`OPACITY: ${Math.round(sel.opacity * 100)}%`);
            } else if (isScale) {
          const dx = e.clientX - this.lastMousePos.x;
          const dy = e.clientY - this.lastMousePos.y;
          const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
          const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
          
          if (!this.scaleNonUniform) {
              // Uniform scale: scale X and Y by the same unified factor
              const factor = 1 + (dx - dy) * 0.005;
              sel.scaleX = Math.max(0.01, scX * factor);
              sel.scaleY = Math.max(0.01, scY * factor);
              sel.scale = sel.scaleX;
          } else {
              // Non-uniform Scale: Horizontal movement scales X, Vertical movement scales Y
              const factorX = 1 + dx * 0.01;
              const factorY = 1 - dy * 0.01;
              sel.scaleX = Math.max(0.01, scX * factorX);
              sel.scaleY = Math.max(0.01, scY * factorY);
              sel.scale = (sel.scaleX + sel.scaleY) / 2; // Keep compatibility fallback
          }
      } else if (isRotate) {
          // Rotate (5x slower sensitivity as requested)
          const dx = e.clientX - this.lastMousePos.x;
          const factor = dx * 0.01;
          sel.rotation = (sel.rotation || 0) + factor;
      } else {
          // Move using world space deltas
          sel.x += dwx;
          sel.y += dwy;
      }
      
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      this._updateSelectionPreview();
      return;
  }

  if (this.brush.type === TOOLS.REF_MOVE && this.isDrawing && this.selectedRefIndex !== -1) {
      const sel = this.referenceImages[this.selectedRefIndex];
      const m1 = this._getMousePos({ clientX: this.lastMousePos.x, clientY: this.lastMousePos.y });
      const m2 = this._getMousePos(e);
      const dwx = m2.wx - m1.wx;
      const dwy = m2.wy - m1.wy;

      if (this.keys['t']) {
          const dy = e.clientY - this.lastMousePos.y;
          const opDelta = -dy * 0.01;
          sel.opacity = Math.max(0, Math.min(1, (sel.opacity !== undefined ? sel.opacity : 1) + opDelta));
          this._status(`OPACITY: ${Math.round(sel.opacity * 100)}%`);
      } else if (this.keys['shift']) {
          const dy = e.clientY - this.lastMousePos.y;
          const factor = 1 + dy * 0.01;
          sel.scale = (sel.scale || 1) * factor;
      } else if (this.keys['alt'] || this.keys['control']) {
          const dx = e.clientX - this.lastMousePos.x;
          const factor = dx * 0.01;
          sel.rotation = (sel.rotation || 0) + factor;
      } else if (this.keys['b']) { // Mirror hotkey while dragging
          // This might be better as a toggle on keydown
      } else {
          sel.x += dwx;
          sel.y += dwy;
      }
      
      this.lastMousePos = { x: e.clientX, y: e.clientY };
      this.refresh();
      return;
  }

  if (!this.isDrawing) return;
  
  const m = this._getMousePos(e);
  let currentPos = { x: m.x, y: m.y };

  // Shift Constraint
  if (this.brush.type !== TOOLS.LASSO && (this.keys['shift'] || e.shiftKey) && this.lastPos) {
      if (!this.shiftOrigin) {
          this.shiftOrigin = { ...this.lastPos };
          this.shiftLockAxis = null;
      }

      const dx = currentPos.x - this.shiftOrigin.x;
      const dy = currentPos.y - this.shiftOrigin.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      const tolerance = 4; 
      if (!this.shiftLockAxis) {
          if (absX > tolerance || absY > tolerance) {
              this.shiftLockAxis = absX > absY ? 'x' : 'y';
          }
      }

      if (this.shiftLockAxis === 'x') {
          currentPos.y = this.shiftOrigin.y;
      } else if (this.shiftLockAxis === 'y') {
          currentPos.x = this.shiftOrigin.x;
      } else {
          currentPos.x = this.shiftOrigin.x;
          currentPos.y = this.shiftOrigin.y;
      }
      
      // Update world coordinates based on the constrained screen coordinates
      const constrainedWorld = this._screenToWorld(currentPos.x, currentPos.y);
      m.wx = constrainedWorld.wx;
      m.wy = constrainedWorld.wy;
  } else {
      this.shiftOrigin = null;
      this.shiftLockAxis = null;
  }

  if (this.brush.type === TOOLS.LASSO) {
      this._drawLasso(this.lastPos, currentPos);
      this.lastPos = currentPos;
      return;
  }

  const currentTime = e.timeStamp || performance.now();
  let pressure = 1.0;
  if (e.pointerType === 'pen' || e.pointerType === 'touch') {
      // More robust pressure fallback
      pressure = (e.pressure !== undefined && e.pressure !== 0 && e.pressure !== 0.5) ? e.pressure : (this.lastPressure || 0.2);
  }
  if (!Number.isFinite(pressure) || pressure <= 0) pressure = this.lastPressure || 0.5;
  pressure = Math.max(0.01, Math.min(1.0, pressure));

  // Smoother pressure
  this.lastPressure = (this.lastPressure || pressure) * 0.6 + pressure * 0.4;
  this.lastPressure = Math.max(0.01, Math.min(1.0, this.lastPressure));

  const dx = currentPos.x - this.lastPos.x;
  const dy = currentPos.y - this.lastPos.y;
  // dt: use a minimum of 1ms to allow high-frequency polling devices (such as modern mice and tablets) to have accurate velocity readings!
  const dt = Math.max(1, currentTime - this.lastTime); 
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (!Number.isFinite(dist)) return;
  if (dist < 0.1) return;
  
  // Clamp high instantaneous speed before running it through the low-pass filter
  const rawVelocity = Math.min(120, dist / dt);
  // Smoother velocity tracking across longer frame averages
  this.smoothedVelocity = this.smoothedVelocity * 0.88 + rawVelocity * 0.12;
  if (!Number.isFinite(this.smoothedVelocity)) this.smoothedVelocity = rawVelocity;
  
  // Clamp velocity more strictly to avoid giant "crashes"
  const velocity = Math.min(this.smoothedVelocity, 120); 

  const worldTo = {
    x: m.wx,
    y: m.wy
  };

  // --- Brush Sensitivity ---
  // Deadzone from 0.0 to 0.7 px/ms. Max speed ranges from 1.0 to 10.0 px/ms.
  const maxSpeed = this.brush.speedMax || 5.0;
  let normSpeed = 0.0;
  if (velocity > 0.7) {
      normSpeed = Math.min((velocity - 0.7) / (Math.max(1.0, maxSpeed) - 0.7), 1.0);
  }
  const vFactor = normSpeed * normSpeed; // Pure quadratic ease-in
  
  // Size Modifier: -100% to +100% compounding on current value.
  const speedSizeFactor = this.brush.speedSize || 0;
  const k_sz = speedSizeFactor / 100;
  const sizeMod = 1.0 + vFactor * k_sz;
  let dynamicSize = this.brush.size * sizeMod;
  
  if (this.brush.pressureEnabled && (e.pointerType === 'pen' || e.pointerType === 'touch')) {
      const inf = this.brush.pressureSizeInfluence !== undefined ? this.brush.pressureSizeInfluence : (this.brush.pressureInfluence ?? 1.0);
      dynamicSize *= ( (1 - inf) + this.lastPressure * inf );
  }
  // Final clamp to prevent "crashed chunks" (e.g. 1500px stamps)
  dynamicSize = Math.max(0.1, Math.min(1500, dynamicSize));
  if (!Number.isFinite(dynamicSize)) dynamicSize = this.brush.size;
  
  // Opacity Modifier: -100% to +100% compounding on current value.
  const speedOpacityFactor = this.brush.speedOpacity || 0;
  const k_op = speedOpacityFactor / 100;
  let opacMod = 1.0 + vFactor * k_op;
  
  if (this.brush.pressureEnabled && (e.pointerType === 'pen' || e.pointerType === 'touch')) {
      const inf = this.brush.pressureOpacityInfluence !== undefined ? this.brush.pressureOpacityInfluence : (this.brush.pressureInfluence ?? 1.0);
      opacMod *= ( (1 - inf) + this.lastPressure * inf );
  }
  opacMod = Math.max(0.005, Math.min(1.0, opacMod));
  if (!Number.isFinite(opacMod)) opacMod = 1.0;

  let color = this.brush.color;
  if (this.brush.speedValue !== 0 || this.brush.speedHue !== 0) {
      // Speed-based color shift: gradual and beautiful
      const hShift = vFactor * (this.brush.speedHue / 100) * 90; // S-HUE ranges from -100 to 100
      const lShift = vFactor * (this.brush.speedValue / 100);    // S-VAL ranges from -100 to 100
      color = this._shiftColor(color, hShift, lShift); 
  }

  const worldPos = {
      ...worldTo,
      size: dynamicSize,
      opacity: opacMod,
      color: color,
      pressure: pressure
  };

  if (this.brush.type === TOOLS.WIREFRAME) {
      // Point density normalization: only store points if we moved significantly in world space
      const lastP = this.strokePoints[this.strokePoints.length - 1];
      const worldDist = Math.sqrt((worldPos.x - lastP.x)**2 + (worldPos.y - lastP.y)**2);
      
      // Minimal distance between points in buffer (e.g., 2 pixels at size 20)
      const minBufferDist = Math.max(2, dynamicSize * 0.15);
      
      if (worldDist > minBufferDist) {
          this.strokePoints.push(worldPos);
          this._paintWireframeIncrementally(this.strokePoints.length - 1);
      }
  } else if (this.brush.type === TOOLS.FLUID) {
      const lastP = this.strokePoints[this.strokePoints.length - 1];
      const dist = Math.hypot(worldTo.x - lastP.x, worldTo.y - lastP.y);
      if (dist >= 0.8) {
          paintFluidOnChunks(this, lastP, worldTo, dynamicSize, opacMod, color, pressure);
          this.strokePoints.push(worldPos);
      }
  } else if (this.brush.type === TOOLS.AIR) {
      const lastP = this.strokePoints[this.strokePoints.length - 1];
      const dist = Math.sqrt((worldTo.x - lastP.x)**2 + (worldTo.y - lastP.y)**2);
      
      const minAirDist = 1.0;
      if (dist >= minAirDist) {
          this.strokePoints.push(worldPos);
          paintAirIncrementally(this, this.strokePoints.length - 1);
      }
  } else if (this.brush.type === TOOLS.LIQUIFY) {
      const lastP = this.strokePoints[this.strokePoints.length - 1];
      const dist = Math.sqrt((worldTo.x - lastP.x)**2 + (worldTo.y - lastP.y)**2);
      
      const minWarpDist = Math.max(1.0, Math.min(20.0, dynamicSize * 0.02));
      if (dist >= minWarpDist) {
          const maxStepDist = Math.max(16.0, dynamicSize * 0.25);
          if (dist > maxStepDist) {
              const steps = Math.min(4, Math.ceil(dist / maxStepDist));
              let prev = lastP;
              for (let s = 1; s <= steps; s++) {
                  const t = s / steps;
                  const subTo = {
                      x: lastP.x + (worldTo.x - lastP.x) * t,
                      y: lastP.y + (worldTo.y - lastP.y) * t
                  };
                  paintLiquifyStroke(this, prev, subTo, dynamicSize, pressure);
                  prev = subTo;
              }
          } else {
              paintLiquifyStroke(this, lastP, worldTo, dynamicSize, pressure);
          }
          this.strokePoints.push(worldPos);
      }
  } else {
      this.strokePoints.push(worldPos);
      
      if (this.strokePoints.length === 2) {
          // First segment: P0 -> Mid(P0, P1)
          const p0 = this.strokePoints[0];
          
          // Recalibrate start point's parameters to align with first move/pressure (always recalibrate so 1st stamp is perfectly speed-modulated)
          p0.size = dynamicSize;
          p0.opacity = opacMod;
          p0.color = color;
          p0.pressure = pressure;
          
          const mid = { x: (p0.x + worldPos.x) / 2, y: (p0.y + worldPos.y) / 2 };
          this._paintOnChunks(p0, mid, p0.size, p0.opacity, p0.color);
      } else if (this.strokePoints.length > 2) {
          // Curve from Mid(P_n-2, P_n-1) to Mid(P_n-1, P_n) with P_n-1 as control
          const p_n2 = this.strokePoints[this.strokePoints.length - 3];
          const p_n1 = this.strokePoints[this.strokePoints.length - 2];
          const p_n = this.strokePoints[this.strokePoints.length - 1];
          
          const mid1 = { x: (p_n2.x + p_n1.x) / 2, y: (p_n2.y + p_n1.y) / 2 };
          const mid2 = { x: (p_n1.x + p_n.x) / 2, y: (p_n1.y + p_n.y) / 2 };
          
          this._paintCurveOnChunks(mid1, p_n1, mid2, p_n1.size, p_n.size, p_n1.opacity, p_n.opacity, p_n.color);
      }
  }
  
  this.lastPos = currentPos;
  this.lastWorldPos = worldTo;
  this.lastTime = currentTime;
}

export function _endStroke(e = null) {
  // Finish last part of smoothed curve first
  if (this.isDrawing && this.brush.type !== TOOLS.LASSO && this.strokePoints.length > 1 && this.brush.type !== TOOLS.WIREFRAME && this.brush.type !== TOOLS.LIQUIFY && this.brush.type !== TOOLS.FLUID && this.brush.type !== TOOLS.AIR) {
      const p_last = this.strokePoints[this.strokePoints.length - 1];
      const p_prev = this.strokePoints[this.strokePoints.length - 2];
      const mid = { x: (p_last.x + p_prev.x) / 2, y: (p_last.y + p_prev.y) / 2 };
      this._paintOnChunks(mid, p_last, p_last.size, p_last.opacity, p_last.color);
  }

  // 1. Calculate bounding box of this stroke based on actual generated/scattered stamp bounds
  let minX = this.strokeMinX;
  let maxX = this.strokeMaxX;
  let minY = this.strokeMinY;
  let maxY = this.strokeMaxY;

  // Fallback if bounds are not set
  if (minX === undefined || minX === Infinity || maxX === -Infinity || minY === Infinity || maxY === -Infinity) {
      minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      if (this.strokePoints && this.strokePoints.length > 0) {
          for (const p of this.strokePoints) {
              const pad = (p.size || this.brush.size || 10) + 15; 
              minX = Math.min(minX, p.x - pad);
              maxX = Math.max(maxX, p.x + pad);
              minY = Math.min(minY, p.y - pad);
              maxY = Math.max(maxY, p.y + pad);
          }
      }
  }

  if (this.brush.type === TOOLS.LASSO) {
      if (this.lassoPath && this.lassoPath.length > 10) {
          this._processLassoSelection(e);
      } else {
          // They tapped and cleared the selection, push history to allow undoing the clear
          if (this._selectionBeforeStroke) {
              this._pushHistory({ type: 'selection', path: this._selectionBeforeStroke });
          }
          this.lassoPath = null;
          this.refresh();
      }
      this._selectionBeforeStroke = null;
  }

  if (this.brush.type === TOOLS.FLUID) {
      endFluidPaintStroke(this);
  }

  // Bake per-stroke buffer
  if (this.brush.type !== TOOLS.ERASER && this.brush.type !== TOOLS.SMUDGE && this.brush.type !== TOOLS.LIQUIFY && this.brush.type !== TOOLS.FLUID) {
      this.currentStrokeDirtyChunks.forEach((data, id) => {
          const chunk = this.chunks.get(id);
          if (chunk) {
              const ctx = chunk.ctxs[this.activeLayer];
              const lx = this.isStatic ? -this.staticWidth / 2 : chunk.cx * this.chunkSize;
              const ly = this.isStatic ? -this.staticHeight / 2 : chunk.cy * this.chunkSize;

              ctx.save();
              
              // Mask strokeCanvas to compound selection before drawing it on the layer
              if (this.activeSelectionPath && chunk.strokeCanvas) {
                  const maskCanvas = document.createElement('canvas');
                  maskCanvas.width = chunk.width;
                  maskCanvas.height = chunk.height;
                  const maskCtx = maskCanvas.getContext('2d');
                  this.drawSelectionMask(maskCtx, this.activeSelectionPath, lx, ly);

                  const sCtx = chunk.strokeCanvas.getContext('2d');
                  sCtx.save();
                  sCtx.globalCompositeOperation = 'destination-in';
                  sCtx.drawImage(maskCanvas, 0, 0);
                  sCtx.restore();
              }

              ctx.globalAlpha = (this.brush.type === TOOLS.AIR) ? 1.0 : this.brush.opacity; // Per-stroke opacity from UI
              
              const layerSet = this.layerSettings[this.activeLayer];
              if (layerSet && layerSet.alphaLock) {
                  ctx.globalCompositeOperation = 'source-atop';
              } else {
                  ctx.globalCompositeOperation = 'source-over';
              }

              const scale = this.isStatic ? this.dpiScale : 1;
              let chunkMinX = 0;
              let chunkMinY = 0;
              let chunkW = chunk.width;
              let chunkH = chunk.height;

              if (minX !== Infinity) {
                  chunkMinX = Math.max(0, Math.floor(minX - lx));
                  chunkMinY = Math.max(0, Math.floor(minY - ly));
                  const chunkMaxX = Math.min(chunk.width, Math.ceil(maxX - lx));
                  const chunkMaxY = Math.min(chunk.height, Math.ceil(maxY - ly));
                  chunkW = chunkMaxX - chunkMinX;
                  chunkH = chunkMaxY - chunkMinY;
              }

              if (chunkW > 0 && chunkH > 0 && chunk.strokeCanvas) {
                  ctx.drawImage(
                      chunk.strokeCanvas,
                      chunkMinX * scale,
                      chunkMinY * scale,
                      chunkW * scale,
                      chunkH * scale,
                      chunkMinX,
                      chunkMinY,
                      chunkW,
                      chunkH
                  );
              }
              ctx.restore();
              this._markDirty(id, this.activeLayer, false);
              if (this.gpuRenderer) {
                  this.gpuRenderer.markChunkLayerDirty(chunk, this.activeLayer);
                  this.gpuRenderer.markChunkStrokeDirty(chunk, false);
              }

              // Clear stroke buffer for next stroke
              const cMinX = chunkMinX;
              const cMinY = chunkMinY;
              const cW = chunkW;
              const cH = chunkH;
              requestAnimationFrame(() => {
                  if (cW > 0 && cH > 0 && chunk.strokeCtx) {
                      chunk.strokeCtx.clearRect(cMinX, cMinY, cW, cH);
                  }
                  if (chunk.strokeCanvas) {
                      chunk.strokeCanvas.style.opacity = '0';
                  }
                  if (this.gpuRenderer) {
                      this.gpuRenderer.markChunkStrokeDirty(chunk, false);
                  }
              });
          }
      });
  } else {
      // If it was smudge or liquify under active selection
      if ((this.brush.type === TOOLS.SMUDGE || this.brush.type === TOOLS.LIQUIFY) && this.activeSelectionPath) {
          this.currentStrokeDirtyChunks.forEach((data, id) => {
              const chunk = this.chunks.get(id);
              if (chunk && data.canvas) {
                  const lx = this.isStatic ? -this.staticWidth / 2 : chunk.cx * this.chunkSize;
                  const ly = this.isStatic ? -this.staticHeight / 2 : chunk.cy * this.chunkSize;
                  
                  // Create selection mask
                  const maskCanvas = document.createElement('canvas');
                  maskCanvas.width = chunk.width;
                  maskCanvas.height = chunk.height;
                  const maskCtx = maskCanvas.getContext('2d');
                  this.drawSelectionMask(maskCtx, this.activeSelectionPath, lx, ly);

                  // 1. Create standard temp canvas containing the CURRENT canvas (drawn/smudged/liquified state)
                  const tempCurrent = document.createElement('canvas');
                  tempCurrent.width = chunk.width;
                  tempCurrent.height = chunk.height;
                  const tempCurrentCtx = tempCurrent.getContext('2d');
                  tempCurrentCtx.drawImage(chunk.canvases[this.activeLayer], 0, 0);

                  // Retain only CURRENT pixels inside mask
                  tempCurrentCtx.save();
                  tempCurrentCtx.globalCompositeOperation = 'destination-in';
                  tempCurrentCtx.drawImage(maskCanvas, 0, 0);
                  tempCurrentCtx.restore();

                  // 2. Create a temp canvas containing original BACKUP pixels
                  const tempBackup = document.createElement('canvas');
                  tempBackup.width = chunk.width;
                  tempBackup.height = chunk.height;
                  const tempBackupCtx = tempBackup.getContext('2d');
                  tempBackupCtx.drawImage(data.canvas, 0, 0);

                  // Retain only BACKUP pixels outside mask
                  tempBackupCtx.save();
                  tempBackupCtx.globalCompositeOperation = 'destination-out';
                  tempBackupCtx.drawImage(maskCanvas, 0, 0);
                  tempBackupCtx.restore();

                  // 3. Combine them back using perfect additive blend to avoid edge antialiasing fringing
                  const layerCtx = chunk.ctxs[this.activeLayer];
                  layerCtx.clearRect(0, 0, chunk.width, chunk.height);
                  layerCtx.drawImage(tempBackup, 0, 0);
                  layerCtx.save();
                  layerCtx.globalCompositeOperation = 'lighter';
                  layerCtx.drawImage(tempCurrent, 0, 0);
                  layerCtx.restore();
                  if (this.gpuRenderer) {
                      this.gpuRenderer.markChunkLayerDirty(chunk, this.activeLayer);
                  }
              }
          });
      }

      // If it was eraser under active selection, we perform our once-off selection clipping mask
      if (this.brush.type === TOOLS.ERASER && this.activeSelectionPath) {
          this.currentStrokeDirtyChunks.forEach((data, id) => {
              const chunk = this.chunks.get(id);
              if (chunk) {
                  const lx = this.isStatic ? -this.staticWidth / 2 : chunk.cx * this.chunkSize;
                  const ly = this.isStatic ? -this.staticHeight / 2 : chunk.cy * this.chunkSize;
                  
                  const backupCanvas = data.canvas;
                  if (backupCanvas) {
                      const layerCtx = chunk.ctxs[this.activeLayer];

                      // 1. Create selection mask
                      const maskCanvas = document.createElement('canvas');
                      maskCanvas.width = chunk.width;
                      maskCanvas.height = chunk.height;
                      const maskCtx = maskCanvas.getContext('2d');
                      this.drawSelectionMask(maskCtx, this.activeSelectionPath, lx, ly);

                      // 2. Create standard temp canvas containing the CURRENT canvas (erased state)
                      const tempCurrent = document.createElement('canvas');
                      tempCurrent.width = chunk.width;
                      tempCurrent.height = chunk.height;
                      const tempCurrentCtx = tempCurrent.getContext('2d');
                      tempCurrentCtx.drawImage(chunk.canvases[this.activeLayer], 0, 0);

                      // Retain only CURRENT pixels inside mask
                      tempCurrentCtx.save();
                      tempCurrentCtx.globalCompositeOperation = 'destination-in';
                      tempCurrentCtx.drawImage(maskCanvas, 0, 0);
                      tempCurrentCtx.restore();

                      // 3. Create a temp canvas containing original BACKUP pixels
                      const tempBackup = document.createElement('canvas');
                      tempBackup.width = chunk.width;
                      tempBackup.height = chunk.height;
                      const tempBackupCtx = tempBackup.getContext('2d');
                      tempBackupCtx.drawImage(backupCanvas, 0, 0);

                      // Retain only BACKUP pixels outside mask
                      tempBackupCtx.save();
                      tempBackupCtx.globalCompositeOperation = 'destination-out';
                      tempBackupCtx.drawImage(maskCanvas, 0, 0);
                      tempBackupCtx.restore();

                      // 4. Combine them back onto chunk's canvas with perfect additive blend to avoid edge antialiasing fringing
                      layerCtx.clearRect(0, 0, chunk.width, chunk.height);
                      layerCtx.drawImage(tempBackup, 0, 0);
                      layerCtx.save();
                      layerCtx.globalCompositeOperation = 'lighter';
                      layerCtx.drawImage(tempCurrent, 0, 0);
                      layerCtx.restore();
                      if (this.gpuRenderer) {
                          this.gpuRenderer.markChunkLayerDirty(chunk, this.activeLayer);
                      }
                  }
              }
          });
      }

      // Clear stroke buffers
      this.currentStrokeDirtyChunks.forEach((data, id) => {
          const chunk = this.chunks.get(id);
          if (chunk) {
              const lx = this.isStatic ? -this.staticWidth / 2 : chunk.cx * this.chunkSize;
              const ly = this.isStatic ? -this.staticHeight / 2 : chunk.cy * this.chunkSize;
              let chunkMinX = 0;
              let chunkMinY = 0;
              let chunkW = chunk.width;
              let chunkH = chunk.height;

              if (minX !== Infinity) {
                  chunkMinX = Math.max(0, Math.floor(minX - lx));
                  chunkMinY = Math.max(0, Math.floor(minY - ly));
                  const chunkMaxX = Math.min(chunk.width, Math.ceil(maxX - lx));
                  const chunkMaxY = Math.min(chunk.height, Math.ceil(maxY - ly));
                  chunkW = chunkMaxX - chunkMinX;
                  chunkH = chunkMaxY - chunkMinY;
              }
              const cMinX = chunkMinX;
              const cMinY = chunkMinY;
              const cW = chunkW;
              const cH = chunkH;
              requestAnimationFrame(() => {
                  if (cW > 0 && cH > 0 && chunk.strokeCtx) {
                      chunk.strokeCtx.clearRect(cMinX, cMinY, cW, cH);
                  }
                  if (chunk.strokeCanvas) {
                      chunk.strokeCanvas.style.opacity = '0';
                  }
              });
          }
      });
  }

  if (this.brush.type === TOOLS.LIQUIFY) {
      endLiquifyStroke(this);
  } else {
      this.liquifyChunkData = null;
      wasmCore.liquifyEndAllSessions();
  }

  // Store the dirty chunks as a history state
  if (this.currentStrokeDirtyChunks.size > 0) {
      this._pushHistory({
          type: 'stroke',
          chunks: this.currentStrokeDirtyChunks,
          zoom: this.zoom,
          pan: { ...this.pan }
      });
  }
  
  if (this.brush.type === TOOLS.REF_MOVE) {
      this.refsDirty = true;
  }
  
  if (this.brush.type === TOOLS.LIQUIFY) {
      endLiquifyStroke(this);
      this.clearAllOffscreenCanvases();
  }
  
  if (this.brush.type === TOOLS.AIR) {
      endAirPaintStroke(this);
      clearAirParticles();
  }
  
  if (this._transformStateBeforeDrag && this.isDrawing) {
      const currentState = this.captureFloatingSelectionState ? this.captureFloatingSelectionState() : null;
      if (currentState && JSON.stringify(this._transformStateBeforeDrag) !== JSON.stringify(currentState)) {
          if (!this.transformHistory) this.transformHistory = [];
          this.transformHistory.push({
              before: this._transformStateBeforeDrag,
              after: currentState
          });
          this.transformRedoHistory = [];
      }
  }
  this._transformStateBeforeDrag = null;

  if (this.onDrawEnd && this.isDrawing) this.onDrawEnd();
  
  this.isDrawing = false;
  this._fluidBristles = null;
  this.isPanning = false;
  this.isZooming = false;
  this.lastPos = null;
  this.lassoPath = null;
  this.lassoStrokeMode = null;
  this.shiftOrigin = null;
  this.shiftLockAxis = null;
  this._status('READY');
  this._updateCursor();
  
  if (e) {
      if (e.pointerType !== 'mouse') {
          if (this.brushCursor) this.brushCursor.style.display = 'none';
          if (this.brushCrosshair) this.brushCrosshair.style.display = 'none';
      } else {
          this._updateBrushCursor(e);
      }
  } else {
      this._updateBrushCursor();
  }
}

export function _paintCurveOnChunks(p0, p1, p2, size1, size2, opac1, opac2, color) {
  const dist = Math.sqrt((p1.x - p0.x)**2 + (p1.y - p0.y)**2) + Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
  
  if (dist < 6) {
      this._paintOnChunks(p0, p2, size2, opac2, color);
      return;
  }

  // Much more aggressive simplification for speed (sacrificing quality)
  const steps = Math.min(6, Math.max(1, Math.ceil(dist / 24)));
  
  let prev = p0;
  for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const tInv = 1 - t;
      const next = {
          x: tInv * tInv * p0.x + 2 * tInv * t * p1.x + t * t * p2.x,
          y: tInv * tInv * p0.y + 2 * tInv * t * p1.y + t * t * p2.y
      };
      const curSize = size1 + (size2 - size1) * t;
      const curOpac = opac1 + (opac2 - opac1) * t;
      this._paintOnChunks(prev, next, curSize, curOpac, color);
      prev = next;
  }
}

export function _paintWireframeIncrementally(j) {
  return paintWireframeIncrementally(this, j);
}

export function _paintOnChunks(from, to, size, opacity, color) {
  if (this.activeLayer === 0) return;
  
  // 1. Prepare Brush Params
  const isSmudge = this.brush.type === TOOLS.SMUDGE;
  const isWire = this.brush.type === TOOLS.WIREFRAME;
  const bSize = Math.round(size);
  let spacing = isSmudge ? Math.max(1, bSize * 0.05) : Math.max(2, bSize * this.brush.spacing); 
  if (!Number.isFinite(spacing) || spacing < 0.5) spacing = 2;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const flow = this.brush.flow || 0.5;
  
  const isEraser = this.brush.type === TOOLS.ERASER;
  const tip = this.brush.tip;
  const airbrush = this.brush.airbrush || 0;
  const oil = this.brush.oiliness || 0;
  const height = this.brush.paintHeight || 0;

  // 2. Generate Stamp Positions
  // Airbrush step optimization: higher airbrush = fewer stamps. We increase spacing proportionally to brush size
  // and blur level to prevent over-concentrating millions of soft stamps at slow speed, while keeping it perfectly smooth.
  let currentSpacing = spacing;
  if (!isSmudge && !isWire && airbrush > 0) {
      const airSpacing = Math.max(3, bSize * (this.brush.spacing + airbrush * 0.15));
      if (airSpacing > currentSpacing) {
          currentSpacing = airSpacing;
      }
  }

  // Additional heavy stamp optimization
  if (!isSmudge && !isWire && (oil > 0.005 || height > 0.005) && this.smoothedVelocity > 5) {
      const speedScale = 1 + Math.min(2.0, (this.smoothedVelocity - 5) / 22.5);
      currentSpacing *= speedScale;
  }

  const stamps = [];
  let p = this.spacingAccumulator;
  const jPos = this.brush.jitterPos || 0;
  const jSize = this.brush.jitterSize || 0;
  const jAngle = this.brush.jitterAngle || 0;
  const jHue = this.brush.jitterHue || 0;

  while (p <= dist) {
      const t = dist === 0 ? 0 : p / dist;
      let sx = from.x + dx * t;
      let sy = from.y + dy * t;
      
      // Position Jitter
      if (jPos > 0) {
          const range = bSize * jPos * 2;
          sx += (Math.random() - 0.5) * range;
          sy += (Math.random() - 0.5) * range;
      }

      const stamp = { x: sx, y: sy };

      // Size Jitter
      if (jSize > 0) {
          stamp.size = bSize * (1 + (Math.random() - 0.5) * jSize);
      } else {
          stamp.size = bSize;
      }

      // Angle Jitter
      if (jAngle > 0) {
          stamp.angle = (this.rotation || 0) + (Math.random() - 0.5) * jAngle * 2;
      } else {
          stamp.angle = this.rotation || 0;
      }

      // Hue Jitter
      if (jHue > 0) {
          this._hueJitterStampCount = (this._hueJitterStampCount || 0) + 1;
          if (!this._currentHueJitterColor || this._hueJitterStampCount % 8 === 0 || this._lastHueJitterBaseColor !== color) {
              this._lastHueJitterBaseColor = color;
              this._currentHueJitterColor = this._shiftColor(color, (Math.random() - 0.5) * jHue * 360, 0);
          }
          stamp.color = this._currentHueJitterColor;
      } else {
          stamp.color = color;
      }

      const pad = (stamp.size / 2) + 15;
      this.strokeMinX = Math.min(this.strokeMinX, sx - pad);
      this.strokeMaxX = Math.max(this.strokeMaxX, sx + pad);
      this.strokeMinY = Math.min(this.strokeMinY, sy - pad);
      this.strokeMaxY = Math.max(this.strokeMaxY, sy + pad);

      stamps.push(stamp);
      p += currentSpacing;
  }
  this.spacingAccumulator = p - dist;
  if (!Number.isFinite(this.spacingAccumulator)) this.spacingAccumulator = 0;

  if (stamps.length === 0) return;

  // 3. Cache and Smudge Prep
  if (tip && !isSmudge) {
      const sharpen = this.brush.brushSharpen || 0;
      const cacheSize = this._getCacheSize(bSize);
      const cacheKey = `${airbrush}_${cacheSize}_${sharpen}`;
      if (!this._tipColorCache || this._tipColorCache.key !== cacheKey || this._tipColorCache.color !== color || this._tipColorCache.srcTip !== this.brush.tip) {
          this._updateTipCache(cacheSize, airbrush, color);
      }
      if ((oil > 0.005 || height > 0.005) && dist < 500) {
          const reliefBlur = Math.max(0.2, (height * 0.1 + oil * 0.02)) * 4 * (1 - airbrush * 0.4);
          const reliefKey = `${cacheSize}_${reliefBlur}`;
          if (!this._reliefCache || this._reliefCache.key !== reliefKey || this._reliefCache.srcTip !== this.brush.tip) {
              this._updateReliefCache(cacheSize, reliefBlur);
          }
      }
  }

  if (isSmudge && !this.smudgeCanvas) {
      this.smudgeCanvas = document.createElement('canvas');
      this.smudgeCanvas.width = 128; 
      this.smudgeCanvas.height = 128;
      this.smudgeCtx = this.smudgeCanvas.getContext('2d', isMobileDevice ? undefined : { willReadFrequently: true });
      this.smudgeDirty = false;
  }

  // 4. Find Affected Chunks
  const affectedChunks = new Map();

  for (const s of stamps) {
      const sR = s.size / 2;
      const sCX = this.isStatic ? 0 : Math.floor((s.x - sR) / this.chunkSize);
      const eCX = this.isStatic ? 0 : Math.floor((s.x + sR) / this.chunkSize);
      const sCY = this.isStatic ? 0 : Math.floor((s.y - sR) / this.chunkSize);
      const eCY = this.isStatic ? 0 : Math.floor((s.y + sR) / this.chunkSize);

      for (let cx = sCX; cx <= eCX; cx++) {
          for (let cy = sCY; cy <= eCY; cy++) {
              const id = `${cx},${cy}`;
              let group = affectedChunks.get(id);
              if (!group) {
                  group = { cx, cy, stamps: [] };
                  affectedChunks.set(id, group);
              }
              group.stamps.push(s);
          }
      }
  }

  // 5. Draw
  const opacityBase = (isEraser || isSmudge) ? (opacity * flow * this.brush.opacity) : (opacity * flow);

  if (isSmudge) {
      paintSmudgeOnChunks(this, stamps, affectedChunks, flow, opacity, tip);
      return;
  }

  affectedChunks.forEach((group, id) => {
      const chunk = this._getChunk(group.cx, group.cy);
      if (!chunk) return;

      if (this.isDrawing && !this.currentStrokeDirtyChunks.has(id)) {
          const srcCanvas = chunk.canvases[this.activeLayer];
          const backup = document.createElement('canvas');
          backup.width = srcCanvas.width; backup.height = srcCanvas.height;
          const useReadBack = (this.brush.type === TOOLS.LIQUIFY);
          backup.getContext('2d', useReadBack ? { willReadFrequently: true } : undefined).drawImage(srcCanvas, 0, 0);
          this.currentStrokeDirtyChunks.set(id, { layer: this.activeLayer, canvas: backup });
          this._markDirty(id, this.activeLayer);
      }

      if (!isEraser) {
          this._ensureStrokeCanvas(chunk);
          chunk.strokeCanvas.style.opacity = this.brush.opacity;
      }
      const ctx = isEraser ? chunk.ctxs[this.activeLayer] : chunk.strokeCtx;

      const lx = this.isStatic ? -this.staticWidth / 2 : group.cx * this.chunkSize;
      const ly = this.isStatic ? -this.staticHeight / 2 : group.cy * this.chunkSize;

      ctx.save();

      ctx.globalAlpha = opacityBase;
      
      if (isEraser) {
          const layerSet = this.layerSettings[this.activeLayer];
          if (layerSet && layerSet.alphaLock) {
              ctx.restore();
              return;
          }
          ctx.globalCompositeOperation = 'destination-out';
      } else {
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = color;
      }

      for (const s of group.stamps) {
          try {
              const px = Math.round(s.x - lx);
              const py = Math.round(s.y - ly);
              const curSize = Math.round(s.size);
              if (curSize < 1) continue;
              const curR = curSize / 2;
              
              if (this.textureModeEnabled && !isEraser && !isSmudge) {
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(px, py, curR, 0, Math.PI * 2);
                  
                  const texColor = s.color || color || '#000000';
                  const pattern = this._getTexturePattern(this.texturePattern, this.textureDensity, this.textureGridSize, texColor);
                  if (pattern) {
                      const matrix = new DOMMatrix().translate(-lx, -ly).rotate(45);
                      pattern.setTransform(matrix);
                      ctx.fillStyle = pattern;
                      ctx.fill();
                  }
                  ctx.restore();
                  continue;
              }
              
              if (s.angle === 0 && !tip && !isWire) {
                  if (isEraser) {
                      ctx.clearRect(px - curR, py - curR/2, curSize, curSize/2);
                  } else {
                      ctx.fillStyle = s.color || color || '#000000';
                      ctx.fillRect(px - curR, py - curR/2, curSize, curSize/2);
                  }
              } else {
                  ctx.save();
                  try {
                      ctx.translate(px, py);
                      if (s.angle !== 0) ctx.rotate(s.angle);

                      if (isWire) {
                          ctx.beginPath(); ctx.arc(0, 0, curR, 0, Math.PI*2);
                          ctx.strokeStyle = s.color || color || '#000000'; ctx.lineWidth = 1.5; ctx.stroke();
                      } else if (tip) {
                          let useTip = (this._tipColorCache && this._tipColorCache.canvas) ? this._tipColorCache.canvas : null;
                          if (!useTip) {
                              ctx.fillStyle = s.color || color || '#000000';
                              ctx.beginPath();
                              ctx.arc(0, 0, curR, 0, Math.PI * 2);
                              ctx.fill();
                          } else {
                              if ((oil > 0.005 || height > 0.005) && dist < 500 && !isEraser) {
                                  if (jHue > 0) {
                                      if (!this.scratchCanvas) {
                                          this.scratchCanvas = document.createElement('canvas');
                                          this.scratchCtx = this.scratchCanvas.getContext('2d', { alpha: true });
                                      }
                                      if (this.scratchCanvas.width < curSize || this.scratchCanvas.height < curSize) {
                                          this.scratchCanvas.width = Math.max(this.scratchCanvas.width, curSize);
                                          this.scratchCanvas.height = Math.max(this.scratchCanvas.height, curSize);
                                      }
                                      this.scratchCtx.globalCompositeOperation = 'source-over'; 
                                      this.scratchCtx.clearRect(0, 0, curSize, curSize);
                                      this.scratchCtx.drawImage(useTip, 0, 0, curSize, curSize);
                                      this.scratchCtx.globalCompositeOperation = 'source-in';
                                      this.scratchCtx.fillStyle = s.color || color || '#000000';
                                      this.scratchCtx.fillRect(0, 0, curSize, curSize);
                                      ctx.drawImage(this.scratchCanvas, 0, 0, curSize, curSize, -curR, -curR, curSize, curSize);
                                  } else {
                                      ctx.drawImage(useTip, -curR, -curR, curSize, curSize);
                                  }

                                  const origAlpha = ctx.globalAlpha;
                                  const origGCO = ctx.globalCompositeOperation;

                                  if (height > 0.005 && !(this.smoothedVelocity > 35) && this._reliefCache) {
                                      ctx.globalCompositeOperation = 'multiply';
                                      ctx.globalAlpha = origAlpha * height * 0.22;
                                      ctx.drawImage(this._reliefCache.shadow, -curR, -curR, curSize, curSize);
                                  }

                                  const baseHighlightOpacity = height * 0.15;
                                  const oilOpacity = oil * 0.35;
                                  const skipBaseHighlight = (this.smoothedVelocity > 15);
                                  if (baseHighlightOpacity > 0.005 && (!skipBaseHighlight || oilOpacity <= 0.005) && this._reliefCache) {
                                      ctx.globalCompositeOperation = 'screen';
                                      ctx.globalAlpha = origAlpha * Math.min(1.0, baseHighlightOpacity);
                                      ctx.drawImage(this._reliefCache.highlight, -curR, -curR, curSize, curSize);
                                  }

                                  if (oilOpacity > 0.005 && this._reliefCache) {
                                      ctx.globalCompositeOperation = 'screen';
                                      ctx.globalAlpha = origAlpha * Math.min(0.95, oilOpacity * 1.25);
                                      ctx.drawImage(this._reliefCache.highlight, -curR, -curR, curSize, curSize);
                                  }

                                  ctx.globalAlpha = origAlpha;
                                  ctx.globalCompositeOperation = origGCO;
                              } else {
                                  if (jHue > 0) {
                                      if (!this.scratchCanvas) {
                                          this.scratchCanvas = document.createElement('canvas');
                                          this.scratchCtx = this.scratchCanvas.getContext('2d', { alpha: true });
                                      }
                                      if (this.scratchCanvas.width < curSize || this.scratchCanvas.height < curSize) {
                                          this.scratchCanvas.width = Math.max(this.scratchCanvas.width, curSize);
                                          this.scratchCanvas.height = Math.max(this.scratchCanvas.height, curSize);
                                      }
                                      this.scratchCtx.globalCompositeOperation = 'source-over'; 
                                      this.scratchCtx.clearRect(0, 0, curSize, curSize);
                                      this.scratchCtx.drawImage(useTip, 0, 0, curSize, curSize);
                                      this.scratchCtx.globalCompositeOperation = 'source-in';
                                      this.scratchCtx.fillStyle = s.color || color || '#000000';
                                      this.scratchCtx.fillRect(0, 0, curSize, curSize);
                                      ctx.drawImage(this.scratchCanvas, 0, 0, curSize, curSize, -curR, -curR, curSize, curSize);
                                  } else {
                                      ctx.drawImage(useTip, -curR, -curR, curSize, curSize);
                                  }
                              }
                          }
                      } else {
                          ctx.fillStyle = s.color || color || '#000000';
                          ctx.fillRect(-curR, -curR/2, curSize, curSize/2);
                      }
                  } finally {
                      ctx.restore();
                  }
              }
          } catch (err) {
              console.error("Stamp sub-draw error:", err);
          }
      }
      ctx.restore();
      if (this.gpuRenderer) {
          if (isEraser) {
              this.gpuRenderer.markChunkLayerDirty(chunk, this.activeLayer);
          } else {
              this.gpuRenderer.markChunkStrokeDirty(chunk, true);
          }
      }
  });
}
