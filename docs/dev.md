# 开发命令 · TDD 节奏 · 调试

> 本文是面向开发者的真实命令 / 调试清单（飞书 Lark adapter，DD #86 M2-M7 + interactive wizard DD W1-W8）。新人 onboard 可对着跑；终端用户上手命令以 [`../README.md`](../README.md) 为准。

## Agent project instructions

Read [AGENTS.md](../AGENTS.md) before contributing in Codex or Claude Code.
Claude Code imports the same file through [CLAUDE.md](../CLAUDE.md).
Use [agent-context.md](agent-context.md) to locate existing Claude memories,
recover the dated handoff, and map older tool names to the current host.
Restart the host session after changing instruction entry files and verify
which files it loaded. Keep shared rules in AGENTS.md.

## Codex terminal task panel

The panel subscribes to the existing local Codex App Server's
`turn/plan/updated` notifications. The connection uses only a Unix socket:
there is no panel-specific cloud service, model request, or external upload.
The normal Codex model conversation still uses its configured provider.

Start from the repository root in a separate terminal pane:

```bash
node scripts/task-panel-events.mjs --session "$CODEX_THREAD_ID"
```

If the new shell does not inherit `CODEX_THREAD_ID`, pass the original Codex
thread id explicitly. In WezTerm, run from the Codex shell environment:

```bash
wezterm cli split-pane --pane-id "$WEZTERM_PANE" --bottom --cells 10 -- \
  node "$PWD/scripts/task-panel-events.mjs" --session "$CODEX_THREAD_ID"
wezterm cli activate-pane --pane-id "$WEZTERM_PANE"
```

The observer reads `thread/read` first and attaches with `thread/resume` only
when that exact thread is already loaded (idle or active). It never starts or
revives an unloaded session, sends prompts, writes configuration, or answers
approval requests. It reconnects every two seconds if the local connection or
session is unavailable. It does not start or restart the App Server.

Display snapshots are stored at `$CODEX_HOME/task-panel/<thread-id>.json`
(default `~/.codex/task-panel/`), directory 0700 / file 0600, using atomic
replacement. A restarted panel restores that thread's checklist and labels it
as saved until the next live update. A new thread has a separate cache.
The Python viewer reads this snapshot once per second, without filesystem
watchers. Its `--once` option prints the view without curses.

Press `q` in the panel to close both the viewer and its observer. If only Codex
is reopened while the lower pane remains open, the observer can reattach once
the same thread is loaded again. Closing the whole terminal also closes the
panel; rerun the entry command next time. No global auto-start hook or shell
configuration is installed. Enlarge the pane when a truncation notice appears.

The earlier project plan hook has been removed after the user selected native
events. Existing global hooks/trust state are untouched. Do not maintain
`docs/agent-tasks.json` as a second task source.

Tests: `python3 scripts/task-panel.test.py` and
`pnpm test scripts/task-panel-events.test.mjs`. These cover local socket
notifications, session isolation, malformed updates, private cache mode,
connection recovery, panel restart/cache restoration, and no approval replies.
`ws` and `zod` are direct development dependencies, reusing versions already in
the workspace lockfile; neither is added to the published CLI's dependencies.

### Codex tab title activity

Codex 0.163.0 honors the host's reduce-motion setting at TUI launch. On macOS,
`reduceMotion = 1` suppresses the title spinner even if `activity` is selected.
The pinned `tui/src/system_motion.rs` reads this preference once;
`local_settings.rs` combines it with `tui.animations`, and
`chatwidget/status_surfaces.rs` requires animations/progress effects to emit a
spinner. A static `status` title item can display work state without animation.
Changing the OS preference requires relaunching the TUI to change this behavior;
this is separate from the plan panel's live event connection. Do not change the
user's system accessibility preferences automatically.

## Codex hook protocol regression checks

Run `pnpm exec vitest run packages/cli-codex/src/setup-hooks.test.ts
packages/cli-codex/src/hook-receiver.test.ts packages/cli-codex/src/payloads.test.ts`
on one line. Fixtures use temporary Codex/state directories, never real user
configuration. They verify trust/disabled state, full third-party fields,
original-byte backup, stable positional hook identities, byte-stable repeat
installation, absent agent metadata,
and native PermissionRequest output for allow/deny/timeout.

