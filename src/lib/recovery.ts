import type { Language } from './game/progress';

/**
 * The rules of the crash-recovery screen, as pure functions.
 *
 * The screen itself is React, but *what it offers* is a decision with two
 * load-bearing properties, and a decision that matters is a decision that
 * belongs somewhere a test can reach without a browser:
 *
 *   - the safe ways out are never withheld, and
 *   - the destructive one is never automatic and never the first thing a
 *     panicking child's finger lands on.
 *
 * `normaliseProfile` already promises that save data outlives code. A recovery
 * screen that "helpfully" cleared localStorage to get the app rendering again
 * would break that promise from the other end: the child would be back in the
 * game, and his album would be gone, and nothing on screen would ever have said
 * so. Losing the album is worse than the crash.
 */

/**
 * How many times "try again" must fail before the destructive option is even
 * shown. One is enough: the safe route has demonstrably not worked, which is
 * the only situation where erasing a save is a sane suggestion.
 */
export const RETRIES_BEFORE_ERASE = 1;

export type RecoveryPlan = {
  /** Re-render the crashed subtree. Always offered - most crashes are transient. */
  canRetry: boolean;
  /** Always offered: a crash must never be able to strand the player. */
  canGoHome: boolean;
  /** Whether the *offer* to erase is visible. Never the erase itself. */
  offerErase: boolean;
};

/**
 * What the error screen offers after `failedRetries` unsuccessful retries.
 *
 * Deliberately total: the counter arrives from component state or sessionStorage
 * and can therefore be `NaN` or nonsense after a tab restore. Every input still
 * has to leave the two safe exits open, because the one thing this screen may
 * never do is show a child a dead end.
 */
export function recoveryPlan(failedRetries: number): RecoveryPlan {
  const failures = Number.isFinite(failedRetries) ? Math.max(0, Math.floor(failedRetries)) : 0;
  return {
    canRetry: true,
    canGoHome: true,
    offerErase: failures >= RETRIES_BEFORE_ERASE,
  };
}

/**
 * The player's language, read from the raw saved profile.
 *
 * Pure on purpose, and separate from `loadLocal`: the error screen renders
 * precisely when something else has thrown, so it must not route its own text
 * through the engine that may be what broke. A profile it cannot parse is not
 * an error here - English is a fallback, not a claim about the player.
 */
export function languageFromSave(raw: string | null): Language {
  if (!raw) return 'en';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return 'en';
    const settings = (parsed as { settings?: unknown }).settings;
    if (typeof settings !== 'object' || settings === null) return 'en';
    const language = (settings as { language?: unknown }).language;
    return language === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}
