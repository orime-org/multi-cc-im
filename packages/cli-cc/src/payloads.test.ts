import { describe, it, expect } from 'vitest';
import {
  SessionStartPayloadSchema,
  UserPromptSubmitPayloadSchema,
  PreToolUsePayloadSchema,
  PostToolUsePayloadSchema,
  StopPayloadSchema,
  HookPayloadSchema,
  parseHookPayload,
} from './payloads.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

const SESSION_START = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-4-7[1m]',
};

const USER_PROMPT_SUBMIT = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'UserPromptSubmit',
  permission_mode: 'default',
  prompt: '你好，回我 hi',
};

const PRE_TOOL_USE = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'tool-abc',
};

const POST_TOOL_USE = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PostToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_response: {
    stdout: 'foo\n',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
  tool_use_id: 'tool-abc',
  duration_ms: 42,
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

describe('SessionStartPayloadSchema', () => {
  it('accepts the H1 verified schema verbatim', () => {
    expect(SessionStartPayloadSchema.parse(SESSION_START).source).toBe('startup');
  });

  it('rejects missing session_id', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, session_id: undefined }),
    ).toThrow();
  });

  it('rejects malformed UUID for session_id', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, session_id: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects non-absolute cwd (cc always gives realpath)', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, cwd: 'relative/path' }),
    ).toThrow();
  });

  it('rejects transcript_path not ending in .jsonl', () => {
    expect(() =>
      SessionStartPayloadSchema.parse({ ...SESSION_START, transcript_path: '/tmp/x.txt' }),
    ).toThrow();
  });
});

describe('UserPromptSubmitPayloadSchema', () => {
  it('accepts the H1 verified schema verbatim', () => {
    expect(UserPromptSubmitPayloadSchema.parse(USER_PROMPT_SUBMIT).prompt).toBe(
      '你好，回我 hi',
    );
  });

  it('preserves Unicode + emoji + newlines in prompt', () => {
    const payload = {
      ...USER_PROMPT_SUBMIT,
      prompt: '多行\n第二行 ✨ probe',
    };
    expect(UserPromptSubmitPayloadSchema.parse(payload).prompt).toBe(
      '多行\n第二行 ✨ probe',
    );
  });
});

describe('PreToolUsePayloadSchema / PostToolUsePayloadSchema', () => {
  it('PreToolUse accepts the H1 verified schema', () => {
    expect(PreToolUsePayloadSchema.parse(PRE_TOOL_USE).tool_name).toBe('Bash');
  });

  it('PostToolUse accepts tool_response with all 5 boolean/string fields', () => {
    const parsed = PostToolUsePayloadSchema.parse(POST_TOOL_USE);
    expect(parsed.tool_response.stdout).toBe('foo\n');
    expect(parsed.tool_response.interrupted).toBe(false);
    expect(parsed.duration_ms).toBe(42);
  });

  it('PostToolUse rejects missing duration_ms', () => {
    const { duration_ms: _, ...rest } = POST_TOOL_USE;
    void _;
    expect(() => PostToolUsePayloadSchema.parse(rest)).toThrow();
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
});

describe('HookPayloadSchema (discriminated union)', () => {
  it('discriminates all 5 events by hook_event_name', () => {
    expect(HookPayloadSchema.parse(SESSION_START).hook_event_name).toBe('SessionStart');
    expect(HookPayloadSchema.parse(USER_PROMPT_SUBMIT).hook_event_name).toBe(
      'UserPromptSubmit',
    );
    expect(HookPayloadSchema.parse(PRE_TOOL_USE).hook_event_name).toBe('PreToolUse');
    expect(HookPayloadSchema.parse(POST_TOOL_USE).hook_event_name).toBe('PostToolUse');
    expect(HookPayloadSchema.parse(STOP).hook_event_name).toBe('Stop');
  });

  it('rejects unknown hook_event_name', () => {
    expect(() =>
      HookPayloadSchema.parse({ ...SESSION_START, hook_event_name: 'Mystery' }),
    ).toThrow();
  });
});

describe('parseHookPayload (raw JSON entry point)', () => {
  it('parses + validates raw JSON string', () => {
    const parsed = parseHookPayload(JSON.stringify(SESSION_START));
    expect(parsed.hook_event_name).toBe('SessionStart');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseHookPayload('not-json{{{')).toThrow();
  });

  it('throws on JSON missing required fields', () => {
    expect(() => parseHookPayload(JSON.stringify({ hook_event_name: 'Stop' }))).toThrow();
  });
});