The upstream contract is pinned to `rust-v0.163.0` input/output schemas; see
[the integration audit](superpowers/specs/2026-10-22-codex-integration-audit.md).
For a built-CLI smoke, pass an inert main-session payload to
`./bin/multi-cc-im hook-receiver-codex` with `MULTI_CC_IM_HOME` pointing to an
isolated temporary fixture. Validate stdout against the official schema;
exercise auto/ask with allow and deny, without sending real IM messages.
Existing global config/trust is never a test fixture. The real-account IM
round trip is a separate check and has not been performed for these fixes.

## Codex triage backend verification

`pnpm exec vitest run packages/bridge/src/ai-router-codex.test.ts
apps/multi-cc-im/src/start.test.ts` (one line) verifies all three selected-backend
paths, shared answer schemas, per-call working-directory isolation, hooks off,
terminal environment removal, model selection, errors/timeouts, and cleanup.
Tests use inert executable fixtures and never call real model services.

An additional isolated real-Codex smoke used Codex 0.163.0 with a localhost
fake Responses provider and an explicitly vetted SessionStart marker hook:
the old trust-bypass invocation ran the marker; all three corrected routes
returned schema-valid results without running it. Temporary CODEX_HOME and
fixture credentials were confined to that smoke process. No global config,
real account, existing user session, daemon restart, or IM send was involved.

Question transport is separately documented in
[the question-bridge DD](superpowers/specs/2026-10-22-codex-question-bridge-dd.md).
The original protocol probe establishes callback semantics. Product and real-TUI
acceptance are separate reproducible checks below; real IM accounts are not used.

## Codex native thread identity probe

```sh
pnpm exec tsx scripts/codex-identity-probe.mts
```

This optional research fixture requires installed Codex 0.163.0, Python 3 and
Unix PTYs. It uses one temporary Codex home, a localhost fake Responses server,
an owned App Server, and two owned TUI clients with distinct terminal markers.
It verifies that hooks inherit the server's pane while the official `thread-id`
titles identify different client threads. Trust bypass applies only to the
private fixture. All fixture processes/files are cleaned up; no live user TUI,
daemon, global configuration or real IM/model account is used.

The probe also runs the production hook entry for replies and auto approvals
with two actual TUI thread ids and a terminal-API fixture containing their
captured titles, despite the shared server's wrong inherited pane. Both real
TUIs ask native questions; the product client reads fresh captured titles and
loaded ids, answers separately, and checks their local fake-model inputs.
Only fixture PTYs inspect control sequences; production uses structured APIs.
The terminal API fixture is preflighted before the sub-second hook checks.

## Codex native question bridge acceptance

```sh
CHOKIDAR_USEPOLLING=1 pnpm exec tsx scripts/codex-question-smoke.mts
pnpm exec vitest run packages/term-iterm2/src/helper-contract.test.ts
```

The first command uses a real native App Server and product adapter/orchestrator
with a fake local model/IM/terminal snapshot. It verifies IM-first, terminal-first,
late answers, native replay after bridge restart, default-mode questions and
multiple questions; no answer becomes a terminal prompt. Its terminal titles
are controlled fixtures, so use the two-TUI identity probe as separate provenance
evidence. Both scripts clean up only processes/files they created.

The second runs the actual Python helper against an isolated iTerm2 API contract
where `autoName` and `terminalWindowName` differ. This protects the raw-title field;
it does not establish a live iTerm2-window round trip. This host's live WezTerm
structured API returned all title fields in about 8ms; iTerm2 was not running.
No user daemon/TUI was restarted, no unrelated process stopped, and no real IM
account or external model provider was contacted.

Required verification also includes `pnpm typecheck`, `pnpm test`, build/bin smoke,
`pnpm install --frozen-lockfile`, and a clean production deployment of the bundled
CLI. On hosts with existing EMFILE watcher exhaustion, the documented test-only
`CHOKIDAR_USEPOLLING=1` environment can run the full suite; it changes no product
watcher behavior. Keep `~/.claude/settings.json` unchanged and compare its backup.

