import { saveSnapshot, getSnapshots } from './snapshotStore.js';
import { compareSnapshots } from './compare.js';
import { getMarketSnapshot, getTopLiquidSymbols, ws } from '../services/bybit.js';
import {
  INTERVALS,
  PRIORITY_COINS,
  COINS_COUNT,
  BASE_IMPULSE_THRESHOLDS,
  LIQUID_IMPULSE_THRESHOLDS,
  BASE_STRUCTURE_THRESHOLDS,
  LIQUID_STRUCTURE_THRESHOLDS,
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
import { createFSM, EXIT_THRESHOLDS, fsmStep, shouldExitPosition } from './fsm.js';
import type { MarketState, SymbolValue } from './types.js';
import { getCVDLastMinutes } from './cvdTracker.js';
import { calcPercentChange, getCvdThreshold } from './candleBuilder.js';
import {
  closePaperPosition,
  getPaperPosition,
  hasOpenPaperPosition,
  openPaperPosition,
} from './paperPositionManager.js';
import { logEvent } from './logger.js';

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
export function startMarketWatcher(symbol: string, onAlert: (msg: string) => void) {
  const INTERVAL = INTERVALS.ONE_MIN;
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as any);

  const impulse = isPriorityCoin ? LIQUID_IMPULSE_THRESHOLDS : BASE_IMPULSE_THRESHOLDS;
  const structure = isPriorityCoin ? LIQUID_STRUCTURE_THRESHOLDS : BASE_STRUCTURE_THRESHOLDS;

  console.log(`🚀 Отслеживание рынка запущено для ${symbol}`);

  return setInterval(async () => {
    try {
      const logData: Record<string, any> = {};
      const cvd1m = getCVDLastMinutes(symbol, 1);
      const cvd3m = getCVDLastMinutes(symbol, 3);
      const cvd15m = getCVDLastMinutes(symbol, 15);
      const cvd30m = getCVDLastMinutes(symbol, 30);
      const snap = await getMarketSnapshot(symbol);
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

      if (snaps.length < 5) return;

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

      const pricePercentChange = calcPercentChange(symbol);
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
      const { entrySignal, longScore, shortScore } = calculateEntryScores({
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
      console.log(`${symbol}: `, '0) entrySignal:', entrySignal);

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
      });

      logData.signal = signal;

      console.log('==============================================');
      console.log('0.1) signal is:', signal);

      // =====================
      // FSM Integration
      // =====================
      // Get or create FSM for this symbol
      if (!tradeFSMBySymbol.has(symbol)) {
        tradeFSMBySymbol.set(symbol, createFSM());
      }
      const fsm = tradeFSMBySymbol.get(symbol)!;

      logData.fsm = {
        state: fsm.state,
        side: fsm.side,
      };

      logEvent(logData);

      console.log('1) FSM:', JSON.stringify(fsm));
      let confirmed = false;
      // Step the FSM
      const now = Date.now();

      // Legacy confirmation check for backward compatibility
      if (signal === 'LONG' || signal === 'SHORT') {
        confirmed = confirmEntry({
          signal,
          delta,
          cvd3m: cvd3m || 0,
          impulse,
          phase: state.phase,
        });
        console.log('2) confirmed value:', JSON.stringify(fsm));
      }

      const paperPos = getPaperPosition(symbol);

      console.log('3) paperPos:', JSON.stringify(paperPos));

      const exitSignal =
        fsm.state === 'OPEN' && paperPos
          ? shouldExitPosition({
              fsm,
              signal,
              cvd3m,
              fundingRate: snap.fundingRate,
              currentPrice: snap.price,
              now,
              entryPrice: paperPos?.entryPrice || 0,
              longScore,
              shortScore,
              phase: state.phase,
            })
          : false;

      const { action } = fsmStep(fsm, {
        signal,
        confirmed,
        exitSignal,
        now,
      });

      console.log('4) ACTION IS:', JSON.stringify(action));
      // =====================
      // Actions
      // =====================
      const hasOpen = hasOpenPaperPosition(symbol);
      // 2. ВХОД В ПОЗИЦИЮ (ENTER_MARKET)
      // Важно: проверяем экшен ENTER_MARKET из нашего нового FSM
      if (action === 'ENTER_MARKET' && !hasOpen) {
        // Сохраняем цену входа в контекст FSM (нужно для расчета PnL в shouldExitPosition)
        fsm.entryPrice = snap.price;

        console.log(`[TRADE] 🚀 ENTER ${fsm.side} for ${symbol} | Phase: ${state.phase}`);

        openPaperPosition(symbol, fsm.side!, snap.price, now);

        onAlert(
          `✅ *${symbol}: ВХОД В СДЕЛКУ*\n` +
            `Тип: ${fsm.side === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴'}\n` +
            `Фаза: *${state.phase.toUpperCase()}*\n` + // Видим фазу
            `Цена: ${snap.price}\n` +
            `Score: L:${longScore} S:${shortScore}`
        );
        state.lastConfirmationAt = now;
      }

      // 3. ВЫХОД ИЗ ПОЗИЦИИ (EXIT_MARKET)
      if (action === 'EXIT_MARKET' && hasOpen) {
        const pos = getPaperPosition(symbol); // Берем данные до закрытия для расчета
        const pnl = pos
          ? (
              ((snap.price - pos.entryPrice) / pos.entryPrice) *
              (pos.side === 'LONG' ? 100 : -100)
            ).toFixed(2)
          : 0;

        console.log(`[TRADE] 🏁 EXIT ${symbol} | PnL: ${pnl}%`);

        closePaperPosition(symbol, snap.price, now);

        // Определяем красивое описание причины выхода
        let exitReason = 'Тайм-аут';
        const pnlNum = Number(pnl); // Convert pnl to number for comparison
        if (state.phase === 'blowoff') exitReason = '🚀 Кульминация (Blow-off)';
        else if (pnlNum <= -EXIT_THRESHOLDS.STOP_LOSS_PCT) exitReason = '🛑 Стоп-лосс';
        else if (pnlNum >= EXIT_THRESHOLDS.TAKE_PROFIT_PCT)
          exitReason = '💰 Тейк-профит (ослабление)';
        else if (exitSignal) exitReason = '⚠️ Смена сигнала/Score';

        onAlert(
          `⚪ *${symbol}: ЗАКРЫТИЕ ПОЗИЦИИ*\n` +
            `Результат: *${pnl}%* ${Number(pnl) > 0 ? '✅' : '❌'}\n` +
            `Цена: ${snap.price}\n` +
            `Причина: ${exitReason}`
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
