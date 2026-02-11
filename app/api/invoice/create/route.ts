import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { logEvent, trackPendingInvoice } from "@/lib/log";
import { canCreateInvoice } from "@/lib/auth";

const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet, auth) => {
    if (!canCreateInvoice(auth.role)) {
      return errorResponse("This token does not have permission to create invoices", "UNAUTHORIZED", 403);
    }
    const body = await request.json();
    const { amountSats, memo } = body;
    const expirySeconds = body.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;

    if (!amountSats || typeof amountSats !== "number" || !Number.isInteger(amountSats) || amountSats <= 0) {
      return errorResponse("amountSats is required and must be a positive integer", "BAD_REQUEST");
    }
    if (typeof expirySeconds !== "number" || !Number.isInteger(expirySeconds) || expirySeconds <= 0) {
      return errorResponse("expirySeconds must be a positive integer", "BAD_REQUEST");
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
