import { describe, it, expect } from 'vitest';
import {
  mdToCard,
  splitMarkdownByTableCapacity,
  FEISHU_CARD_TABLE_LIMIT,
  type CardSchema,
  type CardElement,
} from './md-to-card.js';

function countTables(md: string): number {
  // GFM table = header row `| ... |` + alignment row `|---|...|`
  // immediately following. Match the alignment row pattern alone (it's
  // unique to tables); `m` flag makes `^` match line starts so we don't
  // require a leading `\n` (chunks may start with the alignment row's
  // header).
  const m = md.match(/^\|[-: |]+\|$/gm);
  return m ? m.length : 0;
}

function tagsOf(card: CardSchema | null): string[] {
  return (card?.body.elements ?? []).map((e) => e.tag);
}

describe('mdToCard — no-card path', () => {
  it('plain text → null (caller stays on text msg_type)', () => {
    expect(mdToCard('hello world')).toBeNull();
  });

  it('heading + paragraph + list → null (Lark text msg + stripMarkdown handles)', () => {
    expect(mdToCard('# Title\n\nHello.\n\n- one\n- two')).toBeNull();
  });

  it('fenced code block alone → null (markdown element / stripMarkdown handle)', () => {
    expect(mdToCard('```\ncode\n```')).toBeNull();
  });

  it('empty / whitespace input → null', () => {
    expect(mdToCard('')).toBeNull();
    expect(mdToCard('   \n\n   ')).toBeNull();
  });

  it('force:true returns card even without table', () => {
    const card = mdToCard('plain prose', { force: true });
    expect(card).not.toBeNull();
    expect(tagsOf(card)).toEqual(['markdown']);
  });
});

describe('mdToCard — table path', () => {
  it('minimal table: header + 1 data row → 2 column_sets', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    expect(card).not.toBeNull();
    expect(tagsOf(card)).toEqual(['column_set', 'column_set']);
  });

  it('each column has weighted width, weight 1, single markdown child', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const headerRow = card!.body.elements[0]!;
    expect(headerRow.tag).toBe('column_set');
    if (headerRow.tag !== 'column_set') throw new Error('typeguard');
    expect(headerRow.columns).toHaveLength(2);
    for (const col of headerRow.columns) {
      expect(col.tag).toBe('column');
      expect(col.width).toBe('weighted');
      expect(col.weight).toBe(1);
      expect(col.elements).toHaveLength(1);
      expect(col.elements[0]?.tag).toBe('markdown');
    }
  });

  it('header cells preserve text verbatim (no auto-bold)', () => {
    const md = '| Name | Age |\n|---|---|\n| Alice | 30 |';
    const card = mdToCard(md);
    const header = card!.body.elements[0];
    if (header?.tag !== 'column_set') throw new Error('typeguard');
    expect(header.columns[0]?.elements[0]).toEqual({ tag: 'markdown', content: 'Name' });
    expect(header.columns[1]?.elements[0]).toEqual({ tag: 'markdown', content: 'Age' });
  });

  it('cell inline emphasis preserved (bold / italic / code / link)', () => {
    const md = [
      '| Plain | Bold | Italic | Code | Link |',
      '|---|---|---|---|---|',
      '| a | **b** | *c* | `d` | [text](https://x.io) |',
    ].join('\n');
    const card = mdToCard(md);
    const dataRow = card!.body.elements[1];
    if (dataRow?.tag !== 'column_set') throw new Error('typeguard');
    expect(dataRow.columns[0]?.elements[0]?.content).toBe('a');
    expect(dataRow.columns[1]?.elements[0]?.content).toBe('**b**');
    expect(dataRow.columns[2]?.elements[0]?.content).toBe('*c*');
    expect(dataRow.columns[3]?.elements[0]?.content).toBe('`d`');
    expect(dataRow.columns[4]?.elements[0]?.content).toBe('[text](https://x.io)');
  });

  it('empty cell rendered as single space so column still occupies slot', () => {
    const md = '| A | B |\n|---|---|\n|  | 2 |';
    const card = mdToCard(md);
    const dataRow = card!.body.elements[1];
    if (dataRow?.tag !== 'column_set') throw new Error('typeguard');
    expect(dataRow.columns[0]?.elements[0]?.content).toBe(' ');
    expect(dataRow.columns[1]?.elements[0]?.content).toBe('2');
  });
});

