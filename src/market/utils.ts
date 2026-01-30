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
import { getCSI, getCvdThreshold } from './candleBuilder.js';
import { getSnapshots } from './snapshotStore.js';
import type { WatcherLogger } from './logging.js';
import { getWatcherLogger } from './logging.js';

/**
 * Formats funding rate into a human-readable string
 * @param rate - Funding rate (e.g., 0.0001 for 0.01%)
 * @returns Formatted string with percentage and who pays (e.g., "0.0250% (Longs pay)")
 */
export function formatFundingRate(rate?: number): string {
  const safeRate = rate ?? 0;

  if (safeRate > 0) {
    return `${(safeRate * 100).toFixed(4)}% (Лонги платят шортам)`;
  }

  if (safeRate < 0) {
    return `${(safeRate * 100).toFixed(4)}% (Шорты платят лонгам)`;
  }

  return `0.0000% (Нейтрально)`;
}

export function calculateEntryScores(
  {
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
    globalTrend,
  }: EntryScoresParams,
  log?: WatcherLogger
): EntryScores {
  const logger = getWatcherLogger(log);
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
    logger(
      `[ENTRY_SCORE][${component}] ${side} ${sign}${amount.toFixed(2)}${
        context ? ` | ${context}` : ''
      }`
    );
  };

  /* =====================
   TREND-FOLLOWING SCORING SYSTEM v4
   Ключевое изменение: ФИЛЬТР ГЛОБАЛЬНОГО ТРЕНДА
   - BULLISH → только LONG
   - BEARISH → только SHORT
   - NEUTRAL → обе стороны (с осторожностью)
   Макс скор: ~100
   MIN_SCORE = 65 для входа
   ===================== */

  // Blowoff — единственный жёсткий блок
  if (state.phase === 'blowoff') return { longScore: 0, shortScore: 0, entrySignal: `🚫 BLOWOFF` };

  // =====================
  // 🚨 GLOBAL TREND FILTER — главный фильтр
  // =====================
  const trend = globalTrend ?? 'NEUTRAL';
  logger(`[GLOBAL_TREND] ${trend}`);

  // Если глобальный тренд определён, блокируем противоположную сторону ПОЛНОСТЬЮ
  if (trend === 'BULLISH') {
    // В бычьем тренде SHORT = 0 всегда
    shortScore = 0;
    logger(`[GLOBAL_TREND] BULLISH → SHORT blocked`);
  } else if (trend === 'BEARISH') {
    // В медвежьем тренде LONG = 0 всегда
    longScore = 0;
    logger(`[GLOBAL_TREND] BEARISH → LONG blocked`);
  }

  const oi30 = delta30m?.oiChangePct ?? 0;
  const oi15 = delta15m?.oiChangePct ?? 0;
  const price1m = delta?.priceChangePct ?? 0;
  const price5m = delta5m?.priceChangePct ?? 0;
  const price15m = delta15m?.priceChangePct ?? 0;
  const price30m = delta30m?.priceChangePct ?? 0;

  /* =====================
   1️⃣ MOMENTUM — главный драйвер (макс +30)
   Смотрим на направленное движение цены
  ===================== */
  // 30-минутный momentum: сильное направленное движение
  const momentum30 = Math.min(Math.abs(price30m) / 0.5, 1) * 15; // 0.5% = 15 баллов
  if (price30m > 0.1) {
    awardScore('LONG', momentum30, 'MOMENTUM_30M', `p30m=${price30m.toFixed(2)}%`);
  } else if (price30m < -0.1) {
    awardScore('SHORT', momentum30, 'MOMENTUM_30M', `p30m=${price30m.toFixed(2)}%`);
  }

  // 5-минутный импульс: свежий momentum
  const momentum5 = Math.min(Math.abs(price5m) / 0.3, 1) * 15; // 0.3% = 15 баллов
  if (price5m > 0.05) {
    awardScore('LONG', momentum5, 'MOMENTUM_5M', `p5m=${price5m.toFixed(2)}%`);
  } else if (price5m < -0.05) {
    awardScore('SHORT', momentum5, 'MOMENTUM_5M', `p5m=${price5m.toFixed(2)}%`);
  }
  details.impulse = Math.round(Math.max(momentum30, momentum5));

  /* =====================
   2️⃣ TREND ALIGNMENT — бонус за совпадение направлений (макс +15)
  ===================== */
  const sameDirection = Math.sign(price5m) === Math.sign(price30m) && Math.sign(price30m) !== 0;
  if (sameDirection) {
    const alignBonus = 15;
    if (price30m > 0) {
      awardScore('LONG', alignBonus, 'TREND_ALIGN', '5m & 30m same direction');
    } else {
      awardScore('SHORT', alignBonus, 'TREND_ALIGN', '5m & 30m same direction');
    }
  }
  details.trend = sameDirection ? 15 : 0;

  /* =====================
   3️⃣ OI CONFIRMATION — подтверждение позициями (макс +15)
   Растущий OI = новые позиции = уверенность
  ===================== */
  if (oi15 > 0.05) {
    // OI растёт — уверенный вход в рынок
    const oiBonus = Math.min(oi15 * 30, 15); // 0.5% OI = 15 баллов
    if (price15m > 0) {
      awardScore('LONG', oiBonus, 'OI_CONFIRM', `oi15=${oi15.toFixed(2)}% growing`);
    } else if (price15m < 0) {
      awardScore('SHORT', oiBonus, 'OI_CONFIRM', `oi15=${oi15.toFixed(2)}% growing`);
    }
    details.oi = Math.round(oiBonus);
  } else if (oi15 < -0.2) {
    // OI падает — позиции закрываются, НО это не блокирует
    // Просто не даём бонус
    logger(`[OI] Positions closing (${oi15.toFixed(2)}%), no bonus`);
    details.oi = 0;
  } else {
    details.oi = 0;
  }

  /* =====================
   4️⃣ CVD FLOW — подтверждение объёмом (макс +15)
  ===================== */
  const cvdThresh = impulse.VOL_SURGE_CVD * 2;
  if (Math.abs(cvd15m) > cvdThresh * 0.2) {
    const cvdBonus = Math.min(Math.abs(cvd15m) / cvdThresh, 1) * 15;
    if (cvd15m > 0) {
      awardScore('LONG', cvdBonus, 'CVD_FLOW', `cvd15m=${cvd15m.toFixed(0)}`);
    } else {
      awardScore('SHORT', cvdBonus, 'CVD_FLOW', `cvd15m=${cvd15m.toFixed(0)}`);
    }
    details.cvd = Math.round(cvdBonus);
  } else {
    details.cvd = 0;
  }

  /* =====================
   5️⃣ RSI ZONES — контртренд или momentum (макс +15)
  ===================== */
  if (rsi <= 35) {
    // Перепроданность — возможен отскок (LONG)
    awardScore('LONG', 15, 'RSI_OVERSOLD', `rsi=${rsi.toFixed(1)}`);
    details.rsi = 15;
  } else if (rsi >= 65) {
    // Перекупленность — возможна коррекция (SHORT)
    awardScore('SHORT', 15, 'RSI_OVERBOUGHT', `rsi=${rsi.toFixed(1)}`);
    details.rsi = 15;
  } else if (rsi > 50 && rsi < 65) {
    // Бычий momentum
    awardScore('LONG', 5, 'RSI_BULLISH', `rsi=${rsi.toFixed(1)}`);
    details.rsi = 5;
  } else if (rsi < 50 && rsi > 35) {
    // Медвежий momentum
    awardScore('SHORT', 5, 'RSI_BEARISH', `rsi=${rsi.toFixed(1)}`);
    details.rsi = 5;
  } else {
    details.rsi = 0;
  }

  /* =====================
   6️⃣ PHASE BONUS — бонус за благоприятную фазу (макс +10)
  ===================== */
  if (state.phase === 'accumulation') {
    awardScore('LONG', 10, 'PHASE', 'accumulation');
  } else if (state.phase === 'distribution') {
    awardScore('SHORT', 10, 'PHASE', 'distribution');
  } else if (state.phase === 'trend') {
    if (isBull) awardScore('LONG', 10, 'PHASE', 'trend bull');
    if (isBear) awardScore('SHORT', 10, 'PHASE', 'trend bear');
  }
  details.phase = state.phase !== 'range' ? 10 : 0;

  /* =====================
   7️⃣ FUNDING — контртренд сигнал (макс +5)
  ===================== */
  const fRate = snap.fundingRate ?? 0;
  if (fRate < -0.0002) {
    awardScore('LONG', 5, 'FUNDING', `negative funding ${fRate}`);
  } else if (fRate > 0.0002) {
    awardScore('SHORT', 5, 'FUNDING', `positive funding ${fRate}`);
  }
  details.funding = Math.abs(fRate) > 0.0002 ? 5 : 0;

  /* =====================
   SAFETY FILTERS — защита от опасных ситуаций
  ===================== */
  const knifeThreshold = 1.5; // 1.5% за 5 минут — это обвал
  if (longScore > 0 && price5m < -knifeThreshold) {
    longScore -= 30;
    logger(`[SAFETY] Falling knife (5m: ${price5m.toFixed(2)}%), penalty -30`);
  }
  if (shortScore > 0 && price5m > knifeThreshold) {
    shortScore -= 30;
    logger(`[SAFETY] Parabolic spike (5m: ${price5m.toFixed(2)}%), penalty -30`);
  }

  // Clamp
  longScore = Math.min(100, Math.round(longScore));
  shortScore = Math.min(100, Math.round(shortScore));

  let entrySignal = `⚪ Нет сетапа (L:${longScore} S:${shortScore})`;
  if (longScore >= MIN_SCORE) entrySignal = `🟢 LONG SETUP (${longScore}/100)`;
  else if (shortScore >= MIN_SCORE) entrySignal = `🔴 SHORT SETUP (${shortScore}/100)`;

  logger(
    `[ENTRY_SCORE][TOTAL] 🟢LONG=${longScore} 🔴SHORT=${shortScore} | signal=${entrySignal}`
  );

  return { longScore, shortScore, entrySignal, details };
}

