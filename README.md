# sparkbtcbot-proxy

A serverless proxy that lets AI agents use a [Spark](https://www.spark.info/) Bitcoin L2 wallet over HTTP, without touching the private key.

You deploy it once on Vercel. Agents authenticate with a bearer token and hit REST endpoints to check balances, send payments, create invoices, etc. The mnemonic never leaves the server.

## Features

- Bearer token auth
- Per-transaction and daily spending limits
- Activity logging to Redis (invoices, payments, transfers, errors)
- Automatic detection of paid Lightning invoices
- 1-hour default invoice expiry (configurable)

## API

All routes require `Authorization: Bearer <token>`.

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

## Getting started

There are two things in this repo:

**To deploy the proxy**, see [`skills/deploy/SKILL.md`](skills/deploy/SKILL.md). This is a Claude Code skill you can give to an admin agent, or just follow the instructions yourself. You'll need a [Vercel](https://vercel.com) account (free) and an [Upstash Redis](https://console.upstash.com) instance (free) for logging and budget tracking.

**To connect an AI agent to an existing proxy**, install the MCP server:

```bash
cd mcp && npm install
claude mcp add spark-wallet \
  -e SPARK_PROXY_URL=https://your-deployment.vercel.app \
  -e SPARK_PROXY_TOKEN=your-token \
  -- node /path/to/mcp/index.js
```

Or just hit the API directly with HTTP — no MCP required.

## See also

[sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill) — a simpler option that gives the agent direct SDK access. No server, no deploy, but the agent holds the mnemonic and there are no spending limits.
