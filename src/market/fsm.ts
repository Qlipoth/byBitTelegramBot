// src/market/fsm.ts
import { tradingState } from '../core/tradingState.js';
import type { MarketSnapshot } from './types.js';
import type { WatcherLogger } from './logging.js';
import { getWatcherLogger } from './logging.js';

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
  COOLDOWN_DURATION: 0, // пауза после выхода выключена
  // Максимальное время в сделке для ФЛЕТА (Range)
  // Во флете нам важно быстро зайти и выйти, пока цена не пробила канал.
  MAX_RANGE_HOLD: 45 * 60 * 1000, // 25 минут

  // Максимальное время в сделке для ТРЕНДА (Trend/Accumulation)
  // В тренде мы даем позиции "подышать", чтобы забрать большое движение.
  MAX_TREND_HOLD: 90 * 60 * 1000, // 90 минут

  // Общий лимит: для adaptive (Bollinger) в бэктесте среднее ~6–7 ч до MEAN/STOP.
  // 45 мин резало рано; 8 ч — многовато. Ставим 6 ч.
  MAX_POSITION_DURATION: 24 * 60 * 60 * 1000, // 24 часа — не скальп, держим до MEAN/STOP
};

function getPhaseHoldLimit(phase: string): number {
  if (phase === 'trend' || phase === 'accumulation') {
    return CONFIG.MAX_TREND_HOLD;
  }
  if (phase === 'range' || phase === 'distribution') {
    return CONFIG.MAX_RANGE_HOLD;
  }
  return CONFIG.MAX_POSITION_DURATION;
}

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
  input: { signal: string; confirmed: boolean; now: number; exitSignal: boolean },
  log?: WatcherLogger
): { action: FsmAction } {
  const logger = getWatcherLogger(log);
  const { signal, confirmed, now, exitSignal } = input;

  if (!tradingState.isEnabled()) {
    return { action: 'NONE' };
  }

  switch (fsm.state) {
    case 'IDLE':
      if (fsm.lastExitAt && now - fsm.lastExitAt < CONFIG.COOLDOWN_DURATION) {
        return { action: 'NONE' };
      }
      // Принимаем как трендовые (LONG/SHORT), так и флетовые сигналы (LONG_RANGE)
      if (signal.includes('LONG') || signal.includes('SHORT')) {
        logger(`[FSM] Переход в состояние SETUP. Сигнал: ${signal}`);
        fsm.state = 'SETUP';
        fsm.side = signal.includes('LONG') ? 'LONG' : 'SHORT';
        fsm.setupAt = now;
        return { action: 'SETUP' };
      }
      return { action: 'NONE' };

    case 'SETUP':
      // Если сигнал исчез или сменил полярность - отмена
      if (!signal.includes(fsm.side || '')) {
        logger('[FSM] Отмена SETUP: сигнал исчез или изменил полярность');
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'CANCEL_SETUP' };
      }
      // Если долго нет подтверждения - таймаут
      if (now - (fsm.setupAt || 0) > CONFIG.MAX_SETUP_DURATION) {
        logger('[FSM] Таймаут SETUP: превышено максимальное время ожидания подтверждения');
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'TIMEOUT_SETUP' };
      }

      // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ:
      // Мы переходим в OPEN только если confirmEntry выдал true
      if (confirmed) {
        logger(`[FSM] Переход в состояние OPEN. Сторона: ${fsm.side}`);
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
        logger(
          `[FSM] Переход в состояние EXIT. Причина: ${exitSignal ? 'сигнал на выход' : 'превышено максимальное время удержания'}`
        );
        fsm.state = 'EXIT';
        return { action: 'EXIT_MARKET' };
      }
      return { action: 'HOLD' };

    case 'EXIT':
      logger('[FSM] Возврат в состояние IDLE. Очистка контекста');
      fsm.state = 'IDLE';
      fsm.lastExitAt = now;
      fsm.side = null;
      fsm.openedAt = undefined;
      return { action: 'CLEANUP' };

    default:
      logger('[FSM] Сброс в состояние IDLE по умолчанию');
      fsm.state = 'IDLE';
      return { action: 'RESET' };
  }
}

export const EXIT_THRESHOLDS = {
  STOP_LOSS_PCT: 2.5, // ВАРИАНТ A: увеличенный стоп 2.5%
  TAKE_PROFIT_PCT: 2, // минимум 1.2% для разрешения выхода
  CVD_REVERSAL: 500000, // агрессивный CVD против позиции для BTC/ETH
  CVD_REVERSAL_ALT: 150000, // агрессивный CVD для альтов
  MICRO_PROFIT_HOLD_PCT: 0.5, // не выходим, если профит еще микроскопический
  FUNDING_LONG: 0.0006,
  FUNDING_SHORT: -0.0006,
  MAX_HOLD_TIME: 90 * 60 * 1000,
};

