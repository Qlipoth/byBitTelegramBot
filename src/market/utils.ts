import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';
import type { Delta, ImpulseThresholds } from './types.js';

interface EntryScores {
  longScore: number;
  shortScore: number;
  entrySignal: string;
}

// =====================
// Trend detection (STRUCTURE, not impulse)
// =====================
export function detectTrend(deltaBase: {
  priceChangePct: number;
  oiChangePct: number;
  symbol?: string;
}) {
  const { PRICE_CHANGE, OI_CHANGE, ACCUMULATION_PRICE_BAND } = deltaBase.symbol
    ? getTrendThresholds(deltaBase.symbol)
    : TREND_THRESHOLDS;

  if (deltaBase.priceChangePct > PRICE_CHANGE && deltaBase.oiChangePct > OI_CHANGE) {
    return { label: '📈 Бычий тренд', isBull: true, isBear: false };
  }

  if (deltaBase.priceChangePct < -PRICE_CHANGE && deltaBase.oiChangePct > OI_CHANGE) {
    return { label: '📉 Медвежий тренд', isBull: false, isBear: true };
  }

  if (
    Math.abs(deltaBase.priceChangePct) < ACCUMULATION_PRICE_BAND &&
    deltaBase.oiChangePct > OI_CHANGE
  ) {
    return { label: '🧠 Фаза накопления', isBull: false, isBear: false };
  }

  return { label: '😐 Флэт / неопределённость', isBull: false, isBear: false };
}

export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1 || prices.length < 2) {
    return 50; // Not enough data, return neutral RSI
  }

  // Get the relevant price data
  const deltas = [];
  for (let i = 1; i < prices.length; i++) {
    const curr = prices[i]!;
    const prev = prices[i - 1]!;
    deltas.push(curr - prev);
  }

  // Separate gains and losses
  const gains = deltas.map(delta => (delta > 0 ? delta : 0));
  const losses = deltas.map(delta => (delta < 0 ? Math.abs(delta) : 0));

  // Calculate average gains and losses
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Calculate RS and RSI
  for (let i = period; i < prices.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
  }

  // Avoid division by zero
  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculatePriceChanges(prices: number[]): number[] {
  if (!prices.length) {
    return [];
  }

  return prices.slice(1).map((price, i) => ((price - prices[i]!) / prices[i]!) * 100);
}

/**
 * Formats funding rate into a human-readable string
 * @param rate - Funding rate (e.g., 0.0001 for 0.01%)
 * @returns Formatted string with percentage and who pays (e.g., "0.0250% (Longs pay)")
 */
export function formatFundingRate(rate?: number): string {
  const safeRate = rate ?? 0;

  console.log(rate, safeRate);

  if (safeRate > 0) {
    return `${(safeRate * 100).toFixed(4)}% (Лонги платят шортам)`;
  }

  if (safeRate < 0) {
    return `${(safeRate * 100).toFixed(4)}% (Шорты платят лонгам)`;
  }

  return `0.0000% (Нейтрально)`;
}

