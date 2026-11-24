/**
 * Zero-Overlay, Zero-Readback WebGL2 GPU Fluid & Tip-Guided Impasto Paint Engine
 * Architecture:
 * - No 1024x1024 sliding window (eliminates all mid-stroke recentering / readPixels baking stalls).
 * - No gpuRenderer.fluidOverlay or u_excludeActive cutout (eliminates all white GPU seams).
 * - Sparse 256x256 pooled GPU tiles (paint RGBA8, state RGBA16F) seeded lazily from chunk.gpuTextures[layer].
 * - 1x1 GPU carried-color pickup shader replaces CPU Canvas2D ensureTile/getImageData stalls completely.
 * - Pre-allocated 1024x1024 work FBOs scissor strictly to active move bbox (up to 14x fewer shaded pixels),
 *   run swept bristle advection + curl streamers + 3x3 Sobel Blinn-Phong impasto lighting,
 *   store tiles back, and blit lit output straight into chunk.gpuTextures[layer] on GPU.
 * - Canvas2D chunk synchronization runs once on endStroke() with full Undo & Selection fidelity.
 */

import { backupChunkLayer } from '../engine/backupPool.js';
import { GLSL_RYB_MIX } from '../colorUtils.js';
import { GLSL_SURFACE_BIOME_SAMPLER } from '../engine/canvasSurfaceGpu.js';

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

// 1x1 GPU Pigment Pickup + Brush Replenish Shader (replaces CPU Canvas2D tile readback!)
const FLUID_PICKUP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_prevCarried;
uniform sampler2D u_paint;
uniform sampler2D u_state;
uniform vec2 u_workOrigin;
uniform vec2 u_workSize;
uniform vec4 u_uvClamp;
uniform vec2 u_to;
uniform float u_radius;
uniform float u_prevDistTotal;
uniform float u_coverWindow;
uniform float u_pickupRatio;
uniform float u_retentionRatio;
uniform vec3 u_stepColor;
uniform int u_isFirst;
uniform int u_physicalMix;

${GLSL_RYB_MIX}

out vec4 outCarried;