describe('mdToCard — mixed content', () => {
  it('paragraph before table → markdown + column_set rows', () => {
    const md = 'intro paragraph\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    expect(tagsOf(card)).toEqual(['markdown', 'column_set', 'column_set']);
    const intro = card!.body.elements[0] as { tag: 'markdown'; content: string };
    expect(intro.content).toContain('intro paragraph');
  });

  it('table then list → column_sets + markdown', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\n- bullet one\n- bullet two';
    const card = mdToCard(md);
    expect(tagsOf(card)).toEqual(['column_set', 'column_set', 'markdown']);
  });

  it('paragraph + table + list → 3 element kinds in order', () => {
    const md = 'lead\n\n| H1 | H2 |\n|---|---|\n| a | b |\n\n- end one\n- end two';
    const card = mdToCard(md);
    expect(tagsOf(card)).toEqual(['markdown', 'column_set', 'column_set', 'markdown']);
  });

  it('hr token emits separate hr element', () => {
    const md = 'before\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    // Order: markdown(before) → hr → column_set(header) → column_set(row)
    expect(tagsOf(card)).toEqual(['markdown', 'hr', 'column_set', 'column_set']);
  });

  it('multi-row table: header + N data rows = 1 + N column_sets', () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '| 5 | 6 |',
    ].join('\n');
    const card = mdToCard(md);
    expect(tagsOf(card)).toEqual([
      'column_set', // header
      'column_set', // row 1
      'column_set', // row 2
      'column_set', // row 3
    ]);
  });

  it('two separate tables → both render, no buffer leak', () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'between paragraph',
      '',
      '| X | Y |',
      '|---|---|',
      '| 8 | 9 |',
    ].join('\n');
    const card = mdToCard(md);
    expect(tagsOf(card)).toEqual([
      'column_set', // table1 header
      'column_set', // table1 row
      'markdown', // between paragraph
      'column_set', // table2 header
      'column_set', // table2 row
    ]);
  });
});

