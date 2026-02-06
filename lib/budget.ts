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

function getTodayKey(tokenId: string): string {
  const today = new Date().toISOString().split("T")[0];
  return `spark:daily_spend:${tokenId}:${today}`;
}

// Lua script: atomically check budget and increment if allowed.
// Returns [1, newTotal, 0] on success, [0, currentSpend, reason] if rejected.
const RESERVE_SCRIPT = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local maxTx = tonumber(ARGV[2])
local dailyLimit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if amount > maxTx then
  return {0, tonumber(redis.call("GET", key) or "0"), 1}
end

local current = tonumber(redis.call("GET", key) or "0")
if current + amount > dailyLimit then
  return {0, current, 2}
end

local newTotal = redis.call("INCRBY", key, amount)
redis.call("EXPIRE", key, ttl)
return {1, newTotal, 0}
`;

export type ReserveResult = {
  allowed: boolean;
  reason?: string;
  dailySpent: number;
  dailyLimit: number;
  code?: "TRANSACTION_TOO_LARGE" | "BUDGET_EXCEEDED";
};

export interface BudgetParams {
  tokenId: string;
  maxTxSats: number;
  dailyBudgetSats: number;
}

export async function reserveSpend(
  amountSats: number,
  params: BudgetParams
): Promise<ReserveResult> {
  const { tokenId, maxTxSats, dailyBudgetSats } = params;
  const key = getTodayKey(tokenId);

  const result = (await getRedis().eval(RESERVE_SCRIPT, [key], [
    amountSats,
    maxTxSats,
    dailyBudgetSats,
    86400 * 2,
  ])) as number[];

  const [ok, spent, reason] = result;

  if (ok === 1) {
    return { allowed: true, dailySpent: spent, dailyLimit: dailyBudgetSats };
  }

  if (reason === 1) {
    return {
      allowed: false,
      reason: `Transaction amount ${amountSats} exceeds per-transaction limit of ${maxTxSats} sats`,
      dailySpent: spent,
      dailyLimit: dailyBudgetSats,
      code: "TRANSACTION_TOO_LARGE",
    };
  }

  return {
    allowed: false,
    reason: `Would exceed daily budget. Spent: ${spent}, Requested: ${amountSats}, Limit: ${dailyBudgetSats}`,
    dailySpent: spent,
    dailyLimit: dailyBudgetSats,
    code: "BUDGET_EXCEEDED",
  };
}

// Compensating decrement if payment fails after reservation.
export async function releaseSpend(
  amountSats: number,
  tokenId: string
): Promise<void> {
  const key = getTodayKey(tokenId);
  await getRedis().decrby(key, amountSats);
}

export async function getDailySpend(tokenId: string): Promise<number> {
  const key = getTodayKey(tokenId);
  return (await getRedis().get<number>(key)) || 0;
}
