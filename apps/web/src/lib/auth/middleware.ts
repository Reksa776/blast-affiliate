// AffiliateOS — request-side auth helpers (P0.5).
//
// Kept separate from `session.ts` so the session module has no Next.js import and
// stays callable from a worker or a test.
//
// `requireAuth` accepts a minimal cookie-reader rather than `NextRequest` so a
// Server Component can call it with a request built from `next/headers` cookies,
// using the exact same session validation as the API routes (Phase 2).

// Explicit `.ts` extensions: the test harness runs these modules through Node's
// type stripping, where extensionless specifiers do not resolve (Turbopack accepts
// both).
import { getSessionCookieName } from "./cookie-name.ts";
import { validateSession, type ValidatedSession } from "./session.ts";

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

/** The only part of a request `requireAuth` needs. NextRequest satisfies it. */
export type SessionCookieRequest = {
  cookies: {
    get(name: string): { value: string } | undefined;
  };
};

/** Resolves the session cookie or throws an `AuthError` (401). */
export async function requireAuth(req: SessionCookieRequest): Promise<ValidatedSession> {
  const token = req.cookies.get(getSessionCookieName())?.value;
  if (token === undefined || token === "") throw new AuthError("No session", 401);

  const session = await validateSession(token);
  if (session === null) throw new AuthError("Invalid session", 401);

  return session;
}
