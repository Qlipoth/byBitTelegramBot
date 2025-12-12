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
  volumeChangePct: number;
  minutesAgo: number;
}

export interface MarketState {
  phase: 'range' | 'accumulation' | 'trend';
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
