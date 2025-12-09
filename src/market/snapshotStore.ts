import type { MarketSnapshot } from './types.js';
import { INTERVALS } from './constants.market.js'; // .js extension required for NodeNext module resolution

const store: Record<string, MarketSnapshot[]> = {};
const MAX_SNAPSHOTS = 60; // например: 12 × 5 мин = 1 час

export function saveSnapshot(snapshot: MarketSnapshot) {
  if (!store[snapshot.symbol]) {
    store[snapshot.symbol] = [];
  }

  store[snapshot.symbol]!.push(snapshot);

  if (store[snapshot.symbol]!.length > MAX_SNAPSHOTS) {
    store[snapshot.symbol]!.shift();
  }
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
