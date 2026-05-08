# IMOrigin 重设计为 daemon-global + 每条 inbound 覆盖 DD 报告

**Topic**: 修 stale `context_token` bug：用户连发任务给两个 cc（中间隔几十秒）时，第二个 cc 的 PreToolUse / Stop forward 报 `ECONNRESET` ——根因是 `<paneId>.IMOrigin` 缓存的是 dispatch 当时的 `context_token`，几十秒后 server 端已经把 token 推进到新值，旧 token 失效。把 IMOrigin 从 per-pane 文件改成 daemon-global 单文件，每条 inbound 都覆盖，让异步 outbound 路径跟 inbound 同步 echo 路径用同一个 latest token。

**Scope**: `<stateDir>/IMOrigin` 文件路径与 schema (per-pane → global single)；`bridge/orchestrator` IMOrigin 写入时机（dispatch-only → 每条 inbound 入口）；删除时机（cc Stop forward 后删 → 不删，daemon start/stop 删）；hook E3 检查（per-pane → global）。**不动**：`WechatReplyContext` schema (`{imType, to, contextToken}` 不变)；vendored `contextTokenStore` (我们自己有 IMOrigin 落盘，不依赖 vendored map)；IMWork lifecycle；DD #57 / #58 / #61 / #64 锁定的其他设计。

**Date**: 2026-05-08
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 起源于 PR #66 (auto-approve) merge 之后用户实测连发两个 cc 任务复现 ECONNRESET。根因不是 ECONNRESET 本身（那是 server 端拒绝 stale token 的副作用），而是我们在协议语义上误把 `context_token` 当成 per-cc-bound 的状态缓存，实际它是 user-bot conversation 全局 latest 状态。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **f. global IMOrigin + 每条 inbound 覆盖 + daemon start/stop 删** | ✅ **推荐** |
| a. 维持现状（per-pane IMOrigin + 缓存 dispatch-time token） | ❌ — 已经是 bug，user 实测复现 |
| b. per-pane IMOrigin + token 用 vendored `contextTokenStore` 全局 + 文件不存 token | ⚠️ — 正确但改动大（schema 变更跨 4 包） |
| c. global IMOrigin + cc Stop forward 后删 (one-shot) | ❌ — 多 cc 场景 cc#2 reply 丢失 (cc#1 reply 删了 IMOrigin) |
| d. global IMOrigin + 永不删 | ⚠️ — 干净但 daemon crash 残留 stale 文件，下次 start 用旧 token |
| e. global IMOrigin + 只 daemon stop 删 | ⚠️ — happy path 清；crash path 不清 |

---

## 1. 问题陈述

### 用户实测现象

```
[wechat] router returned echo only: ❌ `@哈哈` not found
[PreToolUse pane=4] ask IM: Bash(...)
  ⚠️  orchestrator [preToolUseAsk pane=4]: fetch failed (ECONNRESET)
[cc → wechat] work_temp reply='# 这阶段我们一起干的事...'
  ⚠️  orchestrator [forwardStop pane=8]: fetch failed (ECONNRESET)
[PreToolUse pane=4] ask IM: Bash(ls ...)
  ⚠️  orchestrator [preToolUseAsk pane=4]: fetch failed (ECONNRESET)
```

用户描述：「单 cc 没问题；先后两个 cc 中间隔几十秒就出问题」。

### 关键观察 (用户提出)

`@multi-cc-im /list` `@multi-cc-im /start` 等 bridge command **永远工作**，即使从未操作过任何 cc。这指向 **echo 路径不依赖 IMOrigin**。

看 `bridge/orchestrator.ts:243`:

```ts
await opts.imAdapter.send(echoLines.join('\n'), msg.replyCtx);
```

echo 直接用 `msg.replyCtx`（当前 inbound msg 的 ctx，`contextToken` = server 刚给的最新值）。所以 echo 路径永远 fresh token。

### 根因

异步 outbound 路径（cc PreToolUse forward / cc Stop forward）不在 inbound 同步链路上，没法用 `msg.replyCtx` —— 必须读 IMOrigin。当前 IMOrigin 只在 `dispatchOne` (`bridge/orchestrator.ts:149`) 时写、内容是 dispatch 当时的 `replyCtx`、cc Stop forward 完即删（one-shot）。

后果：
1. user 发 bridge command (`/start` `/list` `/help`) → server 给新 token → 但 router 不 dispatch → IMOrigin 不写 → token 丢
2. user 发 `@<tab> /1` `/2` (permission response) → 同上，token 丢
3. user 发实际 cc-bound 消息 → IMOrigin 写 (token=A)
4. 几十秒后 cc 自治调工具 / Stop → 异步 outbound 读 IMOrigin → 用 token=A
5. 但中间 user 跟微信交互过几次（哪怕只是 `/list`），server 端 token 已推进到 B / C / D — token=A 失效
6. server 拒绝 stale token → ECONNRESET / 4xx (server 表现行为不一)

