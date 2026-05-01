/**
 * Shim for `openclaw/plugin-sdk/infra-runtime` —— 仅实现 vendored ilink 协议层
 * 真正调用的两个 API: `resolvePreferredOpenClawTmpDir` + `withFileLock`。
 *
 * 设计来源: upstream `package/dist/account-id-CRE2SEcy.js` /
 * `tmp-openclaw-dir-CraDYfRT.js` / `file-lock-CCdyykP_.js` 行为参考；
 * 不引入 OpenClaw plugin framework 全部依赖（80MB / 36 deps），仅满足 vendored
 * code 实际访问的 API surface。
 */

import lockfile from 'proper-lockfile';
import { mkdirSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Upstream 默认 tmp 目录路径常量。 */
const POSIX_OPENCLAW_TMP_DIR = '/tmp/openclaw';

let tmpDirInitialized = false;

/**
 * 返回 OpenClaw 风格 tmp 目录路径。Multi-cc-im 单用户场景，简化为
 * `/tmp/openclaw` + 首次调用时确保存在 (mode 0700)。
 *
 * 上游源码（`package/dist/tmp-openclaw-dir-*.js`）含安全检查（uid match /
 * world-writable detection），对单用户 multi-cc-im 不必要。
 */
export function resolvePreferredOpenClawTmpDir(): string {
  if (!tmpDirInitialized) {
    try {
      mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
    } catch {
      // 已存在 / 权限错误 → 让下游 fs 操作报告具体错误
    }
    tmpDirInitialized = true;
  }
  return POSIX_OPENCLAW_TMP_DIR;
}

/**
 * Options 对应上游 `withFileLock` 第 2 参数 —— 直接匹配 proper-lockfile 的
 * options 形态（上游 vendored 代码也用这个 shape，例如 auth/pairing.ts 的
 * `LOCK_OPTIONS = { retries: { retries: 3, factor: 2, minTimeout: 100, ... }, stale: 10_000 }`）。
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
 * 文件锁包装器。语义匹配上游 `withFileLock(filePath, options, fn)`：
 * 拿锁 → 跑 fn → finally 释锁。底层用 `proper-lockfile`（业界标准 file lock 库）。
 *
 * 跟上游差异：
 * - 上游用自家 `acquireFileLock` impl；我们 delegate 到 proper-lockfile
 * - 上游对 staleMs 有更复杂的检测；proper-lockfile 内置 stale 检测，行为等价
 *
 * Vendored auth/pairing.ts 在文件可能不存在时调用此函数，我们先 touch 文件
 * （proper-lockfile 要求 path 存在）。
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
