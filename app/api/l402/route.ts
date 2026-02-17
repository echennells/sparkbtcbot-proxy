import { NextRequest } from "next/server";
import { decode } from "light-bolt11-decoder";
import { withWallet, successResponse, errorResponse } from "@/lib/spark";
import { reserveSpend, releaseSpend } from "@/lib/budget";
import { logEvent } from "@/lib/log";
import { canPay } from "@/lib/auth";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { Redis } from "@upstash/redis";
import { randomBytes } from "crypto";

interface L402Challenge {
  invoice: string;
  macaroon: string;
  priceSats?: number;
}

export interface PendingL402 {
  paymentId: string;
  macaroon: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  priceSats?: number;
  createdAt: number;
}

const PENDING_L402_KEY = "spark:pending_l402";
const PENDING_L402_TTL = 60 * 60; // 1 hour

const L402_TOKEN_KEY = "spark:l402_tokens";
const L402_TOKEN_TTL = 24 * 60 * 60; // 24 hours max cache

interface CachedL402Token {
  macaroon: string;
  preimage: string;
  cachedAt: number;
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

async function getCachedToken(domain: string): Promise<CachedL402Token | null> {
  const raw = await getRedis().hget(L402_TOKEN_KEY, domain);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : (raw as CachedL402Token);
}

async function cacheToken(domain: string, macaroon: string, preimage: string): Promise<void> {
  const token: CachedL402Token = {
    macaroon,
    preimage,
    cachedAt: Date.now(),
  };
  await getRedis().hset(L402_TOKEN_KEY, { [domain]: JSON.stringify(token) });
  await getRedis().expire(L402_TOKEN_KEY, L402_TOKEN_TTL);
}

async function deleteCachedToken(domain: string): Promise<void> {
  await getRedis().hdel(L402_TOKEN_KEY, domain);
}

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

export async function storePendingL402(pending: PendingL402): Promise<string> {
  const pendingId = randomBytes(16).toString("hex");
  await getRedis().hset(PENDING_L402_KEY, {
    [pendingId]: JSON.stringify(pending),
  });
  // Set TTL on the hash (note: this resets TTL on every write, which is fine)
  await getRedis().expire(PENDING_L402_KEY, PENDING_L402_TTL);
  return pendingId;
}

export async function getPendingL402(pendingId: string): Promise<PendingL402 | null> {
  const raw = await getRedis().hget(PENDING_L402_KEY, pendingId);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : (raw as PendingL402);
}

export async function deletePendingL402(pendingId: string): Promise<void> {
  await getRedis().hdel(PENDING_L402_KEY, pendingId);
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

    // SDK may return different success statuses
    const successStatuses = ["LIGHTNING_PAYMENT_SUCCEEDED", "TRANSFER_COMPLETED", "PREIMAGE_PROVIDED"];
    if (successStatuses.includes(request.status) && request.paymentPreimage) {
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
    if (!canPay(auth.role)) {
      return errorResponse("This token does not have permission to make L402 requests", "UNAUTHORIZED", 403);
    }

    const body = await request.json();
    const { url, method = "GET", headers = {}, body: requestBody, maxFeeSats = 10 } = body;

    if (!url || typeof url !== "string") {
      return errorResponse("url is required", "BAD_REQUEST");
    }
    if (typeof maxFeeSats !== "number" || maxFeeSats <= 0) {
      return errorResponse("maxFeeSats must be a positive number", "BAD_REQUEST");
    }

    const domain = extractDomain(url);

    // Helper to check for empty/null content
    const isEmptyData = (data: unknown): boolean => {
      if (data === null || data === undefined) return true;
      if (typeof data === "string" && data.trim() === "") return true;
      if (typeof data === "object") {
        const obj = data as Record<string, unknown>;
        // Check for null fields that should have content (like joke setup/punchline)
        if ("setup" in obj && obj.setup === null) return true;
        if ("punchline" in obj && obj.punchline === null) return true;
      }
      return false;
    };

    // Helper to check if response indicates server hasn't verified payment yet
    const shouldRetryResponse = (status: number, data: unknown): boolean => {
      // Retry on empty data
      if (isEmptyData(data)) return true;
      // Retry on non-2xx status (server might return 402/400/500 if payment not yet verified)
      if (status < 200 || status >= 300) return true;
      // Check for error-like responses that suggest payment verification is pending
      if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
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
    };

    // Step 0: Check for cached L402 token for this domain
    const cachedToken = await getCachedToken(domain);
    if (cachedToken) {
      const fetchWithCachedToken = async () => {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `L402 ${cachedToken.macaroon}:${cachedToken.preimage}`,
            ...headers,
          },
          body: requestBody ? JSON.stringify(requestBody) : undefined,
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

      // Helper to check if response indicates token is invalid/expired
      const isTokenInvalid = (status: number, data: unknown): boolean => {
        // 401 = unauthorized, 402 = payment required, 403 = forbidden
        if (status === 401 || status === 402 || status === 403) return true;
        // Check for error responses that indicate token issues
        if (data && typeof data === "object") {
          const obj = data as Record<string, unknown>;
          if (obj.error === "invalid_token" || obj.error === "expired_token") return true;
          if (typeof obj.message === "string" && obj.message.toLowerCase().includes("expired")) return true;
        }
        return false;
      };

      try {
        let cachedResult = await fetchWithCachedToken();

        // If token is invalid/expired, delete cache and continue to pay
        if (isTokenInvalid(cachedResult.status, cachedResult.data)) {
          await deleteCachedToken(domain);
        } else {
          // Non-error response - check if content is empty or error-like (might be single-use token)
          // Retry a few times in case server is slow to verify payment
          const MAX_CACHE_RETRIES = 2;
          const CACHE_RETRY_DELAY_MS = 200;

          for (let i = 0; i < MAX_CACHE_RETRIES && shouldRetryResponse(cachedResult.status, cachedResult.data); i++) {
            await new Promise((resolve) => setTimeout(resolve, CACHE_RETRY_DELAY_MS));
            cachedResult = await fetchWithCachedToken();
            if (isTokenInvalid(cachedResult.status, cachedResult.data)) break;
          }

          // If token became invalid after retries, delete cache and continue to pay
          if (isTokenInvalid(cachedResult.status, cachedResult.data)) {
            await deleteCachedToken(domain);
          } else if (shouldRetryResponse(cachedResult.status, cachedResult.data)) {
            // Still getting error-like response after retries - token might be single-use and exhausted
            // Delete cache and continue to pay for fresh token
            await deleteCachedToken(domain);
          } else {
            // Got valid data with cached token
            return successResponse({
              status: cachedResult.status,
              paid: false,
              cached: true,
              data: cachedResult.data,
            });
          }
        }
      } catch {
        // Network error with cached token - delete and try fresh
        await deleteCachedToken(domain);
      }
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

    // Step 3: Decode invoice to get the actual payment amount
    let invoiceAmountSats: number;
    try {
      const decoded = decode(challenge.invoice);
      const amountSection = decoded.sections.find((s) => s.name === "amount");
      if (!amountSection || !("value" in amountSection) || !amountSection.value) {
        return errorResponse(
          "L402 invoice has no amount — amountless invoices are not supported",
          "L402_INVALID_CHALLENGE"
        );
      }
      // BOLT11 amount is in millisatoshis
      invoiceAmountSats = Math.ceil(Number(amountSection.value) / 1000);
    } catch {
      return errorResponse("Failed to decode L402 invoice", "L402_INVALID_CHALLENGE");
    }

    // Step 4: Estimate fees and check budget
    let feeEstimate = maxFeeSats;
    try {
      feeEstimate = await wallet.getLightningSendFeeEstimate({
        encodedInvoice: challenge.invoice,
      });
    } catch {
      // Fall back to maxFeeSats
    }

    // Budget includes invoice amount + fees
    const estimatedTotal = invoiceAmountSats + feeEstimate;

    const reserve = await reserveSpend(estimatedTotal, {
      tokenId: auth.tokenId,
      maxTxSats: auth.maxTxSats,
      dailyBudgetSats: auth.dailyBudgetSats,
    });
    if (!reserve.allowed) {
      return errorResponse(reserve.reason!, reserve.code!, 403);
    }

    // Step 5: Pay the invoice
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
        // Timeout or error - but payment may still complete
        // Store as pending so caller can retry via /api/l402/status
        if (pollResult.error.includes("Timeout")) {
          const pendingId = await storePendingL402({
            paymentId: requestId,
            macaroon: challenge.macaroon,
            url,
            method,
            headers,
            body: requestBody,
            priceSats: challenge.priceSats,
            createdAt: Date.now(),
          });

          return successResponse({
            status: "pending",
            pendingId,
            message: "Payment sent but preimage not yet available. Poll GET /api/l402/status?id=<pendingId> to complete.",
            priceSats: challenge.priceSats,
          });
        }

        // Actual failure (not timeout)
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
      // No preimage and no requestId to poll - store as pending if we have requestId
      if (requestId) {
        const pendingId = await storePendingL402({
          paymentId: requestId,
          macaroon: challenge.macaroon,
          url,
          method,
          headers,
          body: requestBody,
          priceSats: challenge.priceSats,
          createdAt: Date.now(),
        });

        return successResponse({
          status: "pending",
          pendingId,
          message: "Payment sent but preimage not yet available. Poll GET /api/l402/status?id=<pendingId> to complete.",
          priceSats: challenge.priceSats,
        });
      }

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

    // Cache the token for future requests to this domain
    await cacheToken(domain, challenge.macaroon, preimage);

    // Step 6: Fetch with L402 authorization (retry if response looks empty)
    const MAX_FINAL_RETRIES = 3;
    const FINAL_RETRY_DELAY_MS = 200;

    const fetchWithAuth = async () => {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `L402 ${challenge.macaroon}:${preimage}`,
          ...headers,
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
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
      // This handles: empty data, non-2xx status, or error-like JSON responses
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

    return successResponse({
      status: finalResult.status,
      paid: true,
      priceSats: challenge.priceSats,
      preimage,
      data: finalResult.data,
    });
  });
}
