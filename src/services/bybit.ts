import { RestClientV5, WebsocketClient } from 'bybit-api';
import type { MarketSnapshot } from '../market/types.js';
import { PRIORITY_COINS } from '../market/constants.market.js';
import { initCVDTracker } from '../market/cvdTracker.js';

// Initialize Bybit client
const bybitClient = new RestClientV5({
  key: process.env.BYBIT_API_KEY!,
  secret: process.env.BYBIT_SECRET_KEY!,
  testnet: false, // Set to true for testnet
});

export const ws = new WebsocketClient({
  key: process.env.BYBIT_API_KEY!, // можно без ключей для public данных
  secret: process.env.BYBIT_SECRET_KEY!,
  market: 'v5',
  testnet: false,
});

initCVDTracker(ws);

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

    // Filter and sort all USDT pairs by volume
    const allUsdtPairs = response.result.list
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .sort((a, b) => parseFloat(b.volume24h) - parseFloat(a.volume24h));

    // Get priority symbols that exist in the response
    const priorityPairs = PRIORITY_COINS.map(symbol =>
      allUsdtPairs.find(p => p.symbol === symbol)
    ).filter(Boolean);

    // Get top N symbols excluding already included priority pairs
    const topByVolume = allUsdtPairs
      .filter(pair => !PRIORITY_COINS.includes(pair.symbol as (typeof PRIORITY_COINS)[number]))
      .slice(0, limit - priorityPairs.length);

    // Combine and extract symbols
    const result = [...priorityPairs, ...topByVolume].slice(0, limit).map(ticker => ticker!.symbol);

    console.log('🔍 Tracking symbols:', result.join(', '));
    return result;
  } catch (error) {
    console.error('Error fetching top liquid symbols:', error);
    // Fallback to default symbols if API fails
    return PRIORITY_COINS.slice(0, limit);
  }
}

export async function preloadMarketSnapshots(symbol: string): Promise<MarketSnapshot[]> {
  // 1️⃣ Загружаем всё параллельно
  const [klines, oiHistory, funding] = await Promise.all([
    bybitClient.getKline({
      category: 'linear',
      symbol,
      interval: '1',
      limit: 30,
    }),
    bybitClient.getOpenInterest({
      category: 'linear',
      symbol,
      intervalTime: '5min',
      limit: 6, // ~30 минут
    }),
    bybitClient.getFundingRateHistory({
      category: 'linear',
      symbol,
      limit: 1,
    }),
  ]);

  if (
    !klines?.result?.list?.length ||
    !oiHistory?.result?.list?.length ||
    !funding?.result?.list?.length
  ) {
    throw new Error(`[PRELOAD] Failed to load history for ${symbol}`);
  }

  const candles = klines.result.list
    .map(c => ({
      timestamp: Number(c[0]),
      close: Number(c[4]),
    }))
    // свечи приходят в обратном порядке
    .sort((a, b) => a.timestamp - b.timestamp);

  const oiPoints = oiHistory.result.list
    .map(oi => ({
      timestamp: Number(oi.timestamp),
      openInterest: Number(oi.openInterest),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const fundingRate = Number(funding.result.list[0]!.fundingRate);

  // 2️⃣ Функция поиска актуального OI для свечи
  function getOiForTimestamp(ts: number): number {
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

  // 3️⃣ Собираем MarketSnapshot[]
  const snapshots: MarketSnapshot[] = candles.map(candle => ({
    symbol,
    price: candle.close,
    volume24h: 0, // не критично для логики
    openInterest: getOiForTimestamp(candle.timestamp),
    fundingRate,
    timestamp: candle.timestamp,
  }));

  console.log(`[PRELOAD] ${symbol}: loaded ${snapshots.length} snapshots`);

  return snapshots;
}
