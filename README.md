# sparkbtcbot-proxy

A serverless proxy that lets AI agents use a [Spark](https://www.spark.info/) Bitcoin L2 wallet over HTTP, without exposing the private key.

[Spark](https://www.spark.info/) is a Bitcoin L2 with instant payments and sub-satoshi fees. This proxy wraps the Spark SDK behind authenticated REST endpoints so agents can check balances, send payments, and create invoices — while you keep the mnemonic safe on the server.

## Why use this?

If you give an agent direct SDK access ([sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill)), the agent holds your mnemonic. That's fine for testing, but risky in production.

This proxy solves that:

- **Mnemonic stays on server** — agents get bearer tokens, not keys
- **Spending limits** — cap per-transaction and daily spend (global or per-token)
- **Revocable access** — cut off a compromised agent without moving funds
- **Role-based auth** — give agents invoice-only access if they don't need to spend
- **L402 support** — pay Lightning paywalls automatically and fetch protected content

## Token roles

| Role | Permissions |
|------|-------------|
| `admin` | Full access: read, create invoices, pay, transfer, manage tokens |
| `invoice` | Read-only + create invoices. Cannot pay or transfer. |

The `API_AUTH_TOKEN` env var is a hardcoded admin fallback — it always works even if Redis is down. Use it to bootstrap: create scoped tokens via the API, then hand those to agents.

## API

All routes require `Authorization: Bearer <token>`.

| Method | Route | Description | Body |
|--------|-------|-------------|------|
| GET | `/api/balance` | Wallet balance (sats + tokens) | — |
| GET | `/api/info` | Spark address and pubkey | — |
| GET | `/api/transactions` | Transfer history | `?limit=&offset=` |
| GET | `/api/deposit-address` | Bitcoin L1 deposit address | — |
| GET | `/api/fee-estimate` | Lightning fee estimate | `?invoice=<bolt11>` |
| GET | `/api/logs` | Activity logs | `?limit=` |
| POST | `/api/invoice/create` | Create BOLT11 invoice | `{amountSats, memo?, expirySeconds?}` |
| POST | `/api/invoice/spark` | Create Spark invoice | `{amount?, memo?}` |
| POST | `/api/pay` | Pay Lightning invoice | `{invoice, maxFeeSats}` |
| POST | `/api/transfer` | Send to Spark address | `{receiverSparkAddress, amountSats}` |
| POST | `/api/l402` | Pay L402 paywall and fetch content | `{url, method?, headers?, body?, maxFeeSats?}` |
| GET | `/api/l402/status` | Check/complete pending L402 | `?id=<pendingId>` |
| GET | `/api/tokens` | List tokens | — |
| POST | `/api/tokens` | Create token | `{role, label, maxTxSats?, dailyBudgetSats?}` |
| DELETE | `/api/tokens` | Revoke token | `{token}` |

**Notes:**
- `POST /api/pay`, `POST /api/transfer`, and `POST /api/l402` require an `admin` token
- Token management routes (`/api/tokens`) require an `admin` token
- All other routes work with either role

### Example: create an invoice

```bash
curl -X POST https://your-deployment.vercel.app/api/invoice/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountSats": 1000, "memo": "Test invoice"}'
```

Returns:
```json
{"success": true, "data": {"encodedInvoice": "lnbc10u1p..."}}
```

### Example: L402 paywall

[L402](https://docs.lightning.engineering/the-lightning-network/l402) lets agents pay for API access with Lightning. The proxy handles the full flow: detect 402, pay invoice, get preimage, retry with auth.

```bash
curl -X POST https://your-deployment.vercel.app/api/l402 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://lightningfaucet.com/api/l402/joke"}'
```

Returns:
```json
{
  "success": true,
  "data": {
    "status": 200,
    "paid": true,
    "priceSats": 21,
    "preimage": "be2ebe7c...",
    "data": {"setup": "What's a programmer's favorite hangout?", "punchline": "Foo Bar!"}
  }
}
```

#### Handling pending L402 payments

Lightning payments via Spark are asynchronous. If the payment succeeds but the preimage isn't available within the timeout window (~7.5 seconds), the proxy returns a `pending` status instead of failing:

```json
{
  "success": true,
  "data": {
    "status": "pending",
    "pendingId": "a1b2c3d4...",
    "message": "Payment sent but preimage not yet available. Poll GET /api/l402/status?id=<pendingId> to complete.",
    "priceSats": 21
  }
}
```

**Agents must handle this case.** When you receive `status: "pending"`:

1. Wait 2-5 seconds
2. Call `GET /api/l402/status?id=<pendingId>`
3. If still pending, repeat steps 1-2 (up to ~30 seconds total)
4. Once complete, you'll get the full response with the protected content

```bash
# Poll for completion
curl "https://your-deployment.vercel.app/api/l402/status?id=a1b2c3d4..." \
  -H "Authorization: Bearer $TOKEN"
```

The pending state is stored in Redis with a 1-hour TTL. If you don't poll within that window, the pending record expires and you'll need to make a new L402 request (which will pay again).

**Important for agent developers:** Your agent logic should include a retry loop for L402 requests. The payment has already been sent — failing to poll means you paid but didn't get the content.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPARK_MNEMONIC` | Yes | 12-word BIP39 mnemonic for the Spark wallet |
| `SPARK_NETWORK` | Yes | `MAINNET` or `TESTNET` |
| `API_AUTH_TOKEN` | Yes | Admin fallback token (bootstrap, emergencies) |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis auth token |
| `MAX_TRANSACTION_SATS` | No | Global per-tx limit (default: 1000) |
| `DAILY_BUDGET_SATS` | No | Global daily limit (default: 10000) |

## Getting started

You'll need a [Vercel](https://vercel.com) account (free tier works) and an [Upstash Redis](https://console.upstash.com) database (free tier works).

```bash
git clone https://github.com/echennells/sparkbtcbot-proxy.git
cd sparkbtcbot-proxy
npm install
npx vercel --prod
```

Set the environment variables in the Vercel dashboard, then redeploy.

For detailed step-by-step instructions (including generating a mnemonic and creating the Redis database via API), see [`skills/deploy/SKILL.md`](skills/deploy/SKILL.md). That file is also a Claude skill you can give to an agent to handle deployment for you.

## See also

[sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill) — gives an agent direct Spark SDK access. Simpler (no server), but the agent holds the mnemonic and there are no spending limits.
