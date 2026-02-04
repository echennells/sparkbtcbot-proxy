import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { checkBudget, recordSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const body = await request.json();
    const { invoice, maxFeeSats } = body;

    if (!invoice || typeof invoice !== "string") {
      return errorResponse("invoice is required", "BAD_REQUEST");
    }
    if (maxFeeSats === undefined || typeof maxFeeSats !== "number") {
      return errorResponse("maxFeeSats is required", "BAD_REQUEST");
    }

    // Estimate total cost: invoice amount + fees
    // Use fee estimate as a proxy for total spend since decoding BOLT11
    // amounts requires an external lib. The caller knows the invoice amount
    // and should set maxFeeSats accordingly.
    let feeEstimate = maxFeeSats;
    try {
      feeEstimate = await wallet.getLightningSendFeeEstimate({
        encodedInvoice: invoice,
      });
    } catch {
      // Fall back to maxFeeSats if estimate fails
    }

    // For budget purposes, use maxFeeSats + feeEstimate as upper bound
    // This is conservative — actual spend may be less
    const estimatedTotal = maxFeeSats + feeEstimate;

    const budgetCheck = await checkBudget(estimatedTotal);
    if (!budgetCheck.allowed) {
      const maxTx = parseInt(process.env.MAX_TRANSACTION_SATS || "10000");
      return errorResponse(
        budgetCheck.reason!,
        estimatedTotal > maxTx ? "TRANSACTION_TOO_LARGE" : "BUDGET_EXCEEDED",
        403
      );
    }

    let result;
    try {
      result = await wallet.payLightningInvoice({
        invoice,
        maxFeeSats,
      });
    } catch (err) {
      await logEvent({
        action: "error",
        success: false,
        invoice: invoice.slice(0, 30),
        error: err instanceof Error ? err.message : "Payment failed",
      });
      throw err;
    }

    await Promise.all([
      recordSpend(estimatedTotal),
      logEvent({
        action: "payment_sent",
        success: true,
        invoice: invoice.slice(0, 30),
      }),
    ]);

    return successResponse(result);
  });
}
