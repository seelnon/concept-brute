export function setupIgnoreSystem(engine) {
    const getTargetEl = (target) => {
        if (!target) return null;
        return target instanceof Element ? target : target.parentElement;
    };

    const isTextInputEl = (el) => {
        if (!el || !(el instanceof Element)) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') {
            const type = (el.type || 'text').toLowerCase();
            return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
        }
        return false;
    };

    const isEditingText = () => isTextInputEl(document.activeElement);

    const clearRogueSelection = () => {
        const sel = window.getSelection?.();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const active = document.activeElement;
        if (!isTextInputEl(active)) {
            sel.removeAllRanges();
            return;
        }
        if (active.isContentEditable) {
            if (!active.contains(sel.anchorNode) || !active.contains(sel.focusNode)) {
                sel.removeAllRanges();
            }
            return;
        }
        const insideParentOnly = (
            sel.anchorNode === active.parentNode &&
            sel.focusNode === active.parentNode &&
            Math.abs(sel.focusOffset - sel.anchorOffset) <= 1
        );
        const insideActive = active.contains(sel.anchorNode) && active.contains(sel.focusNode);
        if (!insideActive && !insideParentOnly) {
            sel.removeAllRanges();
        }
    };

    // 1. Keydown default action blocks
    window.addEventListener('keydown', (e) => {
        const key = e.key;
        const lowKey = key.toLowerCase();
        
        // Block Alt on its own to prevent Windows/Linux/Firefox menu bar focus activation
        if (key === 'Alt') {
            e.preventDefault();
            return;
        }

        // Check if user is typing in standard text inputs
        if (isEditingText()) {
            return;
        }

        // Tab focus shifting - highly annoying in drawing/canvas apps
        if (key === 'Tab') {
            e.preventDefault();
            return;
        }

        // F1 (Help), F3 (Find), F10 (Bar focus)
        if (key === 'F1' || key === 'F3' || key === 'F10') {
            e.preventDefault();
            return;
        }

        // Ctrl Combinations
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+S (Save), Ctrl+D (Deselect)
            if (lowKey === 's' || lowKey === 'd') {
                e.preventDefault();
                return;
            }
            // Ctrl+Z (Undo), Ctrl+Y (Redo)
            if (lowKey === 'z' || lowKey === 'y') {
                e.preventDefault();
                return;
            }
            // Ctrl+C (Copy), Ctrl+V (Paste), Ctrl+X (Cut)
            if (lowKey === 'c' || lowKey === 'v' || lowKey === 'x') {
                e.preventDefault();
                return;
            }
            // Ctrl+A (Select All text/elements)
            if (lowKey === 'a') {
                e.preventDefault();
                clearRogueSelection();
                return;
            }
            // Ctrl+P (Print)
            if (lowKey === 'p') {
                e.preventDefault();
                return;
            }
            // Ctrl+F (Find)
            if (lowKey === 'f') {
                e.preventDefault();
                return;
            }
        }

        // Alt Combinations (e.g. Alt+F, Alt+E, Alt+D, etc.) to prevent menus
        if (e.altKey && key !== 'Alt') {
            e.preventDefault();
            return;
        }

        // Backspace going back in history (older or customized browsers)
        if (key === 'Backspace') {
            e.preventDefault();
            return;
        }
    }, { capture: true });

    // 2. Prevent accidental text selection & non-draggable element drag-selection
    document.addEventListener('selectstart', (e) => {
        const el = getTargetEl(e.target);
        if (!isTextInputEl(el)) {
            e.preventDefault();
        }
    }, { capture: true });

    document.addEventListener('dragstart', (e) => {
        const el = getTargetEl(e.target);
        if (isTextInputEl(el)) return;
        if (el && el.closest('[draggable="true"]')) return;
        e.preventDefault();
    }, { capture: true });

    document.addEventListener('selectionchange', clearRogueSelection);

    // 3. Prevent Alt+Click standard behaviors and clear any non-input text selection
    window.addEventListener('pointerdown', (e) => {
        const el = getTargetEl(e.target);
        if (!isTextInputEl(el)) {
            const sel = window.getSelection?.();
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
                sel.removeAllRanges();
            }
        }
        if (e.altKey) {
            // Prevent default behavior (e.g., Firefox window dragging, text selection)
            // but still allow our pointer handlers to capture coordinates.
            e.preventDefault();
        }
    }, { capture: true });

    // 4. Block Context Menu globally in the drawing workspace and show selection options
    window.addEventListener('contextmenu', (e) => {
        if (isEditingText()) {
            return;
        }
        e.preventDefault();
        if (engine && engine._lassoJustCancelled) {
            return;
        }
        if (engine && (engine.floatingSelection || engine.activeSelectionPath)) {
            showSelectionContextMenu(e, engine);
        }
    }, { capture: true });

    // 4. Overlap/Drag and Drop files default (stops page replacing with dropped image)
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    }, { capture: true });
    
    window.addEventListener('drop', (e) => {
        e.preventDefault();
    }, { capture: true });
}

