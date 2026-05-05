# 路由语法 DD 报告

**Topic**: multi-cc-im 微信端用户怎么写消息让 bridge 派给 N 个 cc session 中的特定一个或多个
**Date**: 2026-05-04 起草 + 锁定
**Status**: ✅ 已锁定
**结论**: 选定 **G' 组合方案** —— tmux 4 级 fallback + 空格分多目标 + last-explicit-mention 粘性默认（带 visible echo）+ `@all` 广播 + `@list/@help/@current` 控制命令。决议详情见文末「第 6 步」。第 1-5 步保留作 DD 流程证据档。

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走完。触发启发式：「影响范围超过单个 package」（router 是 bridge core 核心，syntax 跨 docs / wechat / 未来 tg/飞书）+「反悔代价 > 1 周」（用户学了的语法改了 = 习惯破坏）。
>
> Memory 规则「DD 候选枚举必须含'不做 X'」遵守：候选 A 是「不做路由前缀，单 cc 假设 / wezterm tab 切换替代」。

---

## 决策上下文

CLAUDE.md「关键设计假设」表当前：

```markdown
| 路由语法（`@a` 前缀 / 模糊匹配 / 多播 / 粘性默认） | ? | 用户最终 sign-off |
```

这是 **4 个独立设计决策**捆在一行 ?：
1. 触发字符（`@` vs `/` vs `#` vs 无前缀）
2. 匹配方式（精确 / 前缀 / 模糊 / 数字索引 / session-id hash）
3. 多目标语法（如何写 `@a + @b`、是否支持 `@all`）
4. 无前缀消息的归属（粘性默认 / 上次接收方 / 第一个 session / 全广播 / 报错）

每决策可独立选，但用户体验是一体的——所以一并 DD 拍板。

### 范围限定

- **本 DD 只决路由语法的 spelling / parsing / matching layer**。回复消息的 formatting（多目标回复时是否带 `[frontend]` 标识来源）是另一议题。
- **不做** session 列表 / friendly_name 配置 UX（已有 ConfigStore [friendly_names] section + `friendly_name` 类型）。
- **不做** 路由失败的兜底动作（dead session 时返回 pending-msg 队列等，已有 Storage DD A 模式覆盖）。

### 真实使用场景

| 场景 | 占比（估计）| 理想 UX |
|---|---|---|
| 同时只 1 个 cc 跑 | ~50% | 不写前缀，消息全部归唯一 cc |
| 2-3 个 cc 平行干活，对话集中在一个 | ~30% | 一句 `@frontend` 切到目标后免前缀连续聊 |
| 2-3 个 cc 来回切 | ~15% | 每条都带短前缀（1-2 字符）|
| > 5 个 cc 大批量 | ~5% | 多播或 `@all` 偶尔下指令 |

约束：微信纯文本输入（**没有 autocomplete UI**），用户在手机敲字慢、容易 typo，需要短前缀 + 容错。

---

## 第 1 步：候选枚举

按 CLAUDE.md「反 DD 模式」"跳过候选枚举只列 2-3 个 → 假对比" + memory「不做 X」规则：

| ID | 候选 | 一句话描述 |
|---|---|---|
| **A** | **不做路由（单 cc / wezterm tab 切换替代）** | bridge 只对接当下 active wezterm pane；多 cc 用户自己切 tab，不在消息里加前缀 |
| B | tmux 风格 4 级 fallback 单目标 | `@<id>` / `@=name` / `@<exact>` / `@<prefix>` / `@<glob>`；歧义报错列候选；无粘性 |
| C | Copilot Chat 风格强制完整名 | 仅 `@frontend` 完整名；无粘性、无多播；歧义不存在 |
| D | IM 风格多目标 | `@a @b 同步实现`（空格分多 @）；单 @ 单目标；独立 `@all` 广播 |
| E | 粘性默认 + 显式切换 | bot 维护 current_session；无前缀=默认；`@name` 切换并粘住；可见反馈 `→ frontend` |
| F | 歧义回选 | `@fr` 多匹配 → bot 回"1 frontend / 2 frame，回数字"；下一条数字选 |
| **G'** | **B + D + E + `@all` 组合** | tmux 4 级 fallback + 空格分多目标 + 粘性默认（带可见反馈）+ `@all` 广播 |

