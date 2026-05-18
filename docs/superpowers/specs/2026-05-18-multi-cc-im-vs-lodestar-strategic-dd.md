# DD: multi-cc-im vs Lodestar — 战略定位重审

**Status**: 🚧 §0+§1 草稿等用户审 → 选路径 → 跑 §2 深 dig → 写 §3 矩阵 + §4 推荐 + §5 拍板
**Date**: 2026-05-18
**Trigger**: npm search 修 md table 渲染时发现直接竞品 `@leviyuan/lodestar` v0.2.9，feature superset + DD #86 §11.5 cancel reasoning 被反证

---

## 0. 现状

### 0.1 Lodestar 全景

- **NPM**: `@leviyuan/lodestar` v0.2.9, MIT, published 2026-05-17
- **GitHub**: [leviyuan/lodestar](https://github.com/leviyuan/lodestar), 10 stars, last push 2026-05-17
- **Tagline**: "把 Claude Code 装进你的飞书群。一个群 = 一个项目 = 一段不熄灯的对话。"
- **Runtime**: Bun ≥ 1.0
- **Code**: 5228 LOC TS，单 repo 单 daemon.ts entry，**无 adapter 抽象层**
- **API**: 直接调 `cardkit/v1` REST endpoints（不只 SDK 封装）
- **Token**: tenant_access_token cache（不依赖 OAuth keychain）

**Feature 集**:

| 类 | Lodestar 有 |
|---|---|
| 渲染 | 真·流式卡片（token 级 typewriter） |
| Thinking | 流式 + turn 后自动收起 |
| 工具调用 | 每次工具一格折叠面板 |
| 审批 | 工具卡上**三按钮 in-card**（`card.action.trigger` 走 WebSocket） |
| Ask | 结构化追问 + 选项行 + 自由文本 + 多题翻页 |
| 排队 | Type-ahead 不打断 + `[#N]` 序号合并 |
| Footer | 实时 `✅ ⏱时长 · 📊上下文% · 💰本轮成本` |
| 控制台 | `hi` 弹卡跨群项目 + 上下文% + 额度 |
| 图文 | `[file:]` 进 / `[[send:]]` 出 |
| 加急 | Ask / 审批 / done 锁屏推送 |
| Cron | `Cron / ScheduleWakeup` 到点自开新卡 |
| 多项目 | 1 daemon ↔ N 群 ↔ N session |
| 自动 resume | sessionId 落盘，重启续接 |
| 守护 | systemd watchdog + 单 PID + alive marker |
| HTTP 端点 | `POST /notify` 任意进程一行 curl 推卡片 |
| Stop / kill / restart / clear | 4 个**裸词控制**（无斜杠） |

**关键架构事实**：
- `card.action.trigger` 事件**走 WebSocket 长连接收**（同 `im.message.receive_v1`），不需 public IP。
- Card Kit v1 streaming API 是 mature 产品级（含 typewriter / element add/remove/replace）。
- 单 daemon 持 N 群 ↔ N session 是已验证 pattern。

### 0.2 multi-cc-im 全景 (v0.1.1)

| 维度 | 状态 |
|---|---|
| 架构 | pnpm monorepo 9 packages |
| Adapter | 4 维（IM / Term / CLI / Storage），未来可扩 tg / wechat / tmux 等 |
| IM | Lark only（其他待加） |
| Term | wezterm + iterm2（v1.13 落地） |
| CLI | cc only |
| Storage | files-based（无 SQL DB） |
| Test | 1016 tests pass |
| DD discipline | 5 步 DD + memory + conventions 修订日志 |
| 渲染 | text msg_type，stripMarkdown 无 table |
| 审批 | text `/1 /2` 或自然语言 IM 回复 (v1.7) |
| AUQ | text-only numbered options |
| 监控 | 本地 web dashboard `:40719`（不在 IM 内） |
| Multi-session | 多 cc TUI tab（wezterm/iterm2 持续） |
| Resume | TUI 自带 |
| Runtime | Node 22 ESM |

**重叠**：cc + 飞书 IM bridge，1 群 ↔ 1 session，IM 控制 cc。
**核心差**：multi-cc-im 围绕「现有 cc TUI tab + IM bridge」；Lodestar 围绕「Card Kit 是 native IM frontend，cc subprocess 服务卡片」。

### 0.3 DD #86 §11.5 cancel reasoning 反证

| 当时 (2026-05-11) 假设 | Lodestar 反证 |
|---|---|
| 「interactive card button callbacks **只能** HTTP webhook」 | ❌ Lodestar 用 `card.action.trigger` 事件订阅 **走 WebSocket 长连接** |
| 「conflict no-public-IP core constraint #1」 | ❌ 不冲突 — WS 长连接是 lark `disableTokenCache: false` client 默认能力 |
| 「M5 interactive cards ❌ 永久取消」 | ❌ 这个 reasoning 错了，cards 实际可行 |

**核心 implication**：multi-cc-im v0.1.x 整套「text-only + IM `/1 /2`」假设建立在**错误前提**之上。如果当时假设对，cards 早就该做。

### 0.4 当前痛点（导致这个 strategic DD 触发）

| 痛点 | 现状 |
|---|---|
| md table 渲染 | 字符乱（本 DD 起源） |
| 富文本 | stripMarkdown 处理头/粗/列，但 native UX 差 |
| 审批 UX | `/1 /2` text vs 卡片三按钮 |
| AUQ | numbered text vs 选项行 in-card |
| 流式 | 整段 reply 收完才发 IM vs token-by-token typewriter |
| 工具调用可见性 | 用户看不到 cc 在跑啥工具 vs 折叠面板 |
| 实时指标 | 须开 web dashboard 看 vs footer 直接展示 |

---

## 1. 候选枚举

按 CLAUDE.md DD + memory `feedback_dd_question_premise.md`「候选含『不做 X』」+ `feedback_no_workload_optimization.md`「不考虑工作量，只追求彻底解决」。`α 不做 X` 是 workaround 性质，**保留作 baseline 对照**但不推荐。

| ID | 候选 | 一句话 |
|---|---|---|
| **α** | **不做 X — 当前路径，假装没看见 Lodestar** | multi-cc-im 继续按 v0.1.x 思路 iterate（含本周修 md table）；DD #86 §11.5 cancel 不动；接受 feature gap |
| **β** | **借鉴 Lodestar 模式 — multi-cc-im 主线继续 + 引入 Card Kit streaming + button callback + 多 IM adapter 抽象保留** | 学 Lodestar 实现，把 cards + streaming 加进 multi-cc-im 的 4 维 adapter，IM 端从 text 升级 cards |
| **γ** | **Fork / 取代 Lodestar — multi-cc-im 团队接管 Lodestar 主线** | multi-cc-im 仓库归档，新仓库 fork lodestar + 加 multi-cc-im 的优点（adapter / test / DD），lodestar 作者放手 |
| **δ** | **Adopt Lodestar — 弃 multi-cc-im 用 Lodestar** | 直接装 lodestar，归档 multi-cc-im，接受 Bun runtime + 无 adapter |
| **ε** | **协作 / 上游 PR — 把 multi-cc-im 的优势贡献给 Lodestar** | Lodestar 作主仓，multi-cc-im 把 adapter abstraction / test infra / iTerm2 支持 / DD discipline upstream 给 lodestar |
| **ζ** | **切赛道 — multi-cc-im 退出 Feishu cc bridge，转 IM adapter 多元化** | 让 lodestar 当 Feishu cc bridge 标杆，multi-cc-im 重定位为「**多 IM** + cc」（tg / wechat / discord / slack），Lark adapter 只作 reference 保留 |

---

## 2. 尽调（β 路径 — 用户 2026-05-18 拍板）

### 2.1 §11.5 cancel reasoning 反证（决定性源码证据）

`/tmp/lodestar/daemon.ts:326-343` 实测：

```typescript
const ws = new lark.WSClient({ appId, appSecret, loggerLevel, logger })
const dispatcher = new lark.EventDispatcher({})
dispatcher.register({
  'im.message.receive_v1': async (d) => { await handleMessage(d) },
})
dispatcher.register({
  'card.action.trigger': async (d) => { return await handleCardAction(d) },
})
ws.start({ eventDispatcher: dispatcher })
```

`card.action.trigger` 跟 `im.message.receive_v1` **同一 `lark.WSClient` + 同一 `EventDispatcher`**，全走 WebSocket 长连接，无 public IP。DD #86 §11.5 cancel 假设字面错。

### 2.2 Card Kit v1 wrapper pattern（lodestar/src/cardkit.ts 349 LOC）

| Pattern | 关键实现 |
|---|---|
| API base | `https://open.feishu.cn/open-apis/cardkit/v1` raw REST |
| 鉴权 | `tenant_access_token` cache（不用 OAuth keychain） |
| Endpoints | `POST /cards/id_convert` / `POST /cards` / `PUT/POST/DELETE /cards/:id/elements` / `PATCH /cards/:id/settings` |
| Sequence | Per-card monotonic 递增 counter；多并发写必须按 seq 排序，Feishu 拒收乱序 |
| Serialization | Promise queue per `cardId` — 所有写串行 |
| Streaming text | `PUT /cards/:id/elements/:elem/content` — prefix-match 触发 typewriter |
| Throttle | 120ms timer + 32-char delta heuristic |
| Summary throttle | 1500ms coalesce |
| TTL auto-recovery | 检 code 300309 / 200850 → `PATCH settings.streaming_mode=true` + retry once |
| Failure mode | fire-and-forget swallow + `onFailure` callback 清失效 placeholder |

### 2.3 Lodestar 整体架构 vs multi-cc-im 4 维 adapter

| 维度 | Lodestar | multi-cc-im | β 决定 |
|---|---|---|---|
| Runtime | Bun ≥ 1.0 | Node 22 ESM | **保 Node 22** — fetch / WS 全兼容 |
| IM adapter | Lark hard-code | 4 维 adapter | **保 adapter** — cards = Lark adapter 内部 |
| Cards 实现 | raw REST cardkit/v1 | (无) | **借 pattern 自写** `packages/im-lark/src/cardkit.ts` |
| Token | tenant_access_token | OAuth via SDK | **加 tenant token path**；OAuth 仍走 SDK |
| Card schema 渲染 | hand-code JSON (cards/turn.ts 530 LOC) | (无) | **建 md → card 转换器** — 学 pattern 不抄 code |
| Streaming | token-by-token (cards/turn.ts) | full-message after Stop | **P6 可选 nice-to-have** |

### 2.4 多 IM adapter 抽象设计（β 关键）

| | Option 1: cards = Lark 内部 | Option 2: RichMessage base 抽象 |
|---|---|---|
| 改动面 | im-lark 内部 + bridge 1 dispatcher 分支 | shared + 所有 adapter 实现 |
| Over-engineering | 低 | 高（tg/wechat 等价物难抽，假抽象） |
| YAGNI | ✅ 加 tg 时再抽 | ❌ 现在抽未来可能错 |
| 推荐 | ⭐ | — |

Memory `feedback_no_workload_optimization.md` 不考虑工作量，但「彻底」≠「过度抽象」。RichMessage 在 1 个 IM adapter 时是假抽象；未来真加 tg/wechat 时**真实迁移会暴露正确抽象边界**。

### 2.5 Lodestar 治理 / license

| 维度 | 数据 |
|---|---|
| License | MIT |
| Stars / Last push | 10 / 2026-05-17 |
| Code lifting | MIT-MIT 兼容；**β 学 pattern 不抄 code** 保 multi-cc-im DNA |
| API 踩坑经验 | 已踩 streaming TTL / sequence ordering / streaming reopen — 学避免重踩 |

---

## 3. 对比矩阵（β 内部 Phase 拆分）

### 3.1 Phase 拆分

| Phase | Scope | 必/选 |
|---|---|---|
| **P1** | DD #86 §11.5 正式撤销 + `packages/im-lark/src/cardkit.ts` Card Kit v1 wrapper（借 lodestar pattern）+ tenant_access_token cache + WS subscribe `card.action.trigger` | ✅ 必 |
| **P2** | md → card schema 转换器 — paragraph / heading / list / **table** / code block；fallback text 兜底 | ✅ 必（解原 md table 痛点） |
| **P3** | bridge outbound dispatch — cc reply 含 table 用 card；否则 text；error 降级 | ✅ 必 |
| **P4** | PreToolUse 审批 → 卡片三按钮 in-card（替 `/1 /2`）+ `card.action.trigger` → PermissionResponse | 🟡 选 — UX 升级 |
| **P5** | AUQ → 选项行 in-card（替 numbered text + 多题翻页） | 🟡 选 — UX 升级 |
| **P6** | Streaming typewriter — cc reply token-by-token 流式渲染 | 🟢 nice-to-have |
| **P7** | 工具调用折叠面板（cc 每个 tool call 一格） | 🟢 nice-to-have |
| **P8** | Footer 实时指标（时长 / 上下文% / 成本） | 🟢 nice-to-have |

### 3.2 Phase 评估

| Phase | LOC delta 估 | 测试覆盖 | DD 影响 |
|---|---|---|---|
| P1 | +500 | cardkit wrapper unit + token cache | §11.5 撤销 + §8.4 加 card msg path |
| P2 | +400 | md→card 转换器 + 多 table fixture | — |
| P3 | +200 | bridge dispatcher unit | — |
| P4 | +600 | PreToolUse smoke + card.action handler | §8.4 cards 不再「未来 milestone」 |
| P5 | +400 | AUQ card smoke | DD #v1.9 §11 加 card variant |
| P6 | +800 | streaming throttle unit + reopen test | — |
| P7 | +500 | tool folder unit | — |
| P8 | +300 | footer 计算 unit | — |

**P1+P2+P3 ≈ 1100 LOC，2-3 周可完成，解原始痛点。**

---

## 4. 推荐 — β.MVP 跑 P1-P3，评估闸再决 P4-P8

### 4.1 路线

| 阶段 | 节奏 |
|---|---|
| **β.MVP** (P1+P2+P3) | 2-3 周；解 md table 痛点 + 立 cards 基础设施 + DD #86 §11.5 撤销 |
| 评估闸 | β.MVP 完成 + 真账号 smoke 后 review：P4-P8 哪些上 / 优先级 |
| **β.UX** (P4+P5) | 4-6 周；按 P4 → P5 单线推；每 P 独立 PR + DD entry |
| **β.Polish** (P6-P8) | 8-12 周 nice-to-have；按用户实际反馈决定优先级 |

### 4.2 关键纪律

| 项 | 规则 |
|---|---|
| 不抄 lodestar code | 学 pattern + 自己重写；MIT-MIT 合规但保 multi-cc-im DNA |
| 保 adapter 抽象 | cards = Lark adapter 内部；不抽 RichMessage base interface |
| 保 OAuth path | tenant_access_token 跟 OAuth 并存：cards 用 token，其他 SDK 调用走 OAuth |
| Test discipline | 每 Phase ≥ 80% line coverage；cardkit / 转换器 / dispatcher 单测必跑 |
| DD #86 §11.5 撤销 | P1 顺手做（修订 DD #86 加 §11.6 sub-revision 撤销 §11.5） |

### 4.3 风险 + 反制

| 风险 | 反制 |
|---|---|
| Card Kit v1 API rate limit | P1 用 lodestar 120ms/32-char throttle 同档 |
| Streaming TTL 10min 重连 | P1 借 lodestar reopen pattern 同档 |
| md table 复杂语法 (cell 含 link / 多行 / 嵌套) | P2 单测 cover edge cases + fallback text |
| OAuth + tenant_token 共存复杂度 | P1 decoupled — 两条独立 path |
| P4-P8 用户不需 | β.MVP 完成已解原痛点，不强 push |

---

## 5. 用户拍板（待）

| 决策点 | 状态 |
|---|---|
| β 路径（借鉴 lodestar 保 adapter） | ✅ 已拍板 2026-05-18 |
| §2.4 多 IM 抽象设计 — Option 1 / Option 2 | ⏳ 推 Option 1 |
| β.MVP scope = P1+P2+P3? 或先 P1+P2 验后再 P3？ | ⏳ |
| P4-P8 启动优先级 | β.MVP 后评估闸再决 |
| Lodestar 作者协作 — issue 鸣谢 / 反向贡献 | 选做 |

---

## 引用

- [Lodestar GitHub](https://github.com/leviyuan/lodestar)
- [Lodestar npm](https://www.npmjs.com/package/@leviyuan/lodestar)
- [DD #86: Lark IM adapter](2026-05-09-lark-im-adapter-dd.md) §11.5 M5 cancel — 假设被本 DD 反证
- [本 DD 触发的 md table DD（已 PAUSE）](2026-05-18-lark-card-rich-rendering-dd.md)
