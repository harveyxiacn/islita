import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PET_POSITION_KEY,
  PET_WINDOW_LABEL,
  PET_WINDOW_SIZE,
  artForMode,
  desktopArt,
  facing,
  filmFacing,
  isPetAction,
  parsePetDesktopPosition,
  shouldSleep,
  type PetDesktopMode,
} from '../src/lib/pet/desktop';

const MODES: PetDesktopMode[] = ['idle', 'walk', 'sleep', 'happy', 'drag'];

test('the window contract matches the Rust constants', () => {
  expect(PET_WINDOW_LABEL).toBe('pet');
  expect(PET_POSITION_KEY).toBe('island.pet.desktop.position');
  const rust = readFileSync(path.join('src-tauri', 'src', 'window', 'pet.rs'), 'utf8');
  expect(rust).toContain(`pub const BASE_W: f64 = ${PET_WINDOW_SIZE.width.toFixed(1)};`);
  expect(rust).toContain(`pub const BASE_H: f64 = ${PET_WINDOW_SIZE.height.toFixed(1)};`);
});

test('every desktop sprite exists for every skin, form and mode', () => {
  for (const skin of ['deepseek', 'hachiware'] as const) {
    const forms = skin === 'deepseek' ? (['chibi', 'transformed'] as const) : (['chibi'] as const);
    for (const form of forms) {
      const art = desktopArt(skin, form);
      expect(art, `${skin}/${form}`).not.toBeNull();
      for (const mode of MODES) {
        const url = artForMode(art, mode);
        expect(url, `${skin}/${form}/${mode}`).toMatch(/^\/pet\/desktop\/[a-z-]+\.webp$/);
        expect(existsSync(path.join('static', url!)), url!).toBe(true);
      }
    }
  }
});

test('the original mascot has no raster set', () => {
  expect(desktopArt('mochi', 'chibi')).toBeNull();
  expect(artForMode(null, 'walk')).toBeNull();
});

test('the transformed and hachiware drag poses reuse their idle frame', () => {
  expect(desktopArt('deepseek', 'transformed')!.drag).toBe(
    '/pet/desktop/deepseek-transformed-idle.webp'
  );
  expect(desktopArt('hachiware', 'chibi')!.drag).toBe('/pet/desktop/hachiware-idle.webp');
  expect(desktopArt('deepseek', 'chibi')!.drag).toBe('/pet/desktop/deepseek-chibi-drag.webp');
});

test('a stored position is validated and rounded', () => {
  expect(parsePetDesktopPosition({ x: 120.4, y: -30.6 })).toEqual({ x: 120, y: -31 });
  expect(parsePetDesktopPosition({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  expect(parsePetDesktopPosition(null)).toBeNull();
  expect(parsePetDesktopPosition('12,34')).toBeNull();
  expect(parsePetDesktopPosition([12, 34])).toBeNull();
  expect(parsePetDesktopPosition({ x: '12', y: 34 })).toBeNull();
  expect(parsePetDesktopPosition({ x: Number.NaN, y: 34 })).toBeNull();
  expect(parsePetDesktopPosition({ x: 1e9, y: 34 })).toBeNull();
});

test('only the four pet actions are accepted from another window', () => {
  for (const action of ['feed', 'play', 'rest', 'pat']) {
    expect(isPetAction(action)).toBe(true);
  }
  for (const bad of ['nap', '', 3, null, { action: 'feed' }]) {
    expect(isPetAction(bad)).toBe(false);
  }
});

test('the pet naps when exhausted or after a long quiet stretch', () => {
  const threeMinutes = 180_000;
  expect(shouldSleep(80, threeMinutes, false)).toBe(true);
  expect(shouldSleep(10, 0, false)).toBe(true);
  expect(shouldSleep(80, 0, false)).toBe(false);
  // the pointer or an open menu keeps it awake
  expect(shouldSleep(80, threeMinutes, true)).toBe(false);
  expect(shouldSleep(10, threeMinutes, true)).toBe(false);
  expect(shouldSleep(80, threeMinutes, false, 60_000)).toBe(true);
  expect(shouldSleep(80, 59_000, false, 60_000)).toBe(false);
});

test('facing is the movement direction used by directional packs', () => {
  expect(facing(-1)).toBe(-1);
  expect(facing(-42)).toBe(-1);
  expect(facing(0)).toBe(1);
  expect(facing(1)).toBe(1);
});

test('filmFacing mirrors only a rightward walk because H3 draws the fish facing left', () => {
  expect(filmFacing(-1)).toBe(1);
  expect(filmFacing(-42)).toBe(1);
  expect(filmFacing(0)).toBe(1);
  expect(filmFacing(1)).toBe(-1);
});
