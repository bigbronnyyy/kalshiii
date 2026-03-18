# Kalshi Railway Template

This is a simple Railway-ready backend that gives your custom GPT live access to Kalshi market data.

## What this does
- Connects securely to Kalshi using your API key and secret
- Exposes simple endpoints your GPT can use:
  - `/healthz`
  - `/markets`
  - `/market/:ticker`
  - `/orderbook/:ticker`
  - `/trades/:ticker`
- Protects your proxy with `PROXY_API_KEY`

## Before you start
You need:
1. A Railway account
2. A GitHub account
3. Your Kalshi API key and secret

## Step-by-step setup

### 1) Download or upload this repo to GitHub
- Create a new GitHub repository
- Upload all files from this folder

### 2) Deploy to Railway
- Go to Railway
- Click **New Project**
- Choose **Deploy from GitHub repo**
- Select your new repo

### 3) Add environment variables in Railway
In Railway, open your project and add these variables:

- `KALSHI_KEY`
- `KALSHI_SECRET`
- `PROXY_API_KEY`
- `PORT=3000`

Use a long random value for `PROXY_API_KEY`.

### 4) Get your Railway URL
Railway will give you a URL like:

`https://your-app-name.up.railway.app`

### 5) Test your backend
Open this in your browser:

`https://your-app-name.up.railway.app/healthz`

You should see a JSON response showing the service is healthy.

## Connect to your Custom GPT

### 1) Open your GPT builder
Go to **Configure** -> **Actions**.

### 2) Paste the OpenAPI schema
Use the contents of `openapi.json`.

### 3) Replace the server URL
In `openapi.json`, replace:

`https://YOUR-RAILWAY-APP.up.railway.app`

with your real Railway URL.

### 4) Add the header
Set this header in your action auth/settings:

- Header name: `x-proxy-api-key`
- Header value: your `PROXY_API_KEY`

## Recommended GPT instruction block
Paste this into your GPT instructions:

```text
When a Kalshi market is mentioned, use live action calls whenever possible.

Rules:
1. If the user gives a ticker, call getMarket first.
2. If pricing depth matters, call getOrderbook.
3. If recent flow matters, call getTrades.
4. Use live prices instead of guessing.
5. If live data is unavailable, clearly say so.
```

## Notes
- This template is read-only. It does not place trades.
- That is intentional. Start with analysis first.
- Keep your Kalshi credentials private.

## Troubleshooting
- If Railway deploy fails, make sure the repo contains `package.json` and `server.js`.
- If Kalshi requests fail, double-check your API key and secret.
- If your GPT cannot call the action, double-check the Railway URL and `x-proxy-api-key` header.
