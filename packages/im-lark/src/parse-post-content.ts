/**
 * Parser for Feishu/Lark `message_type === 'post'` inbound content.
 *
 * A `post` is Feishu's native rich-text format. Unlike `text` (one string)
 * and `image` (one image_key), a post body is a 2D node array — each outer
 * element is a paragraph, each inner element a typed node (text / image /
 * link / mention / etc). Posts are how users naturally mix text and inline
 * images in Feishu UI — dropping them silently (the previous v1 MVP
 * behavior) lost every image-with-caption message.
 *
 * Per [DD-style proposal 2026-05-26, decisions 1A + 2A]: we parse the
 * subset of tags users actually use (text / a / at / img) plus a few
 * structural ones (hr, md), and emit `[<tag>]` placeholders for any
 * tag we don't recognize so downstream cc tabs see SOME indication
 * rather than silent loss.
 *
 * Schema variability defense — receive-side `content` field shape:
 * - Documented send-side wrap: `{ "zh_cn": {title, content}, "en_us": {...} }`.
 * - Some receive payloads deliver UNWRAPPED `{title, content}` (no lang
 *   key) — observed in real Feishu pushes when only one locale is set.
 * - We accept BOTH and prefer the language whose key matches `i18n` if
 *   present; otherwise we take the first lang-keyed body or the
 *   unwrapped body verbatim.
 *
 * No external deps. Pure function — easy to unit-test against fixtures.
 */

export interface ParsedPostNode {
  tag: string;
  [key: string]: unknown;
}

export type ParsedPostParagraph = ParsedPostNode[];

export interface ParsedPost {
  /** Concatenated human-readable text (paragraphs joined by `\n`). */
  text: string;
  /** Image keys discovered in `img` nodes, in document order. */
  imageKeys: string[];
  /** Title of the post (if present); prepended to `text` already. */
  title: string;
}

/**
 * Render a single node as plain text for downstream cc-tab consumption.
 * Unknown tags fall through to `[<tag>]` so users see SOMETHING was there
 * (better than silent loss). Per decision 2A — explicit subset, others
 * placeholder.
 */
function renderNode(node: ParsedPostNode): string {
  switch (node.tag) {
    case 'text': {
      const t = typeof node.text === 'string' ? node.text : '';
      return t;
    }
    case 'a': {
      const t = typeof node.text === 'string' ? node.text : '';
      const href = typeof node.href === 'string' ? node.href : '';
      // Render as `<text> (<href>)` so cc has both the label and the URL.
      // If text and href are identical (auto-linkified bare URL), just
      // emit the URL once.
      if (t.length === 0) return href;
      if (t === href) return href;
      return `${t} (${href})`;
    }
    case 'at': {
      // Feishu mentions can carry either `user_name` (display name) or
      // just `user_id`; prefer user_name, fall back to id.
      const name = typeof node.user_name === 'string' ? node.user_name : '';
      const id = typeof node.user_id === 'string' ? node.user_id : '';
      const label = name.length > 0 ? name : id;
      return label.length > 0 ? `@${label}` : '@';
    }
    case 'img': {
      // Image nodes contribute NO text — the image_key is collected
      // separately into `imageKeys` by the caller. Emit empty so the
      // surrounding paragraph reads cleanly.
      return '';
    }
    case 'hr': {
      // Horizontal rule — render as a markdown-ish divider on its own
      // line so cc sees the structural break.
      return '\n---\n';
    }
    case 'md': {
      // Inline markdown blob — best-effort: take `text` if present,
      // otherwise placeholder.
      const t = typeof node.text === 'string' ? node.text : '';
      return t.length > 0 ? t : '[md]';
    }
    default: {
      // Unknown tag (emotion / code_inline / location / file / etc.):
      // emit a tagged placeholder so the user sees what was lost.
      return `[${node.tag}]`;
    }
  }
}

/**
 * Walk a 2D paragraph array, extracting text per paragraph and harvesting
 * every `img` node's image_key.
 */
