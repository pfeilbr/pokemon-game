import { expect, test } from '@playwright/test';
import { createTrainer, playBattleToEnd } from './helpers';

/**
 * The signed-in path, end to end through the real API routes and a real
 * database.
 *
 * Skipped automatically when the server under test has no database, which is
 * the default. To run these:
 *
 *   TEST_DATABASE_URL='postgres://…?sslmode=disable' npm run test:e2e
 */

/** A fresh trainer name per test, so runs do not collide in a shared database. */
function uniqueName(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.get('/api/session');
  const session = (await response.json()) as { accountsAvailable: boolean };
  test.skip(!session.accountsAvailable, 'no database attached to the server under test');
});

test.describe('accounts', () => {
  test('reports that accounts are available', async ({ page }) => {
    await createTrainer(page);
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible();
  });

  test('creates an account and reports progress as saved to it', async ({ page }) => {
    const name = uniqueName('Leo');
    await createTrainer(page, name);

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();

    await expect(page).toHaveURL(/\/$/);
    const status = page.getByTestId('sync-status');
    if (await status.isVisible().catch(() => false)) {
      await expect(status).toContainText(/saved to your account/i);
    }
  });

  test('refuses a name that is already registered', async ({ page }) => {
    const name = uniqueName('Dup');
    await createTrainer(page, name);

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    // A second sign-up under the same name must be rejected.
    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('5678');
    await page.getByTestId('submit-login').click();
    await expect(page.getByTestId('login-error')).toContainText(/taken/i);
  });

  test('rejects the wrong PIN on sign-in', async ({ page }) => {
    const name = uniqueName('Wrong');
    await createTrainer(page, name);

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/settings');
    await page.getByRole('button', { name: /sign out/i }).click();

    await page.goto('/login');
    await page.getByRole('button', { name: /already have an account/i }).click();
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('9999');
    await page.getByTestId('submit-login').click();
    await expect(page.getByTestId('login-error')).toContainText(/do not match/i);
  });

  /**
   * The whole point of accounts: progress earned on one device shows up on
   * another. A second browser context is a genuinely different client - fresh
   * localStorage, fresh cookies.
   */
  test('carries progress to a different device', async ({ page, browser }) => {
    const name = uniqueName('Sync');
    await createTrainer(page, name, 'cindik');

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    // Earn something worth syncing.
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await playBattleToEnd(page);
    await page.getByRole('button', { name: /^home$/i }).click();

    // Give the debounced push time to land.
    await expect(page.getByTestId('sync-status')).toContainText(/saved to your account/i);
    await page.waitForTimeout(2500);

    const secondDevice = await browser.newContext();
    const other = await secondDevice.newPage();
    await other.goto('/login');
    await other.getByRole('button', { name: /already have an account/i }).click();
    await other.getByLabel(/what's your trainer name/i).fill(name);
    await other.getByLabel(/4-digit pin/i).fill('1234');
    await other.getByTestId('submit-login').click();

    await expect(other).toHaveURL(/\/$/);
    await expect(other.getByText(name)).toBeVisible();

    // The battle won on the first device is on the record here too.
    await other.getByTestId('tile-progress').click();
    await expect(other.getByTestId('badge-first-win')).toContainText(/First Victory/);

    await secondDevice.close();
  });

  test('signing out returns to local-only saving without losing the profile', async ({ page }) => {
    const name = uniqueName('Out');
    await createTrainer(page, name);

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/settings');
    await page.getByRole('button', { name: /sign out/i }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(name)).toBeVisible();
  });

  test('the profile endpoint refuses an unauthenticated caller', async ({ page }) => {
    const context = await page.context().browser()!.newContext();
    const anonymous = await context.newPage();

    expect((await anonymous.request.get('/api/profile')).status()).toBe(401);
    expect((await anonymous.request.put('/api/profile', { data: { profile: {} } })).status()).toBe(
      401,
    );

    await context.close();
  });

  test('the server repairs a tampered profile rather than storing it', async ({ page }) => {
    const name = uniqueName('Tamper');
    await createTrainer(page, name);

    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    // Issued from inside the page rather than via page.request: the session
    // cookie is marked Secure (next start runs in production mode), and while
    // Chromium treats 127.0.0.1 as a secure origin and sends it, Playwright's
    // Node-side request context will not send a Secure cookie over plain http.
    const status = await page.evaluate(async (trainerName) => {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: {
            trainerName,
            starterId: 'not-a-creature',
            xp: -999,
            badges: ['invented-badge'],
            caught: ['fake-mon'],
            tier: 9999,
          },
        }),
      });
      return response.status;
    }, name);
    expect(status).toBe(200);

    const loaded = await page.evaluate(async () => {
      const response = await fetch('/api/profile', { cache: 'no-store' });
      return (await response.json()) as { profile: unknown };
    });
    const profile = loaded.profile as {
      xp: number;
      badges: string[];
      caught: string[];
      tier: number;
      starterId: string;
    };

    expect(profile.xp).toBe(0);
    expect(profile.badges).toEqual([]);
    expect(profile.caught).not.toContain('fake-mon');
    expect(profile.tier).toBeLessThanOrEqual(10);
    expect(profile.starterId).toBe('cindik');
  });
});
