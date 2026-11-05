// Bundled desktop-pet skins. [FRONTEND]
//
// The DeepSeek and Hachiware cards are derivative fan artwork supplied by the
// project owner, who attests that it is licensed for commercial use. The
// prepare-pet-assets.py script turns the source images into the opaque square
// WebP cards in static/pet/; this module only maps a mood or interaction to
// one of them. `mochi` has no cards and falls back to the original inline SVG.
// DeepSeek has two supplied forms (Q版 chibi and 变身 transformed) with their
// own card sets.
import type { MessageKey } from '$lib/i18n/i18n.svelte';
import type {
  DeepSeekForm,
  PetReaction,
  PetSkin,
  PetStatus,
} from './pet';

export type PetMood = PetStatus | PetReaction;

export interface PetSkinOption {
  id: PetSkin;
  label: MessageKey;
  /** Name applied when the pet still carries another skin's default name. */
  defaultName: MessageKey;
}

export interface PetFormOption {
  id: DeepSeekForm;
  label: MessageKey;
}

const DEEPSEEK_CHIBI_IMAGES: Record<PetMood, string> = {
  happy: '/pet/deepseek-chibi-happy.webp',
  ok: '/pet/deepseek-chibi-bored.webp',
  hungry: '/pet/deepseek-chibi-feed.webp',
  tired: '/pet/deepseek-chibi-bored.webp',
  bored: '/pet/deepseek-chibi-bored.webp',
  feed: '/pet/deepseek-chibi-feed.webp',
  play: '/pet/deepseek-chibi-happy.webp',
  rest: '/pet/deepseek-chibi-bored.webp',
  pat: '/pet/deepseek-chibi-surprised.webp',
  offline: '/pet/deepseek-chibi-bored.webp',
};

const DEEPSEEK_TRANSFORMED_IMAGES: Record<PetMood, string> = {
  happy: '/pet/deepseek-transformed-happy.webp',
  ok: '/pet/deepseek-transformed-ok.webp',
  hungry: '/pet/deepseek-transformed-neutral.webp',
  tired: '/pet/deepseek-transformed-neutral.webp',
  bored: '/pet/deepseek-transformed-neutral.webp',
  feed: '/pet/deepseek-transformed-ok.webp',
  play: '/pet/deepseek-transformed-happy.webp',
  rest: '/pet/deepseek-transformed-neutral.webp',
  pat: '/pet/deepseek-transformed-happy.webp',
  offline: '/pet/deepseek-transformed-neutral.webp',
};

const HACHIWARE_IMAGES: Record<PetMood, string> = {
  happy: '/pet/hachiware-happy.webp',
  ok: '/pet/hachiware-ok.webp',
  hungry: '/pet/hachiware-feed.webp',
  tired: '/pet/hachiware-tired.webp',
  bored: '/pet/hachiware-bored.webp',
  feed: '/pet/hachiware-feed.webp',
  play: '/pet/hachiware-play.webp',
  rest: '/pet/hachiware-tired.webp',
  pat: '/pet/hachiware-pat.webp',
  offline: '/pet/hachiware-tired.webp',
};

export const PET_SKIN_OPTIONS: readonly PetSkinOption[] = [
  {
    id: 'mochi',
    label: 'plugin.pet.skin.mochi',
    defaultName: 'plugin.pet.skin.name.mochi',
  },
  {
    id: 'deepseek',
    label: 'plugin.pet.skin.deepseek',
    defaultName: 'plugin.pet.skin.name.deepseek',
  },
  {
    id: 'hachiware',
    label: 'plugin.pet.skin.hachiware',
    defaultName: 'plugin.pet.skin.name.hachiware',
  },
];

export const DEEPSEEK_FORM_OPTIONS: readonly PetFormOption[] = [
  { id: 'chibi', label: 'plugin.pet.form.chibi' },
  { id: 'transformed', label: 'plugin.pet.form.transformed' },
];

function deepseekImages(form: DeepSeekForm): Record<PetMood, string> {
  return form === 'transformed' ? DEEPSEEK_TRANSFORMED_IMAGES : DEEPSEEK_CHIBI_IMAGES;
}

/**
 * The bundled card for a skin, form and mood, or `null` for the inline mascot.
 * Unknown ids cannot occur in a parsed state; the fallback keeps the panel
 * harmless if a future build removes a skin while an old state is stored.
 */
export function skinImage(skin: PetSkin, form: DeepSeekForm, mood: PetMood): string | null {
  switch (skin) {
    case 'deepseek':
      return deepseekImages(form)[mood];
    case 'hachiware':
      return HACHIWARE_IMAGES[mood];
    default:
      return null;
  }
}

/** Which card represents the character while it says a mood/event line. */
export function speechImage(skin: PetSkin, form: DeepSeekForm, mood: PetMood): string | null {
  return skinImage(skin, form, mood);
}
