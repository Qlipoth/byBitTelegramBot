import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MarketSnapshot } from './types.js';
import { INTERVALS, LOG_PATH } from './constants.market.js'; // .js extension required for NodeNext module resolution

const store: Record<string, MarketSnapshot[]> = {};
const MAX_SNAPSHOTS = 300; // 300 минут = 5 часов для EMA(200) global trend detection

const SNAPSHOT_DIR = path.dirname(LOG_PATH);
const BACKTEST_SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'SNAPS_BACKTEST.jsonl');

export const DEFAULT_SNAPSHOT_FILE = BACKTEST_SNAPSHOT_FILE;

type SnapshotMode = 'live' | 'backtest';

let snapshotMode: SnapshotMode = 'live';
let backtestWriteQueue: Promise<void> = Promise.resolve();

const SYMBOL_HISTORY_TARGETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
type HistorySymbol = (typeof SYMBOL_HISTORY_TARGETS)[number];

export const SYMBOL_HISTORY_FILES: Record<HistorySymbol, string> = Object.freeze(
  SYMBOL_HISTORY_TARGETS.reduce(
    (acc, symbol) => {
      acc[symbol] = path.join(SNAPSHOT_DIR, `SNAPS_${symbol}.jsonl`);
      return acc;
    },
    {} as Record<HistorySymbol, string>
  )
);

const historyWriteQueues: Record<HistorySymbol, Promise<void>> = SYMBOL_HISTORY_TARGETS.reduce(
  (acc, symbol) => {
    acc[symbol] = Promise.resolve();
    return acc;
  },
  {} as Record<HistorySymbol, Promise<void>>
);

const ensureSnapshotDirReady = fs
  .mkdir(SNAPSHOT_DIR, { recursive: true })
  .catch(err => console.error('[SNAPSHOT] Failed to ensure snapshot dir:', err));

export function setSnapshotPersistenceMode(mode: SnapshotMode) {
  snapshotMode = mode;
}

export function saveSnapshot(snapshot: MarketSnapshot) {
  if (!store[snapshot.symbol]) {
    store[snapshot.symbol] = [];
  }

  store[snapshot.symbol]!.push(snapshot);

  if (store[snapshot.symbol]!.length > MAX_SNAPSHOTS) {
    store[snapshot.symbol]!.shift();
  }

  persistSnapshot(snapshot);
  persistHistorySnapshot(snapshot);
}

export function getSnapshots(symbol: string): MarketSnapshot[] {
  return store[symbol] || [];
}

function logMemoryUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(
    `Memory: ${Math.round(used * 100) / 100} MB | Snapshots: ${Object.keys(store).length} symbols`
  );
}

setInterval(logMemoryUsage, INTERVALS.FIVE_MIN); // Логировать каждые 5 минут

function persistSnapshot(snapshot: MarketSnapshot) {
  if (snapshotMode !== 'backtest') {
    return;
  }

  const payload = `${JSON.stringify(snapshot)}\n`;

  backtestWriteQueue = backtestWriteQueue
    .catch(() => {})
    .then(() => ensureSnapshotDirReady)
    .then(() => fs.appendFile(BACKTEST_SNAPSHOT_FILE, payload, 'utf-8'))
    .catch(err => {
      console.error('[SNAPSHOT] Failed to append backtest snapshot:', err);
    });
}

function persistHistorySnapshot(snapshot: MarketSnapshot) {
  if (!isHistorySymbol(snapshot.symbol)) {
    return;
  }

  const symbol = snapshot.symbol as HistorySymbol;
  const targetFile = SYMBOL_HISTORY_FILES[symbol];
  const payload = `${JSON.stringify(snapshot)}\n`;

  historyWriteQueues[symbol] = historyWriteQueues[symbol]
    .catch(() => {})
    .then(() => ensureSnapshotDirReady)
    .then(() => fs.appendFile(targetFile, payload, 'utf-8'))
    .catch(err => {
      console.error(`[SNAPSHOT] Failed to append history for ${symbol}:`, err);
    });
}

function isHistorySymbol(symbol: string): symbol is HistorySymbol {
  return (SYMBOL_HISTORY_TARGETS as readonly string[]).includes(symbol as HistorySymbol);
}
