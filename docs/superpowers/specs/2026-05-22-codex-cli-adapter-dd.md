# DD: codex CLI adapter — 接入 multi-cc-im

> 状态: ⏳ 候选 + 尽调 + 矩阵 + 推荐已起草，等用户拍板
> 日期: 2026-05-22
> 触发: 用户 — 「研究下 codex 是不是也有类似 claude code 的 hook 模式，可以使用 multi-cc-im 来支持」
> 关联: [[reference_codex_cli_hooks_system]]

---

## §0 调研材料（实证 2026-05-22）

### Codex CLI 6 个 lifecycle hook events

| event | 何时触发 | matcher | 关键 payload 字段 | 关键 return |
|---|---|---|---|---|
| `SessionStart` | 会话 init / resume / clear | `source`（startup\|resume\|clear）| `session_id` / `transcript_path` / `cwd` / `model` / `source` | exit 0 + plain text → developer context |
| `PreToolUse` | Bash / `apply_patch` / MCP tool 执行前 | `tool_name` | `turn_id` / `tool_use_id` / `tool_input.command` | `permissionDecision: deny + permissionDecisionReason` 阻断；`allow + updatedInput` 改写 |
| **`PermissionRequest`** | Codex 要求审批（shell escalation / managed-network）| `tool_name` | `tool_input.description` 可读理由 | `decision.behavior: allow/deny` |
| `PostToolUse` | tool 执行完成（含非 0 exit）| `tool_name` | `turn_id` / `tool_input` / `tool_response` | `decision: block` 替换 tool result |
| `UserPromptSubmit` | 用户 prompt 送 model 前 | 不支持 | `turn_id` / `prompt` | `decision: block` 阻止 prompt 发送 |
| `Stop` | turn 完成 | 不支持 | `turn_id` / `stop_hook_active` / `last_assistant_message` | exit 0 必须 JSON；`continue: false` 停止 |

### 跟 cc 关键 5 项差异

| 维度 | Claude Code | Codex |
|---|---|---|
| 配置文件 | `~/.claude/settings.json` (JSON) | `~/.codex/config.toml` (TOML) 或 `~/.codex/hooks.json` (JSON) |
| `tool_use_id` 在 PreToolUse | 当时**空字符串**（[[feedback_dont_rely_on_upstream_pre_exec_ids]]）| **已有值**（codex 提前生成）|
| Permission 拆分 | 单个 PreToolUse event + AskUserQuestion 仿权限 | **独立 `PermissionRequest` event**（拆分 cleaner）|
| 默认 timeout | 60s | **600s**（10x cc）|
| pane id env | `WEZTERM_PANE` / `ITERM_SESSION_ID` | 未知（codex CLI 没 doc 说设啥 env；需源码 verify）|

### Payload 共通字段

`session_id` / `transcript_path` / `cwd` / `permission_mode` / `model` 跟 cc 几乎对等。

---

## §1 候选枚举（5 个 — 含「不做 X」）

| 候选 | 一句话描述（通俗）|
|---|---|
| **A** 不做 | 用户只能用 Claude Code 跑 cc tab；想用 codex 跑就用不了 multi-cc-im 桥 |
| **B**（推荐方向）独立 codex 适配器 | 新建 `packages/cli-codex/`，照搬 `packages/cli-cc/` 4 模块改 codex hook 格式；cc 和 codex 各自独立 |
| **C** 抽公共底座再分叉 | 现 `packages/cli-cc/` 拆成「公共底座 + cc 专属」+「codex 专属」三块；cc / codex 共享底座代码 |
| **D** 用 MCP 协议绕开 hook | codex 装 multi-cc-im 作为 MCP server，不走 hook 而走 MCP；架构完全不一样 |
| **E** fork codex 源码 | 改 codex 自己加专属集成；违反「不造轮子」准则 |

---

## §2 每候选尽调

### A — 不做（保持现状）

| 维度 | 说明 |
|---|---|
| 工程量 | 0 |
| 后悔成本 | 0 — 未来真有用户报需求再启动 |
| UX | 想用 codex 的用户只能用 codex 自己 TUI，没法接飞书远程指挥 |
| 跟核心约束 | ✅ 无破坏 |
| 失分 | 4-axis adapter 扩展性放着不用；项目「CLI 可换」承诺没兑现 |