function walkParagraphs(
  paragraphs: unknown,
): { text: string; imageKeys: string[] } {
  if (!Array.isArray(paragraphs)) {
    return { text: '', imageKeys: [] };
  }
  const lines: string[] = [];
  const imageKeys: string[] = [];
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue;
    const rendered: string[] = [];
    for (const raw of para) {
      if (raw === null || typeof raw !== 'object') continue;
      const node = raw as ParsedPostNode;
      if (typeof node.tag !== 'string') continue;
      if (node.tag === 'img') {
        // Image key field name is `image_key` (verified against send-side
        // docs; receive-side observed identical in the few examples
        // available). If the key is missing or wrong shape, skip.
        if (typeof node.image_key === 'string' && node.image_key.length > 0) {
          imageKeys.push(node.image_key);
        }
        continue;
      }
      rendered.push(renderNode(node));
    }
    // Trim per-paragraph whitespace; skip empty paragraphs entirely so
    // the cc-tab output isn't littered with blank lines from img-only
    // paragraphs.
    const line = rendered.join('').trim();
    if (line.length > 0) lines.push(line);
  }
  return { text: lines.join('\n'), imageKeys };
}

/**
 * Pick the right post body out of a possibly-wrapped content blob.
 *
 * Real-world inputs we accept (decision 2A scope):
 * - `{ zh_cn: { title, content } }` — canonical Feishu send shape
 * - `{ en_us: { title, content } }` — same shape, different locale
 * - `{ zh_cn: {...}, en_us: {...} }` — multi-locale, prefer matching `lang`
 *   hint or first-seen
 * - `{ title, content }` — unwrapped (observed in some receive payloads)
 *
 * Returns `{title, content}` or `null` if we can't find either field.
 */
function extractPostBody(
  parsed: Record<string, unknown>,
  langHint: string | undefined,
): { title: unknown; content: unknown } | null {
  // Case 1: unwrapped — `title` or `content` sits at top level.
  if ('title' in parsed || 'content' in parsed) {
    return {
      title: parsed['title'],
      content: parsed['content'],
    };
  }
  // Case 2: wrapped — pick the locale body. Prefer the lang hint if
  // provided and present; otherwise the first locale-keyed entry whose
  // value is an object.
  if (langHint !== undefined && typeof parsed[langHint] === 'object' && parsed[langHint] !== null) {
    const body = parsed[langHint] as Record<string, unknown>;
    return { title: body['title'], content: body['content'] };
  }
  for (const value of Object.values(parsed)) {
    if (value !== null && typeof value === 'object') {
      const body = value as Record<string, unknown>;
      if ('title' in body || 'content' in body) {
        return { title: body['title'], content: body['content'] };
      }
    }
  }
  return null;
}

/**
 * Parse a Feishu post message's stringified `content` field into a
 * normalized `{text, imageKeys, title}` triple suitable for constructing
 * an `IncomingMessage` with mixed text + image attachments.
 *
 * Returns `null` when the input isn't a valid JSON object — caller
 * should treat that as a malformed event and skip.
 *
 * @param rawContent The string from `data.message.content` on a post-type
 *   inbound event. Already JSON-stringified per Feishu's transport.
 * @param langHint Optional locale tag (e.g. `'zh_cn'`) to bias selection
 *   on multi-locale bodies. Pass nothing for single-locale receives.
 */
export function parsePostContent(
  rawContent: string,
  langHint?: string,
): ParsedPost | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const body = extractPostBody(parsed as Record<string, unknown>, langHint);
  if (body === null) return null;
  const title = typeof body.title === 'string' ? body.title : '';
  const { text: bodyText, imageKeys } = walkParagraphs(body.content);
  // Title (if present) prepends as the first line, separated from body
  // by a blank line — same convention Feishu uses in its own UI.
  const combinedText =
    title.length > 0 && bodyText.length > 0
      ? `${title}\n\n${bodyText}`
      : title.length > 0
        ? title
        : bodyText;
  return {
    text: combinedText,
    imageKeys,
    title,
  };
}
