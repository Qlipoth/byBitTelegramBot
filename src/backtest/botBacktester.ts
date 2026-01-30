import { promises as fs, createWriteStream } from 'node:fs';
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
import type { PhaseLogEvent } from '../market/watcher.js';
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
import { parseMonthSelections } from './monthSelection.js';
import type { WatcherLogWriter } from '../market/logging.js';

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
const SNAPS_STORAGE_DIR = process.platform === 'win32' 
  ? 'C:\\tmp\\snaps_storage' 
  : '/tmp/snaps_storage';

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

/**
 * Находит все файлы снапшотов в storage для данного символа и диапазона дат
 */
async function findStorageFiles(symbol: string, startTime: number, endTime: number): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(SNAPS_STORAGE_DIR);
    const prefix = `${symbol}_`;
    
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue;
      
      // Парсим год и месяц из имени файла: ETHUSDT_2024_01.jsonl
      const match = entry.match(/_(\d{4})_(\d{2})\.jsonl$/);
      if (!match) continue;
      
      const year = parseInt(match[1]!, 10);
      const month = parseInt(match[2]!, 10);
      
      // Границы месяца
      const monthStart = new Date(year, month - 1, 1).getTime();
      const monthEnd = new Date(year, month, 0, 23, 59, 59, 999).getTime();
      
      // Проверяем пересечение с запрошенным диапазоном
      if (monthEnd >= startTime && monthStart <= endTime) {
        files.push(path.join(SNAPS_STORAGE_DIR, entry));
      }
    }
    
    // Сортируем по дате
    files.sort();
  } catch (err) {
    // storage directory doesn't exist
  }
  return files;
}

/**
 * Загружает снапшоты из нескольких файлов в storage
 */
