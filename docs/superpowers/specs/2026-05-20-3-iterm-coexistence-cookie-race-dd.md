# DD: 多 iTerm 共存 / cookie race 处理策略

> 状态: ✅ LOCKED 2026-05-20 — 用户拍 **A 不做 X**（reactive：等 S3 真用户报问题再补救）
> 日期: 2026-05-20
> 触发: [DD: iTerm2 adapter](2026-05-13-iterm2-adapter-dd.md) PR #174 留下的 known corner case「3 iTerm 共存 race（哪一份 iTerm 写 cookie 决定 helper 连谁）」(per conventions.md 2026-05-14 entry) → task #389

---

## §0 现状（v0.1.x 落地点）

| 维度 | 事实 |
|---|---|
| iTerm2 adapter 路径 | DD #2026-05-13 §6 C1 — ephemeral Python helper subprocess |
| helper.py 连 iTerm 的接口 | `iterm2.run_until_complete(_run)` → 内部走 AppleScript 探 cookie → WebSocket `wss://127.0.0.1:<port>/?ITERM2_COOKIE=<cookie>` |
| Cookie 来源 | 脚本由 iTerm 启 → env var `ITERM2_COOKIE` 自动注入；外部脚本 (我们 daemon helper.py) → AppleScript osascript 提示 + macOS Automation 权限到 `com.googlecode.iterm2` bundle id |
| Cookie 物理位置 | `~/Library/HTTPStorages/com.googlecode.iterm2.binarycookies`（binary cookies 格式）|
| 用户机器实测 | 当前 `mdfind kMDItemCFBundleIdentifier=com.googlecode.iterm2` 返 1 个 bundle（`/Applications/iTerm.app`），ITERM2_COOKIE env unset，无 iTerm 进程在跑 |
| 用户直觉 | 「打开的时候，好像每一个都一样」— 跟单一 bundle 假设一致，没遇到 race |

**根本不变量**: AppleScript / Automation 权限按 **bundle id** 绑定。如果机器只有 1 个 bundle id `com.googlecode.iterm2`，那 helper 永远连同一份，无 race。

---

## §1 三种 multi-iTerm 场景的实际表现

| 场景 | 说明 | 实际 race? |
|---|---|---|
| **S1** 单 iTerm 装 1 份（用户当前） | 只 `/Applications/iTerm.app` | ❌ 无 |
| **S2** iTerm 稳定版 + iTerm-Beta 都装 | Beta bundle id 通常 `com.googlecode.iterm2.beta`（独立）| ❌ 无 — 我们永远走 `iterm2`（稳定）bundle，Beta 不被 helper 触及；如果用户 cc 跑在 Beta 里，那是用户配错 iTerm 类型 |
| **S3** 同 bundle id 复制（罕见）| 把 `/Applications/iTerm.app` 复制到 `~/Applications/iTerm.app`，两份都 bundle id `com.googlecode.iterm2` | ✅ 有 — LaunchServices 注册「最新挂的」赢；AppleScript 绑该实例，另一份不可达 |

S3 是真 race；S1+S2 都不构成 race。S3 是不可能 zero 但要用户主动违常理拷贝 app 才出现的边界。

---

## §2 候选枚举（5 个，含「不做 X」+ 显式不可行）

| 候选 | 1 句话 |
|---|---|
| **A** 不做 X | 当前 0 race（S1）；S2 已经天然 no-race；S3 罕见，等用户报真问题再处理 |
| **B** wizard 装机时探测 `mdfind` bundle 数 → 多 bundle 警告但不阻止 | 用户知情；UX 软提示 |
| **C** wizard 多 bundle hard-gate 拒绝启动 | 防御 S3，但 S2 normal 双装情况下用户被砍 → 误伤 |
| **D** config 加 `[terminal] iterm_bundle_id = "..."` 允许显式选 bundle | 给用户控制权但绝大多数人用不上 |
| **E** daemon 启时 `pgrep -f iTerm` + AppleScript instance dispatch | 实时绑活的进程，避开 LaunchServices race | 

C3/AppleScript-only candidates 在主 DD #2026-05-13 §6 已显式 ruled out（macOS 弃用 + capability gap），这里**不再重列**作 candidate。

---

## §3 每候选尽调

### A — 不做 X（推荐）

