import { calculatePositionSizing } from '../market/paperPositionManager.js';
import { TOTAL_FEE_PCT } from '../market/constants.market.js';
import type {
  TradeExecutor,
  TradePosition,
  OpenPositionParams,
  ClosePositionContext,
} from '../market/tradeExecutor.js';

interface ClosedBacktestTrade extends TradePosition {
  exitPrice: number;
  exitTime: number;
  pnlUsd: number;
  pnlPct: number;
  pnlGrossUsd: number;
  pnlGrossPct: number;
  feesUsd: number;
  reason: string;
}

interface BacktestTradeManagerOptions {
  initialBalance?: number;
  feePct?: number;
  rrRatio?: number;
}

export class BacktestTradeManager implements TradeExecutor {
  private readonly rrRatio: number;
  private readonly feePct: number;
  private readonly initialBalance: number;

  private balance: number;
  private readonly activePositions = new Map<string, TradePosition>();
  private readonly closedTrades: ClosedBacktestTrade[] = [];

  constructor(options: BacktestTradeManagerOptions = {}) {
    this.initialBalance = options.initialBalance ?? 10_000;
    this.balance = this.initialBalance;
    this.feePct = options.feePct ?? TOTAL_FEE_PCT; // matches live trading (entry + exit)
    this.rrRatio = options.rrRatio ?? 2;
  }

  async bootstrap(_symbols: string[]): Promise<void> {
    this.activePositions.clear();
    this.closedTrades.length = 0;
    this.balance = this.initialBalance;
  }

  hasPosition(symbol: string): boolean {
    return this.activePositions.has(symbol);
  }

  hasPending(_symbol: string): boolean {
    return false;
  }

  hasExposure(symbol: string): boolean {
    return this.hasPosition(symbol);
  }

  getPosition(symbol: string): TradePosition | undefined {
    return this.activePositions.get(symbol);
  }

  async syncSymbol(_symbol: string): Promise<void> {
    // No-op for backtests
  }

  async openPosition(params: OpenPositionParams): Promise<boolean> {
    const { symbol, side, price, stopPrice, balance, entryMeta } = params;

    if (this.hasExposure(symbol)) return false;
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return false;

    const sizing = calculatePositionSizing(balance ?? this.balance, price, stopPrice);
    if (!sizing) return false;

    const qty = sizing.sizeUsd / price;
    if (!Number.isFinite(qty) || qty <= 0) return false;

    const takePct = sizing.stopPct * this.rrRatio + this.feePct;
    const takeProfit = side === 'LONG' ? price * (1 + takePct) : price * (1 - takePct);

    const position: TradePosition = {
      symbol,
      side,
      entryPrice: price,
      stopLoss: stopPrice,
      takeProfit,
      qty,
      entryTime: params.now ?? Date.now(),
      entryMeta: entryMeta!,
    };

    this.activePositions.set(symbol, position);
    return true;
  }

  async closePosition(symbol: string, context?: ClosePositionContext): Promise<void> {
    const existing = this.activePositions.get(symbol);
    if (!existing) return;

    const exitPrice = context?.price ?? existing.takeProfit;
    const exitTime = context?.now ?? Date.now();
    const reason = context?.reason ?? 'EXIT';

    const direction = existing.side === 'LONG' ? 1 : -1;
    const grossPnl = (exitPrice - existing.entryPrice) * direction * existing.qty;
    const notionalEntry = existing.entryPrice * existing.qty;
    const notionalExit = exitPrice * existing.qty;
    const feePerSide = this.feePct / 2;
    const fee = (notionalEntry + notionalExit) * feePerSide;
    const netPnl = grossPnl - fee;
    const pnlPct = (netPnl / notionalEntry) * 100;
    const pnlGrossPct = (grossPnl / notionalEntry) * 100;

    this.balance += netPnl;

    this.closedTrades.push({
      ...existing,
      exitPrice,
      exitTime,
      pnlUsd: netPnl,
      pnlPct,
      pnlGrossUsd: grossPnl,
      pnlGrossPct,
      feesUsd: fee,
      reason,
    });

    this.activePositions.delete(symbol);
  }

  getBalance(): number {
    return this.balance;
  }

  getClosedTrades(): ClosedBacktestTrade[] {
    return [...this.closedTrades];
  }

  getStats() {
    const trades = this.closedTrades.length;
    const wins = this.closedTrades.filter(t => t.pnlUsd > 0).length;
    const losses = trades - wins;
    const pnlTotal = this.closedTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

    return {
      trades,
      wins,
      losses,
      winrate: trades ? (wins / trades) * 100 : 0,
      pnlTotal,
      balance: this.balance,
      maxDrawdown: this.calculateDrawdown(),
      closedTrades: this.getClosedTrades(),
    };
  }

  private calculateDrawdown(): number {
    let equity = this.initialBalance;
    let maxEquity = equity;
    let maxDd = 0;

    for (const trade of this.closedTrades) {
      equity += trade.pnlUsd;
      maxEquity = Math.max(maxEquity, equity);
      maxDd = Math.max(maxDd, maxEquity - equity);
    }

    return maxDd;
  }
}