Runtime activation: select Codex in the wizard, review hooks with native `/hooks`,
and add `thread-id` in native `/terminal-title` for already-running TUIs. The
installer preserves saved title items and appends only the official identity item
(with backup); new TUIs read that selection. Missing/ambiguous ids pause native
IM forwarding/submission and leave the TUI available. Native requests are currently
pinned to 0.163.0 and a single shared `CODEX_HOME`; arbitrary home scans are forbidden.

## 快速跑通

```bash
# 1. 装依赖
pnpm install

# 2. 全量验证
pnpm typecheck                       # 8 workspaces tsc --noEmit
pnpm test                            # 58 文件 / 821 单测
pnpm test:coverage                   # 同上 + v8 coverage（80% 阈值）

# 3. 构建生产 bundle（hook 冷启动从 ~1s 降到 ~50ms — 实际部署必跑）
pnpm --filter multi-cc-im build      # tsup → apps/multi-cc-im/dist/cli.js
```

## CLI 子命令（apps/multi-cc-im）

```bash
./bin/multi-cc-im start              # 启动 daemon（Ctrl+C graceful shutdown）
./bin/multi-cc-im login lark         # 配飞书 app_id + app_secret，存 0600 凭据
./bin/multi-cc-im setup-hooks        # 把 3 个 hook 命令幂等合并到 ~/.claude/settings.json
./bin/multi-cc-im cleanup            # 扫 ~/.multi-cc-im/state/ 删孤儿 pane 文件 + legacy
./bin/multi-cc-im cleanup --dry-run  # 预览不删
./bin/multi-cc-im hook <event>       # 内部 hook 入口（cc 调，不要手动跑）
```

`bin/multi-cc-im` bash wrapper 自动选 prod/dev：

- 有 `apps/multi-cc-im/dist/cli.js` → prod 模式（`node dist/cli.js`，~50ms 冷启动）
- 没 dist → dev 模式（`tsx src/cli.ts`，~300-1500ms，hook 起来肉眼可见延迟）

dev 等价命令：`pnpm --filter multi-cc-im dev <subcommand>`。

## 单包 / 单文件测试

```bash
# 单包
pnpm --filter @multi-cc-im/bridge test
pnpm --filter @multi-cc-im/cli-cc test

# 单文件 / 一组 pattern
pnpm exec vitest run packages/bridge/src/router.test.ts
pnpm exec vitest run apps/multi-cc-im/src/setup-hooks.test.ts

# watch 模式（TDD 红→绿循环）
pnpm exec vitest packages/bridge/src/router.test.ts
```

## EMFILE / ENOSPC 错误处理验证

相关测试：
`pnpm test packages/cli-cc/src/adapter.watcher-error.test.ts apps/multi-cc-im/src/watcher-error.test.ts apps/multi-cc-im/src/start.test.ts packages/bridge/src/orchestrator.test.ts`。
覆盖监听同步抛错、ready 前错误、运行期错误、飞书连接未完成时的监听失败，
以及停止后的启动流程不会继续启动其他 adapter。故障测试用可控事件源，
无需耗尽主机资源，也不会关闭其他开发服务。

验收：终端说明桥接停止和 IM 转发影响，保留原错误与平台检查命令，给出手动恢复
及 `multi-cc-im start`；退出码为 1、清理 daemon.pid，错误也写入 daemon.log。
真实文件事件集成测试仍依赖主机可分配监听资源；环境耗尽时应明确记录该限制，
不能把此时的测试超时当成错误提示已被验证，也不应自动关闭其他开发任务。

2026-10-22 验证记录：131 项相关测试、typecheck、build 和 bin 版本验证通过；
实际打包 CLI 在 ready 前及飞书连接中的故障注入均验证了提示、日志、PID 清理和
退出码 1。原生全量 1,220 通过 / 10 失败（同一主机监听资源限制）；仅对测试进程
设置 `CHOKIDAR_USEPOLLING=1 pnpm test` 后 1,230 项通过，产品未增加轮询回退。

## 启动前置（首次跑 daemon）

1. macOS（v1 仅支持 macOS — Linux 待测）
2. wezterm 已装（`brew install --cask wezterm`）
3. cc 已登录（`claude` 在某个 wezterm tab 里能起）
4. 飞书 app 已配置（`./bin/multi-cc-im login lark`，填 app_id + app_secret）
5. cc settings.json 已合并 multi-cc-im hook（`./bin/multi-cc-im setup-hooks`）

