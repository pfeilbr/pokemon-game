// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hashPin, isValidName, isValidPin, nameKey, verifyPin } from './accounts';

/**
 * Covers the pure parts of the account layer, including the shape and cost of
 * a stored PIN hash. The lockout and name-enumeration properties need a real
 * database and live in db.integration.test.ts, which owns the trainers table.
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

describe('stored hash shape', () => {
  // A bare digest is the failure mode this guards: sha256 of a 4-digit PIN is
  // 32 bytes and unsalted, so a rainbow table of all 10,000 PINs cracks the
  // whole table at once. scrypt with a 16-byte salt and a 64-byte key is what
  // CLAUDE.md promises, and the shape is the cheap part of that to assert.
  it('is a 16-byte salt and a 64-byte derived key, not a bare digest', async () => {
    const parts = (await hashPin('1234')).split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[1]).toMatch(/^[0-9a-f]{128}$/);
  });

  it('gives two accounts with the same PIN different salts and different keys', async () => {
    const [saltA, keyA] = (await hashPin('1234')).split(':');
    const [saltB, keyB] = (await hashPin('1234')).split(':');
    expect(saltA).not.toBe(saltB);
    expect(keyA).not.toBe(keyB);
  });

  it('is slow enough to be a KDF rather than a hash', async () => {
    // Not a precise cost assertion - just enough to catch scrypt being swapped
    // for something instant. A bare sha256 lands around 0.01ms; scrypt at
    // node's defaults is tens of ms. The floor is far below either boundary.
    const started = performance.now();
    await hashPin('1234');
    expect(performance.now() - started).toBeGreaterThan(1);
  });
});
