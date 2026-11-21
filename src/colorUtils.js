import { wasmCore } from './wasm/wasmBridge.js';

export function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
}

export function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    const colorStr = hex.trim().toLowerCase();
    let r = 0, g = 0, b = 0;

    if (colorStr.startsWith('#')) {
        if (colorStr.length === 4) {
            r = parseInt(colorStr[1] + colorStr[1], 16);
            g = parseInt(colorStr[2] + colorStr[2], 16);
            b = parseInt(colorStr[3] + colorStr[3], 16);
        } else if (colorStr.length >= 7) {
            r = parseInt(colorStr.slice(1, 3), 16);
            g = parseInt(colorStr.slice(3, 5), 16);
            b = parseInt(colorStr.slice(5, 7), 16);
        }
    } else if (colorStr.startsWith('rgb')) {
        const parts = colorStr.match(/\d+/g);
        if (parts && parts.length >= 3) {
            r = parseInt(parts[0], 10);
            g = parseInt(parts[1], 10);
            b = parseInt(parts[2], 10);
        }
    }

    return {
        r: Number.isNaN(r) ? 0 : clamp(r, 0, 255),
        g: Number.isNaN(g) ? 0 : clamp(g, 0, 255),
        b: Number.isNaN(b) ? 0 : clamp(b, 0, 255)
    };
}

export function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(x => {
        const clamped = clamp(Math.round(Number.isFinite(x) ? x : 0), 0, 255);
        const hex = clamped.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
    }).join("").toUpperCase();
}

export function normalizeHex(hex, fallback = '#000000') {
    if (!hex || typeof hex !== 'string') return fallback;
    const clean = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
        return ('#' + clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]).toUpperCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
        return ('#' + clean).toUpperCase();
    }
    if (hex.trim().toLowerCase().startsWith('rgb')) {
        const c = hexToRgb(hex);
        return rgbToHex(c.r, c.g, c.b);
    }
    return fallback;
}

export function mixColors(hex1, hex2, ratio = 0.5) {
    const c1 = hexToRgb(hex1);
    const c2 = hexToRgb(hex2);
    return rgbToHex(
        c1.r * (1 - ratio) + c2.r * ratio,
        c1.g * (1 - ratio) + c2.g * ratio,
        c1.b * (1 - ratio) + c2.b * ratio
    );
}

export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
}

export function shiftColor(hex, hDelta = 0, sDelta = 0, lDelta = 0) {
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

    hsl.h = ((hsl.h + hDelta) % 360 + 360) % 360;
    hsl.s = clamp(hsl.s + sDelta, 0, 100);
    hsl.l = clamp(hsl.l + lDelta, 0, 100);

    const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
    return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

export function hsvToRgb(h, s, v) {
    h = (((h % 360) + 360) % 360) / 360;
    s = clamp(s, 0, 100) / 100;
    v = clamp(v, 0, 100) / 100;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r = 0, g = 0, b = 0;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
}

export function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0;
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    if (max !== min) {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s * 100, v: v * 100 };
}

// ==================== CMYK ====================
export function rgbToCmyk(r, g, b) {
    const rn = clamp(r / 255, 0, 1);
    const gn = clamp(g / 255, 0, 1);
    const bn = clamp(b / 255, 0, 1);
    const k = 1 - Math.max(rn, gn, bn);
    if (k >= 0.9999) {
        return { c: 0, m: 0, y: 0, k: 100 };
    }
    const denom = 1 - k;
    return {
        c: clamp(((1 - rn - k) / denom) * 100, 0, 100),
        m: clamp(((1 - gn - k) / denom) * 100, 0, 100),
        y: clamp(((1 - bn - k) / denom) * 100, 0, 100),
        k: clamp(k * 100, 0, 100)
    };
}

export function cmykToRgb(c, m, y, k) {
    const cn = clamp(c, 0, 100) / 100;
    const mn = clamp(m, 0, 100) / 100;
    const yn = clamp(y, 0, 100) / 100;
    const kn = clamp(k, 0, 100) / 100;
    return {
        r: 255 * (1 - cn) * (1 - kn),
        g: 255 * (1 - mn) * (1 - kn),
        b: 255 * (1 - yn) * (1 - kn)
    };
}

