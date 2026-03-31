/* ===============================
   GLOBAL GUARDS & SHUTDOWN
   =============================== */
dotenv.config();
import * as fs from 'node:fs';
import * as http from 'node:http';
import path from 'node:path';

let isShuttingDown = false;
let stopWatchers: (() => void) | null = null;
let healthServer: http.Server | null = null;
let keepAliveIntervalId: ReturnType<typeof setInterval> | null = null;

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
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
  if (healthServer) {
    healthServer.close();
    healthServer = null;
  }
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
import dayjs from 'dayjs';

import { getClosedPnLStats, getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
import { initializeMarketWatcher } from '../market/watcher.js';
import { COINS_COUNT, LOG_PATH } from '../market/constants.market.js';
import { tradingState } from '../core/tradingState.js';
import { getDailyPnlUsd, getDailyLossLimitUsd } from '../core/dailyLossLimit.js';
import { SYMBOL_HISTORY_FILES } from '../market/snapshotStore.js';

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

// Health check для Koyeb: любой входящий HTTP = "трафик", иначе инстанс уходит в deep sleep
const PORT = Number(process.env.PORT) || 8000;
healthServer = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(PORT, () => {
  console.log(`Health check on :${PORT} (GET / or /health)`);
});

// Self-ping: раз в ~8 мин дергаем свой публичный URL, чтобы Koyeb видел трафик и не уводил инстанс в deep sleep (без сторонних сервисов)
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL?.trim();
if (APP_PUBLIC_URL) {
  debugger;
  const KEEP_ALIVE_MS = 1 * 60 * 1000; // 8 минут
  keepAliveIntervalId = setInterval(() => {
    fetch(APP_PUBLIC_URL, { method: 'GET' }).catch(() => {
      // игнорируем ошибки (сеть, таймаут) — следующий пинг через 8 мин
    });
  }, KEEP_ALIVE_MS);
  console.log(`Keep-alive: self-ping every ${KEEP_ALIVE_MS / 60000} min → ${APP_PUBLIC_URL}`);
}

/* ===============================
   KEYBOARD
   =============================== */

const mainKeyboard = new Keyboard()
  .text('/start')
  .text('/market')
  .row()
  .text('/status')
  .text('/stats')
  .text('/stop')
  .text('/close_only')
  .row()
  .text('/download_logs')
  .text('/download_snapshots')
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

  const entryMode = process.env.ENTRY_MODE === 'classic' ? 'classic' : 'adaptive';
  if (entryMode === 'adaptive') {
    console.log('📊 Entry mode: adaptive (Bollinger 1h, как в бэктесте)');
    const { STRATEGY_CONFIG } = await import('../config/strategyConfig.js');
    const { shortOnly, longAndShortSymbols } = STRATEGY_CONFIG.adaptiveBollinger as {
      shortOnly?: boolean;
      longAndShortSymbols?: readonly string[];
    };
    if (shortOnly && longAndShortSymbols?.length) {
      console.log(`📉 Short-only для альтов; лонг+шорт: ${longAndShortSymbols.join(', ')}`);
    } else if (STRATEGY_CONFIG.adaptiveBollinger.shortOnly) {
      console.log('📉 Short-only: только SHORT');
    }
  }
  const limitUsd = getDailyLossLimitUsd();
  stopWatchers = await initializeMarketWatcher(
    async msg => {
      if (subscribers.size === 0) {
        console.warn('Alert not sent: no subscribers (send /start to subscribe)');
        return;
      }
      for (const chatId of subscribers) {
        try {
          await bot.api.sendMessage(chatId, msg, {
            parse_mode: 'Markdown',
          });
        } catch (e) {
          console.error('Send failed:', chatId, e);
        }
      }
    },
    {
      entryMode,
      onDailyLossLimitReached: async () => {
        tradingState.disable();
        const dailyPnl = getDailyPnlUsd();
        const alertMsg =
          `🛑 *Бот выключен: достигнут лимит проигрыша (−${limitUsd}$ за день).*\n\n` +
          `Дневной PnL: *${dailyPnl.toFixed(2)}$*\n\n` +
          `Новые сделки не открываются. Открытые позиции *остаются* — будут закрыты по MEAN или стоп-лоссу как обычно.\n\n` +
          `Включить снова: /start`;
        if (subscribers.size > 0) {
          for (const chatId of subscribers) {
            try {
              await bot.api.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
            } catch (e) {
              console.error('Daily loss limit alert failed:', chatId, e);
            }
          }
        }
        console.log('[TRADING] Disabled due to daily loss limit');
      },
    }
  );

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

bot.command('download_snapshots', async ctx => {
  const files = Object.entries(SYMBOL_HISTORY_FILES);
  if (!files.length) {
    await ctx.reply('❌ Нет доступных снапшотов');
    return;
  }

  try {
    await ctx.reply('📦 Отправляю файлы со снапшотами (BTC/ETH/SOL)...');
    for (const [symbol, filePath] of files) {
      if (!fs.existsSync(filePath)) {
        await ctx.reply(`⚠️ Файл для ${symbol} пока не создан`);
        continue;
      }
      const fileName = path.basename(filePath);
      await ctx.replyWithDocument(new InputFile(fs.createReadStream(filePath), fileName), {
        caption: `📊 История снапшотов ${symbol}`,
      });
    }
  } catch (error) {
    console.error('Error sending snapshot files:', error);
    await ctx.reply('❌ Не удалось отправить снапшоты');
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

bot.command('close_only', async ctx => {
  tradingState.setCloseOnlyMode(true);
  console.log(`📴 Close-only mode ON by chat ${ctx.chat.id}`);

  await ctx.reply(
    '📴 *Режим «только закрытие» включён*\n\n' +
      '• Новые сделки *не открываются*\n' +
      '• Текущие позиции продолжают закрываться по стратегии Болинжера (и по стопам)\n' +
      '• Вотчеры работают как обычно\n\n' +
      'Чтобы снова открывать сделки: /start',
    { parse_mode: 'Markdown', reply_markup: mainKeyboard }
  );
});

bot.command('status', ctx => {
  const closeOnly = tradingState.isCloseOnlyMode();
  const status =
    `👥 Subscribers: ${subscribers.size}\n` +
    `📊 Watching ${COINS_COUNT} coins\n` +
    `🔄 Updates every minute\n` +
    (closeOnly ? `\n📴 Режим «только закрытие»: новые сделки не открываются` : '');
  ctx.reply(status).then();
});

bot.command('stats', async ctx => {
  const loadingMsg = await ctx.reply('🔄 Loading stats...');

  try {
    // Опционально: /stats 2026-02 — статистика за месяц для сравнения с бэктестом
    const text = ctx.message?.text?.trim() ?? '';
    const monthMatch = text.match(/\/stats\s+(\d{4})-(\d{2})/);
    let start: dayjs.Dayjs;
    let end: dayjs.Dayjs;
    if (monthMatch) {
      const [, y, m] = monthMatch;
      start = dayjs(`${y}-${m}-01`).startOf('day');
      end = dayjs(`${y}-${m}-01`).endOf('month');
    } else {
      start = dayjs(new Date(2026, 0, 29, 0, 0, 0, 0));
      end = dayjs();
    }
    const startTime = start.valueOf();
    const endTime = end.valueOf();

    const stats = await getClosedPnLStats({ startTime, endTime, category: 'linear' });

    const winrate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;

    const topSymbols = stats.bySymbol;
    const symbolsLines = topSymbols.length
      ? topSymbols
          .map(s => {
            const pnl = s.pnlTotalUsd;
            const sign = pnl > 0 ? '+' : '';
            return `- \`${s.symbol}\`: ${s.trades} | PnL ${sign}${pnl.toFixed(2)}$`;
          })
          .join('\n')
      : '- (нет данных)';

    const pnlNet = stats.pnlTotalUsd;
    const pnlNetSign = pnlNet > 0 ? '+' : '';
    const earned = stats.pnlWinUsd;
    const lost = Math.abs(stats.pnlLossUsd);

    const msg =
      `📈 *Статистика сделок*\n` +
      `Период: *${start.format('DD.MM.YYYY')} → ${end.format('DD.MM.YYYY')}*\n\n` +
      `Сделок: *${stats.trades}*\n` +
      `Winrate: *${winrate.toFixed(2)}%* (W:${stats.wins} / L:${stats.losses})\n\n` +
      `Заработано: *+${earned.toFixed(2)}$*\n` +
      `Проёбано: *-${lost.toFixed(2)}$*\n` +
      `Итого (Net): *${pnlNetSign}${pnlNet.toFixed(2)}$*\n\n` +
      `Монеты (все торгуемые ${topSymbols.length} по |PnL|):\n${symbolsLines}`;

    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, msg, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error(e);
    const retCode = (e as any)?.bybitRetCode;
    const errMsg =
      retCode === 33004
        ? '❌ API ключ ByBit истёк. Создайте новый ключ в настройках ByBit и обновите конфигурацию бота.'
        : '❌ Ошибка получения статистики (проверьте API ключи / права доступа)';
    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, errMsg);
  }
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
