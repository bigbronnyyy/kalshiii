import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createDb, getMarket, getLatestPrice, getMarketStats, getPriceHistory, getMovers, getDbStatus, scanMarkets, getPostTradeDeltas } from "./db.js";
import { KalshiPipeline } from "./pipeline.js";

dotenv.config();

const {
  PROXY_API_KEY,
  PORT = 3000,
} = process.env;

const BASE_POLY_URL = "https://clob.polymarket.com";

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(helmet());
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
    res.status(500).json({ error: "db_error", message: err.message });
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
    res.json(getDbStatus(db));
  } catch (err) {
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

// ─── Trade execution (placeholder — wallet integration required) ─────────────

app.post("/trade", requireProxyApiKey, (req, res) => {
  res.status(501).json({
    status:  "not_implemented",
    message: "Wallet integration required. Connect a Polymarket API key + private key to enable order submission.",
  });
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
