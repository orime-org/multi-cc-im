# IMWork + IMOrigin + read-only 白名单 + reaper DD 报告

**Topic**: PR #53 ([DD: permission forward](2026-05-07-permission-forward-dd.md)) 实施后真集成实测发现 4 个 UX / 资源问题。需要重新设计 hook PreToolUse 决策路径，让 daemon ↔ hook subprocess 文件 IPC 能区分「IM 远程模式 vs 本地 TUI 模式」+「per-session 是否绑定过 IM 对话」+「工具是否需要审批」。
**Scope**: hook PreToolUse 分支重写；daemon orchestrator 增加 IMWork / IMOrigin 写删时机；router 增加 `/start` `/stop` 命令；state-files 增加 IMWork + IMOrigin 文件；state-sweep 扩展；read-only 工具白名单。**不涉及** cc 协议层、IM 协议层、term adapter。
**Date**: 2026-05-08
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 是 PR #53 上线后真集成发现假设漏洞的补救。memory rule "对接 upstream schema 必须 fetch 官方 docs + 真集成跑通" — PR #53 没真集成实测就 ship，结果用户碰到 4 个具体问题。本 DD 重新基于实测事实尽调候选。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **e. IMWork (大开关) + IMOrigin (per-session ctx, B2 覆盖, Stop 删) + read-only 白名单 + 10s timeout + daemon reaper + IM `/start` `/stop`** | ✅ **推荐** |
| a. 维持现状（PR-D 当前实施） | ❌ 排除 — P1/P2/P3/P4 全部不解决 |
| b. 仅 read-only 白名单 | ❌ 排除 — 仅解 P1，P2/P3/P4 仍存 |
| c. 仅 IMOrigin（auto only，无全局开关）| ❌ 排除 — P3 不能彻底解（cc 自主行为 + 用户从未跟该 cc 对话过的场景断） |
| d. 仅 IMWork（manual only，无 per-session）| ❌ 排除 — 失去 thread 自然性，多 cc 时 ctx 锚点共用单一 IMWork ctx 体验差 |
| f. 改用 cc `--permission-prompt-tool` MCP 路径 | ❌ 排除 — DD #51 已永久排除（工程量 3-4×、跨设计 + 跟现有 hook + file IPC 重复）|

---

## 1. 问题陈述

### P1. read-only 工具被 forward IM 干扰

cc 协议事实：**所有工具调用都 fire PreToolUse hook**（含 Read / Grep / Glob / NotebookRead 这种 read-only 工具）。当前 PR-D 实施不分工具类型，全部走 forward IM 路径。结果：

- cc 一次代码探索可能调 30+ 次 Read / Grep → IM 端被刷屏 30+ 条「准备跑工具: Read(...)」
- 用户回 `/1` 也无意义（cc 对 read-only 工具本来就不弹 TUI menu，hook timeout default-allow 结果一样）
- IM 通知噪音掩盖真正需要审批的危险操作（Bash(rm) / Edit / Write）

**实测证据**: 用户提供 `state/d439e758...PermissionRequest.8ec7854b.json` 内容是 `{"toolName": "Read", "toolInput": {"file_path": "...", "offset": 20, "limit": 40}}` —— 这条 IM 推送毫无价值。

### P2. 没 wechat origin 时浪费 30s + cc TUI hang

当前 PR-D 实施：

```
hook 写 Request → daemon 看 pendingReplyCtxBySession 没该 sid → log "no wechat origin" + skip forward
hook poll 30s → timeout → emit allow + cleanup
```

后果：
- 每次 PreToolUse 都让 hook subprocess 跑满 30s 才退（资源浪费 — cc 跑 50 个工具 = 50 个 hook subprocess 各 hang 30s）
- cc TUI 在 hook running 期间 **hang**（cc docs: hook is blocking, no menu shown until hook returns）
- 用户在公司面对 cc TUI，看不到原生 3 选项菜单，被迫等 30s 后默认放行

