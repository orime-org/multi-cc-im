# 项目技术规范与状态

> 本文是 [`CLAUDE.md`](../CLAUDE.md) 的技术补充。
>
> - **CLAUDE.md** = AI 干活纪律（找根因 / DD 流程 / 编码行为准则 / 通用工程规范）
> - **本文（conventions.md）** = 项目特定的技术实现规范、状态总表、修订记录、参考资料
>
> CLAUDE.md 没有的项目特定规则（hook timeout / send-text 两步法 / 路由 key 选择 / 禁止 `#$<paneId>` / etc.）都在本文。CLAUDE.md 引用本文为「依赖文档」。

---

## 项目简介（详细版）

`multi-cc-im` —— 个人本地 bridge：通过飞书 (Lark) IM 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到手机，实现"在公司用控制台 + 外面用 IM"双客户端 + `#session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> **状态**：v1.8 全实施完成（2026-05-12）—— 路由前缀 `@` → `#` 硬切换（[DD 2026-05-12](superpowers/specs/2026-05-12-routing-symbol-change-dd.md)）：飞书 (以及多数现代 IM) 把 `@` 字符在客户端层 rewrite 为 mention object，bridge parser 拿不到字面 `@<tab>` 字符串；改用 `#` 后零 IM 层 rewrite、跟 Slack/Discord/IRC channel 约定一致、各端键盘易输入。Hard cutover 无 compat / dual-syntax / escape。v1.7 全实施完成（2026-05-11）—— v1.6 wizard + DD #86 §11.4 全 milestones 之上接续完成 [v1.7 natural-language IM permission replies](superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) P1-P6。**M5 interactive cards ❌ 已取消**（2026-05-11，DD #86 §11.5）。当前 packages：shared / storage-files / im-lark / term-wezterm / cli-cc / bridge。架构 → [`architecture.md`](architecture.md)；DD → [`superpowers/specs/`](superpowers/specs/)；用户上手 → [`../README.md`](../README.md) Quick Start；开发命令 → [`dev.md`](dev.md)。Follow-up：Lark intl WSClient 真账号 smoke / 后续 tg IM adapter / analytics package / **v1.9 AskUserQuestion IM bridge P1-P6 实施 pending**（[DD 2026-05-12](superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md) 全 6 维度 user-locked：D1-B/D2-B/D3-numbered/D4-B/D5-C deny+reason/D6-B free text — cc widget 内容 forward IM + IM 自由文本回复 → AI 分诊 → cc 拿 deny+reason 自己解读，无需 keystroke 注入）。**Lark group-chat 支持 ❌ 永久不做**（[DD 2026-05-12](superpowers/specs/2026-05-12-lark-group-chat-support-dd.md) D1-1 锁定：privacy creep / state 复杂度 / scope drift / owner-only ACL 脆弱 / 个人 use case 没真实需求 — 详见 DD §6.x）。**Lark audio msg 处理 ❌ 永久不做**（[DD 2026-05-12](superpowers/specs/2026-05-12-lark-audio-msg-handling-dd.md) D1-1 锁定：飞书手机键盘 🎤 已是 system-level STT，99% 真实使用走 text 即可；adapter 收到 audio msg 改回友好提示「请用键盘麦克风转文字」替代之前 silent drop）。

### 修订记录

