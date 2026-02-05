import { NextRequest, NextResponse } from "next/server";
import {
  verifyAuth,
  createToken,
  listTokens,
  revokeToken,
  type TokenRole,
} from "@/lib/auth";

function jsonError(error: string, code: string, status: number) {
  return NextResponse.json({ success: false, error, code }, { status });
}

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const role = await verifyAuth(request);
  if (!role) return jsonError("Invalid or missing authorization token", "UNAUTHORIZED", 401);
  if (role !== "admin") return jsonError("Admin token required to manage tokens", "UNAUTHORIZED", 403);
  return null;
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const tokens = await listTokens();
  return NextResponse.json({ success: true, data: { tokens } });
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const { role, label } = body;

  if (!role || !["admin", "invoice"].includes(role)) {
    return jsonError('role is required and must be "admin" or "invoice"', "BAD_REQUEST", 400);
  }
  if (!label || typeof label !== "string") {
    return jsonError("label is required", "BAD_REQUEST", 400);
  }

  const token = await createToken(role as TokenRole, label);
  return NextResponse.json({ success: true, data: { token, role, label } });
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const { token } = body;

  if (!token || typeof token !== "string") {
    return jsonError("token is required", "BAD_REQUEST", 400);
  }

  const revoked = await revokeToken(token);
  if (!revoked) {
    return jsonError("Token not found", "BAD_REQUEST", 404);
  }

  return NextResponse.json({ success: true, data: { revoked: true } });
}
