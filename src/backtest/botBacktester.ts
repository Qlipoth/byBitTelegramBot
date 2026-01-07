import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adaptiveBollingerStrategy } from '../market/adaptiveBollingerStrategy.js';
import {
  ingestHistoricalCandle,
  type HistoricalCandleInput,
  candleState,
} from '../market/candleBuilder.js';
import { getSnapshots, saveSnapshot } from '../market/snapshotStore.js';
import { BacktestTradeManager } from './backtestTradeManager.js';
import { startMarketWatcher } from '../market/watcher.js';
import { tradingState } from '../core/tradingState.js';
import { buildSyntheticCvdSeries, getCvdDifference } from './cvdBuilder.js';
import {
  buildCachePath,
  fetchBybitCandles,
  fetchOpenInterestSeries,
  fetchFundingRateSeries,
  INTERVAL_TO_MS,
  type OpenInterestPoint,
  type FundingRatePoint,
} from './candleLoader.js';

interface BacktestRunParams {
  symbol: string;
  startTime: number;
  endTime: number;
  interval?: '1' | '3' | '5' | '15';
}

async function loadHistoricalCandles(params: BacktestRunParams): Promise<HistoricalCandleInput[]> {
  const { symbol, startTime, endTime, interval = '5' } = params;
  const cachePath = buildCachePath(symbol, startTime, endTime, interval);

  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as HistoricalCandleInput[];
    if (Array.isArray(parsed) && parsed.length) {
      console.log(`📦 Cache hit (${parsed.length} candles)`);
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CACHE] read failed for ${cachePath}:`, err);
    }
  }

  console.log(`⬇️  Loading ${symbol} ${interval}m candles from API...`);
  const candles = await fetchBybitCandles({ symbol, start: startTime, end: endTime, interval });
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(candles));
  console.log(`💾 Cache saved to ${cachePath}`);
  return candles;
}

function createSeriesStepper<T>(series: T[], getValue: (point: T) => number, defaultValue = 0) {
  let idx = 0;
  let current = defaultValue;
  return (timestamp: number) => {
    while (idx < series.length && (series[idx] as any).timestamp <= timestamp) {
      current = getValue(series[idx]!);
      idx++;
    }
    return current;
  };
}

function createVolumeTracker(windowMs: number) {
  const queue: { timestamp: number; volume: number }[] = [];
  let sum = 0;
  return (timestamp: number, volume: number) => {
    queue.push({ timestamp, volume });
    sum += volume;
    while (queue.length && timestamp - queue[0]!.timestamp >= windowMs) {
      sum -= queue.shift()!.volume;
    }
    return sum;
  };
}

async function runBotBacktest(params: BacktestRunParams) {
  const candles = await loadHistoricalCandles(params);
  if (!candles.length) {
    throw new Error('No candles loaded for backtest');
  }
  const cvdSeries = buildSyntheticCvdSeries(params.symbol, candles);

  const [oiSeries, fundingSeries] = await Promise.all([
    fetchOpenInterestSeries({
      symbol: params.symbol,
      start: params.startTime,
      end: params.endTime,
    }),
    fetchFundingRateSeries({
      symbol: params.symbol,
      start: params.startTime,
      end: params.endTime,
    }),
  ]);

  const interval = params.interval ?? '5';
  const intervalMs = INTERVAL_TO_MS[interval];
  const volumeTracker = createVolumeTracker(24 * 60 * 60 * 1000);
  const getOpenInterest = createSeriesStepper<OpenInterestPoint>(
    oiSeries,
    point => point.openInterest,
    oiSeries[0]?.openInterest ?? 0
  );
  const getFundingRate = createSeriesStepper<FundingRatePoint>(
    fundingSeries,
    point => point.fundingRate,
    fundingSeries[0]?.fundingRate ?? 0
  );

  const tradeExecutor = new BacktestTradeManager({ initialBalance: 10_000 });
  await tradeExecutor.bootstrap([params.symbol]);

  // Warm up candle builder history
  candleState[params.symbol] = undefined as any;
  for (const candle of candles.slice(0, 50)) {
    ingestHistoricalCandle(params.symbol, candle);
    const volume24h = volumeTracker(candle.timestamp, candle.volume);
    saveSnapshot({
      symbol: params.symbol,
      price: candle.close,
      volume24h,
      openInterest: getOpenInterest(candle.timestamp),
      fundingRate: getFundingRate(candle.timestamp),
      timestamp: candle.timestamp,
    });
  }

  // Replay using watcher
  let cursor = 50;
  tradingState.enable();
  await startMarketWatcher(params.symbol, console.log, {
    tradeExecutor,
    snapshotProvider: async () => {
      if (cursor >= candles.length) return null;
      const candle = candles[cursor++]!;
      ingestHistoricalCandle(params.symbol, candle);
      const volume24h = volumeTracker(candle.timestamp, candle.volume);
      return {
        symbol: params.symbol,
        price: candle.close,
        volume24h,
        openInterest: getOpenInterest(candle.timestamp),
        fundingRate: getFundingRate(candle.timestamp),
        timestamp: candle.timestamp,
      };
    },
    balanceProvider: async () => tradeExecutor.getBalance(),
    cvdProvider: (_symbol, minutes, referenceTs) => {
      const windowMs = minutes * 60_000;
      const fromTs = referenceTs - windowMs;
      return getCvdDifference(cvdSeries, fromTs, referenceTs);
    },
    intervalMs: 0,
    enableRealtime: false,
    entryMode: 'classic',
  });

  const stats = tradeExecutor.getStats();
  console.log('================ BOT BACKTEST REPORT ================');
  console.log(`Symbol: ${params.symbol}`);
  console.log(`Trades: ${stats.trades}`);
  console.log(`Winrate: ${stats.winrate.toFixed(2)}% (W:${stats.wins} / L:${stats.losses})`);
  console.log(`Net PnL: ${stats.pnlTotal.toFixed(2)} USD`);
  console.log(`Final Balance: ${stats.balance.toFixed(2)} USD`);
  console.log(`Max Drawdown: ${stats.maxDrawdown.toFixed(2)} USD`);
}

const [, , startArg, endArg, symbol = 'PIPPINUSDT', intervalArg] = process.argv;
const endTime = endArg ? Date.parse(endArg) : Date.now();
const startTime = startArg ? Date.parse(startArg) : endTime - 60 * 24 * 60 * 60 * 1000;
const interval = '1';

runBotBacktest({ symbol, startTime, endTime, interval })
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Bot backtest failed:', err);
    process.exit(1);
  });
