# DD: Lark / Feishu IM Adapter

**Date**: 2026-05-09
**Status**: 待用户决策（PENDING USER DECISION）
**Author**: multi-cc-im maintainer
**Scope**: how to add a Lark/Feishu IM adapter (`packages/im-lark/`) alongside the existing `packages/im-wechat/`. **This DD only locks in the protocol layer + bot type + dependency strategy.** Implementation begins after user picks a candidate.

---

## 1. Why this is a "重大决策"

Per [`CLAUDE.md`](../../../CLAUDE.md) DD heuristic, all four triggers fire:

- **安全模型**：new credential storage (`app_id` / `app_secret`), new outbound HTTP host (open.feishu.cn / open.larksuite.com).
- **长期维护负担**：a second IM protocol-layer dependency, parallel to wechat's vendored OpenClaw.
- **跨包接口**：`IMReplyContext` discriminated union grows a `'lark'` variant; orchestrator wires a second `IMAdapter`.
- **"用现有 SDK 不造轮子"准则**：picking SDK vs vendor vs from-scratch is exactly this rule's job.

Reversal cost: ≈ 1 week (orchestrator wiring + credential schema + tests). Above the DD threshold.

---

## 2. Use-case constraints (locked)

These constraints come from existing project rules and are **non-negotiable** for any candidate:

1. **No public IP** — daemon runs on user's laptop. Inbound events must arrive via outbound long-connection (wss / long-poll). Webhook-with-public-URL is **out of scope**.
2. **Bidirectional 1-1** — bot must both receive and send to the user's private chat with the bot. Group-only or send-only entries are disqualified.
3. **Local-first credentials** — `app_id` + `app_secret` written to `~/.multi-cc-im/credentials/lark.json` (mode 0600). No OS keychain — see [DD: credentials persistence strategy](2026-05-03-keychain-library-dd.md).
4. **Adapter interface** — must satisfy `@multi-cc-im/shared`'s `IMAdapter` + `IMHandler` shape (per [DD: adapter interface](2026-04-29-adapter-interface-dd.md)). `IMReplyContext` gets a new discriminated-union variant.
5. **TypeScript strict, ESM, Node ≥ 22** — same as the rest of the workspace.

---

## 3. Bot-type candidates (Lark/Feishu offers 3 entry points)

| Type | Receive? | Send 1-1? | No-public-IP? | Verdict |
|---|---|---|---|---|
| **Self-built (enterprise internal) app + WebSocket long-connection event subscription** | ✓ via `wss://...` outbound from laptop, no port forward | ✓ REST `POST /open-apis/im/v1/messages` | ✓ — docs literally say "无需提供公网 IP 或域名、无需使用内网穿透工具" | ✅ **only viable option** |
| Custom group bot / 自定义机器人 (incoming webhook) | ✗ "自定义机器人只能用于在群聊中自动发送通知，不能响应用户 @ 机器人的消息" | ✗ group-only, no 1-1 | N/A | ❌ disqualified |
| "Outgoing bot" | does not exist as a separate entity in Lark/Feishu | — | — | ❌ N/A |

**Conclusion**: bot type is forced — **self-built app + WSClient long-connection**. No real choice here.

⚠️ **Critical caveat — Lark international vs Feishu CN**:
- Feishu CN (`open.feishu.cn`) WSClient is documented and works.
- Lark international (`open.larksuite.com`) docs describe the WSClient feature, but field reports indicate the toggle may not be exposed in the Developer Console UI. **Smoke-test on the actual tenant before committing.**
- If Lark international doesn't expose WSClient → no-public-IP path doesn't exist on that side → would need cloudflared/ngrok tunnel, which violates our local-first principle. In that case the adapter is Feishu-CN-only at v1.

