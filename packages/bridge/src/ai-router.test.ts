import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeArgs,
  parseRoutingOutput,
  renderRoutingPrompt,
  routeViaAI,
} from './ai-router.js';

// ============================================================================
// renderRoutingPrompt — pure interpolation, no IO
// ============================================================================

describe('ai-router — renderRoutingPrompt', () => {
  it('interpolates tabs as bullet list', () => {
    const out = renderRoutingPrompt({
      userMsg: 'hi',
      tabs: ['frontend', 'api'],
      currentTab: null,
    });
    expect(out).toContain('  - frontend');
    expect(out).toContain('  - api');
  });

  it('shows currentTab when set', () => {
    const out = renderRoutingPrompt({
      userMsg: 'continue',
      tabs: ['frontend', 'api'],
      currentTab: 'api',
    });
    expect(out).toMatch(/current.*\n.*api/);
  });

  it('shows "none" when currentTab is null', () => {
    const out = renderRoutingPrompt({
      userMsg: 'hi',
      tabs: ['frontend'],
      currentTab: null,
    });
    expect(out).toMatch(/current.*\n.*none/);
  });

  it('zero tabs → "(无活的 tab)" placeholder (still emits prompt — caller filters first)', () => {
    const out = renderRoutingPrompt({
      userMsg: 'hi',
      tabs: [],
      currentTab: null,
    });
    expect(out).toContain('(无活的 tab)');
  });

  it('userMsg interpolated verbatim (not escaped — cc handles its own quoting)', () => {
    const out = renderRoutingPrompt({
      userMsg: 'hello "quoted" \\backslash',
      tabs: ['x'],
      currentTab: null,
    });
    expect(out).toContain('hello "quoted" \\backslash');
  });

  it('includes the JSON output spec', () => {
    const out = renderRoutingPrompt({
      userMsg: 'x',
      tabs: ['t'],
      currentTab: null,
    });
    expect(out).toContain('"target"');
    expect(out).toContain('"intent"');
    expect(out).toContain('"reason"');
  });

  it('does NOT mention cc slash commands (avoids polluting spawned cc)', () => {
    // Per DD #73 §6.3: prompt must not name `/rename` or any cc TUI slash
    // command — the spawned cc agent itself knows about those, and naming
    // them risks the agent treating the message as a cc command instead of
    // a triage task.
    const out = renderRoutingPrompt({
      userMsg: 'x',
      tabs: ['t'],
      currentTab: null,
    });
    expect(out).not.toMatch(/\/rename/);
    expect(out).not.toMatch(/slash command/i);
  });

  it('does NOT include cwd (per DD #73 — title is enough; cwd creates noise)', () => {
    const out = renderRoutingPrompt({
      userMsg: 'x',
      tabs: ['t'],
      currentTab: null,
    });
    expect(out).not.toMatch(/cwd/i);
  });
});

// ============================================================================
// buildClaudeArgs — flag layout
// ============================================================================

