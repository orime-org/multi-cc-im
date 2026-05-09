# 架构与数据存储

> CLAUDE.md 的硬约束补充。本文记录架构图、包依赖、目录结构、数据存储 schema、外部 CLI 工具路径策略。任何与 CLAUDE.md「核心约束」「关键规范」冲突的实现 = 违规，回 CLAUDE.md 处置。

> **⚠️ v1.5 transitional state（2026-05-09）**：本文大部分图 / 表 / 包列表描述的是 **v1.4 wechat 时代** 的实施 + **M2-M8 lark adapter 完成后**的目标形态混合。M1 wechat purge（DD #86 §11.2）已删 `packages/im-wechat/` + `packages/openclaw/`，但 `packages/im-lark/` 还没建。下文出现 `im-wechat` / `iLink` / `openclaw` 字样仅供历史参考；当前实际 packages 是 `shared / storage-files / term-wezterm / cli-cc / bridge`（M2-M8 完成后会加 `im-lark`）。M2 完成后本文重写。

## 技术栈

Node.js 22+ | TypeScript 5.x strict | pnpm workspace monorepo | tsup | Vitest | Lark/Feishu IM（npm depend `@larksuiteoapi/node-sdk@^1.63.1`，DD #86）| pino | zod | smol-toml | chokidar（state dir watcher）

> v1 不引 SQL DB（持久化用文件 + atomic write）。详见 [Storage DD 报告](superpowers/specs/2026-04-29-storage-strategy-dd.md)。

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
                    │   + SessionRegistry + parser           │
                    └──┬──────────┬──────────┬────────┬──────┘
                       │          │          │        │
                       ▼          ▼          ▼        ▼
                   ┌──────┐   ┌──────┐   ┌──────┐  ┌────────┐
                   │  IM  │   │ Term │   │ CLI  │  │Storage │
                   │wechat│   │wezterm│   │  cc  │  │ files  │
                   └──┬───┘   └──┬───┘   └──┬───┘  └────────┘
                      │          │          │
                      ▼          ▼          ▼
                  iLink long-  wezterm   cc hook
                  poll +       cli +      subprocess
                  Tencent/     listPanes  + state files
                  openclaw     state mach
                  shim
```

**核心约束实现**：bridge 不 spawn cc；cc 继续在用户 WezTerm tab 里 TUI；bridge 只通过 (a) cc 原生 hook（出站 + permission gate）、(b) `wezterm cli send-text` 子命令（入站）跟 cc 通信。

## 包依赖方向

```
shared（接口类型，零依赖）
  ↑           ↑              ↑              ↑              ↑
storage-files  im-wechat   term-wezterm   cli-cc       openclaw
                  ↑                                       (consumed by im-wechat)
                  └─────► 用 openclaw shim 跑 vendored iLink 客户端
                                                          
                              shared, storage-files, im-wechat, term-wezterm, cli-cc
                                                ↑
                                            bridge
                                                ↑
                                         apps/multi-cc-im
