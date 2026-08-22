import { defineConfig, devices } from '@playwright/test';

/**
 * True when this run is capturing the images in `docs/screenshots/`.
 *
 * The screenshot suite is the only spec in `e2e/` that writes files *into the
 * repository*, which is what makes a wrong server permanently damaging there
 * rather than merely flaky: the picture gets committed and the README shows it
 * to everyone who never runs the app.
 *
 * `npm run screenshots` sets `E2E_CAPTURE=1`. The argv sniff is for the same
 * command typed by hand (`npx playwright test e2e/screenshots.spec.ts`), so
 * this does not become one more thing to remember. Neither is the real guard:
 * `e2e/screenshots.spec.ts` checks the build stamp of the server it is actually
 * looking at before every single capture, in every run mode.
 */
const capturing =
  process.env.E2E_CAPTURE === '1' ||
  process.argv.slice(2).some((arg) => arg.includes('screenshots'));

// Playwright loads this config twice: once in the CLI process, which has the
// command line, and again in each worker, whose argv is only
// `workerProcessEntry.js`. Deciding the port from argv alone therefore gave the
// workers a *different* baseURL from the server the CLI had just started - the
// run photographed port 3100 while its own server sat on 3177. The environment
// is inherited by the workers, so stamping the answer into it is what keeps the
// two halves of the run talking about the same server.
process.env.E2E_CAPTURE = capturing ? '1' : '';

/**
 * Three ports, deliberately: 3000 is `next dev`, 3100 is the ordinary E2E
 * suite, 3177 is a capture run. A capture can therefore not collide with the
 * dev server a contributor keeps open all day, nor with an E2E server another
 * run left behind - which is the collision that produced seven blank captures.
 */
const PORT = Number(process.env.PORT ?? (capturing ? 3177 : 3100));
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Some sandboxes ship a Chromium build that predates the one this Playwright
 * version downloads. PLAYWRIGHT_CHROMIUM_PATH points at the local binary in
 * that case; unset, Playwright uses its own managed browser as usual.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // Deterministic rendering for screenshot diffing.
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: { executablePath },
      },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: baseURL,
        /**
         * Reuse is what makes the ordinary `npm run test:e2e` loop quick: leave
         * `npx next start -p 3100` running in a second terminal and every run
         * attaches to it instead of paying a server boot, which is worth having
         * when you are re-running one spec twenty times.
         *
         * It is also the trap. Playwright attaches to *whatever* is listening -
         * a `next dev` server, or a `next start` from a build three commits old
         * - and says nothing. That is how seven screenshots came back blank,
         * four of them from tests that reported PASS.
         *
         * So a capture run never reuses. It starts its own server on its own
         * port or it fails to start at all, which turns the silent collision
         * into `http://127.0.0.1:3177 is already used` before a single PNG is
         * written. The ordinary suite keeps the fast loop; it writes nothing
         * into the repository, so the worst a stale server costs there is a
         * confusing failure rather than a wrong picture - and the build-stamp
         * check in `e2e/screenshots.spec.ts` covers the captures even when they
         * ride along in a full (reusing) `npm run test:e2e`.
         */
        reuseExistingServer: !process.env.CI && !capturing,
        timeout: 120_000,
        env: {
          AUTH_SECRET: 'e2e-test-secret-not-for-production-use-0123456789',
          // Handed through only when a test database is offered, so the default
          // run exercises the zero-config (local-only) deployment and the
          // account specs skip themselves.
          ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
        },
      },
});
