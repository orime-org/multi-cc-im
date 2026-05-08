# multi-cc-im

[English](README.md) | **中文**

一个个人本地 bridge —— 通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code (cc) session** 暴露到微信。在公司用控制台、外面用微信，两边随时切。包含 `@session` 路由、IM 端工具权限审批（PreToolUse → 微信回 `/1` 允许 / `/2` 拒绝），以及可扩展的多 IM / 终端 / CLI 适配器架构。

> **状态**：v1.4 实施完成 —— 7 packages + 1 app 全到位（`apps/multi-cc-im/` 是 CLI 可执行入口）。v1.2 加入 IMWork（手动远程模式开关）+ IMOrigin（IM reply ctx）+ read-only 工具白名单 + daemon reaper；v1.3 加入 daemon liveness PID lock（`state/daemon.pid`）+ 双开检测 + Ctrl+C 清理；v1.4 把 cc hook 订阅收敛到 `PreToolUse` + `Stop` 两件事，state 文件改成 **paneId-keyed**（`<paneId>_<sid>.*` / `<paneId>.IMOrigin`），用 `wezterm cli list` 当 live-pane ground truth —— 不再用 PaneAlive 多信号状态机（[DD: pane-keyed state files](docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)）。Follow-up：真实环境 WezTerm + cc + 微信端到端 smoke 测试、Telegram / 飞书 IM 适配器、analytics package。

---

## 适合谁用

如果**所有这三条**都成立，multi-cc-im 对你有价值：

1. 你在 WezTerm（一个或多个 tab）里跑 cc。
2. 你偶尔会离开桌面，但还想用手机继续指挥 cc。
3. 你愿意用自己的微信账号当 bot 端点（这是个**个人** bridge，单 owner、单机器）。

**不适合**：

- 你没用 cc，或者你在 VS Code / Cursor / iTerm 里用 cc（终端适配器 v1 只支持 wezterm）。
- 你想要多租户 SaaS —— multi-cc-im 设计上就是 local-only。
- 你没有微信账号（Telegram / 飞书 适配器在 roadmap 里，还没 ship）。

---

## 用起来什么感觉

```
你在公司：              [WezTerm tab "frontend" 里跑 cc TUI]
你在路上：              微信 → "@frontend run the tests"
                        微信 ← "→ frontend received"
                        ... cc 在跑、回复 ...
                        微信 ← "[frontend] all 47 tests pass."

cc 想跑 Bash：           微信 ← "[frontend] 准备跑工具:
                                    Bash(rm -rf node_modules)
                                  ⏳ 10 秒内回复，否则默认放行:
                                    @frontend /1   = 允许
                                    @frontend /2   = 拒绝"
你：                     微信 → "@frontend /2"
                        微信 ← "→ frontend permission 拒绝"
                        ... cc 取消，换个方案问你 ...
```

整个过程 WezTerm tab 里的 cc TUI **完全不被打扰** —— multi-cc-im 不 spawn cc、不包 stdin/stdout。你随时坐回笔记本，照样从那个 cc session 接着键盘聊，跟微信端无关。

---

## Quick Start

### 1. 装 WezTerm（一次性）

```bash
brew install --cask wezterm
```

