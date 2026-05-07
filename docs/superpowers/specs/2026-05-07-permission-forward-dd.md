# Permission Prompt 转发 IM 审批 DD 报告

**Topic**: cc TUI 在调用某些 tool（典型: `Bash(rm -rf ...)`、`Edit(...)`、`WebFetch(...)`）前会弹「Do you want to proceed? 1.Yes / 2.No」让用户审批。multi-cc-im 把这个决策点**转发给 IM 端用户**，IM 端选「允许 / 拒绝」后传回 cc TUI 让 tool 真的跑（或拒）。
**Scope**: cc 跑 hook 子进程 / multi-cc-im daemon 长跑进程之间的 permission 决策协议；不涉及 IM 协议层。
**Date**: 2026-05-07
**Status**: ⏳ 待用户决定

> 本 DD 报告响应 CLAUDE.md「重大决策 DD 流程」5 步走完。触发启发式：「影响安全模型（cc 工具调用决策权）」+「影响多 package 接口（cli-cc / bridge / hook 协议子集）」+「反悔成本 > 1 周（permission 协议一旦上线对外用户依赖）」。
>
> ⚠️ **本 DD 是对前期错误判断的补救**：之前在对话中我（assistant）凭印象拍板说 PreToolUse hook「同步阻塞 1.5-5 秒 + 协议只能 block 不能 approve」，并以此排除了 path D。后续 fetch cc 官方 docs 才发现：(a) 默认 timeout 600 秒 (b) `permissionDecision` 支持 `allow/deny/ask/defer` (c) timeout 默认 allow。**前期判断完全错误，触发 CLAUDE.md「凭印象拍板 → 当场撤回」纪律**。本 DD 重新基于 fetch 到的事实尽调所有候选。

---

## 决策摘要（草稿，待用户拍板）

| 候选 | 推荐 |
|---|---|
| **d PreToolUse hook + file IPC（30s timeout 默认 allow）** | ✅ 推荐 |
| a 不做（保持 cc settings.json 配 acceptEdits / 默认）| ❌ 排除 — 用户明确不接受 trust 全部，需要真审批 |
| b 截屏 + pattern match（wezterm get-text + 模拟键盘注入） | ❌ 排除 — fragile：cc 升级 prompt UI / wording 就挂；race window 注入风险 |
| c MCP permission server（`--permission-prompt-tool`） | ❌ 排除（次优）— 协议干净但工程量 3-4× d；用 file IPC 已能拿到等价语义 |

**d 的具体形态**:

```
hook 子进程（PreToolUse 触发）:
  read stdin → 拿 tool_name + tool_input + sid
  写 <stateDir>/<sid>.PermissionRequest.<request_id>.json
  ⏳ 轮询等 <stateDir>/<sid>.PermissionResponse.<request_id>.json (200ms 间隔)
  最多 30 秒
  写 stdout {"hookSpecificOutput":{"permissionDecision":"allow|deny",...}}
  exit 0

daemon (chokidar 看到 PermissionRequest 文件):
  → forward IM "[<tabName>] 准备跑: Bash(<cmd>)\n回 1=允许 / 2=拒绝"
  → 等 IM 用户回复 (异步, 走现有 IMHandler.onMessage)
  → 收到回复 → 写 PermissionResponse.<id>.json {"decision":"allow"|"deny",...}
  → daemon 不删文件，hook 子进程读完自己删

hook 30s timeout 默认行为:
  写 stdout {"permissionDecision":"allow", "reason":"timeout 30s, default allow"}
  exit 0
```

**timeout 默认 allow 的安全 trade-off**: 跟 cc 自带 `acceptEdits` 模式同等便利级别，比 `bypassPermissions` 严格。可加白名单 / 黑名单细化（白名单立即 allow 不 forward IM；黑名单 30s 超时改默认 deny）。

**未解决的研究问题**:
- 多 cc 同时弹 prompt 时 IM 端 UX（用户怎么明确指定回应哪个 cc 的 prompt）
- IM 端用户回复格式（`1` / `2` 简短 vs `@<sid> allow` 显式 vs `<request_id> allow` 完全显式）
- cc 一轮内串行多 tool 调用的 permission 累积体验（每 tool 独立 prompt 还是合并）
- 黑名单 / 白名单 default 的设定来源（multi-cc-im 内置 vs config.toml 用户自定义）

---

## 第 1 步：候选枚举（穷举，含"不做"作为 FIRST 候选）

