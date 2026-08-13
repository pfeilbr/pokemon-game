const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro configuration.
 *
 * The iOS client shares the web app's game engine rather than reimplementing
 * it. `src/lib/game/` is pure TypeScript with no React, no DOM and no Node
 * APIs, which is exactly what makes it portable - the rules of the game are
 * identical on both clients because they are literally the same code.
 *
 * Metro only watches its own project root by default, so the shared directory
 * has to be declared here, and module resolution has to be pinned to this
 * app's node_modules so shared files do not accidentally resolve against the
 * web app's dependency tree.
 */
const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(repoRoot, 'src/lib')];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
// Shared code must not pick up a second copy of React from the web app.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
