import {
  captureLayerSnapshot,
  restoreBackupToLayer,
  releaseBackupCanvas
} from './backupPool.js';
import { stopSumiSimLoop } from '../tools/sumiPaint.js';

export function _disposeAction(action) {
  if (!action) return;
  if (action.chunks) {
      action.chunks.forEach(data => {
          if (data && data.canvas) {
              releaseBackupCanvas(this, data);
              data.canvas = null;
              data.ctx = null;
          }
      });
      action.chunks.clear();
  }
  if (action.sumiPassive) {
      action.sumiPassive.clear();
      action.sumiPassive = null;
  }
  if (action.selection && action.selection.canvas) {
      if (this && this.floatingSelection && (action.selection === this.floatingSelection || action.selection.canvas === this.floatingSelection.canvas)) {
          // Do not destroy the canvas as it is currently being used by the active floatingSelection!
      } else {
          action.selection.canvas.width = 1;
          action.selection.canvas.height = 1;
          action.selection.canvas = null;
      }
  }
}

export function _pushHistory(action) {
  this.history.push(action);
  // Track 30 actions to conserve IndexDB storage
  if (this.history.length > 30) {
      const oldest = this.history.shift();
      this._disposeAction(oldest);
  }
  if (action && action.type === 'stroke' && this.app && this.app.recorder) {
      this.app.recorder.onStrokeCommitted();
  }
}

export function _clearStack(stack) {
  if (!stack) return;
  while (stack.length > 0) {
      this._disposeAction(stack.pop());
  }
}

export function compact() {
  // Clear redo stack on save to free up memory
  this._clearStack(this.redoStack);
}

export function undo() {
  // Handle nested/transform-only history first if there's an active floating selection
  if (this.floatingSelection) {
      if (this.transformHistory && this.transformHistory.length > 0) {
          const adj = this.transformHistory.pop();
          if (!this.transformRedoHistory) this.transformRedoHistory = [];
          this.transformRedoHistory.push(adj);
          this.restoreFloatingSelectionState(adj.before);
          this._status('UNDO ADJUSTMENT');
          if (this.onDrawEnd) this.onDrawEnd();
          return;
      }
  }

  if (this.history.length === 0) return;

  const peekAction = this.history[this.history.length - 1];
  const isSumiAction = !!(peekAction && peekAction.isSumiStroke);
  const sumiSolver = this.gpuRenderer?.sumiSolver;

  if (isSumiAction) {
      stopSumiSimLoop();
      if (this.flushPendingGpuCommits) this.flushPendingGpuCommits({ keepSumiSession: true });
      if (sumiSolver && sumiSolver.active && sumiSolver.hasCpuDirtyTiles()) {
          sumiSolver.syncTilesToCanvas2D(this, sumiSolver.lastParams || {}, peekAction.chunks || null);
      }
  } else {
      if (this.flushPendingGpuCommits) this.flushPendingGpuCommits();
  }
  if (this.invalidateLiquifySession) this.invalidateLiquifySession();

  const action = this.history.pop();
  if (action && action.type === 'stroke' && this.app && this.app.recorder) {
      this.app.recorder.onUndoCommitted();
  }
  let redoAction;

  if (action.type === 'reference_change') {
      redoAction = {
          type: 'reference_change',
          referenceImagesState: this.captureReferenceImagesState()
      };
      this.restoreReferenceImagesState(action.referenceImagesState);
  } else {
      redoAction = {
          type: action.type,
          chunks: new Map(),
          path: this.activeSelectionPath ? [...this.activeSelectionPath] : null,
          selection: this.floatingSelection ? { ...this.floatingSelection } : null
      };

      if (action.isSumiStroke && sumiSolver) {
          redoAction.isSumiStroke = true;
          redoAction.sumiLayer = action.sumiLayer;
          redoAction.sumiProjId = action.sumiProjId;
          redoAction.sumiPassive = sumiSolver.capturePassiveAfterForAction
              ? sumiSolver.capturePassiveAfterForAction(this, action)
              : null;
          if (sumiSolver.active) {
              sumiSolver.cancel(this, false);
          }
      }

      // Restore chunks
      if (action.chunks) {
          action.chunks.forEach((data, id) => {
              const chunk = this.chunks.get(id);
              if (chunk) {
                  const redoBackup = captureLayerSnapshot(this, chunk, data.layer);
                  redoAction.chunks.set(id, redoBackup);
                  restoreBackupToLayer(this, chunk, id, data);
              }
          });
      }

      if (action.isSumiStroke && action.sumiPassive && sumiSolver?.restorePassiveSnapshot) {
          sumiSolver.restorePassiveSnapshot(this, action.sumiPassive, action.sumiLayer);
      }

      // Restore Selection/Transform state
      if (action.type === 'selection') {
          this.activeSelectionPath = action.path;
      } else if (action.type === 'transform') {
          this.floatingSelection = null;
          this.activeSelectionPath = action.path;
      } else if (action.type === 'stroke') {
          if (action.selection) this.floatingSelection = action.selection;
      }

      // Dispose action containing selection only after restoring it to this.floatingSelection
      if (action.chunks || action.sumiPassive) {
          this._disposeAction(action);
      }
  }

  this.redoStack.push(redoAction);
  this._updateSelectionPreview();
  this.refresh();
  this._status('UNDO');
  if (this.onDrawEnd) this.onDrawEnd();
}