**实测证据**: daemon log 多条 `[PreToolUse 14f0a1c5] no wechat origin — IM permission gate skipped (hook will default-allow after 30s)`，每条都阻塞 cc 30s。

### P3. 没有"用户当前是否在远程"的明确信号

当前 PR-D 凭 `pendingReplyCtxBySession`（in-memory，per-session）判断是否 forward IM。但实际场景：

- **场景 A**: 用户出门前打开 IM 模式，希望 cc 自主跑工具时也 forward IM（即使没人当前对话） → 当前实施做不到（没 IMOrigin → daemon skip）
- **场景 B**: 用户从 IM 发完 prompt 立刻坐回办公室，cc 还在跑 → 这一轮 PreToolUse 仍 forward IM（IMOrigin 还在），用户想用键盘选 → 没法切回本地模式
- **场景 C**: 用户下班用 IM，cc 跑代码隔几小时返工自主跑工具 → 没 wechat origin → cc 自主行为静默 → 用户在外面收不到提示

需要一个**用户主动控制的全局开关** + **per-session 自动 ctx 追踪**两层组合。

### P4. hook subprocess 异常死亡留下孤儿文件

PR-D 设计：hook subprocess 自己负责 cleanup（写 Request → poll Response → emit decision → unlink Request + Response → exit）。但实测发现孤儿文件累积：

**实测证据**: 用户 daemon 跑着的状态下 `ls state/ | grep Permission` 看到 5+ 个 PermissionRequest 文件，最早时间戳几小时前 —— 远超 30s timeout 应该自清理的窗口。

原因：hook subprocess 在 30s timeout 之前被异常 kill（cc 退出 / wezterm tab 关 / OOM / 用户 Ctrl+C cc）→ cleanup 没跑完 → 文件留下。daemon 当前**只在启动时**扫孤儿（state-sweep），运行期间不主动清。

---

## 2. 候选枚举

| # | 候选 | 解决的问题 |
|---|---|---|
| a | 维持现状不动（PR-D 当前实施） | 无 |
| b | 仅 read-only 白名单 | P1 |
| c | 仅 IMOrigin（自动 wechat origin 判断 + 物化磁盘）+ b | P1, P2 |
| d | 仅 IMWork（手动全局开关 + 物化磁盘）+ b | P1, P2 |
| **e** | **IMWork + IMOrigin 组合 + b + reaper + 10s timeout + IM `/start` `/stop`** | **P1, P2, P3, P4 全部** |
| f | 改用 cc `--permission-prompt-tool` MCP 路径 | 跨设计，重新选型 |

---

## 3. 每候选尽调

### 候选 a: 维持现状

代码改动：**0**
解决问题：**0/4**
风险：现有问题持续累积，用户实测已抱怨。

❌ **排除** —— 不动等于接受 4 个真实痛点。

### 候选 b: 仅 read-only 白名单

设计：

```
const READ_ONLY_TOOL_NAMES = ['Read', 'Grep', 'Glob', 'NotebookRead'];

hook PreToolUse:
  if toolName in READ_ONLY_TOOL_NAMES:
    emit { permissionDecision: 'allow', reason: 'read-only tool, auto-allow' }
    exit (不写 Request)
  ... rest 走 PR-D
```

代码改动：~30 LOC（hook-receiver.ts + tests）
解决问题：**P1 only**
P2/P3/P4 仍存。

风险：
- cc 加新 read-only 工具或 plugin 加新 read-only 工具时白名单要更新（但漏 forward 比误 forward 安全 — 漏了 read-only 工具走 PR-D forward，用户被打扰但不漏审批）
- Bash 工具内的 read-only 命令（`ls / cat / grep` 等）仍 forward IM（cc 内部判断 read-only 的 Bash 命令名单不公开，无法精确复刻 — 接受）

❌ **排除** —— 解决了 P1 但 P2/P3/P4 是更大的痛点（30s 浪费 + 用户体验断），仅修 P1 不能 ship。

### 候选 c: 仅 IMOrigin（无全局开关）

