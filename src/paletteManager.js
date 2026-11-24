import {
    clamp,
    hexToRgb,
    rgbToHex,
    normalizeHex,
    rgbToHsl,
    hslToRgb,
    rgbToHsv,
    hsvToRgb,
    rgbToRyb,
    rybToRgb,
    rgbToCmyk,
    cmykToRgb,
    rgbToOklab,
    oklabToRgb,
    rgbToOklch,
    oklchToRgb,
    rybHueToRgbHue,
    rgbHueToRybHue,
    wheelAngleToRgb,
    rgbToWheelHsv,
    wheelHsvToRgb,
    mixColorsSpace,
    shiftColorSpace,
    applyPainterlyShift,
    getColorTemperature,
    getMaxOklchChroma,
    getPainterlyWarmCoolModel,
    getContrastTextColor,
    oklchHueToHsvHue,
    hsvHueToOklchHue,
    oklchWheelColor,
    oklabWheelColor
} from './colorUtils.js';

export const SYMMETRY_MODES = [
    { id: 'custom', label: 'CUSTOM (FREE 6)' },
    { id: 'complementary', label: 'COMPLEMENTARY' },
    { id: 'analogous', label: 'ANALOGOUS' },
    { id: 'split', label: 'SPLIT-COMPLEMENTARY' },
    { id: 'triadic', label: 'TRIADIC' },
    { id: 'tetradic', label: 'TETRADIC / SQUARE' },
    { id: 'clash', label: 'CLASH' },
    { id: 'double', label: 'DOUBLE-COMPLEMENT' },
    { id: 'monochrome', label: 'MONOCHROMATIC' },
    { id: 'six-tone', label: 'SIX-TONE RADIAL' }
];

export const ROW_TEMPLATES = [
    { id: 'main', label: 'MAIN ANCHORS', defaultCols: 6 },
    { id: 'pair-mix', label: 'PAIR MIXES [1+2, 3+4, 5+6]', defaultCols: 3 },
    { id: 'adj-mix', label: 'ADJACENT RING MIXES', defaultCols: 6 },
    { id: 'bridge-tint', label: 'LIGHT TINTS & MID MIX', defaultCols: 4 },
    { id: 'anchor-shift', label: 'SHIFTED ANCHOR ACCENTS', defaultCols: 6 },
    { id: 'value-ramp', label: 'ACTIVE VALUE RAMP (DARK→LIGHT)', defaultCols: 6 },
    { id: 'temp-ramp', label: 'ACTIVE TEMP RAMP (COOL→WARM)', defaultCols: 6 },
    { id: 'complements', label: 'ANCHOR COMPLEMENTS', defaultCols: 6 }
];

export const SLIDER_PACKS = [
    { id: 'painterly', label: 'PAINTERLY (TEMP / TONE / CHROMA)' },
    { id: 'ryb', label: 'RYB PIGMENT (R / Y / B · Y+B=GREEN)' },
    { id: 'oklch', label: 'OKLCH (LIGHT / CHROMA / HUE)' },
    { id: 'oklab', label: 'OKLAB (L / A-GRN-RED / B-BLU-YEL)' },
    { id: 'cmyk', label: 'CMYK (SUBTRACTIVE INK)' },
    { id: 'hsv', label: 'HSV / HSB' },
    { id: 'hsl', label: 'HSL' },
    { id: 'rgb', label: 'RGB' }
];

export const PICKER_SHAPES = [
    { id: 'sv-square', label: 'SQUARE + BAR' },
    { id: 'ring-triangle', label: 'TRIANGLE + CIRCLE RING' },
    { id: 'ring-square', label: 'SQUARE + CIRCLE RING' },
    { id: 'wheel', label: 'HARMONY WHEEL' },
    { id: 'none', label: 'NONE (SLIDERS ONLY)' }
];

export const PALETTE_PRESETS = [
    {
        id: 'classic',
        name: 'BRUTE CLASSIC',
        colors: ['#B91C1C', '#1E40AF', '#84CC16', '#EAB308', '#F97316', '#4338CA'],
        wheelSpace: 'ryb',
        mixSpace: 'ryb',
        symmetry: 'custom'
    },
    {
        id: 'zorn',
        name: 'ZORN OIL',
        colors: ['#C93B2B', '#E2A03F', '#2B303A', '#EDE6D6', '#8C583A', '#6B7F82'],
        wheelSpace: 'ryb',
        mixSpace: 'ryb',
        symmetry: 'custom'
    },
    {
        id: 'ryb-primaries',
        name: 'RYB PAINTER',
        colors: ['#E11D48', '#FACC15', '#1D4ED8', '#FB923C', '#16A34A', '#7E22CE'],
        wheelSpace: 'ryb',
        mixSpace: 'ryb',
        symmetry: 'six-tone'
    },
    {
        id: 'mudcube',
        name: 'MUDCUBE VIVID',
        colors: ['#7D91E6', '#837BE4', '#A17CE5', '#BD7DE6', '#D97EE7', '#E77EC9'],
        wheelSpace: 'oklch',
        mixSpace: 'oklab',
        symmetry: 'analogous'
    },
    {
        id: 'botanical',
        name: 'INK & OCHRE',
        colors: ['#1C1917', '#B45309', '#4D7C0F', '#0F766E', '#DC2626', '#E7E5E4'],
        wheelSpace: 'ryb',
        mixSpace: 'ryb',
        symmetry: 'custom'
    }
];

function createDefaultRows() {
    return [
        { id: 'main', enabled: true, label: 'MAIN ANCHORS (6)', type: 'main', cols: 6, hShift: 0, sShift: 0, lShift: 0 },
        { id: 'mix-warm', enabled: true, label: 'WARM PAIR MIXES', type: 'pair-mix', cols: 3, hShift: 10, sShift: 5, lShift: 5 },
        { id: 'tints-mid', enabled: true, label: 'TINTS & MID MIXES', type: 'bridge-tint', cols: 4, hShift: 0, sShift: -10, lShift: 30 },
        { id: 'mix-cool', enabled: true, label: 'COOL VIVID MIXES', type: 'pair-mix', cols: 3, hShift: -10, sShift: 10, lShift: 15 },
        { id: 'accents', enabled: true, label: 'SHIFTED ACCENTS', type: 'anchor-shift', cols: 6, hShift: 20, sShift: 20, lShift: 10 }
    ];
}

export function createDefaultPaletteConfig() {
    return {
        wheelSpace: 'ryb',      // 'ryb' | 'oklch' | 'hsl'
        mixSpace: 'ryb',        // 'ryb' | 'oklab' | 'oklch' | 'cmyk' | 'rgb'
        paletteMode: 'digital', // 'digital' | 'physical'
        canvasMixMode: 'physical', // 'physical' | 'digital'
        pickerShape: 'sv-square', // 'sv-square' | 'ring-triangle' | 'ring-square' | 'wheel' | 'none'
        symmetry: 'custom',     // SYMMETRY_MODES id
        spread: 30,             // degrees 5..90
        harmonyContrast: 16,    // 0..45 lightness/chroma delta
        autoSyncSymmetry: false,
        groupLock: false,       // true => moving ANY node rotates/shifts all non-frozen nodes preserving ratios
        locks: [false, false, false, false, false, false],
        showSwatches: true,
        showHex: true,
        swatchHeight: 24,
        swatchGap: 2,
        swatchShape: 'square',  // 'square' | 'rounded'
        panelWidth: 204,
        sliderGroups: {
            painterly: false,
            ryb: false,
            oklch: false,
            oklab: false,
            cmyk: false,
            hsv: false,
            hsl: false,
            rgb: false
        },
        rows: createDefaultRows()
    };
}

export class PaletteManager {
    constructor() {
        this.baseColors = [
            '#B91C1C', // 1: Red
            '#1E40AF', // 2: Blue
            '#84CC16', // 3: Green
            '#EAB308', // 4: Yellow
            '#F97316', // 5: Orange
            '#4338CA'  // 6: Indigo
        ];
        this.config = createDefaultPaletteConfig();
        this.customPresets = [];
        this.activeIndex = 0;
        this._groupCoords = null;
        this.storage = null;
        this.projectId = 'default';

        this._loadFromStorage();
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
    }

    setStorage(storage, projectId = null) {
        this.storage = storage || null;
        if (projectId) this.projectId = projectId;
    }

    setProjectId(projectId) {
        if (projectId) this.projectId = projectId;
    }

    _cloneConfig(cfg = this.config) {
        const src = cfg || createDefaultPaletteConfig();
        return {
            ...src,
            sliderGroups: { ...(src.sliderGroups || {}) },
            locks: Array.isArray(src.locks) ? [...src.locks] : [false, false, false, false, false, false],
            rows: Array.isArray(src.rows) ? src.rows.map(r => ({ ...r })) : createDefaultRows()
        };
    }

    _loadFromStorage() {
        // Fallback/initial sync read only if legacy keys exist before IDB hydration removes them
        try {
            const savedColors = localStorage.getItem('canvas_palette');
            if (savedColors) {
                const parsed = JSON.parse(savedColors);
                if (Array.isArray(parsed) && parsed.length === 6) {
                    this.baseColors = parsed.map(c => normalizeHex(c, '#333333'));
                }
            }
        } catch (e) {}

        try {
            const savedCfg = localStorage.getItem('canvas_palette_config_v2');
            if (savedCfg) {
                const parsed = JSON.parse(savedCfg);
                this.applySerializedState(parsed, { save: false });
            }
        } catch (e) {}

        try {
            const savedPresets = localStorage.getItem('canvas_palette_presets_v1');
            if (savedPresets) {
                const parsed = JSON.parse(savedPresets);
                if (Array.isArray(parsed)) this.customPresets = parsed;
            }
        } catch (e) {}
    }

    async hydrateFromStorage(projectId = null) {
        if (!this.storage) return;
        if (projectId) this.projectId = projectId;
        const pid = projectId || this.projectId || 'default';
        await this.storage.ensureReady();

        const [cfgState, presets, projState] = await Promise.all([
            this.storage.loadPaletteCompartment('config'),
            this.storage.loadPaletteCompartment('presets'),
            this.storage.loadPaletteCompartment(`p_${pid}`)
        ]);

        if (projState) {
            this.applySerializedState(projState, { save: false });
        } else if (cfgState) {
            this.applySerializedState(cfgState, { save: false });
        } else {
            // Migrate legacy localStorage palette config once into IDB palette compartment
            let hadLegacy = false;
            try {
                if (localStorage.getItem('canvas_palette') || localStorage.getItem('canvas_palette_config_v2')) {
                    hadLegacy = true;
                }
            } catch (_) {}
            if (hadLegacy) {
                await this.storage.savePaletteCompartment('config', this.getSerializedState(), true);
            }
        }

        if (Array.isArray(presets)) {
            this.customPresets = presets;
        } else {
            try {
                const legacyPresets = localStorage.getItem('canvas_palette_presets_v1');
                if (legacyPresets) {
                    const parsed = JSON.parse(legacyPresets);
                    if (Array.isArray(parsed)) this.customPresets = parsed;
                    await this.storage.savePaletteCompartment('presets', this.customPresets, true);
                }
            } catch (_) {}
        }

        // Remove legacy synchronous localStorage blobs after migration to IDB
        try {
            localStorage.removeItem('canvas_palette');
            localStorage.removeItem('canvas_palette_config_v2');
            localStorage.removeItem('canvas_palette_presets_v1');
        } catch (_) {}
    }

    saveConfig() {
        if (this.storage) {
            this.storage.savePaletteCompartment('config', this.getSerializedState());
        } else {
            try {
                localStorage.setItem('canvas_palette', JSON.stringify(this.baseColors));
                localStorage.setItem('canvas_palette_config_v2', JSON.stringify(this.getSerializedState()));
            } catch (e) {}
        }
    }

    saveProjectPalette(projectId = null) {
        const pid = projectId || this.projectId || this.storage?.projectId || 'default';
        if (this.storage) {
            this.storage.savePaletteCompartment(`p_${pid}`, this.getSerializedState());
        }
    }

    saveCustomPresets() {
        if (this.storage) {
            this.storage.savePaletteCompartment('presets', this.customPresets, true);
        } else {
            try {
                localStorage.setItem('canvas_palette_presets_v1', JSON.stringify(this.customPresets));
            } catch (e) {}
        }
    }

    getSerializedState() {
        return {
            baseColors: [...this.baseColors],
            config: this._cloneConfig(this.config)
        };
    }

    applySerializedState(data, { save = true } = {}) {
        if (!data) return;
        if (Array.isArray(data)) {
            if (data.length === 6) {
                this.baseColors = data.map(c => normalizeHex(c, '#333333'));
            }
            if (save) this.saveConfig();
            return;
        }
        if (Array.isArray(data.baseColors) && data.baseColors.length === 6) {
            this.baseColors = data.baseColors.map(c => normalizeHex(c, '#333333'));
        }
        if (data.config && typeof data.config === 'object') {
            const def = createDefaultPaletteConfig();
            const merged = {
                ...def,
                ...data.config,
                sliderGroups: { ...def.sliderGroups, ...(data.config.sliderGroups || {}) },
                locks: Array.isArray(data.config.locks) && data.config.locks.length === 6
                    ? data.config.locks.map(Boolean)
                    : [...def.locks],
                rows: Array.isArray(data.config.rows) && data.config.rows.length > 0
                    ? data.config.rows.map(r => ({ ...r }))
                    : createDefaultRows()
            };
            this.config = merged;
        }
        this._groupCoords = this.config.groupLock ? this.captureGroupBaseline() : null;
        if (save) this.saveConfig();
    }

    resetDefaults() {
        const fresh = createDefaultPaletteConfig();
        this.baseColors = ['#B91C1C', '#1E40AF', '#84CC16', '#EAB308', '#F97316', '#4338CA'];
        this.config = fresh;
        this.activeIndex = 0;
        this._groupCoords = null;
        this.saveConfig();
    }

    _extractSpaceCoord(hex, space = null, override = null) {
        const ws = space || this.config.wheelSpace || 'ryb';
        const rgb = hexToRgb(hex);
        if (ws === 'oklch' || ws === 'oklab') {
            if (override && override.L !== undefined && override.C !== undefined && override.H !== undefined) {
                return {
                    space: ws,
                    L: clamp(Number(override.L), 0, 100),
                    C: clamp(Number(override.C), 0, 0.37),
                    H: (((Number(override.H) || 0) % 360) + 360) % 360
                };
            }
            const lch = rgbToOklch(rgb.r, rgb.g, rgb.b);
            return { space: ws, L: lch.L, C: clamp(lch.C, 0, 0.37), H: lch.H };
        }
        if (override && override.h !== undefined && override.s !== undefined && override.v !== undefined) {
            return {
                space: ws,
                H: (((Number(override.h) || 0) % 360) + 360) % 360,
                S: clamp(Number(override.s), 0, 100),
                V: clamp(Number(override.v), 0, 100)
            };
        }
        const wh = rgbToWheelHsv(rgb.r, rgb.g, rgb.b, ws);
        return { space: ws, H: wh.h, S: wh.s, V: wh.v };
    }

    _coordToHex(coord, space = null) {
        const ws = space || coord?.space || this.config.wheelSpace || 'ryb';
        if (ws === 'oklch' || ws === 'oklab') {
            const rgb = oklchToRgb(clamp(coord.L, 0, 100), clamp(coord.C, 0, 0.37), coord.H);
            return rgbToHex(rgb.r, rgb.g, rgb.b);
        }
        const rgb = wheelHsvToRgb(coord.H, clamp(coord.S, 0, 100), clamp(coord.V, 0, 100), ws);
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    captureGroupBaseline(idxOverride = null, coordOverride = null) {
        const ws = this.config.wheelSpace || 'ryb';
        const isOk = (ws === 'oklch' || ws === 'oklab');
        const arr = new Array(6);
        for (let i = 0; i < 6; i++) {
            const prev = (this._groupCoords && this._groupCoords.length === 6 && this._groupCoords[i]?.space === ws)
                ? this._groupCoords[i]
                : null;
            if (idxOverride === i && coordOverride) {
                arr[i] = this._extractSpaceCoord(this.baseColors[i], ws, coordOverride);
            } else if (prev) {
                // Keep preserved hue on achromatic colors if hex matches
                const fresh = this._extractSpaceCoord(this.baseColors[i], ws, null);
                if (isOk && fresh.C <= 0.004) fresh.H = prev.H;
                if (!isOk && (fresh.S <= 1 || fresh.V <= 1)) fresh.H = prev.H;
                arr[i] = fresh;
            } else {
                arr[i] = this._extractSpaceCoord(this.baseColors[i], ws, null);
            }
        }
        this._groupCoords = arr;
        return arr.map(c => ({ ...c }));
    }

    setGroupLock(enabled) {
        this.config.groupLock = !!enabled;
        this.config.autoSyncSymmetry = false;
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        } else {
            this._groupCoords = null;
        }
        this.saveConfig();
    }

