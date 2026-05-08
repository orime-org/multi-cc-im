# Pane-keyed State Files + 删 SessionStart/SessionEnd DD 报告

**Topic**: 重构 state 文件命名 + daemon 协议层。当前 v1.3 把 cc 的 sessionId 当 daemon-side 路由的核心 key（SessionStart 文件 join wezterm cli list 拿 paneId、IMOrigin / Permission 文件用 sessionId 当 file key）。讨论中发现：**daemon 根本不需要 sessionId 概念** —— hook subprocess 自己能拿 `process.env.WEZTERM_PANE`，daemon 入站用 `wezterm cli list` 拿 tab title → paneId 直接寻址。把 file key 改成 `<paneId>_<sid>`（cc-hook-写）+ `<paneId>`（daemon-写），删 SessionStart + SessionEnd 文件 + 删对应 hook + 删 session-registry 模块 + PaneAlive 弱化为"信任 user `/start` list 给的认知"。同时给 IMReplyContext 加 `imType` discriminator（PR #56 设计漏的，未来 tg / 飞书 必需）。
**Scope**: `packages/cli-cc/src/state-files.ts` schema 改 / `hook-receiver.ts` 加 WEZTERM_PANE filter + 删 2 case / `payloads.ts` 删 SessionStart+End schema / `bridge/session-registry.ts` 整个删 / `bridge/orchestrator.ts` 改 file-key + 删 sid 概念 / `bridge/router.ts` 删 `@$<sid>` 寻址 / `term-wezterm/pane-alive.ts` 重写 / `apps/setup-hooks.ts` 4→2 hook / `apps/state-sweep.ts` 重写 / `shared/adapter/im.ts` ReplyContext 改 union。**不涉及** iLink 协议层、IM 用户面交互、term send-text 两步法。
**Date**: 2026-05-08
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 是 PR #58 ([DD: daemon liveness](2026-05-09-daemon-liveness-dd.md)) 之后讨论中提出的更深一步简化。daemon liveness DD 解决"daemon 死了 hook 怎么办"但保留所有 SessionStart/SessionEnd + sessionId-as-key 设计。本次进一步：**daemon 完全不需要 sessionId 概念**。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **c. paneId-keyed file + 删 SessionStart/SessionEnd + 入站不验活 + IMReplyContext 加 imType** | ✅ **推荐** |
| a. 维持现状（PR #58） | ❌ 排除 — 5 个不必要复杂度持续累积 |
| b. 仅瘦 SessionStart schema（删 paneId/cwd/transcript_path 字段保留 PID+lstart）| ❌ 排除（assistant 之前推荐过的折衷）— 改 < 价值，没解决 sessionId-as-key 跨进程协调 |
| d. paneId-keyed 但保留 sessionId 反查机制（in-memory map） | ❌ 排除 — daemon 重启后 map 失效，第一条 IM 失败 |
| e. paneId-keyed 但保留 SessionStart 当 PaneAlive 数据源 | ❌ 排除 — 既然信任用户 `/start` list 的认知，PaneAlive 的精细验活就不需要了 |

---

## 1. 问题陈述

### P1. SessionStart 跟 wezterm cli list 的 paneId join 是 redundant

当前 `session-registry.listAlive()`：
1. 读 state/ 下所有 `<sid>.SessionStart` 文件 → sid + pid + lstart + paneId
2. 跑 `wezterm cli list --format json` → 拿 paneId + tab title
3. 用 paneId join 两份数据 → SessionInfo

paneId 在两路重复（cc 写到 SessionStart 跟 wezterm 直接给 daemon 是同一个数）。**daemon 入站完全可以丢掉 SessionStart 一路，直接用 wezterm cli list 给的 paneId**。

### P2. sessionId 是 cc 内部概念，daemon 不需要

当前 daemon 端 sessionId 用途：
- `<sid>.IMOrigin` 文件 key
- `<sid>.PermissionRequest/Response.<id>.json` 文件 key
- `<sid>.Stop.<ts>` 文件 key
- session-registry SessionInfo.sessionId
- router `@$<sid>` 寻址路径
- `pendingReplyCtxBySession` Map（PR #56 已删，磁盘化）

但 daemon **路由本质上是 IM ↔ wezterm pane 的双向转发**。"哪个 cc"的概念由 wezterm pane 完全表达：每个 pane 最多跑一个 cc，cc 死则 pane SIGHUP。**paneId 在 cc 生命周期内事实上稳定**。

