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
  lastConfirmationAt?: number; // ✅ вход подтверждён
  flags: {
    accumulation?: number;
    failedAccumulation?: number;
    squeezeStarted?: number;
    entryCandidate?: 'LONG' | 'SHORT' | undefined;
  };
}
