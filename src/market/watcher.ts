import dayjs from 'dayjs';
import { saveSnapshot, getSnapshots } from './snapshotStore.js';
import { compareSnapshots } from './compare.js';
import {
  getCurrentBalance,
  getMarketSnapshot,
  getTopLiquidSymbols,
  preloadMarketSnapshots,
  ws,
} from '../services/bybit.js';
import {
  INTERVALS,
  PRIORITY_COINS,
  COINS_COUNT,
  BASE_IMPULSE_THRESHOLDS,
  LIQUID_IMPULSE_THRESHOLDS,
  SYNC_OPEN_POSITION_INTERVAL_MS,
} from './constants.market.js';
import {
  calculateEntryScores,
  getSignalAgreement,
  confirmEntry,
  selectCoinThresholds,
} from './utils.js';
import { adaptiveBollingerStrategy } from './adaptiveBollingerStrategy.js';
import { fetchBybitCandles } from '../backtest/candleLoader.js';
import { ingest1hCandles } from './candleBuilder.js';
import { calculateRSI, detectTrend, detectMarketPhase, detectGlobalTrend, detectDailyTrend, type GlobalTrend } from './analysis.js';
import { createFSM, fsmStep, shouldExitPosition } from './fsm.js';
import type {
  IMPULSE_THRESHOLDS_CONFIG,
  MarketDelta,
  MarketPhase,
  MarketSnapshot,
  MarketState,
  SymbolValue,
} from './types.js';
import { getCVDLastMinutes } from './cvdTracker.js';
import { findStopLossLevel } from './paperPositionManager.js';
import { logEvent } from './logger.js';
import { realTradeManager } from './realTradeManager.js';
import type { TradeExecutor, TradeEntryMeta } from './tradeExecutor.js';
import { tradingState } from '../core/tradingState.js';
import {
  addDailyPnlUsd,
  isOverDailyLossLimit,
  wasLimitAlertTriggeredToday,
  markLimitAlertTriggered,
} from '../core/dailyLossLimit.js';
import { STRATEGY_CONFIG } from '../config/strategyConfig.js';
import { createWatcherLogger } from './logging.js';
import type { WatcherLogWriter } from './logging.js';

// symbol -> состояние (фаза, флаги, последний алерт)
const stateBySymbol = new Map<string, MarketState>();

// symbol -> FSM instance
const tradeFSMBySymbol = new Map<string, ReturnType<typeof createFSM>>();

const ATR_PERIOD = 14;
const CSI_WINDOW = 30;
const CSI_BODY_WINDOW = 5;
const VOL_WINDOW = 30;

function computeSnapshotATR(snaps: MarketSnapshot[], period: number = ATR_PERIOD): number {
  if (snaps.length < 2) return 0;

  const windowSize = Math.max(period + 1, period * 2);
  const startIdx = Math.max(1, snaps.length - windowSize);
  const ranges: number[] = [];

  for (let i = startIdx; i < snaps.length; i++) {
    const curr = snaps[i];
    const prev = snaps[i - 1];
    if (!curr || !prev) continue;
    ranges.push(Math.abs(curr.price - prev.price));
  }

  if (ranges.length === 0) {
    return 0;
  }

  const seedLength = Math.min(period, ranges.length);
  let atr = ranges.slice(0, seedLength).reduce((sum, value) => sum + value, 0) / seedLength;

  for (let i = seedLength; i < ranges.length; i++) {
    atr = (atr * (period - 1) + ranges[i]!) / period;
  }

  return Number(atr.toFixed(6));
}

