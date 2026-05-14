import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolvePython3Path } from '@multi-cc-im/term-iterm2';
import { resolveWezTermPath } from '@multi-cc-im/term-wezterm';
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
  /**
   * Detect whether WezTerm is installed on this machine. Default tries
   * `resolveWezTermPath` (PATH scan + macOS .app bundle); returns true if
   * the resolver succeeded, false otherwise. Surfaced in the select
   * prompt option hint so the user can pick the terminal they actually
   * have without trial-and-error.
   */
  detectWezTermInstalled: () => Promise<boolean>;
  /**
   * Detect whether iTerm2 is installed. Default checks the standard
   * macOS .app bundle locations (`/Applications/iTerm.app`,
   * `~/Applications/iTerm.app`). Returns true if either is readable.
   */
  detectIterm2Installed: () => Promise<boolean>;
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

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spotlight-backed lookup by macOS bundle identifier. Catches every
 * .app install location Spotlight has indexed — `/Applications/`,
 * `~/Applications/`, `/Applications/Setapp/`, `~/Downloads/...`, etc.
 * Returns true if at least one hit; false if `mdfind` exits with no
 * output OR if `mdfind` is unavailable (non-macOS, Spotlight disabled,
 * `mdutil -i off` on the volume).
 *
 * Per P7 smoke 2026-05-14 user feedback — hard-coding `/Applications/`
 * + `~/Applications/` missed users who installed terminals to custom
 * paths.
 */
