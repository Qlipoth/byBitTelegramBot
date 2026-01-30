import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';
import type { MarketDelta, MarketPhase, MarketSnapshot } from './types.js';

/**
 * Рассчитывает EMA (Exponential Moving Average)
 * @param prices - массив цен (от старых к новым)
 * @param period - период EMA
 * @returns значение EMA или null если недостаточно данных
 */
export function calculateEMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;

  const multiplier = 2 / (period + 1);

  // SMA для начального значения
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // EMA для остальных значений
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i]! - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Определяет глобальный тренд по EMA(50) vs EMA(200)
 * @param snapshots - массив снапшотов (минимум 200 для надёжности)
 * @returns 'BULLISH' | 'BEARISH' | 'NEUTRAL'
 */
export type GlobalTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export function detectGlobalTrend(snapshots: MarketSnapshot[]): GlobalTrend {
  if (snapshots.length < 200) {
    // Недостаточно данных для надёжного определения
    return 'NEUTRAL';
  }

  const prices = snapshots.map(s => s.price);
  const ema50 = calculateEMA(prices, 50);
  const ema200 = calculateEMA(prices, 200);

  if (ema50 === null || ema200 === null) {
    return 'NEUTRAL';
  }

  // Добавляем небольшой буфер (0.1%) чтобы избежать частых переключений
  const buffer = ema200 * 0.001;

  if (ema50 > ema200 + buffer) {
    return 'BULLISH';
  }

  if (ema50 < ema200 - buffer) {
    return 'BEARISH';
  }

  return 'NEUTRAL';
}

/**
 * Проверяет, разрешён ли вход в указанную сторону по глобальному тренду
 */
export function isTradeAllowedByGlobalTrend(
  globalTrend: GlobalTrend,
  side: 'LONG' | 'SHORT'
): boolean {
  if (globalTrend === 'NEUTRAL') {
    // В нейтральном тренде разрешаем обе стороны (но с осторожностью)
    return true;
  }

  if (globalTrend === 'BULLISH' && side === 'LONG') {
    return true;
  }

  if (globalTrend === 'BEARISH' && side === 'SHORT') {
    return true;
  }

  // Торговля против тренда запрещена
  return false;
}

type PhaseDetectionSettings = {
  moveThreshold: number;
  cvdThreshold: number;
  oiThreshold: number;
  baseMoveThreshold?: number;
  realizedVol?: number;
};

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
  delta5m: MarketDelta;
  cvd30m: number;
  settings: PhaseDetectionSettings;
}): MarketPhase {
  const { delta30m, cvd30m, settings } = params;
  const priceMove30m = Math.abs(delta30m.priceChangePct ?? 0);
  const oiMove30m = Math.abs(delta30m.oiChangePct ?? 0);
  const dataAge = delta30m.minutesAgo ?? 0;

  // 1) Протухшие данные → Range
  if (!Number.isFinite(dataAge) || dataAge >= 45) {
    return 'range';
  }

  // 2) Пустой импульс без набора позиций → Range
  if (
    priceMove30m >= settings.moveThreshold &&
    oiMove30m < settings.oiThreshold * 0.4 &&
    Math.abs(cvd30m) < settings.cvdThreshold * 0.4
  ) {
    return 'range';
  }

  // 3) Сильная дивергенция CVD против движения цены → Range
  const priceSign = Math.sign(delta30m.priceChangePct ?? 0);
  const cvdSign = Math.sign(cvd30m);
  if (
    priceSign !== 0 &&
    cvdSign !== 0 &&
    priceSign !== cvdSign &&
    Math.abs(cvd30m) >= settings.cvdThreshold * 0.8 &&
    priceMove30m >= settings.moveThreshold * 0.8
  ) {
    return 'range';
  }

  return legacyPhaseDetection(params);
}

function legacyPhaseDetection(params: {
  delta30m: MarketDelta;
  delta15m: MarketDelta;
  delta5m: MarketDelta;
  cvd30m: number;
  settings: PhaseDetectionSettings;
}): MarketPhase {
  const { delta30m, delta15m, delta5m, cvd30m, settings } = params;
  const p30 = delta30m.priceChangePct ?? 0;
  const oi30 = delta30m.oiChangePct ?? 0;
  const oi15 = delta15m.oiChangePct ?? 0;
  const p15 = delta15m.priceChangePct ?? 0;
  const p5 = delta5m.priceChangePct ?? 0;
  const trendDirection = Math.sign(p30);

  // --- Re-usable conditions ---
  const hasFreshMomentum =
    (Math.sign(p15) === trendDirection && Math.abs(p15) >= settings.moveThreshold * 0.3) ||
    (Math.sign(p5) === trendDirection && Math.abs(p5) >= settings.moveThreshold * 0.2);

  const isStrongMove = Math.abs(p30) >= settings.moveThreshold;
  const strongOiExpansion = Math.abs(oi30) >= settings.oiThreshold;
  const oiExpansion15m =
    Math.sign(oi15) === Math.sign(oi30) && Math.abs(oi15) >= settings.oiThreshold * 0.6;

  // Stricter CVD Check for Trend
  const cvdConfirmsMove =
    Math.sign(cvd30m) === trendDirection && Math.abs(cvd30m) >= settings.cvdThreshold * 0.7;

  // Looser CVD check for Accumulation/Distribution
  const cvdSupportsMove =
    Math.abs(cvd30m) <= settings.cvdThreshold * 1.2 || Math.sign(cvd30m) === trendDirection;

  // --- Trend Detection ---
  // Score now excludes CVD, which is checked separately and is mandatory for trend.
  const trendScore = [isStrongMove, strongOiExpansion, hasFreshMomentum, oiExpansion15m].filter(
    Boolean
  ).length;

  // New Trend Condition: Strong move, confirmed by both OI and CVD, plus a high score.
  if (
    trendDirection !== 0 &&
    isStrongMove &&
    strongOiExpansion &&
    cvdConfirmsMove &&
    trendScore >= 3
  ) {
    return 'trend';
  }

  // --- Accumulation / Distribution ---
  const momentumOrOi = hasFreshMomentum || oiExpansion15m;
  if (
    Math.abs(p30) < settings.moveThreshold * 0.6 &&
    oi30 >= settings.oiThreshold * 0.7 &&
    (cvd30m > settings.cvdThreshold * 0.6 || (cvdSupportsMove && momentumOrOi))
  ) {
    return 'accumulation';
  }

  if (
    Math.abs(p30) < settings.moveThreshold * 0.6 &&
    oi30 >= settings.oiThreshold * 0.7 &&
    (cvd30m < -settings.cvdThreshold * 0.6 || (!cvdSupportsMove && momentumOrOi))
  ) {
    return 'distribution';
  }

  // --- Blowoff Detection ---
  const isExtremeMove = Math.abs(p30) >= settings.moveThreshold * 0.85;
  const isOiCollapsing = oi15 <= -settings.oiThreshold * 0.7;
  const hasReversal =
    trendDirection !== 0 &&
    Math.sign(p15) === -trendDirection &&
    Math.abs(p15) >= settings.moveThreshold * 0.35;
  const hasSharpPullback =
    trendDirection !== 0 &&
    Math.sign(p5) === -trendDirection &&
    Math.abs(p5) >= settings.moveThreshold * 0.25;

  if (isExtremeMove && isOiCollapsing && (hasReversal || hasSharpPullback)) {
    return 'blowoff';
  }

  return 'range';
}
