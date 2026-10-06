import { isMobileDevice } from '../colorUtils.js';

export function _updateMobileGridPosition() {
  if (this.gpuRenderer && this.gpuRenderer.supported) {
      this.gpuRenderer.requestRender();
      return;
  }
  if (!isMobileDevice || !this.showGrid || this.isStatic) {
      if (isMobileDevice && this.container) {
          this.container.style.backgroundImage = 'none';
      }
      return;
  }
  const px = Math.round(this.pan.x);
  const py = Math.round(this.pan.y);
  const scaledSize = this.gridSize * this.zoom;
  
  this.container.style.backgroundSize = `${scaledSize}px ${scaledSize}px`;
  this.container.style.backgroundPosition = `calc(50% + ${px}px) calc(50% + ${py}px)`;
}

export function setupBoard(force = false) {
  if (this.gpuRenderer && this.gpuRenderer.supported) {
      if (this.canvasWrapper) {
          this.canvasWrapper.style.display = 'none';
      }
      if (this.container) {
          this.container.style.backgroundImage = 'none';
          this.container.style.backgroundColor = this.isStatic ? '#18181c' : this.canvasBg;
      }
      this.gpuRenderer.requestRender();
      return;
  }
  const gridVisible = this.showGrid && this.zoom > 0.01;
  const currentKey = `${this.isStatic}-${this.staticWidth}-${this.staticHeight}-${this.canvasBg}-${gridVisible}-${this.gridSize}-${this.gridColor}-${this.gridIntensity}-${this.gridPattern}-${this.gridThickness || 2}`;
  
  if (!force && this._lastSetupBoardKey === currentKey) {
      return;
  }
  this._lastSetupBoardKey = currentKey;

  if (!this.boardContainer) {
      this.boardContainer = document.createElement('div');
      this.boardContainer.id = 'board-container';
      this.boardContainer.style.position = 'absolute';
      this.canvasWrapper.appendChild(this.boardContainer);
  }
  if (this.refLayer && this.refLayer.parentNode !== this.canvasWrapper) {
      this.canvasWrapper.appendChild(this.refLayer);
  }
  
  // Reset wrapper background in case
  this.canvasWrapper.style.backgroundColor = 'transparent';
  this.canvasWrapper.style.backgroundImage = 'none';
  
  if (this.isStatic) {
      this.boardContainer.style.overflow = 'hidden';
      this.boardContainer.style.width = `${this.staticWidth}px`;
      this.boardContainer.style.height = `${this.staticHeight}px`;
      
      const left = this.worldCenter - this.staticWidth / 2;
      const top = this.worldCenter - this.staticHeight / 2;
      this.boardContainer.style.left = `${left}px`;
      this.boardContainer.style.top = `${top}px`;
      
      // Solid brutal line border + shadow
      this.boardContainer.style.outline = '4px solid #000000';
      this.boardContainer.style.boxShadow = '16px 16px 0px 0px rgba(0,0,0,1)';
      this.boardContainer.style.backgroundColor = this.canvasBg;
      
      // High contrast dark gray workspace for desk
      this.container.style.backgroundColor = '#18181c';
      
      // Set up static board grid pattern
      if (gridVisible) {
          const currentKeyGrid = `${this.gridSize}-${this.gridColor}-${this.gridIntensity}-${this.gridPattern}-${this.gridThickness || 2}`;
          if (this._lastGridParams !== currentKeyGrid) {
              this._gridTexture = this._generateGridTexture();
              this._lastGridParams = currentKeyGrid;
          }
          this.boardContainer.style.backgroundImage = `url(${this._gridTexture})`;
          const texSize = this._gridTextureSize || 1024;
          this.boardContainer.style.backgroundSize = `${texSize}px ${texSize}px`;
          this.boardContainer.style.backgroundPosition = `0px 0px`;
          this.boardContainer.style.backgroundRepeat = 'repeat';
      } else {
          this.boardContainer.style.backgroundImage = 'none';
      }
  } else {
      // Infinite Canvas mode defaults
      this.boardContainer.style.overflow = 'visible';
      this.boardContainer.style.width = '100%';
      this.boardContainer.style.height = '100%';
      this.boardContainer.style.left = '0px';
      this.boardContainer.style.top = '0px';
      this.boardContainer.style.border = 'none';
      this.boardContainer.style.outline = 'none';
      this.boardContainer.style.boxShadow = 'none';
      this.boardContainer.style.backgroundColor = 'transparent';
      
      this.container.style.backgroundColor = this.canvasBg;
      this.canvasWrapper.style.backgroundColor = 'transparent'; 
      
      if (gridVisible) {
          const currentKeyGrid = `${this.gridSize}-${this.gridColor}-${this.gridIntensity}-${this.gridPattern}-${this.gridThickness || 2}`;
          if (this._lastGridParams !== currentKeyGrid) {
              this._gridTexture = this._generateGridTexture();
              this._lastGridParams = currentKeyGrid;
          }
          if (isMobileDevice) {
              this.container.style.backgroundImage = `url(${this._gridTexture})`;
              this.container.style.backgroundRepeat = 'repeat';
              this.canvasWrapper.style.backgroundImage = 'none';
              this._updateMobileGridPosition();
          } else {
              this.canvasWrapper.style.backgroundImage = `url(${this._gridTexture})`;
              const texSize = this._gridTextureSize || 1024;
              this.canvasWrapper.style.backgroundSize = `${texSize}px ${texSize}px`;
              this.canvasWrapper.style.backgroundPosition = `${this.worldCenter}px ${this.worldCenter}px`;
              this.canvasWrapper.style.backgroundRepeat = 'repeat';
              this.container.style.backgroundImage = 'none';
          }
      } else {
          this.canvasWrapper.style.backgroundImage = 'none';
          this.container.style.backgroundImage = 'none';
      }
  }
  
  // Refresh transform positions of chunks
  this.chunks.forEach(chunk => {
      this._updateChunkTransform(chunk);
  });
}

