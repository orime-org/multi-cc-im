# cc Hook + wezterm cli 行为实测报告

**Topic**: 验证 multi-cc-im 项目 CLAUDE.md「关键设计假设」表里 ⚠️ 待实测的 5 条
**Date**: 2026-04-27
**cc 版本**: v2.1.119（claude-opus-4-7[1m] / Claude Max）
**wezterm 版本**: macOS Application bundle（`/Applications/WezTerm.app/Contents/MacOS/wezterm`）
**Status**: ✅ 已完成
**结论**: 6 项假设全部升 ✓；实测过程中额外发现 5 条**强制规范**需写入 CLAUDE.md

> 本报告对照 CLAUDE.md「关键设计假设」表的 ⚠️ 项做事实验证。不属于 5 步选型 DD（候选枚举 / 矩阵对比这两步在「事实验证」语境下不适用）；属于「假设 → 实测方法 → 实测结果 → 假设状态升级 + 设计层影响」的轻量 DD 流程。

---

## 决策摘要

| 维度 | 旧 ⚠️ | 新 ✓ | 关键事实 |
|---|---|---|---|
| 出站机制 | hook → HTTP POST 待实测 | ✓ | 5 类 hook stdin schema 全档案；UserPromptSubmit/Stop 等已含完整对话内容，**bridge 出站不需要 tail jsonl** |
| 入站机制 | send-text 转义规则待实测 | ✓ | 锁定**两步法**：默认 paste 内容 + `--no-paste $'\r'` 提交 |
| Idle 唤醒 | block→reason 行为待实测 | ✓ | cc 真把 reason 当下一轮 user prompt 注入；`stop_hook_active` 字段是原生死循环防护 |
| Session 标识 (WEZTERM_PANE) | hook 子进程能否看见待实测 | ✓ | hook env 完整继承 wezterm env，**路由 = O(1) env 读取**，不需要 list 解析 |
| jsonl schema | 实际字段待实测 | ✓ | 8 种 type / 30 字段全档案；usage 字段比假设复杂（service_tier / cache TTL 分级 / iterations）—— events 表 schema 需扩展 |
| pane-id 稳定性 | 重启后是否稳定待实测 | ✓ | 同 pane 重启 cc → pane-id 不变；新 tab 起 cc 得新 PANEID |

**额外强制规范（5 条，写入 CLAUDE.md）**:

1. **multi-cc-im hook 脚本不许往 stdout 写非协议输出** —— SessionStart hook stdout 会被 cc 当 system context 注入到上下文，烧 token + 行为不可预测
2. **idle 唤醒必须用 `stop_hook_active` 防死循环** —— stdin 字段比文件标记更可靠，零 race
3. **路由解析 = `WEZTERM_PANE` env**（O(1)），禁用 `wezterm cli list` 解析 cwd 反推（O(N)）
4. **路由前必须验证 pane 里 cc 还活着** —— pane 生命周期 ≠ cc 生命周期；`/exit` 后 pane 还在但里面是 zsh
5. **入站机制是两步 send-text**（不是单步带回车），命令模板见下文「入站锁定」

---

## 实测范围

针对 CLAUDE.md「关键设计假设」表的以下 ⚠️ 行（v0.2 状态）：

| 编号 | 旧假设 | 实测方法 |
|---|---|---|
| 出站机制 | cc Stop / UserPromptSubmit / PostToolUse hook → HTTP POST | H1 |
| Idle 唤醒 | Stop hook 返回 `{decision:"block", reason:"..."}` 注入 | H2 |
| Session 标识 | WEZTERM_PANE 在 hook 子进程的可用性 | H3 |
| Storage | tail jsonl 增量写 events 表；jsonl schema 稳定性 | H4 |
| 入站机制 | bridge 收微信 → wezterm cli send-text；注入语义 + 转义规则 | W1 |
| pane-id 稳定性 | 重启后是否稳定 | W2 |

---

## 实测方法

### 实测脚手架

