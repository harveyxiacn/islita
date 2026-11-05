// What the desktop pet says. [FRONTEND]
//
// The lines are original, short character-voice lines inspired by the supplied
// artwork and the public catchphrases around DeepSeek 大肥鱼 (food, sleep,
// "no pressure") and Hachiware (「おい！」「えー！」, cheerful and easily
// surprised). They are not transcriptions of copyrighted dialogue.
//
// This module is pure: it maps the island's quota/status state and the pet's
// needs to a situation id, and a situation to an i18n key. The pet panel and
// the ring popover share it; neither needs the other's component state.
import { severityOf } from '$lib/severity';
import { petStatus, type DeepSeekForm, type PetReaction, type PetSkin, type PetState, type PetStatus } from './pet';
import { speechImage } from './skins';
import type { AppSnapshot, ProviderQuota, Settings } from '$lib/types';

export type PetSituation =
  | PetStatus
  | PetReaction
  | 'warn'
  | 'critical'
  | 'reset'
  | 'forecast'
  | 'providerDown'
  | 'paused'
  | 'taskDone';

export type PetVoice = 'mochi' | 'deepseek-chibi' | 'deepseek-transformed' | 'hachiware';

export function petVoice(skin: PetSkin, form: DeepSeekForm): PetVoice {
  if (skin === 'deepseek') return form === 'transformed' ? 'deepseek-transformed' : 'deepseek-chibi';
  return skin === 'hachiware' ? 'hachiware' : 'mochi';
}

/** i18n key of one spoken line; callers use `tDyn` with optional `{name}`. */
export function sayKey(voice: PetVoice, situation: PetSituation): string {
  return `plugin.pet.say.${voice}.${situation}`;
}

const DOWN_STATUSES = new Set(['error', 'token_expired', 'not_logged_in', 'rate_limited']);

/** True when the forecast says the window runs out before it resets. */
function forecastSoon(q: ProviderQuota, now: number): boolean {
  return q.windows.some((w) => {
    const at = w.forecast?.exhaustsAt ? Date.parse(w.forecast.exhaustsAt) : NaN;
    return Number.isFinite(at) && at > now;
  });
}

/**
 * The most relevant thing one provider is doing right now, for its popover.
 * A critical window outranks a connection problem, which outranks a warning
 * and a forecast; the calm "ok" line is the fallback.
 */
export function quotaSituation(q: ProviderQuota, settings: Settings, now = Date.now()): PetSituation {
  let warn = false;
  for (const w of q.windows) {
    const severity = severityOf(w.usedPercent, settings.thresholds);
    if (severity === 'critical') return 'critical';
    if (severity === 'warn') warn = true;
  }
  if (q.status !== 'ok' && DOWN_STATUSES.has(q.status)) return 'providerDown';
  if (warn) return 'warn';
  if (forecastSoon(q, now)) return 'forecast';
  return 'ok';
}

/**
 * The island-wide situation shown in the pet panel. Polling paused is the
 * quietest, most immediate state; after that a critical window, a provider
 * that cannot be reached, a warning, a forecast, and finally the pet's own
 * needs (hungry / tired / bored / happy / ok).
 */
export function petSituation(
  snapshot: AppSnapshot | null,
  settings: Settings,
  pet: Pick<PetState, 'fullness' | 'mood' | 'energy'>,
  now = Date.now()
): PetSituation {
  if (settings.pollingPaused) return 'paused';
  let warn = false;
  let down = false;
  let forecast = false;
  for (const q of snapshot?.providers ?? []) {
    if (q.status === 'disabled') continue;
    const situation = quotaSituation(q, settings, now);
    if (situation === 'critical') return 'critical';
    if (situation === 'providerDown') down = true;
    else if (situation === 'warn') warn = true;
    else if (situation === 'forecast') forecast = true;
  }
  if (down) return 'providerDown';
  if (warn) return 'warn';
  if (forecast) return 'forecast';
  return petStatus(pet);
}

/** The expression a situation should wear; also used by the pet panel. */
export function situationMood(situation: PetSituation): PetStatus | PetReaction {
  switch (situation) {
    case 'warn':
    case 'forecast':
      return 'bored';
    case 'critical':
      return 'pat';
    case 'providerDown':
      return 'tired';
    case 'paused':
      return 'rest';
    case 'reset':
    case 'taskDone':
      return 'happy';
    default:
      return situation;
  }
}

/** The expression used beside a spoken line in the popover. */
export function speechAvatar(voice: PetVoice, situation: PetSituation): string | null {
  const skin: PetSkin =
    voice === 'deepseek-chibi' || voice === 'deepseek-transformed'
      ? 'deepseek'
      : voice === 'hachiware'
        ? 'hachiware'
        : 'mochi';
  const form: DeepSeekForm = voice === 'deepseek-transformed' ? 'transformed' : 'chibi';
  return speechImage(skin, form, situationMood(situation));
}
