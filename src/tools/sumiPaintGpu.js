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
import { GLSL_SURFACE_BIOME_SAMPLER } from '../engine/canvasSurfaceGpu.js';

const TILE_SIZE = 256;
const WORK_RES = 768;
const MAX_POOL_TILES = 96;
const MAX_ACTIVE_WET = 48;
const MAX_PASSIVE_TILES = 160;
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

  float falloff = pow(clamp(1.0 - d * d, 0.0, 1.0), 1.30);
  float inkDep = falloff * v_inkW;
  float watDep = falloff * v_waterW;
  float contact = falloff * v_contactW;
  outStamp = vec4(inkDep, watDep, contact, falloff);
}`;

const SUMI_NOISE_GLSL = `
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
}`;

const SUMI_SURFACE_GLSL = `
${GLSL_SURFACE_BIOME_SAMPLER}
${SUMI_NOISE_GLSL}
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
    vec4 pore = sampleSurfacePoreBiome(u_poreMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    float h = clamp(pore.r * 0.72 + longFibers * 0.28, 0.0, 1.0);
    float openPore = clamp(pore.g, 0.04, 1.0);
    float sootBlock = clamp(mix(pore.b, h * 0.72 + longFibers * 0.18, 0.30), 0.06, 0.98);
    float tooth = clamp(mix(pore.a, 0.45 + (h - 0.5) * (0.48 + u_coarseness * 0.85), 0.35), 0.0, 1.0);
    if (u_useHeightmap == 1 && u_heightSource == 0) {
      vec4 s = sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
      h = clamp(mix(h, s.r, 0.48), 0.0, 1.0);
      openPore = clamp(mix(openPore, (1.0 - s.r * 0.65) * 0.55 + s.a * 0.45, 0.35), 0.04, 1.0);
      tooth = clamp(mix(tooth, 0.45 + (s.r - 0.5) * (0.48 + u_coarseness * 0.85) - s.a * 0.18, 0.50), 0.0, 1.0);
    }
    float sizingMask = mix(1.0, 0.14, u_sizing);
    float perm = clamp(openPore * sizingMask * mix(0.76, 1.16, localGluePatch), 0.03, 1.0);
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

// Pre-bake substrate properties (height, permeability, sootBlock, tooth) once per 256x256 tile
const SUB_BAKE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surfaceMap;
uniform sampler2D u_poreMap;
uniform int u_hasSurface;
uniform int u_useHeightmap;
uniform int u_heightSource;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_sizing;
uniform float u_coarseness;
uniform vec2 u_workOrigin;

out vec4 outSub;

${SUMI_SURFACE_GLSL}

void main() {
  outSub = sampleSumiSubstrate(u_workOrigin + gl_FragCoord.xy);
}`;

// Re-wet previously fixed dryPig back into mobile surfPig on WATER strokes scaled by u_inkAffection
const REWET_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_stamp;
uniform sampler2D u_surfPig;
uniform sampler2D u_dryPig;
uniform float u_waterCharge;
uniform float u_sizing;
uniform float u_inkAffection;

in vec2 v_uv;

layout(location = 0) out vec4 outSurfPig;
layout(location = 1) out vec4 outDryPig;

void main() {
  vec4 stamp = texture(u_stamp, v_uv);
  vec4 surfPig = texture(u_surfPig, v_uv);
  vec4 dryPig = texture(u_dryPig, v_uv);

  float footSignal = min(1.0, max(stamp.b, stamp.g));
  float aff = clamp(u_inkAffection, 0.0, 1.0);
  if (footSignal > 0.002 && dryPig.a > 0.0004 && aff > 0.004) {
    float affScale = pow(aff, 1.15);
    float liftFrac = clamp(footSignal * (0.32 + 0.55 * clamp(u_waterCharge, 0.0, 1.5)) * (1.0 - u_sizing * 0.30) * affScale, 0.0, 0.70);
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
uniform sampler2D u_sub;

uniform float u_surfSlip;
uniform int u_mode;         // 0=draw, 1=water, 2=blow, 3=dry/blot, 4=eraser
uniform vec2 u_brushVel;
uniform float u_pressure;
uniform float u_inkConcentration;
uniform float u_inkAffection;
uniform float u_waterCharge;
uniform float u_maxWater;
uniform float u_glueVisc;
uniform vec3 u_pigmentK;
uniform int u_physicalMix;
uniform float u_strokeId;

in vec2 v_uv;

layout(location = 0) out vec4 outSurf;
layout(location = 1) out vec4 outSurfPig;
layout(location = 2) out vec4 outVel;
layout(location = 3) out vec4 outStrokeCov;

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

  float fiberH = texture(u_sub, v_uv).r;
  float maxCap = clamp(u_maxWater, 0.15, 2.90);
  float headroom = max(0.0, 1.0 - surf.r / maxCap);

  // Fiber tooth modulation (kasure): dry brush catches high fiber ridges, skips valleys
  float avgWatPerContact = totalWatAdd / max(0.002, totalContact);
  float dryFactor = clamp(1.0 - avgWatPerContact * 1.4, 0.0, 1.0);
  float toothGate = smoothstep(dryFactor * 0.60, dryFactor * 0.60 + 0.25, fiberH);
  float kTooth = mix(1.0, toothGate, dryFactor * 0.88);
  float contactClamped = clamp(totalContact, 0.0, 1.0);

  if (u_mode == 0) {
    // DRAW: true multi-tuft accumulation into wet surface puddle & velvety carbon core
    float wCharge = clamp(u_waterCharge, 0.0, 1.0);
    float waterGain = totalWatAdd * 0.45 * (0.28 + 0.72 * kTooth);
    float dilution = mix(1.18, 0.58, wCharge);
    float inkGain = totalInkAdd * 0.52 * kTooth * dilution * (0.08 + 1.20 * u_inkConcentration);

    surf.r = min(maxCap, surf.r + waterGain * headroom);
    surf.g = clamp(surf.g + inkGain * (0.15 + u_glueVisc * 0.65) * 0.55, 0.0, 2.0);
    surf.b = max(surf.b, contactClamped * 0.92);
    surf.a = max(0.0, surf.a * (1.0 - contactClamped * 0.85));

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
    // WATER: rich clean water wash bounded smoothly by u_maxWater
    float watPresence = smoothstep(0.0, 0.012, max(u_waterCharge, totalWatAdd));
    float watScaled = min(2.8, totalWatAdd) * (0.08 + 0.92 * min(1.6, max(0.0, u_waterCharge))) * 0.65;
    float touchFloor = contactClamped * (0.03 + 0.42 * clamp(u_waterCharge, 0.0, 1.5)) * 0.35 * watPresence;
    float waterGain = watScaled + touchFloor * (1.0 - smoothstep(0.0, 0.45, watScaled));
    surf.r = min(maxCap, surf.r + waterGain * headroom);
    surf.g = max(0.0, surf.g * (1.0 - contactClamped * 0.25 * watPresence));
    surf.b = mix(surf.b, clamp(u_inkAffection, 0.0, 1.0), clamp(contactClamped * 1.45 * watPresence, 0.0, 1.0));
    vel.xy += u_brushVel * min(0.95, totalContact) * (0.70 + 1.55 * min(1.6, max(0.0, u_waterCharge))) * mix(0.75, 1.35, u_surfSlip) * watPresence;
  } else if (u_mode == 2) {
    // BLOW: directional air impulse pushes wet ink & shallow-water underpaint
    float pushStrength = min(1.4, max(totalContact, totalWatAdd));
    vel.xy += u_brushVel * pushStrength * (4.2 + 2.2 * u_surfSlip);
    surf.r = min(maxCap, surf.r + pushStrength * 0.015 * headroom);
  } else if (u_mode == 4) {
    // ERASER: paint with erasing ink (uses bristle kasure, water charge & paper bleed to remove paint)
    float waterGain = totalWatAdd * 0.42 * (0.28 + 0.72 * kTooth);
    float solvGain = totalInkAdd * 0.82 * kTooth * (0.06 + 1.18 * u_inkConcentration);
    surf.r = min(maxCap, surf.r + waterGain * headroom);
    surf.b = max(0.0, surf.b * (1.0 - contactClamped));
    surf.a = clamp(surf.a + solvGain, 0.0, 6.0);
    float strip = clamp(solvGain * 0.95, 0.0, 0.98);
    surfPig.a = max(0.0, surfPig.a * (1.0 - strip));
    vel.xy += u_brushVel * min(1.0, totalContact) * (0.8 + 1.4 * u_waterCharge) * mix(0.65, 1.35, u_surfSlip);
  } else if (u_mode == 3) {
    // DRY / BLOT: absorbs wet surface water & suspended soot
    float absorb = clamp(contactClamped * 0.55, 0.0, 0.85);
    surf.r *= (1.0 - absorb);
    surf.g *= (1.0 - absorb * 0.7);
    surf.a *= (1.0 - absorb);
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
uniform sampler2D u_sub;
uniform sampler2D u_surfaceMap;
uniform sampler2D u_baseBg;
uniform int u_hasSurface;
uniform int u_useHeightmap;
uniform int u_heightSource;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_surfSlip;
uniform float u_surfChannel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform vec2 u_workOrigin;
uniform float u_dt;
uniform float u_glueVisc;
uniform float u_turb;
uniform float u_time;
in vec2 v_uv;
out vec4 outVel;
${GLSL_SURFACE_BIOME_SAMPLER}
${SUMI_NOISE_GLSL}
void main() {
  vec2 vel = texture(u_vel, v_uv).xy;
  vec4 surf = texture(u_surf, v_uv);
  vec2 worldPos = u_workOrigin + gl_FragCoord.xy;

  // Semi-Lagrangian backtrace (vel is in work-pixels/sec)
  vec2 backUv = clamp(v_uv - vel * u_texel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec2 advV = texture(u_vel, backUv).xy;

  // 8-neighbor isotropic Sobel height gradient eliminates axis-aligned water stair-stepping
  float hL  = texture(u_surf, clamp(v_uv + vec2(-u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hR  = texture(u_surf, clamp(v_uv + vec2( u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hD  = texture(u_surf, clamp(v_uv + vec2(0.0, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hU  = texture(u_surf, clamp(v_uv + vec2(0.0,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hLD = texture(u_surf, clamp(v_uv + vec2(-u_texel.x, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hRD = texture(u_surf, clamp(v_uv + vec2( u_texel.x, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hLU = texture(u_surf, clamp(v_uv + vec2(-u_texel.x,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  float hRU = texture(u_surf, clamp(v_uv + vec2( u_texel.x,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
  vec2 gradH = vec2(
    2.0 * (hR - hL) + (hRU - hLU) + (hRD - hLD),
    2.0 * (hU - hD) + (hLU - hLD) + (hRU - hRD)
  ) * 0.125;

  // Pore/fiber channel steering + optional heightmap slope (Surface or Layer)
  vec2 gradP = vec2(0.0);
  if (u_useHeightmap == 1 && u_heightSource == 1) {
    vec4 bL = texture(u_baseBg, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
    vec4 bR = texture(u_baseBg, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw));
    vec4 bD = texture(u_baseBg, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
    vec4 bU = texture(u_baseBg, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw));
    float lL = bL.a * (0.35 + 0.65 * dot(bL.a > 0.002 ? (bL.rgb / bL.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
    float lR = bR.a * (0.35 + 0.65 * dot(bR.a > 0.002 ? (bR.rgb / bR.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
    float lD = bD.a * (0.35 + 0.65 * dot(bD.a > 0.002 ? (bD.rgb / bD.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
    float lU = bU.a * (0.35 + 0.65 * dot(bU.a > 0.002 ? (bU.rgb / bU.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
    gradP = vec2(lR - lL, lU - lD) * (1.8 + 1.4 * u_surfChannel);
  } else if (u_useHeightmap == 1 && u_heightSource == 0 && u_hasSurface == 1) {
    vec4 s = sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    gradP = (s.gb - 0.5) * 2.0 * (0.4 + 1.2 * u_surfChannel);
  } else {
    float pL = texture(u_sub, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pR = texture(u_sub, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pD = texture(u_sub, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pU = texture(u_sub, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
    gradP = vec2(pR - pL, pU - pD) * (0.35 + 0.55 * u_surfChannel);
  }

  float wetness = smoothstep(0.004, 0.09, surf.r);
  advV -= gradH * 72.0 * wetness * mix(0.75, 1.25, u_surfSlip);
  advV -= gradP * 14.0 * wetness;

  if (u_turb > 0.002 && wetness > 0.002) {
    float tShift = u_time * 0.42;
    vec2 tp1 = worldPos * 0.032 + vec2(tShift, -tShift * 0.73);
    vec2 tp2 = worldPos * 0.095 + vec2(-tShift * 0.61, tShift * 0.89);
    float eps = 0.06;
    float n1x = sumiNoise(tp1 + vec2(eps, 0.0)) - sumiNoise(tp1 - vec2(eps, 0.0));
    float n1y = sumiNoise(tp1 + vec2(0.0, eps)) - sumiNoise(tp1 - vec2(0.0, eps));
    float n2x = sumiNoise(tp2 + vec2(eps, 0.0)) - sumiNoise(tp2 - vec2(eps, 0.0));
    float n2y = sumiNoise(tp2 + vec2(0.0, eps)) - sumiNoise(tp2 - vec2(0.0, eps));
    vec2 curl = (vec2(n1y, -n1x) * 0.65 + vec2(n2y, -n2x) * 0.35) / (2.0 * eps);
    float puddleAmp = smoothstep(0.008, 0.22, surf.r);
    advV += curl * (u_turb * 190.0) * wetness * puddleAmp * mix(0.70, 1.30, u_surfSlip);
  }

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
uniform float u_maxWater;
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

  // 8-neighbor isotropic stencil (0.20 cardinal, 0.05 diagonal) eliminates octagon/stair artifacts
  vec2 uvL  = clamp(backUv + vec2(-u_texel.x,  0.0), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvR  = clamp(backUv + vec2( u_texel.x,  0.0), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvB  = clamp(backUv + vec2( 0.0, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvT  = clamp(backUv + vec2( 0.0,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvLB = clamp(backUv + vec2(-u_texel.x, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvRB = clamp(backUv + vec2( u_texel.x, -u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvLT = clamp(backUv + vec2(-u_texel.x,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvRT = clamp(backUv + vec2( u_texel.x,  u_texel.y), u_uvClamp.xy, u_uvClamp.zw);

  vec4 sL  = texture(u_surf, uvL);
  vec4 sR  = texture(u_surf, uvR);
  vec4 sB  = texture(u_surf, uvB);
  vec4 sT  = texture(u_surf, uvT);
  vec4 sLB = texture(u_surf, uvLB);
  vec4 sRB = texture(u_surf, uvRB);
  vec4 sLT = texture(u_surf, uvLT);
  vec4 sRT = texture(u_surf, uvRT);

  vec4 pL  = texture(u_surfPig, uvL);
  vec4 pR  = texture(u_surfPig, uvR);
  vec4 pB  = texture(u_surfPig, uvB);
  vec4 pT  = texture(u_surfPig, uvT);
  vec4 pLB = texture(u_surfPig, uvLB);
  vec4 pRB = texture(u_surfPig, uvRB);
  vec4 pLT = texture(u_surfPig, uvLT);
  vec4 pRT = texture(u_surfPig, uvRT);

  float avgWater = 0.20 * (sL.r + sR.r + sB.r + sT.r) + 0.05 * (sLB.r + sRB.r + sLT.r + sRT.r);
  float waterLap = avgWater - surf.r;

  float wetMask = smoothstep(0.004, 0.08, max(surf.r, avgWater));
  float rimWet = smoothstep(0.003, 0.05, max(surf.r, avgWater));
  float wB_sum = 0.20 * (sL.r + sR.r + sB.r + sT.r) + 0.05 * (sLB.r + sRB.r + sLT.r + sRT.r);
  if (wB_sum > 0.001) {
    float avgAff = (
      0.20 * (sL.b * sL.r + sR.b * sR.r + sB.b * sB.r + sT.b * sT.r) +
      0.05 * (sLB.b * sLB.r + sRB.b * sRB.r + sLT.b * sLT.r + sRT.b * sRT.r)
    ) / wB_sum;
    float affBlend = waterLap > 0.0
      ? clamp(waterLap / max(0.001, surf.r + waterLap), 0.0, 0.85)
      : (0.04 * wetMask);
    surf.b = mix(surf.b, avgAff, affBlend);
  }
  float avgSolv = 0.20 * (sL.a + sR.a + sB.a + sT.a) + 0.05 * (sLB.a + sRB.a + sLT.a + sRT.a);
  float solvLap = avgSolv - surf.a;
  surf.a = max(0.0, surf.a + solvLap * 0.24 * wetMask);

  float maxCap = clamp(u_maxWater, 0.15, 2.90);
  surf.r = clamp(surf.r + waterLap * 0.28 * wetMask, 0.0, maxCap);

  // Backrun / Coffee-ring edge pooling: outward radial flow carries suspended soot to perimeter rim
  float rL  = max(0.0, sL.r  - surf.r) * 0.20 * 4.0;
  float rR  = max(0.0, sR.r  - surf.r) * 0.20 * 4.0;
  float rB  = max(0.0, sB.r  - surf.r) * 0.20 * 4.0;
  float rT  = max(0.0, sT.r  - surf.r) * 0.20 * 4.0;
  float rLB = max(0.0, sLB.r - surf.r) * 0.05 * 4.0;
  float rRB = max(0.0, sRB.r - surf.r) * 0.05 * 4.0;
  float rLT = max(0.0, sLT.r - surf.r) * 0.05 * 4.0;
  float rRT = max(0.0, sRT.r - surf.r) * 0.05 * 4.0;

  float inFlux = rL + rR + rB + rT + rLB + rRB + rLT + rRT;
  float outFlux = (
    max(0.0, surf.r - sL.r) + max(0.0, surf.r - sR.r) +
    max(0.0, surf.r - sB.r) + max(0.0, surf.r - sT.r)
  ) * 0.80 + (
    max(0.0, surf.r - sLB.r) + max(0.0, surf.r - sRB.r) +
    max(0.0, surf.r - sLT.r) + max(0.0, surf.r - sRT.r)
  ) * 0.20;

  float rimGain = u_backrunRim * 0.34 * rimWet;
  mixInk(pig, pL,  rL  * rimGain);
  mixInk(pig, pR,  rR  * rimGain);
  mixInk(pig, pB,  rB  * rimGain);
  mixInk(pig, pT,  rT  * rimGain);
  mixInk(pig, pLB, rLB * rimGain);
  mixInk(pig, pRB, rRB * rimGain);
  mixInk(pig, pLT, rLT * rimGain);
  mixInk(pig, pRT, rRT * rimGain);
  pig.a = max(0.0, pig.a - pig.a * outFlux * rimGain * 0.92);

  // Subtle pigment diffusion suppressed along steep outer rim gradients so coffee-ring edge stays crisp
  vec4 avgNeigh = vec4(0.0);
  mixInk(avgNeigh, pL,  0.20);
  mixInk(avgNeigh, pR,  0.20);
  mixInk(avgNeigh, pB,  0.20);
  mixInk(avgNeigh, pT,  0.20);
  mixInk(avgNeigh, pLB, 0.05);
  mixInk(avgNeigh, pRB, 0.05);
  mixInk(avgNeigh, pLT, 0.05);
  mixInk(avgNeigh, pRT, 0.05);
  float isRim = smoothstep(0.02, 0.25, inFlux) * (0.45 + 0.55 * u_backrunRim);
  float pigDiff = clamp(surf.r * 0.085, 0.0, 0.12) * (1.0 - isRim * 0.88);
  float nextM = mix(pig.a, avgNeigh.a, pigDiff);
  float cMix = nextM > 1e-5 ? clamp((avgNeigh.a * pigDiff) / nextM, 0.0, 1.0) : 0.0;
  pig.rgb = mix(pig.rgb, avgNeigh.rgb, cMix);
  pig.a = nextM;

  // Dissolve suspended surface pigment if erasing-ink solvent is present
  if (surf.a > 0.0005) {
    pig.a *= exp(-surf.a * 3.2);
    if (pig.a < 0.0008) pig = vec4(0.0);
  }

  // Natural slow surface evaporation
  float evap = u_evapRate * 0.22 * u_dt + u_forceDry * 5.0;
  surf.r = max(0.0, surf.r - evap);

  // Consume erasing solvent quickly when dry, linger slightly when wet so edges bleed
  surf.a *= mix(0.28, 0.72, smoothstep(0.04, 0.45, surf.r));
  if (u_forceDry > 0.5 || surf.a < 0.0005) {
    surf.a = 0.0;
  }

  if (surf.r < 0.0002 && pig.a < 0.0005 && surf.a < 0.0005) {
    surf = vec4(0.0);
    pig = vec4(0.0);
  }

  outSurf = surf;
  outSurfPig = pig;
}`;

// Wet-mobilized advection & capillary Xuan fiber diffusion of underlying parent layer paint (`ppBaseBg`)
const BASE_STEP_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_baseBg;
uniform sampler2D u_surf;
uniform sampler2D u_vel;
uniform sampler2D u_pore;
uniform sampler2D u_sub;

uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_glueVisc;
uniform int u_alphaLock;

in vec2 v_uv;
out vec4 outBaseBg;

void main() {
  vec4 base = texture(u_baseBg, v_uv);
  vec4 surfData = texture(u_surf, v_uv);
  vec4 poreData = texture(u_pore, v_uv);
  float w = surfData.r + poreData.r * 0.75;
  float solv = clamp(surfData.a + poreData.b, 0.0, 12.0);
  if (w <= 0.015) {
    if (solv > 0.0005 && u_alphaLock == 0) {
      base *= exp(-solv * 2.8);
      if (base.a < 0.004) base = vec4(0.0);
    }
    outBaseBg = base;
    return;
  }

  // Scale baseBg advection (bending) and capillary bleed by surf.b affection
  float aff = clamp(surfData.b, 0.0, 1.0);
  if (aff <= 0.004) {
    if (solv > 0.0005 && u_alphaLock == 0) {
      base *= exp(-solv * 2.8);
      if (base.a < 0.004) base = vec4(0.0);
    }
    outBaseBg = base;
    return;
  }
  float bendT = clamp((aff - 0.15) / 0.85, 0.0, 1.0);
  float bendSmooth = bendT * bendT * (3.0 - 2.0 * bendT);
  float bendScale = pow(bendSmooth, 1.4);
  float bleedScale = pow(aff, 1.20);

  float wetMob = smoothstep(0.015, 0.24, w);
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 backUv = clamp(v_uv - vel * u_texel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec4 advBase = texture(u_baseBg, backUv);
  float advSurf = texture(u_surf, backUv).r + texture(u_pore, backUv).r * 0.75;
  float advMob = smoothstep(0.010, 0.18, advSurf);
  float advW = clamp(length(vel) * 0.020 * wetMob * advMob, 0.0, 0.52) * bendScale;
  vec4 res = mix(base, advBase, advW);

  // Capillary diffusion along Xuan paper pores when wetted
  float perm = texture(u_sub, v_uv).y;

  vec2 uvL = clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvR = clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvB = clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw);
  vec2 uvT = clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw);

  float wL = smoothstep(0.012, 0.20, texture(u_surf, uvL).r + texture(u_pore, uvL).r * 0.75);
  float wR = smoothstep(0.012, 0.20, texture(u_surf, uvR).r + texture(u_pore, uvR).r * 0.75);
  float wB = smoothstep(0.012, 0.20, texture(u_surf, uvB).r + texture(u_pore, uvB).r * 0.75);
  float wT = smoothstep(0.012, 0.20, texture(u_surf, uvT).r + texture(u_pore, uvT).r * 0.75);
  float wSum = wL + wR + wB + wT;
  if (wSum > 0.001) {
    vec4 bAvg = (
      texture(u_baseBg, uvL) * wL +
      texture(u_baseBg, uvR) * wR +
      texture(u_baseBg, uvB) * wB +
      texture(u_baseBg, uvT) * wT
    ) / wSum;
    float diffRate = clamp(wetMob * (0.025 + 0.095 * perm) * (1.0 - u_glueVisc * 0.35), 0.0, 0.16) * bleedScale;
    res = mix(res, bAvg, diffRate);
  }

  if (u_alphaLock == 1) {
    if (base.a <= 0.002) {
      res = vec4(0.0);
    } else {
      vec3 straight = res.a > 0.002 ? clamp(res.rgb / res.a, 0.0, 1.0) : (base.rgb / base.a);
      res = vec4(clamp(straight * base.a, 0.0, base.a), base.a);
    }
  } else if (solv > 0.0005) {
    res *= exp(-solv * 2.8);
    if (res.a < 0.004) res = vec4(0.0);
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
uniform sampler2D u_sub;

uniform float u_seepRate;
uniform float u_sootSnag;
uniform float u_maxWater;
uniform float u_dt;
uniform float u_forceDry;

in vec2 v_uv;

layout(location = 0) out vec4 outSurf;
layout(location = 1) out vec4 outSurfPig;
layout(location = 2) out vec4 outPore;
layout(location = 3) out vec4 outPorePig;

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
    pore.r = min(2.5, pore.r + surf.r);
    pore.b = 0.0;
    addWeightedPig(porePig, surfPig.rgb, surfPig.a);
    outSurf = vec4(0.0);
    outSurfPig = vec4(0.0);
    outPore = pore;
    outPorePig = porePig;
    return;
  }

  vec4 sub = texture(u_sub, v_uv);
  float perm = sub.y;
  float sootBlock = sub.z;

  float maxPoreCap = clamp(u_maxWater * 0.92, 0.15, 2.50);
  float poreCap = max(0.0, maxPoreCap - pore.r);
  float seepWater = min(surf.r, surf.r * (0.35 + 0.85 * perm) * u_seepRate * u_dt * (0.45 + poreCap) * 2.6);

  if (surf.r > 0.0001) {
    float seepRatio = clamp(seepWater / surf.r, 0.0, 1.0);
    surf.r -= seepWater;
    float snagResist = clamp(u_sootSnag * sootBlock * 0.42, 0.0, 0.72);
    float fineShare = seepRatio * 0.92 * (1.0 - snagResist);
    float moveToPore = min(surfPig.a, surfPig.a * fineShare);
    pore.r = clamp(pore.r + seepWater, 0.0, maxPoreCap);
    pore.g = clamp(pore.g + surf.g * seepRatio * 0.92, 0.0, 2.0);
    float moveSolv = min(surf.a, surf.a * seepRatio * 0.85);
    pore.b = clamp(pore.b + moveSolv, 0.0, 6.0);
    surf.a = max(0.0, surf.a - moveSolv);
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
uniform sampler2D u_sub;

uniform float u_capillarity;
uniform float u_evapRate;
uniform float u_backrunRim;
uniform float u_maxWater;
uniform float u_sootSnag;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_forceDry;

in vec2 v_uv;

layout(location = 0) out vec4 outSurfPig;
layout(location = 1) out vec4 outPore;
layout(location = 2) out vec4 outPorePig;
layout(location = 3) out vec4 outDryPig;

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

  vec4 mySub = texture(u_sub, v_uv);
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

  // 8-neighbor anisotropic Darcy capillary wicking stencil (0.20 cardinal, 0.05 diagonal)
  const vec2 OFFSETS[8] = vec2[8](
    vec2(-1.0,  0.0), vec2( 1.0,  0.0), vec2( 0.0, -1.0), vec2( 0.0,  1.0),
    vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0), vec2( 1.0,  1.0)
  );
  const float WEIGHTS[8] = float[8](
    0.20, 0.20, 0.20, 0.20,
    0.05, 0.05, 0.05, 0.05
  );

  float waterDelta = 0.0;
  float solvDelta = 0.0;
  float mySootMobility = clamp((1.0 - myBlock * u_sootSnag) * (1.0 - pore.g * 0.18), 0.04, 0.88);
  float pigOutMass = 0.0;
  vec4 pigInAccum = vec4(0.0);
  float rimFrontFlux = 0.0;

  for (int i = 0; i < 8; i++) {
    vec2 nUV = clamp(v_uv + OFFSETS[i] * u_texel, u_uvClamp.xy, u_uvClamp.zw);
    vec4 nPore = texture(u_pore, nUV);
    vec4 nPig = texture(u_porePig, nUV);
    vec4 nSub = texture(u_sub, nUV);

    float linkPerm = min(myPerm, nSub.y);
    float fiberBias = 1.0 - abs(myH - nSub.r) * 0.65;
    float cond = WEIGHTS[i] * u_capillarity * linkPerm * fiberBias;

    // Smooth continuous capillary transition eliminates hard concentric stepping contours
    if (nPore.r > pore.r) {
      float wIn = (nPore.r - pore.r) * cond * smoothstep(0.003, 0.075, nPore.r);
      waterDelta += wIn;
      float nMob = clamp((1.0 - nSub.z * u_sootSnag) * (1.0 - nPore.g * 0.18), 0.04, 0.88);
      float wRatio = clamp(wIn / max(nPore.r, 0.001), 0.0, 0.65);
      // Wetting front carries extra soot outward to form authentic dark pigment rim
      float rimCarry = mix(1.0, 1.55, u_backrunRim * (1.0 - smoothstep(0.002, 0.09, pore.r)));
      float pigRatio = clamp(wRatio * nMob * rimCarry, 0.0, 0.72);
      addPig(pigInAccum, nPig.rgb, nPig.a * pigRatio);
      solvDelta += nPore.b * wRatio;
      rimFrontFlux += wIn;
    } else if (pore.r > nPore.r) {
      float wOut = (pore.r - nPore.r) * cond * smoothstep(0.003, 0.075, pore.r);
      waterDelta -= wOut;
      float wRatio = clamp(wOut / max(pore.r, 0.001), 0.0, 0.65);
      float rimCarry = mix(1.0, 1.55, u_backrunRim * (1.0 - smoothstep(0.002, 0.09, nPore.r)));
      float pigRatio = clamp(wRatio * mySootMobility * rimCarry, 0.0, 0.72);
      pigOutMass += porePig.a * pigRatio;
      solvDelta -= pore.b * wRatio;
    }
  }

  float maxPoreCap = clamp(u_maxWater * 0.92, 0.15, 2.50);
  pore.r = clamp(pore.r + waterDelta, 0.0, maxPoreCap);
  pore.b = clamp(pore.b + solvDelta, 0.0, 6.0);
  porePig.a = max(0.0, porePig.a - pigOutMass);
  addPig(porePig, pigInAccum.rgb, pigInAccum.a);

  // Evaporation inside pores & water-triggered fixation of soot granules onto Xuan fibers (Layer 4)
  float evap = u_evapRate * 0.36 * u_dt;
  float prevWater = pore.r;
  pore.r = max(0.0, pore.r - evap);
  pore.g = max(0.0, pore.g - evap * 0.5);

  if (prevWater > 0.0001) {
    float dryFraction = clamp(evap / max(prevWater, 0.02), 0.0, 1.0);
    float lowWaterLock = smoothstep(0.09, 0.004, pore.r);
    // Anchor pigment edge halo as wetting front slows against dry fibers
    float edgeLock = lowWaterLock * (0.20 + 0.32 * u_backrunRim * smoothstep(0.001, 0.02, rimFrontFlux));
    float fixRate = clamp(max(dryFraction * 0.85, edgeLock), 0.0, 1.0);
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

  // Dissolve fixed and capillary soot where erasing ink (surf.a + pore.b) touches
  float solv = surf.a * 0.85 + pore.b;
  if (solv > 0.0005) {
    float keep = exp(-solv * 3.2);
    porePig.a *= keep;
    dryPig.a *= keep;
    if (porePig.a < 0.0008) porePig = vec4(0.0);
    if (dryPig.a < 0.0008) dryPig = vec4(0.0);
  }
  pore.b *= mix(0.25, 0.72, smoothstep(0.03, 0.28, pore.r));
  if (pore.b < 0.0005) pore.b = 0.0;

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
uniform sampler2D u_sub;

uniform float u_inkWarmth;
uniform int u_alphaLock;

in vec2 v_uv;
out vec4 outColor;

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

  // Optical density is locked so changing Ink Concentration never retroactively alters existing strokes
  float inkDensity = 1.781;
  vec3 K_dry = layerK(dryPig, warmShift) * 2.35 * inkDensity;
  vec3 K_wet = (layerK(porePig, warmShift) * 2.15 + layerK(surfPig, warmShift) * 1.85) * inkDensity;
  vec3 K_total = K_dry + K_wet;

  // Modulate effective K slightly by pre-baked Xuan fiber tooth for natural soot granulation
  float tooth = texture(u_sub, v_uv).a;
  float toothKMod = 1.0 + (0.5 - tooth) * 0.16;
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

// Lightweight 3x3 workbox frontier water probe (36 bytes readback) for organic progressive tile expansion
const EDGE_PROBE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_pore;
uniform vec4 u_innerUv; // (u0, v0, u1, v1)
uniform vec2 u_bandUv;  // (bandU, bandV)

out vec4 outProbe;

void main() {
  ivec2 c = ivec2(floor(gl_FragCoord.xy));
  float u0 = u_innerUv.x;
  float v0 = u_innerUv.y;
  float u1 = u_innerUv.z;
  float v1 = u_innerUv.w;
  float bu = min(u_bandUv.x, max(0.001, (u1 - u0) * 0.45));
  float bv = min(u_bandUv.y, max(0.001, (v1 - v0) * 0.45));

  float su0;
  float su1;
  float sv0;
  float sv1;

  if (c.x == 0) {
    su0 = u0;
    su1 = u0 + bu;
  } else if (c.x == 2) {
    su0 = u1 - bu;
    su1 = u1;
  } else {
    su0 = (c.y == 1) ? u0 : mix(u0, u1, 0.06);
    su1 = (c.y == 1) ? u1 : mix(u0, u1, 0.94);
  }

  if (c.y == 0) {
    sv0 = v0;
    sv1 = v0 + bv;
  } else if (c.y == 2) {
    sv0 = v1 - bv;
    sv1 = v1;
  } else {
    sv0 = (c.x == 1) ? v0 : mix(v0, v1, 0.06);
    sv1 = (c.x == 1) ? v1 : mix(v0, v1, 0.94);
  }

  float maxW = 0.0;
  float maxSurf = 0.0;
  for (int iy = 0; iy < 4; iy++) {
    float fy = (float(iy) + 0.5) * 0.25;
    float v = mix(sv0, sv1, fy);
    for (int ix = 0; ix < 4; ix++) {
      float fx = (float(ix) + 0.5) * 0.25;
      vec2 uv = vec2(mix(su0, su1, fx), v);
      float s = texture(u_surf, uv).r;
      float p = texture(u_pore, uv).r;
      maxSurf = max(maxSurf, s);
      maxW = max(maxW, s + p);
    }
  }
  outProbe = vec4(clamp(maxW / 0.5, 0.0, 1.0), clamp(maxSurf / 0.5, 0.0, 1.0), 0.0, 1.0);
}`;

// Compact RGBA8 archival packing for fixed fiber soot (dryPig RGBA16F -> RGBA8)
const PACK_DRY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_dryPig;
in vec2 v_uv;
out vec4 outPacked;
void main() {
  vec4 d = texture(u_dryPig, v_uv);
  if (d.a <= 0.0002) {
    outPacked = vec4(0.0);
    return;
  }
  float mNorm = clamp(sqrt(clamp(d.a, 0.0, 8.0) / 8.0), 0.0, 1.0);
  outPacked = vec4(clamp(d.rgb, 0.0, 1.0), max(mNorm, 1.0 / 255.0));
}`;

const UNPACK_DRY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_packedDry;
in vec2 v_uv;
out vec4 outDryPig;
void main() {
  vec4 p = texture(u_packedDry, v_uv);
  if (p.a <= 0.001) {
    outDryPig = vec4(0.0);
    return;
  }
  float mass = (p.a * p.a) * 8.0;
  outDryPig = vec4(clamp(p.rgb, 0.0, 1.0), mass);
}`;

// Reconcile passive fiber archive if user edited/erased the layer with another tool while away from Sumi-e
const RECONCILE_PASSIVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_curLayer;
uniform sampler2D u_savedComp;
uniform sampler2D u_savedBase;
uniform sampler2D u_savedDry;
uniform int u_hasSavedBase;

in vec2 v_uv;

layout(location = 0) out vec4 outBaseBg;
layout(location = 1) out vec4 outDryPig;

void main() {
  vec4 cur = texture(u_curLayer, v_uv);
  vec4 sComp = texture(u_savedComp, v_uv);
  vec4 sBase = u_hasSavedBase == 1 ? texture(u_savedBase, v_uv) : vec4(0.0);
  vec4 sDry = texture(u_savedDry, v_uv);

  if (cur.a <= 0.002) {
    outBaseBg = vec4(0.0);
    outDryPig = vec4(0.0);
    return;
  }
  if (sDry.a <= 0.0002) {
    outBaseBg = cur;
    outDryPig = vec4(0.0);
    return;
  }

  float diff = length(cur.rgb - sComp.rgb) + abs(cur.a - sComp.a);
  if (diff < 0.035) {
    outBaseBg = sBase;
    outDryPig = sDry;
    return;
  }
  if (cur.a < sComp.a - 0.01) {
    float keep = clamp(cur.a / max(sComp.a, 0.002), 0.0, 1.0);
    outBaseBg = sBase * keep;
    outDryPig = vec4(sDry.rgb, sDry.a * keep);
    return;
  }

  float bury = smoothstep(0.04, 0.35, diff);
  outBaseBg = cur;
  outDryPig = vec4(sDry.rgb, sDry.a * (1.0 - bury));
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
    this._passiveTick = 0;
    this._probeTick = 0;
    this._activeWetCount = 0;
    this._hasCpuDirty = false;
    this._needsDryOnClose = false;
    this.lastParams = {};

    this.activeTiles = new Map();
    this.passiveTiles = new Map();
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
    this._packBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._basePackBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._probeBuf = new Uint8Array(36);
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
    this.progSubBake = this._compileProg(QUAD_VS, SUB_BAKE_FRAG, 'subBake');
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
    this.progEdgeProbe = this._compileProg(QUAD_VS, EDGE_PROBE_FRAG, 'edgeProbe');
    this.progPackDry = this._compileProg(QUAD_VS, PACK_DRY_FRAG, 'packDry');
    this.progUnpackDry = this._compileProg(QUAD_VS, UNPACK_DRY_FRAG, 'unpackDry');
    this.progReconcile = this._compileProg(QUAD_VS, RECONCILE_PASSIVE_FRAG, 'reconcile');

    if (
      !this.progRectMap || !this.progUnpremult || !this.progSubBake || !this.progBristle ||
      !this.progRewet || !this.progBrushApply || !this.progVelAdvect ||
      !this.progDiv || !this.progPress || !this.progGradSub ||
      !this.progSurfStep || !this.progBaseStep || !this.progSurfSeep ||
      !this.progPerc || !this.progComp || !this.progEdgeProbe ||
      !this.progPackDry || !this.progUnpackDry || !this.progReconcile
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

    this.texSub = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.texDiv = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.texStamp = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.texOutput = this._makeTexFBO(WORK_RES, WORK_RES, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.texTileUnpremult = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texUploadDry = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texUploadBase = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texTileBaseTmp = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texTileDryTmp = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.texProbe = this._makeTexFBO(3, 3, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);

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
    this.locSubBake = u(this.progSubBake, [
      'u_surfaceMap', 'u_poreMap',
      'u_hasSurface', 'u_useHeightmap', 'u_heightSource', 'u_surfaceInvScale',
      'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_sizing', 'u_coarseness', 'u_workOrigin'
    ]);
    this.locBristle = u(this.progBristle, ['u_invWorkRes']);
    this.locRewet = u(this.progRewet, [
      'u_stamp', 'u_surfPig', 'u_dryPig', 'u_waterCharge', 'u_sizing', 'u_inkAffection'
    ]);
    this.locApply = u(this.progBrushApply, [
      'u_stamp', 'u_surf', 'u_surfPig', 'u_vel', 'u_strokeCov', 'u_sub',
      'u_surfSlip', 'u_mode', 'u_brushVel', 'u_pressure', 'u_inkConcentration',
      'u_inkAffection', 'u_waterCharge', 'u_maxWater', 'u_glueVisc',
      'u_pigmentK', 'u_physicalMix', 'u_strokeId'
    ]);
    this.locVelAdv = u(this.progVelAdvect, [
      'u_vel', 'u_surf', 'u_sub', 'u_surfaceMap', 'u_baseBg',
      'u_hasSurface', 'u_useHeightmap', 'u_heightSource', 'u_surfaceInvScale',
      'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_surfSlip', 'u_surfChannel', 'u_texel', 'u_uvClamp', 'u_workOrigin', 'u_dt', 'u_glueVisc', 'u_turb', 'u_time'
    ]);
    this.locDiv = u(this.progDiv, ['u_vel', 'u_texel', 'u_uvClamp']);
    this.locPress = u(this.progPress, ['u_press', 'u_div', 'u_texel', 'u_uvClamp']);
    this.locGradSub = u(this.progGradSub, ['u_press', 'u_vel', 'u_texel', 'u_uvClamp']);
    this.locSurfStep = u(this.progSurfStep, [
      'u_surf', 'u_surfPig', 'u_vel', 'u_texel', 'u_uvClamp',
      'u_dt', 'u_backrunRim', 'u_evapRate', 'u_maxWater', 'u_forceDry'
    ]);
    this.locBaseStep = u(this.progBaseStep, [
      'u_baseBg', 'u_surf', 'u_vel', 'u_pore', 'u_sub',
      'u_texel', 'u_uvClamp', 'u_dt', 'u_glueVisc', 'u_alphaLock'
    ]);
    this.locSurfSeep = u(this.progSurfSeep, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_sub',
      'u_seepRate', 'u_sootSnag', 'u_maxWater', 'u_dt', 'u_forceDry'
    ]);
    this.locPerc = u(this.progPerc, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_sub',
      'u_capillarity', 'u_evapRate', 'u_backrunRim', 'u_maxWater', 'u_sootSnag',
      'u_texel', 'u_uvClamp', 'u_dt', 'u_forceDry'
    ]);
    this.locComp = u(this.progComp, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_baseBg', 'u_sub',
      'u_inkWarmth', 'u_alphaLock'
    ]);
    this.locEdgeProbe = u(this.progEdgeProbe, ['u_surf', 'u_pore', 'u_innerUv', 'u_bandUv']);
    this.locPackDry = u(this.progPackDry, ['u_dryPig']);
    this.locUnpackDry = u(this.progUnpackDry, ['u_packedDry']);
    this.locReconcile = u(this.progReconcile, [
      'u_curLayer', 'u_savedComp', 'u_savedBase', 'u_savedDry', 'u_hasSavedBase'
    ]);

    this._pipelinesWarmed = false;
    this.ready = true;
  }

  prewarmPipelines(engine = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;
    if (this._pipelinesWarmed) return;

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, WORK_RES, WORK_RES);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // Warm full-screen quad shaders with tiny 4x4 scissored draws
    const warmQuad = (prog, targetFbo, setupFn) => {
      if (!prog || !targetFbo) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.useProgram(prog);
      if (setupFn) setupFn();
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const dummy = this.dummyTex;
    const bindTex = (unit, loc, tex) => {
      if (loc === null || loc === undefined) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || dummy);
      gl.uniform1i(loc, unit);
    };

    warmQuad(this.progRectMap, this.texOutput.fbo, () => {
      gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, 64, 64);
      gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, 64, 64);
      gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
      bindTex(0, this.locRectMap.u_tex, dummy);
    });
    warmQuad(this.progUnpremult, this.texTileUnpremult.fbo, () => {
      bindTex(0, this.locUnpremult.u_tex, dummy);
    });
    warmQuad(this.progSubBake, this.texSub.fbo, () => {
      bindTex(0, this.locSubBake.u_surfaceMap, dummy);
      bindTex(1, this.locSubBake.u_poreMap, dummy);
      gl.uniform1i(this.locSubBake.u_hasSurface, 0);
      gl.uniform1i(this.locSubBake.u_useHeightmap, 0);
      gl.uniform1i(this.locSubBake.u_heightSource, 0);
      gl.uniform1f(this.locSubBake.u_surfaceInvScale, 1.0 / 320.0);
      gl.uniform1f(this.locSubBake.u_surfaceBiomeMix, 0.88);
      gl.uniform1f(this.locSubBake.u_surfaceAllowRotate, 1.0);
      gl.uniform1f(this.locSubBake.u_surfaceScaleSpread, 1.0);
      gl.uniform1f(this.locSubBake.u_sizing, 0.5);
      gl.uniform1f(this.locSubBake.u_coarseness, 0.25);
      gl.uniform2f(this.locSubBake.u_workOrigin, 0, 0);
    });
    warmQuad(this.progRewet, this.ppSurfPig.b.fbo, () => {
      bindTex(0, this.locRewet.u_stamp, this.texStamp.tex);
      bindTex(1, this.locRewet.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locRewet.u_dryPig, this.ppDryPig.a.tex);
      gl.uniform1f(this.locRewet.u_waterCharge, 0.5);
      gl.uniform1f(this.locRewet.u_sizing, 0.5);
      gl.uniform1f(this.locRewet.u_inkAffection, 0.5);
    });
    warmQuad(this.progBrushApply, this.ppSurf.b.fbo, () => {
      bindTex(0, this.locApply.u_stamp, this.texStamp.tex);
      bindTex(1, this.locApply.u_surf, this.ppSurf.a.tex);
      bindTex(2, this.locApply.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(3, this.locApply.u_vel, this.ppVel.a.tex);
      bindTex(4, this.locApply.u_strokeCov, this.ppStrokeCov.a.tex);
      bindTex(5, this.locApply.u_sub, this.texSub.tex);
    });
    warmQuad(this.progVelAdvect, this.ppVel.b.fbo, () => {
      bindTex(0, this.locVelAdv.u_vel, this.ppVel.a.tex);
      bindTex(1, this.locVelAdv.u_surf, this.ppSurf.a.tex);
      bindTex(2, this.locVelAdv.u_sub, this.texSub.tex);
      bindTex(3, this.locVelAdv.u_surfaceMap, dummy);
      bindTex(4, this.locVelAdv.u_baseBg, this.ppBaseBg.a.tex);
    });
    warmQuad(this.progDiv, this.texDiv.fbo, () => {
      bindTex(0, this.locDiv.u_vel, this.ppVel.a.tex);
    });
    warmQuad(this.progPress, this.ppPress.b.fbo, () => {
      bindTex(0, this.locPress.u_press, this.ppPress.a.tex);
      bindTex(1, this.locPress.u_div, this.texDiv.tex);
    });
    warmQuad(this.progGradSub, this.ppVel.b.fbo, () => {
      bindTex(0, this.locGradSub.u_press, this.ppPress.a.tex);
      bindTex(1, this.locGradSub.u_vel, this.ppVel.a.tex);
    });
    warmQuad(this.progSurfStep, this.ppSurf.b.fbo, () => {
      bindTex(0, this.locSurfStep.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locSurfStep.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locSurfStep.u_vel, this.ppVel.a.tex);
    });
    warmQuad(this.progBaseStep, this.ppBaseBg.b.fbo, () => {
      bindTex(0, this.locBaseStep.u_baseBg, this.ppBaseBg.a.tex);
      bindTex(1, this.locBaseStep.u_surf, this.ppSurf.a.tex);
      bindTex(2, this.locBaseStep.u_vel, this.ppVel.a.tex);
      bindTex(3, this.locBaseStep.u_pore, this.ppPore.a.tex);
      bindTex(4, this.locBaseStep.u_sub, this.texSub.tex);
    });
    warmQuad(this.progSurfSeep, this.ppSurf.b.fbo, () => {
      bindTex(0, this.locSurfSeep.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locSurfSeep.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locSurfSeep.u_pore, this.ppPore.a.tex);
      bindTex(3, this.locSurfSeep.u_porePig, this.ppPorePig.a.tex);
      bindTex(4, this.locSurfSeep.u_sub, this.texSub.tex);
    });
    warmQuad(this.progPerc, this.ppPore.b.fbo, () => {
      bindTex(0, this.locPerc.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locPerc.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locPerc.u_pore, this.ppPore.a.tex);
      bindTex(3, this.locPerc.u_porePig, this.ppPorePig.a.tex);
      bindTex(4, this.locPerc.u_dryPig, this.ppDryPig.a.tex);
      bindTex(5, this.locPerc.u_sub, this.texSub.tex);
    });
    warmQuad(this.progComp, this.texOutput.fbo, () => {
      bindTex(0, this.locComp.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locComp.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locComp.u_pore, this.ppPore.a.tex);
      bindTex(3, this.locComp.u_porePig, this.ppPorePig.a.tex);
      bindTex(4, this.locComp.u_dryPig, this.ppDryPig.a.tex);
      bindTex(5, this.locComp.u_baseBg, this.ppBaseBg.a.tex);
      bindTex(6, this.locComp.u_sub, this.texSub.tex);
    });
    warmQuad(this.progEdgeProbe, this.texProbe.fbo, () => {
      bindTex(0, this.locEdgeProbe.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locEdgeProbe.u_pore, this.ppPore.a.tex);
      gl.uniform4f(this.locEdgeProbe.u_innerUv, 0, 0, 0.25, 0.25);
      gl.uniform2f(this.locEdgeProbe.u_bandUv, 28 / WORK_RES, 28 / WORK_RES);
    });
    warmQuad(this.progPackDry, this.texTileUnpremult.fbo, () => {
      bindTex(0, this.locPackDry.u_dryPig, this.texTileDryTmp.tex);
    });
    warmQuad(this.progUnpackDry, this.texTileDryTmp.fbo, () => {
      bindTex(0, this.locUnpackDry.u_packedDry, this.texUploadDry.tex);
    });
    warmQuad(this.progReconcile, this.texTileBaseTmp.fbo, () => {
      bindTex(0, this.locReconcile.u_curLayer, this.texUploadBase.tex);
      bindTex(1, this.locReconcile.u_savedComp, this.texTileUnpremult.tex);
      bindTex(2, this.locReconcile.u_savedBase, this.texUploadBase.tex);
      bindTex(3, this.locReconcile.u_savedDry, this.texTileDryTmp.tex);
      gl.uniform1i(this.locReconcile.u_hasSavedBase, 0);
    });

    // Warm instanced bristle program
    if (this.progBristle && this.bristleVao) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.texStamp.fbo);
      gl.useProgram(this.progBristle);
      gl.uniform2f(this.locBristle.u_invWorkRes, 1.0 / WORK_RES, 1.0 / WORK_RES);
      gl.bindVertexArray(this.bristleVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      gl.bindVertexArray(this.gpuRenderer.vao);
    }

    // Ensure at least 2 warm pooled tiles exist
    while (this.tilePool.length < 2 && this.activeTiles.size === 0) {
      this.tilePool.push(this._allocTileGpu());
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    if (!prevScissor) gl.disable(gl.SCISSOR_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._pipelinesWarmed = true;
  }

  _allocTileGpu() {
    const gl = this.gl;
    const f = this._floatFilter || gl.LINEAR;
    const baseBg = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const sub = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const surf = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const surfPig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const pore = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const porePig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const dryPig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const vel = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const strokeCov = this._makeTexFBO(TILE_SIZE, TILE_SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    return {
      baseBg, sub, surf, surfPig, pore, porePig, dryPig, vel, strokeCov,
      tx: 0, ty: 0, wx: 0, wy: 0,
      subKey: '',
      cpuDirty: false, dirty: false,
      loadedFromPassive: false,
      minX: TILE_SIZE, minY: TILE_SIZE, maxX: 0, maxY: 0,
      wMinX: TILE_SIZE, wMinY: TILE_SIZE, wMaxX: 0, wMaxY: 0,
      genDepth: 0,
      wetTicks: 0,
      lastUsed: 0
    };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    for (const o of [t.baseBg, t.sub, t.surf, t.surfPig, t.pore, t.porePig, t.dryPig, t.vel, t.strokeCov]) {
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
        tile.loadedFromPassive = false;
        tile.wetTicks = 0;
        tile.genDepth = 0;
        tile.minX = TILE_SIZE;
        tile.minY = TILE_SIZE;
        tile.maxX = 0;
        tile.maxY = 0;
        tile.wMinX = TILE_SIZE;
        tile.wMinY = TILE_SIZE;
        tile.wMaxX = 0;
        tile.wMaxY = 0;
        this.tilePool.push(tile);
      } else {
        this._destroyTileGpu(tile);
      }
    });
    this.activeTiles.clear();
    this._hasCpuDirty = false;
    this._activeWetCount = 0;
  }

  _getPassiveKey(projId, layer, tx, ty) {
    return `${projId || 'default'}|${layer}|${tx},${ty}`;
  }

  _trimPassiveArchive() {
    while (this.passiveTiles.size > MAX_PASSIVE_TILES) {
      let oldestKey = null;
      let oldestTick = Infinity;
      this.passiveTiles.forEach((entry, k) => {
        if (entry.lastUsed < oldestTick) {
          oldestTick = entry.lastUsed;
          oldestKey = k;
        }
      });
      if (!oldestKey) break;
      this.passiveTiles.delete(oldestKey);
    }
  }

  clearPassiveArchive(projId = null, layer = null) {
    if (this.passiveTiles.size === 0) return;
    if (projId === null && layer === null) {
      this.passiveTiles.clear();
      return;
    }
    for (const [k, entry] of this.passiveTiles.entries()) {
      if (projId !== null && entry.projId !== projId) continue;
      if (layer !== null && entry.layer !== layer) continue;
      this.passiveTiles.delete(k);
    }
  }

  _archiveSingleTile(engine, tile, params = {}) {
    if (!tile || !engine || (!tile.dirty && !tile.loadedFromPassive)) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const key = this._getPassiveKey(projId, layer, tile.tx, tile.ty);

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);

    // Pack fixed dryPig (RGBA16F) into compact RGBA8 for lightweight passive storage
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.dryPig.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.readPixels(0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this._packBuf);
    let hasDry = false;
    for (let i = 3; i < this._packBuf.length; i += 4) {
      if (this._packBuf[i] > 0) {
        hasDry = true;
        break;
      }
    }
    if (!hasDry) {
      this.passiveTiles.delete(key);
      return;
    }

    const dryPigBytes = new Uint8Array(this._packBuf);

    // Also snapshot underlying non-Sumi underpaint (`baseBg`) only if non-empty
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
    gl.readPixels(0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this._basePackBuf);
    let hasBase = false;
    for (let i = 3; i < this._basePackBuf.length; i += 4) {
      if (this._basePackBuf[i] > 2) {
        hasBase = true;
        break;
      }
    }
    const baseBgBytes = hasBase ? new Uint8Array(this._basePackBuf) : null;

    const chunkRevs = [];
    const sCX = engine.isStatic ? 0 : Math.floor(tile.wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((tile.wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(tile.wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((tile.wy + TILE_SIZE - 1) / engine.chunkSize);
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const id = engine.isStatic ? '0,0' : `${cx},${cy}`;
        const ch = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(id);
        chunkRevs.push([id, ch && ch.nonSumiRev ? (ch.nonSumiRev[layer] || 0) : 0]);
      }
    }

    this.passiveTiles.set(key, {
      key,
      projId,
      layer,
      tx: tile.tx,
      ty: tile.ty,
      dryPigBytes,
      baseBgBytes,
      warmth: params?.warmth ?? this.lastParams?.warmth ?? 12,
      chunkRevs,
      lastUsed: ++this._passiveTick
    });
    this._trimPassiveArchive();
  }

  _archiveActiveTiles(engine, params = {}) {
    if (!engine || this.activeTiles.size === 0) return;
    this.activeTiles.forEach((tile) => {
      if (tile.dirty || tile.loadedFromPassive) {
        this._archiveSingleTile(engine, tile, params);
      }
    });
  }

  _revsMatchPassive(engine, layer, passive) {
    if (!engine || !passive || !passive.chunkRevs) return false;
    for (let i = 0; i < passive.chunkRevs.length; i++) {
      const [id, savedRev] = passive.chunkRevs[i];
      const ch = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(id);
      const curRev = ch && ch.nonSumiRev ? (ch.nonSumiRev[layer] || 0) : 0;
      if (curRev !== savedRev) return false;
    }
    return true;
  }

  _hydrateTileFromPassive(engine, tile, passive, layer, hasAnyChunkPixels) {
    const gl = this.gl;
    if (!hasAnyChunkPixels) {
      this.passiveTiles.delete(passive.key);
      return false;
    }

    const revsMatch = this._revsMatchPassive(engine, layer, passive);
    passive.lastUsed = ++this._passiveTick;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindTexture(gl.TEXTURE_2D, this.texUploadDry.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, passive.dryPigBytes);

    if (revsMatch) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

      gl.bindFramebuffer(gl.FRAMEBUFFER, tile.dryPig.fbo);
      gl.useProgram(this.progUnpackDry);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texUploadDry.tex);
      gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (passive.baseBgBytes) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, tile.baseBg.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, passive.baseBgBytes);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      tile.loadedFromPassive = true;
      return true;
    }

    // Reconcile passive fiber archive against external non-Sumi layer edits (Eraser, Brush, Undo, etc.)
    if (passive.baseBgBytes) {
      gl.bindTexture(gl.TEXTURE_2D, this.texUploadBase.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, passive.baseBgBytes);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    // 1. Copy current chunk baseBg -> texTileBaseTmp
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileBaseTmp.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.baseBg.tex);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. Unpack passive dryPig -> texTileDryTmp
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileDryTmp.fbo);
    gl.useProgram(this.progUnpackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texUploadDry.tex);
    gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Reconstruct saved composite (`savedComp`) -> texTileUnpremult
    const activeParams = this.lastParams || {};
    this._bakeTileSubIfNeeded(engine, tile, activeParams);
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
    gl.useProgram(this.progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locComp.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locComp.u_surfPig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locComp.u_pore, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locComp.u_porePig, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
    gl.uniform1i(this.locComp.u_dryPig, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, passive.baseBgBytes ? this.texUploadBase.tex : this.dummyTex);
    gl.uniform1i(this.locComp.u_baseBg, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, tile.sub.tex);
    gl.uniform1i(this.locComp.u_sub, 6);
    gl.uniform1f(this.locComp.u_inkWarmth, (passive.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. Reconcile curLayer vs savedComp into tile.baseBg + tile.dryPig (2 MRT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tile.baseBg.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, tile.dryPig.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    gl.useProgram(this.progReconcile);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texTileBaseTmp.tex);
    gl.uniform1i(this.locReconcile.u_curLayer, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTileUnpremult.tex);
    gl.uniform1i(this.locReconcile.u_savedComp, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, passive.baseBgBytes ? this.texUploadBase.tex : this.dummyTex);
    gl.uniform1i(this.locReconcile.u_savedBase, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
    gl.uniform1i(this.locReconcile.u_savedDry, 3);
    gl.uniform1i(this.locReconcile.u_hasSavedBase, passive.baseBgBytes ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    tile.loadedFromPassive = true;
    return true;
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
    if (engine && (oldest.dirty || oldest.loadedFromPassive)) {
      this._archiveSingleTile(engine, oldest, this.lastParams || {});
    }
    this.activeTiles.delete(`${oldest.tx},${oldest.ty}`);
    oldest.cpuDirty = false;
    oldest.dirty = false;
    oldest.loadedFromPassive = false;
    oldest.wetTicks = 0;
    oldest.genDepth = 0;
    oldest.minX = TILE_SIZE;
    oldest.minY = TILE_SIZE;
    oldest.maxX = 0;
    oldest.maxY = 0;
    oldest.wMinX = TILE_SIZE;
    oldest.wMinY = TILE_SIZE;
    oldest.wMaxX = 0;
    oldest.wMaxY = 0;
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
    const projId = this.projectId || engine.currentProjectId || 'default';
    const passiveKey = this._getPassiveKey(projId, layer, tx, ty);
    const passive = this.passiveTiles.get(passiveKey) || null;

    tile.tx = tx;
    tile.ty = ty;
    tile.wx = tx * TILE_SIZE;
    tile.wy = ty * TILE_SIZE;
    tile.subKey = '';
    tile.cpuDirty = false;
    tile.dirty = false;
    tile.loadedFromPassive = false;
    tile.minX = TILE_SIZE;
    tile.minY = TILE_SIZE;
    tile.maxX = 0;
    tile.maxY = 0;
    tile.wMinX = TILE_SIZE;
    tile.wMinY = TILE_SIZE;
    tile.wMaxX = 0;
    tile.wMaxY = 0;
    tile.genDepth = 0;
    tile.wetTicks = 0;
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

    let hasAnyChunkPixels = false;
    const sCX = engine.isStatic ? 0 : Math.floor(tile.wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((tile.wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(tile.wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((tile.wy + TILE_SIZE - 1) / engine.chunkSize);

    const exactPassiveHit = !!(passive && this._revsMatchPassive(engine, layer, passive));

    // Seed tile.baseBg from current parent layer chunks (skipped when exact passive snapshot matches)
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!exactPassiveHit) {
      gl.useProgram(this.progRectMap);
      gl.uniform4f(this.locRectMap.u_dstRect, tile.wx, tile.wy, TILE_SIZE, TILE_SIZE);
      gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
      gl.uniform1i(this.locRectMap.u_tex, 0);

      for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
          const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
          if (!chunk) continue;

          const isEmpty = chunk.isEmpty && chunk.isEmpty[layer] && (!chunk.gpuDirty || !chunk.gpuDirty[layer]);
          if (isEmpty && (!chunk.gpuTextures || !chunk.gpuTextures[layer])) continue;

          hasAnyChunkPixels = true;
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
    } else {
      for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
          const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(`${cx},${cy}`);
          if (!chunk) continue;
          const isEmpty = chunk.isEmpty && chunk.isEmpty[layer] && (!chunk.gpuDirty || !chunk.gpuDirty[layer]);
          if (!isEmpty || (chunk.gpuTextures && chunk.gpuTextures[layer])) {
            hasAnyChunkPixels = true;
            break;
          }
        }
        if (hasAnyChunkPixels) break;
      }
    }

    if (passive) {
      this._hydrateTileFromPassive(engine, tile, passive, layer, hasAnyChunkPixels);
    }

    this.activeTiles.set(key, tile);
    return tile;
  }

  _getSubCacheKey(engine, params) {
    const surfMgr = engine ? engine.surfaceManager : null;
    const sp = surfMgr ? surfMgr.getSumiPhysicsParams() : null;
    const ver = surfMgr ? (surfMgr.version || 0) : 0;
    const useH = params?.useHeightmap ? 1 : 0;
    const hSrc = params?.heightSource === 'layer' ? 1 : 0;
    if (!sp || !sp.active) return `0|${useH}|${hSrc}`;
    return `${ver}|1|${sp.invScale.toFixed(5)}|${sp.sizing.toFixed(3)}|${sp.coarseness.toFixed(3)}|${sp.biomeMix.toFixed(3)}|${sp.allowRotate}|${sp.scaleSpread}|${useH}|${hSrc}`;
  }

  _bakeTileSubIfNeeded(engine, tile, params, cacheKey = null) {
    const key = cacheKey || this._getSubCacheKey(engine, params);
    if (tile.subKey === key) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.sub.fbo);
    gl.useProgram(this.progSubBake);
    this._bindSurfaceUniforms(this.locSubBake, engine, params);
    gl.uniform2f(this.locSubBake.u_workOrigin, tile.wx, tile.wy);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    tile.subKey = key;
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH, params = null) {
    const gl = this.gl;
    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);
    const excludeBox = { x: workX, y: workY, w: boxW, h: boxH };

    const activeParams = params || this.lastParams || {};
    const subKey = this._getSubCacheKey(engine, activeParams);

    const tiles = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureTile(engine, tx, ty, excludeBox);
        if (t) {
          this._bakeTileSubIfNeeded(engine, t, activeParams, subKey);
          tiles.push(t);
        }
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
        [this.texSub.fbo, t.sub.tex],
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
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
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
        if (engine.isDrawing && !engine.currentStrokeDirtyChunks.has(id)) {
          backupChunkLayer(engine, chunk, id, { layer });
          engine._markDirty(id, layer, false, true);
          if (chunk.gpuDirty) chunk.gpuDirty[layer] = false;
        }
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
    let poreTex = null;
    if (hasSurface) {
      const texes = surfMgr.ensureGpuTextures(gl);
      mapTex = texes.mapTex;
      poreTex = texes.poreTex;
    }
    if (locs.u_surfaceMap) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, mapTex || this.dummyTex);
      gl.uniform1i(locs.u_surfaceMap, 6);
    }
    if (locs.u_poreMap) {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, poreTex || mapTex || this.dummyTex);
      gl.uniform1i(locs.u_poreMap, 7);
    }
    if (locs.u_hasSurface) gl.uniform1i(locs.u_hasSurface, (hasSurface && mapTex) ? 1 : 0);
    if (locs.u_useHeightmap) gl.uniform1i(locs.u_useHeightmap, params?.useHeightmap ? 1 : 0);
    if (locs.u_heightSource) gl.uniform1i(locs.u_heightSource, params?.heightSource === 'layer' ? 1 : 0);
    if (locs.u_surfaceInvScale) gl.uniform1f(locs.u_surfaceInvScale, sp ? sp.invScale : (1.0 / 340.0));
    if (locs.u_surfaceBiomeMix) gl.uniform1f(locs.u_surfaceBiomeMix, sp ? sp.biomeMix : 0.88);
    if (locs.u_surfaceAllowRotate) gl.uniform1f(locs.u_surfaceAllowRotate, sp ? sp.allowRotate : 1.0);
    if (locs.u_surfaceScaleSpread) gl.uniform1f(locs.u_surfaceScaleSpread, sp ? sp.scaleSpread : 1.0);
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

    const baseEvap = (params?.evaporation ?? 28) / 100;
    const spreadPressure = this._activeWetCount > 28 ? Math.min(1.0, (this._activeWetCount - 28) / 20) : 0.0;
    const evapRate = Math.min(1.8, baseEvap + spreadPressure * 0.16);
    const backrunRim = (params?.backrun ?? 68) / 100;
    const glueVisc = (params?.glue ?? 42) / 100;
    const maxWaterCap = Math.max(0.15, Math.min(2.90, ((params?.maxWater ?? 100) / 100) * 1.45));
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
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locVelAdv.u_sub, 5);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.ppBaseBg.read().tex);
    gl.uniform1i(this.locVelAdv.u_baseBg, 8);
    this._bindSurfaceUniforms(this.locVelAdv, engine, params);
    gl.uniform2f(this.locVelAdv.u_texel, texel, texel);
    gl.uniform4f(this.locVelAdv.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform2f(this.locVelAdv.u_workOrigin, workX, workY);
    gl.uniform1f(this.locVelAdv.u_dt, dt);
    gl.uniform1f(this.locVelAdv.u_glueVisc, glueVisc);
    const turbNorm = Math.max(0, Math.min(1, (params?.turbulence ?? 0) / 100));
    gl.uniform1f(this.locVelAdv.u_turb, Math.pow(turbNorm, 2.25) * 0.20);
    gl.uniform1f(this.locVelAdv.u_time, (performance.now() * 0.001) % 1000.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppVel.swap();

    // Scale Jacobi pressure projection passes dynamically as puddles settle
    const jacobiIters = forceDry ? 0 : (engine.isDrawing ? 8 : (this.simActiveFrames > 280 ? 5 : (this.simActiveFrames > 160 ? 3 : 0)));
    if (jacobiIters > 0) {
      // 2. Divergence
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.texDiv.fbo);
      gl.useProgram(this.progDiv);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ppVel.read().tex);
      gl.uniform1i(this.locDiv.u_vel, 0);
      gl.uniform2f(this.locDiv.u_texel, texel, texel);
      gl.uniform4f(this.locDiv.u_uvClamp, minU, minV, maxU, maxV);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 3. Jacobi Pressure Solve
      gl.useProgram(this.progPress);
      gl.uniform2f(this.locPress.u_texel, texel, texel);
      gl.uniform4f(this.locPress.u_uvClamp, minU, minV, maxU, maxV);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texDiv.tex);
      gl.uniform1i(this.locPress.u_div, 1);
      for (let it = 0; it < jacobiIters; it++) {
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
    }

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
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
    gl.uniform1i(this.locBaseStep.u_pore, 3);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locBaseStep.u_sub, 5);
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
    gl.uniform1f(this.locSurfStep.u_maxWater, maxWaterCap);
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
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locSurfSeep.u_sub, 5);
    this._bindSurfaceUniforms(this.locSurfSeep, engine, params);
    gl.uniform1f(this.locSurfSeep.u_maxWater, maxWaterCap);
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
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locPerc.u_sub, 5);
    this._bindSurfaceUniforms(this.locPerc, engine, params);
    gl.uniform1f(this.locPerc.u_evapRate, evapRate);
    gl.uniform1f(this.locPerc.u_backrunRim, backrunRim);
    gl.uniform1f(this.locPerc.u_maxWater, maxWaterCap);
    gl.uniform2f(this.locPerc.u_texel, texel, texel);
    gl.uniform4f(this.locPerc.u_uvClamp, minU, minV, maxU, maxV);
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
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locComp.u_sub, 6);

    gl.uniform1f(this.locComp.u_inkWarmth, (params?.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  beginStrokeSession(engine, worldPos, params = {}) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    const layer = engine.activeLayer;
    const projId = engine.currentProjectId || 'default';

    let isSameSession = this.active && this.layer === layer && this.projectId === projId;
    if (this.active && !isSameSession) {
      this.commitToChunks(engine, this.lastParams || {}, true);
      isSameSession = false;
    } else if (this.active && this._hasCpuDirty) {
      // Ensure previous stroke's finished idle bleed is synced to Canvas2D BEFORE new Undo snapshot is taken
      this.syncTilesToCanvas2D(engine, this.lastParams || {});
    }
    if (params && typeof params === 'object') {
      this.lastParams = { ...params };
    }

    this.layer = layer;
    this.projectId = projId;
    this.strokeId = (this.strokeId % 1024) + 1;
    this.active = true;
    const evap = params?.evaporation ?? 28;
    this.simActiveFrames = evap < 2 ? 320 : 480;

    if (!isSameSession) {
      this.wetMinX = worldPos.x - 32;
      this.wetMinY = worldPos.y - 32;
      this.wetMaxX = worldPos.x + 32;
      this.wetMaxY = worldPos.y + 32;
    } else {
      // Preserve currently spreading pools cleanly while expanding union for new water
      this.wetMinX = Math.min(this.wetMinX, worldPos.x - 32);
      this.wetMinY = Math.min(this.wetMinY, worldPos.y - 32);
      this.wetMaxX = Math.max(this.wetMaxX, worldPos.x + 32);
      this.wetMaxY = Math.max(this.wetMaxY, worldPos.y + 32);
    }
    this._focusX = worldPos.x;
    this._focusY = worldPos.y;
    this.gpuRenderer.sumiOverlay = null;
    return true;
  }

  _retireExcessWetTiles() {
    let wetList = null;
    this.activeTiles.forEach((t) => {
      if (t.wetTicks > 0) {
        if (!wetList) wetList = [];
        wetList.push(t);
      }
    });
    this._activeWetCount = wetList ? wetList.length : 0;
    if (wetList && wetList.length > MAX_ACTIVE_WET) {
      wetList.sort((a, b) => (b.genDepth - a.genDepth) || (a.wetTicks - b.wetTicks) || (a.lastUsed - b.lastUsed));
      const retireCount = wetList.length - MAX_ACTIVE_WET;
      for (let i = 0; i < retireCount; i++) {
        wetList[i].wetTicks = 0;
      }
      this._activeWetCount = MAX_ACTIVE_WET;
    }
  }

  _markWetTilesInBounds(minX, minY, maxX, maxY, ticks = 480, isStamp = true) {
    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1e-4) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1e-4) / TILE_SIZE);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this.activeTiles.get(`${tx},${ty}`);
        if (t) {
          const lx0 = Math.max(0, Math.floor(minX - t.wx));
          const ly0 = Math.max(0, Math.floor(minY - t.wy));
          const lx1 = Math.min(TILE_SIZE, Math.ceil(maxX - t.wx));
          const ly1 = Math.min(TILE_SIZE, Math.ceil(maxY - t.wy));
          if (lx1 > lx0 && ly1 > ly0) {
            t.wMinX = Math.min(t.wMinX, lx0);
            t.wMinY = Math.min(t.wMinY, ly0);
            t.wMaxX = Math.max(t.wMaxX, lx1);
            t.wMaxY = Math.max(t.wMaxY, ly1);
          }
          if (isStamp) {
            t.genDepth = 0;
          }
          t.wetTicks = Math.max(t.wetTicks || 0, ticks);
        }
      }
    }
    this._retireExcessWetTiles();
  }

  _expandWetBounds(engine, minX, minY, maxX, maxY, parentTicks, parentGenDepth = 0) {
    if (this._activeWetCount >= MAX_ACTIVE_WET && parentGenDepth >= 3) return;
    this.dirtyMinX = Math.min(this.dirtyMinX, minX);
    this.dirtyMinY = Math.min(this.dirtyMinY, minY);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, maxX);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, maxY);
    this.wetMinX = Math.min(this.wetMinX, minX);
    this.wetMinY = Math.min(this.wetMinY, minY);
    this.wetMaxX = Math.max(this.wetMaxX, maxX);
    this.wetMaxY = Math.max(this.wetMaxY, maxY);

    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1e-4) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1e-4) / TILE_SIZE);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const key = `${tx},${ty}`;
        let t = this.activeTiles.get(key);
        const wasWet = !!(t && t.wetTicks > 0);
        if (!t) {
          if (this._activeWetCount >= MAX_ACTIVE_WET) continue;
          t = this._ensureTile(engine, tx, ty);
        }
        if (!t) continue;
        const lx0 = Math.max(0, Math.floor(minX - t.wx));
        const ly0 = Math.max(0, Math.floor(minY - t.wy));
        const lx1 = Math.min(TILE_SIZE, Math.ceil(maxX - t.wx));
        const ly1 = Math.min(TILE_SIZE, Math.ceil(maxY - t.wy));
        if (lx1 > lx0 && ly1 > ly0) {
          t.wMinX = Math.min(t.wMinX, lx0);
          t.wMinY = Math.min(t.wMinY, ly0);
          t.wMaxX = Math.max(t.wMaxX, lx1);
          t.wMaxY = Math.max(t.wMaxY, ly1);
        }
        if (!wasWet) {
          t.genDepth = Math.min(8, parentGenDepth + 1);
          const progressiveCap = Math.max(40, Math.min(parentTicks, 240 - t.genDepth * 16));
          t.wetTicks = Math.max(t.wetTicks || 0, progressiveCap);
          this._activeWetCount++;
        }
      }
    }
    this._retireExcessWetTiles();
  }

  _boxHasWetTiles(x0, y0, x1, y1) {
    const tx0 = Math.floor(x0 / TILE_SIZE);
    const tx1 = Math.floor((x1 - 1) / TILE_SIZE);
    const ty0 = Math.floor(y0 / TILE_SIZE);
    const ty1 = Math.floor((y1 - 1) / TILE_SIZE);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this.activeTiles.get(`${tx},${ty}`);
        if (t && t.wetTicks > 0) return true;
      }
    }
    return false;
  }

  _stampAndStepWorkBox(engine, segments, count, workX, workY, boxW, boxH, apron, modeInt, brushVelWorld, pressure, pigmentK, params) {
    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;

    // Ensure overlapping chunks exist & are backed up for Undo before any pixel changes
    const innerX = workX + apron;
    const innerY = workY + apron;
    const innerW = Math.max(1, boxW - apron * 2);
    const innerH = Math.max(1, boxH - apron * 2);
    const sCX = engine.isStatic ? 0 : Math.floor(innerX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((innerX + innerW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(innerY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((innerY + innerH - 1) / engine.chunkSize);
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
        if (chunk) {
          const id = `${cx},${cy}`;
          if (!engine.currentStrokeDirtyChunks.has(id)) {
            backupChunkLayer(engine, chunk, id, { layer });
            engine._markDirty(id, layer, false, true);
          }
        }
      }
    }

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, params);
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

    const inkAffection = (params?.inkAffection ?? 35) / 100;

    // PASS 1B: On WATER mode, re-wet fixed dryPig into mobile surfPig scaled by u_inkAffection
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
      gl.uniform1f(this.locRewet.u_inkAffection, inkAffection);
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
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texSub.tex);
    gl.uniform1i(this.locApply.u_sub, 5);

    this._bindSurfaceUniforms(this.locApply, engine, params);
    gl.uniform1i(this.locApply.u_mode, modeInt);
    gl.uniform2f(this.locApply.u_brushVel, brushVelWorld.x, brushVelWorld.y);
    gl.uniform1f(this.locApply.u_pressure, pressure);
    gl.uniform1f(this.locApply.u_inkConcentration, (params?.ink ?? 78) / 100);
    gl.uniform1f(this.locApply.u_inkAffection, inkAffection);
    gl.uniform1f(this.locApply.u_waterCharge, (params?.water ?? 65) / 100);
    gl.uniform1f(this.locApply.u_maxWater, Math.max(0.15, Math.min(2.90, ((params?.maxWater ?? 100) / 100) * 1.45)));
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
      const pad = s.r + 20;
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

    const minX = Math.floor(segMinX);
    const minY = Math.floor(segMinY);
    const maxX = Math.ceil(segMaxX);
    const maxY = Math.ceil(segMaxY);
    const apron = 16;
    const spanX = maxX - minX;
    const spanY = maxY - minY;

    engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, minX);
    engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, maxX);
    engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, minY);
    engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, maxY);

    if (spanX <= WORK_RES - apron * 2 && spanY <= WORK_RES - apron * 2) {
      const boxW = Math.max(48, spanX + apron * 2);
      const boxH = Math.max(48, spanY + apron * 2);
      const workX = minX - apron;
      const workY = minY - apron;
      this._stampAndStepWorkBox(
        engine, segments, count, workX, workY, boxW, boxH, apron,
        modeInt, brushVelWorld, pressure, pigmentK, params
      );
    } else {
      // Large brush/swipe: tile stamp seamlessly across overlapping sub-boxes without clipping
      const STEP_SPAN = 640;
      for (let x = minX; x < maxX; x += STEP_SPAN) {
        for (let y = minY; y < maxY; y += STEP_SPAN) {
          const innerW = Math.min(STEP_SPAN, maxX - x);
          const innerH = Math.min(STEP_SPAN, maxY - y);
          const boxW = Math.min(WORK_RES, Math.max(48, innerW + apron * 2));
          const boxH = Math.min(WORK_RES, Math.max(48, innerH + apron * 2));
          this._stampAndStepWorkBox(
            engine, segments, count, x - apron, y - apron, boxW, boxH, apron,
            modeInt, brushVelWorld, pressure, pigmentK, params
          );
        }
      }
    }

    if (modeInt !== 3) {
      this._needsDryOnClose = true;
    }
    const evap = params?.evaporation ?? 28;
    const tickCap = evap < 2 ? 320 : 480;
    this.simActiveFrames = tickCap;
    this._markWetTilesInBounds(minX - 48, minY - 48, maxX + 48, maxY + 48, tickCap, true);
  }

  _probeWorkBoxFrontier(engine, workX, workY, innerMinX, innerMinY, innerMaxX, innerMaxY, parentTicks, parentGenDepth, allowRetireDry = false, clusterTiles = null) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const u0 = (innerMinX - workX) / WORK_RES;
    const v0 = (innerMinY - workY) / WORK_RES;
    const u1 = (innerMaxX - workX) / WORK_RES;
    const v1 = (innerMaxY - workY) / WORK_RES;
    if (u1 <= u0 || v1 <= v0) return;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, 3, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texProbe.fbo);
    gl.useProgram(this.progEdgeProbe);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
    gl.uniform1i(this.locEdgeProbe.u_surf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
    gl.uniform1i(this.locEdgeProbe.u_pore, 1);
    gl.uniform4f(this.locEdgeProbe.u_innerUv, u0, v0, u1, v1);
    gl.uniform2f(this.locEdgeProbe.u_bandUv, 28.0 / WORK_RES, 28.0 / WORK_RES);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.readPixels(0, 0, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, this._probeBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const pb = this._probeBuf;
    const wAt = (cx, cy) => pb[(cy * 3 + cx) * 4];
    const centerMax = wAt(1, 1);
    if (centerMax === 0) {
      if (allowRetireDry && clusterTiles) {
        for (let i = 0; i < clusterTiles.length; i++) {
          clusterTiles[i].wetTicks = 0;
        }
      }
      return;
    }

    const expW = wAt(0, 1) >= 2 || wAt(0, 0) >= 2 || wAt(0, 2) >= 2;
    const expE = wAt(2, 1) >= 2 || wAt(2, 0) >= 2 || wAt(2, 2) >= 2;
    const expS = wAt(1, 0) >= 2 || wAt(0, 0) >= 2 || wAt(2, 0) >= 2;
    const expN = wAt(1, 2) >= 2 || wAt(0, 2) >= 2 || wAt(2, 2) >= 2;

    if (expW || expE || expS || expN) {
      const STEP_OUT = 56;
      const nMinX = expW ? (innerMinX - STEP_OUT) : innerMinX;
      const nMaxX = expE ? (innerMaxX + STEP_OUT) : innerMaxX;
      const nMinY = expS ? (innerMinY - STEP_OUT) : innerMinY;
      const nMaxY = expN ? (innerMaxY + STEP_OUT) : innerMaxY;
      this._expandWetBounds(engine, nMinX, nMinY, nMaxX, nMaxY, parentTicks, parentGenDepth);
    }
  }

  _runWetCluster(engine, clusterMinX, clusterMinY, clusterMaxX, clusterMaxY, dt, forceDry, activeParams, maxTicks = 240, minGen = 0, clusterTiles = null) {
    const minX = Math.floor(clusterMinX);
    const minY = Math.floor(clusterMinY);
    const maxX = Math.ceil(clusterMaxX);
    const maxY = Math.ceil(clusterMaxY);
    if (maxX <= minX || maxY <= minY) return;

    this.dirtyMinX = Math.min(this.dirtyMinX, minX);
    this.dirtyMinY = Math.min(this.dirtyMinY, minY);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, maxX);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, maxY);

    const apron = 20;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const shouldProbe = !forceDry && (engine.isDrawing || (this._probeTick & 1) === 0);

    if (spanX <= WORK_RES - apron * 2 && spanY <= WORK_RES - apron * 2) {
      const boxW = Math.min(WORK_RES, Math.max(48, spanX + apron * 2));
      const boxH = Math.min(WORK_RES, Math.max(48, spanY + apron * 2));
      const workX = minX - apron;
      const workY = minY - apron;
      const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, activeParams);
      if (tiles.length > 0) {
        this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, dt, forceDry, activeParams);
        this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
        this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
        if (shouldProbe) {
          this._probeWorkBoxFrontier(engine, workX, workY, minX, minY, maxX, maxY, maxTicks, minGen, true, clusterTiles);
        }
      }
      return;
    }

    // Multi-box symmetric Gauss-Seidel sweep across large connected wet island
    const STEP_SPAN = 640;
    const xs = [];
    for (let x = minX; x < maxX; x += STEP_SPAN) xs.push(x);
    const ys = [];
    for (let y = minY; y < maxY; y += STEP_SPAN) ys.push(y);
    if ((this.simActiveFrames & 1) === 1) {
      xs.reverse();
      ys.reverse();
    }

    for (let xi = 0; xi < xs.length; xi++) {
      const x = xs[xi];
      const innerW = Math.min(STEP_SPAN, maxX - x);
      const boxW = Math.min(WORK_RES, Math.max(48, innerW + apron * 2));
      const workX = x - apron;
      for (let yi = 0; yi < ys.length; yi++) {
        const y = ys[yi];
        const innerH = Math.min(STEP_SPAN, maxY - y);
        const boxH = Math.min(WORK_RES, Math.max(48, innerH + apron * 2));
        const workY = y - apron;

        if (!this._boxHasWetTiles(x, y, x + innerW, y + innerH)) continue;

        const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, activeParams);
        if (tiles.length === 0) continue;

        this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, dt, forceDry, activeParams);
        this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
        this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
        if (shouldProbe) {
          this._probeWorkBoxFrontier(engine, workX, workY, x, y, x + innerW, y + innerH, maxTicks, minGen, false, null);
        }
      }
    }
  }

  stepSimulation(engine, dt = 0.016, forceDry = false, params = {}) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    this._probeTick++;

    // Group active wet tiles into 8-neighbor connected islands so distant wet strokes run independently & merge seamlessly
    const wetMap = new Map();
    this.activeTiles.forEach((t, k) => {
      if (t.wetTicks > 0) wetMap.set(k, t);
    });
    this._activeWetCount = wetMap.size;
    if (wetMap.size === 0) {
      this.simActiveFrames = Math.min(this.simActiveFrames, 1);
      return;
    }

    const visited = new Set();
    const clusters = [];
    wetMap.forEach((seed, seedKey) => {
      if (visited.has(seedKey)) return;
      const queue = [seed];
      visited.add(seedKey);
      let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
      let maxTicks = 0;
      let minGen = 999;
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        const curMinX = cur.wMaxX > cur.wMinX ? (cur.wx + cur.wMinX) : cur.wx;
        const curMinY = cur.wMaxY > cur.wMinY ? (cur.wy + cur.wMinY) : cur.wy;
        const curMaxX = cur.wMaxX > cur.wMinX ? (cur.wx + cur.wMaxX) : (cur.wx + TILE_SIZE);
        const curMaxY = cur.wMaxY > cur.wMinY ? (cur.wy + cur.wMaxY) : (cur.wy + TILE_SIZE);
        if (curMinX < cMinX) cMinX = curMinX;
        if (curMinY < cMinY) cMinY = curMinY;
        if (curMaxX > cMaxX) cMaxX = curMaxX;
        if (curMaxY > cMaxY) cMaxY = curMaxY;
        if (cur.wetTicks > maxTicks) maxTicks = cur.wetTicks;
        if ((cur.genDepth || 0) < minGen) minGen = cur.genDepth || 0;

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nk = `${cur.tx + dx},${cur.ty + dy}`;
            if (visited.has(nk)) continue;
            const nt = wetMap.get(nk);
            if (nt) {
              visited.add(nk);
              queue.push(nt);
            }
          }
        }
      }
      clusters.push({ minX: cMinX, minY: cMinY, maxX: cMaxX, maxY: cMaxY, maxTicks, minGen, tiles: queue });
    });

    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      this._runWetCluster(engine, cl.minX, cl.minY, cl.maxX, cl.maxY, dt, forceDry, activeParams, cl.maxTicks, cl.minGen, cl.tiles);
    }

    let anyWetLeft = false;
    this.activeTiles.forEach((t) => {
      if (t.wetTicks > 0) {
        t.wetTicks--;
        if (t.wetTicks > 0) anyWetLeft = true;
      }
    });
    if (!anyWetLeft && !engine.isDrawing) {
      this.simActiveFrames = Math.min(this.simActiveFrames, 1);
    }
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

    this._bakeTileSubIfNeeded(engine, t, params);

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
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, t.sub.tex);
    gl.uniform1i(this.locComp.u_sub, 6);
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
        engine._markDirty(id, layer, false, true);
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

  _dryAllActiveTilesForArchive(engine, activeParams) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return;
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

          const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, activeParams);
          if (tiles.length === 0) continue;
          for (let it = 0; it < 2; it++) {
            this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, 0.016, true, activeParams);
          }
          this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
          this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
        }
      }
    }
    this._needsDryOnClose = false;
  }

  commitToChunks(engine, params = {}, closeSession = false, skipDry = false) {
    if (!this.ready || !this.active || !engine) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    if (closeSession && !skipDry && this._needsDryOnClose && this.activeTiles.size > 0) {
      this._dryAllActiveTilesForArchive(engine, activeParams);
    }

    this.syncTilesToCanvas2D(engine, activeParams);

    if (closeSession) {
      this._archiveActiveTiles(engine, activeParams);
      this._releaseAllTiles();
      this.touchedChunks.clear();
      this.active = false;
      this.simActiveFrames = 0;
      this._needsDryOnClose = false;
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

    this._dryAllActiveTilesForArchive(engine, activeParams);
    this.commitToChunks(engine, activeParams, true, true);
    return true;
  }

  cancel(engine = null, restoreDirty = false) {
    this.active = false;
    this.simActiveFrames = 0;
    this._needsDryOnClose = false;
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

  resetProjectState(prevProjId = null) {
    this.cancel(null, false);
    this.clearPassiveArchive(prevProjId, null);
    while (this.tilePool.length > 4) {
      this._destroyTileGpu(this.tilePool.pop());
    }
  }

  dispose() {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      this._releaseAllTiles();
      this.passiveTiles.clear();
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
      delT(this.texSub);
      delT(this.texDiv);
      delT(this.texStamp);
      delT(this.texOutput);
      delT(this.texTileUnpremult);
      delT(this.texUploadDry);
      delT(this.texUploadBase);
      delT(this.texTileBaseTmp);
      delT(this.texTileDryTmp);
      delT(this.texProbe);
      if (this.dummyTex) gl.deleteTexture(this.dummyTex);

      if (this.mrtFbo) gl.deleteFramebuffer(this.mrtFbo);
      if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
      if (this.bristleVao) gl.deleteVertexArray(this.bristleVao);
      if (this.quadCornerVbo) gl.deleteBuffer(this.quadCornerVbo);
      if (this.instSegVbo) gl.deleteBuffer(this.instSegVbo);
      if (this.instPropVbo) gl.deleteBuffer(this.instPropVbo);

      const progs = [
        this.progRectMap, this.progUnpremult, this.progSubBake, this.progBristle,
        this.progRewet, this.progBrushApply, this.progVelAdvect,
        this.progDiv, this.progPress, this.progGradSub,
        this.progSurfStep, this.progBaseStep, this.progSurfSeep,
        this.progPerc, this.progComp, this.progEdgeProbe,
        this.progPackDry, this.progUnpackDry, this.progReconcile
      ];
      for (const p of progs) if (p) gl.deleteProgram(p);
    }
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
    this.gl = null;
  }
}
