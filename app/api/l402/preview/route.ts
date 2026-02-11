import { NextRequest, NextResponse } from "next/server";
import { decode } from "light-bolt11-decoder";
import { verifyAuth } from "@/lib/auth";

interface L402Challenge {
  invoice: string;
  macaroon: string;
  priceSats?: number;
}

function parseL402Response(body: unknown): L402Challenge | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const invoice = obj.invoice || obj.payment_request || obj.pr;
  const macaroon = obj.macaroon || obj.token;

  if (typeof invoice !== "string" || typeof macaroon !== "string") {
    return null;
  }

  const priceSats = typeof obj.price_sats === "number" ? obj.price_sats : undefined;

  return { invoice, macaroon, priceSats };
}

// Shared logic for preview
async function previewL402(url: string, method: string = "GET", headers: Record<string, string> = {}) {
  // Make initial request to check if it's L402-protected
  let initialResponse: Response;
  try {
    initialResponse = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
  } catch (err) {
    return {
      success: false,
      error: `Failed to fetch ${url}: ${err instanceof Error ? err.message : "Unknown error"}`,
      code: "L402_FETCH_ERROR",
      status: 502,
    };
  }

  // If not 402, no payment required
  if (initialResponse.status !== 402) {
    return {
      success: true,
      data: {
        requires_payment: false,
        status: initialResponse.status,
      },
    };
  }

  // Parse 402 response
  let challengeBody: unknown;
  try {
    challengeBody = await initialResponse.json();
  } catch {
    return {
      success: false,
      error: "Failed to parse L402 challenge response",
      code: "L402_PARSE_ERROR",
      status: 502,
    };
  }

  const challenge = parseL402Response(challengeBody);
  if (!challenge) {
    return {
      success: false,
      error: "Invalid L402 response: missing invoice or macaroon",
      code: "L402_INVALID_CHALLENGE",
      status: 502,
    };
  }

  // Decode invoice to get amount
  let invoiceAmountSats: number;
  let expiryTimestamp: number | undefined;
  try {
    const decoded = decode(challenge.invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    if (!amountSection || !("value" in amountSection) || !amountSection.value) {
      return {
        success: false,
        error: "L402 invoice has no amount",
        code: "L402_INVALID_CHALLENGE",
        status: 502,
      };
    }
    invoiceAmountSats = Math.ceil(Number(amountSection.value) / 1000);

    // Try to get expiry
    const expirySection = decoded.sections.find((s) => s.name === "expiry");
    const timestampSection = decoded.sections.find((s) => s.name === "timestamp");
    if (expirySection && "value" in expirySection && timestampSection && "value" in timestampSection) {
      expiryTimestamp = Number(timestampSection.value) + Number(expirySection.value);
    }
  } catch {
    return {
      success: false,
      error: "Failed to decode L402 invoice",
      code: "L402_INVALID_CHALLENGE",
      status: 502,
    };
  }

  return {
    success: true,
    data: {
      requires_payment: true,
      invoice_amount_sats: invoiceAmountSats,
      price_sats: challenge.priceSats,
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      expiry_timestamp: expiryTimestamp,
    },
  };
}

// GET /api/l402/preview?url=...
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (!auth) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing authorization token", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json(
      { success: false, error: "url query parameter is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const result = await previewL402(url);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: result.status }
    );
  }
  return NextResponse.json(result);
}

// POST /api/l402/preview
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (!auth) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing authorization token", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const { url, method = "GET", headers = {} } = body;

  if (!url || typeof url !== "string") {
    return NextResponse.json(
      { success: false, error: "url is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const result = await previewL402(url, method, headers);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: result.status }
    );
  }
  return NextResponse.json(result);
}
