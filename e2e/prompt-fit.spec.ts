import { expect, test } from '@playwright/test';
import { promptWidthEm } from '../src/lib/game/prompt';
import { STORAGE_KEY } from '../src/lib/storage/client';

/**
 * The maths problem must never wrap or overflow.
 *
 * A prompt that breaks across two lines is not a cosmetic problem for this
 * player. `(♛9 + ♜5) −` on one line and `(♝3 + ♟1)` on the next is a different
 * question from the one the engine asked, and the speed meter under it is
 * draining while he works out what he is looking at. Overflow is worse: the
 * prompt is simply cut off.
 *
 * The chess strand made this reachable. Its longest prompt is 21 characters
 * against a previous longest of 12, and four of those characters are chess
 * glyphs, which are close to twice the advance of a digit.
 *
 * `scripts/audit_prompt_fit.py` enumerates every prompt the generator can
 * produce and checks the declared sizes against a width model. This spec is the
 * other half: it puts the real longest prompt in a real browser at the narrowest
 * supported viewport and measures what actually painted.
 */

/**
 * A profile whose very next fight asks the longest prompt in the game.
 *
 * The battle seed is `${trainerName}:${battlesWon + battlesLost}:${opponentId}`
 * and the first question comes from `${seed}:1:problem` at `tier + 1` for the
 * strong move, so this is fully determined: Ada, no battles yet, tier 9,
 * fighting Rimeserp, opening with the strong move.
 */
const TRAINER = 'Ada';
const OPPONENT = 'rimeserp';
const LONGEST_PROMPT = '(♛9 + ♜5) − (♝3 + ♟1)';

const PROFILE = {
  version: 1,
  trainerName: TRAINER,
  starterId: 'cindik',
  xp: 900,
  caught: ['cindik'],
  badges: [],
  battlesWon: 0,
  battlesLost: 0,
  problemsCorrect: 0,
  problemsTotal: 0,
  bestCombo: 0,
  tier: 9,
  recentAttempts: [],
  skillStats: {},
  streak: { current: 1, best: 1, lastPlayed: '2026-08-11' },
  settings: { language: 'en', sound: false },
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
};

/**
 * The narrowest phone this game is expected to survive.
 *
 * The `mobile` project is a Pixel 7 at 412 CSS px, which is a comfortable
 * modern phone. 320 is an iPhone SE (1st generation) in portrait and is the
 * floor the layout is built for, so the fit is proven at both rather than only
 * at the roomier one.
 */
const VIEWPORTS = [
  { name: 'Pixel 7 (412px)', width: 412, height: 915 },
  { name: 'iPhone SE (320px)', width: 320, height: 568 },
  // Above Tailwind's `lg` the battle splits into two columns and the prompt
  // gets a *narrower* box than the shell, at the largest type size in the
  // scale. It is the one case where a wider screen is the harder one.
  { name: 'a laptop (1280px, two columns)', width: 1280, height: 800 },
];

/** Reads how the prompt actually painted, from the browser's own line boxes. */
async function measurePrompt(page: import('@playwright/test').Page) {
  return page.getByTestId('problem').evaluate((element) => {
    // One line box per rendered line. Taken over a Range across the text
    // itself rather than off the element, because the element is a block and
    // would report a single box however many lines it wrapped onto.
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = range.getClientRects().length;

    const text = range.getBoundingClientRect();
    // The line box is the *card's* content width, not the element's own. The
    // card centres its children, so the prompt is shrink-to-fit and its own
    // rect is the width of the text - which would make "does the text fit in
    // the box" trivially true and prove nothing. `clientWidth` excludes the
    // card's borders, which is exactly the room the text has.
    const card = element.parentElement;
    if (card === null) throw new Error('the prompt has no card around it');
    const style = getComputedStyle(element);

    return {
      lines,
      textWidth: text.width,
      boxWidth: card.clientWidth,
      fontSize: parseFloat(style.fontSize),
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      content: element.textContent ?? '',
    };
  });
}

test.describe('the maths prompt fits on one line', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [STORAGE_KEY, JSON.stringify(PROFILE)] as const,
    );
  });

  for (const viewport of VIEWPORTS) {
    test(`the longest chess prompt neither wraps nor overflows on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await page.goto('/play');
      await page.getByTestId(`opponent-${OPPONENT}`).click();
      await page.getByTestId('move-strong').click();

      const problem = page.getByTestId('problem');
      await expect(problem).toBeVisible();
      // If this fails the seed has drifted and the rest of the test is measuring
      // some other, shorter question - which would pass while proving nothing.
      await expect(problem).toHaveText(LONGEST_PROMPT);

      const measured = await measurePrompt(page);

      expect(
        measured.lines,
        `"${measured.content}" painted on ${measured.lines} lines at ${measured.fontSize}px`,
      ).toBe(1);

      expect(
        measured.textWidth,
        `"${measured.content}" is ${measured.textWidth.toFixed(1)}px wide in a ` +
          `${measured.boxWidth.toFixed(1)}px box at ${measured.fontSize}px`,
      ).toBeLessThanOrEqual(measured.boxWidth + 0.5);

      // Nothing may push the page sideways either: an overflowing prompt that
      // widens the document is not clipped, it is simply off screen.
      expect(measured.documentScrollWidth).toBeLessThanOrEqual(measured.viewportWidth);

      /**
       * The size the client chose must be no larger than the line box it really
       * got can afford, under the same width model the audit script uses.
       *
       * This is the assertion that keeps `PROMPT_TYPE`'s layout numbers honest.
       * The component works its line box out from declared constants - the
       * shell's `max-w-5xl`, `<main>`'s `px-4`, the card's borders, the `lg`
       * two-column split - and every one of those restates something the markup
       * says elsewhere. If a padding changes and the constants do not, the size
       * comes out too big for the real box and this fires, rather than a child
       * finding out.
       */
      const affordable = measured.boxWidth / promptWidthEm(LONGEST_PROMPT);
      expect(
        measured.fontSize,
        `sized to ${measured.fontSize}px, but a ${measured.boxWidth.toFixed(1)}px box ` +
          `affords only ${affordable.toFixed(1)}px - the layout numbers declared in ` +
          'PROMPT_TYPE have drifted from the real layout',
      ).toBeLessThanOrEqual(affordable + 0.01);

      // Shrinking to fit is worthless if the result is too small to read.
      // `LEGIBLE_MIN` in scripts/audit_prompt_fit.py is the same bar.
      expect(
        measured.fontSize,
        `shrunk to ${measured.fontSize}px, which is too small for a seven-year-old`,
      ).toBeGreaterThanOrEqual(18);
    });
  }
});
