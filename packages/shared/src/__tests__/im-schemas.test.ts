import { describe, it, expect } from 'vitest';
import { IMReplyContextSchema } from '../index.js';
import type {
  IMReplyContext,
  IMTelegramReplyContext,
  IMLarkReplyContext,
} from '../index.js';

describe('IMReplyContextSchema (discriminated union)', () => {
  describe('lark variant', () => {
    it('accepts canonical lark ctx', () => {
      const valid: IMLarkReplyContext = {
        imType: 'lark',
        openId: 'ou_xxx',
        chatId: 'oc_yyy',
      };
      const parsed = IMReplyContextSchema.parse(valid);
      expect(parsed).toEqual(valid);
      // Type narrowing via discriminator
      if (parsed.imType === 'lark') {
        expect(parsed.openId).toBe('ou_xxx');
        expect(parsed.chatId).toBe('oc_yyy');
      }
    });

    it('rejects lark ctx missing required openId', () => {
      expect(
        IMReplyContextSchema.safeParse({
          imType: 'lark',
          chatId: 'oc_yyy',
        }).success,
      ).toBe(false);
    });

    it('rejects lark ctx with wrong type for chatId', () => {
      expect(
        IMReplyContextSchema.safeParse({
          imType: 'lark',
          openId: 'ou_xxx',
          chatId: 12345,
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
      const v1: unknown = { openId: 'ou_x', chatId: 'oc_y' };
      expect(IMReplyContextSchema.safeParse(v1).success).toBe(false);
    });

    it('rejects retired imType=wechat (purged in DD #86 §11.2)', () => {
      const legacyWechat: unknown = {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tk-x',
      };
      const result = IMReplyContextSchema.safeParse(legacyWechat);
      expect(result.success).toBe(false);
    });

    it('switch on imType after parse narrows correctly (compile-time + runtime)', () => {
      const ctxs: IMReplyContext[] = [
        { imType: 'lark', openId: 'x', chatId: 'y' },
        { imType: 'telegram', chatId: 1, messageId: 2 },
      ];
      for (const ctx of ctxs) {
        const parsed = IMReplyContextSchema.parse(ctx);
        switch (parsed.imType) {
          case 'lark':
            expect(parsed.openId).toBeTypeOf('string');
            break;
          case 'telegram':
            expect(parsed.chatId).toBeTypeOf('number');
            break;
        }
      }
    });
  });
});
