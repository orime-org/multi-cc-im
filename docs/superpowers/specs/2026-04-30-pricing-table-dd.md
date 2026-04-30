# 价格表来源 DD 报告

**Topic**: multi-cc-im 项目 `/cost` 命令计算 USD 成本时，Anthropic Claude API 价格数据从哪来 + 怎么落地
**Date**: 2026-04-30
**Status**: ✅ 已锁定
**结论**: 选定 **G 组合方案**：vendor LiteLLM JSON 的 Claude 子集快照（`packages/analytics/data/prices.json`，~4KB）+ `scripts/sync-prices.sh` 周期同步上游 + 用户 `config.toml` 的 `[pricing]` section 可 override（应对 LiteLLM 漏字段或 Anthropic 新模型未及时录入的情况）。

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走完。此 DD 触发的启发式：「跨包接口 / 共享类型」（analytics 包 + storage-files [pricing] section）+「影响长期维护负担」（需要持续跟踪 Anthropic 价格变化）。

---

## 第 1 步：候选枚举

按 CLAUDE.md「反 DD 模式」"跳过候选枚举只列 2-3 个 → 假对比" + memory「DD 候选枚举必须含'不做 X'」，本 DD 穷举：

| ID | 候选 | 描述 |
|---|---|---|
| **A** | **不做 `/cost` feature** | 仅 `/usage` 显示 token 数，不算 USD（避开整个问题） |
| B | Hardcoded JSON in repo | 自维护 `prices.json`，Anthropic 调价时手 PR 更新 |
| C | Anthropic 官方 pricing API | 启动时拉，缓存到本地 |
| D | LiteLLM `model_prices_and_context_window.json` | 直接 fetch / vendor 大表 |
| E1 | npm `tokencost` | 客户端 token 计数 + 价格估算 |
| E2 | npm `claude-cost` | Claude Code cost analytics TUI |
| E3 | npm `@anthropic-ai/tokenizer` | 官方 tokenizer |
| F | 用户 `config.toml [pricing]` 段 | 用户手维护 |
| **G** | **vendor LiteLLM Claude 子集快照 + 用户 config.toml override** | 组合方案 |

进 DD 第 2-4 步：A / B / D / G 四个真候选。

**透明排除（基于实证筛掉，不进对比矩阵）**:

| 候选 | 排除理由（含可验证证据） |
|---|---|
| **C (Anthropic 官方 API)** | `curl https://docs.anthropic.com/en/docs/about-claude/pricing` 返回 HTTP 000（连接级失败 / 至少在我们的网络位置不可达）；Anthropic 官方文档站没有发现 machine-readable pricing endpoint；只能 HTML 抓页面（违反「local-first」+ 网络脆性高）。**复议时机**: Anthropic 未来若发布 pricing API，可再做一轮 DD |
| **E1 tokencost** | npm 实查：v0.1.11，**最后 publish 2024-10-02（>1.5 年前）**；Claude 4 系列（2025 才发）肯定缺；ISC license OK 但**数据 stale 到不可用** |
| **E2 claude-cost** | npm 实查：v1.0.4，依赖 react/ink/chalk —— **是 TUI 工具不是库**，没暴露 pricing 数据的 programmatic API |
| **E3 @anthropic-ai/tokenizer** | npm 实查：v0.0.4 —— **只 tokenizer 不含 pricing** |
| **F 单独**（仅 user config.toml）| 把价格维护成本完全推给用户；多 model 全维护就要 hand-write 几十条记录；Anthropic 调价用户需要手追。**作为 G 的子组件保留**（override 路径），不作单独方案 |

---

## 第 2 步：5 维度尽调（A / B / D / G）

### 5 维度

| 维度 | 含义 |
|---|---|
| **数据新鲜度** | Anthropic 调价后多久能让用户拿到正确价格 |
| **5 价格维度覆盖** | model × service_tier × cache TTL（5m/1h）× direction（in/out/cache_read/cache_create） |
| **更新机制复杂度** | 谁维护、断网时怎么办、失败模式 |
| **runtime 网络依赖** | multi-cc-im 启动 / 跑 `/cost` 是否需要网络（local-first 硬约束） |
| **license / attribution** | 第三方数据合规性 |

### 候选 A：不做 `/cost` feature

| 维度 | 评估 |
|---|---|
| 数据新鲜度 | N/A |
| 5 维度覆盖 | N/A |
| 更新机制 | N/A |
| runtime 网络 | 0 |
| license | 无 |

