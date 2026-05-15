import { describe, it, expect } from 'vitest';
import { ErrorRingBuffer, relativeTime } from './metrics.js';

describe('ErrorRingBuffer', () => {
  it('starts empty', () => {
    const buf = new ErrorRingBuffer();
    expect(buf.size()).toBe(0);
    expect(buf.snapshot()).toEqual([]);
  });

  it('push appends with deterministic timestamp from injected now', () => {
    const buf = new ErrorRingBuffer({ now: () => '2026-05-15T00:00:00.000Z' });
    buf.push('phase-a', 'first error');
    expect(buf.snapshot()).toEqual([
      {
        timestamp: '2026-05-15T00:00:00.000Z',
        phase: 'phase-a',
        message: 'first error',
      },
    ]);
  });

  it('preserves FIFO order — newest at end', () => {
    let i = 0;
    const buf = new ErrorRingBuffer({ now: () => `t${i++}` });
    buf.push('p', 'a');
    buf.push('p', 'b');
    buf.push('p', 'c');
    expect(buf.snapshot().map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('drops oldest when over capacity', () => {
    let i = 0;
    const buf = new ErrorRingBuffer({
      capacity: 3,
      now: () => `t${i++}`,
    });
    buf.push('p', 'a');
    buf.push('p', 'b');
    buf.push('p', 'c');
    buf.push('p', 'd');
    buf.push('p', 'e');
    expect(buf.size()).toBe(3);
    expect(buf.snapshot().map((e) => e.message)).toEqual(['c', 'd', 'e']);
  });

  it('clamps capacity to at least 1', () => {
    // Per source: `Math.max(1, opts.capacity ?? 200)`. Useful invariant
    // so callers passing 0 / negative don't accidentally disable the
    // buffer (which would be a memory-leak-shaped surprise vs no-op).
    const buf = new ErrorRingBuffer({ capacity: 0 });
    buf.push('p', 'only');
    expect(buf.size()).toBe(1);
  });

  it('clear empties the buffer', () => {
    const buf = new ErrorRingBuffer();
    buf.push('p', 'a');
    buf.push('p', 'b');
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.snapshot()).toEqual([]);
  });

  it('snapshot returns a defensive copy', () => {
    const buf = new ErrorRingBuffer();
    buf.push('p', 'a');
    const s = buf.snapshot();
    s.push({ timestamp: 'fake', phase: 'fake', message: 'fake' });
    // Mutating snapshot must not touch the internal buffer.
    expect(buf.size()).toBe(1);
  });
});

describe('relativeTime', () => {
  const ref = new Date('2026-05-15T12:00:00.000Z');

  it('< 60s → "Ns ago"', () => {
    expect(relativeTime('2026-05-15T11:59:30.000Z', ref)).toBe('30s ago');
  });

  it('< 60m → "Nm ago"', () => {
    expect(relativeTime('2026-05-15T11:55:00.000Z', ref)).toBe('5m ago');
  });

  it('< 24h → "Nh ago"', () => {
    expect(relativeTime('2026-05-15T09:00:00.000Z', ref)).toBe('3h ago');
  });

  it('≥ 24h → "Nd ago"', () => {
    expect(relativeTime('2026-05-13T12:00:00.000Z', ref)).toBe('2d ago');
  });

  it('future timestamp → "in the future"', () => {
    expect(relativeTime('2026-05-15T13:00:00.000Z', ref)).toBe('in the future');
  });

  it('accepts Date input', () => {
    const past = new Date('2026-05-15T11:55:30.000Z');
    expect(relativeTime(past, ref)).toBe('4m ago');
  });
});
