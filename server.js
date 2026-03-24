import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import path from "path";
import { createDb, getMarket, getLatestPrice, getMarketStats, getPriceHistory, getMovers, getDbStatus, scanMarkets, getPostTradeDeltas } from "./db.js";
import { KalshiPipeline } from "./pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const weatherBot = require("./weather-bot/index.js");

// ─── Weather bot server-side scanner state ────────────────────────────────────
let wxScanInterval = null;
let wxMonitorInterval = null;
let wxScanRunning = false;
let wxLastScan = null;

const wxConfig = require("./weather-bot/config.js");

async function runServerScan() {
  if (wxScanRunning) return { skipped: true, reason: "scan_already_running" };
  wxScanRunning = true;
  try {
    await weatherBot.scan();
    wxLastScan = new Date().toISOString();
    return { success: true, timestamp: wxLastScan };
  } catch (err) {
    console.error("[weather-bot] scan error:", err.message);
    return { success: false, error: err.message };
  } finally {
    wxScanRunning = false;
  }
}

async function runServerMonitor() {
  if (wxScanRunning) return;
  try {
    await weatherBot.monitor();
  } catch (err) {
    console.error("[weather-bot] monitor error:", err.message);
  }
}

dotenv.config();

const {
  PROXY_API_KEY,
  PORT = 3000,
  REAL_TRADING_ENABLED,
  KALSHI_API_KEY,
  KALSHI_SECRET,
} = process.env;

const BASE_POLY_URL = "https://clob.polymarket.com";

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(helmet({
  contentSecurityPolicy: false,     // Allow inline styles/scripts in index.html
  crossOriginEmbedderPolicy: false, // Allow loading external fonts/resources
}));
app.use(cors());
app.use(morgan("combined"));

const limiter = rateLimit({ windowMs: 60000, max: 200 });
app.use(limiter);

function requireProxyApiKey(req, res, next) {
  const key = req.header("x-proxy-api-key") || req.query.api_key;
  if (!PROXY_API_KEY) return next();
  if (!key || key !== PROXY_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function polyGet(path, params = {}) {
  const resp = await axios.get(`${BASE_POLY_URL}${path}`, { params, timeout: 10000 });
  return resp.data;
}

/**
 * Normalize a Polymarket market object to the shape the frontend expects.
 * Optionally merges a local DB snapshot (latest price_snapshots row) so the
 * frontend sees real bid/ask instead of the same mid-price for both.
 */
function normalizeMarket(m, snap = null) {
  const yesToken = m.tokens?.find(t => t.outcome === "Yes") || m.tokens?.[0];
  const noToken  = m.tokens?.find(t => t.outcome === "No")  || m.tokens?.[1];
  const midPrice = yesToken?.price ?? null;

  // Prefer real bid/ask from the latest stored snapshot over the market mid-price
  const bid = snap?.yes_bid  ?? (midPrice !== null ? +(midPrice - 0.005).toFixed(4) : null);
  const ask = snap?.yes_ask  ?? (midPrice !== null ? +(midPrice + 0.005).toFixed(4) : null);
  const last = snap?.yes_price ?? midPrice;

  return {
    ticker:             m.condition_id || m.ticker,
    condition_id:       m.condition_id,
    title:              m.question || m.title,
    subtitle:           m.question || m.title,
    category:           m.tags?.[0]?.label || m.tags?.[0]?.id || "",
    status:             (m.active && !m.closed) ? "open" : "closed",
    close_time:         m.end_date_iso || m.close_time,
    volume:             m.volumeClob  || m.volume  || 0,
    liquidity:          m.liquidityClob || m.liquidity || 0,
    floor_strike:       null,
    last_price_dollars: last !== null ? (+last).toFixed(2) : null,
    yes_ask_dollars:    ask  !== null ? (+ask).toFixed(2)  : null,
    yes_bid_dollars:    bid  !== null ? (+bid).toFixed(2)  : null,
    yes_token_id:       yesToken?.token_id || null,
    no_token_id:        noToken?.token_id  || null,
  };
}

app.get("/healthz", (req, res) => res.json({ status: "ok", ts: Date.now() }));

// Browse / search markets — maps series_ticker → keyword search on Polymarket
app.get("/markets", requireProxyApiKey, async (req, res) => {
  try {
    const params = { active: "true", closed: "false" };
    if (req.query.series_ticker) params.q = req.query.series_ticker;
    if (req.query.limit)         params.limit = req.query.limit;
    if (req.query.next_cursor)   params.next_cursor = req.query.next_cursor;
    const data = await polyGet("/markets", params);
    const markets = (data.data || []).map(normalizeMarket);
    res.json({ markets, next_cursor: data.next_cursor });
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "polymarket_error", message: err?.response?.data || err?.message });
  }
});

