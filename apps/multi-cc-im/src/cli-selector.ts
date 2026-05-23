import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CLIId } from '@multi-cc-im/shared';
import { realClackIO, type WizardPromptIO } from './wizard/io.js';

const execFileAsync = promisify(execFile);

/**
 * Result of the CLI multiselect wizard step (step 1 of the 4-step
 * `multi-cc-im start` flow, per
 * [DD §11.5 revision 2026-05-23](../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md)).
 *
 * - `configured`: user picked ≥1 CLI; caller persists into
 *   `config.toml [cli].enabled` and runs the corresponding setup-hooks
 *   per id (cc → `~/.claude/settings.json`, codex → `~/.codex/config.toml`).
 * - `cancelled`: user pressed Ctrl-C in the prompt.
 * - `error`: precondition failed (no supported CLI installed; user
 *   submitted empty selection somehow).
 */
export type SelectCLIsResult =
  | { status: 'configured'; ids: readonly CLIId[] }
  | { status: 'cancelled' }
  | { status: 'error'; exitCode: number; message: string };

export interface SelectCLIsDeps {
  /**
   * Probe whether a CLI binary is on PATH. Default uses `command -v <bin>`
   * via `execFile`; tests inject a stub to script presence/absence.
   *
   * Returns `true` if `command -v <bin>` exits 0 (binary found).
   */
  detectInstalled: (bin: string) => Promise<boolean>;
}

export interface SelectCLIsOpts {
  /**
   * Pre-checked entries from persisted `[cli].enabled`. First-run starts
   * with `['cc']` since CC is the historical default.
   */
  currentEnabled?: readonly CLIId[];
  io?: WizardPromptIO;
  deps?: SelectCLIsDeps;
}

interface CLIDescriptor {
  id: CLIId;
  label: string;
  bin: string;
  installLink: string;
}

const CLI_REGISTRY: readonly CLIDescriptor[] = [
  {
    id: 'cc',
    label: 'Claude Code',
    bin: 'claude',
    installLink: 'https://docs.claude.com/claude-code/quickstart',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    bin: 'codex',
    installLink: 'https://github.com/openai/codex#installation',
  },
];

/**
 * Default `detectInstalled`: runs `command -v <bin>` and treats non-zero
 * exit (or any spawn error) as "not installed". `command -v` is a POSIX
 * shell built-in on every macOS / Linux shell — preferred over `which`
 * because it doesn't depend on a separate binary being present.
 *
 * We invoke via `/bin/sh -c 'command -v "<bin>"'` because `command` is a
 * shell built-in, not a standalone binary — direct `execFile('command',
 * ...)` would ENOENT.
 */
async function defaultDetectInstalled(bin: string): Promise<boolean> {
  try {
    // Single-quote `bin` then strip any embedded single quotes to defuse
    // command injection. Our caller only passes hard-coded values from
    // CLI_REGISTRY so this is defense-in-depth, not a primary control.
    const safeBin = bin.replace(/'/g, '');
    await execFileAsync('/bin/sh', ['-c', `command -v '${safeBin}'`]);
    return true;
  } catch {
    return false;
  }
}

function defaultDeps(): SelectCLIsDeps {
  return { detectInstalled: defaultDetectInstalled };
}

/**
 * Step 1 of the 4-step wizard: multiselect which CLI agents the daemon
 * bridges to IM. Probes each candidate via PATH lookup, displays install
 * status as the option hint, pre-checks any persisted entries from
 * `[cli].enabled`, and requires ≥1 confirmed selection.
 *
 * Why no quiet auto-pick when only one CLI is installed: explicit user
 * direction 2026-05-23 — wizard transparency over single-keystroke
 * convenience. The user sees the full list every time, knows what's on
 * disk, and chooses.
 */
export async function selectCLIs(
  opts: SelectCLIsOpts = {},
): Promise<SelectCLIsResult> {
  const io = opts.io ?? realClackIO;
  const deps = opts.deps ?? defaultDeps();

  // Probe all candidates in parallel.
  const installed = new Map<CLIId, boolean>();
  await Promise.all(
    CLI_REGISTRY.map(async (cli) => {
      installed.set(cli.id, await deps.detectInstalled(cli.bin));
    }),
  );

  const anyInstalled = [...installed.values()].some((v) => v);
  if (!anyInstalled) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: no supported CLI installed on this machine.\n' +
        CLI_REGISTRY.map((c) => `  - ${c.label}: ${c.installLink}`).join('\n') +
        '\n  Install at least one, then re-run `multi-cc-im start`.',
    };
  }

  // Pre-check persisted entries that are still installed; otherwise
  // pre-check the first installed candidate so the user can press Enter
  // straight away on a first-run / freshly-installed machine.
  const persistedInstalled = (opts.currentEnabled ?? []).filter((id) =>
    installed.get(id),
  );
  const fallbackFirst = CLI_REGISTRY.find((c) => installed.get(c.id))?.id;
  const initialValues: readonly CLIId[] =
    persistedInstalled.length > 0
      ? persistedInstalled
      : fallbackFirst !== undefined
        ? [fallbackFirst]
        : [];

  const choice = await io.multiselect<CLIId>({
    message:
      'Pick which command-line agents the daemon should bridge to IM ' +
      '(Space to toggle, Enter to confirm — at least 1):',
    options: CLI_REGISTRY.map((cli) => {
      const yes = installed.get(cli.id) === true;
      return {
        value: cli.id,
        label: cli.label,
        hint: yes
          ? `✓ installed (${cli.bin})`
          : `not installed — ${cli.installLink}`,
      };
    }),
    initialValues,
    required: true,
  });

  if (io.isCancel(choice)) {
    return { status: 'cancelled' };
  }

  const picked = choice as readonly CLIId[];
  if (picked.length === 0) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'multi-cc-im start: no CLI picked. At least one CLI must be bridged.',
    };
  }

  // Reject any picked CLI that isn't actually on disk (user defied the
  // hint and picked an uninstalled one anyway).
  const missing = picked.filter((id) => !installed.get(id));
  if (missing.length > 0) {
    const labels = missing
      .map(
        (id) =>
          CLI_REGISTRY.find((c) => c.id === id)?.label ?? id,
      )
      .join(', ');
    return {
      status: 'error',
      exitCode: 1,
      message:
        `multi-cc-im start: picked CLI(s) not installed on this machine: ${labels}.\n` +
        '  Install them or unpick from the wizard.',
    };
  }

  return { status: 'configured', ids: picked };
}
