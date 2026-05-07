# Daemon Liveness 检测 DD 报告

**Topic**: hook subprocess（cc 子进程，跟 daemon 不同进程）需要在进入 forward 路径前知道 daemon 是否真的活着。当前 PR #56 缺这层检测 → daemon 崩溃 / Ctrl+C 后 hook 仍走 forward → cc TUI hang 10s + 累积孤儿文件。引入 `state/daemon.pid` 独立 lock file + hook 端 PID + lstart 配对验证，并把 daemon liveness 检查接入 PreToolUse + Stop 两个 hook 的前置 short-circuit 链。
**Scope**: hook PreToolUse + Stop 决策链；daemon start / stop 生命周期写删 daemon.pid + IMWork；state-files 增加 daemon.pid 文件；state-sweep 兜底清理 stale daemon.pid；daemon 双开检测。**不涉及** cc 协议层、IM 协议层、term adapter、IMOrigin / IMWork / read-only 白名单（PR #56 已锁定，不动）。
**Date**: 2026-05-09
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 是 PR #56（IMWork + IMOrigin + reaper）上线后讨论中发现的一个 daemon lifecycle 缺口的补救。memory rule "对接 upstream schema 必须 fetch 官方 docs + 真集成跑通" — PR #56 设计 hook decision tree 时把 daemon "永远活着" 当成隐含假设，实际上 daemon 崩溃 / 手动 Ctrl+C 都会破坏这假设。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **d. 独立 `state/daemon.pid` + `kill -0 + ps -o lstart` 配对验证 + 双开检测** | ✅ **推荐** |
| a. 维持现状（PR #56） | ❌ — 4 个浪费/误判路径全部不解决 |
| b. 塞 daemon info 到 IMWork 文件 | ❌ — 把"用户意图"和"daemon 活性"两个独立维度塞一个文件，语义混叠 |
| c. 独立 daemon.pid + 简化 `kill -0` only（不验 lstart） | ❌ — PID 复用窗口虽窄但用户明确不接受 |
| e. fs.watch / inotify 实时订阅 daemon process 状态 | ❌ — 没有"watch 一个 PID 退出"的标准 fs API；要么轮询，要么用 ptrace（需 root） |
| f. 完全不做 daemon liveness，依赖 hook 10s timeout 自然退化 | ❌ — = 维持现状 a |

---

## 1. 问题陈述

PR #56 实施 hook decision tree 时把 daemon "永远活着" 当成隐含假设。实际生产 4 个独立场景会破坏这假设：

### P1. daemon Ctrl+C 退出后 IMWork 文件留在磁盘

当前 daemon 优雅退出（`Ctrl+C` → orchestrator.stop()）只清 reaperTimers，**不清 IMWork**。后果：

```
1. 用户从 IM 发 @multi-cc-im /start → 写 state/IMWork
2. 用户 Ctrl+C kill daemon (常见 — 想重启 / 升级)
3. IMWork 文件留下
4. 下次 cc 触发 PreToolUse hook → 看 IMWork 存在 → 走 forward 路径
5. daemon 不在了 → 没人写 PermissionResponse → hook poll 10s → timeout default-allow
```

每个 PreToolUse hook 浪费 **10 秒 cc TUI hang**。

### P2. daemon 崩溃（kill -9 / OOM）后 hook 仍走 forward

跟 P1 同样路径，daemon 崩溃比 Ctrl+C 更糟（连 stop() 都没机会跑）。

### P3. daemon 死后 Stop hook 仍写文件 → 状态目录累积

cc 每轮回完都触发 Stop hook → 写 `<sid>.Stop.<ts>` → daemon 死了没人读没人删 → 文件累积。下次 daemon 重启时 sweep 清理（清是清，但累积期间 `ls state/` 一团乱）。

### P4. 用户可能误启动两个 daemon

CLAUDE.md「关键设计假设」表「多机（仅一台）」行明确：iLink getupdates cursor 全局共享，多 daemon 互相吃消息。但当前**没有任何代码强制**：

```bash
./bin/multi-cc-im start    # tab A — daemon 1 跑着
# (用户切走，忘了)
./bin/multi-cc-im start    # tab B — daemon 2 也起来
```

两个 daemon 同时 polling iLink → cursor 竞争 → 用户在 IM 发消息**有时收到有时没收到**，无法 debug 的黑洞。

---

## 2. 候选枚举

