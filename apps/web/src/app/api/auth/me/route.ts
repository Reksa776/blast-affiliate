// GET /api/auth/me — the authenticated user (P0.5).
//
// Contract:
//   200 { id, email, name }
//   401 { error } without a valid session
//
// The response is built from an explicit select, so `passwordHash` (and every other
// column) can never leak by accident when the model grows.

import { NextRequest, NextResponse } from "next/server";

import { AuthError, requireAuth } from "@/lib/auth/middleware";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAuth(req);

    const limited = await enforceApiRateLimit(req, {
      scope: "user",
      key: session.userId,
      route: "auth.me",
    });
    if (limited !== null) return limited;

    return NextResponse.json(
      { id: session.user.id, email: session.user.email, name: session.user.displayName },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: error.status, headers: NO_STORE });
    }
    throw error;
  }
}