export function getSignalAgreement(
  {
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
    globalTrend,
  }: SignalAgreementParams,
  log?: WatcherLogger
) {
  const logger = getWatcherLogger(log);
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
  const trend = globalTrend ?? 'NEUTRAL';

  // 🚨 GLOBAL TREND FILTER — блокируем торговлю против тренда
  const isLongAllowed = trend !== 'BEARISH';
  const isShortAllowed = trend !== 'BULLISH';

  if (!isLongAllowed && longScore > shortScore) {
    logger(`[SIGNAL_AGREEMENT] LONG blocked by BEARISH global trend`);
    return 'NONE';
  }
  if (!isShortAllowed && shortScore > longScore) {
    logger(`[SIGNAL_AGREEMENT] SHORT blocked by BULLISH global trend`);
    return 'NONE';
  }

  // 1️⃣ Блокировка при кульминации
  if (phase === 'blowoff') {
    logger(`[SIGNAL_AGREEMENT] Blowoff phase detected, returning NONE`);
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
      logger(`[SIGNAL_AGREEMENT] TREND CONTINUATION LONG`);
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
      logger(`[SIGNAL_AGREEMENT] TREND CONTINUATION SHORT`);
      return 'SHORT';
    }
  }

  // =====================
  // 3️⃣ BREAKOUT / EXPANSION ENTRY
  // =====================
  if (phase === 'trend' || phase === 'accumulation' || phase === 'distribution') {
    if (Math.abs(pricePercentChange) < moveThreshold * tuning.breakoutMoveFactor) {
      logger(
        `[SIGNAL_AGREEMENT] Price change ${pricePercentChange}% < moveThreshold ${moveThreshold}%, returning NONE`
      );
      return 'NONE';
    }

    if (
      longScore >= tuning.minLongScore + 3 &&
      longScore - shortScore >= tuning.breakoutScoreGap &&
      pricePercentChange > 0 &&
      cvd15m > cvdThreshold * tuning.breakoutCvdFactor &&
      fundingRate <= 0.0002
    ) {
      logger(`[SIGNAL_AGREEMENT] BREAKOUT LONG`);
      return 'LONG';
    }

    if (
      shortScore >= tuning.minShortScore + 3 &&
      shortScore - longScore >= tuning.breakoutScoreGap &&
      pricePercentChange < 0 &&
      cvd15m < -cvdThreshold * tuning.breakoutCvdFactor &&
      fundingRate >= -0.0002
    ) {
      logger(`[SIGNAL_AGREEMENT] BREAKOUT SHORT`);
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
      pricePercentChange >= moveThreshold * 0.3 &&
      Math.abs(cvd15m) >= cvdThreshold * 0.3 &&
      cvd15m > 0
    ) {
      logger(`[SIGNAL_AGREEMENT] RANGE LONG`);
      return 'LONG';
    }

    if (
      shortScore >= tuning.minShortScore + 5 &&
      shortScore - longScore >= 20 &&
      rsi <= Math.min(tuning.maxShortRsi, 45) &&
      pricePercentChange <= -moveThreshold * 0.3 &&
      Math.abs(cvd15m) >= cvdThreshold * 0.3 &&
      cvd15m < 0
    ) {
      logger(`[SIGNAL_AGREEMENT] RANGE SHORT`);
      return 'SHORT';
    }
  }

  logger(
    `[SIGNAL_AGREEMENT] No signal matched: phase=${phase}, longScore=${longScore}, shortScore=${shortScore}`
  );
  return 'NONE';
}

