import { describe, expect, it } from 'vitest';
import { screenFromUrl } from '../App';

/**
 * The deep link exists so `mobile/scripts/capture_screens.sh` can walk the app
 * through its screens - `simctl` can open a URL but cannot tap.
 *
 * That is a hook in shipping code, so its whole job is to be boring: pick a
 * screen from a fixed list, or return null. It can carry no state, which is why
 * the harness seeds the save through the filesystem instead. A link that could
 * write the profile would be a hole in a child's album for the life of the app,
 * and it would exist to save a test script twenty lines.
 *
 * These tests are mostly about what it REFUSES.
 */
describe('screenFromUrl', () => {
  it('opens each screen the router knows', () => {
    expect(screenFromUrl('mathmon://screen/home')).toEqual({ name: 'home' });
    expect(screenFromUrl('mathmon://screen/pick')).toEqual({ name: 'pick' });
    expect(screenFromUrl('mathmon://screen/album')).toEqual({ name: 'album' });
    expect(screenFromUrl('mathmon://screen/progress')).toEqual({ name: 'progress' });
    expect(screenFromUrl('mathmon://screen/settings')).toEqual({ name: 'settings' });
    expect(screenFromUrl('mathmon://screen/signin')).toEqual({ name: 'signin' });
  });

  it('needs an opponent before it will start a battle', () => {
    // Without one the link goes nowhere rather than picking a fight at random.
    expect(screenFromUrl('mathmon://screen/battle')).toBeNull();
    expect(screenFromUrl('mathmon://screen/battle?opponent=vinari')).toEqual({
      name: 'battle',
      opponentId: 'vinari',
    });
  });

  it('refuses a host it does not own', () => {
    // The `screen` segment must sit directly after the scheme. A URL whose
    // authority is somebody else's domain is not this app's navigation.
    expect(screenFromUrl('https://evil.example.com/screen/album')).toBeNull();
    expect(screenFromUrl('mathmon://evil.example.com/screen/album')).toBeNull();
  });

  it('refuses anything that is not a screen name', () => {
    expect(screenFromUrl('mathmon://screen/../../etc/passwd')).toBeNull();
    expect(screenFromUrl('mathmon://screen/HOME')).toBeNull();
    expect(screenFromUrl('mathmon://screen/nonesuch')).toBeNull();
    expect(screenFromUrl('mathmon://screen/')).toBeNull();
    expect(screenFromUrl('mathmon://profile/set?xp=99999')).toBeNull();
  });

  it('cannot be made to carry state', () => {
    // The only parameter it reads is `opponent`, and only for a battle. Anything
    // that looks like an attempt to write the save is simply not a match.
    expect(screenFromUrl('mathmon://screen/home?xp=99999')).toBeNull();
    expect(screenFromUrl('mathmon://screen/album?caught=every-creature')).toBeNull();
    expect(screenFromUrl('mathmon://screen/battle?opponent=vinari&xp=99999')).toBeNull();
  });

  it('survives the values a platform really hands it', () => {
    expect(screenFromUrl(null)).toBeNull();
    expect(screenFromUrl('')).toBeNull();
    expect(screenFromUrl('not a url at all')).toBeNull();
  });
});
