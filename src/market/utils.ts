import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';

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
    return '📈 Бычий тренд';
  }

  if (deltaBase.priceChangePct < -PRICE_CHANGE && deltaBase.oiChangePct > OI_CHANGE) {
    return '📉 Медвежий тренд';
  }

  if (
    Math.abs(deltaBase.priceChangePct) < ACCUMULATION_PRICE_BAND &&
    deltaBase.oiChangePct > OI_CHANGE
  ) {
    return '🧠 Фаза накопления';
  }

  return '😐 Флэт / неопределённость';
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
export function formatFundingRate(rate: number | undefined): string {
  const safeRate = rate ?? 0;
  return `${(Math.abs(safeRate) * 100).toFixed(4)}% (${safeRate > 0 ? 'Longs' : 'Shorts'} pay)`;
}

export function getSnapshotsInWindow(snaps: any[], minutes: number) {
  return snaps.filter(s => Date.now() - s.timestamp <= minutes * 60_000);
}
