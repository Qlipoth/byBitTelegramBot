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
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as any);

  const impulse = isPriorityCoin ? LIQUID_IMPULSE_THRESHOLDS : BASE_IMPULSE_THRESHOLDS;
  const structure = isPriorityCoin ? LIQUID_STRUCTURE_THRESHOLDS : BASE_STRUCTURE_THRESHOLDS;

  console.log(`🚀 Market watcher started for ${symbol}`);

  return setInterval(async () => {
    try {
      const snap = await getMarketSnapshot(symbol);
      saveSnapshot(snap);

      const snaps = getSnapshots(symbol);
      if (snaps.length < 3) return;

      // =====================
      // Impulse (1m)
      // =====================
      const prev = snaps[snaps.length - 2];
      const delta = compareSnapshots(snap, prev!);

      // =====================
      // Structure Analysis (15m, 30m)
      // =====================
      const structure15mSnaps = getSnapshotsInWindow(snaps, 15);
      const structure30mSnaps = getSnapshotsInWindow(snaps, 30);

      if (structure15mSnaps.length < 5 || structure30mSnaps.length < 5) return;

      const delta15m = compareSnapshots(snap, structure15mSnaps[0]!);
      const delta30m = compareSnapshots(snap, structure30mSnaps[0]!);

      // =====================
      // Indicators
      // =====================
      const priceHistory = snaps.map(s => s.price).slice(-30);
      const rsi = calculateRSI(priceHistory, 14);

      // For trend detection, you can choose either 30m delta or combined logic
      const trendLabel = detectTrend({ ...delta30m, symbol });

      const alerts: string[] = [];

      // =====================
      // 1. Volume absorption (impulse)
      // =====================
      if (
        delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
        Math.abs(delta.priceChangePct) < impulse.PRICE_STABLE_PCT
      ) {
        alerts.push(
          `🧲 Absorption | vol +${delta.volumeChangePct.toFixed(1)}%, price ${delta.priceChangePct.toFixed(2)}%`
        );
      }

      // =====================
      // 2. Aggressive selling (impulse)
      // =====================
      if (
        delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
        delta.priceChangePct < -impulse.PRICE_DROP_PCT &&
        delta.oiChangePct > 0
      ) {
        alerts.push(
          `📉 Aggressive sell | OI +${delta.oiChangePct.toFixed(1)}%, vol +${delta.volumeChangePct.toFixed(1)}%`
        );
      }

      // =====================
      // 3. Momentum (impulse)
      // =====================
      if (
        delta.volumeChangePct > impulse.VOLUME_HIGH_PCT &&
        Math.abs(delta.priceChangePct) > impulse.PRICE_SURGE_PCT &&
        delta.oiChangePct > impulse.OI_INCREASE_PCT
      ) {
        alerts.push(
          `🚀 Momentum ${delta.priceChangePct > 0 ? 'UP' : 'DOWN'} | price ${delta.priceChangePct.toFixed(2)}%, OI +${delta.oiChangePct.toFixed(1)}%`
        );
      }

      // =====================
      // 4. OI accumulation (structure)
      // =====================
      if (
        delta15m.oiChangePct > structure.OI_INCREASE_PCT && // короткий таймфрейм
        delta30m.oiChangePct > structure.OI_INCREASE_PCT && // длинный таймфрейм
        Math.abs(delta30m.priceChangePct) < structure.PRICE_DROP_PCT
      ) {
        alerts.push(`🧠 OI accumulation | +${delta30m.oiChangePct.toFixed(1)}% / 30m`);
      }

      // =====================
      // 4.1 Long trap (early warning)
      // =====================
      if (
        delta.oiChangePct > 0 &&
        delta15m.oiChangePct > 0 && // Confirm OI increase on 15m
        delta.priceChangePct < -impulse.PRICE_DROP_PCT &&
        delta.volumeChangePct > impulse.VOLUME_HIGH_PCT
      ) {
        alerts.push(
          `⚠️ Long trap forming | OI ↑${delta.oiChangePct.toFixed(1)}%, price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%`
        );
      }

      // =====================
      // 5. Failed accumulation → long squeeze start
      // =====================
      if (
        delta15m.oiChangePct > structure.OI_INCREASE_PCT && // короткий таймфрейм
        delta30m.oiChangePct > structure.OI_INCREASE_PCT && // длинный таймфрейм
        delta.priceChangePct < -impulse.PRICE_DROP_PCT * 1.5 &&
        delta.volumeChangePct > impulse.VOLUME_SPIKE_PCT &&
        delta.oiChangePct > -1 &&
        snap.fundingRate > FUNDING_RATE_THRESHOLDS.FAILED_ACCUMULATION
      ) {
        alerts.push(
          `💥 Accumulation FAILED → LONG SQUEEZE START\n` +
            `• Price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%\n` +
            `• Volume ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI ${delta.oiChangePct >= 0 ? '↑' : '≈'} ${delta.oiChangePct.toFixed(2)}%`
        );
      }

      // =====================
      // 6. Long squeeze confirmation
      // =====================
      const { LONG } = SQUEEZE_THRESHOLDS;
      if (
        delta.priceChangePct < LONG.PRICE_CHANGE &&
        delta.volumeChangePct > LONG.VOLUME_CHANGE &&
        delta.oiChangePct < LONG.OI_CHANGE &&
        rsi > LONG.RSI_OVERBOUGHT &&
        snap.fundingRate > FUNDING_RATE_THRESHOLDS.LONG_SQUEEZE
      ) {
        alerts.push(
          `🔴 LONG SQUEEZE CONFIRMED\n` +
            `• Price ↓${Math.abs(delta.priceChangePct).toFixed(2)}%\n` +
            `• Volume ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI ↓${Math.abs(delta.oiChangePct).toFixed(1)}%\n` +
            `• RSI ${rsi.toFixed(1)}\n` +
            `• Funding ${formatFundingRate(snap.fundingRate)}`
        );
      }

      // =====================
      // 7. Funding extremes
      // =====================
      if (Math.abs(snap.fundingRate) > FUNDING_RATE_THRESHOLDS.EXTREME) {
        alerts.push(`💰 Extreme funding: ${formatFundingRate(snap.fundingRate)}`);
      }

      // =====================
      // Send alert
      // =====================
      if (!alerts.length) return;

      const now = Date.now();
      if (now - (lastAlertAt[symbol] || 0) < ALERT_COOLDOWN) return;

      // 1m vs 30m momentum
      const structure1mSnaps = getSnapshotsInWindow(snaps, 1);
      if (structure1mSnaps.length < 2 || structure30mSnaps.length < 5) return;
      const delta1m = compareSnapshots(snap, structure1mSnaps[0]);

      const priceMomentum = delta1m.priceChangePct - delta30m.priceChangePct;
      const volumeRatio = delta1m.volumeChangePct / Math.max(0.01, delta30m.volumeChangePct);
      const oiMomentum = delta1m.oiChangePct - delta30m.oiChangePct;

      onAlert(
        `
⚠️ *${symbol}*
Trend: ${trendLabel}

${alerts.join('\n\n')}

📊 Impulse (1m):
• Price: ${delta.priceChangePct.toFixed(2)}%
• OI: ${delta.oiChangePct.toFixed(2)}%
• Volume: ${delta.volumeChangePct.toFixed(2)}%
• Funding: ${formatFundingRate(snap.fundingRate)}

🔄 1m vs 30m Momentum:
• Price: ${priceMomentum > 0 ? '↑' : '↓'} ${Math.abs(priceMomentum).toFixed(2)}%
• Volume: ${volumeRatio > 1 ? '↑' : '↓'} ${volumeRatio.toFixed(2)}x
• OI: ${oiMomentum > 0 ? '↑' : '↓'} ${Math.abs(oiMomentum).toFixed(2)}%

📈 Structure:
• 15m Price Δ: ${delta15m.priceChangePct.toFixed(2)}%
• 15m OI Δ: ${delta15m.oiChangePct.toFixed(2)}%
• 15m Volume Δ: ${delta15m.volumeChangePct.toFixed(2)}%

• 30m Price Δ: ${delta30m.priceChangePct.toFixed(2)}%
• 30m OI Δ: ${delta30m.oiChangePct.toFixed(2)}%
• 30m Volume Δ: ${delta30m.volumeChangePct.toFixed(2)}%
        `.trim()
      );

      lastAlertAt[symbol] = now;
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
