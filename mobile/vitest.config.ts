import { defineConfig } from 'vitest/config';
import { compileReactNativeSource, isReactNativeSource } from './src/test/react-native-source';

/**
 * Vitest for a React Native app.
 *
 * The engine tests need nothing here - they are plain TypeScript. The render
 * tests need the real `react-native` module tree, which ships as Flow source
 * that esbuild cannot parse, so those files are compiled by Babel on the way in
 * (see `src/test/react-native-source.ts`).
 *
 * React Native is deliberately *inlined* rather than externalised. It is a
 * CommonJS tree, and left external Node's ESM loader would try to parse the
 * Flow entry point itself and fail; inlined, Vite hands it to this plugin and
 * the `require` graph underneath is picked up by the loader hook installed in
 * `src/test/setup.ts`.
 */
export default defineConfig({
  plugins: [
    {
      name: 'mathmon:react-native-source',
      enforce: 'pre',
      transform(code, id) {
        if (!isReactNativeSource(id)) return null;
        return { code: compileReactNativeSource(code, id), map: null };
      },
    },
  ],
  define: {
    __DEV__: 'true',
  },
  resolve: {
    // React Native publishes under its own export condition.
    conditions: ['react-native', 'require', 'default'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    server: {
      deps: {
        inline: [/node_modules[\\/](react-native|@react-native)[\\/]/],
      },
    },
  },
});
