"use strict";

/**
 * BOT.XAU Sniper Entry
 * XAU/USD supply-demand scanner: 1D + 4H zones, 15M confirmation.
 * Sends alerts only; it does NOT place broker orders.
 *
 * Data: Twelve Data /time_series
 * Hosting: Render Web Service
 */

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const SYMBOL = "XAU/USD";
const SCAN_INTERVAL_MINUTES = Math.max(5, Number(process.env.SCAN_INTERVAL_MINUTES || 15));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");
const ZONE_TOLERANCE_PCT = Number(process.env.ZONE_TOLERANCE_PCT || 0.20);
const MIN_RR = Number(process.env.MIN_RR || 2);
const MAX_OPEN_SIGNALS = Number(process.env.MAX_OPEN_SIGNALS || 5);

if (!TWELVE_DATA_KEY) console.warn("⚠️ TWELVE_DATA_KEY is missing.");
if (!TELEGRAM_BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing.");

let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));
}

const state = {
  signals: [],
  seen: {},
  lastScanAt: null,
  lastScanStatus: "starting",
  lastError: null,
  lastPrice: null
};

function ensureDataDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}
function loadState() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state.signals = Array.isArray(saved.signals) ? saved.signals : [];
      state.seen = saved.seen && typeof saved.seen === "object" ? saved.seen : {};
      state.lastScanAt = saved.lastScanAt || null;
      state.lastScanStatus = saved.lastScanStatus || "loaded";
      state.lastError = saved.lastError || null;
      state.lastPrice = Number.isFinite(saved.lastPrice) ? saved.lastPrice : null;
    }
  } catch (err) {
    console.error("Could not load saved state:", err.message);
  }
}
function saveState() {
  try {
    ensureDataDir();
    const temp = DATA_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, DATA_FILE);
  } catch (err) {
    console.error("Could not save state:", err.message);
  }
}
loadState();

function fmt(n) {
  return Number(n).toFixed(2);
}
function isoNow() {
  return new Date().toISOString();
}
function parseDate(s) {
  // Twelve Data usually returns "YYYY-MM-DD HH:mm:ss"; interpret as UTC.
  const normalized = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
  return new Date(normalized.endsWith("Z") ? normalized : normalized + "Z");
}
function candleIntervalMs(interval) {
  return ({ "15min": 15 * 60e3, "4h": 4 * 60 * 60e3, "1day": 24 * 60 * 60e3 })[interval];
}
function normalizeCandles(values, interval) {
  const now = Date.now();
  const duration = candleIntervalMs(interval);
  return (values || [])
    .map(v => ({
      time: v.datetime,
      ts: parseDate(v.datetime).getTime(),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close)
    }))
    .filter(c => Number.isFinite(c.ts) && [c.open, c.high, c.low, c.close].every(Number.isFinite))
    // Exclude the still-forming candle to avoid look-ahead/repainting.
    .filter(c => c.ts + duration <= now - 5000)
    .sort((a, b) => a.ts - b.ts);
}

