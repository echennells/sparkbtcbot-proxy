import { Redis } from "@upstash/redis";

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

const LOG_KEY = "spark:logs";
const PENDING_KEY = "spark:pending_invoices";
const LOG_TTL = 7 * 24 * 60 * 60; // 7 days
const MAX_LOG_ENTRIES = 1000;
const MAX_CHECK_PER_REQUEST = 5;
const CLEANUP_CUTOFF_HOURS = 24;

export type LogAction =
  | "invoice_created"
  | "spark_invoice_created"
  | "payment_sent"
  | "transfer_sent"
  | "invoice_paid"
  | "invoice_expired"
  | "error";

export interface LogEntry {
  timestamp: string;
  action: LogAction;
  success: boolean;
  amountSats?: number;
  memo?: string;
  invoice?: string;
  error?: string;
}

interface PendingInvoice {
  encodedInvoice: string;
  amountSats: number;
  memo?: string;
  createdAt: string;
  expirySeconds: number;
}

export async function logEvent(
  entry: Omit<LogEntry, "timestamp">
): Promise<void> {
  const redis = getRedis();
  const fullEntry: LogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  const pipeline = redis.pipeline();
  pipeline.lpush(LOG_KEY, JSON.stringify(fullEntry));
  pipeline.ltrim(LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
  pipeline.expire(LOG_KEY, LOG_TTL);
  await pipeline.exec();
}

export async function trackPendingInvoice(data: {
  encodedInvoice: string;
  amountSats: number;
  memo?: string;
  expirySeconds: number;
}): Promise<void> {
  const redis = getRedis();
  const pending: PendingInvoice = {
    ...data,
    createdAt: new Date().toISOString(),
  };
  const key = data.encodedInvoice.slice(0, 30);
  await redis.hset(PENDING_KEY, { [key]: JSON.stringify(pending) });
}

export async function checkPendingInvoices(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any
): Promise<void> {
  const redis = getRedis();
  const all = await redis.hgetall(PENDING_KEY);
  if (!all || Object.keys(all).length === 0) return;

  const now = Date.now();
  const needsWalletCheck: [string, PendingInvoice][] = [];

  for (const [key, raw] of Object.entries(all)) {
    let pending: PendingInvoice;
    try {
      pending =
        typeof raw === "string"
          ? JSON.parse(raw)
          : (raw as unknown as PendingInvoice);
    } catch {
      await redis.hdel(PENDING_KEY, key);
      continue;
    }

    const createdAt = new Date(pending.createdAt).getTime();
    const expiresAt = createdAt + pending.expirySeconds * 1000;
    const cutoff = createdAt + CLEANUP_CUTOFF_HOURS * 60 * 60 * 1000;

    if (now > expiresAt) {
      await redis.hdel(PENDING_KEY, key);
      await logEvent({
        action: "invoice_expired",
        success: true,
        amountSats: pending.amountSats,
        memo: pending.memo,
        invoice: pending.encodedInvoice.slice(0, 30),
      });
      continue;
    }

    if (now > cutoff) {
      await redis.hdel(PENDING_KEY, key);
      continue;
    }

    if (needsWalletCheck.length < MAX_CHECK_PER_REQUEST) {
      needsWalletCheck.push([key, pending]);
    }
  }

  if (needsWalletCheck.length === 0) return;

  try {
    const result = await wallet.getTransfers(50, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transfers: any[] = result?.transfers || [];
    const matchedTransferIds = new Set<string>();

    for (const [key, pending] of needsWalletCheck) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = transfers.find((t: any) => {
        if (matchedTransferIds.has(t.id)) return false;
        if (Number(t.totalValue) !== pending.amountSats) return false;
        const typeStr = String(t.type || "").toUpperCase();
        // Accept Lightning receives or preimage swaps (Spark's internal type for LN)
        if (
          typeStr.includes("LIGHTNING") ||
          typeStr.includes("PREIMAGE") ||
          typeStr.includes("RECEIVE") ||
          typeStr.includes("INCOMING")
        )
          return true;
        return false;
      });

      if (match) {
        matchedTransferIds.add(match.id);
        await redis.hdel(PENDING_KEY, key);
        await logEvent({
          action: "invoice_paid",
          success: true,
          amountSats: pending.amountSats,
          memo: pending.memo,
          invoice: pending.encodedInvoice.slice(0, 30),
        });
      }
    }
  } catch {
    // Swallow — never affect main request
  }
}

export async function getRecentLogs(limit: number = 50): Promise<LogEntry[]> {
  const redis = getRedis();
  const raw = await redis.lrange(LOG_KEY, 0, limit - 1);
  return raw.map((entry) => {
    if (typeof entry === "string") return JSON.parse(entry);
    return entry as unknown as LogEntry;
  });
}
