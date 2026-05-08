# iLink LB IP Health-Probed Dispatcher DD 报告

**Topic**: 修 PR #69 retry 没真正解决的根因 — 腾讯 iLink LB 4 个 backend IP 中**至少 2 个完全不健康** (TCP/TLS 阶段直接 RST，5s timeout 后才 fail)。Node 全局 `fetch` (undici) 默认行为是 `dns.lookup` 取 single first IP，**没有 happy-eyeballs / IP-rotation fallback** —— 命中死 IP 就 hang。PR #69 的 retry 是症状治疗（每次 retry 命中健康 IP 是抽签）；真修法是 daemon 启动时 IP 健康度预探 + 周期 re-probe + custom undici Agent `connect.lookup` 强制只用 healthy IP。

**Scope**: 影响 `packages/im-wechat/lib/ilink/api/` —— 新增 `dispatcher.ts` 模块；`api.ts` `WeixinApiOptions` 加 `dispatcher` 字段；`apiPostFetch` / `apiGetFetch` 把 dispatcher 透传给 fetch。`packages/im-wechat/src/adapter.ts` 在 `start()` 创建 dispatcher + 传给 monitor + send，`stop()` 销毁。**不动**：cli-cc / bridge / shared / cc 协议层；不动其他 IM adapter（telegram / lark 还没 ship）。

**Date**: 2026-05-08
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 起源于 PR #69 (transient retry) merge 后用户跑诊断脚本：`curl --resolve` 4 个 LB IP 各打一次发现 `43.171.116.194` / `43.171.124.85` 完全连不通（5s timeout），`43.137.175.32` / `43.137.191.185` 健康；node fetch burst 10 次时前 7 次都 5s ECONNRESET 后续 3 次成功 —— 印证 undici 没 fallback 逻辑。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **d. Custom undici Agent + IP health probe + 周期 re-probe** | ✅ **推荐** |
| a. 不做（PR #69 retry 兜底） | ❌ — 每次抽签到死 IP 仍付 5s timeout × N retry |
| b. undici Agent `keepAliveMaxTimeout: 60_000` | ⚠️ — 一旦命中健康连接就长用；但**第一次还是抽签**，命中死 IP 仍 hang |
| c. Daemon 启动时 IP 健康度预探一次（不周期 re-probe） | ⚠️ — 健康度会变（腾讯 LB 修复 / 加新 backend），快照过期 |
| e. 自定义 DNS resolver (重写 dns.lookup 全局) | ❌ — 全局副作用 + 重；undici Agent connect.lookup 可单独配置不影响其他 fetch |
| f. 切到 undici `request` API 直接代替 fetch | ❌ — fetch API 面广，业务代码已用，迁移面大 |

---

## 1. 问题陈述

### 实测铁证

用户 2026-05-08 跑诊断脚本（PR #69 merge 后）：

**Test 1** — `curl --resolve` 强制每个 LB IP，POST `https://ilinkai.weixin.qq.com/ilink/bot/getupdates`:

```
43.137.175.32  → 200 OK (200ms)            ← 健康
43.137.191.185 → 200 OK (134ms)            ← 健康
43.171.116.194 → SSL_ERROR_SYSCALL, 5s     ← 死了
43.171.124.85  → SSL_ERROR_SYSCALL, 5s     ← 死了
```

**Test 2** — 固定 healthy IP burst 10 次：10/10 全 200 OK（排除 server-side anti-abuse 限速假设）。

**Test 3** — Node fetch 默认行为 burst 10 次（不 force IP）：

```
[0-6] 5s ECONNRESET   ← 命中死 IP，5s TLS handshake timeout 后 RST
[7]   219ms code=200  ← 切到健康 IP
[8-9] 140/37ms 200    ← keep-alive 复用健康 socket
```

### 根因

1. **腾讯 iLink LB 4 个 backend instance 中 2 个不健康**（这事我们改不了，腾讯运营问题）
2. **Node fetch (undici) 不实现 happy-eyeballs / IP-rotation fallback** — `dns.lookup` 默认取 single first result，命中死 IP 就 hang 5s 直到 OS-level TLS handshake timeout
3. **PR #69 transient retry 是症状治疗** — retry 时 undici 重新 connect，可能命中不同 IP（DNS resolution 重选），但**纯靠运气**，每次 retry 都付 5s 等待 + 重新挑

### 为什么 PR #69 retry 不够

retry 让大多数最终成功，但:
- 用户启动 daemon → 第一个 fetch 命中死 IP → 5s timeout → retry → ... → 总延迟 5-15s
- 长 idle 后 keep-alive 过期 → 第一个 fetch 重抽签 → 命中死 IP → 同上
- IM 用户在微信端体验：发消息几秒后才看到 echo，cc Stop forward 偶发延迟

