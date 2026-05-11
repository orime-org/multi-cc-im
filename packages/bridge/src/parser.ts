/**
 * Parse an IM message text into one of these routing-relevant shapes:
 *
 * - `plain`           — no leading `#` or `/`; body either dispatched via AI
 *                        routing (default) or to `current_session` if AI
 *                        routing disabled. (Per [DD: AI-routed IM dispatch](../../../docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md))
 * - `mention`         — leading `#<name>` (one or more space-separated); body
 *                        to those targets
 * - `broadcast`       — `#all` alone or with body; fan-out to all alive
 *                        sessions
 * - `bridge_command`  — leading bare `/<command> [args]` (e.g. `/list`,
 *                        `/start`, `/start off`, `/stop`, `/help`, `/current`).
 *                        Per DD #73 (AI-routed dispatch): bare-slash syntax.
 * - `permission_response` — `#<tab> /1` (allow) or `#<tab> /2` (deny)
 * - `error`           — malformed (e.g. `#all` mixed with named mentions,
 *                        or bare `/` with empty command)
 *
 * Mentions are recognized **only at message start**, separated by whitespace.
 * `#<name>` mid-message is treated as plain text (matches IM convention; cf.
 * Discord/Slack mention parsers).
 *
 * Per [DD: routing symbol change 2026-05-12](../../../docs/superpowers/specs/2026-05-12-routing-symbol-change-dd.md):
 * prefix changed from `@` to `#` because Feishu (and most modern IMs) rewrite
 * `@` into a user-mention picker / mention object — bridge parser never saw
 * the literal `@<tab>` string the user typed. `#` has no inline parsing in
 * any target IM and follows Slack/Discord/IRC channel-marker convention.
 * The original DD G' (`2026-05-04-routing-syntax-dd.md`) had `@list` /
 * `@help` / `@current` as bareword keywords; those were dropped in v1 due
 * to collision with cc tab titles. The legacy v1.4 `@multi-cc-im /<cmd>`
 * bridge command form was already replaced by bare `/<cmd>` (DD #73) and
 * is unaffected by the symbol change.
 */

const ALL_TOKEN = 'all';

export type ParsedMessage =
  | { type: 'plain'; body: string }
  | { type: 'mention'; mentions: string[]; body: string }
  | { type: 'broadcast'; body: string }
  | { type: 'bridge_command'; command: string; args: string }
  | { type: 'permission_response'; tabName: string; decision: 'allow' | 'deny' }
  | { type: 'error'; message: string };

export function parse(rawText: string): ParsedMessage {
  const text = rawText.replace(/^[\s ]+/, '');

  if (text.length === 0) return { type: 'plain', body: '' };

  // Bare `/<command>` → daemon command (per DD #73). User types just `/list`,
  // `/start`, `/start off`, `/stop`, etc. Bare /X never forwards to cc TUI as
  // a slash command — to forward `/clear` etc. to cc, use `#<tab> /clear`.
  if (text.startsWith('/')) {
    const afterSlash = text.slice(1);
    const spaceIdx = afterSlash.search(/\s/);
    const command =
      spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : afterSlash.slice(spaceIdx).trim();
    if (command.length === 0) {
      return {
        type: 'error',
        message: 'expected /<command> after `/`',
      };
    }
    return { type: 'bridge_command', command, args };
  }

  if (!text.startsWith('#')) {
    return { type: 'plain', body: rawText.trim() === '' ? '' : rawText };
  }

  // Tokenize the leading run of `#<name>` patterns separated by spaces / tabs.
  // Stop at the first non-`#` token (or end-of-string).
  const mentions: string[] = [];
  let cursor = 0;

  while (cursor < text.length && text[cursor] === '#') {
    // Find end of this `#<name>` token: next whitespace or end-of-string.
    const tokenStart = cursor + 1;
    let tokenEnd = tokenStart;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd += 1;
    const token = text.slice(tokenStart, tokenEnd);
    if (token.length === 0) break; // bare `#` followed by space → not a mention
    mentions.push(token);
    cursor = tokenEnd;
    // Skip whitespace between mentions (but only spaces/tabs — newlines end
    // the mention block and start the body)
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
      cursor += 1;
    }
  }

  const body = text.slice(cursor);

  if (mentions.length === 0) {
    // Leading `#` but no real name parsed (e.g. just `#`)
    return { type: 'plain', body: rawText };
  }

  // Permission response: `#<tabname> /1` (allow) or `#<tabname> /2` (deny).
  // Per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md).
  // Single tabname mention + body is exactly `/1` or `/2` → permission
  // response. (`/3` etc. fall through to the regular cc-slash forward
  // case so cc TUI sees them as unknown command.)
  if (mentions.length === 1 && mentions[0] !== ALL_TOKEN) {
    const trimmedBody = body.trim();
    if (trimmedBody === '/1') {
      return { type: 'permission_response', tabName: mentions[0]!, decision: 'allow' };
    }
    if (trimmedBody === '/2') {
      return { type: 'permission_response', tabName: mentions[0]!, decision: 'deny' };
    }
  }

  // Broadcast: #all is exclusive — error if mixed with named mentions
  const allCount = mentions.filter((m) => m === ALL_TOKEN).length;
  if (allCount > 0) {
    if (mentions.length !== allCount) {
      return {
        type: 'error',
        message: '#all is exclusive — cannot combine with #<name>',
      };
    }
    return { type: 'broadcast', body };
  }

  return { type: 'mention', mentions, body };
}
