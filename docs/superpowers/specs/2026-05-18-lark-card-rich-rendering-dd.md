# DD: Lark Card Rich Rendering for cc → IM md tables

**Status**: ⏸️ **PAUSED** 2026-05-18 — npm search 发现直接竞品 `@leviyuan/lodestar` 已用 `card.action.trigger` 走 WebSocket 长连接做 button callback，**证伪 DD #86 §11.5 cancel reasoning**。md table 渲染只是 symptom；项目定位 + cards 整体路径 + §11.5 重审是 deeper question。**Upstream 战略 DD**：[`2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md`](2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md)（待写）。本 DD 在战略 DD 拍板后 resume 或合并 obsolete。
**Date**: 2026-05-18
**Owner**: multi-cc-im daemon outbound rendering

---

## 0. 问题陈述

### 0.1 现象

cc 给 IM 端的 reply 包含 markdown 表格时，Lark IM `msg_type: 'text'` 不渲染 md，`|...|` + `---` 字符原样穿透。手机端字符对齐失败、信息可读性差。

### 0.2 真实失败 case（daemon.log 2026-05-14 ~ 2026-05-18）

```
[cc → IM] reply='| # | 问题 | 严重度 | 性质 |
|---|---|---|---|
| 376 | `/list` 标题写 "wezterm ...'

[cc → IM] reply='| 文件 | 改动 |
|---|---|
| `announce-intent.sh` cat here…'

[cc → IM] reply='# ✅ UserPromptSubmit hook 全栈改造完成
| # | 操作 | 结果 |
|---|---|---|
| 1 | ...'
```

多条 reply 含 md table → 手机端字符乱。**频次高**（最新一周 daemon.log 含 `|...|` table 的 reply ≥ 10 条）。

### 0.3 现状基线（PR #106, 2026-05-11）

`packages/im-lark/src/markdown.ts` `stripMarkdown` 已 handle 头/粗/列/链接/代码块，**明确不 handle table**（doc comment: "tables degrade gracefully, best-effort"）。结果 = table 字符穿透。

### 0.4 DD #86 §11.5 cancel scope 字面 verify

> Feishu's interactive card **button callbacks** only deliver via HTTP webhook, conflicts with no-public-IP.

Cancel 的 = **含 button 的 interactive cards**（`/1 /2` 审批 flow）。**Display-only card（无 button = 无 callback）不在 cancel scope**。

### 0.5 用户期望

cc 输出 md table 时，IM 端能正常展示表格（视觉对齐 + 可复制 + 可手机端 native 看）。

---

## 1. 候选枚举

按 CLAUDE.md DD 流程 + memory `feedback_dd_question_premise.md`「第一个候选永远是『不做 X / 用现有』」+「禁止预设解」。

| ID | 候选 | 一句话 |
|---|---|---|
| **a** | **不做 X — 继续 stripMarkdown text msg** | 接受 table 字符乱，依靠用户脑补对齐 |
| **b** | **现有 `post` 富文本 msg_type** | Lark `post` 富文本无 native table，仅 bold/italic/list |
| **c** | **现有 Lark interactive card display-only** | 用 Lark card schema 描述 table，无 button = 无 callback = 不冲突 §11.5 |
| **d** | **服务端 md → PNG 图片** | daemon 端 puppeteer/canvas render md → png，发 image msg |
| **e** | **cc 源头 — prompt 引导 cc 不出 table** | 改 CLAUDE.md / system prompt 让 cc 用 bullet/序号 代替 md table |
| **f** | **From scratch — ASCII column 对齐器** | 自写 CJK 宽度感知 monospace 对齐，仍 text msg |
| **g** | **npm depend — 现成 md → card lib** | 查 npm 有无 `markdown-to-feishu-card` 类库直接复用 |

---

## 2. 每个候选尽调

### 2.a 不做 — 继续 stripMarkdown text

| 维度 | 评估 |
|---|---|
| 实测 | 失败 — daemon.log 真案例字符乱（§0.2） |
| 源码 | `markdown.ts:11` 注释 "tables degrade gracefully" 已知缺口 |
| 治理 | 0 改动 |
| 安全 | ✅ N/A |
| 协议跟进 | ✅ N/A |
| **结论** | 拒绝 — 不解决问题；用户已反馈 |

### 2.b 现有 Lark `post` 富文本

| 维度 | 评估 |
|---|---|
| Lark docs (webfetch verify) | `post` md 仅支 ordered/unordered list；**无 table 语法** |
| 实测 | 不可能改善 table 渲染 |
| 治理 | 改 adapter outbound msg_type + content schema，工作量中 |
| 协议跟进 | Lark `post` schema 长期稳定 |
| **结论** | 拒绝 — 对 table 不生效；只改善 bold/italic/list 但 stripMarkdown 已覆盖 |

### 2.c 现有 Lark interactive card display-only ⭐

