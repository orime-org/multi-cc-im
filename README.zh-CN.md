# multi-cc-im

[English](README.md) | **中文**

通过腾讯 iLink Bot API 把跑在 WezTerm tab 里的多个 Claude Code (cc) session 暴露到微信。`@<tab-name>` 寻址；不带 `@` 的纯消息由 AI 路由到最匹配的 cc tab。包含微信端工具审批通路 (`/1` 允许 / `/2` 拒绝)，可扩展更多 IM / 终端 / CLI。

---

# Part 1 — 直接使用

## 前置依赖

- macOS / Linux（Windows 需 WSL，未实测）
- Node.js ≥ 22
- pnpm ≥ 9
- WezTerm ≥ 20240203
- 已登录的 Claude Code CLI（`claude` 在 `PATH` 中可执行；AI 路由需要 cc Pro/Max 订阅）
- 一个专用做 bot 的微信账号

## 安装

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm --filter multi-cc-im build
```

入口是 `./bin/multi-cc-im`，自动选择 `apps/multi-cc-im/dist/cli.js`（已 build）或 `tsx src/cli.ts`（dev fallback）。

可选：软链到 `PATH`：

```bash
ln -s "$(pwd)/bin/multi-cc-im" ~/.local/bin/multi-cc-im
```

## 初始化（一次性）

### 1. 微信登录

```bash
./bin/multi-cc-im login wechat
```

终端打印二维码，手机微信扫码。Token 存到 `~/.multi-cc-im/credentials/wechat.json`（mode 0600）。

### 2. 注册 cc hook

```bash
./bin/multi-cc-im setup-hooks
```

幂等地合并到 `~/.claude/settings.json`，加 `PreToolUse` + `Stop` 两条 hook 指向 `./bin/multi-cc-im hook <event>`。其他工具的 hook 保留不动。改动前会写 `.bak.<timestamp>` 备份。

## 启动

```bash
./bin/multi-cc-im start
```

daemon 前台运行，stderr 输出日志。Ctrl+C 停止 daemon 并清理 `state/IMWork`、`state/IMOrigin`、`state/daemon.pid`。

每台机器只能跑一个 daemon。已有 daemon 时再次 `start` 会 exit 1 并打印已存在的 PID。

## Daemon 命令（在微信发）

每条命令是发给 bot 微信会话的单条消息。

| 命令 | 效果 |
|---|---|
| `/list` | 列当前 wezterm tabs，标出哪些可寻址（已 `/rename`）|
| `/help` | 路由示例 |
| `/current` | 显示当前 sticky target + IMWork 状态 |
| `/start` | 开启 IM 模式 + **auto-approve**（cc 工具调用直接放行）|
| `/start off` | 开启 IM 模式 + **ask** 模式（每次工具调用转到微信走 `/1` / `/2`）|
| `/stop` | 关闭 IM 模式（cc 回复留 cc TUI；工具审批走 cc 原生菜单）|

每次 daemon start 会重置 `IMWork` 为 OFF。每段远程会话都需要重新 `/start`。

## 路由（在微信发）

| 消息 | 效果 |
|---|---|
| `@frontend hello` | 发给 tab title 是 `frontend` 的 cc，并设为 sticky `current` |
| `@front hello` | 模糊匹配（4 级 fallback：`=exact` → exact → 短前缀 → glob；歧义列候选并拒绝）|
| `@frontend @api sync` | 多目标分发；**不**改 `current` |
| `@all stop everything` | 广播给所有命名的 cc |
| `@frontend /clear` | 转发 `/clear` 进 cc TUI（cc 自己当 slash 命令处理）|
| `@frontend /1` | 权限允许（仅当有 pending PreToolUse）|
| `@frontend /2` | 权限拒绝 |
| `给前端写个登录页` | **纯消息 — AI 路由**：daemon 起一次性 `claude --print` 子进程做分诊（哪个 tab 合适 + 提取纯净意图）。路由到选中的 tab；echo `→ frontend｜AI: 「写个登录页」` |

**给 cc 起名**：在 cc TUI 里跑 `/rename <name>`，wezterm tab title 变成 `<name>`，IM 就能用 `@<name>` 寻址。没 `/rename` 的 tab 在 `/list` 能看到，但**不能从 IM 寻址**。

**Tab title 约束**：避免纯数字（会跟 wezterm pane ID 撞）。`/start` echo 会主动警告。

## 工具审批通路（仅 ask 模式）

`/start off` 生效时，从微信寻址 cc 后，cc 调工具会触发这条往返：

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 10 秒内回复，否则默认放行:
  @frontend /1   = 允许
  @frontend /2   = 拒绝
```

| 回复 | 效果 |
|---|---|
| `@frontend /1` | 允许 — cc 继续 |
| `@frontend /2` | 拒绝 — cc 取消并询问替代方案 |
| 10 秒内不回复 | 默认放行 |

只读工具（`Read` / `Grep` / `Glob` / `NotebookRead`）自动放行，不打扰 IM。

