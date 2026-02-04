import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const { searchParams } = new URL(request.url);
    const invoice = searchParams.get("invoice");

    if (!invoice) {
      return errorResponse("invoice query parameter is required", "BAD_REQUEST");
    }

    const feeEstimateSats = await wallet.getLightningSendFeeEstimate({
      encodedInvoice: invoice,
    });

    return successResponse({ feeEstimateSats });
  });
}