| 维度 | 评估 |
|---|---|
| SDK | ✅ `@larksuiteoapi/node-sdk@1.63.1` `types/index.d.ts` 支持 `msg_type: card_json` |
| Lark docs (webfetch verify) | ⚠️ **未 verify** — Feishu docs JS-heavy webfetch 拉不到；需手动看 [open.feishu.cn cards 索引](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/feishu-cards/card-json-structure)；社区知识 cards 含 `column_set` 多列 + 「2024 起加 `table` 组件」需 verify |
| DD #86 §11.5 cancel scope | ✅ §0.4 verify — cancel 范围是 button-callback cards，display-only 不在 |
| Adapter 改动 | `im-lark/adapter.ts:264, 471` 出 `msg_type='text'` → 条件式 'interactive'（含 table 时切，否则保 text） |
| md → card 转换器 | 中等复杂度；md AST (remark/unified) → card schema；可能需自写 |
| 多 IM adapter 影响 | tg/wechat 等无 native card；需在 bridge layer 抽象 "richMessage" 接口，后端 fallback text |
| 治理 | 改 im-lark adapter + bridge outbound interface + 新 md→card 模块 |
| 安全 | ✅ 同 text 路径，走同 SDK endpoint，不引入新 surface |
| 协议跟进 | Lark cards schema 半年级 stable，table 组件相对新 |
| 实测 plan | 手写一个 sample card with table → send 到测试 chat → 手机端看渲染 |
| **结论** | 候选主推；前置 verify Lark `table` 组件 schema + 实测 |

### 2.d 服务端 md → PNG

| 维度 | 评估 |
|---|---|
| 实现 | puppeteer / sharp / canvas / playwright 多选；render md → html → png |
| 依赖 binary | chromium ~50 MB / 或 native canvas — bundle 暴胀 |
| 性能 | render 一次 1-3s（puppeteer 冷启动）；daemon 每条 reply 都 render |
| 失败模式 | render 错 → fallback text；puppeteer 二进制平台差异 |
| Mobile UX | ✅ pixel perfect；图片 fit screen |
| 文本可复制 / 搜索 | ❌ 图片 lossy |
| 上游 dep 治理 | puppeteer 大厂维护，但 binary 跟 OS 强耦合（macOS / Linux / Windows）|
| 协议跟进 | Lark `image` msg 长期稳定 |
| **结论** | 主推备选 — 信息可复制丢失是硬伤；保留作 fallback path（Lark card 失败时降级图片） |

### 2.e cc 源头 — prompt 引导

| 维度 | 评估 |
|---|---|
| 实现 | 改 `CLAUDE.md` 或 cc system prompt：「对 IM 端 reply 不输出 md table，用 bullet/序号 / 缩进替代」 |
| 治理 | 改 1 行 CLAUDE.md / hook 注入 system prompt 提示 |
| 信息密度 | ⚠️ 2D table → 1D list 退化；多列数据可读性下降 |
| 失败模式 | cc 不听话仍出 table；Sonnet 4.6 instruction following 高但非 100% |
| 复合 | 跟 c/d 不冲突 — 可叠加（源头少出 + 终端 card 渲染兜底） |
| 协议跟进 | 无 |
| **结论** | 候选 + 跟 c 互补；本身不彻底 |

### 2.f From scratch — CJK ASCII 对齐器

| 维度 | 评估 |
|---|---|
| 实现 | 解析 md table AST → 计算每列 max display width (CJK 字符 = 2 wcwidth) → 用 spaces pad 对齐 |
| 治理 | 改 stripMarkdown 加 table handler；新 utility module |
| 字体依赖 | IM 端字体必须是 monospace 才对齐；Lark mobile **默认非 monospace** ❌ |
| **结论** | 拒绝 — Lark IM 默认字体非等宽，ASCII 对齐失败 |

### 2.g npm depend — md → feishu card 现成 lib

| 维度 | 评估 |
|---|---|
| npm search | 搜 `markdown-to-feishu-card`, `md2feishu-card`, `feishu-card-builder` 等 — 需 verify |
| 治理 | 若有 — 评估包大小 / 治理活跃度 / TS 支持 / star / commit recency |
| 协议跟进 | 第三方包 Lark card schema 更新跟进 lag 风险 |
| 安全 | 引入第三方包 supply chain 风险 |
| **结论** | **待 verify** — §2.g.verify 跑 `npm search` + 查 top 3 候选包；若有 active 维护 + ≥ 100 stars → 优先用现成 |

### 2 尽调汇总 — 待 verify 项

| # | 待 verify | 方式 | 阻塞? |
|---|---|---|---|
| 1 | Lark card `table` 组件 schema 存在 + 限制 | 手动开 open.feishu.cn 看 docs；或 webfetch 试 mirror 站 | ✅ c 推荐前必 verify |
| 2 | npm `markdown-to-feishu-card` 类库 search | `npm search` + GitHub | ✅ g 推荐前必 verify |
| 3 | 多 IM adapter "richMessage" 抽象 — tg/wechat 等价物 | 翻 tg bot API / wechat 协议 docs | 🟡 c 落地时跟进，DD 阶段不阻塞 |

---

## §3 / §4 / §5 — 待 §1+§2 用户审完后补充

---

## 引用

- [DD #86: Lark IM adapter](2026-05-09-lark-im-adapter-dd.md) §8.4 MVP msg types + §11.5 M5 cancel
- `packages/im-lark/src/markdown.ts:11` "tables degrade gracefully"
- `packages/im-lark/src/adapter.ts:264, 471` 现 msg_type='text' 出站
- daemon.log 失败 case（§0.2）
- Memory: `feedback_dd_question_premise.md` 候选必含「不做 X」