| # | 候选 | 解决问题 |
|---|---|---|
| a | 维持现状（不做 liveness 检测） | 无 |
| b | 塞 daemon info 到 IMWork 文件 | P1 P2（但语义混叠）|
| c | 独立 daemon.pid + 简化 `kill -0` only | P1 P2 P3 P4（但 PID 复用风险）|
| **d** | **独立 daemon.pid + `kill -0 + ps -o lstart` 配对验证 + 双开检测** | **P1 P2 P3 P4 全部** |
| e | fs.watch / inotify 订阅 daemon 进程退出 | P1 P2 P3（不做双开）|
| f | 不检测，依赖 hook 10s timeout 自然退化 | = 维持现状 a |

---

## 3. 每候选尽调

### 候选 a: 维持现状

代码改动：0 LOC
解决问题：0/4
风险：4 个真实痛点持续积累。已被用户讨论指出 → 不能 ship 不动。

❌ 排除。

### 候选 b: 塞 daemon info 到 IMWork 文件

设计：

```
state/IMWork 改成 JSON：{ pid, startedAt }
daemon /start → 写 IMWork（含 daemon PID + lstart）
hook 读 IMWork → 检 PID 还活吗？
```

代码改动：~80 LOC + 测试改动 ~200 LOC（IMWork 测试要全改）
解决问题：P1 P2

**核心问题**：把"用户意图开 IM 模式"和"daemon 是否活着"两个独立维度塞一个文件 → 多个 corner case：

- daemon 启动时是不是要写 IMWork？写了 = IMWork ON 跟用户没关系；不写 = 用户原 /start 状态被覆盖
- 用户开 IMWork → daemon 崩溃 → IMWork 文件还在但 PID 死了 → 状态意义？是用户取消了还是 daemon 死了？
- daemon 重启 → 是不是要尊重用户上次的 IMWork 状态？跟 PR #56 锁定的"daemon start 重置 IMWork"冲突

❌ 语义混叠后续维护噩梦。

### 候选 c: 独立 daemon.pid + 简化 `kill -0` only

设计：

```
state/daemon.pid 文件存：{ pid }（只 PID，无 lstart）
hook E0 检查：kill -0 <pid>
  退出码 0 → daemon alive
  非 0 → daemon dead
```

代码改动：~50 LOC + ~150 LOC 测试
解决问题：P1 P2 P3 P4

性能：每次 hook 多一次 syscall（~10μs），可忽略。

**风险：PID 复用**。OS 会回收死进程的 PID 给新进程：

```
周一 10:00  daemon 启动 PID=12345 → 写 daemon.pid
周一 14:00  daemon 崩溃 → PID 12345 释放
周二 09:00  系统某新进程拿到 PID 12345
周二 09:30  hook 读 daemon.pid → kill -0 12345 → 0
            → 误判"daemon 还活" → 走 forward 路径
            → 真 daemon 死了没人读 → hook 10s timeout default-allow
```

PID 复用窗口实测：macOS 默认 PID 上限 99998，需要系统跑 ~10万 个进程才会绕回。**用户 home 目录 daemon 场景下几乎不可能**触发。但用户**明确表态不接受**任何误判风险。

❌ 排除（用户决策）。

### 候选 d: 独立 daemon.pid + `kill -0 + ps -o lstart` 配对验证（推荐）

完整设计见第 5 节。

代码改动：~120 LOC + ~350 LOC 测试
解决问题：P1 P2 P3 P4 全部

性能：每个走 forward 路径的 hook 多一次 spawn ps（~10-30ms）。但因为 hook decision tree 中 daemon 检查在 IMOrigin 检查**之后**，实际触发 spawn ps 的场景极窄（必须 IMWork on + IMOrigin 在 → 才查 daemon）。99% 的 hook 调用走不到第 4 步。

**复用既有基础设施**：项目已有 `packages/cli-cc/src/hook-receiver.ts:74` 的 `defaultCapturePid()` 用了完全一样的 `ps -o lstart=` 逻辑（给 cc SessionStart hook 防 PID 复用）。可以抽 helper 共用。

✅ 推荐 — 唯一同时解 4 问题 + 没 PID 复用风险 + 复用既有基础设施 + 实施代价中等的候选。

### 候选 e: fs.watch / inotify 订阅 daemon 进程退出

设计：hook subprocess 不查 daemon.pid 文件，而是订阅 daemon 进程的退出事件。

实施可能性：

