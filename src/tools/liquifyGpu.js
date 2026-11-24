/**
 * Zero-Readback Pooled-Tile WebGL2 GPU Liquify Engine
 * Architecture:
 * - Sparse 256x256 world displacement tiles at half-resolution (128x128 RGBA16F LINEAR, 2px/texel)
 *   drawn from a pre-allocated reusable GPU pool (0 stroke-time VRAM allocations after warmup).
 * - Single-pass 1024x1024 RGBA16F ping-pong workDisp FBOs covering 2048x2048 world pixels
 *   (fits up to max 1500px brush + move in 1 draw call with 1..4 swept Hermite sub-steps).
 * - Pristine per-chunk GPU snapshots (origTex) cloned once per touched chunk via GPU FBO blit
 *   (0 CPU getImageData readbacks, 0 blur accumulation, lossless backward-warp sampling).
 * - Writes warped pixels directly into chunk.gpuTextures[layer] via scissored FBO pass.
 * - Single tiled readback to Canvas2D + undo backup on endStroke(); instant GPU rollback on cancel().
 */

import { backupChunkLayer } from '../engine/backupPool.js';

const TILE_SIZE = 256;
const COMMIT_TILE = 512;
const PBO_RING_SIZE = 4;
const ASYNC_FRAME_BUDGET_MS = 2.2;
const DEFAULT_DISP_RES = 256;
const WORK_WORLD = 2048;
const MAX_DISP_POOL = 96;
const MAX_ORIG_POOL = 48;

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

// Accumulates 1..8 displacement steps into RGBA16F displacement field in a single draw call
const DISPLACE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_disp;
uniform vec2 u_workOrigin;
uniform float u_workWorldSize;
uniform float u_radius;
uniform float u_falloff;
uniform int u_stepCount;
uniform vec2 u_stepFrom[8];
uniform vec2 u_stepMv[8];

out vec4 outDisp;