### 为什么 retry 不能直接绑死 IP

retry 跑在 `apiPostFetch` 函数内部，它没法跟 undici Agent 的内部 socket pool / DNS cache 直接交互。改 retry 行为在错的层 —— 真改 layer 是 dispatcher。

---

## 2. 候选枚举

### a. 不做（PR #69 retry 兜底）

什么都不动；retry 兜底，用户接受偶发 5-15s 延迟。

### b. undici Agent `keepAliveMaxTimeout: 60_000`

```ts
const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
fetch(url, { dispatcher: agent });
```

一旦命中健康 socket 就长用 1 小时 —— 减少新 connect 次数。但：
- daemon 启动时第一个 fetch 仍抽签
- 健康 socket 也会偶发被对端 close（idle eviction），下次 connect 重抽签
- 不解决 4 个 IP 中 2 个死的本质

### c. Daemon 启动时 IP 健康度预探一次

```ts
// 启动时 dns.resolve4 + 并发 TCP probe → healthySet
// undici Agent connect.lookup 从 healthySet 轮询
// 没有周期 re-probe
```

启动后稳定。但：
- 腾讯 LB backend 健康度会变（运维修复 / 加新 IP）
- 健康集会过期（最多几小时后某些 IP 不再可达）
- 长跑 daemon（multi-cc-im 设计就是常驻）会受影响

### d. Custom undici Agent + IP health probe + 周期 re-probe ✅ 推荐

c 的演进 —— 加周期（5min）re-probe，让健康集自动跟随 LB 状态。

```ts
// 启动: dns.resolve4 → probe all → healthy/dead set
// undici Agent connect.lookup 从 healthy set 轮询
// setInterval(reprobe, 5 * 60_000) 周期重测：
//   - dead → 重测，可能转 healthy（后端修复）
//   - healthy → 重测，可能转 dead（后端挂掉）
// daemon stop → clearInterval + agent.close()
```

跟踪 LB 自适应、零 stale 风险。

### e. 自定义 DNS resolver (重写 dns.lookup 全局)

```ts
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
// or: monkey-patch dns.lookup
```

全局副作用 —— 影响整个 Node 进程的所有 DNS 查询，破坏 isolation。undici Agent `connect.lookup` 是 per-Agent 的更干净。

### f. 切到 undici `request` API 直接代替 fetch

vendored 业务代码已经全用 fetch。切换到 `request` 要把所有 `await fetch(...).then(r => r.text())` 改成 `await request(...).body.text()` —— 大面积改动，跟我们 vendored "minimal patch" 原则冲突。

---

## 3. 对比矩阵

| 维度 | a. 不做 | b. keepAliveMax | c. 启动一次 probe | **d. 周期 probe** | e. 全局 DNS | f. 切 request |
|---|---|---|---|---|---|---|
| 解决根因（避开死 IP）| ❌ | ⚠️ 部分 | ✅ 启动后 | ✅ 持续 | ✅ | ✅ |
| 长跑稳定 | ❌ | ⚠️ | ⚠️ 几小时后失效 | ✅ | ✅ | ✅ |
| 跟踪 LB 自适应（IP 起死回生）| n/a | n/a | ❌ | ✅ | ✅ | n/a |
| 全局副作用 | n/a | 无 | 无 | 无 | ❌ 影响所有 fetch | 无 |
| 改动面 | 0 | 1 行（new Agent + dispatcher 透传）| 中（probe + lifecycle） | 中（c + setInterval） | 1 行但全局 | 大（业务代码迁移） |
| 跟 vendored 原则冲突 | 不冲突 | 不冲突 | 不冲突 | 不冲突 | ⚠️ 副作用 | ❌ 全改 |
| 启动延迟 | 0 | 0 | +2s（probe 4 IP × 2s timeout 并发）| +2s | 0 | 0 |
| 测试面 | 0 | 1 个 | ~5 个 | ~7 个 | 难测全局 | 大量重写 |

### 关键差异点

**(c) vs (d)**: 唯一差异是 setInterval。`packages/im-wechat/lib/ilink/api/config-cache.ts` 已有「指数退避 retry」+ daemon-lifecycle setInterval 模式 —— 能 1:1 复用，不算新机制。开 5min interval 维护成本几乎为 0。**c 没法跟踪 LB 修复后 IP 起死回生** —— daemon 跑几天后 healthy set 可能从 4 → 2 → 0（全死了），fallback 到 retry 兜底，又退化回 PR #69 状态。

**(d) vs (e)**: `e` 用 `dns.setDefaultResultOrder` 全局 patch，影响 Node 进程内所有 fetch（包括 vendored CDN upload / 未来 telegram 的 fetch）。`d` 通过 undici `Agent.connect.lookup` 局限到一个 Agent 实例，干净的 isolation。

