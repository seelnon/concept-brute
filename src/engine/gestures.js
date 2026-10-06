export function _initGesture() {
  const pointers = Array.from(this.activePointers.values());
  if (pointers.length < 2) return;
  const p1 = pointers[0];
  const p2 = pointers[1];
  
  this.gestureStartCenter = { x: (p1.clientX + p2.clientX) / 2, y: (p1.clientY + p2.clientY) / 2 };
  this.gestureStartDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
  this.gestureStartAngle = Math.atan2(p2.clientY - p1.clientY, p2.clientX - p1.clientX);
  
  this.gestureStartPan = { ...this.pan };
  this.gestureStartZoom = this.zoom;
  this.gestureStartRotation = this.rotation;
}

export function _handleGesture() {
  const pointers = Array.from(this.activePointers.values());
  if (pointers.length < 2 || !this.gestureStartCenter) {
      this.isGesture = false;
      return;
  }
  const p1 = pointers[0];
  const p2 = pointers[1];
  
  const center = { x: (p1.clientX + p2.clientX) / 2, y: (p1.clientY + p2.clientY) / 2 };
  const dist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
  const angle = Math.atan2(p2.clientY - p1.clientY, p2.clientX - p1.clientX);
  
  const zoomFactor = dist / Math.max(1, this.gestureStartDist);
  const angleDelta = angle - this.gestureStartAngle;
  const dx = center.x - this.gestureStartCenter.x;
  const dy = center.y - this.gestureStartCenter.y;
  
  // Multi-finger gesture logic:
  // Reset to starting point state first to avoid accumulation drift
  this.pan = { ...this.gestureStartPan };
  this.zoom = this.gestureStartZoom;
  this.rotation = this.gestureStartRotation;
  
  // Apply zoom & rotation anchored at the original midpoint of the fingers
  this.setZoom(this.gestureStartZoom * zoomFactor, this.gestureStartCenter.x, this.gestureStartCenter.y, true);
  this.setRotation(this.gestureStartRotation + angleDelta, this.gestureStartCenter.x, this.gestureStartCenter.y);
  
  // Finally apply translation of the center point itself
  this.pan.x += dx;
  this.pan.y += dy;
  
  this.refresh();
}

export function setZoom(z, cursorX = null, cursorY = null, bypassSnap = false) {
  const oldZoom = this.zoom;
  let targetZoom = Math.max(0.01, Math.min(50, z));

  // Magnetic snapping to integer and common fractional zoom levels (100%, 50%, 200%, etc.)
  // to keep pixel alignment crisp and eliminate subpixel seams.
  if (!bypassSnap) {
      const snapThreshold = 0.04;
      const snaps = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 5.0, 8.0, 12.0, 16.0];
      for (const s of snaps) {
          if (Math.abs(targetZoom - s) < snapThreshold * Math.min(1.2, s)) {
              targetZoom = s;
              break;
          }
      }
  }
  this.zoom = targetZoom;

  const rect = this.container.getBoundingClientRect();
  const cx = Math.floor(rect.width / 2);
  const cy = Math.floor(rect.height / 2);

  if (cursorX === null || cursorY === null) {
      cursorX = rect.left + cx;
      cursorY = rect.top + cy;
  }

  const x = cursorX - rect.left;
  const y = cursorY - rect.top;
  const dx = x - cx;
  const dy = y - cy;

  const factor = this.zoom / oldZoom;
  
  // Fixed point zoom: keep world point under cursor
  const vx = dx - this.pan.x;
  const vy = dy - this.pan.y;
  this.pan.x = dx - vx * factor;
  this.pan.y = dy - vy * factor;

  this.refresh();
  this.saveViewport();
  if (this.onZoomChange) this.onZoomChange(this.zoom);
}

export function setRotation(r, cursorX = null, cursorY = null) {
  const oldRot = this.rotation;
  this.rotation = r;

  const rect = this.container.getBoundingClientRect();
  const cx = Math.floor(rect.width / 2);
  const cy = Math.floor(rect.height / 2);

  if (cursorX === null || cursorY === null) {
      cursorX = rect.left + cx;
      cursorY = rect.top + cy;
  }

  const x = cursorX - rect.left;
  const y = cursorY - rect.top;
  const dx = x - cx;
  const dy = y - cy;

  // Fixed point rotation: keep world point under cursor
  const vx = dx - this.pan.x;
  const vy = dy - this.pan.y;
  
  const dRot = this.rotation - oldRot;
  const cos = Math.cos(dRot);
  const sin = Math.sin(dRot);
  
  const nvx = vx * cos - vy * sin;
  const nvy = vx * sin + vy * cos;
  
  this.pan.x = dx - nvx;
  this.pan.y = dy - nvy;

  this.refresh();
  this.saveViewport();
}

export function fitZoom() {
  if (this.isStatic) {
      const rect = this.container.getBoundingClientRect();
      if (rect.width && rect.height) {
          const fitW = rect.width - 100;
          const fitH = rect.height - 100;
          const scaleX = fitW / this.staticWidth;
          const scaleY = fitH / this.staticHeight;
          const bestScale = Math.min(scaleX, scaleY, 4.0);
          this.setZoom(Math.max(0.05, bestScale));
          return;
      }
  }
  this.setZoom(1);
}

export function saveViewport(projectId = null) {
  const pid = projectId || this.currentProjectId;
  const prefix = pid ? `v_${pid}_` : 'v_';
  localStorage.setItem(prefix + 'zoom', this.zoom);
  localStorage.setItem(prefix + 'pan', JSON.stringify(this.pan));
}

export function loadViewport(projectId = null) {
  if (projectId) this.currentProjectId = projectId;
  try {
      const prefix = this.currentProjectId ? `v_${this.currentProjectId}_` : 'v_';
      const savedZoom = localStorage.getItem(prefix + 'zoom');
      const savedPan = localStorage.getItem(prefix + 'pan');
      if (savedZoom && savedPan) {
          this.zoom = parseFloat(savedZoom);
          this.pan = JSON.parse(savedPan);
          this.refresh();
          if (this.onZoomChange) this.onZoomChange(this.zoom);
      } else {
          this.pan = { x: 0, y: 0 };
          this.zoom = 1.0;
          this.fitZoom();
      }
  } catch(e) {
      console.warn('Failed to load viewport', e);
  }
}
