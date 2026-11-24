/**
 * Zero-Overlay, Zero-Readback WebGL2 GPU Eraser Engine
 * Architecture:
 * - Sparse 256x256 GPU tile cache drawn from a reusable tile pool (orig RGBA8, mask RGBA8).
 * - Instanced stamp rendering with WebGL2 gl.MAX blend equation computes exact non-stacking
 *   per-pixel stroke mask across overlapping stamps in a single draw call per move batch
 *   (eliminating CPU getImageData/putImageData readbacks and coin-stacking loops).
 * - Pre-allocated 1024x1024 work FBOs composite orig * (1 - clamp(mask * brushOpacity, 0, 1))
 *   on GPU and blit dirty sub-rects directly into chunk.gpuTextures[layer].
 * - Canvas2D chunk synchronization runs once on endStroke() via destination-out on dirty
 *   tile sub-rects, preserving full Undo & Selection fidelity.
 */

import { backupChunkLayer } from '../engine/backupPool.js';

const TILE_SIZE = 256;
const WORK_SIZE = 1024;
const MAX_POOL_TILES = 48;
const FLOATS_PER_STAMP = 8; // [cx, cy, halfW, halfH, cosA, sinA, gain, pad]
const INITIAL_STAMP_CAP = 256;

const QUAD_UNIT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_unitPos;
out vec2 v_uv;
void main() {
  v_uv = a_unitPos;
  gl_Position = vec4(a_unitPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Maps world rect u_srcRect ([wx, wy, w, h]) into target world rect u_dstRect ([dx, dy, dw, dh])
const RECT_MAP_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_unitPos;
uniform vec4 u_srcRect;
uniform vec4 u_dstRect;
uniform vec4 u_uvSubRect;
out vec2 v_uv;
void main() {
  v_uv = u_uvSubRect.xy + a_unitPos * u_uvSubRect.zw;
  vec2 worldPos = u_srcRect.xy + a_unitPos * u_srcRect.zw;
  vec2 normDst = (worldPos - u_dstRect.xy) / u_dstRect.zw;
  gl_Position = vec4(normDst * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`;

// Instanced brush/chisel stamp vertex shader into workMask
const STAMP_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_unitPos;
layout(location = 1) in vec4 a_inst0; // [cx, cy, halfW, halfH]
layout(location = 2) in vec4 a_inst1; // [cosA, sinA, gain, unused]

uniform vec4 u_dstRect; // [workX, workY, WORK_SIZE, WORK_SIZE]

out vec2 v_uv;
out float v_gain;

void main() {
  v_uv = a_unitPos;
  v_gain = a_inst1.z;

  vec2 local = (a_unitPos * 2.0 - 1.0) * a_inst0.zw;
  float cosA = a_inst1.x;
  float sinA = a_inst1.y;
  vec2 worldPos = a_inst0.xy + vec2(
    local.x * cosA - local.y * sinA,
    local.x * sinA + local.y * cosA
  );
  vec2 norm = (worldPos - u_dstRect.xy) / u_dstRect.zw;
  gl_Position = vec4(norm * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_gain;

uniform sampler2D u_tip;
uniform int u_hasTip;

out vec4 outMask;

void main() {
  float tipA = (u_hasTip == 1) ? texture(u_tip, v_uv).a : 1.0;
  float targetA = clamp(tipA * v_gain, 0.0, 1.0);
  if (targetA <= 0.001) discard;
  outMask = vec4(targetA, targetA, targetA, targetA);
}
`;

// Premultiplied composite: orig * (1.0 - clamp(mask * brushOpacity, 0.0, 1.0))
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_orig;
uniform sampler2D u_mask;
uniform float u_brushOpacity;

out vec4 outColor;

void main() {
  vec4 orig = texture(u_orig, v_uv);
  if (orig.a <= 0.001) {
    outColor = vec4(0.0);
    return;
  }
  float m = clamp(texture(u_mask, v_uv).r * u_brushOpacity, 0.0, 1.0);
  outColor = orig * (1.0 - m);
}
`;

// End-of-stroke straight-alpha mask for Canvas2D destination-out commit
const COMMIT_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_mask;
uniform float u_brushOpacity;

out vec4 outColor;

void main() {
  float m = clamp(texture(u_mask, v_uv).r * u_brushOpacity, 0.0, 1.0);
  outColor = vec4(0.0, 0.0, 0.0, m);
}
`;

export class GpuEraserSolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer.gl;
    this.ready = false;
    this._pipelinesWarmed = false;

    this.active = false;
    this.lastBrushOpacity = 1.0;
    this._uploadedTipKey = null;

    this.activeTiles = new Map();
    this.tilePool = [];
    this.touchedChunks = new Map();

    this.instanceCap = INITIAL_STAMP_CAP;
    this.instanceData = new Float32Array(this.instanceCap * FLOATS_PER_STAMP);

    this._init();
  }

  _createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this.gpuRenderer._compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.gpuRenderer._compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('EraserGpu Program Link Error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _makeTexFBO(w, h, linear = true) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }
    return { tex, fbo };
  }

  _init() {
    const gl = this.gl;
    if (!gl) return;

    this.progRectMap = this._createProgram(RECT_MAP_VS, BLIT_FS);
    this.progStamp = this._createProgram(STAMP_VS, STAMP_FS);
    this.progComposite = this._createProgram(QUAD_UNIT_VS, COMPOSITE_FS);
    this.progCommitMask = this._createProgram(QUAD_UNIT_VS, COMMIT_MASK_FS);

    if (!this.progRectMap || !this.progStamp || !this.progComposite || !this.progCommitMask) {
      this.dispose();
      return;
    }

    this.workOrig = this._makeTexFBO(WORK_SIZE, WORK_SIZE, true);
    this.workMask = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false);
    this.workOut = this._makeTexFBO(WORK_SIZE, WORK_SIZE, true);
    this.tileCommitMask = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false);
    this.chunkBlitFbo = gl.createFramebuffer();

    if (!this.workOrig || !this.workMask || !this.workOut || !this.tileCommitMask || !this.chunkBlitFbo) {
      this.dispose();
      return;
    }

    // Instanced VAO for batched stamp quads
    this.stampVao = gl.createVertexArray();
    gl.bindVertexArray(this.stampVao);

    this.stampQuadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampQuadVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    this.stampInstVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampInstVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_STAMP * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Tip texture (populated with 2x2 white dummy until uploaded)
    this.tipTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      2,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255])
    );

    // Pre-warm 4 pooled 256x256 tiles so first stroke has zero FBO creation hitch
    for (let i = 0; i < 4; i++) {
      const t = this._allocTileGpu();
      if (t) this.tilePool.push(t);
    }

    // Cache uniform locations
    this.rectLocs = {
      u_srcRect: gl.getUniformLocation(this.progRectMap, 'u_srcRect'),
      u_dstRect: gl.getUniformLocation(this.progRectMap, 'u_dstRect'),
      u_uvSubRect: gl.getUniformLocation(this.progRectMap, 'u_uvSubRect'),
      u_tex: gl.getUniformLocation(this.progRectMap, 'u_tex')
    };
    this.stampLocs = {
      u_dstRect: gl.getUniformLocation(this.progStamp, 'u_dstRect'),
      u_tip: gl.getUniformLocation(this.progStamp, 'u_tip'),
      u_hasTip: gl.getUniformLocation(this.progStamp, 'u_hasTip')
    };
    this.compLocs = {
      u_orig: gl.getUniformLocation(this.progComposite, 'u_orig'),
      u_mask: gl.getUniformLocation(this.progComposite, 'u_mask'),
      u_brushOpacity: gl.getUniformLocation(this.progComposite, 'u_brushOpacity')
    };
    this.commitLocs = {
      u_mask: gl.getUniformLocation(this.progCommitMask, 'u_mask'),
      u_brushOpacity: gl.getUniformLocation(this.progCommitMask, 'u_brushOpacity')
    };

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ready = true;
  }

  _ensureInstanceCapacity(count) {
    if (count <= this.instanceCap) return;
    let nextCap = this.instanceCap;
    while (nextCap < count) nextCap *= 2;
    this.instanceCap = nextCap;
    this.instanceData = new Float32Array(nextCap * FLOATS_PER_STAMP);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampInstVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  _restoreDefaultGlState() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    gl.blendEquation(gl.FUNC_ADD);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.activeTexture(gl.TEXTURE0);
  }

  prewarmPipelines(tipCanvas = null, tipKey = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    if (tipCanvas && tipKey !== null) {
      this.uploadTipCanvas(tipCanvas, tipKey);
    }

    if (this._pipelinesWarmed) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      return;
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
    gl.clearColor(0, 0, 0, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOrig.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workMask.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. progRectMap
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOut.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.rectLocs.u_dstRect, 0, 0, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOrig.tex);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. progStamp (instanced + gl.MAX)
    this.instanceData[0] = 2;
    this.instanceData[1] = 2;
    this.instanceData[2] = 4;
    this.instanceData[3] = 4;
    this.instanceData[4] = 1;
    this.instanceData[5] = 0;
    this.instanceData[6] = 1;
    this.instanceData[7] = 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workMask.fbo);
    gl.useProgram(this.progStamp);
    gl.uniform4f(this.stampLocs.u_dstRect, 0, 0, WORK_SIZE, WORK_SIZE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.stampLocs.u_tip, 0);
    gl.uniform1i(this.stampLocs.u_hasTip, 1);

    gl.bindVertexArray(this.stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampInstVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, FLOATS_PER_STAMP));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // 3. progComposite
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOut.fbo);
    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOrig.tex);
    gl.uniform1i(this.compLocs.u_orig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workMask.tex);
    gl.uniform1i(this.compLocs.u_mask, 1);
    gl.uniform1f(this.compLocs.u_brushOpacity, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. progCommitMask
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.tileCommitMask.fbo);
    gl.useProgram(this.progCommitMask);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workMask.tex);
    gl.uniform1i(this.commitLocs.u_mask, 0);
    gl.uniform1f(this.commitLocs.u_brushOpacity, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this._restoreDefaultGlState();
    this._pipelinesWarmed = true;
  }

  _allocTileGpu() {
    const orig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false);
    const mask = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false);
    if (!orig || !mask) {
      const gl = this.gl;
      if (orig) { gl.deleteFramebuffer(orig.fbo); gl.deleteTexture(orig.tex); }
      if (mask) { gl.deleteFramebuffer(mask.fbo); gl.deleteTexture(mask.tex); }
      return null;
    }
    return {
      orig,
      mask,
      tx: 0,
      ty: 0,
      wx: 0,
      wy: 0,
      dirty: false,
      hasContent: false,
      minX: TILE_SIZE,
      minY: TILE_SIZE,
      maxX: 0,
      maxY: 0
    };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    if (t.orig) {
      if (t.orig.fbo) gl.deleteFramebuffer(t.orig.fbo);
      if (t.orig.tex) gl.deleteTexture(t.orig.tex);
    }
    if (t.mask) {
      if (t.mask.fbo) gl.deleteFramebuffer(t.mask.fbo);
      if (t.mask.tex) gl.deleteTexture(t.mask.tex);
    }
  }

  _releaseAllTiles() {
    this.activeTiles.forEach((tile) => {
      if (this.tilePool.length < MAX_POOL_TILES) {
        tile.dirty = false;
        tile.hasContent = false;
        tile.minX = TILE_SIZE;
        tile.minY = TILE_SIZE;
        tile.maxX = 0;
        tile.maxY = 0;
        this.tilePool.push(tile);
      } else {
        this._destroyTileGpu(tile);
      }
    });
    this.activeTiles.clear();
  }

  uploadTipCanvas(tipCanvasOrImg, tipKey) {
    if (!this.ready || !this.tipTex || !tipCanvasOrImg) return;
    if (tipKey !== null && tipKey !== undefined && this._uploadedTipKey === tipKey) return;
    const w = tipCanvasOrImg.width || tipCanvasOrImg.naturalWidth || 0;
    const h = tipCanvasOrImg.height || tipCanvasOrImg.naturalHeight || 0;
    if (w <= 0 || h <= 0) return;

    this._uploadedTipKey = tipKey;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tipCanvasOrImg);
  }

  _ensureChunkBackup(engine, chunk, cx, cy, wasEmptyOverride = false) {
    const id = `${cx},${cy}`;
    const touched = this.touchedChunks.get(id);
    const wasEmpty = touched ? touched.wasEmpty : wasEmptyOverride;
    backupChunkLayer(engine, chunk, id, {
      layer: engine.activeLayer,
      dirtyIsEmpty: false,
      wasEmpty
    });
  }

  _ensureTile(engine, tx, ty) {
    const key = `${tx},${ty}`;
    let tile = this.activeTiles.get(key);
    if (tile) return tile;

    const layer = engine.activeLayer;
    const wx = tx * TILE_SIZE;
    const wy = ty * TILE_SIZE;

    const sCX = engine.isStatic ? 0 : Math.floor(wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((wy + TILE_SIZE - 1) / engine.chunkSize);

    // Gather overlapping chunks that actually contain pixels
    let contentChunks = null;
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
        if (!chunk) continue;
        const isEmpty = chunk.isEmpty && chunk.isEmpty[layer] &&
          (!chunk.gpuDirty || !chunk.gpuDirty[layer]) &&
          (!chunk.gpuTextures || !chunk.gpuTextures[layer]);
        if (isEmpty) continue;
        if (!contentChunks) contentChunks = [];
        contentChunks.push({ chunk, cx, cy });
      }
    }

    tile = this.tilePool.length > 0 ? this.tilePool.pop() : this._allocTileGpu();
    if (!tile) return null;

    tile.tx = tx;
    tile.ty = ty;
    tile.wx = wx;
    tile.wy = wy;
    tile.dirty = false;
    tile.minX = TILE_SIZE;
    tile.minY = TILE_SIZE;
    tile.maxX = 0;
    tile.maxY = 0;

    if (!contentChunks) {
      tile.hasContent = false;
      this.activeTiles.set(key, tile);
      return tile;
    }

    tile.hasContent = true;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);

    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.mask.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.orig.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_dstRect, wx, wy, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

    for (let i = 0; i < contentChunks.length; i++) {
      const { chunk, cx, cy } = contentChunks[i];
      if (!chunk.gpuTextures) chunk.gpuTextures = new Array(engine.layerSettings.length).fill(null);
      if (!chunk.gpuDirty) chunk.gpuDirty = new Array(engine.layerSettings.length).fill(true);
      if (chunk.gpuDirty[layer] || !chunk.gpuTextures[layer]) {
        chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(
          chunk.gpuTextures[layer],
          chunk.canvases[layer],
          true
        );
        chunk.gpuDirty[layer] = false;
      }

      const cwx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
      const cwy = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
      gl.uniform4f(this.rectLocs.u_srcRect, cwx, cwy, chunk.width, chunk.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    this.activeTiles.set(key, tile);
    return tile;
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH) {
    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);

    const tiles = [];
    let anyContent = false;
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureTile(engine, tx, ty);
        if (t && t.hasContent) {
          tiles.push(t);
          anyContent = true;
        }
      }
    }
    if (!anyContent || tiles.length === 0) return null;

    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOrig.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workMask.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_dstRect, workX, workY, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.rectLocs.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOrig.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.orig.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workMask.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.mask.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.disable(gl.SCISSOR_TEST);
    return tiles;
  }

  _storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Write updated workMask back into touched sparse tiles
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workMask.tex);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const ox = Math.max(workX, t.wx);
      const oy = Math.max(workY, t.wy);
      const ox2 = Math.min(workX + boxW, t.wx + TILE_SIZE);
      const oy2 = Math.min(workY + boxH, t.wy + TILE_SIZE);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const lx0 = ox - t.wx;
      const ly0 = oy - t.wy;
      t.dirty = true;
      if (lx0 < t.minX) t.minX = lx0;
      if (ly0 < t.minY) t.minY = ly0;
      if (lx0 + ow > t.maxX) t.maxX = lx0 + ow;
      if (ly0 + oh > t.maxY) t.maxY = ly0 + oh;

      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(lx0, ly0, ow, oh);
      gl.uniform4f(this.rectLocs.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.mask.fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 2. Blit composited workOut straight onto chunk.gpuTextures[layer] on GPU (0 readback, 0 overlay seams)
    const layer = engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor(workX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((workX + boxW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(workY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((workY + boxH - 1) / engine.chunkSize);

    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, boxW, boxH);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, boxW / WORK_SIZE, boxH / WORK_SIZE);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOut.tex);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
        if (!chunk) continue;
        if (chunk.isEmpty && chunk.isEmpty[layer] && (!chunk.gpuTextures || !chunk.gpuTextures[layer])) {
          continue;
        }

        if (!chunk.gpuTextures) chunk.gpuTextures = new Array(engine.layerSettings.length).fill(null);
        if (!chunk.gpuDirty) chunk.gpuDirty = new Array(engine.layerSettings.length).fill(false);
        if (!chunk.gpuTextures[layer] || chunk.gpuDirty[layer]) {
          chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(
            chunk.gpuTextures[layer],
            chunk.canvases[layer],
            true
          );
          chunk.gpuDirty[layer] = false;
        }

        const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
        const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
        const ox = Math.max(workX, lx);
        const oy = Math.max(workY, ly);
        const ox2 = Math.min(workX + boxW, lx + chunk.width);
        const oy2 = Math.min(workY + boxH, ly + chunk.height);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow <= 0 || oh <= 0) continue;

        const texW = chunk.canvases[layer].width;
        const texH = chunk.canvases[layer].height;
        const scaleX = texW / chunk.width;
        const scaleY = texH / chunk.height;

        const sx = Math.max(0, Math.floor((ox - lx) * scaleX));
        const sy = Math.max(0, Math.floor((oy - ly) * scaleY));
        const ex = Math.min(texW, Math.ceil((ox2 - lx) * scaleX));
        const ey = Math.min(texH, Math.ceil((oy2 - ly) * scaleY));
        const sw = ex - sx;
        const sh = ey - sy;
        if (sw <= 0 || sh <= 0) continue;

        const id = `${cx},${cy}`;
        if (!this.touchedChunks.has(id)) {
          this.touchedChunks.set(id, { cx, cy, chunk, wasEmpty: !!(chunk.isEmpty && chunk.isEmpty[layer]) });
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.workOut.tex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, chunk.gpuTextures[layer], 0);
        gl.viewport(0, 0, texW, texH);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, sy, sw, sh);
        gl.uniform4f(this.rectLocs.u_dstRect, lx, ly, chunk.width, chunk.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    this._restoreDefaultGlState();
  }

  _runBatch(engine, stamps, minX, minY, maxX, maxY, flow, brushOpacity, hasTip) {
    const workX = Math.floor(minX) - 2;
    const workY = Math.floor(minY) - 2;
    const boxW = Math.min(WORK_SIZE, Math.max(4, Math.ceil(maxX) + 2 - workX));
    const boxH = Math.min(WORK_SIZE, Math.max(4, Math.ceil(maxY) + 2 - workY));

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    if (!tiles) return;

    const count = stamps.length;
    this._ensureInstanceCapacity(count);

    const data = this.instanceData;
    const aspectY = hasTip ? 0.5 : 0.25;
    for (let i = 0; i < count; i++) {
      const s = stamps[i];
      const base = i * FLOATS_PER_STAMP;
      const curSize = Math.max(1.0, s.size);
      const halfW = curSize * 0.5;
      const halfH = curSize * aspectY;
      const angle = s.angle || 0.0;
      const gain = Math.max(0.0, Math.min(1.0, (s.opacity !== undefined ? s.opacity : 1.0) * flow));

      data[base] = s.x;
      data[base + 1] = s.y;
      data[base + 2] = halfW;
      data[base + 3] = halfH;
      data[base + 4] = angle === 0.0 ? 1.0 : Math.cos(angle);
      data[base + 5] = angle === 0.0 ? 0.0 : Math.sin(angle);
      data[base + 6] = gain;
      data[base + 7] = 0.0;
    }

    const gl = this.gl;
    try {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, boxW, boxH);
      gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

      // 1. Instanced MAX-blend all stamps into workMask in 1 draw call
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workMask.fbo);
      gl.useProgram(this.progStamp);
      gl.uniform4f(this.stampLocs.u_dstRect, workX, workY, WORK_SIZE, WORK_SIZE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
      gl.uniform1i(this.stampLocs.u_tip, 0);
      gl.uniform1i(this.stampLocs.u_hasTip, hasTip ? 1 : 0);

      gl.bindVertexArray(this.stampVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stampInstVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * FLOATS_PER_STAMP));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    } finally {
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
    }

    // 2. Composite orig * (1 - clamp(mask * brushOpacity, 0, 1)) -> workOut
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOut.fbo);
    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOrig.tex);
    gl.uniform1i(this.compLocs.u_orig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workMask.tex);
    gl.uniform1i(this.compLocs.u_mask, 1);
    gl.uniform1f(this.compLocs.u_brushOpacity, brushOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Persist workMask -> tiles & blit workOut -> chunk.gpuTextures[layer]
    this._storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH);
  }

  beginStroke() {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    this._releaseAllTiles();
    this.touchedChunks.clear();
    this.lastBrushOpacity = 1.0;
    this.active = true;
    return true;
  }

  stepStamps(engine, stamps, flow, brushOpacity, tipCanvas = null, tipKey = null) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost() || !stamps || stamps.length === 0) return;

    this.lastBrushOpacity = Math.max(0.0, Math.min(1.0, brushOpacity));
    const hasTip = !!(tipCanvas && (tipCanvas.width || tipCanvas.naturalWidth || 0) > 0);
    if (hasTip) {
      this.uploadTipCanvas(tipCanvas, tipKey);
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const sR = Math.max(1.0, s.size * 0.5);
      const boundR = Math.ceil(sR * (s.angle ? 1.42 : 1.02)) + 4;
      if (s.x - boundR < minX) minX = s.x - boundR;
      if (s.y - boundR < minY) minY = s.y - boundR;
      if (s.x + boundR > maxX) maxX = s.x + boundR;
      if (s.y + boundR > maxY) maxY = s.y + boundR;
    }

    const totalW = Math.ceil(maxX) - Math.floor(minX) + 6;
    const totalH = Math.ceil(maxY) - Math.floor(minY) + 6;

    if (totalW <= WORK_SIZE && totalH <= WORK_SIZE) {
      this._runBatch(engine, stamps, minX, minY, maxX, maxY, flow, this.lastBrushOpacity, hasTip);
    } else {
      // Tile arbitrarily huge brush sizes or fast flicks into WORK_SIZE blocks cleanly
      const xStart = Math.floor(minX);
      const yStart = Math.floor(minY);
      const xEnd = Math.ceil(maxX);
      const yEnd = Math.ceil(maxY);
      const stepSpan = WORK_SIZE - 8;

      for (let wy = yStart; wy < yEnd; wy += stepSpan) {
        const wy2 = Math.min(yEnd, wy + stepSpan);
        for (let wx = xStart; wx < xEnd; wx += stepSpan) {
          const wx2 = Math.min(xEnd, wx + stepSpan);
          const sub = [];
          for (let i = 0; i < stamps.length; i++) {
            const s = stamps[i];
            const sR = Math.max(1.0, s.size * 0.5);
            const boundR = Math.ceil(sR * (s.angle ? 1.42 : 1.02)) + 4;
            if (s.x + boundR >= wx && s.x - boundR <= wx2 &&
                s.y + boundR >= wy && s.y - boundR <= wy2) {
              sub.push(s);
            }
          }
          if (sub.length > 0) {
            this._runBatch(engine, sub, wx, wy, wx2, wy2, flow, this.lastBrushOpacity, hasTip);
          }
        }
      }
    }

    this.gpuRenderer.requestRender();
  }

  _commitTilesToChunks(engine) {
    if (this.activeTiles.size === 0) return;

    const gl = this.gl;
    const layer = engine.activeLayer;
    const keepExistingGpuTex = !engine.activeSelectionPath && (!engine.isStatic || (engine.dpiScale || 1) <= 1);

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    this.activeTiles.forEach((t) => {
      if (!t.dirty || !t.hasContent || t.maxX <= t.minX || t.maxY <= t.minY) return;

      const rx0 = Math.max(0, t.minX | 0);
      const ry0 = Math.max(0, t.minY | 0);
      const rx1 = Math.min(TILE_SIZE, Math.ceil(t.maxX));
      const ry1 = Math.min(TILE_SIZE, Math.ceil(t.maxY));
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      if (rw <= 0 || rh <= 0) return;

      gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(rx0, ry0, rw, rh);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tileCommitMask.fbo);
      gl.useProgram(this.progCommitMask);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.mask.tex);
      gl.uniform1i(this.commitLocs.u_mask, 0);
      gl.uniform1f(this.commitLocs.u_brushOpacity, this.lastBrushOpacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const byteLen = rw * rh * 4;
      const view = this._readBuf.subarray(0, byteLen);
      gl.readPixels(rx0, ry0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view);

      const imgData = new ImageData(new Uint8ClampedArray(view), rw, rh);
      this._commitCtx.putImageData(imgData, 0, 0);

      const worldMinX = t.wx + rx0;
      const worldMinY = t.wy + ry0;
      engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, worldMinX);
      engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, worldMinX + rw);
      engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, worldMinY);
      engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, worldMinY + rh);

      const sCX = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
      const eCX = engine.isStatic ? 0 : Math.floor((worldMinX + rw - 1) / engine.chunkSize);
      const sCY = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
      const eCY = engine.isStatic ? 0 : Math.floor((worldMinY + rh - 1) / engine.chunkSize);

      for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
          const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
          if (!chunk) continue;
          if (chunk.isEmpty && chunk.isEmpty[layer] && !this.touchedChunks.has(`${cx},${cy}`)) continue;

          const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
          const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
          const ox = Math.max(worldMinX, lx);
          const oy = Math.max(worldMinY, ly);
          const ox2 = Math.min(worldMinX + rw, lx + chunk.width);
          const oy2 = Math.min(worldMinY + rh, ly + chunk.height);
          const ow = ox2 - ox;
          const oh = oy2 - oy;
          if (ow <= 0 || oh <= 0) continue;

          this._ensureChunkBackup(engine, chunk, cx, cy, false);

          const ctx = chunk.ctxs[layer];
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, chunk.width, chunk.height);
          ctx.clip();
          ctx.globalAlpha = 1.0;
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(this._commitCanvas, ox - worldMinX, oy - worldMinY, ow, oh, ox - lx, oy - ly, ow, oh);
          ctx.restore();

          engine._markDirty(`${cx},${cy}`, layer, false);
          if (keepExistingGpuTex && chunk.gpuTextures && chunk.gpuTextures[layer] && chunk.gpuDirty) {
            chunk.gpuDirty[layer] = false;
          }
        }
      }
    });

    this._restoreDefaultGlState();
  }

  endStroke(engine) {
    if (!this.ready || !this.active) return;

    this._commitTilesToChunks(engine);
    this._releaseAllTiles();
    this.touchedChunks.clear();

    this.active = false;
    this.gpuRenderer.requestRender();
  }

  cancel(engine = null) {
    const targetEngine = engine || (this.gpuRenderer ? this.gpuRenderer.engine : null);
    const layer = targetEngine ? targetEngine.activeLayer : -1;
    if (layer >= 0 && this.touchedChunks.size > 0) {
      this.touchedChunks.forEach(({ chunk }) => {
        if (chunk && chunk.gpuDirty) {
          chunk.gpuDirty[layer] = true;
        }
      });
    }
    this._releaseAllTiles();
    this.touchedChunks.clear();
    this.active = false;
    this._restoreDefaultGlState();
    if (this.gpuRenderer) {
      this.gpuRenderer.requestRender();
    }
  }

  resetProjectState() {
    this.cancel(null);
    while (this.tilePool.length > 4) {
      this._destroyTileGpu(this.tilePool.pop());
    }
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    this._releaseAllTiles();
    for (const t of this.tilePool) {
      this._destroyTileGpu(t);
    }
    this.tilePool = [];

    const delTexFbo = (o) => {
      if (!o) return;
      if (o.fbo) gl.deleteFramebuffer(o.fbo);
      if (o.tex) gl.deleteTexture(o.tex);
    };
    [this.workOrig, this.workMask, this.workOut, this.tileCommitMask].forEach(delTexFbo);
    if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
    if (this.stampInstVbo) gl.deleteBuffer(this.stampInstVbo);
    if (this.stampQuadVbo) gl.deleteBuffer(this.stampQuadVbo);
    if (this.stampVao) gl.deleteVertexArray(this.stampVao);
    if (this.tipTex) gl.deleteTexture(this.tipTex);
    [this.progRectMap, this.progStamp, this.progComposite, this.progCommitMask].forEach((p) => {
      if (p) gl.deleteProgram(p);
    });
    this._commitCanvas = null;
    this._commitCtx = null;
    this._readBuf = null;
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
    this._uploadedTipKey = null;
  }
}
