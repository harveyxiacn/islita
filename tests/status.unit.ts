import { test, expect } from '@playwright/test';
import {
  impactKey,
  indicatorKey,
  indicatorTone,
  normalizeImpact,
  normalizeIndicator,
  normalizeState,
  stateKey,
} from '../src/lib/plugins/status';

test('known indicators are normalised; anything else is explicitly unknown', () => {
  expect(normalizeIndicator('none')).toBe('none');
  expect(normalizeIndicator('  MINOR ')).toBe('minor');
  expect(normalizeIndicator('Maintenance')).toBe('maintenance');
  expect(normalizeIndicator('degraded')).toBe('unknown');
  expect(normalizeIndicator('')).toBe('unknown');
  expect(normalizeIndicator(null)).toBe('unknown');
  expect(normalizeIndicator(42)).toBe('unknown');
});

test('indicator severity maps onto the four dot tones', () => {
  expect(indicatorTone('none')).toBe('ok');
  expect(indicatorTone('minor')).toBe('warn');
  expect(indicatorTone('major')).toBe('critical');
  expect(indicatorTone('critical')).toBe('critical');
  expect(indicatorTone('maintenance')).toBe('info');
  expect(indicatorTone('something-new')).toBe('unknown');
});

test('indicator keys always resolve to an existing catalogue family', () => {
  expect(indicatorKey('none')).toBe('plugin.status.indicator.none');
  expect(indicatorKey(' MINOR ')).toBe('plugin.status.indicator.minor');
  expect(indicatorKey('???')).toBe('plugin.status.indicator.unknown');
});

test('an unknown impact degrades to none rather than inventing a badge', () => {
  expect(normalizeImpact('minor')).toBe('minor');
  expect(normalizeImpact('CRITICAL')).toBe('critical');
  expect(normalizeImpact('scheduled')).toBe('none');
  expect(normalizeImpact(undefined)).toBe('none');
  expect(impactKey('major')).toBe('plugin.status.impact.major');
  expect(impactKey('unexpected')).toBe('plugin.status.impact.none');
});

test('known incident states map to catalogue keys and unknown ones stay null', () => {
  expect(normalizeState('monitoring')).toBe('monitoring');
  expect(normalizeState('IN_PROGRESS')).toBe('in_progress');
  expect(normalizeState('paused')).toBeNull();
  expect(stateKey('resolved')).toBe('plugin.status.state.resolved');
  expect(stateKey('paused')).toBeNull();
});

test('an unknown indicator can never read as operational', () => {
  const key = indicatorKey('operational');
  expect(key).toBe('plugin.status.indicator.unknown');
  expect(indicatorTone('operational')).not.toBe('ok');
});