- Node.js / POSIX 没有标准 "watch a PID for exit" API。可用的：
  - `proc/<pid>/status` 文件 watch（Linux only，macOS 没 procfs）
  - ptrace（需 root，且会 attach daemon 影响其行为）
  - 轮询 `kill -0` （= 候选 c/d）

❌ 排除 — 没有标准跨平台 fs.watch 路径，等于退化到候选 c/d。

### 候选 f: 不检测，依赖 hook 10s timeout 退化

= 维持现状 a。❌ 重复排除。

---

## 4. 对比矩阵

| 候选 | P1 | P2 | P3 | P4 | LOC | 测试 LOC | 跨包数 | PID 复用风险 | 反悔成本 |
|---|---|---|---|---|---|---|---|---|---|
| a 维持现状 | ✗ | ✗ | ✗ | ✗ | 0 | 0 | 0 | n/a | — |
| b 塞 IMWork | ✓ | ✓ | ✗ | ✗ | ~80 | ~200 | 3 | ⚠️ 语义混叠 | 高（schema 翻盘）|
| c daemon.pid + kill -0 only | ✓ | ✓ | ✓ | ✓ | ~50 | ~150 | 4 | ⚠️ 窄窗口存在 | 低 |
| **d daemon.pid + kill -0 + ps -o lstart** | **✓** | **✓** | **✓** | **✓** | **~120** | **~350** | **4** | **✓ 防住** | **低** |
| e fs.watch | ✓ | ✓ | ✓ | ✗ | n/a | n/a | n/a | n/a | n/a |
| f = a | ✗ | ✗ | ✗ | ✗ | 0 | 0 | 0 | n/a | — |

---

## 5. 推荐方案 d — 完整设计

### 5.1 文件结构

```
~/.multi-cc-im/state/
├── IMWork                              # (PR #56 已有，不动)
├── daemon.pid                          # ★ 新加
│                                       #   内容 JSON：{ pid: number, startedAt: string }
│                                       #   pid = process.pid（daemon 启动时）
│                                       #   startedAt = `ps -o lstart= -p $pid` 输出 trim()
│                                       #   生命周期：
│                                       #     - daemon start：写
│                                       #     - daemon stop（Ctrl+C / graceful）：删
│                                       #     - daemon start 检测到 stale lock（PID 死或 lstart 不匹配）：覆盖
└── ... (现有 SessionStart/Stop/SessionEnd/PermissionRequest/Response/IMOrigin 不动)
```

### 5.2 daemon 生命周期（apps/multi-cc-im/src/start.ts）

```
daemon start:
  ────── 双开检测（新加） ──────
  if exists(state/daemon.pid):
    read { pid, startedAt }
    actual_lstart = `ps -o lstart= -p ${pid}` 2>/dev/null
    if exit code 0 AND actual_lstart === startedAt:
      ❌ exit 1 + error: "another multi-cc-im daemon already running (PID ${pid}). Stop it first or use \`pkill -f 'multi-cc-im start'\`."
    else:
      ✓ stale lock — daemon 上次崩溃留的，覆盖

  ────── 已有逻辑 ──────
  delete IMWork (auto reset to local mode)
  sweep stale state files

  ────── 新加：写 daemon.pid ──────
  startedAt = `ps -o lstart= -p ${process.pid}`
  write state/daemon.pid = { pid: process.pid, startedAt }

  ────── 已有逻辑 ──────
  build adapters + orchestrator + start

daemon stop（Ctrl+C / SIGTERM / graceful）:
  ────── 已有逻辑 ──────
  await imAdapter.stop()
  await termAdapter.stop()
  await cliAdapter.stop()
  clear reaperTimers

  ────── 新加 ──────
  delete state/IMWork                   # 用户的提议，跟 daemon.pid 一并清
  delete state/daemon.pid

  注意：SIGKILL（kill -9 / OOM）daemon 没机会跑 stop()。
        IMWork + daemon.pid 文件留下来。下次 daemon start：
        - sweep + delete IMWork（已有逻辑）
        - daemon.pid 双开检测识别为 stale lock（PID 死或 lstart 不匹配） → 覆盖
        所以 SIGKILL 的清理交给下次 daemon start，不影响正确性。
```

### 5.3 hook decision tree（packages/cli-cc/src/hook-receiver.ts）

#### PreToolUse（5 步，按 cost 从低到高）