async function getCandles(interval, outputsize = 180) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({
    symbol: SYMBOL,
    interval,
    outputsize: String(outputsize),
    timezone: "UTC",
    order: "desc",
    apikey: TWELVE_DATA_KEY
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status} (${interval})`);
  const data = await response.json();
  if (!Array.isArray(data.values)) {
    throw new Error(`Twelve Data ${interval}: ${data.message || data.code || "no candle values returned"}`);
  }
  const candles = normalizeCandles(data.values, interval);
  if (candles.length < 40) throw new Error(`Not enough closed ${interval} candles (${candles.length}). Check symbol/API access.`);
  return candles;
}

function averageRange(candles, endIndex, length = 14) {
  const start = Math.max(0, endIndex - length + 1);
  const ranges = candles.slice(start, endIndex + 1).map(c => c.high - c.low).filter(x => x > 0);
  if (!ranges.length) return 0;
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}
function isPivotHigh(candles, i, left = 2, right = 2) {
  if (i < left || i + right >= candles.length) return false;
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && candles[j].high >= candles[i].high) return false;
  }
  return true;
}
function isPivotLow(candles, i, left = 2, right = 2) {
  if (i < left || i + right >= candles.length) return false;
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && candles[j].low <= candles[i].low) return false;
  }
  return true;
}

/**
 * Find recent base candles followed by displacement.
 * Demand: a bearish/base candle before strong bullish movement.
 * Supply: a bullish/base candle before strong bearish movement.
 * This is a transparent heuristic, not a guaranteed institutional-zone detector.
 */
function findZones(candles, timeframe, maxZones = 8) {
  const zones = [];
  const end = candles.length - 1;
  const lookback = timeframe === "1D" ? 100 : 130;
  const start = Math.max(3, end - lookback);
  for (let i = start; i <= end - 2; i++) {
    const base = candles[i];
    const avg = averageRange(candles, Math.max(0, i - 14), 14) || (base.high - base.low);
    const body = Math.abs(base.close - base.open);
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];
    const moveUp = Math.max(next1.close, next2.close) - base.high;
    const moveDown = base.low - Math.min(next1.close, next2.close);
    const strongUp = moveUp >= Math.max(avg * 1.25, body * 1.5);
    const strongDown = moveDown >= Math.max(avg * 1.25, body * 1.5);

    if (strongUp) {
      const zone = {
        type: "demand", tf: timeframe, low: base.low,
        high: Math.max(base.open, base.close), time: base.time, ts: base.ts
      };
      if (!zones.some(z => z.type === zone.type && Math.abs(z.low - zone.low) < avg * 0.2)) zones.push(zone);
    }
    if (strongDown) {
      const zone = {
        type: "supply", tf: timeframe, low: Math.min(base.open, base.close),
        high: base.high, time: base.time, ts: base.ts
      };
      if (!zones.some(z => z.type === zone.type && Math.abs(z.high - zone.high) < avg * 0.2)) zones.push(zone);
    }
  }
  // Recent zones first, then discard zones already decisively invalidated.
  return zones
    .sort((a, b) => b.ts - a.ts)
    .filter(z => {
      const later = candles.filter(c => c.ts > z.ts);
      if (z.type === "demand") return !later.some(c => c.close < z.low);
      return !later.some(c => c.close > z.high);
    })
    .slice(0, maxZones);
}

function priceInZone(price, zone) {
  const pad = price * (ZONE_TOLERANCE_PCT / 100);
  return price >= zone.low - pad && price <= zone.high + pad;
}
function findRecentSwing(candles, type, lookback = 12) {
  const end = candles.length - 2;
  const start = Math.max(2, end - lookback);
  for (let i = end; i >= start; i--) {
    if (type === "high" && isPivotHigh(candles, i, 1, 1)) return { price: candles[i].high, index: i, time: candles[i].time };
    if (type === "low" && isPivotLow(candles, i, 1, 1)) return { price: candles[i].low, index: i, time: candles[i].time };
  }
  const section = candles.slice(start, end + 1);
  if (!section.length) return null;
  if (type === "high") {
    const c = section.reduce((a, b) => a.high > b.high ? a : b);
    return { price: c.high, index: candles.indexOf(c), time: c.time };
  }
  const c = section.reduce((a, b) => a.low < b.low ? a : b);
  return { price: c.low, index: candles.indexOf(c), time: c.time };
}

/**
 * 15M confirmation:
 * - price has swept a recent swing level and closed back through it;
 * - the latest closed candle breaks the opposite-side short-term structure.
 */
function confirmation(candles, direction) {
  const end = candles.length - 1;
  if (end < 25) return null;
  const last = candles[end];
  const prior = candles.slice(Math.max(0, end - 14), end);
  const avg = averageRange(candles, end - 1, 14);
  const body = Math.abs(last.close - last.open);
  if (avg <= 0 || body < avg * 0.25) return null;

  if (direction === "BUY") {
    const priorLow = Math.min(...prior.map(c => c.low));
    const swept = prior.some(c => c.low < priorLow) || last.low < priorLow;
    const swingHigh = Math.max(...candles.slice(Math.max(0, end - 8), end).map(c => c.high));
    const structureBreak = last.close > swingHigh;
    const bullish = last.close > last.open;
    if (last.low < priorLow && last.close > priorLow && structureBreak && bullish) {
      return { candle: last, sweep: last.low, structure: swingHigh, label: "Liquidity sweep + bullish BOS/CHOCH" };
    }
  } else {
    const priorHigh = Math.max(...prior.map(c => c.high));
    const swingLow = Math.min(...candles.slice(Math.max(0, end - 8), end).map(c => c.low));
    const structureBreak = last.close < swingLow;
    const bearish = last.close < last.open;
    if (last.high > priorHigh && last.close < priorHigh && structureBreak && bearish) {
      return { candle: last, sweep: last.high, structure: swingLow, label: "Liquidity sweep + bearish BOS/CHOCH" };
    }
  }
  return null;
}

function zoneConfluence(zones1d, zones4h, price, type) {
  const candidates = [
    ...zones1d.filter(z => z.type === type && priceInZone(price, z)),
    ...zones4h.filter(z => z.type === type && priceInZone(price, z))
  ];
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const rank = z => (z.tf === "1D" ? 2 : 1);
    return rank(b) - rank(a) || b.ts - a.ts;
  });
  return candidates[0];
}

function createSignal(direction, candle15, zone, confirm) {
  const entry = candle15.close;
  const buffer = Math.max(entry * 0.0008, (candle15.high - candle15.low) * 0.25);
  const stop = direction === "BUY" ? Math.min(confirm.sweep, zone.low) - buffer : Math.max(confirm.sweep, zone.high) + buffer;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0 || risk / entry > 0.02) return null;
  const tp1 = direction === "BUY" ? entry + risk * Math.max(2, MIN_RR) : entry - risk * Math.max(2, MIN_RR);
  const tp2 = direction === "BUY" ? entry + risk * 3 : entry - risk * 3;
  return {
    id: `${direction}-${zone.tf}-${zone.ts}-${candle15.ts}`,
    symbol: SYMBOL,
    direction,
    status: "OPEN",
    createdAt: isoNow(),
    entryTime: candle15.time,
    entry,
    stopLoss: stop,
    takeProfit1: tp1,
    takeProfit2: tp2,
    initialRisk: risk,
    zone: { tf: zone.tf, type: zone.type, low: zone.low, high: zone.high, time: zone.time },
    confirmation: confirm.label,
    result: null,
    hitTP1: false,
    closedAt: null,
    exitPrice: null
  };
}

function signalMessage(s) {
  const emoji = s.direction === "BUY" ? "🟢📈" : "🔴📉";
  return [
    "🎯 *BOT.XAU — SNIPER ENTRY*",
    "",
    `${emoji} *${s.direction} XAU/USD*`,
    `💵 Entry: \`${fmt(s.entry)}\``,
    `🛑 Stop Loss: \`${fmt(s.stopLoss)}\``,
    `🎯 Take Profit 1: \`${fmt(s.takeProfit1)}\` (${Math.max(2, MIN_RR)}R)`,
    `🚀 Take Profit 2: \`${fmt(s.takeProfit2)}\` (3R)`,
    "",
    `🧭 Zone: ${s.zone.tf} ${s.zone.type.toUpperCase()}`,
    `📍 Zone range: ${fmt(s.zone.low)} – ${fmt(s.zone.high)}`,
    `💧 Confirmation: ${s.confirmation}`,
    `⏱️ Entry candle: ${s.entryTime} UTC`,
    "",
    "⚠️ Signal only — no broker order placed. Confirm spread and execution before trading."
  ].join("\n");
}

