# PreToolUse Auto-Approve DD 报告

**Topic**: 让用户在 IM 模式下通过简单命令把 PreToolUse 工具审批切到「全部自动通过」模式，避免每次工具调用都要手动 `/1`。当前 PR #62 (DD #61) 实施完毕的 PreToolUse → IM forward 路径每次 cc 调工具都把 prompt 转发到微信等 10s 用户回 `/1`/`/2`，工具密集场景（cc 连续 Bash / Edit / Grep）下用户拇指疼。引入「trust me, allow all」模式：远程一句话开关。

**Scope**: 影响 IMWork 文件 schema (0-byte tombstone → JSON)；hook PreToolUse decision tree 加一步 E1.5；router `/start` 命令 args 解析 + echo 表明 auto 状态。**不涉及** cc 协议层 / IM 协议层 / term adapter / IMOrigin / daemon liveness（保持 DD #57 #58 #61 设计）；Stop hook 转发跟 auto 无关，不动。

**Date**: 2026-05-08
**Status**: ⏳ 待用户审 → 锁定 → 实施

> 本 DD 起源于 PR #63 merge 后用户实测反馈：同时给两个 cc 连发任务，每个 PreToolUse 都要回 `/1` 烦。auto-approve 模式让用户在「我已知道接下来会跑啥工具」场景下绕过 IM 回路。

---

## 决策摘要（待锁定）

| 候选 | 评估 |
|---|---|
| **b. IMWork schema 0-byte → JSON `{"auto":bool}`，命令 `/start auto`** | ✅ **推荐** |
| a. 不做（用户继续手动 /1） | ❌ — 工具密集场景体验差 |
| c. 独立 `IMWorkAuto` 0-byte tombstone，命令 `/start auto` `/stop auto` | ⚠️ — 可行；schema 改动小但允许 invalid 组合（IM OFF + auto ON） |
| d. config.toml `[permission].auto_approve = true` 启动锁 | ❌ — 必重启 daemon 才切；远程接 cc 时无法切 |
| e. cc 自身 `permissions.allow = ["*"]` 绕开 multi-cc-im | ❌ — multi-cc-im 失去 IM forward 语义；用户重启 cc 才能切；丢"远程一句话开关" |
| f. 跟 IMWork 解耦的 `/auto on/off`（独立命令 + 独立 file） | ⚠️ — 语义最纯但命令面 + 心智模型成本最高 |

---

## 1. 问题陈述

PR #62 (DD #61) 实施完毕的 hook PreToolUse decision tree:

```
E1 read-only tool (Read/Grep/Glob/NotebookRead)        → allow
E2 !exists IMWork                                       → ask (cc TUI 接管)
E3 !exists <paneId>.IMOrigin                            → ask (没绑 IM thread)
E4 !isDaemonAlive                                       → ask (daemon 不在)
   forward to IM, poll PermissionResponse, timeout 10s default-allow
```

工具密集场景（用户实测：连发任务给两个 cc，Bash 命令组合）下每个非 read-only 工具都触发 forward：
- 用户每次都要在微信回 `@<tab> /1` 或 `/2`
- 默认 10s timeout 软通过；但 cc TUI 也 hang 10s
- 并发场景下 IM fetch 偶发 ECONNRESET (PR-C 暂搁)，更不稳

对比 cc 自己的 TUI：3 选项菜单含「Yes don't ask again」，session 内一次点击全工具自动 allow。multi-cc-im 没这层 — 因为 daemon 想让用户每次审。

但用户实际工作流：
- 远程接 cc 后第一句「分析这个 repo」一次性命令
- cc 跑 30+ Bash / Edit → 每个都要 IM 回
- 用户 mental model: 「我已批准，让 cc 跑下去」

需要「远程一句话切到 trust mode」开关。

---

## 2. 候选枚举

### a. 不做（status quo）

什么都不动；用户继续手动回 `/1` `/2`。

### b. IMWork schema 0-byte → JSON `{"auto":bool}`，命令 `/start auto` ✅ 推荐

IMWork 文件从 0-byte tombstone 升级为 JSON `{ "auto": true|false }`。兼容老 0-byte 文件视为 `{"auto":false}`（兜底）。

命令:
- `/start` → 写 `{"auto":false}` (ask 模式，跟现状一致)
- `/start auto` → 写 `{"auto":true}` (allow 模式)
- `/stop` → 删 IMWork (IM 模式 OFF)

Hook decision tree 加 E1.5（在 E1 之后、E2 之前）:

```
E1   read-only tool                → allow
E1.5 readIMWorkFile().auto = true  → allow ("trust me" mode)
E2   !exists IMWork                → ask
E3   ...
```

### c. 独立 `IMWorkAuto` 0-byte tombstone

不动 IMWork schema；新增 `state/IMWorkAuto` 0-byte tombstone（同模式）。

命令:
- `/start` / `/stop` 不变
- `/start auto` → 写 IMWork + IMWorkAuto
- `/stop auto` → 删 IMWorkAuto (保留 IMWork)

Hook decision tree:
```
E1.5 existsIMWorkAutoFile → allow
```

