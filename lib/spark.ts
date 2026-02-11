import { SparkWallet } from "@buildonspark/spark-sdk";
import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, type AuthResult } from "./auth";
import { checkPendingInvoices } from "./log";
import type { ApiResponse, ErrorCode } from "./types";

type NetworkType = "MAINNET" | "TESTNET" | "REGTEST" | "LOCAL";

export function errorResponse(
  error: string,
  code: ErrorCode,
  status: number = 400
): NextResponse<ApiResponse> {
  return NextResponse.json({ success: false, error, code }, { status });
}

export function successResponse<T>(data: T): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ success: true, data }, { status: 200 });
}

type HandlerFn = (
  wallet: InstanceType<typeof SparkWallet>,
  auth: AuthResult
) => Promise<NextResponse>;

export async function withWallet(
  request: NextRequest,
  handler: HandlerFn
): Promise<NextResponse> {
  const auth = await verifyAuth(request);
  if (!auth) {
    return errorResponse("Invalid or missing authorization token", "UNAUTHORIZED", 401);
  }

  const mnemonic = process.env.SPARK_MNEMONIC;
  if (!mnemonic) {
    return errorResponse("Server misconfiguration: mnemonic not set", "INTERNAL_ERROR", 500);
  }

  let wallet: InstanceType<typeof SparkWallet> | null = null;

  try {
    const network = (process.env.SPARK_NETWORK || "MAINNET") as NetworkType;
    const result = await SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      options: { network },
    });
    wallet = result.wallet;

    const response = await handler(wallet, auth);

    // Lazy check for paid/expired invoices — fire-and-forget
    checkPendingInvoices(wallet).catch(() => {});

    return response;
  } catch (err) {
    const message = err instanceof Error ? (err.message || "Unknown wallet error") : "Unknown error";
    console.error("[spark-middleware]", message);
    return errorResponse(message, "WALLET_ERROR", 500);
  } finally {
    if (wallet) {
      try {
        wallet.cleanupConnections();
      } catch (cleanupErr) {
        console.error("[spark-middleware] cleanup error:", cleanupErr);
      }
    }
  }
}
