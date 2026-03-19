/**
 * pipeline.js — Kalshi data pipeline
 *
 * Adapts the Polymarket-style pipeline architecture to Kalshi:
 *   - Layer 1: REST poller (periodic market + price snapshots)
 *   - Layer 2: WebSocket client (real-time price updates)
 *   - Layer 3: Orchestrator (starts both, handles scheduling)
 */

import WebSocket from "ws";
import cron from "node-cron";
import crypto from "crypto";
import axios from "axios";
import { upsertMarket, recordSnapshot, recordTrade, getActiveMarkets } from "./db.js";
import { createRequire } from "module";

const BASE_KALSHI_URL =
  process.env.BASE_KALSHI_URL || "https://api.elections.kalshi.com/trade-api/v2";

const SNAPSHOT_INTERVAL_SEC = parseInt(process.env.SNAPSHOT_INTERVAL_SEC || "60", 10);
const REFRESH_INTERVAL_SEC  = parseInt(process.env.REFRESH_INTERVAL_SEC  || "300", 10);

// ─── Auth helpers (mirrors server.js signRequest) ─────────────────────────────

function buildPrivateKey(raw) {
  if (!raw) throw new Error("KALSHI_SECRET is not set");
  if (!raw.includes("-----BEGIN")) {
    const body = raw.replace(/\s/g, "").match(/.{1,64}/g).join("\n");
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  }
  return raw.replace(/\\n/g, "\n");
}

