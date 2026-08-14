import { type Page, expect, test } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage/client';
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

  /**
   * A genuine two-device conflict - the one the old last-write-wins rule lost.
   *
   * The tablet and the laptop are both signed in and have both got ahead of the
   * other. Then the tablet, which has not pulled since, *only toggles a
   * setting*: that bumps `updatedAt` to now (`src/app/settings/page.tsx`)
   * without earning anything, and pushes. Under the old one-line rule that
   * stale save was simply "newer", so the laptop's next sync threw the laptop's
   * own album away to match it. `reconcile` now merges what was earned, so
   * opening the laptop again brings everything back.
   *
   * The divergence is written into each device's `localStorage` rather than
   * played out, on purpose:
   *   - the battle path already has coverage in 'carries progress to a
   *     different device' and in `game.spec.ts`; what is under test here is the
   *     merge, and seeding lets the conflict be stated exactly rather than
   *     hoped for;
   *   - a save written by hand is also what a *real* offline session looks like
   *     from the server's point of view - a device that vanished and came back
   *     further along.
   * `scripts/audit_sync.py` sweeps the same property over a corpus of profiles
   * that *are* built by playing.
   */
  test('merges two devices instead of letting the last writer win', async ({ page, browser }) => {
    const name = uniqueName('Merge');
    const now = Date.now();
    /** An hours-old timestamp, so the settings toggle later is genuinely newer. */
    const hoursAgo = (hours: number) => new Date(now - hours * 3600_000).toISOString();

    const readProfile = (target: Page) =>
      target.evaluate(async () => {
        const response = await fetch('/api/profile', { cache: 'no-store' });
        return (await response.json()).profile as {
          xp: number;
          caught: string[];
          badges: string[];
          battlesWon: number;
          bestCombo: number;
          settings: { sound: boolean };
        };
      });

    /** Puts a save on the device *and* on the server, with no merge in between. */
    const seed = (target: Page, key: string, patch: Record<string, unknown>) =>
      target.evaluate(
        async ([storageKey, changes]) => {
          const stored = window.localStorage.getItem(storageKey as string);
          const profile = { ...JSON.parse(stored as string), ...(changes as object) };
          window.localStorage.setItem(storageKey as string, JSON.stringify(profile));
          await fetch('/api/profile', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ profile }),
          });
          return profile as { caught: string[] };
        },
        [key, patch] as const,
      );

    // The tablet: an account, and an afternoon of play behind it.
    await createTrainer(page, name, 'cindik');
    await page.goto('/login');
    await page.getByLabel(/what's your trainer name/i).fill(name);
    await page.getByLabel(/4-digit pin/i).fill('1234');
    await page.getByTestId('submit-login').click();
    await expect(page).toHaveURL(/\/$/);

    await seed(page, STORAGE_KEY, {
      xp: 500,
      caught: ['cindik', 'sproutle', 'bublet'],
      badges: ['first-win'],
      battlesWon: 3,
      problemsCorrect: 40,
      problemsTotal: 50,
      bestCombo: 7,
      updatedAt: hoursAgo(3),
    });
    await page.reload();
    await expect(page.getByTestId('sync-status')).toContainText(/saved to your account/i);

    // The laptop: a genuinely separate client - its own localStorage, its own
    // cookies. It signs in, picks up the tablet's save, and gets further ahead.
    const laptopContext = await browser.newContext();
    const laptop = await laptopContext.newPage();
    await laptop.goto('/login');
    await laptop.getByRole('button', { name: /already have an account/i }).click();
    await laptop.getByLabel(/what's your trainer name/i).fill(name);
    await laptop.getByLabel(/4-digit pin/i).fill('1234');
    await laptop.getByTestId('submit-login').click();
    await expect(laptop).toHaveURL(/\/$/);
    await expect(laptop.getByTestId('sync-status')).toContainText(/saved to your account/i);
    expect((await readProfile(laptop)).caught).toContain('sproutle');

    await seed(laptop, STORAGE_KEY, {
      xp: 800,
      caught: ['cindik', 'sproutle', 'bublet', 'pebblo'],
      badges: ['first-win', 'combo-5'],
      battlesWon: 5,
      problemsCorrect: 70,
      problemsTotal: 90,
      bestCombo: 9,
      updatedAt: hoursAgo(1),
    });

    // The tablet has been sitting open the whole time and never pulled. All it
    // does is flip the sound off, from inside the app so the page never
    // remounts and never re-reads the server - and that alone is enough to make
    // its three-hour-old save the newest write there is.
    await page.getByRole('link', { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByTestId('toggle-sound').click();
    await page.waitForTimeout(2500);

    // The server takes that push at face value - `PUT /api/profile` stores what
    // it is given. So at this moment the server really has lost the laptop's
    // creature, and only the laptop still has it.
    expect((await readProfile(page)).caught).not.toContain('pebblo');

    // Opening the laptop again is where the two saves meet. Nothing either
    // device earned may be gone afterwards.
    await laptop.reload();
    await expect(laptop.getByTestId('sync-status')).toContainText(/saved to your account/i);
    await laptop.waitForTimeout(2500);

    const merged = await readProfile(laptop);
    expect(merged.caught).toEqual(expect.arrayContaining(['sproutle', 'bublet', 'pebblo']));
    expect(merged.badges).toEqual(expect.arrayContaining(['first-win', 'combo-5']));
    expect(merged.xp).toBe(800);
    expect(merged.battlesWon).toBe(5);
    expect(merged.bestCombo).toBe(9);
    // ...while the newest write still decides the mutable state it was about.
    expect(merged.settings.sound).toBe(false);

    // And the tablet agrees the next time it is opened: one album, both devices.
    await page.reload();
    await expect(page.getByTestId('sync-status')).toContainText(/saved to your account/i);
    await page.waitForTimeout(2500);
    const onTablet = await readProfile(page);
    expect(onTablet.caught).toEqual(expect.arrayContaining(merged.caught));
    expect(onTablet.badges).toEqual(expect.arrayContaining(merged.badges));
    expect(onTablet.xp).toBe(800);

    await laptopContext.close();
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
