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
 * - **`noExternal: [/^@multi-cc-im\//]`** — force-inline workspace packages
 *   because they ship TS source (`exports: ./src/index.ts`); without this
 *   tsup defaults to treating dependencies as external, runtime fails with
 *   `ERR_MODULE_NOT_FOUND` resolving the .ts imports.
 * - **`external: [...]`** — npm deps that can't / shouldn't be inlined; see
 *   per-dep notes below. Resolved at runtime from `apps/multi-cc-im/node_modules`
 *   (declared in `package.json` deps).
 * - npm deps not in `noExternal` and not in `external` (zod / smol-toml /
 *   chokidar) are **bundled** by tsup default — pure JS, inline OK.
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
  noExternal: [/^@multi-cc-im\//],
  // Per-dep external rationale:
  //   proper-lockfile         — CJS using a top-level `require('path')`;
  //                             shims can't fix it.
  //   @larksuiteoapi/node-sdk — 25 MB unpacked (auto-generated full Feishu
  //                             OpenAPI surface across ~60 domains, all
  //                             deeply interlinked). Inlining bloats the
  //                             daemon bundle from 121 KB → 4.25 MB even
  //                             though we use only a few entry points.
  //                             Tree-shake doesn't help — the SDK's
  //                             internal cross-references defeat dead-code
  //                             elimination. External-ize and let Node
  //                             resolve at runtime.
  //   axios / protobufjs / qs / ws  — official SDK's runtime deps. Already
  //                             pulled by `@larksuiteoapi/node-sdk` from
  //                             pnpm; bundling them inline would double-
  //                             ship and add ~200 KB.
  external: [
    'proper-lockfile',
    '@larksuiteoapi/node-sdk',
    'axios',
    'protobufjs',
    'qs',
    'ws',
  ],
  // shims: __filename / __dirname / require ESM-CJS interop helpers (still
  // needed by a handful of deps, e.g. some-cjs using module.createRequire).
  shims: true,
});