---

# TDD 写代码节奏（强制）

AGENTS.md「关键规范」「TDD 红→绿→蓝节奏」条的具体实施。任何业务代码（含 adapter 实现 / bridge 路由 / hook receiver）都走此节奏。

## 三步循环

### 1. 红 (RED) — 先写会失败的测试

- 用测试**描述目标行为**（不是验证已有实现）
- 跑 `pnpm test` 确认测试**真的失败** —— 失败原因要明确（功能未实现 / 行为不符），不是 setup 错误（import 错 / 路径错 / 异步未 await）
- 一次只让一个测试 fail，避免多个 fail 互相掩盖

### 2. 绿 (GREEN) — 写最少代码让测试通过

- **不许"顺手"加额外功能**（违反「精准修改」准则）
- **不许写"未来可能用得上"的抽象**（违反「简单优先」准则）
- 跑测试，确认从 RED 转 GREEN
- 此阶段代码丑没关系，重构在第 3 步

### 3. 蓝 (REFACTOR) — 重构 + 覆盖率

- 测试为绿的前提下重构，不允许引入 RED
- 验证覆盖率 ≥ 80%（`pnpm test:coverage`）
- 提交前完整跑：`pnpm typecheck && pnpm test`
- commit message 描述"做什么 + 为什么"，不要描述"怎么做"（diff 已经说明）

## TDD 跟 DD 的衔接

```
DD 锁定方案 → TDD 红 → TDD 绿 → TDD 蓝 → commit → CI
   ↑                                          ↓
   └─── 实测发现 DD 假设错（测试无论如何写不通）┘
```

- DD 假设的行为 → 转成测试 codify
- TDD 实施中发现假设错（测试**无论如何**写不通） → **停下重做 DD**，不在错假设上打补丁
- 这是「禁止补丁」硬规则的 TDD 落地形式

## 测试类型分布

| 类型 | 占比 | 工具 | 何时用 |
|---|---|---|---|
| 单元测试 | 60-70% | vitest | 函数 / 类 / utility |
| 集成测试 | 20-30% | vitest + 真 fs (mkdtemp 沙盒) | adapter ↔ adapter / chokidar ↔ state files / orchestrator e2e |
| E2E 测试 | <10% | （v1 后再加） | 关键用户流（#session 路由 / permission gate / cc Stop forward） |

> 80% 是**最低**门槛。关键路径（路由 / send-text 注入两步法 / hook stdin 解析 / 飞书 WSClient 长连接重连 / permission gate poll/timeout）应当 100%。

## 反 TDD 模式（一律违规）

- **先写实现再补测试**：测试覆盖代码而非行为，倾向 confirm 已有结果（confirmation bias）
- **测试只断言 happy path**：边界 case / 错误 case 全漏，覆盖率虚高
- **测试 mocking 一切**：测的是 mock 行为不是真实行为（AGENTS.md memory: "execFile {input} 在 macOS 不可靠 close stdin" — 真集成跑通才能发现这种 footgun）
- **跳过红色直接绿色**：违反"先看到失败再修"原则；可能把 setup 错误（import 错路径）误判成成功
- **测试名描述实现而非行为**：`test('calls foo() then bar()')` ❌ → `test('routes message to active session')` ✓

## TDD vs 事实验证 DD 的边界

- **TDD**：测的是**自己写的代码**（`packages/*/src/`）
- **事实验证 DD**：测的是**外部库 / cc / 协议**的假设是否成立（如 hook+wezterm 实测、cc PreToolUse 协议字段实测）

两者节奏类似（red→green）但范围不同。事实验证 DD 不需要追求 80% 覆盖率，只需要"假设是否成立"明确即可。

---

# 调试技巧

## daemon 跑了但飞书不收消息

按这个顺序排查：

```bash
# 1. daemon 起来了吗？看日志（总写，tail -f 看实时）
tail -f ~/.multi-cc-im/daemon.log

# 2. 飞书 WSClient 长连接连上了吗？daemon.log 里搜连接 / WS 相关行
grep -iE "ws|连接|connect|ready" ~/.multi-cc-im/daemon.log | tail

# 3. 凭据还在吗？
ls -la ~/.multi-cc-im/credentials/lark.json      # mode 必须 -rw-------

# 4. cc hook 真触发了吗？
ls ~/.multi-cc-im/state/                         # IM 模式跑起来后应看到 <paneId>_<sid>.Stop 等 pane-keyed 文件
```

