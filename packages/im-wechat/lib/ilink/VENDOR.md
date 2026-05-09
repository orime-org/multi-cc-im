# Vendored: Tencent/openclaw-weixin

`packages/im-wechat/lib/ilink/` is a copy of the protocol-layer code extracted from [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin); it is **not** original code.

## Origin

- **Upstream**: https://github.com/Tencent/openclaw-weixin
- **Pinned commit**: `6e58a2bcb505df2cad8ba396b8b58b18bbcb5777` (tag `v2.1.7`, 2026-04-07)
- **License**: MIT — see [`LICENSE.upstream`](./LICENSE.upstream)
- **Vendored at**: 2026-04-30

## Why vendor (not npm depend)

Per the multi-cc-im DD report [`docs/superpowers/specs/2026-04-26-ilink-library-dd.md`](../../../../docs/superpowers/specs/2026-04-26-ilink-library-dd.md), option A1 (extract and vendor) is the locked-in choice. Key reasons:

1. **Official source** (maintained by Tencent) gives the highest protocol correctness — the other candidates (photon-hq / crazynomad) are reverse-engineered from this very repo.
2. **Each subdirectory has a `.test.ts`** → protocol correctness is verifiable.
3. **The OpenClaw plugin framework dependency is detachable** (replaceable with shims).
4. **Compared with an npm dep, vendoring lets us cherry-pick upstream fixes while cutting off the risk of upstream drift we don't track.**

## Contents

8 protocol subdirectories (sourced from upstream `src/`):

```
lib/ilink/
├── api/         # iLink HTTP endpoints (getUpdates / sendMessage etc.)
├── auth/        # QR login / pairing / accounts
├── cdn/         # Media file upload/download + AES-128-ECB decryption
├── messaging/   # Message processing / send / receive
├── media/       # silk voice / images / files
├── util/        # logger / redact / format
├── storage/     # config-cache / sync-buf / context-token
├── config/      # default config + constants
└── LICENSE.upstream  # original MIT license text
```

## Our modifications to vendored code

To remove the OpenClaw plugin framework runtime dependency and to satisfy multi-cc-im's strict TypeScript (`noUncheckedIndexedAccess: true`), we made the following **minimal** changes to the vendored code:

1. **OpenClaw runtime decoupling (5 files, import changes)**
   - In `auth/pairing.ts`, `auth/accounts.ts`, `messaging/send.ts`, and `util/logger.ts`, the `from "openclaw/plugin-sdk/infra-runtime"` / `"openclaw/plugin-sdk/reply-runtime"` imports pass through verbatim — the workspace package `openclaw` (`packages/openclaw/`) provides the minimal shim for those two entries (only `resolvePreferredOpenClawTmpDir` + `withFileLock` + the `ReplyPayload` type — i.e., what the vendored code actually uses). Originally this was wired up via a tsconfig path alias mapping to `src/openclaw-shim/`; refactoring to a workspace package means plain Node module resolution works, and tsx / vitest / real node all need no special configuration.
   - `auth/accounts.ts` was replaced wholesale by a minimal version (keeping only the 4 exports the vendored files depend on: `DEFAULT_BASE_URL` / `CDN_BASE_URL` / `deriveRawAccountId` / `loadConfigRouteTag` — upstream's multi-account index / encrypted storage are replaced by multi-cc-im's own implementation).
   - `messaging/process-message.ts` is deleted (deeply coupled to OpenClaw `channelRuntime`; the business logic is rewritten by multi-cc-im bridge core).
2. **strict-TS compatibility patches (2 files, 5 lines)**
   - `media/mime.ts:63` — `mimeType.split(";")[0]` gets a `?? ""` default (under `noUncheckedIndexedAccess`, `[0]` is inferred as `string | undefined`).
   - `util/logger.ts` — `LEVEL_IDS` becomes `as const satisfies Record<...>` plus a `LogLevelName` keyof and an `isLogLevelName` type guard, eliminating 4 spots where indexing `Record<string, number>` returned `number | undefined`.
   - These two patch sets let the vendored code typecheck cleanly under multi-cc-im's strict tsconfig; logically equivalent (no runtime behavior change).