## 文件位置

| 路径 | 用途 |
|---|---|
| `~/.multi-cc-im/config.toml` | daemon 配置（首次登录后生成）|
| `~/.multi-cc-im/credentials/wechat.json` | `bot_token` + 登录态（mode 0600）|
| `~/.multi-cc-im/state/wechat-cursor` | iLink getupdates cursor（重启续接）|
| `~/.multi-cc-im/state/IMWork` | `{auto:bool}` — IM 模式开关（文件存在 = ON）|
| `~/.multi-cc-im/state/IMOrigin` | 最新 IM 回复上下文（每条入站覆盖）|
| `~/.multi-cc-im/state/daemon.pid` | daemon 活性锁 |
| `~/.multi-cc-im/state/<paneId>_<sid>.Stop.<ts>` | cc 回复事件（daemon 消费）|
| `~/.multi-cc-im/state/<paneId>_<sid>.PermissionRequest.<id>.json` | in-flight 工具审批请求 |
| `~/.multi-cc-im/state/<paneId>_<sid>.PermissionResponse.<id>.json` | 审批结果 |
| `~/.multi-cc-im/inbox/wechat/<sid>/` | 解密后的入站图片 / 文件（cc 用 `Read` 读取）|

`MULTI_CC_IM_HOME` 环境变量可覆盖根目录。

## CLI 参考

| 命令 | 说明 |
|---|---|
| `multi-cc-im start` | 启动 bridge daemon（前台长跑）|
| `multi-cc-im login wechat` | 扫码登录 + 保存 `bot_token` |
| `multi-cc-im setup-hooks` | 注册 cc hook 到 `~/.claude/settings.json`（幂等）|
| `multi-cc-im cleanup [--dry-run]` | 清理过期 state 文件；daemon 跑着也安全 |
| `multi-cc-im hook <event>` | cc 内部 hook 入口（由 `~/.claude/settings.json` 调用）|
| `multi-cc-im --help` / `-h` | 打印 help |
| `multi-cc-im --version` / `-v` | 打印版本 |

退出码：`0` 成功，`1` 运行时失败，`2` 用法错误。

## 故障排查

### `multi-cc-im start` 报 "wezterm CLI not found"

```bash
which wezterm   # 必须能解析
# 或手动写入路径：
echo '[wezterm]' >> ~/.multi-cc-im/config.toml
echo 'path = "/Applications/WezTerm.app/Contents/MacOS/wezterm"' >> ~/.multi-cc-im/config.toml
```

### `multi-cc-im start` 报 "another daemon already running"

```bash
# 看锁住的 PID：
cat ~/.multi-cc-im/state/daemon.pid

# 真在跑就正常停（Ctrl+C 它自己的终端，或 `kill <pid>`）。
# PID 是僵尸（被 SIGKILL）就直接删锁：
rm ~/.multi-cc-im/state/daemon.pid
```

### Daemon 跑着但微信收不到消息

```bash
# 1. cursor 在推进吗？
ls -la ~/.multi-cc-im/state/wechat-cursor

# 2. bot_token 还有效吗？
./bin/multi-cc-im login wechat   # 必要时重登

# 3. cc hook 真的有触发吗？
ls -la ~/.multi-cc-im/state/*.Stop.*
```

### `@frontend` 报 "not found"

- 进 cc TUI 跑 `/rename frontend`。
- 在微信发 `/list` 看哪些 tab 可寻址。

### 工具审批转发不到 IM

1. 是不是 `/start off` 模式？（默认 `/start` 是 auto-approve，不会转发）
2. 你之前从微信寻址过这个 cc 吗？（没 `IMOrigin` → 没 thread 可转发）
3. daemon 还活着吗？（`cat ~/.multi-cc-im/state/daemon.pid`）

### `setup-hooks` 报现有 hook 冲突

从备份恢复：

```bash
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<timestamp> ~/.claude/settings.json
```

### Ctrl+C 后 IM 还在收僵尸消息

```bash
ls ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid
# 都该不存在。还在的话手动删：
rm -f ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/IMOrigin ~/.multi-cc-im/state/daemon.pid
```

### `state/` 攒了一堆文件

```bash
./bin/multi-cc-im cleanup --dry-run   # 预演
./bin/multi-cc-im cleanup             # 真清
```

---

# Part 2 — 二次开发

## 技术栈

- TypeScript strict, ESM only (`"type": "module"`)
- Node ≥ 22
- pnpm workspaces (monorepo)
- Vitest（单元 + 集成测试）
- tsup（CLI bundling）

## 仓库结构

