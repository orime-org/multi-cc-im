# DD: cc 监控 dashboard (web)

**日期**: 2026-05-15  
**状态**: LOCKED  
**作者**: 用户 + AI 协作 DD  
**前置**: v0.1.0 release（iTerm2 适配 + 真账号 smoke 全链路验证 OK）

---

## 0. 问题陈述

用户用 multi-cc-im 同时跑多个 cc tab，光看 IM forward 不够直观感知 daemon 是不是健康、cc 实例是不是活、token 是不是花得失控。需要一个**监控 surface**：

- daemon 启动时打印 URL（如 `http://localhost:40719`）
- 用户随时点开浏览器看「daemon 当下生命体征」
- 输出 dashboard 不影响 daemon 正常工作

属于「重大决策」（CLAUDE.md DD 触发条件）：
- 引 web server 新组件 → 长期维护负担
- 引数据持久化候选 → 影响 v1「不引 SQL DB」约束
- 跨包接口 → 新 `packages/monitor/` 加进 monorepo
- 反悔代价 > 1 周（拆下来涉及 deps / wiring / docs）

---

## 1. 候选枚举（含「不做 X」）

每维度都先列「不做」作 baseline。

### 维度 A — Web 框架

| ID | 候选 | Essence |
|---|---|---|
| A0 | **不做 X**：CLI 子命令 `multi-cc-im stats` | 砍 web，每次终端跑 CLI 看 |
| A1 | Node 原生 `http.createServer` | 0 dep，~50 行手写 router；无中间件 |
| A2 | **hono** (npm) | 30KB，Node 22 fetch-based，TS-first，内置 JSX SSR |
| A3 | fastify | 成熟，>500KB+，>10MB transitive deps |
| A4 | express | commonjs，跟 ESM project 摩擦 |

### 维度 B — 数据持久化

| ID | 候选 | Essence |
|---|---|---|
| B0 | **不做 X / 纯内存** | 重启清零，无文件写入 |
| B1 | JSONL append-only + tail 加载 | file-based，符合 v1 不引 SQL |
| B2 | SQLite (`better-sqlite3`) | 真 query 但违反「v1 不引 SQL DB」 |
| B3 | NDJSON + bucket files（按小时） | tail 快，v1-compatible |
| B4 | 内存 ring + 定时 flush JSONL | hybrid |

### 维度 C — 前端渲染

| ID | 候选 | Essence |
|---|---|---|
| C0 | **不做 X**：JSON only，curl+jq | 砍 dashboard |
| C1 | hono JSX SSR + `<meta refresh="5">` | 0 build / 0 client JS / 5s 全页刷 |
| C2 | C1 + 客户端 polling JS | 局部更新 |
| C3 | WebSocket push | 实时但 +ws dep + 重连逻辑 |
| C4 | 完整 SPA (React/Vue + bundler) | 重，monorepo build 工具链冲突 |
| C5 | C2 + chart 库 (uPlot) | 时序趋势用 |
| C6 | SSE (server-sent events) | 单向推，比 WS 简单一档 |
| C7a | hono JSX SSR + alpinejs 浏览器端 | SPA-feel 0 build step |
| C7b | hono + htmx | HTML attribute 驱动局部更新 |
| C7c | 真全栈框架 (SvelteKit / SolidStart / Astro) | 重 build 链 |

### 维度 D — Port 策略

| ID | 候选 | Essence |
|---|---|---|
| D0 | **不做 X**: unix socket / 走 IM 指令 | 砍 web |
| D1 | 固定 port | 简单；冲突时 daemon fail |
| D2 | config.toml `[monitor].port` | 用户可改；首次默认值仍要选 |
| D3 | OS 分配空 port (`listen(0)`) | 0 冲突；URL 每次变 |
| D4 | preferred port → fallback 空 port + 警告 | 友好 + 防冲突 |

---

## 2. 尽调（证据导向）

### A — hono 4.12.18

- `pnpm view hono`：
  - `license: MIT`
  - `version: 4.12.18`
  - `exports['.']` 含 `import: './dist/index.js'`（ESM 原生）
  - `exports['./jsx']` 含 `import: './dist/jsx/index.js'`（**内置 JSX SSR**，无需额外包）
- `@hono/node-server` 2.0.2 / MIT：
  - `dist/index.mjs` ESM
  - 把 hono app 跑在 Node `http.Server` 上的 adapter

### B — 内存只读够不够

砍「流量计数器累计」+「时序数据 + 历史趋势」后剩下：
- 实时状态：从 listPanes / process.pid 即时拿（0 持久化）
- 错误 rolling buffer：内存 N=200（重启清零接受）
- per-cc cost：tail cc 自己的 `~/.claude/projects/<slug>/<sid>.jsonl` 按需算（数据已在那）

→ B0 纯内存够。0 文件写入，0 schema 设计成本。

### C — JSX SSR + meta refresh 够不够

