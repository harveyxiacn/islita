import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { animationMs } from '../src/lib/pet/animations';
import { skinImage } from '../src/lib/pet/skins';
import {
  PET_CLICK_LINE_COUNT,
  PET_CLICK_REACTIONS,
  clickLineKey,
  clickReactionSpec,
  isPetClickReaction,
  pickClickPerformance,
  sanitizeClickSeed,
  type PetClickReaction,
} from '../src/lib/pet/reactions';
import type { PetVoice } from '../src/lib/pet/speech';

const VOICES: readonly PetVoice[] = [
  'mochi',
  'deepseek-chibi',
  'deepseek-transformed',
  'hachiware',
];

function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function catalogue(name: string): Record<string, string> {
  return JSON.parse(
    readFileSync(path.join('src', 'lib', 'i18n', `${name}.json`), 'utf8')
  ) as Record<string, string>;
}

test('every click reaction has one complete, distinct performance', () => {
  expect(new Set(PET_CLICK_REACTIONS).size).toBe(PET_CLICK_REACTIONS.length);
  expect(new Set(PET_CLICK_REACTIONS.map((id) => clickReactionSpec(id).clip)).size).toBe(
    PET_CLICK_REACTIONS.length
  );
  for (const id of PET_CLICK_REACTIONS) {
    const spec = clickReactionSpec(id);
    expect(spec.id).toBe(id);
    expect(spec.holdMs, id).toBeGreaterThanOrEqual(2400);
    expect(spec.mode, id).toBeTruthy();
    expect(spec.mood, id).toBeTruthy();
    expect(spec.status, id).toBeTruthy();
  }
  // The one-shot hop must not be cut off by the pose timer.
  expect(clickReactionSpec('bounce').holdMs).toBeGreaterThanOrEqual(animationMs('jump'));
});

test('Hachiware has a distinct card for all six reactions, Mochi four faces', () => {
  const hachiCards = PET_CLICK_REACTIONS.map((id) =>
    skinImage('hachiware', 'chibi', clickReactionSpec(id).mood)
  );
  expect(new Set(hachiCards).size).toBe(PET_CLICK_REACTIONS.length);

  const mochiFaces = new Set(
    PET_CLICK_REACTIONS.map((id) => clickReactionSpec(id).status)
  );
  expect(mochiFaces.size).toBeGreaterThanOrEqual(4);
});

test('clickLineKey uses the one-based i18n suffix and clamps the variant', () => {
  expect(clickLineKey('mochi', { reaction: 'munch', variant: 0 })).toBe(
    'plugin.pet.reaction.mochi.munch.1'
  );
  expect(clickLineKey('hachiware', { reaction: 'sulk', variant: 2 })).toBe(
    'plugin.pet.reaction.hachiware.sulk.3'
  );
  expect(clickLineKey('deepseek-chibi', { reaction: 'doze', variant: 99 })).toBe(
    'plugin.pet.reaction.deepseek-chibi.doze.3'
  );
  expect(clickLineKey('mochi', { reaction: 'munch', variant: Number.NaN })).toBe(
    'plugin.pet.reaction.mochi.munch.1'
  );
});

test('a click never repeats the previous reaction and can reach every variant', () => {
  for (const previous of PET_CLICK_REACTIONS) {
    for (const value of [0, 0.2, 0.5, 0.9, 0.999_999]) {
      const picked = pickClickPerformance('mochi', {
        previous,
        random: sequence([value, value]),
      });
      expect(picked.reaction, `${previous}@${value}`).not.toBe(previous);
      expect(PET_CLICK_REACTIONS).toContain(picked.reaction);
      expect(picked.variant).toBeGreaterThanOrEqual(0);
      expect(picked.variant).toBeLessThan(PET_CLICK_LINE_COUNT);
    }
  }

  const first = pickClickPerformance('mochi', { random: sequence([0, 0]) });
  expect(first.reaction).toBe(PET_CLICK_REACTIONS[0]);
  expect(first.variant).toBe(0);

  const last = pickClickPerformance('mochi', { random: sequence([1, 1]) });
  expect(last.reaction).toBe(PET_CLICK_REACTIONS[PET_CLICK_REACTIONS.length - 1]);
  expect(last.variant).toBe(PET_CLICK_LINE_COUNT - 1);
});

test('the previous reaction is only excluded when another exists', () => {
  // A defensive call with the full pool still works: random index 0 wins.
  for (const previous of [null, ...PET_CLICK_REACTIONS] as const) {
    const picked = pickClickPerformance('hachiware', { previous, random: () => 0 });
    expect(isPetClickReaction(picked.reaction)).toBe(true);
    expect(picked.lineKey).toBe(clickLineKey('hachiware', picked));
  }
});

test('sanitizeClickSeed repairs old payloads and rejects unknown reactions', () => {
  expect(sanitizeClickSeed({ reaction: 'munch', variant: 1 })).toEqual({
    reaction: 'munch',
    variant: 1,
  });
  expect(sanitizeClickSeed({ reaction: 'munch', variant: 99 })).toEqual({
    reaction: 'munch',
    variant: 2,
  });
  expect(sanitizeClickSeed({ reaction: 'munch', variant: -4 })).toEqual({
    reaction: 'munch',
    variant: 0,
  });
  expect(sanitizeClickSeed({ reaction: 'munch', variant: '1' })).toEqual({
    reaction: 'munch',
    variant: 0,
  });
  expect(sanitizeClickSeed({ reaction: 'nap', variant: 1 })).toBeNull();
  expect(sanitizeClickSeed(null)).toBeNull();
  expect(sanitizeClickSeed('munch')).toBeNull();
});

test('every voice and reaction has three non-empty lines in both catalogues', () => {
  const catalogues = new Map([
    ['en', catalogue('en')],
    ['zh-CN', catalogue('zh-CN')],
  ]);
  for (const [locale, lines] of catalogues) {
    for (const voice of VOICES) {
      const spoken: string[] = [];
      for (const reaction of PET_CLICK_REACTIONS) {
        for (let variant = 0; variant < PET_CLICK_LINE_COUNT; variant += 1) {
          const key = clickLineKey(voice, { reaction, variant });
          const line: unknown = lines[key];
          expect(typeof line, `${locale} ${key}`).toBe('string');
          expect((line as string).trim().length, `${locale} ${key}`).toBeGreaterThan(0);
          // tDyn(key, { name }) is the only call shape used by both surfaces.
          for (const placeholder of (line as string).match(/\{[^}]*\}/g) ?? []) {
            expect(placeholder, `${locale} ${key}`).toBe('{name}');
          }
          spoken.push(line as string);
        }
      }
      expect(new Set(spoken).size, `${locale} ${voice}`).toBe(spoken.length);
    }
  }
});

test('every reaction is reachable in one draw', () => {
  for (const target of PET_CLICK_REACTIONS) {
    const previous: PetClickReaction = target === 'nuzzle' ? 'bounce' : 'nuzzle';
    const pool = PET_CLICK_REACTIONS.filter((reaction) => reaction !== previous);
    const value = (pool.indexOf(target) + 0.5) / pool.length;
    const picked = pickClickPerformance('deepseek-chibi', {
      previous,
      random: sequence([value, 0]),
    });
    expect(picked.reaction).toBe(target);
    expect(picked.lineKey).toBe(`plugin.pet.reaction.deepseek-chibi.${target}.1`);
  }
});
