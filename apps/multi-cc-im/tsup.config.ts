import { defineConfig } from 'tsup';
import { copyFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Shebang flows through from src/cli.ts line 1 — tsup preserves it.
  // Do NOT add `banner: { js: '#!/usr/bin/env node' }` here: that would
  // emit a SECOND shebang on line 2, which Node's ESM loader rejects with
  // "SyntaxError: Invalid or unexpected token" (only line 1 is honored).
  // Copy the iTerm2 Python helper script next to the bundled cli.js so
  // the daemon can resolve it at runtime via `import.meta.url`. Per
  // [DD: iTerm2 adapter](../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
  // the helper is a sibling Python program the term-iterm2 adapter
  // spawns once per call. tsup inlines TypeScript / JS but leaves the
  // `.py` file untouched — we must copy it ourselves.
  //
  // Function form (not string command) because tsup mangles `..` in
  // string commands. Function callback resolves paths relative to the
  // config file's own location via `import.meta.url`, independent of
  // tsup's runtime cwd.
  onSuccess: async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = resolve(
      here,
      '../../packages/term-iterm2/bin/iterm2-helper.py',
    );
    const dest = resolve(here, 'dist/iterm2-helper.py');
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    // Mark dist/cli.js executable (mode 0755) so `npm install -g` bin
    // symlink resolves to an executable target. tsup doesn't set the
    // executable bit on its output; without this, `multi-cc-im` runs but
    // direct execution of dist/cli.js fails with EACCES.
    await chmod(resolve(here, 'dist/cli.js'), 0o755);
  },
});
