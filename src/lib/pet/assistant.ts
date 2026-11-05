// The pet's built-in assistant. [FRONTEND]
//
// A small deterministic assistant that works with no model installed: it
// recognises a handful of intents in English and Chinese, then answers from
// the live quota snapshot and the pet's own state. A local Ollama / llama.cpp /
// LM Studio model can be layered on top in the panel; when it is unavailable
// the same answers are used, so the feature never depends on a download.
//
// Pure module: the caller injects `t()` and (optionally) the current time, so
// every rule can be unit-tested without a browser or a network.
import type { AppSnapshot, ProviderQuota, QuotaWindow, Settings } from '../types';
import {
  petStatus,
  type PetAction,
  type PetState,
  type PetStatus,
} from './pet';

export type AssistantTranslator = (
  key: string,
  params?: Record<string, string | number>
) => string;

export type AssistantIntent =
  | 'greeting'
  | 'thanks'
  | 'help'
  | 'quota'
  | 'reset'
  | 'busiest'
  | 'forecast'
  | 'credits'
  | 'pet'
  | 'summary'
  | 'budget'
  | 'focus'
  | 'advice'
  | 'unknown'
  | 'action';

export type AssistantSuggestionId =
  | 'quota'
  | 'reset'
  | 'busiest'
  | 'forecast'
  | 'pet'
  | 'feed'
  | 'play'
  | 'rest'
  | 'pat'
  | 'summary'
  | 'advice'
  | 'help';

export interface AssistantSuggestion {
  id: AssistantSuggestionId;
  /** i18n key for the chip; the command sent to the parser is `@<id>`. */
  labelKey: string;
  command: string;
}

export const ASSISTANT_SUGGESTIONS: readonly AssistantSuggestion[] = [
  { id: 'quota', labelKey: 'plugin.pet.assistant.suggest.quota', command: '@quota' },
  { id: 'reset', labelKey: 'plugin.pet.assistant.suggest.reset', command: '@reset' },
  { id: 'busiest', labelKey: 'plugin.pet.assistant.suggest.busiest', command: '@busiest' },
  { id: 'forecast', labelKey: 'plugin.pet.assistant.suggest.forecast', command: '@forecast' },
  { id: 'pet', labelKey: 'plugin.pet.assistant.suggest.pet', command: '@pet' },
  { id: 'feed', labelKey: 'plugin.pet.assistant.suggest.feed', command: '@feed' },
  { id: 'play', labelKey: 'plugin.pet.assistant.suggest.play', command: '@play' },
  { id: 'rest', labelKey: 'plugin.pet.assistant.suggest.rest', command: '@rest' },
  { id: 'pat', labelKey: 'plugin.pet.assistant.suggest.pat', command: '@pat' },
  { id: 'summary', labelKey: 'plugin.pet.assistant.suggest.summary', command: '@summary' },
  { id: 'advice', labelKey: 'plugin.pet.assistant.suggest.advice', command: '@advice' },
  { id: 'help', labelKey: 'plugin.pet.assistant.suggest.help', command: '@help' },
];

const SUGGESTION_BY_ID = new Map(
  ASSISTANT_SUGGESTIONS.map((entry) => [entry.id, entry] as const)
);

export function assistantSuggestion(id: AssistantSuggestionId): AssistantSuggestion {
  return SUGGESTION_BY_ID.get(id) ?? SUGGESTION_BY_ID.get('help')!;
}

export interface AssistantPrevious {
  intent: AssistantIntent;
  provider: string | null;
}

export interface AssistantContext {
  snapshot: AppSnapshot | null;
  pet: PetState;
  settings: Settings;
  t: AssistantTranslator;
  now?: number;
  /** Model id when the panel is using a local model; shown by `@help`. */
  localModel?: string | null;
  /** Interaction buttons that are still cooling down; blocks a chat action. */
  cooldowns?: Partial<Record<PetAction, boolean>>;
  previous?: AssistantPrevious | null;
}

export interface AssistantAnswer {
  intent: AssistantIntent;
  text: string;
  suggestions: AssistantSuggestionId[];
  /** Set when the panel should run the pet interaction. */
  action?: PetAction;
  /** Provider key (`claude`, `claude@work`, …) for follow-up questions. */
  provider: string | null;
}

interface ResolvedAssistantContext extends AssistantContext {
  now: number;
}

const QUOTA_WORDS =
  /\b(quota|usage|used|remaining|left|percent|percentage|limit|limits|how much)\b/i;
const RESET_WORDS = /\b(reset|resets|resetting|renew|renews|refresh|refreshes)\b/i;
const BUSIEST_WORDS = /\b(busiest|most used|highest|worst|heaviest|max|maximum)\b/i;
const FORECAST_WORDS =
  /\b(forecast|run out|running out|runs out|exhaust|exhausts|pace|pacing|before (the )?reset)\b/i;