export function confirmEntry(
  { signal, delta, cvd3m, phase, confirmedAt }: ConfirmEntryParams,
  log?: WatcherLogger
): boolean {
  const logger = getWatcherLogger(log);
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
    logger(
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

type CoinThresholds = {
  moveThreshold: number;
  cvdThreshold: number;
  oiThreshold: number;
};

const SNAPSHOT_OI_MIN_SAMPLES = 8;
const SNAPSHOT_OI_PERCENTILE = 0.85;

/**
 * Определяет категорию монеты и возвращает соответствующие пороги
 */
export function selectCoinThresholds(symbol: SymbolValue) {
  const dynamic = buildDynamicThresholds(symbol);
  if (dynamic) {
    return dynamic;
  }

  return getFallbackThresholds(symbol);
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

function buildDynamicThresholds(symbol: SymbolValue): CoinThresholds | null {
  const { moveThreshold, cvdThreshold } = getCvdThreshold(symbol);
  const oiThreshold = computeOiThresholdFromSnapshots(symbol);

  if (!Number.isFinite(moveThreshold) || !Number.isFinite(cvdThreshold)) {
    return null;
  }

  if (oiThreshold === null) {
    return null;
  }

  return {
    moveThreshold,
    cvdThreshold,
    oiThreshold,
  };
}

function computeOiThresholdFromSnapshots(symbol: SymbolValue): number | null {
  const snaps = getSnapshots(symbol);
  if (snaps.length < SNAPSHOT_OI_MIN_SAMPLES) {
    return null;
  }

  const oiChanges: number[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    if (!prev?.openInterest || !curr?.openInterest || prev.openInterest === 0) continue;
    const pct = Math.abs(((curr.openInterest - prev.openInterest) / prev.openInterest) * 100);
    if (Number.isFinite(pct)) {
      oiChanges.push(pct);
    }
  }

  if (oiChanges.length < SNAPSHOT_OI_MIN_SAMPLES) {
    return null;
  }

  const threshold = percentile(oiChanges, SNAPSHOT_OI_PERCENTILE);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return null;
  }

  return Number(threshold.toFixed(3));
}

function getFallbackThresholds(symbol: SymbolValue): CoinThresholds {
  const liquidCoins = new Set<SymbolValue>([SYMBOLS.BTC, SYMBOLS.ETH]);
  const volatileCoins = new Set<SymbolValue>([SYMBOLS.XRP, SYMBOLS.PIPPIN, SYMBOLS.BEAT]);

  if (liquidCoins.has(symbol)) {
    return { ...MARKET_SETTINGS.LIQUID };
  }

  if (volatileCoins.has(symbol)) {
    return { ...MARKET_SETTINGS.VOLATILE };
  }

  return { ...MARKET_SETTINGS.MEDIUM };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index]!;
}