- **位置**: `/tmp/cc-probe/`（独立 sandbox，跟 multi-cc-im 仓库隔离）
- **dumper**: `/tmp/cc-probe/hooks/dump.sh`（接收 hook stdin/env，写到 `dumps/<HookName>-<ts>.{stdin.json,env,pwd}`；H2 测试模式由文件标记 `.block-stop-once` 一次性触发）
- **配置**: `/tmp/cc-probe/.claude/settings.json` 注册 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop 五类 hook
- **触发动作**:
  - A1: 起 sandbox cc → SessionStart 一次
  - A2: 普通对话一轮（`你好，请用三个汉字回应：完成了` → "完成了"）→ UserPromptSubmit + Stop
  - A3: cc 调 Bash 工具一次 → UserPromptSubmit + PreToolUse + PostToolUse + Stop
  - A4 (H2): touch `.block-stop-once` → cc 处理 prompt → 第一次 Stop 触发 block → cc 续答 reason → 第二次 Stop（stop_hook_active=true）
  - A5: cc 退出（`/exit`）
  - B1: `wezterm cli list` 取 PANEID
  - B2: 4 个 send-text payload（普通文本 / 中文+emoji / shell 元字符 / 内嵌 \n）
  - B2 入站闭环: `send-text "<prompt>"` + `send-text --no-paste $'\r'` → 看 cc 是否真触发回应
  - B3 (W2): cc 重启 + 第二次 list 对比 PANEID

---

## 实测结果

### H1: 5 类 hook stdin schema 全档案

#### SessionStart

```json
{
  "session_id": "91215578-3606-4fe4-b01d-c436bf804790",
  "transcript_path": "/Users/songxiulei/.claude/projects/-private-tmp-cc-probe/<sid>.jsonl",
  "cwd": "/private/tmp/cc-probe",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-7[1m]"
}
```

关键字段：
- `session_id`: UUID v4，cc 主键
- `transcript_path`: cc 直接给绝对路径，**无需自己拼 `~/.claude/projects/<slug>/<sid>.jsonl` 规则**
- `cwd`: 已 realpath（`/tmp` → `/private/tmp`），跟 PWD env 不一致（见 H3）
- `source`: "startup" — 暗示还有 resume / restart 等其他值（待持续观察）
- `model`: 含 `[1m]` 后缀表示 1M context 模式

#### UserPromptSubmit

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/private/tmp/cc-probe",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "你好，请用三个汉字回应：完成了"
}
```

**关键发现**: 含 `prompt` 字段 = 完整用户输入文本。bridge 不需要 tail jsonl 就拿到 user 内容。

#### PreToolUse

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/private/tmp/cc-probe",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "ls /tmp/cc-probe/dumps/",
    "description": "List dumps directory"
  },
  "tool_use_id": "toolu_01HyCzR2NB7C5LL3t1ube8DY"
}
```

#### PostToolUse

```json
{
  "session_id": "...",
  "...": "...",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "ls ...", "description": "..." },
  "tool_response": {
    "stdout": "<完整 stdout>",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  },
  "tool_use_id": "toolu_...",
  "duration_ms": 1172
}
```

**关键发现**:
- `tool_response.stdout` = 工具完整输出
- `duration_ms` = 工具执行耗时（用于 analytics）
- `interrupted` / `isImage` / `noOutputExpected` 是 cc 内部状态字段