**决定性事实**: multi-cc-im 项目简介（CLAUDE.md `项目简介`）明确"cc 用量分析"是核心 feature。`/cost` 是"用量分析"的关键产出。**A 跟项目锁定的 vision 冲突**，作为 DD 形式合规列入但实际不成立。

### 候选 B：Hardcoded JSON in repo（手维护）

| 维度 | 评估 |
|---|---|
| 数据新鲜度 | **差**——依赖维护者主动追 Anthropic 价格变化，单人项目 v0 阶段不现实 |
| 5 维度覆盖 | 取决于手写完整度；可控 |
| 更新机制 | PR 改 JSON。Anthropic 调价没监控信号 → 价格永远 stale |
| runtime 网络 | 0 |
| license | 自有 |

### 候选 D：LiteLLM JSON（fetch 或 vendor 全表）

实证数据（`curl https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json`）:

- 文件 1.41 MB，2690 entries，249 个 Claude 系列
- 直接 API（非 bedrock）`claude-*` keys: 21 个
- 字段完整度（实测 `claude-opus-4-7-20260416`）:
  ```
  input_cost_per_token: 5e-06
  output_cost_per_token: 2.5e-05
  cache_read_input_token_cost: 5e-07
  cache_creation_input_token_cost: 6.25e-06          # 5m 默认
  cache_creation_input_token_cost_above_1hr: 1e-05    # 1hr tier ✓
  cache_creation_input_token_cost_above_200k_tokens   # 200k+ context tier
  output_cost_per_token_above_200k_tokens             # 同上
  output_cost_per_token_batches                       # batch API tier
  ```
  → **5m vs 1h cache TTL 分级 LiteLLM 已支持**（早先担心是错的，撤回）

- License: MIT（`curl https://raw.githubusercontent.com/BerriAI/litellm/main/LICENSE` 实读：non-enterprise 部分 MIT，pricing JSON 在 `litellm/` 不在 `enterprise/`，所以 MIT）
- 维护活跃: ★45285，2026-04-30 当天 (`gh api /commits` 实读) **多次 commit**，最近 commit 距今 < 1 小时
- 2024-04 - 2026-04 持续更新 model_prices JSON

| 维度 | 评估 |
|---|---|
| 数据新鲜度 | **优秀**（每天多次 commit；新 Anthropic 模型通常几小时内入库） |
| 5 维度覆盖 | 高（model + cache TTL 5m/1h + 200k tier + batch tier 都有；service_tier "priority" 可能在 `provider_specific_entry: {fast: 6.0}` 但**未确认**——见风险表）|
| 更新机制 | 自动 PR，社区驱动 |
| runtime 网络 | 启动时拉 → **违反 local-first**；vendor 快照避免 |
| license | MIT ✓ |

### 候选 G：LiteLLM 子集 vendor + user config.toml override（推荐）

实施形式（落地步骤见「实施清单」）:

```
packages/analytics/data/prices.json     # vendor 自 LiteLLM，过滤到 claude-* 21 entries (~4KB)
scripts/sync-prices.sh                  # fetch LiteLLM JSON → 过滤 claude-* → atomic write
~/.multi-cc-im/config.toml              # [pricing] section override（用户漏字段补充 / 修错）
packages/analytics/src/pricing.ts       # load order: shipped → user override (后者赢)
```

| 维度 | 评估 |
|---|---|
| 数据新鲜度 | shipped 快照 = 上次 sync 时间（建议每 1-2 周跑 sync 脚本）；用户 override 即时 |
| 5 维度覆盖 | 继承 LiteLLM 的所有维度 + 用户可补漏（含未确认的 priority tier）|
| 更新机制 | sync 脚本（手 / GitHub Actions cron 调用）+ user override |
| runtime 网络 | **0**（local-first 保留）|
| license | MIT（vendor 时附 ATTRIBUTION + LiteLLM 链接） |

---

## 第 3 步：对比矩阵

