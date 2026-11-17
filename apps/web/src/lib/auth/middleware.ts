// AffiliateOS — request-side auth helpers (P0.5).
//
// Kept separate from `session.ts` so the session module has no Next.js import and
// stays callable from a worker or a test.

import type { NextRequest } from "next/server";
// Explicit `.ts` extensions: the test harness runs these modules through Node's
// type stripping, where extensionless specifiers do not resolve (Turbopack accepts
// both).
import { SESSION_COOKIE_NAME, validateSession, type ValidatedSession } from "./session.ts";

export { getClientIp, UNKNOWN_CLIENT_IP } from "./client-ip.ts";

/** Authentication failure with the status the route should return. */
export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/** Resolves the session cookie or throws an `AuthError` (401). */
export async function requireAuth(req: NextRequest): Promise<ValidatedSession> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token === undefined || token === "") throw new AuthError("No session", 401);

  const session = await validateSession(token);
  if (session === null) throw new AuthError("Invalid session", 401);

  return session;
}
