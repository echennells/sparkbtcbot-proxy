import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

export function verifyAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const expected = process.env.API_AUTH_TOKEN;
  if (!expected) return false;

  const token = authHeader.replace("Bearer ", "");
  if (token.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
