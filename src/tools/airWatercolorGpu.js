/**
 * Zero-Overlay, Zero-Readback WebGL2 GPU Navier-Stokes Watercolor Engine
 * Architecture:
 * - No 1024x1024 sliding window (eliminates all mid-stroke recentering / readPixels baking stalls).
 * - No gpuRenderer.airOverlay or u_excludeActive cutout (eliminates all white GPU transition seams).
 * - Sparse 256x256 pooled GPU tiles (pig RGBA8, vel RGBA16F/RGBA8) seeded lazily from chunk.gpuTextures[layer]
 *   with a bounded 24-tile GPU wet-film cache for infinite-canvas wet-on-wet continuity.
 * - Pre-allocated 1024x1024 work FBOs scissor strictly to active stroke bbox, run batched segment injection,
 *   vorticity confinement, 4 Jacobi pressure passes, streamline advection, dendritic bloom, edge rings,
 *   and blit pigment directly into chunk.gpuTextures[layer] via chunkBlitFbo.
 * - End-of-stroke DRY_SHARPEN_FS and Canvas2D synchronization run once on endStroke() with Undo & Selection fidelity.
 */

import { backupChunkLayer } from '../engine/backupPool.js';
import { GLSL_RYB_MIX } from '../colorUtils.js';
import { GLSL_SURFACE_BIOME_SAMPLER } from '../engine/canvasSurfaceGpu.js';

const TILE_SIZE = 256;
const WORK_SIZE = 1024;
const MAX_POOL_TILES = 48;
const MAX_WET_CACHE = 24;

