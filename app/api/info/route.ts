import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet) => {
    const [sparkAddress, identityPublicKey] = await Promise.all([
      wallet.getSparkAddress(),
      wallet.getIdentityPublicKey(),
    ]);

    return successResponse({ sparkAddress, identityPublicKey });
  });
}
