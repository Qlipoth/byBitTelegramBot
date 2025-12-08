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
