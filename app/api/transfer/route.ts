import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { reserveSpend, releaseSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";
import { withStaleLeafRecovery } from "@/lib/leaves";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet, auth) => {
    if (auth.role !== "admin") {
      return errorResponse("This token does not have permission to send transfers", "UNAUTHORIZED", 403);
    }

    const body = await request.json();
    const { receiverSparkAddress, amountSats } = body;

    if (!receiverSparkAddress || typeof receiverSparkAddress !== "string") {
      return errorResponse("receiverSparkAddress is required", "BAD_REQUEST");
    }
    if (!amountSats || typeof amountSats !== "number" || amountSats <= 0) {
      return errorResponse("amountSats must be a positive number", "BAD_REQUEST");
    }

    // Atomically check and reserve budget before transfer
    const reserve = await reserveSpend(amountSats, {
      tokenId: auth.tokenId,
      maxTxSats: auth.maxTxSats,
      dailyBudgetSats: auth.dailyBudgetSats,
    });
    if (!reserve.allowed) {
      return errorResponse(reserve.reason!, reserve.code!, 403);
    }

    let transfer;
    try {
      transfer = await withStaleLeafRecovery(wallet, () =>
        wallet.transfer({
          receiverSparkAddress,
          amountSats,
        })
      );
    } catch (err) {
      // Transfer failed — release the reserved budget
      await releaseSpend(amountSats, auth.tokenId);
      await logEvent({
        action: "error",
        success: false,
        amountSats,
        error: err instanceof Error ? err.message : "Transfer failed",
      });
      throw err;
    }

    await logEvent({
      action: "transfer_sent",
      success: true,
      amountSats,
    });

    return successResponse({
      id: transfer.id,
      status: transfer.status,
      totalValue: transfer.totalValue,
    });
  });
}
