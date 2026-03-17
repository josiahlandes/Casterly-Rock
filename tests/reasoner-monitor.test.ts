import { describe, expect, it } from 'vitest';
import { detectStall } from '../src/dual-loop/reasoner-monitor.js';

describe('detectStall', () => {
  it('returns false when under threshold', () => {
    expect(detectStall(5, 10, false)).toBe(false);
  });

  it('returns true when at threshold', () => {
    expect(detectStall(10, 10, false)).toBe(true);
  });

  it('returns true when over threshold', () => {
    expect(detectStall(15, 10, false)).toBe(true);
  });

  it('triggers earlier when loop detected (half threshold)', () => {
    // Without loop: 5 < 10 → no stall
    expect(detectStall(5, 10, false)).toBe(false);
    // With loop: 5 >= floor(10/2) = 5 → stall
    expect(detectStall(5, 10, true)).toBe(true);
  });

  it('does not trigger loop shortcut below half threshold', () => {
    expect(detectStall(4, 10, true)).toBe(false);
  });

  it('handles threshold of 1', () => {
    expect(detectStall(1, 1, false)).toBe(true);
    expect(detectStall(0, 1, false)).toBe(false);
  });

  it('handles loop detected with threshold of 2', () => {
    // floor(2/2) = 1
    expect(detectStall(1, 2, true)).toBe(true);
    expect(detectStall(0, 2, true)).toBe(false);
  });
});