export function redo() {
  // Handle nested/transform-only redo first if there's an active floating selection
  if (this.floatingSelection) {
      if (this.transformRedoHistory && this.transformRedoHistory.length > 0) {
          const adj = this.transformRedoHistory.pop();
          if (!this.transformHistory) this.transformHistory = [];
          this.transformHistory.push(adj);
          this.restoreFloatingSelectionState(adj.after);
          this._status('REDO ADJUSTMENT');
          if (this.onDrawEnd) this.onDrawEnd();
          return;
      }
  }

  if (this.redoStack.length === 0) return;

  const peekAction = this.redoStack[this.redoStack.length - 1];
  const isSumiAction = !!(peekAction && peekAction.isSumiStroke);
  const sumiSolver = this.gpuRenderer?.sumiSolver;

  if (isSumiAction) {
      stopSumiSimLoop();
      if (this.flushPendingGpuCommits) this.flushPendingGpuCommits({ keepSumiSession: true });
      if (sumiSolver && sumiSolver.active) {
          // Commit any unrelated live Sumi work before restoring a future Sumi snapshot
          sumiSolver.commitToChunks(this, sumiSolver.lastParams || {}, true);
      }
  } else {
      if (this.flushPendingGpuCommits) this.flushPendingGpuCommits();
  }
  if (this.invalidateLiquifySession) this.invalidateLiquifySession();

  const action = this.redoStack.pop();
  if (action && action.type === 'stroke' && this.app && this.app.recorder) {
      this.app.recorder.onRedoCommitted();
  }
  let undoAction;

  if (action.type === 'reference_change') {
      undoAction = {
          type: 'reference_change',
          referenceImagesState: this.captureReferenceImagesState()
      };
      this.restoreReferenceImagesState(action.referenceImagesState);
  } else {
      undoAction = {
          type: action.type,
          chunks: new Map(),
          path: this.activeSelectionPath ? [...this.activeSelectionPath] : null,
          selection: this.floatingSelection ? { ...this.floatingSelection } : null
      };

      if (action.isSumiStroke && sumiSolver) {
          undoAction.isSumiStroke = true;
          undoAction.sumiLayer = action.sumiLayer;
          undoAction.sumiProjId = action.sumiProjId;
          undoAction.sumiPassive = sumiSolver.capturePassiveAfterForAction
              ? sumiSolver.capturePassiveAfterForAction(this, action)
              : null;
      }

      if (action.chunks) {
          action.chunks.forEach((data, id) => {
              const chunk = this.chunks.get(id);
              if (chunk) {
                  const undoBackup = captureLayerSnapshot(this, chunk, data.layer);
                  undoAction.chunks.set(id, undoBackup);
                  restoreBackupToLayer(this, chunk, id, data);
              }
          });
      }

      if (action.isSumiStroke && action.sumiPassive && sumiSolver?.restorePassiveSnapshot) {
          sumiSolver.restorePassiveSnapshot(this, action.sumiPassive, action.sumiLayer);
      }

      if (action.type === 'selection') {
          this.activeSelectionPath = action.path;
      } else if (action.type === 'transform') {
          this.floatingSelection = action.selection;
          this.activeSelectionPath = null;
      } else if (action.type === 'stroke') {
          if (action.selection) this.floatingSelection = null; // Re-applying stroke clears the "source" floating selection
      }

      this._disposeAction(action);
  }

  this._pushHistory(undoAction);
  this._updateSelectionPreview();
  this.refresh();
  this._status('REDO');
  if (this.onDrawEnd) this.onDrawEnd();
}

