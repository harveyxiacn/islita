// Detached desktop pet: pure mappings and validators. [FRONTEND]
//
// The pet window (`/pet`) and the island's pet panel share the state schema in
// `./pet`. This module only knows which sprite belongs to a skin/form/mode and
// how to repair the small position record kept in the pet window's own
// localStorage. Keeping it DOM-free makes both testable.
import type { DeepSeekForm, PetAction, PetSkin } from './pet';

/** Label of the predefined window in `tauri.conf.json`. */
export const PET_WINDOW_LABEL = 'pet';
/** localStorage key for the last logical top-left of the pet window. */
export const PET_POSITION_KEY = 'island.pet.desktop.position';
/** Logical size at `settings.scale = 1`; must match `window/pet.rs`. */
export const PET_WINDOW_SIZE = { width: 240, height: 300 } as const;

export type PetDesktopMode = 'idle' | 'walk' | 'sleep' | 'happy' | 'drag';

export interface PetDesktopArt {
  idle: string;
  walk: string;
  sleep: string;
  happy: string;
  drag: string;
}

function deepseek(form: DeepSeekForm): PetDesktopArt {
  const prefix = form === 'transformed' ? 'deepseek-transformed' : 'deepseek-chibi';
  return {
    idle: `/pet/desktop/${prefix}-idle.webp`,
    walk: `/pet/desktop/${prefix}-walk.webp`,
    sleep: `/pet/desktop/${prefix}-sleep.webp`,
    happy: `/pet/desktop/${prefix}-happy.webp`,
    // The transformed form has no separate dangling pose; its idle frame
    // reads fine under the dangle animation.
    drag:
      form === 'transformed'
        ? `/pet/desktop/${prefix}-idle.webp`
        : `/pet/desktop/${prefix}-drag.webp`,
  };
}

/**
 * Full-body frames for the detached pet. `mochi` is an inline SVG and has no
 * raster set, so callers fall back to the mascot component.
 */
export function desktopArt(skin: PetSkin, form: DeepSeekForm): PetDesktopArt | null {
  if (skin === 'deepseek') return deepseek(form);
  if (skin === 'hachiware') {
    return {
      idle: '/pet/desktop/hachiware-idle.webp',
      walk: '/pet/desktop/hachiware-walk.webp',
      sleep: '/pet/desktop/hachiware-sleep.webp',
      happy: '/pet/desktop/hachiware-happy.webp',
      drag: '/pet/desktop/hachiware-idle.webp',
    };
  }
  return null;
}

export function artForMode(art: PetDesktopArt | null, mode: PetDesktopMode): string | null {
  if (!art) return null;
  return art[mode];
}

export interface PetDesktopPosition {
  x: number;
  y: number;
}

/** Payload of the backend's `pet-motion` event. */
export interface PetMotion {
  moving: boolean;
  dir: number;
  falling: boolean;
  x: number;
  y: number;
}

/** Parse the last window position; invalid values are simply absent. */
export function parsePetDesktopPosition(raw: unknown): PetDesktopPosition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const x = value.x;
  const y = value.y;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

const ACTIONS = new Set<PetAction>(['feed', 'play', 'rest', 'pat']);

export function isPetAction(raw: unknown): raw is PetAction {
  return typeof raw === 'string' && ACTIONS.has(raw as PetAction);
}

/**
 * Should the page put the pet to sleep? It naps when it is exhausted or after
 * a long quiet stretch, but not while the pointer is on it or a menu is open.
 */
export function shouldSleep(
  energy: number,
  idleMs: number,
  busy: boolean,
  idleAfterMs = 180_000
): boolean {
  if (busy) return false;
  return energy < 22 || idleMs >= idleAfterMs;
}

/** Which way the sprite faces: `-1` flips it to walk left. */
export function facing(dir: number): -1 | 1 {
  return dir < 0 ? -1 : 1;
}