describe('ai-router — buildClaudeArgs', () => {
  it('puts --print first and prompt last', () => {
    const args = buildClaudeArgs({ model: 'haiku', prompt: 'hello' });
    expect(args[0]).toBe('--print');
    expect(args[args.length - 1]).toBe('hello');
  });

  it('includes --output-format json', () => {
    const args = buildClaudeArgs({ model: 'haiku', prompt: 'p' });
    const idx = args.indexOf('--output-format');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('json');
  });

  it('includes --permission-mode bypassPermissions', () => {
    const args = buildClaudeArgs({ model: 'haiku', prompt: 'p' });
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('bypassPermissions');
  });

  it('includes --disable-slash-commands', () => {
    const args = buildClaudeArgs({ model: 'haiku', prompt: 'p' });
    expect(args).toContain('--disable-slash-commands');
  });

  it('includes --setting-sources user', () => {
    const args = buildClaudeArgs({ model: 'haiku', prompt: 'p' });
    const idx = args.indexOf('--setting-sources');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('user');
  });

  it('passes --model with given model name', () => {
    const args = buildClaudeArgs({ model: 'claude-haiku-4-5', prompt: 'p' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('claude-haiku-4-5');
  });
});

// ============================================================================
// parseRoutingOutput — handles cc envelope shapes + LLM quirks
// ============================================================================

describe('ai-router — parseRoutingOutput', () => {
  function envelope(inner: string): string {
    return JSON.stringify({ result: inner, session_id: 's', usage: {} });
  }

  it('happy path — clean JSON inner', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"frontend","intent":"做登录页","reason":"前端"}'),
    );
    expect(out).toEqual({
      target: 'frontend',
      intent: '做登录页',
      reason: '前端',
    });
  });

  it('strips ```json ... ``` markdown fence', () => {
    const out = parseRoutingOutput(
      envelope('```json\n{"target":"api","intent":"x","reason":"r"}\n```'),
    );
    expect(out.target).toBe('api');
    expect(out.intent).toBe('x');
  });

  it('strips bare ``` ... ``` fence', () => {
    const out = parseRoutingOutput(
      envelope('```\n{"target":"api","intent":"x","reason":"r"}\n```'),
    );
    expect(out.target).toBe('api');
  });

  it('target=none → null', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"none","intent":null,"reason":"模糊"}'),
    );
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
    expect(out.reason).toBe('模糊');
  });

  it('target empty string → null', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"","intent":"x","reason":"r"}'),
    );
    expect(out.target).toBeNull();
  });

  it('intent missing → null', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"frontend","reason":"r"}'),
    );
    expect(out.target).toBe('frontend');
    expect(out.intent).toBeNull();
  });

  it('intent empty string → null', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"frontend","intent":"","reason":"r"}'),
    );
    expect(out.intent).toBeNull();
  });

  it('reason missing → null (not crash)', () => {
    const out = parseRoutingOutput(
      envelope('{"target":"frontend","intent":"x"}'),
    );
    expect(out.reason).toBeNull();
  });

  it('cc envelope not JSON → null result with diagnostic reason', () => {
    const out = parseRoutingOutput('this is not JSON');
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
    expect(out.reason).toMatch(/envelope/i);
  });

  it('cc envelope missing result key → null result', () => {
    const out = parseRoutingOutput(JSON.stringify({ session_id: 's' }));
    expect(out.target).toBeNull();
    expect(out.reason).toMatch(/result/i);
  });

  it('inner not JSON → null with diagnostic reason', () => {
    const out = parseRoutingOutput(envelope('not json at all'));
    expect(out.target).toBeNull();
    expect(out.reason).toMatch(/inner/i);
  });

  it('inner not object (e.g. just a string) → null', () => {
    const out = parseRoutingOutput(envelope('"just a string"'));
    expect(out.target).toBeNull();
  });

  it('non-string target field (e.g. number) → null', () => {
    const out = parseRoutingOutput(
      envelope('{"target":123,"intent":"x","reason":"r"}'),
    );
    expect(out.target).toBeNull();
  });
});

// ============================================================================
// routeViaAI — integration via stub binary script
// ============================================================================

describe('ai-router — routeViaAI integration (stub binary)', () => {
  function writeStub(stdout: string, exitCode = 0): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-stub-'));
    const path = join(dir, 'claude-stub');
    writeFileSync(
      path,
      `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`,
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
    return path;
  }

  it('happy path via stub — picks target', async () => {
    const stub = writeStub(
      JSON.stringify({
        result: '{"target":"frontend","intent":"hi","reason":"r"}',
      }),
    );
    const out = await routeViaAI({
      userMsg: 'hi frontend',
      tabs: ['frontend', 'api'],
      currentTab: null,
      claudeBinary: stub,
    });
    expect(out).toEqual({ target: 'frontend', intent: 'hi', reason: 'r' });
  });

  it('binary missing → null result with ENOENT reason', async () => {
    const out = await routeViaAI({
      userMsg: 'hi',
      tabs: ['x'],
      currentTab: null,
      claudeBinary: '/no/such/binary-aB3Xq',
    });
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
    expect(out.reason).toMatch(/PATH|enoent/i);
  });

  it('non-zero exit → null result (errors do NOT propagate)', async () => {
    const stub = writeStub('garbage stderr', 1);
    const out = await routeViaAI({
      userMsg: 'x',
      tabs: ['t'],
      currentTab: null,
      claudeBinary: stub,
    });
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
  });

  it('stub returns malformed JSON → null result (errors do NOT propagate)', async () => {
    const stub = writeStub('not json at all');
    const out = await routeViaAI({
      userMsg: 'x',
      tabs: ['t'],
      currentTab: null,
      claudeBinary: stub,
    });
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
  });
});