### B — 独立 cli-codex 适配器（推荐方向）

| 维度 | 说明 |
|---|---|
| 工程量 | 中（5-10 天）— 镜像 cli-cc 4 模块 + 真账号 smoke + setup wizard |
| 复用 | `packages/cli-cc/` 是参考实现；state-files / hook-receiver / pane-id-detector / setup-hooks 4 模块照搬骨架改 hook 格式 |
| TOML 配置 | 新增 — TOML parse 用 `@iarna/toml` 或 `smol-toml`；cc 用 JSON 不需 |
| `tool_use_id` 有值差异 | 利好 — 用真 tool_use_id 当 routing key，不需 [[feedback_dont_rely_on_upstream_pre_exec_ids]] 自生成 UUID 那套 fallback |
| PermissionRequest 独立 event | 走专属 handler；架构更 cleaner 跟 cc 的 PreToolUse-overload 路径分开 |
| 跟 cc 共享 | 共享 `packages/shared/` schema + `packages/bridge/` orchestrator + `packages/im-lark/` adapter — 一切跨 CLI 抽象都用 |
| 副作用 | cc / codex 两份代码各自演化；未来要改公共逻辑（如 state files 路径策略）需两边同步 |

### C — 抽公共底座 + 分叉

| 维度 | 说明 |
|---|---|
| 工程量 | 大（10-15 天）— 重构 cli-cc 拆 base 包 + 双分叉 + 单测重写 |
| 复用 | 真正的代码 dedupe；改公共逻辑只动 base |
| 风险 | cc 是已 production 9 个月 + 1110+ 单测 + 4 IM 流场景成熟；拆它有回归风险 |
| 时机问题 | codex 接入是 v0.2.0 大目标；底座抽象等 codex 真实接完发现共性后再做更准（YAGNI）|
| 排除 | 现阶段过早；先 B 跑通看 cc / codex 真共性再考虑 C |

### D — MCP server 模式

| 维度 | 说明 |
|---|---|
| 原理 | codex 配 multi-cc-im 为 MCP server，cc tab Stop 不走 hook 写文件，而走 MCP request/response |
| 工程量 | 大 + 不可预测（5-15 天 不等）— 要写 MCP server impl + 改 bridge orchestrator 跟 MCP 通信 |
| 跟 cc 不一致 | cc 走 hook，codex 走 MCP — 两套架构并存，复杂度爆炸 |
| 失分 | 项目核心约束「用现有 SDK + 现有扩展点」（hook 是 codex 现有扩展），不需要造 MCP server 这个新轮子 |
| 排除 | 复杂度 / 一致性 / 跟核心约束矛盾 |

### E — fork codex

不可行：违反 CLAUDE.md「用现有 SDK 与扩展点，不造轮子」准则。排除。

---

## §3 对比矩阵

| 维度 | A 不做 | **B 独立适配器 ⭐** | C 抽底座 | D MCP server | E fork |
|---|---|---|---|---|---|
| 工程量（天）| 0 | 5-10 | 10-15 | 5-15 | 30+ |
| 跟 cc 一致 | N/A | ✅ 同路径 hook | ✅ 共享底座 | ❌ 两套架构 | ❌ |
| 后悔成本 | 0 | 中 — 双份代码 | 大 — 重构 cc | 大 — 新架构 | 巨大 |
| 跟核心约束「现有扩展点」| N/A | ✅ codex hook 是现有 | ✅ | ❌ 造 MCP 轮子 | ❌ |
| 4-axis 扩展性兑现 | ❌ | ✅ | ✅ | ✅ | N/A |
| codex hook 充分利用 | N/A | ✅ 6 事件全用 | ✅ | ❌ 绕开 | ❌ |
| Source verified | - | ✅ docs + cc 镜像 | - | ❌ MCP API 未调研 | - |

---

## §4 推荐 = B（独立 codex 适配器）

