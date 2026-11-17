// POST /api/auth/logout — destroys the session and clears the cookie (P0.5).
//
// Contract:
//   204 (always, even without a cookie — logout is idempotent and must not reveal
//        whether a session existed)
//   403 missing or mismatched CSRF token
//
// The row is deleted rather than revoked: a deleted session cannot be replayed even
// if the cookie is somehow restored. A logout that actually destroyed a session is
// audited; an anonymous call is not (there is no actor to record, and logout must
// stay idempotent).
//
// CSRF matters here: without it, any third-party page could log the user out.

import { NextRequest, NextResponse } from "next/server";
import { writeAudit } from "@affiliateos/database";

import { getClientIp } from "@/lib/auth/middleware";
import { CsrfError, verifyCsrf } from "@/lib/auth/csrf";
import { getSessionCookieName } from "@/lib/auth/cookie-name";
import {
  clearedSessionCookieOptions,
  destroySession,
  validateSession,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    verifyCsrf(req);
  } catch (error) {
    if (error instanceof CsrfError) {
      return NextResponse.json({ error: error.message }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const cookieName = getSessionCookieName();
  const token = req.cookies.get(cookieName)?.value;
  if (token !== undefined && token !== "") {
    // The session must be resolved before it is destroyed: the audit row needs the
    // actor, and afterwards the token maps to nothing.
    const session = await validateSession(token);
    await destroySession(token);

    if (session !== null) {
      await writeAudit({
        tenantId: null,
        actorType: "USER",
        actorUserId: session.userId,
        action: "auth.logout",
        resourceType: "user",
        resourceId: session.userId,
        requestId: req.headers.get("x-request-id"),
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      });
    }
  }

  const response = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(cookieName, "", clearedSessionCookieOptions());

  return response;
}
