import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || "kalshi.db";

let _db = null;

export function createDb(dbPath = DB_PATH) {
  if (_db) return _db;

  const db = new Database(path.resolve(dbPath));

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

  _db = db;
  return db;
}

// ─── Market helpers ───────────────────────────────────────────────────────────

const _upsertMarket = (db) =>
  db.prepare(`
    INSERT INTO markets
      (ticker, title, category, floor_strike, status, close_time,
       rules_primary, volume, liquidity, winner, updated_at)
    VALUES
      (@ticker, @title, @category, @floor_strike, @status, @close_time,
       @rules_primary, @volume, @liquidity, @winner, @updated_at)
    ON CONFLICT(ticker) DO UPDATE SET
      title         = excluded.title,
      status        = excluded.status,
      close_time    = excluded.close_time,
      volume        = excluded.volume,
      liquidity     = excluded.liquidity,
      winner        = excluded.winner,
      updated_at    = excluded.updated_at
  `);

export function upsertMarket(db, market) {
  _upsertMarket(db).run({
    ticker:        market.ticker || market.market?.ticker || "",
    title:         market.title  || market.market?.title  || "",
    category:      market.category || market.market?.category || "",
    floor_strike:  market.floor_strike ?? market.market?.floor_strike ?? null,
    status:        market.status  || market.market?.status  || "",
    close_time:    market.close_time || market.market?.close_time || null,
    rules_primary: market.rules_primary || market.market?.rules_primary || "",
    volume:        parseFloat(market.volume  ?? market.market?.volume  ?? 0) || 0,
    liquidity:     parseFloat(market.liquidity ?? market.market?.liquidity ?? 0) || 0,
    winner:        market.winner  ?? market.market?.winner  ?? null,
    updated_at:    new Date().toISOString(),
  });
}