sessionId 仅在 cc-internal 视角有意义（cc 自己的 transcript jsonl 用 sid 索引、`claude --resume <sid>` 等）。**对 daemon 来说是 opaque 透传字段**。

### P3. SessionStart hook 的"PID + lstart" 验活机制 = 过度防御

当前 PaneAlive 用 PID + lstart 配对验活防 PID 复用。设计动机：cc /exit 后 pane 还在但里面是 zsh，盲注入会发到 shell。

但用户视角的真实 UX：**用户从 IM 发 `@multi-cc-im /start` 后 daemon 回 list，用户从 list 看到 `frontend (pane 15)` 就承诺"我知道这个 pane 有 cc"**。这相当于 user-side 验活。daemon 不需要再做 PID 检查。

corner case（用户 /start 后 cc 死了 daemon 不知道 → 盲注入 zsh）：
- 微信端没收到 cc 回复（cc 不存在了）
- 用户进 cc TUI 看 → 发现 cc 死了 → 自己 cc 重启 + IM 重发
- 接受这个 UX trade-off

### P4. 跨进程 sessionId-as-key 一致性复杂

当前协议：
- daemon 入站时知道 wechat replyCtx，写 `<sid>.IMOrigin` —— **但 daemon 入站时怎么拿到 sid?** 当前通过 router matcher → SessionInfo.sessionId（来自 SessionStart 文件 join）
- hook subprocess 自己拿 sid（payload.session_id）
- 两侧都要 agree on sid 才能 read/write 同一个文件

这条链 — daemon 必须读 SessionStart 文件拿 sid → 跟 hook 一致 — 是当前 SessionStart 文件**必须存在**的根本原因。

paneId-as-key 后：
- daemon 用 `<paneId>` 写 IMOrigin（paneId 来自 wezterm cli list）
- hook subprocess 用 `<paneId>_<sid>` 写 cc-fired 文件（paneId 来自 env、sid 来自 payload）
- daemon 读 cc-fired 文件时从文件名 parse paneId，**不需要 sid 也能路由**
- sid 透明保留在文件名（observability + 未来 cc transcript analytics）

**两侧不需要 agree on sid**。daemon 完全 sid-agnostic。

### P5. IMReplyContext 缺 `imType` discriminator

PR #56 设计 IMOrigin 文件存 IMReplyContext JSON，schema 是 `unknown`（adapter-defined）。

memory rule "feedback_no_workload_optimization.md"：「不许把 wechat-specific 假设渗进 base interface」。但当前 IMOrigin 没 `imType` 字段 —— daemon 出站 forward 时不知道走哪个 IM adapter。v1 只有 wechat 没问题，**未来 tg / 飞书 接入时**：

```
daemon outbound:
  ctx = readIMOrigin(<paneId>)
  ❌ if ctx is wechat schema → wechatAdapter.send(content, ctx)
  ❌ if ctx is tg schema     → tgAdapter.send(content, ctx)
  ❌ ... 怎么 discriminate？
```

shape-based discrimination 是 type system 反 pattern。`imType: "wechat" | "telegram" | "lark"` 字符串 discriminator 才是 standard discriminated union。

### P6. cc filter 当前依赖 paneToSession map，间接

当前 daemon 收到入站 `@frontend hello`：
1. router matcher 在 SessionInfo[]（来自 session-registry.listAlive）找 frontend
2. listAlive 的 SessionInfo 已经过 PaneAlive 检查
3. "matched 到 SessionInfo" 即 "cc 真在 wezterm 里活"

但这是间接证据：filter 通过"我们维护的 SessionInfo[] 里有 frontend"实现，链路：
```
SessionStart hook 写文件 → daemon 启动 chokidar 看 add 事件 → 注册 sid → 入站 listAlive 重新 join wezterm → matcher
```

paneId-keyed 后改成**直接证据**：
```
入站 → wezterm cli list → 找 title===frontend → paneId
出站 → cc-hook 写 <paneId>_<sid>.<event> → daemon 看到 = 真 cc 在 wezterm fire 的事件
```

文件命名格式本身就是 filter 证据（`<paneId>_<sid>.<event>` 这个格式只可能由"在 wezterm 里跑的 cc 的 hook subprocess"创建 —— vim 不会 fire cc hook、ssh 远端 cc 没 WEZTERM_PANE）。**零推断**。

