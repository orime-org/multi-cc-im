import { describe, it, expect } from 'vitest';
import { mdToCard, type CardSchema, type CardElement } from './md-to-card.js';

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
