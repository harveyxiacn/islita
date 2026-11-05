// Service status island plugin, exercised against the browser mock: both
// Statuspage cards, the incident row and the external links. The Rust parser
// is covered by src-tauri/src/status.rs; here the rendered panel is what
// matters.
import { test, expect, type Page } from '@playwright/test';

const ISLAND = '/?settings=' + encodeURIComponent('{"island":true}');

async function openServiceStatus(page: Page) {
  await page.goto(ISLAND);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await page.locator('.stage').hover();
  await expect(page.locator('.island-tools .tool')).toHaveCount(12);
  await page.locator('.island-tools').getByRole('button', { name: 'Service status', exact: true }).click();
  const panel = page.locator('.island-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-label', 'Service status');
  return panel;
}

test('service status shows both providers and the OpenAI incident', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const panel = await openServiceStatus(page);
  await expect(panel.locator('.service')).toHaveCount(2);

  const claude = panel.locator('.service[data-service="claude"]');
  await expect(claude.locator('.name')).toHaveText('Claude');
  await expect(claude.locator('.dot')).toHaveAttribute('data-tone', 'ok');
  await expect(claude).toContainText('All systems operational');
  await expect(claude).toContainText('Updated');
  await expect(claude).toContainText('No incidents in the last 7 days');
  await expect(claude.locator('.incident')).toHaveCount(0);

  const openai = panel.locator('.service[data-service="openai"]');
  await expect(openai.locator('.name')).toHaveText('OpenAI');
  await expect(openai.locator('.dot')).toHaveAttribute('data-tone', 'warn');
  await expect(openai).toContainText('Minor issues');
  await expect(openai).toContainText('Partially degraded service');
  await expect(openai).toContainText('Updated');

  await expect(openai.locator('.incident')).toHaveCount(1);
  await expect(openai.locator('.badge.impact')).toHaveText('Minor');
  await expect(openai.locator('.badge.state')).toHaveText('Monitoring');
  const incident = openai.locator('.incident-link');
  await expect(incident).toHaveText('Elevated error rates on ChatGPT');
  await expect(incident).toHaveAttribute('href', 'https://stspg.io/openai-chatgpt-errors');
  await expect(incident).toHaveAttribute('target', '_blank');
  await expect(incident).toHaveAttribute('rel', /noopener/);

  // The status page link is present on each card (opened through the OS, not
  // navigated here) and the explicit refresh keeps both cards in place.
  await expect(claude.locator('a.link')).toHaveAttribute('href', 'https://status.claude.com');
  await expect(openai.locator('a.link')).toHaveAttribute('href', 'https://status.openai.com');
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.locator('.service')).toHaveCount(2);

  expect(errors).toEqual([]);
});
