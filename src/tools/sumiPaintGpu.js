/**
 * WebGL2 Multi-Layer Sparse-Tile Sumi-e Ink & Paper Physics Solver
 *
 * Architecture:
 *  - Sparse 256x256 pooled tiles (`activeTiles`, LRU-evicted cap = 36) over a 768x768 work domain
 *  - Eliminates any canvas boundary seams by compositing directly into `chunk.gpuTextures[layer]`
 *    via `chunkBlitFbo` during interactive strokes and bleeding frames
 *  - Layers per tile:
 *      `baseBg`    (RGBA8)   - parent layer paint / underpaint substrate (wet-advected when wetted)
 *      `surf`      (RGBA16F) - surface water film, glue viscosity, footprint age
 *      `surfPig`   (RGBA16F) - mobile ink absorbance (RGB) + mass (A)
 *      `pore`      (RGBA16F) - capillary paper pore water
 *      `porePig`   (RGBA16F) - capillary pore ink absorbance (RGB) + mass (A)
 *      `dryPig`    (RGBA16F) - fixed fiber carbon soot (rewettable by WATER mode)
 *      `vel`       (RGBA16F) - shallow-water Navier-Stokes velocity
 *      `strokeCov` (RGBA16F) - per-stroke coverage deduplication (eliminates frame-join blobs)
 *  - Strictly <= 4 MRT attachments per pass for universal WebGL2 compatibility
 */

import { GLSL_RYB_MIX } from '../colorUtils.js';
import { backupChunkLayer } from '../engine/backupPool.js';

const TILE_SIZE = 256;
const WORK_RES = 768;
const MAX_POOL_TILES = 36;
const MAX_INSTANCES = 4096;

const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const RECT_MAP_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec4 u_srcRect;
uniform vec4 u_dstRect;
uniform vec4 u_uvSubRect;
out vec2 v_uv;
void main() {
  vec2 unit = a_pos;
  vec2 world = u_srcRect.xy + unit * u_srcRect.zw;
  vec2 dstNorm = (world - u_dstRect.xy) / max(u_dstRect.zw, vec2(1.0));
  vec2 clip = dstNorm * 2.0 - 1.0;
  v_uv = u_uvSubRect.xy + unit * u_uvSubRect.zw;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const RECT_MAP_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

const UNPREMULT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float a = clamp(c.a, 0.0, 1.0);
  if (a <= 0.002) {
    outColor = vec4(0.0);
  } else {
    outColor = vec4(clamp(c.rgb / a, 0.0, 1.0), a);
  }
}`;

const BRISTLE_STAMP_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec4 a_seg;
layout(location = 2) in vec4 a_props;

uniform vec2 u_invWorkRes;

out vec2 v_local;
out float v_halfLen;
out float v_radius;
out float v_inkW;
out float v_waterW;
out float v_contactW;

void main() {
  vec2 p0 = a_seg.xy;
  vec2 p1 = a_seg.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 0.001 ? (d / len) : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float r = max(0.8, a_props.x);
  float halfLen = len * 0.5;
  float reach = r + 1.5;

  vec2 center = (p0 + p1) * 0.5;
  vec2 localPos = vec2(a_quad.x * (halfLen + reach), a_quad.y * reach);
  vec2 simPos = center + dir * localPos.x + perp * localPos.y;

  vec2 clip = (simPos * u_invWorkRes) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);

  v_local = localPos;
  v_halfLen = halfLen;
  v_radius = r;
  v_inkW = a_props.y;
  v_waterW = a_props.z;
  v_contactW = a_props.w;
}`;

const BRISTLE_STAMP_FRAG = `#version 300 es
precision highp float;

in vec2 v_local;
in float v_halfLen;
in float v_radius;
in float v_inkW;
in float v_waterW;
in float v_contactW;

out vec4 outStamp;

void main() {
  float clampedX = clamp(v_local.x, -v_halfLen, v_halfLen);
  float dist = length(v_local - vec2(clampedX, 0.0));
  float d = dist / max(0.001, v_radius);
  if (d >= 1.0) discard;

  float falloff = pow(clamp(1.0 - d * d, 0.0, 1.0), 1.65);
  float inkDep = falloff * v_inkW;
  float watDep = falloff * v_waterW;
  float contact = falloff * v_contactW;
  outStamp = vec4(inkDep, watDep, contact, falloff);
}`;

const SUMI_SURFACE_GLSL = `
float sumiHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + 17.31);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float sumiNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(sumiHash(i), sumiHash(i + vec2(1.0, 0.0)), f.x),
    mix(sumiHash(i + vec2(0.0, 1.0)), sumiHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
float sumiFiberLayer(vec2 p, float angle, vec2 stretch) {
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);
  vec2 rp = (rot * p) * stretch;
  float n = sumiNoise(rp);
  float ridge = 1.0 - abs(n * 2.0 - 1.0);
  return pow(ridge, 2.2);
}
vec4 sampleSumiSubstrate(vec2 worldPos) {
  vec2 p = worldPos * (0.048 * (0.65 + u_coarseness * 0.85));
  float warp = sumiNoise(p * 0.25) * 2.4;
  float f1 = sumiFiberLayer(p + vec2(warp, -warp * 0.6), 0.32, vec2(0.42, 4.8));
  float f2 = sumiFiberLayer(p + vec2(-warp * 0.7, warp), 1.48, vec2(0.45, 4.5));
  float f3 = sumiFiberLayer(p * 1.7 + warp * 0.5, 2.28, vec2(0.55, 3.9));
  float f4 = sumiFiberLayer(p * 2.9 - warp * 0.3, 0.88, vec2(0.70, 3.6));
  float longFibers = f1 * 0.34 + f2 * 0.34 + f3 * 0.20 + f4 * 0.12;
  float pulpNoise = sumiNoise(p * 3.8) * 0.55 + sumiNoise(p * 8.5) * 0.30 + sumiNoise(p * 17.0) * 0.15;
  float localGluePatch = smoothstep(0.25, 0.85, sumiNoise(p * 0.18 + 7.1));

  if (u_hasSurface == 1) {
    vec4 s = texture(u_surfaceMap, worldPos * u_surfaceInvScale);
    float surfH = s.r;
    float cavity = s.a;
    float h = clamp(mix(surfH, surfH * 0.72 + longFibers * 0.28, 0.35), 0.0, 1.0);
    float openPore = clamp((1.0 - h * 0.65) * 0.58 + cavity * 0.42, 0.05, 1.0);
    float sizingMask = mix(1.0, 0.14, u_sizing);
    float perm = clamp(openPore * sizingMask * mix(0.76, 1.16, localGluePatch), 0.03, 1.0);
    float sootBlock = clamp(h * 0.72 + longFibers * 0.18 + (1.0 - openPore) * 0.18, 0.06, 0.98);
    float tooth = clamp(0.45 + (h - 0.5) * (0.48 + u_coarseness * 0.85) - cavity * 0.18, 0.0, 1.0);
    return vec4(h, perm, sootBlock, tooth);
  }

  float screenLine = mix(1.0, 0.5 + 0.5 * sin(worldPos.y * 0.42), 0.12);
  float height = clamp((longFibers * 0.58 + pulpNoise * 0.42) * screenLine, 0.0, 1.0);
  float openPore = clamp((1.0 - longFibers * 0.72) * 0.65 + (1.0 - pulpNoise) * 0.35, 0.05, 1.0);
  float sizingMask = mix(1.0, 0.12, u_sizing);
  float perm = clamp(openPore * sizingMask * mix(0.75, 1.15, localGluePatch), 0.03, 1.0);
  float sootBlock = clamp(longFibers * 0.75 + (1.0 - openPore) * 0.25, 0.05, 0.98);
  float tooth = clamp(0.45 + (height - 0.5) * 0.55, 0.0, 1.0);
  return vec4(height, perm, sootBlock, tooth);
}
`;

// Re-wet previously fixed dryPig back into mobile surfPig on WATER strokes
const REWET_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_stamp;
uniform sampler2D u_surfPig;
uniform sampler2D u_dryPig;
uniform float u_waterCharge;
uniform float u_sizing;

in vec2 v_uv;

layout(location = 0) out vec4 outSurfPig;
layout(location = 1) out vec4 outDryPig;

