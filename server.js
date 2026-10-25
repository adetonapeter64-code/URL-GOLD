const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Add it in Render → Environment.");
  process.exit(1);
}

app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on("polling_error", (err) => console.error("[Telegram polling]", err.message));

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

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = []; // newest first; stored in memory only
const MAX_SIGNAL_HISTORY = 100;
const MAX_CANDLES = 300;
const TICKS_PER_CANDLE = 10; // 10 samples × 30 seconds = one synthetic 5-minute candle
const PIP_SIZE = 0.1;
const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000;
const PRICE_INTERVAL_MS = 30 * 1000;

let currentTicks = [];
let candles = [];
let pendingSetup = null;
let lastSignalTime = 0;
let lastPrice = null;
let lastPriceAt = null;
let monitorBusy = false;
const startedAt = Date.now();

function formatUptime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function money(value) {
  return Number(value).toFixed(2);
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("🔥 MONEY MAKING MACHINE BOT is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: formatUptime(Date.now() - startedAt),
    price: lastPrice,
    priceUpdatedAt: lastPriceAt ? new Date(lastPriceAt).toISOString() : null,
    candles: candles.length,
    subscribers: subscribers.size
  });
});

async function getGoldPrice() {
  const endpoints = [
    async () => {
      const response = await axios.get("https://xaus.com/api/v1/spot?compact=1", { timeout: 10000 });
      const value = Number(response.data?.xau?.price);
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid xaus.com price response");
      return value;
    },
    async () => {
      const response = await axios.get("https://api.gold-api.com/price/XAU", { timeout: 10000 });
      const value = Number(response.data?.price);
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid gold-api.com price response");
      return value;
    }
  ];
  let lastError;
  for (const getPrice of endpoints) {
    try {
      return await getPrice();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All gold price providers failed");
}

function addTick(price) {
  currentTicks.push(price);
  if (currentTicks.length < TICKS_PER_CANDLE) return;
  const open = currentTicks[0];
  const close = currentTicks[currentTicks.length - 1];
  const high = Math.max(...currentTicks);
  const low = Math.min(...currentTicks);
  candles.push({ open, high, low, close, time: Date.now() });
  if (candles.length > MAX_CANDLES) candles.shift();
  currentTicks = [];
  analyzeMarket();
}

function findSwings(lookback = 2) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const section = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    const isHigh = section.every((item) => item.high <= c.high);
    const isLow = section.every((item) => item.low >= c.low);
    if (isHigh) swings.push({ index: i, price: c.high, type: "high" });
    if (isLow) swings.push({ index: i, price: c.low, type: "low" });
  }
  return swings.sort((a, b) => a.index - b.index);
}

function findFVG(startIndex, direction) {
  for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
    const first = candles[i - 2];
    const third = candles[i];
    if (direction === "bullish" && first.high < third.low) {
      return { top: third.low, bottom: first.high, index: i };
    }
    if (direction === "bearish" && first.low > third.high) {
      return { top: first.low, bottom: third.high, index: i };
    }
  }
  return null;
}

function findOrderBlock(index, direction) {
  for (let i = index; i >= 0 && i >= index - 6; i--) {
    const c = candles[i];
    if (direction === "bullish" && c.close < c.open) return { top: c.high, bottom: c.low, index: i };
    if (direction === "bearish" && c.close > c.open) return { top: c.high, bottom: c.low, index: i };
  }
  return null;
}

function hasOpenSignal() {
  return signalHistory.some((signal) => signal.status === "open");
}

