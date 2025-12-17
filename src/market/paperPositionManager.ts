export type PaperSide = 'LONG' | 'SHORT';

export interface PaperPosition {
  side: PaperSide;
  entryPrice: number;
  entryTime: number;
}

export interface ClosedPaperPosition extends PaperPosition {
  exitPrice: number;
  exitTime: number;
  pnlPct: number;
  durationMs: number;
  symbol: string;
}

// Используем Map для поддержки нескольких монет одновременно
const activePositions = new Map<string, PaperPosition>();
const closedPositions: ClosedPaperPosition[] = [];

// =====================
// Open position
// =====================
export function openPaperPosition(symbol: string, side: PaperSide, price: number, now: number) {
  if (activePositions.has(symbol)) return;

  activePositions.set(symbol, {
    side,
    entryPrice: price,
    entryTime: now,
  });

  console.log(`[PAPER] [${symbol}] OPEN ${side} @ ${price}`);
}

// =====================
// Close position
// =====================
export function closePaperPosition(symbol: string, price: number, now: number) {
  const pos = activePositions.get(symbol);
  if (!pos) return;

  const { side, entryPrice, entryTime } = pos;

  // Учитываем комиссию (стандартная 0.1% за открытие + 0.1% за закрытие = 0.2%)
  const FEE = 0.2;

  const rawPnl =
    side === 'LONG'
      ? ((price - entryPrice) / entryPrice) * 100
      : ((entryPrice - price) / entryPrice) * 100;

  const pnlPct = rawPnl - FEE;

  const closed: ClosedPaperPosition = {
    ...pos,
    symbol, // добавляем символ в историю
    exitPrice: price,
    exitTime: now,
    pnlPct,
    durationMs: now - entryTime,
  };

  closedPositions.push(closed);
  activePositions.delete(symbol);

  console.log(
    `[PAPER] [${symbol}] CLOSE ${side} @ ${price} | PnL (net): ${pnlPct.toFixed(2)}% | ${Math.round(
      closed.durationMs / 1000 / 60
    )} min`
  );
}

// =====================
// Helpers
// =====================
export function hasOpenPaperPosition(symbol: string) {
  return activePositions.has(symbol);
}

export function getPaperPosition(symbol: string) {
  return activePositions.get(symbol);
}