| ID | 候选 | 描述 |
|---|---|---|
| **a** | **不做（cc 自带配置/模式）** | 用户用 cc settings.json `permissions.allow/ask/deny` 列表 + `acceptEdits` mode 自己应付。multi-cc-im 不参与 |
| **b** | **TUI 截屏 + pattern match + 键盘注入** | daemon 周期 `wezterm cli get-text` poll pane 内容；regex match `Do you want to proceed?` + 选项；forward IM；IM 回复 → daemon `wezterm cli send-text "1\r"` 或 `"2\r"` 注入回 cc TUI |
| **c** | **MCP permission server（`--permission-prompt-tool`）** | multi-cc-im 写一个 MCP server (`requestPermission(toolName, toolInput)` 工具)；cc 启动加 `--permission-prompt-tool multi-cc-im-permission` flag；cc 决定调 tool 时不弹 TUI prompt 而是走 MCP server，server forward IM + 等回复 + 返 cc |
| **d** | **PreToolUse hook + file IPC** | cc PreToolUse hook 触发 → hook 子进程写 `<sid>.PermissionRequest.<id>.json` → 轮询等 daemon 写 `<sid>.PermissionResponse.<id>.json` → 读 decision → stdout `{"hookSpecificOutput":{"permissionDecision":"allow"\|"deny"}}` → exit 0。timeout 30s 默认 allow |
| e | cc settings.json `permissions.ask` 列表 + 屏幕侧 pattern match | a + b 混合：通过 settings 让某些 tool 必弹 prompt（不是 acceptEdits 全 trust），只对那些 prompt 走 b 路径 | 排除：仍依赖 b 的 fragility |
| f | hook 子进程直接同步调 IM API | 跳过 daemon 中转：hook 自己 fetch iLink sendMessage + 等回复 | 排除：hook 子进程要 import iLink SDK + token + 网络 RTT 进 hook 临界路径，违反 CLAUDE.md「不破坏现有 cc 进程」（cc 等 hook 阻塞，长 RTT 影响 cc UX；且 hook 没 cc 上下文记 `lastReplyCtxBySession`）|
| g | 改 cc 源码 / fork cc | 排除：违反 CLAUDE.md「核心约束 1: 用现有 SDK 不造轮子 / 不破坏 cc」|

---

## 第 2 步：5 维度尽调

### 维度定义

| 维度 | 说明 | 量化 |
|---|---|---|
| **正确性** | 真把 IM 端决策结果传回 cc 的能力 | binary |
| **延迟** | cc 触发 prompt 到 cc 真跑 / 真 deny tool 的耗时（IM 用户 RTT 之外的协议层延迟） | ms |
| **安全性** | 防止 cc 在用户没确认时跑危险 tool 的能力 | 低/中/高 |
| **基础设施依赖** | 需 cc / wezterm / OS 提供什么 | 越少越好 |
| **fragility** | cc / wezterm 升级会不会让方案挂 | 越低越好 |
| **工程量** | 实施 + 测试 + 文档 工作量 | 行数 / 天数 |
| **跟现 design 契合** | 跟 multi-cc-im 已锁的 monitor-only state/ + file IPC 一致性 | binary |

---

### 候选 a：不做（cc 自带配置 / 模式）

| 维度 | 评估 |
|---|---|
| 正确性 | N/A — 不参与 |
| 延迟 | 0（cc 自己同步处理）|
| 安全性 | **⚠️ 用户自选**：`acceptEdits` 全 trust（rm -rf 也直接跑）/ default 模式弹 TUI prompt 但用户在外面看不到（卡死）|
| 基础设施 | cc 自带 `permissions.{allow,ask,deny}` + `--permission-mode` flag |
| fragility | 低（cc 内置）|
| 工程量 | 0 |
| 现 design 契合 | ✓ |

