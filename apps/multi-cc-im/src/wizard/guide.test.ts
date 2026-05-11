import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGuide, renderGuide } from './guide.js';

/**
 * W6 — covers the markdown→ANSI renderer + filesystem loader for the
 * inline configuration guide. Per [DD §10.1 W6](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 *
 * The renderer only styles what we actually emit in `docs/setup-feishu.md`:
 *   - Headings (`#` / `##`) → bold, leading hashes stripped
 *   - Inline links `[text](url)` → terminal-link OSC 8 with plain-text fallback
 *   - Code spans `` `code` `` → cyan
 *
 * Other markdown (lists, paragraphs, blank lines) passes through verbatim
 * — keep the source readable as plain text.
 */
describe('loadGuide', () => {
  it('returns null when file missing (silent fallback so wizard still proceeds)', async () => {
    expect(await loadGuide('/nonexistent-W6-guide-xyz.md')).toBeNull();
  });

  it('returns file contents when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guide-load-'));
    try {
      const path = join(dir, 'setup.md');
      await writeFile(path, '# Hello\nbody', 'utf-8');
      const out = await loadGuide(path);
      expect(out).toBe('# Hello\nbody');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderGuide', () => {
  it('strips leading # and wraps heading in ANSI bold', () => {
    const out = renderGuide('# Title');
    expect(out).toContain('Title');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('\x1b[0m');
    expect(out).not.toMatch(/^# Title/);
  });

  it('handles multi-level headings (## / ###) the same way', () => {
    const out = renderGuide('## H2\n### H3');
    expect(out).toContain('H2');
    expect(out).toContain('H3');
    expect(out).not.toContain('## ');
    expect(out).not.toContain('### ');
  });

  it('substitutes [text](url) via injected link formatter', () => {
    const out = renderGuide('See [飞书开放平台](https://open.feishu.cn/app)', {
      link: (t, u) => `LINK(${t}|${u})`,
    });
    expect(out).toContain('LINK(飞书开放平台|https://open.feishu.cn/app)');
    expect(out).not.toContain('[飞书开放平台]');
  });

  it('wraps `code` spans in ANSI cyan', () => {
    const out = renderGuide('Run `multi-cc-im start`');
    expect(out).toContain('\x1b[36mmulti-cc-im start\x1b[0m');
  });

  it('noColor: true emits no ANSI escape codes (NO_COLOR / non-TTY)', () => {
    const out = renderGuide('# Title `code` [link](https://x)', {
      noColor: true,
      link: (t, u) => `${t} ${u}`,
    });
    expect(out).not.toContain('\x1b');
  });

  it('passes lists / paragraphs / blank lines through verbatim', () => {
    const md = 'paragraph\n\n- bullet 1\n- bullet 2\n\nnext';
    const out = renderGuide(md, { noColor: true });
    expect(out).toBe(md);
  });

  it('multiple links on one line each substituted independently', () => {
    const out = renderGuide('see [a](u1) and [b](u2)', {
      link: (t, u) => `${t}@${u}`,
      noColor: true,
    });
    expect(out).toBe('see a@u1 and b@u2');
  });

  it('handles the actual docs/setup-feishu.md shape (heading + link + code)', () => {
    const md = '# 配置飞书自建应用\n\n访问 [飞书开放平台](https://open.feishu.cn/app)，点击「创建」。\n\n`App ID` 是公开标识。';
    const out = renderGuide(md);
    // Heading bolded
    expect(out).toContain('配置飞书自建应用');
    // Link substituted (real terminal-link default fallback is "text url" plain-text)
    expect(out).toContain('https://open.feishu.cn/app');
    expect(out).not.toContain('[飞书开放平台]');
    // Code span cyaned
    expect(out).toContain('\x1b[36mApp ID\x1b[0m');
    // Body text preserved
    expect(out).toContain('，点击「创建」');
  });

  it('default link formatter is terminal-link (provides plain-text fallback when terminal does not support OSC 8)', () => {
    // We can't deterministically test the OSC 8 path (depends on $TERM /
    // isCI / isTTY), but we can verify that calling without `link` does
    // not throw and produces a string containing the URL — both OSC 8
    // and the plain-text fallback satisfy this.
    const out = renderGuide('[doc](https://example.com)');
    expect(out).toContain('https://example.com');
    expect(out).toContain('doc');
  });
});
