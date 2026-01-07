export type TradeSide = 'LONG' | 'SHORT';

export interface TradePosition {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  entryTime: number;
}

export interface OpenPositionParams {
  symbol: string;
  side: TradeSide;
  price: number;
  stopPrice: number;
  balance: number;
  now?: number;
}

export interface ClosePositionContext {
  price?: number;
  now?: number;
  reason?: string;
}

export interface TradeExecutor {
  bootstrap(symbols: string[]): Promise<void>;
  hasPosition(symbol: string): boolean;
  hasPending(symbol: string): boolean;
  hasExposure(symbol: string): boolean;
  getPosition(symbol: string): TradePosition | undefined;
  syncSymbol(symbol: string): Promise<void>;
  openPosition(params: OpenPositionParams): Promise<boolean>;
  closePosition(symbol: string, context?: ClosePositionContext): Promise<void>;
}