| 维度 | A: 不做 | B: Hardcoded | D: LiteLLM 全表 | **G: vendor 子集 + override** |
|---|---|---|---|---|
| 跟 vision 一致 | ❌（项目锁定 cost feature） | ✓ | ✓ | ✓ |
| 数据新鲜度 | N/A | ❌ stale 风险高 | ✅ 每天更新 | ✅ sync 周期 + override 兜底 |
| 5 维度覆盖完整 | N/A | ⚠️ 看维护质量 | ✅ 全（含 200k+1h tier） | ✅ 全 + override |
| local-first | ✅ | ✅ | ❌ 启动 fetch | ✅ 快照不联网 |
| 维护成本 | 0 | 高（人工追价） | 0（社区驱动） | 低（sync 自动 + override 兜底） |
| 失败模式 | N/A | 价格越来越偏离实际 | 网络抖动启动失败 | snapshot 旧不影响启动；用户随时 override |
| license | N/A | 自有 | MIT | MIT + ATTRIBUTION |
| 实施复杂度 | -∞ | 中（手维护） | 低（fetch + parse） | 中（sync 脚本 + override 合并逻辑） |

---

## 第 4 步：推荐 + 理由

**推荐 G**。每条理由可追溯到矩阵：

1. **G 唯一 local-first 不破** + 数据新鲜度可接受（矩阵第 4 行）
   - D 启动 fetch 直接违反 CLAUDE.md「关键规范」"local-first 不上传任何外部服务"——含外部 GET 是单向但风险面：网络抖动 / GitHub 限流 / DNS 劫持。
   - 单纯 vendor（D 的 vendor 变种）无 override → snapshot stale 时用户束手无策。
   - G 同时解决两个问题：vendor → 0 网络依赖；override → 用户能修。

2. **G 的数据来源是 D（LiteLLM）+ user override**，而 D 的实证数据完整（矩阵第 3 行）
   - LiteLLM 实测有 cache 5m/1h split + 200k tier + batch tier
   - LiteLLM 是社区驱动的"价格信源"自动化（每天多次 commit），multi-cc-im 单人项目 v0 阶段没人力跟 Anthropic 价格

3. **vendor 子集（21 entries / ~4KB）远比全表（2690 entries / 1.4MB）合理**
   - multi-cc-im 只用 Anthropic 直连模型（v1 目标）
   - bedrock / azure / openrouter 的 Claude 别名跟 multi-cc-im 无关
   - 控制 bundle size + 排除噪音字段

4. **跟 iLink 协议库 DD 的 vendor 模式同构**（CLAUDE.md「关键规范」"用现有 SDK 不造轮子" 精神）
   - iLink DD 选 vendor `Tencent/openclaw-weixin` 子集到 `packages/im-wechat/lib/ilink/` + sync 脚本
   - 本 DD 选 vendor LiteLLM 子集到 `packages/analytics/data/prices.json` + sync 脚本
   - 同套**抽取 + 同步**模式

5. **override 是 `local-first + vendor 模式` 的必备 escape hatch**
   - LiteLLM 漏字段（如 priority tier 的 `provider_specific_entry: {fast: 6.0}` 含义未确认）
   - Anthropic 紧急调价但 LiteLLM 未及时更新
   - 用户用过自己 patch 的 endpoint（如 OpenRouter）
   - `[pricing.<model_id>]` 覆盖任意字段，用户修改即时生效

**排除 A 的核心理由**：跟项目锁定 vision 冲突（CLAUDE.md `项目简介` "cc 用量分析" feature 写明）。

**排除 B 的核心理由**：单人项目 v0 阶段无可持续机制追 Anthropic 价格变化；LiteLLM 是替代社区维护，已有 45285★ 力量做这件事，自己重做 = 重复造轮子（违反 CLAUDE.md「核心约束」#2）。

**排除 D 的核心理由**：runtime 网络依赖违反 local-first 硬规范；vendor 又没 override 路径 → 没法应对未确认 / stale 数据。G 是 D 的"local-first + 兜底"加强版。

---

## 第 5 步：用户决定

**用户拍板**: 接受推荐 G（vendor LiteLLM Claude 子集快照 + `scripts/sync-prices.sh` 周期同步 + `config.toml [pricing]` user override）
**锁定时间**: 2026-04-30
**依据**: 本 DD 报告 + LiteLLM 字段实证（cache 5m/1h split + 200k tier + batch tier 都已支持）+ 排除 A/B/C/D/E1/E2/E3 的实证证据（A vision 冲突 / B 维护成本 / C 不存在 / D 违反 local-first / E1 stale / E2 是 TUI / E3 仅 tokenizer）+ 跟 iLink 协议库 DD 的 vendor 模式同构。

后续动作:
1. 写入 CLAUDE.md「关键设计假设」表「价格表来源」行 ? → ✓（本 PR 同步）
2. v1 analytics 实施时按「实施清单」启动（vendor 子集 + sync 脚本 + override 合并 + ATTRIBUTION）
3. 1 项未确认事实待 v1 前实测：LiteLLM 的 `provider_specific_entry: {fast: 6.0}` 是否 = `service_tier: priority` multiplier（看 LiteLLM PR/issue 历史 + 跟 Anthropic 账单交叉验证）

