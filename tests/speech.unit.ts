import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultSettings } from '../src/lib/settings-defaults';
import {
  petSituation,
  petVoice,
  quotaSituation,
  sayKey,
  speechAvatar,
  type PetSituation,
  type PetVoice,
} from '../src/lib/pet/speech';
import type { PetState } from '../src/lib/pet/pet';
import type {
  AppSnapshot,
  ProviderQuota,
  QuotaForecast,
  QuotaWindow,
  Settings,
} from '../src/lib/types';

/** The four voices the catalogue has to cover, one per skin/form combination. */
export const PET_VOICES: readonly PetVoice[] = [
  'mochi',
  'deepseek-chibi',
  'deepseek-transformed',
  'hachiware',
];

/** Every situation id `sayKey` can be asked for: statuses, reactions and events. */
export const PET_SITUATIONS: readonly PetSituation[] = [
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
  'warn',
  'critical',
  'reset',
  'forecast',
  'providerDown',
  'paused',
  'taskDone',
];

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const FUTURE = new Date(NOW + 3_600_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

function fixtureWindow(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    kind: 'five_hour',
    label: '5-hour',
    windowSeconds: 18_000,
    usedPercent: 10,
    resetsAt: FUTURE,
    scope: null,
    isPrimary: true,
    forecast: null,
    ...overrides,
  };
}

function fixtureQuota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
  return {
    provider: 'claude',
    displayName: 'Claude Code',
    plan: null,
    planLabel: null,
    account: null,
    windows: [fixtureWindow()],
    fetchedAt: new Date(NOW).toISOString(),
    source: 'api',
    status: 'ok',
    error: null,
    credits: null,
    extras: [],
    nextAttemptAt: null,
    ...overrides,
  };
}

function fixtureSnapshot(providers: ProviderQuota[]): AppSnapshot {
  return { providers, generatedAt: new Date(NOW).toISOString() };
}

function fixtureSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings, ...overrides };
}

function fixtureForecast(exhaustsAt: string | null): QuotaForecast {
  return {
    projectedPercentAtReset: 110,
    exhaustsAt,
    ratePercentPerHour: 4,
    confidence: 'high',
  };
}

function needs(
  fullness: number,
  mood: number,
  energy: number
): Pick<PetState, 'fullness' | 'mood' | 'energy'> {
  return { fullness, mood, energy };
}

test('petVoice maps every skin and DeepSeek form to its own voice', () => {
  expect(petVoice('mochi', 'chibi')).toBe('mochi');
  expect(petVoice('mochi', 'transformed')).toBe('mochi');
  expect(petVoice('deepseek', 'chibi')).toBe('deepseek-chibi');
  expect(petVoice('deepseek', 'transformed')).toBe('deepseek-transformed');
  expect(petVoice('hachiware', 'chibi')).toBe('hachiware');
  expect(petVoice('hachiware', 'transformed')).toBe('hachiware');
});

test('sayKey always has the plugin.pet.say.<voice>.<situation> shape', () => {
  expect(sayKey('deepseek-chibi', 'providerDown')).toBe(
    'plugin.pet.say.deepseek-chibi.providerDown'
  );
  for (const voice of PET_VOICES) {
    for (const situation of PET_SITUATIONS) {
      const key = sayKey(voice, situation);
      expect(key, `${voice}/${situation}`).toBe(`plugin.pet.say.${voice}.${situation}`);
      expect(key, `${voice}/${situation}`).toMatch(/^plugin\.pet\.say\.[a-z-]+\.[a-zA-Z]+$/);
    }
  }
});

test('quotaSituation lets a critical window outrank a down status', () => {
  const settings = fixtureSettings();
  expect(
    quotaSituation(
      fixtureQuota({ status: 'error', windows: [fixtureWindow({ usedPercent: 95 })] }),
      settings,
      NOW
    )
  ).toBe('critical');
  // 90 is exactly thresholds.critical.
  expect(
    quotaSituation(
      fixtureQuota({ status: 'token_expired', windows: [fixtureWindow({ usedPercent: 90 })] }),
      settings,
      NOW
    )
  ).toBe('critical');
});

test('quotaSituation lets a down status outrank warn, and warn outrank a forecast', () => {
  const settings = fixtureSettings();
  for (const status of ['error', 'token_expired', 'not_logged_in', 'rate_limited'] as const) {
    expect(
      quotaSituation(
        fixtureQuota({ status, windows: [fixtureWindow({ usedPercent: 75 })] }),
        settings,
        NOW
      ),
      status
    ).toBe('providerDown');
  }
  expect(
    quotaSituation(
      fixtureQuota({
        windows: [fixtureWindow({ usedPercent: 75, forecast: fixtureForecast(FUTURE) })],
      }),
      settings,
      NOW
    )
  ).toBe('warn');
});