进 DD 第 2-4 步：**A / B / C / D / E / G'** 六个真候选。

**透明排除**（不进对比矩阵）:

| 候选 | 排除理由（含证据）|
|---|---|
| **F 歧义回选** | 多一次往返（bot 问 → 用户回数字），手机端比直接打长前缀还慢；fzf/Slack popup 之所以 work 是因为 GUI 一次性弹出可见列表，纯文本两步对话失去这个优势。可作 G' 的歧义兜底 UI（但 G' 默认是"歧义报错列候选"，跟 tmux 一致），不单做主方案 |
| **前缀模糊 + 自动挑第一** | 调研结果：**业界一致拒绝**——tmux / screen / Vim / Bash / aider / Slack / fzf 全部歧义即拒，没有先例采用"自动选"。误发风险高（cc 收到跨 session 的指令上下文断裂） |
| **逗号分隔多目标** | 中英文逗号混淆 + 跟正文逗号歧义。空格分多 @ 是 Discord/Slack 用户认知零成本 |
| **复合 boolean 路由**（`@a&!@b`）| Discord/Slack 拒绝过此类提案，认知成本太高 |

---

## 第 2 步：尽调（A / B / C / D / E / G'）

### 5 维度

| 维度 | 含义 |
|---|---|
| **手机敲字成本** | 单条消息平均要敲多少字符的路由开销（不算正文） |
| **歧义失败模式** | 多 session 名前缀冲突时会发生什么（误发 vs 报错 vs 二次确认） |
| **隐式状态成本** | 用户脑子里要记多少 client-side context（"上次说过谁了"等）才能避免误发 |
| **多目标支持** | 一条消息发给 N 个 session 是否可能、UX 如何 |
| **业界先例数** | 类似 UX 已被多少主流工具实证支撑 |

### 候选 A：不做路由

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **0** —— 完全免前缀 |
| 歧义失败模式 | **N/A** —— 只有 1 个 cc target（active pane） |
| 隐式状态成本 | 重 —— "current active wezterm pane" 状态在 wezterm 那边，用户切 pane 时容易忘自己当前在哪个 tab；微信端无反馈 |
| 多目标 | **不支持** |
| 实证 | aider / Cursor 单 tab / Cline CLI 用 tmux pane 替代 = 工业界普遍做法 |

**致命问题**：multi-cc-im 的核心价值就是"在公司控制台 + 外面微信"双端访问 N 个 session。A 把多目标问题完全交给 wezterm = 退化为单 cc bridge = **价值蒸发**。仅作 DD 流程候选，不会真选。

### 候选 B：tmux 4 级 fallback 单目标

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **低** —— `@f 帮我看` 一字符前缀通常够（前缀唯一） |
| 歧义失败模式 | **优** —— 跟 tmux 一致，多匹配报错 + 列出候选 |
| 隐式状态成本 | 0 —— 每条消息显式 @；无客户端状态 |
| 多目标 | **不支持** |
| 实证 | tmux 13 年 + screen/Vim/aider 同理念 = 业界金标准 |

**特点**：完全显式、可预测、零状态。**缺点**：每条消息都带前缀，跟单 cc 场景（占比 ~50%）的 UX 不友好（用户觉得"明明只一个为啥还要 @"）。

### 候选 C：Copilot Chat 风格强制完整名

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **高** —— `@frontend` 比 `@f` 长 7 字符；中文 friendly_name 要中英切换 |
| 歧义失败模式 | **N/A** —— 完整名无歧义 |
| 隐式状态成本 | 0 |
| 多目标 | 不支持（Copilot 仅单 participant） |
| 实证 | GitHub Copilot Chat = 工业界最相关案例 |

**优点**：可预测、零歧义。**缺点**：手机端长 friendly_name 是 UX 灾难，且单 cc 场景跟 B 一样累赘。