```

**严格边界**：adapter 之间互不 import；bridge 只 import shared 的接口跟 4 个 adapter；apps/multi-cc-im 装配 bridge + adapter 实例。

| Adapter | v1 实现 | 后续候选 | 集成模式 |
|---|---|---|---|
| IM | wechat (iLink, vendored `Tencent/openclaw-weixin` v2.1.7) | telegram / 飞书 | 长轮询 / WS / Webhook |
| Term | wezterm cli list (panes ground truth) + send-text 两步法 | tmux / zellij | 子命令 wrapper |
| CLI | claude-code（hook + state files 路线） | codex / gemini / aider | hook 模式 |
| Storage | files (toml + 0600 JSON + state file IPC) | SQLite cache（仅当 /usage 出现性能瓶颈时）| 小 capability interfaces |

## 目录结构

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/             # CLI binary (start / login wechat / setup-hooks /
│                                #             cleanup / hook <event>)
├── packages/
│   ├── shared/                  # 4 维 adapter 接口 + types + zod schema
│   ├── storage-files/           # atomic-write / cursor / config / pending-queue / credential
│   ├── im-wechat/               # IMAdapter(wechat)
│   │   ├── src/                 # adapter / accounts / monitor / credentials / login
│   │   └── lib/ilink/           # vendored Tencent/openclaw-weixin v2.1.7（不动）
│   │       ├── api/             # iLink REST 客户端
│   │       ├── auth/            # account-id / login QR
│   │       ├── cdn/             # 图片 / 文件 AES-128-ECB 解密 + 落 inbox/
│   │       ├── messaging/       # context-token-store / 长轮询 cursor
│   │       └── VENDOR.md        # 上游 README + 修改记录
│   ├── term-wezterm/            # TermAdapter + ListPanes capability + send-text 两步法
│   ├── cli-cc/                  # CLIAdapter + hook payload zod + state files + injection queue
│   ├── bridge/                  # orchestrator + router (4 级 fallback) + matcher + parser
│   └── openclaw/                # OpenClaw plugin SDK 的 minimal shim（剥离 vendored iLink 客户端
│                                # 对上游 80MB / 36 deps 框架的依赖）
├── docs/
│   ├── architecture.md          # 本文
│   ├── competitors.md           # 不直接采用的端到端项目（决策记录）
│   ├── dev.md                   # 开发命令 / TDD 节奏 / 调试
│   └── superpowers/specs/       # DD 报告（8 篇 + 后续）
├── examples/
│   └── claude-settings.json     # cc settings.json hook 段示例
└── bin/
    └── multi-cc-im              # bash wrapper（dev/prod 自动切换）
```

## 数据存储

详见 [Storage DD 报告](superpowers/specs/2026-04-29-storage-strategy-dd.md)。**v1 不用 SQL DB**。所有持久化走 toml + JSONL + 0600 凭据 + per-event-type state files + atomic write。

```
~/.multi-cc-im/
├── config.toml                              # 用户配置（startup zod 校验）
│                                            #   - [external_paths]: wezterm 探测缓存
│                                            #   - [pricing]: 价格表 user override（v2）
├── credentials/
│   └── wechat.json                          # 0600 mode；bot_token 等敏感凭据
│                                            # （[DD: credentials 持久化策略](superpowers/specs/2026-05-03-keychain-library-dd.md)）
├── state/                                   # daemon 运行时状态 + cc hook ↔ daemon IPC
│   ├── wechat-cursor                        # iLink getupdates cursor（重启续接）
│   ├── IMWork                               # JSON {auto:boolean}：存在 = IM 模式 ON
│   │                                        #   用户 /start 创建，/stop 删（v1.4: bare /<cmd> 语法）
│   │                                        #   daemon 启动自动重置为 OFF；stop 也删
│   ├── IMOrigin                             # 全局 IMReplyContext JSON（discriminated union {imType,...}）
│   │                                        #   daemon 写：handleInbound 入口每条入站 IM 都覆盖
│   │                                        #     （bridge 命令 / 分发 / /1 /2 都覆盖；newest ctx wins）
│   │                                        #   daemon 删：daemon start（崩溃兜底）+ daemon stop（Ctrl+C 清理）
│   │                                        #     **不在** cc Stop forward / /stop 时删（always-fresh，跟 IMWork 一致）
│   │                                        #   [DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md)
│   ├── daemon.pid                           # JSON { pid, startedAt }
│   │                                        #   daemon start 写（双开检测：PID 活 + lstart 一致 → exit 1）
│   │                                        #   daemon stop 删（Ctrl+C / graceful）
│   │                                        #   hook PreToolUse + Stop 用 isDaemonAlive() 检查
│   │                                        #   防 PID 复用：kill -0 + ps -o lstart= 配对验证
│   ├── <paneId>_<sid>.Stop.<ts>             # cc 每轮回复；daemon 读+forward+unlink (~100ms)
│   ├── <paneId>_<sid>.PermissionRequest.<id>.json   # PreToolUse hook → daemon（IM 审批 in-flight）
│   └── <paneId>_<sid>.PermissionResponse.<id>.json  # daemon → PreToolUse hook（IM 用户回 /1 /2）
├── inbox/wechat/<sid>/                      # 微信图片/文件 AES 解密后落盘（cc Read 用）
└── logs/
    └── multi-cc-im-YYYY-MM-DD.log           # pino 日轮转
```

