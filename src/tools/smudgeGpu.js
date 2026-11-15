/**
 * Zero-Overlay, Zero-Readback WebGL2 GPU Smudge Engine
 * Architecture:
 * - No 1024x1024 sliding window (eliminates all mid-stroke recentering / readPixels baking stalls).
 * - No gpuRenderer.smudgeOverlay or u_excludeActive cutout (eliminates all white GPU transition seams).
 * - Sparse 256x256 GPU tile cache drawn from a reusable tile pool (orig RGBA8, sim RGBA16F/RGBA8, cov RGBA8).
 * - Pre-allocated 1024x1024 work FBOs assemble only touched 256x256 tiles per move, run 64x64 pickup
 *   + convex premultiplied deposit + coverage envelope compositing entirely on GPU, store updated tiles,
 *   and blit the dirty sub-rect directly into chunk.gpuTextures[layer] on GPU.
 * - Canvas2D chunk synchronization runs once on endStroke() with full Undo & Selection fidelity.
 */

const TILE_SIZE = 256;
const WORK_SIZE = 1024;
const MAX_POOL_TILES = 48;

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

// Pass A: Pick up pre-deposit workSim pixels across rotated 64x64 carried smudge buffer
const PICKUP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_sim;
uniform sampler2D u_prevBuf;
uniform sampler2D u_tip;
uniform vec2 u_workOrigin;
uniform vec2 u_workSize;
uniform vec4 u_uvClamp;
uniform vec2 u_stampPos;
uniform float u_radius;
uniform float u_cosFwd;
uniform float u_sinFwd;
uniform float u_pickupBase;
uniform int u_isFirstPickup;

out vec4 outBuf;

void main() {
  vec2 n = v_uv * 2.0 - 1.0;
  vec2 local = n * u_radius;
  vec2 worldPos = u_stampPos + vec2(
    local.x * u_cosFwd - local.y * u_sinFwd,
    local.x * u_sinFwd + local.y * u_cosFwd
  );
  vec2 workUv = clamp((worldPos - u_workOrigin) / u_workSize, u_uvClamp.xy, u_uvClamp.zw);
  vec4 sampled = texture(u_sim, workUv);

  if (u_isFirstPickup == 1) {
    outBuf = sampled;
    return;
  }

  vec4 prevBuf = texture(u_prevBuf, v_uv);
  if (u_pickupBase <= 0.001) {
    outBuf = prevBuf;
    return;
  }

  float mask = texture(u_tip, v_uv).r;
  if (mask <= 0.002) {
    outBuf = prevBuf;
    return;
  }

  float p = clamp(u_pickupBase * (0.25 + 0.75 * mask), 0.0, 1.0);
  outBuf = mix(prevBuf, sampled, p);
}
`;

// Pass B (MRT): Deposit carried smudge buffer onto workSim via convex premultiplied lerp + monotonic coverage
const DEPOSIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_sim;
uniform sampler2D u_cov;
uniform sampler2D u_buf;
uniform sampler2D u_tip;
uniform vec2 u_workOrigin;
uniform vec2 u_stampPos;
uniform float u_radius;
uniform float u_cosInv;
uniform float u_sinInv;
uniform float u_depositBase;
uniform float u_effOpacity;
uniform int u_alphaLock;

layout(location = 0) out vec4 outSim;
layout(location = 1) out vec4 outCov;

void main() {
  vec4 sim = texture(u_sim, v_uv);
  vec4 cov = texture(u_cov, v_uv);

  if (u_depositBase <= 0.001) {
    outSim = sim;
    outCov = cov;
    return;
  }

  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;
  vec2 d = worldPos - u_stampPos;
  vec2 local = vec2(
    d.x * u_cosInv - d.y * u_sinInv,
    d.x * u_sinInv + d.y * u_cosInv
  );
  vec2 n = local / max(2.0, u_radius);
  if (n.x <= -1.0 || n.x >= 1.0 || n.y <= -1.0 || n.y >= 1.0) {
    outSim = sim;
    outCov = cov;
    return;
  }

  vec2 tipUv = n * 0.5 + 0.5;
  float mask = texture(u_tip, tipUv).r;
  if (mask <= 0.002) {
    outSim = sim;
    outCov = cov;
    return;
  }

  vec4 carried = texture(u_buf, tipUv);
  float w = clamp(u_depositBase * mask, 0.0, 1.0);
  vec4 nextSim = sim;

  if (u_alphaLock == 1) {
    if (sim.a > 0.002 && carried.a > 0.002) {
      vec3 dCol = sim.rgb / sim.a;
      vec3 bCol = carried.rgb / carried.a;
      vec3 mixCol = clamp(mix(dCol, bCol, w), 0.0, 1.0);
      nextSim = vec4(mixCol * sim.a, sim.a);
    }
  } else {
    nextSim = mix(sim, carried, w);
  }

  nextSim = clamp(nextSim, 0.0, 1.0);
  nextSim.rgb = min(nextSim.rgb, vec3(nextSim.a));

  float covVal = max(cov.r, clamp(u_effOpacity * mask, 0.0, 1.0));
  outSim = nextSim;
  outCov = vec4(covVal, 0.0, 0.0, 1.0);
}
`;

