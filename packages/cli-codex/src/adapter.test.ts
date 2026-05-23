import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CLIHandler,
  PaneId,
  PreToolUsePayload,
  SessionId,
  StopPayload,
} from '@multi-cc-im/shared';
import { writeStopFile } from '@multi-cc-im/cli-cc';
import { createCodexCliAdapter } from './adapter.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const PANE_ID = 77 as unknown as PaneId;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}

describe('createCodexCliAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-codex-adapter-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('exposes name="codex" (not "cc")', () => {
    const adapter = createCodexCliAdapter({ stateDir });
    expect(adapter.name).toBe('codex');
  });

  it('inherits start / stop lifecycle from cli-cc base', async () => {
    const adapter = createCodexCliAdapter({ stateDir });
    const handler: CLIHandler = {
      async onPreToolUse(_p: PreToolUsePayload) {},
      async onStop(_p: StopPayload) {},
    };
    await adapter.start(handler);
    await adapter.stop();
  });

  it('dispatches Stop files written by cli-cc state-file writers (filename protocol shared)', async () => {
    const adapter = createCodexCliAdapter({ stateDir });
    const events: StopPayload[] = [];
    const handler: CLIHandler = {
      async onPreToolUse() {},
      async onStop(p) {
        events.push(p);
      },
    };
    await adapter.start(handler);

    await writeStopFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      timestamp: '2026-05-22T08-00-00-000Z',
      last_assistant_message: 'codex-stop-payload',
      termId: 'wezterm',
    });

    await waitFor(() =>
      events.some((e) => e.last_assistant_message === 'codex-stop-payload'),
    );
    expect(events[0]?.session_id).toBe(SID);

    await adapter.stop();
  });

  it('enqueueInjection is inherited from cli-cc (file written to stateDir)', async () => {
    const adapter = createCodexCliAdapter({ stateDir });
    await adapter.start({
      async onPreToolUse() {},
      async onStop() {},
    });
    // The injection-queue writer is asserted in cli-cc's own tests; here
    // we only confirm the method is wired through and does not throw.
    await expect(
      adapter.enqueueInjection(SID as unknown as SessionId, 'wake-codex'),
    ).resolves.toBeUndefined();
    await adapter.stop();
  });

  it('passes through onHandlerError option from caller', async () => {
    const errors: unknown[] = [];
    const adapter = createCodexCliAdapter({
      stateDir,
      onHandlerError: (err) => errors.push(err),
    });
    await adapter.start({
      async onPreToolUse() {},
      async onStop() {
        throw new Error('codex-boom');
      },
    });

    await writeStopFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      timestamp: 'T1',
      last_assistant_message: 'x',
      termId: 'wezterm',
    });
    await waitFor(() => errors.length === 1);
    expect((errors[0] as Error).message).toBe('codex-boom');

    await adapter.stop();
  });
});
