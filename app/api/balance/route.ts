import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet, _auth) => {
    const { balance, tokenBalances } = await wallet.getBalance();

    const tokens: Record<string, string> = {};
    if (tokenBalances) {
      for (const [key, value] of tokenBalances) {
        tokens[key] = value.toString();
      }
    }

    return successResponse({
      balance: balance.toString(),
      tokenBalances: tokens,
    });
  });
}