void main() {
  vec3 carried = (u_isFirst == 1) ? u_stepColor : texture(u_prevCarried, vec2(0.5)).rgb;

  if (u_pickupRatio > 0.005) {
    float pStep = max(4.0, u_radius * 0.40);
    vec3 pickPR = vec3(0.0);
    float pickW = 0.0;

    for (int iy = -1; iy <= 1; iy++) {
      for (int ix = -1; ix <= 1; ix++) {
        vec2 wp = u_to + vec2(float(ix), float(iy)) * pStep;
        vec2 wUv = clamp((wp - u_workOrigin) / u_workSize, u_uvClamp.xy, u_uvClamp.zw);
        vec4 st = texture(u_state, wUv);
        // Ignore recently-laid paint in same segment pass
        if (u_prevDistTotal - st.b >= u_coverWindow * 0.65) {
          vec4 p = texture(u_paint, wUv);
          if (p.a > 0.06) {
            if (u_physicalMix == 1) {
              vec3 straightCol = clamp(p.rgb / p.a, 0.0, 1.0);
              pickPR += rgbToRyb01(straightCol) * p.a;
            } else {
              pickPR += p.rgb;
            }
            pickW += p.a;
          }
        }
      }
    }

    float mixPickup = u_pickupRatio * (1.0 - u_retentionRatio * 0.72) * 0.42;
    if (pickW > 0.05 && mixPickup > 0.004) {
      float sampleRate = min(0.65, mixPickup);
      vec3 pickedCol = clamp(pickPR / pickW, 0.0, 1.0);
      if (u_physicalMix == 1) {
        pickedCol = rybToRgb01(pickedCol);
      }
      carried = mixPaintCol(carried, pickedCol, sampleRate, u_physicalMix);
    }

    float replenishRate = 0.08 + u_retentionRatio * 0.55;
    carried = mixPaintCol(carried, u_stepColor, replenishRate, u_physicalMix);
  } else {
    carried = u_stepColor;
  }

  outCarried = vec4(clamp(carried, 0.0, 1.0), 1.0);
}
`;

// Unified Swept Tip-Guided Self-Advection + Continuous Filament Bristle Injection (1:1 full resolution)
const FLUID_INJECT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_paint;
uniform sampler2D u_state;
uniform sampler2D u_tip;
uniform sampler2D u_carried;

uniform vec2 u_simOrigin;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;

uniform vec2 u_from;
uniform vec2 u_dir;
uniform vec2 u_prevDir;
uniform float u_safeDist;
uniform float u_prevDistTotal;
uniform float u_coverWindow;
uniform float u_radius;
uniform float u_rotCos;
uniform float u_rotSin;
uniform float u_time;
uniform float u_curlFreq;
uniform int u_hasCurl;

uniform float u_dragAmp;
uniform float u_swirlAmp;
uniform float u_curlAmp;
uniform float u_lagDistBase;
uniform float u_advMixBase;
uniform float u_trailFeatherInv;

uniform float u_brFreq;
uniform float u_bristleContrast;
uniform float u_fluidity;
uniform float u_vortex;
uniform float u_turb;
uniform float u_depthScale;
uniform float u_paintSupply;
uniform float u_supplyThreshold;
uniform float u_strokeOpacity;
uniform float u_recolorRateBase;
uniform int u_nSteps;
uniform int u_alphaLock;
uniform int u_physicalMix;

uniform sampler2D u_surfaceMap;
uniform int u_hasSurface;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_surfSlip;
uniform float u_surfResist;
uniform float u_surfChannel;
uniform float u_surfRelief;
uniform float u_pressure;
uniform float u_heightShield;
uniform float u_speedHeightMod;

${GLSL_RYB_MIX}
${GLSL_SURFACE_BIOME_SAMPLER}

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outState;

void main() {
  vec4 srcP = texture(u_paint, v_uv);
  vec4 srcS = texture(u_state, v_uv);

  vec2 worldPos = u_simOrigin + gl_FragCoord.xy;
  vec2 ap = worldPos - u_from;
  float proj = dot(ap, u_dir);
  float tSeg = clamp(proj / u_safeDist, 0.0, 1.0);

  vec2 closest = u_from + u_dir * (u_safeDist * tSeg);
  vec2 rVec = worldPos - closest;
  float d2 = dot(rVec, rVec);
  float reachR = u_radius * 1.04;
  float reachR2 = reachR * reachR;

  if (d2 >= reachR2) {
    outPaint = srcP;
    outState = srcS;
    return;
  }

  vec2 sDir = mix(u_prevDir, u_dir, tSeg);
  float sdLen = length(sDir);
  sDir = sdLen > 0.0001 ? (sDir / sdLen) : u_dir;
  vec2 sPerp = vec2(-sDir.y, sDir.x);

  float invRadius = 1.0 / u_radius;
  float sMin = max(0.0, proj - reachR);
  float sMax = min(u_safeDist, proj + reachR);
  float sSpan = max(0.0, sMax - sMin);
  int nSteps = max(1, u_nSteps);
  float sStep = sSpan / float(nSteps);

  vec2 dtx0 = worldPos - (u_from + u_dir * sMin);
  vec2 uv0 = vec2(
    ((dtx0.x * u_rotCos - dtx0.y * u_rotSin) * invRadius + 1.0) * 0.5,
    ((dtx0.x * u_rotSin + dtx0.y * u_rotCos) * invRadius + 1.0) * 0.5
  );
  vec2 stepUv = vec2(
    -(u_dir.x * u_rotCos - u_dir.y * u_rotSin) * invRadius * 0.5 * sStep,
    -(u_dir.x * u_rotSin + u_dir.y * u_rotCos) * invRadius * 0.5 * sStep
  );

  float maxTipA = 0.0;
  float maxTipBump = 0.0;
  vec2 curUv = uv0;
  for (int k = 0; k <= 14; k++) {
    if (k > nSteps) break;
    if (curUv.x >= 0.0 && curUv.x <= 1.0 && curUv.y >= 0.0 && curUv.y <= 1.0) {
      vec2 tipSample = texture(u_tip, curUv).rg;
      if (tipSample.r > 0.01) {
        maxTipA = max(maxTipA, tipSample.r);
        maxTipBump = max(maxTipBump, tipSample.g);
      }
    }
    curUv += stepUv;
  }

  if (maxTipA <= 0.008 && srcP.a <= 0.002) {
    outPaint = vec4(0.0);
    outState = vec4(0.0, srcS.g, srcS.b, 0.0);
    return;
  }

  float wNorm = 1.0 - d2 / reachR2;
  float w = wNorm * wNorm;
  float invR = d2 > 0.25 ? inversesqrt(d2) : 0.0;

  float curlVx = 0.0;
  float curlVy = 0.0;
  if (u_hasCurl == 1) {
    vec2 f = worldPos * u_curlFreq;
    float p1 = f.x + u_time;
    float q1 = f.y - 0.7 * u_time;
    float p2 = 2.1 * f.x - 1.3 * u_time;
    float q2 = 1.9 * f.y + 0.9 * u_time;
    curlVx = -sin(p1) * sin(q1) + 0.95 * sin(p2) * cos(q2);
    curlVy = -(cos(p1) * cos(q1) + 1.05 * cos(p2) * sin(q2));
  }

  vec4 surf = (u_hasSurface == 1)
    ? sampleSurfaceMapBiome(u_surfaceMap, worldPos, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread)
    : vec4(0.5, 0.5, 0.5, 0.0);
  float sHeight = surf.r;
  vec2 sSlope = (surf.gb - 0.5) * 2.0;
  float sCavity = surf.a;
  vec2 sTangent = vec2(-sSlope.y, sSlope.x);

  float slipVelMult = (u_hasSurface == 1) ? mix(0.60, 1.85, u_surfSlip) : 1.0;
  float slipAdvMult = (u_hasSurface == 1) ? mix(0.68, 1.45, u_surfSlip) : 1.0;
  float tanSign = (dot(sTangent, sDir) >= 0.0) ? 1.0 : -1.0;
  vec2 grainPush = (u_hasSurface == 1)
    ? (sTangent * (tanSign * u_surfChannel * 1.55) - sSlope * (u_surfChannel * 0.80)) * (0.30 + 0.70 * u_fluidity) * w
    : vec2(0.0);

  float trailFade = proj >= 0.0 ? 1.0 : max(0.0, 1.0 + proj * u_trailFeatherInv);
  float activeTipDrive = 0.25 + 0.75 * maxTipA;
  vec2 vel = sDir * (u_dragAmp * activeTipDrive * slipVelMult)
           + vec2(-rVec.y, rVec.x) * (invR * u_swirlAmp * w * mix(0.75, 1.35, u_surfSlip))
           + vec2(curlVx, curlVy) * (u_curlAmp * w)
           + grainPush;
  float vLen = length(vel);
  if (vLen > 4.5) vel *= (4.5 / vLen);

  float m = clamp(u_advMixBase * slipAdvMult, 0.0, 0.85) * w * trailFade;
  vec4 wetP = srcP;
  float wetH = srcS.r;

  if (m > 0.005) {
    vec2 uv1 = clamp(v_uv - vel * w * u_texel, u_uvClamp.xy, u_uvClamp.zw);
    vec2 uv2 = clamp(v_uv - sDir * (u_lagDistBase * slipVelMult * w) * u_texel, u_uvClamp.xy, u_uvClamp.zw);
    vec4 advP = mixPremulPaint(texture(u_paint, uv1), texture(u_paint, uv2), 0.36, u_physicalMix);
    float advH = texture(u_state, uv1).r * 0.64 + texture(u_state, uv2).r * 0.36;
    wetP = mixPremulPaint(srcP, advP, m, u_physicalMix);
    wetH = mix(srcS.r, advH, m);
  }

  float wetA = clamp(wetP.a, 0.0, 1.0);
  vec3 wetCol = wetA > 0.002 ? clamp(wetP.rgb / wetA, 0.0, 1.0) : vec3(0.0);
  float nextDist = srcS.b;
  float nextCov = srcS.g;

  if (maxTipA > 0.008) {
    vec3 paintColor = texture(u_carried, vec2(0.5)).rgb;
    float crossNorm = (rVec.x * sPerp.x + rVec.y * sPerp.y) * invRadius;
    float phaseWarp = u_vortex * (0.75 + u_turb * 0.85) * (curlVx * 3.6 + curlVy * 1.9);
    float ridgePhase = crossNorm * u_brFreq + phaseWarp;
    float wave = 0.54 + 0.30 * sin(ridgePhase) + 0.16 * sin(ridgePhase * 2.13 + phaseWarp * 0.6);

    float ridgePronounce = (0.10 + 0.90 * u_bristleContrast) * (0.24 + 0.76 * maxTipBump) * (0.40 + 0.60 * (1.0 - u_fluidity * 0.50));
    float ridgeFactor = 1.0 - ridgePronounce * (1.0 - wave);

    float strandCoverage = maxTipA;
    if (u_paintSupply < 0.99) {
      float supplySignal = wave * (0.66 + 0.34 * maxTipBump) * min(1.0, maxTipA * 1.35);
      float softBand = 0.11 + 0.11 * (1.0 - maxTipBump);
      float smoothStrand = clamp((supplySignal - u_supplyThreshold) / softBand, 0.0, 1.0);
      smoothStrand = smoothStrand * smoothStrand * (3.0 - 2.0 * smoothStrand);
      strandCoverage = maxTipA * smoothStrand;
    }

    float localDist = u_prevDistTotal + u_safeDist * tSeg;
    float prevCov = (localDist - srcS.b >= 0.0 && localDist - srcS.b < u_coverWindow) ? srcS.g : 0.0;
    float hShield = clamp(1.0 - (wetH / max(2.5, 22.0 - 16.0 * u_heightShield)) * (0.20 + 1.05 * u_heightShield), 0.0, 1.0);
    float effSurfMod = hShield * u_speedHeightMod;

    if (u_hasSurface == 1 && u_surfResist > 0.01) {
      float workEffort = clamp(u_pressure * 0.50 + u_paintSupply * 0.32 + prevCov * 0.38 + wetA * 0.34, 0.0, 1.35);
      float valleyFloor = clamp((1.0 - workEffort * 0.78) * u_surfResist * 0.88, 0.0, 0.82);
      float toothSignal = clamp(sHeight * (1.0 - 0.18 * u_surfResist) + 0.16 * u_surfRelief * (sHeight - 0.5) - sCavity * 0.24 * u_surfResist, 0.0, 1.0);
      float valleyPass = smoothstep(valleyFloor - 0.15, valleyFloor + 0.17, toothSignal);
      strandCoverage *= mix(1.0, valleyPass, clamp(u_surfResist * effSurfMod, 0.0, 1.0));
    }

    float targetBrushAlpha = min(1.0, strandCoverage * u_strokeOpacity);
    float stepA = (targetBrushAlpha > prevCov && prevCov < 0.99)
      ? (targetBrushAlpha - prevCov) / (1.0 - prevCov)
      : 0.0;

    if (targetBrushAlpha > 0.004) {
      float outA = min(1.0, wetA + stepA * (1.0 - wetA));
      if (outA < targetBrushAlpha) outA = targetBrushAlpha;

      float toneShift = (wave - 0.54) * (4.0 + 14.0 * maxTipBump) * (0.2 + 1.25 * u_bristleContrast) / 255.0;
      if (u_hasSurface == 1) {
        toneShift += (sHeight - 0.5) * u_surfRelief * effSurfMod * (10.0 / 255.0);
      }
      vec3 fCol = clamp(paintColor + vec3(toneShift), 0.0, 1.0);

      if (u_alphaLock == 1) {
        if (srcP.a > 0.004) {
          float colorFeed = max(stepA, strandCoverage * u_recolorRateBase * (0.35 + 0.65 * maxTipBump) * trailFade);
          float blendAmt = min(1.0, colorFeed / max(0.05, outA));
          wetCol = mixPaintCol(wetCol, fCol, blendAmt, u_physicalMix);
          wetA = srcP.a;
        } else {
          wetA = 0.0;
        }
      } else if (wetA <= 0.01) {
        wetCol = fCol;
        wetA = outA;
      } else {
        float colorFeed = max(stepA, strandCoverage * u_recolorRateBase * (0.35 + 0.65 * maxTipBump) * trailFade);
        float blendAmt = min(1.0, colorFeed / max(0.05, outA));
        wetCol = mixPaintCol(wetCol, fCol, blendAmt, u_physicalMix);
        wetA = outA;
      }

      if (u_depthScale > 0.01 && (u_alphaLock == 0 || srcP.a > 0.004)) {
        float supplyH = 0.22 + 0.78 * u_paintSupply;
        float toothRelief = (u_hasSurface == 1) ? mix(1.0, 0.72 + 0.56 * sHeight, clamp(u_surfRelief * effSurfMod, 0.0, 1.0)) : 1.0;
        float targetH = strandCoverage * (0.14 + 0.86 * maxTipBump) * (0.30 + 0.70 * ridgeFactor) * toothRelief * u_depthScale * supplyH;
        wetH = min(52.0, max(wetH, targetH));
      }

      nextDist = localDist;
      nextCov = max(targetBrushAlpha, prevCov);
    } else {
      nextDist = srcS.b;
      nextCov = prevCov;
    }
  }

  if (u_alphaLock == 1) {
    wetA = srcP.a;
  }

  if (wetA < 0.002) {
    outPaint = vec4(0.0);
    outState = vec4(0.0, nextCov, nextDist, 0.0);
  } else {
    outPaint = vec4(clamp(wetCol * wetA, 0.0, wetA), wetA);
    outState = vec4(wetH, nextCov, nextDist, 1.0);
  }
}
`;

