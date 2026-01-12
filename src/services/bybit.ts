import { RestClientV5, WebsocketClient } from 'bybit-api';
import type { MarketSnapshot } from '../market/types.js';
import { PRIORITY_COINS, SYMBOL_BLACKLIST } from '../market/constants.market.js';
import { initCVDTracker } from '../market/cvdTracker.js';
import { buildSyntheticCvdSeries, getCvdDifference } from '../backtest/cvdBuilder.js';

import * as dotenv from 'dotenv';
import dayjs from 'dayjs';

dotenv.config();

const key = process.env.BYBIT_API_KEY;
const secret = process.env.BYBIT_SECRET_KEY;

if (!key || !secret) {
  console.error('❌ Ошибка: API ключи не найдены в process.env!');
  console.log('Текущие ключи:', { key, secret }); // Поможет понять, что они undefined
  process.exit(1);
}

// Initialize Bybit client
export const bybitClient = new RestClientV5({
  key,
  secret,
  demoTrading: true,
  testnet: false, // Set to true for testnet
  enable_time_sync: true,
  sync_interval_ms: 60_000, // раз в минуту
  recv_window: 20000,
});

export const ws = new WebsocketClient({
  key, // можно без ключей для public данных
  secret,
  market: 'v5',
  testnet: false,
});

initCVDTracker(ws);

const ONE_MINUTE_MS = 60_000;
const DEFAULT_HISTORY_MINUTES = 60 * 24 * 130; // ~90 дней
const MIN_HISTORY_MINUTES = 30;
const MAX_HISTORY_MINUTES = 60 * 24 * 60; // 60 дней
const MAX_KLINE_BATCH = 200; // Bybit v5 limit
const MAX_OI_BATCH = 200;
const MAX_FUNDING_BATCH = 200;

type CandlePoint = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

type OiPoint = {
  timestamp: number;
  openInterest: number;
};

