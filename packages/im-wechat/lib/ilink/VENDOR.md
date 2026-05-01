# Vendored: Tencent/openclaw-weixin

`packages/im-wechat/lib/ilink/` 是从 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 抽取的协议层代码副本，**不是**原创代码。

## Origin

- **Upstream**: https://github.com/Tencent/openclaw-weixin
- **Pinned commit**: `6e58a2bcb505df2cad8ba396b8b58b18bbcb5777` (tag `v2.1.7`, 2026-04-07)
- **License**: MIT — 见 [`LICENSE.upstream`](./LICENSE.upstream)
- **Vendored at**: 2026-04-30

## Why vendor (not npm depend)

按 multi-cc-im DD 报告 [`docs/superpowers/specs/2026-04-26-ilink-library-dd.md`](../../../../docs/superpowers/specs/2026-04-26-ilink-library-dd.md) 锁定方案 A1 抽取 vendor。核心理由：

1. **官方源**（Tencent 维护）= 协议正确性最高（其他候选 photon-hq / crazynomad 都是逆向自此仓库）
2. **每子目录有 .test.ts** → 协议正确性可验证
3. **OpenClaw 插件框架依赖可抽离**（写 shim 替代）
4. **跟 npm depend 比，vendor 让我们能 cherry-pick upstream 修复 + 切断未跟进风险**

## Contents

8 个协议子目录（来自上游 `src/`）:

```
lib/ilink/
├── api/         # iLink HTTP endpoints（getUpdates / sendMessage 等）
├── auth/        # 扫码登录 / pairing / accounts
├── cdn/         # 媒体文件上传/下载 + AES-128-ECB 解密
├── messaging/   # 消息处理 / send / receive
├── media/       # silk 语音 / 图片 / 文件
├── util/        # logger / redact / format
├── storage/     # config-cache / sync-buf / context-token
├── config/      # 默认配置 + 常量
└── LICENSE.upstream  # MIT 原文
```

## Upstream changes 我们做的修改

为去除 OpenClaw 插件框架运行时依赖 + 满足 multi-cc-im strict TS（`noUncheckedIndexedAccess: true`），对 vendored 代码做了以下**最小**改动:

1. **OpenClaw runtime 解耦（5 个文件改 import）**
   - `auth/pairing.ts`、`auth/accounts.ts`、`messaging/send.ts`、`util/logger.ts` 改 `from "openclaw/..."` 为 tsconfig path alias `"openclaw/plugin-sdk/infra-runtime"` / `"openclaw/plugin-sdk/reply-runtime"`，由 `packages/im-wechat/tsconfig*.json` 的 `paths` 映射到 `src/openclaw-shim/`。
   - `auth/accounts.ts` 整体替换为最小版本（仅保留 `DEFAULT_BASE_URL` / `CDN_BASE_URL` / `deriveRawAccountId` / `loadConfigRouteTag` 4 个被 vendored 文件依赖的导出 — 上游的多账户索引 / 加密存储均由 multi-cc-im 替代实现）。
   - `messaging/process-message.ts` 删除（深度耦合 OpenClaw `channelRuntime` + 业务逻辑由 multi-cc-im bridge core 重写）。
2. **strict TS 兼容补丁（2 个文件、5 行）**
   - `media/mime.ts:63` — `mimeType.split(";")[0]` 加 `?? ""` 默认值（`noUncheckedIndexedAccess` 下 `[0]` 被推为 `string | undefined`）。
   - `util/logger.ts` — `LEVEL_IDS` 改成 `as const satisfies Record<...>` + 引入 `LogLevelName` keyof + `isLogLevelName` type guard，消除 4 处 `Record<string, number>` 索引返回 `number | undefined` 的报错。
   - 这两组补丁让 vendored code 能在 multi-cc-im 的 strict tsconfig 下 typecheck 干净；逻辑等价（不改变运行时行为）。
3. **`monitor/` 子目录不 vendor**（DD 锁定要重写为 EventEmitter 模式 → `packages/im-wechat/src/monitor.ts`）。
4. **`auth/account-index.test.ts` / `auth/account-store.test.ts` 删除**（测试上游多租户 store，被替换为 owner-only 单 account → `src/accounts.ts`）。
5. **`auth/pairing.test.ts` 改 mock 路径**（1 行）：`vi.mock("openclaw/plugin-sdk", …)` → `vi.mock("openclaw/plugin-sdk/infra-runtime", …)`，匹配 `pairing.ts` 实际 import 的 subpath（上游测试在 npm `openclaw` 包提供的 barrel 重导出下能拦截，我们的 shim 是单独 module，需要精确匹配 subpath）。

完整 diff 见 `git log packages/im-wechat/lib/ilink/`。Sync 时若 upstream 改动这 5 个补丁点，需人工合并保留我们的 strict-TS 形态。

## Sync workflow

更新 vendored code 时（upstream 出新 release）:

```bash
./scripts/sync-vendor-ilink.sh         # 拉新 commit + diff + 提示影响子目录
# 人工 review diff，cherry-pick 必要变更
# 重新跑 packages/im-wechat 的 vitest 验证 vendored test 仍通过
```

## License

MIT (Tencent 2026)。在 multi-cc-im 项目分发时**必须**保留 `LICENSE.upstream` 文件 + 本 VENDOR.md 的归属声明。