设计：

```
state/<sid>.IMOrigin (内容 = IMReplyContext JSON)
  daemon handleInbound → write/overwrite (B2)
  daemon handleStop forward 完 → delete
  daemon start sweep → delete all
  
hook PreToolUse:
  if toolName in READ_ONLY_TOOL_NAMES: allow
  if !<sid>.IMOrigin: emit ask (TUI 接管)
  else: 走 PR-D
```

代码改动：~150 LOC
解决问题：**P1 + P2** + 部分 **P4**（hook 不再写 Request 时不会留孤儿）

P3 三场景：
- 场景 A（cc 自主行为也要 forward IM）：✗ 没 IMOrigin → emit ask → TUI 在外面没人按
- 场景 B（用户回到办公室想切本地）：✗ 必须等 cc Stop 一轮才会删 IMOrigin
- 场景 C（cc 长时跑工具被打扰）：✓ 间接解（cc Stop 后 IMOrigin 删）

风险：用户出门前没法主动开 IM 模式 — 必须先从 IM 发一条消息建立 IMOrigin，但 cc 已经在跑没机会 dispatch。

❌ **排除** —— P3 场景 A 是真实需求（用户出差前希望 cc 跑代码遇到 PreToolUse 也 forward），c 解决不了。

### 候选 d: 仅 IMWork（无 per-session ctx）

设计：

```
state/IMWork (内容 = IMReplyContext JSON，/start 那条消息的 ctx)
  daemon /start → write
  daemon /stop → delete
  daemon start → delete
  
hook PreToolUse:
  if toolName in READ_ONLY_TOOL_NAMES: allow
  if !IMWork: emit ask (TUI 接管)
  else: 走 PR-D
  
daemon handleStop forward → 用 IMWork ctx
```

代码改动：~120 LOC
解决问题：**P1 + P2 + P3-A + P4**

但失去 per-session thread 自然性：
- 用户从 IM 发 `@frontend hello` + `@api hello`（不同 cc）→ cc 各自回复都 reply 同一个 IMWork ctx → IM 端两条 cc 回复混在同一 thread 难分辨
- 多 cc 场景 UX 退化

风险：在 v1 阶段 cc 数量少（用户实测 1-3 个 cc），可能可接受。但项目设计目标是支持多 cc，d 跟设计目标冲突。

❌ **排除** —— per-session ctx 是项目核心价值（routing G' DD），不能为简化牺牲。

### 候选 e: IMWork + IMOrigin 组合 + read-only 白名单 + reaper + 10s timeout（推荐）

完整设计见第 5 节。

代码改动：~300 LOC（4 packages: cli-cc, bridge, state-files, apps）
解决问题：**P1 + P2 + P3 + P4**（全部）

风险：
- 状态空间扩展（IMWork × IMOrigin × read-only），测试组合需覆盖
- 用户多了一个 mental model（"我现在是不是 IM 模式"）— 但通过 daemon stderr banner + IM /start echo + ask reason 三处显式提示降低认知负担
- IMReplyContext schema 必须可序列化（zod parse + 落 JSON）— 当前 wechat ctx 已经能 JSON.stringify，未来 tg / 飞书 ctx 设计时按此约束即可

✅ **推荐** —— 唯一覆盖全部 4 问题的候选；实施代价中等；跟项目设计 (per-session routing + adapter 可扩展) 对齐。

### 候选 f: 改用 cc `--permission-prompt-tool` MCP 路径

DD #51 已永久排除：工程量 3-4×（要起 MCP server 进程 + 实现 MCP 协议层）+ 跟现有 hook + file IPC 路径重复 + 反悔成本高。

❌ **排除** —— DD #51 已结论。

---

## 4. 对比矩阵

