import { describe, it, expect } from 'vitest';
import type { ConfigStore, CredentialStore } from '@multi-cc-im/shared';
import { resolveAccount } from './accounts.js';
import type { WeixinCredentials } from './credentials.js';
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

function stubCredentialStore(
  state: WeixinCredentials | null,
): CredentialStore<WeixinCredentials> {
  return {
    load: async () => state,
    save: async () => {},
    delete: async () => {},
  };
}

describe('resolveAccount', () => {
  it('returns the iLink default endpoints when credentials present', async () => {
    const acc = await resolveAccount({
      configStore: stubConfigStore,
      credentialStore: stubCredentialStore({ token: 'tok-abc' }),
    });
    expect(acc).toEqual({
      accountId: 'default',
      baseUrl: DEFAULT_BASE_URL,
      cdnBaseUrl: CDN_BASE_URL,
      token: 'tok-abc',
    });
  });

  it('passes the persisted token through verbatim', async () => {
    const acc = await resolveAccount({
      configStore: stubConfigStore,
      credentialStore: stubCredentialStore({ token: 'second-token' }),
    });
    expect(acc.token).toBe('second-token');
  });

  it('throws when credentialStore.load() returns null (not yet logged in)', async () => {
    await expect(
      resolveAccount({
        configStore: stubConfigStore,
        credentialStore: stubCredentialStore(null),
      }),
    ).rejects.toThrow(/credentials not found.*login wechat/i);
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
    await resolveAccount({
      configStore: spy,
      credentialStore: stubCredentialStore({ token: 't' }),
    });
    expect(called).toBe(false);
  });
});
