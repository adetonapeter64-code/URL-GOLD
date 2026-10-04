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

const bot = new TelegramBot(token, { polling: true });
bot.on("polling_error", (err) => console.error("Polling error:", err.message));

app.use(express.urlencoded({ extended: true }));

// ===============================
// ADMIN LOGIN (set ADMIN_USER / ADMIN_PASSWORD in Render env vars)
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
  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
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
// STATE
// ===============================

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = []; // most recent first
const MAX_SIGNAL_HISTORY = 100;
const botStartedAt = Date.now();

function broadcast(text) {
  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, text).catch((err) => {
      console.error(`Send failed for ${chatId}:`, err.message);
    });
  }
}

// ================================================================
// SETTINGS
// ================================================================

const SAMPLE_MS = 10 * 1000; // price sampled every 10s (was 30s) -> truer highs/lows
const CANDLE_MS = 5 * 60 * 1000; // real 5-minute candles aligned to the clock
const MIN_TICKS_PER_CANDLE = 15; // a candle with fewer samples than this is discarded
const MAX_CANDLES = 300;
const MIN_CANDLES = 30; // warm-up before any setup is looked for

const PIP_SIZE = 0.1; // 1 "pip" = $0.10
const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;

const MIN_ATR = 0.4; // below this the market is dead/closed - no setups
const MIN_RISK_ATR = 1.5; // stop loss is never closer than 1.5 x ATR to entry
const MAX_RISK_USD = 15; // skip setups needing a stop wider than this ($15 = 150 pips)
const MIN_BODY_ATR = 0.5; // breakout candle body must be at least 0.5 x ATR
const MAX_ZONE_ATR = 3; // skip zones taller than 3 x ATR
const MAX_SWING_AGE = 40; // the broken swing must be within the last 40 candles

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // rest after a signal closes
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000; // drop unconfirmed setups after 3h
const SIGNAL_MAX_AGE_MS = 12 * 60 * 60 * 1000; // close out signals stuck open > 12h

// ================================================================
// LIVE PRICE
// ================================================================

async function getGoldPrice() {
  const response = await axios.get("https://xaus.com/api/v1/spot?compact=1", { timeout: 10000 });
  const data = response.data;
  if (!data.xau || !data.xau.price) throw new Error("Invalid XAUUSD data");
  return Number(data.xau.price);
}

// ================================================================
// CANDLE BUILDER
// Candles are aligned to real 5-minute boundaries. If the bot was
// asleep/restarted (a missing or partial candle), the history is
// wiped instead of stitching a fake gap into the chart.
// ================================================================

let candles = []; // { open, high, low, close, time }
let currentTicks = [];
let currentBucket = null;

function resetHistory(reason) {
  if (candles.length > 0 || pendingSetup) console.log(`[DATA] History reset: ${reason}`);
  candles = [];
  pendingSetup = null;
}

function closeCandle() {
  const ticks = currentTicks;
  const closingBucket = currentBucket;
  currentTicks = [];

  if (ticks.length < MIN_TICKS_PER_CANDLE) {
    if (candles.length > 0) resetHistory("partial candle (data hole)");
    return;
  }

  const last = candles[candles.length - 1];
  if (last && closingBucket - last.time > CANDLE_MS) {
    resetHistory("gap between candles");
  }

  candles.push({
    open: ticks[0],
    high: Math.max(...ticks),
    low: Math.min(...ticks),
    close: ticks[ticks.length - 1],
    time: closingBucket
  });
  if (candles.length > MAX_CANDLES) candles.shift();

  analyzeMarket();
}

function addTick(price) {
  const bucket = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
  if (currentBucket === null) currentBucket = bucket;
  if (bucket !== currentBucket) {
    closeCandle();
    currentBucket = bucket;
  }
  currentTicks.push(price);
}

// ================================================================
// INDICATORS / STRUCTURE
// ================================================================

function calcATR(period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

function findSwings(lookback = 2) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (slice.every((s) => s.high <= c.high)) swings.push({ index: i, price: c.high, type: "high" });
    if (slice.every((s) => s.low >= c.low)) swings.push({ index: i, price: c.low, type: "low" });
  }
  return swings;
}

