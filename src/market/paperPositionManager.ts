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
}

let currentPosition: PaperPosition | null = null;
const closedPositions: ClosedPaperPosition[] = [];

// =====================
// Open position
// =====================
export function openPaperPosition(side: PaperSide, price: number, now: number) {
  if (currentPosition) return;

  currentPosition = {
    side,
    entryPrice: price,
    entryTime: now,
  };

  console.log(`[PAPER] OPEN ${side} @ ${price}`);
}

// =====================
// Close position
// =====================
export function closePaperPosition(price: number, now: number) {
  if (!currentPosition) return;

  const { side, entryPrice, entryTime } = currentPosition;

  const pnlPct =
    side === 'LONG'
      ? ((price - entryPrice) / entryPrice) * 100
      : ((entryPrice - price) / entryPrice) * 100;

  const closed: ClosedPaperPosition = {
    ...currentPosition,
    exitPrice: price,
    exitTime: now,
    pnlPct,
    durationMs: now - entryTime,
  };

  closedPositions.push(closed);

  console.log(
    `[PAPER] CLOSE ${side} @ ${price} | PnL: ${pnlPct.toFixed(2)}% | ${Math.round(
      closed.durationMs / 1000
    )}s`
  );

  currentPosition = null;
}

// =====================
// Helpers
// =====================
export function hasOpenPaperPosition() {
  return Boolean(currentPosition);
}

export function getPaperPosition() {
  return currentPosition;
}

export function getPaperStats() {
  const total = closedPositions.length;
  const wins = closedPositions.filter(p => p.pnlPct > 0).length;
  const avgPnL = total > 0 ? closedPositions.reduce((s, p) => s + p.pnlPct, 0) / total : 0;

  return {
    total,
    wins,
    winRate: total ? (wins / total) * 100 : 0,
    avgPnL,
  };
}