// Pass C: Composite final = lerp(orig, sim, cov) honoring alphaLock
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_orig;
uniform sampler2D u_sim;
uniform sampler2D u_cov;
uniform int u_alphaLock;

out vec4 outColor;

void main() {
  vec4 orig = texture(u_orig, v_uv);
  float c = texture(u_cov, v_uv).r;
  if (c <= 0.0005) {
    outColor = orig;
    return;
  }

  vec4 sim = texture(u_sim, v_uv);
  vec4 res = mix(orig, sim, c);

  if (u_alphaLock == 1) {
    if (orig.a <= 0.001) {
      res = vec4(0.0);
    } else {
      float ratio = (res.a > 0.001) ? (orig.a / res.a) : 0.0;
      res = vec4(clamp(res.rgb * ratio, 0.0, orig.a), orig.a);
    }
  }

  res = clamp(res, 0.0, 1.0);
  res.rgb = min(res.rgb, vec3(res.a));
  outColor = res;
}
`;

// Pass D (endStroke commit only): Unpremultiply -> straight RGBA for Canvas2D chunks
const UNPREMULT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outRgba;
void main() {
  vec4 p = texture(u_tex, v_uv);
  if (p.a <= 0.002) {
    outRgba = vec4(0.0);
  } else {
    outRgba = vec4(clamp(p.rgb / p.a, 0.0, 1.0), p.a);
  }
}
`;

