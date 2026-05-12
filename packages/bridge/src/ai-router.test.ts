import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeArgs,
  explainExecError,
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

  it('zero tabs → "(no active tabs)" placeholder (still emits prompt — caller filters first)', () => {
    const out = renderRoutingPrompt({
      userMsg: 'hi',
      tabs: [],
      currentTab: null,
    });
    expect(out).toContain('(no active tabs)');
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

  it('routing rules tell the model to be LENIENT on tab-name matching (case / whitespace / hyphens / voice-typo)', async () => {
    // Real-account smoke 2026-05-11: user said "跟multi-ccCRM说..." (voice
    // input transcribed "IM" as "CRM") and "就是跟 multi-cc-IM说..." (case
    // + whitespace variant), both got "❌ 无法识别目标" because the old
    // prompt let the model fall back to "none" on any deviation. The fix
    // teaches the model to tolerate these variants explicitly.
    const out = renderRoutingPrompt({
      userMsg: '跟multi-ccCRM说，那个测试没过',
      tabs: ['multi-cc-im'],
      currentTab: null,
    });
    // Each guidance dimension covered (English prompt per user smoke
    // 2026-05-11 — LLMs handle structured rules better in English):
    expect(out).toMatch(/case[-\s]insensitive/i);
    expect(out).toMatch(/whitespace|hyphens|underscores/);
    expect(out).toMatch(/speech[-\s]to[-\s]text/i);
    // And explicit guidance NOT to bail out on minor variants.
    expect(out).toMatch(/do not bail|do not fall back|defaulting to "none" is a routing failure/i);
  });

  it('topic-mention coverage: prompt teaches the model that tab name appearing as TOPIC also counts as a route signal', async () => {
    // Real-account smoke 2026-05-11: user sent "是那个multi-cc-im 已经合并"
    // — the message's subject is "multi-cc-im" (topic word, not a routing
    // cue word), and the user has a tab named "multi-cc-im". The prompt
    // now makes topic-as-route explicit with inline examples in both
    // English and Chinese.
    const out = renderRoutingPrompt({
      userMsg: '是那个multi-cc-im 已经合并',
      tabs: ['multi-cc-im', 'node'],
      currentTab: null,
    });
    // Topic vs route distinction called out explicitly:
    expect(out).toMatch(/topic|subject/i);
    expect(out).toMatch(/route word|routing cue/i);
    // Inline example specifically for the user's reported case (Chinese
    // example preserved alongside English so the model sees a concrete
    // CN input → CN tab match):
    expect(out).toContain('multi-cc-im 已经合并');
  });

  it('intent language constraint: prompt instructs intent be in the same language as the user message', async () => {
    // Real-account smoke 2026-05-11: AI was occasionally translating
    // Chinese user messages to English in the `intent` field, forcing cc
    // to mentally translate back. New prompt rule explicitly forbids
    // language switching.
    const out = renderRoutingPrompt({
      userMsg: '给前端写个登录页',
      tabs: ['frontend', 'backend'],
      currentTab: null,
    });
    // Rule visible in CRITICAL block:
    expect(out).toMatch(/same language/i);
    // Each direction covered:
    expect(out).toMatch(/Chinese.*Chinese/);
    expect(out).toMatch(/English.*English/);
    expect(out).toMatch(/Mixed/);
    // Output spec field annotation:
    expect(out).toMatch(/intent.*user's source language/);
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

  // P2 — natural-language permission reply (DD 2026-05-11)
  describe('pendingRequests integration', () => {
    it('omits the PENDING block when pendingRequests is undefined (backward compat)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'hi',
        tabs: ['frontend'],
        currentTab: null,
      });
      expect(out).not.toMatch(/PENDING TOOL PERMISSION/i);
      expect(out).not.toMatch(/permissionResponse/);
    });

    it('omits the PENDING block when pendingRequests is empty', () => {
      const out = renderRoutingPrompt({
        userMsg: 'hi',
        tabs: ['frontend'],
        currentTab: null,
        pendingRequests: [],
      });
      expect(out).not.toMatch(/PENDING TOOL PERMISSION/i);
      expect(out).not.toMatch(/permissionResponse/);
    });

    it('renders one pending request with tab name + tool + input keys', () => {
      const out = renderRoutingPrompt({
        userMsg: 'multi-cc-im 那个我同意',
        tabs: ['multi-cc-im', 'node'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf node_modules' },
          },
        ],
      });
      expect(out).toMatch(/PENDING TOOL PERMISSION/i);
      // Tab name + tool name + key input fragment all visible:
      expect(out).toContain('multi-cc-im');
      expect(out).toContain('Bash');
      expect(out).toContain('rm -rf node_modules');
    });

    it('renders multiple pending requests as separate bullets', () => {
      const out = renderRoutingPrompt({
        userMsg: 'node 的拒绝',
        tabs: ['multi-cc-im', 'node'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf node_modules' },
          },
          {
            tabName: 'node',
            toolName: 'Edit',
            toolInput: { file_path: '/etc/hosts' },
          },
        ],
      });
      expect(out).toContain('multi-cc-im');
      expect(out).toContain('node');
      expect(out).toContain('Bash');
      expect(out).toContain('Edit');
      expect(out).toContain('/etc/hosts');
    });

    it('includes the D5-3 asymmetric trust rule (allow requires a content match-signal)', () => {
      const out = renderRoutingPrompt({
        userMsg: '同意',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf node_modules' },
          },
        ],
      });
      // The rule is named:
      expect(out).toMatch(/asymmetric|match[-\s]signal/i);
      // The downgrade direction is spelled out:
      expect(out).toMatch(/downgrade.*deny|allow.*→.*deny|degrade.*to.*deny/i);
      // The three signal types are mentioned:
      expect(out).toMatch(/tool name/i);
      expect(out).toMatch(/argument|substring/i);
      expect(out).toMatch(/paraphrase/i);
      // Deny is safe without a match-signal:
      expect(out).toMatch(/deny.*safe|deny does NOT require/i);
    });

    it('extends the OUTPUT spec with a permissionResponse field', () => {
      const out = renderRoutingPrompt({
        userMsg: 'multi-cc-im 同意',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf node_modules' },
          },
        ],
      });
      expect(out).toContain('"permissionResponse"');
      expect(out).toMatch(/"decision":\s*"allow"\s*\|\s*"deny"/);
    });

    // -------------------------------------------------------------------
    // AskUserQuestion-specific bullet + rules (v1.9 DD §6 P4)
    // -------------------------------------------------------------------

    it('AskUserQuestion entry renders question + numbered options (NOT raw JSON dump)', () => {
      const out = renderRoutingPrompt({
        userMsg: '1',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Pick a database',
                  header: 'DB',
                  multiSelect: false,
                  options: [
                    { label: 'Postgres', description: 'mature relational' },
                    { label: 'MongoDB', description: 'doc store' },
                  ],
                },
              ],
            },
          },
        ],
      });
      // Question text visible (not just raw `tool_input` JSON):
      expect(out).toContain('Pick a database');
      // Options rendered as a numbered list:
      expect(out).toMatch(/1\..*Postgres/);
      expect(out).toMatch(/2\..*MongoDB/);
      // Descriptions present (so AI can match against "the mature one" etc.):
      expect(out).toContain('mature relational');
      expect(out).toContain('doc store');
      // Bullet must NOT show the raw `questions=[...]` blob — that's
      // unreadable and confuses the AI:
      expect(out).not.toMatch(/input=questions=\[/);
    });

    it('AskUserQuestion entry triggers the SPECIAL RULE section (always deny + reason = picked option or free text)', () => {
      const out = renderRoutingPrompt({
        userMsg: '我选 Postgres',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Pick a DB',
                  header: '',
                  multiSelect: false,
                  options: [
                    { label: 'Postgres', description: '' },
                    { label: 'MongoDB', description: '' },
                  ],
                },
              ],
            },
          },
        ],
      });
      // Section header:
      expect(out).toMatch(/AskUserQuestion|widget question/i);
      // Always-deny instruction:
      expect(out).toMatch(/always.*deny|decision.*always.*"deny"/i);
      // Reason = picked option's label, or free-text passthrough:
      expect(out).toMatch(/label|option label|exact label/i);
      expect(out).toMatch(/free text|verbatim|pass through/i);
      // D5-3 asymmetric trust should NOT apply to AskUserQuestion (it's
      // about allow/deny gating for regular tools).
      expect(out).toMatch(
        /D5-3.*regular|asymmetric trust.*not apply|only.*regular tools|AskUserQuestion.*exempt/i,
      );
    });

    it('mixed pending (regular + AskUserQuestion) — both rendered correctly side by side', () => {
      const out = renderRoutingPrompt({
        userMsg: 'do option 2',
        tabs: ['multi-cc-im', 'frontend'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf node_modules' },
          },
          {
            tabName: 'frontend',
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Style?',
                  header: '',
                  multiSelect: false,
                  options: [
                    { label: 'Tailwind', description: '' },
                    { label: 'CSS Modules', description: '' },
                  ],
                },
              ],
            },
          },
        ],
      });
      // Regular Bash entry still rendered with input= prefix (existing format):
      expect(out).toMatch(/tool=Bash.*input=command=/);
      // AskUserQuestion still has its question + options visible:
      expect(out).toContain('Style?');
      expect(out).toContain('Tailwind');
      expect(out).toContain('CSS Modules');
    });

    it('AskUserQuestion multi-question (>= 2 questions) — first question options rendered + note about the rest', () => {
      const out = renderRoutingPrompt({
        userMsg: '1',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Q1',
                  header: '',
                  multiSelect: false,
                  options: [{ label: 'A', description: '' }],
                },
                {
                  question: 'Q2',
                  header: '',
                  multiSelect: false,
                  options: [{ label: 'B', description: '' }],
                },
              ],
            },
          },
        ],
      });
      expect(out).toContain('Q1');
      // Multi-question note (mirrors orchestrator P3 behavior):
      expect(out).toMatch(/2 question|additional question|cc TUI/);
    });

    it('AskUserQuestion with malformed toolInput (no questions array) — defensive: bullet still emitted with safe placeholder', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'AskUserQuestion',
            toolInput: { something_else: 'oops' },
          },
        ],
      });
      // Must NOT crash — output must include the tab name + tool name + a
      // placeholder so AI knows there's a pending it can't fully parse.
      expect(out).toContain('multi-cc-im');
      expect(out).toContain('AskUserQuestion');
      expect(out).toMatch(/malformed|unknown|no questions/i);
    });

    // -------------------------------------------------------------------
    // forcePermissionMode (v1.10) — when daemon detects ANY pending, the
    // prompt is rendered in a simplified variant: AI is told the message
    // MUST be a permission reply (cc protocol won't accept new tasks
    // during pending PreToolUse), so routing rules are stripped and the
    // output spec forbids top-level target/intent (must fill
    // permissionResponse).
    // -------------------------------------------------------------------

    it('forcePermissionMode=true → prompt has FORCE PERMISSION MODE marker', () => {
      const out = renderRoutingPrompt({
        userMsg: 'I pick option 2',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Pick',
                  options: [{ label: 'A' }, { label: 'B' }],
                },
              ],
            },
          },
        ],
        forcePermissionMode: true,
      });
      expect(out).toMatch(/FORCE PERMISSION MODE|forced permission|must be a reply/i);
    });

    it('forcePermissionMode=true → prompt OUTPUT spec REQUIRES permissionResponse, forbids routing target/intent', () => {
      const out = renderRoutingPrompt({
        userMsg: 'I pick A',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm' },
          },
        ],
        forcePermissionMode: true,
      });
      // OUTPUT block must say target / intent are always null in this mode.
      expect(out).toMatch(/"target":\s*null/);
      expect(out).toMatch(/"intent":\s*null/);
      // permissionResponse must be marked required (not "| null"):
      expect(out).toContain('"permissionResponse"');
      // Must explicitly say "REQUIRED" or similar — not "optional / null":
      expect(out).toMatch(/required|MUST fill|always fill/i);
    });

    it('forcePermissionMode=true → routing rules (Rule 1/2/3) are STRIPPED from prompt', () => {
      const out = renderRoutingPrompt({
        userMsg: 'I pick A',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm' },
          },
        ],
        forcePermissionMode: true,
      });
      // Routing rules irrelevant when force-permission — should be absent.
      expect(out).not.toMatch(/Rule 1.*IF A TAB NAME APPEARS/i);
      expect(out).not.toMatch(/MATCHING RULES \(in priority order\)/i);
      // But PENDING section + SPECIAL RULE (AskUserQuestion) + ASYMMETRIC
      // TRUST (regular tools) should still be present.
      expect(out).toMatch(/PENDING TOOL PERMISSION/i);
      expect(out).toMatch(/ASYMMETRIC TRUST|match[-\s]signal/i);
    });

    it('forcePermissionMode=false (or undefined) → behaves as before (routing rules present)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'hi frontend',
        tabs: ['frontend'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'frontend',
            toolName: 'Bash',
            toolInput: { command: 'ls' },
          },
        ],
        // No forcePermissionMode — defaults to false
      });
      expect(out).not.toMatch(/FORCE PERMISSION MODE/i);
      // Routing rules still in place:
      expect(out).toMatch(/Rule 1.*IF A TAB NAME APPEARS/i);
    });

    it('forcePermissionMode=true without pending → still strips routing (defensive — caller decides when force)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'hi',
        tabs: ['frontend'],
        currentTab: null,
        forcePermissionMode: true,
      });
      // No routing rules even without pending — caller chose force mode.
      expect(out).not.toMatch(/MATCHING RULES \(in priority order\)/i);
    });
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
      permissionResponse: null,
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

  // P2 — natural-language permission reply (DD 2026-05-11)
  describe('permissionResponse extraction', () => {
    it('absent → permissionResponse is null', () => {
      const out = parseRoutingOutput(
        envelope('{"target":"frontend","intent":"x","reason":"r"}'),
      );
      expect(out.permissionResponse).toBeNull();
    });

    it('valid allow → preserved', () => {
      const inner = JSON.stringify({
        target: null,
        intent: null,
        reason: 'permission reply',
        permissionResponse: {
          target: 'multi-cc-im',
          decision: 'allow',
          reason: '用户同意 rm node_modules',
        },
      });
      const out = parseRoutingOutput(envelope(inner));
      expect(out.permissionResponse).toEqual({
        target: 'multi-cc-im',
        decision: 'allow',
        reason: '用户同意 rm node_modules',
      });
    });

    it('valid deny → preserved', () => {
      const inner = JSON.stringify({
        target: null,
        intent: null,
        reason: 'permission reply',
        permissionResponse: {
          target: 'node',
          decision: 'deny',
          reason: '用户拒绝',
        },
      });
      const out = parseRoutingOutput(envelope(inner));
      expect(out.permissionResponse).toEqual({
        target: 'node',
        decision: 'deny',
        reason: '用户拒绝',
      });
    });

    it('missing target → permissionResponse is null (incomplete)', () => {
      const inner = JSON.stringify({
        target: null,
        intent: null,
        reason: 'r',
        permissionResponse: {
          decision: 'allow',
          reason: 'r',
        },
      });
      const out = parseRoutingOutput(envelope(inner));
      expect(out.permissionResponse).toBeNull();
    });

    it('invalid decision value → permissionResponse is null', () => {
      const inner = JSON.stringify({
        target: null,
        intent: null,
        reason: 'r',
        permissionResponse: {
          target: 'frontend',
          decision: 'maybe',
          reason: 'r',
        },
      });
      const out = parseRoutingOutput(envelope(inner));
      expect(out.permissionResponse).toBeNull();
    });

    it('non-object permissionResponse → null', () => {
      const inner = JSON.stringify({
        target: null,
        intent: null,
        reason: 'r',
        permissionResponse: 'allow',
      });
      const out = parseRoutingOutput(envelope(inner));
      expect(out.permissionResponse).toBeNull();
    });
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
    expect(out).toEqual({
      target: 'frontend',
      intent: 'hi',
      reason: 'r',
      permissionResponse: null,
    });
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

  // Regression — daemon used to inherit WEZTERM_PANE into the spawned cc
  // subprocess, which made cc's Stop hook receiver believe it was running
  // in a wezterm tab and write a `<paneId>_<sid>.Stop.<ts>` file. The daemon
  // then forwarded that file to IM, leaking the routing JSON envelope back
  // to the user. We now strip WEZTERM_PANE from the spawned env so the hook
  // receiver's first gate (`defaultResolvePaneId() === undefined`) silently
  // exits without touching disk.
  function writeStubDumpingEnv(
    stdout: string,
  ): { binary: string; envDumpPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-envdump-'));
    const envDumpPath = join(dir, 'env-dump.txt');
    const path = join(dir, 'claude-stub');
    writeFileSync(
      path,
      `#!/bin/sh
printf 'WEZTERM_PANE=%s\\n' "\${WEZTERM_PANE:-<unset>}" > "${envDumpPath}"
cat <<'EOF'
${stdout}
EOF
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
    return { binary: path, envDumpPath };
  }

  // P2 — natural-language permission reply (DD 2026-05-11)
  it('forwards pendingRequests into prompt and returns AI permissionResponse', async () => {
    const stub = writeStub(
      JSON.stringify({
        result: JSON.stringify({
          target: null,
          intent: null,
          reason: 'permission reply',
          permissionResponse: {
            target: 'multi-cc-im',
            decision: 'allow',
            reason: '用户同意 rm node_modules',
          },
        }),
      }),
    );
    const out = await routeViaAI({
      userMsg: 'multi-cc-im 那个 rm 的我同意',
      tabs: ['multi-cc-im', 'node'],
      currentTab: null,
      claudeBinary: stub,
      pendingRequests: [
        {
          tabName: 'multi-cc-im',
          toolName: 'Bash',
          toolInput: { command: 'rm -rf node_modules' },
        },
      ],
    });
    expect(out.target).toBeNull();
    expect(out.intent).toBeNull();
    expect(out.permissionResponse).toEqual({
      target: 'multi-cc-im',
      decision: 'allow',
      reason: '用户同意 rm node_modules',
    });
  });

  it('strips WEZTERM_PANE from the spawned cc env (prevents stop-hook misforward of routing JSON)', async () => {
    const { binary, envDumpPath } = writeStubDumpingEnv(
      JSON.stringify({
        result: '{"target":"frontend","intent":"x","reason":"r"}',
      }),
    );
    const prev = process.env.WEZTERM_PANE;
    process.env.WEZTERM_PANE = '99999';
    try {
      const out = await routeViaAI({
        userMsg: 'x',
        tabs: ['frontend'],
        currentTab: null,
        claudeBinary: binary,
      });
      expect(out.target).toBe('frontend');
    } finally {
      if (prev === undefined) delete process.env.WEZTERM_PANE;
      else process.env.WEZTERM_PANE = prev;
    }
    const dumped = readFileSync(envDumpPath, 'utf8').trim();
    expect(dumped).toBe('WEZTERM_PANE=<unset>');
  });
});

// ============================================================================
// explainExecError — diagnostic reason formatter
// Per user smoke 2026-05-11: SIGTERM-killed cc subprocesses (exit 143)
// were showing as "cc exec failed: 143" — obscuring the fact that
// Node's execFile timeout fires SIGTERM at deadline. This helper makes
// the cause explicit + includes stderr.
// ============================================================================

describe('ai-router — explainExecError', () => {
  it('ENOENT → "cc not in PATH" (fail-fast, no signal / stderr noise)', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    expect(explainExecError(err, 30_000)).toBe('cc not in PATH');
  });

  it('timeout detected via killed=true → "cc timeout after Nms" + signal', () => {
    const err = Object.assign(new Error('timed out'), {
      code: 143,
      signal: 'SIGTERM',
      killed: true,
    });
    expect(explainExecError(err, 30_000)).toMatch(
      /cc timeout after 30000ms signal=SIGTERM/,
    );
  });

  it('timeout detected via legacy code=ETIMEDOUT (older Node versions)', () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect(explainExecError(err, 15_000)).toMatch(/cc timeout after 15000ms/);
  });

  it('timeout detected via signal=SIGTERM even without killed flag', () => {
    const err = Object.assign(new Error('killed'), {
      signal: 'SIGTERM',
      code: null,
    });
    expect(explainExecError(err, 30_000)).toMatch(/cc timeout/);
  });

  it('numeric exit code (non-timeout) → "cc exited code=N" + stderr snippet', () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stderr: 'Error: invalid model name\n  at parseArgs (...)\n',
    });
    const out = explainExecError(err, 30_000);
    expect(out).toContain('cc exited code=1');
    expect(out).toContain('stderr="Error: invalid model name"');
  });

  it('Buffer stderr is decoded to UTF-8 (Node returns Buffer when no encoding set)', () => {
    const err = Object.assign(new Error('exit 2'), {
      code: 2,
      stderr: Buffer.from('boom from cc\n', 'utf-8'),
    });
    expect(explainExecError(err, 30_000)).toContain('stderr="boom from cc"');
  });

  it('long stderr is truncated to 80 chars', () => {
    const longErr = 'x'.repeat(200);
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stderr: longErr,
    });
    const out = explainExecError(err, 30_000);
    const match = /stderr="([^"]+)"/.exec(out);
    expect(match).toBeTruthy();
    expect(match![1]!.length).toBeLessThanOrEqual(80);
  });

  it('no stderr → no stderr= suffix', () => {
    const err = Object.assign(new Error('exit 5'), { code: 5 });
    const out = explainExecError(err, 30_000);
    expect(out).toBe('cc exited code=5');
    expect(out).not.toContain('stderr=');
  });

  it('unknown shape (no code, no signal) → "cc exec failed: unknown"', () => {
    expect(explainExecError(new Error('mystery'), 30_000)).toBe(
      'cc exec failed: unknown',
    );
  });
});
