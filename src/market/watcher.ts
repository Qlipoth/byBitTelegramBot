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
import { calculatePriceChanges, calculateRSI, detectTrend } from './utils.js';

const lastAlertAt: Record<string, number> = {};
const ALERT_COOLDOWN = 10 * 60 * 1000; // 10 минут

// =====================
// Initialize watchers
// =====================
export async function initializeMarketWatcher(onAlert: (msg: string) => void) {
  const symbols = await getTopLiquidSymbols(COINS_COUNT);

  console.log(`🔄 Tracking ${symbols.length} symbols: ${symbols.join(', ')}`);

  const intervals = symbols.map(symbol =>
    startMarketWatcher(symbol, msg => {
      onAlert(`[${symbol}] ${msg}`);
    })
  );

  return () => {
    intervals.forEach(clearInterval);
    console.log('🛑 All market watchers stopped');
  };
}

// =====================
// Single symbol watcher
// =====================
export function startMarketWatcher(symbol: string, onAlert: (msg: string) => void) {
  const INTERVAL = INTERVALS.ONE_MIN;
  const isPriorityCoin = PRIORITY_COINS.includes(symbol as (typeof PRIORITY_COINS)[number]);
  console.log(`🚀 Market watcher started for ${symbol}`);

  const thresholds = isPriorityCoin ? { ...LIQUID_COIN_THRESHOLDS } : { ...ALERT_THRESHOLDS };

  return setInterval(async () => {
    try {
      const snap = await getMarketSnapshot(symbol);
      saveSnapshot(snap);

      const snaps = getSnapshots(symbol);
      if (snaps.length < 2) return;
      const priceHistory = snaps.map(s => s.price).slice(-30); // Last 30 prices
      const rsi = calculateRSI(priceHistory, 14);

      // Calculate volatility (standard deviation of price changes)
      const priceChanges = calculatePriceChanges(priceHistory);
      const avgPriceChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
      const variance =
        priceChanges.reduce((a, b) => a + Math.pow(b - avgPriceChange, 2), 0) / priceChanges.length;
      const volatility = Math.sqrt(variance);
      const isVolatile = volatility > 0.5; // 0.5% volatility threshold

      // ===== Impulse (1m)
      const prev = snaps[snaps.length - 2];
      if (!prev) return;
      const delta = compareSnapshots(snap, prev);

      // ===== Structure (15m+)
      const baseSnap = snaps[0];
      if (!baseSnap) return;
      const deltaBase = compareSnapshots(snap, baseSnap);

      const trendLabel = detectTrend({
        ...deltaBase, // Now it's safe to spread deltaBase
        symbol,
      });
      const alerts: string[] = [];

      // =====================
      // 1. Volume absorption
      // =====================
      if (
        delta.volumeChangePct > thresholds.VOLUME_SPIKE_PCT &&
        Math.abs(delta.priceChangePct) < thresholds.PRICE_STABLE_PCT
      ) {
        alerts.push(
          `🧲 Absorption | ${trendLabel}(vol +${delta.volumeChangePct.toFixed(1)}%, price ${delta.priceChangePct.toFixed(2)}%)`
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
          `📉 Aggressive sell | ${trendLabel}(OI +${delta.oiChangePct.toFixed(1)}%, vol +${delta.volumeChangePct.toFixed(1)}%)`
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
          `🚀 Momentum ${delta.priceChangePct > 0 ? 'Up' : 'Down'} | ${trendLabel}(price ${delta.priceChangePct.toFixed(2)}%, OI +${delta.oiChangePct.toFixed(1)}%)`
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
          `🧠 OI accumulation | ${trendLabel}(OI +${deltaBase.oiChangePct.toFixed(1)}% / ${deltaBase.minutesAgo}m)`
        );
      }

      // =====================
      // 5. short SQUEEZE (proxy)
      // =====================
      // Enhanced short squeeze detection with dynamic thresholds
      const {
        SHORT,
        SCORE_WEIGHTS,
        SCORE_THRESHOLDS: { STRONG, MEDIUM },
      } = SQUEEZE_THRESHOLDS;

      const isStrongPriceMove =
        delta.priceChangePct >
        (isPriorityCoin ? SHORT.PRICE_CHANGE.PRIORITY : SHORT.PRICE_CHANGE.NORMAL);
      const isVolumeSpike =
        delta.volumeChangePct >
        (isPriorityCoin ? SHORT.VOLUME_CHANGE.PRIORITY : SHORT.VOLUME_CHANGE.NORMAL);
      const isOIDecreasing =
        delta.oiChangePct < (isPriorityCoin ? SHORT.OI_CHANGE.PRIORITY : SHORT.OI_CHANGE.NORMAL);
      const isNotOverbought =
        rsi < (isPriorityCoin ? SHORT.RSI_OVERBOUGHT.PRIORITY : SHORT.RSI_OVERBOUGHT.NORMAL);

      // Calculate squeeze score (0-1)
      const squeezeScore =
        Math.min(delta.priceChangePct / 5, 1) * SCORE_WEIGHTS.PRICE +
        Math.min(delta.volumeChangePct / 300, 1) * SCORE_WEIGHTS.VOLUME +
        Math.min(Math.abs(delta.oiChangePct) / 3, 1) * SCORE_WEIGHTS.OI;

      if (isStrongPriceMove && isVolumeSpike && isOIDecreasing && isNotOverbought && isVolatile) {
        const strength =
          squeezeScore > STRONG ? '🔴 СИЛЬНЫЙ ' : squeezeScore > MEDIUM ? '🟠 ' : '🟡 ';

        alerts.push(
          `${strength}SHORT SQUEEZE DETECTED!\n` +
            `• Price: ↑${delta.priceChangePct.toFixed(1)}%\n` +
            `• Volume: ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI: ↓${Math.abs(delta.oiChangePct).toFixed(1)}%\n` +
            `• RSI: ${rsi.toFixed(1)}/70\n` +
            `• Volatility: ${volatility.toFixed(2)}%`
        );
      }

      // =====================
      // 6. LONG SQUEEZE DETECTION
      // =====================
      const { LONG } = SQUEEZE_THRESHOLDS;
      const isStrongDrop = delta.priceChangePct < LONG.PRICE_CHANGE;
      const isHighVolume = delta.volumeChangePct > LONG.VOLUME_CHANGE;
      const isOISharpDrop = delta.oiChangePct < LONG.OI_CHANGE;
      const wasOverbought = rsi > LONG.RSI_OVERBOUGHT;

      if (isStrongDrop && isHighVolume && isOISharpDrop && wasOverbought) {
        const strength =
          Math.abs(delta.priceChangePct) > 4
            ? '🔴 СИЛЬНЫЙ '
            : Math.abs(delta.priceChangePct) > 2.5
              ? '🟠 '
              : '🟡 ';

        alerts.push(
          `${strength}LONG SQUEEZE DETECTED!\n` +
            `• Price: ↓${Math.abs(delta.priceChangePct).toFixed(1)}%\n` +
            `• Volume: ↑${delta.volumeChangePct.toFixed(0)}%\n` +
            `• OI: ↓${Math.abs(delta.oiChangePct).toFixed(1)}%\n` +
            `• RSI: ${rsi.toFixed(1)}/70\n` +
            `• Volatility: ${volatility.toFixed(2)}%`
        );
      }

      // =====================
      // Send alerts
      // =====================
      if (alerts.length === 0) return;

      const now = Date.now();
      if (now - (lastAlertAt[symbol] || 0) < ALERT_COOLDOWN) return;

      const message = `
      ⚠️ *${symbol}*
      Trend: ${trendLabel}
      
      ${alerts.join('\n\n')}
      
      📊 Impulse (1m):
      • Price: ${delta.priceChangePct.toFixed(2)}%
      • OI: ${delta.oiChangePct.toFixed(2)}%
      • Volume: ${delta.volumeChangePct.toFixed(2)}%
      
      📈 Structure (${deltaBase.minutesAgo}m):
      • Price: ${deltaBase.priceChangePct.toFixed(2)}%
      • OI: ${deltaBase.oiChangePct.toFixed(2)}%
      `.trim();

      onAlert(message);
      lastAlertAt[symbol] = now;
    } catch (err) {
      console.error(`❌ Market watcher error (${symbol}):`, err);
    }
  }, INTERVAL);
}
