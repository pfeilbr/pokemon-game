import { type Locator, type Page, expect, test } from '@playwright/test';
import { solve } from './helpers';

/**
 * Playing without a pointer at all.
 *
 * `e2e/keyboard.spec.ts` proves the keypad accepts physical keys. This spec
 * asks the question that comes before that one: can the player *get* to the
 * controls, and can they see where they are once they have?
 *
 * Two properties, and neither can be read out of the source - which is exactly
 * the division of labour with `scripts/audit_focus.py`. That script proves the
 * static half (no positive tabindex, no suppressed focus ring, no `<div>`
 * pretending to be a button); this one drives a browser, because where focus
 * *goes* when a screen replaces itself is behaviour, not text.
 *
 *   1. Reachability. Every control used here is arrived at with Tab and
 *      pressed with Enter or Space. `tabTo` fails loudly rather than falling
 *      back to a click, so a control that drops out of the tab order fails the
 *      test rather than quietly passing on a mouse.
 *
 *   2. Focus is never dropped. A battle replaces its own controls three times
 *      a turn - moves become the keypad, the keypad becomes "Continue", and
 *      the result screen replaces the lot. Each of those unmounts whatever the
 *      player was standing on, and an unmounted element leaves focus on
 *      `<body>`: the page keeps working for anyone typing digits (the keypad
 *      listens on `window`), while a player who tabs is silently sent back to
 *      the top of the page to walk in again past the header, the nav and both
 *      creature cards, every single turn.
 */

/** WCAG 2.4.11 wants a focus indicator at least this thick. */
const MIN_RING_PX = 2;

/** How many Tab presses a control may reasonably be behind. */
const TAB_BUDGET = 40;

/** A short, stable description of whatever has focus right now. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return 'body';
    const testId = el.getAttribute('data-testid');
    const label = el.getAttribute('aria-label');
    return [
      el.tagName.toLowerCase(),
      testId ? `[${testId}]` : '',
      label ? `("${label}")` : '',
    ].join('');
  });
}

/** True when `target` is the element that currently has focus. */
async function hasFocus(target: Locator): Promise<boolean> {
  return target.evaluate((node) => node === document.activeElement).catch(() => false);
}

/**
 * Tabs until `target` has focus, exactly as a player would.
 *
 * Deliberately never clicks. The point of the helper is that reaching the
 * control by keyboard is the assertion; a fallback would turn a broken tab
 * order into a green test.
 */
async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
  await expect(target, `${what} is not on the page to tab to`).toBeVisible();
  for (let press = 0; press <= TAB_BUDGET; press++) {
    if (await hasFocus(target)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `${what} could not be reached in ${TAB_BUDGET} Tab presses; focus ended on ${await focused(page)}`,
  );
}

/**
 * What the focus ring on `target` actually looks like, and what it looks like
 * without focus.
 *
 * Reading the outline alone would be too narrow: the global `:focus-visible`
 * rule draws one, but a control is equally allowed to answer with a ring drawn
 * as a box-shadow, which is what the Tailwind `focus:ring-*` on the text
 * fields does. So both are read, and the unfocused reading is taken as the
 * control so that "it already looked like that" cannot pass for an indicator.
 */
async function ringOf(target: Locator): Promise<{
  focused: string;
  blurred: string;
  outlineStyle: string;
  outlineWidth: number;
  focusVisible: boolean;
}> {
  return target.evaluate((node: HTMLElement) => {
    const read = () => {
      const s = getComputedStyle(node);
      return `outline:${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} shadow:${s.boxShadow}`;
    };
    const withFocus = read();
    const style = getComputedStyle(node);
    const outlineStyle = style.outlineStyle;
    const outlineWidth = parseFloat(style.outlineWidth) || 0;
    const focusVisible = node.matches(':focus-visible');
    node.blur();
    const withoutFocus = read();
    node.focus();
    return {
      focused: withFocus,
      blurred: withoutFocus,
      outlineStyle,
      outlineWidth,
      focusVisible,
    };
  });
}

