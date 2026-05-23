import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterSetupSchema } from '@multi-cc-im/shared';
import { runWizard } from './run-wizard.js';
import type {
  WizardPromptIO,
  WizardTextPromptOpts,
  WizardPasswordPromptOpts,
  WizardConfirmPromptOpts,
} from './io.js';

/**
 * Sentinel symbol stand-in for clack's cancel — wizard treats anything
 * the IO's `isCancel` accepts as a cancel marker.
 */
const CANCEL = Symbol('clack.cancel');

interface PromptCall {
  method: 'text' | 'password' | 'confirm';
  opts:
    | WizardTextPromptOpts
    | WizardPasswordPromptOpts
    | WizardConfirmPromptOpts;
}

interface ScriptedResponse {
  method: 'text' | 'password' | 'confirm';
  value: string | boolean | symbol;
}

/**
 * Build a `WizardPromptIO` that scripts text/password/confirm responses
 * in order. Records every prompt call so tests can assert on the
 * options actually passed (e.g. masked placeholder for secret fields).
 */
function makeScriptedIO(scripted: readonly ScriptedResponse[]): {
  io: WizardPromptIO;
  calls: PromptCall[];
  intros: string[];
  outros: string[];
  errors: string[];
  messages: string[];
} {
  const calls: PromptCall[] = [];
  const remaining = [...scripted];
  const intros: string[] = [];
  const outros: string[] = [];
  const errors: string[] = [];
  const messages: string[] = [];

  function take(method: PromptCall['method']) {
    const next = remaining.shift();
    if (!next) {
      throw new Error(
        `scripted IO exhausted: wizard called ${method} but no more responses`,
      );
    }
    if (next.method !== method) {
      throw new Error(
        `scripted IO mismatch: expected next call to be ${next.method} but wizard called ${method}`,
      );
    }
    return next.value;
  }

  return {
    calls,
    intros,
    outros,
    errors,
    messages,
    io: {
      intro: (msg) => intros.push(msg),
      outro: (msg) => outros.push(msg),
      info: vi.fn(),
      error: (msg) => errors.push(msg),
      message: (msg) => messages.push(msg),
      text: async (opts) => {
        calls.push({ method: 'text', opts });
        return take('text') as string | symbol;
      },
      password: async (opts) => {
        calls.push({ method: 'password', opts });
        return take('password') as string | symbol;
      },
      confirm: async (opts) => {
        calls.push({ method: 'confirm', opts });
        return take('confirm') as boolean | symbol;
      },
      select: async () => {
        throw new Error('runWizard tests do not exercise select; selector tests do');
      },
      multiselect: async () => {
        throw new Error(
          'runWizard tests do not exercise multiselect; cli-selector tests do',
        );
      },
      isCancel: (v): v is symbol => v === CANCEL,
    },
  };
}

const fakeSchema: AdapterSetupSchema = {
  id: 'fake',
  displayName: 'Fake / 测试',
  fields: [
    {
      key: 'appId',
      label: 'App ID',
      hint: 'starts with cli_',
      secret: false,
      schema: z.string().trim().min(1).startsWith('cli_'),
    },
    {
      key: 'appSecret',
      label: 'App Secret',
      hint: 'long random string',
      secret: true,
      schema: z.string().trim().min(1),
    },
  ],
};

