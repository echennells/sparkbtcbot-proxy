import { NextRequest } from "next/server";

export function verifyAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const token = authHeader.replace("Bearer ", "");
  return token === process.env.API_AUTH_TOKEN;
}