---

## 2. 候选枚举

| # | 候选 | 解决问题 |
|---|---|---|
| a | 维持现状 | 0/6 |
| b | 仅瘦 SessionStart schema（删 paneId/cwd/transcript_path） | P1 部分 |
| **c** | **paneId-keyed + 删 SessionStart/SessionEnd + 入站不验活 + IMReplyContext imType** | **P1-P6 全部** |
| d | paneId-keyed 但 daemon in-memory map 反查 sid | P1 + P2 部分（重启后第一条 IM 失败）|
| e | paneId-keyed 但保留 SessionStart 作 PaneAlive | P1 + P2 + P5（PaneAlive 复杂度仍在） |

---

## 3. 每候选尽调

### 候选 a: 维持现状

代码改动：0 LOC
解决问题：0/6
风险：5 个真实复杂度（SessionStart join / sessionId-as-key 跨进程协调 / PaneAlive 多信号网格 / IMReplyContext 缺 imType / file filter 间接）继续在代码里。讨论中已被用户指出为不必要。

❌ 排除。

### 候选 b: 仅瘦 SessionStart schema

设计：

```ts
// 当前
SessionStartFile { pid, startedAt, paneId?, cwd, transcript_path }

// 改后
SessionStartFile { pid, startedAt }   // 只为 PaneAlive 防 PID 复用
```

session-registry 改用 wezterm cli list 直接拿 paneId（不再 join SessionStart）。

代码改动：~150 LOC + ~80 测试改动
解决问题：P1（部分）

但 P2 / P3 / P4 / P5 / P6 全部不动：
- sessionId 仍是 file key
- SessionStart 文件仍存在
- PaneAlive 仍维护 PID + lstart 多信号
- IMReplyContext 缺 imType
- filter 仍间接

是 assistant（我）之前推荐的折衷，被用户**正确反驳**。

❌ 排除（不彻底，浪费一次大改的机会）。

### 候选 c: 完整 paneId-keyed 架构（推荐）

完整设计见第 5 节。

代码改动：~700 LOC 净增 / ~1500 LOC 净改动 + ~500 测试改动
解决问题：P1 + P2 + P3 + P4 + P5 + P6 全部

风险：
- 反悔成本 > 1 周（IMOrigin / Permission 文件 key 改 = 协议层）
- daemon 入站不验活的 corner case：用户 /start 后 cc 死了 daemon 不知道盲注入 zsh —— 接受
- cc 闲置 30 分钟也不影响（不靠 mtime 验）
- 验活责任 shift 到用户：用户负责"我 /start 看了 list，frontend 真在跑"

✅ 推荐 — 唯一同时解 6 问题的候选。

### 候选 d: paneId-keyed + in-memory sid 反查

设计：daemon 维护 in-memory `paneId → sessionId` map，hook fire 时 update。daemon 入站时反查 map 拿 sid → 写 `<paneId>_<sid>.IMOrigin`。

代码改动：~500 LOC + ~300 测试

问题：daemon 重启后 map 丢失：
- 用户从 IM 发 `@frontend hello` → daemon 反查 map：empty → 没 sid → 写不出 IMOrigin
- 用户体验：daemon 重启后第一条 IM 静默失败，要等 cc 自主 fire 一次 hook 才 rebuild map → race / hang
- 解：daemon 启动时 cold-bootstrap map（扫 state/ 已有文件提取 sid）—— 但等于把 SessionStart 文件加回来

❌ 排除 — 用 in-memory state 解决跨进程协调是 anti-pattern。

### 候选 e: paneId-keyed 但保留 SessionStart

设计：file key 用 paneId（解 P2 / P4 / P6），但保留 SessionStart 给 PaneAlive 用 PID + lstart 验活（解 P3 不接受用户`/start` 视角验活）。

代码改动：~500 LOC + ~300 测试

问题：保留 PaneAlive 多信号 = 保留 SessionStart hook = state 文件类型 ≥7 + cc settings.json 仍 4 hook。**只解决了一半问题**。

❌ 排除 — 既然用户接受不验活的 UX trade-off，PaneAlive 没必要保留。

---

## 4. 对比矩阵

