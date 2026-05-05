import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface AppPaths {
  /** Root dir, default `~/.multi-cc-im/`. */
  root: string;
  /** `<root>/config.toml` — user config (TOML, ConfigStore). */
  configToml: string;
  /**
   * `<root>/state/` — cli-cc state files (`<sid>.cc-pid`, `<sid>.ended`,
   * `<sid>.last-hook-at`, `<sid>.events.jsonl`, `<sid>.injection-queue.jsonl`)
   * + bridge persistent-state (`current-session`).
   */
  stateDir: string;
  /** `<root>/credentials/` — per-IM 0600 JSON files (CLAUDE.md「凭据 0600 落盘」). */
  credentialsDir: string;
  /** `<root>/inbound/` — per-IM decrypted inbound media. */
  inboundDir: string;
  /** Path to `<credentialsDir>/<im>.json`. */
  credentialFor(im: string): string;
  /** Path to `<inboundDir>/<im>/`. */
  inboundFor(im: string): string;
}

export interface ResolveAppPathsOpts {
  /**
   * User home dir. Defaults to `os.homedir()`. Tests inject a sandbox path.
   */
  home?: string;
  /**
   * Environment vars (typically `process.env`). Tests inject a fixture.
   * Recognized keys: `MULTI_CC_IM_HOME` — absolute override of root dir.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve standard multi-cc-im directory layout. Defaults to `~/.multi-cc-im/`
 * with `state/`, `credentials/`, `inbound/` subdirectories per CLAUDE.md
 * data-storage convention. `MULTI_CC_IM_HOME` env overrides the root for
 * sandboxed dev / testing.
 */
export function resolveAppPaths(opts: ResolveAppPathsOpts = {}): AppPaths {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  let root: string;
  const override = env.MULTI_CC_IM_HOME;
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      throw new Error(
        `MULTI_CC_IM_HOME must be an absolute path, got: ${override}`,
      );
    }
    root = override;
  } else {
    root = join(home, '.multi-cc-im');
  }

  const stateDir = join(root, 'state');
  const credentialsDir = join(root, 'credentials');
  const inboundDir = join(root, 'inbound');

  return {
    root,
    configToml: join(root, 'config.toml'),
    stateDir,
    credentialsDir,
    inboundDir,
    credentialFor: (im) => join(credentialsDir, `${im}.json`),
    inboundFor: (im) => join(inboundDir, im),
  };
}