function findFVG(startIndex, direction) {
  for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (direction === "bullish" && c1.high < c3.low) return { top: c3.low, bottom: c1.high, index: i };
    if (direction === "bearish" && c1.low > c3.high) return { top: c1.low, bottom: c3.high, index: i };
  }
  return null;
}

function findOrderBlock(breakIndex, direction) {
  for (let i = breakIndex; i >= 0 && i >= breakIndex - 6; i--) {
    const c = candles[i];
    if (direction === "bullish" && c.close < c.open) return { top: c.high, bottom: c.low, index: i };
    if (direction === "bearish" && c.close > c.open) return { top: c.high, bottom: c.low, index: i };
  }
  return null;
}

// ================================================================
// SIGNAL ENGINE
// ================================================================

let pendingSetup = null;
let lastSignalTime = 0;

function hasOpenSignal() {
  return signalHistory.some((s) => s.status === "open");
}

function analyzeMarket() {
  if (candles.length < MIN_CANDLES) return;
  if (hasOpenSignal()) return; // one trade at a time

  const atr = calcATR(14);
  if (!atr || atr < MIN_ATR) return;

  const n = candles.length - 1;
  const last = candles[n];
  const prev = candles[n - 1];

  // ---------- 1. Manage an existing pending setup ----------
  if (pendingSetup) {
    const s = pendingSetup;
    const bull = s.direction === "bullish";

    if (Date.now() - s.createdAt > SETUP_EXPIRY_MS) {
      console.log("[SETUP] Expired without confirmation");
      pendingSetup = null;
    } else if (candles.length > s.createdCandleCount) {
      // Zone is dead if a candle CLOSES through it - drop the setup
      const broken = bull ? last.close < s.zoneBottom : last.close > s.zoneTop;
      if (broken) {
        console.log("[SETUP] Invalidated - price closed through the zone");
        pendingSetup = null;
      } else {
        const touched = bull ? last.low <= s.zoneTop : last.high >= s.zoneBottom;
        const holding = bull ? last.close >= s.zoneBottom : last.close <= s.zoneTop;
        const confirm = bull ? last.close > last.open : last.close < last.open;

        if (touched && holding && confirm) {
          // Cooldown just delays the signal - it no longer destroys the setup
          if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) return;
          fireSignal(s, last.close, atr);
          pendingSetup = null;
          return;
        }
      }
    }
    if (pendingSetup) return;
  }

  // ---------- 2. Look for a FRESH structure break ----------
  const swings = findSwings(2);
  const swingHighs = swings.filter((s) => s.type === "high");
  const swingLows = swings.filter((s) => s.type === "low");
  if (swingHighs.length < 2 || swingLows.length < 2) return;

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  const structureBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const structureBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

  // Bullish break: this candle closed above the swing high, the previous one had not
  const brokeUp =
    prev.close <= lastHigh.price &&
    last.close > lastHigh.price &&
    n - lastHigh.index <= MAX_SWING_AGE &&
    last.close - last.open >= MIN_BODY_ATR * atr;

  const brokeDown =
    prev.close >= lastLow.price &&
    last.close < lastLow.price &&
    n - lastLow.index <= MAX_SWING_AGE &&
    last.open - last.close >= MIN_BODY_ATR * atr;

  if (brokeUp) {
    // BOS = continuation of bullish structure, CHoCH = flip from bearish. Choppy = skip.
    let label = null;
    if (structureBullish) label = "BOS";
    else if (structureBearish) label = "CHoCH";
    if (!label) return;

    const fvg = findFVG(n, "bullish");
    if (!fvg || fvg.top - fvg.bottom < 0.1 * atr) return;
    const ob = findOrderBlock(fvg.index, "bullish");
    const zoneTop = ob ? ob.top : fvg.top;
    const zoneBottom = ob ? ob.bottom : fvg.bottom;
    if (zoneTop - zoneBottom > MAX_ZONE_ATR * atr) return;

    pendingSetup = {
      direction: "bullish", label, fvg, orderBlock: ob,
      zoneTop, zoneBottom, structureLevel: lastLow.price,
      createdAt: Date.now(), createdCandleCount: candles.length
    };
    console.log(`[SETUP] Bullish ${label} detected @ ${last.close}`);
    return;
  }

  if (brokeDown) {
    let label = null;
    if (structureBearish) label = "BOS";
    else if (structureBullish) label = "CHoCH";
    if (!label) return;

    const fvg = findFVG(n, "bearish");
    if (!fvg || fvg.top - fvg.bottom < 0.1 * atr) return;
    const ob = findOrderBlock(fvg.index, "bearish");
    const zoneTop = ob ? ob.top : fvg.top;
    const zoneBottom = ob ? ob.bottom : fvg.bottom;
    if (zoneTop - zoneBottom > MAX_ZONE_ATR * atr) return;

    pendingSetup = {
      direction: "bearish", label, fvg, orderBlock: ob,
      zoneTop, zoneBottom, structureLevel: lastHigh.price,
      createdAt: Date.now(), createdCandleCount: candles.length
    };
    console.log(`[SETUP] Bearish ${label} detected @ ${last.close}`);
  }
}

