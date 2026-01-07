import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';
import type { MarketDelta, MarketPhase } from './types.js';

export function detectTrend(deltaBase: {
  priceChangePct: number;
  oiChangePct: number;
  symbol?: string;
}) {
  const { PRICE_CHANGE, OI_CHANGE, ACCUMULATION_PRICE_BAND } = deltaBase.symbol
    ? getTrendThresholds(deltaBase.symbol)
    : TREND_THRESHOLDS;

  if (deltaBase.priceChangePct > PRICE_CHANGE && deltaBase.oiChangePct > OI_CHANGE) {
    debugger;
    return { label: '📈 Бычий тренд', isBull: true, isBear: false };
  }

  if (deltaBase.priceChangePct < -PRICE_CHANGE && deltaBase.oiChangePct > OI_CHANGE) {
    debugger;
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
  // IMPORTANT: iterate over deltas/gains length to avoid out-of-bounds reads (NaN RSI)
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
  }

  // Avoid division by zero
  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Number.isFinite(rsi) ? rsi : 50;
}

export function calculatePriceChanges(prices: number[]): number[] {
  if (!prices.length) {
    return [];
  }

  return prices.slice(1).map((price, i) => ((price - prices[i]!) / prices[i]!) * 100);
}

export function detectMarketPhase(params: {
  delta30m: MarketDelta;
  delta15m: MarketDelta;
  cvd30m: number;
  settings: { moveThreshold: number; cvdThreshold: number; oiThreshold: number };
}): MarketPhase {
  const { delta30m, delta15m, cvd30m, settings } = params;
  const p30 = delta30m.priceChangePct;
  const oi30 = delta30m.oiChangePct;
  const oi15 = delta15m.oiChangePct;
  const cvdSupportsMove =
    Math.abs(cvd30m) < settings.cvdThreshold || Math.sign(p30) === Math.sign(cvd30m);

  // 1️⃣ ТРЕНД (Используем moveThreshold из настроек)
  // Для BTC это будет 0.5%, для щитка 2.0%
  if (
    Math.abs(p30) >= settings.moveThreshold &&
    Math.abs(oi30) >= settings.oiThreshold &&
    cvdSupportsMove
  ) {
    return 'trend';
  }

  // 2️⃣ НАКОПЛЕНИЕ (Accumulation)
  // Цена стоит (меньше порога), но OI растет + CVD выше порога монеты
  if (
    Math.abs(p30) < settings.moveThreshold * 0.5 &&
    oi30 > settings.oiThreshold &&
    cvd30m > settings.cvdThreshold
  ) {
    return 'accumulation';
  }

  // 3️⃣ РАСПРЕДЕЛЕНИЕ (Distribution)
  if (
    Math.abs(p30) < settings.moveThreshold * 0.5 &&
    oi30 > settings.oiThreshold &&
    cvd30m < -settings.cvdThreshold
  ) {
    return 'distribution';
  }

  // 4️⃣ КУЛЬМИНАЦИЯ / ВЫХОД
  // Цена уже пробила или почти пробила порог тренда, но OI начал резко сокращаться
  const isExtremeMove = Math.abs(p30) >= settings.moveThreshold * 0.9;
  const isOiCollapsing = oi15 <= -settings.oiThreshold;

  if (isExtremeMove && isOiCollapsing) {
    return 'blowoff';
  }

  return 'range';
}
