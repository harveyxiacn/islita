import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DEEPSEEK_FORMS,
  OFFLINE_DECAY_CAP_MS,
  PET_DEFAULT_DEEPSEEK_FORM,
  PET_SKINS,
  advancePet,
  applyAction,
  createDefaultPet,
  grantXp,
  isDeepSeekForm,
  isPetSkin,
  parsePetState,
  petStatus,
  sanitizeName,
  xpForNextLevel,
} from '../src/lib/pet/pet';
import { PET_SKIN_OPTIONS, skinImage } from '../src/lib/pet/skins';
import {
  MAX_SPRITE_BYTES,
  MAX_SPRITE_DATA_URL_LENGTH,
  MAX_SPRITE_DIMENSION,
  parseStoredSprite,
  spriteFileError,
  spriteFrameCount,
  validateSpriteFile,
} from '../src/lib/pet/sprite';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3G0QAAAABJRU5ErkJggg==';
const HOUR = 3_600_000;

test('a fresh pet starts happy, named Mochi, with a clean level', () => {
  const pet = createDefaultPet(1_000);
  expect(pet).toMatchObject({
    version: 1,
    name: 'Mochi',
    level: 1,
    xp: 0,
    skin: 'mochi',
    deepseekForm: 'chibi',
    lastSeen: 1_000,
  });
  expect(pet.sprite).toBeNull();
  expect(petStatus(pet)).toBe('happy');
});

test('bundled skins map every mood to an existing asset', () => {
  expect(PET_SKIN_OPTIONS.map((option) => option.id)).toEqual([...PET_SKINS]);
  expect(isPetSkin('deepseek')).toBe(true);
  expect(isPetSkin('hachiware')).toBe(true);
  expect(isPetSkin('mochi')).toBe(true);
  expect(isPetSkin('dragon')).toBe(false);
  expect(isPetSkin(null)).toBe(false);
  expect(createDefaultPet(0, 'hachiware').skin).toBe('hachiware');
  expect(PET_DEFAULT_DEEPSEEK_FORM).toBe('chibi');
  expect(isDeepSeekForm('transformed')).toBe(true);
  expect(isDeepSeekForm('giant')).toBe(false);
  expect(skinImage('mochi', 'chibi', 'happy')).toBeNull();

  const moods = [
    'happy',
    'ok',
    'hungry',
    'tired',
    'bored',
    'feed',
    'play',
    'rest',
    'pat',
    'offline',
  ] as const;
  for (const skin of ['deepseek', 'hachiware'] as const) {
    for (const form of DEEPSEEK_FORMS) {
      for (const mood of moods) {
        const asset = skinImage(skin, form, mood);
        expect(asset, `${skin}/${form}/${mood}`).toMatch(/^\/pet\/[a-z-]+\.webp$/);
        expect(existsSync(path.join('static', asset!)), asset!).toBe(true);
      }
    }
  }
  expect(skinImage('hachiware', 'chibi', 'pat')).toBe('/pet/hachiware-pat.webp');
  expect(skinImage('deepseek', 'chibi', 'feed')).toBe('/pet/deepseek-chibi-feed.webp');
  expect(skinImage('deepseek', 'transformed', 'happy')).toBe(
    '/pet/deepseek-transformed-happy.webp'
  );
});

test('needs decay per elapsed hour and lastSeen advances', () => {
  const pet = { ...createDefaultPet(1_000), fullness: 100, mood: 100, energy: 100 };
  const result = advancePet(pet, 1_000 + HOUR);
  expect(result.appliedMs).toBe(HOUR);
  expect(result.elapsedMs).toBe(HOUR);
  expect(result.state.fullness).toBeCloseTo(94, 5);
  expect(result.state.mood).toBeCloseTo(97, 5);
  expect(result.state.energy).toBeCloseTo(96, 5);
  expect(result.state.lastSeen).toBe(1_000 + HOUR);
});

