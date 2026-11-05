import { test, expect } from '@playwright/test';
import {
  NOTES_MAX_CHARS,
  NOTES_MAX_NOTES,
  buildNoteState,
  parseNotes,
  type Note,
} from '../src/lib/plugins/notes';

const note = (id: string, text: string, updatedAt = 1): Note => ({ id, text, updatedAt });

test('the 0.7 single note migrates into the v2 list', () => {
  const loaded = parseNotes({ text: 'old scratchpad', updatedAt: 123 }, 999, () => 'migrated');
  expect(loaded.notes).toEqual([{ id: 'migrated', text: 'old scratchpad', updatedAt: 123 }]);
  expect(loaded.activeId).toBeNull();
});

test('a v2 list keeps its order, active note and unknown fields are ignored', () => {
  const loaded = parseNotes({
    version: 2,
    notes: [note('a', 'first'), { id: 'b', text: 'second', updatedAt: 5, extra: true }],
    activeId: 'b',
    joker: 'ignored',
  });
  expect(loaded.notes.map((entry) => entry.id)).toEqual(['a', 'b']);
  expect(loaded.activeId).toBe('b');
  expect(loaded.notes[1].updatedAt).toBe(5);
});

test('duplicate, malformed and over-long entries are dropped or capped', () => {
  const long = 'x'.repeat(NOTES_MAX_CHARS + 50);
  const loaded = parseNotes({
    version: 2,
    notes: [
      note('a', 'first'),
      note('a', 'duplicate'),
      { id: 'b' },
      { text: 'no id' },
      null,
      note('c', long, Number.NaN),
      ...Array.from({ length: NOTES_MAX_NOTES }, (_, index) => note(`n${index}`, `note ${index}`)),
    ],
    activeId: 42,
  });
  expect(loaded.notes.map((entry) => entry.id)).toEqual(['a', 'c', ...Array.from({ length: NOTES_MAX_NOTES - 2 }, (_, index) => `n${index}`)]);
  expect(loaded.notes[1].text).toHaveLength(NOTES_MAX_CHARS);
  expect(Number.isFinite(loaded.notes[1].updatedAt)).toBe(true);
  expect(loaded.activeId).toBeNull();
});

test('empty notes are not stored and a dangling active id falls back', () => {
  expect(buildNoteState([note('a', '   '), note('b', 'kept')], 'a', '', 10)).toEqual({
    version: 2,
    notes: [{ ...note('b', 'kept'), updatedAt: 1 }],
    activeId: 'b',
  });
  expect(buildNoteState([note('a', '')], 'a', '', 10)).toBeNull();
});

test('the textarea value wins and gets the save timestamp', () => {
  const state = buildNoteState([note('a', 'stale'), note('b', 'other')], 'a', 'fresh', 42);
  expect(state?.notes[0]).toEqual({ id: 'a', text: 'fresh', updatedAt: 42 });
  expect(state?.activeId).toBe('a');
});
