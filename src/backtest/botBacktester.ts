import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ingestHistoricalCandle,
  type HistoricalCandleInput,
  candleState,
} from '../market/candleBuilder.js';
import {
  DEFAULT_SNAPSHOT_FILE,
  saveSnapshot,
  setSnapshotPersistenceMode,
  SYMBOL_HISTORY_FILES,
} from '../market/snapshotStore.js';
import { BacktestTradeManager } from './backtestTradeManager.js';
import { startMarketWatcher } from '../market/watcher.js';
import { tradingState } from '../core/tradingState.js';
import { buildSyntheticCvdSeries, getCvdDifference } from './cvdBuilder.js';
import { buildCachePath, fetchBybitCandles, INTERVAL_TO_MS } from './candleLoader.js';
import dayjs from 'dayjs';
import type { MarketSnapshot, SymbolValue } from '../market/types.js';
import { getCvdThreshold } from '../market/candleBuilder.js';
import { selectCoinThresholds } from '../market/utils.js';
import {
  BASE_IMPULSE_THRESHOLDS,
  LIQUID_IMPULSE_THRESHOLDS,
  PRIORITY_COINS,
} from '../market/constants.market.js';

interface BacktestRunParams {
  symbol: string;
  startTime: number;
  endTime: number;
  interval?: '1' | '3' | '5' | '15';
  snapshotFilePath: string;
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

const FALLBACK_SNAPSHOT_FILE_PATH = DEFAULT_SNAPSHOT_FILE;
const HISTORY_SYMBOL_SET = new Set(Object.keys(SYMBOL_HISTORY_FILES));

function normalizeSymbolInput(rawSymbol: string | undefined) {
  const upper = (rawSymbol ?? 'DOGEUSDT').toUpperCase();
  return upper.endsWith('USDT') ? upper : `${upper}USDT`;
}

function resolveSnapshotFilePath(symbol: string) {
  if (HISTORY_SYMBOL_SET.has(symbol)) {
    return SYMBOL_HISTORY_FILES[symbol as keyof typeof SYMBOL_HISTORY_FILES];
  }
  return FALLBACK_SNAPSHOT_FILE_PATH;
}

function isPrioritySymbol(symbol: string) {
  return PRIORITY_COINS.includes(symbol as any);
}

function ensureSnapshotThresholds(symbol: string, snap: MarketSnapshot): MarketSnapshot {
  if (snap.thresholds) return snap;
  const isPriority = isPrioritySymbol(symbol);
  const { cvdThreshold, moveThreshold } = getCvdThreshold(symbol);
  const { oiThreshold } = selectCoinThresholds(symbol as SymbolValue);
  snap.thresholds = {
    moveThreshold,
    cvdThreshold,
    oiThreshold,
    impulse: {
      PRICE_SURGE_PCT: moveThreshold,
      VOL_SURGE_CVD: cvdThreshold,
      OI_INCREASE_PCT: isPriority
        ? LIQUID_IMPULSE_THRESHOLDS.OI_INCREASE_PCT
        : BASE_IMPULSE_THRESHOLDS.OI_INCREASE_PCT,
      OI_SURGE_PCT: isPriority
        ? LIQUID_IMPULSE_THRESHOLDS.OI_SURGE_PCT
        : BASE_IMPULSE_THRESHOLDS.OI_SURGE_PCT,
    },
  };
  return snap;
}

async function loadRecordedSnapshots(
  symbol: string,
  startTime: number,
  endTime: number,
  snapshotFilePath: string
): Promise<MarketSnapshot[]> {
  const raw = await fs.readFile(snapshotFilePath, 'utf-8');
  const snapshots: MarketSnapshot[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MarketSnapshot;
      if (parsed.symbol !== symbol) continue;
      if (parsed.timestamp < startTime || parsed.timestamp > endTime) continue;
      snapshots.push(ensureSnapshotThresholds(symbol, parsed));
    } catch (err) {
      console.warn('[BACKTEST] Failed to parse snapshot line:', err);
    }
  }
  snapshots.sort((a, b) => a.timestamp - b.timestamp);
  if (!snapshots.length) {
    throw new Error(`No recorded snapshots found in ${snapshotFilePath}`);
  }
  return snapshots;
}

