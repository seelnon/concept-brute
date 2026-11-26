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
import { backupChunkLayer, acquireBackupCanvas } from '../engine/backupPool.js';
import { GLSL_SURFACE_BIOME_SAMPLER } from '../engine/canvasSurfaceGpu.js';
import { computePinWarpVertices } from './selection.js';

const TILE_SIZE = 256;
const WORK_RES = 768;
const MAX_INSTANCES = 4096;
const PBO_RING_SIZE = 12;
const PROBE_PBO_RING_SIZE = 32;
const CHUNK_BACKUP_RING_SIZE = 16;
const LARGE_BACKUP_RING_SIZE = 2;

const SOLVER_PRESETS = {
  1: {
    quality: 1,
    tileRes: 128,
    workRes: 384,
    simScale: 0.5,
    texelWorld: 2.0,
    snapWorld: 4,
    jacobi: [4, 2, 1],
    maxPoolTiles: 220,
    maxActiveWet: 180,
    maxPassiveTiles: 320
  },
  2: {
    quality: 2,
    tileRes: 192,
    workRes: 576,
    simScale: 0.75,
    texelWorld: 256 / 192,
    snapWorld: 4,
    jacobi: [6, 4, 2],
    maxPoolTiles: 185,
    maxActiveWet: 145,
    maxPassiveTiles: 260
  },
  3: {
    quality: 3,
    tileRes: 256,
    workRes: 768,
    simScale: 1.0,
    texelWorld: 1.0,
    snapWorld: 1,
    jacobi: [8, 5, 3],
    maxPoolTiles: 168,
    maxActiveWet: 112,
    maxPassiveTiles: 220
  }
};

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
uniform float u_minRadius;

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

  float r = max(u_minRadius, a_props.x);
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
uniform float u_texelToWorld;

out vec4 outSub;

${SUMI_SURFACE_GLSL}

