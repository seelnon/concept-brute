
import { wasmCore } from './wasm/wasmBridge.js';

export function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    let colorStr = hex.trim().toLowerCase();
    let r = 0, g = 0, b = 0;
    
    if (colorStr.startsWith('#')) {
        if (colorStr.length === 4) {
            r = parseInt(colorStr[1] + colorStr[1], 16);
            g = parseInt(colorStr[2] + colorStr[2], 16);
            b = parseInt(colorStr[3] + colorStr[3], 16);
        } else {
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
        r: isNaN(r) ? 0 : r, 
        g: isNaN(g) ? 0 : g, 
        b: isNaN(b) ? 0 : b 
    };
}

export function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(x => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
    }).join("");
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
    let h, s, l = (max + min) / 2;

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
    h /= 360; s /= 100; l /= 100;
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
}

export function shiftColor(hex, hDelta = 0, sDelta = 0, lDelta = 0) {
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    
    // Apply shifts
    hsl.h = (hsl.h + hDelta) % 360;
    if (hsl.h < 0) hsl.h += 360;
    hsl.s = Math.max(0, Math.min(100, hsl.s + sDelta));
    hsl.l = Math.max(0, Math.min(100, hsl.l + lDelta));
    
    const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
    return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

export function hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    let i = Math.floor(h * 6);
    let f = h * 6 - i;
    let p = v * (1 - s);
    let q = v * (1 - f * s);
    let t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
}

export function rgbToHsv(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0;
    } else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s * 100, v: v * 100 };
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
    // 32-bit fast scan unrolled by 8
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