function analyzeMarket() {
  if (candles.length < 20 || hasOpenSignal()) return;
  const swings = findSwings(2);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return;

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const structureBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const structureBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;
  const latestIndex = candles.length - 1;
  const latestClose = candles[latestIndex].close;

  if (!pendingSetup && latestClose > lastHigh.price) {
    const fvg = findFVG(latestIndex, "bullish");
    if (fvg) {
      pendingSetup = {
        direction: "bullish",
        label: structureBullish ? "BOS" : "CHoCH",
        fvg,
        orderBlock: findOrderBlock(fvg.index, "bullish"),
        structureLow: lastLow.price,
        createdAt: Date.now()
      };
      console.log(`[SETUP] Bullish ${pendingSetup.label} detected at ${money(latestClose)}`);
    }
  } else if (!pendingSetup && latestClose < lastLow.price) {
    const fvg = findFVG(latestIndex, "bearish");
    if (fvg) {
      pendingSetup = {
        direction: "bearish",
        label: structureBearish ? "BOS" : "CHoCH",
        fvg,
        orderBlock: findOrderBlock(fvg.index, "bearish"),
        structureHigh: lastHigh.price,
        createdAt: Date.now()
      };
      console.log(`[SETUP] Bearish ${pendingSetup.label} detected at ${money(latestClose)}`);
    }
  }

  if (!pendingSetup) return;
  if (Date.now() - pendingSetup.createdAt > SETUP_EXPIRY_MS) {
    console.log("[SETUP] Expired without confirmation");
    pendingSetup = null;
    return;
  }

  const zone = pendingSetup.orderBlock || pendingSetup.fvg;
  const latest = candles[latestIndex];
  const priceInZone = latest.low <= zone.top && latest.high >= zone.bottom;
  const bullishConfirm = pendingSetup.direction === "bullish" && latest.close > latest.open;
  const bearishConfirm = pendingSetup.direction === "bearish" && latest.close < latest.open;
  if (priceInZone && (bullishConfirm || bearishConfirm)) {
    fireSignal(pendingSetup, latest.close);
    pendingSetup = null;
  }
}

function fireSignal(setup, entryPrice) {
  if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    console.log("[SIGNAL] Skipped because cooldown is active");
    return;
  }
  const direction = setup.direction === "bullish" ? "BUY" : "SELL";
  const tpDistance = ((TP_PIPS_MIN + TP_PIPS_MAX) / 2) * PIP_SIZE;
  let stopLoss;
  let takeProfit;
  if (setup.direction === "bullish") {
    stopLoss = (setup.orderBlock ? setup.orderBlock.bottom : setup.structureLow) - 1;
    takeProfit = entryPrice + tpDistance;
  } else {
    stopLoss = (setup.orderBlock ? setup.orderBlock.top : setup.structureHigh) + 1;
    takeProfit = entryPrice - tpDistance;
  }

  const signal = {
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
  };
  signalHistory.unshift(signal);
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();
  lastSignalTime = Date.now();

  const emoji = direction === "BUY" ? "🟢" : "🔴";
  const message = `${emoji} 🚨 XAUUSD ${direction} SIGNAL — ${setup.label}

Entry: ${money(entryPrice)}
Stop Loss: ${money(stopLoss)}
Take Profit: ${money(takeProfit)}
Target guide: ${TP_PIPS_MIN}–${TP_PIPS_MAX} pips

Confirmation: market structure break + FVG + zone retest + candle confirmation.

⚠️ This is an automated technical alert, not financial advice. Losses are possible. Verify the price and risk before trading.`;
  console.log(`[SIGNAL] ${direction} at ${money(entryPrice)}`);
  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, message).catch((err) => console.error(`[Telegram] Signal delivery failed for ${chatId}:`, err.message));
  }
}

