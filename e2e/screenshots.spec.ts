import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage/client';
import { answerCurrentProblem, createTrainer, playBattleToEnd, solve } from './helpers';

/**
 * Captures the screenshots used in the README.
 *
 * Runs as part of the normal E2E suite, so the images cannot silently drift
 * away from what the app actually renders.
 *
 * `page.screenshot()` succeeds whether the page rendered the game or a white
 * rectangle, so this file cannot be the only thing guarding the images.
 * `scripts/audit_screenshots.py` re-checks the committed files from the bytes
 * up - valid PNG, right size, not blank, not white, no two of them the same
 * picture - with no browser, on every push.
 */

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

/**
 * The minimum number of characters of visible text a real screen of this app
 * has in its `<main>`. The sparsest is /login with accounts disabled, at 96.
 */
const MIN_RENDERED_TEXT = 40;

/**
 * The path prefix the app is served under, if any (GitHub Pages builds set it).
 * Empty for every normal build, including every capture run.
 */
const BASE_PATH = process.env.PAGES_BASE_PATH ?? '';

/**
 * The id of the production build sitting in the working tree.
 *
 * `next build` writes a fresh random id here every time, and `next start`
 * serves that build's client assets under `/_next/static/<id>/`. So the id is a
 * stamp naming exactly one server: the one built from this tree. A `next dev`
 * server serves `development` and has no such path; a `next start` left over
 * from an earlier build serves a different id. Neither can forge ours.
 */
function buildIdOnDisk(): string {
  try {
    const id = readFileSync('.next/BUILD_ID', 'utf8').trim();
    if (id) return id;
  } catch {
    // An unreadable stamp is a missing one - same message either way.
  }
  throw new Error(
    'There is no production build to photograph: .next/BUILD_ID is missing or empty.\n' +
      'Run `npm run build` before capturing screenshots.',
  );
}

/** One check per origin, not one per capture. */
const stampChecked = new Map<string, Promise<void>>();

/**
 * Refuses to photograph a server this run did not start.
 *
 * `playwright.config.ts` gives a capture run its own port and forbids it to
 * reuse a server, which makes the collision that caused the incident
 * impossible - but "impossible" is a property of one code path, and the
 * screenshot spec also runs inside a plain `npm run test:e2e` (which does
 * reuse), and can be pointed anywhere with `E2E_BASE_URL`. This is the check
 * that holds in all of them, and the only one that catches the nastiest shape
 * of the bug: the port is right, a server is listening, it renders the app
 * perfectly - and it is a `next dev` server, or a build from last week.
 *
 * A wrong page is caught by the text guard below. A wrong *server* renders a
 * page that looks completely fine, so nothing downstream can catch it: the
 * pixels are plausible, the tests pass, and the wrong picture is committed.
 */
async function assertServerIsOurs(page: Page): Promise<void> {
  const here = new URL(page.url());
  if (here.protocol !== 'http:' && here.protocol !== 'https:') {
    throw new Error(`Cannot verify the server under test: the page is at ${page.url()}`);
  }
  const origin = here.origin;

  let check = stampChecked.get(origin);
  if (!check) {
    check = (async () => {
      const id = buildIdOnDisk();
      const stamp = (build: string) =>
        `${origin}${BASE_PATH}/_next/static/${build}/_buildManifest.js`;

      const ours = await page.request.get(stamp(id), { failOnStatusCode: false });
      if (ours.ok()) return;

      const dev = await page.request.get(stamp('development'), { failOnStatusCode: false });
      const found = dev.ok()
        ? 'a `next dev` server (dev serves `development`, never a build id)'
        : 'a server built from something else - an older build, or not this app at all';

      throw new Error(
        [
          `Refusing to photograph ${origin}: it is not serving this build.`,
          '',
          `  this tree's build (.next/BUILD_ID)   ${id}`,
          `  what is answering on ${origin}   ${found}`,
          '',
          'docs/screenshots/ is committed and the README is built from it, so a',
          'capture taken against the wrong server is a permanent wrong picture of',
          'the app - which is exactly how seven blank captures were produced, four',
          'of them by tests that reported PASS.',
          '',
          'Either stop whatever is on that port, or run `npm run build` and then',
          '`npm run screenshots`, which starts a server of its own on port 3177 and',
          'refuses to reuse one.',
        ].join('\n'),
      );
    })();
    stampChecked.set(origin, check);
  }
  await check;
}