- 2026-04-26 v0.1（初稿）→ v0.2（撤回 share 假设）
- 2026-04-27 v0.3（cc hook + wezterm cli 实测完成，6 项假设升 ✓）
- 2026-05-05 v1.0（实施完成 PR #4-#46，6 packages 到位）
- 2026-05-07 v1.1（permission forward PR #51-#53 + voice/image 通路实施）
- 2026-05-08 v1.2（IMWork + IMOrigin + read-only 白名单 + reaper PR #55+）
- 2026-05-09 v1.3（daemon liveness 检测：daemon.pid lock + 双开检测 + Ctrl+C 清理 + hook 4 层 short-circuit decision tree）
- 2026-05-09 v1.4（AI 路由 plain IM 消息：daemon 每条 plain msg 起一个 `claude --print` 子进程做 triage + intent 提取；bare `/<cmd>` 替换 `@multi-cc-im /<cmd>` daemon 命令语法，无 backwards compat）
- 2026-05-09 v1.5（IM adapter 切换：wechat 整包删除（含 vendor OpenClaw）+ openclaw shim 删除 + IMReplyContext `'wechat'` variant 删除 + lark adapter 接 `@larksuiteoapi/node-sdk` WSClient 长连接（DD #86）。M1 wechat purge / M2 lark login / M3 lark adapter 完成；M5 + M7-M8 进行中）
- 2026-05-10 v1.5.1（PR #93 M7 daemon orchestration 完成 + PR #94 hotfix：AI router 子进程 `WEZTERM_PANE` env leak → 子进程 stop hook 不再误 forward 路由 JSON 给 IM；plain AI 路由成功 echo 改两行 X 格式 (`target: <tab>\ncontent: <intent摘录>`) + intent 截前 20 字；分诊失败 echo 加 raw IM 摘录）
- 2026-05-10 v1.6（[interactive start/setup wizard DD](superpowers/specs/2026-05-10-interactive-start-wizard-dd.md) 锁定：单 `start [<adapter>]` 命令；@clack/prompts v1.3.0 prompt 库；inline ASCII + ANSI hyperlink 配置指南；字段-typed AWS-style mask（secret 字段 `'*'*16 + last_4`，非 secret 全显）；hybrid schema-driven adapter setup interface + adapter `validate(values)` callback；W1-W8 实施 milestones）
- 2026-05-11 v1.6 全实施完成（PR #96 W1 deps / #97 W2 shared schema interface / #98 W3 lark setupSchema + validateLarkCredentials 抽出 / #99 W4 generic wizard + AWS-style mask / #100 W5 selector + start.ts rewire / #101 W6 inline guide + OSC 8 hyperlinks + docs/setup-feishu.md / #102 W7 login shortcut unify through schema persist; DD #86 §11.4 M8 docs polish 同 PR 收尾）
- 2026-05-11 真账号 smoke 一系列修复（PR #104 cold-start race + SDK info 噪音抑制 / #105 AI router prompt lenient + 失败 echo 加 tab 列表 / #106 markdown strip cc → IM / #107 start banner 清理 + IM `/start` next-step 提示 / #108 IM 入站 message_id 去重 + #109 静默去重 / #110 AI router topic-mention prompt + substring fallback + daemon stderr 多行 echo 展开 / #111 prompt 全改英文 + `[AI router]` reason trace log / #112 Stop / PreToolUse 文件 delete-always 语义 / #113 AI router exec 错误诊断升级 + timeout 15s→30s）
- 2026-05-11 M5 interactive cards ❌ 取消（DD #86 §11.5 final decision：飞书 cards 回调只走 webhook，与 "no public IP" 核心约束冲突；保留 `/1`/`/2` 文字流 forever；M5 不重新排期，除非飞书改协议或项目放弃 no-public-IP 约束）
- 2026-05-11 v1.7 DD 锁定（[natural-language IM permission replies](superpowers/specs/2026-05-11-im-permission-natural-language-dd.md)）：用户在 PreToolUse 转发的 IM 消息里用自然语言（"multi-cc-im 那个我同意" / "node 的拒绝"）回审批，daemon 跑 AI 分诊 tab + decision；D1 保留 `#<tab> /1 /2` 作 deterministic 兜底；D2 每条消息扫盘 `*.PermissionRequest.*` 喂 AI prompt；D3 `RouterResult.aiTrace` 扩 `permissionResponse?`；D4 daemon 前置 gate（有 pending Request 才进 permission 模式）；D5 非对称信任 + `[AI permission]` trace log
- 2026-05-11 v1.7 全实施完成（PR #122 P1 `listPendingPermissionRequests` helper in cli-cc / PR #123 P2 ai-router prompt 加 PENDING 块 + D5-3 match-signal 规则 + 输出 schema 加 `permissionResponse` 字段 / PR #124 P3 router `handlePlainWithAI` 注入 pending → AI → 短路到 `RouterResult.permissionResponse` 分支 / PR #125 P4 orchestrator dispatch via `handlePermissionResponseFromIM(reason?)` + `[AI permission]` 独立 audit log 行 + cli-cc paneId → router 品牌 `PaneId` IPC 桥接 / 本 PR P6 docs。P5 实施测试折进各 PR 单元覆盖。Bundle 0.0.1 验证 OK，736/736 tests pass）
- 2026-05-12 v1.8 全实施完成（[routing symbol change DD](superpowers/specs/2026-05-12-routing-symbol-change-dd.md)）：路由前缀 `@` → `#` 硬切换。飞书真账号 smoke 暴露 `@` 被客户端 mention picker rewrite 为 mention object，parser 拿不到字面字符；改 `#` 后零 IM 层 rewrite + 跟 Slack/Discord/IRC channel 约定一致。21 文件 / 366 处机械替换：parser tokenizer + matcher / router / orchestrator / ai-router 注释与 echo + 全部 tests + README ×2 + dev.md + architecture.md + conventions.md。Hard cutover 无 compat / dual-syntax / escape。同 PR 修 `/start` echo 漏掉的 v1.4 AI 分诊 + v1.7 自然语言审批两条 bullet（user issue 2026-05-12 (a)）
- 2026-05-12 v1.8 hotfix + group-DD 锁定：sweep PR #127 漏掉的 5 处错描述「当前 toggle 走 `@multi-cc-im /start`」的滞后注释（hook-receiver / state-files / orchestrator / shared cli / term-wezterm tab-title），改成 bare `/start` / `#<tabname>` / `#<query>` 等当前实际语法；matcher.test 描述 `@multi-cc-im` → `#multi-cc-im`。同 PR 锁定 [lark group-chat support DD](superpowers/specs/2026-05-12-lark-group-chat-support-dd.md) 为 **D1-1 ❌ 不做**，理由 5 条（privacy creep / 多 context state 复杂度 / scope drift / owner-only ACL 脆弱 / 个人 use case 无真实需求），P1-P6 cancel 但保留历史档以备未来需求触发 reopen。同时复核 AI 分诊 model `claude-haiku-4-5`：[Anthropic 官方 docs](https://platform.claude.com/docs/en/docs/about-claude/models/overview) 明确标 Haiku 4.5 = "Fastest" tier，currently-available 列表无更快可选，保持不变。
- 2026-05-12 audio-msg DD 锁定 + adapter echo 补丁：[lark audio msg handling DD](superpowers/specs/2026-05-12-lark-audio-msg-handling-dd.md) 全 6 维度尽调（Lark audio payload `{file_key, duration_ms}` + 100M resource API + Lark 自带 STT `speech_to_text.speech.fileRecognize` 60s 上限 + Anthropic Files API 不收 audio + Whisper API $0.006/min + whisper.cpp tiny→large 模型 75 MB→2.9 GB + 用户加 D6 pre-ack 需求），用户最终拍板「服务器支持直接处理语音，但只支持处理文本」走 simple-path：D1-1 不做 audio msg pipeline，依赖飞书手机键盘 🎤 system-level STT 已生效（99% 真实使用走文字）；adapter.ts `msg_type === 'audio'` 分支从 silent drop 改为友好 echo「❌ 暂不支持音频消息，请用键盘 🎤 麦克风转文字后发送」；2 adapter test 覆盖（echo 调用 + echo failure 不阻断）。
- 2026-05-12 v1.9 DD 锁定（[AskUserQuestion IM bridge DD](superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md)）：cc 内置 `AskUserQuestion` widget 当前 fire `PreToolUse` 后被 daemon auto-mode silent-allow 吞掉 / ask-mode 走 `/1` `/2` 语义不对（这是 widget 选项不是允许拒绝）。用户全 6 维度 locked：D1-B（IMWork on 总 forward 不管 auto/off）/ D2-B（hook hold 等 IM 回复，TUI 不渲染 widget）/ D3 numbered options + 你的考虑 / D4-B（AI 自然语言分诊）/ D5-C（hook 返 cc `permissionDecision: 'deny' + permissionDecisionReason: <answer>`，cc 自己解读 reason 当用户答复，**无 keystroke 注入**）/ D6-B（free text 支持）。P1-P6 实施 pending：settings.json per-tool timeout 拆分（AskUserQuestion 5min / 其余 10s）/ hook-receiver special-case branch / orchestrator 格式化 / ai-router prompt 扩展 option 匹配 / tests + smoke C2 风险（cc 是否真把 deny+reason 当 answer 用） / docs。

