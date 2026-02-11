import { NextRequest } from "next/server";
import { timingSafeEqual, randomBytes } from "crypto";
import { Redis } from "@upstash/redis";

export type TokenRole = "admin" | "invoice" | "pay-only" | "read-only";

export interface TokenData {
  role: TokenRole;
  label: string;
  createdAt: string;
  maxTxSats?: number;
  dailyBudgetSats?: number;
}

export interface AuthResult {
  role: TokenRole;
  tokenId: string; // The token string (for per-token budget tracking)
  maxTxSats: number;
  dailyBudgetSats: number;
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

const TOKENS_KEY = "spark:tokens";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function getDefaultLimits() {
  return {
    maxTxSats: parseInt(process.env.MAX_TRANSACTION_SATS || "10000"),
    dailyBudgetSats: parseInt(process.env.DAILY_BUDGET_SATS || "100000"),
  };
}

export async function verifyAuth(
  request: NextRequest
): Promise<AuthResult | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;

  const defaults = getDefaultLimits();

  // Check hardcoded admin token first (fallback — always works even if Redis is down)
  const envToken = process.env.API_AUTH_TOKEN;
  if (envToken && safeCompare(token, envToken)) {
    return {
      role: "admin",
      tokenId: "env",
      ...defaults,
    };
  }

  // Check Redis-stored tokens
  try {
    const raw = await getRedis().hget(TOKENS_KEY, token);
    if (raw) {
      const data: TokenData =
        typeof raw === "string" ? JSON.parse(raw) : (raw as TokenData);
      const validRoles: TokenRole[] = ["admin", "invoice", "pay-only", "read-only"];
      if (validRoles.includes(data.role)) {
        return {
          role: data.role,
          tokenId: token.slice(0, 16), // Use prefix for budget key (shorter, safer)
          maxTxSats: data.maxTxSats ?? defaults.maxTxSats,
          dailyBudgetSats: data.dailyBudgetSats ?? defaults.dailyBudgetSats,
        };
      }
    }
  } catch {
    // Redis failure — fall through to rejection
  }

  return null;
}

export interface CreateTokenOptions {
  role: TokenRole;
  label: string;
  maxTxSats?: number;
  dailyBudgetSats?: number;
}

export async function createToken(options: CreateTokenOptions): Promise<string> {
  const token = randomBytes(30).toString("base64");
  const data: TokenData = {
    role: options.role,
    label: options.label,
    createdAt: new Date().toISOString(),
  };
  if (options.maxTxSats !== undefined) {
    data.maxTxSats = options.maxTxSats;
  }
  if (options.dailyBudgetSats !== undefined) {
    data.dailyBudgetSats = options.dailyBudgetSats;
  }
  await getRedis().hset(TOKENS_KEY, {
    [token]: JSON.stringify(data),
  });
  return token;
}

export interface TokenInfo {
  tokenPrefix: string;
  label: string;
  role: TokenRole;
  createdAt: string;
  maxTxSats?: number;
  dailyBudgetSats?: number;
}

export async function listTokens(): Promise<TokenInfo[]> {
  const all = await getRedis().hgetall(TOKENS_KEY);
  if (!all) return [];
  return Object.entries(all).map(([token, raw]) => {
    const data: TokenData =
      typeof raw === "string" ? JSON.parse(raw) : (raw as TokenData);
    return {
      tokenPrefix: token.slice(0, 8) + "...",
      label: data.label,
      role: data.role,
      createdAt: data.createdAt,
      maxTxSats: data.maxTxSats,
      dailyBudgetSats: data.dailyBudgetSats,
    };
  });
}

export async function revokeToken(token: string): Promise<boolean> {
  const removed = await getRedis().hdel(TOKENS_KEY, token);
  return removed > 0;
}

// Permission helpers
// Roles that can send payments (pay invoices, transfer, L402)
export function canPay(role: TokenRole): boolean {
  return role === "admin" || role === "pay-only";
}

// Roles that can create invoices
export function canCreateInvoice(role: TokenRole): boolean {
  return role === "admin" || role === "invoice";
}

// Roles that can manage tokens
export function canManageTokens(role: TokenRole): boolean {
  return role === "admin";
}

// All roles can read (balance, info, transactions, logs, etc.)