// Single market — fetch from Polymarket, enrich with local snapshot for real bid/ask,
// and fall back to local DB if Polymarket returns 404 (e.g. market no longer active).
app.get("/market/:ticker", requireProxyApiKey, async (req, res) => {
  const ticker = req.params.ticker;
  const snap   = getLatestPrice(db, ticker); // may be null if not yet indexed

  try {
    const data   = await polyGet(`/markets/${encodeURIComponent(ticker)}`);
    const market = normalizeMarket(data, snap);
    res.json({ market });
  } catch (err) {
    const status = err?.response?.status || 500;

    // If Polymarket says 404, serve from local DB cache if we have it
    if (status === 404) {
      const dbMarket = getMarket(db, ticker);
      if (dbMarket) {
        return res.json({
          market: {
            ticker:             dbMarket.ticker,
            condition_id:       dbMarket.ticker,
            title:              dbMarket.title,
            subtitle:           dbMarket.title,
            category:           dbMarket.category || "",
            status:             dbMarket.status,
            close_time:         dbMarket.close_time,
            volume:             dbMarket.volume || 0,
            liquidity:          dbMarket.liquidity || 0,
            floor_strike:       null,
            last_price_dollars: snap ? (+snap.yes_price).toFixed(2) : null,
            yes_ask_dollars:    snap?.yes_ask  ? (+snap.yes_ask).toFixed(2)  : null,
            yes_bid_dollars:    snap?.yes_bid  ? (+snap.yes_bid).toFixed(2)  : null,
            yes_token_id:       dbMarket.yes_token_id,
            no_token_id:        dbMarket.no_token_id,
            _source:            "local_cache",
          }
        });
      }
    }

    res.status(status).json({ error: "polymarket_error", message: err?.response?.data || err?.message });
  }
});

// Orderbook — look up YES token_id from DB, then hit Polymarket /book
app.get("/orderbook/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const dbMarket = getMarket(db, req.params.ticker);
    if (!dbMarket?.yes_token_id) return res.status(404).json({ error: "token_id_not_found", message: "Market not yet indexed — wait for pipeline refresh" });
    const data = await polyGet("/book", { token_id: dbMarket.yes_token_id });
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "polymarket_error", message: err?.response?.data || err?.message });
  }
});

// Trades — look up YES token_id from DB, then hit Polymarket /trades
app.get("/trades/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const dbMarket = getMarket(db, req.params.ticker);
    if (!dbMarket?.yes_token_id) return res.status(404).json({ error: "token_id_not_found", message: "Market not yet indexed — wait for pipeline refresh" });
    const data = await polyGet("/trades", { token_id: dbMarket.yes_token_id });
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "polymarket_error", message: err?.response?.data || err?.message });
  }
});

// ─── History / stats endpoints ────────────────────────────────────────────────

app.get("/market/:ticker/history", requireProxyApiKey, (req, res) => {
  const ticker = req.params.ticker;
  const hours  = parseFloat(req.query.hours) || 24;
  try {
    const history = getPriceHistory(db, ticker, hours);
    res.json({ ticker, hours, count: history.length, history });
  } catch (err) {
    res.status(500).json({ error: "db_error", message: err.message });
  }
});

app.get("/market/:ticker/stats", requireProxyApiKey, (req, res) => {
  const ticker = req.params.ticker;
  const hours  = parseFloat(req.query.hours) || 24;
  try {
    const stats = getMarketStats(db, ticker, hours);
    if (!stats) return res.json({ ticker, hours, message: "no_data" });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: "db_error", message: err.message });
  }
});

app.get("/markets/movers", requireProxyApiKey, (req, res) => {
  const hours   = parseFloat(req.query.hours)    || 1;
  const minMove = parseFloat(req.query.min_move) || 0.05;
  try {
    const movers = getMovers(db, hours, minMove);
    res.json({ hours, min_move: minMove, count: movers.length, movers });
  } catch (err) {
    console.error("[markets/movers] error:", err.message);
    res.json({ hours, min_move: minMove, count: 0, movers: [] });
  }
});

app.get("/scan", requireProxyApiKey, (req, res) => {
  const hours    = parseFloat(req.query.hours)    || 4;
  const minEdge  = parseFloat(req.query.min_edge) || 0.06;
  const bankroll = parseFloat(req.query.bankroll) || null;
  const k        = parseFloat(req.query.k)        || 0.25;
  try {
    const opportunities = scanMarkets(db, hours, minEdge, bankroll, k);
    res.json({
      scan_time: new Date().toISOString(),
      hours,
      min_edge: minEdge,
      bankroll,
      k,
      count: opportunities.length,
      opportunities,
    });
  } catch (err) {
    res.status(500).json({ error: "scan_error", message: err.message });
  }
});