---

## 关键设计假设（状态总表）

> ✓ = 已 DD 锁定 / 协议事实 / 实测确认；⚠️ = 待实测；? = 待用户/DD 决策。

| 维度 | 状态 | 详情 |
|---|---|---|
| 协议层（飞书 IM）| ✓ | npm depend `@larksuiteoapi/node-sdk@^1.63.1`（官方 Bytedance 维护，MIT，月下载 4M+）；WSClient 长连接 = no-public-IP；IM v1 messaging covers text + image + file + interactive cards。**已删**：v1.4 时代 wechat / iLink vendored OpenClaw（PR #76/78/82 多次踩 undici 升级 instability，DD #86 §11.2 决定整包删）。[DD #86: Lark IM adapter](superpowers/specs/2026-05-09-lark-im-adapter-dd.md) + [历史 DD: iLink 选型](superpowers/specs/2026-04-26-ilink-library-dd.md)（保留作 wechat 时代决策记录）|
| Adapter 接口（IM/Term/CLI 事件流）| ✓ | TS-first hybrid（callback inject + extends-based 编译时 capability + type guard narrow）；[DD: adapter 接口](superpowers/specs/2026-04-29-adapter-interface-dd.md) |
| Storage（持久化策略）| ✓ | **无 SQL DB**：cc transcript 只读 cc jsonl，按需 tail；自身仅 cursor / friendly_name / ACL / pending msg buffer 4 项落 toml + JSONL；[DD: 持久化策略](superpowers/specs/2026-04-29-storage-strategy-dd.md) |
| 出站 / 入站 / Idle 唤醒 / Session 标识 / jsonl schema / pane-id | ✓ | [DD: hook+wezterm 实测](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) |
| ACL（owner-only） | ✓ | 协议层自带过滤 |
| 多机（仅一台） | ✓ | 协议层硬约束（getupdates cursor 全局共享） |
| 路由语法 | ✓ | **G' 组合**：`#<name>` tmux 4 级 fallback（id / `=exact` / exact / 短前缀 / glob，歧义报错列候选）+ 空格分多目标（`#a #b ...`）+ `#all` 广播 + last-explicit-mention 粘性默认（带 visible echo）+ **bare `/<cmd>` 控制命令**（v1.4 起：`/list /help /current /start [off] /stop`；替换老 `@multi-cc-im /<cmd>` 语法，**无 backwards compat**；用户输入 `#<tab> /<cmd>` 仍正常 forward 给 cc TUI）；session 死自动 unset current；[DD: 路由语法](superpowers/specs/2026-05-04-routing-syntax-dd.md) + [DD #73: AI 路由](superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md) |
| AI 路由 plain IM msg | ✓ | **每条 plain msg → daemon 起 `claude --print` 子进程做 triage**：headless、`--model claude-haiku-4-5`、`--disable-slash-commands`、`--setting-sources user`、`--permission-mode bypassPermissions`、15s timeout、跑完即退、不沾用户 cc TUI 进程；输出 JSON `{target, intent, reason}`，daemon 拿 target 路由 + intent 当 cc prompt + echo 给 IM 端可见；任何错误（cc 不在 PATH / 网络 / 解析失败）→ 静默降级为 `❌ 无法识别目标，请用 #<tab>`，不阻断 daemon。**不**用 Anthropic API SDK（用户已有 cc Pro/Max 订阅，再付 API key 是反人类）；**不**长进程化（cc TUI 不为 daemon stdin/stdout 设计，per-msg spawn 简单可靠）。[DD: AI 路由 IM dispatch](superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md) |
| 价格表来源 | ✓ DD 完成 | vendor LiteLLM Claude 子集 + `scripts/sync-prices.sh` 周期同步 + `config.toml [pricing]` user override；[DD: 价格表来源](superpowers/specs/2026-04-30-pricing-table-dd.md)。analytics package v2 实施时按此设计落地（v1 未实施 — Follow-up 列表）|
| 语音 / 图片 / 文件 | v2 推后 | DD #86 §8.4 锁定 v1 lark MVP = text + interactive cards。语音 / 图片 / 文件由 lark IM v1 audio/image/file msg_type 在 v2 加；v2 实施时按 §11.3 用 `~/.multi-cc-im/inbox/<imType>/<sid>/` 落本地。v1.4 wechat 时代有的 iLink voice_text + AES-128-ECB 解密路径已随 wechat purge 删除。|
| Pane-keyed state file 架构（DD #61）| ✓ | **路由 key = wezterm paneId**，daemon 不再追踪 sessionId / 单独检测 cc 活性。文件命名 `<paneId>_<sid>.<event>`（cc-hook 写）+ `<paneId>.IMOrigin`（daemon 写）；hook 入口 `WEZTERM_PANE` env undefined 直接静默 exit；matcher 只用 tab title（4 级 fallback：=strict / exact / prefix / glob），不接受 `#$<sid-prefix>` / `#$<paneId>`；用户可见警告：tab title 用纯数字易混淆。原 SessionStart / SessionEnd hook + PaneAlive verification 全部撤销。[DD: pane-keyed state files](superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md) |
| Credentials 持久化 | ✓ | **0600 JSON 文件**（`~/.multi-cc-im/credentials/<im>.json` — e.g. `lark.json` `{appId, appSecret, savedAt}`）；**不调 OS keychain**（`@napi-rs/keyring` WSL 默认开箱失败 + Windows DPAPI 同用户进程互通防护有限 + 一致跨 IM）；[DD: credentials 持久化策略](superpowers/specs/2026-05-03-keychain-library-dd.md) |
| Permission prompt 转发 IM 审批 | ✓ | **PreToolUse hook + file IPC**：hook 子进程写 `<paneId>_<sid>.PermissionRequest.<id>.json` → daemon forward IM → 用户回 (a) 死语法 `#<tabname> /1`（允许）/`/2`（拒绝） 或 (b) **自然语言**（"multi-cc-im 那个 rm 同意" / "deny the bash one"，v1.7 起；daemon 把当前所有 pending Request 喂同一个 AI router 子进程，AI 决 target+decision+reason 写进 `permissionResponse` 输出字段；非对称信任：allow 必须含 match-signal 否则降级 deny；deny 自由）→ daemon 写 `<paneId>_<sid>.PermissionResponse.<id>.json`（AI 路径用 AI verbatim reason，死语法 fall back 默认串 `"IM user replied /1\|/2"`）→ hook 读完写 stdout `{permissionDecision: "allow"/"deny"}`。10 秒 timeout 默认 allow。AI 路径独立 `[AI permission] target=X decision=Y reason="..."` audit log 行（与 `[AI router]` 区分）。[DD: permission forward](superpowers/specs/2026-05-07-permission-forward-dd.md) + [DD: natural-language permission replies](superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) |
| IM 模式总开关 (IMWork) + global IMOrigin + read-only 工具白名单 | ✓ | **三层组合**：`state/IMWork` JSON `{auto:bool}`（用户 bare `/start [off] /stop` 显式控制；**v1.7 起 bare `/start` 默认 `auto:true`**；`/start off` 切到 `auto:false` ask 模式；daemon start 自动重置为 OFF；老 0-byte 文件兼容视为 `{auto:false}`）+ **`state/IMOrigin` 单文件**（每条 inbound 覆盖 latest replyCtx；daemon start/stop 都删，跟 IMWork 同 always-fresh lifecycle，防 crash 残留 stale `context_token`；不再 per-pane / 不再 cc Stop 后 one-shot 删，[DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md) 修 stale token bug）+ Read/Grep/Glob/NotebookRead 自动 allow 不打扰 IM。hook PreToolUse 5 步：read-only → allow / IMWork null → **silent exit (defer 给 cc 原生 permission flow，user allow rules 优先命中)** / IMWork.auto=true → allow（trust mode，跳过 IM 转发）/ 无 IMOrigin → silent exit / 无 daemon → silent exit。**禁用 `permissionDecision: "ask"`** —— 它会 override user 已设的 "Yes don't ask again" allow rules。daemon reaper 10s 兜底删孤儿 PermissionRequest/Response。[DD: IMWork+IMOrigin](superpowers/specs/2026-05-08-imwork-imorigin-dd.md) + [DD: PreToolUse auto-approve](superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md) + [DD: IMOrigin global](superpowers/specs/2026-05-08-imorigin-global-dd.md) |
| Daemon liveness 检测 (PID lock + lstart 配对验证) | ✓ | `state/daemon.pid` JSON `{ pid, startedAt }`：daemon start 写 + 双开检测（已有 PID 活 + lstart 一致 → exit 1；stale lock → 覆盖）；daemon stop 删 IMWork + daemon.pid（Ctrl+C 清理）；hook PreToolUse + Stop 加 `isDaemonAlive()` short-circuit（`process.kill(pid, 0)` + `ps -o lstart=` 配对，防 OS PID 复用）。完整 hook decision tree 顺序：WEZTERM_PANE 入口 filter → read-only → IMWork → `<paneId>.IMOrigin` → daemon alive。state-sweep 用 wezterm `cli list` 的 paneId 集合做 ground truth，清掉 paneId 不在 live 集里的 orphan 文件 + stale daemon.pid（safe to run while daemon live：保留有效 lock）。[DD: daemon liveness](superpowers/specs/2026-05-09-daemon-liveness-dd.md) + [DD: pane-keyed state files](superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md) |
| Interactive start/setup wizard | ✓ DD 完成 | **单 `multi-cc-im start [<adapter>]` 命令**：无参 → `@clack/prompts` arrow-key 菜单选 IM adapter（光标默认聚焦在已配置过的 adapter，由 `~/.multi-cc-im/credentials/<adapter>.json` 文件存在性判定）；有参 → 直接选指定 adapter；选定后查凭据 — 已配置则进 daemon 主循环，未配置则显示 `❌ <adapter> 未配置 \| [开始配置] [返回]` —— 选 [开始配置] 进 schema-driven setup wizard，wizard 跑完同进程续 daemon；选 [返回] 回菜单（无参情况）/ 退出 1（有参情况）。`!process.stdin.isTTY` + 无参数 → exit 1 + hint。**Setup wizard 接口**：每个 IM adapter 包导出 `setupSchema: AdapterSetupSchema`（zod schema 含 per-field metadata `{ key, label, hint, secret }`）+ `validate(values): Promise<void>` callback；CLI 通用 wizard 按 schema 渲染 prompts，secret 字段用 AWS CLI 风格 mask `'*'*16 + last_4`（非 secret 字段全显）；编辑已存凭据时显示当前默认值，回车保留 / 输入新值替换。**配置指南**：`docs/setup-feishu.md`（每个 IM 一份）作为 source of truth，wizard 启动时 `terminal-link` v5 渲染含 OSC 8 hyperlinks 的 inline ASCII 步骤，不支持 OSC 8 的终端降级 plain-text；可选 `open` v11 跳浏览器（容错 SSH/headless）。**Cancel 语义**：`@clack/prompts` 返回 sentinel `cancel symbol` + `isCancel(value)` 检查，无 throw，daemon 不被 SIGINT 杀。**保留 `multi-cc-im login <adapter> --app-id ... --app-secret ...` 非交互 shortcut** 给 CI / 脚本自动化场景，走同一 schema 写盘。[DD: interactive start wizard](superpowers/specs/2026-05-10-interactive-start-wizard-dd.md) |

