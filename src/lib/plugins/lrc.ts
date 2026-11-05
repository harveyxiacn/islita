// LRC lyric parser. [FRONTEND]
//
// Deliberately dependency-free: the music plugin only needs timestamps and
// text, not a karaoke engine. The parser follows the common LRC conventions:
//
//   [ti:Title] [ar:Artist] [al:Album] [offset:+250]
//   [00:12.34]one line
//   [00:15.50][01:02.10]a repeated chorus line
//
// A timestamp fraction is read as a decimal fraction of a second, so both
// `[00:01.5]` and `[00:01.50]` mean 1.5 s. `offset` is in milliseconds and
// positive values delay the lyrics (the LRC spec's sign convention). Lines
// are sorted and de-duplicated so a file with a repeated chorus does not
// produce two entries at the same instant.

export interface LrcLine {
  /** Milliseconds from the start of the track. */
  timeMs: number;
  text: string;
}

export interface LrcDoc {
  title: string;
  artist: string;
  album: string;
  /** The file's `offset` tag in milliseconds (already applied to `lines`). */
  offsetMs: number;
  lines: LrcLine[];
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ti|ar|al|offset):([^\]]*)\]$/i;

const EMPTY: LrcDoc = { title: '', artist: '', album: '', offsetMs: 0, lines: [] };

/** Fraction digits → milliseconds: `.5` = 500, `.05` = 50, `.005` = 5. */
function fractionMs(digits: string | undefined): number {
  if (!digits) return 0;
  const padded = digits.padEnd(3, '0').slice(0, 3);
  return Number.parseInt(padded, 10) || 0;
}

/**
 * Parse an LRC file. Never throws: malformed lines are skipped, because a
 * half-broken lyric file should not take the player down with it.
 */
export function parseLrc(source: string): LrcDoc {
  if (!source || !source.trim()) return { ...EMPTY, lines: [] };

  let title = '';
  let artist = '';
  let album = '';
  let offsetMs = 0;
  const raw: LrcLine[] = [];

  for (const rawLine of source.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = META_TAG.exec(line);
    if (meta) {
      const value = meta[2].trim();
      switch (meta[1].toLowerCase()) {
        case 'ti':
          title = value;
          break;
        case 'ar':
          artist = value;
          break;
        case 'al':
          album = value;
          break;
        case 'offset': {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) offsetMs = parsed;
          break;
        }
      }
      continue;
    }

    // Collect every leading time tag; the rest is the line's text.
    TIME_TAG.lastIndex = 0;
    const times: number[] = [];
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = TIME_TAG.exec(line)) !== null) {
      // Tags must be at the start and contiguous. A bracket inside the lyric
      // text (e.g. "[laughs]") is not a timestamp and stops the scan.
      if (match.index !== consumed) break;
      const minutes = Number.parseInt(match[1], 10);
      const seconds = Number.parseInt(match[2], 10);
      if (seconds >= 60) break;
      times.push(minutes * 60_000 + seconds * 1000 + fractionMs(match[3]));
      consumed = TIME_TAG.lastIndex;
      // The regex is global; reset after a non-contiguous match in the loop.
    }
    if (times.length === 0) continue;

    const text = line.slice(consumed).trim();
    // Empty timestamps are instrumental markers; keeping them would make the
    // active-line highlight jump to a blank row. Drop them.
    if (!text) continue;
    for (const timeMs of times) raw.push({ timeMs, text });
  }

  const shifted = raw.map((line) => ({ ...line, timeMs: Math.max(0, line.timeMs + offsetMs) }));
  shifted.sort((a, b) => a.timeMs - b.timeMs || a.text.localeCompare(b.text));

  const lines: LrcLine[] = [];
  for (const line of shifted) {
    const previous = lines[lines.length - 1];
    if (previous && previous.timeMs === line.timeMs && previous.text === line.text) continue;
    lines.push(line);
  }

  return { title, artist, album, offsetMs, lines };
}

/**
 * Index of the line that is playing at `timeMs`, or -1 before the first one.
 * Binary search keeps the per-frame `timeupdate` work tiny even for a long
 * file with thousands of lines.
 */
export function activeLineAt(lines: readonly LrcLine[], timeMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= timeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** The text to show for the current instant, or the first line before start. */
export function currentLyric(lines: readonly LrcLine[], timeMs: number): string {
  if (lines.length === 0) return '';
  const index = activeLineAt(lines, timeMs);
  return index >= 0 ? lines[index].text : lines[0].text;
}
