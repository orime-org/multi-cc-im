import { describe, it, expect } from 'vitest';
import { resolveAppPaths } from './config-paths.js';

describe('resolveAppPaths', () => {
  it('defaults to ~/.multi-cc-im when MULTI_CC_IM_HOME is unset', () => {
    const paths = resolveAppPaths({ home: '/home/x', env: {} });
    expect(paths.root).toBe('/home/x/.multi-cc-im');
    expect(paths.configToml).toBe('/home/x/.multi-cc-im/config.toml');
    expect(paths.stateDir).toBe('/home/x/.multi-cc-im/state');
    expect(paths.credentialsDir).toBe('/home/x/.multi-cc-im/credentials');
    expect(paths.inboundDir).toBe('/home/x/.multi-cc-im/inbound');
  });

  it('respects MULTI_CC_IM_HOME env override (absolute path)', () => {
    const paths = resolveAppPaths({
      home: '/home/x',
      env: { MULTI_CC_IM_HOME: '/custom/path' },
    });
    expect(paths.root).toBe('/custom/path');
    expect(paths.configToml).toBe('/custom/path/config.toml');
  });

  it('rejects MULTI_CC_IM_HOME relative path (must be absolute)', () => {
    expect(() =>
      resolveAppPaths({
        home: '/home/x',
        env: { MULTI_CC_IM_HOME: 'relative/path' },
      }),
    ).toThrow(/absolute/i);
  });

  it('credentials path for an IM is `<credentialsDir>/<im>.json`', () => {
    const paths = resolveAppPaths({ home: '/home/x', env: {} });
    expect(paths.credentialFor('wechat')).toBe(
      '/home/x/.multi-cc-im/credentials/wechat.json',
    );
    expect(paths.credentialFor('telegram')).toBe(
      '/home/x/.multi-cc-im/credentials/telegram.json',
    );
  });

  it('inbound dir for an IM is `<inboundDir>/<im>`', () => {
    const paths = resolveAppPaths({ home: '/home/x', env: {} });
    expect(paths.inboundFor('wechat')).toBe(
      '/home/x/.multi-cc-im/inbound/wechat',
    );
  });
});