// -------------------------------------------------------------
// NESTED SELECTION TRANSFORM STATE HELPERS
// -------------------------------------------------------------

export function captureFloatingSelectionState() {
  if (!this.floatingSelection) return null;
  const sel = this.floatingSelection;
  return {
    x: sel.x,
    y: sel.y,
    scale: sel.scale !== undefined ? sel.scale : 1,
    scaleX: sel.scaleX !== undefined ? sel.scaleX : (sel.scale ?? 1),
    scaleY: sel.scaleY !== undefined ? sel.scaleY : (sel.scale ?? 1),
    rotation: sel.rotation || 0,
    opacity: sel.opacity !== undefined ? sel.opacity : 1,
    mirrorX: !!sel.mirrorX,
    mirrorY: !!sel.mirrorY,
    pins: sel.pins ? sel.pins.map(p => ({ ...p })) : null
  };
}

export function restoreFloatingSelectionState(state) {
  if (!this.floatingSelection || !state) return;
  const sel = this.floatingSelection;
  sel.x = state.x;
  sel.y = state.y;
  sel.scale = state.scale;
  sel.scaleX = state.scaleX;
  sel.scaleY = state.scaleY;
  sel.rotation = state.rotation;
  sel.opacity = state.opacity;
  sel.mirrorX = state.mirrorX;
  sel.mirrorY = state.mirrorY;
  if (state.pins) {
    sel.pins = state.pins.map(p => ({ ...p }));
  } else {
    sel.pins = null;
  }
  
  if (this.warpSelectionImage) {
      this.warpSelectionImage(this);
  }
  this._updateSelectionPreview();
  this.refresh();
}

export function recordTransformAdjustment(actionFn) {
  if (!this.floatingSelection) {
      actionFn();
      return;
  }
  const before = this.captureFloatingSelectionState();
  actionFn();
  const after = this.captureFloatingSelectionState();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
      if (!this.transformHistory) this.transformHistory = [];
      this.transformHistory.push({ before, after });
      this.transformRedoHistory = []; 
  }
}

export function toggleFloatingSelectionMirrorX() {
  if (!this.floatingSelection) return;
  this.recordTransformAdjustment(() => {
      this.floatingSelection.mirrorX = !this.floatingSelection.mirrorX;
  });
  this.refresh();
}

// -------------------------------------------------------------
// HISTORY STORAGE CACHE / INDEXDB SERIALIZATION
// -------------------------------------------------------------

function canvasToDataURLAsync(canvas, type = 'image/png', quality) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let settled = false;
    const fallbackUrl = () => {
      try {
        return canvas.toDataURL(type, quality);
      } catch (e) {
        return '';
      }
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => done(fallbackUrl()), 10000);
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        if (!blob) {
          done(fallbackUrl());
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => done(reader.result || '');
        reader.onerror = () => done(fallbackUrl());
        reader.readAsDataURL(blob);
      }, type, quality);
    } catch (e) {
      done(fallbackUrl());
    }
  });
}

