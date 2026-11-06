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
  await expect(page.locator('.island-tools .tool')).toHaveCount(12);
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

test('auto-hide keeps only a top handle, reveals on hover and expands on rest', async ({ page }) => {
  await page.goto('/?settings=' + encodeURIComponent('{"island":true,"islandAutoHide":true,"autoHideDelayMs":300}'));
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');

  // idle: the capsule collapses into the thin top handle
  const peek = page.locator('.island-peek');
  await expect(peek).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.pill.island')).toHaveCount(0);

  // The stage is exactly the peek box the native window is docked to, flush
  // with the top edge (no island margin), and stays a keyboard target.
  const box = await page.locator('.stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
  });
  expect(box).toEqual({ w: 96, h: 24, top: 0 });
  expect(await peek.evaluate((el) => getComputedStyle(el).marginTop)).toBe('0px');
  await expect(page.locator('.stage')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.stage')).toHaveAttribute('aria-label', 'Show the island');

  // pointing at the handle brings the capsule back, still closed
  await page.locator('.stage').hover();
  await expect(page.locator('.pill.island')).toBeVisible();
  await expect(page.locator('.pill.island.island-open')).toHaveCount(0);

  // resting on it opens the board
  await expect(page.locator('.pill.island.island-open')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.island-tools .tool')).toHaveCount(12);

  // leaving closes and hides it again
  await page.mouse.move(4, 700);
  await expect(page.locator('.island-peek')).toBeVisible({ timeout: 4000 });
});

test('the island rail exposes every built-in plugin and imports a calendar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openIsland(page);

  const labels = await page.locator('.island-tools .tool').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label'))
  );
  expect(labels).toEqual([
    'Providers',
    'Service status',
    'Calendar',
    'Mail',
    'Sticky notes',
    'WeChat',
    'Completed tasks',
    'Recent sessions',
    'Music',
    'Focus timer',
    'Desktop pet',
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

test('a plugin panel grows past the capsule-sized native window', async ({ page }) => {
  // The island window is only as tall as the capsule, so `vh` describes the
  // capsule and not the monitor. Clamping the panel against it collapsed the
  // panel to zero and the window could never grow; the work area is the limit.
  await page.setViewportSize({ width: 900, height: 150 });
  await openIsland(page);
  await page.locator('.island-tools').getByRole('button', { name: 'Mail', exact: true }).click();
  const panel = page.locator('.island-panel');
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeGreaterThan(120);
  const stage = await page.locator('.stage').boundingBox();
  expect(stage?.height ?? 0).toBeGreaterThan(240);
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

test('the capsule morphs over multiple frames instead of swapping width', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 520 });
  await openIsland(page);
  // Start from a settled idle capsule.
  await page.mouse.move(1190, 500);
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);
  await page.waitForTimeout(650);

  const sampleWidths = (ms: number) =>
    page.evaluate(
      (duration) =>
        new Promise<number[]>((resolve) => {
          const pill = document.querySelector('.pill.island')!;
          const t0 = performance.now();
          const widths: number[] = [];
          const tick = () => {
            widths.push(Math.round(pill.getBoundingClientRect().width));
            if (performance.now() - t0 < duration) requestAnimationFrame(tick);
            else resolve(widths);
          };
          requestAnimationFrame(tick);
        }),
      ms
    );

  const expanding = sampleWidths(1100);
  await page.mouse.move(600, 20);
  const open = await expanding;
  await expect(page.locator('.pill.island')).toHaveClass(/island-open/);
  const openWidth = Math.max(...open);
  const idleWidth = Math.min(...open);
  expect(openWidth - idleWidth).toBeGreaterThan(100);
  expect(new Set(open).size).toBeGreaterThanOrEqual(8);

  await page.waitForTimeout(300);
  const collapsing = sampleWidths(1200);
  await page.mouse.move(1190, 500);
  const closed = await collapsing;
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);
  expect(Math.max(...closed) - Math.min(...closed)).toBeGreaterThan(100);
  expect(new Set(closed).size).toBeGreaterThanOrEqual(8);
});