app.get("/market/:ticker/reaction", requireProxyApiKey, (req, res) => {
  const ticker = req.params.ticker;
  const hours  = parseFloat(req.query.hours) || 24;
  try {
    const trades = db.prepare(`
      SELECT price, size, trade_time
      FROM trades
      WHERE ticker = ?
      ORDER BY trade_time ASC
    `).all(ticker);

    if (trades.length < 5) {
      return res.json({ ticker, samples: 0, avg_delta_5m: null, message: "insufficient_trades" });
    }

    // Top 10%: 90th percentile by count (size)
    const sizes   = trades.map(t => t.size).sort((a, b) => a - b);
    const p90size = sizes[Math.floor(sizes.length * 0.9)];
    const large   = trades.filter(t => t.size >= p90size);

    // Fetch snapshots for this ticker
    const cutoff = new Date(Date.now() - (hours + 1) * 3600 * 1000).toISOString();
    const snaps  = db.prepare(`
      SELECT yes_price, snapshot_time
      FROM price_snapshots
      WHERE ticker = ? AND snapshot_time > ? AND yes_price IS NOT NULL
      ORDER BY snapshot_time ASC
    `).all(ticker, cutoff);

    if (snaps.length < 2) {
      return res.json({ ticker, samples: 0, avg_delta_5m: null, message: "insufficient_snapshots" });
    }

    const snapMs = snaps.map(s => ({ price: s.yes_price, t: new Date(s.snapshot_time).getTime() }));
    function nearestPrice(targetMs, tolMs = 180000) {
      let best = null, bestDiff = Infinity;
      for (const s of snapMs) {
        const diff = Math.abs(s.t - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return bestDiff <= tolMs ? best : null;
    }

    const deltas = [];
    for (const trade of large) {
      const tradeMs = new Date(trade.trade_time).getTime();
      const entry   = nearestPrice(tradeMs);
      const after5m = nearestPrice(tradeMs + 5 * 60000);
      if (entry && after5m && after5m.t !== entry.t) {
        deltas.push(after5m.price - entry.price);
      }
    }

    const avg_delta_5m = deltas.length
      ? +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(4)
      : null;

    res.json({ ticker, samples: deltas.length, avg_delta_5m });
  } catch (err) {
    res.status(500).json({ error: "reaction_error", message: err.message });
  }
});

app.get("/db/status", (req, res) => {
  try {
    const status = getDbStatus(db);
    console.log("[db/status]", JSON.stringify(status));
    res.json(status);
  } catch (err) {
    console.error("[db/status] error:", err.message);
    res.status(500).json({ error: "db_error", message: err.message });
  }
});

// ─── Claude analysis proxy ────────────────────────────────────────────────────

function stripImageContent(messages) {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter(block => block.type !== "image" && block.type !== "image_url");
    return { ...msg, content: filtered };
  });
}

app.post("/analyze", requireProxyApiKey, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "no_api_key", message: "ANTHROPIC_API_KEY not configured on server" });
  }
  const { prompt, messages: rawMessages, model = "claude-sonnet-4-6", max_tokens = 1200 } = req.body;
  if (!prompt && !rawMessages) return res.status(400).json({ error: "missing_prompt" });

  // Build messages array from either prompt string or messages array
  let messages = rawMessages
    ? stripImageContent(rawMessages)
    : [{ role: "user", content: prompt }];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model, max_tokens, messages })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
});

// ─── Weather bot data endpoints ──────────────────────────────────────────────

app.get("/weather/state", requireProxyApiKey, (req, res) => {
  try {
    const file = path.join(__dirname, "weather-bot/data/bot_state.json");
    if (!fs.existsSync(file)) return res.json({ bankroll: 1000, totalTrades: 0, wins: 0, losses: 0, pending: [], resolved: [] });
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    res.json({ bankroll: 1000, totalTrades: 0, wins: 0, losses: 0, pending: [], resolved: [] });
  }
});