void main() {
  vec4 stamp = texture(u_stamp, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 dryPig = texture(u_dryPig, v_uv);

  float footSignal = min(1.0, max(stamp.b, stamp.g));
  if (footSignal > 0.002 && dryPig.a > 0.0004) {
    float liftFrac = clamp(footSignal * (0.18 + 0.36 * u_waterCharge) * (1.0 - u_sizing * 0.35), 0.0, 0.45);
    float lifted = dryPig.a * liftFrac;
    dryPig.a = max(0.0, dryPig.a - lifted);
    float tot = surfPig.a + lifted;
    surfPig.rgb = tot > 1e-5 ? mix(surfPig.rgb, dryPig.rgb, lifted / tot) : dryPig.rgb;
    surfPig.a = tot;
  }

  outSurfPig = surfPig;
  outDryPig = dryPig;
}`;

// Brush Deposit / Wash / Blow / Blot Apply Pass (4 MRT: surf, surfPig, vel, strokeCov)
const BRUSH_APPLY_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_stamp;
uniform sampler2D u_surf;
uniform sampler2D u_surfPig;
uniform sampler2D u_vel;
uniform sampler2D u_strokeCov;
uniform sampler2D u_surfaceMap;

uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_sizing;
uniform float u_coarseness;
uniform float u_surfSlip;
uniform float u_surfChannel;

uniform int u_mode;         // 0=draw, 1=water, 2=blow, 3=dry/blot
uniform vec2 u_workOrigin;
uniform vec2 u_brushVel;
uniform float u_pressure;
uniform float u_inkConcentration;
uniform float u_waterCharge;
uniform float u_glueVisc;
uniform vec3 u_pigmentK;
uniform int u_physicalMix;
uniform float u_strokeId;

in vec2 v_uv;

layout(location = 0) out vec4 outSurf;
layout(location = 1) out vec4 outSurfPig;
layout(location = 2) out vec4 outVel;
layout(location = 3) out vec4 outStrokeCov;

${SUMI_SURFACE_GLSL}
${GLSL_RYB_MIX}

void main() {
  vec4 surf = texture(u_surf, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 vel = texture(u_vel, v_uv);
  vec4 cov = texture(u_strokeCov, v_uv);
  vec4 stamp = texture(u_stamp, v_uv);

  float totalInkAdd = stamp.r;
  float totalWatAdd = stamp.g;
  float totalContact = stamp.b;
  float maxFalloff = stamp.a;

  if (totalContact <= 0.0005 && totalInkAdd <= 0.0005 && totalWatAdd <= 0.0005 && maxFalloff <= 0.0005) {
    outSurf = surf;
    outSurfPig = surfPig;
    outVel = vel;
    outStrokeCov = cov;
    return;
  }

  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;
  vec4 sub = sampleSumiSubstrate(worldPos);
  float fiberH = sub.r;

  // Fiber tooth modulation (kasure): dry brush catches high fiber ridges, skips valleys
  float avgWatPerContact = totalWatAdd / max(0.002, totalContact);
  float dryFactor = clamp(1.0 - avgWatPerContact * 1.4, 0.0, 1.0);
  float toothGate = smoothstep(dryFactor * 0.60, dryFactor * 0.60 + 0.25, fiberH);
  float kTooth = mix(1.0, toothGate, dryFactor * 0.88);
  float contactClamped = clamp(totalContact, 0.0, 1.0);

  if (u_mode == 0) {
    // DRAW: true multi-tuft accumulation into wet surface puddle & velvety carbon core
    float waterGain = totalWatAdd * 0.42 * (0.28 + 0.72 * kTooth);
    float dilution = mix(1.18, 0.58, u_waterCharge);
    float inkGain = totalInkAdd * 0.52 * kTooth * dilution * (0.35 + 0.85 * u_inkConcentration);

    surf.r = clamp(surf.r + waterGain * (1.0 - surf.r * 0.28), 0.0, 3.0);
    surf.g = clamp(surf.g + inkGain * (0.15 + u_glueVisc * 0.65) * 0.55, 0.0, 2.0);
    surf.a = 0.0;

    if (inkGain > 0.0004) {
      float oldM = max(0.0, surfPig.a);
      float totM = min(12.0, oldM + inkGain);
      if (oldM <= 0.0008) {
        surfPig.rgb = u_pigmentK;
      } else {
        float tMix = clamp(inkGain / max(1e-4, oldM + inkGain), 0.0, 1.0);
        if (u_physicalMix == 1) {
          vec3 refA = clamp(1.0 - surfPig.rgb, 0.0, 1.0);
          vec3 refB = clamp(1.0 - u_pigmentK, 0.0, 1.0);
          vec3 refMix = mixPaintCol(refA, refB, tMix, 1);
          surfPig.rgb = clamp(1.0 - refMix, 0.02, 1.0);
        } else {
          surfPig.rgb = mix(surfPig.rgb, u_pigmentK, tMix);
        }
      }
      surfPig.a = totM;
    }

    float velScale = mix(0.65, 1.35, u_surfSlip);
    vel.xy += u_brushVel * min(1.2, totalContact) * (1.2 + 1.8 * u_waterCharge) * velScale;
  } else if (u_mode == 1) {
    // WATER: clean water wash & outward nijimi bleed
    float waterGain = max(totalWatAdd, totalContact * 0.85) * (0.25 + 0.65 * u_waterCharge) * 0.62;
    surf.r = clamp(surf.r + waterGain * (1.0 - surf.r * 0.22), 0.0, 3.0);
    surf.g = max(0.0, surf.g * (1.0 - contactClamped * 0.20));
    surf.a = 0.0;
    vel.xy += u_brushVel * min(1.2, totalContact) * 2.4 * mix(0.75, 1.35, u_surfSlip);
  } else if (u_mode == 2) {
    // BLOW: directional air impulse pushes wet ink & shallow-water underpaint
    float pushStrength = min(1.4, max(totalContact, totalWatAdd));
    vel.xy += u_brushVel * pushStrength * (4.2 + 2.2 * u_surfSlip);
    surf.r = clamp(surf.r + pushStrength * 0.015, 0.0, 3.0);
  } else if (u_mode == 3) {
    // DRY / BLOT: absorbs wet surface water & suspended soot
    float absorb = clamp(contactClamped * 0.55, 0.0, 0.85);
    surf.r *= (1.0 - absorb);
    surf.g *= (1.0 - absorb * 0.7);
    surfPig.a *= (1.0 - absorb * 0.65);
    vel.xy *= (1.0 - absorb * 0.85);
  }

  outSurf = surf;
  outSurfPig = surfPig;
  outVel = vel;
  outStrokeCov = vec4(
    max(cov.r, totalInkAdd),
    max(cov.g, totalWatAdd),
    max(cov.b, contactClamped),
    u_strokeId
  );
}`;

const VEL_ADVECT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_vel;
uniform sampler2D u_surf;
uniform sampler2D u_surfaceMap;
uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_sizing;
uniform float u_coarseness;
uniform float u_surfSlip;
uniform float u_surfChannel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform vec2 u_workOrigin;
uniform float u_dt;
uniform float u_glueVisc;
in vec2 v_uv;
out vec4 outVel;
${SUMI_SURFACE_GLSL}
void main() {
  vec2 vel = texture(u_vel, v_uv).xy;
  vec4 surf = texture(u_surf, v_uv);
  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;

  // Semi-Lagrangian backtrace (vel is in work-pixels/sec)
  vec2 backUv = clamp(v_uv - vel * u_texel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec2 advV = texture(u_vel, backUv).xy;

  // Shallow-water puddle height gradient pushes fluid outward from thick puddles
  float hL = texture(u_surf, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hR = texture(u_surf, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hD = texture(u_surf, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hU = texture(u_surf, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  vec2 gradH = vec2(hR - hL, hU - hD) * 0.5;

  // Paper fiber slope steers liquid gently along channels/valleys
  vec2 gradP = vec2(0.0);
  if (u_hasSurface == 1) {
    vec4 s = texture(u_surfaceMap, worldPos * u_surfaceInvScale);
    gradP = (s.gb - 0.5) * 2.0 * (0.4 + 1.2 * u_surfChannel);
  } else {
    float pL = sampleSumiSubstrate(worldPos - vec2(1.0, 0.0)).r;
    float pR = sampleSumiSubstrate(worldPos + vec2(1.0, 0.0)).r;
    float pD = sampleSumiSubstrate(worldPos - vec2(0.0, 1.0)).r;
    float pU = sampleSumiSubstrate(worldPos + vec2(0.0, 1.0)).r;
    gradP = vec2(pR - pL, pU - pD) * 0.5;
  }

  float wetness = smoothstep(0.01, 0.15, surf.r);
  advV -= gradH * 65.0 * wetness * mix(0.75, 1.25, u_surfSlip);
  advV -= gradP * 14.0 * wetness;

  // Viscosity & friction: animal glue (surf.g + u_glueVisc) & shallow depth damp velocity
  float viscosityDrag = 1.0 + (surf.g + u_glueVisc * 0.5) * 3.2 + (1.0 - wetness) * 14.0 + (1.0 - u_surfSlip) * 1.2;
  advV *= exp(-viscosityDrag * u_dt * 1.4);

  float spd = length(advV);
  if (spd > 260.0) advV = (advV / spd) * 260.0;

  outVel = vec4(advV, 0.0, 1.0);
}`;

const DIVERGENCE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
in vec2 v_uv;
out vec4 outDiv;
void main() {
  float vL = texture(u_vel, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float vR = texture(u_vel, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float vB = texture(u_vel, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).y;
  float vT = texture(u_vel, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).y;
  outDiv = vec4(0.5 * ((vR - vL) + (vT - vB)), 0.0, 0.0, 1.0);
}`;

const PRESSURE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_press;
uniform sampler2D u_div;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
in vec2 v_uv;
out vec4 outPress;
void main() {
  float pL = texture(u_press, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pR = texture(u_press, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pB = texture(u_press, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pT = texture(u_press, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).x;
  float div = texture(u_div, v_uv).x;
  outPress = vec4((pL + pR + pB + pT - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUB_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_press;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
in vec2 v_uv;
out vec4 outVel;
void main() {
  float pL = texture(u_press, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pR = texture(u_press, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pB = texture(u_press, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).x;
  float pT = texture(u_press, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).x;
  vec2 v = texture(u_vel, v_uv).xy - 0.5 * vec2(pR - pL, pT - pB);
  outVel = vec4(v, 0.0, 1.0);
}`;

const SURF_STEP_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_surfPig;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_backrunRim;
uniform float u_evapRate;
uniform float u_forceDry;

in vec2 v_uv;

layout(location = 0) out vec4 outSurf;
layout(location = 1) out vec4 outSurfPig;

void mixInk(inout vec4 dst, vec4 src, float weight) {
  float addM = src.a * weight;
  if (addM <= 1e-6) return;
  float tot = dst.a + addM;
  dst.rgb = mix(dst.rgb, src.rgb, addM / max(1e-5, tot));
  dst.a = tot;
}

void main() {
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 backUv = clamp(v_uv - vel * u_texel * u_dt, u_uvClamp.xy, u_uvClamp.zw);

  vec4 surf = texture(u_surf, backUv);
  vec4 pig = texture(u_surfPig, backUv);

  vec4 sL = texture(u_surf, clamp(backUv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 sR = texture(u_surf, clamp(backUv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 sB = texture(u_surf, clamp(backUv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
  vec4 sT = texture(u_surf, clamp(backUv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));

  vec4 pL = texture(u_surfPig, clamp(backUv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 pR = texture(u_surfPig, clamp(backUv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 pB = texture(u_surfPig, clamp(backUv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
  vec4 pT = texture(u_surfPig, clamp(backUv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));

  float avgWater = 0.25 * (sL.r + sR.r + sB.r + sT.r);
  float waterLap = avgWater - surf.r;

  // Surface fluid spreads smoothly where wet
  float wetMask = smoothstep(0.005, 0.08, max(surf.r, avgWater));
  surf.r = max(0.0, surf.r + waterLap * 0.26 * wetMask);

  // Backrun / Coffee-ring edge pooling: outward capillary flow pulls suspended soot toward drying rim
  float rimFluxL = max(0.0, sL.r - surf.r);
  float rimFluxR = max(0.0, sR.r - surf.r);
  float rimFluxB = max(0.0, sB.r - surf.r);
  float rimFluxT = max(0.0, sT.r - surf.r);

  float outFlux = max(0.0, surf.r - sL.r) + max(0.0, surf.r - sR.r)
                + max(0.0, surf.r - sB.r) + max(0.0, surf.r - sT.r);

  float rimGain = u_backrunRim * 0.22 * wetMask;
  mixInk(pig, pL, rimFluxL * rimGain);
  mixInk(pig, pR, rimFluxR * rimGain);
  mixInk(pig, pB, rimFluxB * rimGain);
  mixInk(pig, pT, rimFluxT * rimGain);
  pig.a = max(0.0, pig.a - pig.a * outFlux * rimGain);

  // Subtle wet pigment diffusion proportional to shallow water depth
  vec4 avgNeigh = vec4(0.0);
  mixInk(avgNeigh, pL, 0.25);
  mixInk(avgNeigh, pR, 0.25);
  mixInk(avgNeigh, pB, 0.25);
  mixInk(avgNeigh, pT, 0.25);
  float pigDiff = clamp(surf.r * 0.08, 0.0, 0.12);
  float nextM = mix(pig.a, avgNeigh.a, pigDiff);
  float cMix = nextM > 1e-5 ? clamp((avgNeigh.a * pigDiff) / nextM, 0.0, 1.0) : 0.0;
  pig.rgb = mix(pig.rgb, avgNeigh.rgb, cMix);
  pig.a = nextM;

  // Natural slow surface evaporation (matches ref/sumi-test: u_evapRate * 0.22 * u_dt)
  float evap = u_evapRate * 0.22 * u_dt + u_forceDry * 5.0;
  surf.r = max(0.0, surf.r - evap);
  surf.a += u_dt;

  if (surf.r < 0.0002 && pig.a < 0.0005) {
    surf = vec4(0.0);
    pig = vec4(0.0);
  }

  outSurf = surf;
  outSurfPig = pig;
}`;

// Wet-mobilized advection & watercolor feathering of underlying parent layer paint (`ppBaseBg`)
const BASE_STEP_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_baseBg;
uniform sampler2D u_surf;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_glueVisc;
uniform int u_alphaLock;

in vec2 v_uv;
out vec4 outBaseBg;

void main() {
  vec4 base = texture(u_baseBg, v_uv);
  float w = texture(u_surf, v_uv).r;
  if (w <= 0.018) {
    outBaseBg = base;
    return;
  }

  float wetMob = smoothstep(0.018, 0.26, w);
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 backUv = clamp(v_uv - vel * u_texel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec4 advBase = texture(u_baseBg, backUv);
  float advSurf = texture(u_surf, backUv).r;
  float advMob = smoothstep(0.012, 0.20, advSurf);
  float advW = clamp(length(vel) * 0.012 * wetMob * advMob, 0.0, 0.65);
  vec4 mixed = mix(base, advBase, advW);

  vec4 bL = texture(u_baseBg, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 bR = texture(u_baseBg, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
  vec4 bB = texture(u_baseBg, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
  vec4 bT = texture(u_baseBg, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
  vec4 avgN = (bL + bR + bB + bT) * 0.25;

  float diffAmt = clamp(0.08 * wetMob * (0.35 + 0.65 * (1.0 - u_glueVisc * 0.5)), 0.0, 0.18);
  vec4 res = mix(mixed, avgN, diffAmt);

  if (u_alphaLock == 1) {
    if (base.a <= 0.002) {
      res = vec4(0.0);
    } else {
      vec3 straight = res.a > 0.002 ? clamp(res.rgb / res.a, 0.0, 1.0) : (base.rgb / base.a);
      res = vec4(clamp(straight * base.a, 0.0, base.a), base.a);
    }
  }
  outBaseBg = res;
}`;

// Vertical Seepage: Surface Pool -> Capillary Pores (4 MRT)
const SURF_SEEP_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_surfPig;
uniform sampler2D u_pore;
uniform sampler2D u_porePig;
uniform sampler2D u_surfaceMap;

uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_sizing;
uniform float u_coarseness;
uniform float u_seepRate;
uniform float u_sootSnag;
uniform vec2 u_workOrigin;
uniform float u_dt;
uniform float u_forceDry;

in vec2 v_uv;

layout(location = 0) out vec4 outSurf;
layout(location = 1) out vec4 outSurfPig;
layout(location = 2) out vec4 outPore;
layout(location = 3) out vec4 outPorePig;

${SUMI_SURFACE_GLSL}

void addWeightedPig(inout vec4 dst, vec3 col, float mass) {
  if (mass <= 1e-6) return;
  float tot = dst.a + mass;
  dst.rgb = mix(dst.rgb, col, mass / max(1e-5, tot));
  dst.a = tot;
}

void main() {
  vec4 surf = texture(u_surf, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 pore = texture(u_pore, v_uv);
  vec4 porePig = texture(u_porePig, v_uv);

  if (u_forceDry > 0.5) {
    // Pass remaining surface water & pigment straight to pores so PERCOLATION fixes all into dryPig
    pore.r = min(2.5, pore.r + surf.r);
    addWeightedPig(porePig, surfPig.rgb, surfPig.a);
    outSurf = vec4(0.0);
    outSurfPig = vec4(0.0);
    outPore = pore;
    outPorePig = porePig;
    return;
  }

  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;
  vec4 sub = sampleSumiSubstrate(worldPos);
  float perm = sub.y;
  float sootBlock = sub.z;

  float poreCap = max(0.0, 1.35 - pore.r);
  float seepWater = min(surf.r, surf.r * perm * u_seepRate * u_dt * (0.35 + poreCap) * 2.2);

  if (surf.r > 0.0001) {
    float seepRatio = clamp(seepWater / surf.r, 0.0, 1.0);
    surf.r -= seepWater;
    float snagResist = clamp(u_sootSnag * sootBlock * 0.42, 0.0, 0.72);
    float fineShare = seepRatio * 0.92 * (1.0 - snagResist);
    float moveToPore = min(surfPig.a, surfPig.a * fineShare);
    pore.r = clamp(pore.r + seepWater, 0.0, 2.5);
    pore.g = clamp(pore.g + surf.g * seepRatio * 0.92, 0.0, 2.0);
    surf.g *= (1.0 - seepRatio * 0.92);
    addWeightedPig(porePig, surfPig.rgb, moveToPore);
    surfPig.a = max(0.0, surfPig.a - moveToPore);
  }

  outSurf = surf;
  outSurfPig = surfPig;
  outPore = pore;
  outPorePig = porePig;
}`;

// Layer 3 & 4: 8-Neighbor Anisotropic Darcy Capillary Percolation + Water/Soot Separation + Fixation (4 MRT)
const PERCOLATION_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_surfPig;
uniform sampler2D u_pore;
uniform sampler2D u_porePig;
uniform sampler2D u_dryPig;
uniform sampler2D u_surfaceMap;

uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_sizing;
uniform float u_coarseness;
uniform float u_capillarity;
uniform float u_evapRate;
uniform float u_sootSnag;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform vec2 u_workOrigin;
uniform float u_dt;
uniform float u_forceDry;

in vec2 v_uv;

layout(location = 0) out vec4 outSurfPig;
layout(location = 1) out vec4 outPore;
layout(location = 2) out vec4 outPorePig;
layout(location = 3) out vec4 outDryPig;

${SUMI_SURFACE_GLSL}

void addPig(inout vec4 dst, vec3 col, float mass) {
  if (mass <= 1e-6) return;
  float tot = dst.a + mass;
  dst.rgb = mix(dst.rgb, col, mass / max(1e-5, tot));
  dst.a = tot;
}

void main() {
  vec4 surf = texture(u_surf, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 pore = texture(u_pore, v_uv);
  vec4 porePig = texture(u_porePig, v_uv);
  vec4 dryPig = texture(u_dryPig, v_uv);

  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;
  vec4 mySub = sampleSumiSubstrate(worldPos);
  float myH = mySub.r;
  float myPerm = mySub.y;
  float myBlock = mySub.z;

  if (u_forceDry > 0.5) {
    addPig(dryPig, porePig.rgb, porePig.a);
    addPig(dryPig, surfPig.rgb, surfPig.a);
    outSurfPig = vec4(0.0);
    outPore = vec4(0.0);
    outPorePig = vec4(0.0);
    outDryPig = dryPig;
    return;
  }

  // 8-neighbor anisotropic Darcy capillary wicking stencil (ref/sumi-test)
  const vec2 OFFSETS[8] = vec2[8](
    vec2(-1.0,  0.0), vec2( 1.0,  0.0), vec2( 0.0, -1.0), vec2( 0.0,  1.0),
    vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0), vec2( 1.0,  1.0)
  );
  const float WEIGHTS[8] = float[8](
    0.18, 0.18, 0.18, 0.18,
    0.07, 0.07, 0.07, 0.07
  );

  float waterDelta = 0.0;
  float mySootMobility = clamp((1.0 - myBlock * u_sootSnag) * (1.0 - pore.g * 0.18), 0.04, 0.82);
  float pigOutMass = 0.0;
  vec4 pigInAccum = vec4(0.0);

  for (int i = 0; i < 8; i++) {
    vec2 nUV = clamp(v_uv + OFFSETS[i] * u_texel, u_uvClamp.xy, u_uvClamp.zw);
    vec4 nPore = texture(u_pore, nUV);
    vec4 nPig = texture(u_porePig, nUV);
    vec4 nSub = sampleSumiSubstrate(worldPos + OFFSETS[i]);

    float linkPerm = min(myPerm, nSub.y);
    float fiberBias = 1.0 - abs(myH - nSub.r) * 0.65;
    float cond = WEIGHTS[i] * u_capillarity * linkPerm * fiberBias;

    float nExcess = max(0.0, nPore.r - 0.035);
    float myExcess = max(0.0, pore.r - 0.035);

    if (nPore.r > pore.r) {
      float wIn = (nPore.r - pore.r) * cond * smoothstep(0.02, 0.12, nExcess);
      waterDelta += wIn;
      float nMob = clamp((1.0 - nSub.z * u_sootSnag) * (1.0 - nPore.g * 0.18), 0.04, 0.82);
      float pigRatio = clamp(wIn / max(nPore.r, 0.001), 0.0, 0.6) * nMob;
      addPig(pigInAccum, nPig.rgb, nPig.a * pigRatio);
    } else if (pore.r > nPore.r) {
      float wOut = (pore.r - nPore.r) * cond * smoothstep(0.02, 0.12, myExcess);
      waterDelta -= wOut;
      float pigRatio = clamp(wOut / max(pore.r, 0.001), 0.0, 0.6) * mySootMobility;
      pigOutMass += porePig.a * pigRatio;
    }
  }

  pore.r = clamp(pore.r + waterDelta, 0.0, 2.5);
  porePig.a = max(0.0, porePig.a - pigOutMass);
  addPig(porePig, pigInAccum.rgb, pigInAccum.a);

  // Evaporation inside pores & water-triggered fixation of soot granules onto Xuan fibers (Layer 4)
  float evap = u_evapRate * 0.36 * u_dt;
  float prevWater = pore.r;
  pore.r = max(0.0, pore.r - evap);
  pore.g = max(0.0, pore.g - evap * 0.5);

  if (prevWater > 0.0001) {
    float dryFraction = clamp(evap / max(prevWater, 0.02), 0.0, 1.0);
    float lowWaterLock = smoothstep(0.14, 0.0, pore.r);
    float fixRate = clamp(max(dryFraction * 0.85, lowWaterLock * 0.25), 0.0, 1.0);
    float fixedNow = porePig.a * fixRate;
    addPig(dryPig, porePig.rgb, fixedNow);
    porePig.a = max(0.0, porePig.a - fixedNow);
  } else if (porePig.a > 0.0001) {
    addPig(dryPig, porePig.rgb, porePig.a);
    porePig = vec4(0.0);
  }

  // Stranded surface soot precipitates onto ridges once surface water dries out
  if (surf.r < 0.004 && surfPig.a > 0.0002) {
    float fixSurfFrac = smoothstep(0.004, 0.0, surf.r) * 0.35;
    float fixedSurf = surfPig.a * fixSurfFrac;
    addPig(dryPig, surfPig.rgb, fixedSurf);
    surfPig.a = max(0.0, surfPig.a - fixedSurf);
  }

  outSurfPig = surfPig;
  outPore = pore;
  outPorePig = porePig;
  outDryPig = dryPig;
}`;

// Layer 5: True Kubelka-Munk 5-Layer Optical Composite (Halo-free over empty & painted parent layers)
const SUMI_COMPOSITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_surfPig;
uniform sampler2D u_pore;
uniform sampler2D u_porePig;
uniform sampler2D u_dryPig;
uniform sampler2D u_baseBg;
uniform sampler2D u_surfaceMap;

uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_coarseness;
uniform float u_sizing;
uniform vec2 u_workOrigin;

uniform float u_sootDensity;
uniform float u_inkWarmth;
uniform int u_alphaLock;

in vec2 v_uv;
out vec4 outColor;

${SUMI_SURFACE_GLSL}

float kmChannel(float kIn, float sIn, float rgIn) {
  float k = max(kIn, 0.0);
  if (k < 0.0001) return clamp(rgIn, 0.0, 1.0);
  float s = max(sIn, 0.0004);
  float rg = clamp(rgIn, 0.0, 1.0);
  float a = 1.0 + k / s;
  float b = sqrt(max(a * a - 1.0, 0.00001));
  float bS = min(b * s, 20.0);
  float e = exp(-2.0 * bS);
  float cothBS = (1.0 + e) / max(1.0 - e, 0.00001);
  float bc = b * cothBS;
  float num = 1.0 - rg * (a - bc);
  float den = a - rg + bc;
  return clamp(num / max(den, 0.0001), 0.0, 1.0);
}

vec3 kubelkaMunk(vec3 K, vec3 S, vec3 Rg) {
  return vec3(
    kmChannel(K.r, S.r, Rg.r),
    kmChannel(K.g, S.g, Rg.g),
    kmChannel(K.b, S.b, Rg.b)
  );
}

vec3 layerK(vec4 pig, vec3 warmShift) {
  if (pig.a <= 1e-5) return vec3(0.0);
  vec3 kUnit = clamp(pig.rgb + warmShift * 0.35, 0.02, 1.0);
  return kUnit * pig.a;
}

void main() {
  vec4 base = texture(u_baseBg, v_uv);
  vec4 surf = texture(u_surf, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 pore = texture(u_pore, v_uv);
  vec4 porePig = texture(u_porePig, v_uv);
  vec4 dryPig = texture(u_dryPig, v_uv);

  float totalMass = dryPig.a + porePig.a + surfPig.a;
  if (totalMass <= 0.0008) {
    outColor = base;
    return;
  }

  float warmth = clamp(u_inkWarmth, -1.0, 1.0);
  vec3 warmShift = warmth >= 0.0
    ? vec3(-0.08 * warmth, -0.02 * warmth, 0.11 * warmth)
    : vec3(0.10 * (-warmth), 0.02 * (-warmth), -0.08 * (-warmth));

  float inkDensity = 0.65 + u_sootDensity * 1.45;
  vec3 K_dry = layerK(dryPig, warmShift) * 2.35 * inkDensity;
  vec3 K_wet = (layerK(porePig, warmShift) * 2.15 + layerK(surfPig, warmShift) * 1.85) * inkDensity;
  vec3 K_total = K_dry + K_wet;

  // Modulate effective K slightly by Xuan fiber tooth for natural soot granulation without blank-alpha steps
  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;
  vec4 sub = sampleSumiSubstrate(worldPos);
  float toothKMod = 1.0 + (0.5 - sub.a) * 0.16;
  vec3 K_eff = K_total * toothKMod;

  float maxK = max(max(K_eff.r, K_eff.g), K_eff.b);
  float minK = min(min(K_eff.r, K_eff.g), K_eff.b);
  float chromaSpread = max(0.0, maxK - minK);
  vec3 S_total = max(vec3(0.0004), vec3(maxK * 0.014 + chromaSpread * 0.22));

  // Evaluate Kubelka-Munk over pure white (1.0) & pure black (0.0) for exact halo-free optical alpha
  vec3 R_white = kubelkaMunk(K_eff, S_total, vec3(1.0));
  vec3 R_black = kubelkaMunk(K_eff, S_total, vec3(0.0));
  vec3 T_chan = clamp(R_white - R_black, 0.0, 1.0);
  float inkAlpha = clamp(1.0 - min(T_chan.r, min(T_chan.g, T_chan.b)), 0.0, 1.0);

  if (inkAlpha <= 0.002) {
    outColor = base;
    return;
  }

  // Subtle wet puddle darken & specular glint where liquid sits over paint/ink
  float totalWet = clamp(surf.r * 0.55 + pore.r * 0.75, 0.0, 1.0);
  float sheen = smoothstep(0.08, 0.55, surf.r) * 0.040;

  vec3 baseStraight = base.a > 0.002 ? clamp(base.rgb / base.a, 0.0, 1.0) : vec3(1.0);
  vec3 onBase = kubelkaMunk(K_eff, S_total, clamp(baseStraight * (1.0 - totalWet * 0.035), 0.0, 1.0));
  onBase = clamp(onBase + vec3(sheen * clamp(base.a + inkAlpha, 0.0, 1.0)), 0.0, 1.0);

  vec3 overEmptyPremul = clamp(R_white - vec3(1.0 - inkAlpha) + vec3(sheen * inkAlpha), 0.0, inkAlpha);

  if (u_alphaLock == 1) {
    if (base.a <= 0.002) {
      outColor = vec4(0.0);
    } else {
      outColor = vec4(clamp(onBase * base.a, 0.0, base.a), base.a);
    }
  } else {
    vec3 outRgb = onBase * base.a + overEmptyPremul * (1.0 - base.a);
    float outA = base.a + inkAlpha * (1.0 - base.a);
    outColor = vec4(clamp(outRgb, 0.0, outA), clamp(outA, 0.0, 1.0));
  }
}`;

export class GpuSumiSolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer ? gpuRenderer.gl : null;
    this.ready = false;
    this.active = false;
    this.simActiveFrames = 0;

    this.layer = -1;
    this.projectId = null;
    this.strokeId = 1;
    this._tileTick = 0;
    this._hasCpuDirty = false;
    this.lastParams = {};

    this.activeTiles = new Map();
    this.tilePool = [];
    this.touchedChunks = new Map();

    this.dirtyMinX = Infinity;
    this.dirtyMinY = Infinity;
    this.dirtyMaxX = -Infinity;
    this.dirtyMaxY = -Infinity;

    this.wetMinX = Infinity;
    this.wetMinY = Infinity;
    this.wetMaxX = -Infinity;
    this.wetMaxY = -Infinity;
    this._focusX = 0;
    this._focusY = 0;

    this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._commitCanvas = document.createElement('canvas');
    this._commitCanvas.width = TILE_SIZE;
    this._commitCanvas.height = TILE_SIZE;
    this._commitCtx = this._commitCanvas.getContext('2d', { willReadFrequently: true });

    this._instSegData = new Float32Array(MAX_INSTANCES * 4);
    this._instPropData = new Float32Array(MAX_INSTANCES * 4);

    if (this.gl) {
      this._init();
    }
  }

  _compileProg(vsSrc, fsSrc, label) {
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
      console.error(`[GpuSumiSolver] link error (${label}):`, gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _makeTexFBO(w, h, internalFormat, format, type, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }

  _makeWorkPingPong(internalFormat, format, type, filter) {
    return {
      idx: 0,
      a: this._makeTexFBO(WORK_RES, WORK_RES, internalFormat, format, type, filter),
      b: this._makeTexFBO(WORK_RES, WORK_RES, internalFormat, format, type, filter),
      read() { return this.idx === 0 ? this.a : this.b; },
      write() { return this.idx === 0 ? this.b : this.a; },
      swap() { this.idx = 1 - this.idx; }
    };
  }

  _init() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const hasColorFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float');
    if (!hasColorFloat && !hasHalfFloat) {
      console.warn('[GpuSumiSolver] Float render targets unavailable');
      return;
    }
    const linFloat = !!gl.getExtension('OES_texture_float_linear');
    const halfLin = !!gl.getExtension('OES_texture_half_float_linear');
    const floatFilter = (hasColorFloat ? (linFloat || halfLin) : halfLin) ? gl.LINEAR : gl.NEAREST;
    this._floatFilter = floatFilter;

    this.progRectMap = this._compileProg(RECT_MAP_VS, RECT_MAP_FS, 'rectMap');
    this.progUnpremult = this._compileProg(QUAD_VS, UNPREMULT_FS, 'unpremult');
    this.progBristle = this._compileProg(BRISTLE_STAMP_VERT, BRISTLE_STAMP_FRAG, 'bristleStamp');
    this.progRewet = this._compileProg(QUAD_VS, REWET_FRAG, 'rewet');
    this.progBrushApply = this._compileProg(QUAD_VS, BRUSH_APPLY_FRAG, 'brushApply');
    this.progVelAdvect = this._compileProg(QUAD_VS, VEL_ADVECT_FRAG, 'velAdvect');
    this.progDiv = this._compileProg(QUAD_VS, DIVERGENCE_FRAG, 'div');
    this.progPress = this._compileProg(QUAD_VS, PRESSURE_FRAG, 'press');
    this.progGradSub = this._compileProg(QUAD_VS, GRADIENT_SUB_FRAG, 'gradSub');
    this.progSurfStep = this._compileProg(QUAD_VS, SURF_STEP_FRAG, 'surfStep');
    this.progBaseStep = this._compileProg(QUAD_VS, BASE_STEP_FRAG, 'baseStep');
    this.progSurfSeep = this._compileProg(QUAD_VS, SURF_SEEP_FRAG, 'surfSeep');
    this.progPerc = this._compileProg(QUAD_VS, PERCOLATION_FRAG, 'perc');
    this.progComp = this._compileProg(QUAD_VS, SUMI_COMPOSITE_FRAG, 'comp');

    if (
      !this.progRectMap || !this.progUnpremult || !this.progBristle ||
      !this.progRewet || !this.progBrushApply || !this.progVelAdvect ||
      !this.progDiv || !this.progPress || !this.progGradSub ||
      !this.progSurfStep || !this.progBaseStep || !this.progSurfSeep ||
      !this.progPerc || !this.progComp
    ) {
      return;
    }

    // Work FBOs (768x768)
    this.ppSurf = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppSurfPig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppPore = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppPorePig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppDryPig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppVel = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppPress = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.ppStrokeCov = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.ppBaseBg = this._makeWorkPingPong(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

    this.texDiv = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.texStamp = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.texOutput = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.texTileUnpremult = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);

    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 0]));
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppSurf.a.fbo);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[GpuSumiSolver] Float FBO incomplete');
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.mrtFbo = gl.createFramebuffer();
    this.chunkBlitFbo = gl.createFramebuffer();

    // Instanced bristle VAO
    this.bristleVao = gl.createVertexArray();
    gl.bindVertexArray(this.bristleVao);

    this.quadCornerVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadCornerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instSegVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instSegVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._instSegData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.instPropVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instPropVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._instPropData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);

    const u = (prog, names) => {
      const o = {};
      for (const n of names) o[n] = gl.getUniformLocation(prog, n);
      return o;
    };

    this.locRectMap = u(this.progRectMap, ['u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_tex']);
    this.locUnpremult = u(this.progUnpremult, ['u_tex']);
    this.locBristle = u(this.progBristle, ['u_invWorkRes']);
    this.locRewet = u(this.progRewet, [
      'u_stamp', 'u_surfPig', 'u_dryPig', 'u_waterCharge', 'u_sizing'
    ]);
    this.locApply = u(this.progBrushApply, [
      'u_stamp', 'u_surf', 'u_surfPig', 'u_vel', 'u_strokeCov', 'u_surfaceMap',
      'u_hasSurface', 'u_surfaceInvScale', 'u_sizing', 'u_coarseness', 'u_surfSlip', 'u_surfChannel',
      'u_mode', 'u_workOrigin', 'u_brushVel', 'u_pressure', 'u_inkConcentration', 'u_waterCharge',
      'u_glueVisc', 'u_pigmentK', 'u_physicalMix', 'u_strokeId'
    ]);
    this.locVelAdv = u(this.progVelAdvect, [
      'u_vel', 'u_surf', 'u_surfaceMap', 'u_hasSurface', 'u_surfaceInvScale',
      'u_sizing', 'u_coarseness', 'u_surfSlip', 'u_surfChannel', 'u_texel', 'u_uvClamp', 'u_workOrigin', 'u_dt', 'u_glueVisc'
    ]);
    this.locDiv = u(this.progDiv, ['u_vel', 'u_texel', 'u_uvClamp']);
    this.locPress = u(this.progPress, ['u_press', 'u_div', 'u_texel', 'u_uvClamp']);
    this.locGradSub = u(this.progGradSub, ['u_press', 'u_vel', 'u_texel', 'u_uvClamp']);
    this.locSurfStep = u(this.progSurfStep, ['u_surf', 'u_surfPig', 'u_vel', 'u_texel', 'u_uvClamp', 'u_dt', 'u_backrunRim', 'u_evapRate', 'u_forceDry']);
    this.locBaseStep = u(this.progBaseStep, ['u_baseBg', 'u_surf', 'u_vel', 'u_texel', 'u_uvClamp', 'u_dt', 'u_glueVisc', 'u_alphaLock']);
    this.locSurfSeep = u(this.progSurfSeep, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_surfaceMap',
      'u_hasSurface', 'u_surfaceInvScale', 'u_sizing', 'u_coarseness', 'u_seepRate', 'u_sootSnag',
      'u_workOrigin', 'u_dt', 'u_forceDry'
    ]);
    this.locPerc = u(this.progPerc, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_surfaceMap',
      'u_hasSurface', 'u_surfaceInvScale', 'u_sizing', 'u_coarseness', 'u_capillarity',
      'u_evapRate', 'u_sootSnag', 'u_texel', 'u_uvClamp', 'u_workOrigin', 'u_dt', 'u_forceDry'
    ]);
    this.locComp = u(this.progComp, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_baseBg', 'u_surfaceMap',
      'u_hasSurface', 'u_surfaceInvScale', 'u_coarseness', 'u_sizing', 'u_workOrigin',
      'u_sootDensity', 'u_inkWarmth', 'u_alphaLock'
    ]);

    this.ready = true;
  }

  _allocTileGpu() {
    const gl = this.gl;
    const f = this._floatFilter || gl.LINEAR;
    const baseBg = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const surf = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const surfPig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const pore = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const porePig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const dryPig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const vel = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const strokeCov = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    return {
      baseBg, surf, surfPig, pore, porePig, dryPig, vel, strokeCov,
      tx: 0, ty: 0, wx: 0, wy: 0,
      cpuDirty: false, dirty: false,
      minX: TILE_SIZE, minY: TILE_SIZE, maxX: 0, maxY: 0,
      lastUsed: 0
    };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    for (const o of [t.baseBg, t.surf, t.surfPig, t.pore, t.porePig, t.dryPig, t.vel, t.strokeCov]) {
      if (!o) continue;
      if (o.fbo) gl.deleteFramebuffer(o.fbo);
      if (o.tex) gl.deleteTexture(o.tex);
    }
  }

  _releaseAllTiles() {
    this.activeTiles.forEach((tile) => {
      if (this.tilePool.length < MAX_POOL_TILES) {
        tile.cpuDirty = false;
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
    this._hasCpuDirty = false;
  }

  _evictLruTile(engine, excludeBox = null) {
    let oldest = null;
    let oldestTick = Infinity;
    this.activeTiles.forEach((t) => {
      if (excludeBox &&
          t.wx + TILE_SIZE > excludeBox.x && t.wx < excludeBox.x + excludeBox.w &&
          t.wy + TILE_SIZE > excludeBox.y && t.wy < excludeBox.y + excludeBox.h) {
        return;
      }
      if (t.lastUsed < oldestTick) {
        oldestTick = t.lastUsed;
        oldest = t;
      }
    });
    if (!oldest) {
      // Fallback: pick oldest ignoring excludeBox if all tiles are inside it
      this.activeTiles.forEach((t) => {
        if (t.lastUsed < oldestTick) {
          oldestTick = t.lastUsed;
          oldest = t;
        }
      });
    }
    if (!oldest) return null;

    if (oldest.cpuDirty && engine) {
      this._syncSingleTileToCanvas2D(engine, oldest, this.lastParams || {});
    }
    this.activeTiles.delete(`${oldest.tx},${oldest.ty}`);
    oldest.cpuDirty = false;
    oldest.dirty = false;
    oldest.minX = TILE_SIZE;
    oldest.minY = TILE_SIZE;
    oldest.maxX = 0;
    oldest.maxY = 0;
    return oldest;
  }

  _ensureTile(engine, tx, ty, excludeBox = null) {
    const key = `${tx},${ty}`;
    let tile = this.activeTiles.get(key);
    if (tile) {
      tile.lastUsed = ++this._tileTick;
      return tile;
    }

    if (this.tilePool.length > 0) {
      tile = this.tilePool.pop();
    } else if (this.activeTiles.size >= MAX_POOL_TILES) {
      tile = this._evictLruTile(engine, excludeBox);
    } else {
      tile = this._allocTileGpu();
    }
    if (!tile) return null;

    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;

    tile.tx = tx;
    tile.ty = ty;
    tile.wx = tx * TILE_SIZE;
    tile.wy = ty * TILE_SIZE;
    tile.cpuDirty = false;
    tile.dirty = false;
    tile.minX = TILE_SIZE;
    tile.minY = TILE_SIZE;
    tile.maxX = 0;
    tile.maxY = 0;
    tile.lastUsed = ++this._tileTick;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);

    gl.clearColor(0, 0, 0, 0);
    for (const target of [tile.surf, tile.surfPig, tile.pore, tile.porePig, tile.dryPig, tile.vel, tile.strokeCov]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Seed tile.baseBg from current parent layer chunks
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_dstRect, tile.wx, tile.wy, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);

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
        gl.uniform4f(this.locRectMap.u_srcRect, wx, wy, chunk.width, chunk.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    this.activeTiles.set(key, tile);
    return tile;
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH) {
    const gl = this.gl;
    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);
    const excludeBox = { x: workX, y: workY, w: boxW, h: boxH };

    const tiles = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureTile(engine, tx, ty, excludeBox);
        if (t) tiles.push(t);
      }
    }
    if (tiles.length === 0) return tiles;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_RES, WORK_RES);

    this.ppSurf.idx = 0;
    this.ppSurfPig.idx = 0;
    this.ppPore.idx = 0;
    this.ppPorePig.idx = 0;
    this.ppDryPig.idx = 0;
    this.ppVel.idx = 0;
    this.ppPress.idx = 0;
    this.ppStrokeCov.idx = 0;
    this.ppBaseBg.idx = 0;

    gl.clearColor(0, 0, 0, 0);
    for (const pp of [
      this.ppSurf, this.ppSurfPig, this.ppPore, this.ppPorePig,
      this.ppDryPig, this.ppVel, this.ppPress, this.ppStrokeCov, this.ppBaseBg
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.a.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_dstRect, workX, workY, WORK_RES, WORK_RES);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.locRectMap.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      const pairs = [
        [this.ppBaseBg.a.fbo, t.baseBg.tex],
        [this.ppSurf.a.fbo, t.surf.tex],
        [this.ppSurfPig.a.fbo, t.surfPig.tex],
        [this.ppPore.a.fbo, t.pore.tex],
        [this.ppPorePig.a.fbo, t.porePig.tex],
        [this.ppDryPig.a.fbo, t.dryPig.tex],
        [this.ppVel.a.fbo, t.vel.tex],
        [this.ppStrokeCov.a.fbo, t.strokeCov.tex]
      ];
      for (let p = 0; p < pairs.length; p++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[p][0]);
        gl.bindTexture(gl.TEXTURE_2D, pairs[p][1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    return tiles;
  }

  _storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron) {
    const gl = this.gl;
    const innerX = workX + apron;
    const innerY = workY + apron;
    const innerW = Math.max(1, boxW - apron * 2);
    const innerH = Math.max(1, boxH - apron * 2);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Copy interior box back into sparse tiles
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, workX, workY, WORK_RES, WORK_RES);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const srcBase = this.ppBaseBg.read().tex;
    const srcSurf = this.ppSurf.read().tex;
    const srcSurfPig = this.ppSurfPig.read().tex;
    const srcPore = this.ppPore.read().tex;
    const srcPorePig = this.ppPorePig.read().tex;
    const srcDryPig = this.ppDryPig.read().tex;
    const srcVel = this.ppVel.read().tex;
    const srcCov = this.ppStrokeCov.read().tex;

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const ox = Math.max(innerX, t.wx);
      const oy = Math.max(innerY, t.wy);
      const ox2 = Math.min(innerX + innerW, t.wx + TILE_SIZE);
      const oy2 = Math.min(innerY + innerH, t.wy + TILE_SIZE);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const lx0 = ox - t.wx;
      const ly0 = oy - t.wy;
      t.dirty = true;
      t.cpuDirty = true;
      this._hasCpuDirty = true;
      if (lx0 < t.minX) t.minX = lx0;
      if (ly0 < t.minY) t.minY = ly0;
      if (lx0 + ow > t.maxX) t.maxX = lx0 + ow;
      if (ly0 + oh > t.maxY) t.maxY = ly0 + oh;

      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(lx0, ly0, ow, oh);
      gl.uniform4f(this.locRectMap.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      const pairs = [
        [t.baseBg.fbo, srcBase],
        [t.surf.fbo, srcSurf],
        [t.surfPig.fbo, srcSurfPig],
        [t.pore.fbo, srcPore],
        [t.porePig.fbo, srcPorePig],
        [t.dryPig.fbo, srcDryPig],
        [t.vel.fbo, srcVel],
        [t.strokeCov.fbo, srcCov]
      ];
      for (let p = 0; p < pairs.length; p++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[p][0]);
        gl.bindTexture(gl.TEXTURE_2D, pairs[p][1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // 2. Direct GPU blit of texOutput interior directly onto chunk.gpuTextures[layer]
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor(innerX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((innerX + innerW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(innerY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((innerY + innerH - 1) / engine.chunkSize);

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, innerX, innerY, innerW, innerH);
    gl.uniform4f(
      this.locRectMap.u_uvSubRect,
      apron / WORK_RES,
      apron / WORK_RES,
      innerW / WORK_RES,
      innerH / WORK_RES
    );
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texOutput.tex);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
        if (!chunk) continue;

        if (!chunk.gpuTextures) chunk.gpuTextures = new Array(engine.layerSettings.length).fill(null);
        if (!chunk.gpuDirty) chunk.gpuDirty = new Array(engine.layerSettings.length).fill(true);
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
        const ox = Math.max(innerX, lx);
        const oy = Math.max(innerY, ly);
        const ox2 = Math.min(innerX + innerW, lx + chunk.width);
        const oy2 = Math.min(innerY + innerH, ly + chunk.height);
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
        if (chunk.isEmpty) chunk.isEmpty[layer] = false;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texOutput.tex);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, chunk.gpuTextures[layer], 0);
        gl.viewport(0, 0, texW, texH);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, sy, sw, sh);
        gl.uniform4f(this.locRectMap.u_dstRect, lx, ly, chunk.width, chunk.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.gpuRenderer) {
      this.gpuRenderer.sumiOverlay = null;
      this.gpuRenderer.requestRender();
    }
  }

  _bindSurfaceUniforms(locs, engine, params) {
    const gl = this.gl;
    const surfMgr = engine ? engine.surfaceManager : null;
    const sp = surfMgr ? surfMgr.getSumiPhysicsParams() : null;
    const hasSurface = !!(sp && sp.active);
    let mapTex = null;
    if (hasSurface) {
      mapTex = surfMgr.ensureGpuTextures(gl).mapTex;
    }
    if (locs.u_surfaceMap) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, mapTex || this.dummyTex);
      gl.uniform1i(locs.u_surfaceMap, 6);
    }
    if (locs.u_hasSurface) gl.uniform1i(locs.u_hasSurface, (hasSurface && mapTex) ? 1 : 0);
    if (locs.u_surfaceInvScale) gl.uniform1f(locs.u_surfaceInvScale, sp ? sp.invScale : (1.0 / 340.0));
    if (locs.u_sizing) gl.uniform1f(locs.u_sizing, sp ? sp.sizing : 0.25);
    if (locs.u_coarseness) gl.uniform1f(locs.u_coarseness, sp ? sp.coarseness : 0.42);
    if (locs.u_surfSlip) gl.uniform1f(locs.u_surfSlip, sp ? sp.slip : 0.45);
    if (locs.u_surfChannel) gl.uniform1f(locs.u_surfChannel, sp ? sp.channel : 0.20);
    if (locs.u_seepRate) {
      const bleedScale = 0.35 + ((params?.bleed ?? 58) / 100) * 1.15;
      gl.uniform1f(locs.u_seepRate, (sp ? sp.seepRate : 0.90) * bleedScale);
    }
    if (locs.u_sootSnag) {
      const snagVal = params?.sootSnag !== undefined ? (params.sootSnag / 100) : (sp ? sp.sootSnag : 0.55);
      gl.uniform1f(locs.u_sootSnag, snagVal);
    }
    if (locs.u_capillarity) {
      const capVal = params?.capillarity !== undefined ? (params.capillarity / 100) : (sp ? sp.capillarity : 0.62);
      gl.uniform1f(locs.u_capillarity, capVal);
    }
  }

  _runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, dt, forceDry, params) {
    const gl = this.gl;
    const texel = 1.0 / WORK_RES;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (boxW - 0.5) * texel);
    const maxV = Math.max(minV, (boxH - 0.5) * texel);

    const evapRate = (params?.evaporation ?? 28) / 100;
    const backrunRim = (params?.backrun ?? 68) / 100;
    const glueVisc = (params?.glue ?? 42) / 100;
    const fdFlag = forceDry ? 1.0 : 0.0;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_RES, WORK_RES);

    // 1. Velocity Advection
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppVel.write().fbo);
    gl.useProgram(this.progVelAdvect);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locVelAdv.u_vel, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locVelAdv.u_surf, 1);
    this._bindSurfaceUniforms(this.locVelAdv, engine, params);
    gl.uniform2f(this.locVelAdv.u_texel, texel, texel);
    gl.uniform4f(this.locVelAdv.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform2f(this.locVelAdv.u_workOrigin, workX, workY);
    gl.uniform1f(this.locVelAdv.u_dt, dt);
    gl.uniform1f(this.locVelAdv.u_glueVisc, glueVisc);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppVel.swap();

    // 2. Divergence
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texDiv.fbo);
    gl.useProgram(this.progDiv);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locDiv.u_vel, 0);
    gl.uniform2f(this.locDiv.u_texel, texel, texel);
    gl.uniform4f(this.locDiv.u_uvClamp, minU, minV, maxU, maxV);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Jacobi Pressure Solve (8 iterations)
    gl.useProgram(this.progPress);
    gl.uniform2f(this.locPress.u_texel, texel, texel);
    gl.uniform4f(this.locPress.u_uvClamp, minU, minV, maxU, maxV);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texDiv.tex);
    gl.uniform1i(this.locPress.u_div, 1);
    for (let it = 0; it < 8; it++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppPress.write().fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ppPress.read().tex);
      gl.uniform1i(this.locPress.u_press, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.ppPress.swap();
    }

    // 4. Pressure Gradient Projection
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppVel.write().fbo);
    gl.useProgram(this.progGradSub);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPress.read().tex);
    gl.uniform1i(this.locGradSub.u_press, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locGradSub.u_vel, 1);
    gl.uniform2f(this.locGradSub.u_texel, texel, texel);
    gl.uniform4f(this.locGradSub.u_uvClamp, minU, minV, maxU, maxV);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppVel.swap();

    // 5a. Advect & Diffuse Wet Parent Layer Underpaint (`ppBaseBg`)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppBaseBg.write().fbo);
    gl.useProgram(this.progBaseStep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppBaseBg.read().tex);
    gl.uniform1i(this.locBaseStep.u_baseBg, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locBaseStep.u_surf, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locBaseStep.u_vel, 2);
    gl.uniform2f(this.locBaseStep.u_texel, texel, texel);
    gl.uniform4f(this.locBaseStep.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1f(this.locBaseStep.u_dt, dt);
    gl.uniform1f(this.locBaseStep.u_glueVisc, glueVisc);
    gl.uniform1i(this.locBaseStep.u_alphaLock, alphaLock);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppBaseBg.swap();

    // 5b. Surface Shallow-Water Spread + Pigment Advection (2 MRT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppSurf.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppSurfPig.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    gl.useProgram(this.progSurfStep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locSurfStep.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
    gl.uniform1i(this.locSurfStep.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locSurfStep.u_vel, 2);
    gl.uniform2f(this.locSurfStep.u_texel, texel, texel);
    gl.uniform4f(this.locSurfStep.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1f(this.locSurfStep.u_dt, dt);
    gl.uniform1f(this.locSurfStep.u_backrunRim, backrunRim);
    gl.uniform1f(this.locSurfStep.u_evapRate, evapRate);
    gl.uniform1f(this.locSurfStep.u_forceDry, fdFlag);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppSurf.swap();
    this.ppSurfPig.swap();

    // 6. Vertical Seepage: Surface -> Capillary Pores (4 MRT)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppSurf.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppSurfPig.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.ppPore.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, this.ppPorePig.write().tex, 0);
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
      gl.COLOR_ATTACHMENT3
    ]);

    gl.useProgram(this.progSurfSeep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locSurfSeep.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
    gl.uniform1i(this.locSurfSeep.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
    gl.uniform1i(this.locSurfSeep.u_pore, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPorePig.read().tex);
    gl.uniform1i(this.locSurfSeep.u_porePig, 3);
    this._bindSurfaceUniforms(this.locSurfSeep, engine, params);
    gl.uniform2f(this.locSurfSeep.u_workOrigin, workX, workY);
    gl.uniform1f(this.locSurfSeep.u_dt, dt);
    gl.uniform1f(this.locSurfSeep.u_forceDry, fdFlag);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppSurf.swap();
    this.ppSurfPig.swap();
    this.ppPore.swap();
    this.ppPorePig.swap();

    // 7. Lateral Capillary Percolation + Fixation into Fiber Pigments (4 MRT)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppSurfPig.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppPore.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.ppPorePig.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, this.ppDryPig.write().tex, 0);
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
      gl.COLOR_ATTACHMENT3
    ]);

    gl.useProgram(this.progPerc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locPerc.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
    gl.uniform1i(this.locPerc.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
    gl.uniform1i(this.locPerc.u_pore, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPorePig.read().tex);
    gl.uniform1i(this.locPerc.u_porePig, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.ppDryPig.read().tex);
    gl.uniform1i(this.locPerc.u_dryPig, 4);
    this._bindSurfaceUniforms(this.locPerc, engine, params);
    gl.uniform1f(this.locPerc.u_evapRate, evapRate);
    gl.uniform2f(this.locPerc.u_texel, texel, texel);
    gl.uniform4f(this.locPerc.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform2f(this.locPerc.u_workOrigin, workX, workY);
    gl.uniform1f(this.locPerc.u_dt, dt);
    gl.uniform1f(this.locPerc.u_forceDry, fdFlag);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppSurfPig.swap();
    this.ppPore.swap();
    this.ppPorePig.swap();
    this.ppDryPig.swap();

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  }

  _compositeWorkBox(engine, workX, workY, boxW, boxH, params) {
    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = !!(layerSet && layerSet.alphaLock);

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_RES, WORK_RES);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texOutput.fbo);
    gl.useProgram(this.progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locComp.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
    gl.uniform1i(this.locComp.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
    gl.uniform1i(this.locComp.u_pore, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPorePig.read().tex);
    gl.uniform1i(this.locComp.u_porePig, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.ppDryPig.read().tex);
    gl.uniform1i(this.locComp.u_dryPig, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.ppBaseBg.read().tex);
    gl.uniform1i(this.locComp.u_baseBg, 5);
    this._bindSurfaceUniforms(this.locComp, engine, params);
    gl.uniform2f(this.locComp.u_workOrigin, workX, workY);

    gl.uniform1f(this.locComp.u_sootDensity, (params?.ink ?? 78) / 100);
    gl.uniform1f(this.locComp.u_inkWarmth, (params?.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  beginStrokeSession(engine, worldPos, params = {}) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    if (params && typeof params === 'object') {
      this.lastParams = { ...params };
    }
    const layer = engine.activeLayer;
    const projId = engine.currentProjectId || 'default';

    if (this.active && (this.layer !== layer || this.projectId !== projId)) {
      this.commitToChunks(engine, this.lastParams || {}, true);
    } else if (this.active && this._hasCpuDirty) {
      // Ensure previous stroke's finished idle bleed is synced to Canvas2D BEFORE new Undo snapshot is taken
      this.syncTilesToCanvas2D(engine, this.lastParams || {});
    }

    this.layer = layer;
    this.projectId = projId;
    this.strokeId = (this.strokeId % 1024) + 1;
    this.active = true;
    this.simActiveFrames = 540;

    this.wetMinX = worldPos.x - 32;
    this.wetMinY = worldPos.y - 32;
    this.wetMaxX = worldPos.x + 32;
    this.wetMaxY = worldPos.y + 32;
    this._focusX = worldPos.x;
    this._focusY = worldPos.y;
    this.gpuRenderer.sumiOverlay = null;
    return true;
  }

  stampAndStep(engine, segments, modeInt, brushVelWorld, pressure, pigmentK, params) {
    if (!this.ready || !this.active || !segments || segments.length === 0) return;
    if (params && typeof params === 'object') this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const count = Math.min(MAX_INSTANCES, segments.length);
    let segMinX = Infinity, segMinY = Infinity, segMaxX = -Infinity, segMaxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const s = segments[i];
      const pad = s.r + 28;
      segMinX = Math.min(segMinX, s.x0 - pad, s.x1 - pad);
      segMaxX = Math.max(segMaxX, s.x0 + pad, s.x1 + pad);
      segMinY = Math.min(segMinY, s.y0 - pad, s.y1 - pad);
      segMaxY = Math.max(segMaxY, s.y0 + pad, s.y1 + pad);
    }

    this.dirtyMinX = Math.min(this.dirtyMinX, segMinX);
    this.dirtyMinY = Math.min(this.dirtyMinY, segMinY);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, segMaxX);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, segMaxY);

    this.wetMinX = Math.min(this.wetMinX, segMinX);
    this.wetMinY = Math.min(this.wetMinY, segMinY);
    this.wetMaxX = Math.max(this.wetMaxX, segMaxX);
    this.wetMaxY = Math.max(this.wetMaxY, segMaxY);
    this._focusX = (segMinX + segMaxX) * 0.5;
    this._focusY = (segMinY + segMaxY) * 0.5;

    const apron = 4;
    const needMinX = Math.floor(Math.min(segMinX, Math.max(this.wetMinX, segMinX - 180)) - apron);
    const needMinY = Math.floor(Math.min(segMinY, Math.max(this.wetMinY, segMinY - 180)) - apron);
    const needMaxX = Math.ceil(Math.max(segMaxX, Math.min(this.wetMaxX, segMaxX + 180)) + apron);
    const needMaxY = Math.ceil(Math.max(segMaxY, Math.min(this.wetMaxY, segMaxY + 180)) + apron);

    const spanX = needMaxX - needMinX;
    const spanY = needMaxY - needMinY;
    const boxW = Math.min(WORK_RES, Math.max(32, spanX));
    const boxH = Math.min(WORK_RES, Math.max(32, spanY));
    const workX = spanX > WORK_RES ? Math.floor(this._focusX - boxW * 0.5) : needMinX;
    const workY = spanY > WORK_RES ? Math.floor(this._focusY - boxH * 0.5) : needMinY;

    engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, workX + apron);
    engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, workX + boxW - apron);
    engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, workY + apron);
    engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, workY + boxH - apron);

    // Ensure overlapping chunks are backed up for Undo before any pixel changes
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor((workX + apron) / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((workX + boxW - apron - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor((workY + apron) / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((workY + boxH - apron - 1) / engine.chunkSize);
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
        if (chunk) {
          const id = `${cx},${cy}`;
          if (!engine.currentStrokeDirtyChunks.has(id)) {
            backupChunkLayer(engine, chunk, id, { layer });
            engine._markDirty(id, layer);
          }
        }
      }
    }

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    if (tiles.length === 0) return;

    for (let i = 0; i < count; i++) {
      const s = segments[i];
      const i4 = i * 4;
      this._instSegData[i4] = s.x0 - workX;
      this._instSegData[i4 + 1] = s.y0 - workY;
      this._instSegData[i4 + 2] = s.x1 - workX;
      this._instSegData[i4 + 3] = s.y1 - workY;

      this._instPropData[i4] = s.r;
      this._instPropData[i4 + 1] = s.inkW;
      this._instPropData[i4 + 2] = s.waterW;
      this._instPropData[i4 + 3] = s.contactW ?? 1.0;
    }

    // PASS 1: Clear texStamp interior & accumulate bristle bundle footprint via gl.FUNC_ADD
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.viewport(0, 0, WORK_RES, WORK_RES);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texStamp.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.progBristle);
    gl.uniform2f(this.locBristle.u_invWorkRes, 1.0 / WORK_RES, 1.0 / WORK_RES);

    gl.bindVertexArray(this.bristleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instSegVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._instSegData.subarray(0, count * 4));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instPropVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._instPropData.subarray(0, count * 4));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(this.gpuRenderer.vao);

    gl.disable(gl.BLEND);

    // PASS 1B: On WATER mode, re-wet fixed dryPig into mobile surfPig
    if (modeInt === 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppSurfPig.write().tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppDryPig.write().tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      gl.useProgram(this.progRewet);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texStamp.tex);
      gl.uniform1i(this.locRewet.u_stamp, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
      gl.uniform1i(this.locRewet.u_surfPig, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.ppDryPig.read().tex);
      gl.uniform1i(this.locRewet.u_dryPig, 2);
      gl.uniform1f(this.locRewet.u_waterCharge, (params?.water ?? 65) / 100);
      const sp = engine?.surfaceManager ? engine.surfaceManager.getSumiPhysicsParams() : null;
      gl.uniform1f(this.locRewet.u_sizing, sp ? sp.sizing : 0.25);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      this.ppSurfPig.swap();
      this.ppDryPig.swap();
    }

    // PASS 2: Brush Apply (4 MRT: surf, surfPig, vel, strokeCov)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppSurf.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppSurfPig.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.ppVel.write().tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, this.ppStrokeCov.write().tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);

    gl.useProgram(this.progBrushApply);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texStamp.tex);
    gl.uniform1i(this.locApply.u_stamp, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locApply.u_surf, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurfPig.read().tex);
    gl.uniform1i(this.locApply.u_surfPig, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
    gl.uniform1i(this.locApply.u_vel, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.ppStrokeCov.read().tex);
    gl.uniform1i(this.locApply.u_strokeCov, 4);

    this._bindSurfaceUniforms(this.locApply, engine, params);
    gl.uniform1i(this.locApply.u_mode, modeInt);
    gl.uniform2f(this.locApply.u_workOrigin, workX, workY);
    gl.uniform2f(this.locApply.u_brushVel, brushVelWorld.x, brushVelWorld.y);
    gl.uniform1f(this.locApply.u_pressure, pressure);
    gl.uniform1f(this.locApply.u_inkConcentration, (params?.ink ?? 78) / 100);
    gl.uniform1f(this.locApply.u_waterCharge, (params?.water ?? 65) / 100);
    gl.uniform1f(this.locApply.u_glueVisc, (params?.glue ?? 42) / 100);
    gl.uniform3f(this.locApply.u_pigmentK, pigmentK[0], pigmentK[1], pigmentK[2]);
    gl.uniform1i(this.locApply.u_physicalMix, engine.physicalColorMix !== false ? 1 : 0);
    gl.uniform1f(this.locApply.u_strokeId, this.strokeId);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    this.ppSurf.swap();
    this.ppSurfPig.swap();
    this.ppVel.swap();
    this.ppStrokeCov.swap();

    // PASS 3..7: Physics + Optical Composite + Direct Chunk Blit
    this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, 0.016, false, params);
    this._compositeWorkBox(engine, workX, workY, boxW, boxH, params);
    this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);

    this.simActiveFrames = 540;
  }

  stepSimulation(engine, dt = 0.016, forceDry = false, params = {}) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    if (this.wetMaxX <= this.wetMinX || this.wetMaxY <= this.wetMinY) return;

    const apron = 4;
    if (this.simActiveFrames > 340 && (this.simActiveFrames % 4) === 0) {
      this.wetMinX -= 1;
      this.wetMinY -= 1;
      this.wetMaxX += 1;
      this.wetMaxY += 1;
    }
    this.dirtyMinX = Math.min(this.dirtyMinX, this.wetMinX);
    this.dirtyMinY = Math.min(this.dirtyMinY, this.wetMinY);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, this.wetMaxX);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, this.wetMaxY);

    const spanX = Math.ceil(this.wetMaxX - this.wetMinX) + apron * 2;
    const spanY = Math.ceil(this.wetMaxY - this.wetMinY) + apron * 2;
    const boxW = Math.min(WORK_RES, Math.max(32, spanX));
    const boxH = Math.min(WORK_RES, Math.max(32, spanY));
    const workX = spanX > WORK_RES ? Math.floor(this._focusX - boxW * 0.5) : Math.floor(this.wetMinX - apron);
    const workY = spanY > WORK_RES ? Math.floor(this._focusY - boxH * 0.5) : Math.floor(this.wetMinY - apron);

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    if (tiles.length === 0) return;

    this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, dt, forceDry, activeParams);
    this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
    this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
  }

  hasCpuDirtyTiles() {
    return this._hasCpuDirty;
  }

  _syncSingleTileToCanvas2D(engine, t, params = {}) {
    if (!t || !t.cpuDirty || t.maxX <= t.minX || t.maxY <= t.minY) return;
    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = !!(layerSet && layerSet.alphaLock);

    const rx0 = Math.max(0, t.minX | 0);
    const ry0 = Math.max(0, t.minY | 0);
    const rx1 = Math.min(TILE_SIZE, Math.ceil(t.maxX));
    const ry1 = Math.min(TILE_SIZE, Math.ceil(t.maxY));
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) {
      t.cpuDirty = false;
      return;
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);

    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.scissor(rx0, ry0, rw, rh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
    gl.useProgram(this.progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.surf.tex);
    gl.uniform1i(this.locComp.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.surfPig.tex);
    gl.uniform1i(this.locComp.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, t.pore.tex);
    gl.uniform1i(this.locComp.u_pore, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, t.porePig.tex);
    gl.uniform1i(this.locComp.u_porePig, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, t.dryPig.tex);
    gl.uniform1i(this.locComp.u_dryPig, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, t.baseBg.tex);
    gl.uniform1i(this.locComp.u_baseBg, 5);
    this._bindSurfaceUniforms(this.locComp, engine, params);
    gl.uniform2f(this.locComp.u_workOrigin, t.wx, t.wy);
    gl.uniform1f(this.locComp.u_sootDensity, (params?.ink ?? 78) / 100);
    gl.uniform1f(this.locComp.u_inkWarmth, (params?.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const byteLen = rw * rh * 4;
    const view = this._readBuf.subarray(0, byteLen);
    gl.readPixels(rx0, ry0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view);

    for (let i = 0; i < byteLen; i += 4) {
      const a = view[i + 3];
      if (a > 0 && a < 255) {
        const inv = 255 / a;
        view[i] = Math.min(255, (view[i] * inv + 0.5) | 0);
        view[i + 1] = Math.min(255, (view[i + 1] * inv + 0.5) | 0);
        view[i + 2] = Math.min(255, (view[i + 2] * inv + 0.5) | 0);
      }
    }

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
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
        if (!chunk) continue;

        const id = `${cx},${cy}`;
        if (engine.isDrawing && !engine.currentStrokeDirtyChunks.has(id)) {
          backupChunkLayer(engine, chunk, id, { layer });
        }

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
        // Leave gpuDirty[layer] = false during live strokes since gpuTextures[layer] already matches
        engine._markDirty(id, layer, false);
        if (chunk.gpuDirty) chunk.gpuDirty[layer] = false;
      }
    }

    t.cpuDirty = false;
  }

  syncTilesToCanvas2D(engine, params = {}) {
    if (!this.ready || !this.active || !engine || this.activeTiles.size === 0) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const dirtyTiles = [];
    this.activeTiles.forEach((t) => {
      if (t.cpuDirty && t.maxX > t.minX && t.maxY > t.minY) {
        dirtyTiles.push(t);
      }
    });

    for (let i = 0; i < dirtyTiles.length; i++) {
      this._syncSingleTileToCanvas2D(engine, dirtyTiles[i], activeParams);
    }
    this._hasCpuDirty = false;

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  commitToChunks(engine, params = {}, closeSession = false) {
    if (!this.ready || !this.active || !engine) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    this.syncTilesToCanvas2D(engine, activeParams);

    if (closeSession) {
      this._releaseAllTiles();
      this.touchedChunks.clear();
      this.active = false;
      this.simActiveFrames = 0;
      this.dirtyMinX = Infinity;
      this.dirtyMinY = Infinity;
      this.dirtyMaxX = -Infinity;
      this.dirtyMaxY = -Infinity;
      this.wetMinX = Infinity;
      this.wetMinY = Infinity;
      this.wetMaxX = -Infinity;
      this.wetMaxY = -Infinity;
      if (this.gpuRenderer) {
        this.gpuRenderer.sumiOverlay = null;
        this.gpuRenderer.requestRender();
      }
    }
  }

  forceDry(engine, params = {}) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return false;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };

    // Step across active tile groups up to WORK_RES so even multi-chunk strokes dry completely
    const STEP_SPAN = 640;
    const minX = Math.floor(this.dirtyMinX);
    const minY = Math.floor(this.dirtyMinY);
    const maxX = Math.ceil(this.dirtyMaxX);
    const maxY = Math.ceil(this.dirtyMaxY);
    const apron = 4;

    if (maxX > minX && maxY > minY) {
      for (let x = minX; x < maxX; x += STEP_SPAN) {
        for (let y = minY; y < maxY; y += STEP_SPAN) {
          const innerW = Math.min(STEP_SPAN, maxX - x);
          const innerH = Math.min(STEP_SPAN, maxY - y);
          const boxW = Math.min(WORK_RES, Math.max(32, innerW + apron * 2));
          const boxH = Math.min(WORK_RES, Math.max(32, innerH + apron * 2));
          const workX = x - apron;
          const workY = y - apron;

          const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
          if (tiles.length === 0) continue;
          for (let it = 0; it < 6; it++) {
            this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, 0.016, true, activeParams);
          }
          this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
          this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
        }
      }
    }

    this.commitToChunks(engine, activeParams, true);
    return true;
  }

  cancel(engine = null, restoreDirty = false) {
    this.active = false;
    this.simActiveFrames = 0;
    if (restoreDirty && engine && this.touchedChunks.size > 0) {
      const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
      this.touchedChunks.forEach(({ chunk }) => {
        if (chunk && chunk.gpuDirty) {
          chunk.gpuDirty[layer] = true;
        }
      });
    }
    this._releaseAllTiles();
    this.touchedChunks.clear();
    this.dirtyMinX = Infinity;
    this.dirtyMinY = Infinity;
    this.dirtyMaxX = -Infinity;
    this.dirtyMaxY = -Infinity;
    this.wetMinX = Infinity;
    this.wetMinY = Infinity;
    this.wetMaxX = -Infinity;
    this.wetMaxY = -Infinity;

    if (this.gl && !this.gl.isContextLost()) {
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.sumiOverlay = null;
      this.gpuRenderer.requestRender();
    }
  }

  dispose() {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      this._releaseAllTiles();
      for (let i = 0; i < this.tilePool.length; i++) {
        this._destroyTileGpu(this.tilePool[i]);
      }
      this.tilePool = [];
      this.touchedChunks.clear();

      const delT = (t) => {
        if (!t) return;
        if (t.tex) gl.deleteTexture(t.tex);
        if (t.fbo) gl.deleteFramebuffer(t.fbo);
      };
      const delPP = (pp) => { if (pp) { delT(pp.a); delT(pp.b); } };
      delPP(this.ppSurf);
      delPP(this.ppSurfPig);
      delPP(this.ppPore);
      delPP(this.ppPorePig);
      delPP(this.ppDryPig);
      delPP(this.ppVel);
      delPP(this.ppPress);
      delPP(this.ppStrokeCov);
      delPP(this.ppBaseBg);
      delT(this.texDiv);
      delT(this.texStamp);
      delT(this.texOutput);
      delT(this.texTileUnpremult);
      if (this.dummyTex) gl.deleteTexture(this.dummyTex);

      if (this.mrtFbo) gl.deleteFramebuffer(this.mrtFbo);
      if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
      if (this.bristleVao) gl.deleteVertexArray(this.bristleVao);
      if (this.quadCornerVbo) gl.deleteBuffer(this.quadCornerVbo);
      if (this.instSegVbo) gl.deleteBuffer(this.instSegVbo);
      if (this.instPropVbo) gl.deleteBuffer(this.instPropVbo);

      const progs = [
        this.progRectMap, this.progUnpremult, this.progBristle,
        this.progRewet, this.progBrushApply, this.progVelAdvect,
        this.progDiv, this.progPress, this.progGradSub,
        this.progSurfStep, this.progBaseStep, this.progSurfSeep,
        this.progPerc, this.progComp
      ];
      for (const p of progs) if (p) gl.deleteProgram(p);
    }
    this.ready = false;
    this.active = false;
    this.gl = null;
  }
}
