# 项目简介

`multi-cc-im` —— 个人本地 bridge：通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到微信，实现"在公司用控制台 + 外面用微信"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> **当前状态**：v0 设计阶段。仓库内除基础设施（`.gitignore` / `CLAUDE.md` / 全局 settings / project memory）外尚无业务代码。  
> 已锁定：**核心约束 / 编码行为准则 / DD 流程 / 工程价值观**。  
> **未锁定**：所有具体技术选型 / 协议层实现 / 关键设计假设 —— 必须经"重大决策 DD 流程"验证后才能写入设计 doc 锁定。  
> 历次修订：2026-04-26 v0.1（初稿，含未经验证的 share 对话内容） → v0.2（撤回所有源自 share 但未独立验证的"已锁定"，降级为"待 DD 假设"）。

# 核心约束（项目第一原则）

任何架构决策必须先过这两条。违反即重新设计。

1. **不破坏现有 cc 进程**
   cc 继续以 TUI 形式跑在用户 WezTerm tab 里。bridge **不** spawn cc、**不** 接管 stdin/stdout、**不** 包一层伪 TUI。
   - 出站：依赖 cc 原生扩展点（具体 hook / 接口待实测验证）
   - 入站：依赖 `wezterm cli` 子命令（语义待实测验证）
   - 用户随时可直接 attach 那个 tab 跟 cc 互动，bridge 不在中间挡。
   - **价值观源头**：用现有扩展点而非破坏现有进程；这条是设计层硬约束，不是某次对话推论的产物。

2. **用现有 SDK 与扩展点，不造轮子**
   - 微信协议：用社区已有实现，**具体选型待 DD 锁定**；禁止 from scratch 除非 DD 证明所有候选都不可用
   - 终端：`wezterm cli` 子命令（CLI 文档可达），不自己解析 ANSI escape
   - cc 集成：用 cc 自身扩展点（待实测确认哪些可用），不写 broker / Agent SDK 包装层
   - 出现"我们自己造一套"的诱惑 → 重新查 npm/GitHub 是否有现成的，并执行 DD 流程

# 重大决策 DD 流程（强制）

任何"重大决策"在写入 CLAUDE.md 锁定 / 在代码中实施前**必须**走完此流程。

## "重大决策"启发式

凡满足以下**任一**条件 → 重大决策：

- 影响项目安全模型（凭据存储 / 协议鉴权 / 网络出站 / 用户数据）
- 影响长期维护负担（核心依赖 / 协议层 / 数据层）
- 影响范围超过单个 package（跨包接口 / 共享类型 / 全局状态）
- 反悔代价 > 1 周工作量
- 影响"用现有 SDK 不造轮子"准则的具体实施

典型例子：iLink 协议库选型、storage 数据库选型、auth/keychain 库选型、term 适配器策略、IM/CLI adapter 接口设计、价格表来源、bridge 部署形态。

## 5 步 DD 流程

1. **候选枚举**：穷举所有可见候选（含 from scratch / vendor in / npm depend / 第三方调用 / 跨语言抄）
2. **每个候选的尽调**：
   - **实测**：能 `npm install` 跑通？核心 path 能跑？
   - **源码**：体量（行数/文件数）、模块化、测试覆盖、依赖清单
   - **治理**：commit 活跃度、issue 响应速度、维护者画像、license
   - **安全**：外部 HTTP 调用 / 上传任何用户数据 / 已知 CVE
   - **协议/上游跟进**（如适用）：上游变化时这个仓库的响应速度（看 git history pattern）
3. **对比矩阵**：候选 × 维度 → 表格，每格填可引用证据（commit hash / star 趋势 / issue 链接），不许填印象
4. **基于 DD 数据的推荐 + 推荐理由**：每条理由必须可追溯到 DD 矩阵某格证据
5. **用户决定** → 写入设计 doc → 锁定到 CLAUDE.md

DD 文档保存到 `docs/superpowers/specs/<topic>-dd.md`，跟设计 doc 一起 commit。

## 反 DD 模式（违纪行为）

- 凭 star 数 / README 描述 / 第三方对话内容 / "感觉合适"拍板 → 浅表决策
- 把对话内容（含 Claude.ai share）当 ground truth → 把 hearsay 升格
- 跳过候选枚举只列 2-3 个 → 假对比
- 推荐时引用单一证据（"它 stateless 所以好"）→ 单点论据
- 提议"先用 X 后续再换" → 治标补丁

**未做 DD 就动手 = 违反纪律 = 当场撤回**。绕开 DD 的方案 = **治标补丁，对用户时间的犯罪**。

# 技术栈（计划）