    setBaseColor(index, color, { skipGroup = false, skipSave = false, coordOverride = null, dragBaseline = null } = {}) {
        const idx = clamp(Math.round(index), 0, 5);
        const hex = normalizeHex(color, '#333333');
        const ws = this.config.wheelSpace || 'ryb';

        if (this.config.groupLock && !skipGroup) {
            const baseline = (dragBaseline && dragBaseline.length === 6 && dragBaseline[0]?.space === ws)
                ? dragBaseline
                : ((this._groupCoords && this._groupCoords.length === 6 && this._groupCoords[0]?.space === ws)
                    ? this._groupCoords
                    : this.captureGroupBaseline());

            const isOk = (ws === 'oklch' || ws === 'oklab');
            const refCoord = baseline[idx] || this._extractSpaceCoord(this.baseColors[idx] || hex, ws, null);
            const nextCoord = this._extractSpaceCoord(hex, ws, coordOverride);
            if (isOk && nextCoord.C <= 0.003 && !coordOverride) nextCoord.H = refCoord.H;
            if (!isOk && (nextCoord.S <= 1 || nextCoord.V <= 1) && !coordOverride) nextCoord.H = refCoord.H;

            let dH = nextCoord.H - refCoord.H;
            if (dH > 180) dH -= 360;
            if (dH < -180) dH += 360;

            const wrapH = (deg) => ((deg % 360) + 360) % 360;
            const nextGroup = new Array(6);

            if (isOk) {
                const dL = nextCoord.L - refCoord.L;
                const dC = nextCoord.C - refCoord.C;
                this.baseColors[idx] = hex;
                nextGroup[idx] = { ...nextCoord };
                for (let i = 0; i < 6; i++) {
                    if (i === idx) continue;
                    const src = baseline[i] || this._extractSpaceCoord(this.baseColors[i], ws, null);
                    if (this.config.locks[i]) {
                        nextGroup[i] = { ...src };
                        continue;
                    }
                    const moved = {
                        space: ws,
                        H: wrapH(src.H + dH),
                        L: clamp(src.L + dL, 0, 100),
                        C: clamp(src.C + dC, 0, 0.37)
                    };
                    nextGroup[i] = moved;
                    this.baseColors[i] = this._coordToHex(moved, ws);
                }
            } else {
                const dS = nextCoord.S - refCoord.S;
                const dV = nextCoord.V - refCoord.V;
                this.baseColors[idx] = hex;
                nextGroup[idx] = { ...nextCoord };
                for (let i = 0; i < 6; i++) {
                    if (i === idx) continue;
                    const src = baseline[i] || this._extractSpaceCoord(this.baseColors[i], ws, null);
                    if (this.config.locks[i]) {
                        nextGroup[i] = { ...src };
                        continue;
                    }
                    const moved = {
                        space: ws,
                        H: wrapH(src.H + dH),
                        S: clamp(src.S + dS, 0, 100),
                        V: clamp(src.V + dV, 0, 100)
                    };
                    nextGroup[i] = moved;
                    this.baseColors[i] = this._coordToHex(moved, ws);
                }
            }
            this._groupCoords = nextGroup;
        } else {
            this.baseColors[idx] = hex;
            if (this._groupCoords && this._groupCoords.length === 6) {
                this._groupCoords[idx] = this._extractSpaceCoord(hex, ws, coordOverride);
            }
        }

        if (!skipSave) this.saveConfig();
    }

    toggleLock(index) {
        const idx = clamp(Math.round(index), 0, 5);
        this.config.locks[idx] = !this.config.locks[idx];
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        this.saveConfig();
    }

    // Generate 6 harmonious anchor colors around anchor 0 in wheelSpace
    applySymmetry(masterIdx = 0, { skipSave = false } = {}) {
        const mode = this.config.symmetry;
        if (!mode || mode === 'custom') return;

        const baseHex = this.baseColors[masterIdx] || this.baseColors[0];
        const rgb = hexToRgb(baseHex);
        const wheelSpace = this.config.wheelSpace || 'ryb';
        const baseW = rgbToWheelHsv(rgb.r, rgb.g, rgb.b, wheelSpace);
        const H = baseW.h;
        const S = Math.max(12, baseW.s);
        const V = Math.max(16, baseW.v);
        const spread = Number(this.config.spread) || 30;
        const contrast = Number(this.config.harmonyContrast) || 16;

        // Returns array of 6 { h, s, v } specs in wheelSpace
        const specs = new Array(6);
        const wrapH = (deg) => ((deg % 360) + 360) % 360;
        const clampSV = (h, s, v) => ({
            h: wrapH(h),
            s: clamp(s, 4, 100),
            v: clamp(v, 8, 100)
        });

        specs[0] = clampSV(H, S, V);

        if (mode === 'complementary') {
            specs[1] = clampSV(H, S * 0.72, V + contrast);
            specs[2] = clampSV(H, S, V - contrast * 1.1);
            specs[3] = clampSV(H + 180, S, V);
            specs[4] = clampSV(H + 180, S * 0.72, V + contrast);
            specs[5] = clampSV(H + 180, S, V - contrast * 1.1);
        } else if (mode === 'analogous') {
            const step = spread * 0.55;
            specs[1] = clampSV(H + step, S * 0.96, V + contrast * 0.35);
            specs[2] = clampSV(H + step * 2, S * 0.92, V + contrast * 0.65);
            specs[3] = clampSV(H - step, S * 0.96, V - contrast * 0.25);
            specs[4] = clampSV(H - step * 2, S * 0.92, V - contrast * 0.5);
            specs[5] = clampSV(H + step * 3, S * 0.85, V + contrast * 0.85);
        } else if (mode === 'split') {
            specs[1] = clampSV(H, S * 0.7, V + contrast);
            specs[2] = clampSV(H + 180 - spread, S, V);
            specs[3] = clampSV(H + 180 + spread, S, V);
            specs[4] = clampSV(H + 180 - spread, S * 0.75, V - contrast * 0.7);
            specs[5] = clampSV(H + 180 + spread, S * 0.75, V + contrast * 0.7);
        } else if (mode === 'triadic') {
            specs[1] = clampSV(H, S * 0.68, V + contrast);
            specs[2] = clampSV(H + 120, S, V);
            specs[3] = clampSV(H + 120, S * 0.78, V - contrast * 0.7);
            specs[4] = clampSV(H + 240, S, V);
            specs[5] = clampSV(H + 240, S * 0.78, V + contrast * 0.7);
        } else if (mode === 'tetradic') {
            specs[1] = clampSV(H + 90, S, V);
            specs[2] = clampSV(H + 180, S, V);
            specs[3] = clampSV(H + 270, S, V);
            specs[4] = clampSV(H + 90, S * 0.7, V + contrast);
            specs[5] = clampSV(H + 270, S * 0.7, V - contrast);
        } else if (mode === 'clash') {
            specs[1] = clampSV(H + 90, S, V);
            specs[2] = clampSV(H + 270, S, V);
            specs[3] = clampSV(H + 90, S * 0.72, V + contrast);
            specs[4] = clampSV(H + 270, S * 0.72, V - contrast);
            specs[5] = clampSV(H + 180, S * 0.4, V + contrast * 0.6);
        } else if (mode === 'double') {
            specs[1] = clampSV(H + spread, S, V);
            specs[2] = clampSV(H + 180, S, V);
            specs[3] = clampSV(H + 180 + spread, S, V);
            specs[4] = clampSV(H + spread * 0.5, S * 0.65, V + contrast);
            specs[5] = clampSV(H + 180 + spread * 0.5, S * 0.65, V - contrast);
        } else if (mode === 'monochrome') {
            const vSteps = [V, clamp(V + contrast * 1.4, 15, 98), clamp(V + contrast * 0.7, 15, 96), clamp(V - contrast * 0.7, 8, 92), clamp(V - contrast * 1.4, 6, 85), clamp(V - contrast * 2.1, 4, 75)];
            const sSteps = [S, clamp(S * 0.45, 5, 100), clamp(S * 0.72, 8, 100), S, clamp(S * 0.9, 10, 100), clamp(S * 0.75, 10, 100)];
            for (let i = 0; i < 6; i++) {
                specs[i] = clampSV(H, sSteps[i], vSteps[i]);
            }
        } else {
            // 'six-tone'
            const toneSpan = Math.max(15, spread * 1.8);
            for (let i = 0; i < 6; i++) {
                const offset = i * (360 / 6) * clamp(spread / 45, 0.35, 1.0);
                const wave = (i % 2 === 0 ? 1 : -1) * contrast * 0.35;
                specs[i] = clampSV(H + offset + (i > 0 ? toneSpan * 0.1 : 0), S - (i % 3) * 5, V + wave);
            }
        }

        for (let i = 0; i < 6; i++) {
            if (i === masterIdx || this.config.locks[i]) continue;
            const spec = specs[i];
            const outRgb = wheelHsvToRgb(spec.h, spec.s, spec.v, wheelSpace);
            this.baseColors[i] = rgbToHex(outRgb.r, outRgb.g, outRgb.b);
        }
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        if (!skipSave) this.saveConfig();
    }

    adjustAllAnchors({ hueDelta = 0, satDelta = 0, lightDelta = 0, tempDelta = 0 }) {
        const space = this.config.wheelSpace || 'ryb';
        for (let i = 0; i < 6; i++) {
            if (this.config.locks[i]) continue;
            let hex = this.baseColors[i];
            if (hueDelta || satDelta || lightDelta) {
                hex = shiftColorSpace(hex, hueDelta, satDelta, lightDelta, space);
            }
            if (tempDelta) {
                hex = applyPainterlyShift(hex, tempDelta, 0, 0);
            }
            this.baseColors[i] = hex;
        }
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        this.saveConfig();
    }