const CREDITS_WORDS = /\b(credits?|balance)\b/i;
const PET_WORDS =
  /\b(pet|mochi|hachiware|deepseek|hungry|hunger|mood|energy|level|xp|tired|bored|sleepy)\b/i;
const PET_STATUS_WORDS =
  /\b(how are you|how's it going|hows it going|you ok|you okay|your (day|mood|energy)|are you (ok|okay|hungry|tired|bored))\b/i;
const SUMMARY_WORDS = /\b(summary|summarize|overview|status|how.*going|today)\b/i;
const BUDGET_WORDS = /\b(budget|spend|spending|cost|costs|price|prices|expensive)\b/i;
const FOCUS_WORDS = /\b(focus|do not disturb|dnd|notifications?)\b/i;
const ADVICE_WORDS =
  /\b(what should i do|what should we do|advice|suggest|suggestions?|recommend|should i|next step)\b/i;
const HELP_WORDS = /\b(help|what can you do|commands?|how do i use)\b/i;
const GREETING_WORDS = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|早上好|早安|你好|嗨|哈喽)/i;
const THANKS_WORDS = /\b(thanks|thank you|thx|ty)\b|谢谢|多谢|感谢/i;

const QUOTA_ZH = /额度|用量|用了多少|剩余|还剩|百分比|限额|上限/;
const RESET_ZH = /重置|刷新|恢复|什么时候.*(重置|恢复)/;
const BUSIEST_ZH = /最忙|最高|用得最多|消耗最多/;
const FORECAST_ZH = /预测|预计|用完|耗尽|提前/;
const CREDITS_ZH = /余额|积分|剩余额度/;
const PET_ZH = /宠物|麻薯|小八|大肥鱼|饿|心情|精力|等级|经验|无聊|累/;
const PET_NAME_ZH = /麻薯|小八|大肥鱼/;
const SUMMARY_ZH = /总结|概况|今天|状态|怎么样/;
const BUDGET_ZH = /预算|花费|成本|费用|花钱/;
const FOCUS_ZH = /专注|免打扰|通知/;
const ADVICE_ZH = /建议|怎么办|该做什么|下一步/;
const HELP_ZH = /帮助|你能做什么|会什么|怎么用/;

const DIRECT: Record<string, AssistantIntent> = {
  '@quota': 'quota',
  '@reset': 'reset',
  '@busiest': 'busiest',
  '@forecast': 'forecast',
  '@pet': 'pet',
  '@summary': 'summary',
  '@advice': 'advice',
  '@help': 'help',
  '@feed': 'action',
  '@play': 'action',
  '@rest': 'action',
  '@pat': 'action',
};

const ACTION_DIRECT: Record<string, PetAction> = {
  '@feed': 'feed',
  '@play': 'play',
  '@rest': 'rest',
  '@pat': 'pat',
};

const PROVIDER_PATTERNS: readonly [string, RegExp][] = [
  ['openrouter', /\bopenrouter\b|\bopen\s+router\b|开放路由/i],
  ['opencode', /\bopencode\b|\bopen\s+code\b/i],
  ['copilot', /\bcopilot\b|\bgithub\s+copilot\b/i],
  ['claude', /\bclaude\b|\banthropic\b|克劳德/i],
  ['codex', /\bcodex\b|\bchatgpt\b|\bopenai\b/i],
];

const PET_TIPS: Record<PetStatus, string> = {
  happy: 'plugin.pet.assistant.petTip.happy',
  ok: 'plugin.pet.assistant.petTip.ok',
  hungry: 'plugin.pet.assistant.petTip.hungry',
  tired: 'plugin.pet.assistant.petTip.tired',
  bored: 'plugin.pet.assistant.petTip.bored',
};

const ACTION_TEXT: Record<PetAction, string> = {
  feed: 'plugin.pet.assistant.action.feed',
  play: 'plugin.pet.assistant.action.play',
  rest: 'plugin.pet.assistant.action.rest',
  pat: 'plugin.pet.assistant.action.pat',
};

/** Text length the parser accepts; the panel clamps its input to the same. */
export const ASSISTANT_QUESTION_LIMIT = 500;

/** Hard cap for the context sent to a local model; the Rust command repeats it. */
export const ASSISTANT_CONTEXT_LIMIT = 12_000;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function providerLabel(provider: ProviderQuota): string {
  const base = provider.displayName || provider.provider;
  return provider.accountLabel ? `${base} · ${provider.accountLabel}` : base;
}

function providerKey(provider: ProviderQuota): string {
  return provider.accountId ? `${provider.provider}@${provider.accountId}` : provider.provider;
}

function activeProviders(snapshot: AppSnapshot | null): ProviderQuota[] {
  return (snapshot?.providers ?? []).filter((provider) => provider.status !== 'disabled');
}

function busiestWindow(provider: ProviderQuota): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const window of provider.windows) {
    if (best === null || window.usedPercent > best.usedPercent) best = window;
  }
  return best;
}