| 候选 | P1 | P2 | P3-A | P3-B | P3-C | P4 | LOC | 测试组合 | 跨包数 | 反悔成本 |
|---|---|---|---|---|---|---|---|---|---|---|
| a 维持现状 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 0 | 0 | 0 | — |
| b 只 read-only | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ~30 | +5 | 1 | 低 |
| c 只 IMOrigin + b | ✓ | ✓ | ✗ | ✗ | ✓ | △ | ~150 | +20 | 3 | 中 |
| d 只 IMWork + b | ✓ | ✓ | ✓ | △ | ✓ | △ | ~120 | +18 | 2 | 中 |
| **e 组合 + reaper + 10s** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** | **~300** | **+35** | **4** | **中** |
| f MCP 路径 | n/a | n/a | n/a | n/a | n/a | n/a | ~1000 | +60 | 5+ | 高 |

注：
- P3-A: 用户出门前 IM 模式期望 cc 自主行为也 forward
- P3-B: 用户回办公室想切回本地模式
- P3-C: cc 长跑期间 IMOrigin 没及时清 → 用户被 stale ctx 打扰
- P4: hook subprocess 异常死亡留孤儿；△ = 缓解不彻底（仅 daemon 启动 sweep）；✓ = 彻底（运行期 reaper）
- 反悔成本：候选 e 大部分是新增文件 + 新增分支，不破坏现有 PR #53 协议（IMOrigin 写时机、PermissionRequest schema 不变）

---

## 5. 推荐方案 e — 完整设计

### 5.1 文件结构（state/ 新增 2 类）

```
~/.multi-cc-im/state/
├── IMWork                              # 0-byte tombstone
│                                       #   存在 = IM mode
│                                       #   不存在 = local mode
├── <sid>.IMOrigin                      # 内容 = IMReplyContext JSON
│                                       #   每次 IM dispatch 覆盖（B2）
│                                       #   cc Stop forward 完即删
│                                       #   daemon start sweep
├── <sid>.SessionStart                  # (现有)
├── <sid>.Stop.<ts>                     # (现有)
├── <sid>.SessionEnd                    # (现有)
├── <sid>.PermissionRequest.<id>.json   # (现有)
├── <sid>.PermissionResponse.<id>.json  # (现有)
└── wechat-cursor                       # (现有)
```

### 5.2 hook PreToolUse 完整决策

```
const READ_ONLY_TOOL_NAMES = ['Read', 'Grep', 'Glob', 'NotebookRead'];
const PERMISSION_POLL_INTERVAL_MS = 200;
const PERMISSION_TIMEOUT_MS = 10_000;   // 10 秒（PR-D 旧值 30 秒）

hook PreToolUse:
  if toolName in READ_ONLY_TOOL_NAMES:
    emit { permissionDecision: 'allow', reason: '[multi-cc-im] read-only tool, auto-allow' }
    exit
  if !file_exists(IMWork):
    emit { permissionDecision: 'ask', reason: '[multi-cc-im] local mode' }
    exit
  if !file_exists(<sid>.IMOrigin):
    emit { permissionDecision: 'ask', reason: '[multi-cc-im] no IM thread for this cc' }
    exit
  // 写 PermissionRequest + poll PermissionResponse 10s
  // (走原 PR-D 流程，超时变成 default-allow)
```

### 5.3 daemon 行为

