# multi-cc-im

**English** | [中文](README.zh-CN.md)

Bridge multiple Claude Code (cc) sessions running in **WezTerm or iTerm2** tabs to a Lark/Feishu bot. Reach your cc tabs from mobile IM; replies and tool prompts come back to IM.

> **v0.1.4** (2026-05-20) — inbound images via reply-thread routing. See [`docs/conventions.md`](docs/conventions.md) revision log or [release notes](https://github.com/orime-org/multi-cc-im/releases/tag/v0.1.4).

**Two audiences below**:
- **[Part 1 — Direct use](#part-1--direct-use)** — install, Feishu app setup, IM commands, troubleshooting. Read if you just want to use multi-cc-im.
- **[Part 2 — Secondary development](#part-2--secondary-development)** — repo layout, adapter contracts, DD flow, doc pointers. Read if you want to add an IM / terminal / CLI adapter or fix bugs.

---

# Part 1 — Direct use

## 1.1 Prerequisites

| 需要 | 要求 |
|---|---|
| OS | macOS / Linux（Windows via WSL untested）|
| Node.js | ≥ 22 |
| pnpm | ≥ 9 |
| 终端 | WezTerm ≥ 20240203 **或** iTerm2 ≥ 3.3 (macOS only) |
| Claude Code | `claude` 在 `PATH` + 已登录（Pro / Max 订阅 — AI 路由要调）|
| Lark 账号 | 一个用作 bot 的飞书账号 |

## 1.2 Create the Feishu app (do this FIRST)

按顺序跑完这 7 步。**没跑完不要去 1.3** — daemon 会因为 scope / event 缺连不上飞书。

| 步 | 做什么 | 做完得到 |
|---|---|---|
| 1 | 浏览器开 https://open.feishu.cn/app 登录 → 「创建应用」→「自建应用」→ 填名称 + 描述 | 一个空 app |
| 2 | 左侧「权限管理」→ 勾下面 2 个 scope（看到 `im:message` 单一项就只勾它即可，是 2a+2b 的合集；后台找不到时分项勾 2a + 2b）| bot 能收 IM 事件 + 发文字 + 拉图 |
| 2a | `im:message:send_as_bot` 「以应用身份发送消息」 | bot 主动发出站文字（cc Stop forward / AI 预 ack 等）|
| 2b | `im:message:readonly` 「获取单聊、群组消息」 | 收 IM 入站事件 + 拉 `/im/v1/messages/{id}/resources/{key}` 图（**图片下载也走这个 scope，不另设 `im:resource`**）|
| 3 | 左侧「事件与回调」→「事件订阅」→ 添加 `im.message.receive_v1` | 用户消息进 daemon |
| 3b | 同页加 `card.action.trigger`（卡片按钮回调）| AskUserQuestion / 权限审批按钮起效 |
| 4 | 左侧「应用功能」→「机器人」→ 启用 | app 在飞书里以 bot 身份能被加好友 / 拉群 |
| 5 | 左侧「版本管理与发布」→「创建版本」→ 填版本号 + changelog →「保存并申请发布」| 版本进审批 |
| 6 | 自建 app 你即 admin → 在「我的待审批」点同意 | scope 和 event 真正生效 |
| 7 | 左侧「凭证与基础信息」→ 复制 `App ID` + `App Secret` | 1.3 wizard 要填这两个字段 |

> 后续改 scope（如缺权限）从 step 2 重跑 + step 5+6 重新发版；token rotate（≤ 2h）或重启 daemon 强刷生效。

## 1.3 Install & start

**Recommended**: 全局装 npm 包（一行装完）—

```bash
pnpm install -g multi-cc-im
# 或 npm install -g multi-cc-im
multi-cc-im start
```

> 没用过 pnpm 的话先 `npm install -g pnpm`。

**Alternative**（想 hack 源码 / 跑测试 / 二次开发）— 见 [Part 2](#part-2--secondary-development)。

首次启动跑 wizard：

| 步 | 做什么 | 做完得到 |
|---|---|---|
| W1 | 选终端 `wezterm` 或 `iterm2` | `~/.multi-cc-im/config.toml` 写 `[terminal] type` |
| W2 | (iTerm2 路径) 启 Python API preference + 装 `iterm2` PyPI 包 + 同意 macOS Automation 权限 | iTerm2 adapter 能列 pane / send-text |
| W3 | 选 IM 走 `lark` | 进飞书 setup |
| W4 | 粘贴 1.2 拿到的 `App ID` + `App Secret` | daemon 拿凭据用 SDK 跟飞书 handshake |
| W5 | wizard 验证凭据有效 | 凭据写 `~/.multi-cc-im/credentials/lark.json` (mode 0600) |

完成 = daemon 前台跑 + WS 连飞书 ready + 监控 dashboard 在 `http://127.0.0.1:40719`。

> Ctrl+C 停 daemon。一台机器只能一个 daemon。
> 非交互式：`./bin/multi-cc-im login lark --app-id cli_xxx --app-secret xxx`。
> 重新配：再跑 `./bin/multi-cc-im start`，wizard 用旧值预填，回车保留 / 方向键改。

## 1.4 IM commands cheat sheet

> daemon 启后 IM mode 默认 OFF。先 IM 端发 `/start` 或 `/start off` 开。然后在每个 cc TUI 跑 `/rename <name>` 给 tab 起名（纯数字名会撞 pane id，wizard 会警告）。

| 你做 | daemon 做 |
|---|---|
| `<text>`（无 `#`）| AI 分诊到匹配 tab + 剥前缀 + 发任务 |
| `#<tab> <text>` | 精确发到该 tab + 该 tab 成 sticky 默认 |
| `#<a> #<b> <text>` | 多 tab 同发（不动 sticky 默认）|
| `#all <text>` | 广播到所有 named tab |
| `#<tab> /clear`（或 cc 任何 `/` slash）| 转发为 cc 自己的 slash command |
| `#<tab> /1` | ask 模式下允许 pending tool 调用 |
| `#<tab> /2` | ask 模式下拒绝 pending tool 调用 |
| 发图（不带文字）| daemon 暂存图 30 min + 回 `🖼️ 图已收到` |
| 在图上 reply `#<tab> <text>` | image path + 文字一起投给该 cc tab；cc Read 读图 |
| `/start` | 开 IM mode auto-approve（cc 工具调用不打扰）|
| `/start off` | 开 IM mode ask（每个工具调用先转 IM 等 `/1` `/2`）|
| `/stop` | 关 IM mode（cc 回复留 TUI、工具走 cc 原生菜单）|
| `/list` | 列当前可寻址 tab |
| `/current` | 当前 sticky 默认 + IM mode 状态 |
| `/help` | 路由示例 |

> 模糊匹配支持（`#front` → `frontend` 若唯一）。`/start` echo 里有 `✓ terminal: <id>` 行告诉你 daemon 启动时选了哪个终端。

## 1.5 cc → IM (反向通知)

cc 端三种事件自动转发到 IM，不需要你做配置：

| 触发 | IM 端看到 | 你做 |
|---|---|---|
| cc 回合结束（Stop hook）| `[<tab>] <last_assistant_message>` | 看回复，需要继续就接着发文字 |
| cc 调 AskUserQuestion 选择题（计划 / 设计选项）| 题目 + 编号选项 + 「你的考虑」 | 回编号 / 选项 label / 自然语言 / 自由文本（5 min 超时，逾时 cc 自己继续）|
| cc 编辑 `.claude/* / .git/* / .env*` 等敏感路径 | auto 模式 → 审计行 `🛡️ daemon auto-allowed`；ask 模式 → 编号选项「同意一次 / 始终允许 / 拒绝」| auto 模式不用回；ask 模式回编号 / 自然语言（2 min 超时，逾时 plain allow）|

## 1.6 Monitor dashboard

浏览器开 `http://127.0.0.1:40719`（只 bind loopback，不可远程）。SSR 静态 HTML 无 JS：

| Tab | 内容 |
|---|---|
| sessions (default) | live pane 列表 + addressable 标志 |
| cost | 近期 cc session token + USD 估算（LiteLLM 价表 vendored）|
| errors | orchestrator `onError` ring buffer（last 200）|

顶部 sticky header 一直显示：pid · uptime · 终端 · IM 连接状态。无自动刷新，点 `↻ refresh` 或 F5 / Cmd+R。

JSON 路由：`/api/state` `/api/sessions` `/api/errors` `/api/cost`。

## 1.7 Where things live

| 路径 | 用途 |
|---|---|
| `~/.multi-cc-im/credentials/lark.json` | 飞书凭据（mode 0600）|
| `~/.multi-cc-im/config.toml` | 终端选择 + cached binary paths |
| `~/.multi-cc-im/state/` | runtime state, daemon 自管 |
| `~/.multi-cc-im/inbound/lark/images/` | 入站图缓存（mode 0600）|
| `~/.multi-cc-im/daemon.log` | daemon stderr 镜像 — 总写，`tail -f` 看 |
| `~/.multi-cc-im/hook-trace.log` | cc-hook 子进程 trace — **仅 `MULTI_CC_IM_DEBUG=1` 才写** |

`MULTI_CC_IM_HOME` env 覆盖根目录。

## 1.8 Troubleshooting

| 现象 | 修法 |
|---|---|
| start 报 `wezterm CLI not found` | `which wezterm` 验证；或写 `[external_paths] wezterm = "..."` 到 `~/.multi-cc-im/config.toml` |
| start 报 `python3 not found` (iTerm2) | `brew install python3` 或 `xcode-select --install` |
| start 报 `cannot connect to iTerm2 Python API` | iTerm2 → Settings → General → Magic → 勾「Enable Python API」+ 启 iTerm2 后重跑 |
| `cannot import iterm2` | `python3 -m pip install --user --break-system-packages iterm2` |
| start 报 `another daemon already running` | `cat ~/.multi-cc-im/state/daemon.pid` → kill 或 rm 文件 |
| daemon 起了 IM 收不到消息 | 重跑 `login lark` 验证凭据；确认 1.2 step 5+6 发版本 + 同意 |
| 图入站报 `HTTP 400 code=99991672 Access denied` | 1.2 step 2b/2c scope 漏了 — 补 + 发版 + 重启 daemon |
| `#frontend` 报 not found | cc TUI 里 `/rename frontend`；IM 发 `/list` 验证 |
| IM 收不到工具审批 | 必须 `/start off`；至少先用 IM 寻址过该 cc 一次 |
| hook 注册抱怨现有 hook | 恢复 `~/.claude/settings.json.bak.<ts>` 备份 |
| Ctrl+C 后 IM 收僵尸消息 | `rm -f ~/.multi-cc-im/state/{IMWork,IMOrigin,daemon.pid}` |
| `state/` 堆积 | `./bin/multi-cc-im cleanup --dry-run` 预览 / 去掉 `--dry-run` 真扫 |

## 1.9 CLI reference

| 命令 | 描述 |
|---|---|
| `multi-cc-im start [adapter]` | 启 daemon（前台）。无 arg → 跑 wizard。首次跑会备份 `~/.claude/settings.json` 后注册 cc hook |
| `multi-cc-im login <adapter> [--<field> <value>...]` | 非交互式凭据配置（env vars 如 `LARK_APP_ID` 也认）|
| `multi-cc-im cleanup [--dry-run]` | 扫陈旧 state 文件，daemon 跑着也安全 |
| `multi-cc-im --help` / `-h` | help |
| `multi-cc-im --version` / `-v` | version |

退出码：`0` 成功 / `1` runtime fail / `2` usage error。

---

# Part 2 — Secondary development

## 2.1 Stack

| 维度 | 选择 |
|---|---|
| 语言 | TypeScript strict, ESM-only (`"type": "module"`) |
| 运行时 | Node ≥ 22 |
| 包管理 | pnpm workspaces (monorepo) |
| 测试 | Vitest (unit + integration) |
| 打包 | tsup (CLI bundling) |

## 2.2 Repo layout

```
multi-cc-im/
├── apps/multi-cc-im/        — CLI binary (tsup → dist/cli.js)
├── packages/
│   ├── shared/              — Cross-package types + zod schemas
│   ├── storage-files/       — TOML + JSON file stores
│   ├── im-lark/             — Lark/Feishu adapter (@larksuiteoapi/node-sdk)
│   ├── term-wezterm/        — WezTerm CLI adapter
│   ├── term-iterm2/         — iTerm2 Python API adapter (ephemeral helper)
│   ├── cli-cc/              — Claude Code hook adapter
│   ├── monitor/             — local dashboard (hono SSR)
│   └── bridge/              — Router + orchestrator + AI-routed dispatch
├── bin/multi-cc-im          — bash wrapper
├── docs/                    — architecture, dev, conventions, DD specs
└── CLAUDE.md                — project rules (mandatory before contributing)
```

## 2.3 Dev commands

| 命令 | 用途 |
|---|---|
| `pnpm install` | 装所有 workspace deps |
| `pnpm --filter multi-cc-im dev <args>` | tsx 直跑 CLI 源码 |
| `pnpm typecheck` | `tsc --noEmit` 跑 9 包 |
| `pnpm test` | 跑所有 vitest |
| `pnpm test:watch` | watch 模式 |
| `pnpm test:coverage` | V8 coverage（阈值 ≥ 80% line）|
| `pnpm --filter <pkg> exec vitest run <file>` | 跑单测文件 |
| `pnpm --filter multi-cc-im build` | tsup 打包 → `apps/multi-cc-im/dist/cli.js` |

## 2.4 TDD rhythm

红 → 绿 → 蓝。先写失败 test 锁目标行为 → 最少代码让它过 → 重构 + 覆盖 ≥ 80%。test 无论如何写不通过 → 停下来重做 DD，**不在错假设上打补丁**。详见 [`CLAUDE.md`](CLAUDE.md) + [`docs/dev.md`](docs/dev.md)。

## 2.5 Adding an IM adapter (Telegram / Slack / etc.)

| # | 做什么 |
|---|---|
| 1 | `packages/im-<name>/` 镜像 `packages/im-lark/` 布局 |
| 2 | 实现 `IMAdapter` 接口：`start(handler)` / `send(text, replyCtx)` / `stop()` |
| 3 | `IMReplyContext` 加 `imType: '<name>'` 变体（discriminated union）|
| 4 | export `setupSchema: AdapterSetupSchema`（per-field `{key, label, hint, secret, schema}` + 可选 `validate(values)`）|
| 5 | `apps/multi-cc-im/src/adapters.ts` 加 registry entry：`id` / `setupSchema` / `persist` / `buildAdapterRuntime` |
| 6 | 凭据写 `~/.multi-cc-im/credentials/<im>.json`（mode 0600）— **不**调 OS keychain (DD: credentials persistence) |
| 7 | 可选：`docs/setup-<im>.md` 走读 + registry 设 `guideDocPath` |

## 2.6 Adding a terminal adapter (tmux / kitty / Ghostty / etc.)

参考 [`docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md`](docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md) + `packages/term-iterm2/` 实测代码。

| # | 做什么 |
|---|---|
| 1 | `packages/term-<name>/` 建包 |
| 2 | `TerminalIdSchema`（`packages/shared/src/adapter/storage.ts`）加 `<name>` literal |
| 3 | 实现 `TermAdapter & TermListPanes`：`name='<name>'` / `start` / `listPanes` / `sendText` / `sendKeystroke` / `stop` |
| 4 | **两步发送**强制：`sendText(content)` → orchestrator sleep ~300ms → `sendKeystroke('\r')`。单步 send-with-newline 禁 |
| 5 | pane-id detector：终端有 env var 标识 pane（如 `TMUX_PANE`）→ 加 `TaggedDetector` 到 `packages/cli-cc/src/pane-id-detectors.ts` `DEFAULT_DETECTORS` |
| 6 | `start.ts` wizard 加 selectTerminal 选项 + adapter 条件创建 |
| 7 | 测试覆盖 listPanes / sendText / sendKeystroke / detector（mirror term-iterm2 tests）|

> `termId` 必须随 Stop payload 端到端传，不许下游 `typeof paneId` 反推（参 [memory: feedback_carry_facts_dont_infer]）。

## 2.7 Adding a CLI adapter (codex / aider / etc.)

cc adapter 耦合 cc-specific hook（`PreToolUse` / `Stop` / `PermissionRequest`）+ jsonl transcript。新 CLI 需等价扩展点；若无 → 提 DD 先不动 — 见 [`CLAUDE.md`](CLAUDE.md)「不破坏现有 cc 进程」。

## 2.8 Major decision (DD) flow

凡影响安全模型 / 长期维护 / 跨包接口 / 「用现有 SDK」原则的改动必走 5 步 DD：候选枚举（必含「不做 X」）→ 每候选尽调 → 对比矩阵（证据可引用）→ 推荐+理由 → 用户拍板。DD 落 `docs/superpowers/specs/<date>-<topic>-dd.md`。详细规则 [`CLAUDE.md`](CLAUDE.md)「重大决策 DD 流程」。

## 2.9 Documentation pointers

| 文档 | 何时读 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | AI 干活纪律（根因 / DD / 编码准则）|
| [`docs/conventions.md`](docs/conventions.md) | 状态总表 + 修订日志 + 项目特定规范 |
| [`docs/architecture.md`](docs/architecture.md) | 架构图 + 状态 schema + 文件 IPC |
| [`docs/dev.md`](docs/dev.md) | dev 命令 + TDD 节奏 + 调试 |
| [`docs/setup-feishu.md`](docs/setup-feishu.md) | 飞书 app 详细 step-by-step（1.2 是摘要版）|
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | DD 报告（一锁一份）|
| [`docs/competitors.md`](docs/competitors.md) | 同类工具对比 |

## 2.10 License

See [`LICENSE`](LICENSE) (MIT).
