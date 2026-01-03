import { getTrendThresholds, MIN_SCORE, SYMBOLS, TREND_THRESHOLDS } from './constants.market.js';
import type {
  ConfirmEntryParams,
  EntryScores,
  EntryScoresParams,
  MarketDelta,
  MarketPhase,
  SignalAgreementParams,
  SymbolValue,
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
  delta5m,
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

  // Объект для отладки (поможет понять, почему Score именно такой)
  const details = { phase: 0, oi: 0, funding: 0, cvd: 0, impulse: 0, rsi: 0, trend: 0 };

  /* =====================
   1️⃣ Phase (max 15)
  ===================== */
  if (state.phase === 'blowoff') {
    // В фазе кульминации обнуляем баллы, чтобы не зайти на "хаях"
    return {
      longScore: 0,
      shortScore: 0,
      entrySignal: `🚫 BLOWOFF (Опасность разворота)`,
    };
  }
  // Убираем бонус за Range. Range — это отсутствие сетапа.
  if (state.phase === 'accumulation') {
    longScore += 15;
    details.phase = 15;
  } else if (state.phase === 'distribution') {
    shortScore += 15;
    details.phase = 15;
  } else if (state.phase === 'trend') {
    // В тренде тоже даем очки, если направление совпадает
    if (isBull) longScore += 15;
    if (isBear) shortScore += 15;
    details.phase = 15;
  }

  /* =====================
   2️⃣ OI dynamics (max 25)
  ===================== */
  const oi30 = delta30m?.oiChangePct ?? 0;
  const oi15 = delta15m?.oiChangePct ?? 0;

  // ФИКС "Начала сессии": Если данных за 30м еще мало, не дублируем веса
  const isDataMature = (delta30m?.minutesAgo ?? 0) >= 15;

  // Используем log1p, но с поправкой на зрелость данных
  const oiLong =
    (isDataMature ? Math.log1p(Math.max(oi30, 0)) * 10 : 0) + Math.log1p(Math.max(oi15, 0)) * 10; // Увеличил вес 15м, если 30м еще нет

  const oiShort =
    (isDataMature ? Math.log1p(Math.max(-oi30, 0)) * 10 : 0) + Math.log1p(Math.max(-oi15, 0)) * 10;

  longScore += Math.min(oiLong, 25);
  shortScore += Math.min(oiShort, 25);
  details.oi = Math.round(Math.max(oiLong, oiShort));

  /* =====================
   3️⃣ Funding (max 10, contrarian)
  ===================== */
  const fRate = snap.fundingRate ?? 0;
  if (fRate < -0.0001) {
    longScore += 10;
    details.funding = 10;
  } // Отрицательный фандинг - топливо для Лонга
  if (fRate > 0.0001) {
    shortScore += 10;
    details.funding = 10;
  } // Положительный - для Шорта

  /* =====================
   4️⃣ CVD strength (max 25)
  ===================== */
  // Адаптируем под твой новый MIN_CVD_THRESHOLD: 1500
  // Снизил пороги нормализации (было 7000/3000), чтобы легче набирать баллы
  const cvd15Norm = Math.min(Math.abs(cvd15m) / 5000, 1);
  const cvd3Norm = Math.min(Math.abs(cvd3m) / 2000, 1);

  if (cvd15m > 0) longScore += cvd15Norm * 15;
  if (cvd15m < 0) shortScore += cvd15Norm * 15;

  if (cvd3m > 0) longScore += cvd3Norm * 10;
  if (cvd3m < 0) shortScore += cvd3Norm * 10;
  details.cvd = Math.round(cvd15Norm * 15 + cvd3Norm * 10);

  /* =====================
   5️⃣ Impulse & Velocity (max 15)
  ===================== */
  const price1m = delta?.priceChangePct ?? 0;
  const price5m = delta5m?.priceChangePct ?? 0;

  // 1m Impulse
  if (price1m > impulse.PRICE_SURGE_PCT) longScore += 7;
  if (price1m < -impulse.PRICE_SURGE_PCT) shortScore += 7;

  // Velocity: Если 5-минутка — это взрыв (большая часть 15-минутки произошла за 5 минут)
  const isVelocityLong = price5m > 0 && price5m > (delta15m?.priceChangePct ?? 0) * 0.7;
  const isVelocityShort = price5m < 0 && price5m < (delta15m?.priceChangePct ?? 0) * 0.7;

  if (isVelocityLong) longScore += 8;
  if (isVelocityShort) shortScore += 8;
  details.impulse = isVelocityLong || isVelocityShort ? 15 : 7;

  /* =====================
   6️⃣ RSI (max 10)
  ===================== */
  // Вернул зоны 55/45 (было 60/40), чтобы чаще ловить движения
  if (rsi >= 55) longScore += 10;
  if (rsi <= 45) shortScore += 10;
  details.rsi = rsi >= 55 || rsi <= 45 ? 10 : 0;

  /* =====================
   7️⃣ Soft trend bonus (max 5)
  ===================== */
  if (isBull) longScore += 5;
  if (isBear) shortScore += 5;
  details.trend = 5;

  // Clamp
  longScore = Math.min(100, Math.round(longScore));
  shortScore = Math.min(100, Math.round(shortScore));

  /* =====================
   🎯 Signal decision
  ===================== */
  // Порог 65 — хорошо, но добавим проверку на минимальный перевес
  let entrySignal = `⚪ Нет сетапа (L:${longScore} S:${shortScore})`;

  if (longScore >= MIN_SCORE && longScore) {
    entrySignal = `🟢 LONG SETUP (${longScore}/100)`;
  } else if (shortScore >= MIN_SCORE && shortScore) {
    entrySignal = `🔴 SHORT SETUP (${shortScore}/100)`;
  }

  return {
    longScore,
    shortScore,
    entrySignal,
    details, // Returning debug details
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
  rsi,
}: SignalAgreementParams) {
  // 1️⃣ Блокировка при кульминации
  if (phase === 'blowoff') {
    console.log(`[SIGNAL_AGREEMENT] Blowoff phase detected, returning NONE`);
    return 'NONE';
  }

  // =====================
  // 2️⃣ TREND CONTINUATION ENTRY (ПЕРВЫМ!)
  // =====================
  if (phase === 'trend') {
    // LONG continuation
    if (
      longScore >= 60 &&
      longScore - shortScore >= 10 &&
      rsi >= 55 &&
      cvd15m > 0 &&
      fundingRate <= 0.0002
    ) {
      console.log(`[SIGNAL_AGREEMENT] TREND CONTINUATION LONG`);
      return 'LONG';
    }

    // SHORT continuation
    if (
      shortScore >= 60 &&
      shortScore - longScore >= 10 &&
      rsi <= 45 &&
      cvd15m < 0 &&
      fundingRate >= -0.0002
    ) {
      console.log(`[SIGNAL_AGREEMENT] TREND CONTINUATION SHORT`);
      return 'SHORT';
    }
  }

  // =====================
  // 3️⃣ BREAKOUT / EXPANSION ENTRY
  // =====================
  if (phase === 'trend' || phase === 'accumulation' || phase === 'distribution') {
    if (Math.abs(pricePercentChange) < moveThreshold) {
      console.log(
        `[SIGNAL_AGREEMENT] Price change ${pricePercentChange}% < moveThreshold ${moveThreshold}%, returning NONE`
      );
      return 'NONE';
    }

    if (
      longScore >= MIN_SCORE + 3 &&
      longScore - shortScore >= 12 &&
      cvd15m > cvdThreshold &&
      fundingRate <= 0.0001
    ) {
      console.log(`[SIGNAL_AGREEMENT] BREAKOUT LONG`);
      return 'LONG';
    }

    if (
      shortScore >= MIN_SCORE + 3 &&
      shortScore - longScore >= 12 &&
      cvd15m < -cvdThreshold &&
      fundingRate >= -0.0001
    ) {
      console.log(`[SIGNAL_AGREEMENT] BREAKOUT SHORT`);
      return 'SHORT';
    }
  }

  // =====================
  // 4️⃣ RANGE
  // =====================
  if (phase === 'range') {
    if (
      longScore >= MIN_SCORE + 5 &&
      longScore - shortScore >= 20 &&
      rsi >= 55 &&
      cvd15m > 0
    ) {
      console.log(`[SIGNAL_AGREEMENT] RANGE LONG`);
      return 'LONG';
    }

    if (
      shortScore >= MIN_SCORE + 5 &&
      shortScore - longScore >= 20 &&
      rsi <= 45 &&
      cvd15m < 0
    ) {
      console.log(`[SIGNAL_AGREEMENT] RANGE SHORT`);
      return 'SHORT';
    }
  }

  console.log(
    `[SIGNAL_AGREEMENT] No signal matched: phase=${phase}, longScore=${longScore}, shortScore=${shortScore}`
  );
  return 'NONE';
}

