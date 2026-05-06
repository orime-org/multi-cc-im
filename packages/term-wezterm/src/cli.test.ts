import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

const { runWezTermCli } = await import('./cli.js');

interface FakeChildOpts {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  spawnError?: Error;
  /** Delay (ms) before emitting exit/error. Default 0 (next tick). */
  delayMs?: number;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(opts: FakeChildOpts = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();

  setTimeout(() => {
    if (opts.spawnError) {
      child.emit('error', opts.spawnError);
      return;
    }
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('exit', opts.exitCode ?? 0, opts.signal ?? null);
  }, opts.delayMs ?? 0);

  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('runWezTermCli', () => {
  it('invokes spawn with the resolved binary + args and returns stdout', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: 'hello stdout' }));
    const out = await runWezTermCli({
      wezterm: '/opt/homebrew/bin/wezterm',
      args: ['cli', 'list'],
    });
    expect(out).toBe('hello stdout');
    expect(mockSpawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/wezterm',
      ['cli', 'list'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('forwards stdin and explicitly ends it (the macOS wezterm-hang fix)', async () => {
    const child = makeFakeChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);
    await runWezTermCli({
      wezterm: '/wt',
      args: ['cli', 'send-text', '--pane-id', '20'],
      stdin: 'hello world',
    });
    expect(child.stdin.write).toHaveBeenCalledWith('hello world');
    // CRITICAL: stdin must be explicitly half-closed. `execFile {input}` did
    // not do this reliably on macOS, causing wezterm send-text to hang
    // forever waiting for EOF.
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('still ends stdin even when no stdin payload was provided', async () => {
    const child = makeFakeChild({ stdout: 'list output' });
    mockSpawn.mockReturnValue(child);
    await runWezTermCli({ wezterm: '/wt', args: ['cli', 'list'] });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('rejects with code + signal + stderr context when child exits nonzero', async () => {
    mockSpawn.mockReturnValue(
      makeFakeChild({ exitCode: 1, stderr: 'pane-id 99: not found\n' }),
    );
    await expect(
      runWezTermCli({ wezterm: '/wt', args: ['cli', 'send-text'] }),
    ).rejects.toThrow(/wezterm cli failed.*code=1.*pane-id 99: not found/);
  });

  it('rejects on spawn error (binary missing etc.)', async () => {
    mockSpawn.mockReturnValue(
      makeFakeChild({ spawnError: new Error('ENOENT') }),
    );
    await expect(
      runWezTermCli({ wezterm: '/nope', args: ['cli', 'list'] }),
    ).rejects.toThrow(/wezterm cli failed to spawn.*ENOENT/);
  });

  it('does NOT use shell interpretation (passes args as array, no string)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: 'ok' }));
    await runWezTermCli({
      wezterm: '/wt',
      args: ['cli', 'send-text', '$(rm -rf /)'],
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      '/wt',
      ['cli', 'send-text', '$(rm -rf /)'],
      expect.any(Object),
    );
  });

  it('kills child + rejects on timeout', async () => {
    // Child never emits exit. Timer fires + kills.
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child);

    await expect(
      runWezTermCli({ wezterm: '/wt', args: ['cli', 'list'], timeoutMs: 30 }),
    ).rejects.toThrow(/timed out after 30ms/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('does not double-settle if exit and timeout race', async () => {
    // Slow child: exit fires after timeout. We should reject with timeout
    // error and NOT also try to resolve/reject from the late exit handler.
    const child = makeFakeChild({ exitCode: 0, stdout: 'late', delayMs: 50 });
    mockSpawn.mockReturnValue(child);

    await expect(
      runWezTermCli({ wezterm: '/wt', args: ['cli', 'list'], timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
    // Wait for late exit to fire — should be ignored without throwing.
    await new Promise((r) => setTimeout(r, 60));
    // If double-settle had happened, vitest would surface "PromiseAlreadyResolved" or similar.
  });
});