### 候选 D：IM 风格多目标 `@a @b`

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **低-中** —— 单目标 `@a 帮我看`；多目标 `@a @b 帮我看` |
| 歧义失败模式 | 取决于匹配子策略（DD 没指定，是 D 的弱点） |
| 隐式状态成本 | 0 |
| 多目标 | **支持** —— 空格分多 @ |
| 实证 | Discord/Slack 多 @、pssh `-H "h1 h2"` 空格分隔 = IM 用户认知零成本 |

**特点**：多目标自然。**缺点**：D 单独不规定匹配策略；落地仍要选 B/C 之一作匹配子策略，否则歧义无章法。

### 候选 E：粘性默认 + 显式切换

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **极低** —— 切目标后大量消息免前缀（90% 场景符合） |
| 歧义失败模式 | 切换时按 B/C 同样规则；切换后误发到旧 target 是状态错配 |
| 隐式状态成本 | **中** —— 必须可见反馈（bot 回 `→ frontend received`）才不炸雷；调研显示业界对自动粘性"接 last-spoke session"较保守 |
| 多目标 | 取决于是否合 D；E 单独不规定 |
| 实证 | irssi `/query`、weechat current buffer = 已用 30 年；但都是 GUI 客户端，纯文本场景较少 |

**关键 UX 决策**：粘性的"粘住对象"是什么？
- E.1 **last-explicit-mention**: 用户上次显式 `@frontend` 后，所有无前缀消息发到 frontend，直到下次 `@xxx` 切换。**安全**：只有用户主动切才变。
- E.2 **last-replied-to**: cc 回复后那个 session 自动作下次 default。**危险**：用户可能不记得最后回复的是哪个 session（特别多 cc 异步回复时）。

E.1 比 E.2 安全 100 倍。多数粘性方案（IRC `/query`）实际是 E.1。E.2 类似 Cline #3514 教训（[multi-instance sync 引发激烈反弹](https://github.com/cline/cline/issues/3514)），**不要做**。

### 候选 G'：B + D + E + `@all`

```
默认状态：current_session = null

无前缀消息：
  - current_session 已设 → 派给 current_session（带 visible echo）
  - current_session 未设 → 报错"no current session, send `@<name>` first or `@list`"

@<name>:
  - tmux 4 级 fallback (id → exact → prefix → glob)
  - 唯一匹配 → 设 current_session + 派当前消息
  - 歧义 → 报错列候选 + 不切换不派发
  - 不存在 → 报错列所有 session

@a @b 多目标:
  - 每个独立 4 级 fallback
  - 任一歧义 / 不存在 → 整条报错
  - 不修改 current_session
  - 派给所有目标，回复带 [name] 前缀来源标识

@all:
  - 派给所有活 session（PaneAlive 真）
  - 不修改 current_session

@list / @help:
  - 控制命令，bot 回当前 session 列表 + current_session

session 死掉自动行为:
  - PaneAlive 状态机判 dead → 若 current_session === dead → unset current
  - 配套 visible 反馈：bot 提示"frontend disconnected, current cleared"
```

| 维度 | 评估 |
|---|---|
| 手机敲字成本 | **极低** —— 单 cc 0 前缀；多 cc 切换后免前缀；多目标支持 |
| 歧义失败模式 | **优** —— tmux 风报错列候选；用户能学会 |
| 隐式状态成本 | **中** —— current_session 状态有 visible echo 兜底（bot 反馈每条消息归属）|
| 多目标 | **支持** —— D 风格 |
| 实证 | tmux + irssi + Slack 多 @ 都被 13+ 年实战验证；G' 是组合不是发明 |

---

## 第 3 步：对比矩阵

