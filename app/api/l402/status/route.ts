import { NextRequest } from "next/server";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { logEvent } from "@/lib/log";
import { canPay } from "@/lib/auth";
import { getPendingL402, deletePendingL402 } from "../route";

const MAX_POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 500;
const MAX_FINAL_RETRIES = 3;
const FINAL_RETRY_DELAY_MS = 200;

// Helper to check if response indicates server hasn't verified payment yet
function shouldRetryResponse(status: number, data: unknown): boolean {
  // Retry on empty data
  if (data === null || data === undefined) return true;
  if (typeof data === "string" && data.trim() === "") return true;
  // Retry on non-2xx status (server might return 402/400/500 if payment not yet verified)
  if (status < 200 || status >= 300) return true;
  // Check for error-like responses that suggest payment verification is pending
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Check for null fields that should have content
    if ("setup" in obj && obj.setup === null) return true;
    if ("punchline" in obj && obj.punchline === null) return true;
    // Common error indicators
    if ("error" in obj) return true;
    if (obj.status === "pending" || obj.status === "processing") return true;
    if (typeof obj.message === "string") {
      const msg = obj.message.toLowerCase();
      if (msg.includes("payment") || msg.includes("verify") || msg.includes("pending") || msg.includes("processing")) {
        return true;
      }
    }
  }
  return false;
}

export async function GET(request: NextRequest) {
  const pendingId = request.nextUrl.searchParams.get("id");

  if (!pendingId) {
    return errorResponse("id query parameter is required", "BAD_REQUEST");
  }

  return withWallet(request, async (wallet, auth) => {
    if (!canPay(auth.role)) {
      return errorResponse(
        "This token does not have permission to check L402 status",
        "UNAUTHORIZED",
        403
      );
    }

    // Get the pending L402 from Redis
    const pending = await getPendingL402(pendingId);
    if (!pending) {
      return errorResponse(
        "Pending L402 not found. It may have expired or already completed.",
        "BAD_REQUEST",
        404
      );
    }

    // Check if expired (1 hour)
    if (Date.now() - pending.createdAt > 60 * 60 * 1000) {
      await deletePendingL402(pendingId);
      return errorResponse(
        "Pending L402 has expired",
        "BAD_REQUEST",
        410
      );
    }

    // Poll Spark for the preimage
    let preimage: string | null = null;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const request = await wallet.getLightningSendRequest(pending.paymentId);
      if (!request) {
        // Payment record not found - may have expired on Spark's side
        await deletePendingL402(pendingId);
        return errorResponse(
          "Payment record not found on Spark. The payment may have failed or expired.",
          "L402_PAYMENT_FAILED"
        );
      }

      const successStatuses = [
        "LIGHTNING_PAYMENT_SUCCEEDED",
        "TRANSFER_COMPLETED",
        "PREIMAGE_PROVIDED",
      ];
      if (successStatuses.includes(request.status) && request.paymentPreimage) {
        preimage = request.paymentPreimage;
        break;
      }

      if (
        request.status === "LIGHTNING_PAYMENT_FAILED" ||
        request.status === "USER_TRANSFER_VALIDATION_FAILED"
      ) {
        await deletePendingL402(pendingId);
        return errorResponse(
          `Payment failed with status: ${request.status}`,
          "L402_PAYMENT_FAILED"
        );
      }

      // Still pending
      if (i < MAX_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    if (!preimage) {
      // Still no preimage - tell caller to try again
      return successResponse({
        status: "pending",
        pendingId,
        message: "Payment still processing. Try again in a few seconds.",
        priceSats: pending.priceSats,
      });
    }

    // Got the preimage - complete the L402 flow
    await logEvent({
      action: "l402_payment",
      success: true,
      url: pending.url,
      priceSats: pending.priceSats,
    });

    // Retry the original request with L402 authorization
    const fetchWithAuth = async () => {
      const response = await fetch(pending.url, {
        method: pending.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `L402 ${pending.macaroon}:${preimage}`,
          ...pending.headers,
        },
        body: pending.body ? JSON.stringify(pending.body) : undefined,
      });

      const contentType = response.headers.get("content-type") || "";
      let data: unknown;
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      return { status: response.status, data };
    };

    let finalResult: { status: number; data: unknown };
    try {
      finalResult = await fetchWithAuth();

      // Retry if response indicates server hasn't verified payment yet
      for (let i = 0; i < MAX_FINAL_RETRIES && shouldRetryResponse(finalResult.status, finalResult.data); i++) {
        await new Promise((resolve) => setTimeout(resolve, FINAL_RETRY_DELAY_MS));
        finalResult = await fetchWithAuth();
      }
    } catch (err) {
      return errorResponse(
        `L402 retry failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "L402_RETRY_ERROR"
      );
    }

    // Clean up the pending record
    await deletePendingL402(pendingId);

    return successResponse({
      status: finalResult.status,
      paid: true,
      priceSats: pending.priceSats,
      preimage,
      data: finalResult.data,
    });
  });
}
