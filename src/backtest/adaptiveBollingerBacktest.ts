import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adaptiveBollingerStrategy } from '../market/adaptiveBollingerStrategy.js';
import {
  ingestHistoricalCandle,
  type HistoricalCandleInput,
  getATR,
} from '../market/candleBuilder.js';

type TradeSide = 'LONG' | 'SHORT';

const fetchFn: typeof fetch =
  globalThis.fetch ??
  (() => {
    throw new Error('Global fetch API недоступен в этой версии Node.js');
  });

const INTERVAL_TO_MS: Record<string, number> = {
  '1': 60_000,
};

interface FetchCandlesParams {
  symbol: string;
  start: number;
  end: number;
  interval?: keyof typeof INTERVAL_TO_MS;
  category?: 'linear' | 'inverse' | 'option' | 'spot';
  limit?: number;
}

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
  reason: 'STOP' | 'TAKE' | 'FLIP';
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
const STOP_ATR_MULT = 1.5;
const TAKE_ATR_MULT = 3;
const RISK_PER_TRADE = 0.01; // 1% от баланса
const START_BALANCE = 10_000;
const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'bybit');

function buildCachePath(
  symbol: string,
  start: number,
  end: number,
  interval: keyof typeof INTERVAL_TO_MS
): string {
  const safeSymbol = symbol.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  return path.join(CACHE_DIR, `${safeSymbol}_${start}_${end}_${interval}.json`);
}

