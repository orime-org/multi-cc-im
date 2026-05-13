import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  ACLConfigSchema,
  ExternalPathsSchema,
} from '../adapter/storage.js';

describe('ACLConfigSchema', () => {
  it('accepts empty owners', () => {
    expect(ACLConfigSchema.parse({}).owners).toEqual([]);
  });

  it('accepts owners list', () => {
    const valid = { owners: ['user1', 'user2'] };
    expect(ACLConfigSchema.parse(valid)).toEqual(valid);
  });

  it('defaults owners to empty array when omitted', () => {
    expect(ACLConfigSchema.parse({}).owners).toEqual([]);
  });

  it('rejects non-string owner entry', () => {
    expect(ACLConfigSchema.safeParse({ owners: [42] }).success).toBe(false);
  });
});

describe('ExternalPathsSchema', () => {
  it('accepts empty object (all paths optional)', () => {
    expect(ExternalPathsSchema.parse({})).toEqual({});
  });

  it('accepts wezterm path', () => {
    const valid = { wezterm: '/opt/homebrew/bin/wezterm' };
    expect(ExternalPathsSchema.parse(valid)).toEqual(valid);
  });

  it('accepts both wezterm and claude paths', () => {
    const valid = {
      wezterm: '/opt/homebrew/bin/wezterm',
      claude: '/Users/x/.local/bin/claude',
    };
    expect(ExternalPathsSchema.parse(valid)).toEqual(valid);
  });

  it('accepts python3 path (iTerm2 adapter prerequisite)', () => {
    // Per [DD: iTerm2 adapter](../../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
    // when user picks iterm2 the daemon caches `python3` binary path so
    // every hook subprocess re-uses it without rediscovery.
    const valid = { python3: '/opt/homebrew/bin/python3' };
    expect(ExternalPathsSchema.parse(valid)).toEqual(valid);
  });

  it('accepts all three paths together', () => {
    const valid = {
      wezterm: '/opt/homebrew/bin/wezterm',
      claude: '/Users/x/.local/bin/claude',
      python3: '/opt/homebrew/bin/python3',
    };
    expect(ExternalPathsSchema.parse(valid)).toEqual(valid);
  });

  it('rejects non-string wezterm value', () => {
    expect(ExternalPathsSchema.safeParse({ wezterm: 42 }).success).toBe(false);
  });

  it('rejects non-string python3 value', () => {
    expect(ExternalPathsSchema.safeParse({ python3: 42 }).success).toBe(false);
  });
});

describe('ConfigSchema', () => {
  it('accepts empty config (all sections default)', () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.acl.owners).toEqual([]);
    expect(parsed.external_paths).toEqual({});
  });

  it('accepts fully populated config', () => {
    const valid = {
      acl: { owners: ['me'] },
      external_paths: { wezterm: '/opt/homebrew/bin/wezterm' },
    };
    const parsed = ConfigSchema.parse(valid);
    expect(parsed.acl.owners).toEqual(['me']);
    expect(parsed.external_paths.wezterm).toBe('/opt/homebrew/bin/wezterm');
  });

  it('ignores unknown top-level keys (zod default permissive)', () => {
    const parsed = ConfigSchema.parse({ unknown: 'ignored', acl: { owners: [] } });
    expect(parsed.acl.owners).toEqual([]);
  });
});
