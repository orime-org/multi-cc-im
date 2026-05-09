# IM 路由智能分诊 (AI-routed dispatch) DD 报告

**Topic**: 当前 v1.7 router 要求 user 在 IM 端显式 `@<tab>` mention 才能路由到指定 cc，多 cc 场景下打 mention 烦躁。引入 daemon 自己 spawn 一个独立 cc 子进程做「智能分诊」: 看 user IM 消息 + 当前 tabs 列表，自动判断该路由到哪个 cc + 提取干净的任务 intent (剥离路由提示词)。

**Scope**:
- 新增 ai-router 模块 (spawn `claude --print` + prompt 模板 + JSON 解析)
- bridge router parser 改 daemon 命令 syntax (裸 `/X` 取代 `@multi-cc-im /X`)
- bridge orchestrator 路由路径分流 (mention vs no-mention → AI 分诊)
- daemon start CLI 不加新 flag (AI routing 永远 enable)
- CLAUDE.md 核心约束 #1 加例外条款 (允许 daemon spawn 独立 cc 做辅助任务)

**不动**: cli-cc / shared / storage-files / term-wezterm / im-wechat 协议层。

**Date**: 2026-05-09
**Status**: ⏳ 待用户审 → 锁定 → 实施 (PR-X 实施跟本 DD doc PR 拆开)

> 起源: 用户实测 v1.7 多 cc 场景痛点反馈「非常烦躁」。讨论中明确选择 spawn 用户已 logged-in 的 cc binary 复用订阅 quota (而非引入 Anthropic API key 依赖)。

---

## 1. 决策摘要 (待锁定)

| 候选 | 评估 |
|---|---|
| **c. per-message spawn `claude --print` 子进程** | ✅ **推荐** |
| a. 不做 (维持 mention + 粘性 current) | ❌ — 用户实测痛点强 |
| b. Anthropic SDK 直调 API (`@anthropic-ai/sdk`) | ❌ — 强制 API key 计费，不复用 user 订阅 |
| d. long-lived cc 子进程 (常驻 PTY) | ❌ — cc TUI 不为 daemon 集成设计；进程管理 + state 污染 + deadlock 风险 |
| e. 关键词规则路由 (无 LLM) | ❌ — user 维护 keyword→tab map 烦；自然语言变种多 |
| f. Claude Agent SDK npm | ❌ — Anthropic 政策禁止第三方 SDK 走 Claude.ai 订阅 (强制 API key)；优势仅在 cc 工具能力，分诊任务用不上 |

---

## 2. 问题陈述

### v1.7 现状

- `@<tab> body` 显式 mention → 路由到指定 cc (4 级 fallback: =strict / exact / prefix / glob)
- 无 mention → 路由到 `current_session` (last-explicit-mention 粘性)
- 单 cc 时无 mention → 自动路由那一个

### 用户痛点 (实测反馈)

> "1. 非常烦躁 ... 用户体验为主"

多 cc 场景下 user 每条消息要打 `@frontend ` 这 10 个字符在手机端是真的烦。`@fr` 短前缀有帮助但 user 还是要思考"这 cc 叫啥"。理想体验:

```
user 发: "前端那个登录页改完了吗"
daemon: 自动识别 → 发给 frontend cc + 剥离 "前端那个" 把 "登录页改完了吗" 发过去
```

### 为什么不能现状凑合

- 粘性 current 只能 cover「持续跟同一 cc 对话」场景。多 cc 并发时 user 思路在切，粘性会路由错
- 4 级 fallback 已经做到极致 (`@fr` 匹配 frontend prefix)，再短就歧义
- IM 端打字成本高 (虚拟键盘)，跟 terminal 体验不同

### 一个不期望的副作用

如果 AI 分诊误判 user 发的 daemon 命令 (`/start` `/stop` 等)，可能会把它当任务发给某个 cc。所以本 DD 需要 router parser **同时**改 daemon 命令 syntax: 裸 `/<word>` 起首 → 当 daemon 命令优先级最高，永远不进 AI 分诊。