async function getSnapshotRange(
  symbol: string,
  snapshotFilePath: string
): Promise<{ start: number; end: number }> {
  const raw = await fs.readFile(snapshotFilePath, 'utf-8');
  let start: number | null = null;
  let end: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MarketSnapshot;
      if (parsed.symbol !== symbol) continue;
      const ts = parsed.timestamp;
      if (start === null || ts < start) start = ts;
      if (end === null || ts > end) end = ts;
    } catch (err) {
      console.warn('[BACKTEST] Failed to parse snapshot line for range:', err);
    }
  }

  if (start === null || end === null) {
    throw new Error(`No snapshots found in ${snapshotFilePath} for symbol ${symbol}`);
  }

  return { start, end };
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
    params.endTime,
    params.snapshotFilePath
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
  const warmupCount = Math.min(30, recordedSnapshots.length);
  for (let i = 0; i < warmupCount; i++) {
    //ingestHistoricalCandle(params.symbol, candles[i]!);
    saveSnapshot(recordedSnapshots[i]!);
  }

  // Replay using watcher
  let cursor = warmupCount;
  tradingState.enable();
  await startMarketWatcher(params.symbol, console.log, {
    tradeExecutor,
    warmupSnapshots: recordedSnapshots.slice(0, warmupCount),
    snapshotProvider: async () => {
      if (cursor >= recordedSnapshots.length) return null;
      const snap = recordedSnapshots[cursor]!;
      const snapTimeLabel = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
      console.log(
        `[SNAP/BACKTEST] ${params.symbol} @ ${snapTimeLabel} (ts=${snap.timestamp}) price=${snap.price}`
      );
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
      throw new Error(
        `[BACKTEST] Missing ${minutes}m CVD in snapshots for ${params.symbol} @ ${referenceTs}`
      );
    },
    intervalMs: 0,
    enableRealtime: false,
    entryMode: 'classic',
  });

  const stats = tradeExecutor.getStats();
  console.log('================ BOT BACKTEST REPORT ================');
  console.log(`Symbol: ${params.symbol}`);
  console.log(`Source file: ${params.snapshotFilePath}`);
  console.log(`Trades: ${stats.trades}`);
  console.log(`Winrate: ${stats.winrate.toFixed(2)}% (W:${stats.wins} / L:${stats.losses})`);
  console.log(`Net PnL: ${stats.pnlTotal.toFixed(2)} USD`);
  console.log(`Final Balance: ${stats.balance.toFixed(2)} USD`);
  console.log(`Max Drawdown: ${stats.maxDrawdown.toFixed(2)} USD`);
}

(async () => {
  const cliArgs = process.argv.slice(2).filter(Boolean);
  const rawSymbol = cliArgs[0] ?? 'SOLUSDT';
  let interval: '1' | '3' | '5' | '15' = '1';
  let startArg: string | undefined;
  let endArg: string | undefined;

  if (cliArgs[1] && ['1', '3', '5', '15'].includes(cliArgs[1]!)) {
    interval = cliArgs[1]! as '1' | '3' | '5' | '15';
    startArg = cliArgs[2];
    endArg = cliArgs[3];
  } else {
    startArg = cliArgs[1];
    endArg = cliArgs[2];
  }

  const symbol = normalizeSymbolInput(rawSymbol);
  const snapshotFilePath = resolveSnapshotFilePath(symbol);

  let startTime: number;
  let endTime: number;

  if (startArg && endArg) {
    startTime = Number(startArg);
    endTime = Number(endArg);
  } else {
    const range = await getSnapshotRange(symbol, snapshotFilePath);
    startTime = range.start;
    endTime = range.end;
  }

  runBotBacktest({ symbol, startTime, endTime, interval, snapshotFilePath })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Bot backtest failed:', err);
      process.exit(1);
    });
})();
