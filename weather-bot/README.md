# Kalshi Weather Paper Trading Bot

GFS ensemble weather forecasts vs Kalshi prediction market prices. Exploits the information asymmetry between 31-member GFS ensemble forecasts (free via Open-Meteo) and Kalshi weather market pricing.

## How It Works

1. Pulls 31-member GFS ensemble forecasts from Open-Meteo (free, no API key)
2. Pulls live Kalshi weather market prices (read-only, no auth needed)
3. Computes edge: ensemble probability vs market implied probability
4. Logs paper trades with Kelly criterion position sizing
5. Auto-resolves trades using NWS API actual temperature data
6. Tracks calibration data to prove the model works

## Requirements

- Node.js >= 18.0.0 (uses native fetch)
- No npm dependencies needed

## Usage

```bash
# Run a single scan
node index.js once

# Run continuous scanning (every 5 minutes)
node index.js

# Check paper trading stats
node index.js stats

# View calibration report
node index.js calibration
```

## Cities Tracked

- New York (Central Park) — KXHIGHNY
- Chicago (Midway) — KXHIGHCHI
- Miami (MIA) — KXHIGHMIA
- Austin (Bergstrom) — KXHIGHAUS

## Trading Parameters

- Minimum edge: 8%
- Kelly fraction: 15% (conservative)
- Max position: 5% of bankroll
- Max trade size: $100
- Starting bankroll: $1,000

## Data Files

All stored in `data/`:
- `paper_trades.json` — All paper trades
- `calibration_log.json` — Every ensemble vs market observation
- `bot_state.json` — Current bankroll, W/L record, pending trades
