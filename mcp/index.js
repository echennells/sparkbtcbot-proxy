#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.SPARK_PROXY_URL;
const API_TOKEN = process.env.SPARK_PROXY_TOKEN;

if (!API_URL || !API_TOKEN) {
  console.error("SPARK_PROXY_URL and SPARK_PROXY_TOKEN environment variables are required");
  process.exit(1);
}

async function callApi(path, options = {}) {
  const url = `${API_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res.json();
}

const server = new McpServer({
  name: "spark-mcp",
  version: "1.0.0",
});

// Read-only tools

server.tool("get_balance", "Get wallet balance in sats and tokens", {}, async () => {
  const result = await callApi("/api/balance");
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

server.tool("get_info", "Get wallet Spark address and identity public key", {}, async () => {
  const result = await callApi("/api/info");
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  "get_transactions",
  "Get transfer history",
  {
    limit: z.number().optional().default(20).describe("Max number of transfers to return"),
    offset: z.number().optional().default(0).describe("Pagination offset"),
  },
  async ({ limit, offset }) => {
    const result = await callApi(`/api/transactions?limit=${limit}&offset=${offset}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool("get_deposit_address", "Get a single-use Bitcoin deposit address (L1 → Spark)", {}, async () => {
  const result = await callApi("/api/deposit-address");
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  "get_fee_estimate",
  "Estimate the fee for paying a Lightning invoice",
  {
    invoice: z.string().describe("BOLT11 Lightning invoice to estimate fees for"),
  },
  async ({ invoice }) => {
    const result = await callApi(`/api/fee-estimate?invoice=${encodeURIComponent(invoice)}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Receive tools

server.tool(
  "create_invoice",
  "Create a Lightning (BOLT11) invoice to receive payment",
  {
    amountSats: z.number().positive().describe("Amount in sats"),
    memo: z.string().optional().describe("Invoice description"),
    expirySeconds: z.number().optional().describe("Invoice expiry in seconds"),
  },
  async ({ amountSats, memo, expirySeconds }) => {
    const result = await callApi("/api/invoice/create", {
      method: "POST",
      body: JSON.stringify({ amountSats, memo, expirySeconds }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "create_spark_invoice",
  "Create a Spark native invoice (only payable by other Spark wallets)",
  {
    amount: z.number().optional().describe("Amount in sats"),
    memo: z.string().optional().describe("Invoice description"),
  },
  async ({ amount, memo }) => {
    const result = await callApi("/api/invoice/spark", {
      method: "POST",
      body: JSON.stringify({ amount, memo }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Send tools (spending controls enforced by middleware)

server.tool(
  "pay_invoice",
  "Pay a Lightning (BOLT11) invoice. Subject to per-transaction and daily spending limits.",
  {
    invoice: z.string().describe("BOLT11 Lightning invoice to pay"),
    maxFeeSats: z.number().describe("Maximum fee in sats you're willing to pay"),
  },
  async ({ invoice, maxFeeSats }) => {
    const result = await callApi("/api/pay", {
      method: "POST",
      body: JSON.stringify({ invoice, maxFeeSats }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "transfer",
  "Send sats to another Spark wallet. Zero fee, instant. Subject to per-transaction and daily spending limits.",
  {
    receiverSparkAddress: z.string().describe("Recipient's Spark address (sp1p...)"),
    amountSats: z.number().positive().describe("Amount in sats to send"),
  },
  async ({ receiverSparkAddress, amountSats }) => {
    const result = await callApi("/api/transfer", {
      method: "POST",
      body: JSON.stringify({ receiverSparkAddress, amountSats }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_logs",
  "Get recent activity logs (invoices, payments, transfers, errors)",
  {
    limit: z.number().optional().default(50).describe("Max number of log entries to return (max 200)"),
  },
  async ({ limit }) => {
    const result = await callApi(`/api/logs?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Token management (admin only)

server.tool(
  "create_token",
  "Create a new API token with a specific role. Requires admin token.",
  {
    role: z.enum(["admin", "invoice"]).describe('Token role: "admin" (full access) or "invoice" (read + create invoices only)'),
    label: z.string().describe("Label to identify this token (e.g. 'merchant-bot')"),
  },
  async ({ role, label }) => {
    const result = await callApi("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ role, label }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "list_tokens",
  "List all API tokens (shows labels, roles, and prefixes — not full tokens). Requires admin token.",
  {},
  async () => {
    const result = await callApi("/api/tokens");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "revoke_token",
  "Revoke an API token. Requires admin token.",
  {
    token: z.string().describe("The full token string to revoke"),
  },
  async ({ token }) => {
    const result = await callApi("/api/tokens", {
      method: "DELETE",
      body: JSON.stringify({ token }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Start server

const transport = new StdioServerTransport();
await server.connect(transport);
