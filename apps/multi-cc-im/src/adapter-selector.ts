import { stat } from 'node:fs/promises';
import type { AdapterRegistryEntry } from './adapters.js';
import type { AppPaths } from './config-paths.js';
import { loadGuide, renderGuide } from './wizard/guide.js';
import { realClackIO, type WizardPromptIO } from './wizard/io.js';
import { runWizard, type RunWizardResult } from './wizard/run-wizard.js';

/**
 * Side-effect dependencies the selector needs from the runtime.
 * Carved out as a single object so tests can stub them without touching
 * the filesystem or the wizard module.
 */
export interface SelectAdapterDeps {
  /**
   * Filesystem existence check for credential files. Default uses
   * `node:fs.stat`; tests inject a deterministic predicate.
   */
  isFile: (path: string) => Promise<boolean>;

  /**
   * Persist the wizard's output for an adapter. Default writes
   * `entry.buildPersistShape(values)` to `<adapter>.json` via the
   * adapter's own credential store.
   */
  persistCredentials: (
    entry: AdapterRegistryEntry,
    values: Record<string, unknown>,
  ) => Promise<void>;

  /** Wizard runner — defaults to the production `runWizard`. */
  runWizard: typeof runWizard;

  /**
   * Whether stdin is a TTY. Default reads `process.stdin.isTTY`. Tests
   * fix this to a known value to exercise the headless guard.
   */
  isTTY: boolean;
}

export interface SelectAndConfigureOpts {
  /**
   * Positional CLI arg from `multi-cc-im start [<adapter>]`. `undefined`
   * means no arg was supplied, in which case we render an interactive
   * adapter-selection menu.
   */
  adapterArg: string | undefined;

  /**
   * Resolved app paths used to look up credential file locations.
   * Defaults to a stub-friendly minimum: only `credentialFor` is used.
   */
  paths?: Pick<AppPaths, 'credentialFor'>;

  /** Adapter registry to choose from. */
  registry: readonly AdapterRegistryEntry[];

  /** Override the prompt IO; tests inject a scripted stub. */
  io?: WizardPromptIO;

  /** Override side-effect deps; tests inject stubs. */
  deps?: Partial<SelectAdapterDeps>;
}

export type SelectAdapterResult =
  | { status: 'configured'; adapter: AdapterRegistryEntry }
  | { status: 'cancelled' }
  | { status: 'error'; message: string; exitCode: number };

const defaultIsFile = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
};

const defaultDeps: SelectAdapterDeps = {
  isFile: defaultIsFile,
  persistCredentials: async () => {
    throw new Error(
      'persistCredentials not configured — pass deps.persistCredentials when calling selectAndConfigureAdapter',
    );
  },
  runWizard,
  isTTY: process.stdin.isTTY === true,
};

/**
 * Drive the D1 / D5 flow: pick an adapter (interactive menu when no arg,
 * direct lookup when an arg is supplied), then check credentials and
 * branch into the wizard if missing.
 *
 * Per [DD §4](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#4-d1--locked-decision-single-start-command).
 *
 * Behavior matrix:
 *
 *   no-arg + TTY    → adapter menu → cred check → daemon | wizard | back
 *   no-arg + !TTY   → status='error' (must specify adapter id headlessly)
 *   with-arg known  → cred check → daemon | wizard | error
 *   with-arg !known → status='error' (lists known ids)
 *
 * In the no-arg path, picking 返回 from the unconfigured-creds menu
 * re-renders the adapter menu (lets user pick a different adapter).
 * In the with-arg path, 返回 returns status='error' (user explicitly
 * named an unconfigured adapter and bailed).
 *
 * Cancellation at any prompt (clack's sentinel symbol via `isCancel`)
 * returns `{ status: 'cancelled' }` — caller treats as a clean exit.
 */
export async function selectAndConfigureAdapter(
  opts: SelectAndConfigureOpts,
): Promise<SelectAdapterResult> {
  const io = opts.io ?? realClackIO;
  const deps: SelectAdapterDeps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const credentialFor = opts.paths?.credentialFor ?? ((id: string) => `${id}.json`);

  // ===== With-arg path =====
  if (opts.adapterArg !== undefined) {
    const entry = opts.registry.find((a) => a.id === opts.adapterArg);
    if (!entry) {
      return {
        status: 'error',
        exitCode: 2,
        message: `multi-cc-im start: unknown adapter '${opts.adapterArg}'\n  Available: ${opts.registry.map((a) => a.id).join(', ')}`,
      };
    }
    const result = await branchOnCredentials(entry, opts.adapterArg, {
      io,
      deps,
      credentialFor,
    });
    // With-arg path: `branchOnCredentials` never returns `'back'` here —
    // 返回 in with-arg case is folded into `status: 'error'`. Defensive
    // narrow so the public return type stays clean.
    if (result.status === 'back') {
      throw new Error(
        "selectAndConfigureAdapter: unreachable 'back' status in with-arg path",
      );
    }
    return result;
  }

  // ===== No-arg path =====
  if (!deps.isTTY) {
    return {
      status: 'error',
      exitCode: 2,
      message:
        `multi-cc-im start: not a TTY — pass an adapter id explicitly for headless invocation\n` +
        `  Example: \`multi-cc-im start lark\``,
    };
  }

  // Loop allows the unconfigured-creds [返回] branch (status: 'back') to
  // re-show the adapter menu so the user can pick a different IM.
  while (true) {
    const entry = await runAdapterMenu(opts.registry, io, deps, credentialFor);
    if (entry === 'cancel') return { status: 'cancelled' };

    const branchResult = await branchOnCredentials(entry, undefined, {
      io,
      deps,
      credentialFor,
    });
    switch (branchResult.status) {
      case 'configured':
      case 'error':
      case 'cancelled':
        return branchResult;
      case 'back':
        continue;
    }
  }
}

