import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { resetAllDailySpends } from "@/lib/budget";

export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (!auth) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing authorization token", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }
  if (auth.role !== "admin") {
    return NextResponse.json(
      { success: false, error: "Admin token required", code: "UNAUTHORIZED" },
      { status: 403 }
    );
  }

  const count = await resetAllDailySpends();
  return NextResponse.json({
    success: true,
    data: { resetCount: count, message: `Reset ${count} daily spend counter(s)` },
  });
}