async function sendTelegram(message, chatId = TELEGRAM_CHAT_ID) {
  if (!bot) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is missing. Set it in Render Environment.");
  return bot.sendMessage(chatId, message, { parse_mode: "Markdown", disable_web_page_preview: true });
}
async function broadcastSignal(signal) {
  if (!TELEGRAM_CHAT_ID) {
    console.warn("Signal found but TELEGRAM_CHAT_ID is missing; not sent.");
    return false;
  }
  try {
    await sendTelegram(signalMessage(signal));
    return true;
  } catch (err) {
    console.error("Telegram signal send failed:", err.message);
    return false;
  }
}

async function updateOpenSignals(candles15) {
  const latest = candles15[candles15.length - 1];
  for (const s of state.signals.filter(x => x.status === "OPEN")) {
    // Don't evaluate the same 15M candle repeatedly.
    if (s.lastEvaluatedCandle === latest.time) continue;
    s.lastEvaluatedCandle = latest.time;
    const stopHit = s.direction === "BUY" ? latest.low <= s.stopLoss : latest.high >= s.stopLoss;
    const tp1Hit = s.direction === "BUY" ? latest.high >= s.takeProfit1 : latest.low <= s.takeProfit1;
    const tp2Hit = s.direction === "BUY" ? latest.high >= s.takeProfit2 : latest.low <= s.takeProfit2;

    // Conservative same-candle assumption: if SL and a target are both touched,
    // count the stop first because candle OHLC cannot reveal intrabar order.
    if (stopHit) {
      s.status = "CLOSED";
      s.result = s.hitTP1 ? "TP1_THEN_SL" : "STOP_LOSS";
      s.exitPrice = s.stopLoss;
      s.closedAt = isoNow();
      await safeOutcomeMessage(s, s.result === "STOP_LOSS"
        ? `🛑 *SIGNAL CLOSED — STOP LOSS*\n${s.direction} XAU/USD\n📍 Exit: \`${fmt(s.exitPrice)}\`\n🧾 Result: -1R (approx.)`
        : `⚠️ *SIGNAL CLOSED AFTER TP1*\n${s.direction} XAU/USD\n📍 Exit: \`${fmt(s.exitPrice)}\`\n🧾 TP1 was reached earlier; remaining position reached SL.`);
    } else if (tp2Hit) {
      s.hitTP1 = true;
      s.status = "CLOSED";
      s.result = "TP2";
      s.exitPrice = s.takeProfit2;
      s.closedAt = isoNow();
      await safeOutcomeMessage(s, `🏆 *TAKE PROFIT 2 HIT*\n${s.direction} XAU/USD\n📍 Exit: \`${fmt(s.exitPrice)}\`\n🚀 Result: +3R (approx.)`);
    } else if (tp1Hit && !s.hitTP1) {
      s.hitTP1 = true;
      s.tp1At = isoNow();
      await safeOutcomeMessage(s, `💰 *TAKE PROFIT 1 HIT*\n${s.direction} XAU/USD\n📍 Target: \`${fmt(s.takeProfit1)}\`\n✅ +${Math.max(2, MIN_RR)}R target reached. TP2 remains active.`);
    }
  }
}
async function safeOutcomeMessage(s, message) {
  try { await sendTelegram(`📊 *BOT.XAU — TRADE UPDATE*\n\n${message}\n\n⏰ ${isoNow()}`); }
  catch (err) { console.error("Outcome message failed:", err.message); }
}