/**
 * Captures one screenshot, refusing to capture a page that has not painted.
 *
 * `page.screenshot()` is happy to photograph an empty shell, and on the run
 * that added this guard it did exactly that: Playwright's `reuseExistingServer`
 * quietly attached to a `next dev` server another process had left on the port,
 * and seven captures came back as the header over an empty `<main>`. Four of
 * the tests writing them reported PASS, because a test that only navigates and
 * screenshots asserts nothing at all. Two of those files were committed.
 *
 * So every capture now has to prove the screen rendered first. The audit script
 * is the second net, not the only one.
 */
const shot = async (page: Page, name: string) => {
  // First, because a blank page served by a foreign server should be reported
  // as the foreign server, not as a page that failed to paint - and because
  // waiting ten seconds for the text poll to time out buries the real cause.
  await assertServerIsOurs(page);
  await expect
    .poll(async () => (await page.locator('main').first().innerText()).trim().length, {
      message: `${name}: <main> never rendered - refusing to photograph a blank page`,
    })
    .toBeGreaterThan(MIN_RENDERED_TEXT);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
};

/** A profile part-way through the game, so the album and badges have content. */
const PLAYED_PROFILE = {
  version: 1,
  trainerName: 'Leo',
  starterId: 'cindik',
  xp: 900,
  caught: ['cindik', 'blazur', 'sproutle', 'bublet', 'zaplet', 'pebblo', 'flurro', 'splashen'],
  badges: ['first-win', 'combo-5', 'collector-6', 'ten-wins', 'tier-5', 'evolved'],
  battlesWon: 14,
  battlesLost: 3,
  problemsCorrect: 121,
  problemsTotal: 140,
  bestCombo: 9,
  tier: 6,
  recentAttempts: [],
  skillStats: {
    add1: { attempts: 30, correct: 29, totalMs: 54_000 },
    sub1: { attempts: 24, correct: 21, totalMs: 62_000 },
    add2: { attempts: 22, correct: 19, totalMs: 79_000 },
    missingAdd: { attempts: 18, correct: 14, totalMs: 91_000 },
    mul1: { attempts: 28, correct: 24, totalMs: 104_000 },
    div1: { attempts: 18, correct: 14, totalMs: 118_000 },
  },
  streak: { current: 4, best: 6, lastPlayed: '2026-08-11' },
  settings: { language: 'en', sound: true },
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
};

/**
 * Seeds the played profile before the first paint.
 *
 * The init script re-runs on *every* navigation, which is what makes the seed
 * reliable - and is also a trap. An earlier version of the Chinese screenshot
 * clicked the language toggle on /settings and then navigated to /, and this
 * script quietly put the English profile back on the way. The capture succeeded,
 * nothing failed, and `12-chinese.png` was a byte-identical copy of
 * `02-dashboard.png` - the README showed an English screen captioned "Chinese
 * interface" until `scripts/audit_screenshots.py` (P5 distinct) caught it.
 *
 * So: anything the profile decides is seeded here, never toggled in the UI and
 * then navigated away from.
 */
async function seedProfile(page: Page, overrides: Record<string, unknown> = {}) {
  const profile = { ...PLAYED_PROFILE, ...overrides };
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [STORAGE_KEY, JSON.stringify(profile)] as const,
  );
}

/** The same profile, playing in Chinese. */
const inChinese = { settings: { language: 'zh', sound: true } };

/**
 * Plays a battle badly on purpose, answering every question wrong, until it is
 * over. A wrong answer deals flat chip damage while the opponent hits normally,
 * so this always ends in a defeat - which is the point: losing still awards XP,
 * and that screen had no picture of it.
 */
async function loseBattle(page: Page, maxSteps = 200): Promise<void> {
  const visible = (testId: string) =>
    page
      .getByTestId(testId)
      .isVisible()
      .catch(() => false);

  for (let step = 0; step < maxSteps; step++) {
    if (await visible('battle-result')) return;

    if (await visible('problem')) {
      const prompt = await page.getByTestId('problem').innerText();
      // One keypress, deliberately wrong, and still the non-negative integer
      // the keypad is the only way to enter.
      await page
        .getByRole('button', { name: solve(prompt) === 1 ? '2' : '1', exact: true })
        .click();
      await page.getByTestId('submit-answer').click();
      continue;
    }
    if (await visible('continue-turn')) {
      await page.getByTestId('continue-turn').click();
      continue;
    }
    if (await visible('move-strong')) {
      await page.getByTestId('move-strong').click();
      continue;
    }
    await page.waitForTimeout(100);
  }

  await expect(page.getByTestId('battle-result')).toBeVisible({ timeout: 15_000 });
}

