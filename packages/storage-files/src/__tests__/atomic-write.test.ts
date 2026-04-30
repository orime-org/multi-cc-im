import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../atomic-write.js';

describe('atomicWrite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcim-aw-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes string content to a new file', async () => {
    const target = join(tmpDir, 'out.txt');
    await atomicWrite(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('writes Uint8Array binary content', async () => {
    const target = join(tmpDir, 'out.bin');
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await atomicWrite(target, data);
    const got = await readFile(target);
    expect(Array.from(got)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('overwrites existing file atomically', async () => {
    const target = join(tmpDir, 'out.txt');
    await writeFile(target, 'old');
    await atomicWrite(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('creates parent directories when missing', async () => {
    const target = join(tmpDir, 'nested', 'deep', 'file.txt');
    await atomicWrite(target, 'hi');
    expect(await readFile(target, 'utf8')).toBe('hi');
  });

  it('does not leave .tmp-* files in target directory', async () => {
    const target = join(tmpDir, 'out.txt');
    await atomicWrite(target, 'hello');
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toEqual([]);
  });

  it('sets restrictive permissions on new file (0600)', async () => {
    const target = join(tmpDir, 'secret.txt');
    await atomicWrite(target, 'sensitive');
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('handles empty string content', async () => {
    const target = join(tmpDir, 'empty.txt');
    await atomicWrite(target, '');
    expect(await readFile(target, 'utf8')).toBe('');
  });
});