const QUAD_UNIT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_unitPos;
out vec2 v_uv;
void main() {
  v_uv = a_unitPos;
  gl_Position = vec4(a_unitPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

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

// Restore decayed wet water (.z) and residual velocity (.xy) while clearing strokeCov (.w)
const PREP_STROKE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform float u_decay;
uniform int u_isFloat;
out vec4 outVel;
void main() {
  vec4 v = texture(u_vel, v_uv);
  float water = v.z * u_decay;
  if (water < 0.015) water = 0.0;
  if (u_isFloat == 1) {
    outVel = vec4(v.xy * u_decay * 0.45, water, 0.0);
  } else {
    float zeroPt = 127.0 / 255.0;
    vec2 decVel = (v.xy - zeroPt) * u_decay * 0.45 + zeroPt;
    outVel = vec4(decVel, water, 0.0);
  }
}
`;

const WATERCOLOR_GLSL_COMMON = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float samplePaperTooth(vec2 wp) {
  // Golden-angle rotated 2-octave domain-warped value noise (zero diamond/grid artifacts, faster than trig fibers)
  vec2 p1 = vec2(wp.x * 0.80 - wp.y * 0.60, wp.x * 0.60 + wp.y * 0.80) * 0.11;
  float nCoarse = valueNoise(p1);
  vec2 p2 = vec2(wp.x * 0.39 + wp.y * 0.92, -wp.x * 0.92 + wp.y * 0.39) * 0.31;
  float nFine = valueNoise(p2 + vec2(nCoarse * 1.35 + 17.3, nCoarse * 0.95 + 9.1));
  return clamp(0.12 + 0.54 * nCoarse + 0.34 * nFine, 0.0, 1.0);
}

vec2 sampleCurl(vec2 wp, float t, float freq) {
  // 3 non-orthogonal rotated & mutually warped wave directions (~22 deg, ~123 deg, ~251 deg) — no 45-deg rhombi
  vec2 p = wp * freq;
  float a = (p.x * 0.927 + p.y * 0.375) + t * 0.68;
  float b = (-p.x * 0.545 + p.y * 0.838) * 1.37 - t * 0.53;
  float c = (-p.x * 0.312 - p.y * 0.950) * 2.13 + t * 0.81;

  float sa = sin(a);
  float sb = sin(b + 0.62 * sa);
  float sc = sin(c + 0.58 * sb);

  float w1 = cos(a + 0.55 * sc);
  float w2 = cos(b + 0.62 * sa);
  float w3 = cos(c + 0.58 * sb);

  return vec2(
    0.72 * w1 - 0.64 * w2 + 0.48 * w3,
    -0.58 * w1 - 0.71 * w2 - 0.52 * w3
  );
}

vec2 decodeVel(vec4 vTex, int isFloat, float maxVel) {
  if (isFloat == 1) return vTex.xy;
  float zeroPt = 127.0 / 255.0;
  return (vTex.xy - zeroPt) * (2.0 * maxVel);
}

vec2 encodeVel(vec2 vel, int isFloat, float maxVel) {
  vec2 cv = clamp(vel, vec2(-maxVel), vec2(maxVel));
  if (isFloat == 1) return cv;
  float zeroPt = 127.0 / 255.0;
  return clamp(cv / (2.0 * maxVel) + zeroPt, 0.0, 1.0);
}
`;

// Pass 1 (MRT): Inject capsule brush pigment, Beer-Lambert optical glazing, meniscus edge, velocity & water
const INJECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_pigment;
uniform sampler2D u_vel;
uniform sampler2D u_tip;
uniform vec2 u_simOrigin;
uniform vec2 u_from;
uniform vec2 u_to;
uniform vec2 u_dir;
uniform float u_radius;
uniform vec3 u_color;
uniform float u_opacity;
uniform float u_flow;
uniform float u_wetness;
uniform float u_streamFlow;
uniform float u_bloom;
uniform float u_edge;
uniform float u_granulation;
uniform float u_time;
uniform float u_segLen;
uniform float u_maxVel;
uniform int u_isFloat;
uniform int u_alphaLock;
uniform int u_hasTip;
uniform int u_isDab;
uniform float u_rotCos;
uniform float u_rotSin;
uniform float u_tipPour;
uniform int u_physicalMix;
uniform sampler2D u_surfaceMap;
uniform sampler2D u_poreMap;
uniform int u_hasSurface;
uniform int u_useHeightmap;
uniform int u_heightSource;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_surfSlip;
uniform float u_surfResist;
uniform float u_surfChannel;
uniform float u_surfRelief;
uniform float u_pressure;

layout(location = 0) out vec4 outPigment;
layout(location = 1) out vec4 outVel;

${WATERCOLOR_GLSL_COMMON}
${GLSL_RYB_MIX}
${GLSL_SURFACE_BIOME_SAMPLER}

void main() {
  vec4 pig = texture(u_pigment, v_uv);
  vec4 vTex = texture(u_vel, v_uv);

  vec2 vel = decodeVel(vTex, u_isFloat, u_maxVel);
  float water = vTex.z;
  float prevCov = vTex.w;

  vec2 worldPos = u_simOrigin + gl_FragCoord.xy;
  vec2 seg = u_to - u_from;
  float segL2 = dot(seg, seg);
  float tSeg = segL2 > 0.0001 ? clamp(dot(worldPos - u_from, seg) / segL2, 0.0, 1.0) : 0.0;
  vec2 closest = u_from + seg * tSeg;
  float dist = length(worldPos - closest);

  float bleedSpread = (u_hasTip == 1)
    ? (0.06 + u_tipPour * (0.20 + u_bloom * 0.28))
    : (0.20 + u_bloom * 0.28);
  float bleedReach = u_radius * (1.02 + bleedSpread);
  if (dist >= bleedReach) {
    outPigment = pig;
    outVel = vTex;
    return;
  }

  float curlFreq = 1.0 / max(12.0, u_radius * 0.72);
  vec2 curl = sampleCurl(worldPos, u_time, curlFreq);
  float tooth = samplePaperTooth(worldPos);
  vec2 surfSlope = vec2(0.0);
  float surfCavity = 0.0;
  if (u_hasSurface == 1) {
    vec4 pore = sampleSurfacePoreBiome(u_poreMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    tooth = clamp(mix(0.5, pore.a, clamp(0.25 + 0.85 * u_surfRelief, 0.0, 1.25)), 0.0, 1.0);
    surfCavity = clamp((1.0 - pore.g) * 0.55 + (1.0 - pore.r) * 0.25, 0.0, 1.0);
  }
  if (u_useHeightmap == 1) {
    if (u_heightSource == 0 && u_hasSurface == 1) {
      vec4 surf = sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
      tooth = clamp(mix(tooth, surf.r, 0.35), 0.0, 1.0);
      surfSlope = (surf.gb - 0.5) * 2.0;
      surfCavity = clamp(mix(surfCavity, surf.a, 0.50), 0.0, 1.0);
    } else if (u_heightSource == 1) {
      vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
      vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
      vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
      vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));
      vec4 pL = texture(u_pigment, uvL);
      vec4 pR = texture(u_pigment, uvR);
      vec4 pT = texture(u_pigment, uvT);
      vec4 pB = texture(u_pigment, uvB);
      float hL = pL.a * (0.35 + 0.65 * dot(pL.a > 0.002 ? (pL.rgb / pL.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hR = pR.a * (0.35 + 0.65 * dot(pR.a > 0.002 ? (pR.rgb / pR.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hT = pT.a * (0.35 + 0.65 * dot(pT.a > 0.002 ? (pT.rgb / pT.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hB = pB.a * (0.35 + 0.65 * dot(pB.a > 0.002 ? (pB.rgb / pB.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      surfSlope = vec2(hR - hL, hB - hT) * 2.2;
      float ridgeH = clamp(pig.a * (0.35 + 0.65 * dot(pig.a > 0.002 ? (pig.rgb / pig.a) : vec3(0.0), vec3(0.299, 0.587, 0.114))), 0.0, 1.0);
      tooth = clamp(mix(tooth, 0.5 + (ridgeH - 0.5) * 0.6, 0.45), 0.0, 1.0);
      surfCavity = clamp(max(surfCavity, (1.0 - ridgeH) * pig.a * 0.45), 0.0, 1.0);
    }
  }

  float dNormRaw = dist / max(1.0, u_radius);
  float edgeWobble = (curl.x * 0.10 + (tooth - 0.5) * (0.14 + 0.08 * u_surfRelief)) * (0.25 + 0.75 * u_bloom);
  float dNorm = max(0.0, dNormRaw + edgeWobble);

  float maxTipA = 0.0;
  float maxTipBump = 0.0;
  vec2 bestGrad = vec2(0.0);

  if (u_hasTip == 1) {
    float invRadius = 1.0 / max(1.0, u_radius);
    vec2 uvWarp = (u_tipPour > 0.03)
      ? ((curl * 0.032 + vec2(tooth - 0.5, 0.5 - tooth) * 0.045) * u_tipPour)
      : vec2(0.0);

    if (u_isDab == 1 || u_segLen < 0.02) {
      vec2 dtx = worldPos - u_to;
      vec2 tipUv = vec2(
        ((dtx.x * u_rotCos - dtx.y * u_rotSin) * invRadius + 1.0) * 0.5,
        ((dtx.x * u_rotSin + dtx.y * u_rotCos) * invRadius + 1.0) * 0.5
      ) + uvWarp;
      if (tipUv.x >= 0.0 && tipUv.x <= 1.0 && tipUv.y >= 0.0 && tipUv.y <= 1.0) {
        vec4 ts = texture(u_tip, tipUv);
        maxTipA = ts.r;
        maxTipBump = ts.g;
        bestGrad = (ts.ba - 0.5) * 2.0;
      }
    } else {
      vec2 ap = worldPos - u_from;
      float proj = dot(ap, u_dir);
      float sMin = max(0.0, proj - bleedReach);
      float sMax = min(u_segLen, proj + bleedReach);
      float sSpan = max(0.0, sMax - sMin);
      int nSteps = clamp(int(ceil(sSpan / max(1.5, u_radius * 0.16))), 1, 16);
      float sStep = sSpan / float(nSteps);

      vec2 dtx0 = worldPos - (u_from + u_dir * sMin);
      vec2 curUv = vec2(
        ((dtx0.x * u_rotCos - dtx0.y * u_rotSin) * invRadius + 1.0) * 0.5,
        ((dtx0.x * u_rotSin + dtx0.y * u_rotCos) * invRadius + 1.0) * 0.5
      ) + uvWarp;
      vec2 stepUv = vec2(
        -(u_dir.x * u_rotCos - u_dir.y * u_rotSin) * invRadius * 0.5 * sStep,
        -(u_dir.x * u_rotSin + u_dir.y * u_rotCos) * invRadius * 0.5 * sStep
      );

      for (int k = 0; k <= 16; k++) {
        if (k > nSteps) break;
        if (curUv.x >= 0.0 && curUv.x <= 1.0 && curUv.y >= 0.0 && curUv.y <= 1.0) {
          vec4 ts = texture(u_tip, curUv);
          if (ts.r > maxTipA) maxTipA = ts.r;
          if (ts.g > maxTipBump) {
            maxTipBump = ts.g;
            bestGrad = (ts.ba - 0.5) * 2.0;
          }
        }
        curUv += stepUv;
      }
    }
  }

  float activeMask = (u_hasTip == 1) ? max(maxTipA, maxTipBump * u_tipPour) : 1.0;
  float prox = max(0.0, 1.0 - dNormRaw / 1.15) * (0.25 + 0.75 * activeMask);
  float pushAmp = min(3.2, u_segLen * 0.28 + 0.45) * (0.30 + 1.45 * u_streamFlow) * (0.35 + 0.65 * u_wetness);
  float curlAmp = (0.35 + 1.35 * u_streamFlow) * (0.35 + 0.65 * u_wetness);
  vec2 tipPourPush = vec2(0.0);
  if (u_hasTip == 1 && u_tipPour > 0.02) {
    vec2 gWorld = vec2(
      bestGrad.x * u_rotCos + bestGrad.y * u_rotSin,
      -bestGrad.x * u_rotSin + bestGrad.y * u_rotCos
    );
    float gLen = length(gWorld);
    if (gLen > 0.01) {
      gWorld /= gLen;
      float pourAmp = (0.55 + 1.65 * u_streamFlow) * u_tipPour * (0.35 + 0.65 * maxTipBump) * (0.4 + 0.6 * u_wetness);
      tipPourPush = -gWorld * pourAmp;
    }
  }
  float slipVelMult = (u_hasSurface == 1) ? mix(0.68, 1.58, u_surfSlip) : 1.0;
  vec2 surfChannelPush = (u_hasSurface == 1)
    ? (surfSlope * (-0.50 - 1.45 * u_surfChannel) * (0.35 + 0.65 * u_wetness) * prox)
    : vec2(0.0);
  vel += (u_dir * pushAmp * prox * prox + curl * curlAmp * prox + tipPourPush) * slipVelMult + surfChannelPush;
  vel = clamp(vel, vec2(-u_maxVel), vec2(u_maxVel));

  float meniscus;
  if (u_hasTip == 1) {
    float drawSilhouette = maxTipA;
    float pourBody = smoothstep(0.05, 0.56, maxTipBump * (0.80 + 0.36 * tooth) + maxTipA * 0.38);
    meniscus = clamp(mix(drawSilhouette, max(drawSilhouette, pourBody), u_tipPour), 0.0, 1.0);
    dNorm = clamp(1.0 - mix(maxTipA * 0.85, maxTipBump * 0.90, u_tipPour), 0.0, 1.05);
  } else {
    float aa = max(0.035, 1.6 / max(2.0, u_radius));
    meniscus = 1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.35, dNorm);
  }

  if (meniscus > 0.004) {
    float toothCatch = 1.0;
    if (u_hasSurface == 1 && u_surfResist > 0.01) {
      float valleyDepth = clamp(1.0 - tooth + surfCavity * 0.45, 0.0, 1.0);
      float pressFill = clamp(0.18 + 0.65 * clamp(u_pressure, 0.05, 1.0) + 0.42 * prevCov + 0.45 * u_wetness, 0.0, 1.0);
      float resistGate = smoothstep(0.0, 0.72, valleyDepth * u_surfResist * 1.15 - pressFill * 0.48);
      toothCatch = clamp(1.0 - resistGate * (0.45 + 0.45 * u_surfResist), 0.14, 1.0);
    }

    float waterScale = ((u_hasTip == 1) ? mix(0.24, 1.0, u_tipPour) : 1.0) * (0.35 + 0.65 * toothCatch);
    float tipWaterMass = (u_hasTip == 1) ? mix(maxTipA, max(maxTipA * 0.6, maxTipBump), u_tipPour) : meniscus;
    float injWater = clamp(tipWaterMass * (0.30 + 0.70 * u_wetness) * (0.50 + 0.50 * u_flow) * waterScale, 0.0, 1.0);
    if (injWater > water) water = injWater;

    if (u_alphaLock == 1 && pig.a <= 0.004) {
      outPigment = pig;
      outVel = vec4(encodeVel(vel, u_isFloat, u_maxVel), water, prevCov);
      return;
    }

    float rimMask = (u_hasTip == 1)
      ? smoothstep(0.18, 0.72, dNorm) * meniscus * (1.0 - 0.55 * maxTipBump * (1.0 - u_tipPour))
      : smoothstep(0.68, 0.96, dNorm) * meniscus;
    float centerThin = clamp(1.0 - u_edge * 0.18 * (1.0 - smoothstep(0.0, 0.85, dNorm)) * u_wetness, 0.25, 1.0);
    float rimBoost = 1.0 + rimMask * u_edge * 0.22;

    vec2 fineCurl = sampleCurl(worldPos + curl * 6.0, u_time * 0.4, curlFreq * 1.65);
    float mottle = (tooth - 0.5) * (0.65 + 0.30 * u_surfRelief) + fineCurl.y * 0.35;
    float ribbon = 0.94 + 0.08 * mottle * (0.25 + 0.75 * u_streamFlow);
    float granEff = u_granulation + ((u_hasSurface == 1) ? u_surfRelief * 0.18 : 0.0);
    float gran = clamp(1.0 - granEff * (0.24 * tooth + 0.16 * (1.0 - surfCavity)), 0.45, 1.05);

    float targetA = clamp(meniscus * u_opacity * u_flow * centerThin * rimBoost * ribbon * gran * toothCatch, 0.0, 1.0);
    float stepA = (targetA > prevCov && prevCov < 0.992)
      ? clamp((targetA - prevCov) / (1.0 - prevCov), 0.0, 1.0)
      : 0.0;

    if (stepA > 0.002) {
      vec3 srcCol = u_color;
      float rimDark = 1.0 - rimMask * u_edge * 0.11 - u_granulation * 0.055 * (1.0 - tooth);
      srcCol *= max(0.82, rimDark);

      vec3 mixedCol = srcCol;
      if (pig.a > 0.015) {
        vec3 dstCol = pig.rgb / max(0.001, pig.a);
        float optW = clamp(0.28 + 0.44 * u_wetness, 0.0, 1.0);
        if (u_physicalMix == 1) {
          vec3 pigMix = mixPaintCol(dstCol, srcCol, 0.55, 1) * 0.94;
          mixedCol = mixPaintCol(srcCol, pigMix, optW, 1);
        } else {
          vec3 multCol = dstCol * srcCol;
          mixedCol = mix(srcCol, multCol, optW);
        }
      }

      vec4 outPigMix = mixPremulPaint(pig, vec4(mixedCol, 1.0), stepA, u_physicalMix);
      float outA = outPigMix.a;
      vec3 outPR = outPigMix.rgb;

      if (u_alphaLock == 1) {
        outPR = (outA > 0.001) ? (outPR * (pig.a / outA)) : vec3(0.0);
        outA = pig.a;
      } else if (outA < targetA) {
        float scaleUp = (outA > 0.001) ? (targetA / outA) : 1.0;
        outPR = mixPremulPaint(vec4(outPR * scaleUp, targetA), vec4(mixedCol * targetA, targetA), 0.25, u_physicalMix).rgb;
        outA = targetA;
      }

      float outAClamp = clamp(outA, 0.0, 1.0);
      vec3 outPRClamp = min(clamp(outPR, 0.0, 1.0), vec3(outAClamp));
      pig = vec4(outPRClamp, outAClamp);
      if (targetA > prevCov) prevCov = targetA;
    }
  }

  outPigment = pig;
  outVel = vec4(encodeVel(vel, u_isFloat, u_maxVel), water, prevCov);
}
`;

const VORTICITY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_maxVel;
uniform int u_isFloat;
out vec4 outVort;

${WATERCOLOR_GLSL_COMMON}

void main() {
  vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
  vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
  vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
  vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));
  vec2 vL = decodeVel(texture(u_vel, uvL), u_isFloat, u_maxVel);
  vec2 vR = decodeVel(texture(u_vel, uvR), u_isFloat, u_maxVel);
  vec2 vT = decodeVel(texture(u_vel, uvT), u_isFloat, u_maxVel);
  vec2 vB = decodeVel(texture(u_vel, uvB), u_isFloat, u_maxVel);
  float omega = 0.5 * ((vR.y - vL.y) - (vB.x - vT.x));
  outVort = vec4(omega, abs(omega), 0.0, 1.0);
}
`;

const CONFINEMENT_AND_DIV_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_vel;
uniform sampler2D u_vort;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_vortAmp;
uniform float u_maxVel;
uniform int u_isFloat;

layout(location = 0) out vec4 outVel;
layout(location = 1) out vec4 outDiv;

${WATERCOLOR_GLSL_COMMON}

void main() {
  vec4 cV = texture(u_vel, v_uv);
  vec2 vel = decodeVel(cV, u_isFloat, u_maxVel);

  vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
  vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
  vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
  vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));

  float oL = texture(u_vort, uvL).y;
  float oR = texture(u_vort, uvR).y;
  float oT = texture(u_vort, uvT).y;
  float oB = texture(u_vort, uvB).y;
  float omega = texture(u_vort, v_uv).x;

  vec2 grad = vec2(oR - oL, oB - oT) * 0.5;
  float gLen = length(grad) + 1e-4;
  vec2 nrm = grad / gLen;
  vel += vec2(nrm.y, -nrm.x) * omega * u_vortAmp;
  vel = clamp(vel, vec2(-u_maxVel), vec2(u_maxVel));

  vec2 vL = decodeVel(texture(u_vel, uvL), u_isFloat, u_maxVel);
  vec2 vR = decodeVel(texture(u_vel, uvR), u_isFloat, u_maxVel);
  vec2 vT = decodeVel(texture(u_vel, uvT), u_isFloat, u_maxVel);
  vec2 vB = decodeVel(texture(u_vel, uvB), u_isFloat, u_maxVel);
  float div = -0.5 * ((vR.x - vL.x) + (vB.y - vT.y));
  float outD = (u_isFloat == 1) ? div : clamp(div / (2.0 * u_maxVel) + (127.0 / 255.0), 0.0, 1.0);

  outVel = vec4(encodeVel(vel, u_isFloat, u_maxVel), cV.zw);
  outDiv = vec4(outD, 0.0, 0.0, 1.0);
}
`;

const JACOBI_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_press;
uniform sampler2D u_div;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_maxVel;
uniform int u_isFloat;
out vec4 outPress;
void main() {
  float zeroPt = 127.0 / 255.0;
  vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
  vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
  vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
  vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));
  float pL = texture(u_press, uvL).x;
  float pR = texture(u_press, uvR).x;
  float pT = texture(u_press, uvT).x;
  float pB = texture(u_press, uvB).x;
  float d = texture(u_div, v_uv).x;
  if (u_isFloat == 0) {
    pL = (pL - zeroPt) * (2.0 * u_maxVel);
    pR = (pR - zeroPt) * (2.0 * u_maxVel);
    pT = (pT - zeroPt) * (2.0 * u_maxVel);
    pB = (pB - zeroPt) * (2.0 * u_maxVel);
    d = (d - zeroPt) * (2.0 * u_maxVel);
  }
  float p = (d + pL + pR + pT + pB) * 0.25;
  float outP = (u_isFloat == 1) ? p : clamp(p / (2.0 * u_maxVel) + zeroPt, 0.0, 1.0);
  outPress = vec4(outP, 0.0, 0.0, 1.0);
}
`;

const FLOW_AND_EDGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_pigment;
uniform sampler2D u_vel;
uniform sampler2D u_press;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform vec2 u_simOrigin;
uniform float u_wetness;
uniform float u_streamFlow;
uniform float u_bloom;
uniform float u_edge;
uniform float u_granulation;
uniform float u_maxVel;
uniform float u_dt;
uniform int u_isFloat;
uniform int u_alphaLock;
uniform int u_physicalMix;
uniform sampler2D u_surfaceMap;
uniform sampler2D u_poreMap;
uniform int u_hasSurface;
uniform int u_useHeightmap;
uniform int u_heightSource;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_surfSlip;
uniform float u_surfResist;
uniform float u_surfChannel;
uniform float u_surfRelief;
uniform float u_surfAbsorb;

layout(location = 0) out vec4 outPigment;
layout(location = 1) out vec4 outVel;

${WATERCOLOR_GLSL_COMMON}
${GLSL_RYB_MIX}
${GLSL_SURFACE_BIOME_SAMPLER}

void main() {
  vec4 cV = texture(u_vel, v_uv);
  vec2 vel = decodeVel(cV, u_isFloat, u_maxVel);
  float water = cV.z;
  float strokeCov = cV.w;

  vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
  vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
  vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
  vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));

  float zeroPt = 127.0 / 255.0;
  float pL = texture(u_press, uvL).x;
  float pR = texture(u_press, uvR).x;
  float pT = texture(u_press, uvT).x;
  float pB = texture(u_press, uvB).x;
  if (u_isFloat == 0) {
    pL = (pL - zeroPt) * (2.0 * u_maxVel);
    pR = (pR - zeroPt) * (2.0 * u_maxVel);
    pT = (pT - zeroPt) * (2.0 * u_maxVel);
    pB = (pB - zeroPt) * (2.0 * u_maxVel);
  }
  vel -= 0.5 * vec2(pR - pL, pB - pT);
  vel = clamp(vel, vec2(-u_maxVel), vec2(u_maxVel));

  float surfDampBias = (u_hasSurface == 1) ? ((u_surfSlip - 0.5) * 0.09 - u_surfAbsorb * 0.03) : 0.0;
  float damp = clamp(0.78 + 0.16 * u_wetness + surfDampBias, 0.62, 0.985);
  vec2 advVelUv = clamp(v_uv - vel * u_texel * 0.65 * u_dt, u_uvClamp.xy, u_uvClamp.zw);
  vec2 velNext = decodeVel(texture(u_vel, advVelUv), u_isFloat, u_maxVel) * damp;

  vec4 pigC = texture(u_pigment, v_uv);

  float wL = texture(u_vel, uvL).z;
  float wR = texture(u_vel, uvR).z;
  float wT = texture(u_vel, uvT).z;
  float wB = texture(u_vel, uvB).z;
  float maxNbW = max(water, max(max(wL, wR), max(wT, wB)));

  if (maxNbW <= 0.015) {
    outPigment = pigC;
    outVel = vec4(encodeVel(velNext, u_isFloat, u_maxVel), 0.0, strokeCov);
    return;
  }

  vec2 worldPos = u_simOrigin + gl_FragCoord.xy;
  float tooth = samplePaperTooth(worldPos);
  vec2 surfSlope = vec2(0.0);
  float surfCavity = 0.0;
  if (u_hasSurface == 1) {
    vec4 pore = sampleSurfacePoreBiome(u_poreMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    tooth = clamp(mix(0.5, pore.a, clamp(0.25 + 0.85 * u_surfRelief, 0.0, 1.25)), 0.0, 1.0);
    surfCavity = clamp((1.0 - pore.g) * 0.55 + (1.0 - pore.r) * 0.25, 0.0, 1.0);
    // Pore-fiber wicking anisotropy without forced steep terrain cliff bounce
    vec2 poreGrad = vec2(pore.r - 0.5, pore.g - 0.5) * (0.28 * u_surfChannel);
    velNext = clamp(velNext + poreGrad * smoothstep(0.015, 0.35, maxNbW) * u_dt, vec2(-u_maxVel), vec2(u_maxVel));
  }
  if (u_useHeightmap == 1) {
    if (u_heightSource == 0 && u_hasSurface == 1) {
      vec4 surf = sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
      tooth = clamp(mix(tooth, surf.r, 0.35), 0.0, 1.0);
      surfSlope = (surf.gb - 0.5) * 2.0;
      surfCavity = clamp(mix(surfCavity, surf.a, 0.50), 0.0, 1.0);
    } else if (u_heightSource == 1) {
      vec4 pL_s = texture(u_pigment, uvL);
      vec4 pR_s = texture(u_pigment, uvR);
      vec4 pT_s = texture(u_pigment, uvT);
      vec4 pB_s = texture(u_pigment, uvB);
      float hL = pL_s.a * (0.35 + 0.65 * dot(pL_s.a > 0.002 ? (pL_s.rgb / pL_s.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hR = pR_s.a * (0.35 + 0.65 * dot(pR_s.a > 0.002 ? (pR_s.rgb / pR_s.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hT = pT_s.a * (0.35 + 0.65 * dot(pT_s.a > 0.002 ? (pT_s.rgb / pT_s.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      float hB = pB_s.a * (0.35 + 0.65 * dot(pB_s.a > 0.002 ? (pB_s.rgb / pB_s.a) : vec3(0.0), vec3(0.299, 0.587, 0.114)));
      surfSlope = vec2(hR - hL, hB - hT) * 2.2;
      float ridgeH = clamp(pigC.a * (0.35 + 0.65 * dot(pigC.a > 0.002 ? (pigC.rgb / pigC.a) : vec3(0.0), vec3(0.299, 0.587, 0.114))), 0.0, 1.0);
      tooth = clamp(mix(tooth, 0.5 + (ridgeH - 0.5) * 0.6, 0.45), 0.0, 1.0);
      surfCavity = clamp(max(surfCavity, (1.0 - ridgeH) * pigC.a * 0.45), 0.0, 1.0);
    }
    if (dot(surfSlope, surfSlope) > 1e-6) {
      // Channel liquid along height slopes and grooves
      vec2 surfTan = vec2(-surfSlope.y, surfSlope.x);
      float tanAlign = dot(velNext, surfTan) >= 0.0 ? 1.0 : -1.0;
      vec2 grainForce = (-surfSlope * (0.45 + 0.85 * u_surfChannel) + surfTan * tanAlign * (0.75 * u_surfChannel)) * smoothstep(0.015, 0.35, maxNbW);
      velNext = clamp(velNext + grainForce * u_dt, vec2(-u_maxVel), vec2(u_maxVel));
    }
  }
  float mob = smoothstep(0.015, 0.40, maxNbW) * (0.20 + 0.80 * u_wetness) * ((u_hasSurface == 1) ? mix(0.75, 1.32, u_surfSlip) : 1.0);

  float spd = length(vel);
  float advScale = min(3.5, (0.35 + 0.95 * u_streamFlow) * mob * u_dt);
  vec2 backUv = clamp(v_uv - vel * u_texel * advScale, u_uvClamp.xy, u_uvClamp.zw);
  vec4 pigAdv = texture(u_pigment, backUv);
  float waterAdv = texture(u_vel, backUv).z;

  float streamMix = clamp(spd * 0.34 * advScale, 0.0, 0.42);
  vec4 pigOut = mixPremulPaint(pigC, pigAdv, streamMix, u_physicalMix);
  float waterOut = mix(water, waterAdv, streamMix);

  vec4 pL_c = texture(u_pigment, uvL);
  vec4 pR_c = texture(u_pigment, uvR);
  vec4 pT_c = texture(u_pigment, uvT);
  vec4 pB_c = texture(u_pigment, uvB);

  float bestW = water;
  vec4 bestPig = pigOut;
  if (wL > bestW) { bestW = wL; bestPig = pL_c; }
  if (wR > bestW) { bestW = wR; bestPig = pR_c; }
  if (wT > bestW) { bestW = wT; bestPig = pT_c; }
  if (wB > bestW) { bestW = wB; bestPig = pB_c; }

  float poreOpen = (u_hasSurface == 1) ? mix(0.55, 1.25, u_surfAbsorb) * (0.75 + 0.65 * surfCavity + 0.35 * u_surfChannel) : 1.0;
  float channelOpen = smoothstep(0.22, 0.88, tooth + u_bloom * 0.32 - 0.15) * clamp(poreOpen, 0.25, 1.35);
  float grainDiff = 1.0 - (u_granulation + ((u_hasSurface == 1) ? u_surfResist * 0.25 : 0.0)) * 0.28 * (1.0 - tooth);
  float wickAmt = clamp(u_bloom * 0.22 * mob * channelOpen * grainDiff * u_dt * max(0.0, (bestW - water) * 2.5 + 0.25), 0.0, 0.26);
  if (wickAmt > 0.002 && bestPig.a > pigOut.a) {
    pigOut = mixPremulPaint(pigOut, bestPig, wickAmt, u_physicalMix);
    waterOut = mix(waterOut, bestW, wickAmt * 0.85);
  }

  float gradW = length(vec2(wR - wL, wB - wT));
  if (u_edge > 0.02 && gradW > 0.08 && pigOut.a > 0.02) {
    float rimStr = clamp(gradW * 0.12 * u_edge * mob * u_dt, 0.0, 0.024);
    float newA = clamp(pigOut.a + rimStr * 0.22 * (1.0 - pigOut.a), 0.0, 1.0);
    float colShade = 1.0 - rimStr * 0.08;
    float ratio = (pigOut.a > 0.001) ? (newA / pigOut.a) : 1.0;
    pigOut.rgb = clamp(pigOut.rgb * ratio * colShade, 0.0, 1.0);
    pigOut.a = newA;
  }

  float effGran = clamp(u_granulation + ((u_hasSurface == 1) ? u_surfRelief * 0.35 : 0.0), 0.0, 1.25);
  if (effGran > 0.02 && pigOut.a > 0.04) {
    vec4 avgNbP = (pL_c + pR_c + pT_c + pB_c) * 0.25;
    float valleyBias = clamp(((0.52 - tooth) + surfCavity * 0.35) * effGran * 0.025 * mob, -0.015, 0.02);
    pigOut.a = clamp(pigOut.a + valleyBias * pigOut.a * (1.0 - pigOut.a), 0.0, 1.0);
    pigOut.rgb = mix(pigOut.rgb, min(pigOut.rgb, avgNbP.rgb * 0.98 + pigOut.rgb * 0.02), effGran * 0.04 * (1.0 - tooth + surfCavity * 0.35));
  }

  if (u_alphaLock == 1) {
    pigOut.rgb = (pigOut.a > 0.001 && pigC.a > 0.001) ? clamp(pigOut.rgb * (pigC.a / pigOut.a), 0.0, 1.0) : pigC.rgb;
    pigOut.a = pigC.a;
  }

  pigOut = clamp(pigOut, 0.0, 1.0);
  pigOut.rgb = min(pigOut.rgb, vec3(pigOut.a));
  outPigment = pigOut;
  outVel = vec4(encodeVel(velNext, u_isFloat, u_maxVel), clamp(waterOut, 0.0, 1.0), strokeCov);
}
`;

const DRY_SHARPEN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_pigment;
uniform sampler2D u_vel;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform float u_edge;
uniform float u_wetness;

layout(location = 0) out vec4 outPigment;
layout(location = 1) out vec4 outVel;

void main() {
  vec4 c = texture(u_pigment, v_uv);
  vec4 vTex = texture(u_vel, v_uv);
  float water = vTex.z;

  if (water <= 0.015 || c.a <= 0.004) {
    outPigment = c;
    outVel = vTex;
    return;
  }

  vec2 uvL = vec2(max(u_uvClamp.x, v_uv.x - u_texel.x), v_uv.y);
  vec2 uvR = vec2(min(u_uvClamp.z, v_uv.x + u_texel.x), v_uv.y);
  vec2 uvT = vec2(v_uv.x, max(u_uvClamp.y, v_uv.y - u_texel.y));
  vec2 uvB = vec2(v_uv.x, min(u_uvClamp.w, v_uv.y + u_texel.y));

  vec4 pL = texture(u_pigment, uvL);
  vec4 pR = texture(u_pigment, uvR);
  vec4 pT = texture(u_pigment, uvT);
  vec4 pB = texture(u_pigment, uvB);

  vec3 cStraight = c.rgb / max(0.001, c.a);
  vec3 avgStraight = (
    (pL.a > 0.004 ? pL.rgb / pL.a : cStraight) +
    (pR.a > 0.004 ? pR.rgb / pR.a : cStraight) +
    (pT.a > 0.004 ? pT.rgb / pT.a : cStraight) +
    (pB.a > 0.004 ? pB.rgb / pB.a : cStraight)
  ) * 0.25;

  float sharpAmt = 0.08 + 0.14 * u_edge;
  vec3 sharpStraight = clamp(cStraight + (cStraight - avgStraight) * sharpAmt, 0.0, 1.0);
  vec4 sharp = vec4(sharpStraight * c.a, c.a);

  float nextWater = min(1.0, water * (0.45 + 0.45 * u_wetness));
  outPigment = sharp;
  outVel = vec4(vTex.xy, nextWater, 0.0);
}
`;

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

export class GpuWatercolorSolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer.gl;
    this.ready = false;
    this._pipelinesWarmed = false;

    this.active = false;
    this.activeLayer = -1;
    this.activeProj = null;
    this.wetDecay = 0.0;
    this.curWorkIdx = 0;

    this.batchActive = false;
    this.batchWorkX = 0;
    this.batchWorkY = 0;
    this.batchBoxW = 0;
    this.batchBoxH = 0;
    this.batchApron = 8;
    this.batchTiles = [];

    this.isFloatVel = false;
    this.maxVel = 4.5;

    this.activeTiles = new Map();
    this.tilePool = [];
    this.wetCache = new Map(); // "${proj}:${layer}:${tx},${ty}" -> { vel, updatedAt }
    this.wetPool = [];        // reusable 256x256 vel tex+fbo slots
    this.touchedChunks = new Map();

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
      console.error('AirWatercolor Program Link Error:', gl.getProgramInfoLog(prog));
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

  _cacheLocs(prog, names) {
    const gl = this.gl;
    const locs = {};
    for (let i = 0; i < names.length; i++) {
      locs[names[i]] = gl.getUniformLocation(prog, names[i]);
    }
    return locs;
  }

  _init() {
    const gl = this.gl;
    if (!gl) return;

    const hasColorFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalfFloat = hasColorFloat || !!gl.getExtension('EXT_color_buffer_half_float');

    this.progRectMap = this._createProgram(RECT_MAP_VS, BLIT_FS);
    this.progBlit = this._createProgram(QUAD_UNIT_VS, BLIT_FS);
    this.progPrep = this._createProgram(QUAD_UNIT_VS, PREP_STROKE_FS);
    this.progInject = this._createProgram(QUAD_UNIT_VS, INJECT_FS);
    this.progVort = this._createProgram(QUAD_UNIT_VS, VORTICITY_FS);
    this.progConfDiv = this._createProgram(QUAD_UNIT_VS, CONFINEMENT_AND_DIV_FS);
    this.progJacobi = this._createProgram(QUAD_UNIT_VS, JACOBI_FS);
    this.progFlowEdge = this._createProgram(QUAD_UNIT_VS, FLOW_AND_EDGE_FS);
    this.progDrySharpen = this._createProgram(QUAD_UNIT_VS, DRY_SHARPEN_FS);
    this.progUnpremult = this._createProgram(QUAD_UNIT_VS, UNPREMULT_FS);

    if (!this.progRectMap || !this.progBlit || !this.progPrep || !this.progInject ||
        !this.progVort || !this.progConfDiv || !this.progJacobi || !this.progFlowEdge ||
        !this.progDrySharpen || !this.progUnpremult) {
      this.dispose();
      return;
    }

    let useFloat = hasHalfFloat;
    let testVel = useFloat ? this._makeTexFBO(WORK_SIZE, WORK_SIZE, true, true) : null;
    if (!testVel) {
      useFloat = false;
      testVel = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    }
    this.isFloatVel = useFloat;

    this.workVelA = testVel;
    this.workVelB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workVelTmp = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workPigA = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workPigB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workDiv = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workPressA = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workPressB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.workCurl = this._makeTexFBO(WORK_SIZE, WORK_SIZE, useFloat, true);
    this.chunkBlitFbo = gl.createFramebuffer();

    if (!this.workVelA || !this.workVelB || !this.workVelTmp || !this.workPigA || !this.workPigB ||
        !this.workDiv || !this.workPressA || !this.workPressB || !this.workCurl || !this.chunkBlitFbo) {
      this.dispose();
      return;
    }

    this.mrtWorkA = this._makeMrtFbo(this.workPigA.tex, this.workVelA.tex);
    this.mrtWorkB = this._makeMrtFbo(this.workPigB.tex, this.workVelB.tex);
    this.mrtTmpDiv = this._makeMrtFbo(this.workVelTmp.tex, this.workDiv.tex);

    if (!this.mrtWorkA || !this.mrtWorkB || !this.mrtTmpDiv) {
      this.dispose();
      return;
    }

    this.tipRes = 64;
    this.hasTip = false;
    this.tipTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.tipRes, this.tipRes, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Pre-warm 4 pooled 256x256 tiles so first stroke has zero FBO creation lag
    for (let i = 0; i < 4; i++) {
      const t = this._allocTileGpu();
      if (t) this.tilePool.push(t);
    }

    // Cache all uniform locations once (eliminates per-frame driver string lookups)
    this.rectLocs = this._cacheLocs(this.progRectMap, ['u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_tex']);
    this.blitLocs = this._cacheLocs(this.progBlit, ['u_tex']);
    this.prepLocs = this._cacheLocs(this.progPrep, ['u_vel', 'u_decay', 'u_isFloat']);
    this.injectLocs = this._cacheLocs(this.progInject, [
      'u_pigment', 'u_vel', 'u_tip', 'u_simOrigin', 'u_from', 'u_to', 'u_dir', 'u_radius',
      'u_color', 'u_opacity', 'u_flow', 'u_wetness', 'u_streamFlow', 'u_bloom', 'u_edge',
      'u_granulation', 'u_time', 'u_segLen', 'u_maxVel', 'u_isFloat', 'u_alphaLock',
      'u_hasTip', 'u_isDab', 'u_rotCos', 'u_rotSin', 'u_tipPour', 'u_physicalMix',
      'u_surfaceMap', 'u_poreMap', 'u_hasSurface', 'u_useHeightmap', 'u_heightSource',
      'u_texel', 'u_uvClamp', 'u_surfaceInvScale', 'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_surfSlip', 'u_surfResist', 'u_surfChannel', 'u_surfRelief', 'u_pressure'
    ]);
    this.vortLocs = this._cacheLocs(this.progVort, ['u_vel', 'u_texel', 'u_uvClamp', 'u_maxVel', 'u_isFloat']);
    this.confDivLocs = this._cacheLocs(this.progConfDiv, [
      'u_vel', 'u_vort', 'u_texel', 'u_uvClamp', 'u_vortAmp', 'u_maxVel', 'u_isFloat'
    ]);
    this.jacobiLocs = this._cacheLocs(this.progJacobi, [
      'u_press', 'u_div', 'u_texel', 'u_uvClamp', 'u_maxVel', 'u_isFloat'
    ]);
    this.flowEdgeLocs = this._cacheLocs(this.progFlowEdge, [
      'u_pigment', 'u_vel', 'u_press', 'u_texel', 'u_uvClamp', 'u_simOrigin',
      'u_wetness', 'u_streamFlow', 'u_bloom', 'u_edge', 'u_granulation',
      'u_maxVel', 'u_dt', 'u_isFloat', 'u_alphaLock', 'u_physicalMix',
      'u_surfaceMap', 'u_poreMap', 'u_hasSurface', 'u_useHeightmap', 'u_heightSource',
      'u_surfaceInvScale', 'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_surfSlip', 'u_surfResist', 'u_surfChannel', 'u_surfRelief', 'u_surfAbsorb'
    ]);
    this.drySharpenLocs = this._cacheLocs(this.progDrySharpen, [
      'u_pigment', 'u_vel', 'u_texel', 'u_uvClamp', 'u_edge', 'u_wetness'
    ]);
    this.unpremultLocs = this._cacheLocs(this.progUnpremult, ['u_tex']);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ready = true;
  }

  prewarmPipelines(engine = null, tipRgbaBytes = null, res = 64, tipVersion = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    if (tipRgbaBytes) {
      this.uploadTipMaps(tipRgbaBytes, res, tipVersion);
    }

    if (this._pipelinesWarmed) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      return;
    }

    const zeroVel = this.isFloatVel ? 0.0 : (127.0 / 255.0);
    const texel = 1.0 / WORK_SIZE;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPressA.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(zeroVel, zeroVel, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelA.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. progRectMap: workPigA -> workPigB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigB.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.rectLocs.u_dstRect, 0, 0, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigA.tex);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. progBlit: workPigB -> workPigA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigB.tex);
    gl.uniform1i(this.blitLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. progPrep: workVelA -> workVelB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelB.fbo);
    gl.useProgram(this.progPrep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelA.tex);
    gl.uniform1i(this.prepLocs.u_vel, 0);
    gl.uniform1f(this.prepLocs.u_decay, 0.5);
    gl.uniform1i(this.prepLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. progInject (MRT): workPigA + workVelA + tipTex -> mrtWorkB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkB);
    gl.useProgram(this.progInject);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigA.tex);
    gl.uniform1i(this.injectLocs.u_pigment, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelA.tex);
    gl.uniform1i(this.injectLocs.u_vel, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_tip, 2);
    gl.uniform2f(this.injectLocs.u_simOrigin, 0, 0);
    gl.uniform2f(this.injectLocs.u_from, 1, 1);
    gl.uniform2f(this.injectLocs.u_to, 2, 2);
    gl.uniform2f(this.injectLocs.u_dir, 1, 0);
    gl.uniform1f(this.injectLocs.u_radius, 12.0);
    gl.uniform3f(this.injectLocs.u_color, 0, 0, 0);
    gl.uniform1f(this.injectLocs.u_opacity, 0.5);
    gl.uniform1f(this.injectLocs.u_flow, 0.5);
    gl.uniform1f(this.injectLocs.u_wetness, 0.5);
    gl.uniform1f(this.injectLocs.u_streamFlow, 0.5);
    gl.uniform1f(this.injectLocs.u_bloom, 0.3);
    gl.uniform1f(this.injectLocs.u_edge, 0.3);
    gl.uniform1f(this.injectLocs.u_granulation, 0.2);
    gl.uniform1f(this.injectLocs.u_time, 0.0);
    gl.uniform1f(this.injectLocs.u_segLen, 1.0);
    gl.uniform1f(this.injectLocs.u_maxVel, this.maxVel);
    gl.uniform1i(this.injectLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.uniform1i(this.injectLocs.u_alphaLock, 0);
    gl.uniform1i(this.injectLocs.u_hasTip, this.hasTip ? 1 : 0);
    gl.uniform1i(this.injectLocs.u_isDab, 0);
    gl.uniform1f(this.injectLocs.u_rotCos, 1.0);
    gl.uniform1f(this.injectLocs.u_rotSin, 0.0);
    gl.uniform1f(this.injectLocs.u_tipPour, 0.5);
    gl.uniform1i(this.injectLocs.u_physicalMix, 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_surfaceMap, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_poreMap, 4);
    gl.uniform1i(this.injectLocs.u_hasSurface, 0);
    gl.uniform1i(this.injectLocs.u_useHeightmap, 0);
    gl.uniform1i(this.injectLocs.u_heightSource, 0);
    gl.uniform2f(this.injectLocs.u_texel, texel, texel);
    gl.uniform4f(this.injectLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1f(this.injectLocs.u_surfaceInvScale, 1.0 / 320.0);
    gl.uniform1f(this.injectLocs.u_surfaceBiomeMix, 0.0);
    gl.uniform1f(this.injectLocs.u_surfaceAllowRotate, 1.0);
    gl.uniform1f(this.injectLocs.u_surfaceScaleSpread, 1.0);
    gl.uniform1f(this.injectLocs.u_surfSlip, 0.5);
    gl.uniform1f(this.injectLocs.u_surfResist, 0.0);
    gl.uniform1f(this.injectLocs.u_surfChannel, 0.0);
    gl.uniform1f(this.injectLocs.u_surfRelief, 0.0);
    gl.uniform1f(this.injectLocs.u_pressure, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 5. progVort: workVelB -> workCurl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workCurl.fbo);
    gl.useProgram(this.progVort);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelB.tex);
    gl.uniform1i(this.vortLocs.u_vel, 0);
    gl.uniform2f(this.vortLocs.u_texel, texel, texel);
    gl.uniform4f(this.vortLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1f(this.vortLocs.u_maxVel, this.maxVel);
    gl.uniform1i(this.vortLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 6. progConfDiv (MRT): workVelB + workCurl -> mrtTmpDiv
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtTmpDiv);
    gl.useProgram(this.progConfDiv);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelB.tex);
    gl.uniform1i(this.confDivLocs.u_vel, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workCurl.tex);
    gl.uniform1i(this.confDivLocs.u_vort, 1);
    gl.uniform2f(this.confDivLocs.u_texel, texel, texel);
    gl.uniform4f(this.confDivLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1f(this.confDivLocs.u_vortAmp, 0.3);
    gl.uniform1f(this.confDivLocs.u_maxVel, this.maxVel);
    gl.uniform1i(this.confDivLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 7. progJacobi: workPressA + workDiv -> workPressB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPressB.fbo);
    gl.useProgram(this.progJacobi);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPressA.tex);
    gl.uniform1i(this.jacobiLocs.u_press, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workDiv.tex);
    gl.uniform1i(this.jacobiLocs.u_div, 1);
    gl.uniform2f(this.jacobiLocs.u_texel, texel, texel);
    gl.uniform4f(this.jacobiLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1f(this.jacobiLocs.u_maxVel, this.maxVel);
    gl.uniform1i(this.jacobiLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 8. progFlowEdge (MRT): workPigB + workVelTmp + workPressB -> mrtWorkA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkA);
    gl.useProgram(this.progFlowEdge);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigB.tex);
    gl.uniform1i(this.flowEdgeLocs.u_pigment, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelTmp.tex);
    gl.uniform1i(this.flowEdgeLocs.u_vel, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.workPressB.tex);
    gl.uniform1i(this.flowEdgeLocs.u_press, 2);
    gl.uniform2f(this.flowEdgeLocs.u_texel, texel, texel);
    gl.uniform4f(this.flowEdgeLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform2f(this.flowEdgeLocs.u_simOrigin, 0, 0);
    gl.uniform1f(this.flowEdgeLocs.u_wetness, 0.5);
    gl.uniform1f(this.flowEdgeLocs.u_streamFlow, 0.5);
    gl.uniform1f(this.flowEdgeLocs.u_bloom, 0.3);
    gl.uniform1f(this.flowEdgeLocs.u_edge, 0.3);
    gl.uniform1f(this.flowEdgeLocs.u_granulation, 0.2);
    gl.uniform1f(this.flowEdgeLocs.u_maxVel, this.maxVel);
    gl.uniform1f(this.flowEdgeLocs.u_dt, 1.0);
    gl.uniform1i(this.flowEdgeLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.uniform1i(this.flowEdgeLocs.u_alphaLock, 0);
    gl.uniform1i(this.flowEdgeLocs.u_physicalMix, 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.flowEdgeLocs.u_surfaceMap, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.flowEdgeLocs.u_poreMap, 4);
    gl.uniform1i(this.flowEdgeLocs.u_hasSurface, 0);
    gl.uniform1i(this.flowEdgeLocs.u_useHeightmap, 0);
    gl.uniform1i(this.flowEdgeLocs.u_heightSource, 0);
    gl.uniform1f(this.flowEdgeLocs.u_surfaceInvScale, 1.0 / 320.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfaceBiomeMix, 0.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfaceAllowRotate, 1.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfaceScaleSpread, 1.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfSlip, 0.5);
    gl.uniform1f(this.flowEdgeLocs.u_surfResist, 0.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfChannel, 0.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfRelief, 0.0);
    gl.uniform1f(this.flowEdgeLocs.u_surfAbsorb, 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 9. progDrySharpen (MRT): workPigA + workVelA -> mrtWorkB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkB);
    gl.useProgram(this.progDrySharpen);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigA.tex);
    gl.uniform1i(this.drySharpenLocs.u_pigment, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workVelA.tex);
    gl.uniform1i(this.drySharpenLocs.u_vel, 1);
    gl.uniform2f(this.drySharpenLocs.u_texel, texel, texel);
    gl.uniform4f(this.drySharpenLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1f(this.drySharpenLocs.u_edge, 0.3);
    gl.uniform1f(this.drySharpenLocs.u_wetness, 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 10. progUnpremult: workPigB -> workPigA
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
    gl.useProgram(this.progUnpremult);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPigB.tex);
    gl.uniform1i(this.unpremultLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Restore WebGL compositor state cleanly
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);

    this._pipelinesWarmed = true;
  }

  _allocTileGpu() {
    const pig = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, false);
    const vel = this._makeTexFBO(TILE_SIZE, TILE_SIZE, this.isFloatVel, false);
    if (!pig || !vel) {
      const gl = this.gl;
      if (pig) { gl.deleteFramebuffer(pig.fbo); gl.deleteTexture(pig.tex); }
      if (vel) { gl.deleteFramebuffer(vel.fbo); gl.deleteTexture(vel.tex); }
      return null;
    }
    return { pig, vel, tx: 0, ty: 0, wx: 0, wy: 0, dirty: false, minX: TILE_SIZE, minY: TILE_SIZE, maxX: 0, maxY: 0 };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    for (const o of [t.pig, t.vel]) {
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

  _acquireWetVelSlot() {
    if (this.wetPool.length > 0) return this.wetPool.pop();
    return this._makeTexFBO(TILE_SIZE, TILE_SIZE, this.isFloatVel, false);
  }

  _saveWetTile(proj, layer, tile, now) {
    const wKey = `${proj}:${layer}:${tile.tx},${tile.ty}`;
    let entry = this.wetCache.get(wKey);
    if (entry) {
      // Refresh LRU position
      this.wetCache.delete(wKey);
    } else {
      if (this.wetCache.size >= MAX_WET_CACHE) {
        const oldestKey = this.wetCache.keys().next().value;
        const oldest = this.wetCache.get(oldestKey);
        this.wetCache.delete(oldestKey);
        if (oldest && oldest.vel) this.wetPool.push(oldest.vel);
      }
      const slot = this._acquireWetVelSlot();
      if (!slot) return;
      entry = { vel: slot, updatedAt: now };
    }
    entry.updatedAt = now;
    this.wetCache.set(wKey, entry);

    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.vel.fbo);
    gl.useProgram(this.progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.vel.tex);
    gl.uniform1i(this.blitLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _clearWetCache() {
    const gl = this.gl;
    this.wetCache.forEach((entry) => {
      if (entry && entry.vel && gl) {
        gl.deleteFramebuffer(entry.vel.fbo);
        gl.deleteTexture(entry.vel.tex);
      }
    });
    this.wetCache.clear();
    for (let i = 0; i < this.wetPool.length; i++) {
      const o = this.wetPool[i];
      if (o && gl) {
        gl.deleteFramebuffer(o.fbo);
        gl.deleteTexture(o.tex);
      }
    }
    this.wetPool = [];
  }

  clearWetCacheForProject(projId) {
    if (!projId) return;
    const prefix = `${projId}:`;
    for (const [key, entry] of this.wetCache.entries()) {
      if (key.startsWith(prefix)) {
        this.wetCache.delete(key);
        if (entry && entry.vel) {
          this.wetPool.push(entry.vel);
        }
      }
    }
  }

  _srcPig() { return this.curWorkIdx === 0 ? this.workPigA : this.workPigB; }
  _dstPig() { return this.curWorkIdx === 0 ? this.workPigB : this.workPigA; }
  _srcVel() { return this.curWorkIdx === 0 ? this.workVelA : this.workVelB; }
  _dstVel() { return this.curWorkIdx === 0 ? this.workVelB : this.workVelA; }
  _dstMrt() { return this.curWorkIdx === 0 ? this.mrtWorkB : this.mrtWorkA; }
  _swapWork() { this.curWorkIdx = 1 - this.curWorkIdx; }

  uploadTipMaps(tipRgbaBytes, res = 64, tipVersion = null) {
    if (!this.ready || !this.tipTex) return;
    if (!tipRgbaBytes || res <= 0) {
      this.hasTip = false;
      this._uploadedTipVersion = tipVersion;
      return;
    }
    if (tipVersion !== null && this._uploadedTipVersion === tipVersion && this.hasTip) {
      return;
    }
    this._uploadedTipVersion = tipVersion;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (res !== this.tipRes) {
      this.tipRes = res;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, tipRgbaBytes);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, res, res, gl.RGBA, gl.UNSIGNED_BYTE, tipRgbaBytes);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.hasTip = true;
  }

  _ensureBackedUp(engine, chunk, cx, cy, wasEmptyOverride = undefined) {
    const id = `${cx},${cy}`;
    const touched = this.touchedChunks.get(id);
    const wasEmpty = wasEmptyOverride !== undefined
      ? wasEmptyOverride
      : (touched ? touched.wasEmpty : undefined);
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

    // Seed or restore decayed wet-on-wet velocity film
    const wKey = `${this.activeProj}:${layer}:${tx},${ty}`;
    const wetEntry = this.wetCache.get(wKey);
    if (wetEntry && this.strokeStartTime > 0 && wetEntry.updatedAt > 0) {
      const dtSec = Math.max(0, (this.strokeStartTime - wetEntry.updatedAt) * 0.001);
      const decay = Math.exp(-dtSec / this.dryHorizon);
      if (decay > 0.04) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.vel.fbo);
        gl.useProgram(this.progPrep);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, wetEntry.vel.tex);
        gl.uniform1i(this.prepLocs.u_vel, 0);
        gl.uniform1f(this.prepLocs.u_decay, decay);
        gl.uniform1i(this.prepLocs.u_isFloat, this.isFloatVel ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } else {
        const clearZ = this.isFloatVel ? 0.0 : (127.0 / 255.0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.vel.fbo);
        gl.clearColor(clearZ, clearZ, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    } else {
      const clearZ = this.isFloatVel ? 0.0 : (127.0 / 255.0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tile.vel.fbo);
      gl.clearColor(clearZ, clearZ, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Seed tile.pig directly from chunk GPU textures (zero readback)
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.pig.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

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

    this.activeTiles.set(key, tile);
    return tile;
  }

  _assembleWorkBox(engine, workX, workY, boxW, boxH) {
    const gl = this.gl;
    const tx0 = Math.floor(workX / TILE_SIZE);
    const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
    const ty0 = Math.floor(workY / TILE_SIZE);
    const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);

    const tiles = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const t = this._ensureTile(engine, tx, ty);
        if (t) tiles.push(t);
      }
    }
    if (tiles.length === 0) return tiles;

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

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const clearZ = this.isFloatVel ? 0.0 : (127.0 / 255.0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelA.fbo);
    gl.clearColor(clearZ, clearZ, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.rectLocs.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.pig.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.vel.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    return tiles;
  }

  _storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH, apron) {
    const gl = this.gl;
    const pigTex = this._srcPig().tex;
    const velTex = this._srcVel().tex;

    const innerX = workX + apron;
    const innerY = workY + apron;
    const innerW = Math.max(1, boxW - apron * 2);
    const innerH = Math.max(1, boxH - apron * 2);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Write updated workPig & workVel back into active sparse tiles inside interior box
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.uniform1i(this.rectLocs.u_tex, 0);

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
      if (lx0 < t.minX) t.minX = lx0;
      if (ly0 < t.minY) t.minY = ly0;
      if (lx0 + ow > t.maxX) t.maxX = lx0 + ow;
      if (ly0 + oh > t.maxY) t.maxY = ly0 + oh;

      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(lx0, ly0, ow, oh);
      gl.uniform4f(this.rectLocs.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.pig.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pigTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.vel.fbo);
      gl.bindTexture(gl.TEXTURE_2D, velTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 2. Blit workPig straight into chunk.gpuTextures[layer] on GPU (0 readback, 0 overlay seams)
    const layer = engine.activeLayer;
    const sCX = engine.isStatic ? 0 : Math.floor(innerX / engine.chunkSize);
    const eCX = engine.isStatic ? 0 : Math.floor((innerX + innerW - 1) / engine.chunkSize);
    const sCY = engine.isStatic ? 0 : Math.floor(innerY / engine.chunkSize);
    const eCY = engine.isStatic ? 0 : Math.floor((innerY + innerH - 1) / engine.chunkSize);

    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, innerX, innerY, innerW, innerH);
    gl.uniform4f(
      this.rectLocs.u_uvSubRect,
      apron / WORK_SIZE,
      apron / WORK_SIZE,
      innerW / WORK_SIZE,
      innerH / WORK_SIZE
    );
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pigTex);

    for (let cx = sCX; cx <= eCX; cx++) {
      for (let cy = sCY; cy <= eCY; cy++) {
        const chunk = engine._getChunk(cx, cy);
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

        // Re-bind pigTex on TEXTURE0 because _createOrUpdateTexture binds chunk.gpuTextures[layer]
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pigTex);

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

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  beginStroke(engine, _startPoint, wetnessNorm) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    this._releaseAllTiles();
    this.touchedChunks.clear();

    this.activeProj = engine.currentProjectId || 'default';
    this.activeLayer = engine.activeLayer;
    this.strokeStartTime = performance.now();
    this.dryHorizon = 3.0 + wetnessNorm * 18.0;
    this.batchActive = false;
    this.batchTiles = [];
    this.curWorkIdx = 0;
    this.active = true;
    this.gpuRenderer.airOverlay = null;
    return true;
  }

  beginStepBatch(engine, minX, minY, maxX, maxY) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost()) return;
    const apron = 8;
    const rawMinX = Math.floor(minX) - apron;
    const rawMinY = Math.floor(minY) - apron;
    const rawMaxX = Math.ceil(maxX) + apron;
    const rawMaxY = Math.ceil(maxY) + apron;
    const spanX = rawMaxX - rawMinX;
    const spanY = rawMaxY - rawMinY;
    const boxW = Math.min(WORK_SIZE, Math.max(16, spanX));
    const boxH = Math.min(WORK_SIZE, Math.max(16, spanY));
    const workX = spanX > WORK_SIZE ? Math.floor((rawMinX + rawMaxX - boxW) * 0.5) : rawMinX;
    const workY = spanY > WORK_SIZE ? Math.floor((rawMinY + rawMaxY - boxH) * 0.5) : rawMinY;

    this.batchWorkX = workX;
    this.batchWorkY = workY;
    this.batchBoxW = boxW;
    this.batchBoxH = boxH;
    this.batchApron = apron;
    this.batchTiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    this.batchActive = this.batchTiles.length > 0;
  }

  injectSegment(engine, from, to, radius, colorRgb, opacity, flow, params, timeSec, tipInfo = null) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost()) return;

    const tipPour = tipInfo ? tipInfo.tipPour : (params.tipPour ?? 1.0);
    const pad = Math.ceil(radius * (1.10 + params.bloom * 0.35 + tipPour * 0.22)) + 16;

    let standalone = false;
    let workX = this.batchWorkX;
    let workY = this.batchWorkY;
    let boxW = this.batchBoxW;
    let boxH = this.batchBoxH;
    let apron = this.batchApron;
    let tiles = this.batchTiles;

    if (!this.batchActive) {
      standalone = true;
      apron = 6;
      const rawMinX = Math.floor(Math.min(from.x, to.x) - pad) - apron;
      const rawMinY = Math.floor(Math.min(from.y, to.y) - pad) - apron;
      const rawMaxX = Math.ceil(Math.max(from.x, to.x) + pad) + apron;
      const rawMaxY = Math.ceil(Math.max(from.y, to.y) + pad) + apron;
      const spanX = rawMaxX - rawMinX;
      const spanY = rawMaxY - rawMinY;
      boxW = Math.min(WORK_SIZE, Math.max(16, spanX));
      boxH = Math.min(WORK_SIZE, Math.max(16, spanY));
      workX = spanX > WORK_SIZE ? Math.floor((rawMinX + rawMaxX - boxW) * 0.5) : rawMinX;
      workY = spanY > WORK_SIZE ? Math.floor((rawMinY + rawMaxY - boxH) * 0.5) : rawMinY;
      tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
      if (tiles.length === 0) return;
    }

    const gl = this.gl;
    const segLen = Math.hypot(to.x - from.x, to.y - from.y);
    const dirX = segLen > 0.0001 ? (to.x - from.x) / segLen : 1.0;
    const dirY = segLen > 0.0001 ? (to.y - from.y) / segLen : 0.0;
    const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;

    const hasTip = (this.hasTip && tipInfo && tipInfo.hasTip) ? 1 : 0;
    const cosR = tipInfo ? tipInfo.cosR : 1.0;
    const sinR = tipInfo ? tipInfo.sinR : 0.0;
    const isDab = tipInfo && tipInfo.isDab ? 1 : 0;

    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.bindVertexArray(this.gpuRenderer.vao);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstMrt());
    gl.useProgram(this.progInject);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._srcPig().tex);
    gl.uniform1i(this.injectLocs.u_pigment, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._srcVel().tex);
    gl.uniform1i(this.injectLocs.u_vel, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_tip, 2);

    gl.uniform2f(this.injectLocs.u_simOrigin, workX, workY);
    gl.uniform2f(this.injectLocs.u_from, from.x, from.y);
    gl.uniform2f(this.injectLocs.u_to, to.x, to.y);
    gl.uniform2f(this.injectLocs.u_dir, dirX, dirY);
    gl.uniform1f(this.injectLocs.u_radius, radius);
    gl.uniform3f(this.injectLocs.u_color, colorRgb.r / 255.0, colorRgb.g / 255.0, colorRgb.b / 255.0);
    gl.uniform1f(this.injectLocs.u_opacity, opacity);
    gl.uniform1f(this.injectLocs.u_flow, flow);
    gl.uniform1f(this.injectLocs.u_wetness, params.wetness);
    gl.uniform1f(this.injectLocs.u_streamFlow, params.streamFlow);
    gl.uniform1f(this.injectLocs.u_bloom, params.bloom);
    gl.uniform1f(this.injectLocs.u_edge, params.edge);
    gl.uniform1f(this.injectLocs.u_granulation, params.granulation);
    gl.uniform1f(this.injectLocs.u_time, timeSec);
    gl.uniform1f(this.injectLocs.u_segLen, segLen);
    gl.uniform1f(this.injectLocs.u_maxVel, this.maxVel);
    gl.uniform1i(this.injectLocs.u_isFloat, this.isFloatVel ? 1 : 0);
    gl.uniform1i(this.injectLocs.u_alphaLock, alphaLock);
    gl.uniform1i(this.injectLocs.u_hasTip, hasTip);
    gl.uniform1i(this.injectLocs.u_isDab, isDab);
    gl.uniform1f(this.injectLocs.u_rotCos, cosR);
    gl.uniform1f(this.injectLocs.u_rotSin, sinR);
    gl.uniform1f(this.injectLocs.u_tipPour, tipPour);
    gl.uniform1i(this.injectLocs.u_physicalMix, (engine.physicalColorMix !== false) ? 1 : 0);

    const texel = 1.0 / WORK_SIZE;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (boxW - 0.5) * texel);
    const maxV = Math.max(minV, (boxH - 0.5) * texel);
    const surfMgr = engine.surfaceManager;
    const surfU = surfMgr ? surfMgr.getShaderUniforms() : null;
    const surfTex = (surfU && surfU.active) ? surfMgr.ensureGpuTextures(gl) : { mapTex: null, poreTex: null };
    const hasSurf = !!(surfTex && surfTex.mapTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, hasSurf ? surfTex.mapTex : this.tipTex);
    gl.uniform1i(this.injectLocs.u_surfaceMap, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, (hasSurf && surfTex.poreTex) ? surfTex.poreTex : this.tipTex);
    gl.uniform1i(this.injectLocs.u_poreMap, 4);
    gl.uniform1i(this.injectLocs.u_hasSurface, hasSurf ? 1 : 0);
    gl.uniform1i(this.injectLocs.u_useHeightmap, params.useHeightmap ? 1 : 0);
    gl.uniform1i(this.injectLocs.u_heightSource, params.heightSource === 1 ? 1 : 0);
    gl.uniform2f(this.injectLocs.u_texel, texel, texel);
    gl.uniform4f(this.injectLocs.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1f(this.injectLocs.u_surfaceInvScale, surfU ? surfU.invScale : 1.0 / 320.0);
    gl.uniform1f(this.injectLocs.u_surfaceBiomeMix, surfU ? surfU.biomeMix : 0.88);
    gl.uniform1f(this.injectLocs.u_surfaceAllowRotate, surfU ? surfU.allowRotate : 1.0);
    gl.uniform1f(this.injectLocs.u_surfaceScaleSpread, surfU ? surfU.scaleSpread : 1.0);
    gl.uniform1f(this.injectLocs.u_surfSlip, surfU ? surfU.slip : 0.5);
    gl.uniform1f(this.injectLocs.u_surfResist, surfU ? surfU.resist : 0.0);
    gl.uniform1f(this.injectLocs.u_surfChannel, surfU ? surfU.channel : 0.0);
    gl.uniform1f(this.injectLocs.u_surfRelief, surfU ? surfU.relief : 0.0);
    gl.uniform1f(this.injectLocs.u_pressure, (tipInfo && tipInfo.pressure !== undefined) ? tipInfo.pressure : (params.pressure ?? 1.0));

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this._swapWork();

    if (standalone) {
      this._storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH, apron);
      this.gpuRenderer.requestRender();
    }
  }

  solveAndFlowStep(engine, minX, minY, maxX, maxY, params, dt = 1.0) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost()) return;

    let workX = this.batchWorkX;
    let workY = this.batchWorkY;
    let boxW = this.batchBoxW;
    let boxH = this.batchBoxH;
    let apron = this.batchApron;
    let tiles = this.batchTiles;

    if (!this.batchActive) {
      apron = 8;
      const rawMinX = Math.floor(minX) - apron;
      const rawMinY = Math.floor(minY) - apron;
      const rawMaxX = Math.ceil(maxX) + apron;
      const rawMaxY = Math.ceil(maxY) + apron;
      const spanX = rawMaxX - rawMinX;
      const spanY = rawMaxY - rawMinY;
      boxW = Math.min(WORK_SIZE, Math.max(16, spanX));
      boxH = Math.min(WORK_SIZE, Math.max(16, spanY));
      workX = spanX > WORK_SIZE ? Math.floor((rawMinX + rawMaxX - boxW) * 0.5) : rawMinX;
      workY = spanY > WORK_SIZE ? Math.floor((rawMinY + rawMaxY - boxH) * 0.5) : rawMinY;
      tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    }

    this.batchActive = false;
    this.batchTiles = [];
    if (!tiles || tiles.length === 0) return;

    const gl = this.gl;
    const texel = 1.0 / WORK_SIZE;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (boxW - 0.5) * texel);
    const maxV = Math.max(minV, (boxH - 0.5) * texel);
    const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
    const alphaLock = (layerSet && layerSet.alphaLock) ? 1 : 0;

    if (params.streamFlow > 0.02 || params.wetness > 0.15) {
      gl.disable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, boxW, boxH);
      gl.bindVertexArray(this.gpuRenderer.vao);
      gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

      // 1. Vorticity -> workCurl
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workCurl.fbo);
      gl.useProgram(this.progVort);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcVel().tex);
      gl.uniform1i(this.vortLocs.u_vel, 0);
      gl.uniform2f(this.vortLocs.u_texel, texel, texel);
      gl.uniform4f(this.vortLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform1f(this.vortLocs.u_maxVel, this.maxVel);
      gl.uniform1i(this.vortLocs.u_isFloat, this.isFloatVel ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 2. Vorticity confinement + divergence -> (workVelTmp, workDiv)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtTmpDiv);
      gl.useProgram(this.progConfDiv);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcVel().tex);
      gl.uniform1i(this.confDivLocs.u_vel, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workCurl.tex);
      gl.uniform1i(this.confDivLocs.u_vort, 1);
      gl.uniform2f(this.confDivLocs.u_texel, texel, texel);
      gl.uniform4f(this.confDivLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform1f(this.confDivLocs.u_vortAmp, 0.12 + 0.52 * params.streamFlow);
      gl.uniform1f(this.confDivLocs.u_maxVel, this.maxVel);
      gl.uniform1i(this.confDivLocs.u_isFloat, this.isFloatVel ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 3. Clear workPressA inside scissor + 4 Jacobi iterations
      const clearP = this.isFloatVel ? 0.0 : (127.0 / 255.0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPressA.fbo);
      gl.clearColor(clearP, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.progJacobi);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workDiv.tex);
      gl.uniform1i(this.jacobiLocs.u_div, 1);
      gl.uniform2f(this.jacobiLocs.u_texel, texel, texel);
      gl.uniform4f(this.jacobiLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform1f(this.jacobiLocs.u_maxVel, this.maxVel);
      gl.uniform1i(this.jacobiLocs.u_isFloat, this.isFloatVel ? 1 : 0);

      let srcP = this.workPressA;
      let dstP = this.workPressB;
      for (let it = 0; it < 4; it++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstP.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcP.tex);
        gl.uniform1i(this.jacobiLocs.u_press, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const tmp = srcP;
        srcP = dstP;
        dstP = tmp;
      }

      // 4. Project + Advect Pigment & Capillary Bloom -> _dstMrt() (zero copy pass needed!)
      gl.scissor(1, 1, Math.max(1, boxW - 2), Math.max(1, boxH - 2));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstMrt());
      gl.useProgram(this.progFlowEdge);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcPig().tex);
      gl.uniform1i(this.flowEdgeLocs.u_pigment, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workVelTmp.tex);
      gl.uniform1i(this.flowEdgeLocs.u_vel, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, srcP.tex);
      gl.uniform1i(this.flowEdgeLocs.u_press, 2);

      gl.uniform2f(this.flowEdgeLocs.u_texel, texel, texel);
      gl.uniform4f(this.flowEdgeLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform2f(this.flowEdgeLocs.u_simOrigin, workX, workY);
      gl.uniform1f(this.flowEdgeLocs.u_wetness, params.wetness);
      gl.uniform1f(this.flowEdgeLocs.u_streamFlow, params.streamFlow);
      gl.uniform1f(this.flowEdgeLocs.u_bloom, params.bloom);
      gl.uniform1f(this.flowEdgeLocs.u_edge, params.edge);
      gl.uniform1f(this.flowEdgeLocs.u_granulation, params.granulation);
      gl.uniform1f(this.flowEdgeLocs.u_maxVel, this.maxVel);
      gl.uniform1f(this.flowEdgeLocs.u_dt, dt);
      gl.uniform1i(this.flowEdgeLocs.u_isFloat, this.isFloatVel ? 1 : 0);
      gl.uniform1i(this.flowEdgeLocs.u_alphaLock, alphaLock);
      gl.uniform1i(this.flowEdgeLocs.u_physicalMix, (engine.physicalColorMix !== false) ? 1 : 0);

      const surfMgr = engine.surfaceManager;
      const surfU = surfMgr ? surfMgr.getShaderUniforms() : null;
      const surfTex = (surfU && surfU.active) ? surfMgr.ensureGpuTextures(gl) : { mapTex: null, poreTex: null };
      const hasSurf = !!(surfTex && surfTex.mapTex);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, hasSurf ? surfTex.mapTex : this.tipTex);
      gl.uniform1i(this.flowEdgeLocs.u_surfaceMap, 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, (hasSurf && surfTex.poreTex) ? surfTex.poreTex : this.tipTex);
      gl.uniform1i(this.flowEdgeLocs.u_poreMap, 4);
      gl.uniform1i(this.flowEdgeLocs.u_hasSurface, hasSurf ? 1 : 0);
      gl.uniform1i(this.flowEdgeLocs.u_useHeightmap, params.useHeightmap ? 1 : 0);
      gl.uniform1i(this.flowEdgeLocs.u_heightSource, params.heightSource === 1 ? 1 : 0);
      gl.uniform1f(this.flowEdgeLocs.u_surfaceInvScale, surfU ? surfU.invScale : 1.0 / 320.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfaceBiomeMix, surfU ? surfU.biomeMix : 0.88);
      gl.uniform1f(this.flowEdgeLocs.u_surfaceAllowRotate, surfU ? surfU.allowRotate : 1.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfaceScaleSpread, surfU ? surfU.scaleSpread : 1.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfSlip, surfU ? surfU.slip : 0.5);
      gl.uniform1f(this.flowEdgeLocs.u_surfResist, surfU ? surfU.resist : 0.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfChannel, surfU ? surfU.channel : 0.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfRelief, surfU ? surfU.relief : 0.0);
      gl.uniform1f(this.flowEdgeLocs.u_surfAbsorb, surfU ? surfU.absorb : 0.5);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._swapWork();
    }

    this._storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH, Math.min(apron, 2));
    this.gpuRenderer.requestRender();
  }

  _commitTilesToChunks(engine, params) {
    if (this.activeTiles.size === 0) return;

    const gl = this.gl;
    const layer = engine.activeLayer;
    const layerSet = engine.layerSettings ? engine.layerSettings[layer] : null;
    const alphaLock = !!(layerSet && layerSet.alphaLock);
    const now = performance.now();

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    const texel = 1.0 / WORK_SIZE;
    const dirtyTiles = [];
    this.activeTiles.forEach((t) => {
      if (t.dirty && t.maxX > t.minX && t.maxY > t.minY) {
        dirtyTiles.push(t);
      }
    });

    for (let i = 0; i < dirtyTiles.length; i++) {
      const t = dirtyTiles[i];
      const rx0 = Math.max(0, t.minX | 0);
      const ry0 = Math.max(0, t.minY | 0);
      const rx1 = Math.min(TILE_SIZE, Math.ceil(t.maxX));
      const ry1 = Math.min(TILE_SIZE, Math.ceil(t.maxY));
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      if (rw <= 0 || rh <= 0) continue;

      // Assemble tile + 1px neighbor apron for seamless DRY_SHARPEN_FS edge polish
      const workX = t.wx + rx0 - 1;
      const workY = t.wy + ry0 - 1;
      const boxW = rw + 2;
      const boxH = rh + 2;

      const tx0 = Math.floor(workX / TILE_SIZE);
      const tx1 = Math.floor((workX + boxW - 1) / TILE_SIZE);
      const ty0 = Math.floor(workY / TILE_SIZE);
      const ty1 = Math.floor((workY + boxH - 1) / TILE_SIZE);

      gl.disable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, boxW, boxH);
      gl.bindVertexArray(this.gpuRenderer.vao);
      gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const clearZ = this.isFloatVel ? 0.0 : (127.0 / 255.0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelA.fbo);
      gl.clearColor(clearZ, clearZ, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this.progRectMap);
      gl.uniform4f(this.rectLocs.u_dstRect, workX, workY, WORK_SIZE, WORK_SIZE);
      gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
      gl.uniform1i(this.rectLocs.u_tex, 0);

      for (let nx = tx0; nx <= tx1; nx++) {
        for (let ny = ty0; ny <= ty1; ny++) {
          const nt = this.activeTiles.get(`${nx},${ny}`);
          if (!nt) continue;
          gl.uniform4f(this.rectLocs.u_srcRect, nt.wx, nt.wy, TILE_SIZE, TILE_SIZE);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, nt.pig.tex);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.workVelA.fbo);
          gl.bindTexture(gl.TEXTURE_2D, nt.vel.tex);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }

      // Run DRY_SHARPEN_FS inside [1, 1, rw, rh] -> mrtWorkB (workPigB, workVelB)
      gl.scissor(1, 1, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkB);
      gl.useProgram(this.progDrySharpen);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.workPigA.tex);
      gl.uniform1i(this.drySharpenLocs.u_pigment, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workVelA.tex);
      gl.uniform1i(this.drySharpenLocs.u_vel, 1);
      gl.uniform2f(this.drySharpenLocs.u_texel, texel, texel);
      gl.uniform4f(this.drySharpenLocs.u_uvClamp, 0.5 * texel, 0.5 * texel, (boxW - 0.5) * texel, (boxH - 0.5) * texel);
      gl.uniform1f(this.drySharpenLocs.u_edge, params ? params.edge : 0.30);
      gl.uniform1f(this.drySharpenLocs.u_wetness, params ? params.wetness : 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Update tile.vel from workVelB and snapshot into wetCache for next stroke's wet-on-wet!
      gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
      gl.scissor(rx0, ry0, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.vel.fbo);
      gl.useProgram(this.progRectMap);
      gl.uniform4f(this.rectLocs.u_srcRect, workX, workY, WORK_SIZE, WORK_SIZE);
      gl.uniform4f(this.rectLocs.u_dstRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);
      gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
      gl.uniform1i(this.rectLocs.u_tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.workVelB.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._saveWetTile(this.activeProj, layer, t, now);

      // Unpremultiply sharpened pigment 1:1 into workPigA at [1, 1, rw, rh]
      gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
      gl.scissor(1, 1, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPigA.fbo);
      gl.useProgram(this.progUnpremult);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.workPigB.tex);
      gl.uniform1i(this.unpremultLocs.u_tex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const byteLen = rw * rh * 4;
      const view = this._readBuf.subarray(0, byteLen);
      gl.readPixels(1, 1, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view);

      const imgData = new ImageData(new Uint8ClampedArray(view), rw, rh);
      this._commitCtx.putImageData(imgData, 0, 0);

      const worldMinX = t.wx + rx0;
      const worldMinY = t.wy + ry0;
      engine.strokeMinX = Math.min(engine.strokeMinX ?? Infinity, worldMinX);
      engine.strokeMaxX = Math.max(engine.strokeMaxX ?? -Infinity, worldMinX + rw);
      engine.strokeMinY = Math.min(engine.strokeMinY ?? Infinity, worldMinY);
      engine.strokeMaxY = Math.max(engine.strokeMaxY ?? -Infinity, worldMinY + rh);

      // Blit final sharpened pigment to chunk.gpuTextures[layer] on GPU & update Canvas2D chunk once
      const sCX = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
      const eCX = engine.isStatic ? 0 : Math.floor((worldMinX + rw - 1) / engine.chunkSize);
      const sCY = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
      const eCY = engine.isStatic ? 0 : Math.floor((worldMinY + rh - 1) / engine.chunkSize);

      for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
          const chunk = engine._getChunk(cx, cy);
          if (!chunk) continue;
          this._ensureBackedUp(engine, chunk, cx, cy);

          const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
          const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
          const ox = Math.max(worldMinX, lx);
          const oy = Math.max(worldMinY, ly);
          const ox2 = Math.min(worldMinX + rw, lx + chunk.width);
          const oy2 = Math.min(worldMinY + rh, ly + chunk.height);
          const ow = ox2 - ox;
          const oh = oy2 - oy;
          if (ow <= 0 || oh <= 0) continue;

          // Sync live GPU chunk texture with sharpened edge finish
          if (chunk.gpuTextures && chunk.gpuTextures[layer]) {
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
            if (sw > 0 && sh > 0) {
              const uvX = (1 + (ox - worldMinX)) * texel;
              const uvY = (1 + (oy - worldMinY)) * texel;
              const uvW = ow * texel;
              const uvH = oh * texel;
              gl.useProgram(this.progRectMap);
              gl.uniform4f(this.rectLocs.u_srcRect, ox, oy, ow, oh);
              gl.uniform4f(this.rectLocs.u_dstRect, lx, ly, chunk.width, chunk.height);
              gl.uniform4f(this.rectLocs.u_uvSubRect, uvX, uvY, uvW, uvH);
              gl.uniform1i(this.rectLocs.u_tex, 0);
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, this.workPigB.tex);

              gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, chunk.gpuTextures[layer], 0);
              gl.viewport(0, 0, texW, texH);
              gl.enable(gl.SCISSOR_TEST);
              gl.scissor(sx, sy, sw, sh);
              gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
          }

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
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chunkBlitFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  endStroke(engine, params) {
    if (!this.ready || !this.active) return;

    this._commitTilesToChunks(engine, params);
    this._releaseAllTiles();
    this.touchedChunks.clear();

    this.active = false;
    this.batchActive = false;
    this.batchTiles = [];
    this.gpuRenderer.airOverlay = null;
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
    this.batchActive = false;
    this.batchTiles = [];
    if (this.gl) {
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.airOverlay = null;
      this.gpuRenderer.requestRender();
    }
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    this._releaseAllTiles();
    for (let i = 0; i < this.tilePool.length; i++) {
      this._destroyTileGpu(this.tilePool[i]);
    }
    this.tilePool = [];
    this._clearWetCache();
    this.touchedChunks.clear();

    const delTexFbo = (o) => {
      if (!o) return;
      if (o.fbo) gl.deleteFramebuffer(o.fbo);
      if (o.tex) gl.deleteTexture(o.tex);
    };
    [
      this.workVelA, this.workVelB, this.workVelTmp, this.workPigA, this.workPigB,
      this.workDiv, this.workPressA, this.workPressB, this.workCurl
    ].forEach(delTexFbo);
    if (this.tipTex) {
      gl.deleteTexture(this.tipTex);
      this.tipTex = null;
    }
    [this.mrtWorkA, this.mrtWorkB, this.mrtTmpDiv, this.chunkBlitFbo].forEach(f => {
      if (f) gl.deleteFramebuffer(f);
    });
    [
      this.progRectMap, this.progBlit, this.progPrep, this.progInject, this.progVort,
      this.progConfDiv, this.progJacobi, this.progFlowEdge, this.progDrySharpen, this.progUnpremult
    ].forEach(p => {
      if (p) gl.deleteProgram(p);
    });
    this._commitCanvas = null;
    this._commitCtx = null;
    this._readBuf = null;
    this.ready = false;
    this.active = false;
    this._pipelinesWarmed = false;
  }
}
