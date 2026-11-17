// POST /api/auth/login — password login (P0.5).
//
// Contract:
//   200 { user: { id, email, name } } + Set-Cookie: session=…
//   400 malformed body
//   401 invalid credentials (unknown email, wrong password, inactive user — all
//       the same response, so the endpoint is not an account oracle)
//
// Every attempt that reaches password verification is audited: `auth.login` on
// success, `auth.login_failed` with a reason on failure. The attempted password is
// never recorded, and the IP is hashed by writeAudit().
//   403 missing or mismatched CSRF token (checked before anything else)
//   429 rate limited (10 attempts per 15 minutes per IP)
//
// The session token is generated here, stored as a SHA-256 digest, and returned
// only inside an httpOnly cookie. No token, hash, or password ever appears in the
// JSON body or in a log line.

import { NextRequest, NextResponse } from "next/server";
import { systemDb, writeAudit } from "@affiliateos/database";

import { CsrfError, verifyCsrf } from "@/lib/auth/csrf";
import { getClientIp } from "@/lib/auth/middleware";
import { verifyPassword } from "@/lib/auth/password";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

type LoginBody = { email: string; password: string };

function readBody(value: unknown): LoginBody | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  const password = typeof record.password === "string" ? record.password : "";

  if (email === "" || password === "") return null;
  return { email, password };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Login is a mutation too: without a token, an attacker could sign a victim into
  // an account they control (login CSRF). The token comes from GET /api/auth/csrf.
  try {
    verifyCsrf(req);
  } catch (error) {
    if (error instanceof CsrfError) return fail(error.message, 403);
    throw error;
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return fail("Too many requests", 429);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }

  const body = readBody(payload);
  if (body === null) return fail("Email and password are required", 400);

  // SYSTEM: login resolves an account before any tenant is selected.
  const user = await systemDb().user.findUnique({
    where: { email: body.email },
    select: { id: true, email: true, displayName: true, passwordHash: true, status: true },
  });

  const userAgent = req.headers.get("user-agent") ?? "";

  // Audit context is built once: the request id comes from the proxy/edge, and the
  // IP is hashed by writeAudit — the plaintext address never reaches the database.
  const auditBase = {
    tenantId: null,
    resourceType: "user",
    requestId: req.headers.get("x-request-id"),
    ip,
    userAgent,
  } as const;

  // Unknown email and wrong password take the same path: one 401, no distinction.
  // The audit trail, however, does distinguish them (that is its job) — and it never
  // records the attempted password, correct or not.
  if (user === null) {
    await writeAudit({
      ...auditBase,
      actorType: "USER",
      actorUserId: null,
      action: "auth.login_failed",
      resourceId: null,
      metadata: { reason: "unknown_account", email_attempted: body.email },
    });
    return fail("Invalid credentials", 401);
  }

  const passwordMatches = await verifyPassword(user.passwordHash, body.password);
  if (!passwordMatches) {
    await writeAudit({
      ...auditBase,
      actorType: "USER",
      actorUserId: user.id,
      action: "auth.login_failed",
      resourceId: user.id,
      metadata: { reason: "invalid_password", email_attempted: body.email },
    });
    return fail("Invalid credentials", 401);
  }

  if (user.status !== "ACTIVE") {
    await writeAudit({
      ...auditBase,
      actorType: "USER",
      actorUserId: user.id,
      action: "auth.login_failed",
      resourceId: user.id,
      metadata: { reason: "inactive_user", email_attempted: body.email },
    });
    return fail("Invalid credentials", 401);
  }

  const { token, expiresAt } = await createSession(user.id, ip, userAgent);

  await writeAudit({
    ...auditBase,
    actorType: "USER",
    actorUserId: user.id,
    action: "auth.login",
    resourceId: user.id,
    metadata: { email: user.email },
  });

  const response = NextResponse.json(
    { user: { id: user.id, email: user.email, name: user.displayName } },
    { status: 200, headers: NO_STORE },
  );
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(expiresAt));

  return response;
}
