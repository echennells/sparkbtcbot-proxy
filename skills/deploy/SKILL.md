---
name: sparkbtcbot-proxy-deploy
description: Deploy a serverless Spark Bitcoin L2 proxy on Vercel with spending limits, auth, and Redis logging. Use when user wants to set up a new proxy, configure env vars, deploy to Vercel, or manage the proxy infrastructure.
argument-hint: "[Optional: setup, deploy, rotate-token, or configure]"
---

# Deploy sparkbtcbot-proxy

You are an expert in deploying and managing the sparkbtcbot-proxy — a serverless middleware that wraps the Spark Bitcoin L2 SDK behind authenticated REST endpoints on Vercel.

## What This Proxy Does

Gives AI agents scoped wallet access without exposing the mnemonic:
- Auth via bearer token
- Per-transaction and daily spending caps
- Activity logging to Redis
- Lazy detection of paid Lightning invoices
- MCP server for Claude Code integration

## Prerequisites

- Node.js 18+
- A Vercel account (free Hobby tier works)
- An Upstash Redis instance (free tier works)
- A BIP39 mnemonic for the Spark wallet

## Step-by-Step Deployment

### 1. Clone and install

```bash
git clone https://github.com/echennells/sparkbtcbot-proxy.git
cd sparkbtcbot-proxy
npm install
```

### 2. Create Upstash Redis

Go to https://console.upstash.com and create a new Redis database. Copy the REST URL and REST token.

### 3. Generate a wallet mnemonic (if needed)

```javascript
import { SparkWallet } from "@buildonspark/spark-sdk";
const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: null,
  options: { network: "MAINNET" },
});
// Save the mnemonic securely — this controls the wallet funds
```

Or use any BIP39 mnemonic generator. 12 or 24 words.

### 4. Generate an API auth token

```bash
openssl rand -base64 30
```

### 5. Deploy to Vercel

```bash
npx vercel --prod
```

When prompted, accept the defaults. Then set environment variables — use the Vercel REST API or dashboard to avoid trailing newline issues:

```
SPARK_MNEMONIC=<12-word mnemonic>
SPARK_NETWORK=MAINNET
API_AUTH_TOKEN=<token from step 4>
UPSTASH_REDIS_REST_URL=<from step 2>
UPSTASH_REDIS_REST_TOKEN=<from step 2>
MAX_TRANSACTION_SATS=10000
DAILY_BUDGET_SATS=100000
```

**Important:** Do NOT use `vercel env add` with heredoc/`<<<` input — it appends newlines that break the Spark SDK. Either use the Vercel dashboard or the REST API:

```bash
curl -X POST "https://api.vercel.com/v10/projects/<PROJECT_ID>/env?teamId=<TEAM_ID>" \
  -H "Authorization: Bearer <VERCEL_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"encrypted","key":"SPARK_MNEMONIC","value":"your mnemonic here","target":["production","preview","development"]}'
```

Redeploy after setting env vars:

```bash
npx vercel --prod
```

### 6. Test

```bash
curl -H "Authorization: Bearer <your-token>" https://<your-deployment>.vercel.app/api/balance
```

Should return `{"success":true,"data":{"balance":"0","tokenBalances":{}}}`.

### 7. Set up MCP server (optional)

For Claude Code or MCP-compatible assistants:

```bash
cd mcp && npm install
claude mcp add spark-wallet \
  -e SPARK_PROXY_URL=https://<your-deployment>.vercel.app \
  -e SPARK_PROXY_TOKEN=<your-token> \
  -- node /path/to/sparkbtcbot-proxy/mcp/index.js
```

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/balance` | Wallet balance (sats + tokens) |
| GET | `/api/info` | Spark address and identity pubkey |
| GET | `/api/transactions` | Transfer history (`?limit=&offset=`) |
| GET | `/api/deposit-address` | Bitcoin L1 deposit address |
| GET | `/api/fee-estimate` | Lightning send fee estimate (`?invoice=`) |
| GET | `/api/logs` | Recent activity logs (`?limit=`) |
| POST | `/api/invoice/create` | Create Lightning invoice (`{amountSats, memo?, expirySeconds?}`) |
| POST | `/api/invoice/spark` | Create Spark invoice (`{amount?, memo?}`) |
| POST | `/api/pay` | Pay Lightning invoice (`{invoice, maxFeeSats}`) |
| POST | `/api/transfer` | Spark transfer (`{receiverSparkAddress, amountSats}`) |

## Common Operations

### Rotate the API token

1. Generate a new token: `openssl rand -base64 30`
2. Update `API_AUTH_TOKEN` in Vercel env vars
3. Redeploy: `npx vercel --prod`
4. Update any MCP configs or agents using the old token

### Adjust spending limits

Update `MAX_TRANSACTION_SATS` and `DAILY_BUDGET_SATS` in Vercel env vars and redeploy. Budget resets daily at midnight UTC.

### Check logs

```bash
curl -H "Authorization: Bearer <token>" https://<deployment>/api/logs?limit=20
```

## Architecture

- **Vercel serverless functions** — each request spins up, initializes the Spark SDK (~1.5s), handles the request, and shuts down. No always-on process, no billing when idle.
- **Upstash Redis** — stores daily spend counters, activity logs, and pending invoice tracking. Accessed over HTTP REST (no persistent connection needed).
- **Spark SDK** — `@buildonspark/spark-sdk` connects to Spark Signing Operators via gRPC over HTTP/2. Pure JavaScript, no native addons.
- **Lazy invoice check** — on every request, the middleware checks Redis for pending invoices and compares against recent wallet transfers. Expired invoices are cleaned up, paid ones are logged. Max 5 checks per request, wrapped in try/catch so failures never affect the main request.
