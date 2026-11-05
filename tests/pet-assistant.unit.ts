import { test, expect } from '@playwright/test';
import {
  ASSISTANT_CONTEXT_LIMIT,
  ASSISTANT_QUESTION_LIMIT,
  ASSISTANT_SUGGESTIONS,
  answerPetQuestion,
  assistantSuggestion,
  buildAssistantContext,
  formatCountdown,
  type AssistantContext,
  type AssistantTranslator,
} from '../src/lib/pet/assistant';
import { createDefaultPet } from '../src/lib/pet/pet';
import {
  DEFAULT_LOCAL_AI,
  LOCAL_AI_MODEL_MAX,
  isLoopbackEndpoint,
  localAiReady,
  parseLocalAiConfig,
  selectLocalAiServer,
  serverSelectable,
  type LocalAiServer,
} from '../src/lib/pet/local-ai';
import { defaultSettings } from '../src/lib/settings-defaults';
import type { AppSnapshot, ProviderQuota, QuotaWindow, Settings } from '../src/lib/types';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const HOUR = 3_600_000;

/** Renders a key plus its parameters so assertions stay language-independent. */
const t: AssistantTranslator = (key, params) => {
  if (!params || Object.keys(params).length === 0) return key;
  const values = Object.entries(params)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return `${key} ${values}`;
};

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    kind: 'five_hour',
    label: '5-hour',
    windowSeconds: 18_000,
    usedPercent: 42,
    resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
    scope: null,
    isPrimary: true,
    forecast: null,
    ...overrides,
  };
}

