# Kalshi Quant Bot

A Railway-ready backend with a Polymarket-style data pipeline that gives your frontend live + historical Kalshi market data with Claude AI analysis.

## What this does

- **Data pipeline**: Continuously polls Kalshi REST API + subscribes to WebSocket feed, storing snapshots and trades in SQLite
- **Proxy endpoints**: Secure proxy for Kalshi API calls (markets, orderbook, trades)
- **History endpoints**: Price history, market stats (avg, volatility, trend), top movers
- **Claude AI proxy**: Routes Claude analysis through backend so the API key stays server-side
- **Quant frontend**: Bayesian probability engine + EV + Kelly sizing + Claude signal generation

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /healthz` | Health check |
| `GET /markets` | List markets (proxied to Kalshi) |
| `GET /market/:ticker` | Single market data |
| `GET /orderbook/:ticker` | Order book |
| `GET /trades/:ticker` | Recent trades |
| `GET /market/:ticker/history?hours=24` | Stored price history from pipeline |
| `GET /market/:ticker/stats?hours=24` | Avg, min, max, volatility, trend |
| `GET /markets/movers?hours=1&min_move=0.05` | Top price movers |
| `GET /db/status` | Pipeline database status |
| `POST /analyze` | Claude AI analysis proxy |

## Setup

### 1) Clone and configure

```bash
cp env.example .env
# Fill in KALSHI_KEY, KALSHI_SECRET, PROXY_API_KEY, ANTHROPIC_API_KEY
npm install
npm start
```

### 2) Deploy to Railway

- Create a new Railway project from this GitHub repo
- Add environment variables (see `env.example`)
- Railway auto-deploys on push

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `KALSHI_KEY` | Yes | Kalshi API key |
| `KALSHI_SECRET` | Yes | Kalshi RSA private key (PEM or raw base64) |
| `PROXY_API_KEY` | No | Optional key to protect proxy endpoints |
| `ANTHROPIC_API_KEY` | No | For Claude AI analysis endpoint |
| `PORT` | No | Server port (default: 3000) |
| `DB_PATH` | No | SQLite file path (default: kalshi.db) |
| `SNAPSHOT_INTERVAL_SEC` | No | REST snapshot frequency (default: 60) |
| `REFRESH_INTERVAL_SEC` | No | Market list refresh frequency (default: 300) |

## Data pipeline

The pipeline runs automatically on startup:

1. **REST poller** — fetches all open markets, stores in SQLite, takes price snapshots every `SNAPSHOT_INTERVAL_SEC` seconds
2. **WebSocket client** — subscribes to real-time ticker and orderbook updates, records snapshots as they arrive
3. **Orchestrator** — refreshes market list every `REFRESH_INTERVAL_SEC` seconds, subscribes new tickers to WebSocket

## Notes

- This template is read-only. It does not place trades.
- Keep your Kalshi credentials private.
- The `KALSHI_SECRET` can be provided as a raw base64 private key or full PEM — the server normalizes both formats.
