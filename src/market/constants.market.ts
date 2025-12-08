// List of all supported symbols
export const SYMBOLS = {
  // Major cryptocurrencies
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',

  // High-cap altcoins
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  ADA: 'ADAUSDT',

  // High-volatility tokens
  DOGE: 'DOGEUSDT',
  SHIB: 'SHIBUSDT',
  PEPE: 'PEPEUSDT',
  FLOKI: 'FLOKIUSDT',

  // DeFi tokens
  UNI: 'UNIUSDT',
  AAVE: 'AAVEUSDT',

  // Layer 1 alternatives
  AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT',
  MATIC: 'MATICUSDT',
  USTC: 'USTCUSDT',

  // Default symbol
  DEFAULT: 'BTCUSDT',
} as const;

export type SymbolType = keyof typeof SYMBOLS;

// Helper function to get symbol with validation
export function getSymbol(symbol: SymbolType | string = 'DEFAULT'): string {
  const upperSymbol = symbol.toUpperCase() as SymbolType;
  return SYMBOLS[upperSymbol] || SYMBOLS.DEFAULT;
}

// Common intervals in milliseconds
export const INTERVALS = {
  ONE_MIN: 60 * 1000,
  FIVE_MIN: 5 * 60 * 1000,
  FIFTEEN_MIN: 15 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
} as const;

// Base thresholds for normal coins
export const BASE_ALERT_THRESHOLDS = {
  // Volume thresholds (in % change)
  VOLUME_SPIKE_PCT: 8, // Moderate volume increase
  VOLUME_HIGH_PCT: 15, // Significant volume increase

  // Price movement thresholds (in %)
  PRICE_STABLE_PCT: 0.3, // Price is relatively stable
  PRICE_DROP_PCT: 0.7, // Noticeable price drop
  PRICE_SURGE_PCT: 0.8, // Initial price surge

  // OI thresholds (in %)
  OI_INCREASE_PCT: 1.5, // Early signs of position building
  OI_SURGE_PCT: 3.0, // Strong position building
} as const;

// More sensitive thresholds for liquid coins (like BTC, ETH)
export const LIQUID_COIN_THRESHOLDS = {
  // More sensitive to volume changes
  VOLUME_SPIKE_PCT: 5, // Lower threshold for liquid pairs
  VOLUME_HIGH_PCT: 10, // Lower threshold for liquid pairs

  // Tighter price movements for liquid pairs
  PRICE_STABLE_PCT: 0.2,
  PRICE_DROP_PCT: 0.5,
  PRICE_SURGE_PCT: 0.6,

  // More sensitive to OI changes
  OI_INCREASE_PCT: 1.0,
  OI_SURGE_PCT: 2.0,
} as const;

// Default to base thresholds
export let ALERT_THRESHOLDS = { ...BASE_ALERT_THRESHOLDS };

// Trend thresholds for normal coins
export const BASE_TREND_THRESHOLDS = {
  PRICE_CHANGE: 2, // 2% price change for significant move
  OI_CHANGE: 5, // 5% OI change for trend confirmation
  ACCUMULATION_PRICE_BAND: 1, // 1% price band for accumulation
} as const;

// More sensitive trend thresholds for liquid coins
export const LIQUID_TREND_THRESHOLDS = {
  PRICE_CHANGE: 1.3, // More sensitive to price changes
  OI_CHANGE: 2, // More sensitive to OI changes
  ACCUMULATION_PRICE_BAND: 0.4, // Tighter accumulation band
} as const;

// Function to get trend thresholds based on symbol
export function getTrendThresholds(symbol: string) {
  return PRIORITY_COINS.includes(symbol as (typeof PRIORITY_COINS)[number])
    ? { ...LIQUID_TREND_THRESHOLDS }
    : { ...BASE_TREND_THRESHOLDS };
}

// Default trend thresholds
export const TREND_THRESHOLDS = { ...BASE_TREND_THRESHOLDS };

// Squeeze detection constants
export const SQUEEZE_THRESHOLDS = {
  // Short squeeze
  SHORT: {
    PRICE_CHANGE: { PRIORITY: 1.6, NORMAL: 2 },
    VOLUME_CHANGE: { PRIORITY: 120, NORMAL: 150 },
    OI_CHANGE: { PRIORITY: -0.8, NORMAL: -1 },
    RSI_OVERBOUGHT: { PRIORITY: 67, NORMAL: 65 },
  },
  // Long squeeze
  LONG: {
    PRICE_CHANGE: -2,
    VOLUME_CHANGE: 100,
    OI_CHANGE: -1.5,
    RSI_OVERBOUGHT: 65,
  },
  // Squeeze score weights
  SCORE_WEIGHTS: {
    PRICE: 0.4,
    VOLUME: 0.3,
    OI: 0.3,
  },
  // Score thresholds
  SCORE_THRESHOLDS: {
    STRONG: 0.7,
    MEDIUM: 0.5,
  },
} as const;

// Number of top liquid coins to track
export const TOP_LIQUID_COINS = 15;

// These coins will always be included in the top liquid coins
export const PRIORITY_COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;

export const COINS_COUNT = 20;

export const STRUCTURE_WINDOW = 15;
