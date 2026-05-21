# DD: lark WS zombie connection detection — attach close listener on underlying wsInstance

> 状态: ✅ LOCKED 2026-05-21 — A path（监听底层 ws close 事件）
> 触发: 真实 bug — 笔记本合盖 → 开盖后 daemon 不响应 IM，需手动重启
> 关联: PR #172（autoReconnect:false 自管 retry loop）

---

## §0 现状（grep 实证 2026-05-21）

| 维度 | 事实 |
|---|---|
| adapter 配置 | `autoReconnect: false`（PR #172 改），自管 1s retry + 10 失败 5s 冷却 |
| 失败信号通道 | 仅 SDK `onError` callback —— 当 SDK 内部 reConnect 因 autoReconnect:false silent return 时**不 fire** |
| sleep/wake 实测 | 08:41 → 11:36 daemon.log IM 入站全静默，但 cc Stop 出站仍工作 → WS half-open zombie |
| SDK 内部 | `wsInstance.on('close') → this.reConnect() → autoReconnect:false 且 hasEverConnected=true → silent return` (SDK L85525-85533) |
| daemon 唯一恢复方式 | 用户手动重启 |

**根因不变量**: SDK 把「socket close」事件吃掉了；我们的 retry loop 没拿到任何信号 → 永不启动。

---

## §1 候选枚举（4 个 — 含「不做 X」+ 显式不可行）

| 候选 | 1 句话 |
|---|---|
| **A** 监听底层 wsInstance close 事件（推荐）| `(wsClient as any).wsConfig.getWSInstance().on('close', scheduleRetry)` — TS private 绕过，触发现有 retry loop |
| **B** 换 `autoReconnect: true` | SDK 自管所有重连，但 `reconnectInterval` 由飞书 server config 决定（默认 120s），慢且不可控 |
| **C** 应用层入站静默看门狗 | `setInterval` 监测「上次收到任何 IM 入站 > N min」→ 推测死 → reconnect | 间接，真闲时误判 |
| **D** fork SDK | 改源码改默认 autoReconnect 或暴露 close hook | 维护负担最重 |

---

## §2 每候选尽调

### A — 监听底层 close（推荐）

| 维度 | 说明 |
|---|---|
| 信号准确度 | 100%（任何 TCP close 立刻触发）|
| 复用 retry loop | ✅ 直接调现有 `scheduleRetry()` |
| TS-private 风险 | `.d.ts` 标 wsConfig private，但 JS runtime 无强制；`as any` 一行绕过 |
| SDK 升级风险 | wsConfig / getWSInstance 字段被改名或真私有化（`#field`）→ 我们代码失效 |
| 风险减缓 | 单测验「能从 wsClient 拿到 wsInstance」+ pin SDK 版本 + log 一行 if 拿不到 → fallback 仍按现行行为 |
| 工程量 | ~0.5 天（adapter 改 ~15 行 + 单测 + 真账号 sleep/wake smoke） |

### B — autoReconnect:true

| 维度 | 说明 |
|---|---|
| 一致性 | SDK 触发链统一 |
| 间隔 | server 给的 `ClientConfig.ReconnectInterval`（实测中国服务器历史 4 分钟级慢 backoff）|
| 跟 PR #172 trade-off | 牺牲首次连快 retry — 回归 PR #172 修过的问题 |
| 不可控 | 没有 server side override 入口 |
| 排除 | 用户明示「失败就重连基本逻辑没时间限制」— 慢 backoff 跟该诉求矛盾 |

### C — 入站静默看门狗

| 维度 | 说明 |
|---|---|
| 信号间接 | 「闲」跟「死」分不清；半夜没人发消息 ≠ daemon 死 |
| 误判风险 | 真静默时间会触发误 reconnect → 浪费 + 可能掩盖真 bug |
| 排除 | 不准 |

### D — fork SDK

| 维度 | 说明 |
|---|---|
| 维护成本 | 长期 carry fork；每次 SDK 升要 rebase |
| 跟「用现有 SDK 不造轮子」CLAUDE.md 原则冲突 | ❌ |
| 排除 | 工程负担 |

---

## §3 对比矩阵

| 维度 | **A 监听 close ⭐** | B autoReconnect:true | C 静默看门狗 | D fork SDK |
|---|---|---|---|---|
| 探测准确度 | 100% | 100% (但慢) | ⚠️ 误判 | 100% |
| 触发延迟 | <100ms | ~120s+ | min 级 | <100ms |
| 复用现有 retry loop | ✅ 1s 快重试 | ❌（用 SDK loop）| ✅ | ✅ |
| 一致性（一种模式）| ✅ close → retry | ✅ SDK 全管 | ⚠️ 两套 | ✅ |
| 工程量 | 0.5 天 | 1 行 | 1 天 | 3+ 天 |
| 长期风险 | SDK 升级可能改 wsConfig | 0 | 误判调参 | fork 维护 |
| 跟 CLAUDE.md「用现有 SDK 不造轮子」 | ✅ | ✅ | ✅ | ❌ |
| Source verified | SDK 源码 L85295 wsConfig.getWSInstance + L85296 setWSInstance | SDK 源码 L85393 autoReconnect default true | N/A | N/A |

---

## §4 推荐 = A，用户拍板

| 理由 | 证据 |
|---|---|
| 信号准确 + 触发快 | 矩阵 1+2 行 |
| 复用现有 1s retry loop（PR #172 投资保留）| 矩阵 3 行 |
| 一种模式 universal — 「close → retry」全场景统一 | §1 表 |
| 用户原诉求「失败就重连，没时间限制」匹配 | 用户原话 |
| 工程量小 + 风险已缓解 | 矩阵 5+6 行 |

**Tradeoffs A 接受**:

| Trade-off | 接受理由 |
|---|---|
| TS-private 绕过 | SDK 源码 verify `wsConfig.getWSInstance()` 是真 public method；只是 `.d.ts` 把 wsConfig 字段标 private（封装意图，非真私有）。`as any` 是 TS 工程实践常见的边界 escape hatch |
| SDK 升级可能改 wsConfig 字段名 | 单测兜底 — 升级时单测先红；defensive code log 一行 if 拿不到 wsInstance + fallback 现行行为（不崩，只是退化）|
| 不通过 SDK upstream PR fix | upstream PR 周期长（4-8 weeks 飞书 review），现在用户每天遭遇；A 是 in-tree 立即可用 |

---

## §5 实施 task table

| # | 改动 | 文件 |
|---|---|---|
| 1 | onReady callback 加 `attachCloseDetector()`：拿 wsInstance + `on('close', scheduleRetry)` | `packages/im-lark/src/adapter.ts` |
| 2 | defensive：拿不到 wsInstance 时 log 一行 + skip（不崩）| 同上 |
| 3 | stopRequested guard：stop() 后 close 不触发 retry | 同上 |
| 4 | 单测：mock wsClient.wsConfig.getWSInstance() 返 EventEmitter；fire close → 验 scheduleRetry 被调 | adapter.test.ts |
| 5 | 单测：mock 返 null/undefined → 验 fallback 不崩 | 同上 |
| 6 | 4 维 verify（typecheck + test + build + bin smoke）| Bash |
| 7 | commit + push + PR | Bash |
| 8 | 真账号 sleep/wake smoke（post-merge）：daemon 跑 → 合盖 N 分钟 → 开盖 → 看 daemon.log `WS close detected` + `WS reconnected` | post-merge |
| 9 | conventions.md milestone entry | docs/conventions.md |
| 10 | release v0.1.6 | Bash |
