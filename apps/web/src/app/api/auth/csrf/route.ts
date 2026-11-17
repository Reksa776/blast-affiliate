// GET /api/auth/csrf — issues a double-submit CSRF token (pre-P0.6 fix).
//
// Contract:
//   200 { csrfToken } + Set-Cookie: csrf_token=… (HttpOnly=false by design)
//
// The cookie must be readable by the client script, which echoes it in
// `X-CSRF-Token` on mutating requests. It contains no secret of its own: knowing it
// grants nothing without the matching session cookie.
//
// A fresh token is minted per call and never cached.

import { NextResponse } from "next/server";

import { CSRF_COOKIE, csrfCookieOptions, generateCsrfToken } from "@/lib/auth/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const token = generateCsrfToken();

  const response = NextResponse.json(
    { csrfToken: token },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(CSRF_COOKIE, token, csrfCookieOptions());

  return response;
}
