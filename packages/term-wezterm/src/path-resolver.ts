import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default PATH directories scanned in order (matches `which wezterm` on most
 * shells). Caller can override via `pathDirs`.
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
];

/**
 * Default macOS bundle candidates per architecture.md "External CLI tool path
 * strategy". Linux extensions (`/usr/bin/wezterm`,
 * `/home/linuxbrew/.linuxbrew/bin/wezterm`) already live in DEFAULT_PATH_DIRS;
 * this list is for `.app` bundle lookups.
 */
const DEFAULT_BUNDLE_CANDIDATES = [
  '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  join(homedir(), 'Applications', 'WezTerm.app', 'Contents', 'MacOS', 'wezterm'),
];

export interface ResolveWezTermPathOpts {
  /**
   * Previously cached absolute path (e.g. from `~/.multi-cc-im/config.toml`'s
   * `wezterm.path`). Verified for executable existence first; if missing,
   * falls through to discovery.
   */
  cachedPath?: string;
  /**
   * Directories to scan as PATH (each appended `/wezterm`). Defaults to a
   * macOS-friendly list (Apple Silicon brew + Intel brew + system + user).
   */
  pathDirs?: string[];
  /**
   * Absolute paths of `.app` bundle binaries to try after PATH fails.
   * Defaults to `/Applications/WezTerm.app/...`.
   */
  bundleCandidates?: string[];
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
 * Resolve an absolute path to the `wezterm` binary per architecture.md.
 *
 * Order:
 *   1. `cachedPath` if given AND still executable (handles user uninstall)
 *   2. `pathDirs` scan (default: macOS PATH-equivalent dirs)
 *   3. `bundleCandidates` (default: `/Applications/WezTerm.app/...`)
 *   4. throw fail-fast with install hint
 *
 * Per CLAUDE.md "no hardcoded secrets / external CLI paths": no hardcoded
 * absolute path is baked into hooks / commands / fixtures. Caller (CLI /
 * bridge core) calls this once at startup, caches result.
 */
export async function resolveWezTermPath(
  opts: ResolveWezTermPathOpts = {},
): Promise<string> {
  if (opts.cachedPath && (await isExecutable(opts.cachedPath))) {
    return opts.cachedPath;
  }

  const pathDirs = opts.pathDirs ?? DEFAULT_PATH_DIRS;
  for (const dir of pathDirs) {
    const candidate = join(dir, 'wezterm');
    if (await isExecutable(candidate)) return candidate;
  }

  const bundles = opts.bundleCandidates ?? DEFAULT_BUNDLE_CANDIDATES;
  for (const candidate of bundles) {
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(
    'wezterm CLI not found. Install via: `brew install --cask wezterm`\n' +
      '  Or set WEZTERM_PATH env / wezterm.path in ~/.multi-cc-im/config.toml',
  );
}