3. **The `monitor/` subdirectory is not vendored** (the DD locked in a rewrite to an EventEmitter pattern → `packages/im-wechat/src/monitor.ts`).
4. **`auth/account-index.test.ts` / `auth/account-store.test.ts` deleted** (they test upstream's multi-tenant store, which is replaced by an owner-only single-account implementation → `src/accounts.ts`).
5. **`auth/pairing.test.ts` mock path adjusted (1 line)**: `vi.mock("openclaw/plugin-sdk", …)` → `vi.mock("openclaw/plugin-sdk/infra-runtime", …)` to match the subpath that `pairing.ts` actually imports (the upstream test could intercept via the barrel re-export from the npm `openclaw` package; our shim is a standalone module and needs the exact subpath).
6. **`api/api.ts` — drop manually-set `Content-Length` request header**: upstream `buildHeaders` sets `Content-Length: <byteLength>` on every POST. Per the fetch spec it's a forbidden request header that the user agent must compute itself; Node 22 / undici 8 strictly enforce this and reject the request with `UND_ERR_INVALID_ARG: invalid content-length header`. Symptom: `getUpdates` long-poll fails on every iteration, daemon log shows `fetch failed (cause: invalid content-length header [code=UND_ERR_INVALID_ARG])`, IM never receives any reply. Fix: remove the line from `buildHeaders`; `fetch` automatically sets a correct `Content-Length` for string bodies. Tests `buildHeaders — forbidden request headers` (api.test.ts) codify the contract per call site (getUpdates / sendMessage / getConfig / sendTyping).
7. **`api/api.ts` — use undici's own `fetch` (not Node global)**: upstream uses `globalThis.fetch`. Node bundles its own (potentially older) undici; passing a `Dispatcher` built from `undici@8` to that internal fetch fails with `UND_ERR_INVALID_ARG: invalid onRequestStart method` because v8 Agent handlers implement the v8 controller-based dispatch protocol that older internal versions don't recognize. Symptom: every getUpdates call fails on Node 24. Fix: `import { fetch } from "undici"` so `fetch` and `Agent` come from the same `undici@8` package and share one dispatcher contract. Test mock pattern accordingly switched from `vi.stubGlobal('fetch', ...)` to `vi.mock('undici', ...)` partial mock.
8. **`auth/login-qr.ts` — replace `String(err)` with `formatErrorWithCause`**: upstream's 5 `String(err)` call sites in `try/catch` blocks render the error as `"TypeError: fetch failed"` and drop `err.cause`, where Node 22+ `fetch` keeps the real network reason (`ECONNREFUSED` / `ENETUNREACH` / TLS handshake failure / DNS issue / etc.). Symptom: when a fetch fails the user sees a useless generic message; debugging requires adding ad-hoc logging. Fix: import `formatErrorWithCause` from `@multi-cc-im/shared` (workspace dep already present in `package.json`) and use it in all 5 spots. The function walks the cause chain (depth-limited at 5) and renders e.g. `"fetch failed (cause: connect ECONNREFUSED 14.18.180.207:443 [code=ECONNREFUSED])"`.
9. **`auth/login-qr.ts` — accept + thread through optional `dispatcher`**: upstream's `startWeixinLoginWithQr` / `waitForWeixinLogin` / `fetchQRCode` / `pollQRStatus` use the bare `apiGetFetch(...)` without a dispatcher. Per CLAUDE.md「禁止直接用 global fetch 绕开 dispatcher」+ [DD: iLink dispatcher health probe](../../../../docs/superpowers/specs/2026-05-08-ilink-dispatcher-health-probe-dd.md), iLink LB has 4 backend IPs of which 1-2 are intermittently dead; bare fetch's `dns.lookup` picks one at random and has no IP-rotation fallback, so login fails with `Client network socket disconnected before secure TLS connection was established [ECONNRESET]` when the roll lands on a dead IP. Fix: each of the 4 functions takes an optional `Dispatcher` parameter and threads it down to `apiGetFetch`. `packages/im-wechat/src/login.ts` builds the dispatcher (via `createHealthProbedDispatcher`) once at the top of `loginWechat`, threads `agent` into both vendor calls, and `await dispatcher.stop()` in `finally` so the re-probe interval timer doesn't leak even on failure paths.

For the full diff, see `git log packages/im-wechat/lib/ilink/`. When syncing, if upstream changes any of these 9 patch points, those changes need to be merged manually so we keep the strict-TS shape, Node-22+ fetch compatibility, our diagnostic error formatting, and the health-probed dispatcher integration.

## Sync workflow

When updating the vendored code (after an upstream release):

```bash
./scripts/sync-vendor-ilink.sh         # pull new commit + diff + flag affected subdirectories
# manually review the diff, cherry-pick the necessary changes
# re-run packages/im-wechat's vitest suite to verify the vendored tests still pass
```

## License

MIT (Tencent 2026). When distributing the multi-cc-im project, the `LICENSE.upstream` file **and** the attribution declaration in this VENDOR.md **must** be retained.