export function confirmEntry({
  signal,
  delta,
  cvd3m,
  impulse,
  phase,
}: ConfirmEntryParams): boolean {
  if (!delta || !impulse || cvd3m === undefined) {
    console.log(
      `[CONFIRM_ENTRY] Missing required data: delta=${!!delta}, impulse=${!!impulse}, cvd3m=${cvd3m}`
    );
    return false;
  }

  const pChange = delta.priceChangePct;
  const minMove = impulse.PRICE_SURGE_PCT * 0.4;

  // Если мы в ТРЕНДЕ — подтверждаем через импульс (как и было)
  if (phase === 'trend') {
    if (signal === 'LONG') {
      const confirmed = pChange > impulse.PRICE_SURGE_PCT && cvd3m > 0;
      console.log(
        `[CONFIRM_ENTRY] TREND LONG check: pChange=${pChange} > ${impulse.PRICE_SURGE_PCT} && cvd3m=${cvd3m} > 0 => ${confirmed}`
      );
      return confirmed;
    }
    if (signal === 'SHORT') {
      const confirmed = pChange < -impulse.PRICE_SURGE_PCT && cvd3m < 0;
      console.log(
        `[CONFIRM_ENTRY] TREND SHORT check: pChange=${pChange} < -${impulse.PRICE_SURGE_PCT} && cvd3m=${cvd3m} < 0 => ${confirmed}`
      );
      return confirmed;
    }
  }

  // Если мы в НАКОПЛЕНИИ или ФЛЕТЕ — подтверждение должно быть мягче,
  // так как мы ловим самое начало движения или отскок.
  if (phase === 'accumulation' || phase === 'distribution' || phase === 'range') {
    if (signal === 'LONG') {
      const confirmed = pChange > minMove && cvd3m > 0;
      console.log(
        `[CONFIRM_ENTRY] ${phase.toUpperCase()} LONG check: pChange=${pChange} > 0 && cvd3m=${cvd3m} > 0 => ${confirmed}`
      );
      return confirmed;
    }
    if (signal === 'SHORT') {
      const confirmed = pChange < -minMove && cvd3m < 0;
      console.log(
        `[CONFIRM_ENTRY] ${phase.toUpperCase()} SHORT check: pChange=${pChange} < 0 && cvd3m=${cvd3m} < 0 => ${confirmed}`
      );
      return confirmed;
    }
  }

  console.log(
    `[CONFIRM_ENTRY] No conditions matched: phase=${phase}, signal=${signal}, pChange=${pChange}, cvd3m=${cvd3m}`
  );
  return false;
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

  // 1️⃣ ТРЕНД (Используем moveThreshold из настроек)
  // Для BTC это будет 0.5%, для щитка 2.0%
  if (Math.abs(p30) > settings.moveThreshold && Math.abs(oi15) > settings.oiThreshold) {
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
  if (Math.abs(p30) > settings.moveThreshold * 0.7 && oi15 < -settings.oiThreshold) {
    return 'blowoff';
  }

  return 'range';
}

const MARKET_SETTINGS = {
  // Для тяжелых монет (BTC, ETH)
  LIQUID: {
    moveThreshold: 0.5, // Малое движение уже тренд
    cvdThreshold: 15000, // Нужно много денег, чтобы заметить фазу
    oiThreshold: 0.3, // Даже 0.3% OI — это серьезно
  },
  // Для обычных альтов (SOL, XRP, ADA)
  MEDIUM: {
    moveThreshold: 1.0,
    cvdThreshold: 5000,
    oiThreshold: 0.8,
  },
  // Для волатильных щитков (PEPE, FOLKS и т.д.)
  VOLATILE: {
    moveThreshold: 2.2, // 0.5% для них — это просто шум
    cvdThreshold: 1500, // Маленький объем уже двигает цену
    oiThreshold: 1.5,
  },
};

/**
 * Определяет категорию монеты и возвращает соответствующие пороги
 */
export function selectCoinThresholds(symbol: SymbolValue) {
  // 2. Определяем списки (их можно расширять)
  const liquidCoins = new Set<SymbolValue>([SYMBOLS.BTC, SYMBOLS.ETH, SYMBOLS.SOL]);
  const mediumLiquidCoins = new Set<SymbolValue>([SYMBOLS.XRP, SYMBOLS.PIPPIN, SYMBOLS.BEAT]);

  // 3. Логика выбора
  // Самые ликвидные
  if (liquidCoins.has(symbol)) {
    return MARKET_SETTINGS.LIQUID;
  }

  // Самые волатильные (шиткоины/мемкоины)
  if (mediumLiquidCoins.has(symbol)) {
    return MARKET_SETTINGS.VOLATILE;
  }

  // Все остальное (SOL, XRP, ADA, DOT и т.д.) по умолчанию — MEDIUM
  return MARKET_SETTINGS.MEDIUM;
}

/**
 * Округляет значение до нужного шага (tickSize или qtyStep)
 */
export function roundStep(value: number, step: number): number {
  if (!step) return value;
  const precision = step.toString().split('.')[1]?.length || 0;
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}
