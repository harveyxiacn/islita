import { test, expect } from '@playwright/test';
import { enabledPlugins, isPluginEnabled, withPluginEnabled } from '../src/lib/plugins/enabled';

const PLUGINS = [
  { id: 'providers' },
  { id: 'mail' },
  { id: 'calendar' },
  { id: 'pet' },
];

test('a plugin is enabled unless it is in the opt-out list', () => {
  expect(isPluginEnabled('pet', [])).toBe(true);
  expect(isPluginEnabled('pet', ['mail'])).toBe(true);
  expect(isPluginEnabled('pet', ['mail', 'pet'])).toBe(false);
});

test('filtering keeps registry order and ignores unknown ids', () => {
  expect(enabledPlugins(PLUGINS, [])).toEqual(PLUGINS);
  expect(enabledPlugins(PLUGINS, ['mail', 'pet']).map((p) => p.id)).toEqual([
    'providers',
    'calendar',
  ]);
  expect(enabledPlugins(PLUGINS, ['not-a-plugin']).map((p) => p.id)).toEqual([
    'providers',
    'mail',
    'calendar',
    'pet',
  ]);
});

test('switching off appends once; switching on removes every copy', () => {
  expect(withPluginEnabled([], 'mail', false)).toEqual(['mail']);
  expect(withPluginEnabled(['mail'], 'mail', false)).toEqual(['mail']);
  expect(withPluginEnabled(['pet', 'mail', 'pet'], 'pet', false)).toEqual(['mail', 'pet']);
  expect(withPluginEnabled(['mail', 'pet'], 'mail', true)).toEqual(['pet']);
  expect(withPluginEnabled(['pet'], 'mail', true)).toEqual(['pet']);
});

test('the helper never mutates the settings array', () => {
  const disabled = ['mail'];
  const next = withPluginEnabled(disabled, 'pet', false);
  expect(next).not.toBe(disabled);
  expect(disabled).toEqual(['mail']);
  const filtered = enabledPlugins(PLUGINS, disabled);
  expect(filtered).not.toBe(PLUGINS);
  expect(PLUGINS).toHaveLength(4);
});
