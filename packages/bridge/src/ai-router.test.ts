import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeArgs,
  explainExecError,
  parseAskUserQuestionOutput,
  parseRoutingOutput,
  renderAskUserQuestionPrompt,
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

  // Role + 3-part intent extraction (2026-05-12 fix for AI dispatcher
  // mis-treating meta-instructions as task body).
  describe('role + 3-part intent extraction', () => {
    it('includes a YOUR ROLE section identifying the dispatcher role', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      expect(out).toMatch(/YOUR ROLE/i);
      expect(out).toMatch(/dispatcher/i);
    });

    it('explains the 你/他 pronoun convention (你 = dispatcher, 他 = cc)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // The user's 你 is the dispatcher; 他 refers to cc — prompt must
      // teach AI to strip "你跟 X 说" and rewrite "他" → 2nd-person.
      expect(out).toMatch(/你跟/);
      expect(out).toMatch(/3rd-person/i);
      expect(out).toMatch(/2nd-person/i);
    });

    it('has an INTENT EXTRACTION section with 3-part split', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      expect(out).toMatch(/INTENT EXTRACTION/i);
      expect(out).toMatch(/ROUTING CUES/i);
      expect(out).toMatch(/TASK BODY/i);
      expect(out).toMatch(/META-INSTRUCTIONS/i);
    });

    it('teaches 3rd-person → 2nd-person rewrite explicitly (with "让他" / "his"/"cc 应该" mappings)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // Each documented rewrite pair must be present so AI sees the pattern.
      expect(out).toMatch(/让他/);
      expect(out).toMatch(/请你|请\s/);
      expect(out).toMatch(/his code|your code/i);
      expect(out).toMatch(/cc 应该/);
    });

    it('teaches meta-instruction rewrite: examples cover Chinese + English variants', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // Both 让他先出计划 and "make him plan first" should appear as
      // patterns AI is expected to recognize as meta.
      expect(out).toMatch(/让他先出计划/);
      expect(out).toMatch(/用 TDD|先 review|出 plan/);
      expect(out).toMatch(/make him plan first|have it run tests/i);
    });

    it('includes the real-case anchor example (2026-05-12 work_temp regression)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // The exact user case that motivated this fix lives in the prompt
      // as an anchor example so AI sees a concrete mapping it can mimic.
      expect(out).toMatch(/work temp/);
      expect(out).toMatch(/stop hook/);
      expect(out).toMatch(/neat-freak/);
      expect(out).toMatch(/请先出计划，不要直接实施/);
    });

    it('OUTPUT spec intent field references INTENT EXTRACTION (not just "task description")', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // Old spec said "task description with routing cues stripped" —
      // new spec must mention meta-instructions / 2nd-person rewrite
      // so the AI hooks into the INTENT EXTRACTION rules.
      expect(out).toMatch(/meta-instructions|2nd-person|INTENT EXTRACTION/i);
    });

    it('has a fallback rule: when meta vs body ambiguous, keep as body', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      expect(out).toMatch(/cannot distinguish|default to keeping|extra wording is better/i);
    });

    it('Rule 1 has MOST-SPECIFIC tie-break for nested tab-name matches (2026-05-12 breatic_frontend fix)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['breatic', 'breatic_frontend'],
        currentTab: null,
      });
      // Tie-break section header / instruction:
      expect(out).toMatch(/MOST-SPECIFIC|most specific|TIE-BREAK/i);
      // Anchor example with the real-case tabs:
      expect(out).toMatch(/breatic_frontend/);
      expect(out).toMatch(/breatic frontend/);
    });

    it('Rule 1 also adds the underscore↔space leniency example (work_temp / breatic_frontend)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['frontend'],
        currentTab: null,
      });
      // Lenient matching list now includes underscore-to-space examples
      // so AI knows "work temp" matches "work_temp" and "breatic frontend"
      // matches "breatic_frontend".
      expect(out).toMatch(/work temp.*work_temp/);
      expect(out).toMatch(/breatic frontend.*breatic_frontend/);
    });

    it('Rule 1 has a standalone STT voice-typo bullet with AGGRESSIVE matching directive (2026-05-13 Multi-CCRM fix)', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['multi-cc-im'],
        currentTab: null,
      });
      // STT voice-typo handling must be its own bullet (not buried inside
      // the Chinese-English code-mixing bullet) so Haiku doesn't skip it.
      expect(out).toMatch(/speech-to-text|STT/i);
      expect(out).toMatch(/AGGRESSIVE/);
      expect(out).toMatch(/Do NOT bail|don't pick on STT typos/i);
    });

    it('Rule 1 spells out the ≤2 character edit-distance rule for STT typos', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['multi-cc-im'],
        currentTab: null,
      });
      expect(out).toMatch(/≤\s*2|at most.*2.*character|2 character/i);
      expect(out).toMatch(/substitut|insertion|deletion/i);
      expect(out).toMatch(/TREAT IT AS A MATCH/);
    });

    it('Rule 1 includes the real-case anchor: Multi-CCRM → multi-cc-im', () => {
      const out = renderRoutingPrompt({
        userMsg: 'whatever',
        tabs: ['multi-cc-im'],
        currentTab: null,
      });
      // The exact STT mishearing the user reported (2026-05-13).
      expect(out).toMatch(/Multi-CCRM/);
      expect(out).toMatch(/multi-cc-im/);
      // Plus several other phonetic-distance anchors so AI generalises.
      expect(out).toMatch(/no\.js|nojs/);
      expect(out).toMatch(/work tamp|walk temp/);
    });
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
    // AskUserQuestion pendings flow through a separate AI path
    // (`renderAskUserQuestionPrompt`) per DD §9 revision. The router
    // filters them out before invoking the routing / force-permission
    // prompts. Tests for the AUQ-only path live further below.
    // -------------------------------------------------------------------

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
        userMsg: 'allow that rm command',
        tabs: ['multi-cc-im'],
        currentTab: null,
        pendingRequests: [
          {
            tabName: 'multi-cc-im',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf build' },
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

// ============================================================================
// AskUserQuestion path (DD §9 — D5-D allow + updatedInput.answers)
// ============================================================================

describe('ai-router — renderAskUserQuestionPrompt', () => {
  const ONE_QUESTION_PENDING = {
    tabName: 'multi-cc-im',
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
  };

  it('renders question text + numbered options + descriptions', () => {
    const out = renderAskUserQuestionPrompt({
      userMsg: '1',
      pendings: [ONE_QUESTION_PENDING],
    });
    expect(out).toContain('Pick a database');
    expect(out).toMatch(/1\. Postgres/);
    expect(out).toMatch(/2\. MongoDB/);
    expect(out).toContain('mature relational');
    expect(out).toContain('doc store');
  });

  it('marks multiSelect questions in the bullet', () => {
    const out = renderAskUserQuestionPrompt({
      userMsg: '1,2',
      pendings: [
        {
          tabName: 'multi-cc-im',
          questions: [
            {
              question: 'Which features?',
              header: 'Feat',
              multiSelect: true,
              options: [
                { label: 'A', description: '' },
                { label: 'B', description: '' },
                { label: 'C', description: '' },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toMatch(/multiSelect/i);
  });

  it('renders multi-question pendings — both questions visible', () => {
    const out = renderAskUserQuestionPrompt({
      userMsg: 'first one is summary, second is intro and conclusion',
      pendings: [
        {
          tabName: 'multi-cc-im',
          questions: [
            {
              question: 'Format?',
              header: 'F',
              multiSelect: false,
              options: [
                { label: 'Summary', description: 's' },
                { label: 'Detailed', description: 'd' },
              ],
            },
            {
              question: 'Sections?',
              header: 'S',
              multiSelect: true,
              options: [
                { label: 'Intro', description: 'i' },
                { label: 'Conclusion', description: 'c' },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toContain('Format?');
    expect(out).toContain('Sections?');
    expect(out).toMatch(/question\[0\]/);
    expect(out).toMatch(/question\[1\]/);
  });

  it('OUTPUT spec mandates structured answers array (option / text kinds)', () => {
    const out = renderAskUserQuestionPrompt({
      userMsg: '1',
      pendings: [ONE_QUESTION_PENDING],
    });
    expect(out).toContain('"answers"');
    expect(out).toMatch(/"kind":\s*"option"/);
    expect(out).toMatch(/"kind":\s*"text"/);
    expect(out).toMatch(/"optionIndex"/);
    expect(out).toMatch(/"text"/);
    // No routing rules — AUQ path is focused on answer extraction only.
    expect(out).not.toMatch(/MATCHING RULES \(in priority order\)/);
    expect(out).not.toMatch(/Rule 1.*IF A TAB NAME APPEARS/i);
    // No allow/deny semantics — AUQ doesn't gate, it answers.
    expect(out).not.toMatch(/decision.*allow/i);
  });

  it('interpolates the user message verbatim', () => {
    const out = renderAskUserQuestionPrompt({
      userMsg: '我选 Postgres，不要 MongoDB',
      pendings: [ONE_QUESTION_PENDING],
    });
    expect(out).toContain('我选 Postgres，不要 MongoDB');
  });
});

describe('ai-router — parseAskUserQuestionOutput', () => {
  function wrapEnvelope(inner: unknown): string {
    return JSON.stringify({
      result:
        typeof inner === 'string' ? inner : JSON.stringify(inner),
      session_id: 'test',
    });
  }

  it('parses a valid option-kind answer (1-based index)', () => {
    const envelope = wrapEnvelope({
      target: 'multi-cc-im',
      reason: 'user picked option 1',
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: 1 }],
    });
    const result = parseAskUserQuestionOutput(envelope);
    expect(result).not.toBeNull();
    expect(result!.target).toBe('multi-cc-im');
    expect(result!.answers).toEqual([
      { questionIndex: 0, kind: 'option', optionIndex: 1 },
    ]);
  });

  it('parses a multi-select option-kind answer (optionIndex array)', () => {
    const envelope = wrapEnvelope({
      target: 'frontend',
      reason: 'multi pick',
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: [1, 3] }],
    });
    const result = parseAskUserQuestionOutput(envelope);
    expect(result).not.toBeNull();
    const entry = result!.answers[0];
    if (entry?.kind !== 'option') throw new Error('expected option');
    expect(entry.optionIndex).toEqual([1, 3]);
  });

  it('parses a text-kind free-form answer', () => {
    const envelope = wrapEnvelope({
      target: 'multi-cc-im',
      reason: 'free text',
      answers: [
        { questionIndex: 0, kind: 'text', text: 'use TypeScript strict mode' },
      ],
    });
    const result = parseAskUserQuestionOutput(envelope);
    expect(result).not.toBeNull();
    const entry = result!.answers[0];
    if (entry?.kind !== 'text') throw new Error('expected text');
    expect(entry.text).toBe('use TypeScript strict mode');
  });

  it('returns null on invalid optionIndex (0 or negative)', () => {
    const envelope = wrapEnvelope({
      target: 'multi-cc-im',
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: 0 }],
    });
    expect(parseAskUserQuestionOutput(envelope)).toBeNull();
  });

  it('returns null on empty answers array', () => {
    const envelope = wrapEnvelope({
      target: 'multi-cc-im',
      answers: [],
    });
    expect(parseAskUserQuestionOutput(envelope)).toBeNull();
  });

  it('returns null on missing target', () => {
    const envelope = wrapEnvelope({
      answers: [{ questionIndex: 0, kind: 'option', optionIndex: 1 }],
    });
    expect(parseAskUserQuestionOutput(envelope)).toBeNull();
  });

  it('strips markdown fences around inner JSON before parsing', () => {
    const inner =
      '```json\n' +
      JSON.stringify({
        target: 'multi-cc-im',
        answers: [{ questionIndex: 0, kind: 'option', optionIndex: 2 }],
      }) +
      '\n```';
    const envelope = JSON.stringify({ result: inner });
    const result = parseAskUserQuestionOutput(envelope);
    expect(result).not.toBeNull();
    expect(result!.target).toBe('multi-cc-im');
  });

  it('returns null on malformed envelope', () => {
    expect(parseAskUserQuestionOutput('not json')).toBeNull();
    expect(parseAskUserQuestionOutput('{}')).toBeNull();
    expect(parseAskUserQuestionOutput('{"result": 123}')).toBeNull();
  });
});