// ==================== OKLAB / OKLCH ====================
function srgbToLinear(c) {
    c = clamp(c, 0, 1);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
    c = clamp(c, 0, 1);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function oklabToLinearSrgbRaw(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    return {
        r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    };
}

function inLinearGamut(rgb) {
    const eps = -0.0002;
    const maxEps = 1.0002;
    return (
        rgb.r >= eps && rgb.r <= maxEps &&
        rgb.g >= eps && rgb.g <= maxEps &&
        rgb.b >= eps && rgb.b <= maxEps
    );
}

export function rgbToOklab(r, g, b) {
    const lr = srgbToLinear(r / 255);
    const lg = srgbToLinear(g / 255);
    const lb = srgbToLinear(b / 255);

    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

    return {
        L: (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s) * 100, // 0..100
        a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,           // ~ -0.4..0.4
        b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s            // ~ -0.4..0.4
    };
}

export function oklabToRgb(L, a, b, gamutMap = true) {
    const L01 = clamp(L / 100, 0, 1);
    if (gamutMap) {
        if (L01 <= 0.001) return { r: 0, g: 0, b: 0 };
        if (L01 >= 0.999) return { r: 255, g: 255, b: 255 };
    }
    let raw = oklabToLinearSrgbRaw(L01, a, b);

    if (gamutMap && !inLinearGamut(raw)) {
        // Chroma-preserving binary search back into sRGB gamut
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) * 0.5;
            const test = oklabToLinearSrgbRaw(L01, a * mid, b * mid);
            if (inLinearGamut(test)) lo = mid;
            else hi = mid;
        }
        raw = oklabToLinearSrgbRaw(L01, a * lo, b * lo);
    }

    return {
        r: linearToSrgb(raw.r) * 255,
        g: linearToSrgb(raw.g) * 255,
        b: linearToSrgb(raw.b) * 255
    };
}

export function rgbToOklch(r, g, b) {
    const lab = rgbToOklab(r, g, b);
    const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    let H = Math.atan2(lab.b, lab.a) * (180 / Math.PI);
    if (H < 0) H += 360;
    return {
        L: lab.L, // 0..100
        C,        // 0..~0.37
        H: C < 1e-5 ? 0 : H // 0..360
    };
}

export function oklchToRgb(L, C, H) {
    const rad = (((H % 360) + 360) % 360) * (Math.PI / 180);
    const cSafe = Math.max(0, C);
    return oklabToRgb(L, cSafe * Math.cos(rad), cSafe * Math.sin(rad), true);
}

// ==================== PAINTERLY RYB (Y + B = GREEN) ====================
// Exact bijective Painterly RYB <-> sRGB mapping:
// - Y(100) + B(100) => Green (#00FF00)
// - R(100) + Y(100) => Orange (#FF8000)
// - R(100) + B(100) => Violet/Magenta (#FF00FF)
// - (0,0,0) => Black, (100,100,100) => White
// - Zero roundtrip error for any sRGB color
export function rgbToRyb(r, g, b) {
    let rn = clamp(r / 255, 0, 1);
    let gn = clamp(g / 255, 0, 1);
    let bn = clamp(b / 255, 0, 1);

    // 1. Remove white component
    const w = Math.min(rn, gn, bn);
    rn -= w;
    gn -= w;
    bn -= w;

    const maxRGB = Math.max(rn, gn, bn);

    // 2. Pull yellow out of red & green
    let y = Math.min(rn, gn);
    rn -= y;
    gn -= y;

    // 3. Split blue & green if both remain
    if (bn > 0 && gn > 0) {
        bn *= 0.5;
        gn *= 0.5;
    }

    // 4. Reassemble green energy into yellow + blue
    y += gn;
    bn += gn;

    // 5. Preserve chromatic intensity
    const maxRYB = Math.max(rn, y, bn);
    if (maxRYB > 0) {
        const n = maxRGB / maxRYB;
        rn *= n;
        y *= n;
        bn *= n;
    }

    // 6. Add white back
    return {
        r: clamp((rn + w) * 100, 0, 100),
        y: clamp((y + w) * 100, 0, 100),
        b: clamp((bn + w) * 100, 0, 100)
    };
}