    adjustAngleSpread(direction = 1) {
        const dir = direction >= 0 ? 1 : -1;
        const ws = this.config.wheelSpace || 'ryb';
        const coords = this.baseColors.map(hex => this._extractSpaceCoord(hex, ws, null));
        const baseH = coords[0].H;
        const factor = dir > 0 ? 1.2 : 0.82;

        for (let i = 1; i < 6; i++) {
            if (this.config.locks[i]) continue;
            const diff = ((coords[i].H - baseH + 540) % 360) - 180;
            let nextDiff;
            if (Math.abs(diff) < 3) {
                if (dir > 0) {
                    nextDiff = (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * 10;
                } else {
                    nextDiff = diff * 0.78;
                }
            } else if (Math.abs(Math.abs(diff) - 180) <= 3) {
                if (dir > 0) {
                    nextDiff = diff + (i % 2 === 0 ? 12 : -12);
                } else {
                    nextDiff = diff > 0 ? 168 : -168;
                }
            } else {
                nextDiff = clamp(diff * factor, -176, 176);
            }
            coords[i].H = ((baseH + nextDiff) % 360 + 360) % 360;
            this.baseColors[i] = this._coordToHex(coords[i], ws);
        }

        this.config.spread = clamp((this.config.spread || 30) + dir * 6, 5, 90);
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        this.saveConfig();
    }

    adjustTonalContrast(direction = 1) {
        const dir = direction >= 0 ? 1 : -1;
        const labs = this.baseColors.map(hex => {
            const rgb = hexToRgb(hex);
            return rgbToOklch(rgb.r, rgb.g, rgb.b);
        });
        let sumL = 0;
        let minL = 100;
        let maxL = 0;
        for (let i = 0; i < 6; i++) {
            sumL += labs[i].L;
            if (labs[i].L < minL) minL = labs[i].L;
            if (labs[i].L > maxL) maxL = labs[i].L;
        }
        const avgL = sumL / 6;
        const spanL = maxL - minL;
        const factor = dir > 0 ? 1.25 : 0.76;

        for (let i = 0; i < 6; i++) {
            if (this.config.locks[i]) continue;
            const c = labs[i];
            let nextL;
            if (dir > 0 && spanL < 8) {
                const step = (i % 2 === 0 ? 1 : -1) * (5 + (i % 3) * 2);
                nextL = clamp(c.L + step, 4, 97);
            } else {
                nextL = clamp(avgL + (c.L - avgL) * factor, 4, 97);
            }
            const outRgb = oklchToRgb(nextL, c.C, c.H);
            this.baseColors[i] = rgbToHex(outRgb.r, outRgb.g, outRgb.b);
        }

        this.config.harmonyContrast = clamp((this.config.harmonyContrast || 16) + dir * 4, 0, 45);
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        this.saveConfig();
    }

    loadPreset(preset) {
        if (!preset || !Array.isArray(preset.colors) || preset.colors.length !== 6) return;
        this.baseColors = preset.colors.map(c => normalizeHex(c, '#333333'));
        if (preset.wheelSpace) this.config.wheelSpace = preset.wheelSpace;
        if (preset.mixSpace) this.config.mixSpace = preset.mixSpace;
        if (preset.symmetry) this.config.symmetry = preset.symmetry;
        if (preset.config && typeof preset.config === 'object') {
            this.applySerializedState({ baseColors: this.baseColors, config: preset.config }, { save: false });
        }
        if (this.config.groupLock) {
            this.captureGroupBaseline();
        }
        this.saveConfig();
    }

    generatePhysicalPalette() {
        const c = this.baseColors;
        const rows = [];

        // Row 1: 6 Main Anchors
        rows.push(c.map((hex, i) => ({
            color: hex,
            type: 'main',
            index: i,
            active: this.activeIndex === i,
            locked: !!this.config.locks[i]
        })));

        // Row 2: Adjacent Physical Pigment RYB Mixes (50/50)
        rows.push(c.map((hex, i) => ({
            color: mixColorsSpace(hex, c[(i + 1) % 6], 0.5, 'ryb'),
            type: 'mix'
        })));

        // Row 3: Cross / Complement Physical RYB Mixes (50/50)
        const crossPairs = [[0, 2], [1, 3], [2, 4], [0, 3], [1, 4], [2, 5]];
        rows.push(crossPairs.map(([a, b]) => ({
            color: mixColorsSpace(c[a], c[b], 0.5, 'ryb'),
            type: 'mix'
        })));

        // Row 4: Physical White Tints (Value Raise + Pigment Mix)
        rows.push(c.map(hex => ({
            color: mixColorsSpace(hex, '#FAF8F5', 0.45, 'ryb'),
            type: 'shift'
        })));

        // Row 5: Physical Dark Umber / Black Value Shades
        rows.push(c.map(hex => ({
            color: mixColorsSpace(hex, '#1C1612', 0.48, 'ryb'),
            type: 'shift'
        })));

        return rows;
    }

    generate(modeOverride = null) {
        const mode = modeOverride || this.config.paletteMode || 'digital';
        if (mode === 'physical') {
            return this.generatePhysicalPalette();
        }

        const rows = [];
        const c = this.baseColors;
        const mixSpace = this.config.mixSpace || 'ryb';
        const ws = this.config.wheelSpace || 'ryb';
        const shiftSpace = (ws === 'oklch' || ws === 'oklab' || ws === 'cmyk' || ws === 'ryb') ? ws : 'hsl';
        const activeHex = c[this.activeIndex] || c[0];

        const activeRows = (this.config.rows || []).filter(r => r.enabled);
        for (const rowDef of activeRows) {
            const hS = Number(rowDef.hShift) || 0;
            const sS = Number(rowDef.sShift) || 0;
            const lS = Number(rowDef.lShift) || 0;
            const cols = clamp(Math.round(Number(rowDef.cols) || 6), 2, 12);
            const hasShift = (hS !== 0 || sS !== 0 || lS !== 0);
            const post = (hex) => hasShift ? shiftColorSpace(hex, hS, sS, lS, shiftSpace) : hex;

            if (rowDef.type === 'main') {
                rows.push(c.map((hex, i) => ({
                    color: hex,
                    type: 'main',
                    index: i,
                    active: this.activeIndex === i,
                    locked: !!this.config.locks[i]
                })));
            } else if (rowDef.type === 'pair-mix') {
                if (cols === 3) {
                    rows.push([
                        { color: post(mixColorsSpace(c[0], c[1], 0.5, mixSpace)), type: 'mix', span: 2 },
                        { color: post(mixColorsSpace(c[2], c[3], 0.5, mixSpace)), type: 'mix', span: 2 },
                        { color: post(mixColorsSpace(c[4], c[5], 0.5, mixSpace)), type: 'mix', span: 2 }
                    ]);
                } else {
                    const out = [];
                    for (let i = 0; i < cols; i++) {
                        const a = c[i % 6];
                        const b = c[(i + 1) % 6];
                        out.push({ color: post(mixColorsSpace(a, b, 0.5, mixSpace)), type: 'mix' });
                    }
                    rows.push(out);
                }
            } else if (rowDef.type === 'bridge-tint') {
                rows.push([
                    { color: post(c[0]), type: 'shift', span: 1 },
                    { color: mixColorsSpace(c[1], c[2], 0.5, mixSpace), type: 'mix', span: 2 },
                    { color: mixColorsSpace(c[3], c[4], 0.5, mixSpace), type: 'mix', span: 2 },
                    { color: post(c[5]), type: 'shift', span: 1 }
                ]);
            } else if (rowDef.type === 'anchor-shift') {
                rows.push(c.map(hex => ({
                    color: post(hex),
                    type: 'new'
                })));
            } else if (rowDef.type === 'adj-mix') {
                const out = [];
                for (let i = 0; i < cols; i++) {
                    const a = c[i % 6];
                    const b = c[(i + 1) % 6];
                    out.push({ color: post(mixColorsSpace(a, b, 0.5, mixSpace)), type: 'mix' });
                }
                rows.push(out);
            } else if (rowDef.type === 'value-ramp') {
                const out = [];
                for (let i = 0; i < cols; i++) {
                    const t = cols > 1 ? (i / (cols - 1)) : 0.5;
                    const deltaL = -38 + t * 76 + lS;
                    out.push({
                        color: shiftColorSpace(activeHex, hS, sS * (1 - t * 0.4), deltaL, 'oklch'),
                        type: 'shift'
                    });
                }
                rows.push(out);
            } else if (rowDef.type === 'temp-ramp') {
                const out = [];
                for (let i = 0; i < cols; i++) {
                    const t = cols > 1 ? (i / (cols - 1)) : 0.5;
                    const temp = -70 + t * 140;
                    out.push({
                        color: applyPainterlyShift(activeHex, temp, sS, lS),
                        type: 'new'
                    });
                }
                rows.push(out);
            } else if (rowDef.type === 'complements') {
                rows.push(c.map(hex => ({
                    color: shiftColorSpace(hex, 180 + hS, sS, lS, shiftSpace),
                    type: 'shift'
                })));
            }
        }

        if (rows.length === 0) {
            rows.push(c.map((hex, i) => ({
                color: hex,
                type: 'main',
                index: i,
                active: this.activeIndex === i,
                locked: !!this.config.locks[i]
            })));
        }

        return rows;
    }
}

// =========================================================================
// COLOR SLIDER ENGINE (Dynamic Left-Right Gradient Sliders)
// =========================================================================
function buildSliderGradient(stopsCount, sampleFn) {
    const stops = [];
    for (let i = 0; i < stopsCount; i++) {
        const t = i / (stopsCount - 1);
        stops.push(sampleFn(t));
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function getSliderDescriptors(packId, hex, oklchOverride = null) {
    const { r, g, b } = hexToRgb(hex);

    if (packId === 'ryb') {
        const ryb = rgbToRyb(r, g, b);
        const setR = (v) => rgbToHex(...Object.values(rybToRgb(v, ryb.y, ryb.b)));
        const setY = (v) => rgbToHex(...Object.values(rybToRgb(ryb.r, v, ryb.b)));
        const setB = (v) => rgbToHex(...Object.values(rybToRgb(ryb.r, ryb.y, v)));
        return [
            {
                key: 'ryb-r', label: 'RYB · R', min: 0, max: 100, step: 0.5, value: ryb.r,
                display: `${Math.round(ryb.r)}%`,
                grad: buildSliderGradient(7, t => setR(t * 100)),
                apply: v => setR(v)
            },
            {
                key: 'ryb-y', label: 'RYB · Y', min: 0, max: 100, step: 0.5, value: ryb.y,
                display: `${Math.round(ryb.y)}%`,
                grad: buildSliderGradient(7, t => setY(t * 100)),
                apply: v => setY(v)
            },
            {
                key: 'ryb-b', label: 'RYB · B', min: 0, max: 100, step: 0.5, value: ryb.b,
                display: `${Math.round(ryb.b)}%`,
                grad: buildSliderGradient(7, t => setB(t * 100)),
                apply: v => setB(v)
            }
        ];
    }

    if (packId === 'painterly') {
        const lch = rgbToOklch(r, g, b);
        const warmModel = getPainterlyWarmCoolModel(hex);
        const maxC = Math.max(0.015, getMaxOklchChroma(lch.L, lch.H));
        const chromaPct = clamp((lch.C / maxC) * 100, 0, 100);
        const tempDisplay = Math.round(warmModel.value);
        return [
            {
                key: 'paint-temp', label: 'WARM ↔ COOL', min: -100, max: 100, step: 1, value: warmModel.value,
                display: tempDisplay > 0 ? `+${tempDisplay}W` : `${tempDisplay}C`,
                grad: buildSliderGradient(9, t => warmModel.sample(-100 + t * 200)),
                apply: v => warmModel.sample(v)
            },
            {
                key: 'paint-tone', label: 'TONE (SHADE↔TINT)', min: 0, max: 100, step: 0.5, value: lch.L,
                display: `${Math.round(lch.L)}%`,
                grad: buildSliderGradient(7, t => rgbToHex(...Object.values(oklchToRgb(t * 100, lch.C, lch.H)))),
                apply: v => rgbToHex(...Object.values(oklchToRgb(v, lch.C, lch.H)))
            },
            {
                key: 'paint-chroma', label: 'CHROMA (MUD↔PURE)', min: 0, max: 100, step: 0.5, value: chromaPct,
                display: `${Math.round(chromaPct)}%`,
                grad: buildSliderGradient(7, t => rgbToHex(...Object.values(oklchToRgb(lch.L, t * maxC, lch.H)))),
                apply: v => rgbToHex(...Object.values(oklchToRgb(lch.L, clamp(v / 100, 0, 1) * maxC, lch.H)))
            }
        ];
    }

    if (packId === 'oklch') {
        const rawLch = rgbToOklch(r, g, b);
        const lch = oklchOverride
            ? {
                L: clamp(Number(oklchOverride.L), 0, 100),
                C: clamp(Number(oklchOverride.C), 0, 0.37),
                H: (((Number(oklchOverride.H) || 0) % 360) + 360) % 360
            }
            : rawLch;
        const MAX_OKLCH_C = 0.37;
        const setL = (v) => rgbToHex(...Object.values(oklchToRgb(v, lch.C, lch.H)));
        const setC = (v) => rgbToHex(...Object.values(oklchToRgb(lch.L, v, lch.H)));
        const setH = (v) => rgbToHex(...Object.values(oklchToRgb(lch.L, Math.max(0.06, lch.C), v)));
        return [
            {
                key: 'oklch-l', label: 'OKLCH · L', min: 0, max: 100, step: 0.5, value: lch.L,
                display: `${Math.round(lch.L)}%`,
                grad: buildSliderGradient(9, t => setL(t * 100)),
                apply: v => setL(v)
            },
            {
                key: 'oklch-c', label: 'OKLCH · C', min: 0, max: MAX_OKLCH_C, step: 0.002, value: clamp(lch.C, 0, MAX_OKLCH_C),
                display: lch.C.toFixed(2),
                grad: buildSliderGradient(9, t => setC(t * MAX_OKLCH_C)),
                apply: v => setC(v)
            },
            {
                key: 'oklch-h', label: 'OKLCH · H', min: 0, max: 360, step: 1, value: lch.H,
                display: `${Math.round(lch.H)}°`,
                grad: buildSliderGradient(13, t => setH(t * 360)),
                apply: v => rgbToHex(...Object.values(oklchToRgb(lch.L, lch.C, v)))
            }
        ];
    }

    if (packId === 'oklab') {
        const lab = rgbToOklab(r, g, b);
        const setL = (v) => rgbToHex(...Object.values(oklabToRgb(v, lab.a, lab.b, true)));
        const setA = (v) => rgbToHex(...Object.values(oklabToRgb(lab.L, v, lab.b, true)));
        const setB = (v) => rgbToHex(...Object.values(oklabToRgb(lab.L, lab.a, v, true)));
        return [
            {
                key: 'oklab-l', label: 'OKLAB · L', min: 0, max: 100, step: 0.5, value: lab.L,
                display: `${Math.round(lab.L)}%`,
                grad: buildSliderGradient(7, t => setL(t * 100)),
                apply: v => setL(v)
            },
            {
                key: 'oklab-a', label: 'OKLAB · A (G↔R)', min: -0.32, max: 0.32, step: 0.005, value: lab.a,
                display: lab.a.toFixed(2),
                grad: buildSliderGradient(7, t => setA(-0.32 + t * 0.64)),
                apply: v => setA(v)
            },
            {
                key: 'oklab-b', label: 'OKLAB · B (B↔Y)', min: -0.32, max: 0.32, step: 0.005, value: lab.b,
                display: lab.b.toFixed(2),
                grad: buildSliderGradient(7, t => setB(-0.32 + t * 0.64)),
                apply: v => setB(v)
            }
        ];
    }

    if (packId === 'cmyk') {
        const cmyk = rgbToCmyk(r, g, b);
        const setC = (v) => rgbToHex(...Object.values(cmykToRgb(v, cmyk.m, cmyk.y, cmyk.k)));
        const setM = (v) => rgbToHex(...Object.values(cmykToRgb(cmyk.c, v, cmyk.y, cmyk.k)));
        const setY = (v) => rgbToHex(...Object.values(cmykToRgb(cmyk.c, cmyk.m, v, cmyk.k)));
        const setK = (v) => rgbToHex(...Object.values(cmykToRgb(cmyk.c, cmyk.m, cmyk.y, v)));
        return [
            {
                key: 'cmyk-c', label: 'CMYK · C', min: 0, max: 100, step: 1, value: cmyk.c,
                display: `${Math.round(cmyk.c)}%`,
                grad: buildSliderGradient(6, t => setC(t * 100)),
                apply: v => setC(v)
            },
            {
                key: 'cmyk-m', label: 'CMYK · M', min: 0, max: 100, step: 1, value: cmyk.m,
                display: `${Math.round(cmyk.m)}%`,
                grad: buildSliderGradient(6, t => setM(t * 100)),
                apply: v => setM(v)
            },
            {
                key: 'cmyk-y', label: 'CMYK · Y', min: 0, max: 100, step: 1, value: cmyk.y,
                display: `${Math.round(cmyk.y)}%`,
                grad: buildSliderGradient(6, t => setY(t * 100)),
                apply: v => setY(v)
            },
            {
                key: 'cmyk-k', label: 'CMYK · K', min: 0, max: 100, step: 1, value: cmyk.k,
                display: `${Math.round(cmyk.k)}%`,
                grad: buildSliderGradient(6, t => setK(t * 100)),
                apply: v => setK(v)
            }
        ];
    }

    if (packId === 'hsv') {
        const hsv = rgbToHsv(r, g, b);
        const setH = (v) => rgbToHex(...Object.values(hsvToRgb(v, hsv.s, hsv.v)));
        const setS = (v) => rgbToHex(...Object.values(hsvToRgb(hsv.h, v, hsv.v)));
        const setV = (v) => rgbToHex(...Object.values(hsvToRgb(hsv.h, hsv.s, v)));
        return [
            {
                key: 'hsv-h', label: 'HSV · H', min: 0, max: 360, step: 1, value: hsv.h,
                display: `${Math.round(hsv.h)}°`,
                grad: buildSliderGradient(13, t => rgbToHex(...Object.values(hsvToRgb(t * 360, 100, 100)))),
                apply: v => setH(v)
            },
            {
                key: 'hsv-s', label: 'HSV · S', min: 0, max: 100, step: 0.5, value: hsv.s,
                display: `${Math.round(hsv.s)}%`,
                grad: buildSliderGradient(6, t => setS(t * 100)),
                apply: v => setS(v)
            },
            {
                key: 'hsv-v', label: 'HSV · V', min: 0, max: 100, step: 0.5, value: hsv.v,
                display: `${Math.round(hsv.v)}%`,
                grad: buildSliderGradient(6, t => setV(t * 100)),
                apply: v => setV(v)
            }
        ];
    }

    if (packId === 'hsl') {
        const hsl = rgbToHsl(r, g, b);
        const setH = (v) => rgbToHex(...Object.values(hslToRgb(v, hsl.s, hsl.l)));
        const setS = (v) => rgbToHex(...Object.values(hslToRgb(hsl.h, v, hsl.l)));
        const setL = (v) => rgbToHex(...Object.values(hslToRgb(hsl.h, hsl.s, v)));
        return [
            {
                key: 'hsl-h', label: 'HSL · H', min: 0, max: 360, step: 1, value: hsl.h,
                display: `${Math.round(hsl.h)}°`,
                grad: buildSliderGradient(13, t => rgbToHex(...Object.values(hslToRgb(t * 360, 90, 50)))),
                apply: v => setH(v)
            },
            {
                key: 'hsl-s', label: 'HSL · S', min: 0, max: 100, step: 0.5, value: hsl.s,
                display: `${Math.round(hsl.s)}%`,
                grad: buildSliderGradient(6, t => setS(t * 100)),
                apply: v => setS(v)
            },
            {
                key: 'hsl-l', label: 'HSL · L', min: 0, max: 100, step: 0.5, value: hsl.l,
                display: `${Math.round(hsl.l)}%`,
                grad: buildSliderGradient(7, t => setL(t * 100)),
                apply: v => setL(v)
            }
        ];
    }

    // 'rgb'
    return [
        {
            key: 'rgb-r', label: 'RGB · R', min: 0, max: 255, step: 1, value: r,
            display: `${Math.round(r)}`,
            grad: buildSliderGradient(5, t => rgbToHex(t * 255, g, b)),
            apply: v => rgbToHex(v, g, b)
        },
        {
            key: 'rgb-g', label: 'RGB · G', min: 0, max: 255, step: 1, value: g,
            display: `${Math.round(g)}`,
            grad: buildSliderGradient(5, t => rgbToHex(r, t * 255, b)),
            apply: v => rgbToHex(r, v, b)
        },
        {
            key: 'rgb-b', label: 'RGB · B', min: 0, max: 255, step: 1, value: b,
            display: `${Math.round(b)}`,
            grad: buildSliderGradient(5, t => rgbToHex(r, g, t * 255)),
            apply: v => rgbToHex(r, g, v)
        }
    ];
}

// =========================================================================
// GEOMETRIC PICKER RENDERER (Ring+Triangle / Ring+Square / Wheel)
// =========================================================================
function clampBarycentricToSimplex(u, v, w) {
    // Standard projection onto triangle (u >= 0, v >= 0, w >= 0, u+v+w = 1)
    if (u >= 0 && v >= 0 && w >= 0) return [u, v, w];
    const clamp01 = (x) => clamp(x, 0, 1);
    if (u < 0 && v >= 0 && w >= 0) {
        const s = v + w || 1;
        return [0, clamp01(v / s), clamp01(w / s)];
    }
    if (v < 0 && u >= 0 && w >= 0) {
        const s = u + w || 1;
        return [clamp01(u / s), 0, clamp01(w / s)];
    }
    if (w < 0 && u >= 0 && v >= 0) {
        const s = u + v || 1;
        return [clamp01(u / s), clamp01(v / s), 0];
    }
    if (u >= v && u >= w) return [1, 0, 0];
    if (v >= u && v >= w) return [0, 1, 0];
    return [0, 0, 1];
}

export class PaletteStudio {
    constructor(app) {
        this.app = app;
        this.activeTab = 'space';
        this._ringBitmapCache = new Map();
        this._wheelBitmapCache = new Map();
        this._oklch2dRaster = null;
        this._oklch2dRasterKey = '';
        this._oklch2dMaxC = null;
        this._oklchTarget = null;
        this._ringAngleState = null;
        this._dockDragMode = null; // 'ring' | 'tri' | 'sq' | 'wheel'
        this._studioWheelDragIdx = -1;
        this._studioWheelDragStartL = null;
        this._studioWheelDragStartV = null;
        this._dragGroupBaseline = null;
        this._liveDragRafId = null;
        this._pendingDeferredSave = false;
        this._sliderLock = false;
        this._activeSliderDrag = null;
        this._initialized = false;
        this._resetArmed = false;
        this._resetArmTimer = null;
    }

    init() {
        if (this._initialized) return;
        this._initialized = true;

        this._bindHeaderTrigger();
        this._bindDockedPickers();
        this._bindStudioUI();
        this.applyDockedPanelLayout();
        this.syncColorUI(this.app.engine?.brush?.color || this.app.palette.baseColors[0]);
    }

    _getDpr() {
        return Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    }

    _beginDragGroupBaseline() {
        const p = this.app.palette;
        if (p.config.groupLock) {
            this._dragGroupBaseline = p.captureGroupBaseline();
        } else {
            this._dragGroupBaseline = null;
        }
        return this._dragGroupBaseline;
    }

    _flushDeferredSave() {
        this._dragGroupBaseline = null;
        if (!this._pendingDeferredSave) return;
        this._pendingDeferredSave = false;
        this.app.palette.saveConfig();
        this.app.palette.saveProjectPalette(this.app.currentProjectId);
        this.app.storage?.saveSetting('lastColor', this.getActiveHex());
    }

    _scheduleDragUISync() {
        if (this._liveDragRafId) return;
        this._liveDragRafId = requestAnimationFrame(() => {
            this._liveDragRafId = null;
            this.app._renderPalette();
            const clean = this.getActiveHex();
            this._updateSliderContainerValues(document.getElementById('palette-live-sliders'), clean);
            if (this.isOpen()) {
                this._updateSliderContainerValues(document.getElementById('studio-quick-sliders'), clean);
                this._updateSliderContainerValues(document.getElementById('studio-live-sliders'), clean);
                if (this._studioWheelDragIdx < 0) {
                    this._drawStudioHarmonyWheel();
                }
                this._syncStudioAnchorCards();
                this._renderMixProofBar();
                this._renderPalettePreview();
            }
        });
    }

    _ensureOklchTarget(hex, { force = false } = {}) {
        const clean = normalizeHex(hex, this.getActiveHex());
        if (!force && this._oklchTarget && this._oklchTarget.hex === clean) {
            return this._oklchTarget;
        }
        const { r, g, b } = hexToRgb(clean);
        const lch = rgbToOklch(r, g, b);
        const prevH = this._oklchTarget ? this._oklchTarget.H : 29.2;
        this._oklchTarget = {
            L: lch.L,
            C: clamp(lch.C, 0, 0.37),
            H: lch.C > 0.0025 ? lch.H : prevH,
            hex: clean
        };
        return this._oklchTarget;
    }

    _commitOklchTarget(L, C, H, { updateBase = true, deferSave = false, dragBaseline = null } = {}) {
        const nL = clamp(Number(L), 0, 100);
        const nC = clamp(Number(C), 0, 0.37);
        const nH = (((Number(H) || 0) % 360) + 360) % 360;
        const rgb = oklchToRgb(nL, nC, nH);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        this._oklchTarget = { L: nL, C: nC, H: nH, hex };
        this.commitPickedHex(hex, {
            updateBase,
            deferSave,
            coordOverride: { L: nL, C: nC, H: nH },
            dragBaseline
        });
    }

    _getWheelAngle() {
        const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
        const clean = this.getActiveHex();
        if (this._ringAngleState && this._ringAngleState.hex === clean && this._ringAngleState.wheelSpace === wheelSpace) {
            return this._ringAngleState.angle;
        }
        const rgbHue = this.app.hsv?.h ?? 0;
        if (wheelSpace === 'ryb') return rgbHueToRybHue(rgbHue);
        if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
            const target = this._ensureOklchTarget(clean);
            return target.C > 0.004 ? target.H : hsvHueToOklchHue(rgbHue);
        }
        return rgbHue;
    }

    getActiveHex() {
        return this.app.engine?.brush?.color || this.app.palette.baseColors[this.app.palette.activeIndex] || '#000000';
    }

    // Apply picker value directly to active color + active main anchor
    commitPickedHex(hex, { updateBase = true, deferSave = false, coordOverride = null, dragBaseline = null } = {}) {
        const clean = normalizeHex(hex, '#000000');
        const palette = this.app.palette;
        if (updateBase) {
            palette.setBaseColor(palette.activeIndex, clean, {
                skipSave: deferSave,
                coordOverride,
                dragBaseline: dragBaseline || this._dragGroupBaseline
            });
        }
        if (deferSave) {
            this._pendingDeferredSave = true;
        }
        this.app.setColor(clean, { skipSave: deferSave, deferUi: deferSave });
        if (updateBase) {
            if (deferSave) {
                this._scheduleDragUISync();
            } else {
                this.app._renderPalette();
                this.app.palette.saveProjectPalette(this.app.currentProjectId);
                if (this.isOpen()) {
                    this.renderStudioDynamicSections({ includeHeavy: false });
                }
            }
        } else if (!deferSave && this.isOpen()) {
            this.renderStudioDynamicSections({ includeHeavy: false });
        }
    }

    commitWheelHsv(wheelHueDeg, sPct, vPct, { updateBase = true, deferSave = false, dragBaseline = null } = {}) {
        const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
        const normAngle = ((wheelHueDeg % 360) + 360) % 360;
        const rgb = wheelHsvToRgb(normAngle, sPct, vPct, wheelSpace);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        // Preserve wheel hue even when saturation/value hits 0 so triangle/ring doesn't jump to 0 deg
        const preservedRgbHue = wheelSpace === 'ryb'
            ? rybHueToRgbHue(normAngle)
            : ((wheelSpace === 'oklch' || wheelSpace === 'oklab') ? oklchHueToHsvHue(normAngle) : normAngle);

        this._ringAngleState = { wheelSpace, angle: normAngle, hex };
        this.app.hsv = {
            h: ((preservedRgbHue % 360) + 360) % 360,
            s: clamp(sPct, 0, 100),
            v: clamp(vPct, 0, 100)
        };
        if (updateBase) {
            this.app.palette.setBaseColor(this.app.palette.activeIndex, hex, {
                skipSave: deferSave,
                coordOverride: { h: normAngle, s: sPct, v: vPct },
                dragBaseline: dragBaseline || this._dragGroupBaseline
            });
        }
        if (deferSave) {
            this._pendingDeferredSave = true;
            this.app.setColor(hex, { skipSave: true, preserveHsv: true, deferUi: true });
            if (updateBase) this._scheduleDragUISync();
            return;
        }
        this.app.setColor(hex, { skipSave: false, preserveHsv: true, deferUi: false });
        if (updateBase) {
            this.app._renderPalette();
            this.app.palette.saveProjectPalette(this.app.currentProjectId);
        }
        if (this.isOpen()) {
            this.renderStudioDynamicSections({ includeHeavy: false });
        }
    }

    // ==================== HEADER SQUARE TRIGGER & MODAL ====================
    _bindHeaderTrigger() {
        const previewSquare = document.getElementById('current-color-preview');
        const btnOpenStudio = document.getElementById('btn-open-color-studio');
        const btnCloseStudio = document.getElementById('btn-close-color-studio');
        const modal = document.getElementById('modal-color-studio');
        const handle = document.getElementById('handle-color-studio');

        if (modal && handle) {
            this.app._makeDraggable(modal, handle);
        }

        const openToggle = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            this.toggleModal();
        };

        if (previewSquare) {
            previewSquare.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
            });
            previewSquare.addEventListener('click', openToggle);
        }
        if (btnOpenStudio) {
            btnOpenStudio.addEventListener('click', openToggle);
        }
        if (btnCloseStudio) {
            btnCloseStudio.addEventListener('click', () => this.closeModal());
        }
    }

    isOpen() {
        const modal = document.getElementById('modal-color-studio');
        return Boolean(modal && !modal.classList.contains('hidden'));
    }

    openModal() {
        const modal = document.getElementById('modal-color-studio');
        if (!modal) return;
        modal.classList.remove('hidden');
        this.renderStudioControls();
        this.renderStudioDynamicSections({ includeHeavy: true });
    }

    closeModal() {
        this._disarmResetBtn();
        const modal = document.getElementById('modal-color-studio');
        if (!modal) return;
        modal.classList.add('hidden');
    }

    _disarmResetBtn() {
        if (this._resetArmTimer) {
            clearTimeout(this._resetArmTimer);
            this._resetArmTimer = null;
        }
        this._resetArmed = false;
        const btn = document.getElementById('btn-cs-reset-defaults');
        if (btn) {
            btn.classList.remove('cs-danger-armed');
            btn.textContent = 'RESET COLOR STUDIO TO DEFAULTS';
        }
    }

    toggleModal() {
        if (this.isOpen()) this.closeModal();
        else this.openModal();
    }

    // ==================== DOCKED PANEL PICKERS & LAYOUT ====================
    applyDockedPanelLayout() {
        const cfg = this.app.palette.config;
        const panelColor = document.getElementById('panel-color');
        const pickerSquareBox = document.getElementById('color-picker-square-wrap');
        const svClassicWrap = document.getElementById('sv-classic-wrap');
        const oklchPickerWrap = document.getElementById('oklch-picker-wrap');
        const oklch2dCanvas = document.getElementById('oklch-2d-canvas');
        const pickerGeoBox = document.getElementById('color-picker-geo-wrap');
        const geoCanvas = document.getElementById('color-geo-canvas');
        const wheelValWrap = document.getElementById('color-wheel-val-wrap');
        const hexRow = document.getElementById('palette-hex-row');
        const paletteGrid = document.getElementById('palette');
        const colorSelector = document.getElementById('color-selector');

        const w = clamp(Number(cfg.panelWidth) || 204, 176, 360);
        if (panelColor) {
            panelColor.style.width = `${w}px`;
            const texDrawer = document.getElementById('texture-settings');
            if (texDrawer) texDrawer.style.width = `${w}px`;
        }

        const shape = cfg.pickerShape || 'sv-square';
        const ws = cfg.wheelSpace || 'ryb';
        const isOk2d = (ws === 'oklch' || ws === 'oklab');
        const isGeo = (shape === 'ring-triangle' || shape === 'ring-square' || shape === 'wheel');
        const dpr = this._getDpr();
        const innerCssW = Math.max(168, w - 28);

        if (colorSelector) {
            colorSelector.classList.toggle('hidden', shape === 'none');
            colorSelector.classList.toggle('geo-dark', isGeo || (shape === 'sv-square' && isOk2d));
        }
        if (pickerSquareBox) {
            pickerSquareBox.classList.toggle('hidden', shape !== 'sv-square');
        }
        if (svClassicWrap) {
            svClassicWrap.classList.toggle('hidden', isOk2d);
        }
        if (oklchPickerWrap) {
            oklchPickerWrap.classList.toggle('hidden', !isOk2d);
        }
        if (oklch2dCanvas) {
            const bw = Math.round(innerCssW * dpr);
            const bh = Math.round(innerCssW * (5 / 6) * dpr);
            if (oklch2dCanvas.width !== bw || oklch2dCanvas.height !== bh) {
                oklch2dCanvas.width = bw;
                oklch2dCanvas.height = bh;
            }
        }
        if (pickerGeoBox) {
            pickerGeoBox.classList.toggle('hidden', !isGeo);
        }
        if (wheelValWrap) {
            wheelValWrap.classList.toggle('hidden', shape !== 'wheel');
        }
        if (geoCanvas) {
            const size = Math.round(innerCssW * dpr);
            if (geoCanvas.width !== size || geoCanvas.height !== size) {
                geoCanvas.width = size;
                geoCanvas.height = size;
            }
        }

        if (hexRow) {
            hexRow.classList.toggle('hidden', !cfg.showHex);
        }
        if (paletteGrid) {
            paletteGrid.classList.toggle('hidden', !cfg.showSwatches);
            paletteGrid.style.gap = `${clamp(Number(cfg.swatchGap) || 2, 0, 8)}px`;
        }

        this.renderDockedSliders();
        this.app.clampPanelsToView?.();
    }

    _bindDockedPickers() {
        const svPicker = document.getElementById('sv-picker');
        const hueSlider = document.getElementById('hue-slider');
        const oklch2d = document.getElementById('oklch-2d-canvas');
        const oklch1d = document.getElementById('oklch-1d-track');
        const geoCanvas = document.getElementById('color-geo-canvas');
        const wheelValSlider = document.getElementById('color-wheel-val-slider');
        const hexInput = document.getElementById('palette-hex-input');

        if (svPicker) {
            const updateFromSV = (e, deferSave = true) => {
                const rect = svPicker.getBoundingClientRect();
                const x = clamp(e.clientX - rect.left, 0, rect.width || 1);
                const y = clamp(e.clientY - rect.top, 0, rect.height || 1);
                const s = (x / (rect.width || 1)) * 100;
                const v = 100 - (y / (rect.height || 1)) * 100;
                const wheelAngle = this._getWheelAngle();
                this.commitWheelHsv(wheelAngle, s, v, { deferSave, dragBaseline: this._dragGroupBaseline });
            };
            svPicker.onpointerdown = (e) => {
                this._beginDragGroupBaseline();
                try { svPicker.setPointerCapture(e.pointerId); } catch (_) {}
                updateFromSV(e, true);
                const onMove = (pe) => updateFromSV(pe, true);
                const onUp = (pe) => {
                    svPicker.removeEventListener('pointermove', onMove);
                    svPicker.removeEventListener('pointerup', onUp);
                    svPicker.removeEventListener('pointercancel', onUp);
                    svPicker.removeEventListener('lostpointercapture', onUp);
                    try { if (pe?.pointerId !== undefined) svPicker.releasePointerCapture(pe.pointerId); } catch (_) {}
                    this._flushDeferredSave();
                };
                svPicker.addEventListener('pointermove', onMove);
                svPicker.addEventListener('pointerup', onUp);
                svPicker.addEventListener('pointercancel', onUp);
                svPicker.addEventListener('lostpointercapture', onUp);
            };
        }

        if (hueSlider) {
            hueSlider.onpointerdown = () => this._beginDragGroupBaseline();
            hueSlider.oninput = (e) => {
                const angle = parseFloat(e.target.value) || 0;
                this.commitWheelHsv(angle, this.app.hsv.s, this.app.hsv.v, {
                    deferSave: true,
                    dragBaseline: this._dragGroupBaseline
                });
            };
            hueSlider.onchange = () => this._flushDeferredSave();
        }

        if (oklch2d) {
            const updateFromOklch2D = (e, deferSave = true) => {
                const rect = oklch2d.getBoundingClientRect();
                const rx = clamp((e.clientX - rect.left) / (rect.width || 1), 0, 1);
                const ry = clamp((e.clientY - rect.top) / (rect.height || 1), 0, 1);
                const target = this._ensureOklchTarget(this.getActiveHex());
                const ws = this.app.palette.config.wheelSpace || 'ryb';
                if (ws === 'oklab') {
                    const MAX_AB = 0.34;
                    const a = (rx * 2 - 1) * MAX_AB;
                    const b = (1 - ry * 2) * MAX_AB;
                    const C = clamp(Math.hypot(a, b), 0, 0.37);
                    let H = Math.atan2(b, a) * (180 / Math.PI);
                    if (H < 0) H += 360;
                    this._commitOklchTarget(target.L, C, C > 1e-4 ? H : target.H, {
                        deferSave,
                        dragBaseline: this._dragGroupBaseline
                    });
                } else {
                    const H = rx * 360;
                    const C = (1 - ry) * 0.37;
                    this._commitOklchTarget(target.L, C, H, { deferSave, dragBaseline: this._dragGroupBaseline });
                }
            };
            oklch2d.onpointerdown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._beginDragGroupBaseline();
                try { oklch2d.setPointerCapture(e.pointerId); } catch (_) {}
                updateFromOklch2D(e, true);
                const onMove = (pe) => updateFromOklch2D(pe, true);
                const onUp = (pe) => {
                    oklch2d.removeEventListener('pointermove', onMove);
                    oklch2d.removeEventListener('pointerup', onUp);
                    oklch2d.removeEventListener('pointercancel', onUp);
                    oklch2d.removeEventListener('lostpointercapture', onUp);
                    try { if (pe?.pointerId !== undefined) oklch2d.releasePointerCapture(pe.pointerId); } catch (_) {}
                    this._flushDeferredSave();
                };
                oklch2d.addEventListener('pointermove', onMove);
                oklch2d.addEventListener('pointerup', onUp);
                oklch2d.addEventListener('pointercancel', onUp);
                oklch2d.addEventListener('lostpointercapture', onUp);
            };
        }

        if (oklch1d) {
            const updateFromOklch1D = (e, deferSave = true) => {
                const rect = oklch1d.getBoundingClientRect();
                const ratio = clamp((e.clientX - rect.left) / (rect.width || 1), 0, 1);
                const L = ratio * 100;
                const target = this._ensureOklchTarget(this.getActiveHex());
                this._commitOklchTarget(L, target.C, target.H, { deferSave, dragBaseline: this._dragGroupBaseline });
            };
            oklch1d.onpointerdown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._beginDragGroupBaseline();
                try { oklch1d.setPointerCapture(e.pointerId); } catch (_) {}
                updateFromOklch1D(e, true);
                const onMove = (pe) => updateFromOklch1D(pe, true);
                const onUp = (pe) => {
                    oklch1d.removeEventListener('pointermove', onMove);
                    oklch1d.removeEventListener('pointerup', onUp);
                    oklch1d.removeEventListener('pointercancel', onUp);
                    oklch1d.removeEventListener('lostpointercapture', onUp);
                    try { if (pe?.pointerId !== undefined) oklch1d.releasePointerCapture(pe.pointerId); } catch (_) {}
                    this._flushDeferredSave();
                };
                oklch1d.addEventListener('pointermove', onMove);
                oklch1d.addEventListener('pointerup', onUp);
                oklch1d.addEventListener('pointercancel', onUp);
                oklch1d.addEventListener('lostpointercapture', onUp);
            };
        }

        if (wheelValSlider) {
            wheelValSlider.onpointerdown = () => this._beginDragGroupBaseline();
            wheelValSlider.oninput = (e) => {
                const val = parseFloat(e.target.value);
                const safeVal = Number.isFinite(val) ? val : 100;
                const ws = this.app.palette.config.wheelSpace || 'ryb';
                if (ws === 'oklch' || ws === 'oklab') {
                    const target = this._ensureOklchTarget(this.getActiveHex());
                    this._commitOklchTarget(safeVal, target.C, target.H, {
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                    return;
                }
                const angle = this._getWheelAngle();
                this.commitWheelHsv(angle, this.app.hsv.s, safeVal, {
                    deferSave: true,
                    dragBaseline: this._dragGroupBaseline
                });
            };
            wheelValSlider.onchange = () => this._flushDeferredSave();
        }

        if (geoCanvas) {
            const handleGeoPointer = (e, isStart) => {
                const rect = geoCanvas.getBoundingClientRect();
                const nx = ((e.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
                const ny = ((e.clientY - rect.top) / (rect.height || 1)) * 2 - 1;
                const shape = this.app.palette.config.pickerShape;
                const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
                const outerR = 0.94;
                const innerR = 0.72;
                const dist = Math.hypot(nx, ny);

                if (shape === 'wheel') {
                    if (isStart) this._dockDragMode = 'wheel';
                    let deg = Math.atan2(ny, nx) * (180 / Math.PI);
                    if (deg < 0) deg += 360;
                    const sat01 = clamp(dist / outerR, 0, 1);
                    if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
                        const target = this._ensureOklchTarget(this.getActiveHex());
                        this._commitOklchTarget(target.L, sat01 * 0.34, deg, {
                            deferSave: true,
                            dragBaseline: this._dragGroupBaseline
                        });
                    } else {
                        this.commitWheelHsv(deg, sat01 * 100, this.app.hsv?.v ?? 100, {
                            deferSave: true,
                            dragBaseline: this._dragGroupBaseline
                        });
                    }
                    return;
                }

                if (isStart) {
                    this._dockDragMode = (dist >= innerR - 0.04) ? 'ring' : (shape === 'ring-triangle' ? 'tri' : 'sq');
                }

                if (this._dockDragMode === 'ring') {
                    let deg = Math.atan2(ny, nx) * (180 / Math.PI);
                    if (deg < 0) deg += 360;
                    this.commitWheelHsv(deg, this.app.hsv.s, this.app.hsv.v, {
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                } else if (this._dockDragMode === 'sq') {
                    const halfSide = (innerR - 0.07) * Math.SQRT1_2;
                    const s = clamp(((nx + halfSide) / (2 * halfSide)) * 100, 0, 100);
                    const v = clamp((1 - (ny + halfSide) / (2 * halfSide)) * 100, 0, 100);
                    this.commitWheelHsv(this._getWheelAngle(), s, v, {
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                } else if (this._dockDragMode === 'tri') {
                    // Stationary triangle (Pure Hue right, White top-left, Black bottom-left)
                    const wheelAngle = this._getWheelAngle();
                    const rTri = innerR - 0.05;
                    const cos60 = 0.5;
                    const sin60 = 0.8660254037844386;
                    const ax = rTri, ay = 0;
                    const bx = -cos60 * rTri, by = -sin60 * rTri;
                    const cx = -cos60 * rTri, cy = sin60 * rTri;

                    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
                    if (Math.abs(det) < 1e-6) return;
                    const rawA = ((by - cy) * (nx - cx) + (cx - bx) * (ny - cy)) / det;
                    const rawB = ((cy - ay) * (nx - cx) + (ax - cx) * (ny - cy)) / det;
                    const rawC = 1 - rawA - rawB;
                    const [u, vW] = clampBarycentricToSimplex(rawA, rawB, rawC);
                    const V = clamp((u + vW) * 100, 0, 100);
                    const S = (u + vW) > 1e-4 ? clamp((u / (u + vW)) * 100, 0, 100) : 0;
                    this.commitWheelHsv(wheelAngle, S, V, {
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                }
            };

            geoCanvas.onpointerdown = (e) => {
                e.stopPropagation();
                this._beginDragGroupBaseline();
                try { geoCanvas.setPointerCapture(e.pointerId); } catch (_) {}
                handleGeoPointer(e, true);
                const onMove = (pe) => handleGeoPointer(pe, false);
                const onUp = (pe) => {
                    this._dockDragMode = null;
                    geoCanvas.removeEventListener('pointermove', onMove);
                    geoCanvas.removeEventListener('pointerup', onUp);
                    geoCanvas.removeEventListener('pointercancel', onUp);
                    geoCanvas.removeEventListener('lostpointercapture', onUp);
                    try { if (pe?.pointerId !== undefined) geoCanvas.releasePointerCapture(pe.pointerId); } catch (_) {}
                    this._flushDeferredSave();
                };
                geoCanvas.addEventListener('pointermove', onMove);
                geoCanvas.addEventListener('pointerup', onUp);
                geoCanvas.addEventListener('pointercancel', onUp);
                geoCanvas.addEventListener('lostpointercapture', onUp);
            };
        }

        if (hexInput) {
            hexInput.addEventListener('change', (e) => {
                const raw = e.target.value.trim();
                const candidate = raw.startsWith('#') ? raw : `#${raw}`;
                if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(candidate)) {
                    this.commitPickedHex(candidate);
                } else {
                    e.target.value = this.getActiveHex();
                }
            });
            hexInput.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    hexInput.blur();
                }
            });
        }
    }

    syncColorUI(hex, { preserveHsv = false, deferUi = false } = {}) {
        const clean = normalizeHex(hex, this.getActiveHex());
        const oklchTarget = this._ensureOklchTarget(clean);

        if (!preserveHsv) {
            const rgb = hexToRgb(clean);
            this.app.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        }

        const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
        const wheelAngle = this._getWheelAngle();
        const shape = this.app.palette.config.pickerShape || 'sv-square';

        if (shape === 'sv-square') {
            if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
                this._drawOklch2DSurface(oklchTarget, clean, wheelSpace);
                const oklch1dTrack = document.getElementById('oklch-1d-track');
                const oklch1dThumb = document.getElementById('oklch-1d-thumb');
                if (oklch1dTrack) {
                    oklch1dTrack.style.background = buildSliderGradient(9, t => {
                        const r = oklchToRgb(t * 100, oklchTarget.C, oklchTarget.H);
                        return rgbToHex(r.r, r.g, r.b);
                    });
                }
                if (oklch1dThumb) {
                    oklch1dThumb.style.left = `${clamp(oklchTarget.L, 0, 100)}%`;
                }
            } else {
                const svPicker = document.getElementById('sv-picker');
                const hueSlider = document.getElementById('hue-slider');
                if (svPicker && hueSlider) {
                    const pure = wheelHsvToRgb(wheelAngle, 100, 100, wheelSpace);
                    svPicker.style.backgroundColor = rgbToHex(pure.r, pure.g, pure.b);
                    const svCursor = svPicker.querySelector('.sv-cursor');
                    if (svCursor) {
                        svCursor.style.left = `${this.app.hsv.s}%`;
                        svCursor.style.top = `${100 - this.app.hsv.v}%`;
                    }
                    hueSlider.value = Math.round(wheelAngle);
                    hueSlider.style.background = buildSliderGradient(13, t => {
                        const rgb = wheelAngleToRgb(t * 360, wheelSpace, 100, 100);
                        return rgbToHex(rgb.r, rgb.g, rgb.b);
                    });
                }
            }
        }

        if (shape === 'ring-triangle' || shape === 'ring-square' || shape === 'wheel') {
            this._drawDockedGeoCanvas(wheelAngle, oklchTarget);
        }

        const wheelValSlider = document.getElementById('color-wheel-val-slider');
        if (wheelValSlider) {
            if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
                wheelValSlider.value = Math.round(oklchTarget.L);
                wheelValSlider.style.background = buildSliderGradient(9, t => {
                    const r = oklchToRgb(t * 100, oklchTarget.C, oklchTarget.H);
                    return rgbToHex(r.r, r.g, r.b);
                });
            } else {
                wheelValSlider.value = Math.round(this.app.hsv.v);
                const pure = wheelHsvToRgb(wheelAngle, this.app.hsv.s, 100, wheelSpace);
                wheelValSlider.style.background = `linear-gradient(to right, #000000, ${rgbToHex(pure.r, pure.g, pure.b)})`;
            }
        }

        const hexInput = document.getElementById('palette-hex-input');
        if (hexInput && document.activeElement !== hexInput) {
            hexInput.value = clean;
        }

        if (!deferUi) {
            this._updateSliderContainerValues(document.getElementById('palette-live-sliders'), clean);
            if (this.isOpen()) {
                this._updateSliderContainerValues(document.getElementById('studio-live-sliders'), clean);
                this._updateSliderContainerValues(document.getElementById('studio-quick-sliders'), clean);
                this._drawStudioHarmonyWheel();
                this._syncStudioAnchorCards();
            }
        }
    }

    _drawOklch2DSurface(oklchTarget, activeHex, wheelSpace = null) {
        const canvas = document.getElementById('oklch-2d-canvas');
        if (!canvas) return;
        const bw = canvas.width;
        const bh = canvas.height;
        if (bw <= 0 || bh <= 0) return;

        const ws = wheelSpace || this.app.palette.config.wheelSpace || 'oklch';
        const isOklab = (ws === 'oklab');
        const L_key = Math.round(clamp(oklchTarget.L, 0, 100) * 2) / 2;
        const rasterKey = `${ws}:${L_key}`;
        const rw = 180;
        const rh = 144;
        const MAX_C = 0.37;
        const MAX_AB = 0.34;

        if (!this._oklch2dRaster || this._oklch2dRaster.width !== rw || this._oklch2dRasterKey !== rasterKey) {
            if (!this._oklch2dRaster) {
                this._oklch2dRaster = document.createElement('canvas');
                this._oklch2dRaster.width = rw;
                this._oklch2dRaster.height = rh;
            }
            const rCtx = this._oklch2dRaster.getContext('2d');
            const img = rCtx.createImageData(rw, rh);
            const data = img.data;
            const L01 = clamp(L_key / 100, 0, 1);

            if (isOklab) {
                for (let y = 0; y < rh; y++) {
                    const b = (1 - (y / (rh - 1)) * 2) * MAX_AB;
                    for (let x = 0; x < rw; x++) {
                        const a = ((x / (rw - 1)) * 2 - 1) * MAX_AB;
                        const rgb = oklabToRgb(L_key, a, b, true);
                        const idx = (y * rw + x) * 4;
                        data[idx] = rgb.r;
                        data[idx + 1] = rgb.g;
                        data[idx + 2] = rgb.b;
                        data[idx + 3] = 255;
                    }
                }
                this._oklch2dMaxC = null;
            } else {
                const maxCs = new Float32Array(rw);
                for (let x = 0; x < rw; x++) {
                    const hueDeg = (x / (rw - 1)) * 360;
                    const rad = hueDeg * (Math.PI / 180);
                    const ca = Math.cos(rad);
                    const cb = Math.sin(rad);
                    const maxC = getMaxOklchChroma(L_key, hueDeg);
                    maxCs[x] = maxC;

                    for (let y = 0; y < rh; y++) {
                        const targetC = (1 - y / (rh - 1)) * MAX_C;
                        const actualC = targetC < maxC ? targetC : maxC;
                        // Fast inline OKLab -> sRGB when already inside maxC gamut (0 binary loops)
                        const a = actualC * ca;
                        const b = actualC * cb;
                        const l_ = L01 + 0.3963377774 * a + 0.2158037573 * b;
                        const m_ = L01 - 0.1055613458 * a - 0.0638541728 * b;
                        const s_ = L01 - 0.0894841775 * a - 1.2914855480 * b;
                        const l = l_ * l_ * l_;
                        const m = m_ * m_ * m_;
                        const s = s_ * s_ * s_;
                        const lr = clamp(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0, 1);
                        const lg = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0, 1);
                        const lb = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s, 0, 1);

                        const sr = lr <= 0.0031308 ? 12.92 * lr : 1.055 * Math.pow(lr, 1 / 2.4) - 0.055;
                        const sg = lg <= 0.0031308 ? 12.92 * lg : 1.055 * Math.pow(lg, 1 / 2.4) - 0.055;
                        const sb = lb <= 0.0031308 ? 12.92 * lb : 1.055 * Math.pow(lb, 1 / 2.4) - 0.055;

                        const idx = (y * rw + x) * 4;
                        data[idx] = sr * 255;
                        data[idx + 1] = sg * 255;
                        data[idx + 2] = sb * 255;
                        data[idx + 3] = 255;
                    }
                }
                this._oklch2dMaxC = maxCs;
            }
            rCtx.putImageData(img, 0, 0);
            this._oklch2dRasterKey = rasterKey;
        }

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, bw, bh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this._oklch2dRaster, 0, 0, bw, bh);

        const scale = bw / 180;
        let cx, cy;

        if (isOklab) {
            // Subtle neutral opponent axes crosshair (a=0, b=0)
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = Math.max(1, 0.8 * scale);
            ctx.beginPath();
            ctx.moveTo(bw * 0.5, 0);
            ctx.lineTo(bw * 0.5, bh);
            ctx.moveTo(0, bh * 0.5);
            ctx.lineTo(bw, bh * 0.5);
            ctx.stroke();
            ctx.restore();

            const rad = oklchTarget.H * (Math.PI / 180);
            const a = oklchTarget.C * Math.cos(rad);
            const b = oklchTarget.C * Math.sin(rad);
            cx = clamp((a / MAX_AB * 0.5 + 0.5) * bw, 0, bw);
            cy = clamp((0.5 - b / MAX_AB * 0.5) * bh, 0, bh);
        } else {
            // Draw crisp thin sRGB gamut boundary curve (no grey cutout!)
            const maxCs = this._oklch2dMaxC;
            if (maxCs && maxCs.length === rw) {
                ctx.beginPath();
                for (let x = 0; x < rw; x++) {
                    const px = (x / (rw - 1)) * bw;
                    const py = (1 - clamp(maxCs[x] / MAX_C, 0, 1)) * bh;
                    if (x === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.lineJoin = 'round';
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
                ctx.lineWidth = Math.max(2, 1.8 * scale);
                ctx.stroke();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
                ctx.lineWidth = Math.max(1, 0.9 * scale);
                ctx.stroke();
            }
            cx = clamp((oklchTarget.H / 360) * bw, 0, bw);
            cy = clamp((1 - clamp(oklchTarget.C / MAX_C, 0, 1)) * bh, 0, bh);
        }

        const radPx = Math.max(5, 4.2 * scale);
        ctx.beginPath();
        ctx.arc(cx, cy, radPx, 0, Math.PI * 2);
        ctx.fillStyle = activeHex;
        ctx.fill();
        ctx.lineWidth = Math.max(2.5, 2.2 * scale);
        ctx.strokeStyle = '#000000';
        ctx.stroke();
        ctx.lineWidth = Math.max(1.2, 1.1 * scale);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
    }

    _getCachedRingBitmap(size, wheelSpace) {
        const rasterSize = clamp(Math.round(size), 64, 280);
        const key = `${rasterSize}:${wheelSpace}`;
        if (this._ringBitmapCache.has(key)) {
            const cached = this._ringBitmapCache.get(key);
            this._ringBitmapCache.delete(key);
            this._ringBitmapCache.set(key, cached);
            return cached;
        }
        const c = document.createElement('canvas');
        c.width = rasterSize;
        c.height = rasterSize;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(rasterSize, rasterSize);
        const data = img.data;
        const half = rasterSize * 0.5;
        const outerPx = half * 0.94;
        const innerPx = half * 0.72;
        const scale = rasterSize / 200;
        const bw = 1.05 * scale;
        const feather = Math.max(0.85, 0.85 * scale);
        const smooth01 = (t) => {
            const x = clamp(t, 0, 1);
            return x * x * (3 - 2 * x);
        };

        for (let y = 0; y < rasterSize; y++) {
            const dy = y - half + 0.5;
            for (let x = 0; x < rasterSize; x++) {
                const dx = x - half + 0.5;
                const d = Math.hypot(dx, dy);
                if (d < innerPx - bw - feather || d > outerPx + bw + feather) continue;

                const idx = (y * rasterSize + x) * 4;
                let deg = Math.atan2(dy, dx) * (180 / Math.PI);
                if (deg < 0) deg += 360;
                const rgb = wheelAngleToRgb(deg, wheelSpace, 100, 100);

                // Smooth outer & inner silhouette coverage
                const outerCov = 1 - smooth01((d - (outerPx + bw - feather)) / (2 * feather));
                const innerCov = smooth01((d - (innerPx - bw - feather)) / (2 * feather));
                const cov = outerCov < innerCov ? outerCov : innerCov;
                if (cov <= 0.002) continue;

                // Smooth black border blend on both inner & outer edges of color band
                const outerInk = smooth01((d - (outerPx - bw - feather)) / (2 * feather));
                const innerInk = 1 - smooth01((d - (innerPx + bw - feather)) / (2 * feather));
                const ink = outerInk > innerInk ? outerInk : innerInk;

                data[idx] = rgb.r * (1 - ink);
                data[idx + 1] = rgb.g * (1 - ink);
                data[idx + 2] = rgb.b * (1 - ink);
                data[idx + 3] = Math.round(cov * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
        if (this._ringBitmapCache.size >= 10) {
            const oldestKey = this._ringBitmapCache.keys().next().value;
            this._ringBitmapCache.delete(oldestKey);
        }
        this._ringBitmapCache.set(key, c);
        return c;
    }

    _getCachedWheelBitmap(size, wheelSpace, oklchLightness = 70, studioWhiteCenter = false) {
        const rasterSize = clamp(Math.round(size), 64, 256);
        const isOk = (wheelSpace === 'oklch' || wheelSpace === 'oklab');
        const qL = Math.round(clamp(oklchLightness, 0, 100) / 3) * 3;
        const okKey = isOk ? (studioWhiteCenter ? 'studio' : qL) : 'v100';
        const key = `${rasterSize}:${wheelSpace}:${okKey}`;
        if (this._wheelBitmapCache.has(key)) {
            const cached = this._wheelBitmapCache.get(key);
            this._wheelBitmapCache.delete(key);
            this._wheelBitmapCache.set(key, cached);
            return cached;
        }
        const c = document.createElement('canvas');
        c.width = rasterSize;
        c.height = rasterSize;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(rasterSize, rasterSize);
        const data = img.data;
        const half = rasterSize * 0.5;
        const outerPx = half * 0.94;
        const scale = rasterSize / 200;
        const bw = 1.15 * scale;
        const feather = Math.max(0.9, 0.9 * scale);
        const smooth01 = (t) => {
            const x = clamp(t, 0, 1);
            return x * x * (3 - 2 * x);
        };
        const sampleL = studioWhiteCenter ? oklchLightness : qL;

        for (let y = 0; y < rasterSize; y++) {
            const dy = y - half + 0.5;
            for (let x = 0; x < rasterSize; x++) {
                const dx = x - half + 0.5;
                const d = Math.hypot(dx, dy);
                if (d > outerPx + bw + feather) continue;

                const idx = (y * rasterSize + x) * 4;
                let deg = Math.atan2(dy, dx) * (180 / Math.PI);
                if (deg < 0) deg += 360;
                const sat01 = clamp(d / outerPx, 0, 1);
                let rgb;
                if (wheelSpace === 'oklch') {
                    rgb = oklchWheelColor(deg, sat01, sampleL, studioWhiteCenter);
                } else if (wheelSpace === 'oklab') {
                    rgb = oklabWheelColor(deg, sat01, sampleL, studioWhiteCenter);
                } else {
                    rgb = wheelAngleToRgb(deg, wheelSpace, sat01 * 100, 100);
                }

                const outerCov = 1 - smooth01((d - (outerPx + bw - feather)) / (2 * feather));
                if (outerCov <= 0.002) continue;

                const borderInk = smooth01((d - (outerPx - bw - feather)) / (2 * feather));
                data[idx] = rgb.r * (1 - borderInk);
                data[idx + 1] = rgb.g * (1 - borderInk);
                data[idx + 2] = rgb.b * (1 - borderInk);
                data[idx + 3] = Math.round(outerCov * 255);
            }
        }
        ctx.putImageData(img, 0, 0);
        if (this._wheelBitmapCache.size >= 20) {
            const oldestKey = this._wheelBitmapCache.keys().next().value;
            this._wheelBitmapCache.delete(oldestKey);
        }
        this._wheelBitmapCache.set(key, c);
        return c;
    }

    _drawDockedGeoCanvas(wheelAngle, oklchTarget = null) {
        const canvas = document.getElementById('color-geo-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        const half = size * 0.5;
        const scale = size / 200;
        const shape = this.app.palette.config.pickerShape;
        const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
        const target = oklchTarget || this._ensureOklchTarget(this.getActiveHex());

        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (shape === 'wheel') {
            const isOkWheel = (wheelSpace === 'oklch' || wheelSpace === 'oklab');
            const disc = this._getCachedWheelBitmap(size, wheelSpace, isOkWheel ? target.L : 100, false);
            ctx.drawImage(disc, 0, 0, size, size);

            const outerPx = half * 0.94;
            const val01 = isOkWheel
                ? clamp(target.L / 100, 0, 1)
                : clamp((this.app.hsv?.v ?? 100) / 100, 0, 1);
            if (!isOkWheel && val01 < 0.995) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(half, half, outerPx - 1.1 * scale, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 0, 0, ${1 - val01})`;
                ctx.fill();
                ctx.restore();
            }

            const c = this.app.palette.baseColors;
            for (let i = c.length - 1; i >= 0; i--) {
                const isAct = (i === this.app.palette.activeIndex);
                let ang, rPx;
                if (isOkWheel) {
                    let lch;
                    if (isAct) {
                        lch = target;
                    } else {
                        const rgb = hexToRgb(c[i]);
                        lch = rgbToOklch(rgb.r, rgb.g, rgb.b);
                    }
                    ang = lch.H * (Math.PI / 180);
                    rPx = clamp(lch.C / 0.34, 0, 1) * outerPx;
                } else {
                    const rgb = hexToRgb(c[i]);
                    const wh = rgbToWheelHsv(rgb.r, rgb.g, rgb.b, wheelSpace);
                    ang = wh.h * (Math.PI / 180);
                    rPx = (wh.s / 100) * outerPx;
                }
                const px = half + Math.cos(ang) * rPx;
                const py = half + Math.sin(ang) * rPx;

                ctx.beginPath();
                ctx.moveTo(half, half);
                ctx.lineTo(px, py);
                ctx.strokeStyle = val01 < 0.45
                    ? (isAct ? '#ffffff' : 'rgba(255,255,255,0.45)')
                    : (isAct ? '#000000' : 'rgba(0,0,0,0.45)');
                ctx.lineWidth = (isAct ? 1.6 : 0.95) * scale;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(px, py, (isAct ? 5.6 : 3.8) * scale, 0, Math.PI * 2);
                ctx.fillStyle = c[i];
                ctx.fill();
                ctx.lineWidth = (isAct ? 1.9 : 1.1) * scale;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
                ctx.lineWidth = 0.95 * scale;
                ctx.strokeStyle = '#000000';
                ctx.stroke();
            }
            return;
        }

        // Draw crisp HiDPI outer hue ring
        const ring = this._getCachedRingBitmap(size, wheelSpace);
        ctx.drawImage(ring, 0, 0, size, size);

        const rad = wheelAngle * (Math.PI / 180);
        const innerPx = half * 0.72;
        const ringMidPx = half * 0.83;

        // Hue cursor on outer ring
        const hx = half + Math.cos(rad) * ringMidPx;
        const hy = half + Math.sin(rad) * ringMidPx;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.8 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2.8 * scale;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4 * scale;
        ctx.stroke();

        if (shape === 'ring-square') {
            const halfSide = Math.floor((innerPx - 7 * scale) * Math.SQRT1_2);
            const sx = Math.round(half - halfSide);
            const sy = Math.round(half - halfSide);
            const sw = halfSide * 2;
            const pure = wheelHsvToRgb(wheelAngle, 100, 100, wheelSpace);
            ctx.fillStyle = rgbToHex(pure.r, pure.g, pure.b);
            ctx.fillRect(sx, sy, sw, sw);

            const gW = ctx.createLinearGradient(sx, sy, sx + sw, sy);
            gW.addColorStop(0, 'rgba(255,255,255,1)');
            gW.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = gW;
            ctx.fillRect(sx, sy, sw, sw);

            const gB = ctx.createLinearGradient(sx, sy, sx, sy + sw);
            gB.addColorStop(0, 'rgba(0,0,0,0)');
            gB.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = gB;
            ctx.fillRect(sx, sy, sw, sw);

            ctx.strokeStyle = '#3d3d3d';
            ctx.lineWidth = 2.4 * scale;
            ctx.strokeRect(sx, sy, sw, sw);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.3 * scale;
            ctx.strokeRect(sx, sy, sw, sw);

            const cx = sx + (this.app.hsv.s / 100) * sw;
            const cy = sy + (1 - this.app.hsv.v / 100) * sw;
            ctx.beginPath();
            ctx.arc(cx, cy, 4.8 * scale, 0, Math.PI * 2);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2.8 * scale;
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.4 * scale;
            ctx.stroke();
            return;
        }

        // 'ring-triangle' — fixed stationary orientation (Pure Hue right, White top-left, Black bottom-left)
        const rTri = innerPx - 5 * scale;
        const cos60 = 0.5;
        const sin60 = 0.8660254037844386;
        const ax = half + rTri;
        const ay = half;
        const bx = half - cos60 * rTri;
        const by = half - sin60 * rTri;
        const cx = half - cos60 * rTri;
        const cy = half + sin60 * rTri;

        const pure = wheelHsvToRgb(wheelAngle, 100, 100, wheelSpace);
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 2);
        const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)) + 2);
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 2);
        const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)) + 2);
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) > 1e-4 && bw > 0 && bh > 0) {
            if (!this._triScratch || this._triScratch.width !== size) {
                this._triScratch = document.createElement('canvas');
                this._triScratch.width = size;
                this._triScratch.height = size;
            }
            const tCtx = this._triScratch.getContext('2d');
            tCtx.clearRect(0, 0, size, size);
            const img = tCtx.createImageData(bw, bh);
            const d = img.data;
            const invDet = 1 / det;

            // Signed inward pixel distance for crisp SDF edge anti-aliasing
            const lenBC = Math.hypot(cx - bx, cy - by) || 1;
            const lenCA = Math.hypot(ax - cx, ay - cy) || 1;
            const lenAB = Math.hypot(bx - ax, by - ay) || 1;

            for (let py = 0; py < bh; py++) {
                const y = minY + py + 0.5;
                for (let px = 0; px < bw; px++) {
                    const x = minX + px + 0.5;
                    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) * invDet;
                    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) * invDet;
                    const w = 1 - u - v;

                    const dU = u * Math.abs(det) / lenBC;
                    const dV = v * Math.abs(det) / lenCA;
                    const dW = w * Math.abs(det) / lenAB;
                    const minEdge = dU < dV ? (dU < dW ? dU : dW) : (dV < dW ? dV : dW);

                    if (minEdge >= -1.0 * scale) {
                        const uc = clamp(u, 0, 1);
                        const vc = clamp(v, 0, 1);
                        const idx = (py * bw + px) * 4;
                        const cov = clamp((minEdge / (0.85 * scale)) + 0.5, 0, 1);
                        d[idx] = clamp(uc * pure.r + vc * 255, 0, 255);
                        d[idx + 1] = clamp(uc * pure.g + vc * 255, 0, 255);
                        d[idx + 2] = clamp(uc * pure.b + vc * 255, 0, 255);
                        d[idx + 3] = Math.round(cov * 255);
                    }
                }
            }
            tCtx.putImageData(img, minX, minY);
            ctx.drawImage(this._triScratch, 0, 0);
        }

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#3d3d3d';
        ctx.lineWidth = 2.4 * scale;
        ctx.stroke();
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3 * scale;
        ctx.stroke();
        ctx.restore();

        // Reticle at barycentric (u = S*V, v = V*(1-S), w = 1-V)
        const S01 = this.app.hsv.s / 100;
        const V01 = this.app.hsv.v / 100;
        const uRet = S01 * V01;
        const vRet = V01 * (1 - S01);
        const wRet = 1 - V01;
        const rx = uRet * ax + vRet * bx + wRet * cx;
        const ry = uRet * ay + vRet * by + wRet * cy;

        ctx.beginPath();
        ctx.arc(rx, ry, 4.8 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2.8 * scale;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4 * scale;
        ctx.stroke();
    }

    // ==================== GRADIENT SLIDER RENDERING ====================
    renderDockedSliders() {
        const container = document.getElementById('palette-live-sliders');
        if (!container) return;
        const packs = SLIDER_PACKS.filter(p => this.app.palette.config.sliderGroups[p.id]);
        this._mountSliderPacks(container, packs, this.getActiveHex(), { compact: true });
    }

    _mountSliderPacks(container, packs, hex, { compact = true } = {}) {
        if (!container) return;
        if (!packs.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
            return;
        }
        container.classList.remove('hidden');
        container.innerHTML = '';
        const frag = document.createDocumentFragment();
        const oklchOverride = this._ensureOklchTarget(hex);

        for (const pack of packs) {
            const group = document.createElement('div');
            group.className = compact ? 'color-slider-pack compact' : 'color-slider-pack';
            if (!compact) {
                const hdr = document.createElement('div');
                hdr.className = 'color-slider-pack-title';
                hdr.textContent = pack.label;
                group.appendChild(hdr);
            }
            const descriptors = getSliderDescriptors(pack.id, hex, pack.id === 'oklch' ? oklchOverride : null);
            for (const desc of descriptors) {
                group.appendChild(this._createGradientSliderRow(desc, compact));
            }
            frag.appendChild(group);
        }
        container.appendChild(frag);
    }

    _createGradientSliderRow(desc, compact) {
        const row = document.createElement('div');
        row.className = compact ? 'cs-bar-row compact' : 'cs-bar-row';
        row.dataset.sliderKey = desc.key;

        const track = document.createElement('div');
        track.className = 'cs-bar-track';
        track.style.background = desc.grad;

        const thumb = document.createElement('div');
        thumb.className = 'cs-bar-thumb';
        const pct = clamp(((desc.value - desc.min) / (desc.max - desc.min || 1)) * 100, 0, 100);
        thumb.style.left = `${pct}%`;

        if (!compact) {
            const lbl = document.createElement('span');
            lbl.className = 'cs-bar-label';
            lbl.textContent = desc.label;

            const val = document.createElement('span');
            val.className = 'cs-bar-val';
            val.textContent = desc.display;

            track.appendChild(lbl);
            track.appendChild(val);
        } else {
            track.title = desc.label;
        }

        track.appendChild(thumb);
        row.appendChild(track);

        const applyPointer = (e) => {
            const rect = track.getBoundingClientRect();
            const ratio = clamp((e.clientX - rect.left) / (rect.width || 1), 0, 1);
            const dragRef = this._activeSliderDrag && this._activeSliderDrag.key === desc.key
                ? this._activeSliderDrag.startHex
                : this.getActiveHex();
            const packId = desc.key.split('-')[0].replace('paint', 'painterly');
            const dragOk = (this._activeSliderDrag && this._activeSliderDrag.key === desc.key)
                ? this._activeSliderDrag.startOklch
                : this._ensureOklchTarget(dragRef);

            if (this._activeSliderDrag && this._activeSliderDrag.key === desc.key) {
                this._activeSliderDrag.ratio = ratio;
            }

            if (packId === 'oklch') {
                const baseOk = dragOk || this._ensureOklchTarget(dragRef);
                if (desc.key === 'oklch-l') {
                    this._commitOklchTarget(ratio * 100, baseOk.C, baseOk.H, {
                        updateBase: true,
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                } else if (desc.key === 'oklch-c') {
                    this._commitOklchTarget(baseOk.L, ratio * 0.37, baseOk.H, {
                        updateBase: true,
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                } else {
                    this._commitOklchTarget(baseOk.L, baseOk.C, ratio * 360, {
                        updateBase: true,
                        deferSave: true,
                        dragBaseline: this._dragGroupBaseline
                    });
                }
                return;
            }

            const freshList = getSliderDescriptors(packId, dragRef);
            const fresh = freshList.find(d => d.key === desc.key) || desc;
            const rawVal = fresh.min + ratio * (fresh.max - fresh.min);
            const nextHex = fresh.apply(rawVal);
            this.commitPickedHex(nextHex, {
                updateBase: true,
                deferSave: true,
                dragBaseline: this._dragGroupBaseline
            });
        };

        track.onpointerdown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._beginDragGroupBaseline();
            const activeHex = this.getActiveHex();
            this._activeSliderDrag = {
                key: desc.key,
                startHex: activeHex,
                startOklch: { ...this._ensureOklchTarget(activeHex) },
                ratio: clamp((desc.value - desc.min) / (desc.max - desc.min || 1), 0, 1)
            };
            try { track.setPointerCapture(e.pointerId); } catch (_) {}
            applyPointer(e);
            const onMove = (pe) => applyPointer(pe);
            const onUp = (pe) => {
                this._activeSliderDrag = null;
                track.removeEventListener('pointermove', onMove);
                track.removeEventListener('pointerup', onUp);
                track.removeEventListener('pointercancel', onUp);
                track.removeEventListener('lostpointercapture', onUp);
                try { if (pe?.pointerId !== undefined) track.releasePointerCapture(pe.pointerId); } catch (_) {}
                this._flushDeferredSave();
                this.syncColorUI(this.getActiveHex(), { preserveHsv: true });
            };
            track.addEventListener('pointermove', onMove);
            track.addEventListener('pointerup', onUp);
            track.addEventListener('pointercancel', onUp);
            track.addEventListener('lostpointercapture', onUp);
        };

        return row;
    }

    _updateSliderContainerValues(container, hex) {
        if (!container || container.classList.contains('hidden')) return;
        // Skip updating sliders inside hidden Studio tab panes!
        const hiddenPane = container.closest('.cs-tab-pane.hidden');
        if (hiddenPane) return;

        const rows = container.querySelectorAll('.cs-bar-row');
        if (!rows.length) return;

        const cache = new Map();
        const curOklch = this._ensureOklchTarget(hex);

        rows.forEach(row => {
            const key = row.dataset.sliderKey;
            if (!key) return;
            const isDraggingThis = this._activeSliderDrag && this._activeSliderDrag.key === key;
            const evalHex = isDraggingThis ? this._activeSliderDrag.startHex : hex;
            const evalOklch = isDraggingThis ? this._activeSliderDrag.startOklch : curOklch;
            const packId = key.split('-')[0].replace('paint', 'painterly');
            const cacheKey = packId === 'oklch'
                ? `${packId}:${isDraggingThis ? 'drag' : 'live'}:${evalOklch.L.toFixed(1)}:${evalOklch.C.toFixed(3)}:${evalOklch.H.toFixed(1)}`
                : `${packId}:${evalHex}`;
            if (!cache.has(cacheKey)) {
                cache.set(cacheKey, getSliderDescriptors(packId, evalHex, packId === 'oklch' ? evalOklch : null));
            }
            const desc = cache.get(cacheKey).find(d => d.key === key);
            if (!desc) return;

            const track = row.querySelector('.cs-bar-track');
            const val = row.querySelector('.cs-bar-val');
            const thumb = row.querySelector('.cs-bar-thumb');
            if (track) track.style.background = desc.grad;

            if (isDraggingThis) {
                const livePackKey = packId === 'oklch' ? 'oklch:live' : `${packId}:${hex}`;
                if (!cache.has(livePackKey)) {
                    cache.set(livePackKey, getSliderDescriptors(packId, hex, packId === 'oklch' ? curOklch : null));
                }
                const liveDesc = cache.get(livePackKey).find(d => d.key === key) || desc;
                if (val) val.textContent = liveDesc.display;
                if (thumb) thumb.style.left = `${this._activeSliderDrag.ratio * 100}%`;
            } else {
                if (val) val.textContent = desc.display;
                if (thumb) {
                    const pct = clamp(((desc.value - desc.min) / (desc.max - desc.min || 1)) * 100, 0, 100);
                    thumb.style.left = `${pct}%`;
                }
            }
        });
    }

    // ==================== STUDIO MODAL CONTROLS & HARMONY WHEEL ====================
    _updateGroupLockUI() {
        const isLocked = !!this.app.palette.config.groupLock;
        const btn = document.getElementById('btn-cs-group-lock');
        if (btn) {
            btn.classList.toggle('locked', isLocked);
            btn.textContent = isLocked ? 'LOCKED · LINKED' : 'UNLOCKED · FREE';
        }
        const hint = document.getElementById('cs-wheel-hint');
        if (hint) {
            hint.textContent = isLocked
                ? 'LOCKED · DRAG ANY NODE TO ROTATE & SHIFT GROUP'
                : 'UNLOCKED · DRAG ANY NODE 1–6 FREELY';
            hint.style.color = isLocked ? '#facc15' : '#999';
        }
    }

    _bindStudioUI() {
        const modal = document.getElementById('modal-color-studio');
        if (!modal) return;

        // Tabs switching (sync newly revealed tab only)
        modal.querySelectorAll('.cs-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._disarmResetBtn();
                this.activeTab = btn.dataset.csTab || 'space';
                modal.querySelectorAll('.cs-tab-btn').forEach(b => b.classList.toggle('active-tool', b === btn));
                modal.querySelectorAll('.cs-tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.csPane !== this.activeTab));
                const hex = this.getActiveHex();
                if (this.activeTab === 'space') {
                    this._updateSliderContainerValues(document.getElementById('studio-quick-sliders'), hex);
                } else if (this.activeTab === 'sliders') {
                    this._updateSliderContainerValues(document.getElementById('studio-live-sliders'), hex);
                } else if (this.activeTab === 'builder') {
                    this._renderRowBuilder();
                }
            });
        });

        // Harmony Wheel interaction (instant wheel redraw + rAF coalesced UI sync + save on pointerup)
        const wheelCanvas = document.getElementById('cs-harmony-wheel');
        if (wheelCanvas) {
            const pickOrDragNode = (e, isStart) => {
                const rect = wheelCanvas.getBoundingClientRect();
                const cx = rect.width * 0.5;
                const cy = rect.height * 0.5;
                const outerPx = Math.min(cx, cy) * 0.88;
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const palette = this.app.palette;
                const wheelSpace = palette.config.wheelSpace || 'ryb';

                if (isStart) {
                    let bestIdx = -1;
                    let bestDist = 18;
                    const isOkWheel = (wheelSpace === 'oklch' || wheelSpace === 'oklab');
                    for (let i = 0; i < 6; i++) {
                        const rgb = hexToRgb(palette.baseColors[i]);
                        let hDeg, sat01;
                        if (isOkWheel) {
                            const lch = rgbToOklch(rgb.r, rgb.g, rgb.b);
                            hDeg = lch.H;
                            sat01 = clamp(lch.C / 0.34, 0, 1);
                        } else {
                            const wh = rgbToWheelHsv(rgb.r, rgb.g, rgb.b, wheelSpace);
                            hDeg = wh.h;
                            sat01 = wh.s / 100;
                        }
                        const ang = hDeg * (Math.PI / 180);
                        const rPx = sat01 * outerPx;
                        const nx = cx + Math.cos(ang) * rPx;
                        const ny = cy + Math.sin(ang) * rPx;
                        const dist = Math.hypot(x - nx, y - ny);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestIdx = i;
                        }
                    }
                    this._studioWheelDragIdx = bestIdx >= 0 ? bestIdx : palette.activeIndex;
                    palette.activeIndex = this._studioWheelDragIdx;

                    // Capture baseline BEFORE moving so group ratios and L/V never drift during drag
                    const curRgb = hexToRgb(palette.baseColors[this._studioWheelDragIdx]);
                    const activeTarget = this._ensureOklchTarget(palette.baseColors[this._studioWheelDragIdx]);
                    this._studioWheelDragStartL = clamp(
                        bestIdx >= 0 ? rgbToOklch(curRgb.r, curRgb.g, curRgb.b).L : activeTarget.L,
                        28,
                        90
                    );
                    this._studioWheelDragStartV = Math.max(15, rgbToHsv(curRgb.r, curRgb.g, curRgb.b).v);
                    this._beginDragGroupBaseline();
                }

                const idx = this._studioWheelDragIdx >= 0 ? this._studioWheelDragIdx : palette.activeIndex;
                const dx = x - cx;
                const dy = y - cy;
                let deg = Math.atan2(dy, dx) * (180 / Math.PI);
                if (deg < 0) deg += 360;
                const sat01 = clamp(Math.hypot(dx, dy) / outerPx, 0, 1);
                let nextHex;
                let coordOverride = null;

                if (wheelSpace === 'oklch' || wheelSpace === 'oklab') {
                    const curL = this._studioWheelDragStartL !== null ? this._studioWheelDragStartL : 68;
                    const C = sat01 * 0.34;
                    const outRgb = oklchToRgb(curL, C, deg);
                    nextHex = rgbToHex(outRgb.r, outRgb.g, outRgb.b);
                    coordOverride = { L: curL, C, H: deg };
                    this._oklchTarget = { L: curL, C, H: deg, hex: nextHex };
                } else {
                    const curV = this._studioWheelDragStartV !== null ? this._studioWheelDragStartV : 90;
                    const outRgb = wheelHsvToRgb(deg, sat01 * 100, curV, wheelSpace);
                    nextHex = rgbToHex(outRgb.r, outRgb.g, outRgb.b);
                    coordOverride = { h: deg, s: sat01 * 100, v: curV };
                    this._ringAngleState = { wheelSpace, angle: deg, hex: nextHex };
                }

                palette.setBaseColor(idx, nextHex, {
                    skipSave: true,
                    coordOverride,
                    dragBaseline: this._dragGroupBaseline
                });
                this._pendingDeferredSave = true;

                // Instant light update: canvas wheel + synced docked picker + readout
                this.app.setColor(nextHex, { skipSave: true, deferUi: true });
                this._drawStudioHarmonyWheel();
                this._scheduleDragUISync();
            };

            wheelCanvas.onpointerdown = (e) => {
                e.preventDefault();
                try { wheelCanvas.setPointerCapture(e.pointerId); } catch (_) {}
                pickOrDragNode(e, true);
                const onMove = (pe) => pickOrDragNode(pe, false);
                const onUp = (pe) => {
                    this._studioWheelDragIdx = -1;
                    this._studioWheelDragStartL = null;
                    this._studioWheelDragStartV = null;
                    wheelCanvas.removeEventListener('pointermove', onMove);
                    wheelCanvas.removeEventListener('pointerup', onUp);
                    wheelCanvas.removeEventListener('pointercancel', onUp);
                    wheelCanvas.removeEventListener('lostpointercapture', onUp);
                    try { if (pe?.pointerId !== undefined) wheelCanvas.releasePointerCapture(pe.pointerId); } catch (_) {}
                    this._flushDeferredSave();
                    this.syncColorUI(this.getActiveHex());
                };
                wheelCanvas.addEventListener('pointermove', onMove);
                wheelCanvas.addEventListener('pointerup', onUp);
                wheelCanvas.addEventListener('pointercancel', onUp);
                wheelCanvas.addEventListener('lostpointercapture', onUp);
            };
        }

        // Wheel Space quick buttons
        modal.querySelectorAll('[data-wheel-space]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.app.palette.config.wheelSpace = btn.dataset.wheelSpace;
                if (this.app.palette.config.groupLock) {
                    this.app.palette.captureGroupBaseline();
                }
                this._onStudioMutated({ rebuildSliders: true });
            });
        });

        // Canvas Brush Paint Mixing buttons
        modal.querySelectorAll('[data-canvas-mix]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.app.palette.config.canvasMixMode = btn.dataset.canvasMix;
                this.app.syncCanvasMixMode?.();
                this._onStudioMutated();
            });
        });

        // Palette Generation Mode buttons
        modal.querySelectorAll('[data-palette-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.app.palette.config.paletteMode = btn.dataset.paletteMode;
                this._onStudioMutated();
            });
        });

        // Mixing Space buttons
        modal.querySelectorAll('[data-mix-space]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.app.palette.config.mixSpace = btn.dataset.mixSpace;
                this._onStudioMutated();
            });
        });

        // Symmetry select & header Group Lock toggle (only runs inside Studio!)
        const symSelect = document.getElementById('cs-symmetry-select');
        const btnGroupLock = document.getElementById('btn-cs-group-lock');

        if (btnGroupLock) {
            btnGroupLock.addEventListener('click', () => {
                const nextState = !this.app.palette.config.groupLock;
                this.app.palette.setGroupLock(nextState);
                this.app.palette.saveProjectPalette(this.app.currentProjectId);
                this._updateGroupLockUI();
                this.app._status?.(nextState
                    ? 'HARMONY RATIOS LOCKED · NODES MOVE TOGETHER'
                    : 'HARMONY UNLOCKED · NODES MOVE FREELY');
            });
        }

        if (symSelect) {
            symSelect.innerHTML = SYMMETRY_MODES.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
            symSelect.addEventListener('change', () => {
                this.app.palette.config.symmetry = symSelect.value;
                if (symSelect.value !== 'custom') {
                    this.app.palette.applySymmetry(0);
                    this.app.setColor(this.app.palette.baseColors[this.app.palette.activeIndex]);
                }
                this._onStudioMutated();
            });
        }

        // Global Painterly Nudge buttons
        document.querySelectorAll('[data-global-nudge]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.globalNudge;
                if (action === 'warm') this.app.palette.adjustAllAnchors({ tempDelta: 18 });
                else if (action === 'cool') this.app.palette.adjustAllAnchors({ tempDelta: -18 });
                else if (action === 'hue-plus') this.app.palette.adjustAllAnchors({ hueDelta: 15 });
                else if (action === 'hue-minus') this.app.palette.adjustAllAnchors({ hueDelta: -15 });
                else if (action === 'light-plus') this.app.palette.adjustAllAnchors({ lightDelta: 8 });
                else if (action === 'light-minus') this.app.palette.adjustAllAnchors({ lightDelta: -8 });
                else if (action === 'sat-plus') this.app.palette.adjustAllAnchors({ satDelta: 12 });
                else if (action === 'sat-minus') this.app.palette.adjustAllAnchors({ satDelta: -12 });
                else if (action === 'angle-plus') this.app.palette.adjustAngleSpread(1);
                else if (action === 'angle-minus') this.app.palette.adjustAngleSpread(-1);
                else if (action === 'contrast-plus') this.app.palette.adjustTonalContrast(1);
                else if (action === 'contrast-minus') this.app.palette.adjustTonalContrast(-1);
                else if (action === 'random') {
                    const baseH = Math.random() * 360;
                    const s = 55 + Math.random() * 40;
                    const v = 50 + Math.random() * 45;
                    const rgb = wheelHsvToRgb(baseH, s, v, this.app.palette.config.wheelSpace);
                    this.app.palette.setBaseColor(0, rgbToHex(rgb.r, rgb.g, rgb.b), { skipGroup: true });
                    if (this.app.palette.config.symmetry !== 'custom') {
                        this.app.palette.applySymmetry(0);
                    } else {
                        for (let i = 1; i < 6; i++) {
                            if (this.app.palette.config.locks[i]) continue;
                            const rr = wheelHsvToRgb((baseH + i * 55 + Math.random() * 25) % 360, 40 + Math.random() * 55, 35 + Math.random() * 60, this.app.palette.config.wheelSpace);
                            this.app.palette.setBaseColor(i, rgbToHex(rr.r, rr.g, rr.b), { skipGroup: true });
                        }
                        if (this.app.palette.config.groupLock) {
                            this.app.palette.captureGroupBaseline();
                        }
                    }
                }
                this.app.setColor(this.app.palette.baseColors[this.app.palette.activeIndex]);
                this._onStudioMutated();
            });
        });

        // Picker shape checkboxes (acts like single-choice checkboxes matching user's request!)
        const shapeListEl = document.getElementById('cs-picker-shape-checks');
        if (shapeListEl) {
            shapeListEl.innerHTML = PICKER_SHAPES.map(ps => `
                <label class="cs-check-card">
                    <input type="checkbox" class="cs-shape-chk" data-picker-shape="${ps.id}">
                    <span class="cs-check-box"></span>
                    <span class="cs-check-text">${ps.label}</span>
                </label>
            `).join('');
            shapeListEl.querySelectorAll('.cs-shape-chk').forEach(chk => {
                chk.addEventListener('change', () => {
                    this.app.palette.config.pickerShape = chk.dataset.pickerShape;
                    this._onStudioMutated({ rebuildSliders: false });
                });
            });
        }

        // Slider packs checkboxes
        const sliderChecksEl = document.getElementById('cs-slider-pack-checks');
        if (sliderChecksEl) {
            sliderChecksEl.innerHTML = SLIDER_PACKS.map(sp => `
                <label class="cs-check-card">
                    <input type="checkbox" class="cs-pack-chk" data-slider-pack="${sp.id}">
                    <span class="cs-check-box"></span>
                    <span class="cs-check-text">${sp.label}</span>
                </label>
            `).join('');
            sliderChecksEl.querySelectorAll('.cs-pack-chk').forEach(chk => {
                chk.addEventListener('change', () => {
                    this.app.palette.config.sliderGroups[chk.dataset.sliderPack] = chk.checked;
                    this._onStudioMutated({ rebuildSliders: true });
                });
            });
        }

        // Docked layout checkboxes / sliders
        const chkSwatches = document.getElementById('cs-chk-show-swatches');
        const chkHex = document.getElementById('cs-chk-show-hex');
        const chkRounded = document.getElementById('cs-chk-rounded-swatches');
        const slWidth = document.getElementById('cs-panel-width');
        const slHeight = document.getElementById('cs-swatch-height');
        const slGap = document.getElementById('cs-swatch-gap');

        if (chkSwatches) chkSwatches.addEventListener('change', () => { this.app.palette.config.showSwatches = chkSwatches.checked; this._onStudioMutated(); });
        if (chkHex) chkHex.addEventListener('change', () => { this.app.palette.config.showHex = chkHex.checked; this._onStudioMutated(); });
        if (chkRounded) chkRounded.addEventListener('change', () => { this.app.palette.config.swatchShape = chkRounded.checked ? 'rounded' : 'square'; this._onStudioMutated(); });
        if (slWidth) slWidth.addEventListener('input', () => { this.app.palette.config.panelWidth = parseInt(slWidth.value, 10); this._onStudioMutated(); });
        if (slHeight) slHeight.addEventListener('input', () => { this.app.palette.config.swatchHeight = parseInt(slHeight.value, 10); this._onStudioMutated(); });
        if (slGap) slGap.addEventListener('input', () => { this.app.palette.config.swatchGap = parseInt(slGap.value, 10); this._onStudioMutated(); });

        // Row Builder "+ ADD ROW" & Reset
        const btnAddRow = document.getElementById('btn-cs-add-row');
        const newRowSelect = document.getElementById('cs-new-row-type');
        if (newRowSelect) {
            newRowSelect.innerHTML = ROW_TEMPLATES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
        }
        if (btnAddRow && newRowSelect) {
            btnAddRow.addEventListener('click', () => {
                const tpl = ROW_TEMPLATES.find(t => t.id === newRowSelect.value) || ROW_TEMPLATES[5];
                this.app.palette.config.rows.push({
                    id: `custom-${Date.now()}`,
                    enabled: true,
                    label: tpl.label.split(' ')[0] + ' ROW',
                    type: tpl.id,
                    cols: tpl.defaultCols,
                    hShift: 0,
                    sShift: 0,
                    lShift: 0
                });
                this._onStudioMutated();
            });
        }

        const btnResetStudio = document.getElementById('btn-cs-reset-defaults');
        if (btnResetStudio) {
            btnResetStudio.addEventListener('click', () => {
                if (!this._resetArmed) {
                    this._resetArmed = true;
                    btnResetStudio.classList.add('cs-danger-armed');
                    btnResetStudio.textContent = 'CLICK AGAIN TO CONFIRM RESET';
                    if (this._resetArmTimer) clearTimeout(this._resetArmTimer);
                    this._resetArmTimer = setTimeout(() => {
                        this._disarmResetBtn();
                    }, 3500);
                    return;
                }
                this._disarmResetBtn();
                this.app.palette.resetDefaults();
                this.app.setColor(this.app.palette.baseColors[0]);
                this.app.syncCanvasMixMode?.();
                this._onStudioMutated({ rebuildSliders: true });
                this.app._status?.('COLOR STUDIO RESET TO DEFAULTS');
            });
        }

        const btnSavePreset = document.getElementById('btn-cs-save-preset');
        if (btnSavePreset) {
            btnSavePreset.addEventListener('click', () => {
                const nameInput = document.getElementById('cs-preset-name');
                const rawName = (nameInput?.value || '').trim().toUpperCase();
                const name = rawName || `PALETTE ${this.app.palette.customPresets.length + 1}`;
                this.app.palette.customPresets.push({
                    id: `usr-${Date.now()}`,
                    name,
                    colors: [...this.app.palette.baseColors],
                    wheelSpace: this.app.palette.config.wheelSpace,
                    mixSpace: this.app.palette.config.mixSpace,
                    symmetry: this.app.palette.config.symmetry,
                    config: this.app.palette._cloneConfig(this.app.palette.config)
                });
                this.app.palette.saveCustomPresets();
                if (nameInput) nameInput.value = '';
                this.renderPresetsBar();
                this.app._status?.(`SAVED PRESET: ${name}`);
            });
        }
    }

    _onStudioMutated({ rebuildSliders = false } = {}) {
        this.app.palette.saveConfig();
        this.app.palette.saveProjectPalette(this.app.currentProjectId);
        this.applyDockedPanelLayout();
        if (!rebuildSliders) {
            this.renderDockedSliders();
        }
        this.app._renderPalette();
        this.syncColorUI(this.getActiveHex());
        this.renderStudioControls();
        this.renderStudioDynamicSections();
    }

    renderStudioControls() {
        const cfg = this.app.palette.config;

        document.querySelectorAll('[data-wheel-space]').forEach(btn => {
            btn.classList.toggle('active-tool', btn.dataset.wheelSpace === cfg.wheelSpace);
        });
        document.querySelectorAll('[data-canvas-mix]').forEach(btn => {
            btn.classList.toggle('active-tool', btn.dataset.canvasMix === (cfg.canvasMixMode || 'physical'));
        });
        document.querySelectorAll('[data-palette-mode]').forEach(btn => {
            btn.classList.toggle('active-tool', btn.dataset.paletteMode === (cfg.paletteMode || 'digital'));
        });
        document.querySelectorAll('[data-mix-space]').forEach(btn => {
            btn.classList.toggle('active-tool', btn.dataset.mixSpace === cfg.mixSpace);
        });

        const symSelect = document.getElementById('cs-symmetry-select');
        if (symSelect) symSelect.value = cfg.symmetry || 'custom';
        this._updateGroupLockUI();

        document.querySelectorAll('.cs-shape-chk').forEach(chk => {
            chk.checked = (chk.dataset.pickerShape === cfg.pickerShape);
        });
        document.querySelectorAll('.cs-pack-chk').forEach(chk => {
            chk.checked = Boolean(cfg.sliderGroups[chk.dataset.sliderPack]);
        });

        const chkSwatches = document.getElementById('cs-chk-show-swatches');
        const chkHex = document.getElementById('cs-chk-show-hex');
        const chkRounded = document.getElementById('cs-chk-rounded-swatches');
        const slWidth = document.getElementById('cs-panel-width');
        const slHeight = document.getElementById('cs-swatch-height');
        const slGap = document.getElementById('cs-swatch-gap');

        if (chkSwatches) chkSwatches.checked = !!cfg.showSwatches;
        if (chkHex) chkHex.checked = !!cfg.showHex;
        if (chkRounded) chkRounded.checked = cfg.swatchShape === 'rounded';
        if (slWidth) {
            slWidth.value = cfg.panelWidth ?? 204;
            const v = document.getElementById('cs-panel-width-val');
            if (v) v.textContent = `${cfg.panelWidth ?? 204}px`;
        }
        if (slHeight) {
            slHeight.value = cfg.swatchHeight ?? 24;
            const v = document.getElementById('cs-swatch-height-val');
            if (v) v.textContent = `${cfg.swatchHeight ?? 24}px`;
        }
        if (slGap) {
            slGap.value = cfg.swatchGap ?? 2;
            const v = document.getElementById('cs-swatch-gap-val');
            if (v) v.textContent = `${cfg.swatchGap ?? 2}px`;
        }

        // Rebuild Studio Quick Sliders & Lab Sliders
        const hex = this.getActiveHex();
        const checkedPacks = SLIDER_PACKS.filter(p => cfg.sliderGroups[p.id]);
        this._mountSliderPacks(
            document.getElementById('studio-quick-sliders'),
            checkedPacks.length ? checkedPacks : SLIDER_PACKS.slice(0, 2),
            hex,
            { compact: false }
        );
        this._mountSliderPacks(
            document.getElementById('studio-live-sliders'),
            SLIDER_PACKS,
            hex,
            { compact: false }
        );
    }

    renderStudioDynamicSections({ includeHeavy = true } = {}) {
        this._drawStudioHarmonyWheel();
        this._syncStudioAnchorCards();
        this._renderMixProofBar();
        this._renderPalettePreview();
        if (includeHeavy) {
            this._renderRowBuilder();
            this.renderPresetsBar();
        }
    }

    _drawStudioHarmonyWheel() {
        const canvas = document.getElementById('cs-harmony-wheel');
        if (!canvas) return;
        const dpr = this._getDpr();
        const targetSize = Math.round(240 * dpr);
        if (canvas.width !== targetSize || canvas.height !== targetSize) {
            canvas.width = targetSize;
            canvas.height = targetSize;
        }
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        const half = size * 0.5;
        const scale = size / 240;
        const outerPx = half * 0.88;
        const wheelSpace = this.app.palette.config.wheelSpace || 'ryb';
        const palette = this.app.palette;

        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const disc = this._getCachedWheelBitmap(size, wheelSpace, wheelSpace === 'oklab' ? 68 : 72, true);
        ctx.drawImage(disc, 0, 0, size, size);

        const isOkWheel = (wheelSpace === 'oklch' || wheelSpace === 'oklab');
        const c = palette.baseColors;
        for (let i = c.length - 1; i >= 0; i--) {
            const rgb = hexToRgb(c[i]);
            let hDeg, sat01;
            if (isOkWheel) {
                const lch = rgbToOklch(rgb.r, rgb.g, rgb.b);
                hDeg = lch.H;
                sat01 = clamp(lch.C / 0.34, 0, 1);
            } else {
                const wh = rgbToWheelHsv(rgb.r, rgb.g, rgb.b, wheelSpace);
                hDeg = wh.h;
                sat01 = wh.s / 100;
            }
            const ang = hDeg * (Math.PI / 180);
            const rPx = sat01 * outerPx;
            const px = half + Math.cos(ang) * rPx;
            const py = half + Math.sin(ang) * rPx;
            const isActive = (i === palette.activeIndex);

            ctx.beginPath();
            ctx.moveTo(half, half);
            ctx.lineTo(px, py);
            ctx.strokeStyle = isActive ? '#000000' : 'rgba(0, 0, 0, 0.5)';
            ctx.lineWidth = (isActive ? 2.1 : 1.15) * scale;
            ctx.stroke();

            const radius = (isActive ? 10.5 : 8.2) * scale;
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fillStyle = c[i];
            ctx.fill();
            ctx.lineWidth = (isActive ? 2.5 : 1.7) * scale;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.lineWidth = 1.0 * scale;
            ctx.strokeStyle = '#000000';
            ctx.stroke();

            ctx.fillStyle = getContrastTextColor(c[i]);
            ctx.font = `bold ${Math.round(8 * scale)}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), px, py + 0.5 * scale);
        }

        const readout = document.getElementById('cs-wheel-readout');
        if (readout) {
            const actHex = c[palette.activeIndex] || c[0];
            const actRgb = hexToRgb(actHex);
            const angle = isOkWheel
                ? this._ensureOklchTarget(actHex).H
                : rgbToWheelHsv(actRgb.r, actRgb.g, actRgb.b, wheelSpace).h;
            readout.textContent = `${wheelSpace === 'hsl' ? 'RGB' : wheelSpace.toUpperCase()} · ${Math.round(angle)}° · ${actHex}`;
        }
    }

    _syncStudioAnchorCards() {
        const grid = document.getElementById('cs-anchor-cards');
        if (!grid) return;
        const palette = this.app.palette;

        // Fast path: patch existing 6 cards in place without innerHTML rebuild
        if (grid.children.length === 6) {
            for (let idx = 0; idx < 6; idx++) {
                const hex = palette.baseColors[idx];
                const card = grid.children[idx];
                const isAct = palette.activeIndex === idx;
                const isLocked = !!palette.config.locks[idx];
                card.className = 'cs-anchor-card' + (isAct ? ' active' : '');
                card.style.backgroundColor = hex;
                card.style.color = getContrastTextColor(hex);
                const lockBtn = card.querySelector('.cs-anchor-lock');
                if (lockBtn) {
                    lockBtn.className = 'cs-anchor-lock' + (isLocked ? ' locked' : '');
                    lockBtn.textContent = isLocked ? 'LCK' : 'OPN';
                    lockBtn.title = isLocked ? 'Unlock Anchor' : 'Freeze Anchor';
                }
                const code = card.querySelector('.cs-anchor-hex');
                if (code) code.textContent = hex;
            }
            return;
        }

        grid.innerHTML = '';
        palette.baseColors.forEach((hex, idx) => {
            const card = document.createElement('div');
            card.className = 'cs-anchor-card' + (palette.activeIndex === idx ? ' active' : '');
            card.style.backgroundColor = hex;
            card.style.color = getContrastTextColor(hex);

            const top = document.createElement('div');
            top.className = 'cs-anchor-top';

            const badge = document.createElement('span');
            badge.className = 'cs-anchor-idx';
            badge.textContent = String(idx + 1);

            const lockBtn = document.createElement('button');
            lockBtn.className = 'cs-anchor-lock' + (palette.config.locks[idx] ? ' locked' : '');
            lockBtn.title = palette.config.locks[idx] ? 'Unlock Anchor' : 'Freeze Anchor';
            lockBtn.textContent = palette.config.locks[idx] ? 'LCK' : 'OPN';
            lockBtn.onclick = (e) => {
                e.stopPropagation();
                palette.toggleLock(idx);
                this._syncStudioAnchorCards();
            };

            top.appendChild(badge);
            top.appendChild(lockBtn);

            const code = document.createElement('div');
            code.className = 'cs-anchor-hex';
            code.textContent = hex;

            card.appendChild(top);
            card.appendChild(code);

            card.onclick = () => {
                palette.activeIndex = idx;
                const curHex = palette.baseColors[idx];
                this.app.setColor(curHex);
                this.app._renderPalette();
                this.renderStudioDynamicSections({ includeHeavy: false });
            };
            grid.appendChild(card);
        });
    }

    _renderMixProofBar() {
        const box = document.getElementById('cs-mix-proof');
        if (!box) return;
        const space = this.app.palette.config.mixSpace || 'ryb';
        const mixSample = mixColorsSpace('#FFFF00', '#1D4ED8', 0.5, space);
        const a0 = this.app.palette.baseColors[0];
        const a1 = this.app.palette.baseColors[1];
        const liveSample = mixColorsSpace(a0, a1, 0.5, space);

        const rows = box.querySelectorAll('.cs-mix-proof-row');
        if (rows.length === 2) {
            const r0Lbl = rows[0].querySelector('.cs-proof-lbl');
            const r0Wide = rows[0].querySelector('.cs-proof-chip.wide');
            if (r0Lbl) r0Lbl.textContent = `YEL + BLU (${space.toUpperCase()}):`;
            if (r0Wide) {
                r0Wide.style.background = mixSample;
                r0Wide.style.color = getContrastTextColor(mixSample);
                r0Wide.textContent = mixSample;
            }
            const r1Chips = rows[1].querySelectorAll('.cs-proof-chip');
            if (r1Chips.length === 3) {
                r1Chips[0].style.background = a0;
                r1Chips[1].style.background = a1;
                r1Chips[2].style.background = liveSample;
                r1Chips[2].style.color = getContrastTextColor(liveSample);
                r1Chips[2].textContent = liveSample;
            }
            return;
        }

        box.innerHTML = `
            <div class="cs-mix-proof-row">
                <span class="cs-proof-lbl">YEL + BLU (${space.toUpperCase()}):</span>
                <span class="cs-proof-chip" style="background:#FFFF00"></span>
                <span>+</span>
                <span class="cs-proof-chip" style="background:#1D4ED8"></span>
                <span>=</span>
                <span class="cs-proof-chip wide" style="background:${mixSample}; color:${getContrastTextColor(mixSample)}">${mixSample}</span>
            </div>
            <div class="cs-mix-proof-row">
                <span class="cs-proof-lbl">ANCHOR 1 + 2:</span>
                <span class="cs-proof-chip" style="background:${a0}"></span>
                <span>+</span>
                <span class="cs-proof-chip" style="background:${a1}"></span>
                <span>=</span>
                <span class="cs-proof-chip wide" style="background:${liveSample}; color:${getContrastTextColor(liveSample)}">${liveSample}</span>
            </div>
        `;
    }

    _renderPalettePreview() {
        const preview = document.getElementById('cs-live-palette-preview');
        if (!preview) return;
        const cfg = this.app.palette.config;
        const activeMode = cfg.paletteMode || 'digital';
        const modes = [
            {
                id: 'digital',
                title: '1 · DIGITAL ROWS',
                badge: 'CUSTOM',
                rows: this.app.palette.generate('digital')
            },
            {
                id: 'physical',
                title: '2 · ARTIST 6-MIX + VALUE',
                badge: 'RYB+VAL',
                rows: this.app.palette.generate('physical')
            }
        ];

        // Fast path: patch existing mode cards & swatches in place when structure matches
        const cards = preview.children;
        let canPatch = cards.length === modes.length;
        if (canPatch) {
            for (let m = 0; m < modes.length; m++) {
                const card = cards[m];
                const mode = modes[m];
                // child 0 is header, children 1..N are palette-row elements
                if (!card || card.children.length !== mode.rows.length + 1) {
                    canPatch = false;
                    break;
                }
                for (let r = 0; r < mode.rows.length; r++) {
                    const rowEl = card.children[r + 1];
                    const row = mode.rows[r];
                    if (!rowEl || rowEl.children.length !== row.length) {
                        canPatch = false;
                        break;
                    }
                    for (let c = 0; c < row.length; c++) {
                        const sw = rowEl.children[c];
                        if (!sw || sw.dataset.swType !== row[c].type || String(sw.dataset.swSpan || '') !== String(row[c].span || '')) {
                            canPatch = false;
                            break;
                        }
                    }
                    if (!canPatch) break;
                }
                if (!canPatch) break;
            }
        }

        if (canPatch) {
            const radius = cfg.swatchShape === 'rounded' ? '3px' : '0px';
            for (let m = 0; m < modes.length; m++) {
                const card = cards[m];
                const mode = modes[m];
                card.className = 'cs-mode-card' + (activeMode === mode.id ? ' active-mode' : '');
                const badge = card.querySelector('.cs-mode-badge');
                if (badge) badge.textContent = activeMode === mode.id ? 'ACTIVE' : mode.badge;
                for (let r = 0; r < mode.rows.length; r++) {
                    const rowEl = card.children[r + 1];
                    const row = mode.rows[r];
                    for (let c = 0; c < row.length; c++) {
                        const sw = rowEl.children[c];
                        const item = row[c];
                        sw._swatchColor = item.color;
                        sw.style.backgroundColor = item.color;
                        sw.style.borderRadius = radius;
                        sw.classList.toggle('active-swatch', !!item.active);
                        sw.title = item.color;
                    }
                }
            }
            return;
        }

        preview.innerHTML = '';
        modes.forEach(mode => {
            const card = document.createElement('div');
            card.className = 'cs-mode-card' + (activeMode === mode.id ? ' active-mode' : '');
            card.onclick = () => {
                if (this.app.palette.config.paletteMode !== mode.id) {
                    this.app.palette.config.paletteMode = mode.id;
                    this._onStudioMutated();
                }
            };

            const hdr = document.createElement('div');
            hdr.className = 'cs-mode-card-hdr';

            const title = document.createElement('span');
            title.className = 'cs-mode-title';
            title.textContent = mode.title;

            const badge = document.createElement('span');
            badge.className = 'cs-mode-badge';
            badge.textContent = activeMode === mode.id ? 'ACTIVE' : mode.badge;

            hdr.appendChild(title);
            hdr.appendChild(badge);
            card.appendChild(hdr);

            mode.rows.forEach(row => {
                const rowEl = document.createElement('div');
                rowEl.className = 'palette-row';
                rowEl.style.gap = '2px';
                rowEl.style.minHeight = '13px';
                row.forEach(item => {
                    const sw = document.createElement('div');
                    sw.className = `swatch ${item.type}`;
                    sw.dataset.swType = item.type;
                    if (item.span) sw.dataset.swSpan = String(item.span);
                    if (item.active) sw.classList.add('active-swatch');
                    sw._swatchColor = item.color;
                    sw.style.backgroundColor = item.color;
                    sw.style.height = '13px';
                    if (cfg.swatchShape === 'rounded') sw.style.borderRadius = '3px';
                    if (item.span) sw.style.flex = item.span;
                    sw.title = item.color;
                    sw.onclick = (e) => {
                        e.stopPropagation();
                        const col = sw._swatchColor || item.color;
                        if (item.type === 'main') {
                            this.app.palette.activeIndex = item.index;
                            this.app.setColor(col);
                            this.app._renderPalette();
                            this.renderStudioDynamicSections({ includeHeavy: false });
                        } else {
                            this.commitPickedHex(col, { updateBase: true });
                        }
                    };
                    rowEl.appendChild(sw);
                });
                card.appendChild(rowEl);
            });

            preview.appendChild(card);
        });
    }

    _renderRowBuilder() {
        const list = document.getElementById('cs-row-builder-list');
        if (!list) return;
        const rows = this.app.palette.config.rows || [];
        list.innerHTML = '';

        rows.forEach((rowDef, idx) => {
            const card = document.createElement('div');
            card.className = 'cs-row-card';

            const top = document.createElement('div');
            top.className = 'cs-row-card-head';

            const chkWrap = document.createElement('label');
            chkWrap.style.display = 'flex';
            chkWrap.style.alignItems = 'center';
            chkWrap.style.gap = '6px';
            chkWrap.style.cursor = 'pointer';

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = !!rowDef.enabled;
            chk.onchange = () => {
                rowDef.enabled = chk.checked;
                this._onStudioMutated();
            };

            const title = document.createElement('span');
            title.textContent = rowDef.label;
            title.style.fontWeight = '900';
            title.style.fontSize = '9px';

            chkWrap.appendChild(chk);
            chkWrap.appendChild(title);

            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '2px';

            const btnUp = document.createElement('button');
            btnUp.className = 'mini-btn';
            btnUp.textContent = '▲';
            btnUp.disabled = idx === 0;
            btnUp.onclick = () => {
                if (idx <= 0) return;
                [rows[idx - 1], rows[idx]] = [rows[idx], rows[idx - 1]];
                this._onStudioMutated();
            };

            const btnDn = document.createElement('button');
            btnDn.className = 'mini-btn';
            btnDn.textContent = '▼';
            btnDn.disabled = idx === rows.length - 1;
            btnDn.onclick = () => {
                if (idx >= rows.length - 1) return;
                [rows[idx], rows[idx + 1]] = [rows[idx + 1], rows[idx]];
                this._onStudioMutated();
            };

            const btnDel = document.createElement('button');
            btnDel.className = 'mini-btn';
            btnDel.textContent = 'X';
            btnDel.disabled = rows.length <= 1;
            btnDel.onclick = () => {
                if (rows.length <= 1) return;
                rows.splice(idx, 1);
                this._onStudioMutated();
            };

            actions.append(btnUp, btnDn, btnDel);
            top.append(chkWrap, actions);
            card.appendChild(top);

            if (rowDef.type !== 'main') {
                const ctrls = document.createElement('div');
                ctrls.className = 'cs-row-card-ctrls';

                const mkMini = (lblText, prop, min, max) => {
                    const wrap = document.createElement('label');
                    wrap.className = 'cs-mini-num';
                    wrap.innerHTML = `<span>${lblText}</span>`;
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.min = min;
                    inp.max = max;
                    inp.value = rowDef[prop] ?? 0;
                    inp.onchange = () => {
                        rowDef[prop] = clamp(parseFloat(inp.value) || 0, min, max);
                        this._onStudioMutated();
                    };
                    wrap.appendChild(inp);
                    return wrap;
                };

                if (rowDef.type === 'pair-mix' || rowDef.type === 'adj-mix' || rowDef.type === 'value-ramp' || rowDef.type === 'temp-ramp') {
                    ctrls.appendChild(mkMini('COLS', 'cols', 2, 10));
                }
                ctrls.appendChild(mkMini('H°', 'hShift', -180, 180));
                ctrls.appendChild(mkMini('S%', 'sShift', -50, 50));
                ctrls.appendChild(mkMini('L%', 'lShift', -50, 50));
                card.appendChild(ctrls);
            }

            list.appendChild(card);
        });
    }

    renderPresetsBar() {
        const bar = document.getElementById('cs-presets-bar');
        if (!bar) return;
        bar.innerHTML = '';

        const all = [
            ...PALETTE_PRESETS.map(p => ({ ...p, builtIn: true })),
            ...this.app.palette.customPresets.map(p => ({ ...p, builtIn: false }))
        ];

        all.forEach((p, idx) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'cs-preset-card';
            card.title = p.name;

            const swatches = document.createElement('div');
            swatches.className = 'cs-preset-swatches';
            p.colors.slice(0, 6).forEach(col => {
                const chip = document.createElement('i');
                chip.style.background = col;
                swatches.appendChild(chip);
            });

            const footer = document.createElement('div');
            footer.className = 'cs-preset-footer';

            const nameEl = document.createElement('span');
            nameEl.className = 'cs-preset-name';
            nameEl.textContent = p.name;
            footer.appendChild(nameEl);

            if (!p.builtIn) {
                const del = document.createElement('span');
                del.className = 'cs-preset-del';
                del.textContent = '×';
                del.title = 'Delete Preset';
                del.onclick = (ev) => {
                    ev.stopPropagation();
                    const usrIdx = idx - PALETTE_PRESETS.length;
                    this.app.palette.customPresets.splice(usrIdx, 1);
                    this.app.palette.saveCustomPresets();
                    this.renderPresetsBar();
                };
                footer.appendChild(del);
            }

            card.appendChild(swatches);
            card.appendChild(footer);
            card.onclick = () => {
                this.app.palette.loadPreset(p);
                this.app.setColor(this.app.palette.baseColors[0]);
                this._onStudioMutated({ rebuildSliders: true });
            };
            bar.appendChild(card);
        });
    }
}