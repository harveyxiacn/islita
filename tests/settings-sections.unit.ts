import { test, expect } from '@playwright/test';
import { SECTIONS, SETTINGS_GROUPS, type SettingsGroup } from '../src/lib/settings-sections';

test('every settings card appears exactly once across the visual groups', () => {
  const grouped = (SETTINGS_GROUPS as readonly SettingsGroup[]).flatMap((group) => group.sections);
  expect(grouped).toEqual(SECTIONS);
  expect(new Set(grouped.map((section) => section.id)).size).toBe(grouped.length);
  expect(grouped).toHaveLength(17);
});

test('group ids are unique and every group has at least two cards', () => {
  const ids = SETTINGS_GROUPS.map((group) => group.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const group of SETTINGS_GROUPS) {
    expect(group.sections.length).toBeGreaterThanOrEqual(2);
  }
});