**关键设计**:

- `config.toml`: 用户可读可手改；启动 zod parse + atomic write
- `credentials/<im>.json`: **0600 mode**，仅 owner 读写；不写 git / 日志 / console / toml；明文出现在这 4 处任一 = bug。**不调 OS keychain**（[DD: credentials 持久化策略](superpowers/specs/2026-05-03-keychain-library-dd.md)）
- `state/wechat-cursor`: 每次 cursor advance 走 atomic write
- `state/<paneId>_<sid>.*`: cc-hook 写的 per-event 文件；filename 以 paneId 起头是 **filter** —— 只有跑在 wezterm pane 里的 cc（hook 子进程的 `WEZTERM_PANE` 有值）才能产生这种文件，daemon chokidar 直接 trust 不再二次校验。
- `state/IMOrigin`: 全局 IM 上下文（discriminated union {imType,...}），`handleInbound` 入口每条入站 IM 都覆盖（跟同步 echo 路径的 `replyCtx` 同源），异步出站路径（cc Stop / PreToolUse forward）从这里读最新 `context_token`。**全局而非 per-pane** 是为修服务器失效后 stale token：bridge 命令 / 权限响应 不走 dispatch 但服务器仍签发新 token，per-pane 缓存看不到这些路径会留旧 token → ECONNRESET（[DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md)）。生命周期跟 IMWork 一致 —— 仅 daemon start / stop 删。
- 路由活性：daemon 不再独立追踪 cc 死活，每次 IM 事件直接调 `wezterm cli list --format json` 拿当前 paneId 集合。state-sweep 也以这个集合为 ground truth — paneId 不在 live 集 = 文件 orphan 直接清掉
- 不存 cc transcript 副本（cc 自己的 `~/.claude/projects/<slug>/<sid>.jsonl` 是 source of truth；分析按需 tail）

## 关键数据流

### 1. Inbound：WeChat → cc

```
wechat user → iLink getupdates → im-wechat.onMessage(IncomingMessage)
   → handleInbound 入口：write state/IMOrigin = msg.replyCtx (全局；每条入站都覆盖：
       dispatch / bridge 命令 / 权限响应 — 跟同步 echo 的 replyCtx 同源)
   → bridge.router.parse(text)         # @<name> /<cmd> /1 /2 / @all 等
   → 每次都拉 termAdapter.listPanes() 当 ground truth
   → matcher.matchSession(@<name>)     # tab title 4 级 fallback (=strict / exact / prefix / glob)
   → orchestrator.dispatchOne(session, content)
       → termAdapter.sendText(paneId, content)  # Step 1: paste（任意 unicode 安全）
       → sleep(300ms)                           # Step 2 → 等 cc TUI 渲染
       → termAdapter.sendKeystroke(paneId, '\r')# Step 2: 提交
   → imAdapter.send(echo, replyCtx)             # 可见反馈：→ frontend received
```

### 2. Outbound：cc Stop hook → WeChat

