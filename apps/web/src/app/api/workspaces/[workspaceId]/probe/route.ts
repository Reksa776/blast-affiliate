// GET /api/workspaces/:workspaceId/probe — RBAC enforcement proof (P0.6).
//
// Diagnostic route, not a product feature: it exists so the permission layer can be
// exercised over real HTTP.
//
// Note on the path: the brief asked for `_probe`, but Next treats every folder whose
// name starts with `_` as a private folder and excludes it from routing — `next
// build` simply did not list it. `probe` is the same route with a routable name.
//
// Gate: `creator.read` by default. Every workspace role holds that permission, which
// would make member-level denial untestable, so `?permission=` selects another
// catalog entry (e.g. `creator.write`, which only manager-and-above hold). Values
// outside the catalog are rejected by `requirePermission` itself.
//
// Contract:
//   200 { ok: true, workspaceId, permission, platformAdmin, permissions }
//   401 no valid session
//   403 authenticated but not allowed
//
// The response never includes the caller's user id, the membership id, or any other
// tenant's data.

import { NextRequest, NextResponse } from "next/server";

import { AuthError } from "@/lib/auth/middleware";
import { PermissionError, requirePermission } from "@/lib/auth/permission";
import { ALL_PERMISSIONS, isPermission, type Permission } from "@affiliateos/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const DEFAULT_PERMISSION: Permission = "creator.read";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const { workspaceId } = await context.params;

  const requested = req.nextUrl.searchParams.get("permission");
  const permission: Permission =
    requested !== null && isPermission(requested) ? requested : DEFAULT_PERMISSION;

  try {
    const grant = await requirePermission(req, workspaceId, permission);

    return NextResponse.json(
      {
        ok: true,
        workspaceId,
        permission,
        platformAdmin: grant.platformAdmin,
        held: grant.permissions.length,
        permissions: grant.permissions,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    }
    if (error instanceof PermissionError) {
      // Fixed message: the reason (not a member vs. missing permission) is for logs.
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    }
    throw error;
  }
}

// Keeps the catalog import meaningful for the documentation above and guarantees the
// default gate is a real catalog entry at module load.
if (!ALL_PERMISSIONS.includes(DEFAULT_PERMISSION)) {
  throw new Error("Probe default permission is not in the catalog.");
}