// ================================================================
// FIRE SIGNAL
// Stop loss = beyond the zone with an ATR buffer, never closer than
// 1.5 x ATR. Take profit stays inside the 200-300 pip range and
// scales with the risk (2R, clamped).
// ================================================================

function fireSignal(setup, entryPrice, atr) {
  const bull = setup.direction === "bullish";
  const direction = bull ? "BUY" : "SELL";
  const emoji = bull ? "🟢" : "🔴";
  const buffer = Math.max(1, 0.5 * atr);

  let stopLoss;
  if (bull) {
    stopLoss = Math.min(setup.zoneBottom - buffer, entryPrice - MIN_RISK_ATR * atr);
  } else {
    stopLoss = Math.max(setup.zoneTop + buffer, entryPrice + MIN_RISK_ATR * atr);
  }

  const risk = Math.abs(entryPrice - stopLoss);
  if (risk > MAX_RISK_USD) {
    console.log(`[SIGNAL] Skipped - stop too wide ($${risk.toFixed(2)})`);
    return;
  }

  const tpMin = TP_PIPS_MIN * PIP_SIZE;
  const tpMax = TP_PIPS_MAX * PIP_SIZE;
  const tpDistance = Math.min(tpMax, Math.max(tpMin, risk * 2));
  const takeProfit = bull ? entryPrice + tpDistance : entryPrice - tpDistance;

  const message =
`🚨 XAUUSD SIGNAL - ${setup.label}

${emoji} ${direction} @ $${entryPrice.toFixed(2)}

🛡️ Stop Loss: $${stopLoss.toFixed(2)}
🎯 Take Profit: $${takeProfit.toFixed(2)}
📏 Target: ~${Math.round(tpDistance / PIP_SIZE)} pips

📊 Confirmed by:
• Market Structure (${setup.label})
• Fair Value Gap
• Order Block retest + confirmation candle

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(`[SIGNAL FIRED] ${direction} @ ${entryPrice}`);

  signalHistory.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    time: Date.now(),
    label: setup.label,
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    status: "open",
    closedAt: null,
    closePrice: null
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

  broadcast(message);
}

// ================================================================
// OUTCOME TRACKER (runs on every price sample)
// ================================================================

function checkOpenSignals(currentPrice) {
  const openSignals = signalHistory.filter((s) => s.status === "open");

  for (const signal of openSignals) {
    let hitTP, hitSL;
    if (signal.direction === "BUY") {
      hitTP = currentPrice >= signal.takeProfit;
      hitSL = currentPrice <= signal.stopLoss;
    } else {
      hitTP = currentPrice <= signal.takeProfit;
      hitSL = currentPrice >= signal.stopLoss;
    }

    const tooOld = Date.now() - signal.time > SIGNAL_MAX_AGE_MS;

    if (hitSL) signal.status = "loss"; // SL wins ties - the conservative outcome
    else if (hitTP) signal.status = "win";
    else if (tooOld) signal.status = "expired";
    else continue;

    signal.closedAt = Date.now();
    signal.closePrice = currentPrice;
    lastSignalTime = Date.now();

    const title = { win: "✅ SIGNAL CLOSED - TAKE PROFIT HIT", loss: "❌ SIGNAL CLOSED - STOP LOSS HIT", expired: "⌛ SIGNAL CLOSED - EXPIRED" }[signal.status];
    const note = { win: "🎯 Target reached.", loss: "🛡️ Stop loss protected your downside.", expired: "Neither level was hit in 12 hours. Treat as closed." }[signal.status];

    const closeMessage =
`${title}

${signal.direction} @ ${signal.entryPrice.toFixed(2)}
Closed @ ${currentPrice.toFixed(2)}

${note}`;

    console.log(`[SIGNAL CLOSED] ${signal.direction} ${signal.status.toUpperCase()} @ ${currentPrice}`);
    broadcast(closeMessage);
  }
}

// ================================================================
// WEB SERVER + ADMIN PANEL
// ================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatUptime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

app.get("/", (req, res) => {
  res.send("🔥 MONEY MAKING MACHINE BOT is running.");
});

app.get("/admin", requireAdminAuth, (req, res) => {
  const price = candles.length > 0 ? candles[candles.length - 1].close : null;

  const subscriberRows =
    [...subscribers.entries()]
      .map(([chatId, info]) => `<tr>
<td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td>
<td>${chatId}</td>
<td>${new Date(info.joinedAt).toLocaleString()}</td>
<td><form method="POST" action="/admin/remove" style="margin:0;"><input type="hidden" name="chatId" value="${chatId}"><button type="submit" class="danger">Remove</button></form></td>
</tr>`)
      .join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const statusBadge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss", expired: "⌛ Expired" };

  const signalRows =
    signalHistory
      .slice(0, 20)
      .map((s) => `<tr>
<td>${new Date(s.time).toLocaleString()}</td>
<td>${escapeHtml(s.label)}</td>
<td>${s.direction}</td>
<td>${s.entryPrice.toFixed(2)}</td>
<td>${s.stopLoss.toFixed(2)}</td>
<td>${s.takeProfit.toFixed(2)}</td>
<td>${statusBadge[s.status] || s.status}</td>
</tr>`)
      .join("") || `<tr><td colspan="7">No signals fired yet.</td></tr>`;

  const wins = signalHistory.filter((s) => s.status === "win").length;
  const losses = signalHistory.filter((s) => s.status === "loss").length;
  const openCount = signalHistory.filter((s) => s.status === "open").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) + "%" : "—";

  const setupStatus = pendingSetup
    ? `Watching a ${escapeHtml(pendingSetup.label)} ${escapeHtml(pendingSetup.direction.toUpperCase())} setup, waiting for retest.`
    : "No active setup right now.";

  res.send(`<!DOCTYPE html>
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
textarea { width: 100%; box-sizing: border-box; background: #1b1f27; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 0.9rem; }
.scroll { overflow-x: auto; }
</style>
</head>
<body>
<h1>🔥 Money Making Machine - Admin</h1>

<div class="stats">
<div class="card"><div class="label">Bot uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
<div class="card"><div class="label">Last price</div><div class="value">${price ? price.toFixed(2) : "—"}</div></div>
<div class="card"><div class="label">Candles</div><div class="value">${candles.length}</div></div>
<div class="card"><div class="label">Subscribers</div><div class="value">${subscribers.size}</div></div>
<div class="card"><div class="label">Signals sent</div><div class="value">${signalHistory.length}</div></div>
</div>

<div class="stats">
<div class="card"><div class="label">Win rate</div><div class="value">${winRate}</div></div>
<div class="card"><div class="label">Wins</div><div class="value">${wins}</div></div>
<div class="card"><div class="label">Losses</div><div class="value">${losses}</div></div>
<div class="card"><div class="label">Open</div><div class="value">${openCount}</div></div>
</div>

<p><strong>Setup status:</strong> ${setupStatus}</p>

<h2>Send a manual message to all subscribers</h2>
<form method="POST" action="/admin/broadcast">
<textarea name="message" rows="3" placeholder="Type a message to send to every subscriber..."></textarea>
<br><br>
<button type="submit">Send Broadcast</button>
</form>

<h2>Subscribers (${subscribers.size})</h2>
<div class="scroll">
<table>
<tr><th>Name</th><th>Chat ID</th><th>Joined</th><th></th></tr>
${subscriberRows}
</table>
</div>

<h2>Recent Signals</h2>
<div class="scroll">
<table>
<tr><th>Time</th><th>Type</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>
${signalRows}
</table>
</div>

</body>
</html>`);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  subscribers.delete(Number(req.body.chatId));
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, (req, res) => {
  const text = (req.body.message || "").trim();
  if (text) broadcast(`📢 ${text}`);
  res.redirect("/admin");
});

// ===============================
// TELEGRAM COMMANDS
// ===============================

bot.onText(/\/start/, (msg) => {
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

bot.on("message", async (msg) => {
  if (!msg.text) return;

  // ---------- 📊 XAUUSD SIGNAL ----------
  if (msg.text === "📊 XAUUSD Signal") {
    try {
      const price = await getGoldPrice();
      const status = pendingSetup
        ? `👀 Watching a ${pendingSetup.label} ${pendingSetup.direction.toUpperCase()} setup - waiting for retest confirmation.`
        : hasOpenSignal()
        ? "⏳ A signal is currently open - waiting for TP or SL."
        : candles.length < MIN_CANDLES
        ? `⏳ Still building candle history (${candles.length}/${MIN_CANDLES} candles). Give the bot a bit more uptime.`
        : "🔎 No active setup right now - scanning every 5 minutes.";

      await bot.sendMessage(
        msg.chat.id,
`🔎 XAUUSD MARKET CHECK

💰 Current Price: ${price.toFixed(2)}

📡 Live market data connected.

${status}

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
      bot.sendMessage(msg.chat.id, "⚠️ XAUUSD market data is temporarily unavailable.");
    }
  }

  // ---------- 💰 LIVE PRICE ----------
  if (msg.text === "💰 Live Price") {
    try {
      const price = await getGoldPrice();
      bot.sendMessage(
        msg.chat.id,
`💰 XAUUSD LIVE PRICE

🪙 ${price.toFixed(2)}

📡 Market Data: LIVE
⏱️ Updated: Just now`
      );
    } catch (error) {
      console.error("Price error:", error.message);
      bot.sendMessage(msg.chat.id, "⚠️ Unable to retrieve the current XAUUSD price.");
    }
  }

  // ---------- 🔔 AUTO SIGNALS ----------
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

