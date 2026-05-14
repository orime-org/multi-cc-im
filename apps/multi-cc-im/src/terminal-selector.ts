import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePython3Path } from '@multi-cc-im/term-iterm2';
import type { TerminalId } from '@multi-cc-im/shared';
import { realClackIO, type WizardPromptIO } from './wizard/io.js';

const execFileAsync = promisify(execFile);

/**
 * Result of the terminal-adapter selection step. The wizard returns one
 * of three shapes:
 *
 *   - `configured` — user picked a terminal AND (for iterm2) the
 *     prerequisite setup completed. Caller persists this into
 *     `config.toml` `[terminal].type` + (iterm2) `[external_paths].python3`.
 *   - `cancelled` — user backed out (Ctrl-C or "Cancel" choice). Caller
 *     exits 0, daemon never starts.
 *   - `error` — non-recoverable failure during iterm2 setup (no python3
 *     on PATH, pip install failed, etc.). Caller exits with the given
 *     `exitCode` + writes `message` to stderr.
 *
 * Per [DD: iTerm2 adapter P4](../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#9-implementation-milestone-plan-to-be-detailed-after-lock).
 */
export type SelectTerminalResult =
  | { status: 'configured'; id: TerminalId; python3?: string }
  | { status: 'cancelled' }
  | { status: 'error'; exitCode: number; message: string };