#### Stop（普通终态）

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/private/tmp/cc-probe",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "完成了"
}
```

#### Stop（block→reason 注入续答的二次 Stop）

```json
{
  "...": "（同上）",
  "stop_hook_active": true,         ← 关键：原生死循环防护字段
  "last_assistant_message": "收到了"  ← cc 对 reason 的回应
}
```

**关键发现**:
- `stop_hook_active`: false = 用户主动结束的 Stop，true = block→reason 注入链中的二次 Stop
- `last_assistant_message`: 直接给最后一条 assistant 文本，**bridge 出站不依赖 jsonl tail**

---

### H2: block→reason 完美注入（idle 唤醒可行）

**A4 实测过程**:
1. touch `/tmp/cc-probe/.block-stop-once`
2. 用户输入 `你好，回我 OK`
3. cc 回 `OK` → 第一次 Stop 触发
4. dumper 检测到标记，stdout 输出 `{"decision":"block","reason":"收到 probe 字串 UNIQUE_BLOCK_PROBE_1777260480，请用且仅用三个汉字回应这个 probe，不要做任何工具调用"}`，立即 `rm` 标记
5. cc TUI 显示：`Ran 10 stop hooks (ctrl+o to expand) → Stop hook error: 收到 probe 字串...`（"error" 是 cc 把 block 归类的 UX 提示，**功能正常**）
6. cc 自动续答 `**收到了**` —— 三汉字精确遵循 reason 指令（含"且仅用三个汉字" + "不要做任何工具调用"两个约束）
7. 第二次 Stop 触发，stdin 含 `stop_hook_active: true`

**时间线**: 第一次 Stop 11:28:00 → 第二次 Stop 11:28:08（cc 把 reason 当 user prompt 处理后 8 秒内完成续答）

**结论**: 假设完美成立。multi-cc-im 实施 idle 唤醒的标准模式：

```typescript
// 在 Stop hook 处理函数中
if (stdin.stop_hook_active) {
  return; // 已经在 block→reason 注入链中，不重复注入（防死循环）
}
const pendingPrompt = await peekPendingPromptFor(stdin.session_id);
if (pendingPrompt) {
  await markPromptConsumed(stdin.session_id, pendingPrompt.id);
  console.log(JSON.stringify({ decision: "block", reason: pendingPrompt.text }));
}
```

---

### H3: WEZTERM_PANE 完整继承 + cc 注入若干特殊 env

**SessionStart env 关键字段**:

```
WEZTERM_PANE=20
WEZTERM_UNIX_SOCKET=/Users/songxiulei/.local/share/wezterm/gui-sock-9131
WEZTERM_EXECUTABLE=/Applications/WezTerm.app/Contents/MacOS/wezterm-gui
WEZTERM_EXECUTABLE_DIR=/Applications/WezTerm.app/Contents/MacOS

CLAUDE_PROJECT_DIR=/private/tmp/cc-probe        ← 已 realpath
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_ENV_FILE=/Users/songxiulei/.claude/session-env/<sid>/sessionstart-hook-1.sh

