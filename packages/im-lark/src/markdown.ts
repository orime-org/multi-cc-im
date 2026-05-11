/**
 * Strip markdown markers from a string so a Feishu `msg_type: 'text'`
 * message renders sanely. Feishu text messages do NOT parse markdown —
 * `**bold**` / `# heading` / fenced code blocks all display literally.
 * Without stripping, cc replies look cluttered with backslashes,
 * asterisks, and triple backticks.
 *
 * Per user smoke 2026-05-11. Not a full markdown parser — handles the
 * syntax cc actually emits (headings, emphasis, lists, inline code,
 * links, code blocks, strikethrough). Edge cases like nested emphasis
 * or tables degrade gracefully (best-effort, no crash).
 *
 * Code blocks are special: their inner content is preserved verbatim
 * so an embedded `**literal**` stays literal. Otherwise we'd
 * accidentally strip emphasis inside source code samples.
 *
 * @param md  Raw markdown text from cc's last_assistant_message.
 * @returns   Plain-text rendering safe to send as `msg_type: 'text'`.
 */
export function stripMarkdown(md: string): string {
  if (md.length === 0) return md;

  // Split into segments alternating between non-code and fenced-code.
  // Inline-strip rules run only on non-code segments so emphasis inside
  // source samples is preserved.
  const codeBlockRe = /```([^`\n]*)\n([\s\S]*?)```/g;
  const segments: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    segments.push(stripInline(md.slice(lastIdx, match.index)));
    segments.push(formatCodeBlock(match[1] ?? '', match[2] ?? ''));
    lastIdx = codeBlockRe.lastIndex;
  }
  segments.push(stripInline(md.slice(lastIdx)));

  return segments.join('');
}

/**
 * Apply inline strip rules (headings, emphasis, links, lists, code spans).
 * Caller must pre-strip fenced code blocks so source samples don't get
 * their inner emphasis molested.
 */
function stripInline(text: string): string {
  return (
    text
      // Headings — `# Title` / `## Sub` / `### Sect` → `▌ Title` etc.
      // Single `▌` prefix regardless of heading depth — Feishu text has
      // no native heading rendering anyway, so emphasizing the depth
      // gradient doesn't help.
      .replace(/^(#{1,6})\s+(.+)$/gm, '▌ $2')

      // Inline code `` `code` `` → `「code」`. Run before bold/italic so
      // backtick boundary doesn't accidentally swallow neighboring `*`.
      .replace(/`([^`\n]+)`/g, '「$1」')

      // Bold `**text**` → `text` (run before italic — longer pattern wins)
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')

      // Underline-style `__text__` → `text` (less common; cc sometimes
      // emits this for emphasis)
      .replace(/__([^_\n]+)__/g, '$1')

      // Italic `*text*` → `text`. Negative lookahead/behind protect us
      // from `**` already handled above.
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')

      // Strikethrough `~~text~~` → `text`
      .replace(/~~([^~\n]+)~~/g, '$1')

      // Unordered list `- item` / `* item` → `• item`
      // Multiline mode + capture leading whitespace so nested lists keep
      // their indentation.
      .replace(/^(\s*)[-*]\s+/gm, '$1• ')

      // Links `[text](url)` → `text (url)`. URL kept inline so a Feishu
      // user can long-press to copy or auto-detect.
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  );
}

/**
 * Render a fenced code block as plain text with a small `[lang]`
 * annotation (when present) so reading flow signals "this is code".
 * The fence itself (triple backtick) is dropped. Trailing whitespace
 * trimmed to avoid stray blank lines after the close fence position.
 */
function formatCodeBlock(lang: string, content: string): string {
  const langTag = lang.trim().length > 0 ? `[${lang.trim()}]\n` : '';
  return `${langTag}${content.trimEnd()}`;
}
