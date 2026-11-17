// AffiliateOS — CSRF protection (P0.5, enforced in the pre-P0.6 fix).
//
// Mechanism: double-submit cookie, stateless, no schema change.
//
//   1. the client calls GET /api/auth/csrf → server sets `csrf_token` (readable by
//      JS on purpose) and returns the same value in the body;
//   2. the client sends it back in `X-CSRF-Token` on every mutating request;
//   3. the server compares cookie vs. header in constant time and rejects with 403
//      when either is missing or they differ.
//
// Why this works: a cross-site attacker can make the browser send the cookie, but
// cannot read it (same-origin policy) and therefore cannot set the header. The
// token is not tied to the session, so it is not a defence against a sub-domain
// attacker that can write cookies — noted in the checkpoint report.
//
// 32 random bytes → 43 base64url characters, the same entropy as the session
// token. Comparison is constant-time to avoid leaking a prefix match.

import crypto from "node:crypto";
import type { NextRequest } from "next/server";

export const CSRF_TOKEN_BYTES = 32;
export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_TTL_SECONDS = 24 * 60 * 60;

/** A rejected mutation: missing or mismatched CSRF token. */
export class CsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

/**
 * Double-submit check: the cookie and the header must both exist and be equal.
 * Throws `CsrfError`; callers translate it to 403 (never to 401, which would be
 * confused with a missing session).
 */
export function verifyCsrf(req: NextRequest): void {
  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
  const headerToken = req.headers.get(CSRF_HEADER);

  if (cookieToken === undefined || cookieToken === "" || headerToken === null || headerToken === "") {
    throw new CsrfError("Missing CSRF token");
  }
  if (!timingSafeEqualString(cookieToken, headerToken)) {
    throw new CsrfError("Invalid CSRF token");
  }
}

/** Cookie attributes for the double-submit token. Must stay readable by JS. */
export function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: CSRF_TTL_SECONDS,
  };
}

/** A fresh, URL-safe CSRF token. */
export function generateCsrfToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first because `crypto.timingSafeEqual` throws on unequal
 * buffers; a differing length is not secret (both sides are fixed-size tokens).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}
