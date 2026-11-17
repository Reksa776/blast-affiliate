// Unit tests for the tenant-isolation contract (Checkpoint 6C, Tahap I).
//
// Pure functions only: no database, no tables required, no network. Runs with the
// Node built-in test runner so no test framework dependency is added.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertJobTenantContext,
  assertSameTenant,
  createTenantContext,
  CrossTenantAccessError,
  hasPermission,
  SYSTEM_JOB_TYPES,
  tenantScope,
  TenantContextError,
} from "./tenancy.js";

const base = {
  tenantId: "tenant-a",
  userId: "user-1",
  membershipId: "member-1",
  actorType: "user" as const,
  requestId: "req-1",
  permissions: ["creator.read", "campaign.publish"],
};

test("createTenantContext accepts a fully authenticated membership", () => {
  const ctx = createTenantContext(base);
  assert.equal(ctx.tenantId, "tenant-a");
  assert.equal(ctx.userId, "user-1");
  assert.equal(ctx.actorType, "user");
  assert.deepEqual([...ctx.permissions].sort(), ["campaign.publish", "creator.read"]);
  assert.deepEqual(tenantScope(ctx), { tenantId: "tenant-a" });
});

test("createTenantContext rejects a blank tenant id (no default workspace)", () => {
  assert.throws(() => createTenantContext({ ...base, tenantId: "   " }), TenantContextError);
});

test("createTenantContext rejects a user context without a membership", () => {
  assert.throws(() => createTenantContext({ ...base, membershipId: "" }), TenantContextError);
});

test("createTenantContext allows a system context without a user or membership", () => {
  const ctx = createTenantContext({ ...base, actorType: "system", userId: "", membershipId: "" });
  assert.equal(ctx.actorType, "system");
  assert.equal(ctx.tenantId, "tenant-a");
});

test("hasPermission is an exact, case-sensitive allowlist", () => {
  const ctx = createTenantContext(base);
  assert.equal(hasPermission(ctx, "creator.read"), true);
  assert.equal(hasPermission(ctx, "creator.read.all"), false);
  assert.equal(hasPermission(ctx, "CREATOR.READ"), false);
  assert.equal(hasPermission(ctx, "team.manage"), false);
});

test("assertSameTenant accepts the owning tenant and rejects every other shape", () => {
  const ctx = createTenantContext(base);
  assert.doesNotThrow(() => assertSameTenant(ctx, "tenant-a"));
  assert.throws(() => assertSameTenant(ctx, "tenant-b"), CrossTenantAccessError);
  assert.throws(() => assertSameTenant(ctx, null), CrossTenantAccessError);
  assert.throws(() => assertSameTenant(ctx, undefined), CrossTenantAccessError);
});

test("assertSameTenant error message never leaks an identifier", () => {
  const ctx = createTenantContext(base);
  try {
    assertSameTenant(ctx, "tenant-b");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof CrossTenantAccessError);
    assert.equal(error.message, "Resource not found.");
    assert.equal(error.message.includes("tenant-b"), false);
  }
});

test("tenant-scoped jobs must carry a tenant id", () => {
  assert.throws(
    () => assertJobTenantContext({ type: "tiktok.sync.orders", idempotencyKey: "k1" }),
    TenantContextError,
  );
  assert.throws(
    () => assertJobTenantContext({ type: "tiktok.sync.orders", tenantId: "  ", idempotencyKey: "k1" }),
    TenantContextError,
  );
  assert.doesNotThrow(() =>
    assertJobTenantContext({ type: "tiktok.sync.orders", tenantId: "tenant-a", idempotencyKey: "k1" }),
  );
});

test("only explicitly named system job types may omit a tenant", () => {
  for (const type of SYSTEM_JOB_TYPES) {
    assert.doesNotThrow(() => assertJobTenantContext({ type, idempotencyKey: "k1" }));
  }
  assert.throws(() => assertJobTenantContext({ type: "outreach.batch.execute", idempotencyKey: "k1" }));
});

test("a job without an idempotency key is rejected", () => {
  assert.throws(
    () => assertJobTenantContext({ type: "maintenance.cleanup", idempotencyKey: " " }),
    TenantContextError,
  );
});
