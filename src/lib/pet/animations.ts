// DeepSeek 大肥鱼 animation clips. [FRONTEND]
//
// Each clip is a five-second MiniMax H3 performance, keyed off its green
// screen and packed into one 60-frame horizontal WebP strip (12 fps, 256 px
// cells) by the generation pipeline documented in `docs/plans/desktop-pet.md`.
// The strips are shared by the island panel and the detached desktop window;
// `PetFilm.svelte` is the only player.
export const PET_ANIMATION_CLIPS = [
  'idle',
  'walk',
  'run',
  'jump',
  'fall',
  'eat',
  'sleep',
  'happy',
  'sad',
] as const;

export type PetAnimation = (typeof PET_ANIMATION_CLIPS)[number];

/** Every clip was generated as 124 frames at 24 fps and thinned to 60. */
export const PET_ANIMATION_FRAMES = 60;
export const PET_ANIMATION_FPS = 12;
/** One loop of the strip, in milliseconds. */
export const PET_ANIMATION_MS = (PET_ANIMATION_FRAMES / PET_ANIMATION_FPS) * 1000;

/**
 * Playback rate per clip. Calm performances run at 12 fps; the energetic ones
 * (run, jump, fall, happy) keep the generated 24 fps so a five-second H3 take
 * becomes a 2.5-second loop instead of slow motion.
 */
const CLIP_FPS: Record<PetAnimation, number> = {
  idle: 12,
  walk: 16,
  run: 24,
  jump: 24,
  fall: 24,
  eat: 12,
  sleep: 12,
  happy: 24,
  sad: 12,
};

export function animationFps(clip: PetAnimation): number {
  return CLIP_FPS[clip];
}

/** How long one pass of a clip takes at its playback rate. */
export function animationMs(clip: PetAnimation): number {
  return (PET_ANIMATION_FRAMES / animationFps(clip)) * 1000;
}

export function isPetAnimation(raw: unknown): raw is PetAnimation {
  return typeof raw === 'string' && (PET_ANIMATION_CLIPS as readonly string[]).includes(raw);
}

/** Horizontal strip: 60 cells of 256 px, transparent background. */
export function animationSrc(clip: PetAnimation): string {
  return `/pet/animations/${clip}-sheet.webp`;
}

/** First frame, used before the strip decodes and for reduced motion. */
export function animationPoster(clip: PetAnimation): string {
  return `/pet/animations/${clip}-poster.webp`;
}

/** Accessible description, e.g. "Fishy is asleep." */
export function animationLabelKey(clip: PetAnimation): string {
  return `plugin.pet.animation.${clip}`;
}