| 维度 | A 不做 | B tmux 单目标 | C 完整名 | D IM 多 @ | E 粘性 | **G' 组合** |
|---|---|---|---|---|---|---|
| 单 cc 场景敲字 | 0 | `@a 文` | `@frontend 文` | `@a 文` | 切后 0 / 切前 `@a 文` | **0**（current 自动 = 唯一 cc） |
| 多 cc 切来切去 | N/A | `@a 文` `@b 文` `@a 文`... | `@frontend ...` ×N | `@a 文` `@b 文`... | 切后免前缀；切前 `@a` | **同 E** |
| 多目标 | ❌ | ❌ | ❌ | ✅ `@a @b` | 取决子策略 | ✅ `@a @b` |
| 广播 | ❌ | ❌ | ❌ | 取决 `@all` 是否单列 | 取决子策略 | ✅ `@all` |
| 歧义处理 | N/A | 报错列候选 | N/A 无歧义 | 未规定 | 取决子策略 | **报错列候选**（同 B） |
| 隐式状态 | wezterm pane（用户记错炸雷） | 0 | 0 | 0 | last-explicit（安全）/ last-reply（炸雷）| last-explicit 安全式 |
| 反馈机制 | ❌ 微信端无反馈 | 默认无（出错才回）| 同 B | 同 B | **必须** visible echo | **必须** visible echo |
| 实证先例 | aider / Cursor / Cline tmux | tmux 13 年 + screen/Vim/aider | Copilot Chat | Discord/Slack/pssh | irssi 30 年 / weechat | 组合 = 上述 4 项各自实证 |
| 反模式 | 退化单 cc bridge ❌ | 单 cc 累赘 | 长名手机不友好 | 子策略未定 | 自动 last-reply 粘性危险 | 跟 last-explicit 强绑定 |
| 实施复杂度 | 0 | 中 | 低 | 中 | 中 | **高**（4 决策叠加 + visible echo state machine）|

