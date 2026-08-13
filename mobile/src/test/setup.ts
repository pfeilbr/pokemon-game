import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { compileReactNativeSource, isReactNativeSource } from './react-native-source';

/**
 * What Metro and the device provide, arranged for a test process.
 *
 * Rendering a screen off a phone needs four things that are normally supplied
 * by the platform, and each is set up here rather than stubbed away in every
 * test file:
 *
 * 1. **Metro's transformer.** React Native ships Flow source, which Node cannot
 *    parse, so `require` is taught to compile it (`react-native-source.ts`).
 * 2. **Metro's platform resolution.** `require('./Platform')` finds
 *    `Platform.ios.js` on the device; Node has no notion of a platform, so the
 *    resolver falls back to the iOS variant - the one this client ships.
 * 3. **The native binary.** Every host component ultimately asks the native
 *    view registry for a real view. React Native publishes the substitutes for
 *    those in `@react-native/jest-preset`, versioned in lockstep with itself,
 *    and this file wires that mock set in. Using the maintained mocks rather
 *    than hand-written ones is deliberate: they move when React Native does.
 * 4. **A few globals** the runtime defines before any app code runs.
 *
 * None of this reaches the app. Nothing in `src/` is mocked here - the screens,
 * the shared engine and this client's own widgets are all the real thing.
 */

const require = Module.createRequire(import.meta.url);

type Loader = { _resolveFilename(request: string, ...rest: unknown[]): string };
type CompiledModule = { _compile(code: string, filename: string): unknown };
type Extensions = Record<string, (module: CompiledModule, filename: string) => void>;

const loader = Module as unknown as Loader & { _extensions: Extensions };

/**
 * React Native modules that talk to the native binary, and the mock React
 * Native itself publishes for each. Same list as `@react-native/jest-preset`'s
 * own setup file; only the mechanism differs, because Vitest has no `jest.mock`.
 */
const NATIVE_MOCKS: Record<string, string> = {
  'Libraries/AppState/AppState': 'AppState',
  'Libraries/BatchedBridge/NativeModules': 'NativeModules',
  'Libraries/Components/AccessibilityInfo/AccessibilityInfo': 'AccessibilityInfo',
  'Libraries/Components/ActivityIndicator/ActivityIndicator': 'ActivityIndicator',
  'Libraries/Components/Clipboard/Clipboard': 'Clipboard',
  'Libraries/Components/RefreshControl/RefreshControl': 'RefreshControl',
  'Libraries/Components/ScrollView/ScrollView': 'ScrollView',
  'Libraries/Components/TextInput/TextInput': 'TextInput',
  'Libraries/Components/View/View': 'View',
  'Libraries/Components/View/ViewNativeComponent': 'ViewNativeComponent',
  'Libraries/Core/InitializeCore': 'InitializeCore',
  'Libraries/Image/Image': 'Image',
  'Libraries/Linking/Linking': 'Linking',
  'Libraries/Modal/Modal': 'Modal',
  'Libraries/NativeComponent/NativeComponentRegistry': 'NativeComponentRegistry',
  'Libraries/ReactNative/RendererProxy': 'RendererProxy',
  'Libraries/ReactNative/requireNativeComponent': 'requireNativeComponent',
  'Libraries/ReactNative/UIManager': 'UIManager',
  'Libraries/Text/Text': 'Text',
  'Libraries/Utilities/useColorScheme': 'useColorScheme',
  'Libraries/Vibration/Vibration': 'Vibration',
};

const mocksDir = join(dirname(require.resolve('@react-native/jest-preset/package.json')), 'jest');
const mockRequire = Module.createRequire(join(mocksDir, 'mocks', 'index.js'));

const mockFor = (filename: string): string | null => {
  for (const [module, mock] of Object.entries(NATIVE_MOCKS)) {
    if (filename.endsWith(join('node_modules', 'react-native', `${module}.js`))) {
      return join(mocksDir, 'mocks', `${mock}.js`);
    }
  }
  return null;
};

/**
 * `jest.requireActual` reaches past the mock to the module it stands in for -
 * the mocked components are built by subclassing their real implementations.
 * The bypass is armed for exactly one resolution so that the real module's own
 * dependencies still get their mocks, which is what Jest does too.
 */
let bypass: string | null = null;