export function rybToRgb(r, y, b) {
    let rn = clamp(r, 0, 100) / 100;
    let yn = clamp(y, 0, 100) / 100;
    let bn = clamp(b, 0, 100) / 100;

    // 1. Remove white component
    const w = Math.min(rn, yn, bn);
    rn -= w;
    yn -= w;
    bn -= w;

    const maxRYB = Math.max(rn, yn, bn);

    // 2. Reconstruct green from yellow + blue overlap
    let gn = Math.min(yn, bn);
    yn -= gn;
    bn -= gn;

    if (bn > 0 && gn > 0) {
        bn *= 2.0;
        gn *= 2.0;
    }

    // 3. Distribute yellow back into red & green
    rn += yn;
    gn += yn;

    // 4. Preserve chromatic intensity
    const maxRGB = Math.max(rn, gn, bn);
    if (maxRGB > 0) {
        const n = maxRYB / maxRGB;
        rn *= n;
        gn *= n;
        bn *= n;
    }

    // 5. Add white back
    return {
        r: clamp((rn + w) * 255, 0, 255),
        g: clamp((gn + w) * 255, 0, 255),
        b: clamp((bn + w) * 255, 0, 255)
    };
}

// Painter's RYB Color Wheel Hue Mapping:
// RYB deg: 0=Red, 60=Orange, 120=Yellow, 180=Green, 240=Blue, 300=Purple
// RGB deg: 0=Red, 30=Orange, 60=Yellow, 120=Green, 232=Blue, 278=Purple
const RYB_TO_RGB_STOPS = [
    [0, 0],
    [60, 28],
    [120, 60],
    [180, 128],
    [240, 228],
    [300, 276],
    [360, 360]
];

export function rybHueToRgbHue(rybHue) {
    const h = ((rybHue % 360) + 360) % 360;
    for (let i = 0; i < RYB_TO_RGB_STOPS.length - 1; i++) {
        const [a0, b0] = RYB_TO_RGB_STOPS[i];
        const [a1, b1] = RYB_TO_RGB_STOPS[i + 1];
        if (h >= a0 && h <= a1) {
            const t = (h - a0) / (a1 - a0);
            return (b0 + (b1 - b0) * t) % 360;
        }
    }
    return h;
}

export function rgbHueToRybHue(rgbHue) {
    const h = ((rgbHue % 360) + 360) % 360;
    for (let i = 0; i < RYB_TO_RGB_STOPS.length - 1; i++) {
        const [a0, b0] = RYB_TO_RGB_STOPS[i];
        const [a1, b1] = RYB_TO_RGB_STOPS[i + 1];
        if (h >= b0 && h <= b1) {
            const t = (h - b0) / (b1 - b0);
            return (a0 + (a1 - a0) * t) % 360;
        }
    }
    return h;
}

// Smooth, strictly monotonic perceptual OKLCH Hue (0..360) <-> Vivid HSV Hue (0..360)
// Eliminates the #0000FF backward-fold crease (~264 deg) where raw HSV corners stalled.
const OKLCH_TO_HSV_STOPS = [
    [0, 340],    // Magenta-Rose
    [29, 360],   // True sRGB Red (#FF0000)
    [55, 390],   // Orange
    [110, 420],  // Yellow (#FFFF00)
    [142, 480],  // Green (#00FF00)
    [195, 540],  // Cyan (#00FFFF)
    [250, 570],  // Azure
    [264, 600],  // Blue (#0000FF)
    [294, 630],  // Indigo / Violet
    [328, 660],  // Magenta (#FF00FF)
    [360, 700]   // Wrap back to Rose
];

export function oklchHueToHsvHue(oklchHue) {
    const h = ((oklchHue % 360) + 360) % 360;
    for (let i = 0; i < OKLCH_TO_HSV_STOPS.length - 1; i++) {
        const [a0, b0] = OKLCH_TO_HSV_STOPS[i];
        const [a1, b1] = OKLCH_TO_HSV_STOPS[i + 1];
        if (h >= a0 && h <= a1) {
            const t = (h - a0) / (a1 - a0 || 1);
            return (((b0 + (b1 - b0) * t) % 360) + 360) % 360;
        }
    }
    return 340;
}

export function hsvHueToOklchHue(hsvHue) {
    let h = ((hsvHue % 360) + 360) % 360;
    if (h < 340) h += 360;
    for (let i = 0; i < OKLCH_TO_HSV_STOPS.length - 1; i++) {
        const [a0, b0] = OKLCH_TO_HSV_STOPS[i];
        const [a1, b1] = OKLCH_TO_HSV_STOPS[i + 1];
        if (h >= b0 && h <= b1) {
            const t = (h - b0) / (b1 - b0 || 1);
            return (((a0 + (a1 - a0) * t) % 360) + 360) % 360;
        }
    }
    return h % 360;
}