| 理由 | 矩阵证据 |
|---|---|
| 复用 cli-cc 4 模块骨架，改 hook 格式即可 | 工程量行 |
| codex hook 是 GA 现有扩展，符合「用现有扩展点」准则 | 跟核心约束行 |
| `tool_use_id` 有值利好 — 不需要 cc 那套自生成 UUID fallback | §2-B 差异 |
| PermissionRequest 独立 event 让 codex 架构 cleaner（不走 AskUserQuestion 那套迂回路径）| §2-B 差异 |
| C 抽底座等 B 跑通发现真共性后再做更准（YAGNI）| C 时机问题 |
| D / E 跟核心约束冲突 | 矩阵行 |

### Tradeoffs B 接受

| Trade-off | 接受理由 |
|---|---|
| cc / codex 双份代码 | 短期可控 — 共享 `packages/shared/` schema + `packages/bridge/` 路由 + `packages/im-lark/` adapter；只 CLI 适配层各自演化 |
| 未来改公共 CLI 逻辑需两边同步 | 真撞共性高、改起来频繁时再走 C 抽底座；现在过早抽象 |
| TOML 解析新增依赖 | 选 `smol-toml`（zero-dep 轻量）或 `@iarna/toml`（稳定但更大）；DD 实施时定 |

### §5 等用户拍

| 选项 | 决议 |
|---|---|
| ✅ **B**（推荐）| 新增 `packages/cli-codex/` 独立适配器 |
| A | 不做 — 保持现状 |
| C | 重构 cli-cc 抽底座 + 双分叉 |
| D | MCP server 模式 |

---

## §6 实施 task table（拍 B 后启动；现 draft）

| # | 改动 | 文件 |
|---|---|---|
| 1 | shared 加 codex 相关枚举（`TerminalId` / `CLIId` 加 codex 选项） | `packages/shared/src/types.ts` |
| 2 | 新建 `packages/cli-codex/` 镜像 cli-cc 4 模块 + TOML 解析 | 新包 |
| 3 | `packages/cli-codex/src/state-files.ts` — codex hook 写状态文件协议（含 `tool_use_id` real-value 利好）| 同上 |
| 4 | `packages/cli-codex/src/hook-receiver.ts` — codex 6 event handler；PermissionRequest 走独立分支 | 同上 |
| 5 | `packages/cli-codex/src/pane-id-detector.ts` — 调研 codex 是否在 spawn 时设 `WEZTERM_PANE`/`ITERM_SESSION_ID`（cc 复用）或需新机制 | 同上 |
| 6 | `packages/cli-codex/src/setup-hooks.ts` — 一键写 `~/.codex/config.toml` 或 `hooks.json`（含 backup before edit per [[feedback_user_dotfile_backup]]）| 同上 |
| 7 | `apps/multi-cc-im/src/adapters.ts` 加 codexEntry runtime | adapters.ts |
| 8 | `apps/multi-cc-im/src/wizard/` 选 CLI（cc / codex） | 同上 |
| 9 | `apps/multi-cc-im/src/cli.ts` `start` 命令加 `--cli=codex` flag | 同上 |
| 10 | 跨 4 模块单测 ≥50 tests | `*.test.ts` |
| 11 | 真账号 smoke 端到端 — codex 跑在 wezterm tab + 飞书 reply + Stop forward + image inbound + AskUserQuestion 等价物 | manual |
| 12 | docs/architecture.md + README §2.7 + DD note 更新 | docs |
| 13 | release v0.2.0 | bash |
| 14 | 1 个未知项：codex 是否有 `WEZTERM_PANE` env 注入？要先 source verify（task #5 前置）| - |

---

## §7 6 项实施前必查清单（per [[reference_codex_cli_hooks_system]]）

| 项 | 状态 | 怎么查 |
|---|---|---|
| 1 hook payload schema 完整字段 | ✅ §0 已记 | 已 WebFetch openai docs |
| 2 各 event stdin JSON shape | ✅ §0 已记 | 已 WebFetch |
| 3 hook 进程超时（默认 600s） | ✅ | 已 WebFetch |
| 4 codex 是否注入 `WEZTERM_PANE` / pane id env | ❌ 未知 | 需 grep codex 源码 + 真账号 `env` dump |
| 5 多 hook 并发 / dedup | ✅ concurrent 单方向 | 已 WebFetch |
| 6 codex 是否支持「一键写 hooks.json」自动装机 | ❌ 未知 | 需查 codex CLI command 或源码 |

