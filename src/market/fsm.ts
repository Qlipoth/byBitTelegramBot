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
  lastExitAt: number | undefined;
}

export const CONFIG = {
  MIN_MOVE_THRESHOLD: 0.4, // Твой новый порог движения (%)
  MIN_CVD_THRESHOLD: 1500, // Твой новый порог CVD
  MAX_SETUP_DURATION: 5 * 60 * 1000, // 5 минут на подтверждение
  COOLDOWN_DURATION: 2 * 60 * 1000, // 2 минуты пауза после выхода
  // Максимальное время в сделке для ФЛЕТА (Range)
  // Во флете нам важно быстро зайти и выйти, пока цена не пробила канал.
  MAX_RANGE_HOLD: 15 * 60 * 1000, // 15 минут

  // Максимальное время в сделке для ТРЕНДА (Trend/Accumulation)
  // В тренде мы даем позиции "подышать", чтобы забрать большое движение.
  MAX_TREND_HOLD: 60 * 60 * 1000, // 60 минут (1 час)

  // Общий лимит на случай, если фаза не определена
  MAX_POSITION_DURATION: 30 * 60 * 1000, // 30 минут
};

export function createFSM(): FSMContext {
  return {
    state: 'IDLE',
    side: null,
    lastExitAt: undefined,
  };
}

export type FsmAction =
  | 'SETUP'
  | 'NONE'
  | 'CANCEL_SETUP'
  | 'TIMEOUT_SETUP'
  | 'CONFIRMING'
  | 'CANCEL_CONFIRM'
  | 'ENTER_MARKET'
  | 'EXIT_MARKET'
  | 'CLEANUP'
  | 'RESET'
  | 'WAIT_CONFIRMATION'
  | 'HOLD';

export function fsmStep(
  fsm: FSMContext,
  input: { signal: string; confirmed: boolean; now: number; exitSignal: boolean }
): { action: FsmAction } {
  const { signal, confirmed, now, exitSignal } = input;

  switch (fsm.state) {
    case 'IDLE':
      if (fsm.lastExitAt && now - fsm.lastExitAt < CONFIG.COOLDOWN_DURATION) {
        return { action: 'NONE' };
      }
      // Принимаем как трендовые (LONG/SHORT), так и флетовые сигналы (LONG_RANGE)
      if (signal.includes('LONG') || signal.includes('SHORT')) {
        fsm.state = 'SETUP';
        fsm.side = signal.includes('LONG') ? 'LONG' : 'SHORT';
        fsm.setupAt = now;
        return { action: 'SETUP' };
      }
      return { action: 'NONE' };

    case 'SETUP':
      // Если сигнал исчез или сменил полярность - отмена
      if (!signal.includes(fsm.side || '')) {
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'CANCEL_SETUP' };
      }
      // Если долго нет подтверждения - таймаут
      if (now - (fsm.setupAt || 0) > CONFIG.MAX_SETUP_DURATION) {
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'TIMEOUT_SETUP' };
      }

      // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ:
      // Мы переходим в OPEN только если confirmEntry выдал true
      if (confirmed) {
        fsm.state = 'OPEN';
        fsm.openedAt = now;
        return { action: 'ENTER_MARKET' };
      }

      // Если сигнал есть, но подтверждения (дельты/импульса) еще нет - ждем
      return { action: 'WAIT_CONFIRMATION' };

    case 'OPEN':
      const timeInPosition = now - (fsm.openedAt || 0);

      // Теперь exitSignal включает в себя фазу Blow-off и противоположный Score
      if (exitSignal || timeInPosition > CONFIG.MAX_POSITION_DURATION) {
        fsm.state = 'EXIT';
        return { action: 'EXIT_MARKET' };
      }
      return { action: 'HOLD' };

    case 'EXIT':
      fsm.state = 'IDLE';
      fsm.lastExitAt = now;
      fsm.side = null;
      fsm.openedAt = undefined;
      return { action: 'CLEANUP' };

    default:
      fsm.state = 'IDLE';
      return { action: 'RESET' };
  }
}

export const EXIT_THRESHOLDS = {
  STOP_LOSS_PCT: 0.6, // 0.6% стоп
  TAKE_PROFIT_PCT: 1.2, // минимум 1.2% для разрешения выхода
  CVD_REVERSAL: 15000, // агрессивный CVD против позиции
  FUNDING_LONG: 0.0006,
  FUNDING_SHORT: -0.0006,
  MAX_HOLD_TIME: 30 * 60 * 1000,
};

export function shouldExitPosition({
  fsm,
  signal,
  phase, // Добавляем фазу
  cvd3m,
  fundingRate,
  now,
  currentPrice,
  entryPrice,
  longScore, // Добавляем баллы для оценки силы
  shortScore,
}: {
  fsm: FSMContext;
  signal: string;
  phase: string;
  cvd3m: number;
  fundingRate: number;
  now: number;
  currentPrice: number;
  entryPrice: number;
  longScore: number;
  shortScore: number;
}): boolean {
  if (fsm.state !== 'OPEN' || !fsm.side) return false;

  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * (fsm.side === 'LONG' ? 100 : -100);

  // 1️⃣ КРИТИЧЕСКИЙ ВЫХОД: Blow-off (Кульминация)
  // Если мы в профите и началась фаза Blow-off — это идеальный момент зафиксироваться на сквизе
  if (phase === 'blowoff' && pnlPct > 0) return true;

  // 2️⃣ ЖЁСТКИЙ СТОП-ЛОСС
  if (pnlPct <= -EXIT_THRESHOLDS.STOP_LOSS_PCT) return true;

  // 3️⃣ ТЕЙК-ПРОФИТ (С логикой затухания)
  if (pnlPct >= EXIT_THRESHOLDS.TAKE_PROFIT_PCT) {
    // Если профит хороший, выходим, как только сигнал пропадает или баллы падают
    const currentScore = fsm.side === 'LONG' ? longScore : shortScore;
    if (signal === 'NONE' || currentScore < 40) return true;
  }

  // 4️⃣ СЛОМ СТРУКТУРЫ (Реверс баллов)
  // Если баллы противоположной стороны стали выше 70 — это опасный разворот
  if (fsm.side === 'LONG' && shortScore > 70) return true;
  if (fsm.side === 'SHORT' && longScore > 70) return true;

  // 5️⃣ ВЫХОД ПО ФАНДИНГУ (Защита от перегрева)
  if (fsm.side === 'LONG' && fundingRate > EXIT_THRESHOLDS.FUNDING_LONG) return true;
  if (fsm.side === 'SHORT' && fundingRate < EXIT_THRESHOLDS.FUNDING_SHORT) return true;

  // 6️⃣ АГРЕССИВНЫЙ CVD ПРОТИВ НАС (Локальный разворот)
  // Используем cvd3m для детекции внезапного давления маркет-ордеров
  if (fsm.side === 'LONG' && cvd3m < -EXIT_THRESHOLDS.CVD_REVERSAL) return true;
  if (fsm.side === 'SHORT' && cvd3m > EXIT_THRESHOLDS.CVD_REVERSAL) return true;

  // 7️⃣ ТАЙМАУТ (Защита от "залипания" в сделке)
  // Для флета (range) таймаут можно сделать короче, для тренда — дольше
  const maxTime = phase === 'range' ? CONFIG.MAX_RANGE_HOLD : CONFIG.MAX_TREND_HOLD;
  if (fsm.openedAt && now - fsm.openedAt > maxTime) return true;

  return false;
}
