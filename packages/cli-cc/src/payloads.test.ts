import { describe, it, expect } from 'vitest';
import {
  SessionStartPayloadSchema,
  StopPayloadSchema,
  SessionEndPayloadSchema,
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

const STOP = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
};

const SESSION_END = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionEnd',
  reason: '/exit',
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

describe('SessionEndPayloadSchema', () => {
  it('accepts the H1 verified schema verbatim', () => {
    expect(SessionEndPayloadSchema.parse(SESSION_END).reason).toBe('/exit');
  });

  it('accepts open-enum reason values (logout / clear / etc.)', () => {
    expect(
      SessionEndPayloadSchema.parse({ ...SESSION_END, reason: 'logout' }).reason,
    ).toBe('logout');
  });
});

describe('HookPayloadSchema (discriminated union)', () => {
  it('discriminates the 3 events by hook_event_name', () => {
    expect(HookPayloadSchema.parse(SESSION_START).hook_event_name).toBe('SessionStart');
    expect(HookPayloadSchema.parse(STOP).hook_event_name).toBe('Stop');
    expect(HookPayloadSchema.parse(SESSION_END).hook_event_name).toBe('SessionEnd');
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
