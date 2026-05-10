/**
 * Truncate `text` to at most `max` characters. When the input exceeds
 * `max`, the last character is replaced with the `…` ellipsis so the
 * returned string is exactly `max` characters wide. When the input is
 * already within the budget, it is returned unchanged.
 *
 * Used by:
 * - orchestrator log lines (paneId / reply / dispatch summaries)
 * - router echo lines (raw IM message excerpt + AI-routed intent excerpt)
 *
 * @param text Source string. Counted by JS code units (UTF-16) — sufficient
 *             for our IM message previews; surrogate-pair edge cases may
 *             leave a half-character before the ellipsis but never crash.
 * @param max  Maximum character count of the returned string. Must be
 *             positive; callers pass small constants (20 / 40 / 80 / 120).
 * @returns    `text` if `text.length <= max`; otherwise `text.slice(0, max-1) + '…'`.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
