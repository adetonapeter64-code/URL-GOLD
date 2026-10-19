
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

app.get("/", (req, res) => res.send("🟢 DAILY BASES is running."));
app.get("/health", (req, res) => {
  res.json({
    bot: "DAILY BASES",
    status: "running",
    market: "XAUUSD",
    dailyTarget: 3
  });
});

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

if (!TOKEN || !API_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

let activeChatId = process.env.TELEGRAM_CHAT_ID || null;
let lastProcessedBucket = "";
let lastSignalTime = 0;
let lastSignalCandle = "";
let dayKey = "";
let dailySignals = [];
let wins = 0;
let losses = 0;
let paused = false;
let scanBusy = false;

const CFG = {
  symbol: "XAU/USD",
  scanSeconds: 15,
  cooldownMinutes: 60,
  dailyTarget: 3,
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  stopATR: 1.3,
  rewardRisk: 1.5,
  minBodyATR: 0.20
};

const KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: "📊 Market Status" }, { text: "📈 My Statistics" }],
      [{ text: "🏆 Mark WIN" }, { text: "❌ Mark LOSS" }],
      [{ text: "⏸️ Pause Alerts" }, { text: "▶️ Resume Alerts" }],
      [{ text: "ℹ️ Help" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

function todayKey() {
  // Nigeria local calendar date (UTC+1).
  return new Date(Date.now() + 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

function resetDailyStats() {
  const today = todayKey();
  if (today !== dayKey) {
    dayKey = today;
    dailySignals = [];
    wins = 0;
    losses = 0;
  }
}

async function reply(chatId, message) {
  try {
    return await bot.sendMessage(chatId, message, KEYBOARD);
  } catch (error) {
    console.error("❌ Telegram send error:", error.message);
  }
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    ranges.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    ));
  }

  return ranges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function aggregate(candles, minutes) {
  const buckets = new Map();
  const size = minutes * 60 * 1000;

  for (const c of candles) {
    const key = Math.floor(c.time / size) * size;
    if (!buckets.has(key)) {
      buckets.set(key, {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        count: 1
      });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.count++;
    }
  }

  const expected = minutes / 5;
  return [...buckets.values()]
    .filter(c => c.count === expected)
    .sort((a, b) => a.time - b.time);
}

async function getCandles() {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", CFG.symbol);
  url.searchParams.set("interval", "5min");
  url.searchParams.set("outputsize", "500");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Market API HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "No market candles returned");
  }

  const now = Date.now();

  const candles = data.values
    .map(v => ({
      time: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time + 5 * 60 * 1000 <= now - 5000
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 100) {
    throw new Error("Not enough closed 5-minute candles yet");
  }

  return candles;
}

function trend(candles) {
  if (candles.length < 55) return "NEUTRAL";

  const closes = candles.map(c => c.close);
  const fast = ema(closes, CFG.emaFast);
  const slow = ema(closes, CFG.emaSlow);
  const last = closes[closes.length - 1];

  if (fast > slow && last > fast) return "BULLISH";
  if (fast < slow && last < fast) return "BEARISH";
  return "NEUTRAL";
}

function findSetup(candles5) {
  const candles15 = aggregate(candles5, 15);
  const candles60 = aggregate(candles5, 60);

  if (candles15.length < 55 || candles60.length < 55) {
    return null;
  }

  const trend15 = trend(candles15);
  const trend60 = trend(candles60);

  if (trend15 === "NEUTRAL" || trend60 === "NEUTRAL") return null;
  if (trend15 !== trend60) return null;

  const closes = candles5.map(c => c.close);
  const fast = ema(closes, CFG.emaFast);
  const slow = ema(closes, CFG.emaSlow);
  const volatility = atr(candles5, CFG.atrPeriod);
  const strength = rsi(candles5, CFG.rsiPeriod);

  const last = candles5[candles5.length - 1];
  const prev = candles5[candles5.length - 2];

  if (!volatility || strength === null || volatility <= 0) return null;

  if (Math.abs(last.close - last.open) < volatility * CFG.minBodyATR) {
    return null;
  }

  const recent = candles5.slice(-6, -1);
  const nearEMA = volatility * 0.45;
  const bullishPullback = recent.some(c => c.low <= fast + nearEMA);
  const bearishPullback = recent.some(c => c.high >= fast - nearEMA);

  let side = null;

  if (
    trend15 === "BULLISH" &&
    fast > slow &&
    last.close > fast &&
    prev.close <= fast &&
    last.close > last.open &&
    bullishPullback &&
    strength >= 50 &&
    strength <= 70
  ) {
    side = "BUY";
  }

  if (
    trend15 === "BEARISH" &&
    fast < slow &&
    last.close < fast &&
    prev.close >= fast &&
    last.close < last.open &&
    bearishPullback &&
    strength >= 30 &&
    strength <= 50
  ) {
    side = "SELL";
  }

  if (!side) return null;

  const recentLow = Math.min(...candles5.slice(-5).map(c => c.low));
  const recentHigh = Math.max(...candles5.slice(-5).map(c => c.high));
  const entry = last.close;

  let sl;
  let tp;

  if (side === "BUY") {
    sl = Math.min(
      entry - volatility * CFG.stopATR,
      recentLow - volatility * 0.1
    );
    tp = entry + (entry - sl) * CFG.rewardRisk;
  } else {
    sl = Math.max(
      entry + volatility * CFG.stopATR,
      recentHigh + volatility * 0.1
    );
    tp = entry - (sl - entry) * CFG.rewardRisk;
  }

  return {
    side, entry, sl, tp,
    rsi: strength,
    atr: volatility,
    candleTime: last.time,
    trend15, trend60
  };
}

function price(n) {
  return Number(n).toFixed(2);
}

async function sendSignal(setup) {
  if (!activeChatId) {
    console.log("📩 Waiting for /start in Telegram.");
    return;
  }

  resetDailyStats();

  const message =
    `🟡🔥 DAILY BASES — XAUUSD 🔥🟡\n\n` +
    `${setup.side === "BUY" ? "🟢🚀 BUY SIGNAL 🚀🟢" : "🔴📉 SELL SIGNAL 📉🔴"}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 Entry: ${price(setup.entry)}\n` +
    `🛑 Stop Loss: ${price(setup.sl)}\n` +
    `🎯 Take Profit: ${price(setup.tp)}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏰ Entry timeframe: M5\n` +
    `📊 1H trend: ${setup.trend60}\n` +
    `📈 15M trend: ${setup.trend15}\n` +
    `💪 RSI: ${setup.rsi.toFixed(1)}\n` +
    `⚖️ Risk/Reward: 1:${CFG.rewardRisk}\n\n` +
    `📅 Today's signals: ${dailySignals.length + 1}\n` +
    `🎯 Daily target: ${CFG.dailyTarget}\n\n` +
    `⚠️ Verify the live price with your broker before entering.\n` +
    `🛡️ Risk management is essential. No profit is guaranteed.`;

  await reply(activeChatId, message);

  dailySignals.push({
    ...setup,
    outcome: "PENDING",
    sentAt: Date.now()
  });

  lastSignalTime = Date.now();
  lastSignalCandle = String(setup.candleTime);

  console.log(`📨 Sent ${setup.side} signal at ${price(setup.entry)}`);
}

async function scan() {
  resetDailyStats();

  if (paused || scanBusy) return;

  const now = new Date();

  if (now.getUTCMinutes() % 5 !== 0 || now.getUTCSeconds() < 20) {
    return;
  }

  const bucket =
    `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-` +
    `${now.getUTCHours()}-${Math.floor(now.getUTCMinutes() / 5)}`;

  if (bucket === lastProcessedBucket) return;
  lastProcessedBucket = bucket;
  scanBusy = true;

  try {
    const candles = await getCandles();
    const setup = findSetup(candles);

    if (!setup) {
      console.log("🔎 No valid setup found on this scan.");
      return;
    }

    if (String(setup.candleTime) === lastSignalCandle) {
      console.log("🔁 Duplicate signal skipped.");
      return;
    }

    if (Date.now() - lastSignalTime < CFG.cooldownMinutes * 60 * 1000) {
      console.log("⏳ Setup skipped: cooldown is active.");
      return;
    }

    await sendSignal(setup);
  } catch (error) {
    console.error("⚠️ Market scan error:", error.message);
  } finally {
    scanBusy = false;
  }
}

function statsMessage() {
  resetDailyStats();

  const pending = dailySignals.filter(s => s.outcome === "PENDING").length;
  const completed = wins + losses;
  const rate = completed ? (wins / completed * 100).toFixed(1) : "0.0";

  return (
    `📊🔥 DAILY BASES RESULTS 🔥📊\n\n` +
    `📨 Signals sent: ${dailySignals.length}\n` +
    `🎯 Daily target: ${CFG.dailyTarget}\n` +
    `🏆 Wins marked: ${wins}\n` +
    `❌ Losses marked: ${losses}\n` +
    `⏳ Pending: ${pending}\n` +
    `📈 Recorded win rate: ${rate}%\n\n` +
    `ℹ️ Results are based on signals marked manually.`
  );
}

async function markOutcome(chatId, outcome) {
  resetDailyStats();

  const signal = [...dailySignals].reverse().find(
    s => s.outcome === "PENDING"
  );

  if (!signal) {
    await reply(chatId, "⚠️ No pending signal is available to update.");
    return;
  }

  signal.outcome = outcome;

  if (outcome === "WIN") wins++;
  else losses++;

  await reply(
    chatId,
    outcome === "WIN"
      ? "🏆✅ Latest pending signal marked as WIN!"
      : "❌📉 Latest pending signal marked as LOSS."
  );
}

async function handleAction(msg, action) {
  const chatId = msg.chat.id;

  switch (action) {
    case "📊 Market Status":
    case "/status":
      resetDailyStats();
      await reply(
        chatId,
        `🟡📊 DAILY BASES STATUS 📊🟡\n\n` +
        `🪙 Market: XAUUSD\n` +
        `⏱️ Timeframes: 1H + 15M + 5M\n` +
        `🔔 Alerts: ${paused ? "⏸️ PAUSED" : "🟢 ACTIVE"}\n` +
        `🎯 Daily target: ${CFG.dailyTarget} setups\n` +
        `📨 Signals sent today: ${dailySignals.length}\n` +
        `🌙 Overnight scanning: Enabled while service and market data are available.`
      );
      break;

    case "📈 My Statistics":
    case "/stats":
      await reply(chatId, statsMessage());
      break;

    case "🏆 Mark WIN":
    case "/win":
      await markOutcome(chatId, "WIN");
      break;

    case "❌ Mark LOSS":
    case "/loss":
      await markOutcome(chatId, "LOSS");
      break;

    case "⏸️ Pause Alerts":
    case "/pause":
      paused = true;
      await reply(chatId, "⏸️🔕 DAILY BASES alerts are now paused.");
      break;

    case "▶️ Resume Alerts":
    case "/resume":
      paused = false;
      await reply(chatId, "▶️🔔 DAILY BASES alerts have resumed.");
      break;

    case "ℹ️ Help":
    case "/help":
      await reply(
        chatId,
        `ℹ️🤖 DAILY BASES HELP 🤖ℹ️\n\n` +
        `📊 Market Status — Check the bot\n` +
        `📈 My Statistics — View today's results\n` +
        `🏆 Mark WIN — Record a winning signal\n` +
        `❌ Mark LOSS — Record a losing signal\n` +
        `⏸️ Pause Alerts — Stop new alerts\n` +
        `▶️ Resume Alerts — Restart alerts\n\n` +
        `⚠️ Signals are alerts, not guaranteed profits.`
      );
      break;
  }
}

bot.onText(/\/start/, async msg => {
  activeChatId = String(msg.chat.id);

  await reply(
    activeChatId,
    `👋🔥 WELCOME TO DAILY BASES! 🔥👋\n\n` +
    `🪙 Market: XAUUSD Gold\n` +
    `⚡ Strategy: Fast but filtered entries\n` +
    `📊 Analysis: 1H + 15M + 5M\n` +
    `🎯 Daily target: 3 valid setups when available\n` +
    `🌙 Overnight monitoring: Enabled\n\n` +
    `👇 Use the emoji buttons below to control your bot.\n\n` +
    `⚠️ Setups and profits are not guaranteed.`
  );
});

bot.on("message", async msg => {
  if (!msg.text) return;

  const action = msg.text.trim();

  if (action === "/start") return;

  const actions = [
    "📊 Market Status", "📈 My Statistics",
    "🏆 Mark WIN", "❌ Mark LOSS",
    "⏸️ Pause Alerts", "▶️ Resume Alerts",
    "ℹ️ Help", "/status", "/stats",
    "/win", "/loss", "/pause", "/resume", "/help"
  ];

  if (actions.includes(action)) {
    try {
      await handleAction(msg, action);
    } catch (error) {
      console.error("❌ Button action error:", error.message);
      await reply(msg.chat.id, "⚠️ Something went wrong. Please try again.");
    }
  }
});

bot.on("polling_error", error => {
  console.error("⚠️ Telegram polling error:", error.message);
});

app.listen(PORT, () => {
  console.log(`🟢 DAILY BASES web server listening on port ${PORT}`);
});

setInterval(scan, CFG.scanSeconds * 1000);
console.log("🚀 DAILY BASES started.");
