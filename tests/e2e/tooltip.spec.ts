import { expect, test, type Page } from '@playwright/test';

// Custom tooltips (plan 21 Task 1, docs/architecture/ui-theme.md "Tooltips").
// Fixture buttons are injected so the test needs no audio and no layout.

async function fixture(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'tipbox';
    box.style.cssText = 'position:fixed;left:300px;top:300px;z-index:900;display:flex;gap:20px';
    box.innerHTML = '<button id="b1" title="First tip">One</button><button id="b2" title="Second tip">Two</button>';
    document.body.appendChild(box);
  });
}

const tip = (page: Page) => page.getByRole('tooltip');

test('hover shows a 13px tip within 400ms and suppresses the native title', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await expect(tip(page)).toBeVisible({ timeout: 400 });
  await expect(tip(page)).toHaveText('First tip');
  expect(await tip(page).evaluate((e) => getComputedStyle(e).fontSize)).toBe('13px');
  expect(await page.locator('#b1').getAttribute('title')).toBeNull();
  await expect(page.locator('#b1')).toHaveAttribute('aria-describedby', 'tooltip-layer');
  await page.mouse.move(10, 10);
  await expect(tip(page)).toBeHidden();
  await expect(page.locator('#b1')).toHaveAttribute('title', 'First tip');
});

test('moving to a second button shows its tip at once', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await expect(tip(page)).toBeVisible();
  await page.locator('#b2').hover();
  // No 250 ms wait: the new text is there within a frame or two.
  await expect(tip(page)).toHaveText('Second tip', { timeout: 100 });
});

test('pointerdown hides the tip', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await expect(tip(page)).toBeVisible();
  await page.mouse.down();
  await expect(tip(page)).toBeHidden();
  await page.mouse.up();
});

test('removing the element hides the tip', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await expect(tip(page)).toBeVisible();
  await page.evaluate(() => document.getElementById('tipbox')!.remove());
  await expect(tip(page)).toBeHidden();
});

test('a title changed while shown updates the tip; Esc hides it', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await expect(tip(page)).toBeVisible();
  await page.evaluate(() => document.getElementById('b1')!.setAttribute('title', 'Changed'));
  await expect(tip(page)).toHaveText('Changed');
  await page.keyboard.press('Escape');
  await expect(tip(page)).toBeHidden();
});

test('keyboard focus shows the tip', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab'); // back onto #b1 via the keyboard
  await expect(tip(page)).toBeVisible();
});

test('removing the element during the delay shows no tip', async ({ page }) => {
  await fixture(page);
  await page.locator('#b1').hover();
  await page.evaluate(() => document.getElementById('tipbox')!.remove());
  await page.waitForTimeout(450);
  await expect(tip(page)).toBeHidden();
});

test('the top-bar hint line still reads a hovered (claimed) title', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  const hint = page.getByTestId('hint-line');
  await page.getByTestId('loop-toggle').hover();
  await expect(hint).toHaveText('Loop the loop range while playing the song');
  await expect(tip(page)).toBeVisible();
});
