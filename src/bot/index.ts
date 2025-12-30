/* ===============================
   GLOBAL GUARDS & SHUTDOWN
   =============================== */
dotenv.config();
import * as fs from 'node:fs';

let isShuttingDown = false;
let stopWatchers: (() => void) | null = null;

const subscribers = new Set<number>();
const activeTimestamps = new Map<number, number>();

const g = global as any;
if (g.__BOT_STARTED__) {
  console.log('Bot already started, skipping');
  process.exit(0);
}
g.__BOT_STARTED__ = true;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`🛑 Shutdown (${signal})`);

  stopWatchers?.();
  stopWatchers = null;

  try {
    await bot.stop();
  } catch (err) {
    console.error('Bot shutdown error:', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(console.error);
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(console.error);
});

process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', reason => {
  console.error('UNHANDLED REJECTION:', reason);
});

/* ===============================
   IMPORTS & ENV
   =============================== */

import { Bot, InputFile, Keyboard } from 'grammy';
import * as dotenv from 'dotenv';

import { bybitClient, getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
import { initializeMarketWatcher } from '../market/watcher.js';
import { COINS_COUNT, LOG_PATH } from '../market/constants.market.js';
import type { OrderParamsV5 } from 'bybit-api/lib/types/request/v5-trade.js';
import { tradingState } from '../core/tradingState.js';

const requiredEnvVars = ['BOT_TOKEN', 'BYBIT_API_KEY', 'BYBIT_SECRET_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length) {
  console.error('Missing env vars:', missingVars.join(', '));
  process.exit(1);
}

/* ===============================
   BOT INIT
   =============================== */

const bot = new Bot(process.env.BOT_TOKEN!);

/* ===============================
   KEYBOARD
   =============================== */

const mainKeyboard = new Keyboard()
  .text('/start')
  .text('/market')
  .row()
  .text('/status')
  .text('/stop')
  .text('/download_logs')
  .row()
  // .text('/openPosition')
  // .text('/closePosition')
  .resized();

/* ===============================
   WATCHERS
   =============================== */

async function startWatchersOnce() {
  if (stopWatchers) {
    console.log('✅ Watchers already running');
    return;
  }

  stopWatchers = await initializeMarketWatcher(async msg => {
    for (const chatId of subscribers) {
      try {
        await bot.api.sendMessage(chatId, msg, {
          parse_mode: 'Markdown',
        });
      } catch (e) {
        console.error('Send failed:', chatId, e);
      }
    }
  });

  console.log('🚀 Market watchers started');
}

/* ===============================
   COMMANDS
   =============================== */

const welcomeMsg =
  `🚀 *Market Bot Started*\n\n` +
  `📊 Tracking top ${COINS_COUNT} liquid coins\n` +
  `🔄 Updates every minute\n` +
  `🔔 Signals for market structure`;

bot.command('start', async ctx => {
  subscribers.add(ctx.chat.id);
  tradingState.enable();
  await startWatchersOnce();
  console.log(`➕ Subscribed chat ${ctx.chat.id}`);
  await ctx.reply(welcomeMsg, {
    parse_mode: 'Markdown',
    reply_markup: mainKeyboard,
  });
});

// bot.command('openPosition', async ctx => {
//   // Send initial response
//   const loadingMsg = await ctx.reply('🔄 Placing order...');
//
//   try {
//     // First, get the current position mode
//     const positionMode = await bybitClient.getPositionInfo({
//       category: 'linear',
//       symbol: 'ETHUSDT',
//     });
//
//     const isHedgeMode = positionMode.result?.list?.[0]?.tradeMode === 1; // 0 for one-way, 1 for hedge mode
//
//     console.log('positionMode: ', positionMode, isHedgeMode);
//
//     const side = {
//       Buy: 'Buy',
//       Sell: 'Sell',
//     };
//
//     // Prepare order parameters
//     const orderParams = {
//       category: 'linear',
//       symbol: 'ETHUSDT',
//       side: 'Buy',
//       orderType: 'Limit',
//       price: '2986.1',
//       timeInForce: 'GTC',
//       qty: '0.05',
//       positionIdx: 0,
//       reduceOnly: false,
//       stopLoss: '2969.44',
//       takeProfit: '3002.77',
//       slTriggerBy: 'LastPrice',
//     } as OrderParamsV5;
//
//     const order = await bybitClient.submitOrder(orderParams);
//
//     console.log('Order response:', JSON.stringify(order, null, 2));
//
//     if (order.retCode !== 0) {
//       const errorMsg = `❌ Error [${order.retCode}]: ${order.retMsg}`;
//       console.error(errorMsg);
//       await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, errorMsg);
//       return;
//     }
//
//     // If we get here, the order was successful
//     const successMsg = `✅ Order placed successfully!\n` + `Order ID: ${order.result.orderId}`;
//
//     await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, successMsg);
//   } catch (error) {
//     console.error('Error in open-position command:', error);
//     const errorMsg = '❌ Failed to place order. Please try again later.';
//
//     if (loadingMsg) {
//       await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, errorMsg);
//     } else {
//       await ctx.reply(errorMsg);
//     }
//   }
// });

// bot.command('closePosition', async ctx => {
//   const symbol = 'ETHUSDT';
//   try {
//     const positionMode = await bybitClient.getPositionInfo({
//       category: 'linear',
//       symbol,
//     });
//
//     console.log('positionMode: ', JSON.stringify(positionMode));
//
//     const position = positionMode.result.list.find(p => Math.abs(Number(p.size)) > 0);
//
//     console.log('position: ', JSON.stringify(position));
//
//     const size = position!.size; // Используем строку напрямую из API
//     const side = position!.side === 'Buy' ? 'Sell' : 'Buy';
//
//     const response = await bybitClient.submitOrder({
//       category: 'linear',
//       symbol,
//       side,
//       orderType: 'Market',
//       qty: size,
//       reduceOnly: true,
//     });
//   } catch (error) {
//     console.error('Error sending log file:', error);
//     await ctx.reply('❌ Error sending log file');
//   }
// });

bot.command('download_logs', async ctx => {
  try {
    await ctx.replyWithDocument(new InputFile(fs.createReadStream(LOG_PATH), 'bot.log'));
  } catch (error) {
    console.error('Error sending log file:', error);
    await ctx.reply('❌ Error sending log file');
  }
});

bot.command('stop', async ctx => {
  subscribers.delete(ctx.chat.id);
  console.log(`➖ Unsubscribed chat ${ctx.chat.id}`);
  tradingState.disable();
  // 🔴 ОСТАНАВЛИВАЕМ ВОТЧЕРЫ
  if (stopWatchers) {
    stopWatchers();
    stopWatchers = null;
  }

  console.log(`🛑 BOT STOPPED by chat ${ctx.chat.id}`);

  await ctx.reply(
    '🛑 Бот остановлен\n\n' +
      '• торговля выключена\n' +
      '• вотчеры остановлены\n' +
      '• новые сделки не открываются',
    { reply_markup: mainKeyboard }
  );
});

bot.command('status', ctx => {
  const status =
    `👥 Subscribers: ${subscribers.size}\n` +
    `📊 Watching ${COINS_COUNT} coins\n` +
    `🔄 Updates every minute`;
  ctx.reply(status).then();
});

bot.command('market', async ctx => {
  const loadingMsg = await ctx.reply('🔄 Loading market data...');

  try {
    const symbols = await getTopLiquidSymbols(COINS_COUNT);

    const marketData = await Promise.all(
      symbols.map(async symbol => {
        const snap = await getMarketSnapshot(symbol);
        return {
          symbol,
          price: snap.price,
          oi: snap.openInterest,
          volume: snap.volume24h,
          funding: snap.fundingRate,
        };
      })
    );

    marketData.sort((a, b) => b.volume - a.volume);

    const message =
      `📊 *Market Overview*\n\n` +
      marketData
        .map(coin => {
          const price = Number(coin.price).toFixed(coin.price < 1 ? 6 : 2);
          const oi = (coin.oi / 1_000_000).toFixed(1);
          const volume = (coin.volume / 1_000_000).toFixed(1);
          const funding = (coin.funding * 100).toFixed(4);

          let fundingStr =
            coin.funding > 0.0005
              ? `🟢 ${funding}%`
              : coin.funding < -0.0005
                ? `🔴 ${funding}%`
                : `⚪ ${funding}%`;

          return `*${coin.symbol}*
Price: $${price}
OI: ${oi}M | Vol: ${volume}M
FR: ${fundingStr}`;
        })
        .join('\n\n');

    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, message, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error(e);
    await ctx.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      '❌ Error fetching market data'
    );
  }
});

/* ===============================
   FALLBACK & START
   =============================== */

// Update timestamp on any message
bot.use(async (ctx, next) => {
  if (ctx.chat) {
    activeTimestamps.set(ctx.chat.id, Date.now());
  }
  await next();
});

bot.on('message:text', async ctx => {
  await ctx.reply('👇 Use buttons below', { reply_markup: mainKeyboard });
});

bot.catch(err => console.error('Bot error:', err));

console.log('🚀 Starting bot...');
bot
  .start({
    onStart: async info => {
      console.log(`🤖 Bot @${info.username} is running!`);
    },
  })
  .then();
