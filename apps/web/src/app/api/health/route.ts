// GET /api/health — server-side read-only database health check.
//
// Contract:
//   200 { status: "ok",         database: "up"   } when SELECT 1 succeeds
//   503 { status: "unavailable", database: "down" } when it does not
//
// Deliberately absent: the URL, host, user, driver text, error message, stack
// trace, and any business data. There is no query parameter and no SQL input, so
// this route cannot be used as a free SQL channel.
//
// Checkpoint 6D: this route no longer imports the Prisma client. The package
// exposes `checkDatabaseHealth()` instead, so the web app has no unscoped query
// surface at all (F-6C-6).

import { NextResponse } from "next/server";
import { checkDatabaseHealth } from "@affiliateos/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<NextResponse> {
  const healthy = await checkDatabaseHealth();

  return NextResponse.json(
    { status: healthy ? "ok" : "unavailable", database: healthy ? "up" : "down" },
    { status: healthy ? 200 : 503, headers: NO_STORE },
  );
}
