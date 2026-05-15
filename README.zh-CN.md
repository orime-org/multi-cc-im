# multi-cc-im

[English](README.md) | **中文**

把多个跑在 **WezTerm 或 iTerm2** tab 里的 Claude Code (cc) session 接到飞书。在 IM 里随便说一句「给前端写个登录页」，daemon 让 cc 自己分诊，自动选最匹配的 tab 把任务发过去；要精确点名才用 `#<tab>`。

> **v0.1.0** (2026-05-14) — iTerm2 适配完整 + 真账号 smoke 暴露的关键根因修复。详见 [`docs/conventions.md`](docs/conventions.md) 修订记录或 [release notes](https://github.com/orime-org/multi-cc-im/releases/tag/v0.1.0)。

**README 分两块** ——
- **[Part 1 — 直接使用](#part-1--直接使用)**：安装 / 启动 / IM 命令 / 故障排查。只想用 multi-cc-im 看这里。
- **[Part 2 — 二次开发](#part-2--二次开发)**：仓库布局 / adapter 接口 (IM / 终端 / CLI) / 重大决策 DD 流程 / 文档索引。想加新 IM（Telegram / Slack / WeChat...）或新终端（tmux / kitty / Ghostty...）adapter、修 bug、读懂内部机制就看这里。

---

# Part 1 — 直接使用

## 你需要什么

- macOS / Linux（Windows 用 WSL，没实测）
- Node.js ≥ 22, pnpm ≥ 9
- 二选一终端:
  - **WezTerm ≥ 20240203** (最省事 — 单二进制 + 原生 CLI)
  - **iTerm2 ≥ 3.3** (仅 macOS — 通过 iTerm2 Python API；需要 Python 3 + 一次性开偏好 + 给 Automation 权限)
- 已登录的 Claude Code CLI（`claude` 在 `PATH` 里；AI 分诊需要 Pro / Max 订阅）
- 一个专门当 bot 的飞书账号

## 第一次启动

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm --filter multi-cc-im build
./bin/multi-cc-im start
```

首次运行弹出配置向导（**先选 term 再选 IM**）:

1. **选 terminal**: `wezterm` 或 `iterm2`。iTerm2 分支会引导你打开 Python API 偏好 + 安装 `iterm2` PyPI 包 + 同意 macOS Automation 权限（每个都一次性）。WezTerm 没额外步骤。
2. **选 IM adapter**: 选 `lark`，跟着内嵌指南去飞书开放平台建一个自建应用，把 `App ID` + `App Secret` 填回来，daemon 在线校验通过后就直接进入运行模式。

选项持久化到 `~/.multi-cc-im/config.toml`（`[terminal].type` + `[external_paths]`）；后续 `start` 预选你之前的选择，按 Enter 保留或方向键切换。

之后想重配 / 自动化场景：

```bash
./bin/multi-cc-im login lark --app-id cli_xxxxxxxxxxxx --app-secret xxxxxxxxxxxxxxxx
```

daemon 前台运行，Ctrl+C 停止。每台机器只能跑一个 daemon — 已有 daemon 时再 `start` 会打印已存在的 PID 并退出。

## 给 cc tab 起名字

在任意 cc TUI 里跑 `/rename frontend`，终端 tab title 就变成 `frontend`，IM 里就能用 `#frontend` 寻址。没 `/rename` 的 tab 在 `/list` 能看到，但**不能从 IM 寻址**。

> 避免起纯数字 tab title（会跟 wezterm pane ID 撞）。`/start` 时会主动 echo 警告。

> IM 端发 `/start` 后，daemon 回包里有一行 `✓ terminal: <id>`，可以从 IM 侧确认 daemon 启动时选了哪个 terminal（wezterm 还是 iterm2）。

## 在 IM 里发什么

### 随便说一句 — AI 帮你选 tab

```
给前端写个登录页
```

不用带 `#`。daemon 会让 cc 自己分诊：cc 挑最匹配的 tab，剥掉路由提示词（"给前端" 之类），把干净的任务发过去。IM 会回显：

```
target: frontend
content: 写个登录页
```

容忍语音转写错字、大小写 / 连字符 / 空格变体、中英混合输入。cc 选错了也会自动走字面 substring 兜底。

> 每条纯消息消耗一次 cc API 调用 — 计入你的 cc 订阅 / Pro / Max 用量。

### 点名 `#` 精确指定

```
#frontend hello              # 发给 frontend tab；同时设为 sticky 默认
#frontend #api sync          # 多目标分发（不改默认）
#all stop everything         # 广播给所有命名的 cc
```

支持模糊匹配（`#front` 唯一匹配 `frontend` 就发过去）。匹配多个的话会列候选让你二选一。

### 从 IM 控制某个 cc

```
#frontend /clear             # 把 /clear 转发给 cc（cc 自己当 slash command 处理）
#frontend /1                 # 同意 pending 工具调用（仅 ask 模式有效）
#frontend /2                 # 拒绝
```

### 控制 daemon

| 命令 | 效果 |
|---|---|
| `/start` | 开启 IM 模式，**自动放行** — cc 工具调用不来打扰 |
| `/start off` | 开启 IM 模式，**每次先问** — 工具调用先转 IM 等 `/1` / `/2` |
| `/stop` | 关闭 IM 模式（cc 回复留 TUI；工具审批走 cc 原生菜单）|
| `/list` | IM 能寻址哪些 tab |
| `/current` | 当前 sticky 默认 + IM 模式状态 |
| `/help` | 路由示例 |

> IM 模式每次 daemon 启动会重置为 OFF。每段会话开始记得先在 IM 发 `/start`。

## 工具审批通路（仅 ask 模式）

`/start off` 模式下，cc 每次要跑工具都会先来问你：

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 10 秒内回复，否则默认放行:
  #frontend /1   = 允许
  #frontend /2   = 拒绝
```

也可以直接输入想说的话，cc 会自己分诊到哪个 pending：

```
multi-cc-im 那个 rm 同意
api 的拒绝
deny the bash one
```

daemon 回显匹配到哪个 pending + 决定。允许是安全默认 — 如果你的回复里没提工具名 / 关键参数 / 操作的清楚转述，AI 会把允许降级成拒绝（你可以补一句再发）。拒绝总是直接生效。

只读工具（`Read` / `Grep` / `Glob` / `NotebookRead`）自动放行，不打扰 IM。

## cc 选择题 (AskUserQuestion) → IM（任意模式都生效）

cc 让你做多选题时（它的 `AskUserQuestion` widget —— 常见场景：plan review / 设计抉择 / 选库），问题 + 选项会**不管你在 `/start` auto-approve 还是 `/start off` ask 模式都转发到 IM**：

```
[multi-cc-im] cc 想问你:

Pick a database

  1. Postgres
     mature relational
  2. MongoDB
     doc store
  3. 你的考虑（自由文本）

请回复你的选择（编号或自然语言都行）
```

回复怎么写都行：
- 数字 —— `1`
- 选项 label —— `Postgres`
- 自然语言 —— `我选第二个` / `the mongo one` / `选第 2 个加个 google login`
- 不匹配任何选项的自由文本 —— 你的回复原文直接传给 cc

daemon 把你的回复作为正常的 `AskUserQuestion` 工具结果交给 cc（走 cc 官方 agent-sdk 通道：`permissionDecision: 'allow'` + `updatedInput: {questions, answers}`），cc 把工具记成正常 succeeded with answers。2 分钟内 IM 没回复，hook 自己 inject 空字符 answers 让 cc 不卡住自己决定下一步；超时后才回的 IM 会收到「⏱ cc 已超时，本轮不再等待你的回复」提示。

**多问题** AskUserQuestion（少见 —— cc 一次问 2+ 个问题）：每个 question 在注入的 `answers` map 里都有对应 entry。

## cc 敏感路径编辑对话框（.claude/* / .git/* / .env 等）→ IM

cc 对某些"敏感路径"有 hard-coded 的 ask 门槛：任何 `.claude/`、`.git/`、`.vscode/`、`.idea/` 下的文件，或者 `.bashrc`、`.zshrc`、`.env*`、`.gitconfig`、`.mcp.json`、`.claude.json` 这类点开头的配置文件，cc 每次编辑前都会弹 TUI prompt。这个门槛跑在所有 user-level allow rule **之前** — 即使你在 `~/.claude/settings.json` 里加 `permissions.allow` 也绕不过去（cc 故意这么设计防误授权）。

没这个 bridge 功能的话 IM 用户会卡死：cc 弹 TUI 等键盘输入，IM 这边什么都看不到。daemon 现在拦截 cc 的 `PermissionRequest` hook，按模式分别处理：

### `/start`（auto 模式）

daemon 自动批准当前这一次调用，同时给 IM 发一条审计通知：

```
🛡️ daemon auto-allowed cc 编辑敏感路径
  <tab>: <path>
```

这是纯通知不用答。同一 session 后续再编辑同一路径还会触发对话框（每次都是 single-yes，daemon 故意不偷偷加 session-wide allow rule，保留每次操作的可见性）。

### `/start off`（ask 模式）

daemon 把编号选项 forward 到 IM：

```
[<tab>] cc 想编辑敏感路径:
  <toolName>: <path>

  1. 同意一次（仅本次调用）
  2. 始终允许: Edit(./.claude/**)    ← cc 自己给的 permission_suggestions[0]
  3. 拒绝

请回复（数字 / 自然语言均可）
```

回复方式：
- `1` / `好` / `yes` — 单次同意
- `2` / `总是允许` / `always` — 同意 + 应用 cc 给的 session rule，后续同 path 编辑直到 cc session 退出前都不再弹
- `3` / `拒绝` / `no` — 拒绝 + cc 收到清晰的"user denied"消息

daemon 把你选的 `appliedSuggestionIndex` 解析成 cc 自己提供的 `PermissionUpdate` 对象（**不会**自创 cc 没给的 always-allow — 保持 cc 安全语义）。

### 注意

- **超时**：2 分钟没回复，hook 自己发 plain allow（不带 session rule）让 cc 不卡。超时后才回的 IM 会收到 `⏱ cc 已超时，本轮不再等待你的 PermissionDialog 回复` 提示。
- **只能 session-scoped**：cc 的敏感路径门槛只认 `destination: 'session'` 的 rule（in-memory）。settings.json 里的 project-level / user-level `permissions.allow` 仍然会被门槛拦截。daemon 始终用 cc 给的 session destination 的 PermissionUpdate。
- **多 hook 互动**：如果你的 `~/.claude/settings.json` 里还注册了其他 `PermissionRequest` hooks，cc 的"first-non-null wins"规则生效 — 谁先返回 decision 谁赢。multi-cc-im 假设它是唯一的 PermissionRequest hook。

## cc 回复 → IM 显示

飞书不渲染 markdown，所以 cc 回复在发送前会做简化 — 你看到的是干净文字而不是裸 `**` / 反引号：

| cc 输出 | IM 显示 |
|---|---|
| `# 标题` | `▌ 标题` |
| `**粗体**` | `粗体` |
| `` `代码` `` | `「代码」` |
| `- 列表项` | `• 列表项` |
| ```` ```ts\nconst x = 1;\n``` ```` | `[ts]` 标注 + 代码内容不变 |
| `[链接文字](url)` | `链接文字 (url)` |

## 文件在哪里

- `~/.multi-cc-im/credentials/lark.json` — 飞书凭据（mode 0600）
- `~/.multi-cc-im/config.toml` — terminal 选择 + 缓存 binary 路径
  - `[terminal] type = "wezterm" | "iterm2"` — 你向导的选择
  - `[external_paths] wezterm = "..."` — 缓存 WezTerm CLI 路径（wezterm 用户）
  - `[external_paths] python3 = "..."` — 缓存 Python 3 路径（iTerm2 用户）
- `~/.multi-cc-im/state/` — 运行时状态，daemon 自管理
- `~/.multi-cc-im/daemon.log` — daemon stderr 镜像（lark 连接 / orchestrator 事件 / iterm2-helper trace）；始终写盘，`tail -f` 实时看
- `~/.multi-cc-im/hook-trace.log` — cc hook 子进程调用 trace。**只有 `MULTI_CC_IM_DEBUG=<非空>` env 设了才写**；默认静默。诊断「cc 回复了但 IM 没收到」类问题用：在启动 daemon 跟相关 cc 实例**的同一 shell** 里 export 这个 env、复现问题、再读 log
- `apps/multi-cc-im/dist/iterm2-helper.py` — bundle 里的 Python 脚本，iTerm2 adapter 每次 invocation spawn 它（`pnpm build` 时从 `packages/term-iterm2/bin/iterm2-helper.py` 复制过来）

要换路径设 `MULTI_CC_IM_HOME` 环境变量。

## CLI 参考

| 命令 | 说明 |
|---|---|
| `multi-cc-im start [adapter]` | 启动 daemon（前台运行）。无参数 → adapter 选择菜单。首次会先把 `~/.claude/settings.json` 备份到 `.bak.<iso>` 再自动注册 cc hook |
| `multi-cc-im login <adapter> [--<field> <value>...]` | 非交互配凭据。走的是跟向导同一条 validate + persist 路径。也支持 `LARK_APP_ID` 这类环境变量 |
| `multi-cc-im cleanup [--dry-run]` | 清理过期 state 文件。daemon 跑着也安全 |
| `multi-cc-im --help` / `-h` | 打印 help |
| `multi-cc-im --version` / `-v` | 打印版本 |

退出码：`0` 成功，`1` 运行时失败，`2` 用法错误。

## 故障排查

### `multi-cc-im start` 报 "wezterm CLI not found"

```bash
which wezterm   # 必须能解析
# 或手动写入路径：
echo '[external_paths]' >> ~/.multi-cc-im/config.toml
echo 'wezterm = "/Applications/WezTerm.app/Contents/MacOS/wezterm"' >> ~/.multi-cc-im/config.toml
```

### `multi-cc-im start` 报 "python3 not found"（iTerm2）

```bash
which python3   # 必须能解析
# macOS 装 python3:
brew install python3
# 或：
xcode-select --install
```

### `multi-cc-im start` 报 "cannot connect to iTerm2 Python API"（iTerm2）

向导尝试真连接（`iterm2.run_until_complete`）失败，拿到 `There was a problem connecting to iTerm2`。两个常见根因：

1. **偏好没开** — 绝大多数情况。修法：

   ```text
   iTerm2 → Settings → General → Magic → ☑ Enable Python API
   ```

   再 `./bin/multi-cc-im start`。向导再跑一次 connect smoke，成功会输出 `Smoke check: iTerm2 Python API is reachable.`。

2. **iTerm2 没运行** — 启动任意一个安装的副本（它们共享 `com.googlecode.iterm2` prefs）后重试。

如果连接 smoke 过了但包本身缺（`ModuleNotFoundError: No module named iterm2`），说明向导的 pip install 步骤 silently 失败了。手动重装：

```bash
python3 -m pip install --user --break-system-packages iterm2
```

### iTerm2: cc 里 `/rename` 设的 tab title 在 `/list` 看不到

- 向导的 connect smoke（上面那条）已经验证过 Python API 偏好开了。如果 `/list` 仍漏 tab title，可能是后续 macOS 更新 silently 撤销了 Automation 权限——再跑一次 `./bin/multi-cc-im start` 让 connect smoke 重新触发系统权限弹窗。
- iTerm2 adapter 读的是 `session.autoName`（cc `/rename` 设的）。如果 title 仍显示默认 `Claude Code [...]`，在 cc TUI 里再 `/rename` 一次。

### `multi-cc-im start` 报 "another daemon already running"

```bash
cat ~/.multi-cc-im/state/daemon.pid
# 真在跑就 Ctrl+C 它自己的终端，或 `kill <pid>`。
# 僵尸 PID（被 SIGKILL）就直接删锁：
rm ~/.multi-cc-im/state/daemon.pid
```

### daemon 跑着但 IM 收不到消息

依次检查：

1. 重跑 setup 走真实校验：`./bin/multi-cc-im login lark --app-id <id> --app-secret <secret>`。
2. 飞书应用发布了吗？权限 + 事件订阅必须在飞书开放平台 → 版本管理与发布 → 创建版本 → 提交发布之后才生效。详见 [`docs/setup-feishu.md`](docs/setup-feishu.md)。

### `#frontend` 报 "not found"

- 进 cc TUI 跑 `/rename frontend`。
- 在 IM 发 `/list` 看哪些 tab 可寻址。

### IM 收不到工具审批

1. 是不是 `/start off` 模式？（默认 `/start` 是 auto-approve，不会转发）
2. 你之前从 IM 寻址过这个 cc 吗？（没寻址 → 没 IM thread 可转发）
3. daemon 还活着吗？（`cat ~/.multi-cc-im/state/daemon.pid`）

### Hook 注册报现有 hook 冲突

从 `start` 自动写的备份恢复：

```bash
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<timestamp> ~/.claude/settings.json
```

### Ctrl+C 后 IM 还在收僵尸消息

```bash
ls ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid
# 都应该不存在；还在的话手动删：
rm -f ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/IMOrigin ~/.multi-cc-im/state/daemon.pid
```

### state/ 攒了一堆文件

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
│   ├── im-lark/             — Lark/Feishu 适配器（npm depend `@larksuiteoapi/node-sdk`）
│   ├── term-wezterm/        — WezTerm CLI 适配器
│   ├── term-iterm2/         — iTerm2 Python API 适配器（每次调用 spawn 一次性 Python helper；详见 DD 2026-05-13）
│   ├── cli-cc/              — Claude Code hook 适配器
│   └── bridge/              — 路由器 + orchestrator + AI 分诊
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

## 内部 CLI 命令（hook 调用，非用户接口）

- `multi-cc-im hook <event>` — 由 `~/.claude/settings.json` 的 PreToolUse / Stop hook 调用。`start` 时自动注册，**不要**手动跑。

## TDD 节奏

参考 `CLAUDE.md` 和 [`docs/dev.md`](docs/dev.md)：先写会失败的测试 codify 目标行为 → 最少代码让它通过 → 重构 + ≥80% 覆盖。当前设计下测试无论如何写不通 → 停下重做 DD，**不许**在错假设上打补丁。

## 加新 IM 适配器（Telegram / Slack / 等）

1. 在 `packages/im-<name>/` 镜像 `packages/im-lark/` 的目录结构。
2. 实现 `@multi-cc-im/shared` 的 `IMAdapter` 接口：
   - `start(handler: IMHandler): Promise<void>`
   - `send(text: string, replyCtx: IMReplyContext): Promise<void>`
   - `stop(): Promise<void>`
3. 在 `IMReplyContext` 加一个 discriminated-union 变体（`imType: 'telegram' | 'lark' | ...`）。
4. 导出 `setupSchema: AdapterSetupSchema`（per-field `{ key, label, hint, secret, schema }` + 可选 `validate(values)`），让 W4 wizard 不依赖 adapter-specific 代码就能驱动配置流程。参考 `larkSetupSchema` 的形状。
5. 在 `apps/multi-cc-im/src/adapters.ts` 的 `adapters` 数组里加一行 entry：`id` / `setupSchema` / `persist(values, paths)` / `buildAdapterRuntime({paths, log})`。`multi-cc-im start <id>`、`multi-cc-im login <id> --<field> <value>`、wizard 的 adapter 选择菜单这些会自动加上对应 adapter，无需改 CLI。
6. 凭据落 `~/.multi-cc-im/credentials/<im>.json`（mode 0600）。**不许**调 OS keychain — 见 [DD: credentials 持久化策略](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)。
7. 可选：写 `docs/setup-<im>.md` 步骤指南，registry entry 里把 `guideDocPath` 指过去。wizard 启动时会用 `terminal-link` 渲染含 OSC 8 hyperlink 的指南（W6）。

## 加新终端适配器（tmux / kitty / Ghostty / 等）

参考实现：[DD: iTerm2 adapter](docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md) 跟 `packages/term-iterm2/`（v0.1.0 落地的第二个适配器，可直接照抄结构）。

1. 建 `packages/term-<name>/`。
2. 在 `TerminalIdSchema`（`packages/shared/src/adapter/storage.ts`）枚举里加 `<name>`：`z.enum(['wezterm', 'iterm2', '<name>'])`。
3. 实现 `@multi-cc-im/shared` 的 `TermAdapter & TermListPanes`：
   - `name: '<name>'` 字面量（orchestrator 用它推 `activeTerminalId`）
   - `start(handler): Promise<void>`（终端不推 lifecycle event 就 no-op）
   - `listPanes(): Promise<TermPaneInfo[]>` — 返每个 tab/pane 的 `{paneId, title, cwd}`
   - `sendText(paneId, content): Promise<void>` — 仅 paste（不带提交）
   - `sendKeystroke(paneId, key): Promise<void>` — 提交键（`\r` 等）
   - `stop(): Promise<void>`
4. **严格走两步发送**：`sendText(content)` → orchestrator sleeps ~300ms → `sendKeystroke('\r')`。**禁止**单步 send-with-newline — 见 `CLAUDE.md`「send-text 注入两步法」。
5. **Pane-id detector**：终端若导出了识别当前 pane 的 env 变量（如 `KITTY_WINDOW_ID`、`TMUX_PANE`），在 `packages/cli-cc/src/pane-id-detectors.ts` `DEFAULT_DETECTORS` 里加 `TaggedDetector` entry。detector 输入 `process.env`、输出 branded `PaneId`（`number | string`）。issue 378 根因：detector 的 `termId` 沿 Stop 文件 payload + `IM<TermType>` 每终端 IMWork 文件**端到端传递**——**不许**用 `typeof paneId` 反推终端。
6. **start.ts 接通**：在 wizard 的 `selectTerminal` 加新选项；`start.ts` 根据 `config.terminal.type` 条件构造适配器。
7. 写测试覆盖 listPanes / sendText / sendKeystroke / detector（参考 `packages/term-iterm2/src/*.test.ts`）。

## 加新 CLI 适配器（codex / aider / 等）

cc 适配器（`packages/cli-cc/`）耦合到 cc 特有的 hook（`PreToolUse` / `Stop`）+ jsonl transcript。新 CLI 需要等价的扩展点；没有的话**先做 DD**再实施 — 见 `CLAUDE.md`「不破坏现有 cc 进程」。

## 重大决策（DD）流程

任何影响安全模型、长期维护负担、跨包接口、或「用现有 SDK」准则的改动都要在 `docs/superpowers/specs/<date>-<topic>-dd.md` 出 DD 报告。DD 必须穷举候选（含「不做 X」）+ 证据导向的对比矩阵 + 推荐可追溯到矩阵某格证据。详见 `CLAUDE.md`「重大决策 DD 流程」。

## 文档导航

| 文档 | 用途 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | AI 干活纪律（找根因 / DD 流程 / 编码行为准则 / 通用工程规范）|
| [`docs/conventions.md`](docs/conventions.md) | 项目特定技术规范（状态总表、hook timeout / send-text 两步法 / 路由 key / 项目特定禁令）|
| [`docs/architecture.md`](docs/architecture.md) | 架构图、state schema、文件 IPC |
| [`docs/dev.md`](docs/dev.md) | 开发命令 + TDD 节奏 + 调试技巧 |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | DD 报告（每条锁定决策一份）—— 近期重点：[iTerm2 适配器](docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md)、[IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)、[PermissionRequest IM bridge](docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md)、[凭据持久化](docs/superpowers/specs/2026-05-03-keychain-library-dd.md) |
| [`docs/competitors.md`](docs/competitors.md) | 为什么不直接采用项目 X |

## License

见 [`LICENSE`](LICENSE)。
