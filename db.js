import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "./data/kalshi.db";

let _db = null;

export function createDb(dbPath = DB_PATH) {
  if (_db) return _db;

  // Ensure the directory exists (survives Railway restarts with a volume mount)
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(resolved);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      ticker          TEXT PRIMARY KEY,
      title           TEXT,
      category        TEXT,
      floor_strike    REAL,
      status          TEXT,
      close_time      TEXT,
      rules_primary   TEXT,
      volume          REAL DEFAULT 0,
      liquidity       REAL DEFAULT 0,
      winner          TEXT,
      yes_token_id    TEXT,
      no_token_id     TEXT,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker          TEXT NOT NULL,
      yes_price       REAL,
      yes_bid         REAL,
      yes_ask         REAL,
      no_price        REAL,
      spread          REAL,
      volume          REAL,
      snapshot_time   TEXT NOT NULL,
      source          TEXT DEFAULT 'rest'
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_time
      ON price_snapshots(ticker, snapshot_time);

    CREATE TABLE IF NOT EXISTS trades (
      trade_id        TEXT PRIMARY KEY,
      ticker          TEXT NOT NULL,
      price           REAL NOT NULL,
      size            REAL NOT NULL,
      side            TEXT,
      trade_time      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_ticker_time
      ON trades(ticker, trade_time);
  `);

  // Migrate existing DBs that don't have token ID columns yet
  try { db.exec("ALTER TABLE markets ADD COLUMN yes_token_id TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE markets ADD COLUMN no_token_id TEXT"); } catch (_) {}
  // Migrate snapshots table
  try { db.exec("ALTER TABLE price_snapshots ADD COLUMN volume REAL"); } catch (_) {}

  _db = db;
  return db;
}

// ─── Market helpers ───────────────────────────────────────────────────────────

const _upsertMarket = (db) =>
  db.prepare(`
    INSERT INTO markets
      (ticker, title, category, floor_strike, status, close_time,
       rules_primary, volume, liquidity, winner, yes_token_id, no_token_id, updated_at)
    VALUES
      (@ticker, @title, @category, @floor_strike, @status, @close_time,
       @rules_primary, @volume, @liquidity, @winner, @yes_token_id, @no_token_id, @updated_at)
    ON CONFLICT(ticker) DO UPDATE SET
      title         = excluded.title,
      status        = excluded.status,
      close_time    = excluded.close_time,
      volume        = excluded.volume,
      liquidity     = excluded.liquidity,
      winner        = excluded.winner,
      yes_token_id  = excluded.yes_token_id,
      no_token_id   = excluded.no_token_id,
      updated_at    = excluded.updated_at
  `);

export function upsertMarket(db, market) {
  // Polymarket market shape: condition_id, question, tokens[], active, closed, end_date_iso, volumeClob, liquidityClob, tags[]
  const yesToken = market.tokens?.find(t => t.outcome === "Yes") || market.tokens?.[0];
  const noToken  = market.tokens?.find(t => t.outcome === "No")  || market.tokens?.[1];

  _upsertMarket(db).run({
    ticker:        market.condition_id || market.ticker || "",
    title:         market.question     || market.title  || "",
    category:      market.tags?.[0]?.label || market.tags?.[0]?.id || market.category || "",
    floor_strike:  null,
    status:        (market.active && !market.closed) ? "open" : (market.status || "closed"),
    close_time:    market.end_date_iso || market.close_time || null,
    rules_primary: market.description  || market.rules_primary || "",
    volume:        parseFloat(market.volumeClob  ?? market.volume  ?? 0) || 0,
    liquidity:     parseFloat(market.liquidityClob ?? market.liquidity ?? 0) || 0,
    winner:        market.winner ?? null,
    yes_token_id:  yesToken?.token_id || null,
    no_token_id:   noToken?.token_id  || null,
    updated_at:    new Date().toISOString(),
  });
}

export function getActiveMarkets(db, limit = 2000) {
  return db.prepare(`
    SELECT ticker, yes_token_id, no_token_id, volume
    FROM markets
    WHERE status = 'open' AND yes_token_id IS NOT NULL
    ORDER BY liquidity DESC, volume DESC
    LIMIT ?
  `).all(limit);
}

export function getMarket(db, ticker) {
  return db.prepare(`SELECT * FROM markets WHERE ticker = ?`).get(ticker);
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

const _insertSnapshot = (db) =>
  db.prepare(`
    INSERT INTO price_snapshots
      (ticker, yes_price, yes_bid, yes_ask, no_price, spread, volume, snapshot_time, source)
    VALUES
      (@ticker, @yes_price, @yes_bid, @yes_ask, @no_price, @spread, @volume, @snapshot_time, @source)
  `);

export function recordSnapshot(db, ticker, prices, source = "rest") {
  const yes_bid  = prices.yes_bid  ?? null;
  const yes_ask  = prices.yes_ask  ?? null;
  const spread   = (yes_bid !== null && yes_ask !== null) ? yes_ask - yes_bid : null;

  _insertSnapshot(db).run({
    ticker,
    yes_price:     prices.yes_price ?? null,
    yes_bid,
    yes_ask,
    no_price:      prices.no_price  ?? null,
    spread,
    volume:        prices.volume    ?? null,
    snapshot_time: new Date().toISOString(),
    source,
  });
}

export function getPriceHistory(db, ticker, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return db.prepare(`
    SELECT yes_price, yes_bid, yes_ask, no_price, spread, snapshot_time, source
    FROM price_snapshots
    WHERE ticker = ? AND snapshot_time > ?
    ORDER BY snapshot_time ASC
  `).all(ticker, cutoff);
}

export function getLatestPrice(db, ticker) {
  return db.prepare(`
    SELECT yes_price, yes_bid, yes_ask, no_price, spread, snapshot_time
    FROM price_snapshots
    WHERE ticker = ?
    ORDER BY snapshot_time DESC
    LIMIT 1
  `).get(ticker);
}

export function getMarketStats(db, ticker, hours = 24) {
  const history = getPriceHistory(db, ticker, hours);
  if (!history.length) return null;

  const prices = history.map((r) => r.yes_price).filter((p) => p !== null);
  if (!prices.length) return null;

  const n       = prices.length;
  const avg     = prices.reduce((a, b) => a + b, 0) / n;
  const min     = Math.min(...prices);
  const max     = Math.max(...prices);
  const change  = prices[n - 1] - prices[0];

  // Volatility: std dev of per-step changes
  let volatility = 0;
  if (n > 1) {
    const changes = prices.slice(1).map((p, i) => p - prices[i]);
    const mean    = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
    volatility = Math.sqrt(variance);
  }

  // Simple trend direction
  const trend = change > 0.02 ? "rising" : change < -0.02 ? "falling" : "flat";

  return {
    ticker,
    avg_yes_price:    +avg.toFixed(4),
    min_yes_price:    +min.toFixed(4),
    max_yes_price:    +max.toFixed(4),
    price_change:     +change.toFixed(4),
    volatility:       +volatility.toFixed(4),
    trend,
    snapshot_count:   n,
    window_hours:     hours,
    latest_price:     prices[n - 1],
  };
}

export function getMovers(db, hours = 1, minMove = 0.05) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return db.prepare(`
    WITH bounds AS (
      SELECT ticker,
             MIN(snapshot_time) AS first_t,
             MAX(snapshot_time) AS last_t
      FROM price_snapshots
      WHERE snapshot_time > ? AND yes_price IS NOT NULL
      GROUP BY ticker
    ),
    first_snaps AS (
      SELECT b.ticker, p.yes_price AS first_p
      FROM bounds b
      JOIN price_snapshots p
        ON p.ticker = b.ticker AND p.snapshot_time = b.first_t
      WHERE p.yes_price IS NOT NULL
    ),
    last_snaps AS (
      SELECT b.ticker, p.yes_price AS last_p
      FROM bounds b
      JOIN price_snapshots p
        ON p.ticker = b.ticker AND p.snapshot_time = b.last_t
      WHERE p.yes_price IS NOT NULL
    )
    SELECT
      f.ticker,
      m.title,
      f.first_p,
      l.last_p,
      ABS(l.last_p - f.first_p) AS price_move
    FROM first_snaps f
    JOIN last_snaps  l ON f.ticker = l.ticker
    JOIN markets     m ON f.ticker = m.ticker
    WHERE ABS(l.last_p - f.first_p) >= ?
    ORDER BY price_move DESC
    LIMIT 20
  `).all(cutoff, minMove);
}

// ─── Trade helpers ────────────────────────────────────────────────────────────

export function recordTrade(db, trade) {
  db.prepare(`
    INSERT OR IGNORE INTO trades
      (trade_id, ticker, price, size, side, trade_time)
    VALUES
      (@trade_id, @ticker, @price, @size, @side, @trade_time)
  `).run({
    trade_id:   trade.trade_id || trade.id || `${trade.ticker}-${Date.now()}`,
    ticker:     trade.ticker,
    price:      trade.price,
    size:       trade.count ?? trade.size ?? 0,
    side:       trade.taker_side ?? trade.side ?? null,
    trade_time: trade.created_time ?? trade.trade_time ?? new Date().toISOString(),
  });
}

// ─── LMSR Engine ─────────────────────────────────────────────────────────────
//
// C(q) = b × ln(Σ e^(qi / b))  — Hanson's Logarithmic Market Scoring Rule
//
// For a binary market:
//   price_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))   [softmax]
//   cost to move price from p → p' ≈ b × |logit(p') - logit(p)|
//
// b = liquidity depth parameter. Higher b → more capital needed to move price.

function logit(p) {
  p = Math.max(0.001, Math.min(0.999, p));
  return Math.log(p / (1 - p));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Estimate LMSR b parameter from market metadata.
 * b scales with liquidity — higher b means prices are harder to move.
 */
function estimateB(volume, liquidity) {
  // Use liquidity if available, fall back to volume
  const liq = liquidity || volume || 0;
  if (liq <= 0) return 1; // default low liquidity
  // b ≈ liquidity / ln(2) for binary markets (max market maker loss = b*ln2)
  return Math.max(0.5, liq / Math.LN2);
}

/**
 * LMSR cost to move price from p_current to p_target in a binary market.
 * Cost = b × |logit(p_target) - logit(p_current)|
 * This is approximated from the cost function derivative.
 */
function lmsrCost(pCurrent, pTarget, b) {
  return b * Math.abs(logit(pTarget) - logit(pCurrent));
}

/**
 * Compute model price using VWAP, bid/ask imbalance, and momentum.
 *
 * 1. Pull last 20 snapshots
 * 2. VWAP from those snapshots (volume-weighted; falls back to simple avg)
 * 3. Bid/ask imbalance = (bid + ask − 1) / 2
 *      > 0  → overbid (buy pressure), < 0 → oversold (sell pressure)
 * 4. Momentum = price_now − price_30_snapshots_ago (or oldest available)
 * 5. p_model = current_price
 *            + 0.30 × (vwap − current_price)   [mean-reversion toward VWAP]
 *            + 0.30 × momentum                  [trend continuation]
 *            + 0.20 × imbalance                 [order-book pressure]
 * 6. Clamp to [0.01, 0.99]
 */
function computeModelPrice(db, ticker, currentPrice) {
  const snaps = db.prepare(`
    SELECT yes_price, yes_bid, yes_ask, volume
    FROM price_snapshots
    WHERE ticker = ? AND yes_price IS NOT NULL
    ORDER BY snapshot_time DESC
    LIMIT 20
  `).all(ticker);

  if (!snaps.length) return Math.max(0.01, Math.min(0.99, currentPrice));

  // VWAP (volume-weighted avg; weight=1 if volume missing)
  let totalPV = 0, totalV = 0;
  for (const s of snaps) {
    const w = s.volume > 0 ? s.volume : 1;
    totalPV += s.yes_price * w;
    totalV += w;
  }
  const vwap = totalPV / totalV;

  // Momentum: price_now minus the price 30 snapshots ago (or oldest available in last 20)
  const snap30 = db.prepare(`
    SELECT yes_price FROM price_snapshots
    WHERE ticker = ? AND yes_price IS NOT NULL
    ORDER BY snapshot_time DESC
    LIMIT 1 OFFSET 29
  `).get(ticker);
  const priceAnchor = snap30 ? snap30.yes_price : snaps[snaps.length - 1].yes_price;
  const momentum = currentPrice - priceAnchor;

  // Bid/ask imbalance — symmetric: positive = buy pressure, negative = sell pressure
  // For a prediction market: if bid+ask > 1 buyers are aggressive (bullish),
  // if bid+ask < 1 sellers are aggressive (bearish).
  let imbalance = 0;
  for (const s of snaps) {
    if (s.yes_bid !== null && s.yes_ask !== null) {
      imbalance = (s.yes_bid + s.yes_ask - 1) / 2;
      break;
    }
  }

  const p_model = currentPrice
    + 0.30 * (vwap - currentPrice)  // mean-reversion toward VWAP
    + 0.30 * momentum               // trend continuation
    + 0.20 * imbalance;             // order-book pressure

  return Math.max(0.01, Math.min(0.99, p_model));
}

// ─── Reaction Model ───────────────────────────────────────────────────────────
//
// After a large trade (top 5% by size), measure price change at +5m, +15m, +60m.
// delta_t = price_at_t+h - price_at_entry
// Signal if |mean delta at +15m| > 0.02 (consistent direction).

export function getPostTradeDeltas(db, ticker, hours = 24) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const trades = db.prepare(`
    SELECT price, size, trade_time
    FROM trades
    WHERE ticker = ? AND trade_time > ?
    ORDER BY trade_time ASC
  `).all(ticker, cutoff);

  if (trades.length < 5) return null;

  // 95th percentile size threshold
  const sizes = trades.map(t => t.size).sort((a, b) => a - b);
  const p95size = sizes[Math.floor(sizes.length * 0.95)];
  if (p95size <= 0) return null;

  const largeTrades = trades.filter(t => t.size >= p95size);
  if (!largeTrades.length) return null;

  // Fetch snapshots covering the window + 1h buffer for post-trade lookups
  const extCutoff = new Date(Date.now() - (hours + 1) * 3600 * 1000).toISOString();
  const snaps = db.prepare(`
    SELECT yes_price, snapshot_time
    FROM price_snapshots
    WHERE ticker = ? AND snapshot_time > ? AND yes_price IS NOT NULL
    ORDER BY snapshot_time ASC
  `).all(ticker, extCutoff);

  if (snaps.length < 3) return null;

  // Pre-compute ms timestamps once
  const snapMs = snaps.map(s => ({ price: s.yes_price, t: new Date(s.snapshot_time).getTime() }));

  function nearestPrice(targetMs, toleranceMs = 180000) {
    let best = null, bestDiff = Infinity;
    for (const s of snapMs) {
      const diff = Math.abs(s.t - targetMs);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return bestDiff <= toleranceMs ? best : null;
  }

  const d5m = [], d15m = [], d60m = [];

  for (const trade of largeTrades) {
    const tradeMs = new Date(trade.trade_time).getTime();
    const entry = nearestPrice(tradeMs);
    if (!entry) continue;
    const ep = entry.price;

    const s5  = nearestPrice(tradeMs + 5  * 60000);
    const s15 = nearestPrice(tradeMs + 15 * 60000);
    const s60 = nearestPrice(tradeMs + 60 * 60000, 300000);

    if (s5  && s5.t  !== entry.t) d5m.push(s5.price   - ep);
    if (s15 && s15.t !== entry.t) d15m.push(s15.price  - ep);
    if (s60 && s60.t !== entry.t) d60m.push(s60.price  - ep);
  }

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const m5  = mean(d5m);
  const m15 = mean(d15m);
  const m60 = mean(d60m);

  return {
    large_trade_count: largeTrades.length,
    mean_delta_5m:  m5  !== null ? +m5.toFixed(4)  : null,
    mean_delta_15m: m15 !== null ? +m15.toFixed(4) : null,
    mean_delta_60m: m60 !== null ? +m60.toFixed(4) : null,
    reaction_signal: m15 !== null && Math.abs(m15) > 0.02
      ? (m15 > 0 ? 'CONTINUE' : 'REVERSE')
      : null,
  };
}

/**
 * Scan all active markets for LMSR edge.
 *
 * Three models combined:
 *  1. Mispricing Model  — flag |p_model - p_market| > minEdge (default 0.06)
 *  2. Sizing Model      — position_size = bankroll * k * |edge|  (k=0.25 default)
 *  3. Reaction Model    — post-large-trade delta at +5m/+15m/+60m
 *
 * Returns sorted by absolute edge descending.
 */
export function scanMarkets(db, hours = 4, minEdge = 0.03, bankroll = null, k = 0.25) {
  // Get all active markets with their latest snapshot
  const markets = db.prepare(`
    SELECT
      m.ticker, m.title, m.volume, m.liquidity, m.close_time, m.floor_strike, m.status,
      p.yes_price, p.yes_bid, p.yes_ask, p.spread, p.snapshot_time
    FROM markets m
    INNER JOIN price_snapshots p ON m.ticker = p.ticker
    WHERE m.status = 'open'
      AND p.yes_price IS NOT NULL
      AND p.snapshot_time = (
        SELECT MAX(p2.snapshot_time)
        FROM price_snapshots p2
        WHERE p2.ticker = m.ticker AND p2.yes_price IS NOT NULL
      )
  `).all();

  const results = [];

  for (const m of markets) {
    const stats = getMarketStats(db, m.ticker, hours);
    if (!stats || stats.snapshot_count < 10) continue; // require at least 10 snapshots

    const marketPrice = m.yes_price;
    if (marketPrice <= 0.01 || marketPrice >= 0.99) continue; // skip extreme prices

    // Skip illiquid markets with wide spreads
    if (m.spread !== null && m.spread > 0.10) continue;

    const b = estimateB(m.volume, m.liquidity);
    const modelPrice = computeModelPrice(db, m.ticker, marketPrice);
    const edge = modelPrice - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < minEdge) continue;

    const costToExploit = lmsrCost(marketPrice, modelPrice, b);
    // Score: edge magnitude per unit cost — higher = better opportunity
    const score = costToExploit > 0 ? absEdge / costToExploit : absEdge;

    // Sizing Model: fraction = k * |edge|, position = bankroll * fraction
    const fraction = k * absEdge;
    const position_size = (bankroll && bankroll > 0) ? +(bankroll * fraction).toFixed(2) : null;

    // Reaction Model: post-large-trade deltas
    const reaction = getPostTradeDeltas(db, m.ticker, hours);

    results.push({
      ticker: m.ticker,
      title: m.title,
      market_price: +marketPrice.toFixed(4),
      model_price: +modelPrice.toFixed(4),
      edge: +edge.toFixed(4),
      edge_pct: +(edge * 100).toFixed(2),
      b_param: +b.toFixed(2),
      cost_to_exploit: +costToExploit.toFixed(4),
      score: +score.toFixed(4),
      spread: m.spread,
      volume: m.volume || 0,
      liquidity: m.liquidity || 0,
      volatility: stats.volatility,
      trend: stats.trend,
      close_time: m.close_time,
      snapshot_count: stats.snapshot_count,
      signal: edge > 0 ? "BUY" : "SELL",
      confidence: absEdge > 0.08 ? "HIGH" : absEdge > 0.04 ? "MEDIUM" : "LOW",
      updated: m.snapshot_time,
      // Sizing model outputs
      fraction: +fraction.toFixed(4),
      position_size,
      // Reaction model outputs
      delta_5m:  reaction?.mean_delta_5m  ?? null,
      delta_15m: reaction?.mean_delta_15m ?? null,
      delta_60m: reaction?.mean_delta_60m ?? null,
      reaction_signal:    reaction?.reaction_signal    ?? null,
      large_trade_count:  reaction?.large_trade_count  ?? 0,
    });
  }

  // Sort by absolute edge descending (biggest opportunities first)
  results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  return results;
}


// ─── Status ───────────────────────────────────────────────────────────────────

export function getDbStatus(db) {
  const markets      = db.prepare("SELECT COUNT(*) as c FROM markets").get().c;
  const snapshots    = db.prepare("SELECT COUNT(*) as c FROM price_snapshots").get().c;
  const trades       = db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
  const lastSnapshot = db.prepare(
    "SELECT snapshot_time FROM price_snapshots ORDER BY snapshot_time DESC LIMIT 1"
  ).get();

  const marketsWith10Snaps = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ticker FROM price_snapshots
      GROUP BY ticker HAVING COUNT(*) >= 10
    )
  `).get().c;

  const avgSpreadRow = db.prepare(`
    SELECT AVG(p.spread) as avg_spread
    FROM price_snapshots p
    INNER JOIN markets m ON p.ticker = m.ticker
    WHERE m.status = 'open'
      AND p.spread IS NOT NULL
      AND p.snapshot_time = (
        SELECT MAX(p2.snapshot_time) FROM price_snapshots p2
        WHERE p2.ticker = p.ticker AND p2.spread IS NOT NULL
      )
  `).get();

  return {
    markets,
    snapshots,
    trades,
    last_snapshot:             lastSnapshot?.snapshot_time ?? null,
    markets_with_10plus_snaps: marketsWith10Snaps,
    avg_bid_ask_spread:        avgSpreadRow?.avg_spread != null
                                 ? +avgSpreadRow.avg_spread.toFixed(4)
                                 : null,
  };
}
