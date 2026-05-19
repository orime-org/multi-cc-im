/**
 * Convert a markdown string from cc → IM into a Lark Card Kit v1
 * schema-2.0 card JSON.
 *
 * **Why**: Lark `msg_type: 'text'` does not render markdown. Tables
 * pass through as literal `|`/`---` characters and look like garbage on
 * mobile. Lark `markdown` card-element supports a md subset
 * (bold / italic / heading / list / link / code) but **not** GFM
 * tables. We bridge the gap by parsing md with `marked`, keeping the
 * non-table tokens as a single `markdown` element (Lark renders the
 * subset natively), and rendering each table row as a `column_set` of
 * `column` cells (the pattern lodestar uses for in-card multi-column
 * layouts, source-verified at `cards/turn.ts:312`).
 *
 * **Returns `null`** when the input has no card-required content (e.g.
 * no table). The caller stays on the cheaper `msg_type: 'text'` path
 * with `stripMarkdown`. Pass `{ force: true }` to always get a card
 * (used by P4+ flows where the card schema is non-negotiable).
 *
 * Per [β.MVP P2](../../../docs/superpowers/specs/2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md)
 * (2026-05-18). Pairs with [P1](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md#116-115-cancel-reasoning-撤销2026-05-18β-mvp-p1)
 * Card Kit wrapper for actual delivery.
 */

import { marked, type Tokens, type Token } from 'marked';

/** Lark Card Kit v1 markdown element — renders Lark's md subset (bold /
 * italic / heading / list / link / inline+fenced code), no GFM table. */
export interface CardMarkdownElement {
  tag: 'markdown';
  content: string;
}

/** Horizontal-rule separator element. */
export interface CardHrElement {
  tag: 'hr';
}

/** Single column inside a `column_set` row. Each column is itself a
 * mini-card body holding one or more child elements. For table rows we
 * use exactly one markdown child per cell. */
export interface CardColumn {
  tag: 'column';
  /** Column sizing policy. `'weighted'` = share row proportionally to
   * `weight`. We default to equal weights for table cells. */
  width: 'weighted';
  weight: number;
  elements: CardLeafElement[];
}

/** Multi-column row container — Lark's primitive for horizontal
 * layouts. Used to render md table rows since Lark cards have no native
 * `table` element (as of 2026-05; source-verified via lodestar source
 * `cards/turn.ts:312` only uses `column_set` + `column` for layout). */
export interface CardColumnSetElement {
  tag: 'column_set';
  columns: CardColumn[];
}

/** A leaf element inside a column — currently just markdown. Extend as
 * P4+ phases land button / collapsible_panel / etc. */
export type CardLeafElement = CardMarkdownElement;

/** Any element that can appear at the top level of `card.body.elements`. */
export type CardElement =
  | CardMarkdownElement
  | CardHrElement
  | CardColumnSetElement;

/** Top-level Lark Card Kit schema 2.0 card body. */
export interface CardSchema {
  schema: '2.0';
  body: {
    elements: CardElement[];
  };
}

export interface MdToCardOpts {
  /** Force conversion to card even when no table is present. Without
   * this, returns null so caller stays on text msg_type. */
  force?: boolean;
}

/**
 * Token types whose presence forces the caller onto the card path. The
 * default heuristic is "only tables need cards" — paragraphs / lists /
 * headings / inline emphasis all render fine in Lark `msg_type: 'text'`
 * via `stripMarkdown`, so we avoid the heavier card path for those.
 */
const CARD_REQUIRED_TOKEN_TYPES = new Set<string>(['table']);

function tokenRequiresCard(token: Token): boolean {
  return CARD_REQUIRED_TOKEN_TYPES.has(token.type);
}

/**
 * Render a `marked` table cell's inline tokens back to a flat md string
 * suitable for embedding inside a `column → markdown` element. `marked`
 * exposes the cell's `tokens` array (resulting from `walkTokens`); we
 * walk it once and emit the equivalent md surface form.
 *
 * Inline runs commonly seen in cc table cells:
 *   - `text` (plain)
 *   - `em` (italic) → wrap in `*`
 *   - `strong` (bold) → wrap in `**`
 *   - `codespan` (inline code) → wrap in backticks
 *   - `link` → `[text](href)`
 *
 * Anything we don't recognize falls back to the token's `raw` text so
 * we never lose user-facing characters silently.
 */
function renderCellInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return '';
  return tokens
    .map((t) => {
      const tok = t as Tokens.Generic;
      switch (tok.type) {
        case 'text':
          return (tok as Tokens.Text).text;
        case 'em':
          return `*${renderCellInline((tok as Tokens.Em).tokens)}*`;
        case 'strong':
          return `**${renderCellInline((tok as Tokens.Strong).tokens)}**`;
        case 'codespan':
          return `\`${(tok as Tokens.Codespan).text}\``;
        case 'link': {
          const link = tok as Tokens.Link;
          return `[${renderCellInline(link.tokens)}](${link.href})`;
        }
        case 'del':
          return `~~${renderCellInline((tok as Tokens.Del).tokens)}~~`;
        case 'br':
          return ' ';
        default:
          return tok.raw ?? '';
      }
    })
    .join('')
    .trim();
}

function makeTableRow(cells: string[]): CardColumnSetElement {
  return {
    tag: 'column_set',
    columns: cells.map((content) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'markdown',
          // empty content makes Lark drop the cell; emit a single space
          // so the column still occupies its grid slot.
          content: content.length > 0 ? content : ' ',
        },
      ],
    })),
  };
}

/**
 * Auto-wrap bare URLs in markdown so Lark Card Kit `markdown` elements
 * render them as clickable links. On Feishu mobile, bare URLs only get
 * colored as link-styled text but aren't clickable — the renderer
 * requires explicit `[text](url)` syntax.
 *
 * Strategy: mask spans we MUST NOT modify (fenced code, inline code,
 * existing markdown links, angle autolinks) with a unique placeholder
 * unlikely to occur in any user text, apply a bare-URL regex to the
 * rest, then unmask.
 *
 * Why daemon-side fix instead of cc prompt habit: prompt habit only
 * holds for THIS cc tab. Other cc tabs across the multi-tab fleet have
 * no awareness. Single-point fix in mdToCard lifts all cc tabs.
 */
