# DD: 飞书多消息顺序乱根治 — CardKit 流式卡片单卡承载

- 日期: 2026-05-30
- 状态: 实测完成，待实施（TDD）
- 触发: 用户实测发现 IM 端消息顺序乱（audit 与工作回复顺序反；单条回复拆多表格时 4/5/6 先到 1/2/3 后到，时好时坏）

## 1. 根因（已坐实）

multi-cc-im 把一条 cc 回复按飞书 card 表格上限（旧 `FEISHU_CARD_TABLE_LIMIT = 3`）用 `splitMarkdownByTableCapacity` 拆成**多条独立飞书消息**，串行 `await message.create` 发送（`im-lark/adapter.ts:1264-1305`）。

**飞书对 text/interactive 多条独立消息不保证接收端展示顺序**（官方 message FAQ + intro 文档通篇无顺序保证；代码注释 `adapter.ts:1263` 自白「no msg.sequence guarantee」；用户实测乱序）。串行 await 只保证客户端按序调 API，飞书服务端异步落库 + 接收端按 `create_time`（毫秒）排序，连发时间戳极近 → 乱序、时好时坏。

统一解释：只要拆成多条消息发，就会乱 —— 多 chunk 乱、audit 与工作回复乱同根。

## 2. 候选矩阵（尽调证据）

| 候选 | 机制 | 根治顺序 | 证据 |
|---|---|---|---|
| 现状 | 串行发多条 text/interactive | ❌ | 官方无序保证 + 实测乱 + 注释自白 |
| **A CardKit 流式卡片** | 一张卡 + 一条消息 + 卡内组件承载全部 | ✅ **根治** | 飞书官方为 AI 长输出设计；node-sdk 1.63.1 已含 cardkit v1 全 API；3 同类竞品都用；实测验证（见 §3）|
| B reply 回复链 | 多条消息 parent_id 串 thread | ⚠️ 存疑 | 仍多消息；飞书没承诺 thread 链保序 |
| C batch_message | 一次 API 发多条 | ⚠️ 存疑 | 仍多消息；未说明内建有序 |
| D 间隔发送 | sleep 拉开 create_time | ❌ workaround | 赌 create_time 精度，飞书没承诺按它排 |

**推荐 A**：唯一从结构上消除「多消息」的方案 —— 把「跨消息排序」（靠 create_time，乱）转成「一张卡内组件排列」（结构写死，天然有序）。B/C 仍是多消息逃不开根因，D 是赌运气。

## 3. 实测 ground truth（真账号 2026-05-30）

- **权限**: `cardkit:card:write` 必须开「**应用身份**」版（不是用户身份）—— daemon 用 tenant_access_token（应用身份）调用。用户身份版配应用身份 token → 99991672。开通后必须发布版本生效。
- **一张卡装 6 表格**: `cardkit.v1.card.create` 两种写法都 `CREATE OK code=0`，**没报 230099 表格超限** → 突破旧 3 表格限制（旧限制是 mdToCard 转 column_set 的限制，cardkit markdown 组件原生渲染不受此限）。
- **发送格式**: `im.v1.message.create` `msg_type='interactive'` + `content={"type":"card","data":{"card_id":"<id>"}}`（不是 `msg_type='card'`，那个报 230001）。
- **渲染 + 顺序**: 用户飞书端实测 — 6 表格全渲染成原生表格、列对齐、**顺序 1→6 一丝不乱**。两种写法（6 组件各 1 表格 / 1 组件含 6 表格）渲染效果一致。
- **选定写法 v2**: 1 个 markdown 组件塞整个回复 markdown（实现最简，渲染一样好）。

## 4. 实施方案（v2）

把 `LarkAdapter.send` 主路径改为：

```
send(content, replyCtx, opts):
  1. cardJson = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: <prefix>+content }] } }
  2. card_id = await client.cardkit.v1.card.create({ data: { type:'card_json', data: JSON.stringify(cardJson) } })
  3. await client.im.v1.message.create({ msg_type:'interactive', content: JSON.stringify({type:'card', data:{card_id}}) })
```

- **一条 cc 回复 = 一张卡 = 一条消息** → 零多消息 → 根治顺序（含 audit 与工作回复顺序、单回复多表格顺序）。
- **sourceTag 前缀**: 保留 `**[<tab>]**\n\n` 作为卡内 markdown 开头（一条消息只需一次，不再每 chunk 重复）。
- **fallback**: cardkit create/send 抛错（网络 / API）→ 退回现有 text 路径（`stripMarkdown` + `msg_type:'text'`），保证不丢消息。这是健壮性兜底（cardkit 是 2 次 API 调用，失败率高于单次），非兼容补丁。

## 5. 影响面 / 废弃

| 项 | 处理 |
|---|---|
| `splitMarkdownByTableCapacity` + 多 chunk 串行发送 | **废弃**（乱序根源，删除） |
| `mdToCard`（转 column_set schema 2.0） | 主路径不再用（cardkit 单组件用原生 markdown）；评估是否还有其他 caller，无则删 |
| `FEISHU_CARD_TABLE_LIMIT = 3` + 相关测试 | 废弃 |
| README / docs 飞书配置 | 加 `cardkit:card:write`（应用身份）到 scope 清单 |
| 现有 adapter.test 多 chunk / 表格上限断言 | 改为 cardkit 单卡断言 |

## 6. 风险 / 必验项

- **完整 markdown 渲染**: 只实测了表格。cc 回复含标题 / 列表 / 加粗 / 代码块等，cardkit markdown 组件对完整 GFM 的渲染需在实现 smoke 用真实多元素 cc 回复端到端验证（飞书 markdown 组件是成熟功能，风险低但必验）。
- **2 次 API 调用**: 每条回复 create + send 两次调用（原来一次）。延迟略增，可接受；fallback 兜底失败。
- **卡片实体 14 天有效期**: 发完即用，无需长期持有，无影响。
- **200 组件上限**: 单组件方案只用 1 个组件，远低于上限。

## 7. 决策

用户拍板 A（2026-05-29）+ 实测验证 v2 写法。待用户确认实施方案（§4-§5）后走 TDD 实施。
