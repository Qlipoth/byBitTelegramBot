import { calculateRSI } from './analysis.js';
import { getATR, getCandle, getHistory } from './candleBuilder.js';
import { STRATEGY_CONFIG } from '../config/strategyConfig.js';

export type AdaptiveSignal = 'LONG' | 'SHORT' | 'NONE';

interface BollingerContext {
  upper: number;
  lower: number;
  middle: number;
  ema: number;
  rsiLong: number;
  close: number;
  atr: number;
  candles: { open: number; close: number }[];
}

export interface AdaptiveSignalResult {
  ready: boolean;
  signal: AdaptiveSignal;
  entrySignal: string;
  longScore: number;
  shortScore: number;
  details: Record<string, unknown>;
}

const adaptiveConfig = STRATEGY_CONFIG.adaptiveBollinger;
const BB_PERIOD = adaptiveConfig.bbPeriod;
const BB_STD = adaptiveConfig.bbStd;
const EMA_PERIOD = adaptiveConfig.emaPeriod;
const RSI_LONG_PERIOD = adaptiveConfig.rsiLongPeriod;
const RSI_NEUTRAL = adaptiveConfig.rsiNeutral;
const RSI_DEADBAND = adaptiveConfig.rsiDeadband;
const SIGNAL_THRESHOLD = adaptiveConfig.signalThreshold;
const SCORE_GAP = adaptiveConfig.scoreGap;
const MIN_BAND_DISTANCE = adaptiveConfig.minBandDistance;
const EMA_TREND_TOLERANCE = adaptiveConfig.emaTrendTolerance;
const CLUSTER_ATR_FACTOR = adaptiveConfig.clusterAtrFactor;
const BAND_SLIPPAGE_TOLERANCE = adaptiveConfig.bandSlippageTolerance;
const DEFAULT_SUPPORTED = adaptiveConfig.supportedSymbols;