function autolinkBareUrls(md: string): string {
  const masked: string[] = [];
  // Placeholder must NOT collide with anything in real cc reply text.
  // The `__MULTICCAUTOLINK_MASK_N__` form combines a project-specific
  // prefix + numeric index + suffix; vanishingly unlikely in natural
  // markdown unless the user literally writes this exact token (and if
  // they do, it'd still roundtrip cleanly since unmask is keyed on the
  // exact same delimited pattern).
  const PRE = '__MULTICCAUTOLINK_MASK_';
  const POST = '__';
  const mask = (input: string, re: RegExp): string =>
    input.replace(re, (m) => {
      const placeholder = `${PRE}${masked.length}${POST}`;
      masked.push(m);
      return placeholder;
    });

  let working = md;
  // Order matters: fenced first (largest spans), then inline code, then
  // existing markdown links / angle autolinks. Stops bare-URL regex
  // from touching content inside these.
  working = mask(working, /```[\s\S]*?```/g);
  working = mask(working, /`[^`\n]+`/g);
  working = mask(working, /\[[^\]\n]*?\]\([^)\n]+?\)/g);
  working = mask(working, /<https?:\/\/[^>\s]+>/g);

  // Wrap bare URLs. Stops at whitespace + common punctuation that
  // can't be part of a URL. Trailing sentence punctuation gets
  // captured then trimmed off the link, kept after.
  working = working.replace(
    /https?:\/\/[^\s)<>`'"\]]+/g,
    (url) => {
      const trailPunct = /[.,;:!?]+$/;
      const tm = url.match(trailPunct);
      const trail = tm ? tm[0] : '';
      const clean = trail ? url.slice(0, -trail.length) : url;
      return `[${clean}](${clean})${trail}`;
    },
  );

  // Unmask in order — placeholder pattern is unique so this is safe.
  const unmaskRe = new RegExp(
    `${PRE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${POST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'g',
  );
  working = working.replace(unmaskRe, (_, idx) => masked[Number(idx)] ?? '');
  return working;
}

/**
 * Convert a markdown string to a Lark card JSON. Returns null when the
 * input doesn't require card rendering (no tables) unless `force: true`
 * is passed.
 *
 * Algorithm:
 *   1. Auto-link bare URLs (so they render clickable in Lark cards).
 *   2. Lex md with `marked`.
 *   3. If no table token AND `!force` → return null.
 *   4. Walk tokens, accumulating non-table tokens into a markdown
 *      buffer (Lark `markdown` element parses them natively).
 *   5. On table token → flush buffer as `markdown` element, emit one
 *      `column_set` per row (header + data).
 *   6. On `hr` token → flush buffer, emit `{ tag: 'hr' }` element.
 *   7. Final flush returns the assembled card body.
 */
/**
 * Feishu Card Kit v1 hard limit: a single card schema 2.0 accepts at
 * most this many GFM markdown tables before the backend rejects the
 * `cardkit.v1.card.create` / `im.v1.message.create(msg_type=interactive)`
 * call with `code:230099 ErrCode:11310 card table number over limit`.
 *
 * Verified by [[reference_feishu_cardkit_limits]] — three larksuite
 * repositories (openclaw-lark / node-sdk / oapi-sdk-python) all use
 * `FEISHU_CARD_TABLE_LIMIT = 3` as the empirical cap (2026-03 实测).
 */
export const FEISHU_CARD_TABLE_LIMIT = 3;

/**
 * Split a markdown string into N chunks such that each chunk contains
 * at most `tableLimit` GFM tables. Used by the Lark adapter to send a
 * cc reply that contains more tables than fit in one card as a series
 * of consecutive IM messages, each a valid card.
 *
 * Algorithm:
 *   1. Lex with `marked`.
 *   2. Walk tokens, copying each token's `raw` to the current chunk.
 *   3. When a `table` token would push the chunk's table count past
 *      `tableLimit`, flush the current chunk and start a new one with
 *      the table as its first token.
 *   4. Final flush returns the array of chunks (each is a complete md
 *      string with original surface form preserved — no token
 *      re-serialization, so paragraph spacing / list markers etc.
 *      survive intact).
 *
 * Invariant: a single table is never split across chunks. A chunk may
 * contain less than `tableLimit` tables when followed by non-table
 * content that exceeds the budget on the next table boundary.
 *
 * @param markdown - The full cc reply markdown.
 * @param tableLimit - Per-chunk table cap. Defaults to `FEISHU_CARD_TABLE_LIMIT`.
 * @returns Array of md string chunks; length 1 when total tables ≤ limit.
 */
export function splitMarkdownByTableCapacity(
  markdown: string,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string[] {
  if (tableLimit < 1) {
    throw new RangeError(`tableLimit must be >= 1, got ${tableLimit}`);
  }
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return [];

  const tokens = marked.lexer(trimmed);
  const tableCount = tokens.filter((t) => t.type === 'table').length;
  if (tableCount <= tableLimit) return [trimmed];

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferTables = 0;

  const flush = (): void => {
    const content = buffer.join('').trim();
    if (content.length > 0) chunks.push(content);
    buffer = [];
    bufferTables = 0;
  };

  for (const token of tokens) {
    if (token.type === 'table') {
      if (bufferTables >= tableLimit) {
        flush();
      }
      buffer.push(token.raw);
      bufferTables += 1;
    } else {
      buffer.push(token.raw);
    }
  }
  flush();
  return chunks;
}

export function mdToCard(markdown: string, opts: MdToCardOpts = {}): CardSchema | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return null;
  // Step 1 — autolink bare URLs so Lark renders them clickable on mobile.
  const preprocessed = autolinkBareUrls(trimmed);

  const tokens = marked.lexer(preprocessed);
  const hasTable = tokens.some(tokenRequiresCard);
  if (!hasTable && !opts.force) return null;

  const elements: CardElement[] = [];
  let mdBuffer: string[] = [];

  const flushMd = (): void => {
    if (mdBuffer.length === 0) return;
    const content = mdBuffer.join('').trim();
    if (content.length > 0) {
      elements.push({ tag: 'markdown', content });
    }
    mdBuffer = [];
  };

  for (const token of tokens) {
    if (token.type === 'table') {
      flushMd();
      const table = token as Tokens.Table;
      // Header row — keep cell text verbatim; user wanting bold writes
      // `| **A** | **B** |` in md so we don't double-wrap.
      elements.push(
        makeTableRow(table.header.map((cell) => renderCellInline(cell.tokens))),
      );
      // Data rows
      for (const row of table.rows) {
        elements.push(makeTableRow(row.map((cell) => renderCellInline(cell.tokens))));
      }
    } else if (token.type === 'hr') {
      flushMd();
      elements.push({ tag: 'hr' });
    } else if (token.type === 'space') {
      // Preserve blank-line separation in the markdown buffer so Lark
      // renders paragraph breaks correctly.
      mdBuffer.push(token.raw);
    } else {
      mdBuffer.push(token.raw);
    }
  }
  flushMd();

  if (elements.length === 0) return null;

  return {
    schema: '2.0',
    body: { elements },
  };
}