```
cc finishes turn → cc fires Stop hook
   → multi-cc-im hook Stop（hook subprocess）
   → 入口 filter: WEZTERM_PANE undefined → silent exit (cc 不在 wezterm 里)
   → 三个前置 short-circuit guard（跟 PreToolUse E2-E4 对称）：
       1. !exists(state/IMWork)               → return void  (本地模式，cc reply 留 TUI)
       2. !existsIMOriginFile(stateDir)       → return void  (没人最近从 IM 来过；全局 IMOrigin)
       3. !isDaemonAlive(stateDir)            → return void  (forward 不可能)
   → 通过则 sweep stale <paneId>_<sid>.Stop.* + write <paneId>_<sid>.Stop.<ts>
   → 检查 stop_hook_active + popInjection（idle wakeup 路径）
   → exit 0

chokidar add event → cli-cc adapter classifyStateFile (parsePaneSidPrefix)
                  → dispatchOne(StopFile { paneId, sid, filePath })
   → orchestrator.handleStop({ paneId, ... })
       → check IMWork & read state/IMOrigin → IMReplyContext (always-fresh，每条入站 IM 都覆盖)
       → imAdapter.send([prefix] + msg, replyCtx)
       → **不删 IMOrigin**（always-fresh 生命周期；下条入站 IM 自己覆盖）
   → unlink <paneId>_<sid>.Stop.<ts>
```

### 3. Permission gate（PreToolUse → IM 审批）

详见 [DD: permission forward](superpowers/specs/2026-05-07-permission-forward-dd.md) + [DD: IMWork+IMOrigin](superpowers/specs/2026-05-08-imwork-imorigin-dd.md) + [DD: daemon liveness](superpowers/specs/2026-05-09-daemon-liveness-dd.md) + [DD: PreToolUse auto-approve](superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md) + [DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md)（每份 refine 前一份）。

```
cc wants to call <tool> → cc fires PreToolUse hook
   → multi-cc-im hook PreToolUse（hook subprocess）
   → 入口 filter: WEZTERM_PANE undefined → silent exit
   → 五个前置 early-return（按 cost 从低到高排序）：
       E1. tool ∈ {Read, Grep, Glob, NotebookRead}：               ~0ms (CPU set lookup)
              emit { permissionDecision: "allow", reason: "read-only tool" }
              exit  ← 不写 Request 文件，IM 不被打扰
       E2. readIMWorkFile() === null：                             ~0.5ms (read+parse)
              silent exit (no JSON in stdout)
              ← cc 走原生 permission flow：user allow rules（如 "Yes don't
                ask again" 设的）先评估命中就放行；没命中才弹 TUI menu。
                **不返回 ask** — 否则会强制 prompt，覆盖 user 的 allow rules
                （DD #64 & PR #67 修这个 bug）
       E1.5. IMWork.auto = true：                                  ~0ms (already read above)
              emit { permissionDecision: "allow", reason: "auto-approve" }
              exit  ← 默认 (bare /start = auto)；user `/start off` 切回 ask 模式
       E3. !existsIMOriginFile(stateDir)：                         ~0.1ms (stat)
              silent exit  ← 同 E2，defer 给 cc 原生流程
              ← 全局 state/IMOrigin（不带 paneId）；hook 用 existsIMOriginFile(stateDir) helper
                而非传 paneId 参数。空意味着没人最近从 IM 来过，无线程可回
       E4. !isDaemonAlive(stateDir)：                              ~10-30ms (spawn ps，rare path)
              silent exit  ← 同 E2，defer 给 cc 原生流程
   → 否则走 PR-D forward 路径：
       sweep stale <paneId>_<sid>.Permission*.json
       write <paneId>_<sid>.PermissionRequest.<reqId>.json
       poll <paneId>_<sid>.PermissionResponse.<reqId>.json every 200ms, max 10s
       (10s < cc settings.json hook timeout 20s — 留 10s margin 给 hook 写 stdout
        + cleanup + daemon-side apiPostFetch retry 预算 + 任何网络抖动；
        race-free even under 2-3 transient retries hitting unhealthy LB IPs)

chokidar add event → cli-cc adapter dispatches PreToolUse
   → orchestrator.handlePreToolUse({ paneId, sid, requestId, ... })
       → schedule reaper(setTimeout 10s) 兜底删 Request + Response（key: paneId:sid:reqId）
       → read state/IMOrigin → IMReplyContext（全局；最近一条入站 IM 的 ctx）
       → if exists: imAdapter.send("[<tab>] 准备跑工具:\n  <Tool>(...)\n@<tab> /1 /2", ctx)
       → if missing (race with daemon stop): log + skip forward

wechat user replies "@frontend /1" → router parses → permission_response branch
   → orchestrator.handlePermissionResponseFromIM(session, decision, replyCtx)
       → 扫 state/ 找 <session.paneId>_*.PermissionRequest.*.json，匹配 paneId
       → write <paneId>_<sid>.PermissionResponse.<reqId>.json

hook subprocess polling → reads PermissionResponse → decision wins
   → unlink Request + Response files
   → write stdout: { hookSpecificOutput: { permissionDecision: "allow"|"deny", ... } }
   → exit 0

cc reads hook stdout → applies decision → continues / cancels tool call
```