// Subtractive CMYK Wheel (0°=Magenta, 60°=Red, 120°=Yellow, 180°=Green, 240°=Cyan, 300°=Blue)
// Bijective 1:1 with CMYK(c,m,y,k): S = max ink saturation (0..100), V = 100 - K
export function rgbToCmykWheelHsv(r, g, b) {
    const { c, m, y, k } = rgbToCmyk(r, g, b);
    const maxInk = Math.max(c, m, y);
    const s = clamp(maxInk, 0, 100);
    const v = clamp(100 - k, 0, 100);
    if (maxInk <= 1e-4) {
        return { h: 0, s: 0, v };
    }
    const cn = c / maxInk;
    const mn = m / maxInk;
    const yn = y / maxInk;
    let h = 0;
    if (cn <= mn && cn <= yn) {
        // C is 0: active M and Y (0°..120°)
        h = yn >= mn ? 60 + 60 * (1 - mn) : 60 * yn;
    } else if (mn <= cn && mn <= yn) {
        // M is 0: active Y and C (120°..240°)
        h = cn >= yn ? 180 + 60 * (1 - yn) : 120 + 60 * cn;
    } else {
        // Y is 0: active C and M (240°..360°)
        h = mn >= cn ? 300 + 60 * (1 - cn) : 240 + 60 * mn;
    }
    return { h: ((h % 360) + 360) % 360, s, v };
}

export function cmykWheelHsvToRgb(h, s, v) {
    const a = ((h % 360) + 360) % 360;
    const sat = clamp(s, 0, 100);
    const k = clamp(100 - clamp(v, 0, 100), 0, 100);
    const sector = Math.floor(a / 60) % 6;
    const f = (a / 60) - Math.floor(a / 60);
    let c = 0, m = 0, y = 0;
    if (sector === 0) { c = 0; m = 1; y = f; }
    else if (sector === 1) { c = 0; m = 1 - f; y = 1; }
    else if (sector === 2) { c = f; m = 0; y = 1; }
    else if (sector === 3) { c = 1; m = 0; y = 1 - f; }
    else if (sector === 4) { c = 1; m = f; y = 0; }
    else { c = 1 - f; m = 1; y = 0; }
    return cmykToRgb(c * sat, m * sat, y * sat, k);
}

// Seam-free pure perceptual OKLCH disc sampling for Harmony Wheel
export function oklchWheelColor(deg, radius01, lightness = 70, studioWhiteCenter = false) {
    const r = clamp(radius01, 0, 1);
    const maxRimChroma = 0.34;
    const L = studioWhiteCenter
        ? clamp(97 - 27 * r, 0, 100)
        : clamp(lightness, 0, 100);
    return oklchToRgb(L, r * maxRimChroma, deg);
}

// Perceptual OKLab (a, b) opponent disc sampling around neutral grey center
export function oklabWheelColor(deg, radius01, lightness = 68, studioNeutralCenter = false) {
    const r = clamp(radius01, 0, 1);
    const maxRimChroma = 0.34;
    const L = studioNeutralCenter ? 68 : clamp(lightness, 0, 100);
    const rad = (((deg % 360) + 360) % 360) * (Math.PI / 180);
    const c = r * maxRimChroma;
    return oklabToRgb(L, c * Math.cos(rad), c * Math.sin(rad), true);
}

// Convert Wheel Degree (0..360) in chosen wheelSpace -> vivid or sat/val RGB
export function wheelAngleToRgb(deg, wheelSpace = 'ryb', sat = 100, val = 100) {
    const a = ((deg % 360) + 360) % 360;
    if (wheelSpace === 'cmyk') {
        return cmykWheelHsvToRgb(a, sat, val);
    }
    if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
        const hsvH = oklchHueToHsvHue(a);
        return hsvToRgb(hsvH, sat, val);
    }
    const rgbHue = wheelSpace === 'ryb' ? rybHueToRgbHue(a) : a;
    return hsvToRgb(rgbHue, sat, val);
}

export function rgbToWheelHsv(r, g, b, wheelSpace = 'ryb') {
    if (wheelSpace === 'cmyk') {
        return rgbToCmykWheelHsv(r, g, b);
    }
    const hsv = rgbToHsv(r, g, b);
    if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
        const lch = rgbToOklch(r, g, b);
        const h = lch.C > 0.004 ? lch.H : hsvHueToOklchHue(hsv.h);
        return { h, s: hsv.s, v: hsv.v };
    }
    const h = wheelSpace === 'ryb' ? rgbHueToRybHue(hsv.h) : hsv.h;
    return { h, s: hsv.s, v: hsv.v };
}

