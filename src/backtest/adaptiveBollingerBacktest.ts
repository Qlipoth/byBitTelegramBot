import { pathToFileURL } from 'node:url';
import { adaptiveBollingerStrategy } from '../market/adaptiveBollingerStrategy.js';
import {
  ingestHistoricalCandle,
  type HistoricalCandleInput,
  getATR,
} from '../market/candleBuilder.js';
import {
  buildCachePath,
  fetchBybitCandles,
  readCandlesCache,
  INTERVAL_TO_MS,
  writeCandlesCache,
} from './candleLoader.js';
import { STRATEGY_CONFIG } from '../config/strategyConfig.js';
import type { GlobalTrend } from '../market/analysis.js';
import { detectDailyTrend } from '../market/analysis.js';

type TradeSide = 'LONG' | 'SHORT';

const BACKTEST_CFG = STRATEGY_CONFIG.adaptiveBacktest;

interface OpenTrade {
  side: TradeSide;
  entryPrice: number;
  stopPrice: number;
  takePrice: number;
  qty: number;
  entryTime: number;
  statIndex: number;
}

interface ClosedTrade extends OpenTrade {
  exitPrice: number;
  exitTime: number;
  pnl: number;
  reason: 'STOP' | 'TAKE' | 'FLIP' | 'MEAN';
}

interface TradeDiagnostic {
  side: TradeSide;
  entryTime: number;
  entryPrice: number;
  atr: number;
  rsi: number;
  distanceToMiddle: number;
  trendBias: 'LONG' | 'SHORT';
  stopDistance: number;
  takeDistance: number;
  exitPrice?: number;
  exitTime?: number;
  pnl?: number;
  reason?: ClosedTrade['reason'];
}

const DEFAULT_SYMBOL = 'ETHUSDT';
function annotateExit(diagnostics: TradeDiagnostic[], trade: OpenTrade, closed: ClosedTrade): void {
  const diag = diagnostics[trade.statIndex];
  if (!diag) return;
  diag.exitPrice = closed.exitPrice;
  diag.exitTime = closed.exitTime;
  diag.pnl = closed.pnl;
  diag.reason = closed.reason;
}

function applyInBarExit(
  trade: OpenTrade,
  candle: HistoricalCandleInput
): { reason: 'STOP' | 'TAKE'; price: number } | null {
  if (trade.side === 'LONG') {
    if (candle.low <= trade.stopPrice) {
      return { reason: 'STOP', price: trade.stopPrice };
    }
    if (candle.high >= trade.takePrice) {
      return { reason: 'TAKE', price: trade.takePrice };
    }
  } else {
    if (candle.high >= trade.stopPrice) {
      return { reason: 'STOP', price: trade.stopPrice };
    }
    if (candle.low <= trade.takePrice) {
      return { reason: 'TAKE', price: trade.takePrice };
    }
  }
  return null;
}

function checkMeanReversionExit(
  trade: OpenTrade,
  candle: HistoricalCandleInput,
  context: ReturnType<typeof adaptiveBollingerStrategy.getContext>
): { reason: 'MEAN'; price: number } | null {
  if (!context) return null;
  const { middle } = context;
  const meanTol = BACKTEST_CFG.meanExitTolerance;
  if (!Number.isFinite(middle)) {
    return null;
  }

  if (trade.side === 'LONG') {
    const triggerPrice = middle * (1 - meanTol);
    if (candle.high >= triggerPrice) {
      return { reason: 'MEAN', price: middle };
    }
  } else {
    const triggerPrice = middle * (1 + meanTol);
    if (candle.low <= triggerPrice) {
      return { reason: 'MEAN', price: middle };
    }
  }

  return null;
}

function computePositionSize(balance: number, stopDistance: number): number {
  if (stopDistance <= 0) return 0;
  const capitalRisked = balance * BACKTEST_CFG.riskPerTrade;
  return capitalRisked / stopDistance;
}

