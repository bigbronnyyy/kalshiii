/**
 * pipeline.js — Polymarket data pipeline
 *
 * Three-layer architecture:
 *   - Layer 1: REST poller (periodic market + price snapshots)
 *   - Layer 2: WebSocket client (real-time price updates)
 *   - Layer 3: Orchestrator (starts both, handles scheduling)
 */

import WebSocket from "ws";
import axios from "axios";
import { upsertMarket, recordSnapshot, recordTrade, getActiveMarkets } from "./db.js";

const BASE_URL = "https://clob.polymarket.com";
const WS_URL   = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const SNAPSHOT_INTERVAL_SEC = parseInt(process.env.SNAPSHOT_INTERVAL_SEC || "60", 10);
const REFRESH_INTERVAL_SEC  = parseInt(process.env.REFRESH_INTERVAL_SEC  || "300", 10);

// ─── REST helpers ─────────────────────────────────────────────────────────────

async function polyGet(path, params = {}) {
  const resp = await axios.get(`${BASE_URL}${path}`, { params, timeout: 10000 });
  return resp.data;
}

// ─── REST Poller ──────────────────────────────────────────────────────────────

async function fetchAndStoreMarkets(db, logger) {
  try {
    let nextCursor = "";
    let total = 0;

    do {
      const params = { active: "true", closed: "false" };
      if (nextCursor) params.next_cursor = nextCursor;

      const data = await polyGet("/markets", params);
      const markets = data.data || [];

      for (const m of markets) {
        upsertMarket(db, m);
        total++;
      }

      // "LTE=" is Polymarket's sentinel for "no more pages"
      nextCursor = (data.next_cursor && data.next_cursor !== "LTE=") ? data.next_cursor : "";
    } while (nextCursor);

    logger(`Pipeline: stored/updated ${total} active markets`);
  } catch (err) {
    logger(`Pipeline: market fetch error — ${err.message}`);
  }
}

async function snapshotTicker(db, conditionId, yesTokenId, logger) {
  try {
    const bookData = await polyGet("/book", { token_id: yesTokenId });

    // Polymarket orderbook: bids sorted descending, asks ascending
    const bids    = bookData.bids || [];
    const asks    = bookData.asks || [];
    const yesBid  = bids.length ? parseFloat(bids[0].price) : null;
    const yesAsk  = asks.length ? parseFloat(asks[0].price) : null;
    // Derive mid-price from spread; fall back to whichever side is available
    const yesPrice = (yesBid !== null && yesAsk !== null)
      ? +((yesBid + yesAsk) / 2).toFixed(4)
      : (yesBid ?? yesAsk ?? null);
    const noPrice = yesPrice !== null ? +(1 - yesPrice).toFixed(4) : null;

    recordSnapshot(db, conditionId, { yes_price: yesPrice, yes_bid: yesBid, yes_ask: yesAsk, no_price: noPrice }, "rest");
    return true;
  } catch (err) {
    if (err?.response?.status !== 404) {
      logger(`Pipeline: snapshot error for ${conditionId} — ${err.message}`);
    }
    return false;
  }
}

async function runRestSnapshots(db, logger) {
  const markets = getActiveMarkets(db);
  logger(`Pipeline: snapshotting ${markets.length} markets via REST`);
  let ok = 0, errors = 0;

  for (const { ticker, yes_token_id } of markets) {
    const success = await snapshotTicker(db, ticker, yes_token_id, logger);
    if (success) ok++; else errors++;
    await new Promise((r) => setTimeout(r, 200)); // 5 req/s
  }
  logger(`Pipeline: REST snapshot done — ok=${ok} errors=${errors}`);
}

// ─── WebSocket Client ─────────────────────────────────────────────────────────

class PolymarketWebSocket {
  constructor(db, logger) {
    this.db                 = db;
    this.logger             = logger;
    this._ws                = null;
    this._running           = false;
    this._reconnectMs       = 1000;
    this._msgCount          = 0;
    this._tokenToMarket     = new Map(); // token_id → condition_id
    this._subscribedTokens  = new Set();
  }