function showSelectionContextMenu(e, engine) {
    const existingMenu = document.getElementById('selection-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'selection-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.backgroundColor = '#ebebeb';
    menu.style.border = '2px solid black';
    menu.style.padding = '4px';
    menu.style.display = 'flex';
    menu.style.flexDirection = 'column';
    menu.style.gap = '2px';
    menu.style.zIndex = '99999';
    menu.style.boxShadow = '2px 2px 0px 0px black';
    
    // Header
    const header = document.createElement('div');
    header.style.fontSize = '8px';
    header.style.fontFamily = 'monospace';
    header.style.fontWeight = 'bold';
    header.style.padding = '2px 4px';
    header.style.borderBottom = '1px solid black';
    header.style.marginBottom = '2px';
    header.style.color = '#555555';
    header.textContent = 'SELECTION OPTIONS';
    menu.appendChild(header);

    const createBtn = (label, onClick) => {
        const btn = document.createElement('button');
        btn.className = 'brutal-btn';
        btn.textContent = label;
        btn.style.fontSize = '9px';
        btn.style.fontFamily = 'monospace';
        btn.style.fontWeight = 'bold';
        btn.style.textAlign = 'left';
        btn.style.padding = '3px 6px';
        btn.style.cursor = 'pointer';
        btn.style.border = '1px solid black';
        btn.style.backgroundColor = '#ffffff';
        btn.style.color = '#000000';
        btn.style.boxShadow = '1px 1px 0px 0px black';
        btn.style.marginBottom = '1px';
        
        btn.onmouseenter = () => {
            btn.style.backgroundColor = '#ffff00';
        };
        btn.onmouseleave = () => {
            btn.style.backgroundColor = '#ffffff';
        };
        btn.onclick = (event) => {
            event.stopPropagation();
            event.preventDefault();
            onClick();
            menu.remove();
        };
        return btn;
    };

    if (!engine.floatingSelection && engine.activeSelectionPath) {
        menu.appendChild(createBtn('TRANSFORM (MOVE)', () => {
            engine.startTransform();
            engine.transformMode = 'move';
            if (engine._updateSelectionPreview) engine._updateSelectionPreview();
            if (engine.refresh) engine.refresh();
        }));
        menu.appendChild(createBtn('DEFORM (WARP)', () => {
            engine.startTransform();
            engine.transformMode = 'deform';
            if (engine._updateSelectionPreview) engine._updateSelectionPreview();
            if (engine.refresh) engine.refresh();
        }));
    } else if (engine.floatingSelection) {
        const modes = [
            { id: 'move', label: 'TRANSFORM (GIZMO)' },
            { id: 'opacity', label: 'OPACITY' },
            { id: 'deform', label: 'DEFORM' }
        ];
        const activeMode = (!engine.transformMode || engine.transformMode === 'scale' || engine.transformMode === 'rotate')
            ? 'move'
            : engine.transformMode;
        modes.forEach(m => {
            const isSel = m.id === activeMode;
            menu.appendChild(createBtn(isSel ? `[ ${m.label} ]` : m.label, () => {
                engine.transformMode = m.id;
                if (engine._updateSelectionPreview) engine._updateSelectionPreview();
                if (engine.refresh) engine.refresh();
            }));
        });
        
        menu.appendChild(createBtn('MIRROR HORIZON', () => {
            if (engine.toggleFloatingSelectionMirrorX) {
                engine.toggleFloatingSelectionMirrorX();
            }
        }));
        
        const divider = document.createElement('div');
        divider.style.borderTop = '1px solid black';
        divider.style.margin = '2px 0';
        menu.appendChild(divider);
        
        menu.appendChild(createBtn('APPLY & DESELECT', () => {
            if (engine._applySelection) {
                engine._applySelection();
            }
        }));
        
        menu.appendChild(createBtn('DISCARD / CANCEL', () => {
            engine.floatingSelection = null;
            engine.activeSelectionPath = null;
            if (engine._updateSelectionPreview) engine._updateSelectionPreview();
            if (engine.refresh) engine.refresh();
        }));
    }

    document.body.appendChild(menu);

    const dismissMenu = (pe) => {
        if (!menu.contains(pe.target)) {
            menu.remove();
            document.removeEventListener('pointerdown', dismissMenu);
        }
    };
    // Defer adding the event listener so we do not trigger on the same click
    setTimeout(() => {
        document.addEventListener('pointerdown', dismissMenu);
    }, 10);
}
