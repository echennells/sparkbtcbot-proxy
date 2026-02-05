import { NextRequest } from "next/server";
import { timingSafeEqual, randomBytes } from "crypto";
import { Redis } from "@upstash/redis";

export type TokenRole = "admin" | "invoice";

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

const TOKENS_KEY = "spark:tokens";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function verifyAuth(
  request: NextRequest
): Promise<TokenRole | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;

  // Check hardcoded admin token first (fallback — always works even if Redis is down)
  const envToken = process.env.API_AUTH_TOKEN;
  if (envToken && safeCompare(token, envToken)) {
    return "admin";
  }

  // Check Redis-stored tokens
  try {
    const raw = await getRedis().hget(TOKENS_KEY, token);
    if (raw) {
      const data =
        typeof raw === "string"
          ? JSON.parse(raw)
          : (raw as { role: TokenRole });
      if (data.role === "admin" || data.role === "invoice") {
        return data.role;
      }
    }
  } catch {
    // Redis failure — fall through to rejection
  }

  return null;
}

export async function createToken(
  role: TokenRole,
  label: string
): Promise<string> {
  const token = randomBytes(30).toString("base64");
  await getRedis().hset(TOKENS_KEY, {
    [token]: JSON.stringify({
      role,
      label,
      createdAt: new Date().toISOString(),
    }),
  });
  return token;
}

export async function listTokens(): Promise<
  { label: string; role: TokenRole; createdAt: string; tokenPrefix: string }[]
> {
  const all = await getRedis().hgetall(TOKENS_KEY);
  if (!all) return [];
  return Object.entries(all).map(([token, raw]) => {
    const data =
      typeof raw === "string"
        ? JSON.parse(raw)
        : (raw as { role: TokenRole; label: string; createdAt: string });
    return {
      tokenPrefix: token.slice(0, 8) + "...",
      label: data.label,
      role: data.role,
      createdAt: data.createdAt,
    };
  });
}

export async function revokeToken(token: string): Promise<boolean> {
  const removed = await getRedis().hdel(TOKENS_KEY, token);
  return removed > 0;
}