export type ExitReason =
  | 'BLOWOFF'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_SIGNAL_WEAK'
  | 'STRUCTURE_REVERSAL'
  | 'FUNDING'
  | 'CVD_REVERSAL'
  | 'TIMEOUT'
  | 'MAX_POSITION_DURATION'
  | 'NONE';

export function shouldExitPosition({
  fsm,
  phase,
  snapshot,
  now,
  entryPrice,
  longScore,
  shortScore,
  atr,
}: {
  fsm: FSMContext;
  phase: string;
  snapshot: MarketSnapshot;
  now: number;
  entryPrice: number;
  longScore: number;
  shortScore: number;
  atr?: number;
}): { exit: boolean; reason: ExitReason } {
  if (fsm.state !== 'OPEN' || !fsm.side) return { exit: false, reason: 'NONE' };

  const currentPrice = snapshot.price;
  const cvd3m = typeof snapshot.cvd3m === 'number' ? snapshot.cvd3m : 0;
  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * (fsm.side === 'LONG' ? 100 : -100);
  const timeInPosition = now - (fsm.openedAt || 0);
  const phaseHoldLimit = Math.min(getPhaseHoldLimit(phase), CONFIG.MAX_POSITION_DURATION);
  const stagnationWindow = Math.min(EXIT_THRESHOLDS.MAX_HOLD_TIME, phaseHoldLimit);
  const moveTargetPct =
    snapshot.thresholds?.moveThreshold ??
    CONFIG.MIN_MOVE_THRESHOLD ??
    EXIT_THRESHOLDS.TAKE_PROFIT_PCT / 2;

  if (timeInPosition >= phaseHoldLimit) {
    return { exit: true, reason: 'MAX_POSITION_DURATION' };
  }

  // 1. ДИНАМИЧЕСКИЙ СТОП-ЛОСС на основе ATR (ВАРИАНТ B)
  // Если ATR доступен — используем 2×ATR, иначе фиксированный %
  let dynamicStopPct = EXIT_THRESHOLDS.STOP_LOSS_PCT;
  if (atr && atr > 0 && entryPrice > 0) {
    // ATR в процентах от цены × 2
    const atrPct = (atr / entryPrice) * 100;
    dynamicStopPct = Math.max(atrPct * 2, 1.0); // Минимум 1%, максимум 2×ATR
    dynamicStopPct = Math.min(dynamicStopPct, 4.0); // Не больше 4%
  }
  if (pnlPct <= -dynamicStopPct) return { exit: true, reason: 'STOP_LOSS' };

  // 2. ЗАЩИТА ПРИБЫЛИ ПО СИГНАЛУ (Вместо maxReachedPnl)
  // Если профит уже > 0.4%, и сигнал (Score) упал ниже 50 — выходим.
  // Это не даст сделке сползти из плюса в минус.
  const currentScore = fsm.side === 'LONG' ? longScore : shortScore;
  // if (pnlPct > 0.4 && currentScore < 50) {
  //   return { exit: true, reason: 'TAKE_PROFIT_SIGNAL_WEAK' };
  // }

  // 3. ЭКСТРЕННЫЙ ВЫХОД ПО CVD (Реальные деньги против нас)
  // Если мы в просадке и видим агрессивный CVD в обратную сторону (1.5 млн за 3 мин)

  const cvdReversal = 2500000;
  if (timeInPosition > 45 * 60 * 1000 && pnlPct < 0) {
    if (fsm.side === 'LONG' && cvd3m < -cvdReversal) return { exit: true, reason: 'CVD_REVERSAL' };
    if (fsm.side === 'SHORT' && cvd3m > cvdReversal) return { exit: true, reason: 'CVD_REVERSAL' };
  }

  // if (fsm.side === 'LONG' && longScore < 65) return { exit: true, reason: 'CVD_REVERSAL' };
  // if (fsm.side === 'SHORT' && shortScore < 65) return { exit: true, reason: 'CVD_REVERSAL' };

  // 4. ВЫХОД ПО ТАЙМАУТУ (Мягкий стагнация-фильтр)
  // Если за 30 минут не ушли в нормальный плюс (> 0.2%), закрываем вялую позицию.
  if (timeInPosition > stagnationWindow) {
    const progressRatio = Math.min(timeInPosition / phaseHoldLimit, 1);
    const requiredPnl = moveTargetPct * progressRatio;
    if (pnlPct < requiredPnl) {
      return { exit: true, reason: 'TIMEOUT' };
    }
  }

  // 5. ТЕЙК-ПРОФИТ (Твоя логика)
  if (pnlPct >= EXIT_THRESHOLDS.TAKE_PROFIT_PCT) {
    if (currentScore < 45) return { exit: true, reason: 'TAKE_PROFIT_SIGNAL_WEAK' };
  }

  // 6. BLOWOFF (Быстрый заброс)
  if (phase === 'blowoff' && pnlPct > 0.7) {
    return { exit: true, reason: 'BLOWOFF' };
  }

  return { exit: false, reason: 'NONE' };
}