function sma(v: number[]) {
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function std(v: number[], m: number) {
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}
function ema(v: number[], p: number) {
  const k = 2 / (p + 1);
  return v.reduce((a, c, i) => (i === 0 ? c : c * k + a * (1 - k)));
}

export class AdaptiveBollingerEmaStrategy {
  private contextMap = new Map<string, BollingerContext>();
  private supportedSymbols = new Set<string>(DEFAULT_SUPPORTED);

  getContext(symbol: string): BollingerContext | null {
    const cached = this.contextMap.get(symbol);
    if (cached) return cached;

    const rebuilt = this.buildContext(symbol);
    if (rebuilt) {
      this.contextMap.set(symbol, rebuilt);
      return rebuilt;
    }

    return null;
  }

  getSignal(symbol: string): AdaptiveSignalResult {
    const ctx = this.buildContext(symbol);
    if (!ctx) {
      return {
        ready: false,
        signal: 'NONE',
        entrySignal: 'NO DATA',
        longScore: 0,
        shortScore: 0,
        details: {},
      };
    }

    this.contextMap.set(symbol, ctx);

    const { close, upper, lower, rsiLong } = ctx;
    const distancePct = this.getBandDistance(ctx);
    const emaBias = this.getEmaBias(ctx);
    const bullCluster = this.isBullCluster(ctx);
    const bearCluster = this.isBearCluster(ctx);

    const allowLong = rsiLong <= RSI_NEUTRAL - RSI_DEADBAND;
    const allowShort = rsiLong >= RSI_NEUTRAL + RSI_DEADBAND;

    const longScore = Math.min(
      100,
      (close <= lower * (1 + BAND_SLIPPAGE_TOLERANCE) ? 35 : 0) +
        (allowLong ? 20 : 0) +
        (distancePct >= MIN_BAND_DISTANCE ? 10 : 0) +
        (emaBias <= -EMA_TREND_TOLERANCE ? 20 : 0) +
        (bullCluster ? 15 : 0)
    );

    const shortScore = Math.min(
      100,
      (close >= upper * (1 - BAND_SLIPPAGE_TOLERANCE) ? 35 : 0) +
        (allowShort ? 20 : 0) +
        (distancePct >= MIN_BAND_DISTANCE ? 10 : 0) +
        (emaBias >= EMA_TREND_TOLERANCE ? 20 : 0) +
        (bearCluster ? 15 : 0)
    );

    let signal: AdaptiveSignal = 'NONE';
    if (longScore >= SIGNAL_THRESHOLD && longScore - shortScore >= SCORE_GAP) {
      signal = 'LONG';
    } else if (shortScore >= SIGNAL_THRESHOLD && shortScore - longScore >= SCORE_GAP) {
      signal = 'SHORT';
    }

    return {
      ready: true,
      signal,
      entrySignal: signal === 'NONE' ? 'NO SETUP' : signal,
      longScore,
      shortScore,
      details: {
        rsiLong,
        distancePct,
        emaBias,
        bullCluster,
        bearCluster,
        allowLong,
        allowShort,
      },
    };
  }

  confirmEntry(symbol: string, signal: AdaptiveSignal): boolean {
    if (signal === 'NONE') return false;
    const ctx = this.getContext(symbol);
    if (!ctx) return false;

    const distancePct = this.getBandDistance(ctx);
    const emaBias = this.getEmaBias(ctx);

    if (signal === 'LONG') {
      return (
        ctx.close <= ctx.lower * (1 + BAND_SLIPPAGE_TOLERANCE) &&
        distancePct >= MIN_BAND_DISTANCE * 0.8 &&
        emaBias <= -EMA_TREND_TOLERANCE
      );
    }

    if (signal === 'SHORT') {
      return (
        ctx.close >= ctx.upper * (1 - BAND_SLIPPAGE_TOLERANCE) &&
        distancePct >= MIN_BAND_DISTANCE * 0.8 &&
        emaBias >= EMA_TREND_TOLERANCE
      );
    }

    return false;
  }

  isSupported(symbol: string): boolean {
    if (this.supportedSymbols.size === 0) return true;
    return this.supportedSymbols.has(symbol.toUpperCase());
  }

  setSupportedSymbols(symbols: string[]): void {
    this.supportedSymbols = new Set(symbols.map(s => s.toUpperCase()));
  }

  // ===== CLUSTER LOGIC (CSI-lite) =====

  private isBullCluster(ctx: BollingerContext): boolean {
    const { candles, atr } = ctx;
    const last = candles.slice(-3);
    const bullish = last.filter(c => c.close > c.open);
    const avgBody =
      bullish.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.max(1, bullish.length);

    return bullish.length >= 2 && avgBody > CLUSTER_ATR_FACTOR * atr;
  }

  private isBearCluster(ctx: BollingerContext): boolean {
    const { candles, atr } = ctx;
    const last = candles.slice(-3);
    const bearish = last.filter(c => c.close < c.open);
    const avgBody =
      bearish.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.max(1, bearish.length);

    return bearish.length >= 2 && avgBody > CLUSTER_ATR_FACTOR * atr;
  }

  private getBandDistance(ctx: BollingerContext): number {
    return Math.abs(ctx.close - ctx.middle) / ctx.middle;
  }

  private getEmaBias(ctx: BollingerContext): number {
    return (ctx.close - ctx.ema) / ctx.ema;
  }

  private buildContext(symbol: string): BollingerContext | null {
    const current = getCandle(symbol);
    const history = getHistory(symbol);
    if (!current || history.length < RSI_LONG_PERIOD + BB_PERIOD) return null;

    const closes = [...history.map(c => c.close), current.close];
    const bbSample = closes.slice(-BB_PERIOD);
    const mid = sma(bbSample);
    const sd = std(bbSample, mid);

    const rsiLong = calculateRSI(closes.slice(-(RSI_LONG_PERIOD + 1)), RSI_LONG_PERIOD);

    return {
      upper: mid + sd * BB_STD,
      lower: mid - sd * BB_STD,
      middle: mid,
      ema: ema(closes.slice(-EMA_PERIOD), EMA_PERIOD),
      rsiLong,
      close: current.close,
      atr: getATR(symbol),
      candles: history.slice(-5).map(c => ({ open: c.open, close: c.close })),
    };
  }
}

export const adaptiveBollingerStrategy = new AdaptiveBollingerEmaStrategy();
