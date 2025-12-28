import type { MarketSnapshot } from './types.js';

export type PaperSide = 'LONG' | 'SHORT';

export interface PaperPosition {
  symbol: string;
  side: PaperSide;

  entryPrice: number;
  stopLoss: number;
  takeProfit: number;

  sizeUsd: number; // НОМИНАЛ позиции (а не маржа!)
  entryTime: number;
}

const RISK_PER_TRADE = 0.005; // 0.5%
const RR_RATIO = 3;

const ENTRY_FEE_PCT = 0.0006;
const EXIT_FEE_PCT = 0.0006;
const TOTAL_FEE_PCT = ENTRY_FEE_PCT + EXIT_FEE_PCT;

const MAX_STOP_PCT = 0.025; // 2.5%
const MIN_POSITION_USD = 20;

const LEVERAGE = 10;

export interface ClosedPaperPosition extends PaperPosition {
  exitPrice: number;
  pnlNet: number;
  exitTime: number;
  symbol: string;
  reason: string;
}

// Используем Map для поддержки нескольких монет одновременно
const activePositions = new Map<string, PaperPosition>();
const closedPositions: ClosedPaperPosition[] = [];

export function calculatePositionSizing(
  balance: number,
  entryPrice: number,
  stopPrice: number
): { sizeUsd: number; stopPct: number } | null {
  console.log(
    `[calculatePositionSizing] Input - balance: ${balance}, entryPrice: ${entryPrice}, stopPrice: ${stopPrice}`
  );

  const stopPct = Math.abs(entryPrice - stopPrice) / entryPrice;
  console.log(`[calculatePositionSizing] Calculated stopPct: ${stopPct}`);

  // 1️⃣ Валидация стопа
  if (stopPct <= 0 || stopPct > MAX_STOP_PCT) {
    console.log(
      `[calculatePositionSizing] ❌ Invalid stopPct: ${stopPct} (must be between 0 and ${MAX_STOP_PCT})`
    );
    return null;
  }

  // 2️⃣ Учет комиссии в риске
  const maxPriceRiskPct = RISK_PER_TRADE - TOTAL_FEE_PCT;
  console.log(
    `[calculatePositionSizing] maxPriceRiskPct: ${maxPriceRiskPct} (RISK_PER_TRADE: ${RISK_PER_TRADE}, TOTAL_FEE_PCT: ${TOTAL_FEE_PCT})`
  );

  if (maxPriceRiskPct <= 0 || stopPct > maxPriceRiskPct) {
    console.log(
      `[calculatePositionSizing] ❌ Invalid risk parameters: maxPriceRiskPct=${maxPriceRiskPct}, stopPct=${stopPct}`
    );
    return null;
  }

  // 3️⃣ Защита от ликвидации (cross + x10)
  const liquidationBufferPct = (1 / LEVERAGE) * 0.8; // ~8%
  console.log(
    `[calculatePositionSizing] liquidationBufferPct: ${liquidationBufferPct} (LEVERAGE: ${LEVERAGE})`
  );

  if (stopPct >= liquidationBufferPct) {
    console.log(
      `[calculatePositionSizing] ❌ Stop too close to liquidation: stopPct=${stopPct}, liquidationBufferPct=${liquidationBufferPct}`
    );
    return null;
  }

  // 4️⃣ Размер позиции
  const sizeUsd = (balance * maxPriceRiskPct) / stopPct;
  console.log(
    `[calculatePositionSizing] Calculated sizeUsd: ${sizeUsd} (balance: ${balance}, maxPriceRiskPct: ${maxPriceRiskPct}, stopPct: ${stopPct})`
  );
  if (sizeUsd < MIN_POSITION_USD) return null;

  return { sizeUsd, stopPct };
}

// =====================
// Open position
// =====================
export function openPaperPosition(params: {
  symbol: string;
  side: PaperSide;
  price: number;
  stopPrice: number | null;
  balance: number;
  now: number;
}): boolean {
  const { symbol, side, price, stopPrice, balance, now } = params;

  if (!balance) {
    console.log('Нулевой баланс!');
    return false;
  }

  if (activePositions.has(symbol) || !stopPrice) return false;

  const sizing = calculatePositionSizing(balance, price, stopPrice);
  if (!sizing) return false;

  const { sizeUsd, stopPct } = sizing;

  // Честный тейк (RR + комиссия)
  const takePct = stopPct * RR_RATIO + TOTAL_FEE_PCT;

  const takeProfit = side === 'LONG' ? price * (1 + takePct) : price * (1 - takePct);

  activePositions.set(symbol, {
    symbol,
    side,
    entryPrice: price,
    stopLoss: stopPrice,
    takeProfit,
    sizeUsd,
    entryTime: now,
  });

  console.log(
    `🚀 [${symbol}] OPEN ${side} | size=$${sizeUsd.toFixed(2)} | SL=${stopPrice.toFixed(
      6
    )} | TP=${takeProfit.toFixed(6)}`
  );

  return true;
}

// =====================
// Close position
// =====================

export function closePaperPosition(symbol: string, price: number, now: number, reason = 'MANUAL') {
  const pos = activePositions.get(symbol);
  if (!pos) return;

  const rawPnlPct =
    pos.side === 'LONG'
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - price) / pos.entryPrice) * 100;

  const pnlNet = rawPnlPct - TOTAL_FEE_PCT * 100;

  closedPositions.push({
    ...pos,
    exitPrice: price,
    exitTime: now,
    pnlNet,
    reason,
  });

  activePositions.delete(symbol);

  const emoji = pnlNet > 0 ? '💰' : '🛑';
  console.log(`${emoji} [${symbol}] CLOSE | PnL: ${pnlNet.toFixed(2)}% | ${reason}`);
}

export function updateAndCheckExit(symbol: string, currentPrice: number, now: number): boolean {
  const pos = activePositions.get(symbol);
  if (!pos) return false;

  const isLong = pos.side === 'LONG';

  const hitStop = isLong ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss;

  const hitTake = isLong ? currentPrice >= pos.takeProfit : currentPrice <= pos.takeProfit;

  if (hitStop || hitTake) {
    closePaperPosition(symbol, currentPrice, now, hitStop ? 'STOP' : 'TAKE');
    return true;
  }

  return false;
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
export function findStopLossLevel(
  snaps: MarketSnapshot[],
  side: 'LONG' | 'SHORT',
  lookback: number = 30
): number {
  if (snaps.length < 5) return 0; // Слишком мало данных

  // Берем только последние N записей
  const relevantSnaps = snaps.slice(-lookback);
  const prices = relevantSnaps.map(s => s.price);

  if (side === 'LONG') {
    // Стоп ставим чуть ниже локального минимума (на 0.1% для "дыхания")
    const minPrice = Math.min(...prices);
    return minPrice * 0.999;
  } else {
    // Стоп ставим чуть выше локального максимума
    const maxPrice = Math.max(...prices);
    return maxPrice * 1.001;
  }
}