dashboard 数据密度：
- ~5-10 行 session table
- ~10-30 行 error rolling
- ~3-5 行 per-cc cost

`<meta http-equiv="refresh" content="5">` 每 5 秒整页刷，用户「扫一眼」型使用场景接受 flicker。Dashboard 复杂度从 hello world 起步，不需 SPA。

### D — port 40719

- 用户拍板（纪念意义 04-07-19）
- `lsof -nP -iTCP:40719` 实测空闲
- 一台机器一个 daemon（CLAUDE.md 多机约束）→ 固定 port 唯一冲突来源是其他进程偶然占用

### 数据源 — cc transcript jsonl

- 路径实测：`~/.claude/projects/<slug>/<sid>.jsonl`
- `usage` 字段实测 schema (`grep -o '"usage":{...}' *.jsonl`):
  ```
  {
    "input_tokens": 9,
    "cache_creation_input_tokens": 18296,  ← flat 单数字（cc 升级后 schema 简化）
    "cache_read_input_tokens": 32116,
    "output_tokens": 2818,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    }
  }
  ```
- `service_tier` 字段在部分 jsonl 中出现（同样跨 session 不一致）

⚠️ **drive-by 发现**：`docs/conventions.md` 「/usage /cost 计算（v2 deferred）」段记的字段 `cache_creation.ephemeral_5m_input_tokens / .ephemeral_1h_input_tokens` 是早期 cc 版本，**实测 jsonl 已合并成 flat `cache_creation_input_tokens` 单数字**。同发现 LiteLLM 价格表也是 flat。conventions 那段过期，单独 follow-up 修。

### 价格表 — LiteLLM Claude 子集

- `https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json` 200 OK
- claude 4.x model 共 110 keys
- 单价字段齐：
  - `input_cost_per_token` = 1.5e-05
  - `output_cost_per_token` = 7.5e-05
  - `cache_read_input_token_cost` = 1.5e-06
  - `cache_creation_input_token_cost` = 1.875e-05（**flat 单价**，跟实测 jsonl 一致）

→ 内置价格表（fetch 一次 freeze 进 const）。月级别更新不重要。

---

## 3. 对比矩阵

| 维度 | 推荐 | vs 备选 |
|---|---|---|
| A | **A2 hono** | A0 砍 surface 不满足需求；A1 0 dep 但 router 手写 50 行；A3 fastify 重；A4 express commonjs |
| B | **B0 纯内存** | 砍历史趋势后无持久化需求；B1-B4 全是 over-engineering |
| C | **C1 SSR + meta refresh** | C2-C7 都为「频繁更新」场景；用户扫一眼型使用，全页刷可接受；C4/C7c 全栈框架 build 链冲突 monorepo |
| D | **D1 40719 固定** | 用户拍板；多机约束下唯一冲突源是别的进程偶然占；接受 daemon 启动失败回报 |

---

## 4. 推荐 + 实施 outline

### 包结构

```
packages/monitor/
├── package.json           # name: @multi-cc-im/monitor
├── tsconfig.json
└── src/
    ├── index.ts           # createMonitorApp(opts) → hono app + start()
    ├── metrics.ts         # 内存 ring buffer (error log) + state aggregator
    ├── cost.ts            # cc jsonl tail + 价格表查询
    ├── prices.ts          # 内置 LiteLLM claude 4.x 价格表 (frozen const)
    └── views/             # JSX SSR 组件
        ├── layout.tsx     # <html><head>...refresh meta...</head><body>...</body>
        ├── dashboard.tsx  # 顶层组件 (compose 下面 4 个)
        ├── daemon-state.tsx
        ├── sessions-table.tsx
        ├── errors-table.tsx
        └── cost-table.tsx
```

### 接口

```ts
// 主入口
export interface MonitorOpts {
  port: number;                    // default 40719
  log: (line: string) => void;     // hook into daemon 的 log
  // metrics 数据源：
  getDaemonState(): DaemonStateSnapshot;
  getSessions(): Promise<SessionSnapshot[]>;
  errorBuffer: ErrorRingBuffer;    // shared ref，daemon onError 写
}

export function createMonitorApp(opts: MonitorOpts): {
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
};
```

### Wiring

`apps/multi-cc-im/src/start.ts` 改：
1. 创建 `ErrorRingBuffer({ capacity: 200 })`
2. 在 onError 回调里 push 一条
3. `monitor = createMonitorApp({ port: 40719, log, getDaemonState, getSessions: () => termAdapter.listPanes(), errorBuffer })`
4. `monitor.start()` → log "✓ monitor dashboard: http://localhost:40719"
5. shutdown 路径加 `monitor.stop()`

### 新 deps

`apps/multi-cc-im/package.json`:
- `hono@^4.12`
- `@hono/node-server@^2.0`

`packages/monitor/package.json`:
- `hono@^4.12`（peer / direct）
- `@multi-cc-im/shared@workspace:*`

### 路由