Note: the bot builds its own candle history from live prices, so the first setups may take a couple of hours to appear after each restart.`
    );
  }

  // ---------- 🔕 STOP ALERTS ----------
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

  // ---------- 📖 HOW IT WORKS ----------
  if (msg.text === "📖 How It Works") {
    bot.sendMessage(
      msg.chat.id,
`📖 HOW IT WORKS

MONEY MAKING MACHINE BOT monitors XAUUSD for high-quality setups.

📈 Market Structure
A fresh BOS / CHoCH break with a strong candle

🟨 Fair Value Gap
Left behind by the breakout move

🟦 Order Block
The zone price must return to

✅ Entry Confirmation
Price retests the zone and a confirming candle closes. If price closes through the zone first, the setup is cancelled.

🎯 Target
200–300 pips

🛡️ Risk
Stop Loss sits beyond the zone with a volatility (ATR) buffer

🚨 When everything lines up, the bot sends an entry alert to everyone with Auto Signals on.`
    );
  }

  // ---------- ⚙️ SETTINGS ----------
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
BOS/CHoCH + FVG + Order Block

📉 Candles collected
${candles.length}

More settings will be added as the system develops.`
    );
  }
});

// ===============================
// MARKET MONITOR (every 10 seconds)
// ===============================

async function monitorMarket() {
  try {
    const price = await getGoldPrice();
    addTick(price);
    checkOpenSignals(price);
  } catch (error) {
    console.error("Market monitor error:", error.message);
  }
}

setInterval(monitorMarket, SAMPLE_MS);
monitorMarket();

// ===============================
// KEEP-ALIVE (Render free tier sleeps after ~15 min idle, and a
// sleep wipes the candle history). Best-effort self-ping; also point
// a free uptime pinger (e.g. UptimeRobot) at your Render URL.
// ===============================

const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL, { timeout: 10000 }).catch(() => {});
  }, 10 * 60 * 1000);
}

// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(`🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`);
});
