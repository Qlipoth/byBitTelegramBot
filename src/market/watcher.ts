import { saveSnapshot, getSnapshots } from './snapshotStore.js';
import { compareSnapshots } from './compare.js';
import { getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
import {
  INTERVALS,
  ALERT_THRESHOLDS,
  PRIORITY_COINS,
  LIQUID_COIN_THRESHOLDS,
  SQUEEZE_THRESHOLDS,
  COINS_COUNT,
} from './constants.market.js';
import { calculateRSI, detectTrend } from './utils.js';

const lastAlertAt: Record<string, number> = {};
const ALERT_COOLDOWN = 10 * 60 * 1000;

// =====================
// Initialize watchers
// =====================
export async function initializeMarketWatcher(onAlert: (msg: string) => void) {
  const symbols = await getTopLiquidSymbols(COINS_COUNT);

  console.log(`🔄 Tracking ${symbols.length} symbols: ${symbols.join(', ')}`);

  const intervals = symbols.map(symbol => startMarketWatcher(symbol, msg => onAlert(msg)));

  return () => {
    intervals.forEach(clearInterval as any);
    console.log('🛑 All market watchers stopped');
  };
}

// =====================
// Single symbol watcher
// =====================
export function startMarketWatcher(symbol: string, onAlert: (msg: string) => void) {
  const INTERVAL = INTERVALS.ONE_MIN;
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as (typeof PRIORITY_COINS)[number]);
  const thresholds = isPriorityCoin ? LIQUID_COIN_THRESHOLDS : ALERT_THRESHOLDS;

  console.log(`🚀 Market watcher started for ${symbol}`);

  return setInterval(async () => {
    try {
      const snap = await getMarketSnapshot(symbol);
      saveSnapshot(snap);

      const snaps = getSnapshots(symbol);
      if (snaps.length < 3) return;

      const prev = snaps[snaps.length - 2];
      const baseSnap = snaps[0];

      const delta = compareSnapshots(snap, prev!);
      const deltaBase = compareSnapshots(snap, baseSnap!);

      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);

      const trendLabel = detectTrend({ ...deltaBase, symbol });

      const alerts: string[] = [];

      // =====================
      // 1. Volume absorption
      // =====================
      if (
        delta.volumeChangePct > thresholds.VOLUME_SPIKE_PCT &&
        Math.abs(delta.priceChangePct) < thresholds.PRICE_STABLE_PCT
      ) {
        alerts.push(
          `🧲 Absorption | vol +${delta.volumeChangePct.toFixed(1)}%, price ${delta.priceChangePct.toFixed(2)}%`
        );
      }

      // =====================
      // 2. Aggressive selling
      // =====================
      if (
        delta.volumeChangePct > thresholds.VOLUME_SPIKE_PCT &&
        delta.priceChangePct < -thresholds.PRICE_DROP_PCT &&
        delta.oiChangePct > 0
      ) {
        alerts.push(
          `📉 Aggressive sell | OI +${delta.oiChangePct.toFixed(1)}%, vol +${delta.volumeChangePct.toFixed(1)}%`
        );
      }

      // =====================
      // 3. Momentum
      // =====================
      if (
        delta.volumeChangePct > thresholds.VOLUME_HIGH_PCT &&
        Math.abs(delta.priceChangePct) > thresholds.PRICE_SURGE_PCT &&
        delta.oiChangePct > thresholds.OI_INCREASE_PCT
      ) {
        alerts.push(
          `🚀 Momentum ${delta.priceChangePct > 0 ? 'UP' : 'DOWN'} | price ${delta.priceChangePct.toFixed(
            2
          )}%, OI +${delta.oiChangePct.toFixed(1)}%`
        );
      }

      // =====================
      // 4. OI accumulation (structure)
      // =====================
      if (
        deltaBase.oiChangePct > thresholds.OI_INCREASE_PCT &&
        Math.abs(deltaBase.priceChangePct) < thresholds.PRICE_DROP_PCT
      ) {
        alerts.push(
          `🧠 OI accumulation | +${deltaBase.oiChangePct.toFixed(1)}% / ${deltaBase.minutesAgo}m`
        );
      }

      // =====================
      // 4.1 LONG TRAP (early squeeze warning)
      // =====================
      if (
        delta.oiChangePct > 0 &&
        delta.priceChangePct < -thresholds.PRICE_DROP_PCT &&
        delta.volumeChangePct > thresholds.VOLUME_HIGH_PCT
      ) {
        alerts.push(
          `⚠️ Long trap forming | OI ↑${delta.oiChangePct.toFixed(
            1
          )}%, price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%`
        );
      }

      // =====================
      // 5. FAILED ACCUMULATION → LONG SQUEEZE START
      // =====================
      if (
        deltaBase.oiChangePct > thresholds.OI_INCREASE_PCT &&
        delta.priceChangePct < -thresholds.PRICE_DROP_PCT * 1.5 &&
        delta.volumeChangePct > thresholds.VOLUME_SPIKE_PCT &&
        delta.oiChangePct > -1
      ) {
        alerts.push(
          `💥 Accumulation FAILED → LONG SQUEEZE START\n` +
            `• Price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%\n` +
            `• Volume ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI ${delta.oiChangePct >= 0 ? '↑' : '≈'} ${delta.oiChangePct.toFixed(2)}%`
        );
      }

      // =====================
      // 6. LONG SQUEEZE CONFIRMATION
      // =====================
      const { LONG } = SQUEEZE_THRESHOLDS;

      if (
        delta.priceChangePct < LONG.PRICE_CHANGE &&
        delta.volumeChangePct > LONG.VOLUME_CHANGE &&
        delta.oiChangePct < LONG.OI_CHANGE &&
        rsi > LONG.RSI_OVERBOUGHT
      ) {
        alerts.push(
          `🔴 LONG SQUEEZE CONFIRMED\n` +
            `• Price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%\n` +
            `• Volume ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI ↓${Math.abs(delta.oiChangePct).toFixed(1)}%\n` +
            `• RSI ${rsi.toFixed(1)}`
        );
      }

      // =====================
      // Send alert
      // =====================
      if (!alerts.length) return;

      const now = Date.now();
      if (now - (lastAlertAt[symbol] || 0) < ALERT_COOLDOWN) return;

      onAlert(
        `
⚠️ *${symbol}*
Trend: ${trendLabel}

${alerts.join('\n\n')}

📊 Impulse (5m):
• Price: ${delta.priceChangePct.toFixed(2)}%
• OI: ${delta.oiChangePct.toFixed(2)}%
• Volume: ${delta.volumeChangePct.toFixed(2)}%

📈 Structure (${deltaBase.minutesAgo}m):
• Price: ${deltaBase.priceChangePct.toFixed(2)}%
• OI: ${deltaBase.oiChangePct.toFixed(2)}%
        `.trim()
      );

      lastAlertAt[symbol] = now;
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
