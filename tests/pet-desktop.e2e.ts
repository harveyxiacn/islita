// The detached desktop pet (route /pet): the transparent window's own page.
// Everything is local — the sprite comes from the saved pet state and every
// action is applied with the same pure reducer as the island panel.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  clickLineKey,
  clickReactionSpec,
  isPetClickReaction,
  type PetClickReaction,
} from '../src/lib/pet/reactions';

const PET_URL = '/pet?settings=' + encodeURIComponent('{"petOnDesktop":true}');
const EN = JSON.parse(
  readFileSync(path.join('src', 'lib', 'i18n', 'en.json'), 'utf8')
) as Record<string, string>;

interface Seed {
  skin: string;
  form: string;
  name: string;
  sprite?: unknown;
}

async function seed(page: Page, seed: Seed): Promise<void> {
  await page.addInitScript((value: Seed) => {
    localStorage.setItem(
      'island.plugin.pet',
      JSON.stringify({
        version: 1,
        name: value.name,
        level: 1,
        xp: 0,
        fullness: 50,
        mood: 50,
        energy: 50,
        skin: value.skin,
        deepseekForm: value.form,
        lastSeen: Date.now(),
        sprite: value.sprite ?? null,
      })
    );
  }, seed);
}

test('the detached pet renders the saved skin, walks and reacts to a pat', async ({ page }) => {
  await seed(page, { skin: 'deepseek', form: 'chibi', name: 'Fishy' });
  await page.goto(PET_URL);

  const petButton = page.getByRole('button', { name: 'Pet: Fishy' });
  await expect(petButton).toBeVisible();
  // The bundled chibi is always drawn by the H3 player.
  const film = page.getByTestId('pet-film');
  await expect(film).toBeVisible();
  await expect(film).toHaveAttribute('data-clip', 'idle');
  await expect(film).toHaveAttribute('data-kind', 'film');
  await expect(film).toHaveAttribute('data-src', /\/pet\/animations\/idle-sheet\.webp$/);
  await expect(page.locator('img.sprite')).toHaveCount(0);
  await expect(page.locator('.stage')).toBeVisible();

  // The poster only covers decode. Leaving it under the transparent strip
  // paints a second silhouette behind the moving character.
  await expect(film).toHaveClass(/ready/);
  await expect(film.locator('img.poster')).toHaveCSS('opacity', '0');

  // A click without pointer movement is a pat, not a drag. The pat rolls one
  // of six performances; the line must belong to the reaction on screen.
  const figure = page.locator('.pet-figure');
  await petButton.click();
  const firstReaction = await figure.getAttribute('data-reaction');
  expect(isPetClickReaction(firstReaction)).toBe(true);
  const firstVariant = Number(await figure.getAttribute('data-reaction-variant'));
  expect(Number.isFinite(firstVariant)).toBe(true);
  await expect(page.locator('.bubble')).toHaveText(
    EN[
      clickLineKey('deepseek-chibi', {
        reaction: firstReaction as PetClickReaction,
        variant: firstVariant,
      })
    ]
  );

  // Two pats in a row never repeat the same performance.
  await page.waitForTimeout(500);
  await petButton.click();
  const secondReaction = await figure.getAttribute('data-reaction');
  expect(isPetClickReaction(secondReaction)).toBe(true);
  expect(secondReaction).not.toBe(firstReaction);

  await page.waitForTimeout(700);
  await petButton.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Pet menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Feed', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('.bubble')).toHaveText('White rice! One more bowl!');
  // Feeding swaps the idle loop for the generated eat performance.
  await expect(film).toHaveAttribute('data-clip', 'eat');
  await expect(film).toHaveAttribute('data-src', /\/pet\/animations\/eat-sheet\.webp$/);
  const strip = film.locator('img.sheet');
  await expect(strip).toBeVisible();
  const frameTransform = () =>
    strip.evaluate((element) => getComputedStyle(element).transform);
  const firstFrame = await frameTransform();
  // Decoding the strip and starting its rAF loop can take a moment under a
  // fully parallel run; poll instead of assuming one 250 ms step.
  await expect.poll(frameTransform, { timeout: 5000 }).not.toBe(firstFrame);
  await expect(page.locator('.pet-figure')).toHaveClass(/chewing/);
  await expect(page.locator('.pet-figure')).toHaveClass(/filming/);
  await expect(page.getByTestId('desktop-feast')).toHaveCount(0);

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('island.plugin.pet') ?? '{}')
  );
  expect(stored.fullness).toBeGreaterThan(70);
  expect(stored.name).toBe('Fishy');
  expect(stored.meals).toBe(1);
});

