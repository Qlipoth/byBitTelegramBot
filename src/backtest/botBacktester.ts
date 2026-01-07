import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ingestHistoricalCandle,
  type HistoricalCandleInput,
  candleState,
} from '../market/candleBuilder.js';
import { saveSnapshot, setSnapshotPersistenceMode } from '../market/snapshotStore.js';
import { BacktestTradeManager } from './backtestTradeManager.js';
import { startMarketWatcher } from '../market/watcher.js';
import { tradingState } from '../core/tradingState.js';
import { buildSyntheticCvdSeries, getCvdDifference } from './cvdBuilder.js';
import { buildCachePath, fetchBybitCandles, INTERVAL_TO_MS } from './candleLoader.js';
import dayjs from 'dayjs';
import type { MarketSnapshot } from '../market/types.js';

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

async function loadRecordedSnapshots(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<MarketSnapshot[]> {
  const filePath = path.resolve(process.cwd(), 'realSnaps.json');
  const raw = await fs.readFile(filePath, 'utf-8');
  const snapshots: MarketSnapshot[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MarketSnapshot;
      if (parsed.symbol !== symbol) continue;
      if (parsed.timestamp < startTime || parsed.timestamp > endTime) continue;
      snapshots.push(parsed);
    } catch (err) {
      console.warn('[BACKTEST] Failed to parse snapshot line:', err);
    }
  }
  snapshots.sort((a, b) => a.timestamp - b.timestamp);
  if (!snapshots.length) {
    throw new Error('No recorded snapshots found in realSnaps.json');
  }
  return snapshots;
}

function snapshotToCandle(
  snap: MarketSnapshot,
  prev: MarketSnapshot | undefined
): HistoricalCandleInput {
  const open = prev?.price ?? snap.price;
  const high = Math.max(open, snap.price);
  const low = Math.min(open, snap.price);
  const volume24hDelta = prev ? Math.max(0, snap.volume24h - prev.volume24h) : 0;
  return {
    timestamp: snap.timestamp,
    open,
    high,
    low,
    close: snap.price,
    volume: volume24hDelta,
  };
}

function getRecordedCvdValue(snapshot: MarketSnapshot | undefined, minutes: number) {
  if (!snapshot) return undefined;
  const fieldMap: Record<number, keyof MarketSnapshot> = {
    1: 'cvd1m',
    3: 'cvd3m',
    15: 'cvd15m',
    30: 'cvd30m',
  };
  const field = fieldMap[minutes];
  if (!field) return undefined;
  const value = snapshot[field];
  return typeof value === 'number' ? value : undefined;
}

async function runBotBacktest(params: BacktestRunParams) {
  setSnapshotPersistenceMode('backtest');
  const recordedSnapshots = await loadRecordedSnapshots(
    params.symbol,
    params.startTime,
    params.endTime
  );
  const snapshotByTimestamp = new Map(recordedSnapshots.map(snap => [snap.timestamp, snap]));
  const candles = recordedSnapshots.map((snap, idx) =>
    snapshotToCandle(snap, recordedSnapshots[idx - 1])
  );
  const cvdSeries = buildSyntheticCvdSeries(params.symbol, candles);

  const tradeExecutor = new BacktestTradeManager({ initialBalance: 10_000 });
  await tradeExecutor.bootstrap([params.symbol]);

  // Warm up candle builder history
  candleState[params.symbol] = undefined as any;
  const warmupCount = Math.min(50, recordedSnapshots.length);
  for (let i = 0; i < warmupCount; i++) {
    ingestHistoricalCandle(params.symbol, candles[i]!);
    saveSnapshot(recordedSnapshots[i]!);
  }

  // Replay using watcher
  let cursor = warmupCount;
  tradingState.enable();
  await startMarketWatcher(params.symbol, console.log, {
    tradeExecutor,
    snapshotProvider: async () => {
      if (cursor >= recordedSnapshots.length) return null;
      const snap = recordedSnapshots[cursor]!;
      ingestHistoricalCandle(params.symbol, candles[cursor]!);
      cursor++;
      return snap;
    },
    balanceProvider: async () => tradeExecutor.getBalance(),
    cvdProvider: (_symbol, minutes, referenceTs) => {
      const recordedValue = getRecordedCvdValue(snapshotByTimestamp.get(referenceTs), minutes);
      if (typeof recordedValue === 'number') {
        return recordedValue;
      }
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

const [, , startArg, endArg, symbol = 'ETHUSDT', intervalArg] = process.argv;
const endTime = dayjs(1767801677110).valueOf();

const diffMs = dayjs(endTime).diff(dayjs(1767792660000));
const startTime = endTime - diffMs;
const interval = '1';

runBotBacktest({ symbol, startTime, endTime, interval })
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Bot backtest failed:', err);
    process.exit(1);
  });