function windowLabel(window: QuotaWindow, t: AssistantTranslator): string {
  if (window.kind === 'other') return window.label.slice(0, 80) || t('plugin.pet.assistant.otherWindow');
  const base =
    window.kind === 'five_hour'
      ? t('window.fiveHourSession')
      : window.kind === 'seven_day'
        ? t('window.weekly')
        : window.label.slice(0, 80);
  return window.scope ? t('window.scoped', { kind: base, scope: window.scope }) : base;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Human duration for reset / forecast phrases, using the caller's language. */
export function formatCountdown(ms: number, t: AssistantTranslator): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('plugin.pet.assistant.resetNow');
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return t('plugin.pet.assistant.minutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) {
    return t('plugin.pet.assistant.hoursMinutes', { h: hours, m: pad2(rest) });
  }
  const days = Math.floor(hours / 24);
  return t('plugin.pet.assistant.daysHours', { d: days, h: hours % 24 });
}

function resetPhrase(window: QuotaWindow, t: AssistantTranslator, now: number): string {
  if (!window.resetsAt) return t('plugin.pet.assistant.resetUnknown');
  const target = Date.parse(window.resetsAt);
  if (!Number.isFinite(target)) return t('plugin.pet.assistant.resetUnknown');
  if (target <= now) return t('plugin.pet.assistant.resetNow');
  return t('plugin.pet.assistant.resetsIn', { time: formatCountdown(target - now, t) });
}

function forecastLeft(window: QuotaWindow, now: number): number | null {
  const target = window.forecast?.exhaustsAt ? Date.parse(window.forecast.exhaustsAt) : NaN;
  if (!Number.isFinite(target) || target <= now) return null;
  return target - now;
}

function normalize(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, ASSISTANT_QUESTION_LIMIT);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return false;
  if (/[一-鿿]/.test(needle)) return text.includes(needle);
  if (needle.includes('@')) return text.includes(needle);
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(text);
}

function matchProvider(text: string, snapshot: AppSnapshot | null): ProviderQuota | null {
  const providers = activeProviders(snapshot);
  const lower = text.toLowerCase();
  // A user label is the most specific address ("work", "claude@work").
  for (const provider of providers) {
    if (provider.accountLabel && mentions(lower, provider.accountLabel)) return provider;
    if (provider.accountId && mentions(lower, provider.accountId)) return provider;
  }
  for (const [id, pattern] of PROVIDER_PATTERNS) {
    if (!pattern.test(text)) continue;
    // Prefer the primary account; the extra accounts have their own label.
    return (
      providers.find((provider) => provider.provider === id && !provider.accountId) ??
      providers.find((provider) => provider.provider === id) ??
      null
    );
  }
  for (const provider of providers) {
    if (mentions(lower, provider.displayName)) return provider;
  }
  return null;
}

function detectAction(text: string, name: string): PetAction | null {
  const trimmed = text.trim();
  if (ACTION_DIRECT[trimmed.toLowerCase()]) return ACTION_DIRECT[trimmed.toLowerCase()];
  const safeName = escapeRegExp(name.toLowerCase());
  const english: readonly [PetAction, RegExp][] = [
    [
      'feed',
      new RegExp(
        `^(please\\s+)?(feed(\\s+(the\\s+)?(pet|${safeName}))?|give(\\s+(the\\s+)?(pet|${safeName}))?\\s+(a\\s+)?(snack|food))[.!?]*$`,
        'i'
      ),
    ],
    [
      'play',
      new RegExp(
        `^(please\\s+)?(play(\\s+with)?(\\s+(the\\s+)?(pet|${safeName}))?|let'?s play)[.!?]*$`,
        'i'
      ),
    ],
    ['rest', /^(please\s+)?(rest|sleep|take a (short )?rest|let .{0,16} rest)[.!?]*$/i],
    [
      'pat',
      new RegExp(
        `^(please\\s+)?((pat|stroke)(\\s+(the\\s+)?(pet|${safeName}))?|pet\\s+(the\\s+pet|${safeName}))[.!?]*$`,
        'i'
      ),
    ],
  ];
  for (const [action, pattern] of english) {
    if (pattern.test(trimmed)) return action;
  }
  const chinese: readonly [PetAction, RegExp][] = [
    ['feed', /^(请|麻烦)?(你)?(喂|喂食|喂饭|喂点东西|给.{0,10}喂(点|些)?(东西|吃的|饭)?)(一下)?[吧呀啊]?[。！!]*$/],
    ['play', /^(请|麻烦)?(你)?(玩|玩耍|陪.{0,10}玩)(一下|一会|会儿)?[吧呀啊]?[。！!]*$/],
    ['rest', /^(请|麻烦)?(你)?(休息|睡|睡觉|歇)(一下|一会|会儿)?[吧呀啊]?[。！!]*$/],
    ['pat', /^(请|麻烦)?(你)?(摸摸|摸一摸|拍一拍|撸一撸)(一下)?[吧呀啊]?[。！!]*$/],
  ];
  for (const [action, pattern] of chinese) {
    if (pattern.test(trimmed)) return action;
  }
  return null;
}

