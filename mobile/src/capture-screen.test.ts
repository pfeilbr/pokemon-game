import { describe, expect, it } from 'vitest';
import { screenFromName } from '../App';
import { readCaptureScreen } from './storage';

/**
 * The one hook `mobile/scripts/capture_screens.sh` needs, and its whole job is
 * to be boring: turn a name from a fixed list into a screen, or refuse.
 *
 * It replaced a `mathmon://screen/<name>` deep link, which the runner proved
 * cannot work - iOS confirms a custom-scheme open with a dialog and waits for a
 * tap `simctl` cannot perform, so two CI runs photographed "Open in Mathmon?"
 * rather than the game. This is also the smaller hook: a URL handler is
 * reachable by any app or web page, a storage key the app only reads is not.
 *
 * These tests are mostly about what it refuses.
 */
describe('screenFromName', () => {
  it('opens each screen the harness can ask for', () => {
    expect(screenFromName('home')).toEqual({ name: 'home' });
    expect(screenFromName('pick')).toEqual({ name: 'pick' });
    expect(screenFromName('album')).toEqual({ name: 'album' });
    expect(screenFromName('progress')).toEqual({ name: 'progress' });
    expect(screenFromName('settings')).toEqual({ name: 'settings' });
    expect(screenFromName('signin')).toEqual({ name: 'signin' });
  });

  it('needs a real opponent before it will start a battle', () => {
    // Without one the screen would pick a fight at random; with a made-up one
    // `getCreature` would throw and land the child on the crash screen. Both
    // are refused here instead.
    expect(screenFromName('battle')).toBeNull();
    expect(screenFromName('battle:no-such-creature')).toBeNull();
    expect(screenFromName('battle:vinari')).toEqual({ name: 'battle', opponentId: 'vinari' });
  });

  it('refuses anything not on the list', () => {
    expect(screenFromName('HOME')).toBeNull();
    expect(screenFromName('nonesuch')).toBeNull();
    expect(screenFromName('../../etc/passwd')).toBeNull();
    expect(screenFromName('')).toBeNull();
    expect(screenFromName(null)).toBeNull();
  });
});

describe('readCaptureScreen', () => {
  /** The smallest store that behaves like AsyncStorage for this one key. */
  const store = (value: string | null) => ({
    getItem: async () => value,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  });

  it('reads a plain screen name', async () => {
    expect(await readCaptureScreen(store('album'))).toBe('album');
  });

  it('is absent in production, which is the normal case', async () => {
    // Nothing in the app ever writes this key, so a real device returns null
    // and the app opens where it always did.
    expect(await readCaptureScreen(store(null))).toBeNull();
  });

  it('refuses a value that is not a bare name', async () => {
    // It carries a screen and nothing else - never JSON, never a profile.
    expect(await readCaptureScreen(store('{"xp":99999}'))).toBeNull();
    expect(await readCaptureScreen(store('album?opponent=vinari'))).toBeNull();
    expect(await readCaptureScreen(store('battle:vinari'))).toBe('battle:vinari');
    expect(await readCaptureScreen(store('album settings'))).toBeNull();
  });

  it('never throws, whatever storage does', async () => {
    const broken = {
      getItem: async () => {
        throw new Error('storage is unavailable');
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
    await expect(readCaptureScreen(broken)).resolves.toBeNull();
  });
});
