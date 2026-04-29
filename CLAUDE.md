# 项目简介

`multi-cc-im` —— 个人本地 bridge：通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到微信，实现"在公司用控制台 + 外面用微信"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> **状态**：v0 设计阶段，无业务代码。架构 / SQLite schema / 数据存储目录 / 外部 CLI 路径策略 → [`docs/architecture.md`](docs/architecture.md)；不直接采用项目 → [`docs/competitors.md`](docs/competitors.md)；开发命令 → [`docs/dev.md`](docs/dev.md)。
> **修订**：2026-04-26 v0.1（初稿）→ v0.2（撤回 share 假设）→ 2026-04-27 v0.3（cc hook + wezterm cli 实测完成，6 项假设升 ✓）。

# 核心约束（项目第一原则）

任何架构决策必须先过这两条。违反即重新设计。

1. **不破坏现有 cc 进程**
   cc 继续以 TUI 形式跑在用户 WezTerm tab 里。bridge **不** spawn cc、**不** 接管 stdin/stdout、**不** 包一层伪 TUI。
   - 出站：依赖 cc 原生 hook
   - 入站：依赖 `wezterm cli` 子命令
   - 用户随时可直接 attach 那个 tab 跟 cc 互动，bridge 不在中间挡

2. **用现有 SDK 与扩展点，不造轮子**
   - 微信协议：用社区已有实现（v0.3 已锁定 vendored `Tencent/openclaw-weixin` v2.1.7）；禁止 from scratch 除非 DD 证明所有候选都不可用
   - 终端：`wezterm cli` 子命令，不自己解析 ANSI escape
   - cc 集成：用 cc 自身扩展点（v0.3 已实测确认），不写 broker / Agent SDK 包装层
   - "我们自己造一套"的诱惑 → 重新查 npm/GitHub 是否有现成的，并执行 DD 流程

# 重大决策 DD 流程（强制）

任何"重大决策"在写入 CLAUDE.md 锁定 / 在代码中实施前**必须**走完此流程。

**"重大决策"启发式**（任一即触发）：
- 影响项目安全模型（凭据存储 / 协议鉴权 / 网络出站 / 用户数据）
- 影响长期维护负担（核心依赖 / 协议层 / 数据层）
- 影响范围超过单个 package（跨包接口 / 共享类型 / 全局状态）
- 反悔代价 > 1 周工作量
- 影响"用现有 SDK 不造轮子"准则的具体实施

典型例子：iLink 协议库选型、storage 数据库选型、auth/keychain 库选型、IM/CLI adapter 接口设计、价格表来源、bridge 部署形态、pane 活性验证策略。

**5 步流程**:
1. **候选枚举**：穷举所有可见候选（含 from scratch / vendor in / npm depend / 第三方调用 / 跨语言抄）
2. **每个候选尽调**：实测 / 源码（体量 + 模块化 + 测试 + 依赖）/ 治理（commit + issue + 维护者 + license）/ 安全（外部 HTTP + 用户数据 + CVE）/ 协议跟进
3. **对比矩阵**：候选 × 维度，每格填可引用证据（commit hash / star 趋势 / issue 链接），不许填印象
4. **基于 DD 数据的推荐 + 理由**：每条理由必须可追溯到矩阵某格证据
5. **用户决定** → 写入设计 doc → 锁定到 CLAUDE.md

DD 文档保存到 `docs/superpowers/specs/<topic>-dd.md`，跟设计 doc 一起 commit。

**反 DD 模式（违纪行为）**:
- 凭 star / README / "感觉合适" / share 对话拍板 → 浅表决策
- 跳过候选枚举只列 2-3 个 → 假对比
- 推荐时引用单一证据 → 单点论据
- 提议"先用 X 后续再换" → 治标补丁

**未做 DD 就动手 = 违反纪律 = 当场撤回**。绕开 DD 的方案 = **治标补丁，对用户时间的犯罪**。

# 关键设计假设（状态总表）

> ✓ = 已 DD 锁定 / 协议事实 / 实测确认；⚠️ = 待实测；? = 待用户/DD 决策。

