// src/market/fsm.ts
export type TradeSide = 'LONG' | 'SHORT';

export type TradeState =
  | 'IDLE' // Nothing to do
  | 'SETUP' // Agreement detected
  | 'CONFIRM' // Waiting for impulse
  | 'OPEN' // Position is open
  | 'EXIT'; // Exiting position

export interface FSMContext {
  state: TradeState;
  side: TradeSide | null;
  setupAt?: number;
  openedAt?: number | undefined;
  lastActionAt?: number;
  entryPrice?: number | undefined;
  cvd3m?: number;
  fundingRate?: number;
  currentPrice?: number | undefined;
}

export function createFSM(): FSMContext {
  return {
    state: 'IDLE',
    side: null,
  };
}

export function fsmStep(
  fsm: FSMContext,
  input: {
    signal: 'LONG' | 'SHORT' | 'NONE';
    confirmed: boolean;
    now: number;
    cvd3m?: number;
    fundingRate?: number;
    currentPrice?: number;
  }
): {
  action: 'NONE' | 'SETUP' | 'CONFIRM' | 'ENTER' | 'EXIT';
} {
  const { signal, confirmed, now, cvd3m, fundingRate, currentPrice } = input;

  // Update last action timestamp
  fsm.lastActionAt = now;

  switch (fsm.state) {
    case 'IDLE': {
      if (signal === 'LONG' || signal === 'SHORT') {
        fsm.state = 'SETUP';
        fsm.side = signal;
        fsm.setupAt = now;
        return { action: 'SETUP' };
      }
      return { action: 'NONE' };
    }

    case 'SETUP': {
      if (signal !== fsm.side) {
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'NONE' };
      }
      fsm.state = 'CONFIRM';
      return { action: 'CONFIRM' };
    }

    case 'CONFIRM': {
      if (signal !== fsm.side) {
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'NONE' };
      }

      if (confirmed) {
        fsm.state = 'OPEN';
        fsm.openedAt = now;
        fsm.entryPrice = currentPrice;
        return { action: 'ENTER' };
      }

      return { action: 'NONE' };
    }

    case 'OPEN': {
      const shouldExit = shouldExitPosition({
        fsm,
        signal: signal,
        cvd3m: cvd3m || 0, // или другое значение по умолчанию
        fundingRate: fundingRate || 0,
        now: now,
        currentPrice: currentPrice || 0,
        entryPrice: fsm.entryPrice || 0,
      });

      if (shouldExit) {
        fsm.state = 'EXIT';
        return { action: 'EXIT' };
      }
      return { action: 'NONE' };
    }

    case 'EXIT': {
      fsm.state = 'IDLE';
      fsm.side = null;
      fsm.openedAt = undefined;
      return { action: 'NONE' };
    }

    default:
      return { action: 'NONE' };
  }
}

const EXIT_THRESHOLDS = {
  STOP_LOSS_PCT: 0.6, // 0.6% стоп
  TAKE_PROFIT_PCT: 1.2, // минимум 1.2% для разрешения выхода
  CVD_REVERSAL: 15000, // агрессивный CVD против позиции
  FUNDING_LONG: 0.0006,
  FUNDING_SHORT: -0.0006,
  MAX_HOLD_TIME: 30 * 60 * 1000,
};

type SIGNAL_VARIANT = 'LONG' | 'SHORT' | 'NONE';

export function shouldExitPosition({
  fsm,
  signal,
  cvd3m,
  fundingRate,
  now,
  currentPrice,
  entryPrice,
}: {
  fsm: FSMContext;
  signal: SIGNAL_VARIANT;
  cvd3m: number;
  fundingRate: number;
  now: number;
  currentPrice: number;
  entryPrice: number;
}): boolean {
  if (fsm.state !== 'OPEN' || !fsm.side) return false;

  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * (fsm.side === 'LONG' ? 100 : -100);

  // Тейк-профит (НЕ мгновенный)
  if (pnlPct >= EXIT_THRESHOLDS.TAKE_PROFIT_PCT) {
    // ждём подтверждение ослабления
    if (signal === 'NONE') return true;
  }

  // 2Слом направления (жёсткий, но без профита)
  if (signal !== fsm.side && pnlPct < EXIT_THRESHOLDS.TAKE_PROFIT_PCT) {
    return true;
  }

  // ЖЁСТКИЙ СТОП
  if (pnlPct <= -EXIT_THRESHOLDS.STOP_LOSS_PCT) return true;

  // Агрессивный CVD против позиции
  if (fsm.side === 'LONG' && cvd3m < -EXIT_THRESHOLDS.CVD_REVERSAL) return true;
  if (fsm.side === 'SHORT' && cvd3m > EXIT_THRESHOLDS.CVD_REVERSAL) return true;

  // Фандинг перегрелся
  if (fsm.side === 'LONG' && fundingRate > EXIT_THRESHOLDS.FUNDING_LONG) return true;
  if (fsm.side === 'SHORT' && fundingRate < EXIT_THRESHOLDS.FUNDING_SHORT) return true;

  // Таймаут
  return !!(fsm.openedAt && now - fsm.openedAt > EXIT_THRESHOLDS.MAX_HOLD_TIME);
}
