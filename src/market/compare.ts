import type { MarketDelta, MarketSnapshot } from './types.js';

export function compareSnapshots(now: MarketSnapshot, prev: MarketSnapshot): MarketDelta {
  return {
    priceChangePct: ((now.price - prev.price) / prev.price) * 100,

    oiChangePct: ((now.openInterest - prev.openInterest) / prev.openInterest) * 100,

    fundingChange: now.fundingRate - prev.fundingRate,

    volumeChangePct:
      prev.volume24h > 0 ? ((now.volume24h - prev.volume24h) / prev.volume24h) * 100 : 0,

    minutesAgo: Math.round((now.timestamp - prev.timestamp) / 60000),
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
  const volumeChange = formatNumber(delta.volumeChangePct, 2);

  const priceEmoji = delta.priceChangePct >= 0 ? '📈' : '📉';
  const oiEmoji = delta.oiChangePct >= 0 ? '📊' : '📉';
  const fundingEmoji = delta.fundingChange >= 0 ? '💹' : '🔻';
  const volumeEmoji = delta.volumeChangePct >= 0 ? '🔼' : '🔽';

  return [
    `🔄 *${symbol} Market Changes (${delta.minutesAgo}m)*`,
    '------------------------',
    `${priceEmoji} Price: ${priceChange}%`,
    `${oiEmoji} OI: ${oiChange}%`,
    `${volumeEmoji} Volume: ${volumeChange}%`,
    `${fundingEmoji} Funding: ${fundingChange}%`,
    '------------------------',
    `ℹ️ Last ${delta.minutesAgo} minutes comparison`,
  ].join('\n');
}
