import { test, expect } from '@playwright/test';
import { nextEvents, parseIcs, startsSoon, unescapeText } from '../src/lib/plugins/ics';

const NOW = Date.parse('2026-06-01T00:00:00Z');

function calendar(body: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body}\r\nEND:VCALENDAR`;
}

function event(lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

test('parses a UTC event and its end', () => {
  const ics = calendar(
    event([
      'UID:one@example.com',
      'SUMMARY:Design review',
      'LOCATION:Room 4',
      'DTSTART:20260704T100000Z',
      'DTEND:20260704T110000Z',
    ])
  );
  const events = parseIcs(ics, NOW);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    title: 'Design review',
    location: 'Room 4',
    startMs: Date.parse('2026-07-04T10:00:00Z'),
    endMs: Date.parse('2026-07-04T11:00:00Z'),
    allDay: false,
  });
});

test('all-day events are local calendar dates and DTEND is exclusive', () => {
  const ics = calendar(
    event([
      'UID:allday@example.com',
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20260704',
      'DTEND;VALUE=DATE:20260705',
    ])
  );
  const [day] = parseIcs(ics, NOW);
  const start = new Date(day.startMs);
  expect(day.allDay).toBe(true);
  expect([start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours()]).toEqual([2026, 7, 4, 0]);
  expect(day.endMs - day.startMs).toBe(86_400_000);
});

test('unfolds long lines and unescapes TEXT values', () => {
  const ics = calendar(
    event([
      'UID:folded@example.com',
      'SUMMARY:A very long title that is folded',
      ' across two physical lines',
      'LOCATION:Building A\\, Floor 3\\; North',
      'DTSTART:20260704T100000Z',
      'DTEND:20260704T110000Z',
    ])
  );
  const [parsed] = parseIcs(ics, NOW);
  expect(parsed.title).toBe('A very long title that is foldedacross two physical lines');
  expect(parsed.location).toBe('Building A, Floor 3; North');
  expect(unescapeText('one\\ntwo')).toBe('one two');
});

test('a TZID wall-clock time is converted through the IANA zone', () => {
  const ics = calendar(
    event([
      'UID:tz@example.com',
      'SUMMARY:New York morning',
      'DTSTART;TZID=America/New_York:20260704T100000',
      'DTEND;TZID=America/New_York:20260704T110000',
    ])
  );
  const [parsed] = parseIcs(ics, NOW);
  expect(parsed.startMs).toBe(Date.parse('2026-07-04T14:00:00Z'));
  expect(parsed.endMs).toBe(Date.parse('2026-07-04T15:00:00Z'));
});

test('expands a weekly BYDAY series and honours COUNT and EXDATE', () => {
  const ics = calendar(
    event([
      'UID:weekly@example.com',
      'SUMMARY:Stand-up',
      'DTSTART:20260706T090000Z',
      'DTEND:20260706T091500Z',
      'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;COUNT=5',
      'EXDATE:20260708T090000Z',
    ])
  );
  const parsed = parseIcs(ics, NOW);
  // Mon 6, Wed 8 (excluded), Fri 10, Mon 13, Wed 15
  expect(parsed.map((event) => new Date(event.startMs).toISOString())).toEqual([
    '2026-07-06T09:00:00.000Z',
    '2026-07-10T09:00:00.000Z',
    '2026-07-13T09:00:00.000Z',
    '2026-07-15T09:00:00.000Z',
  ]);
});

test('a monthly rule skips months where its day does not exist', () => {
  const ics = calendar(
    event([
      'UID:monthly@example.com',
      'SUMMARY:Month end',
      'DTSTART:20260131T090000Z',
      'DTEND:20260131T093000Z',
      'RRULE:FREQ=MONTHLY;COUNT=3',
    ])
  );
  const parsed = parseIcs(ics, Date.parse('2026-01-01T00:00:00Z'));
  expect(parsed.map((event) => new Date(event.startMs).toISOString())).toEqual([
    '2026-01-31T09:00:00.000Z',
    '2026-03-31T09:00:00.000Z',
    '2026-05-31T09:00:00.000Z',
  ]);
});

test('a cancelled event and an unsupported line are skipped safely', () => {
  const ics = calendar(
    [
      event(['UID:cancel@example.com', 'SUMMARY:Nope', 'DTSTART:20260704T100000Z', 'STATUS:CANCELLED']),
      event(['UID:no-start@example.com', 'SUMMARY:No start']),
      event(['UID:good@example.com', 'SUMMARY:Good', 'DTSTART:20260704T100000Z', 'DURATION:PT45M']),
    ].join('\r\n')
  );
  const parsed = parseIcs(ics, NOW);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].endMs - parsed[0].startMs).toBe(45 * 60_000);
});

test('nextEvents drops ended events and orders the rest; startsSoon is 15 minutes', () => {
  const parsed = parseIcs(
    calendar(
      [
        event(['UID:past@example.com', 'SUMMARY:Past', 'DTSTART:20260531T220000Z', 'DTEND:20260531T230000Z']),
        event(['UID:soon@example.com', 'SUMMARY:Soon', 'DTSTART:20260601T001000Z', 'DTEND:20260601T010000Z']),
      ].join('\r\n')
    ),
    NOW
  );
  const upcoming = nextEvents(parsed, NOW, 5);
  expect(upcoming).toHaveLength(1);
  expect(upcoming[0].title).toBe('Soon');
  expect(startsSoon(upcoming[0], NOW)).toBe(true);
  expect(startsSoon(upcoming[0], NOW + 11 * 60_000)).toBe(false);
});

test('an empty or junk file yields no events', () => {
  expect(parseIcs('', NOW)).toEqual([]);
  expect(parseIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR', NOW)).toEqual([]);
});
