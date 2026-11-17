// AffiliateOS — security headers for every response (docs/04 §3.12).
//
// Next.js 16 renamed the `middleware.ts` convention to `proxy.ts` and deprecated
// the old name (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// middleware.md: "deprecated in Next.js 16 and renamed to proxy"). The brief asked
// for `middleware.ts`; using the deprecated file would build but is the wrong
// convention for this framework version, so this is `proxy.ts` exporting `proxy`.
//
// The header values live in `lib/security-headers.ts` (pure, unit-tested). This
// file only applies them, after the response is produced, so HTML and JSON/API
// responses both carry them.
//
// Static assets are excluded by the matcher: adding security headers to immutable
// build output is noise, and CSP/`nosniff` are meant for documents and API bodies.

import { NextResponse, type NextRequest } from "next/server";

import { buildSecurityHeaders } from "./lib/security-headers";

const SECURITY_HEADERS = buildSecurityHeaders({
  isProduction: process.env.NODE_ENV === "production",
});

export function proxy(_req: NextRequest): NextResponse {
  const response = NextResponse.next();

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
