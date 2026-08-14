import { type Page, expect, test } from '@playwright/test';
import { STRINGS } from '../src/lib/i18n';
import { STORAGE_KEY } from '../src/lib/storage/key';
import { createTrainer } from './helpers';

/**
 * What a crash looks like from the child's side of the screen.
 *
 * The engine throws on invalid data on purpose, so a React render can throw,
 * and an unhandled render error in the App Router is a blank white page. To a
 * seven-year-old that is not "an error" - it is the game being gone, with no
 * adult nearby who would think to open devtools. These tests are the proof that
 * he gets a sentence and a big button instead, and - just as important - that
 * nothing on that screen quietly takes his album away to get the app rendering
 * again.
 *
 * How the crash is injected
 * -------------------------
 * `FaultProbe` renders inside `AppShell`, throws a *real* engine error
 * (`getCreature` on an id this build does not have - the exact failure mode
 * CLAUDE.md describes), and is armed only when both `navigator.webdriver` is
 * true and a sentinel was planted on `window` before the component mounted.
 * Neither condition can be reached by a link, a bookmark or a stray tap, which
 * is why this is not a `?crash=1` query parameter.
 *
 * A corrupt save was tried first and could not be made to crash anything:
 * `normaliseProfile` really does repair every field it is given, which is the
 * behaviour CLAUDE.md promises. That closes the save-corruption route to a
 * white screen and leaves code bugs as the route that remains - so a code bug
 * is what these tests inject.
 */

const SENTINEL = 'render-crash';

/** Arms the probe for every subsequent load of this page. */
async function armCrash(page: Page): Promise<void> {
  await page.addInitScript((sentinel) => {
    (window as unknown as { __mathmonFaultProbe?: string }).__mathmonFaultProbe = sentinel;
  }, SENTINEL);
}

/**
 * Disarms it for the current document only. `reset()` re-renders rather than
 * reloading, so this is what "the bug has gone away" looks like to the app.
 */
async function disarmCrash(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete (window as unknown as { __mathmonFaultProbe?: string }).__mathmonFaultProbe;
  });
}

function savedProfile(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

test.describe('crash recovery', () => {
  test('a render crash shows a friendly screen, not a blank page, and try again recovers', async ({
    page,
  }) => {
    await createTrainer(page, 'Leo', 'cindik');
    const saveBefore = await savedProfile(page);
    expect(saveBefore).toBeTruthy();

    await armCrash(page);
    await page.reload();

    // Not a blank page: the recovery screen, with words on it.
    const recovery = page.getByTestId('crash-recovery');
    await expect(recovery).toBeVisible();
    await expect(page.getByText(STRINGS.crashTitle.en)).toBeVisible();
    const visibleText = await page.evaluate(() => document.body.innerText.trim());
    expect(visibleText.length).toBeGreaterThan(0);

    // It says the thing he needs to hear before anything else.
    await expect(page.getByText(STRINGS.crashBody.en)).toBeVisible();

    // Big enough for a seven-year-old's finger, per the 56px rule.
    const tryAgain = page.getByTestId('crash-try-again');
    await expect(tryAgain).toBeVisible();
    const box = await tryAgain.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);

    // A way home is always on the screen, so a crash cannot strand him.
    await expect(page.getByTestId('crash-go-home')).toBeVisible();

    // Crashing changed nothing about what is saved.
    expect(await savedProfile(page)).toBe(saveBefore);

    // The bug goes away; "try again" really does bring the game back.
    await disarmCrash(page);
    await tryAgain.click();

    await expect(recovery).toBeHidden();
    await expect(page.getByText('Leo')).toBeVisible();
    await expect(page.getByTestId('tile-play')).toBeVisible();
    expect(await savedProfile(page)).toBe(saveBefore);
  });

  test('the way home works even while the page is still crashing', async ({ page }) => {
    await createTrainer(page, 'Leo', 'cindik');
    await armCrash(page);
    await page.goto('/album');
    await expect(page.getByTestId('crash-recovery')).toBeVisible();

    // Home is a real navigation, so it survives the subtree still being broken.
    await disarmCrash(page);
    await page.getByTestId('crash-go-home').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('tile-play')).toBeVisible();
  });

  test('the save is never erased without two deliberate taps', async ({ page }) => {
    await createTrainer(page, 'Leo', 'cindik');
    const saveBefore = await savedProfile(page);

    await armCrash(page);
    await page.reload();
    await expect(page.getByTestId('crash-recovery')).toBeVisible();

    // First crash: the destructive door is not even on the screen.
    await expect(page.getByTestId('crash-still-stuck')).toBeHidden();

    // Retry with the fault still armed: it crashes again, and the child still
    // gets the friendly screen rather than a white one.
    await page.getByTestId('crash-try-again').click();
    await expect(page.getByTestId('crash-recovery')).toBeVisible();
    expect(await savedProfile(page)).toBe(saveBefore);

    // Only now is starting over offered, and it is still only an offer.
    const stillStuck = page.getByTestId('crash-still-stuck');
    await expect(stillStuck).toBeVisible();
    await stillStuck.click();

    const confirm = page.getByTestId('crash-erase-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByText(STRINGS.eraseSaveWarning.en)).toBeVisible();
    expect(await savedProfile(page)).toBe(saveBefore);

    // Backing out leaves the album exactly where it was.
    await page.getByRole('button', { name: STRINGS.back.en }).click();
    await expect(confirm).toBeHidden();
    expect(await savedProfile(page)).toBe(saveBefore);

    // Confirming - and only confirming - clears it, and lands him somewhere he
    // can start again rather than on another crash.
    await stillStuck.click();
    await page.getByTestId('crash-erase-confirmed').click();
    await expect(page.getByPlaceholder(/type your name/i)).toBeVisible();
    expect(await savedProfile(page)).toBeNull();
  });

  test('the recovery screen speaks the language the player chose', async ({ page }) => {
    await createTrainer(page, 'Leo', 'cindik');
    await page.goto('/settings');
    await page.getByTestId('lang-zh').click();
    await expect(page.getByTestId('lang-zh')).toHaveAttribute('aria-pressed', 'true');

    await armCrash(page);
    await page.reload();

    await expect(page.getByTestId('crash-recovery')).toBeVisible();
    await expect(page.getByText(STRINGS.crashTitle.zh)).toBeVisible();
    await expect(page.getByText(STRINGS.crashBody.zh)).toBeVisible();
    await expect(page.getByTestId('crash-try-again')).toHaveText(STRINGS.tryAgain.zh);
  });
});