interface ParsedQuestion {
  intent: AssistantIntent;
  action: PetAction | null;
  provider: ProviderQuota | null;
}

function parseQuestion(question: string, context: ResolvedAssistantContext): ParsedQuestion {
  const text = normalize(question);
  const lower = text.toLowerCase();
  const provider = matchProvider(text, context.snapshot);
  const direct = DIRECT[lower];
  if (direct) {
    return {
      intent: direct,
      action: direct === 'action' ? ACTION_DIRECT[lower] ?? null : null,
      provider,
    };
  }

  const action = detectAction(text, context.pet.name);
  if (action) return { intent: 'action', action, provider: null };

  if (GREETING_WORDS.test(text)) return { intent: 'greeting', action: null, provider };
  if (THANKS_WORDS.test(text)) return { intent: 'thanks', action: null, provider };
  if (HELP_WORDS.test(lower) || HELP_ZH.test(text)) {
    return { intent: 'help', action: null, provider };
  }
  if (FORECAST_WORDS.test(lower) || FORECAST_ZH.test(text)) {
    return { intent: 'forecast', action: null, provider };
  }
  if (RESET_WORDS.test(lower) || RESET_ZH.test(text)) {
    return { intent: 'reset', action: null, provider };
  }
  if (BUSIEST_WORDS.test(lower) || BUSIEST_ZH.test(text)) {
    return { intent: 'busiest', action: null, provider };
  }
  if (CREDITS_WORDS.test(lower) || CREDITS_ZH.test(text)) {
    return { intent: 'credits', action: null, provider };
  }
  if (BUDGET_WORDS.test(lower) || BUDGET_ZH.test(text)) {
    return { intent: 'budget', action: null, provider };
  }
  if (FOCUS_WORDS.test(lower) || FOCUS_ZH.test(text)) {
    return { intent: 'focus', action: null, provider };
  }
  if (ADVICE_WORDS.test(lower) || ADVICE_ZH.test(text)) {
    return { intent: 'advice', action: null, provider };
  }
  if (PET_STATUS_WORDS.test(lower) || PET_ZH.test(text) || PET_WORDS.test(lower)) {
    return { intent: 'pet', action: null, provider };
  }
  if (SUMMARY_WORDS.test(lower) || SUMMARY_ZH.test(text)) {
    return { intent: 'summary', action: null, provider };
  }
  if (QUOTA_WORDS.test(lower) || QUOTA_ZH.test(text)) {
    return { intent: 'quota', action: null, provider };
  }
  if (PET_NAME_ZH.test(text)) {
    return { intent: 'pet', action: null, provider: null };
  }
  if (provider) {
    const previous = context.previous;
    const inherited =
      previous &&
      previous.intent !== 'unknown' &&
      previous.intent !== 'action' &&
      ['quota', 'reset', 'forecast', 'busiest', 'credits'].includes(previous.intent)
        ? previous.intent
        : 'quota';
    return { intent: inherited, action: null, provider };
  }
  return { intent: 'unknown', action: null, provider: null };
}

function staleLine(context: ResolvedAssistantContext, t: AssistantTranslator): string | null {
  const generated = context.snapshot?.generatedAt ? Date.parse(context.snapshot.generatedAt) : NaN;
  if (!Number.isFinite(generated)) return null;
  const minutes = Math.floor((context.now - generated) / 60_000);
  if (minutes < 15) return null;
  return t('plugin.pet.assistant.stale', { minutes });
}

function answerNoData(t: AssistantTranslator): AssistantAnswer {
  return {
    intent: 'quota',
    text: t('plugin.pet.assistant.noData'),
    suggestions: ['summary', 'help', 'quota'],
    provider: null,
  };
}

function providerWindows(provider: ProviderQuota, t: AssistantTranslator, now: number): string[] {
  const lines: string[] = [];
  const shown = provider.windows.slice(0, 4);
  for (const window of shown) {
    lines.push(
      t('plugin.pet.assistant.window', {
        provider: providerLabel(provider),
        window: windowLabel(window, t),
        used: clampPercent(window.usedPercent),
        reset: resetPhrase(window, t, now),
      })
    );
  }
  if (provider.windows.length > shown.length) {
    lines.push(
      t('plugin.pet.assistant.moreWindows', { count: provider.windows.length - shown.length })
    );
  }
  return lines;
}

