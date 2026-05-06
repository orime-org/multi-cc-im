import { RESERVED_BRIDGE_NAME } from './matcher.js';

/**
 * Parse a wechat message text into one of these routing-relevant shapes:
 *
 * - `plain`           — no leading `@`; body forwarded to `current_session`
 * - `mention`         — leading `@<name>` (one or more space-separated); body
 *                        to those targets
 * - `broadcast`       — `@all` alone or with body; fan-out to all alive
 *                        sessions
 * - `bridge_command`  — `@multi-cc-im /<command> [args]`; the bridge daemon
 *                        itself handles it (e.g. `/list`, `/help`, `/current`).
 *                        `@multi-cc-im` is a reserved name and never resolves
 *                        to a cc session.
 * - `error`           — malformed (e.g. `@all` mixed with named mentions, or
 *                        `@multi-cc-im` body that isn't a `/`-prefixed slash
 *                        command)
 *
 * Mentions are recognized **only at message start**, separated by whitespace.
 * `@<name>` mid-message is treated as plain text (matches IM convention; cf.
 * Discord/Slack mention parsers).
 *
 * The original DD G' (`docs/superpowers/specs/2026-05-04-routing-syntax-dd.md`)
 * had `@list` / `@help` / `@current` as bareword keywords. These were dropped
 * because they collide with cc tab titles set via `/rename` — a user who
 * /rename'd a cc to "list" would shadow the keyword. The unambiguous
 * `@multi-cc-im /<cmd>` form replaces them.
 */

const ALL_TOKEN = 'all';

export type ParsedMessage =
  | { type: 'plain'; body: string }
  | { type: 'mention'; mentions: string[]; body: string }
  | { type: 'broadcast'; body: string }
  | { type: 'bridge_command'; command: string; args: string }
  | { type: 'error'; message: string };

export function parse(rawText: string): ParsedMessage {
  const text = rawText.replace(/^[\s ]+/, '');

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

  // Bridge command: `@multi-cc-im /<command> [args]`.
  // The reserved name never matches any cc; if it appears with a `/`-prefixed
  // slash command body we route to the bridge handlers. Anything else is an
  // error so users learn the right form.
  if (mentions.includes(RESERVED_BRIDGE_NAME)) {
    if (mentions.length !== 1) {
      return {
        type: 'error',
        message: `@${RESERVED_BRIDGE_NAME} is exclusive — cannot combine with other mentions`,
      };
    }
    const trimmedBody = body.trim();
    if (!trimmedBody.startsWith('/')) {
      return {
        type: 'error',
        message: `@${RESERVED_BRIDGE_NAME} expects a /<command>; e.g. \`@${RESERVED_BRIDGE_NAME} /list\` or \`@${RESERVED_BRIDGE_NAME} /help\``,
      };
    }
    // Split first whitespace: `/list` → command=`list`, args=``.
    // `/rename auth-fix` → command=`rename`, args=`auth-fix`.
    const afterSlash = trimmedBody.slice(1);
    const spaceIdx = afterSlash.search(/\s/);
    const command =
      spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx);
    const args =
      spaceIdx === -1 ? '' : afterSlash.slice(spaceIdx).trim();
    if (command.length === 0) {
      return {
        type: 'error',
        message: `@${RESERVED_BRIDGE_NAME}: empty command after \`/\``,
      };
    }
    return { type: 'bridge_command', command, args };
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
