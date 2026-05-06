/**
 * Parse a wechat message text into one of 4 routing-relevant shapes per
 * [DD: routing-syntax](../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md)
 * G' lock-in:
 *
 * - `plain`     — no leading `@`; body forwarded to `current_session`
 * - `mention`   — leading `@<name>` (one or more space-separated); body to
 *                 those targets
 * - `broadcast` — `@all` alone or with body; fan-out to all alive sessions
 * - `control`   — `@list` / `@help` / `@current`, no body
 * - `error`     — malformed (e.g. `@all` mixed with named mentions)
 *
 * Mentions are recognized **only at message start**, separated by whitespace.
 * `@<name>` mid-message is treated as plain text (matches IM convention; cf.
 * Discord/Slack mention parsers).
 */

const CONTROL_COMMANDS = new Set(['list', 'help', 'current'] as const);
type ControlCommand = 'list' | 'help' | 'current';

export type ParsedMessage =
  | { type: 'plain'; body: string }
  | { type: 'mention'; mentions: string[]; body: string }
  | { type: 'broadcast'; body: string }
  | { type: 'control'; command: ControlCommand }
  | { type: 'error'; message: string };

const ALL_TOKEN = 'all';

export function parse(rawText: string): ParsedMessage {
  const text = rawText.replace(/^[\s ]+/, '');

  if (text.length === 0) return { type: 'plain', body: '' };

  if (!text.startsWith('@')) {
    return { type: 'plain', body: rawText.trim() === '' ? '' : rawText };
  }

  // Tokenize the leading run of `@<name>` patterns separated by spaces / tabs.
  // Stop at the first non-`@` token (or end-of-string).
  const mentions: string[] = [];
  let cursor = 0;

  while (cursor < text.length && text[cursor] === '@') {
    // Find end of this `@<name>` token: next whitespace or end-of-string.
    const tokenStart = cursor + 1;
    let tokenEnd = tokenStart;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd += 1;
    const token = text.slice(tokenStart, tokenEnd);
    if (token.length === 0) break; // bare `@` followed by space → not a mention
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
    // Leading `@` but no real name parsed (e.g. just `@`)
    return { type: 'plain', body: rawText };
  }

  // Control commands: must be alone (no other mentions, no body)
  if (mentions.length === 1 && isControlCommand(mentions[0]!)) {
    if (body.trim().length > 0) {
      return {
        type: 'error',
        message: `@${mentions[0]} must be alone (no body or other mentions)`,
      };
    }
    return { type: 'control', command: mentions[0] as ControlCommand };
  }
  if (mentions.some(isControlCommand)) {
    const ctrl = mentions.find(isControlCommand)!;
    return {
      type: 'error',
      message: `@${ctrl} must be alone (no body or other mentions)`,
    };
  }

  // Broadcast: @all is exclusive — error if mixed with named mentions
  const allCount = mentions.filter((m) => m === ALL_TOKEN).length;
  if (allCount > 0) {
    if (mentions.length !== allCount) {
      return {
        type: 'error',
        message: '@all is exclusive — cannot combine with @<name>',
      };
    }
    return { type: 'broadcast', body };
  }

  return { type: 'mention', mentions, body };
}

function isControlCommand(token: string): boolean {
  return CONTROL_COMMANDS.has(token as ControlCommand);
}
