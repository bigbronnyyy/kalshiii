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
