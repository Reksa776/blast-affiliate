// Tests for the proxy-aware client address (pre-P0.6 fix, TD-7C-A5).
//
// The rule under test: without TRUST_PROXY=true, proxy headers must be ignored, so
// a caller cannot rotate its rate-limit bucket by inventing an address.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { NextRequest } from "next/server";

import { getClientIp, UNKNOWN_CLIENT_IP } from "./client-ip.ts";

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
});

test("TRUST_PROXY=false + X-Forwarded-For → 'unknown', bukan 1.1.1.1", () => {
  process.env.TRUST_PROXY = "false";
  const ip = getClientIp(fakeRequest({ "x-forwarded-for": "1.1.1.1" }));

  assert.equal(ip, UNKNOWN_CLIENT_IP);
  assert.notEqual(ip, "1.1.1.1");
});

test("TRUST_PROXY=true + X-Forwarded-For → 1.1.1.1", () => {
  process.env.TRUST_PROXY = "true";
  assert.equal(getClientIp(fakeRequest({ "x-forwarded-for": "1.1.1.1" })), "1.1.1.1");
});

test("TRUST_PROXY=true + daftar '1.1.1.1, 2.2.2.2' → entri pertama (1.1.1.1)", () => {
  process.env.TRUST_PROXY = "true";
  assert.equal(getClientIp(fakeRequest({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "1.1.1.1");
});

test("TRUST_PROXY=false + x-real-ip → tetap 'unknown' (header juga bisa dipalsukan)", () => {
  process.env.TRUST_PROXY = "false";
  assert.equal(getClientIp(fakeRequest({ "x-real-ip": "9.9.9.9" })), UNKNOWN_CLIENT_IP);
});

test("TRUST_PROXY tidak diset → header diabaikan", () => {
  delete process.env.TRUST_PROXY;
  assert.equal(getClientIp(fakeRequest({ "x-forwarded-for": "1.1.1.1" })), UNKNOWN_CLIENT_IP);
});

test("TRUST_PROXY=true tanpa header apa pun → 'unknown'", () => {
  process.env.TRUST_PROXY = "true";
  assert.equal(getClientIp(fakeRequest({})), UNKNOWN_CLIENT_IP);
});