### 上游 evidence

vendored `packages/im-wechat/lib/ilink/messaging/inbound.ts` 维护 `contextTokenStore: Map<accountId:userId, token>`，`setContextToken` overwrites latest, `context-token-store.test.ts` 明确测「overwrites existing token」。意味着 **iLink 协议层语义就是 per-user latest token**，旧 token 一旦被新 inbound 覆盖就无效。

我们 multi-cc-im 把 token 当 per-cc-bound state 缓存到 `<paneId>.IMOrigin`，与协议层语义不一致 — 这是设计 bug 不是实施 bug。

---

## 2. 候选枚举

### a. 维持现状（per-pane IMOrigin + dispatch-time token）

什么都不动。已经是 bug，否决。

### b. per-pane IMOrigin（仅 `to` 字段）+ token 用 vendored `contextTokenStore`

跟上游对齐：把 token 从 IMOrigin 抽出，存 vendored 全局 map；IMOrigin 仅存 `{imType, to}`。

需要改动:
- `WechatReplyContext` schema 删 `contextToken` 字段
- `im-wechat/adapter.ts` inbound 调 `setContextToken`；send 调 `getContextToken`
- 跨 4 包级联 type 改动（shared / im-wechat / cli-cc / bridge）
- 跨 ~30 处测试 literal 改

### c. global IMOrigin + cc Stop forward 后删（保留 one-shot）

global 解决 stale；one-shot 删除导致多 cc cc#2 reply 丢:

```
inbound#1 @cc1 hello (token=A)   → IMOrigin = A
inbound#2 @cc2 hello (token=B)   → IMOrigin = B
cc1 Stop → forward (token=B) ✓ → 删 IMOrigin
cc2 Stop → IMOrigin = null      → silent exit ❌
```

否决。

### d. global IMOrigin + 永不删

干净但 daemon crash 后 stale 文件残留，下次 daemon start 时第一个异步 outbound 之前如果 IMWork 没被 user `/start`（用户场景：daemon 重启后 user 还没操作），但即使没 IMWork hook 也 short-circuit，IMOrigin stale 不影响 — 实际是安全的。但下次 daemon stop 不删的话 manual 重启场景仍可能遗留旧文件。**hygiene 问题**。

### e. global IMOrigin + 只 daemon stop 删

happy path (Ctrl+C / graceful) 清场。但 daemon crash (OOM / SIGKILL) 不跑 stop hook → IMOrigin 残留 stale。

虽然 IMWork 也是 daemon stop 删 + daemon start 重置（DD #58），如果 IMOrigin 只 stop 删而不 start 删，跟 IMWork 的 lifecycle 不对称 — 容易混淆。

### f. global IMOrigin + 每条 inbound 覆盖 + daemon start/stop 删 ✅ 推荐

跟 IMWork 完全对称的 always-fresh lifecycle:

| 事件 | 行为 |
|---|---|
| user 任何 inbound | 写 `state/IMOrigin = msg.replyCtx` (latest, 跟 echo 同源) |
| cc Stop forward 完 | 不删 (扔 one-shot — 多 cc 都能 reply) |
| `/stop` (router) | 不删 (IMWork 删够了；hook E2 看 IMWork 不是 IMOrigin) |
| daemon stop (graceful) | **删** (happy path) |
| daemon start | **删** (crash 兜底，防 OOM/SIGKILL 留 stale) |

---

## 3. 对比矩阵

