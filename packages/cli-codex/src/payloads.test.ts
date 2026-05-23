import { describe, it, expect } from 'vitest';
import {
  SessionStartPayloadSchema,
  PreToolUsePayloadSchema,
  PermissionRequestPayloadSchema,
  StopPayloadSchema,
  HookPayloadSchema,
  parseHookPayload,
} from './payloads.js';

const SID = 'thread_01J9Z7HVQK5P3M4XYZ';
const TX = '/Users/x/.codex/sessions/2026-05-22/thread_01J9Z7HVQK5P3M4XYZ.jsonl';
const CWD = '/private/tmp/codex-probe';
const MODEL = 'gpt-5-codex';
const TURN_ID = 'turn_01J9Z7HW2A5BCD9XYZQQ';

const SESSION_START = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionStart' as const,
  permission_mode: 'default' as const,
  model: MODEL,
  source: 'startup' as const,
};

const PRE_TOOL_USE = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PreToolUse' as const,
  permission_mode: 'default' as const,
  model: MODEL,
  turn_id: TURN_ID,
  agent_id: '',
  agent_type: '',
  tool_name: 'shell',
  tool_input: { command: ['ls', '-la'] },
  tool_use_id: 'fc_01J9Z7HW9A0',
};

const PERMISSION_REQUEST = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PermissionRequest' as const,
  permission_mode: 'default' as const,
  model: MODEL,
  turn_id: TURN_ID,
  agent_id: '',
  agent_type: '',
  tool_name: 'shell',
  tool_input: { command: ['rm', '-rf', '/tmp/x'] },
};

const STOP = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop' as const,
  permission_mode: 'default' as const,
  model: MODEL,
  turn_id: TURN_ID,
  stop_hook_active: false,
  last_assistant_message: 'task complete',
};

describe('SessionStartPayloadSchema', () => {
  it('accepts the source-verified shape verbatim', () => {
    const parsed = SessionStartPayloadSchema.parse(SESSION_START);
    expect(parsed.hook_event_name).toBe('SessionStart');
    expect(parsed.source).toBe('startup');
    expect(parsed.model).toBe(MODEL);
  });

  it('accepts all 4 source enum values (startup / resume / clear / compact)', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      const parsed = SessionStartPayloadSchema.parse({ ...SESSION_START, source });
      expect(parsed.source).toBe(source);
    }
  });

  it('rejects unknown source value', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, source: 'init' }),
    ).toThrow();
  });

  it('accepts null transcript_path (codex NullableString)', () => {
    const parsed = SessionStartPayloadSchema.parse({
      ...SESSION_START,
      transcript_path: null,
    });
    expect(parsed.transcript_path).toBeNull();
  });

  it('rejects empty session_id', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, session_id: '' }),
    ).toThrow();
  });
});

describe('PreToolUsePayloadSchema', () => {
  it('accepts the source-verified shape verbatim', () => {
    const parsed = PreToolUsePayloadSchema.parse(PRE_TOOL_USE);
    expect(parsed.tool_name).toBe('shell');
    expect(parsed.tool_use_id).toBe('fc_01J9Z7HW9A0');
    expect(parsed.turn_id).toBe(TURN_ID);
  });

  it('rejects empty tool_use_id (codex always provides non-empty at PreToolUse)', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, tool_use_id: '' }),
    ).toThrow();
  });

  it('rejects empty turn_id', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, turn_id: '' }),
    ).toThrow();
  });

  it('accepts empty agent_id / agent_type (non-subagent context)', () => {
    const parsed = PreToolUsePayloadSchema.parse({
      ...PRE_TOOL_USE,
      agent_id: '',
      agent_type: '',
    });
    expect(parsed.agent_id).toBe('');
  });

  it('rejects unknown permission_mode (codex enum is closed)', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({
        ...PRE_TOOL_USE,
        permission_mode: 'yolo',
      }),
    ).toThrow();
  });

  it('accepts all 5 permission_mode enum values', () => {
    for (const mode of [
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ] as const) {
      const parsed = PreToolUsePayloadSchema.parse({
        ...PRE_TOOL_USE,
        permission_mode: mode,
      });
      expect(parsed.permission_mode).toBe(mode);
    }
  });
});

describe('PermissionRequestPayloadSchema', () => {
  it('accepts the source-verified shape verbatim', () => {
    const parsed = PermissionRequestPayloadSchema.parse(PERMISSION_REQUEST);
    expect(parsed.hook_event_name).toBe('PermissionRequest');
    expect(parsed.tool_name).toBe('shell');
  });

  it('does NOT carry permission_suggestions (codex has no analog for cc quick-rules)', () => {
    const parsed = PermissionRequestPayloadSchema.parse(PERMISSION_REQUEST);
    expect(parsed).not.toHaveProperty('permission_suggestions');
  });

  it('rejects empty tool_name', () => {
    expect(() =>
      PermissionRequestPayloadSchema.parse({
        ...PERMISSION_REQUEST,
        tool_name: '',
      }),
    ).toThrow();
  });
});

describe('StopPayloadSchema', () => {
  it('accepts the source-verified shape verbatim', () => {
    const parsed = StopPayloadSchema.parse(STOP);
    expect(parsed.last_assistant_message).toBe('task complete');
    expect(parsed.stop_hook_active).toBe(false);
  });

  it('accepts null last_assistant_message (codex NullableString)', () => {
    const parsed = StopPayloadSchema.parse({
      ...STOP,
      last_assistant_message: null,
    });
    expect(parsed.last_assistant_message).toBeNull();
  });

  it('rejects non-boolean stop_hook_active', () => {
    expect(() =>
      StopPayloadSchema.parse({ ...STOP, stop_hook_active: 'false' as unknown as boolean }),
    ).toThrow();
  });
});

describe('HookPayloadSchema (discriminator)', () => {
  it('routes SessionStart to its schema via hook_event_name', () => {
    const parsed = HookPayloadSchema.parse(SESSION_START);
    expect(parsed.hook_event_name).toBe('SessionStart');
  });

  it('routes PreToolUse to its schema', () => {
    const parsed = HookPayloadSchema.parse(PRE_TOOL_USE);
    expect(parsed.hook_event_name).toBe('PreToolUse');
  });

  it('routes PermissionRequest to its schema', () => {
    const parsed = HookPayloadSchema.parse(PERMISSION_REQUEST);
    expect(parsed.hook_event_name).toBe('PermissionRequest');
  });

  it('routes Stop to its schema', () => {
    const parsed = HookPayloadSchema.parse(STOP);
    expect(parsed.hook_event_name).toBe('Stop');
  });

  it('rejects unsubscribed event (PostToolUse / UserPromptSubmit / etc.)', () => {
    expect(() =>
      HookPayloadSchema.parse({
        ...PRE_TOOL_USE,
        hook_event_name: 'PostToolUse' as unknown as 'PreToolUse',
      }),
    ).toThrow();
  });
});

describe('parseHookPayload', () => {
  it('parses raw stdin JSON into typed payload', () => {
    const raw = JSON.stringify(STOP);
    const parsed = parseHookPayload(raw);
    expect(parsed.hook_event_name).toBe('Stop');
    if (parsed.hook_event_name === 'Stop') {
      expect(parsed.last_assistant_message).toBe('task complete');
    }
  });

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => parseHookPayload('{not json')).toThrow();
  });

  it('throws ZodError on shape mismatch', () => {
    expect(() => parseHookPayload(JSON.stringify({ hook_event_name: 'Stop' }))).toThrow();
  });
});
