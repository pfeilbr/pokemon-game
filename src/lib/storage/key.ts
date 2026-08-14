/**
 * Where the profile lives, and nothing else.
 *
 * This is a leaf on purpose. `client.ts` re-exports it, so there is still one
 * definition of the key, but importing *the key* no longer pulls in
 * `progress.ts` - and through it the roster, the art specs and the maths
 * generators.
 *
 * That matters for exactly one caller. The crash-recovery screen is reached
 * from `app/error.tsx`, which Next bundles into every route, so anything it
 * imports is paid for on every cold visit by every player. Reading the key from
 * `client.ts` put the engine into the shared baseline and blew three budgets in
 * `scripts/audit_bundle.py` at once: +13.2 KiB gzipped on a screen the game
 * hopes never to show.
 */
export const STORAGE_KEY = 'mathmon.profile.v1';