app.get("/weather/trades", requireProxyApiKey, (req, res) => {
  try {
    const file = path.join(__dirname, "weather-bot/data/paper_trades.json");
    if (!fs.existsSync(file)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    res.json([]);
  }
});

app.post("/weather/reset", requireProxyApiKey, (req, res) => {
  try {
    const { resetAllData } = require("./weather-bot/storage/logger.js");
    resetAllData();
    res.json({ success: true, message: "All trade data reset to fresh state." });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/weather/markets", requireProxyApiKey, (req, res) => {
  try {
    const marketsDir = path.join(__dirname, "weather-bot/data/markets");
    if (!fs.existsSync(marketsDir)) return res.json([]);
    const files = fs.readdirSync(marketsDir).filter(f => f.endsWith(".json"));
    const markets = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(marketsDir, f), "utf8")); }
      catch (e) { return null; }
    }).filter(Boolean);
    res.json(markets);
  } catch (e) {
    res.json([]);
  }
});

app.get("/weather/calibration", requireProxyApiKey, (req, res) => {
  try {
    const file = path.join(__dirname, "weather-bot/data/calibration.json");
    if (!fs.existsSync(file)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    res.json({});
  }
});

// ─── Weather bot server-side scan control ─────────────────────────────────────

app.post("/weather/scan", requireProxyApiKey, async (req, res) => {
  const result = await runServerScan();
  res.json(result);
});

app.get("/weather/auto", requireProxyApiKey, (req, res) => {
  res.json({ auto: !!wxScanInterval, scanning: wxScanRunning, lastScan: wxLastScan });
});

app.post("/weather/auto", requireProxyApiKey, (req, res) => {
  const { enabled } = req.body;

  if (enabled && !wxScanInterval) {
    runServerScan();
    // Full scan every hour, monitor every 10 min
    wxScanInterval = setInterval(() => runServerScan(), wxConfig.scanIntervalMs);
    wxMonitorInterval = setInterval(() => runServerMonitor(), wxConfig.monitorIntervalMs);
    return res.json({ auto: true, message: `Auto-scan started (scan: ${wxConfig.scanInterval}s, monitor: ${wxConfig.monitorInterval}s)` });
  }

  if (!enabled && wxScanInterval) {
    clearInterval(wxScanInterval);
    wxScanInterval = null;
    if (wxMonitorInterval) { clearInterval(wxMonitorInterval); wxMonitorInterval = null; }
    return res.json({ auto: false, message: "Auto-scan stopped" });
  }

  res.json({ auto: !!wxScanInterval, message: "No change" });
});

// ─── Trade execution ──────────────────────────────────────────────────────────

app.get("/weather/trading-status", requireProxyApiKey, (req, res) => {
  const reasons = [];
  if (!REAL_TRADING_ENABLED || REAL_TRADING_ENABLED !== "true") reasons.push("REAL_TRADING_ENABLED env var is not set to 'true'");
  if (!KALSHI_API_KEY) reasons.push("KALSHI_API_KEY env var is not set");
  if (!KALSHI_SECRET) reasons.push("KALSHI_SECRET env var is not set");
  res.json({
    mode: reasons.length === 0 ? "LIVE" : "PAPER",
    ready: reasons.length === 0,
    blockers: reasons,
  });
});

app.post("/trade", requireProxyApiKey, (req, res) => {
  if (!REAL_TRADING_ENABLED || REAL_TRADING_ENABLED !== "true") {
    return res.status(403).json({ status: "blocked", message: "REAL_TRADING_ENABLED is not set to 'true'" });
  }
  if (!KALSHI_API_KEY || !KALSHI_SECRET) {
    return res.status(403).json({ status: "blocked", message: "KALSHI_API_KEY and KALSHI_SECRET must be set" });
  }
  // TODO: Implement Kalshi order submission using KALSHI_API_KEY + KALSHI_SECRET
  console.log("[trade] Real trade request received:", JSON.stringify(req.body));
  res.status(501).json({
    status: "not_implemented",
    message: "Kalshi order submission not yet implemented. Credentials are configured — order execution code needs to be added.",
  });
});

// ─── Kalshi API proxy (avoids browser CORS restrictions) ─────────────────────

app.get("/kalshi/markets", requireProxyApiKey, async (req, res) => {
  const { series_ticker, status = "open", limit = 100 } = req.query;
  if (!series_ticker) return res.status(400).json({ error: "missing series_ticker" });
  try {
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(series_ticker)}&status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`;
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) return res.status(r.status).json({ error: "kalshi_error", status: r.status });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "kalshi_fetch_error", message: err.message });
  }
});

// ─── Global error handler (must be last) ─────────────────────────────────────

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err?.message);
  res.status(500).json({ error: "internal_error", message: err?.message });
});

// ─── Start server + pipeline ──────────────────────────────────────────────────

const db       = createDb();
const pipeline = new KalshiPipeline(db);

app.listen(PORT, () => {
  console.log(`Polymarket proxy running on port ${PORT}`);
  pipeline.start().catch((err) => {
    console.error("Pipeline failed to start:", err.message);
  });
});
