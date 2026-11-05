// Desktop-pet simulation and persistence schema. [FRONTEND]
//
// Keeping this module free of Svelte and DOM APIs makes the needs model,
// levelling and storage repair testable, and lets a future detached pet window
// reuse exactly the same state machine with a different persistence wrapper.
import { parseStoredSprite, type PetSprite } from './sprite';

export const PET_VERSION = 1 as const;
export const PET_PLUGIN_ID = 'pet';
export const PET_DEFAULT_NAME = 'Mochi';
export const PET_NAME_MAX = 20;
/** Bundled appearances. `mochi` is the original inline SVG mascot. */
export const PET_SKINS = ['mochi', 'deepseek', 'hachiware'] as const;
export type PetSkin = (typeof PET_SKINS)[number];
export const PET_DEFAULT_SKIN: PetSkin = 'mochi';
/** DeepSeek 大肥鱼 has a resident chibi form and a transformed form. */
export const DEEPSEEK_FORMS = ['chibi', 'transformed'] as const;
export type DeepSeekForm = (typeof DEEPSEEK_FORMS)[number];
export const PET_DEFAULT_DEEPSEEK_FORM: DeepSeekForm = 'chibi';
/** Selectable scene themes; `auto` follows the selected bundled skin. */
export const PET_THEMES = ['auto', 'matcha', 'abyss', 'aquarium'] as const;
export type PetTheme = (typeof PET_THEMES)[number];
export const PET_DEFAULT_THEME: PetTheme = 'auto';
/** Longest accepted imported-pack id; backend ids are ASCII slugs. */
export const PET_PACK_ID_MAX = 64;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PET_STAT_MAX = 100;
/** Lifetime feed count is a keepsake, not a resource; only a sanity cap. */
export const MEALS_MAX = 1_000_000;
export const MAX_LEVEL = 99;
export const XP_BASE = 80;
export const XP_STEP = 40;
/** A long absence should leave a pet to care for, not a completely wiped one. */
export const OFFLINE_DECAY_CAP_MS = 12 * 60 * 60 * 1000;
export const OFFLINE_NOTICE_MS = 5 * 60 * 1000;

export type PetStatus = 'happy' | 'ok' | 'hungry' | 'tired' | 'bored';
export type PetAction = 'feed' | 'play' | 'rest' | 'pat';
export type PetReaction = PetAction | 'offline';

export interface PetState {
  version: typeof PET_VERSION;
  name: string;
  level: number;
  xp: number;
  fullness: number;
  mood: number;
  energy: number;
  /** Lifetime feed count, shown as bowls eaten. It never decays. */
  meals: number;
  /** Selected bundled appearance; ignored while a custom `sprite` is set. */
  skin: PetSkin;
  /** DeepSeek only: which of the two supplied forms is drawn. */
  deepseekForm: DeepSeekForm;
  /** Scene theme; `auto` follows the skin. */
  theme: PetTheme;
  /** Selected imported DyberPet pack, or null for the bundled art. */
  packId: string | null;
  /** Epoch ms of the last simulation/persistence update. */
  lastSeen: number;
  sprite: PetSprite | null;
}

/** Need decay per hour of elapsed time. */
export const DECAY_PER_HOUR = {
  fullness: 6,
  mood: 3,
  energy: 4,
} as const;

/** Action deltas and the XP each interaction grants. */
export const ACTION_EFFECTS: Record<
  PetAction,
  { fullness: number; mood: number; energy: number; xp: number }
> = {
  feed: { fullness: 26, mood: 4, energy: -1, xp: 8 },
  play: { fullness: -4, mood: 22, energy: -12, xp: 12 },
  rest: { fullness: -2, mood: 3, energy: 28, xp: 6 },
  pat: { fullness: 0, mood: 10, energy: 0, xp: 4 },
};

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sanitizeName(raw: unknown, fallback = PET_DEFAULT_NAME): string {
  if (typeof raw !== 'string') return fallback;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, PET_NAME_MAX).trim();
  return name || fallback;
}

export function isPetSkin(raw: unknown): raw is PetSkin {
  return typeof raw === 'string' && (PET_SKINS as readonly string[]).includes(raw);
}

export function isDeepSeekForm(raw: unknown): raw is DeepSeekForm {
  return typeof raw === 'string' && (DEEPSEEK_FORMS as readonly string[]).includes(raw);
}

export function isPetTheme(raw: unknown): raw is PetTheme {
  return typeof raw === 'string' && (PET_THEMES as readonly string[]).includes(raw);
}

/** Backend pack ids are ASCII slugs; anything else is treated as absent. */
export function sanitizePackId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id.length <= PET_PACK_ID_MAX && PACK_ID.test(id) ? id : null;
}

export function xpForNextLevel(level: number): number {
  const safe = clamp(Math.trunc(level), 1, MAX_LEVEL);
  return XP_BASE + (safe - 1) * XP_STEP;
}

export interface XpResult {
  level: number;
  xp: number;
  leveledUp: boolean;
}

/** Add XP, carrying over through as many level thresholds as necessary. */
export function grantXp(level: number, xp: number, amount: number): XpResult {
  let nextLevel = clamp(Math.trunc(level), 1, MAX_LEVEL);
  let nextXp = clamp(Math.trunc(xp), 0, xpForNextLevel(nextLevel) - 1);
  nextXp += Math.max(0, Math.trunc(amount));
  let leveledUp = false;
  while (nextLevel < MAX_LEVEL && nextXp >= xpForNextLevel(nextLevel)) {
    nextXp -= xpForNextLevel(nextLevel);
    nextLevel += 1;
    leveledUp = true;
  }
  if (nextLevel >= MAX_LEVEL) {
    nextXp = Math.min(nextXp, xpForNextLevel(MAX_LEVEL) - 1);
  }
  return { level: nextLevel, xp: nextXp, leveledUp };
}

