import { expect, test } from '@playwright/test';
import { answerCurrentProblem, createTrainer, playBattleToEnd, solve } from './helpers';

test.describe('onboarding', () => {
  test('a new player can name themselves, pick a partner and reach the dashboard', async ({
    page,
  }) => {
    await page.goto('/');
    // No save yet, so the app should route into sign-up on its own.
    await expect(page).toHaveURL(/\/start/);

    await page.getByPlaceholder(/type your name/i).fill('Leo');
    await page.getByRole('button', { name: /next/i }).click();

    await page.getByTestId('starter-cindik').click();
    await page.getByTestId('begin-adventure').click();

    await expect(page).toHaveURL(/\/$|\/#/);
    await expect(page.getByText('Leo')).toBeVisible();
    await expect(page.getByText('Cindik')).toBeVisible();
  });

  test('refuses a name that is too short', async ({ page }) => {
    await page.goto('/start');
    await page.getByPlaceholder(/type your name/i).fill('A');
    await page.getByRole('button', { name: /next/i }).click();
    await expect(page.getByText(/at least 2 letters/i)).toBeVisible();
  });

  test('remembers the player across a reload without any account', async ({ page }) => {
    await createTrainer(page, 'Mia', 'bublet');
    await page.reload();
    await expect(page.getByText('Mia')).toBeVisible();
    await expect(page.getByText('Bublet')).toBeVisible();
  });
});

test.describe('battle', () => {
  test.beforeEach(async ({ page }) => {
    await createTrainer(page);
  });

  test('shows the matchup for each opponent before committing', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await expect(page.getByRole('heading', { name: /choose your opponent/i })).toBeVisible();

    // Every candidate is labelled with how the exchange will go.
    const verdicts = page.getByText(/Good matchup|Tough matchup|Even matchup/);
    expect(await verdicts.count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: /type chart/i }).click();
    await expect(page.getByText(/Strong against/).first()).toBeVisible();
  });

  test('a correct answer damages the opponent', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();

    await expect(page.getByTestId('battle')).toBeVisible();
    await page.getByTestId('move-strong').click();

    await expect(page.getByTestId('problem')).toBeVisible();
    await answerCurrentProblem(page);

    await expect(page.getByText(/Correct!|Critical hit!/)).toBeVisible();
  });

  test('a wrong answer is corrected rather than just rejected', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await page.getByTestId('move-strong').click();

    const prompt = await page.getByTestId('problem').innerText();
    const wrong = solve(prompt) + 1;
    for (const digit of String(wrong)) {
      await page.getByRole('button', { name: digit, exact: true }).click();
    }
    await page.getByTestId('submit-answer').click();

    await expect(page.getByText(/Not quite/)).toBeVisible();
    await expect(page.getByText(/The answer was/)).toBeVisible();
  });

  test('the keypad builds and clears an answer', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await page.getByTestId('move-quick').click();

    const display = page.getByTestId('answer-display');
    await expect(display).toHaveText('?');

    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(display).toHaveText('42');

    await page.getByRole('button', { name: 'Backspace' }).click();
    await expect(display).toHaveText('4');

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(display).toHaveText('?');
  });

  test('playing well wins the battle and awards XP', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();

    await playBattleToEnd(page);

    await expect(page.getByTestId('battle-result')).toBeVisible();
    await expect(page.getByText(/You win!/)).toBeVisible();
    await expect(page.getByText(/XP EARNED/i)).toBeVisible();
  });

  test('a won battle updates the dashboard and album', async ({ page }) => {
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await playBattleToEnd(page);

    await page.getByRole('button', { name: /^home$/i }).click();
    await expect(page).toHaveURL(/\/$/);

    // First win always earns this badge.
    await page.getByTestId('tile-progress').click();
    await expect(page.getByTestId('badge-first-win')).toContainText(/First Victory/);
  });
});

test.describe('album', () => {
  test('shows every creature, with un-caught ones hidden', async ({ page }) => {
    await createTrainer(page, 'Leo', 'cindik');
    await page.getByTestId('tile-album').click();

    // The starter is owned from the beginning.
    await expect(page.getByTestId('album-cindik')).toContainText('Cindik');
    // Its final evolution is not.
    await expect(page.getByTestId('album-pyrolith')).toContainText('???');

    await page.getByTestId('album-cindik').click();
    await expect(page.getByText(/pocket-sized spark/i)).toBeVisible();
  });
});

test.describe('progress', () => {
  test('starts with no badges earned and no maths data', async ({ page }) => {
    await createTrainer(page);
    await page.getByTestId('tile-progress').click();

    await expect(page.getByRole('heading', { name: /your progress/i })).toBeVisible();
    await expect(page.getByTestId('badge-first-win')).toContainText(/Locked/);
    await expect(page.getByText(/Play a battle to see your stats/i)).toBeVisible();
  });

  test('records maths stats per skill after a battle', async ({ page }) => {
    await createTrainer(page);
    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await playBattleToEnd(page);

    await page.getByRole('button', { name: /^home$/i }).click();
    await page.getByTestId('tile-progress').click();

    await expect(page.locator('[data-testid^="skill-"]').first()).toBeVisible();
  });
});

test.describe('settings', () => {
  test('switches the whole interface to Chinese and back', async ({ page }) => {
    await createTrainer(page);
    await page.goto('/settings');

    await page.getByTestId('lang-zh').click();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

    await page.goto('/');
    await expect(page.getByText('小火星')).toBeVisible();

    await page.goto('/settings');
    await page.getByTestId('lang-en').click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('toggles sound off and remembers it', async ({ page }) => {
    await createTrainer(page);
    await page.goto('/settings');

    const toggle = page.getByTestId('toggle-sound');
    await expect(toggle).toHaveText('On');
    await toggle.click();
    await expect(toggle).toHaveText('Off');

    await page.reload();
    await expect(page.getByTestId('toggle-sound')).toHaveText('Off');
  });

  test('starting over clears the save and returns to sign-up', async ({ page }) => {
    await createTrainer(page);
    await page.goto('/settings');

    await page.getByRole('button', { name: /start over/i }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();

    await expect(page).toHaveURL(/\/start/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/start/);
  });
});

test.describe('playing without an account', () => {
  // True of every deployment: a player who has not signed in keeps their
  // progress on the device and can play the whole game.
  test('reports local-only saving and still plays', async ({ page }) => {
    await createTrainer(page);
    const status = page.getByTestId('sync-status');
    // Desktop only; the mobile layout hides the indicator for space.
    if (await status.isVisible().catch(() => false)) {
      await expect(status).toContainText(/this device/i);
    }
    await expect(page.getByText('Leo')).toBeVisible();
  });
});

test.describe('deployment without a database', () => {
  // Only meaningful against a server that genuinely has no database - which is
  // the zero-config Vercel import. CI runs the suite in both shapes.
  test.beforeEach(async ({ page }) => {
    const session = (await (await page.request.get('/api/session')).json()) as {
      accountsAvailable: boolean;
    };
    test.skip(session.accountsAvailable, 'this deployment has a database attached');
  });

  test('the login page explains that accounts are off rather than erroring', async ({ page }) => {
    await createTrainer(page);
    await page.goto('/login');
    await expect(page.getByText(/Accounts are not enabled/i)).toBeVisible();
  });
});
