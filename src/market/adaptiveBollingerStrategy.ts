import { calculateRSI } from './analysis.js';
import { getATR, getCandle, getHistory } from './candleBuilder.js';

export type AdaptiveSignal = 'LONG' | 'SHORT' | 'NONE';

interface BollingerContext {
  upper: number;
  lower: number;
  middle: number;
  ema: number;
  rsi: number;
  close: number;
  atr: number;
}

export interface AdaptiveSignalResult {
  ready: boolean;
  signal: AdaptiveSignal;
  entrySignal: string;
  longScore: number;
  shortScore: number;
  details: Record<string, unknown>;
}

const SUPPORTED_SYMBOLS = ['ETHUSDT'] as const;

const BB_PERIOD = 20; // Было 40
const EMA_PERIOD = 50;
const BB_STD = 2; // Было 1 (1 - слишком узко)
const RSI_PERIOD = 14; // Было 200 (Критично!)
// 2. Смягчаем пороги RSI
const LONG_RSI_THRESHOLD = 30; // Классика перепроданности
const SHORT_RSI_THRESHOLD = 70; // Классика перекупленности

function calculateSMA(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function calculateSTD(values: number[], mean: number): number {
  if (!values.length) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calculateEMA(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  return values.reduce((prev, curr, index) => {
    if (index === 0) return curr;
    return curr * k + prev * (1 - k);
  });
}

export class AdaptiveBollingerEmaStrategy {
  private readonly symbols = new Set<string>(SUPPORTED_SYMBOLS);
  private readonly contextMap = new Map<string, BollingerContext>();

  isSupported(symbol: string): symbol is (typeof SUPPORTED_SYMBOLS)[number] {
    return this.symbols.has(symbol);
  }

  getSignal(symbol: string): AdaptiveSignalResult {
    const context = this.buildContext(symbol);
    if (!context) {
      this.contextMap.delete(symbol);
      return {
        ready: false,
        signal: 'NONE',
        entrySignal: '⚪ Adaptive Bollinger: недостаточно данных',
        longScore: 0,
        shortScore: 0,
        details: { strategy: 'adaptive-bollinger-ema', reason: 'NO_CONTEXT' },
      };
    }

    this.contextMap.set(symbol, context);

    let signal: AdaptiveSignal = 'NONE';
    let entrySignal = `⚪ Adaptive Bollinger: нет сетапа`;
    let longScore = 0;
    let shortScore = 0;

    const trendBias = context.close >= context.ema * 0.998 ? 'LONG' : 'SHORT';

    if (
      context.close <= context.lower &&
      context.rsi <= LONG_RSI_THRESHOLD &&
      trendBias === 'LONG'
    ) {
      signal = 'LONG';
      longScore = 75;
      entrySignal = `🟢 Adaptive Bollinger LONG (${longScore}/100)`;
    } else if (
      context.close >= context.upper &&
      context.rsi >= SHORT_RSI_THRESHOLD &&
      trendBias === 'SHORT'
    ) {
      signal = 'SHORT';
      shortScore = 75;
      entrySignal = `🔴 Adaptive Bollinger SHORT (${shortScore}/100)`;
    }

    return {
      ready: true,
      signal,
      entrySignal,
      longScore,
      shortScore,
      details: {
        strategy: 'adaptive-bollinger-ema',
        rsi: context.rsi,
        ema: context.ema,
        upper: context.upper,
        lower: context.lower,
        middle: context.middle,
        close: context.close,
        atr: context.atr,
        trendBias,
      },
    };
  }

  confirmEntry(symbol: string, signal: AdaptiveSignal): boolean {
    if (signal === 'NONE') return false;
    const context = this.contextMap.get(symbol);
    if (!context) return false;

    const distanceToMiddle = Math.abs(context.close - context.middle) / context.middle;
    const trendBias = context.close >= context.ema * 0.998 ? 'LONG' : 'SHORT';

    // if (signal === 'LONG') {
    //   return (
    //     context.close > context.lower &&
    //     context.rsi > LONG_RSI_THRESHOLD + 2 &&
    //     distanceToMiddle <= 0.02
    //   );
    // }

    if (signal === 'LONG') {
      const reclaimedBand = context.close >= context.lower;
      return (
        trendBias === 'LONG' &&
        reclaimedBand &&
        context.rsi >= LONG_RSI_THRESHOLD - 2 &&
        distanceToMiddle <= 0.03
      );
    }

    if (signal === 'SHORT') {
      const reclaimedBand = context.close <= context.upper;
      return (
        trendBias === 'SHORT' &&
        reclaimedBand &&
        context.rsi <= SHORT_RSI_THRESHOLD + 2 &&
        distanceToMiddle <= 0.03
      );
    }

    return false;
  }

  getContext(symbol: string): BollingerContext | null {
    return this.contextMap.get(symbol) ?? null;
  }

  private buildContext(symbol: string): BollingerContext | null {
    const current = getCandle(symbol);
    if (!current) return null;

    const history = getHistory(symbol);
    const closes = [...history.map(c => c.close), current.close];

    const minRequired = Math.max(BB_PERIOD, EMA_PERIOD, RSI_PERIOD) + 1;
    if (closes.length < minRequired) {
      return null;
    }

    const bbSample = closes.slice(-BB_PERIOD);
    const middle = calculateSMA(bbSample);
    const std = calculateSTD(bbSample, middle);
    const upper = middle + std * BB_STD;
    const lower = middle - std * BB_STD;

    const emaSample = closes.slice(-EMA_PERIOD);
    const ema = calculateEMA(emaSample, EMA_PERIOD);

    const rsiSeries = closes.slice(-(RSI_PERIOD + 1));
    const rsi = calculateRSI(rsiSeries, RSI_PERIOD);

    const atr = getATR(symbol);

    return {
      upper,
      lower,
      middle,
      ema,
      rsi,
      close: current.close,
      atr,
    };
  }
}

export const adaptiveBollingerStrategy = new AdaptiveBollingerEmaStrategy();