function closeTrade(
  trade: OpenTrade,
  exitPrice: number,
  exitTime: number,
  reason: ClosedTrade['reason']
): ClosedTrade {
  const direction = trade.side === 'LONG' ? 1 : -1;
  const rawPnl = (exitPrice - trade.entryPrice) * direction * trade.qty;

  const notionalEntry = trade.entryPrice * trade.qty;
  const notionalExit = exitPrice * trade.qty;
  const fee = (notionalEntry + notionalExit) * BACKTEST_CFG.feeRate;

  const pnl = rawPnl - fee;
  return {
    ...trade,
    exitPrice,
    exitTime,
    pnl,
    reason,
  };
}

async function runBacktest(
  candles: HistoricalCandleInput[],
  symbol: string = DEFAULT_SYMBOL,
  interval: keyof typeof INTERVAL_TO_MS = '5'
) {
  if (!candles.length) {
    throw new Error('❌ Нет исторических данных для бэктеста');
  }

  const expectedStep = INTERVAL_TO_MS[interval];
  if (!expectedStep) {
    throw new Error(`❌ Неизвестный интервал ${interval}`);
  }

  let gaps = 0;

  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i]!.timestamp - candles[i - 1]!.timestamp;
    if (diff !== expectedStep) {
      gaps++;
      console.log(
        `Разрыв в данных: ${new Date(candles[i - 1]!.timestamp).toISOString()} -> ${diff / 1000}сек`
      );
    }
  }

  console.log(`Обнаружено разрывов (пропусков интервала ${interval}m): ${gaps}`);

  const uniqueTimestamps = new Set(candles.map(c => c.timestamp));

  console.log('--- Проверка уникальности данных ---');
  console.log(`Всего свечей в массиве: ${candles.length}`);
  console.log(`Уникальных таймстампов: ${uniqueTimestamps.size}`);

  if (uniqueTimestamps.size !== candles.length) {
    console.warn(`⚠️ ВНИМАНИЕ: Обнаружено ${candles.length - uniqueTimestamps.size} дубликатов!`);
  } else {
    console.log('✅ Данные чистые: дубликатов нет.');
  }

  let balance: number = BACKTEST_CFG.startBalance;
  let maxEquity = balance;
  let maxDrawdown = 0;
  let openTrade: OpenTrade | null = null;
  const trades: ClosedTrade[] = [];
  const diagnostics: TradeDiagnostic[] = [];

  // История цен для определения глобального тренда (нужно минимум 200 свечей)
  const priceHistory: number[] = [];
  // История свечей для определения дневного тренда (по дням)
  const candlesByDay = new Map<string, HistoricalCandleInput[]>();

  // Функция для определения глобального тренда на основе истории цен
  const detectGlobalTrendFromPrices = (prices: number[]): GlobalTrend => {
    if (prices.length < 200) return 'NEUTRAL';
    
    // Упрощенный расчет EMA50 и EMA200
    const calculateEMA = (values: number[], period: number): number | null => {
      if (values.length < period) return null;
      const k = 2 / (period + 1);
      let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < values.length; i++) {
        ema = values[i]! * k + ema * (1 - k);
      }
      return ema;
    };

    const ema50 = calculateEMA(prices, 50);
    const ema200 = calculateEMA(prices, 200);
    
    if (ema50 === null || ema200 === null) return 'NEUTRAL';
    
    const buffer = ema200 * 0.001; // 0.1% буфер
    if (ema50 > ema200 + buffer) return 'BULLISH';
    if (ema50 < ema200 - buffer) return 'BEARISH';
    return 'NEUTRAL';
  };

  // Функция для определения дневного тренда на основе свечей за текущий день
  const detectDailyTrendFromCandles = (currentCandle: HistoricalCandleInput): GlobalTrend => {
    const candleDate = new Date(currentCandle.timestamp);
    const dayKey = `${candleDate.getUTCFullYear()}-${String(candleDate.getUTCMonth() + 1).padStart(2, '0')}-${String(candleDate.getUTCDate()).padStart(2, '0')}`;
    
    // Добавляем текущую свечу в историю дня
    if (!candlesByDay.has(dayKey)) {
      candlesByDay.set(dayKey, []);
    }
    const dayCandles = candlesByDay.get(dayKey)!;
    dayCandles.push(currentCandle);
    
    if (dayCandles.length < 2) return 'NEUTRAL';
    
    const firstPrice = dayCandles[0]!.close;
    const lastPrice = dayCandles[dayCandles.length - 1]!.close;
    const priceChangePct = ((lastPrice - firstPrice) / firstPrice) * 100;
    
    // Порог для определения тренда: 0.5% изменения за день
    const threshold = 0.5;
    
    if (priceChangePct > threshold) return 'BULLISH';
    if (priceChangePct < -threshold) return 'BEARISH';
    return 'NEUTRAL';
  };

  const commitClose = (trade: OpenTrade, closed: ClosedTrade) => {
    trades.push(closed);
    annotateExit(diagnostics, trade, closed);
    balance += closed.pnl;
    maxEquity = Math.max(maxEquity, balance);
    maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
  };

  for (const candle of candles) {
    // Добавляем цену закрытия в историю для определения тренда
    priceHistory.push(candle.close);
    // Держим только последние 200 свечей для экономии памяти
    if (priceHistory.length > 200) priceHistory.shift();
    ingestHistoricalCandle(symbol, candle);

    const signalResult = adaptiveBollingerStrategy.getSignal(symbol);
    const contextSnapshot = adaptiveBollingerStrategy.getContext(symbol);
    if (!signalResult.ready) {
      continue;
    }

    // 1️⃣ Проверка выхода из текущей позиции (ТОЛЬКО MEAN!)
    if (openTrade) {
      // Только mean reversion выход — чистый тест стратегии
      const meanExit = checkMeanReversionExit(openTrade, candle, contextSnapshot);
      if (meanExit) {
        const closed = closeTrade(openTrade, meanExit.price, candle.timestamp, meanExit.reason);
        commitClose(openTrade, closed);
        openTrade = null;
        continue;
      }
      const catastrophicPct = BACKTEST_CFG.catastrophicStopPct ?? 0.07;
      const catastrophicStop = (trade: OpenTrade) => {
        const pctMove = (candle.close - trade.entryPrice) / trade.entryPrice;
        if (trade.side === 'LONG' && pctMove < -catastrophicPct) return true;
        if (trade.side === 'SHORT' && pctMove > catastrophicPct) return true;
        return false;
      };
      if (catastrophicStop(openTrade)) {
        const closed = closeTrade(openTrade, candle.close, candle.timestamp, 'STOP');
        commitClose(openTrade, closed);
        openTrade = null;
        continue;
      }
    }

    // 2️⃣ Разворот по новому сигналу
    if (openTrade && signalResult.signal !== openTrade.side && signalResult.signal !== 'NONE') {
      const flipPrice = candle.close;
      const closed = closeTrade(openTrade, flipPrice, candle.timestamp, 'FLIP');
      commitClose(openTrade, closed);
      openTrade = null;
    }

    // 3️⃣ Условия входа
    if (!openTrade && (signalResult.signal === 'LONG' || signalResult.signal === 'SHORT')) {
      const side: TradeSide = signalResult.signal;
      // Определяем глобальный тренд для фильтрации входа
      const globalTrend = detectGlobalTrendFromPrices(priceHistory);
      // Определяем дневной тренд для дополнительной защиты
      const dailyTrend = detectDailyTrendFromCandles(candle);
      const confirmed = adaptiveBollingerStrategy.confirmEntry(symbol, side, globalTrend, dailyTrend);
      if (!confirmed) continue;

      const atr = getATR(symbol);
      if (!Number.isFinite(atr) || atr <= 0) continue;

      const stopDistance = atr * BACKTEST_CFG.stopAtrMult;
      const qty = computePositionSize(balance, stopDistance);
      if (qty <= 0) continue;

      const entryPrice = candle.close;
      const stopPrice: number =
        side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
      const takePrice: number =
        side === 'LONG' ? entryPrice + atr * BACKTEST_CFG.takeAtrMult : entryPrice - atr * BACKTEST_CFG.takeAtrMult;

      const distanceToMiddle =
        contextSnapshot && contextSnapshot.middle
          ? Math.abs(contextSnapshot.close - contextSnapshot.middle) / contextSnapshot.middle
          : 0;
      const trendBias =
        contextSnapshot && contextSnapshot.ema
          ? contextSnapshot.close >= contextSnapshot.ema * 0.998
            ? 'LONG'
            : 'SHORT'
          : 'LONG';
      const takeDistance = Math.abs(takePrice - entryPrice);

      const diagnosticEntry: TradeDiagnostic = {
        side,
        entryTime: candle.timestamp,
        entryPrice,
        atr,
        rsi: contextSnapshot?.rsiLong ?? 0,
        distanceToMiddle,
        trendBias,
        stopDistance,
        takeDistance,
      };

      const statIndex = diagnostics.length;
      diagnostics.push(diagnosticEntry);

      openTrade = {
        side,
        entryPrice,
        stopPrice,
        takePrice,
        qty,
        entryTime: candle.timestamp,
        statIndex,
      };
    }
  }

  // Закрываем подвисшую позицию по последней цене
  if (openTrade) {
    const lastCandle = candles[candles.length - 1]!;
    const closed = closeTrade(openTrade, lastCandle.close, lastCandle.timestamp, 'FLIP');
    commitClose(openTrade, closed);
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winrate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pnlTotal = balance - BACKTEST_CFG.startBalance;

  console.log('================ ADAPTIVE BOLLINGER BACKTEST ================');
  console.log(`Trades: ${trades.length}`);
  console.log(`Winrate: ${winrate.toFixed(2)}% (W:${wins.length} / L:${losses.length})`);
  console.log(`Net PnL: ${pnlTotal.toFixed(2)} USD`);
  console.log(`Final Balance: ${balance.toFixed(2)} USD`);
  console.log(`Max Drawdown: ${maxDrawdown.toFixed(2)} USD`);
  console.log('Top 5 trades by PnL:');
  trades
    .slice()
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 5)
    .forEach(trade => {
      console.log(
        `  ${new Date(trade.entryTime).toISOString()} | ${trade.side} | PnL: ${trade.pnl.toFixed(
          2
        )} USD | Reason: ${trade.reason}`
      );
    });

  const avg = (values: number[]) =>
    values.length ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;

  const avgAtr = avg(diagnostics.map(d => d.atr));
  const avgRsi = avg(diagnostics.map(d => d.rsi));
  const avgDistance = avg(diagnostics.map(d => d.distanceToMiddle));

  const closedDiagnostics = diagnostics.filter(d => typeof d.pnl === 'number');
  const avgHoldMinutes = avg(
    closedDiagnostics.map(d => ((d.exitTime ?? d.entryTime) - d.entryTime) / 60000)
  );

  const exitStats = closedDiagnostics.reduce<Record<string, number>>((acc, d) => {
    if (d.reason) {
      acc[d.reason] = (acc[d.reason] ?? 0) + 1;
    }
    return acc;
  }, {});

  console.log('--- Entry diagnostics ---');
  console.log(`Avg ATR: ${avgAtr.toFixed(4)}`);
  console.log(`Avg RSI: ${avgRsi.toFixed(2)}`);
  console.log(`Avg distance to middle: ${(avgDistance * 100).toFixed(2)}%`);
  console.log(`Avg hold time: ${avgHoldMinutes.toFixed(2)} min`);
  console.log(
    `Exit reasons: ${
      Object.entries(exitStats)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ') || 'нет закрытых сделок'
    }`
  );

  // По месяцам: винрейт, PnL, STOP vs MEAN, средний выигрыш/убыток
  const byMonth = new Map<
    string,
    { wins: number; losses: number; pnl: number; stopCount: number; meanCount: number; winSum: number; lossSum: number }
  >();
  for (const t of trades) {
    const date = new Date(t.entryTime);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key) ?? {
      wins: 0,
      losses: 0,
      pnl: 0,
      stopCount: 0,
      meanCount: 0,
      winSum: 0,
      lossSum: 0,
    };
    if (t.pnl > 0) {
      row.wins++;
      row.winSum += t.pnl;
    } else {
      row.losses++;
      row.lossSum += t.pnl;
    }
    row.pnl += t.pnl;
    if (t.reason === 'STOP') row.stopCount++;
    else if (t.reason === 'MEAN') row.meanCount++;
    byMonth.set(key, row);
  }
  const sortedMonths = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedMonths.length) {
    console.log('--- По месяцам (Winrate % | PnL USD | STOP/MEAN | avg win/loss) ---');
    for (const [month, row] of sortedMonths) {
      const total = row.wins + row.losses;
      const wr = total ? ((row.wins / total) * 100).toFixed(1) : '0';
      const pnlStr = row.pnl >= 0 ? `+${row.pnl.toFixed(2)}` : row.pnl.toFixed(2);
      const avgWin = row.wins ? (row.winSum / row.wins).toFixed(2) : '-';
      const avgLoss = row.losses ? (row.lossSum / row.losses).toFixed(2) : '-';
      console.log(
        `  ${month}: ${wr}% (W:${row.wins} L:${row.losses}) | PnL: ${pnlStr} | STOP:${row.stopCount} MEAN:${row.meanCount} | avg win: ${avgWin} avg loss: ${avgLoss}`
      );
    }
  }
}

