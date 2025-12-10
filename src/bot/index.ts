/* ===============================
   GLOBAL GUARDS & SHUTDOWN
   =============================== */

let isShuttingDown = false;
let stopWatchers: (() => void) | null = null;

// Track active subscribers and their last activity time
const subscribers = new Set<number>();
const activeTimestamps = new Map<number, number>();

// Clean up inactive subscribers every hour
// const cleanupInterval = setInterval(
//   () => {
//     const now = Date.now();
//     const dayInMs = 24 * 60 * 60 * 1000;
//
//     for (const chatId of subscribers) {
//       const lastActive = activeTimestamps.get(chatId) || 0;
//       if (now - lastActive > dayInMs) {
//         console.log(`👋 Removing inactive chat: ${chatId}`);
//         subscribers.delete(chatId);
//         activeTimestamps.delete(chatId);
//       }
//     }
//   },
//   60 * 60 * 1000
//);

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

import { Bot } from 'grammy';
import * as dotenv from 'dotenv';

import { getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
import { getSnapshots } from '../market/snapshotStore.js';
import { compareSnapshots, formatCompareSnapshots } from '../market/compare.js';
import { initializeMarketWatcher } from '../market/watcher.js';
import { COINS_COUNT } from '../market/constants.market.js';

dotenv.config();

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
   SUBSCRIPTIONS
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
  `🔔 Alerts for significant market movements`;

bot.command('start', async ctx => {
  subscribers.add(ctx.chat.id);
  console.log(`➕ Subscribed chat ${ctx.chat.id}`);
  await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
});

bot.command('stop', async ctx => {
  subscribers.delete(ctx.chat.id);
  console.log(`➖ Unsubscribed chat ${ctx.chat.id}`);

  await ctx.reply('🛑 Notifications stopped');
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

bot.command('delta', async ctx => {
  try {
    const [, symbolArg] = ctx.message?.text?.split(' ') || [];
    const symbol = symbolArg?.toUpperCase() || (await getTopLiquidSymbols(1))[0];

    const loadingMsg = await ctx.reply(`⏳ Analyzing ${symbol}...`);
    const snaps = getSnapshots(symbol!);

    if (snaps.length < 2) {
      return ctx.reply(`Not enough data for ${symbol}`);
    }

    const delta = compareSnapshots(snaps.at(-1)!, snaps[0]!);
    const formatted = formatCompareSnapshots(delta, symbol!);

    await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, formatted, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Error');
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
  await ctx.reply('🤖 Use /market or /delta');
});

bot.catch(err => console.error('Bot error:', err));

console.log('🚀 Starting bot...');
bot
  .start({
    onStart: async info => {
      console.log(`🤖 Bot @${info.username} is running!`);
      await startWatchersOnce();
    },
  })
  .then();