| 候选 | P1 | P2 | P3 | P4 | P5 | P6 | LOC 改 | state 文件类型 | cc hook 数 | 反悔成本 |
|---|---|---|---|---|---|---|---|---|---|---|
| a 维持现状 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 0 | 9 种 | 4 | — |
| b 瘦 SessionStart | △ | ✗ | ✗ | ✗ | ✗ | ✗ | ~150 | 9 种 | 4 | 低 |
| **c paneId-keyed full** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** | **~1500** | **6 种** | **2** | **高** |
| d paneId-keyed + map | ✓ | △ | ✗ | △ | ✗ | △ | ~500 | 8 种 | 3 | 中 |
| e paneId-keyed 保 SessionStart | ✓ | ✓ | ✗ | ✓ | ✓ | △ | ~700 | 8 种 | 3 | 中 |

注：△ = 部分解决；P5（IMReplyContext imType）独立于 paneId-keyed 改动，所有候选都可以加，但只在 c 里跟其他改动一起 ship 才合算。

---

## 5. 推荐方案 c — 完整设计

### 5.1 文件命名约定

| 文件 | 写入者 | filter 证据 | 命名 |
|---|---|---|---|
| `<paneId>_<sid>.Stop.<ts>` | cc Stop hook | ✓ 双 key（hook payload + WEZTERM_PANE）| `15_a1b2c3d4-...Stop.2026-05-08T12-00-00-000Z` |
| `<paneId>_<sid>.PermissionRequest.<id>.json` | cc PreToolUse hook | ✓ 双 key | `15_a1b2c3d4-...PermissionRequest.deadbeef.json` |
| `<paneId>_<sid>.PermissionResponse.<id>.json` | daemon | (从 Request 文件名 copy 双 key) | 同上 |
| `<paneId>.IMOrigin` | daemon 入站 | (daemon 写不需 filter) | `15.IMOrigin` |
| `IMWork` | daemon | 全局，**不变** | — |
| `daemon.pid` | daemon | 全局，**不变** | — |
| `wechat-cursor` | daemon | 全局，**不变** | — |

**filter 证据原理**：`<paneId>_<sid>.<事件>` 这个格式只可能由 hook subprocess 创建：
- `paneId` 来自 `process.env.WEZTERM_PANE` —— 只有 wezterm 启动的进程链才有
- `sid` 来自 `payload.session_id` —— hook payload 是 cc 给 hook 的真值

vim claude.md / ssh 远端 cc / VS Code terminal cc / 任何非 wezterm 启动的 cc 都造不出这个格式：
- 不在 wezterm = 没 WEZTERM_PANE → hook 写不了（silently exit）
- 不是 cc = 不会 fire cc hook = hook subprocess 不存在
- vim 模拟 hook = 也能伪造文件名，但 vim 不在 cc hook 协议链里 → 没机会触发

**filter 是命名格式本身，零推断零验活**。

### 5.2 IMReplyContext schema (shared 包改 union)

```typescript
// packages/shared/src/adapter/im.ts

// 当前
export type ReplyContext = unknown;

// 改后（discriminated union）
export type ReplyContext =
  | { imType: 'wechat'; to: string; contextToken: string }
  | { imType: 'telegram'; chatId: number; messageId: number }   // 预留
  | { imType: 'lark'; openId: string; chatId: string };          // 预留
```

各 IM adapter 的 `send(content, ctx)` 用 `ctx.imType` discriminator 触发自身实现：

```typescript
// daemon orchestrator outbound:
const ctx = await readIMOrigin(paneId);   // 已 zod-validated
switch (ctx.imType) {
  case 'wechat': return wechatAdapter.send(content, ctx);
  case 'telegram': return tgAdapter.send(content, ctx);
  case 'lark': return larkAdapter.send(content, ctx);
}
```

shared 包提供 zod schema 给 storage 层验证（防 disk 文件 corruption）。

### 5.3 hook 行为