test('offline decay is capped instead of wiping a pet after days away', () => {
  const pet = { ...createDefaultPet(1_000), fullness: 100, mood: 100, energy: 100 };
  const result = advancePet(pet, 1_000 + 48 * HOUR);
  expect(result.elapsedMs).toBe(48 * HOUR);
  expect(result.appliedMs).toBe(OFFLINE_DECAY_CAP_MS);
  const cappedHours = OFFLINE_DECAY_CAP_MS / HOUR;
  expect(result.state.fullness).toBeCloseTo(100 - 6 * cappedHours, 5);
  expect(result.state.mood).toBeCloseTo(100 - 3 * cappedHours, 5);
  expect(result.state.energy).toBeCloseTo(100 - 4 * cappedHours, 5);
  // A clock that moved backwards must not restore needs.
  const backwards = advancePet({ ...pet, lastSeen: 2_000 }, 1_000);
  expect(backwards.elapsedMs).toBe(0);
  expect(backwards.state.fullness).toBe(100);
});

test('actions clamp needs and grant XP', () => {
  const pet = {
    ...createDefaultPet(0),
    xp: 0,
    fullness: 95,
    mood: 99,
    energy: 20,
    lastSeen: 0,
  };
  const result = applyAction(pet, 'feed', 500);
  expect(result.state.fullness).toBe(100);
  expect(result.state.mood).toBe(100);
  expect(result.state.energy).toBe(19);
  expect(result.state.xp).toBe(8);
  expect(result.state.lastSeen).toBe(500);

  const play = applyAction({ ...pet, energy: 3 }, 'play', 0);
  expect(play.state.energy).toBe(0);
  expect(play.state.mood).toBe(100);
  expect(play.state.fullness).toBe(91);
});

test('level thresholds carry XP through multiple levels', () => {
  expect(xpForNextLevel(1)).toBe(80);
  expect(xpForNextLevel(2)).toBe(120);
  expect(xpForNextLevel(3)).toBe(160);
  expect(grantXp(1, 76, 4)).toEqual({ level: 2, xp: 0, leveledUp: true });
  expect(grantXp(1, 0, 80 + 120 + 5)).toEqual({ level: 3, xp: 5, leveledUp: true });
  expect(grantXp(2, 5, 5)).toEqual({ level: 2, xp: 10, leveledUp: false });
});

test('status priorities are hungry, tired, bored, happy, then ok', () => {
  expect(petStatus({ fullness: 29, mood: 100, energy: 100 })).toBe('hungry');
  expect(petStatus({ fullness: 100, mood: 100, energy: 29 })).toBe('tired');
  expect(petStatus({ fullness: 100, mood: 39, energy: 100 })).toBe('bored');
  expect(petStatus({ fullness: 100, mood: 100, energy: 100 })).toBe('happy');
  expect(petStatus({ fullness: 69, mood: 100, energy: 100 })).toBe('ok');
});

test('corrupt state is repaired field by field and never throws', () => {
  const now = 10_000;
  for (const raw of [null, 'nope', 42, [], {}]) {
    const pet = parsePetState(raw, now);
    expect(pet.name).toBe('Mochi');
    expect(pet.level).toBe(1);
    expect(pet.lastSeen).toBe(now);
  }
  const repaired = parsePetState(
    {
      name: '   tiny    sprout   ',
      level: -4,
      xp: 99_999,
      fullness: 900,
      mood: -10,
      energy: Number.NaN,
      skin: 'dragon',
      deepseekForm: 'giant',
      lastSeen: now + 60_000,
      sprite: { dataUrl: 'javascript:alert(1)' },
    },
    now
  );
  expect(repaired.name).toBe('tiny sprout');
  expect(repaired.level).toBe(1);
  expect(repaired.xp).toBe(xpForNextLevel(1) - 1);
  expect(repaired.fullness).toBe(100);
  expect(repaired.mood).toBe(0);
  expect(repaired.energy).toBe(70);
  expect(repaired.skin).toBe('mochi');
  expect(repaired.deepseekForm).toBe('chibi');
  expect(repaired.lastSeen).toBe(now);
  expect(repaired.sprite).toBeNull();
  expect(sanitizeName('x'.repeat(60))).toHaveLength(20);
  expect(sanitizeName('   ')).toBe('Mochi');
});

