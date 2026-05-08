---
name: sparkbtcbot-proxy-deploy
description: Deploy a serverless Spark Bitcoin L2 proxy on Vercel with spending limits, auth, and Redis logging. Use when user wants to set up a new proxy, configure env vars, deploy to Vercel, or manage the proxy infrastructure.
argument-hint: "[Optional: setup, deploy, rotate-token, or configure]"
---

# Deploy sparkbtcbot-proxy

You are an expert in deploying and managing the sparkbtcbot-proxy — a serverless middleware that wraps the Spark Bitcoin L2 SDK behind authenticated REST endpoints on Vercel.

## What This Proxy Does

Gives AI agents scoped wallet access without exposing the mnemonic:
- Role-based token auth (`admin` for full access, `invoice` for read + create invoices only)
- Token management via API — create, list, revoke without redeploying
- Per-transaction and daily spending caps
- Activity logging to Redis
- Lazy detection of paid Lightning invoices

## Rules for Claude when operating this skill

These rules apply whenever this skill is active. The proxy's `SPARK_MNEMONIC` controls all funds in the wallet — leaks into chat or shell history are catastrophic.

- **DO NOT print the mnemonic to chat, logs, or any other output.** Not for verification, not for "let's just check it's correct." If it must be displayed once during setup (step 3), surface it to the user with explicit instructions to save offline, and never echo it back.
- **DO NOT pass the mnemonic on the command line as an arg or in shell variables that get logged.** Pipe it directly into the Vercel env-var API call without it touching shell history.
- **DO NOT run `env`, `printenv`, `echo $SPARK_MNEMONIC`, or `cat .env`** in the conversation.
- **DO NOT include the mnemonic in commit messages, code, fixtures, or git history.**
- **Never include credentials in the chat that you've been given.** Vercel API tokens and Redis credentials should be referenced by name (e.g. `$VERCEL_TOKEN`), not echoed back.
- **If a leak happens, stop and tell the user.** Do not auto-rotate or attempt to "clean up" without explicit user instruction.

## What You Need

**Ask the user for these upfront:**

- Vercel API token (from https://vercel.com/account/tokens) and team ID (from dashboard URL or `vercel teams ls`)
- BIP39 mnemonic for the Spark wallet (or generate one in step 3)
- Node.js 20+

**Generated during setup (don't ask for these):**

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — provisioned automatically when you add the Vercel Marketplace Redis integration (step 2)
- `API_AUTH_TOKEN` — generated in step 4

## Step-by-Step Deployment

### 1. Clone and install

```bash
git clone https://github.com/echennells/sparkbtcbot-proxy.git
cd sparkbtcbot-proxy
npm install
```

### 2. Provision Redis via Vercel Marketplace

Recommended: provision Redis as a Vercel Marketplace integration. Vercel handles provisioning, billing, and auto-populates `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as encrypted env vars on the project. **No separate Upstash account or API key juggling.**

This is a UI step the user does in their browser (the marketplace flow does not have a stable headless API yet):

1. Open the Vercel dashboard → Storage tab on the project (or create the project first in step 5 and come back)
2. Click "Create" → choose Redis (powered by Upstash)
3. Pick the free tier and a region close to where the project will be deployed
4. Connect it to the `sparkbtcbot-proxy` project — env vars are auto-attached

If the user prefers to manage Upstash directly (separate account, multi-project sharing), tell them to create a database at https://console.upstash.com, copy `rest_url` and `rest_token`, and they'll set them manually as env vars in step 5.

### 3. Generate a wallet mnemonic (if needed)

`SparkWallet.initialize()` returns `{ mnemonic, wallet }` when called without a mnemonic. **The mnemonic controls all funds and cannot be re-derived later** (the SDK has no `getMnemonic()` getter).

Two options:

**Option A — let the user generate via a BIP39 tool they trust** (paper wallet, hardware wallet, etc.). Lowest exposure, no shell-history risk. Have them paste the resulting 12 or 24 words into the env-var API call in step 5 *directly* (heredoc into the curl body), never into a shell variable that gets logged.

**Option B — generate via the SDK if the user doesn't have a BIP39 generator handy.** Pipe the output through Vercel's env-var API in one step so the mnemonic never sits in shell history:

```bash
node -e "import('@buildonspark/spark-sdk').then(async ({SparkWallet}) => {
  const r = await SparkWallet.initialize({options:{network:'MAINNET'}});
  process.stdout.write(r.mnemonic);
  await r.wallet.cleanupConnections();
})" | tee /dev/tty | curl -s -X POST "https://api.vercel.com/v10/projects/<PROJECT_ID>/env?teamId=<TEAM_ID>" \
  -H "Authorization: Bearer <VERCEL_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  -d '{"type":"encrypted","key":"SPARK_MNEMONIC","value":"<placeholder — pipe-fill from stdin in real flow>","target":["production","preview","development"]}'