```typescript
// packages/cli-cc/src/hook-receiver.ts 入口

const paneId = process.env.WEZTERM_PANE;
if (!paneId) {
  // cc 不在 wezterm（ssh / VS Code terminal / 直接 spawn / etc.）
  // multi-cc-im 不管它，silently exit
  return;
}

const sid = payload.session_id;

switch (payload.hook_event_name) {
  case 'PreToolUse':
    // 4 short-circuit guard:
    // E1 read-only tool → emit allow exit
    // E2 !IMWork → emit ask exit
    // E3 !<paneId>.IMOrigin → emit ask exit
    // E4 !daemon alive → emit ask exit
    // 否则: write <paneId>_<sid>.PermissionRequest.<id>.json
    //       poll <paneId>_<sid>.PermissionResponse.<id>.json (10s)
    //       emit decision
    break;
  case 'Stop':
    // 3 short-circuit guard (E1-E3, mirror PreToolUse):
    // !IMWork / !<paneId>.IMOrigin / !daemon alive → return void
    // 否则: write <paneId>_<sid>.Stop.<ts>
    //       check stop_hook_active && popInjection (idle wakeup)
    break;
  // SessionStart / SessionEnd cases 删除
}
```

**cc settings.json 只剩 PreToolUse + Stop 2 hook**（删 SessionStart + SessionEnd）。

### 5.4 daemon 行为

#### 入站（不验活）

```typescript
async function handleInbound(msg: IncomingMessage) {
  // 1. router parse → mention "frontend"
  const tabName = parsed.mentions[0];

  // 2. wezterm cli list 直接拿当前 panes
  const panes = await opts.termAdapter.listPanes();
  const matches = panes.filter(p => p.title === tabName);

  if (matches.length === 0) {
    return imAdapter.send(`❌ ${tabName} 不存在。当前 tabs: ${...}`, msg.replyCtx);
  }
  if (matches.length > 1) {
    return imAdapter.send(`❌ ${tabName} 同名歧义，请把其中一个 /rename`, msg.replyCtx);
  }

  const paneId = matches[0].pane_id;

  // 3. 不验活，信任 user `/start` 看了 list 的认知
  await writeIMOrigin(paneId, msg.replyCtx);   // 含 imType discriminator
  await termAdapter.sendText(paneId, msg.body);
  await sleep(300);
  await termAdapter.sendKeystroke(paneId, '\r');
}
```

#### 出站

```typescript
chokidar add(`<paneId>_<sid>.Stop.<ts>`):
  const { paneId, sid, timestamp } = parseStopFilename(filename);
  const ctx = await readIMOrigin(paneId);
  if (!ctx) return; // shouldn't happen — hook E2 already short-circuited
  
  switch (ctx.imType) {
    case 'wechat': await wechatAdapter.send(content, ctx); break;
    case 'telegram': ...
    case 'lark': ...
  }
  await deleteIMOrigin(paneId);    // one-shot
  await deleteFile(filename);
```

#### `/start` echo

```
✓ IMWork ON

当前可用 cc sessions:
  1. frontend (pane 15)
  2. api (pane 22)
  3. (pane 28, 未 /rename)         ← 没改名的 cc 显示 paneId

⚠️ 规则：
  - 路由用 wezterm tab title (cc /rename 设的)
  - cc 调工具 IM 收到 prompt，10 秒内 /1 (允许) /2 (拒绝)
  - 超过 10 秒默认放行
  - 终端 cc TUI 直接打字不会 forward IM
```

`@multi-cc-im /list` 同 `/start` 第一段（不含规则提示）。

### 5.5 状态归约：删除的概念

| 删除 | 替代 |
|---|---|
| `<sid>.SessionStart` 文件 | wezterm cli list 实时拿 paneId / cc 不需要 PID 验活 |
| `<sid>.SessionEnd` 文件 | wezterm cli list 看 tab 没了即 cc 死了 |
| SessionStart hook | 不订阅 |
| SessionEnd hook | 不订阅 |
| `bridge/session-registry.ts` 整个模块 | wezterm cli list 直接给 SessionInfo |
| `term-wezterm/pane-alive.ts` 复杂逻辑 | wezterm cli list 看 tab title 即可（不验活）|
| router `@$<sid>` 寻址路径 | 强制 /rename / 用户 IM 路由用 tab title |
| `pendingReplyCtxBySession` Map（PR #56 已删）| 不变 |
| daemon 内 `sessionId` 概念 | daemon 只关心 paneId，sid 是文件名透明字段 |
| `transcript_path` 字段 | 删（dead code，未来 analytics 实施时按 sid 直接拼 cc transcript 路径）|
| `cwd` 字段 in SessionStart | 删（user-facing display 改用 wezterm cli list 给的 cwd 字段）|

### 5.6 PaneAlive 弱化

