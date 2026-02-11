import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { logEvent } from "@/lib/log";
import { canCreateInvoice } from "@/lib/auth";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet, auth) => {
    if (!canCreateInvoice(auth.role)) {
      return errorResponse("This token does not have permission to create invoices", "UNAUTHORIZED", 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", "BAD_REQUEST");
    }

    const { amount, memo } = body;

    // Require amount
    if (amount === undefined || typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return errorResponse("amount is required and must be a positive integer", "BAD_REQUEST");
    }

    // Validate memo if provided
    if (memo !== undefined && typeof memo !== "string") {
      return errorResponse("memo must be a string", "BAD_REQUEST");
    }

    let invoice;
    try {
      invoice = await wallet.createSatsInvoice({
        amount: amount || undefined,
        memo: memo || undefined,
      });
    } catch (err: unknown) {
      // Extract error message defensively - SDK may throw non-Error objects
      let message = "Failed to create Spark invoice";
      if (err instanceof Error && err.message) {
        message = err.message;
      } else if (typeof err === "string" && err) {
        message = err;
      } else if (err && typeof err === "object" && "message" in err) {
        const errObj = err as { message: unknown };
        if (typeof errObj.message === "string" && errObj.message) {
          message = errObj.message;
        }
      }
      return errorResponse(message, "BAD_REQUEST");
    }

    if (!invoice) {
      return errorResponse("Failed to create Spark invoice - no invoice returned", "BAD_REQUEST");
    }

    await logEvent({
      action: "spark_invoice_created",
      success: true,
      amountSats: amount,
      memo,
    });

    return successResponse({ invoice });
  });
}
