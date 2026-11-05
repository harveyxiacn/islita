import { test, expect } from '@playwright/test';
import {
  PET_THEME_IDS,
  PET_THEME_OPTIONS,
  isPetThemeId,
  resolvePetTheme,
  themeForSkin,
} from '../src/lib/pet/themes';

test('each bundled skin has its own default scene', () => {
  expect(themeForSkin('mochi')).toBe('matcha');
  expect(themeForSkin('deepseek')).toBe('abyss');
  expect(themeForSkin('hachiware')).toBe('aquarium');
});

test('an explicit scene wins over the skin default', () => {
  for (const skin of ['mochi', 'deepseek', 'hachiware'] as const) {
    for (const theme of PET_THEME_IDS) {
      expect(resolvePetTheme(skin, theme)).toBe(theme);
    }
    expect(resolvePetTheme(skin, 'auto')).toBe(themeForSkin(skin));
  }
});

test('the picker offers Auto plus every drawn scene exactly once', () => {
  expect(PET_THEME_OPTIONS.map((option) => option.id)).toEqual(['auto', ...PET_THEME_IDS]);
  expect(new Set(PET_THEME_OPTIONS.map((option) => option.label)).size).toBe(
    PET_THEME_OPTIONS.length
  );
  for (const option of PET_THEME_OPTIONS) {
    expect(option.label).toBeTruthy();
    expect(option.hint).toBeTruthy();
  }
});

test('only drawn scenes are valid concrete theme ids', () => {
  for (const id of PET_THEME_IDS) expect(isPetThemeId(id)).toBe(true);
  for (const id of ['auto', 'neon', 'MATCHA', '', null, 1]) expect(isPetThemeId(id)).toBe(false);
});
