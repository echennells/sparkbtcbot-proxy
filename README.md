# sparkbtcbot-proxy

A serverless proxy that lets AI agents use a [Spark](https://www.spark.info/) Bitcoin L2 wallet over HTTP, without touching the private key.

You deploy it once on Vercel with Upstash Redis for state. Agents authenticate with a bearer token and hit REST endpoints to check balances, send payments, create invoices, etc. The mnemonic never leaves the server.

## Features

- Role-based token auth (`admin` for full access, `invoice` for read + create invoices only)
- Token management via API — create, list, revoke without redeploying
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
| GET | `/api/tokens` | List API tokens (admin only) |
| POST | `/api/tokens` | Create a new token (admin only) |
| DELETE | `/api/tokens` | Revoke a token (admin only) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPARK_WALLET_MNEMONIC` | Yes | 12-word BIP39 mnemonic for the Spark wallet |
| `API_AUTH_TOKEN` | Yes | Admin fallback token (can create more via API) |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |
| `MAX_TRANSACTION_SATS` | No | Per-tx spending limit (default: 1000) |
| `DAILY_BUDGET_SATS` | No | Daily spending limit (default: 10000) |

## Getting started

See [`skills/deploy/SKILL.md`](skills/deploy/SKILL.md) for deployment instructions. This is a Claude Code skill you can give to an admin agent, or just follow the instructions yourself. You'll need a [Vercel](https://vercel.com) account (free) and an [Upstash Redis](https://console.upstash.com) instance (free).

Once deployed, hit the API with any HTTP client:

```bash
curl https://your-deployment.vercel.app/api/balance \
  -H "Authorization: Bearer your-token"
```

## See also

[sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill) — a simpler option that gives the agent direct SDK access. No server, no deploy, but the agent holds the mnemonic and there are no spending limits.