async function loadSnapshotsFromStorage(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<MarketSnapshot[]> {
  const storageFiles = await findStorageFiles(symbol, startTime, endTime);
  
  if (!storageFiles.length) {
    return [];
  }
  
  console.log(`📂 Found ${storageFiles.length} storage files for ${symbol}`);
  
  const snapshots: MarketSnapshot[] = [];
  
  for (const filePath of storageFiles) {
    const fileName = path.basename(filePath);
    const raw = await fs.readFile(filePath, 'utf-8');
    let count = 0;
    
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MarketSnapshot;
        if (parsed.symbol !== symbol) continue;
        if (parsed.timestamp < startTime || parsed.timestamp > endTime) continue;
        snapshots.push(ensureSnapshotThresholds(symbol, parsed));
        count++;
      } catch (err) {
        // skip invalid lines
      }
    }
    console.log(`   📄 ${fileName}: ${count} snapshots`);
  }
  
  snapshots.sort((a, b) => a.timestamp - b.timestamp);
  return snapshots;
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
  // Сначала пробуем загрузить из storage
  const storageSnapshots = await loadSnapshotsFromStorage(symbol, startTime, endTime);
  if (storageSnapshots.length > 0) {
    console.log(`✅ Loaded ${storageSnapshots.length} snapshots from storage`);
    return storageSnapshots;
  }
  
  // Fallback на старый файл
  console.log(`📂 Storage empty, falling back to ${snapshotFilePath}`);
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
  // Сначала проверяем storage
  const storageFiles = await findStorageFiles(symbol, 0, Date.now());
  if (storageFiles.length > 0) {
    let start: number | null = null;
    let end: number | null = null;
    
    for (const filePath of storageFiles) {
      const raw = await fs.readFile(filePath, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as MarketSnapshot;
          if (parsed.symbol !== symbol) continue;
          const ts = parsed.timestamp;
          if (start === null || ts < start) start = ts;
          if (end === null || ts > end) end = ts;
        } catch {
          // skip
        }
      }
    }
    
    if (start !== null && end !== null) {
      console.log(`📂 Storage range: ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`);
      return { start, end };
    }
  }
  
  // Fallback на старый файл
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
  // IMPORTANT: Need at least 200 snapshots for EMA(200) global trend detection
  candleState[params.symbol] = undefined as any;
  const warmupCount = Math.min(250, recordedSnapshots.length);
  for (let i = 0; i < warmupCount; i++) {
    //ingestHistoricalCandle(params.symbol, candles[i]!);
    saveSnapshot(recordedSnapshots[i]!);
  }

  // Replay using watcher
  let cursor = warmupCount;
  tradingState.enable();

  const tempDir =
    process.platform === 'win32'
      ? 'C:\\tmp'
      : process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';
  const watcherLogPath = path.join(
    tempDir,
    `watcher-log-${params.symbol}-${params.startTime}-${params.endTime}.log`
  );
  console.log(`[WATCHER_LOG] Writing watcher telemetry to ${watcherLogPath}`);
  await fs.mkdir(path.dirname(watcherLogPath), { recursive: true });
  try {
    await fs.rm(watcherLogPath, { force: true });
  } catch {
    // ignore
  }
  const watcherLogStream = createWriteStream(watcherLogPath, { flags: 'w' });

  const writeWatcherLog: WatcherLogWriter = (line: string) => {
    try {
      watcherLogStream.write(`${line}\n`);
    } catch (err) {
      console.error('[WATCHER_LOG] Failed to write entry:', err);
    }
  };

  const phaseLogPath = path.join(tempDir, `phases-${params.symbol}.jsonl`);
  console.log(`[PHASE_LOG] Writing detectMarketPhase telemetry to ${phaseLogPath}`);
  await fs.mkdir(path.dirname(phaseLogPath), { recursive: true });
  const phaseLogStream = createWriteStream(phaseLogPath, { flags: 'w' });
  const phaseLogger = (event: PhaseLogEvent) => {
    const payload = {
      ...event,
      isoTime: dayjs(event.timestamp).toISOString(),
    };
    try {
      phaseLogStream.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      console.error('[PHASE_LOG] Failed to write entry:', err);
    }
  };

  const closePhaseLog = () => new Promise<void>(resolve => phaseLogStream.end(resolve));
  const closeWatcherLog = () => new Promise<void>(resolve => watcherLogStream.end(resolve));

  try {
    try {
      await startMarketWatcher(params.symbol, () => {}, {
        tradeExecutor,
        warmupSnapshots: recordedSnapshots.slice(0, warmupCount),
        snapshotProvider: async () => {
          if (cursor >= recordedSnapshots.length) return null;
          const snap = recordedSnapshots[cursor]!;
          const snapTimeLabel = dayjs(snap.timestamp).format('YYYY-MM-DD HH:mm:ss');
          writeWatcherLog(
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
        phaseLogger,
        logWriter: writeWatcherLog,
      });
    } finally {
      await closePhaseLog();
    }

    const stats = tradeExecutor.getStats();
    const statsPayload = {
      generatedAt: dayjs().toISOString(),
      symbol: params.symbol,
      startTime: params.startTime,
      endTime: params.endTime,
      snapshotFilePath: params.snapshotFilePath,
      ...stats,
    };
    const statsPath = path.join(
      tempDir,
      `bot-backtest-stats-${params.symbol}-${params.startTime}-${params.endTime}.json`
    );
    try {
      await fs.mkdir(path.dirname(statsPath), { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify(statsPayload, null, 2));
      console.log(`[BACKTEST] Stats written to ${statsPath}`);
    } catch (err) {
      console.error('[BACKTEST] Failed to write stats file:', err);
    }

    const report = (line: string) => {
      console.log(line);
      writeWatcherLog(line);
    };

    report('================ BOT BACKTEST REPORT ================');
    report(`Symbol: ${params.symbol}`);
    report(`Source file: ${params.snapshotFilePath}`);
    report(`Trades: ${stats.trades}`);
    report(`Winrate: ${stats.winrate.toFixed(2)}% (W:${stats.wins} / L:${stats.losses})`);
    report(`Net PnL: ${stats.pnlTotal.toFixed(2)} USD`);
    report(`Final Balance: ${stats.balance.toFixed(2)} USD`);
    report(`Max Drawdown: ${stats.maxDrawdown.toFixed(2)} USD`);
    if (stats.closedTrades.length) {
      report('---------------- TRADE DETAILS ----------------');
      stats.closedTrades.forEach((trade, idx) => {
        const opened = dayjs(trade.entryTime).format('YYYY-MM-DD HH:mm:ss');
        const closed = dayjs(trade.exitTime).format('YYYY-MM-DD HH:mm:ss');
        const pnlUsd = trade.pnlUsd.toFixed(2);
        const pnlPct = trade.pnlPct.toFixed(2);
        const pnlGrossUsd = trade.pnlGrossUsd.toFixed(2);
        const pnlGrossPct = trade.pnlGrossPct.toFixed(2);
        const feesUsd = trade.feesUsd.toFixed(2);
        const entryPrice = trade.entryPrice.toFixed(4);
        const exitPrice = trade.exitPrice.toFixed(4);
        const qty = trade.qty.toFixed(4);
        const longScore = trade.entryMeta?.longScore ?? null;
        const shortScore = trade.entryMeta?.shortScore ?? null;
        const scoreStr =
          longScore !== null && shortScore !== null ? `L:${longScore} | S:${shortScore}` : 'n/a';
        const entrySignalMeta = trade.entryMeta?.entrySignal ?? 'n/a';
        const signalMeta = trade.entryMeta?.signal ?? 'n/a';
        report(
          `${idx + 1}. ${trade.symbol} ${trade.side} | Open:${opened} Close:${closed} | ` +
            `Entry:${entryPrice} Exit:${exitPrice} Qty:${qty} | ` +
            `Gross: ${pnlGrossUsd} USD (${pnlGrossPct}%) | Fees: ${feesUsd} USD | ` +
            `Net: ${pnlUsd} USD (${pnlPct}%) | Reason: ${trade.reason} | Score: ${scoreStr} | ` +
            `EntrySignal: ${entrySignalMeta} | Signal: ${signalMeta}`
        );
      });
    } else {
      report('No trades were executed during this backtest window.');
    }
  } finally {
    await closeWatcherLog();
  }
}

async function main() {
  const cliArgs = process.argv.slice(2).filter(Boolean);
  const rawSymbol = cliArgs[0] ?? 'SOLUSDT';
  let interval: '1' | '3' | '5' | '15' = '1';
  let rangeArgsStartIndex = 1;

  if (cliArgs[1] && ['1', '3', '5', '15'].includes(cliArgs[1]!)) {
    interval = cliArgs[1]! as '1' | '3' | '5' | '15';
    rangeArgsStartIndex = 2;
  }

  const rangeArgs = cliArgs.slice(rangeArgsStartIndex);
  const symbol = normalizeSymbolInput(rawSymbol);
  const snapshotFilePath = resolveSnapshotFilePath(symbol);

  const monthSelections = parseMonthSelections(rangeArgs);

  if (monthSelections && monthSelections.length) {
    console.log(
      `🗓️  Months requested: ${monthSelections.map(sel => `${sel.token} (${sel.label})`).join(', ')}`
    );
    for (const selection of monthSelections) {
      console.log(
        `\n================ ${symbol} | ${selection.label} ================\n` +
          `Range: ${dayjs(selection.startTime).toISOString()} → ${dayjs(selection.endTime).toISOString()}`
      );
      await runBotBacktest({
        symbol,
        startTime: selection.startTime,
        endTime: selection.endTime,
        interval,
        snapshotFilePath,
      });
    }
    return;
  }

  let startTime: number;
  let endTime: number;

  if (rangeArgs.length >= 2) {
    startTime = Number(rangeArgs[0]);
    endTime = Number(rangeArgs[1]);
  } else {
    const range = await getSnapshotRange(symbol, snapshotFilePath);
    startTime = range.start;
    endTime = range.end;
  }

  await runBotBacktest({ symbol, startTime, endTime, interval, snapshotFilePath });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Bot backtest failed:', err);
    process.exit(1);
  });