export function wheelHsvToRgb(h, s, v, wheelSpace = 'ryb') {
    if (wheelSpace === 'cmyk') {
        return cmykWheelHsvToRgb(h, s, v);
    }
    if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
        const hsvH = oklchHueToHsvHue(h);
        return hsvToRgb(hsvH, s, v);
    }
    const rgbHue = wheelSpace === 'ryb' ? rybHueToRgbHue(h) : h;
    return hsvToRgb(rgbHue, s, v);
}

// ==================== MULTI-SPACE COLOR MIXING ====================
export function mixColorsSpace(hex1, hex2, ratio = 0.5, space = 'ryb') {
    const t = clamp(ratio, 0, 1);
    const c1 = hexToRgb(hex1);
    const c2 = hexToRgb(hex2);

    if (space === 'rgb') {
        return rgbToHex(
            c1.r * (1 - t) + c2.r * t,
            c1.g * (1 - t) + c2.g * t,
            c1.b * (1 - t) + c2.b * t
        );
    }

    if (space === 'oklab') {
        const l1 = rgbToOklab(c1.r, c1.g, c1.b);
        const l2 = rgbToOklab(c2.r, c2.g, c2.b);
        const out = oklabToRgb(
            l1.L * (1 - t) + l2.L * t,
            l1.a * (1 - t) + l2.a * t,
            l1.b * (1 - t) + l2.b * t,
            true
        );
        return rgbToHex(out.r, out.g, out.b);
    }

    if (space === 'oklch') {
        const p1 = rgbToOklch(c1.r, c1.g, c1.b);
        const p2 = rgbToOklch(c2.r, c2.g, c2.b);
        let dh = p2.H - p1.H;
        if (p1.C < 0.008) dh = 0;
        if (p2.C < 0.008) dh = 0;
        if (dh > 180) dh -= 360;
        if (dh < -180) dh += 360;
        const h = p1.C < 0.008 ? p2.H : (p1.H + dh * t + 360) % 360;
        const out = oklchToRgb(
            p1.L * (1 - t) + p2.L * t,
            p1.C * (1 - t) + p2.C * t,
            h
        );
        return rgbToHex(out.r, out.g, out.b);
    }

    if (space === 'cmyk') {
        const m1 = rgbToCmyk(c1.r, c1.g, c1.b);
        const m2 = rgbToCmyk(c2.r, c2.g, c2.b);
        const out = cmykToRgb(
            m1.c * (1 - t) + m2.c * t,
            m1.m * (1 - t) + m2.m * t,
            m1.y * (1 - t) + m2.y * t,
            m1.k * (1 - t) + m2.k * t
        );
        return rgbToHex(out.r, out.g, out.b);
    }

    // Default: 'ryb' painterly mixing (Yellow + Blue = vivid Green!)
    const p1 = rgbToRyb(c1.r, c1.g, c1.b);
    const p2 = rgbToRyb(c2.r, c2.g, c2.b);
    let r = p1.r * (1 - t) + p2.r * t;
    let y = p1.y * (1 - t) + p2.y * t;
    let b = p1.b * (1 - t) + p2.b * t;

    // Pigment saturation compensation for pure 2-primary mixes (Y+B, R+Y, R+B)
    // without distorting neutral/black/complement mixes where min(r,y,b) > 0
    const max1 = Math.max(p1.r, p1.y, p1.b);
    const max2 = Math.max(p2.r, p2.y, p2.b);
    const targetMax = max1 * (1 - t) + max2 * t;
    const rawMax = Math.max(r, y, b);
    const rawMin = Math.min(r, y, b);
    if (rawMax > 1 && targetMax > rawMax) {
        const chromaWeight = clamp(1 - (rawMin / 35), 0, 1);
        const scale = 1 + ((targetMax / rawMax) - 1) * chromaWeight;
        r = clamp(r * scale, 0, 100);
        y = clamp(y * scale, 0, 100);
        b = clamp(b * scale, 0, 100);
    }

    const out = rybToRgb(r, y, b);
    return rgbToHex(out.r, out.g, out.b);
}

