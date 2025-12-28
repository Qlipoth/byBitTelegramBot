// cvdTracker.ts
import { WebsocketClient } from 'bybit-api';
import { handleTrade } from './candleBuilder.js';

const cvdCurrent = new Map<string, number>();
const cvdSnapshot = new Map<string, { time: number; value: number }[]>();

export function initCVDTracker(ws: WebsocketClient) {
  ws.on('update', data => {
    if (data.topic.startsWith('publicTrade') && data.data?.length) {
      for (const t of data.data) {
        const symbol = t.s;
        handleTrade(symbol, t);
        const isBuyerMaker = t.S === 'Sell';
        const vol = parseFloat(t.v);
        const price = parseFloat(t.p);
        const notional = vol * price;
        const delta = isBuyerMaker ? -notional : +notional;

        const prev = cvdCurrent.get(symbol) ?? 0;
        cvdCurrent.set(symbol, prev + delta);

        // сохраняем снапшот каждую минуту (или при каждом твоём снапшоте)
        const now = Date.now();
        if (!cvdSnapshot.has(symbol)) cvdSnapshot.set(symbol, []);
        const snaps = cvdSnapshot.get(symbol)!;
        if (snaps.length === 0 || now - snaps[snaps.length - 1]!.time >= 10_000) {
          snaps.push({ time: now, value: prev + delta });
          if (snaps.length > 100) snaps.shift();
        }
      }
    }
  });
}

export function getCurrentCVD(symbol: string) {
  return cvdCurrent.get(symbol) ?? 0;
}

export function getCVDLastMinutes(symbol: string, minutes: number) {
  const snaps = cvdSnapshot.get(symbol) || [];
  const cutoff = Date.now() - minutes * 60_000;
  const recent = snaps.filter(s => s.time >= cutoff);
  if (recent.length < 2) return 0;

  return recent[recent.length - 1]!.value - recent[0]!.value;
}