---

## 项目特定技术规范

CLAUDE.md 包含跨项目通用的工程纪律（TS strict / no `any` / no 裸 catch / 凭据 0600 / TDD 节奏 / etc.）。本节是 multi-cc-im **特定** 实现规范 —— 写跟 cc hook / wezterm cli / IM adapter / IPC 文件相关的代码时**必须**遵守。

| 规范 | 备注 |
|---|---|
| **Hook 内部 timeout < cc-side hook timeout** | cc settings.json 给 hook 的 `timeout` 是 cc kill 子进程的 deadline；hook 自己 `PERMISSION_TIMEOUT_MS` 必须**小于**它（PR-G：10s vs 20s）。10s margin 覆盖：(1) hook 写 stdout + cleanup；(2) daemon-side IM send 重试 / 抖动预算；(3) 网络抖动。否则 race 时 cc 拿不到 hook decision、行为不确定 |
| **send-text 注入两步法** | Step1 默认 paste 内容（任意 `\n` / 元字符 / Unicode 安全），Step2 `--no-paste $'\r'` 提交。混用 `--no-paste` 发内容 = 注入面（cc TUI 解释快捷键）|
| **multi-cc-im hook 不许写非协议 stdout** | cc 把 hook stdout 当 system context 注入（attachment 机制）→ 烧 token + 行为不可预测。受控 JSON（`{"decision":"block",...}` / PreToolUse `{hookSpecificOutput:...}`）除外，其他一律走 stderr 或文件 |
| **idle 唤醒用 `stop_hook_active` 防死循环** | Stop hook 处理时先 `if (stdin.stop_hook_active) return;`。stdin 字段是 cc 原生防护，零 race，比文件标记可靠 |
| **路由解析 = `WEZTERM_PANE` env** | hook env 直接给，O(1)。禁用 `wezterm cli list` 解析 cwd 反推 pane-id（O(N) + 多 cc 同 cwd 时歧义） |
| **`#<name>` 只匹配 tab title** | 不接受 `#$<sid-prefix>` / `#$<paneId>` — daemon 不再持 sessionId，paneId 是数字易跟 tab title 撞。用户 tab title 用纯数字 → `/start` echo 主动警告。session 死 = 用户的 cc TUI 死 = 用户自己重开新 tab；daemon 不做 pane-alive 验证，每次 IM 事件直接调 `wezterm cli list`（[DD: pane-keyed state files](superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)）|
| **路由 visible echo 必须有** | bot 把消息派给 cc 前后必须给 IM 端可见反馈（`→ frontend received` / `📌 current = frontend` / `⚠️ frontend disconnected, current cleared`），否则 last-explicit-mention 粘性的 current_session 状态跟用户脑模型会错配（[DD: 路由语法](superpowers/specs/2026-05-04-routing-syntax-dd.md) 第 4 步理由 3） |
| **路由 key 用 `CLAUDE_PROJECT_DIR` 或 `stdin.cwd`** | 已 realpath；不要用 `PWD` env（macOS `/tmp` vs `/private/tmp` 不一致） |
| **不修改 cc 自己的 jsonl** | `~/.claude/projects/**/*.jsonl` 只读；任何写入都是 bug |
| **凭据落本地路径约定** | `~/.multi-cc-im/credentials/<im>.json` (mode 0600) — 通用规则在 CLAUDE.md「凭据 0600 落盘」；具体 schema (`{appId, appSecret, savedAt}` 等) 见 [`packages/im-lark/src/credentials.ts`](../packages/im-lark/src/credentials.ts) |

