import { STRATEGY_CONFIG } from '../config/strategyConfig.js';

// Интерфейс для хранения данных свечи
interface Candle {
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SymbolCandleState {
  current: Candle | null;
  history: Candle[];
  atr: number;
  avgVolume: number; // Средний объем за период
}

interface CandleState {
  [symbol: string]: SymbolCandleState;
}

export const candleState: CandleState = {};

/** 1h свечи для Bollinger в лайве (как в бэктесте) */
const candleState1h: CandleState = {};

const candleConfig = STRATEGY_CONFIG.candleBuilder;

const HISTORY_LIMIT_1H = 250;

export function initSymbol(symbol: string): void {
  if (!candleState[symbol]) {
    candleState[symbol] = {
      current: null,
      history: [],
      atr: 0,
      avgVolume: 0,
    };
  }
}

export function initSymbol1h(symbol: string): void {
  if (!candleState1h[symbol]) {
    candleState1h[symbol] = {
      current: null,
      history: [],
      atr: 0,
      avgVolume: 0,
    };
  }
}

interface TradeMessage {
  p: string;
  v: string;
  S: string;
  T: number;
}

export function handleTrade(symbol: string, trade: TradeMessage): void {
  initSymbol(symbol);
  const state = candleState[symbol]!;
  const price = parseFloat(trade.p);
  const ts = trade.T;
  const minute = Math.floor(ts / 60000);

  if (!state.current || state.current.minute !== minute) {
    if (state.current) {
      state.history.push(state.current);
      if (state.history.length > candleConfig.historyLimit) state.history.shift();

      // Пересчитываем метрики при закрытии свечи
      state.atr = calculateATRFromCandles(state.history, 14);

      // Считаем средний объем за последние 30 минут
      const lastVols = state.history.slice(-candleConfig.volumeAvgPeriod).map(c => c.volume);
      state.avgVolume = lastVols.reduce((a, b) => a + b, 0) / (lastVols.length || 1);
    }

    state.current = { minute, open: price, high: price, low: price, close: price, volume: 0 };
  }

  state.current.high = Math.max(state.current.high, price);
  state.current.low = Math.min(state.current.low, price);
  state.current.close = price;
  state.current.volume += parseFloat(trade.v);
}

// Расчет порогов (теперь динамический)
export function getCvdThreshold(symbol: string) {
  const state = candleState[symbol];
  if (!state || !state.current || state.history.length < 15) {
    return {
      moveThreshold: candleConfig.minMoveThreshold,
      cvdThreshold: candleConfig.minCvdThreshold,
    };
  }

  const price = state.current.close;
  const atrPct = (state.atr / price) * 100;

  // Порог движения: минимум 0.15%, или 1.2 от текущей волатильности
  const moveThreshold = Math.max(atrPct * 1.2, candleConfig.minMoveThreshold);

  // Порог CVD: берем средний объем за 30 мин и требуем всплеск в 1.3 раза
  // Это делает порог индивидуальным для каждой монеты автоматически
  const cvdThreshold = Math.max(state.avgVolume * 1.3, candleConfig.minCvdThreshold);

  return {
    moveThreshold: Number(moveThreshold.toFixed(3)),
    cvdThreshold: Math.round(cvdThreshold),
  };
}

// Тот самый CSI (Cluster Strength Index) для фильтрации шума
export function getCSI(symbol: string): number {
  const state = candleState[symbol];
  if (!state?.current) return 0;

  const c = state.current;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.0001;
  const bodyRatio = body / range; // Насколько "полная" свеча

  const volScore = state.avgVolume > 0 ? c.volume / state.avgVolume : 1;
  const direction = c.close > c.open ? 1 : -1;

  // Индекс силы: сочетание наполненности свечи и всплеска объема
  return direction * (bodyRatio * 0.6 + (volScore / 3) * 0.4);
}

// Вспомогательные функции (остались почти без изменений)
export function calculateATRFromCandles(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    tr.push(
      Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      )
    );
  }
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

export function getCandle(symbol: string) {
  return candleState[symbol]?.current ?? null;
}
export function getATR(symbol: string) {
  return candleState[symbol]?.atr ?? 0;
}
export function getHistory(symbol: string) {
  return candleState[symbol]?.history ?? [];
}

export function getCandle1h(symbol: string) {
  return candleState1h[symbol]?.current ?? null;
}
export function getHistory1h(symbol: string) {
  return candleState1h[symbol]?.history ?? [];
}
export function getATR1h(symbol: string) {
  return candleState1h[symbol]?.atr ?? 0;
}
export function getAvgVolume(symbol: string) {
  return candleState[symbol]?.avgVolume ?? 0;
}

export function calcPercentChange(symbol: string, minutes: number = 15) {
  const state = candleState[symbol];
  if (!state?.current || state.history.length < minutes) return 0;
  const price15mAgo = state.history.at(-minutes)!.close;
  return ((state.current.close - price15mAgo) / price15mAgo) * 100;
}

export interface HistoricalCandleInput {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function ingestHistoricalCandle(symbol: string, candle: HistoricalCandleInput) {
  initSymbol(symbol);
  const state = candleState[symbol]!;

  if (state.current) {
    state.history.push(state.current);
    if (state.history.length > candleConfig.historyLimit) {
      state.history.shift();
    }
  }

  state.current = {
    minute: Math.floor(candle.timestamp / 60000),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };

  state.atr = calculateATRFromCandles(state.history, 14);

  const lastVols = state.history.slice(-candleConfig.volumeAvgPeriod).map(c => c.volume);
  state.avgVolume = lastVols.reduce((a, b) => a + b, 0) / (lastVols.length || 1);
}

/**
 * Синхронизирует 1h свечи для символа (как в бэктесте).
 * Вызывается из watcher при adaptive mode перед getSignal.
 */
export function ingest1hCandles(symbol: string, candles: HistoricalCandleInput[]) {
  initSymbol1h(symbol);
  const state = candleState1h[symbol]!;
  state.history = [];
  state.current = null;
  for (const c of candles) {
    if (state.current) {
      state.history.push(state.current);
      if (state.history.length >= HISTORY_LIMIT_1H) state.history.shift();
    }
    state.current = {
      minute: Math.floor(c.timestamp / 3600000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    };
  }
  const all1h = state.current ? [...state.history, state.current] : state.history;
  state.atr = all1h.length >= 15 ? calculateATRFromCandles(all1h, 14) : 0;
  const lastVols = state.history.slice(-14).map(h => h.volume);
  state.avgVolume = lastVols.length ? lastVols.reduce((a, b) => a + b, 0) / lastVols.length : 0;
}