function computeSnapshotCSI(snaps: MarketSnapshot[]): number {
  if (snaps.length < 2) return 0;

  const window = snaps.slice(-CSI_WINDOW);
  if (window.length < 2) return 0;

  const bodyWindow = window.slice(-CSI_BODY_WINDOW);
  if (bodyWindow.length < 2) return 0;

  const prices = window.map(s => s.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = Math.max(maxPrice - minPrice, 1e-8);

  const bodyStart = bodyWindow[0]!;
  const bodyEnd = bodyWindow[bodyWindow.length - 1]!;
  const bodyMove = bodyEnd.price - bodyStart.price;
  const bodyRatio = Math.min(Math.abs(bodyMove) / priceRange, 1);

  const avgVolume =
    window.reduce((sum, snap) => sum + (snap.volume24h ?? 0), 0) / window.length || 0;
  const shortVolume =
    bodyWindow.reduce((sum, snap) => sum + (snap.volume24h ?? 0), 0) / bodyWindow.length || 0;
  const volumeScore =
    avgVolume > 0 ? Math.min(shortVolume / avgVolume, 3) / 3 : shortVolume > 0 ? 1 : 0;

  const direction = bodyMove >= 0 ? 1 : -1;
  const csi = direction * (bodyRatio * 0.6 + volumeScore * 0.4);

  return Number(csi.toFixed(4));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function computeSnapshotVolatility(snaps: MarketSnapshot[], window: number = VOL_WINDOW): number {
  if (snaps.length < 2) return 0;
  const windowSnaps = snaps.slice(-(window + 1));
  if (windowSnaps.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < windowSnaps.length; i++) {
    const prev = windowSnaps[i - 1];
    const curr = windowSnaps[i];
    if (!prev || !curr || !prev.price || !curr.price) continue;
    const ret = Math.log(curr.price / prev.price);
    if (Number.isFinite(ret)) {
      returns.push(ret);
    }
  }
  if (!returns.length) return 0;
  const mean = returns.reduce((sum, val) => sum + val, 0) / returns.length;
  const variance =
    returns.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
    Math.max(returns.length - 1, 1);
  const std = Math.sqrt(Math.max(variance, 0));
  return Number((std * 100).toFixed(4));
}

const { watcher: watcherConfig } = STRATEGY_CONFIG;
const MIN_MOVE_THRESHOLD = watcherConfig.minMoveThreshold;
const MAX_MOVE_THRESHOLD_MULTIPLIER = watcherConfig.maxMoveThresholdMultiplier;

function deriveAdaptiveMoveThreshold(base: number, realizedVol: number): number {
  if (!Number.isFinite(base) || base <= 0) {
    return base;
  }
  if (!Number.isFinite(realizedVol) || realizedVol <= 0) {
    const fallback = base * 0.5;
    return Number(
      clamp(fallback, MIN_MOVE_THRESHOLD, base * MAX_MOVE_THRESHOLD_MULTIPLIER).toFixed(3)
    );
  }
  const ratio = realizedVol / base;
  const multiplier = clamp(ratio, 0.5, 1.4);
  const adjusted = base * multiplier;
  const clamped = clamp(adjusted, MIN_MOVE_THRESHOLD, base * MAX_MOVE_THRESHOLD_MULTIPLIER);
  return Number(clamped.toFixed(3));
}

type SnapshotThresholds = {
  moveThreshold: number;
  cvdThreshold: number;
  oiThreshold: number;
  impulse: IMPULSE_THRESHOLDS_CONFIG;
};

type SnapshotWithThresholds = MarketSnapshot & { thresholds: SnapshotThresholds };

export interface PhaseLogEvent {
  symbol: string;
  timestamp: number;
  price: number;
  phase: MarketPhase;
  has30m: boolean;
  inputs: {
    delta30m: MarketDelta;
    delta15m: MarketDelta;
    delta5m: MarketDelta;
    cvd30m: number;
    settings: {
      moveThreshold: number;
      baseMoveThreshold?: number;
      cvdThreshold: number;
      oiThreshold: number;
      realizedVol?: number;
    };
  };
}

interface WatcherOptions {
  tradeExecutor?: TradeExecutor;
  snapshotProvider?: (symbol: string) => Promise<MarketSnapshot | null>;
  balanceProvider?: () => Promise<number>;
  intervalMs?: number;
  enableRealtime?: boolean;
  warmupSnapshots?: MarketSnapshot[];
  onComplete?: () => void;
  entryMode?: 'adaptive' | 'classic';
  cvdProvider?: (symbol: string, minutes: number, referenceTs: number) => number;
  phaseLogger?: (event: PhaseLogEvent) => void;
  logWriter?: WatcherLogWriter;
  /** Вызывается при достижении дневного лимита убытка (−10$). Бот отключает новые сделки; открытые позиции не закрываются. */
  onDailyLossLimitReached?: () => void | Promise<void>;
}

// =====================
// Initialize watchers
// =====================
export async function initializeMarketWatcher(
  onAlert: (msg: string) => void,
  options: WatcherOptions = {}
) {
  const symbols = await getTopLiquidSymbols(COINS_COUNT);
  console.log(`🔄 Tracking ${symbols.length} symbols`);

  const tradeExecutor = options.tradeExecutor ?? realTradeManager;
  try {
    await tradeExecutor.bootstrap(symbols);
  } catch (e) {
    console.error('[WATCHER] tradeExecutor.bootstrap failed:', e);
  }

  const handles = await Promise.all(
    symbols.map(symbol =>
      startMarketWatcher(symbol, msg => onAlert(msg), { ...options, tradeExecutor })
    )
  );

  if (options.enableRealtime ?? true) {
    ws.subscribeV5(
      symbols.map(s => `publicTrade.${s}`),
      'linear'
    );
  }

  return () =>
    handles.forEach(handle => {
      if (handle) clearInterval(handle);
    });
}

// =====================
// Single symbol watcher
// =====================
export async function startMarketWatcher(
  symbol: string,
  onAlert: (msg: string) => void,
  options: WatcherOptions = {}
) {
  const tradeExecutor = options.tradeExecutor ?? realTradeManager;
  const balanceProvider = options.balanceProvider ?? getCurrentBalance;
  const fetchSnapshot = options.snapshotProvider ?? (async (s: string) => getMarketSnapshot(s));
  const customCvdProvider = options.cvdProvider;
  const INTERVAL = options.intervalMs ?? INTERVALS.ONE_MIN;
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as any);
  const entryMode = options.entryMode ?? 'adaptive';
  const useSnapshotTime = options.enableRealtime === false;
  const coinThresholds = selectCoinThresholds(symbol as SymbolValue);
  const scopedLogger = createWatcherLogger(options.logWriter, `[${symbol}]`);
  const log = (...args: unknown[]) => {
    if (options.logWriter) {
      scopedLogger(...args);
    } else {
      console.log(...args);
    }
  };
  type SnapshotThresholds = {
    moveThreshold: number;
    cvdThreshold: number;
    oiThreshold: number;
    impulse: IMPULSE_THRESHOLDS_CONFIG;
  };
  type SnapshotWithThresholds = MarketSnapshot & { thresholds: SnapshotThresholds };
  const buildThresholds = (): SnapshotThresholds => {
    return {
      moveThreshold: BASE_IMPULSE_THRESHOLDS.PRICE_SURGE_PCT,
      cvdThreshold: BASE_IMPULSE_THRESHOLDS.VOLUME_HIGH_PCT,
      oiThreshold: coinThresholds.oiThreshold,
      impulse: {
        PRICE_SURGE_PCT: BASE_IMPULSE_THRESHOLDS.PRICE_SURGE_PCT,
        VOL_SURGE_CVD: BASE_IMPULSE_THRESHOLDS.VOLUME_HIGH_PCT,
        OI_INCREASE_PCT: isPriorityCoin
          ? LIQUID_IMPULSE_THRESHOLDS.OI_INCREASE_PCT
          : BASE_IMPULSE_THRESHOLDS.OI_INCREASE_PCT,
        OI_SURGE_PCT: isPriorityCoin
          ? LIQUID_IMPULSE_THRESHOLDS.OI_SURGE_PCT
          : BASE_IMPULSE_THRESHOLDS.OI_SURGE_PCT,
      },
    };
  };
  const ensureSnapshotThresholds = (snap: MarketSnapshot): SnapshotWithThresholds => {
    snap.thresholds = { ...(snap.thresholds ?? {}), ...buildThresholds() };
    return snap as SnapshotWithThresholds;
  };

  console.log(`🚀 Отслеживание рынка запущено для ${symbol}`);

  // Bollinger (adaptive) — только 1h свечи, 1m прелоад не нужен; классика — полный прелоад снапшотов
  const snapshots =
    options.warmupSnapshots ??
    (entryMode === 'adaptive'
      ? []
      : await preloadMarketSnapshots(symbol));

  for (const snap of snapshots) {
    const normalized = ensureSnapshotThresholds(snap);
    saveSnapshot(normalized); // ТВОЯ существующая функция
  }

  let intervalId: NodeJS.Timeout | null = null;
  /** Время последней синхронизации позиции с биржей (для обнаружения закрытия стопом/ликвидацией). */
  let lastOpenPositionSyncAt = 0;
  const tick = async () => {
    try {
      const logData: Record<string, any> = {};
      const rawSnap = await fetchSnapshot(symbol);
      if (!rawSnap) {
        return false;
      }
      const now = useSnapshotTime ? rawSnap.timestamp : Date.now();
      const referenceTs = rawSnap.timestamp;
      const cvdFieldMap: Record<number, keyof MarketSnapshot> = {
        1: 'cvd1m',
        3: 'cvd3m',
        15: 'cvd15m',
        30: 'cvd30m',
      };

      const cvdLookup = (minutes: number) => {
        const recordedField = cvdFieldMap[minutes];
        if (recordedField) {
          const recordedValue = rawSnap[recordedField];
          if (typeof recordedValue === 'number') {
            return recordedValue;
          }
        }

        if (customCvdProvider) {
          return customCvdProvider(symbol, minutes, referenceTs);
        }

        return getCVDLastMinutes(symbol, minutes);
      };
      const cvd1m = cvdLookup(1);
      const cvd3m = cvdLookup(3);
      const cvd15m = cvdLookup(15);
      const cvd30m = cvdLookup(30);
      const snap = ensureSnapshotThresholds({
        ...rawSnap,
        cvd1m,
        cvd3m,
        cvd15m,
        cvd30m,
      });
      const snapTimeLabel = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
      log(`[SNAP] ${symbol} @ ${snapTimeLabel} (ts=${snap.timestamp}) price=${snap.price}`);
      saveSnapshot(snap);
      logData.cvd = {
        cvd1m,
        cvd3m,
        cvd15m,
        symbol,
        ts: snap.timestamp,
        price: snap.price,
        type: 'snapshot',
      };

      // =====================
      // FSM Integration
      // =====================
      // Get or create FSM for this symbol
      if (!tradeFSMBySymbol.has(symbol)) {
        tradeFSMBySymbol.set(symbol, createFSM());
      }
      const fsm = tradeFSMBySymbol.get(symbol)!;

      const restoredPos = tradeExecutor.getPosition(symbol);
      if (restoredPos && fsm.state !== 'OPEN') {
        fsm.state = 'OPEN';
        fsm.side = restoredPos.side;
        fsm.entryPrice = restoredPos.entryPrice;
        fsm.openedAt = restoredPos.entryTime ?? Date.now();
      }

      const habrMode = entryMode === 'adaptive' && adaptiveBollingerStrategy.isSupported(symbol);
      const snaps = getSnapshots(symbol);
      if (!habrMode && snaps.length < 15) return true;
      if (habrMode && snaps.length < 2) return true; // нужен минимум 2 снапа для prev и дельт

      // 1m импульс — сравнение с предыдущим снапом
      const prev = snaps[snaps.length - 2];
      if (!prev) return true;
      const delta = compareSnapshots(snap, prev);

      // Окна для структуры
      const snaps15m = snaps.slice(-15);
      const snaps30m = snaps.slice(-30);
      const snaps5m = snaps.slice(-5);

      // Проверяем, что действительно есть 15/30 минут истории,
      // а не 3–5 минут после рестарта.
      const has30m = snaps30m.length >= 30;

      const snap15 = snaps15m[0];
      const snap30 = snaps30m[0];
      const snap5 = snaps5m[0];
      if (!snap15 || !snap30 || !snap5) return true;
      const delta15m = compareSnapshots(snap, snap15);
      const delta30m = compareSnapshots(snap, snap30);
      const delta5m = compareSnapshots(snap, snap5);

      logData.delta = {
        delta15m,
        delta30m,
        delta5m,
      };

      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);
      logData.rsi = rsi;
      logData.priceHistoryLen = priceHistory.length;

      // 🚨 GLOBAL TREND DETECTION (EMA50 vs EMA200)
      // Нужно минимум 200 снапшотов для надёжного определения
      const globalTrend: GlobalTrend = detectGlobalTrend(snaps);
      logData.globalTrend = globalTrend;
      log(`[GLOBAL_TREND] ${symbol}: ${globalTrend} (snaps: ${snaps.length})`);

      // 🚨 DAILY TREND DETECTION (изменение цены с начала дня)
      // Более чувствителен к краткосрочным движениям
      const dailyTrend: GlobalTrend = detectDailyTrend(snaps);
      logData.dailyTrend = dailyTrend;
      log(`[DAILY_TREND] ${symbol}: ${dailyTrend} (snaps: ${snaps.length})`);

      const trendObj = {
        isBull: false,
        isBear: false,
      };

      if (has30m) {
        const { isBull, isBear } = detectTrend({ ...delta30m, symbol });
        trendObj.isBear = isBear;
        trendObj.isBull = isBull;
      }

      let state = stateBySymbol.get(symbol);
      if (!state) {
        state = { phase: 'range', lastAlertAt: 0, flags: {} };
        stateBySymbol.set(symbol, state);
      }

      // calcPercentChange() опирается на свечи из trade-stream и часто даёт 0 при недостатке истории.
      // Для сигнальной логики надёжнее использовать изменения цены по снапшотам.
      const pricePercentChange = delta15m.priceChangePct;
      const thresholds = snap.thresholds!;
      const baseMoveThreshold = thresholds.moveThreshold;
      const baseCvdThreshold = thresholds.cvdThreshold;
      const baseOiThreshold = thresholds.oiThreshold;
      const impulse = thresholds.impulse;
      const realizedVol = computeSnapshotVolatility(snaps);
      const moveThreshold = deriveAdaptiveMoveThreshold(baseMoveThreshold, realizedVol);
      const volRatio =
        Number.isFinite(realizedVol) && realizedVol > 0 && baseMoveThreshold > 0
          ? clamp(realizedVol / baseMoveThreshold, 0.7, 1.3)
          : 1;
      const cvdThreshold = Number((baseCvdThreshold * clamp(1 / volRatio, 0.75, 1.25)).toFixed(0));
      const oiThreshold = Number((baseOiThreshold * clamp(volRatio, 0.8, 1.2)).toFixed(3));
      state.phase = has30m
        ? detectMarketPhase({
            delta30m,
            delta15m,
            delta5m,
            cvd30m,
            settings: {
              moveThreshold,
              cvdThreshold,
              oiThreshold,
            },
          })
        : 'range';

      if (has30m && options.phaseLogger) {
        options.phaseLogger({
          symbol,
          timestamp: snap.timestamp,
          price: snap.price,
          phase: state.phase,
          has30m,
          inputs: {
            delta30m: { ...delta30m },
            delta15m: { ...delta15m },
            delta5m: { ...delta5m },
            cvd30m,
            settings: {
              moveThreshold,
              baseMoveThreshold,
              cvdThreshold,
              oiThreshold,
              realizedVol,
            },
          },
        });
      }

      logData.phase = state.phase;
      logData.pricePercentChange = pricePercentChange;
      logData.thresholds = {
        cvdThreshold,
        moveThreshold,
        baseMoveThreshold,
        oiThreshold,
        realizedVol,
        baseOiThreshold,
        baseCvdThreshold,
      };
      logData.fundingRate = snap.fundingRate;

      // =====================
      // Entry Signal Calculation (classic vs Habr)
      // =====================
      let entrySignal: string;
      let longScore = 0;
      let shortScore = 0;
      let details: Record<string, unknown> | undefined;
      let signal = 'NONE';
      let impulseForClassic: {
        PRICE_SURGE_PCT: number;
        VOL_SURGE_CVD: number;
        OI_INCREASE_PCT: number;
        OI_SURGE_PCT: number;
      } | null = null;

      if (habrMode) {
        try {
          const end = Math.floor(Date.now() / 3600000) * 3600000;
          const start = end - 200 * 3600 * 1000;
          const candles1h = await fetchBybitCandles({ symbol, start, end, interval: '60' });
          if (candles1h.length) {
            ingest1hCandles(symbol, candles1h);
            log(`[1h] ${symbol} synced ${candles1h.length} candles`);
          }
        } catch (e) {
          log(`[1h sync] ${symbol} failed:`, e);
        }
        const adaptive = adaptiveBollingerStrategy.getSignal(symbol);
        entrySignal = adaptive.entrySignal;
        longScore = adaptive.longScore;
        shortScore = adaptive.shortScore;
        signal = adaptive.signal;
        details = adaptive.details;
        logData.habr = { ready: adaptive.ready };
      } else {
        impulseForClassic = impulse;

        const classicScores = calculateEntryScores({
          state,
          delta,
          delta15m,
          delta30m,
          delta5m,
          snap,
          cvd3m: cvd3m || 0,
          cvd15m: cvd15m || 0,
          rsi: rsi || 50,
          isBull: trendObj.isBull,
          isBear: trendObj.isBear,
          impulse: impulseForClassic,
          globalTrend,
        });

        entrySignal = classicScores.entrySignal;
        longScore = classicScores.longScore;
        shortScore = classicScores.shortScore;
        details = classicScores.details;

        signal = getSignalAgreement({
          longScore,
          shortScore,
          phase: state.phase,
          pricePercentChange,
          moveThreshold,
          cvd15m: cvd15m || 0,
          cvdThreshold,
          fundingRate: Number(snap.fundingRate || 0),
          rsi,
          symbol,
          globalTrend,
        });
      }

      logData.scores = { longScore, shortScore };
      logData.details = details;
      log(`${symbol}: 0) entrySignal: ${entrySignal} ${JSON.stringify(details)}`);
      if (habrMode && entrySignal === 'NO SETUP') {
        const { signalThreshold, scoreGap } = STRATEGY_CONFIG.adaptiveBollinger;
        const need = `need L or S ≥ ${signalThreshold}, gap ≥ ${scoreGap}`;
        const atBand = longScore >= 35 || shortScore >= 35 ? '' : ' (цена не у полосы — нет 35 баллов)';
        log(`[Bollinger NO_SETUP] ${symbol} L=${longScore} S=${shortScore} (${need})${atBand} | distancePct=${(details as any)?.distancePct != null ? ((details as any).distancePct * 100).toFixed(2) + '%' : '?'} emaBias=${(details as any)?.emaBias != null ? ((details as any).emaBias * 100).toFixed(2) + '%' : '?'} bearCluster=${(details as any)?.bearCluster ?? '?'}`);
      }

      // =====================
      // Signal Agreement Check
      // =====================
      logData.signal = signal;

      log(`0.1) signal is: ${signal}`);

      logData.fsm = {
        state: fsm.state,
        side: fsm.side,
      };
      log(`1) FSM: ${JSON.stringify(fsm)}`);
      let confirmed = false;
      // Step the FSM

      // Legacy confirmation check for backward compatibility
      if (habrMode) {
        confirmed = adaptiveBollingerStrategy.confirmEntry(
          symbol,
          signal as 'LONG' | 'SHORT' | 'NONE',
          globalTrend, // Передаем глобальный тренд для фильтрации SHORT при BULLISH тренде
          dailyTrend   // Передаем дневной тренд для дополнительной защиты от краткосрочных движений
        );
      } else if (signal === 'LONG' || signal === 'SHORT') {
        confirmed = confirmEntry({
          signal,
          delta: delta5m,
          cvd3m: cvd3m || 0,
          impulse: impulseForClassic!,
          phase: state.phase,
          confirmedAt: snap.timestamp,
        });
        log(`2) confirmed value: ${confirmed}`);
        if (confirmed) {
          const confirmTime = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
          log(
            `[CONFIRM_ENTRY] timestamp=${confirmTime} (ts=${snap.timestamp}) | price=${snap.price}`
          );
        }
      }

      // Периодическая проверка позиции на бирже: если локально OPEN, но на бирже позиции нет — закрыли стопом/ликвидацией
      let closedExternallyPos: ReturnType<TradeExecutor['getPosition']> = undefined;
      if (
        fsm.state === 'OPEN' &&
        tradeExecutor.hasPosition(symbol) &&
        typeof tradeExecutor.syncPositionFromExchange === 'function' &&
        now - lastOpenPositionSyncAt >= SYNC_OPEN_POSITION_INTERVAL_MS
      ) {
        closedExternallyPos = tradeExecutor.getPosition(symbol);
        try {
          await tradeExecutor.syncPositionFromExchange(symbol);
        } catch (e) {
          console.error(`[WATCHER] syncPositionFromExchange failed (${symbol}):`, e);
          closedExternallyPos = undefined;
        }
        lastOpenPositionSyncAt = now;
      }

      const hadPending = tradeExecutor.hasPending(symbol);
      if (hadPending) {
        try {
          await tradeExecutor.syncSymbol(symbol);
        } catch (e) {
          console.error(`[WATCHER] syncSymbol failed (${symbol}):`, e);
        }
      }

      const hasOpen = tradeExecutor.hasPosition(symbol);

      // Позиция была закрыта на бирже (стоп/ликвидация) — шлём алерт и сбрасываем FSM
      if (closedExternallyPos && !hasOpen) {
        const exitPrice = snap.price;
        const pnl =
          (
            ((exitPrice - closedExternallyPos.entryPrice) / closedExternallyPos.entryPrice) *
            (closedExternallyPos.side === 'LONG' ? 100 : -100)
          ).toFixed(2);
        const pnlUsd =
          closedExternallyPos.side === 'LONG'
            ? closedExternallyPos.qty * (exitPrice - closedExternallyPos.entryPrice)
            : closedExternallyPos.qty * (closedExternallyPos.entryPrice - exitPrice);
        addDailyPnlUsd(pnlUsd, now);
        const durationMs = now - closedExternallyPos.entryTime;
        const durationHours = (durationMs / (60 * 60 * 1000)).toFixed(1);
        const entryTimeStr = dayjs(closedExternallyPos.entryTime).format('HH:mm:ss');
        log(
          `[TRADE] ⚪ EXIT (на бирже) ${closedExternallyPos.side} for ${symbol} | PnL: ${pnl}% | Причина: стоп/ликвидация на бирже`
        );
        try {
          const stopLossInfo = Number.isFinite(closedExternallyPos.stopLoss)
            ? `\nСтоп-лосс: ${closedExternallyPos.stopLoss.toFixed(4)}`
            : '';
          const alertMsg =
            `⚪ *${symbol}: ПОЗИЦИЯ ЗАКРЫТА НА БИРЖЕ*\n` +
            `(стоп-лосс или ликвидация)\n` +
            `Результат: *${pnl}%* ${Number(pnl) > 0 ? '✅' : '❌'}\n` +
            `Вход: ${closedExternallyPos.entryPrice.toFixed(4)} (${entryTimeStr})\n` +
            `Выход: ${exitPrice.toFixed(4)}\n` +
            `Длительность: ${durationHours}ч${stopLossInfo}`;
          await Promise.resolve(onAlert(alertMsg));
        } catch (alertErr) {
          console.error(`❌ [${symbol}] Не удалось отправить алерт о закрытии на бирже:`, alertErr);
        }
        if (isOverDailyLossLimit() && !wasLimitAlertTriggeredToday() && options.onDailyLossLimitReached) {
          markLimitAlertTriggered();
          await Promise.resolve(options.onDailyLossLimitReached());
        }
        fsm.state = 'IDLE';
        fsm.side = null;
        fsm.openedAt = undefined;
        fsm.lastExitAt = now;
        return true;
      }
      const hasExposure = tradeExecutor.hasExposure(symbol);

      const currentPos = tradeExecutor.getPosition(symbol);

      log(`3) currentPos: ${JSON.stringify(currentPos)}`);

      const atr = computeSnapshotATR(snaps, ATR_PERIOD);
      const csi = computeSnapshotCSI(snaps);

      let exitCheck: { exit: boolean; reason: string };
      if (habrMode && fsm.state === 'OPEN' && currentPos) {
        const ctx = adaptiveBollingerStrategy.getContext(symbol);
        const meanTol = STRATEGY_CONFIG.adaptiveBacktest.meanExitTolerance;
        const entryPrice = currentPos.entryPrice;
        const pctMove = (snap.price - entryPrice) / entryPrice;
        const catastrophicPct = STRATEGY_CONFIG.adaptiveBacktest.catastrophicStopPct ?? 0.07;
        const catastrophic =
          (currentPos.side === 'LONG' && pctMove < -catastrophicPct) ||
          (currentPos.side === 'SHORT' && pctMove > catastrophicPct);
        let meanExit = false;
        if (ctx && Number.isFinite(ctx.middle)) {
          if (currentPos.side === 'LONG' && snap.price >= ctx.middle * (1 - meanTol)) meanExit = true;
          if (currentPos.side === 'SHORT' && snap.price <= ctx.middle * (1 + meanTol)) meanExit = true;
        }
        exitCheck = {
          exit: catastrophic || meanExit,
          reason: catastrophic ? 'STOP' : meanExit ? 'MEAN' : 'NONE',
        };
      } else {
        exitCheck =
          fsm.state === 'OPEN' && currentPos
            ? shouldExitPosition({
                fsm,
                snapshot: snap,
                now,
                entryPrice: currentPos.entryPrice,
                longScore,
                shortScore,
                phase: state.phase,
                atr,
              })
            : { exit: false, reason: 'NONE' as const };
      }

      const exitSignal = exitCheck.exit;
      const exitReason = exitCheck.reason;

      const { action } = fsmStep(fsm, {
        signal,
        confirmed,
        exitSignal,
        now,
      });

      logData.confirmed = confirmed;
      logData.action = action;
      logData.position = {
        hasOpen,
        hasExposure,
        hadPending,
      };
      logData.exitCheck = {
        exitSignal,
        exitReason,
      };

      if (action === 'ENTER_MARKET' && hasExposure) {
        logData.entrySkipReason = 'HAS_EXPOSURE';
      }

      logEvent(logData);

      log(`4) ACTION IS: ${JSON.stringify(action)}`);
      // =====================
      // Actions
      // =====================

      // 2. ВХОД В ПОЗИЦИЮ (ENTER_MARKET)
      // Важно: проверяем экшен ENTER_MARKET из нашего нового FSM
      if (action === 'ENTER_MARKET' && !hasExposure) {
        if (!tradingState.allowNewEntries()) {
          log(
            tradingState.isCloseOnlyMode()
              ? '[WATCHER] Close-only mode — skip ENTER_MARKET (текущие закрываются по стратегии)'
              : '[WATCHER] Trading disabled — skip ENTER_MARKET'
          );
          logData.entrySkipReason = tradingState.isCloseOnlyMode()
            ? 'CLOSE_ONLY_MODE'
            : 'TRADING_DISABLED';
          logEvent(logData);
          return; // ← выход ТОЛЬКО из текущей итерации символа
        }
        // Сохраняем цену входа в контекст FSM (нужно для расчета PnL в shouldExitPosition)
        fsm.entryPrice = snap.price;

        let stopPrice: number | undefined;
        if (habrMode) {
          const ctx = adaptiveBollingerStrategy.getContext(symbol);
          if (ctx && Number.isFinite(ctx.atr) && ctx.atr > 0) {
            const mult = STRATEGY_CONFIG.adaptiveBacktest.stopAtrMult;
            stopPrice =
              fsm.side === 'LONG'
                ? snap.price - ctx.atr * mult
                : snap.price + ctx.atr * mult;
          }
        } else {
          stopPrice = findStopLossLevel(snaps, fsm.side!, state.phase === 'trend' ? 15 : 30);
        }
        if (!stopPrice || stopPrice <= 0) {
          log(habrMode ? 'Bollinger: нет 1h ATR' : 'Не сформирован стоплосс!');
          logData.entrySkipReason = 'NO_STOPLOSS';
          logEvent(logData);
          return;
        }

        const balance = await balanceProvider();

        const entryMeta: TradeEntryMeta = {
          longScore,
          shortScore,
          entrySignal,
          signal,
        };

        const success = await tradeExecutor.openPosition({
          symbol,
          side: fsm.side!,
          price: snap.price,
          stopPrice,
          balance,
          now,
          entryMeta,
        });

        if (success) {
          const entryTimeStr = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
          log(
            `[TRADE] 🚀 ENTER ${fsm.side} for ${symbol} | Phase: ${state.phase} | Balance: ${balance} | Time: ${entryTimeStr}`
          );
          try {
            await Promise.resolve(
              onAlert(
                `✅ *${symbol}: ВХОД В СДЕЛКУ*\n` +
                  `Тип: ${fsm.side === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴'}\n` +
                  `Фаза: *${state.phase.toUpperCase()}*\n` +
                  `Цена: ${snap.price}\n` +
                  `Score: L:${longScore} S:${shortScore}`
              )
            );
          } catch (alertErr) {
            console.error(`❌ [${symbol}] Не удалось отправить алерт о входе:`, alertErr);
          }
          state.lastConfirmationAt = now;
        } else {
          console.warn(
            `[TRADE] ❌ ENTER FAILED for ${symbol} | side=${fsm.side} | Phase=${state.phase} | balance=${balance}`
          );
          // Если не зашли (проскальзывание), сбрасываем FSM, чтобы не висел
          fsmStep(fsm, { signal: 'NONE', confirmed: false, now, exitSignal: true });
        }
      }

      // 3. ВЫХОД ИЗ ПОЗИЦИИ (EXIT_MARKET)
      // ВЫХОД ИЗ ПОЗИЦИИ
      if (action === 'EXIT_MARKET' && hasOpen) {
        const pos = tradeExecutor.getPosition(symbol);

        const effectiveExitReason = exitSignal ? exitReason : 'MAX_POSITION_DURATION';

        logData.exit = {
          reason: effectiveExitReason,
          pnlPct:
            pos && Number.isFinite(pos.entryPrice)
              ? ((snap.price - pos.entryPrice) / pos.entryPrice) *
                (pos.side === 'LONG' ? 100 : -100)
              : null,
          currentPrice: snap.price,
          entryPrice: pos?.entryPrice ?? null,
          side: pos?.side ?? null,
        };

        // ВАЖНО: Добавляем await
        await tradeExecutor.closePosition(symbol, {
          price: snap.price,
          now,
          reason: effectiveExitReason,
        });

        const exitPrice = snap.price;
        const pnl = pos
          ? (
              ((exitPrice - pos.entryPrice) / pos.entryPrice) *
              (pos.side === 'LONG' ? 100 : -100)
            ).toFixed(2)
          : '0';

        if (pos && Number.isFinite(pos.qty)) {
          const pnlUsd =
            pos.side === 'LONG'
              ? pos.qty * (exitPrice - pos.entryPrice)
              : pos.qty * (pos.entryPrice - exitPrice);
          addDailyPnlUsd(pnlUsd, now);
        }

        const entryTimeStr = pos?.entryTime
          ? dayjs(pos.entryTime).format('YYYY-MM-DD HH:mm:ss')
          : dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
        const closeTimeStr = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');

        log(
          `[TRADE] ⚪ EXIT ${pos?.side ?? 'UNKNOWN'} for ${symbol} | PnL: ${pnl}% | Reason: ${effectiveExitReason} | Price: ${exitPrice}` +
            ` | Opened: ${entryTimeStr} | Closed: ${closeTimeStr}`
        );

        try {
          const alertMsg =
            `⚪ *${symbol}: ЗАКРЫТИЕ ПОЗИЦИИ*\n` +
            `Результат: *${pnl}%* ${Number(pnl) > 0 ? '✅' : '❌'}\n` +
            `Причина: *${effectiveExitReason}*\n` +
            `Цена: ${exitPrice}\n`;
          await Promise.resolve(onAlert(alertMsg));
        } catch (alertErr) {
          console.error(`❌ [${symbol}] Не удалось отправить алерт о закрытии:`, alertErr);
        }

        if (isOverDailyLossLimit() && !wasLimitAlertTriggeredToday() && options.onDailyLossLimitReached) {
          markLimitAlertTriggered();
          await Promise.resolve(options.onDailyLossLimitReached());
        }
      }

      // 4. ОБРАБОТКА ОТМЕНЫ (Если сетап не подтвердился)
      if (['CANCEL_SETUP', 'TIMEOUT_SETUP', 'CANCEL_CONFIRM'].includes(action)) {
        log(`[FSM] Setup cancelled: ${action}`);
        // Можно не слать алерты на каждое затишье, чтобы не спамить в Telegram
      }
      return true;
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
      return false;
    }
  };

  const isRealtime = options.enableRealtime ?? true;

  if (!isRealtime) {
    while (await tick()) {
      // continue until snapshots exhausted
    }
    options.onComplete?.();
    return null;
  }

  const first = await tick();
  if (!first) {
    options.onComplete?.();
    return null;
  }

  function scheduleNext() {
    intervalId = setTimeout(async () => {
      const ok = await tick();
      if (!ok) {
        if (intervalId) clearTimeout(intervalId);
        options.onComplete?.();
        return;
      }
      scheduleNext();
    }, INTERVAL);
  }
  scheduleNext();
  return intervalId;
}
