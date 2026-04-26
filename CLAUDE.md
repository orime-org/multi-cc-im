# 项目简介

`multi-cc-wechat` —— 个人本地 bridge：通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到微信，实现"在公司用控制台 + 外面用微信"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> **当前状态**：v0 设计阶段。仓库内除基础设施（`.gitignore` / `CLAUDE.md` / 全局 settings / project memory）外尚无业务代码。下面"目录结构 / 开发命令 / 数据存储"反映**设计意图**，未实际就绪；"核心约束 / 关键设计决定 / 编码行为准则"已锁定。

# 核心约束（项目第一原则）

任何架构决策必须先过这两条。违反即重新设计。

1. **不破坏现有 cc 进程**
   cc 继续以 TUI 形式跑在用户 WezTerm tab 里。bridge **不** spawn cc、**不** 接管 stdin/stdout、**不** 包一层伪 TUI。
   - 出站靠 cc 原生 hook（`SessionStart` / `UserPromptSubmit` / `Stop` / `PostToolUse`）
   - 入站靠 `wezterm cli send-text`（等价人手敲键盘）
   - 用户随时可直接 attach 那个 tab 跟 cc 互动，bridge 不在中间挡。
   - 这条约束是用户在设计对话第 4 轮主动否决 broker 重写方案后定的，不可让步。

2. **用现有 SDK 与扩展点，不造轮子**
   - 微信协议：`photon-hq/wechat-ilink-client`（独立零依赖 TS 库），不自己抄 iLink。
   - 终端：`wezterm cli` 子命令，不自己解析 ANSI escape。
   - cc 集成：cc 自身 hook 系统，不写 broker / Agent SDK 包装层。
   - 出现"我们自己造一套"的诱惑 → 重新查 npm/GitHub 是否有现成的。

# 技术栈（计划）

Node.js 22+ | TypeScript 5.x strict | pnpm workspace monorepo | tsup | Vitest | better-sqlite3 | photon-hq/wechat-ilink-client | pino + pino-roll | zod

# 架构（4 维度 adapter + 1 分析层）

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
| IM | wechat (iLink) | telegram / slack / 飞书 / discord | 长轮询/WS/Webhook 各异 |
| Term | wezterm cli | tmux / zellij / ghostty | 子命令 wrapper |
| CLI | claude-code | codex / gemini / aider | hook 模式（v1） vs spawn 模式（v2） |
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

**严格边界**:adapter 之间互不 import;core 只 import shared 的接口;apps/bridge 装配所有 adapter。任何 adapter 内部不允许直接 import 另一个 adapter(要通过 core 的 message bus)。

## 目录结构（计划）

```
packages/
├── shared/         # IMAdapter / TermAdapter / CLIAdapter / StorageAdapter 接口 + 类型
├── core/           # router · session map · message bus · @ 解析器
├── im-wechat/      # 包 photon-hq/wechat-ilink-client + 实现 IMAdapter
├── term-wezterm/   # wezterm cli wrapper + 实现 TermAdapter
├── cli-claude-code/# hook + transcript jsonl parser + 实现 CLIAdapter
├── storage-sqlite/ # events / sessions / usage 表 + 迁移
└── analytics/      # /usage /cost 命令族 + 定时报告
apps/
└── bridge/         # 装配 adapters 的主进程,pino 日志
scripts/            # SessionStart.sh / Stop.sh / UserPromptSubmit.sh hook
docs/
└── ilink-protocol.md  #(待写)iLink 接口、CDN AES 流程、context_token 注意事项
```

# 关键设计决定（已锁定）

| 维度 | 决定 |
|---|---|
| 出站 | cc Stop / UserPromptSubmit / PostToolUse hook → HTTP POST 到 `localhost:9999/event/*` |
| 入站 | bridge 收微信 → 解析 `@session` 路由 → `wezterm cli send-text --pane-id N` |
| Idle 唤醒 | Stop hook 返回 `{decision:"block", reason:"<新 prompt>"}` 把微信消息注入；空闲超时降级为 send-text 兜底 |
| Session 标识 | `session_id` 主键（持久，cc 自带） + `pane_id` 二级（重启会变） + `friendly_name`（用户可见） |
| 路由语法 | `@web 改下登录` 前缀；模糊匹配（prefix + Levenshtein）；无 `@` 落到上次粘性 session；`@?` 列表；`@a @b 文本` 多播 |
| 语音 | iLink 自带 `voice_text`（腾讯端转好），降级才跑本地 whisper |
| 图片/文件 | AES-128-ECB 解密 → 落盘 `~/.cc-wechat/data/inbox/<session>/<ts>.jpg` → 路径塞进 prompt → cc 自己 `Read` 工具加载 |
| Storage | tail `~/.claude/projects/<slug>/<session>.jsonl` 增量写 events 表（usage 字段已含 input/output/cache_read/cache_creation） |
| 价格表 | JSON 配置文件,model_id → $/Mtok,独立维护 |

# 不直接采用的项目（决策记录）