### d. config.toml `[permission].auto_approve = true`

启动时锁定，跟 IM 命令解耦。用户改 `~/.multi-cc-im/config.toml` 然后重启 daemon。

### e. cc 自身 `permissions.allow = ["*"]`

multi-cc-im 不参与；cc settings.json 直接放过。multi-cc-im hook 看不到这部分 PreToolUse — `read-only` E1 之外完全 bypass。

### f. `/auto on` `/auto off` 独立命令 + 独立 file

跟 `/start /stop` 完全正交。auto 跟 IM 模式独立两个开关。

---

## 3. 对比矩阵

| 维度 | a. 不做 | b. IMWork JSON | c. IMWorkAuto file | d. config.toml | e. cc native | f. /auto 正交 |
|---|---|---|---|---|---|---|
| 解决问题 | ❌ | ✅ | ✅ | ✅（启动后） | ✅（cc 层） | ✅ |
| 远程控制 | n/a | ✅ IM 一句话 | ✅ IM 一句话 | ❌ 必重启 daemon | ❌ 必重启 cc | ✅ IM 一句话 |
| Schema 改动 | 0 | IMWork callsite 全改；老 0-byte 兼容 | +1 文件 + 4 helper；IMWork 不动 | config.toml +1 字段 | cc settings 改 | +1 文件 + 4 helper |
| 命令面 | 0 | 3 (`/start`, `/start auto`, `/stop`) | 4 (含 `/stop auto`) | 0 | 0 | 4 (含 `/auto on/off`) |
| 心智模型 | n/a | 一开关 + 一 mode (auto 是 IM ON 子状态) | 两正交开关，但 invalid 组合（IM OFF + auto ON）允许 | "改配置重启" | "cc 自管" | 两完全正交开关 |
| 语义封闭 | n/a | ✅ schema 强制 invalid 不可能 | ❌ 需 router 命令逻辑维护 | n/a | n/a | ❌ 同 c |
| Migration | 0 | 免费（daemon start 总重置 IMWork→OFF + 0-byte 兼容） | 0 | 用户手改 | 用户手改 | 0 |
| Hook 决策树 | 不变 | +1 step (read+parse) | +1 step (stat) | +1 step (toml 缓存) | -1 step (cc 层 allow) | +1 step |
| 测试改动面 | 0 | IMWork callsite ~30 处 | +1 套 IMWorkAuto + hook E1.5 | +1 config flag 测 | 不在 scope | 同 c |
| 意外 auto 风险 | 无 | daemon 重启重置 → 安全 | 同 b | ❌ 改 config 永久 auto | ❌ cc 不重启一直 allow | 同 b |
| 可见性 | n/a | echo `✓ IMWork ON (auto-approve)` | echo 两行 | 启动 banner | 无 | echo `/auto on` |

### 关键差异点

**(b) vs (c)** — 实质对比，两者方向相同：
- (b) 「auto 是 IM ON 子状态」用 schema 表达；invalid 组合 (IM OFF + auto ON) 不可能存在
- (c) 允许 `IMWorkAuto` 存在但 IMWork 不存在 — schema 上是合法的，要么 router 命令拒绝该组合，要么 hook 决策树跳过 (= 等同 IMWork OFF)

(b) 用 schema 表达约束；(c) 靠 router 命令维护约束。前者更稳。

**(b) vs (d)** — 远程控制差异：
- (b) 一条 IM 命令切换；daemon 不重启
- (d) 必须改配置文件 + 重启 daemon — 远程接 cc 时无法切

CLAUDE.md "Local-first" 不冲突；区别在切换面是 IM 命令还是配置文件。auto-approve 这种「按 session 切换」用 IM 命令更对路。

**(b) vs (e)** — multi-cc-im 是否参与：
- (e) cc 直接 allow，hook 不 fire — multi-cc-im 看不到，IM 端没有「准备跑工具」通知
- (b) hook 仍 fire，决策树到 E1.5 直接 allow — IM 端可选不通知（不打扰用户）

(e) 完全绕开的好处是简单；坏处是 **IM 端连「cc 在跑啥」都不知道**。失去 IM 透明度。

**(b) vs (f)** — 命令模型：
- (b) `/start auto` 一行表达「开 IM + 开 auto」，符合用户脑模型（「远程开始干活」 = 同时切 auto）
- (f) `/start` + `/auto on` 两行命令表达同一意图

(f) 严格更正交但用户体验更繁琐。`/start auto` 单行触发常见路径符合 80/20。

### 否决候选

- **a. 不做** — 问题陈述里说明痛点
- **d. config.toml** — 远程切不动
- **e. cc native** — 失去 IM 透明度
- **f. /auto 正交** — 命令面 + 心智模型成本最高；语义最干净但收益不抵成本

剩下实质对比 **(b) vs (c)**：(b) 胜在 schema 表达约束。

---

## 4. 推荐：候选 b — IMWork JSON

按上述分析，推荐 (b)。理由可追溯到对比矩阵:

