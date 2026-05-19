# DD: 飞书 IM 入站图片 → cc tab forward

> 状态: ⏳ 候选 + 尽调完，等用户拍板修法路径
> 日期: 2026-05-19
> 触发: 用户 — 「研究一下怎么在飞书上发图片」 → 入站 image msg forward 给 cc

---

## §0 当前状态

| 维度 | 现状 |
|---|---|
| 飞书入站图片 | lark `im.message.receive_v1` event payload 含 `image_key`; 用 `/open-apis/im/v1/messages/{id}/resources/{key}?type=image` 下载（lodestar `feishu.ts:330` source verified）|
| 我们 lark adapter `onMessage` | 只处理 text msg；image 走 fallback "Unsupported / 友好提示"（v1.8 已设计但不真处理）|
| cc TUI 接图片 | **cc 不接受外部 stdin/IPC 注入 image**；只支持 OS clipboard paste（TUI 自管理）|
| cc Read 工具读图 | ✅ Anthropic 官方能力 — Read 工具能读 image (PNG/JPG/PDF) 进推理上下文 |
| 现有 wezterm/iterm2 send-text | ✅ P3+ 已实测；可发文字到 cc TUI 作 user message |
| im-wechat vendor image | grep 无 — 历史代码未含 image 入站 |

**关键 insight**: cc 不接外部 inject，但 cc Read 工具能读图 — 所以路径只能是「daemon 下载图到本地 → 发文字/路径到 cc TUI → cc 自己调 Read 读图」。

---

## §1 候选枚举（6 个 — 含「不做 X」+ 显式不可行）

| 候选 | 1 句话 |
|---|---|
| **α** 不做 X | 用户手机收到图自己想办法，cc TUI 端 paste / 截图保存 + 路径发给 cc |
| **β** daemon download + send-text path inject | 飞书入站→download→`~/.multi-cc-im/images/`→wezterm send-text `@path 请看`→cc Read 读图 |
| **γ** inject base64 image 到 cc stdin | cc TUI 不接受 stdin image → **不可行**（cc source verified `QueryEngine attachment` 只含 structured_output/max_turns_reached/queued_command）|
| **δ** fork lodestar wechat image path | vendor lodestar `feishu.ts:324-378` 整套 download + format → 跟 4 维 adapter 架构冲突 |
| **ε** cc Agent SDK 程式化注入 attachment | 走非 TUI 路径起独立 cc 进程 → 不动用户 wezterm tab → 破坏「不接管用户 cc 实例」核心约束 |
| **ζ** 转发 image URL 不下载 | 飞书 image API 需 auth token，没 public URL → **不可行** |

---

## §2 每候选尽调

### α — 不做 X

- **UX**: 多设备协同坏 — 手机看到图，要切桌面 cc TUI paste / save，断流
- **工程量**: 0
- **回退**: N/A
- **何时合适**: feature 不重要 / 团队没带宽

### β — daemon download + path inject（推荐）

- **UX**: 飞书发图 → 自动到 cc 推理上下文（cc Read 读）；用户在 IM 端无需切桌面
- **lodestar source verified**:
  - `feishu.ts:324-348` `downloadAttachment(messageId, key, type='image', name?): Promise<string>`
  - 用 `tenant_access_token` Bearer auth GET `/open-apis/im/v1/messages/{id}/resources/{key}?type=image`
  - 保存到本地 `INBOX_DIR/<timestamp>-<safeName>` (默认 .png)
  - 30 MB 上限
