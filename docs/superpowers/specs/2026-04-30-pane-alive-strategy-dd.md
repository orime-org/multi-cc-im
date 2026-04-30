# Pane 活性验证策略 DD 报告

**Topic**: multi-cc-im 在 send-text 注入到 wezterm pane 之前，如何确认 pane 里 Claude Code TUI 还活着 —— 避免发到用户的 zsh shell（`/exit` 后 pane 还在但内部已是 shell）
**Scope**: `packages/term-wezterm/` 实现 `PaneAlive` capability 的 `isPaneAlive(paneId)` 具体策略。接口已锁定（[adapter 接口 DD](2026-04-29-adapter-interface-dd.md)），见 [`packages/shared/src/adapter/term.ts`](../../../packages/shared/src/adapter/term.ts) `PaneAlive extends Adapter` 定义。
**Date**: 2026-04-30
**Status**: ⏳ 候选评估完成，等待用户拍板（第 5 步）

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走完。此 DD 触发的启发式：「影响项目安全模型（路由前不验证活性 → 注入用户 shell）」+「跨包接口（term-wezterm 实现影响 core router 路由前置条件）」。

---

## 决策摘要

| 候选 | 推荐 |
|---|---|
| **g 多信号组合（SessionEnd hook 权威信号 + 心跳超时兜底）** | ✅ 推荐 |
| a 不做（直接注入不验证） | ❌ 排除 — CLAUDE.md「关键规范」硬约束「路由前必须验证 pane 里 cc 活着」+ 实测「`/exit` 后注入会落到 zsh shell」 |
| b 单 heartbeat（hook 时间戳 map） | ❌ 排除 — 假阳率高（cc 思考期间无 hook 触发，会被错判为 dead）|
| c 单 PID 探活（kill -0 + PPID） | ❌ 排除 — pid 复用风险 + 单信号 |
| d 单 SessionEnd hook | ❌ 排除 — 单信号、不能区分 hook 漏发（崩溃 / SIGKILL / 1.5s 超时）|
| e wezterm pane TITLE 模式匹配 | ❌ 排除 — TITLE 是用户可改的展示字段，cc 退出后 TITLE 不会自动清回 zsh，不可靠 |
| f transcript_path mtime 检查 | ❌ 排除 — jsonl 由 cc 写入，cc 思考期间 mtime 不变，假阳率最高 |

**g 的具体形态**:

```
权威信号（必信）: SessionEnd hook 收到 → 立即标记该 session_id 为 dead
兜底信号（保底）: hook 时间戳 + PID kill -0 双 AND 检查；超时（默认 30 分钟无任何 hook + PID 已 reap）才标记 dead
首次 send-text 前最后一道闸: 同步 PID kill -0（O(1) syscall）确认进程仍在
```

**未解决的研究问题**:
- cc 崩溃 / SIGKILL 不调 SessionEnd hook 的概率（文档说 reason="other" 兜底但不保证 SIGKILL/段错误命中）—— 兜底心跳超时阈值需要用户拍板默认值（建议 30 min，但取决于"cc 长思考最长时长"用户经验）
- pid 复用窗口期内（OS 重新分配相同 PID 给非 cc 进程）误报为 alive 的概率 —— macOS PID 空间 99999，重用周期受 fork 频率影响；需在 SessionStart 时除 PID 外再记 cc 进程启动时间戳（`/proc/<pid>/stat` 等价 macOS `ps -o lstart`）做 PID+startTime 双重锁

---

## 第 1 步：候选枚举（穷举，含"不做"作为 FIRST 候选）

