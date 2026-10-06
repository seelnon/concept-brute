#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// Simple deterministic arena allocator in WASM linear memory.
// Memory layout:
// Static data + stack live below 1MB (1048576).
// We manage heap allocations starting at 2MB (2097152) upward, growing WASM pages (64KB each) on demand.
static mut HEAP_TOP: usize = 2097152;
static mut SCRATCH_BASE: usize = 2097152;

#[inline(always)]
unsafe fn ensure_capacity(required_end: usize) -> bool {
    let current_pages = core::arch::wasm32::memory_size(0);
    let current_bytes = current_pages * 65536;
    if required_end > current_bytes {
        let needed_bytes = required_end - current_bytes;
        let needed_pages = (needed_bytes + 65535) / 65536;
        let res = core::arch::wasm32::memory_grow(0, needed_pages);
        if res == usize::MAX {
            return false;
        }
    }
    true
}

#[no_mangle]
pub unsafe extern "C" fn wasm_init_heap(base: usize) -> usize {
    let aligned = (base + 15) & !15;
    let start = if aligned < 2097152 { 2097152 } else { aligned };
    HEAP_TOP = start;
    SCRATCH_BASE = start;
    start
}

#[no_mangle]
pub unsafe extern "C" fn wasm_alloc(size: usize) -> usize {
    if size == 0 || size > 500_000_000 {
        return 0;
    }
    let aligned_size = (size + 15) & !15;
    let ptr = (HEAP_TOP + 15) & !15;
    let new_top = match ptr.checked_add(aligned_size) {
        Some(top) => top,
        None => return 0,
    };
    if !ensure_capacity(new_top) {
        return 0;
    }
    HEAP_TOP = new_top;
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn wasm_mark_scratch() -> usize {
    SCRATCH_BASE = HEAP_TOP;
    SCRATCH_BASE
}

#[no_mangle]
pub unsafe extern "C" fn wasm_reset_scratch() {
    HEAP_TOP = SCRATCH_BASE;
}

#[inline(always)]
fn clamp_i32(val: i32, min_val: i32, max_val: i32) -> i32 {
    if val < min_val {
        min_val
    } else if val > max_val {
        max_val
    } else {
        val
    }
}

#[inline(always)]
fn clamp_f32(val: f32, min_val: f32, max_val: f32) -> f32 {
    if val.is_nan() {
        return min_val;
    }
    if val < min_val {
        min_val
    } else if val > max_val {
        max_val
    } else {
        val
    }
}

#[inline(always)]
fn floor_f32(x: f32) -> i32 {
    if x.is_nan() {
        return 0;
    }
    if x <= -2147483648.0 {
        return i32::MIN;
    }
    if x >= 2147483647.0 {
        return i32::MAX;
    }
    let xi = x as i32;
    if x < (xi as f32) { xi - 1 } else { xi }
}

#[inline(always)]
fn ceil_f32(x: f32) -> i32 {
    if x.is_nan() {
        return 0;
    }
    if x <= -2147483648.0 {
        return i32::MIN;
    }
    if x >= 2147483647.0 {
        return i32::MAX;
    }
    let xi = x as i32;
    if x > (xi as f32) { xi + 1 } else { xi }
}

#[inline(always)]
fn sqrt_f32(x: f32) -> f32 {
    if x <= 0.0 || x.is_nan() {
        return 0.0;
    }
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::f32x4_extract_lane::<0>(
            core::arch::wasm32::f32x4_sqrt(core::arch::wasm32::f32x4_splat(x)),
        )
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        x
    }
}

#[inline(always)]
fn pow_f32_approx(base: f32, exp: f32) -> f32 {
    if base <= 0.0 || base.is_nan() {
        return 0.0;
    }
    if (exp - 2.0).abs() < 0.01 {
        return base * base;
    }
    if (exp - 1.0).abs() < 0.01 {
        return base;
    }
    if (exp - 4.0).abs() < 0.01 {
        let b2 = base * base;
        return b2 * b2;
    }
    // Smooth rational Pade-like power approximation for [0,1] falloff curves
    let b2 = base * base;
    let b4 = b2 * b2;
    let t = clamp_f32((exp - 0.5) / 3.5, 0.0, 1.0);
    base * (1.0 - t) + b4 * t
}