**(d) vs (f)**: `f` API 迁移是最大的改动（~30 处 fetch call → request call）。`d` 只是给 fetch 多传一个 `dispatcher` 字段，业务代码 + vendored 都不动。

### 否决候选

- **a. 不做** — 用户实测痛感明确（启动后 5-15s 阻塞）
- **b. keepAliveMax** — 只解决"命中健康 IP 之后稳"，没解决"第一次抽签到死 IP"
- **c. 启动 probe 一次** — 长跑场景下健康集过期
- **e. 全局 DNS** — 副作用面大
- **f. 切 request** — 改动量过大，跟 vendored minimal patch 原则冲突

---

## 4. 推荐：候选 d — Custom Agent + IP health probe + 周期 re-probe

理由可追溯到对比矩阵：

1. **修根因** [d ✅]: 强制只用 healthy IP，避免抽签到死 IP
2. **跟踪 LB 自适应** [d ✅ vs c ❌]: 5min re-probe 让健康集跟着 backend 实际状态变
3. **干净 isolation** [d ✅ vs e ❌]: undici Agent per-instance，不影响其他 fetch
4. **改动 minimal** [d ✅ vs f ❌]: 业务代码不动，只加 dispatcher 字段
5. **跟现有 lifecycle 模式一致**: `WeixinConfigManager` 已有 setInterval + adapter.stop() 清 timer 模式，复用

实施成本: ~150 行 dispatcher 模块 + ~30 行 adapter lifecycle + ~5 行 api.ts dispatcher 透传 + ~120 行 tests + ~50 行 docs。总 < 400 行。

---

## 5. 实施计划（PR-H）

### 5.1 新依赖

`packages/im-wechat/package.json` 加 `undici` 显式 dep（Node 22 自带 internal undici 但不暴露 module path）。

### 5.2 新模块: `packages/im-wechat/lib/ilink/api/dispatcher.ts`

```ts
import { Agent, type Dispatcher } from 'undici';
import dns from 'node:dns/promises';
import net from 'node:net';

export interface IPHealthProbedDispatcherOpts {
  hostname: string;          // e.g. 'ilinkai.weixin.qq.com'
  reprobeIntervalMs?: number; // default 5 * 60_000
  probeTimeoutMs?: number;    // default 2_000
  port?: number;              // default 443
  /** Test seam: override TCP probe with a custom function. */
  probe?: (ip: string) => Promise<boolean>;
  /** Test seam: override DNS resolution. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
}

export interface HealthProbedDispatcher {
  agent: Dispatcher;
  stop(): Promise<void>;
  /** For tests: trigger re-probe synchronously. */
  reprobeNow(): Promise<void>;
  /** Inspector — current sets. */
  snapshot(): { healthy: readonly string[]; dead: readonly string[] };
}

export async function createHealthProbedDispatcher(
  opts: IPHealthProbedDispatcherOpts,
): Promise<HealthProbedDispatcher>;
```

行为:
- 启动: `dns.resolve4(hostname)` 拿所有 IPv4 A records → 并发 TCP probe (port 443, 2s timeout) → 分 healthy/dead set
- 全部 dead 时: log warn + healthy = all (退化到默认 fetch 行为，靠 retry 兜底)
- undici `Agent({ connect: { lookup: customLookup } })` 配置：customLookup 从 healthy set round-robin
- `setInterval(reprobeAll, 5min)` 周期 re-probe (dead 重测可能复活；healthy 重测可能死掉)
- `stop()`: `clearInterval` + `agent.close()`

### 5.3 修改 `packages/im-wechat/lib/ilink/api/api.ts`

```diff
 export type WeixinApiOptions = {
   baseUrl: string;
   token?: string;
   timeoutMs?: number;
   longPollTimeoutMs?: number;
+  /** Optional undici Dispatcher (for IP health-probed routing). */
+  dispatcher?: Dispatcher;
 };

 // apiPostFetch / apiGetFetch:
   await fetch(url, {
     ...,
+    ...(params.dispatcher ? { dispatcher: params.dispatcher } : {}),
   });
```

每个公开 API 函数 (`getUpdates` / `sendMessage` / `getConfig` / `sendTyping` / `getUploadUrl`) 接 dispatcher 透传 给 `apiPostFetch` / `apiGetFetch`。

### 5.4 修改 `packages/im-wechat/src/adapter.ts`

```ts
async start(handler) {
  // ... existing resolveAccount + WeixinConfigManager ...
  
  // NEW: create health-probed dispatcher
  const url = new URL(account.baseUrl);
  this.dispatcher = await createHealthProbedDispatcher({
    hostname: url.hostname,
  });
  
  runMonitor({
    baseUrl: account.baseUrl,
    token: account.token,
    dispatcher: this.dispatcher.agent,  // pass through
    // ...
  });
}

async stop() {
  // ... existing cleanup ...
  await this.dispatcher?.stop();
}
```