async function mdfindByBundleId(bundleId: string): Promise<boolean> {
  try {
    const r = await execFileAsync('mdfind', [
      `kMDItemCFBundleIdentifier == '${bundleId}'`,
    ]);
    return String(r.stdout).trim().length > 0;
  } catch {
    return false;
  }
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
    detectWezTermInstalled: async () => {
      // Try the binary-PATH-scan resolver first (matches Linux + macOS
      // PATH installs / brew); then fall back to Spotlight lookup so
      // custom .app install locations (Setapp / ~/Downloads / etc.) are
      // covered on macOS.
      try {
        await resolveWezTermPath({});
        return true;
      } catch {
        return mdfindByBundleId('com.github.wez.wezterm');
      }
    },
    detectIterm2Installed: async () => {
      // Spotlight first so any non-standard install location is covered;
      // fall back to the two canonical .app paths if Spotlight is
      // disabled or hasn't indexed yet.
      if (await mdfindByBundleId('com.googlecode.iterm2')) return true;
      const candidates = [
        '/Applications/iTerm.app',
        join(homedir(), 'Applications', 'iTerm.app'),
      ];
      for (const c of candidates) {
        if (await isReadable(c)) return true;
      }
      return false;
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
 *           Python API preference (one-time user action — toggle in
 *           iTerm2 Settings).
 *        b. Resolve `python3` binary; error out if not found.
 *        c. Prompt: `pip install --user iterm2` ? Run it on confirm.
 *        d. **Empirical** verification: spawn `python3` running
 *           `iterm2.run_until_complete(async_get_app)`. If it connects
 *           the Python API server is provably running; if it fails we
 *           know definitively the preference is off (or iTerm2 isn't
 *           launched), and surface a concrete "Settings → General →
 *           Magic" hint. This replaces the prior `confirm + import
 *           smoke` combo which was a `hope`, not a `gate` — the user
 *           could press Enter without actually toggling the pref and
 *           the wizard would walk on (P7 smoke 2026-05-14 root cause).
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

  // Detect installed terminals BEFORE rendering the select so each option
  // can display its install status. Without this hint the user picks
  // blindly and then hits a "not found" error at adapter creation time —
  // the wizard should surface that up front (P7 smoke feedback).
  const [wezInstalled, it2Installed] = await Promise.all([
    deps.detectWezTermInstalled(),
    deps.detectIterm2Installed(),
  ]);

  const choice = await io.select<TerminalId>({
    message: 'Pick a terminal:',
    options: [
      {
        value: 'wezterm',
        label: 'WezTerm',
        hint: wezInstalled
          ? '✓ installed — native CLI, lowest friction'
          : 'not installed — `brew install --cask wezterm`',
      },
      {
        value: 'iterm2',
        label: 'iTerm2',
        hint: it2Installed
          ? '✓ installed — macOS only, uses Python API helper'
          : 'not installed — `brew install --cask iterm2`',
      },
    ],
    initialValue: initial,
  });

  if (io.isCancel(choice)) {
    return { status: 'cancelled' };
  }

  // Gate on installed status. The hint shown in the select option warned
  // the user this terminal wasn't on disk; if they pick it anyway, hard-
  // stop rather than walking them through prefs / pip install for a
  // terminal that doesn't exist. Per P7 smoke feedback 2026-05-14.
  if (choice === 'wezterm' && !wezInstalled) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: WezTerm is not installed.\n' +
        '  Install: `brew install --cask wezterm`\n' +
        '  Then re-run `multi-cc-im start`.',
    };
  }
  if (choice === 'iterm2' && !it2Installed) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: iTerm2 is not installed.\n' +
        '  Install: `brew install --cask iterm2`\n' +
        '  Then re-run `multi-cc-im start`.',
    };
  }

  if (choice === 'wezterm') {
    return { status: 'configured', id: 'wezterm' };
  }

  // iterm2 setup pipeline

  io.message(
    [
      '🔧 iTerm2 setup — three steps:',
      '',
      '1. Enable the Python API preference (one-time, in iTerm2 itself):',
      `   ${ansiLink(
        'https://iterm2.com/python-api/connection.html#authentication',
        'iTerm2 docs: enabling the Python API',
      )}`,
      '   Path: iTerm2 → Settings → General → Magic → ☑ Enable Python API',
      '',
      '2. We will resolve your `python3` binary + install the `iterm2`',
      '   PyPI package (one time).',
      '',
      '3. We will then connect to iTerm2 to verify the preference is on.',
      '   First call may prompt for macOS Automation permission — click',
      '   "OK" so this script can talk to iTerm2.',
    ].join('\n'),
  );

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

  // `--break-system-packages` bypasses PEP 668 ("externally-managed
  // environment") on Homebrew Python ≥ 3.12 / Debian-managed Python.
  // Combined with `--user` the package lands in the user site-packages
  // (e.g. `~/Library/Python/3.12/lib/python/site-packages` on macOS),
  // NOT the system Python — brew Python's site-packages stays clean.
  // Without this flag the install fails on most modern macOS installs
  // (P7 smoke feedback). See https://peps.python.org/pep-0668/.
  const pipArgs = [
    '-m',
    'pip',
    'install',
    '--user',
    '--break-system-packages',
    'iterm2',
  ];
  const doInstall = await io.confirm({
    message: `Install \`iterm2\` PyPI package now? (${python3} ${pipArgs.join(' ')})`,
    initialValue: true,
  });
  if (io.isCancel(doInstall)) return { status: 'cancelled' };
  if (doInstall) {
    try {
      await deps.exec(python3, pipArgs);
      io.info('Installed iterm2 PyPI package.');
    } catch (err) {
      return {
        status: 'error',
        exitCode: 1,
        message:
          'multi-cc-im start: `pip install iterm2` failed — ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n  If your Python is managed by an OS package manager, try:' +
          '\n    pipx install iterm2  (preferred — virtualenv-based)' +
          '\n  Then re-run `multi-cc-im start`.',
      };
    }
  }

  // Empirical verification — connect to iTerm2's Python API. This is the
  // ONLY way to know definitively whether the user enabled the
  // preference (a confirm prompt is `hope`, not `gate` — the user can
  // press Enter without actually toggling). Failures cluster around two
  // root causes the user can fix:
  //   - preference is off (iTerm2 server isn't running → connect refused)
  //   - iTerm2 isn't launched
  // Catches one more failure the user can't fix from here but should know:
  //   - pip install silently failed → `import iterm2` raises ImportError
  //     before run_until_complete runs (caught by the same try/except).
  // Also surfaces the first-call Automation permission dialog at a known
  // moment (user is still in the wizard, watching the screen).
  const connectSmoke = [
    'import iterm2',
    'async def main(c):',
    '    await iterm2.async_get_app(c)',
    'iterm2.run_until_complete(main)',
  ].join('\n');
  try {
    await deps.exec(python3, ['-c', connectSmoke]);
    io.info('Smoke check: iTerm2 Python API is reachable.');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: cannot connect to iTerm2 Python API.\n' +
        '  This usually means the preference is off, or iTerm2 is not running.\n' +
        '  Fix:\n' +
        '    1. Launch iTerm2 (any installed copy — they share preferences)\n' +
        '    2. Settings → General → Magic → ☑ Enable Python API\n' +
        '    3. Re-run `multi-cc-im start`\n' +
        `  Detail (from python3): ${detail}`,
    };
  }

  return { status: 'configured', id: 'iterm2', python3 };
}