Node.js 22+ | TypeScript 5.x strict | pnpm workspace monorepo | tsup | Vitest | better-sqlite3 | iLink 协议（vendored 自 `Tencent/openclaw-weixin` v2.1.7）| pino + pino-roll | zod

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
| IM | wechat (iLink, vendored `Tencent/openclaw-weixin` v2.1.7) | telegram / slack / 飞书 / discord | 长轮询/WS/Webhook 各异 |
| Term | wezterm cli | tmux / zellij / ghostty | 子命令 wrapper |
| CLI | claude-code（hook 路线 — 待实测） | codex / gemini / aider | hook 模式（v1） vs spawn 模式（v2） |
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
├── core/           # router · session map · message bus · @ 解析器
├── im-wechat/      # iLink 客户端（vendored 自 `Tencent/openclaw-weixin` v2.1.7 → lib/ilink/）+ IMAdapter 实现
├── term-wezterm/   # wezterm cli wrapper + 实现 TermAdapter
├── cli-claude-code/# hook + transcript jsonl parser + 实现 CLIAdapter
├── storage-sqlite/ # events / sessions / usage 表 + 迁移
└── analytics/      # /usage /cost 命令族 + 定时报告
apps/
└── bridge/         # 装配 adapters 的主进程，pino 日志
scripts/            # SessionStart.sh / Stop.sh / UserPromptSubmit.sh hook
docs/
└── superpowers/specs/  # brainstorming 输出的设计 doc + DD 报告
```

# 关键设计假设（**待 DD 验证**）

> v0.1 这一节标题是"已锁定"且"来源 share QN"。v0.2 全部降级为"假设"，每条加验证状态。✓ = 协议事实/文档/可观测；⚠️ = 待实测；? = 待用户/DD 决策。

| 维度 | 当前假设 | 验证状态 |
|---|---|---|
| 协议层实现 | Vendor 抽取 `Tencent/openclaw-weixin` v2.1.7 协议子目录（`src/{api,auth,cdn,messaging,media,util,storage,config}/`）→ `packages/im-wechat/lib/ilink/`；删除 runtime.ts、重写 monitor.ts 去除 OpenClaw 依赖 | ✓ DD 完成 — 见 [DD 报告](docs/superpowers/specs/2026-04-26-ilink-library-dd.md) |
| 出站机制 | cc Stop / UserPromptSubmit / PostToolUse hook → HTTP POST `localhost:9999/event/*` | ⚠️ hook 行为需实测；具体 hook 集合需文档核 + 实测 |
| 入站机制 | bridge 收微信 → 解析 `@session` 路由 → `wezterm cli send-text --pane-id N` | ⚠️ send-text 注入语义 + 转义规则需实测 |
| Idle 唤醒 | Stop hook 返回 `{decision:"block", reason:"<新 prompt>"}` 把消息注入 | ⚠️ 真实模型行为需实测（cc 是否真把 reason 当作下一轮用户输入） |
| Session 标识 | session_id 主键 + pane_id 二级 + friendly_name | ✓ session_id 是 cc hook 自带；⚠️ WEZTERM_PANE 在 hook stdin 子进程的可用性需实测 |
| 路由语法 | `@web 改下登录` 前缀；模糊匹配；粘性默认；`@?` 列表；`@a @b` 多播 | ? 用户偏好（brainstorming 部分确认，待最终 sign-off） |
| 语音 | iLink 自带 `voice_text`（腾讯端转好），降级 whisper | ⚠️ 协议字段存在性 + 实际填充率需实测 |
| 图片/文件 | AES-128-ECB 解密 → 落盘 inbox → 路径塞 prompt → cc Read | ⚠️ 协议字段 + 解密流程需实测（与协议库 DD 联动） |
| Storage | tail `~/.claude/projects/<slug>/<sid>.jsonl` 增量写 events 表 | ✓ cc 写 jsonl 是观察事实；⚠️ 实际 schema + tail 稳定性需实测 |
| 价格表 | JSON 配置 `model_id → $/Mtok` | ? 价格来源 / 更新机制 DD 中 |
| ACL | owner-only（仅登录者自己） | ✓ 协议层自带过滤（多源交叉验证：cc-connect / weixin_claude_code README） + brainstorming Q2 用户确认 |
| 多机 | 仅一台机器 | ✓ 协议层硬约束（getupdates cursor 全局共享 → 不允许多 instance polling） + brainstorming Q1 用户确认 |

# 不直接采用的端到端项目（决策记录）

> 本表是**端到端产品**的不采用判断（通过 gh repo view 实测仓库 + README 验证）。  
> **协议层候选**（photon-hq / openclaw-weixin / weixin_bot_plugin / cc-weixin / from scratch）**单独 DD**，见设计 doc。

| 项目 | ★ | 不采用原因 | 借鉴点 |
|---|---|---|---|
| chenhg5/cc-connect | 6119 | spawn 模式不能托管 WezTerm tab 已有 cc；Go 项目难复用 TS 接口 | adapter 矩阵接口设计参考 |
| Johnixr/claude-code-wechat-channel | 269 | "每 ClawBot 只接 1 agent 实例"（⚠️ 此结论源自 share，README 头我读过未见此明确表述，DD 时再核） | iLink 接入流程参考 |
| sgaofen/cli-in-wechat | 264 | `@` 切**工具种类**而非切多个同种 cc | 跨通道漫游 + `/resume` 设计 |
| Wechat-ggGitHub/wechat-claude-code | 238 | 单 session | 斜杠命令体系完整 |
| six-ddc/ccmux（原 ccbot） | (中) | IM=Telegram + term=tmux + Python | hook+send-keys 架构 + transcript 解析 + tool_use 配对 |
| Bergamolt/telegram-sessions | 4 | Telegram + tmux | 多 session `/new`/`/sessions`/`/kill` + 权限按钮 |
| lc2panda/claude-plugin-wechat | 55 | Channel + ACP，不是 hook 路线 | 全媒体 + 远程权限审批 + 多渠道 UX |

# 开发命令（计划）

```bash
pnpm install               # 装依赖
pnpm dev                   # turbo 启所有包 watch
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm build                 # tsup 编译所有 package 到 dist/
pnpm bridge:start          # 启动 bridge 主进程
pnpm bridge:hook-install   # 把 SessionStart/Stop/... 写入 ~/.claude/settings.json
pnpm bridge:wechat-login   # 扫码登录 iLink，存 bot_token 到 OS keychain
```

# 数据存储

```
~/.multi-cc-im/
├── config.toml           # session friendly_name 映射 / 路由偏好 / 价格表
├── data/
│   ├── events.db         # SQLite: events · sessions · usage
│   └── inbox/<sid>/      # 微信进来的图片/文件落盘（cc Read 用）
└── logs/
    └── bridge-YYYY-MM-DD.log  # pino-roll 日轮转
```

凭据（`bot_token` / `WECHAT_PROFILE` / 任何敏感 token）走 OS keychain（macOS Keychain / Linux secret-tool / Windows credential manager），**不写 `config.toml`、不写日志、不写环境变量**。

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
  content_blob BLOB,                -- gzip 压缩的原文（可关）
  cost_usd REAL                     -- 派生，价格表算
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_project ON events(project);
```

# 关键规范（MANDATORY）

| 规范 | 备注 |
|---|---|
| **禁止 AI 作者署名** | commit / PR / issue 一律不带 `Co-Authored-By` 或 `Generated with Claude Code`。已有全局 `~/.claude/settings.json` 的 `attribution: { commit: "", pr: "" }` + project memory 双防线 |
| **TypeScript strict, 禁止 `any`** | 用 `unknown` 替代；外部输入用 `zod` runtime 校验 |
| **禁止 `var` / `require()`** | ESM only，`type: "module"` |
| **公共函数必须 TSDoc** | `@param @returns @throws @example`，ESLint `eslint-plugin-tsdoc` 强制 |
| **禁止裸 catch** | 必须分类 + `pino` log；不许 `catch(e) {}` 吞错 |
| **禁止硬编码密钥** | `.env` + `zod` 校验，启动时缺一即 `process.exit(1)` |
| **Local-first** | 所有用户数据落本机 SQLite + 文件，**不上传任何外部服务** |
| **iLink 长轮询必须有** | timeout（35s+） + 退避重试 + cursor 持久化（重启后续接，不掉消息） |
| **send-text 注入必须转义** | 换行 / 制表符 / 控制字符按 wezterm 规约处理 |
| **不修改 cc 自己的 jsonl** | `~/.claude/projects/**/*.jsonl` 只读；任何写入都是 bug |
| **凭据进 keychain** | `bot_token` 落盘前必须经 `keytar` / `secret-tool`；明文出现在文件或日志 = bug |
| **重大决策必走 DD** | 见上"重大决策 DD 流程"节；未 DD 就实施 = 当场撤回 |

# 禁止清单

托管 / spawn cc 进程 | 修改 `~/.claude/projects/**/*.jsonl` | 用非官方 / 灰产 / iPad 协议（仅腾讯 iLink）| 公网传输用户 prompt（含外部图床）| 任意形式的 shell 字符串拼接执行（统一用 execFile 数组形式 `(cmd, [arg1, arg2])`）| 任意形式的"动态代码求值"（用户可控字符串作为可执行体的 JS 求值）| bot_token 写到 toml/日志/console | 不带 cursor 的长轮询 | 把"\[执行命令\]"等指令注入字段直接落 cc | TS `any` | 裸 SQL 字符串 | 同步阻塞 hook 脚本 > 1s | adapter 间直接 import | service 层依赖 framework | 把 share 对话当 ground truth | 跳过 DD 直接选型

# 编码行为准则

> 这一节直接继承 breatic 的工程准则。以下 5 条 + 6 个禁止补丁词汇 + 3 条动手前自检对所有 PR 强制适用。

## 1. 先想再写
- 不假设、不隐藏困惑、主动暴露权衡
- 多种理解时**列选项让用户选**，不许自己拍板
- 不确定先问，不许"先实现一版试试"

## 2. 简单优先
- 写最少代码。不做超出要求的功能
- 单次使用的代码不做抽象
- 不可能发生的场景不做错误处理

> **本项目特例**：4 维度 adapter 是用户明确要求的可扩展性，**不属于过度设计**；但每个 adapter 内部仍要严格简单优先。

自检："一个高级工程师会说这过度复杂吗？" 是 → 简化。

## 3. 精准修改
- 只改必须改的。不"顺手改进"周围代码、注释、格式
- 删除自己修改导致无用的 import / 变量 / 函数
- **不要删除修改前就存在的死代码**（除非被要求）
- Diff 每一行都能直接追溯到用户的需求

## 4. 目标驱动执行
任务转化为可验证目标：
- "加 @ 路由" → "为模糊匹配 / 多播 / 粘性默认写 vitest 用例，让全部通过"
- "修长轮询断开" → "写 cursor 持久化的复现测试，让测试通过"

多步任务先声明简要计划：

```
1. [步骤] → 验证：[检查方式]
2. [步骤] → 验证：[检查方式]
```

强成功标准让你独立循环；弱标准（"让它跑起来"）需要不断回头确认。

## 5. 彻底解决，禁止补丁（MANDATORY — 零容忍）

定位根因、提彻底方案；禁止头疼医头、脚疼医脚。**方案不彻底 = 违规**。

### 硬性规则
- **方案未经用户确认前，不动代码**
- **方案不唯一时**：列每个选项的复杂度、回归面、架构影响，让用户选；不许自己拍板
- **自己拿不准时**：必须问；不许猜、不许"先实现一版试试"
- **架构有根本缺陷**：提架构变更，不在缺陷上打补丁
- 已有同类系统的现成模式（adapter 注册 / hook 注入 / events bus 等）：彻底方案必须对齐，不许新发明半套
- **重大决策必走 DD 流程**（见上节）；DD 未完不许实施

### 明令禁止的补丁词汇

一旦出现以下任意一种，立即停手，重新设计：

"作为 compat shim / 兼容层 / 适配层"（保留老 API 绕过重构）  
"作为 legacy mirror / 只读镜像"（旧数据源副本救老代码）  
"作为 escape hatch / 全局 ref / 单例"（绕架构边界）  
"临时 / 过渡 / 暂时 / 先这样 / 后续再改"（技术债登记，不是解决方案）  
"为了不改 XX 个 callsite / 工作量考虑"（把工作量当借口换架构妥协）  
"两条路径并存 / hybrid / 双写"（违反单一真相源）  
"基于 share / 因为别的对话推荐"（把 hearsay 当事实 → DD 替代）

### 动手前三条自检（全通过才写代码）

1. 在解决**根因**，还是只压症状？后者 → 停下来重想
2. 方案是**唯一解**，还是我在多个里挑了一个？后者 → 停下来问用户
3. 方案里有**任何一处"暂时 / 兼容 / 补丁"**？或**任何一处未经 DD**？有 → 该处就是下次要返工的地方，现在重做

### 违规成本

> 给出不彻底方案 → 用户耗费精力识别、拆穿、重提需求。  
> **这是对用户时间的犯罪**，不是工程瑕疵。  
> 发现自己写了补丁 → 立即撤回、重做，**不许辩护、不许找理由、不许谈工作量**。

# 参考资料

- iLink 协议候选 DD（**已完成**）：[`docs/superpowers/specs/2026-04-26-ilink-library-dd.md`](docs/superpowers/specs/2026-04-26-ilink-library-dd.md) — 锁定 `Tencent/openclaw-weixin` v2.1.7 抽取 vendor
- iLink 协议接口文档（社区逆向）：`hao-ji-xing/openclaw-weixin/weixin-bot-api.md`（仓库已通过 gh repo view 验证存在）
- Claude Code Hook 文档：https://docs.anthropic.com/en/docs/claude-code/hooks（待据此实测每个 hook 行为）
- WezTerm CLI 文档：https://wezterm.org/cli/cli/index.html
- 项目设计对话原文（**启发用，不作 ground truth**）：归档 `.playwright-mcp/share-fulltext-*.json`（gitignored）
- GitHub 端到端项目调研：归档 `.playwright-mcp/research-deep.txt`（gitignored）
