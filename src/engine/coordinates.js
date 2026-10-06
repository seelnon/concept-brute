export function getContainerRect() {
  if (!this._containerRect) {
      const rect = this.container.getBoundingClientRect();
      if (rect.width && rect.height) {
          this._containerRect = rect;
      } else {
          return rect;
      }
  }
  return this._containerRect;
}

export function _screenToWorld(x, y) {
  const rect = this.getContainerRect();
  const cx = Math.floor(rect.width / 2);
  const cy = Math.floor(rect.height / 2);

  const dx = x - cx - Math.round(this.pan.x);
  const dy = y - cy - Math.round(this.pan.y);

  const cos = Math.cos(-this.rotation);
  const sin = Math.sin(-this.rotation);
  
  let wx = (dx * cos - dy * sin) / this.zoom;
  let wy = (dx * sin + dy * cos) / this.zoom;

  if (this.isMirrored) {
      wx = -wx;
  }
  
  return { wx, wy };
}

export function _worldToScreen(wx, wy) {
  const rect = this.getContainerRect();
  const cx = Math.floor(rect.width / 2);
  const cy = Math.floor(rect.height / 2);
  
  // Mirroring is applied FIRST
  let rx = wx;
  let ry = wy;
  if (this.isMirrored) rx = -rx;

  const cos = Math.cos(this.rotation);
  const sin = Math.sin(this.rotation);
  
  const finalX = (rx * cos - ry * sin) * this.zoom;
  const finalY = (rx * sin + ry * cos) * this.zoom;
  
  return {
      x: cx + Math.round(this.pan.x) + finalX,
      y: cy + Math.round(this.pan.y) + finalY
  };
}

export function _getMousePos(e) {
  const rect = this.getContainerRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  const world = this._screenToWorld(x, y);
  let wx = world.wx;
  let wy = world.wy;
  
  const isRefMove = this.brush && this.brush.type === 'ref_move';
  const isPicker = (this.brush && this.brush.type === 'picker') || (e && e.altKey);
  
  if (this.isStatic && !isRefMove && !isPicker) {
      wx = Math.max(-this.staticWidth / 2, Math.min(this.staticWidth / 2, wx));
      wy = Math.max(-this.staticHeight / 2, Math.min(this.staticHeight / 2, wy));
  }
  
  return {
      x: x, 
      y: y,
      wx: wx,
      wy: wy
  };
}

export function _worldToScreenScale(v) {
  return v * this.zoom;
}
