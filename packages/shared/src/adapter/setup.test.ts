import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdapterSetupSchema, SetupField } from './setup.js';

/**
 * W2 contract test — covers the schema-driven adapter setup interface
 * defined in [DD §10.1 W2](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 *
 * This file is the executable spec for §9.D5 hybrid-pattern: per-field
 * metadata + adapter-level validate callback. W3 (lark schema) and W4
 * (generic wizard) consume these types; if their assumptions about the
 * shape diverge from this test, the test fails first.
 */
describe('AdapterSetupSchema (W2 — D5 hybrid interface)', () => {
  it('field metadata exposes key/label/hint/secret + zod schema for non-secret field', () => {
    const field: SetupField<z.ZodString> = {
      key: 'appId',
      label: 'App ID',
      hint: 'From Feishu Open Platform → Credentials & Basic Info',
      secret: false,
      schema: z.string().min(1).startsWith('cli_'),
    };
    expect(field.key).toBe('appId');
    expect(field.label).toBe('App ID');
    expect(field.hint).toContain('Feishu');
    expect(field.secret).toBe(false);
    expect(field.schema.safeParse('cli_abc').success).toBe(true);
    expect(field.schema.safeParse('xyz').success).toBe(false);
  });

  it('secret flag drives D4-3 mask strategy when set', () => {
    const field: SetupField = {
      key: 'appSecret',
      label: 'App Secret',
      secret: true,
      schema: z.string().min(32),
    };
    expect(field.secret).toBe(true);
    // Field-level zod still works on secret values.
    expect(field.schema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(field.schema.safeParse('short').success).toBe(false);
  });

  it('hint is optional (terse adapters can omit it)', () => {
    const field: SetupField = {
      key: 'token',
      label: 'Token',
      secret: true,
      schema: z.string(),
    };
    expect(field.hint).toBeUndefined();
  });

  it('AdapterSetupSchema bundles id/displayName/fields + optional validate callback', async () => {
    let validateCalled = false;
    const schema: AdapterSetupSchema = {
      id: 'fake',
      displayName: 'Fake / 测试',
      fields: [
        { key: 'k1', label: 'K1', secret: false, schema: z.string() },
        { key: 'k2', label: 'K2', secret: true, schema: z.string() },
      ],
      validate: async (values) => {
        validateCalled = true;
        if (values.k1 !== 'expected') throw new Error('bad k1');
      },
    };
    expect(schema.id).toBe('fake');
    expect(schema.displayName).toBe('Fake / 测试');
    expect(schema.fields).toHaveLength(2);
    expect(schema.fields[0]?.secret).toBe(false);
    expect(schema.fields[1]?.secret).toBe(true);

    await expect(
      schema.validate?.({ k1: 'expected', k2: 'x' }),
    ).resolves.toBeUndefined();
    expect(validateCalled).toBe(true);

    await expect(
      schema.validate?.({ k1: 'wrong', k2: 'x' }),
    ).rejects.toThrow('bad k1');
  });

  it('validate is optional — adapters with no live-API check can omit it', () => {
    const schema: AdapterSetupSchema = {
      id: 'simple',
      displayName: 'Simple',
      fields: [{ key: 'token', label: 'Token', secret: true, schema: z.string() }],
    };
    expect(schema.validate).toBeUndefined();
  });
});
