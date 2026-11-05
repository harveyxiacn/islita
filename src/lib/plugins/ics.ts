// iCalendar (ICS) parser for the calendar plugin. [FRONTEND]
//
// Scope: what a reminder card needs — VEVENT start/end, summary, location,
// all-day flags, TZID wall-clock times and basic RRULE expansion. It is not a
// CalDAV client: parsing happens locally on a file the user picked, and the
// parsed events are cached in this webview's localStorage.
//
// Recurrence support is intentionally small and predictable:
//   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY
// EXDATE and RDATE are honoured. Unsupported rules (BYSETPOS, BYMONTHDAY, …)
// still yield the first occurrence rather than a wrong series.

export interface CalendarEvent {
  /** Stable id derived from the UID and the occurrence instant. */
  id: string;
  title: string;
  location: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** UID without the occurrence instant (used to group a series). */
  seriesId: string;
}

export interface CalendarImport {
  name: string;
  importedAt: number;
  events: CalendarEvent[];
}

const MAX_EVENTS = 500;
const MAX_EXPANSION_DAYS = 400;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- line text

/** RFC 5545 line unfolding: CRLF followed by a space or tab. */
function unfold(source: string): string[] {
  return source
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

interface Property {
  /** Upper-case name, e.g. `DTSTART`, `SUMMARY`. */
  name: string;
  /** Upper-case parameter map, e.g. `TZID` → `Europe/Berlin`. */
  params: Map<string, string>;
  value: string;
}

/** Split a content line at its first unquoted colon. */
function contentLine(line: string): Property | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let current = '';
  quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const name = (parts.shift() ?? '').trim().toUpperCase();
  if (!name) return null;
  const params = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim().replace(/^"|"$/g, ''));
  }
  return { name, params, value };
}

/** RFC 5545 TEXT unescaping, flattened to one display line. */
export function unescapeText(value: string): string {
  return value
    .replace(/\\[nN]/g, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------- timing

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseWall(value: string): { wall: WallTime; utc: boolean; dateOnly: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const dateOnly = match[4] === undefined;
  return {
    wall: {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: dateOnly ? 0 : Number(match[4]),
      minute: dateOnly ? 0 : Number(match[5]),
      second: match[6] ? Number(match[6]) : 0,
    },
    utc: Boolean(match[7]),
    dateOnly,
  };
}

/** Offset of `tz` at the UTC instant `atMs`, in milliseconds east of UTC. */
function timeZoneOffsetMs(tz: string, atMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return wallAsUtc - atMs;
  } catch {
    // Unknown TZID (or a runtime without full Intl data): treat it as local
    // time, which is the least surprising fallback for a desktop app.
    return -new Date(atMs).getTimezoneOffset() * 60_000;
  }
}

/** Convert a wall-clock reading in `tz` to an absolute instant. */
export function zonedToUtc(wall: WallTime, tz: string | null): number {
  if (!tz) return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second).getTime();
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let offset = timeZoneOffsetMs(tz, guess);
  let instant = guess - offset;
  const second = timeZoneOffsetMs(tz, instant);
  if (second !== offset) {
    offset = second;
    instant = guess - offset;
  }
  return instant;
}

function addDays(wall: WallTime, days: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute, wall.second));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function addMonths(wall: WallTime, months: number): WallTime | null {
  const target = new Date(Date.UTC(wall.year, wall.month - 1 + months, 1, wall.hour, wall.minute, wall.second));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  if (wall.day > lastDay) return null; // e.g. the 31st in a 30-day month
  target.setUTCDate(wall.day);
  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour: target.getUTCHours(),
    minute: target.getUTCMinutes(),
    second: target.getUTCSeconds(),
  };
}

/** Add months, skipping months where the day does not exist (Jan 31 → Mar 31,
 *  Feb 29 → the next leap year). */
function addMonthsSkipping(wall: WallTime, months: number): WallTime | null {
  for (let skip = 1; skip <= 12; skip += 1) {
    const next = addMonths(wall, months * skip);
    if (next) return next;
  }
  return null;
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null;
  days: number[];
}