test('a non-DeepSeek pet gets the standalone rice bowl instead', async ({ page }) => {
  await seed(page, { skin: 'hachiware', form: 'chibi', name: 'Chiikawa' });
  await page.goto(PET_URL);

  const petButton = page.getByRole('button', { name: 'Pet: Chiikawa' });
  await expect(petButton).toBeVisible();
  await petButton.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Pet menu' })
    .getByRole('menuitem', { name: 'Feed', exact: true })
    .click();

  await expect(page.getByTestId('desktop-feast')).toHaveClass(/active/);
  await expect(page.getByTestId('pet-film')).toHaveCount(0);
});

test('play hops and rest sleeps with floating ZZZ', async ({ page }) => {
  await seed(page, { skin: 'deepseek', form: 'chibi', name: 'Fishy' });
  await page.goto(PET_URL);

  const petButton = page.getByRole('button', { name: 'Pet: Fishy' });
  await expect(petButton).toBeVisible();
  const film = page.getByTestId('pet-film');

  await petButton.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Pet menu' })
    .getByRole('menuitem', { name: 'Play', exact: true })
    .click();
  await expect(film).toHaveAttribute('data-clip', 'jump');

  // Let the one-shot hop finish before asking for a nap.
  await page.waitForTimeout(2800);
  await petButton.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Pet menu' })
    .getByRole('menuitem', { name: 'Rest', exact: true })
    .click();
  await expect(film).toHaveAttribute('data-clip', 'sleep');
  await expect(page.getByTestId('pet-zzz')).toBeVisible();
});

test('the context menu toggles wandering and hides the pet from the desktop', async ({ page }) => {
  await seed(page, { skin: 'hachiware', form: 'chibi', name: 'Chiikawa' });
  await page.goto(PET_URL);

  const petButton = page.getByRole('button', { name: 'Pet: Chiikawa' });
  await expect(petButton).toBeVisible();
  await expect(page.locator('img.sprite')).toHaveAttribute(
    'src',
    /\/pet\/desktop\/hachiware-idle\.webp$/
  );

  await petButton.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Pet menu' });
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Wander' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await menu.getByRole('menuitemcheckbox', { name: 'Wander' }).click();
  await expect(menu).toBeHidden();

  // Reopen: the setting the menu just wrote is reflected in its checkmark.
  await page.waitForTimeout(700);
  await petButton.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Pet menu' });
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Wander' })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await menu.getByRole('menuitem', { name: 'Hide from desktop' }).click();
  await expect(menu).toBeHidden();
});

test('the original mascot uses the inline SVG and reacts to a pat', async ({ page }) => {
  await seed(page, { skin: 'mochi', form: 'chibi', name: 'Mochi' });
  await page.goto(PET_URL);
  const petButton = page.getByRole('button', { name: 'Pet: Mochi' });
  await expect(petButton).toBeVisible();
  const creature = page.locator('svg.creature');
  await expect(creature).toBeVisible();

  await petButton.click();
  const figure = page.locator('.pet-figure');
  const reaction = await figure.getAttribute('data-reaction');
  expect(isPetClickReaction(reaction)).toBe(true);
  const id = reaction as PetClickReaction;
  await expect(creature).toHaveAttribute('data-status', clickReactionSpec(id).status);
  const beats: Record<PetClickReaction, string> = {
    nuzzle: 'pet-nuzzle',
    bounce: 'pet-hop',
    zoomies: 'pet-zoomies',
    munch: 'pet-chew',
    doze: 'pet-sleep',
    sulk: 'pet-sulk',
  };
  await expect(figure).toHaveCSS('animation-name', new RegExp(`${beats[id]}$`));
});

test('a custom portrait sprite takes precedence over the skin', async ({ page }) => {
  // A 1×1 PNG behind a valid 16×16 record; parsePetState only validates the
  // declared dimensions, never decodes the image.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3G0QAAAABJRU5ErkJggg==';
  await seed(page, {
    skin: 'hachiware',
    form: 'chibi',
    name: 'Custom',
    sprite: { dataUrl: PNG, width: 16, height: 16, frames: 1, fileName: 'tiny.png' },
  });
  await page.goto(PET_URL);
  await expect(page.getByRole('button', { name: 'Pet: Custom' })).toBeVisible();
  const sprite = page.locator('img.sprite');
  await expect(sprite).toBeVisible();
  await expect(sprite).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('svg.creature')).toHaveCount(0);
});

test('reduced motion keeps a still poster instead of the strip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seed(page, { skin: 'deepseek', form: 'chibi', name: 'Fishy' });
  await page.goto(PET_URL);

  const petButton = page.getByRole('button', { name: 'Pet: Fishy' });
  await petButton.waitFor();
  await petButton.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Pet menu' })
    .getByRole('menuitem', { name: 'Feed', exact: true })
    .click();

  const film = page.getByTestId('pet-film');
  await expect(film).toHaveAttribute('data-kind', 'still');
  await expect(film).toHaveAttribute('data-clip', 'eat');
  await expect(film.locator('img.still')).toHaveAttribute(
    'src',
    /\/pet\/animations\/eat-poster\.webp$/
  );
});