---

## 实施清单（v1 落地）

```
1. packages/analytics/data/prices.json
   - 当前 LiteLLM main 的 21 个 claude-* entries 的快照
   - 仅保留 multi-cc-im 真用的 keys：input_cost_per_token / output_cost_per_token /
     cache_read_input_token_cost / cache_creation_input_token_cost /
     cache_creation_input_token_cost_above_1hr
   - 头部加 metadata: {generated_at, source_commit, source_url}

2. scripts/sync-prices.sh
   - curl https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json
   - jq 过滤到 startswith("claude-") 且不含 "anthropic." / "azure_ai/" / "openrouter/" 前缀的 keys
   - 重写 packages/analytics/data/prices.json + 更新 metadata
   - 跑 pnpm test 验证
   - 输出 git diff 让 PR 提交者 review

3. packages/analytics/src/pricing.ts
   - export type PricingTable: zod schema 定义价格表结构
   - export function loadPricing(configStore): 合并 shipped JSON + user override
   - export function computeCost(usage, model, tier): 按 5 维度查表算 USD

4. packages/storage-files/src/config-store.ts (扩展)
   - ConfigSchema 增加 [pricing] section: z.record(z.string(), PartialPricing)

5. packages/shared/src/adapter/storage.ts (扩展 Config zod schema)
   - 新增 pricing 字段（partial override 形态）

6. ATTRIBUTION.md (root)
   - 声明 packages/analytics/data/prices.json vendor from LiteLLM
   - LiteLLM MIT license 复制 + 链接

7. .github/workflows/sync-prices.yml (可选 v2)
   - 周期 cron 跑 sync-prices.sh，diff 不为空就开 PR
```

---

## 风险与缓解

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| LiteLLM 漏 `service_tier: priority` 价格（cc jsonl 实测有此值，LiteLLM 字段命名未确认是否对应 `provider_specific_entry: {fast: 6.0}`）| 中 | 中 | v1 实施时实测：用户跑实际 priority tier 请求，对比 Anthropic 账单 vs 我们算的；如果差距大 → 用 user override 补 priority 行 |
| Anthropic 新模型 LiteLLM 入库延迟 | 中 | 低 | sync 脚本周期短点（1 周）+ user override |
| LiteLLM 仓库 license 变更 / 撤库 | 极低 | 低 | vendor 后 license 已固化 MIT；vendor 副本永远可用 |
| sync 脚本 fetch 失败（GitHub 限流） | 低 | 低 | 脚本失败不影响 multi-cc-im 运行（用现有 snapshot）；CI 可重试 |
| 用户在 config.toml 写错 pricing override（如 typo 价格高 100x） | 中 | 低 | zod 校验范围 (e.g. 0 < price < 0.001 USD/token)；超出抛错 + log warn |
| Anthropic 改 cache TTL 设计（除 5m/1h 外加新档）| 低 | 中 | LiteLLM 会跟进字段名变化；我们 sync 时检测新字段并日志 + 加 zod schema |
| `provider_specific_entry: {us: 1.1, fast: 6.0}` 真实含义未确认 | 高 | 中 | DD 报告显式 flag；v1 实施前再确认（看 LiteLLM PR 历史 / issue tracker） |

---

## 链接

- **前置 DD**:
  - [hook+wezterm 实测](2026-04-27-cc-hook-wezterm-probe.md) — H4 节实证 5 个价格维度（`assistant.message.usage`）
  - [iLink 协议库选型](2026-04-26-ilink-library-dd.md) — vendor 子集 + sync 脚本模式（同构借鉴）
  - [Storage 持久化策略](2026-04-29-storage-strategy-dd.md) — `~/.multi-cc-im/config.toml` 已预留 `[pricing]` section
- **数据来源**（实证）:
  - LiteLLM model_prices: https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json
  - LiteLLM repo: https://github.com/BerriAI/litellm （MIT license confirmed）
  - npm tokencost / claude-cost / @anthropic-ai/tokenizer 实查（均不 fit，见排除清单）
- **后续相关 DD**（待启动）:
  - `provider_specific_entry: {fast: 6.0}` 含义确认 — v1 analytics 实施前
  - sync 脚本周期 (manual / cron via GHA) — v1 实施时定