| 维度 | 状态 | 详情 |
|---|---|---|
| 协议层（iLink vendored 抽取）| ✓ | [DD: iLink 选型](docs/superpowers/specs/2026-04-26-ilink-library-dd.md) |
| Adapter 接口（IM/Term/CLI 事件流）| ✓ | TS-first hybrid（callback inject + extends-based 编译时 capability + type guard narrow）；[DD: adapter 接口](docs/superpowers/specs/2026-04-29-adapter-interface-dd.md) |
| Storage adapter 接口（CRUD）+ SQLite vs Postgres | ? | 单独 DD（事件流 vs CRUD 形态不同）|
| 出站 / 入站 / Idle 唤醒 / Session 标识 / Storage / pane-id | ✓ | [DD: hook+wezterm 实测](docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md) |
| ACL（owner-only） | ✓ | 协议层自带过滤 |
| 多机（仅一台） | ✓ | 协议层硬约束（getupdates cursor 全局共享） |
| 路由语法（`@a` 前缀 / 模糊匹配 / 多播 / 粘性默认） | ? | 用户最终 sign-off |
| 价格表来源 | ? | 单独 DD（含 service_tier × cache TTL 多维定价）|
| 语音（iLink `voice_text`） | ⚠️ | 跟协议层 DD 联动 |
| 图片/文件（AES-128-ECB 解密） | ⚠️ | 跟协议层 DD 联动 |
| pane 活性验证策略（避免注入到 zsh shell） | ? | v1 实施前单独 DD |

# 关键规范（MANDATORY）

