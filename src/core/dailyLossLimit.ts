/**
 * Отслеживание дневного убытка (UTC).
 * При достижении лимита (например −10$) бот отключает новые сделки до ручного /start.
 * Открытые позиции не закрываются — управляются как обычно (MEAN/STOP).
 */

const DAILY_LOSS_LIMIT_USD = 10;

let dailyPnlUsd = 0;
let dayKey = getDayKey(Date.now());
let limitReachedTriggeredToday = false;

function getDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function maybeResetDay(now: number): void {
  const currentKey = getDayKey(now);
  if (currentKey !== dayKey) {
    dayKey = currentKey;
    dailyPnlUsd = 0;
    limitReachedTriggeredToday = false;
  }
}

/**
 * Добавить PnL закрытой сделки в дневной учёт.
 */
export function addDailyPnlUsd(pnlUsd: number, now: number = Date.now()): void {
  maybeResetDay(now);
  if (!Number.isFinite(pnlUsd)) return;
  dailyPnlUsd += pnlUsd;
}

/**
 * Проверка: достигнут ли лимит дневного убытка (например −10$).
 */
export function isOverDailyLossLimit(): boolean {
  return dailyPnlUsd <= -DAILY_LOSS_LIMIT_USD;
}

/**
 * Была ли уже отправлена сигнальная отключка за сегодня (чтобы не слать алерт повторно).
 */
export function wasLimitAlertTriggeredToday(): boolean {
  return limitReachedTriggeredToday;
}

/**
 * Отметить, что алерт о лимите за сегодня уже отправлен (вызывается после отправки алерта).
 */
export function markLimitAlertTriggered(): void {
  limitReachedTriggeredToday = true;
}

/**
 * Текущий дневной PnL в USD.
 */
export function getDailyPnlUsd(): number {
  return dailyPnlUsd;
}

export function getDailyLossLimitUsd(): number {
  return DAILY_LOSS_LIMIT_USD;
}
