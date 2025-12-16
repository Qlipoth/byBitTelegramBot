export interface MarketSnapshot {
  symbol: string;
  price: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  timestamp: number;
}

export interface MarketDelta {
  priceChangePct: number;
  oiChangePct: number;
  fundingChange: number;
  minutesAgo: number;
}

export type MarketPhase = 'range' | 'accumulation' | 'trend' | 'distribution';

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
export interface ImpulseThresholds {
  PRICE_SURGE_PCT: number;
  VOLUME_SPIKE_PCT: number;
}

export interface IMPULSE_THRESHOLDS_CONFIG {
  VOLUME_SPIKE_PCT: number;
  VOLUME_HIGH_PCT: number;
  PRICE_STABLE_PCT: number;
  PRICE_DROP_PCT: number;
  PRICE_SURGE_PCT: number;
  OI_INCREASE_PCT: number;
  OI_SURGE_PCT: number;
}

export interface EntryScores {
  longScore: number;
  shortScore: number;
  entrySignal: string;
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
}

export interface ConfirmEntryParams {
  signal: 'LONG' | 'SHORT';
  delta: Delta;
  cvd3m: number;
  impulse: ImpulseThresholds;
}
