
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.get("/", (req, res) => res.send("DAILY BASES is running."));
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
  console.error("Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_API_KEY");
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
  if (!response.ok) throw new Error(`Market API HTTP ${response.status}`);

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

  if (trend15 === "NEUTRAL" || trend60 === "NEUTRAL") {
    return null;
  }

  if (trend15 !== trend60) return null;

  const closes = candles5.map(c => c.close);
  const fast = ema(closes, CFG.emaFast);
  const slow = ema(closes, CFG.emaSlow);
  const volatility = atr(candles5, CFG.atrPeriod);
  const strength = rsi(candles5, CFG.rsiPeriod);

  const last = candles5[candles5.length - 1];
  const prev = candles5[candles5.length - 2];

  if (!volatility || !strength || volatility <= 0) return null;
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
    sl = Math.min(entry - volatility * CFG.stopATR, recentLow - volatility * 0.1);
    const risk = entry - sl;
    tp = entry + risk * CFG.rewardRisk;
  } else {
    sl = Math.max(entry + volatility * CFG.stopATR, recentHigh + volatility * 0.1);
    const risk = sl - entry;
    tp = entry - risk * CFG.rewardRisk;
  }

  return {
    side,
    entry,
    sl,
    tp,
    rsi: strength,
    atr: volatility,
    candleTime: last.time,
    trend15,
    trend60
  };
}

function price(n) {
  return Number(n).toFixed(2);
}

async function sendSignal(setup) {
  if (!activeChatId) {
    console.log("Waiting for a user to send /start in Telegram.");
    return;
  }

  resetDailyStats();

  const message =
    `🟡 DAILY BASES — XAUUSD\n\n` +
    `📣 SIGNAL: ${setup.side}\n` +
    `💰 Entry: ${price(setup.entry)}\n` +
    `🛑 Stop Loss: ${price(setup.sl)}\n` +
    `🎯 Take Profit: ${price(setup.tp)}\n\n` +
    `📊 1H trend: ${setup.trend60}\n` +
    `📊 15M trend: ${setup.trend15}\n` +
    `⚡ Entry: 5M pullback confirmation\n` +
    `RSI: ${setup.rsi.toFixed(1)}\n` +
    `Risk/reward: 1:${CFG.rewardRisk}\n\n` +
    `📅 Today's signals: ${dailySignals.length + 1}\n` +
    `⚠️ Confirm the live price with your broker before entering.`;

  await bot.sendMessage(activeChatId, message);

  dailySignals.push({
    ...setup,
    outcome: "PENDING",
    sentAt: Date.now()
  });

  lastSignalTime = Date.now();
  lastSignalCandle = String(setup.candleTime);
  console.log(`Sent ${setup.side} signal at ${price(setup.entry)}`);
}

async function scan() {
  resetDailyStats();

  if (paused) return;

  const now = new Date();

  // Only request data once per 5-minute period, after the candle closes.
  if (now.getUTCMinutes() % 5 !== 0 || now.getUTCSeconds() < 20) {
    return;
  }

  const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${Math.floor(now.getUTCMinutes() / 5)}`;

  if (bucket === lastProcessedBucket) return;
  lastProcessedBucket = bucket;

  try {
    const candles = await getCandles();
    const setup = findSetup(candles);

    if (!setup) {
      console.log("No valid setup on this scan.");
      return;
    }

    if (String(setup.candleTime) === lastSignalCandle) return;

    if (Date.now() - lastSignalTime < CFG.cooldownMinutes * 60 * 1000) {
      console.log("Setup skipped: cooldown is active.");
      return;
    }

    await sendSignal(setup);
  } catch (error) {
    console.error("Scan error:", error.message);
  }
}

bot.onText(/\/start/, async msg => {
  activeChatId = String(msg.chat.id);

  await bot.sendMessage(
    activeChatId,
    "🟡 Welcome to DAILY BASES!\n\n" +
    "Automatic XAUUSD signal monitoring is enabled.\n" +
    "Target: 3 valid setups daily, when available.\n\n" +
    "/status — Bot status\n" +
    "/stats — Daily results\n" +
    "/win — Mark latest pending signal WIN\n" +
    "/loss — Mark latest pending signal LOSS\n" +
    "/pause — Pause alerts\n" +
    "/resume — Resume alerts\n\n" +
    "Keep in mind: signals are not guaranteed to win."
  );
});

bot.onText(/\/status/, msg => {
  bot.sendMessage(
    msg.chat.id,
    `🟡 DAILY BASES STATUS\n\n` +
    `Market: XAUUSD\n` +
    `Strategy: 1H + 15M + 5M\n` +
    `Alerts: ${paused ? "PAUSED" : "ACTIVE"}\n` +
    `Today's target: ${CFG.dailyTarget} setups\n` +
    `Signals sent today: ${dailySignals.length}`
  );
});

bot.onText(/\/stats/, msg => {
  resetDailyStats();

  bot.sendMessage(
    msg.chat.id,
    `📊 DAILY BASES RESULTS\n\n` +
    `Signals sent: ${dailySignals.length}\n` +
    `Wins marked: ${wins}\n` +
    `Losses marked: ${losses}\n` +
    `Pending: ${dailySignals.filter(s => s.outcome === "PENDING").length}\n` +
    `Win rate: ${wins + losses ? (wins / (wins + losses) * 100).toFixed(1) : 0}%\n\n` +
    `WIN/LOSS results are recorded when you mark them.`
  );
});

async function markOutcome(msg, outcome) {
  resetDailyStats();

  const signal = [...dailySignals].reverse().find(s => s.outcome === "PENDING");

  if (!signal) {
    return bot.sendMessage(msg.chat.id, "No pending signal to update.");
  }

  signal.outcome = outcome;
  if (outcome === "WIN") wins++;
  else losses++;

  await bot.sendMessage(msg.chat.id, `Latest pending signal marked ${outcome}.`);
}

bot.onText(/\/win/, msg => markOutcome(msg, "WIN"));
bot.onText(/\/loss/, msg => markOutcome(msg, "LOSS"));

bot.onText(/\/pause/, async msg => {
  paused = true;
  await bot.sendMessage(msg.chat.id, "⏸ DAILY BASES alerts paused.");
});

bot.onText(/\/resume/, async msg => {
  paused = false;
  await bot.sendMessage(msg.chat.id, "▶️ DAILY BASES alerts resumed.");
});

bot.on("polling_error", error => {
  console.error("Telegram polling error:", error.message);
});

app.listen(PORT, () => {
  console.log(`DAILY BASES web server listening on ${PORT}`);
});

setInterval(scan, CFG.scanSeconds * 1000);
console.log("DAILY BASES started.");
