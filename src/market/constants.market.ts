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
  PIPPIN: 'PIPPINUSDT',
  BEAT: 'BEATUSDT',

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
  THIRTY_MIN: 30 * 60 * 1000,
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

// =====================
// IMPULSE (1m) thresholds
// =====================
export const BASE_IMPULSE_THRESHOLDS = {
  VOLUME_SPIKE_PCT: 8, // раньше 6
  VOLUME_HIGH_PCT: 15, // раньше 10

  PRICE_STABLE_PCT: 0.35, // раньше 0.25
  PRICE_DROP_PCT: 0.8, // раньше 0.5
  PRICE_SURGE_PCT: 1.0, // раньше 0.6

  OI_INCREASE_PCT: 1.0, // раньше 0.6
  OI_SURGE_PCT: 2.0, // раньше 1.2
} as const;

export const LIQUID_IMPULSE_THRESHOLDS = {
  VOLUME_SPIKE_PCT: 6,
  VOLUME_HIGH_PCT: 10,

  PRICE_STABLE_PCT: 0.18,
  PRICE_DROP_PCT: 0.4,
  PRICE_SURGE_PCT: 0.5,

  OI_INCREASE_PCT: 0.4,
  OI_SURGE_PCT: 1.0,
} as const;

// =====================
// STRUCTURE (15m) thresholds
// =====================
export const BASE_STRUCTURE_THRESHOLDS = {
  VOLUME_SPIKE_PCT: 20,
  VOLUME_HIGH_PCT: 35,

  PRICE_STABLE_PCT: 1.0,
  PRICE_DROP_PCT: 1.6,
  PRICE_SURGE_PCT: 2.0,

  OI_INCREASE_PCT: 3.5, // раньше 2.5
  OI_SURGE_PCT: 7.0, // раньше 4.5
} as const;

export const LIQUID_STRUCTURE_THRESHOLDS = {
  VOLUME_SPIKE_PCT: 9,
  VOLUME_HIGH_PCT: 15,

  PRICE_STABLE_PCT: 0.4,
  PRICE_DROP_PCT: 0.8,
  PRICE_SURGE_PCT: 1.0,

  OI_INCREASE_PCT: 1.4, // был 1.8
  OI_SURGE_PCT: 2.5, // был 3.5
};

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
    FR_POSITIVE: 0.02,
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

// Funding rate thresholds
export const FUNDING_RATE_THRESHOLDS = {
  // For long squeeze confirmation
  LONG_SQUEEZE: 0.02, // 0.02% per 8h
  // For failed accumulation
  FAILED_ACCUMULATION: 0.01, // 0.01% per 8h
  // For extreme funding rate alert
  EXTREME: 0.03, // 0.03% per 8h
} as const;

export const COINS_COUNT = 20;

export const STRUCTURE_WINDOW = 15;

// These coins will always be included in the top liquid coins
export const PRIORITY_COINS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'FOLKSUSDT',
  'ZECUSDT',
] as const;
export const ALERT_COOLDOWN = 10 * 60 * 1000;
export const CONFIRM_COOLDOWN = 2 * 60_000;
export const LOG_PATH = '/tmp/bot.log';

// ---- Конфигурация Риска ----
export const RISK_PER_TRADE = 0.005; // 0.5% от депозита
export const RR_RATIO = 3; // Соотношение Риск/Прибыль
export const FEE = 0.12; // Реалистичная комиссия (Bybit Taker ~0.06% * 2)

export const ENTRY_FEE_PCT = 0.00055; // 0.055% (Taker)
export const EXIT_FEE_PCT = 0.00055; // 0.055% (Taker)
export const TOTAL_FEE_PCT = ENTRY_FEE_PCT + EXIT_FEE_PCT; // 0.0011 (или 0.11%)