`send / sendImage / sendFile / startTyping` 也都从 `this.dispatcher.agent` 取 dispatcher 传给 `sendMessageWeixin` 等。

### 5.5 修改 `packages/im-wechat/src/monitor.ts`

```ts
export interface MonitorOpts {
  // ...
  dispatcher?: Dispatcher;
}

// in runMonitor loop:
await getUpdates({ ..., dispatcher: opts.dispatcher });
```

### 5.6 测试

`packages/im-wechat/lib/ilink/api/dispatcher.test.ts` (~7 cases):

1. **Initial probe**: stub probe → 2 healthy + 2 dead → snapshot 正确
2. **All dead fallback**: stub probe 全 fail → snapshot.healthy = all IPs (degraded mode), warn logged
3. **Round-robin**: stub fetch with multiple sequential calls → 验证轮询命中不同 healthy IP
4. **Re-probe healthy**: dead IP 第二次 probe 返回 OK → snapshot 把它加进 healthy
5. **Re-probe dead**: healthy IP 第二次 probe 返回 fail → snapshot 把它移走
6. **stop() clears interval + closes agent**: 验证 stop 后 reprobeNow / agent 不再活动
7. **DNS resolve failure**: dns 抛错 → createHealthProbedDispatcher 抛错向上传

`packages/im-wechat/src/adapter.test.ts` 加 case codify:
- start() 创建 dispatcher
- stop() 销毁 dispatcher

### 5.7 docs 同步

- `docs/architecture.md`: 「iLink 网络韧性 (transient retry)」节加一段「+ IP health-probed dispatcher」描述层叠关系（dispatcher 减少触发 retry 的概率，retry 仍是 robustness 兜底）
- `CLAUDE.md`: 加一行 MANDATORY 规则「**iLink fetch 必须走 health-probed dispatcher**」防 future contributor 直接用 global fetch 绕开
- `README.md` / `README.zh-CN.md`: 启动延迟 mention（+~2s probe）

### 5.8 CI smoke

不影响（CI smoke 不实际打 iLink server）。

---

## 6. 风险 / 边界

1. **probe 自身可能不准**: TCP connect 成功不等于 TLS handshake + business logic 成功。但实测铁证显示死 IP 在 TLS handshake 阶段就 RST → TCP probe 也会拒绝；如果将来发现某 IP 「TCP OK 但 TLS RST」，可以升级 probe 到 TLS handshake 测试（用 `tls.connect`），但当前 TCP probe 够。

2. **启动延迟 +2s**: 4 IP × 并发 probe，2s timeout 上限 → 启动多 2s。可接受（一次性）。

3. **dispatcher fallback 全 dead 时退化**: 如果所有 IP probe 都失败（罕见，比如腾讯彻底挂了 / 用户网络断），healthy = all IPs，行为退化到默认 fetch（PR #69 retry 兜底）—— 不会比现状更糟。

4. **undici 版本兼容**: 用 `Agent({ connect: { lookup } })` API。Node 22 内置 undici 6.x，外部 install undici 8.x（兼容相同接口）—— 我们 `pnpm add undici` 装最新稳定，跟全局 fetch 不冲突（这里只用我们的 Agent，不动全局 dispatcher）。

5. **多账户场景**: v1 owner-only 单账户，未来 telegram / lark adapter 各自需要自己的 dispatcher（不共享 wechat 的）。dispatcher 是 per-adapter-instance 的，自然 isolated。

---

## 7. 锁定决策（待用户确认）

✅ **采纳候选 d**:

- 新增 `packages/im-wechat/lib/ilink/api/dispatcher.ts` 模块
- 启动时 `dns.resolve4` + 并发 TCP probe → healthy/dead sets
- undici `Agent` 自定义 `connect.lookup` 从 healthy set round-robin
- `setInterval(5min)` 周期 re-probe
- daemon stop 时清 interval + close agent
- `WeixinApiOptions` 加 `dispatcher?: Dispatcher` 字段，业务 API 透传
- adapter.start 创建 + adapter.stop 销毁

待用户审 → 锁定 → PR-H 实施。

---

## 8. CLAUDE.md 更新（实施时一起 commit）

「关键规范（MANDATORY）」加一行：

| 规范 | 备注 |
|---|---|
| **iLink fetch 必须走 health-probed dispatcher** | `apiPostFetch` / `apiGetFetch` 通过 `WeixinApiOptions.dispatcher` 走 `createHealthProbedDispatcher()`；adapter 启动时创建 + 周期 re-probe + stop 时销毁。**禁止直接用 global fetch** 绕开 dispatcher（[DD: iLink dispatcher health probe](docs/superpowers/specs/2026-05-08-ilink-dispatcher-health-probe-dd.md)）|
