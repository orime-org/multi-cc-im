import { describe, it, expect } from 'vitest';
import { formatStateWatcherError } from './watcher-error.js';

const STATE_DIR = '/Users/u/.multi-cc-im/state';

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('formatStateWatcherError', () => {
  it('macOS EMFILE: explains the exhausted watch limit and gives the fseventsd check command', () => {
    const msg = formatStateWatcherError(
      errnoError('EMFILE', 'EMFILE: too many open files, watch'),
      STATE_DIR,
      'darwin',
    );
    expect(msg).toContain(STATE_DIR);
    expect(msg).toContain('EMFILE: too many open files, watch');
    expect(msg).toContain('cc replies');
    expect(msg).toContain('file-watch resources');
    expect(msg).toContain(
      `/usr/bin/log show --last 5m --predicate 'process == "fseventsd"' | grep "too many clients"`,
    );
    expect(msg).toContain('multi-cc-im start');
    expect(msg).toContain('does not stop your Claude Code / Codex sessions or other development processes');
    expect(msg).toContain('file descriptors or file-watch resources');
    expect(msg).not.toContain('used up by other processes');
    expect(msg).not.toContain('inotify');
  });

  it('Linux ENOSPC: points at the inotify limits', () => {
    const msg = formatStateWatcherError(
      errnoError('ENOSPC', 'ENOSPC: System limit for number of file watchers reached'),
      STATE_DIR,
      'linux',
    );
    expect(msg).toContain('file-watch limit');
    expect(msg).toContain('fs.inotify.max_user_watches');
    expect(msg).not.toContain('fseventsd');
  });

  it('Linux EMFILE also points at per-process open-file limits', () => {
    const msg = formatStateWatcherError(errnoError('EMFILE', 'watch failed'), STATE_DIR, 'linux');
    expect(msg).toContain('ulimit -n');
    expect(msg).toContain('fs.inotify.max_user_instances');
    expect(msg).toContain('only processes you no longer need');
  });

  it('other error codes: shows the original error without the watch-limit advice', () => {
    const msg = formatStateWatcherError(
      errnoError('EACCES', 'EACCES: permission denied, watch'),
      STATE_DIR,
      'darwin',
    );
    expect(msg).toContain(STATE_DIR);
    expect(msg).toContain('EACCES: permission denied, watch');
    expect(msg).toContain('multi-cc-im start');
    expect(msg).not.toContain('file-watch limit');
  });

  it('non-Error values are stringified', () => {
    const msg = formatStateWatcherError('boom', STATE_DIR, 'darwin');
    expect(msg).toContain('boom');
  });
});