| 规范 | 备注 |
|---|---|
| **禁止 AI 作者署名** | commit / PR / issue 一律不带 `Co-Authored-By` 或 `Generated with Claude Code` |
| **TypeScript strict, 禁止 `any`** | 用 `unknown` 替代；外部输入用 `zod` runtime 校验（jsonl `message.content` 是 union: string \| array） |
| **禁止 `var` / `require()`** | ESM only，`type: "module"` |
| **公共函数必须 TSDoc** | `@param @returns @throws @example`，ESLint `eslint-plugin-tsdoc` 强制 |
| **禁止裸 catch** | 必须分类 + `pino` log；不许 `catch(e) {}` 吞错 |
| **禁止硬编码密钥 / 外部 CLI 路径** | 密钥走 keychain；外部 CLI（wezterm 等）运行时探测（[策略](docs/architecture.md#外部-cli-工具路径策略)），禁止 hardcode 绝对路径 —— 开源项目用户安装位置不一 |
| **Local-first** | 所有用户数据落本机 SQLite + 文件，**不上传任何外部服务** |
| **iLink 长轮询必须有** | timeout（35s+）+ 退避重试 + cursor 持久化（重启后续接，不掉消息）|
| **send-text 注入两步法** | Step1 默认 paste 内容（任意 `\n` / 元字符 / Unicode 安全），Step2 `--no-paste $'\r'` 提交。混用 `--no-paste` 发内容 = 注入面（cc TUI 解释快捷键）|
| **multi-cc-im hook 不许写非协议 stdout** | cc 把 SessionStart hook stdout 当 system context 注入（attachment 机制）→ 烧 token + 行为不可预测。受控 JSON（`{"decision":"block",...}`）除外，其他一律走 stderr 或文件 |
| **idle 唤醒用 `stop_hook_active` 防死循环** | Stop hook 处理时先 `if (stdin.stop_hook_active) return;`。stdin 字段是 cc 原生防护，零 race，比文件标记可靠 |
| **路由解析 = `WEZTERM_PANE` env** | hook env 直接给，O(1)。禁用 `wezterm cli list` 解析 cwd 反推 pane-id（O(N) + 多 cc 同 cwd 时歧义） |
| **路由前必须验证 pane 里 cc 活着** | pane lifecycle ≠ cc lifecycle；`/exit` 后 pane 还在但里面是 zsh，盲注入会发到 shell。具体活性策略见 v1 实施前 DD |
| **路由 key 用 `CLAUDE_PROJECT_DIR` 或 `stdin.cwd`** | 已 realpath；不要用 `PWD` env（macOS `/tmp` vs `/private/tmp` 不一致） |
| **不修改 cc 自己的 jsonl** | `~/.claude/projects/**/*.jsonl` 只读；任何写入都是 bug |
| **凭据进 keychain** | `bot_token` 落盘前必须经 `keytar` / `secret-tool`；明文出现在文件或日志 = bug |
| **重大决策必走 DD** | 见上节；未 DD 就实施 = 当场撤回 |
| **TDD 红→绿→蓝节奏** | 先写会失败的测试 codify 目标行为 → 最少代码让测试通过 → 重构 + ≥80% 覆盖。实施中发现 DD 假设错（测试无论如何写不通）→ 停下重做 DD，不在错假设上打补丁。详见 [`docs/dev.md`](docs/dev.md)「TDD 写代码节奏」节 |

# 禁止清单

托管 / spawn cc 进程 | 修改 cc 的 jsonl（`~/.claude/projects/**/*.jsonl`）| 用非官方 / 灰产 / iPad 协议（仅腾讯 iLink）| 公网传输用户 prompt（含外部图床）| shell 字符串拼接执行（统一用 execFile 数组）| 动态代码求值 | bot_token 写 toml/日志/console | 不带 cursor 的长轮询 | "[执行命令]" 注入字段直接落 cc | TS `any` | 裸 SQL 字符串 | 同步阻塞 hook > 1s | adapter 间直接 import | service 层依赖 framework | 把 share 对话当 ground truth | 跳过 DD 直接选型 | hook 写非协议 stdout（污染 cc context）| 用 `PWD` 做路由 key（须用 `CLAUDE_PROJECT_DIR`）| 用 `wezterm cli list` 解析 cwd 反推 pane-id（须用 `WEZTERM_PANE` env）| send-text 单步带回车（须分两步）| 不验证 cc 活性就 send-text | hardcode 外部 CLI 绝对路径（wezterm 等须运行时探测）

# 编码行为准则

## 1. 先想再写
- 不假设、不隐藏困惑、主动暴露权衡
- 多种理解时**列选项让用户选**，不许自己拍板
- 不确定先问，不许"先实现一版试试"

## 2. 简单优先
- 写最少代码。不做超出要求的功能
- 单次使用的代码不做抽象
- 不可能发生的场景不做错误处理
- 自检："一个高级工程师会说这过度复杂吗？" 是 → 简化

> **本项目特例**：4 维度 adapter 是用户明确要求的可扩展性，不属于过度设计；但每个 adapter 内部仍要严格简单优先。

## 3. 精准修改
- 只改必须改的。不"顺手改进"周围代码、注释、格式
- 删除自己修改导致无用的 import / 变量 / 函数
- **不要删除修改前就存在的死代码**（除非被要求）
- Diff 每一行都能直接追溯到用户的需求

## 4. 目标驱动执行
任务转化为可验证目标："加 @ 路由" → "为模糊匹配 / 多播 / 粘性默认写 vitest 用例，让全部通过"。多步任务先声明简要计划。强成功标准让你独立循环；弱标准（"让它跑起来"）需要不断回头确认。

## 5. 彻底解决，禁止补丁（MANDATORY — 零容忍）

定位根因、提彻底方案；禁止头疼医头、脚疼医脚。**方案不彻底 = 违规**。

**硬性规则**:
- 方案未经用户确认前，不动代码
- 方案不唯一时：列每个选项的复杂度、回归面、架构影响，让用户选；不许自己拍板
- 自己拿不准时必须问；不许猜、不许"先实现一版试试"
- 架构有根本缺陷：提架构变更，不在缺陷上打补丁
- 已有同类系统的现成模式：彻底方案必须对齐，不许新发明半套
- 重大决策必走 DD 流程；DD 未完不许实施

**明令禁止的补丁词汇**（出现即停手重新设计）:

"compat shim / 兼容层 / 适配层" | "legacy mirror / 只读镜像" | "escape hatch / 全局 ref / 单例" | "临时 / 过渡 / 暂时 / 先这样 / 后续再改" | "为了不改 XX 个 callsite / 工作量考虑" | "两条路径并存 / hybrid / 双写" | "基于 share / 因为别的对话推荐"

**动手前三条自检**（全通过才写代码）:
1. 在解决**根因**还是只压症状？后者 → 停下来重想
2. 方案是**唯一解**还是我在多个里挑了一个？后者 → 停下来问用户
3. 方案里有**任何一处"暂时 / 兼容 / 补丁"**？或**任何一处未经 DD**？有 → 该处就是下次返工的地方，现在重做

**违规成本**: 给出不彻底方案 → 用户耗费精力识别、拆穿、重提需求。**这是对用户时间的犯罪**，不是工程瑕疵。发现自己写了补丁 → 立即撤回、重做，**不许辩护、不许找理由、不许谈工作量**。

# 参考资料

**DD 报告**:
- iLink 协议库选型（**已完成**）: [`docs/superpowers/specs/2026-04-26-ilink-library-dd.md`](docs/superpowers/specs/2026-04-26-ilink-library-dd.md)
- cc Hook + wezterm cli 行为实测（**已完成**）: [`docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md`](docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)

**工程文档**:
- [`docs/architecture.md`](docs/architecture.md) — 架构图 / 包依赖 / 目录结构 / SQLite schema / 外部 CLI 路径策略
- [`docs/competitors.md`](docs/competitors.md) — 不直接采用的端到端项目
- [`docs/dev.md`](docs/dev.md) — 开发命令

**上游文档**:
- iLink 协议接口（社区逆向）: `hao-ji-xing/openclaw-weixin/weixin-bot-api.md`
- Claude Code Hook: https://docs.anthropic.com/en/docs/claude-code/hooks
- WezTerm CLI: https://wezterm.org/cli/cli/index.html | send-text: https://wezterm.org/cli/cli/send-text.html

**输入材料归档**（gitignored，**不作 ground truth**）:
- 设计对话原文：`.playwright-mcp/share-fulltext-*.json`
- 端到端项目调研：`.playwright-mcp/research-deep.txt`
