process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
  console.error('constructor:', err?.constructor?.name);
  console.error('keys:', Object.keys(err || {}));
});

process.on('unhandledRejection', reason => {
  console.error('UNHANDLED REJECTION:', reason);
});

import { Bot } from 'grammy';
import * as dotenv from 'dotenv';
import { getMarketSnapshot, getTopLiquidSymbols } from '../services/bybit.js';
import { getSnapshots } from '../market/snapshotStore.js';
import { compareSnapshots, formatCompareSnapshots } from '../market/compare.js';
import { initializeMarketWatcher } from '../market/watcher.js';
import { COINS_COUNT } from '../market/constants.market.js';

// Load environment variables from .env file
dotenv.config();

// Check if required environment variables exist
const requiredEnvVars = ['BOT_TOKEN', 'BYBIT_API_KEY', 'BYBIT_SECRET_KEY'];
const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// ===========================================
// ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК (DIAGNOSTICS)
// ===========================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('*** UNHANDLED REJECTION ***');
  console.error('Promise:', promise);
  console.error('Reason (The Uncaught Object):', reason);
  // Выведите объект ошибки полностью, чтобы увидеть его содержимое
  console.dir(reason, { depth: null });
  // Вы можете закомментировать строку ниже, чтобы предотвратить завершение работы
  // process.exit(1);
});

process.on('uncaughtException', (err, origin) => {
  console.error('*** UNCAUGHT EXCEPTION ***');
  console.error('Error:', err);
  console.error('Origin:', origin);
  // process.exit(1);
});

// Initialize the bot
const bot = new Bot(process.env.BOT_TOKEN!);

const welcomeMsg =
  `🚀 *Market Bot Started*\n\n` +
  `📊 Tracking top 30 liquid coins\n` +
  `🔄 Updates every minute\n` +
  `🔔 Alerts for significant market movements`;

bot.command('start', async ctx => {
  try {
    // Initialize watchers for all symbols
    const stopWatchers = await initializeMarketWatcher(msg =>
      ctx.reply(msg, { parse_mode: 'Markdown' })
    );

    // Handle bot stop
    process.on('SIGINT', () => {
      stopWatchers();
      process.exit(0);
    });

    // Send welcome message with tracked symbols

    return ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Start command error:', error);
    return ctx.reply('❌ Failed to start market watchers. Please try again.');
  }
});

bot.command('market', async ctx => {
  // Send initial loading message
  const loadingMsg = await ctx.reply('🔄 Loading market data...', {
    parse_mode: 'Markdown',
  });

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

    // Sort by volume (descending)
    marketData.sort((a, b) => b.volume - a.volume);

    // Format the message with better alignment
    const message =
      `📊 *Market Overview*\n\n` +
      marketData
        .map(coin => {
          // Format numbers
          const price = Number(coin.price).toFixed(coin.price < 1 ? 6 : 2);
          const oi = (coin.oi / 1_000_000).toFixed(1);
          const volume = (coin.volume / 1_000_000).toFixed(1);
          const funding = (coin.funding * 100).toFixed(4);

          // Add color to funding rate
          let fundingStr;
          if (coin.funding > 0.0005) fundingStr = `🟢 ${funding}%`;
          else if (coin.funding < -0.0005) fundingStr = `🔴 ${funding}%`;
          else fundingStr = `⚪ ${funding}%`;

          return `*${coin.symbol}*
  Price: $${price}
  OI: ${oi}M  |  Vol: ${volume}M
  FR: ${fundingStr}`;
        })
        .join('\n\n');

    // Update the loading message with the actual data
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, message, {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('Error in /market command:', error);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      '❌ Error fetching market data. Please try again later.'
    );
  }
});

bot.command('delta', async ctx => {
  try {
    const [symbolArg] = ctx.message?.text?.split(' ') || [];
    const symbol = symbolArg?.toUpperCase() || (await getTopLiquidSymbols(1))[0];

    const loadingMsg = await ctx.reply(`⏳ Analyzing ${symbol}...`);
    const snaps = getSnapshots(symbol!);

    if (snaps.length < 2) {
      return ctx.reply(`Not enough data for ${symbol}. Try again in a minute.`);
    }

    const now = snaps[snaps.length - 1];
    const prev = snaps[0]; // Oldest snapshot

    const delta = compareSnapshots(now!, prev!);
    const formattedDelta = formatCompareSnapshots(delta, symbol!);

    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, formattedDelta, {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('Delta command error:', error);
    await ctx.reply('❌ Error analyzing market data. Please try again.');
  }
});

// Handle other text messages
bot.on('message:text', async ctx => {
  await ctx.reply(`🤖 I'm a market analysis bot! Use /market [symbol] to get market data.`);
});

// Error handling
bot.catch(error => {
  console.error('Bot error:', error);
});

// Start the bot
console.log('🚀 Starting bot...');
bot
  .start({
    onStart: botInfo => {
      console.log(`🤖 Bot @${botInfo.username} is running!`);
    },
  })
  .then();