export function shiftColorSpace(hex, hDelta = 0, sDelta = 0, lDelta = 0, space = 'hsl') {
    const rgb = hexToRgb(hex);

    if (space === 'ryb') {
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        const rybH = rgbHueToRybHue(hsl.h);
        const nextRybH = ((rybH + hDelta) % 360 + 360) % 360;
        const nextRgbH = rybHueToRgbHue(nextRybH);
        const nextS = clamp(hsl.s + sDelta, 0, 100);
        const nextL = clamp(hsl.l + lDelta, 0, 100);
        const out = hslToRgb(nextRgbH, nextS, nextL);
        return rgbToHex(out.r, out.g, out.b);
    }

    if (space === 'cmyk') {
        const w = rgbToCmykWheelHsv(rgb.r, rgb.g, rgb.b);
        const nextH = ((w.h + hDelta) % 360 + 360) % 360;
        const nextS = clamp(w.s + sDelta, 0, 100);
        const nextV = clamp(w.v + lDelta, 0, 100);
        const out = cmykWheelHsvToRgb(nextH, nextS, nextV);
        return rgbToHex(out.r, out.g, out.b);
    }

    if (space === 'oklch' || space === 'oklab') {
        const lch = rgbToOklch(rgb.r, rgb.g, rgb.b);
        const nextH = ((lch.H + hDelta) % 360 + 360) % 360;
        const nextC = clamp(lch.C + (sDelta * 0.0022), 0, 0.36);
        const nextL = clamp(lch.L + (lDelta * 0.85), 2, 99);
        const out = oklchToRgb(nextL, nextC, nextH);
        return rgbToHex(out.r, out.g, out.b);
    }

    return shiftColor(hex, hDelta, sDelta, lDelta);
}

// Painterly Warm/Cool + Chroma + Value shift helper
// temp (-100 Cool Blue <-> +100 Warm Golden-Red), chroma (-100..+100), value (-100..+100)
export function applyPainterlyShift(hex, tempDelta = 0, chromaDelta = 0, valueDelta = 0) {
    let cur = hex;
    if (Math.abs(tempDelta) > 0.5) {
        const target = tempDelta > 0 ? '#FF8800' : '#0066FF';
        cur = mixColorsSpace(cur, target, clamp(Math.abs(tempDelta) / 140, 0, 0.7), 'ryb');
    }
    const lch = rgbToOklch(...Object.values(hexToRgb(cur)));
    const nextL = clamp(lch.L + valueDelta * 0.45, 2, 99);
    const nextC = clamp(lch.C * (1 + chromaDelta / 100), 0, 0.36);
    const out = oklchToRgb(nextL, nextC, lch.H);
    return rgbToHex(out.r, out.g, out.b);
}

const WARM_AXIS_RAD = 36 * (Math.PI / 180);
const WARM_UX = Math.cos(WARM_AXIS_RAD);
const WARM_UY = Math.sin(WARM_AXIS_RAD);

export function getMaxOklchChroma(L, H) {
    const L01 = clamp(L / 100, 0, 1);
    if (L01 <= 0.002 || L01 >= 0.998) return 0;
    const rad = (((H % 360) + 360) % 360) * (Math.PI / 180);
    const ca = Math.cos(rad);
    const cb = Math.sin(rad);
    let lo = 0;
    let hi = 0.40;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) * 0.5;
        if (inLinearGamut(oklabToLinearSrgbRaw(L01, mid * ca, mid * cb))) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function findWarmAxisBounds(L, p, wAnchor) {
    const L01 = clamp(L / 100, 0.005, 0.995);
    let wCenter = wAnchor;
    if (!inLinearGamut(oklabToLinearSrgbRaw(L01, wCenter * WARM_UX - p * WARM_UY, wCenter * WARM_UY + p * WARM_UX))) {
        wCenter = 0;
    }
    let lo = -0.45;
    let hi = wCenter;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) * 0.5;
        if (inLinearGamut(oklabToLinearSrgbRaw(L01, mid * WARM_UX - p * WARM_UY, mid * WARM_UY + p * WARM_UX))) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    const wMin = hi;
    lo = wCenter;
    hi = 0.45;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) * 0.5;
        if (inLinearGamut(oklabToLinearSrgbRaw(L01, mid * WARM_UX - p * WARM_UY, mid * WARM_UY + p * WARM_UX))) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return { wMin, wMax: lo };
}