| 维度 | a. 现状 | b. vendored store | c. global one-shot | d. 永不删 | e. 只 stop 删 | **f. start+stop 删** |
|---|---|---|---|---|---|---|
| 修 stale token | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多 cc reply 一致 | ⚠️ stale | ✅ | ❌ cc#2 丢 | ✅ | ✅ | ✅ |
| schema 改动面 | 0 | 跨 4 包 ~30 处 | 仅 IMOrigin path | 同 c | 同 c | 同 c |
| crash 后 stale 清理 | n/a | n/a (vendored 自管) | one-shot 无残留 | ❌ 残留 | ⚠️ stop 清 / start 不清 | ✅ 双保险 |
| 跟 IMWork lifecycle 对称 | n/a | n/a | ✅ | ❌ 不对称 | ⚠️ 半对称 | ✅ 完全对称 |
| anti-misforward (DD #57) | per-reply one-shot | 同 a | 同 a | per-IMWork-session | 同 d | per-IMWork-session |
| 实施代码量 | 0 | 大 | 中 | 中 | 中 | 中 |

### 关键差异

**(b) vs (f)**: 
- (b) 跟上游对齐最干净；schema 删字段语义最明确
- (f) 改动小一半；不引入新依赖；用户跟讨论后明确选简化路径

(b) 后续 v2 telegram / lark adapter 加进来时如果要用上游 store 模式可以再迁移，**当前 v1 阶段 (f) 充分**。

**(d) vs (e) vs (f)**:
- (d) 永不删 → daemon crash 残留
- (e) 只 stop 删 → crash 路径未 cover
- (f) 双删 → 跟 IMWork 一致 (DD #58 daemon start 永远重置 IMWork)

(f) 是 belt-and-suspenders — happy path + crash path 都 cover，跟现有 daemon liveness 设计模式一致。

### Anti-misforward (DD #57 protection 怎么办)

DD #57 加 IMOrigin one-shot 删除是为了「防 cc TUI 误转发到微信」。改为 (f) 后:
- IMWork ON 期间所有 cc forward (这就是 user 想要的多 cc 一致)
- IMWork OFF (`/stop` / daemon stop / daemon start 重置) → hook E2 (`readIMWorkFile === null`) → silent exit → 所有 forward 关闭

protection 不丢 — 粒度从「per-reply one-shot」变「per-IMWork session」，**用户控制更明确**：
- 当前: 每个 cc reply 一次后自动断 forward；想继续 forward 必须每次 user 重新 trigger
- 改后: `/start` 之后所有 cc 都持续 forward 直到 `/stop` / daemon 退

实测 DD #57 的 one-shot 在 v1 实际场景几乎没救过用户：cc TUI 输入时 user 通常已经 `/stop`，one-shot 是 belt-and-suspenders，不是核心机制。粗化粒度换来多 cc 一致性，划算。

### 否决候选

- **a. 现状** — bug
- **b. vendored store** — 改动 3x；v1 阶段简化路径优先
- **c. global one-shot** — 多 cc cc#2 reply 丢
- **d. 永不删** — daemon crash 残留 hygiene 问题
- **e. 只 stop 删** — crash path 未 cover

---

## 4. 推荐：候选 f — global IMOrigin + 每条 inbound 覆盖 + daemon start/stop 删

按上述分析，推荐 (f)。理由可追溯到对比矩阵:

1. **修 stale token** [f ✅]: 跟 echo 路径用同一个 latest token (`msg.replyCtx`)，异步 outbound 永远 fresh
2. **多 cc 一致** [f ✅ vs c ❌]: cc#1 reply 不影响 cc#2 reply
3. **改动面小** [f ~6 文件 vs b ~30 处]: schema 不动，仅 IMOrigin path + 写入时机 + 删除时机
4. **跟 IMWork lifecycle 对称** [f ✅]: 跟 DD #58 daemon liveness 设计模式一致 (start always reset / stop always clear)
5. **crash 兜底** [f ✅ vs d ❌, e ⚠️]: daemon SIGKILL/OOM 不跑 stop hook 也不会留 stale (start 兜底)

实施代码量约：cli-cc/state-files.ts (~10 行 helper 简化) + bridge/orchestrator.ts (~10 行写入位置移动 + 2 处 delete 删除) + apps/start.ts (~4 行 daemon start/stop 加 delete) + cli-cc/hook-receiver.ts (~2 行 E3 去 paneId) + apps/state-sweep.ts (~1 行白名单) + 测试 (~6 文件 mechanical) + docs (4 处)。总改动 < 200 行。

**风险**:
- 老 `<paneId>.IMOrigin` 文件遗留: state-sweep 不再认它 (top-level 白名单只有 `IMOrigin` 而不是 `*.IMOrigin`)。daemon start 删 `IMOrigin`，老 `<paneId>.IMOrigin` 留下来 → state-sweep 把它们当 paneId-keyed orphan 清掉 (paneId 不在 wezterm live 集时)。**自动 migration**，无需写迁移代码。
- 测试改动面: 主要是 IMOrigin 调用点去 paneId，机械改动。

---

## 5. 实施计划（PR-E）

1. **`cli-cc/src/state-files.ts`**:
   - `IMOriginIO` interface: `{stateDir, paneId}` → `{stateDir}` (或者直接用 `string` 不要 interface)
   - `IM_ORIGIN_SUFFIX = '.IMOrigin'` → `IM_ORIGIN_FILE_NAME = 'IMOrigin'`
   - `imOriginPath / readIMOriginFile / writeIMOriginFile / existsIMOriginFile / deleteIMOriginFile` 签名去 paneId
   - `parseIMOriginFilename` / `extractPaneIdFromFilename` 关于 IMOrigin 的部分简化（IMOrigin 不再算 pane-keyed）
   - `listIMOriginFiles` 删（global 只一个）
   - JSDoc 更新：lifecycle 说明改新语义

2. **`bridge/src/orchestrator.ts`**:
   - **新增**: `handleInbound` 入口（router 之前）`writeIMOriginFile({stateDir, replyCtx: msg.replyCtx})` — 每条 inbound 必写
   - **删除**: `dispatchOne` 内的 `writeIMOriginFile` 调用 (移到 handleInbound 入口了)
   - **删除**: `handleStop` 内的 `deleteIMOriginFile` 调用 (扔 one-shot)
   - 所有 `readIMOriginFile / existsIMOriginFile` 调用去 paneId

3. **`cli-cc/src/hook-receiver.ts`**:
   - PreToolUse E3: `existsIMOriginFile(stateDir)` (无 paneId)
   - Stop guard: 同上

4. **`apps/multi-cc-im/src/start.ts`**:
   - daemon start：在重置 IMWork 之后/之前 `deleteIMOriginFile(paths.stateDir)` (跟 daemon.pid lock 写之前一起)
   - daemon stop hook: 在删 IMWork + daemon.pid 时一并 `deleteIMOriginFile`

5. **`apps/multi-cc-im/src/state-sweep.ts`**:
   - top-level 白名单 (跟 `IMWork` / `wechat-cursor` / `daemon.pid` 一起): 加 `IMOrigin`
   - 老 `<paneId>.IMOrigin` 文件: 仍按 pane-keyed 路径处理 (`extractPaneIdFromFilename` 抽出 paneId, paneId 不在 live 集就删) — 自动迁移完成

6. **测试**:
   - cli-cc/state-files.test.ts: IMOrigin 测试改 (~10 处去 paneId)
   - cli-cc/hook-receiver.test.ts: E3 测试改
   - bridge/orchestrator.test.ts: 写入时机改 (handleInbound 入口); 不再断言 cc Stop 后删 IMOrigin; 新增 inbound bridge command 也写 IMOrigin 的测试
   - apps/start.test.ts: 加 daemon start/stop 删 IMOrigin 断言
   - apps/state-sweep.test.ts: top-level IMOrigin 白名单 + 老 `<paneId>.IMOrigin` 自动清

7. **docs**:
   - `README.md` / `README.zh-CN.md`: state-files reference 表 IMOrigin 行 lifecycle 描述; 异步 outbound 路径段落
   - `docs/architecture.md`: IMOrigin lifecycle 描述
   - `CLAUDE.md`: 关键设计假设表 IMWork+IMOrigin 行同步 (路径 `<paneId>.IMOrigin` → `IMOrigin`; lifecycle "cc Stop forward 完即删" → "每条 inbound 覆盖, daemon start/stop 删")

---

## 6. 锁定决策（待用户确认）

✅ **采纳候选 f**:

- IMOrigin 路径: `state/<paneId>.IMOrigin` → `state/IMOrigin` (global single)
- 写时机: 仅 dispatchOne → 每条 inbound 入口 (覆盖)
- 删时机: cc Stop forward 完 (one-shot) + daemon stop → daemon start + daemon stop (always-fresh)
- 跟 IMWork lifecycle 完全对称
- WechatReplyContext schema 不动 (`{imType, to, contextToken}`)

待用户审 → 锁定 → PR-E 实施。

---

## 7. CLAUDE.md 更新（实施时一起 commit）

「关键设计假设（状态总表）」IMWork+IMOrigin 行更新:

| 维度 | 状态 | 详情 |
|---|---|---|
| IM 模式总开关 (IMWork) + global IMOrigin + read-only 工具白名单 | ✓ | **三层组合**：`state/IMWork` JSON `{auto:bool}`（用户 `@multi-cc-im /start [auto] /stop` 显式控制；daemon start 自动重置 OFF；老 0-byte 兼容 `{auto:false}`）+ **`state/IMOrigin` 单文件**（每条 inbound 覆盖 latest replyCtx；daemon start/stop **都删** — 跟 IMWork 对称 always-fresh，防 crash 残留 stale token；不再 per-pane / 不再 cc Stop 后删，DD #_ID_ 修 stale token bug）+ Read/Grep/Glob/NotebookRead 自动 allow 不打扰 IM。hook PreToolUse 5 步：read-only → allow / IMWork null → silent exit / IMWork.auto=true → allow / 无 IMOrigin → silent exit / 无 daemon → silent exit。**禁用 `permissionDecision: "ask"`**。daemon reaper 10s 兜底删孤儿 PermissionRequest/Response。[DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md) + [DD: PreToolUse auto-approve](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md) + [DD: IMOrigin global + always-fresh](docs/superpowers/specs/2026-05-08-imorigin-global-dd.md) |