---

## 3. 候选枚举

### a. 不做 (status quo)

什么都不动。user 继续打 `@<tab>` mention。

**否决**: 用户实测痛点强，rejected。

### b. Anthropic SDK 直调 API (`@anthropic-ai/sdk`)

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const r = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 256,
  messages: [{ role: 'user', content: prompt }],
});
```

**优点**:
- 最轻 (一个 npm package + 一个 fetch)
- 最快 (~500ms haiku)
- prompt 完全可控

**缺点**:
- **强制 ANTHROPIC_API_KEY** (按月按 token 计费)
- 不能走 user 已有的 Claude.ai (Pro / Max) 订阅 quota
- multi-cc-im 受众都是 cc 用户，他们 100% 已经付了 Claude 订阅 — 让他们再单独配 API key 是烂体验

**否决**: 不复用 user 订阅，违反「user 已经付钱给 Claude 了，复用就完了」直觉。

### c. per-message spawn `claude --print` 子进程 ✅ 推荐

```bash
echo > /dev/null
claude --print \
  --model claude-haiku-4-5 \
  --output-format json \
  --permission-mode bypassPermissions \
  --disable-slash-commands \
  --setting-sources user \
  "<分诊 prompt>"
# 退出后读 stdout 的 JSON
```

每条 IM 消息 spawn 一个独立 cc 子进程做分诊，进程退出即 done。

**优点**:
- **复用 user 订阅** (cc CLI 默认 OAuth login → Claude.ai 订阅，spawn 它继承登录态)
- 零额外 API 费用
- cc CLI `--print` 设计就是为 one-shot 非交互式调用
- 进程隔离干净，无 state 污染
- daemon 端零进程管理负担 (exit 即 done)
- 生产 LLM 输出直接走 user 已熟悉的 model (Claude haiku/sonnet)

**缺点**:
- cc cold start ~1-2s + LLM 推理 ~500ms-1s = 总 ~2-3s 延迟
- cc 加载 system prompt + tools list 浪费 token (但 user 订阅不按 token 算钱所以无所谓)
- 第三方 spawn cc binary 处于 Anthropic 政策灰色 (但等同 user 自己跑 cc，没 "再分发 Claude.ai login")

**推荐**。

### d. long-lived cc 子进程 (常驻 PTY)

daemon 启动时 spawn 一个 cc 进程，跑 interactive 模式，daemon 通过 stdin/stdout (PTY) 持续喂 prompt 收 response。

**优点**:
- 第二次以后无 cold start (已加载 system prompt)
- cc 内部 cache 复用

**缺点**:
- cc TUI 不为 daemon 集成设计 — interactive mode 输出含 ANSI escape / spinner / partial-update，daemon 要实现 PTY 解析
- session state 污染: 上轮分诊上下文进入下轮 prompt，分诊不再独立
- 进程死掉 / hang 要 detect + 重启
- deadlock 风险 (cc 等输入 / daemon 等输出)
- 复杂度跟收益不成比例 (1-2s 节省，多写 200+ 行 PTY 代码)

**否决**。

### e. 关键词规则路由 (无 LLM)

user 在 config.toml 里维护 `[routing.keywords]` 映射: `前端 = frontend`, `后端 = backend`, ...

**优点**:
- 零成本 / 零依赖 / 即时

**缺点**:
- user 维护映射烦
- 自然语言变种多: 前端 / fe / frontend / 网站 / UI / ...
- 用户脑模型「这是个 AI bridge」打破 (没 LLM 智能)

**否决**。

### f. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` npm)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const m of query({ prompt: '...', options: {...} })) { ... }
```

**优点**:
- 官方支持的 daemon 集成方式
- cc 内核完整功能 (tool calling 等如果未来需要)
- 不 spawn 进程 (in-process node module)

**缺点**:
- **Anthropic 政策禁止第三方 SDK 走 Claude.ai 订阅**:
  > "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- 强制 ANTHROPIC_API_KEY → 跟 (b) 一样要 user 单独付钱
- 分诊任务不需要 cc 工具能力，SDK 优势用不上

**否决**。

---

## 4. 对比矩阵

| 维度 | a. 不做 | b. Anthropic SDK | **c. spawn cc** | d. long-lived | e. 关键词 | f. Agent SDK |
|---|---|---|---|---|---|---|
| 解决痛点 | ❌ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| 复用 user 订阅 | n/a | ❌ | ✅ | ✅ | n/a | ❌ |
| 额外费用 | 0 | API 计费 | 0 | 0 | 0 | API 计费 |
| 延迟 | 0 | ~500ms | **~2-3s** | ~500ms 后续 | <50ms | ~500ms |
| 实施难度 | 0 | 低 (npm + fetch) | 低 (exec + parse json) | 高 (PTY 解析 + state) | 低 (toml + map) | 中 (npm + auth) |
| 长期维护 | 0 | 跟 SDK 版本 | 跟 cc CLI 版本 (向后兼容) | PTY hang / state 复杂 | user 改 keywords 烦 | 同 b |
| 进程隔离 | n/a | 无 (in-process) | ✅ | ❌ 状态污染 | n/a | 无 |
| 扩展性 (未来 cc 工具) | n/a | ❌ 无 | ✅ 改 flag 即可 | ✅ | ❌ | ✅ 完整 |

### 关键差异点

**(c) vs (b)**: 唯一差异是「复用订阅 vs 单独付钱」。其他维度差不多。user 痛恨「再付一份钱」，c 胜出。

**(c) vs (f)**: f 是 in-process npm，c 是 exec subprocess。f 看似更轻，但 Anthropic 政策禁止 SDK 走订阅 → 等同 (b)。c 反而是唯一合规走订阅的途径。

**(c) vs (d)**: d 节省 1-2s 冷启 cost；c 实施简单 + 隔离干净。1-2s 在 IM 场景可接受，d 的复杂度跟收益不成比例。

---

## 5. 推荐: 候选 c (per-message spawn `claude --print`)

按矩阵分析，c 是唯一满足:
- ✅ 复用 user 订阅 (零额外费用)
- ✅ 实施简单 (~150 行代码)
- ✅ 进程隔离干净
- ✅ 扩展性好 (未来需要 cc 工具能力，改 flags 就行)

代价 (~2-3s 延迟) 在 IM 场景可接受 — user 期望 IM 反应是秒级，不是毫秒级。

---

## 6. 实施计划

### 6.1 Router parser 改 (`packages/bridge/src/router.ts`)

**Daemon 命令 syntax 切换** (不向后兼容):

```diff
- @multi-cc-im /list      → bridge_command (旧)
+ /list                   → bridge_command (新)
- @multi-cc-im /start     → bridge_command
+ /start                  → bridge_command
+ /start off              → bridge_command (auto-approve OFF)
+ /unknown                → echo "❌ unknown command: /unknown"
```

Parser 优先级 (从高到低):
1. **裸 `/<word>` 起首** → daemon 命令 (新)
2. `@<tab>` mention → mention 路径 (现有)
3. `@<tab> /1`/`/2` → permission response (现有)
4. `@all body` → broadcast (现有)
5. plain (无 mention) → AI 分诊 (新替代粘性 current fallback)

### 6.2 新模块 `packages/im-wechat/src/ai-router.ts` (或 `packages/ai-router/`)

```ts
export interface AIRoutingResult {
  target: string | null;       // 'frontend' | 'backend' | ... | null
  intent: string | null;        // 剥离路由词后的纯任务描述
  reason: string | null;        // <15 字内分诊理由 (daemon log 用)
}

