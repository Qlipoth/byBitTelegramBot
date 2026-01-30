import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoricalCandleInput } from '../market/candleBuilder.js';

const fetchFn: typeof fetch =
  globalThis.fetch ??
  (() => {
    throw new Error('Global fetch API недоступен в этой версии Node.js');
  });

export const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'bybit');

export const INTERVAL_TO_MS = {
  '1': 60_000,
  '3': 180_000,
  '5': 300_000,
  '15': 900_000,
  '60': 3_600_000,
} as const;

export interface OpenInterestPoint {
  timestamp: number;
  openInterest: number;
}

export interface FundingRatePoint {
  timestamp: number;
  fundingRate: number;
}

export interface FetchCandlesParams {
  symbol: string;
  start: number;
  end: number;
  interval?: keyof typeof INTERVAL_TO_MS;
  category?: 'linear' | 'inverse' | 'option' | 'spot';
  limit?: number;
}

export function buildCachePath(
  symbol: string,
  start: number,
  end: number,
  interval: keyof typeof INTERVAL_TO_MS
): string {
  const safeSymbol = symbol.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  return path.join(CACHE_DIR, `${safeSymbol}_${start}_${end}_${interval}.json`);
}

export async function readCandlesCache(cachePath: string): Promise<HistoricalCandleInput[] | null> {
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

export async function writeCandlesCache(
  cachePath: string,
  candles: HistoricalCandleInput[]
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(candles));
}

export async function fetchBybitCandles(
  params: FetchCandlesParams
): Promise<HistoricalCandleInput[]> {
  const { symbol, start, end, interval = '1', category = 'linear', limit = 1000 } = params;
  const step = INTERVAL_TO_MS[interval];
  if (!step) throw new Error(`Неизвестный интервал ${interval}`);

  let currentStart = Math.floor(start / step) * step;
  const allCandles: HistoricalCandleInput[] = [];

  console.log(`[LOADER] Начинаю загрузку с ${new Date(start).toISOString()}`);

  while (currentStart < end) {
    const url = new URL('https://api.bybit.com/v5/market/kline');
    url.searchParams.set('category', category);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('start', String(currentStart));
    url.searchParams.set('limit', String(limit));

    const response = await fetchFn(url);
    const payload = (await response.json()) as any;

    if (payload.retCode !== 0 || !payload.result?.list?.length) {
      console.log(`[LOADER] Данные закончились или ошибка: ${payload.retMsg}`);
      break;
    }

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

    const lastTimestamp = batch[batch.length - 1]?.timestamp;

    if (!lastTimestamp) {
      throw new Error('Не получено время последней свечи');
    }
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

  const finalCandles = allCandles.filter(c => c.timestamp >= start && c.timestamp <= end);

  const uniqueCandles = Array.from(new Map(finalCandles.map(c => [c.timestamp, c])).values());

  return uniqueCandles.sort((a, b) => a.timestamp - b.timestamp);
}

function parseTimestampedValue(
  row: any,
  valueKey: string,
  fallbackIndex: number
): { timestamp: number; value: number } | null {
  const timestamp = Number(row.timestamp ?? row[0]);
  const value = Number(row[valueKey] ?? row[fallbackIndex]);
  if (!Number.isFinite(timestamp) || !Number.isFinite(value)) {
    return null;
  }
  return { timestamp, value };
}

async function fetchPaginatedSeries<T extends { timestamp: number }>(
  buildUrl: (cursor: number) => URL,
  mapRow: (row: any) => T | null,
  start: number,
  end: number,
  stepMs: number
): Promise<T[]> {
  let cursor = start;
  const result: T[] = [];

  while (cursor < end) {
    const url = buildUrl(cursor);
    const response = await fetchFn(url);
    const payload = await response.json();

    const list: unknown[] = payload.result?.list ?? [];
    if (payload.retCode !== 0 || !list.length) {
      break;
    }

    const batch = list
      .map(mapRow)
      .filter((p): p is T => Boolean(p))
      .sort((a: T, b: T) => a.timestamp - b.timestamp);

    if (!batch.length) break;

    result.push(...batch);

    const lastTimestamp = batch[batch.length - 1]!.timestamp;
    if (!Number.isFinite(lastTimestamp) || lastTimestamp <= cursor) {
      break;
    }

    cursor = lastTimestamp + stepMs;

    if (batch.length < 200 || cursor >= end) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  return result.filter(point => point.timestamp >= start && point.timestamp <= end);
}

export async function fetchOpenInterestSeries(params: {
  symbol: string;
  start: number;
  end: number;
  intervalMinutes?: 5 | 15 | 60;
  category?: 'linear' | 'inverse' | 'option' | 'spot';
}): Promise<OpenInterestPoint[]> {
  const { symbol, start, end, intervalMinutes = 5, category = 'linear' } = params;
  const stepMs = intervalMinutes * 60_000;
  const intervalParam = `${intervalMinutes}min`;

  return fetchPaginatedSeries<OpenInterestPoint>(
    cursor => {
      const url = new URL('https://api.bybit.com/v5/market/open-interest');
      url.searchParams.set('category', category);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('intervalTime', intervalParam);
      url.searchParams.set('startTime', String(cursor));
      url.searchParams.set('limit', '200');
      return url;
    },
    row => {
      const parsed = parseTimestampedValue(row, 'openInterest', 1);
      return parsed ? { timestamp: parsed.timestamp, openInterest: parsed.value } : null;
    },
    start,
    end,
    stepMs
  );
}

export async function fetchFundingRateSeries(params: {
  symbol: string;
  start: number;
  end: number;
  category?: 'linear' | 'inverse' | 'option' | 'spot';
}): Promise<FundingRatePoint[]> {
  const { symbol, start, end, category = 'linear' } = params;
  const stepMs = 60 * 60 * 1000; // funding не меняется чаще раза в час

  return fetchPaginatedSeries<FundingRatePoint>(
    cursor => {
      const url = new URL('https://api.bybit.com/v5/market/funding/history');
      url.searchParams.set('category', category);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('startTime', String(cursor));
      url.searchParams.set('limit', '200');
      return url;
    },
    row => {
      const parsed = parseTimestampedValue(row, 'fundingRate', 1);
      return parsed ? { timestamp: parsed.timestamp, fundingRate: parsed.value } : null;
    },
    start,
    end,
    stepMs
  );
}
