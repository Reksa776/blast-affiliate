// Unit tests for the in-memory fixed-window rate limiter (P0.5).
//
// Windows are intentionally short (20–60 ms) so the expiry cases run quickly; the
// tests use unique keys, and the file runs in its own process under node --test,
// so the module-level map contains only what these tests created.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRateLimit, cleanupRateLimitBuckets, consumeRateLimit, rateLimitBucketCount } from "./rate-limit.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("5 request dalam window → semuanya true", () => {
  const key = `rl-a-${Date.now()}`;
  const results = [0, 1, 2, 3, 4].map(() => checkRateLimit(key, 5, 50));
  assert.deepEqual(results, [true, true, true, true, true]);
});

test("request ke-6 dalam window yang sama → false", () => {
  const key = `rl-b-${Date.now()}`;
  for (let i = 0; i < 5; i += 1) checkRateLimit(key, 5, 50);
  assert.equal(checkRateLimit(key, 5, 50), false);
});

test("setelah window lewat → true lagi", async () => {
  const key = `rl-c-${Date.now()}`;
  assert.equal(checkRateLimit(key, 1, 20), true);
  assert.equal(checkRateLimit(key, 1, 20), false);

  await sleep(30);
  assert.equal(checkRateLimit(key, 1, 20), true);
});

test("cleanup menghapus bucket yang sudah expired", async () => {
  await sleep(60); // let every bucket above expire
  cleanupRateLimitBuckets();
  assert.equal(rateLimitBucketCount(), 0);

  const key = `rl-d-${Date.now()}`;
  assert.equal(checkRateLimit(key, 1, 10), true);
  assert.equal(rateLimitBucketCount(), 1);

  await sleep(20);
  cleanupRateLimitBuckets();
  assert.equal(rateLimitBucketCount(), 0);
});

test("consumeRateLimit melaporkan remaining dan Retry-After", () => {
  const key = `rl-e-${Date.now()}`;
  const first = consumeRateLimit(key, 2, 60_000);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.ok(first.retryAfterSeconds >= 1 && first.retryAfterSeconds <= 60);

  const second = consumeRateLimit(key, 2, 60_000);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);

  const third = consumeRateLimit(key, 2, 60_000);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterSeconds >= 1, "Retry-After tidak boleh 0");
  assert.ok(third.retryAfterSeconds <= 60);
});

test("limit non-positif menolak semua permintaan (fail-closed)", () => {
  const key = `rl-f-${Date.now()}`;
  assert.equal(consumeRateLimit(key, 0, 1_000).allowed, false);
  assert.equal(consumeRateLimit(key, -3, 1_000).allowed, false);
});
