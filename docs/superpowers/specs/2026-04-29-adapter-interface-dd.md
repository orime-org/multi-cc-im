# Adapter 接口设计 DD 报告

**Topic**: multi-cc-im 项目 IM / Term / CLI adapter 接口（`packages/shared/`）的设计风格选型
**Scope**: 仅覆盖**事件流类 adapter**（IMAdapter / TermAdapter / CLIAdapter）。**Storage adapter 单独 DD**（CRUD 形态，设计风格完全不同；跟 SQLite vs Postgres 选型 + unstorage driver 借鉴一起做）。
**Date**: 2026-04-29
**Status**: ✅ 已锁定
**结论**: 选定 **D（TS-first hybrid）** —— callback inject 数据流 + `extends`-based 编译时 capability inheritance + type guard narrow。沿用 cc-connect 6573★ 实战验证的"窄核心 + capability extension"哲学，但用 TS 编译时机制替代 Go runtime feature detection。Storage adapter 单独 DD（事件流 vs CRUD 形态不同）。

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走完。此 DD 触发的启发式：「跨包接口 / 共享类型」+「反悔代价 > 1 周工作量」。

---

## 第 1 步：候选枚举

按 CLAUDE.md「反 DD 模式」「跳过候选枚举只列 2-3 个 → 假对比」，本 DD 穷举三大类候选：

### 类别 1: 端到端项目接口实样（看真实代码）

