import { NextRequest } from "next/server";
import { decode } from "light-bolt11-decoder";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { reserveSpend, releaseSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet, auth) => {
    if (auth.role !== "admin") {
      return errorResponse("This token does not have permission to send payments", "UNAUTHORIZED", 403);
    }

    const body = await request.json();
    const { invoice, maxFeeSats } = body;

    if (!invoice || typeof invoice !== "string") {
      return errorResponse("invoice is required", "BAD_REQUEST");
    }
    if (maxFeeSats === undefined || typeof maxFeeSats !== "number") {
      return errorResponse("maxFeeSats is required", "BAD_REQUEST");
    }

    // Decode invoice to get the actual payment amount
    let invoiceAmountSats: number;
    try {
      const decoded = decode(invoice);
      const amountSection = decoded.sections.find((s) => s.name === "amount");
      if (!amountSection || !("value" in amountSection) || !amountSection.value) {
        return errorResponse(
          "Invoice has no amount — amountless invoices are not supported",
          "BAD_REQUEST"
        );
      }
      // BOLT11 amount is in millisatoshis
      invoiceAmountSats = Math.ceil(Number(amountSection.value) / 1000);
    } catch {
      return errorResponse("Failed to decode invoice", "BAD_REQUEST");
    }

    let feeEstimate = maxFeeSats;
    try {
      feeEstimate = await wallet.getLightningSendFeeEstimate({
        encodedInvoice: invoice,
      });
    } catch {
      // Fall back to maxFeeSats if estimate fails
    }

    // Budget includes invoice amount + fees
    const estimatedTotal = invoiceAmountSats + feeEstimate;

    // Atomically check and reserve budget before payment
    const reserve = await reserveSpend(estimatedTotal, {
      tokenId: auth.tokenId,
      maxTxSats: auth.maxTxSats,
      dailyBudgetSats: auth.dailyBudgetSats,
    });
    if (!reserve.allowed) {
      return errorResponse(reserve.reason!, reserve.code!, 403);
    }

    let result;
    try {
      result = await wallet.payLightningInvoice({
        invoice,
        maxFeeSats,
      });
    } catch (err) {
      // Payment failed — release the reserved budget
      await releaseSpend(estimatedTotal, auth.tokenId);
      await logEvent({
        action: "error",
        success: false,
        invoice: invoice.slice(0, 30),
        error: err instanceof Error ? err.message : "Payment failed",
      });
      throw err;
    }

    await logEvent({
      action: "payment_sent",
      success: true,
      invoice: invoice.slice(0, 30),
    });

    return successResponse(result);
  });
}