| 维度 | 说明 |
|---|---|
| 用户机器实测 | mdfind 返 1，无现行 race |
| S2 双装 | bundle id 异 → 不影响 |
| S3 罕见 | 用户主动复制 app + 同 bundle id 才触发；非典型 |
| 后悔成本 | 0 — 不写代码不写文档；未来 S3 真发生用户报问题再处理 |
| 工程量 | 0 |
| 跟 [DD #2026-05-13 §6] 假设 | ✅ 同一 bundle id 一份 |

### B — wizard `mdfind` 多 bundle 警告

| 维度 | 说明 |
|---|---|
| 实现 | `terminal-selector.ts` 选 iterm2 路径加一步 `mdfind`，count > 1 时 `io.message` 警告 + 列路径 |
| 误伤 | S2 双装（Beta + stable）正常，警告会让用户困惑 — 需要在警告里区分 bundle id |
| 用户体验 | 装一次后下次 start 还要走 mdfind（已加在 wizard），轻度啰嗦 |
| 工程量 | ~1 天 (mdfind probe + bundle id 比较 + 文案 + 测试 + 文档) |

### C — wizard 多 bundle hard-gate

| 维度 | 说明 |
|---|---|
| 实现 | 类 B + count > 1 → throw |
| 用户体验 | S2 正常用户被砍，要么删 Beta 要么手编 config — 严重误伤 |
| 排除理由 | 主 DD 一致原则「不破坏现有 cc 进程」，hard-gate 切断 S2 = 切断用户已有 setup |

### D — config 显式 bundle id

| 维度 | 说明 |
|---|---|
| 实现 | `[terminal] iterm_bundle_id = "..."` 字段 + adapter 传给 helper.py + helper.py 通过 osascript `tell application id "<bundle>"` 切换 |
| 复杂度 | wizard 新一步 + storage schema 扩 + helper.py 改 + 测试 |
| 用户体验 | 99% 用户单 bundle 不需要；多 bundle 用户得知道自己 bundle id 才能填 — 高门槛 |
| 工程量 | ~2-3 天 + 测试覆盖 multi-bundle 真账号 smoke |

### E — daemon `pgrep` + AppleScript instance dispatch

| 维度 | 说明 |
|---|---|
| 实现 | `pgrep -f iTerm` → 找 PID → AppleScript 用 PID 绑活的实例 |
| AppleScript 限制 | AppleScript 不支持「按 PID 绑」— 只能 by bundle id / by name；E 技术上**不可行** |
| 排除理由 | 上面 |

---

## §4 对比矩阵

| 维度 | **A 不做** | B 警告 | C hard-gate | D 显式 config | E pgrep |
|---|---|---|---|---|---|
| 当前用户 race? | ❌ 无 | ❌ 无 | ❌ 无（但被 gate）| ❌ 无 | ❌ 无（不可行）|
| S2 双装影响 | ✅ 透明 | ⚠️ 误警 | ❌ 砍 | ✅ 透明 | N/A |
| S3 真 race 防 | ❌ | ✅ 软提示 | ✅ 硬 | ✅ | N/A |
| 工程量（天）| **0** | ~1 | ~1.5 | ~3 | 不可行 |
| 跟核心约束 | ✅ | ✅ | ❌（破 S2） | ✅ | N/A |
| 用户认知负担 | 零 | 低 | 高 | 高 | N/A |
| 后悔成本 | 0 | 低 | 中（已砍用户）| 中（schema 改）| N/A |
| Source verified | mdfind 实测 1 bundle / DD #2026-05-13 §6 cookie 段 | 同 + bundle id ≠ 比较 | 同 | iTerm bundle id docs | AppleScript no-PID 限制 |

---

## §5 推荐 = A（不做 X）

| 理由 | 矩阵证据 |
|---|---|
| 当前用户实测 0 race | mdfind=1 bundle |
| S2（Beta + 稳）天然 no-race | bundle id 隔离 |
| S3 罕见 + 用户主动违常 | 复制 app + 同 bundle id |
| B/C/D 都有 ≥1 天工程量但 fix 的是 0.5% 罕见场景 | 矩阵列 |
| C 砍 S2 用户 = 反「不破坏现有 setup」原则 | 矩阵 ❌ |
| E 技术不可行 | AppleScript no-PID |

**Tradeoffs A 接受**:

| Trade-off | 接受理由 |
|---|---|
| 未来 S3 用户报「cc 在另一份 iTerm 跑但 daemon 连不到」时才补救 | 罕见 + reactive 比 preemptive 砍 S2 用户更划算 |
| 不主动文档化 S3 | 文档 = 用户阅读成本 ↑；S3 罕见到加文档反而误导多数人 |
| 监控信号缺 | daemon.log 已有 helper.py 错误 surface；S3 真发生时用户会看到 connect fail，那时候补救路径 = 复制 app 删一份 OR upgrade 到 D |

---

## §6 用户决定 — ✅ A (2026-05-20)

**主路径拍板**: A = 不做 X。

理由可追溯（§5 已详）：

| 理由 | 证据出处 |
|---|---|
| 当前用户实测 1 个 iTerm bundle，无现行 race | §0 mdfind 实测 |
| S2 双装（Beta + 稳）bundle id 异 → 天然无 race | §1 + iTerm bundle id docs |
| S3 真 race 仅出现于「用户主动复制 .app 且同 bundle id」罕见场景 | §1 |
| 砍 S2 用户（候选 C）违核心约束「不破坏现有 cc 进程」 | §3 |
| 工程量 0、后悔成本 0 — 未来 S3 真出再补救代价低 | §4 矩阵 |

**关闭 task #389** — 评估完毕，结论「不做」。未来若有用户报「cc 在另一份 iTerm 里跑但 daemon 连不到」类反馈 → 重开此 task / 升级到 B/D。

---

## §7 实施 task table（A 路径无实施；保留 B/C/D 占位备未来重启）

| # | 路径 | 改动 |
|---|---|---|
| — | A 不做 X | 无实施；本 DD lock 即结案 |
| B-1 | (备用) | `terminal-selector.ts` 加 `mdfindIterm2Bundles()` helper |
| B-2 | (备用) | wizard 多 bundle warn + 测试 |
| C/D | (备用) | 拍板时再细化 |
