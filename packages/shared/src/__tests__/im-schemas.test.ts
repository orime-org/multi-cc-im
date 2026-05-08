import { describe, it, expect } from 'vitest';
import { IMReplyContextSchema } from '../index.js';
import type {
  IMReplyContext,
  IMWechatReplyContext,
  IMTelegramReplyContext,
  IMLarkReplyContext,
} from '../index.js';

describe('IMReplyContextSchema (discriminated union)', () => {
  describe('wechat variant', () => {
    it('accepts canonical wechat ctx with contextToken', () => {
      const valid: IMWechatReplyContext = {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tk-abc123',
      };
      const parsed = IMReplyContextSchema.parse(valid);
      expect(parsed).toEqual(valid);
      // Type narrowing via discriminator
      if (parsed.imType === 'wechat') {
        expect(parsed.to).toBe('wxid_owner');
      }
    });

    it('accepts wechat ctx without contextToken (optional field)', () => {
      const valid: IMWechatReplyContext = {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: undefined,
      };
      expect(IMReplyContextSchema.parse(valid)).toEqual({
        imType: 'wechat',
        to: 'wxid_owner',
      });
    });

    it('rejects wechat ctx missing required `to`', () => {
      expect(
        IMReplyContextSchema.safeParse({
          imType: 'wechat',
          contextToken: 'tk',
        }).success,
      ).toBe(false);
    });
  });

  describe('telegram variant', () => {
    it('accepts canonical telegram ctx', () => {
      const valid: IMTelegramReplyContext = {
        imType: 'telegram',
        chatId: 12345,
        messageId: 678,
      };
      expect(IMReplyContextSchema.parse(valid)).toEqual(valid);
    });

    it('rejects telegram ctx with wrong type for chatId', () => {
      expect(
        IMReplyContextSchema.safeParse({
          imType: 'telegram',
          chatId: 'not-a-number',
          messageId: 678,
        }).success,
      ).toBe(false);
    });
  });

  describe('lark variant', () => {
    it('accepts canonical lark ctx', () => {
      const valid: IMLarkReplyContext = {
        imType: 'lark',
        openId: 'ou_xxx',
        chatId: 'oc_yyy',
      };
      expect(IMReplyContextSchema.parse(valid)).toEqual(valid);
    });
  });

  describe('discriminator enforcement', () => {
    it('rejects unknown imType (defends against newer-daemon-then-older-client read)', () => {
      const future: unknown = {
        imType: 'discord',
        channelId: 999,
      };
      const result = IMReplyContextSchema.safeParse(future);
      expect(result.success).toBe(false);
    });

    it('rejects missing imType discriminator', () => {
      // wechat-shape but no discriminator — pre-DD #61 schema
      const v1: unknown = { to: 'wxid_owner', contextToken: 'tk' };
      expect(IMReplyContextSchema.safeParse(v1).success).toBe(false);
    });

    it('switch on imType after parse narrows correctly (compile-time + runtime)', () => {
      const ctxs: IMReplyContext[] = [
        { imType: 'wechat', to: 'a', contextToken: 'b' },
        { imType: 'telegram', chatId: 1, messageId: 2 },
        { imType: 'lark', openId: 'x', chatId: 'y' },
      ];
      for (const ctx of ctxs) {
        const parsed = IMReplyContextSchema.parse(ctx);
        switch (parsed.imType) {
          case 'wechat':
            expect(parsed.to).toBeTypeOf('string');
            break;
          case 'telegram':
            expect(parsed.chatId).toBeTypeOf('number');
            break;
          case 'lark':
            expect(parsed.openId).toBeTypeOf('string');
            break;
        }
      }
    });
  });
});
