import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  FriendlyNamesSchema,
  ACLConfigSchema,
  ExternalPathsSchema,
} from '../adapter/storage.js';

describe('FriendlyNamesSchema', () => {
  it('accepts empty record', () => {
    expect(FriendlyNamesSchema.parse({})).toEqual({});
  });

  it('accepts session_id → friendly_name mapping', () => {
    const valid = { 'sid-1': 'web', 'sid-2': 'mobile' };
    expect(FriendlyNamesSchema.parse(valid)).toEqual(valid);
  });

  it('rejects empty friendly name value', () => {
    expect(FriendlyNamesSchema.safeParse({ 'sid-1': '' }).success).toBe(false);
  });

  it('rejects > 64 char friendly name', () => {
    expect(FriendlyNamesSchema.safeParse({ 'sid-1': 'a'.repeat(65) }).success).toBe(false);
  });
});

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

  it('rejects non-string wezterm value', () => {
    expect(ExternalPathsSchema.safeParse({ wezterm: 42 }).success).toBe(false);
  });
});

describe('ConfigSchema', () => {
  it('accepts empty config (all sections default)', () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.friendly_names).toEqual({});
    expect(parsed.acl.owners).toEqual([]);
    expect(parsed.external_paths).toEqual({});
  });

  it('accepts fully populated config', () => {
    const valid = {
      friendly_names: { 'sid-1': 'web' },
      acl: { owners: ['me'] },
      external_paths: { wezterm: '/opt/homebrew/bin/wezterm' },
    };
    const parsed = ConfigSchema.parse(valid);
    expect(parsed.friendly_names['sid-1']).toBe('web');
    expect(parsed.acl.owners).toEqual(['me']);
    expect(parsed.external_paths.wezterm).toBe('/opt/homebrew/bin/wezterm');
  });

  it('rejects malformed friendly_names section', () => {
    expect(
      ConfigSchema.safeParse({
        friendly_names: { 'sid-1': '' }, // empty name
      }).success,
    ).toBe(false);
  });
});