Sources:
- [Configure event subscription method (Feishu CN)](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [Receive events through websocket (Lark intl)](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)
- [Custom bot usage guide (Feishu)](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)

---

## 4. Implementation-strategy candidates

Bot type is fixed. The choice is **how** to build the WSClient + REST IM client.

### A0 — Do not add Lark; keep wechat as the only IM
- Cost: zero
- Trade-off: user has no IM choice. wechat path has been unstable across `undici` upgrades (PR #76, #78, #81, #82) and is vendored from a third party (Tencent OpenClaw).
- Listed per `CLAUDE.md` DD rule "first candidate is always 'do nothing / use existing'".

### A1 — npm depend on `@larksuiteoapi/node-sdk` (official SDK)
- Package: `@larksuiteoapi/node-sdk` — single canonical name, no aliases.
- Repo: <https://github.com/larksuite/node-sdk>
- Latest version: `1.63.1` (published 2026-05-08, ≤ 24h before this DD)
- License: MIT
- Stars: 265
- Last commit on main: 2026-05-08
- Commits last 90 days: 11
- Open issues: 2 (1× bun-specific socket close, 1× error-class wrap suggestion). Closed:open ratio ≈ 78:1.
- Downloads: 4.15M / month
- Maintainers (npm): 6, all `@bytedance.com` / `larkopen@larksuite.com` (no community drift)
- **Bus factor**: 1 — `mazhe.nerd` authored 8 of the last 10 commits. Risk if author leaves Bytedance team.
- Native TypeScript types
- Bundle: 25.8 MB unpacked (most is auto-generated OpenAPI types for ~60 Feishu domains; **runtime impact** is much smaller — only 7 runtime deps: `axios ~1.13`, `lodash.identity/merge/pickby`, `protobufjs ^7.2`, `qs ^6.14`, `ws ^8.19`).
- Capability: `WSClient` (since v1.24.0) does the no-public-IP long-connection; `client.im.message.create()` covers send (text / image / file / voice / interactive); auth tokens auto-cached + refreshed.
- Node 22/24 compat: no engine restriction; no open issue blocks newer Node.

### A2 — Vendor the IM-only subset of `@larksuiteoapi/node-sdk` (mirrors wechat OpenClaw pattern)
- Keep: `ws-client/` (82 KB), `dispatcher/` (9 KB), `client/` (22 KB), `utils/` (12 KB), `http/`, `logger/`, `typings/`, `consts/`. Hand-write a ~10 KB IM-only REST client (no need to vendor the 21.8 MB `code-gen/` covering attendance/calendar/drive/etc.).
- Total vendored TS: ≈ **150-200 KB / ~50 files**, plus `pbbp2.js` (29 KB) protobuf for ws wire format.
- Patches needed: rewrite `@node-sdk/*` path alias to relative imports (mechanical), add a `VENDOR.md` (mirrors `packages/im-wechat/lib/ilink/VENDOR.md`).
- Net `node_modules` deps still required: `axios`, `protobufjs`, `qs`, `ws`, `lodash.*`. **Vendoring source does not eliminate npm deps**, because protobuf + axios + ws are runtime libraries.

### A3 — Group bot webhook
Already disqualified in §3. Listed for completeness.

### A4 — Community libraries
Top 5 surveyed (`connect-feishu-bot`, `agent-feishu-channel`, `@zhin.js/adapter-lark`, `n8n-nodes-feishu-lark`, `feishu-tools`):
- 4 of 5 wrap `@larksuiteoapi/node-sdk` as peerDep — adopting them = A1 + extra hop.
- The exception (`@zhin.js/adapter-lark`) belongs to the zhin.js polyglot bot framework — adopting it = adopting the framework. Not a drop-in adapter.
- Only one (`agent-feishu-channel`) is itself a Claude/Codex-bridge app, similar shape to multi-cc-im — useful as **reference architecture** but not consumable as a library.
- Verdict: **no community library is preferable to the official SDK** for this use case.

### A5 — From scratch (raw `axios` for REST + raw `ws` + protobuf for WSClient)
- Possible but reinvents 80 KB of protobuf wire-format handling and OpenAPI auth that the official SDK does well.
- Violates `CLAUDE.md` 核心约束 #2 ("用现有 SDK，不造轮子").
- Listed per DD rule.

---

## 5. Comparison matrix

| Dimension | A0 do nothing | A1 npm depend | A2 vendor IM subset | A4 community | A5 from scratch |
|---|---|---|---|---|---|
| **Protocol correctness** | N/A | ✅ canonical official | ✅ same source | ⚠️ wraps official | ⚠️ DIY high risk |
| **No-public-IP support** | wechat does | ✅ WSClient | ✅ same code | ✅ via official | ⚠️ DIY protobuf |
| **Bidirectional 1-1** | wechat does | ✅ | ✅ | ✅ | ⚠️ |
| **Maintenance burden (long-term)** | none | minimal — `npm update` | high — manual sync | medium — community + official | very high |
| **Governance** | N/A | ✅ Bytedance team, 4.15M dl/mo | mirrors A1 | varies; mostly solo hobby | self |
| **Bus factor** | N/A | ⚠️ `mazhe.nerd` 8/10 commits, but 6 Bytedance maintainers | inherits A1 risk + adds ours | usually 1 | 1 |
| **Node 22/24 compat** | wechat: yes | ✅ no engine restriction | ✅ same | varies | self-managed |
| **TypeScript strict / `noUncheckedIndexedAccess`** | N/A | ✅ native, full `.d.ts` | ✅ same | varies | self-managed |
| **Bundle / runtime deps** | none | 7 deps (~axios + ws + protobuf + lodash) | same 7 deps + ~150 KB vendored TS | same + extra wrapper | self only |
| **Security (external HTTP / CVE)** | wechat-only | inherits Bytedance audit | inherits Bytedance audit | depends | DIY |
| **Reversal cost** | low | low — `npm uninstall` | medium — drop vendor dir | low | high |
| **Symmetry with wechat OpenClaw vendor** | N/A | ❌ asymmetric (wechat=vendor, lark=npm) | ✅ symmetric | ❌ | ❌ |
| **Pulls full Feishu OpenAPI (60+ domains)** when only IM is wanted | N/A | ⚠️ 25 MB types, but tree-shakeable | ✅ trimmed | ⚠️ via peerDep | ✅ |

---

## 6. Recommendation

**Recommend A1 — npm depend on `@larksuiteoapi/node-sdk`**.

**Why A1 over A2** (the symmetric-with-wechat path):
1. **No SDK existed for wechat** — that's why `Tencent/openclaw-weixin` was extracted. For Lark, an official Bytedance npm package exists with 4.15M monthly downloads, dedicated MIT license, 6 Bytedance maintainers, native TS types, and a single canonical version. The reason to vendor (no upstream npm package) does not apply.
2. **Reversal cost is lower** — `npm uninstall` vs deleting a 150-line vendored tree. If something goes wrong (bus factor, license change, abandonment), pivot to A2 then.
3. **Tree-shake handles the 25 MB types issue** — `tsup` already external-izes runtime deps; only the IM-related code paths actually compile into our bundle.
4. **A2 isn't strictly smaller** — vendoring source still requires the same 7 runtime npm deps (`axios`, `protobufjs`, `qs`, `ws`, `lodash.*`). The vendor saves auto-generated TS types from the bundle, but those types weren't going into the bundle anyway under tsup external rules.

**Why not A0 (do nothing)**: user explicitly asked for Lark adapter after wechat path's instability. Single-IM lock-in is the bigger risk.

**Why not A4 / A5**: covered in §4; they're strictly worse than A1.

**Cell-by-cell traceback for the recommendation** (per CLAUDE.md DD rule "每条理由必须可追溯到矩阵某格证据"):
- "official + actively maintained" → §5 row "Governance" + §4 A1 (4.15M dl/mo, 11 commits / 90d)
- "no SDK existed for wechat" → `packages/im-wechat/lib/ilink/VENDOR.md` §"Why vendor (not npm depend)"
- "tree-shake handles types" → A1 bullet "Bundle: 25.8 MB unpacked … runtime impact much smaller"
- "A2 not strictly smaller" → §4 A2 bullet "Net node_modules deps still required"

---

## 7. Bus-factor mitigation

`mazhe.nerd` authoring 8/10 recent commits is the only governance risk worth flagging.

Mitigation if the SDK becomes unmaintained:
1. **Pin to a known-good version** in `package.json` (`^1.63.x` not `latest`).
2. **CI smoke test** against the SDK every release (covered by our existing `pnpm test` once we add a Lark IM adapter test).
3. **Fallback**: switch to A2 (vendor the same git commit). Cost: ≈ 2 days.

---

## 8. ⚠️ Open items requiring user decision

These items affect implementation scope and are NOT yet resolved by this DD. **Please decide before implementation begins**:

### 8.1 wechat — replace or coexist?

- **Replace** (drop `packages/im-wechat`): one less protocol to maintain, no more `undici` patch chain. But user loses wechat as fallback.
- **Coexist** (run both adapters in parallel, route based on `IMReplyContext.imType`): more code to maintain, but more flexibility. memory `project_future_im_adapters` already requires that the architecture support coexistence (telegram, lark, etc.). The `IMReplyContext` discriminated union is built for it.
- **Recommendation**: **coexist for v1**. The architecture already pays the cost; deleting wechat is a separate decision that can be made later. Default to including wechat unless the user explicitly says drop it.

### 8.2 imType naming — `'lark'` or `'feishu'`?

- `'lark'` matches international branding; the SDK package name uses `larksuite`.
- `'feishu'` matches Chinese market and our likely-primary tenant.
- The `IMReplyContext` discriminated union already reserves `'lark'` (see `packages/shared/src/adapter/im.ts`).
- **Recommendation**: stick with **`'lark'`** to align with the existing reservation + SDK name. Credentials file: `~/.multi-cc-im/credentials/lark.json`.

### 8.3 Tenant: Feishu CN, Lark international, or both?

- Feishu CN: WSClient confirmed working.
- Lark international: WSClient may or may not be exposed via Developer Console (field reports vary). **Untested without a real account.**
- **Recommendation**: **v1 = Feishu CN only**. Lark international support added if the user has an international tenant and we confirm WSClient exposure in a smoke test. Adapter code will be written domain-aware so adding Lark intl is later a config flag, not a refactor.

### 8.4 MVP message types

wechat currently supports text + image + file + voice (with `voice_text` extraction). Lark's IM v1 supports the same types via `client.im.message.create({ msg_type: 'text' | 'image' | 'file' | 'audio' | 'media' | 'interactive' | 'post' | ... })`.

- **MVP (text only)**: ship faster. User can `@<tab>` and send plain text.
- **Full parity with wechat**: text + image + file + voice on day one.
- **Recommendation**: **MVP text + interactive cards for permission prompts**. Image / file / voice deferred to v2. Rationale: text + interactive covers the entire bridge use case (route messages + tool-permission `/1` `/2` flow); image/file/voice are wechat features driven by mobile users sending media into a chat, which is a different optimization curve.

### 8.5 Dependency: minor-pin vs caret?

- Caret `^1.63.x` (current convention in this workspace) — auto-pulls patch + minor.
- Tilde `~1.63.x` — patch only.
- **Recommendation**: **caret** to match workspace convention, but add a CI smoke check that catches breaking changes early. The workspace already runs `pnpm test` on every CI; we'll add an integration test that exercises the WSClient against a fake server.

---

## 9. After this DD is locked

When the user accepts (or amends and accepts) §8 decisions:

1. Save the user's chosen § 8 values **into this DD** under a "Locked decisions" section.
2. Update `CLAUDE.md` 状态总表 with a new row: `Lark/Feishu IM adapter | ✓ DD完成 | A1 + Feishu CN + 'lark' + MVP text+cards + caret`.
3. Update `CLAUDE.md` 修订记录 with a v1.5 line.
4. Open an implementation PR that creates `packages/im-lark/` per the locked decisions.

Implementation milestones (not part of this DD):
- M1. `packages/im-lark/src/credentials.ts` + `WeixinCredentials`-style schema for `lark.json`.
- M2. `packages/im-lark/src/login.ts` — exchange `app_id` + `app_secret` for `tenant_access_token`, save to credential store.
- M3. `packages/im-lark/src/adapter.ts` — `createLarkAdapter()` returning `IMAdapter`. Internally uses `client.ws.start()` for inbound + `client.im.message.create()` for outbound. Mirrors `packages/im-wechat/src/adapter.ts` shape.
- M4. `packages/shared/src/adapter/im.ts` — confirm `LarkReplyContext` already exists; flesh it out per the new `app_id` + `chat_id` + `message_id` shape.
- M5. orchestrator wiring in `apps/multi-cc-im/src/start.ts` + new CLI `multi-cc-im login lark` subcommand.
- M6. Tests + docs (CLAUDE.md status table, README EN+CN, architecture.md).

---

## 10. References

- [DD: adapter interface](2026-04-29-adapter-interface-dd.md)
- [DD: credentials persistence strategy](2026-05-03-keychain-library-dd.md)
- [`packages/im-wechat/lib/ilink/VENDOR.md`](../../../packages/im-wechat/lib/ilink/VENDOR.md) — wechat vendor pattern (precedent for A2)
- [Lark/Feishu official Node SDK](https://github.com/larksuite/node-sdk)
- [Feishu event subscription docs (CN)](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)
- [Feishu im-v1 message create](https://open.feishu.cn/document/server-docs/im-v1/message/create)
