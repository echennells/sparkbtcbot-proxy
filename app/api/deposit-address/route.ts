import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet, _auth) => {
    const address = await wallet.getSingleUseDepositAddress();
    return successResponse({ address });
  });
}
