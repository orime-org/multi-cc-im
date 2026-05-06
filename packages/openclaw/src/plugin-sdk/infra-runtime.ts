/**
 * Shim for `openclaw/plugin-sdk/infra-runtime` — implements only the two APIs
 * actually called by the vendored ilink protocol layer:
 * `resolvePreferredOpenClawTmpDir` + `withFileLock`.
 *
 * Design reference: upstream `package/dist/account-id-CRE2SEcy.js` /
 * `tmp-openclaw-dir-CraDYfRT.js` / `file-lock-CCdyykP_.js` for behavior. We
 * deliberately avoid pulling in the full OpenClaw plugin framework dependency
 * tree (80MB / 36 deps) and only cover the API surface the vendored code
 * actually accesses.
 */

import lockfile from 'proper-lockfile';
import { mkdirSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Upstream's default tmp directory path constant. */
const POSIX_OPENCLAW_TMP_DIR = '/tmp/openclaw';

let tmpDirInitialized = false;

/**
 * Returns the OpenClaw-style tmp directory path. For multi-cc-im's
 * single-user scenario, this simplifies down to `/tmp/openclaw` plus a
 * first-call check that ensures it exists (mode 0700).
 *
 * The upstream source (`package/dist/tmp-openclaw-dir-*.js`) includes
 * additional safety checks (uid match / world-writable detection) which are
 * unnecessary for single-user multi-cc-im.
 */
export function resolvePreferredOpenClawTmpDir(): string {
  if (!tmpDirInitialized) {
    try {
      mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
    } catch {
      // Already exists / permission error → let downstream fs operations report the specific error.
    }
    tmpDirInitialized = true;
  }
  return POSIX_OPENCLAW_TMP_DIR;
}

/**
 * Options corresponding to the upstream `withFileLock` second argument —
 * matches the proper-lockfile options shape directly (the upstream vendored
 * code uses this same shape, e.g. auth/pairing.ts's
 * `LOCK_OPTIONS = { retries: { retries: 3, factor: 2, minTimeout: 100, ... }, stale: 10_000 }`).
 */
export interface FileLockOptions {
  retries?:
    | number
    | {
        retries?: number;
        factor?: number;
        minTimeout?: number;
        maxTimeout?: number;
      };
  stale?: number;
}

/**
 * File lock wrapper. Semantics match the upstream
 * `withFileLock(filePath, options, fn)`: acquire lock → run fn → release in
 * finally. Backed by `proper-lockfile` (the de-facto standard file-lock
 * library).
 *
 * Differences from upstream:
 * - Upstream uses its own `acquireFileLock` impl; we delegate to
 *   proper-lockfile.
 * - Upstream has more elaborate staleMs detection; proper-lockfile's
 *   built-in stale detection is behaviorally equivalent.
 *
 * The vendored auth/pairing.ts may call this function before the file
 * exists, so we touch the file first (proper-lockfile requires the path to
 * exist).
 */
export async function withFileLock<T>(
  filePath: string,
  options: FileLockOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  const fh = await open(filePath, 'a', 0o600);
  await fh.close();

  const release = await lockfile.lock(filePath, {
    retries: options?.retries ?? { retries: 50, minTimeout: 100 },
    stale: options?.stale ?? 30_000,
    realpath: false,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
