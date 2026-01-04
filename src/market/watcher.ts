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
  calculateRSI,
  detectTrend,
  calculateEntryScores,
  getSignalAgreement,
  confirmEntry,
  detectMarketPhase,
  selectCoinThresholds,
} from './utils.js';
import { createFSM, fsmStep, shouldExitPosition } from './fsm.js';
import type { MarketState, SymbolValue } from './types.js';
import { getCVDLastMinutes } from './cvdTracker.js';
import { getCvdThreshold } from './candleBuilder.js';
import { findStopLossLevel } from './paperPositionManager.js';
import { logEvent } from './logger.js';
import { realTradeManager } from './realTradeManager.js';
import { tradingState } from '../core/tradingState.js';

// symbol -> состояние (фаза, флаги, последний алерт)
const stateBySymbol = new Map<string, MarketState>();

// symbol -> FSM instance
const tradeFSMBySymbol = new Map<string, ReturnType<typeof createFSM>>();

// =====================
// Initialize watchers
// =====================
export async function initializeMarketWatcher(onAlert: (msg: string) => void) {
  const symbols = await getTopLiquidSymbols(COINS_COUNT);
  console.log(`🔄 Tracking ${symbols.length} symbols`);

  try {
    await realTradeManager.bootstrap(symbols);
  } catch (e) {
    console.error('[WATCHER] realTradeManager.bootstrap failed:', e);
  }

  const intervals = symbols.map(symbol => startMarketWatcher(symbol, msg => onAlert(msg)));
  ws.subscribeV5(
    symbols.map(s => `publicTrade.${s}`),
    'linear'
  );

  return () => intervals.forEach(clearInterval as any);
}

// =====================
// Single symbol watcher
// =====================
export async function startMarketWatcher(symbol: string, onAlert: (msg: string) => void) {
  const INTERVAL = INTERVALS.ONE_MIN;
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as any);

  const impulse = isPriorityCoin ? LIQUID_IMPULSE_THRESHOLDS : BASE_IMPULSE_THRESHOLDS;

  console.log(`🚀 Отслеживание рынка запущено для ${symbol}`);

  const snapshots = await preloadMarketSnapshots(symbol);

  for (const snap of snapshots) {
    saveSnapshot(snap); // ТВОЯ существующая функция
  }

  return setInterval(async () => {
    try {
      const logData: Record<string, any> = {};
      const cvd1m = getCVDLastMinutes(symbol, 1);
      const cvd3m = getCVDLastMinutes(symbol, 3);
      const cvd15m = getCVDLastMinutes(symbol, 15);
      const cvd30m = getCVDLastMinutes(symbol, 30);
      const snap = await getMarketSnapshot(symbol);
      const now = Date.now();
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

      const restoredPos = realTradeManager.getPosition(symbol);
      if (restoredPos && fsm.state !== 'OPEN') {
        fsm.state = 'OPEN';
        fsm.side = restoredPos.side;
        fsm.entryPrice = restoredPos.entryPrice;
        fsm.openedAt = Date.now();
      }

      const snaps = getSnapshots(symbol);
      if (snaps.length < 5) return;

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
      const { cvdThreshold, moveThreshold } = getCvdThreshold(symbol);

      state.phase = has30m
        ? detectMarketPhase({
            delta30m,
            delta15m,
            cvd30m,
            settings: {
              moveThreshold,
              cvdThreshold,
              oiThreshold: selectCoinThresholds(symbol as SymbolValue).oiThreshold,
            },
          })
        : 'range';

      logData.phase = state.phase;
      logData.pricePercentChange = pricePercentChange;
      logData.thresholds = { cvdThreshold, moveThreshold };
      logData.fundingRate = snap.fundingRate;

      // =====================
      // Entry Score Calculation
      // =====================
      const { entrySignal, longScore, shortScore, details } = calculateEntryScores({
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
        impulse: isPriorityCoin ? LIQUID_IMPULSE_THRESHOLDS : BASE_IMPULSE_THRESHOLDS,
      });

      logData.scores = { longScore, shortScore };
      logData.details = details;
      console.log(`${symbol}: `, '0) entrySignal:', entrySignal, JSON.stringify(details));

      // =====================
      // Signal Agreement Check
      // =====================
      const signal = getSignalAgreement({
        longScore,
        shortScore,
        phase: state.phase,
        pricePercentChange,
        moveThreshold,
        cvd15m: cvd15m || 0,
        cvdThreshold,
        fundingRate: Number(snap.fundingRate || 0),
        rsi,
      });

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
      if (signal === 'LONG' || signal === 'SHORT') {
        confirmed = confirmEntry({
          signal,
          delta: delta5m,
          cvd3m: cvd3m || 0,
          impulse,
          phase: state.phase,
        });
        console.log('2) confirmed value:', confirmed);
      }

      const hadPending = realTradeManager.hasPending(symbol);
      if (hadPending) {
        try {
          await realTradeManager.syncSymbol(symbol);
        } catch (e) {
          console.error(`[WATCHER] syncSymbol failed (${symbol}):`, e);
        }
      }

      const hasOpen = realTradeManager.hasPosition(symbol);
      const hasExposure = realTradeManager.hasExposure(symbol);

      const currentPos = realTradeManager.getPosition(symbol);

      console.log('3) currentPos:', JSON.stringify(currentPos));

      const exitCheck =
        fsm.state === 'OPEN' && currentPos
          ? shouldExitPosition({
              fsm,
              signal,
              cvd3m,
              fundingRate: snap.fundingRate,
              currentPrice: snap.price,
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

        const balance = await getCurrentBalance();

        const success = await realTradeManager.openPosition({
          symbol,
          side: fsm.side!,
          price: snap.price,
          stopPrice,
          balance,
        });

        if (success) {
          console.log(
            `[TRADE] 🚀 ENTER ${fsm.side} for ${symbol} | Phase: ${state.phase} | Balance: ${balance}`
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
        const pos = realTradeManager.getPosition(symbol);

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
        await realTradeManager.closePosition(symbol);

        const pnl = pos
          ? (
              ((snap.price - pos.entryPrice) / pos.entryPrice) *
              (pos.side === 'LONG' ? 100 : -100)
            ).toFixed(2)
          : '0';

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
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