PWD=/tmp/cc-probe                                ← shell 逻辑路径，未 realpath
TERM=xterm-256color
SHLVL=3
PATH=<cc 重组的，含 100+ plugin 的 bin/ 路径，不等于用户 shell PATH>
```

**关键发现**:

1. **`WEZTERM_PANE` 完整继承** ✓ —— 跟 `wezterm cli list` 输出的 PANEID 100% 一致（验证两次：旧 cc session=91215578 / 新 cc session=394d5ea8 都是 PANEID 20）。multi-cc-im 路由解析直接读这个 env 即可，O(1)。
2. **`WEZTERM_UNIX_SOCKET` 也在** —— 未来如果不走 `wezterm cli` subprocess 而是直接 RPC 通信，这条暗示了路径
3. **PATH 跟 user shell PATH 不一样** —— cc 注入了 100+ plugin 的 `bin/` 路径，**不含 `wezterm`**。multi-cc-im 的 hook 脚本调 wezterm 必须用**启动时探测 + 缓存**的路径变量（不能假设 `wezterm` 在 PATH 里，也**不能 hardcode 绝对路径** —— 开源项目用户安装位置不一）。详见 [`docs/architecture.md` 「外部 CLI 工具路径策略」](../../architecture.md#外部-cli-工具路径策略)
4. **`CLAUDE_PROJECT_DIR` 已 realpath，`PWD` 是逻辑路径** —— macOS `/tmp` → `/private/tmp` symlink。multi-cc-im 路由解析 key 必须用 `CLAUDE_PROJECT_DIR` 或 `stdin.cwd`，**不要用 PWD**
5. **`CLAUDE_ENV_FILE`** —— cc 给每个 session × hook 类型生成一个 env 文件 `~/.claude/session-env/<sid>/sessionstart-hook-1.sh`，可能跟 hook 间共享状态有关，v1 不一定用，记录在案

---

### H4: jsonl 结构远超假设的复杂度

**8 种 type / 30 个顶层字段**（68 行 jsonl 全档案）：

| Type | 计数（A2+A3+A4 全跑后） | multi-cc-im 关心吗 |
|---|---|---|
| `assistant` | 6 | ✓ 主线对话 |
| `user` | 5 | ✓ 主线对话 |
| `system`（subtype=`stop_hook_summary`） | 6 | ✓ hook 触发档案 + 健康监控 |
| `attachment` | 43 | 部分（仅 SessionStart hook stdout 安全审计） |
| `tool_use` / `tool_result`（嵌在 `message.content[]` 数组里）| 多次 | ✓ 工具调用追踪 |
| `permission-mode` | 3 | ✓ mode 切换要 ack 给微信 |
| `last-prompt` | 2 | ✗ cc 内部缓存 |
| `file-history-snapshot` | 3 | ✗ cc 内部文件追踪 |

**字段命名混杂三套**:

| 来源 | 风格 | 例 |
|---|---|---|
| Hook stdin | snake_case | `session_id`, `hook_event_name`, `last_assistant_message`, `stop_hook_active` |
| jsonl 顶层 | camelCase | `parentUuid`, `promptId`, `sessionId`, `gitBranch`, `isSidechain`, `userType` |
| Anthropic API 嵌套 | snake_case | `input_tokens`, `cache_read_input_tokens`, `tool_use_id`, `is_error` |

→ multi-cc-im 的 zod schema **必须分三套处理**。共享一套 schema = 一定踩坑。

#### usage 字段实样（assistant 消息）

```json
"usage": {
  "input_tokens": 6,
  "output_tokens": 8,
  "cache_read_input_tokens": 26471,
  "cache_creation_input_tokens": 38522,
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 38522,
    "ephemeral_5m_input_tokens": 0
  },
  "iterations": [
    {
      "input_tokens": 6,
      "output_tokens": 8,
      "cache_read_input_tokens": 26471,
      "cache_creation_input_tokens": 38522,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 38522 },
      "type": "message"
    }
  ],
  "speed": "standard"
}
```

**多于原 CLAUDE.md events 表假设的字段**:

- `service_tier`: standard / priority — **价格不同**
- `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`: cache TTL 分级，**价格不同**
- `iterations[]`: 一次 assistant 消息可能由多次 API 调用累积；正确 token 统计要 sum iterations
- `speed`: standard 还是 priority？跟 service_tier 关系待观察

#### conversation tree 结构

每条 user/assistant 都带 `parentUuid` + `isSidechain`：
- `parentUuid` 形成对话树（不是简单线性链）
- `isSidechain: true` = subagent 子线
- v1 仅消费 `isSidechain: false` 主线即可

#### system 消息 = hook 触发档案

```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 10,
  "hookInfos": [
    {"command": "/tmp/cc-probe/hooks/dump.sh Stop", "durationMs": 54},
    {"command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh\"", "durationMs": 53},
    {"command": "uv run ${CLAUDE_PLUGIN_ROOT}/skills/analyzing-data/scripts/cli.py stop", "durationMs": 458}
    // ... 共 10 个 plugin hook
  ],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": true,
  "level": "suggestion"
}
```

→ multi-cc-im **不需要自己监控 hook 健康**，jsonl 自带。本次 dumper durationMs=54 远低于「同步阻塞 hook > 1s 禁止」红线 ✓。

#### 🚨 attachment = hook stdout 全档案（含安全警告）

```json
{
  "type": "attachment",
  "attachment": {
    "type": "hook_success",
    "hookName": "SessionStart:startup",
    "hookEvent": "SessionStart",
    "stdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"<这段会被 cc 当 system context 注入>\"}}",
    "stderr": "...",
    "exitCode": 0,
    "command": "<hook 命令>",
    "durationMs": 353
  }
}
```

**重大发现**: cc 启动时把每个 plugin 的 SessionStart hook **stdout** 当 `additionalContext` **注入到自己的 system context**。本次 sandbox cc 启动 `cache_creation_input_tokens=38522` 全是 5+ 个 plugin SessionStart hook 注入的（explanatory output style 提示 / superpowers using-superpowers skill 全文 / 上次 session summary 等）。

→ **multi-cc-im 自己的 hook 脚本绝对不能往 stdout 写日志/调试信息**。受控 JSON（`{"decision":"block","reason":"..."}`）除外。其他一律走 stderr 或文件。否则会污染 cc 上下文 → 不可预测行为 + 烧 token。

> 本次实测的 dumper 是 `cat > 文件` 写 stdin、`env > 文件` 写 env，**没误写 stdout**，所以没踩雷。这条规则要写进 CLAUDE.md「关键规范」。

#### message.content 是 union type（schema 教训）

挖 jsonl 时 `jq` 报错 `Cannot index string with number` 揭示：

- user 消息有时 `message.content` 是字符串 `"你好..."`，有时是数组 `[{type:"text", text:"..."}]`
- assistant 消息一律是数组

→ multi-cc-im zod schema 必须用 union：

```typescript
const ContentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional(), /* ... */ }))
]);
```

---

### W1: send-text 注入语义全景

#### 4 个 payload + 入站闭环

| Payload | 输入框看到 | 是否提交 | 异常 |
|---|---|---|---|
| `hello-probe-1` | 完整保留 | 否 | 无 |
| `微信测试 ✨ probe-3` | Unicode 中文 + emoji 完整 | 否 | 无 |
| `echo "hello $world \`pwd\`" probe-4` | 完整保留，**`$world` / `\`pwd\`` / `"` 全部原样**（cc TUI 不解释 shell 元字符） | 否 | 无 |
| `test-newline-only\n` | 文本 + 光标到下一行 | **否** | 无 — paste 模式吃掉 \n 语义 |
| `\x03` (Ctrl+C) | 跳过测试 | — | 无业务价值（multi-cc-im 不会发 Ctrl+C） |