async function serializeHistoryState(historyArray) {
  if (!historyArray) return [];
  const serialized = [];
  for (const action of historyArray) {
    const act = {
      type: action.type,
      path: action.path ? JSON.parse(JSON.stringify(action.path)) : null,
      zoom: action.zoom,
      pan: action.pan ? { ...action.pan } : null,
    };

    if (action.referenceImagesState) {
      act.referenceImagesState = action.referenceImagesState.map(ref => ({
        id: ref.id,
        name: ref.name,
        img: { 
          src: ref.img ? (ref.img.src || ref.img) : '', 
          width: ref.img ? (ref.img.width || 100) : 100, 
          height: ref.img ? (ref.img.height || 100) : 100 
        },
        x: ref.x,
        y: ref.y,
        rotation: ref.rotation,
        scale: ref.scale,
        opacity: ref.opacity,
        mirrorX: ref.mirrorX,
        mirrorY: ref.mirrorY,
        extractedPalette: ref.extractedPalette ? [...ref.extractedPalette] : null
      }));
    }

    if (action.chunks) {
      const chunkEntries = Array.from(action.chunks.entries());
      const chunksArr = await Promise.all(chunkEntries.map(async ([chunkId, data]) => {
        const isWasEmpty = !!(data.wasEmpty || !data.canvas);
        const dataUrl = (!isWasEmpty && data.canvas) ? await canvasToDataURLAsync(data.canvas, 'image/png') : null;
        return {
          chunkId,
          layer: data.layer,
          wasEmpty: isWasEmpty,
          dataUrl,
          width: data.canvas ? data.canvas.width : (data.width || 1024),
          height: data.canvas ? data.canvas.height : (data.height || 1024)
        };
      }));
      act.chunks = chunksArr;
    }

    if (action.selection) {
      const canvasDataUrl = action.selection.canvas ? await canvasToDataURLAsync(action.selection.canvas, 'image/png') : null;
      act.selection = {
        x: action.selection.x,
        y: action.selection.y,
        width: action.selection.width,
        height: action.selection.height,
        scale: action.selection.scale,
        scaleX: action.selection.scaleX,
        scaleY: action.selection.scaleY,
        rotation: action.selection.rotation,
        opacity: action.selection.opacity,
        mirrorX: action.selection.mirrorX,
        mirrorY: action.selection.mirrorY,
        canvasDataUrl: canvasDataUrl
      };
    }

    serialized.push(act);
  }
  return serialized;
}

async function deserializeHistoryState(serializedArray) {
  if (!serializedArray || !Array.isArray(serializedArray)) return [];
  const deserialized = await Promise.all(serializedArray.map(async (act) => {
    const action = {
      type: act.type,
      path: act.path ? JSON.parse(JSON.stringify(act.path)) : null,
      zoom: act.zoom,
      pan: act.pan ? { ...act.pan } : null,
    };

    if (act.referenceImagesState) {
      action.referenceImagesState = act.referenceImagesState.map(ref => {
        const img = new Image();
        img.src = ref.img ? (ref.img.src || '') : '';
        img.width = ref.img ? (ref.img.width || 100) : 100;
        img.height = ref.img ? (ref.img.height || 100) : 100;
        return {
          id: ref.id,
          name: ref.name,
          img: img,
          x: ref.x,
          y: ref.y,
          rotation: ref.rotation,
          scale: ref.scale,
          opacity: ref.opacity,
          mirrorX: ref.mirrorX,
          mirrorY: ref.mirrorY,
          extractedPalette: ref.extractedPalette ? [...ref.extractedPalette] : null
        };
      });
    }

    if (act.chunks) {
      const chunksMap = new Map();
      await Promise.all(act.chunks.map(async (chunkItem) => {
        if (chunkItem.wasEmpty || !chunkItem.dataUrl) {
          chunksMap.set(chunkItem.chunkId, {
            layer: chunkItem.layer,
            canvas: null,
            wasEmpty: true,
            width: chunkItem.width || 1024,
            height: chunkItem.height || 1024
          });
          return;
        }
        const cv = document.createElement('canvas');
        cv.width = chunkItem.width;
        cv.height = chunkItem.height;
        const ctx = cv.getContext('2d');
        const img = new Image();
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => { img.src = ''; finish(); }, 10000);
          img.onload = img.onerror = finish;
          img.src = chunkItem.dataUrl;
        });
        if (img.width > 0) {
          ctx.drawImage(img, 0, 0);
        }
        chunksMap.set(chunkItem.chunkId, {
          layer: chunkItem.layer,
          canvas: cv,
          wasEmpty: false,
          width: cv.width,
          height: cv.height
        });
      }));
      action.chunks = chunksMap;
    }

    if (act.selection) {
      const cv = document.createElement('canvas');
      cv.width = act.selection.width || 100;
      cv.height = act.selection.height || 100;
      const ctx = cv.getContext('2d');
      if (act.selection.canvasDataUrl) {
        const img = new Image();
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => { img.src = ''; finish(); }, 10000);
          img.onload = img.onerror = finish;
          img.src = act.selection.canvasDataUrl;
        });
        if (img.width > 0) {
          ctx.drawImage(img, 0, 0);
        }
      }
      action.selection = {
        ...act.selection,
        canvas: cv
      };
    }

    return action;
  }));
  return deserialized;
}