#[no_mangle]
pub unsafe extern "C" fn liquify_displace_full(
    map_ptr: *mut f32,
    w: i32,
    local_min_x: i32,
    local_max_x: i32,
    local_min_y: i32,
    local_max_y: i32,
    clx: f32,
    cly: f32,
    p0_x: f32,
    p0_y: f32,
    vx_strength: f32,
    vy_strength: f32,
    r: f32,
    exponent: f32,
) {
    if map_ptr.is_null() || w <= 0 || r <= 0.0 {
        return;
    }
    let r_sq = r * r;
    let inv_r_sq = 1.0 / r_sq;
    let w_usize = w as usize;

    for y in local_min_y..=local_max_y {
        let world_y = cly + (y as f32);
        let dy = world_y - p0_y;
        let dy_sq = dy * dy;
        if dy_sq >= r_sq {
            continue;
        }
        let row_offset = (y as usize) * w_usize;

        for x in local_min_x..=local_max_x {
            let world_x = clx + (x as f32);
            let dx = world_x - p0_x;
            let dist_sq = dx * dx + dy_sq;
            if dist_sq < r_sq {
                let one_minus_r2 = 1.0 - dist_sq * inv_r_sq;
                let weight = pow_f32_approx(one_minus_r2, exponent);
                let idx = (row_offset + (x as usize)) * 2;
                *map_ptr.add(idx) -= weight * vx_strength;
                *map_ptr.add(idx + 1) -= weight * vy_strength;
            }
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn liquify_render_box_nearest(
    src_u8: *const u8,
    dst_u8: *mut u8,
    map_ptr: *const f32,
    w: i32,
    h: i32,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
) -> i32 {
    if src_u8.is_null() || dst_u8.is_null() || map_ptr.is_null() || w <= 0 || h <= 0 || min_x > max_x || min_y > max_y {
        return 0;
    }
    let min_x = clamp_i32(min_x, 0, w - 1);
    let max_x = clamp_i32(max_x, 0, w - 1);
    let min_y = clamp_i32(min_y, 0, h - 1);
    let max_y = clamp_i32(max_y, 0, h - 1);
    if min_x > max_x || min_y > max_y {
        return 0;
    }
    let w_usize = w as usize;
    let box_w = (max_x - min_x + 1) as usize;
    let src_u32 = src_u8 as *const u32;
    let dst_u32 = dst_u8 as *mut u32;

    for y in min_y..=max_y {
        let local_y = (y - min_y) as usize;
        let row_map = (y as usize) * w_usize;
        let dst_row = local_y * box_w;

        for x in min_x..=max_x {
            let local_x = (x - min_x) as usize;
            let idx = (row_map + (x as usize)) * 2;
            let dx = *map_ptr.add(idx);
            let dy = *map_ptr.add(idx + 1);
            let dst_pixel = dst_row + local_x;

            if dx == 0.0 && dy == 0.0 {
                *dst_u32.add(dst_pixel) = *src_u32.add(row_map + (x as usize));
            } else {
                let sx = clamp_i32(floor_f32((x as f32) + dx + 0.5), 0, w - 1);
                let sy = clamp_i32(floor_f32((y as f32) + dy + 0.5), 0, h - 1);
                *dst_u32.add(dst_pixel) =
                    *src_u32.add((sy as usize) * w_usize + (sx as usize));
            }
        }
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn liquify_render_box_bilinear(
    src_u8: *const u8,
    dst_u8: *mut u8,
    map_ptr: *const f32,
    w: i32,
    h: i32,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
) -> i32 {
    if src_u8.is_null() || dst_u8.is_null() || map_ptr.is_null() || w <= 0 || h <= 0 || min_x > max_x || min_y > max_y {
        return 0;
    }
    let min_x = clamp_i32(min_x, 0, w - 1);
    let max_x = clamp_i32(max_x, 0, w - 1);
    let min_y = clamp_i32(min_y, 0, h - 1);
    let max_y = clamp_i32(max_y, 0, h - 1);
    if min_x > max_x || min_y > max_y {
        return 0;
    }
    let w_usize = w as usize;
    let box_w = (max_x - min_x + 1) as usize;
    let src_u32 = src_u8 as *const u32;
    let dst_u32 = dst_u8 as *mut u32;

    for y in min_y..=max_y {
        let local_y = (y - min_y) as usize;
        let row_map = (y as usize) * w_usize;
        let dst_row = local_y * box_w;

        for x in min_x..=max_x {
            let local_x = (x - min_x) as usize;
            let idx = (row_map + (x as usize)) * 2;
            let dx = *map_ptr.add(idx);
            let dy = *map_ptr.add(idx + 1);
            let dst_pixel = dst_row + local_x;

            if dx == 0.0 && dy == 0.0 {
                *dst_u32.add(dst_pixel) = *src_u32.add(row_map + (x as usize));
            } else {
                let src_x = (x as f32) + dx;
                let src_y = (y as f32) + dy;
                let x0 = floor_f32(src_x);
                let y0 = floor_f32(src_y);

                let cx0 = clamp_i32(x0, 0, w - 1);
                let cy0 = clamp_i32(y0, 0, h - 1);
                let cx1 = clamp_i32(x0 + 1, 0, w - 1);
                let cy1 = clamp_i32(y0 + 1, 0, h - 1);

                let tx = clamp_f32(src_x - (x0 as f32), 0.0, 1.0);
                let ty = clamp_f32(src_y - (y0 as f32), 0.0, 1.0);
                let idx00 = ((cy0 as usize) * w_usize + (cx0 as usize)) * 4;
                let idx10 = ((cy0 as usize) * w_usize + (cx1 as usize)) * 4;
                let idx01 = ((cy1 as usize) * w_usize + (cx0 as usize)) * 4;
                let idx11 = ((cy1 as usize) * w_usize + (cx1 as usize)) * 4;

                let dst_byte = dst_pixel * 4;
                for c in 0..4 {
                    let c00 = *src_u8.add(idx00 + c) as f32;
                    let c10 = *src_u8.add(idx10 + c) as f32;
                    let c01 = *src_u8.add(idx01 + c) as f32;
                    let c11 = *src_u8.add(idx11 + c) as f32;
                    let r0 = c00 + tx * (c10 - c00);
                    let r1 = c01 + tx * (c11 - c01);
                    *dst_u8.add(dst_byte + c) = (r0 + ty * (r1 - r0) + 0.5) as u8;
                }
            }
        }
    }
    0
}

// ============================================================================
// 1. LIQUIFY DISPLACEMENT GRID & PIXEL WARPING KERNELS
// ============================================================================

#[no_mangle]
pub unsafe extern "C" fn liquify_displace_grid(
    map_ptr: *mut f32,
    scratch_old_ptr: *mut f32,
    grid_w: i32,
    grid_h: i32,
    cell_size: f32,
    chunk_lx: f32,
    chunk_ly: f32,
    p0_x: f32,
    p0_y: f32,
    mv_x: f32,
    mv_y: f32,
    r: f32,
    falloff: f32,
    out_bounds_ptr: *mut i32,
) -> i32 {
    let r_sq = r * r;
    let inv_r_sq = 1.0 / r_sq;
    let inv_cell = 1.0 / cell_size;

    let min_gx = clamp_i32(floor_f32((p0_x - r - chunk_lx) * inv_cell), 0, grid_w - 1);
    let max_gx = clamp_i32(ceil_f32((p0_x + r - chunk_lx) * inv_cell), 0, grid_w - 1);
    let min_gy = clamp_i32(floor_f32((p0_y - r - chunk_ly) * inv_cell), 0, grid_h - 1);
    let max_gy = clamp_i32(ceil_f32((p0_y + r - chunk_ly) * inv_cell), 0, grid_h - 1);

    if min_gx > max_gx || min_gy > max_gy {
        return 0;
    }

    let move_dist = sqrt_f32(mv_x * mv_x + mv_y * mv_y);
    let margin = ceil_f32(move_dist * inv_cell) + 2;
    let s_min_gx = clamp_i32(min_gx - margin, 0, grid_w - 1);
    let s_max_gx = clamp_i32(max_gx + margin, 0, grid_w - 1);
    let s_min_gy = clamp_i32(min_gy - margin, 0, grid_h - 1);
    let s_max_gy = clamp_i32(max_gy + margin, 0, grid_h - 1);

    let gw_usize = grid_w as usize;
    // Copy affected region + margin into scratch_old_ptr
    for gy in s_min_gy..=s_max_gy {
        let row_offset = (gy as usize) * gw_usize * 2;
        let start_idx = row_offset + (s_min_gx as usize) * 2;
        let count = ((s_max_gx - s_min_gx + 1) as usize) * 2;
        core::ptr::copy_nonoverlapping(
            map_ptr.add(start_idx),
            scratch_old_ptr.add(start_idx),
            count,
        );
    }

    let max_gx_f = (grid_w - 1) as f32;
    let max_gy_f = (grid_h - 1) as f32;

    for gy in min_gy..=max_gy {
        let wy = chunk_ly + (gy as f32) * cell_size;
        let dy = wy - p0_y;
        let dy2 = dy * dy;
        if dy2 >= r_sq {
            continue;
        }
        let row_idx = (gy as usize) * gw_usize;

        for gx in min_gx..=max_gx {
            let wx = chunk_lx + (gx as f32) * cell_size;
            let dx = wx - p0_x;
            let d2 = dx * dx + dy2;
            if d2 < r_sq {
                let w = if falloff >= 0.99 {
                    let u2 = d2 * inv_r_sq;
                    let t = 1.0 - (u2 * u2 * u2);
                    t * t
                } else if falloff >= 0.45 {
                    let t = 1.0 - (d2 * inv_r_sq);
                    t * t
                } else {
                    let d = sqrt_f32(d2);
                    let t = 1.0 - (d / r);
                    t * t * t
                };

                let pull_x = wx - mv_x * w;
                let pull_y = wy - mv_y * w;

                let pull_gx = clamp_f32((pull_x - chunk_lx) * inv_cell, 0.0, max_gx_f);
                let pull_gy = clamp_f32((pull_y - chunk_ly) * inv_cell, 0.0, max_gy_f);

                let gx0 = clamp_i32(floor_f32(pull_gx), s_min_gx, s_max_gx);
                let gy0 = clamp_i32(floor_f32(pull_gy), s_min_gy, s_max_gy);
                let gx1 = clamp_i32(gx0 + 1, s_min_gx, s_max_gx);
                let gy1 = clamp_i32(gy0 + 1, s_min_gy, s_max_gy);

                let tx = pull_gx - (gx0 as f32);
                let ty = pull_gy - (gy0 as f32);
                let inv_tx = 1.0 - tx;
                let inv_ty = 1.0 - ty;

                let i00 = ((gy0 as usize) * gw_usize + (gx0 as usize)) * 2;
                let i10 = ((gy0 as usize) * gw_usize + (gx1 as usize)) * 2;
                let i01 = ((gy1 as usize) * gw_usize + (gx0 as usize)) * 2;
                let i11 = ((gy1 as usize) * gw_usize + (gx1 as usize)) * 2;

                let w00 = inv_tx * inv_ty;
                let w10 = tx * inv_ty;
                let w01 = inv_tx * ty;
                let w11 = tx * ty;

                let prev_dx = (*scratch_old_ptr.add(i00)) * w00
                    + (*scratch_old_ptr.add(i10)) * w10
                    + (*scratch_old_ptr.add(i01)) * w01
                    + (*scratch_old_ptr.add(i11)) * w11;

                let prev_dy = (*scratch_old_ptr.add(i00 + 1)) * w00
                    + (*scratch_old_ptr.add(i10 + 1)) * w10
                    + (*scratch_old_ptr.add(i01 + 1)) * w01
                    + (*scratch_old_ptr.add(i11 + 1)) * w11;

                let idx = (row_idx + (gx as usize)) * 2;
                *map_ptr.add(idx) = prev_dx + mv_x * w;
                *map_ptr.add(idx + 1) = prev_dy + mv_y * w;
            }
        }
    }

    if !out_bounds_ptr.is_null() {
        *out_bounds_ptr.add(0) = min_gx;
        *out_bounds_ptr.add(1) = max_gx;
        *out_bounds_ptr.add(2) = min_gy;
        *out_bounds_ptr.add(3) = max_gy;
    }

    1
}

#[no_mangle]
pub unsafe extern "C" fn liquify_warp_nearest(
    src_u32: *const u32,
    dst_u32: *mut u32,
    map_ptr: *const f32,
    w: i32,
    h: i32,
    grid_w: i32,
    grid_h: i32,
    inv_cell: f32,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
) {
    let w_usize = w as usize;
    let gw_usize = grid_w as usize;
    let max_x_idx = w - 1;
    let max_y_idx = h - 1;
    let max_gx_idx = grid_w - 2;
    let max_gy_idx = grid_h - 2;

    let x_start = clamp_i32(min_x, 0, w);
    let x_end = clamp_i32(max_x, 0, w);
    let y_start = clamp_i32(min_y, 0, h);
    let y_end = clamp_i32(max_y, 0, h);

    for y in y_start..y_end {
        let gy_f = (y as f32) * inv_cell;
        let gy0 = clamp_i32(gy_f as i32, 0, max_gy_idx);
        let gy1 = gy0 + 1;
        let ty = gy_f - (gy0 as f32);
        let inv_ty = 1.0 - ty;

        let row0_offset = (gy0 as usize) * gw_usize;
        let row1_offset = (gy1 as usize) * gw_usize;
        let dst_row_offset = (y as usize) * w_usize;

        for x in x_start..x_end {
            let gx_f = (x as f32) * inv_cell;
            let gx0 = clamp_i32(gx_f as i32, 0, max_gx_idx);
            let gx1 = gx0 + 1;
            let tx = gx_f - (gx0 as f32);
            let inv_tx = 1.0 - tx;

            let i00 = (row0_offset + (gx0 as usize)) * 2;
            let i10 = (row0_offset + (gx1 as usize)) * 2;
            let i01 = (row1_offset + (gx0 as usize)) * 2;
            let i11 = (row1_offset + (gx1 as usize)) * 2;

            let w00 = inv_tx * inv_ty;
            let w10 = tx * inv_ty;
            let w01 = inv_tx * ty;
            let w11 = tx * ty;

            let dx = (*map_ptr.add(i00)) * w00
                + (*map_ptr.add(i10)) * w10
                + (*map_ptr.add(i01)) * w01
                + (*map_ptr.add(i11)) * w11;

            let dy = (*map_ptr.add(i00 + 1)) * w00
                + (*map_ptr.add(i10 + 1)) * w10
                + (*map_ptr.add(i01 + 1)) * w01
                + (*map_ptr.add(i11 + 1)) * w11;

            let sx = clamp_i32(floor_f32((x as f32) - dx + 0.5), 0, max_x_idx);
            let sy = clamp_i32(floor_f32((y as f32) - dy + 0.5), 0, max_y_idx);

            *dst_u32.add(dst_row_offset + (x as usize)) =
                *src_u32.add((sy as usize) * w_usize + (sx as usize));
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn liquify_warp_bilinear(
    src_u8: *const u8,
    dst_u8: *mut u8,
    map_ptr: *const f32,
    w: i32,
    h: i32,
    grid_w: i32,
    grid_h: i32,
    inv_cell: f32,
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
) {
    let w_usize = w as usize;
    let gw_usize = grid_w as usize;
    let max_x_f = (w - 1) as f32;
    let max_y_f = (h - 1) as f32;
    let max_x_idx = w - 1;
    let max_y_idx = h - 1;
    let max_gx_idx = grid_w - 2;
    let max_gy_idx = grid_h - 2;

    let src_u32 = src_u8 as *const u32;
    let dst_u32 = dst_u8 as *mut u32;

    let x_start = clamp_i32(min_x, 0, w);
    let x_end = clamp_i32(max_x, 0, w);
    let y_start = clamp_i32(min_y, 0, h);
    let y_end = clamp_i32(max_y, 0, h);

    for y in y_start..y_end {
        let gy_f = (y as f32) * inv_cell;
        let gy0 = clamp_i32(gy_f as i32, 0, max_gy_idx);
        let gy1 = gy0 + 1;
        let ty = gy_f - (gy0 as f32);
        let inv_ty = 1.0 - ty;

        let row0_offset = (gy0 as usize) * gw_usize;
        let row1_offset = (gy1 as usize) * gw_usize;
        let dst_row_offset = (y as usize) * w_usize;

        for x in x_start..x_end {
            let gx_f = (x as f32) * inv_cell;
            let gx0 = clamp_i32(gx_f as i32, 0, max_gx_idx);
            let gx1 = gx0 + 1;
            let tx = gx_f - (gx0 as f32);
            let inv_tx = 1.0 - tx;

            let i00 = (row0_offset + (gx0 as usize)) * 2;
            let i10 = (row0_offset + (gx1 as usize)) * 2;
            let i01 = (row1_offset + (gx0 as usize)) * 2;
            let i11 = (row1_offset + (gx1 as usize)) * 2;

            let w00 = inv_tx * inv_ty;
            let w10 = tx * inv_ty;
            let w01 = inv_tx * ty;
            let w11 = tx * ty;

            let dx = (*map_ptr.add(i00)) * w00
                + (*map_ptr.add(i10)) * w10
                + (*map_ptr.add(i01)) * w01
                + (*map_ptr.add(i11)) * w11;

            let dy = (*map_ptr.add(i00 + 1)) * w00
                + (*map_ptr.add(i10 + 1)) * w10
                + (*map_ptr.add(i01 + 1)) * w01
                + (*map_ptr.add(i11 + 1)) * w11;

            let dst_pixel_idx = dst_row_offset + (x as usize);

            if dx > -0.001 && dx < 0.001 && dy > -0.001 && dy < 0.001 {
                *dst_u32.add(dst_pixel_idx) = *src_u32.add(dst_pixel_idx);
                continue;
            }

            let sx = clamp_f32((x as f32) - dx, 0.0, max_x_f);
            let sy = clamp_f32((y as f32) - dy, 0.0, max_y_f);

            let x0 = sx as i32;
            let y0 = sy as i32;
            let x1 = if x0 < max_x_idx { x0 + 1 } else { x0 };
            let y1 = if y0 < max_y_idx { y0 + 1 } else { y0 };

            let fx = sx - (x0 as f32);
            let fy = sy - (y0 as f32);
            let ifx = 1.0 - fx;
            let ify = 1.0 - fy;

            let pw00 = ifx * ify;
            let pw10 = fx * ify;
            let pw01 = ifx * fy;
            let pw11 = fx * fy;

            let p00 = ((y0 as usize) * w_usize + (x0 as usize)) * 4;
            let p10 = ((y0 as usize) * w_usize + (x1 as usize)) * 4;
            let p01 = ((y1 as usize) * w_usize + (x0 as usize)) * 4;
            let p11 = ((y1 as usize) * w_usize + (x1 as usize)) * 4;

            let a00 = (*src_u8.add(p00 + 3) as f32) * pw00;
            let a10 = (*src_u8.add(p10 + 3) as f32) * pw10;
            let a01 = (*src_u8.add(p01 + 3) as f32) * pw01;
            let a11 = (*src_u8.add(p11 + 3) as f32) * pw11;
            let out_a = a00 + a10 + a01 + a11;

            let dst_byte_idx = dst_pixel_idx * 4;
            if out_a < 0.5 {
                *dst_u32.add(dst_pixel_idx) = 0;
            } else {
                let inv_a = 1.0 / out_a;
                let r = ((*src_u8.add(p00) as f32) * a00
                    + (*src_u8.add(p10) as f32) * a10
                    + (*src_u8.add(p01) as f32) * a01
                    + (*src_u8.add(p11) as f32) * a11)
                    * inv_a;
                let g = ((*src_u8.add(p00 + 1) as f32) * a00
                    + (*src_u8.add(p10 + 1) as f32) * a10
                    + (*src_u8.add(p01 + 1) as f32) * a01
                    + (*src_u8.add(p11 + 1) as f32) * a11)
                    * inv_a;
                let b = ((*src_u8.add(p00 + 2) as f32) * a00
                    + (*src_u8.add(p10 + 2) as f32) * a10
                    + (*src_u8.add(p01 + 2) as f32) * a01
                    + (*src_u8.add(p11 + 2) as f32) * a11)
                    * inv_a;

                *dst_u8.add(dst_byte_idx) = (r + 0.5) as u8;
                *dst_u8.add(dst_byte_idx + 1) = (g + 0.5) as u8;
                *dst_u8.add(dst_byte_idx + 2) = (b + 0.5) as u8;
                *dst_u8.add(dst_byte_idx + 3) = (out_a + 0.5) as u8;
            }
        }
    }
}

// ============================================================================
// 2. AIR PAINT AERODYNAMIC ADVECTION & CURL NOISE KERNEL
// ============================================================================

#[inline(always)]
fn hash2(x: i32, y: i32) -> f32 {
    let n = x.wrapping_mul(374761393).wrapping_add(y.wrapping_mul(668265263));
    let n2 = (n ^ (n >> 13)).wrapping_mul(1274126177);
    let u = ((n2 ^ (n2 >> 16)) as u32) & 0x7fffffff;
    (u as f32) / 2147483647.0
}

#[inline(always)]
fn noise2d(x: f32, y: f32) -> f32 {
    let ix = floor_f32(x);
    let iy = floor_f32(y);
    let fx = x - (ix as f32);
    let fy = y - (iy as f32);
    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);

    let a = hash2(ix, iy);
    let b = hash2(ix + 1, iy);
    let c = hash2(ix, iy + 1);
    let d = hash2(ix + 1, iy + 1);

    a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

#[no_mangle]
pub unsafe extern "C" fn air_advect_region(
    src_u8: *const u8,
    dst_u8: *mut u8,
    bw: i32,
    bh: i32,
    bx: f32,
    by: f32,
    cx: f32,
    cy: f32,
    radius: f32,
    turb_scale: f32,
    turb_power: f32,
    blow_vx: f32,
    blow_vy: f32,
    radial_push: f32,
    diffusion: f32,
    phase: f32,
) -> i32 {
    let r_sq = radius * radius;
    let bw_usize = bw as usize;
    let max_x_f = (bw - 1) as f32;
    let max_y_f = (bh - 1) as f32;
    let max_x_idx = bw - 1;
    let max_y_idx = bh - 1;

    let src_u32 = src_u8 as *const u32;
    let dst_u32 = dst_u8 as *mut u32;
    let total_pixels = (bw as usize) * (bh as usize);
    core::ptr::copy_nonoverlapping(src_u32, dst_u32, total_pixels);

    let mut modified: i32 = 0;
    let eps = 0.25_f32;
    let inv_2eps = 1.0 / (2.0 * eps);
    let inv_radius = 1.0 / radius;

    for py in 0..bh {
        let wy = by + (py as f32);
        let dy = wy - cy;
        let dy2 = dy * dy;
        if dy2 >= r_sq {
            continue;
        }
        let row_offset = (py as usize) * bw_usize;

        for px in 0..bw {
            let wx = bx + (px as f32);
            let dx = wx - cx;
            let d2 = dx * dx + dy2;
            if d2 >= r_sq {
                continue;
            }

            let dist = sqrt_f32(d2);
            let norm_d = dist * inv_radius;
            let t_fall = 1.0 - norm_d * norm_d;
            let falloff = t_fall * t_fall;

            let mut turb_vx = 0.0_f32;
            let mut turb_vy = 0.0_f32;
            if turb_power > 0.001 {
                let nx_coord = wx * turb_scale + phase;
                let ny_coord = wy * turb_scale + phase * 0.73;
                let n_up = noise2d(nx_coord, ny_coord + eps);
                let n_down = noise2d(nx_coord, ny_coord - eps);
                let n_right = noise2d(nx_coord + eps, ny_coord);
                let n_left = noise2d(nx_coord - eps, ny_coord);

                let curl_x = (n_up - n_down) * inv_2eps;
                let curl_y = -(n_right - n_left) * inv_2eps;
                turb_vx = curl_x * turb_power;
                turb_vy = curl_y * turb_power;
            }

            let inv_dist = if dist > 0.5 { 1.0 / dist } else { 0.0 };
            let r_nx = dx * inv_dist;
            let r_ny = dy * inv_dist;
            let radial_factor = norm_d * (1.0 - norm_d) * 4.0;

            let vx = (blow_vx + turb_vx + r_nx * radial_push * radial_factor) * falloff;
            let vy = (blow_vy + turb_vy + r_ny * radial_push * radial_factor) * falloff;

            if vx > -0.02 && vx < 0.02 && vy > -0.02 && vy < 0.02 {
                continue;
            }

            let src_x = clamp_f32((px as f32) - vx, 0.0, max_x_f);
            let src_y = clamp_f32((py as f32) - vy, 0.0, max_y_f);

            let x0 = src_x as i32;
            let y0 = src_y as i32;
            let x1 = if x0 < max_x_idx { x0 + 1 } else { x0 };
            let y1 = if y0 < max_y_idx { y0 + 1 } else { y0 };

            let fx = src_x - (x0 as f32);
            let fy = src_y - (y0 as f32);
            let w00 = (1.0 - fx) * (1.0 - fy);
            let w10 = fx * (1.0 - fy);
            let w01 = (1.0 - fx) * fy;
            let w11 = fx * fy;

            let i00 = ((y0 as usize) * bw_usize + (x0 as usize)) * 4;
            let i10 = ((y0 as usize) * bw_usize + (x1 as usize)) * 4;
            let i01 = ((y1 as usize) * bw_usize + (x0 as usize)) * 4;
            let i11 = ((y1 as usize) * bw_usize + (x1 as usize)) * 4;

            let a00 = (*src_u8.add(i00 + 3) as f32) * w00;
            let a10 = (*src_u8.add(i10 + 3) as f32) * w10;
            let a01 = (*src_u8.add(i01 + 3) as f32) * w01;
            let a11 = (*src_u8.add(i11 + 3) as f32) * w11;
            let out_a = a00 + a10 + a01 + a11;

            let dst_idx = (row_offset + (px as usize)) * 4;
            let orig_a = *src_u8.add(dst_idx + 3);
            if out_a < 0.5 && orig_a == 0 {
                continue;
            }

            modified = 1;
            if out_a > 0.5 {
                let inv_a = 1.0 / out_a;
                let mut r = ((*src_u8.add(i00) as f32) * a00
                    + (*src_u8.add(i10) as f32) * a10
                    + (*src_u8.add(i01) as f32) * a01
                    + (*src_u8.add(i11) as f32) * a11)
                    * inv_a;
                let mut g = ((*src_u8.add(i00 + 1) as f32) * a00
                    + (*src_u8.add(i10 + 1) as f32) * a10
                    + (*src_u8.add(i01 + 1) as f32) * a01
                    + (*src_u8.add(i11 + 1) as f32) * a11)
                    * inv_a;
                let mut b = ((*src_u8.add(i00 + 2) as f32) * a00
                    + (*src_u8.add(i10 + 2) as f32) * a10
                    + (*src_u8.add(i01 + 2) as f32) * a01
                    + (*src_u8.add(i11 + 2) as f32) * a11)
                    * inv_a;
                let mut final_a = out_a;

                if diffusion > 0.01 && orig_a > 0 {
                    let mix = diffusion * falloff;
                    let inv_mix = 1.0 - mix;
                    r = r * inv_mix + (*src_u8.add(dst_idx) as f32) * mix;
                    g = g * inv_mix + (*src_u8.add(dst_idx + 1) as f32) * mix;
                    b = b * inv_mix + (*src_u8.add(dst_idx + 2) as f32) * mix;
                    final_a = out_a * inv_mix + (orig_a as f32) * mix;
                }

                *dst_u8.add(dst_idx) = (r + 0.5) as u8;
                *dst_u8.add(dst_idx + 1) = (g + 0.5) as u8;
                *dst_u8.add(dst_idx + 2) = (b + 0.5) as u8;
                *dst_u8.add(dst_idx + 3) = clamp_i32((final_a + 0.5) as i32, 0, 255) as u8;
            } else {
                let fade = 1.0 - clamp_f32(0.45 * falloff, 0.0, 0.85);
                *dst_u8.add(dst_idx + 3) = ((orig_a as f32) * fade + 0.5) as u8;
            }
        }
    }

    modified
}

// ============================================================================
// 3. FAST IMAGE MASKING & CHUNK INSPECTION KERNELS
// ============================================================================

#[no_mangle]
pub unsafe extern "C" fn rgba_to_tip_mask(pixels_ptr: *mut u8, pixel_count: usize) {
    let mut i = 0;
    let total_bytes = pixel_count * 4;
    while i < total_bytes {
        let r = *pixels_ptr.add(i) as u32;
        let g = *pixels_ptr.add(i + 1) as u32;
        let b = *pixels_ptr.add(i + 2) as u32;
        let a = *pixels_ptr.add(i + 3) as u32;
        let gray = (r + g + b) / 3;
        let inv_gray = 255 - gray;
        let new_a = (inv_gray * a) / 255;
        *pixels_ptr.add(i) = 0;
        *pixels_ptr.add(i + 1) = 0;
        *pixels_ptr.add(i + 2) = 0;
        *pixels_ptr.add(i + 3) = if new_a > 255 { 255 } else { new_a as u8 };
        i += 4;
    }
}

#[no_mangle]
pub unsafe extern "C" fn is_buffer_empty(pixels_u32: *const u32, pixel_count: usize) -> u32 {
    if pixels_u32.is_null() || pixel_count == 0 {
        return 1;
    }
    let mut i = 0;
    while i + 8 <= pixel_count {
        if (*pixels_u32.add(i) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 1) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 2) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 3) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 4) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 5) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 6) & 0xFF00_0000) != 0
            || (*pixels_u32.add(i + 7) & 0xFF00_0000) != 0
        {
            return 0;
        }
        i += 8;
    }
    while i < pixel_count {
        if (*pixels_u32.add(i) & 0xFF00_0000) != 0 {
            return 0;
        }
        i += 1;
    }
    1
}

// ============================================================================
// 4. HIGH-PERFORMANCE FLUID PAINT ADVECTION & IMPASTO SHADING KERNELS
// ============================================================================

#[inline(always)]
fn sin_f32_approx(mut x: f32) -> f32 {
    const PI: f32 = 3.141592653589793;
    const TWO_PI: f32 = 6.283185307179586;
    x = x - TWO_PI * floor_f32(x / TWO_PI + 0.5) as f32;
    let b = 4.0 / PI;
    let c = -4.0 / (PI * PI);
    let y = b * x + c * x * (if x < 0.0 { -x } else { x });
    const P: f32 = 0.225;
    y * (1.0 - P) + P * y * (if y < 0.0 { -y } else { y })
}

#[inline(always)]
fn cos_f32_approx(x: f32) -> f32 {
    const HALF_PI: f32 = 1.5707963267948966;
    sin_f32_approx(x + HALF_PI)
}

#[inline(always)]
fn get_sq_distance_to_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq <= 0.00001 {
        let dax = px - ax;
        let day = py - ay;
        return dax * dax + day * day;
    }
    let t = clamp_f32(((px - ax) * dx + (py - ay) * dy) / len_sq, 0.0, 1.0);
    let rx = px - (ax + t * dx);
    let ry = py - (ay + t * dy);
    rx * rx + ry * ry
}

struct FluidSession {
    w: i32,
    h: i32,
    grid_w: i32,
    grid_h: i32,
    cell_size: f32,
    inv_cell: f32,
    pixel_capacity: usize,
    grid_capacity: usize,
    src_pixels: *mut u8,
    dst_pixels: *mut u8,
    src_height: *mut f32,
    dst_height: *mut f32,
    u_vel: *mut f32,
    v_vel: *mut f32,
    u_temp: *mut f32,
    v_temp: *mut f32,
    pressure: *mut f32,
    pressure_temp: *mut f32,
    divergence: *mut f32,
}

static mut FLUID_SESSION: FluidSession = FluidSession {
    w: 0,
    h: 0,
    grid_w: 0,
    grid_h: 0,
    cell_size: 4.0,
    inv_cell: 0.25,
    pixel_capacity: 0,
    grid_capacity: 0,
    src_pixels: core::ptr::null_mut(),
    dst_pixels: core::ptr::null_mut(),
    src_height: core::ptr::null_mut(),
    dst_height: core::ptr::null_mut(),
    u_vel: core::ptr::null_mut(),
    v_vel: core::ptr::null_mut(),
    u_temp: core::ptr::null_mut(),
    v_temp: core::ptr::null_mut(),
    pressure: core::ptr::null_mut(),
    pressure_temp: core::ptr::null_mut(),
    divergence: core::ptr::null_mut(),
};

#[no_mangle]
pub unsafe extern "C" fn fluid_session_start(w: i32, h: i32, cell_size: f32) -> i32 {
    if w <= 0 || h <= 0 {
        return 0;
    }
    let c_size = if cell_size >= 1.0 { cell_size } else { 4.0 };
    let inv_c = 1.0 / c_size;
    let grid_w = ((w as f32) * inv_c) as i32 + 2;
    let grid_h = ((h as f32) * inv_c) as i32 + 2;

    let pixel_count = (w as usize) * (h as usize);
    let pixel_bytes = pixel_count * 4;
    let height_bytes = pixel_count * core::mem::size_of::<f32>();
    let grid_count = (grid_w as usize) * (grid_h as usize);
    let grid_bytes = grid_count * core::mem::size_of::<f32>();

    let sess = &mut FLUID_SESSION;

    if sess.pixel_capacity < pixel_count {
        sess.src_pixels = wasm_alloc(pixel_bytes) as *mut u8;
        sess.dst_pixels = wasm_alloc(pixel_bytes) as *mut u8;
        sess.src_height = wasm_alloc(height_bytes) as *mut f32;
        sess.dst_height = wasm_alloc(height_bytes) as *mut f32;
        if sess.src_pixels.is_null()
            || sess.dst_pixels.is_null()
            || sess.src_height.is_null()
            || sess.dst_height.is_null()
        {
            return 0;
        }
        sess.pixel_capacity = pixel_count;
    }

    if sess.grid_capacity < grid_count {
        sess.u_vel = wasm_alloc(grid_bytes) as *mut f32;
        sess.v_vel = wasm_alloc(grid_bytes) as *mut f32;
        sess.u_temp = wasm_alloc(grid_bytes) as *mut f32;
        sess.v_temp = wasm_alloc(grid_bytes) as *mut f32;
        sess.pressure = wasm_alloc(grid_bytes) as *mut f32;
        sess.pressure_temp = wasm_alloc(grid_bytes) as *mut f32;
        sess.divergence = wasm_alloc(grid_bytes) as *mut f32;
        if sess.u_vel.is_null() || sess.v_vel.is_null() || sess.pressure.is_null() {
            return 0;
        }
        sess.grid_capacity = grid_count;
    }

    sess.w = w;
    sess.h = h;
    sess.grid_w = grid_w;
    sess.grid_h = grid_h;
    sess.cell_size = c_size;
    sess.inv_cell = inv_c;

    core::ptr::write_bytes(sess.u_vel as *mut u8, 0, grid_bytes);
    core::ptr::write_bytes(sess.v_vel as *mut u8, 0, grid_bytes);
    core::ptr::write_bytes(sess.pressure as *mut u8, 0, grid_bytes);
    core::ptr::write_bytes(sess.divergence as *mut u8, 0, grid_bytes);

    1
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_src_pixels() -> *mut u8 {
    FLUID_SESSION.src_pixels
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_dst_pixels() -> *mut u8 {
    FLUID_SESSION.dst_pixels
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_src_height() -> *mut f32 {
    FLUID_SESSION.src_height
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_dst_height() -> *mut f32 {
    FLUID_SESSION.dst_height
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_w() -> i32 {
    FLUID_SESSION.w
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_get_h() -> i32 {
    FLUID_SESSION.h
}

#[inline(always)]
unsafe fn sample_grid_velocity(x: f32, y: f32) -> (f32, f32) {
    let sess = &FLUID_SESSION;
    let gx = (x * sess.inv_cell).max(0.0);
    let gy = (y * sess.inv_cell).max(0.0);
    let cx0 = clamp_i32(gx as i32, 0, sess.grid_w - 1);
    let cy0 = clamp_i32(gy as i32, 0, sess.grid_h - 1);
    let cx1 = clamp_i32(cx0 + 1, 0, sess.grid_w - 1);
    let cy1 = clamp_i32(cy0 + 1, 0, sess.grid_h - 1);

    let tx = gx - (cx0 as f32);
    let ty = gy - (cy0 as f32);
    let inv_tx = 1.0 - tx;
    let inv_ty = 1.0 - ty;

    let w00 = inv_tx * inv_ty;
    let w10 = tx * inv_ty;
    let w01 = inv_tx * ty;
    let w11 = tx * ty;

    let grid_w = sess.grid_w as usize;
    let i00 = (cy0 as usize) * grid_w + (cx0 as usize);
    let i10 = (cy0 as usize) * grid_w + (cx1 as usize);
    let i01 = (cy1 as usize) * grid_w + (cx0 as usize);
    let i11 = (cy1 as usize) * grid_w + (cx1 as usize);

    let vx = (*sess.u_vel.add(i00)) * w00
        + (*sess.u_vel.add(i10)) * w10
        + (*sess.u_vel.add(i01)) * w01
        + (*sess.u_vel.add(i11)) * w11;

    let vy = (*sess.v_vel.add(i00)) * w00
        + (*sess.v_vel.add(i10)) * w10
        + (*sess.v_vel.add(i01)) * w01
        + (*sess.v_vel.add(i11)) * w11;

    (vx, vy)
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_step(
    ax: f32,
    ay: f32,
    bx: f32,
    by: f32,
    radius: f32,
    brush_r: f32,
    brush_g: f32,
    brush_b: f32,
    opacity: f32,
    flow: f32,
    fluidity: f32,
    val_vortex: f32,
    val_turb: f32,
    val_retention: f32,
    val_pickup: f32,
    val_depth: f32,
    val_gloss: f32,
    bristles: f32,
    is_impasto: i32,
) -> i32 {
    let sess = &mut FLUID_SESSION;
    if sess.src_pixels.is_null() || sess.w <= 0 || sess.h <= 0 {
        return 0;
    }

    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    let len = sqrt_f32(len_sq);
    let inv_len_sq = if len_sq > 0.00001 { 1.0 / len_sq } else { 0.0 };
    let (dir_x, dir_y) = if len > 0.0001 {
        (dx / len, dy / len)
    } else {
        (1.0, 0.0)
    };
    let (nx, ny) = (-dir_y, dir_x);

    let r = radius.max(1.0);
    let r_sq = r * r;
    let inv_r = 1.0 / r;
    let pad = r * 1.5 + 16.0;

    let min_x = clamp_i32(floor_f32(if ax < bx { ax } else { bx } - pad), 0, sess.w - 1);
    let max_x = clamp_i32(ceil_f32(if ax > bx { ax } else { bx } + pad), 0, sess.w - 1);
    let min_y = clamp_i32(floor_f32(if ay < by { ay } else { by } - pad), 0, sess.h - 1);
    let max_y = clamp_i32(ceil_f32(if ay > by { ay } else { by } + pad), 0, sess.h - 1);

    if min_x >= max_x || min_y >= max_y {
        return 0;
    }

    let w_usize = sess.w as usize;
    let bristle_freq = 0.35 + bristles * 0.02;
    let bristle_amp = (bristles * 0.009).min(0.65);
    let pickup_rate = (val_pickup * 0.01) * (fluidity * 0.01) * 0.50;
    let depth_rate = 0.16 * (val_depth * 0.01);
    let reservoir = 0.05 + 0.95 * (val_retention * 0.01);

    // ------------------------------------------------------------------------
    // Step 1: Continuous Capsule Paint Deposition (Zero Dots!)
    // ------------------------------------------------------------------------
    for y in min_y..=max_y {
        let y_f = y as f32;
        let row_offset = (y as usize) * w_usize;

        for x in min_x..=max_x {
            let x_f = x as f32;
            let t = if len_sq > 0.00001 {
                clamp_f32(((x_f - ax) * dx + (y_f - ay) * dy) * inv_len_sq, 0.0, 1.0)
            } else {
                0.0
            };
            let proj_x = ax + t * dx;
            let proj_y = ay + t * dy;
            let dist_x = x_f - proj_x;
            let dist_y = y_f - proj_y;
            let dist_sq = dist_x * dist_x + dist_y * dist_y;

            if dist_sq > r_sq {
                continue;
            }

            let d_norm = sqrt_f32(dist_sq) * inv_r;
            let mut falloff = 1.0 - d_norm * d_norm;
            if falloff < 0.0 {
                falloff = 0.0;
            }
            falloff = falloff * falloff;

            let offset = (x_f - ax) * nx + (y_f - ay) * ny;
            let ridge = sin_f32_approx(offset * bristle_freq) * 0.5
                + sin_f32_approx(offset * bristle_freq * 2.2) * 0.35
                + sin_f32_approx(offset * bristle_freq * 4.1) * 0.15;
            let groove = (1.0 + bristle_amp * ridge).max(0.2);

            let deposit_alpha = clamp_f32(opacity * flow * falloff * groove, 0.0, 1.0);
            if deposit_alpha <= 0.001 {
                continue;
            }

            let pix_idx = (row_offset + (x as usize)) * 4;
            let height_idx = row_offset + (x as usize);

            let bg_a = (*sess.src_pixels.add(pix_idx + 3) as f32) * (1.0 / 255.0);
            let bg_r = *sess.src_pixels.add(pix_idx) as f32;
            let bg_g = *sess.src_pixels.add(pix_idx + 1) as f32;
            let bg_b = *sess.src_pixels.add(pix_idx + 2) as f32;

            // Wet paint mixing with dynamic pickup
            let active_r = brush_r * reservoir + bg_r * (1.0 - reservoir);
            let active_g = brush_g * reservoir + bg_g * (1.0 - reservoir);
            let active_b = brush_b * reservoir + bg_b * (1.0 - reservoir);

            let (mix_r, mix_g, mix_b) = if bg_a > 0.05 {
                (
                    active_r * (1.0 - pickup_rate) + bg_r * pickup_rate,
                    active_g * (1.0 - pickup_rate) + bg_g * pickup_rate,
                    active_b * (1.0 - pickup_rate) + bg_b * pickup_rate,
                )
            } else {
                (active_r, active_g, active_b)
            };

            let out_alpha = bg_a + deposit_alpha * (1.0 - bg_a);
            if out_alpha > 0.001 {
                let bg_w = bg_a * (1.0 - deposit_alpha) / out_alpha;
                let fg_w = deposit_alpha / out_alpha;
                let new_r = bg_r * bg_w + mix_r * fg_w;
                let new_g = bg_g * bg_w + mix_g * fg_w;
                let new_b = bg_b * bg_w + mix_b * fg_w;

                *sess.src_pixels.add(pix_idx) = clamp_f32(new_r + 0.5, 0.0, 255.0) as u8;
                *sess.src_pixels.add(pix_idx + 1) = clamp_f32(new_g + 0.5, 0.0, 255.0) as u8;
                *sess.src_pixels.add(pix_idx + 2) = clamp_f32(new_b + 0.5, 0.0, 255.0) as u8;
                *sess.src_pixels.add(pix_idx + 3) = clamp_f32(out_alpha * 255.0 + 0.5, 0.0, 255.0) as u8;
            }

            let cur_h = *sess.src_height.add(height_idx);
            let build = deposit_alpha * depth_rate * groove;
            let new_h = clamp_f32(cur_h + build, out_alpha, 3.5);
            *sess.src_height.add(height_idx) = new_h;
        }
    }

    // ------------------------------------------------------------------------
    // Step 2: Fluid Velocity Splat (Impulse & Vortex Curl)
    // ------------------------------------------------------------------------
    let speed = len.min(18.0);
    let forward_speed = speed * (flow * 0.01) * 0.85;
    let u_push = dir_x * forward_speed;
    let v_push = dir_y * forward_speed;
    let swirl_power = speed * 1.8 * (val_vortex * 0.01);
    let turb_power = speed * 1.0 * (val_turb * 0.01);

    let grid_min_x = clamp_i32(((min_x as f32) * sess.inv_cell) as i32, 0, sess.grid_w - 1);
    let grid_max_x = clamp_i32(((max_x as f32) * sess.inv_cell) as i32 + 1, 0, sess.grid_w - 1);
    let grid_min_y = clamp_i32(((min_y as f32) * sess.inv_cell) as i32, 0, sess.grid_h - 1);
    let grid_max_y = clamp_i32(((max_y as f32) * sess.inv_cell) as i32 + 1, 0, sess.grid_h - 1);

    let r_vel_sq = r_sq * 1.6;
    let inv_r_vel_sq = if r_vel_sq > 0.0001 { 1.0 / r_vel_sq } else { 0.0 };

    for cy in grid_min_y..=grid_max_y {
        let py = (cy as f32) * sess.cell_size + sess.cell_size * 0.5;
        let row = (cy as usize) * (sess.grid_w as usize);

        for cx in grid_min_x..=grid_max_x {
            let px = (cx as f32) * sess.cell_size + sess.cell_size * 0.5;
            let dist_sq = get_sq_distance_to_segment(px, py, ax, ay, bx, by);
            if dist_sq >= r_vel_sq {
                continue;
            }

            let f = 1.0 - dist_sq * inv_r_vel_sq;
            let force = f * f;

            let g_idx = row + (cx as usize);
            let mut cell_u = u_push * force;
            let mut cell_v = v_push * force;

            let offset = (px - ax) * nx + (py - ay) * ny;
            let norm_offset = clamp_f32(offset * inv_r, -1.0, 1.0);
            cell_u += (-ny * norm_offset) * swirl_power * force;
            cell_v += (nx * norm_offset) * swirl_power * force;

            if turb_power > 0.001 {
                cell_u += sin_f32_approx(py * 0.07 + px * 0.05) * turb_power * force;
                cell_v += cos_f32_approx(px * 0.07 - py * 0.05) * turb_power * force;
            }

            *sess.u_vel.add(g_idx) += cell_u;
            *sess.v_vel.add(g_idx) += cell_v;
        }
    }

    // ------------------------------------------------------------------------
    // Step 3: Navier-Stokes Incompressibility (Divergence & Jacobi Pressure Solve)
    // ------------------------------------------------------------------------
    let g_y0 = grid_min_y.max(1);
    let g_y1 = grid_max_y.min(sess.grid_h - 2);
    let g_x0 = grid_min_x.max(1);
    let g_x1 = grid_max_x.min(sess.grid_w - 2);

    for cy in g_y0..=g_y1 {
        let cy_u = cy as usize;
        let row = cy_u * (sess.grid_w as usize);
        let row_up = (cy_u + 1) * (sess.grid_w as usize);
        let row_down = (cy_u - 1) * (sess.grid_w as usize);

        for cx in g_x0..=g_x1 {
            let cx_u = cx as usize;
            let u_r = *sess.u_vel.add(row + cx_u + 1);
            let u_l = *sess.u_vel.add(row + cx_u - 1);
            let v_t = *sess.v_vel.add(row_up + cx_u);
            let v_b = *sess.v_vel.add(row_down + cx_u);
            *sess.divergence.add(row + cx_u) = 0.5 * ((u_r - u_l) + (v_t - v_b));
            *sess.pressure.add(row + cx_u) = 0.0;
        }
    }

    // 2 Jacobi iterations (David Li's exact solver setup)
    for _ in 0..2 {
        for cy in g_y0..=g_y1 {
            let cy_u = cy as usize;
            let row = cy_u * (sess.grid_w as usize);
            let row_up = (cy_u + 1) * (sess.grid_w as usize);
            let row_down = (cy_u - 1) * (sess.grid_w as usize);

            for cx in g_x0..=g_x1 {
                let cx_u = cx as usize;
                let p_l = *sess.pressure.add(row + cx_u - 1);
                let p_r = *sess.pressure.add(row + cx_u + 1);
                let p_b = *sess.pressure.add(row_down + cx_u);
                let p_t = *sess.pressure.add(row_up + cx_u);
                let div = *sess.divergence.add(row + cx_u);
                *sess.pressure_temp.add(row + cx_u) = 0.25 * (p_l + p_r + p_b + p_t - div);
            }
        }
        for cy in g_y0..=g_y1 {
            let row = (cy as usize) * (sess.grid_w as usize);
            for cx in g_x0..=g_x1 {
                let idx = row + (cx as usize);
                *sess.pressure.add(idx) = *sess.pressure_temp.add(idx);
            }
        }
    }

    // Velocity projection
    for cy in g_y0..=g_y1 {
        let cy_u = cy as usize;
        let row = cy_u * (sess.grid_w as usize);
        let row_up = (cy_u + 1) * (sess.grid_w as usize);
        let row_down = (cy_u - 1) * (sess.grid_w as usize);

        for cx in g_x0..=g_x1 {
            let cx_u = cx as usize;
            let p_l = *sess.pressure.add(row + cx_u - 1);
            let p_r = *sess.pressure.add(row + cx_u + 1);
            let p_b = *sess.pressure.add(row_down + cx_u);
            let p_t = *sess.pressure.add(row_up + cx_u);
            *sess.u_vel.add(row + cx_u) -= 0.5 * (p_r - p_l);
            *sess.v_vel.add(row + cx_u) -= 0.5 * (p_t - p_b);
        }
    }

    // Viscous dissipation
    let dissipation = clamp_f32(0.85 + (fluidity * 0.01) * 0.12, 0.4, 0.98);
    for cy in g_y0..=g_y1 {
        let row = (cy as usize) * (sess.grid_w as usize);
        for cx in g_x0..=g_x1 {
            let idx = row + (cx as usize);
            *sess.u_vel.add(idx) *= dissipation;
            *sess.v_vel.add(idx) *= dissipation;
        }
    }

    // ------------------------------------------------------------------------
    // Step 4: RK2 Paint (Color + Height) Advection
    // ------------------------------------------------------------------------
    let dt = 0.75;
    for y in min_y..=max_y {
        let y_f = y as f32;
        let row_offset = (y as usize) * w_usize;

        for x in min_x..=max_x {
            let x_f = x as f32;
            let (vx, vy) = sample_grid_velocity(x_f, y_f);
            let speed_sq = vx * vx + vy * vy;
            let pix_idx = (row_offset + (x as usize)) * 4;
            let h_idx = row_offset + (x as usize);

            if speed_sq > 0.005 {
                // RK2 midpoint backtrace
                let mid_x = x_f - vx * (0.5 * dt);
                let mid_y = y_f - vy * (0.5 * dt);
                let (mid_vx, mid_vy) = sample_grid_velocity(mid_x, mid_y);
                let src_x = clamp_f32(x_f - mid_vx * dt, 0.0, (sess.w - 1) as f32);
                let src_y = clamp_f32(y_f - mid_vy * dt, 0.0, (sess.h - 1) as f32);

                // Bilinear sample of src_pixels and src_height
                let ix0 = src_x as i32;
                let iy0 = src_y as i32;
                let ix1 = clamp_i32(ix0 + 1, 0, sess.w - 1);
                let iy1 = clamp_i32(iy0 + 1, 0, sess.h - 1);

                let fx = src_x - (ix0 as f32);
                let fy = src_y - (iy0 as f32);
                let ifx = 1.0 - fx;
                let ify = 1.0 - fy;

                let w00 = ifx * ify;
                let w10 = fx * ify;
                let w01 = ifx * fy;
                let w11 = fx * fy;

                let p00 = (iy0 as usize) * w_usize + (ix0 as usize);
                let p10 = (iy0 as usize) * w_usize + (ix1 as usize);
                let p01 = (iy1 as usize) * w_usize + (ix0 as usize);
                let p11 = (iy1 as usize) * w_usize + (ix1 as usize);

                let adv_r = (*sess.src_pixels.add(p00 * 4) as f32) * w00
                    + (*sess.src_pixels.add(p10 * 4) as f32) * w10
                    + (*sess.src_pixels.add(p01 * 4) as f32) * w01
                    + (*sess.src_pixels.add(p11 * 4) as f32) * w11;

                let adv_g = (*sess.src_pixels.add(p00 * 4 + 1) as f32) * w00
                    + (*sess.src_pixels.add(p10 * 4 + 1) as f32) * w10
                    + (*sess.src_pixels.add(p01 * 4 + 1) as f32) * w01
                    + (*sess.src_pixels.add(p11 * 4 + 1) as f32) * w11;

                let adv_b = (*sess.src_pixels.add(p00 * 4 + 2) as f32) * w00
                    + (*sess.src_pixels.add(p10 * 4 + 2) as f32) * w10
                    + (*sess.src_pixels.add(p01 * 4 + 2) as f32) * w01
                    + (*sess.src_pixels.add(p11 * 4 + 2) as f32) * w11;

                let adv_a = (*sess.src_pixels.add(p00 * 4 + 3) as f32) * w00
                    + (*sess.src_pixels.add(p10 * 4 + 3) as f32) * w10
                    + (*sess.src_pixels.add(p01 * 4 + 3) as f32) * w01
                    + (*sess.src_pixels.add(p11 * 4 + 3) as f32) * w11;

                let adv_h = (*sess.src_height.add(p00)) * w00
                    + (*sess.src_height.add(p10)) * w10
                    + (*sess.src_height.add(p01)) * w01
                    + (*sess.src_height.add(p11)) * w11;

                *sess.dst_pixels.add(pix_idx) = clamp_f32(adv_r + 0.5, 0.0, 255.0) as u8;
                *sess.dst_pixels.add(pix_idx + 1) = clamp_f32(adv_g + 0.5, 0.0, 255.0) as u8;
                *sess.dst_pixels.add(pix_idx + 2) = clamp_f32(adv_b + 0.5, 0.0, 255.0) as u8;
                *sess.dst_pixels.add(pix_idx + 3) = clamp_f32(adv_a + 0.5, 0.0, 255.0) as u8;
                *sess.dst_height.add(h_idx) = adv_h;
            } else {
                *sess.dst_pixels.add(pix_idx) = *sess.src_pixels.add(pix_idx);
                *sess.dst_pixels.add(pix_idx + 1) = *sess.src_pixels.add(pix_idx + 1);
                *sess.dst_pixels.add(pix_idx + 2) = *sess.src_pixels.add(pix_idx + 2);
                *sess.dst_pixels.add(pix_idx + 3) = *sess.src_pixels.add(pix_idx + 3);
                *sess.dst_height.add(h_idx) = *sess.src_height.add(h_idx);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Step 5: 3D Surface Relief & Specular Lighting (David Li's Impasto Shader)
    // ------------------------------------------------------------------------
    if is_impasto != 0 && val_gloss > 0.001 {
        let normal_scale = 1.5 + (val_depth * 0.01) * 1.8;
        let gloss_scale = (val_gloss * 0.01) * 1.6;

        for y in min_y..=max_y {
            if y <= 0 || y >= sess.h - 1 {
                continue;
            }
            let y_u = y as usize;
            let row = y_u * w_usize;
            let row_up = (y_u + 1) * w_usize;
            let row_down = (y_u - 1) * w_usize;

            for x in min_x..=max_x {
                if x <= 0 || x >= sess.w - 1 {
                    continue;
                }
                let x_u = x as usize;

                let h_tl = *sess.dst_height.add(row_down + x_u - 1);
                let h_t = *sess.dst_height.add(row_down + x_u);
                let h_tr = *sess.dst_height.add(row_down + x_u + 1);
                let h_l = *sess.dst_height.add(row + x_u - 1);
                let h_r = *sess.dst_height.add(row + x_u + 1);
                let h_bl = *sess.dst_height.add(row_up + x_u - 1);
                let h_b = *sess.dst_height.add(row_up + x_u);
                let h_br = *sess.dst_height.add(row_up + x_u + 1);

                // Sobel operator for surface normal gradient
                let dh_dx = (h_tr + 2.0 * h_r + h_br) - (h_tl + 2.0 * h_l + h_bl);
                let dh_dy = (h_bl + 2.0 * h_b + h_br) - (h_tl + 2.0 * h_t + h_tr);

                let nx = -dh_dx * normal_scale;
                let ny = -dh_dy * normal_scale;
                let nz = 1.0;
                let inv_len = 1.0 / sqrt_f32(nx * nx + ny * ny + nz * nz).max(0.0001);
                let norm_x = nx * inv_len;
                let norm_y = ny * inv_len;
                let norm_z = nz * inv_len;

                // Key light from top-left angled forward
                const LX: f32 = -0.342997;
                const LY: f32 = -0.636994;
                const LZ: f32 = 0.690365;

                let ndotl = clamp_f32(norm_x * LX + norm_y * LY + norm_z * LZ, 0.0, 1.0);
                let diffuse = ndotl * 0.52 + 0.48;

                // Halfway vector for Blinn-Phong specular highlight
                const HX: f32 = -0.198;
                const HY: f32 = -0.368;
                const HZ: f32 = 0.908;

                let ndoth = clamp_f32(norm_x * HX + norm_y * HY + norm_z * HZ, 0.0, 1.0);
                let h2 = ndoth * ndoth;
                let h4 = h2 * h2;
                let h8 = h4 * h4;
                let h16 = h8 * h8;
                let h32 = h16 * h16;
                let specular = h32 * gloss_scale * 255.0;

                let pix_idx = (row + x_u) * 4;
                let orig_r = *sess.dst_pixels.add(pix_idx) as f32;
                let orig_g = *sess.dst_pixels.add(pix_idx + 1) as f32;
                let orig_b = *sess.dst_pixels.add(pix_idx + 2) as f32;

                *sess.dst_pixels.add(pix_idx) = clamp_f32(orig_r * diffuse + specular + 0.5, 0.0, 255.0) as u8;
                *sess.dst_pixels.add(pix_idx + 1) = clamp_f32(orig_g * diffuse + specular + 0.5, 0.0, 255.0) as u8;
                *sess.dst_pixels.add(pix_idx + 2) = clamp_f32(orig_b * diffuse + specular + 0.5, 0.0, 255.0) as u8;
            }
        }
    }

    // Step 6: Commit state back to src buffers for incremental continuation
    for y in min_y..=max_y {
        let row = (y as usize) * w_usize;
        for x in min_x..=max_x {
            let pix_idx = (row + (x as usize)) * 4;
            let h_idx = row + (x as usize);
            *sess.src_pixels.add(pix_idx) = *sess.dst_pixels.add(pix_idx);
            *sess.src_pixels.add(pix_idx + 1) = *sess.dst_pixels.add(pix_idx + 1);
            *sess.src_pixels.add(pix_idx + 2) = *sess.dst_pixels.add(pix_idx + 2);
            *sess.src_pixels.add(pix_idx + 3) = *sess.dst_pixels.add(pix_idx + 3);
            *sess.src_height.add(h_idx) = *sess.dst_height.add(h_idx);
        }
    }

    1
}

#[no_mangle]
pub unsafe extern "C" fn fluid_session_end() {
    let sess = &mut FLUID_SESSION;
    if !sess.u_vel.is_null() && sess.grid_capacity > 0 {
        let grid_bytes = sess.grid_capacity * core::mem::size_of::<f32>();
        core::ptr::write_bytes(sess.u_vel as *mut u8, 0, grid_bytes);
        core::ptr::write_bytes(sess.v_vel as *mut u8, 0, grid_bytes);
        core::ptr::write_bytes(sess.pressure as *mut u8, 0, grid_bytes);
        core::ptr::write_bytes(sess.divergence as *mut u8, 0, grid_bytes);
    }
}

// ============================================================================
// LIQUIFY UNIFIED STROKE SESSION KERNEL
// ============================================================================

struct LiquifySession {
    w: i32,
    h: i32,
    grid_w: i32,
    grid_h: i32,
    cell_size: f32,
    inv_cell: f32,
    origin_x: f32,
    origin_y: f32,
    src_capacity: usize,
    grid_capacity: usize,
    src_ptr: *mut u8,
    grid_ptr: *mut f32,
    scratch_ptr: *mut f32,
    warp_out_capacity: usize,
    warp_out_ptr: *mut u8,
}

static mut LIQUIFY_SESSION: LiquifySession = LiquifySession {
    w: 0,
    h: 0,
    grid_w: 0,
    grid_h: 0,
    cell_size: 8.0,
    inv_cell: 0.125,
    origin_x: 0.0,
    origin_y: 0.0,
    src_capacity: 0,
    grid_capacity: 0,
    src_ptr: core::ptr::null_mut(),
    grid_ptr: core::ptr::null_mut(),
    scratch_ptr: core::ptr::null_mut(),
    warp_out_capacity: 0,
    warp_out_ptr: core::ptr::null_mut(),
};

#[no_mangle]
pub unsafe extern "C" fn liquify_session_start(
    w: i32,
    h: i32,
    cell_size: f32,
    origin_x: f32,
    origin_y: f32,
) -> i32 {
    if w <= 0 || h <= 0 || cell_size <= 0.0 {
        return 0;
    }

    let grid_w = ceil_f32((w as f32) / cell_size) + 1;
    let grid_h = ceil_f32((h as f32) / cell_size) + 1;
    let inv_cell = 1.0 / cell_size;

    let img_bytes = (w as usize) * (h as usize) * 4;
    let grid_len = (grid_w as usize) * (grid_h as usize) * 2;
    let grid_bytes = grid_len * 4;

    // Check if existing allocated capacity can be reused without touching wasm_alloc!
    if LIQUIFY_SESSION.src_ptr.is_null() || LIQUIFY_SESSION.src_capacity < img_bytes {
        wasm_reset_scratch();
        let alloc_img = if img_bytes < 16 * 1024 * 1024 { 16 * 1024 * 1024 } else { img_bytes };
        let alloc_grid = if grid_bytes < 1024 * 1024 { 1024 * 1024 } else { grid_bytes };
        let alloc_out = if img_bytes < 16 * 1024 * 1024 { 16 * 1024 * 1024 } else { img_bytes };

        LIQUIFY_SESSION.src_ptr = wasm_alloc(alloc_img) as *mut u8;
        LIQUIFY_SESSION.src_capacity = alloc_img;

        LIQUIFY_SESSION.grid_ptr = wasm_alloc(alloc_grid) as *mut f32;
        LIQUIFY_SESSION.scratch_ptr = wasm_alloc(alloc_grid) as *mut f32;
        LIQUIFY_SESSION.grid_capacity = alloc_grid;

        LIQUIFY_SESSION.warp_out_ptr = wasm_alloc(alloc_out) as *mut u8;
        LIQUIFY_SESSION.warp_out_capacity = alloc_out;

        wasm_mark_scratch();
    }

    if LIQUIFY_SESSION.src_ptr.is_null() || LIQUIFY_SESSION.grid_ptr.is_null() {
        return 0;
    }

    // Only zero the active grid displacement! (Only ~133KB -> 0.01ms!)
    // DO NOT zero the entire 16MB image buffer, as stamped pixels overwrite it and unstamped pixels are untouched!
    core::ptr::write_bytes(LIQUIFY_SESSION.grid_ptr as *mut u8, 0, grid_bytes);

    LIQUIFY_SESSION.w = w;
    LIQUIFY_SESSION.h = h;
    LIQUIFY_SESSION.grid_w = grid_w;
    LIQUIFY_SESSION.grid_h = grid_h;
    LIQUIFY_SESSION.cell_size = cell_size;
    LIQUIFY_SESSION.inv_cell = inv_cell;
    LIQUIFY_SESSION.origin_x = origin_x;
    LIQUIFY_SESSION.origin_y = origin_y;

    1
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_get_src_ptr() -> *mut u8 {
    LIQUIFY_SESSION.src_ptr
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_get_warp_out_ptr() -> *mut u8 {
    LIQUIFY_SESSION.warp_out_ptr
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_get_w() -> i32 {
    LIQUIFY_SESSION.w
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_get_h() -> i32 {
    LIQUIFY_SESSION.h
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_stamp_src(
    chunk_ptr: *const u8,
    chunk_w: i32,
    chunk_h: i32,
    dst_x: i32,
    dst_y: i32,
) -> i32 {
    if LIQUIFY_SESSION.src_ptr.is_null() || chunk_ptr.is_null() || chunk_w <= 0 || chunk_h <= 0 {
        return 0;
    }
    let sess = &raw const LIQUIFY_SESSION;
    let cw_usize = chunk_w as usize;
    let sw_usize = (*sess).w as usize;

    let x0 = clamp_i32(dst_x, 0, (*sess).w);
    let x1 = clamp_i32(dst_x + chunk_w, 0, (*sess).w);
    let y0 = clamp_i32(dst_y, 0, (*sess).h);
    let y1 = clamp_i32(dst_y + chunk_h, 0, (*sess).h);

    if x0 >= x1 || y0 >= y1 {
        return 0;
    }

    let copy_w = (x1 - x0) as usize;
    let copy_bytes = copy_w * 4;

    for y in y0..y1 {
        let cy = (y - dst_y) as usize;
        let cx = (x0 - dst_x) as usize;
        let src_offset = (cy * cw_usize + cx) * 4;
        let dst_offset = ((y as usize) * sw_usize + (x0 as usize)) * 4;
        core::ptr::copy_nonoverlapping(
            chunk_ptr.add(src_offset),
            (*sess).src_ptr.add(dst_offset),
            copy_bytes,
        );
    }
    1
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_displace(
    p0_x: f32,
    p0_y: f32,
    mv_x: f32,
    mv_y: f32,
    r: f32,
    falloff: f32,
) -> i32 {
    if LIQUIFY_SESSION.grid_ptr.is_null() || r <= 0.0 {
        return 0;
    }
    let sess = &raw mut LIQUIFY_SESSION;
    liquify_displace_grid(
        (*sess).grid_ptr,
        (*sess).scratch_ptr,
        (*sess).grid_w,
        (*sess).grid_h,
        (*sess).cell_size,
        (*sess).origin_x,
        (*sess).origin_y,
        p0_x,
        p0_y,
        mv_x,
        mv_y,
        r,
        falloff,
        core::ptr::null_mut(),
    )
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_warp_box(
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
    out_ptr: *mut u8,
) -> i32 {
    if LIQUIFY_SESSION.src_ptr.is_null() {
        return 0;
    }
    let sess = &raw const LIQUIFY_SESSION;
    let dst_ptr = if !out_ptr.is_null() {
        out_ptr
    } else {
        (*sess).warp_out_ptr
    };
    if dst_ptr.is_null() {
        return 0;
    }

    let min_x = clamp_i32(min_x, 0, (*sess).w - 1);
    let max_x = clamp_i32(max_x, 0, (*sess).w - 1);
    let min_y = clamp_i32(min_y, 0, (*sess).h - 1);
    let max_y = clamp_i32(max_y, 0, (*sess).h - 1);

    if min_x > max_x || min_y > max_y {
        return 0;
    }

    let box_w = (max_x - min_x + 1) as usize;
    let w_usize = (*sess).w as usize;
    let gw_usize = (*sess).grid_w as usize;
    let max_x_f = ((*sess).w - 1) as f32;
    let max_y_f = ((*sess).h - 1) as f32;
    let max_x_idx = (*sess).w - 1;
    let max_y_idx = (*sess).h - 1;
    let max_gx_idx = (*sess).grid_w - 2;
    let max_gy_idx = (*sess).grid_h - 2;

    let src_u8 = (*sess).src_ptr as *const u8;
    let src_u32 = (*sess).src_ptr as *const u32;
    let out_u32 = dst_ptr as *mut u32;

    for y in min_y..=max_y {
        let local_y = (y - min_y) as usize;
        let out_row_offset = local_y * box_w;
        let src_row_offset = (y as usize) * w_usize;

        let gy_f = (y as f32) * (*sess).inv_cell;
        let gy0 = clamp_i32(gy_f as i32, 0, max_gy_idx);
        let gy1 = gy0 + 1;
        let ty = gy_f - (gy0 as f32);
        let inv_ty = 1.0 - ty;

        let row0_offset = (gy0 as usize) * gw_usize;
        let row1_offset = (gy1 as usize) * gw_usize;

        for x in min_x..=max_x {
            let local_x = (x - min_x) as usize;
            let out_pixel_idx = out_row_offset + local_x;

            let gx_f = (x as f32) * (*sess).inv_cell;
            let gx0 = clamp_i32(gx_f as i32, 0, max_gx_idx);
            let gx1 = gx0 + 1;
            let tx = gx_f - (gx0 as f32);
            let inv_tx = 1.0 - tx;

            let i00 = (row0_offset + (gx0 as usize)) * 2;
            let i10 = (row0_offset + (gx1 as usize)) * 2;
            let i01 = (row1_offset + (gx0 as usize)) * 2;
            let i11 = (row1_offset + (gx1 as usize)) * 2;

            let w00 = inv_tx * inv_ty;
            let w10 = tx * inv_ty;
            let w01 = inv_tx * ty;
            let w11 = tx * ty;

            let dx = (*(*sess).grid_ptr.add(i00)) * w00
                + (*(*sess).grid_ptr.add(i10)) * w10
                + (*(*sess).grid_ptr.add(i01)) * w01
                + (*(*sess).grid_ptr.add(i11)) * w11;

            let dy = (*(*sess).grid_ptr.add(i00 + 1)) * w00
                + (*(*sess).grid_ptr.add(i10 + 1)) * w10
                + (*(*sess).grid_ptr.add(i01 + 1)) * w01
                + (*(*sess).grid_ptr.add(i11 + 1)) * w11;

            if dx > -0.001 && dx < 0.001 && dy > -0.001 && dy < 0.001 {
                *out_u32.add(out_pixel_idx) = *src_u32.add(src_row_offset + (x as usize));
                continue;
            }

            let sx = clamp_f32((x as f32) - dx, 0.0, max_x_f);
            let sy = clamp_f32((y as f32) - dy, 0.0, max_y_f);

            let x0 = sx as i32;
            let y0 = sy as i32;
            let x1 = if x0 < max_x_idx { x0 + 1 } else { x0 };
            let y1 = if y0 < max_y_idx { y0 + 1 } else { y0 };

            let fx = sx - (x0 as f32);
            let fy = sy - (y0 as f32);
            let ifx = 1.0 - fx;
            let ify = 1.0 - fy;

            let pw00 = ifx * ify;
            let pw10 = fx * ify;
            let pw01 = ifx * fy;
            let pw11 = fx * fy;

            let p00 = ((y0 as usize) * w_usize + (x0 as usize)) * 4;
            let p10 = ((y0 as usize) * w_usize + (x1 as usize)) * 4;
            let p01 = ((y1 as usize) * w_usize + (x0 as usize)) * 4;
            let p11 = ((y1 as usize) * w_usize + (x1 as usize)) * 4;

            let a00 = (*src_u8.add(p00 + 3) as f32) * pw00;
            let a10 = (*src_u8.add(p10 + 3) as f32) * pw10;
            let a01 = (*src_u8.add(p01 + 3) as f32) * pw01;
            let a11 = (*src_u8.add(p11 + 3) as f32) * pw11;
            let out_a = a00 + a10 + a01 + a11;

            let dst_byte_idx = out_pixel_idx * 4;
            if out_a < 0.5 {
                *out_u32.add(out_pixel_idx) = 0;
            } else {
                let inv_a = 1.0 / out_a;
                let r = ((*src_u8.add(p00) as f32) * a00
                    + (*src_u8.add(p10) as f32) * a10
                    + (*src_u8.add(p01) as f32) * a01
                    + (*src_u8.add(p11) as f32) * a11)
                    * inv_a;
                let g = ((*src_u8.add(p00 + 1) as f32) * a00
                    + (*src_u8.add(p10 + 1) as f32) * a10
                    + (*src_u8.add(p01 + 1) as f32) * a01
                    + (*src_u8.add(p11 + 1) as f32) * a11)
                    * inv_a;
                let b = ((*src_u8.add(p00 + 2) as f32) * a00
                    + (*src_u8.add(p10 + 2) as f32) * a10
                    + (*src_u8.add(p01 + 2) as f32) * a01
                    + (*src_u8.add(p11 + 2) as f32) * a11)
                    * inv_a;

                *dst_ptr.add(dst_byte_idx) = (r + 0.5) as u8;
                *dst_ptr.add(dst_byte_idx + 1) = (g + 0.5) as u8;
                *dst_ptr.add(dst_byte_idx + 2) = (b + 0.5) as u8;
                *dst_ptr.add(dst_byte_idx + 3) = (out_a + 0.5) as u8;
            }
        }
    }
    1
}

#[no_mangle]
pub unsafe extern "C" fn liquify_session_end() {
    LIQUIFY_SESSION.w = 0;
    LIQUIFY_SESSION.h = 0;
    LIQUIFY_SESSION.origin_x = 0.0;
    LIQUIFY_SESSION.origin_y = 0.0;
    // Retain allocated buffers in LIQUIFY_SESSION for subsequent strokes (0-lag reuse)
}

