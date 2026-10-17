import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import type { CLIHandler } from '@multi-cc-im/shared';
import { createCcCliAdapter } from './adapter.js';

// Capture the real chokidar watcher the adapter creates so the test can
// emit the same 'error' event chokidar emits when the OS refuses a watch
// (macOS FSEvents client limit → EMFILE, Linux inotify → ENOSPC).
const captured = vi.hoisted(() => ({ watcher: undefined as FSWatcher | undefined }));
vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      watch: (...args: Parameters<typeof actual.default.watch>) => {
        captured.watcher = actual.default.watch(...args);
        return captured.watcher;
      },
    },
  };
});

const noopHandler: CLIHandler = {
  async onPreToolUse() {},
  async onStop() {},
};

function emfileError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EMFILE: too many open files, watch'), {
    code: 'EMFILE',
    errno: -24,
    syscall: 'watch',
  });
}

describe('createCcCliAdapter — watcher errors', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-watcher-error-'));
    captured.watcher = undefined;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('passes a watcher error emitted after ready to onWatcherError', async () => {
    const onWatcherError = vi.fn();
    const adapter = createCcCliAdapter({ stateDir, onWatcherError });
    await adapter.start(noopHandler);

    const err = emfileError();
    expect(() => captured.watcher!.emit('error', err)).not.toThrow();
    expect(onWatcherError).toHaveBeenCalledTimes(1);
    expect(onWatcherError).toHaveBeenCalledWith(err);

    await adapter.stop();
  });
});