完全去掉 PaneAlive 的精细验活。daemon dispatch 前**唯一**检查：
- wezterm cli list 看 paneId 在 + tab title 一致

不验：cc 进程是否真在跑（`ps -t <tty>` 找 claude）/ PID 复用 / lstart 一致。

corner case 接受：
- 用户 /start 后 cc 死了 → daemon 盲注入 zsh → 用户从 IM 没收到 cc 回复 → 自己进 cc TUI 看 → 重启 cc + IM 重发
- 用户改了 wezterm tab title 但 pane 里不是 cc → 同上盲注入

### 5.7 state-sweep 重写

```typescript
async function sweep(stateDir: string) {
  // 1. 当前 wezterm 活的 paneId 集合（ground truth）
  const activePaneIds = new Set((await wezterm.listPanes()).map(p => String(p.pane_id)));

  // 2. 扫 state/ 所有文件
  for (const file of await readdir(stateDir)) {
    // 全局文件不动
    if (file === 'IMWork') continue;
    if (file === 'daemon.pid') continue;
    if (file === 'wechat-cursor') continue;

    // 提取 paneId 前缀 (`15_xxx.foo` 或 `15.IMOrigin`)
    const m = file.match(/^(\d+)[._]/);
    if (!m) continue; // 不识别的文件不动
    const paneId = m[1];

    // paneId 不在活集合 → cc 已经从 wezterm 消失，文件无主，删
    if (!activePaneIds.has(paneId)) {
      await unlink(join(stateDir, file));
    }
  }
}
```

`multi-cc-im cleanup` 命令同样逻辑，daemon 跑着的时候跑也安全（活的 paneId 文件不会被清）。

---

## 6. 跟 PR #58 协议的兼容性

**不兼容** —— 是故意的破坏性变更：

- 删 SessionStart / SessionEnd 文件 + hook
- IMOrigin / Permission 文件 key 改名（sessionId-prefixed → paneId-prefixed）
- IMReplyContext schema 改成 union（加 imType field）
- daemon stateDir 内已有的 v1.3 文件**不能**被新 daemon 识别

**迁移路径**：

1. 实施 PR 内 daemon start 第一阶段 sweep：删所有 v1.3 残留文件（SessionStart / SessionEnd / `<sid>.IMOrigin` / `<sid>.PermissionRequest/Response` —— 任何不带 `<paneId>_` 或 `<paneId>.` 前缀的 sid-keyed 文件）
2. setup-hooks 改写 cc settings.json：删 SessionStart + SessionEnd hook，PreToolUse + Stop hook 命令不变（`./bin/multi-cc-im hook PreToolUse` 等）
3. 用户首次升级跑 setup-hooks → 4 hook 减为 2 hook + 路径不变
4. README 加 migration note：「v1.4 daemon start sweep 会清掉 v1.3 残留 state 文件，无操作必要 / 无数据丢失（state 不存对话内容）」

破坏性 OK 是因为：
- state 不存对话内容（cc transcript jsonl 是 source of truth）
- 升级后旧 cc session 自然在新 hook 协议下重新 fire 文件
- 单 owner / 单机器约束 → 没多 instance 协调问题

---

## 7. 实施 plan（DD 锁定后单 PR ship）