// Invertible, gamut-normalized Warm <-> Cool model in [-100..+100] so the slider never hits fake walls.
export function getPainterlyWarmCoolModel(hex) {
    const { r, g, b } = hexToRgb(hex);
    const lab = rgbToOklab(r, g, b);
    const L = lab.L;
    const w = lab.a * WARM_UX + lab.b * WARM_UY;
    const p = -lab.a * WARM_UY + lab.b * WARM_UX;

    let { wMin, wMax } = findWarmAxisBounds(L, p, w);
    let Lcool = L, Lwarm = L, pcool = p, pwarm = p;

    // For extreme lightness corners (#FFFF00, near-white, near-black), open a smooth painter's span
    if (wMax - wMin < 0.08) {
        const targetL = L > 80 ? 74 : (L < 20 ? 32 : L);
        const targetP = p * 0.4;
        const b2 = findWarmAxisBounds(targetL, targetP, 0);
        wMin = Math.min(wMin, b2.wMin);
        wMax = Math.max(wMax, b2.wMax);
        Lcool = targetL; Lwarm = targetL;
        pcool = targetP; pwarm = targetP;
    }

    const span = Math.max(0.02, wMax - wMin);
    const tCur = clamp((w - wMin) / span, 0, 1);
    const value = tCur * 200 - 100;

    const sample = (val100) => {
        const t = clamp((val100 + 100) / 200, 0, 1);
        const wt = wMin + t * (wMax - wMin);
        let Lt = L;
        let pt = p;
        if (Lcool !== L || pcool !== p) {
            if (t < tCur && tCur > 1e-4) {
                const k = 1 - t / tCur;
                Lt = L + (Lcool - L) * k;
                pt = p + (pcool - p) * k;
            } else if (t > tCur && (1 - tCur) > 1e-4) {
                const k = (t - tCur) / (1 - tCur);
                Lt = L + (Lwarm - L) * k;
                pt = p + (pwarm - p) * k;
            }
        }
        const out = oklabToRgb(Lt, wt * WARM_UX - pt * WARM_UY, wt * WARM_UY + pt * WARM_UX, true);
        return rgbToHex(out.r, out.g, out.b);
    };

    return { value, sample };
}

// Compute Warmth (-100 cool to +100 warm) for painterly readout
export function getColorTemperature(hex) {
    return clamp(Math.round(getPainterlyWarmCoolModel(hex).value), -100, 100);
}

export function getContrastTextColor(hex) {
    const { r, g, b } = hexToRgb(hex);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#000000' : '#FFFFFF';
}

