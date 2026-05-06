import { open, mkdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write `content` to `path`. Strategy: write to a temp file in
 * the same directory, fsync, then rename over the target.
 *
 * Same approach as cc-connect's `core/atomicwrite.go` (6573 stars, battle-tested).
 *
 * - Tmp in same directory ensures rename is atomic on the underlying fs
 * - fsync ensures the bytes are durable before rename publishes them
 * - On error, tmp is unlinked; the target is never partially overwritten
 * - Mode 0o600 keeps secrets in `state/cursor.txt` etc. user-private
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmpName = `.tmp-${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  let fh: FileHandle | undefined;
  try {
    fh = await open(tmpPath, 'wx', 0o600);
    await fh.writeFile(content);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmpPath, path);
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
