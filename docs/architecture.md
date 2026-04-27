# 架构与数据存储

> CLAUDE.md 的硬约束补充。本文记录架构图、包依赖、目录结构、数据存储 schema、外部 CLI 工具路径策略。任何与 CLAUDE.md「核心约束」「关键规范」冲突的实现 = 违规，回 CLAUDE.md 处置。

## 技术栈（计划）

Node.js 22+ | TypeScript 5.x strict | pnpm workspace monorepo | tsup | Vitest | better-sqlite3 | iLink 协议（vendored 自 `Tencent/openclaw-weixin` v2.1.7）| pino + pino-roll | zod

## 架构（4 维度 adapter + 1 分析层）

```
┌─────────────────────────────────────────────────┐
│   core: router · session map · message bus     │
└──┬─────────┬──────────┬──────────┬─────────────┘
   │         │          │          │
  IM       Term       CLI       Storage      Analytics
(wechat) (wezterm)(claude-code)(sqlite)    (/usage /cost)

v1 各 1 份；接口先抽全，新加 adapter 直接插入即可
```

| Adapter | v1 实现 | 后续候选 | 集成模式 |
|---|---|---|---|
| IM | wechat (iLink, vendored `Tencent/openclaw-weixin` v2.1.7) | telegram / slack / 飞书 / discord | 长轮询/WS/Webhook 各异 |
| Term | wezterm cli | tmux / zellij / ghostty | 子命令 wrapper |
| CLI | claude-code（hook 路线） | codex / gemini / aider | hook 模式（v1） vs spawn 模式（v2） |
| Storage | sqlite | postgres | 接口固定 |

## 包依赖方向

```
shared（接口类型，零依赖）
   ↑                ↑               ↑               ↑
im-wechat    term-wezterm    cli-claude-code    storage-sqlite
                            ↑                          
                          core ──────► analytics
                            ↑
                         apps/bridge
```

**严格边界**：adapter 之间互不 import；core 只 import shared 的接口；apps/bridge 装配所有 adapter。任何 adapter 内部不允许直接 import 另一个 adapter（要通过 core 的 message bus）。

## 目录结构（计划）

```
packages/
├── shared/         # IMAdapter / TermAdapter / CLIAdapter / StorageAdapter 接口 + 类型
├── core/           # router · session map · message bus · @ 解析器 · CLI 路径探测
├── im-wechat/      # iLink 客户端（vendored 自 `Tencent/openclaw-weixin` v2.1.7 → lib/ilink/）+ IMAdapter 实现
├── term-wezterm/   # wezterm cli wrapper + 实现 TermAdapter
├── cli-claude-code/# hook + transcript jsonl parser + 实现 CLIAdapter
├── storage-sqlite/ # events / sessions / usage 表 + 迁移
└── analytics/      # /usage /cost 命令族 + 定时报告
apps/
└── bridge/         # 装配 adapters 的主进程，pino 日志
scripts/            # SessionStart.sh / Stop.sh / UserPromptSubmit.sh hook
docs/
├── architecture.md # 本文（架构 + schema）
├── competitors.md  # 不直接采用的端到端项目（决策记录）
├── dev.md          # 开发命令
└── superpowers/specs/  # brainstorming 输出的设计 doc + DD 报告
```

## 数据存储

```
~/.multi-cc-im/
├── config.toml           # session friendly_name 映射 / 路由偏好 / 价格表 / wezterm 路径缓存
├── data/
│   ├── events.db         # SQLite: events · sessions · usage
│   └── inbox/<sid>/      # 微信进来的图片/文件落盘（cc Read 用）
└── logs/
    └── bridge-YYYY-MM-DD.log  # pino-roll 日轮转
```

凭据（`bot_token` / `WECHAT_PROFILE` / 任何敏感 token）走 OS keychain（macOS Keychain / Linux secret-tool / Windows credential manager），**不写 `config.toml`、不写日志、不写环境变量**。

## SQLite Schema（events 表）