function answerQuota(context: ResolvedAssistantContext, provider: ProviderQuota | null): AssistantAnswer {
  const t = context.t;
  const now = context.now;
  const snapshot = context.snapshot;
  if (snapshot === null) return answerNoData(t);
  const providers = activeProviders(snapshot);
  if (providers.length === 0) {
    return {
      intent: 'quota',
      text: t('plugin.pet.assistant.noProviders'),
      suggestions: ['help', 'summary'],
      provider: null,
    };
  }
  const lines: string[] = [];
  if (provider) {
    lines.push(t('plugin.pet.assistant.aboutProvider', { provider: providerLabel(provider) }));
    if (provider.windows.length === 0) {
      lines.push(t('plugin.pet.assistant.providerIssue', { provider: providerLabel(provider) }));
    } else {
      lines.push(...providerWindows(provider, t, now));
      const forecast = provider.windows.find((window) => forecastLeft(window, now) !== null);
      if (forecast) {
        lines.push(
          t('plugin.pet.assistant.forecastLine', {
            provider: providerLabel(provider),
            window: windowLabel(forecast, t),
            time: formatCountdown(forecastLeft(forecast, now)!, t),
            rate: Math.max(1, Math.round(forecast.forecast?.ratePercentPerHour ?? 0)),
          })
        );
      }
    }
  } else {
    lines.push(t('plugin.pet.assistant.quotaOverview'));
    const shown = providers.slice(0, 5);
    for (const entry of shown) {
      const window = busiestWindow(entry);
      if (!window) {
        lines.push(t('plugin.pet.assistant.providerIssue', { provider: providerLabel(entry) }));
        continue;
      }
      lines.push(
        t('plugin.pet.assistant.window', {
          provider: providerLabel(entry),
          window: windowLabel(window, t),
          used: clampPercent(window.usedPercent),
          reset: resetPhrase(window, t, now),
        })
      );
    }
    if (providers.length > shown.length) {
      lines.push(
        t('plugin.pet.assistant.moreProviders', { count: providers.length - shown.length })
      );
    }
  }
  const stale = staleLine(context, t);
  if (stale) lines.push(stale);
  return {
    intent: 'quota',
    text: lines.join('\n'),
    suggestions: ['reset', 'busiest', 'forecast', 'pet'],
    provider: provider ? providerKey(provider) : null,
  };
}

function answerBusiest(context: ResolvedAssistantContext, provider: ProviderQuota | null): AssistantAnswer {
  const t = context.t;
  const providers = provider ? [provider] : activeProviders(context.snapshot);
  if (context.snapshot === null) return answerNoData(t);
  if (providers.length === 0) {
    return {
      intent: 'busiest',
      text: t('plugin.pet.assistant.noProviders'),
      suggestions: ['help', 'summary'],
      provider: null,
    };
  }
  let bestProvider: ProviderQuota | null = null;
  let bestWindow: QuotaWindow | null = null;
  for (const entry of providers) {
    const window = busiestWindow(entry);
    if (window && (bestWindow === null || window.usedPercent > bestWindow.usedPercent)) {
      bestProvider = entry;
      bestWindow = window;
    }
  }
  if (!bestProvider || !bestWindow) {
    return {
      intent: 'busiest',
      text: t('plugin.pet.assistant.noProviders'),
      suggestions: ['quota', 'help'],
      provider: null,
    };
  }
  const lines = [
    t('plugin.pet.assistant.busiest', {
      provider: providerLabel(bestProvider),
      window: windowLabel(bestWindow, t),
      used: clampPercent(bestWindow.usedPercent),
    }),
    resetPhrase(bestWindow, t, context.now)
      ? t('plugin.pet.assistant.window', {
          provider: providerLabel(bestProvider),
          window: windowLabel(bestWindow, t),
          used: clampPercent(bestWindow.usedPercent),
          reset: resetPhrase(bestWindow, t, context.now),
        })
      : '',
  ].filter(Boolean);
  const stale = staleLine(context, t);
  if (stale) lines.push(stale);
  return {
    intent: 'busiest',
    text: lines.join('\n'),
    suggestions: ['quota', 'reset', 'forecast', 'pet'],
    provider: providerKey(bestProvider),
  };
}

function answerReset(context: ResolvedAssistantContext, provider: ProviderQuota | null): AssistantAnswer {
  const t = context.t;
  const now = context.now;
  if (context.snapshot === null) return answerNoData(t);
  const providers = provider ? [provider] : activeProviders(context.snapshot);
  const entries: { provider: ProviderQuota; window: QuotaWindow; target: number }[] = [];
  for (const entry of providers) {
    for (const window of entry.windows) {
      const target = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (Number.isFinite(target) && target > now) {
        entries.push({ provider: entry, window, target });
      }
    }
  }
  entries.sort((a, b) => a.target - b.target);
  const lines = [t('plugin.pet.assistant.resetHeader')];
  const shown = entries.slice(0, 5);
  for (const entry of shown) {
    lines.push(
      t('plugin.pet.assistant.resetLine', {
        provider: providerLabel(entry.provider),
        window: windowLabel(entry.window, t),
        time: formatCountdown(entry.target - now, t),
      })
    );
  }
  if (entries.length === 0) {
    lines.push(t('plugin.pet.assistant.noResets'));
  } else if (entries.length > shown.length) {
    lines.push(t('plugin.pet.assistant.moreWindows', { count: entries.length - shown.length }));
  }
  const stale = staleLine(context, t);
  if (stale) lines.push(stale);
  return {
    intent: 'reset',
    text: lines.join('\n'),
    suggestions: ['quota', 'forecast', 'pet', 'advice'],
    provider: provider ? providerKey(provider) : null,
  };
}