10s timeout（hook subprocess 端）→ default allow + reason "10s timeout, default allow"。

daemon reaper：每个 chokidar add(PermissionRequest) 都 schedule 一个 `setTimeout(10s)` 在 daemon 进程里。hook 正常 cleanup 时已 unlink → reaper 触发时 ENOENT 静默；hook 异常死亡时 → reaper 兜底删（unlinkOrIgnoreENOENT 幂等）。

## 外部 CLI 工具路径策略

cc hook 子进程的 PATH 是 cc 重组的 plugins PATH，**不含 `wezterm`**（[hook+wezterm DD](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) H3 节实测确认）。但 multi-cc-im 是开源项目，不能假设用户的 wezterm 装在哪里。

### 探测顺序（macOS v1 范围）

```
1. 用户 shell PATH（multi-cc-im 启动时是用户 shell 起的，PATH 完整）
   → which wezterm
2. macOS Apple Silicon Homebrew → /opt/homebrew/bin/wezterm
3. macOS Intel Homebrew         → /usr/local/bin/wezterm
4. macOS .app bundle            → /Applications/WezTerm.app/Contents/MacOS/wezterm
```

未来 Linux 支持时按需扩展（`/usr/bin/wezterm` / `/home/linuxbrew/.linuxbrew/bin/wezterm`）。

### 实施约束

- **启动时探测一次**，结果缓存到 `~/.multi-cc-im/config.toml` 的 `[external_paths].wezterm` 字段
- 缓存路径**每次启动校验存在性**（用户可能升级或卸载 wezterm，文件可能已不在）
- 校验失败 → 重新探测；探测失败 → `process.exit(1)` 明确报错并指引安装：
  ```
  wezterm CLI not found. Install via: brew install --cask wezterm
  Or set WEZTERM_PATH env / [external_paths].wezterm in config.toml
  ```
- **禁止 hardcode 任何 wezterm 绝对路径** —— 含 hook 脚本、命令模板、测试 fixture
- **禁止"找不到就 fallback 用 PATH"**（PATH 假设是个补丁，cc hook 子进程没 wezterm；启动时探测才是根因解决）

实施位置：`packages/term-wezterm/src/path-resolver.ts`（启动期；写入由 `apps/multi-cc-im/src/start.ts` 协调）。

## Pane 活性策略（DD #61 撤销 PaneAlive 验证）

DD #61 之前：用户 `/exit` 后 pane 里残留 zsh，盲注入会发到 shell —— 所以 daemon 维护一套 PaneAlive 信号网格（SessionEnd hook + `kill -0` + `ps lstart` + hook 时间戳）。

DD #61 之后：**daemon 不再独立追踪 cc 死活**。每次 IM 事件直接 `wezterm cli list --format json`：