字段以 hook+wezterm 实测报告（`docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md`）为依据：

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,                    -- cwd（用 CLAUDE_PROJECT_DIR / stdin.cwd，已 realpath）
  cli TEXT NOT NULL,                        -- 'claude-code' / 'codex' / ...
  role TEXT NOT NULL,                       -- user | assistant | tool_use | tool_result | system
  model TEXT,
  tokens_in INT,
  tokens_out INT,
  tokens_cache_read INT,
  tokens_cache_5m_create INT,               -- ephemeral_5m_input_tokens（cache TTL 5m，价格档1）
  tokens_cache_1h_create INT,               -- ephemeral_1h_input_tokens（cache TTL 1h，价格档2）
  service_tier TEXT,                        -- standard | priority（实测：jsonl message.usage.service_tier）
  parent_uuid TEXT,                         -- jsonl conversation tree 关联字段
  is_sidechain INTEGER NOT NULL DEFAULT 0,  -- 0=主线 / 1=subagent 子线（v1 仅消费 0）
  iterations_json TEXT,                     -- 多次 API 调用累积（assistant.usage.iterations[]）
  tool_name TEXT,
  tool_input_json TEXT,                     -- PreToolUse stdin.tool_input 完整结构
  tool_response_json TEXT,                  -- PostToolUse stdin.tool_response（stdout/stderr/duration_ms）
  content_blob BLOB,                        -- gzip 压缩的原文（可关）
  cost_usd REAL                             -- 派生，价格表按 (service_tier × cache TTL) 分档算
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_project ON events(project);
```

> `cost_usd` 计算公式 + 价格表来源仍待 DD（CLAUDE.md「关键设计假设」表「价格表」行 `?`）。

## 外部 CLI 工具路径策略

cc hook 子进程的 PATH 是 cc 重组的 plugins PATH，**不含 `wezterm`**（实测确认，见 hook+wezterm DD 报告 H3 节）。但 multi-cc-im 是开源项目，不能假设用户的 wezterm 装在哪里。

### 探测顺序（macOS v1 范围）

```
1. 用户 shell PATH（multi-cc-im 启动时是用户 shell 起的，PATH 完整）
   → which wezterm
2. macOS Apple Silicon Homebrew
   → /opt/homebrew/bin/wezterm
3. macOS Intel Homebrew
   → /usr/local/bin/wezterm
4. macOS .app bundle
   → /Applications/WezTerm.app/Contents/MacOS/wezterm
```

未来 Linux 支持时按需扩展（`/usr/bin/wezterm` / `/home/linuxbrew/.linuxbrew/bin/wezterm`）。

### 实施约束

- **启动时探测一次**，结果缓存到 `~/.multi-cc-im/config.toml` 的 `wezterm.path` 字段
- 缓存路径**每次启动校验存在性**（用户可能升级或卸载 wezterm，文件可能已不在）
- 校验失败 → 重新探测；探测失败 → `process.exit(1)` 明确报错并指引安装：
  ```
  wezterm CLI not found. Install via: brew install --cask wezterm
  Or set WEZTERM_PATH env / wezterm.path in config.toml
  ```
- **禁止 hardcode 任何 wezterm 绝对路径** —— 含 hook 脚本、命令模板、测试 fixture
- **禁止"找不到就 fallback 用 PATH"**（PATH 假设是个补丁，cc hook 子进程没 wezterm；启动时探测才是根因解决）

### 同样策略适用于其他外部 CLI

任何 multi-cc-im 调用的外部 CLI（`wezterm` / `claude` / `git` / 未来的 `tmux` 等）都遵循「启动探测 + 缓存 + 启动校验 + 失败 fail-fast」模式。封装在 `packages/core/src/cli-resolver.ts`（v1 实施时建立）。

## 多机部署约束（已锁定）

multi-cc-im 仅在**一台机器**上跑（CLAUDE.md「关键设计假设」表「多机」行 ✓）。理由：iLink 协议层 `getupdates` cursor 是全局共享，多 instance polling 会让 cursor 互相吃消息。