function answerForecast(context: ResolvedAssistantContext, provider: ProviderQuota | null): AssistantAnswer {
  const t = context.t;
  const now = context.now;
  if (context.snapshot === null) return answerNoData(t);
  const providers = provider ? [provider] : activeProviders(context.snapshot);
  const entries: { provider: ProviderQuota; window: QuotaWindow; left: number }[] = [];
  for (const entry of providers) {
    for (const window of entry.windows) {
      const left = forecastLeft(window, now);
      if (left !== null) entries.push({ provider: entry, window, left });
    }
  }
  entries.sort((a, b) => a.left - b.left);
  const lines = [t('plugin.pet.assistant.forecastHeader')];
  const shown = entries.slice(0, 4);
  for (const entry of shown) {
    lines.push(
      t('plugin.pet.assistant.forecastLine', {
        provider: providerLabel(entry.provider),
        window: windowLabel(entry.window, t),
        time: formatCountdown(entry.left, t),
        rate: Math.max(1, Math.round(entry.window.forecast?.ratePercentPerHour ?? 0)),
      })
    );
  }
  if (entries.length === 0) lines.push(t('plugin.pet.assistant.noForecast'));
  const stale = staleLine(context, t);
  if (stale) lines.push(stale);
  return {
    intent: 'forecast',
    text: lines.join('\n'),
    suggestions: ['quota', 'reset', 'advice', 'pet'],
    provider: provider ? providerKey(provider) : null,
  };
}

function answerCredits(context: ResolvedAssistantContext, provider: ProviderQuota | null): AssistantAnswer {
  const t = context.t;
  if (context.snapshot === null) return answerNoData(t);
  const providers = provider ? [provider] : activeProviders(context.snapshot);
  const lines = [t('plugin.pet.assistant.creditsHeader')];
  let any = false;
  for (const entry of providers) {
    const credits = entry.credits;
    if (!credits) continue;
    any = true;
    if (credits.unlimited) {
      lines.push(t('plugin.pet.assistant.creditsUnlimited', { provider: providerLabel(entry) }));
    } else if (credits.balance) {
      lines.push(
        t('plugin.pet.assistant.creditsLine', {
          provider: providerLabel(entry),
          balance: credits.balance,
        })
      );
    } else if (!credits.hasCredits) {
      lines.push(t('plugin.pet.assistant.creditsEmpty', { provider: providerLabel(entry) }));
    }
  }
  if (!any) lines.push(t('plugin.pet.assistant.noCredits'));
  return {
    intent: 'credits',
    text: lines.join('\n'),
    suggestions: ['quota', 'reset', 'summary', 'pet'],
    provider: provider ? providerKey(provider) : null,
  };
}

function petTip(status: PetStatus, t: AssistantTranslator): string {
  return t(PET_TIPS[status]);
}

function answerPet(context: ResolvedAssistantContext): AssistantAnswer {
  const t = context.t;
  const pet = context.pet;
  const status = petStatus(pet);
  const lines = [
    t('plugin.pet.assistant.petSummary', {
      name: pet.name,
      level: pet.level,
      status: t(`plugin.pet.status.${status}`),
      fullness: Math.round(pet.fullness),
      mood: Math.round(pet.mood),
      energy: Math.round(pet.energy),
    }),
    petTip(status, t),
  ];
  return {
    intent: 'pet',
    text: lines.join('\n'),
    suggestions:
      status === 'hungry'
        ? ['feed', 'play', 'rest', 'summary']
        : status === 'tired'
          ? ['rest', 'feed', 'play', 'summary']
          : status === 'bored'
            ? ['play', 'feed', 'rest', 'summary']
            : ['feed', 'play', 'rest', 'summary'],
    provider: null,
  };
}

function focusActive(settings: Settings, now: number): boolean {
  return settings.focusUntil === -1 || (settings.focusUntil > 0 && settings.focusUntil > now);
}

function summaryLines(context: ResolvedAssistantContext): string[] {
  const t = context.t;
  const now = context.now;
  const lines = [t('plugin.pet.assistant.summaryHeader')];
  const providers = activeProviders(context.snapshot);
  for (const provider of providers.slice(0, 3)) {
    const window = busiestWindow(provider);
    if (!window) continue;
    lines.push(
      t('plugin.pet.assistant.summaryProvider', {
        provider: providerLabel(provider),
        window: windowLabel(window, t),
        used: clampPercent(window.usedPercent),
      })
    );
  }
  if (providers.length === 0) lines.push(t('plugin.pet.assistant.noProviders'));
  const status = petStatus(context.pet);
  lines.push(
    t('plugin.pet.assistant.summaryPet', {
      name: context.pet.name,
      level: context.pet.level,
      status: t(`plugin.pet.status.${status}`),
      fullness: Math.round(context.pet.fullness),
    })
  );
  if (context.settings.pollingPaused) lines.push(t('plugin.pet.assistant.paused'));
  if (focusActive(context.settings, now)) {
    lines.push(
      context.settings.focusUntil === -1
        ? t('plugin.pet.assistant.focusOn')
        : t('plugin.pet.assistant.focusUntil', {
            time: formatCountdown(context.settings.focusUntil - now, t),
          })
    );
  }
  const stale = staleLine(context, t);
  if (stale) lines.push(stale);
  return lines;
}

