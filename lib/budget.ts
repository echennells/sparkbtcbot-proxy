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

function getTodayKey(): string {
  const today = new Date().toISOString().split("T")[0];
  return `spark:daily_spend:${today}`;
}

export async function checkBudget(amountSats: number): Promise<{
  allowed: boolean;
  reason?: string;
  dailySpent?: number;
  dailyLimit?: number;
}> {
  const maxTx = parseInt(process.env.MAX_TRANSACTION_SATS || "10000");
  const dailyBudget = parseInt(process.env.DAILY_BUDGET_SATS || "100000");

  if (amountSats > maxTx) {
    return {
      allowed: false,
      reason: `Transaction amount ${amountSats} exceeds per-transaction limit of ${maxTx} sats`,
      dailyLimit: dailyBudget,
    };
  }

  const key = getTodayKey();
  const currentSpend = (await getRedis().get<number>(key)) || 0;

  if (currentSpend + amountSats > dailyBudget) {
    return {
      allowed: false,
      reason: `Would exceed daily budget. Spent: ${currentSpend}, Requested: ${amountSats}, Limit: ${dailyBudget}`,
      dailySpent: currentSpend,
      dailyLimit: dailyBudget,
    };
  }

  return { allowed: true, dailySpent: currentSpend, dailyLimit: dailyBudget };
}

export async function recordSpend(amountSats: number): Promise<void> {
  const key = getTodayKey();
  const pipeline = getRedis().pipeline();
  pipeline.incrby(key, amountSats);
  pipeline.expire(key, 86400 * 2);
  await pipeline.exec();
}

export async function getDailySpend(): Promise<number> {
  const key = getTodayKey();
  return (await getRedis().get<number>(key)) || 0;
}
