import { describe, expect, it } from 'vitest';

import { calculateRSI } from '../../src/market/utils.js';

describe('calculateRSI', () => {
  it('returns neutral RSI (50) when not enough data', () => {
    expect(calculateRSI([], 14)).toBe(50);
    expect(calculateRSI([100], 14)).toBe(50);
    expect(calculateRSI([100, 101], 14)).toBe(50);
    expect(calculateRSI(new Array(14).fill(100), 14)).toBe(50);
  });

  it('never returns NaN/Infinity for a typical price series', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const rsi = calculateRSI(prices, 14);
    expect(Number.isFinite(rsi)).toBe(true);
  });

  it('stays within [0, 100] bounds for monotonic up/down series', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);

    const rsiUp = calculateRSI(up, 14);
    const rsiDown = calculateRSI(down, 14);

    expect(rsiUp).toBeGreaterThanOrEqual(0);
    expect(rsiUp).toBeLessThanOrEqual(100);

    expect(rsiDown).toBeGreaterThanOrEqual(0);
    expect(rsiDown).toBeLessThanOrEqual(100);
  });

  it('does not throw and returns finite number for flat price series', () => {
    const flat = new Array(40).fill(100);
    const rsi = calculateRSI(flat, 14);
    expect(Number.isFinite(rsi)).toBe(true);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it('handles edge length exactly period + 1 without NaN (regression for out-of-bounds)', () => {
    const period = 14;
    const prices = Array.from({ length: period + 1 }, (_, i) => 100 + i);
    const rsi = calculateRSI(prices, period);
    expect(Number.isFinite(rsi)).toBe(true);
  });
});