function answerSummary(context: ResolvedAssistantContext): AssistantAnswer {
  return {
    intent: 'summary',
    text: summaryLines(context).join('\n'),
    suggestions: ['quota', 'reset', 'advice', 'pet'],
    provider: null,
  };
}

function answerBudget(context: ResolvedAssistantContext): AssistantAnswer {
  const t = context.t;
  const budget = context.settings.monthlyBudgetUsd;
  const lines =
    budget > 0
      ? [
          t('plugin.pet.assistant.budgetLine', { amount: Math.round(budget) }),
          t('plugin.pet.assistant.budgetCaveat'),
        ]
      : [t('plugin.pet.assistant.budgetOff')];
  return {
    intent: 'budget',
    text: lines.join('\n'),
    suggestions: ['summary', 'advice', 'quota', 'help'],
    provider: null,
  };
}

function answerFocus(context: ResolvedAssistantContext): AssistantAnswer {
  const t = context.t;
  const until = context.settings.focusUntil;
  let text: string;
  if (until === -1) text = t('plugin.pet.assistant.focusOn');
  else if (until > context.now) {
    text = t('plugin.pet.assistant.focusUntil', {
      time: formatCountdown(until - context.now, t),
    });
  } else {
    text = t('plugin.pet.assistant.focusOff');
  }
  return {
    intent: 'focus',
    text,
    suggestions: ['summary', 'advice', 'quota', 'pet'],
    provider: null,
  };
}

function answerAdvice(context: ResolvedAssistantContext): AssistantAnswer {
  const t = context.t;
  const now = context.now;
  const lines: string[] = [];
  let critical: { provider: ProviderQuota; window: QuotaWindow } | null = null;
  let warn: { provider: ProviderQuota; window: QuotaWindow } | null = null;
  let forecast: { provider: ProviderQuota; window: QuotaWindow; left: number } | null = null;
  for (const provider of activeProviders(context.snapshot)) {
    for (const window of provider.windows) {
      const used = clampPercent(window.usedPercent);
      if (used >= context.settings.thresholds.critical && !critical) {
        critical = { provider, window };
      } else if (used >= context.settings.thresholds.warn && !warn) {
        warn = { provider, window };
      }
      const left = forecastLeft(window, now);
      if (left !== null && (!forecast || left < forecast.left)) {
        forecast = { provider, window, left };
      }
    }
  }
  if (critical) {
    lines.push(
      t('plugin.pet.assistant.adviceCritical', {
        provider: providerLabel(critical.provider),
        window: windowLabel(critical.window, t),
        used: clampPercent(critical.window.usedPercent),
      })
    );
  } else if (warn) {
    lines.push(
      t('plugin.pet.assistant.adviceWarn', {
        provider: providerLabel(warn.provider),
        window: windowLabel(warn.window, t),
        used: clampPercent(warn.window.usedPercent),
      })
    );
  } else if (forecast) {
    lines.push(
      t('plugin.pet.assistant.adviceForecast', {
        provider: providerLabel(forecast.provider),
        window: windowLabel(forecast.window, t),
        time: formatCountdown(forecast.left, t),
      })
    );
  } else if (context.settings.pollingPaused) {
    lines.push(t('plugin.pet.assistant.advicePaused'));
  } else if (focusActive(context.settings, now)) {
    lines.push(t('plugin.pet.assistant.adviceFocus'));
  } else {
    lines.push(t('plugin.pet.assistant.adviceCalm'));
  }
  const status = petStatus(context.pet);
  if (status === 'hungry' || status === 'tired' || status === 'bored') {
    lines.push(petTip(status, t));
  }
  return {
    intent: 'advice',
    text: lines.join('\n'),
    suggestions: ['quota', 'reset', 'pet', 'feed'],
    provider: critical?.provider
      ? providerKey(critical.provider)
      : warn?.provider
        ? providerKey(warn.provider)
        : null,
  };
}

function answerAction(context: ResolvedAssistantContext, action: PetAction): AssistantAnswer {
  const t = context.t;
  if (context.cooldowns?.[action]) {
    return {
      intent: 'action',
      text: t('plugin.pet.assistant.action.busy', { name: context.pet.name }),
      suggestions: ['pet', 'summary', 'help'],
      provider: null,
    };
  }
  return {
    intent: 'action',
    text: t(ACTION_TEXT[action], { name: context.pet.name }),
    suggestions: ['pet', 'play', 'rest', 'summary'],
    action,
    provider: null,
  };
}