| 项目 | ★ | 不采用原因 | 借鉴点 |
|---|---|---|---|
| chenhg5/cc-connect | 6119 | spawn 模式不能托管 WezTerm tab 已有 cc;Go 项目难复用 TS 接口 | adapter 矩阵(11 IM × 10 CLI)的接口设计参考 |
| Johnixr/claude-code-wechat-channel | 269 | 每 ClawBot 只接 1 agent 实例(多 session 死路) | iLink 接入流程参考 |
| sgaofen/cli-in-wechat | 264 | `@` 切**工具种类**而非切多个同种 cc | `/resume` 历史会话 + 跨通道漫游设计 |
| Wechat-ggGitHub/wechat-claude-code | 238 | 单 session | **斜杠命令体系完整**(`/help` `/clear` `/model` `/cwd` `/permission` `/skills`),直接抄 |
| six-ddc/ccmux(原 ccbot) | (中) | IM=Telegram + term=tmux + Python,不直接 fork | hook+send-keys 架构 + transcript 解析 + tool_use 配对 |
| Bergamolt/telegram-sessions | 4 | Telegram + tmux | 多 session `/new`/`/sessions`/`/kill` 命令 + Allow/Deny 按钮 |
| photon-hq/wechat-ilink-client | 48 | ⭐ **直接 import 当 IM 协议层**,省 ~300 行手抄 | — |
| lc2panda/claude-plugin-wechat | 55 | Channel + ACP,不是 hook 路线 | 多渠道(微信+飞书) + 远程权限审批 + 全媒体 UX 参考 |

# 开发命令（计划）

```bash
pnpm install               # 装依赖
pnpm dev                   # turbo 启所有包 watch
pnpm typecheck             # tsc --noEmit(所有 packages)
pnpm test                  # vitest(mock,无需外部依赖)
pnpm build                 # tsup 编译所有 package 到 dist/
pnpm bridge:start          # 启动 bridge 主进程
pnpm bridge:hook-install   # 把 SessionStart/Stop/... 写入 ~/.claude/settings.json
pnpm bridge:wechat-login   # 扫码登录 iLink,存 bot_token 到 OS keychain
```

# 数据存储

```
~/.cc-wechat/
├── config.toml           # session friendly_name 映射 / 路由偏好 / 价格表
├── data/
│   ├── events.db         # SQLite: events · sessions · usage
│   └── inbox/<sid>/      # 微信进来的图片/文件落盘(cc Read 用)
└── logs/
    └── bridge-YYYY-MM-DD.log  # pino-roll 日轮转
```

凭据(`bot_token` / `WECHAT_PROFILE` / 任何敏感 token)走 OS keychain(macOS Keychain / Linux secret-tool / Windows credential manager),**不写 `config.toml`、不写日志、不写环境变量**。

