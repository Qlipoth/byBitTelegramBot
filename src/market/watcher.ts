import { saveSnapshot, getSnapshots } from './snapshotStore.js';
import { compareSnapshots } from './compare.js';
import { getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
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
} from './constants.market.js';
import { calculateRSI, detectTrend, formatFundingRate } from './utils.js';
import type { MarketState } from './types.js';

const ALERT_COOLDOWN = 10 * 60 * 1000;

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

      // Тренд и фаза рынка считаем только если есть полноценное 30m окно.
      const trendLabel = has30m ? detectTrend({ ...delta30m, symbol }) : '📡 Сбор данных';

      let state = stateBySymbol.get(symbol);
      if (!state) {
        state = { phase: 'range', lastAlertAt: 0, flags: {} };
        stateBySymbol.set(symbol, state);
      }

      state.phase = has30m ? detectMarketPhase(delta30m) : 'range';

      const alerts: string[] = [];

      console.log(`
        === DEBUG ${symbol} ===
        snaps: ${snaps.length}
        has15m: ${has15m}
        has30m: ${has30m}
        phase: ${state.phase}
        oi15: ${delta15m.oiChangePct.toFixed(2)}
        oi30: ${delta30m.oiChangePct.toFixed(2)}
        price30: ${delta30m.priceChangePct.toFixed(2)}
        funding: ${snap.fundingRate}
        entryCandidate: ${state.flags.entryCandidate}
        lastAlertAt: ${state.lastAlertAt}
        lastConfirmationAt: ${state.lastConfirmationAt}
        alertsCount: ${alerts.length}
        ========================
        `);

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
      // Long squeeze confirmation
      // =====================
      const { LONG } = SQUEEZE_THRESHOLDS;
      if (
        state.flags.failedAccumulation &&
        delta.priceChangePct < LONG.PRICE_CHANGE &&
        delta.volumeChangePct > LONG.VOLUME_CHANGE &&
        delta.oiChangePct < LONG.OI_CHANGE &&
        rsi > LONG.RSI_OVERBOUGHT
      ) {
        alerts.push('🔴 ПОДТВЕРЖДЁН СКВИЗ ЛОНГОВ\n→ Вероятно продолжение');
      }

      // =====================
      // Funding extremes
      // =====================
      if (Math.abs(snap.fundingRate) > FUNDING_RATE_THRESHOLDS.EXTREME) {
        alerts.push(`💰 Высокие фандинги: ${formatFundingRate(snap.fundingRate)}`);
      }

      // =====================
      // Entry Candidate (LONG / SHORT) — только при полном окне
      // =====================
      let entryCandidate: string | null = null;

      if (has15m && has30m && state.phase === 'accumulation') {
        // LONG candidate
        if (
          delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
          delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
          Math.abs(delta30m.priceChangePct) < structure.PRICE_DROP_PCT &&
          (snap.fundingRate ?? 0) <= 0
        ) {
          state.flags.entryCandidate = 'LONG';
          entryCandidate = '🟢 КАНДИДАТ НА ПОКУПКУ\n→ Накопление + нет перегрева лонгов';
        }

        // SHORT candidate
        if (
          delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
          delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
          (snap.fundingRate ?? 0) > 0 &&
          delta30m.priceChangePct <= 0
        ) {
          state.flags.entryCandidate = 'SHORT';
          entryCandidate = '🔴 КАНДИДАТ НА ПРОДАЖУ\n→ Накопление + перегрев лонгов';
        }
      }

      // =====================
      // ENTRY CONFIRMATION (1m trigger)
      // =====================
      let entryConfirmation: string | null = null;

      if (state.flags.entryCandidate === 'LONG') {
        if (
          delta.priceChangePct > impulse.PRICE_SURGE_PCT &&
          delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
          delta.oiChangePct >= 0 &&
          rsi > 45
        ) {
          entryConfirmation =
            '✅ ПОДТВЕРЖДЕНИЕ ПОКУПКИ 🟢\n→ Импульс 1м + объём\n→ Сигнал подтверждён локальным движением';
        }
      }

      if (state.flags.entryCandidate === 'SHORT') {
        if (
          delta.priceChangePct < -impulse.PRICE_SURGE_PCT &&
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

      // ENTRY CONFIRMATION cooldown (отдельный!)
      if (entryConfirmation) {
        const CONFIRM_COOLDOWN = 2 * 60 * 1000; // 2 минуты
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
