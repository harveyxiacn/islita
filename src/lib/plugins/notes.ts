// Sticky-note storage shapes. [FRONTEND]
//
// The panel keeps a small board of notes in one localStorage entry. Version 2
// is `{ version, notes, activeId }`; the 0.7 single-note shape is migrated on
// read. Validation is strict: an entry we cannot recognise is dropped instead
// of being repaired into surprising text.

export interface Note {
  id: string;
  text: string;
  updatedAt: number;
}

export interface NoteStateV2 {
  version: 2;
  notes: Note[];
  activeId: string | null;
}

/** One note per scratchpad; the editor enforces the same cap. */
export const NOTES_MAX_CHARS = 4000;
/** More than this is noise in a 22 rem panel. */
export const NOTES_MAX_NOTES = 20;

export function newNoteId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** A stored or legacy entry, strictly validated and capped. */
function noteFrom(raw: unknown, now: number): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.text !== 'string') return null;
  const id = candidate.id.slice(0, 64);
  if (!id) return null;
  return {
    id,
    text: candidate.text.slice(0, NOTES_MAX_CHARS),
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : now,
  };
}

/**
 * Read whatever `localStorage` held. Returns an empty list for v1 states with
 * no text (there is nothing to migrate) and ignores unknown shapes entirely.
 */
export function parseNotes(
  raw: unknown,
  now = Date.now(),
  makeId: () => string = newNoteId,
): { notes: Note[]; activeId: string | null } {
  if (!raw || typeof raw !== 'object') return { notes: [], activeId: null };
  const state = raw as Record<string, unknown>;
  if (Array.isArray(state.notes)) {
    const seen = new Set<string>();
    const notes: Note[] = [];
    for (const entry of state.notes) {
      const note = noteFrom(entry, now);
      if (!note || seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
      if (notes.length >= NOTES_MAX_NOTES) break;
    }
    return {
      notes,
      activeId: typeof state.activeId === 'string' ? state.activeId : null,
    };
  }
  // Version 1: `{ text, updatedAt }` written by 0.7.
  if (typeof state.text === 'string' && state.text.trim()) {
    return {
      notes: [
        {
          id: makeId(),
          text: state.text.slice(0, NOTES_MAX_CHARS),
          updatedAt:
            typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt)
              ? state.updatedAt
              : now,
        },
      ],
      activeId: null,
    };
  }
  return { notes: [], activeId: null };
}

/**
 * Build the payload to store; `activeText` wins over the note's mirrored text
 * because the textarea might be one effect tick ahead. Empty notes are not
 * persisted, and a dangling active id falls back to the first stored note.
 * Returns null when there is nothing worth storing.
 */
export function buildNoteState(
  notes: readonly Note[],
  activeId: string | null,
  activeText: string,
  now = Date.now(),
): NoteStateV2 | null {
  const stored = notes
    .map((note) =>
      note.id === activeId ? { ...note, text: activeText, updatedAt: now } : note,
    )
    .filter((note) => note.text.trim().length > 0)
    .map((note) => ({ ...note, text: note.text.slice(0, NOTES_MAX_CHARS) }));
  if (stored.length === 0) return null;
  return {
    version: 2,
    notes: stored,
    activeId: stored.some((note) => note.id === activeId) ? activeId : stored[0].id,
  };
}