矩阵证据出处：
- 「tmux 13 年金标准」: [tmux man — OpenBSD](https://man.openbsd.org/tmux.1) 4 级 fallback + 歧义 ambiguous 拒
- 「业界拒绝前缀模糊自动挑第一」: [Vim PR #14082](https://groups.google.com/g/vim_dev/c/bKs_zNAbPAw)、[GNU screen man](https://www.gnu.org/software/screen/manual/screen.html)、[fzf 不替用户拍](https://github.com/junegunn/fzf)
- 「last-reply 粘性炸雷」: [Cline #3514 multi-instance sync 反弹](https://github.com/cline/cline/issues/3514)
- 「空格分多 @」: [Discord 多 @](https://support.discord.com/hc/en-us/community/posts/360057705171-Seperating-Mention-everyone-here-and-Mention-All-Roles)、[pssh -H 空格](https://linux.die.net/man/1/pssh)
- 「Copilot Chat single participant」: [GitHub Copilot Chat cheat sheet](https://docs.github.com/en/copilot/reference/chat-cheat-sheet)
- 「irssi /query 粘性目标」: [irssi /query help](https://irssi.org/documentation/help/query/)
- 「Telegram 强制 chat_id 拒粘性」: [Telegram core/bots](https://core.telegram.org/bots)

---

## 第 4 步：推荐 + 理由

**推荐 G' 组合方案**。三条决定性理由：

### 1. 单 cc 场景（占 ~50%）必须 0 敲字成本，多 cc 场景（~50%）必须可短前缀切换

A 给单 cc 0 前缀但牺牲多 cc；B/C 给多 cc 显式但单 cc 累赘；只有 E（粘性）+ B（tmux fallback）能两边都对：
- 单 cc：current_session 自动 = 唯一 cc → 无前缀消息全派给它
- 多 cc：`@<前缀>` 切换后免前缀连续聊；偶尔切换敲字成本极低（1-2 字符）

### 2. tmux 4 级 fallback 是业界唯一被广泛采用的"前缀短 + 歧义安全"方案

调研显示**没有任何主流系统采用"前缀模糊 + 自动挑第一"**——tmux/screen/Vim/Bash/aider/Slack/fzf 全部歧义即拒，13+ 年实证。我们直接 port 不踩坑：

```
@<input>:
  1. 以 $ 开头 → 当 session_id（cc UUID v4 短 hash）
  2. =name 强制精确
  3. 否则精确名 (case-sensitive)
  4. 否则前缀匹配 (短前缀 friendly_name 匹配)
  5. 否则 fnmatch glob (`@*frontend*`)
  6. 多匹配 → 报错 + 列候选
```

CLAUDE.md 状态表原话"模糊匹配"在工业实证下应理解为"短前缀匹配 + 歧义拒"，**不是**"模糊编辑距离"。

### 3. 粘性默认必须配 visible echo 否则炸雷；且粘性策略只能是 last-explicit-mention

业界唯一安全的粘性方案是 last-explicit-mention（用户主动 `@xxx` 后 current 才变）。last-reply-to-this-session 粘性已被 Cline 用户大规模反弹证伪。

visible echo 形态：bot 在每条 outbound 消息前加 `→ frontend` 或类似 metadata；切换时确认 `📌 current = frontend`；session 死掉提示 `⚠️ frontend disconnected, current cleared`。这是"隐式状态炸雷"的唯一对策。

### 已知风险 + 缓解

| 风险 | 缓解 |
|---|---|
| **粘性 current 跟用户脑模型错配**（用户以为 current 是 X 实际是 Y）| visible echo 每条消息提示当前归属；用户能 1 秒发现错配并 `@xxx` 修正 |
| **多目标回复混乱**（多 cc 异步回复，用户分不清谁说的）| 回复消息前缀 `[frontend]` `[api]` 来源标识；本 DD 范围外 |
| **friendly_name 跟 cc 默认 cwd basename 冲突**（如两个 cc 都在 `frontend/` 目录下） | `friendly_name` 用户配，session_id 短 hash 兜底；cwd basename 仅作建议 default |
| **`@all` 误用风险**（手抖发送大批 cc）| `@all` 单独词 token，不能跟其他 `@` 混；可加 config option "broadcast_confirm" 二次确认（v2） |
| **session 数为 0**（用户从未启动 cc）| bot 回 `no active sessions, start cc in any wezterm tab first` |

### 排除其他候选的最强单条论据

- **A**：把 multi-cc-im 价值蒸发；回 wezterm tab 切换跟"在外面用微信"完全冲突
- **B**：单 cc 场景每条 `@a` 累赘；用户 50% 时间没必要带前缀
- **C**：手机端长名敲字 + 中英切换灾难
- **D 单独**：匹配子策略未定，等于半个方案，必须合 B/C 一起讨论
- **E 单独**：粘性切换的匹配仍要 B/C 子策略；E + B = G' 的子集

---

## 第 5 步：留待用户决定

### 主决策

1. **采纳 G' 组合方案？** 强推 G'，但 A/B/C/D/E 都列出供 sign-off 比较

### G' 内部 5 个子决策

如果 sign-off G'，下面 5 个子决策也需要拍板：

| # | 子决策 | 推荐 | 备选 |
|---|---|---|---|
| 1 | 触发字符 | `@` | `/`（cc TUI 已用，冲突）/ `#`（不直观）/ 其他 |
| 2 | 粘性策略 | last-explicit-mention | last-reply-to（**反对**：Cline 反弹证伪）|
| 3 | 多目标分隔 | 空格分多 `@`（Discord/Slack/pssh） | 逗号（中英文歧义）/ 多个分号 |
| 4 | 广播 token | `@all` | `@everyone`（Discord 习惯）/ `@*`（glob 风格）|
| 5 | 控制命令 | `@list` `@help` `@current` | 单独前缀 `/` 引导（跟 cc TUI 冲突，反对）|

### 锁定后要写入 CLAUDE.md 的内容

如选 G'，"关键设计假设" 表对应行更新：

```markdown
| 路由语法 | ✓ | **G' 组合**：`@<name>` tmux 4 级 fallback（id/exact/prefix/glob，歧义报错列候选）+ 空格分多目标 + last-explicit-mention 粘性默认（带 visible echo）+ `@all` 广播 + `@list/@help/@current` 控制命令；session 死自动 unset current；[DD: 路由语法](docs/superpowers/specs/2026-05-04-routing-syntax-dd.md) |
```

"关键规范" 表追加一行：

```markdown
| **路由 visible echo 必须有** | bot 派给 cc 前必须给微信端可见反馈（`→ frontend received` / `📌 current = frontend` / `⚠️ frontend disconnected`），否则用户脑模型跟 current_session 状态会错配 |
```

"禁止清单" 追加：

```markdown
| 自动 last-reply-to 粘性（错把 cc 最后回复的 session 当 current_session）| Cline #3514 反弹证伪 |
| 前缀模糊 + 自动挑第一（歧义时不报错） | tmux/screen/Vim/aider 全行业拒绝 |
```

---

## 第 6 步：决议（2026-05-04 用户拍板）

PR #18 merge 即用户对第 4 步推荐 G' 默认接受（DD 流程历史 PR #2 / #3 / #6 / #7 / #11 同样模式）。本节固化决议，作为 bridge core router 实施 PR 的引用锚点。

### 主决策

✅ 采纳 **G' 组合方案** —— tmux 4 级 fallback + 空格分多目标 + last-explicit-mention 粘性默认（带 visible echo）+ `@all` 广播 + `@list/@help/@current` 控制命令。

### G' 5 子决策

| # | 子决策 | 锁定 | 锁定理由 |
|---|---|---|---|
| 1 | 触发字符 | **`@`** | IM 用户认知零成本（Slack/Discord/Telegram/微信）；`/` 跟 cc TUI 子命令冲突；`#` 在 IM 中是话题/引用语义不直观 |
| 2 | 粘性策略 | **last-explicit-mention** | irssi /query 30 年实证；last-reply-to 已被 Cline #3514 用户反弹证伪 |
| 3 | 多目标分隔 | **空格分多 `@`**（`@a @b ...`） | Discord / Slack / pssh -H 事实标准；中英文逗号在中文 IM 跟正文歧义 |
| 4 | 广播 token | **`@all`** | 跟 `@<name>` 同 `@` 触发字符家族保持一致；`@everyone` 太长；`@*` glob 跟 4 级 fallback 第 5 级 glob 撞车 |
| 5 | 控制命令 | **`@list` `@help` `@current`** | 沿用 `@` 触发字符；`/` 引导跟 cc TUI 冲突 |

### 已写入 CLAUDE.md（本 PR 同 commit）

1. **「关键设计假设」表 路由语法** 行：? → ✓ 锁定 G' 完整描述
2. **「关键规范」追加** 「路由 visible echo 必须有」
3. **「禁止清单」追加** 两项：自动 last-reply-to 粘性 + 前缀模糊自动挑第一

### 未来如要回归其他候选的触发条件

G' 的潜在脆弱点是粘性带来的隐式状态。如果出现下列情况，可重新开 DD 评估：
- 用户报告 current_session 错配频繁（visible echo 没起预防作用）→ 考虑回 B（tmux 风格无粘性，每条显式 @）
- 多用户场景（owner-only 假设破裂）→ 粘性是 per-user 状态，多用户共用一个 bridge 时粘性无意义
- 微信增加 autocomplete 等 GUI 辅助 → 可考虑回 D（IM 风格多目标无粘性，依赖 GUI 消歧）

回归路径：本 DD 已穷举 6 真候选 + 3 反模式排除，重新评估时不必从零。

---

## 参考资料

完整调研证据见研究 agent 输出（含 36+ 直接 citation）。要点链接：

- [tmux man (OpenBSD)](https://man.openbsd.org/tmux.1) — 4 级 fallback target-session
- [GitHub Copilot Chat cheat sheet](https://docs.github.com/en/copilot/reference/chat-cheat-sheet) — `@participant` 单参与者
- [Vim PR #14082](https://groups.google.com/g/vim_dev/c/bKs_zNAbPAw) — buffer 完成歧义即拒
- [Cline #3514](https://github.com/cline/cline/issues/3514) — last-reply 粘性反弹证伪
- [Discord 多 @](https://support.discord.com/hc/en-us/community/posts/360057705171-Seperating-Mention-everyone-here-and-Mention-All-Roles)
- [irssi /query](https://irssi.org/documentation/help/query/) — 粘性 query window
- [pssh man](https://linux.die.net/man/1/pssh) — 空格分多目标
- [fzf](https://github.com/junegunn/fzf) — 不替用户拍，让用户最终确认

研究截止 2026-05-04。所有 commit hash / star / docs 数据为当天直接查询。
