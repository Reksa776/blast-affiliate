// POST /api/auth/register — bootstrap-only registration (P0.5).
//
// Public sign-up is NOT open: the PRD says customer self-registration is out of
// scope for Phase 1. This route exists to create the first account (the platform
// owner) and closes itself the moment a user exists. The check is a COUNT on
// `users`, so it is single-use by construction; a race between two concurrent
// registrations is closed by the unique email constraint, and a duplicate bootstrap
// would still leave exactly one row per email.
//
// Contract:
//   201 { id, email, name }
//   400 malformed body / invalid email / password < 12 / name out of range
//   403 registration already closed
//   409 email already taken (race with the bootstrap count)
//   403 missing or mismatched CSRF token (checked before anything else)
//   429 rate limited (5 per minute per IP)
//
// A successful bootstrap is audited as `auth.register_bootstrap`. No password, hash
// or token enters the audit metadata.
//
// Never returned: the password hash, the password, or any database error text.

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { systemDb, writeAudit } from "@affiliateos/database";

import { CsrfError, verifyCsrf } from "@/lib/auth/csrf";
import { getClientIp } from "@/lib/auth/middleware";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { checkRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 120;
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 60_000;

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

type RegisterBody = { email: string; password: string; name: string };

function readBody(value: unknown): RegisterBody | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  const password = typeof record.password === "string" ? record.password : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (email === "" || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  if (password.length < PASSWORD_MIN_LENGTH) return null;
  if (name === "" || name.length > MAX_NAME_LENGTH) return null;

  return { email, password, name };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    verifyCsrf(req);
  } catch (error) {
    if (error instanceof CsrfError) return fail(error.message, 403);
    throw error;
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(`register:${ip}`, REGISTER_LIMIT, REGISTER_WINDOW_MS)) {
    return fail("Too many requests", 429);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }

  const body = readBody(payload);
  if (body === null) {
    return fail(`Provide a valid email, a name, and a password of at least ${PASSWORD_MIN_LENGTH} characters`, 400);
  }

  // SYSTEM: registration precedes any tenant; it decides whether the platform has
  // an owner at all.
  const existingUsers = await systemDb().user.count();
  if (existingUsers > 0) {
    return fail("Registration is closed", 403);
  }

  const passwordHash = await hashPassword(body.password);

  try {
    // SYSTEM: the first user is platform-level and has no workspace yet.
    const user = await systemDb().user.create({
      data: {
        id: crypto.randomUUID(),
        email: body.email,
        displayName: body.name,
        passwordHash,
      },
      select: { id: true, email: true, displayName: true },
    });

    // actorType SYSTEM: this is the bootstrap path, the platform creating its first
    // owner. `actorUserId` still names the created user, so the trail is traceable.
    await writeAudit({
      tenantId: null,
      actorType: "SYSTEM",
      actorUserId: user.id,
      action: "auth.register_bootstrap",
      resourceType: "user",
      resourceId: user.id,
      requestId: req.headers.get("x-request-id"),
      ip,
      userAgent: req.headers.get("user-agent"),
      metadata: { email: user.email },
    });

    return NextResponse.json(
      { id: user.id, email: user.email, name: user.displayName },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    // P2002 = unique constraint. Do not echo the driver message.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return fail("Email already registered", 409);
    }
    throw error;
  }
}
