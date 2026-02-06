import { NextRequest } from "next/server";
import { withWallet, successResponse } from "@/lib/spark";

export async function GET(request: NextRequest) {
  return withWallet(request, async (wallet, _auth) => {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    const result = await wallet.getTransfers(limit, offset);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transfers = result.transfers.map((t: any) => ({
      id: t.id,
      status: t.status,
      type: t.type,
      totalValue: t.totalValue,
      senderIdentityPublicKey: t.senderIdentityPublicKey,
      receiverIdentityPublicKey: t.receiverIdentityPublicKey,
    }));

    return successResponse({ transfers, offset, limit });
  });
}
