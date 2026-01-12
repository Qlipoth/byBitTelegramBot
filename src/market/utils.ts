import dayjs from 'dayjs';
import type { KlineIntervalV3 } from 'bybit-api';

import { bybitClient } from '../services/bybit.js';
import { MIN_SCORE, SYMBOLS } from './constants.market.js';
import type {
  ConfirmEntryParams,
  EntryScores,
  EntryScoresParams,
  SignalAgreementParams,
  SymbolValue,
} from './types.js';
import { getCSI } from './candleBuilder.js';

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
  impulse, // Это наши { PRICE_SURGE_PCT, VOL_SURGE_CVD }
  isBull,
  isBear,
}: EntryScoresParams): EntryScores {
  let longScore = 0;
  let shortScore = 0;

  const details = { phase: 0, oi: 0, funding: 0, cvd: 0, impulse: 0, rsi: 0, trend: 0, csi: 0 };
  const awardScore = (
    side: 'LONG' | 'SHORT',
    amount: number,
    component: string,
    context?: string
  ) => {
    if (!amount) return;
    if (side === 'LONG') {
      longScore += amount;
    } else {
      shortScore += amount;
    }
    const sign = amount >= 0 ? '+' : '';
    console.log(
      `[ENTRY_SCORE][${component}] ${side} ${sign}${amount.toFixed(2)}${
        context ? ` | ${context}` : ''
      }`
    );
  };

  /* =====================
   1️⃣ Phase (БЕЗ ИЗМЕНЕНИЙ)
  ===================== */
  if (state.phase === 'blowoff') return { longScore: 0, shortScore: 0, entrySignal: `🚫 BLOWOFF` };
  if (state.phase === 'accumulation') {
    awardScore('LONG', 15, 'PHASE', `phase=${state.phase}`);
  } else if (state.phase === 'distribution') {
    awardScore('SHORT', 15, 'PHASE', `phase=${state.phase}`);
  } else if (state.phase === 'trend') {
    if (isBull) {
      awardScore('LONG', 15, 'PHASE', 'phase=trend isBull');
    }
    if (isBear) {
      awardScore('SHORT', 15, 'PHASE', 'phase=trend isBear');
    }
  }
  details.phase =
    (state.phase === 'accumulation' ? 15 : 0) +
    (state.phase === 'distribution' ? 15 : 0) +
    (state.phase === 'trend' ? (isBull ? 15 : 0) + (isBear ? 15 : 0) : 0);

  /* =====================
   2️⃣ OI dynamics (БЕЗ ИЗМЕНЕНИЙ)
  ===================== */
  const oi30 = delta30m?.oiChangePct ?? 0;
  const oi15 = delta15m?.oiChangePct ?? 0;
  const isDataMature = (delta30m?.minutesAgo ?? 0) >= 15;

  let oiLong =
    (isDataMature ? Math.log1p(Math.max(oi30, 0)) * 10 : 0) + Math.log1p(Math.max(oi15, 0)) * 10;
  let oiShort =
    (isDataMature ? Math.log1p(Math.max(-oi30, 0)) * 10 : 0) + Math.log1p(Math.max(-oi15, 0)) * 10;

  // Если OI падает (меньше нуля), мы вычитаем баллы из обоих направлений,
  // потому что падение OI — это выход игроков (ликвидации/фиксация), а не новый импульс.
  if (oi15 < 0) {
    const penalty = 15;
    oiLong -= penalty;
    oiShort -= penalty;
    // Можно добавить лог, чтобы видеть это в консоли
    console.log(`[OI_PENALTY] OI is falling (${oi15.toFixed(2)}%), reducing confidence`);
  }

  const oiLongBonus = Math.min(oiLong, 25);
  const oiShortBonus = Math.min(oiShort, 25);

  awardScore('LONG', oiLongBonus, 'OI', `oi30=${oi30.toFixed(2)} oi15=${oi15.toFixed(2)}`);
  awardScore('SHORT', oiShortBonus, 'OI', `oi30=${oi30.toFixed(2)} oi15=${oi15.toFixed(2)}`);
  details.oi = Math.round(Math.max(oiLongBonus, oiShortBonus));

  /* =====================
   3️⃣ Funding (БЕЗ ИЗМЕНЕНИЙ)
  ===================== */
  const fRate = snap.fundingRate ?? 0;
  if (fRate < -0.0001) {
    awardScore('LONG', 10, 'FUNDING', `fundingRate=${fRate}`);
  }
  if (fRate > 0.0001) {
    awardScore('SHORT', 10, 'FUNDING', `fundingRate=${fRate}`);
  }
  if (fRate < -0.0004) {
    awardScore('LONG', 5, 'FUNDING_EXTREME', `fundingRate=${fRate}`);
  } else if (fRate > 0.0004) {
    awardScore('SHORT', 5, 'FUNDING_EXTREME', `fundingRate=${fRate}`);
  }
  details.funding = fRate === 0 ? 0 : 10;

  /* =====================
   4️⃣ CVD strength (АДАПТИРОВАНО ПОД ПОРОГ)
  ===================== */
  // Вместо 5000 и 2000 используем динамический cvdThreshold
  // cvdThreshold — это средний минутный объем * 1.8.
  // Для 15 минут логично ждать примерно cvdThreshold * 5
  const dynamicCvd15Threshold = impulse.VOL_SURGE_CVD * 5;
  const dynamicCvd3Threshold = impulse.VOL_SURGE_CVD * 1.5;

  const cvd15Norm = Math.min(Math.abs(cvd15m) / dynamicCvd15Threshold, 1);
  const cvd3Norm = Math.min(Math.abs(cvd3m) / dynamicCvd3Threshold, 1);
  const cvd15Active = Math.abs(cvd15m) >= dynamicCvd15Threshold * 0.5;
  const cvd3Active = Math.abs(cvd3m) >= dynamicCvd3Threshold * 0.5;

  if (cvd15Active && cvd15m > 0) {
    const bonus = cvd15Norm * 10;
    awardScore('LONG', bonus, 'CVD15', `cvd15m=${cvd15m.toFixed(0)}`);
  }
  if (cvd15Active && cvd15m < 0) {
    const bonus = cvd15Norm * 10;
    awardScore('SHORT', bonus, 'CVD15', `cvd15m=${cvd15m.toFixed(0)}`);
  }

  if (cvd3Active && cvd3m > 0) {
    const bonus = cvd3Norm * 7;
    awardScore('LONG', bonus, 'CVD3', `cvd3m=${cvd3m.toFixed(0)}`);
  }
  if (cvd3Active && cvd3m < 0) {
    const bonus = cvd3Norm * 7;
    awardScore('SHORT', bonus, 'CVD3', `cvd3m=${cvd3m.toFixed(0)}`);
  }
  details.cvd = Math.round((cvd15Active ? cvd15Norm * 10 : 0) + (cvd3Active ? cvd3Norm * 7 : 0));

  /* =====================
   5️⃣ Impulse & Velocity (АДАПТИРОВАНО)
  ===================== */
  const price1m = delta?.priceChangePct ?? 0;
  const price5m = delta5m?.priceChangePct ?? 0;

  // 1m Impulse (Сравнение с живым порогом ATR)
  if (price1m > impulse.PRICE_SURGE_PCT) {
    awardScore(
      'LONG',
      10,
      'IMPULSE_1M',
      `price1m=${price1m.toFixed(3)} thresh=${impulse.PRICE_SURGE_PCT}`
    );
  }
  if (price1m < -impulse.PRICE_SURGE_PCT) {
    awardScore(
      'SHORT',
      10,
      'IMPULSE_1M',
      `price1m=${price1m.toFixed(3)} thresh=${impulse.PRICE_SURGE_PCT}`
    );
  }

  // Velocity: Если 5м делает основной вклад в 15м
  const isVelocityLong = price5m > 0 && price5m > (delta15m?.priceChangePct ?? 0) * 0.7;
  const isVelocityShort = price5m < 0 && price5m < (delta15m?.priceChangePct ?? 0) * 0.7;

  if (isVelocityLong) {
    awardScore(
      'LONG',
      5,
      'VELOCITY_5M',
      `price5m=${price5m.toFixed(3)} delta15m=${(delta15m?.priceChangePct ?? 0).toFixed(3)}`
    );
  }
  if (isVelocityShort) {
    awardScore(
      'SHORT',
      5,
      'VELOCITY_5M',
      `price5m=${price5m.toFixed(3)} delta15m=${(delta15m?.priceChangePct ?? 0).toFixed(3)}`
    );
  }
  details.impulse =
    (price1m > impulse.PRICE_SURGE_PCT ? 10 : 0) +
    (price1m < -impulse.PRICE_SURGE_PCT ? 10 : 0) +
    (isVelocityLong || isVelocityShort ? 5 : 0);

  /* =====================
   6️⃣ RSI & Trend (БЕЗ ИЗМЕНЕНИЙ)
  ===================== */
  if (rsi >= 55) {
    awardScore('LONG', 5, 'RSI', `rsi=${rsi.toFixed(2)}`);
  }
  if (rsi <= 45) {
    awardScore('SHORT', 5, 'RSI', `rsi=${rsi.toFixed(2)}`);
  }
  if (rsi >= 70) {
    awardScore('SHORT', 7, 'RSI_EXTREME', `rsi=${rsi.toFixed(2)}`);
  } else if (rsi <= 30) {
    awardScore('LONG', 7, 'RSI_EXTREME', `rsi=${rsi.toFixed(2)}`);
  }
  if (isBull) {
    awardScore('LONG', 5, 'TREND', 'isBull=true');
  }
  if (isBear) {
    awardScore('SHORT', 5, 'TREND', 'isBear=true');
  }
  details.rsi = (rsi >= 55 ? 5 : 0) + (rsi <= 45 ? 5 : 0);
  details.trend = (isBull ? 5 : 0) + (isBear ? 5 : 0);

  // 1. Защита от "падающего ножа" (Убивает убыток сделки №12)
  // Если цена за 5 минут упала в 3 раза сильнее, чем обычный импульс — это обвал, а не разворот.
  const knifeThreshold = impulse.PRICE_SURGE_PCT * 3;
  if (longScore > 0 && price5m < -knifeThreshold) {
    longScore -= 30; // Сбрасываем скор, чтобы не войти
    console.log(`[SAFETY] Falling knife detected (5m: ${price5m.toFixed(2)}%), penalty -30`);
  }

  // Clamp
  longScore = Math.min(100, Math.round(longScore));
  shortScore = Math.min(100, Math.round(shortScore));

  let entrySignal = `⚪ Нет сетапа (L:${longScore} S:${shortScore})`;
  if (longScore >= 65) entrySignal = `🟢 LONG SETUP (${longScore}/100)`;
  else if (shortScore >= 65) entrySignal = `🔴 SHORT SETUP (${shortScore}/100)`;

  console.log(
    `[ENTRY_SCORE][TOTAL] 🟢LONG=${longScore} 🔴SHORT=${shortScore} | signal=${entrySignal}`
  );

  return { longScore, shortScore, entrySignal, details };
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
  symbol,
}: SignalAgreementParams) {
  const isSol = symbol === SYMBOLS.SOL;
  const tuning = {
    minLongScore: MIN_SCORE + (isSol ? 4 : 0),
    minShortScore: MIN_SCORE + (isSol ? 4 : 0),
    trendScoreGap: isSol ? 12 : 7,
    breakoutScoreGap: isSol ? 12 : 9,
    trendMoveFactor: isSol ? 0.9 : 0.5,
    breakoutMoveFactor: isSol ? 1.0 : 0.8,
    minLongRsi: isSol ? 55 : 50,
    maxShortRsi: isSol ? 45 : 50,
    trendCvdFactor: isSol ? 0.6 : 0,
    breakoutCvdFactor: isSol ? 0.8 : 1,
  };
  const csi = getCSI(symbol); // Получаем индекс силы

  // 1. Для пробоев и накопления нам нужен ИМПУЛЬС (CSI выше 0.25)
  // if ((phase === 'accumulation' || phase === 'distribution') && Math.abs(csi) < 0.25) {
  //   console.log(`[SIGNAL_AGREEMENT] CSI ${csi.toFixed(2)} too low for BREAKOUT`);
  //   return 'NONE';
  // }
  //
  // // 2. Для тренда достаточно, чтобы CSI просто не был направлен ПРОТИВ нас
  // if (phase === 'trend') {
  //   if (longScore > shortScore && csi < -0.1) return 'NONE'; // Пытаемся лонговать, а минутка давит вниз
  //   if (shortScore > longScore && csi > 0.1) return 'NONE'; // Пытаемся шортить, а минутка откупается
  // }
  //
  // // 3. Абсолютный мусор (дойджи, отсутствие объема) — режем всегда
  // if (Math.abs(csi) < 0.1) {
  //   return 'NONE';
  // }
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
      longScore >= tuning.minLongScore &&
      longScore - shortScore >= tuning.trendScoreGap &&
      rsi >= tuning.minLongRsi &&
      pricePercentChange > 0 &&
      Math.abs(pricePercentChange) >= moveThreshold * tuning.trendMoveFactor &&
      cvd15m > cvdThreshold * tuning.trendCvdFactor &&
      fundingRate <= 0.00025
    ) {
      console.log(`[SIGNAL_AGREEMENT] TREND CONTINUATION LONG`);
      return 'LONG';
    }

    // SHORT continuation
    if (
      shortScore >= tuning.minShortScore &&
      shortScore - longScore >= tuning.trendScoreGap &&
      rsi <= tuning.maxShortRsi &&
      pricePercentChange < 0 &&
      Math.abs(pricePercentChange) >= moveThreshold * tuning.trendMoveFactor &&
      cvd15m < -cvdThreshold * tuning.trendCvdFactor &&
      fundingRate >= -0.00025
    ) {
      console.log(`[SIGNAL_AGREEMENT] TREND CONTINUATION SHORT`);
      return 'SHORT';
    }
  }

  // =====================
  // 3️⃣ BREAKOUT / EXPANSION ENTRY
  // =====================
  if (phase === 'trend' || phase === 'accumulation' || phase === 'distribution') {
    if (Math.abs(pricePercentChange) < moveThreshold * tuning.breakoutMoveFactor) {
      console.log(
        `[SIGNAL_AGREEMENT] Price change ${pricePercentChange}% < moveThreshold ${moveThreshold}%, returning NONE`
      );
      return 'NONE';
    }

    if (
      longScore >= tuning.minLongScore + 3 &&
      longScore - shortScore >= tuning.breakoutScoreGap &&
      cvd15m > cvdThreshold * tuning.breakoutCvdFactor &&
      fundingRate <= 0.0002
    ) {
      console.log(`[SIGNAL_AGREEMENT] BREAKOUT LONG`);
      return 'LONG';
    }

    if (
      shortScore >= tuning.minShortScore + 3 &&
      shortScore - longScore >= tuning.breakoutScoreGap &&
      cvd15m < -cvdThreshold * tuning.breakoutCvdFactor &&
      fundingRate >= -0.0002
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
      longScore >= tuning.minLongScore + 5 &&
      longScore - shortScore >= 20 &&
      rsi >= Math.max(tuning.minLongRsi, 55) &&
      Math.abs(pricePercentChange) >= moveThreshold * 0.3 &&
      Math.abs(cvd15m) >= cvdThreshold * 0.3 &&
      cvd15m > 0
    ) {
      console.log(`[SIGNAL_AGREEMENT] RANGE LONG`);
      return 'LONG';
    }

    if (
      shortScore >= tuning.minShortScore + 5 &&
      shortScore - longScore >= 20 &&
      rsi <= Math.min(tuning.maxShortRsi, 45) &&
      Math.abs(pricePercentChange) >= moveThreshold * 0.3 &&
      Math.abs(cvd15m) >= cvdThreshold * 0.3 &&
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
  phase,
  confirmedAt,
}: ConfirmEntryParams): boolean {
  // 1. ПРОВЕРКА НАЛИЧИЯ ДАННЫХ
  if (!delta || cvd3m === undefined) return false;

  const pChange = delta.priceChangePct;
  const absPChange = Math.abs(pChange);

  /**
   * 2. ДИНАМИЧЕСКИЕ ПОРОГИ ДЛЯ ETH (Очищено от impulse)
   * Для 1-минутной свечи ETH:
   * - 0.2% - это начало движения
   * - 0.45% - это уже "ракета", в которую поздно прыгать
   */
  const MIN_MOVE = phase === 'trend' ? 0.22 : 0.18; // В тренде ждем чуть больше силы
  const MAX_MOVE = 0.5; // ANTI-FOMO лимит: не заходим на пике палки

  /**
   * 3. РЕАЛЬНЫЕ ПОРОГИ CVD ДЛЯ ETH (в USDT)
   * На ETHUSDT нормальный минутный импульс — это 800k - 1.5M USDT.
   * Если cvd3m меньше 500k — это "пустое" движение роботов.
   */
  const MIN_CVD = phase === 'trend' ? 600000 : 500000;

  /**
   * 4. ПЛОТНОСТЬ (КАЧЕСТВО ДВИЖЕНИЯ)
   * Сколько долларов CVD приходится на 1% движения.
   * Если цена летит, а CVD стоит — это ловушка.
   */
  const currentDensity = Math.abs(cvd3m / (pChange || 0.001));
  const MIN_DENSITY = 1500000; // Минимум 2.5 млн USDT на каждый 1% движения

  let confirmed = false;

  // Логика подтверждения LONG
  if (signal === 'LONG') {
    confirmed =
      pChange >= MIN_MOVE && // Цена выросла достаточно
      pChange <= MAX_MOVE && // Но еще не улетела в космос (Anti-FOMO)
      cvd3m >= MIN_CVD && // Покупатели реально давят (минимум 600k-1M)
      currentDensity >= MIN_DENSITY; // Движение подтверждено плотным объемом
  }

  // Логика подтверждения SHORT
  if (signal === 'SHORT') {
    confirmed =
      pChange <= -MIN_MOVE && // Цена упала достаточно
      pChange >= -MAX_MOVE && // Но не слишком (Anti-FOMO)
      cvd3m <= -MIN_CVD && // Продавцы реально давят
      currentDensity >= MIN_DENSITY;
  }

  // ЛОГИРОВАНИЕ (поможет понять, почему сделка НЕ открылась)
  if (absPChange >= 0.15) {
    // Логируем только значимые попытки
    console.log(
      `[CONFIRM] ${signal} | PNL: ${pChange.toFixed(3)}% | CVD: ${(cvd3m / 1000000).toFixed(2)}M | ` +
        `Dense: ${(currentDensity / 1000000).toFixed(1)} | Res: ${confirmed ? '✅' : '❌'}`
    );
  }

  return confirmed;
}

