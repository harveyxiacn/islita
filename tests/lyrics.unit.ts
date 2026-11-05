import { test, expect } from '@playwright/test';
import { activeLineAt, currentLyric, parseLrc } from '../src/lib/plugins/lrc';

test('parses metadata, timestamps, repeated chorus tags and the offset', () => {
  const doc = parseLrc(`
[ti:Midnight Train]
[ar:The Local]
[al:Demo]
[offset:+250]
[00:01.5]First line
[00:05.00][01:00.25]Chorus
[00:10]Last line
`);
  expect(doc.title).toBe('Midnight Train');
  expect(doc.artist).toBe('The Local');
  expect(doc.album).toBe('Demo');
  expect(doc.offsetMs).toBe(250);
  expect(doc.lines.map((line) => [line.timeMs, line.text])).toEqual([
    [1750, 'First line'],
    [5250, 'Chorus'],
    [60500, 'Chorus'],
    [10250, 'Last line'],
  ].sort((a, b) => Number(a[0]) - Number(b[0])));
});

test('fraction digits are decimal, not a raw millisecond field', () => {
  const doc = parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.005]c');
  expect(doc.lines.map((line) => line.timeMs)).toEqual([1500, 2050, 3005]);
});

test('malformed lines and instrumental markers do not break the file', () => {
  const doc = parseLrc(`
not a timestamp
[00:00.00]
[99:99.99]bad seconds
[00:04.00]ok [laughs] and [00:09.00] stays text
`);
  expect(doc.lines).toEqual([{ timeMs: 4000, text: 'ok [laughs] and [00:09.00] stays text' }]);
});

test('activeLineAt is a binary search over the sorted lines', () => {
  const lines = parseLrc('[00:01]a\n[00:02]b\n[00:03]c').lines;
  expect(activeLineAt(lines, 0)).toBe(-1);
  expect(activeLineAt(lines, 999)).toBe(-1);
  expect(activeLineAt(lines, 1000)).toBe(0);
  expect(activeLineAt(lines, 2599)).toBe(1);
  expect(activeLineAt(lines, 3000)).toBe(2);
  expect(activeLineAt(lines, 999_999)).toBe(2);
  expect(currentLyric(lines, 0)).toBe('a');
  expect(currentLyric(lines, 2500)).toBe('b');
  expect(currentLyric([], 1000)).toBe('');
});

test('empty input is an empty document, not an error', () => {
  expect(parseLrc('').lines).toEqual([]);
  expect(parseLrc('   \n\t').lines).toEqual([]);
});
