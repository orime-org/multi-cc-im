# 开发命令 · TDD 节奏 · 调试

> **⚠️ v1.5 transitional state（2026-05-09）**：本文大部分调试 / 故障排查段是 v1.4 wechat 时代的真实经验。M1 wechat purge（DD #86 §11.2）已删 wechat 路径；M2-M8 lark adapter 完成后本文会更新。当前 daemon 不可运行（无 IM adapter），直到 M2 落地。

> 本文是 v1 实施后的真实命令清单。新人 onboard 可对着跑。

## 快速跑通

```bash
# 1. 装依赖
pnpm install

# 2. 全量验证
pnpm typecheck                       # 8 workspaces tsc --noEmit
pnpm test                            # 58 文件 / 821 单测
pnpm test:coverage                   # 同上 + v8 coverage（80% 阈值）

# 3. 构建生产 bundle（hook 冷启动从 ~1s 降到 ~50ms — 实际部署必跑）
pnpm --filter multi-cc-im build      # tsup → apps/multi-cc-im/dist/cli.js
```

## CLI 子命令（apps/multi-cc-im）

```bash
./bin/multi-cc-im start              # 启动 daemon（Ctrl+C graceful shutdown）
./bin/multi-cc-im login wechat       # iLink 扫码登录，存 0600 凭据
./bin/multi-cc-im setup-hooks        # 把 4 个 hook 命令幂等合并到 ~/.claude/settings.json
./bin/multi-cc-im cleanup            # 扫 ~/.multi-cc-im/state/ 删完成 session + orphan
./bin/multi-cc-im cleanup --dry-run  # 预览不删
./bin/multi-cc-im hook <event>       # 内部 hook 入口（cc 调，不要手动跑）
```

`bin/multi-cc-im` bash wrapper 自动选 prod/dev：

- 有 `apps/multi-cc-im/dist/cli.js` → prod 模式（`node dist/cli.js`，~50ms 冷启动）
- 没 dist → dev 模式（`tsx src/cli.ts`，~300-1500ms，hook 起来肉眼可见延迟）

dev 等价命令：`pnpm --filter multi-cc-im dev <subcommand>`。

## 单包 / 单文件测试

```bash
# 单包
pnpm --filter @multi-cc-im/bridge test
pnpm --filter @multi-cc-im/cli-cc test

# 单文件 / 一组 pattern
pnpm exec vitest run packages/bridge/src/router.test.ts
pnpm exec vitest run apps/multi-cc-im/src/setup-hooks.test.ts

# watch 模式（TDD 红→绿循环）
pnpm exec vitest packages/bridge/src/router.test.ts
```

## 启动前置（首次跑 daemon）

1. macOS（v1 仅支持 macOS — Linux 待测）
2. wezterm 已装（`brew install --cask wezterm`）
3. cc 已登录（`claude` 在某个 wezterm tab 里能起）
4. iLink bot 已扫码登录（`./bin/multi-cc-im login wechat`）
5. cc settings.json 已合并 multi-cc-im hook（`./bin/multi-cc-im setup-hooks`）

---

# TDD 写代码节奏（强制）

CLAUDE.md「关键规范」「TDD 红→绿→蓝节奏」条的具体实施。任何业务代码（含 adapter 实现 / bridge 路由 / hook receiver）都走此节奏。

## 三步循环

### 1. 红 (RED) — 先写会失败的测试

- 用测试**描述目标行为**（不是验证已有实现）
- 跑 `pnpm test` 确认测试**真的失败** —— 失败原因要明确（功能未实现 / 行为不符），不是 setup 错误（import 错 / 路径错 / 异步未 await）
- 一次只让一个测试 fail，避免多个 fail 互相掩盖

### 2. 绿 (GREEN) — 写最少代码让测试通过

- **不许"顺手"加额外功能**（违反「精准修改」准则）
- **不许写"未来可能用得上"的抽象**（违反「简单优先」准则）
- 跑测试，确认从 RED 转 GREEN
- 此阶段代码丑没关系，重构在第 3 步

### 3. 蓝 (REFACTOR) — 重构 + 覆盖率

- 测试为绿的前提下重构，不允许引入 RED
- 验证覆盖率 ≥ 80%（`pnpm test:coverage`）
- 提交前完整跑：`pnpm typecheck && pnpm test`
- commit message 描述"做什么 + 为什么"，不要描述"怎么做"（diff 已经说明）

## TDD 跟 DD 的衔接

```
DD 锁定方案 → TDD 红 → TDD 绿 → TDD 蓝 → commit → CI
   ↑                                          ↓
   └─── 实测发现 DD 假设错（测试无论如何写不通）┘
```

- DD 假设的行为 → 转成测试 codify
- TDD 实施中发现假设错（测试**无论如何**写不通） → **停下重做 DD**，不在错假设上打补丁
- 这是「禁止补丁」硬规则的 TDD 落地形式

## 测试类型分布