export async function routeViaAI(opts: {
  userMsg: string;
  tabs: string[];               // 仅 title (不带 cwd)
  currentTab: string | null;    // last-explicit-mention 粘性 tab
}): Promise<AIRoutingResult>;
```

实现:
1. 渲染 prompt 模板 (见 §6.3)
2. spawn `claude --print` 子进程 (见 §6.4)
3. 解析 stdout JSON
4. 返回 `AIRoutingResult` 或 `{ target: null, intent: null, reason: 'parse failed' }`

### 6.3 分诊 Prompt 模板 (lock 版本)

```
你是 multi-cc-im 的 IM 路由助手。

产品功能:
multi-cc-im 是个人 bridge — user 在 IM 端 (微信 / Telegram / 飞书等)
发消息，daemon 把消息分发到本机跑着的对应 Claude Code 实例。每个实例
对应一个工作流上下文 (前端 / 后端 / 测试 / 文档等)，都有 user 起的
语义化名字。

当前活的 Claude Code tabs:
{{tab_titles_only}}

current (user 上次显式选过的 tab，可能跟当前消息相关也可能不相关):
{{current_or_none}}

User 当前 IM 消息:
"{{user_msg}}"

请你做两件事:
1. 判断这条消息最适合发给哪一个 tab
2. 提取 user 的真实意图 — 把消息中的路由提示词 ("前端那个" / "backend 的"
   等给 IM 路由的 cue 词) 剥离，留下实际要发给 cc 的纯净任务描述

