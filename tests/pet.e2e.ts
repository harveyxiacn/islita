// One short smoke test for the Desktop pet island panel: default mascot name,
// the three needs meters, skin/form switching, and a local interaction updating
// the reaction line. Thresholds are raised so the mock snapshot starts calm.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  clickLineKey,
  clickReactionSpec,
  isPetClickReaction,
  type PetClickReaction,
} from '../src/lib/pet/reactions';
import { skinImage } from '../src/lib/pet/skins';

const ISLAND =
  '/?settings=' +
  encodeURIComponent('{"island":true,"thresholds":{"warn":80,"critical":95}}');
const EN = JSON.parse(
  readFileSync(path.join('src', 'lib', 'i18n', 'en.json'), 'utf8')
) as Record<string, string>;

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
  // The bundled chibi is drawn by the H3 player, not by a sticker card.
  const film = panel.getByTestId('pet-film');
  await expect(film).toBeVisible();
  await expect(film).toHaveAttribute('data-clip', 'idle');
  await expect(film).toHaveAttribute('data-src', /\/pet\/animations\/idle-sheet\.webp$/);

  const forms = panel.getByRole('group', { name: 'Form' });
  await expect(forms.getByRole('button', { name: 'Q-version' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await forms.getByRole('button', { name: 'Transformed' }).click();
  const transformedCard = panel.locator('img.skin-card');
  await expect(transformedCard).toHaveAttribute('data-form', 'transformed');
  await expect(transformedCard).toHaveAttribute(
    'src',
    /\/pet\/deepseek-transformed-happy\.webp$/
  );
  await forms.getByRole('button', { name: 'Q-version' }).click();
  await expect(film).toHaveAttribute('data-clip', 'idle');

  await panel.getByRole('button', { name: 'Feed', exact: true }).click();
  await expect(panel.locator('.reaction')).toHaveText('White rice! One more bowl!');
  await expect(panel.getByRole('meter', { name: 'Fullness' })).toHaveAttribute(
    'aria-valuenow',
    '100'
  );
  // Feeding swaps the idle loop for the generated eat performance.
  await expect(film).toHaveAttribute('data-clip', 'eat');
  await expect(film).toHaveAttribute('data-src', /\/pet\/animations\/eat-sheet\.webp$/);
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

test('a pat rolls a reaction and expression for every bundled skin', async ({ page }) => {
  await page.goto(ISLAND);
  await expect(page.locator('.stage')).toHaveAttribute('data-island', 'true');
  await page.locator('.stage').hover();
  await page
    .locator('.island-tools')
    .getByRole('button', { name: 'Desktop pet', exact: true })
    .click();

  const panel = page.locator('.island-panel');
  await expect(panel).toBeVisible();
  const button = panel.locator('.mascot-button');
  const reactionText = panel.locator('.reaction');

  // Mochi is the default: its face must switch to the reaction's expression.
  await button.click();
  const mochiReaction = await button.getAttribute('data-reaction');
  expect(isPetClickReaction(mochiReaction)).toBe(true);
  const mochiId = mochiReaction as PetClickReaction;
  const mochiSpec = clickReactionSpec(mochiId);
  const mochiVariant = Number(await button.getAttribute('data-reaction-variant'));
  expect(Number.isFinite(mochiVariant)).toBe(true);
  await expect(button).toHaveClass(new RegExp(`reaction-${mochiId}`));
  await expect(button).toHaveCSS('animation-name', new RegExp(`pet-react-${mochiId}$`));
  await expect(panel.locator('.creature')).toHaveAttribute('data-status', mochiSpec.status);
  await expect(reactionText).toHaveText(
    EN[clickLineKey('mochi', { reaction: mochiId, variant: mochiVariant })]
  );

  // Hachiware swaps to the card that belongs to the reaction.
  const skins = panel.getByRole('group', { name: 'Skin' });
  await skins.getByRole('button', { name: 'Hachiware' }).click();
  await button.click();
  const hachiReaction = await button.getAttribute('data-reaction');
  expect(isPetClickReaction(hachiReaction)).toBe(true);
  const hachiId = hachiReaction as PetClickReaction;
  const hachiSpec = clickReactionSpec(hachiId);
  const hachiVariant = Number(await button.getAttribute('data-reaction-variant'));
  await expect(button).toHaveClass(new RegExp(`reaction-${hachiId}`));
  await expect(button).toHaveCSS('animation-name', new RegExp(`pet-react-${hachiId}$`));
  const expectedCard = skinImage('hachiware', 'chibi', hachiSpec.mood);
  expect(expectedCard).not.toBeNull();
  await expect(panel.locator('img.skin-card')).toHaveAttribute('src', expectedCard!);
  await expect(reactionText).toHaveText(
    EN[clickLineKey('hachiware', { reaction: hachiId, variant: hachiVariant })]
  );

  // The DeepSeek chibi plays the reaction's H3 clip.
  await skins.getByRole('button', { name: 'DeepSeek' }).click();
  await button.click();
  const fishReaction = await button.getAttribute('data-reaction');
  expect(isPetClickReaction(fishReaction)).toBe(true);
  const fishId = fishReaction as PetClickReaction;
  const fishVariant = Number(await button.getAttribute('data-reaction-variant'));
  await expect(panel.getByTestId('pet-film')).toHaveAttribute(
    'data-clip',
    clickReactionSpec(fishId).clip
  );
  await expect(reactionText).toHaveText(
    EN[clickLineKey('deepseek-chibi', { reaction: fishId, variant: fishVariant })]
  );
});