- **工程量**: ~2-3 天
  - `packages/im-lark/src/adapter.ts`: `onMessage` 检测 image_key，调 download helper
  - 新 `downloadAttachment` helper (类似 lodestar pattern + TS-strict 重写)
  - 复用现有 `tenant-token.ts` (P1 #195) 拿 Bearer token
  - `packages/bridge/src/orchestrator.ts`: 收到 image path → wezterm send-text `@<path> 请看这张图` 给 cc tab
  - 配置：image 存到 `~/.multi-cc-im/inbox/images/` (类似 INBOX_DIR pattern)
- **跨包风险**: 中 — im-lark 加 attachment download；bridge 加 image forward path；shared 加 image incoming msg 类型
- **回退**: incremental，每步独立可验证
- **跟 v1.1 设计兼容**: 不冲突；扩展 IncomingMessage 字段
- **关键 verify 需求**: cc Read 工具收到 send-text 路径后是否自动 trigger，还是需要用户 cc TUI 端确认？

### γ — base64 stdin inject — 不可行

- cc QueryEngine source verify `QueryEngine.ts:829` `case 'attachment'` 只 handle 3 类，**不含 image attachment**
- cc TUI / `--print` 模式都不接受外部 image inject
- 排除

### δ — fork lodestar 整套

- **工程量**: 5+ 天 (vendor 大量 wechat-Bun-runtime 风格代码 + TS-strict 化 + 跟 4 维 adapter 架构对齐)
- **跨包风险**: 极高 — 长期维护负担
- **跟项目「不造轮子用现有 SDK」原则**: 矛盾，lodestar 是另一项目实现，不是 SDK
- 排除

### ε — cc Agent SDK 程式化路径

- 起独立 cc 子进程注入 image attachment 作 SDK message — 破坏项目核心约束「不破坏现有 cc 进程，bridge 不 spawn 用户 cc 实例」（CLAUDE.md 头号原则）
- 排除

### ζ — 转发 image URL 不下载

- 飞书 image API 需 `Authorization: Bearer <tenant_access_token>` — 无 public URL
- 转给 cc Read 时 cc 不能带 bearer token 访问飞书 API
- 排除

---

## §3 对比矩阵

| 维度 | α 不做 | **β download+inject** | γ stdin | δ fork | ε SDK | ζ URL |
|---|---|---|---|---|---|---|
| UX 完整度 | 2/10 | **8/10** | — | 8/10 | 6/10 | — |
| 工程量（天） | 0 | **2-3** | — | 5+ | 3-4 | — |
| 可行性 | ✅ | **✅** | ❌ | ✅ | ⚠️（破核心约束） | ❌ |
| 跨包风险 | 极低 | **中** | — | 极高 | 高（破约束） | — |
| 跟核心约束 | ✅ | ✅ | — | ✅ | ❌ | — |
| Source verified | N/A | ✅ lodestar `feishu.ts:330` | — | ✅ | 部分 | — |
| 回退成本 | 0 | **低（incremental）** | — | 高 | 中 | — |

---

## §4 推荐 = β

| 理由 | 矩阵证据 |
|---|---|
| UX 真解决用户痛点 — 多设备协同 | UX 8/10 |
| 复用 P1 tenant-token + wezterm send-text 现有通路 | 现 P3+ verified |
| Source verified lodestar download pattern 可借鉴 | feishu.ts:330 |
| 不破核心约束（cc 进程 + 用 SDK） | β 跟约束 ✅ |
| 工程量中等可控 | 2-3 天 |
| γ/ζ 物理不可行；δ/ε 破约束 — 候选实际 2 选 1 (α vs β) | 矩阵列 |

---

## §5 用户决定

待用户拍板。3 个 actionable 选项：

| 选项 | 一句话 | 工程量 |
|---|---|---|
| α | 不做，user cc TUI 自己 paste 图 | 0 |
| **β (推荐)** | daemon 下载图 + wezterm send-text path 给 cc + cc Read 读图 | 2-3 天 |
| 推迟 | 先 v0.1.3 release autolink fix，image feature 下个 milestone | 0 |

### β 实施 task table（拍板后启动）

| # | 改动 | 文件 |
|---|---|---|
| 1 | shared `IncomingMessage` 加 `imagePaths?: string[]` 字段 | shared/types.ts |
| 2 | `tenant-token` reuse 实现 lark image download helper | im-lark/src/inbound-image.ts (new) |
| 3 | lark `onMessage` 检测 image_key → 调 download → IncomingMessage.imagePaths | im-lark/src/adapter.ts |
| 4 | orchestrator 收 imagePaths → wezterm send-text `@<path> 请看` | bridge/orchestrator.ts |
| 5 | tests (download + send + e2e mock) | *.test.ts |
| 6 | 4 维 verify + commit + PR + 真账号 smoke | Bash |
| 7 | DD doc 写入 conventions.md 修订记录 | docs/conventions.md |
