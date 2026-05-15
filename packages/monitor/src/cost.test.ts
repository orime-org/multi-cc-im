import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSessionCost, findRecentSessions } from './cost.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monitor-cost-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeJsonlLine(opts: {
  role?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: opts.role ?? 'assistant',
      model: opts.model,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  });
}

describe('computeSessionCost', () => {
  it('missing file → zero entry, no throw', async () => {
    const got = await computeSessionCost(join(dir, 'nope.jsonl'));
    expect(got.inputTokens).toBe(0);
    expect(got.outputTokens).toBe(0);
    expect(got.model).toBeNull();
    expect(got.usdEstimate).toBe(0);
  });

  it('aggregates all usage blocks (NOT just last)', async () => {
    const path = join(dir, 'aaa-bbb.jsonl');
    await writeFile(path, [
      makeJsonlLine({ input: 100, output: 200, model: 'claude-sonnet-4-6' }),
      makeJsonlLine({ input: 50, output: 100, cacheRead: 1000, model: 'claude-sonnet-4-6' }),
    ].join('\n') + '\n');
    const got = await computeSessionCost(path);
    expect(got.inputTokens).toBe(150);
    expect(got.outputTokens).toBe(300);
    expect(got.cacheReadInputTokens).toBe(1000);
    expect(got.model).toBe('claude-sonnet-4-6');
    expect(got.usdEstimate).toBeGreaterThan(0);
  });

  it('skips malformed lines silently', async () => {
    const path = join(dir, 'corrupt.jsonl');
    await writeFile(path, [
      makeJsonlLine({ input: 100, output: 100, model: 'claude-opus-4-7' }),
      '{not valid json',
      '',
      '{"type": "user"}',  // valid JSON but no message.usage
      makeJsonlLine({ input: 50, output: 50, model: 'claude-opus-4-7' }),
    ].join('\n') + '\n');
    const got = await computeSessionCost(path);
    expect(got.inputTokens).toBe(150);
    expect(got.outputTokens).toBe(150);
  });

  it('extracts sessionId from filename (strip .jsonl)', async () => {
    const path = join(dir, 'abc-1234.jsonl');
    await writeFile(path, '');
    const got = await computeSessionCost(path);
    expect(got.sessionId).toBe('abc-1234');
  });

  it('unknown model → usdEstimate=0 but tokens still counted', async () => {
    const path = join(dir, 'unknown.jsonl');
    await writeFile(path, makeJsonlLine({
      input: 100, output: 100, model: 'gpt-5-turbo',
    }));
    const got = await computeSessionCost(path);
    expect(got.inputTokens).toBe(100);
    expect(got.outputTokens).toBe(100);
    expect(got.model).toBe('gpt-5-turbo');
    expect(got.usdEstimate).toBe(0);
  });

  it('empty file → zero entry', async () => {
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '');
    const got = await computeSessionCost(path);
    expect(got.inputTokens).toBe(0);
    expect(got.usdEstimate).toBe(0);
  });
});

describe('findRecentSessions', () => {
  it('missing root → []', async () => {
    const got = await findRecentSessions(join(dir, 'nope'));
    expect(got).toEqual([]);
  });

  it('returns jsonl paths sorted by mtime (newest first), respects limit', async () => {
    const root = join(dir, 'projects');
    await mkdir(join(root, 'proj-a'), { recursive: true });
    await mkdir(join(root, 'proj-b'), { recursive: true });
    const oldPath = join(root, 'proj-a', 'old.jsonl');
    const newPath = join(root, 'proj-b', 'new.jsonl');
    const newerPath = join(root, 'proj-b', 'newest.jsonl');
    await writeFile(oldPath, '');
    await writeFile(newPath, '');
    await writeFile(newerPath, '');
    // Push old's mtime back so order is deterministic across fs jitter.
    await utimes(oldPath, new Date('2026-01-01'), new Date('2026-01-01'));
    await utimes(newPath, new Date('2026-04-01'), new Date('2026-04-01'));
    await utimes(newerPath, new Date('2026-05-01'), new Date('2026-05-01'));

    const got = await findRecentSessions(root);
    expect(got).toEqual([newerPath, newPath, oldPath]);
  });

  it('limit caps result size', async () => {
    const root = join(dir, 'projects');
    await mkdir(join(root, 'p'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, 'p', `s${i}.jsonl`), '');
    }
    const got = await findRecentSessions(root, 2);
    expect(got).toHaveLength(2);
  });

  it('ignores non-jsonl files', async () => {
    const root = join(dir, 'projects');
    await mkdir(join(root, 'p'), { recursive: true });
    await writeFile(join(root, 'p', 's1.jsonl'), '');
    await writeFile(join(root, 'p', 'README.md'), 'irrelevant');
    const got = await findRecentSessions(root);
    expect(got).toHaveLength(1);
    expect(got[0]!.endsWith('.jsonl')).toBe(true);
  });
});
