# DD: AskUserQuestion + PreToolUse → Lark card 按钮模式 (M3)

> 状态: ✅ 用户拍板 γ (M3 拆 P5 → P4)，2026-05-19
> 日期: 2026-05-19
> 触发: 用户拍 M3 (表格 + 按钮混合) — 重大决策，按 CLAUDE.md DD 流程跑 5 步

---

## §0 当前状态

| 维度 | 现状 |
|---|---|
| AskUserQuestion forward (orchestrator.ts:870) | text msg, numbered list `1. label\n   description` + free-text option N+1 |
| PreToolUse ask (orchestrator.ts:894) | text msg, `准备跑工具:\n  Bash(...)\n  #tab /1 = 允许 #tab /2 = 拒绝` |
| PermissionDialog forward (orchestrator.ts:1156) | text msg + `formatPermissionDialogPrompt` numbered options |
| Lark card.action.trigger 订阅 | ✅ 已 wire (P1 PR #195, adapter.ts:368) — `opts.onCardAction` callback 接收 |
| `onCardAction` caller | ❌ 空 — daemon 端没人传 callback，event 永远走 stub log |
| mdToCard button 元素生成 | ❌ 现版本只生 `column_set/column/markdown`，无 button 支持 |

---

## §1 候选枚举（6 个 — 含「不做 X」+「撤回 M3」防 lock-in）

| 候选 | 1 句话 |
|---|---|
| **α** 不做 M3，回 M1（纯表格渲染） | options 改 md 表格 + 用户仍敲 `/1` `/2` / 自然语言；按钮不要 |
| **β** M3 一气：AUQ + PreToolUse 同 PR | 借鉴 lodestar pattern，AUQ option button + PreToolUse 三按钮 (allow/allow_always/deny) 一 PR 完成 |
| **γ** M3 拆 P5 → P4 | 先 AUQ button merge + 真账号 smoke → 再 PreToolUse button merge；增量验证 |
| **δ** fork lodestar `cards/turn.ts` + `session-ask.ts` 直接 vendor | 直接 copy 代码，最快但跟 4 维 adapter 架构冲突，要大改造 |
| **ε** 用 `cardkit.createCardEntity` streaming entity vs static `msg.create` | button 点击后 card 内部状态可热更新（无需新发消息），但 streaming TTL / sequence 复杂 |
| **ζ** M2 only：撤回表格只做 button | 不做 md 表格，options 仍 plain markdown + button row（lodestar `toolCallPermissionElement` 模式） |

---

## §2 每候选尽调

### α — M1 纯表格回 numbered

- **UX**: options 用 native column 渲染，比现 numbered text 美观；但仍要 user 敲数字 / 自然语言回复
- **工程量**: ~半天，改 2 个 formatter (formatAskUserQuestionPrompt / formatPermissionDialogPrompt) 输出 md table；mdToCard / adapter 不动
- **跨包风险**: 0 — 只动 bridge orchestrator formatter
- **跟 lodestar 对齐度**: lodestar 是 button-first，α 不学 button 那部分
- **回退成本**: 极低，单文件改
- **何时合适**: 不愿赌 button schema / WS payload 端到端可靠性时

### β — M3 一气

- **UX**: 端到端最完整，AUQ + PreToolUse 都按钮可点
- **工程量**: ~3-4 天
  - im-lark cardkit 加 button schema 支持（`tag:'button', behaviors:[{type:'callback', value:{...}}]`，source: lodestar/cards/turn.ts:323 + larksuite/node-sdk docs）
  - mdToCard 扩支持 button option element
  - bridge orchestrator AUQ/PreToolUse 路径切走 cardkit `createCardEntity` 或直接 `msg.create(msg_type:interactive)`
  - `card.action.trigger` event handler wire 到 daemon 业务路由（解析 value payload 找 pending hook + deliver answer）
  - tests: button 渲染 + click payload 解析 + 路由 + timeout fallback
- **跨包风险**: 高 — im-lark + bridge + cli-cc 3 包 + shared types 改
- **真账号验证 N=1 风险**: 一次 PR 太多代码，挂在 prod 时 root cause 难锁定
- **跟 lodestar 对齐度**: 完整借鉴 pattern，MIT 可学不可抄
- **回退成本**: 高，跨包接口变 + tests 同步多

### γ — M3 拆 P5 → P4

- **UX**: 终态等同 β，过程分两阶段
- **工程量**: ~1.5 + 1.5 天 = 3 天，比 β 略多但每阶段独立验证
  - **P5 (AUQ button)** 先: 接 cardkit button schema + `card.action.trigger` handler wire (callback `kind:'auq', toolUseId, questionIdx, optionIdx`) + AUQ formatter 改 button 卡片 + tests + 真账号 smoke 4 类
  - **P4 (PreToolUse button)** 后: 复用 P5 已落的 button schema + handler，加 PreToolUse 三按钮 (allow/allow_always/deny) + PermissionDialog forward 同步 + tests + 真账号 smoke
- **跨包风险**: P5 PR 把跨包接口建好，P4 PR 复用接口低风险
- **真账号验证 N=1 风险**: 每阶段独立 smoke verified，符合 `feedback_upstream_schema_real_smoke` N=1 ≠ verified 教训
- **跟 lodestar 对齐度**: 同 β
- **回退成本**: P5 独立可回退；P4 build on P5
- **何时合适**: 大改但要 incremental verify

### δ — fork lodestar source 直接 vendor

- **UX**: 等同 β/γ 终态
- **工程量**: ~5+ 天 — 表面快但要重写跟 4 维 adapter 集成
  - lodestar 是单 IM (lark) + 单 cc + Bun runtime + own session model (`s.pendingAsks`)
  - multi-cc-im 是多 IM × 多 cc × 多 term × Node 22 ESM + 现有 `bridge/orchestrator.ts` 路由
  - 要把 lodestar session/ 状态机移植到 bridge orchestrator (`pendingPermissionAsks` Map)，重命名 import，TS strict 化
- **跨包风险**: 极高 — vendor 大量代码后续维护额外负担
- **跟 lodestar 对齐度**: 100% 但 over-coupling
- **回退成本**: 高
- **何时合适**: 紧急 + 团队多人 + 愿背 vendor 维护负担

### ε — `cardkit.createCardEntity` streaming entity

- **UX 增量**: button 点击后 card 自身热更新（按钮变灰 + 状态 "✅ 已允许"），不发新消息；β.MVP P1 cardkit 基础设施已落 (streamText/addElement/replaceElement)
- **工程量增量**: P5/P4 之上加 ~1-2 天接 cardkit streaming
- **跨包风险**: 中 — cardkit instance 跨 turn 管理 + 300309/200850 TTL reopen + sequence monotonic
- **跟 lodestar 对齐度**: lodestar 用同 pattern (cards/console.ts streamText)
- **回退成本**: 中 — 跟 static msg.create 兼容路径要保
- **何时合适**: 想极致 UX，按钮点击后视觉反馈 instant

### ζ — M2 only 撤回表格

- **UX**: button row 美观但 options 仍是 plain text bullet
- **工程量**: ~1.5-2 天，比 M3 少做表格部分
- **跨包风险**: 同 β
- **跟 lodestar 对齐度**: 同 β
- **回退成本**: 中
- **何时合适**: 想 simple 不混 md 表格

---

## §3 对比矩阵

| 维度 | α M1 回退 | β M3 一气 | **γ M3 拆 P5→P4** | δ fork | ε streaming 增量 | ζ M2 撤表 |
|---|---|---|---|---|---|---|
| UX 完整度 | 3/10（无按钮） | 9/10 | 9/10 | 9/10 | **10/10** | 7/10（无表格） |
| 工程量（天） | 0.5 | 3-4 | 3 | 5+ | +1-2 on top of γ | 2 |
| 跨包风险 | 极低 | 高 | **中** | 极高 | 中 | 高 |
| N=1 验证风险 | 极低 | 高（一次大改） | **低（拆 2 PR）** | 高 | 中 | 高 |
| 回退成本 | 极低 | 高 | **可分段回退** | 高 | 中 | 高 |
| lodestar 对齐 | 不学 button | 学 pattern | 学 pattern | 直 vendor | 学 pattern | 学 pattern |
| 跟 P6-P8 路径衔接 | 断（无 button base） | 接（base 落地） | **接** | 接 | 接 + 进 P6 streaming | 接 |

---

## §4 推荐 = γ（M3 拆 P5 → P4）

理由可追溯：

| 理由 | 矩阵证据 |
|---|---|
| 真账号 N=1 ≠ verified 教训不重复 | 矩阵 N=1 风险：β 高 / γ 低（每阶段单独 smoke） |
| 按 [memory: feedback_upstream_schema_real_smoke] 「N=1 pass ≠ verified」 | γ 拆 2 PR 各自 4 类 size 谱系 smoke |
| 跨包接口风险 in β 集中 in γ 分散 | β 一次过 3 包改 → γ P5 建接口 / P4 复用 |
| ε streaming 可在 γ 落定后增量加 | DD § 流程：基础设施 first → polish 后续 |
| α / ζ 不能为 P6-P8 streaming/folding/cost-footer 提供 base | 矩阵 P6-P8 路径衔接：α 断 / ζ 接但 UX 减 |
| δ vendor cost 与本项目 adapter 架构冲突 | 矩阵跨包风险 δ 极高 |

---

## §5 用户决定 — ✅ γ (2026-05-19)

**拍板**: γ = M3 拆 P5 (AUQ) → P4 (PreToolUse)，理由跟推荐一致 (N=1 教训不重复 + 跨包接口分阶段建)。

### 实施路图

| 阶段 | 范围 | 关键工作 | 真账号 smoke |
|---|---|---|---|
| **P5** (本周) | AUQ button + 跨包接口建立 | (a) Lark button schema 接 (`tag:'button', behaviors:[{type:'callback', value}]`) (b) mdToCard 加 button element (c) `onCardAction` callback wire 到 daemon 路由 (d) orchestrator AUQ formatter 改 button 卡片 (e) value payload schema `{kind:'auq', toolUseId, questionIdx, optionIdx, customText?}` (f) timeout fallback 保 110/310s baseline | 4 类 size 谱系（option 点击 / 自由文本 / multi-question / timeout） |
| **P4** (P5 通过后) | PreToolUse 三按钮 + PermissionDialog 同步 | (a) 复用 P5 button schema + onCardAction wiring (b) PreToolUse 三按钮 (允许/始终允许/拒绝) (c) PermissionDialog 选项卡 (numbered → button) (d) value `{kind:'permission', requestId, decision: 'allow'\|'allow_always'\|'deny'}` | 4 类 size 谱系（即时审批 / 始终允许写 PermissionUpdate / 拒绝 / 10s timeout 默认放行） |

### 后续 P6-P8 评估闸（不在本 DD scope）

P5 落定后再单独评估：
- **P6 streaming entity**（ε 候选）— button 点击后 card 内部状态热更新
- **P7 tool folding** — `collapsible_panel` 工具调用折叠（lodestar 已 pattern）
- **P8 footer metrics** — cost / tokens 显示

### 拍板可追溯

- 矩阵 §3 N=1 验证风险列：γ 低 / β 高
- [memory: feedback_upstream_schema_real_smoke] N=1 pass ≠ verified
- [memory: project_future_im_adapters] 接口扩到 shared 不渗 lark-specific
- lodestar source-verified pattern (cards/turn.ts:323 `permissionButtonColumn` + session-ask.ts:42 `onAskAnswer`)