#4 + #6 是实施前必跑的 source verify，task #5 + #6 启动时一起做。

---

## §7.1 AI router CLI-selectable（2026-05-22 用户新增约束）

**用户原话**：「记得 codex 的话，AI 分诊也要用 codex」— 当 user 主体 CLI 是 codex 时，daemon 的 AI router triage 子进程**也走 codex**，不依赖 cc 装机。

**实证 codex headless 能力**（2026-05-22 本地 `codex exec --help`）— 比 cc 还强 4 项：

| 维度 | cc `claude --print` | codex `codex exec` |
|---|---|---|
| 结构化输出 | prompt 约定 + JSON parse | **`--json`** JSONL events 流（原生结构化）|
| Schema 强约束 | 无 — 靠 prompt 工程 | **`--output-schema <file>`** JSON Schema 严格约束 |
| 最后一条消息单独输出 | 无 — 整 transcript | **`-o, --output-last-message <file>`** |
| 防自递归（子进程不触发 hook）| strip `WEZTERM_PANE` env | **`--dangerously-bypass-hook-trust` + `--ephemeral`** 显式选项 |
| Sandbox 控制 | `--permission-mode bypassPermissions` | `--sandbox read-only/workspace-write/danger-full-access` + `--dangerously-bypass-approvals-and-sandbox` |

**AI router 实施方案**（user CLI 是 codex 时）：

```ts
// packages/bridge/src/ai-router.ts — 多 CLI 抽象
const aiRouter = createAIRouter({
  cli: 'codex',  // 用户主体 CLI（从 cli adapter name 推断）
  // codex 调用：
  // codex exec --json --output-schema <schema.json> \
  //   --ephemeral --dangerously-bypass-hook-trust \
  //   --sandbox read-only "<prompt>"
});
```

利好：**简化 AI router prompt 工程** — 不再依赖 LLM 自觉输出 JSON（cc 那套 prompt 教学），改用 codex 原生 schema 约束，100% 解析成功。

副作用：cc 跟 codex 两套 AI router 各 spawn 路径要写两份（codex 不能复用 cc 的 `claude --print` argv builder）。落 `packages/bridge/src/ai-router-codex.ts` 或在现有 `ai-router.ts` 加 dispatcher。

### 更新 task table — task #11 + 新增 #15

| # | 改动 | 文件 |
|---|---|---|
| 11（改）| 真账号 smoke — codex 装机已就绪（0.133.0 路径 `/opt/homebrew/bin/codex`），用户跑「wezterm tab 起 codex + 飞书 reply + Stop forward + image inbound + AskUserQuestion 等价」一气贯通 | manual |
| **15（新增）**| **AI router CLI-selectable** — `packages/bridge/src/ai-router.ts` 加 dispatcher `if cli==='codex' → spawnCodexExec({json, output-schema, ephemeral, bypass-hook-trust})`；写 `ai-router-codex.ts` 镜像 `ai-router.ts` 现行 cc 实现 | bridge |

---

## §8 关联 memory

- [[reference_codex_cli_hooks_system]] — 调研结果总览
- [[feedback_dd_question_premise]] — 候选含「不做 X」
- [[feedback_check_superset_of_existing]] — 接入是 CLI adapter 接口的 superset
- [[feedback_enumerate_cc_hook_events]] — 拦截 CLI 行为先枚举所有 hook events
- [[feedback_dont_rely_on_upstream_pre_exec_ids]] — codex `tool_use_id` 有值是利好，不需 cc 那套自生成 fallback
- [[feedback_user_dotfile_backup]] — 写 `~/.codex/config.toml` 前必 backup
- [[feedback_upstream_schema_real_smoke]] — 单测绿 ≠ done；真账号 smoke 必跑
- [[reference_feishu_cardkit_limits]] / [[reference_feishu_message_get_interactive_user_card_content]] — 接入 codex 后 IM 适配仍走飞书已知规则

---

## §11 设计修订（2026-05-23）：4 步 wizard + 删 `--cli=` flag

### 11.1 触发

实施 §7.1 接近完成时用户给出 3 条新约束：

