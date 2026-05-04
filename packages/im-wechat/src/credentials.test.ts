import { describe, it, expect } from 'vitest';
import { WeixinCredentialsSchema } from './credentials.js';

describe('WeixinCredentialsSchema', () => {
  it('accepts a minimal valid credentials object', () => {
    const parsed = WeixinCredentialsSchema.parse({ token: 'tok-abc' });
    expect(parsed).toEqual({ token: 'tok-abc' });
  });

  it('accepts credentials with optional savedAt', () => {
    const parsed = WeixinCredentialsSchema.parse({
      token: 'tok-abc',
      savedAt: '2026-05-04T00:00:00Z',
    });
    expect(parsed.savedAt).toBe('2026-05-04T00:00:00Z');
  });

  it('rejects empty token', () => {
    expect(() =>
      WeixinCredentialsSchema.parse({ token: '' }),
    ).toThrow();
  });

  it('rejects missing token', () => {
    expect(() =>
      WeixinCredentialsSchema.parse({} as unknown),
    ).toThrow();
  });

  it('rejects non-string token', () => {
    expect(() =>
      WeixinCredentialsSchema.parse({ token: 123 } as unknown),
    ).toThrow();
  });
});
