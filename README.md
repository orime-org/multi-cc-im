# multi-cc-im

个人本地 bridge：通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到微信，实现"在公司用控制台 + 外面用微信"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> **状态**：v1 实施完成 —— 6 packages + 1 app 全部到位（`apps/multi-cc-im/` 可执行 CLI）。剩余 follow-up：真实 wezterm + cc + wechat 端到端 smoke test、image/voice 入站实测、tg / 飞书 IM adapter、analytics。

## Quick Start

### 1. 装 wezterm（一次性）

```bash
brew install --cask wezterm
```

multi-cc-im 启动时探测 wezterm 路径并缓存到 `~/.multi-cc-im/config.toml [external_paths].wezterm`，**禁止 hardcode**。详见 [docs/architecture.md「外部 CLI 工具路径策略」](docs/architecture.md#外部-cli-工具路径策略)。

### 2. 装 multi-cc-im

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm typecheck && pnpm test  # 可选验证
```

CLI 入口位于 `apps/multi-cc-im/src/cli.ts`。开发期 `pnpm --filter multi-cc-im dev <subcommand>` 通过 `tsx` 跑 TS 源码；后续打包发布时 v2 加 `tsup` bundle 步骤。

### 3. 首次登录 wechat（QR 扫码）

```bash
./bin/multi-cc-im login wechat
# 等价于 pnpm --filter multi-cc-im dev login wechat（dev 期 alias）
```

终端打印 QR；微信扫码 + 确认 → bridge 把 `bot_token` 落到 `~/.multi-cc-im/credentials/wechat.json`（mode 0600，跟 Tencent OpenClaw vendor 上游一致；[DD: credentials 持久化策略](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)）。

### 4. 配 cc hooks（每个 cc 跑前一次）

把以下加到 `~/.claude/settings.json` 的 `hooks` 段（**绝对路径** 指向 repo 根的 `bin/multi-cc-im` bash wrapper）：

```json
{
  "hooks": [
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook SessionStart" },
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook UserPromptSubmit" },
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook PreToolUse" },
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook PostToolUse" },
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook Stop" },
    { "matcher": "*", "type": "command",
      "command": "/abs/path/to/multi-cc-im/bin/multi-cc-im hook SessionEnd" }
  ]
}
```

`bin/multi-cc-im` 是一个 bash wrapper 自动用 workspace 内的 `tsx` 跑 `apps/multi-cc-im/src/cli.ts`（Node 22-24 default 不能 resolve TS-ESM 风格 `import './foo.js'` → `./foo.ts`，需要 tsx 或 v2 的 tsup bundle）。

> v2 会加全局 `multi-cc-im` 命令（tsup bundle + `npm publish` / `pnpm link --global`），届时 hook 命令简化为 `multi-cc-im hook <event>` 不依赖绝对路径。

### 5. 起 bridge daemon

```bash
./bin/multi-cc-im start
```

后台长跑 iLink 长轮询 + 监 cc hook events.jsonl + wechat IncomingMessage → cc TUI 路由。Ctrl+C 优雅 shutdown（flush current_session 状态 + 释放所有 adapter）。

## 路由语法（用户视角）

按 [DD: 路由语法 G'](docs/superpowers/specs/2026-05-04-routing-syntax-dd.md) 锁定：

| 在微信发什么 | 干啥 |
|---|---|
| `hello` | 派给 `current_session`（last-explicit-mention 粘性；单 cc 自动 = 唯一那个） |
| `@frontend hello` | 派给 friendly_name = `frontend` 的 session + 设 current |
| `@fr hello` | 短前缀（tmux 4 级 fallback：id → =strict → exact → prefix → glob）；歧义会列候选 + 拒绝 |
| `@frontend @api 同步` | 多目标派发，**不动 current** |
| `@all stop everything` | 广播给所有活 session |
| `@list` / `@help` / `@current` | 控制命令，bot 回 echo 不派发 |

bot 派给 cc 前每条都给微信端 `→ frontend received` 等 visible echo（CLAUDE.md「路由 visible echo 必须有」硬规则）。

## Project Structure

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/         CLI binary：start / login wechat / hook <event>
└── packages/
    ├── shared/              4 维 adapter 接口 (IM/Term/CLI/Storage) + 类型 + zod
    ├── storage-files/       atomic-write / cursor / config / pending-queue / credential
    ├── im-wechat/           IMAdapter(wechat) + iLink 协议 vendor (Tencent/openclaw-weixin v2.1.7)
    ├── term-wezterm/        TermAdapter(wezterm) + PaneAlive 4 信号状态机
    ├── cli-cc/              CLIAdapter(cc) + hook payload zod + state files + injection queue
    └── bridge/              router 4 级 fallback / SessionRegistry / orchestrator
```

每个包都有 `src/` + 测试，`pnpm test` 全套跑过 700+ 单测；coverage ≥ 80% 全维度门槛。

## Documentation

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **必读硬约束**：核心约束 / DD 流程 / 关键规范 / 编码行为准则 / 禁止清单 |
| [docs/architecture.md](docs/architecture.md) | 架构图 / 包依赖 / 数据存储 / 外部 CLI 路径策略 |
| [docs/dev.md](docs/dev.md) | 开发命令 + TDD 节奏 |
| [docs/competitors.md](docs/competitors.md) | 不直接采用的端到端项目（决策记录）|
| [docs/superpowers/specs/](docs/superpowers/specs/) | 8 篇 DD 报告（协议 / hook / adapter / storage / pricing / pane-alive / keychain / routing）|

## Development

```bash
pnpm install
pnpm typecheck      # 7 workspaces tsc --noEmit
pnpm test           # 56 files / 713 tests
pnpm test:coverage  # 同上 + v8 coverage（80% threshold 全维度门槛）
```

TDD 节奏（红 → 绿 → 蓝），重大决策 5 步 DD 流程，commit / PR 一律不带 AI 作者署名 —— 详见 [CLAUDE.md](CLAUDE.md)「关键规范」+ [docs/dev.md](docs/dev.md)。

## License

MIT