test('a forecast only counts when it exhausts in the future', () => {
  const settings = fixtureSettings();
  const forecastIn = (exhaustsAt: string | null) =>
    quotaSituation(
      fixtureQuota({
        windows: [fixtureWindow({ usedPercent: 10, forecast: fixtureForecast(exhaustsAt) })],
      }),
      settings,
      NOW
    );

  expect(forecastIn(FUTURE)).toBe('forecast');
  expect(forecastIn(PAST)).toBe('ok');
  expect(forecastIn(null)).toBe('ok');
  expect(forecastIn('not-a-date')).toBe('ok');
  // The comparison is strictly `> now`, so an exact match is not "soon".
  expect(forecastIn(new Date(NOW).toISOString())).toBe('ok');
  // Any window may carry the forecast, not just the primary one.
  expect(
    quotaSituation(
      fixtureQuota({
        windows: [
          fixtureWindow({ usedPercent: 10 }),
          fixtureWindow({
            kind: 'seven_day',
            isPrimary: false,
            usedPercent: 10,
            forecast: fixtureForecast(FUTURE),
          }),
        ],
      }),
      settings,
      NOW
    )
  ).toBe('forecast');
});

test('quotaSituation honours the configured warn and critical thresholds', () => {
  const settings = fixtureSettings({ thresholds: { warn: 50, critical: 80 } });
  const at = (usedPercent: number) =>
    quotaSituation(fixtureQuota({ windows: [fixtureWindow({ usedPercent })] }), settings, NOW);
  expect(at(49)).toBe('ok');
  expect(at(50)).toBe('warn');
  expect(at(79)).toBe('warn');
  expect(at(80)).toBe('critical');
});

test('quotaSituation has no disabled branch, but never reports a disabled provider as down', () => {
  const settings = fixtureSettings();
  expect(
    quotaSituation(fixtureQuota({ status: 'disabled' }), settings, NOW)
  ).toBe('ok');
  // Windows are still inspected first: `disabled` is only skipped by the caller.
  expect(
    quotaSituation(
      fixtureQuota({ status: 'disabled', windows: [fixtureWindow({ usedPercent: 100 })] }),
      settings,
      NOW
    )
  ).toBe('critical');
});

test('petSituation lets pollingPaused outrank every provider state', () => {
  const paused = fixtureSettings({ pollingPaused: true });
  const critical = fixtureQuota({ windows: [fixtureWindow({ usedPercent: 100 })] });
  const down = fixtureQuota({ provider: 'codex', status: 'error' });
  expect(
    petSituation(fixtureSnapshot([critical, down]), paused, needs(0, 0, 0), NOW)
  ).toBe('paused');
  expect(petSituation(null, paused, needs(0, 0, 0), NOW)).toBe('paused');
});

test('petSituation ranks any critical provider, then down, warn and forecast', () => {
  const settings = fixtureSettings();
  const critical = fixtureQuota({ windows: [fixtureWindow({ usedPercent: 100 })] });
  const downWithWarn = fixtureQuota({
    provider: 'codex',
    status: 'error',
    windows: [fixtureWindow({ usedPercent: 75 })],
  });
  const warn = fixtureQuota({ provider: 'claude', windows: [fixtureWindow({ usedPercent: 75 })] });
  const forecast = fixtureQuota({
    provider: 'opencode',
    windows: [fixtureWindow({ usedPercent: 10, forecast: fixtureForecast(FUTURE) })],
  });
  const pet = needs(100, 100, 100);

  expect(petSituation(fixtureSnapshot([downWithWarn, critical]), settings, pet, NOW)).toBe(
    'critical'
  );
  expect(petSituation(fixtureSnapshot([critical, downWithWarn]), settings, pet, NOW)).toBe(
    'critical'
  );
  expect(petSituation(fixtureSnapshot([forecast, downWithWarn]), settings, pet, NOW)).toBe(
    'providerDown'
  );
  expect(petSituation(fixtureSnapshot([forecast, warn]), settings, pet, NOW)).toBe('warn');
  expect(petSituation(fixtureSnapshot([forecast]), settings, pet, NOW)).toBe('forecast');
});

test('petSituation skips disabled providers entirely', () => {
  const settings = fixtureSettings();
  const disabledCritical = fixtureQuota({
    status: 'disabled',
    windows: [fixtureWindow({ usedPercent: 100 })],
  });
  const disabledForecast = fixtureQuota({
    status: 'disabled',
    windows: [fixtureWindow({ usedPercent: 10, forecast: fixtureForecast(FUTURE) })],
  });

  expect(
    petSituation(fixtureSnapshot([disabledCritical]), settings, needs(100, 100, 100), NOW)
  ).toBe('happy');
  expect(
    petSituation(fixtureSnapshot([disabledForecast]), settings, needs(10, 100, 100), NOW)
  ).toBe('hungry');
  // A real critical provider still wins alongside a disabled one.
  expect(
    petSituation(
      fixtureSnapshot([
        disabledCritical,
        fixtureQuota({ windows: [fixtureWindow({ usedPercent: 100 })] }),
      ]),
      settings,
      needs(100, 100, 100),
      NOW
    )
  ).toBe('critical');
});

