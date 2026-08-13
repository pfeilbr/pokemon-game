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