async function runBacktestFromApi(params: {
  symbol: string;
  startTime: number;
  endTime: number;
  interval?: keyof typeof INTERVAL_TO_MS;
}) {
  const { symbol, startTime, endTime, interval = '5' } = params;
  const cachePath = buildCachePath(symbol, startTime, endTime, interval);

  let candles = await readCandlesCache(cachePath);

  if (candles && candles.length) {
    console.log(
      `📦 Найден кеш: ${candles.length} свечей для ${symbol} (${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()})`
    );
  } else {
    candles = null;
  }

  if (!candles) {
    console.log(
      `⬇️  Загружаю свечи ${symbol} c ${new Date(startTime).toISOString()} по ${new Date(endTime).toISOString()} (интервал ${interval}m)`
    );
    candles = await fetchBybitCandles({ symbol, start: startTime, end: endTime, interval });
    if (candles.length) {
      await writeCandlesCache(cachePath, candles);
      console.log(`💾 Кеш сохранен: ${cachePath}`);
    } else {
      console.warn('⚠️ Получен пустой массив свечей — кеш не сохранен');
    }
  }

  console.log(`📈 Получено ${candles.length} свечей. Запускаю бэктест...`);
  await runBacktest(candles, symbol, interval);
}

const isExecutedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutedDirectly) {
  const [, , startArg, endArg, symbol = DEFAULT_SYMBOL, intervalArg] = process.argv;
  const endTime = endArg ? Date.parse(endArg) : Date.now();
  const startTime = startArg ? Date.parse(startArg) : endTime - 120 * 24 * 60 * 60 * 1000;
  const interval =
    intervalArg && intervalArg in INTERVAL_TO_MS
      ? (intervalArg as keyof typeof INTERVAL_TO_MS)
      : '5';

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    console.error(
      'Usage: pnpm ts-node src/backtest/adaptiveBollingerBacktest.ts [START_ISO] [END_ISO] [SYMBOL] [INTERVAL]'
    );
    console.error(
      'Пример: pnpm ts-node src/backtest/adaptiveBollingerBacktest.ts 2024-01-01T00:00:00Z 2024-01-05T00:00:00Z ETHUSDT 5'
    );
    process.exit(1);
  }

  runBacktestFromApi({ symbol, startTime, endTime, interval })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Backtest failed:', err);
      process.exit(1);
    });
}
