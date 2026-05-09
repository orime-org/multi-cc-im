/**
 * Render an error including its cause chain.
 *
 * Node 22+ `fetch` rejects with a generic `Error: fetch failed` whose
 * `.cause` carries the real reason (`ECONNREFUSED`, `ETIMEDOUT`, undici
 * socket errors, TLS handshake failures, etc.). `String(err)` and the
 * default `err.message` both drop that, leaving `"fetch failed"` with no
 * diagnostic value. Walking the chain produces e.g.
 * `"fetch failed (cause: connect ECONNREFUSED 14.18.180.207:443 [code=ECONNREFUSED])"`.
 *
 * Depth-limited at 5 to avoid pathological circular chains.
 *
 * @param err - any thrown value (Error / string / number / object)
 * @returns formatted single-line string suitable for logging
 *
 * @example
 * ```ts
 * try {
 *   await fetch('https://example.invalid');
 * } catch (e) {
 *   logger.error(formatErrorWithCause(e));
 *   // → "fetch failed (cause: getaddrinfo ENOTFOUND example.invalid [code=ENOTFOUND])"
 * }
 * ```
 */
export function formatErrorWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let depth = 0;
  let cur: unknown = (err as Error & { cause?: unknown }).cause;
  while (cur !== undefined && cur !== null && depth < 5) {
    if (cur instanceof Error) {
      const code = (cur as Error & { code?: unknown }).code;
      const codeStr = typeof code === 'string' ? ` [code=${code}]` : '';
      parts.push(`cause: ${cur.message}${codeStr}`);
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      parts.push(`cause: ${String(cur)}`);
      break;
    }
    depth++;
  }
  return parts.length === 1 ? parts[0]! : `${parts[0]} (${parts.slice(1).join('; ')})`;
}
