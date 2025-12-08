import { RestClientV5 } from 'bybit-api';
import type { MarketSnapshot } from '../market/types.js';
import { PRIORITY_COINS } from '../market/constants.market.js';

// Initialize Bybit client
const bybitClient = new RestClientV5({
  key: process.env.BYBIT_API_KEY!,
  secret: process.env.BYBIT_SECRET_KEY!,
  testnet: false, // Set to true for testnet
});

export async function getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  try {
    const [ticker, oi, funding] = await Promise.all([
      bybitClient.getTickers({ category: 'linear', symbol }),
      bybitClient.getOpenInterest({ category: 'linear', symbol, intervalTime: '5min' }),
      bybitClient.getFundingRateHistory({ category: 'linear', symbol }),
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

// src/services/bybit.ts

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