```

In practice, the cleanest pattern is: print the mnemonic to the user's terminal *once* with explicit instructions to save it offline, then immediately POST it to Vercel via API and clear the terminal. The user takes responsibility for never letting it land in `.bash_history` / `.zsh_history`.

**Important:** mnemonic generation can only happen at `SparkWallet.initialize()` time. There is no recovery API. Lose it = lose the wallet.

### 4. Generate an API auth token

```bash
openssl rand -base64 30
```

### 5. Deploy to Vercel

First, create the project and get its ID:

```bash
curl -s -X POST "https://api.vercel.com/v10/projects?teamId=<TEAM_ID>" \
  -H "Authorization: Bearer <VERCEL_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "sparkbtcbot-proxy", "framework": "nextjs"}'
```

The response includes `id` (the project ID) — save it for the next steps.

Then set environment variables via the API. The two `UPSTASH_*` variables are auto-populated by the Vercel Marketplace Redis integration from step 2 — set them manually only if the user is bringing their own Upstash account.

| Variable | Description | Example |
|----------|-------------|---------|
| `SPARK_MNEMONIC` | 12-word BIP39 mnemonic | `fence connect trigger ...` |
| `SPARK_NETWORK` | Spark network | `MAINNET` |
| `API_AUTH_TOKEN` | Admin fallback bearer token | output of step 4 |
| `UPSTASH_REDIS_REST_URL` | Auto-populated by marketplace integration; set only if BYO Upstash | `https://xxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Auto-populated by marketplace integration; set only if BYO Upstash | from Upstash console |
| `MAX_TRANSACTION_SATS` | Per-transaction spending cap | `10000` |
| `DAILY_BUDGET_SATS` | Daily spending cap (resets midnight UTC) | `100000` |

**Important:** Do NOT use `vercel env add` with heredoc/`<<<` input — it appends newlines that break the Spark SDK. Use the REST API:

```bash
curl -X POST "https://api.vercel.com/v10/projects/<PROJECT_ID>/env?teamId=<TEAM_ID>" \
  -H "Authorization: Bearer <VERCEL_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"encrypted","key":"SPARK_MNEMONIC","value":"your mnemonic here","target":["production","preview","development"]}'
```

Repeat for each env var (use `"type":"plain"` for non-sensitive values like `SPARK_NETWORK`).

Then deploy using environment variables for reliable non-interactive deployment:

```bash
npm install -g vercel

VERCEL_ORG_ID=<TEAM_ID> VERCEL_PROJECT_ID=<PROJECT_ID> \
  vercel deploy --prod --yes --token <VERCEL_TOKEN>
```

**Troubleshooting:**
- `ERESOLVE` npm errors: Install vercel globally with `npm install -g vercel` instead of using npx
- "Project was deleted" errors: Remove stale config with `rm -rf .vercel/` and retry
- "missing_scope" errors: Use the `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` env vars as shown above

### 6. Test

```bash
curl -H "Authorization: Bearer <your-token>" https://<your-deployment>.vercel.app/api/balance
```

Should return `{"success":true,"data":{"balance":"0","tokenBalances":{}}}`.

### 7. Create scoped tokens (optional)

Use the admin token to create limited tokens for agents:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"role": "invoice", "label": "my-agent"}' \
  https://<your-deployment>.vercel.app/api/tokens
```

The response includes the full token string — save it, it's only shown once. See the **Token Roles** section below for details.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/llms.txt` | API documentation for bots (no auth required) |
| GET | `/api/balance` | Wallet balance (sats + tokens) |
| GET | `/api/info` | Spark address and identity pubkey |
| GET | `/api/transactions` | Transfer history (`?limit=&offset=`) |
| GET | `/api/deposit-address` | Bitcoin L1 deposit address |
| GET | `/api/fee-estimate` | Lightning send fee estimate (`?invoice=`) |
| GET | `/api/logs` | Recent activity logs (`?limit=`) |
| POST | `/api/invoice/create` | Create Lightning invoice (`{amountSats, memo?, expirySeconds?}`) |
| POST | `/api/invoice/spark` | Create Spark invoice (`{amount?, memo?}`) |
| POST | `/api/pay` | Pay Lightning invoice — admin only (`{invoice, maxFeeSats}`) |
| POST | `/api/transfer` | Spark transfer — admin only (`{receiverSparkAddress, amountSats}`) |
| POST | `/api/l402` | Pay L402 paywall — admin only (`{url, method?, headers?, body?, maxFeeSats?}`) |
| GET | `/api/l402/status` | Check/complete pending L402 (`?id=<pendingId>`) |
| GET | `/api/tokens` | List API tokens — admin only |
| POST | `/api/tokens` | Create a new token — admin only (`{role, label}`) |
| DELETE | `/api/tokens` | Revoke a token — admin only (`{token}`) |

## Token Roles

There are two token roles:

| Role | Permissions |
|------|------------|
| `admin` | Everything — read, create invoices, pay, transfer, manage tokens |
| `invoice` | Read (balance, info, transactions, logs, fee-estimate, deposit-address) + create invoices. Cannot pay or transfer. |

The `API_AUTH_TOKEN` env var is a hardcoded admin fallback — it always works even if Redis is down or tokens get wiped. Use it to bootstrap: create scoped tokens via the API, then hand those out to agents.

### Managing tokens

Create an invoice-only token for a merchant bot:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"role": "invoice", "label": "merchant-bot"}' \
  https://<deployment>/api/tokens
```

List all tokens (shows prefixes, labels, roles — not full token strings):

```bash
curl -H "Authorization: Bearer <admin-token>" https://<deployment>/api/tokens
```

Revoke a token:

```bash
curl -X DELETE -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"token": "<full-token-string>"}' \
  https://<deployment>/api/tokens
```

Tokens are stored in Redis (hash `spark:tokens`). They survive redeploys but not Redis flushes.

## L402 Paywall Support

The proxy can pay [L402](https://docs.lightning.engineering/the-lightning-network/l402) Lightning paywalls automatically. Send a URL, and the proxy will:

1. Fetch the URL
2. If 402 returned, parse the invoice and macaroon
3. Pay the Lightning invoice
4. Retry the request with the L402 Authorization header
5. Return the protected content

### Basic usage

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://lightningfaucet.com/api/l402/joke"}' \
  https://<deployment>/api/l402
```

### Handling pending payments (important for agents)

Lightning payments via Spark are asynchronous. The proxy polls for up to ~7.5 seconds, but if the preimage isn't available in time, it returns a **pending** status:

```json
{
  "success": true,
  "data": {
    "status": "pending",
    "pendingId": "a1b2c3d4e5f6...",
    "message": "Payment sent but preimage not yet available. Poll GET /api/l402/status?id=<pendingId> to complete.",
    "priceSats": 21
  }
}
```

**Your agent MUST handle this case.** The payment has already been sent — if you don't poll for completion, you lose the sats without getting the content.

**Retry loop (pseudocode):**

```
response = POST /api/l402 { url: "..." }

if response.data.status == "pending":
    pendingId = response.data.pendingId
    for attempt in 1..10:
        sleep(3 seconds)
        status = GET /api/l402/status?id={pendingId}
        if status.data.status != "pending":
            return status.data  # Success or failure
    # Give up after ~30 seconds
    raise "L402 payment timed out"
else:
    return response.data  # Immediate success
```

**Key points:**
- **Token caching**: Paid L402 tokens are cached per-domain (up to 24 hours). Subsequent requests to the same domain reuse the cached token without paying again. If the token expires, the proxy pays for a new one automatically.
- Pending records expire after 1 hour
- The `/api/l402/status` endpoint polls Spark for up to 5 seconds per call
- If the payment failed on Spark's side, status will return an error
- Once complete, the pending record is deleted from Redis
- The proxy automatically retries the final fetch up to 3 times (200ms delay) if the response is empty — some servers don't return content immediately after payment

## Common Operations

### Rotate the admin fallback token

1. Generate a new token: `openssl rand -base64 30`
2. Update `API_AUTH_TOKEN` in Vercel env vars (via dashboard or API)
3. Redeploy:
   ```bash
   VERCEL_ORG_ID=<TEAM_ID> VERCEL_PROJECT_ID=<PROJECT_ID> \
     vercel deploy --prod --yes --token <VERCEL_TOKEN>
   ```
4. Update any agents using the old token

Redis-stored tokens are not affected by this — they continue working.

### Adjust spending limits

Update `MAX_TRANSACTION_SATS` and `DAILY_BUDGET_SATS` in Vercel env vars and redeploy:

```bash
VERCEL_ORG_ID=<TEAM_ID> VERCEL_PROJECT_ID=<PROJECT_ID> \
  vercel deploy --prod --yes --token <VERCEL_TOKEN>
```

Budget resets daily at midnight UTC.

### Check logs

```bash
curl -H "Authorization: Bearer <token>" https://<deployment>/api/logs?limit=20
```

## Architecture

- **Vercel serverless functions** — each request spins up, initializes the Spark SDK (~1.5s), handles the request, and shuts down. No always-on process, no billing when idle.
- **Upstash Redis** — stores daily spend counters, activity logs, pending invoice tracking, and API tokens. Accessed over HTTP REST (no persistent connection needed). Free tier is limited to 1 database.
- **Spark SDK** — `@buildonspark/spark-sdk` connects to Spark Signing Operators via gRPC over HTTP/2. Pure JavaScript, no native addons.
- **Lazy invoice check** — on every request, the middleware checks Redis for pending invoices and compares against recent wallet transfers. Expired invoices are cleaned up, paid ones are logged. Max 5 checks per request, wrapped in try/catch so failures never affect the main request.
