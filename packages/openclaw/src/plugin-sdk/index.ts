/**
 * Empty stub for the `openclaw/plugin-sdk` (no subpath) entry. Real upstream
 * `openclaw` npm package exports utilities like `stripMarkdown` from this
 * path, but the vendored Tencent/openclaw-weixin protocol layer (in
 * `packages/im-wechat/lib/ilink/`) only imports from the **subpaths**
 * (`./infra-runtime` + `./reply-runtime`), so we don't need to re-implement
 * the surface here.
 *
 * This stub exists solely so vendored tests that `vi.mock("openclaw/plugin-sdk")`
 * (without subpath) can still resolve a base module — vitest's `vi.mock`
 * intercepts the module factory regardless of what's actually exported, so
 * an empty file is sufficient. Without this stub, vitest fails with
 * `Missing "./plugin-sdk" specifier in "openclaw" package`.
 */

export {};