// Batched Air-Paint curl streamer wisps rendered in 1 pass directly onto paint & state FBOs
const FLUID_STREAMER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_paint;
uniform sampler2D u_state;
uniform vec2 u_simOrigin;
uniform int u_segCount;
uniform vec4 u_segPos[24];
uniform vec4 u_segCol[24];
uniform vec4 u_segMeta[24];
uniform int u_alphaLock;
uniform int u_physicalMix;

${GLSL_RYB_MIX}

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outState;

void main() {
  vec4 srcP = texture(u_paint, v_uv);
  vec4 srcS = texture(u_state, v_uv);
  vec2 wp = u_simOrigin + gl_FragCoord.xy;

  float a = srcP.a;
  vec3 col = a > 0.002 ? (srcP.rgb / a) : vec3(0.0);
  float h = srcS.r;

  for (int i = 0; i < 24; i++) {
    if (i >= u_segCount) break;
    vec4 sp = u_segPos[i];
    vec4 sc = u_segCol[i];
    vec4 sm = u_segMeta[i];

    float dotR = clamp(sm.x * 0.65, 0.7, 2.8);
    vec2 seg = sp.zw - sp.xy;
    float segLen2 = dot(seg, seg);
    float t = segLen2 > 0.0001 ? clamp(dot(wp - sp.xy, seg) / segLen2, 0.0, 1.0) : 0.0;
    vec2 closest = sp.xy + seg * t;
    float d = length(wp - closest);
    if (d >= dotR) continue;

    float falloff = 1.0 - d / dotR;
    float sa = sc.a * falloff * 0.85;
    if (sa <= 0.004) continue;

    if (a <= 0.002) {
      col = sc.rgb;
      a = sa;
    } else {
      float outA = sa + a * (1.0 - sa);
      float mixW = sa / max(0.001, outA);
      col = mixPaintCol(col, sc.rgb, mixW, u_physicalMix);
      a = outA;
    }

    if (sm.y > 0.005) {
      h = min(52.0, h + sm.y * falloff * 0.45);
    }
  }

  if (u_alphaLock == 1) {
    a = srcP.a;
  }

  if (a < 0.002) {
    outPaint = vec4(0.0);
    outState = vec4(0.0, srcS.g, srcS.b, srcS.a);
  } else {
    outPaint = vec4(clamp(col * a, 0.0, a), a);
    outState = vec4(h, srcS.g, srcS.b, srcS.a);
  }
}
`;

// Real-time 3x3 Sobel Normal + Blinn-Phong 3D Impasto Lighting Shader (premultiplied RGBA output)
const FLUID_LIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_paint;
uniform sampler2D u_state;
uniform vec2 u_texel;
uniform vec4 u_uvClamp;
uniform int u_doShade;
uniform float u_bumpScale;
uniform float u_diffIntensity;
uniform float u_rimMax;
uniform float u_specScale;
uniform sampler2D u_surfaceMap;
uniform int u_hasSurface;
uniform vec2 u_simOrigin;
uniform float u_surfaceInvScale;
uniform float u_surfaceBiomeMix;
uniform float u_surfaceAllowRotate;
uniform float u_surfaceScaleSpread;
uniform float u_surfRelief;
uniform float u_heightShield;
uniform float u_speedHeightMod;

out vec4 outLit;

${GLSL_SURFACE_BIOME_SAMPLER}

void main() {
  vec4 p = texture(u_paint, v_uv);
  if (p.a <= 0.002) {
    outLit = vec4(0.0);
    return;
  }

  vec3 col = clamp(p.rgb / p.a, 0.0, 1.0);
  if (u_doShade == 0) {
    outLit = p;
    return;
  }

  float h = texture(u_state, v_uv).r;
  if (h <= 0.004) {
    outLit = p;
    return;
  }

  float uL = max(u_uvClamp.x, v_uv.x - u_texel.x);
  float uR = min(u_uvClamp.z, v_uv.x + u_texel.x);
  float vT = max(u_uvClamp.y, v_uv.y - u_texel.y);
  float vB = min(u_uvClamp.w, v_uv.y + u_texel.y);

  float tl = texture(u_state, vec2(uL, vT)).r;
  float tc = texture(u_state, vec2(v_uv.x, vT)).r;
  float tr = texture(u_state, vec2(uR, vT)).r;
  float ml = texture(u_state, vec2(uL, v_uv.y)).r;
  float mr = texture(u_state, vec2(uR, v_uv.y)).r;
  float bl = texture(u_state, vec2(uL, vB)).r;
  float bc = texture(u_state, vec2(v_uv.x, vB)).r;
  float br = texture(u_state, vec2(uR, vB)).r;

  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);

  vec2 nxy = vec2(-gx, -gy) * u_bumpScale;
  if (u_hasSurface == 1 && u_surfRelief > 0.01) {
    vec2 wp = u_simOrigin + gl_FragCoord.xy;
    vec4 sSample = sampleSurfaceMapBiome(u_surfaceMap, wp, u_surfaceInvScale, u_surfaceBiomeMix, u_surfaceAllowRotate, u_surfaceScaleSpread);
    vec2 surfSlope = (sSample.gb - 0.5) * 2.0;
    float shieldFade = clamp(1.0 - (h / max(2.5, 22.0 - 16.0 * u_heightShield)) * (0.20 + 1.05 * u_heightShield), 0.0, 1.0);
    nxy += -surfSlope * (u_surfRelief * 0.65 * shieldFade * u_speedHeightMod);
  }
  float invLen = inversesqrt(dot(nxy, nxy) + 1.0);
  vec3 n = vec3(nxy * invLen, invLen);

  float dDot = (n.x * -0.54 + n.y * -0.68 + n.z * 0.496) - 0.496;
  float shade = clamp(1.0 + dDot * u_diffIntensity, 0.60, 1.48);
  float rimLift = dDot > 0.0 ? (dDot * u_rimMax / 255.0) : 0.0;

  float spec = 0.0;
  if (u_specScale > 0.005) {
    float ndoth = n.x * -0.305 + n.y * -0.384 + n.z * 0.871;
    if (ndoth > 0.0) {
      float nd2 = ndoth * ndoth;
      float nd4 = nd2 * nd2;
      float nd8 = nd4 * nd4;
      float nd24 = nd8 * nd8 * nd8;
      float hMask = h > 3.2 ? 1.0 : (h * 0.312);
      spec = (nd24 * (190.0 / 255.0) + nd4 * (26.0 / 255.0)) * u_specScale * hMask;
    }
  }

  vec3 litRgb = clamp(col * shade + vec3(rimLift + spec), 0.0, 1.0);
  outLit = vec4(litRgb * p.a, p.a);
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

export class GpuFluidSolver {
  constructor(gpuRenderer) {
    this.gpuRenderer = gpuRenderer;
    this.gl = gpuRenderer.gl;
    this.ready = false;
    this._pipelinesWarmed = false;

    this.active = false;
    this.activeLayer = -1;
    this.curWorkIdx = 0;
    this.curCarriedIdx = 0;
    this.hasCarried = false;

    this.lastShadeParams = { isShading: true, depthRatio: 0.45, glossRatio: 0.35 };
    this.activeTiles = new Map();
    this.tilePool = [];
    this.touchedChunks = new Map();

    this.tipBuf = new Uint8Array(64 * 64 * 4);
    this.segPosArr = new Float32Array(24 * 4);
    this.segColArr = new Float32Array(24 * 4);
    this.segMetaArr = new Float32Array(24 * 4);

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
      console.error('FluidPaint GPU Program Link Error:', gl.getProgramInfoLog(prog));
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
    if (!hasHalfFloat) return;

    this.progRectMap = this._createProgram(RECT_MAP_VS, BLIT_FS);
    this.progPickup = this._createProgram(QUAD_UNIT_VS, FLUID_PICKUP_FS);
    this.progInject = this._createProgram(QUAD_UNIT_VS, FLUID_INJECT_FS);
    this.progStreamer = this._createProgram(QUAD_UNIT_VS, FLUID_STREAMER_FS);
    this.progLight = this._createProgram(QUAD_UNIT_VS, FLUID_LIGHT_FS);
    this.progUnpremult = this._createProgram(QUAD_UNIT_VS, UNPREMULT_FS);

    if (!this.progRectMap || !this.progPickup || !this.progInject || !this.progStreamer || !this.progLight || !this.progUnpremult) {
      this.dispose();
      return;
    }

    this.workStateA = this._makeTexFBO(WORK_SIZE, WORK_SIZE, true, true);
    this.workStateB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, true, true);
    this.workPaintA = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workPaintB = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);
    this.workLit = this._makeTexFBO(WORK_SIZE, WORK_SIZE, false, true);

    this.carriedA = this._makeTexFBO(1, 1, false, false);
    this.carriedB = this._makeTexFBO(1, 1, false, false);
    this.chunkBlitFbo = gl.createFramebuffer();

    if (!this.workStateA || !this.workStateB || !this.workPaintA || !this.workPaintB ||
        !this.workLit || !this.carriedA || !this.carriedB || !this.chunkBlitFbo) {
      this.dispose();
      return;
    }

    this.mrtWorkA = this._makeMrtFbo(this.workPaintA.tex, this.workStateA.tex);
    this.mrtWorkB = this._makeMrtFbo(this.workPaintB.tex, this.workStateB.tex);
    if (!this.mrtWorkA || !this.mrtWorkB) {
      this.dispose();
      return;
    }

    // 64x64 bilinear tip mask & local-thickness bump texture
    this.tipTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Pre-warm 4 pooled 256x256 tiles so first stroke has zero FBO creation lag
    for (let i = 0; i < 4; i++) {
      const t = this._allocTileGpu();
      if (t) this.tilePool.push(t);
    }

    this.rectLocs = this._cacheLocs(this.progRectMap, ['u_srcRect', 'u_dstRect', 'u_uvSubRect', 'u_tex']);
    this.pickupLocs = this._cacheLocs(this.progPickup, [
      'u_prevCarried', 'u_paint', 'u_state', 'u_workOrigin', 'u_workSize', 'u_uvClamp',
      'u_to', 'u_radius', 'u_prevDistTotal', 'u_coverWindow', 'u_pickupRatio', 'u_retentionRatio',
      'u_stepColor', 'u_isFirst', 'u_physicalMix'
    ]);
    this.injectLocs = this._cacheLocs(this.progInject, [
      'u_paint', 'u_state', 'u_tip', 'u_carried', 'u_simOrigin', 'u_texel', 'u_uvClamp',
      'u_from', 'u_dir', 'u_prevDir', 'u_safeDist', 'u_prevDistTotal', 'u_coverWindow',
      'u_radius', 'u_rotCos', 'u_rotSin', 'u_time', 'u_curlFreq', 'u_hasCurl',
      'u_dragAmp', 'u_swirlAmp', 'u_curlAmp', 'u_lagDistBase', 'u_advMixBase', 'u_trailFeatherInv',
      'u_brFreq', 'u_bristleContrast', 'u_fluidity', 'u_vortex', 'u_turb', 'u_depthScale',
      'u_paintSupply', 'u_supplyThreshold', 'u_strokeOpacity', 'u_recolorRateBase',
      'u_nSteps', 'u_alphaLock', 'u_physicalMix',
      'u_surfaceMap', 'u_hasSurface', 'u_surfaceInvScale', 'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_surfSlip', 'u_surfResist', 'u_surfChannel', 'u_surfRelief', 'u_pressure',
      'u_heightShield', 'u_speedHeightMod'
    ]);
    this.streamerLocs = this._cacheLocs(this.progStreamer, [
      'u_paint', 'u_state', 'u_simOrigin', 'u_segCount', 'u_segPos', 'u_segCol', 'u_segMeta',
      'u_alphaLock', 'u_physicalMix'
    ]);
    this.lightLocs = this._cacheLocs(this.progLight, [
      'u_paint', 'u_state', 'u_texel', 'u_uvClamp', 'u_doShade',
      'u_bumpScale', 'u_diffIntensity', 'u_rimMax', 'u_specScale',
      'u_surfaceMap', 'u_hasSurface', 'u_simOrigin', 'u_surfaceInvScale',
      'u_surfaceBiomeMix', 'u_surfaceAllowRotate', 'u_surfaceScaleSpread',
      'u_surfRelief', 'u_heightShield', 'u_speedHeightMod'
    ]);
    this.unpremultLocs = this._cacheLocs(this.progUnpremult, ['u_tex']);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ready = true;
  }

  prewarmPipelines(engine = null, tipRaw = null, tipBump = null, tipVersion = null) {
    const gl = this.gl;
    if (!this.ready || !gl || gl.isContextLost() || !this.gpuRenderer?.vao) return;

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    if (tipRaw && tipBump) {
      this.uploadTipMaps(tipRaw, tipBump, 64, tipVersion);
    }

    if (this._pipelinesWarmed) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      return;
    }

    // Trigger real 4x4 (and 1x1) scissored draws across all 6 shaders & MRT targets
    // so ANGLE/GPU native PSO compilation completes ahead of stroke 1.
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.gpuRenderer.vao);

    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workStateA.fbo);
    gl.clearColor(0, 0, -100000.0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.scissor(0, 0, 1, 1);
    gl.viewport(0, 0, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.carriedA.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. progRectMap: workPaintA -> workPaintB
    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintB.fbo);
    gl.useProgram(this.progRectMap);
    gl.uniform4f(this.rectLocs.u_srcRect, 0, 0, TILE_SIZE, TILE_SIZE);
    gl.uniform4f(this.rectLocs.u_dstRect, 0, 0, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.rectLocs.u_uvSubRect, 0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPaintA.tex);
    gl.uniform1i(this.rectLocs.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. progPickup: carriedA + workPaintA + workStateA -> carriedB
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.carriedB.fbo);
    gl.useProgram(this.progPickup);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.carriedA.tex);
    gl.uniform1i(this.pickupLocs.u_prevCarried, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workPaintA.tex);
    gl.uniform1i(this.pickupLocs.u_paint, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.workStateA.tex);
    gl.uniform1i(this.pickupLocs.u_state, 2);
    gl.uniform2f(this.pickupLocs.u_workOrigin, 0, 0);
    gl.uniform2f(this.pickupLocs.u_workSize, WORK_SIZE, WORK_SIZE);
    gl.uniform4f(this.pickupLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform2f(this.pickupLocs.u_to, 2, 2);
    gl.uniform1f(this.pickupLocs.u_radius, 12.0);
    gl.uniform1f(this.pickupLocs.u_prevDistTotal, 0.0);
    gl.uniform1f(this.pickupLocs.u_coverWindow, 24.0);
    gl.uniform1f(this.pickupLocs.u_pickupRatio, 0.5);
    gl.uniform1f(this.pickupLocs.u_retentionRatio, 0.5);
    gl.uniform3f(this.pickupLocs.u_stepColor, 0, 0, 0);
    gl.uniform1i(this.pickupLocs.u_isFirst, 1);
    gl.uniform1i(this.pickupLocs.u_physicalMix, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. progInject (MRT): workPaintA + workStateA + tipTex + carriedB -> mrtWorkB
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 4);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkB);
    gl.useProgram(this.progInject);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPaintA.tex);
    gl.uniform1i(this.injectLocs.u_paint, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workStateA.tex);
    gl.uniform1i(this.injectLocs.u_state, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_tip, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.carriedB.tex);
    gl.uniform1i(this.injectLocs.u_carried, 3);
    gl.uniform2f(this.injectLocs.u_simOrigin, 0, 0);
    gl.uniform2f(this.injectLocs.u_texel, 1 / WORK_SIZE, 1 / WORK_SIZE);
    gl.uniform4f(this.injectLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform2f(this.injectLocs.u_from, 1, 1);
    gl.uniform2f(this.injectLocs.u_dir, 1, 0);
    gl.uniform2f(this.injectLocs.u_prevDir, 1, 0);
    gl.uniform1f(this.injectLocs.u_safeDist, 1.0);
    gl.uniform1f(this.injectLocs.u_prevDistTotal, 0.0);
    gl.uniform1f(this.injectLocs.u_coverWindow, 24.0);
    gl.uniform1f(this.injectLocs.u_radius, 12.0);
    gl.uniform1f(this.injectLocs.u_rotCos, 1.0);
    gl.uniform1f(this.injectLocs.u_rotSin, 0.0);
    gl.uniform1f(this.injectLocs.u_time, 0.0);
    gl.uniform1f(this.injectLocs.u_curlFreq, 0.05);
    gl.uniform1i(this.injectLocs.u_hasCurl, 0);
    gl.uniform1f(this.injectLocs.u_dragAmp, 0.5);
    gl.uniform1f(this.injectLocs.u_swirlAmp, 0.0);
    gl.uniform1f(this.injectLocs.u_curlAmp, 0.0);
    gl.uniform1f(this.injectLocs.u_lagDistBase, 1.0);
    gl.uniform1f(this.injectLocs.u_advMixBase, 0.5);
    gl.uniform1f(this.injectLocs.u_trailFeatherInv, 0.1);
    gl.uniform1f(this.injectLocs.u_brFreq, 12.0);
    gl.uniform1f(this.injectLocs.u_bristleContrast, 0.5);
    gl.uniform1f(this.injectLocs.u_fluidity, 0.5);
    gl.uniform1f(this.injectLocs.u_vortex, 0.0);
    gl.uniform1f(this.injectLocs.u_turb, 0.0);
    gl.uniform1f(this.injectLocs.u_depthScale, 0.5);
    gl.uniform1f(this.injectLocs.u_paintSupply, 0.5);
    gl.uniform1f(this.injectLocs.u_supplyThreshold, 0.1);
    gl.uniform1f(this.injectLocs.u_strokeOpacity, 1.0);
    gl.uniform1f(this.injectLocs.u_recolorRateBase, 0.5);
    gl.uniform1i(this.injectLocs.u_nSteps, 1);
    gl.uniform1i(this.injectLocs.u_alphaLock, 0);
    gl.uniform1i(this.injectLocs.u_physicalMix, 0);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.injectLocs.u_surfaceMap, 4);
    gl.uniform1i(this.injectLocs.u_hasSurface, 0);
    gl.uniform1f(this.injectLocs.u_surfaceInvScale, 1.0 / 320.0);
    gl.uniform1f(this.injectLocs.u_surfaceBiomeMix, 0.0);
    gl.uniform1f(this.injectLocs.u_surfaceAllowRotate, 1.0);
    gl.uniform1f(this.injectLocs.u_surfaceScaleSpread, 1.0);
    gl.uniform1f(this.injectLocs.u_surfSlip, 0.5);
    gl.uniform1f(this.injectLocs.u_surfResist, 0.0);
    gl.uniform1f(this.injectLocs.u_surfChannel, 0.0);
    gl.uniform1f(this.injectLocs.u_surfRelief, 0.0);
    gl.uniform1f(this.injectLocs.u_pressure, 1.0);
    gl.uniform1f(this.injectLocs.u_heightShield, 0.65);
    gl.uniform1f(this.injectLocs.u_speedHeightMod, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. progStreamer (MRT): workPaintB + workStateB -> mrtWorkA
    this.segPosArr.fill(0);
    this.segColArr.fill(0);
    this.segMetaArr.fill(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrtWorkA);
    gl.useProgram(this.progStreamer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPaintB.tex);
    gl.uniform1i(this.streamerLocs.u_paint, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workStateB.tex);
    gl.uniform1i(this.streamerLocs.u_state, 1);
    gl.uniform2f(this.streamerLocs.u_simOrigin, 0, 0);
    gl.uniform1i(this.streamerLocs.u_segCount, 1);
    gl.uniform4fv(this.streamerLocs.u_segPos, this.segPosArr);
    gl.uniform4fv(this.streamerLocs.u_segCol, this.segColArr);
    gl.uniform4fv(this.streamerLocs.u_segMeta, this.segMetaArr);
    gl.uniform1i(this.streamerLocs.u_alphaLock, 0);
    gl.uniform1i(this.streamerLocs.u_physicalMix, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 5. progLight: workPaintA + workStateA -> workLit
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workLit.fbo);
    gl.useProgram(this.progLight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workPaintA.tex);
    gl.uniform1i(this.lightLocs.u_paint, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.workStateA.tex);
    gl.uniform1i(this.lightLocs.u_state, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.uniform1i(this.lightLocs.u_surfaceMap, 2);
    gl.uniform1i(this.lightLocs.u_hasSurface, 0);
    gl.uniform2f(this.lightLocs.u_simOrigin, 0, 0);
    gl.uniform1f(this.lightLocs.u_surfaceInvScale, 1.0 / 320.0);
    gl.uniform1f(this.lightLocs.u_surfaceBiomeMix, 0.0);
    gl.uniform1f(this.lightLocs.u_surfaceAllowRotate, 1.0);
    gl.uniform1f(this.lightLocs.u_surfaceScaleSpread, 1.0);
    gl.uniform1f(this.lightLocs.u_surfRelief, 0.0);
    gl.uniform1f(this.lightLocs.u_heightShield, 0.65);
    gl.uniform1f(this.lightLocs.u_speedHeightMod, 1.0);
    gl.uniform2f(this.lightLocs.u_texel, 1 / WORK_SIZE, 1 / WORK_SIZE);
    gl.uniform4f(this.lightLocs.u_uvClamp, 0.001, 0.001, 0.999, 0.999);
    gl.uniform1i(this.lightLocs.u_doShade, 1);
    gl.uniform1f(this.lightLocs.u_bumpScale, 0.2);
    gl.uniform1f(this.lightLocs.u_diffIntensity, 0.5);
    gl.uniform1f(this.lightLocs.u_rimMax, 10.0);
    gl.uniform1f(this.lightLocs.u_specScale, 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 6. progUnpremult: workLit -> workPaintB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintB.fbo);
    gl.useProgram(this.progUnpremult);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workLit.tex);
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
    const paint = this._makeTexFBO(TILE_SIZE, TILE_SIZE, false, false);
    const state = this._makeTexFBO(TILE_SIZE, TILE_SIZE, true, false);
    if (!paint || !state) {
      const gl = this.gl;
      if (paint) { gl.deleteFramebuffer(paint.fbo); gl.deleteTexture(paint.tex); }
      if (state) { gl.deleteFramebuffer(state.fbo); gl.deleteTexture(state.tex); }
      return null;
    }
    return { paint, state, tx: 0, ty: 0, wx: 0, wy: 0, dirty: false, minX: TILE_SIZE, minY: TILE_SIZE, maxX: 0, maxY: 0 };
  }

  _destroyTileGpu(t) {
    if (!t || !this.gl) return;
    const gl = this.gl;
    for (const o of [t.paint, t.state]) {
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

  _srcPaint() { return this.curWorkIdx === 0 ? this.workPaintA : this.workPaintB; }
  _dstPaint() { return this.curWorkIdx === 0 ? this.workPaintB : this.workPaintA; }
  _srcState() { return this.curWorkIdx === 0 ? this.workStateA : this.workStateB; }
  _dstState() { return this.curWorkIdx === 0 ? this.workStateB : this.workStateA; }
  _dstMrt() { return this.curWorkIdx === 0 ? this.mrtWorkB : this.mrtWorkA; }
  _swapWork() { this.curWorkIdx = 1 - this.curWorkIdx; }

  _srcCarried() { return this.curCarriedIdx === 0 ? this.carriedA : this.carriedB; }
  _dstCarried() { return this.curCarriedIdx === 0 ? this.carriedB : this.carriedA; }
  _swapCarried() { this.curCarriedIdx = 1 - this.curCarriedIdx; }

  uploadTipMaps(tipRaw, tipBump, res = 64, tipVersion = null) {
    if (!this.ready || !this.tipTex) return;
    if (tipVersion !== null && this._uploadedTipVersion === tipVersion) return;
    this._uploadedTipVersion = tipVersion;
    const gl = this.gl;
    const len = res * res;
    for (let i = 0; i < len; i++) {
      const p4 = i * 4;
      const a = tipRaw[i] <= 0 ? 0 : (tipRaw[i] >= 1 ? 255 : (tipRaw[i] * 255.0 + 0.5) | 0);
      const b = tipBump[i] <= 0 ? 0 : (tipBump[i] >= 1 ? 255 : (tipBump[i] * 255.0 + 0.5) | 0);
      this.tipBuf[p4] = a;
      this.tipBuf[p4 + 1] = b;
      this.tipBuf[p4 + 2] = 0;
      this.tipBuf[p4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, res, res, gl.RGBA, gl.UNSIGNED_BYTE, this.tipBuf);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
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

    // Clear impasto state (height=0, prevCov=0, lastDist=-100000)
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.state.fbo);
    gl.clearColor(0.0, 0.0, -100000.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Seed tile.paint directly from existing chunk GPU textures (zero readback)
    gl.bindFramebuffer(gl.FRAMEBUFFER, tile.paint.fbo);
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

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workStateA.fbo);
    gl.clearColor(0.0, 0.0, -100000.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      gl.uniform4f(this.rectLocs.u_srcRect, t.wx, t.wy, TILE_SIZE, TILE_SIZE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.paint.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workStateA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, t.state.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    return tiles;
  }

  _storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH, apron) {
    const gl = this.gl;
    const paintTex = this._srcPaint().tex;
    const stateTex = this._srcState().tex;

    const innerX = workX + apron;
    const innerY = workY + apron;
    const innerW = Math.max(1, boxW - apron * 2);
    const innerH = Math.max(1, boxH - apron * 2);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Write updated workPaint & workState back into active sparse tiles inside interior box
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

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.paint.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, paintTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.state.fbo);
      gl.bindTexture(gl.TEXTURE_2D, stateTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 2. Blit Sobel-lit workLit straight onto chunk.gpuTextures[layer] on GPU (0 readback, 0 overlay seams)
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
    gl.bindTexture(gl.TEXTURE_2D, this.workLit.tex);

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

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.workLit.tex);

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

  beginStroke(engine, _startPoint, tipRaw, tipBump, tipVersion = null) {
    if (!this.ready || !this.gl || this.gl.isContextLost()) return false;
    this._releaseAllTiles();
    this.touchedChunks.clear();
    this.uploadTipMaps(tipRaw, tipBump, 64, tipVersion);

    this.activeLayer = engine.activeLayer;
    this.curWorkIdx = 0;
    this.curCarriedIdx = 0;
    this.hasCarried = false;
    this.active = true;
    this.gpuRenderer.fluidOverlay = null;
    return true;
  }

  runStep(engine, params) {
    if (!this.ready || !this.active || !this.gl || this.gl.isContextLost()) return;

    this.lastShadeParams = {
      isShading: params.isShading,
      depthRatio: params.depthRatio,
      glossRatio: params.glossRatio,
      heightShield: params.heightShield !== undefined ? params.heightShield : 0.65,
      speedHeightMod: params.speedHeightMod !== undefined ? params.speedHeightMod : 1.0
    };

    const apron = 2;
    const pad = (params.extraPad || 12) + apron;
    const needMinX = Math.floor(params.minX - pad);
    const needMinY = Math.floor(params.minY - pad);
    const needMaxX = Math.ceil(params.maxX + pad);
    const needMaxY = Math.ceil(params.maxY + pad);

    const spanX = needMaxX - needMinX;
    const spanY = needMaxY - needMinY;
    const boxW = Math.min(WORK_SIZE, Math.max(8, spanX));
    const boxH = Math.min(WORK_SIZE, Math.max(8, spanY));
    const workX = spanX > WORK_SIZE ? Math.floor((needMinX + needMaxX - boxW) * 0.5) : needMinX;
    const workY = spanY > WORK_SIZE ? Math.floor((needMinY + needMaxY - boxH) * 0.5) : needMinY;

    if (engine.isStatic) {
      const halfW = engine.staticWidth * 0.5;
      const halfH = engine.staticHeight * 0.5;
      if ((workX + boxW) <= -halfW || workX >= halfW || (workY + boxH) <= -halfH || workY >= halfH) {
        return;
      }
    }

    const tiles = this._assembleWorkBox(engine, workX, workY, boxW, boxH);
    if (tiles.length === 0) return;

    const gl = this.gl;
    const texel = 1.0 / WORK_SIZE;
    const minU = 0.5 * texel;
    const minV = 0.5 * texel;
    const maxU = Math.max(minU, (boxW - 0.5) * texel);
    const maxV = Math.max(minV, (boxH - 0.5) * texel);
    const layerSet = engine.layerSettings ? engine.layerSettings[engine.activeLayer] : null;
    const alphaLock = layerSet && layerSet.alphaLock ? 1 : 0;
    const physicalMix = (engine.physicalColorMix !== false) ? 1 : 0;

    const surfMgr = engine.surfaceManager;
    const surfU = surfMgr ? surfMgr.getShaderUniforms() : { active: false };
    const surfTex = surfU.active ? surfMgr.ensureGpuTextures(gl) : { mapTex: null };
    const hasSurface = !!(surfU.active && surfTex.mapTex);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.gpuRenderer.vao);

    // 1. Update 1x1 GPU carried color buffer (with 3x3 wet pickup from workPaint, 0 CPU readback)
    if (!params.isTailFlush) {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstCarried().fbo);
      gl.useProgram(this.progPickup);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcCarried().tex);
      gl.uniform1i(this.pickupLocs.u_prevCarried, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._srcPaint().tex);
      gl.uniform1i(this.pickupLocs.u_paint, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._srcState().tex);
      gl.uniform1i(this.pickupLocs.u_state, 2);

      gl.uniform2f(this.pickupLocs.u_workOrigin, workX, workY);
      gl.uniform2f(this.pickupLocs.u_workSize, WORK_SIZE, WORK_SIZE);
      gl.uniform4f(this.pickupLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform2f(this.pickupLocs.u_to, params.toX, params.toY);
      gl.uniform1f(this.pickupLocs.u_radius, params.radius);
      gl.uniform1f(this.pickupLocs.u_prevDistTotal, params.prevDistTotal);
      gl.uniform1f(this.pickupLocs.u_coverWindow, params.coverWindow);
      gl.uniform1f(this.pickupLocs.u_pickupRatio, params.pickupRatio ?? 0.0);
      gl.uniform1f(this.pickupLocs.u_retentionRatio, params.retentionRatio ?? 0.5);
      gl.uniform3f(this.pickupLocs.u_stepColor, params.paintR / 255.0, params.paintG / 255.0, params.paintB / 255.0);
      gl.uniform1i(this.pickupLocs.u_isFirst, this.hasCarried ? 0 : 1);
      gl.uniform1i(this.pickupLocs.u_physicalMix, physicalMix);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._swapCarried();
      this.hasCarried = true;
    }

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);

    // 2. Primary Swept Tip-Guided Self-Advection & Bristle Deposit Pass
    if (!params.isTailFlush) {
      const nSteps = params.safeDist <= 0.001
        ? 1
        : Math.min(14, Math.max(1, Math.ceil((params.radius * 2.08) / Math.max(1.5, params.radius * 0.09))));

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstMrt());
      gl.useProgram(this.progInject);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcPaint().tex);
      gl.uniform1i(this.injectLocs.u_paint, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._srcState().tex);
      gl.uniform1i(this.injectLocs.u_state, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.tipTex);
      gl.uniform1i(this.injectLocs.u_tip, 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._srcCarried().tex);
      gl.uniform1i(this.injectLocs.u_carried, 3);

      gl.uniform2f(this.injectLocs.u_simOrigin, workX, workY);
      gl.uniform2f(this.injectLocs.u_texel, texel, texel);
      gl.uniform4f(this.injectLocs.u_uvClamp, minU, minV, maxU, maxV);
      gl.uniform2f(this.injectLocs.u_from, params.fromX, params.fromY);
      gl.uniform2f(this.injectLocs.u_dir, params.dirX, params.dirY);
      gl.uniform2f(this.injectLocs.u_prevDir, params.prevDX, params.prevDY);
      gl.uniform1f(this.injectLocs.u_safeDist, params.safeDist);
      gl.uniform1f(this.injectLocs.u_prevDistTotal, params.prevDistTotal);
      gl.uniform1f(this.injectLocs.u_coverWindow, params.coverWindow);
      gl.uniform1f(this.injectLocs.u_radius, params.radius);
      gl.uniform1f(this.injectLocs.u_rotCos, params.cosR);
      gl.uniform1f(this.injectLocs.u_rotSin, params.sinR);
      gl.uniform1f(this.injectLocs.u_time, params.curTime);
      gl.uniform1f(this.injectLocs.u_curlFreq, params.curlFreq);
      gl.uniform1i(this.injectLocs.u_hasCurl, params.hasCurl ? 1 : 0);

      gl.uniform1f(this.injectLocs.u_dragAmp, params.dragAmp);
      gl.uniform1f(this.injectLocs.u_swirlAmp, params.swirlAmp);
      gl.uniform1f(this.injectLocs.u_curlAmp, params.curlAmp);
      gl.uniform1f(this.injectLocs.u_lagDistBase, params.lagDistBase);
      gl.uniform1f(this.injectLocs.u_advMixBase, params.advMixBase);
      gl.uniform1f(this.injectLocs.u_trailFeatherInv, params.trailFeatherInv);

      gl.uniform1f(this.injectLocs.u_brFreq, params.brFreq);
      gl.uniform1f(this.injectLocs.u_bristleContrast, params.bristleContrastRatio);
      gl.uniform1f(this.injectLocs.u_fluidity, params.fluidityRatio);
      gl.uniform1f(this.injectLocs.u_vortex, params.vortexRatio);
      gl.uniform1f(this.injectLocs.u_turb, params.turbRatio);
      gl.uniform1f(this.injectLocs.u_depthScale, params.depthScale);
      gl.uniform1f(this.injectLocs.u_paintSupply, params.paintSupply);
      gl.uniform1f(this.injectLocs.u_supplyThreshold, params.supplyThreshold);
      gl.uniform1f(this.injectLocs.u_strokeOpacity, params.strokeOpacity);
      gl.uniform1f(this.injectLocs.u_recolorRateBase, params.recolorRateBase);
      gl.uniform1i(this.injectLocs.u_nSteps, nSteps);
      gl.uniform1i(this.injectLocs.u_alphaLock, alphaLock);
      gl.uniform1i(this.injectLocs.u_physicalMix, physicalMix);

      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, hasSurface ? surfTex.mapTex : this.tipTex);
      gl.uniform1i(this.injectLocs.u_surfaceMap, 4);
      gl.uniform1i(this.injectLocs.u_hasSurface, hasSurface ? 1 : 0);
      gl.uniform1f(this.injectLocs.u_surfaceInvScale, surfU.invScale || (1.0 / 320.0));
      gl.uniform1f(this.injectLocs.u_surfaceBiomeMix, surfU.biomeMix ?? 0.88);
      gl.uniform1f(this.injectLocs.u_surfaceAllowRotate, surfU.allowRotate ?? 1.0);
      gl.uniform1f(this.injectLocs.u_surfaceScaleSpread, surfU.scaleSpread ?? 1.0);
      gl.uniform1f(this.injectLocs.u_surfSlip, surfU.slip ?? 0.5);
      gl.uniform1f(this.injectLocs.u_surfResist, surfU.resist ?? 0.0);
      gl.uniform1f(this.injectLocs.u_surfChannel, surfU.channel ?? 0.0);
      gl.uniform1f(this.injectLocs.u_surfRelief, surfU.relief ?? 0.0);
      gl.uniform1f(this.injectLocs.u_pressure, params.pressure !== undefined ? params.pressure : 1.0);
      gl.uniform1f(this.injectLocs.u_heightShield, params.heightShield !== undefined ? params.heightShield : 0.65);
      gl.uniform1f(this.injectLocs.u_speedHeightMod, params.speedHeightMod !== undefined ? params.speedHeightMod : 1.0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._swapWork();
    }

    // 3. Composite Batched Air-Paint Curl Streamers (if active, zero-alloc uniform buffers)
    const segs = params.streamerSegs;
    if (segs && segs.length > 0) {
      const count = Math.min(24, segs.length);
      const posArr = this.segPosArr;
      const colArr = this.segColArr;
      const metaArr = this.segMetaArr;
      for (let i = 0; i < count; i++) {
        const s = segs[i];
        const i4 = i * 4;
        posArr[i4] = s.x0;
        posArr[i4 + 1] = s.y0;
        posArr[i4 + 2] = s.x1;
        posArr[i4 + 3] = s.y1;

        colArr[i4] = s.r / 255.0;
        colArr[i4 + 1] = s.g / 255.0;
        colArr[i4 + 2] = s.b / 255.0;
        colArr[i4 + 3] = s.alpha;

        metaArr[i4] = s.width;
        metaArr[i4 + 1] = params.streamerHScale * s.alpha;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._dstMrt());
      gl.useProgram(this.progStreamer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._srcPaint().tex);
      gl.uniform1i(this.streamerLocs.u_paint, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._srcState().tex);
      gl.uniform1i(this.streamerLocs.u_state, 1);
      gl.uniform2f(this.streamerLocs.u_simOrigin, workX, workY);
      gl.uniform1i(this.streamerLocs.u_segCount, count);
      gl.uniform4fv(this.streamerLocs.u_segPos, posArr);
      gl.uniform4fv(this.streamerLocs.u_segCol, colArr);
      gl.uniform4fv(this.streamerLocs.u_segMeta, metaArr);
      gl.uniform1i(this.streamerLocs.u_alphaLock, alphaLock);
      gl.uniform1i(this.streamerLocs.u_physicalMix, physicalMix);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this._swapWork();
    }

    // 4. Render 3x3 Sobel + Blinn-Phong 3D Impasto Lighting into workLit
    const doShade = (params.isShading && (params.depthRatio > 0.005 || params.glossRatio > 0.005)) ? 1 : 0;
    gl.scissor(1, 1, Math.max(1, boxW - 2), Math.max(1, boxH - 2));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workLit.fbo);
    gl.useProgram(this.progLight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._srcPaint().tex);
    gl.uniform1i(this.lightLocs.u_paint, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._srcState().tex);
    gl.uniform1i(this.lightLocs.u_state, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, hasSurface ? surfTex.mapTex : this.tipTex);
    gl.uniform1i(this.lightLocs.u_surfaceMap, 2);
    gl.uniform1i(this.lightLocs.u_hasSurface, hasSurface ? 1 : 0);
    gl.uniform2f(this.lightLocs.u_simOrigin, workX, workY);
    gl.uniform1f(this.lightLocs.u_surfaceInvScale, surfU.invScale || (1.0 / 320.0));
    gl.uniform1f(this.lightLocs.u_surfaceBiomeMix, surfU.biomeMix ?? 0.88);
    gl.uniform1f(this.lightLocs.u_surfaceAllowRotate, surfU.allowRotate ?? 1.0);
    gl.uniform1f(this.lightLocs.u_surfaceScaleSpread, surfU.scaleSpread ?? 1.0);
    gl.uniform1f(this.lightLocs.u_surfRelief, surfU.relief ?? 0.0);
    gl.uniform1f(this.lightLocs.u_heightShield, params.heightShield !== undefined ? params.heightShield : 0.65);
    gl.uniform1f(this.lightLocs.u_speedHeightMod, params.speedHeightMod !== undefined ? params.speedHeightMod : 1.0);

    gl.uniform2f(this.lightLocs.u_texel, texel, texel);
    gl.uniform4f(this.lightLocs.u_uvClamp, minU, minV, maxU, maxV);
    gl.uniform1i(this.lightLocs.u_doShade, doShade);
    gl.uniform1f(this.lightLocs.u_bumpScale, params.depthRatio * 0.36);
    gl.uniform1f(this.lightLocs.u_diffIntensity, params.depthRatio * 1.08);
    gl.uniform1f(this.lightLocs.u_rimMax, params.depthRatio * 34.0);
    gl.uniform1f(this.lightLocs.u_specScale, params.glossRatio);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 5. Persist updated tiles + blit workLit directly to chunk.gpuTextures[layer]
    this._storeTilesAndUpdateChunks(engine, tiles, workX, workY, boxW, boxH, apron);
    this.gpuRenderer.requestRender();
  }

  _commitTilesToChunks(engine) {
    if (this.activeTiles.size === 0) return;

    const gl = this.gl;
    const layer = engine.activeLayer;
    const layerSet = engine.layerSettings ? engine.layerSettings[layer] : null;
    const alphaLock = !!(layerSet && layerSet.alphaLock);
    const { isShading, depthRatio, glossRatio, heightShield = 0.65, speedHeightMod = 1.0 } = this.lastShadeParams;
    const doShade = (isShading && (depthRatio > 0.005 || glossRatio > 0.005)) ? 1 : 0;

    if (!this._commitCanvas) {
      this._commitCanvas = document.createElement('canvas');
      this._commitCanvas.width = TILE_SIZE;
      this._commitCanvas.height = TILE_SIZE;
      this._commitCtx = this._commitCanvas.getContext('2d');
      this._readBuf = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    }

    const texel = 1.0 / WORK_SIZE;

    // Collect array first so inner neighbor lookup doesn't mutate activeTiles iteration unexpectedly
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

      // Assemble tile + 1px neighbor apron for exact 3x3 Sobel cross-tile continuity
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

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workStateA.fbo);
      gl.clearColor(0.0, 0.0, -100000.0, 0.0);
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

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, nt.paint.tex);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.workStateA.fbo);
          gl.bindTexture(gl.TEXTURE_2D, nt.state.tex);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }

      // Compute Sobel 3D impasto lighting inside [1, 1, rw, rh]
      const commitSurfMgr = engine.surfaceManager;
      const commitSurfU = commitSurfMgr ? commitSurfMgr.getShaderUniforms() : { active: false };
      const commitSurfTex = commitSurfU.active ? commitSurfMgr.ensureGpuTextures(gl) : { mapTex: null };
      const commitHasSurf = !!(commitSurfU.active && commitSurfTex.mapTex);

      gl.scissor(1, 1, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workLit.fbo);
      gl.useProgram(this.progLight);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.workPaintA.tex);
      gl.uniform1i(this.lightLocs.u_paint, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.workStateA.tex);
      gl.uniform1i(this.lightLocs.u_state, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, commitHasSurf ? commitSurfTex.mapTex : this.tipTex);
      gl.uniform1i(this.lightLocs.u_surfaceMap, 2);
      gl.uniform1i(this.lightLocs.u_hasSurface, commitHasSurf ? 1 : 0);
      gl.uniform2f(this.lightLocs.u_simOrigin, workX, workY);
      gl.uniform1f(this.lightLocs.u_surfaceInvScale, commitSurfU.invScale || (1.0 / 320.0));
      gl.uniform1f(this.lightLocs.u_surfaceBiomeMix, commitSurfU.biomeMix ?? 0.88);
      gl.uniform1f(this.lightLocs.u_surfaceAllowRotate, commitSurfU.allowRotate ?? 1.0);
      gl.uniform1f(this.lightLocs.u_surfaceScaleSpread, commitSurfU.scaleSpread ?? 1.0);
      gl.uniform1f(this.lightLocs.u_surfRelief, commitSurfU.relief ?? 0.0);
      gl.uniform1f(this.lightLocs.u_heightShield, heightShield);
      gl.uniform1f(this.lightLocs.u_speedHeightMod, speedHeightMod);
      gl.uniform2f(this.lightLocs.u_texel, texel, texel);
      gl.uniform4f(this.lightLocs.u_uvClamp, 0.5 * texel, 0.5 * texel, (boxW - 0.5) * texel, (boxH - 0.5) * texel);
      gl.uniform1i(this.lightLocs.u_doShade, doShade);
      gl.uniform1f(this.lightLocs.u_bumpScale, depthRatio * 0.36);
      gl.uniform1f(this.lightLocs.u_diffIntensity, depthRatio * 1.08);
      gl.uniform1f(this.lightLocs.u_rimMax, depthRatio * 34.0);
      gl.uniform1f(this.lightLocs.u_specScale, glossRatio);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Unpremultiply workLit 1:1 into workPaintA at [1, 1, rw, rh]
      gl.viewport(0, 0, WORK_SIZE, WORK_SIZE);
      gl.scissor(1, 1, rw, rh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workPaintA.fbo);
      gl.useProgram(this.progUnpremult);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.workLit.tex);
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

      const sCX = engine.isStatic ? 0 : Math.floor(worldMinX / engine.chunkSize);
      const eCX = engine.isStatic ? 0 : Math.floor((worldMinX + rw - 1) / engine.chunkSize);
      const sCY = engine.isStatic ? 0 : Math.floor(worldMinY / engine.chunkSize);
      const eCY = engine.isStatic ? 0 : Math.floor((worldMinY + rh - 1) / engine.chunkSize);

      for (let cx = sCX; cx <= eCX; cx++) {
        for (let cy = sCY; cy <= eCY; cy++) {
          const chunk = engine._getChunk(cx, cy);
          if (!chunk) continue;

          const lx = engine.isStatic ? -engine.staticWidth * 0.5 : cx * engine.chunkSize;
          const ly = engine.isStatic ? -engine.staticHeight * 0.5 : cy * engine.chunkSize;
          const ox = Math.max(worldMinX, lx);
          const oy = Math.max(worldMinY, ly);
          const ox2 = Math.min(worldMinX + rw, lx + chunk.width);
          const oy2 = Math.min(worldMinY + rh, ly + chunk.height);
          const ow = ox2 - ox;
          const oh = oy2 - oy;
          if (ow <= 0 || oh <= 0) continue;
          this._ensureBackedUp(engine, chunk, cx, cy);

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
    this.hasCarried = false;
    this.gpuRenderer.fluidOverlay = null;
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
    this.hasCarried = false;
    if (this.gl) {
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    if (this.gpuRenderer) {
      this.gpuRenderer.fluidOverlay = null;
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
    for (let i = 0; i < this.tilePool.length; i++) {
      this._destroyTileGpu(this.tilePool[i]);
    }
    this.tilePool = [];
    this.touchedChunks.clear();

    const delTexFbo = (o) => {
      if (!o) return;
      if (o.fbo) gl.deleteFramebuffer(o.fbo);
      if (o.tex) gl.deleteTexture(o.tex);
    };
    [
      this.workStateA, this.workStateB, this.workPaintA, this.workPaintB,
      this.workLit, this.carriedA, this.carriedB
    ].forEach(delTexFbo);
    if (this.mrtWorkA) gl.deleteFramebuffer(this.mrtWorkA);
    if (this.mrtWorkB) gl.deleteFramebuffer(this.mrtWorkB);
    if (this.chunkBlitFbo) gl.deleteFramebuffer(this.chunkBlitFbo);
    if (this.tipTex) gl.deleteTexture(this.tipTex);
    [this.progRectMap, this.progPickup, this.progInject, this.progStreamer, this.progLight, this.progUnpremult].forEach(p => {
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
