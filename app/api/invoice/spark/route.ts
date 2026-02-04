import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";
import { logEvent } from "@/lib/log";

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const body = await request.json();
    const { amount, memo } = body;

    const invoice = await wallet.createSatsInvoice({
      amount: amount || undefined,
      memo: memo || undefined,
    });

    await logEvent({
      action: "spark_invoice_created",
      success: true,
      amountSats: amount,
      memo,
    });

    return successResponse({ invoice });
  });
}