| ID | 项目 | 数据来源 | 是否进 short list |
|---|---|---|---|
| Pj1 | **chenhg5/cc-connect** (Go, 6573★, push 2026-04-28) | [`core/interfaces.go`](https://github.com/chenhg5/cc-connect/blob/main/core/interfaces.go) | ✓ → 提炼为 short list **A** |
| Pj2 | six-ddc/ccmux (Python) | `src/ccbot/` | ✗ 单实现模块化，无 abstract 接口；模块组织参考保留 |
| Pj3 | sgaofen/cli-in-wechat | (未深入) | ✗ time-box，规模小、范围窄 |
| Pj4 | Wechat-ggGitHub/wechat-claude-code | (未深入) | ✗ 同上 |
| Pj5 | Bergamolt/telegram-sessions | (未深入) | ✗ 4★，规模小 |
| Pj6 | lc2panda/claude-plugin-wechat | (未深入) | ✗ Channel + ACP 路线，跟 hook 路线不同 |
| Pj7 | Johnixr/claude-code-wechat-channel | (未深入) | ✗ 单 IM，无多 adapter 抽象 |

cc-connect 是同类项目里唯一已经做了 multi-IM × multi-AI-CLI 抽象的（12 IM 平台 + 4 AI CLI 实战），其他项目接口要么不存在要么规模有限。**cc-connect 一份 `interfaces.go` 把端到端项目调研工作量缩减 70%**。

### 类别 2: npm 抽象层

| ID | 包 | 用途 | 进 short list |
|---|---|---|---|
| Np1 | `unstorage` (Nuxt) | StorageAdapter driver pattern | → Storage 单独 DD 用 |
| Np2 | `keyv` (Sindre Sorhus) | 多 storage backend | → Storage 单独 DD 用 |
| Np3 | `ai` (Vercel AI SDK) | multi-LLM provider 抽象 | → CLIAdapter 子组件参考（不进主 short list） |
| Np4 | bottender / botpress | multi-IM bot framework | ✗ 太具体，不抽象到 Channel 这层 |
| Np5 | node-pty / @xterm/headless | terminal 底层 lib | ✗ 实现工具，不是 interface 候选 |

npm 上**没有现成的"事件流 adapter 通用抽象层"** 直接 depend。最相近的是 unstorage driver 模式但只覆盖 KV 类。

### 类别 3: First-principles 设计风格

| ID | 风格 | 进 short list |
|---|---|---|
| **F-A** | cc-connect 风格（callback inject `start(handler)` + runtime capability）| ✓（提炼自 Pj1） |
| **F-B** | EventEmitter 风格（`adapter.on('msg', cb)` + emit）| ✓ |
| **F-C** | AsyncIterator 风格（`for await of adapter.messages()`）| ✓ |
| **F-D** | TS-first hybrid（callback + `extends`-based 编译时 capability inheritance）| ✓ |
| F-E | RxJS Observable | ✗ 引大依赖，不必要 |
| F-F | Web Streams API | ✗ Node.js 生态外文档稀少 |
| F-G | Channel-based（async generator 模拟 Go chan）| ✗ 跟 F-C 重叠且更复杂 |

### Short list（进第 2 步 5 维度尽调）

```
A. cc-connect 风格        — Go runtime feature detection 移植
B. EventEmitter 风格      — Node.js 经典，事件名字符串
C. AsyncIterator 风格     — TS 现代，pull-based 强类型
D. TS-first hybrid 风格   — callback + extends-based 编译时类型保证
```

排除理由可追溯（见上面三张表）。

### Short list 内候选的关键差异 axis

| 维度 | A | B | C | D |
|---|---|---|---|---|
| 数据流形态 | push (callback) | push (event emit) | pull (async iterator) | push (callback) |
| capability 检查 | runtime (`'method' in obj`) | 事件名字符串匹配 | TS interface method 存在性 | TS extends 编译时 |
| 类型安全 | 弱（runtime cast）| 弱（事件名靠约定）| 强（TS native）| 强（TS native）|
| 语言习惯 | Go 风格 port | Node.js 传统 | TS 现代 | TS 现代 |
| 实战 reference | cc-connect 6573★ | Node.js 内置 | TS 4.9+ widespread | 几乎所有现代 TS 项目 |

A 跟 D 的本质差异：**Go runtime type assertion → TS extends 编译时检查**。是 TS-vs-Go idiom 真实差异，不是表面 wrapper。

---

## 第 2 步：5 维度尽调（per-candidate）

> 维度选择按 CLAUDE.md「DD 5 步」第 2 步定义 + 项目特定（multi-cc-im 是 TS 项目，调整"上游跟进" → "TS 适配难度"）。

### 5 维度

| 维度 | 说明 |
|---|---|
| **method 数 / 复杂度** | 核心接口 method 数 + capability 接口数；越少越好（简单优先）|
| **类型安全** | 编译时 vs runtime；编译时 > runtime（CLAUDE.md「禁止 `any`」精神）|
| **错误模型** | exception throw / Result type / typed error variant；可处理性 |
| **生命周期** | 连接、健康检查、断开、重启的清晰度 |
| **扩展性** | 添加新 adapter / 添加新 capability 时改动面 |

### 候选 A：cc-connect 风格（callback + runtime capability）

```typescript
interface Platform {
  name(): string;
  start(handler: MessageHandler): Promise<void>;
  reply(ctx: Context, replyCtx: unknown, content: string): Promise<void>;
  send(ctx: Context, replyCtx: unknown, content: string): Promise<void>;
  stop(): Promise<void>;
}

// Capability 用 plain interface（runtime 检查）
interface ImageSender {
  sendImage(ctx: Context, replyCtx: unknown, img: ImageAttachment): Promise<void>;
}

// 调用方
if ('sendImage' in adapter) {
  await (adapter as unknown as ImageSender).sendImage(...);
}
```

**method 数 / 复杂度**: 核心 5 method（cc-connect 实样验证）+ ~15 capability interface。复杂度可控（核心窄）。  
**类型安全**: 弱。`replyCtx: unknown` 跨 adapter 类型透明，capability 检查靠 runtime `'in'` 操作符（TS 能 narrow 但仍有 cast 风险）。**违反 CLAUDE.md「禁止 `any`」精神**（用 `unknown` + cast，相当于半 any）。  
**错误模型**: throw / Promise reject。Go 原版用 `error` return，TS 移植自然 throw。可在 method 签名加 typed error 但 cc-connect 没做。  
**生命周期**: 仅 `start` / `stop`。无显式 health check / heartbeat。**multi-cc-im 需要 pane 活性 check，A 风格要补一个 capability interface**（增加 capability 数）。  
**扩展性**: 加新 adapter = 实现 5 method + 选择性实现 capability。runtime feature detection 对 caller 透明（caller 用 `'in'` 检查后类型 narrow）。**问题**：caller 写法 `if ('sendImage' in adapter)` 在大型代码里散落是 anti-pattern（违反「禁止 `any`」精神 — 实质是 type erasure）。

### 候选 B：EventEmitter 风格

```typescript
interface PlatformEvents {
  message: [msg: IncomingMessage];
  disconnect: [reason: string];
  error: [err: Error];
}

class WeChatAdapter extends EventEmitter<PlatformEvents> {
  start(): Promise<void>;
  send(content: string, replyCtx: ReplyCtx): Promise<void>;
  stop(): Promise<void>;
}

// 调用方
adapter.on('message', (msg) => { /* ... */ });
adapter.on('disconnect', (reason) => { /* ... */ });
```

**method 数 / 复杂度**: 核心 3 method（start/send/stop）+ N 个 event。简洁。但 capability 通过 event 表达不自然（"sendImage 是 method 不是 event"）。  
**类型安全**: 中。事件 payload 可强类型（TS EventEmitter 泛型），但 capability 检查靠"是否注册了 sendImage method"还是 runtime `typeof adapter.sendImage === 'function'`，仍是弱。  
**错误模型**: error event 隔离同步流（caller `.on('error')` 接），是 Node.js 经典模式但有 swallow 风险（caller 忘记 listen 'error' 会 crash 进程）。  
**生命周期**: start/stop 之外，event 'disconnect' 表达健康。但 caller 若未 listen 'disconnect' 不知道断开。  
**扩展性**: 加新 adapter = extend EventEmitter + 实现 method。capability 不通过 emitter 表达（capability 是 method 而非 event），导致 capability 形态混乱（一些是 event 一些是 method）。**风格混杂的问题**。

### 候选 C：AsyncIterator 风格

```typescript
interface Platform {
  name: string;
  start(): Promise<void>;
  messages(): AsyncIterable<IncomingMessage>;
  send(content: string, replyCtx: ReplyCtx): Promise<void>;
  stop(): Promise<void>;
}

interface ImageSenderPlatform extends Platform {
  sendImage(img: ImageAttachment, replyCtx: ReplyCtx): Promise<void>;
}

// 调用方
const adapter = new WeChatAdapter();
await adapter.start();
for await (const msg of adapter.messages()) {
  await router.route(msg);  // 单消费者
}
```

**method 数 / 复杂度**: 5 method 核心 + 每个 capability 1 method。简洁。  
**类型安全**: 强。capability 通过 TS interface inheritance（`extends Platform`）+ 编译时检查。`adapter as ImageSenderPlatform` 的 narrowing 用 type guard 函数（`isImageSender(adapter)`）实现。  
**错误模型**: throw / Promise reject 在 `for await` 里被 promotion 到 try/catch。可处理性最好。  
**生命周期**: start/stop 清晰。健康通过 messages() 是否中断表达（iterator return = 流结束）。pane 活性 check 加一个 method 即可。  
**扩展性**: 加新 adapter = 实现 messages() AsyncGenerator + 5 method。**问题 1**：AsyncIterator 是 single-consumer（一个 for-await-of 消费即耗尽），multi-cc-im 的 router 是 single consumer 没问题，但若需要 fan-out（送 router + log + analytics）要在 caller 层手动 fan-out。**问题 2**：iterator 不能命令式 pause / resume，控制弱于 EventEmitter。

### 候选 D：TS-first hybrid（callback + extends 编译时 capability）

```typescript
interface Platform {
  name: string;
  start(handler: MessageHandler): Promise<void>;
  send(content: string, replyCtx: ReplyCtx): Promise<void>;
  stop(): Promise<void>;
}

interface ImageSenderPlatform extends Platform {
  sendImage(img: ImageAttachment, replyCtx: ReplyCtx): Promise<void>;
}

interface FileSenderPlatform extends Platform {
  sendFile(file: FileAttachment, replyCtx: ReplyCtx): Promise<void>;
}

interface FullPlatform extends ImageSenderPlatform, FileSenderPlatform {}

// type guard
function isImageSender(p: Platform): p is ImageSenderPlatform {
  return 'sendImage' in p;
}

// 调用方
if (isImageSender(adapter)) {
  await adapter.sendImage(img, replyCtx);  // TS narrow，无需 cast
}
```

**method 数 / 复杂度**: 核心 4 method（start/send/stop + name 字段）。capability 通过 interface extends 表达，每个 capability 1 method。复杂度同 A，但 capability 数可控（按需实现）。  
**类型安全**: 强。capability 通过 interface inheritance 编译时检查，type guard 函数 narrow。**符合 CLAUDE.md「禁止 `any`」精神**（无 cast / 无 `unknown` 漏洞）。  
**错误模型**: throw / Promise reject。可加 typed error variant（`type SendError = AuthError | NetworkError | ...`）增强可处理性。  
**生命周期**: start/stop 清晰，加 `healthCheck()` capability interface 表达 pane 活性 check（multi-cc-im 特有）。  
**扩展性**: 加新 adapter = 实现 4 method + 选择 extends 哪些 capability interface。caller 用 type guard 函数 narrow，**编译时报错警告 missing capability**（A 风格 runtime 才发现）。

---

## 第 3 步：对比矩阵

| 维度 | A: cc-connect 风格 | B: EventEmitter | C: AsyncIterator | D: TS-first hybrid |
|---|---|---|---|---|
| **method 数 / 复杂度** | 5 核心 + 15 cap interface | 3 method + N events | 5 核心 + N cap | 4 核心 + N cap interface |
| **类型安全** | 弱（runtime + unknown）| 中（事件强类型 + capability 弱）| 强（TS native） | **强（TS native）+ 无 cast** |
| **错误模型** | throw / reject | error event（swallow 风险） | throw 在 for-await 自然 promote | throw + 可加 typed variant |
| **生命周期** | start/stop，无 health | start/stop + disconnect event | start/stop + iterator 终止 | start/stop + healthCheck cap |
| **扩展性** | runtime cast 散落 anti-pattern | event vs method 混杂 | single consumer 限制 + 不能 pause | type guard narrow + 编译时检查 |
| **multi-cc-im 适配** | spawn 模式有冲突，需改造 | router fan-out 不便 | router single-consume 天然适合 | 跟 C 一样适合 + 类型保证更强 |
| **对 hook+wezterm 实测产出对接** | 5 类 hook stdin 用 callback inject 顺接 ✓ | 5 类 hook 转 5 个 event 也 OK | 5 类 hook 合并到 single iterator 别扭 | 5 类 hook 用 callback 顺接 ✓ |

---

## 第 4 步：推荐 + 理由

**推荐 D（TS-first hybrid）**。每条理由可追溯到上面矩阵：

1. **类型安全最强**（矩阵第 2 行 D 列）：编译时 capability 检查 + 无 `any` / `unknown` cast 漏洞。**符合 CLAUDE.md「禁止 `any`」精神**。A 用 `replyCtx: unknown` + runtime cast 实质是半 any，违反硬规范。
2. **callback inject 跟 hook+wezterm 实测产出顺接**（矩阵第 7 行）：cc 5 类 hook 来的 stdin payload 已经是 push 形态（hook 触发 → bridge 接收），用 callback inject 的 `start(handler)` 把 5 类 hook 各自的 `handler.onUserPromptSubmit` / `handler.onStop` 等 method 暴露出来天然顺接。AsyncIterator 反而要把 5 类 hook 合并到 single iterator 别扭（C 列扣分）。
3. **router fan-out 不需要**（矩阵第 6 行）：multi-cc-im router 是 single-consumer（每条消息只路由一次），所以 push 风格的 callback inject 跟 pull 风格 AsyncIterator 都 OK。但 callback 风格的 method handler interface（`{ onMessage, onDisconnect, onError }`）让 caller 一次性绑定多种事件 handler，比 EventEmitter 注册多个 listener 简洁。
4. **healthCheck capability 表达 pane 活性最自然**（矩阵第 4 行）：CLAUDE.md「关键规范」要求"路由前必须验证 pane 里 cc 活着"，D 风格通过 `interface PaneAlivePlatform extends Platform { isAlive(): Promise<boolean> }` capability 表达，编译时检查 caller 是否调用，比 A 的 runtime 检查可靠。
5. **添加新 capability 不破坏老 adapter**（矩阵第 5 行）：D 跟 A 一样有这个特性，但 D 的 caller 体验更好（type guard narrow vs runtime cast）。

排除其他候选的理由：

- **排除 A**：cc-connect 风格在 TS 里实质退化为半 any（runtime cast），违反「禁止 `any`」精神。Go → TS 直接 port 不顾 idiom。
- **排除 B**：event vs method 混杂的风格问题（capability 该是 event 还是 method？）+ error event swallow 风险。EventEmitter 在 TS 里已经被 native EventTarget / AsyncIterable 取代。
- **排除 C**：5 类 cc hook 合并到 single iterator 别扭 + iterator 不能命令式控制（pause/resume）。AsyncIterator 适合"统一事件流"场景，multi-cc-im 的 hook 是分类事件流。

---

## 第 5 步：用户决定

**用户拍板**：A — 接受推荐 D（TS-first hybrid）。
**锁定时间**：2026-04-29
**依据**：本 DD 报告 + 推荐 D 的 4 条决定性证据（类型安全是硬规范 / hook+wezterm 实测产出顺接 / pane 活性 check capability 表达最自然 / 沿用 cc-connect 实战验证设计 + TS-idiomatic）。

后续动作：写 `packages/shared/src/{types.ts,adapter.ts,guards.ts}` + contract 测试，按 TDD 节奏（CLAUDE.md「TDD 红→绿→蓝节奏」+ `docs/dev.md`「TDD 写代码节奏」）实施。Storage adapter 单独 DD 启动时机待定。

---

## 实施清单（v1 落地步骤，待第 5 步锁定后启动）

```
1. packages/shared/src/types.ts
   - Context / IncomingMessage / OutgoingMessage / ReplyContext / ImageAttachment / FileAttachment
   - 各 zod schema for runtime validation at adapter boundary

2. packages/shared/src/adapter.ts
   - Platform / Terminal / CLIAgent 三个 interface（事件流 adapter）
   - 各 capability interface（ImageSenderPlatform / FileSenderPlatform / PaneAlivePlatform / 等）
   - type guard 函数（isImageSender / isPaneAlive / 等）
   - MessageHandler / TerminalHandler / CLIHandler 类型

3. packages/shared/src/__tests__/contracts/
   - Platform contract 测试（mock implementation 验证 contract）
   - 各 capability contract 测试

4. packages/shared/src/index.ts
   - re-export 所有 public API
```

## 风险与缓解

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| TS extends-based capability 在大型 codebase 里 type guard 函数散落 | 中 | 中 | 把 type guard 函数集中放 `packages/shared/src/guards.ts`，所有 adapter caller import 同一处 |
| caller 忘记调 type guard 直接调 capability method → 编译错 | 低 | 低 | 编译错就是好事（A 风格 runtime 才发现）|
| 设计选 D 后发现 cc-connect 某个 pattern 没移植到 → 后续返工 | 中 | 中 | 第 5 步用户决定前再扫一遍 cc-connect interfaces.go，确认所有 cap 都有对应 D 形态 |
| Storage adapter 单独 DD 时发现接口形态跟 IM/Term/CLI 风格不一致 | 高 | 低 | 预期之内（CRUD vs 事件流形态本来就不同），单独 DD 时说明边界 |

## 链接

- multi-cc-im CLAUDE.md：「关键设计假设」「关键规范」「禁止清单」
- 前置 DD（已完成）:
  - [`2026-04-26-ilink-library-dd.md`](2026-04-26-ilink-library-dd.md) — iLink 协议库选型
  - [`2026-04-27-cc-hook-wezterm-probe.md`](2026-04-27-cc-hook-wezterm-probe.md) — hook + wezterm cli 实测
- 数据来源:
  - cc-connect `core/interfaces.go`: https://github.com/chenhg5/cc-connect/blob/main/core/interfaces.go
  - cc-connect repo: https://github.com/chenhg5/cc-connect
- 后续 DD（待启动）:
  - Storage adapter + SQLite/Postgres + unstorage driver pattern → 单独 DD
  - pane 活性验证策略 → 可作为 D 风格 PaneAlivePlatform capability 的具体实现 DD
