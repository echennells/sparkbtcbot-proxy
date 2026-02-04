import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { logEvent, trackPendingInvoice } from "@/lib/log";

const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const body = await request.json();
    const { amountSats, memo } = body;
    const expirySeconds = body.expirySeconds || DEFAULT_EXPIRY_SECONDS;

    if (!amountSats || typeof amountSats !== "number" || amountSats <= 0) {
      return errorResponse("amountSats is required and must be a positive number", "BAD_REQUEST");
    }

    const result = await wallet.createLightningInvoice({
      amountSats,
      memo: memo || undefined,
      expirySeconds,
    });

    const encodedInvoice = result.invoice.encodedInvoice;

    await Promise.all([
      logEvent({
        action: "invoice_created",
        success: true,
        amountSats,
        memo,
        invoice: encodedInvoice.slice(0, 30),
      }),
      trackPendingInvoice({
        encodedInvoice,
        amountSats,
        memo,
        expirySeconds,
      }),
    ]);

    return successResponse({ encodedInvoice });
  });
}
