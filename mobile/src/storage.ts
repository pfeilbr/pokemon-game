import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Profile, normaliseProfile } from './engine';

/**
 * Device persistence.
 *
 * The iOS client is offline-first for the same reason the web client is: a
 * child should be able to open the app on a plane and play. AsyncStorage is the
 * local equivalent of the web's localStorage, and the key deliberately matches
 * so the two clients describe the same save even though they cannot share one.
 *
 * Every read runs through `normaliseProfile`, which repairs anything it is
 * given rather than throwing. Save data outlives code.
 */

export const STORAGE_KEY = 'mathmon.profile.v1';

/**
 * The screen `mobile/scripts/capture_screens.sh` wants photographed.
 *
 * This exists because `simctl` can install, launch and screenshot but cannot
 * tap. The first attempt used a `mathmon://screen/<name>` deep link, and the
 * runner proved that cannot work: iOS puts up an "Open in Mathmon?"
 * confirmation for a custom-scheme open and waits for a tap that never comes,
 * whether or not the app is already running. Two CI runs photographed that
 * dialog - once over the dashboard, once over the home screen.
 *
 * A key the app only ever READS is the smaller hook of the two. A URL handler
 * is reachable by any app or web page on the device; this is reachable only by
 * something that already has this app's container, at which point it could
 * rewrite the save regardless. In production the key is never written, so the
 * read returns null and nothing happens.
 *
 * It carries a screen name, and for the battle screen an opponent id that
 * `screenFromName` checks against the real roster. Never state, never a profile.
 */
export const SCREEN_KEY = 'mathmon.capture.screen';

/** The requested screen name, or null. Never throws; a bad value is no value. */
export async function readCaptureScreen(
  store: ProfileStore = AsyncStorage,
): Promise<string | null> {
  try {
    const raw = await store.getItem(SCREEN_KEY);
    return typeof raw === 'string' && /^[a-z]+(:[a-z-]+)?$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The storage surface this module needs. Injectable so tests need no native module. */
export type ProfileStore = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export async function loadProfile(store: ProfileStore = AsyncStorage): Promise<Profile | null> {
  try {
    const raw = await store.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normaliseProfile(JSON.parse(raw));
  } catch {
    // Corrupt JSON means "no save", never a crash on launch.
    return null;
  }
}

export async function saveProfile(
  profile: Profile,
  store: ProfileStore = AsyncStorage,
): Promise<void> {
  try {
    await store.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // A failed write must not interrupt a battle in progress. The in-memory
    // profile is still correct for this session.
  }
}

export async function clearProfile(store: ProfileStore = AsyncStorage): Promise<void> {
  try {
    await store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do; the next save overwrites it anyway.
  }
}
