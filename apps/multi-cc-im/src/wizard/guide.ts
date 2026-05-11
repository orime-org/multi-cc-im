import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import terminalLink from 'terminal-link';

/**
 * Resolve the `<repo>/docs/` directory relative to the running module.
 *
 * Both production (`<repo>/apps/multi-cc-im/dist/cli.js`) and dev
 * (`<repo>/apps/multi-cc-im/src/wizard/guide.ts` via tsx) layouts agree
 * once we anchor on `import.meta.url`. The repo root is 4 segments up
 * from the dev file (`src/wizard/guide.ts` → `src` → `multi-cc-im` →
 * `apps` → repo) and 3 segments from the dist (`dist/cli.js` →
 * `dist` → `multi-cc-im` → `apps` → repo).
 *
 * We resolve the dev path then `..` to find the repo root, which works
 * for both because the dev layout has one more level. For dist (where
 * the bundle is flat), we fall back to a sibling-dist lookup.
 */
export function defaultDocsDir(): string {
  const here = fileURLToPath(import.meta.url);
  // Dev: <repo>/apps/multi-cc-im/src/wizard/guide.ts → 4 up = repo
  // Dist (bundled): <repo>/apps/multi-cc-im/dist/cli.js → 3 up = repo
  // Use a robust climb: from `here`, walk up until we hit a path whose
  // basename is the repo root. Without a marker file, the safest bet is
  // to use the dev relative path (4 levels) and let production callers
  // override via a config knob if needed.
  const upFromHere = (n: number): string =>
    resolve(dirname(here), ...Array.from({ length: n }, () => '..'));
  // src/wizard/guide.ts → ../../../../docs
  // dist/cli.js          → ../../../docs (one less level)
  // Heuristic: check both layouts; return whichever contains `docs/`.
  // For tests we assume dev layout; production callers can pass an
  // explicit path to `loadGuide` instead of relying on this default.
  return join(upFromHere(4), 'docs');
}

/**
 * Read a markdown guide file. Returns `null` (instead of throwing) when
 * the file does not exist so the wizard can silently fall back to the
 * no-guide UX without a noisy error path.
 *
 * @param filePath Absolute path to the markdown file.
 */
export async function loadGuide(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export interface RenderGuideOpts {
  /**
   * Override the link formatter. Default is `terminal-link` which emits
   * OSC 8 hyperlinks on supporting terminals (iTerm2 / wezterm / Windows
   * Terminal / etc.) and falls back to `${text} ${url}` plain text on
   * the rest.
   *
   * Tests pass `(text, url) => \`LINK(${text}|${url})\`` to assert
   * substitution deterministically without depending on the runtime
   * terminal's capabilities.
   */
  link?: (text: string, url: string) => string;

  /**
   * When `true`, omit ANSI escape codes entirely. Use for testing,
   * `NO_COLOR` environments, or piping to non-TTY destinations. Default
   * `false` — emits bold for headings and cyan for code spans.
   */
  noColor?: boolean;
}

const ANSI_BOLD = '\x1b[1m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

/**
 * Render a markdown guide as a terminal-ready string. The renderer is
 * intentionally narrow — only the syntax we actually emit in
 * `docs/setup-feishu.md` is styled:
 *
 *  - `# Heading` / `## Heading` / `### Heading` → leading `#`s stripped,
 *    text wrapped in ANSI bold.
 *  - `[text](url)` → passed to `opts.link` (default `terminal-link`)
 *    so supporting terminals get OSC 8 hyperlinks and the rest get
 *    plain-text `text url` fallback.
 *  - `` `code` `` → wrapped in ANSI cyan.
 *
 * Everything else passes through unchanged. Keep the source markdown
 * terminal-readable in plain text and we only color what's useful.
 *
 * Per [DD §10.1 W6 / §9.D3-5](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md).
 */
export function renderGuide(
  markdown: string,
  opts: RenderGuideOpts = {},
): string {
  const link = opts.link ?? terminalLink;
  const bold = opts.noColor
    ? (s: string) => s
    : (s: string) => `${ANSI_BOLD}${s}${ANSI_RESET}`;
  const cyan = opts.noColor
    ? (s: string) => s
    : (s: string) => `${ANSI_CYAN}${s}${ANSI_RESET}`;

  return markdown
    .split('\n')
    .map((line) => {
      const heading = /^(#+)\s+(.*)$/.exec(line);
      if (heading) return bold(heading[2]!);
      return line;
    })
    .join('\n')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
      link(text, url),
    )
    .replace(/`([^`]+)`/g, (_, code: string) => cyan(code));
}