const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request: string, ...rest: unknown[]): string {
  const parent = rest[0] as { filename?: string } | undefined;

  // Platform extensions, the way Metro resolves them: `./Platform` is
  // `Platform.ios.js` on this client. Node would otherwise pick `Platform.js`,
  // which is a compatibility shim that re-exports `./Platform` and so resolves
  // to itself, leaving `Platform.OS` undefined at the far end.
  if (request.startsWith('.') && parent?.filename && isReactNativeSource(parent.filename)) {
    const ios = join(dirname(parent.filename), `${request}.ios.js`);
    if (existsSync(ios)) return ios;
  }

  const resolved = resolveFilename.call(this, request, ...rest);

  if (bypass === request) {
    bypass = null;
    return resolved;
  }

  return mockFor(resolved) ?? resolved;
};

const compileJs = loader._extensions['.js'];
loader._extensions['.js'] = (module, filename) => {
  if (!isReactNativeSource(filename)) return compileJs?.(module, filename);
  module._compile(compileReactNativeSource(readFileSync(filename, 'utf8'), filename), filename);
};

Object.defineProperties(globalThis, {
  __DEV__: { configurable: true, value: true, writable: true },
  // React's `act` and React Native's own test guards read these.
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
  IS_REACT_NATIVE_TEST_ENVIRONMENT: { configurable: true, value: true, writable: true },
  window: { configurable: true, value: globalThis, writable: true },
  nativeFabricUIManager: { configurable: true, value: {}, writable: true },
  // Testing Library extends the global `expect` on import; point it at Vitest's
  // so its matchers (`toBeOnTheScreen`, `toHaveTextContent`) land there.
  expect: { configurable: true, value: expect, writable: true },
  // React Native's mocks are written against Jest's two primitives. Vitest's
  // equivalents are drop-in, so the mock set needs no fork.
  jest: {
    configurable: true,
    writable: true,
    value: {
      fn: vi.fn,
      requireActual: (request: string) => {
        bypass = request;
        try {
          return request.startsWith('.') ? mockRequire(request) : require(request);
        } finally {
          bypass = null;
        }
      },
    },
  },
});

/**
 * Finish React Native's circular core before any mock reaches into it.
 *
 * The mocked components subclass their real implementations through
 * `jest.requireActual`, and the real `ScrollView` pulls in `Dimensions`, which
 * reads `RCTDeviceEventEmitter.default` at module scope. Those modules import
 * each other, so whichever one is entered first hands the other a
 * half-initialised record - and which one that is depends on the order test
 * files happen to load in.
 *
 * That made the suite green on a developer machine and red on CI, with
 * `_RCTDeviceEventEmitter.default.addListener is not a function` thrown from
 * inside a mock's own construction. Loading the emitter here, before any mock
 * exists, means the cycle is always resolved the same way. It is ordering that
 * is being fixed, not a missing mock: the emitter is deliberately the real one.
 */
for (const core of [
  'react-native/Libraries/EventEmitter/RCTDeviceEventEmitter',
  'react-native/Libraries/Utilities/Dimensions',
]) {
  try {
    bypass = core;
    require(core);
  } catch {
    // A future React Native may move or drop these. The suite should fail on a
    // real assertion if that breaks something, not on a warm-up import.
  } finally {
    bypass = null;
  }
}

/**
 * The two platform APIs this client substitutes for a web one, stood in for
 * here rather than in every test file.
 *
 * Neither has an off-device implementation: the Taptic Engine is hardware, and
 * AsyncStorage is a native key-value store. Note what is *not* mocked - the
 * profile still travels through the real `storage.ts`, which means
 * `normaliseProfile` still runs at the boundary, so a save written by a screen
 * is a real save.
 */
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => void store.set(key, value),
      removeItem: async (key: string) => void store.delete(key),
      clear: async () => store.clear(),
    },
  };
});

beforeEach(async () => {
  // A save must not survive into the next test: the app reads storage on mount,
  // so a leaked profile would silently skip sign-up.
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.clear();
});

/**
 * Unmount between tests, so one screen's timers and effects cannot leak into
 * the next test's assertions.
 *
 * Reached through the module cache rather than imported, so that the tests
 * which never render a component - the engine seam, storage, the battle flow -
 * do not pay for loading React Native at all.
 */
const rendered = require.resolve('@testing-library/react-native');

// Awaited, not fired and forgotten: unmounting is asynchronous in Testing
// Library 14, and an un-awaited cleanup lands in the middle of the next test.
afterEach(async () => {
  await require.cache[rendered]?.exports.cleanup();
});