```
1. tool ∈ {Read, Grep, Glob, NotebookRead}:                       # ~0ms (set lookup)
     emit { permissionDecision: "allow", reason: "[multi-cc-im] read-only tool, auto-allow" }
     exit
2. !exists(IMWork):                                                # ~0.1ms (stat)
     emit { permissionDecision: "ask", reason: "[multi-cc-im] local mode" }
     exit
3. !exists(<sid>.IMOrigin):                                        # ~0.1ms (stat)
     emit { permissionDecision: "ask", reason: "[multi-cc-im] no IM thread for this cc" }
     exit
4. !daemon_alive():                                                # ~10-30ms (spawn ps)
     emit { permissionDecision: "ask", reason: "[multi-cc-im] daemon not running" }
     exit
5. (forward path) write Request, poll Response 10s, emit decision
```

#### Stop（6 步，前 3 个 short-circuit guard 跟 PreToolUse 对称）

```
1. !exists(IMWork):                                                # short-circuit
     return void
2. !exists(<sid>.IMOrigin):                                        # short-circuit
     return void
3. !daemon_alive():                                                # short-circuit
     return void
4. sweep stale Stop files + write <sid>.Stop.<ts>
5. !stop_hook_active && popInjection() !== null:                   # idle wakeup
     return { decision: 'block', reason }
6. (default) return void
```

#### SessionStart / SessionEnd（不动）

这两个是 cc lifecycle marker，daemon 重启时需要它们做 sweep 决策（paired = cc 死，lone start = cc 活）。**daemon 死也照写** — 跟 daemon 状态无关。

### 5.4 `daemon_alive()` 实现

```ts
// packages/cli-cc/src/state-files.ts (新加 helper)

export interface DaemonPidFile {
  pid: number;
  startedAt: string;  // `ps -o lstart= -p <pid>` 输出 trim
}

export function daemonPidPath(stateDir: string): string {
  return join(stateDir, 'daemon.pid');
}

export async function writeDaemonPidFile(opts: {
  stateDir: string;
  pid: number;
  startedAt: string;
}): Promise<void> { ... }

export async function readDaemonPidFile(stateDir: string): Promise<DaemonPidFile | null> { ... }

export async function deleteDaemonPidFile(stateDir: string): Promise<void> { ... }

export async function captureProcessLstart(pid: number): Promise<string | null> {
  // 复用 hook-receiver.ts 现有 defaultCapturePid 的 spawn ps 逻辑
  // 返回 trim 后的 lstart 字符串，PID 不存在或 ps 报错时返回 null
}

export async function isDaemonAlive(stateDir: string): Promise<boolean> {
  const file = await readDaemonPidFile(stateDir);
  if (file === null) return false;
  // kill -0 = ESRCH 不存在 / EPERM 权限不够（视为不存在）
  try {
    process.kill(file.pid, 0);  // signal 0 = check existence only
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH' ||
        (err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
  // 配对验证 lstart（防 PID 复用）
  const actualLstart = await captureProcessLstart(file.pid);
  return actualLstart === file.startedAt;
}
```

### 5.5 测试覆盖目标

| 场景 | 测试路径 |
|---|---|
| `writeDaemonPidFile` 写 + `readDaemonPidFile` 读回（roundtrip） | state-files |
| `isDaemonAlive` PID 不存在 → false | state-files |
| `isDaemonAlive` PID 存在 lstart 一致 → true | state-files |
| `isDaemonAlive` PID 存在但 lstart 不匹配（PID 复用模拟）→ false | state-files |
| `isDaemonAlive` 无 daemon.pid 文件 → false | state-files |
| daemon start：双开检测拒绝（已有 PID + 活）→ exit 1 | apps/start |
| daemon start：stale lock 覆盖（PID 死或 lstart 不匹配） | apps/start |
| daemon stop：删除 IMWork + daemon.pid | apps/start |
| hook PreToolUse E4：daemon dead → emit ask | hook-receiver |
| hook PreToolUse E4：daemon alive → 进入 forward 路径 | hook-receiver |
| hook Stop E3：daemon dead → return void（不写 Stop 文件）| hook-receiver |
| hook Stop E3：daemon alive → 写 Stop 文件 | hook-receiver |
| Decision tree 顺序：read-only > IMWork > IMOrigin > daemon | hook-receiver（precedence tests） |
| state-sweep：daemon.pid 孤儿（PID 死）→ 清理 | apps/state-sweep |

### 5.6 控制台提示文案（`daemon start` banner 调整）

