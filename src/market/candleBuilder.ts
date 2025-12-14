// Интерфейс для хранения данных свечи
interface Candle {
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Интерфейс состояния для каждого символа
interface SymbolCandleState {
  current: Candle | null;
  history: Candle[];
  atr: number;
}

// Тип для глобального состояния свечей
interface CandleState {
  [symbol: string]: SymbolCandleState;
}

export const candleState: CandleState = {};

export function initSymbol(symbol: string): void {
  if (!candleState[symbol]) {
    candleState[symbol] = {
      current: null,
      history: [],
      atr: 0,
    };
  }
}

// Интерфейс для торгового сообщения
interface TradeMessage {
  p: string; // price
  v: string; // volume
  S: string; // Buy / Sell
  T: number; // timestamp (ms)
}

export function handleTrade(symbol: string, trade: TradeMessage): void {
  initSymbol(symbol);

  const state = candleState[symbol] as SymbolCandleState;
  const price = parseFloat(trade.p);
  const ts = trade.T;

  // Вычисляем минуту (целые минуты)
  const minute = Math.floor(ts / 60000);

  // Если свечи нет — создаём новую
  if (!state.current || state.current.minute !== minute) {
    if (state.current) {
      // Закрываем прошлую свечу
      state.history.push(state.current);

      // Ограничиваем историю
      if (state.history.length > 500) {
        state.history.shift();
      }

      // Пересчитываем ATR после закрытия свечи
      state.atr = calculateATRFromCandles(state.history, 14);
    }

    // Создаём новую свечу
    state.current = {
      minute,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
  }

  // Обновляем текущую свечу
  state.current.high = Math.max(state.current.high, price);
  state.current.low = Math.min(state.current.low, price);
  state.current.close = price;
  state.current.volume += parseFloat(trade.v);
}

export function calculateATRFromCandles(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (curr) {
      const trueRange = Math.max(
        curr.high - curr.low,
        prev ? Math.abs(curr.high - prev.close) : 0,
        prev ? Math.abs(curr.low - prev.close) : 0
      );

      tr.push(trueRange);
    }
  }

  // SMA первой части
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder smoothing
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }

  return atr;
}

export function getCandle(symbol: string): Candle | null {
  return candleState[symbol]?.current ?? null;
}

export function getATR(symbol: string): number {
  return candleState[symbol]?.atr ?? 0;
}

export function getHistory(symbol: string): Candle[] {
  return candleState[symbol]?.history ?? [];
}

export function calcPercentChange(symbol: string) {
  const history = getHistory(symbol); // массив свечей
  const currentCandle = getCandle(symbol);
  if (!currentCandle) {
    console.log('Не найдена свеча!');
    return 0;
  }

  const candle15minAgo = history.at(-15); // 15 свечей назад (1m each)
  if (!candle15minAgo) {
    console.log('Не найдена свеча 15 свечей назад!');
    return 0;
  }

  const priceNow = currentCandle.close;
  const price15mAgo = candle15minAgo.close;

  return ((priceNow - price15mAgo) / price15mAgo) * 100;
}

// Константы для настройки
const CONFIG = {
  MIN_ATR_PCT: 0.2, // Минимальная волатильность
  MIN_MOVE_THRESHOLD: 1.0, // Минимальный порог движения (%)
  MIN_CVD_THRESHOLD: 5000, // Минимальный порог CVD
  ATR_MULTIPLIER: 2, // Множитель для порога движения
  CVD_MULTIPLIER: 1500, // Множитель для порога CVD
} as const;

export function getCvdThreshold(symbol: string) {
  const atr = getATR(symbol);
  const price = getCandle(symbol)?.close ?? 0;

  if (!atr || !price) {
    console.warn(`Insufficient data for ${symbol}: price=${price}, atr=${atr}`);
    return {
      moveThreshold: CONFIG.MIN_MOVE_THRESHOLD,
      cvdThreshold: CONFIG.MIN_CVD_THRESHOLD,
    };
  }

  const atrPct = Math.max((atr / price) * 100, CONFIG.MIN_ATR_PCT);
  const moveThreshold = Math.max(atrPct * CONFIG.ATR_MULTIPLIER, CONFIG.MIN_MOVE_THRESHOLD);
  const cvdThreshold = Math.max(atrPct * CONFIG.CVD_MULTIPLIER, CONFIG.MIN_CVD_THRESHOLD);

  return { moveThreshold, cvdThreshold };
}
