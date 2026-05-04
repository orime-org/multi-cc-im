import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const { runWezTermCli } = await import('./cli.js');

beforeEach(() => {
  mockExecFile.mockReset();
});

function mockExecFileSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: object,
      cb: (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      cb(null, stdout, '');
    },
  );
}

function mockExecFileFailure(message: string, stderr = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: object,
      cb: (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      cb(new Error(message), '', stderr);
    },
  );
}

describe('runWezTermCli', () => {
  it('invokes execFile with the resolved binary + args and returns stdout', async () => {
    mockExecFileSuccess('hello stdout');
    const out = await runWezTermCli({
      wezterm: '/opt/homebrew/bin/wezterm',
      args: ['cli', 'list'],
    });
    expect(out).toBe('hello stdout');
    expect(mockExecFile).toHaveBeenCalledWith(
      '/opt/homebrew/bin/wezterm',
      ['cli', 'list'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('forwards stdin when provided (for paste content)', async () => {
    mockExecFileSuccess('');
    let stdinPayload: string | undefined;
    mockExecFile.mockImplementation(
      (_cmd, _args, opts, cb) => {
        stdinPayload = (opts as { input?: string }).input;
        cb(null, '', '');
      },
    );
    await runWezTermCli({
      wezterm: '/wt',
      args: ['cli', 'send-text', '--pane-id', '20'],
      stdin: 'hello world',
    });
    expect(stdinPayload).toBe('hello world');
  });

  it('rejects with stderr context when execFile fails', async () => {
    mockExecFileFailure('Command failed', 'pane-id 99: not found\n');
    await expect(
      runWezTermCli({ wezterm: '/wt', args: ['cli', 'send-text'] }),
    ).rejects.toThrow(/wezterm cli failed.*pane-id 99/);
  });

  it('does NOT use shell interpretation (passes args as array, no string)', async () => {
    mockExecFileSuccess('ok');
    await runWezTermCli({
      wezterm: '/wt',
      args: ['cli', 'send-text', '$(rm -rf /)'],
    });
    // Args stay as array — execFile semantics, no shell.
    expect(mockExecFile).toHaveBeenCalledWith(
      '/wt',
      ['cli', 'send-text', '$(rm -rf /)'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('respects timeoutMs (default 10s, opts.timeoutMs override)', async () => {
    mockExecFileSuccess('ok');
    let capturedOpts: { timeout?: number } | undefined;
    mockExecFile.mockImplementation((_cmd, _args, opts, cb) => {
      capturedOpts = opts as { timeout?: number };
      cb(null, 'ok', '');
    });
    await runWezTermCli({ wezterm: '/wt', args: ['cli', 'list'] });
    expect(capturedOpts?.timeout).toBe(10_000);
    await runWezTermCli({
      wezterm: '/wt',
      args: ['cli', 'list'],
      timeoutMs: 5_000,
    });
    expect(capturedOpts?.timeout).toBe(5_000);
  });
});
