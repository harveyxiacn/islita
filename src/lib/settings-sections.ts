// The Settings tab's cards and their visual groups. [FRONTEND]
//
// `SECTIONS` is the flat 17-card list shared by the tab's index and the
// command palette ("Go to Settings › Privacy"), so a new card shows up in
// both. `SETTINGS_GROUPS` only adds page headings; it must contain every
// section exactly once (tested in tests/settings-sections.unit.ts).
export interface SettingsSection {
  readonly id: string;
  readonly title: string;
}

export interface SettingsGroup {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly SettingsSection[];
}

export const SETTINGS_GROUPS = [
  {
    id: 'appearance',
    title: 'settings.group.appearance',
    sections: [
      { id: 'appearance', title: 'settings.appearance' },
      { id: 'sidebarItems', title: 'settings.sidebarItems' },
      { id: 'plugins', title: 'settings.plugins' },
      { id: 'presets', title: 'settings.card.presets' },
      { id: 'sizeColour', title: 'settings.sizeColour' },
    ],
  },
  {
    id: 'placement',
    title: 'settings.group.placement',
    sections: [
      { id: 'position', title: 'settings.position' },
      { id: 'behaviour', title: 'settings.behaviour' },
      { id: 'shortcuts', title: 'settings.card.shortcuts' },
    ],
  },
  {
    id: 'usage',
    title: 'settings.group.usage',
    sections: [
      { id: 'providers', title: 'settings.providers' },
      { id: 'data', title: 'settings.data' },
      { id: 'accounts', title: 'settings.accounts' },
    ],
  },
  {
    id: 'alerts',
    title: 'settings.group.alerts',
    sections: [
      { id: 'notifications', title: 'settings.card.notifications' },
      { id: 'integrations', title: 'integrations.title' },
    ],
  },
  {
    id: 'system',
    title: 'settings.group.system',
    sections: [
      { id: 'updates', title: 'settings.card.updates' },
      { id: 'privacy', title: 'settings.card.privacy' },
      { id: 'about', title: 'settings.about' },
      { id: 'backup', title: 'settings.card.backup' },
    ],
  },
] as const satisfies readonly SettingsGroup[];

export type SectionId = (typeof SETTINGS_GROUPS)[number]['sections'][number]['id'];

/** Widened view of the table: `as const` keeps the ids literal for `SectionId`,
 *  but a union of tuples cannot be `flatMap`ped. */
const GROUPS: readonly SettingsGroup[] = SETTINGS_GROUPS;

/** Flat page/palette order. */
export const SECTIONS: readonly SettingsSection[] = GROUPS.flatMap(
  (group) => group.sections
);