test.describe('screenshots', () => {
  // Screenshots are captured once, at the desktop viewport used in the README.
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'captured on desktop only');
  });

  test('onboarding', async ({ page }) => {
    await page.goto('/start');
    await page.getByPlaceholder(/type your name/i).fill('Leo');
    await page.waitForTimeout(300);
    // The first thing a new player ever sees. It had no picture.
    await shot(page, '17-start-name');

    await page.getByRole('button', { name: /next/i }).click();
    await page.getByTestId('starter-cindik').click();
    await page.waitForTimeout(400);
    await shot(page, '01-choose-partner');
  });

  test('dashboard', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/');
    await page.waitForTimeout(500);
    await shot(page, '02-dashboard');
  });

  test('opponent select with type chart', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/play');
    await page.waitForTimeout(400);
    await shot(page, '03-choose-opponent');

    await page.getByRole('button', { name: /type chart/i }).click();
    await page.waitForTimeout(300);
    await shot(page, '04-type-chart');
  });

  test('battle: move select, solving, and victory', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/play');
    await page.locator('[data-testid^="opponent-"]').first().click();
    await page.waitForTimeout(400);
    await shot(page, '05-battle-choose-move');

    await page.getByTestId('move-strong').click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '7', exact: true }).click();
    await shot(page, '06-battle-solving');

    await page.getByRole('button', { name: 'Clear' }).click();
    await answerCurrentProblem(page);
    await page.waitForTimeout(400);
    await shot(page, '07-battle-hit');

    await playBattleToEnd(page);
    await page.waitForTimeout(600);
    await shot(page, '08-victory');
  });

  test('album', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/album');
    await page.waitForTimeout(500);
    await shot(page, '09-album');

    // Tapping a caught creature opens its card - element, stats and flavour.
    await page.getByTestId('album-blazur').click();
    await page.waitForTimeout(400);
    await shot(page, '18-album-detail');
  });

  test('progress and badges', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/progress');
    await page.waitForTimeout(500);
    await shot(page, '10-progress');
  });

  test('settings', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/settings');
    await page.waitForTimeout(300);
    await shot(page, '11-settings');
  });

  /**
   * The player this game was built for is bilingual, so Chinese is not a
   * footnote screen: the dashboard, a battle mid-question and the album all
   * get captured in it. Every string on these three is a `zh` entry in
   * src/lib/i18n.ts, which is exactly what makes them worth photographing -
   * a missing translation is invisible in the type system and obvious here.
   */
  test('Chinese interface', async ({ page }) => {
    await seedProfile(page, inChinese);

    await page.goto('/');
    await page.waitForTimeout(500);
    await shot(page, '12-chinese');

    await page.goto('/play');
    await page.locator('[data-testid^="opponent-"]').first().click();
    await page.getByTestId('move-strong').click();
    await expect(page.getByTestId('problem')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, '20-chinese-battle');

    await page.goto('/album');
    await page.waitForTimeout(500);
    await shot(page, '21-chinese-album');
  });

  /**
   * Losing still awards XP, which is a deliberate rule for a seven-year-old and
   * had no picture of it. Captured by playing badly on purpose.
   */
  test('defeat', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/play');
    await page.locator('[data-testid^="opponent-"]').first().click();
    await loseBattle(page);
    await expect(page.getByTestId('battle-result')).toContainText('You fainted');
    await page.waitForTimeout(400);
    await shot(page, '19-defeat');
  });

  // Best captured against a server that has a database, so the shot shows the
  // real form rather than the "accounts are not enabled" notice.
  test('sign in', async ({ page }) => {
    await seedProfile(page);
    await page.goto('/login');
    await page.waitForTimeout(400);
    await shot(page, '13-sign-in');
  });

  test('mobile battle', async ({ browser }) => {
    // Captured explicitly at phone size to show the responsive layout.
    const context = await browser.newContext({
      viewport: { width: 400, height: 860 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await seedProfile(page);
    await page.goto('/play');
    await page.locator('[data-testid^="opponent-"]').first().click();
    await page.getByTestId('move-strong').click();
    await page.waitForTimeout(400);
    await shot(page, '14-mobile-battle');

    await page.goto('/');
    await page.waitForTimeout(500);
    await shot(page, '15-mobile-dashboard');
    await context.close();
  });
});

test.describe('screenshot fixtures', () => {
  // Screenshots are captured once, at the desktop viewport used in the README.
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'captured on desktop only');
  });

  test('a fresh trainer still renders the empty states', async ({ page }) => {
    await createTrainer(page, 'Leo', 'zaplet');
    await page.goto('/progress');
    await page.waitForTimeout(400);
    await shot(page, '16-progress-empty');
  });
});
