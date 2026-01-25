import { getTrendThresholds, TREND_THRESHOLDS } from './constants.market.js';
import type { MarketDelta, MarketPhase, MarketSnapshot } from './types.js';

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

// export function detectMarketPhase(params: {
//   delta30m: MarketDelta;
//   delta15m: MarketDelta;
//   delta5m: MarketDelta;
//   cvd30m: number;
//   settings: PhaseDetectionSettings;
// }): MarketPhase {
//   const { delta30m, delta15m, delta5m, cvd30m, settings } = params;
//   const p30 = delta30m.priceChangePct;
//   const oi30 = delta30m.oiChangePct;
//   const oi15 = delta15m.oiChangePct;
//   const p15 = delta15m.priceChangePct;
//   const p5 = delta5m.priceChangePct;
//   const trendDirection = Math.sign(p30);
//   const hasFreshMomentum =
//     (Math.sign(p15) === trendDirection && Math.abs(p15) >= settings.moveThreshold * 0.3) ||
//     (Math.sign(p5) === trendDirection && Math.abs(p5) >= settings.moveThreshold * 0.2);
//   const cvdSupportsMove =
//     Math.abs(cvd30m) <= settings.cvdThreshold * 1.2 || Math.sign(cvd30m) === trendDirection;
//
//   const isStrongMove = Math.abs(p30) >= settings.moveThreshold;
//   const moveOvershoot = Math.abs(p30) >= settings.moveThreshold * 1.35;
//   const strongOiExpansion = Math.abs(oi30) >= settings.oiThreshold;
//   const oiExpansion15m =
//     Math.sign(oi15) === Math.sign(oi30) && Math.abs(oi15) >= settings.oiThreshold * 0.6;
//   const momentumOrOi = hasFreshMomentum || oiExpansion15m;
//   const trendScore = [
//     isStrongMove,
//     strongOiExpansion,
//     cvdSupportsMove,
//     hasFreshMomentum,
//     oiExpansion15m,
//   ].filter(Boolean).length;
//
//   // 1️⃣ ТРЕНД (Используем moveThreshold из настроек)
//   // Для BTC это будет 0.5%, для щитка 2.0%
//   if (
//     trendDirection !== 0 &&
//     ((isStrongMove && trendScore >= 3) || (moveOvershoot && trendScore >= 2))
//   ) {
//     return 'trend';
//   }
//
//   // 2️⃣ НАКОПЛЕНИЕ (Accumulation)
//   // Цена стоит (меньше порога), но OI растет + CVD выше порога монеты
//   if (
//     Math.abs(p30) < settings.moveThreshold * 0.6 &&
//     oi30 >= settings.oiThreshold * 0.7 &&
//     (cvd30m > settings.cvdThreshold * 0.6 || (cvdSupportsMove && momentumOrOi))
//   ) {
//     return 'accumulation';
//   }
//
//   // 3️⃣ РАСПРЕДЕЛЕНИЕ (Distribution)
//   if (
//     Math.abs(p30) < settings.moveThreshold * 0.6 &&
//     oi30 >= settings.oiThreshold * 0.7 &&
//     (cvd30m < -settings.cvdThreshold * 0.6 || (!cvdSupportsMove && momentumOrOi))
//   ) {
//     return 'distribution';
//   }
//
//   // 4️⃣ КУЛЬМИНАЦИЯ / ВЫХОД
//   // Цена уже пробила или почти пробила порог тренда, но OI начал резко сокращаться
//   const isExtremeMove = Math.abs(p30) >= settings.moveThreshold * 0.85;
//   const isOiCollapsing = oi15 <= -settings.oiThreshold * 0.7;
//   const hasReversal =
//     trendDirection !== 0 &&
//     Math.sign(p15) === -trendDirection &&
//     Math.abs(p15) >= settings.moveThreshold * 0.35;
//   const hasSharpPullback =
//     trendDirection !== 0 &&
//     Math.sign(p5) === -trendDirection &&
//     Math.abs(p5) >= settings.moveThreshold * 0.25;
//
//   if (isExtremeMove && isOiCollapsing && (hasReversal || hasSharpPullback)) {
//     return 'blowoff';
//   }
//
//   return 'range';
// }

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

  const hasFreshMomentum =
    (Math.sign(p15) === trendDirection && Math.abs(p15) >= settings.moveThreshold * 0.3) ||
    (Math.sign(p5) === trendDirection && Math.abs(p5) >= settings.moveThreshold * 0.2);
  const cvdSupportsMove =
    Math.abs(cvd30m) <= settings.cvdThreshold * 1.2 || Math.sign(cvd30m) === trendDirection;

  const isStrongMove = Math.abs(p30) >= settings.moveThreshold;
  const moveOvershoot = Math.abs(p30) >= settings.moveThreshold * 1.35;
  const strongOiExpansion = Math.abs(oi30) >= settings.oiThreshold;
  const oiExpansion15m =
    Math.sign(oi15) === Math.sign(oi30) && Math.abs(oi15) >= settings.oiThreshold * 0.6;
  const momentumOrOi = hasFreshMomentum || oiExpansion15m;
  const trendScore = [
    isStrongMove,
    strongOiExpansion,
    cvdSupportsMove,
    hasFreshMomentum,
    oiExpansion15m,
  ].filter(Boolean).length;

  if (
    trendDirection !== 0 &&
    ((isStrongMove && trendScore >= 3) || (moveOvershoot && trendScore >= 2))
  ) {
    return 'trend';
  }

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