```
multi-cc-im/
├── apps/multi-cc-im/        — CLI binary（tsup bundle 到 dist/cli.js）
├── packages/
│   ├── shared/              — 跨包类型 + zod schema
│   ├── storage-files/       — TOML + JSON 文件存储（config / 凭据 / cursor / queue）
│   ├── im-wechat/           — iLink Bot 适配器（vendored Tencent OpenClaw）
│   ├── term-wezterm/        — wezterm CLI 适配器
│   ├── cli-cc/              — Claude Code hook 适配器
│   ├── bridge/              — 路由器 + orchestrator + AI 分诊
│   └── openclaw/            — Tencent OpenClaw vendor shim
├── bin/multi-cc-im          — Bash 包装脚本（解析 dist 或 tsx）
├── docs/
│   ├── architecture.md      — 完整架构 + state schema + IPC
│   ├── dev.md               — 开发命令 + TDD 节奏 + 调试技巧
│   ├── competitors.md       — 跟相关项目的对比
│   └── superpowers/specs/   — DD 报告（每个重大决策一份）
└── CLAUDE.md                — 项目规则（贡献前必读）
```

## 开发命令

| 命令 | 说明 |
|---|---|
| `pnpm install` | 安装所有 workspace 依赖 |
| `pnpm --filter multi-cc-im dev <args>` | 用 tsx 直接跑源码 |
| `pnpm typecheck` | 全 workspace `tsc --noEmit` |
| `pnpm test` | 跑全部 vitest 用例 |
| `pnpm test:watch` | vitest watch 模式 |
| `pnpm test:coverage` | vitest + V8 覆盖率报告 |
| `pnpm --filter @multi-cc-im/bridge exec vitest run src/router.test.ts` | 跑单个测试文件 |
| `pnpm --filter multi-cc-im build` | bundle CLI 到 `apps/multi-cc-im/dist/cli.js` |
| `pnpm --filter multi-cc-im smoke` | 跑 bundled CLI（`node dist/cli.js`）|

覆盖率门槛：全 workspace 行覆盖 ≥ 80%。CI 强制。

## TDD 节奏

参考 `CLAUDE.md` 和 [`docs/dev.md`](docs/dev.md)：先写会失败的测试 codify 目标行为 → 最少代码让它通过 → 重构 + ≥80% 覆盖。当前设计下测试无论如何写不通 → 停下重做 DD，**不许**在错假设上打补丁。

## 加新 IM 适配器（Telegram / 飞书 / 等）

1. 在 `packages/im-<name>/` 镜像 `packages/im-wechat/` 的目录结构。
2. 实现 `@multi-cc-im/shared` 的 `IMAdapter` 接口：
   - `start(handler: IMHandler): Promise<void>`
   - `send(text: string, replyCtx: IMReplyContext): Promise<void>`
   - `stop(): Promise<void>`
3. 在 `IMReplyContext` 加一个 discriminated-union 变体（`imType: 'telegram' | 'lark' | ...`）。
4. 在 `apps/multi-cc-im/src/start.ts` 按配置开关把它接进 orchestrator。
5. 凭据落 `~/.multi-cc-im/credentials/<im>.json`（mode 0600）。**不许**调 OS keychain — 见 [DD: credentials 持久化策略](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)。

## 加新终端适配器（tmux / kitty / 等）

1. 建 `packages/term-<name>/`。
2. 实现 `@multi-cc-im/shared` 的 `TermAdapter` + `TermListPanes`：
   - `start(): Promise<void>`
   - `listPanes(): Promise<TermPaneInfo[]>` — 必须返 tab title
   - `sendText(paneId, content): Promise<void>` — 仅 paste（不带提交）
   - `sendKeystroke(paneId, key): Promise<void>` — 提交键（`\r`）
   - `stop(): Promise<void>`
3. 严格走两步发送：paste（`sendText`）→ ~300ms → 提交（`sendKeystroke('\r')`）。**禁止**单步 send-with-newline — 见 `CLAUDE.md`「send-text 注入两步法」。

## 加新 CLI 适配器（codex / aider / 等）

cc 适配器（`packages/cli-cc/`）耦合到 cc 特有的 hook（`PreToolUse` / `Stop`）+ jsonl transcript。新 CLI 需要等价的扩展点；没有的话**先做 DD**再实施 — 见 `CLAUDE.md`「不破坏现有 cc 进程」。

## 重大决策（DD）流程

任何影响安全模型、长期维护负担、跨包接口、或「用现有 SDK」准则的改动都要在 `docs/superpowers/specs/<date>-<topic>-dd.md` 出 DD 报告。DD 必须穷举候选（含「不做 X」）+ 证据导向的对比矩阵 + 推荐可追溯到矩阵某格证据。详见 `CLAUDE.md`「重大决策 DD 流程」。

## 文档导航

| 文档 | 用途 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 项目规则 + 禁止清单（先读这个）|
| [`docs/architecture.md`](docs/architecture.md) | 架构图、state schema、文件 IPC |
| [`docs/dev.md`](docs/dev.md) | 开发命令 + TDD 节奏 + 调试技巧 |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | DD 报告（每条锁定决策一份）|
| [`docs/competitors.md`](docs/competitors.md) | 为什么不直接采用项目 X |

## License

见 [`LICENSE`](LICENSE)。
