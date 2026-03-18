import express from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";

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
app.use(express.json());
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

  // If the secret doesn't have PEM headers, wrap it
  if (!privateKey.includes("-----BEGIN")) {
    privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
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

app.listen(PORT, () => {
  console.log(`Kalshi proxy running on port ${PORT}`);
});
