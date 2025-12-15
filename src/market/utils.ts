import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';
import type {
  ConfirmEntryParams,
  EntryScores,
  EntryScoresParams,
  MarketDelta,
  MarketPhase,
  SignalAgreementParams,
} from './types.js';

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
}: EntryScoresParams): EntryScores {
  let longScore = 0;
  let shortScore = 0;

  /* =====================
   1️⃣ Phase (max 15)
  ===================== */
  if (state.phase === 'accumulation') longScore += 15;
  if (state.phase === 'range') {
    longScore += 5;
    shortScore += 5;
  }

  /* =====================
   2️⃣ OI dynamics (max 25)
   ===================== */
  const oi30 = delta30m?.oiChangePct ?? 0;
  const oi15 = delta15m?.oiChangePct ?? 0;

  const oiLong = Math.log1p(Math.max(oi30, 0)) * 10 + Math.log1p(Math.max(oi15, 0)) * 5;

  const oiShort = Math.log1p(Math.max(-oi30, 0)) * 10 + Math.log1p(Math.max(-oi15, 0)) * 5;

  longScore += Math.min(oiLong, 25);
  shortScore += Math.min(oiShort, 25);

  /* =====================
   3️⃣ Funding (max 10, contrarian)
   ===================== */
  if ((snap.fundingRate ?? 0) < 0) longScore += 10;
  if ((snap.fundingRate ?? 0) > 0) shortScore += 10;

  /* =====================
   4️⃣ CVD strength (max 25)
   ===================== */
  const cvd15Norm = Math.min(Math.abs(cvd15m) / 20000, 1);
  const cvd3Norm = Math.min(Math.abs(cvd3m) / 10000, 1);

  if (cvd15m > 0) longScore += cvd15Norm * 15;
  if (cvd15m < 0) shortScore += cvd15Norm * 15;

  if (cvd3m > 0) longScore += cvd3Norm * 10;
  if (cvd3m < 0) shortScore += cvd3Norm * 10;

  /* =====================
   5️⃣ 1m impulse (max 15)
   ===================== */
  if (delta?.priceChangePct > impulse.PRICE_SURGE_PCT) longScore += 15;
  if (delta?.priceChangePct < -impulse.PRICE_SURGE_PCT) shortScore += 15;

  /* =====================
   6️⃣ RSI (max 10)
   ===================== */
  if (rsi > 55) longScore += 10;
  if (rsi < 45) shortScore += 10;

  /* =====================
   7️⃣ Soft trend bonus (max 5)
   ===================== */
  if (isBull) longScore += 5;
  if (isBear) shortScore += 5;

  // Clamp
  longScore = Math.min(100, Math.round(longScore));
  shortScore = Math.min(100, Math.round(shortScore));

  /* =====================
   🎯 Signal decision
   ===================== */
  let entrySignal = `⚪ Нет сетапа (LONG ${longScore}/100 vs SHORT ${shortScore}/100)`;

  if (longScore >= 65 && longScore - shortScore >= 10) {
    entrySignal = `🟢 LONG SETUP (${longScore}/100)`;
  } else if (shortScore >= 65 && shortScore - longScore >= 10) {
    entrySignal = `🔴 SHORT SETUP (${shortScore}/100)`;
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
  phase,
  pricePercentChange,
  moveThreshold,
  cvd15m,
  cvdThreshold,
  fundingRate,
}: SignalAgreementParams) {
  // ❌ Глобальные блокировки
  if (phase === 'range') return 'NONE';
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

export function confirmEntry({ signal, delta, cvd3m, impulse }: ConfirmEntryParams): boolean {
  if (!delta || !impulse || cvd3m === undefined) {
    return false;
  }
  if (signal === 'LONG') {
    return delta.priceChangePct > impulse.PRICE_SURGE_PCT && cvd3m > 0;
  }
  if (signal === 'SHORT') {
    return delta.priceChangePct < -impulse.PRICE_SURGE_PCT && cvd3m < 0;
  }
  return false;
}

export function detectMarketPhase(delta30m: MarketDelta): MarketPhase {
  // тренд
  if (Math.abs(delta30m.priceChangePct) > 2 && delta30m.oiChangePct > 0) {
    return 'trend';
  }

  // накопление (лонги)
  if (delta30m.oiChangePct > 4 && delta30m.priceChangePct > -1 && delta30m.priceChangePct < 1) {
    return 'accumulation';
  }

  // распределение (шорты)
  if (delta30m.oiChangePct < -4 && delta30m.priceChangePct > -1 && delta30m.priceChangePct < 1) {
    return 'distribution';
  }

  return 'range';
}