async function scanMarket() {
  if (!TWELVE_DATA_KEY) throw new Error("TWELVE_DATA_KEY is not configured.");
  state.lastScanAt = isoNow();
  state.lastScanStatus = "scanning";
  saveState();

  // Three time-series calls per scan. Adjust SCAN_INTERVAL_MINUTES to fit your API quota.
  const [daily, fourHour, fifteen] = await Promise.all([
    getCandles("1day", 160),
    getCandles("4h", 180),
    getCandles("15min", 180)
  ]);
  const price = fifteen[fifteen.length - 1].close;
  state.lastPrice = price;

  await updateOpenSignals(fifteen);

  const zones1d = findZones(daily, "1D");
  const zones4h = findZones(fourHour, "4H");
  if (state.signals.filter(s => s.status === "OPEN").length >= MAX_OPEN_SIGNALS) {
    state.lastScanStatus = "ok — open signal limit reached";
    state.lastError = null;
    saveState();
    return;
  }

  for (const direction of ["BUY", "SELL"]) {
    const zoneType = direction === "BUY" ? "demand" : "supply";
    const zone = zoneConfluence(zones1d, zones4h, price, zoneType);
    if (!zone) continue;

    const confirm = confirmation(fifteen, direction);
    if (!confirm) continue;

    const candle15 = fifteen[fifteen.length - 1];
    const signal = createSignal(direction, candle15, zone, confirm);
    if (!signal || state.seen[signal.id]) continue;

    state.seen[signal.id] = true;
    signal.sentToTelegram = await broadcastSignal(signal);
    state.signals.unshift(signal);
    state.signals = state.signals.slice(0, 300);
    saveState();
    console.log(`New ${direction} signal ${signal.id}; Telegram sent: ${signal.sentToTelegram}`);
  }

  state.lastScanStatus = "ok";
  state.lastError = null;
  saveState();
}