export function calculateEntryScores({
  state,
  delta,
  delta15m,
  delta30m,
  snap,
  cvd3m,
  cvd15m,
  rsi,
  impulse,
  isBull,
  isBear,
}: {
  state: any;
  delta: any;
  delta15m: any;
  delta30m: any;
  snap: any;
  cvd3m: number;
  cvd15m: number;
  rsi: number;

  impulse: any;
  isBull: boolean;
  isBear: boolean;
}): EntryScores {
  let longScore = 0;
  let shortScore = 0;

  // 1. Market phase (reduced weight)
  if (state.phase === 'accumulation') longScore += 10;
  if (state.phase === 'distribution') shortScore += 10;

  if (state.flags?.accumulationStrong) longScore += 5;
  if (state.flags?.distributionStrong) shortScore += 5;

  // 2. OI dynamics (logarithmic)
  const oi30 = delta30m?.oiChangePct || 0;
  const oi15 = delta15m?.oiChangePct || 0;

  longScore += Math.min(Math.log1p(Math.max(oi30, 0)) * 8, 15);
  longScore += Math.min(Math.log1p(Math.max(oi15, 0)) * 6, 12);
  shortScore += Math.min(Math.log1p(Math.max(-oi30, 0)) * 8, 15);
  shortScore += Math.min(Math.log1p(Math.max(-oi15, 0)) * 6, 12);

  // 3. Funding (contrarian)
  if ((snap.fundingRate ?? 0) < 0) longScore += 6;
  if ((snap.fundingRate ?? 0) > 0) shortScore += 6;

  // 4. CVD strength (normalized)
  const cvdNorm15 = Math.sign(cvd15m) * Math.min(Math.abs(cvd15m) / 20000, 1);
  const cvdNorm3 = Math.sign(cvd3m) * Math.min(Math.abs(cvd3m) / 10000, 1);

  longScore += Math.max(cvdNorm15 * 15, 0);
  longScore += Math.max(cvdNorm3 * 8, 0);
  shortScore += Math.max(-cvdNorm15 * 15, 0);
  shortScore += Math.max(-cvdNorm3 * 8, 0);

  // 5. 1m impulse
  if (delta?.priceChangePct > impulse?.PRICE_SURGE_PCT) longScore += 10;
  if (delta?.priceChangePct < -(impulse?.PRICE_SURGE_PCT || 0)) shortScore += 10;

  if (delta?.volumeChangePct > impulse?.VOLUME_SPIKE_PCT) longScore += 8;
  if (delta?.volumeChangePct < -(impulse?.VOLUME_SPIKE_PCT || 0)) shortScore += 8;

  if ((delta?.oiChangePct || 0) > 0) longScore += 5;
  if ((delta?.oiChangePct || 0) < 0) shortScore += 5;

  // 6. RSI (clear zones)
  if (rsi > 55) longScore += 8;
  if (rsi < 45) shortScore += 8;

  // 7. Trend strength
  if (isBull) longScore += 12;
  if (isBear) shortScore += 12;

  // Final normalization
  longScore = Math.min(100, Math.max(0, longScore));
  shortScore = Math.min(100, Math.max(0, shortScore));

  let entrySignal = `⚪ Нет четкого тренда (LONG ${Math.round(longScore)}/100 vs SHORT ${Math.round(shortScore)}/100)`;

  if (longScore >= 70 && longScore - shortScore >= 12) {
    entrySignal = `🟢 Сильный LONG (${Math.round(longScore)}/100)`;
  } else if (shortScore >= 70 && shortScore - longScore >= 12) {
    entrySignal = `🔴 Сильный SHORT (${Math.round(shortScore)}/100)`;
  }

  return {
    longScore,
    shortScore,
    entrySignal,
  };
}

export function getSignalAgreement({
  longScore,
  shortScore,
  isRange,
  pricePercentChange,
  moveThreshold,
  cvd15m,
  cvdThreshold,
  fundingRate,
}: {
  longScore: number;
  shortScore: number;
  isRange: boolean;
  pricePercentChange: number;
  moveThreshold: number;
  cvd15m: number;
  cvdThreshold: number;
  fundingRate: number;
}) {
  // ❌ Глобальные блокировки
  if (isRange) return 'NONE';
  if (Math.abs(pricePercentChange) < moveThreshold) return 'NONE';

  // 🟢 LONG
  if (
    longScore >= 70 &&
    longScore - shortScore >= 12 &&
    cvd15m > cvdThreshold &&
    fundingRate <= 0
  ) {
    return 'LONG';
  }

  // 🔴 SHORT
  if (
    shortScore >= 70 &&
    shortScore - longScore >= 12 &&
    cvd15m < -cvdThreshold &&
    fundingRate >= 0
  ) {
    return 'SHORT';
  }

  return 'NONE';
}

export function confirmEntry({
  signal,
  delta,
  cvd3m,
  impulse,
}: {
  signal: 'LONG' | 'SHORT';
  delta: Delta;
  cvd3m: number;
  impulse: ImpulseThresholds;
}): boolean {
  if (!delta || !impulse || cvd3m === undefined) {
    return false;
  }

  if (signal === 'LONG') {
    return (
      delta.priceChangePct > impulse.PRICE_SURGE_PCT &&
      delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
      cvd3m > 0
    );
  }

  if (signal === 'SHORT') {
    return (
      delta.priceChangePct < -impulse.PRICE_SURGE_PCT &&
      delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
      cvd3m < 0
    );
  }

  return false;
}
