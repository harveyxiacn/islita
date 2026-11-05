import { test, expect } from '@playwright/test';

const SETTINGS = encodeURIComponent(
  JSON.stringify({
    island: true,
    islandIdle: { providers: ['claude'], plugins: ['mail'] },
  })
);

test('the position card edits the idle island providers and plugins', async ({ page }) => {
  await page.goto(`/dashboard?tab=settings&settings=${SETTINGS}`);
  const providers = page.locator('article#position .picks').first();
  const plugins = page.locator('article#position .picks').nth(1);

  const claude = providers.getByRole('button', { name: 'Claude', exact: true });
  await expect(claude).toHaveAttribute('aria-pressed', 'true');
  await claude.click();
  await expect(claude).toHaveAttribute('aria-pressed', 'false');

  const mail = plugins.getByRole('button', { name: 'Mail', exact: true });
  await expect(mail).toHaveAttribute('aria-pressed', 'true');
  await mail.click();
  await expect(mail).toHaveAttribute('aria-pressed', 'false');
});

test('six idle plugin icons are the cap and the rest stay disabled', async ({ page }) => {
  const settings = encodeURIComponent(
    JSON.stringify({
      island: true,
      islandIdle: {
        plugins: ['providers', 'calendar', 'mail', 'notes', 'wechat', 'tasks'],
      },
    })
  );
  await page.goto(`/dashboard?tab=settings&settings=${settings}`);
  const plugins = page.locator('article#position .picks').nth(1);
  for (const name of ['Recent sessions', 'Music', 'Focus timer', 'File drop']) {
    await expect(plugins.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await expect(plugins.getByRole('button', { name: 'Mail', exact: true })).toBeEnabled();
});