function signRequest(method, urlPath) {
  const KALSHI_SECRET = process.env.KALSHI_SECRET;
  const tsSeconds = Math.floor(Date.now() / 1000).toString();
  const message   = tsSeconds + method.toUpperCase() + urlPath;
  const privateKey = buildPrivateKey(KALSHI_SECRET);

  const signature = crypto.sign("sha256", Buffer.from(message), {
    key:        privateKey,
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    timestamp: tsSeconds,
    signature: signature.toString("base64"),
  };
}

function authHeaders(method, path) {
  const { timestamp, signature } = signRequest(method, path);
  return {
    "KALSHI-ACCESS-KEY":       process.env.KALSHI_KEY,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

async function kalshiGet(path, params = {}) {
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  const url      = `${BASE_KALSHI_URL}${fullPath}`;
  const resp     = await axios.get(url, {
    params,
    headers: authHeaders("GET", fullPath),
    timeout: 10000,
  });
  return resp.data;
}

// ─── REST Poller ──────────────────────────────────────────────────────────────

async function fetchAndStoreMarkets(db, logger) {
  try {
    let cursor = null;
    let total  = 0;

    do {
      const params = { limit: 200, status: "open" };
      if (cursor) params.cursor = cursor;

      const data = await kalshiGet("/markets", params);
      const markets = data.markets || [];

      for (const m of markets) {
        upsertMarket(db, m);
        total++;
      }

      cursor = data.cursor || null;
    } while (cursor);

    logger(`Pipeline: stored/updated ${total} open markets`);
  } catch (err) {
    logger(`Pipeline: market fetch error — ${err.message}`);
  }
}

async function snapshotTicker(db, ticker, logger) {
  try {
    const data   = await kalshiGet(`/markets/${encodeURIComponent(ticker)}`);
    const market = data.market || data;

    // Parse prices from Kalshi's format (cents strings or dollar strings)
    const parse = (v) => {
      if (v === undefined || v === null) return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : n > 1 ? n / 100 : n; // convert cents to decimal if > 1
    };

    recordSnapshot(db, ticker, {
      yes_price: parse(market.last_price) ?? parse(market.yes_bid),
      yes_bid:   parse(market.yes_bid),
      yes_ask:   parse(market.yes_ask),
      no_price:  parse(market.no_bid),
    }, "rest");
  } catch (err) {
    if (err?.response?.status !== 404) {
      logger(`Pipeline: snapshot error for ${ticker} — ${err.message}`);
    }
  }
}

async function runRestSnapshots(db, logger) {
  const markets = getActiveMarkets(db);
  logger(`Pipeline: snapshotting ${markets.length} tickers via REST`);

  // Batch with a small delay between requests to respect rate limits
  for (const { ticker } of markets) {
    await snapshotTicker(db, ticker, logger);
    await new Promise((r) => setTimeout(r, 200)); // 5 req/s
  }
}

// ─── WebSocket Client ─────────────────────────────────────────────────────────

const WS_URL = "wss://api.elections.kalshi.com/trade-api/v2/ws/market";

class KalshiWebSocket {
  constructor(db, logger) {
    this.db            = db;
    this.logger        = logger;
    this._ws           = null;
    this._running      = false;
    this._reconnectMs  = 1000;
    this._msgCount     = 0;
    this._subscribedTickers = new Set();
  }

  subscribeTickers(tickers) {
    for (const t of tickers) this._subscribedTickers.add(t);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._sendSubscription(tickers);
    }
  }

  _sendSubscription(tickers) {
    if (!tickers.length) return;
    const msg = { id: 1, cmd: "subscribe", params: { channels: ["orderbook_delta", "ticker"], market_tickers: tickers } };
    this._ws.send(JSON.stringify(msg));
    this.logger(`WS: subscribed to ${tickers.length} tickers`);
  }

  async connect() {
    this._running = true;

    while (this._running) {
      try {
        await this._connectOnce();
      } catch (err) {
        this.logger(`WS: connection error — ${err.message}`);
      }

      if (!this._running) break;
      this.logger(`WS: reconnecting in ${this._reconnectMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, this._reconnectMs));
      this._reconnectMs = Math.min(this._reconnectMs * 2, 60000);
    }
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const { timestamp, signature } = signRequest("GET", "/trade-api/v2/ws/market");

      const ws = new WebSocket(WS_URL, {
        headers: {
          "KALSHI-ACCESS-KEY":       process.env.KALSHI_KEY,
          "KALSHI-ACCESS-SIGNATURE": signature,
          "KALSHI-ACCESS-TIMESTAMP": timestamp,
        },
      });

      this._ws = ws;

      ws.on("open", () => {
        this._reconnectMs = 1000; // reset backoff on success
        this.logger("WS: connected to Kalshi real-time feed");

        if (this._subscribedTickers.size > 0) {
          this._sendSubscription([...this._subscribedTickers]);
        }
      });

      ws.on("message", (raw) => this._handleMessage(raw));

      ws.on("close", (code, reason) => {
        this.logger(`WS: closed (code=${code})`);
        this._ws = null;
        resolve();
      });

      ws.on("error", (err) => {
        this.logger(`WS: error — ${err.message}`);
        this._ws = null;
        reject(err);
      });

      // Keep-alive ping every 30s
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(ping);
      }, 30000);
    });
  }

  _handleMessage(raw) {
    try {
      const data = JSON.parse(raw.toString());
      this._msgCount++;

      if (this._msgCount % 500 === 0) {
        this.logger(`WS: processed ${this._msgCount} messages`);
      }

      const type   = data.type || data.msg;
      const ticker = data.market_ticker || data.params?.market_ticker || data.sid;

      if (!ticker) return;

      // Kalshi WS sends ticker updates with yes/no prices
      if (type === "ticker" || (data.yes_price !== undefined)) {
        const parse = (v) => {
          if (v === undefined || v === null) return null;
          const n = parseFloat(v);
          return isNaN(n) ? null : n > 1 ? n / 100 : n;
        };

        recordSnapshot(this.db, ticker, {
          yes_price: parse(data.yes_price ?? data.params?.yes_price),
          yes_bid:   parse(data.yes_bid   ?? data.params?.yes_bid),
          yes_ask:   parse(data.yes_ask   ?? data.params?.yes_ask),
          no_price:  parse(data.no_price  ?? data.params?.no_price),
        }, "ws");
      }

      // Trade events
      if (type === "trade" && data.trade_id) {
        recordTrade(this.db, {
          trade_id:  data.trade_id,
          ticker,
          price:     parseFloat(data.price ?? 0),
          size:      parseFloat(data.count ?? data.size ?? 0),
          side:      data.taker_side,
          trade_time: data.created_time ?? new Date().toISOString(),
        });
      }
    } catch (err) {
      this.logger(`WS: message parse error — ${err.message}`);
    }
  }

  stop() {
    this._running = false;
    this._ws?.terminate();
  }
}

// ─── Pipeline Orchestrator ────────────────────────────────────────────────────

export class KalshiPipeline {
  constructor(db, logger = console.log) {
    this.db     = db;
    this.logger = logger;
    this.ws     = new KalshiWebSocket(db, logger);
    this._snapshotCron = null;
    this._refreshCron  = null;
    this._started      = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    this.logger("Pipeline: initializing...");

    // Step 1: load all open markets into DB
    await fetchAndStoreMarkets(this.db, this.logger);

    // Step 2: subscribe WS to active tickers
    const active = getActiveMarkets(this.db);
    const tickers = active.map((r) => r.ticker);
    this.ws.subscribeTickers(tickers);

    // Step 3: take initial REST snapshots
    await runRestSnapshots(this.db, this.logger);

    // Step 4: schedule REST snapshots every N seconds
    this._snapshotCron = cron.schedule(
      `*/${SNAPSHOT_INTERVAL_SEC} * * * * *`,
      () => runRestSnapshots(this.db, this.logger),
      { scheduled: true }
    );

    // Step 5: schedule metadata refresh every N seconds (using setInterval for > 60s intervals)
    this._refreshInterval = setInterval(async () => {
      await fetchAndStoreMarkets(this.db, this.logger);

      // Subscribe any newly-discovered tickers
      const freshTickers = getActiveMarkets(this.db).map((r) => r.ticker);
      const newOnes = freshTickers.filter((t) => !this.ws._subscribedTickers.has(t));
      if (newOnes.length) this.ws.subscribeTickers(newOnes);
    }, REFRESH_INTERVAL_SEC * 1000);

    // Step 6: start WebSocket (non-blocking, runs in background)
    this.ws.connect().catch((err) => {
      this.logger(`Pipeline: WS fatal error — ${err.message}`);
    });

    this.logger(`Pipeline: running (REST every ${SNAPSHOT_INTERVAL_SEC}s, refresh every ${REFRESH_INTERVAL_SEC}s)`);
  }

  stop() {
    this._snapshotCron?.stop();
    clearInterval(this._refreshInterval);
    this.ws.stop();
    this._started = false;
    this.logger("Pipeline: stopped");
  }
}