export function createDefaultPet(now = Date.now(), skin: PetSkin = PET_DEFAULT_SKIN): PetState {
  return {
    version: PET_VERSION,
    name: PET_DEFAULT_NAME,
    level: 1,
    xp: 0,
    fullness: 82,
    mood: 76,
    energy: 70,
    meals: 0,
    skin: isPetSkin(skin) ? skin : PET_DEFAULT_SKIN,
    deepseekForm: PET_DEFAULT_DEEPSEEK_FORM,
    theme: PET_DEFAULT_THEME,
    packId: null,
    lastSeen: now,
    sprite: null,
  };
}

/**
 * Parse whatever was in localStorage. Every field is repaired or clamped;
 * strings, arrays and null become a fresh pet. The parser never throws.
 */
export function parsePetState(raw: unknown, now = Date.now()): PetState {
  const base = createDefaultPet(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const level = clamp(
    Number.isFinite(value.level) ? Math.trunc(value.level as number) : base.level,
    1,
    MAX_LEVEL
  );
  const nextXp = xpForNextLevel(level);
  const xp = Number.isFinite(value.xp)
    ? clamp(Math.trunc(value.xp as number), 0, nextXp - 1)
    : base.xp;
  const stat = (key: 'fullness' | 'mood' | 'energy'): number =>
    Number.isFinite(value[key])
      ? clamp(value[key] as number, 0, PET_STAT_MAX)
      : base[key];
  const lastSeen =
    Number.isFinite(value.lastSeen) && (value.lastSeen as number) > 0
      ? Math.min(value.lastSeen as number, now)
      : now;
  return {
    version: PET_VERSION,
    name: sanitizeName(value.name),
    level,
    xp,
    fullness: stat('fullness'),
    mood: stat('mood'),
    energy: stat('energy'),
    meals: Number.isFinite(value.meals)
      ? clamp(Math.trunc(value.meals as number), 0, MEALS_MAX)
      : base.meals,
    skin: isPetSkin(value.skin) ? value.skin : base.skin,
    deepseekForm: isDeepSeekForm(value.deepseekForm) ? value.deepseekForm : base.deepseekForm,
    theme: isPetTheme(value.theme) ? value.theme : base.theme,
    packId: sanitizePackId(value.packId),
    lastSeen,
    sprite: parseStoredSprite(value.sprite),
  };
}

export interface DecayResult {
  state: PetState;
  /** Wall-clock time since the state was saved. */
  elapsedMs: number;
  /** Time actually applied after the offline cap. */
  appliedMs: number;
}

/** Advance needs by elapsed time. Long offline gaps are capped. */
export function advancePet(
  state: PetState,
  now = Date.now(),
  maxElapsedMs = OFFLINE_DECAY_CAP_MS
): DecayResult {
  const elapsedMs = Math.max(0, now - state.lastSeen);
  const appliedMs = Math.min(elapsedMs, Math.max(0, maxElapsedMs));
  const hours = appliedMs / 3_600_000;
  return {
    state: {
      ...state,
      fullness: clamp(state.fullness - DECAY_PER_HOUR.fullness * hours, 0, PET_STAT_MAX),
      mood: clamp(state.mood - DECAY_PER_HOUR.mood * hours, 0, PET_STAT_MAX),
      energy: clamp(state.energy - DECAY_PER_HOUR.energy * hours, 0, PET_STAT_MAX),
      lastSeen: now,
    },
    elapsedMs,
    appliedMs,
  };
}

export interface ActionResult {
  state: PetState;
  leveledUp: boolean;
}

/** Apply one interaction after the panel has advanced elapsed decay. */
export function applyAction(
  state: PetState,
  action: PetAction,
  now = Date.now()
): ActionResult {
  const effect = ACTION_EFFECTS[action];
  const xp = grantXp(state.level, state.xp, effect.xp);
  return {
    state: {
      ...state,
      fullness: clamp(state.fullness + effect.fullness, 0, PET_STAT_MAX),
      mood: clamp(state.mood + effect.mood, 0, PET_STAT_MAX),
      energy: clamp(state.energy + effect.energy, 0, PET_STAT_MAX),
      meals: action === 'feed' ? clamp(state.meals + 1, 0, MEALS_MAX) : state.meals,
      level: xp.level,
      xp: xp.xp,
      lastSeen: now,
    },
    leveledUp: xp.leveledUp,
  };
}

/**
 * One expression for the whole face and status chip. Hunger and tiredness win
 * over mood, so a very hungry pet never claims to be merely bored.
 */
export function petStatus(state: Pick<PetState, 'fullness' | 'mood' | 'energy'>): PetStatus {
  if (state.fullness < 30) return 'hungry';
  if (state.energy < 30) return 'tired';
  if (state.mood < 40) return 'bored';
  if (state.fullness >= 70 && state.mood >= 65 && state.energy >= 60) return 'happy';
  return 'ok';
}

/**
 * The rice-eating cutscene uses the bundled DeepSeek chibi artwork only.
 * A custom sprite or a DyberPet pack must keep showing its own art.
 */
export function hasRiceFeast(
  state: Pick<PetState, 'skin' | 'deepseekForm' | 'sprite' | 'packId'>
): boolean {
  return (
    state.skin === 'deepseek' &&
    state.deepseekForm === 'chibi' &&
    state.sprite === null &&
    state.packId === null
  );
}