- 用户 `/exit` 后 pane 留着 zsh，仍然出现在 listPanes 输出里 —— 但其 tab title 还是用户之前设的（cc /rename 设的）
- 用户重启 cc：`@<name>` 路由命中同一个 paneId，新 cc 接管这个名字
- 用户关掉 wezterm tab：listPanes 不再返回这个 paneId → matcher 找不到 → echo 报告"未 /rename 或不存在"

权衡：偶尔残留 zsh 的 pane 被注入是用户可见的痛感（自己关 tab 就好），换来 daemon 端零状态、零 stale-tracking 风险。SessionEnd hook + sid-keyed 文件 + PaneAlive 验证全部撤销。详见 [DD: pane-keyed state files](superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)。

## iLink 网络韧性（两层防御）

### 第一层：IP health-probed dispatcher（根因 fix）

PR-H ([DD: iLink dispatcher health probe](superpowers/specs/2026-05-08-ilink-dispatcher-health-probe-dd.md)) 加自定义 undici `Agent` (`packages/im-wechat/lib/ilink/api/dispatcher.ts`)：

```
adapter.start():
  1. dns.resolve4(ilinkai.weixin.qq.com)        # 拿 4 个 A records
  2. concurrent TCP probe (port 443, 2s timeout) # 标记 healthy / dead set
  3. new Agent({ connect: { lookup } })          # lookup 从 healthy round-robin
  4. setInterval(5 * 60_000, reprobeAll)         # 周期 re-probe (跟踪 LB 自适应)

每条 fetch:
  fetch(url, { dispatcher: agent })              # 强制只用 healthy IP

adapter.stop():
  clearInterval(reprobeTimer) + agent.close()
```

**起源**: 用户 2026-05-08 跑诊断脚本发现腾讯 iLink LB 4 个 backend IP 中 **2 个完全不健康** (`43.171.116.194` / `43.171.124.85`)。Node fetch 默认 `dns.lookup` 取 single first IP 没 fallback，命中死 IP hang 5s 直到 OS TLS handshake timeout。

**全 dead 退化**: 如果某次 re-probe 4 IP 全 fail（罕见），dispatcher 进 degraded 模式 (healthy = all)，行为退化到默认 fetch + 第二层 retry 兜底。`snapshot().degraded === true` 可观测。

**测试覆盖** (`packages/im-wechat/lib/ilink/api/dispatcher.test.ts` 9 cases): initial probe / all-dead degraded / re-probe revive+kill / DNS error / empty A records / probe rejection / stop 幂等 / Agent 接口验证。

### 第二层：apiPostFetch transient retry (兜底)

`packages/im-wechat/lib/ilink/api/api.ts` 的 `apiPostFetch` (sendMessage / sendImage / sendFile / sendTyping / getConfig 共用) 对 TCP/网络瞬时错误自动 retry：