type FundingPoint = {
  timestamp: number;
  fundingRate: number;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchKlinesRange(symbol: string, startTime: number, endTime: number) {
  const candles: CandlePoint[] = [];
  const step = ONE_MINUTE_MS;
  let cursor = Math.floor(startTime / step) * step;

  while (cursor <= endTime) {
    const resp = await bybitClient.getKline({
      category: 'linear',
      symbol,
      interval: '1',
      start: cursor,
      limit: MAX_KLINE_BATCH,
    } as any);

    const list = resp?.result?.list ?? [];
    if (!list.length) {
      break;
    }

    const batch = list
      .map((row: string[]) => ({
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        turnover: Number(row[6] ?? 0),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    candles.push(...batch);
    console.log(
      `[PRELOAD] ${symbol}: fetched ${batch.length} candles (total ${candles.length}) up to ${new Date(
        batch.at(-1)?.timestamp ?? cursor
      ).toISOString()}`
    );

    const lastTimestamp = batch.at(-1)?.timestamp;
    if (!lastTimestamp || lastTimestamp <= cursor) {
      break;
    }

    cursor = lastTimestamp + step;
    if (cursor > endTime) {
      break;
    }

    if (batch.length < MAX_KLINE_BATCH) {
      break;
    }

    await sleep(150);
  }

  const deduped = Array.from(new Map(candles.map(c => [c.timestamp, c])).values());
  return deduped
    .filter(c => c.timestamp >= startTime && c.timestamp <= endTime)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchOpenInterestRange(symbol: string, startTime: number, endTime: number) {
  const points: OiPoint[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await bybitClient.getOpenInterest({
      category: 'linear',
      symbol,
      intervalTime: '5min',
      limit: MAX_OI_BATCH,
      startTime,
      endTime,
      ...(cursor ? { cursor } : {}),
    } as any);

    const list = resp?.result?.list ?? [];
    if (!list.length) break;

    const batch = list
      .map((item: any) => ({
        timestamp: Number(item.timestamp),
        openInterest: Number(item.openInterest),
      }))
      .filter(p => p.timestamp >= startTime && p.timestamp <= endTime);

    points.push(...batch);

    const next = resp?.result?.nextPageCursor;
    if (!next || next === cursor) break;
    cursor = next;
    if (batch.length < MAX_OI_BATCH) break;
    await sleep(150);
  }

  if (!points.length) {
    const fallback = await bybitClient.getOpenInterest({
      category: 'linear',
      symbol,
      intervalTime: '5min',
      limit: 6,
    });
    const list = fallback?.result?.list ?? [];
    points.push(
      ...list.map((item: any) => ({
        timestamp: Number(item.timestamp),
        openInterest: Number(item.openInterest),
      }))
    );
  }

  const deduped = Array.from(new Map(points.map(p => [p.timestamp, p])).values());
  return deduped.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchFundingHistoryRange(symbol: string, startTime: number, endTime: number) {
  const points: FundingPoint[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await bybitClient.getFundingRateHistory({
      category: 'linear',
      symbol,
      limit: MAX_FUNDING_BATCH,
      startTime,
      endTime,
      ...(cursor ? { cursor } : {}),
    } as any);

    const list = resp?.result?.list ?? [];
    if (!list.length) break;

    const batch = list
      .map((item: any) => ({
        timestamp: Number(item.fundingTime ?? item.timestamp),
        fundingRate: Number(item.fundingRate),
      }))
      .filter(p => p.timestamp >= startTime && p.timestamp <= endTime);

    points.push(...batch);

    const next = (resp as any)?.result?.nextPageCursor ?? (resp as any)?.result?.cursor;

    if (!next || next === cursor) break;
    cursor = next;
    if (batch.length < MAX_FUNDING_BATCH) break;
    await sleep(150);
  }

  if (!points.length) {
    const fallback = await bybitClient.getFundingRateHistory({
      category: 'linear',
      symbol,
      limit: 1,
    });
    const list = fallback?.result?.list ?? [];
    points.push(
      ...list.map((item: any) => ({
        timestamp: Number(item.fundingTime ?? item.timestamp ?? Date.now()),
        fundingRate: Number(item.fundingRate),
      }))
    );
  }

  const deduped = Array.from(new Map(points.map(p => [p.timestamp, p])).values());
  return deduped.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  try {
    const [ticker, oi, funding] = await Promise.all([
      bybitClient.getTickers({ category: 'linear', symbol }),
      bybitClient.getOpenInterest({ category: 'linear', symbol, intervalTime: '5min' }),
      bybitClient.getFundingRateHistory({
        category: 'linear',
        symbol,
        limit: 1,
      }),
    ]);

    // Validate responses
    if (!ticker?.result?.list?.[0] || !oi?.result?.list?.[0] || !funding?.result?.list?.[0]) {
      throw new Error(`Failed to get complete market data for ${symbol}`);
    }

    const tickerData = ticker.result.list[0];
    const oiData = oi.result.list[0];
    const fundingData = funding.result.list[0];

    return {
      symbol,
      price: parseFloat(tickerData.lastPrice),
      volume24h: parseFloat(tickerData.turnover24h),
      openInterest: parseFloat(oiData.openInterest),
      fundingRate: parseFloat(fundingData.fundingRate),
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`Error in getMarketSnapshot for ${symbol}:`, error);
    throw error; // Re-throw to let the caller handle the error
  }
}

export function formatMarketSnapshot(snapshot: MarketSnapshot): string {
  const { symbol, price, volume24h, openInterest, fundingRate, timestamp } = snapshot;

  const formatNumber = (num: number, decimals: number = 2) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    }).format(num);
  };

  const formattedPrice = formatNumber(price, price > 1000 ? 0 : 2);
  const formattedVolume = formatNumber(volume24h);
  const formattedOI = formatNumber(openInterest);
  const formattedFunding = (fundingRate * 100).toFixed(4);
  const formattedDate = new Date(timestamp).toLocaleString();

  return [
    `📊 *${symbol} Market Snapshot*`,
    '------------------------',
    `💰 Price: $${formattedPrice}`,
    `📈 24h Volume: $${formattedVolume}`,
    `🏦 Open Interest: $${formattedOI}`,
    `📉 Funding Rate: ${formattedFunding}%`,
    '------------------------',
    `ℹ️ Last updated: ${formattedDate}`,
  ].join('\n');
}

// Add this new function to get top liquid symbols

export async function getTopLiquidSymbols(limit: number = 30): Promise<string[]> {
  try {
    const response = await bybitClient.getTickers({
      category: 'linear', // for USDT-M futures
    });

    if (response.retCode !== 0) {
      throw new Error(`Failed to fetch tickers: ${response.retMsg}`);
    }

    // Define the priority symbols we always want to include

    // Filter and sort all USDT pairs by turnover (quote volume) to avoid bias toward low-priced coins
    const allUsdtPairs = response.result.list
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .filter(
        ticker => !SYMBOL_BLACKLIST.includes(ticker.symbol as (typeof SYMBOL_BLACKLIST)[number])
      )
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h));

    // Get priority symbols that exist in the response
    const priorityPairs = PRIORITY_COINS.map(symbol =>
      allUsdtPairs.find(p => p.symbol === symbol)
    ).filter(Boolean);

    // Get top N symbols excluding already included priority pairs
    const topByVolume = allUsdtPairs
      .filter(pair => !PRIORITY_COINS.includes(pair.symbol as (typeof PRIORITY_COINS)[number]))
      .slice(0, limit - priorityPairs.length);

    // Combine and extract symbols
    const result = [...priorityPairs, ...topByVolume]
      .slice(0, limit)
      .map(ticker => ticker!.symbol)
      .filter(s => !SYMBOL_BLACKLIST.includes(s as (typeof SYMBOL_BLACKLIST)[number]));

    console.log('🔍 Tracking symbols:', result.join(', '));
    return result;
  } catch (error) {
    console.error('Error fetching top liquid symbols:', error);
    // Fallback to default symbols if API fails
    return PRIORITY_COINS.slice(0, limit).filter(
      s => !SYMBOL_BLACKLIST.includes(s as (typeof SYMBOL_BLACKLIST)[number])
    );
  }
}

type PreloadRangeOptions = {
  minutes?: number;
  startTime?: number;
  endTime?: number;
};

export async function preloadMarketSnapshots(
  symbol: string,
  options?: PreloadRangeOptions
): Promise<MarketSnapshot[]> {
  let startTime: number;
  let endTime: number;

  if (options?.startTime && options?.endTime) {
    if (options.startTime >= options.endTime) {
      throw new Error('[PRELOAD] startTime must be less than endTime');
    }
    startTime = Math.floor(options.startTime);
    endTime = Math.floor(options.endTime);
  } else {
    endTime = Date.now();
    const requestedMinutes = options?.minutes ?? DEFAULT_HISTORY_MINUTES;
    const historyMinutes = Math.min(
      Math.max(Math.floor(requestedMinutes), MIN_HISTORY_MINUTES),
      MAX_HISTORY_MINUTES
    );
    startTime = endTime - historyMinutes * ONE_MINUTE_MS;
  }

  const [ticker] = await Promise.all([
    bybitClient.getTickers({
      category: 'linear',
      symbol,
    }),
  ]);

  if (!ticker?.result?.list?.length) {
    throw new Error(`[PRELOAD] Failed to load ticker for ${symbol}`);
  }

  const [candles, oiPoints, fundingPoints] = await Promise.all([
    fetchKlinesRange(symbol, startTime, endTime),
    fetchOpenInterestRange(symbol, startTime, endTime),
    fetchFundingHistoryRange(symbol, startTime, endTime),
  ]);

  if (!candles.length) {
    throw new Error(`[PRELOAD] No klines available for ${symbol}`);
  }

  const volume24h = Number(ticker.result.list[0]!.turnover24h);

  type CvdPoint = { timestamp: number; value: number };

  const cvdSeries = buildSyntheticCvdSeries(symbol, [
    ...candles.map(candle => ({
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    })),
  ]);

  function getCvdDelta(timestamp: number, minutes: number): number {
    if (!minutes || !cvdSeries.length) return 0;
    const startTs = timestamp - minutes * ONE_MINUTE_MS;
    if (startTs < cvdSeries[0]!.timestamp) return 0;
    return getCvdDifference(cvdSeries, startTs, timestamp);
  }

  function getOiForTimestamp(ts: number): number {
    if (!oiPoints.length) return 0;
    let currentOi = oiPoints[0]!.openInterest;
    for (const oi of oiPoints) {
      if (oi.timestamp <= ts) {
        currentOi = oi.openInterest;
      } else {
        break;
      }
    }
    return currentOi;
  }

  function getFundingRateAt(ts: number): number {
    if (!fundingPoints.length) return fundingPoints.at(-1)?.fundingRate ?? 0;
    let rate = fundingPoints[0]!.fundingRate;
    for (const point of fundingPoints) {
      if (point.timestamp <= ts) {
        rate = point.fundingRate;
      } else {
        break;
      }
    }
    return rate;
  }

  const snapshots: MarketSnapshot[] = candles.map(candle => ({
    symbol,
    price: candle.close,
    volume24h,
    openInterest: getOiForTimestamp(candle.timestamp),
    fundingRate: getFundingRateAt(candle.timestamp),
    timestamp: candle.timestamp,
    cvd1m: getCvdDelta(candle.timestamp, 1),
    cvd3m: getCvdDelta(candle.timestamp, 3),
    cvd15m: getCvdDelta(candle.timestamp, 15),
    cvd30m: getCvdDelta(candle.timestamp, 30),
  }));

  console.log(`[PRELOAD] ${symbol}: loaded ${snapshots.length} snapshots`);

  return snapshots;
}

// Функция для получения актуального доступного баланса
export async function getCurrentBalance(): Promise<number> {
  try {
    const response = await bybitClient.getWalletBalance({
      accountType: 'UNIFIED',
      coin: 'USDT',
    });

    // 1. Берем первый аккаунт из списка
    const account = response.result.list[0];
    if (!account) return 0;

    // 2. Оптимальный вариант для Unified аккаунта — общий доступный баланс
    // Если нужно строго USDT, можно взять из массива coin, как показано ниже
    const totalAvailable = parseFloat(account.totalAvailableBalance || '0');

    // Если вы хотите именно USDT баланс кошелька:
    // const usdtCoin = account.coin.find(c => c.coin === 'USDT');
    // const usdtBalance = parseFloat(usdtCoin?.walletBalance || '0');

    return totalAvailable;
  } catch (error) {
    console.error('Ошибка при получении баланса:', error);
    return 0;
  }
}

export interface ClosedPnlStatsBySymbol {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  pnlTotalUsd: number;
}

export interface ClosedPnlStats {
  startTime: number;
  endTime: number;
  trades: number;
  wins: number;
  losses: number;
  pnlTotalUsd: number;
  pnlWinUsd: number;
  pnlLossUsd: number;
  bySymbol: ClosedPnlStatsBySymbol[];
}

async function fetchClosedPnLRecords(params: {
  category: 'linear' | 'inverse';
  startTime: number;
  endTime: number;
}): Promise<Record<string, any>[]> {
  const { category, startTime, endTime } = params;
  const all: Record<string, any>[] = [];

  let cursor: string | undefined;
  for (;;) {
    const resp = await bybitClient.getClosedPnL({
      category,
      startTime,
      endTime,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    } as any);

    if (resp.retCode !== 0) {
      throw new Error(`getClosedPnL failed: retCode=${resp.retCode} retMsg=${resp.retMsg}`);
    }

    const list = (resp as any)?.result?.list;
    if (Array.isArray(list) && list.length) {
      all.push(...list);
    }

    const next = (resp as any)?.result?.nextPageCursor;
    if (!next) break;
    if (next === cursor) break;
    cursor = next;
  }

  return all;
}

export async function getClosedPnLStats(params: {
  startTime: number;
  endTime: number;
  category?: 'linear' | 'inverse';
}): Promise<ClosedPnlStats> {
  const category = params.category ?? 'linear';
  const startTime = params.startTime;
  const endTime = params.endTime;

  const start = dayjs(startTime);
  const end = dayjs(endTime);
  const chunks: Array<{ start: number; end: number }> = [];

  for (let from = start; from.valueOf() < end.valueOf(); from = from.add(7, 'day')) {
    const chunkStart = from;
    const rawChunkEnd = from.add(7, 'day').subtract(1, 'millisecond');
    const chunkEnd = rawChunkEnd.isAfter(end) ? end : rawChunkEnd;
    chunks.push({ start: chunkStart.valueOf(), end: chunkEnd.valueOf() });
  }

  const records: Record<string, any>[] = [];
  for (const chunk of chunks) {
    const part = await fetchClosedPnLRecords({
      category,
      startTime: chunk.start,
      endTime: chunk.end,
    });
    records.push(...part);
  }

  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnlTotalUsd = 0;
  let pnlWinUsd = 0;
  let pnlLossUsd = 0;

  const bySymbol = new Map<string, ClosedPnlStatsBySymbol>();

  for (const r of records) {
    const symbol = String(r?.symbol ?? '').trim();
    if (!symbol) continue;

    const pnl = Number(r?.closedPnl ?? 0);
    if (!Number.isFinite(pnl)) continue;

    trades += 1;
    pnlTotalUsd += pnl;
    if (pnl > 0) {
      wins += 1;
      pnlWinUsd += pnl;
    } else if (pnl < 0) {
      losses += 1;
      pnlLossUsd += pnl;
    }

    const existing = bySymbol.get(symbol) ?? {
      symbol,
      trades: 0,
      wins: 0,
      losses: 0,
      pnlTotalUsd: 0,
    };

    existing.trades += 1;
    existing.pnlTotalUsd += pnl;
    if (pnl > 0) existing.wins += 1;
    if (pnl < 0) existing.losses += 1;

    bySymbol.set(symbol, existing);
  }

  const bySymbolArr = [...bySymbol.values()].sort((a, b) => {
    const pnlDiff = Math.abs(b.pnlTotalUsd) - Math.abs(a.pnlTotalUsd);
    if (pnlDiff !== 0) return pnlDiff;
    return b.trades - a.trades;
  });

  return {
    startTime,
    endTime,
    trades,
    wins,
    losses,
    pnlTotalUsd,
    pnlWinUsd,
    pnlLossUsd,
    bySymbol: bySymbolArr,
  };
}