### 文件改动估算

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/shared/src/adapter/im.ts` | ReplyContext `unknown` → discriminated union + zod schema | ~30 |
| `packages/cli-cc/src/state-files.ts` | 删 SessionStart/End helpers + 改 file-name 函数 (paneId-prefix + paneId_sid-prefix) + 加 imType-typed IMOrigin | -200 / +120 |
| `packages/cli-cc/src/hook-receiver.ts` | 入口加 WEZTERM_PANE filter + 删 SessionStart/SessionEnd cases | -100 / +30 |
| `packages/cli-cc/src/payloads.ts` | 删 SessionStart + SessionEnd schema | -60 |
| `packages/cli-cc/src/adapter.ts` | classify 改为按 paneId 前缀分组、删 SessionStart/End dispatch | -80 / +40 |
| `packages/cli-cc/src/index.ts` | exports 调整 | ~20 |
| `packages/bridge/src/session-registry.ts` | **整个删** | -120 |
| `packages/bridge/src/orchestrator.ts` | 改 file-key、删 sid 概念、入站不验活、出站按 imType discriminator switch | -100 / +80 |
| `packages/bridge/src/router.ts` | 删 `@$<sid>` 寻址 + matcher 改在 wezterm tab list 上跑 | -50 / +30 |
| `packages/bridge/src/matcher.ts` | SessionInfo 不再有 sessionId，改 paneId | ~20 |
| `packages/term-wezterm/src/pane-alive.ts` | **整个删**（daemon 不验活）或保留极简 stub（仅 wezterm cli list 看 tab 在）| -50 / +20 |
| `packages/term-wezterm/src/adapter.ts` | 加 `listPanes()` capability（如果 termAdapter 接口还没暴露 wezterm cli list 数据 —— 让我确认） | ~30 |
| `packages/im-wechat/src/adapter.ts` | send() 接 imType:wechat 类型 ctx | ~10 |
| `apps/multi-cc-im/src/setup-hooks.ts` | 4 hook → 2 hook | -30 |
| `apps/multi-cc-im/src/state-sweep.ts` | 重写按 wezterm paneId 集合 | -150 / +80 |
| `apps/multi-cc-im/src/start.ts` | banner 调整、初始 sweep 删 v1.3 残留 | ~20 |
| **测试** | state-files / hook-receiver / orchestrator / router / matcher / state-sweep / start / hook 全改造 | ~600 |
| **文档** | CLAUDE.md 假设表 / README 全改 / docs/architecture.md state files 重画 / docs/dev.md 调试节 | ~150 |
| **合计** | — | **~1700 行净改 / ~800 LOC 净增** |

### 测试覆盖目标 (~+30 个新测试)

- `<paneId>_<sid>.<event>` 文件名 parser/builder roundtrip (5 cases)
- WEZTERM_PANE 未定义 hook silently exit (2 cases — PreToolUse / Stop)
- IMReplyContext discriminated union zod parse 各 imType (3 cases)
- daemon outbound switch(ctx.imType) 路由各 adapter (3 cases)
- 入站不验活（盲注入 zsh 用户接受 corner）+ tab 不存在 / 同名歧义 (4 cases)
- state-sweep 按 wezterm paneId 集合清 (5 cases)
- hook decision tree 4 步在新 paneId-keyed 下仍 work (修原有 ~10 测试)
- migration: daemon start sweep 删 v1.3 残留文件 (3 cases)

---

## 8. 锁定后动作

DD merge 后：

1. 在 [CLAUDE.md「关键设计假设」表](../../../CLAUDE.md) 加新行 「state 文件 paneId-keyed (废 SessionStart/SessionEnd)」+ 改 IMReplyContext 行加 imType discriminator，链回本 DD
2. 修 [docs/architecture.md](../architecture.md) "数据存储" 节 — state 文件清单全改
3. 修 [README.md](../../../README.md) "State files reference" 节 — 命名约定改、删 SessionStart/SessionEnd、加 imType 字段
4. 修 [README.zh-CN.md](../../../README.zh-CN.md) 同步
5. 实施 PR 单 commit（per CLAUDE.md "彻底解决，禁止补丁"）

---

## 9. 用户决策点

请最后确认（DD merge 之前）：

1. ✅ 走候选 c（paneId-keyed full + 删 SessionStart/SessionEnd + 入站不验活 + IMReplyContext imType discriminator）
2. ✅ 文件命名 `<paneId>_<sid>.<event>` 双 key (cc-hook-写) + `<paneId>.IMOrigin` 单 key (daemon-写)
3. ✅ daemon 入站不验活，信任用户从 `/start` list 的认知；corner case (cc 中途死) 接受盲注入 zsh
4. ✅ cc settings.json 减到 2 hook (PreToolUse + Stop)，删 SessionStart + SessionEnd
5. ✅ 删 router `@$<sid>` 寻址路径，强制用户 /rename 才能 IM 路由 (没 /rename 用 paneId 兜底 `@$15` ?)
6. ✅ WEZTERM_PANE 未定义时 hook silently exit (cc 不在 wezterm = multi-cc-im 不管)
7. ✅ state-sweep 用 wezterm cli list 当前 paneId 集合作 ground truth
8. ✅ per-pane IMOrigin 保留（多 cc 同时 IM 对话需要）

唯一未拍：第 5 点 `@$<sid>` 寻址替代物 — 删掉强制 /rename / 还是保留 `@$<paneId>` (paneId 兜底)？

确认后 DD merge → 实施 PR ship。
