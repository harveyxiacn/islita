// Desktop-pet scene themes. [FRONTEND]
//
// Three hand-drawn scenes, one per bundled character, plus `auto` which maps a
// skin to its own theme. The theme only affects the pet panel, the detached
// window and the pet's speech chrome — never the rest of the island — so it is
// safe to keep with the pet state instead of the global settings file.
//
// Pure module: the panel, the detached window and the tests share it.
import type { MessageKey } from '$lib/i18n/i18n.svelte';
import type { PetSkin, PetTheme } from './pet';

/** A theme with a concrete scene; `auto` is a choice, not a drawn theme. */
export type PetThemeId = Exclude<PetTheme, 'auto'>;

export const PET_THEME_IDS = ['matcha', 'abyss', 'aquarium'] as const;

export interface PetThemeOption {
  id: PetTheme;
  label: MessageKey;
  hint: MessageKey;
}

export const PET_THEME_OPTIONS: readonly PetThemeOption[] = [
  {
    id: 'auto',
    label: 'plugin.pet.theme.auto',
    hint: 'plugin.pet.theme.auto.hint',
  },
  {
    id: 'matcha',
    label: 'plugin.pet.theme.matcha',
    hint: 'plugin.pet.theme.matcha.hint',
  },
  {
    id: 'abyss',
    label: 'plugin.pet.theme.abyss',
    hint: 'plugin.pet.theme.abyss.hint',
  },
  {
    id: 'aquarium',
    label: 'plugin.pet.theme.aquarium',
    hint: 'plugin.pet.theme.aquarium.hint',
  },
];

/** The scene each bundled character was drawn for. */
export function themeForSkin(skin: PetSkin): PetThemeId {
  switch (skin) {
    case 'deepseek':
      return 'abyss';
    case 'hachiware':
      return 'aquarium';
    default:
      return 'matcha';
  }
}

/** `auto` follows the character; an explicit choice always wins. */
export function resolvePetTheme(skin: PetSkin, theme: PetTheme): PetThemeId {
  return theme === 'auto' ? themeForSkin(skin) : theme;
}

export function isPetThemeId(raw: unknown): raw is PetThemeId {
  return typeof raw === 'string' && (PET_THEME_IDS as readonly string[]).includes(raw);
}
