# 架构与数据存储

> CLAUDE.md 的硬约束补充。本文记录架构图、包依赖、目录结构、数据存储 schema、关键数据流、外部 CLI 工具路径策略。任何与 CLAUDE.md「核心约束」「关键规范」冲突的实现 = 违规，回 CLAUDE.md 处置。
>
> **版本状态**：本文反映 **v0.1.0** (2026-05-14) — iTerm2 第二终端落地 + 真账号 smoke 暴露的根因修。当前状态总表 + 完整修订记录见 [`conventions.md`](conventions.md)。

## 技术栈

- Node.js ≥ 22 + TypeScript 5.x strict + ESM (`"type": "module"`)
- pnpm workspace monorepo
- tsup（CLI bundle 到 `dist/cli.js`，~280 KB）
- Vitest（单元 + 集成测试，覆盖 ≥ 80%）
- Lark/Feishu IM：npm `@larksuiteoapi/node-sdk@^1.63.1`（WSClient 长连接）—— [DD #86](superpowers/specs/2026-04-29-storage-strategy-dd.md)
- iTerm2 Python API：PyPI `iterm2` 包 + 一次性 helper 子进程 —— [DD 2026-05-13](superpowers/specs/2026-05-13-iterm2-adapter-dd.md)
- pino（日志）、zod（runtime 校验）、smol-toml（config）、chokidar（state dir watcher）

> v1 不引 SQL DB（持久化用文件 + atomic write）。详见 [Storage DD](superpowers/specs/2026-04-29-storage-strategy-dd.md)。

## 架构（4 维度 adapter + bridge core）

```
                  ┌────────────────────────────────────────┐
                  │  apps/multi-cc-im (CLI binary)         │
                  │   start | login | setup-hooks |        │
                  │   cleanup | hook <event>               │
                  └─────────────────┬──────────────────────┘
                                    │ wires
                                    ▼
                  ┌────────────────────────────────────────┐
                  │  packages/bridge                       │
                  │   orchestrator + router + matcher      │
                  │   + ai-router + parser                 │
                  └──┬──────────┬──────────┬────────┬──────┘
                     │          │          │        │
                     ▼          ▼          ▼        ▼
                 ┌──────┐   ┌────────┐  ┌──────┐  ┌─────────┐
                 │  IM  │   │  Term  │  │ CLI  │  │ Storage │
                 │ lark │   │wezterm │  │  cc  │  │  files  │
                 │      │   │ iterm2 │  │      │  │         │
                 └──┬───┘   └────┬───┘  └──┬───┘  └─────────┘
                    │            │         │
                    ▼            ▼         ▼
                Lark WS    wezterm cli   cc hook
                + Lark    or python3    subprocess
                REST       + helper.py   + state files
                            (iterm2)
```

**核心约束实现**（CLAUDE.md「不破坏现有 cc 进程」）：
- bridge 不 spawn 用户 cc；cc 继续在用户 WezTerm tab / iTerm2 tab 里以 TUI 形式跑
- bridge 只通过 (a) cc 原生 hook 事件（出站 + permission gate） + (b) 终端的 send-text 子命令（wezterm cli / iTerm2 Python API） 跟 cc 通信
- **唯一例外**：daemon 自起一次性 `claude --print` 子进程做 IM 路由 triage（[DD: AI-routed IM dispatch](superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md)），独立 session、headless、`--disable-slash-commands`、不沾用户 tab

## 包依赖方向

```
shared（接口类型 + zod schema，零运行时依赖）
  ↑          ↑              ↑              ↑           ↑
storage-  im-lark      term-wezterm     cli-cc      term-iterm2
files                                                    ↑
                                                  spawn python3 +
                                                  iterm2-helper.py

                  shared + storage-files + im-lark + term-wezterm
                                          + term-iterm2 + cli-cc
                                                ↑
                                            bridge
                                                ↑
                                         apps/multi-cc-im
```

**严格边界**：adapter 互不 import；bridge 只 import shared 的接口跟 adapter；apps/multi-cc-im 装配 bridge + adapter 实例。

| Adapter | v0.1.0 实现 | 候选扩展 | 集成模式 |
|---|---|---|---|
| IM | lark (`@larksuiteoapi/node-sdk` WSClient) | telegram / slack / wechat | WS 长连接 / Webhook |
| Term | wezterm cli + iTerm2 Python API helper | tmux / kitty / Ghostty | 子命令 wrapper / API 子进程 |
| CLI | claude-code（hook + state file IPC） | codex / aider | hook 模式 |
| Storage | files (toml + 0600 JSON + state file IPC) | SQLite cache（仅当 /usage 出现性能瓶颈） | small capability interfaces |

## 目录结构

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/             # CLI binary
│       ├── src/                 # cli.ts / start.ts / hook.ts / config-paths.ts /
│       │                        # terminal-selector.ts / adapters.ts / etc.
│       └── dist/                # tsup bundle: cli.js + iterm2-helper.py
├── packages/
│   ├── shared/                  # 4 维 adapter 接口 + types + zod schema
│   │                            #   PaneId = Brand<number | string, 'PaneId'>
│   │                            #   TerminalId = 'wezterm' | 'iterm2'
│   ├── storage-files/           # atomic-write / cursor / config / credential store
│   ├── im-lark/                 # IMAdapter(lark) — WSClient + 1s 固定重试 + 10 次冷却
│   ├── term-wezterm/            # TermAdapter(wezterm) — wezterm cli + send-text 两步法
│   ├── term-iterm2/             # TermAdapter(iterm2) — python3 + 一次性 helper.py 子进程
│   │   ├── src/                 # adapter / python-bridge / path-resolver / tab-title
│   │   └── bin/iterm2-helper.py # 每次 invocation 一个 fresh Python 子进程，做一个 RPC
│   ├── cli-cc/                  # CLIAdapter(cc) — hook payload zod + state files +
│   │                            #   PaneOrigin detector chain（wezterm + iterm2）
│   └── bridge/                  # orchestrator + router (4 级 fallback) + matcher +
│                                #   ai-router（IM 自然语言 → 路由决策）+ parser
├── docs/
│   ├── architecture.md          # 本文
│   ├── conventions.md           # 状态总表 + 修订记录 + 项目特定技术规范
│   ├── competitors.md           # 不直接采用的端到端项目（决策记录）
│   ├── dev.md                   # 开发命令 / TDD 节奏 / 调试
│   └── superpowers/specs/       # DD 报告（每条锁定决策一份）
├── examples/
│   └── claude-settings.json     # cc settings.json hook 段示例
└── bin/
    └── multi-cc-im              # bash wrapper（dist 或 tsx 自动切换）
```

## 数据存储

**v1 不用 SQL DB**。所有持久化走 toml + JSON + 0600 凭据 + per-event-type state files + atomic write。详见 [Storage DD](superpowers/specs/2026-04-29-storage-strategy-dd.md)。

```
~/.multi-cc-im/
├── config.toml                              # 用户配置（startup zod 校验）
│                                            #   - [terminal] type = "wezterm" | "iterm2"
│                                            #   - [external_paths] wezterm / python3
├── credentials/
│   └── lark.json                            # 0600 mode；app_id + app_secret
│                                            # [DD: credentials 持久化策略](superpowers/specs/2026-05-03-keychain-library-dd.md)
├── state/                                   # daemon 运行时状态 + cc hook ↔ daemon IPC
│   ├── lark-cursor                          # Lark WS / event cursor（重启续接，最近 ack）
│   ├── IMWezterm                            # JSON {auto:boolean}；存在 ⇔ wezterm 上 IM 模式 ON
│   ├── IMIterm2                             # JSON {auto:boolean}；存在 ⇔ iterm2 上 IM 模式 ON
│   │                                        #   两个文件互斥（daemon 启动只配 1 个 term）；
│   │                                        #   issue 378 修：原单 IMWork 拆这两个防 wezterm
│   │                                        #   cc 漏进 iterm 模式的 IM
│   ├── IMOrigin                             # 全局 IMReplyContext JSON（discriminated union {imType,...}）
│   │                                        #   handleInbound 入口每条入站 IM 都覆盖
│   │                                        #   daemon start / stop 删（always-fresh）
│   │                                        #   [DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md)
│   ├── daemon.pid                           # JSON { pid, startedAt }；防双开 + hook isDaemonAlive
│   │                                        #   startedAt 字符串走 `ps -o lstart=` LC_TIME=C
│   │                                        #   POSIX locale 强制锁定（issue 377 修）
│   ├── <paneId>_<sid>.Stop.<ts>             # cc 每轮回复；JSON 含 {last_assistant_message, termId}
│   │                                        #   termId 端到端传递（issue 378 修）
│   ├── <paneId>_<sid>.PermissionRequest.<id>.json   # PreToolUse hook → daemon
│   ├── <paneId>_<sid>.PermissionResponse.<id>.json  # daemon → PreToolUse hook
│   ├── <paneId>_<sid>.PermissionDialogRequest.<id>.json   # cc 敏感路径对话框（v1.12 DD）
│   └── <paneId>_<sid>.PermissionDialogResponse.<id>.json
├── daemon.log                               # daemon stderr 镜像（lark / orchestrator /
│                                            #   iterm2-helper trace）；append-only 0600
└── hook-trace.log                           # cc hook 子进程入口 trace
                                             #   **env-gated** by MULTI_CC_IM_DEBUG；
                                             #   默认不写，需要时 `export MULTI_CC_IM_DEBUG=1`
```

**关键设计**：

- `config.toml`：用户可读可手改；startup zod parse + atomic write
- `credentials/<im>.json`：**0600 mode**，仅 owner 读写；不写 git / 日志 / console / toml；明文出现在这 4 处任一 = bug。**不调 OS keychain**（[DD](superpowers/specs/2026-05-03-keychain-library-dd.md)）
- `state/lark-cursor`：每次 cursor advance 走 atomic write
- `state/<paneId>_<sid>.*`：cc-hook 写的 per-event 文件
  - **paneId 是 brand union `number | string`**：wezterm 数字 / iterm2 UUID。`PaneId = Brand<number | string, 'PaneId'>`
  - 入口由 `cli-cc` 的 `PaneOrigin` 检测链（`[wezterm, iterm2]`）解析（详见下文「关键数据流」），未匹配 → hook silent-exit
- `state/IM<TermType>`：master IM-mode 开关。文件名根据**写入时刻 daemon 配的活跃终端**生成（`imWorkFileName(termId)` helper → `IMWezterm` / `IMIterm2`）。hook 子进程读时也按 termId 选；issue 378 根因：原 `IMWork` 单文件不区分终端 → wezterm cc 漏到 iterm 模式的 IM。
- `state/IMOrigin`：全局 IM 上下文。`handleInbound` 入口每条入站 IM 都覆盖（跟同步 echo 路径同源），异步出站路径（cc Stop / PreToolUse forward）从这里读最新 `replyCtx`。生命周期跟 IMWork 一致（仅 daemon start / stop 删）。**全局而非 per-pane** 是为防服务器失效后 stale token（[DD](superpowers/specs/2026-05-08-imorigin-global-dd.md)）。
- `daemon.log`：dual-write logger（stderr + 文件）+ fileOnly sink 给 iterm2-helper trace。launch / stop 都打 banner。append-only 0600。
- `hook-trace.log`：**env-gated**（`MULTI_CC_IM_DEBUG`）。默认静默；需要诊断时 `export MULTI_CC_IM_DEBUG=1` 在 daemon + cc 共同 shell 里，hook 子进程会通过 cc 继承 env，trace 才写盘。

## 关键数据流

### 1. Inbound：IM (lark) → cc

```
lark user → Lark WS event → im-lark.onMessage(IncomingMessage{replyCtx})
   → handleInbound 入口：
       write state/IMOrigin = msg.replyCtx
         （全局；每条入站都覆盖：dispatch / bridge 命令 / 权限响应同源）
       read state/IM<activeTerm>  → derive imWorkOn / imWorkAuto
   → bridge.router.parse(text)         # #<name> /<cmd> /1 /2 / #all / 自然语言路由
   → 每次都拉 termAdapter.listPanes() 当 ground truth
       wezterm: `wezterm cli list --format json`
       iterm2:  `python3 iterm2-helper.py listSessions`（一次性子进程，~100-300ms）
   → matcher.matchSession(#<name>)     # 4 级 fallback (=strict / exact / prefix / glob)
       或 ai-router 接管（IM 自然语言 → cc --print 子进程 triage）
   → orchestrator.dispatchOne(session, content)
       → termAdapter.sendText(paneId, content)  # Step 1: paste（unicode 安全）
       → sleep(300ms)                           # 等 cc TUI 渲染
       → termAdapter.sendKeystroke(paneId, '\r')# Step 2: 提交
   → imAdapter.send(echo, replyCtx)             # IM 反馈：→ frontend received
```

#### 1.a Image inbound — C.1 reply-thread join（β.MVP P6，PR #209）

```
lark user 发图 → message_type='image' → im-lark.onMessage：
   → 用 tenant_access_token Bearer 调 /open-apis/im/v1/messages/{id}/resources/{key}?type=image
   → 落 ~/.multi-cc-im/inbound/lark/images/<ts>-attachment.png（mode 0600，30 MB cap）
   → IncomingMessage{ text:null, attachments:[{kind:'image',localPath,mimetype}],
                      replyToMessageId: data.message.parent_id ?? undefined,
                      replyCtx }
orchestrator.handleInbound 检测 image-only msg：
   → pendingImages.set(msgId, {imagePath, storedAt: now()})
   → imAdapter.send('🖼️ 图已收到。在该图上回复并附 #<tab>...')
   → return（不进 route）

lark user 在该图上 reply text '#<tab> 看这图'：
   → IncomingMessage{ text:'#<tab> 看这图',
                      replyToMessageId: <image msg id> }
   → 走正常 route() → 得 dispatches[]
   → handleInbound 检 pendingImages.get(replyToMessageId) 命中：
       pendingImages.delete(...)
       dispatches.map(d => ({...d, content: `请看 @${imagePath}\n${d.content}`}))
   → dispatchOne(d, msg) 把含 image 路径的 content 通过 wezterm/iterm2 send-text 投递
   → cc Read 工具读图（@<path> 触发）

TTL 30 min：lazy on lookup + 60s 间隔 sweep（setInterval + unref 不阻 exit）
```
状态文件不涉及（in-memory map），daemon 重启 stash 清空。
详见 [DD: IM image to cc](superpowers/specs/2026-05-19-im-image-to-cc-dd.md) §6 C.1。

### 2. Outbound：cc Stop hook → IM (lark)

```
cc finishes turn → cc fires Stop hook (~/.claude/settings.json 注册)
   → multi-cc-im hook Stop（hook 子进程，bin/multi-cc-im → node dist/cli.js）
   → entry trace（MULTI_CC_IM_DEBUG set 才写 hook-trace.log）
   → PaneOrigin detector chain（[wezterm, iterm2]，DEFAULT_DETECTORS）：
       检 process.env.WEZTERM_PANE → 数字 → PaneOrigin{termId:'wezterm', paneId:N}
       检 process.env.ITERM_SESSION_ID → 解 'w<W>t<T>p<P>:UUID' → PaneOrigin{termId:'iterm2', paneId:UUID}
       都不匹配 → silent exit（cc 不在支持的终端里）
   → 三个前置 short-circuit guard：
       1. !exists(state/IM<termId>)         → return void  (本地模式)
       2. !exists(state/IMOrigin)           → return void  (没人最近从 IM 来过)
       3. !isDaemonAlive(stateDir)          → return void  (forward 不可能)
          （isDaemonAlive: kill(pid,0) + ps -o lstart= 带 LC_TIME=C 配对）
   → 通过则：
       sweep stale <paneId>_<sid>.Stop.* + write <paneId>_<sid>.Stop.<ts>
         （文件 body 含 last_assistant_message + termId）
       检 stop_hook_active + popInjection（idle wakeup 路径）
   → exit 0

chokidar add event → cli-cc adapter.classifyStateFile (parseStopFilename)
                  → dispatchOne(StopFile{paneId, sid, termId, filePath})
   → orchestrator.handleStop({paneId, termId, ...})
       → check IM<termId> exists（payload 带 termId，不靠 typeof paneId 推）
       → read state/IMOrigin → IMReplyContext
       → imAdapter.send([prefix] + msg, replyCtx)
       → **不删 IMOrigin**（always-fresh；下条入站 IM 自己覆盖）
   → unlink <paneId>_<sid>.Stop.<ts>
```

### 3. Permission gate（PreToolUse → IM 审批）

详见 [DD: permission forward](superpowers/specs/2026-05-07-permission-forward-dd.md) + [DD: IMWork+IMOrigin](superpowers/specs/2026-05-08-imwork-imorigin-dd.md) + [DD: daemon liveness](superpowers/specs/2026-05-09-daemon-liveness-dd.md) + [DD: PreToolUse auto-approve](superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md) + [DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md) + [DD: PermissionRequest hook IM bridge](superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md)。

```
cc wants to call <tool> → cc fires PreToolUse hook
   → multi-cc-im hook PreToolUse（hook 子进程）
   → PaneOrigin detector → silent exit if no supported terminal env
   → 五个前置 early-return（按 cost 从低到高排序）：
       E1.  tool ∈ {Read, Grep, Glob, NotebookRead}：
              emit { permissionDecision: "allow", reason: "read-only tool" }
              ← 不写 Request 文件，IM 不被打扰
       E2.  readIMWorkFile(stateDir, termId) === null：
              silent exit ← cc 走原生 permission flow（user allow rules 命中放行；
                          没命中才弹 TUI menu）。**不返回 ask** — 否则强制 prompt 覆盖 allow rules。
       E1.5 IMWork.auto = true：
              emit { permissionDecision: "allow", reason: "auto-approve" }
              ← 默认 (bare /start = auto)；user `/start off` 切回 ask 模式
       E3.  !existsIMOriginFile(stateDir)：
              silent exit ← 同 E2
       E4.  !isDaemonAlive(stateDir)：
              silent exit ← 同 E2（rare path：daemon 进程死）
   → 否则走 forward 路径：
       sweep stale <paneId>_<sid>.Permission*.json
       write <paneId>_<sid>.PermissionRequest.<reqId>.json
       poll <paneId>_<sid>.PermissionResponse.<reqId>.json every 200ms, max 10s
       （10s < cc settings.json hook timeout 20s — 留 10s margin 给 hook 写 stdout +
        cleanup + daemon-side apiPostFetch retry 预算 + 网络抖动）

chokidar add event → cli-cc adapter dispatches PreToolUse
   → orchestrator.handlePreToolUse({paneId, sid, requestId, ...})
       → schedule reaper(setTimeout 10s) 兜底删 Request + Response
       → read state/IMOrigin → IMReplyContext（全局；最近一条入站 IM 的 ctx）
       → if exists: imAdapter.send("[<tab>] 准备跑工具: ...\n#<tab> /1 /2", ctx)
       → if missing (race with daemon stop): log + skip

IM user 回 "#frontend /1" → router parses → permission_response branch
   → orchestrator.handlePermissionResponseFromIM(session, decision, replyCtx)
       → 扫 state/ 找 PermissionRequest.*.json，匹配 paneId
       → write <paneId>_<sid>.PermissionResponse.<reqId>.json

hook 子进程 polling → reads PermissionResponse → decision wins
   → unlink Request + Response
   → write stdout: { hookSpecificOutput: { permissionDecision: ..., ... } }
   → exit 0

cc reads hook stdout → applies decision → continues / cancels tool call
```

10s timeout（hook 子进程端）→ default allow + reason "10s timeout, default allow"。

daemon reaper：每个 chokidar add(PermissionRequest) 都 schedule 一个 `setTimeout(10s)` 在 daemon 进程里。hook 正常 cleanup 时已 unlink → reaper 触发时 ENOENT 静默；hook 异常死亡时 → reaper 兜底删（幂等）。

## PaneOrigin / TerminalId 端到端传递（issue 378 根因 framing）

**事实信息**（来自哪个终端）必须随 payload 端到端流动，**不许**下游用 `typeof paneId` 反推（数字 = wezterm？UUID = iterm2？—— 这种 hack 加任何新终端就撞）。详见 [memory: feedback_carry_facts_dont_infer](.claude/projects/.../memory/feedback_carry_facts_dont_infer.md)。

```
cc hook 子进程入口
  ├── PaneOrigin detector chain：DEFAULT_DETECTORS = [
  │     { termId: 'wezterm', detect: detectWezTermPaneId(env) },  // WEZTERM_PANE
  │     { termId: 'iterm2',  detect: detectIterm2PaneId(env) },   // ITERM_SESSION_ID
  │   ]
  ├── runDetectors(env) → PaneOrigin{termId, paneId} | undefined
  └── 用 termId 选 state/IM<TermType> 文件 + 写 Stop file body 带 termId

cli-cc adapter.classifyStateFile / parseStopFilename
  └── 读 Stop file → 反序列 termId（optional 仅为升级 back-compat，新写永远带）→
      传 onStop payload

bridge/orchestrator.handleStop(p with termId)
  └── existsIMWorkFile(stateDir, p.termId) → 读对应 IM<TermType> 文件
      不存在 = silent skip（即「daemon 跑 iterm2 模式时收到 wezterm cc Stop」就静默）

daemon /start auto / /stop
  └── activeTerminalId = opts.termAdapter.name → 只写 / 删 active 那个 IM 文件
      另一终端的 IM 文件永远不存在 → 它的 hook 全部 silent skip
```

## 外部 CLI 工具路径策略

cc hook 子进程的 PATH 是 cc 重组的，**不含** `wezterm` / `python3`（[hook+wezterm DD](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) H3 节实测确认）。multi-cc-im 是开源项目，不能假设用户的二进制装在哪里。

### 启动期探测

| 工具 | 探测顺序（macOS） | 缓存位置 |
|---|---|---|
| wezterm | shell PATH → `/opt/homebrew/bin/wezterm` → `/usr/local/bin/wezterm` → `/Applications/WezTerm.app/Contents/MacOS/wezterm` | `config.toml [external_paths].wezterm` |
| python3 | shell PATH → brew → Xcode CLT | `config.toml [external_paths].python3` |

未来 Linux 支持时按需扩展（`/usr/bin/...` / `/home/linuxbrew/.linuxbrew/bin/...`）。

### 实施约束

- **启动时探测一次** + 写入 config.toml
- 缓存路径**每次启动校验存在性**（用户可能升级 / 卸载）
- 校验失败 → 重新探测；探测失败 → 明确报错 + 指引安装
- **禁止 hardcode 任何绝对路径** —— 含 hook 脚本、命令模板、测试 fixture
- **禁止"找不到就 fallback 用 PATH"**（cc hook 子进程没 wezterm 在 PATH 上；启动时探测才是根因解决）

iTerm2 还需额外校验 **Python API 偏好真的开了** —— wizard 跑 `iterm2.run_until_complete(async_get_app)` 真连接 smoke（[DD #174](superpowers/specs/2026-05-13-iterm2-adapter-dd.md)）；旧的「问用户『勾了吗』」是 hope-not-gate。

## Pane 活性策略

daemon **不独立追踪 cc 死活**。每次 IM 事件直接调当前 termAdapter 的 `listPanes()` 拿 ground truth：
- wezterm: `wezterm cli list --format json`
- iterm2: helper.py listSessions（spawn 一次 python3 + WebSocket + 退出）

- 用户 `/exit` 后 pane 留着 zsh，仍出现在 listPanes 输出 —— 但 tab title 是用户之前 `/rename` 的；新 cc `/resume` 接管同 paneId 重用名字
- 用户关掉 tab：listPanes 不再返回 → matcher 找不到 → echo「未 /rename 或不存在」

权衡：偶尔残留 zsh 的 pane 被注入是用户可见的痛感（自己关 tab），换来 daemon 端零状态、零 stale-tracking 风险。state-sweep 也以 listPanes 集合为 ground truth — paneId 不在 live 集 = 文件 orphan 直接清。详见 [DD: pane-keyed state files](superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)。

## Lark WS 韧性（PR #172 改写）

**Lark IM**：用 `@larksuiteoapi/node-sdk` 的 WSClient 长连接。SDK 默认 `autoReconnect: true` + 指数 backoff (1s→2s→4s→8s→…) 在真账号 smoke 暴露问题：

- backoff 最长可到 4 分钟，stderr 静默无 hook，用户 / AI 看不出「在重连还是已死」

修：**driver-side 自管重连循环**（v0.1.0 落地）：

```ts
WSClient({ autoReconnect: false })       // SDK 不再管重连

每次 attempt：
  log '[lark] 连接中... (尝试 N)'
  if onReady fires:
    log '[lark] WS connected (after N attempt(s))' / 'WS reconnected — bridge ready'
    重置 attempt = 0
  if onError fires:
    log 'WS error (attempt N): <msg>'
    scheduleRetry()

scheduleRetry：
  attempt += 1
  if attempt % 10 === 0:
    log '连接失败 N 次，冷却 5s 后继续重试'
    setTimeout(tryConnect, 5000)
  else:
    setTimeout(tryConnect, 1000)
```

**永不放弃**：循环跑到 `stop()` 设 `stopRequested = true` 为止（graceful Ctrl+C）。每 attempt 都打 log → daemon.log + stderr 用户随时可见。

测试 seam：`retryIntervalMs / cooldownMs / cooldownAfter` opts（prod 默认 `1000`/`5000`/`10`，测试用 `10`/`50`/`10` 在 ~100ms 内跑完）。

## /usage /cost 计算（v2 deferred）

> v1 / v0.1.0 不实施。`packages/analytics` 不存在。价格表 DD 已完成（[DD: 价格表来源](superpowers/specs/2026-04-30-pricing-table-dd.md)）。

设计：按需 tail cc session 的 jsonl 文件计算 aggregate（jsonl schema 见 [hook+wezterm DD](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) H4 节）。关键字段：

```
input_tokens / output_tokens / cache_read_input_tokens
cache_creation.ephemeral_5m_input_tokens     # cache TTL 5m，价格档 1
cache_creation.ephemeral_1h_input_tokens     # cache TTL 1h，价格档 2
service_tier                                 # standard | priority
```

价格表来源：vendor LiteLLM Claude 子集 + `scripts/sync-prices.sh` 周期同步 + `config.toml [pricing]` user override。

性能：单机几十 MB jsonl tail 毫秒级（hook+wezterm DD 实测 156 KB jsonl 解析 < 1ms）。未来真慢加 SQLite query cache（不影响 source of truth）—— v1 / v0.1.0 均不引。

## Daemon 生命周期 + liveness 检测

详见 [DD: daemon liveness](superpowers/specs/2026-05-09-daemon-liveness-dd.md)。

```
daemon start (apps/multi-cc-im/src/start.ts):
  ────── 双开检测 ──────
  read state/daemon.pid
  if isDaemonAlive() (PID 活 + lstart 一致):
    exit 1 with "another daemon already running" + 操作指引
  else (stale lock 或不存在): 继续

  ────── 状态重置 ──────
  delete state/IMWezterm        # 自动回到 local mode（两个文件都清）
  delete state/IMIterm2
  delete state/IMOrigin         # 崩溃兜底 + 下条入站 IM 重新覆盖
  sweep stale state files       # 含 stale daemon.pid + 老版本 IMWork（升级期残留）
  write state/daemon.pid        # JSON { pid, startedAt: <ps -o lstart= LC_TIME=C> }
                                #   banner: "✓ daemon.pid: PID 12345, lstart \"...\""

  ────── 启动 adapters + orchestrator ──────

daemon stop（Ctrl+C / SIGTERM）:
  await imAdapter.stop / termAdapter.stop / cliAdapter.stop
  clear reaperTimers
  delete state/IM<activeTerm>   # 用户必须 /start 才回 IM 模式
  delete state/IMOrigin         # 跟 IMWork 同级清理（always-fresh 生命周期）
  delete state/daemon.pid       # 立刻让 hooks 看到"daemon dead"

daemon SIGKILL (kill -9 / OOM):
  没机会跑 stop() → IM<term> + IMOrigin + daemon.pid 留下
  下次 daemon start：
    sweep 检测 daemon.pid stale（PID 死 / lstart 不匹配）→ 删
    双开检测识别为 stale lock → 不阻拦
    继续重置状态（含删两个 IM<term> + IMOrigin）+ 写新 daemon.pid
```

**`isDaemonAlive()` 实现**（issue 377 修后）：

```ts
1. read daemon.pid → { pid, startedAt }
2. process.kill(pid, 0)  // 存在性测试（ESRCH/EPERM → false）
3. execFile('ps', ['-o', 'lstart=', '-p', pid],
            { env: { ...process.env, LC_TIME: 'C', LC_ALL: 'C' } })
            // POSIX locale 强制：'Thu May 14 19:16:33 2026' 格式确定
4. trimmed === startedAt → alive；不等 → false
```

**为什么 pin LC_TIME=C**：`ps -o lstart=` 输出是 locale-dependent。daemon 写盘时用 user shell locale（en_US: `Thu May 14...`），cc spawn 的 hook 子进程 env 里 LC_TIME 可能不同（zh_CN: `四 5月/14...`），字符串比较失败 → silent skip → cc 回复永远到不了 IM。pin C 让两侧确定性匹配。详见 [memory: feedback_lc_time_pin_when_persisting_ps](.claude/projects/.../memory/feedback_lc_time_pin_when_persisting_ps.md)。

`multi-cc-im cleanup` 命令也走同样的 sweep，**安全跑在 daemon 跑着的状态下** —— 当时 daemon.pid 是合法的，sweep 不删它。

## 多机部署约束（已锁定）

multi-cc-im 仅在**一台机器**上跑。理由：
- IM cursor / WS subscription 协议层全局共享（lark / 任何 IM），多 instance 会让 cursor 互相吃消息或重复处理
- cc hook 子进程靠 `process.env.WEZTERM_PANE` / `ITERM_SESSION_ID` 识别终端，跨机器没意义

**daemon.pid 双开检测**强制了这条规则 —— 用户即使手滑也启不起第二个 daemon（PR #57 之后）。
