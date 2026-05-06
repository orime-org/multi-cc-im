import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCleanupCommand } from './cleanup.js';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('runCleanupCommand', () => {
  let root: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcim-cleanup-'));
    stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFiles(rel: Record<string, string>): Promise<void> {
    for (const [name, body] of Object.entries(rel)) {
      await writeFile(join(stateDir, name), body, 'utf-8');
    }
  }

  it('clean state dir → "already clean" + exit 0', async () => {
    const lines: string[] = [];
    const r = await runCleanupCommand({ root, log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('already clean'))).toBe(true);
  });

  it('paired SessionStart+SessionEnd → deletes both, summary reports 1 completed', async () => {
    await writeFiles({
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.SessionEnd`]: '',
    });
    const lines: string[] = [];
    const r = await runCleanupCommand({ root, log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(await readdir(stateDir)).toEqual([]);
    expect(lines.some((l) => l.includes('1 completed cc session'))).toBe(true);
  });

  it('--dry-run → preview, NO deletions', async () => {
    await writeFiles({
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.SessionEnd`]: '',
      [`${SID_A}.Stop.2026-05-06T16-20-00-000Z`]: '{}',
    });
    const lines: string[] = [];
    const r = await runCleanupCommand({
      root,
      dryRun: true,
      log: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    // Files still there
    const remaining = (await readdir(stateDir)).sort();
    expect(remaining).toEqual([
      `${SID_A}.SessionEnd`,
      `${SID_A}.SessionStart`,
      `${SID_A}.Stop.2026-05-06T16-20-00-000Z`,
    ]);
    // Output mentions dry-run + would-delete counts
    const joined = lines.join('\n');
    expect(joined).toContain('dry-run');
    expect(joined).toContain('would delete');
    expect(joined).toContain('1 completed cc session');
  });

  it('legacy + paired + orphan-stop combined → all cleaned in one shot', async () => {
    await writeFiles({
      // Paired session A
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.SessionEnd`]: '',
      // Lone session B with orphan stops (cc still alive but daemon was down)
      [`${SID_B}.SessionStart`]: '{}',
      [`${SID_B}.Stop.2026-05-06T16-25-00-000Z`]: '{}',
      // Legacy junk
      'current-session': 'old-sid',
      [`${SID_A}.cc-pid`]: '{}',
      [`${SID_B}.events.jsonl`]: '',
    });
    const lines: string[] = [];
    const r = await runCleanupCommand({ root, log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(await readdir(stateDir)).toEqual([`${SID_B}.SessionStart`]);
    const joined = lines.join('\n');
    expect(joined).toContain('1 completed cc session');
    expect(joined).toContain('1 orphan Stop');
    expect(joined).toContain('3 legacy file');
  });

  it('logs state dir path', async () => {
    const lines: string[] = [];
    await runCleanupCommand({ root, log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes(stateDir))).toBe(true);
  });

  it('state dir does not exist (root no state/) → no-op clean', async () => {
    await rm(stateDir, { recursive: true, force: true });
    const lines: string[] = [];
    const r = await runCleanupCommand({ root, log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('already clean'))).toBe(true);
  });
});