| 错误码 | 处理 |
|---|---|
| `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `ENETUNREACH` / `EHOSTUNREACH` / `EPIPE` / `UND_ERR_SOCKET` / `UND_ERR_CONNECT_TIMEOUT` | retry 最多 2 次（200ms / 500ms 退避） |
| HTTP 4xx / 5xx (server 给了 response body) | **不** retry — server-side 确定性答案 |
| AbortError (本地 timeout) | **不** retry — 已经到 budget |

**Idempotent 安全**: caller 在 `sendMessageWeixin / sendImageMessageWeixin / sendFileMessageWeixin` 一次性生成 `client_id`，retry 用同一 body 同一 client_id，server 端按 client_id 去重 — 不会发重复消息。

### 两层关系

dispatcher 是根因 fix（避开死 IP），retry 是 robustness 兜底（dispatcher 也可能瞬时失败 / degraded 模式时 / dispatcher 重 probe 之间的 race）。两层独立，dispatcher 失败不影响 retry，retry 失败不影响 dispatcher 工作。

## /usage /cost 计算（v2 deferred）

> v1 不实施。`packages/analytics` 不存在；价格表 DD 已完成（[DD: 价格表来源](superpowers/specs/2026-04-30-pricing-table-dd.md)），v2 实施时按此设计落地。

设计：按需 tail 已知 session 的 jsonl 文件计算 aggregate（jsonl schema 见 [hook+wezterm DD](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) H4 节）。

关键字段（来自 `assistant.message.usage`）:

```
input_tokens / output_tokens / cache_read_input_tokens
cache_creation.ephemeral_5m_input_tokens     # cache TTL 5m，价格档 1
cache_creation.ephemeral_1h_input_tokens     # cache TTL 1h，价格档 2
service_tier                                 # standard | priority，价格不同
```

价格表来源：vendor LiteLLM Claude 子集 + `scripts/sync-prices.sh` 周期同步 + `config.toml [pricing]` user override。

性能：单机几十 MB jsonl tail 在毫秒级（hook+wezterm DD 实测 156KB jsonl 解析 < 1ms）。如果未来真慢，加 SQLite query cache（不影响 source of truth）—— 但 v1 / v2 均不引。

## Daemon 生命周期 + liveness 检测

详见 [DD: daemon liveness](superpowers/specs/2026-05-09-daemon-liveness-dd.md)。

```
daemon start (apps/multi-cc-im/src/start.ts):
  ────── 双开检测 ──────
  read state/daemon.pid
  if isDaemonAlive() (PID 活 + lstart 一致):
    exit 1 with "another daemon already running" + 操作指引
  else (stale lock 或不存在):
    继续

  ────── 状态重置 ──────
  delete state/IMWork           # 自动回到 local mode
  delete state/IMOrigin         # 崩溃兜底 + 下条入站 IM 重新覆盖（[DD: IMOrigin global]）
  sweep stale state files        # 含 stale daemon.pid（PID 死 / lstart 不匹配）+ 老版本 <paneId>.IMOrigin
  write state/daemon.pid         # JSON { pid: process.pid, startedAt: <ps lstart> }
                                  # banner: "✓ daemon.pid: PID 12345, lstart \"...\""

  ────── 启动 adapters + orchestrator ──────

daemon stop（Ctrl+C / SIGTERM / orchestrator.stop()）:
  await imAdapter.stop / termAdapter.stop / cliAdapter.stop
  clear reaperTimers
  delete state/IMWork           # 用户必须 /start 才回 IM 模式
  delete state/IMOrigin         # 跟 IMWork 同级清理（always-fresh 生命周期）
  delete state/daemon.pid       # 立刻让 hooks 看到"daemon dead"

daemon SIGKILL (kill -9 / OOM):
  没机会跑 stop() → IMWork + IMOrigin + daemon.pid 文件留下
  下次 daemon start：
    sweep 检测 daemon.pid 为 stale（PID 死 / lstart 不匹配）→ 删
    双开检测识别为 stale lock → 不阻拦
    继续重置状态（含删 IMOrigin）+ 写新 daemon.pid
```

`isDaemonAlive()` 实现 = `process.kill(pid, 0)`（存在性测试）+ `ps -o lstart= -p <pid>` 配对验证（防 OS PID 复用）。两步都通过才返回 true。

`multi-cc-im cleanup` 命令也走同样的 sweep，跟 daemon start 用同一逻辑。**安全跑在 daemon 跑着的状态下** —— 当时 daemon.pid 是合法的（PID 活 + lstart 一致），sweep 不会删它。

## 多机部署约束（已锁定）

multi-cc-im 仅在**一台机器**上跑（CLAUDE.md「关键设计假设」表「多机」行 ✓）。理由：iLink 协议层 `getupdates` cursor 是全局共享，多 instance polling 会让 cursor 互相吃消息。**daemon.pid 双开检测**强制了这条规则（PR #57 之后）—— 用户即使手滑也启不起第二个 daemon。