function provider(
  overrides: Partial<ProviderQuota> & Pick<ProviderQuota, 'provider'>
): ProviderQuota {
  return {
    displayName: overrides.provider === 'codex' ? 'Codex' : 'Claude Code',
    plan: null,
    planLabel: null,
    account: null,
    windows: [window()],
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

function snapshot(providers: ProviderQuota[], generatedAt = NOW): AppSnapshot {
  return { providers, generatedAt: new Date(generatedAt).toISOString() };
}

function context(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    snapshot: snapshot([
      provider({ provider: 'claude' }),
      provider({
        provider: 'codex',
        displayName: 'Codex',
        windows: [window({ usedPercent: 75, resetsAt: new Date(NOW + 5 * HOUR).toISOString() })],
      }),
    ]),
    pet: createDefaultPet(NOW),
    settings: { ...defaultSettings },
    t,
    now: NOW,
    ...overrides,
  };
}

test('every suggestion is addressable and uses a non-empty command', () => {
  const ids = new Set<string>();
  for (const suggestion of ASSISTANT_SUGGESTIONS) {
    expect(ids.has(suggestion.id)).toBe(false);
    ids.add(suggestion.id);
    expect(suggestion.command).toBe(`@${suggestion.id}`);
    expect(suggestion.labelKey).toMatch(/^plugin\.pet\.assistant\.suggest\./);
    expect(assistantSuggestion(suggestion.id)).toBe(suggestion);
  }
  expect(assistantSuggestion('help').id).toBe('help');
});

test('an English quota question summarises every active provider', () => {
  const answer = answerPetQuestion('How much quota do I have left?', context());
  expect(answer.intent).toBe('quota');
  expect(answer.text).toContain('plugin.pet.assistant.quotaOverview');
  expect(answer.text).toContain('provider=Claude Code');
  expect(answer.text).toContain('provider=Codex');
  expect(answer.text).toContain('used=42');
  expect(answer.suggestions).toEqual(['reset', 'busiest', 'forecast', 'pet']);
});

test('a provider name narrows the answer, including an extra account', () => {
  const work = provider({
    provider: 'claude',
    accountId: 'work',
    accountLabel: 'Work',
    windows: [window({ usedPercent: 91 })],
  });
  const answer = answerPetQuestion('what about work?', context({
    snapshot: snapshot([provider({ provider: 'claude' }), work]),
  }));
  expect(answer.intent).toBe('quota');
  expect(answer.provider).toBe('claude@work');
  expect(answer.text).toContain('provider=Claude Code · Work');
  expect(answer.text).toMatch(/used=91/);
  expect(answer.text).not.toContain('used=42');
});

test('a bare provider after a reset question keeps the question', () => {
  const answer = answerPetQuestion('codex?', context({
    previous: { intent: 'reset', provider: 'claude' },
  }));
  expect(answer.intent).toBe('reset');
  expect(answer.provider).toBe('codex');
  expect(answer.text).toContain('plugin.pet.assistant.resetLine');
  expect(answer.text).toContain('provider=Codex');
});

test('Chinese questions reach the same intents', () => {
  const quota = answerPetQuestion('我的额度还剩多少？', context());
  expect(quota.intent).toBe('quota');
  expect(quota.text).toContain('plugin.pet.assistant.quotaOverview');

  const reset = answerPetQuestion('什么时候重置？', context());
  expect(reset.intent).toBe('reset');

  const pet = answerPetQuestion('你现在饿不饿？', context());
  expect(pet.intent).toBe('pet');
});

test('Chinese and English interaction phrases become pet actions', () => {
  expect(answerPetQuestion('摸摸', context()).action).toBe('pat');
  expect(answerPetQuestion('喂一下', context()).action).toBe('feed');
  expect(answerPetQuestion('休息一下吧', context()).action).toBe('rest');
  expect(answerPetQuestion('feed the pet', context()).action).toBe('feed');
  expect(answerPetQuestion('play with Mochi', context()).action).toBe('play');
  expect(answerPetQuestion('pat Mochi', context()).action).toBe('pat');
  expect(answerPetQuestion('@play', context()).action).toBe('play');
});

test('an action in its cooldown answers without firing again', () => {
  const answer = answerPetQuestion('feed', context({ cooldowns: { feed: true } }));
  expect(answer.action).toBeUndefined();
  expect(answer.text).toContain('plugin.pet.assistant.action.busy');
  expect(answer.text).toContain('name=Mochi');
});

test('the pet status answer meets its needs and suggests a fitting action', () => {
  const pet = createDefaultPet(NOW);
  pet.fullness = 10;
  const answer = answerPetQuestion('how are you?', context({ pet }));
  expect(answer.intent).toBe('pet');
  expect(answer.text).toContain('plugin.pet.assistant.petSummary');
  expect(answer.text).toContain('plugin.pet.assistant.petTip.hungry');
  expect(answer.suggestions[0]).toBe('feed');
});

test('reset answers are sorted by the soonest window', () => {
  const answer = answerPetQuestion('when do things reset?', context({
    snapshot: snapshot([
      provider({
        provider: 'claude',
        windows: [window({ resetsAt: new Date(NOW + 4 * HOUR).toISOString() })],
      }),
      provider({
        provider: 'codex',
        displayName: 'Codex',
        windows: [window({ resetsAt: new Date(NOW + 1 * HOUR).toISOString() })],
      }),
    ]),
  }));
  expect(answer.intent).toBe('reset');
  const codex = answer.text.indexOf('provider=Codex');
  const claude = answer.text.indexOf('provider=Claude Code');
  expect(codex).toBeGreaterThan(-1);
  expect(claude).toBeGreaterThan(codex);
  expect(answer.text).toContain('plugin.pet.assistant.hoursMinutes');
});

test('forecasts only include windows that run out before their reset', () => {
  const answer = answerPetQuestion('will I run out?', context({
    snapshot: snapshot([
      provider({
        provider: 'claude',
        windows: [
          window({
            usedPercent: 80,
            forecast: {
              projectedPercentAtReset: 130,
              exhaustsAt: new Date(NOW + 30 * 60_000).toISOString(),
              ratePercentPerHour: 40,
              confidence: 'medium',
            },
          }),
        ],
      }),
    ]),
  }));
  expect(answer.intent).toBe('forecast');
  expect(answer.text).toContain('plugin.pet.assistant.forecastLine');
  expect(answer.text).toContain('plugin.pet.assistant.minutes m=30');
  expect(answer.text).toContain('rate=40');
});

test('credits and budget answers never invent numbers', () => {
  const credits = answerPetQuestion('credits?', context({
    snapshot: snapshot([
      provider({
        provider: 'openrouter',
        displayName: 'OpenRouter',
        credits: { hasCredits: true, unlimited: false, balance: '$12.50' },
      }),
    ]),
  }));
  expect(credits.intent).toBe('credits');
  expect(credits.text).toContain('balance=$12.50');

  const noBudget = answerPetQuestion('what is my budget?', context());
  expect(noBudget.intent).toBe('budget');
  expect(noBudget.text).toContain('plugin.pet.assistant.budgetOff');

  const budget = answerPetQuestion('budget', context({
    settings: { ...defaultSettings, monthlyBudgetUsd: 40 },
  }));
  expect(budget.text).toContain('amount=40');
  expect(budget.text).toContain('plugin.pet.assistant.budgetCaveat');
});

test('focus mode is read from the settings', () => {
  const off = answerPetQuestion('focus?', context());
  expect(off.text).toContain('plugin.pet.assistant.focusOff');

  const until = answerPetQuestion('focus?', context({
    settings: { ...defaultSettings, focusUntil: NOW + 45 * 60_000 },
  }));
  expect(until.text).toContain('plugin.pet.assistant.focusUntil');
  expect(until.text).toContain('minutes m=45');
});

test('summary includes quota, pet and pause state', () => {
  const answer = answerPetQuestion('summary', context({
    settings: { ...defaultSettings, pollingPaused: true },
  }));
  expect(answer.intent).toBe('summary');
  expect(answer.text).toContain('plugin.pet.assistant.summaryProvider');
  expect(answer.text).toContain('plugin.pet.assistant.summaryPet');
  expect(answer.text).toContain('plugin.pet.assistant.paused');
});

test('advice prioritises a critical window and then the pet', () => {
  const pet = createDefaultPet(NOW);
  pet.energy = 5;
  const answer = answerPetQuestion('what should I do?', context({
    pet,
    snapshot: snapshot([
      provider({ provider: 'claude', windows: [window({ usedPercent: 95 })] }),
    ]),
  }));
  expect(answer.intent).toBe('advice');
  expect(answer.text).toContain('plugin.pet.assistant.adviceCritical');
  expect(answer.text).toContain('plugin.pet.assistant.petTip.tired');
  expect(answer.provider).toBe('claude');
});

test('help mentions whether a local model is connected', () => {
  expect(answerPetQuestion('help', context()).text).toContain(
    'plugin.pet.assistant.helpLocalOff'
  );
  const local = answerPetQuestion('help', context({ localModel: 'qwen3:1.7b' }));
  expect(local.text).toContain('model=qwen3:1.7b');
  expect(local.text).toContain('plugin.pet.assistant.helpLocalOn');
});

test('greetings, thanks and unknown text stay short and useful', () => {
  expect(answerPetQuestion('hello', context()).intent).toBe('greeting');
  expect(answerPetQuestion('thank you', context()).intent).toBe('thanks');
  const unknown = answerPetQuestion('quantum flux capacitor', context());
  expect(unknown.intent).toBe('unknown');
  expect(unknown.text).toBe('plugin.pet.assistant.unknown');
  expect(unknown.suggestions.length).toBeGreaterThan(0);
});

test('no snapshot answers with a no-data message instead of guessing', () => {
  for (const question of ['quota', 'reset', 'busiest', 'forecast', 'credits']) {
    const answer = answerPetQuestion(question, context({ snapshot: null }));
    expect(answer.text).toContain('plugin.pet.assistant.noData');
    expect(answer.provider).toBeNull();
  }
});

test('empty provider lists are reported, not treated as zero usage', () => {
  const answer = answerPetQuestion('quota', context({ snapshot: snapshot([]) }));
  expect(answer.text).toContain('plugin.pet.assistant.noProviders');
});

test('stale snapshots carry their age', () => {
  const answer = answerPetQuestion('quota', context({
    snapshot: snapshot([provider({ provider: 'claude' })], NOW - 47 * 60_000),
  }));
  expect(answer.text).toContain('plugin.pet.assistant.stale');
  expect(answer.text).toContain('minutes=47');
});

test('the parser ignores control characters and clamps long input', () => {
  const answer = answerPetQuestion(`quota\u0000${'x'.repeat(ASSISTANT_QUESTION_LIMIT * 2)}`, context());
  expect(answer.intent).toBe('quota');
  expect(answer.text.length).toBeLessThan(2000);
});

test('countdown formatting covers minutes, hours and days', () => {
  expect(formatCountdown(0, t)).toBe('plugin.pet.assistant.resetNow');
  expect(formatCountdown(30_000, t)).toContain('minutes m=1');
  expect(formatCountdown(90 * 60_000, t)).toContain('hoursMinutes h=1 m=30');
  expect(formatCountdown(50 * HOUR, t)).toContain('daysHours d=2 h=2');
});

test('local-model context carries quota and pet facts but no identity or paths', () => {
  const secret = 'person@example.com';
  const data = buildAssistantContext(
    snapshot([
      provider({
        provider: 'claude',
        account: { email: secret, name: 'Person' },
        windows: [
          window({
            scope: 'Fable',
            forecast: {
              projectedPercentAtReset: 90,
              exhaustsAt: new Date(NOW + HOUR).toISOString(),
              ratePercentPerHour: 12.5,
              confidence: 'high',
            },
          }),
        ],
      }),
    ]),
    createDefaultPet(NOW),
    {
      ...defaultSettings,
      monthlyBudgetUsd: 25,
      focusUntil: NOW + HOUR,
    },
    NOW
  );
  const parsed = JSON.parse(data) as {
    pet: { name: string; status: string };
    quota: {
      provider: string;
      name: string;
      windows: { label: string; usedPercent: number; exhaustsInMinutes: number }[];
    }[];
    preferences: { monthlyBudgetUsd: number; focusUntil: number };
  };
  expect(parsed.pet.name).toBe('Mochi');
  expect(parsed.quota[0].provider).toBe('claude');
  expect(parsed.quota[0].windows[0].usedPercent).toBe(42);
  expect(parsed.quota[0].windows[0].exhaustsInMinutes).toBe(60);
  expect(parsed.preferences.monthlyBudgetUsd).toBe(25);
  expect(data).not.toContain(secret);
  expect(data).not.toContain('Person');
  expect(data.length).toBeLessThanOrEqual(ASSISTANT_CONTEXT_LIMIT);
});

test('requested settings are read without mutating them', () => {
  const settings: Settings = { ...defaultSettings, monthlyBudgetUsd: 10 };
  const before = JSON.stringify(settings);
  answerPetQuestion('budget', context({ settings }));
  expect(JSON.stringify(settings)).toBe(before);
});

test('only literal loopback endpoints are offered to the backend', () => {
  for (const value of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'https://[::1]:8443/v1',
  ]) {
    expect(isLoopbackEndpoint(value), value).toBe(true);
  }
  for (const value of [
    'http://192.168.1.4:11434/v1',
    'https://example.com/v1',
    'http://user:pass@127.0.0.1:11434/v1',
    'http://127.0.0.1:11434/v1?token=x',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    expect(isLoopbackEndpoint(value), value).toBe(false);
  }
});

test('a persisted local model config is repaired and enables only when complete', () => {
  expect(parseLocalAiConfig(null)).toEqual(DEFAULT_LOCAL_AI);
  expect(parseLocalAiConfig('nope')).toEqual(DEFAULT_LOCAL_AI);
  expect(parseLocalAiConfig({ enabled: true })).toEqual(DEFAULT_LOCAL_AI);
  expect(
    parseLocalAiConfig({
      enabled: true,
      baseUrl: 'https://example.com/v1',
      model: 'qwen3:1.7b',
    })
  ).toEqual({ ...DEFAULT_LOCAL_AI, model: 'qwen3:1.7b' });
  expect(
    parseLocalAiConfig({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen 3',
    })
  ).toEqual({ ...DEFAULT_LOCAL_AI, baseUrl: 'http://127.0.0.1:11434/v1' });
  expect(
    parseLocalAiConfig({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: `qwen3:${'x'.repeat(LOCAL_AI_MODEL_MAX * 2)}`,
      serverId: 'ollama!!!',
    })
  ).toEqual({
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: `qwen3:${'x'.repeat(LOCAL_AI_MODEL_MAX - 6)}`,
    serverId: 'ollama',
  });
});

test('selecting a server keeps a still-available model and otherwise takes the first', () => {
  const server: LocalAiServer = {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    reachable: true,
    models: ['qwen3:0.6b', 'qwen3:1.7b'],
    issue: null,
  };
  expect(
    selectLocalAiServer(
      { ...DEFAULT_LOCAL_AI, model: 'qwen3:1.7b', enabled: true },
      server
    )
  ).toEqual({
    enabled: true,
    baseUrl: server.baseUrl,
    model: 'qwen3:1.7b',
    serverId: 'ollama',
  });
  expect(
    selectLocalAiServer({ ...DEFAULT_LOCAL_AI, model: 'llama3.2', enabled: true }, server)
  ).toMatchObject({ model: 'qwen3:0.6b', serverId: 'ollama', enabled: true });
  expect(serverSelectable(server)).toBe(true);
  expect(serverSelectable({ ...server, models: [] })).toBe(false);
  expect(serverSelectable({ ...server, reachable: false })).toBe(false);
});

test('localAiReady requires all three: opt-in, endpoint and model', () => {
  expect(localAiReady(DEFAULT_LOCAL_AI)).toBe(false);
  expect(
    localAiReady({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:1.7b',
      serverId: 'ollama',
    })
  ).toBe(true);
  expect(
    localAiReady({
      enabled: false,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:1.7b',
      serverId: 'ollama',
    })
  ).toBe(false);
  expect(
    localAiReady({
      enabled: true,
      baseUrl: '',
      model: 'qwen3:1.7b',
      serverId: 'ollama',
    })
  ).toBe(false);
});
