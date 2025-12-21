// Локальное хранилище для активных позиций (синхронизация с биржей)
import { calculatePositionSizing } from './paperPositionManager.js';
import { roundStep } from './utils.js';
import { bybitClient } from '../services/bybit.js';

interface ActivePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  entryTime: number;
}

export const activePositions = new Map<string, ActivePosition>();

// Комиссия (Taker + Taker)
const TOTAL_FEE_PCT = 0.0011;
const RR_RATIO = 3;

// ==========================================
// 🚀 ОТКРЫТИЕ ПОЗИЦИИ (LIMIT + IOC)
// ==========================================
export async function openRealPosition(params: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  price: number; // Цена из снапшота (текущая)
  stopPrice: number;
  balance: number;
}) {
  const { symbol, side, price, stopPrice, balance } = params;
  const SLIPPAGE_TOLERANCE = 0.002; // 0.2% защиты

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
      side === 'LONG' ? price * (1 + SLIPPAGE_TOLERANCE) : price * (1 - SLIPPAGE_TOLERANCE);

    // Тейк-профит (от цены лимита)
    const takePct = sizing.stopPct * RR_RATIO + TOTAL_FEE_PCT;
    const tpPrice = side === 'LONG' ? price * (1 + takePct) : price * (1 - takePct);

    // 4. ОТПРАВКА ОРДЕРА НА БИРЖУ
    const order = await bybitClient.submitOrder({
      category: 'linear',
      symbol,
      side: side === 'LONG' ? 'Buy' : 'Sell',
      orderType: 'Limit',
      price: roundStep(limitPrice, tickSize).toString(),
      qty: qty.toString(),
      timeInForce: 'IOC', // IOC - либо сейчас по этой цене, либо отмена
      stopLoss: roundStep(stopPrice, tickSize).toString(),
      takeProfit: roundStep(tpPrice, tickSize).toString(),
      slTriggerBy: 'LastPrice',
    });

    // 5. ПРОВЕРКА ИСПОЛНЕНИЯ

    if (order.retCode !== 0) {
      // Если код НЕ 0, значит случилась беда
      console.log(`❌ Ошибка биржи [${order.retCode}]: ${order.retMsg}`);
      return false; // Выходим из функции, так как ордера нет
    }

    // Запрашиваем историю этого конкретного ордера
    const history = await bybitClient.getHistoricOrders({
      category: 'linear',
      symbol,
      orderId: order.result.orderId,
    });

    const orderData = history.result.list[0];

    if (!orderData) {
      console.log('❌ Ошибка получения истории', orderData);
      return false;
    }
    const execQty = parseFloat(orderData.cumExecQty || '0');
    const execValue = parseFloat(orderData.cumExecValue || '0');

    const avgPrice = execValue / execQty;

    // СОХРАНЯЕМ В ЛОКАЛЬНУЮ ПАМЯТЬ
    activePositions.set(symbol, {
      symbol,
      side,
      entryPrice: avgPrice,
      stopLoss: stopPrice,
      takeProfit: tpPrice,
      qty: execQty,
      entryTime: Date.now(),
    });

    console.log(`✅ [${symbol}] REAL POSITION OPENED at ${avgPrice}`);
    return true;
  } catch (e) {
    console.error(`❌ Ошибка openRealPosition:`, e);
    return false;
  }
}

// ==========================================
// 🏁 ЗАКРЫТИЕ ПОЗИЦИИ (MARKET + REDUCE ONLY)
// ==========================================
export async function closeRealPosition(symbol: string) {
  try {
    const posResp = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol,
    });

    const position = posResp.result.list.find(p => Math.abs(Number(p.size)) > 0);

    // Если на бирже пусто — чистим локально и выходим
    if (!position) {
      console.warn(`⚠️ [${symbol}] На бирже позиции нет. Синхронизируем локальный стейт.`);
      activePositions.delete(symbol);
      return;
    }

    const size = position.size; // Используем строку напрямую из API
    const side = position.side === 'Buy' ? 'Sell' : 'Buy';

    const response = await bybitClient.submitOrder({
      category: 'linear',
      symbol,
      side,
      orderType: 'Market',
      qty: size,
      reduceOnly: true,
    });

    // ПРОВЕРКА: Закрылось ли на самом деле?
    if (response.retCode === 0) {
      activePositions.delete(symbol);
      console.log(`🏁 [${symbol}] Позиция успешно закрыта на бирже. Объем: ${size}`);
    } else {
      // Если retCode не 0, значит позиция ВСЕ ЕЩЕ ОТКРЫТА
      console.error(
        `❌ [${symbol}] Биржа отклонила закрытие! Код: ${response.retCode}, Инфо: ${response.retMsg}`
      );
      // Мы НЕ удаляем из activePositions, чтобы Watcher попробовал еще раз или выдал алерт
    }
  } catch (e) {
    console.error(`❌ Критическая ошибка при закрытии ${symbol}:`, e);
    // В случае сетевой ошибки позиция остается в activePositions для повтора
  }
}
