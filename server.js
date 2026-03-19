import express from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createDb, getMarketStats, getPriceHistory, getMovers, getDbStatus } from "./db.js";
import { KalshiPipeline } from "./pipeline.js";

dotenv.config();

const {
  KALSHI_KEY,
  KALSHI_SECRET,
  PROXY_API_KEY,
  PORT = 3000,
  BASE_KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2"
} = process.env;

if (!KALSHI_KEY || !KALSHI_SECRET) {
  console.error("Missing KALSHI_KEY or KALSHI_SECRET in environment.");
  process.exit(1);
}

const app = express();
app.use(express.json());app.use(express.static("public"));
app.use(helmet());
app.use(cors());
app.use(morgan("combined"));

const limiter = rateLimit({ windowMs: 10000, max: 30 });
app.use(limiter);

function requireProxyApiKey(req, res, next) {
  const key = req.header("x-proxy-api-key") || req.query.api_key;
  if (!PROXY_API_KEY) return next();
  if (!key || key !== PROXY_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function signRequest(method, path) {
  const timestampMs = Date.now();
  const timestampSeconds = Math.floor(timestampMs / 1000).toString();

  // Kalshi uses RSA-PSS with SHA-256
  // Private key must be in PEM format
  let privateKey = KALSHI_SECRET;

  // Rebuild PEM if line breaks were stripped by env variable storage
  if (!privateKey.includes("-----BEGIN")) {
    // Raw base64 only — wrap it
    const body = privateKey.replace(/\s/g, "").match(/.{1,64}/g).join("\n");
    privateKey = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  } else {
    // Has headers but line breaks may be \n literals instead of real breaks
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  const message = timestampSeconds + method.toUpperCase() + path;

  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    timestamp: timestampSeconds,
    signature: signature.toString("base64"),
  };
}

async function kalshiGet(path, params = {}) {
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  const { timestamp, signature } = signRequest("GET", fullPath);
  const url = `${BASE_KALSHI_URL}${fullPath}`;

  const resp = await axios.get(url, {
    params,
    headers: {
      "KALSHI-ACCESS-KEY": KALSHI_KEY,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    },
    timeout: 10000,
  });
  return resp.data;
}

app.get("/healthz", (req, res) => res.json({ status: "ok", ts: Date.now() }));

app.get("/markets", requireProxyApiKey, async (req, res) => {
  try {
    const data = await kalshiGet("/markets", req.query);
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "kalshi_error", message: err?.response?.data || err?.message });
  }
});

app.get("/market/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const ticker = encodeURIComponent(req.params.ticker);
    const data = await kalshiGet(`/markets/${ticker}`);
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "kalshi_error", message: err?.response?.data || err?.message });
  }
});

app.get("/orderbook/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const ticker = encodeURIComponent(req.params.ticker);
    const data = await kalshiGet(`/markets/${ticker}/orderbook`);
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "kalshi_error", message: err?.response?.data || err?.message });
  }
});

app.get("/trades/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const ticker = encodeURIComponent(req.params.ticker);
    const data = await kalshiGet(`/markets/${ticker}/trades`);
    res.json(data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "kalshi_error", message: err?.response?.data || err?.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: "internal_error", message: err?.message });
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

app.get("/db/status", (req, res) => {
  try {
    res.json(getDbStatus(db));
  } catch (err) {
    res.status(500).json({ error: "db_error", message: err.message });
  }
});

// ─── Claude analysis proxy ────────────────────────────────────────────────────
// Routes Claude API calls through the backend so the API key stays server-side.
// Falls back gracefully if ANTHROPIC_API_KEY is not set.

app.post("/analyze", requireProxyApiKey, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "no_api_key", message: "ANTHROPIC_API_KEY not configured on server" });
  }
  const { prompt, model = "claude-sonnet-4-6", max_tokens = 1200 } = req.body;
  if (!prompt) return res.status(400).json({ error: "missing_prompt" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content: prompt }] })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
});

// ─── Start server + pipeline ──────────────────────────────────────────────────

const db       = createDb();
const pipeline = new KalshiPipeline(db);

app.listen(PORT, () => {
  console.log(`Kalshi proxy running on port ${PORT}`);
  pipeline.start().catch((err) => {
    console.error("Pipeline failed to start:", err.message);
  });
});
