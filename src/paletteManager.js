import { mixColors, shiftColor } from './colorUtils.js';

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

        try {
            const saved = localStorage.getItem('canvas_palette');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length === 6) {
                    this.baseColors = parsed;
                }
            }
        } catch(e) {}

        this.activeIndex = 0;
    }

    setBaseColor(index, color) {
        this.baseColors[index] = color;
        localStorage.setItem('canvas_palette', JSON.stringify(this.baseColors));
    }

    generate() {
        const rows = [];
        const c = this.baseColors;

        // Row 1: Main (6 cols)
        rows.push([
            { color: c[0], type: 'main', index: 0, active: this.activeIndex === 0 },
            { color: c[1], type: 'main', index: 1, active: this.activeIndex === 1 },
            { color: c[2], type: 'main', index: 2, active: this.activeIndex === 2 },
            { color: c[3], type: 'main', index: 3, active: this.activeIndex === 3 },
            { color: c[4], type: 'main', index: 4, active: this.activeIndex === 4 },
            { color: c[5], type: 'main', index: 5, active: this.activeIndex === 5 }
        ]);

        // Row 2: Mixes (3 double-wide or 3 items)
        // [1+2] [3+4] [5+6]
        rows.push([
            { color: shiftColor(mixColors(c[0], c[1]), 10, 5, 5), type: 'mix', span: 2 },
            { color: shiftColor(mixColors(c[2], c[3]), 10, 5, 5), type: 'mix', span: 2 },
            { color: shiftColor(mixColors(c[4], c[5]), 10, 5, 5), type: 'mix', span: 2 }
        ]);

        // Row 3: Shifts and Mid Mixes (4 items)
        // [1L] [2+3] [4+5] [6L]
        rows.push([
            { color: shiftColor(c[0], 0, -10, 30), type: 'shift', span: 1 },
            { color: mixColors(c[1], c[2]), type: 'mix', span: 2 },
            { color: mixColors(c[3], c[4]), type: 'mix', span: 2 },
            { color: shiftColor(c[5], 0, -10, 30), type: 'shift', span: 1 }
        ]);

        // Row 4: More Mixes (3 items)
        // [1+2 shifted more]
        rows.push([
            { color: shiftColor(mixColors(c[0], c[1]), -10, 10, 15), type: 'mix', span: 2 },
            { color: shiftColor(mixColors(c[2], c[3]), -10, 10, 15), type: 'mix', span: 2 },
            { color: shiftColor(mixColors(c[4], c[5]), -10, 10, 15), type: 'mix', span: 2 }
        ]);

        // Row 5: Final Shifts (6 items)
        // "New" 1, 2, 3, 4, 5, 6
        rows.push([
             { color: shiftColor(c[0], 20, 20, 10), type: 'new' },
             { color: shiftColor(c[1], 20, 20, 10), type: 'new' },
             { color: shiftColor(c[2], 20, 20, 10), type: 'new' },
             { color: shiftColor(c[3], 20, 20, 10), type: 'new' },
             { color: shiftColor(c[4], 20, 20, 10), type: 'new' },
             { color: shiftColor(c[5], 20, 20, 10), type: 'new' }
        ]);

        return rows;
    }
}