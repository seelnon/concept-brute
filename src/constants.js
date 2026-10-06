export const CHUNK_SIZE = 512;
export const SECTOR_SIZE = 8; // 8x8 chunks per sector
export const MAX_CHUNKS = 64; // 64 * 1024 = 65536px
export const LAYERS_COUNT = 4; // 3 Draw + 1 Image
export const STORAGE_KEY = 'BRUT_SKETCH_DATA';

export const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  WIREFRAME: 'wireframe',
  LASSO: 'lasso',
  PICKER: 'picker',
  SMUDGE: 'smudge',
  REF_MOVE: 'ref_move',
  EXPORT: 'export',
  LIQUIFY: 'liquify',
  DEFORM: 'deform',
  FLUID: 'fluid',
  AIR: 'air_paint'
};
