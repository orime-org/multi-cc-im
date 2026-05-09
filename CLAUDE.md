# 头号原则（MANDATORY）

> 解决问题要找根因。
> 解决问题要找根因。
> 解决问题要找根因。

不要在症状上贴补丁。不要"先这样后续再改"。不要把"工作量大""时间紧"当借口跳过根因分析。每个 PR 动手前先回答：**这个修改是在解决根因，还是在压住症状？** 答不上来就停下来，重新想，或者问用户。

**解决完毕，再次问自己：这次的修改是不是真的解决了根本问题？** 还是只是把症状从一个地方搬到了另一个地方 / 把问题往后拖了一步 / 让自己看起来像解决了？答不上来或者答案是后者，停下先跟用户沟通。

**每次完成任务后必须进行所有的必要测试并且必须更新所有相关文档。** 测试 = `pnpm typecheck` + `pnpm test` + 改动了 CLI / 影响 bundle 时还要 `pnpm --filter multi-cc-im build` **并跑一次 `./bin/multi-cc-im --version` 验证 bundle 真能 load**（typecheck + tests 不抓 ESM external 解析问题：本地 dev node_modules hoist 后能 load，CI clean 环境照 `apps/multi-cc-im/package.json` 装就 fail，必须先在本地用 bin smoke 复现一次） + **改了任何 `package.json` 时跑 `pnpm install --frozen-lockfile` 模拟 CI 严格校验**（仅本地 `pnpm install` 会 silently 刷 lockfile，CI 用 `--frozen-lockfile` 不刷，对不上立刻 fail；漏这步 → 推 PR 后 CI 红 + 需要追加 lockfile-sync commit）+ 改动会影响用户 dotfile 时跑前后 `cmp ~/.claude/settings.json` 验证未变（[memory: feedback_user_dotfile_backup](.claude/projects/.../memory/feedback_user_dotfile_backup.md)）。文档 = [`docs/conventions.md`](docs/conventions.md) 状态总表 / 修订记录 + [`docs/architecture.md`](docs/architecture.md) 受影响节 + `README.md` & `README.zh-CN.md` 操作章节 + `VENDOR.md` 若改 vendor 区域 + 相关 DD 报告。漏一项 = 任务未完成，**不能** 报"done"。

**所有任务都必须先列 todo 计划，再按计划执行；完成后再次对照计划检查。** 不分 research / 执行 / 测试 / 更新文档，**也不分大小** —— 哪怕只有一两步，也先落 todo，做完再对照地图复核。todo 是工作的地图，先有地图再走路；没地图就上路 = 边走边发明 scope = 容易漏步骤、容易做着做着偏题、容易事后补不全文档。"任务太小不必写计划"是反复出问题的反模式，这里**取消"小任务豁免"**：小任务也写，小任务也复核。

**未经用户明确同意，不得修改 CLAUDE.md。** 想加 / 删 / 改任何字面，先告诉用户提议（哪段加什么、为什么、是替换还是新增），等用户拍板后再动手。即使是已经 push 了的 PR 内的 CLAUDE.md 改动也要先问。例外：用户原话指示「改 CLAUDE.md 加 X」/「把 Y 写到 CLAUDE.md」 = 已同意，按原话写不再二次确认。

# 项目简介

`multi-cc-im` —— 个人本地 bridge：通过飞书 (Lark) IM 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到手机，实现"在公司用控制台 + 外面用 IM"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

> 状态总表 / 修订记录 / 项目特定技术规范 / 项目特定禁止清单 / 参考资料 → **[`docs/conventions.md`](docs/conventions.md)**。本文（CLAUDE.md）只放 AI 干活纪律。

# 核心约束（项目第一原则）

任何架构决策必须先过这两条。违反即重新设计。

1. **不破坏现有 cc 进程**
   cc 继续以 TUI 形式跑在用户 WezTerm tab 里。bridge **不** spawn 用户的 cc 实例、**不** 接管 stdin/stdout、**不** 包一层伪 TUI。
   - 出站：依赖 cc 原生 hook
   - 入站：依赖 `wezterm cli` 子命令
   - 用户随时可直接 attach 那个 tab 跟 cc 互动，bridge 不在中间挡
   - **唯一例外**：daemon 自己起一次性 `claude --print` 子进程做 IM 路由 triage（DD #73）。该子进程独立 session、headless、`--disable-slash-commands`、`--setting-sources user`、不复用任何用户 transcript / cwd / 状态，跑完即退；不沾任何用户的 wezterm tab 或 cc TUI 进程。

2. **用现有 SDK 与扩展点，不造轮子**
   - 飞书协议：官方 npm `@larksuiteoapi/node-sdk`（DD #86 锁定）；WSClient 长连接 = no-public-IP daemon 直接可用
   - 终端：`wezterm cli` 子命令，不自己解析 ANSI escape
   - cc 集成：用 cc 自身扩展点（v0.3 已实测确认），不写 broker / Agent SDK 包装层
   - "我们自己造一套"的诱惑 → 重新查 npm/GitHub 是否有现成的，并执行 DD 流程

