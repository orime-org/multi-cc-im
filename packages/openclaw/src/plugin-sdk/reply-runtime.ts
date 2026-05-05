/**
 * Shim for `openclaw/plugin-sdk/reply-runtime` —— 仅 type re-export。
 *
 * Vendored `messaging/send.ts` 仅访问 `payload.text` 字段。上游 ReplyPayload
 * 是含多种 outbound 消息变体的 union type，对 multi-cc-im wechat IM adapter
 * 我们仅要 text reply（其他媒体走 IMAdapter capability interfaces 处理），
 * 因此 partial type 足够。
 */

export interface ReplyPayload {
  /** 主文本内容（vendored send.ts 唯一访问的字段）。 */
  text?: string;
}
