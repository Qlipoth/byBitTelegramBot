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

// symbol -> состояние (фаза, флаги, последний алерт)
const stateBySymbol = new Map<string, MarketState>();

// symbol -> FSM instance
const tradeFSMBySymbol = new Map<string, ReturnType<typeof createFSM>>();

const ATR_PERIOD = 14;
const CSI_WINDOW = 30;
const CSI_BODY_WINDOW = 5;

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

type SnapshotThresholds = {
  moveThreshold: number;
  cvdThreshold: number;
  oiThreshold: number;
  impulse: IMPULSE_THRESHOLDS_CONFIG;
};

type SnapshotWithThresholds = MarketSnapshot & { thresholds: SnapshotThresholds };

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
    if (!snap.thresholds) {
      snap.thresholds = buildThresholds();
    }
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
      const { moveThreshold, cvdThreshold, oiThreshold, impulse } = snap.thresholds!;
      const habrMode = entryMode === 'adaptive' && adaptiveBollingerStrategy.isSupported(symbol);

      state.phase = has30m
        ? detectMarketPhase({
            delta30m,
            delta15m,
            cvd30m,
            settings: {
              moveThreshold,
              cvdThreshold,
              oiThreshold,
            },
          })
        : 'range';

      logData.phase = state.phase;
      logData.pricePercentChange = pricePercentChange;
      logData.thresholds = { cvdThreshold, moveThreshold, oiThreshold };
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
              atr,
              csi,
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