/** Asserts the focused element is visibly marked as focused. */
async function expectVisibleRing(target: Locator, what: string): Promise<void> {
  const ring = await ringOf(target);
  expect(ring.focused, `${what} looks identical focused and unfocused`).not.toBe(ring.blurred);

  const outline = ring.outlineStyle !== 'none' && ring.outlineWidth >= MIN_RING_PX;
  const shadow = ring.focused !== ring.blurred && !ring.focused.includes('shadow:none');
  expect(
    outline || shadow,
    `${what} has no visible focus indicator: ${ring.focused} (unfocused: ${ring.blurred})`,
  ).toBe(true);
}

/** Onboarding, with the keyboard only: no click anywhere in here. */
async function signUpByKeyboard(page: Page, name = 'Leo'): Promise<void> {
  await page.goto('/start');

  const field = page.getByPlaceholder(/type your name/i);
  await tabTo(page, field, 'the trainer-name field');
  await expectVisibleRing(field, 'the trainer-name field');
  await page.keyboard.type(name);
  await expect(field).toHaveValue(name);

  const next = page.getByRole('button', { name: /next/i });
  await tabTo(page, next, 'the Next button');
  await expectVisibleRing(next, 'the Next button');
  await page.keyboard.press('Enter');

  const starter = page.getByTestId('starter-cindik');
  await tabTo(page, starter, 'the first starter');
  await expectVisibleRing(starter, 'the starter card');
  // Space, not Enter: a button must answer both, and Space is the one a
  // player who has just tabbed onto a card reaches for.
  await page.keyboard.press('Space');
  await expect(starter).toHaveAttribute('aria-pressed', 'true');

  const begin = page.getByTestId('begin-adventure');
  await tabTo(page, begin, 'the "Let\'s go!" button');
  await page.keyboard.press('Enter');
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
}

