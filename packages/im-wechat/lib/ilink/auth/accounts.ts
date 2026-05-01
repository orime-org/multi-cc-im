/**
 * Multi-cc-im replacement for upstream `auth/accounts.ts`.
 *
 * 上游版本含 19 个 OpenClaw runtime references (PluginRuntime, OpenClawConfig,
 * normalizeAccountId, getWeixinRuntime, etc) 服务 OpenClaw plugin framework
 * 的多租户 account 模型。Multi-cc-im 是 owner-only 单 account（CLAUDE.md
 * 「关键设计假设」表 ACL 行 + 多机硬约束 ✓ 已锁），因此 drop 所有 OpenClaw
 * 耦合代码，只保留以下 4 个**纯协议层 utility exports**（被 vendored
 * `api/api.ts` / `storage/sync-buf.ts` / `config/config-schema.ts` 引用）:
 *
 *   - DEFAULT_BASE_URL / CDN_BASE_URL — iLink 协议端点常量
 *   - deriveRawAccountId() — 纯字符串变换（normalized ID ↔ raw ID 反查）
 *   - loadConfigRouteTag() — stub 返回 undefined（multi-cc-im 不用 SKRouteTag）
 *
 * 真实的 account resolution（哪个账号 / token 从哪取 / state dir 在哪）走
 * `packages/im-wechat/src/accounts.ts` 的 ConfigStore-driven 实现，跟 vendored
 * 协议层解耦。
 */

/** iLink getupdates / sendmessage 默认 endpoint。 */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** iLink 媒体 CDN 默认 endpoint。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * 把 normalized account ID 反推回 upstream 的 "raw" 形态。
 *
 * 上游 sync-buf.ts 用此函数做向后兼容文件路径 lookup —— 老版本上游用
 * "b0f5860fdecb@im.bot" 这种含 @ 的 raw ID 当文件名，新版本规范化为
 * "b0f5860fdecb-im-bot"。读 syncbuf 时如果找不到 normalized 文件名，
 * 用 derive 出的 raw 文件名做 fallback。
 *
 * Pure function — 无 OpenClaw / fs / state 依赖，可安全移植。
 *
 * @example
 *   deriveRawAccountId("b0f5860fdecb-im-bot")    // → "b0f5860fdecb@im.bot"
 *   deriveRawAccountId("b0f5860fdecb-im-wechat") // → "b0f5860fdecb@im.wechat"
 *   deriveRawAccountId("default")                // → undefined（无 -im- 后缀）
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith('-im-bot')) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith('-im-wechat')) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

/**
 * 上游：从 OpenClawConfig 读 `channels.openclaw-weixin.routeTag` 给 iLink HTTP
 * 请求加 `SKRouteTag` header（多租户分流）。
 *
 * Multi-cc-im 是单租户、owner-only，**不用 SKRouteTag** —— 默认路由够。
 * 这里 stub 返回 undefined，vendored `api.ts:buildBaseHeaders()` 会跳过加 header。
 *
 * 未来如果需要 routeTag override（比如 multi-cc-im 加 OpenClaw-style 多账号），
 * 在 multi-cc-im 自己的 ConfigStore 里加 `[wechat.route_tag]` 字段 + 这里读取。
 *
 * @param _accountId 上游签名包含此参数；我们无视
 */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}