---

## 项目特定禁止清单

通用禁令（TS `any` / shell 字符串拼接 / 动态代码求值 / 凭据明文 / 同步阻塞 hook / 跳过 DD / etc.）见 [`CLAUDE.md`](../CLAUDE.md)「禁止清单」。下列是 multi-cc-im **特定** 禁令（绑 cc / wezterm / IM 协议 / IPC 文件）：

- 托管 / spawn cc 进程（用户的 cc TUI 实例）
- 修改 cc 的 jsonl（`~/.claude/projects/**/*.jsonl`）
- 用非官方 / 灰产 / 逆向协议（仅官方 IM SDK；当前 = `@larksuiteoapi/node-sdk`）
- 公网传输用户 prompt（含外部图床）
- 不带 cursor 的长轮询（如果适用 — lark WSClient 不需要，未来 IM 可能需要）
- "[执行命令]" 注入字段直接落 cc
- adapter 间直接 import（违反 4 维度可扩展）
- 把 share 对话当 ground truth
- hook 写非协议 stdout（污染 cc context）
- 用 `PWD` 做路由 key（须用 `CLAUDE_PROJECT_DIR`）
- 用 `wezterm cli list` 解析 cwd 反推 pane-id（须用 `WEZTERM_PANE` env）
- send-text 单步带回车（须分两步）
- hardcode 外部 CLI 绝对路径（wezterm 等须运行时探测）
- 自动 last-reply-to 粘性（cc 最后回复的 session 自动当下次 current_session — Cline #3514 用户反弹证伪）
- 路由 `#<前缀>` 歧义时自动挑第一个（须报错列候选 — tmux/screen/Vim/aider 全行业拒绝）
- `#$<sid-prefix>` / `#$<paneId>` 路由（DD #61：matcher 只用 tab title，纯数字 tab 由 `/start` 警告）