export async function saveHistoryStackToStorage(explicitProjectId = null) {
  if (!this.storage) return;

  try {
    const projKey = explicitProjectId || this.currentProjectId || '_default';
    if (!this.history || this.history.length === 0) {
      if (this._lastSavedHistoryAction === null && this._lastSavedHistoryProjId === projKey && this._lastSavedHistoryLen === 0) {
        return;
      }
      await this.storage.saveSetting('historyStack', [], explicitProjectId);
      await this.storage.saveSetting('redoStack', [], explicitProjectId);
      this._lastSavedHistoryAction = null;
      this._lastSavedHistoryProjId = projKey;
      this._lastSavedHistoryLen = 0;
      return;
    }

    const lastAction = this.history[this.history.length - 1];
    if (
      this._lastSavedHistoryAction === lastAction &&
      this._lastSavedHistoryProjId === projKey &&
      this._lastSavedHistoryLen === this.history.length
    ) {
      return;
    }

    // Only serialize the last 1 action for storage persistence to prevent massive project-switching lags!
    const historyToSave = [lastAction];
    const serializedHistory = await serializeHistoryState(historyToSave);
    const serializedRedo = [];

    await this.storage.saveSetting('historyStack', serializedHistory, explicitProjectId);
    await this.storage.saveSetting('redoStack', serializedRedo, explicitProjectId);
    this._lastSavedHistoryAction = lastAction;
    this._lastSavedHistoryProjId = projKey;
    this._lastSavedHistoryLen = this.history.length;
  } catch (err) {
    console.warn('Failed to save history stacks to storage:', err);
  }
}

export async function loadHistoryStackFromStorage(explicitProjectId = null) {
  if (!this.storage) return;

  try {
    const serializedHistory = await this.storage.loadSetting('historyStack', explicitProjectId);
    const serializedRedo = await this.storage.loadSetting('redoStack', explicitProjectId);

    if (serializedHistory && Array.isArray(serializedHistory) && serializedHistory.length > 0) {
      this._clearStack(this.history);
      this.history = await deserializeHistoryState(serializedHistory);
    } else {
      this._clearStack(this.history);
      this.history = [];
    }

    if (serializedRedo && Array.isArray(serializedRedo) && serializedRedo.length > 0) {
      this._clearStack(this.redoStack);
      this.redoStack = await deserializeHistoryState(serializedRedo);
    } else {
      this._clearStack(this.redoStack);
      this.redoStack = [];
    }
  } catch (err) {
    console.warn('Failed to load history stacks from storage:', err);
  }
}