void main() {
  outSub = sampleSumiSubstrate(u_workOrigin + gl_FragCoord.xy * u_texelToWorld);
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
uniform vec2 u_worldTexel;
uniform float u_texelToWorld;
uniform float u_gradScale;
uniform vec4 u_uvClamp;
uniform vec2 u_workOrigin;
uniform float u_dt;
uniform float u_glueVisc;
uniform float u_turb;
uniform float u_time;
uniform float u_bleedRate;
uniform float u_bleedResist;
uniform float u_bleedBypass;
in vec2 v_uv;
out vec4 outVel;
${GLSL_SURFACE_BIOME_SAMPLER}
${SUMI_NOISE_GLSL}
void main() {
  vec2 vel = texture(u_vel, v_uv).xy;
  vec4 surf = texture(u_surf, v_uv);
  vec2 worldPos = u_workOrigin + gl_FragCoord.xy * u_texelToWorld;

  // Semi-Lagrangian backtrace (vel is in world-pixels/sec)
  vec2 backUv = clamp(v_uv - vel * u_worldTexel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
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
  ) * (0.125 * u_gradScale);

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
    gradP = vec2(lR - lL, lU - lD) * ((1.8 + 1.4 * u_surfChannel) * u_gradScale);
  } else if (u_useHeightmap == 1 && u_heightSource == 0 && u_hasSurface == 1) {
    vec4 s = sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    gradP = (s.gb - 0.5) * 2.0 * (0.4 + 1.2 * u_surfChannel);
  } else {
    float pL = texture(u_sub, clamp(v_uv - vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pR = texture(u_sub, clamp(v_uv + vec2(u_texel.x, 0.0), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pD = texture(u_sub, clamp(v_uv - vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
    float pU = texture(u_sub, clamp(v_uv + vec2(0.0, u_texel.y), u_uvClamp.xy, u_uvClamp.zw)).r;
    gradP = vec2(pR - pL, pU - pD) * ((0.35 + 0.55 * u_surfChannel) * u_gradScale);
  }

  float wetness = smoothstep(0.004, 0.09, surf.r);
  float gradPush = mix(1.0, 0.14, u_bleedResist) * (1.0 + 0.55 * u_bleedBypass);
  advV -= gradH * 72.0 * wetness * mix(0.75, 1.25, u_surfSlip) * gradPush;
  advV -= gradP * 14.0 * wetness * mix(1.0, 0.28, u_bleedResist) * (1.0 + 0.25 * u_bleedBypass);

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

  // Viscosity & friction: animal glue, shallow depth & paper bleed resistance damp velocity
  float viscosityDrag = (1.0 + (surf.g + u_glueVisc * 0.5) * 3.2 + (1.0 - wetness) * 14.0 + (1.0 - u_surfSlip) * 1.2) * (1.0 - 0.35 * u_bleedBypass) + u_bleedResist * 28.0;
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
uniform vec2 u_worldTexel;
uniform float u_diffScale;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_backrunRim;
uniform float u_evapRate;
uniform float u_maxWater;
uniform float u_forceDry;
uniform float u_bleedRate;
uniform float u_bleedResist;
uniform float u_bleedBypass;

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
  vec2 backUv = clamp(v_uv - vel * u_worldTexel * u_dt, u_uvClamp.xy, u_uvClamp.zw);

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

  float bleedWaterScale = clamp(u_bleedRate, 0.04, 2.0);
  float bleedSolvScale = clamp(u_bleedRate, 0.10, 1.85);
  float bleedRimScale = clamp(u_bleedRate, 0.15, 1.65);
  float bleedPigScale = clamp(u_bleedRate, 0.08, 1.75);

  float wetMask = smoothstep(0.004, 0.08, max(surf.r, avgWater));
  float rimWet = smoothstep(0.003, 0.05, max(surf.r, avgWater));
  float wB_sum = 0.20 * (sL.r + sR.r + sB.r + sT.r) + 0.05 * (sLB.r + sRB.r + sLT.r + sRT.r);
  if (wB_sum > 0.001) {
    float avgAff = (
      0.20 * (sL.b * sL.r + sR.b * sR.r + sB.b * sB.r + sT.b * sT.r) +
      0.05 * (sLB.b * sLB.r + sRB.b * sRB.r + sLT.b * sLT.r + sRT.b * sRT.r)
    ) / wB_sum;
    float affScale = waterLap * u_diffScale * bleedWaterScale;
    float affBlend = waterLap > 0.0
      ? clamp(affScale / max(0.001, surf.r + affScale), 0.0, 0.85)
      : (0.04 * wetMask * u_diffScale * bleedSolvScale);
    surf.b = mix(surf.b, avgAff, affBlend);
  }
  float avgSolv = 0.20 * (sL.a + sR.a + sB.a + sT.a) + 0.05 * (sLB.a + sRB.a + sLT.a + sRT.a);
  float solvLap = avgSolv - surf.a;
  surf.a = max(0.0, surf.a + solvLap * 0.24 * wetMask * u_diffScale * bleedSolvScale);

  float maxCap = clamp(u_maxWater, 0.15, 2.90);
  surf.r = clamp(surf.r + waterLap * clamp(0.28 * wetMask * u_diffScale * bleedWaterScale, 0.0, 0.72), 0.0, maxCap);

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

  float rimGain = u_backrunRim * 0.34 * rimWet * u_diffScale * bleedRimScale;
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
  float pigDiff = clamp(surf.r * 0.085, 0.0, 0.12) * (1.0 - isRim * 0.88) * u_diffScale * bleedPigScale;
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
uniform vec2 u_worldTexel;
uniform float u_diffScale;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_glueVisc;
uniform int u_alphaLock;
uniform float u_bleedRate;
uniform float u_bleedResist;
uniform float u_bleedBypass;

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
  vec2 backUv = clamp(v_uv - vel * u_worldTexel * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec4 advBase = texture(u_baseBg, backUv);
  float advSurf = texture(u_surf, backUv).r + texture(u_pore, backUv).r * 0.75;
  float advMob = smoothstep(0.010, 0.18, advSurf);
  float advBleed = mix(1.0, 0.15, u_bleedResist) * (1.0 + 0.35 * u_bleedBypass);
  float advW = clamp(length(vel) * 0.020 * wetMob * advMob * advBleed, 0.0, 0.56) * bendScale;
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
    float diffRate = clamp(wetMob * (0.025 + 0.095 * perm) * (1.0 - u_glueVisc * 0.35) * u_bleedRate, 0.0, 0.32) * bleedScale * u_diffScale;
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
uniform float u_bleedResist;
uniform float u_bleedBypass;

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
    float snagFactor = clamp(1.0 + 0.60 * u_bleedResist - 0.42 * u_bleedBypass, 0.25, 1.85);
    float snagResist = clamp(u_sootSnag * sootBlock * 0.42 * snagFactor, 0.0, 0.85);
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
uniform float u_diffScale;
uniform vec4 u_uvClamp;
uniform float u_dt;
uniform float u_forceDry;
uniform float u_bleedRate;
uniform float u_bleedResist;
uniform float u_bleedBypass;

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
  float effSnag = clamp(u_sootSnag * (1.0 + 0.65 * u_bleedResist - 0.45 * u_bleedBypass), 0.0, 1.45);
  float mySootMobility = clamp((1.0 - myBlock * effSnag) * (1.0 - pore.g * 0.18), 0.04, 0.88);
  float ridgeBlock = 0.65 * (1.0 + 0.45 * u_bleedResist - 0.55 * u_bleedBypass);
  float pigOutMass = 0.0;
  vec4 pigInAccum = vec4(0.0);
  float rimFrontFlux = 0.0;

  for (int i = 0; i < 8; i++) {
    vec2 nUV = clamp(v_uv + OFFSETS[i] * u_texel, u_uvClamp.xy, u_uvClamp.zw);
    vec4 nPore = texture(u_pore, nUV);
    vec4 nPig = texture(u_porePig, nUV);
    vec4 nSub = texture(u_sub, nUV);

    float linkPerm = min(myPerm, nSub.y);
    float lowPermBypass = max(linkPerm, pow(max(linkPerm, 0.04), 0.42));
    float tightPerm = linkPerm * mix(1.0, max(0.18, linkPerm), u_bleedResist);
    float effPerm = mix(tightPerm, lowPermBypass, u_bleedBypass * 0.72);
    float fiberBias = clamp(1.0 - abs(myH - nSub.r) * ridgeBlock, 0.08, 1.0);
    float cond = min(WEIGHTS[i] * 0.92, WEIGHTS[i] * u_capillarity * effPerm * fiberBias * u_diffScale * u_bleedRate);

    // Smooth continuous capillary transition eliminates hard concentric stepping contours
    if (nPore.r > pore.r) {
      float wIn = (nPore.r - pore.r) * cond * smoothstep(0.003, 0.075, nPore.r);
      waterDelta += wIn;
      float nMob = clamp((1.0 - nSub.z * effSnag) * (1.0 - nPore.g * 0.18), 0.04, 0.88);
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
uniform int u_unpremult;

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
    if (u_unpremult == 1) {
      outColor = base.a > 0.002 ? vec4(clamp(base.rgb / base.a, 0.0, 1.0), clamp(base.a, 0.0, 1.0)) : vec4(0.0);
    } else {
      outColor = base;
    }
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
    if (u_unpremult == 1) {
      outColor = base.a > 0.002 ? vec4(clamp(base.rgb / base.a, 0.0, 1.0), clamp(base.a, 0.0, 1.0)) : vec4(0.0);
    } else {
      outColor = base;
    }
    return;
  }

  // Subtle wet puddle darken & specular glint where liquid sits over paint/ink
  float totalWet = clamp(surf.r * 0.55 + pore.r * 0.75, 0.0, 1.0);
  float sheen = smoothstep(0.08, 0.55, surf.r) * 0.040;

  vec3 baseStraight = base.a > 0.002 ? clamp(base.rgb / base.a, 0.0, 1.0) : vec3(1.0);
  vec3 onBase = kubelkaMunk(K_eff, S_total, clamp(baseStraight * (1.0 - totalWet * 0.035), 0.0, 1.0));
  onBase = clamp(onBase + vec3(sheen * clamp(base.a + inkAlpha, 0.0, 1.0)), 0.0, 1.0);

  vec3 overEmptyPremul = clamp(R_white - vec3(1.0 - inkAlpha) + vec3(sheen * inkAlpha), 0.0, inkAlpha);

  vec4 res;
  if (u_alphaLock == 1) {
    if (base.a <= 0.002) {
      res = vec4(0.0);
    } else {
      res = vec4(clamp(onBase * base.a, 0.0, base.a), base.a);
    }
  } else {
    vec3 outRgb = onBase * base.a + overEmptyPremul * (1.0 - base.a);
    float outA = base.a + inkAlpha * (1.0 - base.a);
    res = vec4(clamp(outRgb, 0.0, outA), clamp(outA, 0.0, 1.0));
  }

  if (u_unpremult == 1) {
    outColor = res.a > 0.002 ? vec4(clamp(res.rgb / res.a, 0.0, 1.0), res.a) : vec4(0.0);
  } else {
    outColor = res;
  }
}`;

// Lightweight 3x3 workbox frontier water probe (36 bytes readback) for organic progressive tile expansion
const EDGE_PROBE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_pore;
uniform vec4 u_innerUv; // (u0, v0, u1, v1)
uniform vec2 u_bandUv;  // (bandU, bandV)
uniform vec2 u_probePhase;

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
    su0 = (c.y == 1) ? u0 : mix(u0, u1, 0.04);
    su1 = (c.y == 1) ? u1 : mix(u0, u1, 0.96);
  }

  if (c.y == 0) {
    sv0 = v0;
    sv1 = v0 + bv;
  } else if (c.y == 2) {
    sv0 = v1 - bv;
    sv1 = v1;
  } else {
    sv0 = (c.x == 1) ? v0 : mix(v0, v1, 0.04);
    sv1 = (c.x == 1) ? v1 : mix(v0, v1, 0.96);
  }

  int nx = (c.x == 1) ? 12 : 4;
  int ny = (c.y == 1) ? 12 : 4;
  if (c.x == 1 && c.y == 1) {
    nx = 8;
    ny = 8;
  }

  float maxW = 0.0;
  float maxSurf = 0.0;
  for (int iy = 0; iy < 12; iy++) {
    if (iy >= ny) break;
    float fy = (float(iy) + 0.5 + u_probePhase.y) / float(ny);
    float v = mix(sv0, sv1, clamp(fy, 0.02, 0.98));
    for (int ix = 0; ix < 12; ix++) {
      if (ix >= nx) break;
      float fx = (float(ix) + 0.5 + u_probePhase.x) / float(nx);
      vec2 uv = vec2(mix(su0, su1, clamp(fx, 0.02, 0.98)), v);
      float s = texture(u_surf, uv).r;
      float p = texture(u_pore, uv).r;
      maxSurf = max(maxSurf, s);
      maxW = max(maxW, s + p);
    }
  }
  outProbe = vec4(clamp(maxW * 8.0, 0.0, 1.0), clamp(maxSurf * 8.0, 0.0, 1.0), 0.0, 1.0);
}`;

// Dense 8x8 cell x 6x6 sub-grid (48x48 = 2304 samples) interior wetness check for reliable dry retirement
const WET_PROBE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_surf;
uniform sampler2D u_pore;
uniform vec4 u_innerUv; // (u0, v0, u1, v1)
uniform vec2 u_probePhase;

out vec4 outProbe;

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 cellMin = cell * 0.125;
  vec2 cellMax = (cell + 1.0) * 0.125;
  float su0 = mix(u_innerUv.x, u_innerUv.z, cellMin.x);
  float su1 = mix(u_innerUv.x, u_innerUv.z, cellMax.x);
  float sv0 = mix(u_innerUv.y, u_innerUv.w, cellMin.y);
  float sv1 = mix(u_innerUv.y, u_innerUv.w, cellMax.y);

  float maxW = 0.0;
  float maxSurf = 0.0;
  for (int iy = 0; iy < 6; iy++) {
    float fy = (float(iy) + 0.5 + u_probePhase.y) / 6.0;
    float v = mix(sv0, sv1, clamp(fy, 0.02, 0.98));
    for (int ix = 0; ix < 6; ix++) {
      float fx = (float(ix) + 0.5 + u_probePhase.x) / 6.0;
      vec2 uv = vec2(mix(su0, su1, clamp(fx, 0.02, 0.98)), v);
      float s = texture(u_surf, uv).r;
      float p = texture(u_pore, uv).r;
      maxSurf = max(maxSurf, s);
      maxW = max(maxW, s + p);
    }
  }
  outProbe = vec4(clamp(maxW * 8.0, 0.0, 1.0), clamp(maxSurf * 8.0, 0.0, 1.0), 0.0, 1.0);
}`;

// Compact RGBA8 archival packing for fixed + optional wet soot (RGBA16F -> RGBA8)
const PACK_DRY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_dryPig;
uniform sampler2D u_porePig;
uniform sampler2D u_surfPig;
in vec2 v_uv;
out vec4 outPacked;
void main() {
  vec4 d = texture(u_dryPig, v_uv);
  vec4 p = texture(u_porePig, v_uv);
  vec4 s = texture(u_surfPig, v_uv);
  float mDry = max(0.0, d.a);
  float mPore = max(0.0, p.a) * (2.15 / 2.35);
  float mSurf = max(0.0, s.a) * (1.85 / 2.35);
  float totalM = mDry + mPore + mSurf;
  if (totalM <= 0.0002) {
    outPacked = vec4(0.0);
    return;
  }
  vec3 rgb = (d.rgb * mDry + p.rgb * mPore + s.rgb * mSurf) / totalM;
  float mNorm = clamp(sqrt(clamp(totalM, 0.0, 8.0) / 8.0), 0.0, 1.0);
  outPacked = vec4(clamp(rgb, 0.0, 1.0), max(mNorm, 1.0 / 255.0));
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
  if (cur.a < sComp.a - 0.015) {
    vec3 cStr = cur.rgb / max(cur.a, 0.0001);
    vec3 sStr = sComp.rgb / max(sComp.a, 0.0001);
    if (length(cStr - sStr) < 0.07) {
      float keep = clamp(cur.a / max(sComp.a, 0.002), 0.0, 1.0);
      outBaseBg = sBase * keep;
      outDryPig = vec4(sDry.rgb, sDry.a * keep);
      return;
    }
  }

  // Non-Sumi paint/smudge altered this pixel into 'cur'; keep 'cur' as authoritative baseBg and drop dryPig to avoid double-compositing outlines.
  outBaseBg = cur;
  outDryPig = vec4(0.0);
}`;

// Liquify backward displacement warp for Sumi-e passive dryPig & baseBg tiles
const LIQUIFY_SUMI_WARP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_workDisp;
uniform sampler2D u_srcTile;
uniform vec2 u_dispOrigin;
uniform float u_dispWorldSize;
uniform vec4 u_dispClamp;
uniform vec4 u_dstWorldRect;
uniform vec4 u_srcWorldBounds;
uniform int u_isFloatData;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 worldPos = u_dstWorldRect.xy + v_uv * u_dstWorldRect.zw;
  vec2 dUv = (worldPos - u_dispOrigin) / u_dispWorldSize;
  vec2 disp = texture(u_workDisp, clamp(dUv, u_dispClamp.xy, u_dispClamp.zw)).xy;
  vec2 srcWorld = worldPos - disp;
  vec2 srcUv = (srcWorld - u_srcWorldBounds.xy) / max(u_srcWorldBounds.zw - u_srcWorldBounds.xy, vec2(1.0));
  if (srcUv.x < 0.0 || srcUv.x >= 1.0 || srcUv.y < 0.0 || srcUv.y >= 1.0) {
    discard;
  }
  vec4 c = texture(u_srcTile, srcUv);
  if (u_isFloatData == 1 && c.a <= 0.0001) {
    outColor = vec4(0.0);
    return;
  }
  outColor = c;
}`;

const PORE_SMUDGE_PICKUP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_workDry;
uniform sampler2D u_workBase;
uniform sampler2D u_prevDry;
uniform sampler2D u_prevBase;
uniform sampler2D u_tip;
uniform vec2 u_workOrigin;
uniform vec2 u_workTexSize;
uniform vec4 u_uvClamp;
uniform vec2 u_stampPos;
uniform float u_radius;
uniform float u_cosFwd;
uniform float u_sinFwd;
uniform float u_pickupBase;
uniform int u_isFirstPickup;
uniform int u_physicalMix;

${GLSL_RYB_MIX}

layout(location = 0) out vec4 outDry;
layout(location = 1) out vec4 outBase;

vec4 sampleDryBilinear(sampler2D tex, vec2 uv, vec2 texSize, vec4 uvClamp) {
  vec2 p = uv * texSize - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec2 invSz = 1.0 / texSize;
  vec4 c00 = texture(tex, clamp((i0 + 0.5) * invSz, uvClamp.xy, uvClamp.zw));
  vec4 c10 = texture(tex, clamp((i0 + vec2(1.5, 0.5)) * invSz, uvClamp.xy, uvClamp.zw));
  vec4 c01 = texture(tex, clamp((i0 + vec2(0.5, 1.5)) * invSz, uvClamp.xy, uvClamp.zw));
  vec4 c11 = texture(tex, clamp((i0 + vec2(1.5, 1.5)) * invSz, uvClamp.xy, uvClamp.zw));
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  float m = c00.a * w00 + c10.a * w10 + c01.a * w01 + c11.a * w11;
  if (m <= 0.00005) return vec4(0.0);
  vec3 col = (c00.rgb * (c00.a * w00) + c10.rgb * (c10.a * w10) + c01.rgb * (c01.a * w01) + c11.rgb * (c11.a * w11)) / m;
  return vec4(clamp(col, 0.0, 1.0), m);
}

void main() {
  vec2 n = v_uv * 2.0 - 1.0;
  vec2 local = n * u_radius;
  vec2 worldPos = u_stampPos + vec2(
    local.x * u_cosFwd - local.y * u_sinFwd,
    local.x * u_sinFwd + local.y * u_cosFwd
  );
  vec2 workUv = clamp((worldPos - u_workOrigin) / float(${WORK_RES}.0), u_uvClamp.xy, u_uvClamp.zw);
  vec4 sampDry = sampleDryBilinear(u_workDry, workUv, u_workTexSize, u_uvClamp);
  vec4 sampBase = texture(u_workBase, workUv);

  if (u_isFirstPickup == 1) {
    outDry = sampDry;
    outBase = sampBase;
    return;
  }

  vec4 prevDry = texture(u_prevDry, v_uv);
  vec4 prevBase = texture(u_prevBase, v_uv);
  if (u_pickupBase <= 0.001) {
    outDry = prevDry;
    outBase = prevBase;
    return;
  }

  float mask = texture(u_tip, v_uv).r;
  if (mask <= 0.002) {
    outDry = prevDry;
    outBase = prevBase;
    return;
  }

  float p = clamp(u_pickupBase * (0.25 + 0.75 * mask), 0.0, 1.0);
  float nextM = mix(prevDry.a, sampDry.a, p);
  if (nextM <= 0.00005) {
    outDry = vec4(0.0);
  } else {
    float wd = prevDry.a * (1.0 - p);
    float ws = sampDry.a * p;
    float wSum = wd + ws;
    float mixT = wSum > 0.00001 ? clamp(ws / wSum, 0.0, 1.0) : 0.0;
    vec3 nextCol = prevDry.a <= 0.00005
      ? sampDry.rgb
      : (sampDry.a <= 0.00005 ? prevDry.rgb : clamp(mixPaintCol(prevDry.rgb, sampDry.rgb, mixT, u_physicalMix), 0.0, 1.0));
    outDry = vec4(nextCol, nextM);
  }

  outBase = mixPremulPaint(prevBase, sampBase, p, u_physicalMix);
}`;

const PORE_SMUDGE_DEPOSIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_workDry;
uniform sampler2D u_workBase;
uniform sampler2D u_bufDry;
uniform sampler2D u_bufBase;
uniform sampler2D u_tip;
uniform vec2 u_workOrigin;
uniform vec2 u_stampPos;
uniform float u_radius;
uniform float u_cosInv;
uniform float u_sinInv;
uniform float u_depositBase;
uniform int u_alphaLock;
uniform int u_physicalMix;

${GLSL_RYB_MIX}

layout(location = 0) out vec4 outDry;
layout(location = 1) out vec4 outBase;

vec4 sampleBufDryBilinear(sampler2D tex, vec2 uv) {
  vec2 texSize = vec2(64.0, 64.0);
  vec2 p = uv * texSize - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec2 invSz = 1.0 / texSize;
  vec4 c00 = texture(tex, clamp((i0 + 0.5) * invSz, vec2(0.0078125), vec2(0.9921875)));
  vec4 c10 = texture(tex, clamp((i0 + vec2(1.5, 0.5)) * invSz, vec2(0.0078125), vec2(0.9921875)));
  vec4 c01 = texture(tex, clamp((i0 + vec2(0.5, 1.5)) * invSz, vec2(0.0078125), vec2(0.9921875)));
  vec4 c11 = texture(tex, clamp((i0 + vec2(1.5, 1.5)) * invSz, vec2(0.0078125), vec2(0.9921875)));
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  float m = c00.a * w00 + c10.a * w10 + c01.a * w01 + c11.a * w11;
  if (m <= 0.00005) return vec4(0.0);
  vec3 col = (c00.rgb * (c00.a * w00) + c10.rgb * (c10.a * w10) + c01.rgb * (c01.a * w01) + c11.rgb * (c11.a * w11)) / m;
  return vec4(clamp(col, 0.0, 1.0), m);
}

void main() {
  vec4 dstDry = texture(u_workDry, v_uv);
  vec4 dstBase = texture(u_workBase, v_uv);

  if (u_depositBase <= 0.001) {
    outDry = dstDry;
    outBase = dstBase;
    return;
  }

  vec2 worldPos = u_workOrigin + v_uv * float(${WORK_RES}.0);
  vec2 d = worldPos - u_stampPos;
  vec2 local = vec2(
    d.x * u_cosInv - d.y * u_sinInv,
    d.x * u_sinInv + d.y * u_cosInv
  );
  vec2 n = local / max(2.0, u_radius);
  if (n.x <= -1.0 || n.x >= 1.0 || n.y <= -1.0 || n.y >= 1.0) {
    outDry = dstDry;
    outBase = dstBase;
    return;
  }

  vec2 tipUv = n * 0.5 + 0.5;
  float mask = texture(u_tip, tipUv).r;
  if (mask <= 0.002) {
    outDry = dstDry;
    outBase = dstBase;
    return;
  }

  vec4 carDry = sampleBufDryBilinear(u_bufDry, tipUv);
  vec4 carBase = texture(u_bufBase, tipUv);
  float w = clamp(u_depositBase * mask, 0.0, 1.0);

  if (u_alphaLock == 1) {
    if (dstDry.a > 0.0001 && carDry.a > 0.0001) {
      float wd = dstDry.a * (1.0 - w);
      float ws = carDry.a * w;
      float mixT = clamp(ws / max(wd + ws, 0.00001), 0.0, 1.0);
      outDry = vec4(clamp(mixPaintCol(dstDry.rgb, carDry.rgb, mixT, u_physicalMix), 0.0, 1.0), dstDry.a);
    } else {
      outDry = dstDry;
    }
    if (dstBase.a > 0.002 && carBase.a > 0.002) {
      vec3 dCol = dstBase.rgb / dstBase.a;
      vec3 cCol = carBase.rgb / carBase.a;
      vec3 mixCol = clamp(mixPaintCol(dCol, cCol, w, u_physicalMix), 0.0, 1.0);
      outBase = vec4(mixCol * dstBase.a, dstBase.a);
    } else {
      outBase = dstBase;
    }
    return;
  }

  float nextM = mix(dstDry.a, carDry.a, w);
  if (nextM <= 0.00005) {
    outDry = vec4(0.0);
  } else {
    float wd = dstDry.a * (1.0 - w);
    float ws = carDry.a * w;
    float wSum = wd + ws;
    float mixT = wSum > 0.00001 ? clamp(ws / wSum, 0.0, 1.0) : 0.0;
    vec3 nextCol = dstDry.a <= 0.00005
      ? carDry.rgb
      : (carDry.a <= 0.00005 ? dstDry.rgb : clamp(mixPaintCol(dstDry.rgb, carDry.rgb, mixT, u_physicalMix), 0.0, 1.0));
    outDry = vec4(nextCol, nextM);
  }

  vec4 nextBase = clamp(mixPremulPaint(dstBase, carBase, w, u_physicalMix), 0.0, 1.0);
  nextBase.rgb = min(nextBase.rgb, vec3(nextBase.a));
  outBase = nextBase;
}`;

const SEL_MASK_RECT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec4 u_srcRect;
uniform vec4 u_dstRect;
uniform vec4 u_uvSubRect;
out vec2 v_uv;
out vec2 v_dstUv;
void main() {
  vec2 world = u_srcRect.xy + a_pos * u_srcRect.zw;
  vec2 dstNorm = (world - u_dstRect.xy) / max(u_dstRect.zw, vec2(1.0));
  gl_Position = vec4(dstNorm * 2.0 - 1.0, 0.0, 1.0);
  v_uv = u_uvSubRect.xy + a_pos * u_uvSubRect.zw;
  v_dstUv = dstNorm;
}`;

const SEL_MASK_EXTRACT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_dstUv;
uniform sampler2D u_srcTex;
uniform sampler2D u_mask;
uniform int u_isFloatDry;
out vec4 outColor;
void main() {
  float m = clamp(texture(u_mask, v_dstUv).a, 0.0, 1.0);
  if (m <= 0.002) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texture(u_srcTex, v_uv);
  if (u_isFloatDry == 1) {
    float outM = c.a * m;
    if (outM <= 0.00005) {
      outColor = vec4(0.0);
      return;
    }
    outColor = vec4(clamp(c.rgb, 0.0, 1.0), outM);
  } else {
    outColor = c * m;
  }
}`;

const SEL_TILE_MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cur;
uniform sampler2D u_before;
uniform sampler2D u_mask;
uniform vec4 u_tileRect;
uniform vec4 u_maskRect;
uniform int u_hasBefore;
uniform int u_isFloatDry;
out vec4 outColor;
void main() {
  vec4 cur = texture(u_cur, v_uv);
  vec4 bef = u_hasBefore == 1 ? texture(u_before, v_uv) : vec4(0.0);
  vec2 world = u_tileRect.xy + v_uv * u_tileRect.zw;
  vec2 mUv = (world - u_maskRect.xy) / max(u_maskRect.zw, vec2(1.0));
  float m = (mUv.x >= 0.0 && mUv.x <= 1.0 && mUv.y >= 0.0 && mUv.y <= 1.0)
    ? clamp(texture(u_mask, mUv).a, 0.0, 1.0)
    : 0.0;
  if (m >= 0.998) {
    outColor = cur;
    return;
  }
  if (m <= 0.002) {
    outColor = bef;
    return;
  }
  if (u_isFloatDry == 1) {
    float outM = mix(bef.a, cur.a, m);
    if (outM <= 0.00005) {
      outColor = vec4(0.0);
      return;
    }
    float wb = bef.a * (1.0 - m);
    float wc = cur.a * m;
    vec3 col = (bef.rgb * wb + cur.rgb * wc) / max(wb + wc, 0.00001);
    outColor = vec4(clamp(col, 0.0, 1.0), outM);
  } else {
    outColor = mix(bef, cur, m);
  }
}`;

const SEL_PIN_WARP_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_dstNorm;
layout(location = 1) in vec2 a_srcUv;
out vec2 v_srcUv;
void main() {
  v_srcUv = a_srcUv;
  gl_Position = vec4(a_dstNorm * 2.0 - 1.0, 0.0, 1.0);
}`;

const SEL_PIN_WARP_FS = `#version 300 es
precision highp float;
in vec2 v_srcUv;
uniform sampler2D u_srcTex;
uniform vec2 u_srcTexSize;
uniform int u_isFloatDry;
out vec4 outColor;

vec4 sampleDryBilinear(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 p = uv * texSize - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec2 invSz = 1.0 / texSize;
  vec2 cMin = invSz * 0.5;
  vec2 cMax = vec2(1.0) - cMin;
  vec4 c00 = texture(tex, clamp((i0 + 0.5) * invSz, cMin, cMax));
  vec4 c10 = texture(tex, clamp((i0 + vec2(1.5, 0.5)) * invSz, cMin, cMax));
  vec4 c01 = texture(tex, clamp((i0 + vec2(0.5, 1.5)) * invSz, cMin, cMax));
  vec4 c11 = texture(tex, clamp((i0 + vec2(1.5, 1.5)) * invSz, cMin, cMax));
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  float m = c00.a * w00 + c10.a * w10 + c01.a * w01 + c11.a * w11;
  if (m <= 0.00005) return vec4(0.0);
  vec3 col = (c00.rgb * (c00.a * w00) + c10.rgb * (c10.a * w10) + c01.rgb * (c01.a * w01) + c11.rgb * (c11.a * w11)) / m;
  return vec4(clamp(col, 0.0, 1.0), m);
}

void main() {
  if (v_srcUv.x <= 0.0002 || v_srcUv.x >= 0.9998 || v_srcUv.y <= 0.0002 || v_srcUv.y >= 0.9998) {
    discard;
  }
  if (u_isFloatDry == 1) {
    outColor = sampleDryBilinear(u_srcTex, v_srcUv, u_srcTexSize);
  } else {
    vec2 cMin = 0.5 / max(u_srcTexSize, vec2(1.0));
    outColor = texture(u_srcTex, clamp(v_srcUv, cMin, 1.0 - cMin));
  }
}`;

const SEL_STAMP_COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_dstDry;
uniform sampler2D u_dstBase;
uniform sampler2D u_srcDry;
uniform sampler2D u_srcBase;
uniform vec4 u_dstTileRect;
uniform vec2 u_pivot;
uniform float u_cosRot;
uniform float u_sinRot;
uniform float u_invScaleX;
uniform float u_invScaleY;
uniform vec2 u_drawSize;
uniform vec2 u_srcDryTexSize;
uniform float u_opacity;
uniform int u_hasSrcBase;

layout(location = 0) out vec4 outDry;
layout(location = 1) out vec4 outBase;

vec4 sampleDryBilinear(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 p = uv * texSize - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec2 invSz = 1.0 / texSize;
  vec2 cMin = invSz * 0.5;
  vec2 cMax = vec2(1.0) - cMin;
  vec4 c00 = texture(tex, clamp((i0 + 0.5) * invSz, cMin, cMax));
  vec4 c10 = texture(tex, clamp((i0 + vec2(1.5, 0.5)) * invSz, cMin, cMax));
  vec4 c01 = texture(tex, clamp((i0 + vec2(0.5, 1.5)) * invSz, cMin, cMax));
  vec4 c11 = texture(tex, clamp((i0 + vec2(1.5, 1.5)) * invSz, cMin, cMax));
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  float m = c00.a * w00 + c10.a * w10 + c01.a * w01 + c11.a * w11;
  if (m <= 0.00005) return vec4(0.0);
  vec3 col = (c00.rgb * (c00.a * w00) + c10.rgb * (c10.a * w10) + c01.rgb * (c01.a * w01) + c11.rgb * (c11.a * w11)) / m;
  return vec4(clamp(col, 0.0, 1.0), m);
}

void main() {
  vec4 dstDry = texture(u_dstDry, v_uv);
  vec4 dstBase = texture(u_dstBase, v_uv);

  vec2 worldPos = u_dstTileRect.xy + v_uv * u_dstTileRect.zw;
  vec2 d = worldPos - u_pivot;
  float ux = d.x * u_cosRot + d.y * u_sinRot;
  float uy = -d.x * u_sinRot + d.y * u_cosRot;
  vec2 c = vec2(ux * u_invScaleX, uy * u_invScaleY);
  vec2 selUv = c / max(u_drawSize, vec2(1.0)) + 0.5;

  if (selUv.x <= 0.0002 || selUv.x >= 0.9998 || selUv.y <= 0.0002 || selUv.y >= 0.9998) {
    outDry = dstDry;
    outBase = dstBase;
    return;
  }

  vec4 srcDry = sampleDryBilinear(u_srcDry, selUv, u_srcDryTexSize);
  vec4 srcBase = u_hasSrcBase == 1 ? texture(u_srcBase, selUv) : vec4(0.0);

  if (srcDry.a <= 0.00005 && srcBase.a <= 0.001) {
    outDry = dstDry;
    outBase = dstBase;
    return;
  }

  float sM = srcDry.a * u_opacity;
  float covMask = clamp(max(srcBase.a, clamp(srcDry.a / 1.5, 0.0, 1.0)) * u_opacity, 0.0, 1.0);
  float dM = dstDry.a * (1.0 - covMask);
  float outM = clamp(dM + sM, 0.0, 8.0);
  if (outM <= 0.00005) {
    outDry = vec4(0.0);
  } else {
    vec3 col = (dstDry.rgb * dM + srcDry.rgb * sM) / max(dM + sM, 0.00001);
    outDry = vec4(clamp(col, 0.0, 1.0), outM);
  }

  vec4 sB = srcBase * u_opacity;
  outBase = clamp(sB + dstBase * (1.0 - sB.a), 0.0, 1.0);
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
    this._strokeSeq = 0;
    this._currentSumiBefore = null;
    this._recordedBeforeKeys = null;
    this._activeHistoryAction = null;
    this._tileTick = 0;
    this._passiveTick = 0;
    this._probeTick = 0;
    this._activeWetCount = 0;
    this._activeSolverCount = 0;
    this._hasCpuDirty = false;
    this._needsDryOnClose = false;
    this.lastParams = {};

    this.solverQuality = 3;
    const preset = SOLVER_PRESETS[3];
    this.tileRes = preset.tileRes;
    this.workRes = preset.workRes;
    this.simScale = preset.simScale;
    this.texelWorld = preset.texelWorld;
    this.snapWorld = preset.snapWorld;
    this.jacobiCurve = preset.jacobi;
    this.maxPoolTiles = preset.maxPoolTiles;
    this.maxActiveWet = preset.maxActiveWet;
    this.maxPassiveTiles = preset.maxPassiveTiles;

    this.activeTiles = new Map();
    this.passiveTiles = new Map();
    this.tilePool = [];
    this.touchedChunks = new Map();

    this._smudgeActive = false;
    this._smudgeCarriedHasPores = false;
    this._smudgeLayer = -1;
    this._smudgeProjId = null;
    this._smudgeTiles = new Map();
    this._smudgeBefore = new Map();
    this._smudgeTouchedKeys = [];
    this._pendingSmudgeHistory = null;
    this._smudgeBufPP = null;
    this._smudgeTipTex = null;
    this._smudgeTipBytes = null;
    this._smudgeTipVer = -1;
    this._reconcileSubTile = null;
    this._selWarpVao = null;
    this._selWarpVbo = null;
    this._selWarpVerts = null;

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
    this._clusterCursor = 0;

    this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._paddedCommitBuf = new Uint8ClampedArray((TILE_SIZE + 2) * (TILE_SIZE + 2) * 4);
    this._packBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._basePackBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    this._probeBuf = new Uint8Array(36);
    this._wetProbeBuf = new Uint8Array(8 * 8 * 4);
    this._commitCanvas = document.createElement('canvas');
    this._commitCanvas.width = TILE_SIZE + 2;
    this._commitCanvas.height = TILE_SIZE + 2;
    this._commitCtx = this._commitCanvas.getContext('2d', { willReadFrequently: true });

    this._pboSupported = !!(this.gl && typeof WebGL2RenderingContext !== 'undefined' && (this.gl instanceof WebGL2RenderingContext));
    this._syncPboRing = [];
    this._inFlightSyncs = [];
    this._probePboRing = [];
    this._inFlightProbes = [];
    this._packPboRing = [];
    this._inFlightPacks = [];
    this._packTexPool = [];
    this._pendingPacks = [];

    this._tileWriteGen = 0;
    this._passiveDirtyProjs = new Set();
    this._passiveWriteGenByProj = new Map();
    this._passiveSavedStateByProj = new Map();
    this._chunkBackupPboRing = [];
    this._chunkBackupPboBytes = 0;
    this._inFlightChunkBackups = [];
    this._backupUnpremultFbo = null;
    this._backupReadBuf = null;
    this._largeBackupPboRing = [];
    this._largeBackupPboBytes = 0;
    this._largeBackupUnpremultFbo = null;
    this._largeBackupReadBuf = null;
    this._inChunkBackup = false;
    this._deferBackupFlush = false;
    this._queuedBackupFlush = false;
    this._inSyncOuter = false;
    this._boxCursor = 0;
    this._simSweepCount = 0;
    this._lastStepSimBoxes = 0;
    this._lastStampBoxCount = 0;
    this._lastStampRanPhysics = false;
    this._lastStampEndTime = 0;
    this._lastStampElapsedMs = 0;
    this._lastSimStepMs = 0;
    this._consecutiveSimSkips = 0;
    this._secStarveCount = 0;
    this._lastSyncPumpMs = 0;
    this._retireDryQueue = new Set();

    this._instSegData = new Float32Array(MAX_INSTANCES * 4);
    this._instPropData = new Float32Array(MAX_INSTANCES * 4);

    if (this.gl) {
      this._init();
    }
  }

  _getPerfStats(engine) {
    return engine && engine.perfMonitor ? engine.perfMonitor.sumiFrameStats : null;
  }

  _snapContextStats(engine, wetOverride = -1) {
    const s = this._getPerfStats(engine);
    if (!s) return;
    s.activeTiles = this.activeTiles.size;
    if (wetOverride >= 0) {
      s.wetTiles = wetOverride;
    } else {
      let wc = 0;
      this.activeTiles.forEach((t) => { if (t.wetTicks > 0) wc++; });
      s.wetTiles = wc;
    }
    s.passiveTiles = this.passiveTiles.size;
    s.inFlightSyncs = this._inFlightSyncs.length;
    s.inFlightBackups = this._inFlightChunkBackups.length;
    s.retireQueue = this._retireDryQueue ? this._retireDryQueue.size : 0;
    s.isStatic = !!(engine && engine.isStatic);
    s.canvasDim = engine
      ? (engine.isStatic ? `${engine.staticWidth}x${engine.staticHeight}` : `${engine.chunkSize}x${engine.chunkSize}`)
      : '';
    s.zoom = engine ? (engine.zoom || 1) : 1;
    s.quality = this.solverQuality || 3;
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
    return { tex, fbo, w, h };
  }

  _delTexFBO(t) {
    if (!t || !this.gl) return;
    if (t.tex) this.gl.deleteTexture(t.tex);
    if (t.fbo) this.gl.deleteFramebuffer(t.fbo);
  }

  _makeWorkPingPong(internalFormat, format, type, filter) {
    const r = this.workRes;
    return {
      idx: 0,
      a: this._makeTexFBO(r, r, internalFormat, format, type, filter),
      b: this._makeTexFBO(r, r, internalFormat, format, type, filter),
      read() { return this.idx === 0 ? this.a : this.b; },
      write() { return this.idx === 0 ? this.b : this.a; },
      swap() { this.idx = 1 - this.idx; }
    };
  }

  _testFboFmt(internalFormat, format, type, filter) {
    const gl = this.gl;
    const probe = this._makeTexFBO(4, 4, internalFormat, format, type, filter);
    gl.bindFramebuffer(gl.FRAMEBUFFER, probe.fbo);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._delTexFBO(probe);
    return ok;
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

    // Compact float channel formats when supported by GPU/driver
    const canRG16F = hasColorFloat && this._testFboFmt(gl.RG16F, gl.RG, gl.HALF_FLOAT, floatFilter);
    const canR16F = hasColorFloat && this._testFboFmt(gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    this._velFmt = canRG16F
      ? { internal: gl.RG16F, fmt: gl.RG, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };
    this._scalarFmt = canR16F
      ? { internal: gl.R16F, fmt: gl.RED, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };

    this.progRectMap = this._compileProg(RECT_MAP_VS, RECT_MAP_FS, 'rectMap');
    this.progUnpremult = this._compileProg(QUAD_VS, UNPREMULT_FS, 'unpremult');
    this.progUnpremultRect = this._compileProg(RECT_MAP_VS, UNPREMULT_FS, 'unpremultRect');
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
    this.progWetProbe = this._compileProg(QUAD_VS, WET_PROBE_FRAG, 'wetProbe');
    this.progPackDry = this._compileProg(QUAD_VS, PACK_DRY_FRAG, 'packDry');
    this.progUnpackDry = this._compileProg(QUAD_VS, UNPACK_DRY_FRAG, 'unpackDry');
    this.progReconcile = this._compileProg(QUAD_VS, RECONCILE_PASSIVE_FRAG, 'reconcile');
    this.progLiquifyWarp = this._compileProg(QUAD_VS, LIQUIFY_SUMI_WARP_FRAG, 'liquifyWarp');
    this.progPoreSmudgePickup = this._compileProg(QUAD_VS, PORE_SMUDGE_PICKUP_FS, 'poreSmudgePickup');
    this.progPoreSmudgeDeposit = this._compileProg(QUAD_VS, PORE_SMUDGE_DEPOSIT_FS, 'poreSmudgeDeposit');
    this.progSelMaskExtract = this._compileProg(SEL_MASK_RECT_VS, SEL_MASK_EXTRACT_FS, 'selMaskExtract');
    this.progSelTileMask = this._compileProg(QUAD_VS, SEL_TILE_MASK_FS, 'selTileMask');
    this.progSelPinWarp = this._compileProg(SEL_PIN_WARP_VS, SEL_PIN_WARP_FS, 'selPinWarp');
    this.progSelStampComp = this._compileProg(QUAD_VS, SEL_STAMP_COMP_FS, 'selStampComp');

    if (
      !this.progRectMap || !this.progUnpremult || !this.progUnpremultRect || !this.progSubBake || !this.progBristle ||
      !this.progRewet || !this.progBrushApply || !this.progVelAdvect ||
      !this.progDiv || !this.progPress || !this.progGradSub ||
      !this.progSurfStep || !this.progBaseStep || !this.progSurfSeep ||
      !this.progPerc || !this.progComp || !this.progEdgeProbe || !this.progWetProbe ||
      !this.progPackDry || !this.progUnpackDry || !this.progReconcile || !this.progLiquifyWarp ||
      !this.progPoreSmudgePickup || !this.progPoreSmudgeDeposit || !this.progSelMaskExtract ||
      !this.progSelTileMask || !this.progSelPinWarp || !this.progSelStampComp
    ) {
      return;
    }

    if (!this._allocateResBuffers()) {
      return;
    }

    this._uploadDryByRes = {};
    this._uploadBaseByRes = {};
    for (const r of [128, 192, 256]) {
      this._uploadDryByRes[r] = this._makeTexFBO(r, r, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      this._uploadBaseByRes[r] = this._makeTexFBO(r, r, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    }
    this.texProbe = this._makeTexFBO(3, 3, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texCenterProbe = this._makeTexFBO(8, 8, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);

    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 0]));
    gl.bindTexture(gl.TEXTURE_2D, null);

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

    if (this._pboSupported) {
      this._initPboRings();
    }

    const u = (prog, names) => {
      const o = {};
      for (const n of names) o[n] = gl.getUniformLocation(prog, n);
      return o;
    };

    this.locRectMap = u(this.progRectMap, ['u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_tex']);
    this.locUnpremult = u(this.progUnpremult, ['u_tex']);
    this.locUnpremultRect = u(this.progUnpremultRect, ['u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_tex']);
    this.locSubBake = u(this.progSubBake, [
      'u_surfaceMap', 'u_poreMap',
      'u_hasSurface', 'u_useHeightmap', 'u_heightSource', 'u_surfaceInvScale',
      'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_sizing', 'u_coarseness', 'u_workOrigin', 'u_texelToWorld'
    ]);
    this.locBristle = u(this.progBristle, ['u_invWorkRes', 'u_minRadius']);
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
      'u_surfSlip', 'u_surfChannel', 'u_texel', 'u_worldTexel', 'u_texelToWorld',
      'u_gradScale', 'u_uvClamp', 'u_workOrigin', 'u_dt', 'u_glueVisc', 'u_turb', 'u_time',
      'u_bleedRate', 'u_bleedResist', 'u_bleedBypass'
    ]);
    this.locDiv = u(this.progDiv, ['u_vel', 'u_texel', 'u_uvClamp']);
    this.locPress = u(this.progPress, ['u_press', 'u_div', 'u_texel', 'u_uvClamp']);
    this.locGradSub = u(this.progGradSub, ['u_press', 'u_vel', 'u_texel', 'u_uvClamp']);
    this.locSurfStep = u(this.progSurfStep, [
      'u_surf', 'u_surfPig', 'u_vel', 'u_texel', 'u_worldTexel', 'u_diffScale', 'u_uvClamp',
      'u_dt', 'u_backrunRim', 'u_evapRate', 'u_maxWater', 'u_forceDry',
      'u_bleedRate', 'u_bleedResist', 'u_bleedBypass'
    ]);
    this.locBaseStep = u(this.progBaseStep, [
      'u_baseBg', 'u_surf', 'u_vel', 'u_pore', 'u_sub',
      'u_texel', 'u_worldTexel', 'u_diffScale', 'u_uvClamp', 'u_dt', 'u_glueVisc', 'u_alphaLock',
      'u_bleedRate', 'u_bleedResist', 'u_bleedBypass'
    ]);
    this.locSurfSeep = u(this.progSurfSeep, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_sub',
      'u_seepRate', 'u_sootSnag', 'u_maxWater', 'u_dt', 'u_forceDry',
      'u_bleedResist', 'u_bleedBypass'
    ]);
    this.locPerc = u(this.progPerc, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_sub',
      'u_capillarity', 'u_evapRate', 'u_backrunRim', 'u_maxWater', 'u_sootSnag',
      'u_texel', 'u_diffScale', 'u_uvClamp', 'u_dt', 'u_forceDry',
      'u_bleedRate', 'u_bleedResist', 'u_bleedBypass'
    ]);
    this.locComp = u(this.progComp, [
      'u_surf', 'u_surfPig', 'u_pore', 'u_porePig', 'u_dryPig', 'u_baseBg', 'u_sub',
      'u_inkWarmth', 'u_alphaLock', 'u_unpremult'
    ]);
    this.locEdgeProbe = u(this.progEdgeProbe, ['u_surf', 'u_pore', 'u_innerUv', 'u_bandUv', 'u_probePhase']);
    this.locWetProbe = u(this.progWetProbe, ['u_surf', 'u_pore', 'u_innerUv', 'u_probePhase']);
    this.locPackDry = u(this.progPackDry, ['u_dryPig', 'u_porePig', 'u_surfPig']);
    this.locUnpackDry = u(this.progUnpackDry, ['u_packedDry']);
    this.locReconcile = u(this.progReconcile, [
      'u_curLayer', 'u_savedComp', 'u_savedBase', 'u_savedDry', 'u_hasSavedBase'
    ]);
    this.locLiquifyWarp = u(this.progLiquifyWarp, [
      'u_workDisp', 'u_srcTile', 'u_dispOrigin', 'u_dispWorldSize',
      'u_dispClamp', 'u_dstWorldRect', 'u_srcWorldBounds', 'u_isFloatData'
    ]);
    this.locPoreSmudgePickup = u(this.progPoreSmudgePickup, [
      'u_workDry', 'u_workBase', 'u_prevDry', 'u_prevBase', 'u_tip',
      'u_workOrigin', 'u_workTexSize', 'u_uvClamp', 'u_stampPos', 'u_radius',
      'u_cosFwd', 'u_sinFwd', 'u_pickupBase', 'u_isFirstPickup', 'u_physicalMix'
    ]);
    this.locPoreSmudgeDeposit = u(this.progPoreSmudgeDeposit, [
      'u_workDry', 'u_workBase', 'u_bufDry', 'u_bufBase', 'u_tip',
      'u_workOrigin', 'u_stampPos', 'u_radius', 'u_cosInv', 'u_sinInv',
      'u_depositBase', 'u_alphaLock', 'u_physicalMix'
    ]);
    this.locSelMaskExtract = u(this.progSelMaskExtract, [
      'u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_srcTex', 'u_mask', 'u_isFloatDry'
    ]);
    this.locSelTileMask = u(this.progSelTileMask, [
      'u_cur', 'u_before', 'u_mask', 'u_tileRect', 'u_maskRect', 'u_hasBefore', 'u_isFloatDry'
    ]);
    this.locSelPinWarp = u(this.progSelPinWarp, [
      'u_srcTex', 'u_srcTexSize', 'u_isFloatDry'
    ]);
    this.locSelStampComp = u(this.progSelStampComp, [
      'u_dstDry', 'u_dstBase', 'u_srcDry', 'u_srcBase',
      'u_dstTileRect', 'u_pivot', 'u_cosRot', 'u_sinRot',
      'u_invScaleX', 'u_invScaleY', 'u_drawSize', 'u_srcDryTexSize',
      'u_opacity', 'u_hasSrcBase'
    ]);

    this._pipelinesWarmed = false;
    this.ready = true;
  }

  _initPboRings() {
    const gl = this.gl;
    if (!gl || !this._pboSupported || gl.isContextLost()) return;
    if (this._syncPboRing.length === 0) {
      const maxSyncBytes = TILE_SIZE * TILE_SIZE * 4;
      for (let i = 0; i < PBO_RING_SIZE; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, maxSyncBytes, gl.STREAM_READ);
        this._syncPboRing.push({ pbo, inUse: false });
      }
    }
    if (this._packPboRing.length === 0) {
      const maxPackBytes = TILE_SIZE * TILE_SIZE * 4;
      for (let i = 0; i < PBO_RING_SIZE; i++) {
        const pboDry = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboDry);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, maxPackBytes, gl.STREAM_READ);
        const pboBase = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pboBase);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, maxPackBytes, gl.STREAM_READ);
        this._packPboRing.push({ pboDry, pboBase, inUse: false });
      }
    }
    if (this._probePboRing.length === 0) {
      for (let i = 0; i < PROBE_PBO_RING_SIZE; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, 512, gl.STREAM_READ);
        this._probePboRing.push({ pbo, inUse: false });
      }
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  _destroyResBuffers() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const delPP = (pp) => { if (pp) { this._delTexFBO(pp.a); this._delTexFBO(pp.b); } };
    delPP(this.ppSurf);
    delPP(this.ppSurfPig);
    delPP(this.ppPore);
    delPP(this.ppPorePig);
    delPP(this.ppDryPig);
    delPP(this.ppVel);
    delPP(this.ppPress);
    delPP(this.ppStrokeCov);
    delPP(this.ppBaseBg);
    this._delTexFBO(this.texSub);
    this._delTexFBO(this.texDiv);
    this._delTexFBO(this.texStamp);
    this._delTexFBO(this.texOutput);
    this._delTexFBO(this.texTileUnpremult);
    this._delTexFBO(this.texTileBaseTmp);
    this._delTexFBO(this.texTileDryTmp);
    this._delTexFBO(this._warpDryDst);
    this._warpDryDst = null;
    this._delTexFBO(this._reconcileSubTile);
    this._reconcileSubTile = null;
    for (let i = 0; i < this._packTexPool.length; i++) {
      const p = this._packTexPool[i];
      if (p) {
        this._delTexFBO(p.dry);
        this._delTexFBO(p.base);
      }
    }
    this._packTexPool.length = 0;
  }

  _allocateResBuffers() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return false;
    const floatFilter = this._floatFilter || gl.LINEAR;
    const tr = this.tileRes;
    const wr = this.workRes;
    const vf = this._velFmt || { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };
    const sf = this._scalarFmt || { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };

    this.ppSurf = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppSurfPig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppPore = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppPorePig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppDryPig = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.ppVel = this._makeWorkPingPong(vf.internal, vf.fmt, vf.type, floatFilter);
    this.ppPress = this._makeWorkPingPong(sf.internal, sf.fmt, sf.type, gl.NEAREST);
    this.ppStrokeCov = this._makeWorkPingPong(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.ppBaseBg = this._makeWorkPingPong(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

    this.texSub = this._makeTexFBO(wr, wr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.texDiv = this._makeTexFBO(wr, wr, sf.internal, sf.fmt, sf.type, gl.NEAREST);
    this.texStamp = this._makeTexFBO(wr, wr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    this.texOutput = this._makeTexFBO(wr, wr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.texTileUnpremult = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texTileBaseTmp = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.texTileDryTmp = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppSurf.a.fbo);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[GpuSumiSolver] Float FBO incomplete');
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  setSolverQuality(quality, engine = null) {
    const q = Math.max(1, Math.min(3, Math.round(quality || 3)));
    if (q === this.solverQuality) return false;
    const preset = SOLVER_PRESETS[q] || SOLVER_PRESETS[3];

    if (engine) {
      this.flushPendingSyncs(engine);
      this.flushPendingPacks();
      if (this.active) {
        this.commitToChunks(engine, this.lastParams || {}, true);
      }
    } else {
      this._discardPendingAsync();
    }

    this._releaseAllTiles();
    while (this.tilePool.length > 0) {
      this._destroyTileGpu(this.tilePool.pop());
    }
    this._destroyResBuffers();

    this.solverQuality = preset.quality;
    this.tileRes = preset.tileRes;
    this.workRes = preset.workRes;
    this.simScale = preset.simScale;
    this.texelWorld = preset.texelWorld;
    this.snapWorld = preset.snapWorld;
    this.jacobiCurve = preset.jacobi;
    this.maxPoolTiles = preset.maxPoolTiles;
    this.maxActiveWet = preset.maxActiveWet;
    this.maxPassiveTiles = preset.maxPassiveTiles;

    if (this.ready && this.gl && !this.gl.isContextLost()) {
      this._allocateResBuffers();
      this._pipelinesWarmed = false;
      this.prewarmPipelines(engine);
    }
    return true;
  }

  prewarmPipelines(engine = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;
    if (this._pipelinesWarmed) return;

    const wr = this.workRes;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, wr, wr);
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
    warmQuad(this.progUnpremultRect, this.texTileUnpremult.fbo, () => {
      gl.uniform4f(this.locUnpremultRect.u_srcRect, 0, 0, 64, 64);
      gl.uniform4f(this.locUnpremultRect.u_dstRect, 0, 0, 64, 64);
      gl.uniform4f(this.locUnpremultRect.u_uvSubRect, 0, 0, 1, 1);
      bindTex(0, this.locUnpremultRect.u_tex, dummy);
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
      gl.uniform1f(this.locSubBake.u_texelToWorld, this.texelWorld);
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
      gl.uniform2f(this.locVelAdv.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform2f(this.locVelAdv.u_worldTexel, 1.0 / WORK_RES, 1.0 / WORK_RES);
      gl.uniform1f(this.locVelAdv.u_texelToWorld, this.texelWorld);
      gl.uniform1f(this.locVelAdv.u_gradScale, this.simScale);
      gl.uniform4f(this.locVelAdv.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progDiv, this.texDiv.fbo, () => {
      bindTex(0, this.locDiv.u_vel, this.ppVel.a.tex);
      gl.uniform2f(this.locDiv.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform4f(this.locDiv.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progPress, this.ppPress.b.fbo, () => {
      bindTex(0, this.locPress.u_press, this.ppPress.a.tex);
      bindTex(1, this.locPress.u_div, this.texDiv.tex);
      gl.uniform2f(this.locPress.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform4f(this.locPress.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progGradSub, this.ppVel.b.fbo, () => {
      bindTex(0, this.locGradSub.u_press, this.ppPress.a.tex);
      bindTex(1, this.locGradSub.u_vel, this.ppVel.a.tex);
      gl.uniform2f(this.locGradSub.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform4f(this.locGradSub.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progSurfStep, this.ppSurf.b.fbo, () => {
      bindTex(0, this.locSurfStep.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locSurfStep.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locSurfStep.u_vel, this.ppVel.a.tex);
      gl.uniform2f(this.locSurfStep.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform2f(this.locSurfStep.u_worldTexel, 1.0 / WORK_RES, 1.0 / WORK_RES);
      gl.uniform1f(this.locSurfStep.u_diffScale, this.simScale);
      gl.uniform4f(this.locSurfStep.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progBaseStep, this.ppBaseBg.b.fbo, () => {
      bindTex(0, this.locBaseStep.u_baseBg, this.ppBaseBg.a.tex);
      bindTex(1, this.locBaseStep.u_surf, this.ppSurf.a.tex);
      bindTex(2, this.locBaseStep.u_vel, this.ppVel.a.tex);
      bindTex(3, this.locBaseStep.u_pore, this.ppPore.a.tex);
      bindTex(4, this.locBaseStep.u_sub, this.texSub.tex);
      gl.uniform2f(this.locBaseStep.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform2f(this.locBaseStep.u_worldTexel, 1.0 / WORK_RES, 1.0 / WORK_RES);
      gl.uniform1f(this.locBaseStep.u_diffScale, this.simScale);
      gl.uniform4f(this.locBaseStep.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
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
      gl.uniform2f(this.locPerc.u_texel, 1.0 / wr, 1.0 / wr);
      gl.uniform1f(this.locPerc.u_diffScale, this.simScale);
      gl.uniform4f(this.locPerc.u_uvClamp, 0.01, 0.01, 0.99, 0.99);
    });
    warmQuad(this.progComp, this.texOutput.fbo, () => {
      bindTex(0, this.locComp.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locComp.u_surfPig, this.ppSurfPig.a.tex);
      bindTex(2, this.locComp.u_pore, this.ppPore.a.tex);
      bindTex(3, this.locComp.u_porePig, this.ppPorePig.a.tex);
      bindTex(4, this.locComp.u_dryPig, this.ppDryPig.a.tex);
      bindTex(5, this.locComp.u_baseBg, this.ppBaseBg.a.tex);
      bindTex(6, this.locComp.u_sub, this.texSub.tex);
      gl.uniform1i(this.locComp.u_unpremult, 0);
    });
    warmQuad(this.progEdgeProbe, this.texProbe.fbo, () => {
      bindTex(0, this.locEdgeProbe.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locEdgeProbe.u_pore, this.ppPore.a.tex);
      gl.uniform4f(this.locEdgeProbe.u_innerUv, 0, 0, 0.25, 0.25);
      gl.uniform2f(this.locEdgeProbe.u_bandUv, 28 / WORK_RES, 28 / WORK_RES);
      gl.uniform2f(this.locEdgeProbe.u_probePhase, 0, 0);
    });
    warmQuad(this.progWetProbe, this.texCenterProbe.fbo, () => {
      bindTex(0, this.locWetProbe.u_surf, this.ppSurf.a.tex);
      bindTex(1, this.locWetProbe.u_pore, this.ppPore.a.tex);
      gl.uniform4f(this.locWetProbe.u_innerUv, 0, 0, 0.25, 0.25);
      gl.uniform2f(this.locWetProbe.u_probePhase, 0, 0);
    });
    warmQuad(this.progPackDry, this.texTileUnpremult.fbo, () => {
      bindTex(0, this.locPackDry.u_dryPig, this.texTileDryTmp.tex);
      bindTex(1, this.locPackDry.u_porePig, dummy);
      bindTex(2, this.locPackDry.u_surfPig, dummy);
    });
    const upDry = this._uploadDryByRes?.[this.tileRes]?.tex || dummy;
    const upBase = this._uploadBaseByRes?.[this.tileRes]?.tex || dummy;
    warmQuad(this.progUnpackDry, this.texTileDryTmp.fbo, () => {
      bindTex(0, this.locUnpackDry.u_packedDry, upDry);
    });
    warmQuad(this.progReconcile, this.texTileBaseTmp.fbo, () => {
      bindTex(0, this.locReconcile.u_curLayer, upBase);
      bindTex(1, this.locReconcile.u_savedComp, this.texTileUnpremult.tex);
      bindTex(2, this.locReconcile.u_savedBase, upBase);
      bindTex(3, this.locReconcile.u_savedDry, this.texTileDryTmp.tex);
      gl.uniform1i(this.locReconcile.u_hasSavedBase, 0);
    });
    warmQuad(this.progLiquifyWarp, this.texTileBaseTmp.fbo, () => {
      bindTex(0, this.locLiquifyWarp.u_workDisp, dummy);
      bindTex(1, this.locLiquifyWarp.u_srcTile, upBase);
      gl.uniform2f(this.locLiquifyWarp.u_dispOrigin, 0, 0);
      gl.uniform1f(this.locLiquifyWarp.u_dispWorldSize, 2048);
      gl.uniform4f(this.locLiquifyWarp.u_dispClamp, 0.01, 0.01, 0.99, 0.99);
      gl.uniform4f(this.locLiquifyWarp.u_dstWorldRect, 0, 0, 256, 256);
      gl.uniform4f(this.locLiquifyWarp.u_srcWorldBounds, 0, 0, 256, 256);
      gl.uniform1i(this.locLiquifyWarp.u_isFloatData, 0);
    });

    // Warm instanced bristle program
    if (this.progBristle && this.bristleVao) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.texStamp.fbo);
      gl.useProgram(this.progBristle);
      gl.uniform2f(this.locBristle.u_invWorkRes, 1.0 / WORK_RES, 1.0 / WORK_RES);
      gl.uniform1f(this.locBristle.u_minRadius, Math.max(0.8, 0.72 * this.texelWorld));
      gl.bindVertexArray(this.bristleVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      gl.bindVertexArray(this.gpuRenderer.vao);
    }

    // Prewarm tile patch backup FBO/PBOs and up to 20 pooled tiles before stroke_init
    if (this._pboSupported) {
      this._ensureChunkBackupResources(512, 512, 512 * 512 * 4);
    }
    const warmTileTarget = Math.min(20, this.maxPoolTiles || 20);
    while (this.tilePool.length < warmTileTarget && this.activeTiles.size === 0) {
      this.tilePool.push(this._allocTileGpu());
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    if (!prevScissor) gl.disable(gl.SCISSOR_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._pipelinesWarmed = true;
  }

  _allocTileGpu(resOverride = null) {
    const gl = this.gl;
    const tr = resOverride || this.tileRes;
    const f = this._floatFilter || gl.LINEAR;
    const vf = this._velFmt || { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };
    const baseBg = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const sub = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const surf = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const surfPig = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const pore = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const porePig = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const dryPig = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, f);
    const vel = this._makeTexFBO(tr, tr, vf.internal, vf.fmt, vf.type, f);
    const strokeCov = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    return {
      baseBg, sub, surf, surfPig, pore, porePig, dryPig, vel, strokeCov,
      res: tr,
      tx: 0, ty: 0, wx: 0, wy: 0,
      subKey: '',
      cpuDirty: false, dirty: false,
      loadedFromPassive: false,
      minX: tr, minY: tr, maxX: 0, maxY: 0,
      wMinX: TILE_SIZE, wMinY: TILE_SIZE, wMaxX: 0, wMaxY: 0,
      genDepth: 0,
      wetTicks: 0,
      dryProbes: 0,
      lastUsed: 0,
      _preStrokeSeq: 0,
      _preStrokeSnapshot: null,
      _syncGen: 0
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

  _acquireStagingTile(tr = this.tileRes) {
    while (this.tilePool.length > 0) {
      const cand = this.tilePool.pop();
      if ((cand.res || TILE_SIZE) === tr) return cand;
      this._destroyTileGpu(cand);
    }
    return this._allocTileGpu(tr);
  }

  _releaseStagingTile(tile) {
    if (!tile) return;
    const tr = this.tileRes;
    const poolCap = Math.max(24, (this.maxPoolTiles || 185) + 16);
    if ((tile.res || TILE_SIZE) === tr && this.tilePool.length < poolCap) {
      tile.cpuDirty = false;
      tile.dirty = false;
      tile.loadedFromPassive = false;
      tile.wetTicks = 0;
      tile.dryProbes = 0;
      tile.genDepth = 0;
      tile.minX = tr;
      tile.minY = tr;
      tile.maxX = 0;
      tile.maxY = 0;
      tile.wMinX = TILE_SIZE;
      tile.wMinY = TILE_SIZE;
      tile.wMaxX = 0;
      tile.wMaxY = 0;
      tile.subKey = '';
      tile._preStrokeSeq = 0;
      tile._preStrokeSnapshot = null;
      this.tilePool.push(tile);
    } else {
      this._destroyTileGpu(tile);
    }
  }

  _copyTileChannels(src, dst) {
    const gl = this.gl;
    if (!gl || !src || !dst) return;
    const tr = src.res || this.tileRes;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const pairs = [
      [dst.baseBg.fbo, src.baseBg.tex],
      [dst.surf.fbo, src.surf.tex],
      [dst.surfPig.fbo, src.surfPig.tex],
      [dst.pore.fbo, src.pore.tex],
      [dst.porePig.fbo, src.porePig.tex],
      [dst.dryPig.fbo, src.dryPig.tex],
      [dst.vel.fbo, src.vel.tex],
      [dst.strokeCov.fbo, src.strokeCov.tex]
    ];
    for (let i = 0; i < pairs.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[i][0]);
      gl.bindTexture(gl.TEXTURE_2D, pairs[i][1]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _releaseAllTiles() {
    const tr = this.tileRes;
    this.activeTiles.forEach((tile) => {
      if (this.tilePool.length < this.maxPoolTiles && (tile.res || TILE_SIZE) === tr) {
        tile.cpuDirty = false;
        tile.dirty = false;
        tile.loadedFromPassive = false;
        tile.wetTicks = 0;
        tile.dryProbes = 0;
        tile.genDepth = 0;
        tile.minX = tr;
        tile.minY = tr;
        tile.maxX = 0;
        tile.maxY = 0;
        tile.wMinX = TILE_SIZE;
        tile.wMinY = TILE_SIZE;
        tile.wMaxX = 0;
        tile.wMaxY = 0;
        tile._preStrokeSeq = 0;
        tile._preStrokeSnapshot = null;
        tile._syncGen = (tile._syncGen || 0) + 1;
        this.tilePool.push(tile);
      } else {
        this._destroyTileGpu(tile);
      }
    });
    this.activeTiles.clear();
    this._retireDryQueue.clear();
    this._hasCpuDirty = false;
    this._activeWetCount = 0;
  }

  _getPassiveKey(projId, layer, tx, ty) {
    return `${projId || 'default'}|${layer}|${tx},${ty}`;
  }

  _markPassiveChanged(projId = null) {
    const pid = projId || this.projectId || 'default';
    this._passiveDirtyProjs.add(pid);
    this._passiveWriteGenByProj.set(pid, (this._passiveWriteGenByProj.get(pid) || 0) + 1);
  }

  hasDirtyPassiveForProject(projId, engine = null) {
    const pid = projId || engine?.currentProjectId || this.projectId || 'default';
    if (this._passiveDirtyProjs.has(pid)) return true;
    const saved = this._passiveSavedStateByProj.get(pid);
    const curVer = this._passiveWriteGenByProj.get(pid) || 0;
    if (saved) {
      if (saved.passiveVer !== curVer) return true;
    } else if (curVer > 0) {
      return true;
    }
    if (this.active && (this.projectId || engine?.currentProjectId || 'default') === pid && this.activeTiles.size > 0) {
      const savedTileGen = saved ? saved.tileWriteGen : -1;
      if (savedTileGen !== this._tileWriteGen) {
        for (const t of this.activeTiles.values()) {
          if (t && (t.dirty || t.loadedFromPassive)) return true;
        }
      }
    }
    return false;
  }

  markPassiveSavedForProject(projId, passiveVer = null, tileWriteGen = null) {
    const pid = projId || this.projectId || 'default';
    const curVer = passiveVer !== null ? passiveVer : (this._passiveWriteGenByProj.get(pid) || 0);
    const curTileGen = tileWriteGen !== null ? tileWriteGen : this._tileWriteGen;
    this._passiveDirtyProjs.delete(pid);
    this._passiveSavedStateByProj.set(pid, { passiveVer: curVer, tileWriteGen: curTileGen });
  }

  async exportPassiveArchiveForStorage(engine, projId, options = {}) {
    const pid = projId || engine?.currentProjectId || this.projectId || 'default';
    const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
    const background = !!options.background;
    const passiveVer = this._passiveWriteGenByProj.get(pid) || 0;
    const tileWriteGen = this._tileWriteGen;

    const exportMap = new Map();
    this.passiveTiles.forEach((entry) => {
      if (entry && entry.projId === pid && entry.dryPigBytes) {
        exportMap.set(`${entry.layer}|${entry.tx},${entry.ty}`, {
          ...entry,
          dryPigBytes: entry.dryPigBytes,
          baseBgBytes: entry.baseBgBytes || null
        });
      }
    });

    const gl = this.gl;
    if (
      this.ready &&
      this.active &&
      gl &&
      !gl.isContextLost() &&
      (this.projectId || engine?.currentProjectId || 'default') === pid &&
      this.activeTiles.size > 0
    ) {
      const layer = this.layer >= 0 ? this.layer : (engine?.activeLayer ?? 1);
      const activeSnapshot = Array.from(this.activeTiles.values());
      for (let i = 0; i < activeSnapshot.length; i++) {
        if (shouldAbort && shouldAbort()) {
          return { aborted: true, passiveVer, tileWriteGen, payload: null };
        }
        if (background && i > 0 && (i & 3) === 0) {
          await new Promise(r => setTimeout(r, 0));
          if (shouldAbort && shouldAbort()) {
            return { aborted: true, passiveVer, tileWriteGen, payload: null };
          }
        }
        const tile = activeSnapshot[i];
        if (!tile) continue;
        const tCoordKey = `${tile.tx},${tile.ty}`;
        const subKey = `${layer}|${tCoordKey}`;
        if (this.activeTiles.get(tCoordKey) === tile && tile.dryPig && tile.porePig && tile.surfPig && tile.baseBg) {
          if (tile.dirty || tile.loadedFromPassive) {
            const packed = this._packTileToPassiveEntry(engine, tile, this.lastParams || {}, true);
            if (packed) {
              exportMap.set(subKey, packed);
            } else {
              exportMap.delete(subKey);
            }
          }
        } else {
          const pKey = this._getPassiveKey(pid, layer, tile.tx, tile.ty);
          const refreshed = this.passiveTiles.get(pKey);
          if (refreshed && refreshed.dryPigBytes) {
            exportMap.set(subKey, refreshed);
          } else {
            exportMap.delete(subKey);
          }
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    const entries = [];
    exportMap.forEach((entry) => {
      if (!entry || !entry.dryPigBytes) return;
      const revsMatch = engine ? this._revsMatchPassive(engine, entry.layer, entry) : true;
      const storedRevs = Array.isArray(entry.chunkRevs)
        ? entry.chunkRevs.map(([id]) => [id, revsMatch ? 0 : -1])
        : [];
      entries.push({
        layer: entry.layer,
        tx: entry.tx,
        ty: entry.ty,
        res: this._getPassiveEntryRes(entry),
        dryPigBytes: new Uint8Array(entry.dryPigBytes),
        baseBgBytes: entry.baseBgBytes ? new Uint8Array(entry.baseBgBytes) : null,
        warmth: entry.warmth ?? 12,
        chunkRevs: storedRevs
      });
    });

    return {
      aborted: false,
      passiveVer,
      tileWriteGen,
      payload: entries.length > 0 ? { version: 1, entries } : null
    };
  }

  importPassiveArchiveFromStorage(engine, projId, payload) {
    const pid = projId || engine?.currentProjectId || this.projectId || 'default';
    this.clearPassiveArchive(pid, null, false);
    const list = payload && Array.isArray(payload.entries) ? payload.entries : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !item.dryPigBytes) continue;
      const dryBytes = item.dryPigBytes instanceof Uint8Array
        ? item.dryPigBytes
        : new Uint8Array(item.dryPigBytes);
      const baseBytes = item.baseBgBytes
        ? (item.baseBgBytes instanceof Uint8Array ? item.baseBgBytes : new Uint8Array(item.baseBgBytes))
        : null;
      const layer = Number.isFinite(item.layer) ? item.layer : 1;
      const tx = Number.isFinite(item.tx) ? item.tx : 0;
      const ty = Number.isFinite(item.ty) ? item.ty : 0;
      const key = this._getPassiveKey(pid, layer, tx, ty);
      this.passiveTiles.set(key, {
        key,
        projId: pid,
        layer,
        tx,
        ty,
        res: this._getPassiveEntryRes({ res: item.res, dryPigBytes: dryBytes }),
        dryPigBytes: dryBytes,
        baseBgBytes: baseBytes,
        warmth: Number.isFinite(item.warmth) ? item.warmth : 12,
        chunkRevs: Array.isArray(item.chunkRevs) ? item.chunkRevs : [],
        lastUsed: ++this._passiveTick
      });
    }
    if (list.length > this.maxPassiveTiles) {
      this.maxPassiveTiles = list.length;
    }
    const curVer = this._passiveWriteGenByProj.get(pid) || 0;
    this._passiveDirtyProjs.delete(pid);
    this._passiveSavedStateByProj.set(pid, { passiveVer: curVer, tileWriteGen: this._tileWriteGen });
    return list.length;
  }

  _trimPassiveArchive() {
    while (this.passiveTiles.size > this.maxPassiveTiles) {
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

  clearPassiveArchive(projId = null, layer = null, markDirty = true) {
    if (this.passiveTiles.size === 0) return;
    if (projId === null && layer === null) {
      const affectedProjs = new Set();
      if (markDirty) {
        this.passiveTiles.forEach((entry) => {
          if (entry && entry.projId) affectedProjs.add(entry.projId);
        });
      }
      this.passiveTiles.clear();
      if (markDirty) {
        if (affectedProjs.size === 0) {
          this._markPassiveChanged(this.projectId || 'default');
        } else {
          affectedProjs.forEach((p) => this._markPassiveChanged(p));
        }
      }
      return;
    }
    let removed = false;
    for (const [k, entry] of this.passiveTiles.entries()) {
      if (projId !== null && entry.projId !== projId) continue;
      if (layer !== null && entry.layer !== layer) continue;
      this.passiveTiles.delete(k);
      removed = true;
    }
    if (removed && markDirty) {
      this._markPassiveChanged(projId || this.projectId || 'default');
    }
  }

  _captureTileChunkRevs(engine, layer, wx, wy) {
    const chunkRevs = [];
    const sCX = engine.isStatic ? 0 : Math.floor(wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((wy + TILE_SIZE - 1) / engine.chunkSize);
    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const id = engine.isStatic ? '0,0' : `${cx},${cy}`;
        const ch = engine.isStatic ? engine._getChunk(0, 0) : engine.chunks.get(id);
        chunkRevs.push([id, ch && ch.nonSumiRev ? (ch.nonSumiRev[layer] || 0) : 0]);
      }
    }
    return chunkRevs;
  }

  _acquirePackTexPair(res = this.tileRes) {
    const gl = this.gl;
    for (let i = this._packTexPool.length - 1; i >= 0; i--) {
      const p = this._packTexPool[i];
      if (p && p.res === res) {
        this._packTexPool.splice(i, 1);
        return p;
      }
    }
    return {
      res,
      dry: this._makeTexFBO(res, res, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST),
      base: this._makeTexFBO(res, res, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST)
    };
  }

  _releasePackTexPair(pair) {
    if (!pair) return;
    if (pair.res === this.tileRes && this._packTexPool.length < 24) {
      this._packTexPool.push(pair);
    } else {
      this._delTexFBO(pair.dry);
      this._delTexFBO(pair.base);
    }
  }

  _buildPackEntryFromBytes(job, dryBytes, baseBytes) {
    const byteLen = job.res * job.res * 4;
    let hasDry = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (dryBytes[i] > 0) {
        hasDry = true;
        break;
      }
    }
    if (!hasDry) return null;

    let hasBase = false;
    if (baseBytes) {
      for (let i = 3; i < byteLen; i += 4) {
        if (baseBytes[i] > 2) {
          hasBase = true;
          break;
        }
      }
    }
    return {
      key: job.key,
      projId: job.projId,
      layer: job.layer,
      tx: job.tx,
      ty: job.ty,
      res: job.res,
      dryPigBytes: new Uint8Array(dryBytes.subarray(0, byteLen)),
      baseBgBytes: hasBase ? new Uint8Array(baseBytes.subarray(0, byteLen)) : null,
      warmth: job.warmth,
      chunkRevs: job.chunkRevs,
      lastUsed: ++this._passiveTick
    };
  }

  _queueAsyncTilePack(engine, tile, params = {}, includeWet = true) {
    if (!tile || !engine) return null;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return null;

    const tr = tile.res || this.tileRes;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const key = this._getPassiveKey(projId, layer, tile.tx, tile.ty);
    const pair = this._acquirePackTexPair(tr);

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);

    // 1. Pack dry (+ optional wet) soot on GPU -> pair.dry.fbo (0 blocking readPixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, pair.dry.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.dryPig.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, includeWet ? tile.porePig.tex : this.dummyTex);
    gl.uniform1i(this.locPackDry.u_porePig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, includeWet ? tile.surfPig.tex : this.dummyTex);
    gl.uniform1i(this.locPackDry.u_surfPig, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. Copy tile.baseBg -> pair.base.fbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, pair.base.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.baseBg.tex);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const job = {
      key,
      projId,
      layer,
      tx: tile.tx,
      ty: tile.ty,
      res: tr,
      warmth: params?.warmth ?? this.lastParams?.warmth ?? 12,
      chunkRevs: this._captureTileChunkRevs(engine, layer, tile.wx, tile.wy),
      pair,
      pboSlot: null,
      sync: null,
      resolved: false,
      snapRef: null
    };
    const snap = { entry: null, wasExact: true, _packJob: job };
    job.snapRef = snap;
    this._pendingPacks.push(job);
    this._pumpAsyncPacks(2);
    return snap;
  }

  _pumpAsyncPacks(budget = 4) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    // 1. Drain completed PBO pack readbacks non-blockingly
    let completed = 0;
    while (this._inFlightPacks.length > 0 && completed < budget) {
      const job = this._inFlightPacks[0];
      const status = gl.clientWaitSync(job.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;
      this._inFlightPacks.shift();
      gl.deleteSync(job.sync);
      job.sync = null;

      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        const byteLen = job.res * job.res * 4;
        const drySub = this._packBuf.subarray(0, byteLen);
        const baseSub = this._basePackBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pboSlot.pboDry);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, drySub, 0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pboSlot.pboBase);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, baseSub, 0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        if (job.snapRef) {
          job.snapRef.entry = this._buildPackEntryFromBytes(job, drySub, baseSub);
          job.snapRef._packJob = null;
        }
      }
      if (job.pboSlot) {
        job.pboSlot.inUse = false;
        job.pboSlot = null;
      }
      this._releasePackTexPair(job.pair);
      job.pair = null;
      job.resolved = true;
      completed++;
    }

    // 2. Dispatch queued pack jobs onto free PBO slots
    if (this._pboSupported && this._pendingPacks.length > 0) {
      this._initPboRings();
      let dispatched = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      while (dispatched < 2 && this._pendingPacks.length > 0) {
        let slot = null;
        for (let i = 0; i < this._packPboRing.length; i++) {
          if (!this._packPboRing[i].inUse) {
            slot = this._packPboRing[i];
            break;
          }
        }
        if (!slot) break;

        const job = this._pendingPacks.shift();
        if (!job || job.resolved || !job.pair) continue;
        const tr = job.res;
        slot.inUse = true;
        job.pboSlot = slot;

        gl.bindFramebuffer(gl.FRAMEBUFFER, job.pair.dry.fbo);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pboDry);
        gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, job.pair.base.fbo);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pboBase);
        gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, 0);

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        job.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this._inFlightPacks.push(job);
        dispatched++;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (dispatched > 0) gl.flush();
    }
  }

  _resolvePackSnapshot(snap) {
    if (!snap || !snap._packJob) return snap;
    const job = snap._packJob;
    if (job.resolved) {
      snap._packJob = null;
      return snap;
    }
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      this._releasePackTexPair(job.pair);
      job.pair = null;
      job.resolved = true;
      snap._packJob = null;
      return snap;
    }

    const byteLen = job.res * job.res * 4;
    const drySub = this._packBuf.subarray(0, byteLen);
    const baseSub = this._basePackBuf.subarray(0, byteLen);

    if (job.sync && job.pboSlot) {
      gl.finish();
      gl.deleteSync(job.sync);
      job.sync = null;
      const idx = this._inFlightPacks.indexOf(job);
      if (idx >= 0) this._inFlightPacks.splice(idx, 1);

      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pboSlot.pboDry);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, drySub, 0, byteLen);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pboSlot.pboBase);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, baseSub, 0, byteLen);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      job.pboSlot.inUse = false;
      job.pboSlot = null;
      snap.entry = this._buildPackEntryFromBytes(job, drySub, baseSub);
    } else if (job.pair) {
      const idx = this._pendingPacks.indexOf(job);
      if (idx >= 0) this._pendingPacks.splice(idx, 1);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, job.pair.dry.fbo);
      gl.readPixels(0, 0, job.res, job.res, gl.RGBA, gl.UNSIGNED_BYTE, drySub);
      gl.bindFramebuffer(gl.FRAMEBUFFER, job.pair.base.fbo);
      gl.readPixels(0, 0, job.res, job.res, gl.RGBA, gl.UNSIGNED_BYTE, baseSub);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      snap.entry = this._buildPackEntryFromBytes(job, drySub, baseSub);
    }
    this._releasePackTexPair(job.pair);
    job.pair = null;
    job.resolved = true;
    snap._packJob = null;
    return snap;
  }

  flushPendingPacks() {
    if (this._inFlightPacks.length === 0 && this._pendingPacks.length === 0) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      this._inFlightPacks.length = 0;
      this._pendingPacks.length = 0;
      for (let i = 0; i < this._packPboRing.length; i++) this._packPboRing[i].inUse = false;
      return;
    }
    while (this._inFlightPacks.length > 0) {
      const job = this._inFlightPacks[0];
      if (job && job.snapRef) this._resolvePackSnapshot(job.snapRef);
      else this._inFlightPacks.shift();
    }
    while (this._pendingPacks.length > 0) {
      const job = this._pendingPacks[0];
      if (job && job.snapRef) this._resolvePackSnapshot(job.snapRef);
      else this._pendingPacks.shift();
    }
  }

  _packTileToPassiveEntry(engine, tile, params = {}, includeWet = false) {
    if (!tile || !engine) return null;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return null;
    const tr = tile.res || this.tileRes;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const key = this._getPassiveKey(projId, layer, tile.tx, tile.ty);
    const byteLen = tr * tr * 4;
    const drySub = this._packBuf.subarray(0, byteLen);
    const baseSub = this._basePackBuf.subarray(0, byteLen);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.dryPig.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, includeWet ? tile.porePig.tex : this.dummyTex);
    gl.uniform1i(this.locPackDry.u_porePig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, includeWet ? tile.surfPig.tex : this.dummyTex);
    gl.uniform1i(this.locPackDry.u_surfPig, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, drySub);
    let hasDry = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (drySub[i] > 0) {
        hasDry = true;
        break;
      }
    }
    if (!hasDry) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }

    const dryPigBytes = new Uint8Array(drySub);

    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
    gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, baseSub);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let hasBase = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (baseSub[i] > 2) {
        hasBase = true;
        break;
      }
    }
    const baseBgBytes = hasBase ? new Uint8Array(baseSub) : null;
    const chunkRevs = this._captureTileChunkRevs(engine, layer, tile.wx, tile.wy);

    return {
      key,
      projId,
      layer,
      tx: tile.tx,
      ty: tile.ty,
      res: tr,
      dryPigBytes,
      baseBgBytes,
      warmth: params?.warmth ?? this.lastParams?.warmth ?? 12,
      chunkRevs,
      lastUsed: ++this._passiveTick
    };
  }

  _recordSumiBeforeForTiles(engine, tiles) {
    if (!this._currentSumiBefore || !this._recordedBeforeKeys || !tiles || !engine) return;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t) continue;
      const key = this._getPassiveKey(projId, layer, t.tx, t.ty);
      if (this._recordedBeforeKeys.has(key)) continue;
      this._recordedBeforeKeys.add(key);
      if (t._preStrokeSeq === this._strokeSeq) {
        this._currentSumiBefore.set(key, t._preStrokeSnapshot || null);
      } else {
        const snap = this._queueAsyncTilePack(engine, t, this.lastParams || {}, true);
        this._currentSumiBefore.set(key, snap || null);
      }
    }
  }

  attachHistoryAction(engine, action) {
    if (!action || !engine) return;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    action.isSumiStroke = true;
    action.sumiLayer = layer;
    action.sumiProjId = projId;
    if (!this._currentSumiBefore) {
      this._currentSumiBefore = new Map();
    }
    action.sumiPassive = this._currentSumiBefore;
    this._activeHistoryAction = action;
  }

  _getChunkBackupMap(engine, layer, targetMapOverride = null) {
    if (targetMapOverride) return targetMapOverride;
    if (engine.isDrawing) {
      if (!engine.currentStrokeDirtyChunks) {
        engine.currentStrokeDirtyChunks = new Map();
      }
      return engine.currentStrokeDirtyChunks;
    }
    if (
      this._activeHistoryAction &&
      this._activeHistoryAction.chunks &&
      this._activeHistoryAction.sumiLayer === layer &&
      engine.history &&
      engine.history.length > 0 &&
      engine.history[engine.history.length - 1] === this._activeHistoryAction
    ) {
      return this._activeHistoryAction.chunks;
    }
    return null;
  }

  captureLayerPassiveSnapshot(engine, projId = 'default', layer = 0) {
    const map = new Map();
    this.passiveTiles.forEach((entry, k) => {
      if (entry && entry.projId === projId && entry.layer === layer) {
        map.set(k, { entry, wasExact: engine ? this._revsMatchPassive(engine, layer, entry) : false });
      }
    });
    return map;
  }

  capturePassiveAfterForAction(engine, action) {
    this.flushPendingPacks();
    const result = new Map();
    if (!engine || !action) return result;
    const layer = action.sumiLayer !== undefined ? action.sumiLayer : engine.activeLayer;
    const projId = action.sumiProjId || engine.currentProjectId || 'default';
    const isLiveLayer = this.active && this.layer === layer && (this.projectId || 'default') === projId;

    const captureKey = (key, tx, ty) => {
      if (isLiveLayer) {
        const activeTile = this.activeTiles.get(`${tx},${ty}`);
        if (activeTile) {
          if (activeTile.dirty || activeTile.loadedFromPassive) {
            const packed = this._packTileToPassiveEntry(engine, activeTile, this.lastParams || {}, true);
            result.set(key, packed ? { entry: packed, wasExact: true } : null);
            return;
          }
        }
      }
      const existing = this.passiveTiles.get(key) || null;
      if (existing) {
        result.set(key, {
          entry: existing,
          wasExact: this._revsMatchPassive(engine, layer, existing)
        });
      } else {
        result.set(key, null);
      }
    };

    if (action.sumiPassive) {
      action.sumiPassive.forEach((_val, key) => {
        const sep = key.lastIndexOf('|');
        const coords = sep >= 0 ? key.slice(sep + 1) : '';
        const comma = coords.indexOf(',');
        const tx = comma >= 0 ? Number(coords.slice(0, comma)) : 0;
        const ty = comma >= 0 ? Number(coords.slice(comma + 1)) : 0;
        captureKey(key, tx, ty);
      });
    }

    if (isLiveLayer) {
      this.activeTiles.forEach((tile) => {
        if (!tile || (!tile.dirty && !tile.loadedFromPassive)) return;
        const key = this._getPassiveKey(projId, layer, tile.tx, tile.ty);
        if (!result.has(key)) {
          const packed = this._packTileToPassiveEntry(engine, tile, this.lastParams || {}, true);
          result.set(key, packed ? { entry: packed, wasExact: true } : null);
          if (action.sumiPassive && !action.sumiPassive.has(key)) {
            action.sumiPassive.set(key, null);
          }
        }
      });
    }

    if (this.gl && !this.gl.isContextLost()) {
      this.gl.enable(this.gl.BLEND);
      this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    }
    return result;
  }

  restorePassiveSnapshot(engine, snapshotMap, layerOverride = null) {
    if (!snapshotMap) return;
    const layer = layerOverride !== null && layerOverride !== undefined ? layerOverride : engine?.activeLayer;
    let touched = false;
    const fallbackProj = engine?.currentProjectId || this.projectId || 'default';
    const touchedProjs = new Set();
    snapshotMap.forEach((snap, key) => {
      if (snap && snap._packJob) {
        this._resolvePackSnapshot(snap);
      }
      const sep = key.indexOf('|');
      const keyProj = sep > 0 ? key.slice(0, sep) : fallbackProj;
      touchedProjs.add(keyProj);
      if (!snap || !snap.entry) {
        this.passiveTiles.delete(key);
        touched = true;
        return;
      }
      const entry = snap.entry;
      const chunkRevs = (snap.wasExact && engine && layer >= 0)
        ? this._captureTileChunkRevs(engine, layer, entry.tx * TILE_SIZE, entry.ty * TILE_SIZE)
        : entry.chunkRevs;
      this.passiveTiles.set(key, {
        ...entry,
        chunkRevs,
        lastUsed: ++this._passiveTick
      });
      touched = true;
    });
    if (touched) {
      touchedProjs.forEach((p) => this._markPassiveChanged(p));
      this._trimPassiveArchive();
    }
  }

  _archiveSingleTile(engine, tile, params = {}) {
    if (!tile || !engine || (!tile.dirty && !tile.loadedFromPassive)) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const key = this._getPassiveKey(projId, layer, tile.tx, tile.ty);

    const entry = this._packTileToPassiveEntry(engine, tile, params, true);
    if (!entry) {
      if (this.passiveTiles.delete(key)) {
        this._markPassiveChanged(projId);
      }
      return;
    }
    this.passiveTiles.set(key, entry);
    this._markPassiveChanged(projId);
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

  _getPassiveEntryRes(passive) {
    if (!passive) return this.tileRes;
    if (passive.res && (passive.res === 128 || passive.res === 192 || passive.res === 256)) {
      return passive.res;
    }
    if (passive.dryPigBytes) {
      const px = (passive.dryPigBytes.length / 4) | 0;
      if (px === 128 * 128) return 128;
      if (px === 192 * 192) return 192;
    }
    return TILE_SIZE;
  }

  _hydrateTileFromPassive(engine, tile, passive, layer, hasAnyChunkPixels) {
    const gl = this.gl;
    if (!hasAnyChunkPixels) {
      if (this.passiveTiles.delete(passive.key)) {
        this._markPassiveChanged(passive.projId || this.projectId || engine?.currentProjectId || 'default');
      }
      return false;
    }

    const tr = tile.res || this.tileRes;
    const pRes = this._getPassiveEntryRes(passive);
    const upDryObj = this._uploadDryByRes?.[pRes] || this._uploadDryByRes?.[256];
    const upBaseObj = this._uploadBaseByRes?.[pRes] || this._uploadBaseByRes?.[256];
    if (!upDryObj || !upBaseObj) return false;

    const revsMatch = this._revsMatchPassive(engine, layer, passive);
    passive.lastUsed = ++this._passiveTick;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, passive.dryPigBytes);

    if (revsMatch) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

      gl.bindFramebuffer(gl.FRAMEBUFFER, tile.dryPig.fbo);
      gl.useProgram(this.progUnpackDry);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
      gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (passive.baseBgBytes) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, passive.baseBgBytes);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.baseBg.fbo);
        gl.useProgram(this.progRectMap);
        gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
        gl.uniform1i(this.locRectMap.u_tex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
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
      gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, passive.baseBgBytes);
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

    // 2. Unpack passive dryPig -> texTileDryTmp (rescaled cleanly if passive came from another quality level)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileDryTmp.fbo);
    gl.useProgram(this.progUnpackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
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
    gl.bindTexture(gl.TEXTURE_2D, passive.baseBgBytes ? upBaseObj.tex : this.dummyTex);
    gl.uniform1i(this.locComp.u_baseBg, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, tile.sub.tex);
    gl.uniform1i(this.locComp.u_sub, 6);
    gl.uniform1f(this.locComp.u_inkWarmth, (passive.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock);
    gl.uniform1i(this.locComp.u_unpremult, 0);
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
    gl.bindTexture(gl.TEXTURE_2D, passive.baseBgBytes ? upBaseObj.tex : this.dummyTex);
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
      this.activeTiles.forEach((t) => {
        if (t.lastUsed < oldestTick) {
          oldestTick = t.lastUsed;
          oldest = t;
        }
      });
    }
    if (!oldest) return null;

    const _sPerf = this._getPerfStats(engine);
    if (_sPerf) _sPerf.tilesEvicted++;

    if (engine) {
      this._flushSyncForTile(engine, oldest);
      if (oldest.cpuDirty) {
        this._syncSingleTileToCanvas2D(engine, oldest, this.lastParams || {}, null, false);
      }
      if (oldest.dirty || oldest.loadedFromPassive) {
        this._archiveSingleTile(engine, oldest, this.lastParams || {});
      }
    }
    this._retireDryQueue.delete(oldest);
    const tr = this.tileRes;
    this.activeTiles.delete(`${oldest.tx},${oldest.ty}`);
    oldest.cpuDirty = false;
    oldest.dirty = false;
    oldest.loadedFromPassive = false;
    oldest.wetTicks = 0;
    oldest.dryProbes = 0;
    oldest.genDepth = 0;
    oldest.minX = tr;
    oldest.minY = tr;
    oldest.maxX = 0;
    oldest.maxY = 0;
    oldest.wMinX = TILE_SIZE;
    oldest.wMinY = TILE_SIZE;
    oldest.wMaxX = 0;
    oldest.wMaxY = 0;
    oldest._preStrokeSeq = 0;
    oldest._preStrokeSnapshot = null;
    oldest._syncGen = (oldest._syncGen || 0) + 1;
    return oldest;
  }

  _ensureTile(engine, tx, ty, excludeBox = null) {
    const key = `${tx},${ty}`;
    let tile = this.activeTiles.get(key);
    if (tile) {
      tile.lastUsed = ++this._tileTick;
      return tile;
    }

    const _sPerf = this._getPerfStats(engine);
    const _tEns0 = _sPerf ? performance.now() : 0;
    const tr = this.tileRes;
    while (this.tilePool.length > 0) {
      const cand = this.tilePool.pop();
      if ((cand.res || TILE_SIZE) === tr) {
        tile = cand;
        break;
      }
      this._destroyTileGpu(cand);
    }
    if (!tile) {
      if (this.activeTiles.size >= this.maxPoolTiles) {
        tile = this._evictLruTile(engine, excludeBox);
        if (tile && (tile.res || TILE_SIZE) !== tr) {
          this._destroyTileGpu(tile);
          tile = this._allocTileGpu();
        }
      } else {
        tile = this._allocTileGpu();
      }
    }
    if (!tile) return null;

    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const passiveKey = this._getPassiveKey(projId, layer, tx, ty);
    const passive = this.passiveTiles.get(passiveKey) || null;
    const exactPassiveHit = !!(passive && this._revsMatchPassive(engine, layer, passive));

    tile.tx = tx;
    tile.ty = ty;
    tile.wx = tx * TILE_SIZE;
    tile.wy = ty * TILE_SIZE;
    tile.subKey = '';
    tile.cpuDirty = false;
    tile.dirty = false;
    tile.loadedFromPassive = false;
    tile.minX = tr;
    tile.minY = tr;
    tile.maxX = 0;
    tile.maxY = 0;
    tile.wMinX = TILE_SIZE;
    tile.wMinY = TILE_SIZE;
    tile.wMaxX = 0;
    tile.wMaxY = 0;
    tile.genDepth = 0;
    tile.wetTicks = 0;
    tile.dryProbes = 0;
    tile.lastUsed = ++this._tileTick;
    tile._preStrokeSeq = this._strokeSeq;
    tile._preStrokeSnapshot = passive ? { entry: passive, wasExact: exactPassiveHit } : null;
    tile._syncGen = (tile._syncGen || 0) + 1;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);

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
    if (_sPerf) {
      _sPerf.tileEnsureMs += performance.now() - _tEns0;
      _sPerf.tilesCreated++;
    }
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
    const _sPerf = this._getPerfStats(engine);
    const _tSub0 = _sPerf ? performance.now() : 0;
    const gl = this.gl;
    const tr = tile.res || this.tileRes;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.sub.fbo);
    gl.useProgram(this.progSubBake);
    this._bindSurfaceUniforms(this.locSubBake, engine, params);
    gl.uniform2f(this.locSubBake.u_workOrigin, tile.wx, tile.wy);
    gl.uniform1f(this.locSubBake.u_texelToWorld, TILE_SIZE / tr);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    tile.subKey = key;
    if (_sPerf) {
      _sPerf.subBakeMs += performance.now() - _tSub0;
      _sPerf.subBakedCount++;
    }
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH, params = null, preLoadedTiles = null, preStepOverrides = null) {
    const _sPerf = this._getPerfStats(engine);
    const _tAsm0 = _sPerf ? performance.now() : 0;
    const _prevChild = _sPerf ? (_sPerf.tileEnsureMs + _sPerf.subBakeMs) : 0;
    const gl = this.gl;
    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(1, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(1, Math.round((boxH * wr) / WORK_RES)));

    let tiles = preLoadedTiles;
    if (!tiles) {
      const tx0 = Math.floor(workX / TILE_SIZE);
      const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
      const ty0 = Math.floor(workY / TILE_SIZE);
      const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);
      const excludeBox = { x: workX, y: workY, w: boxW, h: boxH };

      const activeParams = params || this.lastParams || {};
      const subKey = this._getSubCacheKey(engine, activeParams);

      tiles = [];
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const t = this._ensureTile(engine, tx, ty, excludeBox);
          if (t) {
            this._bakeTileSubIfNeeded(engine, t, activeParams, subKey);
            tiles.push(t);
          }
        }
      }
    }
    if (tiles.length === 0) return tiles;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, workTexW, workTexH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, wr, wr);

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
      const srcT = (preStepOverrides && preStepOverrides.get(t)) || t;
      gl.uniform4f(this.locRectMap.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      const pairs = [
        [this.texSub.fbo, t.sub.tex],
        [this.ppBaseBg.a.fbo, srcT.baseBg.tex],
        [this.ppSurf.a.fbo, srcT.surf.tex],
        [this.ppSurfPig.a.fbo, srcT.surfPig.tex],
        [this.ppPore.a.fbo, srcT.pore.tex],
        [this.ppPorePig.a.fbo, srcT.porePig.tex],
        [this.ppDryPig.a.fbo, srcT.dryPig.tex],
        [this.ppVel.a.fbo, srcT.vel.tex],
        [this.ppStrokeCov.a.fbo, srcT.strokeCov.tex]
      ];
      for (let p = 0; p < pairs.length; p++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[p][0]);
        gl.bindTexture(gl.TEXTURE_2D, pairs[p][1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    if (_sPerf) {
      const childDelta = (_sPerf.tileEnsureMs + _sPerf.subBakeMs) - _prevChild;
      _sPerf.assembleMs += Math.max(0, (performance.now() - _tAsm0) - childDelta);
    }
    return tiles;
  }

  _storeStampToTiles(engine, tiles, workX, workY, boxW, boxH, includeDry = false) {
    const _sPerf = this._getPerfStats(engine);
    const _tStore0 = _sPerf ? performance.now() : 0;
    const gl = this.gl;
    const defaultTr = this.tileRes;

    this._recordSumiBeforeForTiles(engine, tiles);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_srcRect, workX, workY, WORK_RES, WORK_RES);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const srcSurf = this.ppSurf.read().tex;
    const srcSurfPig = this.ppSurfPig.read().tex;
    const srcDryPig = includeDry ? this.ppDryPig.read().tex : null;
    const srcVel = this.ppVel.read().tex;
    const srcCov = this.ppStrokeCov.read().tex;

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const tr = t.res || defaultTr;
      const ox = Math.max(workX, t.wx);
      const oy = Math.max(workY, t.wy);
      const ox2 = Math.min(workX + boxW, t.wx + TILE_SIZE);
      const oy2 = Math.min(workY + boxH, t.wy + TILE_SIZE);
      const ow = ox2 - ox;
      const oh = oy2 - oy;
      if (ow <= 0 || oh <= 0) continue;

      const lx0 = Math.max(0, Math.floor(((ox - t.wx) * tr) / TILE_SIZE + 1e-5));
      const ly0 = Math.max(0, Math.floor(((oy - t.wy) * tr) / TILE_SIZE + 1e-5));
      const lx1 = Math.min(tr, Math.max(lx0 + 1, Math.ceil(((ox2 - t.wx) * tr) / TILE_SIZE - 1e-5)));
      const ly1 = Math.min(tr, Math.max(ly0 + 1, Math.ceil(((oy2 - t.wy) * tr) / TILE_SIZE - 1e-5)));
      const texOw = Math.max(1, lx1 - lx0);
      const texOh = Math.max(1, ly1 - ly0);

      t.dirty = true;
      t.cpuDirty = true;
      this._hasCpuDirty = true;
      if (lx0 < t.minX) t.minX = lx0;
      if (ly0 < t.minY) t.minY = ly0;
      if (lx1 > t.maxX) t.maxX = lx1;
      if (ly1 > t.maxY) t.maxY = ly1;

      gl.viewport(0, 0, tr, tr);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(lx0, ly0, texOw, texOh);
      gl.uniform4f(this.locRectMap.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      const pairs = [
        [t.surf.fbo, srcSurf],
        [t.surfPig.fbo, srcSurfPig],
        [t.vel.fbo, srcVel],
        [t.strokeCov.fbo, srcCov]
      ];
      if (srcDryPig) pairs.push([t.dryPig.fbo, srcDryPig]);

      for (let p = 0; p < pairs.length; p++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pairs[p][0]);
        gl.bindTexture(gl.TEXTURE_2D, pairs[p][1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (_sPerf) {
      _sPerf.storeBlitMs += performance.now() - _tStore0;
    }
  }

  _storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron, skipTileWrite = false) {
    const _sPerf = this._getPerfStats(engine);
    const _tStore0 = _sPerf ? performance.now() : 0;
    const _prevBak = _sPerf ? _sPerf.backupMs : 0;
    const gl = this.gl;
    const innerX = workX + apron;
    const innerY = workY + apron;
    const innerW = Math.max(1, boxW - apron * 2);
    const innerH = Math.max(1, boxH - apron * 2);
    const tw = this.texelWorld;
    const defaultTr = this.tileRes;

    this._recordSumiBeforeForTiles(engine, tiles);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    if (skipTileWrite) {
      // Tile textures were not rewritten in composite-only pass; keep existing _blitGen intact so pending PBO syncs complete.
    } else {
      // 1. Copy interior box back into sparse tiles at active tileRes
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
        const tr = t.res || defaultTr;
        const ox = Math.max(innerX, t.wx);
        const oy = Math.max(innerY, t.wy);
        const ox2 = Math.min(innerX + innerW, t.wx + TILE_SIZE);
        const oy2 = Math.min(innerY + innerH, t.wy + TILE_SIZE);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow <= 0 || oh <= 0) continue;

        const lx0 = Math.max(0, Math.floor(((ox - t.wx) * tr) / TILE_SIZE + 1e-5));
        const ly0 = Math.max(0, Math.floor(((oy - t.wy) * tr) / TILE_SIZE + 1e-5));
        const lx1 = Math.min(tr, Math.max(lx0 + 1, Math.ceil(((ox2 - t.wx) * tr) / TILE_SIZE - 1e-5)));
        const ly1 = Math.min(tr, Math.max(ly0 + 1, Math.ceil(((oy2 - t.wy) * tr) / TILE_SIZE - 1e-5)));
        const texOw = Math.max(1, lx1 - lx0);
        const texOh = Math.max(1, ly1 - ly0);

        t.dirty = true;
        t.cpuDirty = true;
        t._blitGen = ++this._tileWriteGen;
        this._hasCpuDirty = true;
        if (lx0 < t.minX) t.minX = lx0;
        if (ly0 < t.minY) t.minY = ly0;
        if (lx1 > t.maxX) t.maxX = lx1;
        if (ly1 > t.maxY) t.maxY = ly1;

        gl.viewport(0, 0, tr, tr);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(lx0, ly0, texOw, texOh);
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
    }

    // 2. Capture any missing chunk Undo backups cleanly (sparse tile-rect patches for oversized layers) BEFORE blitting
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor(innerX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((innerX + innerW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(innerY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((innerY + innerH - 1) / engine.chunkSize);
    const backupMap = this._getChunkBackupMap(engine, layer);
    if (backupMap) {
      this._deferBackupFlush = true;
      this._queuedBackupFlush = false;
      try {
        for (let cx = sCX; cx <= eCX; cx++) {
          for (let cy = sCY; cy <= eCY; cy++) {
            const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
            if (!chunk) continue;
            const id = `${cx},${cy}`;
            const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
            const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
            for (let ti = 0; ti < tiles.length; ti++) {
              const tile = tiles[ti];
              if (tile.wx >= lx + chunk.width || tile.wx + TILE_SIZE <= lx || tile.wy >= ly + chunk.height || tile.wy + TILE_SIZE <= ly) {
                continue;
              }
              this._ensureSumiTilePatchBackup(engine, chunk, id, layer, backupMap, tile);
            }
          }
        }
      } finally {
        this._deferBackupFlush = false;
        if (this._queuedBackupFlush) {
          this._queuedBackupFlush = false;
          gl.flush();
        }
      }
    }

    // 3. Direct GPU blit of texOutput interior directly onto chunk.gpuTextures[layer]
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);
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
        const texW = chunk.canvases[layer].width;
        const texH = chunk.canvases[layer].height;
        if (!chunk.gpuTextures[layer]) {
          if (chunk.isEmpty && chunk.isEmpty[layer] && !chunk.gpuDirty[layer]) {
            chunk.gpuTextures[layer] = this.gpuRenderer._createEmptyTexture(texW, texH, true);
          } else {
            chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(
              null,
              chunk.canvases[layer],
              true
            );
          }
          chunk.gpuDirty[layer] = false;
        } else if (chunk.gpuDirty[layer]) {
          if (chunk.isEmpty && chunk.isEmpty[layer]) {
            this.gpuRenderer._clearTexture(chunk.gpuTextures[layer]);
          } else {
            chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(
              chunk.gpuTextures[layer],
              chunk.canvases[layer],
              true
            );
          }
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

        const scaleX = texW / chunk.width;
        const scaleY = texH / chunk.height;

        const sx = Math.max(0, Math.floor((ox - lx) * scaleX + 1e-5));
        const sy = Math.max(0, Math.floor((oy - ly) * scaleY + 1e-5));
        const ex = Math.min(texW, Math.max(sx + 1, Math.ceil((ox2 - lx) * scaleX - 1e-5)));
        const ey = Math.min(texH, Math.max(sy + 1, Math.ceil((oy2 - ly) * scaleY - 1e-5)));
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
    if (_sPerf) {
      const bakDelta = _sPerf.backupMs - _prevBak;
      _sPerf.storeBlitMs += Math.max(0, (performance.now() - _tStore0) - bakDelta);
    }
  }

  _computeBleedCurve(params) {
    const bleedVal = params?.bleed !== undefined ? params.bleed : 50;
    const bleedNorm = Math.max(0, Math.min(1, bleedVal / 100));
    const bleedResist = bleedNorm < 0.5 ? (0.5 - bleedNorm) / 0.5 : 0.0;
    const bleedBypass = bleedNorm > 0.5 ? (bleedNorm - 0.5) / 0.5 : 0.0;
    const bleedRate = bleedNorm <= 0.5
      ? (0.06 + 0.94 * Math.pow(bleedNorm / 0.5, 1.35))
      : (1.0 + bleedBypass * 1.0);
    return { bleedNorm, bleedRate, bleedResist, bleedBypass };
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
    const { bleedNorm, bleedRate, bleedResist, bleedBypass } = this._computeBleedCurve(params);
    if (locs.u_hasSurface) gl.uniform1i(locs.u_hasSurface, (hasSurface && mapTex) ? 1 : 0);
    if (locs.u_useHeightmap) gl.uniform1i(locs.u_useHeightmap, params?.useHeightmap ? 1 : 0);
    if (locs.u_heightSource) gl.uniform1i(locs.u_heightSource, params?.heightSource === 'layer' ? 1 : 0);
    if (locs.u_surfaceInvScale) gl.uniform1f(locs.u_surfaceInvScale, sp ? sp.invScale : (1.0 / 340.0));
    if (locs.u_surfaceBiomeMix) gl.uniform1f(locs.u_surfaceBiomeMix, sp ? sp.biomeMix : 0.88);
    if (locs.u_surfaceAllowRotate) gl.uniform1f(locs.u_surfaceAllowRotate, sp ? sp.allowRotate : 1.0);
    if (locs.u_surfaceScaleSpread) gl.uniform1f(locs.u_surfaceScaleSpread, sp ? sp.scaleSpread : 1.0);
    if (locs.u_sizing) gl.uniform1f(locs.u_sizing, sp ? sp.sizing : 0.25);
    if (locs.u_coarseness) gl.uniform1f(locs.u_coarseness, sp ? sp.coarseness : 0.42);
    if (locs.u_surfSlip) {
      const baseSlip = sp ? sp.slip : 0.45;
      const effSlip = bleedNorm < 0.5
        ? baseSlip * (1.0 - 0.85 * bleedResist)
        : Math.min(1.0, baseSlip + (1.0 - baseSlip) * bleedBypass * 0.55);
      gl.uniform1f(locs.u_surfSlip, effSlip);
    }
    if (locs.u_surfChannel) {
      const baseChan = sp ? sp.channel : 0.20;
      const effChan = bleedNorm < 0.5
        ? baseChan * (1.0 - 0.78 * bleedResist)
        : Math.min(1.0, baseChan * (1.0 + 0.55 * bleedBypass));
      gl.uniform1f(locs.u_surfChannel, effChan);
    }
    if (locs.u_seepRate) {
      const baseSeep = sp ? sp.seepRate : 0.90;
      const seepScale = bleedNorm <= 0.5
        ? (0.35 + 0.65 * (bleedNorm / 0.5))
        : (1.0 + 0.35 * bleedBypass);
      gl.uniform1f(locs.u_seepRate, baseSeep * seepScale);
    }
    if (locs.u_sootSnag) {
      const snagVal = params?.sootSnag !== undefined ? (params.sootSnag / 100) : (sp ? sp.sootSnag : 0.55);
      gl.uniform1f(locs.u_sootSnag, snagVal);
    }
    if (locs.u_capillarity) {
      const capVal = params?.capillarity !== undefined ? (params.capillarity / 100) : (sp ? sp.capillarity : 0.62);
      gl.uniform1f(locs.u_capillarity, capVal);
    }
    if (locs.u_bleedRate) gl.uniform1f(locs.u_bleedRate, bleedRate);
    if (locs.u_bleedResist) gl.uniform1f(locs.u_bleedResist, bleedResist);
    if (locs.u_bleedBypass) gl.uniform1f(locs.u_bleedBypass, bleedBypass);
  }

  _runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, dt, forceDry, params, sweepTime = -1) {
    const _sPerf = this._getPerfStats(engine);
    const _tPhys0 = _sPerf ? performance.now() : 0;
    const gl = this.gl;
    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(4, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(4, Math.round((boxH * wr) / WORK_RES)));
    const texel = 1.0 / wr;
    const worldTexel = 1.0 / WORK_RES;
    const simScale = this.simScale;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (workTexW - 0.5) * texel);
    const maxV = Math.max(minV, (workTexH - 0.5) * texel);

    const { bleedRate, bleedResist, bleedBypass } = this._computeBleedCurve(params);
    const baseEvap = (params?.evaporation ?? 28) / 100;
    const spreadPressure = this._activeWetCount > 36 ? Math.min(1.0, (this._activeWetCount - 36) / 36) : 0.0;
    const evapRate = Math.min(1.8, baseEvap + spreadPressure * 0.14);
    const backrunRim = (params?.backrun ?? 68) / 100;
    const glueVisc = (params?.glue ?? 42) / 100;
    const maxWaterCap = Math.max(0.15, Math.min(2.90, ((params?.maxWater ?? 100) / 100) * 1.45));
    const fdFlag = forceDry ? 1.0 : 0.0;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, workTexW, workTexH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, wr, wr);

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
    gl.uniform2f(this.locVelAdv.u_worldTexel, worldTexel, worldTexel);
    gl.uniform1f(this.locVelAdv.u_texelToWorld, this.texelWorld);
    gl.uniform1f(this.locVelAdv.u_gradScale, simScale);
    gl.uniform4f(this.locVelAdv.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform2f(this.locVelAdv.u_workOrigin, workX, workY);
    gl.uniform1f(this.locVelAdv.u_dt, dt);
    gl.uniform1f(this.locVelAdv.u_glueVisc, glueVisc);
    const turbNorm = Math.max(0, Math.min(1, (params?.turbulence ?? 0) / 100));
    gl.uniform1f(this.locVelAdv.u_turb, Math.pow(turbNorm, 2.25) * 0.20);
    gl.uniform1f(this.locVelAdv.u_time, sweepTime >= 0 ? sweepTime : ((performance.now() * 0.001) % 1000.0));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.ppVel.swap();

    // Scale Jacobi pressure projection passes dynamically per solver resolution & settling stage
    const jc = this.jacobiCurve || [6, 4, 2];
    const jacobiIters = forceDry
      ? 0
      : (engine.isDrawing ? jc[0] : (this.simActiveFrames > 280 ? jc[1] : (this.simActiveFrames > 160 ? jc[2] : 0)));
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
    gl.uniform2f(this.locBaseStep.u_worldTexel, worldTexel, worldTexel);
    gl.uniform1f(this.locBaseStep.u_diffScale, simScale);
    gl.uniform4f(this.locBaseStep.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1f(this.locBaseStep.u_dt, dt);
    gl.uniform1f(this.locBaseStep.u_glueVisc, glueVisc);
    gl.uniform1i(this.locBaseStep.u_alphaLock, alphaLock);
    gl.uniform1f(this.locBaseStep.u_bleedRate, bleedRate);
    gl.uniform1f(this.locBaseStep.u_bleedResist, bleedResist);
    gl.uniform1f(this.locBaseStep.u_bleedBypass, bleedBypass);
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
    gl.uniform2f(this.locSurfStep.u_worldTexel, worldTexel, worldTexel);
    gl.uniform1f(this.locSurfStep.u_diffScale, simScale);
    gl.uniform4f(this.locSurfStep.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1f(this.locSurfStep.u_dt, dt);
    gl.uniform1f(this.locSurfStep.u_backrunRim, backrunRim);
    gl.uniform1f(this.locSurfStep.u_evapRate, evapRate);
    gl.uniform1f(this.locSurfStep.u_maxWater, maxWaterCap);
    gl.uniform1f(this.locSurfStep.u_forceDry, fdFlag);
    gl.uniform1f(this.locSurfStep.u_bleedRate, bleedRate);
    gl.uniform1f(this.locSurfStep.u_bleedResist, bleedResist);
    gl.uniform1f(this.locSurfStep.u_bleedBypass, bleedBypass);
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
    gl.uniform1f(this.locPerc.u_diffScale, simScale);
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
    if (_sPerf) {
      _sPerf.physicsMs += performance.now() - _tPhys0;
    }
  }

  _compositeWorkBox(engine, workX, workY, boxW, boxH, params) {
    const _sPerf = this._getPerfStats(engine);
    const _tComp0 = _sPerf ? performance.now() : 0;
    const gl = this.gl;
    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(4, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(4, Math.round((boxH * wr) / WORK_RES)));
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = !!(layerSet && layerSet.alphaLock);

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, workTexW, workTexH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, wr, wr);

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
    gl.uniform1i(this.locComp.u_unpremult, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (_sPerf) {
      _sPerf.compositeMs += performance.now() - _tComp0;
    }
  }

  beginStrokeSession(engine, worldPos, params = {}) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    const _sPerf = this._getPerfStats(engine);
    const _tBeg0 = _sPerf ? performance.now() : 0;
    const layer = engine.activeLayer;
    const projId = engine.currentProjectId || 'default';

    let isSameSession = this.active && this.layer === layer && this.projectId === projId;
    if (this.active && !isSameSession) {
      const prevLayer = this.layer >= 0 ? this.layer : layer;
      const prevMap = (
        this._activeHistoryAction &&
        this._activeHistoryAction.chunks &&
        this._activeHistoryAction.sumiLayer === prevLayer &&
        engine.history &&
        engine.history.length > 0 &&
        engine.history[engine.history.length - 1] === this._activeHistoryAction
      ) ? this._activeHistoryAction.chunks : null;
      this.flushPendingChunkBackups();
      this.flushPendingSyncs(engine, prevMap);
      if (this._hasCpuDirty && prevMap) {
        this.syncTilesToCanvas2D(engine, this.lastParams || {}, prevMap, false);
      }
      this.commitToChunks(engine, this.lastParams || {}, true);
      isSameSession = false;
    } else if (this.active) {
      // Tag any prior in-flight PBO syncs with previous stroke's history action; never block stroke_init with gl.finish
      const prevMap = (
        this._activeHistoryAction &&
        this._activeHistoryAction.chunks &&
        this._activeHistoryAction.sumiLayer === layer &&
        engine.history &&
        engine.history.length > 0 &&
        engine.history[engine.history.length - 1] === this._activeHistoryAction
      ) ? this._activeHistoryAction.chunks : null;
      if (prevMap && this._inFlightSyncs.length > 0) {
        for (let i = 0; i < this._inFlightSyncs.length; i++) {
          if (!this._inFlightSyncs[i].targetMapOverride) {
            this._inFlightSyncs[i].targetMapOverride = prevMap;
          }
        }
      }
      this.pumpAsyncWork(engine);
    }
    if (params && typeof params === 'object') {
      this.lastParams = { ...params };
    }

    this._strokeSeq++;
    this._currentSumiBefore = new Map();
    this._recordedBeforeKeys = new Set();
    this._activeHistoryAction = null;

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
    if (_sPerf) {
      _sPerf.beginMs += performance.now() - _tBeg0;
      this._snapContextStats(engine);
    }
    return true;
  }

  _retireExcessWetTiles() {
    const maxWet = this.maxActiveWet || 145;
    let wetList = null;
    this.activeTiles.forEach((t) => {
      if (t.wetTicks > 0) {
        if (!wetList) wetList = [];
        wetList.push(t);
      }
    });
    this._activeWetCount = wetList ? wetList.length : 0;
    if (wetList && wetList.length > maxWet) {
      const fx = this._focusX || 0;
      const fy = this._focusY || 0;
      wetList.sort((a, b) => {
        const dpDiff = (b.dryProbes || 0) - (a.dryProbes || 0);
        if (dpDiff !== 0) return dpDiff;
        const genDiff = (b.genDepth || 0) - (a.genDepth || 0);
        if (genDiff !== 0) return genDiff;
        const da = (a.wx + 128 - fx) ** 2 + (a.wy + 128 - fy) ** 2;
        const db = (b.wx + 128 - fx) ** 2 + (b.wy + 128 - fy) ** 2;
        const scoreA = a.lastUsed - (da > 65536 ? 40 : 0);
        const scoreB = b.lastUsed - (db > 65536 ? 40 : 0);
        return scoreA - scoreB;
      });
      const retireCount = wetList.length - maxWet;
      for (let i = 0; i < retireCount; i++) {
        const t = wetList[i];
        t.wetTicks = 0;
        // Schedule graceful GPU force-dry so semi-wet pigment never freezes along 256px borders
        this._retireDryQueue.add(t);
      }
      this._activeWetCount = maxWet;
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
          this._retireDryQueue.delete(t);
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
          t.dryProbes = 0;
          t.wetTicks = Math.max(t.wetTicks || 0, ticks);
        }
      }
    }
    this._retireExcessWetTiles();
  }

  _markWetTilesFromSegments(segments, count, pad = 48, ticks = 480) {
    for (let i = 0; i < count; i++) {
      const s = segments[i];
      const p = s.r + pad;
      const sMinX = Math.min(s.x0, s.x1) - p;
      const sMaxX = Math.max(s.x0, s.x1) + p;
      const sMinY = Math.min(s.y0, s.y1) - p;
      const sMaxY = Math.max(s.y0, s.y1) + p;

      const tx0 = Math.floor(sMinX / TILE_SIZE);
      const tx1 = Math.floor((sMaxX - 1e-4) / TILE_SIZE);
      const ty0 = Math.floor(sMinY / TILE_SIZE);
      const ty1 = Math.floor((sMaxY - 1e-4) / TILE_SIZE);
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const t = this.activeTiles.get(`${tx},${ty}`);
          if (!t) continue;
          this._retireDryQueue.delete(t);
          const lx0 = Math.max(0, Math.floor(sMinX - t.wx));
          const ly0 = Math.max(0, Math.floor(sMinY - t.wy));
          const lx1 = Math.min(TILE_SIZE, Math.ceil(sMaxX - t.wx));
          const ly1 = Math.min(TILE_SIZE, Math.ceil(sMaxY - t.wy));
          if (lx1 > lx0 && ly1 > ly0) {
            t.wMinX = Math.min(t.wMinX, lx0);
            t.wMinY = Math.min(t.wMinY, ly0);
            t.wMaxX = Math.max(t.wMaxX, lx1);
            t.wMaxY = Math.max(t.wMaxY, ly1);
          }
          t.genDepth = 0;
          t.dryProbes = 0;
          t.wetTicks = Math.max(t.wetTicks || 0, ticks);
        }
      }
    }
    this._retireExcessWetTiles();
  }

  _expandWetBounds(engine, minX, minY, maxX, maxY, parentTicks, parentGenDepth = 0) {
    const maxWet = this.maxActiveWet || 145;
    if (this._activeWetCount >= maxWet + 8 && parentGenDepth >= 4) return;
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
          if (parentGenDepth >= 4 && this._activeWetCount >= maxWet) continue;
          t = this._ensureTile(engine, tx, ty);
        }
        if (!t) continue;
        this._retireDryQueue.delete(t);
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
        t.dryProbes = 0;
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

  _executeStampPasses(engine, segments, count, workX, workY, workTexW, workTexH, modeInt, brushVelWorld, pressure, pigmentK, params) {
    const gl = this.gl;
    const wr = this.workRes;

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
    gl.scissor(0, 0, workTexW, workTexH);
    gl.viewport(0, 0, wr, wr);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texStamp.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.progBristle);
    gl.uniform2f(this.locBristle.u_invWorkRes, 1.0 / WORK_RES, 1.0 / WORK_RES);
    gl.uniform1f(this.locBristle.u_minRadius, Math.max(0.8, 0.72 * this.texelWorld));

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
  }

  _stampOnlyWorkBox(engine, segments, count, workX, workY, boxW, boxH, modeInt, brushVelWorld, pressure, pigmentK, params) {
    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(1, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(1, Math.round((boxH * wr) / WORK_RES)));

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, params);
    if (tiles.length === 0) return;

    this._executeStampPasses(engine, segments, count, workX, workY, workTexW, workTexH, modeInt, brushVelWorld, pressure, pigmentK, params);
    this._storeStampToTiles(engine, tiles, workX, workY, boxW, boxH, modeInt === 1);
  }

  _stampAndStepWorkBox(engine, segments, count, workX, workY, boxW, boxH, apron, modeInt, brushVelWorld, pressure, pigmentK, params, skipPhysics = false) {
    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(4, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(4, Math.round((boxH * wr) / WORK_RES)));

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, params);
    if (tiles.length === 0) return;

    const _sPerf = this._getPerfStats(engine);
    if (_sPerf) _sPerf.stampBoxes++;

    this._executeStampPasses(engine, segments, count, workX, workY, workTexW, workTexH, modeInt, brushVelWorld, pressure, pigmentK, params);

    // PASS 3..7: Physics (optional when paused during stroke) + Optical Composite + Direct Chunk Blit
    if (!skipPhysics) {
      this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, 0.016, false, params);
    }
    this._compositeWorkBox(engine, workX, workY, boxW, boxH, params);
    this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
  }

  _runSynchronizedBoxes(engine, boxes, dt, forceDry, activeParams, apron, options = {}) {
    if (!boxes || boxes.length === 0) return [];
    const subKey = this._getSubCacheKey(engine, activeParams);
    const skipPhysics = !!options.skipPhysics;
    const skipTileWrite = !!options.skipTileWrite;

    let unionMinX = Infinity, unionMinY = Infinity, unionMaxX = -Infinity, unionMaxY = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.workX < unionMinX) unionMinX = b.workX;
      if (b.workY < unionMinY) unionMinY = b.workY;
      if (b.workX + b.boxW > unionMaxX) unionMaxX = b.workX + b.boxW;
      if (b.workY + b.boxH > unionMaxY) unionMaxY = b.workY + b.boxH;
    }
    const excludeBox = {
      x: unionMinX,
      y: unionMinY,
      w: Math.max(1, unionMaxX - unionMinX),
      h: Math.max(1, unionMaxY - unionMinY)
    };

    const lastReaderIdx = new Map();
    const boxJobs = [];
    const allTouchedSet = new Set();

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const tx0 = Math.floor(b.workX / TILE_SIZE);
      const tx1 = Math.floor((b.workX + b.boxW - 1) / TILE_SIZE);
      const ty0 = Math.floor(b.workY / TILE_SIZE);
      const ty1 = Math.floor((b.workY + b.boxH - 1) / TILE_SIZE);

      const readTiles = [];
      const writeTiles = [];
      const innerX0 = b.x;
      const innerY0 = b.y;
      const innerX1 = b.x + b.innerW;
      const innerY1 = b.y + b.innerH;

      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const t = this._ensureTile(engine, tx, ty, excludeBox);
          if (!t) continue;
          this._bakeTileSubIfNeeded(engine, t, activeParams, subKey);
          readTiles.push(t);
          if (
            t.wx + TILE_SIZE > innerX0 && t.wx < innerX1 &&
            t.wy + TILE_SIZE > innerY0 && t.wy < innerY1
          ) {
            writeTiles.push(t);
          }
        }
      }
      if (readTiles.length === 0 || writeTiles.length === 0) continue;
      const jobIdx = boxJobs.length;
      for (let k = 0; k < readTiles.length; k++) {
        const t = readTiles[k];
        allTouchedSet.add(t);
        lastReaderIdx.set(t, jobIdx);
      }
      boxJobs.push({ b, readTiles, writeTiles });
    }

    if (boxJobs.length === 0) return [];

    const preStepOverrides = skipPhysics ? null : new Map();
    const sweepTime = (performance.now() * 0.001) % 1000.0;
    const _sPerf = this._getPerfStats(engine);
    const shouldProbe = !!options.shouldProbe;
    const maxTicks = options.maxTicks ?? 240;
    const minGen = options.minGen ?? 0;

    try {
      for (let i = 0; i < boxJobs.length; i++) {
        const { b, readTiles, writeTiles } = boxJobs[i];
        this._assembleWorkBox(engine, b.workX, b.workY, b.boxW, b.boxH, activeParams, readTiles, preStepOverrides);
        if (!skipPhysics) {
          this._runPhysicsOnWorkBox(engine, b.workX, b.workY, b.boxW, b.boxH, dt, forceDry, activeParams, sweepTime);
        }
        this._compositeWorkBox(engine, b.workX, b.workY, b.boxW, b.boxH, activeParams);

        if (preStepOverrides) {
          for (let w = 0; w < writeTiles.length; w++) {
            const wt = writeTiles[w];
            if ((lastReaderIdx.get(wt) ?? -1) > i && !preStepOverrides.has(wt)) {
              const clone = this._acquireStagingTile(wt.res || this.tileRes);
              if (clone) {
                this._copyTileChannels(wt, clone);
                preStepOverrides.set(wt, clone);
              }
            }
          }
        }

        this._storeTilesAndBlitChunks(engine, writeTiles, b.workX, b.workY, b.boxW, b.boxH, apron, skipTileWrite);
        if (_sPerf && !skipPhysics) _sPerf.simBoxes++;
        if (shouldProbe) {
          this._probeWorkBoxFrontier(
            engine, b.workX, b.workY, b.x, b.y, b.x + b.innerW, b.y + b.innerH,
            maxTicks, minGen, false, null
          );
        }

        if (preStepOverrides) {
          preStepOverrides.forEach((clone, origTile) => {
            if ((lastReaderIdx.get(origTile) ?? -1) <= i) {
              this._releaseStagingTile(clone);
              preStepOverrides.delete(origTile);
            }
          });
        }
      }
    } finally {
      if (preStepOverrides) {
        preStepOverrides.forEach((clone) => {
          this._releaseStagingTile(clone);
        });
        preStepOverrides.clear();
      }
    }

    return Array.from(allTouchedSet);
  }

  stampAndStep(engine, segments, modeInt, brushVelWorld, pressure, pigmentK, params) {
    if (!this.ready || !this.active || !segments || segments.length === 0) return;
    if (params && typeof params === 'object') this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const _stampT0 = performance.now();
    this._pumpAsyncProbes(engine, 8);
    this._pumpAsyncPacks(2);
    const pausePhysics = !!(params?.pauseWhilePainting && (modeInt === 0 || modeInt === 1));

    const count = Math.min(MAX_INSTANCES, segments.length);
    const _sPerf = this._getPerfStats(engine);
    if (_sPerf) _sPerf.stampSegs += count;
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

    const snap = this.snapWorld || 4;
    const minX = Math.floor(segMinX / snap) * snap;
    const minY = Math.floor(segMinY / snap) * snap;
    const maxX = Math.ceil(segMaxX / snap) * snap;
    const maxY = Math.ceil(segMaxY / snap) * snap;
    const apron = 16;
    const spanX = maxX - minX;
    const spanY = maxY - minY;

    engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, minX);
    engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, maxX);
    engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, minY);
    engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, maxY);

    if (spanX <= WORK_RES - apron * 2 && spanY <= WORK_RES - apron * 2) {
      const boxW = Math.min(WORK_RES, Math.max(48, spanX + apron * 2));
      const boxH = Math.min(WORK_RES, Math.max(48, spanY + apron * 2));
      const workX = minX - apron;
      const workY = minY - apron;
      this._stampAndStepWorkBox(
        engine, segments, count, workX, workY, boxW, boxH, apron,
        modeInt, brushVelWorld, pressure, pigmentK, params, pausePhysics
      );
      this._lastStampBoxCount = 1;
    } else {
      // Pass 1: Disjoint full-box stamping (apron=0) avoids double-stamping & seam cliffs
      const STEP_STAMP = WORK_RES;
      for (let x = minX; x < maxX; x += STEP_STAMP) {
        const boxW = Math.min(STEP_STAMP, maxX - x);
        for (let y = minY; y < maxY; y += STEP_STAMP) {
          const boxH = Math.min(STEP_STAMP, maxY - y);
          const bx0 = x;
          const by0 = y;
          const bx1 = x + boxW;
          const by1 = y + boxH;
          const subSegs = [];
          for (let i = 0; i < count; i++) {
            const s = segments[i];
            const pad = s.r + 20;
            if (
              Math.max(s.x0, s.x1) + pad >= bx0 &&
              Math.min(s.x0, s.x1) - pad <= bx1 &&
              Math.max(s.y0, s.y1) + pad >= by0 &&
              Math.min(s.y0, s.y1) - pad <= by1
            ) {
              subSegs.push(s);
            }
          }
          if (subSegs.length === 0) continue;
          this._stampOnlyWorkBox(
            engine, subSegs, subSegs.length, x, y, boxW, boxH,
            modeInt, brushVelWorld, pressure, pigmentK, params
          );
        }
      }

      // Pass 2: Synchronized physics + composite + chunk blit across all stamped 640px sub-boxes
      const STEP_SPAN = 640;
      const stepBoxes = [];
      for (let x = minX; x < maxX; x += STEP_SPAN) {
        const innerW = Math.min(STEP_SPAN, maxX - x);
        const boxW = Math.min(WORK_RES, innerW + apron * 2);
        const workX = x - apron;
        for (let y = minY; y < maxY; y += STEP_SPAN) {
          const innerH = Math.min(STEP_SPAN, maxY - y);
          const boxH = Math.min(WORK_RES, innerH + apron * 2);
          const workY = y - apron;
          let hasOverlap = false;
          for (let i = 0; i < count; i++) {
            const s = segments[i];
            const pad = s.r + 20 + apron;
            if (
              Math.max(s.x0, s.x1) + pad >= x &&
              Math.min(s.x0, s.x1) - pad <= x + innerW &&
              Math.max(s.y0, s.y1) + pad >= y &&
              Math.min(s.y0, s.y1) - pad <= y + innerH
            ) {
              hasOverlap = true;
              break;
            }
          }
          if (!hasOverlap && !this._boxHasWetTiles(x, y, x + innerW, y + innerH)) continue;
          stepBoxes.push({ x, y, innerW, innerH, boxW, boxH, workX, workY });
          if (_sPerf) _sPerf.stampBoxes++;
        }
      }
      this._runSynchronizedBoxes(engine, stepBoxes, 0.016, false, params, apron, {
        shouldProbe: !pausePhysics && stepBoxes.length <= 6,
        skipPhysics: pausePhysics,
        skipTileWrite: pausePhysics
      });
      this._lastStampBoxCount = stepBoxes.length;
    }

    if (modeInt !== 3) {
      this._needsDryOnClose = true;
      this._activeSolverCount = Math.max(1, this._activeSolverCount || 0);
    }
    const evap = params?.evaporation ?? 28;
    const tickCap = evap < 2 ? 320 : 480;
    this.simActiveFrames = tickCap;
    this._markWetTilesFromSegments(segments, count, 48, tickCap);
    this._lastStampRanPhysics = !pausePhysics;
    this._lastStampEndTime = performance.now();
    this._lastStampElapsedMs = this._lastStampEndTime - _stampT0;
    this._snapContextStats(engine);
  }

  _applyProbeResultBytes(engine, pb, wb, job) {
    const wAt = (cx, cy) => pb[(cy * 3 + cx) * 4];
    let anyEdgeWet = false;
    for (let i = 0; i < 36; i += 4) {
      if (pb[i] > 0 || pb[i + 1] > 0) {
        anyEdgeWet = true;
        break;
      }
    }

    const expW = wAt(0, 1) >= 2 || wAt(0, 0) >= 2 || wAt(0, 2) >= 2;
    const expE = wAt(2, 1) >= 2 || wAt(2, 0) >= 2 || wAt(2, 2) >= 2;
    const expS = wAt(1, 0) >= 2 || wAt(0, 0) >= 2 || wAt(2, 0) >= 2;
    const expN = wAt(1, 2) >= 2 || wAt(0, 2) >= 2 || wAt(2, 2) >= 2;

    if (expW || expE || expS || expN) {
      const STEP_OUT = 56;
      const nMinX = expW ? (job.innerMinX - STEP_OUT) : job.innerMinX;
      const nMaxX = expE ? (job.innerMaxX + STEP_OUT) : job.innerMaxX;
      const nMinY = expS ? (job.innerMinY - STEP_OUT) : job.innerMinY;
      const nMaxY = expN ? (job.innerMaxY + STEP_OUT) : job.innerMaxY;
      this._expandWetBounds(engine, nMinX, nMinY, nMaxX, nMaxY, job.parentTicks, job.parentGenDepth);
      if (job.clusterTiles) {
        for (let i = 0; i < job.clusterTiles.length; i++) {
          const ct = job.clusterTiles[i];
          if (ct && (!job.clusterTileGens || ct._syncGen === job.clusterTileGens[i])) {
            ct.dryProbes = 0;
          }
        }
      }
      return;
    }

    if (job.doWet && job.clusterTiles && !engine.isDrawing) {
      let anyWet = anyEdgeWet;
      if (!anyWet && wb) {
        for (let i = 0; i < wb.length; i += 4) {
          if (wb[i] > 0 || wb[i + 1] > 0) {
            anyWet = true;
            break;
          }
        }
      }
      if (anyWet) {
        for (let i = 0; i < job.clusterTiles.length; i++) {
          const ct = job.clusterTiles[i];
          if (ct && (!job.clusterTileGens || ct._syncGen === job.clusterTileGens[i])) {
            ct.dryProbes = 0;
          }
        }
      } else {
        for (let i = 0; i < job.clusterTiles.length; i++) {
          const ct = job.clusterTiles[i];
          if (ct && (!job.clusterTileGens || ct._syncGen === job.clusterTileGens[i])) {
            ct.dryProbes = (ct.dryProbes || 0) + 1;
            if (ct.dryProbes >= 6) {
              ct.wetTicks = 0;
            }
          }
        }
      }
    }
  }

  _pumpAsyncProbes(engine, budget = 24) {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this._inFlightProbes.length === 0) return;

    let done = 0;
    while (this._inFlightProbes.length > 0 && done < budget) {
      const job = this._inFlightProbes[0];
      const status = gl.clientWaitSync(job.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;

      this._inFlightProbes.shift();
      gl.deleteSync(job.sync);
      job.sync = null;

      if (
        (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) &&
        this.active &&
        job.layer === this.layer &&
        job.projectId === this.projectId &&
        engine
      ) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._probeBuf, 0, 36);
        let wb = null;
        if (job.hasWetBytes) {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 64, this._wetProbeBuf, 0, 256);
          wb = this._wetProbeBuf;
        }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this._applyProbeResultBytes(engine, this._probeBuf, wb, job);
      }

      if (job.slot) {
        job.slot.inUse = false;
        job.slot = null;
      }
      done++;
    }
  }

  _probeWorkBoxFrontier(engine, workX, workY, innerMinX, innerMinY, innerMaxX, innerMaxY, parentTicks, parentGenDepth, allowRetireDry = false, clusterTiles = null) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const _sPerf = this._getPerfStats(engine);
    const _tPr0 = _sPerf ? performance.now() : 0;
    const u0 = (innerMinX - workX) / WORK_RES;
    const v0 = (innerMinY - workY) / WORK_RES;
    const u1 = (innerMaxX - workX) / WORK_RES;
    const v1 = (innerMaxY - workY) / WORK_RES;
    if (u1 <= u0 || v1 <= v0) return;

    const pIdx = this._probeTick & 3;
    const phaseX = pIdx === 0 ? 0.0 : (pIdx === 1 ? 0.33 : (pIdx === 2 ? -0.33 : 0.18));
    const phaseY = pIdx === 0 ? 0.0 : (pIdx === 1 ? -0.27 : (pIdx === 2 ? 0.31 : -0.19));
    const doWet = !!(allowRetireDry && clusterTiles && !engine.isDrawing);

    if (this._pboSupported) {
      this._pumpAsyncProbes(engine, 24);
      this._initPboRings();
      let slot = null;
      for (let i = 0; i < this._probePboRing.length; i++) {
        if (!this._probePboRing[i].inUse) {
          slot = this._probePboRing[i];
          break;
        }
      }
      if (!slot) return;

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
      gl.uniform2f(this.locEdgeProbe.u_probePhase, phaseX, phaseY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      slot.inUse = true;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.readPixels(0, 0, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, 0);

      if (doWet) {
        gl.viewport(0, 0, 8, 8);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texCenterProbe.fbo);
        gl.useProgram(this.progWetProbe);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
        gl.uniform1i(this.locWetProbe.u_surf, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
        gl.uniform1i(this.locWetProbe.u_pore, 1);
        gl.uniform4f(this.locWetProbe.u_innerUv, u0, v0, u1, v1);
        gl.uniform2f(this.locWetProbe.u_probePhase, phaseX, phaseY);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, 64);
      }

      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this._inFlightProbes.push({
        sync,
        slot,
        layer: this.layer,
        projectId: this.projectId,
        innerMinX,
        innerMinY,
        innerMaxX,
        innerMaxY,
        parentTicks,
        parentGenDepth,
        doWet,
        hasWetBytes: doWet,
        clusterTiles,
        clusterTileGens: clusterTiles ? clusterTiles.map((t) => t._syncGen) : null
      });
      if (_sPerf) _sPerf.probeMs += performance.now() - _tPr0;
      return;
    }

    // Blocking fallback if PBOs unsupported
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
    gl.uniform2f(this.locEdgeProbe.u_probePhase, phaseX, phaseY);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, this._probeBuf);

    let wb = null;
    if (doWet) {
      gl.viewport(0, 0, 8, 8);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.texCenterProbe.fbo);
      gl.useProgram(this.progWetProbe);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.ppSurf.read().tex);
      gl.uniform1i(this.locWetProbe.u_surf, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.ppPore.read().tex);
      gl.uniform1i(this.locWetProbe.u_pore, 1);
      gl.uniform4f(this.locWetProbe.u_innerUv, u0, v0, u1, v1);
      gl.uniform2f(this.locWetProbe.u_probePhase, phaseX, phaseY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, this._wetProbeBuf);
      wb = this._wetProbeBuf;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._applyProbeResultBytes(engine, this._probeBuf, wb, {
      innerMinX,
      innerMinY,
      innerMaxX,
      innerMaxY,
      parentTicks,
      parentGenDepth,
      doWet,
      clusterTiles,
      clusterTileGens: null
    });
    if (_sPerf) _sPerf.probeMs += performance.now() - _tPr0;
  }

  _runWetCluster(engine, clusterMinX, clusterMinY, clusterMaxX, clusterMaxY, dt, forceDry, activeParams, maxTicks = 240, minGen = 0, clusterTiles = null) {
    const snap = this.snapWorld || 4;
    const minX = Math.floor(clusterMinX / snap) * snap;
    const minY = Math.floor(clusterMinY / snap) * snap;
    const maxX = Math.ceil(clusterMaxX / snap) * snap;
    const maxY = Math.ceil(clusterMaxY / snap) * snap;
    if (maxX <= minX || maxY <= minY) return [];

    this.dirtyMinX = Math.min(this.dirtyMinX, minX);
    this.dirtyMinY = Math.min(this.dirtyMinY, minY);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, maxX);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, maxY);

    const apron = 20;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const shouldProbe = !forceDry && (engine.isDrawing || (this._probeTick & 1) === 0);
    const _sPerf = this._getPerfStats(engine);

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
        if (_sPerf) _sPerf.simBoxes++;
        if (shouldProbe) {
          this._probeWorkBoxFrontier(engine, workX, workY, minX, minY, maxX, maxY, maxTicks, minGen, true, clusterTiles);
        }
      }
      return null;
    }

    // Partition multi-box wet cluster with rotating grid phase and step EVERY box synchronously from the same pre-step snapshot
    const STEP_SPAN = 640;
    const phaseShift = Math.floor(((this._simSweepCount & 3) * 32) / snap) * snap;
    const gridMinX = minX - phaseShift;
    const gridMinY = minY - phaseShift;
    const boxes = [];

    for (let x = gridMinX; x < maxX; x += STEP_SPAN) {
      const innerStartX = Math.max(minX, x);
      const innerEndX = Math.min(maxX, x + STEP_SPAN);
      const innerW = innerEndX - innerStartX;
      if (innerW <= 0) continue;
      const boxW = Math.min(WORK_RES, innerW + apron * 2);
      const workX = innerStartX - apron;
      for (let y = gridMinY; y < maxY; y += STEP_SPAN) {
        const innerStartY = Math.max(minY, y);
        const innerEndY = Math.min(maxY, y + STEP_SPAN);
        const innerH = innerEndY - innerStartY;
        if (innerH <= 0) continue;
        const boxH = Math.min(WORK_RES, innerH + apron * 2);
        const workY = innerStartY - apron;
        if (!this._boxHasWetTiles(innerStartX, innerStartY, innerEndX, innerEndY)) continue;
        boxes.push({
          x: innerStartX,
          y: innerStartY,
          innerW,
          innerH,
          boxW,
          boxH,
          workX,
          workY
        });
      }
    }
    if (boxes.length === 0) return [];

    this._simSweepCount++;
    return this._runSynchronizedBoxes(engine, boxes, dt, forceDry, activeParams, apron, {
      shouldProbe,
      maxTicks,
      minGen
    });
  }

  _processRetireDryQueue(engine, activeParams, maxTiles = 6, forceFlush = false) {
    if (!this._retireDryQueue || this._retireDryQueue.size === 0 || !engine || maxTiles <= 0) return 0;
    const checkNeighborWet = !forceFlush && this._retireDryQueue.size <= 16;
    const snap = this.snapWorld || 4;
    const apron = 16;
    const batch = [];
    const deferred = [];

    for (const t of this._retireDryQueue) {
      this._retireDryQueue.delete(t);
      if (!t || this.activeTiles.get(`${t.tx},${t.ty}`) !== t) continue;
      if (t.wetTicks > 0) continue;
      if (checkNeighborWet) {
        let touchesWet = false;
        for (let dx = -1; dx <= 1 && !touchesWet; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nt = this.activeTiles.get(`${t.tx + dx},${t.ty + dy}`);
            if (nt && nt.wetTicks > 0) {
              touchesWet = true;
              break;
            }
          }
        }
        if (touchesWet) {
          deferred.push(t);
          continue;
        }
      }
      batch.push(t);
      if (batch.length >= maxTiles) break;
    }

    for (let i = 0; i < deferred.length; i++) {
      this._retireDryQueue.add(deferred[i]);
    }

    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      const minX = Math.floor(t.wx / snap) * snap;
      const minY = Math.floor(t.wy / snap) * snap;
      const boxW = Math.min(WORK_RES, TILE_SIZE + apron * 2);
      const boxH = Math.min(WORK_RES, TILE_SIZE + apron * 2);
      const workX = minX - apron;
      const workY = minY - apron;
      const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH, activeParams);
      if (tiles.length === 0) continue;
      for (let it = 0; it < 2; it++) {
        this._runPhysicsOnWorkBox(engine, workX, workY, boxW, boxH, 0.016, true, activeParams);
      }
      this._compositeWorkBox(engine, workX, workY, boxW, boxH, activeParams);
      this._storeTilesAndBlitChunks(engine, tiles, workX, workY, boxW, boxH, apron);
    }
    const _sPerf = this._getPerfStats(engine);
    if (_sPerf && batch.length > 0) {
      _sPerf.retireDryBoxes += batch.length;
    }
    return batch.length;
  }

  stepSimulation(engine, dt = 0.016, forceDry = false, params = {}, skipAsyncPump = false) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return false;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return false;

    this._probeTick++;
    if (!skipAsyncPump) {
      const isDraw = !!(engine && engine.isDrawing);
      const isSaving = !!(engine && engine.app && engine.app._isSavingProject);
      this._pumpAsyncChunkBackups(engine, isDraw ? 2 : 3, false, isDraw ? 1.8 : 2.4);
      this._pumpAsyncProbes(engine, 12);
      this._pumpAsyncPacks(4);
      if (!isSaving) {
        this._pumpAsyncSyncs(engine, 2, 2.2);
      }
    }

    const simStartMs = performance.now();
    const _sPerf = this._getPerfStats(engine);
    const _simBoxesBefore = _sPerf ? _sPerf.simBoxes : 0;

    const stampedRecently = (simStartMs - (this._lastStampEndTime || 0)) < 14;
    const canThrottleAfterHeavyStamp = (
      !forceDry &&
      engine.isDrawing &&
      stampedRecently &&
      (this._lastStampBoxCount || 0) > 1 &&
      this._lastStampRanPhysics &&
      (this._consecutiveSimSkips || 0) === 0 &&
      (simStartMs - (this._lastSimStepMs || 0)) < 20
    );
    if (canThrottleAfterHeavyStamp) {
      this._consecutiveSimSkips = (this._consecutiveSimSkips || 0) + 1;
      this._lastStepSimBoxes = 0;
      if (_sPerf) {
        _sPerf.simMs += performance.now() - simStartMs;
        this._snapContextStats(engine);
      }
      return false;
    }
    this._consecutiveSimSkips = 0;
    this._lastSimStepMs = simStartMs;

    const wetMap = new Map();
    this.activeTiles.forEach((t, k) => {
      if (t.wetTicks > 0) wetMap.set(k, t);
    });
    this._activeWetCount = wetMap.size;

    if (this._retireDryQueue && this._retireDryQueue.size > 0) {
      let maxRetire = 0;
      if (forceDry) {
        maxRetire = 32;
      } else if (!stampedRecently) {
        maxRetire = wetMap.size === 0 ? 4 : 2;
      }
      if (maxRetire > 0) {
        this._processRetireDryQueue(engine, activeParams, maxRetire, forceDry);
      }
    }

    // Group active wet tiles into 8-neighbor connected islands so distant wet strokes run independently & merge seamlessly
    if (wetMap.size === 0) {
      this._lastStepSimBoxes = 0;
      this._activeSolverCount = (!forceDry && this._retireDryQueue && this._retireDryQueue.size > 0) ? 1 : 0;
      if (!this._retireDryQueue || this._retireDryQueue.size === 0) {
        this.simActiveFrames = Math.min(this.simActiveFrames, 1);
      }
      if (_sPerf) {
        _sPerf.simMs += performance.now() - simStartMs;
        this._snapContextStats(engine, 0);
      }
      return true;
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
      const cxMid = (cMinX + cMaxX) * 0.5;
      const cyMid = (cMinY + cMaxY) * 0.5;
      const dxFocus = cxMid - (this._focusX || 0);
      const dyFocus = cyMid - (this._focusY || 0);
      clusters.push({
        minX: cMinX,
        minY: cMinY,
        maxX: cMaxX,
        maxY: cMaxY,
        maxTicks,
        minGen,
        tiles: queue,
        distSq: dxFocus * dxFocus + dyFocus * dyFocus
      });
    });

    const recentStampCost = (simStartMs - this._lastStampEndTime) < 12 ? this._lastStampElapsedMs : 0;
    const budgetMs = engine.isDrawing ? Math.max(4.0, 9.5 - recentStampCost) : 11.5;

    const steppedTilesLists = [];
    if (forceDry) {
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        const stepped = this._runWetCluster(
          engine, cl.minX, cl.minY, cl.maxX, cl.maxY, dt, true, activeParams,
          cl.maxTicks, cl.minGen, cl.tiles
        );
        steppedTilesLists.push(stepped || cl.tiles);
      }
    } else {
      // Always step every box of a wet cluster synchronously as a unit so border seams can never desync
      clusters.sort((a, b) => a.distSq - b.distSq);
      const primary = clusters[0];
      const stepped1 = this._runWetCluster(
        engine, primary.minX, primary.minY, primary.maxX, primary.maxY, dt, false, activeParams,
        primary.maxTicks, primary.minGen, primary.tiles
      );
      if (stepped1 === null) {
        steppedTilesLists.push(primary.tiles);
      } else if (stepped1.length > 0) {
        steppedTilesLists.push(stepped1);
      }

      if (clusters.length > 1) {
        const distCount = clusters.length - 1;
        const starved = (this._secStarveCount || 0) >= 2;
        if ((performance.now() - simStartMs) < budgetMs || starved) {
          this._secStarveCount = 0;
          let secRan = 0;
          const maxSecPerFrame = Math.min(distCount, 4);
          while (secRan < maxSecPerFrame) {
            if (secRan > 0 && (performance.now() - simStartMs) >= budgetMs) break;
            const secIdx = 1 + (this._clusterCursor % distCount);
            this._clusterCursor++;
            const sec = clusters[secIdx];
            const sliceDt = Math.min(0.032, dt * Math.min(2.0, Math.max(1, distCount - secRan)));
            const stepped2 = this._runWetCluster(
              engine, sec.minX, sec.minY, sec.maxX, sec.maxY, sliceDt, false, activeParams,
              sec.maxTicks, sec.minGen, sec.tiles
            );
            if (stepped2 === null) {
              steppedTilesLists.push(sec.tiles);
            } else if (stepped2.length > 0) {
              steppedTilesLists.push(stepped2);
            }
            secRan++;
          }
        } else {
          this._secStarveCount = (this._secStarveCount || 0) + 1;
        }
      } else {
        this._secStarveCount = 0;
      }
    }

    for (let c = 0; c < steppedTilesLists.length; c++) {
      const tiles = steppedTilesLists[c];
      for (let i = 0; i < tiles.length; i++) {
        if (forceDry) {
          tiles[i].wetTicks = 0;
          tiles[i].dryProbes = 0;
        } else if (tiles[i].wetTicks > 0) {
          tiles[i].wetTicks--;
        }
      }
    }

    let anyWetLeft = this._retireDryQueue.size > 0;
    if (!anyWetLeft) {
      this.activeTiles.forEach((t) => {
        if (t.wetTicks > 0) anyWetLeft = true;
      });
    }
    this._activeSolverCount = forceDry
      ? 0
      : (anyWetLeft ? Math.max(clusters.length, (this._retireDryQueue && this._retireDryQueue.size > 0) ? 1 : 0) : 0);
    if (!anyWetLeft && !engine.isDrawing) {
      this.simActiveFrames = Math.min(this.simActiveFrames, 1);
    }

    if (_sPerf) {
      this._lastStepSimBoxes = Math.max(0, _sPerf.simBoxes - _simBoxesBefore);
      _sPerf.simMs += performance.now() - simStartMs;
      _sPerf.simClusters += steppedTilesLists.length;
      this._snapContextStats(engine, wetMap.size);
    } else {
      this._lastStepSimBoxes = 0;
    }
    return true;
  }

  getActiveSolverCount() {
    return this.active ? (this._activeSolverCount || 0) : 0;
  }

  hasActiveWetTiles() {
    if (!this.ready || !this.active) return false;
    if (this._retireDryQueue && this._retireDryQueue.size > 0) return true;
    let found = false;
    this.activeTiles.forEach((t) => {
      if (t.wetTicks > 0) found = true;
    });
    return found;
  }

  hasCpuDirtyTiles() {
    return this._hasCpuDirty;
  }

  hasPendingSyncs() {
    return (
      this._hasCpuDirty ||
      this._inFlightSyncs.length > 0 ||
      this._inFlightChunkBackups.length > 0 ||
      (this._retireDryQueue && this._retireDryQueue.size > 0)
    );
  }

  _discardPendingAsync() {
    const gl = this.gl;
    const validGl = !!(gl && !gl.isContextLost());
    for (let i = 0; i < this._inFlightSyncs.length; i++) {
      const job = this._inFlightSyncs[i];
      if (job.sync && validGl) {
        try { gl.deleteSync(job.sync); } catch (_) {}
      }
      if (job.slot) job.slot.inUse = false;
    }
    this._inFlightSyncs.length = 0;

    for (let i = 0; i < this._inFlightProbes.length; i++) {
      const job = this._inFlightProbes[i];
      if (job.sync && validGl) {
        try { gl.deleteSync(job.sync); } catch (_) {}
      }
      if (job.slot) job.slot.inUse = false;
    }
    this._inFlightProbes.length = 0;

    for (let i = 0; i < this._inFlightPacks.length; i++) {
      const job = this._inFlightPacks[i];
      if (job.sync && validGl) {
        try { gl.deleteSync(job.sync); } catch (_) {}
      }
      if (job.pboSlot) job.pboSlot.inUse = false;
      if (job.pair) this._releasePackTexPair(job.pair);
      if (job.snapRef) job.snapRef._packJob = null;
      job.resolved = true;
    }
    this._inFlightPacks.length = 0;

    for (let i = 0; i < this._pendingPacks.length; i++) {
      const job = this._pendingPacks[i];
      if (job.pair) this._releasePackTexPair(job.pair);
      if (job.snapRef) job.snapRef._packJob = null;
      job.resolved = true;
    }
    this._pendingPacks.length = 0;

    for (let i = 0; i < this._inFlightChunkBackups.length; i++) {
      const job = this._inFlightChunkBackups[i];
      if (job.sync && validGl) {
        try { gl.deleteSync(job.sync); } catch (_) {}
      }
      if (job.entry) {
        job.entry._resolveSync = null;
        job.entry._cancelSync = null;
        job.entry._pendingBackupJob = null;
        job.entry = null;
      }
      if (job.slot) job.slot.inUse = false;
      job.sync = null;
      job.resolved = true;
      job.cancelled = true;
    }
    this._inFlightChunkBackups.length = 0;

    for (let i = 0; i < this._syncPboRing.length; i++) this._syncPboRing[i].inUse = false;
    for (let i = 0; i < this._probePboRing.length; i++) this._probePboRing[i].inUse = false;
    for (let i = 0; i < this._packPboRing.length; i++) this._packPboRing[i].inUse = false;
    for (let i = 0; i < this._chunkBackupPboRing.length; i++) this._chunkBackupPboRing[i].inUse = false;
    for (let i = 0; i < this._largeBackupPboRing.length; i++) this._largeBackupPboRing[i].inUse = false;
    if (this._retireDryQueue) this._retireDryQueue.clear();
  }

  _flushSyncForTile(engine, tile) {
    if (!tile || this._inFlightSyncs.length === 0) return;
    const syncGen = tile._syncGen || 0;
    let lastMatchIdx = -1;
    for (let i = this._inFlightSyncs.length - 1; i >= 0; i--) {
      const job = this._inFlightSyncs[i];
      if (job.tile === tile && job.tileSyncInstance === syncGen) {
        lastMatchIdx = i;
        break;
      }
    }
    if (lastMatchIdx < 0) return;

    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    gl.finish();

    let boundPbo = false;
    for (let n = 0; n <= lastMatchIdx && this._inFlightSyncs.length > 0; n++) {
      const job = this._inFlightSyncs.shift();
      if (job.sync) {
        try { gl.clientWaitSync(job.sync, 0, 0); } catch (_) {}
        gl.deleteSync(job.sync);
        job.sync = null;
      }
      if (engine && job.projectId === (this.projectId || engine.currentProjectId || 'default')) {
        const byteLen = job.rw * job.rh * 4;
        const view = this._readBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        boundPbo = true;
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, byteLen);
        this._writeSyncBytesToChunks(engine, job, view);
      }
      if (job.slot) job.slot.inUse = false;
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }

  _ensureChunkBackupResources(w, h, byteLen) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    if (!this._backupUnpremultFbo || this._backupUnpremultFbo.w !== w || this._backupUnpremultFbo.h !== h) {
      this._delTexFBO(this._backupUnpremultFbo);
      this._backupUnpremultFbo = this._makeTexFBO(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    }
    if (!this._backupReadBuf || this._backupReadBuf.byteLength < byteLen) {
      this._backupReadBuf = new Uint8ClampedArray(byteLen);
    }
    if (this._pboSupported && (this._chunkBackupPboRing.length === 0 || this._chunkBackupPboBytes < byteLen)) {
      for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
        if (this._chunkBackupPboRing[i]?.pbo) gl.deleteBuffer(this._chunkBackupPboRing[i].pbo);
      }
      this._chunkBackupPboRing = [];
      this._chunkBackupPboBytes = byteLen;
      for (let i = 0; i < CHUNK_BACKUP_RING_SIZE; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
        this._chunkBackupPboRing.push({ pbo, inUse: false });
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }

  _ensureLargeBackupResources(w, h, byteLen) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    if (!this._largeBackupUnpremultFbo || this._largeBackupUnpremultFbo.w !== w || this._largeBackupUnpremultFbo.h !== h) {
      this._delTexFBO(this._largeBackupUnpremultFbo);
      this._largeBackupUnpremultFbo = this._makeTexFBO(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    }
    if (!this._largeBackupReadBuf || this._largeBackupReadBuf.byteLength < byteLen) {
      this._largeBackupReadBuf = new Uint8ClampedArray(byteLen);
    }
    if (this._pboSupported && (this._largeBackupPboRing.length === 0 || this._largeBackupPboBytes < byteLen)) {
      for (let i = 0; i < this._largeBackupPboRing.length; i++) {
        if (this._largeBackupPboRing[i]?.pbo) gl.deleteBuffer(this._largeBackupPboRing[i].pbo);
      }
      this._largeBackupPboRing = [];
      this._largeBackupPboBytes = byteLen;
      for (let i = 0; i < LARGE_BACKUP_RING_SIZE; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);
        this._largeBackupPboRing.push({ pbo, inUse: false });
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }

  _tileNeedsGpuBackup(engine, chunk, layer, tile) {
    if (!chunk || !chunk.gpuTextures || !chunk.gpuTextures[layer]) return false;
    if (chunk.gpuDirty && chunk.gpuDirty[layer]) return false;
    if (!tile) return this._chunkNeedsGpuBackup(engine, chunk, layer);
    if (tile.cpuDirty) return true;
    const wx0 = tile.wx;
    const wy0 = tile.wy;
    const wx1 = wx0 + TILE_SIZE;
    const wy1 = wy0 + TILE_SIZE;
    for (let i = 0; i < this._inFlightSyncs.length; i++) {
      const job = this._inFlightSyncs[i];
      if (job.layer !== layer) continue;
      if (
        job.worldMinX < wx1 &&
        (job.worldMinX + job.worldW) > wx0 &&
        job.worldMinY < wy1 &&
        (job.worldMinY + job.worldH) > wy0
      ) {
        return true;
      }
    }
    return false;
  }

  _chunkNeedsGpuBackup(engine, chunk, layer) {
    if (!chunk || !chunk.gpuTextures || !chunk.gpuTextures[layer]) return false;
    if (chunk.gpuDirty && chunk.gpuDirty[layer]) return false;
    const isStatic = !!(engine && engine.isStatic);
    const lx = isStatic ? -engine.staticWidth * 0.5 : chunk.cx * engine.chunkSize;
    const ly = isStatic ? -engine.staticHeight * 0.5 : chunk.cy * engine.chunkSize;
    const rx = lx + chunk.width;
    const by = ly + chunk.height;

    let needs = false;
    this.activeTiles.forEach((t) => {
      if (needs || !t.cpuDirty) return;
      if (t.wx < rx && (t.wx + TILE_SIZE) > lx && t.wy < by && (t.wy + TILE_SIZE) > ly) {
        needs = true;
      }
    });
    if (needs) return true;

    for (let i = 0; i < this._inFlightSyncs.length; i++) {
      const job = this._inFlightSyncs[i];
      if (job.layer !== layer) continue;
      if (
        job.worldMinX < rx &&
        (job.worldMinX + job.worldW) > lx &&
        job.worldMinY < by &&
        (job.worldMinY + job.worldH) > ly
      ) {
        return true;
      }
    }
    return false;
  }

  _pumpAsyncChunkBackups(engine = null, budget = 6, forceLarge = false, maxMs = 0) {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this._inFlightChunkBackups.length === 0) return;

    const _tb0 = performance.now();
    const isDrawing = !!(engine && engine.isDrawing);
    let done = 0;
    let drainedBytes = 0;
    let drainedMode = '';
    let boundPbo = false;
    let i = 0;

    while (i < this._inFlightChunkBackups.length && done < budget) {
      if (done >= 1 && maxMs > 0 && (performance.now() - _tb0) >= maxMs) break;
      const job = this._inFlightChunkBackups[i];
      if (job.isLarge && isDrawing && !forceLarge) {
        i++;
        continue;
      }
      const status = job.sync ? gl.clientWaitSync(job.sync, 0, 0) : gl.ALREADY_SIGNALED;
      if (status === gl.TIMEOUT_EXPIRED) {
        i++;
        continue;
      }

      this._inFlightChunkBackups.splice(i, 1);
      if (job.sync) {
        gl.deleteSync(job.sync);
        job.sync = null;
      }

      if (!job.cancelled && job.entry && (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED)) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        boundPbo = true;
        if (job.isLarge) {
          if (!this._largeBackupReadBuf || this._largeBackupReadBuf.byteLength < job.byteLen) {
            this._largeBackupReadBuf = new Uint8ClampedArray(job.byteLen);
          }
          const view = this._largeBackupReadBuf.subarray(0, job.byteLen);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
          const imgData = new ImageData(view, job.texW, job.texH);
          const ctx = job.entry.ctx || job.entry.canvas?.getContext('2d');
          if (ctx) ctx.putImageData(imgData, 0, 0);
          drainedMode = 'pbo_large_drain';
        } else {
          if (!this._backupReadBuf || this._backupReadBuf.byteLength < job.byteLen) {
            this._backupReadBuf = new Uint8ClampedArray(job.byteLen);
          }
          const view = this._backupReadBuf.subarray(0, job.byteLen);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
          const imgData = new ImageData(view, job.texW, job.texH);
          const ctx = job.entry.ctx || job.entry.canvas?.getContext('2d');
          if (ctx) ctx.putImageData(imgData, 0, 0);
          if (!drainedMode) drainedMode = 'pbo_drain';
        }
        drainedBytes += job.byteLen;
      }

      if (job.entry) {
        job.entry._resolveSync = null;
        job.entry._cancelSync = null;
        job.entry._pendingBackupJob = null;
        job.entry = null;
      }
      if (job.slot) job.slot.inUse = false;
      job.resolved = true;
      done++;
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    if (done > 0 && !this._inChunkBackup) {
      const _sPerf = this._getPerfStats(engine);
      if (_sPerf) {
        _sPerf.backupMs += performance.now() - _tb0;
        _sPerf.backupBytes += drainedBytes;
        if (drainedMode) _sPerf.backupMode = drainedMode;
        this._snapContextStats(engine);
      }
    }
  }

  _resolveChunkBackupJob(job) {
    if (!job || job.resolved) return;
    const gl = this.gl;
    const idx = this._inFlightChunkBackups.indexOf(job);
    if (idx >= 0) this._inFlightChunkBackups.splice(idx, 1);

    if (!gl || gl.isContextLost()) {
      if (job.entry) {
        job.entry._resolveSync = null;
        job.entry._cancelSync = null;
        job.entry._pendingBackupJob = null;
        job.entry = null;
      }
      if (job.slot) job.slot.inUse = false;
      job.sync = null;
      job.resolved = true;
      return;
    }

    if (job.sync) {
      gl.finish();
      try { gl.clientWaitSync(job.sync, 0, 0); } catch (_) {}
      gl.deleteSync(job.sync);
      job.sync = null;
    }

    if (!job.cancelled && job.entry && job.slot) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
      let imgData;
      if (job.isLarge) {
        if (!this._largeBackupReadBuf || this._largeBackupReadBuf.byteLength < job.byteLen) {
          this._largeBackupReadBuf = new Uint8ClampedArray(job.byteLen);
        }
        const view = this._largeBackupReadBuf.subarray(0, job.byteLen);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
        imgData = new ImageData(view, job.texW, job.texH);
      } else {
        if (!this._backupReadBuf || this._backupReadBuf.byteLength < job.byteLen) {
          this._backupReadBuf = new Uint8ClampedArray(job.byteLen);
        }
        const view = this._backupReadBuf.subarray(0, job.byteLen);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
        imgData = new ImageData(view, job.texW, job.texH);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const ctx = job.entry.ctx || job.entry.canvas?.getContext('2d');
      if (ctx) {
        ctx.putImageData(imgData, 0, 0);
      }
    }

    if (job.entry) {
      job.entry._resolveSync = null;
      job.entry._cancelSync = null;
      job.entry._pendingBackupJob = null;
      job.entry = null;
    }
    if (job.slot) job.slot.inUse = false;
    job.resolved = true;
  }

  flushPendingChunkBackups() {
    if (this._inFlightChunkBackups.length === 0) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      for (let i = 0; i < this._inFlightChunkBackups.length; i++) {
        const job = this._inFlightChunkBackups[i];
        if (job.entry) {
          job.entry._resolveSync = null;
          job.entry._cancelSync = null;
          job.entry._pendingBackupJob = null;
          job.entry = null;
        }
        if (job.slot) job.slot.inUse = false;
        job.sync = null;
        job.resolved = true;
      }
      this._inFlightChunkBackups.length = 0;
      return;
    }

    gl.finish();
    let boundPbo = false;
    while (this._inFlightChunkBackups.length > 0) {
      const job = this._inFlightChunkBackups.shift();
      if (job.sync) {
        try { gl.clientWaitSync(job.sync, 0, 0); } catch (_) {}
        gl.deleteSync(job.sync);
        job.sync = null;
      }
      if (!job.cancelled && job.entry && job.slot) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        boundPbo = true;
        let imgData;
        if (job.isLarge) {
          if (!this._largeBackupReadBuf || this._largeBackupReadBuf.byteLength < job.byteLen) {
            this._largeBackupReadBuf = new Uint8ClampedArray(job.byteLen);
          }
          const view = this._largeBackupReadBuf.subarray(0, job.byteLen);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
          imgData = new ImageData(view, job.texW, job.texH);
        } else {
          if (!this._backupReadBuf || this._backupReadBuf.byteLength < job.byteLen) {
            this._backupReadBuf = new Uint8ClampedArray(job.byteLen);
          }
          const view = this._backupReadBuf.subarray(0, job.byteLen);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, job.byteLen);
          imgData = new ImageData(view, job.texW, job.texH);
        }
        const ctx = job.entry.ctx || job.entry.canvas?.getContext('2d');
        if (ctx) {
          ctx.putImageData(imgData, 0, 0);
        }
      }
      if (job.entry) {
        job.entry._resolveSync = null;
        job.entry._cancelSync = null;
        job.entry._pendingBackupJob = null;
        job.entry = null;
      }
      if (job.slot) job.slot.inUse = false;
      job.resolved = true;
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }

  _ensureSumiTilePatchBackup(engine, chunk, id, layer, backupMap, tile) {
    if (!engine || !chunk || !backupMap || !tile) return;

    const srcCanvas = chunk.canvases[layer];
    if (!srcCanvas) return;
    const texW = srcCanvas.width;
    const texH = srcCanvas.height;

    // Small chunks or completely blank layers keep the existing full-chunk / zero-alloc empty backup
    const hasGpuTex = !!(chunk.gpuTextures && chunk.gpuTextures[layer]);
    if (texW * texH <= 512 * 512 || (chunk.isEmpty && chunk.isEmpty[layer] && !hasGpuTex)) {
      if (!backupMap.has(id)) {
        this._ensureSumiChunkBackup(engine, chunk, id, layer, backupMap);
      }
      return;
    }

    let container = backupMap.get(id);
    if (container && !container.isPatchList) {
      return;
    }
    const patchKey = `${tile.tx},${tile.ty}`;
    if (container && container.patches && container.patches.has(patchKey)) {
      return;
    }

    const isStatic = !!(engine && engine.isStatic);
    const lx = isStatic ? -engine.staticWidth * 0.5 : chunk.cx * engine.chunkSize;
    const ly = isStatic ? -engine.staticHeight * 0.5 : chunk.cy * engine.chunkSize;
    const ox = Math.max(lx, tile.wx);
    const oy = Math.max(ly, tile.wy);
    const ox2 = Math.min(lx + chunk.width, tile.wx + TILE_SIZE);
    const oy2 = Math.min(ly + chunk.height, tile.wy + TILE_SIZE);
    if (ox2 <= ox || oy2 <= oy) return;

    const scaleX = texW / chunk.width;
    const scaleY = texH / chunk.height;
    const rx = Math.max(0, Math.floor((ox - lx) * scaleX));
    const ry = Math.max(0, Math.floor((oy - ly) * scaleY));
    const rx1 = Math.min(texW, Math.ceil((ox2 - lx) * scaleX));
    const ry1 = Math.min(texH, Math.ceil((oy2 - ly) * scaleY));
    const rw = rx1 - rx;
    const rh = ry1 - ry;
    if (rw <= 0 || rh <= 0) return;

    if (!container) {
      container = {
        layer,
        isPatchList: true,
        wasEmpty: false,
        width: texW,
        height: texH,
        patches: new Map(),
        _resolveSync: () => {
          if (container.patches) {
            container.patches.forEach((p) => {
              if (p && typeof p._resolveSync === 'function') p._resolveSync();
            });
          }
        },
        _cancelSync: () => {
          if (container.patches) {
            container.patches.forEach((p) => {
              if (p && typeof p._cancelSync === 'function') p._cancelSync();
            });
          }
        }
      };
      backupMap.set(id, container);
    }

    const _tb0 = performance.now();
    this._inChunkBackup = true;
    const byteLen = rw * rh * 4;
    let backupMode = 'patch_2d';

    try {
      const patchCanvas = acquireBackupCanvas(engine, rw, rh, false);
      let bCtx = patchCanvas._cached2dCtx;
      if (!bCtx) {
        bCtx = patchCanvas.getContext('2d');
        patchCanvas._cached2dCtx = bCtx;
      }
      const patchEntry = {
        rx,
        ry,
        rw,
        rh,
        canvas: patchCanvas,
        ctx: bCtx,
        width: rw,
        height: rh,
        _willReadFrequently: false
      };

      const gpuClean = hasGpuTex && !(chunk.gpuDirty && chunk.gpuDirty[layer]);
      const needGpu = gpuClean && this._tileNeedsGpuBackup(engine, chunk, layer, tile);
      const gl = this.gl;

      if (!needGpu || !gl || gl.isContextLost() || !this.progUnpremultRect) {
        bCtx.save();
        bCtx.setTransform(1, 0, 0, 1, 0, 0);
        bCtx.globalAlpha = 1.0;
        bCtx.globalCompositeOperation = 'copy';
        bCtx.drawImage(srcCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
        bCtx.restore();
        container.patches.set(patchKey, patchEntry);
        return;
      }

      const fboW = Math.max(512, rw);
      const fboH = Math.max(512, rh);
      const minBytes = Math.max(512 * 512 * 4, byteLen);
      if (this._pboSupported) {
        this._ensureChunkBackupResources(fboW, fboH, minBytes);
      } else {
        if (!this._backupUnpremultFbo || this._backupUnpremultFbo.w !== fboW || this._backupUnpremultFbo.h !== fboH) {
          this._delTexFBO(this._backupUnpremultFbo);
          this._backupUnpremultFbo = this._makeTexFBO(fboW, fboH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        }
        if (!this._backupReadBuf || this._backupReadBuf.byteLength < byteLen) {
          this._backupReadBuf = new Uint8ClampedArray(minBytes);
        }
      }

      if (!this._backupUnpremultFbo) {
        bCtx.save();
        bCtx.setTransform(1, 0, 0, 1, 0, 0);
        bCtx.globalAlpha = 1.0;
        bCtx.globalCompositeOperation = 'copy';
        bCtx.drawImage(srcCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
        bCtx.restore();
        container.patches.set(patchKey, patchEntry);
        return;
      }

      let slot = null;
      if (this._pboSupported) {
        for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
          if (!this._chunkBackupPboRing[i].inUse) {
            slot = this._chunkBackupPboRing[i];
            break;
          }
        }
        if (!slot) {
          this._pumpAsyncChunkBackups(engine, CHUNK_BACKUP_RING_SIZE);
          for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
            if (!this._chunkBackupPboRing[i].inUse) {
              slot = this._chunkBackupPboRing[i];
              break;
            }
          }
        }
        if (!slot && this._inFlightChunkBackups.length > 0) {
          this._resolveChunkBackupJob(this._inFlightChunkBackups[0]);
          for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
            if (!this._chunkBackupPboRing[i].inUse) {
              slot = this._chunkBackupPboRing[i];
              break;
            }
          }
        }
      }

      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.gpuRenderer.vao);
      gl.viewport(0, 0, rw, rh);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._backupUnpremultFbo.fbo);
      gl.useProgram(this.progUnpremultRect);
      gl.uniform4f(this.locUnpremultRect.u_srcRect, 0, 0, rw, rh);
      gl.uniform4f(this.locUnpremultRect.u_dstRect, 0, 0, rw, rh);
      gl.uniform4f(this.locUnpremultRect.u_uvSubRect, rx / texW, ry / texH, rw / texW, rh / texH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
      gl.uniform1i(this.locUnpremultRect.u_tex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (slot) {
        slot.inUse = true;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (this._deferBackupFlush) {
          this._queuedBackupFlush = true;
        } else {
          gl.flush();
        }
        const job = {
          entry: patchEntry,
          texW: rw,
          texH: rh,
          byteLen,
          slot,
          sync,
          resolved: false,
          cancelled: false,
          isLarge: false
        };
        patchEntry._pendingBackupJob = job;
        patchEntry._resolveSync = () => this._resolveChunkBackupJob(job);
        patchEntry._cancelSync = () => {
          job.cancelled = true;
          job.entry = null;
          patchEntry._resolveSync = null;
          patchEntry._cancelSync = null;
          patchEntry._pendingBackupJob = null;
        };
        this._inFlightChunkBackups.push(job);
        backupMode = 'patch_pbo';
      } else {
        const view = this._backupReadBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.readPixels(0, 0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view);
        bCtx.putImageData(new ImageData(view, rw, rh), 0, 0);
        backupMode = 'patch_sync';
      }

      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      container.patches.set(patchKey, patchEntry);
    } finally {
      this._inChunkBackup = false;
      const _sPerf = this._getPerfStats(engine);
      if (_sPerf) {
        _sPerf.backupMs += performance.now() - _tb0;
        _sPerf.backupBytes += byteLen;
        _sPerf.backupMode = backupMode;
        this._snapContextStats(engine);
      }
    }
  }

  _ensureSumiChunkBackup(engine, chunk, id, layer, backupMap) {
    if (!engine || !chunk || !backupMap || backupMap.has(id)) return;

    const _tb0 = performance.now();
    this._inChunkBackup = true;
    let backupMode = 'cpu2d';
    let backupBytes = (chunk.width || 0) * (chunk.height || 0) * 4;

    try {
      const hasGpuTex = !!(chunk.gpuTextures && chunk.gpuTextures[layer]);
      const gpuClean = hasGpuTex && !(chunk.gpuDirty && chunk.gpuDirty[layer]);
      if ((chunk.isEmpty && chunk.isEmpty[layer] && !hasGpuTex) || !gpuClean || !this._chunkNeedsGpuBackup(engine, chunk, layer)) {
        backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
        return;
      }

      const gl = this.gl;
      if (!gl || gl.isContextLost()) {
        backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
        return;
      }

      const texW = chunk.canvases[layer].width;
      const texH = chunk.canvases[layer].height;
      const byteLen = texW * texH * 4;
      backupBytes = byteLen;

      const backup = acquireBackupCanvas(engine, texW, texH, false);
      let bCtx = backup._cached2dCtx;
      if (!bCtx) {
        bCtx = backup.getContext('2d');
        backup._cached2dCtx = bCtx;
      }
      const entry = {
        layer,
        canvas: backup,
        ctx: bCtx,
        wasEmpty: false,
        _willReadFrequently: false,
        width: texW,
        height: texH
      };

      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.gpuRenderer.vao);

      // Oversized single sheet (>512x512): prefer non-blocking 2-slot async PBO readback
      if (byteLen > 512 * 512 * 4) {
        if (this._pboSupported) {
          this._ensureLargeBackupResources(texW, texH, byteLen);
          if (this._largeBackupUnpremultFbo && this._largeBackupPboRing.length > 0) {
            let slot = null;
            for (let i = 0; i < this._largeBackupPboRing.length; i++) {
              if (!this._largeBackupPboRing[i].inUse) {
                slot = this._largeBackupPboRing[i];
                break;
              }
            }
            if (!slot) {
              this._pumpAsyncChunkBackups(engine, LARGE_BACKUP_RING_SIZE, true);
              for (let i = 0; i < this._largeBackupPboRing.length; i++) {
                if (!this._largeBackupPboRing[i].inUse) {
                  slot = this._largeBackupPboRing[i];
                  break;
                }
              }
            }
            if (!slot && this._inFlightChunkBackups.length > 0) {
              let targetJob = null;
              for (let i = 0; i < this._inFlightChunkBackups.length; i++) {
                if (this._inFlightChunkBackups[i].isLarge) {
                  targetJob = this._inFlightChunkBackups[i];
                  break;
                }
              }
              this._resolveChunkBackupJob(targetJob || this._inFlightChunkBackups[0]);
              for (let i = 0; i < this._largeBackupPboRing.length; i++) {
                if (!this._largeBackupPboRing[i].inUse) {
                  slot = this._largeBackupPboRing[i];
                  break;
                }
              }
            }

            gl.viewport(0, 0, texW, texH);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._largeBackupUnpremultFbo.fbo);
            gl.useProgram(this.progUnpremult);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
            gl.uniform1i(this.locUnpremult.u_tex, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            if (slot) {
              slot.inUse = true;
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
              gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
              const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
              gl.flush();
              const job = {
                entry,
                texW,
                texH,
                byteLen,
                slot,
                sync,
                resolved: false,
                cancelled: false,
                isLarge: true
              };
              entry._pendingBackupJob = job;
              entry._resolveSync = () => this._resolveChunkBackupJob(job);
              entry._cancelSync = () => {
                job.cancelled = true;
                job.entry = null;
                entry._resolveSync = null;
                entry._cancelSync = null;
                entry._pendingBackupJob = null;
              };
              this._inFlightChunkBackups.push(job);
              backupMode = 'pbo_large';
            } else {
              const view = this._largeBackupReadBuf.subarray(0, byteLen);
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
              gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, view);
              bCtx.putImageData(new ImageData(view, texW, texH), 0, 0);
              backupMode = 'sync_large';
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            backupMap.set(id, entry);
            return;
          }
        }

        const tmpFbo = this._makeTexFBO(texW, texH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        if (tmpFbo) {
          gl.viewport(0, 0, texW, texH);
          gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFbo.fbo);
          gl.useProgram(this.progUnpremult);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
          gl.uniform1i(this.locUnpremult.u_tex, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          const px = new Uint8ClampedArray(byteLen);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, px);
          bCtx.putImageData(new ImageData(px, texW, texH), 0, 0);
          this._delTexFBO(tmpFbo);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          backupMap.set(id, entry);
          backupMode = 'sync_large';
          return;
        }
        backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
        return;
      }

      if (!this._pboSupported) {
        const tmpFbo = this._makeTexFBO(texW, texH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        if (tmpFbo) {
          gl.viewport(0, 0, texW, texH);
          gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFbo.fbo);
          gl.useProgram(this.progUnpremult);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
          gl.uniform1i(this.locUnpremult.u_tex, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          const px = new Uint8ClampedArray(byteLen);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, px);
          bCtx.putImageData(new ImageData(px, texW, texH), 0, 0);
          this._delTexFBO(tmpFbo);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          backupMap.set(id, entry);
          backupMode = 'sync';
          return;
        }
        backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
        return;
      }

      this._ensureChunkBackupResources(texW, texH, byteLen);
      if (!this._backupUnpremultFbo) {
        backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
        return;
      }

      let slot = null;
      for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
        if (!this._chunkBackupPboRing[i].inUse) {
          slot = this._chunkBackupPboRing[i];
          break;
        }
      }
      if (!slot) {
        this._pumpAsyncChunkBackups(engine, CHUNK_BACKUP_RING_SIZE);
        for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
          if (!this._chunkBackupPboRing[i].inUse) {
            slot = this._chunkBackupPboRing[i];
            break;
          }
        }
      }
      if (!slot && this._inFlightChunkBackups.length > 0) {
        this._resolveChunkBackupJob(this._inFlightChunkBackups[0]);
        for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
          if (!this._chunkBackupPboRing[i].inUse) {
            slot = this._chunkBackupPboRing[i];
            break;
          }
        }
      }

      gl.viewport(0, 0, texW, texH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._backupUnpremultFbo.fbo);
      gl.useProgram(this.progUnpremult);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
      gl.uniform1i(this.locUnpremult.u_tex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (slot) {
        slot.inUse = true;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (this._deferBackupFlush) {
          this._queuedBackupFlush = true;
        } else {
          gl.flush();
        }
        const job = { entry, texW, texH, byteLen, slot, sync, resolved: false, cancelled: false, isLarge: false };
        entry._pendingBackupJob = job;
        entry._resolveSync = () => this._resolveChunkBackupJob(job);
        entry._cancelSync = () => {
          job.cancelled = true;
          job.entry = null;
          entry._resolveSync = null;
          entry._cancelSync = null;
          entry._pendingBackupJob = null;
        };
        this._inFlightChunkBackups.push(job);
        backupMode = 'pbo';
      } else {
        const view = this._backupReadBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, view);
        bCtx.putImageData(new ImageData(view, texW, texH), 0, 0);
        backupMode = 'sync';
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      backupMap.set(id, entry);
    } finally {
      this._inChunkBackup = false;
      const _sPerf = this._getPerfStats(engine);
      if (_sPerf) {
        _sPerf.backupMs += performance.now() - _tb0;
        _sPerf.backupBytes += backupBytes;
        _sPerf.backupMode = backupMode;
        this._snapContextStats(engine);
      }
    }
  }

  _writeSyncBytesToChunks(engine, job, bytes) {
    if (job.tile && job.tile._syncGen === job.tileSyncInstance && job.tile._blitGen > job.tileGen) {
      let hasNewerSync = false;
      for (let i = 0; i < this._inFlightSyncs.length; i++) {
        const other = this._inFlightSyncs[i];
        if (other && other.tile === job.tile && other.tileSyncInstance === job.tileSyncInstance && other.tileGen >= job.tile._blitGen) {
          hasNewerSync = true;
          break;
        }
      }
      if (!hasNewerSync && job.tile.maxX > job.tile.minX && job.tile.maxY > job.tile.minY) {
        job.tile.cpuDirty = true;
        this._hasCpuDirty = true;
      }
      return;
    }
    const { layer, tr, rw, rh, worldMinX, worldMinY, worldW, worldH, alphaLock, targetMapOverride } = job;
    const pw = rw + 2;
    const ph = rh + 2;
    const dst = this._paddedCommitBuf;
    const rowBytes = rw * 4;
    const dstStride = pw * 4;
    for (let y = 0; y < rh; y++) {
      const srcOff = y * rowBytes;
      const dstOff = (y + 1) * dstStride;
      dst.set(bytes.subarray(srcOff, srcOff + rowBytes), dstOff + 4);
      dst[dstOff] = bytes[srcOff];
      dst[dstOff + 1] = bytes[srcOff + 1];
      dst[dstOff + 2] = bytes[srcOff + 2];
      dst[dstOff + 3] = bytes[srcOff + 3];
      const srcLast = srcOff + rowBytes - 4;
      const dstRight = dstOff + 4 + rowBytes;
      dst[dstRight] = bytes[srcLast];
      dst[dstRight + 1] = bytes[srcLast + 1];
      dst[dstRight + 2] = bytes[srcLast + 2];
      dst[dstRight + 3] = bytes[srcLast + 3];
    }
    dst.copyWithin(0, dstStride, dstStride * 2);
    dst.copyWithin((rh + 1) * dstStride, rh * dstStride, (rh + 1) * dstStride);

    const imgData = new ImageData(dst.subarray(0, pw * ph * 4), pw, ph);
    this._commitCtx.putImageData(imgData, 0, 0);

    engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, worldMinX);
    engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, worldMinX + worldW);
    engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, worldMinY);
    engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, worldMinY + worldH);

    const sCX = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((worldMinX + worldW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((worldMinY + worldH - 1) / engine.chunkSize);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
        if (!chunk) continue;

        const id = `${cx},${cy}`;
        const backupMap = this._getChunkBackupMap(engine, layer, targetMapOverride);
        if (backupMap) {
          const existing = backupMap.get(id);
          if (job.tile && (!existing || (existing.isPatchList && !existing.patches?.has(`${job.tile.tx},${job.tile.ty}`)))) {
            this._ensureSumiTilePatchBackup(engine, chunk, id, layer, backupMap, job.tile);
          } else if (!existing) {
            backupChunkLayer(engine, chunk, id, { layer, fromSumi: true, markDirty: false, targetMap: backupMap });
          }
        }

        const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
        const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
        const ox = Math.max(worldMinX, lx);
        const oy = Math.max(worldMinY, ly);
        const ox2 = Math.min(worldMinX + worldW, lx + chunk.width);
        const oy2 = Math.min(worldMinY + worldH, ly + chunk.height);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow <= 0 || oh <= 0) continue;

        const srcX = ((ox - worldMinX) / worldW) * rw;
        const srcY = ((oy - worldMinY) / worldH) * rh;
        const srcW = (ow / worldW) * rw;
        const srcH = (oh / worldH) * rh;

        const ctx = chunk.ctxs[layer];
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chunk.width, chunk.height);
        ctx.clip();
        ctx.imageSmoothingEnabled = (tr !== TILE_SIZE);
        if (alphaLock) {
          ctx.globalCompositeOperation = 'source-atop';
        } else {
          ctx.clearRect(ox - lx, oy - ly, ow, oh);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.drawImage(this._commitCanvas, 1 + srcX, 1 + srcY, srcW, srcH, ox - lx, oy - ly, ow, oh);
        ctx.restore();

        if (chunk.isEmpty) chunk.isEmpty[layer] = false;
        const hadGpuTex = !!(chunk.gpuTextures && chunk.gpuTextures[layer]);
        const wasGpuDirty = !!(chunk.gpuDirty && chunk.gpuDirty[layer]);
        engine._markDirty(id, layer, false, true);
        if (chunk.gpuDirty && hadGpuTex && !wasGpuDirty) {
          chunk.gpuDirty[layer] = false;
        }
      }
    }
  }

  _pumpAsyncSyncs(engine, budget = 2, maxMs = 2.2) {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this._inFlightSyncs.length === 0) return;

    const now = performance.now();
    if ((now - (this._lastSyncPumpMs || 0)) < 8 && this._inFlightSyncs.length < 4) return;
    this._lastSyncPumpMs = now;

    const _ts0 = now;
    let done = 0;
    let boundPbo = false;
    while (this._inFlightSyncs.length > 0 && done < budget) {
      if (done >= 1 && maxMs > 0 && (performance.now() - _ts0) >= maxMs) break;
      const job = this._inFlightSyncs[0];
      const status = gl.clientWaitSync(job.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;

      this._inFlightSyncs.shift();
      gl.deleteSync(job.sync);
      job.sync = null;

      if (
        (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) &&
        engine &&
        job.projectId === (this.projectId || engine.currentProjectId || 'default')
      ) {
        const byteLen = job.rw * job.rh * 4;
        const view = this._readBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        boundPbo = true;
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, byteLen);
        this._writeSyncBytesToChunks(engine, job, view);
      }
      if (job.slot) job.slot.inUse = false;
      done++;
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    if (done > 0) {
      const _sPerf = this._getPerfStats(engine);
      if (_sPerf) {
        if (!this._inSyncOuter) {
          _sPerf.syncMs += performance.now() - _ts0;
        }
        _sPerf.syncTiles += done;
        this._snapContextStats(engine);
      }
    }
  }

  flushPendingSyncs(engine = null) {
    if (this._inFlightSyncs.length === 0) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      for (let i = 0; i < this._inFlightSyncs.length; i++) {
        if (this._inFlightSyncs[i].slot) this._inFlightSyncs[i].slot.inUse = false;
      }
      this._inFlightSyncs.length = 0;
      return;
    }

    const _ts0 = performance.now();
    let done = 0;
    gl.finish();
    let boundPbo = false;
    while (this._inFlightSyncs.length > 0) {
      const job = this._inFlightSyncs.shift();
      if (job.sync) {
        try { gl.clientWaitSync(job.sync, 0, 0); } catch (_) {}
        gl.deleteSync(job.sync);
        job.sync = null;
      }
      if (engine && job.projectId === (this.projectId || engine.currentProjectId || 'default')) {
        const byteLen = job.rw * job.rh * 4;
        const view = this._readBuf.subarray(0, byteLen);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.slot.pbo);
        boundPbo = true;
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, view, 0, byteLen);
        this._writeSyncBytesToChunks(engine, job, view);
      }
      if (job.slot) job.slot.inUse = false;
      done++;
    }
    if (boundPbo) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    if (done > 0 && engine) {
      const _sPerf = this._getPerfStats(engine);
      if (_sPerf) {
        if (!this._inSyncOuter) {
          _sPerf.syncMs += performance.now() - _ts0;
        }
        _sPerf.syncTiles += done;
        this._snapContextStats(engine);
      }
    }
  }

  pumpAsyncWork(engine = null, skipCpuSync = false) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return;
    if (engine) {
      const isDraw = !!engine.isDrawing;
      this._pumpAsyncProbes(engine, isDraw ? 6 : 10);
      if (!skipCpuSync) {
        this._pumpAsyncSyncs(engine, 2, 2.2);
      }
      this._pumpAsyncChunkBackups(engine, isDraw ? 2 : 3, false, isDraw ? 1.8 : 2.4);
    }
    this._pumpAsyncPacks(6);
  }

  _syncSingleTileToCanvas2D(engine, t, params = {}, targetMapOverride = null, asyncPreferred = false) {
    if (!t || !t.cpuDirty || t.maxX <= t.minX || t.maxY <= t.minY) return false;
    const _ts0 = performance.now();
    const _sPerf = this._getPerfStats(engine);
    const _subPrev = _sPerf ? _sPerf.subBakeMs : 0;

    const gl = this.gl;
    const layer = this.layer >= 0 ? this.layer : engine.activeLayer;
    const projId = this.projectId || engine.currentProjectId || 'default';
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = !!(layerSet && layerSet.alphaLock);

    const tr = t.res || this.tileRes;
    const tw = TILE_SIZE / tr;
    const align = tr === 192 ? 3 : 1;

    const rx0 = Math.max(0, Math.floor((t.minX | 0) / align) * align);
    const ry0 = Math.max(0, Math.floor((t.minY | 0) / align) * align);
    const rx1 = Math.min(tr, Math.ceil(t.maxX / align) * align);
    const ry1 = Math.min(tr, Math.ceil(t.maxY / align) * align);
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) {
      t.cpuDirty = false;
      return false;
    }

    const worldMinX = t.wx + Math.round(rx0 * tw);
    const worldMinY = t.wy + Math.round(ry0 * tw);
    const worldW = Math.max(1, Math.round(rw * tw));
    const worldH = Math.max(1, Math.round(rh * tw));

    this._bakeTileSubIfNeeded(engine, t, params);

    const backupMapForTile = this._getChunkBackupMap(engine, layer, targetMapOverride);
    if (backupMapForTile) {
      const sCXb = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
      const eCXb = engine.isStatic ? 0 : Math.floor((worldMinX + worldW - 1) / engine.chunkSize);
      const sCYb = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
      const eCYb = engine.isStatic ? 0 : Math.floor((worldMinY + worldH - 1) / engine.chunkSize);
      for (let cx = sCXb; cx <= eCXb; cx++) {
        for (let cy = sCYb; cy <= eCYb; cy++) {
          const chunk = engine.isStatic ? engine._getChunk(0, 0) : engine._getChunk(cx, cy);
          if (!chunk) continue;
          const id = `${cx},${cy}`;
          this._ensureSumiTilePatchBackup(engine, chunk, id, layer, backupMapForTile, t);
        }
      }
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);

    gl.viewport(0, 0, tr, tr);
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
    gl.uniform1i(this.locComp.u_unpremult, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const job = {
      layer,
      projId,
      projectId: projId,
      tr,
      rx0,
      ry0,
      rw,
      rh,
      worldMinX,
      worldMinY,
      worldW,
      worldH,
      alphaLock,
      targetMapOverride,
      tile: t,
      tileGen: t._blitGen || 0,
      tileSyncInstance: t._syncGen || 0,
      slot: null,
      sync: null
    };

    if (asyncPreferred && this._pboSupported && !targetMapOverride) {
      this._initPboRings();
      let slot = null;
      for (let i = 0; i < this._syncPboRing.length; i++) {
        if (!this._syncPboRing[i].inUse) {
          slot = this._syncPboRing[i];
          break;
        }
      }
      if (slot) {
        engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, worldMinX);
        engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, worldMinX + worldW);
        engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, worldMinY);
        engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, worldMinY + worldH);

        slot.inUse = true;
        job.slot = slot;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.readPixels(rx0, ry0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        job.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this._inFlightSyncs.push(job);
        t.cpuDirty = false;
        if (_sPerf) {
          if (!this._inSyncOuter) {
            const _subDelta = _sPerf.subBakeMs - _subPrev;
            _sPerf.syncMs += Math.max(0, (performance.now() - _ts0) - _subDelta);
          }
          _sPerf.syncTiles += 1;
        }
        return true;
      }
    }

    const byteLen = rw * rh * 4;
    const view = this._readBuf.subarray(0, byteLen);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.readPixels(rx0, ry0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view);
    this._writeSyncBytesToChunks(engine, job, view);
    t.cpuDirty = false;
    if (_sPerf) {
      if (!this._inSyncOuter) {
        const _subDelta = _sPerf.subBakeMs - _subPrev;
        _sPerf.syncMs += Math.max(0, (performance.now() - _ts0) - _subDelta);
      }
      _sPerf.syncTiles += 1;
    }
    return true;
  }

  syncTilesToCanvas2D(engine, params = {}, targetMapOverride = null, asyncPreferred = false) {
    if (!this.ready || !this.active || !engine || this.activeTiles.size === 0) return;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const _ts0 = performance.now();
    const _sPerf = this._getPerfStats(engine);
    const _subPrev = _sPerf ? _sPerf.subBakeMs : 0;
    const _wasOuter = this._inSyncOuter;
    this._inSyncOuter = true;

    try {
      this._pumpAsyncSyncs(engine, 2, 2.2);

      if (!asyncPreferred || targetMapOverride) {
        this.flushPendingSyncs(engine);
      }

      const dirtyTiles = [];
      this.activeTiles.forEach((t) => {
        if (t.cpuDirty && t.maxX > t.minX && t.maxY > t.minY) {
          dirtyTiles.push(t);
        }
      });

      if (asyncPreferred && this._pboSupported && !targetMapOverride) {
        let queuedAny = false;
        let queued = 0;
        for (let i = 0; i < dirtyTiles.length; i++) {
          if (queued >= 2 || this._inFlightSyncs.length >= 4) break;
          if (this._syncSingleTileToCanvas2D(engine, dirtyTiles[i], activeParams, targetMapOverride, true)) {
            queuedAny = true;
            queued++;
          }
        }
        if (queuedAny) gl.flush();
        let stillDirty = false;
        this.activeTiles.forEach((t) => {
          if (t.cpuDirty && t.maxX > t.minX && t.maxY > t.minY) stillDirty = true;
        });
        this._hasCpuDirty = stillDirty;
      } else {
        for (let i = 0; i < dirtyTiles.length; i++) {
          this._syncSingleTileToCanvas2D(engine, dirtyTiles[i], activeParams, targetMapOverride, false);
        }
        this._hasCpuDirty = false;
      }

      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } finally {
      this._inSyncOuter = _wasOuter;
      if (_sPerf && !_wasOuter) {
        const _subDelta = _sPerf.subBakeMs - _subPrev;
        _sPerf.syncMs += Math.max(0, (performance.now() - _ts0) - _subDelta);
        this._snapContextStats(engine);
      }
    }
  }

  syncSettledTilesAsync(engine, maxQueued = 2) {
    if (!this.ready || !this.active || !engine || !this._pboSupported || this.activeTiles.size === 0) return;
    if (!this._hasCpuDirty) return;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    const _ts0 = performance.now();
    const _sPerf = this._getPerfStats(engine);
    const _subPrev = _sPerf ? _sPerf.subBakeMs : 0;
    const _wasOuter = this._inSyncOuter;
    this._inSyncOuter = true;

    try {
      this._pumpAsyncSyncs(engine, 2, 2.2);
      const activeParams = this.lastParams || {};
      const cap = Math.min(maxQueued, 2);
      let queued = 0;
      let queuedAny = false;
      this.activeTiles.forEach((t) => {
        if (queued >= cap || this._inFlightSyncs.length >= 3) return;
        if (t.cpuDirty && t.wetTicks === 0 && t.maxX > t.minX && t.maxY > t.minY) {
          if (this._syncSingleTileToCanvas2D(engine, t, activeParams, null, true)) {
            queuedAny = true;
            queued++;
          }
        }
      });
      if (queuedAny) gl.flush();

      let stillDirty = false;
      this.activeTiles.forEach((t) => {
        if (t.cpuDirty && t.maxX > t.minX && t.maxY > t.minY) stillDirty = true;
      });
      this._hasCpuDirty = stillDirty;

      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } finally {
      this._inSyncOuter = _wasOuter;
      if (_sPerf && !_wasOuter) {
        const _subDelta = _sPerf.subBakeMs - _subPrev;
        _sPerf.syncMs += Math.max(0, (performance.now() - _ts0) - _subDelta);
        this._snapContextStats(engine);
      }
    }
  }

  _boxHasDirtyTiles(x0, y0, x1, y1) {
    const tx0 = Math.floor(x0 / TILE_SIZE);
    const tx1 = Math.floor((x1 - 1) / TILE_SIZE);
    const ty0 = Math.floor(y0 / TILE_SIZE);
    const ty1 = Math.floor((y1 - 1) / TILE_SIZE);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this.activeTiles.get(`${tx},${ty}`);
        if (t && (t.dirty || t.wetTicks > 0 || t.loadedFromPassive)) return true;
      }
    }
    return false;
  }

  _dryAllActiveTilesForArchive(engine, activeParams) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return;
    const STEP_SPAN = 640;
    const snap = this.snapWorld || 4;
    let rawMinX = this.dirtyMinX;
    let rawMinY = this.dirtyMinY;
    let rawMaxX = this.dirtyMaxX;
    let rawMaxY = this.dirtyMaxY;
    this.activeTiles.forEach((t) => {
      if (t && (t.dirty || t.wetTicks > 0 || t.loadedFromPassive)) {
        rawMinX = Math.min(rawMinX, t.wx);
        rawMinY = Math.min(rawMinY, t.wy);
        rawMaxX = Math.max(rawMaxX, t.wx + TILE_SIZE);
        rawMaxY = Math.max(rawMaxY, t.wy + TILE_SIZE);
      }
    });
    const minX = Math.floor(rawMinX / snap) * snap;
    const minY = Math.floor(rawMinY / snap) * snap;
    const maxX = Math.ceil(rawMaxX / snap) * snap;
    const maxY = Math.ceil(rawMaxY / snap) * snap;
    const apron = snap;

    if (maxX > minX && maxY > minY) {
      for (let x = minX; x < maxX; x += STEP_SPAN) {
        for (let y = minY; y < maxY; y += STEP_SPAN) {
          const innerW = Math.min(STEP_SPAN, maxX - x);
          const innerH = Math.min(STEP_SPAN, maxY - y);
          if (!this._boxHasDirtyTiles(x, y, x + innerW, y + innerH)) continue;
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

    this.flushPendingChunkBackups();
    this.syncTilesToCanvas2D(engine, activeParams, null, false);
    this.flushPendingSyncs(engine);

    if (closeSession) {
      this.flushPendingPacks();
      this._archiveActiveTiles(engine, activeParams);
      this._releaseAllTiles();
      this.touchedChunks.clear();
      this.active = false;
      this.simActiveFrames = 0;
      this._activeSolverCount = 0;
      this._needsDryOnClose = false;
      this._currentSumiBefore = null;
      this._recordedBeforeKeys = null;
      this._activeHistoryAction = null;
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

  flushActiveForExternalEdit(engine, layer = -1) {
    if (!this.ready || !engine) return;
    this.flushPendingChunkBackups();
    this.flushPendingSyncs(engine);
    this.flushPendingPacks();
    if (this.active && (layer < 0 || this.layer === layer)) {
      this.commitToChunks(engine, this.lastParams || {}, true);
    }
  }

  captureSumiRegionForLiquify(engine, layer, projId, minX, minY, maxX, maxY, sessionOrigs, strokeBeforeMap) {
    if (!engine || layer < 0) return;
    const pid = projId || engine.currentProjectId || 'default';
    const tx0 = Math.floor(minX / TILE_SIZE);
    const tx1 = Math.floor((maxX - 1) / TILE_SIZE);
    const ty0 = Math.floor(minY / TILE_SIZE);
    const ty1 = Math.floor((maxY - 1) / TILE_SIZE);

    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const key = this._getPassiveKey(pid, layer, tx, ty);
        const existing = this.passiveTiles.get(key) || null;
        if (sessionOrigs && !sessionOrigs.has(key)) {
          sessionOrigs.set(key, existing ? { ...existing } : null);
        }
        if (strokeBeforeMap && !strokeBeforeMap.has(key)) {
          const wasExact = existing ? this._revsMatchPassive(engine, layer, existing) : false;
          strokeBeforeMap.set(key, existing ? { entry: existing, wasExact } : null);
        }
      }
    }
  }

  applyLiquifyWarpToPassive(engine, layer, projId, dstBounds, sessionOrigs, strokeBeforeMap, activeDispTiles, dispRes) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !engine || !activeDispTiles || activeDispTiles.size === 0 || !dstBounds) {
      return false;
    }
    if (!(dstBounds.maxX > dstBounds.minX && dstBounds.maxY > dstBounds.minY)) return false;

    const pid = projId || engine.currentProjectId || 'default';
    const tr = this.tileRes;
    const dRes = dispRes || 256;
    const floatFilter = this._floatFilter || gl.LINEAR;

    const dtx0 = Math.floor(dstBounds.minX / TILE_SIZE);
    const dtx1 = Math.floor((dstBounds.maxX - 1) / TILE_SIZE);
    const dty0 = Math.floor(dstBounds.minY / TILE_SIZE);
    const dty1 = Math.floor((dstBounds.maxY - 1) / TILE_SIZE);

    // Ensure lazy tr x tr RGBA16F warp destination target exists and uses linear filtering on dry source
    if (!this._warpDryDst || this._warpDryDst.w !== tr || this._warpDryDst.h !== tr) {
      this._delTexFBO(this._warpDryDst);
      this._warpDryDst = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, floatFilter);
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // Temporarily allow linear filtering on texTileDryTmp for smooth dryPig warping
    gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, floatFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, floatFilter);
    gl.bindTexture(gl.TEXTURE_2D, null);

    let modified = false;
    const byteLen = tr * tr * 4;
    const drySub = this._packBuf.subarray(0, byteLen);
    const baseSub = this._basePackBuf.subarray(0, byteLen);
    const clampMin = 0.5 / dRes;
    const clampMax = 1.0 - 0.5 / dRes;

    for (let dtx = dtx0; dtx <= dtx1; dtx++) {
      for (let dty = dty0; dty <= dty1; dty++) {
        const dKey = `${dtx},${dty}`;
        const dTile = activeDispTiles.get(dKey);
        if (!dTile || !dTile.tex) continue;

        const dWx = dtx * TILE_SIZE;
        const dWy = dty * TILE_SIZE;
        const srcMinX = dWx - (dTile.maxDx || 0) - 6;
        const srcMaxX = dWx + TILE_SIZE - (dTile.minDx || 0) + 6;
        const srcMinY = dWy - (dTile.maxDy || 0) - 6;
        const srcMaxY = dWy + TILE_SIZE - (dTile.minDy || 0) + 6;

        const stx0 = Math.floor(srcMinX / TILE_SIZE);
        const stx1 = Math.floor((srcMaxX - 1) / TILE_SIZE);
        const sty0 = Math.floor(srcMinY / TILE_SIZE);
        const sty1 = Math.floor((srcMaxY - 1) / TILE_SIZE);

        const srcEntries = [];
        for (let stx = stx0; stx <= stx1; stx++) {
          for (let sty = sty0; sty <= sty1; sty++) {
            const sKey = this._getPassiveKey(pid, layer, stx, sty);
            let sEntry = null;
            if (sessionOrigs && sessionOrigs.has(sKey)) {
              sEntry = sessionOrigs.get(sKey);
            } else {
              sEntry = this.passiveTiles.get(sKey) || null;
              if (sessionOrigs) sessionOrigs.set(sKey, sEntry ? { ...sEntry } : null);
            }
            if (sEntry && sEntry.dryPigBytes) {
              srcEntries.push(sEntry);
            }
          }
        }

        const dstKey = this._getPassiveKey(pid, layer, dtx, dty);
        if (strokeBeforeMap && !strokeBeforeMap.has(dstKey)) {
          const prevEntry = this.passiveTiles.get(dstKey) || null;
          const wasExact = prevEntry ? this._revsMatchPassive(engine, layer, prevEntry) : false;
          strokeBeforeMap.set(dstKey, prevEntry ? { entry: prevEntry, wasExact } : null);
        }

        if (srcEntries.length === 0) {
          if (this.passiveTiles.delete(dstKey)) {
            modified = true;
          }
          continue;
        }

        // Clear warp accumulators
        gl.viewport(0, 0, tr, tr);
        gl.clearColor(0, 0, 0, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._warpDryDst.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileBaseTmp.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);

        let warmth = this.lastParams?.warmth ?? 12;
        for (let s = 0; s < srcEntries.length; s++) {
          const se = srcEntries[s];
          warmth = se.warmth ?? warmth;
          const pRes = this._getPassiveEntryRes(se);
          const upDryObj = this._uploadDryByRes?.[pRes] || this._uploadDryByRes?.[256];
          const upBaseObj = this._uploadBaseByRes?.[pRes] || this._uploadBaseByRes?.[256];
          if (!upDryObj || !upBaseObj) continue;

          const sWx = se.tx * TILE_SIZE;
          const sWy = se.ty * TILE_SIZE;

          // 1. Unpack dryPig into texTileDryTmp -> warp into _warpDryDst
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, se.dryPigBytes);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileDryTmp.fbo);
          gl.useProgram(this.progUnpackDry);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
          gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this._warpDryDst.fbo);
          gl.useProgram(this.progLiquifyWarp);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, dTile.tex);
          gl.uniform1i(this.locLiquifyWarp.u_workDisp, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
          gl.uniform1i(this.locLiquifyWarp.u_srcTile, 1);
          gl.uniform2f(this.locLiquifyWarp.u_dispOrigin, dWx, dWy);
          gl.uniform1f(this.locLiquifyWarp.u_dispWorldSize, TILE_SIZE);
          gl.uniform4f(this.locLiquifyWarp.u_dispClamp, clampMin, clampMin, clampMax, clampMax);
          gl.uniform4f(this.locLiquifyWarp.u_dstWorldRect, dWx, dWy, TILE_SIZE, TILE_SIZE);
          gl.uniform4f(this.locLiquifyWarp.u_srcWorldBounds, sWx, sWy, sWx + TILE_SIZE, sWy + TILE_SIZE);
          gl.uniform1i(this.locLiquifyWarp.u_isFloatData, 1);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          // 2. Warp baseBg if source tile has baseBgBytes
          if (se.baseBgBytes) {
            gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, se.baseBgBytes);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileBaseTmp.fbo);
            gl.useProgram(this.progLiquifyWarp);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, dTile.tex);
            gl.uniform1i(this.locLiquifyWarp.u_workDisp, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
            gl.uniform1i(this.locLiquifyWarp.u_srcTile, 1);
            gl.uniform2f(this.locLiquifyWarp.u_dispOrigin, dWx, dWy);
            gl.uniform1f(this.locLiquifyWarp.u_dispWorldSize, TILE_SIZE);
            gl.uniform4f(this.locLiquifyWarp.u_dispClamp, clampMin, clampMin, clampMax, clampMax);
            gl.uniform4f(this.locLiquifyWarp.u_dstWorldRect, dWx, dWy, TILE_SIZE, TILE_SIZE);
            gl.uniform4f(this.locLiquifyWarp.u_srcWorldBounds, sWx, sWy, sWx + TILE_SIZE, sWy + TILE_SIZE);
            gl.uniform1i(this.locLiquifyWarp.u_isFloatData, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
        }

        // Pack _warpDryDst -> texTileUnpremult and read back
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
        gl.useProgram(this.progPackDry);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._warpDryDst.tex);
        gl.uniform1i(this.locPackDry.u_dryPig, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        gl.uniform1i(this.locPackDry.u_porePig, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        gl.uniform1i(this.locPackDry.u_surfPig, 2);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, drySub);

        let hasDry = false;
        for (let k = 3; k < byteLen; k += 4) {
          if (drySub[k] > 0) {
            hasDry = true;
            break;
          }
        }
        if (!hasDry) {
          if (this.passiveTiles.delete(dstKey)) modified = true;
          continue;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileBaseTmp.fbo);
        gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, baseSub);

        let hasBase = false;
        for (let k = 3; k < byteLen; k += 4) {
          if (baseSub[k] > 2) {
            hasBase = true;
            break;
          }
        }

        this.passiveTiles.set(dstKey, {
          key: dstKey,
          projId: pid,
          layer,
          tx: dtx,
          ty: dty,
          res: tr,
          dryPigBytes: new Uint8Array(drySub),
          baseBgBytes: hasBase ? new Uint8Array(baseSub) : null,
          warmth,
          chunkRevs: this._captureTileChunkRevs(engine, layer, dWx, dWy),
          lastUsed: ++this._passiveTick
        });
        modified = true;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (modified) {
      this._markPassiveChanged(pid);
      this._trimPassiveArchive();
    }
    return modified;
  }

  _resetGlStateForExternal() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  refreshPassiveChunkRevs(engine, layer, projId, touchedKeys) {
    if (!engine || !touchedKeys || touchedKeys.length === 0) return;
    for (let i = 0; i < touchedKeys.length; i++) {
      const item = touchedKeys[i];
      if (!item || !item.key) continue;
      const entry = this.passiveTiles.get(item.key);
      if (!entry) continue;
      entry.chunkRevs = this._captureTileChunkRevs(engine, layer, item.tx * TILE_SIZE, item.ty * TILE_SIZE);
    }
  }

  _uploadSelectionMaskTex(maskCanvas) {
    const gl = this.gl;
    if (!gl || !maskCanvas) return null;
    const maxDim = 2048;
    let src = maskCanvas;
    let tempCanvas = null;
    if (maskCanvas.width > maxDim || maskCanvas.height > maxDim) {
      const s = maxDim / Math.max(maskCanvas.width, maskCanvas.height);
      tempCanvas = document.createElement('canvas');
      tempCanvas.width = Math.max(1, Math.round(maskCanvas.width * s));
      tempCanvas.height = Math.max(1, Math.round(maskCanvas.height * s));
      tempCanvas.getContext('2d').drawImage(maskCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
      src = tempCanvas;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (tempCanvas) {
      tempCanvas.width = 0;
      tempCanvas.height = 0;
    }
    return tex;
  }

  _loadPassiveEntryIntoDryBase(engine, entry, layer, dstDryObj, dstBaseObj, tr = this.tileRes) {
    const gl = this.gl;
    if (!gl || !dstDryObj || !dstBaseObj) return false;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);
    gl.clearColor(0, 0, 0, 0);

    if (!entry || !entry.dryPigBytes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstDryObj.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstBaseObj.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return false;
    }

    const pRes = this._getPassiveEntryRes(entry);
    const upDryObj = this._uploadDryByRes?.[pRes] || this._uploadDryByRes?.[256];
    const upBaseObj = this._uploadBaseByRes?.[pRes] || this._uploadBaseByRes?.[256];
    if (!upDryObj || !upBaseObj) return false;

    const revsMatch = this._revsMatchPassive(engine, layer, entry);
    entry.lastUsed = ++this._passiveTick;

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, entry.dryPigBytes);

    if (revsMatch) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstDryObj.fbo);
      gl.useProgram(this.progUnpackDry);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
      gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (entry.baseBgBytes) {
        gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, entry.baseBgBytes);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstBaseObj.fbo);
        gl.useProgram(this.progRectMap);
        gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
        gl.uniform1i(this.locRectMap.u_tex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstBaseObj.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      return true;
    }

    // Reconcile against external layer edits before using stale passive entry
    const wx = entry.tx * TILE_SIZE;
    const wy = entry.ty * TILE_SIZE;
    const sCX = engine.isStatic ? 0 : Math.floor(wx / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((wx + TILE_SIZE - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(wy / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((wy + TILE_SIZE - 1) / engine.chunkSize);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileBaseTmp.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_dstRect, wx, wy, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);

    let hasAnyChunkPixels = false;
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
          chunk.gpuTextures[layer] = this.gpuRenderer._createOrUpdateTexture(chunk.gpuTextures[layer], chunk.canvases[layer], true);
          chunk.gpuDirty[layer] = false;
        }
        const cwx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
        const cwy = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
        gl.uniform4f(this.locRectMap.u_srcRect, cwx, cwy, chunk.width, chunk.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.gpuTextures[layer]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    if (!hasAnyChunkPixels) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstDryObj.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstBaseObj.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return false;
    }

    if (entry.baseBgBytes) {
      gl.bindTexture(gl.TEXTURE_2D, upBaseObj.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pRes, pRes, gl.RGBA, gl.UNSIGNED_BYTE, entry.baseBgBytes);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileDryTmp.fbo);
    gl.useProgram(this.progUnpackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, upDryObj.tex);
    gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (!this._reconcileSubTile || this._reconcileSubTile.w !== tr || this._reconcileSubTile.h !== tr) {
      this._delTexFBO(this._reconcileSubTile);
      this._reconcileSubTile = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    }
    const activeParams = this.lastParams || {};
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._reconcileSubTile.fbo);
    gl.useProgram(this.progSubBake);
    this._bindSurfaceUniforms(this.locSubBake, engine, activeParams);
    gl.uniform2f(this.locSubBake.u_workOrigin, wx, wy);
    gl.uniform1f(this.locSubBake.u_texelToWorld, TILE_SIZE / tr);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

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
    gl.bindTexture(gl.TEXTURE_2D, entry.baseBgBytes ? upBaseObj.tex : this.dummyTex);
    gl.uniform1i(this.locComp.u_baseBg, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this._reconcileSubTile.tex);
    gl.uniform1i(this.locComp.u_sub, 6);
    gl.uniform1f(this.locComp.u_inkWarmth, (entry.warmth ?? 12) / 100);
    gl.uniform1i(this.locComp.u_alphaLock, alphaLock);
    gl.uniform1i(this.locComp.u_unpremult, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstBaseObj.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, dstDryObj.tex, 0);
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
    gl.bindTexture(gl.TEXTURE_2D, entry.baseBgBytes ? upBaseObj.tex : this.dummyTex);
    gl.uniform1i(this.locReconcile.u_savedBase, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.texTileDryTmp.tex);
    gl.uniform1i(this.locReconcile.u_savedDry, 3);
    gl.uniform1i(this.locReconcile.u_hasSavedBase, entry.baseBgBytes ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  _packDryBaseFbosToEntry(engine, layer, projId, tx, ty, dryObj, baseObj, tr, warmth) {
    const gl = this.gl;
    if (!gl || !dryObj || !baseObj) return null;
    const byteLen = tr * tr * 4;
    const drySub = this._packBuf.subarray(0, byteLen);
    const baseSub = this._basePackBuf.subarray(0, byteLen);
    const key = this._getPassiveKey(projId, layer, tx, ty);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, tr, tr);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dryObj.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_porePig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_surfPig, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, drySub);

    let hasDry = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (drySub[i] > 0) {
        hasDry = true;
        break;
      }
    }
    if (!hasDry) return null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, baseObj.fbo);
    gl.readPixels(0, 0, tr, tr, gl.RGBA, gl.UNSIGNED_BYTE, baseSub);
    let hasBase = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (baseSub[i] > 2) {
        hasBase = true;
        break;
      }
    }

    return {
      key,
      projId,
      layer,
      tx,
      ty,
      res: tr,
      dryPigBytes: new Uint8Array(drySub),
      baseBgBytes: hasBase ? new Uint8Array(baseSub) : null,
      warmth: warmth ?? this.lastParams?.warmth ?? 12,
      chunkRevs: this._captureTileChunkRevs(engine, layer, tx * TILE_SIZE, ty * TILE_SIZE),
      lastUsed: ++this._passiveTick
    };
  }

  _clearSmudgeTiles() {
    this._smudgeTiles.forEach((t) => {
      if (!t) return;
      this._delTexFBO(t.dry);
      this._delTexFBO(t.base);
    });
    this._smudgeTiles.clear();
  }

  _uploadSmudgeTip(tipMaskFloat32, tipVersion) {
    const gl = this.gl;
    if (!gl || !tipMaskFloat32) return;
    if (!this._smudgeTipTex) {
      this._smudgeTipTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._smudgeTipTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._smudgeTipBytes = new Uint8Array(64 * 64 * 4);
    }
    if (tipVersion !== null && tipVersion !== undefined && this._smudgeTipVer === tipVersion) return;
    this._smudgeTipVer = tipVersion;
    const bytes = this._smudgeTipBytes;
    const len = 64 * 64;
    for (let i = 0; i < len; i++) {
      const m = tipMaskFloat32[i] <= 0 ? 0 : (tipMaskFloat32[i] >= 1 ? 255 : (tipMaskFloat32[i] * 255.0 + 0.5) | 0);
      const i4 = i * 4;
      bytes[i4] = m;
      bytes[i4 + 1] = m;
      bytes[i4 + 2] = m;
      bytes[i4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this._smudgeTipTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _ensureSmudgeTile(engine, tx, ty, allowEmptyAlloc) {
    const tKey = `${tx},${ty}`;
    let t = this._smudgeTiles.get(tKey);
    if (t) return t;

    const pid = this._smudgeProjId;
    const layer = this._smudgeLayer;
    const pKey = this._getPassiveKey(pid, layer, tx, ty);
    const passive = this.passiveTiles.get(pKey) || null;
    if (!passive && !allowEmptyAlloc) return null;

    const gl = this.gl;
    const tr = this.tileRes;
    const dry = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const base = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

    if (!this._smudgeBefore.has(pKey)) {
      const wasExact = passive ? this._revsMatchPassive(engine, layer, passive) : false;
      this._smudgeBefore.set(pKey, passive ? { entry: passive, wasExact } : null);
    }

    let hasPores = false;
    if (passive) {
      hasPores = this._loadPassiveEntryIntoDryBase(engine, passive, layer, dry, base, tr);
    } else {
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, base.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    t = {
      tx,
      ty,
      wx: tx * TILE_SIZE,
      wy: ty * TILE_SIZE,
      res: tr,
      dirty: false,
      warmth: passive?.warmth ?? this.lastParams?.warmth ?? 12,
      dry,
      base,
      hasPores
    };
    this._smudgeTiles.set(tKey, t);
    return t;
  }

  beginPassiveSmudge(engine, worldPos, tipMaskFloat32, tipVersion) {
    if (!this.ready || !this.gl || this.gl.isContextLost() || !engine) return false;
    const layer = engine.activeLayer;
    const pid = engine.currentProjectId || 'default';
    this.flushActiveForExternalEdit(engine, layer);

    let layerHasPassive = false;
    this.passiveTiles.forEach((entry) => {
      if (entry && entry.projId === pid && entry.layer === layer) {
        layerHasPassive = true;
      }
    });
    if (!layerHasPassive) {
      this._smudgeActive = false;
      this._pendingSmudgeHistory = null;
      return false;
    }

    const gl = this.gl;
    if (!this._smudgeBufPP) {
      this._smudgeBufPP = {
        idx: 0,
        a: {
          dry: this._makeTexFBO(64, 64, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST),
          base: this._makeTexFBO(64, 64, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
        },
        b: {
          dry: this._makeTexFBO(64, 64, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST),
          base: this._makeTexFBO(64, 64, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
        },
        read() { return this.idx === 0 ? this.a : this.b; },
        write() { return this.idx === 0 ? this.b : this.a; },
        swap() { this.idx = 1 - this.idx; }
      };
    }

    this._clearSmudgeTiles();
    this._smudgeBefore.clear();
    this._smudgeTouchedKeys = [];
    this._pendingSmudgeHistory = null;
    this._smudgeActive = true;
    this._smudgeCarriedHasPores = false;
    this._smudgeLayer = layer;
    this._smudgeProjId = pid;

    this._uploadSmudgeTip(tipMaskFloat32, tipVersion);

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smudgeBufPP.a.dry.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smudgeBufPP.a.base.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smudgeBufPP.b.dry.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smudgeBufPP.b.base.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._smudgeBufPP.idx = 0;

    if (worldPos) {
      const sz = worldPos.size || engine.brush?.size || 50;
      const initStamp = { x: worldPos.x, y: worldPos.y, size: sz, angle: worldPos.angle || 0 };
      this._runPassiveSmudgeBatch(engine, [initStamp], 0, 1.0, 1.0, true);
    }
    this._resetGlStateForExternal();
    return true;
  }

  _runPassiveSmudgeBatch(engine, stamps, depositBase, pickupBase, effOpacity, pickupOnly = false) {
    const gl = this.gl;
    if (!stamps || stamps.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const r = Math.max(2.0, (s.size || engine.brush?.size || 50) * 0.5) + 4;
      minX = Math.min(minX, s.x - r);
      minY = Math.min(minY, s.y - r);
      maxX = Math.max(maxX, s.x + r);
      maxY = Math.max(maxY, s.y + r);
    }
    const workX = Math.floor(minX);
    const workY = Math.floor(minY);
    const boxW = Math.min(WORK_RES, Math.max(16, Math.ceil(maxX) - workX));
    const boxH = Math.min(WORK_RES, Math.max(16, Math.ceil(maxY) - workY));

    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);

    const tiles = [];
    let batchHasAnyPassive = false;
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureSmudgeTile(engine, tx, ty, !pickupOnly && this._smudgeCarriedHasPores);
        if (t) {
          tiles.push(t);
          if (t.hasPores || t.dirty) batchHasAnyPassive = true;
        }
      }
    }
    if (tiles.length === 0 || (!batchHasAnyPassive && !this._smudgeCarriedHasPores)) return;

    const wr = this.workRes;
    const workTexW = Math.min(wr, Math.max(4, Math.round((boxW * wr) / WORK_RES)));
    const workTexH = Math.min(wr, Math.max(4, Math.round((boxH * wr) / WORK_RES)));
    const texel = 1.0 / wr;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (workTexW - 0.5) * texel);
    const maxV = Math.max(minV, (workTexH - 0.5) * texel);
    const layer = this._smudgeLayer;
    const layerSet = engine.layerSettings && engine.layerSettings[layer];
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;
    const physicalMix = (engine.physicalColorMix !== false) ? 1 : 0;
    const effDeposit = pickupOnly ? 0.0 : (depositBase * effOpacity);

    this.ppDryPig.idx = 0;
    this.ppBaseBg.idx = 0;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, workTexW, workTexH);
    gl.viewport(0, 0, wr, wr);
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppDryPig.a.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppBaseBg.a.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.locRectMap.u_dstRect, workX, workY, WORK_RES, WORK_RES);
    gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.locRectMap.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.locRectMap.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppDryPig.a.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.dry.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppBaseBg.a.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.base.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    let depositedAny = false;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const sR = Math.max(2.0, (s.size || engine.brush?.size || 50) * 0.5);
      const angle = s.angle || 0.0;
      const cosFwd = Math.cos(angle);
      const sinFwd = Math.sin(angle);
      const cosInv = cosFwd;
      const sinInv = -sinFwd;

      // 1. Pickup onto 64x64 carried buffer
      if (this._smudgeCarriedHasPores || batchHasAnyPassive) {
        const isFirst = !this._smudgeCarriedHasPores ? 1 : 0;
        const dstBuf = this._smudgeBufPP.write();
        const prevBuf = this._smudgeBufPP.read();
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, 64, 64);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstBuf.dry.tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, dstBuf.base.tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

        gl.useProgram(this.progPoreSmudgePickup);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.ppDryPig.read().tex);
        gl.uniform1i(this.locPoreSmudgePickup.u_workDry, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.ppBaseBg.read().tex);
        gl.uniform1i(this.locPoreSmudgePickup.u_workBase, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, prevBuf.dry.tex);
        gl.uniform1i(this.locPoreSmudgePickup.u_prevDry, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, prevBuf.base.tex);
        gl.uniform1i(this.locPoreSmudgePickup.u_prevBase, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this._smudgeTipTex);
        gl.uniform1i(this.locPoreSmudgePickup.u_tip, 4);
        gl.uniform2f(this.locPoreSmudgePickup.u_workOrigin, workX, workY);
        gl.uniform2f(this.locPoreSmudgePickup.u_workTexSize, wr, wr);
        gl.uniform4f(this.locPoreSmudgePickup.u_uvClamp, minU, minV, maxU, maxV);
        gl.uniform2f(this.locPoreSmudgePickup.u_stampPos, s.x, s.y);
        gl.uniform1f(this.locPoreSmudgePickup.u_radius, sR);
        gl.uniform1f(this.locPoreSmudgePickup.u_cosFwd, cosFwd);
        gl.uniform1f(this.locPoreSmudgePickup.u_sinFwd, sinFwd);
        gl.uniform1f(this.locPoreSmudgePickup.u_pickupBase, pickupBase);
        gl.uniform1i(this.locPoreSmudgePickup.u_isFirstPickup, isFirst);
        gl.uniform1i(this.locPoreSmudgePickup.u_physicalMix, physicalMix);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this._smudgeBufPP.swap();
        this._smudgeCarriedHasPores = true;
      }

      // 2. Deposit carried pores into work dry & base
      if (!pickupOnly && this._smudgeCarriedHasPores && effDeposit > 0.001) {
        const curBuf = this._smudgeBufPP.read();
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, workTexW, workTexH);
        gl.viewport(0, 0, wr, wr);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ppDryPig.write().tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.ppBaseBg.write().tex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

        gl.useProgram(this.progPoreSmudgeDeposit);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.ppDryPig.read().tex);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_workDry, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.ppBaseBg.read().tex);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_workBase, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, curBuf.dry.tex);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_bufDry, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, curBuf.base.tex);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_bufBase, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this._smudgeTipTex);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_tip, 4);
        gl.uniform2f(this.locPoreSmudgeDeposit.u_workOrigin, workX, workY);
        gl.uniform2f(this.locPoreSmudgeDeposit.u_stampPos, s.x, s.y);
        gl.uniform1f(this.locPoreSmudgeDeposit.u_radius, sR);
        gl.uniform1f(this.locPoreSmudgeDeposit.u_cosInv, cosInv);
        gl.uniform1f(this.locPoreSmudgeDeposit.u_sinInv, sinInv);
        gl.uniform1f(this.locPoreSmudgeDeposit.u_depositBase, effDeposit);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_alphaLock, alphaLock);
        gl.uniform1i(this.locPoreSmudgeDeposit.u_physicalMix, physicalMix);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this.ppDryPig.swap();
        this.ppBaseBg.swap();
        depositedAny = true;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    if (depositedAny) {
      const srcDryTex = this.ppDryPig.read().tex;
      const srcBaseTex = this.ppBaseBg.read().tex;
      gl.useProgram(this.progRectMap);
      gl.uniform4f(this.locRectMap.u_srcRect, workX, workY, WORK_RES, WORK_RES);
      gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
      gl.uniform1i(this.locRectMap.u_tex, 0);
      gl.activeTexture(gl.TEXTURE0);

      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const tr = t.res || this.tileRes;
        const ox = Math.max(workX, t.wx);
        const oy = Math.max(workY, t.wy);
        const ox2 = Math.min(workX + boxW, t.wx + TILE_SIZE);
        const oy2 = Math.min(workY + boxH, t.wy + TILE_SIZE);
        const ow = ox2 - ox;
        const oh = oy2 - oy;
        if (ow <= 0 || oh <= 0) continue;

        const lx0 = Math.max(0, Math.floor(((ox - t.wx) * tr) / TILE_SIZE + 1e-5));
        const ly0 = Math.max(0, Math.floor(((oy - t.wy) * tr) / TILE_SIZE + 1e-5));
        const lx1 = Math.min(tr, Math.max(lx0 + 1, Math.ceil(((ox2 - t.wx) * tr) / TILE_SIZE - 1e-5)));
        const ly1 = Math.min(tr, Math.max(ly0 + 1, Math.ceil(((oy2 - t.wy) * tr) / TILE_SIZE - 1e-5)));
        const texOw = Math.max(1, lx1 - lx0);
        const texOh = Math.max(1, ly1 - ly0);

        gl.viewport(0, 0, tr, tr);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(lx0, ly0, texOw, texOh);
        gl.uniform4f(this.locRectMap.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, t.dry.fbo);
        gl.bindTexture(gl.TEXTURE_2D, srcDryTex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindFramebuffer(gl.FRAMEBUFFER, t.base.fbo);
        gl.bindTexture(gl.TEXTURE_2D, srcBaseTex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        t.dirty = true;
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  stepPassiveSmudge(engine, stamps, depositBase, pickupBase, effOpacity) {
    if (!this._smudgeActive || !this.ready || !this.gl || this.gl.isContextLost() || !engine || !stamps || stamps.length === 0) {
      return;
    }
    const maxSpan = WORK_RES - 16;
    let batch = [];
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;

    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const r = Math.max(2.0, (s.size || engine.brush?.size || 50) * 0.5) + 4;
      const nMinX = Math.min(bMinX, s.x - r);
      const nMinY = Math.min(bMinY, s.y - r);
      const nMaxX = Math.max(bMaxX, s.x + r);
      const nMaxY = Math.max(bMaxY, s.y + r);
      if (batch.length > 0 && ((nMaxX - nMinX) > maxSpan || (nMaxY - nMinY) > maxSpan)) {
        this._runPassiveSmudgeBatch(engine, batch, depositBase, pickupBase, effOpacity, false);
        batch = [s];
        bMinX = s.x - r;
        bMinY = s.y - r;
        bMaxX = s.x + r;
        bMaxY = s.y + r;
      } else {
        batch.push(s);
        bMinX = nMinX;
        bMinY = nMinY;
        bMaxX = nMaxX;
        bMaxY = nMaxY;
      }
    }
    if (batch.length > 0) {
      this._runPassiveSmudgeBatch(engine, batch, depositBase, pickupBase, effOpacity, false);
    }
    this._resetGlStateForExternal();
  }

  endPassiveSmudge(engine) {
    if (!this._smudgeActive) return;
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !engine) {
      this._clearSmudgeTiles();
      this._smudgeBefore.clear();
      this._pendingSmudgeHistory = null;
      this._smudgeActive = false;
      return;
    }

    const layer = this._smudgeLayer;
    const pid = this._smudgeProjId;
    const tr = this.tileRes;
    const hasSel = !!(engine.activeSelectionPath && engine.drawSelectionMask);
    let selCanvas = null;
    let selCtx = null;
    let selTex = null;
    let curDryCopy = null;

    if (hasSel) {
      selCanvas = document.createElement('canvas');
      selCanvas.width = TILE_SIZE;
      selCanvas.height = TILE_SIZE;
      selCtx = selCanvas.getContext('2d');
      selTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, selTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TILE_SIZE, TILE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      curDryCopy = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    }

    const touchedKeys = [];
    this._smudgeTiles.forEach((t) => {
      if (!t || !t.dirty) return;
      const pKey = this._getPassiveKey(pid, layer, t.tx, t.ty);

      if (hasSel && selCtx && selTex) {
        selCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        engine.drawSelectionMask(selCtx, engine.activeSelectionPath, t.wx, t.wy);
        gl.bindTexture(gl.TEXTURE_2D, selTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, selCanvas);

        const bef = this._smudgeBefore.get(pKey);
        const hasBef = !!(bef && bef.entry && bef.entry.dryPigBytes);
        if (hasBef) {
          this._loadPassiveEntryIntoDryBase(engine, bef.entry, layer, this.texTileDryTmp, this.texTileBaseTmp, tr);
        }

        gl.disable(gl.BLEND);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindVertexArray(this.gpuRenderer.vao);
        gl.viewport(0, 0, tr, tr);

        gl.useProgram(this.progRectMap);
        gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
        gl.uniform1i(this.locRectMap.u_tex, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, curDryCopy.fbo);
        gl.bindTexture(gl.TEXTURE_2D, t.dry.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
        gl.bindTexture(gl.TEXTURE_2D, t.base.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.useProgram(this.progSelTileMask);
        gl.uniform4f(this.locSelTileMask.u_tileRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locSelTileMask.u_maskRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
        gl.uniform1i(this.locSelTileMask.u_hasBefore, hasBef ? 1 : 0);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, selTex);
        gl.uniform1i(this.locSelTileMask.u_mask, 2);

        gl.bindFramebuffer(gl.FRAMEBUFFER, t.dry.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, curDryCopy.tex);
        gl.uniform1i(this.locSelTileMask.u_cur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, hasBef ? this.texTileDryTmp.tex : this.dummyTex);
        gl.uniform1i(this.locSelTileMask.u_before, 1);
        gl.uniform1i(this.locSelTileMask.u_isFloatDry, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindFramebuffer(gl.FRAMEBUFFER, t.base.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texTileUnpremult.tex);
        gl.uniform1i(this.locSelTileMask.u_cur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, hasBef ? this.texTileBaseTmp.tex : this.dummyTex);
        gl.uniform1i(this.locSelTileMask.u_before, 1);
        gl.uniform1i(this.locSelTileMask.u_isFloatDry, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      const nextEntry = this._packDryBaseFbosToEntry(engine, layer, pid, t.tx, t.ty, t.dry, t.base, tr, t.warmth);
      if (nextEntry) {
        this.passiveTiles.set(pKey, nextEntry);
      } else {
        this.passiveTiles.delete(pKey);
      }
      touchedKeys.push({ key: pKey, tx: t.tx, ty: t.ty });
    });

    if (selCanvas) { selCanvas.width = 0; selCanvas.height = 0; }
    if (selTex) gl.deleteTexture(selTex);
    this._delTexFBO(curDryCopy);
    this._clearSmudgeTiles();
    this._smudgeActive = false;
    this._smudgeCarriedHasPores = false;

    if (touchedKeys.length > 0) {
      const beforeFiltered = new Map();
      for (let i = 0; i < touchedKeys.length; i++) {
        const pKey = touchedKeys[i].key;
        beforeFiltered.set(pKey, this._smudgeBefore.get(pKey) || null);
      }
      this._pendingSmudgeHistory = { projId: pid, layer, before: beforeFiltered, touchedKeys };
      this._markPassiveChanged(pid);
      this._trimPassiveArchive();
    } else {
      this._pendingSmudgeHistory = null;
    }
    this._smudgeBefore.clear();
    this._resetGlStateForExternal();
  }

  cancelPassiveSmudge() {
    this._clearSmudgeTiles();
    this._smudgeBefore.clear();
    this._pendingSmudgeHistory = null;
    this._smudgeActive = false;
    this._smudgeCarriedHasPores = false;
  }

  hasPendingSmudgeHistory() {
    return !!(this._pendingSmudgeHistory && this._pendingSmudgeHistory.before && this._pendingSmudgeHistory.before.size > 0);
  }

  attachSmudgeHistoryAction(engine, action) {
    if (!action || !engine || !this._pendingSmudgeHistory) return false;
    const pend = this._pendingSmudgeHistory;
    this.refreshPassiveChunkRevs(engine, pend.layer, pend.projId, pend.touchedKeys);
    action.sumiPassive = pend.before;
    action.sumiLayer = pend.layer;
    action.sumiProjId = pend.projId;
    this._pendingSmudgeHistory = null;
    return true;
  }

  extractSelectionPores(engine, layer, fMinX, fMinY, width, height, maskCanvas, clearSource) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !engine || !maskCanvas || width <= 0 || height <= 0) {
      return null;
    }
    this.flushActiveForExternalEdit(engine, layer);

    const pid = engine.currentProjectId || 'default';
    const tx0 = Math.floor(fMinX / TILE_SIZE);
    const tx1 = Math.floor((fMinX + width - 1) / TILE_SIZE);
    const ty0 = Math.floor(fMinY / TILE_SIZE);
    const ty1 = Math.floor((fMinY + height - 1) / TILE_SIZE);

    const srcEntries = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const pKey = this._getPassiveKey(pid, layer, tx, ty);
        const entry = this.passiveTiles.get(pKey);
        if (entry && entry.dryPigBytes) {
          srcEntries.push({ pKey, entry });
        }
      }
    }
    if (srcEntries.length === 0) return null;

    const maskTex = this._uploadSelectionMaskTex(maskCanvas);
    if (!maskTex) return null;

    const tr = this.tileRes;
    const bakeScale = Math.min(1.0, 2048.0 / Math.max(width, height));
    const dstW = Math.max(1, Math.round(width * bakeScale));
    const dstH = Math.max(1, Math.round(height * bakeScale));

    const selDry = this._makeTexFBO(dstW, dstH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const selBase = this._makeTexFBO(dstW, dstH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const selPacked = this._makeTexFBO(dstW, dstH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const tDry = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const tBase = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const tDryCopy = clearSource ? this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST) : null;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, selDry.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, selBase.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const affectedPassive = new Map();
    const touchedKeys = [];
    let warmth = this.lastParams?.warmth ?? 12;

    for (let i = 0; i < srcEntries.length; i++) {
      const { pKey, entry } = srcEntries[i];
      warmth = entry.warmth ?? warmth;
      const wasExact = this._revsMatchPassive(engine, layer, entry);
      const ok = this._loadPassiveEntryIntoDryBase(engine, entry, layer, tDry, tBase, tr);
      if (!ok) continue;

      const wx = entry.tx * TILE_SIZE;
      const wy = entry.ty * TILE_SIZE;
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindVertexArray(this.gpuRenderer.vao);
      gl.viewport(0, 0, dstW, dstH);

      gl.useProgram(this.progSelMaskExtract);
      gl.uniform4f(this.locSelMaskExtract.u_srcRect, wx, wy, TILE_SIZE, TILE_SIZE);
      gl.uniform4f(this.locSelMaskExtract.u_dstRect, fMinX, fMinY, width, height);
      gl.uniform4f(this.locSelMaskExtract.u_uvSubRect, 0, 0, 1, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.uniform1i(this.locSelMaskExtract.u_mask, 1);

      gl.bindFramebuffer(gl.FRAMEBUFFER, selDry.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tDry.tex);
      gl.uniform1i(this.locSelMaskExtract.u_srcTex, 0);
      gl.uniform1i(this.locSelMaskExtract.u_isFloatDry, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, selBase.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tBase.tex);
      gl.uniform1i(this.locSelMaskExtract.u_srcTex, 0);
      gl.uniform1i(this.locSelMaskExtract.u_isFloatDry, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (clearSource && tDryCopy) {
        affectedPassive.set(pKey, { entry, wasExact });
        gl.viewport(0, 0, tr, tr);
        gl.useProgram(this.progRectMap);
        gl.uniform4f(this.locRectMap.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_dstRect, 0, 0, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locRectMap.u_uvSubRect, 0, 0, 1, 1);
        gl.uniform1i(this.locRectMap.u_tex, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, tDryCopy.fbo);
        gl.bindTexture(gl.TEXTURE_2D, tDry.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.texTileUnpremult.fbo);
        gl.bindTexture(gl.TEXTURE_2D, tBase.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.useProgram(this.progSelTileMask);
        gl.uniform4f(this.locSelTileMask.u_tileRect, wx, wy, TILE_SIZE, TILE_SIZE);
        gl.uniform4f(this.locSelTileMask.u_maskRect, fMinX, fMinY, width, height);
        gl.uniform1i(this.locSelTileMask.u_hasBefore, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(this.locSelTileMask.u_mask, 2);

        gl.bindFramebuffer(gl.FRAMEBUFFER, tDry.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        gl.uniform1i(this.locSelTileMask.u_cur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tDryCopy.tex);
        gl.uniform1i(this.locSelTileMask.u_before, 1);
        gl.uniform1i(this.locSelTileMask.u_isFloatDry, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.bindFramebuffer(gl.FRAMEBUFFER, tBase.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        gl.uniform1i(this.locSelTileMask.u_cur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texTileUnpremult.tex);
        gl.uniform1i(this.locSelTileMask.u_before, 1);
        gl.uniform1i(this.locSelTileMask.u_isFloatDry, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        const nextEntry = this._packDryBaseFbosToEntry(engine, layer, pid, entry.tx, entry.ty, tDry, tBase, tr, warmth);
        if (nextEntry) {
          this.passiveTiles.set(pKey, nextEntry);
        } else {
          this.passiveTiles.delete(pKey);
        }
        touchedKeys.push({ key: pKey, tx: entry.tx, ty: entry.ty });
      }
    }

    const byteLen = dstW * dstH * 4;
    const dryBytes = new Uint8Array(byteLen);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.viewport(0, 0, dstW, dstH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, selPacked.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, selDry.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_porePig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_surfPig, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, dstW, dstH, gl.RGBA, gl.UNSIGNED_BYTE, dryBytes);

    let hasDry = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (dryBytes[i] > 0) {
        hasDry = true;
        break;
      }
    }

    let baseBytes = null;
    if (hasDry) {
      const tmpBase = new Uint8Array(byteLen);
      gl.bindFramebuffer(gl.FRAMEBUFFER, selBase.fbo);
      gl.readPixels(0, 0, dstW, dstH, gl.RGBA, gl.UNSIGNED_BYTE, tmpBase);
      for (let i = 3; i < byteLen; i += 4) {
        if (tmpBase[i] > 2) {
          baseBytes = tmpBase;
          break;
        }
      }
    }

    gl.deleteTexture(maskTex);
    this._delTexFBO(selDry);
    this._delTexFBO(selBase);
    this._delTexFBO(selPacked);
    this._delTexFBO(tDry);
    this._delTexFBO(tBase);
    this._delTexFBO(tDryCopy);
    this._resetGlStateForExternal();

    if (clearSource && touchedKeys.length > 0) {
      this._markPassiveChanged(pid);
      this._trimPassiveArchive();
    }

    if (!hasDry && touchedKeys.length === 0) return null;
    return {
      sumiPoreData: hasDry ? {
        width,
        height,
        dataW: dstW,
        dataH: dstH,
        dryBytes,
        baseBytes,
        warmth
      } : null,
      affectedPassive,
      touchedKeys,
      projId: pid,
      layer
    };
  }

  _warpSelectionPoresGpu(poreData, sel) {
    const gl = this.gl;
    if (!gl || !poreData || !poreData.dryBytes) return null;
    const sw = poreData.dataW || poreData.width;
    const sh = poreData.dataH || poreData.height;

    const upDry = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, upDry);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, poreData.dryBytes);

    const srcDryFbo = this._makeTexFBO(sw, sh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, sw, sh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcDryFbo.fbo);
    gl.useProgram(this.progUnpackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, upDry);
    gl.uniform1i(this.locUnpackDry.u_packedDry, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.deleteTexture(upDry);

    let srcBaseFbo = null;
    if (poreData.baseBytes) {
      srcBaseFbo = this._makeTexFBO(sw, sh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, srcBaseFbo.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, poreData.baseBytes);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    const pins = sel && Array.isArray(sel.pins) && sel.pins.length > 0 ? sel.pins : null;
    if (!pins) {
      return {
        dstW: sw,
        dstH: sh,
        worldW: poreData.width,
        worldH: poreData.height,
        dryFbo: srcDryFbo,
        baseFbo: srcBaseFbo
      };
    }

    const origW = poreData.width;
    const origH = poreData.height;
    const margin = sel.deformMargin || 0;
    const w = sel.canvas ? sel.canvas.width : (origW + 2 * margin);
    const h = sel.canvas ? sel.canvas.height : (origH + 2 * margin);
    const bakeScale = Math.min(1.0, 2048.0 / Math.max(w, h));
    const dstW = Math.max(1, Math.round(w * bakeScale));
    const dstH = Math.max(1, Math.round(h * bakeScale));

    const GRID_SIZE = 10;
    const verts = computePinWarpVertices(w, h, pins, GRID_SIZE);
    const neededFloats = GRID_SIZE * GRID_SIZE * 6 * 4;
    if (!this._selWarpVerts || this._selWarpVerts.length !== neededFloats) {
      this._selWarpVerts = new Float32Array(neededFloats);
    }
    const arr = this._selWarpVerts;
    let ptr = 0;
    const pushV = (vx, vy, ox, oy) => {
      arr[ptr++] = vx / Math.max(1, w);
      arr[ptr++] = vy / Math.max(1, h);
      arr[ptr++] = (ox - margin) / Math.max(1, origW);
      arr[ptr++] = (oy - margin) / Math.max(1, origH);
    };
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let j = 0; j < GRID_SIZE; j++) {
        const v00 = verts[i][j];
        const v10 = verts[i + 1][j];
        const v01 = verts[i][j + 1];
        const v11 = verts[i + 1][j + 1];
        pushV(v00.x, v00.y, v00.ox, v00.oy);
        pushV(v10.x, v10.y, v10.ox, v10.oy);
        pushV(v01.x, v01.y, v01.ox, v01.oy);
        pushV(v10.x, v10.y, v10.ox, v10.oy);
        pushV(v11.x, v11.y, v11.ox, v11.oy);
        pushV(v01.x, v01.y, v01.ox, v01.oy);
      }
    }

    if (!this._selWarpVao) {
      this._selWarpVao = gl.createVertexArray();
      this._selWarpVbo = gl.createBuffer();
      gl.bindVertexArray(this._selWarpVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._selWarpVbo);
      gl.bufferData(gl.ARRAY_BUFFER, arr.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    } else {
      gl.bindVertexArray(this._selWarpVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._selWarpVbo);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr);

    const warpDry = this._makeTexFBO(dstW, dstH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, dstW, dstH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, warpDry.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progSelPinWarp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcDryFbo.tex);
    gl.uniform1i(this.locSelPinWarp.u_srcTex, 0);
    gl.uniform2f(this.locSelPinWarp.u_srcTexSize, sw, sh);
    gl.uniform1i(this.locSelPinWarp.u_isFloatDry, 1);
    gl.drawArrays(gl.TRIANGLES, 0, GRID_SIZE * GRID_SIZE * 6);

    let warpBase = null;
    if (srcBaseFbo) {
      warpBase = this._makeTexFBO(dstW, dstH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, warpBase.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcBaseFbo.tex);
      gl.uniform1i(this.locSelPinWarp.u_srcTex, 0);
      gl.uniform2f(this.locSelPinWarp.u_srcTexSize, sw, sh);
      gl.uniform1i(this.locSelPinWarp.u_isFloatDry, 0);
      gl.drawArrays(gl.TRIANGLES, 0, GRID_SIZE * GRID_SIZE * 6);
    }

    gl.bindVertexArray(null);
    this._delTexFBO(srcDryFbo);
    this._delTexFBO(srcBaseFbo);
    return {
      dstW,
      dstH,
      worldW: w,
      worldH: h,
      dryFbo: warpDry,
      baseFbo: warpBase
    };
  }

  bakeSelectionPores(engine, sel) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !sel || !sel.sumiPoreData) return null;
    const warped = this._warpSelectionPoresGpu(sel.sumiPoreData, sel);
    if (!warped) return null;

    const { dstW, dstH, worldW, worldH, dryFbo, baseFbo } = warped;
    const packed = this._makeTexFBO(dstW, dstH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const byteLen = dstW * dstH * 4;
    const dryBytes = new Uint8Array(byteLen);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, dstW, dstH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, packed.fbo);
    gl.useProgram(this.progPackDry);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dryFbo.tex);
    gl.uniform1i(this.locPackDry.u_dryPig, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_porePig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.uniform1i(this.locPackDry.u_surfPig, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, dstW, dstH, gl.RGBA, gl.UNSIGNED_BYTE, dryBytes);

    let hasDry = false;
    for (let i = 3; i < byteLen; i += 4) {
      if (dryBytes[i] > 0) {
        hasDry = true;
        break;
      }
    }

    let baseBytes = null;
    if (hasDry && baseFbo) {
      const tmpBase = new Uint8Array(byteLen);
      gl.bindFramebuffer(gl.FRAMEBUFFER, baseFbo.fbo);
      gl.readPixels(0, 0, dstW, dstH, gl.RGBA, gl.UNSIGNED_BYTE, tmpBase);
      for (let i = 3; i < byteLen; i += 4) {
        if (tmpBase[i] > 2) {
          baseBytes = tmpBase;
          break;
        }
      }
    }

    this._delTexFBO(packed);
    this._delTexFBO(dryFbo);
    this._delTexFBO(baseFbo);
    this._resetGlStateForExternal();

    if (!hasDry) return null;
    return {
      width: worldW,
      height: worldH,
      dataW: dstW,
      dataH: dstH,
      dryBytes,
      baseBytes,
      warmth: sel.sumiPoreData.warmth ?? 12
    };
  }

  applySelectionPores(engine, layer, sel, historyAction = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !engine || !sel || !sel.sumiPoreData) return false;
    this.flushActiveForExternalEdit(engine, layer);

    const warped = this._warpSelectionPoresGpu(sel.sumiPoreData, sel);
    if (!warped) return false;

    const pid = engine.currentProjectId || 'default';
    const { dstW, dstH, worldW, worldH, dryFbo, baseFbo } = warped;
    const origW = sel.width || worldW;
    const origH = sel.height || worldH;
    const scX = sel.scaleX !== undefined ? sel.scaleX : (sel.scale || 1);
    const scY = sel.scaleY !== undefined ? sel.scaleY : (sel.scale || 1);
    const mScX = scX * (sel.mirrorX ? -1 : 1);
    const mScY = scY * (sel.mirrorY ? -1 : 1);
    const invScX = 1.0 / (Math.abs(mScX) < 1e-4 ? (mScX < 0 ? -1e-4 : 1e-4) : mScX);
    const invScY = 1.0 / (Math.abs(mScY) < 1e-4 ? (mScY < 0 ? -1e-4 : 1e-4) : mScY);
    const rot = sel.rotation || 0;
    const cosRot = Math.cos(rot);
    const sinRot = Math.sin(rot);
    const op = sel.opacity !== undefined ? sel.opacity : 1.0;

    const bbW = worldW * Math.abs(scX) * Math.abs(cosRot) + worldH * Math.abs(scY) * Math.abs(sinRot);
    const bbH = worldW * Math.abs(scX) * Math.abs(sinRot) + worldH * Math.abs(scY) * Math.abs(cosRot);
    const pivotX = sel.x + origW * 0.5;
    const pivotY = sel.y + origH * 0.5;

    const tx0 = Math.floor((pivotX - bbW * 0.5) / TILE_SIZE);
    const tx1 = Math.floor((pivotX + bbW * 0.5) / TILE_SIZE);
    const ty0 = Math.floor((pivotY - bbH * 0.5) / TILE_SIZE);
    const ty1 = Math.floor((pivotY + bbH * 0.5) / TILE_SIZE);

    const tr = this.tileRes;
    const srcDryTile = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const srcBaseTile = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const dstDryTile = this._makeTexFBO(tr, tr, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const dstBaseTile = this._makeTexFBO(tr, tr, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

    const beforeMap = (historyAction && historyAction.sumiPassive) ? historyAction.sumiPassive : new Map();
    const warmth = sel.sumiPoreData.warmth ?? this.lastParams?.warmth ?? 12;
    let modified = false;

    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const pKey = this._getPassiveKey(pid, layer, tx, ty);
        const existing = this.passiveTiles.get(pKey) || null;
        if (!beforeMap.has(pKey)) {
          const wasExact = existing ? this._revsMatchPassive(engine, layer, existing) : false;
          beforeMap.set(pKey, existing ? { entry: existing, wasExact } : null);
        }

        if (existing) {
          this._loadPassiveEntryIntoDryBase(engine, existing, layer, srcDryTile, srcBaseTile, tr);
        } else {
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, srcDryTile.fbo);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindFramebuffer(gl.FRAMEBUFFER, srcBaseTile.fbo);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }

        const wx = tx * TILE_SIZE;
        const wy = ty * TILE_SIZE;
        gl.disable(gl.BLEND);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindVertexArray(this.gpuRenderer.vao);
        gl.viewport(0, 0, tr, tr);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstDryTile.tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, dstBaseTile.tex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, null, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

        gl.useProgram(this.progSelStampComp);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcDryTile.tex);
        gl.uniform1i(this.locSelStampComp.u_dstDry, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, srcBaseTile.tex);
        gl.uniform1i(this.locSelStampComp.u_dstBase, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, dryFbo.tex);
        gl.uniform1i(this.locSelStampComp.u_srcDry, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, baseFbo ? baseFbo.tex : this.dummyTex);
        gl.uniform1i(this.locSelStampComp.u_srcBase, 3);
        gl.uniform4f(this.locSelStampComp.u_dstTileRect, wx, wy, TILE_SIZE, TILE_SIZE);
        gl.uniform2f(this.locSelStampComp.u_pivot, pivotX, pivotY);
        gl.uniform1f(this.locSelStampComp.u_cosRot, cosRot);
        gl.uniform1f(this.locSelStampComp.u_sinRot, sinRot);
        gl.uniform1f(this.locSelStampComp.u_invScaleX, invScX);
        gl.uniform1f(this.locSelStampComp.u_invScaleY, invScY);
        gl.uniform2f(this.locSelStampComp.u_drawSize, worldW, worldH);
        gl.uniform2f(this.locSelStampComp.u_srcDryTexSize, dstW, dstH);
        gl.uniform1f(this.locSelStampComp.u_opacity, op);
        gl.uniform1i(this.locSelStampComp.u_hasSrcBase, baseFbo ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

        const nextEntry = this._packDryBaseFbosToEntry(engine, layer, pid, tx, ty, dstDryTile, dstBaseTile, tr, warmth);
        if (nextEntry) {
          this.passiveTiles.set(pKey, nextEntry);
          modified = true;
        } else if (this.passiveTiles.delete(pKey)) {
          modified = true;
        }
      }
    }

    this._delTexFBO(srcDryTile);
    this._delTexFBO(srcBaseTile);
    this._delTexFBO(dstDryTile);
    this._delTexFBO(dstBaseTile);
    this._delTexFBO(dryFbo);
    this._delTexFBO(baseFbo);
    this._resetGlStateForExternal();

    if (historyAction && beforeMap.size > 0) {
      historyAction.sumiPassive = beforeMap;
      historyAction.sumiLayer = layer;
      historyAction.sumiProjId = pid;
    }
    if (modified) {
      this._markPassiveChanged(pid);
      this._trimPassiveArchive();
    }
    return modified;
  }

  forceDry(engine, params = {}) {
    if (!this.ready || !this.active || this.activeTiles.size === 0) return false;
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (params && Object.keys(params).length > 0) this.lastParams = { ...params };

    this._dryAllActiveTilesForArchive(engine, activeParams);
    this.commitToChunks(engine, activeParams, true, true);
    return true;
  }

  stopAndFullDry(engine, params = {}) {
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (this.ready && this.active) {
      if (this.activeTiles.size > 0) {
        this.forceDry(engine, activeParams);
      } else {
        this.commitToChunks(engine, activeParams, true, true);
      }
    } else if (engine) {
      this.flushPendingChunkBackups();
      this.flushPendingSyncs(engine);
      this.flushPendingPacks();
    }
    this.active = false;
    this.simActiveFrames = 0;
    this._activeSolverCount = 0;
    this._needsDryOnClose = false;
    while (this.tilePool.length > 12) {
      this._destroyTileGpu(this.tilePool.pop());
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.sumiOverlay = null;
      this.gpuRenderer.requestRender();
    }
    return true;
  }

  clearPoreAndFiberLayers(engine, params = {}) {
    const activeParams = (params && Object.keys(params).length > 0) ? params : (this.lastParams || {});
    if (this.ready && this.active) {
      if (this.activeTiles.size > 0) {
        this.forceDry(engine, activeParams);
      } else {
        this.commitToChunks(engine, activeParams, true, true);
      }
    }

    const targetPid = engine?.currentProjectId || this.projectId || 'default';
    this._discardPendingAsync();
    this.cancel(engine, false);
    this.clearPassiveArchive(null, null, false);
    this._markPassiveChanged(targetPid);
    if (this.gpuRenderer) {
      this.gpuRenderer._pendingSumiPores = null;
    }

    if (engine) {
      for (const stack of [engine.history, engine.redoStack]) {
        if (!Array.isArray(stack)) continue;
        for (let i = 0; i < stack.length; i++) {
          const act = stack[i];
          if (!act) continue;
          if (act.sumiPassive) {
            act.sumiPassive.clear();
            act.sumiPassive = null;
          }
          if (act.isSumiStroke) {
            act.isSumiStroke = false;
          }
        }
      }
    }

    while (this.tilePool.length > 0) {
      this._destroyTileGpu(this.tilePool.pop());
    }

    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      const clearTarget = (t) => {
        if (!t || !t.fbo) return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      };
      const clearPP = (pp) => {
        if (!pp) return;
        clearTarget(pp.a);
        clearTarget(pp.b);
      };
      clearPP(this.ppSurf);
      clearPP(this.ppSurfPig);
      clearPP(this.ppPore);
      clearPP(this.ppPorePig);
      clearPP(this.ppDryPig);
      clearPP(this.ppVel);
      clearPP(this.ppPress);
      clearPP(this.ppStrokeCov);
      clearPP(this.ppBaseBg);
      clearTarget(this.texSub);
      clearTarget(this.texDiv);
      clearTarget(this.texStamp);
      clearTarget(this.texOutput);
      clearTarget(this.texTileUnpremult);
      clearTarget(this.texTileBaseTmp);
      clearTarget(this.texTileDryTmp);
      clearTarget(this._warpDryDst);
      clearTarget(this.texProbe);
      clearTarget(this.texCenterProbe);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    if (this.gpuRenderer) {
      this.gpuRenderer.sumiOverlay = null;
      this.gpuRenderer.requestRender();
    }
    return true;
  }

  cancel(engine = null, restoreDirty = false) {
    this._discardPendingAsync();
    this.cancelPassiveSmudge();
    this.active = false;
    this.simActiveFrames = 0;
    this._activeSolverCount = 0;
    this._needsDryOnClose = false;
    if (restoreDirty && this._currentSumiBefore) {
      this.restorePassiveSnapshot(engine, this._currentSumiBefore, this.layer);
    }
    this._currentSumiBefore = null;
    this._recordedBeforeKeys = null;
    this._activeHistoryAction = null;
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
    this._discardPendingAsync();
    this.cancel(null, false);
    this.clearPassiveArchive(prevProjId, null, false);
    if (prevProjId) {
      this._passiveDirtyProjs.delete(prevProjId);
      this._passiveSavedStateByProj.delete(prevProjId);
      this._passiveWriteGenByProj.delete(prevProjId);
    } else {
      this._passiveDirtyProjs.clear();
      this._passiveSavedStateByProj.clear();
      this._passiveWriteGenByProj.clear();
    }
    if (this.gpuRenderer) {
      this.gpuRenderer._pendingSumiPores = null;
    }
    while (this.tilePool.length > 4) {
      this._destroyTileGpu(this.tilePool.pop());
    }
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (let i = 0; i < this._largeBackupPboRing.length; i++) {
        if (this._largeBackupPboRing[i]?.pbo) gl.deleteBuffer(this._largeBackupPboRing[i].pbo);
      }
      this._delTexFBO(this._largeBackupUnpremultFbo);
    }
    this._largeBackupPboRing = [];
    this._largeBackupPboBytes = 0;
    this._largeBackupUnpremultFbo = null;
    this._largeBackupReadBuf = null;
  }

  onContextLost() {
    this._discardPendingAsync();
    this.activeTiles.clear();
    this.tilePool = [];
    this.touchedChunks.clear();
    this._retireDryQueue.clear();
    this._syncPboRing = [];
    this._probePboRing = [];
    this._packPboRing = [];
    this._packTexPool = [];
    this._chunkBackupPboRing = [];
    this._chunkBackupPboBytes = 0;
    this._largeBackupPboRing = [];
    this._largeBackupPboBytes = 0;
    this._inFlightChunkBackups = [];
    this._backupUnpremultFbo = null;
    this._backupReadBuf = null;
    this._largeBackupUnpremultFbo = null;
    this._largeBackupReadBuf = null;
    this.ppSurf = null;
    this.ppSurfPig = null;
    this.ppPore = null;
    this.ppPorePig = null;
    this.ppDryPig = null;
    this.ppVel = null;
    this.ppPress = null;
    this.ppStrokeCov = null;
    this.ppBaseBg = null;
    this.texSub = null;
    this.texDiv = null;
    this.texStamp = null;
    this.texOutput = null;
    this.texTileUnpremult = null;
    this.texTileBaseTmp = null;
    this.texTileDryTmp = null;
    this._warpDryDst = null;
    this._reconcileSubTile = null;
    if (this._smudgeBufPP) {
      this._delTexFBO(this._smudgeBufPP.a?.dry);
      this._delTexFBO(this._smudgeBufPP.a?.base);
      this._delTexFBO(this._smudgeBufPP.b?.dry);
      this._delTexFBO(this._smudgeBufPP.b?.base);
      this._smudgeBufPP = null;
    }
    this._smudgeTipTex = null;
    this._smudgeTipVer = -1;
    this._selWarpVao = null;
    this._selWarpVbo = null;
    this._smudgeTiles.clear();
    this._smudgeBefore.clear();
    this._pendingSmudgeHistory = null;
    this._smudgeActive = false;
    this._smudgeCarriedHasPores = false;
    this.texProbe = null;
    this.texCenterProbe = null;
    this._uploadDryByRes = null;
    this._uploadBaseByRes = null;
    this.ready = false;
    this.active = false;
    this._activeSolverCount = 0;
    this._pipelinesWarmed = false;
  }

  dispose() {
    this._discardPendingAsync();
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      this._releaseAllTiles();
      this.passiveTiles.clear();
      for (let i = 0; i < this.tilePool.length; i++) {
        this._destroyTileGpu(this.tilePool[i]);
      }
      this.tilePool = [];
      this.touchedChunks.clear();

      this._destroyResBuffers();
      this._delTexFBO(this._backupUnpremultFbo);
      this._backupUnpremultFbo = null;
      this._backupReadBuf = null;
      this._delTexFBO(this._largeBackupUnpremultFbo);
      this._largeBackupUnpremultFbo = null;
      this._largeBackupReadBuf = null;
      if (this._uploadDryByRes) {
        for (const k of Object.keys(this._uploadDryByRes)) {
          this._delTexFBO(this._uploadDryByRes[k]);
        }
        this._uploadDryByRes = null;
      }
      if (this._uploadBaseByRes) {
        for (const k of Object.keys(this._uploadBaseByRes)) {
          this._delTexFBO(this._uploadBaseByRes[k]);
        }
        this._uploadBaseByRes = null;
      }
      this._delTexFBO(this.texProbe);
      this._delTexFBO(this.texCenterProbe);
      if (this.dummyTex) gl.deleteTexture(this.dummyTex);
      if (this._smudgeBufPP) {
        this._delTexFBO(this._smudgeBufPP.a?.dry);
        this._delTexFBO(this._smudgeBufPP.a?.base);
        this._delTexFBO(this._smudgeBufPP.b?.dry);
        this._delTexFBO(this._smudgeBufPP.b?.base);
        this._smudgeBufPP = null;
      }
      if (this._smudgeTipTex) {
        gl.deleteTexture(this._smudgeTipTex);
        this._smudgeTipTex = null;
      }
      this._smudgeTipVer = -1;
      if (this._selWarpVao) gl.deleteVertexArray(this._selWarpVao);
      if (this._selWarpVbo) gl.deleteBuffer(this._selWarpVbo);
      this._selWarpVao = null;
      this._selWarpVbo = null;
      this._clearSmudgeTiles();

      for (let i = 0; i < this._syncPboRing.length; i++) {
        if (this._syncPboRing[i]?.pbo) gl.deleteBuffer(this._syncPboRing[i].pbo);
      }
      this._syncPboRing = [];
      for (let i = 0; i < this._probePboRing.length; i++) {
        if (this._probePboRing[i]?.pbo) gl.deleteBuffer(this._probePboRing[i].pbo);
      }
      this._probePboRing = [];
      for (let i = 0; i < this._packPboRing.length; i++) {
        if (this._packPboRing[i]?.pboDry) gl.deleteBuffer(this._packPboRing[i].pboDry);
        if (this._packPboRing[i]?.pboBase) gl.deleteBuffer(this._packPboRing[i].pboBase);
      }
      this._packPboRing = [];
      for (let i = 0; i < this._chunkBackupPboRing.length; i++) {
        if (this._chunkBackupPboRing[i]?.pbo) gl.deleteBuffer(this._chunkBackupPboRing[i].pbo);
      }
      this._chunkBackupPboRing = [];
      this._chunkBackupPboBytes = 0;
      for (let i = 0; i < this._largeBackupPboRing.length; i++) {
        if (this._largeBackupPboRing[i]?.pbo) gl.deleteBuffer(this._largeBackupPboRing[i].pbo);
      }
      this._largeBackupPboRing = [];
      this._largeBackupPboBytes = 0;

      if (this.mrtFbo) gl.deleteFramebuffer(this.mrtFbo);
      if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
      if (this.bristleVao) gl.deleteVertexArray(this.bristleVao);
      if (this.quadCornerVbo) gl.deleteBuffer(this.quadCornerVbo);
      if (this.instSegVbo) gl.deleteBuffer(this.instSegVbo);
      if (this.instPropVbo) gl.deleteBuffer(this.instPropVbo);

      const progs = [
        this.progRectMap, this.progUnpremult, this.progUnpremultRect, this.progSubBake, this.progBristle,
        this.progRewet, this.progBrushApply, this.progVelAdvect,
        this.progDiv, this.progPress, this.progGradSub,
        this.progSurfStep, this.progBaseStep, this.progSurfSeep,
        this.progPerc, this.progComp, this.progEdgeProbe, this.progWetProbe,
        this.progPackDry, this.progUnpackDry, this.progReconcile, this.progLiquifyWarp,
        this.progPoreSmudgePickup, this.progPoreSmudgeDeposit, this.progSelMaskExtract,
        this.progSelTileMask, this.progSelPinWarp, this.progSelStampComp
      ];
      for (const p of progs) if (p) gl.deleteProgram(p);
    }
    this.ready = false;
    this.active = false;
    this._activeSolverCount = 0;
    this._pipelinesWarmed = false;
    this.gl = null;
  }
}
