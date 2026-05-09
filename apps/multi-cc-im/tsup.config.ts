import { defineConfig } from 'tsup';

/**
 * Bundle `apps/multi-cc-im/src/cli.ts` → `dist/cli.js` for fast startup
 * (`bin/multi-cc-im` wrapper detects `dist/cli.js` and skips tsx if built).
 *
 * Why bundle:
 * - cc hook subprocess fires on every assistant turn (UserPromptSubmit + Stop
 *   = 2 spawns / turn). tsx cold start is ~300ms; bundled `node dist/cli.js`
 *   is ~50ms. 600ms vs 100ms per turn matters for typing UX.
 * - v2 path to `npm publish` — bundled output is closer to publishable form.
 *
 * Bundling strategy:
 * - **`noExternal: [/^@multi-cc-im\//, 'openclaw']`** — force-inline workspace
 *   packages because they ship TS source (`exports: ./src/index.ts`); without
 *   this tsup defaults to treating dependencies as external, runtime fails
 *   with `ERR_MODULE_NOT_FOUND` resolving the .ts imports.
 * - **`external: ['silk-wasm']`** — ships a `.wasm` binary tsup can't bundle
 *   safely. Resolve from `node_modules` at runtime (still required there).
 * - npm deps not in `noExternal` (zod / smol-toml / chokidar / proper-lockfile
 *   / qrcode-terminal) are **bundled** by tsup default — pure JS, inline OK.
 * - Node built-ins (`node:*`, `fs`, etc.): auto-external.
 */
export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Bundle all dependencies (workspace TS source + every npm dep) so the
  // output is as self-contained as possible. The few deps that genuinely
  // can't be inlined go via external:
  //   silk-wasm       — ships a .wasm binary the bundler can't handle
  //   proper-lockfile — CJS using a top-level `require('path')`; shims can't fix it
  //   undici          — internal `require('assert')` etc. that ESM bundle's
  //                     dynamic-require shim can't resolve. undici 8 IS valid
  //                     in Node ESM via `import { Agent } from 'undici'`,
  //                     just not when re-bundled inside another ESM file.
  // These three are resolved at runtime by Node from apps/multi-cc-im/node_modules
  // (already declared in package.json deps).
  noExternal: [/^@multi-cc-im\//, 'openclaw'],
  external: ['silk-wasm', 'proper-lockfile', 'undici'],
  // shims: __filename / __dirname / require ESM-CJS interop helpers (still
  // needed by a handful of deps, e.g. some-cjs using module.createRequire).
  shims: true,
});
