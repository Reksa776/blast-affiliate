// Tests for CSRF primitives and double-submit enforcement (pre-P0.6 fix).
//
// `verifyCsrf` only reads `req.cookies` and `req.headers`, so a structural fake is
// enough — no Next runtime and no database are involved.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_TOKEN_BYTES,
  CsrfError,
  csrfCookieOptions,
  generateCsrfToken,
  timingSafeEqualString,
  verifyCsrf,
} from "./csrf.ts";

function fakeRequest(cookieToken?: string, headerToken?: string): NextRequest {
  return {
    cookies: {
      get: (name: string) => (name === CSRF_COOKIE && cookieToken !== undefined ? { value: cookieToken } : undefined),
    },
    headers: new Headers(headerToken === undefined ? {} : { [CSRF_HEADER]: headerToken }),
  } as unknown as NextRequest;
}

test("timingSafeEqualString('abc','abc') → true", () => {
  assert.equal(timingSafeEqualString("abc", "abc"), true);
});

test("timingSafeEqualString('abc','abd') → false", () => {
  assert.equal(timingSafeEqualString("abc", "abd"), false);
});

test("timingSafeEqualString('abc','abcd') → false (panjang beda, tidak throw)", () => {
  assert.equal(timingSafeEqualString("abc", "abcd"), false);
  assert.equal(timingSafeEqualString("", "a"), false);
});

test("generateCsrfToken → 43 karakter base64url dan selalu berbeda", () => {
  const first = generateCsrfToken();
  const second = generateCsrfToken();

  assert.equal(first.length, 43);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(CSRF_TOKEN_BYTES, 32);
});

test("verifyCsrf: cookie dan header cocok → lolos", () => {
  const token = generateCsrfToken();
  assert.doesNotThrow(() => verifyCsrf(fakeRequest(token, token)));
});

test("verifyCsrf: cookie dan header berbeda → CsrfError 'Invalid'", () => {
  const token = generateCsrfToken();
  assert.throws(
    () => verifyCsrf(fakeRequest(token, generateCsrfToken())),
    (error: unknown) => error instanceof CsrfError && /Invalid CSRF token/.test(error.message),
  );
});

test("verifyCsrf: tanpa cookie → CsrfError 'Missing'", () => {
  const token = generateCsrfToken();
  assert.throws(
    () => verifyCsrf(fakeRequest(undefined, token)),
    (error: unknown) => error instanceof CsrfError && /Missing CSRF token/.test(error.message),
  );
});

test("verifyCsrf: tanpa header → CsrfError 'Missing'", () => {
  const token = generateCsrfToken();
  assert.throws(
    () => verifyCsrf(fakeRequest(token, undefined)),
    (error: unknown) => error instanceof CsrfError && /Missing CSRF token/.test(error.message),
  );
});

test("verifyCsrf: cookie kosong dianggap tidak ada", () => {
  assert.throws(
    () => verifyCsrf(fakeRequest("", "")),
    (error: unknown) => error instanceof CsrfError && /Missing CSRF token/.test(error.message),
  );
});

test("csrfCookieOptions: HttpOnly false (client harus bisa membaca), SameSite lax", () => {
  const options = csrfCookieOptions();
  assert.equal(options.httpOnly, false);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, 24 * 60 * 60);
});
