import { describe, expect, it } from 'vitest';
import { RETRIES_BEFORE_ERASE, languageFromSave, recoveryPlan } from './recovery';

describe('recoveryPlan', () => {
  it('never withholds the safe ways out, whatever it is handed', () => {
    // The counter can arrive as NaN or garbage from a restored tab. A dead end
    // is the one outcome this screen may never produce.
    for (const failures of [0, 1, 2, 99, -1, -0, 0.5, NaN, Infinity, -Infinity]) {
      const plan = recoveryPlan(failures);
      expect(plan.canRetry, `retry at ${failures}`).toBe(true);
      expect(plan.canGoHome, `home at ${failures}`).toBe(true);
    }
  });

  it('does not offer to erase the save on the first crash', () => {
    expect(recoveryPlan(0).offerErase).toBe(false);
  });

  it('offers to erase only once "try again" has actually failed', () => {
    expect(recoveryPlan(RETRIES_BEFORE_ERASE - 1).offerErase).toBe(false);
    expect(recoveryPlan(RETRIES_BEFORE_ERASE).offerErase).toBe(true);
    expect(recoveryPlan(RETRIES_BEFORE_ERASE + 5).offerErase).toBe(true);
  });

  it('treats a nonsense counter as no failures rather than as many', () => {
    // Erring the other way would flash the destructive option at a child the
    // instant anything went wrong with the counter itself.
    expect(recoveryPlan(NaN).offerErase).toBe(false);
    expect(recoveryPlan(-3).offerErase).toBe(false);
  });
});

describe('languageFromSave', () => {
  it('reads the language the player chose', () => {
    expect(languageFromSave(JSON.stringify({ settings: { language: 'zh' } }))).toBe('zh');
    expect(languageFromSave(JSON.stringify({ settings: { language: 'en' } }))).toBe('en');
  });

  it('falls back to English rather than throwing on anything it is given', () => {
    // This runs *inside* the error screen. If it could throw, a crash would
    // become a crash loop with no UI at all - the exact white screen the
    // boundary exists to prevent.
    for (const raw of [
      null,
      '',
      '{not json',
      'null',
      '[]',
      '"a string"',
      '42',
      JSON.stringify({}),
      JSON.stringify({ settings: null }),
      JSON.stringify({ settings: 'zh' }),
      JSON.stringify({ settings: { language: 'klingon' } }),
      JSON.stringify({ settings: { language: 7 } }),
    ]) {
      expect(() => languageFromSave(raw)).not.toThrow();
      expect(languageFromSave(raw)).toBe('en');
    }
  });
});
