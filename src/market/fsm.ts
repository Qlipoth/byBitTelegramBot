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

type ActionType = 'NONE' | 'SETUP' | 'CONFIRM' | 'ENTER' | 'EXIT';

export function createFSM(): FSMContext {
  return {
    state: 'IDLE',
    side: null,
  };
}

interface InputParams {
  signal: 'LONG' | 'SHORT' | 'NONE';
  confirmed: boolean;
  now: number;
  exitSignal: boolean;
}

export function fsmStep(
  fsm: FSMContext,
  input: InputParams
): {
  action: ActionType;
} {
  const { signal, confirmed, now, exitSignal } = input;

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
        return { action: 'ENTER' };
      }

      return { action: 'NONE' };
    }

    case 'OPEN': {
      if (exitSignal) {
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