test('petSituation falls back to petStatus: hungry, tired, bored, happy, ok', () => {
  const settings = fixtureSettings();
  // A null or empty snapshot means no provider state at all.
  expect(petSituation(null, settings, needs(29, 100, 100), NOW)).toBe('hungry');
  expect(petSituation(null, settings, needs(100, 100, 29), NOW)).toBe('tired');
  expect(petSituation(null, settings, needs(100, 39, 100), NOW)).toBe('bored');
  expect(petSituation(null, settings, needs(100, 100, 100), NOW)).toBe('happy');
  expect(petSituation(null, settings, needs(69, 100, 100), NOW)).toBe('ok');

  // Healthy providers stay out of the way and the pet's own needs win.
  const calm = fixtureSnapshot([fixtureQuota()]);
  expect(petSituation(calm, settings, needs(29, 100, 100), NOW)).toBe('hungry');
  expect(petSituation(fixtureSnapshot([]), settings, needs(100, 100, 100), NOW)).toBe('happy');
});

test('mochi has no bundled expression cards', () => {
  for (const situation of PET_SITUATIONS) {
    expect(speechAvatar('mochi', situation), situation).toBeNull();
  }
});

test('every bundled voice and situation resolves to an existing /pet webp card', () => {
  for (const voice of PET_VOICES) {
    if (voice === 'mochi') continue;
    for (const situation of PET_SITUATIONS) {
      const asset = speechAvatar(voice, situation);
      const label = `${voice}/${situation}`;
      expect(asset, label).not.toBeNull();
      expect(asset!, label).toMatch(/^\/pet\/[a-z-]+\.webp$/);
      expect(existsSync(path.join('static', asset!)), asset!).toBe(true);
    }
  }
});

test('happy situations use the happy card and critical uses the pat card', () => {
  const HAPPY_CARD: Record<'deepseek-chibi' | 'deepseek-transformed' | 'hachiware', string> = {
    'deepseek-chibi': '/pet/deepseek-chibi-happy.webp',
    'deepseek-transformed': '/pet/deepseek-transformed-happy.webp',
    hachiware: '/pet/hachiware-happy.webp',
  };
  const PLAY_CARD: Record<'deepseek-chibi' | 'deepseek-transformed' | 'hachiware', string> = {
    'deepseek-chibi': '/pet/deepseek-chibi-happy.webp',
    'deepseek-transformed': '/pet/deepseek-transformed-happy.webp',
    hachiware: '/pet/hachiware-play.webp',
  };
  for (const voice of Object.keys(HAPPY_CARD) as Array<keyof typeof HAPPY_CARD>) {
    for (const situation of ['happy', 'reset', 'taskDone'] as const) {
      expect(speechAvatar(voice, situation), `${voice}/${situation}`).toBe(HAPPY_CARD[voice]);
    }
    // `play` is a happy reaction, but Hachiware has a dedicated play card.
    expect(speechAvatar(voice, 'play'), `${voice}/play`).toBe(PLAY_CARD[voice]);
  }
  expect(speechAvatar('hachiware', 'critical')).toBe('/pet/hachiware-pat.webp');
  expect(speechAvatar('deepseek-chibi', 'critical')).toBe('/pet/deepseek-chibi-surprised.webp');
  expect(speechAvatar('deepseek-transformed', 'critical')).toBe(
    '/pet/deepseek-transformed-happy.webp'
  );
});

test('every voice/situation line exists in both catalogues with only {name} placeholders', () => {
  const catalogue = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(path.join('src', 'lib', 'i18n', `${locale}.json`), 'utf8')) as Record<
      string,
      string
    >;
  const catalogues = new Map([
    ['en', catalogue('en')],
    ['zh-CN', catalogue('zh-CN')],
  ]);

  for (const [locale, lines] of catalogues) {
    for (const voice of PET_VOICES) {
      for (const situation of PET_SITUATIONS) {
        const key = sayKey(voice, situation);
        const label = `${locale} ${key}`;
        const line: unknown = lines[key];
        expect(typeof line, label).toBe('string');
        expect((line as string).trim().length, label).toBeGreaterThan(0);
        // tDyn(key, { name }) is the only call shape, so {name} is the only
        // placeholder the panels can fill; anything else would render raw.
        for (const placeholder of (line as string).match(/\{[^}]*\}/g) ?? []) {
          expect(placeholder, label).toBe('{name}');
        }
        expect((line as string).replace(/\{name\}/g, ''), label).not.toMatch(/[{}]/);
      }
    }
  }
});