```
multi-cc-im start (root: ~/.multi-cc-im)
  ✓ wechat credentials at ...
  ✓ wezterm at ...
  ✓ state sweep: ... cleaned
  ✓ IMWork: OFF (run @multi-cc-im /start from IM to enable)
  ✓ daemon.pid: PID 12345, lstart "Mon May  9 10:00:00 2026"   ← 新加
  ✓ orchestrator started — bridge running. Ctrl+C to stop.
```

双开检测错误信息：

```
multi-cc-im start: another daemon already running.
  PID:    12345
  Start:  Mon May  9 10:00:00 2026
  Stop:   pkill -f 'multi-cc-im start'   (or kill 12345)

If you're sure no daemon is running, the lock file may be stale:
  rm ~/.multi-cc-im/state/daemon.pid
```

---

## 6. 跟现有 PR #56 协议的兼容性

- IMWork file schema **不变**（仍是 0-byte tombstone）
- IMOrigin file schema **不变**（IMReplyContext JSON）
- PermissionRequest / PermissionResponse / hook stdout schema **不变**
- IM 端 `/start` `/stop` `/1` `/2` 命令行为 **不变**
- daemon stop 多删 IMWork（你的提议）— **行为变更**：用户 Ctrl+C 后用户必须重新 `/start`。但 PR #56 已经设计了 daemon start 自动删 IMWork，所以"重启后 IMWork OFF" 的语义本来就成立，本变更只是把"清理时机提前到 stop"。

新增项独立：daemon.pid 文件、daemon_alive 检查、双开检测。

PR #56 的 hook decision tree 在新方案中**完全保留**，新加的 E4 (PreToolUse) / E3 (Stop) 是**前置 short-circuit**，不破坏后续 forward path 的语义。

---

## 7. 实施 plan（DD 锁定后单 PR ship）

文件改动估算：

| 文件 | 改动 | LOC |
|---|---|---|
| `packages/cli-cc/src/state-files.ts` | DaemonPidFile interface + path/read/write/delete + isDaemonAlive + captureProcessLstart helper | ~90 |
| `packages/cli-cc/src/hook-receiver.ts` | PreToolUse 加 E4 + Stop 加前置 3 步 | ~40 |
| `packages/cli-cc/src/index.ts` | 导出新 helpers | ~6 |
| `apps/multi-cc-im/src/start.ts` | 双开检测 + 写 daemon.pid + banner 调整 | ~50 |
| `apps/multi-cc-im/src/state-sweep.ts` | 兜底清 stale daemon.pid（safety net）| ~15 |
| `packages/bridge/src/orchestrator.ts` | stop() 删 IMWork + daemon.pid | ~10 |
| 测试 | state-files / hook-receiver / orchestrator / apps/start / apps/state-sweep | ~400 |
| 文档 | CLAUDE.md 假设表 + README "daemon lifecycle" 节 + docs/architecture.md state/ 文件清单 | ~50 |
| **合计** | — | **~660** |

测试覆盖（参照 5.5）：约 +25 个新测试。

---

## 8. 锁定后动作

DD merge 后：
1. 在 [CLAUDE.md「关键设计假设」表](../../../CLAUDE.md) 加新行 "daemon liveness 检测（PID + lstart 配对验证）"，链回本 DD
2. 在 [docs/architecture.md](../architecture.md) "数据存储" 节加 daemon.pid 文件描述 + "daemon 生命周期" 子节
3. 在 [README.md](../../../README.md) "Troubleshooting" 节加 "daemon 双开 / stale lock 处理" 条目
4. 实施 PR 单 commit ship（per CLAUDE.md "彻底解决，禁止补丁"）

---

## 9. 用户决策点

请最后确认（DD merge 之前）：

1. ✅ 走候选 d（独立 daemon.pid + kill -0 + ps -o lstart 配对验证）
2. ✅ daemon stop 同时删 IMWork + daemon.pid
3. ✅ daemon start 双开检测（已有 PID 活 + lstart 一致 → 拒绝启动；stale lock → 覆盖）
4. ✅ hook decision tree 顺序：read-only → IMWork → IMOrigin → daemon alive
5. ✅ Stop hook 跟 PreToolUse hook 前 3 个 short-circuit guard 完全对称（IMWork / IMOrigin / daemon alive）
6. ✅ SessionStart / SessionEnd 不加 daemon liveness 检查（lifecycle marker 跟 daemon 状态无关）

确认后 DD merge → 实施 PR ship。
