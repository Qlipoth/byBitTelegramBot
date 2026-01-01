// Локальное хранилище для активных позиций (синхронизация с биржей)
import { calculatePositionSizing } from './paperPositionManager.js';
import { roundStep } from './utils.js';
import { bybitClient } from '../services/bybit.js';
import { tradingState } from '../core/tradingState.js';

export interface ActivePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  entryTime: number;
}

export class RealTradeManager {
  private readonly activePositions = new Map<string, ActivePosition>();

  // Комиссия (Taker + Taker)
  private readonly TOTAL_FEE_PCT = 0.0011;
  private readonly RR_RATIO = 3;
  private readonly SLIPPAGE_TOLERANCE = 0.002; // 0.2% защиты

  hasPosition(symbol: string) {
    return this.activePositions.has(symbol);
  }

  getPosition(symbol: string) {
    return this.activePositions.get(symbol);
  }

  // ==========================================
  // 🚀 ОТКРЫТИЕ ПОЗИЦИИ (LIMIT + GTC)
  // ==========================================
  async openPosition(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    price: number; // Цена из снапшота (текущая)
    stopPrice: number;
    balance: number;
  }) {
    const { symbol, side, price, stopPrice, balance } = params;

    if (!tradingState.isEnabled()) {
      console.warn('[EXECUTION] Trading disabled');
      return false;
    }

    // 1. Считаем риск и объем (твоя функция)
    const sizing = calculatePositionSizing(balance, price, stopPrice);
    if (!sizing) {
      console.log('❌ Не расчитан размер позиции', sizing);
      return false;
    }

    try {
      // 2. Получаем спецификации монеты (округления)
      const instrInfo = await bybitClient.getInstrumentsInfo({ category: 'linear', symbol });
      const instrument = instrInfo.result.list[0];
      if (!instrument) {
        console.log('Не получен инструмент');
        return false;
      }
      const tickSize = parseFloat(instrument.priceFilter.tickSize);
      const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);

      // 3. Расчет параметров ордера
      const qty = roundStep(sizing.sizeUsd / price, qtyStep);
      if (qty <= 0) {
        console.log('❌ Ошибка расчета ордера', qty);
        return false;
      }

      // Защитный лимит (чуть хуже рынка)
      const limitPrice =
        side === 'LONG'
          ? price * (1 + this.SLIPPAGE_TOLERANCE)
          : price * (1 - this.SLIPPAGE_TOLERANCE);

      // Тейк-профит (от цены лимита)
      const takePct = sizing.stopPct * this.RR_RATIO + this.TOTAL_FEE_PCT;
      const tpPrice = side === 'LONG' ? price * (1 + takePct) : price * (1 - takePct);

      // 4. ОТПРАВКА ОРДЕРА НА БИРЖУ
      const order = await bybitClient.submitOrder({
        category: 'linear',
        symbol,
        side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        price: roundStep(limitPrice, tickSize).toString(),
        qty: qty.toString(),
        timeInForce: 'GTC',
        stopLoss: roundStep(stopPrice, tickSize).toString(),
        takeProfit: roundStep(tpPrice, tickSize).toString(),
        slTriggerBy: 'LastPrice',
      });

      if (order.retCode !== 0) {
        console.log(`❌ Ошибка биржи [${order.retCode}]: ${order.retMsg}`);
        return false;
      }

      const entryPrice = limitPrice;

      this.activePositions.set(symbol, {
        symbol,
        side,
        entryPrice: entryPrice,
        stopLoss: stopPrice,
        takeProfit: tpPrice,
        qty: qty,
        entryTime: Date.now(),
      });

      console.log(`✅ [${symbol}] Ожидаем исполнение по цене ${entryPrice}. Записано в память.`);
      return true;
    } catch (e) {
      console.error(`❌ Ошибка openPosition:`, e);
      return false;
    }
  }

  // ==========================================
  // 🏁 ЗАКРЫТИЕ ПОЗИЦИИ (MARKET + REDUCE ONLY)
  // ==========================================
  async closePosition(symbol: string) {
    try {
      const posResp = await bybitClient.getPositionInfo({
        category: 'linear',
        symbol,
      });

      const position = posResp.result.list.find(p => Math.abs(Number(p.size)) > 0);

      // Если на бирже пусто — чистим локально и выходим
      if (!position) {
        console.warn(`⚠️ [${symbol}] На бирже позиции нет. Синхронизируем локальный стейт.`);
        this.activePositions.delete(symbol);
        return;
      }

      const size = position.size;
      const side = position.side === 'Buy' ? 'Sell' : 'Buy';

      const response = await bybitClient.submitOrder({
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: size,
        reduceOnly: true,
      });

      if (response.retCode === 0) {
        this.activePositions.delete(symbol);
        console.log(`🏁 [${symbol}] Позиция успешно закрыта на бирже. Объем: ${size}`);
      } else {
        console.error(
          `❌ [${symbol}] Биржа отклонила закрытие! Код: ${response.retCode}, Инфо: ${response.retMsg}`
        );
      }
    } catch (e) {
      console.error(`❌ Критическая ошибка при закрытии ${symbol}:`, e);
    }
  }
}

export const realTradeManager = new RealTradeManager();