规则 (按优先级):
1. 消息内容明显跟某个 tab 名字相关 → 选那个
2. 消息用代词「它」「这个」延续上文 → 选 current
3. 模糊或多个都合理 → "none" (intent 不必处理)

只能选一个 target，不允许多个。

输出 JSON (无 markdown 包装):
{
  "target": "<tab name>" | "none",
  "intent": "<剥离路由词后的纯任务描述>" | null,
  "reason": "<15字内分诊理由>"
}
```

### 6.4 Spawn 命令模板

```bash
claude --print \
  --model claude-haiku-4-5 \
  --output-format json \
  --permission-mode bypassPermissions \
  --disable-slash-commands \
  --setting-sources user \
  "<rendered prompt>"
```

flags 作用:
- `--print` / `-p`: headless one-shot
- `--model claude-haiku-4-5`: 强制 haiku (默认 sonnet 慢 + 浪费 quota)
- `--output-format json`: 结构化输出 (cc 包了一层 outer envelope: `{ result: "...", session_id: "...", usage: {...} }`，inner result 是我们 prompt 输出的 JSON)
- `--permission-mode bypassPermissions`: 不弹任何工具审批 (我们任务纯文本不调工具)
- `--disable-slash-commands`: 禁 skills + slash commands 加载 (减少 token + 启动时间)
- `--setting-sources user`: 只 load `~/.claude/`，不 load daemon cwd 的 project CLAUDE.md (避免污染)

### 6.5 Bridge orchestrator 接入

```ts
async function handleInbound(msg: IncomingMessage) {
  // ... 现有 IMOrigin write + IMWork read ...
  
  const parsed = parse(msg.text);
  
  switch (parsed.type) {
    case 'bridge_command':
      // /start /stop /list /help /current /unknown
      return handleBridgeCommand(parsed);
    
    case 'mention':
      // @<tab> body — 现有路径
      return handleMention(parsed);
    
    case 'plain': {
      // 无 mention — AI 分诊
      const tabs = await opts.termAdapter.listPanes();
      const tabTitles = tabs.filter(t => t.title.length > 0).map(t => t.title);
      const currentTab = state.getCurrent() ? findTabName(...) : null;
      
      const result = await routeViaAI({
        userMsg: parsed.body,
        tabs: tabTitles,
        currentTab,
      });
      
      if (result.target === null || result.intent === null) {
        // AI 给不出可用结果 (target=none 或 intent=null)
        return imSend(msg.replyCtx, '❌ 无法识别目标，请用 @<tab>');
      }
      
      // 当 explicit mention 处理 — 路由 + 粘性更新 + echo
      await termAdapter.sendText(targetPaneId, result.intent);
      await termAdapter.sendKeystroke(targetPaneId, '\r');
      state.setCurrent(targetPaneId);  // 粘性更新
      return imSend(msg.replyCtx, `→ ${result.target}｜AI: 「${result.intent}」`);
    }
  }
}
```

### 6.6 echo 文案

| 情况 | echo |
|---|---|
| AI 路由成功 | `→ frontend｜AI: 「登录页改完了吗」` |
| AI 输出 'none' | `❌ 无法识别目标，请用 @<tab>` |
| AI 输出 target 但 intent=null | `❌ 无法识别目标，请用 @<tab>` (跟 'none' 同处理) |
| AI 子进程超时 / 崩溃 / parse 失败 | `❌ AI 分诊失败，请用 @<tab>` (可选: log err 详细到 daemon) |

### 6.7 CLAUDE.md 修订

```diff
 # 核心约束（项目第一原则）
 
 任何架构决策必须先过这两条。违反即重新设计。
 
