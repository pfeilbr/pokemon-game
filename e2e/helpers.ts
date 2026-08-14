import { type Page, expect } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * `solve` re-implements the arithmetic independently of the game, so the tests
 * genuinely play: they read the question off the screen, work out the answer,
 * and tap it in on the keypad exactly as a player would.
 */

export function solve(prompt: string): number {
  const text = prompt.trim();

  // Chess prompts print each piece's value beside it (`♜5 + ♟1`), which is what
  // makes them answerable without knowing chess - so the solver adds up exactly
  // what is on the screen, the way a player reads it, and never consults a table
  // of what a piece is worth.
  if (/[♔-♟]/.test(text)) {
    const squad = (side: string): number =>
      side.split(' + ').reduce((total, term) => {
        const piece = term.match(/^[♟♞♝♜♛](\d+)$/);
        if (!piece) throw new Error(`E2E solver cannot read the chess term: "${term}"`);
        return total + Number(piece[1]);
      }, 0);

    const lead = text.match(/^\((.+)\) − \((.+)\)$/);
    if (lead) return squad(lead[1] ?? '') - squad(lead[2] ?? '');

    const swap = text.match(/^(.+) \+ \? = (.+)$/);
    if (swap) return squad(swap[2] ?? '') - squad(swap[1] ?? '');

    return squad(text);
  }

  const fraction = text.match(/^([½⅓¼]) of (\d+)$/);
  if (fraction) {
    const denominator = { '½': 2, '⅓': 3, '¼': 4 }[fraction[1]!]!;
    return Number(fraction[2]) / denominator;
  }

  const twoStep = text.match(/^\((\d+) × (\d+)\) \+ (\d+)$/);
  if (twoStep) return Number(twoStep[1]) * Number(twoStep[2]) + Number(twoStep[3]);

  const missing = text.match(/^(\d+) ([+×]) \? = (\d+)$/);
  if (missing) {
    const [, a, op, total] = missing;
    return op === '+' ? Number(total) - Number(a) : Number(total) / Number(a);
  }

  const binary = text.match(/^(\d+) ([+−×÷]) (\d+)$/);
  if (binary) {
    const [, a, op, b] = binary;
    const x = Number(a);
    const y = Number(b);
    if (op === '+') return x + y;
    if (op === '−') return x - y;
    if (op === '×') return x * y;
    return x / y;
  }

  throw new Error(`E2E solver cannot parse the prompt: "${text}"`);
}

/** Types a number on the on-screen keypad and submits it. */
export async function answerWith(page: Page, value: number): Promise<void> {
  for (const digit of String(value)) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByTestId('submit-answer').click();
}

/** Reads the current question and answers it correctly. */
export async function answerCurrentProblem(page: Page): Promise<void> {
  const prompt = await page.getByTestId('problem').innerText();
  await answerWith(page, solve(prompt));
}

/** Completes onboarding and lands on the dashboard. */
export async function createTrainer(page: Page, name = 'Leo', starter = 'cindik'): Promise<void> {
  await page.goto('/start');
  await page.getByPlaceholder(/type your name/i).fill(name);
  await page.getByRole('button', { name: /next/i }).click();
  await page.getByTestId(`starter-${starter}`).click();
  await page.getByTestId('begin-adventure').click();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
}

/**
 * Plays a battle to its conclusion, answering everything correctly.
 *
 * The budget counts individual interactions, not turns: a single turn is a
 * move tap, an answer and a continue. It also taps through the hit animation
 * rather than waiting it out, which keeps a full battle to a few seconds.
 */
export async function playBattleToEnd(page: Page, maxSteps = 300): Promise<void> {
  const visible = (testId: string) =>
    page
      .getByTestId(testId)
      .isVisible()
      .catch(() => false);

  for (let step = 0; step < maxSteps; step++) {
    if (await visible('battle-result')) return;

    if (await visible('problem')) {
      await answerCurrentProblem(page);
      continue;
    }
    if (await visible('continue-turn')) {
      await page.getByTestId('continue-turn').click();
      continue;
    }

    // Play well, not just correctly: unload the special the moment it is
    // charged. In the worst matchups on the wheel it is the difference between
    // winning and losing, so a helper that only ever taps "strong" would be
    // testing bad play rather than good.
    const special = page.getByTestId('move-special');
    if ((await special.isVisible().catch(() => false)) && (await special.isEnabled())) {
      await special.click();
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
