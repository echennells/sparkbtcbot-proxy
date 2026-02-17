import { NextResponse } from "next/server";

const LLMS_TXT = `# Spark Bitcoin Proxy API

This proxy provides access to a Spark Bitcoin L2 wallet. All endpoints require Bearer token authentication.

## Authentication
Header: Authorization: Bearer <token>

## Receiving Funds (Refilling the Wallet)

### Get Spark Address (for Spark transfers)
GET /api/info
Returns: { sparkAddress, identityPublicKey }
Send Spark payments directly to the sparkAddress.

### Create Lightning Invoice (for Lightning payments)
POST /api/invoice/create
Body: { "amountSats": 100, "memo": "optional", "expirySeconds": 3600 }
Returns: { encodedInvoice }
Pay this invoice from any Lightning wallet.
Requires admin or invoice role.

### Create Spark Invoice
POST /api/invoice/spark
Body: { "amount": 100, "memo": "optional" }
Returns: { invoice }
Requires admin or invoice role.

## Sending Funds

### Send via Lightning
POST /api/pay
Body: { "invoice": "lnbc...", "maxFeeSats": 10 }
Requires admin or pay-only role.

### Send via Spark Transfer
POST /api/transfer
Body: { "receiverSparkAddress": "spark1...", "amountSats": 100 }
Requires admin or pay-only role.

### L402 Paywall Requests
POST /api/l402
Body: { "url": "https://...", "method": "GET", "maxFeeSats": 10, "preview": false }
Automatically pays L402 challenges and returns the response.
Set "preview": true to check cost without paying (returns invoice, macaroon, price).
Tokens are cached per-domain — subsequent requests reuse the token without paying again.
Retries up to 3 times if server returns empty content after payment.
May return status: "pending" if preimage takes too long — poll GET /api/l402/status?id=<pendingId> to complete.
Requires admin or pay-only role.

### Preview L402 Cost (no payment)
POST /api/l402/preview
Body: { "url": "https://...", "method": "GET" }
Check if a URL requires L402 payment and how much it costs without paying.
Returns: { requires_payment, invoice_amount_sats, invoice, macaroon }
Works with any role.

## Read-Only Endpoints

### Check Balance
GET /api/balance
Returns: { balance, tokenBalances }

### Get Transactions
GET /api/transactions?limit=20&offset=0
Returns recent transfers.

### Get Fee Estimate
GET /api/fee-estimate?invoice=lnbc...
Returns estimated fee for a Lightning payment.

### Get Logs
GET /api/logs
Returns recent activity logs.

## Token Management (Admin Only)

### List Tokens
GET /api/tokens

### Create Token
POST /api/tokens
Body: { "role": "admin" | "invoice" | "pay-only" | "read-only", "label": "description", "maxTxSats?": 100, "dailyBudgetSats?": 1000 }

### Revoke Token
DELETE /api/tokens
Body: { "token": "token_to_revoke" }

## Roles
- admin: Full access (send, receive, create invoices, manage tokens)
- invoice: Read + create invoices (cannot send funds)
- pay-only: Read + pay invoices and L402 (cannot create invoices or transfer)
- read-only: Read only (balance, info, transactions, logs)
`;

export async function GET() {
  return new NextResponse(LLMS_TXT, {
    headers: { "Content-Type": "text/plain" },
  });
}
