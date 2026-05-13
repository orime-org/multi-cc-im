import { describe, it, expect } from 'vitest';
import {
  SessionIdSchema,
  CwdAbsSchema,
  TranscriptPathSchema,
  PaneIdSchema,
  AttachmentSchema,
  IncomingMessageSchema,
} from '../types.js';

describe('SessionIdSchema', () => {
  it('accepts valid UUID v4', () => {
    const valid = '91215578-3606-4fe4-b01d-c436bf804790';
    expect(SessionIdSchema.parse(valid)).toBe(valid);
  });

  it('rejects non-UUID string', () => {
    expect(SessionIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(SessionIdSchema.safeParse('').success).toBe(false);
  });
});

describe('CwdAbsSchema', () => {
  it('accepts absolute path', () => {
    const valid = '/private/tmp/cc-probe';
    expect(CwdAbsSchema.parse(valid)).toBe(valid);
  });

  it('rejects relative path', () => {
    expect(CwdAbsSchema.safeParse('cc-probe').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(CwdAbsSchema.safeParse('').success).toBe(false);
  });
});

describe('TranscriptPathSchema', () => {
  it('accepts .jsonl absolute path', () => {
    const valid = '/Users/foo/.claude/projects/-tmp/abc.jsonl';
    expect(TranscriptPathSchema.parse(valid)).toBe(valid);
  });

  it('rejects non-jsonl extension', () => {
    expect(TranscriptPathSchema.safeParse('/tmp/abc.txt').success).toBe(false);
  });

  it('rejects relative .jsonl path', () => {
    expect(TranscriptPathSchema.safeParse('rel.jsonl').success).toBe(false);
  });
});

describe('PaneIdSchema', () => {
  it('accepts non-negative integer', () => {
    expect(PaneIdSchema.parse(20)).toBe(20);
    expect(PaneIdSchema.parse(0)).toBe(0);
  });

  it('rejects negative number', () => {
    expect(PaneIdSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects non-integer number', () => {
    expect(PaneIdSchema.safeParse(1.5).success).toBe(false);
  });

  it('accepts non-empty string (iTerm2 UUID-style pane id)', () => {
    // Per [DD: iTerm2 adapter §8](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
    // iTerm2's stable pane id is the UUID suffix of ITERM_SESSION_ID
    // (e.g. "C3D91F33-3805-47E2-A3F6-B8AED6EC2209"). The schema accepts any
    // non-empty string; the detector is responsible for shape correctness.
    expect(PaneIdSchema.parse('C3D91F33-3805-47E2-A3F6-B8AED6EC2209')).toBe(
      'C3D91F33-3805-47E2-A3F6-B8AED6EC2209',
    );
    expect(PaneIdSchema.parse('any-non-empty')).toBe('any-non-empty');
  });

  it('rejects empty string', () => {
    expect(PaneIdSchema.safeParse('').success).toBe(false);
  });
});

describe('AttachmentSchema', () => {
  it('accepts valid image attachment with mimetype', () => {
    const valid = { kind: 'image', localPath: '/tmp/img.png', mimetype: 'image/png' };
    const parsed = AttachmentSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('accepts attachment without mimetype (optional)', () => {
    const valid = { kind: 'file', localPath: '/tmp/x.pdf' };
    const parsed = AttachmentSchema.parse(valid);
    expect(parsed.kind).toBe('file');
    expect(parsed.mimetype).toBeUndefined();
  });

  it('rejects unknown kind', () => {
    expect(
      AttachmentSchema.safeParse({ kind: 'unknown', localPath: '/tmp/x' }).success,
    ).toBe(false);
  });

  it('rejects missing localPath', () => {
    expect(
      AttachmentSchema.safeParse({ kind: 'image' }).success,
    ).toBe(false);
  });
});

describe('IncomingMessageSchema', () => {
  const baseValid = {
    msgId: 'msg-1',
    from: 'user1',
    text: 'hello',
    attachments: [],
    timestamp: 1700000000000,
    replyCtx: {
      imType: 'lark' as const,
      openId: 'ou_xxx',
      chatId: 'oc_yyy',
    },
  };

  it('accepts text-only message', () => {
    expect(IncomingMessageSchema.parse(baseValid)).toEqual(baseValid);
  });

  it('accepts attachment-only message (text=null)', () => {
    const v = {
      ...baseValid,
      text: null,
      attachments: [{ kind: 'image' as const, localPath: '/tmp/x.png' }],
    };
    const parsed = IncomingMessageSchema.parse(v);
    expect(parsed.text).toBeNull();
    expect(parsed.attachments).toHaveLength(1);
  });

  it('defaults attachments to empty array if omitted', () => {
    const { attachments: _, ...withoutAttachments } = baseValid;
    const parsed = IncomingMessageSchema.parse(withoutAttachments);
    expect(parsed.attachments).toEqual([]);
  });

  it('rejects missing msgId', () => {
    const { msgId: _, ...invalid } = baseValid;
    expect(IncomingMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    const invalid = { ...baseValid, timestamp: '2024-01-01' };
    expect(IncomingMessageSchema.safeParse(invalid).success).toBe(false);
  });
});
