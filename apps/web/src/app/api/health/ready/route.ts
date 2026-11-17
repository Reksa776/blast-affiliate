// GET /api/health/ready — readiness probe that also checks the RBAC catalog
// (Phase 2, item 2.3; closes TD-7F-R2).
//
// Contract:
//   200 { status: "ready", database: "up", permissionCatalog: { expected, actual, missing: [] } }
//   503 { status: "not_ready", database, permissionCatalog, reasons: string[] }
//
// Why the catalog is part of readiness: creating a workspace provisions the six
// default roles from `permissions`. If that global catalog is empty or partial,
// `createDefaultRolesForWorkspace` throws and the request becomes a 500. A probe
// that only checks `SELECT 1` would call the instance healthy right up to that
// failure, so it now reports the missing catalog rows explicitly.
//
// Deliberately absent: database URL, host, credentials and driver error text. The
// response names only permission KEYS that are missing, which are not secrets.

import { NextResponse } from "next/server";
import { checkDatabaseHealth, systemDb } from "@affiliateos/database";
import { ALL_PERMISSIONS } from "@affiliateos/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<NextResponse> {
  const databaseUp = await checkDatabaseHealth();

  let actual = 0;
  let missing: string[] = [...ALL_PERMISSIONS];

  if (databaseUp) {
    // SYSTEM: the permission catalog is platform-global and has no tenant column.
    // This is a health probe, not a request-path tenant query.
    const rows = await systemDb().permission.findMany({ select: { key: true } });
    const present = new Set(rows.map((row) => row.key));
    actual = rows.length;
    missing = ALL_PERMISSIONS.filter((key) => !present.has(key));
  }

  const reasons: string[] = [];
  if (!databaseUp) reasons.push("database_unreachable");
  if (databaseUp && missing.length > 0) reasons.push("permission_catalog_incomplete");

  const ready = databaseUp && missing.length === 0;

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      database: databaseUp ? "up" : "down",
      permissionCatalog: {
        expected: ALL_PERMISSIONS.length,
        actual: databaseUp ? actual : null,
        missing: databaseUp ? missing : [],
      },
      reasons,
    },
    { status: ready ? 200 : 503, headers: NO_STORE },
  );
}
