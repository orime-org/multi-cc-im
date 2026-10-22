import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { CLIHandler } from '@multi-cc-im/shared';
import { createCcCliAdapter } from './adapter.js';

// Drive error/ready ordering without consuming the OS resource under test.
vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));

class TestWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}

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
  const stateDir = '/test/state';
  let watcher: TestWatcher;

  beforeEach(() => {
    watcher = new TestWatcher();
    vi.mocked(chokidar.watch).mockReset();
    vi.mocked(chokidar.watch).mockReturnValue(watcher as unknown as FSWatcher);
  });

  it('passes a watcher error emitted after ready to onWatcherError', async () => {
    const onWatcherError = vi.fn();
    const adapter = createCcCliAdapter({ stateDir, onWatcherError });
    const starting = adapter.start(noopHandler);
    watcher.emit('ready');
    await starting;

    const err = emfileError();
    expect(() => watcher.emit('error', err)).not.toThrow();
    expect(onWatcherError).toHaveBeenCalledTimes(1);
    expect(onWatcherError).toHaveBeenCalledWith(err);

    await adapter.stop();
  });

  it('reports a synchronous watch failure to the caller', async () => {
    const err = emfileError();
    vi.mocked(chokidar.watch).mockImplementationOnce(() => { throw err; });
    const onWatcherError = vi.fn();
    const adapter = createCcCliAdapter({ stateDir, onWatcherError });
    await expect(adapter.start(noopHandler)).rejects.toBe(err);
    expect(onWatcherError).toHaveBeenCalledOnce();
    expect(onWatcherError).toHaveBeenCalledWith(err);
    await adapter.stop();
  });

  it('rejects startup and closes the watcher when an error precedes ready', async () => {
    const onWatcherError = vi.fn();
    const adapter = createCcCliAdapter({ stateDir, onWatcherError });
    const err = emfileError();
    const starting = adapter.start(noopHandler);
    const rejected = expect(starting).rejects.toBe(err);
    watcher.emit('error', err);
    await rejected;
    expect(onWatcherError).toHaveBeenCalledOnce();
    expect(onWatcherError).toHaveBeenCalledWith(err);
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(watcher.listenerCount('ready')).toBe(0);
    await adapter.stop();
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it('rejects a startup error without an optional runtime error callback', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const err = emfileError();
    const starting = adapter.start(noopHandler);
    const rejected = expect(starting).rejects.toBe(err);
    expect(() => watcher.emit('error', err)).not.toThrow();
    await rejected;
    expect(watcher.close).toHaveBeenCalledOnce();
    await adapter.stop();
  });
});