function checkOpenSignals(currentPrice) {
  for (const signal of signalHistory.filter((item) => item.status === "open")) {
    const hitTP = signal.direction === "BUY" ? currentPrice >= signal.takeProfit : currentPrice <= signal.takeProfit;
    const hitSL = signal.direction === "BUY" ? currentPrice <= signal.stopLoss : currentPrice >= signal.stopLoss;
    if (!hitTP && !hitSL) continue;
    signal.status = hitSL ? "loss" : "win"; // conservative if both conditions are met on one sampled tick
    signal.closedAt = Date.now();
    signal.closePrice = currentPrice;
    lastSignalTime = Date.now();
    const won = signal.status === "win";
    const closeMessage = `${won ? "✅" : "❌"} XAUUSD SIGNAL CLOSED — ${won ? "TAKE PROFIT HIT" : "STOP LOSS HIT"}

Direction: ${signal.direction}
Entry: ${money(signal.entryPrice)}
Observed price: ${money(currentPrice)}
Result: ${won ? "Target level reached" : "Stop-loss level reached"}

Note: outcomes are based on sampled prices; fast movements between samples may be missed.`;
    console.log(`[SIGNAL CLOSED] ${signal.direction} ${signal.status.toUpperCase()} at ${money(currentPrice)}`);
    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, closeMessage).catch((err) => console.error(`[Telegram] Result delivery failed for ${chatId}:`, err.message));
    }
  }
}

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  try {
    await bot.sendMessage(msg.chat.id, `🔥 MONEY MAKING MACHINE BOT

Welcome! 👋
Your XAUUSD market-alert assistant.

📊 Market checks
🚨 Entry alerts
🎯 Suggested target levels
🛡️ Stop-loss levels

Choose an option below.`, mainMenu);
  } catch (err) {
    console.error("[/start]", err.message);
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/start")) return;
  const chatId = String(msg.chat.id);
  try {
    if (msg.text === "📊 XAUUSD Signal") {
      const price = await getGoldPrice();
      lastPrice = price;
      lastPriceAt = Date.now();
      const status = pendingSetup
        ? `Watching ${pendingSetup.label} ${pendingSetup.direction.toUpperCase()} setup; waiting for retest confirmation.`
        : candles.length < 20
          ? `Building sampled candle history (${candles.length}/20 complete candles).`
          : "No active setup right now; scanning as new candles close.";
      await bot.sendMessage(chatId, `🔎 XAUUSD MARKET CHECK

Current price: ${money(price)}
Data: latest spot price
Status: ${status}

The bot uses sampled prices to construct its own 5-minute candles. This is not broker candle history.`, mainMenu);
    } else if (msg.text === "💰 Live Price") {
      const price = await getGoldPrice();
      lastPrice = price;
      lastPriceAt = Date.now();
      await bot.sendMessage(chatId, `💰 XAUUSD LIVE PRICE\n\n${money(price)}\nUpdated: ${new Date().toLocaleString()}`, mainMenu);
    } else if (msg.text === "🔔 Auto Signals") {
      subscribers.set(chatId, {
        username: msg.from?.username || null,
        firstName: msg.from?.first_name || "Unknown",
        joinedAt: subscribers.get(chatId)?.joinedAt || Date.now()
      });
      await bot.sendMessage(chatId, `🔔 Automatic alerts enabled.

You will receive XAUUSD alerts when the bot detects a setup. This service does not guarantee profitable trades. The first setup may take time because candle history is built from live samples.`, mainMenu);
    } else if (msg.text === "🔕 Stop Alerts") {
      subscribers.delete(chatId);
      await bot.sendMessage(chatId, "🔕 Automatic alerts stopped. You can enable them again anytime.", mainMenu);
    } else if (msg.text === "📖 How It Works") {
      await bot.sendMessage(chatId, `📖 HOW IT WORKS

The signal logic checks:
• Swing highs and lows for market structure
• Break of Structure (BOS) / Change of Character (CHoCH)
• Fair Value Gap (FVG)
• A possible opposite-candle order block
• Retest and candle-direction confirmation

The bot samples a spot-price API every 30 seconds and groups 10 samples into a synthetic 5-minute candle. It does not use broker candles or tick-by-tick prices, so signals can be delayed or inaccurate. Please test on demo first.`, mainMenu);
    } else if (msg.text === "⚙️ Settings") {
      await bot.sendMessage(chatId, `⚙️ SETTINGS

Symbol: XAUUSD
Analysis: sampled synthetic 5-minute candles
Target guide: ${TP_PIPS_MIN}–${TP_PIPS_MAX} pips
Automatic alerts: available
History: ${candles.length} candles currently collected

These are technical alerts only, not guaranteed trade outcomes.`, mainMenu);
    }
  } catch (err) {
    console.error(`[Telegram message] ${err.message}`);
    try {
      await bot.sendMessage(chatId, "⚠️ The request failed temporarily. Please try again shortly.", mainMenu);
    } catch {}
  }
});

async function monitorMarket() {
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    const price = await getGoldPrice();
    lastPrice = price;
    lastPriceAt = Date.now();
    addTick(price);
    checkOpenSignals(price);
    console.log(`[MARKET] XAUUSD ${money(price)} | ticks ${currentTicks.length}/${TICKS_PER_CANDLE} | candles ${candles.length}`);
  } catch (err) {
    console.error("[Market monitor]", err.message);
  } finally {
    monitorBusy = false;
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`);
  monitorMarket();
  setInterval(monitorMarket, PRICE_INTERVAL_MS);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled rejection]", reason);
});
