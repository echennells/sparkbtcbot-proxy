# sparkbtcbot-proxy

Serverless proxy for the [Spark](https://www.spark.info/) Bitcoin L2, designed to give AI agents scoped access to a Spark wallet without exposing the mnemonic.

Deploys to Vercel. Includes an MCP server for Claude Code / MCP-compatible assistants.

## vs [sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill)

[sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill) gives an AI agent direct access to the Spark SDK — simpler to set up, no server needed, but the agent holds the mnemonic and has full control of the wallet.

This proxy adds a layer between the agent and the wallet:

- **Mnemonic stays on the server** — the agent only gets an API token
- **Spending limits** — per-transaction and daily caps enforced server-side
- **Activity logging** — all actions logged to Redis, queryable via API
- **Invoice tracking** — lazy detection of paid Lightning invoices
- **Shared access** — multiple agents or bots can use the same wallet through the API

## What it does

- Wraps the `@buildonspark/spark-sdk` behind authenticated REST endpoints
- Per-transaction and daily spending limits (configurable via env vars)
- Logs all activity (invoices, payments, transfers, errors) to Redis
- Lazy detection of paid Lightning invoices on each request
- 1-hour default invoice expiry (configurable per-request)

## API routes

All routes require `Authorization: Bearer <token>` header.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/balance` | Wallet balance (sats + tokens) |
| GET | `/api/info` | Spark address and identity pubkey |
| GET | `/api/transactions` | Transfer history (`?limit=&offset=`) |
| GET | `/api/deposit-address` | Bitcoin L1 deposit address |
| GET | `/api/fee-estimate` | Lightning send fee estimate (`?invoice=`) |
| GET | `/api/logs` | Recent activity logs (`?limit=`) |
| POST | `/api/invoice/create` | Create Lightning (BOLT11) invoice |
| POST | `/api/invoice/spark` | Create Spark-native invoice |
| POST | `/api/pay` | Pay a Lightning invoice |
| POST | `/api/transfer` | Send sats to a Spark address |

## Setup

### Environment variables (Vercel)

```
SPARK_MNEMONIC=<12-word BIP39 mnemonic>
SPARK_NETWORK=MAINNET
API_AUTH_TOKEN=<random token for authenticating requests>
UPSTASH_REDIS_REST_URL=<your Upstash Redis URL>
UPSTASH_REDIS_REST_TOKEN=<your Upstash Redis token>
MAX_TRANSACTION_SATS=10000
DAILY_BUDGET_SATS=100000
```

### Deploy

```bash
npm install
npx vercel --prod
```

### MCP server (optional)

For AI assistants that use the Model Context Protocol:

```bash
cd mcp && npm install
claude mcp add spark-wallet \
  -e SPARK_PROXY_URL=https://your-deployment.vercel.app \
  -e SPARK_PROXY_TOKEN=your-token \
  -- node /path/to/mcp/index.js
```

This exposes 10 tools: `get_balance`, `get_info`, `get_transactions`, `get_deposit_address`, `get_fee_estimate`, `get_logs`, `create_invoice`, `create_spark_invoice`, `pay_invoice`, `transfer`.
