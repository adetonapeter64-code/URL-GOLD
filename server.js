const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;

if (!token) {
console.error("BOT_TOKEN is missing");
process.exit(1);
}

const bot = new TelegramBot(token, {
polling: true
});

app.use(express.urlencoded({ extended: true }));


// ===============================
// ADMIN PANEL LOGIN
// ===============================
// Set these in Render's Environment Variables tab. If you don't set
// them, the panel falls back to admin / changeme123 - change that
// immediately if you leave it on the default.
// ===============================

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

function requireAdminAuth(req, res, next) {
const authHeader = req.headers.authorization;

if (!authHeader || !authHeader.startsWith("Basic ")) {
res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
return res.status(401).send("Authentication required.");
}

const decoded = Buffer.from(authHeader.split(" ")[1], "base64").toString();
const [user, pass] = decoded.split(":");

if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
return next();
}

res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
return res.status(401).send("Invalid credentials.");
}


// ===============================
// BOT MENU
// ===============================

const mainMenu = {
reply_markup: {
keyboard: [
["📊 XAUUSD Signal", "💰 Live Price"],
["🔔 Auto Signals", "🔕 Stop Alerts"],
["📖 How It Works", "⚙️ Settings"]
],
resize_keyboard: true,
is_persistent: true
}
};


// ===============================
// USERS SUBSCRIBED TO AUTO SIGNALS
// ===============================
// Map instead of a Set so the admin panel can show who each
// subscriber actually is, not just their raw chat ID.
// ===============================

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }


// ===============================
// SIGNAL HISTORY (for the admin panel)
// ===============================

const signalHistory = []; // most recent first
const MAX_SIGNAL_HISTORY = 100;

const botStartedAt = Date.now();


// ===============================
// WEB SERVER
// ===============================

app.get("/", (req, res) => {
res.send("🔥 MONEY MAKING MACHINE BOT is running.");
});


// ===============================
// ADMIN PANEL
// ===============================
// Open https://your-render-url.onrender.com/admin in any phone
// browser. It will prompt for a username/password - that's the
// ADMIN_USER / ADMIN_PASSWORD you set in Render's environment
// variables.
//
// NOTE: everything here lives in memory, same as the bot's candle
// data. A restart (or Render free-tier spin-down) clears history
// and the subscriber list rebuilds itself as people interact again.
// ===============================

function escapeHtml(str) {
if (str === null || str === undefined) return "";
return String(str)
.replace(/&/g, "&")
.replace(/</g, "<")
.replace(/>/g, ">");
}

function formatUptime(ms) {
const totalMinutes = Math.floor(ms / 60000);
const hours = Math.floor(totalMinutes / 60);
const minutes = totalMinutes % 60;
return ${hours}h ${minutes}m;
}