test('the idle island shows the chosen providers and plugin icons', async ({ page }) => {
  const settings = encodeURIComponent(
    JSON.stringify({
      island: true,
      islandIdle: { providers: ['claude'], plugins: ['mail', 'calendar'] },
    })
  );
  await page.goto(`/?settings=${settings}`);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);

  // One chosen provider ring and two informational plugin icons, no full rail.
  await expect(page.locator('.idle-layer .slot')).toHaveCount(1);
  await expect(page.locator('.idle-layer .idle-tool')).toHaveCount(2);
  await expect(page.locator('.idle-layer .island-tools')).toHaveCount(0);

  // Hovering morphs to the open board, where the plugin rail is a 5-column
  // grid: twelve plugins occupy three rows rather than one long strip.
  await page.locator('.stage').hover();
  await expect(page.locator('.pill.island')).toHaveClass(/island-open/);
  await expect(page.locator('.island-tools .tool')).toHaveCount(12);
  const grid = await page.locator('.island-tools').evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      columns: style.gridTemplateColumns.split(' ').length,
      rows: [...el.children].map((child) => (child as HTMLElement).offsetTop),
    };
  });
  expect(grid.columns).toBe(5);
  const rowTops = [...new Set(grid.rows)];
  expect(rowTops).toHaveLength(3);
  expect(rowTops[1]).toBeGreaterThan(rowTops[0]);
  expect(rowTops[2]).toBeGreaterThan(rowTops[1]);
});

test('a plugin switched off in Settings disappears from the rail and idle capsule', async ({
  page,
}) => {
  const settings = encodeURIComponent(
    JSON.stringify({
      island: true,
      islandIdle: { providers: ['claude'], plugins: ['mail', 'calendar'] },
      disabledPlugins: ['mail'],
    })
  );
  await page.goto(`/?settings=${settings}`);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);

  // The saved idle selection for Mail is kept, but a switched-off module is
  // not drawn; Calendar is unaffected.
  await expect(page.locator('.idle-layer .idle-tool')).toHaveCount(1);
  await expect(page.locator('.idle-layer .idle-tool[aria-label="Mail"]')).toHaveCount(0);
  await expect(page.locator('.idle-layer .idle-tool[aria-label="Calendar"]')).toHaveCount(1);

  await page.locator('.stage').hover();
  await expect(page.locator('.pill.island')).toHaveClass(/island-open/);
  await expect(page.locator('.island-tools .tool')).toHaveCount(11);
  const rail = page.locator('.island-tools');
  await expect(rail.getByRole('button', { name: 'Mail', exact: true })).toHaveCount(0);
  await expect(rail.getByRole('button', { name: 'Calendar', exact: true })).toHaveCount(1);
});

test('rapid hover in and out settles on the idle island without drifting', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 520 });
  await openIsland(page);
  // Leave and re-enter faster than the 360 ms collapse grace, then leave for
  // good: state must not stick expanded and the capsule must stay centred.
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(1190, 500);
    await page.mouse.move(600, 20);
  }
  await page.mouse.move(1190, 500);
  await expect(page.locator('.pill.island')).toHaveClass(/island-idle/);
  const centre = await page.locator('.stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  expect(Math.abs(centre - 600)).toBeLessThanOrEqual(1);
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

test('sticky notes keep several notes in a list and switch between them', async ({ page }) => {
  await openIsland(page);
  await openTool(page, 'Sticky notes');

  const textarea = page.locator('.island-panel textarea.note');
  await textarea.fill('first note');
  await page.getByRole('button', { name: 'New note' }).click();
  await textarea.fill('second note');

  const cards = page.locator('.island-panel .note-pick');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('second note');
  await expect(cards.nth(1)).toContainText('first note');

  await cards.nth(1).click();
  await expect(textarea).toHaveValue('first note');

  await page.getByRole('button', { name: 'Delete note 2' }).click();
  await expect(cards).toHaveCount(1);
  await expect(textarea).toHaveValue('second note');
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