const MARKET_SETTINGS = {
  // Для тяжелых монет (BTC, ETH)
  LIQUID: {
    moveThreshold: 0.6, // Малое движение уже тренд
    cvdThreshold: 8000, // Нужен заметный, но не экстремальный поток капитала
    oiThreshold: 0.15, // Более мягкий порог для фиксирования набора позиций
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

const COIN_THRESHOLD_OVERRIDES: Partial<
  Record<
    SymbolValue,
    {
      moveThreshold: number;
      cvdThreshold: number;
      oiThreshold: number;
    }
  >
> = {
  [SYMBOLS.SOL]: {
    moveThreshold: 0.45,
    cvdThreshold: 4500,
    oiThreshold: 0.5,
  },
};

/**
 * Определяет категорию монеты и возвращает соответствующие пороги
 */
export function selectCoinThresholds(symbol: SymbolValue) {
  const override = COIN_THRESHOLD_OVERRIDES[symbol];
  if (override) {
    return override;
  }

  const liquidCoins = new Set<SymbolValue>([SYMBOLS.BTC, SYMBOLS.ETH]);
  const volatileCoins = new Set<SymbolValue>([SYMBOLS.XRP, SYMBOLS.PIPPIN, SYMBOLS.BEAT]);

  if (liquidCoins.has(symbol)) {
    return MARKET_SETTINGS.LIQUID;
  }

  if (volatileCoins.has(symbol)) {
    return MARKET_SETTINGS.VOLATILE;
  }

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

const LIQUID_CALIBRATION_SYMBOLS: string[] = [SYMBOLS.BTC, SYMBOLS.ETH, SYMBOLS.SOL];
const LIQUID_CALIBRATION_SETTINGS = {
  days: 60,
  intervalMinutes: 30,
  percentile: 0.8,
};

let liquidThresholdsCalibrated = false;
let liquidCalibrationPromise: Promise<void> | null = null;

export async function ensureLiquidThresholdsCalibrated() {
  if (liquidThresholdsCalibrated) return;
  if (!liquidCalibrationPromise) {
    liquidCalibrationPromise = calibrateLiquidThresholds()
      .catch(error => {
        console.error('[CALIBRATION] Failed to calibrate liquid thresholds:', error);
      })
      .finally(() => {
        liquidThresholdsCalibrated = true;
      });
  }
  await liquidCalibrationPromise;
}

type KlineRow = {
  timestamp: number;
  close: number;
  turnover: number;
};

type OpenInterestRow = {
  timestamp: number;
  openInterest: number;
};

type CalibrationSample = {
  priceChangePct: number;
  oiChangePct: number;
  cvdProxy: number;
};

async function calibrateLiquidThresholds() {
  const summaries: CalibrationSample[] = [];
  const endTime = Date.now();
  const startTime = dayjs(endTime).subtract(LIQUID_CALIBRATION_SETTINGS.days, 'day').valueOf();

  for (const symbol of LIQUID_CALIBRATION_SYMBOLS) {
    try {
      const [klines, oiPoints] = await Promise.all([
        fetchKlines(symbol, startTime, endTime),
        fetchOpenInterest(symbol, startTime, endTime),
      ]);

      if (!klines.length || !oiPoints.length) {
        console.warn(`[CALIBRATION] Not enough history for ${symbol}`);
        continue;
      }

      const samples = buildCalibrationSamples(klines, oiPoints);
      if (!samples.length) {
        console.warn(`[CALIBRATION] No samples derived for ${symbol}`);
        continue;
      }

      summaries.push(...samples);
      console.log(`[CALIBRATION] ${symbol}: collected ${samples.length} samples`);
    } catch (error) {
      console.error(`[CALIBRATION] Failed to fetch data for ${symbol}:`, error);
    }
  }

  if (!summaries.length) {
    console.warn('[CALIBRATION] No calibration data gathered; keeping default thresholds');
    return;
  }

  const moveThreshold = percentile(
    summaries.map(s => Math.abs(s.priceChangePct)),
    LIQUID_CALIBRATION_SETTINGS.percentile
  );
  const oiThreshold = percentile(
    summaries.map(s => Math.abs(s.oiChangePct)),
    LIQUID_CALIBRATION_SETTINGS.percentile
  );
  const cvdThreshold = percentile(
    summaries.map(s => Math.abs(s.cvdProxy)),
    LIQUID_CALIBRATION_SETTINGS.percentile
  );

  if (
    !Number.isFinite(moveThreshold) ||
    !Number.isFinite(oiThreshold) ||
    !Number.isFinite(cvdThreshold)
  ) {
    console.warn('[CALIBRATION] Computed thresholds invalid; keeping defaults');
    return;
  }

  MARKET_SETTINGS.LIQUID.moveThreshold = Number(moveThreshold.toFixed(3));
  MARKET_SETTINGS.LIQUID.oiThreshold = Number(oiThreshold.toFixed(3));
  MARKET_SETTINGS.LIQUID.cvdThreshold = Math.round(cvdThreshold);

  console.log(
    `[CALIBRATION] Liquid thresholds updated: move=${MARKET_SETTINGS.LIQUID.moveThreshold}%, oi=${MARKET_SETTINGS.LIQUID.oiThreshold}%, cvd=${MARKET_SETTINGS.LIQUID.cvdThreshold}`
  );
}

async function fetchKlines(symbol: string, start: number, end: number): Promise<KlineRow[]> {
  const interval = LIQUID_CALIBRATION_SETTINGS.intervalMinutes.toString() as KlineIntervalV3;
  let cursor: string | undefined;
  const rows: KlineRow[] = [];

  do {
    const response = (await bybitClient.getKline({
      category: 'linear',
      symbol,
      interval,
      start,
      end,
      limit: 200,
      cursor,
    } as any)) as any;

    if (response.retCode !== 0) {
      throw new Error(response.retMsg || 'Unknown error');
    }

    const list = response.result.list ?? [];
    for (const item of list) {
      const [ts, , , , close, , turnover] = item;
      rows.push({
        timestamp: Number(ts),
        close: Number(close),
        turnover: Number(turnover ?? 0),
      });
    }

    cursor = response.result.nextPageCursor ?? undefined;
  } while (cursor && rows.length < 2000);

  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchOpenInterest(symbol: string, startTime: number, endTime: number) {
  const intervalTime = `${LIQUID_CALIBRATION_SETTINGS.intervalMinutes}min`;
  let cursor: string | undefined;
  const rows: OpenInterestRow[] = [];

  do {
    const response = (await bybitClient.getOpenInterest({
      category: 'linear',
      symbol,
      intervalTime,
      startTime,
      endTime,
      limit: 200,
      cursor,
    } as any)) as any;

    if (response.retCode !== 0) {
      throw new Error(response.retMsg || 'Unknown error');
    }

    const list = response.result.list ?? [];
    for (const item of list) {
      rows.push({
        timestamp: Number(item.timestamp),
        openInterest: Number(item.openInterest),
      });
    }

    cursor = response.result.nextPageCursor ?? undefined;
  } while (cursor && rows.length < 2000);

  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

function buildCalibrationSamples(
  klines: KlineRow[],
  oiPoints: OpenInterestRow[]
): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1]!;
    const curr = klines[i]!;
    if (!prev.close || !curr.close) continue;

    const priceChangePct = ((curr.close - prev.close) / prev.close) * 100;
    const prevOi = findNearestOi(oiPoints, prev.timestamp);
    const currOi = findNearestOi(oiPoints, curr.timestamp);
    const oiChangePct = prevOi ? ((currOi - prevOi) / prevOi) * 100 : 0;
    const turnover = curr.turnover || 0;
    const normalizedCvd = turnover && curr.close ? turnover / Math.max(curr.close, 1) : 0;
    const cvdProxy = normalizedCvd * Math.sign(priceChangePct || 1);

    samples.push({ priceChangePct, oiChangePct, cvdProxy });
  }
  return samples;
}

function findNearestOi(points: OpenInterestRow[], timestamp: number): number {
  let latest = points[0]?.openInterest ?? 0;
  for (const point of points) {
    if (point.timestamp <= timestamp) {
      latest = point.openInterest;
    } else {
      break;
    }
  }
  return latest;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index]!;
}