export function refreshGrid() {
  this.setupBoard();
}

export function _generateGridTexture() {
  const targetSize = 256;
  const cellCount = Math.max(1, Math.round(targetSize / this.gridSize));
  const size = cellCount * this.gridSize;
  this._gridTextureSize = size;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  this._gridCanvas = canvas;
  const ctx = canvas.getContext('2d');
  
  const color = this.gridColor;
  const opacity = this.gridIntensity;
  
  let r = 200, g = 200, b = 200;
  if (color.startsWith('#')) {
      if (color.length === 4) {
          r = parseInt(color[1] + color[1], 16);
          g = parseInt(color[2] + color[2], 16);
          b = parseInt(color[3] + color[3], 16);
      } else {
          r = parseInt(color.slice(1, 3), 16);
          g = parseInt(color.slice(3, 5), 16);
          b = parseInt(color.slice(5, 7), 16);
      }
  }
  const gridColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = gridColor;

  if (this.gridPattern === 'dots' || this.gridPattern === 'crosses') {
      ctx.lineWidth = 1;
  } else {
      ctx.lineWidth = this.gridThickness || 2;
  }

  const step = this.gridSize;
  
  if (this.gridPattern === 'dots') {
      const radius = Math.max(0.5, (this.gridThickness !== undefined ? this.gridThickness : 2));
      for (let x = 0; x < cellCount; x++) {
          for (let y = 0; y < cellCount; y++) {
              ctx.beginPath();
              ctx.arc(x * step + step/2, y * step + step/2, radius, 0, Math.PI * 2);
              ctx.fill();
          }
      }
  } else if (this.gridPattern === 'lines') {
      for (let i = 0; i <= cellCount; i++) {
          ctx.beginPath();
          ctx.moveTo(0, i * step);
          ctx.lineTo(size, i * step);
          ctx.stroke();
      }
  } else if (this.gridPattern === 'squares') {
      for (let i = 0; i <= cellCount; i++) {
          ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
      }
  } else if (this.gridPattern === 'crosses') {
      const arm = Math.max(1, (this.gridThickness !== undefined ? this.gridThickness : 2));
      for (let x = 0; x < cellCount; x++) {
          for (let y = 0; y < cellCount; y++) {
              const px = x * step + step/2;
              const py = y * step + step/2;
              ctx.beginPath();
              ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py);
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm);
              ctx.stroke();
          }
      }
  }
  return canvas.toDataURL();
}