function parseRule(value: string): Rule | null {
  const fields = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1).toUpperCase());
  }
  const freq = fields.get('FREQ') as Rule['freq'] | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, Number.parseInt(fields.get('INTERVAL') ?? '1', 10) || 1);
  const count = Number.parseInt(fields.get('COUNT') ?? '', 10);
  const untilRaw = fields.get('UNTIL');
  let until: number | null = null;
  if (untilRaw) {
    const parsed = parseWall(untilRaw);
    if (parsed) {
      until = parsed.utc
        ? Date.UTC(parsed.wall.year, parsed.wall.month - 1, parsed.wall.day, parsed.wall.hour, parsed.wall.minute, parsed.wall.second)
        : zonedToUtc(parsed.wall, null);
    }
  }
  const days = (fields.get('BYDAY') ?? '')
    .split(',')
    .map((day) => WEEKDAYS[day.trim().slice(-2)])
    .filter((day): day is number => day !== undefined);
  return { freq, interval, count: Number.isFinite(count) && count > 0 ? count : null, until, days };
}

// ------------------------------------------------------------------- events

interface RawEvent {
  uid: string;
  summary: string;
  location: string;
  start: { wall: WallTime; utc: boolean; dateOnly: boolean; tzid: string | null };
  end: { wall: WallTime; dateOnly: boolean; utc: boolean; tzid: string | null } | null;
  durationMs: number | null;
  rule: Rule | null;
  exdates: Set<number>;
}

function propertyDate(prop: Property | undefined): { wall: WallTime; utc: boolean; dateOnly: boolean; tzid: string | null } | null {
  if (!prop) return null;
  const parsed = parseWall(prop.value);
  if (!parsed) return null;
  const dateOnly = parsed.dateOnly || (prop.params.get('VALUE') ?? '').toUpperCase() === 'DATE';
  return {
    ...parsed,
    dateOnly,
    tzid: dateOnly ? null : parsed.utc ? null : (prop.params.get('TZID') ?? null),
  };
}

function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const ms =
    (Number(match[2] ?? 0) * 7 + Number(match[3] ?? 0)) * DAY_MS +
    (Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0)) * 1000;
  return sign * ms;
}

function expand(raw: RawEvent, windowStart: number, windowEnd: number): CalendarEvent[] {
  // All-day events are local calendar dates, not UTC instants: storing them
  // at UTC midnight would make them jump a day west of Greenwich.
  const startInstant = (wall: WallTime): number =>
    raw.start.dateOnly
      ? new Date(wall.year, wall.month - 1, wall.day).getTime()
      : raw.start.utc
        ? Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
        : zonedToUtc(wall, raw.start.tzid);

  const firstStart = startInstant(raw.start.wall);
  const lengthMs = raw.end
    ? Math.max(
        0,
        (raw.start.dateOnly
          ? new Date(raw.end.wall.year, raw.end.wall.month - 1, raw.end.wall.day).getTime()
          : raw.end.utc
            ? Date.UTC(raw.end.wall.year, raw.end.wall.month - 1, raw.end.wall.day, raw.end.wall.hour, raw.end.wall.minute, raw.end.wall.second)
            : zonedToUtc(raw.end.wall, raw.end.tzid ?? raw.start.tzid)) - firstStart
      )
    : (raw.durationMs ?? (raw.start.dateOnly ? DAY_MS : 0));
  const effectiveLength = raw.start.dateOnly && raw.end === null ? DAY_MS : lengthMs;

  const out: CalendarEvent[] = [];
  const push = (wall: WallTime, occurrence: number) => {
    if (raw.exdates.has(occurrence)) return;
    if (occurrence > windowEnd || occurrence + effectiveLength < windowStart) return;
    out.push({
      id: `${raw.uid}@${occurrence}`,
      seriesId: raw.uid,
      title: raw.summary,
      location: raw.location,
      startMs: occurrence,
      endMs: occurrence + effectiveLength,
      allDay: raw.start.dateOnly,
    });
  };

  if (!raw.rule) {
    push(raw.start.wall, firstStart);
    return out;
  }

  const rule = raw.rule;
  let wall = raw.start.wall;
  let occurrence = firstStart;
  let generated = 0;
  let steps = 0;
  // Walk the series from its first occurrence. The window is short (a few
  // weeks) but the series may have started years ago; 20 000 steps is a hard
  // ceiling so a hostile/broken file cannot freeze the UI.
  while (steps < 20_000) {
    steps += 1;
    if (rule.count !== null && generated >= rule.count) break;
    if (rule.until !== null && occurrence > rule.until) break;
    if (occurrence > windowEnd) break;
    if (occurrence + effectiveLength >= windowStart && occurrence <= windowEnd) push(wall, occurrence);
    generated += 1;

    const interval = rule.interval;
    if (rule.freq === 'WEEKLY' && rule.days.length > 0) {
      // Expand every selected weekday in each interval week. The cursor's
      // weekday is the anchor; step to the next selected day, wrapping with
      // `interval * 7` days.
      const currentDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
      const sorted = [...rule.days].sort((a, b) => a - b);
      const next = sorted.find((d) => d > currentDay);
      const delta = next === undefined ? interval * 7 - currentDay + sorted[0] : next - currentDay;
      wall = addDays(wall, delta);
    } else if (rule.freq === 'DAILY') {
      wall = addDays(wall, interval);
    } else if (rule.freq === 'WEEKLY') {
      wall = addDays(wall, interval * 7);
    } else if (rule.freq === 'MONTHLY') {
      const next = addMonthsSkipping(wall, interval);
      if (!next) break;
      wall = next;
    } else {
      const next = addMonthsSkipping(wall, interval * 12);
      if (!next) break;
      wall = next;
    }
    occurrence = startInstant(wall);
  }
  return out;
}