test('valid state and its stored sprite survive a round trip', () => {
  const now = 50_000_000;
  const sprite = parseStoredSprite({
    dataUrl: PNG,
    width: 1024,
    height: 256,
    frames: 4,
    fileName: '/tmp/my-pet.png',
  });
  expect(sprite).toEqual({
    dataUrl: PNG,
    width: 1024,
    height: 256,
    frames: 4,
    fileName: 'my-pet.png',
  });
  const pet = parsePetState(
    {
      name: 'Pip',
      level: 3,
      xp: 12,
      fullness: 55,
      mood: 66,
      energy: 77,
      skin: 'deepseek',
      deepseekForm: 'transformed',
      lastSeen: now - HOUR,
      sprite,
    },
    now
  );
  expect(pet).toMatchObject({
    name: 'Pip',
    level: 3,
    xp: 12,
    fullness: 55,
    mood: 66,
    energy: 77,
    skin: 'deepseek',
    deepseekForm: 'transformed',
    lastSeen: now - HOUR,
    sprite,
  });
});

test('a single portrait and a 4:1 strip are classified; invalid dimensions are rejected', () => {
  expect(spriteFrameCount(512, 512)).toBe(1);
  expect(spriteFrameCount(300, 400)).toBe(1);
  expect(spriteFrameCount(1024, 256)).toBe(4);
  expect(spriteFrameCount(1000, 251)).toBe(4);
  expect(spriteFrameCount(0, 256)).toBeNull();
  expect(spriteFrameCount(Number.NaN, 256)).toBeNull();
  expect(spriteFrameCount(MAX_SPRITE_DIMENSION + 1, 256)).toBeNull();
  expect(spriteFrameCount(1024.5, 256)).toBeNull();
});

test('import rejects oversized, empty, unsupported and undecodable files', () => {
  const file = {
    name: 'mochi.png',
    type: 'image/png',
    size: 1000,
    width: 256,
    height: 256,
  };
  expect(validateSpriteFile(file)).toEqual({ ok: true, frames: 1 });
  expect(validateSpriteFile({ ...file, width: 1024, height: 256 })).toEqual({
    ok: true,
    frames: 4,
  });
  expect(validateSpriteFile({ ...file, size: MAX_SPRITE_BYTES + 1 })).toEqual({
    ok: false,
    error: 'too-large',
  });
  expect(validateSpriteFile({ ...file, size: 0 })).toEqual({ ok: false, error: 'empty' });
  expect(validateSpriteFile({ ...file, type: 'image/svg+xml' })).toEqual({
    ok: false,
    error: 'unsupported-type',
  });
  expect(validateSpriteFile({ ...file, width: 0 })).toEqual({
    ok: false,
    error: 'invalid-dimensions',
  });
  expect(
    spriteFileError({ name: 'notes.txt', type: '', size: 100 })
  ).toBe('unsupported-type');
  expect(spriteFileError({ name: 'PET.WEBP', type: '', size: 100 })).toBeNull();
});

test('stored sprites are re-validated and frame count is derived, not trusted', () => {
  const base = {
    dataUrl: PNG,
    width: 1024,
    height: 256,
    frames: 1,
    fileName: 'strip.png',
  };
  expect(parseStoredSprite(base)?.frames).toBe(4);
  expect(parseStoredSprite({ ...base, dataUrl: 'javascript:alert(1)' })).toBeNull();
  expect(parseStoredSprite({ ...base, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeNull();
  expect(parseStoredSprite({ ...base, width: MAX_SPRITE_DIMENSION + 1 })).toBeNull();
  expect(
    parseStoredSprite({
      ...base,
      dataUrl: `data:image/png;base64,${'A'.repeat(MAX_SPRITE_DATA_URL_LENGTH)}`,
    })
  ).toBeNull();
});
