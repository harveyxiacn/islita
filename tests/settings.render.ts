import { test, expect } from '@playwright/test';

// Deliberately no pointer, keyboard, dispatchEvent, or element.click calls.
// These checks load the real settings route and observe what it renders.
const SECTION_IDS = [
  'appearance', 'presets', 'sidebarItems', 'sizeColour', 'position', 'behaviour', 'plugins',
  'notifications', 'shortcuts', 'providers', 'accounts', 'data', 'integrations', 'updates',
  'privacy', 'backup', 'about',
];

for (const language of ['en', 'zh-CN']) {
  test(`settings tab renders every card and its index (${language})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 800 });
    const settings = encodeURIComponent(JSON.stringify({ language }));
    await page.goto(`/dashboard?tab=settings&settings=${settings}`);
    for (const id of SECTION_IDS) await expect(page.locator(`article#${id}`)).toBeAttached();
    // one index link per card, the search box and the global reset
    await expect(page.locator('nav .index a')).toHaveCount(SECTION_IDS.length);
    // the cards are grouped under five headings
    await expect(page.locator('.group-title')).toHaveCount(5);
    await expect(page.getByRole('searchbox')).toBeVisible();
    // a card with something to reset starts with its button disabled
    await expect(page.locator('article#position button.reset')).toBeDisabled();
    // the privacy card lists every local read and request the app can make
    await expect(page.locator('article#privacy li')).toHaveCount(14);
    // the percent window selector offers automatic, 5-hour, weekly and 30-day
    await expect(
      page.locator('article#appearance select:has(option[value="thirty_day"])')
    ).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/settings-${language}.png`, fullPage: true });
  });
}

test('the edge auto-hide steps aside while the island hides on its own', async ({ page }) => {
  const settings = encodeURIComponent(JSON.stringify({ island: true, islandAutoHide: true }));
  await page.goto(`/dashboard?tab=settings&settings=${settings}`);
  const behaviour = page.locator('article#behaviour');
  // The edge bar is not in use, so its toggle explains itself and is disabled.
  await expect(behaviour.getByRole('checkbox', { name: 'Auto-hide to a thin handle' })).toBeDisabled();
  await expect(behaviour.getByText(/not used while the dynamic island is on/)).toBeVisible();
  // The island's own switch, and the delay they share, stay usable.
  await expect(
    page.locator('article#position').getByRole('checkbox', { name: 'Auto-hide at the top edge' })
  ).toBeEnabled();
  await expect(behaviour.getByLabel('Auto-hide delay (ms)')).toBeEnabled();
});

test('settings groups fold to two columns on a wide window and one on a narrow one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const settings = encodeURIComponent(JSON.stringify({ language: 'en' }));
  await page.goto(`/dashboard?tab=settings&settings=${settings}`);

  const grid = page.locator('.group-grid').first();
  const columnCount = () =>
    grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
  await expect.poll(columnCount).toBe(2);

  // a hint uses the card's width instead of wrapping in a narrow left column
  const widestHint = await page.locator('article#behaviour .setting-field').evaluateAll((fields) => {
    const ratios = fields.map((field) => {
      const hint = field.querySelector<HTMLElement>('.hint');
      if (!hint) return 0;
      return hint.getBoundingClientRect().width / field.getBoundingClientRect().width;
    });
    return Math.max(...ratios);
  });
  expect(widestHint).toBeGreaterThan(0.8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(columnCount).toBe(1);
  expect(errors).toEqual([]);
});

test('settings index collapses to a select on a narrow window without overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 700, height: 850 });
  await page.goto('/dashboard?tab=settings');
  await expect(page.locator('nav select.jump')).toBeVisible();
  await expect(page.locator('nav .index')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/settings-narrow.png', fullPage: true });
});