test.describe('keyboard-only play', () => {
  test('sign-up, an opponent and a battle turn, without touching the mouse', async ({ page }) => {
    await signUpByKeyboard(page);

    const play = page.getByTestId('tile-play');
    await tabTo(page, play, 'the Battle tile');
    await expectVisibleRing(play, 'the Battle tile');
    await page.keyboard.press('Enter');

    const opponent = page.locator('[data-testid^="opponent-"]').first();
    await tabTo(page, opponent, 'the first opponent');
    await expectVisibleRing(opponent, 'an opponent card');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('battle')).toBeVisible();

    const move = page.getByTestId('move-strong');
    await tabTo(page, move, 'the strong move');
    await expectVisibleRing(move, 'a move button');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('problem')).toBeVisible();

    // The keypad, pressed rather than typed: the "1" key is reachable by Tab
    // and Enter presses it. This is the bug `Keypad.belongsToFocus` fixes -
    // a global Enter handler that submitted an empty answer instead.
    const one = page.getByRole('button', { name: '1', exact: true });
    await tabTo(page, one, 'the "1" key on the keypad');
    await expectVisibleRing(one, 'a keypad key');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('answer-display')).toHaveText('1');

    // Then answer it properly. Escape clears, the digits are typed, and the
    // answer is sent by tabbing onto "Go!" and pressing it - not by pressing
    // Enter from the "1" key, which correctly presses *that key* instead.
    // That distinction is the whole of `Keypad.belongsToFocus`, so a
    // keyboard-only player has to be able to reach the submit button.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('answer-display')).toHaveText('?');

    const prompt = await page.getByTestId('problem').innerText();
    await page.keyboard.type(String(solve(prompt)));

    const go = page.getByTestId('submit-answer');
    await tabTo(page, go, 'the "Go!" button');
    await expectVisibleRing(go, 'the "Go!" button');
    await page.keyboard.press('Enter');

    await expect(page.getByText(/Correct!|Critical hit!/)).toBeVisible();
  });

  test('focus is never dropped on <body> as the battle advances', async ({ page }) => {
    await signUpByKeyboard(page);

    const play = page.getByTestId('tile-play');
    await tabTo(page, play, 'the Battle tile');
    await page.keyboard.press('Enter');

    const opponent = page.locator('[data-testid^="opponent-"]').first();
    await tabTo(page, opponent, 'the first opponent');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('battle')).toBeVisible();

    const move = page.getByTestId('move-strong');
    await tabTo(page, move, 'the strong move');
    await page.keyboard.press('Enter');

    // The move buttons have just been replaced by the keypad, taking the
    // focused button with them.
    await expect(page.getByTestId('problem')).toBeVisible();
    expect(await focused(page), 'focus was dropped when the question appeared').not.toBe('body');

    // Three turns is enough to cross every transition the loop has: question
    // to result, result back to the move buttons, and round again.
    for (let turn = 0; turn < 3; turn++) {
      if (
        await page
          .getByTestId('battle-result')
          .isVisible()
          .catch(() => false)
      )
        break;

      if (
        await page
          .getByTestId('problem')
          .isVisible()
          .catch(() => false)
      ) {
        const prompt = await page.getByTestId('problem').innerText();
        await page.keyboard.type(String(solve(prompt)));
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('problem')).toBeHidden();
        expect(await focused(page), 'focus was dropped when the answer resolved').not.toBe('body');
      }

      const moves = page.getByTestId('move-strong');
      await expect(moves).toBeVisible({ timeout: 15_000 });
      expect(await focused(page), 'focus was dropped when the turn came back around').not.toBe(
        'body',
      );

      // Reachable again without walking in from the top of the page: whatever
      // holds focus now is inside the battle, so the moves are a few Tabs away
      // rather than a whole page away.
      await tabTo(page, moves, 'the strong move on a later turn');
      await page.keyboard.press('Enter');
    }
  });

  test('the result screen takes focus when it replaces the battle', async ({ page }) => {
    await signUpByKeyboard(page);

    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await expect(page.getByTestId('battle')).toBeVisible();

    // Lose on purpose - it is much the shorter route to the result screen, and
    // losing still awards XP, so it is a real end of a real battle. Wrong
    // answers deal flat chip damage and the foe hits back every turn.
    for (let guard = 0; guard < 60; guard++) {
      if (
        await page
          .getByTestId('battle-result')
          .isVisible()
          .catch(() => false)
      )
        break;
      if (
        await page
          .getByTestId('problem')
          .isVisible()
          .catch(() => false)
      ) {
        await page.keyboard.type('0');
        await page.keyboard.press('Enter');
        continue;
      }
      const move = page.getByTestId('move-strong');
      if (await move.isVisible().catch(() => false)) {
        await move.click();
        continue;
      }
      await page.waitForTimeout(100);
    }

    await expect(page.getByTestId('battle-result')).toBeVisible({ timeout: 30_000 });
    expect(
      await focused(page),
      'focus was dropped when the result screen replaced the battle',
    ).not.toBe('body');

    // And the way onward is a short Tab away rather than a page away.
    const again = page.getByTestId('play-again');
    await tabTo(page, again, 'the "Play again" button');
    await expectVisibleRing(again, 'the "Play again" button');
  });
});

test.describe('the album dialog', () => {
  test('opens, traps Tab, closes on Escape and hands focus back', async ({ page }) => {
    await signUpByKeyboard(page);

    const album = page.getByTestId('tile-album');
    await tabTo(page, album, 'the Album tile');
    await page.keyboard.press('Enter');

    const card = page.getByTestId('album-cindik');
    await tabTo(page, card, 'the starter in the album');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await focused(page), 'the dialog opened without taking focus').not.toBe('body');

    // Tab cannot escape into the cards the overlay is covering.
    const close = page.getByTestId('creature-dialog-close');
    for (let press = 0; press < 4; press++) {
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
        'Tab walked out of the dialog and into the cards behind it',
      ).toBe(true);
    }
    await expectVisibleRing(close, 'the dialog close button');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(
      await hasFocus(card),
      'closing the dialog did not hand focus back to the card that opened it',
    ).toBe(true);
  });
});