function answerHelp(context: ResolvedAssistantContext): AssistantAnswer {
  const t = context.t;
  const lines = [
    t('plugin.pet.assistant.helpIntro'),
    t('plugin.pet.assistant.helpActions'),
    context.localModel
      ? t('plugin.pet.assistant.helpLocalOn', { model: context.localModel })
      : t('plugin.pet.assistant.helpLocalOff'),
  ];
  return {
    intent: 'help',
    text: lines.join('\n'),
    suggestions: ['quota', 'reset', 'pet', 'summary'],
    provider: null,
  };
}

/**
 * Answer one question from local state only. The panel calls this even when a
 * local model is enabled, so its answer is always available as a fallback.
 */
export function answerPetQuestion(question: string, context: AssistantContext): AssistantAnswer {
  const now = context.now ?? Date.now();
  const normalized: ResolvedAssistantContext = { ...context, now };
  const parsed = parseQuestion(question, normalized);
  switch (parsed.intent) {
    case 'greeting':
      return {
        intent: 'greeting',
        text: normalized.t('plugin.pet.assistant.greeting', { name: normalized.pet.name }),
        suggestions: ['quota', 'pet', 'summary', 'help'],
        provider: parsed.provider ? providerKey(parsed.provider) : null,
      };
    case 'thanks':
      return {
        intent: 'thanks',
        text: normalized.t('plugin.pet.assistant.thanks'),
        suggestions: ['quota', 'pet', 'summary', 'help'],
        provider: parsed.provider ? providerKey(parsed.provider) : null,
      };
    case 'help':
      return answerHelp(normalized);
    case 'quota':
      return answerQuota(normalized, parsed.provider);
    case 'reset':
      return answerReset(normalized, parsed.provider);
    case 'busiest':
      return answerBusiest(normalized, parsed.provider);
    case 'forecast':
      return answerForecast(normalized, parsed.provider);
    case 'credits':
      return answerCredits(normalized, parsed.provider);
    case 'pet':
      return answerPet(normalized);
    case 'summary':
      return answerSummary(normalized);
    case 'budget':
      return answerBudget(normalized);
    case 'focus':
      return answerFocus(normalized);
    case 'advice':
      return answerAdvice(normalized);
    case 'action':
      return answerAction(normalized, parsed.action ?? 'pat');
    default:
      return {
        intent: 'unknown',
        text: normalized.t('plugin.pet.assistant.unknown'),
        suggestions: ['help', 'quota', 'pet', 'summary'],
        provider: null,
      };
  }
}

/**
 * A compact, credential-free context for a local model. Account e-mails,
 * session text, sprite data and paths are deliberately never included.
 */
export function buildAssistantContext(
  snapshot: AppSnapshot | null,
  pet: PetState,
  settings: Settings,
  now = Date.now()
): string {
  const providers = activeProviders(snapshot).slice(0, 8).map((provider) => ({
    provider: provider.provider,
    name: providerLabel(provider).slice(0, 80),
    status: provider.status,
    windows: provider.windows.slice(0, 6).map((window) => {
      const target = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      const exhaust = window.forecast?.exhaustsAt
        ? Date.parse(window.forecast.exhaustsAt)
        : NaN;
      return {
        label: windowLabel({ ...window, scope: null }, (key, params) => {
          // Context is data for a model, not UI: resolve the two dynamic keys
          // without importing the rune-based i18n store.
          if (key === 'window.fiveHourSession') return '5-hour';
          if (key === 'window.weekly') return 'weekly';
          return String(params?.kind ?? key);
        }).slice(0, 80),
        scope: window.scope?.slice(0, 60) ?? null,
        usedPercent: clampPercent(window.usedPercent),
        resetsInMinutes: Number.isFinite(target)
          ? Math.max(0, Math.round((target - now) / 60_000))
          : null,
        exhaustsInMinutes: Number.isFinite(exhaust)
          ? Math.max(0, Math.round((exhaust - now) / 60_000))
          : null,
        ratePercentPerHour: window.forecast?.ratePercentPerHour ?? null,
      };
    }),
    credits: provider.credits
      ? {
          hasCredits: provider.credits.hasCredits,
          unlimited: provider.credits.unlimited,
          balance: provider.credits.balance?.slice(0, 40) ?? null,
        }
      : null,
  }));
  const context = {
    now: new Date(now).toISOString(),
    pet: {
      name: pet.name.slice(0, 40),
      level: pet.level,
      xp: pet.xp,
      fullness: Math.round(pet.fullness),
      mood: Math.round(pet.mood),
      energy: Math.round(pet.energy),
      status: petStatus(pet),
    },
    quota: providers,
    preferences: {
      language: settings.language,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      pollingPaused: settings.pollingPaused,
      focusUntil: settings.focusUntil,
      thresholds: settings.thresholds,
    },
  };
  return JSON.stringify(context).slice(0, ASSISTANT_CONTEXT_LIMIT);
}