1. **远程控制** [b ✅]: 跟 IMWork ON/OFF 同模式（IM 命令切换），用户体验连贯
2. **语义封闭** [b ✅ vs c ❌]: auto 作为 IM ON 子状态，schema 强制 invalid 组合不可能；c 靠 router 维护约束
3. **Migration 免费** [b ✅]: CLAUDE.md daemon start 总重置 IMWork→OFF + 老 0-byte 视为 `{"auto":false}` 兼容兜底
4. **意外 auto 风险低** [b ✅]: daemon 重启自动关 auto；(d) (e) 都不重启重置 — 风险高
5. **命令面紧凑** [b 3 个 vs c 4 个 vs f 4 个]: 跟用户脑模型对齐
6. **Echo 可见**: `✓ IMWork ON (auto-approve)` 让用户每次切到 auto 都看到状态

实施成本: IMWork callsite 全改（约 30 处 read/write/exists/delete + 测试），但 helper 函数改完后 callsite 多数只是改一行；新增 `readIMWorkFile()` 返回 `{ auto: boolean } | null`。

**风险**: IMWork 在 cli-cc / bridge / apps 三个 package 都有引用。实施时跑 `git grep IMWorkFile` 全跑一遍是必要 verification step。

---

## 5. 实施计划（PR-B）

1. **shared / cli-cc state-files**:
   - `IMWorkFileSchema = z.object({ auto: z.boolean() })`
   - `readIMWorkFile(stateDir): Promise<{auto: boolean} | null>` — null = ENOENT；0-byte 视为 `{auto:false}`；JSON parse 失败抛 (corruption)
   - `writeIMWorkFile(stateDir, content?: {auto: boolean})` — 默认 `{auto:false}`；老调用点 `writeIMWorkFile(stateDir)` 行为不变
   - existsIMWorkFile / deleteIMWorkFile / imWorkPath / IM_WORK_FILE_NAME 不变

2. **cli-cc hook-receiver**:
   - PreToolUse decision tree 加 E1.5: `const imWork = await readIMWorkFile(stateDir); if (imWork && imWork.auto) return allow`
   - 顺序: read-only → IMWork.auto → IMWork exists → IMOrigin → daemon
   - Stop hook 不动（auto 只影响 PreToolUse；cc reply 转发跟 auto 无关）

3. **bridge router**:
   - `/start` parser: `_args` 字符串包含 `auto` token → `imWorkAction = { kind: 'enable', auto: true }`；否则 `auto: false`
   - `/start auto` echo: `✓ IMWork ON (auto-approve) — cc 工具调用直接放行` + 现有 inventory + 规则
   - `/start` echo: `✓ IMWork ON` + 现有
   - `/start` 已经 ON 时再发: idempotent re-render + 显示当前 auto 状态
   - `/stop` echo / 行为不变 (一刀切 OFF)
   - `/current` echo 加一行: `auto-approve: ON | OFF`

4. **bridge orchestrator**: 接 router `imWorkAction` 现在是 `{ kind: 'enable', auto: boolean } | { kind: 'disable' }`；写文件时带 auto

5. **apps**: setup-hooks / start.ts 不变；state-sweep 不变（IMWork 仍由 daemon 管理）

6. **test**:
   - cli-cc state-files: `readIMWorkFile` 三态测（ENOENT / 0-byte / JSON）+ `writeIMWorkFile({auto:true})` round-trip
   - hook-receiver: `auto:true` → allow; `auto:false` → 走 E2/E3/E4
   - bridge router: `/start auto` parser → `imWorkAction.auto=true`; `/start` → false
   - orchestrator: imWorkAction handler 写 IMWork 内容跟 auto flag 对齐

7. **docs**:
   - CLAUDE.md「关键设计假设」表加一行 PreToolUse auto-approve
   - README.md / README.zh-CN.md `/start` 行加 `(auto)` 选项 + IMWork schema 说明
   - docs/architecture.md PreToolUse decision tree 加 E1.5

---

## 6. 锁定决策（待用户确认）

✅ **采纳候选 b**:

- IMWork schema: 0-byte tombstone (兼容兜底) → JSON `{"auto": boolean}`
- 命令: `/start` (auto:false) / `/start auto` (auto:true) / `/stop` (删)
- Hook decision tree 新增 E1.5: IMWork.auto=true → allow
- Echo 表明 auto 状态 (`/start /current` 都加 line)
- Daemon start 总重置 IMWork→OFF 不变 (auto 也跟着重置)

待用户审 → 锁定 → PR-B 实施。

---

## 7. CLAUDE.md 更新（实施时一起 commit）

「关键设计假设（状态总表）」增加一行:

| 维度 | 状态 | 详情 |
|---|---|---|
| PreToolUse auto-approve | ✓ | IMWork schema 升级为 JSON `{"auto":bool}`；`/start auto` 切到 trust mode；hook 决策树 E1.5（read-only 之后、IMWork exists 之前）：`auto=true` → 直接 allow，跳过 IM 转发；daemon start 重置 IMWork → OFF 一并重置 auto；老 0-byte 文件兼容视为 `auto:false`；[DD: PreToolUse auto-approve](docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md) |