| 类型 | 占比 | 工具 | 何时用 |
|---|---|---|---|
| 单元测试 | 60-70% | vitest | 函数 / 类 / utility |
| 集成测试 | 20-30% | vitest + 真 fs (mkdtemp 沙盒) | adapter ↔ adapter / chokidar ↔ state files / orchestrator e2e |
| E2E 测试 | <10% | （v1 后再加） | 关键用户流（@session 路由 / permission gate / cc Stop forward） |

> 80% 是**最低**门槛。关键路径（路由 / send-text 注入两步法 / hook stdin 解析 / iLink 长轮询 cursor / permission gate poll/timeout）应当 100%。

## 反 TDD 模式（一律违规）

- **先写实现再补测试**：测试覆盖代码而非行为，倾向 confirm 已有结果（confirmation bias）
- **测试只断言 happy path**：边界 case / 错误 case 全漏，覆盖率虚高
- **测试 mocking 一切**：测的是 mock 行为不是真实行为（CLAUDE.md memory: "execFile {input} 在 macOS 不可靠 close stdin" — 真集成跑通才能发现这种 footgun）
- **跳过红色直接绿色**：违反"先看到失败再修"原则；可能把 setup 错误（import 错路径）误判成成功
- **测试名描述实现而非行为**：`test('calls foo() then bar()')` ❌ → `test('routes message to active session')` ✓

## TDD vs 事实验证 DD 的边界

- **TDD**：测的是**自己写的代码**（`packages/*/src/`）
- **事实验证 DD**：测的是**外部库 / cc / 协议**的假设是否成立（如 hook+wezterm 实测、cc PreToolUse 协议字段实测）

两者节奏类似（red→green）但范围不同。事实验证 DD 不需要追求 80% 覆盖率，只需要"假设是否成立"明确即可。

---

# 调试技巧

## daemon 跑了但微信不收消息

按这个顺序排查：

```bash
# 1. daemon 起来了吗？看日志
tail -f ~/.multi-cc-im/logs/multi-cc-im-$(date +%F).log

# 2. iLink 长轮询 cursor 在动吗？
ls -la ~/.multi-cc-im/state/wechat-cursor

# 3. 凭据还活着吗？（bot_token 可能过期）
ls -la ~/.multi-cc-im/credentials/wechat.json   # mode 必须 -rw-------

# 4. cc hook 真触发了吗？
ls ~/.multi-cc-im/state/                         # 应该看到 <sid>.SessionStart 等文件
```

## 验证 cc hook 已配置

```bash
# 看 settings.json 有没有 multi-cc-im hook
jq '.hooks' ~/.claude/settings.json
# 应该看到 SessionStart / PreToolUse / Stop / SessionEnd 4 个 event 各一条 multi-cc-im hook 命令

# 重新合并（已存在的不动，只补缺失 / 替换 stale 路径）
./bin/multi-cc-im setup-hooks
```

setup-hooks 改写之前会自动备份 `~/.claude/settings.json` 到 `settings.json.bak.<ISO>`，要回退就 `cp` 回去。

## 看 hook payload 实际长啥样

cc hook 只能通过 stdin 收 payload。手动模拟：

```bash
echo '{"hook_event_name":"SessionStart","session_id":"...","cwd":"/tmp/x","transcript_path":"/tmp/t.jsonl","source":"startup","model":"claude-opus-4-7"}' \
  | ./bin/multi-cc-im hook SessionStart
ls ~/.multi-cc-im/state/
```

实际 cc 触发的 payload 也写到 jsonl 里：`~/.claude/projects/<slug>/<sid>.jsonl`（只读，不要改）。

## state dir 累积怎么办

```bash
./bin/multi-cc-im cleanup --dry-run   # 看会删什么
./bin/multi-cc-im cleanup             # 实删
```

`cleanup` 安全可在 daemon 运行时跑 —— 只删配对的 SessionStart+SessionEnd（cc 已死且 daemon 已不再路由），不动 lone SessionStart（cc 可能还活着）。

## 微信端 routing echo 看不见

每条入站消息都应该有 visible echo（CLAUDE.md "routing visible echo required" 硬规则）。如果你 `@frontend hello` 发了但微信没收到 `→ frontend received` 类反馈：

1. 看 daemon log 有没有 `[wechat → frontend]` 行
2. 看 `wezterm cli list --format json` —— 有没有叫 `frontend` 的 tab？
3. 没有 → 进 cc TUI 跑 `/rename frontend`，再发一次（tab title 实时 poll，不用重启 daemon）

## permission gate 用不了

`@frontend /1` 没生效有几种可能：

1. **没绑过 wechat origin**：你最近**没**从微信发过给 `frontend`，所以 `pendingReplyCtxBySession` 里没存 replyCtx → daemon 拿到 PreToolUse 后 log "no wechat origin"，hook 30s timeout default-allow。**解法**：先发个 `@frontend ping` 绑一下。
2. **多个 cc 同时跑工具**：cc 对同一 session 串行 PreToolUse，但**多 session 并发**时 `/1` 必须带 tab name 区分（`@frontend /1` 不是裸 `/1`）
3. **超过 30s**：默认放行了，hook 已退出，再发 `/1` 没 polling 进程读取（state-sweep 会把孤儿 Response 文件清掉）
