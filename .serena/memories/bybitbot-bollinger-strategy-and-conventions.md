# byBitBot: стратегия и конвенции

## Стратегия
- **Режим:** адаптивный Боллинджер (mean reversion у полос), 1h свечи в лайве.
- **Вход:** только когда цена у нижней полосы (лонг) или верхней (шорт). Касание полосы даёт 35 баллов; без него L/S не дотягивают до порога → NO SETUP, ACTION NONE — это нормально.

## Скоринг (L/S)
- LONG: 35 (цена ≤ lower×1.004) + 20 (allowLong) + 10 (distancePct≥0.008) + 20 (emaBias≤-0.001) + 15 (bullCluster). Порог входа: **65**, gap **12** (config: `strategyConfig.adaptiveBollinger`).
- L=50 при цене в середине канала = 0+20+10+20+0 — без 35 за полосу, порог не достигается.

## Ключевые файлы
- Вход/сигнал: `src/market/adaptiveBollingerStrategy.ts`, `src/config/strategyConfig.ts`.
- Тик, логи, 1h sync: `src/market/watcher.ts`. Лайв-свечи 1m из `src/services/bybit.ts`; 1h для Bollinger подгружаются в watcher и попадают в `candleBuilder` (`ingest1hCandles`, `getCandle1h`, `getHistory1h`).
- Бэктест: `src/backtest/adaptiveBollingerBacktest.ts`. По умолчанию интервал **5m**; для соответствия лайву запускать с интервалом **60** (1h), например: `pnpx tsx src/backtest/adaptiveBollingerBacktest.ts <START> <END> <SYMBOL> 60`.

## Конвенции
- Пороги (signalThreshold, scoreGap) не ослаблять без обоснования — иначе входы не у полосы, больше шума.
- В логах NO SETUP показываются реальные пороги из конфига и подсказка «цена не у полосы», если оба L и S < 35.
