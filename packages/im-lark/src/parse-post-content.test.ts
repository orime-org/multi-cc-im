import { describe, it, expect } from 'vitest';
import { parsePostContent } from './parse-post-content.js';

describe('parsePostContent', () => {
  it('parses wrapped zh_cn body with title + text', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '问题',
        content: [[{ tag: 'text', text: '这个 bug 怎么修？' }]],
      },
    });
    const out = parsePostContent(raw);
    expect(out).toEqual({
      title: '问题',
      text: '问题\n\n这个 bug 怎么修？',
      imageKeys: [],
    });
  });

  it('parses unwrapped (no lang key) body — receive-side variant', () => {
    const raw = JSON.stringify({
      title: 'Q',
      content: [[{ tag: 'text', text: 'hello' }]],
    });
    const out = parsePostContent(raw);
    expect(out).toEqual({
      title: 'Q',
      text: 'Q\n\nhello',
      imageKeys: [],
    });
  });

  it('extracts image_keys in document order and skips img nodes in rendered text', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'text', text: '看这两张图：' }],
          [{ tag: 'img', image_key: 'img_v3_abc' }],
          [{ tag: 'img', image_key: 'img_v3_def' }],
          [{ tag: 'text', text: '解释一下' }],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toBe('看这两张图：\n解释一下');
    expect(out?.imageKeys).toEqual(['img_v3_abc', 'img_v3_def']);
  });

  it('renders a-tag link as `<text> (<href>)` and collapses when text===href', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'text', text: '看这条 ' },
            { tag: 'a', text: 'changelog', href: 'https://example.com/cl' },
            { tag: 'text', text: ' 和原文 ' },
            { tag: 'a', text: 'https://x.com/p', href: 'https://x.com/p' },
          ],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toBe(
      '看这条 changelog (https://example.com/cl) 和原文 https://x.com/p',
    );
  });

  it('renders at-tag as `@<user_name>` (preferred) or `@<user_id>` fallback', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'at', user_name: '张三', user_id: 'ou_zhang' },
            { tag: 'text', text: ' 和 ' },
            { tag: 'at', user_id: 'ou_li' },
            { tag: 'text', text: ' 看下' },
          ],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toBe('@张三 和 @ou_li 看下');
  });

  it('emits `[<tag>]` placeholder for unknown / out-of-scope tags', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'text', text: '位置 ' },
            { tag: 'location', name: '北京' },
            { tag: 'text', text: ' 表情 ' },
            { tag: 'emotion', key: 'smile' },
          ],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toBe('位置 [location] 表情 [emotion]');
  });

  it('hr tag renders as a markdown-ish divider', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'text', text: '上' }],
          [{ tag: 'hr' }],
          [{ tag: 'text', text: '下' }],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toContain('上');
    expect(out?.text).toContain('下');
    expect(out?.text).toContain('---');
  });

  it('returns null on malformed JSON', () => {
    expect(parsePostContent('{not json')).toBeNull();
  });

  it('returns null when body has neither title nor content anywhere', () => {
    const raw = JSON.stringify({ other_field: 'nope' });
    expect(parsePostContent(raw)).toBeNull();
  });

  it('langHint biases multi-locale picker', () => {
    const raw = JSON.stringify({
      zh_cn: { title: 'CN', content: [[{ tag: 'text', text: '中文' }]] },
      en_us: { title: 'EN', content: [[{ tag: 'text', text: 'english' }]] },
    });
    const cn = parsePostContent(raw, 'zh_cn');
    const en = parsePostContent(raw, 'en_us');
    expect(cn?.text).toContain('中文');
    expect(en?.text).toContain('english');
  });

  it('image-only post (no text nodes, only img) yields empty text + image keys', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'img', image_key: 'img_only_1' }],
          [{ tag: 'img', image_key: 'img_only_2' }],
        ],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.text).toBe('');
    expect(out?.imageKeys).toEqual(['img_only_1', 'img_only_2']);
  });

  it('text-only post (no img nodes) yields empty imageKeys array', () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '问题',
        content: [[{ tag: 'text', text: '纯文字 post' }]],
      },
    });
    const out = parsePostContent(raw);
    expect(out?.imageKeys).toEqual([]);
    expect(out?.text).toBe('问题\n\n纯文字 post');
  });
});
