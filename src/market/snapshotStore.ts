import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MarketSnapshot } from './types.js';
import { INTERVALS } from './constants.market.js'; // .js extension required for NodeNext module resolution

const store: Record<string, MarketSnapshot[]> = {};
const MAX_SNAPSHOTS = 60; // например: 12 × 5 мин = 1 час

const SNAPSHOT_FILES = {
  live: path.resolve(process.cwd(), 'realSnaps.json'),
  backtest: path.resolve(process.cwd(), 'backtest.json'),
} as const;

type SnapshotMode = keyof typeof SNAPSHOT_FILES;

let snapshotMode: SnapshotMode = 'live';
const writeQueues: Record<SnapshotMode, Promise<void>> = {
  live: Promise.resolve(),
  backtest: Promise.resolve(),
};

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
  const mode = snapshotMode;
  const targetFile = SNAPSHOT_FILES[mode];
  const payload = `${JSON.stringify(snapshot)}\n`;

  writeQueues[mode] = writeQueues[mode]
    .catch(() => {})
    .then(() => fs.appendFile(targetFile, payload, 'utf-8'))
    .catch(err => {
      console.error(`[SNAPSHOT] Failed to append ${mode} snapshot:`, err);
    });
}
