import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet, _auth) => {
    const { balance, satsBalance, tokenBalances } = await wallet.getBalance();

    const tokens: Record<
      string,
      {
        ownedBalance: string;
        availableToSendBalance: string;
        ticker?: string;
        name?: string;
        decimals?: number;
      }
    > = {};
    if (tokenBalances) {
      for (const [id, info] of tokenBalances) {
        tokens[id] = {
          ownedBalance: info.ownedBalance.toString(),
          availableToSendBalance: info.availableToSendBalance.toString(),
          ticker: info.tokenMetadata?.tokenTicker,
          name: info.tokenMetadata?.tokenName,
          decimals: info.tokenMetadata?.decimals,
        };
      }
    }

    return successResponse({
      // Deprecated top-level field, kept for backward compatibility
      balance: balance.toString(),
      // Preferred breakdown (0.7.x):
      satsBalance: {
        available: satsBalance.available.toString(),
        owned: satsBalance.owned.toString(),
        incoming: satsBalance.incoming.toString(),
      },
      tokenBalances: tokens,
    });
  });
}
