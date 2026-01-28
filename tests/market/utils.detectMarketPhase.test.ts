import { describe, expect, it } from 'vitest';
import { detectMarketPhase } from '../../src/market/analysis.js';
import type { MarketDelta } from '../../src/market/types.js';

const baseSettings = {
  moveThreshold: 1,
  cvdThreshold: 2000,
  oiThreshold: 0.5,
};

const baseDelta: MarketDelta = {
  priceChangePct: 0,
  oiChangePct: 0,
  fundingChange: 0,
  minutesAgo: 0,
};

const makeDelta = (overrides: Partial<MarketDelta> = {}): MarketDelta => ({
  ...baseDelta,
  ...overrides,
});

const buildPhaseParams = (
  overrides: Partial<{
    delta30m: MarketDelta;
    delta15m: MarketDelta;
    delta5m: MarketDelta;
    cvd30m: number;
  }> = {}
) => ({
  delta30m: overrides.delta30m ?? makeDelta(),
  delta15m: overrides.delta15m ?? makeDelta(),
  delta5m: overrides.delta5m ?? makeDelta(),
  cvd30m: overrides.cvd30m ?? 0,
  settings: baseSettings,
});

describe('detectMarketPhase', () => {
  it('detects trend when price and OI exceed thresholds', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 1.2, oiChangePct: 0.6 }),
        delta15m: makeDelta({ priceChangePct: 0.5 }),
        delta5m: makeDelta({ priceChangePct: 0.4 }),
        cvd30m: baseSettings.cvdThreshold,
      })
    );

    expect(phase).toBe('trend');
  });

  it('detects accumulation when price flat, OI rising and cvd positive', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 0.3, oiChangePct: 0.7 }),
        cvd30m: 3000,
      })
    );

    expect(phase).toBe('accumulation');
  });

  it('detects distribution when cvd negative with flat price and rising OI', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 0.3, oiChangePct: 0.7 }),
        cvd30m: -3000,
      })
    );

    expect(phase).toBe('distribution');
  });

  it('detects blowoff when price spikes and OI collapses', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 0.95 }),
        delta15m: makeDelta({ oiChangePct: -0.6, priceChangePct: -0.5 }),
        delta5m: makeDelta({ priceChangePct: -0.4 }),
      })
    );

    expect(phase).toBe('blowoff');
  });

  it('defaults to range when no other condition matches', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 0.2, oiChangePct: 0.1 }),
        delta15m: makeDelta({ oiChangePct: 0.1 }),
      })
    );

    expect(phase).toBe('range');
  });
  // Проверка шортового тренда (чтобы логика не была заточена только на лонг)
  it('detects trend for short direction (price down, OI up)', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: -1.5, oiChangePct: 0.8 }),
        delta15m: makeDelta({ priceChangePct: -0.5 }),
        delta5m: makeDelta({ priceChangePct: -0.3 }),
        cvd30m: -baseSettings.cvdThreshold,
      })
    );
    expect(phase).toBe('trend');
  });

  // 2️⃣ Тест на "Ложный пробой" (Цена летит, но ликвидности/денег нет)
  it('stays in range if price moves but OI does not follow', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 2.0, oiChangePct: 0.1 }),
        delta15m: makeDelta({ oiChangePct: 0.05 }),
        cvd30m: 100,
      })
    );
    // Мы не хотим заходить в тренд, если это пустой прострел без набора позиций
    expect(phase).toBe('range');
  });

  // 3️⃣ Тест на Дивергенцию (Цена растет, а CVD сильно давит вниз)
  it('detects range/noise when price and CVD diverge strongly', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 1.5, oiChangePct: 0.7 }),
        cvd30m: -5000,
      })
    );
    // Это классический признак "скрытых продаж", опасно считать это чистым трендом
    expect(phase).toBe('range');
  });

  it('handles missing or zero delta gracefully', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 0, oiChangePct: 0 }),
      })
    );
    expect(phase).toBe('range');
  });

  // Тест на "Выжженную землю" (Нулевые или NaN данные)
  it('returns range for invalid or zero data', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: NaN, oiChangePct: 0 }),
      })
    );
    expect(phase).toBe('range');
  });

  // Тест на очень старые данные (Stale Data)
  it('returns range if data is too old', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({ priceChangePct: 2.0, minutesAgo: 60 }),
        cvd30m: 5000,
      })
    );
    // Если данные протухли, фаза не может считаться актуальной
    expect(phase).toBe('range');
  });
  // Проверка граничных условий (Boundary Testing)
  it('handles values exactly at the threshold', () => {
    const phase = detectMarketPhase(
      buildPhaseParams({
        delta30m: makeDelta({
          priceChangePct: baseSettings.moveThreshold,
          oiChangePct: baseSettings.oiThreshold,
        }),
        delta15m: makeDelta({ priceChangePct: baseSettings.moveThreshold * 0.35 }),
        cvd30m: baseSettings.cvdThreshold,
      })
    );
    // Проверяем, включительно у нас работают пороги или нет
    expect(phase).toBe('trend');
  });
});
