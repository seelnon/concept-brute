import { LAYERS_COUNT, TOOLS } from '../constants.js';
import { GLSL_SURFACE_BIOME_SAMPLER } from './canvasSurfaceGpu.js';

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
uniform vec4 u_uvRect;

out vec2 v_uv;
out vec2 v_worldPos;

void main() {
    v_uv = u_uvRect.xy + a_unitPos * u_uvRect.zw;
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
uniform int u_excludeActive;
uniform vec4 u_excludeRect;
uniform vec4 u_uvClamp;

uniform vec2 u_viewport;
uniform vec2 u_invDpr;
uniform vec2 u_viewCenter;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_cosR;
uniform float u_sinR;
uniform float u_isMirrored;

uniform int u_useSurfaceBg;
uniform float u_surfaceInvScale;
uniform float u_surfaceBgOpacity;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;

out vec4 outColor;

${GLSL_SURFACE_BIOME_SAMPLER}

void main() {
    if (u_clipToBoard == 1) {
        if (abs(v_worldPos.x) > u_boardHalfSize.x || abs(v_worldPos.y) > u_boardHalfSize.y) {
            discard;
        }
    }

    if (u_excludeActive != 0) {
        // Compute world coordinate identically from gl_FragCoord for both chunk & overlay
        // so boundary pixels never suffer MSAA triangle-edge / float-interpolation 1px seams.
        vec2 cssPos = vec2(gl_FragCoord.x * u_invDpr.x, u_viewport.y - gl_FragCoord.y * u_invDpr.y);
        vec2 d = (cssPos - u_viewCenter - u_pan) / u_zoom;
        vec2 fragWorldPos = vec2(
            d.x * u_cosR + d.y * u_sinR,
            -d.x * u_sinR + d.y * u_cosR
        );
        if (u_isMirrored > 0.5) {
            fragWorldPos.x = -fragWorldPos.x;
        }
        bool inBox = (fragWorldPos.x >= u_excludeRect.x && fragWorldPos.x < u_excludeRect.z &&
                      fragWorldPos.y >= u_excludeRect.y && fragWorldPos.y < u_excludeRect.w);
        if (u_excludeActive == 1 && inBox) {
            discard;
        }
        if (u_excludeActive == 2 && !inBox) {
            discard;
        }
    }

    if (u_useSurfaceBg == 1) {
        vec3 texCol = sampleSurfaceColorBiome(
            u_tex,
            v_worldPos,
            u_surfaceInvScale,
            u_surfaceBiomeMix,
            u_surfaceAllowRotate,
            u_surfaceScaleSpread
        );
        // Blend cleanly with user's chosen canvasBg color while letting dark/bright bg tint grain
        vec3 baseBg = u_solidColor.rgb;
        float bgLum = dot(baseBg, vec3(0.299, 0.587, 0.114));
        vec3 tinted = mix(baseBg * texCol * 1.06, mix(baseBg, texCol, 0.85), clamp((1.0 - bgLum) * 0.4 + 0.5, 0.0, 1.0));
        vec3 finalBg = mix(baseBg, tinted, u_surfaceBgOpacity);
        outColor = vec4(clamp(finalBg, 0.0, 1.0), 1.0);
    } else if (u_useSolidColor == 1) {
        outColor = vec4(u_solidColor.rgb * u_solidColor.a * u_opacity, u_solidColor.a * u_opacity);
    } else {
        vec2 uv = (u_excludeActive == 2) ? clamp(v_uv, u_uvClamp.xy, u_uvClamp.zw) : v_uv;
        vec4 texColor = texture(u_tex, uv);
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

const LIQUIFY_CURSOR_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_unitPos;

uniform vec2 u_viewport;
uniform vec4 u_cursorRect;   // [leftCss, topCss, widthCss, heightCss]
uniform vec2 u_cursorCenter; // [mxCss, myCss]

out vec2 v_localPos;

void main() {
    vec2 screenPos = u_cursorRect.xy + a_unitPos * u_cursorRect.zw;
    v_localPos = screenPos - u_cursorCenter;
    vec2 clipPos = vec2(
        (screenPos.x / u_viewport.x) * 2.0 - 1.0,
        1.0 - (screenPos.y / u_viewport.y) * 2.0
    );
    gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const LIQUIFY_CURSOR_FS = `#version 300 es
precision highp float;

in vec2 v_localPos;

uniform float u_cursorRadius;
uniform float u_falloff;

out vec4 outColor;

void main() {
    float outerR = max(2.0, u_cursorRadius);
    float r = length(v_localPos);

    // Outer solid circle at full brush radius
    float dOuter = abs(r - outerR);
    float darkOuter = 1.0 - smoothstep(0.95, 1.65, dOuter);
    float whiteOuter = 1.0 - smoothstep(0.35, 1.05, dOuter);

    // Inner dashed plateau circle showing hard-edge vs falloff zone
    float rInnerRatio = clamp(1.0 - clamp(u_falloff, 0.0, 1.0), 0.0, 1.0);
    float innerR = (rInnerRatio >= 0.96) ? max(1.0, outerR - 3.5) : (outerR * rInnerRatio);

    float darkInner = 0.0;
    float whiteInner = 0.0;
    if (innerR >= 5.0) {
        float dInner = abs(r - innerR);
        float circum = 6.2831853 * innerR;
        float dashCount = max(8.0, floor(circum / 11.0));
        float dashPeriod = circum / dashCount;
        float ang = atan(v_localPos.y, v_localPos.x) + 3.14159265;
        float sArc = fract((ang / 6.2831853) * dashCount) * dashPeriod;
        float signedArcD = abs(sArc - dashPeriod * 0.5) - dashPeriod * 0.27;
        float dDash2D = length(vec2(max(0.0, signedArcD), dInner));
        darkInner = 1.0 - smoothstep(0.95, 1.65, dDash2D);
        whiteInner = 1.0 - smoothstep(0.35, 1.05, dDash2D);
    }

    // Center "+" crosshair
    float dH = length(vec2(max(0.0, abs(v_localPos.x) - 4.5), abs(v_localPos.y)));
    float dV = length(vec2(abs(v_localPos.x), max(0.0, abs(v_localPos.y) - 4.5)));
    float dCross = min(dH, dV);
    float darkCross = 1.0 - smoothstep(0.95, 1.65, dCross);
    float whiteCross = 1.0 - smoothstep(0.35, 1.05, dCross);

    float totalDark = max(darkOuter, max(darkInner, darkCross)) * 0.65;
    float totalWhite = max(whiteOuter, max(whiteInner, whiteCross));
    float a = clamp(max(totalDark, totalWhite), 0.0, 1.0);
    if (a <= 0.002) {
        discard;
    }

    vec3 rgb = mix(vec3(0.06), vec3(0.98), clamp(totalWhite, 0.0, 1.0));
    outColor = vec4(rgb * a, a);
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
    this._contextLost = false;
    this.selectionTexture = null;

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.supported = false;
      this._contextLost = true;
      this._renderPending = false;
      if (this.liquifySolver && this.liquifySolver.onContextLost) {
        this.liquifySolver.onContextLost();
      }
      if (this.smudgeSolver) {
        this.smudgeSolver.active = false;
        this.smudgeSolver.ready = false;
      }
      if (this.fluidSolver) {
        this.fluidSolver.active = false;
        this.fluidSolver.ready = false;
      }
      if (this.airSolver) {
        this.airSolver.active = false;
        this.airSolver.ready = false;
      }
      if (this.sumiSolver) {
        this.sumiSolver.active = false;
        this.sumiSolver.ready = false;
      }
      this.sumiOverlay = null;
      this.canvas.style.display = 'none';
      if (this.engine) {
        if (typeof this.engine._resetInteractionState === 'function') {
          this.engine._resetInteractionState({ cancelActive: false });
        }
        if (typeof this.engine._enableDomFallback === 'function') {
          this.engine._enableDomFallback();
        } else if (this.engine.canvasWrapper) {
          this.engine.canvasWrapper.style.display = '';
        }
      }
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      this._handleContextRestored();
    });

    if (this.supported) {
      this._initGL();
    }
  }

  _handleContextRestored() {
    if (!this.gl || this.gl.isContextLost()) return;
    this._contextLost = false;
    this.supported = true;

    this.selectionTexture = null;
    this.airSolver = null;
    this.airOverlay = null;
    this.fluidSolver = null;
    this.fluidOverlay = null;
    this.smudgeSolver = null;
    this.smudgeOverlay = null;
    this.liquifySolver = null;
    this.sumiSolver = null;
    this.sumiOverlay = null;

    if (this.engine && this.engine.chunks) {
      this.engine.chunks.forEach(chunk => {
        if (chunk.gpuTextures) chunk.gpuTextures.fill(null);
        chunk.gpuStrokeTexture = null;
      });
    }
    if (this.engine && this.engine.referenceImages) {
      this.engine.referenceImages.forEach(ref => {
        ref.gpuTexture = null;
        ref.gpuDirty = true;
      });
    }

    this._initGL();
    if (this.supported) {
      this.canvas.style.display = '';
      if (this.engine && this.engine.canvasWrapper) {
        this.engine.canvasWrapper.style.display = 'none';
      }
      this.markAllChunksDirty();
      this.requestRender();
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
    if (!gl || gl.isContextLost()) {
      this.supported = false;
      return;
    }
    this.quadProgram = this._createProgram(QUAD_VS, QUAD_FS);
    this.gridProgram = this._createProgram(GRID_VS, GRID_FS);
    if (!this.quadProgram || !this.gridProgram) {
      this.supported = false;
      return;
    }

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
      u_uvRect: gl.getUniformLocation(this.quadProgram, 'u_uvRect'),
      u_tex: gl.getUniformLocation(this.quadProgram, 'u_tex'),
      u_solidColor: gl.getUniformLocation(this.quadProgram, 'u_solidColor'),
      u_useSolidColor: gl.getUniformLocation(this.quadProgram, 'u_useSolidColor'),
      u_opacity: gl.getUniformLocation(this.quadProgram, 'u_opacity'),
      u_clipToBoard: gl.getUniformLocation(this.quadProgram, 'u_clipToBoard'),
      u_boardHalfSize: gl.getUniformLocation(this.quadProgram, 'u_boardHalfSize'),
      u_excludeActive: gl.getUniformLocation(this.quadProgram, 'u_excludeActive'),
      u_excludeRect: gl.getUniformLocation(this.quadProgram, 'u_excludeRect'),
      u_uvClamp: gl.getUniformLocation(this.quadProgram, 'u_uvClamp'),
      u_invDpr: gl.getUniformLocation(this.quadProgram, 'u_invDpr'),
      u_useSurfaceBg: gl.getUniformLocation(this.quadProgram, 'u_useSurfaceBg'),
      u_surfaceInvScale: gl.getUniformLocation(this.quadProgram, 'u_surfaceInvScale'),
      u_surfaceBgOpacity: gl.getUniformLocation(this.quadProgram, 'u_surfaceBgOpacity'),
      u_surfaceBiomeMix: gl.getUniformLocation(this.quadProgram, 'u_surfaceBiomeMix'),
      u_surfaceAllowRotate: gl.getUniformLocation(this.quadProgram, 'u_surfaceAllowRotate'),
      u_surfaceScaleSpread: gl.getUniformLocation(this.quadProgram, 'u_surfaceScaleSpread')
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

    this.liquifyCursorProgram = this._createProgram(LIQUIFY_CURSOR_VS, LIQUIFY_CURSOR_FS);
    if (this.liquifyCursorProgram) {
      this.liquifyCursorLocs = {
        u_viewport: gl.getUniformLocation(this.liquifyCursorProgram, 'u_viewport'),
        u_cursorRect: gl.getUniformLocation(this.liquifyCursorProgram, 'u_cursorRect'),
        u_cursorCenter: gl.getUniformLocation(this.liquifyCursorProgram, 'u_cursorCenter'),
        u_cursorRadius: gl.getUniformLocation(this.liquifyCursorProgram, 'u_cursorRadius'),
        u_falloff: gl.getUniformLocation(this.liquifyCursorProgram, 'u_falloff')
      };
    }

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

  updateChunkTextureSubRegion(chunk, layer, x, y, width, height, dataOrImageData) {
    if (!this.gl || !chunk || !this.supported || width <= 0 || height <= 0) return false;
    const gl = this.gl;
    if (!chunk.gpuTextures) {
      chunk.gpuTextures = new Array(LAYERS_COUNT).fill(null);
    }
    let tex = chunk.gpuTextures[layer];
    if (!tex) {
      tex = this._createOrUpdateTexture(null, chunk.canvases[layer], true);
      chunk.gpuTextures[layer] = tex;
      if (chunk.gpuDirty) chunk.gpuDirty[layer] = false;
      return true;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (dataOrImageData instanceof ImageData) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, dataOrImageData.data);
    } else if (dataOrImageData instanceof Uint8Array || dataOrImageData instanceof Uint8ClampedArray) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, dataOrImageData);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, dataOrImageData);
    }
    if (chunk.gpuDirty) {
      chunk.gpuDirty[layer] = false;
    }
    return true;
  }

  markChunkStrokeDirty(chunk, active = true) {
    if (!chunk) return;
    chunk.gpuStrokeDirty = true;
    chunk.gpuStrokeActive = active;
    this.requestRender();
  }

  markAllChunksDirty() {
    this.engine.chunks.forEach(chunk => {
      if (!chunk.gpuDirty) {
        chunk.gpuDirty = new Array(LAYERS_COUNT).fill(false);
      }
      for (let l = 0; l < LAYERS_COUNT; l++) {
        if (!chunk.isEmpty || !chunk.isEmpty[l] || (chunk.gpuTextures && chunk.gpuTextures[l])) {
          chunk.gpuDirty[l] = true;
        }
      }
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
    if (this.airSolver) {
      this.airSolver.dispose();
      this.airSolver = null;
    }
    this.airOverlay = null;
    if (this.fluidSolver) {
      this.fluidSolver.dispose();
      this.fluidSolver = null;
    }
    this.fluidOverlay = null;
    if (this.smudgeSolver) {
      this.smudgeSolver.dispose();
      this.smudgeSolver = null;
    }
    this.smudgeOverlay = null;
    if (this.liquifySolver) {
      this.liquifySolver.dispose();
      this.liquifySolver = null;
    }
    if (this.sumiSolver) {
      this.sumiSolver.dispose();
      this.sumiSolver = null;
    }
    this.sumiOverlay = null;
    if (this.engine && this.engine.surfaceManager) {
      this.engine.surfaceManager.dispose();
    }
  }

  requestRender() {
    if (!this.supported || this._contextLost || this._renderPending || !this.gl || this.gl.isContextLost()) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      this.render();
    });
  }

  render() {
    if (!this.supported || this._contextLost || !this.gl || this.gl.isContextLost()) return;
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

    // Guarantee clean default screen framebuffer and compositor state regardless of tool passes
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
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
    gl.uniform2f(this.quadLocs.u_invDpr, viewW / targetW, viewH / targetH);
    gl.uniform2f(this.quadLocs.u_viewCenter, cx, cy);
    gl.uniform2f(this.quadLocs.u_pan, px, py);
    gl.uniform1f(this.quadLocs.u_zoom, zoom);
    gl.uniform1f(this.quadLocs.u_cosR, cosR);
    gl.uniform1f(this.quadLocs.u_sinR, sinR);
    gl.uniform1f(this.quadLocs.u_isMirrored, isMirrored);
    gl.uniform1i(this.quadLocs.u_tex, 0);
    gl.uniform4f(this.quadLocs.u_uvRect, 0, 0, 1, 1);
    gl.uniform4f(this.quadLocs.u_uvClamp, 0, 0, 1, 1);
    gl.uniform2f(this.quadLocs.u_boardHalfSize, engine.staticWidth * 0.5, engine.staticHeight * 0.5);
    gl.uniform1i(this.quadLocs.u_excludeActive, 0);

    // Compute visible world bounds early (for frustum culling + infinite tiled surface quad)
    const c0 = engine._screenToWorld(0, 0);
    const c1 = engine._screenToWorld(viewW, 0);
    const c2 = engine._screenToWorld(0, viewH);
    const c3 = engine._screenToWorld(viewW, viewH);
    const pad = 256 / zoom;
    const viewMinX = Math.min(c0.wx, c1.wx, c2.wx, c3.wx) - pad;
    const viewMaxX = Math.max(c0.wx, c1.wx, c2.wx, c3.wx) + pad;
    const viewMinY = Math.min(c0.wy, c1.wy, c2.wy, c3.wy) - pad;
    const viewMaxY = Math.max(c0.wy, c1.wy, c2.wy, c3.wy) + pad;

    // Resolve cached tiled surface GPU texture (0 allocations during painting)
    const surfMgr = engine.surfaceManager;
    const surfUniforms = surfMgr ? surfMgr.getShaderUniforms() : { active: false };
    const surfTexPair = surfUniforms.active ? surfMgr.ensureGpuTextures(gl) : { colorTex: null, mapTex: null };
    const hasSurfaceBg = !!(surfUniforms.active && surfTexPair.colorTex && surfUniforms.bgOpacity > 0.005);

    gl.uniform1i(this.quadLocs.u_useSurfaceBg, 0);
    gl.uniform1f(this.quadLocs.u_surfaceInvScale, surfUniforms.invScale || (1.0 / 320.0));
    gl.uniform1f(this.quadLocs.u_surfaceBgOpacity, surfUniforms.bgOpacity || 0.0);
    gl.uniform1f(this.quadLocs.u_surfaceBiomeMix, surfUniforms.biomeMix ?? 0.88);
    gl.uniform1f(this.quadLocs.u_surfaceAllowRotate, surfUniforms.allowRotate ?? 1.0);
    gl.uniform1f(this.quadLocs.u_surfaceScaleSpread, surfUniforms.scaleSpread ?? 1.0);

    // 2. Static Mode: Drop Shadow, Brutalist Border, and Paper/Material Surface
    //    Infinite Mode: Full-viewport tiled material quad (if active & visible)
    if (engine.isStatic) {
      const halfW = engine.staticWidth * 0.5;
      const halfH = engine.staticHeight * 0.5;
      const minBoardDim = Math.max(64.0, Math.min(engine.staticWidth, engine.staticHeight));
      const maxWorldBorder = Math.max(4.0, minBoardDim * 0.004);
      const maxWorldShadow = Math.max(12.0, minBoardDim * 0.012);
      const borderW = Math.max(1.0 / zoom, Math.min(maxWorldBorder, 3.0 / zoom));
      const shadowOffset = Math.min(maxWorldShadow, 14.0 / zoom);

      gl.uniform1i(this.quadLocs.u_mode, 0);
      gl.uniform1i(this.quadLocs.u_useSolidColor, 1);
      gl.uniform1f(this.quadLocs.u_opacity, 1.0);
      gl.uniform1i(this.quadLocs.u_clipToBoard, 0);

      // Shadow
      gl.uniform4f(this.quadLocs.u_solidColor, 0, 0, 0, 1);
      gl.uniform4f(
        this.quadLocs.u_rect,
        -halfW - borderW + shadowOffset,
        -halfH - borderW + shadowOffset,
        engine.staticWidth + borderW * 2.0,
        engine.staticHeight + borderW * 2.0
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Black Outline
      gl.uniform4f(
        this.quadLocs.u_rect,
        -halfW - borderW,
        -halfH - borderW,
        engine.staticWidth + borderW * 2.0,
        engine.staticHeight + borderW * 2.0
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Paper / Material Surface
      gl.uniform4f(this.quadLocs.u_solidColor, bgRgb[0], bgRgb[1], bgRgb[2], 1.0);
      if (hasSurfaceBg) {
        gl.uniform1i(this.quadLocs.u_useSurfaceBg, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, surfTexPair.colorTex);
      }
      gl.uniform4f(this.quadLocs.u_rect, -halfW, -halfH, engine.staticWidth, engine.staticHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform1i(this.quadLocs.u_useSurfaceBg, 0);
    } else if (hasSurfaceBg) {
      gl.uniform1i(this.quadLocs.u_mode, 0);
      gl.uniform1i(this.quadLocs.u_useSolidColor, 1);
      gl.uniform1i(this.quadLocs.u_useSurfaceBg, 1);
      gl.uniform1f(this.quadLocs.u_opacity, 1.0);
      gl.uniform1i(this.quadLocs.u_clipToBoard, 0);
      gl.uniform4f(this.quadLocs.u_solidColor, bgRgb[0], bgRgb[1], bgRgb[2], 1.0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, surfTexPair.colorTex);
      gl.uniform4f(this.quadLocs.u_rect, viewMinX, viewMinY, viewMaxX - viewMinX, viewMaxY - viewMinY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform1i(this.quadLocs.u_useSurfaceBg, 0);
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

      const activeOverlay = (layer === engine.activeLayer)
        ? (this.sumiOverlay && this.sumiOverlay.active && this.sumiOverlay.tex ? this.sumiOverlay
          : (this.airOverlay && this.airOverlay.active && this.airOverlay.tex ? this.airOverlay
            : (this.fluidOverlay && this.fluidOverlay.active && this.fluidOverlay.tex ? this.fluidOverlay
              : (this.smudgeOverlay && this.smudgeOverlay.active && this.smudgeOverlay.tex ? this.smudgeOverlay : null))))
        : null;
      const exX = activeOverlay ? (activeOverlay.exX ?? activeOverlay.x) : 0;
      const exY = activeOverlay ? (activeOverlay.exY ?? activeOverlay.y) : 0;
      const exW = activeOverlay ? (activeOverlay.exW ?? activeOverlay.w) : 0;
      const exH = activeOverlay ? (activeOverlay.exH ?? activeOverlay.h) : 0;

      if (activeOverlay) {
        gl.uniform1i(this.quadLocs.u_excludeActive, 1);
        gl.uniform4f(this.quadLocs.u_excludeRect, exX, exY, exX + exW, exY + exH);
      } else {
        gl.uniform1i(this.quadLocs.u_excludeActive, 0);
      }

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

      if (activeOverlay) {
        gl.uniform1i(this.quadLocs.u_excludeActive, 2);
        gl.uniform4f(this.quadLocs.u_excludeRect, exX, exY, exX + exW, exY + exH);
        gl.uniform4f(
          this.quadLocs.u_uvClamp,
          activeOverlay.uMin ?? 0,
          activeOverlay.vMin ?? 0,
          activeOverlay.uMax ?? 1,
          activeOverlay.vMax ?? 1
        );
        gl.uniform4f(
          this.quadLocs.u_uvRect,
          activeOverlay.u0 ?? 0,
          activeOverlay.v0 ?? 0,
          activeOverlay.uw ?? 1,
          activeOverlay.vh ?? 1
        );
        gl.uniform4f(
          this.quadLocs.u_rect,
          activeOverlay.x,
          activeOverlay.y,
          activeOverlay.w,
          activeOverlay.h
        );
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, activeOverlay.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.uniform1i(this.quadLocs.u_excludeActive, 0);
        gl.uniform4f(this.quadLocs.u_uvRect, 0, 0, 1, 1);
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

    // 6. Dual-ring dotted Liquify brush cursor overlay (zero DOM layout/box-shadow overhead)
    const lc = engine._liquifyCursor;
    if (
      this.liquifyCursorProgram &&
      lc &&
      lc.visible &&
      engine.brush.type === TOOLS.LIQUIFY &&
      !engine.isExportMode &&
      !engine.floatingSelection
    ) {
      const outerR = Math.max(2.0, lc.radiusCss || 4.0);
      const padCss = 6.0;
      const boxHalf = outerR + padCss;
      gl.useProgram(this.liquifyCursorProgram);
      gl.uniform2f(this.liquifyCursorLocs.u_viewport, viewW, viewH);
      gl.uniform4f(
        this.liquifyCursorLocs.u_cursorRect,
        lc.mx - boxHalf,
        lc.my - boxHalf,
        boxHalf * 2.0,
        boxHalf * 2.0
      );
      gl.uniform2f(this.liquifyCursorLocs.u_cursorCenter, lc.mx, lc.my);
      gl.uniform1f(this.liquifyCursorLocs.u_cursorRadius, outerR);
      gl.uniform1f(this.liquifyCursorLocs.u_falloff, lc.falloff !== undefined ? lc.falloff : 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.bindVertexArray(null);
  }
}
