import type { MarketDelta, MarketSnapshot } from './types.js';

function safePctChange(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return 0;
  }
  const pct = ((current - previous) / previous) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

export function compareSnapshots(now: MarketSnapshot, prev: MarketSnapshot): MarketDelta {
  return {
    priceChangePct: safePctChange(now.price, prev.price), // На сколько процентов изменилась цена между двумя моментами времени
    oiChangePct: safePctChange(now.openInterest, prev.openInterest), //На сколько процентов изменился открытый интерес (OI)
    fundingChange: now.fundingRate - (prev.fundingRate || 0), // Как изменился фандинг между снапшотами
    minutesAgo: Math.round((now.timestamp - prev.timestamp) / 60000), // Сколько минут прошло между снапшотами
  };
}

export function formatCompareSnapshots(delta: MarketDelta, symbol: string): string {
  const formatNumber = (num: number, decimals: number = 2, showPlus: boolean = true) => {
    const sign = showPlus && num > 0 ? '+' : '';
    return (
      sign +
      new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      }).format(num)
    );
  };

  const priceChange = formatNumber(delta.priceChangePct, 2);
  const oiChange = formatNumber(delta.oiChangePct, 2);
  const fundingChange = formatNumber(delta.fundingChange * 100, 4);

  const priceEmoji = delta.priceChangePct >= 0 ? '📈' : '📉';
  const oiEmoji = delta.oiChangePct >= 0 ? '📊' : '📉';
  const fundingEmoji = delta.fundingChange >= 0 ? '💹' : '🔻';

  return [
    `🔄 *${symbol} Market Changes (${delta.minutesAgo}m)*`,
    '------------------------',
    `${priceEmoji} Price: ${priceChange}%`,
    `${oiEmoji} OI: ${oiChange}%`,
    `${fundingEmoji} Funding: ${fundingChange}%`,
    '------------------------',
    `ℹ️ Last ${delta.minutesAgo} minutes comparison`,
  ].join('\n');
}
