import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { transformSync } from '@babel/core';

/**
 * Metro's transformer, for the two places a test can reach React Native.
 *
 * `react-native` ships untranspiled Flow source. Metro compiles it on the way
 * into the bundle; off the device nothing does, and neither esbuild (Vite) nor
 * Node can parse it. The Vite plugin in `vitest.config.ts` and the `require`
 * hook in `setup.ts` both hand their files here, so the render tests compile
 * React Native with the same Babel preset the shipped iOS bundle uses.
 */

const require = createRequire(import.meta.url);

/**
 * The preset and its options are resolved once and reused by reference.
 *
 * Both details matter. Babel caches a preset's evaluation against the identity
 * of its options object, so a fresh object literal per call would re-run the
 * whole preset for every file; and resolving a preset by name from inside
 * Node's module loader is a re-entrant require, which Babel probes with a
 * `.then` access that Node then reports as a circular-dependency warning.
 */
const PRESETS: [unknown, object][] = [[require('babel-preset-expo'), { jsxRuntime: 'automatic' }]];

/** What Metro passes; the preset reads the platform off it. */
const CALLER = { name: 'vitest', platform: 'ios', isDev: true };

/** Packages published as source rather than as compiled JavaScript. */
const SOURCE = /[\\/]node_modules[\\/](react-native|@react-native)[\\/]/;

/**
 * React's own renderer, shipped pre-built and free of Flow. It is by far the
 * largest file in the tree and needs nothing done to it, so skipping it is most
 * of the difference between a fast suite and a slow one.
 */
const PREBUILT = /Renderer[\\/]implementations[\\/]/;

export function isReactNativeSource(id: string): boolean {
  return SOURCE.test(id) && !PREBUILT.test(id) && /\.[cm]?js$/.test(id);
}

/**
 * Compiled output is cached on disk, because every test file pays this cost
 * again: Vitest isolates each file in its own module registry, so React Native
 * is compiled from scratch per file otherwise. The key is the file's contents,
 * so an upgrade or a patch invalidates it without anyone remembering to.
 */
const cacheDir = join(
  dirname(dirname(require.resolve('react-native/package.json'))),
  '.cache',
  'mathmon-react-native',
);

export function compileReactNativeSource(code: string, filename: string): string {
  const key = createHash('sha1').update(filename).update('\0').update(code).digest('hex');
  const cached = join(cacheDir, `${key}.js`);
  if (existsSync(cached)) return readFileSync(cached, 'utf8');

  const result =
    transformSync(code, {
      filename,
      babelrc: false,
      configFile: false,
      sourceMaps: 'inline',
      caller: CALLER,
      presets: PRESETS,
    })?.code ?? code;

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, result);
  return result;
}