export function getActiveMarkets(db) {
  return db.prepare(`
    SELECT ticker FROM markets WHERE status = 'open'
  `).all();
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

const _insertSnapshot = (db) =>
  db.prepare(`
    INSERT INTO price_snapshots
      (ticker, yes_price, yes_bid, yes_ask, no_price, spread, snapshot_time, source)
    VALUES
      (@ticker, @yes_price, @yes_bid, @yes_ask, @no_price, @spread, @snapshot_time, @source)
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
    WITH window AS (
      SELECT
        ticker,
        MIN(yes_price) as min_p,
        MAX(yes_price) as max_p,
        FIRST_VALUE(yes_price) OVER (PARTITION BY ticker ORDER BY snapshot_time ASC) as first_p,
        LAST_VALUE(yes_price)  OVER (PARTITION BY ticker ORDER BY snapshot_time ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_p
      FROM price_snapshots
      WHERE snapshot_time > ? AND yes_price IS NOT NULL
      GROUP BY ticker
    )
    SELECT
      w.ticker,
      m.title,
      w.first_p,
      w.last_p,
      ABS(w.last_p - w.first_p) as price_move
    FROM window w
    JOIN markets m ON w.ticker = m.ticker
    WHERE ABS(w.last_p - w.first_p) >= ?
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
 * Compute model price from historical stats + LMSR principles.
 *
 * Model combines:
 *  1. Mean reversion (historical avg is an anchor)
 *  2. Trend continuation (short-term momentum)
 *  3. Volatility-adjusted confidence
 *  4. Time decay (closer to expiry → price should polarize toward 0 or 1)
 */
function computeModelPrice(stats, market) {
  const currentPrice = stats.latest_price;
  const avgPrice = stats.avg_yes_price;
  const trend = stats.price_change; // over the stats window
  const vol = stats.volatility;

  // Mean reversion component: pull toward historical average
  const meanRevWeight = 0.35;
  const meanRevTarget = avgPrice;

  // Momentum component: continue recent trend (dampened)
  const momWeight = 0.25;
  const momTarget = Math.max(0.01, Math.min(0.99, currentPrice + trend * 0.5));

  // Market-respect component: current price reflects information we don't have
  const mktWeight = 0.40;
  const mktTarget = currentPrice;

  let modelPrice = meanRevWeight * meanRevTarget + momWeight * momTarget + mktWeight * mktTarget;

  // Time decay adjustment: if market is closing soon, push toward extremes
  if (market.close_time) {
    const hoursToClose = (new Date(market.close_time) - Date.now()) / 3.6e6;
    if (hoursToClose > 0 && hoursToClose < 6) {
      // Near expiry: polarize toward 0 or 1
      const polarize = Math.max(0, 1 - hoursToClose / 6) * 0.15;
      modelPrice = modelPrice > 0.5
        ? modelPrice + polarize * (1 - modelPrice)
        : modelPrice - polarize * modelPrice;
    }
  }

  // Volatility discount: high vol means less certainty in our model
  // Shrink edge toward market price when vol is high
  if (vol > 0.03) {
    const volDiscount = Math.min(0.5, vol * 5);
    modelPrice = modelPrice * (1 - volDiscount) + currentPrice * volDiscount;
  }

  return Math.max(0.01, Math.min(0.99, modelPrice));
}

/**
 * Scan all active markets for LMSR edge.
 * Returns sorted array of opportunities with edge > minEdge.
 */
export function scanMarkets(db, hours = 4, minEdge = 0.02) {
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
    if (!stats || stats.snapshot_count < 3) continue;

    const marketPrice = m.yes_price;
    if (marketPrice <= 0.01 || marketPrice >= 0.99) continue; // Skip extreme prices

    const b = estimateB(m.volume, m.liquidity);
    const modelPrice = computeModelPrice(stats, m);
    const edge = modelPrice - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < minEdge) continue;

    const costToExploit = lmsrCost(marketPrice, modelPrice, b);
    // Score: edge magnitude per unit cost — higher = better opportunity
    const score = costToExploit > 0 ? absEdge / costToExploit : absEdge;

    results.push({
      ticker: m.ticker,
      title: m.title,
      market_price: +marketPrice.toFixed(4),
      model_price: +modelPrice.toFixed(4),
      edge: +edge.toFixed(4),
      edge_pct: +((edge / marketPrice) * 100).toFixed(2),
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
    });
  }

  // Sort by absolute edge descending (biggest opportunities first)
  results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  return results;
}

// ─── LMSR Engine ──────────────────────────────────────────────────────────────
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
 * Compute model price from historical stats + LMSR principles.
 *
 * Model combines:
 *  1. Mean reversion (historical avg is an anchor)
 *  2. Trend continuation (short-term momentum)
 *  3. Volatility-adjusted confidence
 *  4. Time decay (closer to expiry → price should polarize toward 0 or 1)
 */
function computeModelPrice(stats, market) {
  const currentPrice = stats.latest_price;
  const avgPrice = stats.avg_yes_price;
  const trend = stats.price_change; // over the stats window
  const vol = stats.volatility;

  // Mean reversion component: pull toward historical average
  const meanRevWeight = 0.35;
  const meanRevTarget = avgPrice;

  // Momentum component: continue recent trend (dampened)
  const momWeight = 0.25;
  const momTarget = Math.max(0.01, Math.min(0.99, currentPrice + trend * 0.5));

  // Market-respect component: current price reflects information we don't have
  const mktWeight = 0.40;
  const mktTarget = currentPrice;

  let modelPrice = meanRevWeight * meanRevTarget + momWeight * momTarget + mktWeight * mktTarget;

  // Time decay adjustment: if market is closing soon, push toward extremes
  if (market.close_time) {
    const hoursToClose = (new Date(market.close_time) - Date.now()) / 3.6e6;
    if (hoursToClose > 0 && hoursToClose < 6) {
      // Near expiry: polarize toward 0 or 1
      const polarize = Math.max(0, 1 - hoursToClose / 6) * 0.15;
      modelPrice = modelPrice > 0.5
        ? modelPrice + polarize * (1 - modelPrice)
        : modelPrice - polarize * modelPrice;
    }
  }

  // Volatility discount: high vol means less certainty in our model
  // Shrink edge toward market price when vol is high
  if (vol > 0.03) {
    const volDiscount = Math.min(0.5, vol * 5);
    modelPrice = modelPrice * (1 - volDiscount) + currentPrice * volDiscount;
  }

  return Math.max(0.01, Math.min(0.99, modelPrice));
}

/**
 * Scan all active markets for LMSR edge.
 * Returns sorted array of opportunities with edge > minEdge.
 */
export function scanMarkets(db, hours = 4, minEdge = 0.02) {
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
    if (!stats || stats.snapshot_count < 3) continue;

    const marketPrice = m.yes_price;
    if (marketPrice <= 0.01 || marketPrice >= 0.99) continue; // Skip extreme prices

    const b = estimateB(m.volume, m.liquidity);
    const modelPrice = computeModelPrice(stats, m);
    const edge = modelPrice - marketPrice;
    const absEdge = Math.abs(edge);

    if (absEdge < minEdge) continue;

    const costToExploit = lmsrCost(marketPrice, modelPrice, b);
    // Score: edge magnitude per unit cost — higher = better opportunity
    const score = costToExploit > 0 ? absEdge / costToExploit : absEdge;

    results.push({
      ticker: m.ticker,
      title: m.title,
      market_price: +marketPrice.toFixed(4),
      model_price: +modelPrice.toFixed(4),
      edge: +edge.toFixed(4),
      edge_pct: +((edge / marketPrice) * 100).toFixed(2),
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
    });
  }

  // Sort by absolute edge descending (biggest opportunities first)
  results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  return results;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getDbStatus(db) {
  const markets        = db.prepare("SELECT COUNT(*) as c FROM markets").get().c;
  const snapshots      = db.prepare("SELECT COUNT(*) as c FROM price_snapshots").get().c;
  const trades         = db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
  const lastSnapshot   = db.prepare(
    "SELECT snapshot_time FROM price_snapshots ORDER BY snapshot_time DESC LIMIT 1"
  ).get();

  return {
    markets,
    snapshots,
    trades,
    last_snapshot: lastSnapshot?.snapshot_time ?? null,
  };
}