type BranchResult = SelectAdapterResult | { status: 'back' };

async function branchOnCredentials(
  entry: AdapterRegistryEntry,
  adapterArg: string | undefined,
  ctx: {
    io: WizardPromptIO;
    deps: SelectAdapterDeps;
    credentialFor: (id: string) => string;
  },
): Promise<BranchResult> {
  const credPath = ctx.credentialFor(entry.id);
  const configured = await ctx.deps.isFile(credPath);
  if (configured) return { status: 'configured', adapter: entry };

  // Headless guard: with-arg + missing creds → can't run wizard.
  if (!ctx.deps.isTTY) {
    return {
      status: 'error',
      exitCode: 1,
      message:
        `multi-cc-im start: ${entry.id} is not configured and stdin is not a TTY — cannot run setup wizard headlessly\n` +
        `  Run \`multi-cc-im login ${entry.id} --app-id <id> --app-secret <secret>\` first.`,
    };
  }

  ctx.io.info(`${entry.setupSchema.displayName} 未配置`);
  const choice = await ctx.io.select({
    message: `Configure ${entry.id} now?  (↑↓ to move / Enter to select / Ctrl+C to cancel)`,
    options: [
      { value: 'configure', label: '开始配置' },
      { value: 'back', label: '返回' },
    ],
    initialValue: 'configure',
  });
  if (ctx.io.isCancel(choice)) return { status: 'cancelled' };

  if (choice === 'back') {
    if (adapterArg !== undefined) {
      // With-arg: user chose this adapter explicitly + bailed.
      return {
        status: 'error',
        exitCode: 1,
        message: `multi-cc-im start: ${entry.id} is not configured`,
      };
    }
    return { status: 'back' };
  }

  // 'configure' → run wizard.
  // Per [DD §10.1 W6]: when the adapter declares a markdown guide, render
  // it through `terminal-link` so OSC-8-capable terminals get clickable
  // hyperlinks while the rest get plain-text fallback. Loader silently
  // returns null if the file is missing (`docs/setup-feishu.md` not
  // shipped in some downstream packaging), in which case the wizard
  // proceeds without an intro guide — same UX as before W6.
  let guide: string | undefined;
  if (entry.guideDocPath) {
    const raw = await loadGuide(entry.guideDocPath);
    if (raw !== null) guide = renderGuide(raw);
  }

  const wizardResult: RunWizardResult = await ctx.deps.runWizard({
    schema: entry.setupSchema,
    io: ctx.io,
    guide,
  });
  if (wizardResult.status === 'cancelled') {
    if (adapterArg !== undefined) return { status: 'cancelled' };
    // No-arg: treat wizard cancel same as 返回 — re-show menu.
    return { status: 'back' };
  }

  await ctx.deps.persistCredentials(entry, wizardResult.values);
  return { status: 'configured', adapter: entry };
}

async function runAdapterMenu(
  registry: readonly AdapterRegistryEntry[],
  io: WizardPromptIO,
  deps: SelectAdapterDeps,
  credentialFor: (id: string) => string,
): Promise<AdapterRegistryEntry | 'cancel'> {
  const presence = await Promise.all(
    registry.map(async (entry) => ({
      entry,
      configured: await deps.isFile(credentialFor(entry.id)),
    })),
  );
  const firstConfigured = presence.find((p) => p.configured)?.entry.id;
  const options = presence.map(({ entry, configured }) => ({
    value: entry.id,
    label: entry.setupSchema.displayName,
    // Hint string deliberately avoids embedding "configured" as a
    // substring in the unconfigured case so tests can distinguish them
    // with a simple `toContain('✓ configured')` check.
    hint: configured ? '✓ configured' : '— not set up',
  }));

  const pick = await io.select({
    message: 'Pick an IM adapter to start  (↑↓ to move / Enter to select / Ctrl+C to cancel)',
    options,
    initialValue: firstConfigured,
  });
  if (io.isCancel(pick)) return 'cancel';

  const entry = registry.find((a) => a.id === pick);
  if (!entry) {
    throw new Error(
      `selectAndConfigureAdapter: clack returned unknown adapter id '${String(pick)}'`,
    );
  }
  return entry;
}