app.get("/admin", requireAdminAuth, (req, res) => {

const price = candles.length > 0 ? candles[candles.length - 1].close : null;

const subscriberRows = [...subscribers.entries()].map(([chatId, info]) => &lt;tr&gt; &lt;td&gt;${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}&lt;/td&gt; &lt;td&gt;${chatId}</td>
<td>${new Date(info.joinedAt).toLocaleString()}&lt;/td&gt; &lt;td&gt; &lt;form method="POST" action="/admin/remove" style="margin:0;"&gt; &lt;input type="hidden" name="chatId" value="${chatId}">
<button type="submit" class="danger">Remove</button>
</form>
</td>
</tr>
).join("") ||<tr><td colspan="4">No subscribers yet.</td></tr>`;

const statusBadge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss" };

const signalRows = signalHistory.slice(0, 20).map(s => &lt;tr&gt; &lt;td&gt;${new Date(s.time).toLocaleString()}</td>
<td> {s.direction}</td>
<td> {s.stopLoss.toFixed(2)}</td>
<td> {statusBadge[s.status] || s.status}</td>
</tr>
).join("") ||<tr><td colspan="7">No signals fired yet.</td></tr>`;

const wins = signalHistory.filter(s => s.status === "win").length;
const losses = signalHistory.filter(s => s.status === "loss").length;
const openCount = signalHistory.filter(s => s.status === "open").length;
const decided = wins + losses;
const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) : "—";

const setupStatus = pendingSetup
? Watching a ${escapeHtml(pendingSetup.label)} ${escapeHtml(pendingSetup.direction.toUpperCase())} setup, waiting for retest.
: "No active setup right now.";

res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Money Making Machine - Admin</title>
<style>
body { font-family: -apple-system, Arial, sans-serif; background: #0f1115; color: #eee; margin: 0; padding: 16px; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1.05rem; margin-top: 28px; color: #f5c542; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.card { background: #1b1f27; border-radius: 10px; padding: 12px 16px; flex: 1 1 140px; }
.card .label { font-size: 0.75rem; color: #999; }
.card .value { font-size: 1.3rem; font-weight: bold; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a2f3a; }
th { color: #aaa; font-weight: normal; }
button { background: #2b6fe0; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.85rem; }
button.danger { background: #c0392b; }
textarea, input[type=text] { width: 100%; box-sizing: border-box; background: #1b1f27; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 0.9rem; }
form.broadcast { margin-top: 8px; }
.scroll { overflow-x: auto; }
</style>
</head>
<body>
<h1>🔥 Money Making Machine - Admin</h1>

<div class="stats">
<div class="card"><div class="label">Bot uptime</div><div class="value"> {price ? price.toFixed(2) : "—"}</div></div>
<div class="card"><div class="label">Candles</div><div class="value"> {subscribers.size}</div></div>
<div class="card"><div class="label">Signals sent</div><div class="value">$`{signalHistory.length}</div></div>
</div>

<div class="stats">
<div class="card"><div class="label">Win rate</div><div class="value">${winRate}${decided > 0 ? "%" : ""}</div></div>
<div class="card"><div class="label">Wins</div><div class="value">${wins}&lt;/div&gt;&lt;/div&gt; &lt;div class="card"&gt;&lt;div class="label"&gt;Losses&lt;/div&gt;&lt;div class="value"&gt;${losses}</div></div>
<div class="card"><div class="label">Open</div><div class="value">`${openCount}</div></div>
</div>

<p><strong>Setup status:</strong> $`{setupStatus}</p>

<h2>Send a manual message to all subscribers</h2>
<form class="broadcast" method="POST" action="/admin/broadcast">
<textarea name="message" rows="3" placeholder="Type a message to send to every subscriber..."></textarea>
<br><br>
<button type="submit">Send Broadcast</button>
</form>

<h2>Subscribers (${subscribers.size})&lt;/h2&gt; &lt;div class="scroll"&gt; &lt;table&gt; &lt;tr&gt;&lt;th&gt;Name&lt;/th&gt;&lt;th&gt;Chat ID&lt;/th&gt;&lt;th&gt;Joined&lt;/th&gt;&lt;th&gt;&lt;/th&gt;&lt;/tr&gt; ${subscriberRows}
</table>
</div>

<h2>Recent Signals</h2>
<div class="scroll">
<table>
<tr><th>Time</th><th>Type</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>
`${signalRows}
</table>
</div>

</body>
</html>
`);

});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
const chatId = Number(req.body.chatId);
subscribers.delete(chatId);
res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, async (req, res) => {
const text = (req.body.message || "").trim();

if (text) {
for (const chatId of subscribers.keys()) {
bot.sendMessage(chatId, 📢 ${text}).catch(err =&gt; { console.error(Broadcast failed for ${chatId}:, err.message);
});
}
}

res.redirect("/admin");
});


// ===============================
// GET LIVE XAUUSD PRICE
// ===============================

async function getGoldPrice() {

const response = await axios.get(
"https://xaus.com/api/v1/spot?compact=1",
{
timeout: 10000
}
);

const data = response.data;

if (!data.xau || !data.xau.price) {
throw new Error("Invalid XAUUSD data");
}

return Number(data.xau.price);
}


// ================================================================
// CANDLE BUILDER
// ================================================================
// The free price API only returns the CURRENT spot price, not a
// history of candles. So this bot builds its own candle history by
// sampling the live price every 30 seconds and grouping those ticks
// into 5-minute candles (10 ticks per candle).
//
// IMPORTANT: because history has to be built from scratch, the
// signal engine needs a couple of hours of uptime before it has
// enough candles to find real market structure. It will not (and
// should not) fire signals the moment it starts up.
// ================================================================

const TICKS_PER_CANDLE = 10; // 10 x 30s = 5 minutes per candle
const MAX_CANDLES = 300; // keep roughly the last 25 hours

let currentTicks = [];
let candles = []; // { open, high, low, close, time }

function addTick(price) {
currentTicks.push(price);

if (currentTicks.length >= TICKS_PER_CANDLE) {
const open = currentTicks[0];
const close = currentTicks[currentTicks.length - 1];
const high = Math.max(...currentTicks);
const low = Math.min(...currentTicks);

candles.push({ open, high, low, close, time: Date.now() });
if (candles.length > MAX_CANDLES) candles.shift();

currentTicks = [];

// A candle just closed - re-run the signal engine
analyzeMarket();
}
}


// ================================================================
// SWING HIGH / LOW DETECTION (fractals)
// ================================================================
// A candle counts as a swing high if its high is greater than the
// lookback candles immediately before AND after it. Same idea,
// inverted, for swing lows. This is the standard way to find the
// "structure points" that BOS/CHoCH are measured against.
// ================================================================

function findSwings(lookback = 2) {
const swings = [];

for (let i = lookback; i < candles.length - lookback; i++) {
const slice = candles.slice(i - lookback, i + lookback + 1);
const c = candles[i];

const isHigh = slice.every(s => s.high <= c.high);
const isLow = slice.every(s => s.low >= c.low);

if (isHigh) swings.push({ index: i, price: c.high, type: "high" });
if (isLow) swings.push({ index: i, price: c.low, type: "low" });
}

return swings;
}


// ================================================================
// FAIR VALUE GAP (FVG) DETECTION
// ================================================================
// Bullish FVG: candle[i-2]'s high sits below candle[i]'s low - an
// unfilled gap left behind by an impulsive move up.
// Bearish FVG: candle[i-2]'s low sits above candle[i]'s high.
// ================================================================

function findFVG(startIndex, direction) {
for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
const c1 = candles[i - 2];
const c3 = candles[i];

if (direction === "bullish" && c1.high < c3.low) {
return { top: c3.low, bottom: c1.high, index: i };
}
if (direction === "bearish" && c1.low > c3.high) {
return { top: c1.low, bottom: c3.high, index: i };
}
}
return null;
}


// ================================================================
// ORDER BLOCK DETECTION
// ================================================================
// The last opposite-colored candle right before the impulsive move
// that broke structure - the classic ICT "order block" zone.
// ================================================================

function findOrderBlock(breakIndex, direction) {
for (let i = breakIndex; i >= 0 && i >= breakIndex - 6; i--) {
const c = candles[i];
const isBearishCandle = c.close < c.open;
const isBullishCandle = c.close > c.open;

if (direction === "bullish" && isBearishCandle) {
return { top: c.high, bottom: c.low, index: i };
}
if (direction === "bearish" && isBullishCandle) {
return { top: c.high, bottom: c.low, index: i };
}
}
return null;
}


// ================================================================
// SIGNAL ENGINE STATE
// ================================================================

let pendingSetup = null; // { direction, label, fvg, orderBlock, breakLevel, createdAt }
let lastSignalTime = 0;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // rest period after a signal closes before hunting resumes
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000; // drop an unconfirmed setup after 3 hours

const PIP_SIZE = 0.1; // XAUUSD convention used here: 1 "pip" = $`0.10 move
const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;


// ================================================================
// MAIN ANALYSIS - runs every time a new 5-minute candle closes
// ================================================================

function hasOpenSignal() {
return signalHistory.some(s => s.status === "open");
}

function analyzeMarket() {
if (candles.length < 20) return; // not enough history yet

// Strict one-at-a-time rule: never hunt for a new setup while a
// previous signal is still running. Wait for it to hit TP or SL
// (checkOpenSignals handles that), send the result, THEN resume
// scanning. This keeps the bot from ever overlapping trades.
if (hasOpenSignal()) return;

const swings = findSwings(2);
if (swings.length < 4) return;

const swingHighs = swings.filter(s => s.type === "high");
const swingLows = swings.filter(s => s.type === "low");

const lastHigh = swingHighs[swingHighs.length - 1];
const prevHigh = swingHighs[swingHighs.length - 2];
const lastLow = swingLows[swingLows.length - 1];
const prevLow = swingLows[swingLows.length - 2];

if (!lastHigh || !prevHigh || !lastLow || !prevLow) return;

// Current structure/trend based on the last two swing points
const structureBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
const structureBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

const latestClose = candles[candles.length - 1].close;
const latestIndex = candles.length - 1;

const brokeAboveHigh = latestClose > lastHigh.price;
const brokeBelowLow = latestClose < lastLow.price;

// Bullish break: BOS if structure was already bullish, CHoCH if it
// was bearish (a break like this signals a possible reversal).
if (brokeAboveHigh && !pendingSetup) {
const fvg = findFVG(latestIndex, "bullish");
if (fvg) {
const ob = findOrderBlock(fvg.index, "bullish");
pendingSetup = {
direction: "bullish",
label: structureBullish ? "BOS" : "CHoCH",
fvg,
orderBlock: ob,
structureLow: lastLow.price,
createdAt: Date.now()
};
console.log([SETUP] Bullish${pendingSetup.label} detected @ ${latestClose});
}
}

if (brokeBelowLow && !pendingSetup) {
const fvg = findFVG(latestIndex, "bearish");
if (fvg) {
const ob = findOrderBlock(fvg.index, "bearish");
pendingSetup = {
direction: "bearish",
label: structureBearish ? "BOS" : "CHoCH",
fvg,
orderBlock: ob,
structureHigh: lastHigh.price,
createdAt: Date.now()
};
console.log([SETUP] Bearish${pendingSetup.label} detected @ ${latestClose});
}
}

// If a setup is pending, watch for price retracing back into the
// FVG / order block zone with a confirming candle before firing.
if (pendingSetup) {

if (Date.now() - pendingSetup.createdAt > SETUP_EXPIRY_MS) {
console.log("[SETUP] Expired without confirmation");
pendingSetup = null;
return;
}

const zoneTop = pendingSetup.orderBlock ? pendingSetup.orderBlock.top : pendingSetup.fvg.top;
const zoneBottom = pendingSetup.orderBlock ? pendingSetup.orderBlock.bottom : pendingSetup.fvg.bottom;

const priceInZone = latestClose <= zoneTop && latestClose >= zoneBottom;

if (priceInZone) {
const confirmCandle = candles[candles.length - 1];
const bullishConfirm = pendingSetup.direction === "bullish" && confirmCandle.close > confirmCandle.open;
const bearishConfirm = pendingSetup.direction === "bearish" && confirmCandle.close < confirmCandle.open;

if (bullishConfirm || bearishConfirm) {
fireSignal(pendingSetup, latestClose);
pendingSetup = null;
}
}
}
}


// ================================================================
// FIRE SIGNAL - broadcast the confirmed entry to all subscribers
// ================================================================

function fireSignal(setup, entryPrice) {

if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) {
console.log("[SIGNAL] Skipped - cooldown active");
return;
}
lastSignalTime = Date.now();

const direction = setup.direction === "bullish" ? "BUY" : "SELL";
const emoji = setup.direction === "bullish" ? "🟢" : "🔴";

const tpDistance = ((TP_PIPS_MIN + TP_PIPS_MAX) / 2) * PIP_SIZE; // midpoint of 200-300 pip range

let stopLoss, takeProfit;

if (setup.direction === "bullish") {
stopLoss = (setup.orderBlock ? setup.orderBlock.bottom : setup.structureLow) - 1;
takeProfit = entryPrice + tpDistance;
} else {
stopLoss = (setup.orderBlock ? setup.orderBlock.top : setup.structureHigh) + 1;
takeProfit = entryPrice - tpDistance;
}

const message =
🚨 XAUUSD SIGNAL -${setup.label}

 {direction} @ $`{entryPrice.toFixed(2)}

🛡️ Stop Loss: ${stopLoss.toFixed(2)} 🎯 Take Profit: ${takeProfit.toFixed(2)}
📏 Target: ~${TP_PIPS_MIN}-${TP_PIPS_MAX} pips

📊 Confirmed by:
• Market Structure (`${setup.label})
• Fair Value Gap
• Order Block retest + confirmation candle

⚠️ Always manage your own risk. This is not financial advice.`;

console.log([SIGNAL FIRED] ${direction} @ ${entryPrice});

signalHistory.unshift({
id: ${Date.now()}-${Math.floor(Math.random() * 1000)},
time: Date.now(),
label: setup.label,
direction,
entryPrice,
stopLoss,
takeProfit,
status: "open", // open -> win / loss once price hits TP or SL
closedAt: null,
closePrice: null
});
if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

for (const chatId of subscribers.keys()) {
bot.sendMessage(chatId, message).catch(err => {
console.error(Failed to send signal to ${chatId}:`, err.message);
});
}
}


// ================================================================
// OUTCOME TRACKER
// ================================================================
// Runs on every price tick (every 30 seconds). Checks every still-
// open signal against the current live price - if price has hit
// either the Take Profit or Stop Loss, the signal is marked as a
// win or a loss and everyone subscribed gets notified.
// ================================================================

function checkOpenSignals(currentPrice) {

const openSignals = signalHistory.filter(s => s.status === "open");

for (const signal of openSignals) {

let hitTP = false;
let hitSL = false;

if (signal.direction === "BUY") {
hitTP = currentPrice >= signal.takeProfit;
hitSL = currentPrice <= signal.stopLoss;
} else {
hitTP = currentPrice <= signal.takeProfit;
hitSL = currentPrice >= signal.stopLoss;
}

// If both somehow trip on the same tick (fast spike/wick), treat
// the Stop Loss as hit first - the more conservative outcome.
if (hitSL) {
signal.status = "loss";
} else if (hitTP) {
signal.status = "win";
} else {
continue; // still open, nothing to do
}

signal.closedAt = Date.now();
signal.closePrice = currentPrice;

// Cooldown now counts from when THIS signal closed, not when it
// opened - guarantees a clean rest period after every result
// before the bot starts hunting for the next setup.
lastSignalTime = Date.now();

const resultEmoji = signal.status === "win" ? "✅" : "❌";
const resultText = signal.status === "win" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";

const closeMessage =
``${resultEmoji} SIGNAL CLOSED - $`{resultText}

${signal.direction} @ ${signal.entryPrice.toFixed(2)}
Closed @ `${currentPrice.toFixed(2)}

${signal.status === "win" ? "🎯 Target reached." : "🛡️ Stop loss protected your downside."};

console.log([SIGNAL CLOSED]${signal.direction} @  {signal.status.toUpperCase()} @ ${currentPrice});

for (const chatId of subscribers.keys()) {
bot.sendMessage(chatId, closeMessage).catch(err => {
console.error(Failed to send close update to${chatId}:`, err.message);
});
}
}
}


// ===============================
// START COMMAND
// ===============================

bot.onText(//start/, (msg) => {

bot.sendMessage(
msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD trading assistant.

📊 Market analysis
🚨 Entry alerts
🎯 200–300 pip targets
🛡️ Risk levels

Choose an option below:`,
mainMenu
);

});


// ===============================
// 📊 XAUUSD SIGNAL BUTTON
// ===============================

bot.on("message", async (msg) => {

if (!msg.text) return;

if (msg.text === "📊 XAUUSD Signal") {

try {

const price = await getGoldPrice();
const status = pendingSetup
? 👀 Watching a ${pendingSetup.label} ${pendingSetup.direction.toUpperCase()} setup - waiting for retest confirmation.
: candles.length < 20
? ⏳ Still building candle history (${candles.length}/20 candles). Give the bot a bit more uptime.:🔎 No active setup right now - scanning every 5 minutes.`;

await bot.sendMessage(
msg.chat.id,

`🔎 XAUUSD MARKET CHECK

💰 Current Price: `${price.toFixed(2)}

📡 Live market data connected.

$`{status}

📊 Checking:
• Market Structure
• BOS / CHoCH
• Liquidity
• FVG
• Order Block

🚨 A signal will be sent automatically when the entry conditions are confirmed.`
);

} catch (error) {

console.error("Signal price error:", error.message);

bot.sendMessage(
msg.chat.id,
"⚠️ XAUUSD market data is temporarily unavailable."
);

}

}


// ===============================
// 💰 LIVE PRICE
// ===============================

if (msg.text === "💰 Live Price") {

try {

const price = await getGoldPrice();

bot.sendMessage(
msg.chat.id,

`💰 XAUUSD LIVE PRICE

🪙 `${price.toFixed(2)}

📡 Market Data: LIVE
⏱️ Updated: Just now`
);

} catch (error) {

console.error("Price error:", error.message);

bot.sendMessage(
msg.chat.id,
"⚠️ Unable to retrieve the current XAUUSD price."
);

}

}


// ===============================
// 🔔 AUTO SIGNALS
// ===============================

if (msg.text === "🔔 Auto Signals") {

subscribers.set(msg.chat.id, {
username: msg.from.username || null,
firstName: msg.from.first_name || "Unknown",
joinedAt: subscribers.has(msg.chat.id) ? subscribers.get(msg.chat.id).joinedAt : Date.now()
});

bot.sendMessage(
msg.chat.id,

`🔔 AUTOMATIC SIGNALS ENABLED

MONEY MAKING MACHINE BOT will monitor XAUUSD automatically.

You will receive an alert when a complete trading setup is confirmed.

📊 BOS / CHoCH
💧 Liquidity
🟨 FVG
🟦 Order Block
✅ Entry confirmation
🎯 200–300 pip target

You don't need to keep typing /signal.

Note: the bot builds its own candle history from live prices, so the first real setups may take a couple of hours to appear after each restart.`
);

}


// ===============================
// 🔕 STOP SIGNALS
// ===============================

if (msg.text === "🔕 Stop Alerts") {

subscribers.delete(msg.chat.id);

bot.sendMessage(
msg.chat.id,

`🔕 AUTOMATIC SIGNALS STOPPED

You will no longer receive automatic XAUUSD entry alerts.

You can turn them back on anytime with:

🔔 Auto Signals`
);

}


// ===============================
// 📖 HOW IT WORKS
// ===============================

if (msg.text === "📖 How It Works") {

bot.sendMessage(
msg.chat.id,

`📖 HOW IT WORKS

MONEY MAKING MACHINE BOT monitors XAUUSD for high-quality setups.

The signal engine checks:

📈 Market Structure
BOS / CHoCH

💧 Liquidity
Swing highs/lows used as structure points

🟨 Fair Value Gap
FVG confirmation

🟦 Order Block
Potential institutional zone

✅ Entry Confirmation
Price must retest the FVG/order block zone with a confirming candle

🎯 Target
200–300 pip target range

🛡️ Risk
Stop Loss is calculated from the order block / structure point

🚨 When all required conditions are confirmed, the bot automatically sends an entry alert to everyone with Auto Signals on.

⏳ The bot builds its price history live, so it needs some uptime after each restart before it has enough candles to analyze.`
);

}


// ===============================
// ⚙️ SETTINGS
// ===============================

if (msg.text === "⚙️ Settings") {

bot.sendMessage(
msg.chat.id,

`⚙️ SETTINGS

📊 Market
XAUUSD

🎯 Target
200–300 pips

🔔 Automatic Alerts
Available

⏱️ Market Monitoring
Automatic (5-minute candles built from live price)

📈 Signal Type
Technical confirmation (BOS/CHoCH + FVG + Order Block)

📉 Candles collected
$`{candles.length}

More settings will be added as the system develops.`
);

}

});


// ===============================
// AUTOMATIC MARKET MONITOR
// Runs every 30 seconds: fetches the live price and feeds it into
// the candle builder, which in turn triggers the signal engine
// whenever a new 5-minute candle closes.
// ===============================

async function monitorMarket() {

try {

const price = await getGoldPrice();

console.log(
[MARKET] XAUUSD:${price.toFixed(2)} | ticks:  {TICKS_PER_CANDLE} | candles: ${candles.length}
);

addTick(price);
checkOpenSignals(price);

} catch (error) {

console.error(
"Market monitor error:",
error.message
);

}

}


// ===============================
// CHECK MARKET EVERY 30 SECONDS
// ===============================

setInterval(
monitorMarket,
30000
);


// ===============================
// INITIAL MARKET CHECK
// ===============================

monitorMarket();


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {

console.log(
🔥 MONEY MAKING MACHINE BOT running on port${PORT}`
);

});
