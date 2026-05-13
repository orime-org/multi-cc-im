import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIterM2Helper } from './python-bridge.js';

/**
 * python-bridge invokes a `python3` subprocess. To exercise it without
 * the real iTerm2 PyPI package or a live iTerm2 instance, we point the
 * `python.path` and `helperScript.path` at a stub shell script that
 * reads JSON from stdin and emits a canned response on stdout. The
 * bridge doesn't know it's not running real Python — it only requires
 * an executable that conforms to the request/response contract.
 *
 * This isolates protocol concerns (request serialization, response
 * parsing, error surfacing, timeout, stdin closure) from the actual
 * iTerm2 integration (which lives in the helper script and is best
 * smoke-tested against a real iTerm2 in P7).
 */

describe('runIterM2Helper (stubbed Python)', () => {
  let tmpDir: string;
  let stubPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'it2-bridge-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeStub(behavior: string): Promise<string> {
    const path = join(tmpDir, `stub-${Date.now()}-${Math.random()}.sh`);
    await writeFile(path, `#!/bin/bash\n${behavior}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('returns parsed result on ok:true response', async () => {
    stubPath = await writeStub(
      `echo '{"ok":true,"result":[{"paneId":"UUID-A","title":"x","cwd":"/tmp"}]}'`,
    );
    const result = await runIterM2Helper({
      python: { path: '/bin/sh' },
      helperScript: { path: stubPath },
      request: { action: 'listSessions' },
    });
    expect(result).toEqual([{ paneId: 'UUID-A', title: 'x', cwd: '/tmp' }]);
  });

  it('throws with helper error message on ok:false response', async () => {
    stubPath = await writeStub(
      `echo '{"ok":false,"error":"iterm2 package not installed"}'`,
    );
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/iterm2 package not installed/);
  });

  it('throws on non-zero exit with non-JSON stderr', async () => {
    stubPath = await writeStub(`echo 'fatal: explode' >&2; exit 1`);
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/exited 1/);
  });

  it('surfaces helper failure JSON when subprocess exits non-zero', async () => {
    // The Python helper emits {ok:false,error:...} on stdout AND exits 1.
    // We should prefer the helper's error string over the generic "exited 1".
    stubPath = await writeStub(
      `echo '{"ok":false,"error":"specific helper message"}'; exit 1`,
    );
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/specific helper message/);
  });

  it('throws on unparseable stdout', async () => {
    stubPath = await writeStub(`echo 'not json at all'`);
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws on wrong-shape response (missing ok)', async () => {
    stubPath = await writeStub(`echo '{"random":"junk"}'`);
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/wrong shape/);
  });

  it('writes the request JSON to stdin (proven via roundtrip file)', async () => {
    // Stub captures stdin to a tmp file and emits a fixed success response.
    // Reading the file confirms the bridge delivered our JSON verbatim.
    const sinkPath = join(tmpDir, `stdin-sink-${Date.now()}`);
    stubPath = await writeStub(
      `cat > "${sinkPath}"; echo '{"ok":true,"result":{"sent":2}}'`,
    );
    await runIterM2Helper({
      python: { path: '/bin/sh' },
      helperScript: { path: stubPath },
      request: { action: 'sendText', sessionId: 'U', text: 'hi' },
    });
    const captured = await import('node:fs/promises').then((fs) =>
      fs.readFile(sinkPath, 'utf8'),
    );
    expect(JSON.parse(captured)).toEqual({
      action: 'sendText',
      sessionId: 'U',
      text: 'hi',
    });
  });

  it('kills the subprocess on timeout and throws a timeout error', async () => {
    // `exec sleep` replaces the shell with sleep so SIGKILL hits sleep
    // directly; without exec, SIGKILL goes to bash but bash's child
    // sleep can linger and delay the close event past vitest's 5s test
    // timeout.
    stubPath = await writeStub(`exec sleep 10`);
    await expect(
      runIterM2Helper({
        python: { path: '/bin/sh' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('throws spawn error for non-existent python binary', async () => {
    await expect(
      runIterM2Helper({
        python: { path: '/nonexistent/python3' },
        helperScript: { path: stubPath },
        request: { action: 'listSessions' },
      }),
    ).rejects.toThrow(/spawn failed/);
  });
});