#### 入站闭环测试

**步骤**:
1. `wezterm cli send-text --pane-id 20 "你好，回我 hi"` （默认 paste 模式）
2. `sleep 0.5`
3. `wezterm cli send-text --pane-id 20 --no-paste $'\r'` （**关键 --no-paste**）

**结果**:
- cc TUI 显示 `›  你好，回我 hi` 作为 user prompt
- cc Cogitate ~28s
- cc 输出 `● hi`
- Stop hook 触发：stdin 显示 `last_assistant_message: "hi"`, `stop_hook_active: false`
- jsonl 主线: `{type:"assistant", text:"hi", model:"claude-opus-4-7"}`
- system summary: `hookCount=10, hookErrors=[], preventedContinuation=false`

#### 入站机制锁定（命令模板）

```bash
# 前置：$WEZTERM 由启动时探测得出（见 docs/architecture.md「外部 CLI 工具路径策略」）
#       禁止 hardcode 绝对路径 —— cc hook 子进程 PATH 不含 wezterm，用户安装位置不一

# Step 1: paste prompt 内容（默认 paste 模式 = 安全）
#   - bracketed paste 包装（\e[200~ ... \e[201~），cc TUI 识别后整体粘贴
#   - 内容里的任意 \n / shell 元字符 / Unicode / emoji 全部原样保留
#   - 不会因 \n 误触发提交
"$WEZTERM" cli send-text --pane-id "$P" "<prompt 含任意 \n>"
sleep 0.3   # 等 cc TUI 处理 paste（render 时间）

# Step 2: 单独发回车触发提交（必须 --no-paste）
#   - --no-paste 关掉 bracketed paste，\r 直接到 TUI 当键盘事件
#   - 默认 paste 模式发 \r 也被吃掉，不触发回车
"$WEZTERM" cli send-text --pane-id "$P" --no-paste $'\r'
```

**为什么必须分两步**:

| 混用方式 | 后果 |
|---|---|
| 把 prompt + \r 一次性默认模式 paste | \r 被包装成 paste 字符，**不触发提交** |
| 把 prompt 用 --no-paste 发 | cc TUI 把 prompt 里的特殊字符当快捷键解释（潜在注入攻击面） |
| 正确：默认 paste 内容 + --no-paste 发 \r | 内容安全 + 提交可控 ✓ |

---

### W2: pane-id 在同 pane 重启 cc 不变

**实测过程**:

| 步骤 | session_id | PANEID | 备注 |
|---|---|---|---|
| 1. sandbox cc 跑 A1-A4 | `91215578-...` | 20 | TITLE = cc 取的对话标题 |
| 2. `/exit` 退出 | — | 20 | **pane 不消失**，回到 zsh，TITLE 变空 |
| 3. 同 pane 跑 `claude` 重启 | `394d5ea8-...` | 20 | TITLE = "Claude Code"（cc 默认） |
| 4. 第二次 SessionStart env | — | `WEZTERM_PANE=20` | 跟 list 一致 ✓ |

**结论**:

- 同 pane 重启 cc → pane-id 不变（pane 是 wezterm 容器，cc 是里面跑的程序）
- session_id 必变 → multi-cc-im 路由主键应是 `session_id`，pane_id 是瞬时路由值
- TITLE 字段是 cc 自取的对话标题，**不可作为 cc 是否活着的可靠信号**

