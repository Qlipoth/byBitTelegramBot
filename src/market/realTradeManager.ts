// Локальное хранилище для активных позиций (синхронизация с биржей)
import { calculatePositionSizing } from './paperPositionManager.js';
import { roundStep } from './utils.js';
import { bybitClient } from '../services/bybit.js';
import { tradingState } from '../core/tradingState.js';
import type { CancelOrderParams } from './types.js';

export interface ActivePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  entryTime: number;
}

interface PendingOrder {
  symbol: string;
  side: 'LONG' | 'SHORT';
  orderId: string | undefined;
  orderLinkId: string;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: number;
}

export class RealTradeManager {
  private readonly activePositions = new Map<string, ActivePosition>();
  private readonly pendingOrders = new Map<string, PendingOrder>();

  // Комиссия (Taker + Taker)
  private readonly TOTAL_FEE_PCT = 0.0011;
  private readonly RR_RATIO = 3;
  private readonly SLIPPAGE_TOLERANCE = 0.002; // 0.2% защиты

  hasPosition(symbol: string) {
    return this.activePositions.has(symbol);
  }

  hasPending(symbol: string) {
    return this.pendingOrders.has(symbol);
  }

  hasExposure(symbol: string) {
    return this.hasPosition(symbol) || this.hasPending(symbol);
  }

  getPosition(symbol: string) {
    return this.activePositions.get(symbol);
  }

  getPending(symbol: string) {
    return this.pendingOrders.get(symbol);
  }

  private async sleep(ms: number) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateOrderLinkId(symbol: string) {
    return `bot_${symbol}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  async syncSymbol(symbol: string) {
    const pending = this.pendingOrders.get(symbol);
    if (!pending) return;

    const posResp = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol,
    });

    const position = posResp.result.list.find(p => Math.abs(Number(p.size)) > 0);
    if (position) {
      const size = Math.abs(Number(position.size));
      const avgPrice = Number((position as any).avgPrice || (position as any).entryPrice || 0);
      const entryPrice = avgPrice > 0 ? avgPrice : NaN;

      if (Number.isFinite(entryPrice)) {
        this.activePositions.set(symbol, {
          symbol,
          side: pending.side,
          entryPrice,
          stopLoss: pending.stopLoss,
          takeProfit: pending.takeProfit,
          qty: size,
          entryTime: Date.now(),
        });
        this.pendingOrders.delete(symbol);
      }

      return;
    }

    type ActiveOrdersParams = Parameters<typeof bybitClient.getActiveOrders>[0];
    const activeParams = {
      category: 'linear',
      symbol,
      orderLinkId: pending.orderLinkId,
      ...(pending.orderId ? { orderId: pending.orderId } : {}),
    } satisfies ActiveOrdersParams;

    type HistoricOrdersParams = Parameters<typeof bybitClient.getHistoricOrders>[0];
    const historicParams = {
      category: 'linear',
      symbol,
      orderLinkId: pending.orderLinkId,
      ...(pending.orderId ? { orderId: pending.orderId } : {}),
    } satisfies HistoricOrdersParams;

    const [active, historic] = await Promise.all([
      bybitClient.getActiveOrders(activeParams),
      bybitClient.getHistoricOrders(historicParams),
    ]);

    const activeOrder = active.result?.list?.[0];
    if (activeOrder) return;

    const histOrder = historic.result?.list?.[0];
    if (!histOrder) return;

    const status = String(histOrder.orderStatus || '').toLowerCase();
    if (status.includes('cancel') || status.includes('reject')) {
      this.pendingOrders.delete(symbol);
      return;
    }
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

      if (this.hasExposure(symbol)) {
        console.log(`⚠️ [${symbol}] Уже есть позиция или ожидающий ордер`);
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

      const orderLinkId = this.generateOrderLinkId(symbol);

      // 4. ОТПРАВКА ОРДЕРА НА БИРЖУ
      const order = await bybitClient.submitOrder({
        category: 'linear',
        symbol,
        side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        price: roundStep(limitPrice, tickSize).toString(),
        qty: qty.toString(),
        timeInForce: 'GTC',
        orderLinkId,
        stopLoss: roundStep(stopPrice, tickSize).toString(),
        takeProfit: roundStep(tpPrice, tickSize).toString(),
        slTriggerBy: 'LastPrice',
      });

      if (order.retCode !== 0) {
        console.log(`❌ Ошибка биржи [${order.retCode}]: ${order.retMsg}`);
        return false;
      }

      const orderId = order.result?.orderId;

      this.pendingOrders.set(symbol, {
        symbol,
        side,
        orderId,
        orderLinkId,
        qty,
        stopLoss: stopPrice,
        takeProfit: tpPrice,
        createdAt: Date.now(),
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await this.syncSymbol(symbol);
        } catch (e) {
          console.error(`❌ [${symbol}] syncSymbol error:`, e);
        }

        if (this.activePositions.has(symbol)) {
          const pos = this.activePositions.get(symbol)!;
          console.log(
            `✅ [${symbol}] Позиция подтверждена биржей. entry=${pos.entryPrice} qty=${pos.qty}`
          );
          return true;
        }

        if (!this.pendingOrders.has(symbol)) {
          return false;
        }

        await this.sleep(500);
      }

      const stillPending = this.pendingOrders.get(symbol);
      if (stillPending) {
        try {
          type CancelOrderParams = Parameters<typeof bybitClient.cancelOrder>[0];
          const cancelParams = {
            category: 'linear',
            symbol,
            orderLinkId: stillPending.orderLinkId,
            ...(stillPending.orderId ? { orderId: stillPending.orderId } : {}),
          } satisfies CancelOrderParams;

          await bybitClient.cancelOrder(cancelParams);
        } catch (e) {
          console.error(`❌ [${symbol}] cancelOrder error:`, e);
        } finally {
          this.pendingOrders.delete(symbol);
        }
      }

      return false;
    } catch (e) {
      console.error(`❌ Ошибка openPosition:`, e);
      this.pendingOrders.delete(symbol);
      return false;
    }
  }

  // ==========================================
  // 🏁 ЗАКРЫТИЕ ПОЗИЦИИ (MARKET + REDUCE ONLY)
  // ==========================================
  async closePosition(symbol: string) {
    try {
      const pending = this.pendingOrders.get(symbol);
      if (pending) {
        try {
          const cancelParams = {
            category: 'linear',
            symbol,
            orderLinkId: pending.orderLinkId,
            ...(pending.orderId ? { orderId: pending.orderId } : {}),
          } satisfies CancelOrderParams;

          await bybitClient.cancelOrder(cancelParams);
        } catch (e) {
          console.error(`❌ [${symbol}] cancelOrder error:`, e);
        } finally {
          this.pendingOrders.delete(symbol);
        }
      }

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