  subscribeTokens(tokenMap) {
    // tokenMap: array of { token_id, condition_id }
    for (const { token_id, condition_id } of tokenMap) {
      this._tokenToMarket.set(token_id, condition_id);
      this._subscribedTokens.add(token_id);
    }
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._sendSubscription([...this._subscribedTokens]);
    }
  }

  _sendSubscription(tokenIds) {
    if (!tokenIds.length) return;
    this._ws.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));
    this.logger(`WS: subscribed to ${tokenIds.length} tokens`);
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
      const ws = new WebSocket(WS_URL);
      this._ws = ws;

      ws.on("open", () => {
        this._reconnectMs = 1000;
        this.logger("WS: connected to Polymarket real-time feed");
        if (this._subscribedTokens.size > 0) {
          this._sendSubscription([...this._subscribedTokens]);
        }
      });

      ws.on("message", (raw) => this._handleMessage(raw));

      ws.on("close", (code) => {
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
      const events = JSON.parse(raw.toString());
      const list = Array.isArray(events) ? events : [events];
      this._msgCount += list.length;

      if (this._msgCount % 500 === 0) {
        this.logger(`WS: processed ${this._msgCount} messages`);
      }

      for (const ev of list) {
        const tokenId = ev.asset_id;
        if (!tokenId) continue;

        const conditionId = this._tokenToMarket.get(tokenId);
        if (!conditionId) continue;

        if (ev.event_type === "price_change" || ev.price !== undefined) {
          const yesPrice = parseFloat(ev.price) || null;
          recordSnapshot(this.db, conditionId, {
            yes_price: yesPrice,
            yes_bid:   ev.bid_price ? parseFloat(ev.bid_price) : null,
            yes_ask:   ev.ask_price ? parseFloat(ev.ask_price) : null,
            no_price:  yesPrice !== null ? +(1 - yesPrice).toFixed(4) : null,
          }, "ws");
        }

        if (ev.event_type === "last_trade_price" && ev.price !== undefined) {
          recordTrade(this.db, {
            trade_id:   `${conditionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            ticker:     conditionId,
            price:      parseFloat(ev.price),
            size:       parseFloat(ev.size ?? 0),
            side:       ev.side ?? null,
            trade_time: new Date().toISOString(),
          });
        }
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
    this.db               = db;
    this.logger           = logger;
    this.ws               = new PolymarketWebSocket(db, logger);
    this._snapshotTimer   = null;
    this._refreshInterval = null;
    this._started         = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    this.logger("Pipeline: initializing (Polymarket)...");

    // Step 1: load all active markets into DB
    await fetchAndStoreMarkets(this.db, this.logger);

    // Step 2: subscribe WS to YES token IDs for all active markets
    const active = getActiveMarkets(this.db);
    const tokenMap = active
      .filter((r) => r.yes_token_id)
      .map((r) => ({ token_id: r.yes_token_id, condition_id: r.ticker }));
    this.ws.subscribeTokens(tokenMap);

    // Step 3: take initial REST snapshots
    await runRestSnapshots(this.db, this.logger);

    // Step 4: schedule REST snapshots every N seconds
    this._snapshotTimer = setInterval(
      () => runRestSnapshots(this.db, this.logger),
      SNAPSHOT_INTERVAL_SEC * 1000
    );

    // Step 5: schedule metadata refresh
    this._refreshInterval = setInterval(async () => {
      await fetchAndStoreMarkets(this.db, this.logger);

      const fresh = getActiveMarkets(this.db);
      const newTokens = fresh
        .filter((r) => r.yes_token_id && !this.ws._subscribedTokens.has(r.yes_token_id))
        .map((r) => ({ token_id: r.yes_token_id, condition_id: r.ticker }));
      if (newTokens.length) this.ws.subscribeTokens(newTokens);
    }, REFRESH_INTERVAL_SEC * 1000);

    // Step 6: start WebSocket (non-blocking)
    this.ws.connect().catch((err) => {
      this.logger(`Pipeline: WS fatal error — ${err.message}`);
    });

    this.logger(`Pipeline: running (REST every ${SNAPSHOT_INTERVAL_SEC}s, refresh every ${REFRESH_INTERVAL_SEC}s)`);
  }

  stop() {
    clearInterval(this._snapshotTimer);
    clearInterval(this._refreshInterval);
    this.ws.stop();
    this._started = false;
    this.logger("Pipeline: stopped");
  }
}