export interface SelectTerminalDeps {
  /**
   * Locate a `python3` interpreter on the user's machine. Default delegates
   * to `resolvePython3Path` from `@multi-cc-im/term-iterm2` (PATH scan +
   * brew + Xcode CLT). Tests inject a stub that returns a fixed path or
   * throws to exercise the "python3 missing" branch.
   */
  resolvePython3: () => Promise<string>;
  /**
   * Run a child process and return stdout/stderr. Default uses
   * `child_process.execFile`. Tests inject a stub to control pip install
   * success/failure + the iterm2 `import` smoke check.
   */
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export interface SelectTerminalOpts {
  /**
   * Pre-built I/O surface (defaults to `realClackIO`). Tests inject a
   * scripted `WizardPromptIO` to step through prompts deterministically.
   */
  io?: WizardPromptIO;
  /**
   * Side-effect dependencies. Default uses production implementations
   * (real python3 resolver + `execFile`). Override in tests.
   */
  deps?: SelectTerminalDeps;
  /**
   * Currently-persisted terminal id from `config.toml` `[terminal].type`.
   * When set, the wizard pre-selects this option so the user can press
   * Enter to keep their existing choice. `undefined` = first-time run
   * (no `[terminal]` section in config), default-selects `wezterm`.
   */
  currentTerminal?: TerminalId;
}

/**
 * Default deps wiring — direct passthrough to production implementations.
 * Hoisted so the public `selectTerminal` signature stays tiny.
 */
function defaultDeps(): SelectTerminalDeps {
  return {
    resolvePython3: () => resolvePython3Path({}),
    exec: async (cmd, args) => {
      const r = await execFileAsync(cmd, args);
      // Default execFile encoding is utf8, so stdout/stderr are strings.
      return { stdout: String(r.stdout), stderr: String(r.stderr) };
    },
  };
}

/**
 * Render an OSC 8 hyperlink terminals will display as clickable text. The
 * URL is wrapped per the OSC 8 protocol (`\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\`).
 * Used for the iterm2 Python API preference instructions — clicking opens
 * the iterm2 docs in the user's browser.
 *
 * Mirrors the W6 inline-guide pattern (PR #101) — same protocol, same
 * fallback behavior on terminals that don't support OSC 8 (the URL
 * itself becomes selectable text, still useful).
 */
function ansiLink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Interactive terminal-adapter selection. P4 of the iTerm2 adapter
 * milestone chain.
 *
 * Flow:
 *   1. `select` between wezterm and iterm2 (pre-select `currentTerminal`)
 *   2. wezterm picked → return `{configured, id: 'wezterm'}` (no setup)
 *   3. iterm2 picked → setup pipeline:
 *        a. Render ANSI-hyperlink instructions for enabling iTerm2's
 *           Python API preference. Wait for user confirmation that they
 *           toggled it.
 *        b. Resolve `python3` binary; error out if not found.
 *        c. Prompt: `pip install --user iterm2` ? Run it on confirm.
 *        d. Smoke test: `python3 -c "import iterm2"` to verify the
 *           install + Automation permission. (First-time install
 *           triggers the macOS Automation dialog here, which we want
 *           because the wizard can hand-hold the user through it.)
 *   4. Return `{configured, id: 'iterm2', python3}`
 *
 * Per CLAUDE.md "no hardcoded external CLI paths" — `python3` is
 * resolved at runtime via `resolvePython3Path` and cached to
 * `config.toml` by the caller, not baked into anything.
 */
export async function selectTerminal(
  opts: SelectTerminalOpts = {},
): Promise<SelectTerminalResult> {
  const io = opts.io ?? realClackIO;
  const deps = opts.deps ?? defaultDeps();
  const initial: TerminalId = opts.currentTerminal ?? 'wezterm';

  const choice = await io.select<TerminalId>({
    message: 'Pick a terminal:',
    options: [
      { value: 'wezterm', label: 'WezTerm', hint: 'native CLI, lowest friction' },
      {
        value: 'iterm2',
        label: 'iTerm2',
        hint: 'macOS default — uses Python API helper',
      },
    ],
    initialValue: initial,
  });

  if (io.isCancel(choice)) {
    return { status: 'cancelled' };
  }

  if (choice === 'wezterm') {
    return { status: 'configured', id: 'wezterm' };
  }

  // iterm2 setup pipeline

  io.message(
    [
      '🔧 iTerm2 setup — three steps:',
      '',
      '1. Enable the Python API preference:',
      `   ${ansiLink(
        'https://iterm2.com/python-api/connection.html#authentication',
        'iTerm2 docs: enabling the Python API',
      )}`,
      '   Path: iTerm2 → Preferences → General → Magic → ☑ Enable Python API',
      '',
      '2. We will resolve your `python3` binary + install the `iterm2`',
      '   PyPI package (one time).',
      '',
      '3. First call may prompt for macOS Automation permission — click',
      '   "OK" so this script can talk to iTerm2.',
    ].join('\n'),
  );

  const prefsDone = await io.confirm({
    message: 'Did you enable Python API in iTerm2 Preferences?',
    initialValue: false,
  });
  if (io.isCancel(prefsDone)) return { status: 'cancelled' };
  if (!prefsDone) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: iTerm2 setup aborted — enable Python API in iTerm2 Preferences and rerun.',
    };
  }

  let python3: string;
  try {
    python3 = await deps.resolvePython3();
  } catch (err) {
    return {
      status: 'error',
      exitCode: 1,
      message: `multi-cc-im start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  io.info(`Found python3 at ${python3}`);

  const doInstall = await io.confirm({
    message: `Install \`iterm2\` PyPI package now? (${python3} -m pip install --user iterm2)`,
    initialValue: true,
  });
  if (io.isCancel(doInstall)) return { status: 'cancelled' };
  if (doInstall) {
    try {
      await deps.exec(python3, ['-m', 'pip', 'install', '--user', 'iterm2']);
      io.info('Installed iterm2 PyPI package.');
    } catch (err) {
      return {
        status: 'error',
        exitCode: 1,
        message:
          'multi-cc-im start: `pip install iterm2` failed — ' +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  // Smoke import. Catches: pip install silently failed / wrong python3 /
  // user skipped install but the package wasn't there. Also surfaces the
  // first-call Automation permission dialog at a known moment (the user
  // is still in the wizard, watching the screen).
  try {
    await deps.exec(python3, ['-c', 'import iterm2']);
    io.info('Smoke check: `python3 -c "import iterm2"` OK.');
  } catch (err) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: cannot import `iterm2` Python package — ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n  Retry: re-run wizard and confirm the install step.',
    };
  }

  return { status: 'configured', id: 'iterm2', python3 };
}
