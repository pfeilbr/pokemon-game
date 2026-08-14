import { expect, test } from '@playwright/test';
import { answerCurrentProblem, createTrainer } from './helpers';

/**
 * The offline promise, tested the way it is actually broken.
 *
 * README and CLAUDE.md both call this game offline-first, and the profile and
 * the engine have always earned that. The shell did not: with a manifest but no
 * service worker the app *looked* installable, so a child could add it to a
 * home screen, open it in a car with no signal, and get a blank page. These
 * tests fail if that ever becomes true again.
 */

/** Resolves once a service worker is controlling the page. */
async function waitForController(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {
    timeout: 20_000,
  });
}

test.describe('offline', () => {
  test('the shell survives losing the network and the game is still playable', async ({
    page,
    context,
  }) => {
    await createTrainer(page, 'Leo', 'cindik');
    await waitForController(page);

    await context.setOffline(true);
    try {
      await page.reload();

      // Not a browser error page: the real dashboard, with the real save.
      await expect(page.getByText('Leo')).toBeVisible();
      await expect(page.getByText('Cindik')).toBeVisible();
      await expect(page.getByTestId('tile-play')).toBeVisible();

      // Playable, not merely rendered. A battle is the whole product, and it
      // runs entirely on the pure engine, so nothing here needs a server.
      await page.getByTestId('tile-play').click();
      await page.locator('[data-testid^="opponent-"]').first().click();
      await expect(page.getByTestId('battle')).toBeVisible();
      await page.getByTestId('move-strong').click();
      await answerCurrentProblem(page);
      await expect(page.getByText(/Correct!|Critical hit!/)).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('the API is never served from the cache', async ({ page, context }) => {
    await page.goto('/');
    await waitForController(page);

    // Warm anything the worker might wrongly be willing to keep. Polled rather
    // than asserted once: a hiccup while the server is still warming up is not
    // this test's subject, and it must not be able to masquerade as one.
    await expect
      .poll(() =>
        page.evaluate(async () => (await fetch('/api/session', { cache: 'no-store' })).ok),
      )
      .toBe(true);

    await context.setOffline(true);
    try {
      // A stale session or profile is worse than no answer at all: it would
      // tell a child he is signed in when nothing can be saved anywhere.
      const offline = await page.evaluate(async () => {
        try {
          await fetch('/api/session', { cache: 'no-store' });
          return 'answered';
        } catch {
          return 'failed';
        }
      });
      expect(offline).toBe('failed');
    } finally {
      await context.setOffline(false);
    }
  });
});
