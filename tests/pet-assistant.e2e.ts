// The pet assistant's deterministic path in the browser preview: no local
// model is available there, so this also proves the "works without Ollama"
// promise and the desktop-only model settings.
import { test, expect } from '@playwright/test';

const ISLAND =
  '/?settings=' +
  encodeURIComponent('{"island":true,"thresholds":{"warn":80,"critical":95}}');

test('pet assistant answers from local data and degrades cleanly without a model', async ({
  page,
}) => {
  await page.goto(ISLAND);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await page.locator('.stage').hover();
  await page
    .locator('.island-tools')
    .getByRole('button', { name: 'Desktop pet', exact: true })
    .click();

  const assistant = page.locator('.island-panel .assistant');
  await expect(assistant).toBeVisible();
  await expect(assistant.locator('.chat-bubble').first()).toContainText(
    'Hi! Mochi here. What should we check?'
  );

  await assistant.getByRole('button', { name: 'Quota', exact: true }).click();
  await expect(assistant.locator('.chat-message[data-role="user"]').last()).toContainText(
    'Quota'
  );
  const answer = assistant.locator('.chat-bubble').last();
  await expect(answer).toContainText('Current quota:');
  await expect(answer).toContainText('Claude · Current session: 73% used');
  await expect(answer).toContainText('Codex · Weekly: 41% used');
  await expect(assistant.locator('.chat-source').last()).toHaveText('Built-in answers');

  const input = assistant.locator('.assistant-input');
  await input.fill('how are you?');
  await assistant.getByRole('button', { name: 'Send' }).click();
  await expect(assistant.locator('.chat-bubble').last()).toContainText(
    'Mochi · Lv.1 · Feeling great'
  );
  await expect(input).toHaveValue('');

  await assistant.getByRole('button', { name: 'Model settings' }).click();
  await expect(assistant.locator('.model-settings')).toContainText(
    'Local models need the desktop app.'
  );
  await expect(assistant.getByRole('button', { name: 'Check local servers' })).toHaveCount(0);

  await assistant.getByRole('button', { name: 'Clear' }).click();
  await expect(assistant.locator('.chat-message[data-role="user"]')).toHaveCount(0);
  await expect(assistant.locator('.chat-bubble').first()).toContainText('Hi! Mochi here.');
});
