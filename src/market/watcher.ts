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
import { calculateRSI, detectTrend, formatFundingRate, getSnapshotsInWindow } from './utils.js';

const ALERT_COOLDOWN = 10 * 60 * 1000;

type MarketState = {
  phase: 'range' | 'accumulation' | 'trend';
  lastAlertAt: number;
  flags: {
    accumulation?: number;
    failedAccumulation?: number;
    squeezeStarted?: number;
  };
};

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

  console.log(`🚀 Market watcher started for ${symbol}`);

  return setInterval(async () => {
    try {
      const snap = await getMarketSnapshot(symbol);
      saveSnapshot(snap);

      const snaps = getSnapshots(symbol);
      if (snaps.length < 5) return;

      const prev = snaps[snaps.length - 2];
      const delta = compareSnapshots(snap, prev!);

      const snaps15m = getSnapshotsInWindow(snaps, 15);
      const snaps30m = getSnapshotsInWindow(snaps, 30);
      if (snaps15m.length < 5 || snaps30m.length < 5) return;

      const delta15m = compareSnapshots(snap, snaps15m[0]);
      const delta30m = compareSnapshots(snap, snaps30m[0]);

      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);
      const trendLabel = detectTrend({ ...delta30m, symbol });

      let state = stateBySymbol.get(symbol);
      if (!state) {
        state = { phase: 'range', lastAlertAt: 0, flags: {} };
        stateBySymbol.set(symbol, state);
      }

      state.phase = detectMarketPhase(delta30m);

      const alerts: string[] = [];

      // =====================
      // Accumulation (structure)
      // =====================
      if (
        state.phase === 'accumulation' &&
        delta15m.oiChangePct > structure.OI_INCREASE_PCT &&
        delta30m.oiChangePct > structure.OI_INCREASE_PCT &&
        Math.abs(delta30m.priceChangePct) < structure.PRICE_DROP_PCT
      ) {
        state.flags.accumulation ??= Date.now();
        alerts.push(`🧠 OI accumulation (30m)\n→ Positions building\n→ Wait for 1m break`);
      }

      // =====================
      // Failed accumulation → squeeze start
      // =====================
      if (
        state.flags.accumulation &&
        Date.now() - state.flags.accumulation > 15 * 60_000 &&
        delta.priceChangePct < -impulse.PRICE_DROP_PCT * 1.5 &&
        delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
        snap.fundingRate > FUNDING_RATE_THRESHOLDS.FAILED_ACCUMULATION
      ) {
        state.flags.failedAccumulation = Date.now();
        alerts.push(`💥 Accumulation FAILED\n→ High risk LONGS\n→ Watch breakdown`);
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
        alerts.push(`🔴 LONG SQUEEZE CONFIRMED\n→ Continuation likely`);
      }

      // =====================
      // 7. Funding extremes
      // =====================
      if (Math.abs(snap.fundingRate) > FUNDING_RATE_THRESHOLDS.EXTREME) {
        alerts.push(`💰 Extreme funding: ${formatFundingRate(snap.fundingRate)}`);
      }

      if (!alerts.length) return;

      const now = Date.now();
      if (now - state.lastAlertAt < ALERT_COOLDOWN) return;
      state.lastAlertAt = now;

      onAlert(
        `
⚠️ *${symbol}*
Phase: ${state.phase.toUpperCase()}
Trend: ${trendLabel}

${alerts.join('\n\n')}

📊 1m Impulse:
• Price: ${delta.priceChangePct.toFixed(2)}%
• OI: ${delta.oiChangePct.toFixed(2)}%
• Volume: ${delta.volumeChangePct.toFixed(2)}%
• Funding: ${formatFundingRate(snap.fundingRate)}

📈 Structure:
• 15m Δ Price: ${delta15m.priceChangePct.toFixed(2)}%
• 15m Δ OI: ${delta15m.oiChangePct.toFixed(2)}%

• 30m Δ Price: ${delta30m.priceChangePct.toFixed(2)}%
• 30m Δ OI: ${delta30m.oiChangePct.toFixed(2)}%
        `.trim()
      );
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
