// src/market/fsm.ts
import { tradingState } from '../core/tradingState.js';
import { getATR, getCSI, getCvdThreshold } from './candleBuilder.js';

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
        console.log(`[FSM] Переход в состояние SETUP. Сигнал: ${signal}`);
        fsm.state = 'SETUP';
        fsm.side = signal.includes('LONG') ? 'LONG' : 'SHORT';
        fsm.setupAt = now;
        return { action: 'SETUP' };
      }
      return { action: 'NONE' };

    case 'SETUP':
      // Если сигнал исчез или сменил полярность - отмена
      if (!signal.includes(fsm.side || '')) {
        console.log('[FSM] Отмена SETUP: сигнал исчез или изменил полярность');
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'CANCEL_SETUP' };
      }
      // Если долго нет подтверждения - таймаут
      if (now - (fsm.setupAt || 0) > CONFIG.MAX_SETUP_DURATION) {
        console.log('[FSM] Таймаут SETUP: превышено максимальное время ожидания подтверждения');
        fsm.state = 'IDLE';
        fsm.side = null;
        return { action: 'TIMEOUT_SETUP' };
      }

      // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ:
      // Мы переходим в OPEN только если confirmEntry выдал true
      if (confirmed) {
        console.log(`[FSM] Переход в состояние OPEN. Сторона: ${fsm.side}`);
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
        console.log(
          `[FSM] Переход в состояние EXIT. Причина: ${exitSignal ? 'сигнал на выход' : 'превышено максимальное время удержания'}`
        );
        fsm.state = 'EXIT';
        return { action: 'EXIT_MARKET' };
      }
      return { action: 'HOLD' };

    case 'EXIT':
      console.log('[FSM] Возврат в состояние IDLE. Очистка контекста');
      fsm.state = 'IDLE';
      fsm.lastExitAt = now;
      fsm.side = null;
      fsm.openedAt = undefined;
      return { action: 'CLEANUP' };

    default:
      console.log('[FSM] Сброс в состояние IDLE по умолчанию');
      fsm.state = 'IDLE';
      return { action: 'RESET' };
  }
}

export const EXIT_THRESHOLDS = {
  STOP_LOSS_PCT: 1.2, // 0.6% стоп
  TAKE_PROFIT_PCT: 2, // минимум 1.2% для разрешения выхода
  CVD_REVERSAL: 500000, // агрессивный CVD против позиции для BTC/ETH
  CVD_REVERSAL_ALT: 150000, // агрессивный CVD для альтов
  MICRO_PROFIT_HOLD_PCT: 0.5, // не выходим, если профит еще микроскопический
  FUNDING_LONG: 0.0006,
  FUNDING_SHORT: -0.0006,
  MAX_HOLD_TIME: 30 * 60 * 1000,
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
  phase, // Добавляем фазу
  symbol,
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
  symbol: string;
  cvd3m: number;
  fundingRate: number;
  now: number;
  currentPrice: number;
  entryPrice: number;
  longScore: number;
  shortScore: number;
}): { exit: boolean; reason: ExitReason } {
  if (fsm.state !== 'OPEN' || !fsm.side) return { exit: false, reason: 'NONE' };

  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * (fsm.side === 'LONG' ? 100 : -100);
  const timeInPosition = now - (fsm.openedAt || 0);

  // 1. ДИНАМИЧЕСКИЕ ПОРОГИ (Вместо статичных EXIT_THRESHOLDS)
  const atr = getATR(symbol);
  const { cvdThreshold, moveThreshold } = getCvdThreshold(symbol);
  const csi = getCSI(symbol);

  // Динамический стоп-лосс: если ATR вырос, даем позиции больше "дышать"
  // Но не меньше твоего базового стопа
  const dynamicStopLoss = Math.max((atr / currentPrice) * 100 * 1.5, EXIT_THRESHOLDS.STOP_LOSS_PCT);

  // 2. ЖЕСТКИЙ СТОП-ЛОСС (Теперь динамический)
  if (pnlPct <= -dynamicStopLoss) {
    return { exit: true, reason: 'STOP_LOSS' };
  }

  // В shouldExitPosition замени условие Blow-off:
  if (phase === 'blowoff' && pnlPct > moveThreshold) {
    // Выходим, если профит больше, чем типичный импульс этой монеты
    return { exit: true, reason: 'BLOWOFF' };
  }

  const isMicroProfit = pnlPct > 0 && pnlPct < 0.2; // Фиксированный порог "шумового" профита

  // Если профит копеечный, игнорируем мелкие развороты CVD, даем цене шанс
  if (isMicroProfit && Math.abs(csi) < 0.4) {
    return { exit: false, reason: 'NONE' };
  }

  // Защита от дорогого фандинга (оставляем как было)
  if (fsm.side === 'LONG' && fundingRate > 0.0005) return { exit: true, reason: 'FUNDING' };
  if (fsm.side === 'SHORT' && fundingRate < -0.0005) return { exit: true, reason: 'FUNDING' };

  // 4. ДИНАМИЧЕСКИЙ РЕВЕРС CVD
  // Выходим, если против нас за 3 минуты налили больше 2-х норм аномального объема
  const dynamicCvdReversal = cvdThreshold * 2;
  const isCvdOpposed =
    fsm.side === 'LONG' ? cvd3m < -dynamicCvdReversal : cvd3m > dynamicCvdReversal;

  if (timeInPosition > 60_000 && isCvdOpposed) {
    // Доп. проверка: действительно ли свеча против нас "полная"?
    if ((fsm.side === 'LONG' && csi < -0.3) || (fsm.side === 'SHORT' && csi > 0.3)) {
      return { exit: true, reason: 'CVD_REVERSAL' };
    }
  }

  // 5. ТЕЙК-ПРОФИТ С ЗАТУХАНИЕМ
  if (pnlPct >= EXIT_THRESHOLDS.TAKE_PROFIT_PCT) {
    const currentScore = fsm.side === 'LONG' ? longScore : shortScore;
    // Если импульс выдохся (CSI близок к 0) и баллы упали — забираем профит
    if (Math.abs(csi) < 0.1 || currentScore < 40) {
      return { exit: true, reason: 'TAKE_PROFIT_SIGNAL_WEAK' };
    }
  }

  // 6. СЛОМ СТРУКТУРЫ (Реверс баллов — без изменений)
  if ((fsm.side === 'LONG' && shortScore > 75) || (fsm.side === 'SHORT' && longScore > 75)) {
    return { exit: true, reason: 'STRUCTURE_REVERSAL' };
  }

  // 7. ТАЙМАУТ (Защита от залипания)
  const maxTime = phase === 'range' ? 10 * 60000 : 30 * 60000; // 10м для ренджа, 30м для тренда
  if (timeInPosition > maxTime && pnlPct < 0.1) {
    return { exit: true, reason: 'TIMEOUT' };
  }

  return { exit: false, reason: 'NONE' };
}
