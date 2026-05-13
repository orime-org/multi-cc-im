import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneId } from '@multi-cc-im/shared';
import { createITerm2Adapter } from './adapter.js';

/**
 * adapter tests drive the public `TermAdapter & TermListPanes` surface
 * by pointing the adapter at a stub shell script standing in for both
 * `python3` and `iterm2-helper.py`. The stub reads its request JSON
 * from stdin and emits canned action-specific responses, letting us
 * exercise listPanes / sendText / sendKeystroke against the real
 * `runIterM2Helper` plumbing without iTerm2 itself.
 *
 * The tab-title cleanup tests live in `tab-title.test.ts`; the bridge
 * protocol tests live in `python-bridge.test.ts`. This file just
 * covers the integration seam (request shape, return-value mapping,
 * input validation).
 */

describe('createITerm2Adapter', () => {
  let tmpDir: string;
  let stub: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'it2-adapter-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeStub(body: string): Promise<string> {
    const path = join(tmpDir, `stub-${Date.now()}-${Math.random()}.sh`);
    await writeFile(path, `#!/bin/bash\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  function adapterFor(stubPath: string) {
    return createITerm2Adapter({
      python: { path: '/bin/sh' },
      helperScript: { path: stubPath },
    });
  }

  it('name is "iterm2"', () => {
    const adapter = adapterFor('/dev/null');
    expect(adapter.name).toBe('iterm2');
  });

  it('listPanes maps helper rows through cleanTitle + cleanCwd', async () => {
    // Raw helper output mixes a clean title, a cc-emoji-prefixed title,
    // and a default-cc title that should coalesce to empty.
    stub = await writeStub(
      `cat > /dev/null; echo '{"ok":true,"result":[` +
        `{"paneId":"UUID-1","title":"frontend","cwd":"/tmp/a"},` +
        `{"paneId":"UUID-2","title":"✳ backend","cwd":"  /tmp/b  "},` +
        `{"paneId":"UUID-3","title":"Claude Code","cwd":"/tmp/c"}` +
        `]}'`,
    );
    const adapter = adapterFor(stub);
    const panes = await adapter.listPanes();
    expect(panes).toEqual([
      { paneId: 'UUID-1', title: 'frontend', cwd: '/tmp/a' },
      { paneId: 'UUID-2', title: 'backend', cwd: '/tmp/b' },
      { paneId: 'UUID-3', title: '', cwd: '/tmp/c' },
    ]);
  });

  it('listPanes returns empty array when iterm2 reports no windows', async () => {
    stub = await writeStub(`cat > /dev/null; echo '{"ok":true,"result":[]}'`);
    const adapter = adapterFor(stub);
    const panes = await adapter.listPanes();
    expect(panes).toEqual([]);
  });

  it('listPanes throws when helper returns non-array result', async () => {
    // Indicates protocol misuse / wrong action wired — we want a clear
    // throw rather than silently returning {sent:N}.
    stub = await writeStub(
      `cat > /dev/null; echo '{"ok":true,"result":{"sent":5}}'`,
    );
    const adapter = adapterFor(stub);
    await expect(adapter.listPanes()).rejects.toThrow(/non-array result/);
  });

  it('sendText resolves when helper returns ok:true', async () => {
    stub = await writeStub(
      `cat > /dev/null; echo '{"ok":true,"result":{"sent":5}}'`,
    );
    const adapter = adapterFor(stub);
    await expect(
      adapter.sendText('UUID' as unknown as PaneId, 'hello'),
    ).resolves.toBeUndefined();
  });

  it('sendText propagates helper error', async () => {
    stub = await writeStub(
      `cat > /dev/null; echo '{"ok":false,"error":"no session"}'`,
    );
    const adapter = adapterFor(stub);
    await expect(
      adapter.sendText('UUID' as unknown as PaneId, 'hello'),
    ).rejects.toThrow(/no session/);
  });

  it('sendKeystroke resolves when helper returns ok:true', async () => {
    stub = await writeStub(
      `cat > /dev/null; echo '{"ok":true,"result":{"sent":1}}'`,
    );
    const adapter = adapterFor(stub);
    await expect(
      adapter.sendKeystroke('UUID' as unknown as PaneId, '\r'),
    ).resolves.toBeUndefined();
  });

  it('sendKeystroke rejects empty key (caller bug guard)', async () => {
    const adapter = adapterFor('/dev/null');
    await expect(
      adapter.sendKeystroke('UUID' as unknown as PaneId, ''),
    ).rejects.toThrow(/must not be empty/);
  });

  it('start + stop are no-ops in v1 (no persistent connection)', async () => {
    const adapter = adapterFor('/dev/null');
    await expect(adapter.start({})).resolves.toBeUndefined();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});