# 重大决策 DD 流程（强制）

任何"重大决策"在写入 [`docs/conventions.md`](docs/conventions.md) 状态总表锁定 / 在代码中实施前**必须**走完此流程。

**"重大决策"启发式**（任一即触发）：
- 影响项目安全模型（凭据存储 / 协议鉴权 / 网络出站 / 用户数据）
- 影响长期维护负担（核心依赖 / 协议层 / 数据层）
- 影响范围超过单个 package（跨包接口 / 共享类型 / 全局状态）
- 反悔代价 > 1 周工作量
- 影响"用现有 SDK 不造轮子"准则的具体实施

典型例子：IM adapter 选型（wechat/lark/tg/etc.）、storage 数据库选型、credentials 持久化策略、IM/CLI adapter 接口设计、价格表来源、bridge 部署形态、pane 活性验证策略。

**5 步流程**:
1. **候选枚举**：穷举所有可见候选（含 from scratch / vendor in / npm depend / 第三方调用 / 跨语言抄）
2. **每个候选尽调**：实测 / 源码（体量 + 模块化 + 测试 + 依赖）/ 治理（commit + issue + 维护者 + license）/ 安全（外部 HTTP + 用户数据 + CVE）/ 协议跟进
3. **对比矩阵**：候选 × 维度，每格填可引用证据（commit hash / star 趋势 / issue 链接），不许填印象
4. **基于 DD 数据的推荐 + 理由**：每条理由必须可追溯到矩阵某格证据
5. **用户决定** → 写入设计 doc → 更新 [`docs/conventions.md`](docs/conventions.md) 状态总表

DD 文档保存到 `docs/superpowers/specs/<topic>-dd.md`，跟设计 doc 一起 commit。

**反 DD 模式（违纪行为）**:
- 凭 star / README / "感觉合适" / share 对话拍板 → 浅表决策
- 跳过候选枚举只列 2-3 个 → 假对比
- 推荐时引用单一证据 → 单点论据
- 提议"先用 X 后续再换" → 治标补丁

**未做 DD 就动手 = 违反纪律 = 当场撤回**。绕开 DD 的方案 = **治标补丁，对用户时间的犯罪**。

# 通用工程纪律（MANDATORY）

跨项目通用规则。项目特定的实现规范（hook timeout / send-text 两步法 / 路由 key 选择 / etc.）见 [`docs/conventions.md`](docs/conventions.md)「项目特定技术规范」。

| 规范 | 备注 |
|---|---|
| **禁止 AI 作者署名** | commit / PR / issue 一律不带 `Co-Authored-By` 或 `Generated with Claude Code` |
| **TypeScript strict, 禁止 `any`** | 用 `unknown` 替代；外部输入用 `zod` runtime 校验 |
| **禁止 `var` / `require()`** | ESM only，`type: "module"` |
| **公共函数必须 TSDoc** | `@param @returns @throws @example`；导出函数 / 接口 / 公共类型必须有 TSDoc 块说明用途 + 约束（被测引用的 DI 钩子尤其要写清楚为什么）|
| **禁止裸 catch** | 必须分类 + `pino` log；不许 `catch(e) {}` 吞错 |
| **禁止硬编码密钥 / 外部 CLI 路径** | 密钥落 0600 JSON 文件（见下行「凭据 0600 落盘」）；外部 CLI（wezterm 等）运行时探测，禁止 hardcode 绝对路径 —— 开源项目用户安装位置不一 |
| **Local-first** | 所有用户数据落本机文件（toml + JSONL + 0600 凭据 + state 文件），**不上传任何外部服务**；v1 不引 SQL DB |
| **凭据 0600 落盘** | 敏感凭据（`app_id` + `app_secret` 等）写 0600 JSON 文件，仅 owner 读写；不进 git / 日志 / console / toml；明文出现在这 4 处任一 = bug。**不调 OS keychain**（理由见 [DD: credentials 持久化策略](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)）|
| **重大决策必走 DD** | 见上节；未 DD 就实施 = 当场撤回 |
| **TDD 红→绿→蓝节奏** | 先写会失败的测试 codify 目标行为 → 最少代码让测试通过 → 重构 + ≥80% 覆盖。实施中发现 DD 假设错（测试无论如何写不通）→ 停下重做 DD，不在错假设上打补丁。详见 [`docs/dev.md`](docs/dev.md)「TDD 写代码节奏」节 |

# 通用禁止行为

跨项目通用禁令。项目特定禁令（cc / wezterm / IM 协议相关）见 [`docs/conventions.md`](docs/conventions.md)「项目特定禁止清单」。

shell 字符串拼接执行（统一用 execFile 数组）| 动态代码求值 | 凭据写 git / 日志 / console / toml / 任何非 0600 凭据文件位置 | TS `any` | 裸 SQL 字符串（v1 无 SQL，v2 引入时仍走参数化）| 同步阻塞 hook > 1s | 把 share 对话当 ground truth | 跳过 DD 直接选型

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