-1. **不破坏现有 cc 进程**
-   cc 继续以 TUI 形式跑在用户 WezTerm tab 里。bridge **不** spawn cc、**不** 接管 stdin/stdout、**不** 包一层伪 TUI。
+1. **不破坏用户的 cc 进程**
+   bridge **不** spawn 用户在 wezterm tab 里跑的那个 cc TUI 进程、**不** 接管它的 stdin/stdout、**不** 包一层伪 TUI 给它。
+
+   **例外 (DD 锁定)**: daemon 可以 spawn 独立 `claude --print` 子进程做辅助任务
+   (如 IM 路由分诊 — 见 [DD: AI-routed IM dispatch](docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md))。
+   这种实例:
+   - 跟 wezterm tab 里的 cc TUI 完全独立 (separate process, 不共享 session/cwd)
+   - 必须 `--print --permission-mode bypassPermissions --disable-slash-commands` 等 minimal flags
+   - 复用 user 已 `claude login` 的订阅 quota (零额外费用，禁止引入 ANTHROPIC_API_KEY 依赖)
+   - 必须 IM echo 显示 AI-routed 标签让用户知情 (per "路由 visible echo" 规则)
```

### 6.8 测试 plan

- `ai-router.test.ts` (~10 cases):
  - mock spawn — 输出 valid JSON → 正常 route
  - mock spawn — 输出 target=none → null result
  - mock spawn — 输出 target + intent=null → null result
  - mock spawn — exit 非 0 → throw
  - mock spawn — stdout 非 JSON → parse error → null result
  - mock spawn — 超时 (设短 timeout 测) → null result
  - prompt 模板渲染正确 (tabs / current / userMsg 注入)
  - cmd args 正确 (model / permission-mode / etc.)
- `router.test.ts`:
  - 裸 `/start` → bridge_command
  - 裸 `/unknown` → bridge_command (echo unknown)
  - plain 无 mention → 触发 AI 分诊 (mock)
- `orchestrator.test.ts`:
  - plain → AI route → sendText 到对应 paneId + 粘性更新 + echo 含 intent
  - plain → AI 'none' → echo 拒绝
  - mention 路径不调 AI

### 6.9 文档同步

- `CLAUDE.md`: 修订核心约束 #1 + 新增 MANDATORY 规则 (`AI 分诊必须复用 user 订阅，禁止引入 API key`)
- `README.md` / `README.zh-CN.md`: 路由语法表全改 (裸 `/X` syntax + AI 分诊行为)
- `docs/architecture.md`: 加 AI 分诊章节 (描述 spawn 命令 + prompt + lifecycle)

---

## 7. 风险

### 7.1 cc cold start 延迟

每条 plain IM 消息 +1.5-2.5s 延迟 (cc cold start + haiku 推理)。user 实测可接受，但 IM 端 user 会感知到「我发了消息，等几秒才看到 echo」。

**缓解**: cc CLI 自身在新版本可能优化 cold start (我们 follow 上游)。如果未来仍痛，再考虑 (d) long-lived 方向。

### 7.2 AI 误判

LLM 看短消息可能误判 target (e.g. "改下" 没明显信号)。

**缓解**: echo 显示 `intent` → user 看到 AI 误解能下条 `@<tab> 真意图` 显式覆盖。错误成本低 (路由错的消息发给错的 cc，cc 可能跑了一会但 user 立刻看到回复就知道错了)。

### 7.3 cc 订阅 rate limit

cc 订阅 (Pro/Max) 有 rate limit (e.g. Pro 5h 内限制 X 个 turn)。AI 分诊每条无 mention IM 消息消耗一个 turn —— 高频 user 可能撞 limit。

**缓解**:
- haiku 4.5 是订阅里最便宜的 turn (低 cost)
- user 高频时仍可手动 `@<tab>` 显式 mention 跳过 AI
- 撞 limit 时分诊 fail → echo 拒绝 + 降级到「请用 @<tab>」

### 7.4 cc 政策合规灰色

第三方项目 spawn user 的 cc binary 是政策灰色地带 (Anthropic SDK 政策禁第三方走 Claude.ai 订阅，但 spawn binary 不在 SDK 范畴)。

**评估**: 我们没"再分发 Claude.ai login"也没"提供给我们的 user" — 我们的 user 自己 install + 自己 login cc，daemon spawn 等同 user 自己跑一次 `claude -p`。**实际**等同 user 用法。如果未来 Anthropic 收紧政策，最坏 fallback 到 (b) Anthropic SDK + API key，user 加配 key 即可。

### 7.5 IM 端 echo 长度

`→ frontend｜AI: 「<长 intent>」` 在 user IM 里多一行。但比 user 自己打 `@frontend` 节省更多打字成本，净负担降低。

### 7.6 Token 浪费

cc system prompt + tools list 每次 spawn 都加载 (即使 `--disable-slash-commands`)，分诊任务实际只需要几百 token。用户订阅不按 token 算钱所以 fee 无影响，但 rate limit (turn 数) 仍是 1 turn — 跟 prompt 长度无关，所以 token 浪费不影响 limit。

---

## 8. 锁定决策 (待用户确认)

✅ **采纳候选 c**:

- 新模块 `ai-router` (per-message spawn `claude --print`)
- 默认 enable，**无 CLI flag 关掉** (理由: multi-cc-im 受众都是 cc 用户，100% 已 login 订阅)
- 全部无 mention 消息走 AI 分诊 (单 cc 也走，统一逻辑)
- AI 输出 JSON 含 `target` + `intent` + `reason`，路由用 `target`，发给 cc 的 prompt 用 `intent`，echo 显示 `intent` 让 user 验证 AI 理解
- AI 输出 'none' 或 intent=null → echo `❌ 无法识别，请用 @<tab>`
- Router parser 改裸 `/X` daemon 命令 syntax，**删 `@multi-cc-im /X` 旧 syntax 不向后兼容**
- CLAUDE.md 核心约束 #1 加例外条款 (允许 daemon spawn 独立 cc 做辅助任务)
- 强制复用 user 订阅，**禁止** 引入 `ANTHROPIC_API_KEY` 依赖

待用户审 → 锁定 → PR-X 实施 (本 doc PR 单独 merge，再开实施 PR)。

---

## 9. CLAUDE.md「关键设计假设（状态总表）」加一行

| 维度 | 状态 | 详情 |
|---|---|---|
| AI 路由分诊 (daemon 自动 IM 路由) | ✓ | daemon 收到无 mention plain IM 消息 → spawn 独立 `claude --print --model haiku-4-5 --permission-mode bypassPermissions --disable-slash-commands --setting-sources user` 子进程做分诊；prompt 含 tabs 列表 + current_session + user 消息；输出 `{target, intent, reason}` JSON。target 为空 / intent 为空 → echo 拒绝。复用 user 订阅 quota，禁引 API key。Router parser 改裸 `/<cmd>` daemon 命令 syntax，删 `@multi-cc-im /X` 旧 syntax；[DD: AI-routed IM dispatch](docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md) |
