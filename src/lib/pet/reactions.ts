// Random click reactions. [FRONTEND]
//
// A pat is the pet's most frequent interaction, so one fixed line and one
// fixed pose wears out quickly. Each click now picks one of six small
// performances and one of three lines written for the active voice. The
// performance is described once here and rendered by every surface:
//
//   * the bundled DeepSeek chibi plays the matching H3 clip;
//   * Hachiware swaps to its matching sticker card and plays a CSS beat;
//   * Mochi swaps expression and plays the same CSS beat;
//   * the detached window uses the same mappings, so both windows agree.
//
// The module is pure so the no-repeat rule and the catalogue coverage can be
// tested without a browser.
import type { PetAnimation } from './animations';
import type { PetDesktopMode } from './desktop';
import type { PetReaction, PetStatus } from './pet';
import type { PetVoice } from './speech';

export const PET_CLICK_REACTIONS = [
  'nuzzle',
  'bounce',
  'zoomies',
  'munch',
  'doze',
  'sulk',
] as const;

export type PetClickReaction = (typeof PET_CLICK_REACTIONS)[number];

/** Lines available for every voice and reaction: `.1`, `.2`, `.3` in i18n. */
export const PET_CLICK_LINE_COUNT = 3;

export type PetClickMood = PetStatus | PetReaction;

export interface PetClickReactionSpec {
  id: PetClickReaction;
  /** H3 performance used by the bundled DeepSeek chibi. */
  clip: PetAnimation;
  /** Desktop mode; also drives the static card and the existing CSS beats. */
  mode: PetDesktopMode;
  /** Sticker-card mood for DeepSeek transformed and Hachiware. */
  mood: PetClickMood;
  /** Expression for the inline Mochi mascot. */
  status: PetStatus;
  /** How long the performance stays on screen before the pet settles. */
  holdMs: number;
}

const SPECS: Record<PetClickReaction, PetClickReactionSpec> = {
  // Lean into the hand, then settle back with a soft sway.
  nuzzle: { id: 'nuzzle', clip: 'happy', mode: 'happy', mood: 'pat', status: 'happy', holdMs: 2600 },
  // A single delighted hop. The jump clip is one-shot, so hold it to its end.
  bounce: { id: 'bounce', clip: 'jump', mode: 'jump', mood: 'happy', status: 'happy', holdMs: 2600 },
  // A short burst of running in place.
  zoomies: { id: 'zoomies', clip: 'run', mode: 'run', mood: 'play', status: 'happy', holdMs: 2400 },
  // Sniffing out a snack and chewing.
  munch: { id: 'munch', clip: 'eat', mode: 'eat', mood: 'feed', status: 'hungry', holdMs: 2800 },
  // A sudden yawn and a doze.
  doze: { id: 'doze', clip: 'sleep', mode: 'sleep', mood: 'tired', status: 'tired', holdMs: 3200 },
  // A theatrical little grumble.
  sulk: { id: 'sulk', clip: 'sad', mode: 'sad', mood: 'bored', status: 'bored', holdMs: 2600 },
};

export function isPetClickReaction(raw: unknown): raw is PetClickReaction {
  return typeof raw === 'string' && (PET_CLICK_REACTIONS as readonly string[]).includes(raw);
}

export function clickReactionSpec(id: PetClickReaction): PetClickReactionSpec {
  return SPECS[id];
}

/** The reproducible half of a reaction: send it to the other window to replay. */
export interface PetClickSeed {
  reaction: PetClickReaction;
  /** Zero-based line variant; i18n keys use the one-based suffix. */
  variant: number;
}

export interface PetClickPerformance extends PetClickReactionSpec, PetClickSeed {
  lineKey: string;
}

/** i18n key of one line, e.g. `plugin.pet.reaction.mochi.munch.2`. */
export function clickLineKey(voice: PetVoice, seed: PetClickSeed): string {
  const raw = Number.isFinite(seed.variant) ? Math.trunc(seed.variant) : 0;
  const variant = Math.min(PET_CLICK_LINE_COUNT - 1, Math.max(0, raw));
  return `plugin.pet.reaction.${voice}.${seed.reaction}.${variant + 1}`;
}

/** Repair a reaction seed from an event or an older build. */
export function sanitizeClickSeed(raw: unknown): PetClickSeed | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isPetClickReaction(value.reaction)) return null;
  const variant = Number.isFinite(value.variant)
    ? Math.trunc(value.variant as number)
    : 0;
  return {
    reaction: value.reaction,
    variant: Math.min(PET_CLICK_LINE_COUNT - 1, Math.max(0, variant)),
  };
}

function randomIndex(length: number, random: () => number): number {
  if (length <= 1) return 0;
  const value = Number(random());
  const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999_999) : 0;
  return Math.floor(safe * length);
}

/**
 * Pick a performance and line. `previous` is excluded when another reaction is
 * available, so two clicks in a row always look different; the line variant is
 * independent, giving each reaction a little more variety.
 */
export function pickClickPerformance(
  voice: PetVoice,
  options: { previous?: PetClickReaction | null; random?: () => number } = {}
): PetClickPerformance {
  const random = options.random ?? Math.random;
  const previous = options.previous ?? null;
  const pool =
    previous && PET_CLICK_REACTIONS.length > 1
      ? PET_CLICK_REACTIONS.filter((reaction) => reaction !== previous)
      : PET_CLICK_REACTIONS;
  const reaction = pool[randomIndex(pool.length, random)] ?? pool[0];
  const variant = randomIndex(PET_CLICK_LINE_COUNT, random);
  const spec = SPECS[reaction];
  return {
    ...spec,
    reaction,
    variant,
    lineKey: clickLineKey(voice, { reaction, variant }),
  };
}

/** UI-friendly subset: both windows can reproduce the full performance. */
export function pickClickSeed(
  voice: PetVoice,
  previous: PetClickReaction | null = null,
  random: () => number = Math.random
): PetClickSeed {
  const { reaction, variant } = pickClickPerformance(voice, { previous, random });
  return { reaction, variant };
}
