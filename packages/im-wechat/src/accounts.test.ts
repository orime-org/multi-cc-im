import { describe, it, expect } from 'vitest';
import type { ConfigStore } from '@multi-cc-im/shared';
import { resolveAccount } from './accounts.js';
import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
} from '../lib/ilink/auth/accounts.js';

const stubConfigStore: ConfigStore = {
  load: async () => {
    throw new Error('configStore.load should not be called in v1');
  },
  save: async () => {
    throw new Error('configStore.save should not be called in v1');
  },
};

describe('resolveAccount', () => {
  it('returns the iLink default endpoints for owner-only mode', async () => {
    const acc = await resolveAccount({
      configStore: stubConfigStore,
      token: 'tok-abc',
    });
    expect(acc).toEqual({
      accountId: 'default',
      baseUrl: DEFAULT_BASE_URL,
      cdnBaseUrl: CDN_BASE_URL,
      token: 'tok-abc',
    });
  });

  it('passes the caller-supplied token through verbatim', async () => {
    const acc = await resolveAccount({
      configStore: stubConfigStore,
      token: 'second-token',
    });
    expect(acc.token).toBe('second-token');
  });

  it('does not invoke configStore in v1', async () => {
    let called = false;
    const spy: ConfigStore = {
      load: async () => {
        called = true;
        return { friendly_names: {}, acl: { owners: [] }, external_paths: {} };
      },
      save: async () => {
        called = true;
      },
    };
    await resolveAccount({ configStore: spy, token: 't' });
    expect(called).toBe(false);
  });
});
