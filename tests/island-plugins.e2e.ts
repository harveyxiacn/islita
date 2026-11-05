// The island's built-in plugin rail, exercised end to end against the browser
// mock: calendar import, local mail, music + LRC and the file drop station.
// Native drop/picker paths are unit-tested in Rust; here the browser fallbacks
// and the shared panel contract are what matter.
import { test, expect, type Page } from '@playwright/test';

const ISLAND = '/?settings=' + encodeURIComponent('{"island":true}');

async function openIsland(page: Page) {
  await page.goto(ISLAND);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await page.locator('.stage').hover();
  await expect(page.locator('.island-tools .tool')).toHaveCount(10);
}

async function openTool(page: Page, name: string) {
  await page.locator('.island-tools').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.island-panel')).toBeVisible();
}

function icsStart(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function oneSecondWav(): Buffer {
  const sampleRate = 8000;
  const samples = 8000;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000), i * 2);
  }
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

test('the island rail exposes every built-in plugin and imports a calendar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openIsland(page);

  const labels = await page.locator('.island-tools .tool').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label'))
  );
  expect(labels).toEqual([
    'Providers',
    'Calendar',
    'Mail',
    'Sticky note',
    'WeChat',
    'Completed tasks',
    'Recent sessions',
    'Music',
    'Focus timer',
    'File drop',
  ]);

  await openTool(page, 'Calendar');
  const start = Date.now() + 10 * 60_000;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:island-e2e@example.com',
    'SUMMARY:Design review',
    'LOCATION:Room 4',
    `DTSTART:${icsStart(start)}`,
    `DTEND:${icsStart(start + 3_600_000)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  await page.locator('.island-panel input[type=file]').setInputFiles({
    name: 'island.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ics),
  });
  await expect(page.locator('.island-panel')).toContainText('Design review');
  await expect(page.locator('.island-panel')).toContainText('Imported 1 events');
  await expect(page.locator('.island-panel')).toContainText('Room 4');
  await expect(page.locator('.island-panel')).toContainText('Starts soon');
  await expect(page.locator('.island-tools .tool-dot')).toBeVisible();

  expect(errors).toEqual([]);
});

test('the island expands and collapses around its horizontal centre', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 520 });
  await openIsland(page);
  const centre = () =>
    page.locator('.stage').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    });
  // `openIsland` leaves the pointer on the expanded row; moving off collapses it.
  await page.mouse.move(1190, 500);
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);
  await expect.poll(async () => Math.abs((await centre()) - 600)).toBeLessThanOrEqual(1);
  await page.locator('.stage').hover();
  await expect(page.locator('.pill.island')).toHaveClass(/island-open/);
  await expect.poll(async () => Math.abs((await centre()) - 600)).toBeLessThanOrEqual(1);
  await page.mouse.move(1190, 500);
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);
  await expect.poll(async () => Math.abs((await centre()) - 600)).toBeLessThanOrEqual(1);
});

test('local mail shows unread headers without a body', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'Mail');
  await expect(page.locator('.island-panel')).toContainText('Choose a local mail folder');
  await page.locator('.island-panel .dropzone').click();
  await expect(page.locator('.island-panel')).toContainText('2 unread');
  await expect(page.locator('.island-panel')).toContainText('Design review moved to 3 pm');
  await expect(page.locator('.island-tools .tool-badge')).toHaveText('2');
  await expect(page.locator('.island-panel')).toContainText('Headers only');
  await expect(page.locator('.island-panel')).not.toContainText('secret body');
});

test('cloud mail offers all three sign-in routes and connects with an app password', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'Mail');
  await page.getByRole('tab', { name: 'Accounts' }).click();

  // The mock starts with one Gmail account; its row and unread headers show.
  await expect(page.locator('.island-panel')).toContainText('Maya Chen');
  await expect(page.locator('.island-panel')).toContainText('3 unread');
  await expect(page.locator('.island-panel')).toContainText('Your invoice for October');
  await expect(page.locator('.island-panel')).toContainText('OS keychain');

  // Add another account: Gmail OAuth is offered alongside app passwords.
  await page.getByRole('button', { name: 'Add another account' }).click();
  await expect(page.locator('.island-panel')).toContainText('Choose how to connect');
  await expect(page.locator('.island-panel')).toContainText('Other IMAP');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Use an app password' }).first().click();
  await expect(page.locator('.island-panel')).toContainText('Gmail app password');

  await page.getByLabel('E-mail address').fill('you@gmail.com');
  await page.getByLabel('App password').fill('abcd efgh ijkl mnop');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  // The browser mock validates and returns a metadata-only account.
  await expect(page.locator('.island-panel')).toContainText('you@gmail.com');
  await expect(page.locator('.island-panel')).toContainText('3 unread');
  await expect(page.locator('.island-panel')).not.toContainText('abcd efgh');
});

test('the WeChat panel mirrors the visible conversation list read-only', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'WeChat');
  await expect(page.locator('.island-panel')).toContainText('4 conversations');
  await expect(page.locator('.island-panel')).toContainText('Maya');
  await expect(page.locator('.island-panel')).toContainText('Design review moved to 3 pm');
  await expect(page.locator('.island-panel')).toContainText('Sam: shipped the build');
  await expect(page.locator('.island-panel')).toContainText('read-only mirror');
  await expect(page.locator('.island-panel')).toContainText(/Never opens chats/i);
});

test('music matches an LRC file and makes the clicked line active', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'Music');
  await page
    .locator('.island-panel input[type=file][accept^="audio"]')
    .setInputFiles({ name: 'demo-song.wav', mimeType: 'audio/wav', buffer: oneSecondWav() });
  await expect(page.locator('.island-panel')).toContainText('demo-song');

  const lrc = ['[ti:Demo song]', '[ar:Local artist]', '[00:00.00]First line', '[00:00.50]Second line', '[00:01.00]Third line'].join('\n');
  await page
    .locator('.island-panel input[type=file][accept=".lrc,text/plain"]')
    .setInputFiles({ name: 'demo-song.lrc', mimeType: 'text/plain', buffer: Buffer.from(lrc) });
  await expect(page.locator('.island-panel')).toContainText('Lyrics synced');

  await page.locator('.island-panel .lyric', { hasText: 'Second line' }).click();
  await expect(page.locator('.island-panel .lyric.active')).toHaveText('Second line');
});

test('the file drop station lists files saved through the browser fallback', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'File drop');
  await page.locator('.island-panel input[type=file]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') },
  ]);
  await expect(page.locator('.island-panel')).toContainText('Saved 2 files');
  await expect(page.locator('.island-panel')).toContainText('notes.txt');
  await expect(page.locator('.island-panel')).toContainText('report.pdf');
  await expect(page.locator('.island-panel')).toContainText(/never executed/i);
});