multi-cc-im 启动时探测 WezTerm 路径并缓存到 `~/.multi-cc-im/config.toml [external_paths].wezterm`。**禁止 hardcode 路径** —— 详见 [docs/architecture.md「外部 CLI 工具路径策略」](docs/architecture.md#外部-cli-工具路径策略)。

### 2. 装 multi-cc-im

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm typecheck && pnpm test            # 可选验证（约 5s，903 单测）
pnpm --filter multi-cc-im build        # 推荐 —— 见下面 "production vs dev"
```

CLI 入口是 `bin/multi-cc-im` bash wrapper。**Production 模式**（推荐）：跑过 `pnpm build` 后 wrapper 自动用 `apps/multi-cc-im/dist/cli.js`（冷启动 ~50ms）。**Dev 模式**：dist 不存在时退化到 `tsx src/cli.ts`（冷启动 ~300-1500ms）。cc hook 一轮对话会触发好几次 —— **生产用必须 production 模式**，否则手机端打字延迟肉眼可见。

### 3. 首次登录微信（扫码）

```bash
./bin/multi-cc-im login wechat
# 等价于 dev：pnpm --filter multi-cc-im dev login wechat
```

终端打印二维码；微信扫描 + 确认 → bridge 把 `bot_token` 持久化到 `~/.multi-cc-im/credentials/wechat.json`（mode 0600，跟 Tencent OpenClaw 上游一致；[DD: 凭据持久化策略](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)）。token 不会落到 git / 日志 / console / 任何非 0600 位置。

### 4. 配置 cc hook（每个 cc 安装一次）

```bash
./bin/multi-cc-im setup-hooks
```

幂等合并 —— 自动检测 `~/.claude/settings.json` 当前状态，写入 multi-cc-im 的 **2 条 hook 命令**（用当前 repo 的绝对路径）：

- 文件不存在 → 创建
- 存在但 `{}` 空或没有 `hooks` 字段 → 添加
- 已有别的工具的 hook → 保留它们，把 multi-cc-im 的 2 条追加上去
- 已有 stale 的 multi-cc-im hook（比如你换了 repo 路径）→ 用当前路径替换

2 个事件：

| 事件 | 用途 |
|---|---|
| `PreToolUse` | 把工具权限审批转发到微信（`/1` 允许 / `/2` 拒绝，10s 超时默认放行）—— `matcher: "*"`, `timeout: 10` |
| `Stop` | cc 的回复送进 bridge router 转发到微信 |

`SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PostToolUse` **不订阅**。hook 入口先看 `process.env.WEZTERM_PANE`，没有就静默退出（cc 不在 wezterm 里跑 —— 比如 ssh / VS Code 终端 —— multi-cc-im 没东西可桥接）。有的话，paneId 进入每一个 state 文件的命名（见 [State files reference](#state-files-reference)）。cc 自己的 transcript jsonl（`~/.claude/projects/<dir>/<sid>.jsonl`）就是对话内容的 source of truth；以后做 analytics 直接读它就行。

**安全**：写入前自动备份原 `settings.json` 到 `settings.json.bak.<ISO-时间戳>`（后悔了 `cp <backup> ~/.claude/settings.json` 还原）。

如果你想手改：复制 [`examples/claude-settings.json`](examples/claude-settings.json) 里的 `hooks` 块到 `~/.claude/settings.json`，把 `ABS_PATH` `sed` 替换：

```bash
sed "s|ABS_PATH|$(pwd)|g" examples/claude-settings.json
```

### 5. 启动 bridge daemon

```bash
./bin/multi-cc-im start
```

长跑的后台进程：iLink 长轮询 + 监听 `~/.multi-cc-im/state/` 的 cc hook 事件 + 把微信 `IncomingMessage` 路由到 cc TUI。`Ctrl+C` 触发 graceful shutdown（释放所有 adapter；in-memory 的 `current_session` 粘性指针丢失 —— 重启后从微信重新 `@<name>` 即可）。

`state/` 目录是**只监听用**的 —— 不累积 cc 对话内容（cc 自己的 transcript jsonl 已经是 source of truth）。它装一组按 `<paneId>`（live wezterm pane id）作 key 的短命 hook ↔ daemon IPC 文件，加 3 个顶级 lock / 状态文件（`IMWork`, `daemon.pid`, `wechat-cursor`）。完整 schema 看本文末尾的 [State files reference](#state-files-reference)。

daemon 启动时跑 sweep，用 `wezterm cli list --format json` 当 live-pane ground truth：paneId **不在**当前 live 集合里的 `<paneId>_<sid>.*` / `<paneId>.IMOrigin` 文件全清，外加 stale `daemon.pid`（PID 死或 lstart 不匹配）和老版本遗留的 legacy state 文件。手动跑同一个 sweep：

```bash
./bin/multi-cc-im cleanup --dry-run    # 预览要删什么
./bin/multi-cc-im cleanup              # 实删
```

daemon 跑着的时候跑也安全 —— live paneId 的文件都保留。如果 wezterm 路径解析不到，命令会拒绝跑（没有 live-pane 快照就没有 ground truth，不会盲删）。

### 6. 给 cc session 起名（推荐）

cc 跑起来后，用它内建的 `/rename` 命令起个易记名：

```
/rename frontend
```

cc 会持久化这个名字到自身 session 状态（`claude --resume` 也带回），并通过 OSC 推到 wezterm tab title。multi-cc-im 在每次 IM 事件 poll `wezterm cli list --format json`，把 tab title 当路由 key：

- 微信 `@frontend hello` → 路由到 tab title 是 `frontend` 的 cc
- 微信回显 `→ frontend received` 确认路由成功
- cc 回复转回微信时前缀 `[frontend]`，方便区分多个 session

**没 `/rename`**：该 cc 没有可寻址的名字，router 回显 `未 /rename` 拒绝分发。tab title 实时 poll —— rename 之后下一轮 IM 往返就能看到新名字，**不用重启 daemon**。（数字 tab title 会在 `/start` 回显里触发警告，因为它跟 wezterm pane id 长得一样会让 matcher 困惑。）

`@multi-cc-im` 是保留名，router 不会匹配到任何 cc；它是 bridge 命令的 namespace（见下文）。

---

## 路由语法（用户视角）

按 [DD: 路由语法 G'](docs/superpowers/specs/2026-05-04-routing-syntax-dd.md)，原 DD 后两处更新：(a) 路由 key 用 wezterm tab title（cc `/rename`），不用 config-file `[friendly_names]` map；(b) bridge 命令通过 `@multi-cc-im /<cmd>` 寻址，不用裸词 `@list` / `@help` / `@current`（这些会跟 cc tab title 冲突）。

| 你在微信发什么 | 干什么 |
|---|---|
| `hello` | 路由到 `current_session`（last-explicit-mention 粘性；只有一个 cc 时自动 = 那一个）|
| `@frontend hello` | 路由到 tab title 是 `frontend` 的 session，并设置为 `current` |
| `@fr hello` | 短前缀（4 级 fallback：`=strict` → exact → prefix → glob）；歧义时列候选拒绝 |
| `@frontend @api sync` | 多目标分发；**不**改 `current` |
| `@frontend /clear` | 把 `/clear` 转发进 cc TUI —— cc 自己当 slash 命令处理 |
| `@all stop everything` | 广播给所有活的 session |
| `@frontend /1` | **权限允许**（仅当有 pending PreToolUse 时 —— 见下文）|
| `@frontend /2` | **权限拒绝** |
| `@multi-cc-im /list` | 列出活的 cc session（tab title + pane id）。bot 回显，不分发到任何 cc |
| `@multi-cc-im /help` | 内建帮助文本 |
| `@multi-cc-im /current` | 显示 `current_session` + IMWork 状态 |
| `@multi-cc-im /start` | **开启 IM 模式**（cc 回复 + 工具审批都转发到微信）|
| `@multi-cc-im /start auto` | **开启 IM 模式 + auto-approve** —— cc 工具调用直接放行不问 IM（[DD #64](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md)）|
| `@multi-cc-im /stop` | **关闭 IM 模式**（cc 回复留 cc TUI，工具审批走 cc 原生菜单）|

每条入站消息分发到 cc 之前，bot 都会回显一条可见反馈给微信端（如 `→ frontend received`）。这是 CLAUDE.md「路由必须有可见 echo」硬规则。

---

## IM 模式开关：`/start` 跟 `/stop`（手动切换）

按 [DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)。multi-cc-im 有一个全局开关，从微信端控制：

```
@multi-cc-im /start         →  IM 模式 ON, ask 模式（cc 工具调用转微信，等 /1 /2）
@multi-cc-im /start auto    →  IM 模式 ON, auto-approve（cc 工具直接放行，不问 IM）
@multi-cc-im /stop          →  IM 模式 OFF（cc 回复留 cc TUI，工具审批走 cc 原生菜单）
@multi-cc-im /current       →  显示 current 目标 + IMWork 状态（含 auto-approve flag）
```

- **daemon 启动总是重置为 OFF**。每次去远程之前必须从微信发一次 `/start`。auto-approve 也会一起重置 —— 重启 = 安全默认。
- **OFF 时**，发到 cc 的 IM 消息（`@frontend hello` 等）会被拒绝并提示 `"❌ IMWork off — 请先发 @multi-cc-im /start 开启 IM 模式"`。bridge 命令和权限响应仍然能用。
- **ON 时**，`/start` 回显会列出当前活的 cc session 跟使用规则。
- `/start auto` 给工具密集场景用（"分析这个 repo" 类一次性命令），cc 连发 30+ Bash/Edit 时每个都 IM 回 `/1` 拇指疼。按 [DD: PreToolUse auto-approve](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md)。切回 ask: 重发 `/start`（不带 auto）。

这是总开关。下一节说的 per-session 转发只在 IMWork 开着时才生效。

## 工具权限审批（PreToolUse → IM 转发）

按 [DD: 权限转发](docs/superpowers/specs/2026-05-07-permission-forward-dd.md) + [DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)。当 IMWork 开着 **且**你最近从微信跟该 cc 聊过，那个 cc 的工具审批 prompt 会转发到微信：

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 10 秒内回复，否则默认放行:
  @frontend /1   = 允许
  @frontend /2   = 拒绝
```

回复两个字符：

| 微信回复 | 效果 |
|---|---|
| `@frontend /1` | 允许 —— cc 继续跑工具 |
| `@frontend /2` | 拒绝 —— cc 取消并问你换个方案 |
| 10s 内不回复 | 默认放行 —— cc 继续 |

hook 决策树（按顺序，最便宜的检查在前）：

1. **read-only 工具**（`Read` / `Grep` / `Glob` / `NotebookRead`）→ 自动放行，不转发 IM（cc 自己对这些工具也不弹 TUI 菜单 —— 转发只会刷屏）。
2. **IMWork off** → cc TUI 显示原生权限菜单（3 选项 `Yes / Yes don't ask again / No`）。你在键盘前直接选。
3. **IMWork on + auto-approve 开着**（`/start auto`）→ 自动放行，不转发 IM，不需要 `/1`（[DD #64](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md)）。
4. **IMWork on 但该 cc 没绑 IM 线程**（你没从微信 `@<tab>` 过它）→ 退化到 cc TUI 菜单。
5. **daemon 没跑**（Ctrl+C 了 / 崩了 / 没启动）→ 退化到 cc TUI 菜单 —— 没人 listen 时干等 10s timeout 没意义（[DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)）。
6. **其他** → 转发到微信，10s 窗口。

所以同一个 cc 可以**逐轮**在 "cc TUI 菜单" 跟 "IM 往返" 之间切换：

- 你在公司，直接在 cc TUI 打字 → IMWork off → TUI 弹菜单 ✓
- 你出门，发 `@multi-cc-im /start` 然后 `@frontend run tests` → IMWork on + IMOrigin 设上 → 下一次工具 prompt 来手机上 ✓
- cc 回完一轮 → IMOrigin 自动删 → 如果 cc 自己又调工具 → 没 IMOrigin → 退化到 TUI 菜单（你还在外面但 cc 没线程回到你那）

**设计上不做白名单 / 黑名单**。如果想让 cc 别再问某个命令，去 cc TUI 里选选项 2（"Yes, and don't ask again for similar commands in `<cwd>`"）。cc TUI 自己写规则到 project-local `.claude/settings.local.json`。multi-cc-im 不会代你做这件事（让 daemon 根据远程 IM 输入写用户 dotfile —— 太冒险）。

---

## 内部怎么工作

（给开发者 / 贡献者看的。完整 schema 见 [docs/architecture.md](docs/architecture.md)。）

```
                                 4 adapter dimensions
       ┌────────┐    iLink long-poll     ┌────────┐
微信   │  IM    │ ──────────────────► ┌──┤ bridge │
client │adapter │ ◄────────────────── │  │  core  │
       └────────┘  iLink send (reply) │  │        │
                                      │  │ router │
       ┌────────┐  wezterm cli send-text │ matcher │
WezTerm│ Term   │ ◄─────────────────── │  │ (tab    │
tabs   │adapter │     (Step 1 paste +  │  │  title) │
       │listPan │      Step 2 \r submit)│  │ parser │
       └────────┘  wezterm cli list ─►  │  │        │
                                       │  └────────┘
       ┌────────┐  hook stdin / stdout │
cc     │  CLI   │ ◄─────────────────── ┘
hooks  │adapter │       chokidar watch state files
       │+ state │ ◄─────────────────── 
       └────────┘
                                       
       ┌────────────┐
       │ Storage    │  toml + 0600 JSON + state files (no SQL DB)
       │ adapter    │  
       └────────────┘
```

**bridge orchestrator** 串起 3 条主要数据流：

1. **入站**（微信 → cc）：`IM 长轮询 → wezterm cli list（live panes）→ router.parse → matcher（按 tab title 4 级 fallback）→ orchestrator.dispatch → 写 <paneId>.IMOrigin → term.sendText（Step 1）+ sleep + sendKeystroke '\r'（Step 2）`。两步发送是**强制**的 —— 单步 `--no-paste $'\r'` 注入会让 cc TUI 把它当快捷键解释（[DD: hook+wezterm 实测](docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)）。

2. **出站**（cc Stop hook → 微信）：hook 入口先看 `process.env.WEZTERM_PANE`，没有就静默退出。拿到 `<paneId>` 之后过 3 个短路 guard（无 `IMWork` / 无 `<paneId>.IMOrigin` / daemon 死 → return void 不写文件）。全过的话，写 `<paneId>_<sid>.Stop.<ts>` → daemon 的 chokidar 拣起来 → 读 `<paneId>.IMOrigin`（per-pane reply ctx 落在磁盘）→ IM send → 删 IMOrigin（one-shot）。ONE-SHOT 意味着每条 cc 回复转发回微信前你都得有一条新的 `@<tab> body` —— 防你直接在 cc TUI 打字误转发到微信。

3. **权限审批**（PreToolUse → IM `/1` `/2` → hook subprocess 解锁）：hook subprocess 走上面那决策树。走到 forward 步骤时，写 `<paneId>_<sid>.PermissionRequest.<id>.json`，每 200ms poll `<paneId>_<sid>.PermissionResponse.<id>.json`（最多 10s）。daemon 把 prompt 转发到 IM。用户回复 → daemon 写 response 文件。hook subprocess 读 → 给 cc 发 `permissionDecision: allow|deny` → 删两个文件 → 退出。daemon 端 reaper 在 10s 后兜底删（hook subprocess 异常死亡的兜底）。

所有 cc session **都属于同一个微信账号**（你自己的 —— owner-only ACL 由 iLink 协议层强制）。multi-cc-im 只在**一台机器**上跑（[CLAUDE.md "Multi-machine: only one"](CLAUDE.md) —— iLink `getupdates` cursor 是全局共享，多 instance 互相吃消息）。

---

## 项目结构

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/         CLI 二进制：start / login / setup-hooks / cleanup / hook
└── packages/
    ├── shared/              4 维 adapter 接口（IM/Term/CLI/Storage）+ 类型 + zod
    ├── storage-files/       atomic-write / cursor / config / pending-queue / credential
    ├── im-wechat/           IMAdapter(wechat) + iLink 协议 vendor（Tencent/openclaw-weixin v2.1.7）
    ├── term-wezterm/        TermAdapter(wezterm) + listPanes capability（wezterm cli list 当 ground truth）
    ├── cli-cc/              CLIAdapter(cc) + hook payload zod + paneId-keyed state files + injection queue
    ├── bridge/              router 4 级 fallback / orchestrator（按 paneId 索引）
    └── openclaw/            Tencent/openclaw-weixin plugin SDK 的 minimal shim
```

每个 package 都有 `src/` 目录加测试；`pnpm test` 跑全套，每维度覆盖率 ≥ 80%。

---

## 文档

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **必读硬约束**：核心规则 / DD 流程 / 关键规范 / 编码准则 / 禁止清单 |
| [docs/architecture.md](docs/architecture.md) | 架构图 / 包依赖 / 数据存储 / 3 条关键数据流 / 外部 CLI 路径策略 |
| [docs/dev.md](docs/dev.md) | 开发命令 + TDD 节奏 + 调试技巧 |
| [docs/competitors.md](docs/competitors.md) | 调研过但未直接采用的端到端项目（决策记录）|
| [docs/superpowers/specs/](docs/superpowers/specs/) | DD 报告（协议 / hook / adapter / storage / pricing / pane-alive / keychain / routing / 权限转发 等）|

---

## 开发

```bash
pnpm install
pnpm typecheck                        # 8 workspaces tsc --noEmit
pnpm test                             # vitest 单测套件
pnpm test:coverage                    # 同上 + v8 coverage（80% 阈值）
pnpm --filter multi-cc-im build       # tsup → apps/multi-cc-im/dist/cli.js
pnpm --filter multi-cc-im dev <cmd>   # tsx src/cli.ts（dev 别名，无需 build）

# 跑单文件测试（TDD 红→绿循环）
pnpm exec vitest run packages/bridge/src/router.test.ts
pnpm exec vitest packages/bridge/src/router.test.ts        # watch 模式
```

TDD 节奏（红 → 绿 → 重构）、5 步 DD 流程做重大决策、commit / PR 不带 AI 作者署名 —— 见 [CLAUDE.md](CLAUDE.md)「关键规范」和 [docs/dev.md](docs/dev.md)。

---

## Troubleshooting（常见问题）

### `multi-cc-im start` 报 "wezterm CLI not found"

要么装 wezterm（`brew install --cask wezterm`），要么在不寻常位置安装的话手写路径：

```bash
# 手动写 ~/.multi-cc-im/config.toml
[external_paths]
wezterm = "/path/to/your/wezterm"
```

### daemon 跑着但微信收不到消息

```bash
# 1. 看日志
tail -f ~/.multi-cc-im/logs/multi-cc-im-$(date +%F).log

# 2. iLink cursor 在动吗？
ls -la ~/.multi-cc-im/state/wechat-cursor

# 3. bot_token 还有效吗？
ls -la ~/.multi-cc-im/credentials/wechat.json   # 应该是 -rw-------

# 4. cc hook 真触发了吗？
ls ~/.multi-cc-im/state/   # cc 跑完一轮之后应该看到 <paneId>_<sid>.Stop.* 或 <paneId>.IMOrigin 文件
```

如果 cc 跑完一轮后没出现 `<paneId>_*` 开头的文件 → cc hook 没装（或者你不在 wezterm 里跑 cc —— `WEZTERM_PANE` 没设，hook 静默退出）。重跑 `./bin/multi-cc-im setup-hooks`。

### `@frontend` 报 "not found" 但 cc 明明在跑

multi-cc-im 按 **wezterm tab title** 路由，不是按目录或 session id。如果 tab 还是默认的 `cc` 或 cwd：

1. 在 cc TUI 里跑 `/rename frontend`（名字会通过 OSC 推到 wezterm tab title）。
2. 重新发 `@frontend hello` —— tab title 在每次 IM 事件都会通过 `wezterm cli list --format json` 重新 poll。

没 `/rename` 就**没有**可寻址的名字（v1.4 没有 sid 前缀 fallback —— 路由 key 就是 tab title）。`@multi-cc-im /list` 可以看当前能寻址哪些。

### IM 收不到工具权限 prompt（`@frontend /1` 永远没机会用）

按概率排序的 4 个原因：

1. **没 `/start`**。daemon 默认 local 模式（cc TUI 处理审批）。**修**：从微信发一次 `@multi-cc-im /start`。
2. **该 cc 没绑 IM 线程**。即使 IMWork on，你必须**当前轮里至少从微信跟那个 cc 对话过一次**。如果 cc 自主调工具但你从来没 `@<tab>` 过它，hook 退化到 cc TUI 菜单。**修**：发一次 `@frontend ping` 绑线程。
3. **该工具是只读的**。cc 调 Read / Grep / Glob / NotebookRead 这种不需要审批 —— multi-cc-im 也自动放行避免刷屏 IM。只有"破坏性"工具（Bash / Edit / Write / WebFetch 等）才转发 IM。
4. **超过 10 秒窗口才回**。hook 已经默认放行退出了。`/1` 没人接（polling subprocess 没了 —— daemon reaper 10s 内会清孤儿文件）。

### `@frontend /1` 回复不生效

- **忘了 tab name**：裸 `/1` 没 `@<tabname>` 会被当普通内容，不是权限响应。即使只跑一个 cc，`@<tabname> /1` 也是必须的。
- **过窗口**：跟上一节第 4 条一样 —— 10s 默认放行已经触发。

### setup-hooks 跟现有 hook 冲突

setup-hooks **不会破坏**已有的非 multi-cc-im hook，是 merge 行为。如果状态怪，两条恢复路径：

```bash
# A. 还原到 setup-hooks 上次备份
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<最新-ISO> ~/.claude/settings.json

# B. 推倒重来（手加的别的 cc hook 会丢）
mv ~/.claude/settings.json ~/.claude/settings.json.before-redo
./bin/multi-cc-im setup-hooks
```

### `multi-cc-im start` 报 "another daemon already running"

multi-cc-im 通过 `state/daemon.pid` 强制单实例（按 [DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)）。两个 daemon 同时 polling iLink 会互相吃消息。三种恢复方式：

```bash
# 1. 真有 daemon 在跑（你忘了）：
pkill -f 'multi-cc-im start'
./bin/multi-cc-im start

# 2. 确认没 daemon 在跑（比如上次被 SIGKILL 了）：
rm ~/.multi-cc-im/state/daemon.pid
./bin/multi-cc-im start

# 3. 不确定的话，错误信息给了 PID —— 看那个 PID 实际是啥：
ps -p <pid> -o command=
# 输出是 `node ... multi-cc-im start` → 真 daemon，kill 掉
# 否则 → PID 被别的进程复用了，rm 那个 lock 文件
```

第 3 种 case 极少（home-dir-daemon 场景下 PID 复用窗口巨大），lock 文件含 `startedAt` 时间戳能检测到 —— 真复用了，multi-cc-im 自动覆盖不报错。

### Ctrl+C 之后微信还在收 stale 消息

不应该 —— daemon stop 删 `IMWork` + `daemon.pid`，hook 转发前两个都查。如果还看到 stale 转发：

```bash
# 看 lock 文件清没清
ls ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid 2>&1
# 都该报 "No such file or directory"

# 没清的话手动清：
rm -f ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid
```

如果两个文件都没了但 IM 还在路由 → daemon 不知怎么还在跑 —— `pkill -f 'multi-cc-im start'` 保险起见。

### state/ 目录文件累积

daemon 跑久了正常会累积。`./bin/multi-cc-im cleanup --dry-run` 预览，`./bin/multi-cc-im cleanup` 实删。daemon 跑着也安全。

### 风险提示：微信账号被封

iLink Bot API 走腾讯官方协议跟微信通信 —— 比 灰产 / iPad 协议安全得多（那些**会**让你账号被封）。但"个人 bridge"用法在流量异常时仍有小概率每号风险。缓解办法：

- 用小号当 bot，主号别用。
- 别每秒发 > 1 条；multi-cc-im 自带节流，但腾讯端 bot 速率限制独立存在。
- 别拿你的 bot 转发别人的消息（owner-only ACL 在协议层就强制了，正是为这件事）。

---

## State files reference

multi-cc-im 持久化的所有东西都在 `~/.multi-cc-im/state/` 下。这个目录是**只监听用**的：cc 自己的 transcript jsonl（`~/.claude/projects/<dir>/<sid>.jsonl`）是 cc 对话内容的 source of truth；multi-cc-im 只做 hook subprocess ↔ daemon 之间短命文件的桥接。所有写入走 storage-files 的 atomic-write helper（mode-0600，同目录 tmp + fsync + rename）。

按 [DD: pane-keyed state files](docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)，v1.4 把 hook ↔ daemon 文件按 `<paneId>`（hook 入口从 `process.env.WEZTERM_PANE` 拿到的 live wezterm pane id）作 key。live-pane 集合来自 `wezterm cli list --format json` —— paneId 不在这个集合里的 state 文件都是 sweep 候选。`WEZTERM_PANE` 没设的 hook 会静默退出（cc 不在 wezterm 里 —— 没东西可桥接）。

两类：**top-level** 文件（每 daemon 一份）+ **paneId-keyed** 文件（按 pane / 按 pane+session）。

### Top-level 文件

| 文件 | Schema | 写入者 | 删除者 | 用途 |
|---|---|---|---|---|
| `daemon.pid` | JSON `{ pid: number, startedAt: string }`（`startedAt` = `ps -o lstart= -p <pid>` 输出，用来防 PID 复用 —— [DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)）| daemon `start` | daemon `stop`（Ctrl+C / graceful）；state-sweep 当 PID 死或 lstart 不匹配 | Lock 文件：hook 走 forward 路径前用 `isDaemonAlive()` 检查。同时强制单实例 —— 第二次 `start` 如果第一个 daemon 的 PID + lstart 都匹配就直接报错 |
| `IMWork` | JSON `{auto:boolean}`（文件存在性 = IM 模式 ON；`auto:true` = auto-approve 模式，[DD #64](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md)；老 0-byte 文件兼容视为 `{auto:false}`）| router 处理 `@multi-cc-im /start [auto]`（orchestrator handler）| router 处理 `/stop`；daemon `start`（强制重置 OFF）；daemon `stop`（Ctrl+C 清理）| 主 IM 模式开关。**不存在** = hook 短路（cc TUI 处理审批）；**存在** = IM 模式开，微信发 `@frontend body` 会分发到 cc。`auto:true` 时 hook PreToolUse 直接放行不走 IM 转发 |
| `wechat-cursor` | 文本文件（单字符串）| iLink getupdates 循环每次 cursor 推进时（`atomicWrite`）| 正常运行从不删 | iLink 长轮询 cursor。daemon 重启之间持久化，避免 daemon-down 窗口期消息丢失 |

### paneId-keyed 文件

`<paneId>` 是 wezterm pane id（数字）。`<sid>` 是 cc session 的 UUID v4（如 `bbfd2f1f-5f89-447c-b5df-2032ce18e2a7`）。`<id>` 是 8 字符 hex 请求 id。

| 文件 | Schema | 写入者 | 删除者 | 用途 |
|---|---|---|---|---|
| `<paneId>.IMOrigin` | JSON 按 `imType` 区分的 discriminated union —— wechat 是 `{ imType: 'wechat', to: string, contextToken?: string }`（telegram / 飞书 variant 已预留）| daemon orchestrator 每次有 IM 分发到该 pane 时（最新 ctx 覆盖，[DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)）| orchestrator 在 cc Stop forward 完后（one-shot）；daemon `start` sweep；state-sweep 当 paneId 不再 live | per-pane 的 IM reply 上下文。cc 的回复会 thread 回你最近的那条 IM。hook 走 forward 路径前 stat 这个文件。每个 pane 单 key —— 不带 sid 分量，因为用户的脑模型是「我在跟哪个 tab 聊」对应的是 pane，不是 session id |
| `<paneId>_<sid>.Stop.<ts>` | JSON `{ last_assistant_message: string }`（`<ts>` 是 ISO 风格如 `2026-05-08T01-43-40-131Z`）| cc Stop hook subprocess（过 3 个短路 guard 之后：IMWork on、`<paneId>.IMOrigin` 设上、daemon 活）| daemon 的 chokidar handler 转发到 IM 后（典型寿命 ~100ms）；state-sweep 当 paneId 不再 live | per-轮 assistant 回复队列。daemon 当时 down 文件可能堆几条；下次 daemon start 按字典序（= 时间序）逐条处理 |
| `<paneId>_<sid>.PermissionRequest.<id>.json` | JSON `{ requestId, toolName, toolInput, createdAt }` | cc PreToolUse hook subprocess（过完决策树 guard）| hook subprocess 自己 polling 完后（≤10s）；daemon 端 reaper 兜底（chokidar add 触发 10s setTimeout）；state-sweep 当 paneId 不再 live | hook → daemon「请去问用户这个工具调用」|
| `<paneId>_<sid>.PermissionResponse.<id>.json` | JSON `{ requestId, decision: 'allow'\|'deny', reason }` | orchestrator 在 IM 用户回 `@<tab> /1` 或 `/2` 之后 | hook subprocess 读完后；daemon reaper 兜底 | daemon → hook「用户回 allow / deny」|

### 生命周期不变量

- **paneId 在 `wezterm cli list` 里** = pane 活着 → 该 paneId 下的 `<paneId>.IMOrigin` 和 `<paneId>_<sid>.*` 全保留。
- **paneId 不在 live 集合里** = wezterm pane 没了（关 tab / 退 wezterm）→ state-sweep 把该 paneId 前缀的所有文件清光。**没有多信号 PaneAlive** —— live wezterm 快照本身就是 ground truth。
- **`daemon.pid` 存在 + `process.kill(pid, 0)` 成功 + `ps -o lstart=` 一致** = daemon 真在跑。否则是 stale lock；下次 `daemon start` 自动覆盖、sweep 也清。
- **`IMWork` 存在 + `<paneId>.IMOrigin` 存在 + daemon 活** = hook PreToolUse / Stop 走 forward 路径的**唯一**状态。其他任何组合 → 短路（PreToolUse 走 cc TUI；Stop return void）。
- **`wechat-cursor`** 是唯一每次 daemon 重启都保留的文件 —— 它是 iLink 协议状态，没法从本地数据重建。

### 快速排查

```bash
ls -la ~/.multi-cc-im/state/

# 顶级 lock 文件在不在？
test -f ~/.multi-cc-im/state/daemon.pid && jq . ~/.multi-cc-im/state/daemon.pid
test -f ~/.multi-cc-im/state/IMWork && echo "IM 模式 ON" || echo "IM 模式 OFF"

# 已绑定 IM 线程的 pane（每轮 @<tab> 过的 pane 各一个）：
ls ~/.multi-cc-im/state/*.IMOrigin 2>/dev/null | wc -l

# pending 权限审批数（稳态应为 0）：
ls ~/.multi-cc-im/state/*_*.PermissionRequest.*.json 2>/dev/null | wc -l
```

详细 schema + 跨包引用见 [docs/architecture.md](docs/architecture.md)「数据存储」节。每个文件的行为都由 [docs/superpowers/specs/](docs/superpowers/specs/) 里的 DD 锁定。

---

## License

MIT
