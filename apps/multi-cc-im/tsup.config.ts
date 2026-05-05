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
  shims: false,
  dts: false,
  // Bundle 全部依赖（workspace TS source + 所有 npm deps），让产物尽量自包含；
  // 对**真**不能 inline 的少数 deps 走 external：
  //   silk-wasm   — 含 .wasm binary，bundler 处理不了
  //   proper-lockfile — CJS 用顶层 `require('path')`，shims 也修不动
  // 这两个 runtime Node 通过 apps/multi-cc-im/node_modules 直接 resolve（已加进
  // package.json deps）。
  noExternal: [/^@multi-cc-im\//, 'openclaw'],
  external: ['silk-wasm', 'proper-lockfile'],
  // shims: __filename / __dirname / require ESM-CJS 互操作 helper（少数 dep
  // 还是需要的，比如 some-cjs 用 module.createRequire 等）。
  shims: true,
});