**意外发现 — pane lifecycle ≠ cc lifecycle**:

`/exit` 后 pane 还在但里面跑的是 zsh，不是 cc。如果 multi-cc-im 此时用 send-text 注入 prompt 到 PANEID 20，**会发到 zsh shell**（zsh 把它当 shell 命令执行 → 各种意想不到的副作用）！

→ multi-cc-im 路由前**必须验证 pane 里 cc 还活着**。可选策略（v1 实施时再 DD）:

- 选项 a: hook 触发记录 → bridge 内存维护「session_id → 最近活跃时间」，超时（比如 5 分钟无 UserPromptSubmit/Stop）标记 inactive
- 选项 b: 探测 cc 进程 pid（每个 cc 注册 pid 到 keychain 或文件）
- 选项 c: 用 cc 自身的 SessionEnd hook（cc 文档存在的话；本次实测未观察）

> 注：`/exit` **不触发 Stop hook**（Stop hook 语义是「assistant 单轮回合结束」而非「session 结束」）。这是预期行为，不是问题，但多了一项约束 —— bridge 不能用 Stop hook 判定 session 结束。

---

## 假设状态升级（patch 进 CLAUDE.md「关键设计假设」表）

| 维度 | 旧 | 新 | 证据 |
|---|---|---|---|
| 出站机制 | ⚠️ | ✓ | dumps/{SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop}-*.stdin.json 5 类全档案 + system stop_hook_summary（H1 + H2） |
| 入站机制 | ⚠️ | ✓ | W1 4 payload + 入站闭环（默认 paste prompt + `--no-paste $'\r'` 提交）|
| Idle 唤醒 | ⚠️ | ✓ | A4 cc 自动续 "收到了" 三汉字遵循 reason；二次 Stop stdin `stop_hook_active=true` 防死循环原生字段 |
| Session 标识（WEZTERM_PANE 可见性） | ⚠️ | ✓ | SessionStart env: WEZTERM_PANE=20，跟 wezterm cli list 100% 一致 |
| Storage（jsonl schema） | ⚠️ | ✓ | jsonl 8 种 type / 30 字段全档案；events 表 schema 需扩展（service_tier / cache TTL 分级 / parent_uuid / is_sidechain） |
| pane-id 稳定性 | ⚠️ | ✓ | 同 pane 重启 cc → PANEID 不变；新 tab 起 cc 会得新 PANEID |

---

## 设计层影响（5 条新规则，写入 CLAUDE.md「关键规范」+「禁止清单」）

### 1. hook 脚本不许写非协议 stdout（关键规范）

multi-cc-im 自己的 hook 脚本**绝对不能**往 stdout 写日志/调试/状态信息。否则 cc 会把它当 system context 注入到上下文（attachment 机制），烧 token + 行为不可预测。

**允许的 stdout**: 受控协议 JSON，例如 `{"decision":"block","reason":"..."}`
**禁止的 stdout**: 任何其他 echo / printf / console.log

**应该写到**: stderr（cc 不读）或文件

### 2. idle 唤醒用 stop_hook_active 防死循环（关键规范）

```typescript
if (stdin.stop_hook_active) return;  // 在 block→reason 注入链中，不重复注入
```

不要用文件标记（race-prone）。stdin 字段是 cc 原生的、零 race。

### 3. 路由解析 = WEZTERM_PANE env，不是 list 解析（关键规范）

multi-cc-im 路由 session → pane 必须从 hook env 读 `WEZTERM_PANE`，不要跑 `wezterm cli list` 解析 cwd 反推 pane-id（O(N) + 可能多个 cc 同 cwd）。

### 4. 路由前必须验证 pane 里 cc 活着（关键规范）

pane lifecycle ≠ cc lifecycle。路由前必须验证目标 pane 里 cc 还在跑（具体策略 v1 实施 DD）。否则 send-text 会注入到 zsh shell。

### 5. 入站机制是两步 send-text（关键规范精确化）

替代原 CLAUDE.md「send-text 注入必须转义」那条粗略规范。精确化为：

```bash
# $WEZTERM 由启动探测得出（见 docs/architecture.md「外部 CLI 工具路径策略」）
# Step 1: 默认 paste 模式发内容（含任意 \n / 元字符 / Unicode）
"$WEZTERM" cli send-text --pane-id "$P" "<prompt>"
sleep 0.3
# Step 2: --no-paste 模式发回车触发提交
"$WEZTERM" cli send-text --pane-id "$P" --no-paste $'\r'
```

