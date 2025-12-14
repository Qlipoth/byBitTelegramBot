import { saveSnapshot, getSnapshots } from './snapshotStore.js';
import { compareSnapshots } from './compare.js';
import { getMarketSnapshot, getTopLiquidSymbols, ws } from '../services/bybit.js';
import {
  INTERVALS,
  PRIORITY_COINS,
  COINS_COUNT,
  FUNDING_RATE_THRESHOLDS,
  SQUEEZE_THRESHOLDS,
  BASE_IMPULSE_THRESHOLDS,
  LIQUID_IMPULSE_THRESHOLDS,
  BASE_STRUCTURE_THRESHOLDS,
  LIQUID_STRUCTURE_THRESHOLDS,
  ALERT_COOLDOWN,
  CONFIRM_COOLDOWN,
} from './constants.market.js';
import { calculateRSI, detectTrend, formatFundingRate, calculateEntryScores } from './utils.js';
import type { MarketState } from './types.js';
import { getCVDLastMinutes } from './cvdTracker.js';
import { calcPercentChange, getCvdThreshold } from './candleBuilder.js';

// symbol -> состояние (фаза, флаги, последний алерт)
const stateBySymbol = new Map<string, MarketState>();

function detectMarketPhase(delta30m: any): MarketState['phase'] {
  if (Math.abs(delta30m.priceChangePct) > 2 && delta30m.oiChangePct > 0) {
    return 'trend';
  }
  if (delta30m.oiChangePct > 4 && Math.abs(delta30m.priceChangePct) < 1) {
    return 'accumulation';
  }
  return 'range';
}

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
      const cvd1m = getCVDLastMinutes(symbol, 1);
      const cvd3m = getCVDLastMinutes(symbol, 3);
      const cvd15m = getCVDLastMinutes(symbol, 15);
      const snap = await getMarketSnapshot(symbol);
      saveSnapshot(snap);

      const snaps = getSnapshots(symbol);
      if (snaps.length < 5) return;

      // 1m импульс — сравнение с предыдущим снапом
      const prev = snaps[snaps.length - 2];
      const delta = compareSnapshots(snap, prev!);

      // Окна для структуры
      const snaps15m = snaps.slice(-15);
      const snaps30m = snaps.slice(-30);

      // Проверяем, что действительно есть 15/30 минут истории,
      // а не 3–5 минут после рестарта.
      const has15m = snaps15m.length >= 15;
      const has30m = snaps30m.length >= 30;

      if (snaps15m.length < 5 || snaps30m.length < 5) return;

      const delta15m = compareSnapshots(snap, snaps15m[0]!);
      const delta30m = compareSnapshots(snap, snaps30m[0]!);

      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);

      let trendLabel = '📡 Сбор данных';
      const trendObj = {
        isBull: false,
        isBear: false,
      };

      if (has30m) {
        const { label, isBull, isBear } = detectTrend({ ...delta30m, symbol });
        trendLabel = label;
        trendObj.isBear = isBear;
        trendObj.isBull = isBull;
      }

      let state = stateBySymbol.get(symbol);
      if (!state) {
        state = { phase: 'range', lastAlertAt: 0, flags: {} };
        stateBySymbol.set(symbol, state);
      }

      state.phase = has30m ? detectMarketPhase(delta30m) : 'range';

      const alerts: string[] = [];

      // CVD дивергенции и подтверждения
      const CVD_BULL_THRESHOLD = isPriorityCoin ? 20000 : 8000;
      const CVD_BEAR_THRESHOLD = isPriorityCoin ? -20000 : -8000;

      // 1. УСИЛЕНИЕ НАКОПЛЕНИЯ через CVD
      if (state.phase === 'accumulation' && has30m) {
        if (cvd15m > CVD_BULL_THRESHOLD && delta30m.oiChangePct > 2) {
          alerts.push('CVD ПОДТВЕРЖДАЕТ НАКОПЛЕНИЕ\nАгрессивные покупки на просадке');
          state.flags.accumulationStrong = true;
        }
      }

      // =====================
      // Accumulation (structure)
      // =====================
      if (
        has15m &&
        has30m &&
        state.phase === 'accumulation' &&
        delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
        delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
        Math.abs(delta30m.priceChangePct) < structure.PRICE_DROP_PCT
      ) {
        state.flags.accumulation ??= Date.now();
        alerts.push('🧠 Накопление OI (30м)\n→ Идёт накопление позиций\n→ Ожидаем пробой 1м');
      }

      // =====================
      // Failed accumulation → squeeze start
      // =====================
      if (
        has15m &&
        has30m &&
        state.flags.accumulation &&
        Date.now() - state.flags.accumulation > 15 * 60_000 &&
        delta.priceChangePct < -impulse.PRICE_DROP_PCT * 1.5 &&
        delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
        snap.fundingRate > FUNDING_RATE_THRESHOLDS.FAILED_ACCUMULATION
      ) {
        state.flags.failedAccumulation = Date.now();
        alerts.push('💥 Накопление ПРОВАЛЕНО\n→ Высокий риск для ЛОНГОВ\n→ Ожидаем пробой');
      }

      // =====================
      // Long squeeze confirmation with CVD
      // =====================
      const { LONG } = SQUEEZE_THRESHOLDS;
      if (state.flags.failedAccumulation || state.flags.accumulationStrong) {
        if (cvd1m < -60_000 && delta.oiChangePct < -3) {
          alerts.push('🔴 СКВИЗ ЛОНГОВ ПОДТВЕРЖДЁН CVD\n→ Агрессивные продажи выносят толпу');
        }
      } else if (
        state.flags.failedAccumulation &&
        delta.priceChangePct < LONG.PRICE_CHANGE &&
        delta.volumeChangePct > LONG.VOLUME_CHANGE &&
        delta.oiChangePct < LONG.OI_CHANGE &&
        rsi > LONG.RSI_OVERBOUGHT
      ) {
        alerts.push('🔴 ПОДТВЕРЖДЁН СКВИЗ ЛОНГОВ\n→ Вероятно продолжение');
      }

      // =====================
      // CVD Divergence Detection
      // =====================

      const pricePercentChange = calcPercentChange(symbol);
      const { cvdThreshold, moveThreshold } = getCvdThreshold(symbol);
      if (Math.abs(pricePercentChange) > moveThreshold) {
        // Bearish Divergence: Price up but CVD down
        if (pricePercentChange > 0 && cvd15m < -cvdThreshold) {
          alerts.push('🔴 МЕДВЕЖЬЯ ДИВЕРГЕНЦИЯ\nРост цены на слабых покупках — разворот вниз');
        }
        // Bullish Divergence: Price down but CVD up
        if (pricePercentChange < 0 && cvd15m > cvdThreshold) {
          alerts.push('🟢 БЫЧЬЯ ДИВЕРГЕНЦИЯ\nПадение на сильных покупках — разворот вверх');
        }
      }

      // =====================
      // Funding extremes
      // =====================
      if (Math.abs(snap.fundingRate) > FUNDING_RATE_THRESHOLDS.EXTREME) {
        alerts.push(`💰 Высокие фандинги: ${formatFundingRate(snap.fundingRate)}`);
      }

      // =====================
      // Entry Score Calculation
      // =====================
      const { entrySignal } = calculateEntryScores({
        state,
        delta,
        delta15m,
        delta30m,
        snap,
        cvd3m: cvd3m || 0,
        cvd15m: cvd15m || 0,
        rsi: rsi || 50,
        isBull: trendObj.isBull,
        isBear: trendObj.isBear,
        impulse: isPriorityCoin ? LIQUID_IMPULSE_THRESHOLDS : BASE_IMPULSE_THRESHOLDS,
      });

      // =====================
      // Entry Candidate (LONG / SHORT) — только при полном окне
      // =====================
      let entryCandidate: string | null = null;

      if (has15m && has30m && state.phase === 'accumulation') {
        // LONG candidate with CVD confirmation
        if (
          delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
          delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
          Math.abs(delta30m.priceChangePct) < structure.PRICE_DROP_PCT
        ) {
          if ((snap.fundingRate ?? 0) <= 0.0001 && cvd15m > CVD_BULL_THRESHOLD) {
            state.flags.entryCandidate = 'LONG';
            entryCandidate = '🟢 КАНДИДАТ НА ПОКУПКУ + CVD\n→ Скрытые покупки + накопление';
          }
        }

        // SHORT candidate with CVD confirmation
        if (
          delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
          delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
          (snap.fundingRate ?? 0) > 0.0003 &&
          delta30m.priceChangePct <= 0
        ) {
          if (cvd15m < CVD_BEAR_THRESHOLD) {
            state.flags.entryCandidate = 'SHORT';
            entryCandidate = '🔴 КАНДИДАТ НА ПРОДАЖУ + CVD\n→ Агрессивные продажи + перегрев';
          }
        }
      }

      // =====================
      // ENTRY CONFIRMATION (1m trigger) with CVD
      // =====================
      let entryConfirmation: string | null = null;

      if (state.flags.entryCandidate === 'LONG') {
        const bullImpulse =
          delta.priceChangePct > impulse.PRICE_SURGE_PCT &&
          delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
          cvd3m > CVD_BULL_THRESHOLD;

        if (bullImpulse) {
          entryConfirmation = '🟢 ПОДТВЕРЖДЕНИЕ LONG\n→ Импульс + CVD > порога\n→ ВХОДИМ В ЛОНГ';
          state.flags.lastEntrySide = 'LONG';
        } else if (delta.priceChangePct > impulse.PRICE_SURGE_PCT && cvd3m < 0) {
          alerts.push('⚠️ ЛОЖНЫЙ ПРОБОЙ ВВЕРХ\nЦена выросла, но CVD отрицательный — игнорируем');
          entryConfirmation = null;
        } else if (
          delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
          delta.oiChangePct >= 0 &&
          rsi > 45
        ) {
          entryConfirmation =
            '✅ ПОДТВЕРЖДЕНИЕ ПОКУПКИ 🟢\n→ Импульс 1м + объём\n→ Сигнал подтверждён локальным движением';
        }
      }

      if (state.flags.entryCandidate === 'SHORT') {
        const bearImpulse =
          delta.priceChangePct < -impulse.PRICE_SURGE_PCT &&
          delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
          cvd3m < CVD_BEAR_THRESHOLD;

        if (bearImpulse) {
          entryConfirmation =
            '🔴 ПОДТВЕРЖДЕНИЕ SHORT\n→ Пробой вниз + CVD < порога\n→ ВХОДИМ В ШОРТ';
          state.flags.lastEntrySide = 'SHORT';
        } else if (delta.priceChangePct < -impulse.PRICE_SURGE_PCT && cvd3m > 0) {
          alerts.push('⚠️ ЛОЖНЫЙ ПРОБОЙ ВНИЗ\nПадение на покупателях — ловушка');
          entryConfirmation = null;
        } else if (
          delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
          delta.oiChangePct >= 0 &&
          (snap.fundingRate ?? 0) > 0
        ) {
          entryConfirmation =
            '✅ ПОДТВЕРЖДЕНИЕ ПРОДАЖИ 🔴\n→ Пробой 1м + объём\n→ Лонги попали в ловушку';
        }
      }

      // если нет ни структурных алертов, ни кандидата, ни конфирмации — молчим
      if (!alerts.length && !entryCandidate && !entryConfirmation) return;

      const now = Date.now();
      // --- обычные алерты (accumulation, failed, funding) ---
      if (alerts.length || entryCandidate) {
        console.log('entryCandidate', entryCandidate);
        if (now - state.lastAlertAt < ALERT_COOLDOWN) return;
        state.lastAlertAt = now;
      }

      // подтверждение входа — свой отдельный cooldown
      if (entryConfirmation) {
        console.log('entryConfirmation', entryConfirmation);
        if (state.lastConfirmationAt && now - state.lastConfirmationAt < CONFIRM_COOLDOWN) {
          entryConfirmation = null;
        } else {
          state.lastConfirmationAt = now;
        }
      }

      const structureBlock =
        has15m && has30m
          ? `
📈 Structure:
• 15m Δ Price: ${delta15m.priceChangePct.toFixed(2)}%
• 15m Δ OI: ${delta15m.oiChangePct.toFixed(2)}%

• 30m Δ Price: ${delta30m.priceChangePct.toFixed(2)}%
• 30m Δ OI: ${delta30m.oiChangePct.toFixed(2)}%`
          : `
📈 Structure:
• Сбор истории… нужно полное окно 30м`;
      onAlert(
        `⚠️ *${symbol}*
Phase: ${state.phase.toUpperCase()}
Trend: ${trendLabel}

${alerts.join('\n\n')}
${entryCandidate ? `${entryCandidate}\n` : ''}${entryConfirmation ? `${entryConfirmation}\n` : ''}
${entrySignal}

📊 1m Impulse:
• Price: ${delta.priceChangePct.toFixed(2)}%
• OI: ${delta.oiChangePct.toFixed(2)}%
• Volume: ${delta.volumeChangePct.toFixed(2)}%
• Funding: ${formatFundingRate(snap.fundingRate)}${structureBlock}`
      );
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
