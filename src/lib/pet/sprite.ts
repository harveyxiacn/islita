// User-supplied desktop-pet sprites. [FRONTEND]
//
// The built-in mascot is original SVG drawn by the panel. A user may replace
// it with one raster image, kept as a data URL in the same local plugin state:
//
//   · a square-ish image is a portrait;
//   · an image within 5% of 4:1 is a four-frame horizontal idle strip. The
//     frames are equal square cells, left to right.
//
// Validation is intentionally DOM-free so import rules and the persisted-state
// parser can be unit-tested. The panel supplies the decoded width and height.
export const MAX_SPRITE_BYTES = 2 * 1024 * 1024;
export const MAX_SPRITE_DATA_URL_LENGTH = Math.ceil((MAX_SPRITE_BYTES * 4) / 3) + 256;
/** Guards against decompression bombs; a 4096px sprite is already generous. */
export const MAX_SPRITE_DIMENSION = 4096;
export const MIN_SPRITE_DIMENSION = 8;
const STRIP_RATIO = 4;
const STRIP_RATIO_TOLERANCE = 0.05;

const MIME_TYPES = new Set(['image/png', 'image/webp', 'image/gif']);
const EXTENSIONS = /\.(?:png|webp|gif)$/i;
const DATA_URL = /^data:image\/(?:png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;

export type SpriteFrameCount = 1 | 4;
export type SpriteFileError =
  | 'empty'
  | 'too-large'
  | 'unsupported-type'
  | 'invalid-dimensions';

export interface SpriteFileMeta {
  name: string;
  type: string;
  size: number;
}

export interface SpriteFileInput extends SpriteFileMeta {
  width: number;
  height: number;
}

/** What the plugin stores for a custom sprite. */
export interface PetSprite {
  dataUrl: string;
  width: number;
  height: number;
  /** 1 = portrait, 4 = horizontal strip. */
  frames: SpriteFrameCount;
  fileName: string;
}

export type SpriteValidation =
  | { ok: true; frames: SpriteFrameCount }
  | { ok: false; error: SpriteFileError };

function normalizedMime(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
}

/** Cheap checks that do not need the image to be decoded. */
export function spriteFileError(file: SpriteFileMeta): SpriteFileError | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return 'empty';
  if (file.size > MAX_SPRITE_BYTES) return 'too-large';
  const mime = normalizedMime(file.type);
  if (mime) {
    if (!MIME_TYPES.has(mime)) return 'unsupported-type';
  } else if (!EXTENSIONS.test(file.name)) {
    // Some pickers omit the MIME type; fall back to the extension.
    return 'unsupported-type';
  }
  return null;
}

/** Classify valid dimensions as a portrait or a four-frame strip. */
export function spriteFrameCount(width: number, height: number): SpriteFrameCount | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_SPRITE_DIMENSION || height < MIN_SPRITE_DIMENSION) return null;
  if (width > MAX_SPRITE_DIMENSION || height > MAX_SPRITE_DIMENSION) return null;
  const ratio = width / height;
  return Math.abs(ratio - STRIP_RATIO) <= STRIP_RATIO_TOLERANCE ? 4 : 1;
}

export function validateSpriteFile(file: SpriteFileInput): SpriteValidation {
  const basic = spriteFileError(file);
  if (basic) return { ok: false, error: basic };
  const frames = spriteFrameCount(file.width, file.height);
  if (frames === null) return { ok: false, error: 'invalid-dimensions' };
  return { ok: true, frames };
}

function fileName(value: unknown): string {
  if (typeof value !== 'string') return 'sprite';
  const name = value.trim().split(/[\\/]/).filter(Boolean).pop() ?? 'sprite';
  return name.slice(0, 80) || 'sprite';
}

function approximateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.floor((payload * 3) / 4) - padding;
}

/**
 * Re-validate a stored sprite. A corrupt or hand-edited localStorage entry
 * falls back to the built-in mascot without throwing. `frames` is derived from
 * the dimensions rather than trusted from disk.
 */
export function parseStoredSprite(raw: unknown): PetSprite | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.dataUrl !== 'string') return null;
  if (value.dataUrl.length > MAX_SPRITE_DATA_URL_LENGTH) return null;
  if (!DATA_URL.test(value.dataUrl) || approximateBytes(value.dataUrl) > MAX_SPRITE_BYTES) {
    return null;
  }
  if (typeof value.width !== 'number' || typeof value.height !== 'number') return null;
  const frames = spriteFrameCount(value.width, value.height);
  if (frames === null) return null;
  return {
    dataUrl: value.dataUrl,
    width: value.width,
    height: value.height,
    frames,
    fileName: fileName(value.fileName),
  };
}
