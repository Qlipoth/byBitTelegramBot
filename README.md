# ByBit Market Bot 🤖

A sophisticated trading bot for ByBit cryptocurrency exchange that monitors market conditions, detects trading opportunities, and sends alerts via Telegram.

## ✨ Features

- Real-time market monitoring of top liquid coins
- Advanced squeeze detection (short and long)
- Volume and price action analysis
- Open Interest (OI) accumulation detection
- Trend analysis and momentum detection
- Customizable alert thresholds
- Telegram notifications

## 🚀 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Qlipoth/byBitTelegramBot.git
   cd byBitTelegramBot
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn
   # or
   pnpm install
   ```

3. Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

## ⚙️ Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Telegram Bot Token from @BotFather
BOT_TOKEN=your_telegram_bot_token

# ByBit API Credentials
BYBIT_API_KEY=your_bybit_api_key
BYBIT_SECRET_KEY=your_bybit_secret_key

# Optional: Customize alert thresholds (see src/market/constants.market.ts)
```

## 🏃‍♂️ Usage

1. Start the bot:
   ```bash
   npm start
   # or
   yarn start
   # or
   pnpm start
   ```

2. In Telegram, start a chat with your bot and use the following commands:

## 📋 Commands

- `/start` - Start receiving market alerts
- `/market` - Get current market overview
- `/delta [symbol]` - Analyze price and OI changes for a symbol

## 📊 Features in Detail

### Market Monitoring
- Tracks top liquid coins with customizable thresholds
- Real-time price, volume, and OI analysis
- Customizable alert conditions

### Squeeze Detection
- Advanced short squeeze detection with RSI confirmation
- Long squeeze detection with volume and OI analysis
- Customizable squeeze score thresholds

### Trend Analysis
- Multi-timeframe trend detection
- Volume-Weighted Average Price (VWAP) analysis
- Support/Resistance level detection

## 📁 Project Structure

```
src/
├── bot/                # Telegram bot implementation
│   └── index.ts        # Bot entry point and command handlers
├── market/             # Market analysis logic
│   ├── compare.ts      # Snapshot comparison utilities
│   ├── constants.market.ts  # Market constants and thresholds
│   ├── snapshotStore.ts     # Market data storage
│   ├── types.ts        # TypeScript interfaces
│   ├── utils.ts        # Utility functions
│   └── watcher.ts      # Market watcher implementation
└── services/
    └── bybit.ts        # ByBit API client
```

## 🌐 Деплой на Koyeb (free tier)

На бесплатном тарифе Koyeb считает «трафик» только **входящие HTTP-запросы**. Если больше ~1 часа нет запросов, инстанс переводится в deep sleep и затем останавливается (SIGTERM).

Бот уже поднимает HTTP-сервер на `PORT` (по умолчанию 8000) и отвечает на `GET /` и `GET /health` кодом 200. Чтобы инстанс не засыпал:

1. **В Koyeb** создайте сервис как **Web Service**, укажите порт (например 8000) и получите публичный URL вида `https://your-app-xxx.koyeb.app`.
2. **Включите периодический пинг извне** — любой запрос к вашему URL раз в 15–30 минут считается трафиком:
   - [UptimeRobot](https://uptimerobot.com) — бесплатный мониторинг, проверка каждые 5 мин.
   - [cron-job.org](https://cron-job.org) — бесплатный cron: добавьте задачу `GET https://your-app-xxx.koyeb.app/health` с интервалом 15–30 мин.

Без внешнего пинга бот будет засыпать после ~1 часа без обращений к HTTP.

## 🔧 Development

### Available Scripts

- `npm start` - Start the bot in development mode
- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Start in development mode with hot-reload

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `BYBIT_API_KEY` | Yes | Your ByBit API key |
| `BYBIT_SECRET_KEY` | Yes | Your ByBit API secret key |

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📧 Contact

For any inquiries, please open an issue on GitHub.