void main() {
  vec2 disp = texture(u_disp, v_uv).xy;
  vec2 worldPos = u_workOrigin + v_uv * u_workWorldSize;

  float R = max(4.0, u_radius);
  float rSq = R * R;
  float invR = 1.0 / R;
  float rInner = max(0.0, 1.0 - clamp(u_falloff, 0.0, 1.0));
  float falloffSpan = max(0.0001, 1.0 - rInner);

  for (int i = 0; i < 8; i++) {
    if (i >= u_stepCount) break;
    vec2 d = worldPos - u_stepFrom[i];
    float d2 = dot(d, d);
    if (d2 >= rSq) continue;

    float u = sqrt(d2) * invR;
    float w;
    if (u <= rInner) {
      if (rInner >= 0.95 && u > 0.96) {
        float edgeT = (u - 0.96) / 0.04;
        w = 1.0 - (edgeT * edgeT * (3.0 - 2.0 * edgeT));
      } else {
        w = 1.0;
      }
    } else {
      float t = (u - rInner) / falloffSpan;
      w = (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
    }

    disp += u_stepMv[i] * w;
  }

  outDisp = vec4(disp, 0.0, 1.0);
}
`;

// Backward-warps pristine chunk origTex directly into destination chunk.gpuTextures[layer]
const WARP_HEADER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_srcOrig;
uniform sampler2D u_workDisp;
uniform vec4 u_dstWorldRect;   // [lx, ly, cw, ch]
uniform vec4 u_srcWorldBounds; // [minX, minY, maxX, maxY]
uniform vec2 u_dispOrigin;
uniform float u_dispWorldSize;
uniform vec4 u_dispClamp;

out vec4 outColor;
`;

const WARP_FAST_FS = `${WARP_HEADER_FS}
void main() {
  vec2 worldPos = u_dstWorldRect.xy + v_uv * u_dstWorldRect.zw;
  vec2 dispUv = clamp((worldPos - u_dispOrigin) / u_dispWorldSize, u_dispClamp.xy, u_dispClamp.zw);
  vec2 disp = texture(u_workDisp, dispUv).xy;

  vec2 srcPos = worldPos - disp;
  if (
    srcPos.x < u_srcWorldBounds.x || srcPos.x >= u_srcWorldBounds.z ||
    srcPos.y < u_srcWorldBounds.y || srcPos.y >= u_srcWorldBounds.w
  ) {
    discard;
  }

  vec2 srcSize = u_srcWorldBounds.zw - u_srcWorldBounds.xy;
  vec2 srcUv = (srcPos - u_srcWorldBounds.xy) / srcSize;
  outColor = texture(u_srcOrig, srcUv);
}
`;

// Mode 2 (CRISP): 9-tap GPU bilinear-factored Catmull-Rom Bicubic + zero-disp fast path
const WARP_CRISP_FS = `${WARP_HEADER_FS}
void main() {
  vec2 worldPos = u_dstWorldRect.xy + v_uv * u_dstWorldRect.zw;
  vec2 dispUv = clamp((worldPos - u_dispOrigin) / u_dispWorldSize, u_dispClamp.xy, u_dispClamp.zw);
  vec2 disp = texture(u_workDisp, dispUv).xy;

  vec2 srcPos = worldPos - disp;
  if (
    srcPos.x < u_srcWorldBounds.x || srcPos.x >= u_srcWorldBounds.z ||
    srcPos.y < u_srcWorldBounds.y || srcPos.y >= u_srcWorldBounds.w
  ) {
    discard;
  }

  vec2 srcSize = u_srcWorldBounds.zw - u_srcWorldBounds.xy;
  vec2 srcUv = (srcPos - u_srcWorldBounds.xy) / srcSize;

  if (abs(disp.x) < 0.0005 && abs(disp.y) < 0.0005) {
    outColor = texture(u_srcOrig, srcUv);
    return;
  }

  vec2 texSize = vec2(textureSize(u_srcOrig, 0));
  vec2 invTexSize = 1.0 / texSize;
  vec2 tc = srcUv * texSize - 0.5;
  vec2 i = floor(tc);
  vec2 f = tc - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;

  vec2 w0 = -0.5 * f + f2 - 0.5 * f3;
  vec2 w1 = 1.0 - 2.5 * f2 + 1.5 * f3;
  vec2 w2 = 0.5 * f + 2.0 * f2 - 1.5 * f3;
  vec2 w3 = -0.5 * f2 + 0.5 * f3;

  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / max(vec2(1e-5), w12);

  vec2 uv0 = (i - 0.5) * invTexSize;
  vec2 uv12 = (i + 0.5 + off12) * invTexSize;
  vec2 uv3 = (i + 2.5) * invTexSize;

  vec4 col = vec4(0.0);
  col += texture(u_srcOrig, vec2(uv0.x,  uv0.y))  * (w0.x  * w0.y);
  col += texture(u_srcOrig, vec2(uv12.x, uv0.y))  * (w12.x * w0.y);
  col += texture(u_srcOrig, vec2(uv3.x,  uv0.y))  * (w3.x  * w0.y);

  col += texture(u_srcOrig, vec2(uv0.x,  uv12.y)) * (w0.x  * w12.y);
  col += texture(u_srcOrig, vec2(uv12.x, uv12.y)) * (w12.x * w12.y);
  col += texture(u_srcOrig, vec2(uv3.x,  uv12.y)) * (w3.x  * w12.y);

  col += texture(u_srcOrig, vec2(uv0.x,  uv3.y))  * (w0.x  * w3.y);
  col += texture(u_srcOrig, vec2(uv12.x, uv3.y))  * (w12.x * w3.y);
  col += texture(u_srcOrig, vec2(uv3.x,  uv3.y))  * (w3.x  * w3.y);

  col = clamp(col, vec4(0.0), vec4(1.0));
  col.rgb = min(col.rgb, vec3(col.a));
  outColor = col;
}
`;

// Mode 3 (ULTRA): 36-tap 6x6 Lanczos-3 + inner 2x2 anti-ringing clamp
const WARP_ULTRA_FS = `${WARP_HEADER_FS}
float lanczos3(float x) {
  float ax = abs(x);
  if (ax >= 3.0) return 0.0;
  if (ax < 1e-4) return 1.0;
  float pix = 3.14159265359 * x;
  return (sin(pix) / pix) * (sin(pix * 0.3333333333) / (pix * 0.3333333333));
}

void main() {
  vec2 worldPos = u_dstWorldRect.xy + v_uv * u_dstWorldRect.zw;
  vec2 dispUv = clamp((worldPos - u_dispOrigin) / u_dispWorldSize, u_dispClamp.xy, u_dispClamp.zw);
  vec2 disp = texture(u_workDisp, dispUv).xy;

  vec2 srcPos = worldPos - disp;
  if (
    srcPos.x < u_srcWorldBounds.x || srcPos.x >= u_srcWorldBounds.z ||
    srcPos.y < u_srcWorldBounds.y || srcPos.y >= u_srcWorldBounds.w
  ) {
    discard;
  }

  vec2 srcSize = u_srcWorldBounds.zw - u_srcWorldBounds.xy;
  vec2 srcUv = (srcPos - u_srcWorldBounds.xy) / srcSize;

  if (abs(disp.x) < 0.0005 && abs(disp.y) < 0.0005) {
    outColor = texture(u_srcOrig, srcUv);
    return;
  }

  ivec2 iSize = textureSize(u_srcOrig, 0);
  vec2 texSize = vec2(iSize);
  vec2 tc = srcUv * texSize - 0.5;
  vec2 iBase = floor(tc);
  vec2 f = tc - iBase;
  ivec2 i0 = ivec2(iBase);
  ivec2 maxCoord = iSize - ivec2(1);

  float wx[6];
  float wy[6];
  float sumWx = 0.0;
  float sumWy = 0.0;
  for (int k = 0; k < 6; k++) {
    float ok = float(k - 2);
    wx[k] = lanczos3(ok - f.x);
    wy[k] = lanczos3(ok - f.y);
    sumWx += wx[k];
    sumWy += wy[k];
  }
  float invSum = 1.0 / max(1e-5, sumWx * sumWy);

  vec4 acc = vec4(0.0);
  vec4 innerMin = vec4(1.0);
  vec4 innerMax = vec4(0.0);
  for (int ky = 0; ky < 6; ky++) {
    int sy = clamp(i0.y + (ky - 2), 0, maxCoord.y);
    float wY = wy[ky];
    for (int kx = 0; kx < 6; kx++) {
      int sx = clamp(i0.x + (kx - 2), 0, maxCoord.x);
      vec4 s = texelFetch(u_srcOrig, ivec2(sx, sy), 0);
      if ((kx == 2 || kx == 3) && (ky == 2 || ky == 3)) {
        innerMin = min(innerMin, s);
        innerMax = max(innerMax, s);
      }
      acc += s * (wx[kx] * wY);
    }
  }

  vec4 col = acc * invSum;
  col = mix(col, clamp(col, innerMin, innerMax), 0.55);
  col = clamp(col, vec4(0.0), vec4(1.0));
  col.rgb = min(col.rgb, vec3(col.a));
  outColor = col;
}
`;

// Converts premultiplied RGBA chunk texture -> straight RGBA for Canvas2D endStroke commit
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

export class GpuLiquifySolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer.gl;
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
    this._maxTexSize = 2048;
    this._workTexSize = 1024;
    this._activeDispRes = DEFAULT_DISP_RES;

    this.activeDispTiles = new Map(); // "tx,ty" -> { tx, ty, wx, wy, tex, fbo, res }
    this.dispPools = { 128: [], 256: [] }; // reusable RGBA16F displacement tiles keyed by resolution
    this.chunkOrigs = new Map();      // "cx,cy" -> { cx, cy, chunk, w, h, lx, ly, wasEmpty, origItem }
    this.origPool = [];               // reusable RGBA8 chunk snapshot textures
    this.touchedDestChunks = new Map(); // "cx,cy" -> { cx, cy, chunk, minX, minY, maxX, maxY, wasEmpty }

    // Non-destructive session persistence state (Modes 2 & 3)
    this._sessionActive = false;
    this._sessionProjectId = null;
    this._sessionLayer = -1;
    this._sessionQuality = 2;
    this._sessionDispRes = DEFAULT_DISP_RES;
    this._activeModeCfg = null;

    this.boundMinDx = 0;
    this.boundMaxDx = 0;
    this.boundMinDy = 0;
    this.boundMaxDy = 0;

    // Async PBO commit pipeline state
    this._pboSupported = false;
    this._pboRing = [];
    this._pendingQueue = [];
    this._inFlightPBOs = [];
    this._commitRafId = null;
    this._onAllCommitsDone = [];
    this._commitCanvas = null;
    this._commitCtx = null;
    this._commitImgData = null;
    this._commitU8 = null;
    this._edgeImgDataMap = new Map();

    this._init();
  }

  _getModeConfig(engine = null) {
    const qRaw = engine?.brush?.liquifyQuality ?? 2;
    const quality = qRaw <= 1 ? 1 : (qRaw >= 3 ? 3 : 2);
    const maxWorkTex = Math.min(2048, this._maxTexSize || 2048);
    if (quality === 1) {
      return {
        quality: 1,
        dispRes: 128,
        workTex: Math.min(1024, maxWorkTex),
        subStepFactor: 0.40,
        minSubStep: 12.0,
        sessionPersistent: false,
        maxSessionOrigs: 16,
        filter: 'fast'
      };
    }
    const dispRes = maxWorkTex >= 2048 ? 256 : 128;
    if (quality === 3) {
      return {
        quality: 3,
        dispRes,
        workTex: maxWorkTex,
        subStepFactor: 0.16,
        minSubStep: 4.0,
        sessionPersistent: true,
        maxSessionOrigs: 48,
        filter: 'ultra'
      };
    }
    return {
      quality: 2,
      dispRes,
      workTex: maxWorkTex,
      subStepFactor: 0.28,
      minSubStep: 8.0,
      sessionPersistent: true,
      maxSessionOrigs: 24,
      filter: 'crisp'
    };
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
      console.error('Liquify GPU program link failed:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _createTexFbo(w, h, isFloat16 = false) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (isFloat16) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    return { tex, fbo, w, h };
  }

  _init() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    // Require renderable HALF_FLOAT (RGBA16F) displacement targets
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');

    this._maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    const initWorkTex = Math.min(2048, this._maxTexSize);
    this._workTexSize = initWorkTex;
    this._activeDispRes = initWorkTex >= 2048 ? 256 : 128;

    this.workDispA = this._createTexFbo(initWorkTex, initWorkTex, true);
    this.workDispB = this._createTexFbo(initWorkTex, initWorkTex, true);

    if (!this.workDispA || !this.workDispB) {
      this._delTexFbo(this.workDispA);
      this._delTexFbo(this.workDispB);
      this.workDispA = null;
      this.workDispB = null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.ready = false;
      return;
    }

    this.progRectMap = this._createProgram(RECT_MAP_VS, BLIT_FS);
    this.progBlit = this._createProgram(QUAD_UNIT_VS, BLIT_FS);
    this.progDisplace = this._createProgram(QUAD_UNIT_VS, DISPLACE_FS);
    this.progWarpFast = this._createProgram(QUAD_UNIT_VS, WARP_FAST_FS);
    this.progWarpCrisp = this._createProgram(QUAD_UNIT_VS, WARP_CRISP_FS);
    this.progWarpUltra = this._createProgram(QUAD_UNIT_VS, WARP_ULTRA_FS);
    this.progUnpremult = this._createProgram(RECT_MAP_VS, UNPREMULT_FS);

    if (
      !this.progRectMap || !this.progBlit || !this.progDisplace ||
      !this.progWarpFast || !this.progWarpCrisp || !this.progWarpUltra ||
      !this.progUnpremult
    ) {
      this.dispose();
      return;
    }

    this.rectLocs = {
      u_srcRect: gl.getUniformLocation(this.progRectMap, 'u_srcRect'),
      u_dstRect: gl.getUniformLocation(this.progRectMap, 'u_dstRect'),
      u_uvSubRect: gl.getUniformLocation(this.progRectMap, 'u_uvSubRect'),
      u_tex: gl.getUniformLocation(this.progRectMap, 'u_tex')
    };

    this.blitLocs = {
      u_tex: gl.getUniformLocation(this.progBlit, 'u_tex')
    };

    this.dispLocs = {
      u_disp: gl.getUniformLocation(this.progDisplace, 'u_disp'),
      u_workOrigin: gl.getUniformLocation(this.progDisplace, 'u_workOrigin'),
      u_workWorldSize: gl.getUniformLocation(this.progDisplace, 'u_workWorldSize'),
      u_radius: gl.getUniformLocation(this.progDisplace, 'u_radius'),
      u_falloff: gl.getUniformLocation(this.progDisplace, 'u_falloff'),
      u_stepCount: gl.getUniformLocation(this.progDisplace, 'u_stepCount'),
      u_stepFrom: gl.getUniformLocation(this.progDisplace, 'u_stepFrom[0]'),
      u_stepMv: gl.getUniformLocation(this.progDisplace, 'u_stepMv[0]')
    };

    const getWarpLocs = (prog) => ({
      u_srcOrig: gl.getUniformLocation(prog, 'u_srcOrig'),
      u_workDisp: gl.getUniformLocation(prog, 'u_workDisp'),
      u_dstWorldRect: gl.getUniformLocation(prog, 'u_dstWorldRect'),
      u_srcWorldBounds: gl.getUniformLocation(prog, 'u_srcWorldBounds'),
      u_dispOrigin: gl.getUniformLocation(prog, 'u_dispOrigin'),
      u_dispWorldSize: gl.getUniformLocation(prog, 'u_dispWorldSize'),
      u_dispClamp: gl.getUniformLocation(prog, 'u_dispClamp')
    });
    this.warpFastLocs = getWarpLocs(this.progWarpFast);
    this.warpCrispLocs = getWarpLocs(this.progWarpCrisp);
    this.warpUltraLocs = getWarpLocs(this.progWarpUltra);

    this.unpremultLocs = {
      u_srcRect: gl.getUniformLocation(this.progUnpremult, 'u_srcRect'),
      u_dstRect: gl.getUniformLocation(this.progUnpremult, 'u_dstRect'),
      u_uvSubRect: gl.getUniformLocation(this.progUnpremult, 'u_uvSubRect'),
      u_tex: gl.getUniformLocation(this.progUnpremult, 'u_tex')
    };

    this.chunkBlitFbo = gl.createFramebuffer();
    this.commitTile = this._createTexFbo(COMMIT_TILE, COMMIT_TILE, false);
    if (!this.chunkBlitFbo || !this.commitTile) {
      this.dispose();
      return;
    }

    this._pboSupported = (
      typeof gl.PIXEL_PACK_BUFFER === 'number' &&
      typeof gl.fenceSync === 'function' &&
      typeof gl.clientWaitSync === 'function' &&
      typeof gl.getBufferSubData === 'function' &&
      typeof gl.deleteSync === 'function'
    );

    // Pre-warm 4 displacement tiles for default resolution
    const initPool = this.dispPools[this._activeDispRes];
    for (let i = 0; i < 4; i++) {
      const dispTile = this._createTexFbo(this._activeDispRes, this._activeDispRes, true);
      if (dispTile) initPool.push(dispTile);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._stepFromArr = new Float32Array(16);
    this._stepMvArr = new Float32Array(16);
    this.ready = true;
  }

  _ensureWorkDispSize(targetWorkTex) {
    if (!this.gl || this.gl.isContextLost()) return false;
    if (this._workTexSize === targetWorkTex && this.workDispA && this.workDispB) return true;
    const nextA = this._createTexFbo(targetWorkTex, targetWorkTex, true);
    const nextB = this._createTexFbo(targetWorkTex, targetWorkTex, true);
    if (!nextA || !nextB) {
      this._delTexFbo(nextA);
      this._delTexFbo(nextB);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      return false;
    }
    this._delTexFbo(this.workDispA);
    this._delTexFbo(this.workDispB);
    this.workDispA = nextA;
    this.workDispB = nextB;
    this._workTexSize = targetWorkTex;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return true;
  }

  prewarmPipelines(engine = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;

    // Ensure CPU/PBO readback resources exist before endStroke
    this._ensureCommitResources();

    // Ensure at least one chunk-sized orig texture is pooled so stroke #1 doesn't allocate mid-move
    const cw = engine?.isStatic ? (engine.staticWidth || 1024) : (engine?.chunkSize || 1024);
    const ch = engine?.isStatic ? (engine.staticHeight || 1024) : (engine?.chunkSize || 1024);
    const dpi = engine?.isStatic ? (engine.dpiScale || 1) : 1;
    const texW = Math.min(4096, Math.max(128, Math.round(cw * dpi)));
    const texH = Math.min(4096, Math.max(128, Math.round(ch * dpi)));
    if (this.origPool.length < MAX_ORIG_POOL && !this.origPool.some(o => o.w === texW && o.h === texH)) {
      const origItem = this._createTexFbo(texW, texH, false);
      if (origItem) {
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, origItem.fbo);
        gl.viewport(0, 0, texW, texH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.origPool.push(origItem);
      }
    }

    const cfg = this._getModeConfig(engine);
    this._ensureWorkDispSize(cfg.workTex);

    // Ensure at least 4 displacement tiles exist for active resolution
    const pool = this.dispPools[cfg.dispRes] || (this.dispPools[cfg.dispRes] = []);
    while (pool.length < 4 && this.activeDispTiles.size === 0) {
      const dispTile = this._createTexFbo(cfg.dispRes, cfg.dispRes, true);
      if (!dispTile) break;
      pool.push(dispTile);
    }

    if (this._pipelinesWarmed) return;

    const workTex = this._workTexSize;

    // Trigger real 4x4 scissored draws across every Liquify shader program so ANGLE/driver
    // finishes native PSO compilation during idle warmup instead of first stroke start.
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, workTex, workTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispA.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispB.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. progRectMap: workDispA -> workDispB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispB.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, 0, 0, WORK_WORLD, WORK_WORLD);
    gl.uniform4f(this.rectLocs.u_dstRect, 0, 0, WORK_WORLD, WORK_WORLD);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workDispA.tex);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. progBlit: workDispB -> workDispA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispA.fbo);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workDispB.tex);
    gl.uniform1i(this.blitLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. progDisplace: workDispA -> workDispB (zero displacement dummy pass)
    this._stepFromArr.fill(0);
    this._stepMvArr.fill(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispB.fbo);
    gl.useProgram(this.progDisplace);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workDispA.tex);
    gl.uniform1i(this.dispLocs.u_disp, 0);
    gl.uniform2f(this.dispLocs.u_workOrigin, 0, 0);
    gl.uniform1f(this.dispLocs.u_workWorldSize, WORK_WORLD);
    gl.uniform1f(this.dispLocs.u_radius, 32.0);
    gl.uniform1f(this.dispLocs.u_falloff, 0.5);
    gl.uniform1i(this.dispLocs.u_stepCount, 1);
    gl.uniform2fv(this.dispLocs.u_stepFrom, this._stepFromArr);
    gl.uniform2fv(this.dispLocs.u_stepMv, this._stepMvArr);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. Warm all 3 warp shaders (Fast Bilinear, Crisp 9-tap Catmull-Rom, Ultra Lanczos-3)
    const dummyOrigTex = (this.origPool[0] && this.origPool[0].tex) ? this.origPool[0].tex : this.workDispA.tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.commitTile.tex, 0);
    gl.viewport(0, 0, COMMIT_TILE, COMMIT_TILE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const warpPasses = [
      [this.progWarpFast, this.warpFastLocs],
      [this.progWarpCrisp, this.warpCrispLocs],
      [this.progWarpUltra, this.warpUltraLocs]
    ];
    for (let pIdx = 0; pIdx < warpPasses.length; pIdx++) {
      const [prog, locs] = warpPasses[pIdx];
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dummyOrigTex);
      gl.uniform1i(locs.u_srcOrig, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workDispB.tex);
      gl.uniform1i(locs.u_workDisp, 1);
      gl.uniform4f(locs.u_dstWorldRect, 0, 0, COMMIT_TILE, COMMIT_TILE);
      gl.uniform4f(locs.u_srcWorldBounds, 0, 0, COMMIT_TILE, COMMIT_TILE);
      gl.uniform2f(locs.u_dispOrigin, 0, 0);
      gl.uniform1f(locs.u_dispWorldSize, WORK_WORLD);
      gl.uniform4f(locs.u_dispClamp, 0.001, 0.001, 0.999, 0.999);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);

    // 5. progUnpremult: workDispA -> commitTile.fbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.commitTile.fbo);
    gl.useProgram(this.progUnpremult);
    gl.uniform4f(this.unpremultLocs.u_srcRect, 0, 0, 4, 4);
    gl.uniform4f(this.unpremultLocs.u_dstRect, 0, 0, COMMIT_TILE, COMMIT_TILE);
    gl.uniform4f(this.unpremultLocs.u_uvSubRect, 0, 0, 0.01, 0.01);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dummyOrigTex);
    gl.uniform1i(this.unpremultLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Clear touched 4x4 corner cleanly and restore GL compositor state
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);

    this._pipelinesWarmed = true;
  }

  _delTexFbo(o) {
    if (!o || !this.gl) return;
    if (o.fbo) this.gl.deleteFramebuffer(o.fbo);
    if (o.tex) this.gl.deleteTexture(o.tex);
  }

  _acquireDispTile(tx, ty, dispRes = DEFAULT_DISP_RES) {
    const key = `${tx},${ty}`;
    let t = this.activeDispTiles.get(key);
    if (t && t.res === dispRes) return { tile: t, isNew: false };
    if (t && t.res !== dispRes) {
      this._releaseAllDispTiles();
    }

    const gl = this.gl;
    const pool = this.dispPools[dispRes] || (this.dispPools[dispRes] = []);
    const item = pool.length > 0
      ? pool.pop()
      : this._createTexFbo(dispRes, dispRes, true);
    if (!item) return { tile: null, isNew: false };

    t = {
      key,
      tx,
      ty,
      wx: tx * TILE_SIZE,
      wy: ty * TILE_SIZE,
      res: dispRes,
      tex: item.tex,
      fbo: item.fbo,
      minDx: 0,
      maxDx: 0,
      minDy: 0,
      maxDy: 0
    };

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, dispRes, dispRes);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.activeDispTiles.set(key, t);
    return { tile: t, isNew: true };
  }

  _releaseAllDispTiles() {
    this.activeDispTiles.forEach((t) => {
      const res = t.res || 128;
      const pool = this.dispPools[res] || (this.dispPools[res] = []);
      if (pool.length < MAX_DISP_POOL) {
        pool.push({ tex: t.tex, fbo: t.fbo, w: res, h: res });
      } else {
        this._delTexFbo(t);
      }
    });
    this.activeDispTiles.clear();
  }

  _acquireOrigTex(w, h) {
    for (let i = this.origPool.length - 1; i >= 0; i--) {
      const o = this.origPool[i];
      if (o.w === w && o.h === h) {
        this.origPool.splice(i, 1);
        return o;
      }
    }
    return this._createTexFbo(w, h, false);
  }

  _releaseAllOrigs() {
    this.chunkOrigs.forEach((entry) => {
      if (entry.origItem) {
        if (this.origPool.length < MAX_ORIG_POOL) {
          this.origPool.push(entry.origItem);
        } else {
          this._delTexFbo(entry.origItem);
        }
        entry.origItem = null;
      }
    });
    this.chunkOrigs.clear();
  }

  _ensureChunkOrig(engine, cx, cy, createIfEmpty = false) {
    const id = `${cx},${cy}`;
    const existing = this.chunkOrigs.get(id);
    if (existing) {
      if (createIfEmpty && !existing.chunk.gpuTextures?.[engine.activeLayer]) {
        this._ensureChunkGpuTex(engine, existing.chunk, engine.activeLayer);
      }
      return existing;
    }

    const chunk = createIfEmpty ? engine._getChunk(cx, cy) : engine.chunks.get(id);
    if (!chunk) return null;

    const layer = engine.activeLayer;
    const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
    const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
    const cw = engine.isStatic ? engine.staticWidth : (chunk.width || engine.chunkSize);
    const ch = engine.isStatic ? engine.staticHeight : (chunk.height || engine.chunkSize);

    const isChunkEmpty = !!(chunk.isEmpty && chunk.isEmpty[layer] && !(chunk.gpuDirty && chunk.gpuDirty[layer]));

    if (isChunkEmpty && !chunk.gpuTextures?.[layer]) {
      if (createIfEmpty) {
        this._ensureChunkGpuTex(engine, chunk, layer);
      }
      const entry = { cx, cy, chunk, w: cw, h: ch, lx, ly, wasEmpty: true, origItem: null };
      this.chunkOrigs.set(id, entry);
      return entry;
    }

    if (!chunk.gpuTextures) {
      chunk.gpuTextures = new Array(engine.layerSettings ? engine.layerSettings.length : 4).fill(null);
    }
    if (!chunk.gpuDirty) {
      chunk.gpuDirty = new Array(engine.layerSettings ? engine.layerSettings.length : 4).fill(true);
    }
    if (chunk.gpuDirty[layer] || !chunk.gpuTextures[layer]) {
      chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(
        chunk.gpuTextures[layer],
        chunk.canvases[layer],
        true
      );
      chunk.gpuDirty[layer] = false;
    }

    const texW = chunk.canvases[layer].width || cw;
    const texH = chunk.canvases[layer].height || ch;
    const origItem = this._acquireOrigTex(texW, texH);
    if (!origItem) return null;

    // Clone pristine pre-stroke chunk texture on GPU via FBO blit (0 CPU readback)
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, origItem.fbo);
    gl.viewport(0, 0, texW, texH);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
    gl.uniform1i(this.blitLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const entry = { cx, cy, chunk, w: cw, h: ch, lx, ly, wasEmpty: false, origItem };
    this.chunkOrigs.set(id, entry);
    return entry;
  }

  _ensureChunkGpuTex(engine, chunk, layer) {
    if (!chunk.gpuTextures) {
      chunk.gpuTextures = new Array(engine.layerSettings ? engine.layerSettings.length : 4).fill(null);
    }
    if (!chunk.gpuDirty) {
      chunk.gpuDirty = new Array(engine.layerSettings ? engine.layerSettings.length : 4).fill(true);
    }
    if (chunk.gpuTextures[layer]) return;

    const canvas = chunk.canvases[layer];
    const texW = canvas ? canvas.width : (chunk.width || engine.chunkSize);
    const texH = canvas ? canvas.height : (chunk.height || engine.chunkSize);
    const gl = this.gl;

    if (chunk.isEmpty && chunk.isEmpty[layer]) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, texW, texH);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      chunk.gpuTextures[layer] = tex;
      chunk.gpuDirty[layer] = false;
    } else {
      chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(null, canvas, true);
      chunk.gpuDirty[layer] = false;
    }
  }

  invalidateSession() {
    if (this.active) {
      // Mid-stroke invalidation is handled via cancel()
      this._sessionActive = false;
      return;
    }
    this._releaseAllDispTiles();
    this._releaseAllOrigs();
    this._sessionActive = false;
    this._sessionProjectId = null;
    this._sessionLayer = -1;
  }

  beginStroke(engine) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    if (this.hasPendingCommits()) {
      this.flushPendingCommits(engine);
    }

    const cfg = this._getModeConfig(engine);
    this._ensureWorkDispSize(cfg.workTex);
    this._activeDispRes = cfg.dispRes;
    this._activeModeCfg = cfg;

    const projId = engine?.currentProjectId || 'default';
    const layer = engine?.activeLayer ?? -1;
    const canReuseSession = !!(
      cfg.sessionPersistent &&
      !engine?.activeSelectionPath &&
      this._sessionActive &&
      this._sessionProjectId === projId &&
      this._sessionLayer === layer &&
      this._sessionQuality === cfg.quality &&
      this._sessionDispRes === cfg.dispRes &&
      this.chunkOrigs.size > 0 &&
      this.chunkOrigs.size <= cfg.maxSessionOrigs
    );

    if (!canReuseSession) {
      this._releaseAllDispTiles();
      this._releaseAllOrigs();
      this._sessionActive = !!cfg.sessionPersistent && !engine?.activeSelectionPath;
      this._sessionProjectId = projId;
      this._sessionLayer = layer;
      this._sessionQuality = cfg.quality;
      this._sessionDispRes = cfg.dispRes;
    }

    this.touchedDestChunks.clear();
    this.boundMinDx = 0;
    this.boundMaxDx = 0;
    this.boundMinDy = 0;
    this.boundMaxDy = 0;
    this.active = true;
    return true;
  }

  _runBatch(engine, steps, minX, minY, maxX, maxY, R, falloff) {
    const gl = this.gl;
    const layer = engine.activeLayer;
    const cfg = this._activeModeCfg || this._getModeConfig(engine);
    const dispRes = cfg.dispRes;
    const workTex = this._workTexSize;

    // Align work origin and extents to texelWorld world pixels
    // so tile <-> workDisp transfers are exact 1:1 texel copies with zero bilinear drift.
    const texelWorld = TILE_SIZE / dispRes;
    const workX = Math.floor((Math.floor(minX) - 4) / texelWorld) * texelWorld;
    const workY = Math.floor((Math.floor(minY) - 4) / texelWorld) * texelWorld;
    const rawW = Math.ceil(maxX) + 4 - workX;
    const rawH = Math.ceil(maxY) + 4 - workY;
    const boxTexW = Math.min(workTex, Math.max(4, Math.ceil(rawW / texelWorld)));
    const boxTexH = Math.min(workTex, Math.max(4, Math.ceil(rawH / texelWorld)));
    const boxW = boxTexW * texelWorld;
    const boxH = boxTexH * texelWorld;

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // Pre-acquire ALL overlapping displacement tiles BEFORE binding workDispA.fbo!
    // (_acquireDispTile switches FBO, viewport, and scissor when zero-clearing a newly created tile.)
    const minTX = Math.floor(workX / TILE_SIZE);
    const maxTX = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const minTY = Math.floor(workY / TILE_SIZE);
    const maxTY = Math.floor((workY + boxH - 1) / TILE_SIZE);

    const assembledTiles = [];
    const existingTiles = [];
    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let ty = minTY; ty <= maxTY; ty++) {
        const { tile, isNew } = this._acquireDispTile(tx, ty, dispRes);
        if (!tile) continue;
        assembledTiles.push(tile);
        if (!isNew) {
          existingTiles.push(tile);
        }
      }
    }
    if (assembledTiles.length === 0) return;

    // 1. Assemble existing displacement tiles into workDispA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispA.fbo);
    gl.viewport(0, 0, workTex, workTex);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxTexW, boxTexH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (existingTiles.length > 0) {
      gl.useProgram(this.progRectMap);
      gl.uniform4f(this.rectLocs.u_dstRect, workX, workY, WORK_WORLD, WORK_WORLD);
      gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
      gl.uniform1i(this.rectLocs.u_tex, 0);
      gl.activeTexture(gl.TEXTURE0);

      for (let i = 0; i < existingTiles.length; i++) {
        const tile = existingTiles[i];
        gl.bindTexture(gl.TEXTURE_2D, tile.tex);
        gl.uniform4f(this.rectLocs.u_srcRect, tile.wx, tile.wy, TILE_SIZE, TILE_SIZE);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // 2. Single-pass GPU displacement accumulation (workDispA -> workDispB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workDispB.fbo);
    gl.viewport(0, 0, workTex, workTex);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxTexW, boxTexH);
    gl.useProgram(this.progDisplace);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workDispA.tex);
    gl.uniform1i(this.dispLocs.u_disp, 0);
    gl.uniform2f(this.dispLocs.u_workOrigin, workX, workY);
    gl.uniform1f(this.dispLocs.u_workWorldSize, WORK_WORLD);
    gl.uniform1f(this.dispLocs.u_radius, R);
    gl.uniform1f(this.dispLocs.u_falloff, falloff);

    const stepCount = Math.min(8, steps.length);
    for (let i = 0; i < stepCount; i++) {
      const st = steps[i];
      this._stepFromArr[i * 2] = st.fx;
      this._stepFromArr[i * 2 + 1] = st.fy;
      this._stepMvArr[i * 2] = st.mvx;
      this._stepMvArr[i * 2 + 1] = st.mvy;

      // Update conservative displacement bounds per touched tile
      const sMinX = st.fx - R - 4;
      const sMaxX = st.fx + R + 4;
      const sMinY = st.fy - R - 4;
      const sMaxY = st.fy + R + 4;
      for (let k = 0; k < assembledTiles.length; k++) {
        const t = assembledTiles[k];
        if (t.wx + TILE_SIZE < sMinX || t.wx > sMaxX || t.wy + TILE_SIZE < sMinY || t.wy > sMaxY) {
          continue;
        }
        if (st.mvx < 0) t.minDx += st.mvx;
        else t.maxDx += st.mvx;
        if (st.mvy < 0) t.minDy += st.mvy;
        else t.maxDy += st.mvy;
      }
    }
    gl.uniform1i(this.dispLocs.u_stepCount, stepCount);
    gl.uniform2fv(this.dispLocs.u_stepFrom, this._stepFromArr);
    gl.uniform2fv(this.dispLocs.u_stepMv, this._stepMvArr);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Persist updated displacement patches back to overlapping 128x128 tiles
    // Compute conservative [localMinDx..localMaxDx] across assembled tiles for tight source lookup
    let localMinDx = 0;
    let localMaxDx = 0;
    let localMinDy = 0;
    let localMaxDy = 0;

    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.progRectMap);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workDispB.tex);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, WORK_WORLD, WORK_WORLD);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);

    for (let i = 0; i < assembledTiles.length; i++) {
      const t = assembledTiles[i];
      if (t.minDx < localMinDx) localMinDx = t.minDx;
      if (t.maxDx > localMaxDx) localMaxDx = t.maxDx;
      if (t.minDy < localMinDy) localMinDy = t.minDy;
      if (t.maxDy > localMaxDy) localMaxDy = t.maxDy;

      const ox = Math.max(workX, t.wx);
      const oy = Math.max(workY, t.wy);
      const ox2 = Math.min(workX + boxW, t.wx + TILE_SIZE);
      const oy2 = Math.min(workY + boxH, t.wy + TILE_SIZE);
      if (ox2 <= ox || oy2 <= oy) continue;

      const scaleD = dispRes / TILE_SIZE;
      const sx = Math.max(0, Math.round((ox - t.wx) * scaleD));
      const sy = Math.max(0, Math.round((oy - t.wy) * scaleD));
      const ex = Math.min(dispRes, Math.round((ox2 - t.wx) * scaleD));
      const ey = Math.min(dispRes, Math.round((oy2 - t.wy) * scaleD));
      if (ex <= sx || ey <= sy) continue;

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, dispRes, dispRes);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx, sy, ex - sx, ey - sy);
      gl.uniform4f(this.rectLocs.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 4. Backward-warp pristine orig chunk snapshots directly into destination chunk.gpuTextures[layer]
    const dstMinX = Math.floor(minX);
    const dstMinY = Math.floor(minY);
    const dstMaxX = Math.ceil(maxX);
    const dstMaxY = Math.ceil(maxY);

    // Source bounds guaranteed to contain (worldPos - disp) for all pixels in dst box
    const srcMinX = Math.floor(dstMinX - localMaxDx - 6);
    const srcMaxX = Math.ceil(dstMaxX - localMinDx + 6);
    const srcMinY = Math.floor(dstMinY - localMaxDy - 6);
    const srcMaxY = Math.ceil(dstMaxY - localMinDy + 6);

    // Gather non-empty source chunks BEFORE binding progWarp
    const srcEntries = [];
    if (engine.isStatic) {
      const entry = this._ensureChunkOrig(engine, 0, 0, false);
      if (entry && !entry.wasEmpty && entry.origItem) {
        srcEntries.push(entry);
      }
    } else {
      const scx0 = Math.floor(srcMinX / engine.chunkSize);
      const scx1 = Math.floor(srcMaxX / engine.chunkSize);
      const scy0 = Math.floor(srcMinY / engine.chunkSize);
      const scy1 = Math.floor(srcMaxY / engine.chunkSize);
      for (let scx = scx0; scx <= scx1; scx++) {
        for (let scy = scy0; scy <= scy1; scy++) {
          const entry = this._ensureChunkOrig(engine, scx, scy, false);
          if (entry && !entry.wasEmpty && entry.origItem) {
            srcEntries.push(entry);
          }
        }
      }
    }

    // Pre-ensure ALL destination chunks BEFORE binding progWarp & TEXTURE1!
    // (_ensureChunkOrig invokes progBlit / chunkBlitFbo when snapshotting a newly entered chunk.)
    const dcx0 = engine.isStatic ? 0 : Math.floor(dstMinX / engine.chunkSize);
    const dcx1 = engine.isStatic ? 0 : Math.floor(dstMaxX / engine.chunkSize);
    const dcy0 = engine.isStatic ? 0 : Math.floor(dstMinY / engine.chunkSize);
    const dcy1 = engine.isStatic ? 0 : Math.floor(dstMaxY / engine.chunkSize);

    const dstTargets = [];
    for (let dcx = dcx0; dcx <= dcx1; dcx++) {
      for (let dcy = dcy0; dcy <= dcy1; dcy++) {
        const dstOrigEntry = this._ensureChunkOrig(engine, dcx, dcy, srcEntries.length > 0);
        if (!dstOrigEntry) continue;
        const dChunk = dstOrigEntry.chunk;
        const dlx = dstOrigEntry.lx;
        const dly = dstOrigEntry.ly;
        const dcw = dstOrigEntry.w;
        const dch = dstOrigEntry.h;

        const ox = Math.max(dstMinX, dlx);
        const oy = Math.max(dstMinY, dly);
        const ox2 = Math.min(dstMaxX, dlx + dcw);
        const oy2 = Math.min(dstMaxY, dly + dch);
        if (ox2 <= ox || oy2 <= oy) continue;

        if (!dChunk.gpuTextures?.[layer] && srcEntries.length === 0) continue;
        this._ensureChunkGpuTex(engine, dChunk, layer);

        const texW = dChunk.canvases[layer].width || dcw;
        const texH = dChunk.canvases[layer].height || dch;
        const scaleX = texW / dcw;
        const scaleY = texH / dch;

        const sx = Math.max(0, Math.floor((ox - dlx) * scaleX));
        const sy = Math.max(0, Math.floor((oy - dly) * scaleY));
        const ex = Math.min(texW, Math.ceil((ox2 - dlx) * scaleX));
        const ey = Math.min(texH, Math.ceil((oy2 - dly) * scaleY));
        const sw = ex - sx;
        const sh = ey - sy;
        if (sw <= 0 || sh <= 0) continue;

        dstTargets.push({ dcx, dcy, dChunk, dlx, dly, dcw, dch, texW, texH, sx, sy, ex, ey, sw, sh });
      }
    }

    if (dstTargets.length > 0) {
      const texelD = 1.0 / workTex;
      const dispClampX0 = 0.5 * texelD;
      const dispClampY0 = 0.5 * texelD;
      const dispClampX1 = Math.max(dispClampX0, (boxTexW - 0.5) * texelD);
      const dispClampY1 = Math.max(dispClampY0, (boxTexH - 0.5) * texelD);

      let warpProg = this.progWarpCrisp;
      let warpLocs = this.warpCrispLocs;
      if (cfg.filter === 'fast') {
        warpProg = this.progWarpFast;
        warpLocs = this.warpFastLocs;
      } else if (cfg.filter === 'ultra') {
        warpProg = this.progWarpUltra;
        warpLocs = this.warpUltraLocs;
      }

      gl.useProgram(warpProg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workDispB.tex);
      gl.uniform1i(warpLocs.u_workDisp, 1);
      gl.uniform1i(warpLocs.u_srcOrig, 0);
      gl.uniform2f(warpLocs.u_dispOrigin, workX, workY);
      gl.uniform1f(warpLocs.u_dispWorldSize, WORK_WORLD);
      gl.uniform4f(warpLocs.u_dispClamp, dispClampX0, dispClampY0, dispClampX1, dispClampY1);

      for (let i = 0; i < dstTargets.length; i++) {
        const dt = dstTargets[i];
        const { dcx, dcy, dChunk, dlx, dly, dcw, dch, texW, texH, sx, sy, ex, ey, sw, sh } = dt;

        const id = `${dcx},${dcy}`;
        let tRec = this.touchedDestChunks.get(id);
        if (!tRec) {
          tRec = {
            cx: dcx,
            cy: dcy,
            chunk: dChunk,
            minX: sx,
            minY: sy,
            maxX: ex,
            maxY: ey,
            wasEmpty: !!(dChunk.isEmpty && dChunk.isEmpty[layer])
          };
          this.touchedDestChunks.set(id, tRec);
        } else {
          if (sx < tRec.minX) tRec.minX = sx;
          if (sy < tRec.minY) tRec.minY = sy;
          if (ex > tRec.maxX) tRec.maxX = ex;
          if (ey > tRec.maxY) tRec.maxY = ey;
        }
        if (dChunk.isEmpty) dChunk.isEmpty[layer] = false;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dChunk.gpuTextures[layer], 0);
        gl.viewport(0, 0, texW, texH);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, sy, sw, sh);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.uniform4f(warpLocs.u_dstWorldRect, dlx, dly, dcw, dch);
        gl.activeTexture(gl.TEXTURE0);

        for (let s = 0; s < srcEntries.length; s++) {
          const se = srcEntries[s];
          gl.bindTexture(gl.TEXTURE_2D, se.origItem.tex);
          gl.uniform4f(
            warpLocs.u_srcWorldBounds,
            se.lx,
            se.ly,
            se.lx + se.w,
            se.ly + se.h
          );
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
    }

    // Cleanly detach textures & restore GL state for compositor render
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  stepMove(engine, from, to, dynamicSize, pressure) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost()) return false;

    const totalDx = to.x - from.x;
    const totalDy = to.y - from.y;
    const dist = Math.hypot(totalDx, totalDy);
    if (dist < 0.2) return true;

    const currentSize = dynamicSize || engine.brush.size || 50;
    const R = Math.max(4.0, currentSize * 0.5);

    const flow = (engine.brush.flow !== undefined) ? engine.brush.flow : 0.40;
    let strength;
    if (pressure !== undefined && Number.isFinite(pressure) && pressure > 0 && pressure !== 0.5) {
      strength = Math.max(0.01, Math.min(1.0, flow * (0.15 + 0.85 * pressure)));
    } else {
      strength = Math.max(0.01, Math.min(1.0, flow));
    }
    const falloff = (engine.brush.falloff !== undefined) ? engine.brush.falloff : 0.50;

    // Limit each batch span so its [min..max] + R fits cleanly inside WORK_WORLD (2048)
    const cfg = this._activeModeCfg || this._getModeConfig(engine);
    const maxSpan = Math.max(64.0, WORK_WORLD - (R * 2 + 48));
    const maxSubStepDist = Math.max(cfg.minSubStep, R * cfg.subStepFactor);
    const totalSubSteps = Math.max(1, Math.ceil(dist / maxSubStepDist));

    let idx = 0;
    while (idx < totalSubSteps) {
      const steps = [];
      let bMinX = Infinity;
      let bMaxX = -Infinity;
      let bMinY = Infinity;
      let bMaxY = -Infinity;

      const batchStartX = from.x + totalDx * (idx / totalSubSteps);
      const batchStartY = from.y + totalDy * (idx / totalSubSteps);

      while (idx < totalSubSteps && steps.length < 8) {
        const t0 = idx / totalSubSteps;
        const t1 = (idx + 1) / totalSubSteps;
        const curFx = from.x + totalDx * t0;
        const curFy = from.y + totalDy * t0;
        const nextX = from.x + totalDx * t1;
        const nextY = from.y + totalDy * t1;

        if (steps.length > 0) {
          const spanX = Math.abs(nextX - batchStartX);
          const spanY = Math.abs(nextY - batchStartY);
          if (spanX > maxSpan || spanY > maxSpan) break;
        }

        const mvx = (nextX - curFx) * strength;
        const mvy = (nextY - curFy) * strength;
        steps.push({ fx: curFx, fy: curFy, mvx, mvy });

        bMinX = Math.min(bMinX, curFx - R - 8, nextX - R - 8);
        bMaxX = Math.max(bMaxX, curFx + R + 8, nextX + R + 8);
        bMinY = Math.min(bMinY, curFy - R - 8, nextY - R - 8);
        bMaxY = Math.max(bMaxY, curFy + R + 8, nextY + R + 8);

        if (mvx < 0) this.boundMinDx += mvx;
        else this.boundMaxDx += mvx;
        if (mvy < 0) this.boundMinDy += mvy;
        else this.boundMaxDy += mvy;

        idx++;
      }

      if (steps.length > 0) {
        this._runBatch(engine, steps, bMinX, bMinY, bMaxX, bMaxY, R, falloff);
      }
    }

    this.gpuRenderer.requestRender();
    return true;
  }

  hasPendingCommits() {
    return this._pendingQueue.length > 0 || this._inFlightPBOs.length > 0;
  }

  whenCommitsDone(cb) {
    if (typeof cb !== 'function') return;
    if (!this.hasPendingCommits()) {
      cb();
      return;
    }
    this._onAllCommitsDone.push(cb);
  }

  _notifyAllCommitsDone() {
    if (this._onAllCommitsDone.length === 0) return;
    const cbs = this._onAllCommitsDone.slice();
    this._onAllCommitsDone.length = 0;
    for (let i = 0; i < cbs.length; i++) {
      try {
        cbs[i]();
      } catch (e) {
        console.warn('GPU commit completion callback error:', e);
      }
    }
  }

  _ensureCommitResources() {
    const gl = this.gl;
    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = COMMIT_TILE;
      this._commitCanvas.height = COMMIT_TILE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._commitImgData = this._commitCtx.createImageData(COMMIT_TILE, COMMIT_TILE);
      this._commitU8 = new Uint8Array(this._commitImgData.data.buffer);
    }
    if (this._pboSupported && this._pboRing.length === 0 && gl && !gl.isContextLost()) {
      const maxBytes = COMMIT_TILE * COMMIT_TILE * 4;
      for (let i = 0; i < PBO_RING_SIZE; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, maxBytes, gl.STREAM_READ);
        this._pboRing.push({ pbo, inUse: false });
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }

  _getTileImgData(rw, rh) {
    if (rw === COMMIT_TILE && rh === COMMIT_TILE) {
      return { imgData: this._commitImgData, u8: this._commitU8 };
    }
    const key = `${rw}x${rh}`;
    let entry = this._edgeImgDataMap.get(key);
    if (!entry) {
      if (this._edgeImgDataMap.size >= 16) {
        this._edgeImgDataMap.clear();
      }
      const imgData = this._commitCtx.createImageData(rw, rh);
      entry = {
        imgData,
        u8: new Uint8Array(imgData.data.buffer)
      };
      this._edgeImgDataMap.set(key, entry);
    }
    return entry;
  }

  _beginReadbackPass() {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.useProgram(this.progUnpremult);
    gl.uniform1i(this.unpremultLocs.u_tex, 0);
    gl.uniform4f(this.unpremultLocs.u_dstRect, 0, 0, COMMIT_TILE, COMMIT_TILE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.commitTile.fbo);
    gl.viewport(0, 0, COMMIT_TILE, COMMIT_TILE);
    gl.enable(gl.SCISSOR_TEST);
  }

  _endReadbackPass() {
    const gl = this.gl;
    if (this._pboSupported) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _writeTileToCanvas2D(item, imgData) {
    const { ctx, tx, ty, rw, rh } = item;
    if (!ctx) return;
    this._commitCtx.putImageData(imgData, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(tx, ty, rw, rh);
    ctx.drawImage(this._commitCanvas, 0, 0, rw, rh, tx, ty, rw, rh);
    ctx.restore();
  }

  _dispatchNextPBOs(maxDispatch = PBO_RING_SIZE) {
    const gl = this.gl;
    if (!gl || !this._pboSupported || this._pendingQueue.length === 0) return 0;

    let freeCount = 0;
    for (let i = 0; i < this._pboRing.length; i++) {
      if (!this._pboRing[i].inUse) freeCount++;
    }
    const targetDispatch = Math.min(maxDispatch, freeCount, this._pendingQueue.length);
    if (targetDispatch <= 0) return 0;

    this._beginReadbackPass();
    let dispatched = 0;
    while (dispatched < targetDispatch && this._pendingQueue.length > 0) {
      let slot = null;
      for (let i = 0; i < this._pboRing.length; i++) {
        if (!this._pboRing[i].inUse) {
          slot = this._pboRing[i];
          break;
        }
      }
      if (!slot) break;

      const tile = this._pendingQueue.shift();
      const { tex, tx, ty, rw, rh, texW, texH } = tile;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.scissor(0, 0, rw, rh);
      gl.uniform4f(this.unpremultLocs.u_srcRect, 0, 0, rw, rh);
      gl.uniform4f(
        this.unpremultLocs.u_uvSubRect,
        tx / texW,
        ty / texH,
        rw / texW,
        rh / texH
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      slot.inUse = true;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this._inFlightPBOs.push({ slot, sync, tile });
      dispatched++;
    }
    this._endReadbackPass();
    if (dispatched > 0) {
      gl.flush();
    }
    return dispatched;
  }

  _scheduleCommitPump() {
    if (this._commitRafId !== null) return;
    if (!this.hasPendingCommits()) return;
    this._commitRafId = requestAnimationFrame(() => {
      this._commitRafId = null;
      this._pumpAsyncCommits();
    });
  }

  _pumpAsyncCommits() {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost()) {
      this._discardPendingCommits();
      return;
    }

    const tStart = performance.now();
    this._ensureCommitResources();

    // 1. Drain completed PBOs with zero-blocking clientWaitSync (timeout 0)
    let boundPbo = false;
    while (this._inFlightPBOs.length > 0) {
      const head = this._inFlightPBOs[0];
      const status = gl.clientWaitSync(head.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        break;
      }
      this._inFlightPBOs.shift();
      gl.deleteSync(head.sync);

      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        const { tile, slot } = head;
        const { imgData, u8 } = this._getTileImgData(tile.rw, tile.rh);
        const byteLen = tile.rw * tile.rh * 4;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        boundPbo = true;
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, u8, 0, byteLen);
        this._writeTileToCanvas2D(tile, imgData);
      }
      head.slot.inUse = false;

      if ((performance.now() - tStart) >= ASYNC_FRAME_BUDGET_MS) {
        break;
      }
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    // 2. Dispatch next batch of non-blocking PBO reads if within CPU budget
    if (this._pendingQueue.length > 0 && (performance.now() - tStart) < ASYNC_FRAME_BUDGET_MS) {
      this._dispatchNextPBOs(3);
    }

    if (this.hasPendingCommits()) {
      this._scheduleCommitPump();
    } else {
      this._notifyAllCommitsDone();
    }
  }

  flushPendingCommits(engine = null) {
    if (this._commitRafId !== null) {
      cancelAnimationFrame(this._commitRafId);
      this._commitRafId = null;
    }
    if (!this.hasPendingCommits()) {
      this._notifyAllCommitsDone();
      return;
    }

    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost()) {
      this._discardPendingCommits();
      return;
    }

    this._ensureCommitResources();

    // 1. Complete any in-flight PBO readbacks with a single gl.finish()
    if (this._inFlightPBOs.length > 0) {
      gl.finish();
      let boundPbo = false;
      while (this._inFlightPBOs.length > 0) {
        const item = this._inFlightPBOs.shift();
        const status = gl.clientWaitSync(item.sync, 0, 0);
        gl.deleteSync(item.sync);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          const { tile, slot } = item;
          const { imgData, u8 } = this._getTileImgData(tile.rw, tile.rh);
          const byteLen = tile.rw * tile.rh * 4;
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
          boundPbo = true;
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, u8, 0, byteLen);
          this._writeTileToCanvas2D(tile, imgData);
        }
        item.slot.inUse = false;
      }
      if (boundPbo) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
    }

    // 2. Drain any remaining queued tiles synchronously
    if (this._pendingQueue.length > 0) {
      this._beginReadbackPass();
      while (this._pendingQueue.length > 0) {
        const tile = this._pendingQueue.shift();
        const { tex, tx, ty, rw, rh, texW, texH } = tile;
        const { imgData, u8 } = this._getTileImgData(rw, rh);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.scissor(0, 0, rw, rh);
        gl.uniform4f(this.unpremultLocs.u_srcRect, 0, 0, rw, rh);
        gl.uniform4f(
          this.unpremultLocs.u_uvSubRect,
          tx / texW,
          ty / texH,
          rw / texW,
          rh / texH
        );
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, u8);
        this._writeTileToCanvas2D(tile, imgData);
      }
      this._endReadbackPass();
    }

    this._notifyAllCommitsDone();
  }

  _discardPendingCommits() {
    if (this._commitRafId !== null) {
      cancelAnimationFrame(this._commitRafId);
      this._commitRafId = null;
    }
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (let i = 0; i < this._inFlightPBOs.length; i++) {
        try { gl.deleteSync(this._inFlightPBOs[i].sync); } catch (_) {}
      }
    }
    for (let i = 0; i < this._pboRing.length; i++) {
      this._pboRing[i].inUse = false;
    }
    this._inFlightPBOs.length = 0;
    this._pendingQueue.length = 0;
    this._notifyAllCommitsDone();
  }

  onContextLost() {
    this._discardPendingCommits();
    this.activeDispTiles.clear();
    this.dispPools = { 128: [], 256: [] };
    this.chunkOrigs.clear();
    this.origPool = [];
    this.touchedDestChunks.clear();
    this._pboRing = [];
    this.workDispA = null;
    this.workDispB = null;
    this.commitTile = null;
    this.chunkBlitFbo = null;
    this.progRectMap = null;
    this.progBlit = null;
    this.progDisplace = null;
    this.progWarpFast = null;
    this.progWarpCrisp = null;
    this.progWarpUltra = null;
    this.progUnpremult = null;
    this._sessionActive = false;
    this._sessionProjectId = null;
    this._sessionLayer = -1;
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
  }

  _commitToCanvas2D(engine, syncImmediate = false) {
    if (this.touchedDestChunks.size === 0) return;

    const layer = engine.activeLayer;
    this._ensureCommitResources();

    if (!engine.offscreenDirty) {
      engine.offscreenDirty = new Set();
    }

    this.touchedDestChunks.forEach((rec, id) => {
      const { cx, cy, chunk, minX, minY, maxX, maxY, wasEmpty } = rec;
      const tex = chunk.gpuTextures?.[layer];
      const canvas = chunk.canvases?.[layer];
      const ctx = chunk.ctxs?.[layer];
      if (!tex || !canvas || !ctx) return;

      const texW = canvas.width;
      const texH = canvas.height;
      const rx0 = Math.max(0, minX | 0);
      const ry0 = Math.max(0, minY | 0);
      const rx1 = Math.min(texW, Math.ceil(maxX));
      const ry1 = Math.min(texH, Math.ceil(maxY));
      if (rx1 <= rx0 || ry1 <= ry0) return;

      // Capture pristine Canvas2D backup BEFORE overwriting Canvas2D pixels with warped result.
      // Pass markDirty: false so we NEVER mark chunk.gpuDirty[layer] = true (GPU texture is already current!).
      const prevEmptyFlag = chunk.isEmpty ? chunk.isEmpty[layer] : false;
      if (chunk.isEmpty) chunk.isEmpty[layer] = wasEmpty;
      backupChunkLayer(engine, chunk, id, { layer, markDirty: false });
      if (chunk.isEmpty) chunk.isEmpty[layer] = prevEmptyFlag;

      const clx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
      const cly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
      const worldX0 = clx + rx0;
      const worldY0 = cly + ry0;
      const worldX1 = clx + rx1;
      const worldY1 = cly + ry1;
      engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, worldX0);
      engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, worldX1);
      engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, worldY0);
      engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, worldY1);

      if (chunk.isEmpty) chunk.isEmpty[layer] = false;
      if (chunk.gpuDirty) chunk.gpuDirty[layer] = false;
      if (chunk._cachedOffscreenImageData) {
        chunk._cachedOffscreenImageData[layer] = null;
      }
      engine.dirtyChunks.add(`${id}|${layer}`);
      engine.offscreenDirty.add(`${id}|${layer}`);

      for (let ty = ry0; ty < ry1; ty += COMMIT_TILE) {
        const rh = Math.min(COMMIT_TILE, ry1 - ty);
        for (let tx = rx0; tx < rx1; tx += COMMIT_TILE) {
          const rw = Math.min(COMMIT_TILE, rx1 - tx);
          this._pendingQueue.push({
            id,
            layer,
            chunk,
            ctx,
            tex,
            tx,
            ty,
            rw,
            rh,
            texW,
            texH
          });
        }
      }
    });

    if (!this.hasPendingCommits()) return;

    const requireSync = syncImmediate || !this._pboSupported || !!engine.activeSelectionPath;
    if (requireSync) {
      this.flushPendingCommits(engine);
    } else {
      // Kick off first ring batch of non-blocking async PBO DMA transfers immediately,
      // then drain across upcoming rAF slices with 0 blocking gl.readPixels stalls.
      this._dispatchNextPBOs(PBO_RING_SIZE);
      if (this.hasPendingCommits()) {
        this._scheduleCommitPump();
      }
    }
  }

  endStroke(engine) {
    if (!this.ready || !this.active) return;

    this._commitToCanvas2D(engine, !!engine.activeSelectionPath);
    const cfg = this._activeModeCfg || this._getModeConfig(engine);
    const keepSession = !!(
      cfg.sessionPersistent &&
      this._sessionActive &&
      !engine.activeSelectionPath &&
      this.chunkOrigs.size <= cfg.maxSessionOrigs
    );

    if (!keepSession) {
      this._releaseAllDispTiles();
      this._releaseAllOrigs();
      this._sessionActive = false;
    }

    this.touchedDestChunks.clear();
    this.active = false;
    this.gpuRenderer.requestRender();
  }

  cancel(engine = null) {
    const targetEngine = engine || (this.gpuRenderer ? this.gpuRenderer.engine : null);
    const layer = targetEngine ? targetEngine.activeLayer : -1;
    if (layer >= 0 && this.touchedDestChunks.size > 0) {
      this.touchedDestChunks.forEach(({ chunk, wasEmpty }) => {
        if (chunk) {
          if (chunk.isEmpty && wasEmpty) {
            chunk.isEmpty[layer] = true;
          }
          if (chunk.gpuDirty) {
            chunk.gpuDirty[layer] = true;
          }
        }
      });
    }
    this._releaseAllDispTiles();
    this._releaseAllOrigs();
    this._sessionActive = false;
    this.touchedDestChunks.clear();
    this.active = false;
    if (this.gl && !this.gl.isContextLost()) {
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.requestRender();
    }
  }

  resetProjectState() {
    this._discardPendingCommits();
    this.cancel(null);
    this._edgeImgDataMap.clear();
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (const res of [128, 256]) {
        const pool = this.dispPools[res];
        if (pool) {
          while (pool.length > 4) this._delTexFbo(pool.pop());
        }
      }
      while (this.origPool.length > 1) {
        this._delTexFbo(this.origPool.pop());
      }
    }
  }

  dispose() {
    this._discardPendingCommits();
    const gl = this.gl;
    if (!gl) return;
    this._releaseAllDispTiles();
    this._releaseAllOrigs();
    this._sessionActive = false;
    this.touchedDestChunks.clear();

    if (!gl.isContextLost()) {
      for (const res of [128, 256]) {
        const pool = this.dispPools[res];
        if (pool) {
          for (const d of pool) this._delTexFbo(d);
          pool.length = 0;
        }
      }
      for (const o of this.origPool) {
        this._delTexFbo(o);
      }
      for (const slot of this._pboRing) {
        if (slot && slot.pbo) gl.deleteBuffer(slot.pbo);
      }
      this._delTexFbo(this.workDispA);
      this._delTexFbo(this.workDispB);
      this._delTexFbo(this.commitTile);
      if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
      [
        this.progRectMap,
        this.progBlit,
        this.progDisplace,
        this.progWarpFast,
        this.progWarpCrisp,
        this.progWarpUltra,
        this.progUnpremult
      ].forEach((p) => {
        if (p) gl.deleteProgram(p);
      });
    }

    this.dispPools = { 128: [], 256: [] };
    this.origPool = [];
    this._pboRing = [];
    this._edgeImgDataMap.clear();
    this._commitCanvas = null;
    this._commitCtx = null;
    this._commitImgData = null;
    this._commitU8 = null;
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
  }
}