1. wizard 应在启动时**自动探测**本地装了哪些 CLI，再让用户多选要 bridge 哪些 — 不是命令行参数二选一
2. 「AI router 用哪个 CLI」应作 wizard 独立一步让用户选（单选）；即使只勾 1 个 CLI，第 2 步**不能跳过**
3. 删掉 `--cli=cc|codex` 命令行参数 — 所有启动必须走 wizard，没有脚本绕过

### 11.2 修订决策

| 维度 | 原 §7.1 设计 | 修订设计 |
|---|---|---|
| CLI 选择 | `--cli=cc\|codex` 命令行二选一 | wizard step 1 多选（探装机 + ☑️）|
| AI router 选择 | 跟 CLI 选择绑定（同 cliKind 字段）| wizard step 2 独立单选 |
| 顺序 | term → IM | CLI multi → AI router → term → IM |
| 单 CLI 时是否跳过 step 2 | n/a | **不跳过** — 用户明确说「分诊用哪个永远显式确认」|
| 命令行入口 | `multi-cc-im start [<adapter>] [--cli=cc\|codex]` | `multi-cc-im start [<adapter>]`；wizard 强制 |
| 配置持久化 | n/a | `[cli] enabled = ['cc','codex']  aiRouter = 'cc'` |

### 11.3 实施清单（增量于 §6 任务表）

| # | 范围 | 内容 |
|---|---|---|
| **w1** | shared | `CLIIdSchema` z.enum + `CLIConfigSchema { enabled[], aiRouter }` + `ConfigSchema.superRefine(cli.aiRouter ∈ cli.enabled)` |
| **w2** | app | `cli-selector.ts` — `command -v claude` / `command -v codex` 探装机 + clack `multiselect` + 持久化预勾选 + ≥1 校验 + 拒「defies-the-hint」 |
| **w3** | app | `ai-router-selector.ts` — 从 step 1 结果出 clack `select`；**enabledCLIs.length===1 仍 ask** |
| **w4** | app | `start.ts` 重排 4 步顺序：CLI multi → AI router → term → IM；按 `enabledCLIs` 分别跑 `runSetupHooksCommand` (cc) + `runCodexSetupHooks` (codex)；按 `aiRouterCLI` 选 `routeViaCodex` 或内置 `routeViaAI` |
| **w5** | app | `cli.ts` 删 `--cli=` 解析整段；HELP_TEXT 不再列 `[--cli=cc\|codex]` |
| **w6** | bridge | `index.ts` + `ai-router-codex.ts` 注释更新（去除 `--cli=codex` 字面引用，改为 wizard step 2）|
| **w7** | app | 36 新测试（cli-selector 10 + ai-router-selector 8 + start 4-step + 双 setup-hooks + 取消传播 5）|
| **w8** | docs | 本节修订 + README 描述「multi-cc-im start 进入 4 步 wizard」+ architecture.md adapter 表加 `[cli]` 段 + conventions.md 状态总表 + 修订日志 v0.2.0 entry |
| **w9** | verify | `pnpm typecheck` + `pnpm test` + `pnpm --filter multi-cc-im build` + `./bin/multi-cc-im --version` smoke + `pnpm install --frozen-lockfile`（schema 改动）|

### 11.4 取舍

| 候选 | 评价 | 否决理由 |
|---|---|---|
| 保留 `--cli=cc,codex` 多值（B.1）| 跟 wizard 多选语义对齐 | 用户拍 B.2（删字段）— wizard 是唯一入口；脚本化场景靠 daemon-restart manager + 持久化 config 而非 reflag |
| step 2 单 CLI 时跳过（A.2）| 减一次按键 | 用户拍 A.1 + 加码「不能跳过」— 长期暗箱选择风险大于一次确认成本 |
| env var `MULTI_CC_IM_CLI=cc` 旁路 wizard | 给 CI / batch 用户兜底 | 同样被 B.2「wizard 是唯一入口」覆盖；CI 应用持久化 config.toml + 二次 start 不再交互 |

### 11.5 状态

- §7.1 + 本节双锁定 → `feat/cli-codex-adapter` 分支推进，并入 v0.2.0 一次发布
- Memory 沉淀：[[feedback_check_superset_of_existing]] 再次命中 — 「命令行二选一」是 wizard 现行流程 superset，1 处改动而非 5 候选 DD
