import { WASM_BASE64 } from './wasmBinary.js';

class WasmCanvasCore {
  getMemBuffer() {
    if (this.exports && this.exports.memory) {
      this.memory = this.exports.memory;
    }
    return this.memory.buffer;
  }
  constructor() {
    this.instance = null;
    this.exports = null;
    this.memory = null;
    this.ready = false;
    this.liquifySessions = new Map();
    this._initSync();
  }

  _initSync() {
    try {
      const binaryString = atob(WASM_BASE64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const mod = new WebAssembly.Module(bytes);
      this.instance = new WebAssembly.Instance(mod, {});
      this.exports = this.instance.exports;
      this.memory = this.exports.memory;
      const heapBase = this.exports.__heap_base ? this.exports.__heap_base.value : 2097152;
      this.exports.wasm_init_heap(heapBase);
      this.exports.wasm_mark_scratch();
      this.ready = true;
    } catch (err) {
      console.error('Failed to initialize Rust WASM Canvas Core:', err);
      this.ready = false;
    }
  }

  /**
   * Displaces a full-resolution Liquify map in WASM memory
   */
  liquifyDisplaceFull(mapF32, w, localMinX, localMaxX, localMinY, localMaxY, clx, cly, p0x, p0y, vxStrength, vyStrength, r, exponent) {
    if (!this.ready || !mapF32 || w <= 0) return false;
    const h = Math.floor(mapF32.length / (w * 2));
    if (h <= 0) return false;

    // Strict boundary clamping to prevent any negative offsets or buffer overflow
    const cMinX = Math.max(0, Math.min(w - 1, Math.floor(localMinX)));
    const cMaxX = Math.max(0, Math.min(w - 1, Math.ceil(localMaxX)));
    const cMinY = Math.max(0, Math.min(h - 1, Math.floor(localMinY)));
    const cMaxY = Math.max(0, Math.min(h - 1, Math.ceil(localMaxY)));
    if (cMaxX < cMinX || cMaxY < cMinY) return false;

    const rowStart = (cMinY * w * 2) >>> 0;
    const rowEnd = ((cMaxY + 1) * w * 2) >>> 0;
    const sliceLen = rowEnd - rowStart;
    if (sliceLen <= 0 || rowEnd > mapF32.length) return false;

    const ex = this.exports;
    ex.wasm_reset_scratch();

    const mapPtr = (ex.wasm_alloc(mapF32.byteLength)) >>> 0;
    const buf = this.getMemBuffer();
    if (mapPtr + mapF32.byteLength > buf.byteLength) return false;

    const byteOffset = (mapPtr + rowStart * 4) >>> 0;
    if (byteOffset + sliceLen * 4 > this.getMemBuffer().byteLength) return false;

    new Float32Array(buf, byteOffset, sliceLen).set(mapF32.subarray(rowStart, rowEnd));

    ex.liquify_displace_full(
      mapPtr,
      w,
      cMinX,
      cMaxX,
      cMinY,
      cMaxY,
      clx,
      cly,
      p0x,
      p0y,
      vxStrength,
      vyStrength,
      r,
      exponent
    );

    const updated = new Float32Array(this.getMemBuffer(), byteOffset, sliceLen);
    mapF32.set(updated, rowStart);
    return true;
  }

  /**
   * Unified David Li Fluid Paint Session in Rust WASM
   */
  fluidSessionStart(w, h, cellSize = 4.0) {
    if (!this.ready || w <= 0 || h <= 0) return false;
    return this.exports.fluid_session_start(w, h, cellSize) === 1;
  }

  fluidSessionSetInputs(pixelsU8, heightF32, w, h) {
    if (!this.ready || !pixelsU8 || !heightF32 || w <= 0 || h <= 0) return false;
    const ex = this.exports;
    this.memory = ex.memory;
    const srcPixPtr = ex.fluid_session_get_src_pixels ? (ex.fluid_session_get_src_pixels() >>> 0) : 0;
    const srcHgtPtr = ex.fluid_session_get_src_height ? (ex.fluid_session_get_src_height() >>> 0) : 0;
    if (!srcPixPtr || !srcHgtPtr) return false;

    const count = (w * h) >>> 0;
    const pixBytes = count * 4;
    const buf = this.getMemBuffer();

    new Uint8Array(buf, srcPixPtr, pixBytes).set(pixelsU8);
    new Float32Array(buf, srcHgtPtr, count).set(heightF32);
    return true;
  }

  fluidSessionStep(
    ax, ay, bx, by, radius,
    brushR, brushG, brushB,
    opacity, flow, fluidity,
    valVortex, valTurb, valRetention,
    valPickup, valDepth, valGloss,
    bristles, isImpasto
  ) {
    if (!this.ready) return false;
    this.memory = this.exports.memory;
    return this.exports.fluid_session_step(
      ax, ay, bx, by, radius,
      brushR, brushG, brushB,
      opacity, flow, fluidity,
      valVortex, valTurb, valRetention,
      valPickup, valDepth, valGloss,
      bristles, isImpasto ? 1 : 0
    ) === 1;
  }

  fluidSessionGetOutputs(dstPixelsU8, dstHeightF32, w, h) {
    if (!this.ready || !dstPixelsU8 || !dstHeightF32 || w <= 0 || h <= 0) return false;
    const ex = this.exports;
    this.memory = ex.memory;
    const dstPixPtr = ex.fluid_session_get_dst_pixels ? (ex.fluid_session_get_dst_pixels() >>> 0) : 0;
    const dstHgtPtr = ex.fluid_session_get_dst_height ? (ex.fluid_session_get_dst_height() >>> 0) : 0;
    if (!dstPixPtr || !dstHgtPtr) return false;

    const count = (w * h) >>> 0;
    const pixBytes = count * 4;
    const buf = this.getMemBuffer();

    dstPixelsU8.set(new Uint8Array(buf, dstPixPtr, pixBytes));
    dstHeightF32.set(new Float32Array(buf, dstHgtPtr, count));
    return true;
  }

  fluidSessionEnd() {
    if (!this.ready) return;
    this.exports.fluid_session_end();
  }

  /**
   * Renders a Liquify bounding box in WASM and returns { ok, oobCount }
   */
  liquifyRenderBox(srcU8, dstU8, mapF32, w, h, minX, maxX, minY, maxY, bilinear = false) {
    if (!this.ready || !srcU8 || !dstU8 || !mapF32 || w <= 0 || h <= 0) return null;

    const cMinX = Math.max(0, Math.min(w - 1, Math.floor(minX)));
    const cMaxX = Math.max(0, Math.min(w - 1, Math.ceil(maxX)));
    const cMinY = Math.max(0, Math.min(h - 1, Math.floor(minY)));
    const cMaxY = Math.max(0, Math.min(h - 1, Math.ceil(maxY)));
    if (cMaxX < cMinX || cMaxY < cMinY) return null;

    const boxW = cMaxX - cMinX + 1;
    const boxH = cMaxY - cMinY + 1;
    const dstBytes = boxW * boxH * 4;
    if (dstU8.byteLength < dstBytes) return null;

    const ex = this.exports;
    ex.wasm_reset_scratch();

    const srcBytes = srcU8.byteLength;
    const mapBytes = mapF32.byteLength;

    const srcPtr = (ex.wasm_alloc(srcBytes)) >>> 0;
    const dstPtr = (ex.wasm_alloc(dstBytes)) >>> 0;
    const mapPtr = (ex.wasm_alloc(mapBytes)) >>> 0;

    const buf = this.getMemBuffer();
    if (mapPtr + mapBytes > buf.byteLength) return null;

    new Uint8Array(buf, srcPtr, srcBytes).set(srcU8);
    new Float32Array(buf, mapPtr, mapF32.length).set(mapF32);

    const oobCount = bilinear
      ? ex.liquify_render_box_bilinear(srcPtr, dstPtr, mapPtr, w, h, cMinX, cMaxX, cMinY, cMaxY)
      : ex.liquify_render_box_nearest(srcPtr, dstPtr, mapPtr, w, h, cMinX, cMaxX, cMinY, cMaxY);

    dstU8.set(new Uint8Array(this.getMemBuffer(), dstPtr, dstBytes));
    return { ok: true, oobCount };
  }

  /**
   * Displaces a Liquify grid in WASM memory and returns { hit, minGX, maxGX, minGY, maxGY }
   */
  liquifyDisplaceGrid(mapF32, gridW, gridH, cellSize, chunkLX, chunkLY, p0x, p0y, mvx, mvy, r, falloff) {
    if (!this.ready) return null;
    const ex = this.exports;
    ex.wasm_reset_scratch();

    const mapLen = mapF32.length;
    const mapBytes = (mapLen * 4) >>> 0;
    const mapPtr = (ex.wasm_alloc(mapBytes)) >>> 0;
    const scratchPtr = (ex.wasm_alloc(mapBytes)) >>> 0;
    const boundsPtr = (ex.wasm_alloc(16)) >>> 0;

    let memF32 = new Float32Array(this.getMemBuffer(), mapPtr, mapLen);
    memF32.set(mapF32);

    const hit = ex.liquify_displace_grid(
      mapPtr,
      scratchPtr,
      gridW,
      gridH,
      cellSize,
      chunkLX,
      chunkLY,
      p0x,
      p0y,
      mvx,
      mvy,
      r,
      falloff,
      boundsPtr
    );

    if (!hit) {
      return { hit: false };
    }

    // Re-create views in case memory grew
    memF32 = new Float32Array(this.getMemBuffer(), mapPtr, mapLen);
    mapF32.set(memF32);
    const boundsI32 = new Int32Array(this.getMemBuffer(), boundsPtr, 4);

    return {
      hit: true,
      minGX: boundsI32[0],
      maxGX: boundsI32[1],
      minGY: boundsI32[2],
      maxGY: boundsI32[3]
    };
  }

  /**
   * Warps pixels in WASM using either nearest-neighbor (fast live drag) or premultiplied bilinear (resolve/ultra)
   */
  liquifyWarpPixels(srcU8, dstU8, mapF32, w, h, gridW, gridH, invCellSize, minX, maxX, minY, maxY, bilinear = false) {
    if (!this.ready) return false;
    const ex = this.exports;
    ex.wasm_reset_scratch();

    const pixelBytes = (w * h * 4) >>> 0;
    const mapLen = mapF32.length;
    const mapBytes = (mapLen * 4) >>> 0;

    const srcPtr = (ex.wasm_alloc(pixelBytes)) >>> 0;
    const dstPtr = (ex.wasm_alloc(pixelBytes)) >>> 0;
    const mapPtr = (ex.wasm_alloc(mapBytes)) >>> 0;

    const buf = this.getMemBuffer();
    new Uint8Array(buf, srcPtr, pixelBytes).set(srcU8);
    new Uint8Array(buf, dstPtr, pixelBytes).set(dstU8);
    new Float32Array(buf, mapPtr, mapLen).set(mapF32);

    if (bilinear) {
      ex.liquify_warp_bilinear(
        srcPtr,
        dstPtr,
        mapPtr,
        w,
        h,
        gridW,
        gridH,
        invCellSize,
        minX,
        maxX,
        minY,
        maxY
      );
    } else {
      ex.liquify_warp_nearest(
        srcPtr,
        dstPtr,
        mapPtr,
        w,
        h,
        gridW,
        gridH,
        invCellSize,
        minX,
        maxX,
        minY,
        maxY
      );
    }

    dstU8.set(new Uint8Array(this.getMemBuffer(), dstPtr, pixelBytes));
    return true;
  }

  /**
   * Runs the Air Paint curl-noise + directional blow + radial pressure advection in Rust WASM
   */
  airAdvectRegion(srcU8, dstU8, bw, bh, bx, by, cx, cy, radius, turbScale, turbPower, blowVx, blowVy, radialPush, diffusion, phase) {
    if (!this.ready) return false;
    const ex = this.exports;
    ex.wasm_reset_scratch();

    const byteLen = bw * bh * 4;
    const srcPtr = ex.wasm_alloc(byteLen);
    const dstPtr = ex.wasm_alloc(byteLen);

    new Uint8Array(this.getMemBuffer(), srcPtr, byteLen).set(srcU8);

    const modified = ex.air_advect_region(
      srcPtr,
      dstPtr,
      bw,
      bh,
      bx,
      by,
      cx,
      cy,
      radius,
      turbScale,
      turbPower,
      blowVx,
      blowVy,
      radialPush,
      diffusion,
      phase
    );

    if (modified) {
      dstU8.set(new Uint8Array(this.getMemBuffer(), dstPtr, byteLen));
      return true;
    }
    return false;
  }

  /**
   * Persistent Liquify Session Management:
   * Keeps src image and displacement map inside WASM memory for the entire stroke duration.
   * Completely avoids copying multi-megabyte image arrays across the JS-WASM boundary on every mouse move!
   */
  liquifyGetOrCreateSession(chunkId, srcU8, w, h) {
    if (!this.ready || !srcU8 || w <= 0 || h <= 0) return null;
    let session = this.liquifySessions.get(chunkId);
    if (session && session.w === w && session.h === h) {
      return session;
    }

    const ex = this.exports;
    const srcBytes = (w * h * 4) >>> 0;
    const mapBytes = (w * h * 2 * 4) >>> 0;

    const srcPtr = ex.wasm_alloc(srcBytes) >>> 0;
    const mapPtr = ex.wasm_alloc(mapBytes) >>> 0;
    if (!srcPtr || !mapPtr) return null;

    let buf = this.getMemBuffer();
    new Uint8Array(buf, srcPtr, srcBytes).set(srcU8);
    new Uint8Array(buf, mapPtr, mapBytes).fill(0); // Zero-fill initial displacement

    ex.wasm_mark_scratch();

    session = {
      chunkId,
      w,
      h,
      srcPtr,
      mapPtr
    };
    this.liquifySessions.set(chunkId, session);
    return session;
  }

  liquifyDisplaceSession(session, localMinX, localMaxX, localMinY, localMaxY, clx, cly, p0x, p0y, vxStrength, vyStrength, r, exponent) {
    if (!this.ready || !session) return false;
    const { w, h, mapPtr } = session;

    const cMinX = Math.max(0, Math.min(w - 1, Math.floor(localMinX)));
    const cMaxX = Math.max(0, Math.min(w - 1, Math.ceil(localMaxX)));
    const cMinY = Math.max(0, Math.min(h - 1, Math.floor(localMinY)));
    const cMaxY = Math.max(0, Math.min(h - 1, Math.ceil(localMaxY)));
    if (cMaxX < cMinX || cMaxY < cMinY) return false;

    // Displaces directly in WASM memory without any data transfers!
    this.exports.liquify_displace_full(
      mapPtr,
      w,
      cMinX,
      cMaxX,
      cMinY,
      cMaxY,
      clx,
      cly,
      p0x,
      p0y,
      vxStrength,
      vyStrength,
      r,
      exponent
    );
    return true;
  }

  liquifyRenderSession(session, minX, maxX, minY, maxY, dstU8, bilinear = true) {
    if (!this.ready || !session || !dstU8) return false;
    const { w, h, srcPtr, mapPtr } = session;

    const cMinX = Math.max(0, Math.min(w - 1, Math.floor(minX)));
    const cMaxX = Math.max(0, Math.min(w - 1, Math.ceil(maxX)));
    const cMinY = Math.max(0, Math.min(h - 1, Math.floor(minY)));
    const cMaxY = Math.max(0, Math.min(h - 1, Math.ceil(maxY)));
    if (cMaxX < cMinX || cMaxY < cMinY) return false;

    const boxW = cMaxX - cMinX + 1;
    const boxH = cMaxY - cMinY + 1;
    const dstBytes = (boxW * boxH * 4) >>> 0;
    if (dstU8.byteLength < dstBytes) return false;

    const ex = this.exports;
    ex.wasm_reset_scratch();
    const dstPtr = ex.wasm_alloc(dstBytes) >>> 0;
    if (!dstPtr) return false;

    if (bilinear) {
      ex.liquify_render_box_bilinear(srcPtr, dstPtr, mapPtr, w, h, cMinX, cMaxX, cMinY, cMaxY);
    } else {
      ex.liquify_render_box_nearest(srcPtr, dstPtr, mapPtr, w, h, cMinX, cMaxX, cMinY, cMaxY);
    }

    dstU8.set(new Uint8Array(this.getMemBuffer(), dstPtr, dstBytes));
    ex.wasm_reset_scratch();
    return true;
  }

  liquifyEndAllSessions() {
    this.liquifySessions.clear();
    if (this.ready) {
      this.exports.liquify_session_end();
      const heapBase = this.exports.__heap_base ? this.exports.__heap_base.value : 2097152;
      this.exports.wasm_init_heap(heapBase);
      this.exports.wasm_mark_scratch();
    }
  }

  /**
   * Unified Liquify Stroke Session in Rust WASM
   */
  liquifyPrewarm(w = 2048, h = 2048, cellSize = 8) {
    if (!this.ready) return false;
    return this.exports.liquify_session_start(w, h, cellSize, 0, 0) === 1;
  }

  liquifySessionStart(w, h, cellSize, originX, originY) {
    if (!this.ready || w <= 0 || h <= 0) return false;
    const res = this.exports.liquify_session_start(w, h, cellSize, originX, originY);
    return res === 1;
  }

  liquifySessionGetGridPtr() {
    if (!this.ready) return 0;
    const ex = this.exports;
    const srcPtr = ex.liquify_session_get_src_ptr ? (ex.liquify_session_get_src_ptr() >>> 0) : 0;
    const sessW = ex.liquify_session_get_w ? ex.liquify_session_get_w() : 2048;
    const sessH = ex.liquify_session_get_h ? ex.liquify_session_get_h() : 2048;
    const imgBytes = sessW * sessH * 4;
    const allocImg = imgBytes < 16 * 1024 * 1024 ? 16 * 1024 * 1024 : imgBytes;
    return srcPtr + allocImg;
  }

  liquifySessionStampSrc(chunkU8, chunkW, chunkH, dstX, dstY) {
    if (!this.ready || !chunkU8 || chunkW <= 0 || chunkH <= 0) return false;
    const ex = this.exports;
    const srcPtr = ex.liquify_session_get_src_ptr ? (ex.liquify_session_get_src_ptr() >>> 0) : 0;
    const sessW = ex.liquify_session_get_w ? ex.liquify_session_get_w() : 2048;
    const sessH = ex.liquify_session_get_h ? ex.liquify_session_get_h() : 2048;

    if (srcPtr !== 0 && sessW > 0 && sessH > 0) {
      // Direct fast row-by-row write into WASM memory - 0 allocations!
      const x0 = Math.max(0, Math.min(sessW, dstX));
      const x1 = Math.max(0, Math.min(sessW, dstX + chunkW));
      const y0 = Math.max(0, Math.min(sessH, dstY));
      const y1 = Math.max(0, Math.min(sessH, dstY + chunkH));
      if (x0 >= x1 || y0 >= y1) return true;

      const copyW = x1 - x0;
      const copyBytes = copyW * 4;
      const buf = this.getMemBuffer();
      const memU8 = new Uint8Array(buf);

      for (let y = y0; y < y1; y++) {
        const cy = y - dstY;
        const cx = x0 - dstX;
        const srcOffset = (cy * chunkW + cx) * 4;
        const dstOffset = srcPtr + ((y * sessW + x0) * 4);
        memU8.set(
          chunkU8.subarray(srcOffset, srcOffset + copyBytes),
          dstOffset
        );
      }
      return true;
    }

    const byteLen = (chunkW * chunkH * 4) >>> 0;
    const chunkPtr = (ex.wasm_alloc(byteLen)) >>> 0;
    if (!chunkPtr) return false;
    new Uint8Array(this.getMemBuffer(), chunkPtr, byteLen).set(chunkU8);
    const res = ex.liquify_session_stamp_src(chunkPtr, chunkW, chunkH, dstX, dstY);
    return res === 1;
  }

  liquifySessionDisplace(p0X, p0Y, mvX, mvY, r, falloff) {
    if (!this.ready || r <= 0) return false;
    const res = this.exports.liquify_session_displace(p0X, p0Y, mvX, mvY, r, falloff);
    return res === 1;
  }

  liquifySessionWarpBox(minX, maxX, minY, maxY, dstBoxU8) {
    if (!this.ready || !dstBoxU8) return false;
    const cMinX = Math.max(0, Math.floor(minX));
    const cMaxX = Math.max(0, Math.ceil(maxX));
    const cMinY = Math.max(0, Math.floor(minY));
    const cMaxY = Math.max(0, Math.ceil(maxY));
    if (cMaxX < cMinX || cMaxY < cMinY) return false;

    const boxW = cMaxX - cMinX + 1;
    const boxH = cMaxY - cMinY + 1;
    const boxBytes = (boxW * boxH * 4) >>> 0;
    if (dstBoxU8.byteLength < boxBytes) return false;

    const ex = this.exports;
    const staticOutPtr = ex.liquify_session_get_warp_out_ptr ? (ex.liquify_session_get_warp_out_ptr() >>> 0) : 0;
    const outPtr = staticOutPtr || (ex.wasm_alloc(boxBytes) >>> 0);
    if (!outPtr) return false;

    const ok = ex.liquify_session_warp_box(cMinX, cMaxX, cMinY, cMaxY, outPtr);
    if (!ok) return false;

    dstBoxU8.set(new Uint8Array(this.getMemBuffer(), outPtr, boxBytes));
    return true;
  }

  liquifySessionEnd() {
    if (!this.ready) return;
    this.exports.liquify_session_end();
  }

  /**
   * Fast buffer empty check in Rust WASM (SIMD / 32-bit word scanning)
   */
  isBufferEmpty(u32Array) {
    if (!this.ready || !u32Array || u32Array.length === 0) return true;
    const count = u32Array.length;
    const byteLen = count * 4;
    const ex = this.exports;
    ex.wasm_reset_scratch();
    const ptr = ex.wasm_alloc(byteLen) >>> 0;
    if (!ptr) return false;
    new Uint32Array(this.getMemBuffer(), ptr, count).set(u32Array);
    const res = ex.is_buffer_empty(ptr, count);
    ex.wasm_reset_scratch();
    return res === 1;
  }

  /**
   * Converts RGBA image data in-place into a black brush tip alpha mask via Rust WASM
   */
  rgbaToTipMask(u8Data) {
    if (!this.ready) return false;
    const ex = this.exports;
    ex.wasm_reset_scratch();

    const byteLen = u8Data.byteLength;
    const ptr = ex.wasm_alloc(byteLen);
    new Uint8Array(this.getMemBuffer(), ptr, byteLen).set(u8Data);
    ex.rgba_to_tip_mask(ptr, byteLen >> 2);
    u8Data.set(new Uint8Array(this.getMemBuffer(), ptr, byteLen));
    return true;
  }
}

export const wasmCore = new WasmCanvasCore();
