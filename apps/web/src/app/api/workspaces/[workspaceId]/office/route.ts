// /api/workspaces/:workspaceId/office — workspace/office settings (Phase 2, 2.7).
//
// GET contract:
//   200 { id, slug, name, address, timezone, workStart, workEnd, status, plan }
//   401 no valid session
//   403 not a member with `workspace.read` (same body for foreign and missing)
//   404 the workspace does not exist for a platform admin
//
// PATCH contract:
//   200 <same shape as GET>
//   400 malformed body / invalid name / address / timezone / work hour
//   401 no valid session
//   403 missing CSRF, not a member, or missing `workspace.manage`
//   404 workspace does not exist for a platform admin
//   429 per-user workspace-mutation rate limit exhausted
//
// Fields: `name`, `address`, `timezone`, `workStart`, `workEnd`. Timezone is an IANA
// name validated by the runtime, and work hours are 24-hour `HH:MM` wall-clock
// strings in that timezone. Phase 2 stores the schedule; interpreting it (shifts,
// holidays, late calculations) belongs to attendance in Phase 3 and is not done here.
//
// Audit: one `workspace.update_office` row per real change, with
// `{ fields, from, to }`. A PATCH that changes nothing writes no row.

import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import type { Permission } from "@affiliateos/permissions";

import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission, type PermissionGrant } from "@/lib/auth/permission";
import {
  auditActorType,
  auditRequestFields,
  handleRouteError,
  jsonFail,
  normalizeWorkspaceName,
  NO_STORE,
  readJsonObject,
  tenantContextFor,
} from "@/lib/auth/route-support";
import {
  workspaceMutationRateLimit,
  workspaceRateLimitResponse,
} from "@/lib/auth/workspace-rate-limit";
import { readOfficeSettings, type OfficeSettings } from "@/lib/workspaces/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFICE_SELECT = {
  id: true,
  slug: true,
  name: true,
  address: true,
  timezone: true,
  workStart: true,
  workEnd: true,
  status: true,
  plan: true,
} as const;

const WORK_HOUR_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADDRESS_MAX_LENGTH = 255;
const TIMEZONE_MAX_LENGTH = 64;

type OfficeChanges = {
  name?: string;
  address?: string | null;
  timezone?: string;
  workStart?: string;
  workEnd?: string;
};

type OfficeField = "name" | "address" | "timezone" | "workStart" | "workEnd";

function normalizeAddress(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };

  const address = value.trim();
  if (address.length > ADDRESS_MAX_LENGTH) return { ok: false };
  return { ok: true, value: address === "" ? null : address };
}

function normalizeTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const timezone = value.trim();
  if (timezone === "" || timezone.length > TIMEZONE_MAX_LENGTH) return null;

  try {
    // Throws RangeError for an unknown zone; the list itself is platform data, so
    // this validates against the runtime's tz database rather than a copy.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

function normalizeWorkHour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = value.trim();
  return WORK_HOUR_PATTERN.test(time) ? time : null;
}

async function loadOffice(
  req: NextRequest,
  workspaceId: string,
  permission: Permission,
): Promise<
  | { kind: "not-found" }
  | {
      kind: "ok";
      grant: PermissionGrant;
      ctx: ReturnType<typeof tenantContextFor>;
      office: OfficeSettings;
    }
> {
  const grant = await requirePermission(req, workspaceId, permission);
  const ctx = tenantContextFor(
    grant,
    grant.member?.tenantId ?? workspaceId,
    req.headers.get("x-request-id"),
  );

  const office = await withTenant(ctx, (db) => readOfficeSettings(db, ctx.tenantId));
  return office === null ? { kind: "not-found" } : { kind: "ok", grant, ctx, office };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const result = await loadOffice(req, workspaceId, "workspace.read");
    if (result.kind === "not-found") return jsonFail("Not found", 404);

    return NextResponse.json(result.office, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const result = await loadOffice(req, workspaceId, "workspace.manage");
    if (result.kind === "not-found") return jsonFail("Not found", 404);

    verifyCsrf(req);

    const limit = workspaceMutationRateLimit(result.ctx.userId);
    if (!limit.allowed) return workspaceRateLimitResponse(limit);

    const payload = await readJsonObject(req);
    if (payload === null) return jsonFail("Invalid JSON body", 400);

    const changes: OfficeChanges = {};
    const fields: OfficeField[] = [];

    if (Object.hasOwn(payload, "name")) {
      const name = normalizeWorkspaceName(payload.name);
      if (name === null) return jsonFail("Name must be 1-150 characters", 400);
      changes.name = name;
      fields.push("name");
    }

    if (Object.hasOwn(payload, "address")) {
      const address = normalizeAddress(payload.address);
      if (!address.ok) return jsonFail("Address must be at most 255 characters", 400);
      changes.address = address.value;
      fields.push("address");
    }

    if (Object.hasOwn(payload, "timezone")) {
      const timezone = normalizeTimezone(payload.timezone);
      if (timezone === null) return jsonFail("Timezone must be a valid IANA name", 400);
      changes.timezone = timezone;
      fields.push("timezone");
    }

    if (Object.hasOwn(payload, "workStart")) {
      const workStart = normalizeWorkHour(payload.workStart);
      if (workStart === null) return jsonFail("Work start must be HH:MM (24-hour)", 400);
      changes.workStart = workStart;
      fields.push("workStart");
    }

    if (Object.hasOwn(payload, "workEnd")) {
      const workEnd = normalizeWorkHour(payload.workEnd);
      if (workEnd === null) return jsonFail("Work end must be HH:MM (24-hour)", 400);
      changes.workEnd = workEnd;
      fields.push("workEnd");
    }

    if (fields.length === 0) return jsonFail("No supported fields provided", 400);

    const from: Record<string, string | null> = {};
    const to: Record<string, string | null> = {};
    const changedFields: OfficeField[] = [];

    for (const field of fields) {
      const before = result.office[field];
      const after = changes[field];
      if (after === undefined || before === after) continue;
      changedFields.push(field);
      from[field] = before;
      to[field] = after;
    }

    // No-op PATCH: 200 with the current row, no audit (same rule as role.change).
    if (changedFields.length === 0) {
      return NextResponse.json(result.office, { status: 200, headers: NO_STORE });
    }

    const updated = await withTenant(result.ctx, (db) =>
      db.workspace.update({
        where: { id: result.ctx.tenantId },
        data: changes,
        select: OFFICE_SELECT,
      }),
    );

    await writeAudit({
      tenantId: result.ctx.tenantId,
      actorType: auditActorType(result.grant),
      actorUserId: result.ctx.userId,
      actorMemberId: result.ctx.membershipId === "" ? null : result.ctx.membershipId,
      action: "workspace.update_office",
      resourceType: "workspace",
      resourceId: result.ctx.tenantId,
      ...auditRequestFields(req),
      metadata: { fields: changedFields, from, to },
    });

    return NextResponse.json(updated, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}
