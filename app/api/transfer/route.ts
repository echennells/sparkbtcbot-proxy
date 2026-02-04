import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { checkBudget, recordSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const body = await request.json();
    const { receiverSparkAddress, amountSats } = body;

    if (!receiverSparkAddress || typeof receiverSparkAddress !== "string") {
      return errorResponse("receiverSparkAddress is required", "BAD_REQUEST");
    }
    if (!amountSats || typeof amountSats !== "number" || amountSats <= 0) {
      return errorResponse("amountSats must be a positive number", "BAD_REQUEST");
    }

    const budgetCheck = await checkBudget(amountSats);
    if (!budgetCheck.allowed) {
      const maxTx = parseInt(process.env.MAX_TRANSACTION_SATS || "10000");
      return errorResponse(
        budgetCheck.reason!,
        amountSats > maxTx ? "TRANSACTION_TOO_LARGE" : "BUDGET_EXCEEDED",
        403
      );
    }

    let transfer;
    try {
      transfer = await wallet.transfer({
        receiverSparkAddress,
        amountSats,
      });
    } catch (err) {
      await logEvent({
        action: "error",
        success: false,
        amountSats,
        error: err instanceof Error ? err.message : "Transfer failed",
      });
      throw err;
    }

    await Promise.all([
      recordSpend(amountSats),
      logEvent({
        action: "transfer_sent",
        success: true,
        amountSats,
      }),
    ]);

    return successResponse({
      id: transfer.id,
      status: transfer.status,
      totalValue: transfer.totalValue,
    });
  });
}