| ID | 候选 | 描述 |
|---|---|---|
| **a** | **不做（直接 send-text 不验证）** | bridge 收到路由消息直接注入 pane，不检查 cc 是否活着 |
| **b** | **heartbeat 时间戳 map** | bridge 内存 `Map<session_id, lastHookTimestamp>`；任何 cc hook 触发刷新；超时 N 分钟标记 stale |
| **c** | **PID 探活（kill -0 + PPID）** | SessionStart hook 把 `$PPID`（= cc PID）+ 进程启动时间记到磁盘；路由前 `kill(pid, 0)` 检查 |
| **d** | **cc SessionEnd hook** | 注册 SessionEnd hook，收到即标记 dead；session_id ∈ alive set 即视为 alive |
| **e** | **wezterm pane TITLE 模式匹配** | `wezterm cli list --format json` 取 title 字段；cc 跑时 TITLE 是对话摘要，zsh 时是其他模式 |
| **f** | **transcript_path mtime check** | tail jsonl 文件 mtime；N 分钟未变 → 推测 cc 死 |
| **g** | **多信号组合（SessionEnd 权威 + heartbeat + PID 兜底）** | SessionEnd 收到立即 dead；其他 alive 判定 = "PID 仍在 AND last hook < timeout" |
| h | wezterm Lua API 取 foreground process（`get_foreground_process_info`） | 排除前置：CLAUDE.md「关键规范」硬约束「禁用 `wezterm cli list` 解析」精神 + Lua API 只在 wezterm 配置层可用，不通过 cli 暴露（[wezterm 文档](https://wezterm.org/cli/cli/list.html) 实测 `--format json` 字段仅 `{window_id,tab_id,pane_id,workspace,size,title,cwd}`，无 foreground process info） |
| i | 注入"探针 prompt"（如 ANSI 查询）等回复 | 排除：违反 CLAUDE.md「核心约束 1: 不破坏现有 cc 进程」—— 探针落 cc 上下文污染对话 |
| j | spawn cc 进程接管 | 排除：违反 CLAUDE.md「核心约束 1: bridge 不 spawn cc」 |

短列表：a/b/c/d/e/f/g 进第 2-4 步。h/i/j 排除理由可追溯到上表。

> **关于"不做 X"候选**: CLAUDE.md memory「DD 候选枚举必须含'不做 X'」硬规则要求列入 a。CLAUDE.md「关键规范」表「路由前必须验证 pane 里 cc 活着」与「禁止清单」「不验证 cc 活性就 send-text」已是答案，但本 DD 仍在第 4 步**展开论证**为什么必须做（不是路径依赖思维，而是把"不做"的具体后果摆在矩阵里跟其他候选对照）。

---

## 第 2 步：5 维度尽调

### 维度定义

| 维度 | 说明 | 量化标准 |
|---|---|---|
| **正确性** | 对"cc 死了"的检测可靠度（vs "cc 在思考"误判） | 检测 truth table 里的命中率 |
| **延迟** | cc 死掉后多久能知道 | 从 cc 死到 isPaneAlive 返回 false 的时间窗口 |
| **基础设施依赖** | 要 OS / cc / wezterm 提供什么 | 越少越好 |
| **假阳率（claims alive when dead）** | **最危险** —— 会注入 zsh shell；安全模型核心 | 越低越好；零容忍 |
| **假阴率（claims dead when alive）** | UX 麻烦 —— 消息排队 / 用户被告知 session 不可用 | 越低越好但相对可容忍 |

### 候选 a：不做

| 维度 | 评估 |
|---|---|
| 正确性 | **0%**（永远 claim alive） |
| 延迟 | N/A（不检测）|
| 基础设施依赖 | 无 |
| 假阳率 | **100%**（cc 死后所有注入都到 zsh）|
| 假阴率 | 0% |

**致命问题**: 实测确认（[hook+wezterm 实测 W2](2026-04-27-cc-hook-wezterm-probe.md#w2-pane-id-在同-pane-重启-cc-不变)）`/exit` 后 pane 不消失，里面是 zsh shell。bridge 注入的 prompt → zsh 当 shell 命令执行 → 任意命令注入。**安全灾难**。CLAUDE.md「禁止清单」「不验证 cc 活性就 send-text」+「关键规范」「路由前必须验证 pane 里 cc 活着」双重硬约束。直接排除。

### 候选 b：heartbeat 时间戳 map

```typescript
// bridge 内存
const lastHookAt = new Map<SessionId, number>();
// 任意 hook 触发时
lastHookAt.set(sid, Date.now());
// 路由前
const stale = Date.now() - (lastHookAt.get(sid) ?? 0) > TIMEOUT_MS;
```

| 维度 | 评估 |
|---|---|
| 正确性 | **不可靠** —— cc 处于"用户没发新 prompt 静默期"时，无 UserPromptSubmit / Stop / PreToolUse / PostToolUse 触发；只有 SessionStart 是一次性。不能区分"cc 死了"和"cc 闲着等用户" |
| 延迟 | TIMEOUT_MS 量级；要长才不误判，长则 cc 死后还能 alive 状态很久 |
| 基础设施依赖 | 仅 cc 已有 hook 触发 |
| 假阳率 | **高** —— cc 死了之后 TIMEOUT_MS 内仍 claim alive（注入会到 zsh）|
| 假阴率 | **高** —— cc 长时间静默被误判 dead；长思考一轮（几分钟到 30+ 分钟，"思考预算" 31999 token 实测可超 5 min）也无 hook 触发 |

**致命问题**: hook 触发跟 cc 活性是两个不同信号。cc 在思考一道复杂问题时，UserPromptSubmit 早就触发完，PreToolUse / PostToolUse 间隙可达分钟级，Stop 还没到 —— 此时心跳判定 stale 但 cc 完全活着。反之 cc 崩溃后心跳依然 fresh 一段时间。**单 heartbeat 信号根本性不充分**。

### 候选 c：PID 探活（kill -0）

```bash
# SessionStart hook（hook subprocess 的 PPID = cc PID）
echo "$PPID:$(ps -o lstart= -p $PPID)" > "$STATE_DIR/$session_id.cc-pid"
# 路由前
kill -0 "$pid" 2>/dev/null  # exit 0 = pid 仍存在
```

实测确认：hook subprocess `os.getppid()` 返回 cc 进程的 PID（本次实测 hook PID=18231 PPID=18229，PPID 即 cc）。

| 维度 | 评估 |
|---|---|
| 正确性 | **高**（OS 内核状态，cc 进程死则 kill -0 立即返回 ESRCH）|
| 延迟 | 0（kill 是 O(1) syscall）|
| 基础设施依赖 | POSIX `kill(pid, 0)` —— macOS man 2 kill 文档确认 "A value of 0 will cause error checking to be performed (with no signal being sent). This can be used to check the validity of pid" |
| 假阳率 | **PID 复用风险**：cc 进程退出后 PID 被 OS 重新分配给无关进程 → kill -0 仍返回 0 误判 alive。macOS PID 空间 99999，PID 复用周期受 fork 速率影响（短周期可能秒级）。**缓解**：SessionStart 同时记录 cc 进程启动时间戳（macOS `ps -o lstart -p $PID`），路由前对比 `(pid, startTime)` pair 而非裸 pid |
| 假阴率 | 低（kill -0 假阴几乎不可能，除非权限丢失但同 uid 不会）|

**关键风险（PID 复用）已有缓解**: `(pid, startTime)` 双重锁。但增加 1 个 syscall + 启动时间字符串解析；不是单纯 `kill -0`。

### 候选 d：cc SessionEnd hook

**文档实测确认**（[Anthropic Hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks)）:

> `SessionEnd` — Runs when a Claude Code session ends. Useful for cleanup tasks, logging session statistics, or saving session state. Supports matchers to filter by exit reason. The reason field in the hook input indicates why the session ended:
> - `clear` — Session cleared with /clear command
> - `resume` — Session switched via interactive /resume
> - `logout` — User logged out
> - `prompt_input_exit` — User exited while prompt input was visible
> - `bypass_permissions_disabled` — Bypass permissions mode was disabled
> - `other` — Other exit reasons

stdin schema:
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../<sid>.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

**关键限制**（来自文档同段）:
- "no decision control. They cannot block session termination but can perform cleanup tasks"
- "default timeout of 1.5 seconds"
- 5 个 reason 值 + `other` 兜底

| 维度 | 评估 |
|---|---|
| 正确性 | **权威信号**（cc 主动告知 session 结束）|
| 延迟 | hook 触发 → bridge 处理 < 100 ms |
| 基础设施依赖 | cc 自身扩展点（v0.3 已锁定 hook 路线） |
| 假阳率 | **未知非零** —— 若 cc 因 SIGKILL / 段错误 / 系统 shutdown 而非 graceful exit，SessionEnd 可能不触发；reason="other" 是兜底但不保证所有 abnormal exit 都命中。**研究问题**：未实测 SIGKILL 场景；CLAUDE.md memory 已 flag 待补 |
| 假阴率 | 极低（cc 主动告知就是真 dead）|

**单独使用的问题**: 假阳率虽低但非零（abnormal exit 可能漏发）；hook 1.5s 超时若 bridge 此时正繁忙可能丢失 SessionEnd 事件。

### 候选 e：wezterm pane TITLE 模式匹配

```bash
$WEZTERM cli list --format json | jq '.[] | select(.pane_id == 20).title'
```

[wezterm cli list 文档](https://wezterm.org/cli/cli/list.html) 确认 JSON 输出仅含 `{window_id, tab_id, pane_id, workspace, size, title, cwd}` 字段；**不包含 foreground process / pid**。

实测（hook+wezterm DD W2）:

| pane 状态 | TITLE 实样 |
|---|---|
| cc 跑对话 | cc 取的对话标题（如"实施 Storage DD"）|
| `/exit` 后退到 zsh | TITLE 变空（或 zsh 设置的 hostname / cwd，无统一规则）|
| 同 pane 跑 `claude` 重启 | "Claude Code"（cc 默认）|

| 维度 | 评估 |
|---|---|
| 正确性 | 低 —— TITLE 是展示字段，多个 source 写：cc / zsh prompt / wezterm config / 用户手改。无 schema 保证 |
| 延迟 | wezterm cli list O(N) where N = pane 数（CLAUDE.md「关键规范」「禁用 `wezterm cli list` 解析」精神排斥这条）|
| 基础设施依赖 | wezterm cli + JSON 解析 |
| 假阳率 | **中高** —— "Claude Code" 标题 cc 退出后未必立即变 zsh prompt；用户主动改 TITLE 也会污染 |
| 假阴率 | 中 —— cc 在 zsh 风格的 TITLE 下跑（用户配 wezterm `set_pane_title` rule）会被误判 |

**致命问题**: TITLE 没有 schema 保证。用户 wezterm 配置 / zsh prompt 风格高度个性化。把"是否 claude code"压在 TITLE 字符串匹配 = 启发式 hack，违反 CLAUDE.md「编码行为准则 5: 彻底解决，禁止补丁」精神。

### 候选 f：transcript_path mtime check

```typescript
const stat = await fs.stat(transcriptPath);
const stale = Date.now() - stat.mtime.getTime() > TIMEOUT_MS;
```

| 维度 | 评估 |
|---|---|
| 正确性 | **极不可靠** —— jsonl 由 cc 在事件时写入；cc 思考一轮（数分钟）期间 mtime 不变；用户与 cc 对话间静默几十分钟 mtime 也不变。判 stale 是判"没人在说话"而非"cc 死了" |
| 延迟 | TIMEOUT_MS 量级 |
| 基础设施依赖 | fs stat |
| 假阳率 | **高** —— cc 死后立即注入仍命中 mtime fresh 窗口 |
| 假阴率 | **极高** —— cc 完全闲置（用户去吃饭）= dead 误判，但 cc 还在 |

**致命问题**: transcript mtime 是"对话写入活性"，不是"进程活性"。比 candidate b 的 hook timestamp 还差（hook timestamp 至少包含 PreToolUse/PostToolUse；jsonl 是 cc 自己写，cc 死了则 jsonl 也停，但 cc 没死也可能停）。

### 候选 g：多信号组合

```typescript
// 状态机
interface SessionAliveState {
  // 权威：SessionEnd 收到立即 false（不可逆）
  endReceived: boolean;
  // 启动时记录的进程 ID + 启动时间戳（PID 复用防护）
  ccPid: number;
  ccStartedAt: string;  // ps -o lstart 输出，字符串 anchor
  // hook 时间戳（任意 hook 刷新）
  lastHookAt: number;
}

async function isAlive(sid: SessionId): Promise<boolean> {
  const s = state.get(sid);
  if (!s) return false;                    // 没 SessionStart 记录过
  if (s.endReceived) return false;         // SessionEnd 权威 dead
  // PID + startTime 双重锁防 PID 复用
  if (!await pidMatchesStart(s.ccPid, s.ccStartedAt)) return false;
  // 极端长 idle 兜底：如果连续 IDLE_TIMEOUT_MS（默认 30 min）无任何 hook
  // 触发 + PID 已 reap 双 AND，标记 dead；只命中 PID 还在的不标记
  if (Date.now() - s.lastHookAt > IDLE_TIMEOUT_MS && !pidExists(s.ccPid)) return false;
  return true;
}
```

| 维度 | 评估 |
|---|---|
| 正确性 | **高** —— 三信号互补：SessionEnd 权威、PID+startTime 内核状态、hook 时间戳兜底 |
| 延迟 | SessionEnd: <100ms; PID 死: <100ms；纯 idle 异常: IDLE_TIMEOUT_MS（默认 30 min）|
| 基础设施依赖 | cc SessionEnd hook（已确认存在）+ POSIX kill + ps |
| 假阳率 | **极低** —— 同时绕过 SessionEnd（abnormal exit）+ PID kill -0 + startTime 一致 + hook 时间戳 fresh 概率乘积 |
| 假阴率 | 低 —— 只有 cc 长 idle 时间超过 IDLE_TIMEOUT_MS 且 PID 真实已退（pid 复用边缘场景）|

**复杂度成本**: 比单信号高约 50 行代码 + 1 次 SessionStart 时记录 + 1 次 SessionEnd 处理 + 1 次 isAlive 调用时 2 syscall。可控。

---

## 第 3 步：对比矩阵

| 维度 | a 不做 | b heartbeat | c PID | d SessionEnd | e TITLE | f mtime | **g 组合** |
|---|---|---|---|---|---|---|---|
| **正确性** | 0% | 不充分 | 高（+startTime 锁）| 权威但单点 | 启发式 | 极差 | **高** |
| **延迟（cc 死 → 知道）** | ∞ | TIMEOUT_MS | <100ms | <100ms | wezterm cli list O(N) | TIMEOUT_MS | **<100ms（SessionEnd or PID）+ tail timeout 兜底** |
| **基础设施依赖** | 无 | cc hook | POSIX kill+ps | cc SessionEnd 文档确认 | wezterm cli list | fs.stat | cc hook+kill+ps |
| **假阳率（claims alive when dead → 注入 zsh）** | 100% 灾难 | 高（cc 死后 TIMEOUT 内 alive）| 中（PID 复用，已缓解 startTime）| 低但非零（abnormal exit 漏发）| 中高（TITLE schema 无保证）| 高 | **极低（多信号同时绕过乘积）** |
| **假阴率（claims dead when alive → 排队 UX 麻烦）** | 0 | 高（cc 长思考误判）| 低 | 极低 | 中（zsh 风 TITLE 误判）| 极高 | **低** |
| **CLAUDE.md「禁止清单」「不验证 cc 活性就 send-text」合规** | ❌ 违反 | ⚠️ 部分（误判时仍注入）| ⚠️ PID 复用未缓解则部分违反 | ✓ 但漏 abnormal exit | ⚠️ 启发式 | ⚠️ 部分 | ✓ |
| **CLAUDE.md「关键规范」「路由解析 = WEZTERM_PANE env」「禁用 wezterm cli list 解析」精神对齐** | N/A | ✓ | ✓ | ✓ | ❌ 违反（依赖 list 解析）| ✓ | ✓ |
| **CLAUDE.md「编码行为准则 5: 彻底解决禁止补丁」对齐** | ❌（不验证 = 不做）| ❌（单信号不充分 = 补丁）| ⚠️（单信号 + PID 复用边缘）| ⚠️（依赖 cc 优雅 exit 是补丁假设）| ❌（启发式 hack）| ❌ | ✓（多信号互补根因）|
| **跟 cc-connect 同类项目对齐** | ❌ | ⚠️（cc-connect heartbeat.go 是周期 prompt 调度器，不是活性检测；不可移植）| N/A（cc-connect 是 spawn 模式，直接持有子进程 handle，无此问题）| ✓ | ❌ | ❌ | ✓ |
| **实施复杂度** | 0（不做）| ~30 行 | ~50 行（含 startTime）| ~40 行 | ~80 行（list parsing）| ~20 行 | ~120 行（多信号状态机）|

### 矩阵证据出处（按格）

| 格 | 证据来源 |
|---|---|
| a 假阳率 100% | [hook+wezterm DD W2](2026-04-27-cc-hook-wezterm-probe.md#w2-pane-id-在同-pane-重启-cc-不变) "/exit 后 pane 还在但里面跑的是 zsh" |
| c 基础设施 | macOS `man 2 kill` 实读："A value of 0 will cause error checking to be performed (with no signal being sent). This can be used to check the validity of pid" |
| c PID 来源 | hook+wezterm DD probe 实测：hook subprocess `os.getppid()` 返回 cc 进程 PID（本次复测 PID=18231 PPID=18229）|
| d hook 存在 | [Anthropic docs hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks) `SessionEnd` 章节，stdin 含 `{session_id, transcript_path, cwd, hook_event_name, reason}`，reason 取值 `clear/resume/logout/prompt_input_exit/bypass_permissions_disabled/other` |
| d 漏发风险 | 同上 docs："1.5 second default timeout"（hook 超时丢弃事件可能）+ 文档未保证 SIGKILL/段错误必触发 SessionEnd |
| e wezterm fields | [wezterm cli list 文档](https://wezterm.org/cli/cli/list.html) `--format json` 字段 `{window_id, tab_id, pane_id, workspace, size, title, cwd}`；**无 foreground process info / pid** |
| e TITLE 实样 | hook+wezterm DD W2 表格："`/exit` 后 TITLE 变空" |
| 「禁用 wezterm cli list 解析」 | CLAUDE.md「关键规范」「路由解析 = `WEZTERM_PANE` env」 + 「禁止清单」「用 `wezterm cli list` 解析 cwd 反推 pane-id」 |
| 「不验证 cc 活性就 send-text」 | CLAUDE.md「禁止清单」直接条目 |
| cc-connect heartbeat ≠ 活性检测 | [cc-connect `core/heartbeat.go`](https://github.com/chenhg5/cc-connect/blob/main/core/heartbeat.go) L86-100 `Register` + L319-335 `run` 实读：周期 ticker 触发 `engine.ExecuteHeartbeat()` 发提示词，**不是检测**。cc-connect 是 spawn 模式直接持有 `*exec.Cmd`，无 multi-cc-im 这个问题 |

---

## 第 4 步：基于 DD 数据的推荐 + 理由

**推荐 g（多信号组合：SessionEnd 权威 + PID+startTime + hook 时间戳兜底）**。每条理由可追溯到矩阵某格证据：

1. **a/b/f 都假阳率高，违反「禁止注入 zsh」安全核心**（矩阵第 4 行 a/b/f 列）
   - a 100% 假阳是灾难（实测 W2 证据）
   - b 单 heartbeat 不能区分"cc 思考"与"cc 死"，cc 长思考实测可超 5 min（hook+wezterm DD H2 stop_hook_active 实测时 cc 续答耗时 8s，而长任务实测过分钟级），TIMEOUT_MS 没法选准
   - f mtime 比 b 更差（mtime 只在 cc 写 jsonl 时变，cc 闲置就不变）

2. **e 违反 CLAUDE.md「禁用 wezterm cli list 解析」精神**（矩阵第 7 行 e 列）—— 同样的 O(N) 解析 wezterm cli list 反模式，且 TITLE 没有 schema 保证（wezterm 文档实测仅 7 个字段无 process info）

3. **d 单独看权威但有漏发**（矩阵第 4 行 d 列）—— SessionEnd 文档确认存在但 1.5s 超时 + abnormal exit（SIGKILL / 段错误 / OS shutdown）不保证触发。**单信号不彻底**

4. **c 单独看够强但 PID 复用是真风险**（矩阵第 4 行 c 列）—— 加 startTime 缓解后接近 g 的 PID 子信号；但缺少 SessionEnd 权威信号 → 检测延迟变大（SessionEnd <100 ms vs PID 死要等 cc 真退出）

5. **g 是 c+d 互补 + b 兜底**（矩阵第 1/4/5 行 g 列）
   - SessionEnd 收到 → 立即 dead（覆盖 graceful exit / `/exit` / `/clear` / logout 等 5 种 reason）
   - PID kill -0 + startTime → 覆盖 abnormal exit（SIGKILL / 段错误 / system shutdown，SessionEnd 没触发也 PID 真实死了）
   - hook 时间戳 + idle 超时 → 覆盖 bridge 重启后状态丢失（重启时没拿到 SessionEnd，PID 仍在，但实际 cc 已死的边缘场景）—— 仅作为兜底「都没确认死则保守 alive」

6. **g 在矩阵第 8 行「彻底解决禁止补丁」对齐唯一 ✓**（矩阵第 8 行）—— 其他候选要么不够（a 不做）、要么单信号不彻底（b/c/d/e/f 都需要二次补丁）。g 的多信号互补不是"hybrid 双写"补丁词汇所禁的"两条路径并存"（双写禁的是同一 source of truth 写两份；g 是多 source of truth 互补），是真正的根因解（活性的真实信号本来就是多维 OS 状态）

7. **g 跟 cc-connect 同类项目结构对齐**（矩阵第 9 行）—— cc-connect 是 spawn 模式有直接子进程 handle，没移植路径，但对应模式的 d+c 组合是 multi-cc-im 在 hook+bridge 模式下的等价物（不是"port"是"等价架构"）

**排除其他候选的最强单条论据**:
- a：违反 CLAUDE.md 硬约束「禁止清单」「不验证 cc 活性就 send-text」+ 实测证据 W2「/exit 后 pane 内是 zsh」
- b: 单 heartbeat 不能区分思考与死亡 → cc 长思考误判 dead，cc 死后窗口期假 alive
- c: PID 复用边缘 + 无 SessionEnd 权威信号会漏 graceful exit 信号
- d: 1.5s 超时 + abnormal exit 漏发，单信号不充分
- e: wezterm cli list 反模式 + TITLE 无 schema
- f: mtime 跟"进程活性"维度不对应

---

## 第 5 步：用户决定

<待用户拍板>

**用户决定**:
**锁定时间**:
**依据**:

后续动作（用户决定 g 后）:
1. 写入 CLAUDE.md「关键设计假设」表「pane 活性验证策略」行从 ? 改 ✓，附本 DD 链接
2. 按下方实施清单实施 `packages/term-wezterm/src/pane-alive.ts`
3. TDD 节奏（CLAUDE.md「TDD 红→绿→蓝」）：先写假阳率为 0 的 vitest 用例 codify 三信号互补行为 → 实现状态机 → 重构 + ≥80% 覆盖

---

## 实施清单（v1 落地步骤，待第 5 步锁定后启动）

```
1. packages/shared/src/types.ts
   + AliveState 类型: { endReceived: boolean; ccPid: number;
       ccStartedAt: string; lastHookAt: number }

2. scripts/SessionStart.sh hook 增量
   + 写 $PPID + $(ps -o lstart= -p $PPID) 到 ~/.multi-cc-im/state/<sid>.cc-pid
   + 注意 stdout 严禁污染（CLAUDE.md「关键规范」「multi-cc-im hook 不许写非协议 stdout」）

3. scripts/SessionEnd.sh hook（新加）
   + 在 cc settings.json 注册 SessionEnd matcher: *
   + stdin 解析 { session_id, reason } → 写 ~/.multi-cc-im/state/<sid>.ended
   + 1.5s 超时内 fast path: 一次 fs.writeFile + 退出

4. packages/term-wezterm/src/pane-alive.ts
   + 实现 PaneAlive capability 的 isPaneAlive(paneId)
   + reverse lookup: pane_id → session_id（core router 状态）
   + 三信号 AND/OR 状态机（见第 4 步推荐里的伪代码）

5. packages/core/src/router.ts 路由前置闸
   + before send-text: if (!await termAdapter.isPaneAlive(paneId))
       throw RouteError("session dead, skipping")
   + dead 时把 msg 返还 pending-msg.jsonl 队列（CLAUDE.md storage DD A 模式）+ 通知微信侧

6. packages/term-wezterm/src/__tests__/pane-alive.test.ts
   + 红：mock SessionEnd 信号下应 dead；mock PID 死应 dead；mock idle 超时 + PID dead 应 dead
   + 绿：实现状态机
   + 蓝：覆盖率 ≥80%；边缘 case（PID 复用：startTime 不一致应判 dead）专项测
```

---

## 风险与缓解

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| **cc abnormal exit（SIGKILL / segfault）不触发 SessionEnd** | 中 | 高 | g 的 PID 信号兜底；额外可在 SessionEnd 收到任何 reason 时立即 dead |
| **PID 复用：cc 死后 PID 被无关进程占用** | 低 | 高 | g 的 startTime 双重锁；macOS `ps -o lstart` 字符串 anchor，PID 复用必然 startTime 不同 |
| **SessionStart hook 时记录 PID 失败（hook 写文件错）** | 低 | 中 | hook 失败则 SessionStart 不算成功，bridge 不创建 alive 状态 → 路由检查时 state 缺失视为 dead，不会误注入 |
| **bridge 重启丢失内存 alive map** | 中 | 中 | 启动时全量重读 `~/.multi-cc-im/state/*.cc-pid` + `*.ended` 文件 → 用 PID kill -0 重建状态；只有 PID 还在且 startTime 一致才视 alive |
| **IDLE_TIMEOUT_MS 阈值选错（太小误判 cc 长思考；太大假 alive 窗口长）** | 中 | 中 | **未解决研究问题**：默认 30 min 是经验值，需用户在 v1 实施前 sign-off，或做成 config.toml 可配 |
| **g 实施复杂度比单信号高** | 中 | 低 | 矩阵显示 g ~120 行 vs 单信号 30-50 行；项目特例（CLAUDE.md「简单优先」豁免：4 维度 adapter 是用户明确要求的可扩展性，安全 critical path 多信号同样合理）|
| **wezterm cli send-text 跟 isPaneAlive 之间 race（kill -0 后 0.1s 内 cc 死，注入仍打到 zsh）** | 低 | 高 | 两阶段防御：1) 路由前 isPaneAlive；2) 路由后立刻收到 SessionEnd 时若 send-text 还没完成 → 取消（不能完全消除窗口，但 0.1s 窗口期比无检测好几个量级）。完全消除要 cc 提供"输入端口"原子接口（v1 不在范围）|

---

## 未解决研究问题（list）

1. **cc abnormal exit 是否触发 SessionEnd**：[Anthropic docs](https://docs.anthropic.com/en/docs/claude-code/hooks) SessionEnd 章节列了 5 个 reason + `other` 兜底，但未明文保证 SIGKILL / segfault / OS shutdown 都触发。需 v1 实施前实测（kill -9 + 复测 SessionEnd 文件出现否）
2. **IDLE_TIMEOUT_MS 默认值**：依赖"用户经验上 cc 一轮思考最长时长"；建议 30 min 起步但需用户 sign-off
3. **bridge 重启时已 dead 但 SessionEnd 文件未写入的边缘**：bridge 重启前 cc 突死 + bridge 也突死（双重故障）→ 重启后 PID 已 reap，重建状态会判 dead ✓；但若 PID 已被复用 → startTime 不一致仍判 dead ✓。**已被 g 状态机覆盖**，但需用 unit test codify

---

## 链接

- **前置 DD**:
  - [hook+wezterm 实测](2026-04-27-cc-hook-wezterm-probe.md) — 锁定 W2「pane lifecycle ≠ cc lifecycle」+ hook stdin schema
  - [adapter 接口设计 DD](2026-04-29-adapter-interface-dd.md) — 锁定 `PaneAlive extends Adapter` capability 接口
  - [Storage 持久化策略 DD](2026-04-29-storage-strategy-dd.md) — 状态文件落 `~/.multi-cc-im/state/` 走 atomic write（同套机制）

- **数据来源**:
  - Anthropic Claude Code Hooks Reference: https://docs.anthropic.com/en/docs/claude-code/hooks（SessionEnd 章节实读）
  - WezTerm CLI list 文档: https://wezterm.org/cli/cli/list.html（`--format json` 字段实读）
  - macOS `man 2 kill`（kill(pid, 0) 验证语义实读）
  - cc-connect `core/heartbeat.go`: https://github.com/chenhg5/cc-connect/blob/main/core/heartbeat.go（实读确认是周期 prompt 调度器，不是活性检测；不可直接移植）
  - cc-connect `core/runas_check.go`: https://github.com/chenhg5/cc-connect/blob/main/core/runas_check.go（实读确认是 sudo 权限 preflight，跟"agent 是否活着"无关）

- **CLAUDE.md 引用条目**（强约束 anchor）:
  - 「关键规范」「路由前必须验证 pane 里 cc 活着」
  - 「关键规范」「路由解析 = `WEZTERM_PANE` env」
  - 「禁止清单」「不验证 cc 活性就 send-text」
  - 「禁止清单」「用 `wezterm cli list` 解析 cwd 反推 pane-id」
  - 「编码行为准则 5: 彻底解决，禁止补丁」
  - memory「DD 候选枚举必须含'不做 X'」