混用 `--no-paste` 发内容是**潜在注入攻击面**（cc TUI 把 prompt 里特殊字符当快捷键）。

---

## events 表 schema 修订建议（patch CLAUDE.md SQLite Schema 节）

原 schema:
```sql
tokens_in INT, tokens_out INT, tokens_cache_read INT, tokens_cache_create INT,
```

修订为:
```sql
tokens_in INT,
tokens_out INT,
tokens_cache_read INT,
tokens_cache_5m_create INT,         -- ephemeral_5m_input_tokens
tokens_cache_1h_create INT,         -- ephemeral_1h_input_tokens（价格不同）
service_tier TEXT,                   -- standard | priority（价格不同）
parent_uuid TEXT,                    -- jsonl 对话树关联
is_sidechain INTEGER NOT NULL DEFAULT 0,  -- 0=主线，1=subagent 子线
iterations_json TEXT,                -- 多次 API 调用历史（JSON 数组）
```

理由：
- `tokens_cache_create` 拆 5m/1h 两档，因为 cache TTL 不同价格不同
- `service_tier` 加上以正确计算 cost
- `parent_uuid` + `is_sidechain` 让 events 表能表达 conversation tree（v1 仅消费 is_sidechain=0）
- `iterations_json` 兜底（一条 assistant 可能 N 次 API 调用，sum iterations 才是真实 token）

---

## 实测产物归档

- **DD 报告**（本文件）—— 进 git，永久参考
- **实测脚手架**（不进 git，保留备查或随时清理）:
  - `/tmp/cc-probe/hooks/dump.sh` — hook dumper
  - `/tmp/cc-probe/.claude/settings.json` — sandbox cc hook 配置
  - `/tmp/cc-probe/README.md` — 操作指引（实测过程参考）
  - `/tmp/cc-probe/dumps/` — hook stdin/env/pwd 全档案 + 两次 wezterm list 输出
  - `~/.claude/projects/-private-tmp-cc-probe/<sid>.jsonl` — sandbox cc 自己的 transcript（H4 数据源）

实测产物**清理命令**: `rm -rf /tmp/cc-probe/`（DD 报告里关键 schema 已永久保存，sandbox 用完即弃）

---

## 风险与遗留

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| cc 版本变化（>v2.1.119）导致 hook stdin schema 变化 | 中 | 中 | DD 报告里记录了 cc v2.1.119 实样；升级时复测；zod schema 用 `.passthrough()` 容忍未知字段 |
| cc 加新 hook 类型（SessionEnd 等）需要补测 | 中 | 低 | 实施时观察 cc release notes |
| jsonl 加新 type 让 multi-cc-im tailer 报错 | 中 | 低 | tailer 必须**只过滤想要的 type**（assistant/user/system），不报错处理未知 type |
| `WEZTERM_PANE` 在某些 wezterm 版本/配置下缺失 | 低 | 高 | hook 启动时校验该字段存在；缺失则 **fail-fast**（dumper 报错并退出非零，触发 cc UI 提示用户检查 wezterm 版本）。禁止 fallback 用 list 解析（违反「路由解析 = WEZTERM_PANE env」规范） |
| 用户机器 wezterm 安装在非标准位置 | 中 | 低 | 启动探测 + 缓存策略（见 [`docs/architecture.md`](../../architecture.md) 「外部 CLI 工具路径策略」节）；探测失败 fail-fast 引导用户 |
| pane lifecycle ≠ cc lifecycle 导致路由打到 zsh | 中 | **高** | v1 实施时**必做**「pane 活性验证」DD（见上文 W2 选项 a/b/c） |

---

## 链接

- multi-cc-im CLAUDE.md：「关键设计假设」表（本 DD 报告的输入与产出）
- iLink DD 报告（同级，已完成）：[`docs/superpowers/specs/2026-04-26-ilink-library-dd.md`](2026-04-26-ilink-library-dd.md)
- cc Hook 文档：https://docs.anthropic.com/en/docs/claude-code/hooks
- WezTerm CLI 文档：https://wezterm.org/cli/cli/index.html
- WezTerm send-text 命令：https://wezterm.org/cli/cli/send-text.html
