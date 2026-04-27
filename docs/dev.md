# 开发命令 + TDD 节奏

> v0 设计阶段尚无业务代码。本文是规划版命令清单 + TDD 实施规范，待 monorepo 初始化时按此落地。

## 命令清单（计划）

```bash
pnpm install               # 装依赖
pnpm dev                   # turbo 启所有包 watch
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm test --coverage       # 覆盖率（c8/istanbul）
pnpm test --watch          # TDD 红→绿循环用
pnpm build                 # tsup 编译所有 package 到 dist/
pnpm bridge:start          # 启动 bridge 主进程
pnpm bridge:hook-install   # 把 SessionStart/Stop/... 写入 ~/.claude/settings.json
pnpm bridge:wechat-login   # 扫码登录 iLink，存 bot_token 到 OS keychain
pnpm bridge:cli-resolve    # 探测并写入外部 CLI 路径（wezterm 等）到 config.toml
```

## 启动前置

1. macOS（v1 仅支持 macOS）
2. wezterm 已安装（可选路径见 [`architecture.md`](architecture.md)「外部 CLI 工具路径策略」节）
3. claude（cc）已登录
4. iLink bot 已申请（`pnpm bridge:wechat-login` 引导）

---

# TDD 写代码节奏（强制）

CLAUDE.md「关键规范」「TDD 红→绿→蓝节奏」条的具体实施。任何业务代码（含 adapter 实现 / core 路由 / analytics）都走此节奏。

## 三步循环

每个 feature / bug fix / 重构都走完整三步：

### 1. 红 (RED) — 先写会失败的测试

- 用测试**描述目标行为**（不是验证已有实现）
- 跑 `pnpm test` 确认测试**真的失败**——失败原因要明确（功能未实现 / 行为不符），不是 setup 错误（import 错 / 路径错 / 异步未 await）
- 一次只让一个测试 fail，避免多个 fail 互相掩盖

### 2. 绿 (GREEN) — 写最少代码让测试通过

- **不许"顺手"加额外功能**（违反「精准修改」准则）
- **不许写"未来可能用得上"的抽象**（违反「简单优先」准则）
- 跑测试，确认从 RED 转 GREEN
- 此阶段代码丑没关系，重构在第 3 步

### 3. 蓝 (REFACTOR) — 重构 + 覆盖率

- 测试为绿的前提下重构，不允许引入 RED
- 验证覆盖率 ≥ 80%（`pnpm test --coverage`）
- 提交前完整跑一遍：`pnpm typecheck && pnpm test && pnpm lint`
- commit message 描述"做什么 + 为什么"，不要描述"怎么做"（diff 已经说明）

## TDD 跟 DD 的衔接（重要）

```
DD 锁定方案 → TDD 红 → TDD 绿 → TDD 蓝 → commit → CI
   ↑                                          ↓
   └─── 实测发现 DD 假设错（测试无论如何写不通）┘
```

- DD 假设的行为 → 转成测试 codify
- TDD 实施中发现假设错（测试**无论如何**写不通） → **停下重做 DD**，不在错假设上打补丁
- 这是「禁止补丁」硬规则的 TDD 落地形式

## 测试类型分布（参考）

| 类型 | 占比 | 工具 | 何时用 |
|---|---|---|---|
| 单元测试 | 60-70% | vitest | 函数 / 类 / utility |
| 集成测试 | 20-30% | vitest + better-sqlite3 in-memory | adapter ↔ adapter / adapter ↔ DB |
| E2E 测试 | <10% | （v1 后再加，先 skip） | 关键用户流（@session 路由 / idle 唤醒）|

> 80% 是**最低**门槛，不是目标。关键路径（路由 / idle 唤醒 / send-text 注入 / hook stdin 解析 / iLink 长轮询 cursor）应当 100%。

## 适配器层 TDD 注意

每个 adapter 实现接口（`packages/shared/`）必须有：

1. **Contract 测试**：跑在 mock 实现上，验证 adapter 行为符合接口契约（这部分被所有 adapter 共享，提到 `packages/shared/src/__tests__/contracts/`）
2. **集成测试**：跑在真实 / 测试容器实现上（如 `term-wezterm` 用真 wezterm 跑，`storage-sqlite` 用 in-memory SQLite）

## 反 TDD 模式（一律违规）

- **先写实现再补测试**：测试覆盖代码而非行为，倾向 confirm 已有结果（confirmation bias）
- **测试只断言 happy path**：边界 case / 错误 case 全漏，覆盖率虚高（80% 凑数 != 80% 有效）
- **测试 mocking 一切**：测的是 mock 行为不是真实行为（"mocked tests passed but prod migration failed" 经典反例 — 数据库类测试**禁止**全 mock，要用 in-memory SQLite 或 testcontainers）
- **跳过红色直接绿色**：违反"先看到失败再修"原则；可能把 setup 错误（import 错路径）误判成成功
- **测试名描述实现而非行为**：`test('calls foo() then bar()')` ❌ → `test('routes message to active session')` ✓

## 覆盖率工具

```bash
pnpm test --coverage   # 输出到 coverage/index.html
```

vitest 默认用 c8（v8 内置覆盖率），无需额外配置。CI 集成时把 coverage threshold 设 80% 强制。

## TDD vs 事实验证 DD 的边界

- **TDD**：测的是**自己写的代码**（`packages/*/src/`）
- **事实验证 DD**：测的是**外部库 / cc / 协议**的假设是否成立（如 hook+wezterm 实测）

两者节奏类似（red→green）但范围不同。事实验证 DD 不需要追求 80% 覆盖率，只需要"假设是否成立"明确即可。
