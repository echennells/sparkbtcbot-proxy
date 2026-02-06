import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { reserveSpend, releaseSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";
import { SparkWallet } from "@buildonspark/spark-sdk";

interface L402Challenge {
  invoice: string;
  macaroon: string;
  priceSats?: number;
}

const MAX_POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 500;

async function waitForPreimage(
  wallet: SparkWallet,
  requestId: string
): Promise<{ preimage: string } | { error: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const request = await wallet.getLightningSendRequest(requestId);
    if (!request) {
      return { error: "Payment request not found" };
    }

    if (request.status === "LIGHTNING_PAYMENT_SUCCEEDED" && request.paymentPreimage) {
      return { preimage: request.paymentPreimage };
    }

    if (request.status === "LIGHTNING_PAYMENT_FAILED" || request.status === "USER_TRANSFER_VALIDATION_FAILED") {
      return { error: `Payment failed with status: ${request.status}` };
    }

    // Still pending, wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { error: "Timeout waiting for payment to complete" };
}

function parseL402Response(body: unknown): L402Challenge | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  // Try common field names
  const invoice = obj.invoice || obj.payment_request || obj.pr;
  const macaroon = obj.macaroon || obj.token;

  if (typeof invoice !== "string" || typeof macaroon !== "string") {
    return null;
  }

  const priceSats = typeof obj.price_sats === "number" ? obj.price_sats : undefined;

  return { invoice, macaroon, priceSats };
}

export async function POST(request: NextRequest) {
  return withWallet(request, async (wallet, auth) => {
    if (auth.role !== "admin") {
      return errorResponse("This token does not have permission to make L402 requests", "UNAUTHORIZED", 403);
    }

    const body = await request.json();
    const { url, method = "GET", headers = {}, body: requestBody, maxFeeSats = 10 } = body;

    if (!url || typeof url !== "string") {
      return errorResponse("url is required", "BAD_REQUEST");
    }

    // Step 1: Make initial request
    let initialResponse: Response;
    try {
      initialResponse = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
      });
    } catch (err) {
      return errorResponse(
        `Failed to fetch ${url}: ${err instanceof Error ? err.message : "Unknown error"}`,
        "L402_FETCH_ERROR"
      );
    }

    // If not 402, return the response directly
    if (initialResponse.status !== 402) {
      const contentType = initialResponse.headers.get("content-type") || "";
      let responseData: unknown;

      if (contentType.includes("application/json")) {
        responseData = await initialResponse.json();
      } else {
        responseData = await initialResponse.text();
      }

      return successResponse({
        status: initialResponse.status,
        paid: false,
        data: responseData,
      });
    }

    // Step 2: Parse 402 response
    let challengeBody: unknown;
    try {
      challengeBody = await initialResponse.json();
    } catch {
      return errorResponse("Failed to parse L402 challenge response", "L402_PARSE_ERROR");
    }

    const challenge = parseL402Response(challengeBody);
    if (!challenge) {
      return errorResponse(
        "Invalid L402 response: missing invoice or macaroon",
        "L402_INVALID_CHALLENGE"
      );
    }

    // Step 3: Estimate cost and check budget
    let feeEstimate = maxFeeSats;
    try {
      feeEstimate = await wallet.getLightningSendFeeEstimate({
        encodedInvoice: challenge.invoice,
      });
    } catch {
      // Fall back to maxFeeSats
    }

    const estimatedTotal = maxFeeSats + feeEstimate;

    const reserve = await reserveSpend(estimatedTotal, {
      tokenId: auth.tokenId,
      maxTxSats: auth.maxTxSats,
      dailyBudgetSats: auth.dailyBudgetSats,
    });
    if (!reserve.allowed) {
      return errorResponse(reserve.reason!, reserve.code!, 403);
    }

    // Step 4: Pay the invoice
    let paymentResult;
    try {
      paymentResult = await wallet.payLightningInvoice({
        invoice: challenge.invoice,
        maxFeeSats,
      });
    } catch (err) {
      await releaseSpend(estimatedTotal, auth.tokenId);
      await logEvent({
        action: "error",
        success: false,
        invoice: challenge.invoice.slice(0, 30),
        error: err instanceof Error ? err.message : "L402 payment failed",
      });
      return errorResponse(
        `L402 payment failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "L402_PAYMENT_FAILED"
      );
    }

    // paymentResult can be LightningSendRequest or WalletTransfer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paymentResultAny = paymentResult as any;
    let preimage = paymentResultAny.paymentPreimage as string | undefined;
    const requestId = paymentResultAny.id as string | undefined;
    const status = paymentResultAny.status as string | undefined;

    // If payment initiated but no preimage yet, poll for completion
    if (!preimage && status === "LIGHTNING_PAYMENT_INITIATED" && requestId) {
      const pollResult = await waitForPreimage(wallet, requestId);
      if ("error" in pollResult) {
        await releaseSpend(estimatedTotal, auth.tokenId);
        await logEvent({
          action: "error",
          success: false,
          invoice: challenge.invoice.slice(0, 30),
          error: pollResult.error,
        });
        return errorResponse(pollResult.error, "L402_PAYMENT_FAILED");
      }
      preimage = pollResult.preimage;
    }

    if (!preimage) {
      await releaseSpend(estimatedTotal, auth.tokenId);
      return errorResponse(
        `Payment completed but no preimage available. Status: ${status || "unknown"}`,
        "L402_NO_PREIMAGE"
      );
    }

    await logEvent({
      action: "l402_payment",
      success: true,
      url,
      priceSats: challenge.priceSats,
    });

    // Step 5: Retry with L402 authorization
    let finalResponse: Response;
    try {
      finalResponse = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `L402 ${challenge.macaroon}:${preimage}`,
          ...headers,
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
      });
    } catch (err) {
      return errorResponse(
        `L402 retry failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "L402_RETRY_ERROR"
      );
    }

    const contentType = finalResponse.headers.get("content-type") || "";
    let finalData: unknown;

    if (contentType.includes("application/json")) {
      finalData = await finalResponse.json();
    } else {
      finalData = await finalResponse.text();
    }

    return successResponse({
      status: finalResponse.status,
      paid: true,
      priceSats: challenge.priceSats,
      preimage,
      data: finalData,
    });
  });
}