/** Parse one ICS file into the next occurrence of each event. */
export function parseIcs(source: string, nowMs: number = Date.now()): CalendarEvent[] {
  const lines = unfold(source);
  const events: RawEvent[] = [];
  let current: {
    uid: string;
    summary: string;
    location: string;
    start: ReturnType<typeof propertyDate>;
    end: ReturnType<typeof propertyDate>;
    durationMs: number | null;
    rule: Rule | null;
    exdates: Set<number>;
    cancelled: boolean;
  } | null = null;

  const finish = () => {
    if (!current || current.cancelled || !current.start) {
      current = null;
      return;
    }
    events.push({
      uid: current.uid || `local-${events.length}`,
      summary: current.summary,
      location: current.location,
      start: current.start,
      end: current.end,
      durationMs: current.durationMs,
      rule: current.rule,
      exdates: current.exdates,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.trim().toUpperCase() === 'BEGIN:VEVENT') {
      current = { uid: '', summary: '', location: '', start: null, end: null, durationMs: null, rule: null, exdates: new Set(), cancelled: false };
      continue;
    }
    if (line.trim().toUpperCase() === 'END:VEVENT') {
      finish();
      continue;
    }
    if (!current) continue;
    const prop = contentLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        current.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(prop.value);
        break;
      case 'LOCATION':
        current.location = unescapeText(prop.value);
        break;
      case 'DTSTART':
        current.start = propertyDate(prop);
        break;
      case 'DTEND':
        current.end = propertyDate(prop);
        break;
      case 'DURATION':
        current.durationMs = parseDuration(prop.value);
        break;
      case 'RRULE':
        current.rule = parseRule(prop.value);
        break;
      case 'EXDATE':
        for (const value of prop.value.split(',')) {
          const parsed = parseWall(value);
          if (!parsed) continue;
          current.exdates.add(
            parsed.utc
              ? Date.UTC(parsed.wall.year, parsed.wall.month - 1, parsed.wall.day, parsed.wall.hour, parsed.wall.minute, parsed.wall.second)
              : current.start?.dateOnly
                ? new Date(parsed.wall.year, parsed.wall.month - 1, parsed.wall.day).getTime()
                : current.start?.utc
                  ? Date.UTC(parsed.wall.year, parsed.wall.month - 1, parsed.wall.day, parsed.wall.hour, parsed.wall.minute, parsed.wall.second)
                  : zonedToUtc(parsed.wall, prop.params.get('TZID') ?? null)
          );
        }
        break;
      case 'STATUS':
        if (prop.value.trim().toUpperCase() === 'CANCELLED') current.cancelled = true;
        break;
    }
  }

  // Include anything already in progress, then the next 400 days. `-1 day`
  // covers events that started yesterday and run into today.
  const windowStart = nowMs - DAY_MS;
  const windowEnd = nowMs + MAX_EXPANSION_DAYS * DAY_MS;
  const expanded: CalendarEvent[] = [];
  for (const event of events) {
    for (const occurrence of expand(event, windowStart, windowEnd)) expanded.push(occurrence);
    if (expanded.length >= MAX_EVENTS) break;
  }
  expanded.sort((a, b) => a.startMs - b.startMs);
  const seen = new Set<string>();
  return expanded.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }).slice(0, MAX_EVENTS);
}

/** Upcoming events that have not ended yet, soonest first. */
export function nextEvents(events: readonly CalendarEvent[], nowMs: number, limit = 5): CalendarEvent[] {
  return events
    .filter((event) => event.endMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, limit);
}

/** True when the event starts within `withinMs` (and has not started yet). */
export function startsSoon(event: CalendarEvent, nowMs: number, withinMs = 15 * 60_000): boolean {
  return event.startMs >= nowMs && event.startMs - nowMs <= withinMs;
}
