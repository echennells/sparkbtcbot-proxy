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

## Two skills, two audiences

This repo contains two separate things for two different use cases:

### 1. Deploy skill (`skills/deploy/`) — for the admin agent

A Claude Code skill that knows how to set up and deploy the proxy from scratch: clone the repo, configure Vercel, set env vars, deploy, rotate tokens, adjust limits. Give this to the agent that manages your infrastructure.

Install:
```bash
# Copy to your Claude Code skills directory
cp -r skills/deploy ~/.claude/skills/sparkbtcbot-proxy-deploy
```

### 2. MCP server (`mcp/`) — for the wallet agent

10 tools for interacting with an already-running proxy: check balance, send sats, create invoices, read logs. Give this to agents that need to transact.

Install:
```bash
cd mcp && npm install
claude mcp add spark-wallet \
  -e SPARK_PROXY_URL=https://your-deployment.vercel.app \
  -e SPARK_PROXY_TOKEN=your-token \
  -- node /path/to/mcp/index.js
```

Tools: `get_balance`, `get_info`, `get_transactions`, `get_deposit_address`, `get_fee_estimate`, `get_logs`, `create_invoice`, `create_spark_invoice`, `pay_invoice`, `transfer`.

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

## Quick setup

See the [deploy skill](skills/deploy/SKILL.md) for full step-by-step instructions, or the short version:

1. Clone and `npm install`
2. Create an Upstash Redis instance
3. Set env vars on Vercel (`SPARK_MNEMONIC`, `API_AUTH_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, etc.)
4. `npx vercel --prod`