let scanInProgress = false;
async function guardedScan() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    await scanMarket();
  } catch (err) {
    state.lastScanStatus = "error";
    state.lastError = err.message;
    console.error("Market scan failed:", err.message);
    saveState();
  } finally {
    scanInProgress = false;
  }
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOT.XAU Sniper Entry</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 18px;background:#10151f;color:#eef2ff}section{background:#1b2433;border-radius:12px;padding:18px;margin:12px 0}code{overflow-wrap:anywhere;color:#a7f3d0}a{color:#93c5fd}</style></head><body><h1>🎯 BOT.XAU Sniper Entry</h1><p>Independent XAU/USD supply-and-demand signal service.</p><section><b>Status</b><p><a href="/health">Health JSON</a> · <a href="/signals">Recent signals</a></p><p>Strategy: 1D + 4H zones, 15M liquidity sweep and BOS/CHOCH confirmation.</p><p>Signals are alerts only; no broker orders are placed.</p></section></body></html>`);
});
app.get("/health", (_req, res) => {
  res.json({
    app: "BOT.XAU Sniper Entry",
    status: state.lastScanStatus,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    symbol: SYMBOL,
    lastPrice: state.lastPrice,
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES,
    telegramConfigured: Boolean(bot && TELEGRAM_CHAT_ID),
    openSignals: state.signals.filter(s => s.status === "OPEN").length,
    totalSignals: state.signals.length
  });
});
app.get("/signals", (_req, res) => {
  res.json({
    lastScanAt: state.lastScanAt,
    status: state.lastScanStatus,
    signals: state.signals.slice(0, 100)
  });
});

if (bot) {
  bot.onText(/\/start|\/help/, async msg => {
    const text = [
      "🎯 *BOT.XAU Sniper Entry*",
      "",
      "🤖 Automatic XAU/USD alerts using 1D + 4H supply/demand zones and 15M confirmation.",
      "",
      "📊 /status — scanner status",
      "📈 /signals — latest signal results",
      "ℹ️ /help — help",
      "",
      "⚠️ Alerts are not broker orders. Verify every setup before trading."
    ].join("\n");
    try { await sendTelegram(text, String(msg.chat.id)); } catch (e) { console.error(e.message); }
  });
  bot.onText(/\/status/, async msg => {
    const text = `🤖 *BOT.XAU STATUS*\n\n🟡 Symbol: ${SYMBOL}\n📡 Scan: ${state.lastScanStatus}\n⏰ Last scan: ${state.lastScanAt || "not yet"}\n💵 Last price: ${state.lastPrice == null ? "not available" : fmt(state.lastPrice)}\n📂 Open signals: ${state.signals.filter(s => s.status === "OPEN").length}\n⚠️ Error: ${state.lastError || "none"}`;
    try { await sendTelegram(text, String(msg.chat.id)); } catch (e) { console.error(e.message); }
  });
  bot.onText(/\/signals/, async msg => {
    const recent = state.signals.slice(0, 5);
    const text = recent.length
      ? "📈 *LATEST BOT.XAU SIGNALS*\n\n" + recent.map(s => `${s.direction === "BUY" ? "🟢" : "🔴"} ${s.direction} | ${s.status}\nEntry ${fmt(s.entry)} · SL ${fmt(s.stopLoss)} · TP1 ${fmt(s.takeProfit1)}\nResult: ${s.result || "in progress"}`).join("\n\n")
      : "🔎 No signals recorded yet. The bot sends a signal only when all conditions match.";
    try { await sendTelegram(text, String(msg.chat.id)); } catch (e) { console.error(e.message); }
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BOT.XAU Sniper Entry listening on port ${PORT}`);
  console.log(`Market scan interval: ${SCAN_INTERVAL_MINUTES} minutes`);
  setTimeout(guardedScan, 3000);
  setInterval(guardedScan, SCAN_INTERVAL_MINUTES * 60 * 1000);
});

process.on("SIGTERM", () => {
  saveState();
  if (bot) bot.stopPolling();
  process.exit(0);
});
