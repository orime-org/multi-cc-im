import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './markdown.js';

/**
 * Feishu `msg_type: 'text'` does NOT render markdown — `**bold**`,
 * `# heading`, fenced code blocks etc. display literally as backslashes
 * and asterisks. Per user smoke 2026-05-11 this made cc replies look
 * cluttered. `stripMarkdown` strips / simplifies markers so plain-text
 * IM output looks closer to the cc TUI rendering.
 *
 * The function does NOT aim for full markdown parsing fidelity. Real
 * markdown (with link refs, nested emphasis, HTML, tables) is out of
 * scope — cc rarely emits these. We cover the syntax cc actually uses:
 * headings, bold, italic, lists, inline code, links, code blocks,
 * strikethrough.
 */
describe('stripMarkdown', () => {
  it('plain text → unchanged', () => {
    expect(stripMarkdown('just plain prose')).toBe('just plain prose');
    expect(stripMarkdown('')).toBe('');
  });

  it('bold `**text**` → bare text', () => {
    expect(stripMarkdown('this is **bold** text')).toBe('this is bold text');
  });

  it('italic `*text*` → bare text (asymmetric not bold)', () => {
    expect(stripMarkdown('this is *italic* text')).toBe('this is italic text');
  });

  it('strikethrough `~~text~~` → bare text', () => {
    expect(stripMarkdown('this is ~~struck~~ out')).toBe('this is struck out');
  });

  it('underscore underline `__text__` → bare text', () => {
    expect(stripMarkdown('emphasis: __underlined__ here')).toBe(
      'emphasis: underlined here',
    );
  });

  it('headings `#` / `##` / `###` → `▌ Text` prefix, hash stripped', () => {
    expect(stripMarkdown('# Title')).toBe('▌ Title');
    expect(stripMarkdown('## Subtitle')).toBe('▌ Subtitle');
    expect(stripMarkdown('### Section')).toBe('▌ Section');
  });

  it('inline code `` `code` `` → 「code」 (Unicode brackets, no backticks)', () => {
    expect(stripMarkdown('run `multi-cc-im start` to begin')).toBe(
      'run 「multi-cc-im start」 to begin',
    );
  });

  it('unordered list `- item` / `* item` → `• item`', () => {
    expect(stripMarkdown('- first\n- second')).toBe('• first\n• second');
    expect(stripMarkdown('* a\n* b')).toBe('• a\n• b');
  });

  it('ordered list `1. item` → unchanged (numbers already render fine)', () => {
    expect(stripMarkdown('1. one\n2. two')).toBe('1. one\n2. two');
  });

  it('links `[text](url)` → `text (url)` (URL visible inline)', () => {
    expect(stripMarkdown('see [docs](https://example.com) here')).toBe(
      'see docs (https://example.com) here',
    );
  });

  it('fenced code block ` ``` ` → fence removed, content preserved verbatim', () => {
    const md = 'before\n```js\nconst x = 1;\nconst y = 2;\n```\nafter';
    const out = stripMarkdown(md);
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
    expect(out).not.toContain('```');
    // Language marker preserved as a small annotation
    expect(out).toMatch(/\[js\]/);
  });

  it('code block content is PROTECTED from inline strip (markdown inside code stays literal)', () => {
    const md = 'prose **bold**\n```\nsource has **literal stars**\n```\nmore';
    const out = stripMarkdown(md);
    expect(out).toContain('prose bold');
    // Inside the code block, ** should NOT be stripped
    expect(out).toContain('**literal stars**');
  });

  it('mixed real-world cc-style reply renders sanely', () => {
    const md = `# 修复完成

修了 \`router.ts:303\` 的失败 echo。

## 改动

- 加 tab 列表到 echo
- 改 prompt 容错

代码示例：

\`\`\`ts
const tabs = ['frontend', 'api'];
\`\`\`

链接：[PR](https://github.com/x/y/pull/105)
`;
    const out = stripMarkdown(md);
    expect(out).toContain('▌ 修复完成');
    expect(out).toContain('▌ 改动');
    expect(out).toContain('「router.ts:303」');
    expect(out).toContain('• 加 tab 列表到 echo');
    expect(out).toContain('• 改 prompt 容错');
    expect(out).toContain('[ts]');
    expect(out).toContain("const tabs = ['frontend', 'api'];");
    expect(out).toContain('PR (https://github.com/x/y/pull/105)');
    expect(out).not.toContain('```');
    expect(out).not.toContain('**');
    expect(out).not.toContain('[PR]');
  });

  it('nested emphasis is best-effort (one-level strip)', () => {
    // Don't aim for perfect nested handling; just ensure no crash + most
    // markers stripped. The asterisks-in-code edge case is the only one
    // we strictly guarantee correctness on.
    expect(() => stripMarkdown('**bold *italic***')).not.toThrow();
    expect(() => stripMarkdown('***triple***')).not.toThrow();
  });

  it('preserves blank lines between paragraphs', () => {
    expect(stripMarkdown('para1\n\npara2')).toBe('para1\n\npara2');
  });

  it('leading whitespace before list marker is preserved (nested lists)', () => {
    expect(stripMarkdown('  - nested item')).toBe('  • nested item');
  });
});