describe('mdToCard — output schema invariants', () => {
  it('top-level shape: { schema: "2.0", body: { elements: [...] } }', () => {
    const card = mdToCard('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(card?.schema).toBe('2.0');
    expect(card?.body).toBeDefined();
    expect(Array.isArray(card?.body.elements)).toBe(true);
  });

  it('all column_sets have non-empty columns', () => {
    const card = mdToCard('| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |');
    for (const el of card!.body.elements) {
      if (el.tag === 'column_set') {
        expect(el.columns.length).toBeGreaterThan(0);
      }
    }
  });
});

// 2026-05-19 hotfix: Feishu mobile renders bare URLs as link-styled
// text (blue) but they're not clickable — user has to copy. Autolink
// preprocessor wraps `https://...` into `[url](url)` so Lark renders
// clickable. Skips fenced code, inline code, existing markdown links,
// angle autolinks.
describe('mdToCard — autolink bare URLs (2026-05-19)', () => {
  function getMarkdownContent(card: CardSchema | null): string {
    if (!card) return '';
    const els = card.body.elements;
    return els
      .map((e) => (e.tag === 'markdown' ? (e as { content: string }).content : ''))
      .join('\n');
  }

  it('bare URL in paragraph → wrapped as [url](url)', () => {
    const card = mdToCard('See https://example.com for info\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    const content = getMarkdownContent(card);
    expect(content).toContain('[https://example.com](https://example.com)');
    // Total URL occurrences should be exactly 2 (one inside `[]`, one inside `()`)
    const matches = content.match(/https:\/\/example\.com/g);
    expect(matches?.length).toBe(2);
  });

  it('existing markdown link `[text](url)` is NOT double-wrapped', () => {
    const md = 'Click [here](https://example.com) now\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('[here](https://example.com)');
    expect(content).not.toContain('[[here]');
    expect(content).not.toContain('[https://example.com](https://example.com)');
  });

  it('inline code with URL is NOT modified', () => {
    const md = 'Like `curl https://example.com` to test\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('`curl https://example.com`');
    expect(content).not.toContain('[https://example.com](https://example.com)');
  });

  it('fenced code block URL is NOT modified', () => {
    const md = '```\nhttps://example.com\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('```\nhttps://example.com\n```');
  });

  it('angle-bracket autolink `<https://...>` is NOT modified', () => {
    const md = 'see <https://example.com> here\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('<https://example.com>');
    expect(content).not.toContain('[<https://example.com>]');
  });

  it('multiple bare URLs in same paragraph all wrapped', () => {
    const md = 'A https://a.io and B https://b.io\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('[https://a.io](https://a.io)');
    expect(content).toContain('[https://b.io](https://b.io)');
  });

  it('trailing punctuation (period / comma / semicolon) NOT swallowed into URL', () => {
    const md = 'visit https://example.com. End.\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    // URL itself doesn't include the period
    expect(content).toContain('[https://example.com](https://example.com).');
    // Period stays as text after the link
    expect(content).not.toContain('example.com.](');
  });

  it('http (not just https) URLs also wrapped', () => {
    const md = 'old style http://example.com works\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const card = mdToCard(md);
    const content = getMarkdownContent(card);
    expect(content).toContain('[http://example.com](http://example.com)');
  });
});

describe('mdToCard — real cc reply fixtures', () => {
  it('cc summary table from daemon.log 2026-05-15 (issue list)', () => {
    const md = [
      '| # | 问题 | 严重度 | 性质 |',
      '|---|---|---|---|',
      '| 376 | /list 标题写 "wezterm tabs:" | 中 | UX bug |',
      '| 377 | iTerm cc reply 不回 IM | 高 | 产线 bug |',
    ].join('\n');
    const card = mdToCard(md);
    expect(card).not.toBeNull();
    expect(tagsOf(card)).toEqual(['column_set', 'column_set', 'column_set']);
    const row1 = card!.body.elements[1] as Extract<CardElement, { tag: 'column_set' }>;
    expect(row1.columns[0]?.elements[0]?.content).toBe('376');
    expect(row1.columns[1]?.elements[0]?.content).toBe('/list 标题写 "wezterm tabs:"');
  });

  it('cc step table from daemon.log 2026-05-14 (verification checklist)', () => {
    const md = [
      '| 步骤 | 状态 |',
      '|---|---|',
      '| 0.1 rebase | ✅ |',
      '| 0.2 push | ⏳ |',
    ].join('\n');
    const card = mdToCard(md);
    expect(card).not.toBeNull();
    const row1 = card!.body.elements[1] as Extract<CardElement, { tag: 'column_set' }>;
    expect(row1.columns[1]?.elements[0]?.content).toBe('✅');
  });
});

describe('splitMarkdownByTableCapacity', () => {
  function makeTable(n: number): string {
    return `| C${n} | V${n} |\n|---|---|\n| a | b |`;
  }

  it('exposes FEISHU_CARD_TABLE_LIMIT = 3', () => {
    expect(FEISHU_CARD_TABLE_LIMIT).toBe(3);
  });

  it('empty / whitespace input → []', () => {
    expect(splitMarkdownByTableCapacity('')).toEqual([]);
    expect(splitMarkdownByTableCapacity('   \n\n  ')).toEqual([]);
  });

  it('0 tables → 1 chunk (the input)', () => {
    const md = 'hello world\n\nno tables here';
    expect(splitMarkdownByTableCapacity(md)).toEqual(['hello world\n\nno tables here']);
  });

  it('exactly 3 tables → 1 chunk (at limit, no split)', () => {
    const md = `intro\n\n${makeTable(1)}\n\n${makeTable(2)}\n\n${makeTable(3)}\n\nend`;
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(1);
    expect(countTables(chunks[0]!)).toBe(3);
  });

  it('4 tables → 2 chunks (3 + 1)', () => {
    const md = `intro\n\n${makeTable(1)}\n\n${makeTable(2)}\n\n${makeTable(3)}\n\n${makeTable(4)}`;
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(2);
    expect(countTables(chunks[0]!)).toBe(3);
    expect(countTables(chunks[1]!)).toBe(1);
  });

  it('5 tables → 2 chunks (3 + 2)', () => {
    const tables = [1, 2, 3, 4, 5].map(makeTable).join('\n\n');
    const md = `lead\n\n${tables}\n\ntrailing`;
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(2);
    expect(countTables(chunks[0]!)).toBe(3);
    expect(countTables(chunks[1]!)).toBe(2);
  });

  it('6 tables → 2 chunks (3 + 3)', () => {
    const md = [1, 2, 3, 4, 5, 6].map(makeTable).join('\n\n');
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(2);
    expect(countTables(chunks[0]!)).toBe(3);
    expect(countTables(chunks[1]!)).toBe(3);
  });

  it('7 tables → 3 chunks (3 + 3 + 1)', () => {
    const md = [1, 2, 3, 4, 5, 6, 7].map(makeTable).join('\n\n');
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(3);
    expect(countTables(chunks[0]!)).toBe(3);
    expect(countTables(chunks[1]!)).toBe(3);
    expect(countTables(chunks[2]!)).toBe(1);
  });

  it('a single table is never split across chunks', () => {
    const bigTable = ['| H |', '|---|', '| r1 |', '| r2 |', '| r3 |', '| r4 |'].join('\n');
    // Force a 4-table input where the 4th is this multi-row table —
    // it must land in chunk 2 intact, not partially in chunk 1.
    const md = `${makeTable(1)}\n\n${makeTable(2)}\n\n${makeTable(3)}\n\n${bigTable}`;
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain('r1');
    expect(chunks[1]).toContain('r2');
    expect(chunks[1]).toContain('r3');
    expect(chunks[1]).toContain('r4');
  });

  it('custom tableLimit=1 → each table its own chunk', () => {
    const md = `${makeTable(1)}\n\n${makeTable(2)}\n\n${makeTable(3)}`;
    const chunks = splitMarkdownByTableCapacity(md, 1);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(countTables(c)).toBe(1);
    }
  });

  it('tableLimit < 1 throws RangeError (precondition)', () => {
    expect(() => splitMarkdownByTableCapacity('any', 0)).toThrow(RangeError);
    expect(() => splitMarkdownByTableCapacity('any', -1)).toThrow(RangeError);
  });

  it('trailing markdown between tables follows the preceding table chunk', () => {
    const md = `${makeTable(1)}\n\nbetween12\n\n${makeTable(2)}\n\nbetween23\n\n${makeTable(3)}\n\nbetween34\n\n${makeTable(4)}\n\ntail`;
    const chunks = splitMarkdownByTableCapacity(md);
    expect(chunks).toHaveLength(2);
    // chunk 1: tables 1-3 + their intervening text + the text right
    // before table 4 (which gets bumped to chunk 2)
    expect(chunks[0]).toContain('between12');
    expect(chunks[0]).toContain('between23');
    expect(chunks[0]).toContain('between34');
    expect(chunks[1]).toContain('tail');
  });
});
