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

// Константы для адаптивной настройки
const CONFIG = {
  MIN_ATR_PCT: 0.15,
  MIN_MOVE_THRESHOLD: 0.25,
  MIN_CVD_THRESHOLD: 500,
  HISTORY_LIMIT: 500,
  VOLUME_AVG_PERIOD: 30, // Считаем средний объем за 30 минут
} as const;

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
      if (state.history.length > CONFIG.HISTORY_LIMIT) state.history.shift();

      // Пересчитываем метрики при закрытии свечи
      state.atr = calculateATRFromCandles(state.history, 14);

      // Считаем средний объем за последние 30 минут
      const lastVols = state.history.slice(-CONFIG.VOLUME_AVG_PERIOD).map(c => c.volume);
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
    return { moveThreshold: CONFIG.MIN_MOVE_THRESHOLD, cvdThreshold: CONFIG.MIN_CVD_THRESHOLD };
  }

  const price = state.current.close;
  const atrPct = (state.atr / price) * 100;

  // Порог движения: минимум 0.25%, или 1.5 от текущей волатильности
  const moveThreshold = Math.max(atrPct * 1.5, CONFIG.MIN_MOVE_THRESHOLD);

  // Порог CVD: берем средний объем за 30 мин и требуем всплеск в 1.8 раза
  // Это делает порог индивидуальным для каждой монеты автоматически
  const cvdThreshold = Math.max(state.avgVolume * 1.8, CONFIG.MIN_CVD_THRESHOLD);

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
    if (state.history.length > CONFIG.HISTORY_LIMIT) {
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

  const lastVols = state.history.slice(-CONFIG.VOLUME_AVG_PERIOD).map(c => c.volume);
  state.avgVolume = lastVols.reduce((a, b) => a + b, 0) / (lastVols.length || 1);
}