| GET path | 返 | 内容 |
|---|---|---|
| `/` | HTML | dashboard SSR 整页 |
| `/api/state` | JSON | daemon + sessions snapshot |
| `/api/errors` | JSON | error ring buffer |
| `/api/cost` | JSON | per-session cost aggregate |
| `/health` | text "OK" | liveness check |

### 测试

- `metrics.test.ts`：ErrorRingBuffer 容量 / FIFO 行为
- `cost.test.ts`：parse jsonl mock + 算 USD（fixture 喂 sample jsonl）
- `prices.test.ts`：内置价格表完整性 + 价格匹配
- `index.test.ts`：hono app routes 各路径 status 200 + 返 JSON shape

### Verify

- `pnpm install --frozen-lockfile`（新 deps → 第一次 fail，install 完再跑 frozen 验证 lockfile 同步）
- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter multi-cc-im build` + `./bin/multi-cc-im --version`

---

## 5. 用户拍板

✅ A2 hono / B0 纯内存 / C1 SSR + meta refresh 5s / D1 port 40719 / 错误 buffer N=200。  
✅ 实施 outline 按上面 §4 落地。

**Drive-by 不在本 DD 范围**（单独 follow-up）:
- conventions.md 「/usage /cost 计算」段过期字段 (`cache_creation.ephemeral_5m/1h`) → 改 flat `cache_creation_input_tokens`

---

## 6. 修订 2026-05-15 — 手动刷新 + CSS tabs

PR #187 实施落地后用户跑真实 dashboard 反馈：「上方需要三个 tab 标签切换。现在太丑了」+「不用 [meta refresh]。我希望前端靠用户手动刷新看最新数据」。

**修订项**：

| 原 §4 决策 | 撤销 | 新决策 |
|---|---|---|
| C1 SSR + `<meta http-equiv="refresh" content="5">` 5 秒整页刷一次 | ❌ | **C1' SSR + 手动刷新**：删 meta refresh；页面顶 `↻ refresh` 按钮 `<a href="/">` 触发整页 reload；用户 F5 / Cmd+R 同效；数据新鲜度由用户主动操作触发 |
| 单页堆叠 sessions / cost / errors 三 section | ❌ | **3-tab 布局**：sessions / cost / errors 各一 tab；daemon state 留顶 sticky header（4 个字段 KV pills 横排，始终可见）；CSS-only 切换（`<input type="radio">` + `:checked ~ .panel` sibling combinator hack，no client JS） |

**没改的**：A2 hono / B0 纯内存 / D1 port 40719 / 错误 buffer N=200 / vendored LiteLLM 价格表 — 全部保持。

**理由**：
- meta refresh 每 5 秒整页 reload 在 dashboard 长时间打开时眼睛累 + 网络 round-trip / fetch 浪费（本地无所谓但不优雅）；用户实际「扫一眼 → 关掉」usage pattern 不需要 5s 自动刷
- 堆叠 3 个长表格列在一页（12 sessions / 21 costs / 0 errors）视觉重 + 重要信息（daemon state）容易被往下滑出视野
- CSS radio hack 是 SSR 项目里业界公认 progressive enhancement 模式（MDN / web.dev 都背书），no client JS 契约不破；坏处是 reload 回 default tab（sessions）— 接受，符合「手动刷 = 整页重置」直觉
- Tab 状态 lives in DOM radio inputs，刷新前 active tab 体现在 `:checked` 上 — 切 tab 零网络成本 + 零 latency

**为什么不需要重走 5 步 DD**：
- 用户在 PR #187 真实使用反馈上当场拍板修订（"不用 meta refresh"）
- 修订项仅替换 C 维度内一个 sub-decision（5s auto-refresh vs manual refresh）+ 新增视觉布局优化（tab 切分），不动 A / B / D 任何主决策
- 候选空间小（手动刷 vs auto-refresh 二选一；tab 实现 a/b/c 三选一推荐 a 后用户未否定）+ 反悔代价低（纯前端 css/jsx 改动 < 1 天）→ 不达"重大决策"启发式阈值

**实施落地**（同 PR）：
- `views/layout.tsx` 删 `refreshSeconds` prop + `<meta refresh>` tag；加 tab CSS（radio hidden / sibling-checked panel show/hide / sticky `.daemon-header`）
- `views/dashboard.tsx` 重排：sticky header + `↻ refresh` 按钮 + 3-radio + tab-nav + 3-panel；default checked = `tab-sessions`
- `views/daemon-state.tsx` 改从 4-row table → 单行 KV pills（`pid · uptime · terminal · IM (lark) [connected pill]`）
- `index.test.ts` 改既有 GET / 断言 `not.toContain('meta http-equiv="refresh"')` + 必含 `↻ refresh`；加新 case 验证 3 radio + 3 label + 3 panel 全在 + default checked = sessions

**Test/build**：1012/1012 pass (+1 tab test)，bundle 425 KB，bin smoke `0.1.0`。