async function readCandlesCache(cachePath: string): Promise<HistoricalCandleInput[] | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as HistoricalCandleInput[];
    if (Array.isArray(parsed) && parsed.length) {
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CACHE] Не удалось прочитать ${cachePath}:`, err);
    }
  }
  return null;
}

async function writeCandlesCache(
  cachePath: string,
  candles: HistoricalCandleInput[]
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(candles));
}

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

function computePositionSize(balance: number, stopDistance: number): number {
  if (stopDistance <= 0) return 0;
  const capitalRisked = balance * RISK_PER_TRADE;
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

  const FEE_RATE = 0.0005; // 0.05 %

  const notionalEntry = trade.entryPrice * trade.qty;
  const notionalExit = exitPrice * trade.qty;
  const fee = (notionalEntry + notionalExit) * FEE_RATE;

  const pnl = rawPnl - fee;
  return {
    ...trade,
    exitPrice,
    exitTime,
    pnl,
    reason,
  };
}

async function fetchBybitCandles(params: FetchCandlesParams): Promise<HistoricalCandleInput[]> {
  const { symbol, start, end, interval = '1', category = 'linear', limit = 1000 } = params;
  const step = INTERVAL_TO_MS[interval];
  if (!step) throw new Error(`Неизвестный интервал ${interval}`);

  let currentStart = start;
  const allCandles: HistoricalCandleInput[] = [];

  console.log(`[LOADER] Начинаю загрузку с ${new Date(start).toISOString()}`);

  while (currentStart < end) {
    const url = new URL('https://api.bybit.com/v5/market/kline');
    url.searchParams.set('category', category);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('start', String(currentStart));
    // url.searchParams.set('end', String(end)); // Убираем, чтобы лимит работал корректно от start
    url.searchParams.set('limit', String(limit));

    const response = await fetchFn(url);
    const payload = (await response.json()) as any;

    if (payload.retCode !== 0 || !payload.result?.list?.length) {
      console.log(`[LOADER] Данные закончились или ошибка: ${payload.retMsg}`);
      break;
    }

    // Bybit V5: [0] - самая новая, [n] - самая старая.
    // Преобразуем и разворачиваем, чтобы в конце была самая свежая свеча.
    const batch: HistoricalCandleInput[] = payload.result.list
      .map((row: string[]) => ({
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
      .reverse();

    allCandles.push(...batch);

    // Берем время последней полученной свечи и делаем шаг вперед
    const lastTimestamp = batch[batch.length - 1]?.timestamp;

    if (!lastTimestamp) {
      throw new Error('Не получен', ('' + lastTimestamp) as any);
    }
    // Если мы не сдвинулись (API вернул то же самое), выходим, чтобы не зациклиться
    if (lastTimestamp <= currentStart) {
      break;
    }

    currentStart = lastTimestamp + step;

    console.log(
      `[LOADER] Загружено ${allCandles.length} свечей. Последняя дата: ${new Date(lastTimestamp).toISOString()}`
    );

    if (batch.length < limit) break;
    if (currentStart >= end) break;

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  // Финальная фильтрация, чтобы не вылезти за end
  const finalCandles = allCandles.filter(c => c.timestamp >= start && c.timestamp <= end);

  // Удаляем дубликаты по timestamp (на всякий случай)
  const uniqueCandles = Array.from(new Map(finalCandles.map(c => [c.timestamp, c])).values());

  return uniqueCandles.sort((a, b) => a.timestamp - b.timestamp);
}

async function runBacktest(candles: HistoricalCandleInput[], symbol: string = DEFAULT_SYMBOL) {
  if (!candles.length) {
    throw new Error('❌ Нет исторических данных для бэктеста');
  }

  let gaps = 0;
  const EXPECTED_STEP = 60_000; // 1 минута в мс

  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i]!.timestamp - candles[i - 1]!.timestamp;
    if (diff !== EXPECTED_STEP) {
      gaps++;
      console.log(
        `Разрыв в данных: ${new Date(candles[i - 1]!.timestamp).toISOString()} -> ${diff / 1000}сек`
      );
    }
  }

  console.log(`Обнаружено разрывов (пропусков минут): ${gaps}`);

  const uniqueTimestamps = new Set(candles.map(c => c.timestamp));

  console.log('--- Проверка уникальности данных ---');
  console.log(`Всего свечей в массиве: ${candles.length}`);
  console.log(`Уникальных таймстампов: ${uniqueTimestamps.size}`);

  if (uniqueTimestamps.size !== candles.length) {
    console.warn(`⚠️ ВНИМАНИЕ: Обнаружено ${candles.length - uniqueTimestamps.size} дубликатов!`);
  } else {
    console.log('✅ Данные чистые: дубликатов нет.');
  }

  let balance = START_BALANCE;
  let maxEquity = balance;
  let maxDrawdown = 0;
  let openTrade: OpenTrade | null = null;
  const trades: ClosedTrade[] = [];
  const diagnostics: TradeDiagnostic[] = [];

  for (const candle of candles) {
    ingestHistoricalCandle(symbol, candle);

    const signalResult = adaptiveBollingerStrategy.getSignal(symbol);
    if (!signalResult.ready) {
      continue;
    }

    // 1️⃣ Проверка выхода из текущей позиции (по стопу/тейку)
    if (openTrade) {
      const exit = applyInBarExit(openTrade, candle);
      if (exit) {
        const closed = closeTrade(openTrade, exit.price, candle.timestamp, exit.reason);
        trades.push(closed);
        annotateExit(diagnostics, openTrade, closed);
        balance += closed.pnl;
        maxEquity = Math.max(maxEquity, balance);
        maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
        openTrade = null;
      }
    }

    // 2️⃣ Разворот по новому сигналу
    if (openTrade && signalResult.signal !== openTrade.side && signalResult.signal !== 'NONE') {
      const flipPrice = candle.close;
      const closed = closeTrade(openTrade, flipPrice, candle.timestamp, 'FLIP');
      trades.push(closed);
      annotateExit(diagnostics, openTrade, closed);
      balance += closed.pnl;
      maxEquity = Math.max(maxEquity, balance);
      maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
      openTrade = null;
    }

    // 3️⃣ Условия входа
    if (!openTrade && (signalResult.signal === 'LONG' || signalResult.signal === 'SHORT')) {
      const side: TradeSide = signalResult.signal;
      const confirmed = adaptiveBollingerStrategy.confirmEntry(symbol, side);
      if (!confirmed) continue;

      const atr = getATR(symbol);
      if (!Number.isFinite(atr) || atr <= 0) continue;

      const stopDistance = atr * STOP_ATR_MULT;
      const qty = computePositionSize(balance, stopDistance);
      if (qty <= 0) continue;

      const entryPrice = candle.close;
      const stopPrice: number =
        side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
      const takePrice: number =
        side === 'LONG' ? entryPrice + atr * TAKE_ATR_MULT : entryPrice - atr * TAKE_ATR_MULT;

      const contextSnapshot = adaptiveBollingerStrategy.getContext(symbol);
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
        rsi: contextSnapshot?.rsi ?? 0,
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
    trades.push(closed);
    annotateExit(diagnostics, openTrade, closed);
    balance += closed.pnl;
    maxEquity = Math.max(maxEquity, balance);
    maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winrate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pnlTotal = balance - START_BALANCE;

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
}

async function runBacktestFromApi(params: {
  symbol: string;
  startTime: number;
  endTime: number;
  interval?: keyof typeof INTERVAL_TO_MS;
}) {
  const { symbol, startTime, endTime, interval = '1' } = params;
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
  await runBacktest(candles, symbol);
}

const isExecutedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutedDirectly) {
  const [, , startArg, endArg, symbol = DEFAULT_SYMBOL] = process.argv;
  const endTime = endArg ? Date.parse(endArg) : Date.now();
  const startTime = startArg ? Date.parse(startArg) : endTime - 30 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    console.error(
      'Usage: pnpm ts-node src/backtest/adaptiveBollingerBacktest.ts [START_ISO] [END_ISO] [SYMBOL]'
    );
    console.error(
      'Пример: pnpm ts-node src/backtest/adaptiveBollingerBacktest.ts 2024-01-01T00:00:00Z 2024-01-05T00:00:00Z ETHUSDT'
    );
    process.exit(1);
  }

  runBacktestFromApi({ symbol, startTime, endTime })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Backtest failed:', err);
      process.exit(1);
    });
}
