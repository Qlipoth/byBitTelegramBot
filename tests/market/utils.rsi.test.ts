import { describe, expect, it } from 'vitest';

import { calculateRSI } from '../../src/market/analysis.js';

describe('calculateRSI', () => {
  it('возвращает нейтральный RSI (50), когда данных недостаточно', () => {
    expect(calculateRSI([], 14)).toBe(50);
    expect(calculateRSI([100], 14)).toBe(50);
    expect(calculateRSI([100, 101], 14)).toBe(50);
    expect(calculateRSI(new Array(14).fill(100), 14)).toBe(50);
  });

  it('не возвращает NaN/Infinity на типичном ценовом ряде', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const rsi = calculateRSI(prices, 14);
    expect(Number.isFinite(rsi)).toBe(true);
  });

  it('всегда находится в диапазоне [0, 100] для монотонного роста/падения', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);

    const rsiUp = calculateRSI(up, 14);
    const rsiDown = calculateRSI(down, 14);

    expect(rsiUp).toBeGreaterThanOrEqual(0);
    expect(rsiUp).toBeLessThanOrEqual(100);

    expect(rsiDown).toBeGreaterThanOrEqual(0);
    expect(rsiDown).toBeLessThanOrEqual(100);
  });

  it('не падает и возвращает конечное число на плоском (флетовом) ценовом ряде', () => {
    const flat = new Array(40).fill(100);
    const rsi = calculateRSI(flat, 14);
    expect(Number.isFinite(rsi)).toBe(true);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it('обрабатывает длину period + 1 без NaN (регрессия на out-of-bounds)', () => {
    const period = 14;
    const prices = Array.from({ length: period + 1 }, (_, i) => 100 + i);
    const rsi = calculateRSI(prices, period);
    expect(Number.isFinite(rsi)).toBe(true);
  });

  it('обрабатывает резкие ценовые скачки без ошибок', () => {
    const spike = [100, 100, 100, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150];
    const rsi = calculateRSI(spike, 14);
    expect(Number.isFinite(rsi)).toBe(true);
  });

  it('даёт RSI > 50 на росте и RSI < 50 на падении', () => {
    const up = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
    const down = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85];

    expect(calculateRSI(up, 14)).toBeGreaterThan(50);
    expect(calculateRSI(down, 14)).toBeLessThan(50);
  });
});
