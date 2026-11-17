// Security headers (docs/04 §3.12) — unit tests for the pure header builder.
//
// The headers are applied by `src/proxy.ts`; this file proves the values and the
// production/development split without starting a fifth `next dev` server on a
// 3.2 GiB host (the integration suites already run four). Application to a real
// HTTP response is verified separately by curling `next dev` and is recorded in
// docs/PHASE-1-CHECKPOINT-8B-BUILDFIX.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HSTS_VALUE,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "./security-headers.ts";

describe("security headers", () => {
  const production = buildSecurityHeaders({ isProduction: true });
  const development = buildSecurityHeaders({ isProduction: false });

  it("sends the baseline headers", () => {
    for (const headers of [production, development]) {
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
      assert.equal(headers["X-Frame-Options"], "DENY");
      assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
      assert.equal(
        headers["Permissions-Policy"],
        "camera=(), microphone=(), geolocation=()",
      );
    }
  });

  it("keeps the clickjacking directives in both modes", () => {
    assert.equal(development["X-Frame-Options"], "DENY");
    assert.match(development["Content-Security-Policy"] ?? "", /frame-ancestors 'none'/);
    assert.match(production["Content-Security-Policy"] ?? "", /frame-ancestors 'none'/);
  });

  it("emits HSTS only in production", () => {
    assert.equal(production["Strict-Transport-Security"], HSTS_VALUE);
    assert.equal(production["Strict-Transport-Security"], "max-age=31536000; includeSubDomains; preload");
    assert.equal(development["Strict-Transport-Security"], undefined);
  });

  it("production CSP has no eval and no websocket origins", () => {
    const csp = production["Content-Security-Policy"] ?? "";
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /ws:/);
  });

  it("development CSP allows the dev server's eval and HMR socket", () => {
    const csp = development["Content-Security-Policy"] ?? "";
    assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
    assert.match(csp, /connect-src 'self' ws: wss:/);
  });

  it("CSP is a single line with the required directives", () => {
    const csp = buildContentSecurityPolicy(true);
    assert.doesNotMatch(csp, /\n/);
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      assert.ok(csp.includes(directive), `CSP missing: ${directive}`);
    }
  });
});
