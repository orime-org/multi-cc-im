# multi-cc-im

[English](https://github.com/orime-org/multi-cc-im/blob/main/README.md) | **中文**

把跑在 **WezTerm 或 iTerm2 tabs 里**的多个 **Claude Code (cc)** 或 **OpenAI Codex** session 桥接到飞书 (Lark) bot。手机 IM 端能远程驱动各 AI agent tab；回复和工具审批反向到 IM。

> **v0.2.3**（2026-05-30）— cc 回复改用单张 CardKit 卡片发送（一条回复 = 一张卡 = 一条消息），根治多表格回复顺序乱；markdown（标题/表格/代码/列表）原生渲染，不再限 3 张表。**新增 scope 要求**：`cardkit:card:write`（**应用身份**）— 见 [Part 1.1](#11-创建飞书-app必先做完这一节) step 2c。修订日志：[`docs/conventions.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/conventions.md) · [release notes](https://github.com/orime-org/multi-cc-im/releases/tag/v0.2.3)。

**四部分**：
- **[Part 1 — 用户使用](#part-1--用户使用)** — 飞书 app 配置 / IM 命令 / 监控 / 使用类故障排查。装好后怎么用（两种装法都先做这里 1.1 的飞书配置）。
- **[Part 2 — 从源码安装](#part-2--从源码安装)** — git clone + 编译 + 启动（想跑最新代码 / 改源码）。
- **[Part 3 — pnpm 安装](#part-3--pnpm-安装)** — 一行全局装（大多数人）。
- **[Part 4 — 二次开发](#part-4--二次开发)** — 仓库布局 / adapter 接口 / DD 流程 / 文档导航。

---

# Part 1 — 用户使用

> 不管用哪种装法（[Part 2](#part-2--从源码安装) 源码 / [Part 3](#part-3--pnpm-安装) pnpm），都**先做完 1.1 的飞书配置**，装好启动后回这部分看怎么用。

## 1.1 创建飞书 app（必先做完这一节）

按顺序跑完这 7 步。**没跑完别去装** — daemon 会因为 scope / event 缺连不上飞书。

| 步 | 做什么 | 做完得到 |
|---|---|---|
| 1 | 浏览器开 https://open.feishu.cn/app 登录 →「创建应用」→「自建应用」→ 填名称 + 描述 | 一个空 app |
| 2 | 左侧「权限管理」→ 勾下面 3 个 scope（`im:message` 单一项是 2a+2b 合集，cardkit 那个要单独勾；后台找不到时分项勾）| bot 能收 IM 事件 + 发文字 + 拉图 + 发卡片 |
| 2a | `im:message:send_as_bot` 「以应用身份发送消息」 | bot 主动发出站文字（cc Stop forward / AI 预 ack 等）|
| 2b | `im:message:readonly` 「获取单聊、群组消息」 | 收 IM 入站事件 + 拉 `/im/v1/messages/{id}/resources/{key}` 图（**图片下载也走这个 scope，不另设 `im:resource`**）|
| 2c | `cardkit:card:write` 「创建与更新卡片」**（必须选「应用身份」，不是用户身份）** | cc 回复用 cardkit 流式卡片渲染：一条回复 = 一张卡 = 一条消息，根治多条消息顺序乱 + markdown 原生渲染 |
| 3 | 左侧「事件与回调」→「事件订阅」→ 添加 `im.message.receive_v1` | 用户消息进 daemon |
| 3b | 同页加 `card.action.trigger`（卡片按钮回调）| AskUserQuestion / 权限审批按钮起效 |
| 4 | 左侧「应用功能」→「机器人」→ 启用 | app 在飞书里以 bot 身份能被加好友 / 拉群 |
| 5 | 左侧「版本管理与发布」→「创建版本」→ 填版本号 + changelog →「保存并申请发布」| 版本进审批 |
| 6 | 自建 app 你即 admin → 在「我的待审批」点同意 | scope 和 event 真正生效 |
| 7 | 左侧「凭证与基础信息」→ 复制 `App ID` + `App Secret` | 装好启动时向导（[Part 2.2](#22-安装--启动) / [Part 3](#part-3--pnpm-安装)）要填这两个字段 |

> 后续改 scope（如缺权限）从 step 2 重跑 + step 5+6 重新发版；token rotate（≤ 2h）或重启 daemon 强刷生效。

## 1.2 IM 命令速查

> daemon 启后 IM mode 默认 OFF。先 IM 端发 `/start` 或 `/start off` 开。然后在每个 cc TUI 跑 `/rename <name>` 给 tab 起名（纯数字名会撞 pane id，wizard 会警告）。

| 你做 | daemon 做 |
|---|---|
| `<文字>`（无 `#`）| AI 分诊到匹配 tab + 剥前缀 + 发任务 |
| `#<tab> <文字>` | 精确发到该 tab + 该 tab 成 sticky 默认 |
| `#<a> #<b> <文字>` | 多 tab 同发（不动 sticky 默认）|
| `#all <文字>` | 广播到所有 named tab |
| `#<tab> /clear`（或 cc 任何 `/` slash）| 转发为 cc 自己的 slash command |
| `#<tab> /1` | ask 模式下允许 pending tool 调用 |
| `#<tab> /2` | ask 模式下拒绝 pending tool 调用 |
| `/answer <问题编号> <回答>` | 回答对应 Codex 原生问题；支持选项编号或文字 |
| 发图（不带文字）| daemon 暂存图 30 min + 回 `🖼️ 图已收到` |
| 在图上 reply `#<tab> <文字>` | image path + 文字一起投给该 cc tab；cc Read 读图 |
| `/start` | 开 IM mode auto-approve（cc 工具调用不打扰）|
| `/start off` | 开 IM mode ask（每个工具调用先转 IM 等 `/1` `/2`）|
| `/stop` | 关 IM mode（cc 回复留 TUI、工具走 cc 原生菜单）|
| `/list` | 列当前可寻址 tab |
| `/current` | 当前 sticky 默认 + IM mode 状态 |
| `/help` | 路由示例 |

> 模糊匹配支持（`#front` → `frontend` 若唯一）。`/start` echo 里有 `✓ terminal: <id>` 行告诉你 daemon 启动时选了哪个终端。

## 1.3 cc → IM（反向通知）

cc 端三种事件自动转发到 IM，不需要你做配置：

| 触发 | IM 端看到 | 你做 |
|---|---|---|
| cc 回合结束（Stop hook）| `[<tab>] <last_assistant_message>` | 看回复，需要继续就接着发文字 |
| cc 调 AskUserQuestion 选择题（计划 / 设计选项）| 题目 + 编号选项 + 「你的考虑」 | 回编号 / 选项 label / 自然语言 / 自由文本（5 min 超时，逾时 cc 自己继续）|
| cc 编辑 `.claude/* / .git/* / .env*` 等敏感路径 | auto 模式 → 审计行 `🛡️ daemon auto-allowed`；ask 模式 → 编号选项「同意一次 / 始终允许 / 拒绝」| auto 模式不用回；ask 模式回编号 / 自然语言（2 min 超时，逾时 plain allow）|

## 1.4 监控 dashboard

浏览器开 `http://127.0.0.1:40719`（只 bind loopback，不可远程）。SSR 静态 HTML 无 JS：

| Tab | 内容 |
|---|---|
| sessions (默认) | live pane 列表 + addressable 标志 |
| cost | 近期 cc session token + USD 估算（LiteLLM 价表 vendored）|
| errors | orchestrator `onError` ring buffer（last 200）|

顶部 sticky header 一直显示：pid · uptime · 终端 · IM 连接状态。无自动刷新，点 `↻ refresh` 或 F5 / Cmd+R。

JSON 路由：`/api/state` `/api/sessions` `/api/errors` `/api/cost`。

## 1.5 文件位置

| 路径 | 用途 |
|---|---|
| `~/.multi-cc-im/credentials/lark.json` | 飞书凭据（mode 0600）|
| `~/.multi-cc-im/config.toml` | 终端选择 + cached binary paths |
| `~/.multi-cc-im/state/` | runtime state, daemon 自管 |
| `~/.multi-cc-im/inbound/lark/images/` | 入站图缓存（mode 0600）|
| `~/.multi-cc-im/daemon.log` | daemon stderr 镜像 — 总写，`tail -f` 看 |
| `~/.multi-cc-im/hook-trace.log` | cc-hook 子进程 trace — **仅 `MULTI_CC_IM_DEBUG=1` 才写** |

`MULTI_CC_IM_HOME` env 覆盖根目录。

## 1.6 故障排查（使用类）

> 装 / 启动阶段的报错（找不到 wezterm / python3 / daemon 已在跑 等）看 [Part 2.3](#23-故障排查安装类)。

| 现象 | 修法 |
|---|---|
| daemon 起了 IM 收不到消息 | 重跑 `login lark` 验证凭据；确认 [1.1](#11-创建飞书-app必先做完这一节) step 5+6 发版本 + 同意 |
| 图入站报 `HTTP 400 code=99991672 Access denied` | [1.1](#11-创建飞书-app必先做完这一节) step 2b/2c scope 漏了 — 补 + 发版 + 重启 daemon |
| 发卡片失败、回复退成纯文本（`▌「」`）| `cardkit:card:write` 没开成**应用身份**，或 daemon 跑的是没这权限的旧版 — 见 [1.1](#11-创建飞书-app必先做完这一节) step 2c；daemon.log 搜 `cardkit path failed` |
| `#frontend` 报 not found | cc TUI 里 `/rename frontend`；IM 发 `/list` 验证 |
| IM 收不到工具审批 | 必须 `/start off`；至少先用 IM 寻址过该 cc 一次 |
| Ctrl+C 后 IM 收僵尸消息 | `rm -f ~/.multi-cc-im/state/{IMWork,IMOrigin,daemon.pid}` |
| `state/` 堆积 | `./bin/multi-cc-im cleanup --dry-run` 预览 / 去掉 `--dry-run` 真扫 |

## 1.7 CLI 参考

| 命令 | 描述 |
|---|---|
| `multi-cc-im start [adapter]` | 启 daemon（前台）。无 arg → 跑 wizard。首次跑会备份 `~/.claude/settings.json` 后注册 cc hook |
| `multi-cc-im login <adapter> [--<field> <value>...]` | 非交互式凭据配置（env vars 如 `LARK_APP_ID` 也认）|
| `multi-cc-im cleanup [--dry-run]` | 扫陈旧 state 文件，daemon 跑着也安全 |
| `multi-cc-im --help` / `-h` | help |
| `multi-cc-im --version` / `-v` | version |

退出码：`0` 成功 / `1` runtime fail / `2` usage error。

---

# Part 2 — 从源码安装

不想走 npm、想直接跑 git 最新代码 / 改源码，从源码装。

## 2.1 前置要求

| 需要 | 要求 |
|---|---|
| OS | macOS / Linux（Windows via WSL 未测）|
| Node.js | ≥ 22 |
| pnpm | ≥ 9 |
| 终端 | WezTerm ≥ 20240203 **或** iTerm2 ≥ 3.3 (macOS only) |
| AI agent | 至少装一个：**Claude Code**（`claude` 在 `PATH` + 已登录 Pro / Max 订阅）或 **OpenAI Codex**（`codex` 在 `PATH`，免登录 — ChatGPT Plus 账号或 API key）。向导第 1 步会自动探装机，没装的灰色显示 + 给安装链接。装两个都勾就能在同一 wezterm 里 cc 标签 + codex 标签同时挂 IM。|
| Lark 账号 | 一个用作 bot 的飞书账号 |

## 2.2 安装 + 启动

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install                        # 装依赖（没用过 pnpm 先 npm install -g pnpm）
pnpm --filter multi-cc-im build     # 编译出 dist/
./bin/multi-cc-im start             # 用仓库自带的 bin 启动
```

首次启动跑 4 步向导（v0.2.0 起）：

| 步 | 做什么 | 做完得到 |
|---|---|---|
| W1 | **CLI 多选** — 探装机后让你勾要桥接到 IM 的 CLI（Claude Code 或 OpenAI Codex 或都勾） | `[cli].enabled` 写 `~/.multi-cc-im/config.toml`；每个勾选的 CLI 自动注册 hook（cc 进 `~/.claude/settings.json`，codex 进 `~/.codex/config.toml`，写前 `.bak.<ISO>` 备份）|
| W2 | **分诊 AI 单选** — 选哪个 CLI 跑 daemon 内部 IM 消息分诊子进程（即使只勾了 1 个 CLI 也要按 Enter 确认） | `[cli].aiRouter` 写 config.toml |
| W3 | 选终端 `wezterm` 或 `iterm2` | `[terminal].type` 写 config.toml |
| W3b | (iTerm2 路径) 启 Python API preference + 装 `iterm2` PyPI 包 + 同意 macOS Automation 权限 | iTerm2 adapter 能列 pane / send-text |
| W4 | 选 IM 走 `lark` 并粘贴 [1.1](#11-创建飞书-app必先做完这一节) 拿到的 `App ID` + `App Secret` | 凭据写 `~/.multi-cc-im/credentials/lark.json` (mode 0600) + daemon WS handshake |

完成 = daemon 前台跑 + WS 连飞书 ready + 监控 dashboard 在 `http://127.0.0.1:40719`。

Codex hook 安装会保留 `hooks.state` 中的信任／禁用状态和第三方 hook 的完整字段；
既有 handler 在原位置更新，避免位置变化让状态对应到其他 hook；
已有配置写入前创建 `.bak.<ISO>` 备份，配置未变时不写文件、不新增备份。
首次出现的 hook 或内容改变的 hook 仍需在 Codex 的 `/hooks` 中审核；安装器不会替你授予信任。
IM 模式由 `/start`（自动允许）和 `/start off`（询问）控制；Codex 审批回复按原生
`PermissionRequest` 协议返回单次允许／拒绝，不增加会话级权限规则。

Codex 的 Stop 回信通过本机 `codex app-server --listen stdio://` 子进程读取完整会话名，
支持默认共享后台和 `codex --no-daemon`，飞书显示为
`[会话名]` 加回复正文。用 `/rename <name>` 设置该名称；`thread-name`
表示会话名，`project-name` 表示项目目录名。飞书入站按 `/list` 展示的
终端标题寻址；在 `/terminal-title` 中将 `thread-name` 放在首位，并保留
`activity`，可用唯一前缀 `#<name>` 寻址。原生问题以 `/rename` 设置的
会话名标注来源；权限事件的窗格定位使用 `thread-id`，安装器会在保存的标题配置中追加该项。

向导 W2 选择 Codex 后，普通消息、权限回复和已有 Claude 提问的自然语言解释都使用
Codex，无需额外安装 Claude 作为解释后端。每次路由在独立临时目录运行，使用
`--disable hooks`、`--ephemeral` 和 read-only sandbox；不会修改用户全局配置。
Codex 原生 `request_user_input` 通过本机 App Server 转发到 IM；回复
`/answer <问题编号> <选项编号或文字回答>`，或直接回复机器人发来的问题消息。
多题可逐题说明，由 W2 选定的后端解释。即使 `/start auto`，问题也需要你的实际回答；
手机和终端先到的回答生效。迟到回复不会变成新任务；断连时暂停回答，重连后核对原生待答请求。
敏感输入只提示你去终端填写，不转发题目或把回复交给解释模型。

原生问题通过本机 App Server 读取当前已加载根线程的 `thread.name`，并按原始问题请求提交回答。
用 `/rename <name>` 设置会话名；缺名或重名时，该名称的问题转发暂停，日志给出 `/rename` 处理提示。
其他名称唯一的会话继续转发；改名后后续通知使用当前名称，已有问题编号继续关联原请求。
问题发现、投递和回答通过原生接口完成，终端查询故障的影响范围见下方故障表。

权限事件的窗格归属使用官方 `thread-id` 标题项；安装器保留已有标题顺序并追加该项，写前备份。
已运行的 Codex 在 `/terminal-title` 中勾选 `thread-id`；后续新会话读取保存的配置。
权限 hook 对当前已加载线程进行唯一 ID 匹配；标题缺失、前缀歧义、同一线程出现在多个窗格时暂停权限转发。
Codex 版本不作为启动或请求的准入条件；仅实际失败时报告操作、观察到的版本、原始原因和检查步骤。
初始化之前无法取得版本时显示 `unknown`。daemon 与所桥接会话须使用同一个
`CODEX_HOME`（未设时为 `~/.codex`）。Stop 名称查询使用该 home 的本机 stdio 接口；
原生问题使用该 home 的 Unix socket，权限定位同时读取所选终端。
问题内容仅在启用 IM 模式后发送给既有 owner 聊天。另见
[会话名提问 DD](docs/superpowers/specs/2026-10-26-codex-question-session-name-dd.md)、
[提问通道 DD](docs/superpowers/specs/2026-10-22-codex-question-bridge-dd.md) 和
[线程身份 DD](docs/superpowers/specs/2026-10-22-codex-thread-identity-dd.md)。

WezTerm 部署验收：W3 选择 `wezterm`；部署后在飞书执行 `/start` 和 `/list`，
核对终端与会话列表，再向 `#<标签页标题>` 发送消息，检查回复与原生提问的回答往返。
开发侧隔离测试的环境与结果见 [WezTerm 验收记录](docs/superpowers/specs/2026-10-22-codex-wezterm-acceptance.md)。

> **Codex hook**：在 `/hooks` 中审核／刷新 hook；权限定位需在 `/terminal-title` 中启用线程 ID。原生问题通过 `/rename` 设置会话名。
> 安装器不会替你授予 hook 信任或修改 Codex 自身的审批策略。
>
> Ctrl+C 停 daemon。一台机器只能一个 daemon。
> 非交互式凭据预填：`./bin/multi-cc-im login lark --app-id cli_xxx --app-secret xxx`。
> 重新配：再跑 `./bin/multi-cc-im start`，wizard 用旧值预填，回车保留 / 方向键改。

## 2.3 故障排查（安装类）

| 现象 | 修法 |
|---|---|
| start 报 `wezterm CLI not found` | `which wezterm` 验证；或写 `[external_paths] wezterm = "..."` 到 `~/.multi-cc-im/config.toml` |
| start 报 `python3 not found`（iTerm2）| `brew install python3` 或 `xcode-select --install` |
| start 报 `cannot connect to iTerm2 Python API` | iTerm2 → Settings → General → Magic → 勾「Enable Python API」+ 启 iTerm2 后重跑 |
| `cannot import iterm2` | `python3 -m pip install --user --break-system-packages iterm2` |
| start 报 `another daemon already running` | `cat ~/.multi-cc-im/state/daemon.pid` → kill 或 rm 文件 |
| daemon 退出并报 `cannot watch the state directory ... EMFILE` / `ENOSPC` | 桥接已停止，回复和权限请求暂时不能转发到 IM；不会停止 Claude Code / Codex 会话或其他开发任务。`EMFILE` 可能是文件描述符或文件监听资源耗尽，不能仅凭错误码断定哪个进程占满。按提示里的 `Check:` 命令确认：macOS 查 fseventsd 日志，Linux 查 inotify 限制；`EMFILE` 同时检查打开文件数限制。由你决定关闭哪些不再需要的进程或调整已确认的可配置限制，然后运行 `multi-cc-im start`。创建监听、等待就绪及飞书连接期间出错也会给出同样提示并以状态码 1 退出 |
| Codex Stop 回信缺失或会话名不可用 | 用 `/hooks` 确认 Stop 已启用并信任，运行 `/rename <name>` 设置会话名；核对 IM 模式和同一 `CODEX_HOME`。hook stderr 的 `Stop reply was not forwarded` 会说明失败操作、观察到的版本、原始原因和下一步；按提示在会话环境运行 `codex --version` 及 `codex app-server --help`。两种运行模式均支持名称回信；队列错误写入 daemon 日志。飞书 `/list` 可核对入站名称 |
| Codex 原生问题未转发或会话名不可用 | 在原会话运行 `/rename <name>`，给同时使用的会话设置不同名称；确认 IM 模式、owner 聊天、同一 `CODEX_HOME` 和本机 App Server 连接。查看 `[Codex questions]` 的缺名、重名或实际 RPC 错误，按提示处理；连接断开时可在原终端回答 |
| Codex 权限窗格身份无法识别 | 在该 TUI 的 `/terminal-title` 勾选 `thread-id`，一个线程只保留一个窗格；确认所选终端、同一 `CODEX_HOME` 和本机 App Server 连接。hook 信任用 `/hooks` 审核；查看 daemon 控制台／`daemon.log` 中的实际操作、版本和错误原因，按检查步骤处理。身份未明确时在原终端继续处理 |
| `WezTerm pane lookup is unavailable` 或 `wezterm cli timed out` | 当前窗格状态查询失败，按窗格路由和权限来源定位受影响。可在原终端继续操作；在启动 bridge 的 shell 核对 `WEZTERM_UNIX_SOCKET`，使用配置中的 WezTerm 可执行文件运行 `cli --no-auto-start list --format json`。日志保留原始超时、连接或 JSON 错误。核对命令也无响应时，继续检查该 WezTerm 实例的 RPC 响应状态。Codex 原生问题通过独立的本机 App Server 通道处理 |
| hook 注册抱怨现有 hook | 恢复 `~/.claude/settings.json.bak.<ts>` 备份 |

---

# Part 3 — pnpm 安装

大多数人推荐 — 全局装 npm 包（一行装完）：

```bash
pnpm install -g multi-cc-im
# 或 npm install -g multi-cc-im
multi-cc-im start
```

> 没用过 pnpm 的话先 `npm install -g pnpm`。环境要求同 [Part 2.1](#21-前置要求)。

首次启动的 4 步向导跟 [Part 2.2](#22-安装--启动) **完全一样**（只是启动命令是 `multi-cc-im start` 而非 `./bin/multi-cc-im start`）。装 / 启动阶段报错看 [Part 2.3](#23-故障排查安装类)。

---

# Part 4 — 二次开发

## 4.1 技术栈

| 维度 | 选择 |
|---|---|
| 语言 | TypeScript strict, ESM-only (`"type": "module"`) |
| 运行时 | Node ≥ 22 |
| 包管理 | pnpm workspaces (monorepo) |
| 测试 | Vitest (unit + integration) |
| 打包 | tsup (CLI bundling) |

## 4.2 仓库布局

```
multi-cc-im/
├── apps/multi-cc-im/        — CLI binary (tsup → dist/cli.js)
├── packages/
│   ├── shared/              — 跨包 types + zod schemas
│   ├── storage-files/       — TOML + JSON file stores
│   ├── im-lark/             — Lark/Feishu adapter (@larksuiteoapi/node-sdk)
│   ├── term-wezterm/        — WezTerm CLI adapter
│   ├── term-iterm2/         — iTerm2 Python API adapter (ephemeral helper)
│   ├── cli-cc/              — Claude Code hook adapter
│   ├── monitor/             — 本地 dashboard (hono SSR)
│   └── bridge/              — Router + orchestrator + AI-routed dispatch
├── bin/multi-cc-im          — bash wrapper
├── docs/                    — architecture / dev / conventions / DD specs
├── AGENTS.md                — 共同项目规则（贡献前必读）
└── CLAUDE.md                — Claude Code 入口，导入 AGENTS.md
```

## 4.3 dev 命令

需要在终端下方常驻显示 Codex 的每项任务时，见
[Codex 任务面板](docs/dev.md#codex-terminal-task-panel)。面板通过本机 Unix socket
订阅 Codex 的计划事件，显示数据按 session 保存在 `~/.codex/task-panel/`。
启动命令为 `node scripts/task-panel-events.mjs --session <thread-id>`，无需任务 hook。

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

## 4.4 TDD 节奏

红 → 绿 → 蓝。先写失败 test 锁目标行为 → 最少代码让它过 → 重构 + 覆盖 ≥ 80%。test 无论如何写不通过 → 停下来重做 DD，**不在错假设上打补丁**。详见 [`AGENTS.md`](https://github.com/orime-org/multi-cc-im/blob/main/AGENTS.md) + [`docs/dev.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/dev.md)。

## 4.5 加一个 IM adapter（Telegram / Slack / 等）

| # | 做什么 |
|---|---|
| 1 | `packages/im-<name>/` 镜像 `packages/im-lark/` 布局 |
| 2 | 实现 `IMAdapter` 接口：`start(handler)` / `send(text, replyCtx)` / `stop()` |
| 3 | `IMReplyContext` 加 `imType: '<name>'` 变体（discriminated union）|
| 4 | export `setupSchema: AdapterSetupSchema`（per-field `{key, label, hint, secret, schema}` + 可选 `validate(values)`）|
| 5 | `apps/multi-cc-im/src/adapters.ts` 加 registry entry：`id` / `setupSchema` / `persist` / `buildAdapterRuntime` |
| 6 | 凭据写 `~/.multi-cc-im/credentials/<im>.json`（mode 0600）— **不**调 OS keychain（DD: credentials persistence）|
| 7 | 可选：`docs/setup-<im>.md` 走读 + registry 设 `guideDocPath` |

## 4.6 加一个终端 adapter（tmux / kitty / Ghostty / 等）

参考 [`docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md) + `packages/term-iterm2/` 实测代码。

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

## 4.7 加一个 CLI adapter（gemini / aider / 等）

**已落地（v0.2.0）**：`@multi-cc-im/cli-cc` (Claude Code) + `@multi-cc-im/cli-codex` (OpenAI Codex) 两个 adapter 都在仓库里，向导第 1 步多选哪个或都勾。本节描述如何再添加第三个（gemini / aider / 等）。

需求：新 CLI 必须有等价扩展点（hook lifecycle：tool-use 拦截 / 会话结束 / 权限请求等）。codex 接入是个参考——见 [`docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md) 的 5 步 DD（候选枚举 / hook events source-verify / 共享 state-file 协议 / 4 步向导接入）。无等价扩展点 → 提 DD 先不动 — 见 [`AGENTS.md`](https://github.com/orime-org/multi-cc-im/blob/main/AGENTS.md)「不破坏现有 cc 进程」。

## 4.8 重大决策（DD）流程

凡影响安全模型 / 长期维护 / 跨包接口 / 「用现有 SDK」原则的改动必走 5 步 DD：候选枚举（必含「不做 X」）→ 每候选尽调 → 对比矩阵（证据可引用）→ 推荐+理由 → 用户拍板。DD 落 `docs/superpowers/specs/<date>-<topic>-dd.md`。详细规则 [`AGENTS.md`](https://github.com/orime-org/multi-cc-im/blob/main/AGENTS.md)「重大决策 DD 流程」。

## 4.9 文档导航

| 文档 | 何时读 |
|---|---|
| [`AGENTS.md`](https://github.com/orime-org/multi-cc-im/blob/main/AGENTS.md) | AI 干活纪律（根因 / DD / 编码准则）|
| [`CLAUDE.md`](https://github.com/orime-org/multi-cc-im/blob/main/CLAUDE.md) | Claude Code 入口，导入共同规则 |
| [`docs/agent-context.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/agent-context.md) | 记忆读取、历史进度与两端工作流差异 |
| [`docs/conventions.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/conventions.md) | 状态总表 + 修订日志 + 项目特定规范 |
| [`docs/architecture.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/architecture.md) | 架构图 + 状态 schema + 文件 IPC |
| [`docs/dev.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/dev.md) | dev 命令 + TDD 节奏 + 调试 |
| [`docs/setup-feishu.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/setup-feishu.md) | 飞书 app 详细 step-by-step（[Part 1.1](#11-创建飞书-app必先做完这一节) 是摘要版）|
| [`docs/superpowers/specs/`](https://github.com/orime-org/multi-cc-im/blob/main/docs/superpowers/specs/) | DD 报告（一锁一份）|
| [`docs/competitors.md`](https://github.com/orime-org/multi-cc-im/blob/main/docs/competitors.md) | 同类工具对比 |

## 4.10 License

参 [`LICENSE`](https://github.com/orime-org/multi-cc-im/blob/main/LICENSE)（MIT）。