export class GpuSmudgeSolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer.gl;
    this.ready = false;

    this.bufRes = 64;
    this.active = false;
    this.isFloat = false;
    this.dirtyBuf = false;
    this.curWorkIdx = 0;
    this.curBufIdx = 0;

    this.activeTiles = new Map(); // key "tx,ty" -> tile object
    this.tilePool = [];           // reusable GPU tiles (0 stroke-time allocation after warmup)
    this.touchedChunks = new Map(); // id -> { cx, cy, chunk }

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
      console.error('SmudgeGpu Program Link Error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _makeTexFBO(w, h, useFloat, linear = true) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    if (useFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

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

  _makeMrtFbo(texA, texB) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      return null;
    }
    return fbo;
  }

  _init() {
    const gl = this.gl;
    if (!gl) return;

    const hasColorFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalfFloat = hasColorFloat || !!gl.getExtension('EXT_color_buffer_half_float');

    this.progRectMap = this._createProgram(RECT_MAP_VS, BLIT_FS);
    this.progBlit = this._createProgram(QUAD_UNIT_VS, BLIT_FS);
    this.progPickup = this._createProgram(QUAD_UNIT_VS, PICKUP_FS);
    this.progDeposit = this._createProgram(QUAD_UNIT_VS, DEPOSIT_FS);
    this.progComposite = this._createProgram(QUAD_UNIT_VS, COMPOSITE_FS);
    this.progUnpremult = this._createProgram(QUAD_UNIT_VS, UNPREMULT_FS);

    if (!this.progRectMap || !this.progBlit || !this.progPickup || !this.progDeposit || !this.progComposite || !this.progUnpremult) {
      return;
    }

    let useFloat = hasHalfFloat;
    let testSim = useFloat ? this._makeTexFBO(WORK_SIZE, WORK_SIZE, true, true) : null;
    if (!testSim) {
      useFloat = false;
      testSim = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    }
    this.isFloat = useFloat;
    this.workSimA = testSim;
    this.workSimB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workOrig = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workCovA = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workCovB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workOut = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);

    this.bufA = this._makeTexFBO(this.bufRes, this.bufRes, useFloat, true);
    this.bufB = this._makeTexFBO(this.bufRes, this.bufRes, useFloat, true);

    // Scratch FBOs for endStroke 256x256 tile commit + GPU chunk texture attach
    this.tileCommitPre = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, true);
    this.tileCommitStraight = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, true);
    this.chunkBlitFbo = gl.createFramebuffer();

    if (!this.workSimA || !this.workSimB || !this.workOrig || !this.workCovA || !this.workCovB ||
        !this.workOut || !this.bufA || !this.bufB || !this.tileCommitPre || !this.tileCommitStraight || !this.chunkBlitFbo) {
      this.dispose();
      return;
    }

    this.mrtWorkA = this._makeMrtFbo(this.workSimA.tex, this.workCovA.tex);
    this.mrtWorkB = this._makeMrtFbo(this.workSimB.tex, this.workCovB.tex);
    if (!this.mrtWorkA || !this.mrtWorkB) {
      this.dispose();
      return;
    }

    this.tipTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.bufRes, this.bufRes, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.tipUploadBytes = new Uint8Array(this.bufRes * this.bufRes * 4);

    // Pre-warm 4 pooled 256x256 tiles so first stroke has zero FBO creation lag
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
    this.blitLocs = {
      u_tex: gl.getUniformLocation(this.progBlit, 'u_tex')
    };
    this.pickupLocs = {
      u_sim: gl.getUniformLocation(this.progPickup, 'u_sim'),
      u_prevBuf: gl.getUniformLocation(this.progPickup, 'u_prevBuf'),
      u_tip: gl.getUniformLocation(this.progPickup, 'u_tip'),
      u_workOrigin: gl.getUniformLocation(this.progPickup, 'u_workOrigin'),
      u_workSize: gl.getUniformLocation(this.progPickup, 'u_workSize'),
      u_uvClamp: gl.getUniformLocation(this.progPickup, 'u_uvClamp'),
      u_stampPos: gl.getUniformLocation(this.progPickup, 'u_stampPos'),
      u_radius: gl.getUniformLocation(this.progPickup, 'u_radius'),
      u_cosFwd: gl.getUniformLocation(this.progPickup, 'u_cosFwd'),
      u_sinFwd: gl.getUniformLocation(this.progPickup, 'u_sinFwd'),
      u_pickupBase: gl.getUniformLocation(this.progPickup, 'u_pickupBase'),
      u_isFirstPickup: gl.getUniformLocation(this.progPickup, 'u_isFirstPickup')
    };
    this.depositLocs = {
      u_sim: gl.getUniformLocation(this.progDeposit, 'u_sim'),
      u_cov: gl.getUniformLocation(this.progDeposit, 'u_cov'),
      u_buf: gl.getUniformLocation(this.progDeposit, 'u_buf'),
      u_tip: gl.getUniformLocation(this.progDeposit, 'u_tip'),
      u_workOrigin: gl.getUniformLocation(this.progDeposit, 'u_workOrigin'),
      u_stampPos: gl.getUniformLocation(this.progDeposit, 'u_stampPos'),
      u_radius: gl.getUniformLocation(this.progDeposit, 'u_radius'),
      u_cosInv: gl.getUniformLocation(this.progDeposit, 'u_cosInv'),
      u_sinInv: gl.getUniformLocation(this.progDeposit, 'u_sinInv'),
      u_depositBase: gl.getUniformLocation(this.progDeposit, 'u_depositBase'),
      u_effOpacity: gl.getUniformLocation(this.progDeposit, 'u_effOpacity'),
      u_alphaLock: gl.getUniformLocation(this.progDeposit, 'u_alphaLock')
    };
    this.compLocs = {
      u_orig: gl.getUniformLocation(this.progComposite, 'u_orig'),
      u_sim: gl.getUniformLocation(this.progComposite, 'u_sim'),
      u_cov: gl.getUniformLocation(this.progComposite, 'u_cov'),
      u_alphaLock: gl.getUniformLocation(this.progComposite, 'u_alphaLock')
    };
    this.unpremultLocs = {
      u_tex: gl.getUniformLocation(this.progUnpremult, 'u_tex')
    };

    this.ready = true;
  }

  _allocTileGpu() {
    const orig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, false);
    const sim = this._makeTexFBO(TILE_SIZE, TILE_SIZE, this.isFloat, false);
    const cov = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, false);
    if (!orig || !sim || !cov) {
      const gl = this.gl;
      if (orig) { gl.deleteFramebuffer(orig.fbo); gl.deleteTexture(orig.tex); }
      if (sim) { gl.deleteFramebuffer(sim.fbo); gl.deleteTexture(sim.tex); }
      if (cov) { gl.deleteFramebuffer(cov.fbo); gl.deleteTexture(cov.tex); }
      return null;
    }
    return { orig, sim, cov, tx: 0, ty: 0, wx: 0, wy: 0, dirty: false, minX: TILE_SIZE, minY: TILE_SIZE, maxX: 0, maxY: 0 };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    for (const o of [t.orig, t.sim, t.cov]) {
      if (!o) continue;
      if (o.fbo) gl.deleteFramebuffer(o.fbo);
      if (o.tex) gl.deleteTexture(o.tex);
    }
  }

  _releaseAllTiles() {
    this.activeTiles.forEach((tile) => {
      if (this.tilePool.length < MAX_POOL_TILES) {
        tile.dirty = false;
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

  _srcSim() { return this.curWorkIdx === 0 ? this.workSimA : this.workSimB; }
  _dstSim() { return this.curWorkIdx === 0 ? this.workSimB : this.workSimA; }
  _srcCov() { return this.curWorkIdx === 0 ? this.workCovA : this.workCovB; }
  _dstCov() { return this.curWorkIdx === 0 ? this.workCovB : this.workCovA; }
  _dstMrt() { return this.curWorkIdx === 0 ? this.mrtWorkB : this.mrtWorkA; }
  _swapWork() { this.curWorkIdx = 1 - this.curWorkIdx; }

  _srcBuf() { return this.curBufIdx === 0 ? this.bufA : this.bufB; }
  _dstBuf() { return this.curBufIdx === 0 ? this.bufB : this.bufA; }
  _swapBuf() { this.curBufIdx = 1 - this.curBufIdx; }

  uploadTipMask(tipMaskFloat32) {
    if (!this.ready || !this.tipTex || !tipMaskFloat32) return;
    const bytes = this.tipUploadBytes;
    const len = this.bufRes * this.bufRes;
    for (let i = 0; i < len; i++) {
      const v = tipMaskFloat32[i] <= 0 ? 0 : (tipMaskFloat32[i] >= 1 ? 255 : (tipMaskFloat32[i] * 255.0 + 0.5) | 0);
      const i4 = i * 4;
      bytes[i4] = v;
      bytes[i4 + 1] = v;
      bytes[i4 + 2] = v;
      bytes[i4 + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.bufRes, this.bufRes, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  _ensureChunkBackup(engine, chunk, cx, cy) {
    const id = `${cx},${cy}`;
    if (!engine.currentStrokeDirtyChunks.has(id)) {
      const srcCanvas = chunk.canvases[engine.activeLayer];
      const backup = document.createElement('canvas');
      backup.width = srcCanvas.width;
      backup.height = srcCanvas.height;
      backup.getContext('2d').drawImage(srcCanvas, 0, 0);
      engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
      engine._markDirty(id, engine.activeLayer, false);
    }
  }

  _ensureTile(engine, tx, ty) {
    const key = `${tx},${ty}`;
    let tile = this.activeTiles.get(key);
    if (tile) return tile;

    tile = this.tilePool.length > 0 ? this.tilePool.pop() : this._allocTileGpu();
    if (!tile) return null;

    const gl = this.gl;
    const layer = engine.activeLayer;
    tile.tx = tx;
    tile.ty = ty;
    tile.wx = tx * TILE_SIZE;
    tile.wy = ty * TILE_SIZE;
    tile.dirty = false;
    tile.minX = TILE_SIZE;
    tile.minY = TILE_SIZE;
    tile.maxX = 0;
    tile.maxY = 0;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);

    // Clear tile cov and orig
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.cov.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.orig.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Seed tile.orig directly from chunk GPU textures (no readback)
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_dstRect, tile.wx, tile.wy, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

    const sCX = engine.isStatic ? 0 : Math.floor(tile.wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((tile.wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(tile.wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((tile.wy + TILE_SIZE - 1) / engine.chunkSize);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
        if (!chunk) continue;

        const isEmpty = chunk.isEmpty && chunk.isEmpty[layer] && (!chunk.gpuDirty || !chunk.gpuDirty[layer]);
        if (isEmpty && (!chunk.gpuTextures || !chunk.gpuTextures[layer])) continue;

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

        const wx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
        const wy = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
        gl.uniform4f(this.rectLocs.u_srcRect, wx, wy, chunk.width, chunk.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // Mirror tile.orig -> tile.sim
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.sim.fbo);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.orig.tex);
    gl.uniform1i(this.blitLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.activeTiles.set(key, tile);
    return tile;
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH) {
    const gl = this.gl;
    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);

    // Ensure all tiles exist before rendering into work FBOs
    const tiles = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureTile(engine, tx, ty);
        if (t) tiles.push(t);
      }
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

    this.curWorkIdx = 0;
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_dstRect, workX, workY, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

    // Clear just in case a tile allocation failed
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workCovA.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOrig.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workSimA.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.rectLocs.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOrig.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.orig.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workSimA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.sim.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workCovA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.cov.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    return tiles;
  }

  _storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH) {
    const gl = this.gl;
    const simTex = this._srcSim().tex;
    const covTex = this._srcCov().tex;

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Write updated workSim & workCov back into active sparse tiles
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

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

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.sim.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, simTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.cov.fbo);
      gl.bindTexture(gl.TEXTURE_2D, covTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 2. Blit composited workOut straight onto chunk.gpuTextures[layer] on GPU (0 readback, 0 overlay seams)
    const layer = engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor(workX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((workX + boxW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(workY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((workY + boxH - 1) / engine.chunkSize);
    const uvScaleX = boxW / WORK_SIZE;
    const uvScaleY = boxH / WORK_SIZE;

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, boxW, boxH);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, uvScaleX, uvScaleY);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOut.tex);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine._getChunk(cx, cy);
        if (!chunk) continue;

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

        if (chunk.isEmpty) chunk.isEmpty[layer] = false;
        const id = `${cx},${cy}`;
        this.touchedChunks.set(id, { cx, cy, chunk });

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, chunk.gpuTextures[layer], 0);
        gl.viewport(0, 0, texW, texH);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, sy, sw, sh);
        gl.uniform4f(this.rectLocs.u_dstRect, lx, ly, chunk.width, chunk.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // Detach chunk texture cleanly
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _runBatch(engine, stamps, minX, minY, maxX, maxY, depositBase, pickupBase, effOpacity) {
    const workX = Math.floor(minX) - 2;
    const workY = Math.floor(minY) - 2;
    const boxW = Math.min(WORK_SIZE, Math.max(4, Math.ceil(maxX) + 2 - workX));
    const boxH = Math.min(WORK_SIZE, Math.max(4, Math.ceil(maxY) + 2 - workY));

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    if (tiles.length === 0) return;

    const gl = this.gl;
    const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
    const alphaLock = layerSet && layerSet.alphaLock ? 1 : 0;
    const texel = 1.0 / WORK_SIZE;
    const uvClampMinX = 0.5 * texel;
    const uvClampMinY = 0.5 * texel;
    const uvClampMaxX = Math.max(uvClampMinX, (boxW - 0.5) * texel);
    const uvClampMaxY = Math.max(uvClampMinY, (boxH - 0.5) * texel);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const sR = Math.max(2.0, s.size * 0.5);
      const angle = s.angle || 0.0;
      const cosFwd = Math.cos(angle);
      const sinFwd = Math.sin(angle);
      const isFirst = !this.dirtyBuf;

      // 1. Sample PRE-deposit workSim into 64x64 carried buffer
      if (isFirst || pickupBase > 0.001) {
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, this.bufRes, this.bufRes);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstBuf().fbo);
        gl.useProgram(this.progPickup);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._srcSim().tex);
        gl.uniform1i(this.pickupLocs.u_sim, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._srcBuf().tex);
        gl.uniform1i(this.pickupLocs.u_prevBuf, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
        gl.uniform1i(this.pickupLocs.u_tip, 2);

        gl.uniform2f(this.pickupLocs.u_workOrigin, workX, workY);
        gl.uniform2f(this.pickupLocs.u_workSize, WORK_SIZE, WORK_SIZE);
        gl.uniform4f(this.pickupLocs.u_uvClamp, uvClampMinX, uvClampMinY, uvClampMaxX, uvClampMaxY);
        gl.uniform2f(this.pickupLocs.u_stampPos, s.x, s.y);
        gl.uniform1f(this.pickupLocs.u_radius, sR);
        gl.uniform1f(this.pickupLocs.u_cosFwd, cosFwd);
        gl.uniform1f(this.pickupLocs.u_sinFwd, sinFwd);
        gl.uniform1f(this.pickupLocs.u_pickupBase, pickupBase);
        gl.uniform1i(this.pickupLocs.u_isFirstPickup, isFirst ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // 2. Deposit carried srcBuf onto workSim + update cov envelope
      if (!isFirst && depositBase > 0.001) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, boxW, boxH);
        gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstMrt());
        gl.useProgram(this.progDeposit);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._srcSim().tex);
        gl.uniform1i(this.depositLocs.u_sim, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._srcCov().tex);
        gl.uniform1i(this.depositLocs.u_cov, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this._srcBuf().tex);
        gl.uniform1i(this.depositLocs.u_buf, 2);

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
        gl.uniform1i(this.depositLocs.u_tip, 3);

        gl.uniform2f(this.depositLocs.u_workOrigin, workX, workY);
        gl.uniform2f(this.depositLocs.u_stampPos, s.x, s.y);
        gl.uniform1f(this.depositLocs.u_radius, sR);
        gl.uniform1f(this.depositLocs.u_cosInv, cosFwd);
        gl.uniform1f(this.depositLocs.u_sinInv, -sinFwd);
        gl.uniform1f(this.depositLocs.u_depositBase, depositBase);
        gl.uniform1f(this.depositLocs.u_effOpacity, effOpacity);
        gl.uniform1i(this.depositLocs.u_alphaLock, alphaLock);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this._swapWork();
      }

      if (isFirst || pickupBase > 0.001) {
        this._swapBuf();
        this.dirtyBuf = true;
      }
    }

    // 3. Composite final = lerp(workOrig, workSim, workCov) once per move batch
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workOut.fbo);
    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workOrig.tex);
    gl.uniform1i(this.compLocs.u_orig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._srcSim().tex);
    gl.uniform1i(this.compLocs.u_sim, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._srcCov().tex);
    gl.uniform1i(this.compLocs.u_cov, 2);
    gl.uniform1i(this.compLocs.u_alphaLock, alphaLock);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. Persist tiles + update chunk.gpuTextures[layer] on GPU
    this._storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH);
  }

  beginStroke(engine, worldPos, tipMaskFloat32) {
    if (!this.ready) return false;
    this._releaseAllTiles();
    this.touchedChunks.clear();
    this.uploadTipMask(tipMaskFloat32);

    this.curWorkIdx = 0;
    this.curBufIdx = 0;
    this.dirtyBuf = false;
    this.active = true;
    this.gpuRenderer.smudgeOverlay = null;

    // Pre-warm carried 64x64 buffer at initial pointerdown coordinates
    const sz = worldPos.size || engine.brush.size || 50;
    const sR = Math.max(2.0, sz * 0.5);
    const pad = Math.ceil(sR) + 4;
    const workX = Math.floor(worldPos.x - pad);
    const workY = Math.floor(worldPos.y - pad);
    const boxW = Math.min(WORK_SIZE, Math.max(8, pad * 2));
    const boxH = Math.min(WORK_SIZE, Math.max(8, pad * 2));

    this._assembleWorkBox(engine, workX, workY, boxW, boxH);

    const gl = this.gl;
    const angle = engine.rotation || 0.0;
    const texel = 1.0 / WORK_SIZE;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, this.bufRes, this.bufRes);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._srcBuf().fbo);
    gl.useProgram(this.progPickup);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._srcSim().tex);
    gl.uniform1i(this.pickupLocs.u_sim, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._dstBuf().tex);
    gl.uniform1i(this.pickupLocs.u_prevBuf, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.pickupLocs.u_tip, 2);
    gl.uniform2f(this.pickupLocs.u_workOrigin, workX, workY);
    gl.uniform2f(this.pickupLocs.u_workSize, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.pickupLocs.u_uvClamp, 0.5 * texel, 0.5 * texel, (boxW - 0.5) * texel, (boxH - 0.5) * texel);
    gl.uniform2f(this.pickupLocs.u_stampPos, worldPos.x, worldPos.y);
    gl.uniform1f(this.pickupLocs.u_radius, sR);
    gl.uniform1f(this.pickupLocs.u_cosFwd, Math.cos(angle));
    gl.uniform1f(this.pickupLocs.u_sinFwd, Math.sin(angle));
    gl.uniform1f(this.pickupLocs.u_pickupBase, 1.0);
    gl.uniform1i(this.pickupLocs.u_isFirstPickup, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.dirtyBuf = true;
    return true;
  }

  stepStamps(engine, stamps, depositBase, pickupBase, effOpacity) {
    if (!this.ready || !this.active || !stamps || stamps.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const sR = Math.max(2.0, s.size * 0.5);
      const boundR = Math.ceil(sR * (s.angle ? 1.42 : 1.02)) + 4;
      if (s.x - boundR < minX) minX = s.x - boundR;
      if (s.y - boundR < minY) minY = s.y - boundR;
      if (s.x + boundR > maxX) maxX = s.x + boundR;
      if (s.y + boundR > maxY) maxY = s.y + boundR;
    }

    if ((Math.ceil(maxX) - Math.floor(minX) + 6) <= WORK_SIZE &&
        (Math.ceil(maxY) - Math.floor(minY) + 6) <= WORK_SIZE) {
      this._runBatch(engine, stamps, minX, minY, maxX, maxY, depositBase, pickupBase, effOpacity);
    } else {
      for (let i = 0; i < stamps.length; i++) {
        const s = stamps[i];
        const sR = Math.max(2.0, s.size * 0.5);
        const boundR = Math.ceil(sR * (s.angle ? 1.42 : 1.02)) + 4;
        this._runBatch(engine, [s], s.x - boundR, s.y - boundR, s.x + boundR, s.y + boundR, depositBase, pickupBase, effOpacity);
      }
    }

    this.gpuRenderer.requestRender();
  }

  _commitTilesToChunks(engine) {
    if (this.activeTiles.size === 0) return;

    const gl = this.gl;
    const layer = engine.activeLayer;
    const layerSet = engine.layerSettings ? engine.layerSettings[layer] : null;
    const alphaLock = layerSet && layerSet.alphaLock ? 1 : 0;

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
      if (!t.dirty || t.maxX <= t.minX || t.maxY <= t.minY) return;

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

      // Composite orig -> sim by cov inside tile sub-rect
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tileCommitPre.fbo);
      gl.useProgram(this.progComposite);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.orig.tex);
      gl.uniform1i(this.compLocs.u_orig, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.sim.tex);
      gl.uniform1i(this.compLocs.u_sim, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t.cov.tex);
      gl.uniform1i(this.compLocs.u_cov, 2);
      gl.uniform1i(this.compLocs.u_alphaLock, alphaLock);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Unpremultiply for Canvas2D chunk commit
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tileCommitStraight.fbo);
      gl.useProgram(this.progUnpremult);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tileCommitPre.tex);
      gl.uniform1i(this.unpremultLocs.u_tex, 0);
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
          const chunk = engine._getChunk(cx, cy);
          if (!chunk) continue;
          this._ensureChunkBackup(engine, chunk, cx, cy);

          const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
          const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
          const ox = Math.max(worldMinX, lx);
          const oy = Math.max(worldMinY, ly);
          const ox2 = Math.min(worldMinX + rw, lx + chunk.width);
          const oy2 = Math.min(worldMinY + rh, ly + chunk.height);
          const ow = ox2 - ox;
          const oh = oy2 - oy;
          if (ow <= 0 || oh <= 0) continue;

          const ctx = chunk.ctxs[layer];
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, chunk.width, chunk.height);
          ctx.clip();
          if (alphaLock) {
            ctx.globalCompositeOperation = 'source-atop';
          } else {
            ctx.clearRect(ox - lx, oy - ly, ow, oh);
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.drawImage(this._commitCanvas, ox - worldMinX, oy - worldMinY, ow, oh, ox - lx, oy - ly, ow, oh);
          ctx.restore();

          if (chunk.isEmpty) chunk.isEmpty[layer] = false;
          engine._markDirty(`${cx},${cy}`, layer, false);
        }
      }
    });

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  endStroke(engine) {
    if (!this.ready || !this.active) return;

    this._commitTilesToChunks(engine);
    this._releaseAllTiles();
    this.touchedChunks.clear();

    this.active = false;
    this.dirtyBuf = false;
    this.gpuRenderer.smudgeOverlay = null;
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
    this.dirtyBuf = false;
    if (this.gl) {
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.smudgeOverlay = null;
      this.gpuRenderer.requestRender();
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
    [
      this.workSimA, this.workSimB, this.workOrig, this.workCovA, this.workCovB,
      this.workOut, this.bufA, this.bufB, this.tileCommitPre, this.tileCommitStraight
    ].forEach(delTexFbo);
    if (this.mrtWorkA) gl.deleteFramebuffer(this.mrtWorkA);
    if (this.mrtWorkB) gl.deleteFramebuffer(this.mrtWorkB);
    if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
    if (this.tipTex) gl.deleteTexture(this.tipTex);
    [this.progRectMap, this.progBlit, this.progPickup, this.progDeposit, this.progComposite, this.progUnpremult].forEach(p => {
      if (p) gl.deleteProgram(p);
    });
    this._commitCanvas = null;
    this._commitCtx = null;
    this._readBuf = null;
    this.ready = false;
    this.active = false;
  }
}
