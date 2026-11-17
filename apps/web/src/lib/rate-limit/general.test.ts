// Unit tests for the general API rate limiter (P1 HIGH #2).
//
// Each test uses a fresh route label, so buckets never leak between cases even
// though the backing map is module-global. Env overrides are reset in `beforeEach`
// because limits are read per call by design.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  apiRateLimit,
  API_TENANT_LIMIT_DEFAULT,
  API_USER_LIMIT_DEFAULT,
} from "./general.ts";
import { cleanupRateLimitBuckets, rateLimitBucketCount } from "../auth/rate-limit.ts";

function uniqueRoute(): string {
  return `test.${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

beforeEach(() => {
  process.env.API_RATE_LIMIT_USER_MAX = String(API_USER_LIMIT_DEFAULT);
  process.env.API_RATE_LIMIT_USER_WINDOW_MS = "60000";
  process.env.API_RATE_LIMIT_TENANT_MAX = String(API_TENANT_LIMIT_DEFAULT);
  process.env.API_RATE_LIMIT_TENANT_WINDOW_MS = "60000";
});

describe("apiRateLimit", () => {
  it("mengizinkan request pertama dan mencatat sisa kuota", () => {
    const decision = apiRateLimit("user", "user-1", uniqueRoute());

    assert.equal(decision.allowed, true);
    assert.equal(decision.limit, API_USER_LIMIT_DEFAULT);
    assert.equal(decision.remaining, API_USER_LIMIT_DEFAULT - 1);
    assert.ok(decision.retryAfterSeconds >= 1);
  });

  it("memblokir request ke-301 pada bucket user yang sama", () => {
    const route = uniqueRoute();
    const id = "user-blocked";

    for (let attempt = 1; attempt <= API_USER_LIMIT_DEFAULT; attempt += 1) {
      const decision = apiRateLimit("user", id, route);
      assert.equal(decision.allowed, true, `request ${attempt} seharusnya lolos`);
    }

    const blocked = apiRateLimit("user", id, route);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSeconds >= 1);
    assert.ok(blocked.retryAfterSeconds <= 60);
  });

  it("mengizinkan lagi setelah window reset", async () => {
    process.env.API_RATE_LIMIT_USER_WINDOW_MS = "25";
    const route = uniqueRoute();
    const id = "user-reset";

    const first = apiRateLimit("user", id, route);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, API_USER_LIMIT_DEFAULT - 1);

    await sleep(45);

    const second = apiRateLimit("user", id, route);
    assert.equal(second.allowed, true);
    // A fresh window, not a continuation: the remaining count reset too.
    assert.equal(second.remaining, API_USER_LIMIT_DEFAULT - 1);
  });

  it("bucket user dan tenant terpisah, dan user lain punya bucket sendiri", () => {
    process.env.API_RATE_LIMIT_USER_MAX = "2";
    process.env.API_RATE_LIMIT_TENANT_MAX = "2";
    const route = uniqueRoute();

    assert.equal(apiRateLimit("user", "shared-id", route).allowed, true);
    assert.equal(apiRateLimit("user", "shared-id", route).allowed, true);
    assert.equal(apiRateLimit("user", "shared-id", route).allowed, false);

    // Same id, different scope: the tenant bucket is untouched.
    assert.equal(apiRateLimit("tenant", "shared-id", route).allowed, true);

    // Same route, different user: independent bucket.
    assert.equal(apiRateLimit("user", "another-user", route).allowed, true);
  });

  it("cleanup membuang bucket yang sudah kedaluwarsa", async () => {
    process.env.API_RATE_LIMIT_TENANT_WINDOW_MS = "5";
    const before = rateLimitBucketCount();
    const route = uniqueRoute();

    assert.equal(apiRateLimit("tenant", "tenant-cleanup", route).allowed, true);
    assert.ok(rateLimitBucketCount() > before);

    await sleep(15);
    cleanupRateLimitBuckets();

    assert.ok(
      rateLimitBucketCount() <= before,
      "bucket kedaluwarsa harus dihapus oleh cleanup",
    );

    // The key is usable again after cleanup, and starts a fresh window.
    const again = apiRateLimit("tenant", "tenant-cleanup", route);
    assert.equal(again.allowed, true);
    assert.equal(again.remaining, API_TENANT_LIMIT_DEFAULT - 1);
  });
});
