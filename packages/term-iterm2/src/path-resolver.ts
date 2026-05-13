import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default PATH directories scanned in order (matches `which python3` on
 * most shells). Caller can override via `pathDirs`. Apple Silicon brew
 * comes first since most multi-cc-im users on M1+ Macs install Python
 * there.
 */
const DEFAULT_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/local/sbin',
  '/usr/sbin',
  '/sbin',
  join(homedir(), '.local', 'bin'),
  // macOS Command Line Tools / Xcode-bundled Python
  '/Library/Developer/CommandLineTools/usr/bin',
];

export interface ResolvePython3PathOpts {
  /**
   * Previously cached absolute path (e.g. from
   * `~/.multi-cc-im/config.toml`'s `iterm2.python3` field). Verified for
   * executable existence first; if missing, falls through to discovery.
   */
  cachedPath?: string;
  /**
   * Directories to scan as PATH (each appended `/python3`). Defaults to a
   * macOS-friendly list (Apple Silicon brew + Intel brew + system + user
   * + Xcode CLT).
   */
  pathDirs?: string[];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to a `python3` binary capable of running
 * `iterm2-helper.py`. Per
 * [DD: iTerm2 adapter §7](../../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#7-trade-offs-the-user-accepts-by-locking-c1):
 * the user accepted Python 3 + `iterm2` PyPI as a runtime dependency. The
 * setup wizard (P4) will install the PyPI package; this resolver just
 * locates the interpreter.
 *
 * Order:
 *   1. `cachedPath` if given AND still executable (handles user uninstall)
 *   2. `pathDirs` scan (default: macOS PATH-equivalent dirs + CLT)
 *   3. throw fail-fast with install hint
 *
 * Per CLAUDE.md "no hardcoded secrets / external CLI paths": no
 * absolute path is baked into hooks / commands / fixtures. Caller
 * (CLI / bridge core) resolves once at startup and caches result in
 * `~/.multi-cc-im/config.toml`.
 *
 * Note: the resolver verifies executable bit only — it does NOT verify
 * Python version or that the `iterm2` PyPI package is importable. That
 * check belongs in the setup wizard (P4) which can give better UX hints
 * than a hook subprocess.
 */
export async function resolvePython3Path(
  opts: ResolvePython3PathOpts = {},
): Promise<string> {
  if (opts.cachedPath && (await isExecutable(opts.cachedPath))) {
    return opts.cachedPath;
  }

  const pathDirs = opts.pathDirs ?? DEFAULT_PATH_DIRS;
  for (const dir of pathDirs) {
    const candidate = join(dir, 'python3');
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    'python3 not found on PATH or common install locations.\n' +
      '  Install via:\n' +
      '    macOS: `brew install python3` or `xcode-select --install`\n' +
      '  Then run setup wizard again to register the path.',
  );
}
