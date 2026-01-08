import type { SYMBOLS } from './constants.market.js';

export interface MarketSnapshot {
  symbol: string;
  price: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  timestamp: number;
  cvd1m?: number;
  cvd3m?: number;
  cvd15m?: number;
  cvd30m?: number;
  thresholds?: {
    moveThreshold?: number;
    cvdThreshold?: number;
    oiThreshold?: number;
    impulse?: {
      PRICE_SURGE_PCT: number;
      OI_INCREASE_PCT: number;
      OI_SURGE_PCT: number;
      VOL_SURGE_CVD: number;
    };
  };
}

export interface MarketDelta {
  priceChangePct: number;
  oiChangePct: number;
  fundingChange: number;
  minutesAgo: number;
}

export type MarketPhase = 'range' | 'accumulation' | 'trend' | 'distribution' | 'blowoff';

export interface MarketState {
  phase: MarketPhase;
  lastAlertAt: number;
  lastConfirmationAt?: number;
  flags: {
    entryCandidate?: 'LONG' | 'SHORT';
    lastEntrySide?: 'LONG' | 'SHORT';
    accumulationStrong?: boolean;
    accumulation?: number;
    failedAccumulation?: number;
    squeezeStarted?: number;
    [key: string]: any;
  };
}
export interface Delta {
  priceChangePct: number;
}

export interface IMPULSE_THRESHOLDS_CONFIG {
  PRICE_SURGE_PCT: number;
  OI_INCREASE_PCT: number;
  OI_SURGE_PCT: number;
  VOL_SURGE_CVD: number;
}

export interface EntryScores {
  longScore: number;
  shortScore: number;
  entrySignal: string;
  details?: Partial<{
    phase: number;
    oi: number;
    funding: number;
    cvd: number;
    impulse: number;
    rsi: number;
    trend: number;
  }>;
}

export interface EntryScoresParams {
  state: MarketState;
  delta: MarketDelta;
  delta15m: MarketDelta;
  delta30m: MarketDelta;
  delta5m: MarketDelta;
  snap: MarketSnapshot;
  cvd3m: number;
  cvd15m: number;
  rsi: number;
  impulse: IMPULSE_THRESHOLDS_CONFIG;
  isBull: boolean;
  isBear: boolean;
}

export interface SignalAgreementParams {
  longScore: number;
  shortScore: number;
  phase: MarketPhase;
  pricePercentChange: number;
  moveThreshold: number;
  cvd15m: number;
  cvdThreshold: number;
  fundingRate: number;
  rsi: number;
  symbol: string;
}

export interface ConfirmEntryParams {
  signal: 'LONG' | 'SHORT';
  delta: Delta;
  cvd3m: number;
  impulse: IMPULSE_THRESHOLDS_CONFIG;
  phase: MarketPhase;
  confirmedAt?: number;
}

export type SymbolValue = (typeof SYMBOLS)[keyof typeof SYMBOLS];
