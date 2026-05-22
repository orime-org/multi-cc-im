# Note: Text reply quoted-context handling (no DD)

> 状态: ✅ 实施完成 2026-05-22 — 现行 IM 入站流程的 superset 扩展，无需 DD 候选枚举
> 触发: 用户 — 「研究一下飞书里边回复的那种文字消息怎么处理」
> 关联: [DD #208 image reply-thread routing](2026-05-19-im-image-to-cc-dd.md) §6 C.1（reply event 字段 `parent_id` 同源）

---

## §1 为什么不上 DD

调研过程中起草过 5 候选 DD（A 不做 / B stateful 反查路由 / C B+ 注入 / D AI 推断 / E 强制 reply pattern），用户一锤拍掉：

> 「你那 4 点和之前的逻辑没有区别。只是之前的逻辑是相当于回复信息里边的回复信息没有被引用的内容，所以跟之前的逻辑没有区别。」

**核心 insight**：reply event = 现行 IM 入站 + 被引附加上下文；reply 无被引 = 完全等价现行入站。所以这不是需要候选枚举的「新场景」，而是现行流程的 superset 扩展 — 加 1 input 字段 + AI router prompt 一段说明就够了。

跟 [[feedback_check_superset_of_existing]] 联动 — 新需求落地前先反问「这是不是现行 X 流程的 superset？加 1 字段够吗？」是 → 1 处改动；漏问 → 设计绕远。

---

## §2 source verify（实证 2026-05-22）

| 项 | 实证 |
|---|---|
| 飞书 `im.message.receive_v1` event 含被引原文？ | ❌ 仅 `parent_id`（引用 ID），需 on-demand 拉取 |
| SDK 拉被引消息的 API | `client.im.v1.message.get({path: {message_id}})` — SDK lib L85295 / L89700 / types L252219-L252260 |
| Response 字段 | `data.items[].body.content`（JSON-serialized；text → `{"text": "..."}`）+ `sender.{id, sender_type}` + `msg_type` + `deleted` |
| 所需 scope | `im:message:readonly` / `im:message` / `im:message.history:readonly` 任一（项目已有 `im:message:readonly`）|
| 失败错误码 | `230110` (parent deleted) / `230050` (invisible to bot) / `230002` (bot not in group) |

---

## §3 路径

| 路径 | 触发 | 行为 |
|---|---|---|
| **主路径** | `parent_id` 存在 + `message.get` 成功 | 填 `IncomingMessage.quotedMessage` → orchestrator dispatch 阶段**程序化** append `以下是被引用的消息（来自 ...）` 段到 `dispatch.content` |
| **降级路径** | `parent_id` 存在 + `message.get` 失败（删 / scope / network） | `quotedMessage` undefined → orchestrator 发 IM 回执「⚠️ 无法获取被引消息内容，仅用你的回复处理」+ 走现行入站不带 quoted 上下文 |
| **退化路径** | 无 `parent_id` | 完全等价现行入站，0 改动 |

降级路径**显式 IM 通知**（不静默吞）— 用户原话：「拿不到被引用的这些文字，你就应该给IM回一条消息」。

**降级跳过条件**:
- `parent_id` 匹配 `pendingImages` 缓存（image-join 路径，不需要 quoted 上下文）
- `/start` 等 bridge cmd（不消费 quoted 上下文）

---

## §4 AI 分诊跟 quoted 解耦（2026-05-22 设计修订）

**关键设计**：AI 分诊**只**输入用户当前 reply 文本（不含 quoted），只输出 target + intent。quoted 透传是 orchestrator dispatch 阶段的**程序化**职责，跟 AI 分诊完全解耦。

**为何撤掉原 §4 的「prompt 注入 quoted」设计**：[[feedback_wire_data_from_source_to_every_sink]] — 把 quoted 喂给 AI router 让它「自由决定」嵌不嵌 intent 是反模式，AI 是 free-form generator 不是 typed pipe；同输入两次会随机丢字段。**确定性数据透传**必须在 orchestrator 层显式 wire 到每个 sink。

**两条路径都走同一个程序化 append**（mention / AI-routed plain 统一行为）：

| 路径 | 拼接前 | 拼接后（给 cc 的 prompt）|
|---|---|---|
| `#tab` mention | `<user reply 原文（已 strip #tab 前缀）>` | `<reply>\n\n---\n以下是被引用的消息（来自 <role>）:\n<quoted>` |
| AI 分诊出 intent | `<AI intent>` | `<intent>\n\n---\n以下是被引用的消息（来自 <role>）:\n<quoted>` |
| 无 quoted | `<reply or intent>` | 同上，不附加段 |
| image-join 路径 | `请看 @<path>\n<reply>` | **不**附加 quoted（intentional exempt — quoted 通常是 daemon 自己发的「图已收到」hint，冗余）|

跟 [[feedback_dd_stateless_first_candidate]] 联动 — quotedMessage 仍走「on-demand GET」stateless 路径，daemon 不记 stateful map；只是消费它的不是 AI router 而是 orchestrator dispatch。

---

## §5 实施改动

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/shared/src/types.ts` | `IncomingMessage` 加 `quotedMessage?: { content; sender: { id; role } }` optional 字段 |
| 2 | `packages/im-lark/src/adapter.ts` | (a) `LarkClientShape.im.v1.message.get?` (optional 兼容测试 stub) (b) `renderQuotedItem` 解析 SDK 返的 item → quoted shape，text msg_type 解 JSON，其它 `[<msg_type>]` placeholder (c) `fetchQuotedMessage` on-demand 拉取，所有失败模式返 undefined + log (d) image / text reply 分支调 `fetchQuotedMessage` 填字段 |
| 3 | `packages/bridge/src/orchestrator.ts` | (a) reply event 进来时 `replyToMessageId` 有但 `quotedMessage` 缺 + 非 pendingImage + 非 bridge cmd → 发 IM 通知 (b) **dispatch loop 程序化 append quoted 段到每个 `dispatch.content`**（image-join 路径除外）|
| 4 | `packages/bridge/src/ai-router.ts` | **NO quotedMessage** — AI 分诊跟 quoted 完全解耦。撤掉原设计的 `AIRoutingOpts.quotedMessage` / `renderQuotedBlock` / prompt 注入 |
| 5 | `packages/bridge/src/router.ts` | **NO quotedMessage 透传** — `handlePlainWithAI` 不接 `quotedMessage` 参数；router 只关心 target + intent |
| 6 | tests | 8 adapter（成功 / 删 / 230110 / 网络 / 非 text msg_type / sender_role / 无 parent_id / legacy stub）+ 1 ai-router（prompt **不**含 QUOTED PARENT 段）+ 7 orchestrator（缺 quoted 通知 / 有 quoted 不通知 / pendingImage 不通知 / bridge cmd 不通知 / dispatch append / 无 quoted 不变 / sender role=bot / image-join 不 append） |
| 7 | interactive (cardkit) 真 parse — `extractCardText` 递归遍历 `body.elements[]` 抽 markdown / plain_text / button.text.content + 兜底 `[interactive]` 占位（解析失败 / 无文本元素时）| `packages/im-lark/src/adapter.ts` |
| 8 | image / file / sticker 仍保留 `[<msg_type>]` 占位 — cc 没本地资源 + raw image_key/file_key JSON 是噪音；只 interactive 走真 parse 因为卡片本质就是结构化文本 | 同上 + 设计文档注释 |
| 9 | cardkit parse 单测 — AUQ 卡 / PermissionRequest 卡 / Stop forward markdown table 卡 / 解析失败 fallback / empty elements fallback | `adapter.test.ts` (+5) |

4 维 verify：typecheck 9/9 ✅；tests 1137/1137 ✅；bundle 535.57 KB ✅；bin smoke 0.1.5 ✅。

---

## §6 后续

| 项 | 状态 |
|---|---|
| 真账号 smoke（手机 reply cc Stop forward / 自己旧消息 / 群第三方 / 被引删 / 跨 chat）| 等用户跑 |
| release v0.1.6（bundle WS zombie 修 + reply quoted context）| 待真账号 smoke 通过 |
| conventions.md milestone entry | 等 PR merge |
