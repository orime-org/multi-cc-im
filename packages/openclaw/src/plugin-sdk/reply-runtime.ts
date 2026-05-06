/**
 * Shim for `openclaw/plugin-sdk/reply-runtime` — type re-export only.
 *
 * The vendored `messaging/send.ts` only accesses `payload.text`. Upstream's
 * ReplyPayload is a union type covering several outbound message variants;
 * for the multi-cc-im wechat IM adapter we only need text replies (other
 * media flow through the IMAdapter capability interfaces), so the partial
 * type below is sufficient.
 */

export interface ReplyPayload {
  /** Primary text content (the only field accessed by the vendored send.ts). */
  text?: string;
}
