// One short smoke test for the Desktop pet island panel: default mascot name,
// the three needs meters, skin/form switching, and a local interaction updating
// the reaction line. Thresholds are raised so the mock snapshot starts calm.
import { test, expect } from '@playwright/test';

const ISLAND =
  '/?settings=' +
  encodeURIComponent('{"island":true,"thresholds":{"warn":80,"critical":95}}');

test('the island rail shows a hungry pet and its bowl count', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'island.plugin.pet',
      JSON.stringify({
        version: 1,
        name: 'Mochi',
        level: 1,
        xp: 0,
        fullness: 10,
        mood: 60,
        energy: 60,
        meals: 3,
        skin: 'deepseek',
        deepseekForm: 'chibi',
        theme: 'auto',
        packId: null,
        lastSeen: Date.now(),
        sprite: null,
      })
    );
  });
  await page.goto(ISLAND);
  await page.locator('.stage').hover();

  const petTool = page
    .locator('.island-tools')
    .getByRole('button', { name: 'Desktop pet', exact: true });
  await expect(petTool).toHaveAttribute('title', 'Desktop pet — Hungry · Bowls eaten: 3');
  await expect(petTool.locator('.tool-dot.need')).toBeVisible();
});

test('desktop pet opens with stats, switches skins/forms and reacts to feeding', async ({
  page,
}) => {
  await page.goto(ISLAND);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await page.locator('.stage').hover();
  await page
    .locator('.island-tools')
    .getByRole('button', { name: 'Desktop pet', exact: true })
    .click();

  const panel = page.locator('.island-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.name-text')).toHaveText('Mochi');
  await expect(panel.locator('.level-chip')).toHaveText('Lv. 1');
  await expect(panel.getByRole('meter')).toHaveCount(3);
  await expect(panel.locator('.reaction')).toHaveText(
    'At this pace, the quota may run out early.'
  );

  const skins = panel.getByRole('group', { name: 'Skin' });
  await expect(skins.getByRole('button', { name: 'Mochi (original)' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  await skins.getByRole('button', { name: 'Hachiware' }).click();
  await expect(panel.locator('.name-text')).toHaveText('Hachiware');
  const card = panel.locator('img.skin-card');
  await expect(card).toHaveAttribute('data-skin', 'hachiware');
  await expect(card).toHaveAttribute('src', /\/pet\/hachiware-happy\.webp$/);

  await skins.getByRole('button', { name: 'DeepSeek' }).click();
  await expect(panel.locator('.name-text')).toHaveText('DeepSeek');
  await expect(card).toHaveAttribute('data-skin', 'deepseek');
  await expect(card).toHaveAttribute('data-form', 'chibi');
  await expect(card).toHaveAttribute('src', /\/pet\/deepseek-chibi-happy\.webp$/);

  const forms = panel.getByRole('group', { name: 'Form' });
  await expect(forms.getByRole('button', { name: 'Q-version' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await forms.getByRole('button', { name: 'Transformed' }).click();
  await expect(card).toHaveAttribute('data-form', 'transformed');
  await expect(card).toHaveAttribute('src', /\/pet\/deepseek-transformed-happy\.webp$/);
  await forms.getByRole('button', { name: 'Q-version' }).click();
  await expect(card).toHaveAttribute('src', /\/pet\/deepseek-chibi-happy\.webp$/);

  await panel.getByRole('button', { name: 'Feed', exact: true }).click();
  await expect(panel.locator('.reaction')).toHaveText('Rice! One more bowl!');
  await expect(panel.getByRole('meter', { name: 'Fullness' })).toHaveAttribute(
    'aria-valuenow',
    '100'
  );
  // The bundled DeepSeek chibi swaps the sticker card for the rice cutscene.
  const feast = panel.getByTestId('rice-feast');
  await expect(feast).toBeVisible();
  await expect(feast).toHaveAttribute('data-kind', 'video');
  await expect(feast.locator('video source').first()).toHaveAttribute(
    'src',
    /\/pet\/deepseek-feast\.webm$/
  );
  await expect(panel.locator('.meals-chip')).toHaveAttribute('aria-label', 'Bowls eaten: 1');

  // The detached window is opt-in; enabling it reveals the wander switch.
  const desktop = panel.locator('.desktop');
  const show = desktop.getByRole('checkbox', { name: 'Show on desktop' });
  await expect(show).not.toBeChecked();
  await show.check();
  await expect(show).toBeChecked();
  await expect(desktop.getByRole('checkbox', { name: 'Let it wander' })).toBeChecked();
  await desktop.getByRole('checkbox', { name: 'Let it wander' }).uncheck();
  await expect(desktop.getByRole('checkbox', { name: 'Let it wander' })).not.toBeChecked();
});