export function isCanvasEmpty(canvas) {
    if (!canvas || canvas.width === 0 || canvas.height === 0) return true;
    const ctx = canvas.getContext('2d', { alpha: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const u32 = new Uint32Array(imageData.data.buffer);
    if (wasmCore && wasmCore.ready) {
        return wasmCore.isBufferEmpty(u32);
    }
    const len = u32.length;
    let i = 0;
    const len8 = len & ~7;
    while (i < len8) {
        if ((u32[i] & 0xFF000000) !== 0 ||
            (u32[i+1] & 0xFF000000) !== 0 ||
            (u32[i+2] & 0xFF000000) !== 0 ||
            (u32[i+3] & 0xFF000000) !== 0 ||
            (u32[i+4] & 0xFF000000) !== 0 ||
            (u32[i+5] & 0xFF000000) !== 0 ||
            (u32[i+6] & 0xFF000000) !== 0 ||
            (u32[i+7] & 0xFF000000) !== 0) {
            return false;
        }
        i += 8;
    }
    while (i < len) {
        if ((u32[i] & 0xFF000000) !== 0) return false;
        i++;
    }
    return true;
}

export const isMobileDevice = typeof navigator !== 'undefined' && (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// Fast zero-allocation Painterly RYB <-> sRGB helpers for real-time canvas paint engines (CPU + GPU)
const _rybTmp = new Float32Array(6);

export function rgb255ToRyb01(r, g, b, out, off = 0) {
    let rn = r < 0 ? 0 : (r > 255 ? 1 : r * (1 / 255));
    let gn = g < 0 ? 0 : (g > 255 ? 1 : g * (1 / 255));
    let bn = b < 0 ? 0 : (b > 255 ? 1 : b * (1 / 255));

    const w = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    rn -= w;
    gn -= w;
    bn -= w;

    const maxRGB = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    let y = rn < gn ? rn : gn;
    rn -= y;
    gn -= y;

    if (bn > 0 && gn > 0) {
        bn *= 0.5;
        gn *= 0.5;
    }
    y += gn;
    bn += gn;

    const maxRYB = rn > y ? (rn > bn ? rn : bn) : (y > bn ? y : bn);
    if (maxRYB > 1e-5) {
        const n = maxRGB / maxRYB;
        rn *= n;
        y *= n;
        bn *= n;
    }

    out[off] = rn + w;
    out[off + 1] = y + w;
    out[off + 2] = bn + w;
}

export function ryb01ToRgb255(rn, yn, bn, out, off = 0) {
    const w = rn < yn ? (rn < bn ? rn : bn) : (yn < bn ? yn : bn);
    rn -= w;
    yn -= w;
    bn -= w;

    const maxRYB = rn > yn ? (rn > bn ? rn : bn) : (yn > bn ? yn : bn);
    let gn = yn < bn ? yn : bn;
    yn -= gn;
    bn -= gn;

    if (bn > 0 && gn > 0) {
        bn *= 2.0;
        gn *= 2.0;
    }
    rn += yn;
    gn += yn;

    const maxRGB = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    if (maxRGB > 1e-5) {
        const n = maxRYB / maxRGB;
        rn *= n;
        gn *= n;
        bn *= n;
    }

    const r = (rn + w) * 255;
    const g = (gn + w) * 255;
    const b = (bn + w) * 255;
    out[off] = r < 0 ? 0 : (r > 255 ? 255 : r);
    out[off + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
    out[off + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
}

export function mixRgb255Ryb(r1, g1, b1, r2, g2, b2, t, out = _rybTmp, off = 0) {
    if (t <= 0) {
        out[off] = r1; out[off + 1] = g1; out[off + 2] = b1;
        return out;
    }
    if (t >= 1) {
        out[off] = r2; out[off + 1] = g2; out[off + 2] = b2;
        return out;
    }
    rgb255ToRyb01(r1, g1, b1, _rybTmp, 0);
    rgb255ToRyb01(r2, g2, b2, _rybTmp, 3);
    const inv = 1.0 - t;
    ryb01ToRgb255(
        _rybTmp[0] * inv + _rybTmp[3] * t,
        _rybTmp[1] * inv + _rybTmp[4] * t,
        _rybTmp[2] * inv + _rybTmp[5] * t,
        out,
        off
    );
    return out;
}

export const GLSL_RYB_MIX = `
vec3 rgbToRyb01(vec3 c) {
  float w = min(c.r, min(c.g, c.b));
  vec3 d = max(c - w, vec3(0.0));
  float maxRGB = max(d.r, max(d.g, d.b));
  float y = min(d.r, d.g);
  float r = d.r - y;
  float g = d.g - y;
  float b = d.b;
  if (b > 0.0 && g > 0.0) {
    b *= 0.5;
    g *= 0.5;
  }
  y += g;
  b += g;
  float maxRYB = max(r, max(y, b));
  if (maxRYB > 0.00001) {
    float n = maxRGB / maxRYB;
    r *= n; y *= n; b *= n;
  }
  return clamp(vec3(r, y, b) + w, 0.0, 1.0);
}

vec3 rybToRgb01(vec3 c) {
  float w = min(c.x, min(c.y, c.z));
  float rn = max(c.x - w, 0.0);
  float yn = max(c.y - w, 0.0);
  float bn = max(c.z - w, 0.0);
  float maxRYB = max(rn, max(yn, bn));
  float gn = min(yn, bn);
  yn -= gn;
  bn -= gn;
  if (bn > 0.0 && gn > 0.0) {
    bn *= 2.0;
    gn *= 2.0;
  }
  rn += yn;
  gn += yn;
  float maxRGB = max(rn, max(gn, bn));
  if (maxRGB > 0.00001) {
    float n = maxRYB / maxRGB;
    rn *= n; gn *= n; bn *= n;
  }
  return clamp(vec3(rn, gn, bn) + w, 0.0, 1.0);
}

vec3 mixPaintCol(vec3 colA, vec3 colB, float t, int phys) {
  if (phys == 0) return mix(colA, colB, t);
  return rybToRgb01(mix(rgbToRyb01(colA), rgbToRyb01(colB), t));
}

vec4 mixPremulPaint(vec4 pA, vec4 pB, float t, int phys) {
  if (phys == 0) return mix(pA, pB, t);
  float outA = mix(pA.a, pB.a, t);
  if (outA <= 0.002) return vec4(0.0);
  if (pA.a <= 0.002) return pB * t;
  if (pB.a <= 0.002) return pA * (1.0 - t);
  float wB = clamp((pB.a * t) / outA, 0.0, 1.0);
  vec3 cA = clamp(pA.rgb / pA.a, 0.0, 1.0);
  vec3 cB = clamp(pB.rgb / pB.a, 0.0, 1.0);
  vec3 cMix = mixPaintCol(cA, cB, wB, 1);
  return vec4(clamp(cMix * outA, 0.0, outA), outA);
}
`;

