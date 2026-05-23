import type { CLIId } from '@multi-cc-im/shared';
import { realClackIO, type WizardPromptIO } from './wizard/io.js';

/**
 * Result of the AI router single-select wizard step (step 2 of the
 * 4-step `multi-cc-im start` flow, per
 * [DD §11.5 revision 2026-05-23](../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md)).
 *
 * The router CLI is the binary the daemon spawns headless to parse
 * inbound IM messages into routing decisions (`target` / `intent` /
 * `permissionResponse`). It must be one of the CLIs the user enabled
 * in step 1 — otherwise the binary likely isn't on PATH.
 */
export type SelectAIRouterResult =
  | { status: 'configured'; id: CLIId }
  | { status: 'cancelled' }
  | { status: 'error'; exitCode: number; message: string };

export interface SelectAIRouterOpts {
  /**
   * The set of CLIs the user enabled in step 1. The router single-select
   * picks from this set (never from CLIs outside it, even if installed,
   * because we don't want the user later wondering why an unselected
   * CLI is still being spawned).
   */
  enabledCLIs: readonly CLIId[];
  /**
   * Persisted `[cli].aiRouter`. Pre-selects if it's still in
   * `enabledCLIs`; otherwise we pre-select the first enabled CLI so the
   * user can press Enter on a freshly-installed machine.
   */
  currentAIRouter?: CLIId;
  io?: WizardPromptIO;
}

const CLI_LABELS: Record<CLIId, string> = {
  cc: 'Claude Code (claude --print)',
  codex: 'OpenAI Codex (codex exec --output-schema)',
};

const CLI_HINTS: Record<CLIId, string> = {
  cc:
    'spawned per inbound IM message; uses settings.disableAllHooks=true so ' +
    'the spawn does not re-trigger multi-cc-im hooks',
  codex:
    'spawned per inbound IM message; uses --ephemeral + ' +
    '--dangerously-bypass-hook-trust + --sandbox read-only',
};

/**
 * Step 2 of the 4-step wizard: pick which CLI runs the daemon's
 * inbound-IM triage subprocess. Even when `enabledCLIs.length === 1`
 * the user must still press Enter to confirm — per explicit user
 * direction 2026-05-23 ("第 2 步不能跳过") — because the choice
 * controls a long-running subprocess pattern users should consciously
 * accept (privacy / cost / latency profile differs between cc and
 * codex).
 */
export async function selectAIRouter(
  opts: SelectAIRouterOpts,
): Promise<SelectAIRouterResult> {
  const io = opts.io ?? realClackIO;

  if (opts.enabledCLIs.length === 0) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        'selectAIRouter: cannot pick a router from an empty enabledCLIs set. ' +
        'Wizard step 1 (CLI multiselect) should have rejected this state.',
    };
  }

  const persistedValid =
    opts.currentAIRouter !== undefined &&
    opts.enabledCLIs.includes(opts.currentAIRouter)
      ? opts.currentAIRouter
      : undefined;
  const initialValue: CLIId = persistedValid ?? opts.enabledCLIs[0]!;

  const choice = await io.select<CLIId>({
    message:
      'Pick which agent runs the daemon triage subprocess ' +
      '(reads each inbound IM message and decides which tab to route to):',
    options: opts.enabledCLIs.map((id) => ({
      value: id,
      label: CLI_LABELS[id],
      hint: CLI_HINTS[id],
    })),
    initialValue,
  });

  if (io.isCancel(choice)) {
    return { status: 'cancelled' };
  }

  return { status: 'configured', id: choice as CLIId };
}
