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
  console.error("Missing KALSHI_KEY or KALSHI_SECRET environment variables.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(helmet());
app.use(cors());
app.use(morgan("tiny"));
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

function requireProxyApiKey(req, res, next) {
  if (!PROXY_API_KEY) return next();
  const incomingKey = req.header("x-proxy-api-key") || req.query.api_key;
  if (incomingKey !== PROXY_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function signRequest(method, path, body = "") {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const signature = crypto
    .createHmac("sha256", KALSHI_SECRET)
    .update(message)
    .digest("base64");

  return { timestamp, signature };
}

async function kalshiGet(path, params = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const { timestamp, signature } = signRequest("GET", normalizedPath);

  const response = await axios.get(`${BASE_KALSHI_URL}${normalizedPath}`, {
    params,
    timeout: 10000,
    headers: {
      "KALSHI-ACCESS-KEY": KALSHI_KEY,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp
    }
  });

  return response.data;
}

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/markets", requireProxyApiKey, async (req, res) => {
  try {
    const data = await kalshiGet("/markets", req.query);
    res.json(data);
  } catch (error) {
    res.status(error?.response?.status || 500).json({
      error: "kalshi_error",
      message: error?.response?.data || error.message
    });
  }
});

app.get("/market/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const data = await kalshiGet(`/markets/${encodeURIComponent(req.params.ticker)}`);
    res.json(data);
  } catch (error) {
    res.status(error?.response?.status || 500).json({
      error: "kalshi_error",
      message: error?.response?.data || error.message
    });
  }
});

app.get("/orderbook/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const data = await kalshiGet(`/markets/${encodeURIComponent(req.params.ticker)}/orderbook`, req.query);
    res.json(data);
  } catch (error) {
    res.status(error?.response?.status || 500).json({
      error: "kalshi_error",
      message: error?.response?.data || error.message
    });
  }
});

app.get("/trades/:ticker", requireProxyApiKey, async (req, res) => {
  try {
    const data = await kalshiGet(`/markets/${encodeURIComponent(req.params.ticker)}/trades`, req.query);
    res.json(data);
  } catch (error) {
    res.status(error?.response?.status || 500).json({
      error: "kalshi_error",
      message: error?.response?.data || error.message
    });
  }
});

app.get("/openapi.json", (req, res) => {
  res.sendFile(new URL("./openapi.json", import.meta.url).pathname);
});

app.listen(PORT, () => {
  console.log(`Kalshi proxy running on port ${PORT}`);
});
