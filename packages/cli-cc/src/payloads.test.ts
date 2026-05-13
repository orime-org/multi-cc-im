import { describe, it, expect } from 'vitest';
import {
  PreToolUsePayloadSchema,
  PermissionRequestPayloadSchema,
  StopPayloadSchema,
  HookPayloadSchema,
  parseHookPayload,
} from './payloads.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

const PRE_TOOL_USE = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_abc',
};

const STOP = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
};

const PERMISSION_REQUEST = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'mkdir -p .claude/hooks' },
  permission_suggestions: [
    { type: 'addRules', behavior: 'allow', destination: 'session' },
  ],
};

describe('PreToolUsePayloadSchema', () => {
  it('accepts the H1 verified schema verbatim', () => {
    const parsed = PreToolUsePayloadSchema.parse(PRE_TOOL_USE);
    expect(parsed.tool_name).toBe('Bash');
    expect(parsed.tool_use_id).toBe('toolu_abc');
  });

  it('rejects missing session_id', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, session_id: undefined }),
    ).toThrow();
  });

  it('rejects malformed UUID for session_id', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, session_id: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects non-absolute cwd (cc always gives realpath)', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, cwd: 'relative/path' }),
    ).toThrow();
  });

  it('rejects transcript_path not ending in .jsonl', () => {
    expect(() =>
      PreToolUsePayloadSchema.parse({ ...PRE_TOOL_USE, transcript_path: '/tmp/x.txt' }),
    ).toThrow();
  });
});

describe('StopPayloadSchema', () => {
  it('accepts the H1 verified schema verbatim', () => {
    const parsed = StopPayloadSchema.parse(STOP);
    expect(parsed.stop_hook_active).toBe(false);
    expect(parsed.last_assistant_message).toBe('hi');
  });

  it('accepts stop_hook_active=true (idle wakeup chain marker)', () => {
    expect(
      StopPayloadSchema.parse({ ...STOP, stop_hook_active: true }).stop_hook_active,
    ).toBe(true);
  });

  it('preserves Unicode + emoji + newlines in last_assistant_message', () => {
    const payload = {
      ...STOP,
      last_assistant_message: '多行\n第二行 ✨ probe',
    };
    expect(StopPayloadSchema.parse(payload).last_assistant_message).toBe(
      '多行\n第二行 ✨ probe',
    );
  });
});

describe('PermissionRequestPayloadSchema', () => {
  it('accepts the cc 2.1.88 PermissionRequest payload shape', () => {
    const parsed = PermissionRequestPayloadSchema.parse(PERMISSION_REQUEST);
    expect(parsed.hook_event_name).toBe('PermissionRequest');
    expect(parsed.tool_name).toBe('Bash');
    expect(parsed.tool_input).toEqual({ command: 'mkdir -p .claude/hooks' });
    expect(parsed.permission_suggestions).toHaveLength(1);
  });

  it('permission_suggestions is optional (cc may omit it for some dialogs)', () => {
    const { permission_suggestions, ...withoutSuggestions } = PERMISSION_REQUEST;
    void permission_suggestions;
    expect(() =>
      PermissionRequestPayloadSchema.parse(withoutSuggestions),
    ).not.toThrow();
  });

  it('rejects payload missing required tool_name', () => {
    const { tool_name, ...invalid } = PERMISSION_REQUEST;
    void tool_name;
    expect(() => PermissionRequestPayloadSchema.parse(invalid)).toThrow();
  });
});

describe('HookPayloadSchema (discriminated union)', () => {
  it('discriminates PreToolUse + PermissionRequest + Stop by hook_event_name', () => {
    expect(HookPayloadSchema.parse(PRE_TOOL_USE).hook_event_name).toBe('PreToolUse');
    expect(HookPayloadSchema.parse(PERMISSION_REQUEST).hook_event_name).toBe(
      'PermissionRequest',
    );
    expect(HookPayloadSchema.parse(STOP).hook_event_name).toBe('Stop');
  });

  it('rejects SessionStart / SessionEnd (no longer subscribed per DD #61)', () => {
    expect(() =>
      HookPayloadSchema.parse({
        session_id: SID,
        transcript_path: TX,
        cwd: CWD,
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    ).toThrow();
    expect(() =>
      HookPayloadSchema.parse({
        session_id: SID,
        transcript_path: TX,
        cwd: CWD,
        hook_event_name: 'SessionEnd',
        reason: '/exit',
      }),
    ).toThrow();
  });

  it('rejects unknown hook_event_name', () => {
    expect(() =>
      HookPayloadSchema.parse({ ...STOP, hook_event_name: 'Mystery' }),
    ).toThrow();
  });
});

describe('parseHookPayload (raw JSON entry point)', () => {
  it('parses + validates raw JSON string', () => {
    const parsed = parseHookPayload(JSON.stringify(STOP));
    expect(parsed.hook_event_name).toBe('Stop');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseHookPayload('not-json{{{')).toThrow();
  });

  it('throws on JSON missing required fields', () => {
    expect(() => parseHookPayload(JSON.stringify({ hook_event_name: 'Stop' }))).toThrow();
  });
});