```
handleInbound (IM 入站):
  if !file_exists(IMWork):
    echo IM "❌ IMWork off — 请先发 @multi-cc-im /start 开启 IM 模式"
    skip dispatch
  else:
    write/overwrite <sid>.IMOrigin with msg.replyCtx (B2)
    dispatch normally

handleStop (cc → IM forward):
  if !file_exists(IMWork):                        # 大开关 — 关了完全静默
    skip
  ctx = readIMOrigin(<sid>)
  if ctx:
    forward IM (用 ctx)
    delete <sid>.IMOrigin                          # one-shot 删
  else:
    skip                                            # 没 ctx 锚点，不发

handlePermissionResponseFromIM (IM 回 /1 /2):
  (现有逻辑不变 — write Response file)

router 新增 bridge command:
  @multi-cc-im /start:
    if file_exists(IMWork): echo "ℹ️ IMWork already ON"
    else:
      create empty IMWork file
      echo (见 5.5 文案)
  @multi-cc-im /stop:
    if !file_exists(IMWork): echo "ℹ️ IMWork already OFF"
    else:
      delete IMWork
      echo "✓ IMWork OFF — cc 工具问题在终端 TUI 处理"

daemon start (apps/multi-cc-im/src/start.ts):
  delete IMWork                                    # 重启回到 local mode
  sweep all <sid>.IMOrigin                          # 一致性 reset
  stderr banner: "  ✓ IMWork: OFF (run @multi-cc-im /start from IM to enable)"

daemon reaper (新增 — 解决 P4):
  chokidar add(<sid>.PermissionRequest.<id>.json) →
    handle (forward IM 或 IMWork off skip)
    setTimeout(10s, () => {
      unlinkOrIgnoreENOENT(<sid>.PermissionRequest.<id>.json);
      unlinkOrIgnoreENOENT(<sid>.PermissionResponse.<id>.json);
    })
  // hook 正常 cleanup → reaper 跑到时 ENOENT 静默
  // hook 异常死亡 → reaper 兜底删
```

### 5.4 cleanup 命令（A 方案 — 不动 IMWork）

```
multi-cc-im cleanup:
  - 不动 IMWork（保留运行时状态，不让 cleanup 副作用关掉用户的 IM 模式）
  - 清 <sid>.IMOrigin where SessionEnd 存在（cc 已死的 session）
  - (现有清理路径不变)
```

理由：cleanup 是用户**主动整理**的命令，不该有副作用改运行时状态。daemon start 才是"重置一切"。

### 5.5 控制台提示文案（4 处）

**A. daemon 启动 stderr banner**:
```
multi-cc-im start (root: ~/.multi-cc-im)
  ✓ wechat credentials at ...
  ✓ wezterm at ...
  ✓ IMWork: OFF (run @multi-cc-im /start from IM to enable)
  ✓ orchestrator started
```

**B. cc TUI ask 菜单上方（hook reason）**:
- `[multi-cc-im] read-only tool, auto-allow` (read-only 工具，不显示菜单 cc 自动放行)
- `[multi-cc-im] local mode` (IMWork off)
- `[multi-cc-im] no IM thread for this cc` (IMWork on 但没 IMOrigin)

**C. IM `/start` echo**:
```
✓ IMWork ON

当前可用 cc sessions:
  1. frontend (pane 10)
  2. api (pane 20)
  3. $aabb1234 (pane 30, 未 /rename)

⚠️ 规则：
  - 只处理从 IM 发出的消息
  - cc 调工具时 IM 收到提示，10 秒内回复 /1 (允许) 或 /2 (拒绝)
  - 超过 10 秒默认放行
  - 终端 cc TUI 直接打字的对话不会 forward 到 IM
```

`/stop` echo:
```
✓ IMWork OFF — cc 工具问题在终端 TUI 处理
```

`/start` 已经 ON 时:
```
ℹ️ IMWork already ON

当前可用 cc sessions:
  1. frontend (pane 10)
  ...
```

**D. IM dispatch 在 IMWork off 时 echo**:
```
❌ IMWork off — 请先发 @multi-cc-im /start 开启 IM 模式
```

**E. `@multi-cc-im /current` 扩展**:
```
current = frontend (alive)
IMWork = ON (since 2026-05-08 14:23 UTC)
```
或
```
current = none
IMWork = OFF
```

---

## 6. 跟现有 PR #53 协议的兼容性

- `<sid>.PermissionRequest.<id>.json` schema **不变**（toolName + toolInput + requestId + createdAt）
- `<sid>.PermissionResponse.<id>.json` schema **不变**（requestId + decision + reason）
- hook stdout 协议**不变**（`{ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }`）
- IM 端 `/1` `/2` 命令**不变**（仍由 router parser 识别）

新增项**完全独立**：IMWork 文件、IMOrigin 文件、read-only 白名单、reaper timer、bridge command `/start` `/stop`。

