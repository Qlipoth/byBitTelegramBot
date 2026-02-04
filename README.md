# ByBit Market Bot

Telegram bot for **ByBit** that runs a **Bollinger Bands mean-reversion strategy** on linear perpetuals (e.g. BTCUSDT, ETHUSDT, SOLUSDT). It opens and closes positions automatically and sends entry/exit alerts to Telegram.

## Strategy

- **Logic:** Mean reversion using Bollinger Bands (20-period, 2.2 std) on **1h** candles.
- **Entry:** LONG when price is at or near the **lower band** (oversold); SHORT when price is at or near the **upper band** (overbought). Filters: RSI, EMA bias, band width (no entry in a tight squeeze), optional OI/trend context.
- **Exit:**  
  - **MEAN** — close when price reaches the **middle band** (target).  
  - **STOP** — catastrophic stop (e.g. −7% from entry) if price moves against the position before reaching the middle.
- **Max hold:** Configurable (e.g. 24h); beyond that the position is closed by time.

The bot can run in **adaptive** (Bollinger) or **classic** (trend/phase) entry mode; adaptive is the default and matches the backtests.

## Features

- Real-time monitoring of top liquid coins (configurable list).
- Bollinger-based mean-reversion entries and MEAN/STOP exits.
- Telegram alerts for position open and close (with PnL and reason).
- Optional: Price + Open Interest context (trend confirmation, Short cover / Long unwind).
- Health HTTP server for deployment (e.g. Koyeb) and optional self-ping via `APP_PUBLIC_URL`.
- **Backtests** for the same strategy on historical ByBit 5m candles.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Qlipoth/byBitTelegramBot.git
   cd byBitTelegramBot
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Create a `.env` file (see Configuration below).

## Configuration

Create a `.env` file in the project root:

```env
# Required
BOT_TOKEN=your_telegram_bot_token
BYBIT_API_KEY=your_bybit_api_key
BYBIT_SECRET_KEY=your_bybit_secret_key

# Optional
PORT=8000
ENTRY_MODE=adaptive
APP_PUBLIC_URL=https://your-app.koyeb.app
```

- **BOT_TOKEN** — from [@BotFather](https://t.me/BotFather).
- **BYBIT_API_KEY / BYBIT_SECRET_KEY** — ByBit API keys with trading (and optionally read) permissions for linear perpetuals.
- **PORT** — HTTP server port for health checks (default 8000).
- **ENTRY_MODE** — `adaptive` (Bollinger) or `classic`.
- **APP_PUBLIC_URL** — public URL of the app for self-ping keep-alive (e.g. Koyeb); no external pinger needed if set.

Strategy parameters (Bollinger period, bands, stop %, etc.) are in `src/config/strategyConfig.ts`.

## Usage

1. Start the bot:
   ```bash
   pnpm start
   ```

2. In Telegram, send `/start` to your bot to subscribe to alerts. The bot will run the strategy and send messages on position open and close.

## Telegram Commands

| Command | Description |
|--------|-------------|
| `/start` | Subscribe to alerts and start the watchers |
| `/stop` | Unsubscribe and stop watchers |
| `/market` | Current market overview (top symbols) |
| `/status` | Subscribers count and watcher status |
| `/stats [YYYY-MM]` | Closed PnL stats (optionally for a given month) |
| `/download_logs` | Download bot log file |
| `/download_snapshots` | Download snapshot history files |

## Backtests

The repository includes an **adaptive Bollinger backtest** that uses the same entry/exit logic on historical 5m candles from ByBit.

- **Script:** `src/backtest/adaptiveBollingerBacktest.ts`
- **Run (date range + symbol):**
  ```bash
  pnpx tsx src/backtest/adaptiveBollingerBacktest.ts <START_ISO> <END_ISO> <SYMBOL>
  ```
  Example (ETH, Jun 2025 – Feb 2026):
  ```bash
  pnpx tsx src/backtest/adaptiveBollingerBacktest.ts 2025-06-01 2026-02-01 ETHUSDT
  ```
- **Output:** Trade count, win rate, net PnL, max drawdown, exit reasons (MEAN/STOP), and per-month breakdown. Candles are cached under `cache/bybit/` to avoid re-downloading.

Other scripts in `package.json`:

- `pnpm run backtest:adaptive` — same backtest (pass args after `--` if needed).
- `pnpm run backtest:bot` — full bot-style backtest (see `src/backtest/botBacktester.ts`).

## Project Structure

```
src/
├── bot/
│   └── index.ts              # Telegram bot, commands, watcher startup, health server
├── config/
│   └── strategyConfig.ts    # Bollinger/adaptive and backtest parameters
├── market/
│   ├── adaptiveBollingerStrategy.ts  # Bollinger entry/exit logic
│   ├── analysis.ts           # Trend, phase, RSI, Price+OI
│   ├── constants.market.ts   # Intervals, thresholds, symbols
│   ├── fsm.ts                # Trade FSM, max position duration
│   ├── realTradeManager.ts   # ByBit order/position execution
│   ├── watcher.ts            # Per-symbol loop, tick, alerts
│   └── ...
├── backtest/
│   ├── adaptiveBollingerBacktest.ts  # Bollinger backtest runner
│   ├── candleLoader.ts       # ByBit kline fetch and cache
│   └── ...
└── services/
    └── bybit.ts              # ByBit API client
```

## Deployment (e.g. Koyeb)

On Koyeb **free tier**, the instance is put into deep sleep after ~1 hour with **no incoming HTTP traffic**. The bot already runs an HTTP server on `PORT` and responds to `GET /` and `GET /health` with `200 OK`.

- Set the service as a **Web Service** and use the assigned public URL.
- To avoid sleep, trigger **external pings** to that URL every 5–15 minutes (e.g. [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org)).
- Optionally set **APP_PUBLIC_URL** in the app so the bot can self-ping; on free tier, external ping is more reliable.

## Development

- `pnpm run typecheck` — TypeScript check
- `pnpm test` — Run tests (Vitest)
- `pnpm run build` — Build for production (e.g. `node dist/bot.js`)

All commands use **pnpm**; to run a binary (e.g. `tsx`) use **pnpx** (e.g. `pnpx tsx src/backtest/...`).

## License

MIT — see [LICENSE](LICENSE).