## SQLite Schema（events 表骨架）

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,           -- cwd
  cli TEXT NOT NULL,                -- 'claude-code' / 'codex' / ...
  role TEXT NOT NULL,               -- user | assistant | tool_use | tool_result
  model TEXT,
  tokens_in INT, tokens_out INT, tokens_cache_read INT, tokens_cache_create INT,
  tool_name TEXT,
  content_blob BLOB,                -- gzip 压缩的原文(可关)
  cost_usd REAL                     -- 派生,价格表算
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_project ON events(project);
```

# 关键规范（MANDATORY）

| 规范 | 备注 |
|---|---|
| **禁止 AI 作者署名** | commit / PR / issue 一律不带 `Co-Authored-By` 或 `Generated with Claude Code`。已有全局 `~/.claude/settings.json` 的 `attribution: { commit: "", pr: "" }` + project memory 双防线。任何 PR 模板里出现这两类署名 = 拒收 |
| **TypeScript strict, 禁止 `any`** | 用 `unknown` 替代;外部输入用 `zod` runtime 校验 |
| **禁止 `var` / `require()`** | ESM only,`type: "module"` |
| **公共函数必须 TSDoc** | `@param @returns @throws @example`,ESLint `eslint-plugin-tsdoc` 强制 |
| **禁止裸 catch** | 必须分类 + `pino` log;不许 `catch(e) {}` 吞错 |
| **禁止硬编码密钥** | `.env` + `zod` 校验,启动时缺一即 `process.exit(1)` |
| **Local-first** | 所有用户数据落本机 SQLite + 文件,**不上传任何外部服务**(含错误上报、统计、第三方 LLM 走转写等) |
| **iLink 长轮询必须有** | timeout(35s+) + 退避重试 + cursor 持久化(重启后续接,不掉消息) |
| **send-text 注入必须转义** | 换行 / 制表符 / 控制字符按 wezterm 规约处理;防止意外触发 cc 命令 |
| **不修改 cc 自己的 jsonl** | `~/.claude/projects/**/*.jsonl` 只读;任何写入都是 bug |
| **凭据进 keychain** | `bot_token` 落盘前必须经 `keytar` / `secret-tool`;明文出现在文件或日志 = bug |

# 禁止清单

托管 / spawn cc 进程 | 修改 `~/.claude/projects/**/*.jsonl` | 用非官方 / 灰产 / iPad 协议(仅腾讯 iLink)| 公网传输用户 prompt(含外部图床)| 任意形式的 shell 字符串拼接执行(统一用 execFile 数组形式 `(cmd, [arg1, arg2])`)| 任意形式的"动态代码求值"(用户可控字符串作为可执行体的 JS 求值)| bot_token 写到 toml/日志/console | 不带 cursor 的长轮询 | 把"\[执行命令\]"等指令注入字段直接落 cc | TS `any` | 裸 SQL 字符串 | 同步阻塞 hook 脚本 > 1s | adapter 间直接 import | service 层依赖 framework

# 编码行为准则

> 这一节直接继承 breatic 的工程准则。以下 5 条 + 6 个禁止补丁词汇 + 3 条动手前自检对所有 PR 强制适用。

## 1. 先想再写
- 不假设、不隐藏困惑、主动暴露权衡
- 多种理解时**列选项让用户选**,不许自己拍板
- 不确定先问,不许"先实现一版试试"

## 2. 简单优先
- 写最少代码。不做超出要求的功能
- 单次使用的代码不做抽象
- 不可能发生的场景不做错误处理

> **本项目特例**:4 维度 adapter 是用户明确要求的可扩展性,**不属于过度设计**;但每个 adapter 内部仍要严格简单优先。

自检:"一个高级工程师会说这过度复杂吗?" 是 → 简化。

## 3. 精准修改
- 只改必须改的。不"顺手改进"周围代码、注释、格式
- 删除自己修改导致无用的 import / 变量 / 函数
- **不要删除修改前就存在的死代码**(除非被要求)
- Diff 每一行都能直接追溯到用户的需求

## 4. 目标驱动执行
任务转化为可验证目标:
- "加 @ 路由" → "为模糊匹配 / 多播 / 粘性默认写 vitest 用例,让全部通过"
- "修长轮询断开" → "写 cursor 持久化的复现测试,让测试通过"
- "重构 X" → "确保重构前后测试通过"

多步任务先声明简要计划:

```
1. [步骤] → 验证:[检查方式]
2. [步骤] → 验证:[检查方式]
```

强成功标准让你独立循环;弱标准("让它跑起来")需要不断回头确认。

## 5. 彻底解决,禁止补丁（MANDATORY — 零容忍）

定位根因、提彻底方案;禁止头疼医头、脚疼医脚。**方案不彻底 = 违规**。

### 硬性规则
- **方案未经用户确认前,不动代码**
- **方案不唯一时**:列每个选项的复杂度、回归面、架构影响,让用户选;不许自己拍板
- **自己拿不准时**:必须问;不许猜、不许"先实现一版试试"
- **架构有根本缺陷**:提架构变更,不在缺陷上打补丁
- 已有同类系统的现成模式(adapter 注册 / hook 注入 / events bus 等):彻底方案必须对齐,不许新发明半套

### 明令禁止的补丁词汇

一旦出现以下任意一种,立即停手,重新设计:

"作为 compat shim / 兼容层 / 适配层"(保留老 API 绕过重构)  
"作为 legacy mirror / 只读镜像"(旧数据源副本救老代码)  
"作为 escape hatch / 全局 ref / 单例"(绕架构边界)  
"临时 / 过渡 / 暂时 / 先这样 / 后续再改"(技术债登记,不是解决方案)  
"为了不改 XX 个 callsite / 工作量考虑"(把工作量当借口换架构妥协)  
"两条路径并存 / hybrid / 双写"(违反单一真相源)

### 动手前三条自检（全通过才写代码）

1. 在解决**根因**,还是只压症状?后者 → 停下来重想
2. 方案是**唯一解**,还是我在多个里挑了一个?后者 → 停下来问用户
3. 方案里有**任何一处"暂时 / 兼容 / 补丁"**?有 → 该处就是下次要返工的地方,现在重做

### 违规成本

> 给出不彻底方案 → 用户耗费精力识别、拆穿、重提需求。  
> **这是对用户时间的犯罪**,不是工程瑕疵。  
> 发现自己写了补丁 → 立即撤回、重做,**不许辩护、不许找理由、不许谈工作量**。

# 参考资料

- iLink Bot 协议实现参考:[`photon-hq/wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)(独立 TS 库,零依赖)
- iLink 协议 markdown:`hao-ji-xing/openclaw-weixin/weixin-bot-api.md`
- Claude Code Hook 文档:https://docs.anthropic.com/en/docs/claude-code/hooks
- WezTerm CLI 文档:https://wezterm.org/cli/cli/index.html
- 项目设计对话原文(与 Claude.ai 的设计讨论):归档在 `.playwright-mcp/share-fulltext-*.json`(gitignored)
- GitHub 调研结果(cc-connect / ccbot 等深扒):归档在 `.playwright-mcp/research-deep.txt`(gitignored)