PR #53 已 merge 的代码大部分保留；hook PreToolUse 分支前面新增 3 个 early-return 分支，PR-D 主流程作为**最后一种 fallback**。

---

## 7. 实施 plan（DD 锁定后单 PR ship）

文件改动估算：

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/cli-cc/src/state-files.ts` | 加 IMWork + IMOrigin path/read/write/delete/exists helpers | ~80 |
| `packages/cli-cc/src/hook-receiver.ts` | PreToolUse 分支前置 3 个 early-return | ~30 |
| `packages/cli-cc/src/index.ts` | 导出新 helpers | ~6 |
| `packages/bridge/src/parser.ts` | `@multi-cc-im /start /stop` 加入 bridge_command 识别 | ~5 |
| `packages/bridge/src/router.ts` | handleBridgeCommand 加 start/stop case | ~30 |
| `packages/bridge/src/orchestrator.ts` | handleInbound IMWork 检查 + handleStop IMWork+IMOrigin + reaper + 增加 IM forward 时识别 IMOrigin 的逻辑 | ~80 |
| `apps/multi-cc-im/src/start.ts` | banner 加 IMWork 状态行 + start 时 delete IMWork + sweep IMOrigin | ~15 |
| `apps/multi-cc-im/src/state-sweep.ts` | 加 IMOrigin sweep（A 方案不动 IMWork）| ~25 |
| 测试 | parser / router / orchestrator / hook-receiver / state-files / state-sweep | ~600 |
| 文档 | CLAUDE.md 假设表更新 + README permission gate 节更新 + docs/architecture.md 文件清单更新 | ~50 |
| **合计** | — | **~920** |

测试覆盖目标：
- read-only 白名单 4 个工具 + 1 个非白名单工具 = 5 cases
- IMWork × IMOrigin 4 状态组合 × hook + daemon 双视角 = 8 cases
- read-only × IMWork × IMOrigin = 不会同时触发（read-only 早退），仅需 sanity test
- reaper 正常 / 异常死亡 / 重复 unlink = 3 cases
- /start /stop 重复执行幂等 = 2 cases
- /start echo cc 列表 happy + zero alive = 2 cases
- /start 时 cc 列表中含未 /rename 的 fallback = 1 case
- IMWork on dispatch / off dispatch echo 提示 = 2 cases

合计 **+30~35 个新测试**，全部 vitest 单元 + 集成（mkdtemp 沙盒）。

---

## 8. 锁定后动作

DD merge 后：
1. 在 [CLAUDE.md「关键设计假设」表](../../../CLAUDE.md) 加新行 "IM 模式开关 (IMWork) + per-session IM ctx (IMOrigin) + read-only 白名单"，链回本 DD
2. 在 [docs/architecture.md](../architecture.md) "数据存储" 节加 IMWork / IMOrigin 文件描述
3. 在 [README.md](../../../README.md) "Tool permission gate" 节扩展，说明 `/start /stop` 命令 + 10s 超时 + read-only 自动放行
4. 实施 PR 单 commit（per CLAUDE.md "彻底解决，禁止补丁" — 不拆中间态）

---

## 9. 用户决策点

请确认（DD merge 之前最后一审）：

1. ✅ 大方向 e 候选（IMWork + IMOrigin + read-only 白名单 + 10s + reaper）
2. ✅ read-only 白名单仅含 4 个工具：Read / Grep / Glob / NotebookRead（Bash 即使 read-only 命令也 forward — 接受打扰，避免漏审批）
3. ✅ cleanup A 方案（不动 IMWork）
4. ✅ daemon start 删 IMWork（重置回 local mode，跟 cleanup 不一样）
5. ✅ 控制台提示 5 处文案（A daemon banner / B hook reason / C IM /start echo / D dispatch off echo / E /current 扩展）
6. ✅ 10s timeout + 显式告诉用户「超过 10 秒默认放行」

确认后 DD merge → 实施 PR ship。