**实测来源**:
- cc CLI docs (https://code.claude.com/docs/en/cli-reference): `--permission-mode` 接受 `default / acceptEdits / plan / auto / dontAsk / bypassPermissions`
- cc TUI shift+tab 循环切换 mode（用户实测：屏幕底部状态栏 `⏵⏵ accept edits on` 等）
- settings.json `permissions.{allow,ask,deny}` 字段支持 pattern 如 `Bash(rm *)` / `Edit` / `Read`

**结论**: 用户明确说过「用 acceptEdits 在外面 cc 自由跑 = 安全性不够」。a 不能满足真审批需求。

---

### 候选 b：TUI 截屏 + pattern match + 键盘注入

| 维度 | 评估 |
|---|---|
| 正确性 | ✓（有 prompt 时能截到 + 注入 1/2 进 cc TUI 输入）|
| 延迟 | poll 周期 + match 处理 ~ 1-2 秒（poll 间隔决定）|
| 安全性 | ✓ 真审批；但**注入 race**：daemon 看到 prompt → forward IM → IM 回 → daemon `send-text "1"`，但 cc 可能在这中间因别的原因（用户本地按了 Esc）退出 prompt 状态，此时注入「1」落到了别的输入面（zsh / 新 prompt） — **真 hazard** |
| 基础设施 | wezterm cli get-text + send-text（已有）|
| fragility | **❌ 高**：cc 升级 prompt UI（wording 改 / 选项数变 / layout 改 / 中文化）→ pattern miss → 漏掉 prompt → cc 卡住等用户输入 |
| 工程量 | 200-300 行（poll loop + pattern match + IM 转发 + 键盘注入）|
| 现 design 契合 | ❌ 破坏 monitor-only：daemon 周期主动 query TUI 状态，引入 polling 模式（之前都是 chokidar 事件驱动）|

**实测来源**:
- wezterm cli get-text 输出（用户实测 dump）：cc TUI 屏幕含 `Do you want to proceed?` + `1.` / `2.` 编号 + 底部 `Esc to cancel` hint
- cc 历史记录显示 prompt 的 layout 在不同 cc 版本之间有微调（社区 GitHub 反馈）—— fragile 真问题

**额外风险**:
- 多语言 cc UI（中文 cc TUI prompt 是中文）→ 多 pattern 维护
- prompt **持续显示** 直到用户决定，但 daemon poll 间隔内 cc 可能因别的原因（timeout / 信号）退出 prompt → daemon 看到 stale prompt 状态以为还在等

**结论**: 跟现 design 哲学（file IPC + 事件驱动）冲突，且 fragile。可作 emergency fallback 但不应主路径。

---

### 候选 c：MCP permission server

| 维度 | 评估 |
|---|---|
| 正确性 | ✓ cc 标准协议 |
| 延迟 | <100ms 协议层（IM RTT 之外）|
| 安全性 | ✓ |
| 基础设施 | `@modelcontextprotocol/sdk-typescript` MCP server 框架 |
| fragility | 低（MCP 协议稳定，跟 cc 同步演进）|
| 工程量 | 800-1500 行（学 MCP + 实现 server + 启动整合 + 测试） |
| 现 design 契合 | △ 新 dimension（MCP server 是个新长跑进程，跟现有 daemon 平行）|

**实测来源**:
- cc CLI docs `--permission-prompt-tool` flag: "Specify an MCP tool to handle permission prompts in non-interactive mode"
- cc CLI docs `--mcp-config` flag 加载 MCP server config
- MCP 协议规范 (https://modelcontextprotocol.io)

**关键约束**: 文档说 `--permission-prompt-tool` "**in non-interactive mode**"。这是 print mode (`-p`) 的 flag。**TUI 模式（用户主要场景）能不能用？需要进一步验证**。如果 TUI 不支持 → c 整体不可行。

**实测验证（计划）**:
```bash
# 写一个最小 MCP server 暴露 permission tool
# cc 用 TUI 模式启动 + --permission-prompt-tool 看是否生效
claude --permission-prompt-tool my-mcp-server
# 然后让 cc 调一个会触发 prompt 的 Bash → 看是否走 MCP server 而非 TUI prompt
```

**结论**: 如果 TUI 也支持，c 是「最干净」选项。但工程量大；且 d 用 file IPC 已能拿到**等价语义**。c 暂排除。

---

### 候选 d：PreToolUse hook + file IPC

| 维度 | 评估 |
|---|---|
| 正确性 | ✓ — `permissionDecision: "allow"` 让 cc 真的跑；`"deny"` 阻止 |
| 延迟 | <100ms 协议层 + IM 用户 RTT |
| 安全性 | ✓ — 30s timeout 默认 allow（同 acceptEdits 安全等级）+ 可加白/黑名单细化 |
| 基础设施 | cc PreToolUse hook 协议（已用过，PR #43 删订阅前）+ multi-cc-im 现有 file IPC 模式 |
| fragility | 低（cc PreToolUse 协议稳定，cc 文档化）|
| 工程量 | 300-400 行（hook 子进程 PermissionRequest + daemon handler + file polling + 测试） |
| 现 design 契合 | **✓ 完美** — 沿用 chokidar 事件驱动 + state/ per-event-type file 模式 |

**实测来源（fetch 自 cc docs）**:
- https://code.claude.com/docs/en/hooks PreToolUse 协议
- 默认 timeout 600 秒，可在 settings.json hook entry 加 `"timeout": 30` 自定义
- `permissionDecision` 支持: `"allow"` / `"deny"` / `"ask"` / `"defer"`
- Hook stdout schema:
  ```json
  {"hookSpecificOutput":{
    "hookEventName":"PreToolUse",
    "permissionDecision":"allow|deny|ask|defer",
    "permissionDecisionReason":"..."
  }}
  ```
- timeout 默认行为 = `"allow"`（cc 文档明示）

**实施 plan**:

1. `setup-hooks.ts`: HOOK_EVENTS 加回 `PreToolUse`（PR #43 删了；但语义不同，新订阅是 permission gate 不是 dead-end analytics）。`timeout: 30` 字段在 settings.json hook entry 里。
2. `cli-cc/state-files.ts`: 新增 `<sid>.PermissionRequest.<id>.json` + `<sid>.PermissionResponse.<id>.json` 4 个 IO 函数（write/read/delete + listPending）
3. `cli-cc/hook-receiver.ts`: PreToolUse 分支
   - 拿 stdin payload
   - 写 PermissionRequest
   - 轮询等 PermissionResponse（200ms 间隔，30s 上限）
   - 读 decision → stdout JSON → exit
4. `bridge/orchestrator.ts`: chokidar add `*.PermissionRequest.*` event → onPermissionRequest
   - forward IM 给 lastReplyCtxBySession 关联 wechat 用户
   - 等 IM 回复（route IM msg 时识别 "1" / "2" 简短回复或 prefix `<id8>`）
   - 写 PermissionResponse
5. `bridge/router.ts`: parser 识别 IM 端 permission response 格式
6. `apps/multi-cc-im/src/state-sweep.ts`: cleanup 加 PermissionRequest/Response 兜底删
7. 测试：~10 新测试 (hook 等响应 / daemon forward / IM 回复匹配 / timeout / 多 cc 并发)
8. README: 加 permission flow 段

预估 300-400 行 +/- + 1-2 天。

**关键 design 决策（DD 内 stake out）**:

a. **白名单 / 黑名单**: multi-cc-im config.toml 加段：
   ```toml
   [permission]
   allow = ["Read", "Grep", "Glob", "Bash(ls *)", "Bash(cat *)"]
   deny  = ["Bash(rm -rf *)", "Bash(curl *)"]   # 30s timeout → 这些改默认 deny
   # 其余 → 30s timeout → 默认 allow（用户提议）
   ```
b. **多 cc 并发 prompt 的 IM UX**:
   - 选项 1: 每条 IM forward 带 `<request_id 8 字符>`：`[smoke a3f2c1b9] 准备跑 Bash(...)`，用户回 `a3f2 allow`
   - 选项 2: 默认对最近 1 个 pending request 回应；多个 pending 时只 ask 最新；其他 timeout 默认
   - **选项 1 更稳**（用户明确指定）；**选项 2 更直觉**（轻量交互）
c. **PermissionRequest / Response 文件 hook 子进程谁删**:
   - hook 读完 Response → hook 自己 unlink Response（一次性消费）
   - daemon 处理完 Request → daemon 写 Response → 不删 Request（hook 子进程 exit 时 daemon 看不到 chokidar event；让 hook 自己 unlink Request 在 exit 之前）
   - 简单原则：「读完即删，跟 Stop.\<ts\> 同模式」

---

## 第 3 步：对比矩阵

| 候选 | 正确性 | 延迟 | 安全 | fragility | 工程量 | 现 design 契合 |
|---|---|---|---|---|---|---|
| **a 不做** | N/A | N/A | ❌（用户否决）| 低 | 0 | ✓ |
| **b 截屏注入** | ✓+race | ~1-2s poll | ✓ | ❌ 高（cc UI 改）| 200-300 行 | ❌ 破坏事件驱动 |
| **c MCP server** | ✓ | <100ms | ✓ | ✓ MCP std | 800-1500 行 | △ 新 dimension |
| **d PreToolUse hook + file IPC** | ✓ | <100ms | ✓ | ✓ hook std | 300-400 行 | ✓ 完美 |

证据格引用：
- d 的 timeout 600s + permissionDecision 4 选项：cc docs https://code.claude.com/docs/en/hooks (fetched 2026-05-07)
- b 的 fragility：用户实测 dump 显示 cc TUI prompt layout，跨 cc 版本观察到 wording 调整
- c 的 TUI 模式适用性：cc docs 标注 "in non-interactive mode" — **未实测验证**

---

## 第 4 步：基于矩阵的推荐 + 理由

### 推荐 d

**理由 1**: 协议正确性最稳（cc 自家 PreToolUse hook，文档化 + 跟 cc 同步演进）→ 矩阵 fragility 列「✓」
**理由 2**: 工程量是 c 的 1/3，且利用现有 file IPC 模式 → 矩阵工程量列 + 现 design 契合列双优
**理由 3**: 30s timeout + 默认 allow 给 cc 同等于 acceptEdits 的便利级别，但每个被审批的 tool 都给 IM 用户一次拦截机会 → 矩阵安全列「✓」
**理由 4**: 跟现有 monitor-only state/ + chokidar 事件驱动完美对称（Request / Response 跟 Stop.\<ts\> 同款 per-event 文件）→ 矩阵现 design 契合列「✓」

### 排除 a / b / c 的精确理由

- **a 不做**: 用户明确否决（前期讨论：「想要真 IM 端确认，不只是配置 trust」）→ 安全列硬约束未达标
- **b 截屏**: fragility 列「❌ 高」 + 注入 race 未解 → 不应主路径
- **c MCP server**: 工程量 3-4× d 但**没拿到 d 拿不到的能力**（同样异步等待 + 同样原生 cc 协议）→ 性价比劣势

---

## 第 5 步：用户决定 + 锁定（pending）

### 待用户拍板

1. **方向**: ✅ 选 d / 改选其他 / 暂缓不做
2. **timeout 默认行为**: 30s allow（用户提议）/ 60s allow / 30s deny / 等用户拍
3. **白名单 / 黑名单**: 启用 / 不启用 / 留待后续 PR
4. **IM 端响应 UX**: 选项 1（带 request_id）/ 选项 2（最近 pending）/ 你提另外形态
5. **c MCP server 实测验证**: 是否要先跑 c 实测（确认 TUI 模式支不支持 `--permission-prompt-tool`）再下结论

### 一旦用户拍板

- **写入设计 doc**: 本 DD 报告状态 ⏳ → ✅，加「最终决策」段记锁定值
- **CLAUDE.md 更新**: 加一行到「关键设计假设」表 — `permission forward = ✓ DD 锁定 → docs/superpowers/specs/2026-05-07-permission-forward-dd.md`
- **HOOK_EVENTS 重新订阅 PreToolUse**: setup-hooks.ts HOOK_EVENTS 加回 `PreToolUse`（带 settings.json hook entry `"timeout": 30`）— PR #43 当时删订阅是因为「无 consumer」，现在有 consumer 了
- **PR**: 实施 PR 单独走，不混进本 DD doc PR

---

## 反 DD 模式自检

CLAUDE.md「反 DD 模式 = 违纪行为」自检：
- [ ] **不**凭 star / README / 「感觉合适」 / share 对话拍板 — 本 DD 的事实全部 fetch 自 cc 官方 docs（已注明 URL）
- [ ] **不**跳过候选枚举只列 2-3 个 — 列了 a / b / c / d / e / f / g 共 7 个，含「不做」FIRST + 排除候选
- [ ] **不**单点论据推荐 — d 的推荐理由 4 条，每条对应矩阵不同列
- [ ] **不**提议「先用 X 后续再换」 — d 是终态推荐，不存在 staged migration
- [ ] **不**未 DD 直接动手 — 本 DD 是动手前的强制前置；前期错误判断已记录在文档头部反思段

---

## 历史记录（自我反思）

**2026-05-07**: 本 DD 是补救 work。前期 design 讨论中，我（assistant）对 cc PreToolUse hook 协议的 3 条核心事实（timeout / decision shape / timeout 默认行为）凭印象拍板，且**明确告诉用户 d 路径不可行**。用户在思考备选时主动提议「PreToolUse 等 30 秒 timeout 默认 allow」—— 直觉触到了协议事实，反而是用户把我从错误结论拉回正轨。后续 fetch cc docs 完全证实用户直觉。

**教训记忆（已写入 memory）**:
- 凡是涉及 cc / wezterm / iLink / git / OS 等外部协议的事实判断，**必须 fetch 官方 docs 验证**才能拍板，不接受「我记得」「应该是」类推断。
- 如果没 fetch，对外回答必须显式标记「待验证」，不要给确定性结论。