---

## 参考资料

### DD 报告

- Lark/Feishu IM adapter（**当前**，DD #86）: [`superpowers/specs/2026-05-09-lark-im-adapter-dd.md`](superpowers/specs/2026-05-09-lark-im-adapter-dd.md)
- cc Hook + wezterm cli 行为实测（**已完成**）: [`superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md`](superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
- iLink 协议库选型（**v1.4 wechat 时代历史**，DD #86 §11.2 已 supersede）: [`superpowers/specs/2026-04-26-ilink-library-dd.md`](superpowers/specs/2026-04-26-ilink-library-dd.md)
- 全部 DD 报告：[`superpowers/specs/`](superpowers/specs/)

### 工程文档

- [`architecture.md`](architecture.md) — 架构图 / 包依赖 / 目录结构 / 数据存储（toml + 0600 凭据 + state files）/ 外部 CLI 路径策略
- [`competitors.md`](competitors.md) — 不直接采用的端到端项目
- [`dev.md`](dev.md) — 开发命令 / TDD 节奏 / 调试技巧
- [`../CLAUDE.md`](../CLAUDE.md) — AI 干活纪律（找根因 / DD 流程 / 编码行为准则）

### 上游文档

- Lark/Feishu Node SDK: https://github.com/larksuite/node-sdk
- Feishu Open Platform IM v1: https://open.feishu.cn/document/server-docs/im-v1/message/create
- Feishu event subscription (WSClient long-connection): https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- Claude Code Hook: https://code.claude.com/docs/en/hooks
- Claude Code Permissions: https://code.claude.com/docs/en/permissions
- WezTerm CLI: https://wezterm.org/cli/cli/index.html | send-text: https://wezterm.org/cli/cli/send-text.html

### 输入材料归档（gitignored，**不作 ground truth**）

- 设计对话原文：`.playwright-mcp/share-fulltext-*.json`
- 端到端项目调研：`.playwright-mcp/research-deep.txt`
