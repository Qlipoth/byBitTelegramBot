import type { HistoricalCandleInput } from '../market/candleBuilder.js';
export interface CvdPoint {
  timestamp: number;
  value: number;
}

const CVD_CACHE = new Map<string, CvdPoint[]>();

export function buildSyntheticCvdSeries(symbol: string, candles: HistoricalCandleInput[]): CvdPoint[] {
  if (!candles.length) return [];
  const cacheKey = `${symbol}_${candles[0]!.timestamp}_${candles.at(-1)!.timestamp}`;
  if (CVD_CACHE.has(cacheKey)) return CVD_CACHE.get(cacheKey)!;

  const series: CvdPoint[] = [];
  let cumulative = 0;
  for (const candle of candles) {
    const deltaPrice = candle.close - candle.open;
    const signedVolume = deltaPrice >= 0 ? candle.volume : -candle.volume;
    cumulative += signedVolume * candle.close;
    series.push({ timestamp: candle.timestamp, value: cumulative });
  }
  CVD_CACHE.set(cacheKey, series);
  return series;
}

export function getCvdDifference(series: CvdPoint[], startTs: number, endTs: number): number {
  if (!series.length) return 0;
  const startPoint = findClosestPoint(series, startTs, 'start');
  const endPoint = findClosestPoint(series, endTs, 'end');
  return endPoint.value - startPoint.value;
}

function findClosestPoint(series: CvdPoint[], ts: number, mode: 'start' | 'end'): CvdPoint {
  if (mode === 'start') {
    return series.find(point => point.timestamp >= ts) ?? series[0]!;
  }
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i]!.timestamp <= ts) return series[i]!;
  }
  return series.at(-1)!;
}
