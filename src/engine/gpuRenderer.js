import { LAYERS_COUNT, TOOLS } from '../constants.js';

const QUAD_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_unitPos; // [0..1, 0..1]

uniform vec2 u_viewport;
uniform vec2 u_viewCenter;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_cosR;
uniform float u_sinR;
uniform float u_isMirrored;

// Quad world transform:
// Mode 0: axis-aligned world rect (u_rect = [wx, wy, w, h])
// Mode 1: centered rotated/scaled quad (u_rect = [cx, cy, w, h], u_localTransform = [scaleX, scaleY, cosL, sinL])
uniform int u_mode;
uniform vec4 u_rect;
uniform vec4 u_localTransform;

out vec2 v_uv;
out vec2 v_worldPos;

void main() {
    v_uv = a_unitPos;
    vec2 worldPos;

    if (u_mode == 0) {
        worldPos = u_rect.xy + a_unitPos * u_rect.zw;
    } else {
        vec2 local = (a_unitPos - 0.5) * u_rect.zw;
        local *= u_localTransform.xy; // scaleX (with mirrorX sign), scaleY (with mirrorY sign)
        float cosL = u_localTransform.z;
        float sinL = u_localTransform.w;
        vec2 rotated = vec2(
            local.x * cosL - local.y * sinL,
            local.x * sinL + local.y * cosL
        );
        worldPos = u_rect.xy + rotated;
    }

    v_worldPos = worldPos;

    float mx = u_isMirrored > 0.5 ? -worldPos.x : worldPos.x;
    float my = worldPos.y;

    float rx = mx * u_cosR - my * u_sinR;
    float ry = mx * u_sinR + my * u_cosR;

    vec2 screenPos = u_viewCenter + u_pan + vec2(rx, ry) * u_zoom;
    vec2 clipPos = vec2(
        (screenPos.x / u_viewport.x) * 2.0 - 1.0,
        1.0 - (screenPos.y / u_viewport.y) * 2.0
    );

    gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const QUAD_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec2 v_worldPos;

uniform sampler2D u_tex;
uniform vec4 u_solidColor;
uniform int u_useSolidColor;
uniform float u_opacity;
uniform int u_clipToBoard;
uniform vec2 u_boardHalfSize;

out vec4 outColor;

void main() {
    if (u_clipToBoard == 1) {
        if (abs(v_worldPos.x) > u_boardHalfSize.x || abs(v_worldPos.y) > u_boardHalfSize.y) {
            discard;
        }
    }

    if (u_useSolidColor == 1) {
        outColor = vec4(u_solidColor.rgb * u_solidColor.a * u_opacity, u_solidColor.a * u_opacity);
    } else {
        vec4 texColor = texture(u_tex, v_uv);
        outColor = texColor * u_opacity;
    }
}
`;

const GRID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_unitPos; // [0..1, 0..1]

uniform vec2 u_viewport;
uniform vec2 u_viewCenter;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_cosR;
uniform float u_sinR;
uniform float u_isMirrored;

out vec2 v_worldPos;

void main() {
    vec2 screenPos = a_unitPos * u_viewport;
    vec2 d = (screenPos - u_viewCenter - u_pan) / u_zoom;
    // Inverse rotation (-R)
    vec2 unrot = vec2(
        d.x * u_cosR + d.y * u_sinR,
        -d.x * u_sinR + d.y * u_cosR
    );
    if (u_isMirrored > 0.5) {
        unrot.x = -unrot.x;
    }
    v_worldPos = unrot;

    vec2 clipPos = vec2(
        a_unitPos.x * 2.0 - 1.0,
        1.0 - a_unitPos.y * 2.0
    );
    gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const GRID_FS = `#version 300 es
precision highp float;

in vec2 v_worldPos;

uniform float u_gridSize;
uniform float u_gridThickness;
uniform vec4 u_gridColor; // rgb + intensity in a
uniform int u_pattern; // 0: dots, 1: lines, 2: squares, 3: crosses
uniform float u_zoom;
uniform int u_clipToBoard;
uniform vec2 u_boardHalfSize;

out vec4 outColor;

void main() {
    if (u_clipToBoard == 1) {
        if (abs(v_worldPos.x) > u_boardHalfSize.x || abs(v_worldPos.y) > u_boardHalfSize.y) {
            discard;
        }
    }

    float stepSize = max(2.0, u_gridSize);
    vec2 cell = v_worldPos - floor(v_worldPos / stepSize) * stepSize;
    vec2 center = vec2(stepSize * 0.5);
    float aa = max(0.5 / max(u_zoom, 0.05), 0.35);
    float alpha = 0.0;

    if (u_pattern == 0) {
        // Dots at cell center
        float radius = max(0.5, u_gridThickness);
        float dist = length(cell - center);
        alpha = 1.0 - smoothstep(radius - aa, radius + aa, dist);
    } else if (u_pattern == 1) {
        // Horizontal lines
        float distY = min(cell.y, stepSize - cell.y);
        float halfW = max(0.5, u_gridThickness * 0.5);
        alpha = 1.0 - smoothstep(halfW - aa, halfW + aa, distY);
    } else if (u_pattern == 2) {
        // Squares (horizontal + vertical lines)
        float distX = min(cell.x, stepSize - cell.x);
        float distY = min(cell.y, stepSize - cell.y);
        float dist = min(distX, distY);
        float halfW = max(0.5, u_gridThickness * 0.5);
        alpha = 1.0 - smoothstep(halfW - aa, halfW + aa, dist);
    } else if (u_pattern == 3) {
        // Crosses at cell center
        float arm = max(1.0, u_gridThickness);
        vec2 d = abs(cell - center);
        float halfStroke = 0.65;
        float hBar = (1.0 - smoothstep(arm - aa, arm + aa, d.x)) * (1.0 - smoothstep(halfStroke - aa, halfStroke + aa, d.y));
        float vBar = (1.0 - smoothstep(arm - aa, arm + aa, d.y)) * (1.0 - smoothstep(halfStroke - aa, halfStroke + aa, d.x));
        alpha = max(hBar, vBar);
    }

    float finalA = alpha * u_gridColor.a;
    if (finalA <= 0.002) {
        discard;
    }
    outColor = vec4(u_gridColor.rgb * finalA, finalA);
}
`;

function parseHexColor(hex) {
  if (!hex || typeof hex !== 'string') return [1, 1, 1];
  const s = hex.trim();
  if (s.startsWith('#')) {
    if (s.length === 4) {
      return [
        parseInt(s[1] + s[1], 16) / 255,
        parseInt(s[2] + s[2], 16) / 255,
        parseInt(s[3] + s[3], 16) / 255
      ];
    }
    if (s.length >= 7) {
      return [
        parseInt(s.slice(1, 3), 16) / 255,
        parseInt(s.slice(3, 5), 16) / 255,
        parseInt(s.slice(5, 7), 16) / 255
      ];
    }
  }
  return [1, 1, 1];
}

export class GPURenderer {
  constructor(engine) {
    this.engine = engine;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'gpu-viewport-canvas';
    this.canvas.className = 'absolute inset-0 pointer-events-none';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.zIndex = '1';

    // Insert before canvasWrapper so UI overlays remain on top
    if (engine.container.firstChild) {
      engine.container.insertBefore(this.canvas, engine.container.firstChild);
    } else {
      engine.container.appendChild(this.canvas);
    }

    this.gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });

    this.supported = !!this.gl;
    this._renderPending = false;
    this.selectionTexture = null;

    if (this.supported) {
      this._initGL();
    }
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('WebGL2 Shader Error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('WebGL2 Program Link Error:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  _initGL() {
    const gl = this.gl;
    this.quadProgram = this._createProgram(QUAD_VS, QUAD_FS);
    this.gridProgram = this._createProgram(GRID_VS, GRID_FS);

    // Cache uniform locations for quadProgram
    this.quadLocs = {
      u_viewport: gl.getUniformLocation(this.quadProgram, 'u_viewport'),
      u_viewCenter: gl.getUniformLocation(this.quadProgram, 'u_viewCenter'),
      u_pan: gl.getUniformLocation(this.quadProgram, 'u_pan'),
      u_zoom: gl.getUniformLocation(this.quadProgram, 'u_zoom'),
      u_cosR: gl.getUniformLocation(this.quadProgram, 'u_cosR'),
      u_sinR: gl.getUniformLocation(this.quadProgram, 'u_sinR'),
      u_isMirrored: gl.getUniformLocation(this.quadProgram, 'u_isMirrored'),
      u_mode: gl.getUniformLocation(this.quadProgram, 'u_mode'),
      u_rect: gl.getUniformLocation(this.quadProgram, 'u_rect'),
      u_localTransform: gl.getUniformLocation(this.quadProgram, 'u_localTransform'),
      u_tex: gl.getUniformLocation(this.quadProgram, 'u_tex'),
      u_solidColor: gl.getUniformLocation(this.quadProgram, 'u_solidColor'),
      u_useSolidColor: gl.getUniformLocation(this.quadProgram, 'u_useSolidColor'),
      u_opacity: gl.getUniformLocation(this.quadProgram, 'u_opacity'),
      u_clipToBoard: gl.getUniformLocation(this.quadProgram, 'u_clipToBoard'),
      u_boardHalfSize: gl.getUniformLocation(this.quadProgram, 'u_boardHalfSize')
    };

    // Cache uniform locations for gridProgram
    this.gridLocs = {
      u_viewport: gl.getUniformLocation(this.gridProgram, 'u_viewport'),
      u_viewCenter: gl.getUniformLocation(this.gridProgram, 'u_viewCenter'),
      u_pan: gl.getUniformLocation(this.gridProgram, 'u_pan'),
      u_zoom: gl.getUniformLocation(this.gridProgram, 'u_zoom'),
      u_cosR: gl.getUniformLocation(this.gridProgram, 'u_cosR'),
      u_sinR: gl.getUniformLocation(this.gridProgram, 'u_sinR'),
      u_isMirrored: gl.getUniformLocation(this.gridProgram, 'u_isMirrored'),
      u_gridSize: gl.getUniformLocation(this.gridProgram, 'u_gridSize'),
      u_gridThickness: gl.getUniformLocation(this.gridProgram, 'u_gridThickness'),
      u_gridColor: gl.getUniformLocation(this.gridProgram, 'u_gridColor'),
      u_pattern: gl.getUniformLocation(this.gridProgram, 'u_pattern'),
      u_clipToBoard: gl.getUniformLocation(this.gridProgram, 'u_clipToBoard'),
      u_boardHalfSize: gl.getUniformLocation(this.gridProgram, 'u_boardHalfSize')
    };

    // Unit quad VAO [0,0] -> [1,1]
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const verts = new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      0, 1,
      1, 0,
      1, 1
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  _createOrUpdateTexture(existingTex, sourceCanvasOrImg, useLinear = true) {
    const gl = this.gl;
    let tex = existingTex;
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useLinear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, useLinear ? gl.LINEAR : gl.NEAREST);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvasOrImg);
    return tex;
  }

  markChunkLayerDirty(chunk, layer) {
    if (!chunk) return;
    if (!chunk.gpuDirty) {
      chunk.gpuDirty = new Array(LAYERS_COUNT).fill(true);
    }
    chunk.gpuDirty[layer] = true;
    this.requestRender();
  }

  markChunkStrokeDirty(chunk, active = true) {
    if (!chunk) return;
    chunk.gpuStrokeDirty = true;
    chunk.gpuStrokeActive = active;
    this.requestRender();
  }

  markAllChunksDirty() {
    this.engine.chunks.forEach(chunk => {
      chunk.gpuDirty = new Array(LAYERS_COUNT).fill(true);
      if (chunk.strokeCanvas) {
        chunk.gpuStrokeDirty = true;
      }
    });
    this.requestRender();
  }

  disposeChunkTextures(chunk) {
    if (!this.gl || !chunk) return;
    const gl = this.gl;
    if (chunk.gpuTextures) {
      for (const tex of chunk.gpuTextures) {
        if (tex) gl.deleteTexture(tex);
      }
      chunk.gpuTextures = null;
    }
    if (chunk.gpuStrokeTexture) {
      gl.deleteTexture(chunk.gpuStrokeTexture);
      chunk.gpuStrokeTexture = null;
    }
  }

  disposeAllTextures() {
    if (!this.gl) return;
    this.engine.chunks.forEach(chunk => this.disposeChunkTextures(chunk));
    this.engine.referenceImages.forEach(ref => {
      if (ref.gpuTexture) {
        this.gl.deleteTexture(ref.gpuTexture);
        ref.gpuTexture = null;
      }
    });
    if (this.selectionTexture) {
      this.gl.deleteTexture(this.selectionTexture);
      this.selectionTexture = null;
    }
  }

  requestRender() {
    if (!this.supported || this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      this.render();
    });
  }

  render() {
    if (!this.supported) return;
    const gl = this.gl;
    const engine = this.engine;
    const rect = engine.getContainerRect();
    if (!rect || !rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    gl.viewport(0, 0, targetW, targetH);

    // 1. Clear Desk / Infinite Canvas Background
    const bgRgb = parseHexColor(engine.canvasBg || '#ffffff');
    if (engine.isStatic) {
      // Desk dark background #18181c
      gl.clearColor(24 / 255, 24 / 255, 28 / 255, 1.0);
    } else {
      gl.clearColor(bgRgb[0], bgRgb[1], bgRgb[2], 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);

    const viewW = rect.width;
    const viewH = rect.height;
    const cx = Math.floor(viewW / 2);
    const cy = Math.floor(viewH / 2);
    const px = Math.round(engine.pan.x);
    const py = Math.round(engine.pan.y);
    const cosR = Math.cos(engine.rotation || 0);
    const sinR = Math.sin(engine.rotation || 0);
    const isMirrored = engine.isMirrored ? 1.0 : 0.0;
    const zoom = engine.zoom || 1.0;

    gl.bindVertexArray(this.vao);
    gl.useProgram(this.quadProgram);

    gl.uniform2f(this.quadLocs.u_viewport, viewW, viewH);
    gl.uniform2f(this.quadLocs.u_viewCenter, cx, cy);
    gl.uniform2f(this.quadLocs.u_pan, px, py);
    gl.uniform1f(this.quadLocs.u_zoom, zoom);
    gl.uniform1f(this.quadLocs.u_cosR, cosR);
    gl.uniform1f(this.quadLocs.u_sinR, sinR);
    gl.uniform1f(this.quadLocs.u_isMirrored, isMirrored);
    gl.uniform1i(this.quadLocs.u_tex, 0);
    gl.uniform2f(this.quadLocs.u_boardHalfSize, engine.staticWidth * 0.5, engine.staticHeight * 0.5);

    // 2. If Static Mode: Draw Drop Shadow, Brutalist 4px Border, and Paper Background
    if (engine.isStatic) {
      const halfW = engine.staticWidth * 0.5;
      const halfH = engine.staticHeight * 0.5;
      const borderW = 4.0 / zoom;
      const shadowOffset = 16.0 / zoom;

      gl.uniform1i(this.quadLocs.u_mode, 0);
      gl.uniform1i(this.quadLocs.u_useSolidColor, 1);
      gl.uniform1f(this.quadLocs.u_opacity, 1.0);
      gl.uniform1i(this.quadLocs.u_clipToBoard, 0);

      // Shadow
      gl.uniform4f(this.quadLocs.u_solidColor, 0, 0, 0, 1);
      gl.uniform4f(
        this.quadLocs.u_rect,
        -halfW + shadowOffset,
        -halfH + shadowOffset,
        engine.staticWidth + borderW,
        engine.staticHeight + borderW
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 4px Black Outline
      gl.uniform4f(
        this.quadLocs.u_rect,
        -halfW - borderW,
        -halfH - borderW,
        engine.staticWidth + borderW * 2.0,
        engine.staticHeight + borderW * 2.0
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Paper Surface
      gl.uniform4f(this.quadLocs.u_solidColor, bgRgb[0], bgRgb[1], bgRgb[2], 1.0);
      gl.uniform4f(this.quadLocs.u_rect, -halfW, -halfH, engine.staticWidth, engine.staticHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 3. Procedural World-Space Grid Shader (if visible)
    if (engine.showGrid && zoom > 0.01) {
      gl.useProgram(this.gridProgram);
      gl.uniform2f(this.gridLocs.u_viewport, viewW, viewH);
      gl.uniform2f(this.gridLocs.u_viewCenter, cx, cy);
      gl.uniform2f(this.gridLocs.u_pan, px, py);
      gl.uniform1f(this.gridLocs.u_zoom, zoom);
      gl.uniform1f(this.gridLocs.u_cosR, cosR);
      gl.uniform1f(this.gridLocs.u_sinR, sinR);
      gl.uniform1f(this.gridLocs.u_isMirrored, isMirrored);
      gl.uniform1f(this.gridLocs.u_gridSize, engine.gridSize || 20);
      gl.uniform1f(this.gridLocs.u_gridThickness, engine.gridThickness !== undefined ? engine.gridThickness : 2);

      const gRgb = parseHexColor(engine.gridColor || '#cccccc');
      const gInt = engine.gridIntensity !== undefined ? engine.gridIntensity : 1.0;
      gl.uniform4f(this.gridLocs.u_gridColor, gRgb[0], gRgb[1], gRgb[2], gInt);

      let pat = 0;
      if (engine.gridPattern === 'lines') pat = 1;
      else if (engine.gridPattern === 'squares') pat = 2;
      else if (engine.gridPattern === 'crosses') pat = 3;
      gl.uniform1i(this.gridLocs.u_pattern, pat);
      gl.uniform1i(this.gridLocs.u_clipToBoard, engine.isStatic ? 1 : 0);
      gl.uniform2f(this.gridLocs.u_boardHalfSize, engine.staticWidth * 0.5, engine.staticHeight * 0.5);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.useProgram(this.quadProgram);
    }

    // Compute visible world bounds for fast frustum culling
    const c0 = engine._screenToWorld(0, 0);
    const c1 = engine._screenToWorld(viewW, 0);
    const c2 = engine._screenToWorld(0, viewH);
    const c3 = engine._screenToWorld(viewW, viewH);
    const pad = 256 / zoom;
    const viewMinX = Math.min(c0.wx, c1.wx, c2.wx, c3.wx) - pad;
    const viewMaxX = Math.max(c0.wx, c1.wx, c2.wx, c3.wx) + pad;
    const viewMinY = Math.min(c0.wy, c1.wy, c2.wy, c3.wy) - pad;
    const viewMaxY = Math.max(c0.wy, c1.wy, c2.wy, c3.wy) + pad;

    // 4. Render Reference Images (Layer 0)
    const refLayerVisible = !engine.layerSettings[0] || engine.layerSettings[0].visible;
    if (refLayerVisible && engine.referenceImages.length > 0) {
      gl.uniform1i(this.quadLocs.u_mode, 1);
      gl.uniform1i(this.quadLocs.u_clipToBoard, 0);

      for (let i = 0; i < engine.referenceImages.length; i++) {
        const ref = engine.referenceImages[i];
        if (!ref.img || !ref.img.complete || !ref.img.width) continue;

        const imgW = ref.img.width;
        const imgH = ref.img.height;
        const halfDiag = Math.hypot(imgW, imgH) * (ref.scale || 1) * 0.5;

        if (
          ref.x + halfDiag < viewMinX ||
          ref.x - halfDiag > viewMaxX ||
          ref.y + halfDiag < viewMinY ||
          ref.y - halfDiag > viewMaxY
        ) {
          continue;
        }

        if (!ref.gpuTexture || ref.gpuDirty) {
          ref.gpuTexture = this._createOrUpdateTexture(ref.gpuTexture, ref.img, true);
          ref.gpuDirty = false;
        }

        const sc = ref.scale || 1.0;
        const sx = (ref.mirrorX ? -1.0 : 1.0) * sc;
        const sy = (ref.mirrorY ? -1.0 : 1.0) * sc;
        const cosL = Math.cos(ref.rotation || 0);
        const sinL = Math.sin(ref.rotation || 0);

        // Selected reference outline
        if (i === engine.selectedRefIndex) {
          const outPad = 4.0 / zoom;
          gl.uniform1i(this.quadLocs.u_useSolidColor, 1);
          gl.uniform1f(this.quadLocs.u_opacity, 0.9);
          gl.uniform4f(this.quadLocs.u_solidColor, 0.95, 0.78, 0.35, 1.0);
          gl.uniform4f(this.quadLocs.u_rect, ref.x, ref.y, imgW + outPad / sc, imgH + outPad / sc);
          gl.uniform4f(this.quadLocs.u_localTransform, sx, sy, cosL, sinL);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        gl.uniform1i(this.quadLocs.u_useSolidColor, 0);
        gl.uniform1f(this.quadLocs.u_opacity, ref.opacity !== undefined ? ref.opacity : 1.0);
        gl.uniform4f(this.quadLocs.u_rect, ref.x, ref.y, imgW, imgH);
        gl.uniform4f(this.quadLocs.u_localTransform, sx, sy, cosL, sinL);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ref.gpuTexture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // 5. Gather visible chunks for Paint Layers (1 .. LAYERS_COUNT - 1)
    const visibleChunks = [];
    engine.chunks.forEach(chunk => {
      const wx = engine.isStatic ? -engine.staticWidth * 0.5 : chunk.cx * engine.chunkSize;
      const wy = engine.isStatic ? -engine.staticHeight * 0.5 : chunk.cy * engine.chunkSize;
      const cw = chunk.width;
      const ch = chunk.height;

      if (wx + cw >= viewMinX && wx <= viewMaxX && wy + ch >= viewMinY && wy <= viewMaxY) {
        visibleChunks.push({ chunk, wx, wy, cw, ch });
      }
    });

    gl.uniform1i(this.quadLocs.u_mode, 0);
    gl.uniform1i(this.quadLocs.u_useSolidColor, 0);
    gl.uniform1i(this.quadLocs.u_clipToBoard, engine.isStatic ? 1 : 0);

    for (let layer = 1; layer < LAYERS_COUNT; layer++) {
      if (engine.layerSettings[layer] && !engine.layerSettings[layer].visible) {
        continue;
      }

      gl.uniform1f(this.quadLocs.u_opacity, 1.0);

      for (let i = 0; i < visibleChunks.length; i++) {
        const { chunk, wx, wy, cw, ch } = visibleChunks[i];
        if (!chunk.gpuTextures) {
          chunk.gpuTextures = new Array(LAYERS_COUNT).fill(null);
        }
        if (!chunk.gpuDirty) {
          chunk.gpuDirty = new Array(LAYERS_COUNT).fill(true);
        }

        const isEmpty = chunk.isEmpty && chunk.isEmpty[layer] && !chunk.gpuDirty[layer];
        if (isEmpty && !chunk.gpuTextures[layer]) continue;

        if (chunk.gpuDirty[layer] || !chunk.gpuTextures[layer]) {
          chunk.gpuTextures[layer] = this._createOrUpdateTexture(
            chunk.gpuTextures[layer],
            chunk.canvases[layer],
            true
          );
          chunk.gpuDirty[layer] = false;
        }

        gl.uniform4f(this.quadLocs.u_rect, wx, wy, cw, ch);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // Render active strokeCanvas immediately above activeLayer
      if (layer === engine.activeLayer && engine.isDrawing) {
        const strokeOpacity = engine.brush.type === TOOLS.AIR ? 1.0 : (engine.brush.opacity ?? 1.0);
        gl.uniform1f(this.quadLocs.u_opacity, strokeOpacity);

        for (let i = 0; i < visibleChunks.length; i++) {
          const { chunk, wx, wy, cw, ch } = visibleChunks[i];
          if (!chunk.strokeCanvas || !chunk.gpuStrokeActive) continue;

          if (chunk.gpuStrokeDirty || !chunk.gpuStrokeTexture) {
            chunk.gpuStrokeTexture = this._createOrUpdateTexture(
              chunk.gpuStrokeTexture,
              chunk.strokeCanvas,
              true
            );
            chunk.gpuStrokeDirty = false;
          }

          gl.uniform4f(this.quadLocs.u_rect, wx, wy, cw, ch);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, chunk.gpuStrokeTexture);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }

      // Render Floating Selection immediately above activeLayer
      if (layer === engine.activeLayer && engine.floatingSelection && engine.floatingSelection.canvas) {
        const sel = engine.floatingSelection;
        this.selectionTexture = this._createOrUpdateTexture(this.selectionTexture, sel.canvas, true);

        const selW = sel.width || sel.canvas.width;
        const selH = sel.height || sel.canvas.height;
        const pivotX = sel.x + selW * 0.5;
        const pivotY = sel.y + selH * 0.5;
        const scX = (sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1.0)) * (sel.mirrorX ? -1.0 : 1.0);
        const scY = (sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1.0)) * (sel.mirrorY ? -1.0 : 1.0);
        const rot = sel.rotation || 0;

        gl.uniform1i(this.quadLocs.u_mode, 1);
        gl.uniform1f(this.quadLocs.u_opacity, sel.opacity !== undefined ? sel.opacity : 1.0);
        gl.uniform4f(this.quadLocs.u_rect, pivotX, pivotY, sel.canvas.width, sel.canvas.height);
        gl.uniform4f(this.quadLocs.u_localTransform, scX, scY, Math.cos(rot), Math.sin(rot));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.selectionTexture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Restore mode 0 for remaining layers
        gl.uniform1i(this.quadLocs.u_mode, 0);
      }
    }

    gl.bindVertexArray(null);
  }
}
