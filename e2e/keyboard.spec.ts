import { type Page, expect, test } from '@playwright/test';
import { solve } from './helpers';

/**
 * Playing from a physical keyboard.
 *
 * The on-screen keypad is the right primary control - it is a tablet game, and
 * it is why the maths generator only ever produces non-negative whole numbers.
 * But the same app runs on a laptop, and the difficulty adapter is explicitly
 * calibrated around how slow it is to hunt for digits with a pointer: par at
 * tier 1 is 5.1 seconds, and `PATIENCE_WINDOW` exists because a seven-year-old
 * takes seven. Typing `12` and pressing Enter removes that tax entirely.
 *
 * The rule these tests defend is that there is exactly one keypad. Physical
 * keys are a second way to press it, never a second implementation of it - so
 * the digit cap, the leading-zero rule and the "empty answer cannot be
 * submitted" rule have to come out identical whichever way the key is pressed.
 *
 * The other half is restraint: a global key listener is a keystroke thief. A
 * focused text field and a focused button both own their own keys, and the
 * keypad has to keep its hands off them.
 */

/**
 * Onboarding, typed rather than filled.
 *
 * Deliberately not `createTrainer` from `helpers.ts`: that one uses `fill()`,
 * which sets the value without ever pressing a key, and pressing keys is the
 * entire subject here. Typing it also asserts the value landed before moving
 * on, which `fill()` cannot promise on a page still hydrating.
 */
async function signUp(page: Page, name = 'Leo', starter = 'cindik'): Promise<void> {
  await page.goto('/start');
  const field = page.getByPlaceholder(/type your name/i);
  await field.click();
  await page.keyboard.type(name);
  await expect(field).toHaveValue(name);

  await page.getByRole('button', { name: /next/i }).click();
  await page.getByTestId(`starter-${starter}`).click();
  await page.getByTestId('begin-adventure').click();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
}

/** Into a battle, with a question on screen and the keypad live. */
async function startBattle(page: Page): Promise<void> {
  await signUp(page);
  await page.getByTestId('tile-play').click();
  await page.locator('[data-testid^="opponent-"]').first().click();
  await expect(page.getByTestId('battle')).toBeVisible();
  await page.getByTestId('move-strong').click();
  await expect(page.getByTestId('problem')).toBeVisible();
}

test.describe('physical keyboard', () => {
  test('a battle turn is answerable from the keyboard alone', async ({ page }) => {
    await startBattle(page);

    // Read the question and work the answer out independently of the game,
    // exactly as the pointer-driven specs do - then type it rather than aim.
    const prompt = await page.getByTestId('problem').innerText();
    const answer = String(solve(prompt));

    await page.keyboard.type(answer);
    await expect(page.getByTestId('answer-display')).toHaveText(answer);

    await page.keyboard.press('Enter');

    await expect(page.getByText(/Correct!|Critical hit!/)).toBeVisible();
    // The hit actually landed: damage is on screen, not just praise.
    await expect(page.getByText(/−\d+/)).toBeVisible();
  });

  test('typed editing matches the on-screen keys exactly', async ({ page }) => {
    await startBattle(page);
    const display = page.getByTestId('answer-display');

    await expect(display).toHaveText('?');

    await page.keyboard.type('42');
    await expect(display).toHaveText('42');

    await page.keyboard.press('Backspace');
    await expect(display).toHaveText('4');

    await page.keyboard.press('Escape');
    await expect(display).toHaveText('?');

    // Same leading-zero rule the ⌨ buttons use: "07" would look like a bug.
    await page.keyboard.type('07');
    await expect(display).toHaveText('7');

    // Same four-digit cap, too.
    await page.keyboard.press('Escape');
    await page.keyboard.type('123456');
    await expect(display).toHaveText('1234');
  });

  test('Enter cannot submit an empty answer', async ({ page }) => {
    await startBattle(page);

    await page.keyboard.press('Enter');

    // Nothing was answered, so the question is still up and nothing resolved.
    await expect(page.getByTestId('problem')).toBeVisible();
    await expect(page.getByTestId('answer-display')).toHaveText('?');
  });

  test('Enter on a focused keypad key presses that key rather than submitting', async ({
    page,
  }) => {
    await startBattle(page);

    // A keyboard-only player tabs onto the "7" key. Enter is that button's own
    // keystroke; a global handler that swallows it leaves them unable to press
    // any key on the keypad at all.
    await page.getByRole('button', { name: '7', exact: true }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('answer-display')).toHaveText('7');
  });

  test('a focused text field keeps its own keystrokes', async ({ page }) => {
    await startBattle(page);

    // The battle screen carries no text field today, so this puts one on the
    // page to hold the guard in place: the keypad listener is global, and the
    // day a field does share the screen with it - a name edit, a search, a
    // parent's PIN - the failure would be silent typing, not an error.
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.type = 'text';
      field.id = 'probe-field';
      document.body.append(field);
      field.focus();
    });

    await page.keyboard.type('12');
    await page.keyboard.press('Backspace');

    await expect(page.locator('#probe-field')).toHaveValue('1');
    await expect(page.getByTestId('answer-display')).toHaveText('?');
  });

  test('the trainer-name field still receives digits', async ({ page }) => {
    // Real screen, real field. Guards against the keypad listener ever being
    // promoted to app scope, which would make this silently impossible - and
    // digits are exactly the keystrokes the keypad wants for itself.
    await page.goto('/start');
    const field = page.getByPlaceholder(/type your name/i);
    await field.click();
    await page.keyboard.type('Leo7');
    await expect(field).toHaveValue('Leo7');
  });

  test('tells a laptop player they can type, and says nothing on a touch screen', async ({
    page,
  }, testInfo) => {
    await startBattle(page);
    const hint = page.getByTestId('keyboard-hint');

    if (testInfo.project.name === 'mobile') {
      // A phone has no keyboard to hint at, and the battle screen belongs to a
      // seven-year-old: an unusable tip is clutter.
      await expect(hint).toHaveCount(0);
    } else {
      await expect(hint).toBeVisible();
    }
  });
});
