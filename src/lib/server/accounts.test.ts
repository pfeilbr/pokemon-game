import { describe, expect, it } from 'vitest';
import { hashPin, isValidName, isValidPin, nameKey, verifyPin } from './accounts';

/**
 * Covers the pure parts of the account layer. The database-backed functions are
 * exercised end-to-end by the E2E suite instead.
 */

describe('PIN hashing', () => {
  it('verifies a correct PIN', async () => {
    const hash = await hashPin('1234');
    expect(await verifyPin('1234', hash)).toBe(true);
  });

  it('rejects a wrong PIN', async () => {
    const hash = await hashPin('1234');
    expect(await verifyPin('1235', hash)).toBe(false);
    expect(await verifyPin('', hash)).toBe(false);
    expect(await verifyPin('12345', hash)).toBe(false);
  });

  it('salts each hash, so identical PINs do not collide in the database', async () => {
    const a = await hashPin('1234');
    const b = await hashPin('1234');
    expect(a).not.toBe(b);
    expect(await verifyPin('1234', a)).toBe(true);
    expect(await verifyPin('1234', b)).toBe(true);
  });

  it('never stores the PIN in the clear', async () => {
    expect(await hashPin('1234')).not.toContain('1234');
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'nosalt:', ':nohash', 'a:b:c']) {
      await expect(verifyPin('1234', bad)).resolves.toBe(false);
    }
  });
});

describe('nameKey', () => {
  it('matches names case- and whitespace-insensitively', () => {
    expect(nameKey('Leo')).toBe(nameKey('leo'));
    expect(nameKey('  Leo  ')).toBe(nameKey('Leo'));
    expect(nameKey('Big  Leo')).toBe(nameKey('big leo'));
  });

  it('keeps genuinely different names apart', () => {
    expect(nameKey('Leo')).not.toBe(nameKey('Mia'));
  });

  it('handles non-Latin names', () => {
    expect(nameKey(' 小明 ')).toBe('小明');
  });
});

describe('validation', () => {
  it('accepts a four-digit PIN and nothing else', () => {
    expect(isValidPin('0000')).toBe(true);
    expect(isValidPin('9999')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
    expect(isValidPin(' 1234')).toBe(false);
  });

  it('accepts names between 2 and 16 characters', () => {
    expect(isValidName('Leo')).toBe(true);
    expect(isValidName('  Leo  ')).toBe(true);
    expect(isValidName('小明')).toBe(true);
    expect(isValidName('A')).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName('   ')).toBe(false);
    expect(isValidName('x'.repeat(17))).toBe(false);
  });
});
