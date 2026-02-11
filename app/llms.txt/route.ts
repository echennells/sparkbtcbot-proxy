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
Body: { "amountSats": 100, "memo": "optional" }
Returns: { encodedInvoice, paymentHash }
Pay this invoice from any Lightning wallet.

### Create Spark Invoice
POST /api/invoice/spark
Body: { "amountSats": 100, "memo": "optional" }
Returns: { id, encodedInvoice }

## Sending Funds

### Send via Lightning
POST /api/pay
Body: { "invoice": "lnbc...", "maxFeeSats": 10 }
Requires admin role.

### Send via Spark Transfer
POST /api/transfer
Body: { "receiverSparkAddress": "spark1...", "amountSats": 100 }
Requires admin role.

### L402 Paywall Requests
POST /api/l402
Body: { "url": "https://...", "method": "GET", "maxFeeSats": 10 }
Automatically pays L402 challenges and returns the response.
Requires admin role.

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
Body: { "role": "admin" | "invoice", "label": "description" }

### Revoke Token
DELETE /api/tokens
Body: { "token": "token_to_revoke" }

## Roles
- admin: Full access (send, receive, manage tokens)
- invoice: Read-only + create invoices (cannot send funds)
`;

export async function GET() {
  return new NextResponse(LLMS_TXT, {
    headers: { "Content-Type": "text/plain" },
  });
}
