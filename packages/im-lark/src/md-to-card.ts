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
 * Convert a markdown string to a Lark card JSON. Returns null when the
 * input doesn't require card rendering (no tables) unless `force: true`
 * is passed.
 *
 * Algorithm:
 *   1. Lex md with `marked`.
 *   2. If no table token AND `!force` → return null.
 *   3. Walk tokens, accumulating non-table tokens into a markdown
 *      buffer (Lark `markdown` element parses them natively).
 *   4. On table token → flush buffer as `markdown` element, emit one
 *      `column_set` per row (header + data).
 *   5. On `hr` token → flush buffer, emit `{ tag: 'hr' }` element.
 *   6. Final flush returns the assembled card body.
 */
export function mdToCard(markdown: string, opts: MdToCardOpts = {}): CardSchema | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return null;

  const tokens = marked.lexer(trimmed);
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
