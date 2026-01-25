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
} from './constants.market.js';
import {
  calculateEntryScores,
  getSignalAgreement,
  confirmEntry,
  selectCoinThresholds,
} from './utils.js';
import { adaptiveBollingerStrategy } from './adaptiveBollingerStrategy.js';
import { calculateRSI, detectTrend, detectMarketPhase } from './analysis.js';
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
import type { TradeExecutor } from './tradeExecutor.js';
import { tradingState } from '../core/tradingState.js';
import { STRATEGY_CONFIG } from '../config/strategyConfig.js';

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
  const entryMode = options.entryMode ?? 'classic';
  const useSnapshotTime = options.enableRealtime === false;
  const coinThresholds = selectCoinThresholds(symbol as SymbolValue);
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

  const snapshots = options.warmupSnapshots ?? (await preloadMarketSnapshots(symbol));

  for (const snap of snapshots) {
    const normalized = ensureSnapshotThresholds(snap);
    saveSnapshot(normalized); // ТВОЯ существующая функция
  }

  let intervalId: NodeJS.Timeout | null = null;
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
      console.log(`[SNAP] ${symbol} @ ${snapTimeLabel} (ts=${snap.timestamp}) price=${snap.price}`);
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

      const snaps = getSnapshots(symbol);
      if (snaps.length < 15) return true;

      // 1m импульс — сравнение с предыдущим снапом
      const prev = snaps[snaps.length - 2];
      const delta = compareSnapshots(snap, prev!);

      // Окна для структуры
      const snaps15m = snaps.slice(-15);
      const snaps30m = snaps.slice(-30);
      const snaps5m = snaps.slice(-5);

      // Проверяем, что действительно есть 15/30 минут истории,
      // а не 3–5 минут после рестарта.
      const has30m = snaps30m.length >= 30;

      const delta15m = compareSnapshots(snap, snaps15m[0]!);
      const delta30m = compareSnapshots(snap, snaps30m[0]!);
      const delta5m = compareSnapshots(snap, snaps5m[0]!);

      logData.delta = {
        delta15m,
        delta30m,
        delta5m,
      };

      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);
      logData.rsi = rsi;
      logData.priceHistoryLen = priceHistory.length;

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
      const habrMode = entryMode === 'adaptive' && adaptiveBollingerStrategy.isSupported(symbol);

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
        });
      }

      logData.scores = { longScore, shortScore };
      logData.details = details;
      console.log(`${symbol}: `, '0) entrySignal:', entrySignal, JSON.stringify(details));

      // =====================
      // Signal Agreement Check
      // =====================
      logData.signal = signal;

      console.log('==============================================');
      console.log('0.1) signal is:', signal);

      logData.fsm = {
        state: fsm.state,
        side: fsm.side,
      };
      console.log('1) FSM:', JSON.stringify(fsm));
      let confirmed = false;
      // Step the FSM

      // Legacy confirmation check for backward compatibility
      if (habrMode) {
        confirmed = adaptiveBollingerStrategy.confirmEntry(
          symbol,
          signal as 'LONG' | 'SHORT' | 'NONE'
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
        console.log('2) confirmed value:', confirmed);
        if (confirmed) {
          const confirmTime = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
          console.log(
            `[CONFIRM_ENTRY] timestamp=${confirmTime} (ts=${snap.timestamp}) | price=${snap.price}`
          );
        }
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
      const hasExposure = tradeExecutor.hasExposure(symbol);

      const currentPos = tradeExecutor.getPosition(symbol);

      console.log('3) currentPos:', JSON.stringify(currentPos));

      const atr = computeSnapshotATR(snaps, ATR_PERIOD);
      const csi = computeSnapshotCSI(snaps);

      const exitCheck =
        fsm.state === 'OPEN' && currentPos
          ? shouldExitPosition({
              fsm,
              snapshot: snap,
              now,
              entryPrice: currentPos.entryPrice, // Берем реальную цену входа
              longScore,
              shortScore,
              phase: state.phase,
            })
          : { exit: false, reason: 'NONE' as const };

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

      console.log('4) ACTION IS:', JSON.stringify(action));
      // =====================
      // Actions
      // =====================

      // 2. ВХОД В ПОЗИЦИЮ (ENTER_MARKET)
      // Важно: проверяем экшен ENTER_MARKET из нашего нового FSM
      if (action === 'ENTER_MARKET' && !hasExposure) {
        if (!tradingState.isEnabled()) {
          console.log('[WATCHER] Trading disabled — skip ENTER_MARKET');
          logData.entrySkipReason = 'TRADING_DISABLED';
          logEvent(logData);
          return; // ← выход ТОЛЬКО из текущей итерации символа
        }
        // Сохраняем цену входа в контекст FSM (нужно для расчета PnL в shouldExitPosition)
        fsm.entryPrice = snap.price;

        const stopPrice = findStopLossLevel(snaps, fsm.side!, state.phase === 'trend' ? 15 : 30);

        if (!stopPrice) {
          console.log('Не сформирован стоплосс!');
          logData.entrySkipReason = 'NO_STOPLOSS';
          logEvent(logData);
          return;
        }

        const balance = await balanceProvider();

        const success = await tradeExecutor.openPosition({
          symbol,
          side: fsm.side!,
          price: snap.price,
          stopPrice,
          balance,
          now,
          entryMeta: {
            longScore,
            shortScore,
            entrySignal,
            signal,
          },
        });

        if (success) {
          const entryTimeStr = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
          console.log(
            `[TRADE] 🚀 ENTER ${fsm.side} for ${symbol} | Phase: ${state.phase} | Balance: ${balance} | Time: ${entryTimeStr}`
          );
          onAlert(
            `✅ *${symbol}: ВХОД В СДЕЛКУ*\n` +
              `Тип: ${fsm.side === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴'}\n` +
              `Фаза: *${state.phase.toUpperCase()}*\n` + // Видим фазу
              `Цена: ${snap.price}\n` +
              `Score: L:${longScore} S:${shortScore}`
          );
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

        debugger;

        // ВАЖНО: Добавляем await
        await tradeExecutor.closePosition(symbol, {
          price: snap.price,
          now,
          reason: effectiveExitReason,
        });

        const pnl = pos
          ? (
              ((snap.price - pos.entryPrice) / pos.entryPrice) *
              (pos.side === 'LONG' ? 100 : -100)
            ).toFixed(2)
          : '0';

        const entryTimeStr = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
        const closeTimeStr = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');

        console.log(
          `[TRADE] ⚪ EXIT ${pos?.side ?? 'UNKNOWN'} for ${symbol} | PnL: ${pnl}% | Reason: ${effectiveExitReason} | Price: ${snap.price}` +
            ` | Opened: ${entryTimeStr} | Closed: ${closeTimeStr}`
        );

        onAlert(
          `⚪ *${symbol}: ЗАКРЫТИЕ ПОЗИЦИИ*\n` +
            `Результат: *${pnl}%* ${Number(pnl) > 0 ? '✅' : '❌'}\n` +
            `Причина: *${effectiveExitReason}*\n` +
            `Цена: ${snap.price}\n`
        );
      }

      // 4. ОБРАБОТКА ОТМЕНЫ (Если сетап не подтвердился)
      if (['CANCEL_SETUP', 'TIMEOUT_SETUP', 'CANCEL_CONFIRM'].includes(action)) {
        console.log(`[FSM] Setup cancelled: ${action}`);
        // Можно не слать алерты на каждое затишье, чтобы не спамить в Telegram
      }
      console.log('==============================================');
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

  intervalId = setInterval(async () => {
    const ok = await tick();
    if (!ok && intervalId) {
      clearInterval(intervalId);
      options.onComplete?.();
    }
  }, INTERVAL);
  return intervalId;
}