## 验证 cc hook 已配置

```bash
# 看 settings.json 有没有 multi-cc-im hook
jq '.hooks' ~/.claude/settings.json
# 应该看到 PreToolUse / PermissionRequest / Stop 3 个 event 各一条 multi-cc-im hook 命令
# (SessionStart / SessionEnd 自 DD #61 起已退订)

# 重新合并（已存在的不动，只补缺失 / 替换 stale 路径）
./bin/multi-cc-im setup-hooks
```

setup-hooks 改写之前会自动备份 `~/.claude/settings.json` 到 `settings.json.bak.<ISO>`，要回退就 `cp` 回去。

## 看 hook payload 实际长啥样

cc hook 只能通过 stdin 收 payload。手动模拟（用真实订阅的 event：`PreToolUse` / `PermissionRequest` / `Stop`）：

```bash
# DD #61 起 hook 先过 WEZTERM_PANE 闸门——没有它会静默退出；没有 IMWork 也会
# 静默退出（不写 state 文件）。开 MULTI_CC_IM_DEBUG=1 看 detector / gate 决策 trace。
echo '{"hook_event_name":"Stop","session_id":"x","cwd":"/tmp/x","transcript_path":"/tmp/t.jsonl","stop_hook_active":false}' \
  | MULTI_CC_IM_DEBUG=1 WEZTERM_PANE=0 ./bin/multi-cc-im hook Stop
cat ~/.multi-cc-im/hook-trace.log                # 看 hook 收到 payload + 每一步 gate 决策
```

实际 cc 触发的 payload 也写到 jsonl 里：`~/.claude/projects/<slug>/<sid>.jsonl`（只读，不要改）。

## state dir 累积怎么办

```bash
./bin/multi-cc-im cleanup --dry-run   # 看会删什么
./bin/multi-cc-im cleanup             # 实删
```

`cleanup` 安全可在 daemon 运行时跑 —— 以 wezterm 当前活动 tab 的 paneId 集合为基准，只删 ① tab 已关的孤儿 pane 文件 ② 死掉的 `daemon.pid` ③ DD #61 之前的 legacy 旧文件（`<sid>.SessionStart` 等旧命名）；活动 cc 的文件（paneId 还在 wezterm 里）一律不动。只扫 `~/.multi-cc-im/state/` 这一个目录，不碰 `~/.claude/settings.json` 或任何业务文件。

## 飞书端 routing echo 看不见

每条入站消息都应该有 visible echo（AGENTS.md "routing visible echo required" 硬规则）。如果你 `#frontend hello` 发了但飞书没收到 `→ frontend received` 类反馈：

1. 看 `~/.multi-cc-im/daemon.log` 有没有把消息路由到 `frontend` 的记录（AI 分诊路径会打 `[AI router] target=frontend` 行）
2. 看 `wezterm cli list --format json` —— 有没有叫 `frontend` 的 tab？
3. 没有 → 进 cc TUI 跑 `/rename frontend`，再发一次（tab title 实时 poll，不用重启 daemon）

## permission gate 用不了

`#frontend /1` 没生效有几种可能：

1. **没绑过 IMOrigin**：你最近**没**从飞书发过给 `frontend`，所以 daemon 没写 `<paneId>.IMOrigin` 文件（DD: IMOrigin global）→ hook 的 PreToolUse/PermissionRequest gate 走到 `!existsIMOriginFile` 分支静默退出，cc 落回原生权限流 / timeout default-allow。**解法**：先发个 `#frontend ping` 绑一下（daemon 入站时写 IMOrigin）。
2. **多个 cc 同时跑工具**：cc 对同一 session 串行 PreToolUse，但**多 session 并发**时 `/1` 必须带 tab name 区分（`#frontend /1` 不是裸 `/1`）
3. **超过 30s**：默认放行了，hook 已退出，再发 `/1` 没 polling 进程读取（state-sweep 会把孤儿 Response 文件清掉）