describe('runWizard (W4)', () => {
  it('happy path — non-secret + secret field, all valid → completed with values', async () => {
    const { io } = makeScriptedIO([
      { method: 'text', value: 'cli_abc123' },
      { method: 'password', value: 'sec_xyz' },
    ]);
    const result = await runWizard({ schema: fakeSchema, io });
    expect(result).toEqual({
      status: 'completed',
      values: { appId: 'cli_abc123', appSecret: 'sec_xyz' },
    });
  });

  it('renders intro using schema displayName', async () => {
    const { io, intros } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    expect(intros[0]).toContain('Fake / 测试');
  });

  it('non-secret field uses text prompt', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    expect(calls[0]?.method).toBe('text');
    expect(calls[0]?.opts.message).toContain('App ID');
  });

  it('secret field uses password prompt (no echo)', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    expect(calls[1]?.method).toBe('password');
    expect(calls[1]?.opts.message).toContain('App Secret');
  });

  it('field hint is rendered in the prompt message', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    expect(calls[0]?.opts.message).toContain('starts with cli_');
    expect(calls[1]?.opts.message).toContain('long random string');
  });

  it('cancel mid-prompt → wizard returns { status: cancelled } without persisting', async () => {
    const { io, outros } = makeScriptedIO([
      { method: 'text', value: CANCEL },
    ]);
    const result = await runWizard({ schema: fakeSchema, io });
    expect(result).toEqual({ status: 'cancelled' });
    expect(outros[0]?.toLowerCase()).toContain('cancel');
  });

  it('non-secret field with existing value → text prompt gets defaultValue + placeholder showing existing', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: '' },  // empty Enter — keep
      { method: 'password', value: 'newsecret' },
    ]);
    const result = await runWizard({
      schema: fakeSchema,
      io,
      existing: { appId: 'cli_existing' },
    });
    const textOpts = calls[0]?.opts as WizardTextPromptOpts;
    expect(textOpts.defaultValue).toBe('cli_existing');
    expect(textOpts.placeholder).toBe('cli_existing');
    expect(result).toEqual({
      status: 'completed',
      values: { appId: 'cli_existing', appSecret: 'newsecret' },
    });
  });

  it('secret field with existing value → message contains AWS-style mask + empty Enter keeps existing', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_new' },
      { method: 'password', value: '' },  // empty Enter — keep secret
    ]);
    const existingSecret = 'cli_a1b2c3d4e5f6g7h8WXYZ';
    const result = await runWizard({
      schema: fakeSchema,
      io,
      existing: { appSecret: existingSecret },
    });
    const passwordOpts = calls[1]?.opts as WizardPasswordPromptOpts;
    expect(passwordOpts.message).toContain('****************WXYZ');
    expect(result).toEqual({
      status: 'completed',
      values: { appId: 'cli_new', appSecret: existingSecret },
    });
  });

  it('per-field zod validation: text validate callback rejects bad input + accepts valid input', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    const textOpts = calls[0]?.opts as WizardTextPromptOpts;
    // missing cli_ prefix → returns error message
    expect(textOpts.validate?.('not_cli_prefixed')).toBeTruthy();
    // valid input → undefined (no error)
    expect(textOpts.validate?.('cli_valid')).toBeUndefined();
  });

  it('per-field zod validation: password validate rejects empty + accepts non-empty', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    const passwordOpts = calls[1]?.opts as WizardPasswordPromptOpts;
    expect(passwordOpts.validate?.('')).toBeTruthy();
    expect(passwordOpts.validate?.('any-non-empty')).toBeUndefined();
  });

  it('password validate accepts empty input when existing value is present (means keep existing)', async () => {
    const { io, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: '' },
    ]);
    await runWizard({
      schema: fakeSchema,
      io,
      existing: { appSecret: 'existing-secret-value' },
    });
    const passwordOpts = calls[1]?.opts as WizardPasswordPromptOpts;
    expect(passwordOpts.validate?.('')).toBeUndefined();
    expect(passwordOpts.validate?.(undefined)).toBeUndefined();
  });

  it('adapter-level validate failure → error logged + retry confirm shown; yes restarts loop', async () => {
    let attempt = 0;
    const schema: AdapterSetupSchema = {
      ...fakeSchema,
      validate: async () => {
        attempt++;
        if (attempt === 1) throw new Error('Feishu rejected: app id not exist');
        // succeed on second attempt
      },
    };
    const { io, errors } = makeScriptedIO([
      // attempt 1
      { method: 'text', value: 'cli_a' },
      { method: 'password', value: 's1' },
      { method: 'confirm', value: true },  // retry yes
      // attempt 2
      { method: 'text', value: 'cli_b' },
      { method: 'password', value: 's2' },
    ]);
    const result = await runWizard({ schema, io });
    expect(attempt).toBe(2);
    expect(errors[0]).toContain('app id not exist');
    expect(result).toEqual({
      status: 'completed',
      values: { appId: 'cli_b', appSecret: 's2' },
    });
  });

  it('adapter-level validate failure → retry no → returns cancelled', async () => {
    const schema: AdapterSetupSchema = {
      ...fakeSchema,
      validate: async () => {
        throw new Error('still bad');
      },
    };
    const { io } = makeScriptedIO([
      { method: 'text', value: 'cli_a' },
      { method: 'password', value: 's1' },
      { method: 'confirm', value: false },  // retry no
    ]);
    const result = await runWizard({ schema, io });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('adapter-level validate failure → retry confirm cancelled (Ctrl-C) → returns cancelled', async () => {
    const schema: AdapterSetupSchema = {
      ...fakeSchema,
      validate: async () => {
        throw new Error('bad');
      },
    };
    const { io } = makeScriptedIO([
      { method: 'text', value: 'cli_a' },
      { method: 'password', value: 's1' },
      { method: 'confirm', value: CANCEL },
    ]);
    const result = await runWizard({ schema, io });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('guide option: pre-rendered guide is printed via io.message before first field prompt (W6)', async () => {
    const { io, messages, calls } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({
      schema: fakeSchema,
      io,
      guide: '<rendered guide text>',
    });
    expect(messages).toEqual(['<rendered guide text>']);
    // Guide must precede the first prompt
    expect(calls.length).toBe(2);
  });

  it('guide option absent: io.message never called', async () => {
    const { io, messages } = makeScriptedIO([
      { method: 'text', value: 'cli_abc' },
      { method: 'password', value: 's' },
    ]);
    await runWizard({ schema: fakeSchema, io });
    expect(messages).toEqual([]);
  });

  it('completed wizard does NOT mutate schema or existing values', async () => {
    const existing = { appId: 'cli_old' };
    const { io } = makeScriptedIO([
      { method: 'text', value: '' },  // keep existing
      { method: 'password', value: 'newsec' },
    ]);
    await runWizard({ schema: fakeSchema, io, existing });
    expect(existing).toEqual({ appId: 'cli_old' });
    expect(fakeSchema.fields).toHaveLength(2);
  });
});
