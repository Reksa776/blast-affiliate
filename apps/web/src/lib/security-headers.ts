// AffiliateOS — security response headers (docs/04-SECURITY-PLAN.md §3.12).
//
// Kept as a pure function with no `next/server` import so it can be unit-tested by
// Node's type-stripping test runner (the same constraint that shapes the other
// `lib/auth` modules). `src/proxy.ts` is the only production caller.
//
// Two modes, and the difference is deliberate:
//   - production: the policy the plan asks for. No `unsafe-eval`, no websocket
//     origins, and HSTS is emitted (the app is expected to be HTTPS-only there).
//   - development: `next dev` needs React's eval-based debugging and an HMR
//     websocket. Adding `'unsafe-eval'` and `ws:` only outside production keeps the
//     production policy strict while not breaking the dev server.
//
// `script-src 'unsafe-inline'` is required because this app has no nonce plumbing
// yet (docs/04 §3.12 prefers a nonce; the nonce route forces dynamic rendering on
// every page and is a Phase 2 change). Recorded as TD-8B-R2 rather than pretending
// the policy is nonce-based.

export type SecurityHeaderOptions = {
  /** True only for a production build; drives HSTS and the CSP relaxations. */
  isProduction: boolean;
};

/** HSTS is one year here; docs/04 §3.12 floats two years. One year is the value
 *  the buildfix brief specified and is still within the preload-eligible range. */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains; preload";

/** Content-Security-Policy for the given mode. */
export function buildContentSecurityPolicy(isProduction: boolean): string {
  const directives = [
    "default-src 'self'",
    // No nonce yet: React/Next hydration needs inline scripts on this app.
    `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // HMR uses a websocket in development only.
    `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}

/**
 * Every header the app must send. HSTS is absent in development on purpose:
 * browsers ignore it over http, and sending it from a dev host can poison the
 * origin for `localhost` in a developer's browser.
 */
export function buildSecurityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const { isProduction } = options;

  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": buildContentSecurityPolicy(isProduction),
  };

  if (isProduction) headers["Strict-Transport-Security"] = HSTS_VALUE;

  return headers;
}
