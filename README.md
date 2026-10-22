🎯 BOT.XAU Sniper Entry
A new, independent Node.js Telegram signal bot for XAU/USD only.
Strategy
1D: Find major supply and demand zones.
4H: Find/refine recent zones.
15M: Require a liquidity sweep and a directional structure break (BOS/CHOCH-style confirmation) before sending a signal.
Signal contains entry, stop loss, TP1 (at least 2R), TP2 (3R), zone, confirmation and UTC candle time.
Tracks open signal outcomes from subsequent closed 15M candles.
Sends Telegram messages for new signals and trade updates.
It sends alerts only. It does not place broker orders.
Files
server.js — server, market data, strategy, Telegram and result tracking.
package.json — dependencies and start command.
.env.example — environment-variable template.
README.md — setup guide.
Environment variables
Set these in Render → your service → Environment:
Key
Value
TWELVE_DATA_KEY
Your Twelve Data API key
TELEGRAM_BOT_TOKEN
Token from BotFather
TELEGRAM_CHAT_ID
Your personal Telegram chat ID or destination chat ID
SCAN_INTERVAL_MINUTES
15 recommended starting value
DATA_FILE
Optional, e.g. /var/data/state.json when a persistent disk is mounted
Do not put real API keys in GitHub or share them in screenshots.
Deploy to Render
Create a new GitHub repository for this project so it remains separate from your other bot.
Upload server.js, package.json, and README.md. .env.example is only a template.
In Render, choose New → Web Service and connect the new repository.
Build command: npm install
Start command: npm start
Add TWELVE_DATA_KEY, TELEGRAM_BOT_TOKEN, and TELEGRAM_CHAT_ID under Environment.
Deploy, then open https://YOUR-SERVICE.onrender.com/health.
Send /start to your Telegram bot. The bot must have been started by you before it can message your private chat.
Telegram chat ID
If you do not know your chat ID, send /start to the bot, then use Telegram's Bot API getUpdates endpoint in a browser after sending a message to the bot. Find message.chat.id in the returned JSON. Keep your bot token private; do not paste the token into public websites or chats.
Data and API usage
Each full scan makes three Twelve Data time-series requests (1day, 4h, 15min). At a 15-minute interval that is about 288 requests per day, before retries. Check your Twelve Data plan's credits and rate limits; increase SCAN_INTERVAL_MINUTES if needed. The service excludes the still-forming candle from each timeframe.
Render's local filesystem can be ephemeral. For signal history to survive redeploys/restarts, attach a persistent disk and set DATA_FILE=/var/data/state.json (persistent disks may require a paid Render service plan).
Important limitations
Supply/demand and BOS/CHOCH are rule-based approximations, not subjective chart-reading or guaranteed institutional signals.
Candle OHLC data cannot tell the exact order of price touches within a candle; when stop and target are both touched on the same candle, the tracker assumes stop first (conservative).
The strategy may produce no signals for long periods if strict conditions are not met.
Confirm the symbol is available on your Twelve Data plan. If the API returns a symbol or entitlement error, check the Twelve Data dashboard/docs and symbol format.
No strategy guarantees profitable results. Test on demo/paper trading before risking money.
